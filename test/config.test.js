/**
 * The config layer: what a project gets for free, and what it is refused.
 *
 * Every refusal here is a message a person will read at the moment they are most
 * annoyed, so the tests check that the right one comes out — not merely that
 * something threw.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  loadProject,
  resolveConfig,
  settingsForScreen,
  hasSomethingToOpen,
  NOTHING_TO_OPEN,
  DEFAULT_VIEWPORT,
  DEFAULT_FREEZE,
  DEFAULT_TOLERANCE,
  DEFAULT_SETTLE,
  DEFAULT_MCP,
} from '../src/core/config.js';
import { StaysFixedError } from '../src/core/errors.js';
import { versionTwoState } from '../src/cli/status.js';
import { cliPath, scratchDir, cleanUp } from './support.mjs';

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
        assert.match(error.message, /commands to run/, 'and say what these settings ARE, so the refusal is about THIS project');
        // `app` is version 1's word for the thing to open. The settings this tool writes
        // today have no `app` in them and never will, so telling somebody to add one sends
        // them editing their file against a shape nothing else in the tool uses.
        assert.doesNotMatch(error.message + String(error.hint), /\bapp:/, 'never a key the person has never heard of');
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

  test('a website described the version 2 way is never told it has no screen', () => {
    // `staysfixed init` writes `web: { start: 'npm run dev' }` for a website and says out
    // loud "The website can be checked here now ... opened in a throwaway browser". Seconds
    // later `status`, `walk` and `flake` all answered "these settings do not name anything
    // to open" and listed the project as `process, source` — about the same file. `status`
    // is the command whose entire promise is to say instantly what is set up here.
    assert.throws(
      () => resolveConfig({ product: 'website', web: { start: 'npm run dev' } }),
      (error) => {
        assert.ok(error instanceof StaysFixedError);
        assert.doesNotMatch(error.message, /do not name anything to open/, 'it has a website; saying it has nothing is the lie');
        assert.match(error.message, /website/i);
        assert.match(String(error.hint), /staysfixed check/, 'and it has to name the command that does cover it');
        return true;
      },
    );
  });

  test('a version 2 website that names its address just works', () => {
    // Where the address is knowable there is nothing to explain and nothing to refuse.
    const web = resolveConfig({ product: 'website', web: { start: 'npm run dev', url: 'http://localhost:4321' } });
    assert.equal(web.app.kind, 'web');
    assert.equal(web.app.url, 'http://localhost:4321');

    const desktop = resolveConfig({ product: 'desk', electron: { binary: '/tmp/Some.app/Contents/MacOS/Some' } });
    assert.equal(desktop.app.kind, 'electron');
    assert.equal(desktop.app.binary, '/tmp/Some.app/Contents/MacOS/Some');
  });

  test('status sees a version 2 run, so it never says nothing has happened after one', async () => {
    // Measured on 2026-08-30, one command after a check that walked 36 addresses and a ship
    // that cut the reference: `status` answered "Nothing has been checked here yet. Start
    // with: staysfixed check". It only ever counted version 1's things. The command whose
    // whole promise is to say instantly what is going on here was the one saying nothing
    // had happened.
    const root = await scratchDir('staysfixed-v2state');
    const dir = path.join(root, '.staysfixed', 'v2');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'last-check.json'),
      JSON.stringify({ at: '2026-08-30T09:11:15.968Z', verdict: 'nothing unaccounted for', reference: 'no-reference-yet', findings: [] }),
    );
    // The check wrote "no-reference-yet" because the ship had not happened yet. It has now,
    // and the reference is read from where it is kept rather than from that memory of it.
    await fsp.writeFile(
      path.join(dir, 'reference-log.json'),
      JSON.stringify([{ id: 'ref-older', product: 'p' }, { id: 'ref-20260830-131116-98896f', product: 'p' }]),
    );

    const state = versionTwoState(root);
    assert.ok(state, 'a project that has been checked has something to say');
    assert.equal(state.verdict, 'nothing unaccounted for');
    assert.equal(state.reference, 'ref-20260830-131116-98896f', 'the newest cut, not the check\'s stale field');
  });

  test('a project where nothing has run still says so', async () => {
    const root = await scratchDir('staysfixed-v2none');
    assert.equal(versionTwoState(root), null);
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


/*
 * The commands that were dead on the settings this tool writes for itself.
 *
 * Found on 2026-08-31 by using the published tool as a stranger would, on a Python
 * command-line tool and again on a plain Node one. `staysfixed init` wrote the settings, and
 * then FIVE of the commands `--help` offers — status, flake, mark, trace and approve —
 * refused to run at all. Every one of them does its whole job by reading files this tool has
 * already written; not one of them opens anything. They were refused because the only way to
 * load settings insisted on an `app` key that version 2's `init` never writes, so the
 * message a person got was a paragraph about a key they had never seen, in a file they had
 * never edited, about a project that was set up correctly.
 */
