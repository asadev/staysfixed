/**
 * Native Linux desktop applications, driven over the machine somebody already has.
 *
 * This is the sibling of `windows.js`. Same problem — a window that can only be read from the
 * operating system it is running on — solved the same way, and costed the same way before a
 * line of it was written. Read the top of `linux-driver.js` for the measurements; this file is
 * about what they MEAN.
 *
 * ── WHAT WAS FOUND BEFORE ANY OF THIS WAS WRITTEN ──────────────────────────────────────────
 *
 * Checked against a real Ubuntu 24.04 machine on 2026-08-31, with NOTHING installed for the
 * purpose. Four measurements settled the design.
 *
 *   1. THE MACHINE ALREADY HAS EVERYTHING. `at-spi2-core` — the accessibility service every
 *      screen reader on Linux reads — and `gdbus` and `python3` and the `python3-dbus` module
 *      are on a stock desktop install. Nothing is copied to that machine and nothing is
 *      installed on it. The probe is Python, sent down the ssh connection at the start of a
 *      run, living only in the memory of the process running it.
 *   2. ONE PROGRAM DOES THE WHOLE WALK. In one Python process: 189 controls with their names,
 *      roles, states, actions and values in 562-707 ms across four runs; 260 controls of a
 *      bigger app in about the same. Doing the same walk by running `gdbus` once per property
 *      instead: 30 things in 1343 ms, which is not slower but unusable. For scale, the Windows
 *      adapter reads 148 controls in 303 ms — the two platforms cost about the same.
 *   3. THE SESSION IS FOUND, NOT ASSUMED. An ssh login has no screen, no session bus and no
 *      accessibility bus, because all three belong to the desktop the person logged in to. The
 *      probe reads them out of `/proc`, from a process that person's own session started.
 *      Proved on the demo box: with no configuration at all it found `DISPLAY=:99` and the
 *      session bus, and read the window.
 *   4. THE OBVIOUS FAST PATH IS A LIAR AND IS NOT USED. Every application on the bus offers
 *      `org.a11y.atspi.Collection.GetMatches`, which is supposed to hand back a whole subtree
 *      in one call. It returned ZERO objects, in ZERO milliseconds, in all five of its modes,
 *      while a plain walk of the same app found 189 controls. An adapter that trusted it would
 *      have written "this app has no controls" into the reference, and every run after that
 *      would have compared zero against zero and agreed nothing had changed. That is the exact
 *      failure this product exists to prevent, and it is why every read here is cross-checked.
 *
 * ── WHAT IT WATCHES ────────────────────────────────────────────────────────────────────────
 *
 *   meaning     The window tree from the accessibility bus: what each control IS (a button, a
 *               check box, a list), what it is CALLED, whether it is on, off, ticked, chosen,
 *               open or closed, what it is set to, and what it says it can DO. This is the
 *               channel that answers "what does the screen say this control now does", and it
 *               is the reason the platform is worth covering at all.
 *   effects     Programs it started, and files that changed in the folders it was told to
 *               watch, and the connections it had open while it ran.
 *   complaints  Everything it wrote to its error output, and whether it exited — including
 *               which signal killed it, which is how a crash is recognised here.
 *   results     What it printed, and the titles of the windows it opened.
 *   counters    How many windows, how many controls and how long things took, all in buckets.
 *   pixels      A picture of each window, as evidence for something another channel found.
 *
 * ── WHAT IT CANNOT DO, SAID PLAINLY ────────────────────────────────────────────────────────
 *
 * TWO BUILDS CANNOT RUN AT ONCE. Not "should not" — cannot. A desktop session has one screen
 * and one accessibility bus, and both builds would appear on it as two applications with the
 * same name, indistinguishable to anything reading the bus. So runs are strictly sequential,
 * and the same-machine guarantee is weaker here than anywhere else: that desktop is shared
 * with whatever else the person has open, and a notification or an update prompt appearing
 * mid-run is a real difference this cannot tell from a real one. Running twice subtracts some
 * of it. It does not subtract all of it.
 *
 * A MACHINE WITH NO DESKTOP SESSION HAS NO ACCESSIBILITY BUS AT ALL, and that is reported as
 * exactly that. A server, or a machine nobody has logged in to, is not a desktop with an empty
 * screen — there is nothing there to read. Reporting it as "no controls found" would put a
 * confident zero into the reference and every later run would agree with it. So this adapter
 * refuses to walk at all and says which of the two it is: no session, or a session with a
 * bus that would not answer.
 *
 * AN APP THAT DOES NOT PUBLISH AN ACCESSIBILITY TREE IS INVISIBLE HERE, AND THAT IS A HOLE.
 * Anything drawing its own widgets — a game, an Electron app with accessibility switched off,
 * some Qt builds, anything on a canvas — appears on the bus as a window with nothing in it, or
 * does not appear at all. The probe sets the four environment switches that turn the bridge on
 * for GTK and for Qt before it starts the app, which is what fixes most of them. When a window
 * still comes back empty it is recorded as UNCHECKED with that explanation, never as an app
 * with no controls.
 *
 * PIXELS NEED ONE PACKAGE AND EVERYTHING ELSE NEEDS NONE. A picture is taken through the
 * desktop's own toolkit, which needs `gir1.2-gtk-3.0` present. On the machine this was built
 * against it was missing, every other channel worked perfectly, and the pixels channel said so
 * and named the one-line install. Pictures are evidence for something another channel already
 * found; they are never the thing compared, so a machine without it loses nothing that decides
 * a release.
 *
 * ON WAYLAND THERE ARE NO PIXELS AT ALL, and the meaning channel does not care. The
 * accessibility bus is the same on Wayland and X11, so every control is read exactly as well.
 * Screen capture is not: Wayland refuses it to any program that has not gone through the
 * desktop's own permission dialogue, which nothing unattended can answer. The picture is
 * reported as missing with that reason.
 *
 * NOTHING IRREVERSIBLE IS WALKED. There is no way here to let a compiled program ask to reach
 * the internet and then refuse it — the CLI adapter can, because it loads a watcher inside a
 * Node child, and there is no equivalent for a GTK binary without root on somebody's desktop.
 * So a journey marked irreversible is REFUSED OUTRIGHT, reported as missing coverage, and
 * never run.
 *
 * MOST LINUX DESKTOP PRODUCTS DO NOT NEED THIS. If the Linux build is Electron — and most
 * desktop products are, including the one this tool was written alongside — it is already
 * covered from any machine over its debug port by the Electron adapter, in full, with two
 * builds able to run side by side. This adapter DECLINES an app whose toolkit says Chromium
 * and says where to go instead.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  countBucket, defineAdapter, joinPath, notCovered, observation, sizeBucket, timeBucket,
  trimForStorage,
} from './contract.js';
import { RemoteLinkLost, remoteRunner } from '../remote.js';
import { endOfChild, letGoOf } from './process.js';
import {
  COMPARED_STATES, MAX_SHOT_BYTES, MAX_TREE_NODES, askLinux, gdbusProbeCommand, readDesktopProbe,
} from './linux-driver.js';

/** @typedef {import('./contract.js').Build} Build */
/** @typedef {import('./contract.js').PreparedBuild} PreparedBuild */
/** @typedef {import('./contract.js').RunContext} RunContext */
/** @typedef {import('./contract.js').AdapterProject} AdapterProject */
/** @typedef {import('./contract.js').Detection} Detection */
/** @typedef {import('./contract.js').Missing} Missing */
/** @typedef {import('../types.js').Journey} Journey */
/** @typedef {import('../types.js').Observation} Observation */

