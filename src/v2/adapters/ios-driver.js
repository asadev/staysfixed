/**
 * Driving an iPhone app in the simulator, and reading what it means.
 *
 * This file knows about simulators and nothing about Stays Fixed. It finds a device, makes
 * the device boring enough to be compared twice, installs a build into it, walks the steps
 * it is given, and hands back five plain things: the meaning tree, the calls the app made,
 * what it complained about, the files it wrote and a picture. `ios.js` turns those into
 * observations. The split is the same one `web.js` and `web-driver.js` use, for the same
 * reason: the hard problems here are all timing problems, and they are easier to fix when
 * they live in one file.
 *
 * FIVE DECISIONS WORTH KNOWING ABOUT.
 *
 * 1. NO WEBDRIVERAGENT, AND THAT WAS NOT THE PLAN. The usual way to read an iPhone screen
 *    is Appium's WebDriverAgent and its `/source?format=json`. It is not on this machine,
 *    it needs its own Xcode build every time Xcode moves, and it has historically lagged a
 *    new Xcode by months — Xcode 26.6 here is new. So the app is asked directly instead. A
 *    small observer library is put beside the app in a SCRATCH COPY of the bundle and loaded
 *    into it at launch, exactly the way `src/freeze/` is injected into a page before the
 *    browser fetches a byte. From inside the process it can read the real accessibility
 *    tree — the same tree VoiceOver reads — with no server, no port, no signing, no Xcode
 *    project and no second toolchain. It is about 250 lines of Objective-C and it builds in
 *    under two seconds.
 *
 * 2. THE TREE ONLY EXISTS ONCE SOMEBODY ASKS FOR IT. iOS does not build the accessibility
 *    tree until an assistive client turns up; a plain walk of the views finds nothing but
 *    anonymous wrappers. Measured here: 39 view nodes, every one of them with no name, no
 *    identifier and no accessibility children. Calling `_AXSApplicationAccessibilitySetEnabled`
 *    and `_AXSSetAutomationEnabled` inside the app is what makes the tree appear — the same
 *    39 nodes then carry names, roles and identifiers. Without that call this whole channel
 *    silently reads empty, which is the worst failure this tool could have, so the probe
 *    turns it on at load AND again before every read.
 *
 * 3. MEANING, NEVER COORDINATES. What is read is role, name, identifier, value and state.
 *    What is TAPPED is an accessibility identifier or a name, activated the way a screen
 *    reader activates it — `accessibilityActivate`. Nothing in this file ever touches a
 *    pixel position. An app whose buttons moved has not changed, and a tap that depends on
 *    where a button was is a test that breaks for a living.
 *
 * 4. THE PAYMENT IS WATCHED, NOT MADE. Every `URLSessionTask.resume` goes through the
 *    probe. Anything that would not come back — a POST or DELETE to a path that says charge,
 *    pay, refund, transfer, message, delete — is written down with its method, host, path
 *    and body size, and then cancelled before the socket opens. It is reported as a hole in
 *    the coverage, never as a pass. Proven here: `GET /price` went out, `POST /charge` did
 *    not.
 *
 * 5. NEVER THE DEVICE SOMEBODY ELSE IS USING. This file creates its own device, remembers
 *    that it created it, and shuts down only what it booted. A machine can easily have a
 *    simulator booted for something else — this one did, all through the work that produced
 *    this file — and shutting it down would take somebody's session with it.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

/** @typedef {import('../types.js').ObservedValue} JsonValue */

// ---------------------------------------------------------------------------
// Running simctl without letting it take the whole run down with it
// ---------------------------------------------------------------------------

/**
 * `xcrun simctl` has hung on a Mac before — not returned, not failed, just stopped — and a
 * lane that waits forever on it is worse than one that cannot drive iOS at all. So every
 * call is given a deadline, and when `xcrun` misses it the same command is tried again
 * against CoreSimulator's own binary, which `xcrun` is only a lookup wrapper around. If both
 * miss the deadline the answer is "this machine cannot be driven", in those words, and the
 * run carries on without iOS instead of stopping.
 *
 * @typedef {object} Ran
 * @property {boolean} ok
 * @property {number} code            -1 when it never finished.
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} hung           True when the deadline was missed by both routes.
 * @property {string} why             Plain English, always filled in.
 * @property {number} ms
 */

/** Where CoreSimulator's own simctl lives, when `xcrun` will not answer. */
let directSimctl = /** @type {string|null} */ (null);

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{timeoutMs?: number, signal?: AbortSignal, env?: Record<string,string>}} [opts]
 * @returns {Promise<{code: number, stdout: string, stderr: string, timedOut: boolean}>}
 */
function runOnce(file, args, opts = {}) {
  return new Promise((resolve) => {
    let timedOut = false;
    const child = execFile(
      file,
      args,
      {
        timeout: opts.timeoutMs ?? 60_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024 * 1024,
        signal: opts.signal,
        env: { ...process.env, ...opts.env },
      },
      (error, stdout, stderr) => {
        const err = /** @type {any} */ (error);
        if (err && (err.killed || err.signal === 'SIGKILL')) timedOut = true;
        resolve({
          code: err?.code === undefined ? (error ? 1 : 0) : Number(err.code),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? (error ? error.message : '')),
          timedOut,
        });
      },
    );
    child.on('error', () => {});
  });
}

/**
 * Run one simctl command, with the hang guard.
 *
 * @param {string[]} args
 * @param {{timeoutMs?: number, signal?: AbortSignal, env?: Record<string,string>}} [opts]
 * @returns {Promise<Ran>}
 */
export async function simctl(args, opts = {}) {
  const started = Date.now();
  const deadline = opts.timeoutMs ?? 60_000;
  let ran = await runOnce('xcrun', ['simctl', ...args], { ...opts, timeoutMs: deadline });

  if (ran.timedOut) {
    if (!directSimctl) {
      const found = await runOnce('xcode-select', ['-p'], { timeoutMs: 10_000 });
      const developer = found.stdout.trim();
      if (developer) directSimctl = path.join(developer, 'usr', 'bin', 'simctl');
    }
    if (directSimctl) {
      ran = await runOnce(directSimctl, args, { ...opts, timeoutMs: deadline });
    }
  }

  const ms = Date.now() - started;
  if (ran.timedOut) {
    return {
      ok: false,
      code: -1,
      stdout: ran.stdout,
      stderr: ran.stderr,
      hung: true,
      ms,
      why: `The simulator tool stopped answering while it was asked to ${args[0]}. It was given ${Math.round(deadline / 1000)} seconds through xcrun and then the same again through CoreSimulator's own copy, and neither came back.`,
    };
  }
  return {
    ok: ran.code === 0,
    code: ran.code,
    stdout: ran.stdout,
    stderr: ran.stderr,
    hung: false,
    ms,
    why: ran.code === 0 ? `simctl ${args[0]} finished` : `simctl ${args[0]} failed: ${firstLine(ran.stderr) || `it exited ${ran.code}`}`,
  };
}

/**
 * @param {string} text
 * @returns {string}
 */
function firstLine(text) {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
}

// ---------------------------------------------------------------------------
// What this machine has
// ---------------------------------------------------------------------------

/**
 * What is installed, and what a person would have to do about it.
 *
 * @typedef {object} MachineState
 * @property {boolean} ok             An app can be driven here right now.
 * @property {boolean} isMac          Simulators exist on macOS and nowhere else.
 * @property {string|null} xcode      'Xcode 26.6' or null.
 * @property {string|null} developerDir
 * @property {string|null} sdk        The iPhone simulator SDK version, e.g. '26.5'.
 * @property {Runtime[]} runtimes
 * @property {SimDevice[]} devices
 * @property {boolean} simctlAnswers
 * @property {boolean} clangWorks     The probe cannot be built without it.
 * @property {string} why             Plain English, always filled in.
 * @property {string[]} notes
 */

/**
 * @typedef {object} Runtime
 * @property {string} id              'com.apple.CoreSimulator.SimRuntime.iOS-26-5'
 * @property {string} name            'iOS 26.5'
 * @property {string} version         '26.5'
 */

/**
 * @typedef {object} SimDevice
 * @property {string} udid
 * @property {string} name
 * @property {string} runtimeId
 * @property {string} runtimeName
 * @property {string} state           'Booted' | 'Shutdown' | ...
 * @property {boolean} available
 */

