/**
 * Five hundred differences are not five hundred findings.
 *
 * Rename one field on a response and it differs on every response. Change one
 * colour token and it differs on every screen. Reported one line at a time that
 * is a wall an agent will not read and a person cannot judge, and the tool
 * becomes the thing everybody switches off. So differences are grouped by what
 * they ARE rather than by where they happened: same channel, same shape of
 * change, same move from one value to another. One finding, with a count.
 *
 * The grouping key is deliberately exact in one place and coarse in another.
 * Exact on the value transition, because "5 became 6" and "5 became 9" are two
 * different bugs. Coarse on the address, because the whole point is that the
 * same thing happened in two hundred places and their addresses all differ.
 *
 * One special case earns its own code: a rename arrives as two unrelated
 * differences — something vanished, something appeared — and grouping them
 * separately reports one edit as two findings, which is exactly the confusion
 * this file exists to prevent.
 */

import { sha256, shortHash } from '../core/hash.js';
import { splitPath, sameValue } from './observation.js';

/** @typedef {import('./types.js').Difference} Difference */
/** @typedef {import('./types.js').Finding} Finding */
/** @typedef {import('./types.js').Channel} Channel */
/** @typedef {import('./types.js').ObservedValue} ObservedValue */

/** How much of a cluster a finding carries with it. Enough to orient, not enough to bury. */
const KEEP_NEAR_FILES = 5;

/**
 * How many of a cluster's addresses travel with the finding. `count` always says how
 * many there really are, so a long cluster cannot hide its size behind a short list.
 */
const KEEP_PATHS = 20;

/**
 * How each channel introduces itself. This is the first half of every sentence
 * an agent reads, so it is written for somebody who has never seen this tool.
 *
 * @type {Record<Channel, string>}
 */
const CHANNEL_WORDS = {
  meaning: 'On screen',
  effects: 'In what the program sends out',
  complaints: 'In what the program complains about',
  results: 'In what the program gives back',
  contract: 'In the doors the code opens',
  counters: 'In the counts and timings',
  pixels: 'In the picture',
};

/**
 * Last segments too vague to identify anything alone. When an address ends in
 * one of these, the segment before it comes along for the ride.
 */
const VAGUE = new Set([
  'value',
  'text',
  'name',
  'state',
  'label',
  'title',
  'count',
  'enabled',
  'visible',
  'status',
  'type',
  'id',
  'body',
  'result',
  'exit',
]);

/**
 * Group differences into findings.
 *
 * @param {Difference[]} differences
 * @param {{sources?: Record<string, string>}} [opts]
 *   `sources` maps an observation path to the source file it came from, which is
 *   what lets ranking work out how far a finding is from the edit. Build it from
 *   the candidate captures' observation meta; leave it out and findings simply
 *   say their distance is unknown.
 * @returns {Finding[]}
 */
export function clusterDifferences(differences, opts = {}) {
  const list = differences ?? [];
  const renames = findRenames(list);

  /** @type {Map<string, Difference[]>} */
  const groups = new Map();
  /** @type {Map<string, {from: string, to: string}>} */
  const renameNames = new Map();

  for (const d of list) {
    const rename = renames.get(d);
    const signature = rename
      ? `${d.channel} | renamed | ${generalise(rename.from)} | ${generalise(rename.to)}`
      : signatureOf(d);
    if (rename) renameNames.set(signature, rename);
    const bucket = groups.get(signature);
    if (bucket) bucket.push(d);
    else groups.set(signature, [d]);
  }

  /** @type {Finding[]} */
  const findings = [];
  for (const [signature, members] of groups) {
    findings.push(buildFinding(signature, members, renameNames.get(signature), opts.sources ?? {}));
  }

  // Biggest first is only a starting order — rank.js decides the real one — but
  // a stable order matters, because two runs that found the same things have to
  // hand back the same list in the same order.
  findings.sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.id.localeCompare(b.id));
  return findings;
}

/**
 * Spot the pairs where one name was swapped for another.
 *
 * A rename is: in the same place, on the same channel, one address went away,
 * one arrived, and they hold the same value. Two conditions carry the weight.
 * Exactly one of each in that place — two of each is a rewrite, not a rename,
 * and guessing which pairs with which would be a fiction. And the values must
 * match, or this is two unrelated edits that happened to land side by side.
 *
 * @param {Difference[]} differences
 * @returns {Map<Difference, {from: string, to: string}>} the differences that are
 *   halves of a rename, each pointing at the old and new name
 */
