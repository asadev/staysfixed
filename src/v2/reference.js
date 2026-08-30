/**
 * What "working" means, and the only act that is allowed to change it.
 *
 * Everything else in version 2 measures differences. This file holds the one thing a
 * measurement can never supply: the standard the measurement is taken against. And the
 * whole point of the design is that a person never opens the tool to set that standard.
 * It is cut by an act he already performs — saying ship.
 *
 * FOUR DECISIONS WERE HIDING INSIDE THE WORD "APPROVE", and only the first one lives here.
 *
 *   1. What counts as working             a person, by shipping.        THIS FILE.
 *   2. Is this difference real or noise   the machine, arithmetically.  observation.js
 *   3. Did my own change cause it         the agent, by proving it.     cause.js
 *   4. Is an unintended difference fine   a person, a few times a month. the summary
 *
 * So there is no function in here called `approve`, and there is no way for an agent to
 * reach one. An agent may write a WAIVER — a provisional, fingerprinted, budgeted,
 * expiring note saying "I meant that" — and the gates on those live in the MCP surface.
 * A waiver never becomes the standard on its own. It becomes the standard the moment a
 * build ships with it still standing, and at that moment it stops being a waiver and
 * starts being what the product does.
 *
 * WHY THE STABILITY RECORD IS STORED WITH THE REFERENCE, and not left to be recomputed.
 * A reference that only remembers what the product DID cannot answer the one question no
 * other tool asks: "this address gave the same answer twice back then, and it does not
 * now." That finding — the change made something unpredictable — is invisible unless the
 * reference remembers how steady it was as well as what it said. Captures get pruned,
 * disks get cleared, and a recomputation months later can quietly come back empty and
 * read as "nothing became unstable". So the measurement is taken at the moment the
 * reference is cut and written down beside it. When it cannot be taken, the reference
 * says so in those words rather than storing a zero that looks like good news.
 *
 * WHAT THIS FILE WILL REFUSE TO DO. It will not make a build the standard when that build
 * was never checked, or was checked and found broken, unless somebody forces it and
 * accepts that the forcing goes on the record. A safety net that will accept a broken
 * build as the definition of correct has not become slightly less useful; it has become a
 * rubber stamp, and it will now report the broken behaviour as normal every day, silently,
 * for as long as it runs.
 *
 * ON DISK, all inside the store folder (`.staysfixed/v2`):
 *
 *   references.json      the pointer per product. Written by store.js, never by hand.
 *   reference-log.json   every cut ever made, with its stability record. This file.
 *   waivers.json         the agent's provisional notes. Retired here when a reference moves.
 *   waivers-expired.json the overflow archive, so nothing is ever actually thrown away.
 *   check-log.json       what the last few checks concluded, so a ship can tell whether
 *                        the build it is about to bless was ever actually checked.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { StaysFixedError } from '../core/errors.js';
import { safeName } from '../core/paths.js';
import { setReference, referencePointer, loadBuild, listBuilds, listCaptures, loadCapture, ensureStore } from './store.js';
import { measureWobble } from './observation.js';

/** @typedef {import('./types.js').Store} Store */
/** @typedef {import('./types.js').Capture} Capture */
/** @typedef {import('./types.js').BuildFingerprint} BuildFingerprint */
/** @typedef {import('./types.js').BuildRecord} BuildRecord */
/** @typedef {import('./types.js').ReferencePointer} ReferencePointer */
/** @typedef {import('./types.js').Finding} Finding */

/**
 * How many unstable addresses are written into a reference's stability record before the
 * list is cut short. The COUNT is always exact; the list is for reading, and a reference
 * carrying forty thousand path strings helps nobody.
 */
const MAX_UNSTABLE_LISTED = 500;

/** How many cuts stay in the log. Older ones move to the archive rather than being deleted. */
const MAX_LOG_ENTRIES = 200;

/** How many retired waivers stay visible in waivers.json before they move to the archive. */
const KEEP_RETIRED = 40;

/** How many check conclusions are remembered, so a ship can look one up. */
const MAX_CHECK_LOG = 40;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * How steady one journey was, the last time this build walked it twice.
 *
 * @typedef {object} JourneyStability
 * @property {string} journey
 * @property {boolean} measured    False when the build was only ever walked once.
 * @property {string} [why]        Plain English, present whenever `measured` is false.
 * @property {number} paths        Addresses seen. The denominator.
 * @property {number} steady       Addresses that answered the same way twice.
 * @property {number} unstableCount
 * @property {string[]} unstable   The addresses themselves, cut short after MAX_UNSTABLE_LISTED.
 * @property {boolean} [truncated] True when `unstable` is shorter than `unstableCount`.
 * @property {[string, string]} [runs]  The two captures that were compared.
 */

/**
 * What a build disagreed with itself about, at the moment it became the standard.
 *
 * @typedef {object} StabilityRecord
 * @property {boolean} measured        False when NOTHING could be measured. Never a zero
 *                                     dressed up as calm.
 * @property {number} journeys
 * @property {number} measuredJourneys
 * @property {number} paths
 * @property {number} steady
 * @property {number} unstable
 * @property {string[]} unstablePaths
 * @property {JourneyStability[]} byJourney
 * @property {string} note             One plain sentence. Says outright when there is no
 *                                     record rather than implying the build was steady.
 */

