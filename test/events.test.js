/**
 * The event stream and the stopwatch behind `--watch` and `--profile`.
 *
 * Both of these are watched by things that are allowed to fail — a panel, a
 * terminal, whatever comes next — and none of them may ever be able to break a
 * run. That is what most of this file is about.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeEvents, makeTimings } from '../src/core/events.js';

/**
 * The stream and the stopwatch are built elsewhere and this file only cares how
 * they behave, so they are read through a loose type rather than pinning down a
 * shape that the other file is free to change.
 * @param {unknown} value
 * @returns {any}
 */
function loose(value) {
  return /** @type {any} */ (value);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Every field a Timings is promised to have. */
const TIMING_FIELDS = ['launch', 'steps', 'prepare', 'settle', 'compare', 'guards', 'other', 'total'];

describe('the event stream', () => {
  test('a listener that joins late is caught up on everything it missed', () => {
    const events = loose(makeEvents());
    events.emit({ type: 'run:start', plan: { screens: 2, guards: 1, app: 'web', project: 'shop', watching: true } });
    events.emit({ type: 'screen:start', name: 'home' });

    // A panel takes a moment to open, and it must not open onto an empty list.
    /** @type {any[]} */
    const seen = [];
    events.on(/** @param {any} event */ (event) => seen.push(event));

    assert.deepEqual(
      seen.map((event) => event.type),
      ['run:start', 'screen:start'],
    );
  });

  test('everything that has happened is kept, in the order it happened', () => {
    const events = loose(makeEvents());
    events.emit({ type: 'screen:start', name: 'home' });
    events.emit({ type: 'screen:done', name: 'home', status: 'passed' });

    const history = events.history();
    assert.equal(history.length, 2);
    assert.deepEqual(
      history.map(/** @param {any} event */ (event) => event.type),
      ['screen:start', 'screen:done'],
    );
  });

  test('a listener that falls over does not take the run down with it', () => {
    const events = loose(makeEvents());
    let reached = 0;

    events.on(() => {
      throw new Error('the panel fell over');
    });
    events.on(() => {
      reached += 1;
    });

    // Both halves matter: emitting must not throw, and the listener behind the
    // broken one must still be told. A watch window is never worth a failed run.
    assert.doesNotThrow(() => events.emit({ type: 'note', message: 'still going' }));
    assert.equal(reached, 1);
  });

  test('a listener that falls over while being caught up is survived too', () => {
    const events = loose(makeEvents());
    events.emit({ type: 'note', message: 'before anyone was listening' });

    assert.doesNotThrow(() =>
      events.on(() => {
        throw new Error('fell over on the first thing it was told');
      }),
    );
  });

  test('every event is stamped with how far into the run it happened', async () => {
    const events = loose(makeEvents());
    events.emit({ type: 'run:start' });
    await sleep(12);
    events.emit({ type: 'note', message: 'later' });

    const history = events.history();
    for (const event of history) {
      assert.equal(typeof event.at, 'number', 'every event needs an `at`');
      assert.ok(Number.isFinite(event.at) && event.at >= 0, `a strange stamp: ${event.at}`);
    }
    // Time only goes one way, so a drawn timeline can never fold back on itself.
    assert.ok(history[1].at >= history[0].at);
    assert.ok(history[1].at >= 1, 'a stamp taken 12ms later should not read as zero');
    assert.ok(events.elapsed() >= history[1].at);
  });

  test('unsubscribing really stops the events', () => {
    const events = loose(makeEvents());
    /** @type {any[]} */
    const seen = [];
    const off = events.on(/** @param {any} event */ (event) => seen.push(event));

    events.emit({ type: 'note', message: 'one' });
    off();
    events.emit({ type: 'note', message: 'two' });

    assert.equal(seen.length, 1);
    assert.doesNotThrow(() => off(), 'unsubscribing twice is not a mistake worth throwing over');
  });
});

describe('the stopwatch', () => {
  test('mark hands back a stop function, and the time lands in the bucket it named', async () => {
    const timings = loose(makeTimings());
    const stop = timings.mark('settle');
    assert.equal(typeof stop, 'function');
    await sleep(15);
    stop();

    const t = timings.get();
    assert.ok(t.settle >= 5, `waiting 15ms should show up as more than 5ms, got ${t.settle}`);
    assert.equal(t.steps, 0, 'nothing else should have been charged for that wait');
  });

  test('the same bucket adds up over a whole run', async () => {
    const timings = loose(makeTimings());
    for (let n = 0; n < 3; n += 1) {
      const stop = timings.mark('compare');
      await sleep(5);
      stop();
    }
    assert.ok(timings.get().compare >= 9, 'three waits of 5ms should add up');
  });

  test('get fills in every field, whether anything was measured or not', () => {
    const t = /** @type {Record<string, number>} */ (loose(makeTimings()).get());
    for (const field of TIMING_FIELDS) {
      assert.equal(typeof t[field], 'number', `${field} is missing from the timings`);
      assert.ok(Number.isFinite(t[field]), `${field} is not a real number`);
      assert.ok(t[field] >= 0, `${field} came out negative`);
    }
  });

  test('other is never negative, however the parts add up', () => {
    const timings = loose(makeTimings());
    // More than the run could possibly have taken. Phases overlap in real life,
    // so the parts genuinely can add up to more than the whole, and "everything
    // else: minus four minutes" would make the whole table look broken.
    timings.add('steps', 300_000);

    const t = /** @type {Record<string, number>} */ (timings.get());
    assert.ok(t.other >= 0, `other came out as ${t.other}`);
    assert.ok(t.total >= 0);
  });
});
