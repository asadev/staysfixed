/**
 * CLI tools and libraries — the first platform, and the one the whole design is tested on.
 *
 * A command is the easiest thing in the world to observe honestly. You run it, and it tells
 * you what happened: what it printed, what it complained about, what number it exited with,
 * what it left behind on disk, what it tried to phone. No accessibility tree, no browser, no
 * simulator. That is exactly why this adapter is first — if subtracting the measured wobble
 * does not make the differences quiet HERE, it will not work anywhere, and it is better to
 * find that out in days than in months.
 *
 * WHAT IT WATCHES, per journey:
 *   printed          stdout and stderr, with only our own footprint rubbed out
 *   finished         the exit code, and whether it was killed
 *   files            every file created, changed or deleted, by content, not by timestamp
 *   ran              every other program it started
 *   reached out to   every outbound connection it tried — and every one of them refused
 *   settings it read which environment variables it looked at
 *   how long         in coarse buckets, never in milliseconds
 *
 * TWO THINGS TO KNOW ABOUT HOW IT WATCHES.
 *
 * First, every run happens in a scratch copy of the project. Never the real one. Somebody
 * has the real one open in an editor, and a command that writes a file is a command that
 * would have written it into their working tree.
 *
 * Second, the watching itself is done from INSIDE the child, by a small script Node loads
 * before the program starts. That is what makes "it tried to call this URL" observable at
 * all, and it is the safety boundary: an outbound connection to anywhere but this machine
 * is recorded and then refused, so a command that charges a card gets watched asking and
 * never gets to ask. The catch, said plainly rather than hidden: this only works when the
 * thing being run is Node. Run a Go binary and the file-and-output channels still work
 * perfectly, but nobody is watching its network, and the report says so with `covered:
 * false` rather than quietly passing.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  defineAdapter, howLongItTook, joinPath, notCovered, observation, sizeBucket,
  trimForStorage, undoOurFootprint,
} from './contract.js';

// ---------------------------------------------------------------------------
// The environment every run gets
// ---------------------------------------------------------------------------

/**
 * The settings that are pinned for every run, so two runs of the same build differ because
 * of the build and not because of the weather.
 *
 * `NO_COLOR` and friends matter more than they look: a program that colours its output when
 * it thinks it is talking to a terminal and does not when it thinks it is talking to a pipe
 * produces two completely different strings for the same work. Pinning the answer is better
 * than stripping the colours afterwards, because stripping also hides a real change in what
 * the program chose to colour.
 *
 * @param {object} opts
 * @param {string} opts.clock       ISO time the run should believe it is.
 * @param {number} opts.seed
 * @param {string} opts.home        A scratch home directory, so nothing reads the real one.
 * @param {string} opts.tmp
 * @param {Record<string,string>} [opts.extra]
 * @returns {Record<string,string>}
 */
export function frozenEnvironment(opts) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    SHELL: '/bin/sh',
    HOME: opts.home,
    TMPDIR: opts.tmp,
    TEMP: opts.tmp,
    TMP: opts.tmp,
    TZ: 'UTC',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CI: '',
    COLUMNS: '80',
    LINES: '24',
    // Anything that seeds itself from here gets the same seed twice, which is the point.
    STAYSFIXED: '1',
    STAYSFIXED_SEED: String(opts.seed),
    STAYSFIXED_CLOCK: opts.clock,
    ...opts.extra,
  };
}

// ---------------------------------------------------------------------------
// The watcher that rides inside the child
// ---------------------------------------------------------------------------

/**
 * Build the script Node loads before the program under test starts.
 *
 * Written as text rather than as a file in this package because it has to be given a path
 * inside the scratch folder anyway, and because generating it here keeps what it does
 * readable next to why it does it.
 *
 * The network patch goes on `net.Socket.prototype.connect` rather than on `fetch` or on
 * `http.request`. That is deliberate and it is the difference between a boundary and a
 * suggestion: every HTTP client, every database driver, every SDK anybody has ever written
 * ends up on that one prototype, however it was imported. Patching `fetch` catches the
 * polite callers and misses the payment library.
 *
 * @param {object} opts
 * @param {string} opts.reportFile   Where the child writes what it saw.
 * @param {boolean} opts.allowLoopback  Let it talk to this machine (its own server).
 * @returns {string} JavaScript, ready to be written to disk and passed to --import
 */
