/**
 * One run of a desktop app, genuinely alone — and proved gone afterwards.
 *
 * This file exists because of a real day lost. On 2026-08-28 two copies of one desktop app
 * were running on one machine, sharing one identity, and every time either of them
 * reconnected it pushed the other one off. The symptom was "my phone will not stay
 * connected". The cause was two instances that each believed they were the only one.
 *
 * A checking tool that opens the same app twice — a reference build and a changed build,
 * minutes apart — walks straight into that. Two instances of one app collide on FIVE things
 * and every one of them is silent:
 *
 *   1. the single-instance lock       the second copy quits, and quitting looks like a crash
 *   2. the user data directory        settings, databases and lock files written by both
 *   3. the debugging port             the second copy attaches to the FIRST copy's window
 *   4. whatever identity it registers  a relay slot, an account, a device id
 *   5. lock files left behind         a copy that died leaves them, the next copy sees them
 *
 * So every run gets its own of all five, and — the part that matters more — the teardown is
 * PROVED rather than assumed. `release` does not return until the process is gone, until
 * nothing on this machine is still holding the run's own folder, and until the ports it took
 * are free again. If it cannot prove that, it says so in plain English instead of quietly
 * letting the next run start on top of the last one.
 *
 * THE ONE RULE THAT IS NEVER BENT: only ever kill what this tool started. Somebody's real
 * app is very probably open on this machine right now. Everything killed here is either a
 * process we spawned ourselves, or a process whose command line names OUR OWN scratch
 * folder — which no other process on earth can be pointing at, because we made the folder
 * and its name has a random part.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

// Every wait in this file has to have a limit on it and every limit has to produce a sentence,
// so the pieces that do that live in one place rather than three. `process.js` is where they
// are, because it is the file that already owns running a program and waiting for it, and
// `electron.js` already reads its folder-watching out of there too.
import { letGoOf, withLimit } from './process.js';

const execFileAsync = promisify(execFile);

/**
 * The one port a person's own paired browser lives on. Never taken, never probed, never
 * killed. It is written down here rather than left to chance because "the tool stole the
 * port my browser was on" is exactly the kind of damage nobody connects back to the tool.
 */
export const PORTS_THAT_ARE_NOT_OURS = new Set([9333]);

/**
 * Ports handed out in this process, so two isolations never pick the same one.
 * @type {Set<number>}
 */
const handedOut = new Set();

/**
 * Every isolation still alive, so nothing survives a check that threw.
 * @type {Map<string, {isolation: Isolation, closers: (() => Promise<void>|void)[], children: import('node:child_process').ChildProcess[]}>}
 */
const alive = new Map();

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Saying out loud that something was opened
// ---------------------------------------------------------------------------

/**
 * What this tool opened, and enough about it to be able to look after it.
 *
 * The screen is the reason this exists. A check that starts a desktop app has to be
 * able to say, afterwards and to something outside this file: THAT application, with
 * THAT unix id, is mine — I opened it, I will close it, and while it is up it does
 * not get to keep taking the screen from whoever is using this machine. Nothing else
 * on the machine can work that out for itself: a scratch copy of an app and the
 * person's own copy of the same app are indistinguishable from the outside.
 *
 * @typedef {object} OpenedApp
 * @property {string} name     The application's name, as macOS reports it.
 * @property {number} pid
 * @property {string} binary   What was actually run.
 * @property {string} label    Which build it is, in plain English.
 */

/**
 * Everybody who wants to be told. A Set rather than a single hook because a check, a
 * panel and a test can all reasonably want to know at once.
 * @type {Set<(app: OpenedApp) => void>}
 */
const told = new Set();

/**
 * Be told whenever this tool opens a desktop app.
 *
 * Called before anything is started, and the listener runs the moment the process
 * exists — before the app has drawn a window, which is what makes it early enough to
 * be useful. A listener that throws is ignored: nothing that merely wants to WATCH a
 * run may break one.
 *
 * @param {(app: OpenedApp) => void} listener
 * @returns {() => void} stop being told
 */
export function onAppStarted(listener) {
  told.add(listener);
  return () => {
    told.delete(listener);
  };
}

/**
 * @param {OpenedApp} app
 * @returns {void}
 */
function announce(app) {
  for (const listener of [...told]) {
    try {
      listener(app);
    } catch {
      // Watching is never allowed to be the reason a run fails.
    }
  }
}

/**
 * The application name macOS will use for this binary.
 *
 * A Mac app is run through the executable buried inside its bundle —
 * `Foo.app/Contents/MacOS/Foo` — but everything that talks about windows and the
 * foreground talks about "Foo". The bundle is what to read: the executable inside it
 * is often called something else entirely, and for a development build it is called
 * `Electron`.
 *
 * @param {string} binary
 * @returns {string}
 */
