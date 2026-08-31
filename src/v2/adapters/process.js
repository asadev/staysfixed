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
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  defineAdapter, howLongItTook, joinPath, notCovered, observation, sizeBucket,
  trimForStorage, undoOurFootprint,
} from './contract.js';
// The harvest writes the test-file steps this adapter walks, and it owns reading a runner's
// output back. One place on purpose: a journey read differently from the way it was
// harvested is not the same journey.
import { quietenRunnerOutput, readChecks } from '../journeys/from-suite.js';

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
    "const loopback = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0']);",
    "try {",
    "  const net = require('node:net');",
    "  const connect = net.Socket.prototype.connect;",
    "  net.Socket.prototype.connect = function (...args) {",
    "    // Node normalises the arguments before they ever reach here, so what arrives is",
    "    // usually the ARRAY [options, callback] and not the port and host somebody typed.",
    "    // Reading `.host` off that array gives undefined, and an empty host used to mean",
    "    // 'nowhere named, therefore this machine' - so every fetch, every http.get and every",
    "    // net.connect walked straight out through a boundary that then reported nothing at",
    "    // all. Measured on 2026-08-30: all three got a 200 back from the open internet and",
    "    // the watcher's report was empty. Unwrap it first, and treat a shape nobody",
    "    // recognises as somewhere to refuse rather than somewhere to allow, because a",
    "    // boundary that fails open is not a boundary.",
    "    const given = Array.isArray(args[0]) ? args[0][0] : args[0];",
    "    const options = typeof given === 'object' && given !== null ? given : null;",
    "    const host = options ? String(options.host ?? '') : String(args[1] ?? '');",
    "    const port = options ? options.port : given;",
    "    const readable = options !== null || typeof given === 'number' || typeof given === 'string';",
    "    // A socket file is on this machine by definition, and a port with no host beside it",
    "    // is the one case where 'nowhere named' really does mean here.",
    "    const local = Boolean(options && options.path) || (readable && (host === '' || loopback.has(host)));",
    "    if (local && settings.allowLoopback) return connect.apply(this, args);",

    "    write('reached out', { host: host || 'somewhere it did not name', port: port ?? null });",
    "    // Refused, not allowed through. Whatever this was going to do out there, it does not",
    "    // do it twice, and the run is reported as having a hole rather than as having passed.",
    "    //",
    "    // HOW the refusal arrives matters as much as that it happens. Emitting 'error' on the",
    "    // socket ourselves reads correctly and kills the product: at that moment nothing is",
    "    // listening on the socket yet, and in Node an 'error' event with no listener is a",
    "    // thrown exception. `http.get` and `https.get` on Node 22 - the floor this package",
    "    // declares in its own engines field - and a bare `net.connect` on EVERY version all",
    "    // died that way, exit 1, and the run then reported the product as broken. A tool",
    "    // blaming a product for something the tool itself did is the exact failure this whole",
    "    // package exists to prevent. Measured 2026-08-30 against the published 0.8.0 watcher;",
    "    // its own CI had been red on this for four releases and nobody read it.",
    "    //",
    "    // So the refusal is made real rather than simulated: the socket is pointed at a port on",
    "    // this machine that nothing can be listening on, and the operating system produces the",
    "    // refusal through Node's own plumbing - by which time every listener the runtime wires",
    "    // up is in place. The product gets an ordinary ECONNREFUSED, which is exactly what it",
    "    // would get if the host were unreachable, and cannot tell the difference.",
    "    const named = host || 'an unnamed host';",
    "    const explain = 'Stays Fixed refused a connection to ' + named + ': nothing irreversible is allowed out during a check.';",
    "    const refusal = () => Object.assign(new Error(explain), { code: 'ECONNREFUSED', refusedBy: 'staysfixed' });",
    "    // Said in the error the product actually catches, without swallowing it: prepending a",
    "    // listener rewrites the message and still leaves every other handler to run as it would.",
    "    this.prependListener('error', (e) => {",
    "      if (e && e.code === 'ECONNREFUSED') { e.message = explain; e.refusedBy = 'staysfixed'; }",
    "    });",
    "    // Belt and braces. If something really is listening down there, the connection is cut",
    "    // before one byte can cross it: a boundary that fails open is not a boundary.",
    "    this.prependOnceListener('connect', () => { this.destroy(refusal()); });",
    "    // And a machine where that port is silently dropped rather than refused would hang",
    "    // here instead of failing, which is worse than the bug this replaced: a check that",
    "    // never finishes tells you nothing at all. A refusal is owed promptly, so if the",
    "    // operating system has not produced one shortly, produce it. Safe to do now, and only",
    "    // now, because the listener above means this can never be an unhandled error.",
    "    const soon = setTimeout(() => { if (!this.destroyed) this.destroy(refusal()); }, 250);",
    "    if (typeof soon.unref === 'function') soon.unref();",
    "    this.once('close', () => clearTimeout(soon));",
    "    try {",
    "      return connect.call(this, { port: 1, host: '127.0.0.1' });",
    "    } catch {",
    "      // Even the refusal failed. Still never throw into the product.",
    "      process.nextTick(() => { if (!this.destroyed) this.destroy(refusal()); });",
    "      return this;",
    "    }",
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
    "  const note = (key) => { if (typeof key === 'string') settingsRead.add(key); };",
    "  // EVERY trap forwards, and every trap that changes something forwards with the TARGET",
    "  // as the receiver. A proxy carrying only the traps we happen to care about is not a",
    "  // window, it is a wall with a window in it. With no `set` trap, `process.env.X = 'y'`",
    "  // takes the default, which reflects onto the PROXY, which lands on defineProperty",
    "  // against Node's own env object and quietly does nothing at all. npm sets",
    "  // npm_lifecycle_event and its npm_config_ family that way, reads them back, finds",
    "  // nothing and exits 1 without printing one word - so every product whose start command",
    "  // went through npm died here, and the report said, in good faith, that the product",
    "  // would not boot. `staysfixed init` writes `npm run start` by default, so this was the",
    "  // default path. Found by installing the published copy and pointing it at an ordinary",
    "  // Express app.",
    "  const watched = new Proxy(real, {",
    "    get(target, key) { note(key); return Reflect.get(target, key); },",
    "    has(target, key) { note(key); return Reflect.has(target, key); },",
    "    set(target, key, value) { return Reflect.set(target, key, value); },",
    "    deleteProperty(target, key) { return Reflect.deleteProperty(target, key); },",
    "    ownKeys(target) { return Reflect.ownKeys(target); },",
    "    getOwnPropertyDescriptor(target, key) { return Reflect.getOwnPropertyDescriptor(target, key); },",
    "    defineProperty(target, key, descriptor) { return Reflect.defineProperty(target, key, descriptor); },",
    "    getPrototypeOf(target) { return Reflect.getPrototypeOf(target); },",
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
 * @property {number} torn                 Lines of the report that could not be read back.
 */