export function watcherScript(opts) {
  const settings = JSON.stringify({ reportFile: opts.reportFile, allowLoopback: opts.allowLoopback });
  return [
    "// Written by Stays Fixed. Watches one run from the inside, and refuses anything that",
    "// would reach off this machine. Deleted with the scratch folder when the run ends.",
    "import { createRequire } from 'node:module';",
    "const require = createRequire(import.meta.url);",
    "const fs = require('node:fs');",
    "const settings = " + settings + ";",
    "",
    "const write = (kind, what) => {",
    "  try { fs.appendFileSync(settings.reportFile, JSON.stringify({ kind, what }) + '\\n'); }",
    "  catch { /* a run we cannot report on is still a run */ }",
    "};",
    "",
    "// The first line goes out before anything else runs. Its presence is the proof that",
    "// something was watching at all — without it, a run that simply did nothing quiet is",
    "// indistinguishable from a run nobody was watching, and those two must never be confused.",
    "write('watching', { pid: process.pid });",
    "",
    "// --- what else it started ------------------------------------------------",
    "// Patched on the module's own exports object, which every `require` and every default",
    "// import shares. A caller who wrote `import { spawn } from ...` bound the function",
    "// directly and will not be seen; the report says so rather than pretending otherwise.",
    "try {",
    "  const cp = require('node:child_process');",
    "  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {",
    "    const original = cp[name];",
    "    if (typeof original !== 'function') continue;",
    "    cp[name] = function (...args) {",
    "      write('ran', { how: name, command: String(args[0] ?? '') });",
    "      return original.apply(this, args);",
    "    };",
    "  }",
    "} catch { /* no child_process, nothing to watch */ }",
    "",
    "// --- what it tried to reach ----------------------------------------------",
    "const loopback = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0', '']);",
    "try {",
    "  const net = require('node:net');",
    "  const connect = net.Socket.prototype.connect;",
    "  net.Socket.prototype.connect = function (...args) {",
    "    const first = args[0];",
    "    const host = typeof first === 'object' && first !== null ? String(first.host ?? first.path ?? '') : String(args[1] ?? '');",
    "    const port = typeof first === 'object' && first !== null ? first.port : first;",
    "    const local = loopback.has(host) || (typeof first === 'object' && first !== null && first.path);",
    "    if (local && settings.allowLoopback) return connect.apply(this, args);",
    "    write('reached out', { host: host || 'somewhere it did not name', port: port ?? null });",
    "    // Refused, not allowed through. Whatever this was going to do out there, it does not",
    "    // do it twice, and the run is reported as having a hole rather than as having passed.",
    "    const error = new Error('Stays Fixed refused a connection to ' + (host || 'an unnamed host') + ': nothing irreversible is allowed out during a check.');",
    "    error.code = 'ECONNREFUSED';",
    "    process.nextTick(() => this.emit('error', error));",
    "    return this;",
    "  };",
    "} catch { /* no net module, nothing to refuse */ }",
    "",
    "// --- what settings it read -----------------------------------------------",
    "// Buffered rather than written as it happens: a program can read the environment",
    "// thousands of times and appending to a file each time would change what we are trying",
    "// to measure.",
    "const settingsRead = new Set();",
    "try {",
    "  const real = process.env;",
    "  const watched = new Proxy(real, {",
    "    get(target, key) { if (typeof key === 'string') settingsRead.add(key); return target[key]; },",
    "    has(target, key) { if (typeof key === 'string') settingsRead.add(key); return key in target; },",
    "  });",
    "  Object.defineProperty(process, 'env', { value: watched, configurable: true, writable: true });",
    "} catch { /* some hosts freeze this; the other channels still work */ }",
    "",
    "const finish = () => {",
    "  if (settingsRead.size > 0) { write('settings read', [...settingsRead].sort()); settingsRead.clear(); }",
    "};",
    "process.on('exit', finish);",
  ].join('\n');
}

/**
 * @typedef {object} WatchedEvents
 * @property {boolean} inForce             False when nothing was watching from the inside.
 * @property {Map<string, number>} ran     Command as written, and how many times.
 * @property {Array<{host: string, port: number|null}>} reachedOut
 * @property {string[]} settingsRead
 */

