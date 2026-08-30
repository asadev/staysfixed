/**
 * Every browser this tool opens, and every one it has to close again.
 *
 * This file exists because of a real incident on the owner's Mac, and the rule it
 * encodes is the strongest one in the repository: A TOOL MUST NEVER MAKE THE MACHINE
 * IT RUNS ON WORSE.
 *
 * What happened. macOS hands each application ONE slot. Clicking a Dock icon does not
 * start a program, it activates whatever is already running under that application's
 * identity. Every browser this tool used to open was the person's own Google Chrome
 * binary — the same identity, `com.google.Chrome`. So when he clicked his own Chrome
 * icon, macOS dutifully woke one of our invisible instances instead, and nothing
 * appeared to happen. His browser stopped opening while our tool was running.
 *
 * The fix is not a flag. It is to open a DIFFERENT browser: Chrome for Testing, which
 * is the same engine under a different identity (`com.google.chrome.for.testing`) and
 * therefore a different slot, or a standalone Chromium, or Chrome's headless shell,
 * which has no application bundle at all and so cannot take a slot from anybody. His
 * everyday browser is the last resort, taken only when this machine has nothing else,
 * and the run says so out loud rather than quietly borrowing his.
 *
 * Four promises this file keeps, in the order they matter:
 *
 *   1. NEVER HIS BROWSER IF THERE IS ANY OTHER. And when there is not, say it.
 *   2. NEVER HIS PROFILE. A throwaway user-data-dir, made fresh, deleted after — never
 *      his cookies, his extensions, his open tabs. And never port 9333, which another
 *      session on this machine already owns.
 *   3. NOTHING WE OPENED OUTLIVES THE RUN. Every instance is registered the moment it
 *      starts. `closeEverything()` shuts them all. It also runs on a throw, on Ctrl-C,
 *      and on the way out of the process, where the last resort is a synchronous kill,
 *      because an asynchronous cleanup at `exit` never gets to run.
 *   4. NEVER KILL WHAT WE DID NOT START. His own Chrome may be open; so may another
 *      session's. Nothing is ever killed on a name match. It is killed only when its
 *      command line contains a throwaway profile path that this tool created, which
 *      no other program on the machine can be holding.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { StaysFixedError, isExpected } from '../core/errors.js';
import { findChrome, freePort, resolveElectronBinary } from '../drive/find.js';
import { waitForEndpoint } from '../drive/cdp.js';
import { keepOutput, stopProcess } from '../drive/browser.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Facts that are policy, not preference
// ---------------------------------------------------------------------------

/**
 * The one port this tool may never take. Another session on the owner's machine
 * drives a signed-in browser on 9333 and has done for months; binding it would
 * take his logged-in browser away from him mid-run. The operating system hands
 * out free ports for free — there is no reason ever to want a fixed one.
 */
export const PORT_NEVER_USE = 9333;

/**
 * Where every throwaway profile lives, and the only string this tool will kill
 * a process over. It is inside the temporary folder on purpose: nothing here is
 * meant to survive a reboot, and a leftover profile costs nothing.
 */
export const SCRATCH_ROOT = path.join(os.tmpdir(), 'staysfixed-browsers');

/** How long a browser gets to answer on its debugging port before we give up. */
const START_MS = 60_000;

/**
 * How long a `--version` probe gets. A browser that will not answer in this is not
 * usable, and doctor is the first call an agent makes — it must never be the slow one.
 */
const PROBE_MS = 5_000;

/** Politeness before SIGKILL, in milliseconds. */
const GRACE_MS = 3_000;

/**
 * The kinds of browser, best first, and why each one is ranked where it is.
 *
 * The ranking is about ONE question and nothing else: whose application slot does
 * this take? Not speed, not fidelity, not version. A browser that steals the
 * person's own is last however good it is.
 *
 * @type {{kind: BrowserKind, name: string, why: string}[]}
 */
const RANK = [
  {
    kind: 'chrome-for-testing',
    name: 'Chrome for Testing',
    why: 'The same engine as Chrome under a different identity, so opening it cannot take over the browser you use.',
  },
  {
    kind: 'chromium',
    name: 'Chromium',
    why: 'A separate application from your everyday browser, so opening it leaves yours alone.',
  },
  {
    kind: 'headless-shell',
    name: 'Chrome’s headless shell',
    why: 'Not an application at all — it has no icon and no window, so it cannot take a slot from anything. It can only run invisibly.',
  },
  {
    kind: 'given',
    name: 'the browser you named',
    why: 'You pointed at this one yourself, so it is used as asked.',
  },
  {
    kind: 'everyday',
    name: 'your everyday browser',
    why: 'Last resort. It shares an application slot with the browser you use, so while a check is running, clicking your own browser icon may wake this invisible copy instead of opening your window.',
  },
];

/** @typedef {'chrome-for-testing'|'chromium'|'headless-shell'|'given'|'everyday'} BrowserKind */

/**
 * One browser found on this machine.
 *
 * @typedef {object} BrowserFound
 * @property {BrowserKind} kind
 * @property {string} name          What a person would call it.
 * @property {string} binary        The executable, not the app folder.
 * @property {boolean} everyday     True when opening it competes with the browser the person uses.
 * @property {boolean} usable       It answered `--version` with a version. A file that exists is not a browser.
 * @property {string} [version]
 * @property {string} [broken]      Filled in when it is on disk but does not run, with what it said.
 * @property {boolean} [headlessOnly] It cannot show a window at all.
 * @property {string} why           Plain English: why this one is ranked where it is.
 */