/**
 * Ask the machine what it has. Everything here is read, nothing is started.
 *
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<MachineState>}
 */
export async function readMachine(opts = {}) {
  /** @type {string[]} */
  const notes = [];
  const isMac = process.platform === 'darwin';
  if (!isMac) {
    return {
      ok: false, isMac: false, xcode: null, developerDir: null, sdk: null,
      runtimes: [], devices: [], simctlAnswers: false, clangWorks: false,
      why: 'iPhone apps can only be run on a Mac. There is no simulator on this operating system, and there is no honest way to fake one.',
      notes,
    };
  }

  const version = await runOnce('xcodebuild', ['-version'], { timeoutMs: 20_000, signal: opts.signal });
  const xcode = version.code === 0 ? firstLine(version.stdout) : null;
  const dev = await runOnce('xcode-select', ['-p'], { timeoutMs: 10_000, signal: opts.signal });
  const developerDir = dev.code === 0 ? dev.stdout.trim() : null;
  const sdkVersion = await runOnce('xcrun', ['-sdk', 'iphonesimulator', '--show-sdk-version'], { timeoutMs: 20_000, signal: opts.signal });
  const sdk = sdkVersion.code === 0 ? sdkVersion.stdout.trim() : null;

  const listed = await simctl(['list', '-j', 'devices', 'available'], { timeoutMs: 45_000, signal: opts.signal });
  const runtimeList = await simctl(['list', '-j', 'runtimes'], { timeoutMs: 45_000, signal: opts.signal });
  if (listed.hung || runtimeList.hung) notes.push(listed.why || runtimeList.why);

  /** @type {Runtime[]} */
  const runtimes = [];
  try {
    const parsed = JSON.parse(runtimeList.stdout || '{}');
    for (const r of parsed.runtimes ?? []) {
      if (!r.isAvailable) continue;
      if (!String(r.identifier ?? '').includes('SimRuntime.iOS')) continue;
      runtimes.push({ id: String(r.identifier), name: String(r.name ?? r.identifier), version: String(r.version ?? '') });
    }
  } catch {
    // A machine with no runtimes answers with something that is not JSON. That is a 'no',
    // not a crash, and the caller finds out from `ok`.
  }

  /** @type {SimDevice[]} */
  const devices = [];
  try {
    const parsed = JSON.parse(listed.stdout || '{}');
    for (const [runtimeId, list] of Object.entries(parsed.devices ?? {})) {
      if (!runtimeId.includes('SimRuntime.iOS')) continue;
      const runtime = runtimes.find((r) => r.id === runtimeId);
      for (const d of /** @type {any[]} */ (list)) {
        devices.push({
          udid: String(d.udid),
          name: String(d.name),
          runtimeId,
          runtimeName: runtime?.name ?? runtimeId.split('.').pop() ?? runtimeId,
          state: String(d.state ?? 'Unknown'),
          available: d.isAvailable !== false,
        });
      }
    }
  } catch {
    // Same as above.
  }

  const clang = await runOnce('xcrun', ['-sdk', 'iphonesimulator', '--find', 'clang'], { timeoutMs: 20_000, signal: opts.signal });
  const clangWorks = clang.code === 0 && clang.stdout.trim().length > 0;
  const simctlAnswers = !listed.hung && !runtimeList.hung;

  const ok = Boolean(xcode) && runtimes.length > 0 && simctlAnswers && clangWorks;
  const why = !xcode
    ? 'Xcode is not installed, so there is no simulator to run anything in.'
    : !simctlAnswers
      ? 'Xcode is installed but the simulator tool did not answer, through xcrun or directly. Nothing can be driven until it does.'
      : runtimes.length === 0
        ? `${xcode} is installed but it has no iOS runtime, so there is no version of iOS to run an app on.`
        : !clangWorks
          ? `${xcode} is installed with ${runtimes.length} iOS runtime${runtimes.length === 1 ? '' : 's'}, but the compiler for the simulator could not be found, and the small observer that reads the screen has to be built with it.`
          : `${xcode}, ${runtimes.length} iOS runtime${runtimes.length === 1 ? '' : 's'} (${runtimes.map((r) => r.version).join(', ')}), ${devices.length} device${devices.length === 1 ? '' : 's'} already made.`;

  const booted = devices.filter((d) => d.state === 'Booted');
  if (booted.length > 0) {
    notes.push(`${booted.length} simulator${booted.length === 1 ? ' is' : 's are'} already running (${booted.map((d) => d.name).join(', ')}). They were not started here and they will not be touched — a device of our own is made instead.`);
  }

  return { ok, isMac, xcode, developerDir, sdk, runtimes, devices, simctlAnswers, clangWorks, why, notes };
}

// ---------------------------------------------------------------------------
// A device of our own
// ---------------------------------------------------------------------------

/**
 * A device this file is allowed to touch.
 *
 * @typedef {object} OurDevice
 * @property {string} udid
 * @property {string} name
 * @property {string} runtimeName
 * @property {boolean} weMadeIt       True when this run created it, so this run may delete it.
 * @property {boolean} weBootedIt     True when this run booted it, so this run may shut it down.
 * @property {string} why
 */

/**
 * Find or make the device this run will use, and never adopt one that is already booted.
 *
 * A simulator somebody else started is somebody else's: it may hold a session, a paired
 * host, a half-finished review. So a device is looked for BY NAME among the shut-down ones,
 * made if it is not there, and its state before we touched it is remembered so teardown can
 * put it back exactly.
 *
 * @param {object} opts
 * @param {string} [opts.name]          Defaults to a name nothing else uses.
 * @param {string} [opts.deviceType]    A simctl device type id, or a plain name like 'iPhone 16'.
 * @param {string} [opts.runtime]       A runtime id, or a version like '26.5'. Newest by default.
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok: boolean, device: OurDevice|null, why: string}>}
 */
export async function ensureDevice(opts = {}) {
  const wanted = opts.name ?? 'staysfixed-ios';
  const machine = await readMachine({ signal: opts.signal });
  if (!machine.ok) return { ok: false, device: null, why: machine.why };

  const existing = machine.devices.find((d) => d.name === wanted && d.available);
  if (existing) {
    if (existing.state === 'Booted') {
      return {
        ok: true,
        device: { udid: existing.udid, name: existing.name, runtimeName: existing.runtimeName, weMadeIt: false, weBootedIt: false, why: 'This device was already running when we arrived, so it will be used as it is and left running afterwards.' },
        why: `Using the device called ${wanted}, which was already booted.`,
      };
    }
    const booted = await bootDevice(existing.udid, { signal: opts.signal });
    if (!booted.ok) return { ok: false, device: null, why: booted.why };
    return {
      ok: true,
      device: { udid: existing.udid, name: existing.name, runtimeName: existing.runtimeName, weMadeIt: false, weBootedIt: true, why: booted.why },
      why: `Booted the device called ${wanted}, which was already made.`,
    };
  }

  const runtime = pickRuntime(machine.runtimes, opts.runtime);
  if (!runtime) {
    return { ok: false, device: null, why: `No iOS runtime here matches "${opts.runtime}". This machine has ${machine.runtimes.map((r) => r.version).join(', ') || 'none'}.` };
  }
  const typeId = await pickDeviceType(opts.deviceType, { signal: opts.signal });
  if (!typeId.ok) return { ok: false, device: null, why: typeId.why };

  const made = await simctl(['create', wanted, typeId.id, runtime.id], { timeoutMs: 120_000, signal: opts.signal });
  if (!made.ok) return { ok: false, device: null, why: `A simulator called ${wanted} could not be made: ${firstLine(made.stderr) || made.why}` };
  const udid = made.stdout.trim();

  const booted = await bootDevice(udid, { signal: opts.signal });
  if (!booted.ok) return { ok: false, device: null, why: booted.why };
  return {
    ok: true,
    device: { udid, name: wanted, runtimeName: runtime.name, weMadeIt: true, weBootedIt: true, why: booted.why },
    why: `Made a new ${typeId.label} on ${runtime.name} called ${wanted}, and booted it.`,
  };
}

/**
 * @param {Runtime[]} runtimes
 * @param {string} [wanted]
 * @returns {Runtime|null}
 */
