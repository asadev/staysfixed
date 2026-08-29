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
import { safeName } from '../core/paths.js';
import { StaysFixedError } from '../core/errors.js';
import { sortObservations } from './observation.js';

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
 * @param {string} file
 * @param {string} text
 */
async function writeAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
  await fsp.writeFile(temp, text);
  await fsp.rename(temp, file);
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
  const existing = await loadBuild(store, fingerprint.id);
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
 * @param {{build: BuildFingerprint, journey: string, run: CaptureRun, id?: string, source?: JourneySource, startedAt?: string, rules?: string}} opts
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
  await handle.write(JSON.stringify(headerOf(shell)) + '\n');

  return {
    ref,
    async append(o) {
      count++;
      await handle.write(JSON.stringify(o) + '\n');
    },
    async close(end = {}) {
      const finished = { ...shell, durationMs: end.durationMs ?? Date.now() - started };
      if (end.coverage) finished.coverage = end.coverage;
      if (end.note) finished.note = end.note;
      await handle.write(JSON.stringify(endOf(finished, count)) + '\n');
      await handle.close();
      await fsp.rename(temp, ref.file);
      await bumpBuild(store, finished);
      return ref;
    },
    async abandon() {
      await handle.close();
      await fsp.rm(temp, { force: true });
    },
  };
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
  } catch {
    return null;
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
      observations.push(/** @type {Observation} */ (parsed));
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
 * @param {{buildId: string, journey: string, run?: CaptureRun}} opts
 * @returns {Promise<Capture|null>}
 */
export async function latestCapture(store, opts) {
  const refs = await listCaptures(store, { buildId: opts.buildId, journey: opts.journey });
  for (let i = refs.length - 1; i >= 0; i--) {
    /** @type {Capture|null} */
    let capture = null;
    try {
      capture = await loadCapture(store, refs[i]);
    } catch {
      // One file nobody can read must never take the whole reference with it. Asking for
      // a named capture that turns out not to be one is an error and stays one; scanning
      // for the newest usable record steps over it and keeps looking. Otherwise a single
      // interrupted run leaves the next check with "nothing to compare against", which
      // reads as a pass and lets a release through.
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
  try {
    const raw = await fsp.readFile(path.join(buildDir(store, buildId), 'build.json'), 'utf8');
    return /** @type {BuildRecord} */ (JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Every build the store knows about, newest first.
 *
 * @param {Store} store
 * @param {{product?: string}} [opts]
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
    } catch {
      // A build folder with no readable record is not worth failing a run over. It happens
      // when a write was interrupted, and the next capture against that build rewrites it.
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
  try {
    const raw = await fsp.readFile(store.referencesFile, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
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
  if (record && references[record.fingerprint.product]?.buildId === buildId) {
    throw new StaysFixedError(`${buildId} is the reference for ${record.fingerprint.product}, so its observations cannot be pruned.`, {
      hint: 'Point the reference at a newer build first, with setReference.',
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
  const dirs = opts.buildId ? [safeName(opts.buildId)] : await subdirs(store.buildsDir);
  for (const buildDirName of dirs) {
    const base = path.join(store.buildsDir, buildDirName);
    for (const journeyDir of await subdirs(base)) {
      const full = path.join(base, journeyDir);
      for (const name of await entries(full)) {
        if (!name.endsWith('.part')) continue;
        const file = path.join(full, name);
        try {
          const stat = await fsp.stat(file);
          if (stat.mtimeMs > cutoff) continue;
          await fsp.rm(file, { force: true });
          removed++;
        } catch {
          // Gone while we looked at it. Somebody else's cleanup, and none of our business.
        }
      }
    }
  }
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
  } catch {
    return [];
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
  } catch {
    return [];
  }
}