export function appNameFor(binary) {
  const text = String(binary ?? '');
  // Both separators, not just this machine's. A path is a fact about the machine it came
  // from, and this one is asked about a Mac app bundle — so on Windows, where `path.sep` is a
  // backslash, `/Applications/Widget.app/Contents/MacOS/Widget` did not split at all and the
  // app was announced to the person's screen as "Widget" only by luck, or as the wrong name
  // when the two differ. Measured on a real Windows 11 machine on 2026-08-31, where it
  // answered "Electron" for an app called Terminal Deck.
  const parts = text.split(/[\\/]/);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i].toLowerCase().endsWith('.app')) return parts[i].slice(0, -4);
  }
  // The last part of the same split, rather than `path.basename`, so the whole function reads
  // a path the same way from end to end. `path.basename` only knows this machine's separator,
  // and half a function that understands both is worse than either.
  const base = parts[parts.length - 1] ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

/**
 * Everything one run of one app is allowed to touch.
 *
 * @typedef {object} Isolation
 * @property {string} id               Short, unique to this run. Appears in every folder name.
 * @property {string} label            Plain English, for messages: 'your change', 'the build you shipped'.
 * @property {string} dir              The run's own folder. Everything below lives inside it.
 * @property {string} userDataDir      What the app will believe is its settings folder.
 * @property {string} homeDir          What the app will believe is the home folder.
 * @property {string} tmpDir
 * @property {string} cacheDir
 * @property {string} crashDir
 * @property {number} debugPort        Where the window can be driven from.
 * @property {number} inspectPort      Where the main process can be read from.
 * @property {string} identity         A name for this run, for apps that register one
 *                                     somewhere — a relay slot, a device id, an account.
 * @property {string[]} args           Command line flags that put all of that into force.
 * @property {Record<string, string>} env   Environment that does the same for anything
 *                                     the flags do not cover.
 * @property {(close: () => Promise<void>|void) => void} closeFirst
 *                                     Register something that must be hung up BEFORE the
 *                                     app is asked to quit. A debugger still attached
 *                                     holds the app open — measured, not guessed.
 * @property {(child: import('node:child_process').ChildProcess) => void} own
 *                                     Register a process this run started.
 * @property {() => void} [markReleased]
 *                                     Told by the teardown. After it, anything registered
 *                                     through `closeFirst` or `own` is closed or stopped on
 *                                     arrival instead of being added to a list nobody reads
 *                                     again — an abandoned open can still finish connecting
 *                                     after the sweep, and one live socket holds the tool open.
 * @property {string[]} notes          Plain English, for the run's own report.
 */

/**
 * What actually happened when a run was torn down. Returned rather than logged, because
 * "the last one is definitely gone" is a claim the next run depends on.
 *
 * @typedef {object} TeardownReport
 * @property {boolean} proved          True only when nothing is left: no process, no holder
 *                                     of the folder, both ports free again.
 * @property {boolean} askedNicely     The app was asked to quit and did.
 * @property {boolean} hadToInsist     It ignored being asked and was killed.
 * @property {number[]} strays         Other processes that were still pointing at this run's
 *                                     own folder, and were stopped.
 * @property {number} ms               How long the whole teardown took.
 * @property {string} why              One plain sentence a person or an agent can read.
 * @property {string[]} leftBehind     Anything that could not be cleaned up. Empty is the
 *                                     normal case and the only one that counts as proved.
 */

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * Is anything listening here?
 *
 * Asked by trying to LISTEN rather than by trying to connect. A port with a half-dead
 * process still bound to it refuses a connection and still cannot be listened on, and it is
 * the second answer that decides whether the next run can start.
 *
 * @param {number} port
 * @returns {Promise<boolean>} true when the port is free
 */
export function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const done = (/** @type {boolean} */ answer) => {
      server.removeAllListeners();
      try { server.close(); } catch { /* already closed */ }
      resolve(answer);
    };
    server.once('error', () => done(false));
    server.once('listening', () => done(true));
    try { server.listen(port, '127.0.0.1'); } catch { done(false); }
  });
}

/**
 * A port nobody else is on, and nobody else in this process is about to be on.
 *
 * The operating system is asked for a free one rather than a number being guessed, and the
 * answer is remembered so that reserving two isolations in a row cannot hand out the same
 * number twice before either of them has actually bound it.
 *
 * @returns {Promise<number>}
 */
export async function takePort() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = await /** @type {Promise<number>} */ (new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const chosen = address && typeof address === 'object' ? address.port : 0;
        server.close(() => (chosen ? resolve(chosen) : reject(new Error('no port'))));
      });
    }));
    if (PORTS_THAT_ARE_NOT_OURS.has(port) || handedOut.has(port)) continue;
    handedOut.add(port);
    return port;
  }
  throw new Error('Could not find a free port to talk to the app on after forty tries.');
}