/**
 * Read back what the watcher saw. An empty or missing file is not an error: it is the
 * answer to "was anything watching", and the caller reports coverage accordingly.
 * @param {string} reportFile
 * @returns {Promise<WatchedEvents>}
 */
export async function readWatcher(reportFile) {
  /** @type {WatchedEvents} */
  const seen = { inForce: false, ran: new Map(), reachedOut: [], settingsRead: [], torn: 0 };
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
    // A half-written line is a program that started or a host that was reached and is now
    // reported as neither. Counted, so the run can say it saw less than it saw.
    try { event = JSON.parse(line); } catch { seen.torn += 1; continue; }
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

/**
 * Folders left out of a snapshot: enormous, and not what anybody means by "it wrote a file".
 *
 * `node_modules` is the one that had to be argued out rather than assumed. A build step that
 * writes in there — a patch, a generated client, a native rebuild — is a real change to what
 * ships, and leaving it out means that change is invisible. It stays out anyway, because
 * fingerprinting thirty thousand files twice per journey per build turns a check that takes
 * seconds into one that takes minutes, and a check nobody runs catches nothing.
 *
 * What is NOT acceptable is skipping it quietly. Every run says which folders it did not
 * watch, as missing coverage rather than as a clean result, and `process.alsoWatch` takes any
 * of these back off the list for a project that needs it. See `snapshotSkip`.
 */
export const SNAPSHOT_SKIP = new Set(['node_modules', '.git', '.staysfixed']);

/**
 * The folders this run will not watch, after the project has had its say.
 *
 * @param {Record<string, unknown>|undefined} config   The `process` section of the settings.
 * @returns {Set<string>}
 */
export function snapshotSkip(config) {
  const skip = new Set(SNAPSHOT_SKIP);
  const alsoWatch = Array.isArray(config?.alsoWatch) ? config.alsoWatch : [];
  for (const name of alsoWatch) skip.delete(String(name));
  return skip;
}

/** A file recorded by its size because hashing it would have meant reading past the ceiling. */
export const BY_SIZE_ALONE = 'compared by size alone, ';

/** A file or folder nothing could read. Kept in the snapshot so it is never a silence. */
export const COULD_NOT_READ = 'could not be looked at: ';

/**
 * Why a path would not open, in words rather than in an errno.
 * @param {unknown} error
 * @returns {string}
 */
function whyItWouldNotOpen(error) {
  const code = String(/** @type {{code?: unknown}} */ (error)?.code ?? '');
  if (code === 'EACCES' || code === 'EPERM') return 'no permission to read it';
  if (code === 'EIO') return 'the disk would not answer';
  if (code === 'ELOOP') return 'the symlinks point at each other';
  if (code === 'EMFILE' || code === 'ENFILE') return 'this machine ran out of open files';
  if (code === 'ENAMETOOLONG') return 'the name is longer than this machine allows';
  if (code !== '') return code;
  return error instanceof Error ? error.message : String(error);
}

/** A path that is simply not there any more was not there to begin with. */
const isGone = (/** @type {unknown} */ error) => {
  const code = String(/** @type {{code?: unknown}} */ (error)?.code ?? '');
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/**
 * Fingerprint one file that is bigger than the read-it-all-at-once limit.
 *
 * Streamed rather than read into memory, so the size of the file is the machine's problem and
 * not this process's. There is still a ceiling, because a file measured in tens of gigabytes
 * would be read twice per journey per build and nobody would wait for it — and above that
 * ceiling the answer is the size bucket, with the marker that says so, so the run can report
 * it as a hole instead of as a match.
 *
 * @param {string} file
 * @param {number} size
 * @param {number} ceilingBytes
 * @returns {Promise<string>}
 */
async function fingerprintBigFile(file, size, ceilingBytes) {
  if (size > ceilingBytes) return `${BY_SIZE_ALONE}${sizeBucket(size)}`;
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex').slice(0, 16);
}

/**
 * Fingerprint every file under a folder.
 *
 * By CONTENTS, never by timestamp or size. A run that rewrites a file with the same bytes
 * has not changed anything, and reporting it as a change is how a tool teaches people to
 * ignore it.
 *
 * A big file is streamed rather than bucketed. It used to be recorded as "too big to
 * fingerprint, tens of megabytes", which meant a build that wrote a COMPLETELY DIFFERENT
 * forty-megabyte bundle compared equal to the old one as long as the size landed in the same
 * bucket — the exact file a bundler rewrites, silently passing. Reading a large file is cheap
 * next to running the whole product twice, so it is read.
 *
 * Anything that cannot be read at all — a folder with no permission on it, a disk that will
 * not answer — goes into the snapshot as its own entry rather than being dropped. Dropping a
 * folder takes everything under it with it, and a file nobody looked at cannot be seen
 * changing; the run reports those as holes.
 *
 * @param {string} root
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]     Read files up to this size in one go. Default 8MB.
 * @param {number} [opts.ceilingBytes] Above this, record the size instead of hashing. Default 4GB.
 * @param {Set<string>} [opts.skip]
 * @returns {Promise<TreeSnapshot>}
 */
export async function snapshotTree(root, opts = {}) {
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const ceilingBytes = opts.ceilingBytes ?? 4 * 1024 * 1024 * 1024;
  const skip = opts.skip ?? SNAPSHOT_SKIP;
  /** @type {TreeSnapshot} */
  const snapshot = new Map();

  /** @param {string} dir */
  const walk = async (dir) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      // A folder that will not open used to be dropped here without a word, and everything
      // under it with it — so a file inside it could be created, rewritten or deleted and the
      // run would report the folder as unchanged. It goes in the snapshot instead, and
      // `describeRun` reports it as a hole.
      if (!isGone(error)) {
        const at = path.relative(root, dir);
        snapshot.set(at === '' ? '.' : at, `${COULD_NOT_READ}${whyItWouldNotOpen(error)}`);
      }
      return;
    }
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
        snapshot.set(relative, stat.size > maxBytes
          ? await fingerprintBigFile(full, stat.size, ceilingBytes)
          : crypto.createHash('sha256').update(await fsp.readFile(full)).digest('hex').slice(0, 16));
      } catch (error) {
        // A file that vanished between the listing and the read was not there to begin with.
        // Anything else is a file nobody looked at, and staying quiet about it reads exactly
        // like "it did not change".
        if (!isGone(error)) snapshot.set(relative, `${COULD_NOT_READ}${whyItWouldNotOpen(error)}`);
      }
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
// Never waiting for ever
// ---------------------------------------------------------------------------

/**
 * The three pieces below exist because of one measured symptom, and they are used by every
 * adapter in this folder that starts a program.
 *
 * On 2026-08-30 an Electron check produced no output at all and simply never came back. On
 * 2026-08-31 it was reproduced twice, deliberately, against a fake app that starts, prints one
 * line and leaves a `sleep` behind that inherited its standard output:
 *
 *   1. `runCommand` was asked for a two second limit and had still not returned twenty
 *      seconds later. Its limit fired exactly on time and killed the shell — but the promise
 *      is settled by the child's `close` event, and `close` does not mean "the program ended",
 *      it means "nobody is holding its pipes any more". The orphan was holding them, so
 *      `close` never arrived and the limit may as well not have existed.
 *
 *   2. A run that had finished all of its work — the app opened, read, closed and PROVED gone,
 *      the teardown printing "The next run starts alone" — then sat there for ever, because
 *      the same orphan was still holding the writing end of a pipe this process was reading.
 *      A pipe being read keeps Node's event loop awake, so the tool never exited.
 *
 * `child.js` says the same thing about servers started from a start command, and it is right:
 * the whole group has to be signalled and the pipes have to be TORN DOWN rather than trusted
 * to close. These are the same two rules for the children that adapters start directly.
 *
 * The reason this matters more than an ordinary bug: a tool somebody runs before a release
 * that never comes back cannot be told apart from a tool that is broken, or from a product
 * that is broken. A run that gives up after a bounded wait and says exactly what it was
 * waiting for is worse news and better information.
 */

/**
 * A number of milliseconds that is definitely a number of milliseconds.
 *
 * Every limit in this tool can be set from a project's own settings file, and a settings file
 * is written by a person. `Number("30s")` is NaN — and NaN is the most dangerous value a limit
 * can take, because `Date.now() + NaN` is NaN, `Date.now() > NaN` is false for ever, and a
 * loop written around that runs until somebody kills it and never says why. A limit that is
 * not a real, positive, finite number becomes the default instead, and one that is absurd is
 * capped, because "wait thirty days" is a typo every time.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} [ceiling]
 * @returns {number}
 */
export function boundedMs(value, fallback, ceiling = 30 * 60_000) {
  const asked = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(asked) || asked <= 0) return fallback;
  return Math.min(asked, ceiling);
}

