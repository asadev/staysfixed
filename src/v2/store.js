/**
 * Where observations live on disk.
 *
 * One line of JSON per fact, in files keyed by which build was running and which journey was
 * walked. JSONL rather than one big JSON document for three reasons: a capture can be written
 * as it happens instead of held in memory, a torn file loses its last line rather than all of
 * them, and `grep` works on it, which matters more than it sounds when a run reports something
 * strange at three in the morning.
 *
 *   .staysfixed/v2/
 *     builds/<build>/build.json                  what we know about the build
 *     builds/<build>/<journey>/<capture>.jsonl   one run of one journey
 *     references.json                            which build each product calls 'working'
 *
 * WHAT THIS COSTS ON DISK, honestly, because the design brief noticed nobody had costed it:
 * one observation line runs about 150 bytes. A CLI journey makes maybe 300 of them — 45 KB, a
 * rounding error. A full desktop sweep makes around 20,000 — about 3 MB a capture. A check
 * runs the new build twice, so 6 MB a check; ten checks a day is 60 MB, and about 22 GB a
 * year. That is NOT "small and kept forever". So the rule is: captures against a REFERENCE
 * build are kept forever, because they are what everything is compared against; captures
 * against working builds are pruned to the newest few per journey by `pruneBuild`. Build
 * ARTIFACTS are never kept here at all — that is the marker system's job, and it keeps them
 * only at markers for exactly this reason.
 *
 * Two safety properties this file owes the rest of the tool:
 *   - A file being written is never visible half-written. Everything lands as `.part` and is
 *     renamed into place, and a rename is atomic on every filesystem we run on.
 *   - A capture that was killed mid-write is readable anyway. The reader takes whole lines and
 *     stops at the first torn one, and says `complete: false` rather than pretending.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { safeName, findConfigFile } from '../core/paths.js';
import { StaysFixedError } from '../core/errors.js';
import { sortObservations } from './observation.js';
import { asMarkedValue } from './refusal.js';

/**
 * @typedef {import('./types.js').Store} Store
 * @typedef {import('./types.js').Capture} Capture
 * @typedef {import('./types.js').CaptureRef} CaptureRef
 * @typedef {import('./types.js').CaptureRun} CaptureRun
 * @typedef {import('./types.js').Observation} Observation
 * @typedef {import('./types.js').BuildFingerprint} BuildFingerprint
 * @typedef {import('./types.js').BuildRecord} BuildRecord
 * @typedef {import('./types.js').ReferencePointer} ReferencePointer
 * @typedef {import('./types.js').Coverage} Coverage
 * @typedef {import('./types.js').JourneySource} JourneySource
 */

/** The format written into every header line, so a future reader can tell what it is holding. */
const FORMAT = 2;

// ---------------------------------------------------------------------------
// Opening the store
// ---------------------------------------------------------------------------

/**
 * @param {{root?: string, dir?: string}} [opts]  `dir` overrides the whole location; `root` is
 *                                                the project folder and the usual way in.
 * @returns {Store}
 */
export function openStore(opts = {}) {
  const root = path.resolve(opts.root ?? process.cwd());
  const dir = opts.dir ? path.resolve(opts.dir) : path.join(root, '.staysfixed', 'v2');
  return {
    root,
    dir,
    buildsDir: path.join(dir, 'builds'),
    referencesFile: path.join(dir, 'references.json'),
  };
}

/**
 * @param {Store} store
 * @param {string} buildId
 * @returns {string}
 */
function buildDir(store, buildId) {
  return path.join(store.buildsDir, safeName(buildId));
}

// ---------------------------------------------------------------------------
// What this product is called — the key everything in here is filed under
// ---------------------------------------------------------------------------

/**
 * Which product is this?
 *
 * IT LIVES HERE BECAUSE THE NAME IS THE STORE'S KEY. References are filed under it, builds
 * are listed by it, and two commands that work it out two different ways do not disagree
 * politely — they file into two different drawers and never meet again.
 *
 * Which is exactly what happened. Until 2026-08-31 `staysfixed ship` read `product` out of
 * the settings file ONLY when that file ended in `.json`, and every settings file
 * `staysfixed init` writes is JavaScript. So on a real project — measured driving a native
 * Windows app over ssh — the settings said `product: "notepad"`, package.json said
 * `"win-proof"`, `check` recorded the run under `notepad`, `ship` blessed under `win-proof`
 * and answered "Stays Fixed had never seen this build", and every later check answered
 * "no build of notepad is on record as working" and exited 2. Forever: the project could
 * ship and check for its whole life and never once compare anything, with nothing anywhere
 * saying the two names disagreed. `ship --product notepad` cut the reference instantly,
 * which is the proof that the name was the whole cause.
 *
 * The order is the one `check` has always used: what the caller was told, then the settings
 * file, then package.json, then the folder. Everything a caller needs to EXPLAIN the answer
 * comes back too, because "no record of this build" was true and useless — "no record of a
 * build of win-proof; your settings call this product notepad" names the bug in one line.
 *
 * It never throws. A settings file that will not load leaves `settings` null and the answer
 * falls through, which is the behaviour both callers had before.
 *
 * @param {string} root
 * @param {{product?: string, configFile?: string|null}} [opts]
 * @returns {Promise<{name: string, from: 'told'|'settings'|'package'|'folder', settings: string|null, package: string|null, configFile: string|null}>}
 */