/**
 * Read back what the watcher saw. An empty or missing file is not an error: it is the
 * answer to "was anything watching", and the caller reports coverage accordingly.
 * @param {string} reportFile
 * @returns {Promise<WatchedEvents>}
 */
export async function readWatcher(reportFile) {
  /** @type {WatchedEvents} */
  const seen = { inForce: false, ran: new Map(), reachedOut: [], settingsRead: [] };
  let text;
  try {
    text = await fsp.readFile(reportFile, 'utf8');
  } catch {
    return seen;
  }
  seen.inForce = true;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.kind === 'ran') {
      const command = String(event.what?.command ?? '');
      seen.ran.set(command, (seen.ran.get(command) ?? 0) + 1);
    } else if (event.kind === 'reached out') {
      seen.reachedOut.push({ host: String(event.what?.host ?? ''), port: event.what?.port ?? null });
    } else if (event.kind === 'settings read') {
      // The variables we set ourselves are our footprint, not the program's dependencies.
      // Everything else stays, including the ones Node itself reads — those vary between
      // runs, and subtracting the measured wobble is exactly how that is meant to be dealt
      // with, rather than by a growing list of names somebody has to keep up to date.
      const ours = /^(STAYSFIXED|NODE_OPTIONS$)/;
      seen.settingsRead.push(...(Array.isArray(event.what) ? event.what.map(String).filter((/** @type {string} */ k) => !ours.test(k)) : []));
    }
  }
  seen.settingsRead = [...new Set(seen.settingsRead)].sort();
  return seen;
}

// ---------------------------------------------------------------------------
// What the disk looked like before and after
// ---------------------------------------------------------------------------

/** @typedef {Map<string, string>} TreeSnapshot   relative path -> fingerprint of its contents */

/** Folders left out of a snapshot: enormous, and not what anybody means by "it wrote a file". */
const SNAPSHOT_SKIP = new Set(['node_modules', '.git', '.staysfixed']);

/**
 * Fingerprint every file under a folder.
 *
 * By CONTENTS, never by timestamp or size. A run that rewrites a file with the same bytes
 * has not changed anything, and reporting it as a change is how a tool teaches people to
 * ignore it. Files too big to hash are recorded by size with a note, so they still show a
 * change when they grow, and they say what they are.
 *
 * @param {string} root
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]     Hash files up to this size. Default 8MB.
 * @param {Set<string>} [opts.skip]
 * @returns {Promise<TreeSnapshot>}
 */
export async function snapshotTree(root, opts = {}) {
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const skip = opts.skip ?? SNAPSHOT_SKIP;
  /** @type {TreeSnapshot} */
  const snapshot = new Map();

  /** @param {string} dir */
  const walk = async (dir) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) await walk(full);
        continue;
      }
      const relative = path.relative(root, full);
      if (entry.isSymbolicLink()) {
        try { snapshot.set(relative, `points at ${await fsp.readlink(full)}`); } catch { /* gone already */ }
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fsp.stat(full);
        if (stat.size > maxBytes) {
          snapshot.set(relative, `too big to fingerprint, ${sizeBucket(stat.size)}`);
          continue;
        }
        snapshot.set(relative, crypto.createHash('sha256').update(await fsp.readFile(full)).digest('hex').slice(0, 16));
      } catch { /* a file that vanished mid-walk was not there to begin with */ }
    }
  };

  await walk(root);
  return snapshot;
}

/**
 * @typedef {object} FileChange
 * @property {string} file
 * @property {'created'|'changed'|'deleted'} what
 * @property {string} [now]     Fingerprint afterwards.
 */

/**
 * @param {TreeSnapshot} before
 * @param {TreeSnapshot} after
 * @returns {FileChange[]}
 */
export function compareTrees(before, after) {
  /** @type {FileChange[]} */
  const changes = [];
  for (const [file, now] of after) {
    const then = before.get(file);
    if (then === undefined) changes.push({ file, what: 'created', now });
    else if (then !== now) changes.push({ file, what: 'changed', now });
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changes.push({ file, what: 'deleted' });
  }
  changes.sort((a, b) => a.file.localeCompare(b.file));
  return changes;
}

// ---------------------------------------------------------------------------
// Running one command
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CommandResult
 * @property {string} stdout
 * @property {string} stderr
 * @property {number|null} code
 * @property {string|null} signal    Set when it was killed rather than finishing.
 * @property {boolean} timedOut
 * @property {number} ms
 */