function pickRuntime(runtimes, wanted) {
  if (runtimes.length === 0) return null;
  if (wanted) {
    const exact = runtimes.find((r) => r.id === wanted || r.version === wanted || r.name === wanted);
    if (exact) return exact;
    const prefix = runtimes.find((r) => r.version.startsWith(wanted));
    if (prefix) return prefix;
    return null;
  }
  return [...runtimes].sort((a, b) => compareVersions(b.version, a.version))[0];
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersions(a, b) {
  const left = String(a).split('.').map((n) => Number(n) || 0);
  const right = String(b).split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const d = (left[i] ?? 0) - (right[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * @param {string|undefined} wanted
 * @param {{signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, id: string, label: string, why: string}>}
 */
async function pickDeviceType(wanted, opts) {
  const listed = await simctl(['list', '-j', 'devicetypes'], { timeoutMs: 45_000, signal: opts.signal });
  /** @type {{identifier: string, name: string}[]} */
  let types = [];
  try {
    types = (JSON.parse(listed.stdout || '{}').devicetypes ?? []).map((/** @type {any} */ t) => ({
      identifier: String(t.identifier), name: String(t.name),
    }));
  } catch {
    return { ok: false, id: '', label: '', why: 'The list of device kinds could not be read, so no device can be made.' };
  }
  if (wanted) {
    const found = types.find((t) => t.identifier === wanted || t.name === wanted);
    if (found) return { ok: true, id: found.identifier, label: found.name, why: '' };
    return { ok: false, id: '', label: '', why: `This machine has no simulator called "${wanted}".` };
  }
  const phones = types.filter((t) => /SimDeviceType\.iPhone-\d/.test(t.identifier) && !/Plus|Max|mini|e$/.test(t.name));
  const pick = phones[phones.length - 1] ?? types.find((t) => t.identifier.includes('iPhone'));
  if (!pick) return { ok: false, id: '', label: '', why: 'This machine has no iPhone simulator kind at all.' };
  return { ok: true, id: pick.identifier, label: pick.name, why: '' };
}

/**
 * @param {string} udid
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, why: string, ms: number}>}
 */
export async function bootDevice(udid, opts = {}) {
  const started = Date.now();
  const boot = await simctl(['boot', udid], { timeoutMs: opts.timeoutMs ?? 180_000, signal: opts.signal });
  if (!boot.ok && !/already booted/i.test(boot.stderr)) {
    return { ok: false, why: `That simulator would not start: ${firstLine(boot.stderr) || boot.why}`, ms: Date.now() - started };
  }
  await simctl(['bootstatus', udid], { timeoutMs: opts.timeoutMs ?? 180_000, signal: opts.signal });
  const ms = Date.now() - started;
  return { ok: true, why: `The simulator was ready after ${Math.round(ms / 1000)} seconds.`, ms };
}

/**
 * Put the device back the way we found it. Shuts down only what this run booted.
 *
 * @param {OurDevice} device
 * @param {{delete?: boolean, signal?: AbortSignal}} [opts]
 * @returns {Promise<string>} plain English, what was and was not done
 */
export async function releaseDevice(device, opts = {}) {
  if (!device.weBootedIt) return `The simulator "${device.name}" was running before this started, so it was left running.`;
  await simctl(['shutdown', device.udid], { timeoutMs: 90_000, signal: opts.signal });
  if (opts.delete && device.weMadeIt) {
    await simctl(['delete', device.udid], { timeoutMs: 90_000, signal: opts.signal });
    return `The simulator "${device.name}" was made here, so it was shut down and deleted.`;
  }
  return `The simulator "${device.name}" was booted here, so it was shut down. It was not deleted, because booting a fresh one costs about a minute and the next run can reuse this.`;
}

// ---------------------------------------------------------------------------
// Making the device boring
// ---------------------------------------------------------------------------

/**
 * Everything about a phone that changes on its own, pinned.
 *
 * A phone is a clock with a radio in it. The clock in the status bar, the signal bars, the
 * battery percentage and the light/dark setting all move without anybody touching the app,
 * and every one of them lands in a picture. These are pinned to fixed values so that when
 * two runs disagree, the disagreement is about the app.
 *
 * What could NOT be pinned is said out loud in the return value rather than left to be
 * discovered later, because a determinism setting that quietly did nothing is exactly the
 * kind of thing that makes a green run mean less than it looks.
 *
 * @param {string} udid
 * @param {{appearance?: 'light'|'dark', signal?: AbortSignal}} [opts]
 * @returns {Promise<{pinned: string[], couldNot: string[]}>}
 */
export async function steadyTheDevice(udid, opts = {}) {
  /** @type {string[]} */
  const pinned = [];
  /** @type {string[]} */
  const couldNot = [];

  // '9:41' and not an ISO timestamp. Measured on iOS 26.5: the documented ISO form is
  // rejected outright ('Invalid, non-ISO date/time string', errno 22) while the short clock
  // form is accepted. Passing the documented one and not checking would have left the clock
  // live in every screenshot.
  const bar = await simctl([
    'status_bar', udid, 'override',
    '--time', '9:41',
    '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3',
    '--cellularMode', 'active', '--cellularBars', '4',
    '--batteryState', 'charged', '--batteryLevel', '100',
  ], { timeoutMs: 30_000, signal: opts.signal });
  if (bar.ok) pinned.push('the clock, the signal bars and the battery in the status bar');
  else couldNot.push(`the status bar could not be pinned (${firstLine(bar.stderr) || bar.why}), so the clock in every picture will differ between runs`);

  const look = await simctl(['ui', udid, 'appearance', opts.appearance ?? 'light'], { timeoutMs: 30_000, signal: opts.signal });
  if (look.ok) pinned.push(`the ${opts.appearance ?? 'light'} appearance`);
  else couldNot.push('light or dark mode could not be set, so a system-wide change would show up as a difference in the app');

  const motion = await simctl(['spawn', udid, 'defaults', 'write', 'com.apple.Accessibility', 'ReduceMotionEnabled', '-bool', 'true'], { timeoutMs: 30_000, signal: opts.signal });
  if (motion.ok) pinned.push('reduced motion, so animations do not decide what a picture catches');
  else couldNot.push('reduced motion could not be switched on, so a picture may catch an animation halfway');

  couldNot.push('the app\'s own clock and its own randomness are not touched from out here — they are the product\'s own wobble, and they are measured by running the same build twice rather than suppressed');

  return { pinned, couldNot };
}

// ---------------------------------------------------------------------------
// The observer that goes inside the app
// ---------------------------------------------------------------------------

/**
 * The whole probe, in Objective-C.
 *
 * It lives here as text rather than as a file on disk for the same reason the browser lane
 * keeps its page scripts inline: the thing that reads the screen and the thing that
 * interprets what it read have to move together, and a separate file is a separate version.
 *
 * Deliberately no backslashes anywhere in this source: it is carried through a JavaScript
 * template string, and an escape here would arrive at the compiler as something else.
 */
export const PROBE_SOURCE = `#import <UIKit/UIKit.h>
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <dlfcn.h>

static NSString *gDir = nil;
static NSMutableArray *gCalls = nil;
static NSMutableArray *gRefused = nil;

static NSString *roleOf(UIAccessibilityTraits t) {
  if (t & UIAccessibilityTraitButton) return @"button";
  if (t & UIAccessibilityTraitLink) return @"link";
  if (t & UIAccessibilityTraitSearchField) return @"search field";
  if (t & UIAccessibilityTraitKeyboardKey) return @"key";
  if (t & UIAccessibilityTraitHeader) return @"heading";
  if (t & UIAccessibilityTraitAdjustable) return @"slider";
  if (t & UIAccessibilityTraitImage) return @"image";
  if (t & UIAccessibilityTraitStaticText) return @"text";
  if (t & UIAccessibilityTraitTabBar) return @"tab bar";
  return @"element";
}

static NSArray *statesOf(id node, UIAccessibilityTraits t) {
  NSMutableArray *s = [NSMutableArray array];
  if (t & UIAccessibilityTraitNotEnabled) [s addObject:@"disabled"];
  if (t & UIAccessibilityTraitSelected) [s addObject:@"selected"];
  if (t & UIAccessibilityTraitUpdatesFrequently) [s addObject:@"updates often"];
  if ([node isKindOfClass:[UIControl class]] && ![(UIControl *)node isEnabled]) [s addObject:@"disabled"];
  return s;
}

static NSDictionary *describe(id node, int depth);

static NSArray *childrenOf(id node, int depth) {
  NSMutableArray *kids = [NSMutableArray array];
  NSInteger n = 0;
  if ([node respondsToSelector:@selector(accessibilityElementCount)]) n = [node accessibilityElementCount];
  if (n != NSNotFound && n > 0 && n < 5000) {
    for (NSInteger i = 0; i < n; i++) {
      NSDictionary *d = describe([node accessibilityElementAtIndex:i], depth + 1);
      if (d) [kids addObject:d];
    }
    return kids;
  }
  if ([node isKindOfClass:[UIView class]]) {
    for (UIView *sub in [(UIView *)node subviews]) {
      if (sub.isHidden || sub.alpha < 0.01) continue;
      NSDictionary *d = describe(sub, depth + 1);
      if (d) [kids addObject:d];
    }
  }
  return kids;
}

static NSDictionary *describe(id node, int depth) {
  if (!node || depth > 60) return nil;
  if ([node respondsToSelector:@selector(accessibilityElementsHidden)] && [node accessibilityElementsHidden]) return nil;
  NSString *label = [node respondsToSelector:@selector(accessibilityLabel)] ? [node accessibilityLabel] : nil;
  NSString *ident = [node respondsToSelector:@selector(accessibilityIdentifier)] ? [node accessibilityIdentifier] : nil;
  NSString *value = [node respondsToSelector:@selector(accessibilityValue)] ? [node accessibilityValue] : nil;
  UIAccessibilityTraits tr = [node respondsToSelector:@selector(accessibilityTraits)] ? [node accessibilityTraits] : 0;
  BOOL isEl = [node respondsToSelector:@selector(isAccessibilityElement)] ? [node isAccessibilityElement] : NO;

  NSArray *kids = childrenOf(node, depth);
  BOOL named = isEl || label.length || ident.length || value.length;
  if (!named) {
    if (kids.count == 1) return kids[0];
    if (kids.count == 0) return nil;
  }
  NSMutableDictionary *d = [NSMutableDictionary dictionary];
  d[@"role"] = named ? roleOf(tr) : @"group";
  if (label.length) d[@"name"] = label;
  if (ident.length) d[@"id"] = ident;
  if (value.length) d[@"value"] = value;
  NSArray *st = statesOf(node, tr);
  if (st.count) d[@"states"] = st;
  if (kids.count) d[@"children"] = kids;
  return d;
}

static void turnAccessibilityOn(void) {
  void *h = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW);
  if (!h) return;
  void (*setApp)(BOOL) = dlsym(h, "_AXSApplicationAccessibilitySetEnabled");
  void (*setAuto)(BOOL) = dlsym(h, "_AXSSetAutomationEnabled");
  if (setApp) setApp(YES);
  if (setAuto) setAuto(YES);
}

static NSArray *snapshotTree(void) {
  turnAccessibilityOn();
  NSMutableArray *out = [NSMutableArray array];
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) continue;
    for (UIWindow *w in ((UIWindowScene *)scene).windows) {
      if (w.isHidden) continue;
      NSDictionary *d = describe(w, 0);
      if (d) [out addObject:d];
    }
  }
  return out;
}

static id findElement(NSString *wanted) {
  __block id found = nil;
  __block void (^scan)(id, int);
  scan = ^(id node, int depth) {
    if (found || !node || depth > 60) return;
    NSString *ident = [node respondsToSelector:@selector(accessibilityIdentifier)] ? [node accessibilityIdentifier] : nil;
    NSString *label = [node respondsToSelector:@selector(accessibilityLabel)] ? [node accessibilityLabel] : nil;
    if ([ident isEqualToString:wanted] || [label isEqualToString:wanted]) { found = node; return; }
    NSInteger n = [node respondsToSelector:@selector(accessibilityElementCount)] ? [node accessibilityElementCount] : 0;
    if (n != NSNotFound && n > 0 && n < 5000) {
      for (NSInteger i = 0; i < n && !found; i++) scan([node accessibilityElementAtIndex:i], depth + 1);
      return;
    }
    if ([node isKindOfClass:[UIView class]])
      for (UIView *sub in [(UIView *)node subviews]) { if (found) break; scan(sub, depth + 1); }
  };
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) continue;
    for (UIWindow *w in ((UIWindowScene *)scene).windows) scan(w, 0);
  }
  return found;
}

static BOOL wouldNotComeBack(NSURLRequest *r) {
  NSString *m = (r.HTTPMethod ?: @"GET").uppercaseString;
  NSString *u = (r.URL.absoluteString ?: @"").lowercaseString;
  if ([m isEqualToString:@"GET"] || [m isEqualToString:@"HEAD"] || [m isEqualToString:@"OPTIONS"]) return NO;
  NSArray *words = @[@"charge", @"payment", @"pay", @"purchase", @"checkout", @"subscribe",
                     @"refund", @"payout", @"transfer", @"withdraw", @"sms", @"email",
                     @"message", @"invite", @"delete", @"destroy", @"wipe", @"erase"];
  for (NSString *word in words) if ([u containsString:word]) return YES;
  return [m isEqualToString:@"DELETE"];
}

static IMP gOrigResume = NULL;

static void sf_resume(id self, SEL _cmd) {
  NSURLRequest *r = [(NSURLSessionTask *)self originalRequest];
  if (r && gCalls) {
    NSMutableDictionary *e = [NSMutableDictionary dictionary];
    e[@"method"] = (r.HTTPMethod ?: @"GET").uppercaseString;
    e[@"host"] = r.URL.host ?: @"";
    e[@"path"] = r.URL.path ?: @"";
    e[@"query"] = r.URL.query ?: @"";
    e[@"bodyBytes"] = @(r.HTTPBody.length);
    if (wouldNotComeBack(r)) {
      [gRefused addObject:e];
      [(NSURLSessionTask *)self cancel];
      return;
    }
    [gCalls addObject:e];
  }
  ((void (*)(id, SEL))gOrigResume)(self, _cmd);
}

static void writeReply(NSString *seq, id payload) {
  NSData *d = [NSJSONSerialization dataWithJSONObject:payload options:NSJSONWritingSortedKeys error:NULL];
  if (!d) d = [NSJSONSerialization dataWithJSONObject:@{@"error": @"the reply could not be written down"} options:0 error:NULL];
  NSString *tmp = [gDir stringByAppendingPathComponent:[NSString stringWithFormat:@"reply-%@.part", seq]];
  NSString *fin = [gDir stringByAppendingPathComponent:[NSString stringWithFormat:@"reply-%@.json", seq]];
  [d writeToFile:tmp atomically:YES];
  [[NSFileManager defaultManager] moveItemAtPath:tmp toPath:fin error:NULL];
}

static void runCommand(NSDictionary *cmd, NSString *seq) {
  NSString *act = cmd[@"act"] ?: @"tree";
  NSMutableDictionary *res = [NSMutableDictionary dictionary];
  res[@"act"] = act;
  if ([act isEqualToString:@"tree"]) {
    res[@"tree"] = snapshotTree();
  } else if ([act isEqualToString:@"tap"] || [act isEqualToString:@"type"]) {
    id el = findElement(cmd[@"target"]);
    if (!el) {
      res[@"ok"] = @NO;
      res[@"why"] = [NSString stringWithFormat:@"nothing on this screen is called '%@'", cmd[@"target"] ?: @""];
    } else if ([act isEqualToString:@"type"]) {
      BOOL ok = NO;
      if ([el isKindOfClass:[UITextField class]]) { [(UITextField *)el setText:cmd[@"text"]]; ok = YES; }
      else if ([el isKindOfClass:[UITextView class]]) { [(UITextView *)el setText:cmd[@"text"]]; ok = YES; }
      res[@"ok"] = @(ok);
      if (!ok) res[@"why"] = @"that control does not take typing";
    } else {
      BOOL ok = [el respondsToSelector:@selector(accessibilityActivate)] ? [el accessibilityActivate] : NO;
      if (!ok && [el isKindOfClass:[UIControl class]]) {
        [(UIControl *)el sendActionsForControlEvents:UIControlEventTouchUpInside];
        ok = YES;
      }
      res[@"ok"] = @(ok);
      if (!ok) res[@"why"] = @"the control was found but would not activate";
    }
  } else if ([act isEqualToString:@"calls"]) {
    res[@"calls"] = gCalls ?: @[];
    res[@"refused"] = gRefused ?: @[];
  } else if ([act isEqualToString:@"reset"]) {
    [gCalls removeAllObjects];
    [gRefused removeAllObjects];
    res[@"ok"] = @YES;
  } else if ([act isEqualToString:@"ping"]) {
    res[@"ok"] = @YES;
    res[@"bundle"] = [[NSBundle mainBundle] bundleIdentifier] ?: @"";
    res[@"version"] = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"";
    res[@"home"] = NSHomeDirectory() ?: @"";
  } else {
    res[@"ok"] = @NO;
    res[@"why"] = [NSString stringWithFormat:@"the probe was asked to '%@' and does not know how", act];
  }
  writeReply(seq, res);
}

static void loop(void) {
  NSFileManager *fm = [NSFileManager defaultManager];
  while (1) @autoreleasepool {
    NSArray *files = [[fm contentsOfDirectoryAtPath:gDir error:NULL] sortedArrayUsingSelector:@selector(compare:)];
    for (NSString *f in files) {
      if (![f hasPrefix:@"cmd-"] || ![f hasSuffix:@".json"]) continue;
      NSString *seq = [[f stringByDeletingPathExtension] substringFromIndex:4];
      NSString *full = [gDir stringByAppendingPathComponent:f];
      NSData *d = [NSData dataWithContentsOfFile:full];
      [fm removeItemAtPath:full error:NULL];
      if (!d) continue;
      NSDictionary *cmd = [NSJSONSerialization JSONObjectWithData:d options:0 error:NULL];
      if ([cmd isKindOfClass:[NSDictionary class]])
        dispatch_sync(dispatch_get_main_queue(), ^{ runCommand(cmd, seq); });
    }
    usleep(30000);
  }
}

__attribute__((constructor))
static void sf_start(void) {
  @autoreleasepool {
    const char *dir = getenv("STAYSFIXED_DIR");
    if (!dir) return;
    gDir = [NSString stringWithUTF8String:dir];
    gCalls = [NSMutableArray array];
    gRefused = [NSMutableArray array];
    [[NSFileManager defaultManager] createDirectoryAtPath:gDir withIntermediateDirectories:YES attributes:nil error:NULL];
    turnAccessibilityOn();
    Class cls = NSClassFromString(@"__NSCFURLSessionTask") ?: NSClassFromString(@"NSURLSessionTask");
    Method m = class_getInstanceMethod(cls, @selector(resume));
    if (m) gOrigResume = method_setImplementation(m, (IMP)sf_resume);
    [NSThread detachNewThreadWithBlock:^{ loop(); }];
  }
}
`;

/** The name the probe is given inside the app bundle. */
export const PROBE_NAME = 'libstaysfixed-probe.dylib';

/**
 * Build the probe, once, and keep it. Measured at about 1.5 seconds cold; after that the
 * cached copy is used, because the source is hashed and the hash is the file name.
 *
 * @param {object} opts
 * @param {string} opts.scratchDir
 * @param {string} [opts.target]       Defaults to the oldest iOS the probe is known to work on.
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok: boolean, dylib: string, why: string, ms: number, cached: boolean}>}
 */
export async function buildProbe(opts) {
  const started = Date.now();
  const target = opts.target ?? 'arm64-apple-ios15.0-simulator';
  const stamp = crypto.createHash('sha256').update(`${PROBE_SOURCE}|${target}`).digest('hex').slice(0, 16);
  const home = path.join(opts.scratchDir, 'ios-probe');
  const dylib = path.join(home, `probe-${stamp}.dylib`);
  await fsp.mkdir(home, { recursive: true });
  try {
    await fsp.access(dylib);
    return { ok: true, dylib, why: 'The observer was already built for this machine and was reused.', ms: Date.now() - started, cached: true };
  } catch {
    // Not built yet. Fall through and build it.
  }

  const source = path.join(home, `probe-${stamp}.m`);
  await fsp.writeFile(source, PROBE_SOURCE, 'utf8');
  const built = await runOnce('xcrun', [
    '-sdk', 'iphonesimulator', 'clang',
    '-dynamiclib', '-fobjc-arc', '-O1',
    '-Wno-arc-retain-cycles',
    '-target', target,
    '-framework', 'UIKit', '-framework', 'Foundation', '-framework', 'CoreGraphics',
    '-o', dylib, source,
  ], { timeoutMs: 120_000, signal: opts.signal });

  if (built.code !== 0) {
    return {
      ok: false,
      dylib: '',
      why: `The small observer that reads the screen would not compile: ${firstLine(built.stderr) || `clang exited ${built.code}`}`,
      ms: Date.now() - started,
      cached: false,
    };
  }
  return { ok: true, dylib, why: 'The observer was built.', ms: Date.now() - started, cached: false };
}

// ---------------------------------------------------------------------------
// Opening one build
// ---------------------------------------------------------------------------

/**
 * One node of the accessibility tree, as the probe reports it.
 *
 * @typedef {object} MeaningNode
 * @property {string} role
 * @property {string} [name]
 * @property {string} [id]
 * @property {string} [value]
 * @property {string[]} [states]
 * @property {MeaningNode[]} [children]
 */

/**
 * One call the app tried to make.
 *
 * @typedef {object} Call
 * @property {string} method
 * @property {string} host
 * @property {string} path
 * @property {string} query
 * @property {number} bodyBytes
 */

/**
 * A running app, with the probe inside it.
 *
 * @typedef {object} OpenApp
 * @property {string} udid
 * @property {string} bundleId
 * @property {string} appPath          The scratch copy that was installed, never the original.
 * @property {string} container        The app's data container, on the Mac's own disk.
 * @property {number} launchedAt
 * @property {boolean} probeAnswered   False means the screen cannot be read, only pictured.
 * @property {string} why
 * @property {(act: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<any>} ask
 * @property {() => Promise<MeaningNode[]>} tree
 * @property {(target: string) => Promise<{ok: boolean, why: string}>} tap
 * @property {(target: string, text: string) => Promise<{ok: boolean, why: string}>} type
 * @property {() => Promise<{calls: Call[], refused: Call[]}>} calls
 * @property {(file: string) => Promise<{ok: boolean, path: string, why: string}>} screenshot
 * @property {() => Promise<string[]>} filesWritten
 * @property {() => Promise<void>} close
 */

/** How long the probe is given to answer one question before we stop waiting. */
const ANSWER_TIMEOUT_MS = 20_000;

/** Where inside the app's own container the two sides leave notes for each other. */
const CHANNEL_INSIDE_CONTAINER = path.join('Library', 'Caches', 'staysfixed-channel');

/**
 * Folders inside an app's container that iOS writes, not the app.
 *
 * Everything here was seen changing between two runs of the SAME build, which is the
 * definition of somebody else's footprint.
 */
export const IOS_OWN_BOOKKEEPING = [
  path.join('Library', 'SplashBoard'),
  path.join('Library', 'Caches', 'com.apple.'),
  path.join('Library', 'Saved Application State'),
  path.join('SystemData'),
  path.join('tmp', 'com.apple.'),
];

/**
 * Install one build into the device and start it with the probe inside.
 *
 * The bundle is COPIED first and the copy is what gets the probe and gets installed. The
 * real build directory is never written to — somebody has it open in Xcode.
 *
 * @param {object} opts
 * @param {string} opts.udid
 * @param {string} opts.appPath          Path to a .app bundle.
 * @param {string} opts.scratchDir
 * @param {string} [opts.probeDylib]     Skip to run without the probe: pictures only.
 * @param {Record<string,string>} [opts.env]  Extra environment for the app.
 * @param {string[]} [opts.args]
 * @param {number} [opts.firstAnswerMs] How long to wait for the app to answer at all.
 * @param {AbortSignal} [opts.signal]
 * @param {(message: string) => void} [opts.log]
 * @returns {Promise<{ok: boolean, app: OpenApp|null, why: string, timings: Record<string, number>}>}
 */
export async function openApp(opts) {
  /** @type {Record<string, number>} */
  const timings = {};
  const mark = /** @param {string} name @param {number} from */ (name, from) => {
    timings[name] = Date.now() - from;
  };

  let t = Date.now();
  const facts = await readAppBundle(opts.appPath);
  if (!facts.ok) return { ok: false, app: null, why: facts.why, timings };
  mark('read the bundle', t);

  t = Date.now();
  const staging = path.join(opts.scratchDir, 'ios-install');
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });
  const copied = path.join(staging, path.basename(opts.appPath));
  await fsp.cp(opts.appPath, copied, { recursive: true });
  if (opts.probeDylib) await fsp.cp(opts.probeDylib, path.join(copied, PROBE_NAME));
  mark('copy the app', t);

  t = Date.now();
  const installed = await simctl(['install', opts.udid, copied], { timeoutMs: 180_000, signal: opts.signal });
  if (!installed.ok) {
    return { ok: false, app: null, why: `That build would not install: ${firstLine(installed.stderr) || installed.why}`, timings };
  }
  mark('install', t);

  const containerRan = await simctl(['get_app_container', opts.udid, facts.bundleId, 'data'], { timeoutMs: 60_000, signal: opts.signal });
  const container = containerRan.stdout.trim();
  if (!container) {
    return { ok: false, app: null, why: `The app installed but its own folder on the device could not be found, so nothing it writes can be seen.`, timings };
  }
  const channel = path.join(container, CHANNEL_INSIDE_CONTAINER);
  await fsp.rm(channel, { recursive: true, force: true });
  await fsp.mkdir(channel, { recursive: true });

  t = Date.now();
  const launchedAt = Date.now();
  /** @type {Record<string,string>} */
  const env = {};
  for (const [key, value] of Object.entries(opts.env ?? {})) env[`SIMCTL_CHILD_${key}`] = value;
  if (opts.probeDylib) {
    env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES = `@executable_path/${PROBE_NAME}`;
    env.SIMCTL_CHILD_STAYSFIXED_DIR = channel;
  }
  const launched = await simctl(['launch', opts.udid, facts.bundleId, ...(opts.args ?? [])], {
    timeoutMs: 120_000, signal: opts.signal, env,
  });
  if (!launched.ok) {
    return { ok: false, app: null, why: `That build installed but would not start: ${firstLine(launched.stderr) || launched.why}`, timings };
  }
  mark('launch', t);

  let sequence = 0;
  /**
   * @param {string} act
   * @param {Record<string, unknown>} [args]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  const ask = async (act, args = {}, timeoutMs = ANSWER_TIMEOUT_MS) => {
    if (!opts.probeDylib) return { ok: false, why: 'The app was started without the observer, so it cannot be asked anything.' };
    sequence += 1;
    const seq = String(sequence).padStart(5, '0');
    const reply = path.join(channel, `reply-${seq}.json`);
    await fsp.writeFile(path.join(channel, `cmd-${seq}.json`), JSON.stringify({ act, ...args }), 'utf8');
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (opts.signal?.aborted) throw new Error('The run was cancelled while the app was being asked something.');
      try {
        const text = await fsp.readFile(reply, 'utf8');
        await fsp.rm(reply, { force: true });
        return JSON.parse(text);
      } catch {
        await wait(40);
      }
    }
    return { ok: false, timedOut: true, why: `The app did not answer within ${Math.round(timeoutMs / 1000)} seconds when it was asked to ${act}. It may be busy, or it may have stopped.` };
  };

  t = Date.now();
  let probeAnswered = false;
  if (opts.probeDylib) {
    // Sixty seconds and not twenty. Measured: on a device that has just been wiped, the
    // first app to start waits behind everything iOS does on a fresh boot, and a walk that
    // took eighteen seconds on a warm device took over seven minutes on a cold one. A
    // window that is too short does not fail loudly - it reports the screen as unreadable,
    // which is a hole where there was no problem.
    const until = Date.now() + (opts.firstAnswerMs ?? 60_000);
    while (Date.now() < until && !probeAnswered) {
      const pong = await ask('ping', {}, 4_000);
      probeAnswered = pong?.ok === true;
      if (!probeAnswered) await wait(200);
    }
  }
  mark('the app answered', t);

  /** @type {OpenApp} */
  const app = {
    udid: opts.udid,
    bundleId: facts.bundleId,
    appPath: copied,
    container,
    launchedAt,
    probeAnswered,
    why: probeAnswered
      ? 'The app is running with the observer inside it, so its screen can be read by meaning.'
      : opts.probeDylib
        ? 'The app is running but the observer never answered, so only pictures, logs, crashes and the files it writes can be seen. What the screen MEANS is not being checked, and that is the most important channel there is.'
        : 'The app is running without the observer, by request. Only pictures, logs, crashes and the files it writes are being seen.',
    ask,
    tree: async () => {
      const reply = await ask('tree', {}, 30_000);
      return Array.isArray(reply?.tree) ? reply.tree : [];
    },
    tap: async (target) => {
      const reply = await ask('tap', { target });
      return { ok: reply?.ok === true, why: reply?.why ?? (reply?.ok ? `Activated "${target}".` : 'The app gave no reason.') };
    },
    type: async (target, text) => {
      const reply = await ask('type', { target, text });
      return { ok: reply?.ok === true, why: reply?.why ?? (reply?.ok ? `Typed into "${target}".` : 'The app gave no reason.') };
    },
    calls: async () => {
      const reply = await ask('calls');
      return { calls: Array.isArray(reply?.calls) ? reply.calls : [], refused: Array.isArray(reply?.refused) ? reply.refused : [] };
    },
    screenshot: async (file) => takeScreenshot(opts.udid, file, { signal: opts.signal }),
    filesWritten: async () => listContainerFiles(container),
    close: async () => {
      await simctl(['terminate', opts.udid, facts.bundleId], { timeoutMs: 60_000 });
    },
  };

  return { ok: true, app, why: app.why, timings };
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Reading a build without running it
// ---------------------------------------------------------------------------

/**
 * What the app bundle says about itself, before anything is started.
 *
 * This is the contract channel for a phone app, and it is the cheapest observation in the
 * whole lane: no boot, no install, no walking. It names the doors — which URL schemes the
 * app answers on, which permissions it will ask a person for, which background modes it
 * claims — and all of that is exact, because it is read out of the thing that ships.
 *
 * @typedef {object} AppFacts
 * @property {boolean} ok
 * @property {string} why
 * @property {string} bundleId
 * @property {string} name
 * @property {string} version
 * @property {string} build
 * @property {string} minimumOS
 * @property {string[]} urlSchemes      Every address a stranger can hand this app.
 * @property {{key: string, reason: string}[]} permissions  Every permission it will ask for.
 * @property {string[]} backgroundModes
 * @property {string[]} deviceFamilies
 * @property {Record<string, JsonValue>} raw
 */

/**
 * @param {string} appPath
 * @returns {Promise<AppFacts>}
 */
export async function readAppBundle(appPath) {
  /** @type {AppFacts} */
  const empty = {
    ok: false, why: '', bundleId: '', name: '', version: '', build: '', minimumOS: '',
    urlSchemes: [], permissions: [], backgroundModes: [], deviceFamilies: [], raw: {},
  };
  const plist = path.join(appPath, 'Info.plist');
  const ran = await runOnce('plutil', ['-convert', 'json', '-o', '-', plist], { timeoutMs: 20_000 });
  if (ran.code !== 0) {
    return { ...empty, why: `"${path.basename(appPath)}" does not look like an iPhone app: it has no readable Info.plist inside it.` };
  }
  /** @type {Record<string, any>} */
  let info = {};
  try {
    info = JSON.parse(ran.stdout);
  } catch {
    return { ...empty, why: `The Info.plist inside "${path.basename(appPath)}" could not be read.` };
  }

  const bundleId = String(info.CFBundleIdentifier ?? '');
  if (!bundleId) return { ...empty, why: `The app bundle at "${appPath}" has no bundle identifier, so it cannot be installed or launched.` };

  /** @type {string[]} */
  const urlSchemes = [];
  for (const entry of info.CFBundleURLTypes ?? []) {
    for (const scheme of entry?.CFBundleURLSchemes ?? []) urlSchemes.push(String(scheme));
  }
  /** @type {{key: string, reason: string}[]} */
  const permissions = [];
  for (const [key, value] of Object.entries(info)) {
    if (/UsageDescription$/.test(key)) permissions.push({ key, reason: String(value) });
  }

  return {
    ok: true,
    why: `${info.CFBundleDisplayName ?? info.CFBundleName ?? bundleId}, version ${info.CFBundleShortVersionString ?? '?'} (${info.CFBundleVersion ?? '?'}).`,
    bundleId,
    name: String(info.CFBundleDisplayName ?? info.CFBundleName ?? bundleId),
    version: String(info.CFBundleShortVersionString ?? ''),
    build: String(info.CFBundleVersion ?? ''),
    minimumOS: String(info.MinimumOSVersion ?? ''),
    urlSchemes: urlSchemes.sort(),
    permissions: permissions.sort((a, b) => a.key.localeCompare(b.key)),
    backgroundModes: [...(info.UIBackgroundModes ?? [])].map(String).sort(),
    deviceFamilies: [...(info.UIDeviceFamily ?? [])].map((n) => (n === 1 ? 'iPhone' : n === 2 ? 'iPad' : `family ${n}`)),
    raw: info,
  };
}

// ---------------------------------------------------------------------------
// Turning a tree into addresses
// ---------------------------------------------------------------------------

/**
 * One thing on the screen, at an address that survives a redesign.
 *
 * @typedef {object} Meaning
 * @property {string} address
 * @property {JsonValue} value
 * @property {string} says
 */

/**
 * Flatten the accessibility tree into addresses.
 *
 * THE ADDRESSING RULE, and it is the load-bearing choice in this file. A control that has
 * an accessibility identifier is addressed by that identifier alone, and everything a
 * person can see about it — its role, its label, its value, its states — becomes the VALUE
 * at that address. An identifier is put there by the people who wrote the app precisely so
 * it can be pointed at later; it does not move when the screen is rearranged and it does
 * not change when the wording changes. That means renaming a button reports as one changed
 * value rather than as a button vanishing and another appearing, which is what a person
 * actually did.
 *
 * A control with NO identifier falls back to what it is and what it says — `button:Pay now`
 * — inside the chain of named ancestors above it. That address does move when the wording
 * moves, and that is the honest cost of an app that did not label its controls. The
 * coverage ledger counts how many controls had to be addressed this way.
 *
 * Position is used only to tell apart two controls that are otherwise identical, and only
 * within the one group they share.
 *
 * @param {MeaningNode[]} tree
 * @returns {Meaning[]}
 */
export function flattenMeaning(tree) {
  /** @type {Meaning[]} */
  const out = [];
  /** @type {Map<string, number>} */
  const seen = new Map();

  /**
   * @param {MeaningNode} node
   * @param {string[]} trail
   */
  const walk = (node, trail) => {
    /** @type {string} */
    let address = '';
    if (node.id) {
      address = `#${node.id}`;
    } else if (node.name) {
      address = [...trail, `${node.role}:${node.name}`].join(' > ');
    }

    if (address) {
      const count = seen.get(address) ?? 0;
      seen.set(address, count + 1);
      const unique = count === 0 ? address : `${address} (${count + 1})`;
      /** @type {Record<string, JsonValue>} */
      const value = { role: node.role };
      if (node.name) value.name = node.name;
      if (node.value) value.value = node.value;
      if (node.states?.length) value.states = [...node.states].sort();
      out.push({
        address: unique,
        value,
        says: `${describeRole(node.role)}${node.name ? ` saying "${node.name}"` : ''}${node.value ? `, set to "${node.value}"` : ''}${node.states?.length ? `, ${node.states.join(' and ')}` : ''}`,
      });
    }

    const nextTrail = node.name && isLandmark(node.role) ? [...trail, `${node.role}:${node.name}`] : trail;
    for (const child of node.children ?? []) walk(child, nextTrail);
  };

  for (const root of tree) walk(root, []);
  return out;
}

/**
 * Roles that anchor everything under them. Kept short: a deep chain of ancestors makes an
 * address that moves whenever anything above it moves, which is the opposite of the point.
 * @param {string} role
 * @returns {boolean}
 */
function isLandmark(role) {
  return role === 'heading' || role === 'tab bar';
}

/**
 * @param {string} role
 * @returns {string}
 */
function describeRole(role) {
  switch (role) {
    case 'button': return 'a button';
    case 'link': return 'a link';
    case 'heading': return 'a heading';
    case 'text': return 'a piece of text';
    case 'image': return 'an image';
    case 'slider': return 'a control you can slide';
    case 'search field': return 'a search box';
    case 'tab bar': return 'a row of tabs';
    case 'group': return 'a group of things';
    default: return 'something on the screen';
  }
}

/**
 * Read the screen until it stops changing.
 *
 * The same idea as `src/freeze/settle.js`, which captures until two frames agree, moved
 * from pixels to meaning: ask for the tree, ask again, and keep the answer only once two
 * answers in a row are identical. A phone animates almost every transition, and reading
 * mid-animation gives a tree with half a screen in it — which then reports as a difference
 * caused by nothing.
 *
 * @param {() => Promise<MeaningNode[]>} read
 * @param {{tries?: number, gapMs?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<{tree: MeaningNode[], settled: boolean, tries: number, why: string}>}
 */
export async function settleTree(read, opts = {}) {
  const tries = opts.tries ?? 6;
  const gap = opts.gapMs ?? 300;
  let previous = '';
  /** @type {MeaningNode[]} */
  let tree = [];
  for (let i = 1; i <= tries; i += 1) {
    if (opts.signal?.aborted) break;
    tree = await read();
    const now = JSON.stringify(tree);
    if (now === previous && now !== '[]') {
      return { tree, settled: true, tries: i, why: `The screen was the same twice in a row after ${i} looks.` };
    }
    previous = now;
    if (i < tries) await wait(gap);
  }
  return {
    tree,
    settled: false,
    tries,
    why: `The screen was still changing after ${tries} looks, so what was read may have caught it mid-move. Anything that differs here should be treated as the app's own wobble until a second run says otherwise.`,
  };
}

// ---------------------------------------------------------------------------
// Complaints, files, pictures
// ---------------------------------------------------------------------------

/**
 * The app's own log, filtered to what the app itself said.
 *
 * Everything else on a phone is talking at once — a raw log stream from a simulator is tens
 * of thousands of lines a minute, almost none of it the app's. The filter is the app's OWN
 * SUBSYSTEM, which is what any team using `Logger` gets for free.
 *
 * Widening it to the process name was tried and measured, and it is off by default because
 * of what it caught: every line the networking stack writes on the app's behalf, each one
 * carrying a fresh connection id, so a run that made one HTTP call produced six log paths
 * that had never existed before and would never exist again. Six invented differences for
 * one real one is how a tool teaches its owner to stop reading it. Ask for `alsoProcess`
 * when an app prints the old way and means it.
 *
 * @param {object} opts
 * @param {string} opts.udid
 * @param {string} opts.bundleId
 * @param {string} [opts.processName]
 * @param {boolean} [opts.alsoProcess] Widen to everything the process logged. Noisy - see above.
 * @param {number} opts.sinceMs        How far back to look, in milliseconds.
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{lines: {level: string, text: string}[], ok: boolean, why: string}>}
 */
export async function readAppLog(opts) {
  const seconds = Math.max(1, Math.ceil(opts.sinceMs / 1000) + 2);
  const predicate = opts.alsoProcess && opts.processName
    ? `subsystem BEGINSWITH "${opts.bundleId}" OR process == "${opts.processName}"`
    : `subsystem BEGINSWITH "${opts.bundleId}"`;
  const ran = await simctl([
    'spawn', opts.udid, 'log', 'show',
    '--style', 'compact', '--last', `${seconds}s`,
    '--predicate', predicate,
  ], { timeoutMs: 90_000, signal: opts.signal });

  if (!ran.ok) {
    return { lines: [], ok: false, why: `The app's log could not be read: ${firstLine(ran.stderr) || ran.why}` };
  }
  /** @type {{level: string, text: string}[]} */
  const lines = [];
  for (const raw of ran.stdout.split('\n')) {
    const match = /^\d{4}-\d{2}-\d{2} [\d:.]+\s+(\S+)\s+\S+\s+(.*)$/.exec(raw.trim());
    if (!match) continue;
    const level = ({ Df: 'debug', In: 'info', Dg: 'default', Er: 'error', Fa: 'fault' })[match[1]] ?? match[1];
    const text = match[2].replace(/^\[[^\]]*\]\s*/, '');
    if (text) lines.push({ level, text });
  }
  return { lines, ok: true, why: `${lines.length} line${lines.length === 1 ? '' : 's'} the app itself wrote.` };
}

/**
 * Crashes, from the folder the operating system puts them in.
 *
 * A simulator writes its crash reports to the Mac's own DiagnosticReports folder, not into
 * the device. Only reports newer than the moment the app was launched are read, and only
 * the first few lines of each — the process, the reason and the exception — because the
 * whole report is a megabyte of stack and none of it belongs in a comparison.
 *
 * @param {object} opts
 * @param {string} opts.processName
 * @param {number} opts.since          Milliseconds since the epoch.
 * @returns {Promise<{crashes: {process: string, reason: string, at: string}[], why: string}>}
 */
export async function readCrashes(opts) {
  const folder = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');
  /** @type {{process: string, reason: string, at: string}[]} */
  const crashes = [];
  /** @type {string[]} */
  let names = [];
  try {
    names = await fsp.readdir(folder);
  } catch {
    return { crashes, why: 'There is no crash report folder on this Mac, so a crash could not have been seen even if there had been one.' };
  }
  for (const name of names) {
    if (!name.startsWith(`${opts.processName}-`) && !name.startsWith(`${opts.processName}_`)) continue;
    if (!/\.(ips|crash)$/.test(name)) continue;
    const full = path.join(folder, name);
    /** @type {import('node:fs').Stats} */
    let stat;
    try {
      stat = await fsp.stat(full);
    } catch {
      continue;
    }
    if (stat.mtimeMs < opts.since) continue;
    let reason = 'it stopped without saying why';
    try {
      const text = (await fsp.readFile(full, 'utf8')).slice(0, 20_000);
      const term = /"termination"\s*:\s*\{[^}]*"indicator"\s*:\s*"([^"]+)"/.exec(text);
      const exception = /"exception"\s*:\s*\{[^}]*"type"\s*:\s*"([^"]+)"/.exec(text);
      const legacy = /Exception Type:\s*(.+)/.exec(text);
      // The report is JSON, so a slash in the reason arrives escaped. Left alone it turns
      // "Trace/BPT trap: 5" into an address with a stray backslash in it.
      reason = (term?.[1] ?? exception?.[1] ?? legacy?.[1]?.trim() ?? reason).replace(/\\\//g, '/');
    } catch {
      // A report we cannot read is still a crash, and saying so is the point.
    }
    crashes.push({ process: opts.processName, reason, at: new Date(stat.mtimeMs).toISOString() });
  }
  return {
    crashes,
    why: crashes.length === 0
      ? 'The app did not crash while it was being walked.'
      : `The app crashed ${crashes.length} time${crashes.length === 1 ? '' : 's'} while it was being walked.`,
  };
}

