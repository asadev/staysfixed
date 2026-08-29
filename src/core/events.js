/**
 * What a run says about itself while it is happening.
 *
 * A run used to tell the terminal what it was doing and tell nobody else, so
 * anything that also wanted to watch — the live window, and whatever comes after
 * it — had to be threaded through the engine as another callback. Instead a run
 * now describes itself once, into this stream, and anyone who cares listens.
 *
 * Two rules hold the whole thing up. A listener that throws must never break the
 * run: watching is a convenience, and a convenience that can take down a check is
 * not worth having. And a listener that arrives late is handed everything that
 * already happened, in order, which is what lets a window open in the middle of a
 * run and still draw the screens that were photographed before it opened.
 */

import { pathToFileURL } from 'node:url';
import { detail } from './log.js';
import { messageOf } from './errors.js';
// Only for the stock pixel allowance. The number a person is shown has to be the
// number the verdict was made against, so it is read from the one place that
// defines it rather than copied and left to drift.
import { DEFAULT_TOLERANCE } from './config.js';

/** @typedef {import('../types.js').RunEvent} RunEvent */
/** @typedef {import('../types.js').RunEvents} RunEvents */
/** @typedef {import('../types.js').Timings} Timings */

/**
 * An event on its way in. Everything a `RunEvent` carries except `at`, which the
 * stream stamps, so no caller has to hold a clock of its own.
 * @typedef {Omit<RunEvent, 'at'> & {at?: number}} DraftEvent
 */

/**
 * The parts of a run whose time we can name. `other` and `total` are worked out
 * at the end rather than measured, so they can never disagree with the rest.
 * @typedef {'launch'|'steps'|'prepare'|'settle'|'compare'|'guards'} TimingKey
 */

/**
 * A fresh event stream. One per run.
 *
 * @returns {RunEvents}
 */