/**
 * Run a command and wait for it, with a hard limit.
 *
 * Killed with SIGTERM first and SIGKILL after a grace period, because a program that traps
 * SIGTERM and hangs would otherwise hold the whole run open — and killed is reported as
 * killed, never quietly as an exit code.
 *
 * @param {string} command       Run through the shell, so a project can write what it means.
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {Record<string,string>} opts.env
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.stdin]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<CommandResult>}
 */
export function runCommand(command, opts) {
  const timeoutMs = opts.timeoutMs ?? 120000;
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    let timedOut = false;
    let settled = false;

    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => err.push(chunk));
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    else child.stdin?.end();

    const finish = (/** @type {number|null} */ code, /** @type {string|null} */ signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(alarm);
      clearTimeout(hardStop);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        code,
        signal,
        timedOut,
        ms: Date.now() - started,
      });
    };

    /** @type {NodeJS.Timeout} */
    let hardStop;
    const alarm = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      hardStop = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs);

    const onAbort = () => { child.kill('SIGTERM'); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      err.push(Buffer.from(`${error.message}\n`));
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

// ---------------------------------------------------------------------------
// Making the scratch copy
// ---------------------------------------------------------------------------

/**
 * Copy a project into a scratch folder so a run can write whatever it likes.
 *
 * `node_modules` is cloned rather than copied where the filesystem can do it — on this Mac
 * that is one APFS call and no bytes move; on Linux it is a reflink where the filesystem
 * has them and a real copy where it does not. Never a symlink and never a hardlink: both
 * point back at the real project, which is the one thing this whole function exists to
 * protect.
 *
 * @param {string} from
 * @param {string} to
 * @param {object} [opts]
 * @param {string[]} [opts.skip]   Folder names not to copy. `.git` by default — it is huge
 *                                 and nothing a CLI check does needs history.
 * @returns {Promise<{copied: boolean, why: string}>}
 */
export async function copyForScratch(from, to, opts = {}) {
  const skip = new Set(opts.skip ?? ['.git', '.staysfixed']);
  await fsp.mkdir(to, { recursive: true });
  try {
    await fsp.cp(from, to, {
      recursive: true,
      force: true,
      dereference: false,
      preserveTimestamps: true,
      filter: (source) => {
        const name = path.basename(source);
        if (skip.has(name)) return false;
        return true;
      },
    });
    return { copied: true, why: `Copied the project into a scratch folder, so the run can write anywhere it likes without touching the real one.` };
  } catch (error) {
    return { copied: false, why: `The project could not be copied into a scratch folder: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CommandJourneyDetail
 * @property {string} run                  The command line, as a person would type it.
 * @property {string} [cwd]                Relative to the scratch copy. Default: its root.
 * @property {string} [stdin]
 * @property {number} [timeoutMs]
 * @property {Record<string,string>} [env]
 */

/**
 * @typedef {object} ImportJourneyDetail
 * @property {string} module               A path inside the project, or a package entry name.
 */

/** Everything a prepared build needs to remember between journeys. */
const prepared = new Map();

/**
 * The CLI-and-library adapter.
 */
export const processAdapter = defineAdapter({
  name: 'process',
  title: 'CLI tools and libraries',
  describe:
    'Runs a command, or imports a module, in a scratch copy of the project and reports what it printed, what it exited with, every file it created or changed, every program it started, every outbound connection it tried — all of which are refused — and roughly how long it took. Outbound calls and started programs are only visible when the thing being run is Node; for anything else those two channels are reported as not checked rather than as clean.',
  channels: ['results', 'complaints', 'effects', 'counters'],

  /** @param {import('./contract.js').AdapterProject} project */
  async detect(project) {
    /** @type {import('./contract.js').Missing[]} */
    const missing = [];
    const configured = project.config?.commands ?? [];
    const imports = project.config?.imports ?? [];

    let pkg = null;
    try { pkg = JSON.parse(await fsp.readFile(path.join(project.root, 'package.json'), 'utf8')); } catch { /* fine */ }
    const bins = pkg?.bin ? (typeof pkg.bin === 'string' ? 1 : Object.keys(pkg.bin).length) : 0;

    if (configured.length === 0 && imports.length === 0) {
      missing.push({
        what: 'a list of commands worth running',
        unlocks: 'everything this adapter does — it needs to know what to run, and it will not guess, because guessing means running something that deletes files',
        howToGet: bins > 0
          ? `This project installs ${bins} command${bins === 1 ? '' : 's'}. Put the ones worth checking under "process.commands" in the config, each as {"name": "...", "run": "..."}.`
          : 'Put them under "process.commands" in the config, each as {"name": "...", "run": "..."}.',
        blocking: true,
      });
    }

    const applies = configured.length > 0 || imports.length > 0 || bins > 0 || pkg !== null;
    return {
      applies,
      confidence: configured.length + imports.length > 0 ? 1 : (bins > 0 ? 0.6 : 0.2),
      why: configured.length + imports.length > 0
        ? `There ${configured.length + imports.length === 1 ? 'is 1 journey' : `are ${configured.length + imports.length} journeys`} to walk. Each runs in its own scratch copy of the project.`
        : applies
          ? 'This looks like a package, but nothing has said which commands are worth running yet.'
          : 'There is no package here and no commands were listed, so there is nothing to run.',
      missing,
      notes: [
        'Every run happens in a scratch copy. The real project is never written to.',
        'Outbound connections are recorded and then refused, so nothing that costs money or sends a message can happen during a check.',
      ],
    };
  },

  /** @param {import('./contract.js').AdapterProject} project */
  async journeys(project) {
    /** @type {import('./contract.js').Journey[]} */
    const journeys = [];
    for (const entry of project.config?.commands ?? []) {
      journeys.push({
        name: String(entry.name ?? entry.run),
        describe: String(entry.describe ?? entry.why ?? `run ${entry.run}`),
        source: 'code',
        surface: 'cli',
        from: 'the project config',
        channels: ['results', 'complaints', 'effects', 'counters'],
        steps: [{ act: 'run', run: String(entry.run), cwd: entry.cwd, stdin: entry.stdin, env: entry.env }],
        irreversible: entry.irreversible === true,
        timeoutMs: entry.timeoutMs,
      });
    }
    for (const entry of project.config?.imports ?? []) {
      journeys.push({
        name: String(entry.name ?? entry.module),
        describe: String(entry.describe ?? `import ${entry.module} and look at what it exports`),
        source: 'code',
        surface: 'library',
        from: 'the project config',
        channels: ['results', 'complaints', 'effects', 'counters'],
        steps: [{ act: 'import', module: String(entry.module) }],
        timeoutMs: entry.timeoutMs,
      });
    }
    return journeys;
  },

  /**
   * @param {import('./contract.js').Build} build
   * @param {import('./contract.js').RunContext} ctx
   */
  async prepare(build, ctx) {
    const base = path.join(ctx.scratchDir, `build-${build.id.slice(0, 12)}`);
    const work = path.join(base, 'work');
    const home = path.join(base, 'home');
    const tmp = path.join(base, 'tmp');
    await fsp.mkdir(home, { recursive: true });
    await fsp.mkdir(tmp, { recursive: true });

    const copy = await copyForScratch(build.root, work);
    if (!copy.copied) {
      return {
        build, root: work, ready: false, why: copy.why,
        dispose: async () => { await fsp.rm(base, { recursive: true, force: true }); },
      };
    }

    const watcher = path.join(base, 'watcher.mjs');
    prepared.set(build.id, { base, work, home, tmp, watcher });

    return {
      build,
      root: work,
      ready: true,
      why: `${copy.why} It reads a scratch home folder too, so nothing picks up a real config file by accident.`,
      facts: { work, home, tmp },
      dispose: async () => {
        prepared.delete(build.id);
        await fsp.rm(base, { recursive: true, force: true });
      },
    };
  },

  /**
   * @param {import('./contract.js').Journey} journey
   * @param {import('./contract.js').PreparedBuild} build
   * @param {import('./contract.js').RunContext} ctx
   * @returns {Promise<import('./contract.js').Observation[]>}
   */
  async run(journey, build, ctx) {
    const places = prepared.get(build.build.id);
    if (!build.ready || !places) {
      return [notCovered({
        channel: 'results',
        path: joinPath('cli', journey.name, 'ran at all'),
        reason: 'refused',
        says: `"${journey.describe}" was not run: ${build.why}`,
      })];
    }

    // Something irreversible is watched at the call boundary and refused at the wire — but
    // a journey that says up front that it is irreversible is not started at all, because
    // the refusal happens inside the child and there is no child until we start one.
    if (journey.irreversible && ctx.allowIrreversible !== true) {
      return [notCovered({
        channel: 'effects',
        path: joinPath('cli', journey.name, 'ran at all'),
        reason: 'irreversible',
        says: `"${journey.describe}" was left alone because it spends money, sends a message or destroys data. This is a hole in what was checked, not a pass.`,
      })];
    }

    const reportFile = path.join(places.base, `watch-${sanitise(journey.name)}.jsonl`);
    await fsp.rm(reportFile, { force: true });
    await fsp.writeFile(places.watcher, watcherScript({ reportFile, allowLoopback: true }), 'utf8');

    // The engine's Journey carries its steps as an open-ended list; a CLI journey has
    // exactly one, and this is where it is unpacked.
    const step = /** @type {any} */ (journey.steps?.[0] ?? {});
    const cwd = step.cwd ? path.resolve(places.work, step.cwd) : places.work;
    const env = frozenEnvironment({
      clock: ctx.clock,
      seed: ctx.seed,
      home: places.home,
      tmp: places.tmp,
      extra: {
        ...step.env,
        // `--import` is how a module gets to run before anything else does. It is appended
        // rather than assigned so a project that needs its own options keeps them.
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToUrl(places.watcher)}`.trim(),
      },
    });

    // A step that names nothing to run must say so. Handing `undefined` to a shell runs a
    // command called "undefined", which fails identically on both builds and therefore
    // reports NO difference - a silent nothing that looks exactly like a clean check.
    const nothingToRun = step.act === 'import' ? !step.module : !step.run;
    if (nothingToRun) {
      return [notCovered({
        channel: 'results',
        path: joinPath('cli', journey.name, 'ran at all'),
        reason: 'refused',
        says:
          `"${journey.describe}" says nothing to run. A command journey needs a "run" with the command line in it, ` +
          `and an import journey needs a "module". Nothing was run, and that is a hole, not a pass.`,
      })];
    }

    const before = await snapshotTree(places.work);
    const result = step.act === 'import'
      ? await runCommand(importProbeCommand(String(step.module)), { cwd, env, timeoutMs: journey.timeoutMs ?? 60000, signal: ctx.signal })
      : await runCommand(String(step.run), { cwd, env, timeoutMs: journey.timeoutMs ?? 120000, stdin: step.stdin, signal: ctx.signal });
    const after = await snapshotTree(places.work);
    const watched = await readWatcher(reportFile);

    const observations = await describeRun({
      journey, result, before, after, watched, ctx,
      footprint: { dirs: [places.base, places.tmp, places.home], projectRoot: build.build.root },
    });
    if (step.act === 'import') observations.push(...apiSurface(journey, result));
    return observations;
  },

  async teardown() {
    prepared.clear();
  },
});