/**
 * Everything the app wrote inside its own folder on the device.
 *
 * Paths only — the contents are the app's business, they are often large, and a byte-exact
 * comparison of a database file reports a difference every single run.
 *
 * TWO KINDS OF FOOTPRINT ARE RUBBED OUT HERE, and both were measured rather than guessed.
 * Ours: the folder the probe and the harness leave notes in. And the operating system's:
 * iOS drops a fresh picture of the app into Library/SplashBoard/Snapshots every time it
 * goes to the background, named with a brand new random id each time. Left in, that alone
 * produced four invented differences per paired run — files that appeared and vanished
 * because iOS took a photograph, which is not something the app did and not something
 * anybody can fix.
 *
 * What is NOT rubbed out is any random id in a name the app chose itself. A database file
 * that used to have a stable name and now has a random one is a real finding.
 *
 * @param {string} container
 * @returns {Promise<string[]>}
 */
export async function listContainerFiles(container) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = async (dir) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(container, full);
      if (relative.startsWith(CHANNEL_INSIDE_CONTAINER)) continue;
      if (IOS_OWN_BOOKKEEPING.some((folder) => relative.startsWith(folder))) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(relative);
    }
  };
  await walk(container);
  return out.sort();
}

/**
 * A picture, as evidence and never as the accusation.
 *
 * @param {string} udid
 * @param {string} file
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{ok: boolean, path: string, why: string}>}
 */
