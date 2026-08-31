/**
 * "The question could not be answered" is not an answer.
 *
 * This file exists because of one measurement, taken on 2026-08-31 against a Node command
 * that threw on its first line. `staysfixed check` recorded what it saw, `staysfixed ship`
 * blessed it, and from that moment on the tool reported a product that could not start as
 * one where nothing had changed. Three separate wrongs came out of one cause, and all three
 * were reproduced end to end before a line of this was written:
 *
 *   1. TWO REFUSALS COMPARE EQUAL. A refusal was stored as an ordinary value — the words
 *      "not checked — the thing being observed fell over before it could be read", or a
 *      crash record, or nothing at all — and two of those are the same string. So the diff
 *      found no difference and the run ended "Nothing that worked has changed. 7 addresses
 *      checked", about a product whose entire output had been rewritten in between.
 *   2. SHIP BLESSED IT. The stability record said "all 7 addresses it was watched at
 *      answered the same way twice", which was true and meant nothing: two refusals do
 *      answer the same way twice. A refusal became the definition of working.
 *   3. FIXING THE PRODUCT PRODUCED FINDINGS NOBODY CAUSED. The day it started answering,
 *      every real value differed from the stored refusal. Four of them on the tiny fixture,
 *      thirteen on the three-route server, and one of them landed in the money class, which
 *      no agent may wave through — so a phantom went to a person and stayed there.
 *
 * THE RULE, and it is one rule. A refusal is a DIFFERENT KIND OF THING from a value. It is
 * never compared with a value, never compared with another refusal as if both were answers,
 * and never written down as what "working" means. It is a hole, with the reason attached,
 * exactly the way this tool already treats a guard that timed out.
 *
 * WHY A MARKED OBJECT AND NOT A SPECIAL STRING. A product's own output is a string, and any
 * sentinel string a product could print by accident is a sentinel that stops working the day
 * somebody prints it. An observed value can already be a plain object, so a plain object with
 * a reserved key costs nothing on disk, survives the JSONL store untouched, and cannot be
 * produced by a product talking about itself. `meta.refused` is not enough on its own either:
 * meta is never compared, and it is also set on observations that hold a REAL value that was
 * only partly read — a truncated stdout is still an answer, and treating it as a refusal
 * would throw away a comparison that works.
 *
 * TWO KINDS LIVE HERE, because there are two ways an address can be incomparable and only
 * one of them is a hole:
 *
 *   NO ANSWER      the adapter was asked and could not answer. A hole. Counted, reported,
 *                  and refused at ship.
 *   NEVER COMPARED the tool has an answer and has decided on purpose never to compare it —
 *                  how long something took, which measures the machine as much as the
 *                  product. Not a hole; the coverage list already explains it. It still must
 *                  never become a difference, and on 2026-08-31 it did: `count.pay.duration`
 *                  APPEARED where the reference had no record of that journey at all, and
 *                  the finding came back classed as money.
 */

import { diffCaptures, indexByPath, splitPath } from './observation.js';

/**
 * @typedef {import('./types.js').Observation} Observation
 * @typedef {import('./types.js').ObservedValue} ObservedValue
 * @typedef {import('./types.js').Capture} Capture
 * @typedef {import('./types.js').Difference} Difference
 * @typedef {import('./types.js').Channel} Channel
 */

/**
 * The reserved key. An at-sign leads it because no path segment, no header name and no
 * JSON body a product prints has ever started one of its own keys that way, and because it
 * reads as "this is the tool talking, not the product" to anyone who opens the store.
 */
export const NO_ANSWER_KEY = '@no-answer';

/**
 * The two sentences the adapters have been writing since before this file existed.
 *
 * They are recognised rather than left behind, for two reasons. Every store on every machine
 * already holds them — a reference cut last week is made of these strings, and a fix that
 * only understands the new shape would report that whole reference as changed the first time
 * it ran. And `notCovered` lives in the adapter contract, which this lane does not own; until
 * that one line is changed, this is what a refusal arrives as.
 */
