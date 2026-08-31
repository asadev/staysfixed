/**
 * Native Mac applications — Swift or Objective-C, AppKit or SwiftUI — read on the Mac they
 * already run on.
 *
 * ── WHAT WAS MEASURED BEFORE ANY OF THIS WAS WRITTEN ───────────────────────────────────────
 *
 * The plan for this surface assumed a small Swift probe would have to be built and shipped,
 * the same assumption the Windows plan made about a .NET one. That was checked against a real
 * Mac — macOS 27.0, Apple silicon — on 2026-08-31 before a line was written, and it is the
 * wrong answer. Four measurements settled it.
 *
 *   1. `osascript -l JavaScript` is on every Mac and needs no developer tools. Its
 *      Objective-C bridge publishes the WHOLE accessibility C API through the BridgeSupport
 *      files that ship with the system: AXUIElementCreateApplication, CopyAttributeValue,
 *      CopyMultipleAttributeValues, CopyActionNames, PerformAction, SetAttributeValue,
 *      SetMessagingTimeout. A compiled Swift probe would have no more reach than this, and
 *      would need Xcode to build and a signature to run. So the probe is JavaScript, handed
 *      to `osascript` on standard input, living only in the memory of the process running it.
 *   2. It is fast enough. A real AppKit window — sixteen controls with roles, names,
 *      identifiers, values, enabled states and action lists — read in 57 milliseconds.
 *      Finder's window: 17 controls, 79ms. TextEdit with one empty document: 204 controls,
 *      788ms. That is about 3.9 milliseconds a control, against 2.0 measured for Windows UI
 *      Automation. macOS has no cached subtree read, so every attribute is a live message
 *      into the app; batching all twelve attributes and the child list into ONE message is
 *      what makes it affordable. The first version asked one at a time and could not finish a
 *      large window in two minutes.
 *   3. It does not scale to a table. Activity Monitor's window is 5,821 controls and takes
 *      15.6 seconds to read, and had not finished after twenty with action lists switched on.
 *      So this adapter caps a window at 1,500 controls and twelve seconds and REPORTS both
 *      caps rather than quietly returning a short tree.
 *   4. Pressing works and clicking does not. `AXUIElementPerformAction(el, AXPress)` really
 *      fires the handler: an on-screen counter went 0-1-2-3 across three presses, the app's
 *      own output logged each one, and pressing Save wrote a real file. Synthetic mouse
 *      events do not do this in these apps, which is why nothing here sends one.
 *
 * ── THE ONE THAT MATTERS MOST ──────────────────────────────────────────────────────────────
 *
 * TWO COPIES OF THE SAME APP BREAK THE ACCESSIBILITY LAYER, AND IT LOOKS EXACTLY LIKE AN
 * EMPTY WINDOW. Reproduced twice on 2026-08-31, on purpose. One build was read correctly for
 * twenty minutes. A second build of the same app — same bundle identifier, different folder —
 * was opened alongside it. The newer one answered in 98ms; THE OLDER ONE WENT DARK, returning
 * zero windows after a two-second timeout, while CoreGraphics still showed its real window,
 * on screen, 460 by 332, with its title. Killing the newer one brought the older one back
 * immediately, in 178ms.
 *
 * A third attempt the same afternoon did not reproduce it: both copies answered fine. That
 * makes this WORSE rather than better. A fault that happens every time gets found on the first
 * run and fixed; one that happens sometimes gets found on the run somebody trusted.
 *
 * And it is the exact shape of the failure this whole product exists to prevent. Zero controls
 * from one build and zero from the other reads as "nothing changed". Zero from the old build
 * and a full tree from the new one reads as "every control in the app vanished". Both are lies
 * and neither one announces itself.
 *
 * So: every window read is cross-checked against CoreGraphics' own on-screen window list,
 * which is a completely different mechanism — the window server, which drew the window, rather
 * than the app's accessibility responder, which is the thing that has gone quiet. When they
 * disagree, nothing is recorded and the reason is. And this adapter runs ONE build at a time
 * and stops the previous one first, and refuses to read at all when it finds another copy of
 * the same app running that it did not start.
 *
 * ── WHAT IT WATCHES ────────────────────────────────────────────────────────────────────────
 *
 *   meaning     The window tree from the Accessibility API: what each control IS (a button, a
 *               checkbox, a pop-up), what it is CALLED, its accessibility identifier, whether
 *               it is on, off, selected or focused, what it currently says, and what actions
 *               it says it can be asked to perform. This is the channel that answers "what
 *               does this screen now do", and it is the reason this surface is worth having.
 *   effects     Programs it started, and files that changed in the folders it was told to
 *               watch — by CONTENT, not by size, because this runs on the same machine.
 *   complaints  Crash reports macOS filed for it, anything it logged at error or fault level,
 *               and whether it was still running at the end.
 *   results     What it printed, and the titles of the windows it opened.
 *   counters    How many windows, how many controls, how many files, in buckets.
 *   pixels      A picture of each window, as evidence for something another channel already
 *               found. Never compared.
 *
 * ── WHAT IT CANNOT DO, SAID PLAINLY ────────────────────────────────────────────────────────
 *
 * ONE PERSON MUST CLICK ONE THING, ONCE, AND NOTHING HERE CAN DO IT FOR THEM. Reading another
 * app's window needs Accessibility permission, and macOS deliberately makes that ungrantable
 * from a script — that is the whole point of it. Until the terminal or editor running Stays
 * Fixed is ticked under System Settings, Privacy & Security, Accessibility, this surface reads
 * nothing at all, and it says so as a blocking gap rather than as an empty result.
 *
 * ONE DESKTOP, ONE BUILD AT A TIME. For the bundle-identifier reason above, and because the
 * desktop is shared with whatever else that person has open. A notification arriving mid-run
 * is a real source of difference that no amount of freezing removes. Running twice and
 * subtracting the wobble absorbs some of it. It does not absorb all of it.
 *
 * THERE IS NO SAFETY BOUNDARY AT THE WIRE. The CLI adapter can watch a program ask to reach
 * the internet and refuse it, because it loads a watcher inside a Node child. There is no
 * equivalent for a compiled Mac application: everything that would really capture what it does
 * — `fs_usage`, `dtrace`, an Endpoint Security client — needs root or an Apple entitlement. So
 * a journey marked irreversible is REFUSED OUTRIGHT here rather than walked carefully. It is
 * reported as missing coverage, and it never runs.
 *
 * FILES ARE WATCHED WHERE IT IS TOLD, NOT EVERYWHERE. Same limit as Windows, with one real
 * improvement: this runs on the same machine, so the folders it watches are compared by the
 * CONTENTS of every file rather than by size. A file rewritten with different bytes and the
 * same length is caught here and is missed on Windows. A file written OUTSIDE those folders is
 * still not seen, and that is reported as a hole rather than as a clean result.
 *
 * CONNECTIONS ARE SAMPLED, NOT CAPTURED. `lsof` lists what the app has open at the moment it
 * is asked, without needing root. A connection that opens and closes between two samples is
 * not seen, and nothing here could have stopped one.
 *
 * AN APP THAT INSISTS ON COMING TO THE FRONT WILL COME TO THE FRONT. Everything here opens in
 * the background — `open -g`, never a direct spawn, because the same binary spawned directly
 * twice left the foreground alone once and took it once, and unpredictable is worse than
 * wrong. But an app that calls `activate` on itself takes the screen and no launcher option
 * prevents it. That is the app's behaviour, not this tool's, and it is reported rather than
 * hidden.
 *
 * MENUS AND MODAL SHEETS ARE NOT WALKED. Pressing a menu opens something that holds the event
 * loop, and a modal sheet stops the window underneath answering. Both are readable if a
 * journey deliberately opens them; neither is opened by this adapter on its own. An adapter
 * that guessed which menu items to press on an unknown Mac app is an adapter that will one day
 * press Delete.
 *
 * A PICTURE NEEDS A SECOND PERMISSION. Screen Recording, separately from Accessibility. Without
 * it the picture comes back black or not at all, and that is recorded as a hole in the pixels
 * channel with every other channel still reported in full.
 *
 * MOST MAC PRODUCTS DO NOT NEED THIS AT ALL. If the Mac build is Electron — and most desktop
 * products are, including the one this tool was written alongside — it is already covered from
 * any machine over its debug port by the Electron adapter, in full, with two builds able to run
 * side by side. This adapter DECLINES an Electron bundle on purpose and says where to go
 * instead. Reading one here would also mean switching on Chromium's accessibility engine, which
 * changes the timing and the behaviour of the very thing being measured.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  countBucket, defineAdapter, joinPath, notCovered, observation, sizeBucket, timeBucket,
} from './contract.js';
import {
  MAX_SHOT_BYTES, MAX_TREE_NODES, TREE_BUDGET_MS, WINDOW_WAIT_MS,
  askTheScreen, crashesSince, descendantsOf, inspectBundle, loggedBy, openInTheBackground,
  pictureOfWindow, pidsRunning, processList, runQuietly, stopOne,
} from './macos-driver.js';
import { compareTrees, snapshotTree } from './process.js';

/** @typedef {import('./contract.js').Build} Build */
/** @typedef {import('./contract.js').PreparedBuild} PreparedBuild */
/** @typedef {import('./contract.js').RunContext} RunContext */
/** @typedef {import('./contract.js').AdapterProject} AdapterProject */
/** @typedef {import('./contract.js').Detection} Detection */
/** @typedef {import('./contract.js').Missing} Missing */
/** @typedef {import('../types.js').Journey} Journey */
/** @typedef {import('../types.js').Observation} Observation */