// ---------------------------------------------------------------------------
// Who is holding what
// ---------------------------------------------------------------------------

/**
 * The whole process table, on Windows: who is running, who started them, and with what.
 *
 * This is Windows' `ps -axo pid=,ppid=,command=`. There is no `ps` there, and the two callers
 * below used to hand back an empty list rather than an answer — which reads exactly like
 * "nothing is running", the most dangerous wrong answer either of them could give. PowerShell
 * is on every Windows machine and answers all three columns in one call; JSON rather than a
 * table, because a command line is full of spaces and quotes and columns cannot survive it.
 *
 * An unanswerable question still returns an empty list, because a sweep that cannot be done is
 * not a reason to fail somebody's check — but it is now the rare case rather than every case.
 *
 * @returns {Promise<{pid: number, ppid: number, command: string}[]>}
 */
async function windowsProcessTable() {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress -Depth 2',
      ],
      { timeout: 20_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    );
    const text = String(stdout).trim();
    if (text === '') return [];
    const parsed = JSON.parse(text);
    // One process comes back as an object rather than a list of one, which is PowerShell being
    // helpful in a way that would otherwise crash the loop below.
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((row) => ({
        pid: Number(row?.ProcessId ?? 0),
        ppid: Number(row?.ParentProcessId ?? 0),
        command: String(row?.CommandLine ?? ''),
      }))
      .filter((row) => Number.isInteger(row.pid) && row.pid > 0);
  } catch {
    return [];
  }
}

/**
 * Every process on this machine whose command line contains `marker`.
 *
 * The marker is always this run's own folder path, which has a random part in it, so a
 * process that names it was started by this run — by us directly, or by the app we started.
 * Nothing else can be pointing at a folder we invented sixty seconds ago.
 *
 * @param {string} marker
 * @returns {Promise<{pid: number, command: string}[]>}
 */
export async function whoIsUsing(marker) {
  if (!marker || marker.length < 8) return [];
  // Windows has no `ps`, and asking it nothing at all was the same as answering "nobody is
  // using this folder" — which is the one answer this function must never invent, because it
  // is what the run trusts when it decides it is alone. Measured on a real Windows 11 machine
  // on 2026-08-31: every call here failed silently and returned an empty list.
  if (process.platform === 'win32') {
    return (await windowsProcessTable())
      .filter((row) => row.pid !== process.pid && row.command.includes(marker))
      .map((row) => ({ pid: row.pid, command: row.command }));
  }
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,command='], {
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
    });
    /** @type {{pid: number, command: string}[]} */
    const found = [];
    for (const line of stdout.split('\n')) {
      if (!line.includes(marker)) continue;
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      if (pid === process.pid) continue;
      found.push({ pid, command: match[2] });
    }
    return found;
  } catch {
    // No `ps` (an unusual Linux container) is not a reason to fail a run. It is a reason to
    // say the sweep could not be done, which the caller does.
    return [];
  }
}

/**
 * Every process descended from these, however deep.
 *
 * A desktop app is a family, not a process: helpers for the screen and for the network, one
 * per window, plus whatever the app itself started — a shell, a language server, an agent.
 * The grandchildren are the ones that bite. They inherit the run's throwaway home folder but
 * they do NOT carry it on their command line, so a sweep that only matches the folder path
 * misses them entirely — and one of them writing a file a moment after the folder was deleted
 * puts the folder back. Measured exactly that way: a shell the app started recreated its own
 * dot-folder inside a home directory that had already been cleaned up.
 *
 * The family has to be read BEFORE the parent is killed. Once it dies its children are
 * adopted by the system and the trail is gone.
 *
 * @param {number[]} pids
 * @returns {Promise<number[]>} the descendants, not including the ones passed in
 */
export async function descendantsOf(pids) {
  const roots = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (roots.length === 0) return [];
  /** @type {Map<number, number[]>} */
  const childrenOf = new Map();
  /** @param {number} pid @param {number} parent */
  const note = (pid, parent) => {
    const list = childrenOf.get(parent) ?? [];
    list.push(pid);
    childrenOf.set(parent, list);
  };
  // The same table, asked for in Windows' words. Returning nothing here meant the app's own
  // children — the renderer processes a browser or an Electron app starts — were never found
  // and never closed, so every check on Windows left a handful of them behind. Measured on a
  // real Windows 11 machine on 2026-08-31.
  if (process.platform === 'win32') {
    for (const row of await windowsProcessTable()) note(row.pid, row.ppid);
  } else {
    try {
      const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
      for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (!match) continue;
        note(Number(match[1]), Number(match[2]));
      }
    } catch {
      return [];
    }
  }
  /** @type {Set<number>} */
  const found = new Set();
  /** @type {number[]} */
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = /** @type {number} */ (queue.shift());
    for (const child of childrenOf.get(pid) ?? []) {
      if (found.has(child) || roots.includes(child) || child === process.pid) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return [...found];
}