/**
 * A count that is definitely a count. The same guard as `boundedMs`, for the numbers that are
 * a number of times round a loop rather than a number of milliseconds.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} ceiling
 * @returns {number}
 */
export function boundedCount(value, fallback, ceiling) {
  const asked = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(asked) || asked < 1) return fallback;
  return Math.min(Math.round(asked), ceiling);
}

/**
 * Let go of a child completely, so nothing it left behind can hold this tool open.
 *
 * The pipes are destroyed rather than left to close on their own, because whatever the child
 * started inherited the writing end of them and a survivor this file did not start must not
 * be able to keep a finished check awake. This is the same tear-down `child.js` does for a
 * start command's server, for the same measured reason.
 *
 * @param {import('node:child_process').ChildProcess|null|undefined} child
 * @returns {void}
 */
export function letGoOf(child) {
  if (!child) return;
  for (const stream of [child.stdout, child.stderr, child.stdin]) {
    try { stream?.destroy(); } catch { /* already gone, which is the outcome wanted */ }
  }
  try { child.unref(); } catch { /* not every child can be unreferenced; it has been let go either way */ }
}

/**
 * Stop a child, and everything it started, as firmly as the platform allows.
 *
 * Signalling a negative pid signals the whole process GROUP, which is the only way to reach
 * the grandchildren — a start command's shell runs npm which runs node, and killing the shell
 * leaves the other two running. That only works for a child that was started in a group of
 * its own, so `group` is the caller's promise that it spawned with `detached`. Passing it for
 * a child that is in OUR group would ask this process to kill itself.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 * @param {boolean} group
 * @returns {void}
 */
export function tellItToStop(child, signal, group) {
  const pid = child.pid;
  if (group && pid && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch { /* no group of that name, or already gone; fall through and ask the one process */ }
  }
  try { child.kill(signal); } catch { /* already gone, which is the outcome wanted */ }
}

/**
 * Wait for a child to be GONE, with a limit that always fires and always says something.
 *
 * The important line in here is that it settles on `exit` and not on `close`. `exit` means the
 * program ended. `close` means the program ended AND nobody anywhere is holding its pipes any
 * more, which is a completely different claim and one an orphaned grandchild can refuse for
 * ever. Every `close`-shaped wait in this folder was a hang waiting to happen, and one of them
 * was measured hanging on 2026-08-31.
 *
 * After `exit` the last of the output is still worth having, so there is a short drain — but
 * it is a drain with a clock on it, not a wait.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {object} [opts]
 * @param {number} [opts.limitMs]     How long the program itself may take. Default two minutes.
 * @param {number} [opts.drainMs]     How long to wait for the last of its output after it ends.
 * @param {number} [opts.graceMs]     Between asking it to stop and insisting.
 * @param {boolean} [opts.group]      True only when it was spawned with `detached`.
 * @param {string} [opts.what]        Named in the sentence, so a give-up can be acted on.
 * @returns {Promise<{code: number|null, signal: string|null, gaveUp: boolean, why: string}>}
 */
export function endOfChild(child, opts = {}) {
  const limitMs = boundedMs(opts.limitMs, 120_000);
  const drainMs = boundedMs(opts.drainMs, 250, 10_000);
  const graceMs = boundedMs(opts.graceMs, 2000, 60_000);
  const group = opts.group === true;
  const what = opts.what ?? 'the program it started';

  return new Promise((resolve) => {
    let settled = false;
    /** @type {ReturnType<typeof setTimeout>[]} */
    const timers = [];
    /** @param {number} ms @param {() => void} fn */
    const later = (ms, fn) => {
      const timer = setTimeout(fn, ms);
      // The limit itself must never be the thing holding the loop open.
      if (typeof timer.unref === 'function') timer.unref();
      timers.push(timer);
      return timer;
    };

    // Set the moment the limit fires, and read by every path out of here. A program that
    // stops promptly when it is asked to still ran out of time, and reporting that as a clean
    // exit is how a run that checked nothing comes back looking green.
    let ranOutOfTime = false;
    const gaveUpBecause = () => `Stays Fixed gave up waiting for ${what} after ${Math.round(limitMs / 1000)} seconds and stopped it. Nothing it would have done after that point was checked.`;

    /** @param {string} why */
    const finish = (why) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      letGoOf(child);
      resolve({ code: child.exitCode, signal: child.signalCode, gaveUp: ranOutOfTime, why: ranOutOfTime ? gaveUpBecause() : why });
    };

    child.once('close', () => finish(`${what} finished.`));
    child.once('exit', () => {
      later(drainMs, () => finish(`${what} finished, and the last of its output was cut off after ${Math.round(drainMs)}ms because something it started was still holding its pipes open.`));
    });
    child.once('error', (error) => finish(`${what} could not be run: ${error.message}`));

    later(limitMs, () => {
      ranOutOfTime = true;
      tellItToStop(child, 'SIGTERM', group);
      later(graceMs, () => {
        tellItToStop(child, 'SIGKILL', group);
        // Even SIGKILL cannot make a pipe close while an orphan holds it, so this is where
        // the waiting stops whatever anything else does.
        finish(gaveUpBecause());
      });
    });

    // It may already be over before anybody looked.
    if (child.exitCode !== null || child.signalCode !== null) {
      later(drainMs, () => finish(`${what} had already finished.`));
    }
  });
}