/** How many times to re-read a window looking for two readings in a row that match. */
const SETTLE_TRIES = 5;

/** How long to wait between those readings. */
const SETTLE_GAP_MS = 250;

/** The exact click a person has to make once, spelt out wherever it is needed. */
export const HOW_TO_ALLOW =
  'Open System Settings, then Privacy & Security, then Accessibility, and switch on the app you '
  + 'run Stays Fixed from — Terminal, iTerm, or your editor. macOS will not let any program grant '
  + 'itself that, which is the point of it.';

// ---------------------------------------------------------------------------
// One control, turned into something comparable
// ---------------------------------------------------------------------------

/**
 * @typedef {object} TreeNode
 * @property {number} d
 * @property {string|null} role
 * @property {string|null} sub
 * @property {string|null} title
 * @property {string|null} desc
 * @property {string|number|null} value
 * @property {string|null} id
 * @property {boolean|number|null} on
 * @property {string|null} help
 * @property {string|null} hint
 * @property {boolean|number|null} sel
 * @property {boolean|number|null} foc
 * @property {string[]} can
 */

/**
 * The address one control lives at.
 *
 * Built from what the control IS and what it is CALLED, never from where it sits in the tree.
 * An index would be stable right up until somebody adds a control above it, at which point
 * every control below would report as changed and the real change would be buried.
 *
 * The accessibility identifier comes first because it is the one thing a developer sets
 * deliberately and a translator never touches. Then the title, then the description — which is
 * what a toolbar button or an image button is actually called on a Mac, where the title is
 * usually empty. Only when a control has none of those does its position get used, and that is
 * marked in the address so a reader knows the address itself is fragile.
 *
 * @param {TreeNode} node
 * @param {number} index
 * @returns {string}
 */
export function controlAddress(node, index) {
  const role = String(node.role ?? 'unknown').replace(/^AX/, '').toLowerCase();
  const called = node.id || node.title || node.desc;
  if (called) return `${role}:${called}`;
  return `${role}#${index}`;
}

/**
 * What one control says it is, in one line, and it is the only thing compared.
 *
 * Deliberately excludes where it is on screen. A window that opens two pixels lower is not a
 * difference anybody wants reported, and a control that MOVED without changing what it is or
 * does is a pixel finding, not a meaning one. What is included is what would make somebody say
 * the product behaves differently: what it is, what it is called, whether it works, what it is
 * set to, and what it can be asked to do.
 *
 * Focus is left out on purpose and it is the subtle one. Which control has the keyboard on a
 * Mac depends on whether that app happens to be the front app, and this adapter deliberately
 * opens apps in the background — so focus would flip depending on what the person using the
 * machine clicked on while the run was going, and report as a regression.
 *
 * @param {TreeNode} node
 * @returns {string}
 */
export function controlMeaning(node) {
  const parts = [String(node.role ?? 'something with no role').replace(/^AX/, '')];
  if (node.sub) parts.push(`(${String(node.sub).replace(/^AX/, '')})`);
  const called = node.title || node.desc;
  if (called) parts.push(`called "${called}"`);
  // A checkbox's tick, a text field's contents and a slider's position all arrive as AXValue,
  // and all three are exactly what a person means by "the screen changed".
  if (node.value !== null && node.value !== undefined && node.value !== '') parts.push(`showing ${JSON.stringify(node.value)}`);
  if (node.on === false || node.on === 0) parts.push('greyed out');
  if (node.sel === true || node.sel === 1) parts.push('selected');
  if (node.hint) parts.push(`placeholder "${node.hint}"`);
  if (node.help) parts.push(`tooltip "${node.help}"`);
  if (node.can && node.can.length > 0) parts.push(`can ${node.can.map((a) => a.replace(/^AX/, '')).join(', ')}`);
  return parts.join(', ');
}

/**
 * Turn one window's tree into observations, or into a hole when the read cannot be trusted.
 *
 * The cross-check is the important half, and it is why `onScreen` comes back from the probe at
 * all. CoreGraphics and the accessibility layer are two different mechanisms answering the same
 * question. When the window server says a window is up, 460 by 332, with a title, and the app's
 * accessibility responder says the app has no windows, the accessibility answer is wrong —
 * measured on 2026-08-31, caused by a second copy of the same app being open. Recording that as
 * "this app has no controls" would put a confident zero into the reference, after which every
 * later run would compare zero against zero and agree that nothing had changed.
 *
 * @param {object} spec
 * @param {Journey} spec.journey
 * @param {string} spec.window
 * @param {TreeNode[]} spec.nodes
 * @param {number} spec.onScreenCount   How many windows the window server can see for this app.
 * @param {number} spec.childCount      Direct children, asked for through a different call.
 * @param {boolean} [spec.settled]
 * @param {boolean} [spec.truncated]
 * @param {boolean} [spec.ranOut]
 * @returns {Observation[]}
 */
