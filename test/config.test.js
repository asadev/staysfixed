/**
 * The config layer: what a project gets for free, and what it is refused.
 *
 * Every refusal here is a message a person will read at the moment they are most
 * annoyed, so the tests check that the right one comes out — not merely that
 * something threw.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  loadProject,
  resolveConfig,
  settingsForScreen,
  DEFAULT_VIEWPORT,
  DEFAULT_FREEZE,
  DEFAULT_TOLERANCE,
  DEFAULT_SETTLE,
  DEFAULT_MCP,
} from '../src/core/config.js';
import { StaysFixedError } from '../src/core/errors.js';
import { scratchDir, cleanUp } from './support.mjs';

/** The smallest config that is allowed to exist. */
const minimal = () => ({ app: { kind: 'web', url: 'http://localhost:3000' } });

after(cleanUp);

/**
 * Assert that a call throws our own error, and that the message says the thing
 * we meant it to say.
 * @param {() => unknown} run
 * @param {RegExp} says
 */
function refuses(run, says) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof StaysFixedError, `expected a StaysFixedError, got ${String(error)}`);
    assert.match(error.message, says);
    return true;
  });
}

describe('defaults', () => {
  test('a minimal web config comes back fully furnished', () => {
    const c = resolveConfig(minimal());

    assert.deepEqual(c.viewport, DEFAULT_VIEWPORT);
    assert.deepEqual(c.tolerance, DEFAULT_TOLERANCE);
    assert.deepEqual(c.freeze.settle, DEFAULT_SETTLE);
    assert.equal(c.freeze.clock, DEFAULT_FREEZE.clock);
    assert.equal(c.freeze.timezone, 'UTC');
    assert.equal(c.freeze.network, 'block-external');
    assert.deepEqual(c.masks, []);
    assert.deepEqual(c.screens, []);
    assert.equal(c.dir, '.staysfixed');
    assert.equal(c.flakeLimit, 2);
    assert.equal(c.retries, 1);
    assert.equal(c.concurrency, 1);
  });

  test('an agent cannot approve its own work unless the project says so', () => {
    const c = resolveConfig(minimal());
    assert.deepEqual(c.mcp, DEFAULT_MCP);
    assert.equal(c.mcp.allowApprove, false);
    assert.equal(c.mcp.allowMark, false);

    const opted = resolveConfig({ ...minimal(), mcp: { allowApprove: true } });
    assert.equal(opted.mcp.allowApprove, true);
    // Opting in to one door must not open the other.
    assert.equal(opted.mcp.allowMark, false);
  });

  test('concurrency never drops below one, however it is written', () => {
    assert.equal(resolveConfig({ ...minimal(), concurrency: 0 }).concurrency, 1);
    assert.equal(resolveConfig({ ...minimal(), concurrency: -4 }).concurrency, 1);
    assert.equal(resolveConfig({ ...minimal(), concurrency: 3 }).concurrency, 3);
  });

  test('a screen url becomes the first step', () => {
    const c = resolveConfig({ ...minimal(), screens: [{ name: 'home', url: '/home' }] });
    assert.deepEqual(c.screens[0].steps, [{ goto: '/home' }]);
  });

  test('a screen url is prepended to the steps it already had', () => {
    const c = resolveConfig({
      ...minimal(),
      screens: [{ name: 'home', url: '/', steps: [{ click: '#go' }] }],
    });
    assert.deepEqual(c.screens[0].steps, [{ goto: '/' }, { click: '#go' }]);
  });

  test('a screen with only a do() function is accepted', () => {
    const c = resolveConfig({
      ...minimal(),
      screens: [{ name: 'home', do: async () => {} }],
    });
    assert.equal(c.screens[0].name, 'home');
    assert.equal(typeof c.screens[0].do, 'function');
  });

  test('an electron config does not need a url', () => {
    const c = resolveConfig({ app: { kind: 'electron', binary: '/tmp/Whatever' } });
    assert.equal(c.app.kind, 'electron');
    assert.deepEqual(c.app.args, []);
    assert.deepEqual(c.app.env, {});
  });

  test('attaching to a running app stands in for both url and binary', () => {
    assert.equal(resolveConfig({ app: { kind: 'web', attach: 'http://127.0.0.1:9333' } }).app.kind, 'web');
    assert.equal(
      resolveConfig({ app: { kind: 'electron', attach: 'http://127.0.0.1:9333' } }).app.kind,
      'electron',
    );
  });
});