/**
 * Put a limit on any wait at all, and make the limit say what it was waiting for.
 *
 * For the waits that are not a child process: a socket that accepts a connection and then goes
 * quiet, a window that never opens, a handler that never answers. The sentence is the whole
 * point of it — "it timed out" and "it never came back" are the same non-answer, while "it
 * gave up after sixty seconds waiting for the app to open its main-process debugging
 * connection" is something a person can act on.
 *
 * `what` may be a function, so that a wait made of several stages can name the stage it was
 * actually stuck in rather than the whole job. "It gave up opening the app" sends somebody
 * looking everywhere; "it gave up while waiting for the app to open a window" sends them to one
 * place.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {{limitMs: number, what: string|(() => string), fallbackMs?: number}} opts
 * @returns {Promise<T>}
 */
export function withLimit(promise, opts) {
  const limitMs = boundedMs(opts.limitMs, opts.fallbackMs ?? 60_000);
  /** @type {ReturnType<typeof setTimeout>} */
  let timer;
  const giveUp = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Stays Fixed gave up after ${Math.round(limitMs / 1000)} seconds waiting for ${typeof opts.what === 'function' ? opts.what() : opts.what}.`)),
      limitMs,
    );
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, giveUp]).finally(() => clearTimeout(timer));
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
 * @property {string} [couldNotStart]  Why the command never ran at all. A missing exit code
 *                                     means two different things without this — killed, or
 *                                     never started — and the second one compares equal on
 *                                     both builds, which reads exactly like a clean run.
 */

/**
 * Run a command and wait for it, with a hard limit that is actually hard.
 *
 * Killed with SIGTERM first and SIGKILL after a grace period, because a program that traps
 * SIGTERM and hangs would otherwise hold the whole run open — and killed is reported as
 * killed, never quietly as an exit code.
 *
 * Two things in here are not decoration, and both were measured on 2026-08-31 against a start
 * command that leaves an orphan behind — the shape `npm run dev` has, and the shape that had
 * already been recorded once as an Electron check that gave no output at all and never came
 * back.
 *
 * The command runs in a process GROUP of its own, because the thing spawned is a shell and the
 * program is its child or grandchild. Killing the shell leaves the program running, and the
 * limit then achieves nothing at all. This is the same finding `child.js` made about servers.
 *
 * And the answer is settled by `endOfChild`, which waits for the command to END rather than
 * for its pipes to close. Waiting for `close` was the actual bug: asked for a two second
 * limit, this function had not returned twenty seconds later, because the orphan was still
 * holding the writing end of the pipes and `close` will not fire until every last holder lets
 * go. The limit fired perfectly and nobody was listening.
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
export async function runCommand(command, opts) {
  const timeoutMs = boundedMs(opts.timeoutMs, 120000);
  const started = Date.now();
  // Its own process group, so the limit can reach the program and not only the shell in front
  // of it. There are no groups of this kind on Windows, where signalling the child is the best
  // that can be done.
  const inItsOwnGroup = process.platform !== 'win32';
  const child = spawn(command, {
    shell: true,
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: inItsOwnGroup,
  });

  /** @type {Buffer[]} */
  const out = [];
  /** @type {Buffer[]} */
  const err = [];

  child.stdout?.on('data', (chunk) => out.push(chunk));
  child.stderr?.on('data', (chunk) => err.push(chunk));
  if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  else child.stdin?.end();

  /** @type {string|undefined} */
  let couldNotStart;
  child.on('error', (error) => {
    // Nothing ran. Said out loud rather than folded into "exit code null", which is what a
    // killed run also looks like — and which is identical on both builds, so the comparison
    // saw no difference and the run passed for the worst possible reason.
    couldNotStart = error.message;
    err.push(Buffer.from(`${error.message}\n`));
  });

  // The whole group, not the shell. Stopping the shell and leaving npm and node running is
  // how a cancelled run leaves a dev server on somebody's machine.
  const onAbort = () => { tellItToStop(child, 'SIGTERM', inItsOwnGroup); };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  const ended = await endOfChild(child, {
    limitMs: timeoutMs,
    graceMs: 5000,
    group: inItsOwnGroup,
    // Both ends of the command, never just the first eighty characters. A command that lives
    // under a long scratch path is all path for the first eighty characters, so cutting from
    // the front produces a sentence naming a FOLDER and never the thing it gave up on.
    what: `"${trimForStorage(String(command), 120).text}"`,
  });
  opts.signal?.removeEventListener('abort', onAbort);

  if (ended.gaveUp) err.push(Buffer.from(`${ended.why}\n`));

  return {
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8'),
    code: ended.code,
    signal: ended.signal,
    timedOut: ended.gaveUp,
    ms: Date.now() - started,
    ...(couldNotStart ? { couldNotStart } : {}),
  };
}

// ---------------------------------------------------------------------------
// Making the scratch copy
// ---------------------------------------------------------------------------

/**
 * Folders not worth copying into a scratch build.
 *
 * The bar for this list is deliberately high: anything skipped that turns out to matter
 * produces a run that passes for the wrong reason, and a false pass is the one failure
 * this whole tool exists to prevent. So it holds only things that are *regenerated on
 * demand and read by nothing* — caches and coverage reports — plus the two that are ours
 * and git's. Build output, `node_modules`, lockfiles, fixtures and configuration are all
 * copied, because a check that runs against a different set of files than the real
 * product is not checking the real product.
 */
export const SKIP_BY_DEFAULT = [
  '.git',
  '.staysfixed',
  '.turbo',
  '.nyc_output',
  'coverage',
  '.pytest_cache',
  '__pycache__',
  '.DS_Store',
];

/**
 * Copy a project into a scratch folder so a run can write whatever it likes.
 *
 * ## Why this is a clone and not a copy
 *
 * The real projects this gets pointed at are enormous — the one it was built against is
 * twelve gigabytes, most of it an iOS build folder. Copying that byte by byte before every
 * single run would take minutes and fill a disk, and a check nobody can afford to run is
 * a check nobody runs.
 *
 * So it asks the filesystem to *clone* instead: on macOS that is `cp -c`, one APFS call
 * per file that copies no bytes at all and shares the blocks until something writes to
 * them; on Linux it is `cp --reflink=auto`, which does the same where the filesystem
 * supports it and a real copy where it does not. Measured on the twelve-gigabyte project:
 * the six-hundred-megabyte `node_modules` alone went from a long wait to under three
 * seconds, and used no extra disk.
 *
 * Never a symlink and never a hardlink. Both of those point back at the real project,
 * which is the one thing this function exists to protect — the first thing a broken build
 * does is write to a file, and with a link that write lands in his actual working tree.
 *
 * It falls back to a plain recursive copy whenever the clone is unavailable or fails, so
 * a filesystem without reflinks is slower here and never wrong.
 *
 * @param {string} from
 * @param {string} to
 * @param {object} [opts]
 * @param {string[]} [opts.skip]     Names not to copy. See `SKIP_BY_DEFAULT`.
 * @param {string[]} [opts.also]     Extra names to skip, on top of the defaults.
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{copied: boolean, why: string, cloned: boolean, tookMs: number, skipped: string[]}>}
 */
export async function copyForScratch(from, to, opts = {}) {
  const began = Date.now();
  const skip = new Set([...(opts.skip ?? SKIP_BY_DEFAULT), ...(opts.also ?? [])]);
  await fsp.mkdir(to, { recursive: true });

  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await fsp.readdir(from, { withFileTypes: true });
  } catch (error) {
    return {
      copied: false, cloned: false, tookMs: Date.now() - began, skipped: [],
      why: `The project could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const skipped = entries.filter((e) => skip.has(e.name)).map((e) => e.name);
  const wanted = entries.filter((e) => !skip.has(e.name));

  let cloned = 0;
  let copied = 0;
  for (const entry of wanted) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (await cloneOne(source, target, opts.signal)) {
      cloned += 1;
      continue;
    }
    try {
      await fsp.cp(source, target, {
        recursive: true,
        force: true,
        dereference: false,
        preserveTimestamps: true,
        filter: (p) => !skip.has(path.basename(p)),
      });
      copied += 1;
    } catch (error) {
      return {
        copied: false, cloned: cloned > 0, tookMs: Date.now() - began, skipped,
        why: `The project could not be copied into a scratch folder: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const tookMs = Date.now() - began;
  const how = cloned > 0 && copied === 0
    ? 'The project was cloned into a scratch folder — the filesystem shared the blocks, so no bytes moved'
    : cloned > 0
      ? 'The project was cloned into a scratch folder where the filesystem allowed it and copied where it did not'
      : 'The project was copied into a scratch folder';
  const left = skipped.length ? ` Left behind: ${skipped.join(', ')}.` : '';
  return {
    copied: true,
    cloned: cloned > 0,
    tookMs,
    skipped,
    why: `${how} (${(tookMs / 1000).toFixed(1)}s), so the run can write anywhere it likes without touching the real one.${left}`,
  };
}

/**
 * Ask the filesystem to clone one entry. False means "it would not", not "it broke".
 *
 * @param {string} source
 * @param {string} target
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
async function cloneOne(source, target, signal) {
  // Windows has no reflink through `cp`, and there is no `cp`. Straight to the fallback.
  if (process.platform === 'win32') return false;
  const args = process.platform === 'darwin'
    ? ['-Rc', source, target]
    : ['-a', '--reflink=auto', source, target];
  let child;
  try {
    child = spawn('cp', args, { stdio: 'ignore', signal });
  } catch {
    return false;
  }
  // Ten minutes is far longer than a clone of a project tree has ever taken and still a limit.
  // `cp` on a network mount that stops answering hangs for ever otherwise, and a copy that
  // never finishes looks to whoever ran the check exactly like the check being broken.
  const ended = await endOfChild(child, { limitMs: 10 * 60_000, what: `copying ${path.basename(source)} into the scratch build` });
  if (!ended.gaveUp && ended.code === 0) return true;
  // A half-written target from a failed clone would make the fallback copy merge into it.
  // Clear it out so the fallback starts from nothing.
  await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
  return false;
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

/**
 * The command a run line actually opens, named the way the code reader names it.
 *
 * These two lists only ever meet here. A command door is read out of package.json and comes
 * out as either `staysfixed` (something the package installs) or `npm run build` (a script),
 * while a journey is named by whoever wrote the settings — "build the app". So a journey
 * carrying nothing but its own name matched no door at all.
 *
 * `pnpm run build` opens the same door as `npm run build`, because the door is the script in
 * package.json and the package manager standing in front of it is not a second door.
 *
 * A line this cannot read plainly — a pipeline, a shell one-liner, anything with an operator
 * in it — gets null instead of a guess. Missing a walked command leaves a job on the queue;
 * naming the wrong one marks a door walked that nobody touched, and that is the single
 * direction the coverage ledger is never allowed to be wrong in.
 *
 * @param {string} run   The command line, exactly as the settings wrote it.
 * @returns {string|null}
 */
export function commandDoorName(run) {
  const line = String(run ?? '').trim();
  if (line === '') return null;
  // An operator means the line runs more than one thing, and this cannot say which of them
  // the door is.
  if (/[|;&<>`$]/.test(line)) return null;
  const words = line.split(/\s+/);
  // FOO=bar in front of a command is the environment it runs in, not the command.
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  // A runner in front fetches or finds the real command and then runs it; the door is what
  // comes after it.
  while (words.length > 1 && (/^(npx|bunx)$/.test(words[0]) || (/^(pnpm|yarn|bun|npm)$/.test(words[0]) && /^(exec|dlx)$/.test(words[1])))) {
    words.splice(0, words[0] === 'npx' || words[0] === 'bunx' ? 1 : 2);
  }
  // Flags to the runner itself — `npx --yes staysfixed` — belong to the runner.
  while (words.length > 1 && words[0].startsWith('-')) words.shift();
  if (words.length === 0) return null;
  const program = path.basename(words[0]);
  const rest = words.slice(1).filter((w) => !w.startsWith('-'));
  if (/^(npm|pnpm|yarn|bun)$/.test(program)) {
    if (words[1] === 'run' && rest[1]) return `npm run ${rest[1]}`;
    // npm's own shorthands for four scripts. `yarn <anything>` is deliberately not read this
    // way: with yarn a bare word may be a script or a command, and this cannot tell.
    if (program !== 'yarn' && rest[0] && /^(test|start|stop|restart)$/.test(rest[0])) return `npm run ${rest[0]}`;
    return null;
  }
  // An interpreter with something after it is running that something, and the door is whatever
  // that file installs as — which this cannot know. Null, rather than reporting a door called
  // "node" that the code reader never found.
  if (words.length > 1 && /^(node|deno|sh|bash|zsh|dash|env|python|python3|ruby|perl)$/.test(program)) return null;
  return program;
}