/** @param {number} pid */
function stillThere(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Reserving one
// ---------------------------------------------------------------------------

/**
 * Somewhere that is definitely not the person's real data.
 *
 * A bug that pointed `--user-data-dir` at a real settings folder would not throw and would
 * not look wrong; it would quietly run a test build against somebody's actual sessions. So
 * the check is made once, here, loudly, on a rule with no judgement in it: the folder has to
 * be inside the scratch folder the engine handed us.
 *
 * @param {string} scratchDir
 * @param {string} dir
 */
function refuseIfNotScratch(scratchDir, dir) {
  const inside = path.resolve(dir) + path.sep;
  const root = path.resolve(scratchDir) + path.sep;
  if (!inside.startsWith(root)) {
    throw new Error(
      `Stays Fixed will not point an app at "${dir}", because it is not inside the scratch folder "${scratchDir}". ` +
      'A run always gets its own throwaway settings folder — never a real one.',
    );
  }
  // Anything inside the machine's own temp folder is throwaway by definition, and the
  // settings check below is skipped for it.
  //
  // This is not a loophole, it is the difference between the two operating systems. On
  // Windows the temp folder lives INSIDE the settings folder — `C:\Users\me\AppData\Local\Temp`
  // sits under `C:\Users\me\AppData` — so the rule "refuse anything under AppData" refused
  // every scratch folder the tool makes for itself. Measured on a real Windows 11 machine on
  // 2026-08-31: all 18 isolation cases failed with "that is where real settings live" about a
  // folder the tool had just created for its own use, which means isolation, and therefore
  // every check that opens an app, could never have worked on Windows at all.
  //
  // The guard itself is unchanged everywhere else, and is still the strict one: the folder
  // has to be inside the scratch folder the engine handed us, and if it is not somewhere the
  // operating system itself calls temporary, it may not be anywhere near real settings.
  if (isUnderTemp(inside)) return;
  for (const real of [
    path.join(os.homedir(), 'Library', 'Application Support'),
    path.join(os.homedir(), '.config'),
    path.join(os.homedir(), 'AppData'),
  ]) {
    if (inside.startsWith(path.resolve(real) + path.sep)) {
      throw new Error(`Stays Fixed will not point an app at "${dir}" — that is where real settings live.`);
    }
  }
}

/**
 * Is this path inside the folder the operating system itself hands out for throwaway files?
 *
 * Both spellings are compared, because Windows hands the same folder out under two names: the
 * long one and the old eight-character one (`C:\Users\RUNNER~1\...`), and a path that came
 * back from one call can be spelled the other way from the next.
 *
 * @param {string} resolvedWithSeparator  An already-resolved path, ending in a separator.
 * @returns {boolean}
 */
function isUnderTemp(resolvedWithSeparator) {
  const temp = os.tmpdir();
  /** @type {string[]} */
  const spellings = [temp];
  try {
    spellings.push(fs.realpathSync.native(temp));
  } catch {
    // No second spelling available, which is the ordinary case everywhere but Windows.
  }
  return spellings.some((t) => resolvedWithSeparator.startsWith(path.resolve(t) + path.sep));
}

/**
 * The flags that make one desktop app run alone, and paint the same way twice.
 *
 * Two separate jobs in one list, and it is worth knowing which is which. The first four are
 * ISOLATION: its own settings, its own cache, its own crash folder, its own debugging ports.
 * The rest are DETERMINISM: the same pixel grid, no animation half-finished at the moment
 * something is read, and no slowing-down when the window is behind another window — which
 * otherwise turns "wait for the list to appear" into a random timeout.
 *
 * @param {Isolation} isolation
 * @param {{scale?: number, brk?: boolean}} [opts]
 * @returns {string[]}
 */
export function isolationArgs(isolation, opts = {}) {
  const scale = opts.scale ?? 1;
  return [
    `--user-data-dir=${isolation.userDataDir}`,
    `--disk-cache-dir=${isolation.cacheDir}`,
    `--crash-dumps-dir=${isolation.crashDir}`,
    `--remote-debugging-port=${isolation.debugPort}`,
    '--remote-allow-origins=*',
    `${opts.brk === false ? '--inspect' : '--inspect-brk'}=${isolation.inspectPort}`,
    `--force-device-scale-factor=${scale}`,
    '--force-color-profile=srgb',
    '--disable-lcd-text',
    '--font-render-hinting=none',
    '--force-prefers-reduced-motion',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ];
}

/**
 * Set one run up: its own folders, its own ports, its own identity.
 *
 * Nothing is started here. Reserving and launching are separate on purpose — the engine
 * reserves, checks it really is alone, and only then opens anything.
 *
 * @param {object} opts
 * @param {string} opts.scratchDir      Where the engine says this run may write.
 * @param {string} [opts.label]         Plain English name for the build being run.
 * @param {string} [opts.appId]         Something stable about the app, so its identity is
 *                                      stable too: a bundle id, a product name.
 * @param {string} [opts.clock]         ISO time the app should believe it is.
 * @param {number} [opts.seed]
 * @param {Record<string, string>} [opts.identityEnv]
 *                                      Environment variables this app uses to know who it
 *                                      is. Any `{identity}` in a value is filled in. This is
 *                                      the fifth collision — the relay slot — and it is the
 *                                      one the tool cannot detect for itself.
 * @param {Record<string, string>} [opts.env]   Anything else the project wants set.
 * @returns {Promise<Isolation>}
 */
export async function reserveIsolation(opts) {
  const id = crypto.randomBytes(5).toString('hex');
  const label = opts.label ?? 'this build';
  const dir = path.join(opts.scratchDir, `run-${id}`);
  refuseIfNotScratch(opts.scratchDir, dir);

  const userDataDir = path.join(dir, 'settings');
  const homeDir = path.join(dir, 'home');
  const tmpDir = path.join(dir, 'tmp');
  const cacheDir = path.join(dir, 'cache');
  const crashDir = path.join(dir, 'crashes');
  for (const folder of [userDataDir, homeDir, tmpDir, cacheDir, crashDir]) {
    await fsp.mkdir(folder, { recursive: true });
  }

  const debugPort = await takePort();
  const inspectPort = await takePort();

  // Deliberately the SAME name every time this app is checked, rather than a new one per
  // run. Runs are sequential and the previous one is proved gone before the next starts, so
  // one name is never in two places at once — and a name that changed every run would show
  // up as a difference in every single report.
  const identity = `staysfixed-${crypto.createHash('sha256').update(String(opts.appId ?? label)).digest('hex').slice(0, 10)}`;

  /** @type {Record<string, string>} */
  const identityEnv = {};
  for (const [key, value] of Object.entries(opts.identityEnv ?? {})) {
    identityEnv[key] = String(value).split('{identity}').join(identity);
  }

  /** @type {(() => Promise<void>|void)[]} */
  const closers = [];
  /** @type {import('node:child_process').ChildProcess[]} */
  const children = [];
  // True once the teardown has run. Anything that arrives after that has to be dealt with on
  // the spot rather than added to a list nobody reads again — see the two handlers below.
  let releasedAlready = false;

  /** @type {Isolation} */
  const isolation = {
    id,
    label,
    dir,
    userDataDir,
    homeDir,
    tmpDir,
    cacheDir,
    crashDir,
    debugPort,
    inspectPort,
    identity,
    args: [],
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: homeDir,
      TMPDIR: tmpDir,
      TEMP: tmpDir,
      TMP: tmpDir,
      XDG_CONFIG_HOME: path.join(homeDir, '.config'),
      XDG_CACHE_HOME: cacheDir,
      XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
      TZ: 'UTC',
      LANG: 'en_US.UTF-8',
      NO_COLOR: '1',
      // An app that seeds itself from here gets the same seed both runs, which is the point.
      STAYSFIXED: '1',
      STAYSFIXED_SEED: String(opts.seed ?? 1),
      STAYSFIXED_CLOCK: opts.clock ?? new Date().toISOString(),
      STAYSFIXED_IDENTITY: identity,
      // Nothing being checked should be phoning home about itself.
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      ELECTRON_ENABLE_LOGGING: '1',
      ...identityEnv,
      ...opts.env,
    },
    // A connection or a process that arrives AFTER the teardown has already run is not
    // hypothetical: opening an app is a wait with a limit on it, and when that limit fires the
    // open is abandoned while it is still half way through — so it can still finish connecting
    // a moment later, on an isolation that has already been swept. Pushed onto these lists it
    // would be held by nobody and closed by nobody, and one live debugging socket is all it
    // takes to keep Node's event loop awake for ever, which is the exact hang this whole pass
    // exists to remove. So a latecomer is closed or stopped immediately instead.
    closeFirst(close) {
      if (releasedAlready) { void Promise.resolve(close()).catch(() => {}); return; }
      closers.push(close);
    },
    own(child) {
      if (releasedAlready) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        letGoOf(child);
        return;
      }
      children.push(child);
    },
    /** Told by the teardown, so latecomers know there is nothing left to join. */
    markReleased() { releasedAlready = true; },
    notes: [
      `This run has its own settings folder, its own cache, its own two debugging ports and the name "${identity}".`,
      'Nothing here is shared with the real app, so the two cannot displace each other.',
      Object.keys(identityEnv).length > 0
        ? `The app is told who it is through ${Object.keys(identityEnv).join(', ')}, so it registers as itself and never as the real install.`
        : 'This app was not told to register under a different name. If it signs in to something with a device id, name that setting under "electron.identityEnv" in the config so two runs cannot fight over one slot.',
    ],
  };
  isolation.args = isolationArgs(isolation);

  alive.set(id, { isolation, closers, children });
  armTheSafetyNet();
  return isolation;
}