/**
 * The command that imports a module and prints its shape.
 *
 * Run in its own process rather than imported here, for two reasons that are both about
 * honesty: a module that throws on import must not take the tool down with it, and a module
 * that starts a server or reads a file on import must do that under the same watcher as
 * everything else. Importing it into this process would let it out of the boundary.
 *
 * @param {string} moduleId
 */
export function importProbeCommand(moduleId) {
  const probe = [
    "const m = await import(process.argv[1].startsWith('.') || process.argv[1].includes('/') ? new URL(process.argv[1], 'file://' + process.cwd() + '/').href : process.argv[1]);",
    "const out = {};",
    "for (const key of Object.keys(m).sort()) {",
    "  const v = m[key];",
    "  const t = typeof v;",
    "  out[key] = t === 'function' ? ('a function taking ' + v.length + (v.length === 1 ? ' argument' : ' arguments'))",
    "    : v === null ? 'nothing'",
    "    : Array.isArray(v) ? ('a list of ' + v.length)",
    "    : t === 'object' ? ('an object with ' + Object.keys(v).sort().join(', '))",
    "    : t === 'string' ? 'some text' : t;",
    "}",
    "process.stdout.write(JSON.stringify(out, null, 2));",
  ].join('\n');
  return `node --input-type=module -e ${shellQuote(probe)} ${shellQuote(moduleId)}`;
}

