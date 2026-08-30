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
 *
 * WHAT PUTS A WORD IN HERE. Every address ends either in something the PRODUCT
 * named — an exported function, a route, a control, a field — or in a word this
 * tool wrote to say what was being asked about it. The first kind identifies
 * something on its own. The second kind is the same word on every journey, every
 * door and every screen in the product, so a sentence built out of it names
 * nothing: `"declared" is gone` was a real title, about a route that had been
 * renamed, and the route was sitting one segment to the left the whole time.
 * That sentence is not only read by an agent — it goes verbatim into the block a
 * person reads in the closing summary, and the owner of this tool is not a coder.
 *
 * So this holds the words the tool writes, checked against the addresses the
 * adapters actually produce rather than guessed at. `smartLeaf names the half a
 * reader can act on` in the tests sweeps one real address of every shape through
 * here; a new adapter that ends an address in a shared word belongs in that list
 * and in this set on the same day.
 */
const VAGUE = new Set([
  // What was asked about a thing: the thing itself is one segment to the left.
  'value',
  'text',
  'name',
  'state',
  'label',
  'title',
  'count',
  'size',
  'reason',
  'enabled',
  'visible',
  'status',
  'type',
  'id',
  'body',
  'shape',
  'result',
  'exit',
  // Doors, which all end the same way whatever the door is: a route, a command,
  // an IPC channel, a named control on a phone.
  'declared',
  'registered',
  'reached',
  // What happened when we asked, on every surface there is.
  'asked',
  'answered',
  'answered at all',
  'ran at all',
  'opened at all',
  'walked',
  'read',
  'typed',
  'pressed',
  'done',
  'started',
  'finished',
  'refused',
  'settled',
  'held still',
  'looks like',
  'written',
  'still running',
  'stdout',
  'stderr',
  'controls',
  'picture',
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
  /** @type {{was: string, now: string, from: string, to: string}[]} */
  const moves = [];
  for (const place of places.values()) {
    if (place.gone.length !== 1 || place.came.length !== 1) continue;
    const gone = place.gone[0];
    const came = place.came[0];
    const from = leafOf(gone.path);
    const to = leafOf(came.path);
    if (from === to) continue;
    // "The values must match" is right for a thing addressed by its position, and wrong for
    // one addressed by its own words. A heading lives at `heading:Nine Bakers` and its value
    // reads `a heading called "Nine Bakers"` — rename it and BOTH move, so the values never
    // match and the rename was never spotted. Measured 2026-08-30: renaming one heading on a
    // page came back as five separate findings, one thing vanishing and a different thing
    // appearing, with nothing anywhere saying "renamed". So a value that changed in exactly
    // the same way the name did counts as the same value. Anything else is still two edits
    // that happened to land side by side, which is what this test exists to keep out.
    if (!sameValue(gone.reference, came.candidate) && !movedWithItsName(gone.reference, came.candidate, from, to)) continue;
    found.set(gone, { from, to });
    found.set(came, { from, to });
    moves.push({ was: gone.path, now: came.path, from, to });
  }

  // A rename takes its children with it. Everything under the old address goes away and the
  // same things arrive under the new one — true, and not a second piece of news. Renaming one
  // heading on a page reported the heading AND the two halves of its own `level`, so one edit
  // a person would describe in four words arrived as four findings. Anything that moved with
  // it, unchanged, belongs to the rename that moved it.
  for (const move of moves) {
    for (const gone of differences) {
      if (gone.kind !== 'vanished' || found.has(gone)) continue;
      if (!gone.path.startsWith(`${move.was}.`)) continue;
      const wanted = move.now + gone.path.slice(move.was.length);
      const came = differences.find(
        (d) => d.kind === 'appeared' && !found.has(d) && d.path === wanted && d.channel === gone.channel && sameValue(gone.reference, d.candidate),
      );
      if (!came) continue;
      found.set(gone, { from: move.from, to: move.to });
      found.set(came, { from: move.from, to: move.to });
    }
  }
  return found;
}

/**
 * Did the value change in exactly the way the name did?
 *
 * Only for two addresses naming the same KIND of thing — `heading:X` and `heading:Y`, never
 * `heading:X` and `button:Y` — because the part before the colon is what the thing IS, and a
 * heading becoming a button is not a rename.
 *
 * @param {unknown} before
 * @param {unknown} after
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function movedWithItsName(before, after, from, to) {
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  const wasNamed = /^([^:]+):(.+)$/.exec(from);
  const nowNamed = /^([^:]+):(.+)$/.exec(to);
  if (!wasNamed || !nowNamed) return false;
  if (wasNamed[1] !== nowNamed[1]) return false;
  const was = wasNamed[2];
  const now = nowNamed[2];
  if (!was || was === now) return false;
  return before.split(was).join(now) === after;
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
  // EVERY source file this finding touches, not the first five. The short list was written
  // as "enough to orient, not enough to bury", and the things reading it are not orienting.
  // `sealed.js` searches these names for the words nobody may wave through, so a finding
  // whose sixth file was src/billing/refund.js was classified ordinary and became waivable;
  // `intent.js` matches them against what the agent declared it was changing, and `cause.js`
  // uses them to work out which edit caused what. A cap on the input to the one gate that
  // cannot have a ceiling is the same bug that was closed for differences. Everything that
  // DISPLAYS this list already cuts it itself and says "and N more" when it does.
  const nearFiles = unique(members.map((m) => sources[m.path]));
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
    // EVERY address, not the first twenty. The short list was there to keep a finding small,
    // and it was buying nothing: the finding already carries `differences`, which holds the
    // same addresses AND both values at each of them, so cutting this list saved a fraction
    // of what was being stored anyway. What it cost was real. A waiver is pinned partly to
    // this list, so two three-hundred-address findings that agreed about their first twenty
    // pinned to the same thing; and the reply an agent reads prints the length of this list
    // under the heading "every address that moved", which was a count of twenty about a
    // finding with three hundred. Readers that want a short list still cut it themselves,
    // and every one of them says "and N more" when it does.
    paths: members.map((m) => m.path),
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
    case 'changed': {
      const now = describeValue(d.candidate);
      const was = describeValue(d.reference);
      if (now !== was) return `${where}, "${name}" is now ${now} where it was ${was}.${spread}`;
      // BOTH SIDES CAME OUT IN THE SAME WORDS, so this sentence would say nothing changed
      // while sitting on top of a difference. It is what happens whenever the two values
      // are summarised by their SHAPE and the shape held still: an invoice line that went
      // from "£49.99" to "49.99 GBP" read "is now a set of details (one field: line) where
      // it was a set of details (one field: line)" — twice the same words, on the tool's own
      // flagship example, in the paragraph a person reads rather than an agent. So the
      // summary is put down and the thing that actually moved is named instead.
      const moved = whatMoved(d.reference, d.candidate);
      if (!moved) return `${where}, "${name}" changed, and both versions of it read the same at this length.${spread}`;
      return moved.what === ''
        ? `${where}, "${name}" now reads ${moved.now} where it read ${moved.was}.${spread}`
        : `${where}, "${name}" now has "${moved.what}" reading ${moved.now} where it read ${moved.was}.${spread}`;
    }
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
  // The field names are quoted and counted. Bare, they run into the sentence around them and
  // stop looking like names at all: a shape whose fields are the words "a list of" and "each
  // one" came out as "a set of details (a list of, each one)", which is not a thing anybody
  // can picture. Quoted, it reads as what it is.
  const shown = keys.slice(0, 4).map((k) => JSON.stringify(k)).join(', ');
  return `a set of details (${keys.length === 1 ? 'one field' : `${keys.length} fields`}: ${shown}${keys.length > 4 ? ', and more' : ''})`;
}

/**
 * The smallest thing that actually moved between two values.
 *
 * Only reached when a summary of the two whole values comes out identical, which is exactly
 * when a summary is the wrong thing to print. It walks in until it finds the one field, or
 * the one stretch of text, that is not the same, and hands back that piece with a name for
 * it. `sameValue` is the tool's one comparison, so what counts as "not the same" here is
 * what counts as a difference everywhere else.
 *
 * @param {ObservedValue|undefined} reference
 * @param {ObservedValue|undefined} candidate
 * @param {string[]} [trail]
 * @returns {{what: string, was: string, now: string}|null}
 */
function whatMoved(reference, candidate, trail = []) {
  if (isSetOfDetails(reference) && isSetOfDetails(candidate)) {
    for (const key of [...new Set([...Object.keys(reference), ...Object.keys(candidate)])].sort()) {
      const a = /** @type {Record<string, any>} */ (reference)[key];
      const b = /** @type {Record<string, any>} */ (candidate)[key];
      if (sameValue(a, b)) continue;
      return whatMoved(a, b, [...trail, key]);
    }
    return null;
  }
  if (Array.isArray(reference) && Array.isArray(candidate)) {
    for (let i = 0; i < Math.max(reference.length, candidate.length); i += 1) {
      if (sameValue(reference[i], candidate[i])) continue;
      return whatMoved(reference[i], candidate[i], [...trail, `number ${i + 1}`]);
    }
    return null;
  }
  const what = trail.join(' / ');
  if (typeof reference === 'string' && typeof candidate === 'string') {
    // Two long strings summarise to their first sixty-odd characters, so if they agree that
    // far they read the same however differently they end. A window round the first place
    // they part company says what neither summary can.
    const spot = firstDifference(reference, candidate);
    return { what, was: JSON.stringify(spot.was), now: JSON.stringify(spot.now) };
  }
  const was = describeValue(reference);
  const now = describeValue(candidate);
  return was === now ? null : { what, was, now };
}

/**
 * A window round the first character two pieces of text stop agreeing at, with enough either
 * side to recognise the place.
 *
 * @param {string} a
 * @param {string} b
 * @returns {{was: string, now: string}}
 */
function firstDifference(a, b) {
  // Short enough to read whole, so read it whole. A window round the difference is only
  // worth its ellipses when there is genuinely too much text to print.
  if (a.length <= 70 && b.length <= 70) return { was: a, now: b };
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
  const from = Math.max(0, at - 20);
  /** @param {string} text */
  const window = (text) => `${from > 0 ? '…' : ''}${text.slice(from, at + 40)}${at + 40 < text.length ? '…' : ''}`;
  return { was: window(a), now: window(b) };
}

/**
 * A value made of named fields, as opposed to a list, a number, or a piece of text.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isSetOfDetails(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
