/**
 * Observations, paths, and the arithmetic of difference.
 *
 * This is the engine room. Everything the tool learns about a product — on a phone, in a
 * terminal, over HTTP, out of the source — arrives here as `path -> value` and is compared
 * the same way. There is exactly one comparison in the tool, and it lives in this file.
 *
 * Three things happen here and nothing else does:
 *   1. Facts are made, and a malformed one is rejected AT THE SOURCE. A bad path found three
 *      layers later is a mystery; a bad path found at `makeObservation` is a stack trace
 *      pointing at the collector that wrote it.
 *   2. Two captures are compared, including the paths that appeared and the paths that
 *      vanished — the findings that matter most and the ones pixels never see.
 *   3. The product's own noise is MEASURED, by running the same build twice, and subtracted.
 *      There are no tolerance settings in v2 and there is no place to add one.
 */

import { StaysFixedError } from '../core/errors.js';

/**
 * @typedef {import('./types.js').Observation} Observation
 * @typedef {import('./types.js').ObservedValue} ObservedValue
 * @typedef {import('./types.js').ObservationMeta} ObservationMeta
 * @typedef {import('./types.js').Channel} Channel
 * @typedef {import('./types.js').Capture} Capture
 * @typedef {import('./types.js').Difference} Difference
 * @typedef {import('./types.js').DifferenceKind} DifferenceKind
 * @typedef {import('./types.js').Wobble} Wobble
 * @typedef {import('./types.js').WobbleEntry} WobbleEntry
 * @typedef {import('./types.js').WobbleSubtraction} WobbleSubtraction
 */

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** @type {Channel[]} */
export const CHANNELS = [
  'meaning',
  'effects',
  'complaints',
  'results',
  'contract',
  'counters',
  'pixels',
];

/**
 * What each channel is, in the words we would use to a person. Printed by `doctor` and handed
 * to any agent that asks the tool to describe itself.
 * @type {Record<Channel, string>}
 */
export const CHANNEL_NOTES = {
  meaning: 'What the interface says a control is and does — its role, its name, whether it is on, off or disabled. Not the underlying markup.',
  effects: 'What the product sent out into the world: calls made, files written, processes started, things saved.',
  complaints: 'What the product complained about: console messages, errors, crashes, the code it exited with.',
  results: 'What the product gave back: what it printed, what it answered, what it offers other code.',
  contract: 'The doors the source code says exist: routes, exported functions, message channels. Read without running anything.',
  counters: 'Rough counts and rough timings. Deliberately rough — precise timing is noise, not information.',
  pixels: 'What it looked like. Used to show a person a problem another channel already found.',
};

/**
 * @param {unknown} value
 * @returns {value is Channel}
 */
export function isChannel(value) {
  return typeof value === 'string' && /** @type {string[]} */ (CHANNELS).includes(value);
}

// ---------------------------------------------------------------------------
// Paths — the address space the whole tool is built on
// ---------------------------------------------------------------------------

/** Longest path we will accept. A path is an address; a runaway value must never become one. */
const MAX_PATH_LENGTH = 512;

/** Deepest value we will store. Past this something is recursing, not observing. */
const MAX_VALUE_DEPTH = 64;

/** Control characters and newlines, which would break the store and every log line. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * The path grammar, written out so it can be printed to whoever is wiring the tool up.
 *
 * A path is segments joined with dots, read left to right from the widest thing to the
 * narrowest: surface, then place, then thing, then the property of it.
 *
 *   api.GET./users.status
 *   cli.build.exit
 *   ipc.session:create.registered
 *   screen.home.tree.button:Save.enabled
 *
 * The first segment names the surface so paths from a phone and paths from a terminal sit in
 * one list without colliding. Nothing enforces the vocabulary — a project may invent its own
 * heads — but sticking to these keeps findings readable across products.
 */
export const PATH_RULES = {
  separator: '.',
  maxLength: MAX_PATH_LENGTH,
  minSegments: 2,
  escaped: 'A dot inside one segment is written %2E, and a literal percent is %25. Use joinPath() and you never have to think about it.',
  commonHeads: ['api', 'cli', 'ipc', 'screen', 'file', 'proc', 'store', 'net', 'export', 'route', 'log', 'count'],
  examples: [
    'api.GET./users.status',
    'cli.build.exit',
    'ipc.session:create.registered',
    'screen.home.tree.button:Save.enabled',
  ],
};