export function meaningFromTree(spec) {
  const { journey, window: windowName, nodes, onScreenCount, childCount } = spec;
  // The journey is in the address, not only the window. Every index in this engine keeps the
  // FIRST observation at a path and drops the rest, so two journeys that both read the same
  // window would collide: the second journey's answer would have no address of its own, would
  // never be compared with anything, and the run would still say nothing had changed. The
  // effects and counters paths already carried the journey for this reason; the screen ones
  // did not, and that was found by running two journeys against one window on 2026-08-31.
  const head = ['screen', journey.name, windowName];

  if (nodes.length === 0 && onScreenCount > 0) {
    return [notCovered({
      channel: 'meaning',
      path: joinPath(...head, 'controls'),
      reason: 'not supported here',
      says: `"${windowName}" is on the screen — macOS itself can see the window — but the app would not say what is `
        + 'in it. On a Mac that almost always means a second copy of the same app is running, which makes the older '
        + 'one stop answering. Nothing is recorded for it, because recording "no controls" would make the next run '
        + 'agree that nothing had changed.',
    })];
  }
  if (nodes.length === 0) {
    return [notCovered({
      channel: 'meaning',
      path: joinPath(...head, 'controls'),
      reason: 'not supported here',
      says: `"${windowName}" reported no controls at all. Either it draws itself without telling macOS what it is `
        + 'showing, or there was nothing on it yet. Either way it is unchecked, not empty.',
    })];
  }
  if (nodes.length === 1 && childCount > 1) {
    return [notCovered({
      channel: 'meaning',
      path: joinPath(...head, 'controls'),
      reason: 'not supported here',
      says: `"${windowName}" says it has ${childCount} things in it and then handed back none of them. That is a `
        + 'half-answer, not an empty window, so nothing was recorded for it.',
    })];
  }

  /** @type {Observation[]} */
  const out = [];
  /** @type {Map<string, number>} */
  const used = new Map();
  nodes.forEach((node, index) => {
    let address = controlAddress(node, index);
    // Two controls can honestly share a name — two "Close" buttons in two panels. Number the
    // repeats rather than let the second quietly overwrite the first.
    const seen = used.get(address) ?? 0;
    used.set(address, seen + 1);
    if (seen > 0) address = `${address}~${seen + 1}`;
    const meaning = controlMeaning(node);
    out.push(observation({
      channel: 'meaning',
      path: joinPath(...head, address),
      value: meaning,
      says: `On "${windowName}", ${meaning}.`,
      journey: journey.name,
      surface: 'macos',
    }));
  });

  out.push(observation({
    channel: 'counters',
    path: joinPath('count', journey.name, windowName, 'controls'),
    value: countBucket(nodes.length),
    says: `"${windowName}" is showing ${nodes.length} control${nodes.length === 1 ? '' : 's'}.`,
    journey: journey.name,
    surface: 'macos',
  }));

  if (spec.settled === false) {
    out.push(notCovered({
      channel: 'meaning',
      path: joinPath(...head, 'settled'),
      reason: 'timed out',
      says: `"${windowName}" never held still: two readings in a row never matched. What was recorded is one snapshot `
        + 'of something still moving, so a difference found in it may be the movement rather than the change.',
    }));
  }
  if (spec.truncated) {
    out.push(notCovered({
      channel: 'meaning',
      path: joinPath(...head, 'all of it'),
      reason: 'too big',
      says: `"${windowName}" has more than ${MAX_TREE_NODES} controls, so only the first ${MAX_TREE_NODES} were read. `
        + 'Anything past that is unchecked. Reading a Mac window costs about four milliseconds a control, so a table '
        + 'with thousands of rows in it would take longer than the rest of the check put together.',
    }));
  }
  if (spec.ranOut) {
    out.push(notCovered({
      channel: 'meaning',
      path: joinPath(...head, 'the rest of it'),
      reason: 'timed out',
      says: `Reading "${windowName}" hit its ${timeBucket(TREE_BUDGET_MS)} limit with ${nodes.length} controls read. `
        + 'The rest of that window is unchecked, not unchanged.',
    }));
  }
  return out;
}

/**
 * Programs the app started, as observations.
 *
 * The command line is kept and compared, because "it now launches its updater with a different
 * flag" is exactly the kind of change no screenshot has ever caught. Helper processes are
 * sorted by name so two runs that started the same helpers in a different order do not differ.
 *
 * @param {Journey} journey
 * @param {{pid: number, parent: number, command: string}[]} procs
 * @returns {Observation[]}
 */
export function spawnedObservations(journey, procs) {
  const named = procs
    .map((p) => ({ name: path.basename(p.command), command: p.command }))
    .sort((a, b) => (a.command < b.command ? -1 : a.command > b.command ? 1 : 0));
  /** @type {Observation[]} */
  const out = named.map((p, index) => observation({
    channel: 'effects',
    path: joinPath('proc', journey.name, `${p.name}#${index}`),
    value: p.command,
    says: `It started ${p.name}. That is a program running because this app ran.`,
    journey: journey.name,
    surface: 'macos',
  }));
  out.push(observation({
    channel: 'counters',
    path: joinPath('count', journey.name, 'programs started'),
    value: countBucket(named.length),
    says: `It started ${named.length} other program${named.length === 1 ? '' : 's'}.`,
    journey: journey.name,
    surface: 'macos',
  }));
  return out;
}

/**
 * What changed on disk in the folders this run was told to watch.
 *
 * By content, because this runs on the same machine and reading the file back costs nothing
 * next to running the whole product twice. That is a real improvement on the Windows adapter,
 * which compares sizes over a network connection and openly misses a file rewritten to the
 * same length.
 *
 * @param {Journey} journey
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 * @param {string} where   Plain name of the folder, for the sentence.
 * @returns {Observation[]}
 */
export function fileObservations(journey, before, after, where) {
  const changes = compareTrees(before, after);
  /** @type {Observation[]} */
  const out = changes
    .slice()
    .sort((a, b) => (a.file < b.file ? -1 : 1))
    .map((change) => observation({
      channel: 'effects',
      path: joinPath('file', journey.name, change.file),
      value: change.what === 'deleted' ? 'deleted' : `${change.what}, contents ${change.now}`,
      says: change.what === 'deleted'
        ? `It deleted ${change.file}.`
        : change.what === 'created'
          ? `It wrote ${change.file}.`
          : `It changed what is inside ${change.file}.`,
      journey: journey.name,
      surface: 'macos',
    }));
  out.push(observation({
    channel: 'counters',
    path: joinPath('count', journey.name, 'files touched'),
    value: countBucket(changes.length),
    says: `${changes.length} file${changes.length === 1 ? '' : 's'} changed under ${where}.`,
    journey: journey.name,
    surface: 'macos',
  }));
  return out;
}

/**
 * Crashes and log complaints, as observations.
 *
 * A crash report is kept down to its exception and its reason. The rest of a `.ips` file is
 * every thread, every frame and every loaded address, and those differ on every run of
 * identical code — comparing them would report a regression every single time.
 *
 * @param {Journey} journey
 * @param {{file: string, exception: string|null, reason: string|null}[]} crashes
 * @param {{kept: string[], dropped: number, ok: boolean, why: string}} logs
 * @returns {Observation[]}
 */
