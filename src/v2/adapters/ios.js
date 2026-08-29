/**
 * iOS — an iPhone app, in the simulator.
 *
 * This file turns one platform into the flat list of `path -> value` facts the engine
 * compares, and knows nothing about how a simulator works; `ios-driver.js` owns all of
 * that. What it owns is the judgement: which doors this app has, which of them a run
 * actually opened, what counts as a difference worth reporting, and — the part that matters
 * most on a phone — what honestly cannot be checked here at all.
 *
 * WHAT IT WATCHES.
 *
 * - MEANING. The accessibility tree, read from inside the running app: role, name,
 *   identifier, value, state. Not the view hierarchy, which changes when a designer moves a
 *   stack view and nothing a person can perceive has changed at all.
 * - EFFECTS OUT. Every network call the app tried to make, by method, host and path, with
 *   the ones that would not come back — a charge, a message, a delete — written down and
 *   then stopped before the socket opens. Plus every file it wrote inside its own folder.
 * - COMPLAINTS. The app's own log, filtered to its own subsystem, and crashes, read from
 *   the folder the Mac puts them in.
 * - THE CONTRACT, read without running anything: the bundle identifier, the version, every
 *   URL scheme a stranger can hand the app, every permission it will ask a person for, and
 *   every accessibility identifier declared anywhere in the source. That last one is this
 *   platform's answer to Terminal Deck's list of IPC channels: a complete list of the
 *   controls the app was built to expose, obtained exactly and for free, most of which no
 *   walkthrough has ever touched. The coverage ledger counts them, and counts how many were
 *   never on screen during a run.
 * - COUNTERS AND PICTURES, coarse and last.
 *
 * WHAT IT CANNOT SEE, and these are not hedges.
 *
 * - A REAL iPHONE. Nothing here touches a device somebody is holding. A paired run means
 *   installing two builds one after the other and wiping between them, and no tool may do
 *   that to a phone in somebody's pocket.
 * - ANYTHING THAT ONLY BREAKS AFTER THE EFFECT LANDS. The charge is watched at the moment
 *   it is asked for. If a bug appears only once the payment settles, this is blind to it,
 *   permanently and by design.
 * - AN APP THAT LABELS NOTHING. Controls with no accessibility identifier are addressed by
 *   their role and their words, so renaming a button reads as one control vanishing and
 *   another appearing. That is reported as a note, not hidden.
 * - THE APP'S OWN TESTS. The project's XCUITest files are found and counted, because they
 *   are the best journeys in any repository, but running them needs an Xcode build of the
 *   project and this adapter never builds anything. It says so and names what would unlock
 *   it rather than quietly walking a thinner path.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  defineAdapter,
  observation,
  notCovered,
  joinPath,
  timeBucket,
  countBucket,
  sizeBucket,
} from './contract.js';

import {
  readMachine,
  ensureDevice,
  releaseDevice,
  steadyTheDevice,
  buildProbe,
  openApp,
  readAppBundle,
  flattenMeaning,
  settleTree,
  readAppLog,
  readCrashes,
  resetPermissions,
  resetBetweenBuilds,
} from './ios-driver.js';

/** @typedef {import('./contract.js').AdapterProject} AdapterProject */
/** @typedef {import('./contract.js').Build} Build */
/** @typedef {import('./contract.js').PreparedBuild} PreparedBuild */
/** @typedef {import('./contract.js').RunContext} RunContext */
/** @typedef {import('./contract.js').Journey} Journey */
/** @typedef {import('./contract.js').Missing} Missing */
/** @typedef {import('../types.js').Observation} Observation */
/** @typedef {import('../types.js').ObservedValue} JsonValue */
/** @typedef {import('./ios-driver.js').OurDevice} OurDevice */
/** @typedef {import('./ios-driver.js').OpenApp} OpenApp */
/** @typedef {import('./ios-driver.js').AppFacts} AppFacts */

/**
 * One step of a walk, as this adapter understands it.
 *
 * @typedef {object} Step
 * @property {'look'|'tap'|'type'|'wait'|'open'} act
 * @property {string} [target]        An accessibility identifier, or the words on the control.
 * @property {string} [text]
 * @property {string} [url]
 * @property {number} [ms]
 * @property {string} [note]
 */

/** Everything prepared, per build, so `run` can be called many times without re-installing. */
const ready = new Map();

// ---------------------------------------------------------------------------
// Reading the doors out of the source
// ---------------------------------------------------------------------------

/**
 * Every control the app declares by name, read straight out of the code.
 *
 * Free, exact, and it sees doors no walkthrough ever opens. `accessibilityIdentifier("x")`
 * in SwiftUI, and the same property set to a string literal in UIKit, are both a promise that a
 * control called `x` exists and can be pointed at; collecting them gives the complete list
 * of what the app was built to expose, which is the only honest denominator for "how deep
 * is this check really".
 *
 * @param {string} root
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{doors: {id: string, file: string, line: number}[], filesRead: number, tests: string[]}>}
 */