/** @param {string} text */
function shellQuote(text) {
  return `'${text.split("'").join(`'\\''`)}'`;
}

/** @param {string} file */
function pathToUrl(file) {
  return `file://${file.split(path.sep).join('/')}`;
}

/** @param {string} name */
function sanitise(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'journey';
}

// ---------------------------------------------------------------------------
// Turning a run into observations
// ---------------------------------------------------------------------------

/**
 * Everything a run saw, as observations.
 *
 * Split fine on purpose. One observation holding "here is everything that happened" means
 * any change anywhere reports as one enormous difference, and the agent reading it has to
 * work out which part moved. One observation per file, per program started, per host
 * reached for, means the difference names itself.
 *
 * @param {object} input
 * @param {import('./contract.js').Journey} input.journey
 * @param {CommandResult} input.result
 * @param {TreeSnapshot} input.before
 * @param {TreeSnapshot} input.after
 * @param {WatchedEvents} input.watched
 * @param {import('./contract.js').RunContext} input.ctx
 * @param {{dirs: string[], projectRoot?: string, ports?: number[]}} input.footprint
 * @returns {Promise<import('./contract.js').Observation[]>}
 */
export async function describeRun(input) {
  const { journey, result, watched, ctx, footprint } = input;
  /** @type {import('./contract.js').Observation[]} */
  const out = [];
  const id = journey.name;

  // ---- what it printed
  for (const [where, raw, channel, sentence, nothing] of /** @type {const} */ ([
    ['to the screen', result.stdout, 'results', 'printed to the screen', 'printed nothing at all'],
    ['as a complaint', result.stderr, 'complaints', 'complained about', 'complained about nothing'],
  ])) {
    const text = undoOurFootprint(raw, footprint);
    const kept = trimForStorage(text);
    let evidence;
    if (kept.truncated) {
      evidence = path.join(ctx.evidenceDir, `${sanitise(id)}-${sanitise(where)}.txt`);
      try {
        await fsp.mkdir(ctx.evidenceDir, { recursive: true });
        await fsp.writeFile(evidence, text, 'utf8');
      } catch { evidence = undefined; }
    }
    out.push(observation({
      channel,
      path: joinPath('cli', id, where === 'to the screen' ? 'stdout' : 'stderr'),
      value: kept.text,
      says: text === ''
        ? `"${journey.describe}" ${nothing}.`
        : `What "${journey.describe}" ${sentence}${
            kept.truncated
              ? `. It is ${sizeBucket(kept.bytes)}, so only the two ends were kept and compared. A change confined to the middle that does not change its length would NOT be seen here; the whole of it is in the evidence file`
              : ''
          }.`,
      evidence,
      journey: id,
      // Truncation is missing coverage and has to be counted as such. Left unsaid, a break
      // buried in the middle of a big output is a silence that reads like an all-clear.
      covered: kept.truncated ? false : undefined,
      reason: kept.truncated ? 'too big' : undefined,
    }));
  }

  // ---- how it finished
  out.push(observation({
    channel: 'complaints',
    path: joinPath('cli', id, 'exit'),
    value: result.timedOut ? 'killed for taking too long' : (result.signal ? `killed by ${result.signal}` : result.code),
    says: result.timedOut
      ? `"${journey.describe}" was still running when its time ran out, so it was stopped.`
      : result.signal
        ? `"${journey.describe}" was killed by ${result.signal} rather than finishing on its own.`
        : result.code === 0
          ? `"${journey.describe}" finished cleanly.`
          : `"${journey.describe}" finished with exit code ${result.code}, which means it thinks something went wrong.`,
  }));

  // ---- what it left behind
  const changes = compareTrees(input.before, input.after);
  for (const change of changes) {
    out.push(observation({
      channel: 'effects',
      path: joinPath('file', id, change.file),
      value: change.what === 'deleted' ? 'deleted' : { what: change.what, contents: change.now ?? '' },
      says: change.what === 'deleted'
        ? `"${journey.describe}" deleted ${change.file}.`
        : `"${journey.describe}" ${change.what} ${change.file}. Only the contents are compared, so rewriting the same bytes is not a change.`,
    }));
  }
  out.push(observation({
    channel: 'counters',
    path: joinPath('count', id, 'files touched'),
    value: changes.length,
    says: changes.length === 0
      ? `"${journey.describe}" left the folder exactly as it found it.`
      : `"${journey.describe}" created, changed or deleted ${changes.length} file${changes.length === 1 ? '' : 's'}.`,
  }));

  // ---- what else it started, and what it tried to reach
  if (watched.inForce) {
    for (const [command, times] of [...watched.ran].sort()) {
      out.push(observation({
        channel: 'effects',
        path: joinPath('proc', id, undoOurFootprint(command, footprint)),
        value: times,
        says: `"${journey.describe}" started ${command}${times > 1 ? ` ${times} times` : ''}.`,
      }));
    }
    /** @type {Map<string, number>} */
    const hosts = new Map();
    for (const attempt of watched.reachedOut) {
      const key = attempt.port ? `${attempt.host}:${attempt.port}` : attempt.host;
      hosts.set(key, (hosts.get(key) ?? 0) + 1);
    }
    for (const [host, times] of [...hosts].sort()) {
      out.push(observation({
        channel: 'effects',
        path: joinPath('net', id, host),
        value: `tried ${times} time${times === 1 ? '' : 's'}, refused every time`,
        says: `"${journey.describe}" tried to connect to ${host} and was refused. What it asked for is compared; whether it would have worked is not, because it was never allowed to happen.`,
        covered: false,
        reason: 'irreversible',
      }));
    }
    if (watched.settingsRead.length > 0) {
      out.push(observation({
        channel: 'effects',
        path: joinPath('proc', id, 'environment read'),
        value: watched.settingsRead,
        says: `The environment variables "${journey.describe}" looked at. A new one appearing here means it started depending on something it did not depend on before.`,
      }));
    }
  } else {
    out.push(notCovered({
      channel: 'effects',
      path: joinPath('net', id, 'watched at all'),
      reason: 'not supported here',
      says: `Nothing was watching "${journey.describe}" from the inside — it is not a Node program, or it replaced the environment it was started with. Its files and its output were still checked exactly; its outbound calls and the programs it started were not.`,
    }));
  }

  // ---- how long. Recorded, never compared. See howLongItTook in contract.js for the
  // measurement that settled this: on an idle machine these fixtures run 48-96ms against a
  // rung boundary at 100ms, so any load at all crossed it and invented a difference.
  out.push(howLongItTook({
    channel: 'counters',
    path: joinPath('count', id, 'duration'),
    ms: result.ms,
    what: `"${journey.describe}"`,
    journey: id,
  }));

  return out;
}

