/**
 * The adapter interface — written once, so the engine never knows what it is driving.
 *
 * The engine's job is arithmetic: run the new build twice, subtract the wobble, compare
 * what is left against the reference. It does that over a flat list of `path -> value`
 * observations and nothing else. An adapter's job is to turn one platform — a CLI, a
 * server, a browser, a phone — into that flat list. Six more adapters will be written
 * against this file, so the shape has to be right the first time.
 *
 * The five methods, in the order the engine calls them:
 *
 *   detect(project)         Can you drive this project on this machine, right now? Also:
 *                           what is missing that would let you drive more of it? This is
 *                           what `doctor` reports, and it is the first thing an agent asks.
 *   journeys(project)       What steps do you know how to walk? Read out of the code, out
 *                           of the project's own test suite, out of a recording — never
 *                           out of a person.
 *   prepare(build)          Get one build ready to be walked. Unpack it, install it into a
 *                           scratch copy, boot it. Called once per build, not per journey,
 *                           because booting is the expensive part.
 *   run(journey, build, ctx)  Walk one journey against one prepared build and report what
 *                           you saw, as Observations.
 *   teardown()              Put everything back. Kill only what you started.
 *
 * Three rules every adapter obeys, and the engine cannot enforce for you:
 *
 *   1. NEVER TOUCH THE REAL PROJECT. Work in a scratch copy. The person running this has
 *      the real thing open in an editor.
 *   2. NEVER LET SOMETHING IRREVERSIBLE HAPPEN. Money, messages, deleted data. Watch the
 *      call go out, record that it was asked for, and refuse it at the wire. A refusal is
 *      reported with `covered: false` — missing coverage, never a pass.
 *   3. NEVER KILL WHAT YOU DID NOT START. Somebody's own app may be running.
 */

import { CHANNELS, isChannel, joinPath as joinSegments, makeObservation } from '../observation.js';

export { CHANNELS };

/** @typedef {import('../types.js').Channel} Channel */
/** @typedef {import('../types.js').Surface} Surface */
/** @typedef {import('../types.js').Observation} Observation */
/** @typedef {import('../types.js').ObservedValue} JsonValue */
/** @typedef {import('../types.js').Journey} Journey */

/**
 * Why a thing was not observed. Short vocabulary on purpose: the engine counts these and
 * reports them as holes, and a free-text reason cannot be counted.
 *
 * @typedef {'irreversible'|'missing tool'|'refused'|'too big'|'timed out'|'not supported here'|'crashed'|'needs a sample'} NotCoveredReason
 */

/** @type {Record<NotCoveredReason, string>} */
export const NOT_COVERED_MEANING = Object.freeze({
  irreversible: 'doing this for real would spend money, send a message, or destroy data',
  'missing tool': 'something this machine does not have would be needed',
  refused: 'the project asked us not to',
  'too big': 'the value was too large to keep, so only a fingerprint of it was kept',
  'timed out': 'it did not finish in the time allowed',
  'not supported here': 'this platform cannot be observed this way, and saying so is the honest answer',
  crashed: 'the thing being observed fell over before it could be read',
  'needs a sample': 'a real value has to be supplied before this can be tried at all',
});

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

/**
 * One build, as the engine hands it to an adapter.
 *
 * `root` is a directory the adapter may read. It is NOT the person's working copy unless
 * the engine says so, and an adapter must not write into it either way.
 *
 * @typedef {object} Build
 * @property {string} id                  Content-addressed id of this build.
 * @property {string} label               Plain English: 'the build you shipped', 'your change'.
 * @property {'reference'|'candidate'} role
 * @property {string} root                Directory holding the source or the unpacked artifact.
 * @property {string} [artifact]          Path to a packaged artifact, when there is one.
 * @property {string|null} [gitSha]
 */

/**
 * A build that has been made ready to walk.
 *
 * @typedef {object} PreparedBuild
 * @property {Build} build
 * @property {string} root                Where the walkable copy lives. Scratch, always.
 * @property {boolean} ready              False means prepare gave up; `why` says so in English.
 * @property {string} why                 Plain English, always filled in — including on success.
 * @property {Record<string, string|number|boolean>} [facts]
 *                                        Anything a journey needs: a port, a binary path, a pid.
 * @property {() => Promise<void>} dispose  Undo just this build's preparation.
 */