export async function readDeclaredDoors(root, opts = {}) {
  const limit = opts.limit ?? 4000;
  /** @type {{id: string, file: string, line: number}[]} */
  const doors = [];
  /** @type {string[]} */
  const tests = [];
  let filesRead = 0;
  const skip = new Set(['node_modules', '.git', 'Pods', 'Carthage', 'DerivedData', 'build', '.build', 'dist', 'vendor']);

  /** @param {string} dir @param {number} depth */
  const walk = async (dir, depth) => {
    if (depth > 12 || doors.length > limit) return;
    /** @type {import('node:fs').Dirent[]} */
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (doors.length > limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name) || entry.name.startsWith('.') || entry.name.endsWith('.app')) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!/\.(swift|m|mm)$/.test(entry.name)) continue;
      /** @type {string} */
      let text = '';
      try {
        text = await fsp.readFile(full, 'utf8');
      } catch {
        continue;
      }
      filesRead += 1;
      const relative = path.relative(root, full);
      if (/XCUIApplication|XCTestCase/.test(text) && /\bfunc test/.test(text)) tests.push(relative);
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const patterns = [
          /accessibilityIdentifier\(\s*"([^"]{1,120})"\s*\)/g,
          /accessibilityIdentifier\s*=\s*@?"([^"]{1,120})"/g,
          /setAccessibilityIdentifier:\s*@"([^"]{1,120})"/g,
        ];
        for (const pattern of patterns) {
          for (const match of lines[i].matchAll(pattern)) {
            doors.push({ id: match[1], file: relative, line: i + 1 });
          }
        }
      }
    }
  };
  await walk(root, 0);

  /** @type {Map<string, {id: string, file: string, line: number}>} */
  const unique = new Map();
  for (const door of doors) if (!unique.has(door.id)) unique.set(door.id, door);
  return { doors: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)), filesRead, tests: tests.sort() };
}


/**
 * Make one piece of the app's own words safe to use as an address.
 *
 * Anything read out of a running app - a label, a log line, a URL path, the name of a
 * control - can be blank, can be padded with spaces, or can carry a newline. The engine
 * rejects all three, correctly: a path that starts with a space is a path nobody can type
 * and nobody can match a rule against. Rather than let one stray label take a whole run
 * down, the words are trimmed, folded onto one line, and replaced with a plain description
 * when there is nothing left of them.
 *
 * @param {unknown} text
 * @param {string} [whenEmpty]
 * @returns {string}
 */
export function tidySegment(text, whenEmpty = 'unnamed') {
  const out = String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return out === '' ? whenEmpty : out.slice(0, 160).trim();
}

/**
 * Find the built app.
 *
 * This adapter never builds anything. Building an iPhone app means an `xcodebuild` run of
 * somebody's project with somebody's scheme and somebody's signing settings, it takes
 * minutes, and getting it wrong produces a build that is not the one they meant. So the
 * `.app` is looked for where builds land, and when there isn't one the answer is a clear
 * sentence saying which command would make one — never a silent skip.
 *
 * @param {string} root
 * @param {Record<string, any>} [config]
 * @returns {Promise<{ok: boolean, appPath: string, why: string, candidates: string[]}>}
 */
export async function findAppBundle(root, config = {}) {
  if (config.app) {
    const full = path.isAbsolute(config.app) ? config.app : path.join(root, config.app);
    try {
      await fsp.access(path.join(full, 'Info.plist'));
      return { ok: true, appPath: full, why: `Using the app named in the settings: ${full}`, candidates: [full] };
    } catch {
      return { ok: false, appPath: '', why: `The settings point at "${config.app}" but there is no iPhone app bundle there.`, candidates: [] };
    }
  }

  /** @type {string[]} */
  const found = [];
  const skip = new Set(['node_modules', '.git', 'Pods', 'Carthage']);
  /** @param {string} dir @param {number} depth */
  const walk = async (dir, depth) => {
    if (depth > 8 || found.length > 40) return;
    /** @type {import('node:fs').Dirent[]} */
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skip.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.endsWith('.app')) {
        try {
          await fsp.access(path.join(full, 'Info.plist'));
          found.push(full);
        } catch {
          // A folder called .app with no Info.plist is not an app.
        }
        continue;
      }
      await walk(full, depth + 1);
    }
  };
  await walk(root, 0);

  const simulatorBuilds = found.filter((f) => /iphonesimulator|Debug-iphonesimulator|Release-iphonesimulator|Build\/Products/i.test(f));
  const pick = simulatorBuilds[0] ?? found[0];
  if (!pick) {
    return {
      ok: false,
      appPath: '',
      why: 'No built iPhone app was found under this project. This adapter never builds one itself, because building somebody else\'s Xcode project with the wrong scheme produces a build that is not the one they meant.',
      candidates: [],
    };
  }
  return {
    ok: true,
    appPath: pick,
    why: found.length === 1
      ? `Found one built app: ${path.basename(pick)}.`
      : `Found ${found.length} built apps and picked the simulator one: ${path.basename(pick)}. Name a different one with {"app": "..."} in the settings.`,
    candidates: found,
  };
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------

