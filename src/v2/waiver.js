/**
 * The four gates, machine-checked.
 *
 * An agent cannot write a reference. Only shipping does that, and only Asad ships. What an agent
 * CAN write is a waiver: a record saying "this difference is one I meant to cause". A waiver is
 * provisional — it silences one exact difference until the reference moves, and then it dies. It
 * never makes anything the new normal.
 *
 * Four things are checked before one is written, in this order, and each refusal says which gate
 * stopped it in a sentence a person could read over the agent's shoulder:
 *
 *   1. SEALED       Money, signing in, losing data, a crash, or anything touching a named guard.
 *                   Unwaivable. No reason is read, because a reason is exactly what an agent
 *                   under pressure produces best.
 *   2. INTENT       There has to be an intent, sealed BEFORE the check ran, still under the
 *                   reference in force. An explanation written after seeing the damage proves
 *                   nothing; one written before is falsifiable.
 *   3. COVERAGE     The difference has to fall inside what that intent declared. A claim about
 *                   something the agent never said it was touching is not a claim about a side
 *                   effect, it is a rationalisation.
 *   4. BUDGET       Five between one ship and the next. Past five it is not a change with side
 *                   effects, it is a rewrite, and a person looks at a rewrite.
 *
 * WHY A REFUSAL IS A RETURN VALUE AND NOT AN EXCEPTION. Being told no is a normal, expected
 * answer here — it is the tool working. It comes back as data with the gate named, so the caller
 * can hand the agent the sentence unchanged and the summary can count refusals as easily as it
 * counts waivers.
 *
 * WHY THE BUDGET IS COUNTED AGAINST THE REFERENCE AND NOT THE INTENT. Otherwise an agent that
 * has spent its five buys five more by sealing a fresh intent and calling the same work a
 * different change. Between one ship and the next, all of it is one change.
 *
 * WHY A WAIVER IS PINNED TO THE VALUES AND NOT THE ADDRESS. "I meant the total to read 9.99
 * instead of 10.00" must not go on quietly covering the same total the day it becomes 0. The
 * fingerprint takes in every value that differs, so a DIFFERENT break at the same address is a
 * different difference and is reported.
 */

import path from 'node:path';
import crypto from 'node:crypto';

import { safeName } from '../core/paths.js';
import { StaysFixedError } from '../core/errors.js';
import { classify, sayRefusal } from './sealed.js';
import {
  intentCovers,
  readIntent,
  readIntentById,
  referenceStamp,
  fingerprintTree,
  treeMovedSince,
  readJsonFile,
  writeJsonAtomic,
} from './intent.js';

/**
 * @typedef {import('./types.js').Store} Store
 * @typedef {import('./types.js').Finding} Finding
 * @typedef {import('./types.js').FindingClass} FindingClass
 * @typedef {import('./intent.js').Intent} Intent
 * @typedef {import('./intent.js').IntentCoverage} IntentCoverage
 * @typedef {import('./sealed.js').SealedVerdict} SealedVerdict
 */

/**
 * Five waivers between one ship and the next.
 *
 * The number is deliberately small enough to be annoying. An agent that needs a sixth has not
 * had an unlucky day; it has misunderstood its task, and the right thing to happen next is that
 * a person reads what it did.
 */
export const WAIVER_BUDGET = 5;

/**
 * How many dead waivers are kept per product, so a summary can still say what expired.
 *
 * LIVE ONES ARE NEVER PRUNED, which is what matters: the budget, the gates and whether a
 * difference is covered are all worked out from those alone and none of them can be affected
 * by this number. What it can affect is the sentence "three waivers expired when you
 * shipped", which counts the dead ones still on disk — so after fifty of them, spread over
 * ten ships or more, that number is the recent history rather than the whole of it.
 */
const KEEP_EXPIRED = 50;

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