/**
 * Toolkit names that mean "this is not really a native Linux app".
 *
 * Every application tells the accessibility bus what drew it, and an Electron or Chrome window
 * says Chromium. Seeing one is not a failure — it is this adapter finding out that a better
 * tool for the job is already in the box and saying so. It is also the exact Linux equivalent
 * of the Chromium window class the Windows adapter looks for, which is not a coincidence:
 * these two adapters are the same adapter twice.
 */
export const CHROMIUM_TOOLKITS = ['chromium', 'chrome', 'blink'];

/** How long to let an app get its first window onto the bus before calling it a no-show. */
const WINDOW_WAIT_MS = 20_000;

// ---------------------------------------------------------------------------
// Turning replies into observations
// ---------------------------------------------------------------------------

/**
 * @typedef {object} TreeNode
 * @property {string} role
 * @property {string} name
 * @property {string} [describe]
 * @property {string} [id]
 * @property {number} depth
 * @property {string[]} states
 * @property {string[]} can
 * @property {number|null} [value]
 * @property {string|null} [text]
 * @property {boolean} [secret]
 * @property {number} [kids]
 * @property {number} [claimed]
 * @property {string} [unreadable]
 */

/**
 * The address one control lives at.
 *
 * Built from what the control IS and what it is CALLED, never from where it sits in the tree.
 * A position would be stable right up until somebody adds a control above it, at which point
 * every control below it would report as changed and the one real difference would be buried
 * in the noise. GTK and Qt both leave most containers unnamed — 90 of the 189 controls read on
 * the demo box had no name at all — so an unnamed control falls back to its role and its depth
 * plus a number, which at least moves only when the shape of the tree really moves.
 *
 * @param {TreeNode} node
 * @param {number} index  Only used when a control has no identity of its own.
 * @returns {string}
 */
export function controlAddress(node, index) {
  const called = (node.id || node.name || '').trim();
  if (called !== '') return `${node.role}:${called}`;
  return `${node.role}@${node.depth}#${index}`;
}

/**
 * What one control says it is, in one line, and it is the only thing compared.
 *
 * Deliberately excludes where it is on screen. A window that opens two pixels lower is not a
 * difference anybody wants reported, and a control that MOVED without changing what it is or
 * does is a pixel finding, not a meaning one. What IS included is what would make somebody say
 * the product behaves differently: what it is, what it is called, whether it works, whether it
 * is ticked or chosen or open, what it is set to, and what it can be asked to do.
 *
 * The states are filtered through `COMPARED_STATES` — see the note beside that list for which
 * ones are left out and why.
 *
 * @param {TreeNode} node
 * @returns {string}
 */
export function controlMeaning(node) {
  if (node.unreadable) return `${node.role}, could not be read: ${node.unreadable}`;
  const parts = [node.role];
  if (node.name) parts.push(`called "${node.name}"`);
  const states = node.states.filter((s) => COMPARED_STATES.has(s));
  if (states.length > 0) parts.push(states.join(' '));
  if (node.value !== null && node.value !== undefined) parts.push(`set to ${node.value}`);
  // A password box is compared on its LENGTH, never its contents. The probe replaces the text
  // with a count before it leaves that machine, and this is the second half of the same
  // promise: somebody else's password must never end up in a reference stored in a git repo.
  if (node.text) parts.push(node.secret ? `holding ${node.text}` : `saying "${node.text}"`);
  if (node.can && node.can.length > 0) parts.push(`can ${node.can.join(', ')}`);
  return parts.join(', ');
}

/**
 * Turn one window's tree into observations, or into a hole if the read cannot be trusted.
 *
 * THE CROSS-CHECK IS THE IMPORTANT PART. `walked` is how many nodes the walk actually visited
 * and `shapeDisagreed` is how many of them said they had a different number of children from
 * the number they handed over. Those are two code paths inside the accessibility bridge
 * answering the same question, and when they disagree the tree is lying about its own shape.
 * Recording its answer anyway would put something wrong into the reference and every later run
 * would compare against it and agree.
 *
 * AND AN EMPTY TREE IS NEVER A PASS. A window that comes back with nothing in it is a window
 * that has not been checked — usually an app that draws its own widgets, or one whose toolkit
 * never switched its accessibility bridge on. Writing "no controls" would make the next run
 * compare zero against zero and call it unchanged, which is the one outcome this tool must
 * never produce.
 *
 * @param {object} spec
 * @param {Journey} spec.journey
 * @param {string} spec.window        Plain name of the window, for the path.
 * @param {TreeNode[]} spec.nodes
 * @param {number} spec.walked
 * @param {number} [spec.shapeDisagreed]
 * @param {number} [spec.unreadable]
 * @param {boolean} [spec.hitLimit]
 * @param {boolean} [spec.settled]    Did two reads in a row agree.
 * @param {string} [spec.toolkit]     What drew it, when the bus said.
 * @returns {Observation[]}
 */