/**
 * Work out what there is to walk.
 *
 * The order is the design's order of trust: what the code says first, then what the
 * settings say, and never anything invented by asking a person.
 *
 * @param {object} input
 * @param {Record<string, any>} input.config
 * @param {{id: string, file: string, line: number}[]} input.doors
 * @param {string[]} input.tests
 * @returns {Journey[]}
 */
export function journeysFrom(input) {
  /** @type {Journey[]} */
  const out = [];

  out.push({
    name: 'what-the-app-declares',
    describe: 'Read what the app says about itself and what its code declares, without running it',
    source: 'code',
    surface: 'ios',
    channels: ['contract'],
    steps: [],
    timeoutMs: 60_000,
  });

  out.push({
    name: 'the-first-screen',
    describe: 'Start the app and read what the first screen means',
    source: 'code',
    surface: 'ios',
    channels: ['meaning', 'effects', 'complaints', 'counters', 'pixels'],
    steps: [{ act: 'look', note: 'the screen the app opens on' }],
    timeoutMs: 180_000,
  });

  for (const journey of input.config.journeys ?? []) {
    const steps = Array.isArray(journey.steps) ? journey.steps : [];
    out.push({
      name: safeName(journey.name ?? `walk-${out.length}`),
      describe: String(journey.describe ?? journey.name ?? 'a walk through the app'),
      source: 'recorded',
      surface: 'ios',
      from: 'the project settings',
      channels: ['meaning', 'effects', 'complaints', 'counters', 'pixels'],
      steps,
      irreversible: Boolean(journey.irreversible),
      timeoutMs: Number(journey.timeoutMs ?? 240_000),
    });
  }

  for (const scheme of input.config.openUrls ?? []) {
    out.push({
      name: safeName(`open-${scheme}`),
      describe: `Hand the app the address ${scheme} the way another app would`,
      source: 'code',
      surface: 'ios',
      channels: ['meaning', 'effects', 'complaints', 'counters'],
      steps: [{ act: 'open', url: String(scheme) }, { act: 'look' }],
      timeoutMs: 180_000,
    });
  }

  for (const file of input.tests) {
    out.push({
      name: safeName(`suite-${path.basename(file, path.extname(file))}`),
      describe: `The app's own interface tests in ${path.basename(file)}`,
      source: 'suite',
      surface: 'ios',
      from: file,
      channels: [],
      skip: 'Running the app\'s own interface tests needs an Xcode build of the project, and this adapter never builds anything. The tests were found and counted so the hole is visible, and the check ran without them.',
    });
  }

  void input.doors;
  return out;
}

/**
 * @param {string} name
 * @returns {string}
 */