/**
 * A recorded "I meant to do that".
 *
 * Every field here answers a question somebody will ask later: who, when, why, against which
 * intent, and under which reference. A waiver nobody can interrogate is a rubber stamp with
 * extra steps.
 *
 * @typedef {object} Waiver
 * @property {string} id
 * @property {string} product
 * @property {string} fingerprint      Pins the exact difference, values included.
 * @property {string} finding          The finding's own id, when it had one.
 * @property {string} summary          The finding's title, kept so this reads without a check.
 * @property {string[]} paths          The first few addresses involved, for somebody reading
 *                                    this back later. Nothing is decided from them: what the
 *                                    waiver actually covers is `fingerprint`, which takes in
 *                                    every difference with no ceiling at all.
 * @property {FindingClass} class      What the engine called it. Always ordinary — see gate 1.
 * @property {string} why              The agent's reason, in its own words.
 * @property {string} intentId
 * @property {string} intentSummary    Copied, so a pruned intent does not orphan the waiver.
 * @property {string} ordering         What was known about when the intent was sealed.
 * @property {{moved: boolean, knowable: boolean, say: string}} codeSince
 *                                    Whether the code moved between sealing that intent and
 *                                    writing this. Not a gate — a moved tree is what an
 *                                    intent sealed BEFORE the work is supposed to look like.
 *                                    It is recorded because the alternative is that nobody
 *                                    reading this waiver a month later can tell whether the
 *                                    intent describes the build that was actually checked.
 * @property {IntentCoverage} coverage How well it matched what was declared, and how sure.
 * @property {string} at               ISO. Written here, never supplied.
 * @property {string} [by]
 * @property {string} reference        The stamp it was written under. It dies when this moves.
 * @property {string} [retiredAt]      Set when something retired it early — a build shipped, or a
 *                                     person struck it out. A retired waiver is dead whatever its
 *                                     reference says. Kept rather than deleted, because "three
 *                                     waivers expired when you shipped" is a sentence somebody may
 *                                     reasonably want to check.
 * @property {string} [retiredBy]
 * @property {string} [retiredWhy]
 */

/**
 * @typedef {object} WaiverGranted
 * @property {true} ok
 * @property {Waiver} waiver
 * @property {boolean} already     True when this exact difference was already waived, which
 *                                 costs no further slot.
 * @property {number} spent
 * @property {number} left
 * @property {number} budget
 * @property {string} say          The whole answer, in plain English, ready to hand back.
 */

/**
 * @typedef {object} WaiverRefused
 * @property {false} ok
 * @property {'sealed'|'intent'|'coverage'|'budget'|'incomplete'} gate
 *   Which gate stopped it. `incomplete` is not one of the four — it means the call itself was
 *   missing something the gates need, and it says what.
 * @property {string} say
 * @property {SealedVerdict} [sealed]
 * @property {IntentCoverage} [coverage]
 * @property {number} [spent]
 * @property {number} [budget]
 */

/** @typedef {WaiverGranted|WaiverRefused} WaiverDecision */

/**
 * What the caller has to say about the check this difference came out of.
 *
 * `at` is what makes gate 2 real. Without it there is no way to tell whether the intent was
 * sealed before or after the agent saw what broke, and that ordering is the whole point of
 * sealing one — so a call that leaves it out is refused rather than waved through on trust.
 *
 * @typedef {object} CheckStamp
 * @property {string} at           ISO. When the check that produced this finding ran.
 * @property {string} [runId]
 */

// ---------------------------------------------------------------------------
// Writing one
// ---------------------------------------------------------------------------

/**
 * Try to record a difference as intended.
 *
 * @param {Store} store
 * @param {{product: string, finding: Finding, why: string, intentId?: string, check?: CheckStamp, guards?: string[], by?: string}} what
 * @returns {Promise<WaiverDecision>}
 */