/**
 * What this machine can open, and what it will open.
 *
 * @typedef {object} BrowserSurvey
 * @property {BrowserFound[]} found       Everything found, best first, usable and not.
 * @property {BrowserFound|null} chosen   What a run would open now.
 * @property {boolean} borrowingHis       True when the only choice is the person's own browser.
 * @property {string} note                One plain sentence, safe to repeat to a person.
 * @property {string|null} install        The exact command that would fix it, when one would.
 */

/**
 * One browser this tool has open right now.
 *
 * @typedef {object} OpenBrowser
 * @property {string} id
 * @property {BrowserFound} browser
 * @property {number} port
 * @property {string} endpoint            http://127.0.0.1:<port> — where its debugging port answers.
 * @property {string} webSocketDebuggerUrl
 * @property {string} userDataDir         Throwaway. Deleted on close.
 * @property {number|null} pid
 * @property {boolean} headless
 * @property {string[]} notes             Anything the caller should repeat, in plain English.
 * @property {() => Promise<void>} close
 */

/**
 * A browser some earlier run left behind, found by its throwaway profile.
 *
 * @typedef {object} Stray
 * @property {string} id
 * @property {number|null} pid
 * @property {boolean} running
 * @property {boolean} inUseByAnotherRun   A different Stays Fixed is alive and still owns this.
 * @property {number|null} owner           The process id of the run that opened it.
 * @property {string} userDataDir
 * @property {string} binary
 * @property {string} startedAt
 */

// ---------------------------------------------------------------------------
// Finding a browser that is not his
// ---------------------------------------------------------------------------

/**
 * Directories that hold a browser somebody downloaded FOR testing rather than
 * one they use. Anything found here is safe to drive; anything found in
 * /Applications or Program Files belongs to the person.
 *
 * @returns {string[]}
 */
function testingBrowserRoots() {
  const home = os.homedir();
  /** @type {string[]} */
  const roots = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Caches', 'ms-playwright'));
    roots.push(path.join(home, '.cache', 'puppeteer'));
  } else if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright'));
    roots.push(path.join(home, '.cache', 'puppeteer'));
  } else {
    roots.push(path.join(home, '.cache', 'ms-playwright'));
    roots.push(path.join(home, '.cache', 'puppeteer'));
  }
  return roots.filter((dir) => dir && exists(dir));
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @returns {string[]} entries, newest-looking first
 */
function entriesNewestFirst(dir) {
  /** @type {string[]} */
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  // Playwright names its folders `chromium-1234`. Sorting on the number rather
  // than the string is what stops `chromium-999` beating `chromium-1234`.
  return names.sort((a, b) => {
    const na = Number(/(\d+)\s*$/.exec(a)?.[1] ?? 0);
    const nb = Number(/(\d+)\s*$/.exec(b)?.[1] ?? 0);
    if (na !== nb) return nb - na;
    return b.localeCompare(a);
  });
}

/**
 * Every browser that is not the person's, found by walking the folders where
 * downloaded test browsers live. Nothing here is probed yet — that costs a
 * process each and only the ones we might actually use are worth it.
 *
 * @returns {{kind: BrowserKind, binary: string, headlessOnly?: boolean}[]}
 */