describe('what a config is refused for', () => {
  test('nothing at all', () => {
    refuses(() => resolveConfig(null), /did not export a config object/);
    refuses(() => resolveConfig('a string'), /did not export a config object/);
    refuses(() => resolveConfig(42), /did not export a config object/);
  });

  test('no app', () => {
    refuses(() => resolveConfig({}), /do not name anything to open/);
    refuses(() => resolveConfig({ app: 'chrome' }), /do not name anything to open/);
  });

  test('and settings for a product with no screen are told which half of the tool covers them', () => {
    // A command-line tool, a library or a server has nothing to open, and that is the
    // correct shape for its settings. The picture commands still cannot run — but sending
    // somebody off to invent a web address they do not have is worse than refusing.
    assert.throws(
      () => resolveConfig({ product: 'tiny', process: { commands: [{ name: 'x', run: 'node x.js' }] } }),
      (error) => {
        assert.ok(error instanceof StaysFixedError);
        assert.match(String(error.hint), /staysfixed check/, 'it has to name the half of the tool that does cover this project');
        assert.match(String(error.hint), /process/, 'and say which of these settings it recognised, so the refusal is about THIS project');
        return true;
      },
    );
  });

  test('an app kind nobody has heard of', () => {
    refuses(() => resolveConfig({ app: { kind: 'ios' } }), /must be 'web' or 'electron'/);
    refuses(() => resolveConfig({ app: {} }), /must be 'web' or 'electron'/);
  });

  test('a web app with no address', () => {
    refuses(() => resolveConfig({ app: { kind: 'web' } }), /needs `app\.url`/);
  });

  test('an electron app with no binary', () => {
    refuses(() => resolveConfig({ app: { kind: 'electron' } }), /needs `app\.binary`/);
  });

  test('a screen that is not an object', () => {
    refuses(() => resolveConfig({ ...minimal(), screens: [null] }), /screens\[0\] is not an object/);
    refuses(() => resolveConfig({ ...minimal(), screens: ['home'] }), /screens\[0\] is not an object/);
  });

  test('a screen with no name', () => {
    refuses(() => resolveConfig({ ...minimal(), screens: [{ url: '/' }] }), /screens\[0\] has no name/);
    refuses(() => resolveConfig({ ...minimal(), screens: [{ name: 7, url: '/' }] }), /screens\[0\] has no name/);
  });

  test('a screen that never says how to get there', () => {
    refuses(
      () => resolveConfig({ ...minimal(), screens: [{ name: 'home' }] }),
      /Screen "home" says nothing about how to get there/,
    );
  });

  test('two screens with the same name', () => {
    refuses(
      () =>
        resolveConfig({
          ...minimal(),
          screens: [
            { name: 'home', url: '/' },
            { name: 'home', url: '/again' },
          ],
        }),
      /Two screens are both called "home"/,
    );
  });

  test('a clock that is not a time', () => {
    refuses(() => resolveConfig({ ...minimal(), freeze: { clock: 'last tuesday' } }), /not a time I can read/);
  });

  test('a clock that is switched off is fine', () => {
    assert.equal(resolveConfig({ ...minimal(), freeze: { clock: false } }).freeze.clock, false);
  });

  test('a network mode that does not exist', () => {
    refuses(
      () => resolveConfig({ ...minimal(), freeze: { network: 'offline' } }),
      /must be 'replay', 'block-external' or 'live'/,
    );
  });

  test('every refusal carries a name for the file it came from', () => {
    refuses(() => resolveConfig(null, '/somewhere/staysfixed.config.js'), /^staysfixed\.config\.js/);
  });
});