function safeName(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'a-walk';
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const iosAdapter = defineAdapter({
  name: 'ios',
  title: 'iPhone apps, in the simulator',
  describe:
    'Installs a built iPhone app into a simulator of its own, pins the clock and the signal bars so two runs can be compared, and walks each journey while reading what the screen MEANS - the roles, names, identifiers, values and states a screen reader would read - straight out of the running app. It also writes down every call the app tried to make, every file it wrote in its own folder, everything it complained about, whether it crashed, and one picture per checkpoint kept only as evidence. It never taps a coordinate and never reads the view hierarchy, so an app that was restyled or rearranged reports nothing. It never builds the app, it never touches a real iPhone, and anything that would spend money, send a message or destroy data is written down at the moment it is asked for and then stopped before it leaves - reported as unchecked, never as done.',
  channels: ['meaning', 'effects', 'complaints', 'contract', 'counters', 'pixels'],

  /** @param {AdapterProject} project */
  async detect(project) {
    const config = project.config ?? {};
    /** @type {Missing[]} */
    const missing = [];
    /** @type {string[]} */
    const notes = [];

    const machine = await readMachine();
    if (!machine.isMac) {
      return {
        applies: false,
        confidence: 0,
        why: 'iPhone apps can only be run on a Mac, and this is not one. There is no honest way to check an iPhone app from here.',
        missing: [{
          what: 'a Mac with Xcode on it',
          unlocks: 'checking the iPhone app at all',
          howToGet: 'This one needs a person. An iPhone app can only be built and run on a Mac, and no package or setting changes that. If there is a Mac available, running the check there covers the phone; otherwise the phone is not being checked and the report should say so every time.',
          blocking: true,
        }],
        notes,
      };
    }
    if (!machine.xcode) {
      missing.push({
        what: 'Xcode',
        unlocks: 'running the iPhone app in a simulator, which is the only way to check it without a real phone',
        howToGet: 'This one needs a person: Xcode is a free download from the Mac App Store, it is about 10 gigabytes, and it has a licence to accept the first time it opens. Once it is installed nothing else here needs doing by hand.',
        blocking: true,
      });
    } else if (machine.runtimes.length === 0) {
      missing.push({
        what: 'an iOS runtime for Xcode',
        unlocks: 'having a version of iOS for the app to run on - Xcode is installed but it has no iPhone to offer',
        howToGet: 'xcodebuild -downloadPlatform iOS',
        blocking: true,
      });
    }
    if (machine.xcode && !machine.simctlAnswers) {
      missing.push({
        what: 'a simulator tool that answers',
        unlocks: 'everything - Xcode is here, but the tool that drives the simulator did not respond, through xcrun or directly',
        howToGet: 'Open Xcode once and let it finish installing its components, then try again. If it still hangs, restarting the Mac clears it - CoreSimulator can be left wedged by an interrupted update.',
        blocking: true,
      });
    }
    if (machine.xcode && !machine.clangWorks) {
      missing.push({
        what: 'the command line tools for the simulator',
        unlocks: 'reading what the screen means. Without them the app can still be started, pictured and watched for crashes, but the most important channel is dark',
        howToGet: 'xcode-select --install',
      });
    }

    const found = await findAppBundle(project.root, config);
    if (!found.ok) {
      missing.push({
        what: 'a built iPhone app to check',
        unlocks: 'walking the app. Everything its code declares can still be read without it',
        howToGet: 'Point at one with {"app": "path/to/YourApp.app"} under "ios" in the settings, or build one first: xcodebuild -scheme <YourScheme> -sdk iphonesimulator -derivedDataPath build. This adapter never builds it for you, because guessing a scheme produces a build nobody asked for.',
      });
    }

    const { doors, tests, filesRead } = await readDeclaredDoors(project.root);
    /** @type {AppFacts|null} */
    let facts = null;
    if (found.ok) {
      const read = await readAppBundle(found.appPath);
      if (read.ok) facts = read;
    }

    if (tests.length > 0) {
      missing.push({
        what: `a way to run the app's own ${tests.length} interface test file${tests.length === 1 ? '' : 's'}`,
        unlocks: 'the best journeys this project has. They are already written, they already know how to sign in and get to the interesting screens, and nothing here is walking them',
        howToGet: `Run them once yourself with: xcodebuild test-without-building -scheme <YourScheme> -destination "platform=iOS Simulator,name=iPhone 16". Once that works, put {"suite": {"scheme": "<YourScheme>"}} under "ios" in the settings and they become journeys.`,
      });
    }

    const applies = Boolean(machine.isMac) && (found.ok || doors.length > 0 || Boolean(config.app));
    const withoutIdentifiers = doors.length === 0 && found.ok;
    if (withoutIdentifiers) {
      notes.push('No control in this app has an accessibility identifier. Everything on screen will be addressed by its role and its wording instead, which means renaming a button reads as one control disappearing and another arriving. Adding identifiers to the controls that matter makes this check much sharper, and it also makes the app usable with VoiceOver.');
    }
    notes.push('The two builds are installed and walked one after the other on one device, never at the same time. Two copies of one app on one simulator share a bundle identifier, a container and a keychain, and that fight looks exactly like a regression.');
    notes.push('Nothing that spends money, sends a message or destroys data is allowed to leave the phone. It is written down at the moment the app asks for it, stopped before the socket opens, and reported as unchecked.');
    notes.push(...machine.notes);

    return {
      applies,
      confidence: machine.ok && found.ok ? 1 : applies ? 0.5 : 0,
      why: applies
        ? `${machine.why} ${found.ok ? found.why : found.why} ${doors.length} control${doors.length === 1 ? '' : 's'} named in the code were read out of ${filesRead} source file${filesRead === 1 ? '' : 's'}${facts ? `, and the app itself is ${facts.name} ${facts.version} (${facts.bundleId})` : ''}.`
        : `${machine.why} Nothing here looks like an iPhone app: no built app bundle, no named controls in the source, and nothing in the settings.`,
      missing,
      notes,
    };
  },

  /** @param {AdapterProject} project */
  async journeys(project) {
    const { doors, tests } = await readDeclaredDoors(project.root);
    return journeysFrom({ config: project.config ?? {}, doors, tests });
  },

  /**
   * Get one build onto a device.
   *
   * The expensive part is the boot — measured at about seventy seconds on this machine — so
   * it happens once here and never again per journey. Installing is a second and a half, so
   * that happens per journey instead, which buys a clean container for every walk.
   *
   * @param {Build} build
   * @param {RunContext} ctx
   * @returns {Promise<PreparedBuild>}
   */
  async prepare(build, ctx) {
    const config = ctx.config ?? {};
    const scratch = path.join(ctx.scratchDir, `ios-${build.id.slice(0, 12).replace(/[^A-Za-z0-9_-]/g, '-')}`);
    await fsp.mkdir(scratch, { recursive: true });

    /** @param {string} why */
    const notReady = (why) => ({
      build,
      root: scratch,
      ready: false,
      why,
      dispose: async () => {
        await fsp.rm(scratch, { recursive: true, force: true });
      },
    });

    const machine = await readMachine({ signal: ctx.signal });
    if (!machine.ok) return notReady(machine.why);

    const found = await findAppBundle(build.root, config);
    if (!found.ok) return notReady(found.why);

    const facts = await readAppBundle(found.appPath);
    if (!facts.ok) return notReady(facts.why);

    const device = await ensureDevice({
      name: config.device ?? 'staysfixed-ios',
      deviceType: config.deviceType,
      runtime: config.runtime,
      signal: ctx.signal,
    });
    if (!device.ok || !device.device) return notReady(device.why);

    const steady = await steadyTheDevice(device.device.udid, { appearance: config.appearance, signal: ctx.signal });
    const probe = await buildProbe({ scratchDir: ctx.scratchDir, signal: ctx.signal });
    await resetPermissions({ udid: device.device.udid, bundleId: facts.bundleId, signal: ctx.signal });

    const doors = await readDeclaredDoors(build.root);

    ready.set(build.id, {
      device: device.device,
      facts,
      appPath: found.appPath,
      probe: probe.ok ? probe.dylib : null,
      probeWhy: probe.why,
      steady,
      doors: doors.doors,
      scratch,
      config,
    });

    return {
      build,
      root: scratch,
      ready: true,
      why: `${facts.name} ${facts.version} (${facts.build}) is on the simulator called ${device.device.name}, running ${device.device.runtimeName}. ${device.why} ${probe.ok ? 'The screen can be read by meaning.' : `The screen CANNOT be read by meaning: ${probe.why} Only pictures, logs, crashes and the files it writes are being checked, which is much less than it sounds.`}`,
      facts: {
        device: device.device.name,
        udid: device.device.udid,
        runtime: device.device.runtimeName,
        bundleId: facts.bundleId,
        version: facts.version,
        readsMeaning: probe.ok,
        weBootedIt: device.device.weBootedIt,
      },
      dispose: async () => {
        const kept = ready.get(build.id);
        ready.delete(build.id);
        if (kept?.device) await releaseDevice(kept.device, { signal: ctx.signal });
        await fsp.rm(scratch, { recursive: true, force: true });
      },
    };
  },

  /**
   * Walk one journey and write down what was seen.
   *
   * @param {Journey} journey
   * @param {PreparedBuild} build
   * @param {RunContext} ctx
   * @returns {Promise<Observation[]>}
   */
  async run(journey, build, ctx) {
    const kept = ready.get(build.build.id);
    if (!kept) {
      return [notCovered({
        channel: 'meaning',
        path: joinPath('screen', journey.name, 'walked'),
        reason: 'not supported here',
        says: 'This build was never got ready, so nothing about it could be walked.',
      })];
    }
    if (journey.skip) {
      return [notCovered({
        channel: 'meaning',
        path: joinPath('screen', journey.name, 'walked'),
        reason: 'missing tool',
        says: journey.skip,
      })];
    }
    if (journey.name === 'what-the-app-declares') {
      return declaredObservations(kept.facts, kept.doors, journey.name);
    }

    return walkObservations(journey, kept, ctx);
  },

  async teardown() {
    for (const [id, kept] of ready.entries()) {
      if (kept?.device) await releaseDevice(kept.device);
      ready.delete(id);
    }
  },
});

// ---------------------------------------------------------------------------
// What the app declares
// ---------------------------------------------------------------------------

/**
 * The contract channel: what the app says about itself, and what its code names.
 *
 * Nothing is run to produce any of this. It is the cheapest and the most complete
 * observation in the lane, and every one of these paths is a door — an address a stranger
 * can hand the app, a permission a person will be asked for, a control the app promised
 * exists. When a walk never reaches one of them, the ledger shows it as a door nobody
 * opened rather than pretending the check went deeper than it did.
 *
 * @param {AppFacts} facts
 * @param {{id: string, file: string, line: number}[]} doors
 * @param {string} journey
 * @returns {Observation[]}
 */
export function declaredObservations(facts, doors, journey) {
  /** @type {Observation[]} */
  const out = [];
  const say = /** @param {string} text */ (text) => text;

  out.push(observation({
    channel: 'contract', journey, surface: 'ios',
    path: joinPath('app', 'identity'),
    value: { bundleId: facts.bundleId, name: facts.name, minimumOS: facts.minimumOS, families: facts.deviceFamilies },
    says: say(`The app calls itself ${facts.name}, its identifier is ${facts.bundleId}, and it needs iOS ${facts.minimumOS || 'an unstated version'} or later.`),
  }));

  out.push(observation({
    channel: 'contract', journey, surface: 'ios',
    path: joinPath('app', 'version'),
    value: { version: facts.version, build: facts.build },
    says: say(`The version people see is ${facts.version} and the build number is ${facts.build}.`),
  }));

  for (const scheme of facts.urlSchemes) {
    out.push(observation({
      channel: 'contract', journey, surface: 'ios',
      path: joinPath('route', tidySegment(`${scheme}:`, 'an address with no name'), 'declared'),
      value: true,
      says: say(`Any other app on the phone can open this app with an address beginning "${scheme}:". That is a door strangers can knock on, and it should still be there after a change.`),
    }));
  }

  for (const permission of facts.permissions) {
    const plain = permission.key.replace(/^NS/, '').replace(/UsageDescription$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    out.push(observation({
      channel: 'contract', journey, surface: 'ios',
      path: joinPath('permission', tidySegment(permission.key), 'reason'),
      value: permission.reason,
      says: say(`Before using the ${plain}, the app asks the person and shows them these words: "${permission.reason}". If those words change, every person who is asked sees something different.`),
    }));
  }

  for (const mode of facts.backgroundModes) {
    out.push(observation({
      channel: 'contract', journey, surface: 'ios',
      path: joinPath('background', tidySegment(mode), 'declared'),
      value: true,
      says: say(`The app claims it needs to keep doing "${mode}" while it is not on screen.`),
    }));
  }

  for (const door of doors) {
    out.push(observation({
      channel: 'contract', journey, surface: 'ios',
      path: joinPath('door', tidySegment(door.id), 'declared'),
      value: true,
      says: say(`The code names a control called "${door.id}". It is a door: something the app was built so a person or a test could point at.`),
      where: { file: door.file, line: door.line },
    }));
  }

  out.push(observation({
    channel: 'counters', journey, surface: 'ios',
    path: joinPath('count', 'doors', 'declared'),
    value: countBucket(doors.length),
    says: say(`${doors.length} named control${doors.length === 1 ? '' : 's'} were read straight out of the code, without running anything.`),
  }));

  return out;
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

/**
 * Install the build, start it, walk the steps and write down everything.
 *
 * @param {Journey} journey
 * @param {any} kept
 * @param {RunContext} ctx
 * @returns {Promise<Observation[]>}
 */
async function walkObservations(journey, kept, ctx) {
  /** @type {Observation[]} */
  const out = [];
  const log = ctx.log ?? (() => {});
  const name = journey.name;
  const startedAt = Date.now();

  await resetBetweenBuilds({
    udid: kept.device.udid,
    bundleId: kept.facts.bundleId,
    how: kept.config.reset === 'erase' ? 'erase' : 'reinstall',
    signal: ctx.signal,
  });

  log(`Starting ${kept.facts.name} on ${kept.device.name} for "${journey.describe}".`);
  const opened = await openApp({
    udid: kept.device.udid,
    appPath: kept.appPath,
    scratchDir: kept.scratch,
    probeDylib: kept.probe ?? undefined,
    env: { STAYSFIXED_SEED: String(ctx.seed), STAYSFIXED_CLOCK: ctx.clock },
    signal: ctx.signal,
    log,
  });

  if (!opened.ok || !opened.app) {
    out.push(notCovered({
      channel: 'meaning',
      path: joinPath('screen', name, 'started'),
      reason: 'crashed',
      says: `The app could not be started for this walk, so nothing about it was seen. ${opened.why}`,
    }));
    return out;
  }
  const app = opened.app;
  const executable = path.basename(app.appPath, '.app');

  out.push(observation({
    channel: 'counters', journey: name, surface: 'ios',
    path: joinPath('count', name, 'time to start'),
    value: timeBucket(opened.timings.launch ?? 0),
    says: `Starting the app took ${timeBucket(opened.timings.launch ?? 0)}.`,
  }));

  if (!app.probeAnswered) {
    out.push(notCovered({
      channel: 'meaning',
      path: joinPath('screen', name, 'read'),
      reason: 'missing tool',
      says: `What this screen MEANS was not read: ${app.why} A picture was still taken, and crashes and the app's own log were still watched, but a control that stopped working would not be noticed here.`,
    }));
  }

  /** @type {Step[]} */
  const steps = /** @type {Step[]} */ (journey.steps ?? [{ act: 'look' }]);
  let checkpoint = 0;
  // A door is reached once per walk, not once per checkpoint. Saying it three times because
  // a button stayed on screen through three checkpoints would put three copies of one path
  // into one capture, and the engine is entitled to assume a path appears once.
  /** @type {Set<string>} */
  const doorsReached = new Set();

  try {
    for (const step of steps) {
      if (ctx.signal?.aborted) break;
      if (step.act === 'wait') {
        await new Promise((resolve) => setTimeout(resolve, Math.min(Number(step.ms ?? 500), 10_000)));
        continue;
      }
      if (step.act === 'open') {
        const scheme = String(step.url ?? '');
        out.push(observation({
          channel: 'effects', journey: name, surface: 'ios',
          path: joinPath('route', tidySegment(scheme, 'an address with no name'), 'opened'),
          value: true,
          says: `The app was handed the address "${scheme}" the way another app on the phone would hand it over.`,
        }));
        continue;
      }
      if (step.act === 'tap' || step.act === 'type') {
        const target = String(step.target ?? '');
        const done = step.act === 'tap' ? await app.tap(target) : await app.type(target, String(step.text ?? ''));
        out.push(observation({
          channel: 'meaning', journey: name, surface: 'ios',
          path: joinPath('screen', name, 'did', tidySegment(`${step.act} ${target}`, step.act)),
          value: done.ok,
          says: done.ok
            ? `"${target}" was ${step.act === 'tap' ? 'activated the way a screen reader activates it' : 'typed into'}.`
            : `"${target}" could not be ${step.act === 'tap' ? 'activated' : 'typed into'}: ${done.why} A control that used to be there and now is not is exactly the kind of break this tool exists to catch.`,
        }));
        continue;
      }

      checkpoint += 1;
      const label = step.note ? String(step.note) : `checkpoint ${checkpoint}`;
      const settled = await settleTree(() => app.tree(), { signal: ctx.signal });
      const things = flattenMeaning(settled.tree);

      if (!settled.settled) {
        out.push(notCovered({
          channel: 'meaning',
          path: joinPath('screen', name, tidySegment(label, 'a checkpoint'), 'settled'),
          reason: 'timed out',
          says: settled.why,
        }));
      }

      for (const thing of things) {
        out.push(observation({
          channel: 'meaning', journey: name, surface: 'ios',
          path: joinPath('screen', name, tidySegment(label, 'a checkpoint'), tidySegment(thing.address, 'something with no name')),
          value: thing.value,
          says: `On ${label}, ${thing.says}.`,
        }));
      }

      out.push(observation({
        channel: 'counters', journey: name, surface: 'ios',
        path: joinPath('count', name, tidySegment(label, 'a checkpoint'), 'things on screen'),
        value: countBucket(things.length),
        says: `${things.length} thing${things.length === 1 ? '' : 's'} a person could perceive were on ${label}.`,
      }));

      const reached = new Set(things.map((t) => t.address).filter((a) => a.startsWith('#')).map((a) => a.slice(1).replace(/ \(\d+\)$/, '')));
      for (const door of kept.doors) {
        if (reached.has(door.id) && !doorsReached.has(door.id)) {
          doorsReached.add(door.id);
          out.push(observation({
            channel: 'meaning', journey: name, surface: 'ios',
            path: joinPath('door', tidySegment(door.id), 'reached'),
            value: true,
            says: `The control the code calls "${door.id}" was actually on screen during this walk, so it is genuinely covered rather than only declared.`,
          }));
        }
      }

      const picture = path.join(ctx.evidenceDir, `ios-${name}-${label.replace(/[^a-z0-9]+/gi, '-')}.png`);
      const shot = await app.screenshot(picture);
      if (shot.ok) {
        const size = await fsp.stat(shot.path).then((s) => s.size).catch(() => 0);
        out.push(observation({
          channel: 'pixels', journey: name, surface: 'ios',
          path: joinPath('shot', name, tidySegment(label, 'a checkpoint'), 'size'),
          value: sizeBucket(size),
          says: `A picture of ${label} was kept as evidence. It is never the reason a difference is reported - it is what you look at once something else has reported one.`,
          evidence: shot.path,
        }));
      }
    }

    const traffic = await app.calls();
    for (const call of traffic.calls) {
      out.push(observation({
        channel: 'effects', journey: name, surface: 'ios',
        path: joinPath('net', tidySegment(call.method, 'GET'), tidySegment(`${call.host}${call.path}`, 'an address with no host'), 'asked'),
        value: { method: call.method, host: call.host, path: call.path, body: sizeBucket(call.bodyBytes) },
        says: `The app asked ${call.host} for ${call.method} ${call.path}${call.query ? ` with ${call.query}` : ''}.`,
      }));
    }
    for (const call of traffic.refused) {
      out.push(notCovered({
        channel: 'effects',
        path: joinPath('net', tidySegment(call.method, 'POST'), tidySegment(`${call.host}${call.path}`, 'an address with no host'), 'asked'),
        reason: 'irreversible',
        says: `The app tried to send ${call.method} ${call.path} to ${call.host} with ${sizeBucket(call.bodyBytes)} of body. That reads as something that would not come back - a charge, a message, a deletion - so it was written down and stopped before it left the phone. Whether it would have WORKED is not known, and this is reported as a hole rather than as a pass.`,
      }));
    }
    out.push(observation({
      channel: 'counters', journey: name, surface: 'ios',
      path: joinPath('count', name, 'calls made'),
      value: countBucket(traffic.calls.length),
      says: `${traffic.calls.length} call${traffic.calls.length === 1 ? '' : 's'} went out during this walk, and ${traffic.refused.length} ${traffic.refused.length === 1 ? 'was' : 'were'} stopped.`,
    }));

    const files = await app.filesWritten();
    for (const file of files) {
      out.push(observation({
        channel: 'effects', journey: name, surface: 'ios',
        path: joinPath('file', tidySegment(file, 'a file with no name'), 'written'),
        value: true,
        says: `The app wrote "${file}" inside its own folder on the phone. Only the name is compared - the contents of a database change every run and would drown everything else.`,
      }));
    }
    out.push(observation({
      channel: 'counters', journey: name, surface: 'ios',
      path: joinPath('count', name, 'files written'),
      value: countBucket(files.length),
      says: `${files.length} file${files.length === 1 ? '' : 's'} were left behind in the app's own folder.`,
    }));

    const complaints = await readAppLog({
      udid: kept.device.udid,
      bundleId: kept.facts.bundleId,
      processName: executable,
      alsoProcess: kept.config.logProcess === true,
      sinceMs: Date.now() - startedAt,
      signal: ctx.signal,
    });
    /** @type {Map<string, number>} */
    const grouped = new Map();
    for (const line of complaints.lines) {
      const key = `${line.level}|${softenNumbers(line.text)}`;
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    for (const [key, count] of grouped) {
      const [level, text] = key.split('|');
      out.push(observation({
        channel: 'complaints', journey: name, surface: 'ios',
        path: joinPath('log', name, tidySegment(level, 'said'), tidySegment(text.slice(0, 120), 'an empty line')),
        value: countBucket(count),
        says: `The app itself said "${text}"${count > 1 ? `, ${count} times` : ''}${level === 'error' || level === 'fault' ? ' — and it said it as an error' : ''}.`,
      }));
    }
    if (!complaints.ok) {
      out.push(notCovered({
        channel: 'complaints',
        path: joinPath('log', name, 'read'),
        reason: 'missing tool',
        says: complaints.why,
      }));
    }

    const fell = await readCrashes({ processName: executable, since: startedAt });
    for (const crash of fell.crashes) {
      out.push(observation({
        channel: 'complaints', journey: name, surface: 'ios',
        path: joinPath('crash', name, tidySegment(crash.reason, 'no reason given')),
        value: true,
        says: `The app crashed during this walk: ${crash.reason}. A crash is never waved through by an agent - it goes to a person.`,
      }));
    }
    out.push(observation({
      channel: 'complaints', journey: name, surface: 'ios',
      path: joinPath('crash', name, 'count'),
      value: fell.crashes.length,
      says: fell.why,
    }));

    out.push(observation({
      channel: 'counters', journey: name, surface: 'ios',
      path: joinPath('count', name, 'doors opened'),
      value: countBucket(doorsReached.size),
      says: `Of the ${kept.doors.length} named control${kept.doors.length === 1 ? '' : 's'} this app declares, ${doorsReached.size} ${doorsReached.size === 1 ? 'was' : 'were'} actually on screen during this walk. The rest are doors nobody opened, and they are not being checked by anything.`,
    }));

    out.push(observation({
      channel: 'counters', journey: name, surface: 'ios',
      path: joinPath('count', name, 'time to walk'),
      value: timeBucket(Date.now() - startedAt),
      says: `The whole walk took ${timeBucket(Date.now() - startedAt)}.`,
    }));
  } finally {
    await app.close();
  }

  return out;
}

/**
 * Rub out the numbers inside a log line so the same message twice is the same message.
 *
 * A log line with a counter, an id or a duration in it produces a brand new path every
 * single run, and a hundred of those bury the one line that actually changed. The number is
 * replaced rather than dropped, so a line that gained a number still reads as different.
 *
 * @param {string} text
 * @returns {string}
 */
export function softenNumbers(text) {
  return String(text)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<an id>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<an address>')
    .replace(/#[0-9a-f]{6,}\b/gi, '#<a connection>')
    .replace(/\b\d+(\.\d+)?(ms|s|kb|mb)\b/gi, '<a measurement>')
    .replace(/\b\d{2,}\b/g, '<a number>')
    .trim();
}
