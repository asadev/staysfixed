/**
 * Android apps, on an emulator.
 *
 * A phone is the hardest surface in this repository to compare honestly, and it is worth
 * saying why before saying what this does. A desktop app can be booted twice on two ports. A
 * website can be opened in two throwaway profiles. A phone has ONE screen, ONE package name,
 * ONE set of granted permissions and ONE keyboard, and two builds of the same app cannot
 * both be installed. So there is no version of this where the two builds run side by side.
 * Everything below is arranged around that: one device, one build at a time, the whole
 * machine put back in between.
 *
 * What is read, and in which channel:
 *
 *   CONTRACT    Everything the APK declares, read out of the file without installing it and
 *               without a Java runtime: the package, the version, every permission it asks
 *               for, every activity, service, broadcast receiver and content provider, and
 *               which of them any other app on the phone can reach. This is Android's door
 *               list. It is free, it is exact, and it sees doors no walkthrough opens.
 *   MEANING     The accessibility tree, through UiAutomator - what each control IS and DOES,
 *               its role, the name a screen reader would read, whether it is on, off, ticked
 *               or disabled. Addressed by identity, never by position on screen.
 *   EFFECTS     Every call the app made, watched at a proxy this tool runs and STOPPED there;
 *               every file it wrote; every permission it was actually granted; every screen
 *               or other app it asked Android to open.
 *   COMPLAINTS  Crashes, ANRs and errors out of logcat, cut down to this app's own process.
 *   RESULTS     The text the app rendered as data, kept apart from the controls, because a
 *               changed sentence and a vanished button are not the same kind of news.
 *   COUNTERS    How many controls, how many calls, and a rough time bucket. Never milliseconds.
 *   PIXELS      One picture per checkpoint, kept as evidence for a finding another channel
 *               already made. Never the accusation.
 *
 * WHAT IT CANNOT SEE, and these are not small.
 *
 *   - Anything inside TLS. The proxy sees that the app reached for a host and a port and
 *     stops it there. The request itself is never opened, and no certificate is installed to
 *     open it. That IS the call boundary the design draws, and it is drawn here on purpose.
 *   - Which process made a call. A device-wide proxy sees sockets, not programs. Calls to
 *     Google's own infrastructure are filed separately from the app's; a third-party library
 *     inside the app cannot be told apart from the app itself.
 *   - The files an app writes, when the device refuses root AND the app is a release build.
 *     A Play Store system image always refuses root. That combination is reported as missing
 *     coverage on every run rather than passing quietly.
 *   - A real handset. Two builds cannot be run on a phone somebody is holding, and this
 *     adapter will not pretend otherwise: pointed at a real device it walks it against the
 *     stored record and says, on every run, that this is the weaker of the two comparisons.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  countBucket, defineAdapter, joinPath, notCovered, observation, sizeBucket, timeBucket,
} from './contract.js';
import {
  Device, HOST_FROM_EMULATOR, complaints, filesWritten, findAdb, findEmulator,
  findNodes, holdStill, installApk, intentsFired, isDeviceHost, listAvds, listDevices,
  pause, permissionsHeld, pidOf, pressNode, readApk, readTree, removeApp, screenshot,
  settleScreen, snapshotLoad, snapshotSave, startEmulator, typeText, watchTheWire,
} from './android-driver.js';

/** @typedef {import('./contract.js').Journey} Journey */
/** @typedef {import('./contract.js').Observation} Observation */
/** @typedef {import('./contract.js').Missing} Missing */
/** @typedef {import('./contract.js').Build} Build */
/** @typedef {import('./contract.js').RunContext} RunContext */
/** @typedef {import('./android-driver.js').ApkFacts} ApkFacts */
/** @typedef {import('./android-driver.js').Node} Node */

/** The snapshot this tool takes of a clean device. Its own name, so nobody else's is touched. */
const CLEAN_SNAPSHOT = 'staysfixed-clean';

/** The journey that needs no device at all. */
const DECLARED = 'what the app declares';

// ---------------------------------------------------------------------------
// Finding the APK
// ---------------------------------------------------------------------------

/** Where Gradle puts things, best first. */
const APK_PLACES = [
  'app/build/outputs/apk/release',
  'app/build/outputs/apk/debug',
  'android/app/build/outputs/apk/release',
  'android/app/build/outputs/apk/debug',
  'build/app/outputs/flutter-apk',
  'build/outputs/apk/release',
  'dist',
  'build',
  '.',
];

/**
 * Find the APK for one build.
 *
 * A named path in the settings wins outright. Otherwise the usual output folders are looked
 * in, newest first — and an unsigned APK is passed over, because it cannot be installed and
 * reporting "the app would not install" when a signed one is sitting beside it would send
 * somebody hunting the wrong thing.
 *
 * @param {string} root
 * @param {Record<string, any>} config
 * @returns {Promise<{path: string|null, why: string, looked: string[]}>}
 */
export async function findApk(root, config) {
  if (config.apk) {
    const named = path.isAbsolute(config.apk) ? config.apk : path.join(root, config.apk);
    if (fs.existsSync(named)) return { path: named, why: `the APK named in the settings`, looked: [named] };
    return { path: null, why: `the settings name an APK at ${config.apk}, and there is no file there`, looked: [named] };
  }

  /** @type {string[]} */
  const looked = [];
  /** @type {{file: string, at: number}[]} */
  const found = [];
  for (const place of APK_PLACES) {
    const dir = path.join(root, place);
    looked.push(place);
    /** @type {string[]} */
    let entries;
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.apk')) continue;
      if (/unsigned/i.test(entry)) continue;
      try {
        found.push({ file: path.join(dir, entry), at: (await fsp.stat(path.join(dir, entry))).mtimeMs });
      } catch {
        // A file that vanished between listing and asking about it is not worth reporting.
      }
    }
    if (found.length > 0) break;
  }
  found.sort((a, b) => b.at - a.at);
  if (found.length > 0) return { path: found[0].file, why: `found in ${path.relative(root, path.dirname(found[0].file))}`, looked };
  return { path: null, why: 'no APK was found anywhere this looks', looked };
}