/**
 * Make one segment safe to sit inside a path.
 *
 * Escaping rather than stripping matters: `v1.2` and `v12` are different names, and a
 * stripping scheme would quietly merge two different buttons into one address.
 *
 * @param {string} segment
 * @returns {string}
 */
export function escapeSegment(segment) {
  return String(segment).replace(/%/g, '%25').replace(/\./g, '%2E');
}

/**
 * @param {string} segment
 * @returns {string}
 */
export function unescapeSegment(segment) {
  return String(segment).replace(/%2E/gi, '.').replace(/%25/g, '%');
}

/**
 * Build a path out of parts, escaping each one.
 * @param {(string|number)[]} segments
 * @returns {string}
 */
export function joinPath(segments) {
  return segments.map((s) => escapeSegment(String(s))).join('.');
}

/**
 * Split a path back into its unescaped parts.
 * @param {string} path
 * @returns {string[]}
 */
export function splitPath(path) {
  return String(path).split('.').map(unescapeSegment);
}

/**
 * Is this a usable path? Returns the reason it is not, or null when it is fine.
 *
 * Kept separate from `assertPath` so a collector can filter a noisy source without throwing
 * on every stray line.
 *
 * @param {unknown} path
 * @returns {string|null}
 */
export function pathProblem(path) {
  if (typeof path !== 'string') return `a path must be a string, got ${typeof path}`;
  if (path.length === 0) return 'a path cannot be empty';
  if (path.length > MAX_PATH_LENGTH) return `a path cannot be longer than ${MAX_PATH_LENGTH} characters (this one is ${path.length})`;
  if (path !== path.trim()) return 'a path cannot start or end with a space';
  // If this fires, a value has leaked into the address.
  if (CONTROL_CHARS.test(path)) return 'a path cannot contain control characters or newlines';
  if (path.startsWith('.') || path.endsWith('.')) return 'a path cannot start or end with a dot';
  if (path.includes('..')) return 'a path cannot contain an empty segment (two dots in a row)';
  const segments = path.split('.');
  if (segments.length < PATH_RULES.minSegments) {
    return `a path needs at least ${PATH_RULES.minSegments} parts — an address, not a name. Try something like "cli.${path}" or "screen.home.${path}"`;
  }
  for (const s of segments) {
    if (s.trim().length === 0) return 'a path cannot contain a blank segment';
  }
  return null;
}

/**
 * @param {unknown} path
 * @returns {string}
 */
export function assertPath(path) {
  const problem = pathProblem(path);
  if (problem) {
    throw new StaysFixedError(`Bad observation path: ${problem}.`, {
      hint: `Paths look like ${PATH_RULES.examples[0]}. ${PATH_RULES.escaped}`,
    });
  }
  return /** @type {string} */ (path);
}

/**
 * Match a path against a pattern.
 *
 * `*` matches anything inside one segment. `**` matches any number of segments. Used by the
 * normalisation rules and by anything that wants to talk about a family of paths at once.
 *
 *   matchPath('api.GET./users.status', 'api.*.*.status')            -> true
 *   matchPath('screen.home.tree.button:Save.enabled', 'screen.**')  -> true
 *
 * @param {string} path
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchPath(path, pattern) {
  if (pattern === '**' || pattern === path) return true;
  return matchFrom(path.split('.'), 0, pattern.split('.'), 0);
}

/**
 * @param {string[]} p
 * @param {number} startPi
 * @param {string[]} g
 * @param {number} startGi
 * @returns {boolean}
 */
function matchFrom(p, startPi, g, startGi) {
  let pi = startPi;
  let gi = startGi;
  while (gi < g.length) {
    const part = g[gi];
    if (part === '**') {
      // `**` at the end swallows the rest; otherwise try every split point.
      if (gi === g.length - 1) return true;
      for (let k = pi; k <= p.length; k++) {
        if (matchFrom(p, k, g, gi + 1)) return true;
      }
      return false;
    }
    if (pi >= p.length) return false;
    if (!matchSegment(p[pi], part)) return false;
    pi++;
    gi++;
  }
  return pi === p.length;
}