export function findRenames(differences) {
  /** @type {Map<string, {gone: Difference[], came: Difference[]}>} */
  const places = new Map();
  for (const d of differences) {
    if (d.kind !== 'vanished' && d.kind !== 'appeared') continue;
    const at = `${d.journey ?? ''} ${d.channel} ${parentOf(d.path)}`;
    const place =
      places.get(at) ?? /** @type {{gone: Difference[], came: Difference[]}} */ ({ gone: [], came: [] });
    if (d.kind === 'vanished') place.gone.push(d);
    else place.came.push(d);
    places.set(at, place);
  }

  /** @type {Map<Difference, {from: string, to: string}>} */
  const found = new Map();
  for (const place of places.values()) {
    if (place.gone.length !== 1 || place.came.length !== 1) continue;
    const gone = place.gone[0];
    const came = place.came[0];
    if (!sameValue(gone.reference, came.candidate)) continue;
    const from = leafOf(gone.path);
    const to = leafOf(came.path);
    if (from === to) continue;
    found.set(gone, { from, to });
    found.set(came, { from, to });
  }
  return found;
}

/**
 * The grouping key: channel, shape of change, what the address ends in, and the
 * move from one value to another.
 *
 * @param {Difference} d
 * @returns {string}
 */
export function signatureOf(d) {
  return [d.channel, d.kind, generalise(smartLeaf(d.path)), faceOf(d.reference), faceOf(d.candidate)].join(
    ' | ',
  );
}

/**
 * Every journey a finding shows up on. Findings hold differences, and each
 * difference knows its own journey, so this is derived rather than stored — one
 * fewer field that can disagree with the list beside it.
 *
 * @param {Finding} finding
 * @returns {string[]}
 */
export function journeysOf(finding) {
  return unique(finding.differences.map((d) => d.journey));
}

/**
 * @param {string} signature
 * @param {Difference[]} members
 * @param {{from: string, to: string}|undefined} rename
 * @param {Record<string, string>} sources
 * @returns {Finding}
 */
function buildFinding(signature, members, rename, sources) {
  const head = members[0];
  const nearFiles = unique(members.map((m) => sources[m.path])).slice(0, KEEP_NEAR_FILES);
  const evidence = members.find((m) => typeof m.evidence === 'string' && m.evidence.length > 0)?.evidence;
  // Half the differences in a rename are the "vanished" side, so the count of
  // places is the count of pairs, not of rows.
  const count = rename ? Math.max(1, Math.round(members.length / 2)) : members.length;
  // Do all the members really say the same thing, or only the same KIND of thing?
  //
  // The grouping key is coarse on long values on purpose — two five-hundred-character
  // strings that differ in the middle are one finding, not two hundred — and the sentence
  // it produced said "The same thing in 12 places" about twelve different values. An agent
  // reading titles and counts, which is exactly what the design asks it to do, would fix the
  // one example it was shown and take the count as proof of the other eleven. They are not
  // the same thing, and now the sentence says so.
  const identical = members.every((m) => sameValue(m.reference, head.reference) && sameValue(m.candidate, head.candidate));

  /** @type {Finding} */
  const finding = {
    id: shortHash(sha256(signature)),
    title: describe(head, count, rename, identical),
    // Provisional. rank.js replaces this once it knows how far this sits from
    // the edit, which is the only thing that makes the sentence worth reading.
    why: 'Not yet worked out.',
    class: 'ordinary',
    differences: members,
    rank: 0,
    count,
    signature,
    // The addresses, and one difference that stands for the rest. Both are read by
    // everything downstream — the MCP reply lists them, and the self-check corpus
    // matches its patterns against them — so they are filled in here rather than
    // left for each reader to dig out of `differences` in its own way.
    paths: members.map((m) => m.path).slice(0, KEEP_PATHS),
    sample: head,
  };
  if (nearFiles.length > 0) finding.nearFiles = nearFiles;
  if (evidence) finding.evidence = evidence;
  return finding;
}

/**
 * One plain sentence. No addresses, no jargon, no test ids — the reader is an
 * agent deciding whether to spend tokens on this, or a person deciding whether
 * to care.
 *
 * @param {Difference} d
 * @param {number} count
 * @param {{from: string, to: string}} [rename]
 * @param {boolean} [identical]  True when every place in the group moved between the SAME two
 *                               values. False means the same kind of change with its own
 *                               values each time, and the sentence has to say which.
 * @returns {string}
 */