/**
 * One repeatable set of steps.
 *
 * Journeys are never written by a person. They come from the code (free and exact), from
 * the project's own test suite (already written, sitting there unused), from a recorded
 * session, or from an agent that explored one named gap and froze it into a file.
 *
 * @property {string} id                  Stable, file-safe. Becomes the first path segment.
 * @property {string} name                Plain English. 'run the help text', 'GET /api/sessions'.
 * @property {'code'|'suite'|'recording'|'config'|'agent'} from   Where these steps came from.
 * @property {string} [why]               Plain English: why this is worth walking.
 * @property {string} kind                Adapter-specific: 'command', 'import', 'request', ...
 * @property {JsonValue} detail           Adapter-specific payload. The adapter that produced
 *                                        the journey is the only thing that reads it.
 * @property {boolean} [irreversible]     True means walking this for real would spend money,
 *                                        send a message or destroy data. The adapter must
 *                                        observe it at the call boundary and refuse the effect.
 * @property {number} [timeoutMs]
 */

/**
 * What an adapter says about a project when asked whether it can drive it.
 *
 * This is the honest-limits channel, and it is the first thing an agent installing the tool
 * reads. `missing` is the important half: not "no", but "no, and here is the one thing that
 * would turn this into a yes".
 *
 * @typedef {object} Detection
 * @property {boolean} applies            Can this adapter drive this project at all?
 * @property {number} confidence          0..1. How sure. Below 0.5 the engine asks first.
 * @property {string} why                 Plain English, always filled in, including for 'no'.
 * @property {Missing[]} missing          What would unlock more. Empty when nothing would.
 * @property {string[]} [notes]           Anything else worth saying in one line each.
 */

/**
 * One thing that is not here, and what having it would buy.
 *
 * @typedef {object} Missing
 * @property {string} what                'a Java runtime', 'a database snapshot to restore'.
 * @property {string} unlocks             Plain English: what becomes possible once it is there.
 * @property {string} [howToGet]          The exact command or link, filled in where detectable.
 * @property {boolean} [blocking]         True means nothing works without it.
 */

/**
 * Everything a run is allowed to use, handed in rather than reached for, so a run can be
 * cancelled, redirected to a scratch disk, or replayed.
 *
 * @typedef {object} RunContext
 * @property {AbortSignal} [signal]       Cancel. Adapters must honour it.
 * @property {string} scratchDir          Somewhere to write. Wiped between runs by the engine.
 * @property {string} evidenceDir         Somewhere to keep things too big to inline.
 * @property {number} seed                The one seed. Same for both builds, both runs.
 * @property {string} clock               ISO time the product should believe it is.
 * @property {(message: string) => void} [log]     Progress, in plain English.
 * @property {Record<string, any>} [config]  The project's config for THIS adapter — the slice
 *                                        under a key matching the adapter's name. Handed in
 *                                        here as well as to `detect` because `prepare` needs
 *                                        it too, and an adapter that remembered it between
 *                                        calls would be one shared mutable variable away
 *                                        from two builds reading each other's settings.
 * @property {boolean} [allowIrreversible] Default false, and the engine never sets it true.
 *                                        It exists so the refusal is a decision in the code
 *                                        rather than an accident of omission.
 */

/**
 * A platform, taught to the engine.
 *
 * @typedef {object} Adapter
 * @property {string} name                Short id: 'process', 'http', 'source'.
 * @property {string} title               Plain English: 'CLI tools and libraries'.
 * @property {string} describe            One sentence an agent can read to know what this
 *                                        adapter watches and what it cannot see.
 * @property {Channel[]} channels         Which of the seven this adapter can fill. Honest —
 *                                        the coverage ledger is built from these.
 * @property {(project: AdapterProject) => Promise<Detection>} detect
 * @property {(project: AdapterProject) => Promise<Journey[]>} journeys
 * @property {(build: Build, ctx: RunContext) => Promise<PreparedBuild>} prepare
 * @property {(journey: Journey, build: PreparedBuild, ctx: RunContext) => Promise<Observation[]>} run
 * @property {() => Promise<void>} teardown
 */

/**
 * The slice of a project an adapter is allowed to see. Deliberately small: an adapter that
 * can reach the whole engine ends up depending on it.
 *
 * @typedef {object} AdapterProject
 * @property {string} root                The real project root. READ ONLY, always.
 * @property {Record<string, any>} [config]   Whatever the project put in its config for this
 *                                        adapter, under a key matching the adapter's name.
 * @property {Observation[]} [contract]   The static contract, when the source adapter has
 *                                        already read it. This is how the HTTP adapter learns
 *                                        its routes without crawling.
 */

// ---------------------------------------------------------------------------
// Building an adapter
// ---------------------------------------------------------------------------

const REQUIRED_METHODS = ['detect', 'journeys', 'prepare', 'run', 'teardown'];