/**
 * Is this run really alone before anything opens?
 *
 * Cheap, and it is the check that turns "we made a new folder so it must be fine" into
 * something known. It catches the case that actually happens: a previous run that was
 * killed rudely and left a copy of the app still running on its ports.
 *
 * @param {Isolation} isolation
 * @returns {Promise<{alone: boolean, why: string, holders: {pid: number, command: string}[]}>}
 */
export async function verifyAlone(isolation) {
  const holders = await whoIsUsing(isolation.dir);
  const debugFree = await portFree(isolation.debugPort);
  const inspectFree = await portFree(isolation.inspectPort);
  if (holders.length === 0 && debugFree && inspectFree) {
    return { alone: true, why: 'Nothing else is using this run\'s folder or either of its ports, so it starts alone.', holders };
  }
  /** @type {string[]} */
  const problems = [];
  if (holders.length > 0) problems.push(`${holders.length} process${holders.length === 1 ? ' is' : 'es are'} still using this run's own folder`);
  if (!debugFree) problems.push(`something is already listening on port ${isolation.debugPort}`);
  if (!inspectFree) problems.push(`something is already listening on port ${isolation.inspectPort}`);
  return { alone: false, why: `This run is not alone yet: ${problems.join(', ')}.`, holders };
}

// ---------------------------------------------------------------------------
// Starting one
// ---------------------------------------------------------------------------