describe('settingsForScreen', () => {
  const base = () =>
    resolveConfig({
      ...minimal(),
      viewport: { width: 1200, height: 800 },
      tolerance: { pixels: 0.01 },
      masks: ['.everywhere'],
      freeze: { settle: { frames: 3 } },
      screens: [{ name: 'home', url: '/' }],
    });

  test('a screen with no opinions gets the project settings', () => {
    const config = base();
    const s = settingsForScreen(config, config.screens[0]);
    assert.equal(s.viewport.width, 1200);
    assert.equal(s.tolerance.pixels, 0.01);
    assert.deepEqual(s.masks, ['.everywhere']);
    assert.equal(s.freeze.settle.frames, 3);
    assert.equal(s.freeze.settle.intervalMs, DEFAULT_SETTLE.intervalMs);
  });

  test('a screen overrides one field without losing the rest', () => {
    const config = base();
    const s = settingsForScreen(config, {
      name: 'wide',
      url: '/',
      viewport: { width: 400, height: 900 },
      tolerance: { threshold: 0.3 },
      freeze: { settle: { intervalMs: 50 } },
    });
    assert.equal(s.viewport.width, 400);
    // deviceScaleFactor was never mentioned by the screen, so the project's stands.
    assert.equal(s.viewport.deviceScaleFactor, DEFAULT_VIEWPORT.deviceScaleFactor);
    assert.equal(s.tolerance.threshold, 0.3);
    assert.equal(s.tolerance.pixels, 0.01);
    assert.equal(s.freeze.settle.frames, 3);
    assert.equal(s.freeze.settle.intervalMs, 50);
  });

  test('screen masks are added to the project masks, never instead of them', () => {
    const config = base();
    const s = settingsForScreen(config, { name: 'home', url: '/', masks: ['#clock'] });
    assert.deepEqual(s.masks, ['.everywhere', '#clock']);
  });

  test('merging a screen does not change the project config', () => {
    const config = base();
    settingsForScreen(config, { name: 'home', url: '/', masks: ['#clock'], viewport: { width: 1, height: 1 } });
    assert.deepEqual(config.masks, ['.everywhere']);
    assert.equal(config.viewport.width, 1200);
  });
});

describe('loading a config from disk', () => {
  test('a JSON config works, so a project with no JavaScript can use the tool', async () => {
    const dir = await scratchDir('staysfixed-json');
    await fsp.writeFile(
      path.join(dir, 'staysfixed.config.json'),
      JSON.stringify({
        app: { kind: 'web', url: 'http://localhost:4321' },
        viewport: { width: 800, height: 600 },
        screens: [{ name: 'home', describe: 'the front page', url: '/' }],
      }),
    );

    const project = await loadProject({ cwd: dir });
    assert.equal(project.config.app.url, 'http://localhost:4321');
    assert.equal(project.config.viewport.width, 800);
    assert.equal(project.config.screens[0].describe, 'the front page');
    assert.deepEqual(project.config.screens[0].steps, [{ goto: '/' }]);
    assert.equal(project.paths.root, dir);
    assert.equal(project.paths.configFile, path.join(dir, 'staysfixed.config.json'));
  });

  test('a JavaScript config can use code for a screen', async () => {
    const dir = await scratchDir('staysfixed-js');
    await fsp.writeFile(
      path.join(dir, 'staysfixed.config.js'),
      `export default {
  app: { kind: 'web', url: 'http://localhost:4321' },
  screens: [{ name: 'home', async do(page) { await page.goto('/'); } }],
};
`,
    );
    const project = await loadProject({ cwd: dir });
    assert.equal(typeof project.config.screens[0].do, 'function');
  });

  test('broken JSON is explained, not thrown at the wall', async () => {
    const dir = await scratchDir('staysfixed-bad-json');
    await fsp.writeFile(path.join(dir, 'staysfixed.config.json'), '{ this is not json');
    await assert.rejects(loadProject({ cwd: dir }), (error) => {
      assert.ok(error instanceof StaysFixedError);
      assert.match(error.message, /not valid JSON/);
      return true;
    });
  });

  test('no config at all points at init', async () => {
    const dir = await scratchDir('staysfixed-empty');
    await assert.rejects(loadProject({ cwd: dir }), (error) => {
      assert.ok(error instanceof StaysFixedError);
      assert.match(error.message, /No Stays Fixed config found/);
      assert.match(String(error.hint), /staysfixed init/);
      return true;
    });
  });

  test('a config named on the command line is used instead of searching', async () => {
    const dir = await scratchDir('staysfixed-named');
    await fsp.writeFile(
      path.join(dir, 'other.config.json'),
      JSON.stringify({ app: { kind: 'web', url: 'http://localhost:9' } }),
    );
    const project = await loadProject({ cwd: dir, configFile: 'other.config.json' });
    assert.equal(project.config.app.url, 'http://localhost:9');
  });
});