/**
 * @param {string} segment
 * @param {string} pattern
 * @returns {boolean}
 */
function matchSegment(segment, pattern) {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return segment === pattern;
  const source = '^' + pattern.split('*').map(escapeRegExp).join('[^.]*') + '$';
  return new RegExp(source).test(segment);
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A stable order for paths, so two captures always list the same way and a diff of two
 * reports is readable.
 *
 * Segment by segment, and a segment that is all digits compares as a number — otherwise
 * `item.10` sorts before `item.2` and every report reads wrong. Plain `<` rather than
 * `localeCompare` on purpose: locale collation varies with the ICU build, and an order that
 * changes with the machine is exactly the kind of noise this tool exists to remove.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function comparePaths(a, b) {
  if (a === b) return 0;
  const as = a.split('.');
  const bs = b.split('.');
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const x = as[i];
    const y = bs[i];
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
      // '007' and '7' are the same number — fall back to byte order so it is still stable.
      return x < y ? -1 : 1;
    }
    if (xn !== yn) return xn ? -1 : 1; // numbers before words, consistently
    return x < y ? -1 : 1;
  }
  if (as.length === bs.length) return 0;
  return as.length < bs.length ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Values — canonical form, equality, and how far apart two of them are
// ---------------------------------------------------------------------------

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A canonical string for a value: object keys sorted, so two objects that say the same thing
 * in a different key order are equal.
 *
 * Non-finite numbers are written out as text rather than left to `JSON.stringify`, which
 * turns NaN and Infinity into `null` — and a NaN that reads as null is a real difference
 * hidden by a serialiser, which is the one thing this tool must never do.
 *
 * @param {ObservedValue} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalise(value, 0)) ?? 'null';
}

/**
 * @param {ObservedValue} value
 * @param {number} depth
 * @returns {unknown}
 */