/**
 * The door fields a command journey's step carries, or nothing when the command line is not
 * plain enough to name one honestly. `door` in the settings overrides the reading, which is
 * the way out for a project whose command line this cannot make sense of.
 *
 * @param {Record<string, unknown>} entry
 * @returns {{door: string, kind: 'command'}|{}}
 */
function doorFields(entry) {
  const named = typeof entry.door === 'string' && entry.door.trim() !== ''
    ? entry.door.trim()
    : commandDoorName(String(entry.run ?? ''));
  return named ? { door: named, kind: /** @type {const} */ ('command') } : {};
}

/** Everything a prepared build needs to remember between journeys. */
const prepared = new Map();

/**
 * The CLI-and-library adapter.
 */
export const processAdapter = defineAdapter({
  name: 'process',
  title: 'CLI tools and libraries',
  describe:
    'Runs a command, imports a module, or walks one of the project\'s own test files, in a scratch copy of the project — and reports what it printed, what it exited with, every file it created or changed, every program it started, every outbound connection it tried — all of which are refused — and roughly how long it took. A test file also reports each of its checks by name and why any failing one failed, so a check that goes red on the new build alone names itself. Outbound calls and started programs are only visible when the thing being run is Node; for anything else those two channels are reported as not checked rather than as clean.',
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
        // `door` and `kind` are how the coverage ledger learns this journey ran that command.
        // Without them a command counted as walked only if an observation landed at its own
        // address, and this adapter writes everything under `cli.<journey name>` — so
        // {"name": "build the app", "run": "npm run build"} produced `cli.build the app.*`
        // against a door addressed `cli.npm run build`, and every command in the project read
        // as never walked on a run that had just walked all of them. The address rule cannot
        // rescue this one: it is switched off for commands on purpose.
        steps: [{
          act: 'run', run: String(entry.run), cwd: entry.cwd, stdin: entry.stdin, env: entry.env,
          ...doorFields(entry),
        }],
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
        // No `door` here on purpose, and it was checked rather than assumed: `apiSurface`
        // writes every exported name at `export.<journey name>.<name>`, which is exactly the
        // branch the ledger already reads exports through, so these doors open on their own.
        // Naming the module as the door instead would claim a door of that name that the code
        // reader never found.
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

    // A project may name more to leave behind — a giant build folder no command reads,
    // say. It can only ADD to the defaults: a setting that could switch off `.git` being
    // skipped would only ever make runs slower.
    const alsoSkip = Array.isArray(ctx.config?.skip) ? ctx.config.skip.map(String) : [];
    const copy = await copyForScratch(build.root, work, { also: alsoSkip, signal: ctx.signal });
    if (copy.copied && copy.tookMs > 20_000) {
      ctx.log?.(
        `Making a scratch copy of this project took ${Math.round(copy.tookMs / 1000)} seconds. ` +
        `If a large folder here is not read by any command, name it under "process.skip" in the config and it will be left behind.`,
      );
    }
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
        // rather than assigned so a project that needs its own options keeps them — and the
        // journey's own NODE_OPTIONS is the one that has to survive, which it did not: this
        // line spread `step.env` and then overwrote it with the OUTER machine's value, so a
        // journey that asked for `--max-old-space-size` got the comment's promise and none of
        // its behaviour.
        NODE_OPTIONS: `${step.env?.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? ''} --import ${pathToUrl(places.watcher)}`.trim(),
      },
    });

    // A step that names nothing to run must say so. Handing `undefined` to a shell runs a
    // command called "undefined", which fails identically on both builds and therefore
    // reports NO difference - a silent nothing that looks exactly like a clean check.
    const nothingToRun = step.act === 'import'
      ? !step.module
      : step.act === 'run-tests'
        ? !step.file || !(step.command || step.run)
        : !step.run;
    if (nothingToRun) {
      return [notCovered({
        channel: 'results',
        path: joinPath('cli', journey.name, 'ran at all'),
        reason: 'refused',
        says:
          `"${journey.describe}" says nothing to run. A command journey needs a "run" with the command line in it, ` +
          `an import journey needs a "module", and a test-file journey needs the "file" it walks and the command ` +
          `that runs it. Nothing was run, and that is a hole, not a pass.`,
      })];
    }

    const runner = /** @type {import('../journeys/from-suite.js').Runner} */ (step.runner ?? 'node:test');
    // The same list for both snapshots, and handed on to the report: a folder that is not
    // watched has to be named in the run that did not watch it, not left to be discovered.
    const skip = snapshotSkip(ctx.config);
    const before = await snapshotTree(places.work, { skip });
    const result = step.act === 'import'
      ? await runCommand(importProbeCommand(String(step.module)), { cwd, env, timeoutMs: journey.timeoutMs ?? 60000, signal: ctx.signal })
      : step.act === 'run-tests'
        ? await runCommand(testFileCommand(step), { cwd, env, timeoutMs: journey.timeoutMs ?? 120000, signal: ctx.signal })
        : await runCommand(String(step.run), { cwd, env, timeoutMs: journey.timeoutMs ?? 120000, stdin: step.stdin, signal: ctx.signal });
    const after = await snapshotTree(places.work, { skip });
    const watched = await readWatcher(reportFile);

    const observations = await describeRun({
      journey, result, before, after, watched, ctx, skipped: [...skip].sort(),
      footprint: { dirs: [places.base, places.tmp, places.home], projectRoot: build.build.root },
      // A test runner narrates its own stopwatch and nothing else moves between two runs of
      // identical bytes, so taking the stopwatch out is what makes the whole of what it
      // printed worth comparing. See `withoutRunnerTiming`.
      quieten: step.act === 'run-tests' ? (text) => quietenRunnerOutput(runner, text) : undefined,
    });
    if (step.act === 'import') observations.push(...apiSurface(journey, result));
    if (step.act === 'run-tests') {
      observations.push(...(await suiteObservations({ journey, step, runner, result, root: places.work })));
    }
    // Only the first step is walked, and until now the rest were dropped without a word — a
    // journey of three steps reported on one of them and read as a clean, complete walk.
    // Nothing here builds a multi-step CLI journey today; a recording or an agent easily
    // could, and a silent drop is how that arrives as a false pass.
    const rest = (journey.steps ?? []).slice(1);
    if (rest.length > 0) {
      observations.push(notCovered({
        channel: 'results',
        path: joinPath('cli', journey.name, 'the rest of its steps'),
        reason: 'not supported here',
        says:
          `"${journey.describe}" has ${rest.length + 1} steps and this adapter walks one command per journey, so ` +
          `${rest.length} of them ${rest.length === 1 ? 'was' : 'were'} not walked: ` +
          `${rest.map((/** @type {any} */ s) => s.run ?? s.module ?? s.file ?? s.act).join(', ')}. ` +
          `Split them into a journey each. This is a hole, not a pass.`,
      }));
    }
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
    // A FILE unless it is really a package. The old rule was "starts with a dot, or has a
    // slash in it" — and `index.js` has neither, so Node was asked for a PACKAGE called
    // "index.js" and answered ERR_MODULE_NOT_FOUND. `staysfixed init` writes exactly
    // `{ module: "index.js" }` for an ordinary package entry, so on those projects this
    // journey failed on every run, failed the SAME way on both builds, produced no
    // difference, and the check said "Nothing that worked has changed" for ever. Measured
    // 2026-08-30. So: if a file of that name is really there, it is a file.
    "const id = process.argv[1];",
    "const { existsSync } = await import('node:fs');",
    "const { fileURLToPath } = await import('node:url');",
    "const asFile = new URL(id, 'file://' + process.cwd() + '/').href;",
    "const onDisk = (() => { try { return existsSync(fileURLToPath(asFile)); } catch { return false; } })();",
    "const m = await import(id.startsWith('.') || id.startsWith('/') || id.includes('/') || onDisk ? asFile : id);",
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
    "process.stdout.write('\\n' + " + JSON.stringify(EXPORTS_MARKER) + " + '\\n' + JSON.stringify(out, null, 2));",
  ].join('\n');
  return `node --input-type=module -e ${shellQuote(probe)} ${shellQuote(moduleId)}`;
}