describe('commands that open nothing are never refused for having nothing to open', () => {
  /** The shape `staysfixed init` writes for a command-line tool or a library. */
  const versionTwoSettings = () => ({
    product: 'lint-lens',
    source: { folders: ['src'] },
    process: { commands: [{ name: 'lint-lens --help', run: 'python3 -m lint_lens.cli --help' }] },
  });

  test('a command that promises to open nothing gets its settings', () => {
    const config = resolveConfig(versionTwoSettings(), 'staysfixed.config.mjs', { opening: false });
    assert.equal(config.app.kind, NOTHING_TO_OPEN);
    assert.equal(hasSomethingToOpen(config), false);
    // And everything else in the file is still there to be read, which is the whole point:
    // `status` has to be able to say what these settings cover.
    assert.equal(/** @type {any} */ (config).process.commands.length, 1);
  });

  test('and one that does open something is still asked the same questions', () => {
    refuses(() => resolveConfig(versionTwoSettings()), /photographs a screen/);
    refuses(() => resolveConfig({ app: { kind: 'web' } }, '(inline)', { opening: false }), /needs `app\.url`/);
  });

  test('a version 2 website hands its screens across, not only its address', () => {
    // Half a bridge is worse than none. `walk` was given the address and then found nothing
    // to photograph, so it opened a browser and reported an empty walk of a site with three
    // screens sitting in its own settings file.
    const config = resolveConfig({
      product: 'site',
      web: { url: 'http://localhost:3000', screens: [{ name: 'the front page', url: '/' }, { name: 'pricing', url: '/pricing' }] },
    });
    assert.equal(config.app.kind, 'web');
    assert.deepEqual(config.screens.map((s) => s.name), ['the front page', 'pricing']);
    assert.deepEqual(config.screens[1].steps, [{ goto: '/pricing' }]);
  });

  test('a screen reached by clicking is not carried over as an address', () => {
    // Version 2 walks those by clicking the control that names them. Turning one into an
    // address here would put a screen in the report that nobody can actually reach.
    const config = resolveConfig({
      product: 'site',
      web: { url: 'http://localhost:3000', screens: [{ name: 'the front page', url: '/' }, { name: 'the settings tab' }] },
    });
    assert.deepEqual(config.screens.map((s) => s.name), ['the front page']);
  });

  test('screens already written the version 1 way are never overwritten', () => {
    const config = resolveConfig({
      product: 'site',
      screens: [{ name: 'mine', url: '/mine' }],
      web: { url: 'http://localhost:3000', screens: [{ name: 'theirs', url: '/theirs' }] },
    });
    assert.deepEqual(config.screens.map((s) => s.name), ['mine']);
  });
});

describe('every command in --help, on the settings this tool writes', () => {
  /**
   * Run the CLI and wait for it, whatever it exits with.
   * @param {string[]} args
   * @param {string} cwd
   */
  const cli = (args, cwd) => new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd, env: { ...process.env, NO_COLOR: '1' }, timeout: 120_000 },
      (error, stdout, stderr) => resolve({
        code: error && typeof (/** @type {any} */ (error).code) === 'number' ? /** @type {any} */ (error).code : 0,
        out: String(stdout) + String(stderr),
      }),
    );
  });

  /** A project set up exactly the way `staysfixed init` sets one up. */
  const setUp = async () => {
    const dir = await scratchDir('staysfixed-v2-settings');
    await fsp.writeFile(path.join(dir, 'staysfixed.config.mjs'), [
      'export default {',
      '  product: "lint-lens",',
      '  source: { folders: ["src"] },',
      '  process: { commands: [{ name: "lint-lens --help", run: "python3 -m lint_lens.cli --help" }] },',
      '};',
      '',
    ].join('\n'));
    return dir;
  };

  test('status, flake, mark, trace and approve all run, and none of them mentions a key nobody wrote', async () => {
    const dir = await setUp();
    for (const args of [['status'], ['flake'], ['mark', 'v0.1.0'], ['trace'], ['approve']]) {
      const { code, out } = await cli(args, dir);
      assert.equal(code, 0, `\`staysfixed ${args.join(' ')}\` refused to run on the settings this tool writes:\n${out}`);
      assert.doesNotMatch(out, /do not name anything to open/, `\`${args[0]}\` is still refusing over a screen it never needed`);
      assert.doesNotMatch(out, /app: \{ kind:/, `\`${args[0]}\` is still telling somebody to add a key version 2 never writes`);
    }
  });

  test('status says what these settings actually cover, instead of four zeroes', async () => {
    const { out } = await cli(['status'], await setUp());
    // "0 approved pictures, 0 screens, 0 guards, 0 markers" is every word of it true and
    // together reads as "nothing is set up" about a project whose settings name a command
    // and a folder of source.
    assert.match(out, /1 command to run and compare word for word/);
    assert.match(out, /the code in src/);
  });

  test('trace refuses a project with no screen by saying why, not by naming a setting', async () => {
    const { code, out } = await cli(['trace'], await setUp());
    assert.equal(code, 0);
    assert.match(out, /no screen in this project to trace/);
    // The generic ending told somebody to pin a good version — which, on a project that had
    // just pinned one, was advice they had already followed thirty seconds earlier.
    assert.doesNotMatch(out, /Pin a good version first/);
  });

  test('walk still refuses, and the refusal names this project rather than a missing key', async () => {
    const { code, out } = await cli(['walk'], await setUp());
    assert.equal(code, 2, 'a project with no screen genuinely cannot be walked');
    assert.match(out, /photographs a screen, and this project has none/);
    assert.match(out, /commands to run/, 'it has to say what this project IS');
    assert.doesNotMatch(out, /app: \{ kind:/);
  });
});
