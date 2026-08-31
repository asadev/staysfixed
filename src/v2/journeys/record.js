/**
 * A real session, frozen into a journey.
 *
 * The code gives you every door. The suite gives you every path somebody already wrote a
 * test for. This file is for the third case and only the third case: something a person or
 * an agent actually did, that neither of the other two can reach — signing in, dragging a
 * pane onto another one, the four steps that reproduce a bug that was reported once.
 *
 * IT IS AN ESCAPE HATCH, NOT A HABIT. A recorded journey is the weakest of the four sources
 * because it is one path somebody happened to take, and because it goes stale the moment the
 * interface it describes moves. Anything reachable from the code or from the suite should
 * come from there instead, and `index.js` sorts them in that order for exactly this reason.
 *
 * WHAT A RECORDING MUST NOT KEEP. A real session contains a real password. It contains the
 * token that came back, the card number somebody typed, the one-time code that arrived on a
 * phone. All of it goes through {@link redact} before it reaches a file, and the count of
 * what was hidden is written into the journey — because a redaction nobody can see is
 * indistinguishable from a recording that never captured anything.
 *
 * WHAT A RECORDING MUST NOT DO. It must not keep a sleep. A recorded "waited 1,400ms" is a
 * timing on one machine on one afternoon, and replaying it is how a journey becomes flaky
 * on somebody else's laptop. Waits are recorded as `settle` — carry on when the thing being
 * watched stops changing — which is the one algorithm in this repository that works on every
 * platform because it only ever needs a picture.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

/** @typedef {import('../types.js').Journey} Journey */
/** @typedef {import('../types.js').JourneyStep} JourneyStep */
/** @typedef {import('../types.js').Surface} Surface */
/** @typedef {import('../types.js').Channel} Channel */

/** The shape of a journeys file on disk. Version it, because a format nobody versioned is a format nobody can change. */
export const JOURNEY_FILE_VERSION = 2;

/**
 * Where recordings live, relative to the project.
 *
 * One name, because three readers used to spell it out for themselves — the gatherer, the
 * check path and the recording command — and three copies of a folder name is three chances
 * for a recording to be written where nothing looks for it, which reads afterwards exactly
 * like a recording that was never made.
 *
 * It is committed, not ignored: a recording is the promise, not the evidence.
 */
export const RECORDINGS_DIR = path.join('.staysfixed', 'journeys');

// ---------------------------------------------------------------------------
// Keeping secrets out
// ---------------------------------------------------------------------------

/**
 * Field names whose value never goes into a file. Generous on purpose: hiding one field too
 * many costs a little detail in a report, and hiding one too few writes somebody's password
 * into a repository.
 */
export const SECRET_NAMES =
  /(pass|pwd|secret|token|api[-_]?key|apikey|auth|bearer|session|cookie|otp|2fa|mfa|pin|cvv|cvc|card|iban|ssn|private[-_]?key|credential)/i;

/** Values that are obviously a secret whatever the field is called. */
const SECRET_VALUES = [
  { pattern: /^eyJ[A-Za-z0-9_-]{10,}\./, what: 'a signed token' },
  { pattern: /^(sk|pk|rk)[-_][A-Za-z0-9]{16,}/, what: 'an API key' },
  { pattern: /^gh[pousr]_[A-Za-z0-9]{20,}/, what: 'a GitHub token' },
  { pattern: /^[A-Fa-f0-9]{40,}$/, what: 'a long hex secret' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'a private key' },
];

/** What replaces anything hidden. Fixed text, so two recordings of the same flow still match. */
export const HIDDEN = '<hidden>';

/**
 * @typedef {object} Redaction
 * @property {unknown} value       The value with anything secret taken out.
 * @property {number} hidden       How many values were hidden.
 * @property {string[]} what       Plain English, one line per kind of thing hidden.
 */

/**
 * Take the secrets out of anything about to be written down.
 *
 * @param {unknown} value
 * @param {{name?: string}} [context]   The field name this value sat under, when there is one.
 * @returns {Redaction}
 */
