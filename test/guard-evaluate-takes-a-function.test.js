/**
 * `evaluate` takes a function, because that is what everybody writes first.
 *
 * A guard can run its own JavaScript inside the app, and this took only text. Every other
 * tool in this space takes a function — `page.evaluate(() => document.title)` — so that is
 * what somebody who has driven a browser before writes, and what came back, measured while
 * using the tool on 2026-08-31, was the whole of the message:
 *
 *     The app refused the request "Runtime.evaluate": Invalid parameters
 *
 * The machine's own words about its own wire format, said to somebody who had done nothing
 * wrong. A function is turned into the call it obviously means now, and the two things that
 * genuinely cannot be run say so in a sentence with an example in it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { asJavaScript } from '../src/drive/page.js';

describe('what evaluate accepts', () => {
  test('text goes through exactly as written', () => {
    assert.equal(asJavaScript('document.title'), 'document.title');
  });

  test('an arrow function becomes a call', () => {
    assert.equal(asJavaScript(() => document.title), '(() => document.title)()');
  });

  test('an async function is called and awaited by the page, not unwrapped here', () => {
    // `awaitPromise` is already on the protocol call, so returning a promise is fine. What
    // matters here is only that the source arrives as something the page can run.
    const js = asJavaScript(async () => 1);
    assert.match(js, /^\(async \(\) => 1\)\(\)$/);
  });

  test('a plain function expression becomes a call', () => {
    assert.equal(
      asJavaScript(function () {
        return 1;
      }).replace(/\s+/g, ' '),
      '(function () { return 1; })()',
    );
  });

  test('shorthand method syntax is put back in an object rather than sent as it stands', () => {
    // `String()` of one of these is `title() { ... }`, which is not an expression: wrapping
    // it in brackets and calling it would send the app a syntax error.
    const { title } = { title() { return document.title; } };
    const js = asJavaScript(title);
    assert.match(js, /^\(\{ title\(\)/);
    assert.match(js, /\}\)\.title\(\)$/);
  });
});

describe('what evaluate refuses, and how', () => {
  test('a function that asks for an argument is refused, because nothing can be passed', () => {
    assert.throws(
      () => asJavaScript((/** @type {any} */ x) => x),
      (/** @type {any} */ e) => {
        assert.match(String(e.message), /nothing passed to it/i);
        assert.match(String(e.hint ?? ''), /page\.evaluate/);
        return true;
      },
    );
  });

  test('a built-in is refused by name, not by a syntax error out of the app', () => {
    assert.throws(
      () => asJavaScript(Math.max),
      (/** @type {any} */ e) => {
        assert.match(String(e.message), /built-in/i);
        assert.match(String(e.hint ?? ''), /page\.evaluate\(\(\) =>/);
        return true;
      },
    );
  });

  test('anything else says what it wants, what it got, and shows both ways of writing it', () => {
    assert.throws(
      () => asJavaScript(/** @type {any} */ ({ js: 'document.title' })),
      (/** @type {any} */ e) => {
        const said = `${e.message} ${e.hint ?? ''}`;
        assert.match(said, /JavaScript written as text/i, said);
        assert.match(said, /object/, said);
        // Both shapes, so the reader does not have to guess which one this tool wants.
        assert.match(said, /page\.evaluate\('document\.title'\)/, said);
        assert.match(said, /page\.evaluate\(\(\) => document\.title\)/, said);
        return true;
      },
    );
  });

  test('nothing in the message is the debug protocol talking to itself', () => {
    for (const bad of [42, null, undefined, { js: 'x' }]) {
      try {
        asJavaScript(/** @type {any} */ (bad));
        assert.fail(`${String(bad)} was accepted`);
      } catch (e) {
        const said = String(/** @type {any} */ (e).message);
        assert.ok(!/Invalid parameters/i.test(said), said);
        assert.ok(!/Runtime\.evaluate/i.test(said), said);
      }
    }
  });
});