/**
 * How the probe's answer is told apart from anything the module printed on the way in.
 *
 * Without it the whole of stdout was handed to `JSON.parse`, so ONE line printed at import
 * time — a dotenv banner, a deprecation warning, anything — made the parse fail, and the run
 * then said "could not be imported, so nothing is known about what it exports". Both halves
 * false: it imported perfectly, and its whole exported surface was sitting in the same
 * string. Every export on that module read as never walked, which is the coverage ledger
 * lying, and the API comparison that is the entire point of an import journey was off.
 */
const EXPORTS_MARKER = '<<< staysfixed: what it exports >>>';

// ---------------------------------------------------------------------------
// Walking a test file the harvest found
// ---------------------------------------------------------------------------

/**
 * The command line for a test-file journey, exactly as it was harvested.
 *
 * The harvest wrote the program and its arguments down separately, and they are put back
 * together with every part quoted, because a project with a space in its path is not a
 * project this tool gets to be wrong about.
 *
 * ONE SUBSTITUTION, and only one. The program the harvest recorded is an absolute path to the
 * Node binary on the machine that did the harvesting. A journey saved in a repository and
 * walked on somebody else's laptop names a file that is not there, and the shell then fails
 * the same way on BOTH builds - which produces no difference at all and reads exactly like a
 * clean check. So a missing absolute Node is replaced with the Node running this, and
 * anything else is left alone for the shell to find on the path.
 *
 * @param {{command?: string, argv?: string[], run?: string, file?: string}} step
 * @returns {string}
 */