/**
 * Check an adapter before the engine trusts it, and say what is wrong in plain English.
 *
 * Separate from {@link defineAdapter} so a test, or `doctor`, can ask the question without
 * building anything.
 *
 * @param {Partial<Adapter>} spec
 * @returns {string[]} problems, empty when it is fine
 */
export function checkAdapter(spec) {
  /** @type {string[]} */
  const problems = [];
  if (!spec || typeof spec !== 'object') return ['An adapter has to be an object.'];

  if (typeof spec.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(spec.name)) {
    problems.push('An adapter needs a short lowercase name like "process" or "http".');
  }
  if (typeof spec.title !== 'string' || spec.title.trim() === '') {
    problems.push(`Adapter "${spec.name}" needs a title a person can read, like "CLI tools and libraries".`);
  }
  if (typeof spec.describe !== 'string' || spec.describe.trim() === '') {
    problems.push(`Adapter "${spec.name}" needs one sentence saying what it watches and what it cannot see.`);
  }
  if (!Array.isArray(spec.channels) || spec.channels.length === 0) {
    problems.push(`Adapter "${spec.name}" has to say which channels it fills.`);
  } else {
    for (const channel of spec.channels) {
      if (!isChannel(channel)) {
        problems.push(`Adapter "${spec.name}" claims a channel called "${channel}", which is not one of the seven.`);
      }
    }
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof (/** @type {any} */ (spec)[method]) !== 'function') {
      problems.push(`Adapter "${spec.name}" is missing ${method}().`);
    }
  }
  return problems;
}

/**
 * Take an adapter spec and hand back something the engine can hold.
 *
 * Frozen, because six adapters sharing one engine is exactly the shape where one of them
 * quietly reaches over and patches another.
 *
 * @param {Adapter} spec
 * @returns {Adapter}
 */
export function defineAdapter(spec) {
  const problems = checkAdapter(spec);
  if (problems.length > 0) {
    throw new Error(`This adapter cannot be used yet:\n  - ${problems.join('\n  - ')}`);
  }
  return Object.freeze({ ...spec });
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Build an observation path out of parts.
 *
 * A thin variadic wrapper over the engine's own `joinPath`, which owns the rules: dots
 * between the parts, a dot inside a part escaped so it cannot be mistaken for a separator.
 * It is wrapped rather than re-exported only because reading
 * `path(kind, journey, 'status')` at a call site is easier than reading an array literal,
 * and because every adapter going through one function is what keeps six of them agreeing.
 *
 * The FIRST part is the kind of thing being observed — `api`, `cli`, `ipc`, `route`, `file`,
 * `proc`, `net`, `export`, `count` — not the journey. That ordering is what lets the engine
 * cluster and rank by what broke rather than by which journey happened to find it.
 *
 * @param {...(string|number)} segments
 * @returns {string}
 */
export function joinPath(...segments) {
  return joinSegments(segments.filter((s) => s !== '' && s !== null && s !== undefined).map(String));
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * Put a value into the one shape the comparison engine understands.
 *
 * A pre-pass before the engine's own validator, which rejects anything that is not a
 * string, a number, a boolean, null, or a list or plain object of those. Rather than let an
 * adapter throw because something handed it a Date or a Buffer, everything is turned into
 * something describable first — so a diff can say "this used to be a function" instead of
 * "this used to be nothing".
 *
 * Object keys are sorted, because two runs of the same code can build the same object in a
 * different order and that is not a difference.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @returns {JsonValue}
 */
export function stableValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return /** @type {string|boolean} */ (value);
  if (type === 'number') {
    const n = /** @type {number} */ (value);
    if (Number.isNaN(n)) return '(not a number)';
    if (!Number.isFinite(n)) return n > 0 ? '(infinity)' : '(negative infinity)';
    return n;
  }
  if (type === 'bigint') return `${value}n`;
  if (type === 'function') return `(a function called ${/** @type {Function} */ (value).name || 'nothing'})`;
  if (type === 'symbol') return `(the symbol ${String(value)})`;

  const object = /** @type {object} */ (value);
  if (seen.has(object)) return '(refers back to itself)';
  seen.add(object);

  if (Array.isArray(object)) return object.map((item) => stableValue(item, seen));
  if (object instanceof Date) return object.toISOString();
  if (object instanceof RegExp) return String(object);
  if (object instanceof Error) return `${object.name}: ${object.message}`;
  if (object instanceof Map) {
    return stableValue(Object.fromEntries([...object.entries()].map(([k, v]) => [String(k), v])), seen);
  }
  if (object instanceof Set) return [...object].map((item) => stableValue(item, seen)).sort(compareJson);
  if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) {
    const bytes = object instanceof ArrayBuffer ? object.byteLength : /** @type {ArrayBufferView} */ (object).byteLength;
    return `(${bytes} bytes)`;
  }

  /** @type {Record<string, JsonValue>} */
  const out = {};
  for (const key of Object.keys(object).sort()) {
    out[key] = stableValue(/** @type {any} */ (object)[key], seen);
  }
  return out;
}