export async function productNameFor(root, opts = {}) {
  const configFile = opts.configFile ?? findConfigFile(root) ?? null;
  const settings = await productInSettings(configFile);
  const pkg = await nameInPackage(root);
  const told = typeof opts.product === 'string' && opts.product ? opts.product : null;
  const name = told ?? settings ?? pkg ?? path.basename(path.resolve(root));
  /** @type {'told'|'settings'|'package'|'folder'} */
  const from = told ? 'told' : settings ? 'settings' : pkg ? 'package' : 'folder';
  return { name, from, settings, package: pkg, configFile };
}

/**
 * The `product` field out of a settings file of any shape.
 *
 * JSON is parsed and JavaScript is imported, which is what `check` does and always did. The
 * import is the half that was missing from ship: `.js` and `.mjs` are the two shapes
 * `staysfixed init` writes, so a JSON-only reader covers essentially no real project.
 *
 * @param {string|null} configFile
 * @returns {Promise<string|null>}
 */
async function productInSettings(configFile) {
  if (!configFile) return null;
  try {
    if (configFile.endsWith('.json')) {
      const parsed = JSON.parse(await fsp.readFile(configFile, 'utf8'));
      return typeof parsed?.product === 'string' && parsed.product ? parsed.product : null;
    }
    // `pathToFileURL`, rather than gluing `file://` to the front of a path.
    //
    // Measured on a real Windows 11 machine on 2026-08-31, and the answer was not the one
    // expected: `file://C:\Users\me\staysfixed.config.mjs` DOES load, because the URL rules
    // treat a drive letter sitting where the host should be as part of the path and turn the
    // backslashes round. Even a folder with a space in it survives that. So this was not the
    // Windows bug it looked like.
    //
    // It is still wrong, and it is changed for the one shape where the luck runs out: a
    // project on a network share. `\\server\share\app` glued to `file://` becomes
    // `file:////server/share/app`, which names no host and no file; `pathToFileURL` makes it
    // `file://server/share/app`, which is the file. The catch below would have turned that
    // into a silent "no product name in the settings", and the release would have been
    // recorded under the wrong name rather than the one the person wrote down.
    const module = await import(pathToFileURL(configFile).href);
    const raw = module.default ?? module.config ?? module;
    return typeof raw?.product === 'string' && raw.product ? raw.product : null;
  } catch {
    // A settings file nobody can load is somebody else's problem to report — `check` says so
    // loudly about the same file. Falling through keeps the release recorded under SOME name
    // rather than failing somebody's release over their settings.
    return null;
  }
}

/**
 * @param {string} root
 * @returns {Promise<string|null>}
 */
async function nameInPackage(root) {
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
    return typeof pkg?.name === 'string' && pkg.name ? pkg.name : null;
  } catch {
    return null;
  }
}

/**
 * A sortable capture id: when it ran, and which of the two runs it was.
 * @param {CaptureRun} run
 * @param {Date} [now]
 * @returns {string}
 */
