/**
 * The parts of the watch window that can be checked without opening one.
 *
 * Where the panel sits is arithmetic, what it is told to do is a merge of a
 * settings file and a command line, and the page it draws is a string — so all
 * three are tested here in an ordinary Node process. Everything else about the
 * panel — that it really opens, behind your work, and draws what arrives — needs
 * a real browser and is left to a person looking at it.
 *
 * How the panel and the app are placed relative to each other lives next door,
 * in `place.test.js`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { panelBounds } from '../src/watch/window.js';
import { watchOptionsFrom } from '../src/watch/index.js';
import { panelHtml } from '../src/watch/panel.js';

/** A perfectly ordinary desktop app window. */
const APP = { width: 1440, height: 900 };

/**
 * Both of these live in another file and this test only cares how they behave,
 * so they are called through a loose type instead of pinning down a shape that
 * file is free to change.
 * @type {(app: any, watch: any) => {width: number, height: number, x: number, y: number}}
 */
const boundsFor = panelBounds;

/** @type {(plan?: any) => string} */
const htmlFor = panelHtml;

/** @type {(config: any, cli: any) => any} */
const optionsFrom = watchOptionsFrom;

/**
 * @param {{width: number, height: number, x: number, y: number}} bounds
 * @param {string} what
 * @returns {void}
 */
function assertUsable(bounds, what) {
  for (const [key, value] of Object.entries(bounds)) {
    assert.equal(typeof value, 'number', `${what}: ${key} is not a number`);
    assert.ok(Number.isFinite(value), `${what}: ${key} is ${value}`);
  }
  assert.ok(bounds.width > 0, `${what}: a panel with no width is not a panel`);
  assert.ok(bounds.height > 0, `${what}: a panel with no height is not a panel`);
}

describe('where the panel sits', () => {
  test('on the right it starts where the app ends, so it never covers it', () => {
    const bounds = boundsFor(APP, { side: 'right', width: 460 });
    assertUsable(bounds, 'right');
    assert.equal(bounds.width, 460);
    assert.ok(bounds.x >= APP.width, `the panel starts at ${bounds.x}, inside an app 1440 wide`);
  });

  test('on the left it sits the other side of the app', () => {
    const left = boundsFor(APP, { side: 'left', width: 460 });
    const right = boundsFor(APP, { side: 'right', width: 460 });
    assertUsable(left, 'left');

    assert.ok(left.x < right.x, 'the left panel is not to the left of the right one');
    assert.ok(left.x + left.width <= APP.width, 'the left panel runs across the app');
  });

  test('it is as tall as the app unless it is told otherwise', () => {
    assert.equal(boundsFor(APP, { side: 'right' }).height, APP.height);
    assert.equal(boundsFor(APP, { side: 'right', height: 640 }).height, 640);
  });

  test('460 wide is the default nobody has to know about', () => {
    assert.equal(boundsFor(APP, {}).width, 460);
    assert.equal(boundsFor(APP, { width: 520 }).width, 520);
  });

  test('with no app size to go on it still gives somewhere to put a window', () => {
    // A web app that never reported a viewport, or a run that failed before the
    // app opened. The panel still has to appear somewhere sensible.
    assertUsable(boundsFor(undefined, { side: 'right' }), 'no viewport');
    assertUsable(boundsFor(undefined, {}), 'no viewport, no options');
  });
});

describe('the page the panel draws', () => {
  test('it is a document with the door the run pushes events through', () => {
    const html = htmlFor({
      project: 'shop',
      app: 'the web app at localhost:3000',
      screens: [{ name: 'home' }, { name: 'billing-empty', describe: 'Billing with no invoices yet' }],
      guards: [{ name: 'the sidebar still collapses' }],
    });
    assert.equal(typeof html, 'string');
    assert.ok(html.length > 0);
    assert.match(html, /<html/i);
    assert.ok(html.includes('__staysfixed_push'), 'the page has no way to be told what happened');
  });

  test('it asks the internet for nothing at all', () => {
    // The panel opens on a machine that may have no network, in a browser with no
    // profile, while a run is being timed. Anything fetched could hang it, and a
    // font arriving late would make the panel itself flicker.
    const html = htmlFor({ project: 'shop', app: 'the web app', screens: [{ name: 'home' }], guards: [] });
    assert.ok(!html.includes('http://'), 'the panel loads something over http');
    assert.ok(!html.includes('https://'), 'the panel loads something over https');
  });

  test('a project name is text, never code', () => {
    // Project names come from a settings file, and a settings file is as
    // trustworthy as whoever cloned the repository.
    const html = htmlFor({
      project: 'Shop <script>alert("x")</script>',
      app: 'the web app',
      screens: [{ name: 'home' }],
      guards: [],
    });
    assert.ok(html.includes('Shop'), 'the panel never shows the project name at all');
    assert.ok(!html.includes('<script>alert("x")</script>'), 'the project name went in as live code');
    assert.ok(!html.includes('alert("x")</script>'), 'the project name can still close the script tag');
  });
});