export async function takeScreenshot(udid, file, opts = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const ran = await simctl(['io', udid, 'screenshot', '--type', 'png', file], { timeoutMs: 60_000, signal: opts.signal });
  if (!ran.ok) return { ok: false, path: '', why: `A picture of the screen could not be taken: ${firstLine(ran.stderr) || ran.why}` };
  return { ok: true, path: file, why: 'A picture was kept as evidence.' };
}

// ---------------------------------------------------------------------------
// Getting back to a clean start
// ---------------------------------------------------------------------------

/**
 * Put the device back to a clean state between two builds.
 *
 * Two ways, and they are not equivalent, so the choice is named rather than hidden.
 *
 * 'reinstall' removes the app and everything it had written, then installs the next build.
 * Measured on this machine: about a second and a half, and it leaves the rest of the device
 * exactly as it was — the same first-launch prompts already dismissed, the same keyboard
 * state, the same warm caches.
 *
 * 'erase' wipes the whole device and boots it again. Measured: about seventy seconds, of
 * which the boot is nearly all of it. It is the only way to clear anything the app left
 * OUTSIDE its own container — the keychain, granted permissions, the photo library, a
 * notification it registered.
 *
 * The recommendation, which the adapter follows by default, is 'reinstall'. The reason is
 * arithmetic rather than taste: a paired iOS run costs two of whatever this is, and at
 * seventy seconds each an erase turns a two-minute check into a four-minute one, which is
 * the difference between something that runs on every change and something nobody switches
 * on. What 'reinstall' cannot clear is named in the return value so it appears in the
 * coverage ledger, and 'erase' is what a pre-release run should use.
 *
 * @param {object} opts
 * @param {string} opts.udid
 * @param {string} opts.bundleId
 * @param {'reinstall'|'erase'} [opts.how]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok: boolean, how: string, ms: number, why: string, leftBehind: string[]}>}
 */