/**
 * What a started app is, from the outside.
 *
 * @typedef {object} StartedApp
 * @property {import('node:child_process').ChildProcess} child
 * @property {number} pid
 * @property {() => string} said        Everything it has printed so far, both streams.
 * @property {() => {code: number|null, signal: string|null}|null} finished
 *                                      Null while it is still running.
 */

/**
 * Start the app inside one isolation.
 *
 * @param {Isolation} isolation
 * @param {object} opts
 * @param {string} opts.binary          The executable — inside the bundle on a Mac.
 * @param {string[]} [opts.extraArgs]   Anything the project wants added.
 * @param {string} [opts.cwd]
 * @param {AbortSignal} [opts.signal]
 * @returns {StartedApp}
 */
export function startIsolated(isolation, opts) {
  const child = spawn(opts.binary, [...isolation.args, ...(opts.extraArgs ?? [])], {
    cwd: opts.cwd,
    env: isolation.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: opts.signal,
  });
  isolation.own(child);

  /** @type {string[]} */
  const lines = [];
  let bytes = 0;
  const keep = (/** @type {Buffer} */ chunk) => {
    const text = String(chunk);
    bytes += text.length;
    if (bytes > 256 * 1024) return;
    lines.push(text);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);

  /** @type {{code: number|null, signal: string|null}|null} */
  let ended = null;
  child.once('exit', (code, signal) => { ended = { code, signal }; });
  // A quit later on must never take the tool down with an unhandled error event.
  child.on('error', () => {});

  // Said out loud the moment the process exists, and before it has drawn anything.
  // Whoever is looking after the screen during this check needs to know that this
  // application belongs to the tool BEFORE it appears, or its first appearance is
  // read as the person choosing it.
  announce({ name: appNameFor(opts.binary), pid: child.pid ?? -1, binary: opts.binary, label: isolation.label });

  return {
    child,
    pid: child.pid ?? -1,
    said: () => lines.join(''),
    finished: () => ended,
  };
}

// ---------------------------------------------------------------------------
// Proving it is gone
// ---------------------------------------------------------------------------