/**
 * The exported API surface of a library, one observation per name.
 *
 * The whole surface as one blob would report a single enormous difference the moment
 * anything moved, and an agent reading it would have to diff the blob itself. One
 * observation per export means a removed function names itself, and a function that quietly
 * grew a required argument names itself too — which is the break nobody notices until a
 * caller in another repo falls over.
 *
 * @param {import('./contract.js').Journey} journey
 * @param {CommandResult} result
 * @returns {import('./contract.js').Observation[]}
 */
export function apiSurface(journey, result) {
  /** @type {Record<string, string>} */
  let surface;
  try {
    surface = JSON.parse(result.stdout);
  } catch {
    return [notCovered({
      channel: 'results',
      path: joinPath('export', journey.name, 'readable at all'),
      reason: 'crashed',
      says: `"${journey.describe}" could not be imported, so nothing is known about what it exports. Whatever it printed instead is under "printed".`,
    })];
  }
  const names = Object.keys(surface).sort();
  /** @type {import('./contract.js').Observation[]} */
  const out = names.map((name) => observation({
    channel: 'results',
    path: joinPath('export', journey.name, name),
    value: surface[name],
    says: `The module exports "${name}", which is ${surface[name]}. If this changes, anything calling it from outside has to change too.`,
  }));
  out.push(observation({
    channel: 'counters',
    path: joinPath('count', journey.name, 'exports'),
    value: names.length,
    says: `"${journey.describe}" exports ${names.length} name${names.length === 1 ? '' : 's'}.`,
  }));
  return out;
}

/**
 * A scratch folder under the system temp directory, for callers that do not have one.
 * @param {string} [label]
 */
export async function scratchFolder(label = 'staysfixed') {
  return fsp.mkdtemp(path.join(os.tmpdir(), `${label}-`));
}

/** True when a path exists. Small enough to inline, useful enough to name. */
export function exists(/** @type {string} */ file) {
  return fs.existsSync(file);
}