export function meaningFromTree(spec) {
  const { journey, window: windowName, nodes } = spec;
  const head = ['screen', windowName];
  const disagreed = spec.shapeDisagreed ?? 0;

  if (nodes.length === 0) {
    return [notCovered({
      channel: 'meaning',
      path: joinPath(...head, 'controls'),
      reason: 'not supported here',
      says: `The window "${windowName}" reported no controls at all${spec.toolkit ? ` (it was drawn with ${spec.toolkit})` : ''}. `
        + 'Either it draws its own widgets and tells the accessibility bus nothing about them, or its toolkit '
        + 'never switched its accessibility bridge on. Either way this window is UNCHECKED, not empty — recording '
        + '"no controls" would make the next run compare nothing against nothing and agree that nothing changed.',
    })];
  }

  if (disagreed > 0) {
    return [notCovered({
      channel: 'meaning',
      path: joinPath(...head, 'controls'),
      reason: 'not supported here',
      says: `The window "${windowName}" contradicted itself: ${disagreed} of its ${nodes.length} controls said they `
        + 'had a different number of children from the number they then handed over. Two ways of asking the same '
        + 'question got two answers, so the tree cannot be trusted and nothing was recorded from it. This usually '
        + 'means the window was still being built while it was read.',
    })];
  }

  /** @type {Observation[]} */
  const out = [];
  /** @type {Map<string, number>} */
  const usedNames = new Map();
  nodes.forEach((node, index) => {
    let address = controlAddress(node, index);
    // Two controls can honestly share a name — two "Close" buttons in two panels. Number the
    // repeats rather than let the second quietly overwrite the first.
    const seen = usedNames.get(address) ?? 0;
    usedNames.set(address, seen + 1);
    if (seen > 0) address = `${address}~${seen + 1}`;
    out.push(observation({
      channel: 'meaning',
      path: joinPath(...head, address),
      value: controlMeaning(node),
      says: `On "${windowName}", ${controlMeaning(node)}.`,
      journey: journey.name,
      surface: 'linux',
    }));
  });

  out.push(observation({
    channel: 'counters',
    path: joinPath('count', windowName, 'controls'),
    value: countBucket(nodes.length),
    says: `"${windowName}" is showing ${nodes.length} control${nodes.length === 1 ? '' : 's'}.`,
    journey: journey.name,
    surface: 'linux',
  }));

  if ((spec.unreadable ?? 0) > 0) {
    out.push(notCovered({
      channel: 'meaning',
      path: joinPath(...head, 'some of it'),
      reason: 'not supported here',
      says: `${spec.unreadable} control${spec.unreadable === 1 ? '' : 's'} on "${windowName}" would not answer when `
        + 'asked what they were. They are in the report by position but their meaning is unchecked, which usually '
        + 'means they were removed from the window between being listed and being read.',
    }));
  }
  if (spec.settled === false) {
    out.push(notCovered({
      channel: 'meaning',
      path: joinPath(...head, 'settled'),
      reason: 'timed out',
      says: `"${windowName}" never held still: two readings in a row never matched. What was recorded is one `
        + 'snapshot of something still moving, so a difference found in it may be the movement rather than the change.',
    }));
  }
  if (spec.hitLimit) {
    out.push(notCovered({
      channel: 'meaning',
      path: joinPath(...head, 'all of it'),
      reason: 'too big',
      says: `"${windowName}" has more than ${MAX_TREE_NODES} controls, so only the first ${MAX_TREE_NODES} were `
        + 'recorded. Anything past that is unchecked.',
    }));
  }
  return out;
}

/**
 * What an exit code means in plain English, and whether it is a crash.
 *
 * A shell reports a program killed by a signal as 128 plus the signal number, and that is the
 * only way a crash is visible here: 139 is a segmentation fault, 134 is an abort, 136 is a
 * floating point error. 143 is the polite one — that is this tool itself asking the app to
 * close at the end of a walk, and it must never be reported as a crash.
 *
 * @param {string|null|undefined} code
 * @returns {{crashed: boolean, says: string, value: string}}
 */
export function exitMeaning(code) {
  if (code === null || code === undefined || code === '') {
    return { crashed: false, says: 'It was still running when the check finished, which is what a window app should do.', value: 'still running' };
  }
  const n = Number(code);
  if (!Number.isFinite(n)) return { crashed: false, says: `It ended, and the machine recorded "${code}".`, value: String(code) };
  if (n === 0) return { crashed: false, says: 'It closed on its own without an error.', value: 'closed cleanly' };
  if (n === 143) return { crashed: false, says: 'It closed when this check asked it to.', value: 'closed when asked' };
  if (n === 137) return { crashed: false, says: 'It had to be forced to close — it did not go when asked.', value: 'forced to close' };
  if (n > 128) {
    const names = { 131: 'quit', 134: 'abort', 136: 'a floating point error', 139: 'a segmentation fault', 141: 'a broken pipe' };
    const what = /** @type {Record<number, string>} */ (names)[n] ?? `signal ${n - 128}`;
    return { crashed: true, says: `It CRASHED: ${what} killed it.`, value: `crashed (${what})` };
  }
  return { crashed: true, says: `It exited with an error, code ${n}.`, value: `exited ${n}` };
}

/**
 * Programs the app started, as observations.
 *
 * Everything carrying this run's marker in its environment is something running because this
 * app ran. The command line is kept and compared, because "it now launches the updater with a
 * different flag" is exactly the kind of change no screenshot has ever caught.
 *
 * @param {Journey} journey
 * @param {{name: string, pid: number, ppid: number, cmd: string}[]} procs
 * @param {number} wrapperPid   The little shell this tool put around the app.
 * @param {number|null} appPid  The app itself.
 * @returns {Observation[]}
 */
export function spawnedObservations(journey, procs, wrapperPid, appPid) {
  // The wrapper is ours and the app is the thing under test. Neither is "a program it
  // started", and counting them would report the same two every run as if they were findings.
  const children = procs.filter((p) => p.pid !== wrapperPid && p.pid !== appPid);
  /** @type {Observation[]} */
  const out = children
    .map((p) => ({ name: p.name, cmd: p.cmd || '(no command line visible)' }))
    .sort((a, b) => (a.name + a.cmd < b.name + b.cmd ? -1 : 1))
    .map((p, index) => observation({
      channel: 'effects',
      path: joinPath('proc', journey.name, `${p.name}#${index}`),
      value: p.cmd,
      says: `It started ${p.name}. That is a program running because this app ran.`,
      journey: journey.name,
      surface: 'linux',
    }));
  out.push(observation({
    channel: 'counters',
    path: joinPath('count', journey.name, 'programs started'),
    value: countBucket(children.length),
    says: `It started ${children.length} other program${children.length === 1 ? '' : 's'}.`,
    journey: journey.name,
    surface: 'linux',
  }));
  return out;
}

/**
 * What changed on disk in the folders we were told to watch.
 *
 * Sizes rather than contents, because reading every file back over an ssh connection would
 * cost more than the whole rest of the run. A file that changed size changed; a file rewritten
 * with the same length is missed, and that is said out loud rather than hidden.
 *
 * @param {Journey} journey
 * @param {Record<string, Record<string, number>>} before
 * @param {Record<string, Record<string, number>>} after
 * @returns {Observation[]}
 */
export function fileObservations(journey, before, after) {
  /** @type {Observation[]} */
  const out = [];
  for (const dir of Object.keys(after).sort()) {
    const was = before[dir] ?? {};
    const now = after[dir] ?? {};
    const names = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort();
    let touched = 0;
    for (const name of names) {
      const oldSize = was[name];
      const newSize = now[name];
      if (oldSize === newSize) continue;
      touched++;
      out.push(observation({
        channel: 'effects',
        path: joinPath('file', journey.name, name),
        value: newSize === undefined
          ? 'deleted'
          : oldSize === undefined ? `written, ${sizeBucket(newSize)}` : `changed to ${sizeBucket(newSize)}`,
        says: newSize === undefined
          ? `It deleted ${name}.`
          : oldSize === undefined
            ? `It wrote ${name}, ${sizeBucket(newSize)}.`
            : `It changed ${name}; it is now ${sizeBucket(newSize)}.`,
        journey: journey.name,
        surface: 'linux',
      }));
    }
    out.push(observation({
      channel: 'counters',
      path: joinPath('count', journey.name, 'files touched'),
      value: countBucket(touched),
      says: `${touched} file${touched === 1 ? '' : 's'} changed under ${dir}.`,
      journey: journey.name,
      surface: 'linux',
    }));
  }
  out.push(notCovered({
    channel: 'effects',
    path: joinPath('file', journey.name, 'everywhere else'),
    reason: 'missing tool',
    says: 'Only the folders this check was told to watch were compared. Watching everything a program writes on '
      + 'Linux needs a kernel audit rule or a filesystem trace, and both need root on somebody\'s own desktop, '
      + 'so a file written anywhere else was not seen. That is a hole, not a clean result.',
  }));
  return out;
}

