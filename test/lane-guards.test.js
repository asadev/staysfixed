/**
 * A guard that ran out of time has not caught anything.
 *
 * Measured on 2026-08-31 against a healthy shop with three guards — one genuinely broken, and
 * one whose `run()` slept six seconds against its own limit of one and a half. The run
 * announced "2 guards failed — bugs that were already fixed are back." One bug was back. The
 * other guard was never answered, and that sentence sends somebody hunting a regression in
 * checkout that never happened, on a tree where nothing is wrong.
 *
 * Running out of time is the guard failing to report, not the product failing — the same
 * distance as "nothing changed" from "nothing was compared". It still has to keep the run out
 * of the green, because a question nobody got an answer to is not a pass either.
 *
 * The same run printed `Invalid parameters (Failed to deserialize params.expression - BINDINGS:
 * string value expected at position 19)` at a person as the whole reason their guard failed,
 * and `[object Object]` at them as the whole reason for another. Both are guarded here too.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runGuards, plainly } from '../src/guard/run.js';
import { allClear } from '../src/report/console.js';

/** A page that answers everything instantly, so these tests measure the runner and nothing else. */
function fakeApp() {
  return /** @type {any} */ ({
    page: {
      goto: async () => {},
      consoleErrors: () => [],
      clearConsole: () => {},
      exists: async () => true,
    },
  });
}

/** A web project, so the clean start is one `goto` and never touches a real browser. */
const project = /** @type {any} */ ({
  config: { app: { kind: 'web', url: 'http://127.0.0.1:1' } },
  paths: { root: '/tmp' },
});

/** @param {any[]} guards */
function run(guards) {
  return runGuards(project, fakeApp(), /** @type {any} */ (guards), {});
}

/**
 * A guard that never finishes inside its own limit.
 * @param {number} timeoutMs
 */
function stuckGuard(timeoutMs) {
  return {
    name: 'the basket still empties after checkout',
    because: 'Checking out twice used to leave the old basket behind.',
    timeoutMs,
    /** @param {any} app */
    async run(app) {
      await new Promise((r) => setTimeout(r, timeoutMs * 10).unref?.());
      await app.expect('the basket is empty', async () => true);
    },
  };
}

/** Quick enough that five of these do not make the file slow to run. */
const stuck = stuckGuard(300);

/** A guard whose claim really is false — the bug really is back. */
const broken = {
  name: 'the delivery note still shows on the front page',
  because: 'The delivery note vanished for two days after a template change.',
  timeoutMs: 2000,
  /** @param {any} app */
  async run(app) {
    await app.expect('the delivery note is on the page', async () => false);
  },
};

/** A guard that asks a question and gets the right answer. */
const holds = {
  name: 'the order button is still on the front page',
  because: 'A refactor deleted the button and nobody noticed for a day.',
  timeoutMs: 2000,
  /** @param {any} app */
  async run(app) {
    await app.expect('the order button is on the page', async () => true);
  },
};

describe('a guard that runs out of time', () => {
  test('is marked as having run out of time, not as a bug coming back', async () => {
    const [result] = /** @type {any[]} */ (await run([stuck]));
    assert.equal(result.timedOut, true, 'the result has to carry the timeout as its own outcome');
    assert.match(result.message, /ran out of time/);
    // Compared against the words a returned bug actually gets, rather than banned phrases: a
    // message that says "nothing here says the bug is back" would fail a search for "is back"
    // while being exactly right.
    const [returned] = /** @type {any[]} */ (await run([broken]));
    assert.doesNotMatch(
      result.message,
      /This should still be true, and it is not/,
      `it is still being described as a returned bug: ${result.message}`,
    );
    assert.match(returned.message, /This should still be true, and it is not/, 'a real failure still says it');
  });

  test('names no failed claim, because no claim was ever answered', async () => {
    const [result] = /** @type {any[]} */ (await run([stuck]));
    assert.equal(result.failedAt, undefined, 'a claim nobody reached must not be printed as the one that failed');
  });

  test('still keeps the run out of the green', async () => {
    // The whole point of splitting the wording is so the SENTENCE can tell the two apart —
    // never so that one of them can quietly become a pass. A guard nobody got an answer out
    // of is the quietest way there is to go green, and it must stay shut.
    const guards = await run([stuck]);
    assert.equal(guards[0].status, 'failed');
    assert.equal(allClear(/** @type {any} */ ({ pictures: [], guards })), false);
  });

  test('quotes the limit the guard actually set', async () => {
    // Rounded to whole seconds, `timeoutMs: 1500` came back as "within 2 seconds" — a number
    // that appears nowhere in the guard, so it reads as the tool having waited longer than it did.
    const [result] = /** @type {any[]} */ (await run([stuckGuard(1500)]));
    assert.match(result.message, /1\.5 seconds/);
    assert.doesNotMatch(result.message, /2 seconds/);
  });

  test('does not lead with the story of the original bug', async () => {
    // The story is printed beside a failure to say whether the failure matters. Nothing here
    // says the bug is back, so leading with its story gives exactly the wrong impression —
    // and the story still travels on the result for anything that wants it.
    const [result] = /** @type {any[]} */ (await run([stuck]));
    assert.doesNotMatch(result.message, /Why this guard exists/);
    assert.equal(result.because, stuck.because, 'the story itself must not be thrown away');
  });
});