export function testFileCommand(step) {
  if (!step.command) return String(step.run ?? '');
  let program = String(step.command);
  if (path.isAbsolute(program) && !exists(program) && /^node(\.exe)?$/.test(path.basename(program))) {
    program = process.execPath;
  }
  return [program, ...(step.argv ?? []).map(String)].map(shellQuote).join(' ');
}

/**
 * What a walked test file says, beyond what any command says.
 *
 * Four things, and each one answers a question an exit code cannot.
 *
 *   EACH CHECK, BY NAME, passed or failed. A suite that was already red stays red on both
 *   builds and reports nothing, which is right: it was already failing and you did not break
 *   it. A check that goes green-to-red on the new build alone is the finding, and it names
 *   itself instead of arriving as "the exit code changed".
 *
 *   WHY EACH FAILING CHECK FAILED. "Still failing" and "failing for a completely different
 *   reason" are different facts, and a flag cannot hold both.
 *
 *   THE CHECKS THE FILE CONTAINS, as a list. Add, rename or delete a test and this moves.
 *
 *   THE TEST FILE ITSELF, as a fingerprint of its contents. This is the one that stops the
 *   whole feature crying wolf. If you edited the test, then every difference underneath it is
 *   a difference you made on purpose, and the reader has to be told so in the same breath as
 *   the difference rather than left to work it out. It is compared rather than merely noted,
 *   so it appears exactly when it is true and never otherwise.
 *
 * FLAKES ARE NOT DEALT WITH HERE, on purpose. A check that flips between two runs of the same
 * build lands in the wobble measurement like anything else that cannot answer twice, and is
 * subtracted there. A second mechanism for the same problem is how two mechanisms end up
 * disagreeing with each other.
 *
 * @param {object} input
 * @param {import('./contract.js').Journey} input.journey
 * @param {{file?: string, tests?: string[]}} input.step
 * @param {import('../journeys/from-suite.js').Runner} input.runner
 * @param {CommandResult} input.result
 * @param {string} input.root            The scratch copy this build was walked in.
 * @returns {Promise<import('./contract.js').Observation[]>}
 */
export async function suiteObservations(input) {
  const { journey, step, runner, result, root } = input;
  const id = journey.name;
  const file = String(step.file ?? '');
  /** @type {import('./contract.js').Observation[]} */
  const out = [];

  out.push(observation({
    channel: 'results',
    path: joinPath('test', id, 'the test file itself'),
    value: await fingerprintOf(path.join(root, file)),
    says:
      `${file} as it stands in this build. If this is one of the things that changed, then whatever moved below ` +
      `moved because you edited the test, and it cannot tell you whether the product still works - run the check ` +
      `again once the test is the way you want it.`,
    where: { file },
  }));

  const read = readChecks(runner, result.stdout);
  if (!read.read) {
    out.push(notCovered({
      channel: 'results',
      path: joinPath('test', id, 'the checks it reported'),
      reason: 'crashed',
      says:
        `Nothing could be read back from ${file}: ${read.why} It was run, and what it printed and how it finished ` +
        `are still compared exactly - but which of its checks passed is not known, and that is a hole, not a pass.`,
      where: { file },
    }));
    return out;
  }

  out.push(observation({
    channel: 'results',
    path: joinPath('test', id, 'the checks it contains'),
    value: read.checks.map((c) => c.name).sort(),
    says:
      `The ${read.checks.length} ${read.checks.length === 1 ? 'check' : 'checks'} ${file} reported. A name appearing ` +
      `or disappearing here means the test file itself was added to or cut down.`,
    where: { file },
  }));

  for (const check of read.checks) {
    out.push(observation({
      channel: 'results',
      path: joinPath('test', id, check.name),
      value: check.ok ? 'passed' : 'failed',
      says: check.ok
        ? `"${check.name}" in ${file} passed.`
        : `"${check.name}" in ${file} failed. If it failed on the build you were happy with too, nothing is ` +
          `reported - it was already broken, and you did not break it.`,
      where: { file },
    }));
    if (check.detail) {
      // A long failure message gets its middle cut out, and that used to be stored with
      // nothing saying so — two different failures whose ends match would then compare equal
      // and report "still failing for the same reason" when the reason had changed.
      const kept = trimForStorage(check.detail);
      out.push(observation({
        channel: 'complaints',
        path: joinPath('test', id, check.name, 'why it failed'),
        value: kept.text,
        says:
          `What ${file} said when "${check.name}" failed. A check that was already failing and is now failing for a ` +
          `different reason is a change, and this is where it shows.` +
          (kept.truncated
            ? ` It is ${sizeBucket(kept.bytes)}, so only the two ends are compared: a different failure with the same ` +
              `ends and the same length would not be seen.`
            : ''),
        where: { file },
        covered: kept.truncated ? false : undefined,
        reason: kept.truncated ? 'too big' : undefined,
      }));
    }
  }

  out.push(observation({
    channel: 'counters',
    path: joinPath('count', id, 'checks that failed'),
    value: read.checks.filter((c) => !c.ok).length,
    says:
      `How many of ${file}'s checks did not pass. Compared against the build you were happy with, so a suite that ` +
      `was already red is not news.`,
    where: { file },
  }));

  return out;
}