export function newCaptureId(run, now = new Date()) {
  /**
   * @param {number} n
   * @returns {string}
   */
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  // Two captures inside one second is normal for fast CLI journeys, so the id carries a few
  // random characters as well. Without them the second one would silently overwrite the first.
  return `${stamp}-${run}-${crypto.randomBytes(3).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Write a file so nobody can ever read it half-finished.
 *
 * Three things happen here that a plain `writeFile` does not do, and all three exist because
 * his disk hit zero bytes on 2026-08-30.
 *
 *   - The bytes are counted back off the disk before the file is renamed into place. A write
 *     onto a full disk can come back without throwing and with only some of the text on the
 *     platter, and a half-written references.json that gets renamed into place is a store that
 *     has quietly forgotten which build was working.
 *   - A failure says, in words, that the disk is full, rather than handing back a five-letter
 *     error code to somebody who is not a programmer.
 *   - The half-written temporary file is removed on the way out. Otherwise every failed write
 *     leaves its wreckage behind and the disk that was already full gets fuller.
 *
 * @param {string} file
 * @param {string} text
 */
async function writeAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
  const wanted = Buffer.byteLength(text, 'utf8');
  try {
    await fsp.writeFile(temp, text);
    const landed = (await fsp.stat(temp)).size;
    if (landed !== wanted) {
      throw new StaysFixedError(
        `Only ${landed} of ${wanted} bytes of ${path.basename(file)} reached the disk, so it was not saved.`,
        { hint: 'The disk this project sits on is full, or something else is writing to the same folder. Free some space and run it again.' },
      );
    }
    await fsp.rename(temp, file);
  } catch (e) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw noRoom(e, file);
  }
}

/**
 * The same failure, said in a way somebody who is not a programmer can act on.
 *
 * A full disk is the one storage failure that happens to real people mid-run, and ENOSPC on
 * its own tells them nothing. Anything else is passed through untouched rather than dressed
 * up as something it is not.
 *
 * @param {unknown} e
 * @param {string} file
 * @returns {unknown}
 */
function noRoom(e, file) {
  const code = /** @type {{code?: string}} */ (e)?.code;
  if (code === 'ENOSPC') {
    return new StaysFixedError(`There was no room left on the disk to save ${path.basename(file)}.`, {
      hint: 'Free some space and run the check again. Nothing was lost except this record; the answer the run already worked out is still good.',
    });
  }
  if (code === 'EDQUOT') {
    return new StaysFixedError(`This account has used up its disk allowance, so ${path.basename(file)} could not be saved.`, {
      hint: 'Ask for more space, or delete something, and run the check again.',
    });
  }
  return e;
}

/**
 * Is this the ordinary "there is no such file" that means nothing is wrong?
 *
 * Everything else — a permission that was taken away, a folder where a file should be, a
 * disk that will not read — is a file that EXISTS and cannot be read, and those two answers
 * must never come back as the same `null`. One of them means "this product has never been
 * shipped"; the other means "the record of what working looks like is damaged", and a tool
 * that reports the second as the first tells somebody to start from scratch when what they
 * needed to hear was that their evidence is hurt.
 *
 * @param {unknown} e
 * @returns {boolean}
 */
function justNotThere(e) {
  const code = /** @type {{code?: string}} */ (e)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Record what we know about a build, and merge it with whatever we knew before.
 *
 * Called every time a capture is saved, so `lastSeenAt` and the journey list stay true without
 * anybody having to remember to update them.
 *
 * @param {Store} store
 * @param {BuildFingerprint} fingerprint
 * @param {{journey?: string, at?: string, captures?: number}} [opts]
 * @returns {Promise<BuildRecord>}
 */
export async function saveBuild(store, fingerprint, opts = {}) {
  if (!fingerprint?.id) throw new StaysFixedError('A build needs an id before its observations can be stored.');
  if (!fingerprint.product) throw new StaysFixedError(`Build ${fingerprint.id} does not say which product it is of.`);

  const at = opts.at ?? new Date().toISOString();
  // A damaged record is loud everywhere else — a reader must never mistake it for a build
  // nobody has heard of. Here it is different: this function is about to write a correct
  // record over the top of it, and refusing would leave the damage in place for good and
  // break every future run against that build. What is lost is the first-seen date and the
  // journey list, which are rebuilt from the next few runs.
  /** @type {BuildRecord|null} */
  let existing = null;
  try {
    existing = await loadBuild(store, fingerprint.id);
  } catch {
    existing = null;
  }
  const journeys = new Set(existing?.journeys ?? []);
  if (opts.journey) journeys.add(opts.journey);

  /** @type {BuildRecord} */
  const record = {
    fingerprint: { ...existing?.fingerprint, ...fingerprint },
    firstSeenAt: existing?.firstSeenAt ?? at,
    lastSeenAt: at,
    captures: opts.captures ?? existing?.captures ?? 0,
    journeys: [...journeys].sort(),
  };
  await writeAtomic(path.join(buildDir(store, fingerprint.id), 'build.json'), JSON.stringify(record, null, 2) + '\n');
  return record;
}

/**
 * Store one finished capture.
 *
 * @param {Store} store
 * @param {Capture} capture
 * @returns {Promise<CaptureRef>}
 */
export async function saveCapture(store, capture) {
  const ref = refFor(store, capture.build.id, capture.journey, capture.id);
  const lines = [JSON.stringify(headerOf(capture))];
  for (const o of sortObservations(capture.observations)) lines.push(JSON.stringify(o));
  lines.push(JSON.stringify(endOf(capture, capture.observations.length)));
  await writeAtomic(ref.file, lines.join('\n') + '\n');
  await bumpBuild(store, capture);
  return ref;
}

/**
 * Store a capture as it happens, rather than holding every observation in memory.
 *
 * The file only appears under its real name when `close` is called, so a run that dies halfway
 * leaves a `.part` file that no reader will ever mistake for a capture. `sweepIncomplete`
 * clears those up.
 *
 * @param {Store} store
 * @param {{build: BuildFingerprint, journey: string, run: CaptureRun, id?: string, source?: JourneySource, startedAt?: string, rules?: string, rulesScope?: Record<string, string[]>}} opts
 * @returns {Promise<{ref: CaptureRef, append: (o: Observation) => Promise<void>, close: (end?: {durationMs?: number, coverage?: Coverage, note?: string}) => Promise<CaptureRef>, abandon: () => Promise<void>}>}
 */
export async function openCaptureWriter(store, opts) {
  const id = opts.id ?? newCaptureId(opts.run);
  const startedAt = opts.startedAt ?? new Date().toISOString();
  const ref = refFor(store, opts.build.id, opts.journey, id);
  const temp = `${ref.file}.part`;

  await fsp.mkdir(path.dirname(ref.file), { recursive: true });
  const handle = await fsp.open(temp, 'w');
  let count = 0;
  const started = Date.now();

  /** @type {Capture} */
  const shell = {
    id,
    journey: opts.journey,
    build: opts.build,
    run: opts.run,
    startedAt,
    durationMs: 0,
    observations: [],
  };
  if (opts.source) shell.source = opts.source;
  if (opts.rules) shell.rules = opts.rules;
  if (opts.rulesScope) shell.rulesScope = opts.rulesScope;
  await handle.write(JSON.stringify(headerOf(shell)) + '\n');

  let open = true;
  /** Close once, and never let a failure to close hide the failure that caused it. */
  const shut = async () => {
    if (!open) return;
    open = false;
    await handle.close().catch(() => {});
  };

  return {
    ref,
    async append(o) {
      count++;
      await writeLine(handle, JSON.stringify(o) + '\n', temp, shut);
    },
    async close(end = {}) {
      const finished = { ...shell, durationMs: end.durationMs ?? Date.now() - started };
      if (end.coverage) finished.coverage = end.coverage;
      if (end.note) finished.note = end.note;
      await writeLine(handle, JSON.stringify(endOf(finished, count)) + '\n', temp, shut);
      await shut();
      try {
        await fsp.rename(temp, ref.file);
      } catch (e) {
        await fsp.rm(temp, { force: true }).catch(() => {});
        throw noRoom(e, ref.file);
      }
      await bumpBuild(store, finished);
      return ref;
    },
    async abandon() {
      // The file comes off the disk whatever the handle does. A close that throws used to
      // leave the half-written capture sitting there for the sweeper to find an hour later.
      await shut();
      await fsp.rm(temp, { force: true }).catch(() => {});
    },
  };
}

/**
 * Write one whole line, or say plainly that it did not go on the disk.
 *
 * `handle.write` is allowed to write only part of what it was given and come back without
 * throwing — which is exactly what a disk with a few hundred bytes left on it does. The half
 * line that lands takes the newline with it, so the NEXT line is joined onto it and two
 * observations are lost inside one unreadable line. `loadCapture` would still notice, because
 * the end line counts what should be there; this stops it happening at all, and stops the
 * run pretending the capture is finished.
 *
 * @param {import('node:fs/promises').FileHandle} handle
 * @param {string} line
 * @param {string} temp
 * @param {() => Promise<void>} shut
 * @returns {Promise<void>}
 */
async function writeLine(handle, line, temp, shut) {
  const wanted = Buffer.byteLength(line, 'utf8');
  try {
    const { bytesWritten } = await handle.write(line, null, 'utf8');
    if (bytesWritten !== wanted) {
      throw new StaysFixedError(
        `Only ${bytesWritten} of ${wanted} bytes of this observation reached the disk, so the capture was abandoned rather than finished half-written.`,
        { hint: 'The disk is full. Free some space and run the check again.' },
      );
    }
  } catch (e) {
    await shut();
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw noRoom(e, temp);
  }
}

/**
 * @param {Store} store
 * @param {Capture} capture
 */
async function bumpBuild(store, capture) {
  // Counted from what is actually on disk rather than incremented, so a pruned build reports
  // the truth instead of a number that only ever goes up.
  const captures = (await listCaptures(store, { buildId: capture.build.id })).length;
  await saveBuild(store, capture.build, { journey: capture.journey, captures });
}

/**
 * The first line of a capture file.
 *
 * The field list is written out rather than spread, so that what reaches disk is a decision
 * somebody made. The cost of that is this: a field added to `Capture` and not added here is
 * silently dropped, and everything downstream reads its absence as a fact about the run. It
 * happened to `rulesScope` — stamped on every capture, written to none of them, and the
 * feature that reads it took the "this record predates the stamp" branch forever. If you add
 * a field to Capture that a later run needs, add it here and to the read in `loadCapture`,
 * and prove it with a write-then-read test rather than a unit test on the stamping.
 *
 * @param {Capture} capture
 * @returns {Record<string, unknown>}
 */
function headerOf(capture) {
  return {
    kind: 'capture',
    format: FORMAT,
    id: capture.id,
    journey: capture.journey,
    source: capture.source,
    build: capture.build,
    run: capture.run,
    startedAt: capture.startedAt,
    rules: capture.rules,
    rulesScope: capture.rulesScope,
  };
}

/**
 * @param {Capture} capture
 * @param {number} count
 * @returns {Record<string, unknown>}
 */
function endOf(capture, count) {
  return {
    kind: 'end',
    count,
    durationMs: capture.durationMs,
    coverage: capture.coverage,
    note: capture.note,
  };
}

/**
 * @param {Store} store
 * @param {string} buildId
 * @param {string} journey
 * @param {string} captureId
 * @returns {CaptureRef}
 */
function refFor(store, buildId, journey, captureId) {
  return {
    buildId,
    journey,
    captureId,
    file: path.join(buildDir(store, buildId), safeName(journey), `${safeName(captureId)}.jsonl`),
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Read a stored capture back.
 *
 * Torn files are the point of this function. A run killed mid-write, a disk that filled, a
 * laptop that died — all of them leave a file whose last line is half a JSON object. That line
 * is dropped, `complete` comes back false, and the caller can decide. What must never happen
 * is a silent parse failure that reads as "this journey observed nothing", because that is
 * indistinguishable from "everything vanished", which is the loudest finding the tool has.
 *
 * @param {Store} store
 * @param {CaptureRef|{buildId: string, journey: string, captureId: string}|string} where
 *        A ref, the three parts, or an absolute path to the file.
 * @returns {Promise<Capture|null>}
 */
export async function loadCapture(store, where) {
  const file = typeof where === 'string'
    ? where
    : 'file' in where && where.file
      ? where.file
      : refFor(store, where.buildId, where.journey, where.captureId).file;

  /** @type {string} */
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (e) {
    // A capture that is not there and a capture that is there and unreadable came back as
    // the same `null` until 2026-08-30, and they are opposite answers. "Not there" is the
    // cold start and is fine. "There and unreadable" — a permission taken away, a folder
    // where a file should be, a disk that will not read — means the record of what working
    // looks like is damaged, and swallowing it turns damaged evidence into "no evidence",
    // which reads as a clean start and lets a release through.
    if (justNotThere(e)) return null;
    throw new StaysFixedError(`${file} is there and could not be read: ${e instanceof Error ? e.message : String(e)}`, {
      hint: 'This is a record of what the old build did. It is not missing, it is damaged, so nothing should be compared against it until it is either readable or deleted.',
    });
  }

  const lines = raw.split('\n');
  /** @type {Record<string, any>|null} */
  let header = null;
  /** @type {Observation[]} */
  const observations = [];
  /** @type {Record<string, any>|null} */
  let end = null;
  let unreadable = 0;

  for (const line of lines) {
    if (line.trim() === '') continue;
    /** @type {any} */
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      unreadable++;
      continue;
    }
    if (parsed?.kind === 'capture') {
      header = parsed;
      continue;
    }
    if (parsed?.kind === 'end') {
      end = parsed;
      continue;
    }
    if (typeof parsed?.path === 'string' && typeof parsed?.channel === 'string') {
      // A REFUSAL COMES BACK OFF THE DISK AS A REFUSAL, not as a sentence that happens to
      // begin "not checked —".
      //
      // Every store on every machine holds refusals written as plain strings, because that
      // is what the adapters wrote before there was a kind for them. A string is comparable,
      // and on 2026-08-31 two of them compared equal and a product that threw on its first
      // line came back "Nothing that worked has changed". Marking it here, at the one door
      // every stored observation comes through, means the comparison, the reference and the
      // report all see the same kind whatever age the file is — and nothing on disk is
      // rewritten, so a store stays readable by an older copy of the tool.
      const observation = /** @type {Observation} */ (parsed);
      const marked = asMarkedValue(observation.value);
      observations.push(marked === observation.value ? observation : { ...observation, value: marked });
    } else {
      unreadable++;
    }
  }

  if (!header) {
    throw new StaysFixedError(`${file} does not start with a capture header, so it is not a Stays Fixed capture file.`, {
      hint: 'Delete it and run the check again — a capture is evidence, never a promise, and it can always be retaken.',
    });
  }

  const complete = Boolean(end) && unreadable === 0 && (end?.count === undefined || end.count === observations.length);

  /** @type {Capture} */
  const capture = {
    id: header.id,
    journey: header.journey,
    build: header.build,
    run: header.run ?? 'single',
    startedAt: header.startedAt,
    durationMs: end?.durationMs ?? 0,
    observations,
    complete,
  };
  if (header.source) capture.source = header.source;
  if (header.rules) capture.rules = header.rules;
  if (header.rulesScope) capture.rulesScope = header.rulesScope;
  if (end?.coverage) capture.coverage = end.coverage;

  const notes = [];
  if (end?.note) notes.push(end.note);
  if (!end) notes.push('This capture was never finished — the run stopped while it was being written, so some of what the journey saw is missing.');
  if (unreadable > 0) notes.push(`${unreadable} line${unreadable === 1 ? '' : 's'} in this file could not be read and ${unreadable === 1 ? 'was' : 'were'} skipped.`);
  if (end?.count !== undefined && end.count !== observations.length) {
    notes.push(`This file says it holds ${end.count} observations and ${observations.length} could be read.`);
  }
  if (notes.length > 0) capture.note = notes.join(' ');

  return capture;
}

/**
 * Every stored capture for a build, newest last. `.part` files are never listed — a capture
 * still being written is not a capture.
 *
 * @param {Store} store
 * @param {{buildId: string, journey?: string}} opts
 * @returns {Promise<CaptureRef[]>}
 */
export async function listCaptures(store, opts) {
  const dir = buildDir(store, opts.buildId);
  const journeys = opts.journey ? [safeName(opts.journey)] : await subdirs(dir);
  /** @type {CaptureRef[]} */
  const out = [];
  for (const journeyDir of journeys) {
    const full = path.join(dir, journeyDir);
    for (const name of await entries(full)) {
      if (!name.endsWith('.jsonl')) continue;
      out.push({
        buildId: opts.buildId,
        journey: opts.journey ?? journeyDir,
        captureId: name.slice(0, -'.jsonl'.length),
        file: path.join(full, name),
      });
    }
  }
  // Capture ids start with a sortable timestamp, so plain string order is time order.
  return out.sort((a, b) => (a.captureId < b.captureId ? -1 : a.captureId > b.captureId ? 1 : 0));
}

/**
 * The most recent capture of one journey against one build.
 * @param {Store} store
 * @param {{buildId: string, journey: string, run?: CaptureRun, onProblem?: (message: string) => void}} opts
 *   `onProblem` is told about every record that had to be stepped over on the way back. The
 *   stepping over is right — one bad file must not cost the whole reference — but it means
 *   the answer is an OLDER record than the newest one, and nothing said so.
 * @returns {Promise<Capture|null>}
 */
export async function latestCapture(store, opts) {
  const refs = await listCaptures(store, { buildId: opts.buildId, journey: opts.journey });
  for (let i = refs.length - 1; i >= 0; i--) {
    /** @type {Capture|null} */
    let capture = null;
    try {
      capture = await loadCapture(store, refs[i]);
    } catch (e) {
      // One file nobody can read must never take the whole reference with it. Asking for
      // a named capture that turns out not to be one is an error and stays one; scanning
      // for the newest usable record steps over it and keeps looking. Otherwise a single
      // interrupted run leaves the next check with "nothing to compare against", which
      // reads as a pass and lets a release through.
      opts.onProblem?.(
        `The newest stored record of "${opts.journey}" (${refs[i].captureId}) could not be read: ${e instanceof Error ? e.message : String(e)}. An older one was used instead, so this comparison is against something further back than it looks.`,
      );
      continue;
    }
    if (!capture) continue;
    if (opts.run && capture.run !== opts.run) continue;
    return capture;
  }
  return null;
}

/**
 * @param {Store} store
 * @param {string} buildId
 * @returns {Promise<BuildRecord|null>}
 */
export async function loadBuild(store, buildId) {
  const file = path.join(buildDir(store, buildId), 'build.json');
  /** @type {string} */
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (e) {
    // Never seen is null. Seen and damaged is loud — see justNotThere.
    if (justNotThere(e)) return null;
    throw new StaysFixedError(`${file} is there and could not be read: ${e instanceof Error ? e.message : String(e)}`, {
      hint: 'Nothing should treat this build as unknown while its record is sitting there damaged.',
    });
  }
  try {
    return /** @type {BuildRecord} */ (JSON.parse(raw));
  } catch (e) {
    throw new StaysFixedError(`${file} is not readable as JSON: ${e instanceof Error ? e.message : String(e)}`, {
      hint: 'A half-written build record means a run was interrupted. Delete the file and run the check again; it will be rewritten.',
    });
  }
}

/**
 * Every build the store knows about, newest first.
 *
 * @param {Store} store
 * @param {{product?: string, onProblem?: (message: string) => void}} [opts]
 *   `onProblem` is told about every build folder that had to be skipped. Without it a build
 *   whose record is damaged simply is not in the list, and "not in the list" is how every
 *   caller spells "never existed" — so a build that HAS captures and a broken record reads
 *   as a build nobody ever made, in the coverage ledger and in `--against` alike.
 * @returns {Promise<BuildRecord[]>}
 */
export async function listBuilds(store, opts = {}) {
  const references = await loadReferences(store);
  /** @type {BuildRecord[]} */
  const out = [];
  for (const dirName of await subdirs(store.buildsDir)) {
    /** @type {BuildRecord|null} */
    let record = null;
    try {
      const raw = await fsp.readFile(path.join(store.buildsDir, dirName, 'build.json'), 'utf8');
      record = /** @type {BuildRecord} */ (JSON.parse(raw));
    } catch (e) {
      // A build folder with no readable record is not worth failing a run over. It happens
      // when a write was interrupted, and the next capture against that build rewrites it.
      // It IS worth saying out loud, because everything above reads a missing build as a
      // build that never existed.
      opts.onProblem?.(
        justNotThere(e)
          ? `The build folder ${dirName} has no record in it, so whatever was stored against that build is not counted here.`
          : `The build folder ${dirName} has a record that could not be read (${e instanceof Error ? e.message : String(e)}), so whatever was stored against that build is not counted here.`,
      );
      continue;
    }
    const product = record.fingerprint?.product;
    if (opts.product && product !== opts.product) continue;
    record.isReference = Boolean(product && references[product]?.buildId === record.fingerprint.id);
    out.push(record);
  }
  return out.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0));
}

// ---------------------------------------------------------------------------
// The reference — which build a product calls 'working'
// ---------------------------------------------------------------------------

/**
 * @param {Store} store
 * @returns {Promise<Record<string, ReferencePointer>>}
 */
async function loadReferences(store) {
  /** @type {string} */
  let raw;
  try {
    raw = await fsp.readFile(store.referencesFile, 'utf8');
  } catch (e) {
    // No file at all is the honest cold start: nothing has ever been shipped with the hook
    // in place. A file that is there and cannot be read is the opposite — this product HAS a
    // reference and the pointer to it is damaged — and returning an empty map for both meant
    // a damaged store reported itself as a brand new one and every run after it compared
    // against nothing while saying so in the gentlest possible words.
    if (justNotThere(e)) return {};
    throw new StaysFixedError(`${store.referencesFile} is there and could not be read: ${e instanceof Error ? e.message : String(e)}`, {
      hint: 'This file is the only record of which build you called working. Until it can be read, no run can honestly say what it is comparing against.',
    });
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new StaysFixedError(`${store.referencesFile} is not readable as JSON: ${e instanceof Error ? e.message : String(e)}`, {
      hint: 'It says which build of each product counts as working. Restore it from git, or ship again to write a fresh one. Treating it as empty would quietly turn every check into a first run.',
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StaysFixedError(`${store.referencesFile} does not hold a set of reference pointers.`, {
      hint: 'It should be an object keyed by product name. Delete it and ship again rather than letting a check run against nothing.',
    });
  }
  return /** @type {Record<string, ReferencePointer>} */ (parsed);
}

/**
 * Which build is this product's reference, and what do we know about it?
 *
 * Returns null on a product that has never been shipped with the hook in place. That is the
 * cold start, it is expected on any existing product, and the caller has to say so out loud
 * rather than quietly comparing against nothing.
 *
 * @param {Store} store
 * @param {string} product
 * @returns {Promise<BuildRecord|null>}
 */
export async function referenceFor(store, product) {
  const pointer = (await loadReferences(store))[product];
  if (!pointer) return null;
  const record = await loadBuild(store, pointer.buildId);
  if (!record) return null;
  record.isReference = true;
  return record;
}

/**
 * The pointer itself — who set it, when, and why. For the summary line, and for telling a
 * stale reference from a missing one.
 *
 * @param {Store} store
 * @param {string} product
 * @returns {Promise<ReferencePointer|null>}
 */
export async function referencePointer(store, product) {
  return (await loadReferences(store))[product] ?? null;
}

/**
 * Point a product's reference at a build.
 *
 * This is the only place in the tool that decides what "working" means, and it must only ever
 * be called for an act a person performed — saying ship. An agent may write a waiver; an agent
 * may not write a reference. Whoever calls this owes the summary a line saying they did.
 *
 * @param {Store} store
 * @param {string} buildId
 * @param {{product?: string, setBy?: string, note?: string, at?: string}} [opts]
 * @returns {Promise<ReferencePointer>}
 */
export async function setReference(store, buildId, opts = {}) {
  const record = await loadBuild(store, buildId);
  const product = opts.product ?? record?.fingerprint?.product;
  if (!product) {
    throw new StaysFixedError(`Cannot make ${buildId} the reference: nothing here says which product it is of.`, {
      hint: 'Save a capture against the build first, or pass the product name.',
    });
  }
  if (!record) {
    throw new StaysFixedError(`Cannot make ${buildId} the reference for ${product}: nothing has ever been observed against that build.`, {
      hint: 'A reference has to have observations behind it, or there is nothing to compare the next build with.',
    });
  }

  const references = await loadReferences(store);
  /** @type {ReferencePointer} */
  const pointer = {
    product,
    buildId,
    setAt: opts.at ?? new Date().toISOString(),
  };
  if (opts.setBy) pointer.setBy = opts.setBy;
  if (opts.note) pointer.note = opts.note;
  references[product] = pointer;
  await writeAtomic(store.referencesFile, JSON.stringify(references, null, 2) + '\n');
  return pointer;
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/**
 * Throw away all but the newest few captures per journey for a build.
 *
 * Reference builds are refused, loudly. Their captures are the only record of what "working"
 * looked like, and once they are gone the next check has nothing to compare against.
 *
 * @param {Store} store
 * @param {string} buildId
 * @param {{keepPerJourney?: number}} [opts]
 * @returns {Promise<{removed: number, kept: number}>}
 */
export async function pruneBuild(store, buildId, opts = {}) {
  const keep = Math.max(1, opts.keepPerJourney ?? 4);
  const record = await loadBuild(store, buildId);
  const references = await loadReferences(store);

  // Asked of the POINTERS, not of the build's own record. Reading it the other way round —
  // "what product does this build say it is of, and is that product's reference this build" —
  // has a hole in it exactly where it matters: a build whose build.json is missing answers
  // nothing, the guard is skipped, and the captures that are the only record of what working
  // looks like get deleted. Every pointer is checked here, so an unreadable record can never
  // be the reason a reference is thrown away.
  const pointedAt = Object.values(references).filter((p) => p?.buildId === buildId);
  if (pointedAt.length > 0) {
    throw new StaysFixedError(
      `${buildId} is the reference for ${pointedAt.map((p) => p.product).join(', ')}, so its observations cannot be pruned.`,
      { hint: 'Point the reference at a newer build first, with setReference.' },
    );
  }
  if (!record) {
    throw new StaysFixedError(`Nothing here says what ${buildId} is, so its observations will not be thrown away.`, {
      hint: 'Its build.json is missing. Deleting captures on the strength of a record nobody can read is how the evidence for "this used to work" disappears. Run a check against that build to rewrite the record, or delete the whole folder deliberately.',
    });
  }

  let removed = 0;
  let kept = 0;
  const dir = buildDir(store, buildId);
  for (const journeyDir of await subdirs(dir)) {
    const refs = await listCaptures(store, { buildId, journey: journeyDir });
    const doomed = refs.slice(0, Math.max(0, refs.length - keep));
    for (const ref of doomed) {
      await fsp.rm(ref.file, { force: true });
      removed++;
    }
    kept += refs.length - doomed.length;
  }
  return { removed, kept };
}

/**
 * Throw the whole of a build away: its record, its captures, its folder.
 *
 * The companion `pruneBuild` thins one build's captures down to the newest few, which is the
 * right tool when a build is worth keeping and its hundred captures are not. It is the wrong
 * tool for the growth anybody actually measures: one build FOLDER per check, forever, in a
 * directory this tool asks people to commit. Nothing could remove a folder at all, so the only
 * housekeeping that existed could not touch the thing that grows.
 *
 * The two refusals are the same two, for the same reason, and they are loud rather than quiet
 * because deleting the evidence of what "working" means is not recoverable:
 *
 *   - A build any product points at as its reference is never removed. Its captures are the
 *     only record of what working looked like, and once they are gone the next check has
 *     nothing to compare against.
 *   - A build whose own record cannot be read is never removed. An unreadable record is the
 *     one state where we do not know what we would be deleting, and "I could not tell, so I
 *     deleted it" is the wrong way round.
 *
 * WHAT TO KEEP IS NOT DECIDED HERE. This removes one build that has been named. Which builds
 * are worth keeping — how many, how long, whether a `work-` build off a dirty tree is worth
 * less than a `git-` one off a commit — is a policy about somebody's disk and their history,
 * and it belongs where the run knows what it just did, not in the file that owns the folder.
 *
 * @param {Store} store
 * @param {string} buildId
 * @returns {Promise<{removed: true, captures: number}>}
 */
export async function removeBuild(store, buildId) {
  const record = await loadBuild(store, buildId);
  const references = await loadReferences(store);

  // Asked of the POINTERS rather than of the build's own record, for the reason spelled out in
  // pruneBuild: a build whose build.json is missing answers nothing, and reading it the other
  // way round would skip the guard exactly when it matters most.
  const pointedAt = Object.values(references).filter((p) => p?.buildId === buildId);
  if (pointedAt.length > 0) {
    throw new StaysFixedError(
      `${buildId} is the reference for ${pointedAt.map((p) => p.product).join(', ')}, so it cannot be thrown away.`,
      { hint: 'Point the reference at a newer build first, with setReference.' },
    );
  }
  if (!record) {
    throw new StaysFixedError(`Nothing here says what ${buildId} is, so it will not be thrown away.`, {
      hint: 'Its build.json is missing. Deleting a build on the strength of a record nobody can read is how the evidence for "this used to work" disappears. Run a check against it to rewrite the record, or delete the folder deliberately.',
    });
  }

  const captures = (await listCaptures(store, { buildId })).length;
  await fsp.rm(buildDir(store, buildId), { recursive: true, force: true });
  return { removed: true, captures };
}

/**
 * Delete `.part` files left behind by runs that died.
 *
 * They are harmless — nothing reads them — but they are also invisible, and an invisible pile
 * of half-written megabytes is how a tool ends up blamed for a full disk.
 *
 * @param {Store} store
 * @param {{olderThanMs?: number, buildId?: string}} [opts]
 *   `buildId` narrows the sweep to one build. A run knows which build it just wrote, and
 *   clearing up after itself should not reach into every other product in the store.
 *   `olderThanMs` of 0 sweeps everything, however fresh — which is what a run that has
 *   just finished its own build wants.
 * @returns {Promise<{removed: number}>}
 */
export async function sweepIncomplete(store, opts = {}) {
  const cutoff = Date.now() - (opts.olderThanMs ?? 60 * 60 * 1000);
  let removed = 0;

  /** @param {string} dir */
  const sweep = async (dir) => {
    for (const name of await entries(dir)) {
      if (!name.endsWith('.part')) continue;
      const file = path.join(dir, name);
      try {
        const stat = await fsp.stat(file);
        if (stat.mtimeMs > cutoff) continue;
        await fsp.rm(file, { force: true });
        removed++;
      } catch {
        // Gone while we looked at it. Somebody else's cleanup, and none of our business.
      }
    }
  };

  const dirs = opts.buildId ? [safeName(opts.buildId)] : await subdirs(store.buildsDir);
  for (const buildDirName of dirs) {
    const base = path.join(store.buildsDir, buildDirName);
    // The build's own folder as well as each journey's. A half-written build.json lands
    // beside the journey folders rather than inside one, so sweeping only the journeys left
    // those behind for good — invisible, and counting against a disk that was already full.
    await sweep(base);
    for (const journeyDir of await subdirs(base)) await sweep(path.join(base, journeyDir));
  }
  // And the store's own root, where a half-written references.json lands.
  if (!opts.buildId) await sweep(store.dir);
  return { removed };
}

/**
 * Is there a v2 store here at all?
 * @param {Store} store
 * @returns {boolean}
 */
export function storeExists(store) {
  return fs.existsSync(store.dir);
}

/**
 * @param {Store} store
 */
export async function ensureStore(store) {
  await fsp.mkdir(store.buildsDir, { recursive: true });
}

/**
 * Directory names inside a folder, or nothing when the folder is not there.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function subdirs(dir) {
  try {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    return items.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    // Not there is an empty list and always was. A folder that IS there and will not open —
    // a permission taken away, a mount that went — used to come back as the same empty list,
    // and an empty list here means "this product has never been walked". Everything above
    // then reports a store full of evidence as a store with nothing in it.
    if (justNotThere(e)) return [];
    throw new StaysFixedError(`${dir} is there and could not be listed: ${e instanceof Error ? e.message : String(e)}`, {
      hint: 'Reading it as empty would report everything already stored in it as never having been walked.',
    });
  }
}

/**
 * File names inside a folder, or nothing when the folder is not there.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function entries(dir) {
  try {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    return items.filter((d) => d.isFile()).map((d) => d.name);
  } catch (e) {
    if (justNotThere(e)) return [];
    throw new StaysFixedError(`${dir} is there and could not be listed: ${e instanceof Error ? e.message : String(e)}`, {
      hint: 'Reading it as empty would report every capture inside it as never having been taken.',
    });
  }
}