export async function waive(store, what) {
  const product = typeof what?.product === 'string' ? what.product.trim() : '';
  const finding = what?.finding;
  const why = typeof what?.why === 'string' ? what.why.trim() : '';
  if (!product) throw new StaysFixedError('A waiver has to say which product it is about.');
  if (!finding || typeof finding !== 'object') throw new StaysFixedError('A waiver has to be about a finding the tool reported.');

  if (why === '') {
    return refuse(
      'incomplete',
      'Say why this difference is what you meant, in one plain sentence. A waiver with no reason is worth nothing to whoever reads it later, and somebody will read it.'
    );
  }

  // ---- GATE 1. The sealed classes. Nothing gets through this, ever, and it is checked before
  // anything else so that no amount of good paperwork can get a look-in first.
  const sealed = classify(finding, { guards: what.guards ?? [] });
  if (sealed) {
    return { ok: false, gate: 'sealed', say: sayRefusal(sealed, finding), sealed };
  }

  const fingerprint = fingerprintFinding(finding);
  const stamp = await referenceStamp(store, product);
  const waivers = await allWaivers(store, product);

  // Already recorded. The gates were all passed the day it was written, the reference has not
  // moved since, and re-affirming it must not cost another slot — an agent that runs a check
  // twice would otherwise spend its budget on the same difference.
  const standing = waivers.find((w) => w.fingerprint === fingerprint && isLive(w, stamp));
  if (standing) {
    const spent = waivers.filter((w) => isLive(w, stamp)).length;
    return {
      ok: true,
      waiver: standing,
      already: true,
      spent,
      left: Math.max(0, WAIVER_BUDGET - spent),
      budget: WAIVER_BUDGET,
      say: `Already recorded as intended, and it did not cost you another waiver.\n  ${trim(finding.title ?? '', 200)}\n  Your reason on the day: ${standing.why}`,
    };
  }

  // ---- GATE 2. There has to be an intent, it has to predate the check, and it has to belong to
  // the world as it is now.
  const intent = what.intentId ? await readIntentById(store, product, what.intentId) : await readIntent(store, product);
  if (!intent) {
    return refuse(
      'intent',
      what.intentId
        ? `Refused. There is no sealed intent called "${what.intentId}" for ${product}. You can only waive against an intent this tool actually holds.`
        : 'Refused. You did not seal an intent before this run, so there is nothing to check your claim against. Seal one that names what you are changing, run the check again, and waive from that. Sealing one now, after seeing what broke, would prove nothing.'
    );
  }
  if (intent.product !== product) {
    return refuse('intent', `Refused. That intent was sealed for ${intent.product}, and this difference is in ${product}. An intent covers one product.`);
  }

  const check = what.check;
  if (!check || typeof check.at !== 'string' || Number.isNaN(Date.parse(check.at))) {
    return refuse(
      'incomplete',
      'Refused. Nothing here says when the check ran, so there is no way to tell whether you sealed your intent before or after you saw what broke, and that ordering is the whole point of sealing one. Pass the time of the check that produced this finding.'
    );
  }
  if (Date.parse(intent.sealedAt) > Date.parse(check.at)) {
    return refuse(
      'intent',
      [
        `Refused. That intent (${intent.id}) was sealed AFTER the check ran.`,
        'An intent only means something when it is written before you see what broke. Run the check again so the claim is tested against an intent that already existed, and waive from that run.',
      ].join('\n')
    );
  }
  if (intent.reference !== stamp) {
    return refuse(
      'intent',
      [
        'Refused. That intent was sealed against a different reference, and the reference has moved since: a build shipped.',
        'What counts as working is now something else, so an intent written about the old one cannot cover anything. Seal a fresh intent, run the check again, and waive from there.',
      ].join('\n')
    );
  }

  // ---- GATE 3. It has to fall inside what was declared. This is the substance of the whole
  // system: the gate exists to stop a difference FAR from the declared work being waved through,
  // and a weak match is exactly the shape a rationalisation takes.
  const coverage = intentCovers(intent, finding);
  if (!coverage.covers) {
    return {
      ok: false,
      gate: 'coverage',
      coverage,
      say: [
        'Refused. This is outside what you sealed.',
        `  ${trim(finding.title ?? '', 200)}`,
        '',
        `You said you were changing: ${intent.summary}`,
        `You said it would affect: ${intent.files.join(', ')}.`,
        `Why this does not match: ${coverage.why}`,
        '',
        'A difference outside what you declared is the definition of a side effect, which is the exact thing you are not allowed to wave through. If you genuinely meant to change this too, that is a different change: seal a new intent that names it, run the check again, and waive from there.',
      ].join('\n'),
    };
  }

  // ---- GATE 4. Five between one ship and the next.
  const spent = waivers.filter((w) => isLive(w, stamp)).length;
  if (spent >= WAIVER_BUDGET) {
    return {
      ok: false,
      gate: 'budget',
      spent,
      budget: WAIVER_BUDGET,
      say: [
        `Refused. That would be waiver number ${spent + 1} since the last build shipped, and the limit is ${WAIVER_BUDGET}.`,
        '',
        'Past five, this is not a change with side effects, it is a rewrite, and a person looks at a rewrite. Sealing another intent will not give you more. Stop waiving, fix what you can, and report the rest plainly.',
      ].join('\n'),
    };
  }

  // The last of the three things intent.js says its tree fingerprint makes checkable. The
  // other two are gates above; this one cannot be, because both answers are legitimate — an
  // intent sealed before the work SHOULD see a moved tree, and one sealed after it should
  // not. So it is written down rather than judged, and a person reading the waiver decides.
  const codeSince = treeMovedSince(intent, await fingerprintTree(store.root));

  /** @type {Waiver} */
  const waiver = {
    id: `waiver-${crypto.randomBytes(5).toString('hex')}`,
    product,
    fingerprint,
    finding: typeof finding.id === 'string' ? finding.id : '',
    summary: trim(finding.title ?? '(a difference with no title)', 200),
    paths: (finding.paths ?? (finding.differences ?? []).map((d) => d.path)).slice(0, 8),
    class: finding.class ?? 'ordinary',
    why,
    intentId: intent.id,
    intentSummary: intent.summary,
    ordering: intent.ordering,
    codeSince,
    coverage,
    at: new Date().toISOString(),
    reference: stamp,
  };
  if (what.by) waiver.by = what.by;

  waivers.push(waiver);
  await writeJsonAtomic(waiversFile(store, product), prune(waivers, stamp));

  const left = WAIVER_BUDGET - (spent + 1);
  return {
    ok: true,
    waiver,
    already: false,
    spent: spent + 1,
    left,
    budget: WAIVER_BUDGET,
    say: [
      `Recorded as intended: ${waiver.summary}`,
      `Your reason, kept: ${why}`,
      `Matched against what you sealed: ${coverage.why} (${coverage.confidence} match)`,
      codeSince.say,
      '',
      `${left} of your ${WAIVER_BUDGET} waivers left before the next ship. This one is pinned to the exact values that differ and to the reference in force now: if either moves, it stops covering anything.`,
      'This is not approval. Nothing becomes the new normal until a build ships. Say in what you report back that you waived this, and why.',
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Reading them back
// ---------------------------------------------------------------------------

/**
 * The waivers that still apply: written under the reference that is in force now.
 *
 * @param {Store} store
 * @param {string} product
 * @returns {Promise<Waiver[]>}
 */
export async function activeWaivers(store, product) {
  const stamp = await referenceStamp(store, product);
  return (await allWaivers(store, product)).filter((w) => isLive(w, stamp));
}

/**
 * Every waiver kept for a product, live and dead, oldest first.
 *
 * @param {Store} store
 * @param {string} product
 * @returns {Promise<Waiver[]>}
 */
export async function allWaivers(store, product) {
  const raw = await readJsonFile(waiversFile(store, product), []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((w) => w && typeof w === 'object' && typeof w.fingerprint === 'string' && typeof w.id === 'string');
}

/**
 * Which waiver, if any, covers this exact difference.
 *
 * Pure and synchronous on purpose: a check has hundreds of findings and one list of waivers, so
 * the list is read from disk once by `activeWaivers` and matched against every finding here
 * without touching the disk again.
 *
 * @param {Waiver[]} waivers   From `activeWaivers`. Passing every waiver ever written would let
 *                             an expired one go on covering something, so it takes the live list.
 * @param {Finding} finding
 * @returns {Waiver|null}
 */
export function waiverFor(waivers, finding) {
  const fingerprint = fingerprintFinding(finding);
  return waivers.find((w) => w.fingerprint === fingerprint) ?? null;
}

/**
 * What a waiver is pinned to.
 *
 * Every value that differs goes in, so the waiver covers this break and not the address. A
 * cluster that grew a difference produces a different fingerprint and the waiver stops applying,
 * which errs towards a person looking at something they have already seen rather than towards a
 * new break hiding behind an old excuse. That is the right way round.
 *
 * EVERY difference, and there is deliberately no ceiling on that. Until 2026-08-30 this took
 * the first forty and stopped, and the sentence above was simply false: a waiver written about
 * a three-hundred-address finding went on covering it after a value past the fortieth turned
 * into something else. The addresses were all still there, the title still read the same, the
 * cluster was still one finding — so the pin matched, the difference was filed as intended, and
 * nobody was ever shown the one row that had actually broken. That is the whole failure this
 * file exists to prevent, arriving through the file itself.
 *
 * The cost of having no ceiling is a hash over text the caller is already holding in memory,
 * which is nothing next to being wrong. The tuples are sorted first so that two runs which
 * found the same differences in a different order still pin to the same thing; the number of
 * them goes in as well, so a cluster that merely GREW cannot match a waiver written about the
 * smaller one.
 *
 * @param {Finding} finding
 * @returns {string}
 */
export function fingerprintFinding(finding) {
  const differences = finding.differences ?? [];
  const hash = crypto.createHash('sha256');
  /** @param {unknown} part */
  const eat = (part) => {
    // JSON escapes every newline inside a value, so a newline is a separator nothing in the
    // text can forge — two different findings cannot run together into one identical digest.
    hash.update(`${JSON.stringify(part) ?? 'null'}\n`);
  };

  eat(finding.title ?? '');
  eat([...(finding.paths ?? [])].sort());
  eat(differences.length);
  const rows = differences.map((d) => JSON.stringify([d.path, d.kind, face(d.reference), face(d.candidate)]));
  rows.sort();
  for (const row of rows) hash.update(`${row}\n`);

  // A finding with no differences attached, which some callers pass, still has to be pinnable,
  // so the sample and the paths stand in for them.
  if (differences.length === 0) {
    eat([finding.sample?.path ?? '', finding.sample?.kind ?? '', face(finding.sample?.reference), face(finding.sample?.candidate)]);
  }
  return hash.digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Small things
// ---------------------------------------------------------------------------

/**
 * @param {Store} store
 * @param {string} product
 * @returns {string}
 */
export function waiversFile(store, product) {
  return path.join(store.dir, 'waivers', `${safeName(product)}.json`);
}

/**
 * Keep every live waiver and the most recent dead ones. The dead ones are worth something, since
 * "this was waived once and then the reference moved" is a real sentence in a summary, but they
 * are not worth keeping forever.
 *
 * @param {Waiver[]} waivers
 * @param {string} stamp
 * @returns {Waiver[]}
 */
function prune(waivers, stamp) {
  const live = waivers.filter((w) => isLive(w, stamp));
  const dead = waivers.filter((w) => !isLive(w, stamp)).slice(-KEEP_EXPIRED);
  return [...dead, ...live];
}

/**
 * Does this waiver still cover anything?
 *
 * Two conditions, and both are needed. A waiver retired by hand or by a ship is dead whatever it
 * says. A waiver written against a reference that has since moved is dead even if nothing got
 * round to retiring it. Belt and braces, because the cost of getting this wrong is a regression
 * nobody is ever shown.
 *
 * @param {Waiver} waiver
 * @param {string} stamp
 * @returns {boolean}
 */
function isLive(waiver, stamp) {
  return !waiver.retiredAt && waiver.reference === stamp;
}

/**
 * @param {'sealed'|'intent'|'coverage'|'budget'|'incomplete'} gate
 * @param {string} say
 * @returns {WaiverRefused}
 */
function refuse(gate, say) {
  return { ok: false, gate, say };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function face(value) {
  if (value === undefined) return '(absent)';
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function trim(text, max) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