/**
 * One cut: the moment a build became this product's definition of working.
 *
 * @typedef {object} ReferenceCut
 * @property {string} id              File-safe and sortable: 'ref-20260829-013245-a1b2c3'.
 * @property {string} product
 * @property {string} buildId
 * @property {BuildFingerprint} [build]
 * @property {string} at              ISO.
 * @property {string} [setBy]         'ship-everywhere', 'staysfixed ship', a person.
 * @property {string} [why]           What the release was, in a person's words.
 * @property {string[]} journeys      What had actually been walked against this build.
 * @property {StabilityRecord} stability
 * @property {number} waiversRetired  Counted out loud, because a waiver that expires quietly
 *                                    is indistinguishable from one that was never written.
 * @property {string} [previousBuildId]
 * @property {boolean} [forced]       Somebody cut this past a refusal. It stays on the record.
 * @property {string} [forcedPast]    The exact refusal that was overridden.
 * @property {boolean} [unchanged]    This build was already the reference; nothing moved.
 * @property {string} summary         One line for the closing summary he already reads.
 */

/**
 * Whether a build may become the standard, and if not, exactly why not.
 *
 * @typedef {object} CutDecision
 * @property {boolean} ok
 * @property {'clean'|'accounted-for'|'already-the-reference'|'never-checked'|'broken'|'blocked'|'not-stored'} state
 * @property {string} why             Plain English, whichever way it went.
 * @property {string} [refusal]       The full refusal, present only when `ok` is false.
 * @property {boolean} needsForce     True when only `force: true` would get past this.
 * @property {string} buildId
 * @property {number} [findings]      Differences the last check left unaccounted for.
 * @property {number} [waived]        Differences an agent had waived, which this ship adopts.
 * @property {string} [checkedAt]
 */

/**
 * A provisional "I meant that", as the MCP surface writes it. Repeated here rather than
 * imported: this file must keep working in a copy where the MCP surface is not installed,
 * and the two only ever meet through the JSON on disk.
 *
 * @typedef {object} Waiver
 * @property {string} id
 * @property {string} fingerprint
 * @property {string} summary
 * @property {string} because
 * @property {string} intentId
 * @property {string} at
 * @property {string} reference
 * @property {string} [retiredAt]
 * @property {string} [retiredBy]     The id of the cut that retired it.
 * @property {string} [retiredWhy]
 */

/**
 * What a check concluded, kept so that a ship can find out whether the build it is about
 * to bless was ever checked at all.
 *
 * @typedef {object} CheckNote
 * @property {string} at
 * @property {string} buildId
 * @property {string} [product]
 * @property {boolean} ok
 * @property {boolean} [blocked]
 * @property {number} findings        Total findings the engine reported.
 * @property {number} unaccounted     Findings nobody accounted for. This is the number that decides.
 * @property {number} [waived]
 * @property {number} [sealed]
 * @property {string} [by]            'staysfixed check', 'staysfixed_check', the self-check corpus.
 */

// ---------------------------------------------------------------------------
// Small disk helpers. Deliberately local — nothing here may fail a release.
// ---------------------------------------------------------------------------

/**
 * @param {Store} store
 * @param {string} name
 * @returns {string}
 */
function fileIn(store, name) {
  return path.join(store.dir, name);
}

/**
 * Write so that nobody can ever read the file half-finished.
 * @param {string} file
 * @param {unknown} value
 */
async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
  await fsp.writeFile(temp, JSON.stringify(value, null, 2) + '\n');
  await fsp.rename(temp, file);
}

/**
 * Read JSON, and treat anything unreadable as absent.
 *
 * A hand-edited waiver file must not be able to stop a release being recorded. Losing a
 * waiver is safe — it errs towards a person looking at something. Refusing to record what
 * shipped is not safe: it leaves the next check comparing against yesterday.
 *
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {Promise<T>}
 */
async function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/**
 * A sortable, file-safe id for one cut.
 * @param {Date} [now]
 * @returns {string}
 */