/**
 * A file's contents in one short string, or a plain sentence saying it is not there.
 *
 * @param {string} file
 * @returns {Promise<string>}
 */
async function fingerprintOf(file) {
  try {
    const bytes = await fsp.readFile(file);
    return `${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)} (${bytes.length} bytes)`;
  } catch (error) {
    // "It is not here" and "it is here and would not open" are different facts, and one
    // sentence for both means a permissions problem reads as a deleted test file.
    if (isGone(error)) return 'there is no such file in this build';
    return `${COULD_NOT_READ}${whyItWouldNotOpen(error)}`;
  }
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
 * @param {string[]} [input.skipped]  Folders this run did not watch, so it can say so.
 * @param {(text: string) => string} [input.quieten]
 *   Applied to what the program printed, after our own footprint is rubbed out and before
 *   anything is compared. It exists for one narrow case and has to stay narrow: a harness the
 *   journey itself started - a test runner - that narrates its own stopwatch into the output.
 *   That is the harness talking about the machine, not the product talking about itself, and
 *   it is the same reason durations are never compared anywhere else in here. It is NOT for
 *   the product's own volatile output; that is the noise-control layer's job, where the rules
 *   live in the project's git and a person can see and argue with them.
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
    const plain = undoOurFootprint(raw, footprint);
    const text = input.quieten ? input.quieten(plain) : plain;
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
  // DID THIS WALK EVER REACH THE PRODUCT? Said out loud, in one place, because it is the one
  // question nothing downstream can work out for itself.
  //
  // A command that fails to SPAWN has always been reported here. The other half was missing
  // until 2026-08-31: a command that spawns perfectly, throws on its first line, prints
  // nothing and exits non-zero. That walk fills the complaints channel with a real stack
  // trace and a real exit code — both genuine facts, and both facts about a crash rather than
  // about the product. Two builds that crash the same way agree at every one of those
  // addresses, so the run came back "Nothing that worked has changed. 7 addresses checked"
  // about a product whose entire output had been rewritten in between; `ship` blessed it; and
  // the day it was fixed, every real value differed from the stored crash and four findings
  // arrived that nobody had caused.
  //
  // The stdout test is what keeps this narrow, and it is the honest line. A command that
  // printed something got somewhere, and what it printed is a real observation of the product
  // however it ended — a linter that exits 1 with a list of problems is being observed
  // properly and must go on being compared. A command that printed nothing and then died
  // never reached the product at all.
  const neverReachedIt =
    result.couldNotStart
    || (result.stdout.trim() === '' && (result.timedOut || result.signal !== null || (result.code !== null && result.code !== 0)));
  if (neverReachedIt) {
    const why = result.couldNotStart
      ? `it never started: ${result.couldNotStart}`
      : result.timedOut
        ? 'it was still running when its time ran out and had printed nothing'
        : result.signal
          ? `it was killed by ${result.signal} having printed nothing`
          : `it exited ${result.code} without printing anything at all`;
    out.push(notCovered({
      channel: 'complaints',
      path: joinPath('cli', id, 'ran at all'),
      reason: 'crashed',
      says:
        `"${journey.describe}" did not get far enough to observe the product: ${why}. What it complained about and how ` +
        `it finished are recorded below and are facts about the crash, not about the product — so nothing here is ` +
        `compared with the other build. A command that fails the same way on both builds otherwise agrees at every ` +
        `address, and that agreement reads exactly like a clean run.`,
    }));
  }
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
  // ---- and the three ways looking at files can come up short. All of them used to be
  // silent, and a silence here is indistinguishable from "nothing changed", which is the one
  // shape of wrong answer this whole tool exists to prevent.
  const bySize = [...input.after].filter(([, mark]) => mark.startsWith(BY_SIZE_ALONE)).map(([file]) => file).sort();
  if (bySize.length > 0) {
    out.push(observation({
      channel: 'effects',
      path: joinPath('file', id, 'compared by size alone'),
      value: bySize,
      says:
        `${bySize.length} file${bySize.length === 1 ? ' was' : 's were'} too big to read through, so ${bySize.length === 1 ? 'it was' : 'they were'} ` +
        `compared by size rather than by contents: ${bySize.join(', ')}. A rewrite of the same rough size would NOT be seen. ` +
        `This is a hole in what was checked, not a pass.`,
      covered: false,
      reason: 'too big',
    }));
  }
  const unreadable = [...new Map([...input.before, ...input.after])]
    .filter(([, mark]) => mark.startsWith(COULD_NOT_READ))
    .map(([file, mark]) => `${file} (${mark.slice(COULD_NOT_READ.length)})`)
    .sort();
  if (unreadable.length > 0) {
    out.push(observation({
      channel: 'effects',
      path: joinPath('file', id, 'could not be looked at'),
      value: unreadable,
      says:
        `${unreadable.length} place${unreadable.length === 1 ? '' : 's'} in the scratch copy could not be read, so anything written ` +
        `there — and anything underneath, for a folder — was not seen: ${unreadable.join(', ')}. This is a hole, not a pass.`,
      covered: false,
      reason: 'refused',
    }));
  }
  if (input.skipped && input.skipped.length > 0) {
    out.push(observation({
      channel: 'effects',
      path: joinPath('file', id, 'folders left unwatched'),
      value: input.skipped,
      says:
        `Files written into ${input.skipped.join(', ')} were not watched. ` +
        `node_modules is the one that costs something: a build step that patches a dependency, generates a client into it, ` +
        `or rebuilds a native module changes what ships and is not seen here. It is left out because fingerprinting it twice ` +
        `per run makes a check nobody waits for. Name it under "process.alsoWatch" in the settings to watch it anyway.`,
      covered: false,
      reason: 'too big',
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
    if (watched.torn > 0) {
      out.push(observation({
        channel: 'effects',
        path: joinPath('proc', id, 'events that could not be read back'),
        value: watched.torn,
        says:
          `${watched.torn} line${watched.torn === 1 ? '' : 's'} of what the watcher wrote could not be read back, so ` +
          `that many programs started or connections attempted are missing from this run. This is a hole, not a pass.`,
        covered: false,
        reason: 'crashed',
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
  const at = result.stdout.lastIndexOf(EXPORTS_MARKER);
  try {
    // Only what comes after the marker. Anything the module printed while importing sits in
    // front of it and is compared under "printed", where it belongs.
    surface = JSON.parse(at === -1 ? result.stdout : result.stdout.slice(at + EXPORTS_MARKER.length));
    if (surface === null || typeof surface !== 'object' || Array.isArray(surface)) throw new Error('not a list of names');
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

/** True when a path exists. Small enough to inline, useful enough to name. */
export function exists(/** @type {string} */ file) {
  return fs.existsSync(file);
}