describe('a guard that really did fail', () => {
  test('still says the bug is back', async () => {
    const [result] = /** @type {any[]} */ (await run([broken]));
    assert.equal(result.status, 'failed');
    assert.notEqual(result.timedOut, true, 'a real failure must never be excused as a timeout');
    assert.match(result.message, /This should still be true, and it is not/);
    assert.equal(result.failedAt, 'the delivery note is on the page');
    // The story used to be checked for inside `message`. It is checked for on the result
    // instead now, because putting it in the message as well printed it twice on one screen:
    // every renderer prints `because` on its own line underneath, and the blank line the
    // message carried also put a newline inside a value that is a cell in the results table.
    // What matters is that the story is still there and still reaches a person — which
    // test/guard-story-once.test.js holds in place on the rendered output itself.
    assert.equal(result.because, broken.because, 'the story of the bug must still travel with it');
  });

  test('a guard that asked and got the right answer is still a pass', async () => {
    const [result] = /** @type {any[]} */ (await run([holds]));
    assert.equal(result.status, 'passed');
    assert.equal(result.timedOut, undefined);
  });

  test('the three outcomes stay apart in one run', async () => {
    const results = /** @type {any[]} */ (await run([holds, broken, stuck]));
    assert.deepEqual(
      results.map((r) => [r.status, r.timedOut === true]),
      [
        ['passed', false],
        ['failed', false],
        ['failed', true],
      ],
    );
  });
});

describe('the debugging protocol is never printed at a person', () => {
  test("Chrome's own diagnostics are dropped from the end of a message", () => {
    const raw =
      'The app refused the request "Runtime.evaluate": Invalid parameters (Failed to deserialize params.expression - BINDINGS: string value expected at position 19)';
    const said = plainly(raw);
    assert.doesNotMatch(said, /Failed to deserialize|BINDINGS|at position/);
    assert.match(said, /Invalid parameters/, 'the readable part must survive');
  });

  test('a bracket that says something useful is left alone', () => {
    const raw = 'The page threw an error: TypeError: cannot read x (the sidebar had already closed)';
    assert.equal(plainly(raw), raw);
  });

  test('a raw protocol frame becomes a sentence', () => {
    const said = plainly('{"id":17,"method":"Runtime.callFunctionOn","params":{"objectId":"1.2.3"}}');
    assert.doesNotMatch(said, /"method"|objectId/);
    assert.match(said, /debugging-protocol/);
  });

  test('a guard that threw something that is not an error gets a real sentence', async () => {
    // `String({...})` is "[object Object]", which was printed as the entire reason a guard failed.
    const thrower = {
      name: 'the receipt still prints one line per item',
      because: 'Receipts used to collapse duplicate items into one line.',
      timeoutMs: 2000,
      async run() {
        throw { id: 17, method: 'Runtime.callFunctionOn' };
      },
    };
    const [result] = /** @type {any[]} */ (await run([thrower]));
    assert.doesNotMatch(result.message, /\[object Object\]/);
    assert.match(result.message, /not an error/);
  });

  test('only the first line survives, so the results table stays a table', () => {
    // A stack trace, a browser library's "Call log" block and a protocol dump all arrive as
    // one message with newlines in it. The second line lands in the next column of the row
    // this sits in, and the table comes apart.
    const said = plainly('Timeout 30000ms exceeded.\n=== logs ===\nwaiting for locator("#save")\n===');
    assert.equal(said, 'Timeout 30000ms exceeded.');
    assert.ok(!said.includes('\n'));
  });

  test('an ordinary message is passed through untouched', () => {
    const raw = 'The page threw an error: SyntaxError: \'::::\' is not a valid selector.';
    assert.equal(plainly(raw), raw);
  });
});
