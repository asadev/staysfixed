/**
 * A guard that asks nothing has not held.
 *
 * Measured on 2026-08-30: a guard called "the checkout total is never charged twice", whose
 * `run()` was an empty function, came back as `ok ... still holds`. It cannot hold and it
 * cannot fail — it is a name over an empty room, and it would say that every day for ever.
 * The whole promise of this half of the tool is one plain-English rule per bug somebody
 * already had; a rule that checks nothing is worse than no rule, because somebody believes it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { verdictFor, allClear } from '../src/report/console.js';

/** @param {any} guards @returns {any} */
const run = (guards) => ({ pictures: [], guards });

describe('a guard that checks nothing', () => {
  test('is not a clean run', () => {
    const empty = run([{ name: 'the checkout total is never charged twice', status: 'failed', assertedNothing: true }]);
    assert.equal(allClear(empty), false, 'it must never come back as everything being fine');
  });

  test('is not described as a bug coming back, because it is not one', () => {
    // Two different things wore the same status. Calling both "a bug is back" sends somebody
    // hunting a regression that never happened.
    const empty = run([{ name: 'the checkout total is never charged twice', status: 'failed', assertedNothing: true }]);
    const said = verdictFor(empty);
    assert.match(said, /checks nothing/);
    assert.doesNotMatch(said, /already fixed is back/);
  });

  test('a guard that really did fail still says a bug is back', () => {
    const broke = run([{ name: 'the order button is still on the front page', status: 'failed' }]);
    const said = verdictFor(broke);
    assert.match(said, /already fixed is back/);
    assert.equal(allClear(broke), false);
  });

  test('a guard that asked and got the right answer is still a pass', () => {
    const fine = run([{ name: 'the order button is still on the front page', status: 'passed' }]);
    assert.equal(allClear(fine), true, 'or nothing could ever be green');
  });
});
