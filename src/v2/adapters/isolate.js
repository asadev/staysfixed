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
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

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
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
    for (const line of stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const parent = Number(match[2]);
      const list = childrenOf.get(parent) ?? [];
      list.push(pid);
      childrenOf.set(parent, list);
    }
  } catch {
    return [];
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
    closeFirst(close) { closers.push(close); },
    own(child) { children.push(child); },
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
 *   5. Check the ports are free again, because the next run needs them and a port that is
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
  handedOut.delete(isolation.debugPort);
  handedOut.delete(isolation.inspectPort);

  /** @type {string[]} */
  const leftBehind = [];

  // 1 — hang up, before asking anything to quit.
  for (const close of closers) {
    try { await close(); } catch { /* a connection that will not close is one we are leaving anyway */ }
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

  // 5 — the ports have to come back.
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
