/**
 * The message a guard gets when it reaches for a method that is not there.
 *
 * A guard is the first code most people write against this tool, and the object it is handed
 * is not the shape anybody arrives expecting. This is the one error a stranger is most likely
 * to meet, so it is the one that most has to say something useful — and it was the raw
 * JavaScript sentence "page.goto is not a function" until the first guard written against the
 * tool while proving it still worked failed exactly that way.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { explainApiSlip } from '../src/guard/run.js';

/** Enough of a page handle for the explainer, which only reads the names on it. */
const page = /** @type {any} */ ({ goto: () => {}, click: () => {}, evaluate: () => {} });
const project = /** @type {any} */ ({ config: { app: { url: 'http://localhost' } }, paths: { root: '/tmp' } });

describe('explaining a guard that called something that is not there', () => {
  test('an error it does not recognise is passed through untouched', () => {
    const raw = 'Something else went wrong entirely';
    assert.equal(explainApiSlip(raw, page, project), raw);
  });

  test('a method that DOES exist on the guard object is not second-guessed', () => {
    // This shape means something inside `open` threw, not that `open` is missing. Rewriting
    // it would bury the real failure under an explanation of an API that is working.
    const raw = 'open is not a function';
    assert.equal(explainApiSlip(raw, page, project), raw);
  });

  test('it never repeats the name back as the suggestion', () => {
    // The receiver in the error is whatever the guard called its parameter. The first guard
    // to hit this called it `page`, so reading that name as if it meant the page handle
    // suggested "did you mean goto()" — the very thing that had just been written.
    const said = explainApiSlip('page.goto is not a function', page, project);
    assert.ok(!/did you mean .?goto/i.test(said), `it suggested the same name back: ${said}`);
    assert.match(said, /app\.open/);
  });

  test('a near miss on one name is suggested, and only when there is exactly one', () => {
    const said = explainApiSlip('app.opened is not a function', page, project);
    assert.match(said, /You probably want `app\.open\(\)`/);
  });

  test('it names what the guard object actually has, and stays short', () => {
    const said = explainApiSlip('app.wibble is not a function', page, project);
    for (const name of ['click', 'expect', 'open', 'read', 'run']) {
      assert.ok(said.includes(`\`${name}()\``), `it did not name ${name}: ${said}`);
    }
    // An earlier version listed all thirty names on the page handle inline. It was complete,
    // unreadable, and it destroyed the results table it was printed inside.
    assert.ok(!said.includes('addInitScript'), 'it is listing the whole page handle again');
    assert.ok(said.length < 420, `too long to sit in a results table: ${said.length} characters`);
  });
});