export function complaintObservations(journey, crashes, logs) {
  /** @type {Observation[]} */
  const out = crashes.map((crash, index) => observation({
    channel: 'complaints',
    path: joinPath('log', journey.name, 'crash', String(index)),
    value: `${crash.exception ?? 'it fell over'}: ${crash.reason ?? 'no reason given'}`,
    says: 'macOS filed a crash report for this app while the check was running.',
    evidence: crash.file,
    journey: journey.name,
    surface: 'macos',
  }));
  out.push(observation({
    channel: 'complaints',
    path: joinPath('log', journey.name, 'crashed'),
    value: crashes.length,
    says: crashes.length === 0
      ? 'macOS filed no crash report for this app while it ran.'
      : `macOS filed ${crashes.length} crash report${crashes.length === 1 ? '' : 's'} for this app.`,
    journey: journey.name,
    surface: 'macos',
  }));

  if (!logs.ok) {
    out.push(notCovered({
      channel: 'complaints',
      path: joinPath('log', journey.name, 'what it logged'),
      reason: 'missing tool',
      says: `What this app logged could not be read: ${logs.why}. Crashes are still reported; ordinary complaints are not.`,
    }));
    return out;
  }
  logs.kept.forEach((line, index) => {
    out.push(observation({
      channel: 'complaints',
      path: joinPath('log', journey.name, 'complaint', String(index)),
      value: line,
      says: `While it ran, it logged: ${line}`,
      journey: journey.name,
      surface: 'macos',
    }));
  });
  out.push(observation({
    channel: 'counters',
    path: joinPath('count', journey.name, 'complaints'),
    value: countBucket(logs.kept.length),
    says: logs.kept.length === 0
      ? 'It logged nothing at error level or worse while it ran.'
      : `It logged ${logs.kept.length} thing${logs.kept.length === 1 ? '' : 's'} at error level or worse.`,
    journey: journey.name,
    surface: 'macos',
  }));
  return out;
}

/**
 * Connections the app had open, plus the honest note about what sampling misses.
 * @param {Journey} journey
 * @param {string} lsofOutput
 * @returns {Observation[]}
 */