function newCutId(now = new Date()) {
  /** @param {number} n */
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `ref-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * A build, named the way a person would name it.
 * @param {BuildFingerprint|undefined} build
 * @param {string} buildId
 * @returns {string}
 */
function nameOf(build, buildId) {
  if (build?.version) return build.version;
  if (build?.gitSha) return build.gitSha.slice(0, 7);
  return buildId;
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 * @returns {string}
 */
function plural(n, one, many) {
  return n === 1 ? one : many;
}

/**
 * A build id out of whatever the caller had to hand.
 * @param {string|BuildFingerprint} build
 * @returns {string}
 */
function idOfBuild(build) {
  return typeof build === 'string' ? build : build.id;
}

// ---------------------------------------------------------------------------
// The stability record — how steady this build was with itself
// ---------------------------------------------------------------------------

/**
 * Measure how much a stored build disagreed with itself, journey by journey.
 *
 * This reads only what is already on disk. It never runs the product: by the time a
 * reference is cut the build has shipped, and re-walking it would be measuring a different
 * afternoon. If the two runs are not both there, that journey says so and the reference
 * carries the admission instead of a comforting zero.
 *
 * @param {Store} store
 * @param {string} buildId
 * @returns {Promise<StabilityRecord>}
 */
export async function measureStability(store, buildId) {
  const record = await loadBuild(store, buildId);
  /** @type {string[]} */
  const journeys = record?.journeys ?? [];

  /** @type {JourneyStability[]} */
  const byJourney = [];
  /** @type {string[]} */
  const unstablePaths = [];
  let paths = 0;
  let steady = 0;
  let measuredJourneys = 0;

  for (const journey of journeys) {
    const looked = await twoRunsOf(store, buildId, journey);
    const pair = looked.pair;
    if (!pair) {
      byJourney.push({
        journey,
        measured: false,
        why:
          looked.unreadable > 0
            ? `${looked.unreadable} of the ${looked.stored} stored runs of this journey could not be read, so the pair needed to measure how steady it was is not there. This build DID walk it more than once — the evidence is on the disk and it is damaged, which is a different problem from never having walked it.`
            : 'This build only ever walked this journey once, so nothing here says how steady it was.',
        paths: 0,
        steady: 0,
        unstableCount: 0,
        unstable: [],
      });
      continue;
    }

    /** @type {import('./types.js').Wobble} */
    let wobble;
    try {
      wobble = measureWobble(pair.a, pair.b);
    } catch (e) {
      byJourney.push({
        journey,
        measured: false,
        why: `The two stored runs of this journey could not be compared: ${e instanceof Error ? e.message : String(e)}`,
        paths: 0,
        steady: 0,
        unstableCount: 0,
        unstable: [],
      });
      continue;
    }

    measuredJourneys++;
    const seen = wobble.steady + wobble.unstable.length;
    paths += seen;
    steady += wobble.steady;
    for (const p of wobble.unstable) unstablePaths.push(p);

    /** @type {JourneyStability} */
    const entry = {
      journey,
      measured: true,
      paths: seen,
      steady: wobble.steady,
      unstableCount: wobble.unstable.length,
      unstable: wobble.unstable.slice(0, MAX_UNSTABLE_LISTED),
      runs: wobble.runs,
    };
    if (wobble.unstable.length > entry.unstable.length) entry.truncated = true;
    byJourney.push(entry);
  }

  const measured = measuredJourneys > 0;
  const listed = unstablePaths.slice(0, MAX_UNSTABLE_LISTED);

  return {
    measured,
    journeys: journeys.length,
    measuredJourneys,
    paths,
    steady,
    unstable: unstablePaths.length,
    unstablePaths: listed,
    byJourney,
    note: stabilityNote(measured, journeys.length, measuredJourneys, steady, unstablePaths.length),
  };
}

/**
 * The sentence that goes in the reference. It has one job: never let "we did not measure"
 * read like "nothing wobbled".
 *
 * @param {boolean} measured
 * @param {number} journeys
 * @param {number} measuredJourneys
 * @param {number} steady
 * @param {number} unstable
 * @returns {string}
 */
function stabilityNote(measured, journeys, measuredJourneys, steady, unstable) {
  if (journeys === 0) {
    return 'Nothing has ever been walked against this build, so this reference has no record of what it does or how steady it is.';
  }
  if (!measured) {
    return `This build was walked once, never twice, so there is NO record of how steady it was. A later run cannot tell you that an address which used to answer the same way twice has stopped doing so — not because nothing became unpredictable, but because nobody wrote down what steady looked like here.`;
  }
  const partial =
    measuredJourneys < journeys
      ? ` ${journeys - measuredJourneys} of its ${journeys} ${plural(journeys, 'journey', 'journeys')} ran only once and carry no steadiness record.`
      : '';
  if (unstable === 0) {
    const all = steady === 1 ? 'the one address it was watched at' : `all ${steady} addresses`;
    return `Measured across ${measuredJourneys} ${plural(measuredJourneys, 'journey', 'journeys')}: ${all} answered the same way twice.${partial}`;
  }
  return `Measured across ${measuredJourneys} ${plural(measuredJourneys, 'journey', 'journeys')}: ${steady} ${plural(steady, 'address', 'addresses')} answered the same way twice and ${unstable} did not. ${unstable === 1 ? 'That one was' : `Those ${unstable} were`} already unpredictable when this shipped, so a later run must not blame a change for ${plural(unstable, 'it', 'them')}.${partial}`;
}

/**
 * The two runs of one journey that belong together.
 *
 * Pairing matters more than it looks. The store keeps several captures per journey, and
 * grabbing the newest 'a' and the newest 'b' can straddle two different checks — which
 * would measure the difference between two afternoons and call it wobble. So: take the
 * newest second run, then the newest first run that came before it.
 *
 * WHY IT SAYS HOW MANY IT COULD NOT READ. One unreadable capture must never take the whole
 * stability record with it, and it never did — but it used to vanish into a `continue`, and
 * a journey that lost its pair that way came back as the same plain `null` a journey that
 * was genuinely only ever walked once comes back as. The caller then wrote "this build only
 * ever walked this journey once, so nothing here says how steady it was" onto the reference,
 * for good, about a journey that was walked twice and whose evidence is sitting on the disk
 * damaged. That sentence sends somebody to walk it again; the truth would have sent them to
 * look at their store.
 *
 * @param {Store} store
 * @param {string} buildId
 * @param {string} journey
 * @returns {Promise<{pair: {a: Capture, b: Capture}|null, stored: number, unreadable: number}>}
 */
async function twoRunsOf(store, buildId, journey) {
  const refs = await listCaptures(store, { buildId, journey });
  if (refs.length < 2) return { pair: null, stored: refs.length, unreadable: 0 };

  /** @type {Capture[]} */
  const captures = [];
  let unreadable = 0;
  for (const ref of refs) {
    /** @type {Capture|null} */
    let capture = null;
    try {
      capture = await loadCapture(store, ref);
    } catch {
      unreadable += 1;
      continue;
    }
    if (capture) captures.push(capture);
    else unreadable += 1;
  }

  for (let i = captures.length - 1; i >= 0; i--) {
    if (captures[i].run !== 'b') continue;
    for (let j = i - 1; j >= 0; j--) {
      if (captures[j].run === 'a') return { pair: { a: captures[j], b: captures[i] }, stored: refs.length, unreadable };
    }
  }
  return { pair: null, stored: refs.length, unreadable };
}

// ---------------------------------------------------------------------------
// Waivers — every one of them dies when the reference moves
// ---------------------------------------------------------------------------

/**
 * Retire every waiver, because the reference has moved.
 *
 * This is the mechanism that stops a waiver becoming a permanent blind spot. A waiver says
 * "I meant that, this once, against this standard". The moment the standard moves, the
 * sentence stops being true of anything: either the difference shipped, in which case it
 * IS the standard now and needs no waiver, or it did not, in which case waving it through
 * a second time is a decision somebody should make again on purpose.
 *
 * WHICH WAIVERS. This product's, wherever they are kept. Waivers live per product at
 * `waivers/<product>.json`, and an older flat `waivers.json` exists in copies where the MCP
 * surface wrote them before they were split up. Both are swept, because a waiver the tool
 * cannot see is a waiver that outlives its subject, and that is the one failure mode this
 * whole mechanism exists to prevent.
 *
 * The waiver files also stamp each waiver with the reference in force when it was written,
 * so a moved reference already retires them arithmetically. This function is the belt to
 * that pair of braces AND the audit trail: it writes down WHEN each one died and WHY, so
 * "this was waived once and then a build shipped" is a sentence somebody can read six
 * months later, rather than an inference from two hashes not matching.
 *
 * Nothing is deleted. Retired waivers stay in place with the reason on them, and the
 * overflow moves to an archive beside them.
 *
 * @param {Store} store
 * @param {string} product
 * @param {string} newReferenceId   The id of the cut that retired them.
 * @returns {Promise<{retired: number, live: number, archived: number, waivers: Waiver[], files: string[], note: string}>}
 */
export async function expireWaivers(store, product, newReferenceId) {
  const files = [path.join(store.dir, 'waivers', `${safeName(product)}.json`), fileIn(store, 'waivers.json')];

  /** @type {Waiver[]} */
  const retired = [];
  /** @type {string[]} */
  const touched = [];
  let liveLeft = 0;
  let archived = 0;

  for (const file of files) {
    /** @type {Waiver[]} */
    const waivers = await readJson(file, /** @type {Waiver[]} */ ([]));
    if (!Array.isArray(waivers) || waivers.length === 0) continue;
    touched.push(file);

    const at = new Date().toISOString();
    for (const waiver of waivers) {
      if (!waiver || typeof waiver !== 'object') continue;
      if (waiver.retiredAt) continue;
      waiver.retiredAt = at;
      waiver.retiredBy = newReferenceId;
      waiver.retiredWhy = `${product} shipped, so the reference moved and this waiver stopped covering anything. What it described either shipped — in which case it is now simply what the product does — or it did not, in which case waiving it again is a fresh decision.`;
      retired.push(waiver);
    }

    // Keep the recent dead ones where a summary can still count them; move the rest to the
    // archive. Kept, not deleted: a waiver is a record of a judgement call, and "why did
    // nobody catch this" is a question that gets asked months later.
    const live = waivers.filter((w) => w && !w.retiredAt);
    const dead = waivers.filter((w) => Boolean(w && w.retiredAt)).sort((a, b) => (a.retiredAt ?? '').localeCompare(b.retiredAt ?? ''));
    const overflow = dead.slice(0, Math.max(0, dead.length - KEEP_RETIRED));
    liveLeft += live.length;
    archived += overflow.length;

    if (overflow.length > 0) {
      const archiveFile = `${file.slice(0, -'.json'.length)}-expired.json`;
      /** @type {Waiver[]} */
      const archive = await readJson(archiveFile, /** @type {Waiver[]} */ ([]));
      await writeJsonAtomic(archiveFile, [...(Array.isArray(archive) ? archive : []), ...overflow]);
    }
    await writeJsonAtomic(file, [...live, ...dead.slice(-KEEP_RETIRED)]);
  }

  return {
    retired: retired.length,
    live: liveLeft,
    archived,
    waivers: retired,
    files: touched,
    note:
      retired.length === 0
        ? 'No waivers were outstanding, so nothing had to be retired.'
        : `${retired.length} ${plural(retired.length, 'waiver', 'waivers')} retired: whatever ${plural(retired.length, 'it', 'they')} covered has now either shipped and become normal, or has to be decided again.`,
  };
}

// ---------------------------------------------------------------------------
// Remembering what a check concluded
// ---------------------------------------------------------------------------

/**
 * Write down what a check concluded, so that a ship can find out whether the build it is
 * about to make the standard was ever actually checked.
 *
 * Without this, `shouldCut` has only the MCP surface's `last-check.json` to go on, which
 * means a person who runs `staysfixed check` on the command line and then ships gets told
 * their build was never checked. Wiring this into the two front doors is a one-line call
 * each, and it is listed in the handover.
 *
 * @param {Store} store
 * @param {{buildId: string, product?: string, ok: boolean, blocked?: boolean, findings?: number, unaccounted?: number, waived?: number, sealed?: number, by?: string, at?: string}} note
 * @returns {Promise<CheckNote>}
 */
export async function recordCheck(store, note) {
  const file = fileIn(store, 'check-log.json');
  /** @type {CheckNote[]} */
  const log = await readJson(file, /** @type {CheckNote[]} */ ([]));
  const findings = note.findings ?? 0;
  /** @type {CheckNote} */
  const entry = {
    at: note.at ?? new Date().toISOString(),
    buildId: note.buildId,
    ok: note.ok === true,
    findings,
    unaccounted: note.unaccounted ?? (note.ok === true ? 0 : findings),
  };
  if (note.product) entry.product = note.product;
  if (note.blocked !== undefined) entry.blocked = note.blocked;
  if (note.waived !== undefined) entry.waived = note.waived;
  if (note.sealed !== undefined) entry.sealed = note.sealed;
  if (note.by) entry.by = note.by;

  const next = [...(Array.isArray(log) ? log : []), entry].slice(-MAX_CHECK_LOG);
  await writeJsonAtomic(file, next);
  return entry;
}

/**
 * What the checks on disk say about one build, from both places a check is recorded.
 *
 * @param {Store} store
 * @param {string} buildId
 * @returns {Promise<CheckNote|null>}
 */
async function checkFor(store, buildId) {
  /** @type {CheckNote[]} */
  const log = await readJson(fileIn(store, 'check-log.json'), /** @type {CheckNote[]} */ ([]));
  /** @type {CheckNote|null} */
  let best = null;
  if (Array.isArray(log)) {
    for (const entry of log) {
      if (!entry || entry.buildId !== buildId) continue;
      if (!best || entry.at > best.at) best = entry;
    }
  }

  const fromSurface = await lastCheckOf(store, buildId);
  if (fromSurface && (!best || fromSurface.at > best.at)) best = fromSurface;
  return best;
}

/**
 * The agent surface's record of the last check, read back as a CheckNote.
 *
 * WHY THIS IS NOT SIMPLY `result.ok`. A build that ships with a waiver standing has
 * `ok: false` on it, and refusing to cut a reference for that would refuse the normal case:
 * shipping IS the moment a provisional waiver stops being provisional and becomes what the
 * product does. So what decides is how many differences were left UNACCOUNTED FOR — nobody's
 * judgement, no agent's opinion, the count the check itself already worked out.
 *
 * Two shapes are read, because the record has been through one revision and a copy of the
 * tool in the wild may hold either. The newer one carries an `accounting` block with the
 * numbers already worked out; the older one carries findings with the fingerprint a waiver
 * pins to, and the numbers are recomputed from the live waivers. Reading one shape and
 * silently returning null on the other would look exactly like "this was never checked",
 * which refuses every ship for a reason nobody could work out.
 *
 * @param {Store} store
 * @param {string} buildId
 * @returns {Promise<CheckNote|null>}
 */
async function lastCheckOf(store, buildId) {
  /**
   * @type {{
   *   at?: string,
   *   product?: string,
   *   verdict?: string,
   *   accounting?: {reported?: number, waived?: number, unwaivable?: number},
   *   findings?: (Finding & {fingerprint?: string, unwaivable?: boolean})[],
   *   result?: {ok?: boolean, blocked?: boolean, candidate?: BuildFingerprint, product?: string}
   * }|null}
   */
  const last = await readJson(fileIn(store, 'last-check.json'), /** @type {any} */ (null));
  if (!last || typeof last !== 'object') return null;

  const candidate = last.result?.candidate;
  if (!candidate || candidate.id !== buildId) return null;

  const findings = Array.isArray(last.findings) ? last.findings : [];
  const at = typeof last.at === 'string' ? last.at : new Date(0).toISOString();
  const blocked = last.result?.blocked === true || last.verdict === 'blocked';

  // The newer record has already done the arithmetic, and it did it against the waivers that
  // were live at the time — which is more accurate than anything recomputed now.
  if (last.accounting && typeof last.accounting === 'object') {
    const reported = last.accounting.reported ?? 0;
    return {
      at,
      buildId,
      ok: !blocked && reported === 0,
      blocked,
      findings: findings.length,
      unaccounted: reported,
      waived: last.accounting.waived ?? 0,
      sealed: last.accounting.unwaivable ?? 0,
      by: 'the agent surface',
      ...(last.product ? { product: last.product } : {}),
    };
  }

  /** @type {Waiver[]} */
  const flat = await readJson(fileIn(store, 'waivers.json'), /** @type {Waiver[]} */ ([]));
  const product = last.product ?? last.result?.product ?? candidate.product;
  /** @type {Waiver[]} */
  const perProduct = product
    ? await readJson(path.join(store.dir, 'waivers', `${safeName(product)}.json`), /** @type {Waiver[]} */ ([]))
    : [];
  const covered = new Set(
    [...(Array.isArray(perProduct) ? perProduct : []), ...(Array.isArray(flat) ? flat : [])]
      .filter((w) => w && !w.retiredAt && w.fingerprint)
      .map((w) => w.fingerprint)
  );

  let waived = 0;
  let sealed = 0;
  let unaccounted = 0;
  for (const f of findings) {
    if (f?.sealed || f?.unwaivable) {
      sealed++;
      unaccounted++;
      continue;
    }
    if (f?.fingerprint && covered.has(f.fingerprint)) {
      waived++;
      continue;
    }
    unaccounted++;
  }

  return {
    at,
    buildId,
    ok: !blocked && unaccounted === 0,
    blocked,
    findings: findings.length,
    unaccounted,
    waived,
    sealed,
    by: 'the agent surface',
    ...(product ? { product } : {}),
  };
}

// ---------------------------------------------------------------------------
// shouldCut — the refusal that keeps this from becoming a rubber stamp
// ---------------------------------------------------------------------------

/**
 * The sentence this whole file exists to be able to say. Written once so every refusal
 * says it in the same words, and so nobody has to reconstruct the reasoning at 3am.
 */
const RUBBER_STAMP =
  'Cutting a broken build as the standard is how a safety net silently becomes a rubber stamp: ' +
  'from tomorrow the tool would call this behaviour correct, stop reporting it, and go on ' +
  'quietly passing every run that keeps it broken.';

/**
 * May this build become what "working" means for this product?
 *
 * @param {Store} store
 * @param {string} product
 * @param {string|BuildFingerprint} build
 * @returns {Promise<CutDecision>}
 */
export async function shouldCut(store, product, build) {
  const buildId = idOfBuild(build);
  const fingerprint = typeof build === 'string' ? undefined : build;
  const name = nameOf(fingerprint, buildId);

  const pointer = await referencePointer(store, product);
  if (pointer?.buildId === buildId) {
    return {
      ok: true,
      state: 'already-the-reference',
      why: `${name} is already what ${product} calls working, so there is nothing to move.`,
      needsForce: false,
      buildId,
    };
  }

  const record = await loadBuild(store, buildId);
  if (!record) {
    return {
      ok: false,
      state: 'not-stored',
      needsForce: true,
      buildId,
      why: `Nothing has ever been observed against ${name}.`,
      refusal: [
        `Refusing to make ${name} the standard for ${product}: nothing has ever been observed against it.`,
        'A reference is not a label, it is a record — the observations everything afterwards gets compared with. Pointing at a build that was never walked would leave the next check comparing today against nothing and reporting that as a pass.',
        `Run a check against this build first, then ship. Nothing about ${product} is being checked in the meantime.`,
      ].join(' '),
    };
  }

  const check = await checkFor(store, buildId);
  if (!check) {
    return {
      ok: false,
      state: 'never-checked',
      needsForce: true,
      buildId,
      why: `${name} was walked, but no check ever concluded anything about it.`,
      refusal: [
        `Refusing to make ${name} the standard for ${product}: it was observed, but no check ever compared it with anything, so nobody — machine or person — has said this build works.`,
        RUBBER_STAMP,
        'Run `staysfixed check` against this build and ship again, or force it and it goes on the record as forced.',
      ].join(' '),
    };
  }

  if (check.blocked) {
    return {
      ok: false,
      state: 'blocked',
      needsForce: true,
      buildId,
      checkedAt: check.at,
      findings: check.unaccounted,
      why: `The last check on ${name} could not be completed.`,
      refusal: [
        `Refusing to make ${name} the standard for ${product}: the last check on it was BLOCKED — it could not be run, which is neither a pass nor a failure.`,
        'Treating "I could not test this" as "this is correct" is the exact mistake this tool exists to prevent.',
        RUBBER_STAMP,
        'Fix whatever blocked the check, run it, and ship again.',
      ].join(' '),
    };
  }

  if (check.unaccounted > 0) {
    const sealed = check.sealed ?? 0;
    return {
      ok: false,
      state: 'broken',
      needsForce: true,
      buildId,
      checkedAt: check.at,
      findings: check.unaccounted,
      waived: check.waived,
      why: `The last check on ${name} left ${check.unaccounted} ${plural(check.unaccounted, 'difference', 'differences')} unaccounted for.`,
      refusal: [
        `Refusing to make ${name} the standard for ${product}: the last check left ${check.unaccounted} ${plural(check.unaccounted, 'difference', 'differences')} nobody accounted for${sealed > 0 ? `, ${sealed} of which ${plural(sealed, 'is', 'are')} in a class nobody may wave through` : ''}.`,
        RUBBER_STAMP,
        'Fix them, or force the cut and accept that it is recorded as forced with the reason above kept beside it.',
      ].join(' '),
    };
  }

  const waived = check.waived ?? 0;
  return {
    ok: true,
    state: waived > 0 ? 'accounted-for' : 'clean',
    needsForce: false,
    buildId,
    checkedAt: check.at,
    findings: 0,
    waived,
    why:
      waived > 0
        ? `The last check on ${name} found nothing unaccounted for. ${waived} ${plural(waived, 'difference was', 'differences were')} waived as intended, and shipping is what turns ${plural(waived, 'that', 'those')} from a provisional note into simply what the product does.`
        : `The last check on ${name} found nothing unaccounted for.`,
  };
}

// ---------------------------------------------------------------------------
// cutReference — the one act that changes what "working" means
// ---------------------------------------------------------------------------

/**
 * Make this build the definition of working for this product.
 *
 * Called by the ship hook and by nothing else that an agent can reach. It runs `shouldCut`
 * itself rather than trusting its caller to have done so, because the refusal is a safety
 * property and a safety property that depends on being called correctly is not one.
 *
 * @param {Store} store
 * @param {object} opts
 * @param {string} opts.product
 * @param {string|BuildFingerprint} opts.build
 * @param {string} [opts.why]      What the release was, in a person's words.
 * @param {string} [opts.setBy]    Who or what did it: 'ship-everywhere', 'staysfixed ship'.
 * @param {boolean} [opts.force]   Cut past a refusal, on the record.
 * @param {string} [opts.at]       ISO, for tests and for a hook recording a past release.
 * @returns {Promise<ReferenceCut>}
 */
export async function cutReference(store, opts) {
  const product = opts.product;
  if (!product) throw new StaysFixedError('A reference has to belong to a product, and none was named.');

  const buildId = idOfBuild(opts.build);
  if (!buildId) throw new StaysFixedError(`Cannot cut a reference for ${product}: the build has no id.`);

  await ensureStore(store);

  const decision = await shouldCut(store, product, opts.build);
  if (!decision.ok && opts.force !== true) {
    throw new StaysFixedError(decision.refusal ?? decision.why, {
      hint: 'If this really is the build you shipped, cut it with force and the refusal stays on the record beside it.',
    });
  }

  const previous = await referencePointer(store, product);
  const record = await loadBuild(store, buildId);
  const fingerprint = record?.fingerprint ?? (typeof opts.build === 'string' ? undefined : opts.build);
  const name = nameOf(fingerprint, buildId);

  // Already the standard: say so and change nothing. A release script that runs twice, or a
  // git hook that fires on both the tag and the push, must not retire a second round of
  // waivers or write a second entry that makes the history look like two releases.
  if (decision.state === 'already-the-reference') {
    const existing = (await referenceHistory(store, product)).find((c) => c.buildId === buildId);
    if (existing) return { ...existing, unchanged: true };
  }

  const stability = await measureStability(store, buildId);
  const id = newCutId(opts.at ? new Date(opts.at) : undefined);
  const at = opts.at ?? new Date().toISOString();

  // The pointer moves first. Everything after this — retiring waivers, writing the log — is
  // bookkeeping about a move that has already happened, and if the process dies between the
  // two the worst case is a reference with a thinner record beside it, never a waiver that
  // outlives the standard it was written against.
  await setReference(store, buildId, {
    product,
    setBy: opts.setBy ?? 'ship',
    note: [opts.why, stability.note].filter(Boolean).join(' — '),
    at,
  });

  const waivers = await expireWaivers(store, product, id);

  /** @type {ReferenceCut} */
  const cut = {
    id,
    product,
    buildId,
    at,
    journeys: record?.journeys ?? [],
    stability,
    waiversRetired: waivers.retired,
    summary: '',
  };
  if (fingerprint) cut.build = fingerprint;
  if (opts.setBy) cut.setBy = opts.setBy;
  if (opts.why) cut.why = opts.why;
  if (previous?.buildId) cut.previousBuildId = previous.buildId;
  if (!decision.ok && opts.force === true) {
    cut.forced = true;
    cut.forcedPast = decision.refusal ?? decision.why;
  }
  cut.summary = summarise(cut, name, decision);

  await appendToLog(store, cut);
  return cut;
}

/**
 * The one line that goes into the closing summary he already reads.
 *
 * @param {ReferenceCut} cut
 * @param {string} name
 * @param {CutDecision} decision
 * @returns {string}
 */
function summarise(cut, name, decision) {
  const parts = [`${name} is now what ${cut.product} calls working.`];
  if (cut.previousBuildId) parts.push(`It replaces ${cut.previousBuildId}.`);
  else parts.push('Nothing was being compared against before this — from now on it is.');

  if (cut.stability.measured) {
    parts.push(
      cut.stability.unstable === 0
        ? cut.stability.steady === 1
          ? 'The one address it was watched at answered the same way twice.'
          : `All ${cut.stability.steady} addresses it was watched at answered the same way twice.`
        : `${cut.stability.unstable} of the ${cut.stability.paths} ${plural(cut.stability.paths, 'address', 'addresses')} it was watched at ${plural(cut.stability.unstable, 'was', 'were')} already unpredictable, and that is written down so nothing blames a future change for ${plural(cut.stability.unstable, 'it', 'them')}.`
    );
  } else {
    parts.push('It carries no steadiness record, so "this used to be steady and now it wobbles" cannot be reported against it.');
  }

  if (cut.waiversRetired > 0) {
    parts.push(
      `${cut.waiversRetired} ${plural(cut.waiversRetired, 'waiver', 'waivers')} retired — whatever ${plural(cut.waiversRetired, 'it', 'they')} covered has shipped and is simply how the product behaves now.`
    );
  }
  if (decision.waived && decision.waived > 0 && cut.waiversRetired === 0) {
    parts.push(`${decision.waived} waived ${plural(decision.waived, 'difference', 'differences')} became normal with this ship.`);
  }
  if (cut.forced) parts.push('This was FORCED past a refusal, and the refusal is on the record beside it.');
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// The log — so a regression can be traced to the release that introduced it
// ---------------------------------------------------------------------------

/**
 * @param {Store} store
 * @param {ReferenceCut} cut
 */
async function appendToLog(store, cut) {
  const file = fileIn(store, 'reference-log.json');
  /** @type {ReferenceCut[]} */
  const log = await readJson(file, /** @type {ReferenceCut[]} */ ([]));
  const all = [...(Array.isArray(log) ? log : []), cut];

  if (all.length > MAX_LOG_ENTRIES) {
    const overflow = all.slice(0, all.length - MAX_LOG_ENTRIES);
    const archiveFile = fileIn(store, 'reference-log-archive.json');
    /** @type {ReferenceCut[]} */
    const archive = await readJson(archiveFile, /** @type {ReferenceCut[]} */ ([]));
    await writeJsonAtomic(archiveFile, [...(Array.isArray(archive) ? archive : []), ...overflow]);
    await writeJsonAtomic(file, all.slice(-MAX_LOG_ENTRIES));
    return;
  }
  await writeJsonAtomic(file, all);
}

/**
 * Every reference ever cut for this product, newest first.
 *
 * This is what makes a regression traceable to a release. A difference that appeared
 * between two references narrows the search to the commits between them, which is a
 * different order of problem from "somewhere in the last four months".
 *
 * @param {Store} store
 * @param {string} product
 * @param {{includeArchive?: boolean}} [opts]
 * @returns {Promise<ReferenceCut[]>}
 */
export async function referenceHistory(store, product, opts = {}) {
  /** @type {ReferenceCut[]} */
  const log = await readJson(fileIn(store, 'reference-log.json'), /** @type {ReferenceCut[]} */ ([]));
  /** @type {ReferenceCut[]} */
  const archive = opts.includeArchive
    ? await readJson(fileIn(store, 'reference-log-archive.json'), /** @type {ReferenceCut[]} */ ([]))
    : [];

  const all = [...(Array.isArray(archive) ? archive : []), ...(Array.isArray(log) ? log : [])];
  return all
    .filter((c) => c && c.product === product)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * Which reference is in force, and everything a summary needs to say about it.
 *
 * Returns null on a product that has never been shipped with the hook in place. That is the
 * cold start, it is expected on every existing product, and a caller has to say so out loud
 * rather than quietly comparing against nothing.
 *
 * @param {Store} store
 * @param {string} product
 * @returns {Promise<{pointer: ReferencePointer, cut: ReferenceCut|null, note: string}|null>}
 */
export async function currentReference(store, product) {
  const pointer = await referencePointer(store, product);
  if (!pointer) return null;
  const history = await referenceHistory(store, product);
  const cut = history.find((c) => c.buildId === pointer.buildId) ?? null;
  const note = cut
    ? cut.summary
    : `${product} compares against ${pointer.buildId}, set ${pointer.setAt}${pointer.setBy ? ` by ${pointer.setBy}` : ''}. There is no cut record beside it, so how steady that build was is not known.`;
  return { pointer, cut, note };
}

/**
 * Every product this store knows a build of, whether or not it has a reference yet.
 *
 * The ship hook uses this to work out which product it is looking at when nobody said, and
 * a `doctor` or summary uses it to name the products that are not being checked at all.
 *
 * BOTH OF THOSE USES ARE RUINED BY A LIST THAT IS QUIETLY SHORT. A build record that cannot
 * be read is a build that is not in the list, and a product whose only builds are damaged
 * records is a product that is not in the list at all — so the ship hook sees one product
 * where there are two and blesses the wrong one without a word, and the summary says a
 * product is not being checked when it is. Until 2026-08-30 this asked for the builds without
 * asking to be told about the ones that were skipped, so neither could have known.
 *
 * The problems come back BESIDE the list rather than through a callback nobody has to pass,
 * because a caller that does not want to hear them now has to say so on purpose.
 *
 * @param {Store} store
 * @returns {Promise<{products: {product: string, hasReference: boolean, builds: number}[], problems: string[]}>}
 *   `problems` is empty when every build folder could be read. Each entry is a plain
 *   sentence naming a folder that could not be, and anything built on this list is weaker
 *   for as long as one is there.
 */
export async function productsKnown(store) {
  /** @type {string[]} */
  const problems = [];
  const builds = await listBuilds(store, { onProblem: (message) => problems.push(message) });
  /** @type {Map<string, {product: string, hasReference: boolean, builds: number}>} */
  const seen = new Map();
  for (const record of builds) {
    const product = record.fingerprint?.product;
    if (!product) continue;
    const entry = seen.get(product) ?? { product, hasReference: false, builds: 0 };
    entry.builds++;
    if (record.isReference) entry.hasReference = true;
    seen.set(product, entry);
  }
  return { products: [...seen.values()].sort((a, b) => a.product.localeCompare(b.product)), problems };
}