export function describe(d, count, rename, identical = true) {
  const where = CHANNEL_WORDS[d.channel] ?? 'Somewhere';
  const name = smartLeaf(d.path);
  const spread =
    count > 1
      ? identical
        ? ` The same thing in ${count} places.`
        : ` The same kind of change in ${count} places, each with its own values — this is one of them, not all of them.`
      : '';

  if (rename) return `${where}, "${rename.from}" is now called "${rename.to}".${spread}`;

  switch (d.kind) {
    case 'changed':
      return `${where}, "${name}" is now ${describeValue(d.candidate)} where it was ${describeValue(d.reference)}.${spread}`;
    case 'appeared':
      return `${where}, "${name}" is there now and was not before. It says ${describeValue(d.candidate)}.${spread}`;
    case 'vanished':
      return `${where}, "${name}" is gone. It used to say ${describeValue(d.reference)}.${spread}`;
    default:
      return `${where}, "${name}" behaves differently.${spread}`;
  }
}

// ---------------------------------------------------------------------------
// Addresses and values, read the way a person would read them
// ---------------------------------------------------------------------------

/** @param {string} path */
export function leafOf(path) {
  const parts = splitPath(path);
  return parts.length > 0 ? parts[parts.length - 1] : String(path ?? '');
}

/** @param {string} path */
export function parentOf(path) {
  return splitPath(path).slice(0, -1).join('.');
}

/**
 * The last segment, plus the one before it when the last is too vague to mean
 * anything alone. "enabled" tells a reader nothing; "button:Save / enabled"
 * tells them everything.
 *
 * @param {string} path
 */
export function smartLeaf(path) {
  const parts = splitPath(path);
  if (parts.length === 0) return String(path ?? '');
  const last = parts[parts.length - 1];
  if (parts.length > 1 && VAGUE.has(last.toLowerCase())) return `${parts[parts.length - 2]} / ${last}`;
  return last;
}

/**
 * Flatten the parts of a name that are always different anyway: row numbers,
 * ids, hashes. Without this, two hundred rows of one table look like two hundred
 * separate findings.
 *
 * @param {string} text
 */
export function generalise(text) {
  return String(text ?? '')
    .replace(/\b[0-9a-f]{8,}\b/gi, 'x')
    .replace(/\d+/g, '#');
}

/**
 * A value reduced to its recognisable face, for grouping.
 *
 * Short values keep their exact text, because the exact move from one to the
 * other is what makes two differences the same finding. Long values keep only
 * their shape, because two long strings differing in the middle are still the
 * same kind of change and nobody wants them listed one by one.
 *
 * @param {ObservedValue|undefined} value
 * @returns {string}
 */
export function faceOf(value) {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'number' || kind === 'boolean') return String(value);
  if (kind === 'string') {
    const text = /** @type {string} */ (value);
    return text.length <= 60 ? JSON.stringify(text) : `text of about ${bucket(text.length)} characters`;
  }
  if (Array.isArray(value)) return `list of ${bucket(value.length)}`;
  return `{${Object.keys(/** @type {object} */ (value)).sort().join(',')}}`;
}

/**
 * A value written for a person to read in the middle of a sentence.
 * @param {ObservedValue|undefined} value
 * @returns {string}
 */
export function describeValue(value) {
  if (value === undefined || value === null) return 'nothing';
  const kind = typeof value;
  if (kind === 'number' || kind === 'boolean') return String(value);
  if (kind === 'string') {
    const text = /** @type {string} */ (value);
    if (text.length === 0) return 'empty';
    return text.length <= 70 ? JSON.stringify(text) : `${JSON.stringify(text.slice(0, 67))} and more`;
  }
  if (Array.isArray(value)) return `a list of ${value.length}`;
  const keys = Object.keys(/** @type {object} */ (value));
  if (keys.length === 0) return 'an empty set of details';
  return `a set of details (${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', and more' : ''})`;
}

/**
 * Sizes bucketed, so "a list of 41" and "a list of 47" group together while "a
 * list of 3" stays on its own — small counts are usually the point, large ones
 * usually are not.
 *
 * @param {number} n
 */
function bucket(n) {
  if (n <= 3) return String(n);
  if (n <= 10) return '4 to 10';
  if (n <= 100) return '11 to 100';
  if (n <= 1000) return 'a few hundred';
  return 'thousands';
}

/**
 * @param {(string|undefined)[]} values
 * @returns {string[]}
 */
function unique(values) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const v of values) {
    if (typeof v !== 'string' || v.length === 0 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