/**
 * Everything it wrote to its error output, and how it ended.
 *
 * A Linux desktop app does not have a Windows event log to complain into; it complains to its
 * own error output, which this tool captures because it started the app. That is more useful
 * than the system log and it needs no privileges to read.
 *
 * @param {Journey} journey
 * @param {object} spec
 * @param {string} spec.complained   What went to its error output.
 * @param {boolean} [spec.cut]       Was that truncated.
 * @param {string|null} [spec.exit]  Exit code, when it has ended.
 * @returns {Observation[]}
 */
export function complaintObservations(journey, spec) {
  const text = (spec.complained ?? '').trim();
  const lines = text === '' ? [] : text.split('\n');
  const ending = exitMeaning(spec.exit);
  /** @type {Observation[]} */
  const out = [];

  out.push(observation({
    channel: 'complaints',
    path: joinPath('log', journey.name, 'complained'),
    value: trimForStorage(text, 16 * 1024).text,
    says: lines.length === 0
      ? 'It complained about nothing while it ran.'
      : `It wrote ${lines.length} line${lines.length === 1 ? '' : 's'} to its error output while it ran.`,
    journey: journey.name,
    surface: 'linux',
  }));
  out.push(observation({
    channel: 'counters',
    path: joinPath('count', journey.name, 'complaints'),
    value: countBucket(lines.length),
    says: `It complained ${lines.length} time${lines.length === 1 ? '' : 's'}.`,
    journey: journey.name,
    surface: 'linux',
  }));
  out.push(observation({
    channel: 'complaints',
    path: joinPath('proc', journey.name, 'how it ended'),
    value: ending.value,
    says: ending.says,
    journey: journey.name,
    surface: 'linux',
  }));
  if (spec.cut) {
    out.push(notCovered({
      channel: 'complaints',
      path: joinPath('log', journey.name, 'the rest of it'),
      reason: 'too big',
      says: 'It complained more than was kept, so only the first part is compared. A message that only appears '
        + 'further down was not looked at.',
    }));
  }
  out.push(notCovered({
    channel: 'complaints',
    path: joinPath('log', journey.name, 'core dumps'),
    reason: 'missing tool',
    says: 'A crash is recognised here by the signal that killed the program, which is reliable. The core dump '
      + 'file itself is not collected: where Linux puts one is a machine-wide setting this check is not allowed '
      + 'to read on somebody else\'s desktop.',
  }));
  return out;
}

/**
 * What it printed, as observations.
 *
 * @param {Journey} journey
 * @param {string} printed
 * @param {boolean} [cut]
 * @returns {Observation[]}
 */
export function printedObservations(journey, printed, cut = false) {
  /** @type {Observation[]} */
  const out = [observation({
    channel: 'results',
    path: joinPath('printed', journey.name),
    value: trimForStorage(printed ?? '', 16 * 1024).text,
    says: (printed ?? '').trim() === ''
      ? 'It printed nothing, which is normal for a window app.'
      : 'This is what it printed while it was open.',
    journey: journey.name,
    surface: 'linux',
  })];
  if (cut) {
    out.push(notCovered({
      channel: 'results',
      path: joinPath('printed', journey.name, 'the rest of it'),
      reason: 'too big',
      says: 'It printed more than was kept, so only the first part is compared.',
    }));
  }
  return out;
}

/**
 * Connections the app had open, plus the honest note about what sampling misses.
 *
 * @param {Journey} journey
 * @param {{remote: string, state: string}[]} conns
 * @returns {Observation[]}
 */