// ---------------------------------------------------------------------------
// The contract — what the APK says, before anything runs
// ---------------------------------------------------------------------------

/**
 * Turn what an APK declares into observations.
 *
 * Kept as its own function because it needs no device, no emulator and no Java: on a machine
 * with nothing installed at all this still runs and still catches a permission that appeared,
 * a component that quietly became reachable by other apps, or a version that did not move.
 *
 * @param {ApkFacts} apk
 * @param {string} [file]
 * @returns {Observation[]}
 */
export function declaredObservations(apk, file) {
  /** @type {Observation[]} */
  const out = [];
  const where = file ? { file } : undefined;

  out.push(observation({ channel: 'contract', path: ['manifest', 'package'], value: apk.pkg, says: `the app calls itself ${apk.pkg}`, where }));
  out.push(observation({ channel: 'contract', path: ['manifest', 'version'], value: apk.versionName ?? '(none)', says: `the version people see is ${apk.versionName ?? 'not set'}`, where }));
  out.push(observation({ channel: 'contract', path: ['manifest', 'build number'], value: apk.versionCode ?? 0, says: `the build number the store sees is ${apk.versionCode ?? 'not set'}`, where }));
  out.push(observation({ channel: 'contract', path: ['manifest', 'oldest android'], value: apk.minSdk ?? 0, says: `it will install on Android API ${apk.minSdk ?? 'unknown'} and newer`, where }));
  out.push(observation({ channel: 'contract', path: ['manifest', 'built for android'], value: apk.targetSdk ?? 0, says: `it is built against API ${apk.targetSdk ?? 'unknown'}, which decides which of Android's rules apply to it`, where }));
  out.push(observation({ channel: 'contract', path: ['manifest', 'debuggable'], value: apk.debuggable, says: apk.debuggable ? 'this build can be inspected and debugged — never true of something shipped to people' : 'this build cannot be debugged, which is what a shipped build should say', where }));
  out.push(observation({ channel: 'contract', path: ['manifest', 'plain http allowed'], value: apk.cleartext, says: apk.cleartext ? 'the app is allowed to talk over unencrypted HTTP' : 'the app is only allowed to talk over encrypted connections', where }));

  for (const permission of apk.permissions) {
    out.push(observation({
      channel: 'contract',
      path: ['manifest', 'permission', permission],
      value: 'asked for',
      says: `the app asks for ${permission.replace(/^android\.permission\./, '')}`,
      where,
    }));
  }

  for (const component of apk.components) {
    out.push(observation({
      channel: 'contract',
      path: ['manifest', component.kind, component.name, 'open to other apps'],
      value: component.exported,
      says: component.exported
        ? `any other app on the phone can reach this ${component.kind}${component.permission ? `, if it holds ${component.permission}` : ', with no permission needed'}`
        : `this ${component.kind} can only be reached by the app itself`,
      where,
    }));
    if (component.actions.length > 0) {
      out.push(observation({
        channel: 'contract',
        path: ['manifest', component.kind, component.name, 'answers'],
        value: component.actions.slice().sort(),
        says: `this ${component.kind} answers ${component.actions.length} kind${component.actions.length === 1 ? '' : 's'} of request from elsewhere on the phone`,
        where,
      }));
    }
  }

  out.push(observation({
    channel: 'counters',
    path: ['count', 'doors'],
    value: countBucket(apk.components.length),
    says: `the app declares ${apk.components.length} component${apk.components.length === 1 ? '' : 's'} in total`,
    where,
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------

/**
 * What there is to walk.
 *
 * Three sources, in the order the design ranks them. The settings first, because somebody
 * wrote those on purpose. Then one journey per screen the APK says other apps can open,
 * read straight out of the manifest — free, exact, and it finds the screens nobody wrote a
 * test for. And always the one that needs no device at all.
 *
 * @param {object} input
 * @param {Record<string, any>} input.config
 * @param {ApkFacts|null} input.apk
 * @param {string} [input.from]
 * @returns {Journey[]}
 */
export function journeysFrom(input) {
  const config = input.config ?? {};
  /** @type {Journey[]} */
  const journeys = [];

  journeys.push({
    name: DECLARED,
    describe: 'read everything the app file itself says: its version, the permissions it asks for, and every screen and background piece other apps can reach',
    source: 'code',
    surface: 'android',
    from: input.from ?? 'the APK',
    channels: ['contract', 'counters'],
  });

  for (const named of [...(config.journeys ?? []), ...(config.screens ?? [])]) {
    if (!named || typeof named !== 'object') continue;
    const name = String(named.name ?? 'a journey');
    /** @type {any[]} */
    const steps = [];
    if (named.activity) steps.push({ act: 'open', activity: String(named.activity), note: `open ${named.activity}` });
    else if (!Array.isArray(named.steps) || !named.steps.some((/** @type {any} */ s) => s?.act === 'open')) {
      steps.push({ act: 'open', note: 'open the app' });
    }
    for (const step of named.steps ?? []) steps.push({ act: String(step.act ?? 'read'), ...step });
    journeys.push({
      name,
      describe: String(named.describe ?? named.why ?? `walk ${name}`),
      source: 'code',
      surface: 'android',
      from: 'the project settings',
      channels: ['meaning', 'effects', 'complaints', 'results', 'counters', 'pixels'],
      steps,
      irreversible: named.irreversible === true,
      timeoutMs: named.timeoutMs,
    });
  }

  const named = new Set(journeys.map((j) => j.name));
  for (const component of input.apk?.components ?? []) {
    if (component.kind !== 'activity' || !component.exported) continue;
    const short = component.name.split('.').pop() ?? component.name;
    const name = `open ${short}`;
    if (named.has(name)) continue;
    named.add(name);
    journeys.push({
      name,
      describe: `open the ${short} screen straight from outside the app, the way another app on the phone could, and read what it says`,
      source: 'code',
      surface: 'android',
      from: 'the APK manifest',
      channels: ['meaning', 'effects', 'complaints', 'results', 'counters', 'pixels'],
      steps: [{ act: 'open', activity: component.name, note: `open ${short}` }, { act: 'read', note: 'read what the screen says' }],
    });
  }

  return journeys;
}

// ---------------------------------------------------------------------------
// Turning one walked screen into observations
// ---------------------------------------------------------------------------

/**
 * Whether a control is something a person operates, as opposed to something they read.
 *
 * The line matters because the two go into different channels. A button, a tick box or a
 * text field is MEANING: what the screen says you can do. A label or a paragraph is
 * RESULTS: what the app is telling you. Mixing them makes a reworded sentence sort next to
 * a button that stopped working, and the whole point of ranking is that it does not.
 *
 * @param {Node} node
 * @returns {boolean}
 */
export function isControl(node) {
  return node.clickable || node.checkable || node.scrollable || node.kind === 'EditText' || node.kind === 'Switch' || node.kind === 'SeekBar';
}

/**
 * One screen, as observations.
 *
 * Each control produces its own address with its properties hanging off it, so a button that
 * went disabled is one difference at one address and not a whole screen redrawn. Everything
 * that is only ever read is filed under results with its words as the value.
 *
 * @param {object} input
 * @param {Node[]} input.nodes
 * @param {string} input.journey
 * @param {string} [input.step]
 * @param {boolean} input.settled
 * @returns {Observation[]}
 */
export function screenObservations(input) {
  /** @type {Observation[]} */
  const out = [];
  const at = input.step ? [input.journey, input.step] : [input.journey];

  let controls = 0;
  let readable = 0;
  for (const node of input.nodes) {
    const address = joinPath('screen', ...at, node.address);
    if (isControl(node)) {
      controls += 1;
      out.push(observation({
        channel: 'meaning',
        path: `${address}.is`,
        value: `${node.kind}${node.name ? ` called "${node.name}"` : ''}`,
        says: `there is a ${node.kind.toLowerCase()}${node.name ? ` called "${node.name}"` : ' with no name a screen reader could read'} on this screen`,
        journey: input.journey,
        surface: 'android',
      }));
      out.push(observation({
        channel: 'meaning',
        path: `${address}.you can use it`,
        value: node.enabled,
        says: node.enabled ? `"${node.name || node.kind}" can be used` : `"${node.name || node.kind}" is there but greyed out`,
        journey: input.journey,
        surface: 'android',
      }));
      if (node.checkable) {
        out.push(observation({
          channel: 'meaning',
          path: `${address}.ticked`,
          value: node.checked,
          says: `"${node.name || node.kind}" is ${node.checked ? 'ticked' : 'not ticked'}`,
          journey: input.journey,
          surface: 'android',
        }));
      }
      if (node.kind === 'EditText') {
        out.push(observation({
          channel: 'meaning',
          path: `${address}.hidden text`,
          value: node.password,
          says: node.password ? 'what is typed here is hidden, the way a password should be' : 'what is typed here is shown on screen',
          journey: input.journey,
          surface: 'android',
        }));
      }
    } else if (node.text !== '') {
      readable += 1;
      out.push(observation({
        channel: 'results',
        path: `${address}.says`,
        value: node.text,
        says: `the screen shows "${node.text.length > 80 ? `${node.text.slice(0, 77)}...` : node.text}"`,
        journey: input.journey,
        surface: 'android',
      }));
    }
  }

  out.push(observation({
    channel: 'counters',
    path: joinPath('count', ...at, 'controls'),
    value: countBucket(controls),
    says: `${controls} thing${controls === 1 ? '' : 's'} on this screen can be operated`,
    journey: input.journey,
    surface: 'android',
  }));
  out.push(observation({
    channel: 'counters',
    path: joinPath('count', ...at, 'things to read'),
    value: countBucket(readable),
    says: `${readable} piece${readable === 1 ? '' : 's'} of text on this screen are there to be read`,
    journey: input.journey,
    surface: 'android',
  }));
  if (!input.settled) {
    out.push(notCovered({
      channel: 'meaning',
      path: joinPath('screen', ...at, 'held still'),
      reason: 'timed out',
      says: 'this screen was still moving when it was read, so what was read may be halfway through something and anything odd here should be blamed on that first',
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// What one build is holding open while it is walked
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Session
 * @property {Device} device
 * @property {ApkFacts} apk
 * @property {string} apkPath
 * @property {boolean} ownsDevice   True only when this tool started the emulator.
 * @property {() => Promise<void>} stopDevice
 * @property {'snapshot'|'uninstall'} reset
 * @property {Record<string, any>} config
 * @property {string[]} caveats     Everything about this device that weakens the check.
 */

/** Keyed by build id, emptied on teardown. Never shared between two builds. */
const open = new Map();

/**
 * Read the size out of a PNG without decoding it.
 *
 * The pixel channel is evidence, never the accusation, so nothing here needs to look at the
 * picture. What is worth comparing is the shape of it and roughly how much is in it: a
 * screen that went blank weighs a fraction of one that did not.
 *
 * @param {Buffer} png
 * @returns {{width: number, height: number} | null}
 */
export function pngSize(png) {
  if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452) return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Choose how the device gets put back between builds, and say what that costs.
 *
 * @param {Session} session
 * @returns {Promise<{ok: boolean, why: string}>}
 */
async function resetDevice(session) {
  if (session.reset === 'snapshot') {
    const back = await snapshotLoad(session.device, CLEAN_SNAPSHOT);
    if (back.ok) return { ok: true, why: `the whole device was put back to how it was before anything was installed, in ${(back.ms / 1000).toFixed(1)} seconds` };
    // Falling back rather than failing: a weaker reset that says so beats no run at all.
    session.reset = 'uninstall';
    session.caveats.push(`the device would not restore its snapshot (${back.why}), so between builds only the app itself is removed — anything it changed outside its own folder carries over`);
  }
  const gone = await removeApp(session.device, session.apk.pkg);
  return { ok: gone.ok, why: gone.why };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const androidAdapter = defineAdapter({
  name: 'android',
  title: 'Android apps, on an emulator',
  describe:
    'Reads everything an APK declares — its version, every permission it asks for, and every screen, service, receiver and provider other apps on the phone can reach — straight out of the file, with nothing installed and no Java needed. Then, where there is an emulator, it puts the device back to a known state, installs one build at a time with the clock stopped and every animation switched off, walks each journey, and writes down what the screen MEANS through the accessibility layer, every call the app tried to make, every file it wrote, every permission it was really granted, and everything it crashed or complained about. Controls are found by what they are, never by where they are on screen. Nothing is allowed off the machine: every outbound call is written down at a proxy and stopped there, so what is inside an encrypted request is never seen and is reported as unchecked rather than passed. It cannot tell which program made a call, it cannot see the files a release build writes on a device that refuses root, and on a real handset it cannot run two builds at all.',
  channels: ['meaning', 'effects', 'complaints', 'results', 'contract', 'counters', 'pixels'],

  /** @param {import('./contract.js').AdapterProject} project */
  async detect(project) {
    const config = project.config ?? {};
    /** @type {Missing[]} */
    const missing = [];
    /** @type {string[]} */
    const notes = [];

    const apkFound = await findApk(project.root, config);
    const apk = apkFound.path ? await readApk(apkFound.path) : null;
    const looksAndroid = Boolean(apk?.ok)
      || fs.existsSync(path.join(project.root, 'android', 'app', 'build.gradle'))
      || fs.existsSync(path.join(project.root, 'app', 'build.gradle'))
      || fs.existsSync(path.join(project.root, 'android', 'app', 'build.gradle.kts'))
      || fs.existsSync(path.join(project.root, 'AndroidManifest.xml'));

    if (!apkFound.path) {
      missing.push({
        what: 'a built APK',
        unlocks: 'everything — without the app file there is nothing to read and nothing to install',
        howToGet: looksAndroid
          ? 'Build the app first (in most projects that is ./gradlew assembleRelease), or put {"apk": "path/to/your.apk"} under "android" in the settings.'
          : 'Put {"apk": "path/to/your.apk"} under "android" in the settings.',
        blocking: true,
      });
    } else if (apk && !apk.ok) {
      missing.push({ what: 'a readable APK', unlocks: 'reading what the app declares', howToGet: apk.why, blocking: true });
    }

    const adb = findAdb();
    const emulator = findEmulator();
    const avds = listAvds();
    const devices = adb ? await listDevices(adb) : [];
    const usable = devices.filter((d) => d.state === 'device');

    if (!adb) {
      missing.push({
        what: 'adb, the program that talks to an Android device',
        unlocks: 'installing the app and walking it. Everything the APK declares can still be checked without it',
        // A person has to accept a licence, so this is the third of the four states: only a
        // person can do it, and what they get for it is said in words they can act on.
        howToGet: 'Install the Android command line tools. On a Mac: brew install --cask android-commandlinetools, then run sdkmanager "platform-tools" "emulator". Somebody has to accept Google\'s licence once, and after that nothing here needs a person again.',
      });
    }
    if (adb && !emulator) {
      missing.push({
        what: 'the Android emulator',
        unlocks: 'running the app without a phone plugged in, which is the only way two builds can be compared',
        howToGet: `${path.dirname(path.dirname(adb))}/cmdline-tools/latest/bin/sdkmanager --install emulator`,
      });
    }
    if (emulator && avds.length === 0) {
      missing.push({
        what: 'a virtual device for the emulator to run',
        unlocks: 'having somewhere to install the app',
        howToGet: 'sdkmanager --install "system-images;android-33;google_apis;arm64-v8a" then avdmanager create avd -n staysfixed -k "system-images;android-33;google_apis;arm64-v8a". Pick a plain Google APIs image, NOT a Play Store one: a Play Store device refuses root forever, and without root the files an app writes cannot be seen.',
      });
    }

    const chosen = config.avd ? avds.find((a) => a.name === config.avd) : avds.find((a) => !a.playStore) ?? avds[0];
    if (chosen?.playStore) {
      missing.push({
        what: 'a virtual device built from a plain Google APIs image rather than a Play Store one',
        unlocks: 'seeing the files the app writes, and stopping the clock. A Play Store device refuses root permanently, and both of those need it',
        howToGet: 'avdmanager create avd -n staysfixed -k "system-images;android-33;google_apis;arm64-v8a"',
      });
    }
    if (usable.some((d) => !d.emulator)) {
      notes.push('There is a real phone plugged in. It can be walked, but two builds cannot be compared on it — a phone somebody is holding cannot be put back to a known state — so it is only ever compared against the record from last time, which is the weaker of the two.');
    }
    if (!config.journeys && !config.screens) {
      missing.push({
        what: 'a list of the things somebody actually does in this app',
        unlocks: 'checking what the app DOES rather than only what each screen looks like when it opens. Every screen other apps can reach is opened without this; nothing is typed, pressed or saved',
        howToGet: 'Put {"journeys": [{"name": "save a note", "steps": [{"act": "type", "into": "note text", "text": "hello"}, {"act": "press", "name": "save"}, {"act": "read"}]}]} under "android" in the settings.',
      });
    }

    const canWalk = Boolean(adb) && (usable.length > 0 || (Boolean(emulator) && avds.length > 0));
    const doors = apk?.components.length ?? 0;
    return {
      applies: looksAndroid,
      confidence: apk?.ok && canWalk ? 1 : apk?.ok ? 0.7 : looksAndroid ? 0.4 : 0,
      why: !looksAndroid
        ? 'Nothing here looks like an Android app: no APK, and no Gradle build for one.'
        : `${apk?.ok ? `${apk.why} ` : `${apkFound.why}. `}${
            canWalk
              ? `${usable.length > 0 ? `${usable.length} device${usable.length === 1 ? ' is' : 's are'} connected right now` : `no device is running, so one will be started from the ${chosen?.name} virtual device`}, so all ${doors} of those doors can also be opened and walked.`
              : 'There is no way to run it on this machine, so what the app declares can be checked but nothing can be opened.'
          }`,
      missing,
      notes: [
        ...notes,
        'What is compared is what the screen MEANS — the roles, names and states a screen reader would read — and every control is found by what it is, never by where it sits. Moving something, restyling it, or wrapping it in another layout reports nothing.',
        'The two builds are never installed at once. Android allows one app of a given name on a device, so each build is installed, walked and removed, and the whole device is put back in between.',
        'Nothing is allowed off this machine. Every call the app makes is written down at a proxy and stopped there — which also means what is inside an encrypted request is never seen, and is reported as unchecked rather than as fine.',
      ],
    };
  },

  /** @param {import('./contract.js').AdapterProject} project */
  async journeys(project) {
    const config = project.config ?? {};
    const found = await findApk(project.root, config);
    const apk = found.path ? await readApk(found.path) : null;
    return journeysFrom({ config, apk: apk?.ok ? apk : null, from: found.path ?? undefined });
  },

  /**
   * Get one build onto a device.
   *
   * The order matters and each step is here for a reason somebody paid for once. The APK is
   * read before anything is started, so a build that cannot be read costs no emulator boot.
   * The device is held still before the app is installed, so the very first launch already
   * has animations off. A clean snapshot is taken BEFORE the app goes on, so putting the
   * device back really does mean back. And the app is launched once and thrown away, because
   * the first launch after an install is genuinely different from every later one — it
   * builds caches, it compiles, and comparing a first launch against a later one reports a
   * difference that has nothing to do with anybody's change.
   *
   * @param {Build} build
   * @param {RunContext} ctx
   */
  async prepare(build, ctx) {
    const config = ctx.config ?? {};
    const base = path.join(ctx.scratchDir, `android-${build.id.slice(0, 12).replace(/[^A-Za-z0-9_-]/g, '-')}`);
    await fsp.mkdir(base, { recursive: true });

    /** @param {string} why */
    const notReady = (why) => ({
      build, root: base, ready: false, why,
      dispose: async () => { await fsp.rm(base, { recursive: true, force: true }); },
    });

    const found = await findApk(build.artifact ? path.dirname(build.artifact) : build.root, { ...config, apk: build.artifact ?? config.apk });
    if (!found.path) return notReady(`There is no APK for ${build.label}: ${found.why}.`);
    const apk = await readApk(found.path);
    if (!apk.ok) return notReady(`The APK for ${build.label} could not be read: ${apk.why}`);

    const adb = findAdb();
    if (!adb) {
      // Not a failure. Everything the APK declares was still read, and saying so is the
      // difference between "we could not check" and "there is nothing to check".
      return {
        build, root: base, ready: true,
        why: `adb is not on this machine, so ${build.label} cannot be installed or opened. What it declares — its version, its permissions and all ${apk.components.length} of its components — is still read straight out of the file, and every journey that needs a device is reported as unchecked rather than passed.`,
        facts: { apk: found.path, pkg: apk.pkg, deviceless: true },
        dispose: async () => { await fsp.rm(base, { recursive: true, force: true }); },
      };
    }

    /** @type {string[]} */
    const caveats = [];
    let serial = config.serial ?? null;
    let ownsDevice = false;
    let stopDevice = async () => {};

    if (!serial) {
      const already = (await listDevices(adb, ctx.signal)).filter((d) => d.state === 'device');
      const emulatorFirst = already.find((d) => d.emulator) ?? already[0];
      if (emulatorFirst) {
        serial = emulatorFirst.serial;
        // Somebody else's device. Used as found, never shut down, and never wiped.
        caveats.push(`this ran on ${serial}, which was already running and was left running afterwards`);
        if (!emulatorFirst.emulator) {
          caveats.push('this is a real phone, not an emulator: it cannot be put back to a known state, so this build can only be compared against the record from last time, never against another build run minutes earlier. That is the weaker of the two comparisons and it applies to every finding below.');
        }
      } else {
        const emulator = findEmulator();
        const avds = listAvds();
        const wanted = config.avd ? avds.find((a) => a.name === config.avd) : avds.find((a) => !a.playStore) ?? avds[0];
        if (!emulator || !wanted) {
          return notReady(`There is no device connected and no emulator to start${config.avd ? ` called ${config.avd}` : ''}, so ${build.label} cannot be opened.`);
        }
        ctx.log?.(`starting the ${wanted.name} emulator`);
        const started = await startEmulator({ emulator, adb, avd: wanted.name, signal: ctx.signal, log: ctx.log, headless: config.headless !== false });
        if (!started.ok) return notReady(`The emulator would not start: ${started.why}`);
        serial = started.serial;
        ownsDevice = true;
        stopDevice = started.stop;
        if (wanted.playStore) caveats.push(`${wanted.name} is a Play Store device, which refuses root: the clock cannot be stopped and the files this app writes cannot be seen`);
      }
    }

    const device = new Device(adb, /** @type {string} */ (serial), { signal: ctx.signal, log: ctx.log });
    const ready = await device.waitUntilReady(240000);
    if (!ready.ready) {
      await stopDevice();
      return notReady(ready.why);
    }

    const still = await holdStill(device, { clock: ctx.clock, timezone: config.timezone ?? 'UTC', locale: config.locale });
    caveats.push(...still.couldNot);

    /** @type {'snapshot'|'uninstall'} */
    let reset = 'uninstall';
    await removeApp(device, apk.pkg);
    if (config.reset !== 'uninstall' && (await listDevices(adb, ctx.signal)).some((d) => d.serial === serial && d.emulator)) {
      const saved = await snapshotSave(device, CLEAN_SNAPSHOT);
      if (saved.ok) reset = 'snapshot';
      else caveats.push(`the device would not save a snapshot (${saved.why}), so between builds only the app is removed and anything it changed elsewhere on the device carries over`);
    } else if (config.reset !== 'uninstall') {
      caveats.push('this is not an emulator, so the device cannot be snapshotted: between builds only the app is removed, and anything it changed elsewhere carries over');
    }

    const installed = await installApk(device, found.path);
    if (!installed.ok) {
      if (ownsDevice) await stopDevice();
      return notReady(installed.why);
    }

    // Burn the first launch. It is measurably different from every later one and comparing
    // one against the other is a difference nobody caused.
    const warmStart = Date.now();
    if (apk.launchActivity) {
      await device.shell(`am start -W -n ${apk.pkg}/${apk.launchActivity}`, { timeoutMs: 120000 });
      await settleScreen(device, { tries: 8 });
      await device.shell(`am force-stop ${apk.pkg}`, { timeoutMs: 30000 });
    }
    const warmMs = Date.now() - warmStart;

    /** @type {Session} */
    const session = { device, apk, apkPath: found.path, ownsDevice, stopDevice, reset, config, caveats };
    open.set(build.id, session);

    return {
      build,
      root: base,
      ready: true,
      why: `${build.label} is installed on ${serial} (${apk.pkg} ${apk.versionName ?? ''} build ${apk.versionCode ?? '?'}). The clock, the time zone, the text size and every animation are pinned, the first launch has been used up and thrown away, and between builds the device is put back ${reset === 'snapshot' ? 'completely, from a snapshot taken before anything was installed' : 'by removing the app — which does not undo anything it changed elsewhere on the device'}.${caveats.length > 0 ? ` Worth knowing: ${caveats.join('; ')}.` : ''}`,
      facts: {
        serial: /** @type {string} */ (serial),
        pkg: apk.pkg,
        apk: found.path,
        reset,
        rooted: device.rooted === true,
        firstLaunchMs: warmMs,
        ownsDevice,
      },
      dispose: async () => {
        open.delete(build.id);
        try {
          await resetDevice(session);
        } catch {
          // Putting the device back is best effort; failing here must not hide a finding.
        }
        // Only ever stop an emulator this tool started.
        if (ownsDevice) await stopDevice();
        await fsp.rm(base, { recursive: true, force: true });
      },
    };
  },

  /**
   * Walk one journey against one prepared build.
   *
   * @param {Journey} journey
   * @param {import('./contract.js').PreparedBuild} prepared
   * @param {RunContext} ctx
   * @returns {Promise<Observation[]>}
   */
  async run(journey, prepared, ctx) {
    /** @type {Observation[]} */
    const out = [];
    const session = open.get(prepared.build.id);

    // The one journey that needs nothing but the file.
    if (journey.name === DECLARED) {
      const apkPath = String(prepared.facts?.apk ?? session?.apkPath ?? '');
      const apk = session?.apk ?? (apkPath ? await readApk(apkPath) : null);
      if (!apk?.ok) {
        return [notCovered({ channel: 'contract', path: ['manifest', 'read'], reason: 'missing tool', says: 'the app file could not be read, so nothing it declares was checked' })];
      }
      return declaredObservations(apk, apkPath);
    }

    if (!session) {
      return [notCovered({
        channel: 'meaning',
        path: joinPath('screen', journey.name, 'walked'),
        reason: 'missing tool',
        says: `"${journey.name}" was not walked: ${prepared.why}`,
      })];
    }

    const { device, apk } = session;
    const started = Date.now();

    if (journey.irreversible && ctx.allowIrreversible !== true) {
      return [notCovered({
        channel: 'effects',
        path: joinPath('screen', journey.name, 'walked'),
        reason: 'irreversible',
        says: `"${journey.name}" was not walked because doing it for real would spend money, send a message or destroy data. It is unchecked, not fine.`,
      })];
    }

    // Every run starts from the same place: the app stopped, its own data cleared, logs
    // emptied. Without this the second journey inherits whatever the first one left behind,
    // and the order journeys happen to run in becomes part of the answer.
    await device.shell(`am force-stop ${apk.pkg}`, { timeoutMs: 30000 });
    await device.shell(`pm clear ${apk.pkg}`, { timeoutMs: 60000 });
    await device.shell('logcat -c; logcat -c -b events', { timeoutMs: 30000 });

    const wire = await watchTheWire({ allowTo: session.config.allowTo ?? [], log: ctx.log });
    await device.shell(`settings put global http_proxy ${HOST_FROM_EMULATOR}:${wire.port}`, { timeoutMs: 30000 });

    /** @type {string[]} */
    const trouble = [];
    let checkpoints = 0;

    /**
     * Read the screen and write down everything on it.
     * @param {string} label
     */
    const readScreen = async (label) => {
      checkpoints += 1;
      const settled = await settleScreen(device, { tries: session.config.settleTries ?? 6 });
      if (!settled.ok) {
        out.push(notCovered({
          channel: 'meaning',
          path: joinPath('screen', journey.name, label, 'read'),
          reason: 'crashed',
          says: `the screen could not be read at "${label}": ${settled.why}`,
        }));
        return [];
      }
      const nodes = readTree(settled.xml, { pkg: apk.pkg });
      out.push(...screenObservations({ nodes, journey: journey.name, step: label, settled: settled.settled }));

      const shot = await screenshot(device, path.join(ctx.evidenceDir, `${journey.name.replace(/[^\w -]/g, '')}-${label.replace(/[^\w -]/g, '')}.png`));
      if (shot.ok) {
        const size = pngSize(await fsp.readFile(shot.path));
        out.push(observation({
          channel: 'pixels',
          path: joinPath('pixels', journey.name, label),
          // Coarse on purpose. This is evidence for a finding another channel already made,
          // and a value precise enough to differ on its own would turn it into an accusation.
          value: size ? { shape: `${size.width} by ${size.height}`, weight: sizeBucket(shot.bytes) } : { shape: 'unknown', weight: sizeBucket(shot.bytes) },
          says: `a picture of "${label}" was kept as evidence`,
          evidence: shot.path,
          journey: journey.name,
          surface: 'android',
        }));
      }
      return nodes;
    };

    try {
      /** @type {Node[]} */
      let nodes = [];
      const steps = journey.steps ?? [{ act: 'open' }, { act: 'read' }];

      for (let i = 0; i < steps.length; i += 1) {
        const step = /** @type {any} */ (steps[i]);
        const label = String(step.note ?? step.act ?? `step ${i + 1}`);

        if (step.act === 'open') {
          const target = step.activity ? `${apk.pkg}/${String(step.activity).startsWith('.') ? String(step.activity) : String(step.activity)}` : `${apk.pkg}/${apk.launchActivity}`;
          const launch = await device.shell(`am start -W -n ${target}`, { timeoutMs: 120000 });
          const state = (/LaunchState:\s*(\w+)/.exec(launch.out) ?? [])[1] ?? 'unknown';
          out.push(observation({
            channel: 'counters',
            path: joinPath('count', journey.name, label, 'how it started'),
            value: state,
            says: `the screen came up ${state === 'COLD' ? 'from nothing, with the app not already running' : state.toLowerCase()}`,
            journey: journey.name,
            surface: 'android',
          }));
          if (/Error|Exception/i.test(launch.out + launch.err)) trouble.push(`the screen would not open: ${launch.out.trim() || launch.err.trim()}`);
          nodes = await readScreen(label);
          continue;
        }

        if (step.act === 'read') {
          nodes = await readScreen(label);
          continue;
        }

        if (step.act === 'press' || step.act === 'tap' || step.act === 'tick') {
          if (nodes.length === 0) nodes = readTree((await settleScreen(device)).xml, { pkg: apk.pkg });
          const want = { id: step.id, name: step.name, text: step.text, kind: step.kind, address: step.address };
          for (const key of Object.keys(want)) if (/** @type {any} */ (want)[key] === undefined) delete /** @type {any} */ (want)[key];
          const hits = findNodes(nodes, want);
          if (hits.length === 0) {
            out.push(notCovered({
              channel: 'meaning',
              path: joinPath('screen', journey.name, label, 'pressed'),
              reason: 'not supported here',
              says: `nothing on this screen answers to ${JSON.stringify(want)}, so the rest of "${journey.name}" was not walked. That is a finding in itself: the control this journey depends on is not there.`,
            }));
            break;
          }
          if (hits.length > 1) {
            // Pressing the first of several would make the walk depend on the order the
            // accessibility layer happened to list them in, which is not something to build on.
            out.push(notCovered({
              channel: 'meaning',
              path: joinPath('screen', journey.name, label, 'pressed'),
              reason: 'refused',
              says: `${hits.length} things on this screen answer to ${JSON.stringify(want)}, so nothing was pressed rather than guessing which one was meant`,
            }));
            break;
          }
          if (!hits[0].enabled) {
            out.push(observation({
              channel: 'meaning',
              path: joinPath('screen', journey.name, label, 'pressed'),
              value: 'could not — it is greyed out',
              says: `"${hits[0].name || hits[0].kind}" is on screen but greyed out, so it could not be pressed`,
              journey: journey.name,
              surface: 'android',
            }));
            break;
          }
          await pressNode(device, hits[0]);
          await pause(step.settleMs ?? 600, ctx.signal);
          nodes = await readScreen(label);
          continue;
        }

        if (step.act === 'type') {
          if (nodes.length === 0) nodes = readTree((await settleScreen(device)).xml, { pkg: apk.pkg });
          const field = findNodes(nodes, step.into ? { name: String(step.into) } : { kind: 'EditText' })[0]
            ?? findNodes(nodes, { id: String(step.into ?? '') })[0];
          if (!field) {
            out.push(notCovered({
              channel: 'meaning',
              path: joinPath('screen', journey.name, label, 'typed'),
              reason: 'not supported here',
              says: `there is nowhere on this screen called "${step.into ?? 'a text field'}" to type into, so the rest of "${journey.name}" was not walked`,
            }));
            break;
          }
          await pressNode(device, field);
          await pause(300, ctx.signal);
          const typed = await typeText(device, String(step.text ?? ''));
          if (!typed.ok) {
            out.push(notCovered({ channel: 'meaning', path: joinPath('screen', journey.name, label, 'typed'), reason: 'not supported here', says: typed.why }));
            break;
          }
          await device.shell('input keyevent KEYCODE_ESCAPE', { timeoutMs: 20000 });
          nodes = await readScreen(label);
          continue;
        }

        if (step.act === 'back') {
          await device.shell('input keyevent KEYCODE_BACK', { timeoutMs: 20000 });
          await pause(500, ctx.signal);
          nodes = await readScreen(label);
          continue;
        }

        if (step.act === 'key') {
          await device.shell(`input keyevent ${String(step.key ?? 'KEYCODE_ENTER').replace(/[^A-Z_0-9]/g, '')}`, { timeoutMs: 20000 });
          await pause(400, ctx.signal);
          nodes = await readScreen(label);
          continue;
        }

        if (step.act === 'wait') {
          await pause(Math.min(Number(step.ms ?? 1000), 30000), ctx.signal);
          continue;
        }

        out.push(notCovered({
          channel: 'meaning',
          path: joinPath('screen', journey.name, label, 'done'),
          reason: 'not supported here',
          says: `this adapter does not know how to "${step.act}", so that step and everything after it in "${journey.name}" was skipped`,
        }));
        break;
      }

      // --- what went out ------------------------------------------------------
      const pid = await pidOf(device, apk.pkg);
      const calls = await wire.stop();
      await device.shell('settings put global http_proxy :0', { timeoutMs: 30000 });

      /** @type {Map<string, number>} */
      const byCall = new Map();
      let fromTheApp = 0;
      for (const call of calls) {
        const key = `${call.method} ${call.host}${call.route}`;
        byCall.set(key, (byCall.get(key) ?? 0) + 1);
      }
      /**
       * The phone's own background chatter is COUNTED, never given an address of its own.
       *
       * A device-wide proxy sees the whole phone, and on a Google APIs emulator most of what
       * it sees is Play services: checking connectivity, fetching fonts, asking about digital
       * asset links, phoning gmscompliance. None of it belongs to the app being checked, none
       * of it is the same twice, and every one of those hosts given an address of its own is
       * an address that appears in one run and is gone in the next.
       *
       * Measured on Terminal Deck on 2026-08-30, on a build with NOTHING changed in it: eight
       * findings, seven of them a Google host that came or went. Running the build twice
       * subtracted fifteen more and still could not subtract those, because this traffic is
       * not merely unstable — it is episodic, so a run pair can agree with itself and still
       * disagree with the run pair before it. Left as it was, an Android check reports noise
       * on a build nobody touched, and the first thing anybody does with a tool that cries
       * wolf is switch it off.
       *
       * So: the app's own calls keep one address each, which is the signal worth having, and
       * the phone's own are reduced to a count that sits on one rung of a coarse ladder. What
       * was seen is still said in plain English, and the ledger still records that nothing
       * inside those requests was ever opened.
       */
      let fromThePhone = 0;
      for (const [key, times] of [...byCall.entries()].sort()) {
        const call = calls.find((c) => `${c.method} ${c.host}${c.route}` === key);
        if (!call) continue;
        if (isDeviceHost(call.host)) {
          fromThePhone += 1;
          continue;
        }
        fromTheApp += 1;
        out.push(observation({
          channel: 'effects',
          path: joinPath('net', journey.name, 'the app', key),
          value: { asked: countBucket(times), reached: call.allowed ? 'let through' : 'stopped here' },
          says: `the app tried to call ${key}${times > 1 ? ` ${times} times` : ''} — ${call.why}`,
          covered: call.how === 'encrypted' ? false : undefined,
          reason: call.how === 'encrypted' ? 'not supported here' : undefined,
          journey: journey.name,
          surface: 'android',
        }));
      }
      out.push(notCovered({
        channel: 'effects',
        path: joinPath('net', journey.name, 'the phone itself'),
        reason: 'not supported here',
        says: `${fromThePhone === 0 ? 'nothing else on the phone' : `${fromThePhone} other thing${fromThePhone === 1 ? '' : 's'} on the phone`} reached out while this ran — Android\'s own services, not this app. It is watched and stopped here like everything else, and it is not compared, because a device-wide proxy cannot tell which program made a call and Google\'s background traffic is different every single run.`,
      }));
      out.push(observation({
        channel: 'counters',
        path: joinPath('count', journey.name, 'calls the app made'),
        value: countBucket(fromTheApp),
        says: `the app reached out ${fromTheApp} time${fromTheApp === 1 ? '' : 's'} while this journey ran`,
        journey: journey.name,
        surface: 'android',
      }));

      const files = await filesWritten(device, apk.pkg);
      if (!files.ok) {
        out.push(notCovered({ channel: 'effects', path: joinPath('file', journey.name), reason: 'not supported here', says: files.why }));
      } else {
        for (const file of files.files) {
          out.push(observation({
            channel: 'effects',
            path: joinPath('file', journey.name, file.path),
            value: file.bytes,
            says: `the app wrote ${file.path}, ${file.bytes}`,
            journey: journey.name,
            surface: 'android',
          }));
        }
        out.push(observation({
          channel: 'counters',
          path: joinPath('count', journey.name, 'files written'),
          value: countBucket(files.files.length),
          says: `the app left ${files.files.length} file${files.files.length === 1 ? '' : 's'} behind`,
          journey: journey.name,
          surface: 'android',
        }));
      }

      const held = await permissionsHeld(device, apk.pkg);
      for (const permission of held.granted) {
        out.push(observation({
          channel: 'effects',
          path: joinPath('perm', journey.name, permission),
          value: 'granted',
          says: `the app has been granted ${permission.replace(/^android\.permission\./, '')}`,
          journey: journey.name,
          surface: 'android',
        }));
      }

      for (const component of await intentsFired(device, apk.pkg)) {
        out.push(observation({
          channel: 'effects',
          path: joinPath('proc', journey.name, 'opened', component),
          value: 'opened',
          says: `the app asked Android to open ${component}`,
          journey: journey.name,
          surface: 'android',
        }));
      }

      // --- what it complained about ------------------------------------------
      const said = await complaints(device, { pkg: apk.pkg, pid: pid ?? undefined });
      out.push(observation({
        channel: 'complaints',
        path: joinPath('log', journey.name, 'crashed'),
        value: said.crashes.length > 0,
        says: said.crashes.length > 0 ? `the app crashed: ${said.crashes[0]}` : 'the app did not crash',
        journey: journey.name,
        surface: 'android',
      }));
      out.push(observation({
        channel: 'complaints',
        path: joinPath('log', journey.name, 'froze'),
        value: said.anrs.length > 0,
        says: said.anrs.length > 0 ? `the app stopped responding: ${said.anrs[0]}` : 'the app never stopped responding',
        journey: journey.name,
        surface: 'android',
      }));
      out.push(observation({
        channel: 'complaints',
        path: joinPath('log', journey.name, 'errors'),
        value: countBucket(said.errors.length),
        says: said.errors.length > 0 ? `the app logged ${said.errors.length} error${said.errors.length === 1 ? '' : 's'}, the first being: ${said.errors[0]}` : 'the app logged no errors',
        journey: journey.name,
        surface: 'android',
      }));
      for (const problem of trouble) {
        out.push(observation({
          channel: 'complaints',
          path: joinPath('log', journey.name, 'would not open'),
          value: problem,
          says: problem,
          journey: journey.name,
          surface: 'android',
        }));
      }

      out.push(observation({
        channel: 'counters',
        path: joinPath('count', journey.name, 'how long'),
        value: timeBucket(Date.now() - started),
        says: `walking "${journey.name}" took ${timeBucket(Date.now() - started)}`,
        journey: journey.name,
        surface: 'android',
      }));
      out.push(observation({
        channel: 'counters',
        path: joinPath('count', journey.name, 'screens read'),
        value: countBucket(checkpoints),
        says: `${checkpoints} screen${checkpoints === 1 ? ' was' : 's were'} read along the way`,
        journey: journey.name,
        surface: 'android',
      }));

      for (const caveat of session.caveats) {
        out.push(notCovered({
          channel: 'complaints',
          path: joinPath('log', journey.name, 'worth knowing', caveat.slice(0, 48)),
          reason: 'not supported here',
          says: caveat,
        }));
      }
      return out;
    } finally {
      await wire.stop().catch(() => {});
      await device.shell('settings put global http_proxy :0', { timeoutMs: 30000 }).catch(() => {});
    }
  },

  /**
   * Put everything back.
   *
   * Only what this tool started is stopped. Somebody's own emulator, and their own phone, are
   * left exactly as they were found — including the app, if it was already on there.
   */
  async teardown() {
    for (const [id, session] of [...open.entries()]) {
      try {
        await resetDevice(session);
        await session.device.shell('settings put global http_proxy :0', { timeoutMs: 20000 });
        if (session.ownsDevice) await session.stopDevice();
      } catch {
        // Nothing here is worth throwing over: teardown must never hide a finding.
      }
      open.delete(id);
    }
  },
});

export default androidAdapter;