export function makeEvents() {
  const born = process.hrtime.bigint();
  /** @type {RunEvent[]} */
  const history = [];
  /** @type {Set<(event: RunEvent) => void>} */
  const listeners = new Set();

  /** @returns {number} Milliseconds since this stream was made. */
  function elapsed() {
    return Math.round(Number(process.hrtime.bigint() - born) / 1e6);
  }

  /**
   * Hand one event to one listener, and swallow whatever it does with it.
   *
   * The message goes to `detail` on purpose: a watcher misbehaving is worth
   * knowing about when somebody asks for detail, and is never worth a warning in
   * the middle of a clean run.
   *
   * @param {(event: RunEvent) => void} listener
   * @param {RunEvent} event
   */
  function hand(listener, event) {
    try {
      listener(event);
    } catch (e) {
      detail(`Something watching this run failed on a "${event.type}" event. ${messageOf(e)}`);
    }
  }

  /** @param {DraftEvent} event */
  function emit(event) {
    /** @type {RunEvent} */
    const stamped =
      typeof event.at === 'number' ? /** @type {RunEvent} */ (event) : { ...event, at: elapsed() };
    history.push(stamped);
    // A copy, because a listener is allowed to unsubscribe — or subscribe
    // somebody else — while it is being called.
    for (const listener of [...listeners]) hand(listener, stamped);
  }

  /**
   * @param {(event: RunEvent) => void} listener
   * @returns {() => void} Call it to stop listening.
   */
  function on(listener) {
    // Catch-up first, then live. A copy again: a listener that emits while it is
    // catching up would otherwise grow the array it is being read from.
    for (const past of [...history]) hand(listener, past);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { emit, on, elapsed, history: () => [...history] };
}

/**
 * Emit, when there may be nobody to emit to.
 *
 * Every place in the engine that describes itself is optional — a run with no
 * watcher is the normal case — and this keeps that from being an `if` at every
 * call site.
 *
 * @param {RunEvents|undefined} events
 * @param {DraftEvent} event
 * @returns {void}
 */
export function emitEvent(events, event) {
  if (!events) return;
  events.emit(/** @type {RunEvent} */ (event));
}

/**
 * A file on disk, as an address a local page can load.
 *
 * The watch panel is itself a local `file://` page, which means it can open the real
 * full-resolution PNGs this run just wrote instead of a shrunken copy pasted into the
 * event. That is the difference between a picture you can zoom into and a picture you
 * cannot read — and it costs nothing to send, because the address is a few dozen
 * characters and the pixels never move.
 *
 * Hands back `undefined` rather than a broken address for anything that is not a real
 * path: an <img> pointed at a file that is not there draws the browser's torn-page
 * icon, which looks like the tool is broken. Nothing at all looks like nothing at all.
 *
 * @param {string|undefined|null} file  An absolute path to a file that EXISTS. Callers
 *   pass the path they have just written, or one they have just read — this function
 *   does not touch the disk, so it cannot tell the difference itself.
 * @returns {string|undefined}
 */
export function fileUrl(file) {
  if (typeof file !== 'string' || file === '') return undefined;
  try {
    return pathToFileURL(file).href;
  } catch {
    return undefined;
  }
}

/**
 * Where a run spent its time.
 *
 * Deliberately dumb: a few numbers added up, `process.hrtime.bigint()` for the
 * clock, and nothing allocated while a screen is being photographed. A profiler
 * that shows up in its own measurements is worse than no profiler.
 *
 * @returns {{add: (key: TimingKey, ms: number) => void, mark: (key: TimingKey) => () => void, get: () => Timings}}
 */
export function makeTimings() {
  const born = process.hrtime.bigint();
  /** @type {Record<TimingKey, number>} */
  const spent = { launch: 0, steps: 0, prepare: 0, settle: 0, compare: 0, guards: 0 };

  /**
   * @param {TimingKey} key
   * @param {number} ms
   * @returns {void}
   */
  function add(key, ms) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    spent[key] += ms;
  }

  /**
   * Start the clock on one part of the run; the function it hands back stops it.
   * @param {TimingKey} key
   * @returns {() => void}
   */
  function mark(key) {
    const from = process.hrtime.bigint();
    return () => {
      spent[key] += Number(process.hrtime.bigint() - from) / 1e6;
    };
  }

  /** @returns {Timings} */
  function get() {
    const total = Number(process.hrtime.bigint() - born) / 1e6;
    const named =
      spent.launch + spent.steps + spent.prepare + spent.settle + spent.compare + spent.guards;
    return {
      launch: Math.round(spent.launch),
      steps: Math.round(spent.steps),
      prepare: Math.round(spent.prepare),
      settle: Math.round(spent.settle),
      compare: Math.round(spent.compare),
      guards: Math.round(spent.guards),
      // Everything nobody claimed: reading and writing pictures, git, the report.
      // Clamped, because two parts of the run can overlap and the leftovers must
      // never be printed as a negative number of milliseconds.
      other: Math.round(Math.max(0, total - named)),
      total: Math.round(total),
    };
  }

  return { add, mark, get };
}

// ---------------------------------------------------------------------------
// Showing the working
// ---------------------------------------------------------------------------

/**
 * Every phrase a step of a picture check can be described by, in one place.
 *
 * They live here as data rather than scattered through the code below for one
 * reason: this is the wording a non-programmer reads, so the whole set has to be
 * readable — and judgeable — in a single glance. If a line here sounds like a
 * programmer talking, it is wrong, whatever the code around it does.
 *
 * Most steps have two or three wordings, because a step that was switched off in
 * the config must say so rather than quietly claim success.
 */
export const CHECK_LABELS = Object.freeze({
  frozen: 'the clock was frozen',
  frozenOff: 'the clock was left alone',
  steps: 'reached the screen',
  stepsFailed: 'could not reach the screen',
  settle: 'everything held still',
  settleGaveUp: 'it never fully stopped moving',
  loaded: 'fonts and pictures landed',
  loadedWaiting: 'something was still loading',
  loadedOff: 'fonts were left to load on their own',
  loadedUnknown: 'could not ask what was still loading',
  network: 'the outside world kept out',
  networkLive: 'the app was left online',
  networkUnknown: 'the network was not watched',
  masks: 'live things painted over',
  masksNone: 'nothing needed painting over',
  size: 'same size as approved',
  sizeChanged: 'not the same size as approved',
  sizeNew: 'nothing approved to measure against',
  pixels: 'every pixel compared',
  pixelsNew: 'nothing to compare it with yet',
  pixelsSkipped: 'the pixels could not be compared',
  console: 'no errors from the page',
  consoleBad: 'the page threw errors',
  retried: 'photographed more than once',
  platform: 'approved on a different computer',
  failed: 'the picture could not be taken',
});