export const NOT_CHECKED_PREFIX = 'not checked — ';
export const NEVER_COMPARED_PREFIX = 'not compared — ';

/** What a value is, for the one purpose of deciding whether it may be compared. */
/** @typedef {'answer'|'no-answer'|'never-compared'} Comparability */

/**
 * The channels a running product has to fill. A door read out of the source is not a door
 * opened, so `contract` and `counters` prove nothing about whether anything ran — which is
 * the same line `shouldCut` and `ship` already draw, written here once so all three cannot
 * come to disagree about it.
 *
 * @type {Set<Channel>}
 */
export const CHANNELS_ONLY_A_RUNNING_PRODUCT_FILLS = new Set(
  /** @type {Channel[]} */ (['meaning', 'effects', 'complaints', 'results', 'pixels']),
);

/**
 * A refusal, as a value.
 *
 * @param {string} reason  Short and machine-readable: `crashed`, `refused`, `irreversible`.
 * @param {string} why     One plain sentence a person reads.
 * @returns {ObservedValue}
 */
export function noAnswer(reason, why) {
  return { [NO_ANSWER_KEY]: String(reason || 'refused'), why: String(why || '') };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What kind of thing is this value?
 *
 * Everything that is not explicitly one of the two incomparable kinds is an answer. That
 * direction of default is deliberate: mistaking an answer for a refusal loses a real
 * comparison silently, which is the failure this whole tool exists to prevent, so the new
 * kind has to be claimed rather than guessed at.
 *
 * @param {unknown} value
 * @returns {Comparability}
 */
export function comparability(value) {
  if (isPlainObject(value) && typeof value[NO_ANSWER_KEY] === 'string') {
    return value[NO_ANSWER_KEY] === 'measures the machine' ? 'never-compared' : 'no-answer';
  }
  if (typeof value === 'string') {
    if (value.startsWith(NOT_CHECKED_PREFIX)) return 'no-answer';
    if (value.startsWith(NEVER_COMPARED_PREFIX)) return 'never-compared';
  }
  return 'answer';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNoAnswer(value) {
  return comparability(value) === 'no-answer';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNeverCompared(value) {
  return comparability(value) === 'never-compared';
}

/**
 * May these two values be put side by side at all?
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAnswer(value) {
  return comparability(value) === 'answer';
}

/**
 * Why there is no answer here, in the words the adapter used.
 *
 * @param {unknown} value
 * @param {Observation} [observation]  Its meta carries a longer reason when the adapter set one.
 * @returns {string}
 */
export function whyNoAnswer(value, observation) {
  if (isPlainObject(value) && typeof value.why === 'string' && value.why) return value.why;
  if (typeof value === 'string' && value.startsWith(NOT_CHECKED_PREFIX)) {
    return value.slice(NOT_CHECKED_PREFIX.length);
  }
  if (typeof value === 'string' && value.startsWith(NEVER_COMPARED_PREFIX)) {
    return value.slice(NEVER_COMPARED_PREFIX.length);
  }
  const meta = /** @type {{refusedWhy?: string}|undefined} */ (observation?.meta);
  return meta?.refusedWhy ?? 'no reason was recorded';
}

/**
 * Turn the old string form into the marked form, leaving everything else exactly as it is.
 *
 * Used on the way OUT of the store, so that one shape reaches the comparison, the reference
 * and the report however old the file it came from. It is not a migration and it never
 * rewrites anything on disk: the stored line stays as it was written, and this is what the
 * reader hands on.
 *
 * @param {ObservedValue} value
 * @returns {ObservedValue}
 */
export function asMarkedValue(value) {
  const kind = comparability(value);
  if (kind === 'answer') return value;
  if (isPlainObject(value)) return value;
  const text = String(value);
  const prefix = kind === 'no-answer' ? NOT_CHECKED_PREFIX : NEVER_COMPARED_PREFIX;
  const why = text.slice(prefix.length);
  return { [NO_ANSWER_KEY]: kind === 'never-compared' ? 'measures the machine' : 'refused', why };
}

/**
 * The observations of a capture, or the list itself when that is what was handed over.
 * @param {Capture|Observation[]} x
 * @returns {Observation[]}
 */
function observationsOf(x) {
  return Array.isArray(x) ? x : x.observations;
}

/**
 * The addresses an adapter uses to say, in one place, whether the product was reached at all.
 *
 * `cli.<journey>.ran at all` and `api.<journey>.answered at all` are a convention that
 * predates this file — `cluster.js` groups them and `check.js` reads them — and it is exactly
 * the sentence needed here. An adapter is the only thing that knows whether it got to the
 * product, and this is where it already says so.
 */
const REACHED_THE_PRODUCT_AT_ALL = ['ran at all', 'answered at all'];

/**
 * Did this walk get the product to say anything at all?
 *
 * Three ways to answer no, and the first one is the one that needs an adapter's word for it:
 *
 *   1. The adapter said outright that it never reached the product — a refusal at
 *      `<surface>.<journey>.ran at all`. This is the case a channel count cannot see. A
 *      command that throws on its first line still fills the complaints channel with a real
 *      stack trace and a real exit code, and those ARE facts, and they are facts about a
 *      crash rather than about the product. Two builds that crash identically then agree at
 *      every address, and on 2026-08-31 that agreement came back as "Nothing that worked has
 *      changed" over a product whose entire output had been rewritten in between.
 *   2. Every product-channel observation it has is a refusal. The adapter was asked and said
 *      it could not.
 *   3. Nothing else. A walk with no product-channel observations at all — the source reader,
 *      which only lists doors it has read — is neither evidence that the product ran nor
 *      evidence that it would not, so it answers `true` and is left to the coverage ledger,
 *      which is where a door nobody walked through is already counted.
 *
 * @param {Capture|Observation[]} capture
 * @returns {boolean}
 */
export function answeredAnything(capture) {
  const all = observationsOf(capture);
  const journey = Array.isArray(capture) ? undefined : capture.journey;
  for (const o of all) {
    if (!isNoAnswer(o.value)) continue;
    if (!REACHED_THE_PRODUCT_AT_ALL.some((tail) => o.path.endsWith(`.${tail}`))) continue;
    // THIS journey's own address, not any address shaped like one. The adapters build it as
    // `<surface>.<journey name>.ran at all`, so the second segment names whose walk it is.
    // Without this check one refusal shaped like the sentence would take down a walk it says
    // nothing about, and every real difference in that walk would go with it — the whole
    // point of the change is to stop losing comparisons, not to lose more of them.
    if (journey === undefined || splitPath(o.path)[1] === journey) return false;
  }
  const fromTheProduct = all.filter((o) => CHANNELS_ONLY_A_RUNNING_PRODUCT_FILLS.has(o.channel));
  if (fromTheProduct.length === 0) return true;
  return fromTheProduct.some((o) => isAnswer(o.value));
}

/**
 * The refusals in a list, so a caller can name them rather than count them.
 * @param {Capture|Observation[]} capture
 * @returns {Observation[]}
 */
export function refusalsIn(capture) {
  return observationsOf(capture).filter((o) => isNoAnswer(o.value));
}

/**
 * One address that could not be put side by side, and which side was missing.
 *
 * @typedef {object} Uncompared
 * @property {string} path
 * @property {Channel} channel
 * @property {'lost'|'recovered'|'never-answered'} kind
 *   `lost`        — the standard has an answer here and this build has none. Coverage this
 *                   build took away, and the one shape of this that is bad news.
 *   `recovered`   — the standard has no answer here and this build does. Good news, and the
 *                   thing that used to arrive as a pile of findings nobody caused.
 *   `never-answered` — neither side answered. Silent until today; the comparison covered
 *                   nothing here and said nothing about it.
 * @property {string} why
 * @property {string} [journey]
 * @property {string} [describe]
 */

/**
 * Compare two captures, putting only answers beside answers.
 *
 * This is `diffCaptures` with the one rule this file exists for wrapped around it: an address
 * where either side holds a refusal is not compared at all, and comes back in the second list
 * instead of the first. Nothing is lost by that — a refusal never carried a fact about the
 * product — and what is gained is that the tool stops turning "I could not look" into either
 * "it is fine" or "you broke it", which are the only two things it could say before.
 *
 * @param {Capture|Observation[]} reference
 * @param {Capture|Observation[]} candidate
 * @returns {{differences: Difference[], uncompared: Uncompared[]}}
 */
export function compareAnswers(reference, candidate) {
  const refIndex = indexByPath(observationsOf(reference));
  const candIndex = indexByPath(observationsOf(candidate));
  const journey = Array.isArray(candidate)
    ? Array.isArray(reference)
      ? undefined
      : reference.journey
    : candidate.journey;

  /** @type {Uncompared[]} */
  const uncompared = [];
  // Every address that is incomparable on EITHER side, so it can be taken out of BOTH before
  // anything is diffed. Filtering only the side that holds the refusal is not enough and was
  // the first way this was written: drop the reference's refusal and the candidate's real
  // answer at the same address has nothing opposite it, so it comes back as an address that
  // has just APPEARED — which is the phantom finding, arriving by a new road.
  /** @type {Set<string>} */
  const notComparable = new Set();

  for (const path of new Set([...refIndex.keys(), ...candIndex.keys()])) {
    const was = refIndex.get(path);
    const now = candIndex.get(path);
    const before = was ? comparability(was.value) : 'absent';
    const after = now ? comparability(now.value) : 'absent';
    if (before === 'answer' && after === 'answer') continue;
    if (before === 'answer' && after === 'absent') continue; // vanished — a real finding
    if (before === 'absent' && after === 'answer') continue; // appeared — a real finding
    notComparable.add(path);
    // A value the tool has decided never to compare is not a hole and never a difference,
    // in any direction. This is the branch that stops `count.<journey>.duration` arriving
    // as a money-class finding the first time a refused journey starts running.
    if (before === 'never-compared' || after === 'never-compared') continue;

    /** @type {Uncompared['kind']} */
    let kind;
    if (before === 'answer') kind = 'lost';
    else if (after === 'answer') kind = 'recovered';
    else kind = 'never-answered';

    const holder = kind === 'lost' ? now : kind === 'recovered' ? was : (now ?? was);
    const why =
      kind === 'lost'
        ? whyNoAnswer(now?.value, now)
        : kind === 'recovered'
          ? whyNoAnswer(was?.value, was)
          : whyNoAnswer(now?.value ?? was?.value, now ?? was);

    /** @type {Uncompared} */
    const entry = {
      path,
      channel: (now ?? was)?.channel ?? 'results',
      kind,
      why,
    };
    if (journey) entry.journey = journey;
    const describe = holder?.meta?.describe;
    if (describe) entry.describe = describe;
    uncompared.push(entry);
  }

  uncompared.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Only answers go into the arithmetic. Filtering here rather than inside `diffCaptures`
  // keeps the one comparison in the tool exactly where the design put it, in observation.js,
  // and keeps this rule readable in one place instead of threaded through it.
  const differences = diffCaptures(
    onlyAnswers(reference, refIndex, notComparable),
    onlyAnswers(candidate, candIndex, notComparable),
  );

  return { differences, uncompared };
}

/**
 * The same capture with every incomparable address taken out of it, keeping the journey name
 * so a difference can still say which walk it came from.
 *
 * The address list is shared between the two sides on purpose: an address is comparable only
 * when BOTH sides hold an answer at it, so both sides have to lose it together or the
 * surviving one reads as having appeared or vanished.
 *
 * @param {Capture|Observation[]} capture
 * @param {Map<string, Observation>} index
 * @param {Set<string>} notComparable
 * @returns {Capture|Observation[]}
 */
function onlyAnswers(capture, index, notComparable) {
  const kept = [...index.values()].filter((o) => isAnswer(o.value) && !notComparable.has(o.path));
  if (Array.isArray(capture)) return kept;
  return { ...capture, observations: kept };
}