function testingBrowsers() {
  /** @type {{kind: BrowserKind, binary: string, headlessOnly?: boolean}[]} */
  const out = [];

  /**
   * @param {BrowserKind} kind
   * @param {string} binary
   * @param {boolean} [headlessOnly]
   */
  const take = (kind, binary, headlessOnly) => {
    if (binary && exists(binary) && !out.some((b) => b.binary === binary)) out.push({ kind, binary, headlessOnly });
  };

  for (const root of testingBrowserRoots()) {
    for (const entry of entriesNewestFirst(root)) {
      const dir = path.join(root, entry);
      // Playwright: chromium-<rev>/chrome-{mac-arm64,mac,linux,win}/...
      // Puppeteer:  chrome/<platform>-<version>/chrome-<platform>/...
      for (const inner of [dir, ...entriesNewestFirst(dir).map((name) => path.join(dir, name))]) {
        take('chrome-for-testing', path.join(inner, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'));
        take('chrome-for-testing', path.join(inner, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'));
        take('chromium', path.join(inner, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
        take('chrome-for-testing', path.join(inner, 'chrome-linux', 'chrome'));
        take('chrome-for-testing', path.join(inner, 'chrome-win', 'chrome.exe'));
        take('headless-shell', path.join(inner, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'), true);
        take('headless-shell', path.join(inner, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'), true);
        take('headless-shell', path.join(inner, 'chrome-headless-shell-linux64', 'chrome-headless-shell'), true);
        take('headless-shell', path.join(inner, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'), true);
        take('headless-shell', path.join(inner, 'chrome-linux', 'headless_shell'), true);
      }
    }
  }
  return out;
}

/**
 * Does this file actually run?
 *
 * A path that exists is not a browser. This machine had a half-downloaded Chrome
 * for Testing sitting in Playwright's cache: every file check said yes, and it
 * died on its first library load. Asking it its version is one cheap process and
 * it is the difference between "ready" and a run that fails ten minutes later.
 *
 * @param {string} binary
 * @returns {Promise<{ok: boolean, version?: string, why?: string}>}
 */
export async function probeBrowser(binary) {
  try {
    const { stdout, stderr } = await exec(binary, ['--version'], { timeout: PROBE_MS, maxBuffer: 1 << 20, windowsHide: true });
    const said = String(stdout || stderr).trim();
    const version = /\d+\.\d+\.\d+(\.\d+)?/.exec(said)?.[0];
    // It answered, but with no version in it. That is what a broken bundle does:
    // it exits zero and prints the library it could not load.
    if (!version) return { ok: false, why: said.split('\n')[0]?.slice(0, 200) || 'it printed nothing when asked its version' };
    return { ok: true, version };
  } catch (e) {
    const err = /** @type {{killed?: boolean, stderr?: string}} */ (Object(e));
    if (err.killed) return { ok: false, why: `it did not answer within ${Math.round(PROBE_MS / 1000)} seconds` };
    return { ok: false, why: String(err.stderr || (e instanceof Error ? e.message : e)).split('\n')[0].slice(0, 200) };
  }
}

/**
 * @param {BrowserKind} kind
 * @returns {{name: string, why: string}}
 */
function describeKind(kind) {
  const hit = RANK.find((r) => r.kind === kind);
  return hit ? { name: hit.name, why: hit.why } : { name: 'a browser', why: '' };
}

/**
 * Surveys already taken, keyed by what was asked for.
 *
 * A survey costs one process per candidate, and a run of forty journeys would
 * otherwise ask this machine the same question forty times. The answer cannot
 * change mid-run in any way that matters — nobody installs a browser while a
 * check is running — and `refresh` is there for the one case that does: the
 * agent installing one because doctor told it to.
 *
 * @type {Map<string, Promise<BrowserSurvey>>}
 */
const surveys = new Map();

/**
 * What this machine can open, best first, with the person's own browser last.
 *
 * @param {object} [opts]
 * @param {string} [opts.explicit]   A binary named in settings or on the command line.
 * @param {boolean} [opts.probe]     Ask each candidate its version. Default true.
 * @param {boolean} [opts.headless]  Default true. When false, the headless shell is dropped:
 *                                   it has no window to show and offering it would be a lie.
 * @param {boolean} [opts.refresh]   Look again rather than reusing the answer from earlier
 *                                   in this process. Use it right after installing one.
 * @returns {Promise<BrowserSurvey>}
 */
export async function surveyBrowsers(opts = {}) {
  const key = JSON.stringify([opts.explicit ?? process.env.STAYSFIXED_BROWSER ?? '', opts.probe !== false, opts.headless !== false]);
  if (opts.refresh) surveys.delete(key);
  const already = surveys.get(key);
  if (already) return await already;
  const pending = takeSurvey(opts);
  surveys.set(key, pending);
  try {
    return await pending;
  } catch (e) {
    surveys.delete(key);
    throw e;
  }
}

/**
 * @param {{explicit?: string, probe?: boolean, headless?: boolean}} opts
 * @returns {Promise<BrowserSurvey>}
 */
async function takeSurvey(opts) {
  const wantProbe = opts.probe !== false;
  const headless = opts.headless !== false;

  /** @type {{kind: BrowserKind, binary: string, headlessOnly?: boolean}[]} */
  const raw = [];

  const named = opts.explicit ?? process.env.STAYSFIXED_BROWSER;
  if (named) {
    let binary = named;
    try {
      binary = resolveElectronBinary(named);
    } catch {
      // Not a Mac app folder, or not there at all. Either way the probe below
      // is what decides, and it gives a better sentence than this would.
    }
    raw.push({ kind: 'given', binary });
  }

  raw.push(...testingBrowsers());

  // The person's own, last, and only ever as a fallback.
  const his = findChrome(process.env.STAYSFIXED_CHROME);
  if (his) raw.push({ kind: 'everyday', binary: his });

  /** @type {BrowserFound[]} */
  const found = [];
  for (const item of raw) {
    if (found.some((f) => f.binary === item.binary)) continue;
    if (item.headlessOnly && !headless) continue;
    const { name, why } = describeKind(item.kind);
    found.push({
      kind: item.kind,
      name: item.kind === 'given' ? `${name} (${path.basename(item.binary)})` : name,
      binary: item.binary,
      everyday: item.kind === 'everyday',
      usable: true,
      why,
      ...(item.headlessOnly ? { headlessOnly: true } : {}),
    });
  }

  // All at once. Six short-lived processes finish in the time one of them takes,
  // and doctor is the first call an agent makes: it must never be the slow one.
  if (wantProbe) {
    await Promise.all(
      found.map(async (entry) => {
        const answer = await probeBrowser(entry.binary);
        entry.usable = answer.ok;
        if (answer.version) entry.version = answer.version;
        if (!answer.ok) entry.broken = answer.why ?? 'it did not run';
      })
    );
  }

  const order = RANK.map((r) => r.kind);
  found.sort((a, b) => {
    if (a.usable !== b.usable) return a.usable ? -1 : 1;
    return order.indexOf(a.kind) - order.indexOf(b.kind);
  });

  const chosen = found.find((f) => f.usable) ?? null;
  const borrowingHis = chosen !== null && chosen.everyday;

  return {
    found,
    chosen,
    borrowingHis,
    note: noteFor(chosen, found, borrowingHis),
    install: chosen && !borrowingHis ? null : INSTALL_COMMAND,
  };
}

/**
 * The one command that turns "borrowing his browser" into "has its own". It is a
 * download and a package, nothing else — no licence, no account, no clicking.
 * That is why doctor reports it as something the agent does without asking.
 */
// One command, and it installs nothing into anybody's project.
//
// It used to be `npm install --save-dev playwright && npx playwright install chromium`, which
// puts a 150MB package into a stranger's dependencies to solve a problem this tool has already
// solved: the driver ships with the tool, and the only thing that can be missing is a browser.
// `npx` fetches the downloader for the length of one command and leaves nothing behind, and the
// browser it downloads lands in a shared folder outside every project, where `surveyBrowsers`
// looks and where it survives every reinstall.
export const INSTALL_COMMAND = 'npx playwright install chromium';

/**
 * @param {BrowserFound|null} chosen
 * @param {BrowserFound[]} found
 * @param {boolean} borrowingHis
 * @returns {string}
 */
function noteFor(chosen, found, borrowingHis) {
  const broken = found.filter((f) => !f.usable);
  const brokenNote = broken.length
    ? ` ${broken.length === 1 ? 'One browser was' : `${broken.length} browsers were`} on disk but would not run, so ${broken.length === 1 ? 'it was' : 'they were'} passed over: ${broken.map((b) => `${b.name} (${b.broken})`).join('; ')}.`
    : '';

  if (!chosen) {
    return `There is no browser on this machine that will run, so nothing that needs one can be checked.${brokenNote} This fixes it and needs nobody's permission: ${INSTALL_COMMAND}`;
  }
  if (borrowingHis) {
    return (
      `The only browser here is the one you use yourself (${chosen.binary}). It will be opened invisibly with a throwaway profile, so your own settings, cookies and tabs are never touched — but on a Mac it shares an application slot with your browser, so while a check is running, clicking your browser icon may wake this hidden copy instead of opening a window. ` +
      `This fixes it and takes one command: ${INSTALL_COMMAND}${brokenNote}`
    );
  }
  return `Checks open ${chosen.name}${chosen.version ? ` ${chosen.version}` : ''}, which is a separate application from the browser you use, so your own browser is never disturbed.${brokenNote}`;
}

// ---------------------------------------------------------------------------
// The register — what we have open, and what we left behind
// ---------------------------------------------------------------------------

/**
 * Everything open right now, in this process.
 * @type {Map<string, {id: string, pid: number|null, userDataDir: string, home: string, close: () => Promise<void>}>}
 */
const live = new Map();

/** Exit handlers are installed once, the first time a browser is opened. */
let guardsInstalled = false;

/**
 * Make sure nothing we opened outlives this process, however it ends.
 *
 * `exit` is the important one and the awkward one: by then nothing asynchronous
 * will ever run again, so the only thing left is a synchronous kill and a
 * synchronous delete. It is blunt, and being blunt at the very end is right —
 * the alternative is a browser still running after the person's command has
 * returned to their prompt.
 */
function installGuards() {
  if (guardsInstalled) return;
  guardsInstalled = true;

  process.on('exit', () => {
    for (const entry of live.values()) killNow(entry.pid, entry.home);
    live.clear();
  });

  for (const signal of /** @type {NodeJS.Signals[]} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
    /** @type {NodeJS.SignalsListener} */
    const onSignal = () => {
      for (const entry of live.values()) killNow(entry.pid, entry.home);
      live.clear();
      // Take away OUR listener and nobody else's. A library that calls
      // removeAllListeners has just deleted whatever the program around it was
      // going to do about Ctrl-C, which is not this file's decision to make.
      process.off(signal, onSignal);
      // And only finish the job if nothing else was listening. If something was,
      // it owns what happens next; a Ctrl-C that tidies up and then does not stop
      // is its own kind of bug, and so is one that stops a shutdown halfway.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
}

/**
 * The last-resort cleanup: no promises, no awaiting, no politeness.
 * @param {number|null} pid
 * @param {string} home
 */
function killNow(pid, home) {
  if (pid) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone. That is the outcome we wanted.
    }
  }
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    // A profile left in the temporary folder is untidy, not harmful.
  }
}

// ---------------------------------------------------------------------------
// Opening one
// ---------------------------------------------------------------------------

/**
 * The flags, and what each group is for.
 *
 * Every one of these removes a reason two runs of the same build could disagree
 * for a cause that has nothing to do with the code. They are deliberately close
 * to the version 1 list — that list was tuned against real pictures — with the
 * profile and the port made non-negotiable here rather than optional there.
 *
 * @param {object} ctx
 * @param {number|null} ctx.port   Null when something else will choose how to talk to it.
 * @param {string} ctx.userDataDir
 * @param {boolean} ctx.headless
 * @param {{width: number, height: number, deviceScaleFactor: number}} ctx.viewport
 * @param {string[]} ctx.extra
 * @returns {string[]}
 */
function argsFor(ctx) {
  /** @type {string[]} */
  const args = [];
  if (ctx.headless) args.push('--headless=new');
  if (ctx.port !== null) {
    args.push(
      `--remote-debugging-port=${ctx.port}`,
      // Node's WebSocket sends no Origin header and modern Chrome refuses an
      // unknown one. On a throwaway browser with a throwaway profile there is
      // nothing here for anybody to reach.
      '--remote-allow-origins=*'
    );
  }
  args.push(`--user-data-dir=${ctx.userDataDir}`);

  // Pixels land in the same place run after run.
  args.push(
    `--force-device-scale-factor=${ctx.viewport.deviceScaleFactor}`,
    '--force-color-profile=srgb',
    '--font-render-hinting=none',
    '--disable-lcd-text',
    '--disable-font-subpixel-positioning',
    '--disable-gpu',
    '--hide-scrollbars',
    '--disable-smooth-scrolling',
    '--force-prefers-reduced-motion'
  );

  // Nothing pops up, and the browser itself talks to nobody. The second half
  // matters more than it looks: without it a run depends on somebody else's
  // server being awake.
  args.push(
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--metrics-recording-only',
    '--disable-client-side-phishing-detection',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain',
    '--mute-audio',
    '--disable-notifications',
    '--deny-permission-prompts'
  );

  // A hidden window counts as backgrounded, and Chrome slows backgrounded pages
  // down. That turns "wait for the list to load" into a flaky timeout.
  args.push('--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-ipc-flooding-protection', '--disable-dev-shm-usage');

  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');

  args.push(`--window-size=${Math.round(ctx.viewport.width)},${Math.round(ctx.viewport.height)}`);
  args.push(...ctx.extra);
  // A blank page on purpose: the new-tab page talks to Google and looks
  // different depending on who is signed in.
  args.push('about:blank');
  return args;
}

/**
 * A sortable, unique name for one opened browser. It is also the folder name, so
 * a person listing the temporary folder can see when each one was started.
 * @returns {string}
 */
function reservationId() {
  return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex');
}

/**
 * The record that makes a crashed run's browser findable afterwards.
 *
 * Written before the browser is known to be up, on purpose: a browser that hangs
 * while starting is exactly the one somebody gives up on, and it has to still be
 * findable by `staysfixed browsers --clean` after they do.
 *
 * @param {string} home
 * @param {{id: string, pid: number|null, binary: string, userDataDir: string, port: number|null, startedAt: string, owner: number}} record
 * @returns {Promise<void>}
 */
async function writeRecord(home, record) {
  await fsp.writeFile(path.join(home, 'open.json'), JSON.stringify(record, null, 2)).catch(() => {});
}

/**
 * What the caller has to repeat to a person, when there is anything to repeat.
 *
 * Only ever about borrowing their own browser, because that is the only thing
 * this tool does that a person could notice while it runs.
 *
 * @param {BrowserFound} chosen
 * @param {boolean} headless   What the caller asked for, not what it will get.
 * @returns {string[]}
 */
function notesFor(chosen, headless) {
  if (!chosen.everyday) return [];
  /** @type {string[]} */
  const notes = [
    `This run is using your own browser (${chosen.binary}) because it is the only one here. Your profile is untouched — it runs on a throwaway one — but on a Mac it shares an application slot with your browser, so clicking your browser icon while this runs may wake this hidden copy instead of opening a window. One command fixes it for good: ${INSTALL_COMMAND}`,
  ];
  if (!headless) {
    // A VISIBLE copy of his own browser is the incident itself. It is downgraded
    // rather than refused, because refusing would stop a check that is otherwise
    // fine — and it says what it did instead of doing it quietly.
    notes.push('It was asked to open a visible window and will run invisibly instead, because a visible copy of your own browser is exactly what took your browser away from you before.');
  }
  return notes;
}

/**
 * A browser this tool has reserved but is letting something else start.
 *
 * @typedef {object} Reservation
 * @property {string} id
 * @property {BrowserFound} browser       Which browser to open. Never the person's, if there is any other.
 * @property {string} userDataDir         The throwaway profile to open it with.
 * @property {string[]} args              The hygiene flags, with no debugging port in them.
 * @property {boolean} headless           What it must actually run as, which is not always what was asked for.
 * @property {string[]} notes             Anything the caller has to repeat, in plain English.
 * @property {(stop: () => Promise<void>, pid?: number|null) => void} startedBy
 *           Call this the moment the browser is open, handing over how to close it and its
 *           process id. From then on it is covered by everything below: closeEverything,
 *           the exit and Ctrl-C guards, and `staysfixed browsers --clean`.
 * @property {() => Promise<void>} release   Give the reservation back without ever opening anything.
 */

/**
 * Reserve a browser for something else to start.
 *
 * Playwright wants to launch the browser itself — it is how it gets its own
 * protocol client, its route interception and its ARIA snapshots — and forcing it
 * through {@link openBrowser} would mean giving all that up. So the choice, the
 * throwaway profile, the flags and the bookkeeping stay here, and only the launch
 * itself moves. That is the important half: whatever starts the process, the
 * promises about the person's machine are the same ones, kept in the same place.
 *
 * The one thing a caller MUST do is call `startedBy` as soon as the browser is
 * open. A browser nobody registered is a browser nothing will ever close.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.headless]
 * @param {string} [opts.explicit]
 * @param {{width?: number, height?: number, deviceScaleFactor?: number}} [opts.viewport]
 * @param {BrowserSurvey} [opts.survey]
 * @returns {Promise<Reservation>}
 */
export async function reserveBrowser(opts = {}) {
  const headless = opts.headless !== false;
  const survey = opts.survey ?? (await surveyBrowsers({ explicit: opts.explicit, headless }));
  const chosen = survey.chosen;
  if (!chosen) {
    throw new StaysFixedError('There is no browser on this machine that Stays Fixed can open.', { hint: survey.note });
  }

  installGuards();

  const id = reservationId();
  const home = path.join(SCRATCH_ROOT, id);
  const userDataDir = path.join(home, 'profile');
  await fsp.mkdir(userDataDir, { recursive: true });

  const runHeadless = chosen.everyday ? true : headless;
  const notes = notesFor(chosen, headless);
  const viewport = { width: 1280, height: 800, deviceScaleFactor: 1, ...(opts.viewport ?? {}) };
  // No debugging port: whatever starts the browser will pick its own way of
  // talking to it, and a port we do not own is a port we must not name.
  const args = argsFor({ port: null, userDataDir, headless: runHeadless, viewport, extra: [] });

  await writeRecord(home, { id, pid: null, binary: chosen.binary, userDataDir, port: null, startedAt: new Date().toISOString(), owner: process.pid });

  let handedOver = false;
  /** @type {Promise<void>|null} */
  let closing = null;

  /** @param {() => Promise<void>} stop @param {number|null} [pid] */
  const startedBy = (stop, pid = null) => {
    handedOver = true;
    void writeRecord(home, { id, pid, binary: chosen.binary, userDataDir, port: null, startedAt: new Date().toISOString(), owner: process.pid });
    const close = () => {
      closing ??= (async () => {
        live.delete(id);
        await stop().catch(() => {});
        await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
      })();
      return closing;
    };
    live.set(id, { id, pid, userDataDir, home, close });
  };

  const release = async () => {
    if (handedOver) {
      const entry = live.get(id);
      if (entry) await entry.close();
      return;
    }
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  };

  return { id, browser: chosen, userDataDir, args, headless: runHeadless, notes, startedBy, release };
}

/**
 * Open a browser, register it, and hand back where to talk to it.
 *
 * It hands back an endpoint rather than a driven page on purpose. The web lane
 * drives with Playwright and the Electron lane drives over the debugging socket
 * directly; both need the same hygiene and neither should own it, so this owns
 * the process and they own the driving.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.headless]        Default true.
 * @param {string} [opts.explicit]         A specific binary to use.
 * @param {{width?: number, height?: number, deviceScaleFactor?: number}} [opts.viewport]
 * @param {string[]} [opts.args]           Extra command line flags.
 * @param {Record<string, string>} [opts.env]
 * @param {string} [opts.timezone]         IANA zone forced on the process before it starts.
 * @param {string} [opts.locale]           BCP-47 locale forced on the process before it starts.
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.startTimeoutMs]
 * @param {BrowserSurvey} [opts.survey]    A survey already taken, so a run of many journeys
 *                                         does not re-probe the machine for every one.
 * @returns {Promise<OpenBrowser>}
 */
export async function openBrowser(opts = {}) {
  const headless = opts.headless !== false;
  const survey = opts.survey ?? (await surveyBrowsers({ explicit: opts.explicit, headless }));
  const chosen = survey.chosen;

  if (!chosen) {
    throw new StaysFixedError('There is no browser on this machine that Stays Fixed can open.', {
      hint: `${survey.note}\nOr point at one you already have with STAYSFIXED_BROWSER=/path/to/the/browser.`,
    });
  }
  if (chosen.headlessOnly && !headless) {
    throw new StaysFixedError(`${chosen.name} cannot show a window, and this run asked for a visible one.`, {
      hint: `Install a full browser for testing and it will be used instead: ${INSTALL_COMMAND}`,
    });
  }

  installGuards();

  const id = reservationId();
  const home = path.join(SCRATCH_ROOT, id);
  const userDataDir = path.join(home, 'profile');
  await fsp.mkdir(userDataDir, { recursive: true });

  let port = await freePort();
  if (port === PORT_NEVER_USE) port = await freePort();
  if (port === PORT_NEVER_USE) {
    throw new StaysFixedError(`The operating system offered port ${PORT_NEVER_USE}, which Stays Fixed will not take.`, {
      hint: 'Another session on this machine drives a signed-in browser on that port. Try the command again.',
    });
  }

  const notes = notesFor(chosen, headless);

  const viewport = { width: 1280, height: 800, deviceScaleFactor: 1, ...(opts.viewport ?? {}) };
  const runHeadless = chosen.everyday ? true : headless;
  const args = argsFor({ port, userDataDir, headless: runHeadless, viewport, extra: opts.args ?? [] });

  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, ...(opts.env ?? {}) };
  if (opts.timezone) env.TZ = opts.timezone;
  if (opts.locale) {
    const posix = opts.locale.replace('-', '_');
    env.LANG = `${posix}.UTF-8`;
    env.LC_ALL = `${posix}.UTF-8`;
  }

  const child = spawn(chosen.binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal });
  const output = keepOutput(child);

  await writeRecord(home, { id, pid: child.pid ?? null, binary: chosen.binary, userDataDir, port, startedAt: new Date().toISOString(), owner: process.pid });

  /** @type {Promise<void>|null} */
  let closing = null;
  const close = () => {
    closing ??= (async () => {
      live.delete(id);
      await stopProcess(child, GRACE_MS);
      await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
    })();
    return closing;
  };

  live.set(id, { id, pid: child.pid ?? null, userDataDir, home, close });

  const diedEarly = /** @type {Promise<never>} */ (
    new Promise((_resolve, reject) => {
      child.once('error', (cause) => {
        reject(new StaysFixedError(`Could not run the browser at ${chosen.binary}.`, { hint: survey.note, cause }));
      });
      child.once('exit', (code, signal) => {
        reject(
          new StaysFixedError(`The browser quit before it was ready (${signal ? `signal ${signal}` : `exit code ${code}`}).`, {
            hint: output() ? `The last thing it said:\n${output()}` : undefined,
          })
        );
      });
    })
  );
  // Quitting later, on purpose, must not crash the process with an unhandled
  // rejection. This catch does not stop the race below from seeing it.
  diedEarly.catch(() => {});

  const endpoint = `http://127.0.0.1:${port}`;
  try {
    /** @type {any} */
    const version = await Promise.race([waitForEndpoint(endpoint, { timeoutMs: opts.startTimeoutMs ?? START_MS, intervalMs: 100 }), diedEarly]);
    const wsUrl = version?.webSocketDebuggerUrl;
    if (typeof wsUrl !== 'string' || wsUrl === '') {
      throw new StaysFixedError('The browser answered but did not offer a debugging connection.');
    }
    return { id, browser: chosen, port, endpoint, webSocketDebuggerUrl: wsUrl, userDataDir, pid: child.pid ?? null, headless: runHeadless, notes, close };
  } catch (e) {
    await close();
    if (isExpected(e)) throw e;
    throw new StaysFixedError('The browser started but never answered, so nothing could be looked at.', {
      hint: output() ? `The last thing it said:\n${output()}` : survey.note,
      cause: e,
    });
  }
}

/**
 * How many browsers this process has open. For the run loop, and for a test that
 * wants to prove none were left behind.
 * @returns {number}
 */
export function openBrowserCount() {
  return live.size;
}

/**
 * Close every browser this process opened.
 *
 * The run loop calls this in its `finally`, so it runs on a clean finish, on a
 * throw and on a cancel. It never throws: cleanup that can fail is cleanup that
 * gets skipped.
 *
 * @returns {Promise<{closed: number}>}
 */
export async function closeEverything() {
  const all = [...live.values()];
  await Promise.all(all.map((entry) => entry.close().catch(() => {})));
  live.clear();
  return { closed: all.length };
}

// ---------------------------------------------------------------------------
// Leftovers from a run that crashed
// ---------------------------------------------------------------------------

/**
 * Browsers left behind by a run that died before it could tidy up.
 *
 * Found by the throwaway profile folder, never by name. A folder under
 * {@link SCRATCH_ROOT} could only have been made by this tool, which is what
 * makes it safe to act on — a browser is never touched because it looks like
 * one of ours.
 *
 * @returns {Promise<Stray[]>}
 */
export async function findStrays() {
  /** @type {Stray[]} */
  const out = [];
  /** @type {string[]} */
  let ids = [];
  try {
    ids = await fsp.readdir(SCRATCH_ROOT);
  } catch {
    return out;
  }
  for (const id of ids) {
    if (live.has(id)) continue;
    const home = path.join(SCRATCH_ROOT, id);
    /** @type {any} */
    let record = null;
    try {
      record = JSON.parse(await fsp.readFile(path.join(home, 'open.json'), 'utf8'));
    } catch {
      record = null;
    }
    const pid = typeof record?.pid === 'number' ? record.pid : null;
    const owner = typeof record?.owner === 'number' ? record.owner : null;
    const userDataDir = typeof record?.userDataDir === 'string' ? record.userDataDir : path.join(home, 'profile');
    out.push({
      id,
      pid,
      running: pid !== null && (await isOurs(pid, userDataDir)),
      // A leftover is only a leftover if the run that opened it is gone. Several
      // Stays Fixed runs share this machine — on the owner's Mac, several agents
      // do at once — and one of them clearing up must never reach into another
      // one's live check and close the browser out from under it.
      inUseByAnotherRun: owner !== null && owner !== process.pid && isAlive(owner),
      owner,
      userDataDir,
      binary: typeof record?.binary === 'string' ? record.binary : '(not recorded)',
      startedAt: typeof record?.startedAt === 'string' ? record.startedAt : '(not recorded)',
    });
  }
  return out;
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is this process alive, AND is it one of ours?
 *
 * Both halves are required and the second is the important one. A process id is
 * recycled by the operating system within hours; killing on a stale id alone
 * would eventually kill something innocent. So the id has to still be running a
 * command line containing a throwaway profile path that this tool created, and
 * nothing else on the machine can be holding one of those.
 *
 * @param {number} pid
 * @param {string} userDataDir
 * @returns {Promise<boolean>}
 */
async function isOurs(pid, userDataDir) {
  if (!userDataDir.startsWith(SCRATCH_ROOT)) return false;
  if (!isAlive(pid)) return false;
  if (process.platform === 'win32') {
    // No cheap command line read here. The profile folder is under our own
    // scratch root and the record was written by us, which is the same
    // guarantee arrived at a different way.
    return true;
  }
  try {
    const { stdout } = await exec('ps', ['-o', 'command=', '-p', String(pid)], { timeout: PROBE_MS, windowsHide: true });
    return String(stdout).includes(userDataDir);
  } catch {
    return false;
  }
}

/**
 * Quit everything an earlier run left behind, and delete its throwaway profiles.
 *
 * This is what `staysfixed browsers --clean` runs. It is safe to run at any
 * time, including while a check is in progress: anything this process has open
 * is skipped, and anything else had to prove it was ours before being touched.
 *
 * @returns {Promise<{quit: Stray[], swept: Stray[], busy: Stray[], left: Stray[]}>}
 */
export async function cleanStrays() {
  const strays = await findStrays();
  /** @type {Stray[]} */
  const quit = [];
  /** @type {Stray[]} */
  const swept = [];
  /** @type {Stray[]} */
  const busy = [];
  /** @type {Stray[]} */
  const left = [];

  for (const stray of strays) {
    if (stray.inUseByAnotherRun) {
      // Somebody else's check is still going. Their browser is not a leftover,
      // and closing it would break their run for the sake of tidiness.
      busy.push(stray);
      continue;
    }
    if (stray.running && stray.pid !== null) {
      try {
        process.kill(stray.pid, 'SIGTERM');
      } catch {
        // It went away between being listed and being asked. Fine.
      }
      await waitForGone(stray.pid, GRACE_MS);
      try {
        process.kill(stray.pid, 'SIGKILL');
      } catch {
        // Already gone, which is what we wanted.
      }
      quit.push(stray);
    } else {
      swept.push(stray);
    }
    try {
      await fsp.rm(path.join(SCRATCH_ROOT, stray.id), { recursive: true, force: true });
    } catch {
      left.push(stray);
    }
  }
  return { quit, swept, busy, left };
}

/**
 * @param {number} pid
 * @param {number} ms
 * @returns {Promise<void>}
 */
async function waitForGone(pid, ms) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > until) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/**
 * The survey, said out loud. Used by doctor and by the command below, so an
 * agent and a person are never told different things about the same machine.
 *
 * @param {BrowserSurvey} survey
 * @returns {string[]}
 */
export function describeBrowsers(survey) {
  /** @type {string[]} */
  const lines = [];
  if (survey.found.length === 0) {
    lines.push('No browser was found on this machine at all.');
  } else {
    for (const b of survey.found) {
      const mark = b === survey.chosen ? '→' : ' ';
      const state = b.usable ? b.version ?? 'runs' : `will not run: ${b.broken ?? 'unknown'}`;
      lines.push(`${mark} ${b.name} — ${state}`);
      lines.push(`    ${b.binary}`);
    }
  }
  lines.push('');
  lines.push(survey.note);
  return lines;
}

// ---------------------------------------------------------------------------
// staysfixed browsers
// ---------------------------------------------------------------------------

/**
 * The command entry, in exactly the shape `src/v2/cli.js` already uses for
 * `check` and `doctor`. Wiring it up is one line there:
 *
 *     import { BROWSERS_COMMAND } from './browsers.js';
 *     ... browsers: BROWSERS_COMMAND, ...
 *
 * It is defined here rather than there because everything it does — knowing
 * which browser would be opened, and knowing which leftovers are safe to kill —
 * is this file's knowledge, and splitting it would put the safety rule in one
 * file and the kill in another.
 */
export const BROWSERS_COMMAND = {
  summary: 'Which browser checks open, and a way to clear up any this tool left running.',
  usage: 'staysfixed browsers [--clean] [--json]',
  describe:
    'Checks never open the browser you use if there is any other on this machine, and\nnever your profile. This says which one they would open and why, and lists any\nthat an interrupted run left behind.\n\n--clean quits those leftovers and deletes their throwaway profiles. It only ever\ntouches something started by this tool: anything it quits had to be running from\na scratch profile this tool created, so your own browser and anybody else’s\ncannot be caught by it.',
  options: /** @type {[string, string][]} */ ([
    ['--clean', 'Quit anything an earlier run left behind, and delete its throwaway profile.'],
    ['--json', 'The same answer as one object, and no prose. For agents.'],
  ]),
  examples: ['staysfixed browsers', 'staysfixed browsers --clean'],
  spec: { booleans: ['clean', 'json'] },
  load: async () => ({ run: runBrowsersCommand }),
};

/**
 * @param {{bool: (name: string) => boolean}} ctx
 * @returns {Promise<number>}
 */
export async function runBrowsersCommand(ctx) {
  const { say, ok, warn, blank, heading, paint, setLogLevel } = await import('../core/log.js');
  const { EXIT } = await import('../core/errors.js');

  const clean = ctx.bool('clean');
  const survey = await surveyBrowsers();
  const strays = clean ? null : await findStrays();
  const cleaned = clean ? await cleanStrays() : null;

  if (ctx.bool('json')) {
    setLogLevel({ quiet: true });
    process.stdout.write(
      JSON.stringify(
        {
          chosen: survey.chosen,
          borrowingYourOwnBrowser: survey.borrowingHis,
          note: survey.note,
          install: survey.install,
          found: survey.found,
          leftBehind: strays ?? [...(cleaned?.quit ?? []), ...(cleaned?.swept ?? [])],
          cleaned: cleaned
            ? { quit: cleaned.quit.length, profilesRemoved: cleaned.quit.length + cleaned.swept.length, leftAloneBecauseAnotherRunOwnsThem: cleaned.busy.length, couldNotRemove: cleaned.left.length }
            : null,
        },
        null,
        2
      ) + '\n'
    );
    return EXIT.ok;
  }

  heading('Stays Fixed — the browser checks open');
  blank();
  for (const line of describeBrowsers(survey)) say(survey.borrowingHis && line === survey.note ? paint.yellow(line) : line);
  blank();

  if (cleaned) {
    if (cleaned.quit.length === 0 && cleaned.swept.length === 0) {
      ok('Nothing was left behind. No browser from an earlier run is still running.');
    } else {
      if (cleaned.quit.length > 0) ok(`Quit ${cleaned.quit.length} browser${cleaned.quit.length === 1 ? '' : 's'} an earlier run left running.`);
      if (cleaned.swept.length > 0) ok(`Removed ${cleaned.swept.length} throwaway profile${cleaned.swept.length === 1 ? '' : 's'} whose browser had already stopped.`);
      for (const l of cleaned.left) warn(`Could not remove ${l.userDataDir} — delete it by hand when you get a moment.`);
    }
    if (cleaned.busy.length > 0) {
      say(
        paint.grey(
          `  ${cleaned.busy.length} browser${cleaned.busy.length === 1 ? '' : 's'} left alone: another Stays Fixed run is still using ${cleaned.busy.length === 1 ? 'it' : 'them'}. ${cleaned.busy.length === 1 ? 'It is not a leftover' : 'They are not leftovers'} and closing ${cleaned.busy.length === 1 ? 'it' : 'them'} would break that run.`
        )
      );
    }
  } else if (strays && strays.length > 0) {
    const running = strays.filter((s) => s.running);
    warn(
      running.length > 0
        ? `${running.length} browser${running.length === 1 ? '' : 's'} from an earlier run ${running.length === 1 ? 'is' : 'are'} still running. Run \`staysfixed browsers --clean\` to quit ${running.length === 1 ? 'it' : 'them'}.`
        : `${strays.length} throwaway profile${strays.length === 1 ? '' : 's'} from an earlier run ${strays.length === 1 ? 'is' : 'are'} still on disk. Run \`staysfixed browsers --clean\` to remove ${strays.length === 1 ? 'it' : 'them'}.`
    );
  } else {
    ok('Nothing was left behind by an earlier run.');
  }
  blank();
  return EXIT.ok;
}