/**
 * What was asked of the freeze layer for one screen. Everything here is a
 * setting, not a measurement — it is how the list can say a check was switched
 * off instead of pretending it passed.
 *
 * @typedef {object} FrozenPlan
 * @property {boolean} clock            The clock, timezone and locale were pinned.
 * @property {boolean} motion           Animations, transitions and carets were killed.
 * @property {boolean} random           Random numbers were seeded.
 * @property {boolean} fonts            The shutter waited for fonts.
 * @property {'replay'|'block-external'|'live'} network   How requests were treated.
 * @property {number} frames            Identical frames in a row demanded.
 * @property {number} [maxDriftPixels]  Pixels allowed to wobble and still count as identical.
 */

/**
 * What the page said was still loading at the moment the picture was taken.
 * Read off the real page, so it is a measurement rather than a hope.
 *
 * @typedef {object} LoadedReport
 * @property {string} [fonts]           document.fonts.status: 'loaded', 'loading', or 'none'.
 * @property {number} [images]          How many pictures the page has.
 * @property {number} [imagesPending]   How many of them had not finished.
 */

/**
 * Everything needed to say what was done to one screen.
 *
 * All of it optional except the screen, because a screen that fell over halfway
 * still deserves an honest list of how far it got.
 *
 * @typedef {object} ChecksInput
 * @property {import('../types.js').ScreenConfig} screen        The recipe that was followed.
 * @property {import('../types.js').CheckStatus} [status]       How the screen ended up.
 * @property {FrozenPlan} [frozen]                              What the freeze layer was asked to do.
 * @property {import('../types.js').SettleReport} [settle]      How the holding-still went.
 * @property {LoadedReport} [loaded]                            What was still loading at the shutter.
 * @property {import('../types.js').FreezeStats} [freeze]       Requests blocked, replayed, allowed.
 * @property {import('../types.js').MaskRect[]} [masks]         Rectangles painted over both pictures.
 * @property {number} [masksAsked]                              How many masks the config set for this screen.
 * @property {string[]} [consoleErrors]                         Errors the page threw, unprompted.
 * @property {{width:number,height:number}} [size]              The new picture.
 * @property {{width:number,height:number}} [approvedSize]      The approved one.
 * @property {import('../types.js').CompareReport|null} [compare]  The verdict on the pixels.
 * @property {boolean} [hasApproved]                            Was there an approved picture at all.
 * @property {import('../types.js').ToleranceConfig} [tolerance] How much difference was allowed.
 * @property {number} [attempts]                                How many times it was photographed.
 * @property {{approvedOn?: string, here?: string}} [platform]  Where the two pictures were taken.
 * @property {string} [failure]                                 Why it could not be photographed at all.
 */

/**
 * Turn what a capture and a comparison know into the list of things that were
 * actually done to a screen, in the order they happened.
 *
 * A verdict on its own — "matches", "1.9s" — tells nobody what was verified. It
 * reads like a speed test, and a person who cannot see the work cannot decide
 * whether to believe it. This is that work, written out.
 *
 * Pure on purpose: no browser, no disk, no clock. The words that appear in front
 * of a person are then testable without photographing anything, and every path
 * through the tool that wants to explain itself uses the same ones.
 *
 * @param {ChecksInput} input
 * @returns {import('../types.js').CheckStep[]}
 */
