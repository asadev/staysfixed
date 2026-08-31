/**
 * The panel must not say a bug is back when nobody asked the question.
 *
 * Three different things wear the status `failed` on a guard: its claim really broke, its
 * clock ran out, or it asserted nothing at all. The terminal was taught the difference on
 * 2026-08-31; the live panel was not, and called all three "broken again" — with the story
 * of the original bug printed underneath, which reads as proof. On a healthy tree, a guard
 * that timed out therefore announced a returned bug, in the one place somebody is watching
 * while they work.
 *
 * The wording lives in the browser half of the panel, which ships as text inside
 * `panelHtml()`. So the functions are lifted straight out of the page that is really served
 * and run here — a test that read the source for banned words would pass on a comment.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { panelHtml } from '../src/watch/panel.js';

/**
 * Lift one function out of the served page and make it callable.
 * @param {string} name
 * @returns {(kind: string, ev: any) => string}
 */
function lift(name) {
  const page = panelHtml();
  const at = page.indexOf(`function ${name}(`);
  assert.ok(at > -1, `${name} is not in the page any more — this test is about the page that is served`);
  let depth = 0;
  let end = page.indexOf('{', at);
  const start = end;
  for (; end < page.length; end += 1) {
    if (page[end] === '{') depth += 1;
    else if (page[end] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = page.slice(start + 1, end);
  return /** @type {(kind: string, ev: any) => string} */ (
    new Function('kind', 'ev', `${body}\nreturn '';`)
  );
}

describe('what the panel calls a guard that did not answer', () => {
  const outcomeText = lift('outcomeText');
  const shortOutcome = lift('shortOutcome');

  test('a guard that ran out of time is not a returned bug', () => {
    const ev = { status: 'failed', timedOut: true, message: 'ran out of time' };
    assert.doesNotMatch(outcomeText('guard', ev), /broken again/);
    assert.match(outcomeText('guard', ev), /nobody knows/);
    assert.doesNotMatch(shortOutcome('guard', ev), /broken again/);
  });

  test('a guard that asserted nothing proved nothing', () => {
    const ev = { status: 'failed', assertedNothing: true };
    assert.doesNotMatch(outcomeText('guard', ev), /broken again/);
    assert.match(outcomeText('guard', ev), /proved nothing/);
    assert.doesNotMatch(shortOutcome('guard', ev), /broken again/);
  });

  test('a guard whose claim really broke still says so', () => {
    const ev = { status: 'failed', message: 'the total lost its pennies' };
    assert.equal(outcomeText('guard', ev), 'the total lost its pennies');
    assert.equal(shortOutcome('guard', ev), 'broken again');
  });

  test('a guard that held still says it held', () => {
    assert.equal(outcomeText('guard', { status: 'passed' }), 'still holds');
    assert.equal(shortOutcome('guard', { status: 'passed' }), 'still holds');
  });
});