/**
 * Stop everything this run started, and prove it stopped.
 *
 * The order is not arbitrary; each step was measured on a real app.
 *
 *   1. Hang up every debugging connection FIRST. An Electron app with a debugger still
 *      attached prints "Waiting for the debugger to disconnect..." and ignores being asked
 *      to quit. Measured on Terminal Deck 0.15.0: with the socket open it survived a polite
 *      request; with the socket closed it quit in well under a second.
 *   2. Ask the app to quit, and give it a moment — a desktop app saves its state on the way
 *      out, and killing it mid-save is how a run corrupts its own scratch data.
 *   3. Insist, if it ignored being asked.
 *   4. Sweep. A desktop app is not one process: there is a helper for the screen, one per
 *      window, one for the network, and whatever the app itself started. They all carry this
 *      run's own folder on their command line, which is how they are told from everybody
 *      else's, and nothing without that marker is ever touched.
 *   5. Let go of the pipes. Not tidiness — the run's own survival. A survivor holding the
 *      writing end of a pipe this process is reading keeps Node's event loop awake for ever,
 *      and on 2026-08-31 that was measured doing exactly that: every step above succeeded, the
 *      report said the app was proved gone, and the tool then never returned. A check that
 *      prints a perfect verdict and hangs cannot be told apart from a check that is broken.
 *   6. Check the ports are free again, because the next run needs them and a port that is
 *      still held is the clearest possible proof that something survived.
 *
 * @param {Isolation} isolation
 * @param {{graceMs?: number, keepFolder?: boolean}} [opts]
 * @returns {Promise<TeardownReport>}
 */
