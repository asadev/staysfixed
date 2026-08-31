/**
 * Every sentence a run says about its guards has to be a thing the run knows.
 *
 * Four different outcomes wear two statuses, and each renderer used to sort them out for
 * itself — the terminal line, the verdict sentence, the results table and the HTML report,
 * four times, differently. Measured on 2026-08-31 against a healthy tree:
 *
 *   - "1 guard failed — a bug that was already fixed is back." for a guard whose clock ran
 *     out. Nobody had asked it anything it managed to finish.
 *   - "3 of 3 bugs that were fixed are back." over one real failure, one timeout and one
 *     guard that asserted nothing.
 *   - "All 3 bugs that were fixed are still fixed." over three guards marked skip.
 *   - "Everything that worked still works." over a run with nothing in it at all.
 *
 * The last one is the friendliest-sounding false all-clear this tool can print. A report that
 * cries wolf and a report that says all is well are the same failure by different routes:
 * both end with somebody not reading it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { verdictFor, allClear, guardVerdict, printRunSummary } from '../src/report/console.js';

/** @param {any} guards @param {any} [pictures] @returns {any} */
const run = (guards, pictures = []) => ({ pictures, guards, durationMs: 10 });

const held = { name: 'the order button is still on the front page', status: 'passed' };
const back = { name: 'the delivery note still shows', status: 'failed', failedAt: 'the delivery note is on the page' };
const late = {
  name: 'the basket still empties after checkout',
  status: 'failed',
  timedOut: true,
  because: 'Checking out twice used to leave the old basket behind.',
  message: 'This guard ran out of time after 1.5 seconds and never gave an answer.',
};
const hollow = { name: 'the checkout total is never charged twice', status: 'failed', assertedNothing: true };
const skipped = { name: 'the invoice still totals correctly', status: 'skipped' };

describe('a guard that ran out of time', () => {
  test('is not called a bug coming back', () => {
    const said = verdictFor(run([late]));
    assert.doesNotMatch(said, /already fixed is back/, said);
    assert.match(said, /ran out of time/);
    assert.match(said, /nobody knows/);
  });

  test('still keeps the run out of the green', () => {
    // A question nobody answered is the quietest way there is to go green, and it must stay shut.
    assert.equal(allClear(run([late])), false);
  });

  test('is counted apart from a guard that really did fail, in the same run', () => {
    const said = verdictFor(run([back, late]));
    assert.match(said, /^1 guard failed — a bug that was already fixed is back\./, said);
    assert.match(said, /1 guard ran out of time/, said);
    assert.doesNotMatch(said, /2 guards failed/, said);
  });

  test('gets a row in the table that says what happened, on one line', () => {
    let out = '';
    const real = process.stdout.write.bind(process.stdout);
    /** @type {any} */ (process.stdout).write = (/** @type {any} */ c) => {
      out += String(c);
      return true;
    };
    try {
      printRunSummary(run([late]));
    } finally {
      /** @type {any} */ (process.stdout).write = real;
    }
    const plain = out.replace(/\x1b\[\d+m/g, '');
    assert.match(plain, /ran out of time — nothing was proved either way/, plain);
    assert.doesNotMatch(plain, /broken again/, plain);
  });
});

describe('what a guard result actually says', () => {
  test('each of the four is told apart', () => {
    assert.equal(guardVerdict(/** @type {any} */ (held)), 'held');
    assert.equal(guardVerdict(/** @type {any} */ (back)), 'back');
    assert.equal(guardVerdict(/** @type {any} */ (late)), 'unanswered');
    assert.equal(guardVerdict(/** @type {any} */ (hollow)), 'unanswered');
    assert.equal(guardVerdict(/** @type {any} */ (skipped)), 'left out');
  });

  test('anything nobody recognises counts as unanswered, never as held', () => {
    // The one mistake that must never be made here is a result nobody understood being read
    // as a clean bill of health.
    assert.equal(guardVerdict(/** @type {any} */ ({ name: 'x', status: 'flaky' })), 'unanswered');
    assert.equal(guardVerdict(/** @type {any} */ ({ name: 'x' })), 'unanswered');
  });
});

describe('the sentence that summarises the rest', () => {
  test('does not call guards screens', () => {
    // "1 guard failed ... 1 guard checks nothing ... And 1 other screen needs a look." was
    // printed on 2026-08-31 about a run of five guards and no screens at all.
    const said = verdictFor(run([back, hollow, late, { ...back, name: 'another', assertedNothing: true }]));
    assert.doesNotMatch(said, /other screens? needs? a look|screens need a look/, said);
    assert.match(said, /other checks? needs? a look/, said);
  });
});

describe('a run that looked at nothing', () => {
  test('does not say everything still works, because nothing was tried', () => {
    const said = verdictFor(run([]));
    assert.doesNotMatch(said, /Everything that worked still works/, said);
    assert.match(said, /Nothing was checked/);
    assert.equal(allClear(run([])), false);
  });

  test('says the same when every guard and screen was left out', () => {
    const said = verdictFor(run([skipped, { ...skipped, name: 'another' }], [{ name: 'home', status: 'skipped' }]));
    assert.match(said, /Nothing was checked/, said);
    assert.equal(allClear(run([skipped])), false);
  });

  test('and a run that really did look at something still gets its green sentence', () => {
    assert.equal(verdictFor(run([held])), 'Everything that worked still works.');
    assert.equal(allClear(run([held])), true, 'or nothing could ever be green');
  });
});