export function redact(value, context = {}) {
  /** @type {string[]} */
  const what = [];
  let hidden = 0;

  /**
   * @param {unknown} node
   * @param {string|undefined} name
   * @param {number} depth
   * @returns {unknown}
   */
  const walk = (node, name, depth) => {
    if (depth > 12) return node;
    if (typeof node === 'string') {
      // Already hidden, by the recorder or by an earlier save. Counting it again would
      // report more secrets than there were, and a count nobody can trust is not a count.
      if (node === HIDDEN) return node;
      if (name && SECRET_NAMES.test(name)) {
        hidden++;
        what.push(`the value of "${name}"`);
        return HIDDEN;
      }
      for (const rule of SECRET_VALUES) {
        if (rule.pattern.test(node)) {
          hidden++;
          what.push(rule.what);
          return HIDDEN;
        }
      }
      return node;
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, name, depth + 1));
    if (node && typeof node === 'object') {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [key, item] of Object.entries(node)) out[key] = walk(item, key, depth + 1);
      return out;
    }
    if (name && SECRET_NAMES.test(name) && node !== null && node !== undefined) {
      hidden++;
      what.push(`the value of "${name}"`);
      return HIDDEN;
    }
    return node;
  };

  return { value: walk(value, context.name, 0), hidden, what: [...new Set(what)] };
}

// ---------------------------------------------------------------------------
// Noise, and what to do with it
// ---------------------------------------------------------------------------

/**
 * Acts that are somebody's hand moving, not somebody doing something. A recorded session is
 * mostly these, and keeping them turns a four-step journey into four hundred steps that
 * describe a mouse.
 */
const JUST_MOVEMENT = new Set(['move', 'mousemove', 'hover', 'scroll', 'focus', 'blur', 'resize']);

/** Acts where the last one wins: ten keystrokes into one box are one thing that happened. */
const COLLAPSES = new Set(['type', 'fill', 'set', 'select', 'input']);

/**
 * One thing that happened, as a driver reports it. Deliberately loose — every driver has its
 * own vocabulary, and this file's job is to take whichever one it is given.
 *
 * @typedef {object} SessionEvent
 * @property {string} act              'click', 'type', 'navigate', 'run', 'invoke', 'wait'…
 * @property {string} [target]         What it happened to, said the way a person would:
 *                                     'the Save button', not a CSS selector.
 * @property {unknown} [value]
 * @property {number} [at]             Milliseconds since the recording started.
 * @property {string} [note]
 * @property {Record<string, unknown>} [detail]
 */

/**
 * Turn what a driver saw into steps worth replaying.
 *
 * Three rules, and each one exists because of a specific way recorded journeys go bad:
 * movement is dropped, because a mouse path is not a journey; consecutive typing into the
 * same place is collapsed to the final value, because a replay of keystrokes is a replay of
 * a person's speed; and every wait becomes `settle`, because a recorded sleep is a timing
 * from one machine that will be wrong on the next one.
 *
 * @param {SessionEvent[]} events
 * @returns {{steps: JourneyStep[], dropped: number, collapsed: number, hidden: number, hiddenWhat: string[]}}
 */