/**
 * A total order over stable values, so lists that have no natural order still come out the
 * same way twice. Cheap and only used for sorting.
 * @param {JsonValue} a
 * @param {JsonValue} b
 */
export function compareJson(a, b) {
  const left = typeof a === 'string' ? a : JSON.stringify(a);
  const right = typeof b === 'string' ? b : JSON.stringify(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Making an observation
// ---------------------------------------------------------------------------

/**
 * Make one observation.
 *
 * Everything an adapter sees goes through here, so the shape is identical whatever produced
 * it and so there is exactly one place that knows how an adapter's words map onto the
 * engine's `Observation`. Two rules are enforced here and nowhere else:
 *
 *   - `value` is the ONLY thing compared. The sentence, the file it came from and the
 *     picture backing it up all go into `meta`, which the engine never compares. If any of
 *     them leaked into `value`, a file move or a reworded sentence would report as a
 *     regression.
 *   - `says` is required. It is not decoration: it is what an agent reads when a difference
 *     lands in its lap, and it is the reason nothing about this tool needs documentation.
 *
 * @param {object} spec
 * @param {Channel} spec.channel
 * @param {string|(string|number)[]} spec.path   A finished path, or parts to join.
 * @param {unknown} spec.value
 * @param {string} spec.says
 * @param {boolean} [spec.covered]        False means we did not really look. See `reason`.
 * @param {NotCoveredReason} [spec.reason]
 * @param {{file?: string, line?: number, url?: string}} [spec.where]
 * @param {string} [spec.evidence]
 * @param {string} [spec.journey]
 * @param {Surface} [spec.surface]
 * @returns {Observation}
 */
export function observation(spec) {
  const path = Array.isArray(spec.path) ? joinPath(...spec.path) : spec.path;
  if (!spec.says) throw new Error(`The observation at "${path}" needs one plain sentence saying what it is.`);
  if (!isChannel(spec.channel)) {
    throw new Error(`The observation at "${path}" claims channel "${spec.channel}", which is not one of the seven.`);
  }
  /** @type {import('../types.js').ObservationMeta} */
  const meta = { describe: spec.says };
  if (spec.where?.file) meta.source = spec.where.file;
  else if (spec.where?.url) meta.source = spec.where.url;
  if (spec.where?.line !== undefined) meta.line = spec.where.line;
  if (spec.evidence) meta.evidence = spec.evidence;
  if (spec.journey) meta.journey = spec.journey;
  if (spec.surface) meta.surface = spec.surface;
  if (spec.covered === false) {
    // The engine reads `refused` when it builds the coverage ledger. Everything an adapter
    // could not look at lands here, whichever of the reasons it was — a payment it would not
    // make, a runtime this machine does not have, a parameter nobody supplied. They are all
    // the same thing to a reader: a hole, with the reason attached, and never a pass.
    meta.refused = true;
    meta.refusedWhy = `${NOT_COVERED_MEANING[spec.reason ?? 'refused']} (${spec.reason ?? 'refused'})`;
  }
  return makeObservation(path, spec.channel, stableValue(spec.value), meta);
}

/**
 * A hole, recorded honestly.
 *
 * The rule the whole tool rests on: a refusal is reported as missing coverage, never as a
 * pass. A run that quietly skipped the payment path and said "nothing changed" is worse
 * than no run at all, because somebody believed it.
 *
 * @param {object} spec
 * @param {Channel} spec.channel
 * @param {string|(string|number)[]} spec.path
 * @param {NotCoveredReason} spec.reason
 * @param {string} spec.says              What we would have looked at, and why we did not.
 * @param {{file?: string, line?: number, url?: string}} [spec.where]
 * @returns {Observation}
 */
export function notCovered(spec) {
  return observation({
    channel: spec.channel,
    path: spec.path,
    value: `not checked — ${NOT_COVERED_MEANING[spec.reason]}`,
    says: spec.says,
    covered: false,
    reason: spec.reason,
    where: spec.where,
  });
}

// ---------------------------------------------------------------------------
// Coarse measures
// ---------------------------------------------------------------------------

/**
 * The time ladder. Roughly three times apart, so ordinary variance stays inside one rung
 * and a real slowdown crosses one. Exact milliseconds are never observed: they differ on
 * every run, they would swamp every diff, and nobody has ever fixed a bug because a command
 * took 412ms instead of 389ms.
 */
const TIME_LADDER = /** @type {const} */ ([
  [100, 'instant'],
  [300, 'quick'],
  [1000, 'under a second'],
  [3000, 'a few seconds'],
  [10000, 'several seconds'],
  [30000, 'half a minute'],
  [90000, 'a minute or so'],
  [300000, 'a few minutes'],
]);

/**
 * @param {number} ms
 * @returns {string} a plain-English bucket
 */
export function timeBucket(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  for (const [limit, label] of TIME_LADDER) if (ms < limit) return label;
  return 'over five minutes';
}

/**
 * Sizes, on the same principle as time. A response body that grew by two bytes is not news;
 * one that doubled is.
 * @param {number} bytes
 * @returns {string}
 */
export function sizeBucket(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes === 0) return 'empty';
  const ladder = /** @type {const} */ ([
    [128, 'a line or two'],
    [1024, 'under a kilobyte'],
    [10240, 'a few kilobytes'],
    [102400, 'tens of kilobytes'],
    [1048576, 'hundreds of kilobytes'],
    [10485760, 'a few megabytes'],
    [104857600, 'tens of megabytes'],
  ]);
  for (const [limit, label] of ladder) if (bytes < limit) return label;
  return 'over a hundred megabytes';
}

/**
 * Counts, bucketed once they get big enough that the exact number is noise. Small counts
 * stay exact, because going from three files to four IS the finding.
 * @param {number} n
 * @returns {number|string}
 */
export function countBucket(n) {
  if (!Number.isFinite(n) || n < 0) return 'unknown';
  if (n <= 20) return n;
  if (n < 50) return 'between 21 and 50';
  if (n < 100) return 'between 51 and 100';
  if (n < 500) return 'in the hundreds';
  if (n < 1000) return 'many hundreds';
  return 'thousands';
}

// ---------------------------------------------------------------------------
// Text that has to be the same twice
// ---------------------------------------------------------------------------

/**
 * Rub out the things THIS TOOL varied, and nothing else.
 *
 * This is a deliberately short list, and keeping it short is the point. Every product has
 * volatile output — version strings, ids, dates — and it is tempting to scrub all of it
 * here. Do not. That is the noise-control layer's job, its rules live in the project's git
 * so a person can see and argue with them, and the wobble measurement catches most of it
 * for free. What belongs HERE is only the variation the harness itself introduced: the
 * scratch directory it chose, the port it picked, the temp folder the operating system
 * handed it. Rubbing those out is not judgement, it is undoing our own footprint.
 *
 * @param {string} text
 * @param {object} footprint
 * @param {string[]} [footprint.dirs]     Absolute directories we created for this run.
 * @param {number[]} [footprint.ports]    Ports we picked.
 * @param {string} [footprint.projectRoot] The real project root, when it appears in output.
 * @returns {string}
 */
export function undoOurFootprint(text, footprint) {
  let out = String(text).replace(/\r\n/g, '\n');
  for (const dir of (footprint.dirs ?? []).slice().sort((a, b) => b.length - a.length)) {
    if (!dir) continue;
    out = out.split(dir).join('<the scratch folder>');
  }
  if (footprint.projectRoot) out = out.split(footprint.projectRoot).join('<the project>');
  for (const port of footprint.ports ?? []) {
    if (!port) continue;
    out = out.split(`:${port}`).join(':<the port we picked>');
  }
  return out;
}

/**
 * Keep a piece of text at a size worth storing.
 *
 * Anything longer gets its head and tail kept — the two ends are where the interesting
 * lines are — plus a fingerprint of the whole, so a change in the middle still shows as a
 * difference even though the middle itself was never stored. The caller writes the full
 * text to the evidence folder and points at it.
 *
 * @param {string} text
 * @param {number} [limit] bytes
 * @returns {{text: string, truncated: boolean, bytes: number}}
 */
export function trimForStorage(text, limit = 64 * 1024) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= limit) return { text, truncated: false, bytes };
  const keep = Math.floor(limit / 2);
  const head = text.slice(0, keep);
  const tail = text.slice(-keep);
  return {
    text: `${head}\n... ${sizeBucket(bytes - keep * 2)} left out of the middle ...\n${tail}`,
    truncated: true,
    bytes,
  };
}