export function networkObservations(journey, lsofOutput) {
  /** @type {string[]} */
  const reachable = [];
  for (const line of lsofOutput.split('\n')) {
    // `lsof -nP -i` prints "local->remote" in its NAME column for anything connected.
    const m = /->([0-9a-fA-F.:[\]]+):(\d+)/.exec(line);
    if (!m) continue;
    if (m[1] === '127.0.0.1' || m[1] === '[::1]') continue;
    reachable.push(`${m[1]}:${m[2]}`);
  }
  const unique = [...new Set(reachable)].sort();
  /** @type {Observation[]} */
  const out = unique.map((where, index) => observation({
    channel: 'effects',
    path: joinPath('net', journey.name, String(index)),
    value: where,
    says: `While it was running it had a connection open to ${where}.`,
    journey: journey.name,
    surface: 'macos',
  }));
  out.push(notCovered({
    channel: 'effects',
    path: joinPath('net', journey.name, 'everything it asked for'),
    reason: 'missing tool',
    says: 'Connections were sampled while the app ran, not captured. A request that opened and finished between two '
      + 'samples was not seen, and nothing here could have stopped one. Capturing every call from a compiled Mac app '
      + 'needs root or an Apple entitlement.',
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Finding the app
// ---------------------------------------------------------------------------

/**
 * Where the Mac build is.
 *
 * A single `.app` folder, named in the config or found in the usual places a Mac build lands.
 * Nothing is guessed beyond those places: pointing this at the wrong bundle produces a run that
 * reads a different program and reports it as a pass.
 *
 * @param {AdapterProject} project
 * @returns {{app: string|null, why: string}}
 */
export function findMacApp(project) {
  const config = project.config ?? {};
  if (typeof config.app === 'string' && config.app.trim() !== '') {
    const app = path.isAbsolute(config.app) ? config.app : path.join(project.root, config.app);
    return { app, why: `The Mac app named in the config is at ${app}.` };
  }
  return { app: null, why: 'No Mac app was named, so there is nothing to open.' };
}

/**
 * Places a Mac build normally lands, in the order worth looking.
 *
 * Xcode's own default first, then the two folders every packaging tool writes into. Read by
 * `detect` so a project that has a build sitting there is told exactly what one line of config
 * would turn on, rather than being told "nothing found".
 */
export const WHERE_MAC_BUILDS_LAND = [
  'build/Build/Products/Release',
  'build/Release',
  '.build/release',
  'dist/mac',
  'dist/mac-arm64',
  'dist',
  'build',
];

/**
 * Look for a `.app` in the usual places, so `detect` can name a real path in its advice.
 * @param {string} root
 * @returns {Promise<string|null>}
 */
export async function lookForABundle(root) {
  for (const where of WHERE_MAC_BUILDS_LAND) {
    /** @type {string[]} */
    let names = [];
    try { names = await fsp.readdir(path.join(root, where)); } catch { continue; }
    const app = names.find((n) => n.endsWith('.app'));
    if (app) return path.join(root, where, app);
  }
  return null;
}

/**
 * Does this project look like it is written in Swift or Objective-C at all.
 *
 * Cheap and deliberately shallow: it reads the top of the tree, not all of it, because a
 * detection pass that walks a whole repository is a detection pass nobody waits for.
 *
 * @param {string[]} topLevelNames
 * @returns {boolean}
 */
export function looksLikeAMacProject(topLevelNames) {
  return topLevelNames.some((n) => n.endsWith('.xcodeproj') || n.endsWith('.xcworkspace') || n === 'Package.swift');
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Everything this run started, so teardown puts back exactly that and nothing else.
 *
 * Somebody's own copy of the same app may well be running. The rule the whole tool obeys is
 * never to kill what it did not start, and on a machine somebody is sitting at it is not an
 * abstraction.
 *
 * @type {Map<string, number[]>}
 */
const startedHere = new Map();

export const macosAdapter = defineAdapter({
  name: 'macos',
  title: 'native Mac apps',
  describe:
    'Opens a native Mac app in the background on this Mac, reads what every control on screen says it is and does '
    + 'through the Accessibility API, and watches what it starts, writes, prints and complains about. It needs '
    + 'Accessibility permission, which a person has to grant once by hand. It runs one build at a time, because a '
    + 'second copy of the same app makes the first stop answering. It declines Electron apps, which are covered '
    + 'better and in pairs over their debug port.',
  channels: ['meaning', 'effects', 'complaints', 'results', 'counters', 'pixels'],

  /**
   * @param {AdapterProject} project
   * @returns {Promise<Detection>}
   */
  async detect(project) {
    /** @type {Missing[]} */
    const missing = [];

    if (process.platform !== 'darwin') {
      return {
        applies: false,
        confidence: 0,
        why: 'A native Mac window can only be read from a Mac. This is not one, and there is no way to reach one '
          + 'over a network the way a Windows desktop can be reached over ssh — the Accessibility API only answers '
          + 'inside a signed-in graphical session on the machine itself.',
        missing: [],
        notes: ['If you have a Mac, run the check there. Nothing needs installing on it.'],
      };
    }

    const found = findMacApp(project);
    let appPath = found.app;
    if (!appPath) appPath = await lookForABundle(project.root);

    const hello = await askTheScreen({ op: 'hello' }, { limitMs: 20_000 });
    const allowed = hello.ok === true && hello.axTrusted === true;
    if (!allowed) {
      missing.push({
        what: 'permission to read another app\'s window',
        unlocks: 'everything on this surface — without it not one control can be read',
        howToGet: HOW_TO_ALLOW,
        blocking: true,
      });
    }

    if (!found.app) {
      missing.push({
        what: 'the built Mac app',
        unlocks: 'opening the app and reading what is on its screen',
        howToGet: appPath
          ? `There is one at ${path.relative(project.root, appPath)}. Put {"app": "${path.relative(project.root, appPath)}"} under "macos" in the config to use it.`
          : 'Put {"app": "build/Release/YourApp.app"} under "macos" in the config, pointing at the built .app folder.',
        blocking: true,
      });
    }

    const bundle = appPath ? await inspectBundle(appPath) : null;
    if (bundle?.electron) {
      return {
        applies: false,
        confidence: 0,
        why: 'This is an Electron app, so the Electron adapter covers its Mac build properly — over the debug port, '
          + 'from any machine, with two builds able to run side by side. This adapter would be strictly worse: one '
          + 'build at a time, and reading the window would switch on Chromium\'s accessibility engine and change the '
          + 'timing of the thing being measured.',
        missing: [],
        notes: ['Nothing is missing. There is simply a better tool for this app already in the box.'],
      };
    }

    if (!Array.isArray(project.config?.watchDirs) || project.config.watchDirs.length === 0) {
      missing.push({
        what: 'the folders this app writes into',
        unlocks: 'seeing what it saved, which is otherwise invisible — watching everything a Mac app writes needs '
          + 'root, which this does not have and will not ask for',
        howToGet: 'Put {"watchDirs": ["~/Library/Application Support/YourApp"]} under "macos" in the config.',
      });
    }

    const applies = allowed && Boolean(found.app) && bundle?.ok === true;
    return {
      applies,
      confidence: applies ? 0.9 : 0,
      why: applies
        ? `${found.why} It will be opened in the background on this Mac, read through the Accessibility API, and `
          + 'closed again — one build at a time.'
        : !allowed
          ? 'This Mac has not been told to let Stays Fixed read another app\'s window, so nothing on screen can be read yet.'
          : found.app
            ? `${bundle?.why ?? 'That is not a readable Mac app bundle.'}`
            : 'A native Mac app needs a built .app folder, and none is named yet.',
      missing,
      notes: [
        'Nothing is installed to do this. The program that reads the screen is JavaScript handed to macOS\'s own '
          + 'osascript on standard input, and it disappears when the run ends.',
        'The app is opened in the BACKGROUND and never brought to the front, so a check can run while somebody is '
          + 'working. An app that brings itself to the front will still do so, and that is reported.',
        'One build at a time, always. Two copies of the same app make the older one stop answering the '
          + 'Accessibility API entirely, which looks exactly like an app with no controls in it.',
        'Nothing irreversible can be stopped here. There is no way to refuse a compiled Mac app\'s network call '
          + 'without root, so a journey marked irreversible is refused outright instead of walked.',
      ],
    };
  },

  /**
   * @param {AdapterProject} project
   * @returns {Promise<Journey[]>}
   */
  async journeys(project) {
    const config = project.config ?? {};
    const found = findMacApp(project);
    if (!found.app) return [];

    /** @type {Journey[]} */
    const journeys = [{
      name: 'open-the-app',
      describe: 'open the Mac app in the background and read every control it puts on screen',
      source: 'code',
      surface: 'macos',
      from: 'the app bundle named in the config',
      channels: ['meaning', 'effects', 'complaints', 'results', 'counters', 'pixels'],
      steps: [{ act: 'launch' }, { act: 'settle' }, { act: 'read' }],
      timeoutMs: 180_000,
    }];

    // Anything beyond opening it has to be described by somebody who knows the app. Read out of
    // the config rather than invented here: an adapter that guesses which buttons to press on
    // an unknown Mac app is an adapter that will one day press "Delete account".
    for (const extra of Array.isArray(config.journeys) ? config.journeys : []) {
      if (!extra || typeof extra.name !== 'string') continue;
      journeys.push({
        name: extra.name,
        describe: typeof extra.describe === 'string' ? extra.describe : `walk "${extra.name}"`,
        source: 'recorded',
        surface: 'macos',
        from: 'the project config',
        channels: ['meaning', 'effects', 'complaints', 'results', 'counters', 'pixels'],
        steps: Array.isArray(extra.steps) ? extra.steps : [],
        irreversible: Boolean(extra.irreversible),
        timeoutMs: 180_000,
      });
    }
    return journeys;
  },

  /**
   * @param {Build} build
   * @param {RunContext} ctx
   * @returns {Promise<PreparedBuild>}
   */
  async prepare(build, ctx) {
    const config = ctx.config ?? {};
    const nothingReady = (/** @type {string} */ why) =>
      ({ build, root: build.root, ready: false, why, dispose: async () => {} });

    if (process.platform !== 'darwin') {
      return nothingReady('A native Mac app can only be opened on a Mac, and this is not one.');
    }
    const found = findMacApp({ root: build.root, config });
    if (!found.app) return nothingReady(found.why);

    const bundle = await inspectBundle(found.app);
    if (!bundle.ok || !bundle.executable) return nothingReady(bundle.why);
    if (bundle.electron) {
      return nothingReady('That is an Electron app. The Electron adapter drives it properly over its debug port, from '
        + 'any machine, with both builds up at once — this adapter would be strictly worse.');
    }

    const hello = await askTheScreen({ op: 'hello' }, { limitMs: 20_000 });
    if (hello.ok !== true || hello.axTrusted !== true) {
      return nothingReady(`This Mac has not been told to let Stays Fixed read another app's window. ${HOW_TO_ALLOW}`);
    }

    // Anything already running that IS this app is the measured problem: a second copy makes one
    // of them stop answering the accessibility layer entirely. Matched on the BUNDLE IDENTIFIER
    // rather than on the path to the program, and that distinction is the whole point — two
    // builds being compared live in two folders and run two different files, so nothing about
    // their paths says they are the same app. The first version of this check matched paths,
    // and a rival build sitting right next to the one under test walked straight past it.
    //
    // Only copies THIS run started are stopped. Somebody else's copy is reported and left alone,
    // because the rule the whole tool obeys is never to kill what it did not start, and on a
    // machine somebody is sitting at that is not an abstraction.
    const ours = new Set([...startedHere.values()].flat());
    const rivals = await otherCopiesOf(bundle.bundleId, bundle.executable, ours, ctx.log);

    return {
      build,
      root: build.root,
      ready: true,
      why: `${found.why} ${bundle.why}${rivals.length > 0 ? ` ${warnAboutRivals(bundle.name ?? path.basename(found.app, '.app'), rivals)}` : ''}`,
      facts: {
        app: found.app,
        executable: bundle.executable,
        name: bundle.name,
        bundleId: bundle.bundleId,
        rivals: rivals.length,
        macos: typeof hello.macos === 'string' ? hello.macos : undefined,
        screen: typeof hello.screen === 'string' ? hello.screen : undefined,
      },
      dispose: async () => {
        for (const pid of startedHere.get(build.id) ?? []) await stopOne(pid, ctx.log);
        startedHere.delete(build.id);
      },
    };
  },

  /**
   * @param {Journey} journey
   * @param {PreparedBuild} prepared
   * @param {RunContext} ctx
   * @returns {Promise<Observation[]>}
   */
  async run(journey, prepared, ctx) {
    const config = ctx.config ?? {};
    const appPath = String(prepared.facts?.app ?? '');
    const executable = String(prepared.facts?.executable ?? '');
    const appName = String(prepared.facts?.name ?? path.basename(appPath, '.app'));

    if (!prepared.ready || !executable) {
      return [notCovered({
        channel: 'meaning',
        path: joinPath('screen', journey.name, 'anything at all'),
        reason: 'missing tool',
        says: `"${journey.describe}" was not walked: ${prepared.why}`,
      })];
    }

    // Refused outright rather than walked carefully. There is no wire boundary on a compiled
    // Mac app without root, so "watch it ask and then stop it" is not available, and a careful
    // walk of an irreversible journey is a walk that really does the irreversible thing.
    if (journey.irreversible) {
      return [notCovered({
        channel: 'effects',
        path: joinPath('screen', journey.name, 'refused'),
        reason: 'irreversible',
        says: `"${journey.describe}" would spend money, send a message or destroy data, and on a Mac there is no way `
          + 'to let it ask and then stop it — that needs root, which this will not take. It was not run at all. This '
          + 'is a hole in what was checked, not a pass.',
      })];
    }

    /** @type {Observation[]} */
    const seen = [];
    /** @type {string[]} */
    const watchDirs = (Array.isArray(config.watchDirs) ? config.watchDirs : [])
      .map((d) => String(d).replace(/^~(?=$|\/)/, os.homedir()));
    const startedAt = Date.now();
    /** @type {number|null} */
    let pid = null;
    const outFile = path.join(ctx.scratchDir, `macos-${journey.name}-printed.txt`);
    const errFile = path.join(ctx.scratchDir, `macos-${journey.name}-complained.txt`);

    try {
      /** @type {Map<string, Map<string, string>>} */
      const before = new Map();
      for (const dir of watchDirs) before.set(dir, await snapshotTree(dir));

      const opened = await openInTheBackground({
        appPath,
        args: Array.isArray(config.args) ? config.args.map(String) : [],
        stdoutFile: outFile,
        stderrFile: errFile,
      });
      if (opened.code !== 0) {
        return [notCovered({
          channel: 'meaning',
          path: joinPath('screen', journey.name, 'anything at all'),
          reason: 'crashed',
          says: `The app would not open: ${(opened.stderr || opened.stdout).trim().slice(0, 300) || `open ended with ${opened.code}`}.`,
        })];
      }

      // `open` hands back as soon as LaunchServices has taken the request, so the process id has
      // to be looked up rather than returned. Matched on the FULL path to the program inside the
      // bundle, never on its name: two builds being compared have the same name and different
      // folders, and picking the wrong one reads the old build and calls it the new one.
      const deadline = Date.now() + WINDOW_WAIT_MS;
      while (Date.now() < deadline && pid === null) {
        const { byPath } = await processList();
        const running = pidsRunning(byPath, executable);
        if (running.length > 0) pid = running[running.length - 1];
        else await new Promise((r) => setTimeout(r, 300));
      }
      if (pid === null) {
        return [notCovered({
          channel: 'meaning',
          path: joinPath('screen', journey.name, 'anything at all'),
          reason: 'crashed',
          says: `The app was asked to open and never appeared in the list of running programs within `
            + `${timeBucket(WINDOW_WAIT_MS)}. Nothing about it was checked.`,
        })];
      }
      startedHere.set(prepared.build.id, [...(startedHere.get(prepared.build.id) ?? []), pid]);

      // Wait for a window rather than sleeping a fixed time. A machine under load takes longer,
      // and a fixed sleep would turn that into a difference in the report.
      /** @type {{title: string|null, index: number}[]} */
      let windows = [];
      /** @type {{id: number, title: string|null, w: number, h: number}[]} */
      let onScreen = [];
      const windowDeadline = Date.now() + WINDOW_WAIT_MS;
      while (Date.now() < windowDeadline) {
        const reply = await askTheScreen({ op: 'windows', pid }, { limitMs: 30_000 });
        if (reply.ok) {
          windows = Array.isArray(reply.windows) ? reply.windows : [];
          onScreen = Array.isArray(reply.onScreen) ? reply.onScreen : [];
          if (windows.length > 0 || onScreen.length > 0) break;
        }
        await new Promise((r) => setTimeout(r, 400));
      }

      if (Number(prepared.facts?.rivals ?? 0) > 0) {
        seen.push(notCovered({
          channel: 'meaning',
          path: joinPath('screen', journey.name, 'read on a clean machine'),
          reason: 'not supported here',
          says: `Another copy of ${appName} was running while this was checked. Two copies of one Mac app make one of `
            + 'them stop answering the Accessibility API, so anything read here may be a partial answer rather than '
            + 'the whole screen. It is reported as unchecked on purpose: a short tree that looks complete is the one '
            + 'thing this tool must never hand back.',
        }));
      }

      if (windows.length === 0 && onScreen.length === 0) {
        seen.push(notCovered({
          channel: 'meaning',
          path: joinPath('screen', journey.name, 'a window'),
          reason: 'timed out',
          says: `The app opened but put no window on screen within ${timeBucket(WINDOW_WAIT_MS)}. Nothing about its `
            + 'screen was checked. It may be a menu-bar-only program, or it may have failed quietly.',
        }));
      }

      for (const window of windows) {
        const label = window.title || `window ${window.index + 1}`;
        const tree = await askTheScreen({
          op: 'settle',
          pid,
          index: window.index,
          limit: MAX_TREE_NODES,
          budgetMs: TREE_BUDGET_MS,
          tries: SETTLE_TRIES,
          gapMs: SETTLE_GAP_MS,
        }, { limitMs: 120_000 });

        if (!tree.ok) {
          seen.push(notCovered({
            channel: 'meaning',
            path: joinPath('screen', journey.name, label, 'controls'),
            reason: 'crashed',
            says: `"${label}" could not be read: ${tree.error}.`,
          }));
          continue;
        }

        seen.push(...meaningFromTree({
          journey,
          window: label,
          nodes: Array.isArray(tree.nodes) ? tree.nodes : [],
          onScreenCount: Array.isArray(tree.onScreen) ? tree.onScreen.length : 0,
          childCount: Number(tree.childCount ?? -1),
          settled: Boolean(tree.agreed),
          truncated: Boolean(tree.truncated),
          ranOut: Boolean(tree.ranOut),
        }));
        seen.push(observation({
          channel: 'results',
          path: joinPath('screen', journey.name, label, 'title'),
          value: window.title,
          says: `A window is open called "${window.title}".`,
          journey: journey.name,
          surface: 'macos',
        }));
      }

      // The steps a project wrote down, walked in order. Only after the first read, so a journey
      // that presses something has a "before" in the reference to be different from.
      for (const step of journey.steps ?? []) {
        if (step.act === 'press' || step.act === 'set') {
          seen.push(...await walkOneStep(journey, step, pid, ctx));
        }
      }
      if ((journey.steps ?? []).some((s) => s.act === 'press' || s.act === 'set')) {
        for (const window of windows) {
          const label = window.title || `window ${window.index + 1}`;
          const after = await askTheScreen({
            op: 'settle', pid, index: window.index, limit: MAX_TREE_NODES,
            budgetMs: TREE_BUDGET_MS, tries: SETTLE_TRIES, gapMs: SETTLE_GAP_MS,
          }, { limitMs: 120_000 });
          if (!after.ok) continue;
          seen.push(...meaningFromTree({
            journey,
            window: `${label} after the steps`,
            nodes: Array.isArray(after.nodes) ? after.nodes : [],
            onScreenCount: Array.isArray(after.onScreen) ? after.onScreen.length : 0,
            childCount: Number(after.childCount ?? -1),
            settled: Boolean(after.agreed),
            truncated: Boolean(after.truncated),
            ranOut: Boolean(after.ranOut),
          }));
        }
      }

      // Pictures last, and only as evidence. A picture is written to the evidence folder and
      // pointed at; it is never the thing compared.
      seen.push(...await picturesOfWindows(journey, onScreen, ctx));

      // What it printed. A Mac app's output is block-buffered when it goes to a file rather
      // than a terminal, so an app that prints without flushing shows nothing here until it
      // exits — which is a property of the app, and is said rather than left as a silence.
      const printed = await readIfThere(outFile);
      const complained = await readIfThere(errFile);
      seen.push(observation({
        channel: 'results',
        path: joinPath('cli', journey.name, 'printed'),
        value: printed.trim(),
        says: printed.trim() === ''
          ? 'It printed nothing while the check was running. A Mac app that prints without flushing shows nothing '
            + 'here until it quits, so this is not proof that it printed nothing.'
          : `It printed: ${printed.trim().slice(0, 200)}`,
        journey: journey.name,
        surface: 'macos',
      }));
      if (complained.trim() !== '') {
        seen.push(observation({
          channel: 'complaints',
          path: joinPath('cli', journey.name, 'complained'),
          value: complained.trim(),
          says: `It complained: ${complained.trim().slice(0, 200)}`,
          journey: journey.name,
          surface: 'macos',
        }));
      }

      const { byParent } = await processList();
      seen.push(...spawnedObservations(journey, descendantsOf(byParent, [pid])));

      const conns = await runQuietly('/usr/sbin/lsof', ['-nP', '-i', '-a', '-p', String(pid)], {
        limitMs: 20_000, what: 'the connections this app had open',
      });
      seen.push(...networkObservations(journey, conns.stdout));

      for (const dir of watchDirs) {
        seen.push(...fileObservations(journey, before.get(dir) ?? new Map(), await snapshotTree(dir), dir));
      }
      if (watchDirs.length === 0) {
        seen.push(notCovered({
          channel: 'effects',
          path: joinPath('file', journey.name, 'anything written'),
          reason: 'needs a sample',
          says: 'Nothing was watched on disk, because no folders were named. Add "watchDirs" under "macos" in the '
            + 'config and what this app saves becomes visible.',
        }));
      } else {
        seen.push(notCovered({
          channel: 'effects',
          path: joinPath('file', journey.name, 'everywhere else'),
          reason: 'missing tool',
          says: 'Only the folders this check was told to watch were compared. Watching everything a Mac app writes '
            + 'needs root, which this will not take, so a file written anywhere else was not seen. That is a hole, '
            + 'not a clean result.',
        }));
      }

      const stillHere = isStillRunning(pid);
      seen.push(observation({
        channel: 'complaints',
        path: joinPath('proc', journey.name, 'still running'),
        value: stillHere,
        says: stillHere
          ? 'The app was still running when the check finished, which is what a window app should do.'
          : 'The app had already quit by the time the check finished. For a window app that usually means it fell over.',
        journey: journey.name,
        surface: 'macos',
      }));

      seen.push(...complaintObservations(
        journey,
        await crashesSince(appName, startedAt),
        await loggedBy(pid, startedAt),
      ));

      return seen;
    } catch (error) {
      // Something went wrong part way through. Keep everything really seen, and say plainly that
      // the rest is unchecked. Never let a short run look like a clean one.
      return [...seen, notCovered({
        channel: 'meaning',
        path: joinPath('screen', journey.name, 'the rest of it'),
        reason: 'crashed',
        says: `"${journey.describe}" stopped part way through: ${error instanceof Error ? error.message : String(error)}. `
          + 'Everything after that point is unchecked, not unchanged.',
      })];
    } finally {
      // Closed before the next build opens, because two copies of the same app make one of them
      // stop answering — which is the single worst failure this surface has.
      if (pid !== null) {
        await stopOne(pid, ctx.log);
        const left = (startedHere.get(prepared.build.id) ?? []).filter((p) => p !== pid);
        if (left.length > 0) startedHere.set(prepared.build.id, left);
        else startedHere.delete(prepared.build.id);
      }
    }
  },

  /**
   * Put the Mac back the way it was found.
   *
   * Only ever stops what this run started. Somebody's own copy of the same app may be open, and
   * on a machine somebody is sitting at that is not an abstraction.
   */
  async teardown() {
    for (const [id, pids] of startedHere) {
      for (const pid of pids) await stopOne(pid);
      startedHere.delete(id);
    }
  },
});

// ---------------------------------------------------------------------------
// The pieces `run` leans on
// ---------------------------------------------------------------------------

/**
 * Do one thing to the screen, and report what happened either way.
 *
 * Presses go through the accessibility layer's own press action, never a synthetic mouse
 * event. Measured on this machine: a synthetic click lands on the window and no handler fires,
 * while `AXPress` really runs the code — counter went up, output was logged, a file was
 * written. A step that pressed and silently did nothing would be the worst kind of pass.
 *
 * @param {Journey} journey
 * @param {import('../types.js').JourneyStep} step
 * @param {number} pid
 * @param {RunContext} ctx
 * @returns {Promise<Observation[]>}
 */
async function walkOneStep(journey, step, pid, ctx) {
  const control = String(step.control ?? '');
  if (control === '') {
    return [notCovered({
      channel: 'meaning',
      path: joinPath('screen', journey.name, 'a step with no control named'),
      reason: 'needs a sample',
      says: `A "${step.act}" step in "${journey.name}" does not say which control it means, so it was skipped. `
        + 'Name it by its accessibility identifier, its title or its description.',
    })];
  }
  const reply = step.act === 'press'
    ? await askTheScreen({ op: 'press', pid, control, action: step.action }, { limitMs: 45_000 })
    : await askTheScreen({ op: 'set', pid, control, value: String(step.value ?? '') }, { limitMs: 45_000 });

  if (!reply.ok) {
    return [notCovered({
      channel: 'meaning',
      path: joinPath('screen', journey.name, `${step.act} ${control}`),
      reason: 'crashed',
      says: `"${journey.name}" could not ${step.act} "${control}": ${reply.error}. Everything the app would have done `
        + 'afterwards is unchecked.',
    })];
  }
  ctx.log?.(`${step.act === 'press' ? 'Pressed' : 'Set'} "${control}".`);
  // A short settle after acting, because a Mac app updates its screen on the next turn of its
  // run loop and reading immediately reads the old state.
  await new Promise((r) => setTimeout(r, SETTLE_GAP_MS));
  return [observation({
    channel: 'effects',
    path: joinPath('screen', journey.name, `${step.act} ${control}`),
    value: step.act === 'press' ? 'accepted the press' : `accepted the value ${JSON.stringify(String(step.value ?? ''))}`,
    says: step.act === 'press'
      ? `"${control}" accepted being pressed.`
      : `"${control}" accepted being set to ${JSON.stringify(String(step.value ?? ''))}.`,
    journey: journey.name,
    surface: 'macos',
  })];
}

/**
 * Take and keep a picture of every window, and never let a failed picture be a silence.
 *
 * Three ways out of here and two of them would be silent if this were written the obvious way.
 * A picture that failed, came back black, or came back over the size this keeps would produce
 * no observation at all — so the pixels channel would drop out of the run without a word, and
 * the coverage ledger would report the same coverage as a run where every window really was
 * photographed. A cap is a decision and a decision has to be visible; a failure is a hole and a
 * hole has to be named.
 *
 * @param {Journey} journey
 * @param {{id: number, title: string|null, w: number, h: number}[]} onScreen
 * @param {RunContext} ctx
 * @returns {Promise<Observation[]>}
 */
async function picturesOfWindows(journey, onScreen, ctx) {
  /** @type {Observation[]} */
  const out = [];
  /** @type {string[]} */
  const files = [];
  /** @type {Map<string, string>} */
  const labelFor = new Map();

  for (const window of onScreen) {
    const label = window.title || `window ${window.id}`;
    const file = path.join(ctx.evidenceDir, `macos-${journey.name}-${label.replace(/[^a-z0-9]+/gi, '-')}.png`);
    const shot = await pictureOfWindow(window.id, file);
    if (!shot.ok) {
      out.push(notCovered({
        channel: 'pixels',
        path: joinPath('screen', journey.name, label, 'picture'),
        reason: 'crashed',
        says: `No picture of "${label}" could be taken: ${shot.why}. Every other channel still looked at that window; `
          + 'only the picture is missing.',
      }));
      continue;
    }
    if (shot.bytes > MAX_SHOT_BYTES) {
      out.push(notCovered({
        channel: 'pixels',
        path: joinPath('screen', journey.name, label, 'picture'),
        reason: 'too big',
        says: `The picture of "${label}" came back at ${sizeBucket(shot.bytes)}, over the ${sizeBucket(MAX_SHOT_BYTES)} `
          + 'this keeps, so it was not stored. Every other channel still looked at that window.',
      }));
      await fsp.rm(file, { force: true });
      continue;
    }
    files.push(file);
    labelFor.set(file, label);
    out.push(observation({
      channel: 'pixels',
      path: joinPath('screen', journey.name, label, 'looks like'),
      value: `${window.w} by ${window.h}`,
      says: `A picture of "${label}" was kept as evidence. It is not compared — it is there to show a person `
        + 'something another channel already found.',
      evidence: file,
      journey: journey.name,
      surface: 'macos',
    }));
  }

  if (files.length === 0) return out;
  // One call for all of them, because starting osascript costs about 130ms and a window's
  // brightness is not worth that each.
  const lit = await askTheScreen({ op: 'lit', files }, { limitMs: 45_000 });
  for (const file of files) {
    const count = Number(lit.lit?.[file] ?? -1);
    if (count === 0) {
      out.push(notCovered({
        channel: 'pixels',
        path: joinPath('screen', journey.name, labelFor.get(file) ?? file, 'picture is usable'),
        reason: 'not supported here',
        says: 'The picture came back completely black. On a Mac that means either the screen is locked or this '
          + 'program has not been given Screen Recording permission in System Settings, Privacy & Security. Every '
          + 'other channel still works; only the picture is lost.',
      }));
    }
  }
  return out;
}

/**
 * Other copies of this same app that are running and were not started by this run.
 *
 * Copies this run started are stopped here rather than reported, because leaving one up is what
 * breaks the next build's read. Everything else is handed back so the caller can say so.
 *
 * @param {string|undefined} bundleId
 * @param {string} executable
 * @param {Set<number>} ours
 * @param {(m: string) => void} [log]
 * @returns {Promise<{pid: number, path: string|null}[]>}
 */
async function otherCopiesOf(bundleId, executable, ours, log) {
  /** @type {{pid: number, path: string|null}[]} */
  const rivals = [];
  const reply = await askTheScreen({ op: 'running' }, { limitMs: 30_000 });
  /** @type {{pid: number, bundleId: string, path: string|null}[]} */
  const apps = reply.ok && Array.isArray(reply.apps) ? reply.apps : [];
  const sameApp = bundleId
    ? apps.filter((a) => a.bundleId === bundleId)
    // With no identifier to go on — a plist that did not name one — fall back to the path. It is
    // a weaker check and it is used only because the better one is unavailable.
    : (await processList().then(({ byPath }) => pidsRunning(byPath, executable))).map((pid) => ({ pid, path: null }));
  for (const app of sameApp) {
    if (ours.has(app.pid)) { await stopOne(app.pid, log); continue; }
    rivals.push({ pid: app.pid, path: 'path' in app ? app.path : null });
  }
  return rivals;
}

/**
 * The sentence about a rival copy, in one place so `prepare` and `run` say the same thing.
 * @param {string} appName
 * @param {{pid: number, path: string|null}[]} rivals
 * @returns {string}
 */
function warnAboutRivals(appName, rivals) {
  const where = rivals.map((r) => r.path ?? `process ${r.pid}`).join(', ');
  return `Another copy of ${appName} is already running (${where}) and it was left alone. Two copies of one Mac app `
    + 'make one of them stop answering the Accessibility API completely, which looks exactly like an app with no '
    + 'controls in it. Quit that copy before running this for a result you can trust.';
}

/** @param {string} file */
async function readIfThere(file) {
  try { return await fsp.readFile(file, 'utf8'); } catch { return ''; }
}

/** @param {number} pid */
function isStillRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * One paragraph about what this adapter can do on this machine, for `doctor` and for an agent
 * reading the tool's own description of itself.
 *
 * `allowed` is optional because on a machine that is not a Mac the question is never asked —
 * there is nothing to ask it of — and a signature that demanded an answer would force callers
 * to invent one.
 *
 * @param {{darwin: boolean, allowed?: boolean, macos?: string}} facts
 * @returns {string}
 */
export function describeMacos(facts) {
  if (!facts.darwin) {
    return 'A native Mac app can only be read from a Mac, and this is not one. There is no remote option here the '
      + 'way there is for Windows: the Accessibility API only answers inside a signed-in graphical session on the '
      + 'machine itself. If the Mac product is Electron — most desktop products are — it is already covered over its '
      + 'debug port from anywhere, and nothing is missing.';
  }
  if (!facts.allowed) {
    return `${facts.macos ?? 'This Mac'} can read a native Mac app's screen, but it has not been told to let Stays `
      + `Fixed do it. ${HOW_TO_ALLOW} That is the only manual step on this surface; nothing needs installing.`;
  }
  return `${facts.macos ?? 'This Mac'} can open a native Mac app in the background and read every control on its `
    + 'screen through the Accessibility API. Nothing is installed to do it. One build at a time, always: two copies '
    + 'of the same Mac app make one of them stop answering.';
}