export function stepsFromEvents(events) {
  /** @type {JourneyStep[]} */
  const steps = [];
  let dropped = 0;
  let collapsed = 0;
  let hidden = 0;
  /** @type {Set<string>} */
  const hiddenWhat = new Set();

  for (const event of events) {
    const act = String(event.act ?? '').trim();
    if (act === '') { dropped++; continue; }
    if (JUST_MOVEMENT.has(act)) { dropped++; continue; }

    if (act === 'wait' || act === 'sleep' || act === 'pause') {
      const previous = steps[steps.length - 1];
      if (previous?.act === 'settle') { dropped++; continue; }
      steps.push({ act: 'settle', note: 'Carry on when it stops changing. The recording had a pause here; the pause itself is not kept.' });
      continue;
    }

    /** @type {JourneyStep} */
    const step = { act };
    if (event.target !== undefined) step.target = event.target;
    if (event.note !== undefined) step.note = event.note;
    if (event.detail !== undefined) {
      const cleaned = redact(event.detail);
      hidden += cleaned.hidden;
      for (const item of cleaned.what) hiddenWhat.add(item);
      step.detail = cleaned.value;
    }
    if (event.value !== undefined) {
      const cleaned = redact(event.value, { name: typeof event.target === 'string' ? event.target : undefined });
      hidden += cleaned.hidden;
      for (const item of cleaned.what) hiddenWhat.add(item);
      step.value = cleaned.value;
    }

    const previous = steps[steps.length - 1];
    if (previous && COLLAPSES.has(act) && previous.act === act && previous.target === step.target) {
      steps[steps.length - 1] = step;
      collapsed++;
      continue;
    }
    if (previous && previous.act === act && previous.target === step.target && sameJson(previous.value, step.value)) {
      dropped++;
      continue;
    }
    steps.push(step);
  }

  return { steps, dropped, collapsed, hidden, hiddenWhat: [...hiddenWhat] };
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function sameJson(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Recorder
 * @property {(act: string, detail?: Omit<SessionEvent, 'act'>) => Recorder} did
 *   Write down one thing that happened. Chains, so a driver can call it inline.
 * @property {(text: string) => Recorder} note        A sentence for whoever reads the journey.
 * @property {() => number} count                     Events recorded so far, before cleaning.
 * @property {(finish?: {describe?: string, irreversible?: boolean}) => RecordedJourney} stop
 */

/**
 * A journey with the story of how it was recorded attached.
 *
 * @typedef {Journey & {recorded: RecordingNotes}} RecordedJourney
 */

/**
 * @typedef {object} RecordingNotes
 * @property {string} at              ISO time the recording finished.
 * @property {number} events          Raw events the driver reported.
 * @property {number} kept            Steps that survived cleaning.
 * @property {number} dropped
 * @property {number} collapsed
 * @property {number} hidden          Values taken out because they were secret.
 * @property {string[]} hiddenWhat    What kind of thing was hidden, in plain English.
 * @property {string} [by]            Who or what was driving: a person, an agent, a script.
 */

/**
 * Start recording a session.
 *
 * @param {object} spec
 * @param {string} spec.name              File-safe. It becomes a folder name.
 * @param {string} [spec.describe]        One plain sentence. Filled in at `stop` if not here.
 * @param {Surface} [spec.surface]
 * @param {Channel[]} [spec.channels]
 * @param {string} [spec.by]              'a person', 'the agent', 'the pairing script'.
 * @returns {Recorder}
 */
export function startRecording(spec) {
  /** @type {SessionEvent[]} */
  const events = [];
  const startedAt = Date.now();
  /** @type {string[]} */
  const notes = [];

  /** @type {Recorder} */
  const recorder = {
    did(act, detail = {}) {
      events.push({ ...detail, act, at: Date.now() - startedAt });
      return recorder;
    },
    note(text) {
      notes.push(text);
      return recorder;
    },
    count() {
      return events.length;
    },
    stop(finish = {}) {
      const cleaned = stepsFromEvents(events);
      const describe =
        finish.describe ??
        spec.describe ??
        (cleaned.steps.length > 0
          ? `a recorded session: ${cleaned.steps.map((s) => s.act).slice(0, 4).join(', then ')}`
          : 'a recorded session with nothing in it');
      /** @type {RecordedJourney} */
      const journey = {
        name: spec.name,
        describe,
        source: 'recorded',
        surface: spec.surface ?? 'library',
        from: spec.by ? `a session driven by ${spec.by}` : 'a recorded session',
        channels: spec.channels ?? ['meaning', 'results', 'complaints', 'effects'],
        steps: cleaned.steps,
        recorded: {
          at: new Date().toISOString(),
          events: events.length,
          kept: cleaned.steps.length,
          dropped: cleaned.dropped,
          collapsed: cleaned.collapsed,
          hidden: cleaned.hidden,
          hiddenWhat: cleaned.hiddenWhat,
          by: spec.by,
        },
      };
      if (finish.irreversible) journey.irreversible = true;
      if (notes.length > 0) journey.steps?.push({ act: 'note', note: notes.join(' ') });
      return journey;
    },
  };
  return recorder;
}

/**
 * Record a session somebody drives inside a function, and get the journey back.
 *
 * @param {Parameters<typeof startRecording>[0]} spec
 * @param {(recorder: Recorder) => Promise<void>|void} drive
 * @returns {Promise<RecordedJourney>}
 */
export async function recordSession(spec, drive) {
  const recorder = startRecording(spec);
  try {
    await drive(recorder);
  } catch (error) {
    recorder.note(`The session stopped early: ${error instanceof Error ? error.message : String(error)}`);
  }
  return recorder.stop();
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * @typedef {object} JourneyFile
 * @property {number} staysfixed        Format version.
 * @property {'journeys'} kind
 * @property {string} savedAt
 * @property {string} [product]
 * @property {string} [note]
 * @property {Journey[]} journeys
 */

/**
 * Write journeys to a file, with the secrets taken out on the way.
 *
 * The redaction happens HERE as well as while recording, because a journey can be built by
 * hand, edited afterwards, or produced by an agent that exploring a gap — and every one of
 * those routes ends at this function.
 *
 * @param {string} file
 * @param {Journey[]} journeys
 * @param {{product?: string, note?: string}} [meta]
 * @returns {Promise<{file: string, journeys: number, hidden: number}>}
 */
export async function saveJourneys(file, journeys, meta = {}) {
  const cleaned = redact(journeys);
  /** @type {JourneyFile} */
  const payload = {
    staysfixed: JOURNEY_FILE_VERSION,
    kind: 'journeys',
    savedAt: new Date().toISOString(),
    product: meta.product,
    note: meta.note,
    journeys: /** @type {Journey[]} */ (cleaned.value),
  };
  await fsp.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { file, journeys: payload.journeys.length, hidden: cleaned.hidden };
}

/**
 * Read journeys back, and say plainly what is wrong with them rather than throwing.
 *
 * @param {string} file
 * @returns {Promise<{journeys: Journey[], problems: string[], savedAt?: string}>}
 */
export async function loadJourneys(file) {
  /** @type {string} */
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    return { journeys: [], problems: [`${file} could not be opened: ${error instanceof Error ? error.message : String(error)}`] };
  }
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { journeys: [], problems: [`${file} is not readable as JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }

  /** @type {string[]} */
  const problems = [];
  const list = Array.isArray(parsed) ? parsed : parsed?.journeys;
  if (!Array.isArray(list)) {
    return { journeys: [], problems: [`${file} does not contain a list of journeys.`] };
  }
  if (!Array.isArray(parsed) && parsed.staysfixed !== JOURNEY_FILE_VERSION) {
    problems.push(
      `${file} was written by a different version of this format (${parsed.staysfixed ?? 'none'}, this is ${JOURNEY_FILE_VERSION}). It was read anyway.`,
    );
  }

  /** @type {Journey[]} */
  const journeys = [];
  list.forEach((/** @type {any} */ journey, index) => {
    if (!journey || typeof journey !== 'object') {
      problems.push(`Journey ${index + 1} in ${file} is not an object.`);
      return;
    }
    if (typeof journey.name !== 'string' || journey.name.trim() === '') {
      problems.push(`Journey ${index + 1} in ${file} has no name.`);
      return;
    }
    if (!journey.source) journey.source = 'recorded';
    if (!journey.describe) journey.describe = `the recorded journey "${journey.name}"`;
    if (!journey.from) journey.from = file;
    journeys.push(/** @type {Journey} */ (journey));
  });

  return { journeys, problems, savedAt: typeof parsed?.savedAt === 'string' ? parsed.savedAt : undefined };
}

/**
 * Read every journeys file in a folder. Missing folder is not a problem — most projects
 * have never recorded anything, and that is a normal state, not an error.
 *
 * @param {string} dir
 * @returns {Promise<{journeys: Journey[], problems: string[], files: string[]}>}
 */
export async function loadJourneyFolder(dir) {
  /** @type {string[]} */
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return { journeys: [], problems: [], files: [] };
  }
  /** @type {Journey[]} */
  const journeys = [];
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const files = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue;
    const full = path.join(dir, entry);
    const read = await loadJourneys(full);
    journeys.push(...read.journeys);
    problems.push(...read.problems);
    if (read.journeys.length > 0) files.push(full);
  }
  return { journeys, problems, files };
}

// ---------------------------------------------------------------------------
// Is this thing replayable?
// ---------------------------------------------------------------------------

/** Things inside a recorded step that will not mean the same thing tomorrow. */
const WONT_REPLAY = [
  { pattern: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, why: 'it has a date and time in it, which will not be the same tomorrow' },
  { pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, why: 'it has a one-off id in it, which will be a different id next time' },
  { pattern: /:\d{4,5}\b/, why: 'it has a port number in it, which the next run may not get' },
  { pattern: /\/(var\/folders|tmp)\//, why: 'it points into a temporary folder that will not exist next time' },
];

/**
 * What would stop this recorded journey being replayable, in plain English.
 *
 * Recorded journeys rot, and they rot quietly: the ids and timestamps captured on the
 * afternoon somebody made the recording go stale, and the replay then fails for a reason
 * that has nothing to do with the product. Saying it here, once, at the point the journey is
 * saved, is much cheaper than finding out inside a failing check three weeks later.
 *
 * @param {Journey} journey
 * @returns {string[]}
 */
export function whatWillNotReplay(journey) {
  /** @type {string[]} */
  const problems = [];
  const steps = journey.steps ?? [];
  if (steps.length === 0) problems.push('It has no steps, so replaying it would do nothing.');
  for (const [index, step] of steps.entries()) {
    let text;
    try {
      text = JSON.stringify(step);
    } catch {
      problems.push(`Step ${index + 1} cannot be written down, so it cannot be replayed.`);
      continue;
    }
    for (const rule of WONT_REPLAY) {
      if (rule.pattern.test(text)) problems.push(`Step ${index + 1} may not replay: ${rule.why}.`);
    }
  }
  return [...new Set(problems)];
}