export async function resetBetweenBuilds(opts) {
  const started = Date.now();
  const how = opts.how ?? 'reinstall';
  if (how === 'erase') {
    await simctl(['shutdown', opts.udid], { timeoutMs: 90_000, signal: opts.signal });
    const erased = await simctl(['erase', opts.udid], { timeoutMs: 180_000, signal: opts.signal });
    if (!erased.ok) {
      return { ok: false, how, ms: Date.now() - started, why: `The device would not erase: ${firstLine(erased.stderr) || erased.why}`, leftBehind: [] };
    }
    const booted = await bootDevice(opts.udid, { signal: opts.signal });
    return {
      ok: booted.ok,
      how,
      ms: Date.now() - started,
      why: booted.ok
        ? `The whole device was wiped and booted again, which took about ${Math.round((Date.now() - started) / 1000)} seconds. Nothing at all is left from the previous build. The first walk after this will also be much slower than the ones after it - measured here at over seven minutes against eighteen seconds warm - because everything iOS does on a fresh boot happens while the app is trying to start.`
        : booted.why,
      leftBehind: [],
    };
  }

  await simctl(['terminate', opts.udid, opts.bundleId], { timeoutMs: 60_000, signal: opts.signal });
  const removed = await simctl(['uninstall', opts.udid, opts.bundleId], { timeoutMs: 120_000, signal: opts.signal });
  return {
    ok: removed.ok || /not.*installed/i.test(removed.stderr),
    how,
    ms: Date.now() - started,
    why: `The app and everything it had written were removed, which took about ${((Date.now() - started) / 1000).toFixed(1)} seconds. The rest of the device was left alone.`,
    leftBehind: [
      'anything the app put in the keychain',
      'permissions a person or a previous run had already granted',
      'notifications the app had registered for',
      'anything it added to the photo library or the contacts',
    ],
  };
}

/**
 * Clear granted permissions for one app without wiping the device.
 *
 * The middle option between the two resets above: it costs no boot and it removes the one
 * thing a reinstall reliably leaves behind and that reliably changes what a screen says.
 *
 * @param {object} opts
 * @param {string} opts.udid
 * @param {string} opts.bundleId
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok: boolean, why: string}>}
 */
export async function resetPermissions(opts) {
  const ran = await simctl(['privacy', opts.udid, 'reset', 'all', opts.bundleId], { timeoutMs: 60_000, signal: opts.signal });
  return {
    ok: ran.ok,
    why: ran.ok
      ? 'Every permission this app had been granted was taken back, so both builds are asked the same questions.'
      : `Permissions could not be reset (${firstLine(ran.stderr) || ran.why}), so one build may have been trusted with something the other was not.`,
  };
}