function canonicalise(value, depth) {
  if (depth > MAX_VALUE_DEPTH) return '<too deep>';
  if (typeof value === 'number' && !Number.isFinite(value)) return `<number:${String(value)}>`;
  if (Array.isArray(value)) return value.map((v) => canonicalise(v, depth + 1));
  if (isPlainObject(value)) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalise(/** @type {ObservedValue} */ (value[key]), depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * @param {ObservedValue|undefined} a
 * @param {ObservedValue|undefined} b
 * @returns {boolean}
 */
export function sameValue(a, b) {
  if (a === undefined || b === undefined) return a === b;
  if (a === b) return true;
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Roughly how far apart two values are, 0 (identical) to 1 (nothing in common).
 *
 * READ THIS BEFORE USING IT: the number is for sorting a list and for writing a sentence a
 * person can read. It is NOT a threshold and nothing in v2 compares it against one. Whether
 * something differs is decided by equality; whether it counts is decided by measured wobble.
 * Distance only decides what to show first.
 *
 * @param {ObservedValue|undefined} a
 * @param {ObservedValue|undefined} b
 * @param {number} [depth]
 * @returns {number}
 */
export function valueDistance(a, b, depth = 0) {
  if (a === undefined || b === undefined) return a === b ? 0 : 1;
  if (sameValue(a, b)) return 0;
  if (depth > 8) return 1;

  if (typeof a === 'number' && typeof b === 'number') {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
    const scale = Math.max(Math.abs(a), Math.abs(b), 1);
    return clamp01(Math.abs(a - b) / scale);
  }
  if (typeof a === 'string' && typeof b === 'string') return stringDistance(a, b);
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    if (n === 0) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += i < a.length && i < b.length ? valueDistance(a[i], b[i], depth + 1) : 1;
    }
    return clamp01(sum / n);
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    if (keys.size === 0) return 0;
    let sum = 0;
    for (const k of keys) {
      const av = /** @type {ObservedValue|undefined} */ (a[k]);
      const bv = /** @type {ObservedValue|undefined} */ (b[k]);
      sum += av === undefined || bv === undefined ? 1 : valueDistance(av, bv, depth + 1);
    }
    return clamp01(sum / keys.size);
  }
  // Different shapes entirely — a string where a number used to be. As far apart as it gets.
  return 1;
}

/**
 * How much of two strings is shared at their ends. Cheap on purpose: a real edit distance is
 * quadratic and stdout observations run to megabytes.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function stringDistance(a, b) {
  const total = a.length + b.length;
  if (total === 0) return 0;
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  return clamp01(1 - (2 * (prefix + suffix)) / total);
}

/**
 * @param {number} n
 * @returns {number}
 */
function clamp01(n) {
  if (!Number.isFinite(n)) return 1;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// ---------------------------------------------------------------------------
// Making an observation
// ---------------------------------------------------------------------------

/**
 * Check a value is something we can store and compare, and say plainly what is wrong if not.
 * @param {unknown} value
 * @param {string} where     Where inside the value we are, for the error message.
 * @param {number} depth
 * @param {Set<unknown>} seen
 * @returns {string|null}
 */
function valueProblem(value, where, depth, seen) {
  if (depth > MAX_VALUE_DEPTH) return `${where} nests deeper than ${MAX_VALUE_DEPTH} levels`;
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return null;
  if (t === 'undefined') {
    return `${where} is undefined — a fact we do not have is an absent path, not a path holding nothing`;
  }
  if (t === 'function' || t === 'symbol' || t === 'bigint') return `${where} is a ${t}, which cannot be stored or compared`;
  if (value instanceof Date) return `${where} is a Date — write it out as a string first, and let the clock rule normalise it`;
  if (Array.isArray(value) || isPlainObject(value)) {
    if (seen.has(value)) return `${where} contains itself`;
    seen.add(value);
    /** @type {[string, unknown][]} */
    const entries = Array.isArray(value)
      ? value.map((v, i) => /** @type {[string, unknown]} */ ([`${where}[${i}]`, v]))
      : Object.entries(value).map(([k, v]) => /** @type {[string, unknown]} */ ([`${where}.${k}`, v]));
    for (const [childWhere, child] of entries) {
      const problem = valueProblem(child, childWhere, depth + 1, seen);
      if (problem) return problem;
    }
    seen.delete(value);
    return null;
  }
  return `${where} is a ${Object.prototype.toString.call(value)}, which cannot be stored or compared`;
}

/**
 * Make one observation, and refuse to make a broken one.
 *
 * Validation lives here rather than at the store, at the diff or in a report, because a bad
 * path found later is a mystery and a bad path found here is a stack trace pointing straight
 * at the collector that produced it.
 *
 * @param {string} path
 * @param {Channel} channel
 * @param {ObservedValue} value
 * @param {ObservationMeta} [meta]
 * @returns {Observation}
 */
export function makeObservation(path, channel, value, meta) {
  const safePath = assertPath(path);
  if (!isChannel(channel)) {
    throw new StaysFixedError(`Unknown observation channel "${String(channel)}" for ${safePath}.`, {
      hint: `The channels are: ${CHANNELS.join(', ')}.`,
    });
  }
  const problem = valueProblem(value, 'the value', 0, new Set());
  if (problem) {
    throw new StaysFixedError(`Cannot observe ${safePath}: ${problem}.`, {
      hint: 'Observations hold strings, numbers, booleans, null, and arrays or plain objects of those.',
    });
  }
  /** @type {Observation} */
  const observation = { path: safePath, channel, value };
  if (meta && Object.keys(meta).length > 0) observation.meta = meta;
  return observation;
}

/**
 * Put a list of observations in the canonical order.
 * @param {Observation[]} observations
 * @returns {Observation[]}
 */
export function sortObservations(observations) {
  return [...observations].sort((a, b) => comparePaths(a.path, b.path));
}

// ---------------------------------------------------------------------------
// Indexing and diffing
// ---------------------------------------------------------------------------

/**
 * @param {Capture|Observation[]} x
 * @returns {Observation[]}
 */
function observationsOf(x) {
  return Array.isArray(x) ? x : x.observations;
}

/**
 * @param {Capture|Observation[]} x
 * @returns {string|undefined}
 */
function journeyOf(x) {
  return Array.isArray(x) ? undefined : x.journey;
}

/**
 * Index observations by path.
 *
 * The FIRST observation at a path wins. Two facts at one address is a bug in whatever
 * collected them — see `findDuplicatePaths` — and letting the last one win would hide it
 * behind whatever order the collector happened to emit in.
 *
 * @param {Observation[]} observations
 * @returns {Map<string, Observation>}
 */
export function indexByPath(observations) {
  /** @type {Map<string, Observation>} */
  const map = new Map();
  for (const o of observations) {
    if (!map.has(o.path)) map.set(o.path, o);
  }
  return map;
}

/**
 * Paths a capture claimed twice with two different answers. A collector bug, always —
 * reported rather than thrown so one bad address does not lose a whole run.
 *
 * @param {Observation[]} observations
 * @returns {{path: string, values: ObservedValue[]}[]}
 */
export function findDuplicatePaths(observations) {
  /** @type {Map<string, ObservedValue[]>} */
  const seen = new Map();
  for (const o of observations) {
    const list = seen.get(o.path);
    if (list) list.push(o.value);
    else seen.set(o.path, [o.value]);
  }
  /** @type {{path: string, values: ObservedValue[]}[]} */
  const out = [];
  for (const [path, values] of seen) {
    if (values.length < 2) continue;
    /** @type {ObservedValue[]} */
    const distinct = [];
    for (const v of values) {
      if (!distinct.some((d) => sameValue(d, v))) distinct.push(v);
    }
    if (distinct.length > 1) out.push({ path, values: distinct });
  }
  return out.sort((a, b) => comparePaths(a.path, b.path));
}

/**
 * Compare a reference capture against a candidate capture.
 *
 * Three kinds come out, and the last two are what this tool exists for:
 *   changed   — the same address now answers differently
 *   appeared  — an address that did not exist before
 *   vanished  — an address that has stopped existing. A door that closed. No screenshot
 *               comparison has ever noticed one of these.
 *
 * @param {Capture|Observation[]} reference
 * @param {Capture|Observation[]} candidate
 * @returns {Difference[]}
 */
export function diffCaptures(reference, candidate) {
  const ref = indexByPath(observationsOf(reference));
  const cand = indexByPath(observationsOf(candidate));
  const journey = journeyOf(candidate) ?? journeyOf(reference);

  /** @type {Difference[]} */
  const out = [];

  for (const [path, r] of ref) {
    const c = cand.get(path);
    if (!c) {
      out.push(difference(path, r.channel, 'vanished', r.value, undefined, journey, r, undefined));
      continue;
    }
    if (!sameValue(r.value, c.value)) {
      out.push(difference(path, c.channel, 'changed', r.value, c.value, journey, r, c));
    }
  }

  for (const [path, c] of cand) {
    if (!ref.has(path)) {
      out.push(difference(path, c.channel, 'appeared', undefined, c.value, journey, undefined, c));
    }
  }

  return out.sort((a, b) => comparePaths(a.path, b.path));
}

/**
 * @param {string} path
 * @param {Channel} channel
 * @param {DifferenceKind} kind
 * @param {ObservedValue|undefined} referenceValue
 * @param {ObservedValue|undefined} candidateValue
 * @param {string|undefined} journey
 * @param {Observation|undefined} refObs
 * @param {Observation|undefined} candObs
 * @returns {Difference}
 */
function difference(path, channel, kind, referenceValue, candidateValue, journey, refObs, candObs) {
  /** @type {Difference} */
  const d = {
    path,
    channel,
    kind,
    distance: valueDistance(referenceValue, candidateValue),
  };
  if (referenceValue !== undefined) d.reference = referenceValue;
  if (candidateValue !== undefined) d.candidate = candidateValue;
  if (journey) d.journey = journey;

  const describe = candObs?.meta?.describe ?? refObs?.meta?.describe;
  if (describe) d.describe = describe;
  const evidence = candObs?.meta?.evidence ?? refObs?.meta?.evidence;
  if (evidence) d.evidence = evidence;

  // One address arriving on two different channels is worth saying out loud: two collectors
  // are both claiming it, and one of them is wrong about what it is looking at.
  if (refObs && candObs && refObs.channel !== candObs.channel) {
    const prefix = d.describe ? d.describe + ' ' : '';
    d.describe = `${prefix}(this address was observed as ${refObs.channel} before and ${candObs.channel} now — two collectors are claiming it)`;
  }
  return d;
}

// ---------------------------------------------------------------------------
// Wobble — the product arguing with itself
// ---------------------------------------------------------------------------

/**
 * Measure what a build disagrees with itself about, by comparing two runs of the SAME build.
 *
 * This replaces every tolerance setting the old tool had. A tolerance is a guess about how
 * much noise a product makes; this is the measurement. Two runs, same bytes, same machine,
 * minutes apart — anything that differs was not caused by anybody's change.
 *
 * @param {Capture|Observation[]} runA
 * @param {Capture|Observation[]} runB
 * @returns {Wobble}
 */
export function measureWobble(runA, runB) {
  const a = Array.isArray(runA) ? undefined : runA;
  const b = Array.isArray(runB) ? undefined : runB;

  if (a && b && a.build.id !== b.build.id) {
    throw new StaysFixedError(
      `Wobble has to be measured on one build, but these captures are of different builds (${a.build.id} and ${b.build.id}).`,
      { hint: 'Run the same build twice. Comparing two different builds gives a difference, not a wobble.' },
    );
  }
  if (a && b && a.journey !== b.journey) {
    throw new StaysFixedError(
      `Wobble has to be measured on one journey, but these captures walked "${a.journey}" and "${b.journey}".`,
    );
  }

  const indexA = indexByPath(observationsOf(runA));
  const indexB = indexByPath(observationsOf(runB));

  /** @type {WobbleEntry[]} */
  const entries = [];
  let steady = 0;

  for (const [path, oa] of indexA) {
    const ob = indexB.get(path);
    if (!ob) {
      entries.push({ path, channel: oa.channel, kind: 'vanished', a: oa.value, distance: 1 });
      continue;
    }
    if (sameValue(oa.value, ob.value)) {
      steady++;
      continue;
    }
    entries.push({
      path,
      channel: ob.channel,
      kind: 'changed',
      a: oa.value,
      b: ob.value,
      distance: valueDistance(oa.value, ob.value),
    });
  }

  for (const [path, ob] of indexB) {
    if (!indexA.has(path)) {
      entries.push({ path, channel: ob.channel, kind: 'appeared', b: ob.value, distance: 1 });
    }
  }

  entries.sort((x, y) => comparePaths(x.path, y.path));

  return {
    buildId: a?.build.id ?? b?.build.id ?? '',
    journey: a?.journey ?? b?.journey ?? '',
    runs: [a?.id ?? 'a', b?.id ?? 'b'],
    entries,
    unstable: entries.map((e) => e.path),
    steady,
    measured: true,
  };
}

/**
 * A wobble record for the case where the build was only run once.
 *
 * It subtracts nothing, and it exists so the rest of the pipeline never has to ask whether it
 * has a measurement — it asks `measured`, and a run that could not measure says so in its
 * summary instead of pretending its list is clean.
 *
 * @param {string} buildId
 * @param {string} journey
 * @returns {Wobble}
 */
export function unmeasuredWobble(buildId, journey) {
  return { buildId, journey, runs: ['', ''], entries: [], unstable: [], steady: 0, measured: false };
}

/**
 * Fold several journeys' wobble into one record, so a whole-product run subtracts in one go.
 *
 * One journey that could not be measured twice makes the whole record unmeasured, because the
 * alternative is a summary claiming a clean subtraction over a list that is partly raw.
 *
 * @param {Wobble[]} wobbles
 * @returns {Wobble}
 */
export function mergeWobble(wobbles) {
  if (wobbles.length === 1) return wobbles[0];
  /** @type {WobbleEntry[]} */
  const entries = [];
  const seen = new Set();
  let steady = 0;
  let measured = wobbles.length > 0;
  for (const w of wobbles) {
    if (!w.measured) measured = false;
    steady += w.steady;
    for (const e of w.entries) {
      if (seen.has(e.path)) continue;
      seen.add(e.path);
      entries.push(e);
    }
  }
  entries.sort((a, b) => comparePaths(a.path, b.path));
  return {
    buildId: wobbles[0]?.buildId ?? '',
    journey: '*',
    runs: [wobbles[0]?.runs[0] ?? '', wobbles[0]?.runs[1] ?? ''],
    entries,
    unstable: entries.map((e) => e.path),
    steady,
    measured,
  };
}

/**
 * Subtract the measured noise from the differences.
 *
 * The rule is set subtraction and nothing cleverer: if a path will not sit still between two
 * runs of the same build, a difference at that path proves nothing, whatever its size. Any
 * "but it changed by MORE than the wobble did" rule is a tolerance wearing a disguise, and
 * tolerances are how tools like this die — too loose to catch the real thing, too tight to
 * leave switched on.
 *
 * The third result is the one no other tool produces. A path that was steady in the reference
 * and wobbles now is a finding in itself: the change made something unpredictable. Nothing is
 * "wrong" at that address and it still needs fixing.
 *
 * @param {Difference[]} differences
 * @param {Wobble} wobble                                Measured on the candidate build.
 * @param {{referenceWobble?: Wobble, steadyInReference?: string[]}} [opts]
 * @returns {WobbleSubtraction}
 */
export function subtractWobble(differences, wobble, opts = {}) {
  const unstableNow = new Set(wobble.unstable);
  // NOT symmetric, and that is deliberate. Subtracting the OLD build's wobble as well was
  // tried on 2026-08-30 and taken straight back out: a path the old build answered randomly
  // and the new build now answers the same way every time is a REAL change — somebody made
  // something deterministic, or hard-coded what used to vary — and subtracting the old
  // build's wobble is exactly what would hide it. Where both builds wobble at a path, the
  // candidate's own wobble already covers it, so nothing is lost by leaving this alone.

  /** @type {Difference[]} */
  const real = [];
  /** @type {Difference[]} */
  const noise = [];

  for (const d of differences) {
    const wobbling = unstableNow.has(d.path);
    // Copy rather than mutate: the caller's list is often the stored diff, and a flag written
    // into it becomes a fact nobody can trace back to whoever decided it.
    const flagged = { ...d, real: !wobbling, wobbling };
    if (wobbling) noise.push(flagged);
    else real.push(flagged);
  }

  const referenceWobble = opts.referenceWobble;
  const steadyBefore = opts.steadyInReference ? new Set(opts.steadyInReference) : null;
  const couldTell = Boolean((referenceWobble && referenceWobble.measured) || steadyBefore);

  /** @type {WobbleEntry[]} */
  let newlyUnstable = [];
  if (couldTell) {
    const unstableBefore = new Set(referenceWobble?.unstable ?? []);
    newlyUnstable = wobble.entries.filter((e) => {
      if (unstableBefore.has(e.path)) return false;
      // With an explicit steady list we only claim the paths it names. Without one, anything
      // the reference did not record as unstable counts.
      return steadyBefore ? steadyBefore.has(e.path) : true;
    });
  }

  return {
    real,
    noise,
    newlyUnstable,
    couldTellNewlyUnstable: couldTell,
    note: subtractionNote(wobble, couldTell, real.length, noise.length, newlyUnstable.length),
  };
}

/**
 * The sentence that goes in the summary. Written here so every caller says the same honest
 * thing rather than inventing its own wording.
 *
 * @param {Wobble} wobble
 * @param {boolean} couldTell
 * @param {number} realCount
 * @param {number} noiseCount
 * @param {number} newlyUnstableCount
 * @returns {string}
 */
function subtractionNote(wobble, couldTell, realCount, noiseCount, newlyUnstableCount) {
  if (!wobble.measured) {
    return `The new build was only run once, so none of its own noise has been subtracted. All ${realCount} difference${realCount === 1 ? '' : 's'} here may include things that change on every run. Run it twice for a clean list.`;
  }
  const parts = [
    `Running the new build twice showed ${wobble.unstable.length} address${wobble.unstable.length === 1 ? '' : 'es'} that will not sit still, and ${wobble.steady} that ${wobble.steady === 1 ? 'does' : 'do'}.`,
    `${noiseCount} difference${noiseCount === 1 ? '' : 's'} landed on the unsteady ones and ${noiseCount === 1 ? 'was' : 'were'} dropped; ${realCount} remain${realCount === 1 ? 's' : ''}.`,
  ];
  if (!couldTell) {
    parts.push('There is no record of how steady the old build was, so nothing can be reported as newly unpredictable.');
  } else if (newlyUnstableCount > 0) {
    parts.push(`${newlyUnstableCount} address${newlyUnstableCount === 1 ? ' was' : 'es were'} steady before and unpredictable now — the change made something non-deterministic.`);
  } else {
    parts.push('Nothing that used to be steady has become unpredictable.');
  }
  return parts.join(' ');
}