export function buildChecks(input) {
  /** @type {import('../types.js').CheckStep[]} */
  const out = [];
  /**
   * @param {string} label
   * @param {string|undefined} detail
   * @param {import('../types.js').CheckStep['state']} state
   */
  const say = (label, detail, state) => {
    out.push(detail ? { label, detail, state } : { label, state });
  };

  const screen = input.screen ?? /** @type {import('../types.js').ScreenConfig} */ ({ name: '' });
  const errors = input.consoleErrors ?? [];

  frozenStep(say, input.frozen);
  stepsStep(say, screen, input.failure);

  if (input.failure) {
    // Nothing after this happened, so nothing after this is claimed. The one
    // thing still worth saying is whether the page was shouting on its way down.
    say(CHECK_LABELS.failed, input.failure, 'bad');
    consoleStep(say, errors);
    return out;
  }

  settleStep(say, input.settle, input.frozen);
  loadedStep(say, input.loaded, input.frozen);
  networkStep(say, input.freeze, input.frozen);
  masksStep(say, input.masks, input.masksAsked);
  sizeStep(say, input);
  pixelsStep(say, input);
  consoleStep(say, errors);
  retryStep(say, input);
  platformStep(say, input.platform);

  return out;
}

/** @typedef {(label: string, detail: string|undefined, state: import('../types.js').CheckStep['state']) => void} Say */

/**
 * @param {Say} say
 * @param {FrozenPlan|undefined} frozen
 */
function frozenStep(say, frozen) {
  if (!frozen) return;
  /** @type {string[]} */
  const also = [];
  if (frozen.motion) also.push('animations off');
  if (frozen.random) also.push('random numbers pinned');
  if (!frozen.clock) {
    say(
      CHECK_LABELS.frozenOff,
      also.length > 0 ? also.join(', ') : 'the time may be different every run',
      'skipped',
    );
    return;
  }
  say(CHECK_LABELS.frozen, also.length > 0 ? also.join(', ') : 'the same instant every run', 'ok');
}

/**
 * @param {Say} say
 * @param {import('../types.js').ScreenConfig} screen
 * @param {string|undefined} failure
 */
function stepsStep(say, screen, failure) {
  const label = failure ? CHECK_LABELS.stepsFailed : CHECK_LABELS.steps;
  const state = failure ? 'bad' : 'ok';

  if (typeof screen.do === 'function') {
    say(label, 'its own instructions', state);
    return;
  }
  const steps = screen.steps ?? [];
  const waits = steps.filter((s) => s && s.wait !== undefined).length;
  const after = (screen.after ?? []).length;

  if (steps.length === 0) {
    say(label, 'nothing to do — it was already there', state);
    return;
  }
  /** @type {string[]} */
  const parts = [`${steps.length} ${plural(steps.length, 'step', 'steps')}`];
  parts.push(waits === 0 ? 'none of them a timed wait' : `${waits} of them a timed wait`);
  if (after > 0) parts.push(`${after} more to put the app back`);
  say(label, parts.join(', '), state);
}

/**
 * @param {Say} say
 * @param {import('../types.js').SettleReport|undefined} settle
 * @param {FrozenPlan|undefined} frozen
 */
function settleStep(say, settle, frozen) {
  if (!settle) return;
  const frames = Math.max(1, frozen?.frames ?? 2);
  const drift = settle.lastDriftPixels ?? 0;

  if (!settle.settled) {
    const moving =
      drift > 0
        ? `${count(drift)} ${plural(drift, 'pixel', 'pixels')} still moving`
        : 'it never held';
    say(
      CHECK_LABELS.settleGaveUp,
      `gave up after ${count(settle.attempts)} ${plural(settle.attempts, 'photo', 'photos')}, ${moving}`,
      'warn',
    );
    return;
  }

  /** @type {string[]} */
  const parts = [`${frames} identical ${plural(frames, 'frame', 'frames')} in a row`];
  parts.push(
    settle.attempts > frames ? `after ${count(settle.attempts)} photos` : 'first try',
  );
  // Only worth saying when a project deliberately allows a little wobble AND
  // some wobble actually happened; otherwise it is noise about nothing.
  if ((frozen?.maxDriftPixels ?? 0) > 0 && drift > 0) {
    parts.push(`${count(drift)} ${plural(drift, 'pixel', 'pixels')} of allowed wobble`);
  }
  say(CHECK_LABELS.settle, parts.join(', '), 'ok');
}

/**
 * @param {Say} say
 * @param {LoadedReport|undefined} loaded
 * @param {FrozenPlan|undefined} frozen
 */