export function networkObservations(journey, conns) {
  const reachable = conns
    .map((c) => c.remote)
    .filter((where) => !where.startsWith('0.0.0.0:') && !where.startsWith('127.0.0.1:') && !where.startsWith('[00000000'))
    .sort();
  const unique = [...new Set(reachable)];
  /** @type {Observation[]} */
  const out = unique.map((where, index) => observation({
    channel: 'effects',
    path: joinPath('net', journey.name, String(index)),
    value: where,
    says: `While it was running it had a connection open to ${where}.`,
    journey: journey.name,
    surface: 'linux',
  }));
  out.push(notCovered({
    channel: 'effects',
    path: joinPath('net', journey.name, 'everything it asked for'),
    reason: 'missing tool',
    says: 'Connections were sampled while the app ran, not captured. A request that opened and finished between '
      + 'two samples was not seen, and nothing here could have stopped one — refusing a compiled program\'s '
      + 'network call needs root on that desktop, which this does not have and should not want.',
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Finding the app
// ---------------------------------------------------------------------------

/**
 * Where the Linux build is, and whether it is already on the far machine.
 *
 * Two honest modes, and which one a project is in changes what a run costs by minutes:
 *
 *   `there`  The config names a path that already exists on the Linux machine. Free.
 *   `push`   The build is here and has to be copied over. Real, and reported with the time it
 *            took, because a person who does not know that a run copies 200 megabytes over ssh
 *            every time will reasonably conclude the tool is broken when it takes four minutes.
 *
 * @param {AdapterProject} project
 * @returns {{mode: 'there'|'push'|'none', exe: string|null, local: string|null, why: string}}
 */
export function findLinuxBuild(project) {
  const config = project.config ?? {};
  if (typeof config.remoteExe === 'string' && config.remoteExe.trim() !== '') {
    return {
      mode: 'there',
      exe: config.remoteExe,
      local: null,
      why: `The Linux build is already on that machine at ${config.remoteExe}, so nothing is copied.`,
    };
  }
  if (typeof config.exe === 'string' && config.exe.trim() !== '') {
    const local = path.isAbsolute(config.exe) ? config.exe : path.join(project.root, config.exe);
    return {
      mode: 'push',
      exe: null,
      local,
      why: `The Linux build is here at ${local} and has to be copied to the Linux machine before each run.`,
    };
  }
  return {
    mode: 'none',
    exe: null,
    local: null,
    why: 'No Linux build was named, so there is nothing to open.',
  };
}

/**
 * Is this really a native app, or a Chromium shell wearing a Linux window frame.
 * @param {string} toolkit  What the accessibility bus said drew it.
 * @returns {boolean}
 */
export function isChromiumToolkit(toolkit) {
  return CHROMIUM_TOOLKITS.includes(String(toolkit ?? '').trim().toLowerCase());
}

/**
 * Copy a build over to the far machine, and say how long it took.
 *
 * Streamed through tar rather than scp so it is one connection and one pass, and so a folder
 * of thousands of small files does not become thousands of round trips at a second each. This
 * is the same shape as the Windows adapter's copy and for the same reasons; both are here
 * rather than shared because the two land the build in different places and only one of them
 * has to worry about a UNC path.
 *
 * @param {string} host
 * @param {string} localDir
 * @param {string} remoteDir
 * @returns {Promise<{ok: boolean, ms: number, why: string}>}
 */
export async function pushBuild(host, localDir, remoteDir) {
  const started = Date.now();
  const tar = spawn('tar', ['-cf', '-', '-C', path.dirname(localDir), path.basename(localDir)]);
  const ssh = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host,
    `mkdir -p '${remoteDir}' && tar -xf - -C '${remoteDir}'`]);
  let trouble = '';
  tar.stdout.pipe(ssh.stdin);
  ssh.stderr.on('data', (d) => { trouble += String(d); });
  tar.stderr.on('data', (d) => { trouble += String(d); });
  // Nothing wants what ssh prints on its way through, and that is exactly why it has to be
  // read. A pipe nobody empties fills up, and a full pipe blocks its writer for ever.
  ssh.stdout?.resume();
  ssh.on('error', () => { try { tar.kill('SIGKILL'); } catch { /* already gone */ } });
  tar.on('error', () => { try { ssh.kill('SIGKILL'); } catch { /* already gone */ } });

  const ended = await endOfChild(ssh, { limitMs: 30 * 60_000, what: `the copy of this build to ${host}` });
  try { tar.kill('SIGKILL'); } catch { /* it finished on its own */ }
  letGoOf(tar);

  const ms = Date.now() - started;
  if (ended.gaveUp) return { ok: false, ms, why: `${ended.why} ${trouble.trim().slice(0, 200)}`.trim() };
  if (ended.code === 0) return { ok: true, ms, why: `Copied to ${host} in ${timeBucket(ms)}.` };
  return { ok: false, ms, why: `Copying to ${host} failed: ${trouble.trim().slice(0, 300) || `the copy ended with ${ended.code ?? ended.signal}`}` };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** The one connection this adapter holds while a run is going on. */
let link = /** @type {import('../remote.js').RemoteRunner|null} */ (null);

/** Everything this run started over there, so teardown can put it back and nothing else. */
/** @type {{pid: number, run: string, exitFile: string}[]} */
let startedHere = [];

/**
 * Open the Linux machine, once, and keep it.
 * @param {string} host
 * @param {(m: string) => void} [log]
 */
async function connect(host, log) {
  if (link && link.alive) return link;
  link = remoteRunner({ host, kind: 'posix', surface: 'linux', log });
  await link.open();
  return link;
}

/**
 * What the probe should be told about the desktop, out of the project's config.
 * @param {Record<string, any>} config
 * @returns {{env?: Record<string, string>, envFile?: string}}
 */
function sessionFrom(config) {
  /** @type {{env?: Record<string, string>, envFile?: string}} */
  const out = {};
  /** @type {Record<string, string>} */
  const env = {};
  if (typeof config.display === 'string') env.DISPLAY = config.display;
  if (typeof config.sessionBus === 'string') env.DBUS_SESSION_BUS_ADDRESS = config.sessionBus;
  if (Object.keys(env).length > 0) out.env = env;
  if (typeof config.envFile === 'string') out.envFile = config.envFile;
  return out;
}

export const linuxAdapter = defineAdapter({
  name: 'linux',
  title: 'native Linux desktop apps',
  describe:
    'Opens a native Linux program on a real desktop reached over ssh, reads what every control on screen says it '
    + 'is and does through the accessibility bus every screen reader already uses, and watches what it starts, '
    + 'writes, prints and complains about. It cannot run two builds at once — a desktop has one screen — and it '
    + 'declines Electron apps, which are covered better and in pairs over their debug port.',
  channels: ['meaning', 'effects', 'complaints', 'results', 'counters', 'pixels'],

  /**
   * @param {AdapterProject} project
   * @returns {Promise<Detection>}
   */
  async detect(project) {
    const config = project.config ?? {};
    const host = typeof config.host === 'string' ? config.host : null;
    const build = findLinuxBuild(project);
    /** @type {Missing[]} */
    const missing = [];

    if (!host) {
      missing.push({
        what: 'the name of a machine with a Linux desktop session on it',
        unlocks: 'checking a native Linux app at all — a Linux window can only be read from the desktop it is on',
        howToGet: 'Put {"host": "the-ssh-host-name"} under "linux" in the config. Any ssh host that gets you a shell '
          + 'on a Linux machine where somebody is logged in to a desktop works. Nothing needs installing on it.',
        blocking: true,
      });
    }
    if (build.mode === 'none') {
      missing.push({
        what: 'the built Linux program',
        unlocks: 'opening the app and reading what is on its screen',
        howToGet: 'Either put {"remoteExe": "/opt/yourapp/yourapp"} under "linux" in the config if the build already '
          + 'lives on that machine — much faster — or {"exe": "dist/linux/yourapp"} to have it copied over before '
          + 'each run.',
        blocking: true,
      });
    }
    if (!Array.isArray(config.watchDirs) || config.watchDirs.length === 0) {
      missing.push({
        what: 'the folders this app writes into',
        unlocks: 'seeing what it saved, which is otherwise invisible — watching the whole disk needs root on that '
          + 'desktop, which this does not have and should not want',
        howToGet: 'Put {"watchDirs": ["/home/you/.config/yourapp"]} under "linux" in the config.',
      });
    }

    let electronish = false;
    try {
      const pkg = JSON.parse(await fsp.readFile(path.join(project.root, 'package.json'), 'utf8'));
      electronish = Boolean(pkg.dependencies?.electron || pkg.devDependencies?.electron || pkg.build?.appId);
    } catch { /* a built app somebody pointed at need not have a package.json */ }

    if (electronish) {
      return {
        applies: false,
        confidence: 0,
        why: 'This is an Electron app, so the Electron adapter covers its Linux build properly — over the debug '
          + 'port, from any machine, with two builds able to run side by side. This adapter would be strictly '
          + 'worse: one build at a time, on one shared desktop, and switching on Chromium\'s accessibility engine '
          + 'to read the window would change the timing of the very thing being measured.',
        missing: [],
        notes: ['Nothing is missing. There is simply a better tool for this app already in the box.'],
      };
    }

    const applies = Boolean(host) && build.mode !== 'none';
    return {
      applies,
      confidence: applies ? 0.9 : 0,
      why: applies
        ? `${build.why} It will be opened on the desktop behind "${host}", read through the accessibility bus, and `
          + 'closed again — one build at a time, because a desktop has one screen and two cannot be up at once.'
        : 'A native Linux app needs a machine with a desktop session and a built program, and one of those is not '
          + 'named yet.',
      missing,
      notes: [
        'Nothing is installed on the Linux machine. The program that reads the screen is sent down the ssh '
          + 'connection each run and disappears when it closes.',
        'The screen, the session bus and the accessibility bus are found by reading them out of the desktop session '
          + 'already running there, so no configuration is needed on a machine somebody is logged in to.',
        'Two builds can never run at the same time here. That is a property of a desktop, not of this tool, and it '
          + 'makes the same-machine comparison weaker on this platform than on any other.',
        'A machine with nobody logged in to a desktop has no accessibility bus at all. That is reported as nothing '
          + 'to read, never as an app with no controls.',
        'Nothing irreversible can be stopped here, so a journey marked irreversible is refused outright rather than '
          + 'walked carefully.',
      ],
    };
  },

  /**
   * @param {AdapterProject} project
   * @returns {Promise<Journey[]>}
   */
  async journeys(project) {
    const config = project.config ?? {};
    const build = findLinuxBuild(project);
    if (build.mode === 'none') return [];

    /** @type {Journey[]} */
    const journeys = [{
      name: 'open-the-app',
      describe: 'open the Linux app and read every control it puts on screen',
      source: 'code',
      surface: 'linux',
      from: 'the built program named in the config',
      channels: ['meaning', 'effects', 'complaints', 'results', 'counters', 'pixels'],
      steps: [{ act: 'launch' }, { act: 'settle' }, { act: 'read' }],
      timeoutMs: 120_000,
    }];

    // Anything else has to be described by somebody who knows the app. Read out of the config
    // rather than invented here: an adapter that guesses which buttons to press on an unknown
    // native program is an adapter that will one day press "Delete account".
    for (const extra of Array.isArray(config.journeys) ? config.journeys : []) {
      if (!extra || typeof extra.name !== 'string') continue;
      journeys.push({
        name: extra.name,
        describe: typeof extra.describe === 'string' ? extra.describe : `walk "${extra.name}"`,
        source: 'recorded',
        surface: 'linux',
        from: 'the project config',
        channels: ['meaning', 'effects', 'complaints', 'results', 'counters', 'pixels'],
        steps: Array.isArray(extra.steps) ? extra.steps : [],
        irreversible: Boolean(extra.irreversible),
        timeoutMs: 120_000,
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
    const host = typeof config.host === 'string' ? config.host : null;
    if (!host) {
      return { build, root: build.root, ready: false, why: 'No Linux machine is named in the config, so there is nowhere to open this.', dispose: async () => {} };
    }
    const where = findLinuxBuild({ root: build.root, config });
    if (where.mode === 'none') {
      return { build, root: build.root, ready: false, why: where.why, dispose: async () => {} };
    }

    let runner;
    try {
      runner = await connect(host, ctx.log);
    } catch (error) {
      return {
        build,
        root: build.root,
        ready: false,
        why: error instanceof RemoteLinkLost
          ? `${error.message}. Nothing was checked on Linux.`
          : `Could not reach ${host}: ${String(error)}`,
        dispose: async () => {},
      };
    }

    // Ask the machine what it has before anything is copied to it. A machine with no desktop
    // session has no accessibility bus, and finding that out after a four-minute copy is a
    // waste of somebody's afternoon.
    let hello;
    try {
      hello = await askLinux(runner, 'hello', sessionFrom(config), { timeoutMs: 45_000 });
    } catch (error) {
      return {
        build,
        root: build.root,
        ready: false,
        why: `${host} answered, but nothing there could tell us about its desktop: `
          + `${error instanceof Error ? error.message : String(error)}.`,
        dispose: async () => {},
      };
    }

    if (hello.screenFound === false) {
      return {
        build,
        root: build.root,
        ready: false,
        why: `${host} has a user session on it but no screen, so there is no desktop there to open anything on. `
          + 'That is not the same as an app with nothing on its screen, and it must never be reported as one: a '
          + 'machine like this still answers when asked for an accessibility bus, and starts an empty one to do it. '
          + 'Log in to a desktop on that machine and leave the session running, or name a machine that has one.',
        dispose: async () => {},
      };
    }
    if (!hello.session?.DBUS_SESSION_BUS_ADDRESS) {
      return {
        build,
        root: build.root,
        ready: false,
        why: `There is no desktop session on ${host}. A Linux window can only be read from a desktop somebody is `
          + 'logged in to, and this machine has none — so there is nothing here to check, which is different from '
          + 'an app with nothing on its screen. Log in on that machine once and leave the session running, or name '
          + 'a machine that has one.',
        dispose: async () => {},
      };
    }
    if (hello.dbusModule === false) {
      return {
        build,
        root: build.root,
        ready: false,
        why: `${host} has a desktop, but the small Python module this reads the screen with is not installed there. `
          + 'One line fixes it, on that machine: sudo apt-get install -y python3-dbus (or the equivalent for that '
          + 'distribution). Nothing else is needed.',
        dispose: async () => {},
      };
    }
    if (!hello.bus) {
      return {
        build,
        root: build.root,
        ready: false,
        why: `${host} has a desktop session but its accessibility bus would not answer: ${hello.why ?? 'no reason given'}. `
          + 'On most desktops it starts on its own the first time something asks for it; on a few it has to be '
          + 'switched on once, with: gsettings set org.gnome.desktop.interface toolkit-accessibility true',
        dispose: async () => {},
      };
    }

    let exe = where.exe;
    /** @type {string[]} */
    const notes = [];
    if (where.mode === 'push' && where.local) {
      const remoteDir = `/tmp/staysfixed-${build.id}`;
      const pushed = await pushBuild(host, path.dirname(where.local), remoteDir);
      if (!pushed.ok) {
        return { build, root: build.root, ready: false, why: pushed.why, dispose: async () => {} };
      }
      notes.push(pushed.why);
      exe = path.posix.join(remoteDir, path.basename(path.dirname(where.local)), path.basename(where.local));
      notes.push('Starting a program from a copied folder is slower than one already on that machine. Naming '
        + '"remoteExe" instead, once, removes this from every run.');
    }

    return {
      build,
      root: build.root,
      ready: Boolean(exe),
      why: exe ? `${where.why} ${notes.join(' ')}`.trim() : 'The Linux program could not be placed on that machine.',
      facts: {
        exe: exe ?? undefined,
        host,
        desktop: typeof hello.screen === 'string' ? hello.screen : undefined,
        wayland: Boolean(hello.wayland),
        distro: typeof hello.distro === 'string' ? hello.distro : undefined,
      },
      dispose: async () => { /* nothing was installed, so there is nothing to undo */ },
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
    const exe = String(prepared.facts?.exe ?? '');
    const host = String(prepared.facts?.host ?? '');
    const session = sessionFrom(config);

    if (!prepared.ready || !exe) {
      return [notCovered({
        channel: 'meaning',
        path: joinPath('screen', journey.name, 'anything at all'),
        reason: 'missing tool',
        says: `"${journey.describe}" was not walked: ${prepared.why}`,
      })];
    }

    // Refused outright rather than walked carefully. There is no wire boundary here without
    // root on somebody's own desktop, so "watch it ask and stop it" is not available, and a
    // careful walk of an irreversible journey is a walk that really does the irreversible thing.
    if (journey.irreversible) {
      return [notCovered({
        channel: 'effects',
        path: joinPath('screen', journey.name, 'refused'),
        reason: 'irreversible',
        says: `"${journey.describe}" would spend money, send a message or destroy data, and on a Linux desktop there `
          + 'is no way to let it ask and then stop it — that needs root on a machine somebody else is using. It was '
          + 'not run at all. This is a hole in what was checked, not a pass.',
      })];
    }

    let runner;
    try {
      runner = await connect(host, ctx.log);
    } catch (error) {
      return [notCovered({
        channel: 'meaning',
        path: joinPath('screen', journey.name, 'anything at all'),
        reason: 'timed out',
        says: `"${journey.describe}" was not walked: ${error instanceof Error ? error.message : String(error)}.`,
      })];
    }

    /** @type {Observation[]} */
    const seen = [];
    /** @type {string[]} */
    const watchDirs = Array.isArray(config.watchDirs) ? config.watchDirs.map(String) : [];
    // One marker per journey per build, so two runs of the same product on the same desktop
    // can never claim each other's processes.
    const runId = `${prepared.build.id}-${journey.name}`.replace(/[^a-z0-9-]+/gi, '-').slice(0, 60);
    /** @type {Record<string, any>|null} */
    let launched = null;

    try {
      const before = watchDirs.length > 0
        ? await askLinux(runner, 'snap', { ...session, dirs: watchDirs }, { timeoutMs: 90_000 })
        : { dirs: {} };

      launched = await askLinux(runner, 'launch', {
        ...session,
        run: runId,
        exe,
        args: Array.isArray(config.args) ? config.args : [],
        cwd: typeof config.cwd === 'string' ? config.cwd : undefined,
        extraEnv: typeof config.env === 'object' && config.env ? config.env : undefined,
      }, { timeoutMs: 60_000 });
      if (!launched.ok) {
        return [notCovered({
          channel: 'meaning',
          path: joinPath('screen', journey.name, 'anything at all'),
          reason: 'crashed',
          says: `The app would not start on ${host}: ${launched.error}.`,
        })];
      }
      startedHere.push({ pid: Number(launched.pid), run: runId, exitFile: String(launched.exitFile) });

      // Wait for a window rather than sleeping a fixed time. A machine under load takes longer,
      // and a fixed sleep would turn that into a difference in the report.
      /** @type {{bus: string, path: string, role: string, name: string, app: string, toolkit: string, pid: number, box: {x: number, y: number, w: number, h: number}|null, showing: boolean}[]} */
      let windows = [];
      const deadline = Date.now() + WINDOW_WAIT_MS;
      while (Date.now() < deadline) {
        const reply = await askLinux(runner, 'windows', session, { timeoutMs: 45_000 });
        const rows = Array.isArray(reply.windows) ? reply.windows : [];
        // Only the windows belonging to what this run started. Somebody else's editor is open
        // on that desktop and it is not part of this product.
        const ours = await askLinux(runner, 'after', {
          ...session, run: runId, pid: launched.pid, exitFile: launched.exitFile,
        }, { timeoutMs: 45_000 });
        const mine = new Set((ours.procs ?? []).map((/** @type {any} */ p) => Number(p.pid)));
        windows = rows.filter((/** @type {any} */ w) => mine.has(Number(w.pid)) && w.showing);
        if (windows.length > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      if (windows.length === 0) {
        seen.push(notCovered({
          channel: 'meaning',
          path: joinPath('screen', journey.name, 'a window'),
          reason: 'timed out',
          says: `The app started on ${host} but put no window on the accessibility bus within `
            + `${timeBucket(WINDOW_WAIT_MS)}. Nothing about its screen was checked. Either it is a background `
            + 'program, or it failed silently, or it draws its own widgets and tells the desktop nothing about '
            + 'them — and this cannot tell those apart, so all three are unchecked rather than empty.',
        }));
      }

      const chromium = windows.filter((w) => isChromiumToolkit(w.toolkit));
      if (chromium.length > 0 && chromium.length === windows.length) {
        seen.push(notCovered({
          channel: 'meaning',
          path: joinPath('screen', journey.name, 'controls'),
          reason: 'not supported here',
          says: 'Every window this app opened says it was drawn by Chromium, so it is an Electron app after all. It '
            + 'is not read here: the Electron adapter covers it properly over its debug port, from any machine, '
            + 'with two builds able to run at once.',
        }));
      } else {
        for (const window of windows.filter((w) => !isChromiumToolkit(w.toolkit))) {
          const label = window.name || `${window.app} ${window.role}` || 'a window with no title';
          const tree = await askLinux(runner, 'settle', {
            ...session, bus: window.bus, path: window.path, limit: MAX_TREE_NODES,
          }, { timeoutMs: 120_000 });
          if (!tree.ok) {
            seen.push(notCovered({
              channel: 'meaning',
              path: joinPath('screen', label, 'controls'),
              reason: 'crashed',
              says: `"${label}" could not be read: ${tree.error}.`,
            }));
            continue;
          }
          seen.push(...meaningFromTree({
            journey,
            window: label,
            nodes: Array.isArray(tree.nodes) ? tree.nodes : [],
            walked: Number(tree.walked ?? 0),
            shapeDisagreed: Number(tree.shapeDisagreed ?? 0),
            unreadable: Number(tree.unreadable ?? 0),
            hitLimit: Boolean(tree.hitLimit),
            settled: Boolean(tree.agreed),
            toolkit: window.toolkit,
          }));
          seen.push(observation({
            channel: 'results',
            path: joinPath('screen', label, 'title'),
            value: window.name,
            says: window.name
              ? `A window is open called "${window.name}".`
              : `A ${window.role} is open with no title on it.`,
            journey: journey.name,
            surface: 'linux',
          }));

          // Pixels last, and only as evidence. A picture is written to the evidence folder and
          // pointed at; it is never the thing compared. Three ways out of here and all three
          // say something: a cap is a decision and has to be visible, a failure is a hole and
          // has to be named, and neither is a reason to lose the rest of the walk.
          const shot = await askLinux(runner, 'shot', { ...session, box: window.box ?? {} }, { timeoutMs: 60_000 });
          const bytes = shot.png ? Math.floor(String(shot.png).length * 0.75) : 0;
          const tooBig = shot.ok === true && bytes > MAX_SHOT_BYTES;
          if (!shot.ok || !shot.png || tooBig) {
            seen.push(notCovered({
              channel: 'pixels',
              path: joinPath('screen', label, 'picture'),
              reason: tooBig ? 'too big' : 'missing tool',
              says: tooBig
                ? `The picture of "${label}" came back at ${sizeBucket(bytes)}, over the ${sizeBucket(MAX_SHOT_BYTES)} this keeps, so it was not stored. Every other channel still looked at that window; only the picture is missing.`
                : `No picture of "${label}" could be taken: ${shot.why ?? 'the desktop would not say why'}. `
                  + `${prepared.facts?.wayland ? 'This desktop is Wayland, which refuses screen capture to anything that has not gone through its own permission dialogue, and nothing unattended can answer one. ' : 'One line on that machine fixes it: sudo apt-get install -y gir1.2-gtk-3.0. '}`
                  + 'Every other channel still looked at that window; only the picture is missing, and a picture is '
                  + 'evidence for a finding rather than a finding of its own.',
            }));
          } else {
            const file = path.join(ctx.evidenceDir, `linux-${journey.name}-${label.replace(/[^a-z0-9]+/gi, '-')}.png`);
            await fsp.writeFile(file, Buffer.from(String(shot.png), 'base64'));
            seen.push(observation({
              channel: 'pixels',
              path: joinPath('screen', label, 'looks like'),
              value: `${shot.w} by ${shot.h}`,
              says: `A picture of "${label}" was kept as evidence. It is not compared — it is there to show a person `
                + 'something another channel already found.',
              evidence: file,
              journey: journey.name,
              surface: 'linux',
            }));
            if (Number(shot.lit) === 0) {
              seen.push(notCovered({
                channel: 'pixels',
                path: joinPath('screen', label, 'picture is usable'),
                reason: 'not supported here',
                says: 'The picture came back completely black, which is what a locked or blanked screen gives. '
                  + 'Every other channel still works; only the picture is lost.',
              }));
            }
          }
        }
      }

      seen.push(observation({
        channel: 'counters',
        path: joinPath('count', journey.name, 'windows'),
        value: countBucket(windows.length),
        says: `It put ${windows.length} window${windows.length === 1 ? '' : 's'} on screen.`,
        journey: journey.name,
        surface: 'linux',
      }));

      const after = await askLinux(runner, 'after', {
        ...session, run: runId, pid: launched.pid, exitFile: launched.exitFile, dirs: watchDirs,
      }, { timeoutMs: 90_000 });

      seen.push(...spawnedObservations(
        journey,
        Array.isArray(after.procs) ? after.procs : [],
        Number(launched.pid),
        after.appPid === null || after.appPid === undefined ? null : Number(after.appPid),
      ));
      seen.push(...networkObservations(journey, Array.isArray(after.conns) ? after.conns : []));
      seen.push(...printedObservations(journey, String(after.printed ?? ''), Boolean(after.printedCut)));
      seen.push(...complaintObservations(journey, {
        complained: String(after.complained ?? ''),
        cut: Boolean(after.complainedCut),
        exit: after.running ? null : (after.exit ?? null),
      }));

      if (watchDirs.length > 0) {
        seen.push(...fileObservations(journey, before.dirs ?? {}, after.dirs ?? {}));
      } else {
        seen.push(notCovered({
          channel: 'effects',
          path: joinPath('file', journey.name, 'anything written'),
          reason: 'needs a sample',
          says: 'Nothing was watched on disk, because no folders were named. Add "watchDirs" under "linux" in the '
            + 'config and what this app saves becomes visible.',
        }));
      }

      return seen;
    } catch (error) {
      // The machine went away part way through. Keep everything really seen, and say plainly
      // that the rest is unchecked. Never let a short run look like a clean one.
      return [...seen, notCovered({
        channel: 'meaning',
        path: joinPath('screen', journey.name, 'the rest of it'),
        reason: 'timed out',
        says: `"${journey.describe}" stopped part way through on ${host}: `
          + `${error instanceof Error ? error.message : String(error)}. Everything after that point is unchecked, `
          + 'not unchanged.',
      })];
    } finally {
      if (launched?.ok && link && link.alive) {
        const pid = Number(launched.pid);
        try {
          await askLinux(link, 'stop', { ...session, run: runId, pid, exitFile: launched.exitFile }, { timeoutMs: 30_000 });
        } catch { /* the link is gone; teardown says so */ }
        startedHere = startedHere.filter((p) => p.pid !== pid);
      }
    }
  },

  /**
   * Put the machine back the way it was found.
   *
   * Only ever stops what this run started. The probe refuses any process that does not carry
   * this run's marker in its own environment, and that refusal is the last line of defence for
   * somebody's real work sitting on that desktop.
   */
  async teardown() {
    if (link) {
      for (const started of startedHere.slice()) {
        try {
          await askLinux(link, 'stop', { run: started.run, pid: started.pid, exitFile: started.exitFile }, { timeoutMs: 15_000 });
        } catch { /* going away anyway */ }
      }
      startedHere = [];
      try { await link.close(); } catch { /* already closed */ }
      link = null;
    }
  },
});

/**
 * One paragraph about what this adapter can do on a given machine, for `doctor` and for an
 * agent reading the tool's own description of itself.
 *
 * `desktop` is what `readDesktopProbe` made of the cheap `gdbus` probe — the one that needs
 * nothing installed. Passing it is optional so doctor can say something useful about a machine
 * before it has paid for the deeper look.
 *
 * @param {import('../remote.js').RemoteDescription} remote
 * @param {import('./linux-driver.js').DesktopProbe} [desktop]
 * @returns {string}
 */
export function describeLinuxDesktop(remote, desktop) {
  if (!remote.reachable) {
    return `Nothing answers through "${remote.host}", so a native Linux app cannot be checked from here. If the `
      + 'Linux product is Electron — most desktop products are — it is already covered over its debug port and '
      + 'nothing is missing.';
  }
  if (remote.windows) {
    return `"${remote.host}" is a Windows machine, not a Linux desktop. A native Linux window can only be read from `
      + 'the desktop it is running on.';
  }
  if (!desktop) {
    return `"${remote.host}" answers over ssh. Whether it has a desktop session on it — which is what publishes the `
      + 'accessibility bus a native Linux app is read through — has not been looked at yet.';
  }
  if (!desktop.hasBus) {
    return `"${remote.host}" answers, but there is no desktop session on it. ${desktop.why} A Linux window can only `
      + 'be read from a desktop somebody is logged in to; logging in there once and leaving the session running is '
      + 'what turns this on. Locking the screen afterwards is fine — every control still reads correctly, only the '
      + 'pictures come back black.';
  }
  return `${desktop.why} Nothing has to be installed on it: the program that reads the screen is sent down the ssh `
    + 'connection each run and disappears when it closes. One build at a time, always — a desktop has one screen '
    + 'and two cannot be up at once.';
}

/**
 * The cheap "is there a desktop here" probe, run over a connection somebody already has.
 *
 * Needs only `gdbus`, which every desktop Linux has, so it answers on a machine that is
 * missing the Python module the full read needs. Detect, never ask.
 *
 * @param {import('../remote.js').RemoteRunner} runner
 * @param {{display?: string, sessionBus?: string}} [env]
 * @returns {Promise<import('./linux-driver.js').DesktopProbe>}
 */
export async function probeDesktop(runner, env = {}) {
  const result = await runner.shell(gdbusProbeCommand(env), { timeoutMs: 30_000 });
  return readDesktopProbe(result.stdout, result.stderr);
}

export default linuxAdapter;