describe('what the panel is told to do', () => {
  test('with nothing set it takes the answers nobody has to know about', () => {
    const opts = optionsFrom(null, null);
    assert.equal(opts.enabled, false, 'the panel opens without anybody asking for it');
    assert.equal(opts.width, 460);
    assert.equal(opts.side, 'right');
    assert.equal(opts.keepOpen, true, 'the panel closes before you can look at what changed');
    assert.equal(opts.foreground, false, 'the panel takes the screen off whatever you are using');
    assert.equal(opts.snap, true, 'the panel does not attach itself to the app');
    // No height means "as tall as the app", which is a different answer from a
    // number, so it must not be invented here.
    assert.equal('height' in opts, false, 'a height was guessed at');
  });

  test('every flag says what it says', () => {
    const opts = optionsFrom(null, {
      enabled: true,
      side: 'left',
      width: 520,
      height: 700,
      keepOpen: false,
      foreground: true,
      snap: false,
      theme: 'light',
    });
    assert.deepEqual(opts, {
      enabled: true,
      width: 520,
      side: 'left',
      keepOpen: false,
      foreground: true,
      snap: false,
      theme: 'light',
      height: 700,
    });
  });

  test('the panel is dark unless somebody asks for something else', () => {
    // Not a preference: the panel opens on a brand new browser profile, and a fresh
    // profile insists the computer is in light mode however it is really set. Asking
    // it would get the wrong answer, so it is told.
    assert.equal(optionsFrom(null, { enabled: true }).theme, 'dark');
    assert.equal(optionsFrom({ watch: { theme: 'light' } }, null).theme, 'light');
    assert.equal(optionsFrom({ watch: { theme: 'system' } }, null).theme, 'system');
    assert.equal(optionsFrom({ watch: { theme: 'nonsense' } }, null).theme, 'dark');
    assert.equal(optionsFrom({ watch: { theme: 'light' } }, { theme: 'dark' }).theme, 'dark');
  });

  test('--no-snap reaches the panel, from the command line or the settings file', () => {
    assert.equal(optionsFrom(null, { enabled: true, snap: false }).snap, false, '--no-snap was ignored');
    assert.equal(optionsFrom({ watch: { snap: false } }, null).snap, false, 'the settings file was ignored');
    // Typed on the command line beats written in the file, both ways round.
    assert.equal(optionsFrom({ watch: { snap: false } }, { snap: true }).snap, true);
    assert.equal(optionsFrom({ watch: { snap: true } }, { snap: false }).snap, false);
  });

  test('the settings file can ask for the panel, and --watch never takes it away', () => {
    assert.equal(optionsFrom({ watch: true }, null).enabled, true);
    assert.equal(optionsFrom({ watch: { enabled: true } }, null).enabled, true);
    // Not typing --watch is not the same as saying no to it.
    assert.equal(optionsFrom({ watch: true }, { enabled: false }).enabled, true);
  });

  test('the settings file is overruled by anything actually typed', () => {
    const settings = { watch: { enabled: true, side: 'right', width: 300, keepOpen: true, foreground: false } };
    const opts = optionsFrom(settings, { side: 'left', width: 620, keepOpen: false, foreground: true });
    assert.equal(opts.side, 'left');
    assert.equal(opts.width, 620);
    assert.equal(opts.keepOpen, false);
    assert.equal(opts.foreground, true);
  });

  test('nonsense in the settings file does not become nonsense on screen', () => {
    // A settings file is as trustworthy as whoever cloned the repository.
    assert.equal(optionsFrom({ watch: { side: /** @type {any} */ ('sideways') } }, null).side, 'right');
    assert.equal(optionsFrom({ watch: { width: /** @type {any} */ ('wide') } }, null).width, 460);
    assert.equal(optionsFrom(/** @type {any} */ ({ watch: 'yes' }), null).enabled, false);
  });
});