function loadedStep(say, loaded, frozen) {
  if (frozen && frozen.fonts === false) {
    say(CHECK_LABELS.loadedOff, 'the shutter did not wait for them', 'skipped');
    return;
  }
  if (!loaded) {
    say(CHECK_LABELS.loadedUnknown, 'the page had moved on by the time we asked', 'skipped');
    return;
  }

  const pending = loaded.imagesPending ?? 0;
  const fontsBusy = loaded.fonts === 'loading';
  if (!fontsBusy && pending === 0) {
    const total = loaded.images ?? 0;
    say(
      CHECK_LABELS.loaded,
      total > 0
        ? `every face loaded, ${count(total)} ${plural(total, 'picture', 'pictures')}, none still loading`
        : 'every face loaded, nothing still loading',
      'ok',
    );
    return;
  }

  /** @type {string[]} */
  const busy = [];
  if (fontsBusy) busy.push('a font was still loading');
  if (pending > 0) {
    busy.push(`${count(pending)} ${plural(pending, 'picture', 'pictures')} still loading`);
  }
  say(CHECK_LABELS.loadedWaiting, busy.join(', '), 'warn');
}

/**
 * @param {Say} say
 * @param {import('../types.js').FreezeStats|undefined} stats
 * @param {FrozenPlan|undefined} frozen
 */
function networkStep(say, stats, frozen) {
  if (frozen && frozen.network === 'live') {
    say(CHECK_LABELS.networkLive, 'requests were left alone', 'skipped');
    return;
  }
  if (!stats) {
    say(CHECK_LABELS.networkUnknown, 'nothing was counted', 'skipped');
    return;
  }

  const blocked = stats.requestsBlocked ?? 0;
  const replayed = stats.requestsReplayed ?? 0;
  const recorded = stats.requestsRecorded ?? 0;
  const allowed = stats.requestsAllowed ?? 0;

  /** @type {string[]} */
  const parts = [];
  if (blocked > 0) parts.push(`${count(blocked)} ${plural(blocked, 'request', 'requests')} blocked`);
  if (replayed > 0) parts.push(`${count(replayed)} replayed from saved copies`);
  if (recorded > 0) parts.push(`${count(recorded)} saved for next time`);
  if (parts.length === 0) {
    parts.push(
      allowed > 0
        ? `nothing to block, ${count(allowed)} ${plural(allowed, 'request', 'requests')} stayed inside the app`
        : 'nothing tried to load',
    );
  } else if (allowed > 0) {
    parts.push(`${count(allowed)} allowed through`);
  }
  say(CHECK_LABELS.network, parts.join(', '), 'ok');
}

/**
 * Masks are set in the config and found on the page, and those are two different
 * numbers. A screen with three masks configured and none of them on it painted
 * nothing — saying "no live areas set" there would be a small lie, and the kind
 * that makes somebody stop trusting the rest of the list.
 *
 * @param {Say} say
 * @param {import('../types.js').MaskRect[]|undefined} masks
 * @param {number|undefined} asked
 */
function masksStep(say, masks, asked) {
  const n = masks ? masks.length : 0;
  if (n === 0) {
    const set = asked ?? 0;
    say(
      CHECK_LABELS.masksNone,
      set > 0
        ? `${count(set)} set, none of them on this screen`
        : 'no live areas set for this screen',
      'skipped',
    );
    return;
  }
  say(CHECK_LABELS.masks, `${count(n)} ${plural(n, 'area', 'areas')}, on both pictures`, 'ok');
}

/**
 * @param {Say} say
 * @param {ChecksInput} input
 */
function sizeStep(say, input) {
  const size = input.size;
  const approved = input.approvedSize;
  const has = input.hasApproved !== false && Boolean(approved);

  if (!size) return;
  if (!has || !approved) {
    say(CHECK_LABELS.sizeNew, dimensions(size), 'skipped');
    return;
  }
  if (approved.width !== size.width || approved.height !== size.height) {
    say(CHECK_LABELS.sizeChanged, `${dimensions(size)} now, ${dimensions(approved)} approved`, 'bad');
    return;
  }
  say(CHECK_LABELS.size, dimensions(size), 'ok');
}

/**
 * The line the whole thing exists for: how many pixels were looked at, how many
 * of them moved, and how many were allowed to. A share on its own ("0.30%
 * changed") means nothing without the allowance beside it.
 *
 * @param {Say} say
 * @param {ChecksInput} input
 */
