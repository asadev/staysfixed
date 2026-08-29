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