export async function releaseIsolation(isolation, opts = {}) {
  const started = Date.now();
  const graceMs = opts.graceMs ?? 5000;
  const held = alive.get(isolation.id);
  const closers = held?.closers ?? [];
  const children = held?.children ?? [];
  alive.delete(isolation.id);
  // Said before anything is torn down, so a connection that finishes opening half way through
  // this is closed on arrival rather than added to a list that has already been walked.
  isolation.markReleased?.();
  handedOut.delete(isolation.debugPort);
  handedOut.delete(isolation.inspectPort);

  /** @type {string[]} */
  const leftBehind = [];

  // 1 — hang up, before asking anything to quit.
  //
  // On a clock, because a closer is a callback somebody else registered and a debugging socket
  // that refuses to say goodbye must not be able to hold the teardown — and therefore the whole
  // check — open. If one will not close in five seconds it is left, which is exactly what the
  // sweep below is for.
  for (const close of closers) {
    try {
      await withLimit(Promise.resolve(close()), { limitMs: 5000, what: `one of ${isolation.label}'s debugging connections to hang up` });
    } catch (e) {
      leftBehind.push(`a debugging connection would not hang up (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  // 2 — read the whole family while the trail still exists, then ask the app to quit.
  const family = await descendantsOf(children.map((c) => c.pid ?? 0));
  let askedNicely = false;
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) { askedNicely = true; continue; }
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  const until = Date.now() + graceMs;
  while (Date.now() < until) {
    if (children.every((c) => c.exitCode !== null || c.signalCode !== null || !c.pid || !stillThere(c.pid))) {
      askedNicely = true;
      break;
    }
    await wait(100);
  }

  // 3 — insist.
  let hadToInsist = false;
  for (const child of children) {
    if (!child.pid || !stillThere(child.pid)) continue;
    hadToInsist = true;
    try { child.kill('SIGKILL'); } catch { /* gone between the two lines */ }
  }
  if (hadToInsist) await wait(600);

  // 4 — sweep. First everything the app itself started, then everything still pointing at
  // this run's own folder. The two catch different things and both are needed: a helper
  // process names the folder, a grandchild only inherits it.
  /** @type {number[]} */
  const strays = [];
  for (const signal of /** @type {const} */ (['SIGTERM', 'SIGKILL'])) {
    const survivors = family.filter((pid) => stillThere(pid));
    if (survivors.length === 0) break;
    for (const pid of survivors) {
      strays.push(pid);
      try { process.kill(pid, signal); } catch { /* it ended on its own */ }
    }
    await wait(signal === 'SIGTERM' ? 500 : 300);
  }
  for (const round of [0, 1]) {
    const holders = await whoIsUsing(isolation.dir);
    if (holders.length === 0) break;
    for (const holder of holders) {
      strays.push(holder.pid);
      try { process.kill(holder.pid, round === 0 ? 'SIGTERM' : 'SIGKILL'); } catch { /* it ended on its own */ }
    }
    await wait(round === 0 ? 700 : 400);
  }
  const stubborn = await whoIsUsing(isolation.dir);
  for (const holder of stubborn) {
    leftBehind.push(`process ${holder.pid} is still running and still pointing at this run's folder`);
  }

  // 5 — let go of the pipes, whatever else happened.
  //
  // This is the step that was missing, and it is the one that cost a run. Measured on
  // 2026-08-31: with everything above done and the report reading "the app was closed and is
  // gone ... the next run starts alone", the tool then sat there for ever. An app that started
  // a shell of its own — which is the entire job of the app this was measured against — leaves
  // that shell holding the writing end of the pipes this process is reading, a pipe being read
  // keeps Node's event loop awake, and so the check never ended. It printed a perfect verdict
  // and never came back, which is indistinguishable from the tool being broken.
  //
  // A short drain first, because whatever the app said on its way out is worth keeping and the
  // exit and the last of the output can land a tick apart. Then the pipes go, on a clock,
  // rather than being trusted to close on their own. `child.js` reaches the same conclusion for
  // a start command's server, for the same reason.
  for (const child of children) {
    await Promise.race([
      new Promise((done) => { child.once('close', done); }),
      wait(250),
    ]);
    letGoOf(child);
  }

  // 6 — the ports have to come back.
  /** @type {[number, string][]} */
  const portsToCheck = [[isolation.debugPort, 'the window'], [isolation.inspectPort, 'the main process']];
  for (const [port, what] of portsToCheck) {
    let free = false;
    for (let i = 0; i < 20 && !free; i += 1) {
      free = await portFree(port);
      if (!free) await wait(150);
    }
    if (!free) leftBehind.push(`port ${port}, which was how ${what} was read, is still held by something`);
  }

  if (!opts.keepFolder) {
    // Twice, with a pause. The first pass can race a process that was in the middle of
    // writing; if the folder comes back, something is still alive that should not be, and the
    // second pass is what turns that from a silent leftover into something said out loud.
    try {
      await fsp.rm(isolation.dir, { recursive: true, force: true });
      await wait(250);
      await fsp.rm(isolation.dir, { recursive: true, force: true });
      await fsp.stat(isolation.dir).then(
        () => leftBehind.push("the run's folder keeps coming back, so something of its is still running"),
        () => {},
      );
    } catch (e) {
      leftBehind.push(`the run's folder could not be deleted: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const ms = Date.now() - started;
  const proved = leftBehind.length === 0;
  const uniqueStrays = [...new Set(strays)];
  return {
    proved,
    askedNicely,
    hadToInsist,
    strays: uniqueStrays,
    ms,
    leftBehind,
    why: proved
      ? `${isolation.label} was closed and is gone: ${askedNicely && !hadToInsist ? 'it quit when asked' : 'it had to be stopped'}, ` +
        `${uniqueStrays.length === 0 ? 'nothing else of its was left running' : `${uniqueStrays.length} helper process${uniqueStrays.length === 1 ? '' : 'es'} of its were stopped too`}, ` +
        'and both of its ports are free again. The next run starts alone.'
      : `${isolation.label} may not be completely gone: ${leftBehind.join('; ')}. ` +
        'The next run must not start until this is clear, because two copies of one app fight over the same lock, the same settings and the same identity.',
  };
}

/**
 * Everything still open, closed. Called when a check ends — including when it throws.
 *
 * A scratch copy of somebody's app left running on their screen is the single rudest thing
 * this tool could do, and an exception halfway through a check is exactly when it would
 * happen.
 *
 * @returns {Promise<TeardownReport[]>}
 */
export async function releaseEverything() {
  /** @type {TeardownReport[]} */
  const reports = [];
  for (const held of [...alive.values()]) {
    reports.push(await releaseIsolation(held.isolation));
  }
  return reports;
}

/**
 * The last-resort version, for the moment the whole program is going away.
 *
 * Exit handlers cannot wait for anything, so this one is deliberately blunt and synchronous:
 * it signals what it knows about and returns. The full, proved teardown is
 * {@link releaseEverything}; this is only there so a crash does not leave a window open.
 */
function killOnTheWayOut() {
  for (const held of alive.values()) {
    for (const child of held.children) {
      if (!child.pid) continue;
      try { child.kill('SIGKILL'); } catch { /* nothing left to do about it */ }
    }
  }
  alive.clear();
}

let netArmed = false;
/** Put the safety net up once, however many isolations are reserved. */
function armTheSafetyNet() {
  if (netArmed) return;
  netArmed = true;
  process.once('exit', killOnTheWayOut);
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
    process.once(signal, () => { killOnTheWayOut(); process.exit(130); });
  }
}

/**
 * How many runs this process still has open. For a test, and for a report that wants to say
 * out loud that it left nothing behind.
 */
export function stillOpen() {
  return alive.size;
}

/**
 * The isolation, said in plain English, for the run's own report.
 * @param {Isolation} isolation
 * @returns {string}
 */
export function describeIsolation(isolation) {
  return (
    `"${isolation.label}" runs on its own: settings in a throwaway folder, the window read on port ` +
    `${isolation.debugPort}, the main process read on port ${isolation.inspectPort}, and the name ` +
    `"${isolation.identity}" so it never takes the real app's place anywhere it signs in. ` +
    'Only one copy is ever open at a time, and the previous one is proved gone before the next starts.'
  );
}