function pixelsStep(say, input) {
  const compare = input.compare;
  const size = compare?.size ?? input.size;
  const total = size ? size.width * size.height : 0;

  if (input.hasApproved === false || !compare) {
    say(
      CHECK_LABELS.pixelsNew,
      total > 0 ? `${count(total)} pixels waiting for a first approval` : undefined,
      'skipped',
    );
    return;
  }
  if (compare.sizeMismatch) {
    say(CHECK_LABELS.pixelsSkipped, 'two different sizes cannot be laid over each other', 'skipped');
    return;
  }

  const allowed = allowanceFor(total, input.tolerance);
  const differed = compare.diffPixels ?? 0;
  const pixels = `${count(total)} pixels`;

  if (differed === 0) {
    say(CHECK_LABELS.pixels, `${pixels}, none different`, 'ok');
    return;
  }
  const moved = `${count(differed)} different (${share(compare.diffRatio ?? 0)})`;
  if (compare.equal) {
    say(CHECK_LABELS.pixels, `${pixels}, ${moved}, within the ${count(allowed)} allowed`, 'ok');
    return;
  }
  say(CHECK_LABELS.pixels, `${pixels}, ${moved}, more than the ${count(allowed)} allowed`, 'bad');
}

/**
 * @param {Say} say
 * @param {string[]} errors
 */
function consoleStep(say, errors) {
  if (errors.length === 0) {
    say(CHECK_LABELS.console, 'nothing thrown', 'ok');
    return;
  }
  const first = firstLine(errors[0]);
  say(
    CHECK_LABELS.consoleBad,
    `${count(errors.length)} ${plural(errors.length, 'error', 'errors')}${first ? `, first: ${first}` : ''}`,
    'warn',
  );
}

/**
 * @param {Say} say
 * @param {ChecksInput} input
 */
function retryStep(say, input) {
  const attempts = input.attempts ?? 1;
  if (attempts <= 1) return;
  const passed = input.status === 'passed';
  say(
    CHECK_LABELS.retried,
    passed
      ? `it looked different at first, then matched on try ${count(attempts)} — it may be unreliable`
      : `${count(attempts)} tries, different every time`,
    'warn',
  );
}

/**
 * @param {Say} say
 * @param {{approvedOn?: string, here?: string}|undefined} platform
 */
function platformStep(say, platform) {
  if (!platform || !platform.approvedOn || !platform.here) return;
  if (platform.approvedOn === platform.here) return;
  say(
    CHECK_LABELS.platform,
    `approved on ${platform.approvedOn}, checked on ${platform.here} — text is drawn differently on each`,
    'warn',
  );
}

/**
 * How many differing pixels this project is willing to forgive.
 * The same arithmetic the comparison itself does, so the number a person is
 * shown is the number the verdict was made against.
 *
 * @param {number} total
 * @param {import('../types.js').ToleranceConfig|undefined} tolerance
 * @returns {number}
 */
function allowanceFor(total, tolerance) {
  const t = tolerance ?? {};
  if (typeof t.maxPixels === 'number') return t.maxPixels;
  return Math.floor(total * (t.pixels ?? DEFAULT_TOLERANCE.pixels));
}

/**
 * @param {{width:number,height:number}} size
 * @returns {string}
 */
function dimensions(size) {
  return `${count(size.width)} × ${count(size.height)}`;
}

/**
 * @param {number} n
 * @returns {string}
 */
function count(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : String(n);
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
 * A share of the picture, said in a way that is never misleading. A count of
 * pixels can be large and still round to 0.00%, and "0.00% changed" beside a
 * five-figure pixel count reads as a bug in the tool.
 *
 * @param {number} ratio
 * @returns {string}
 */
function share(ratio) {
  const pct = (Number.isFinite(ratio) ? ratio : 0) * 100;
  if (pct <= 0) return '0%';
  if (pct < 0.01) return 'under 0.01%';
  return `${pct.toFixed(2)}%`;
}

/**
 * @param {string|undefined} text
 * @returns {string}
 */
function firstLine(text) {
  if (typeof text !== 'string') return '';
  const line = text.split('\n')[0].trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
