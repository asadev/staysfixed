/**
 * The headline test.
 *
 * The fixture app exists to be as awkward as a real one: a clock ticking ten
 * times a second, a relative timestamp, an endless CSS spinner, a Web Animations
 * tween, a shuffled list, a random number, a random uuid, a chart of random
 * bars, a blinking caret, an autofocused input, a web font, an image that
 * arrives late, and a feed the server deliberately answers differently every
 * single time it is asked.
 *
 * Photograph that twenty times and every picture must be byte-for-byte the same.
 * If this test fails, the tool is broken — a check that cries wolf is worse than
 * no check at all, and nothing else in this suite matters until it is green.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { settingsForScreen, loadProject } from '../src/core/config.js';
import { launchApp } from '../src/drive/launch.js';
import { captureScreen } from '../src/picture/capture.js';
import { sha256 } from '../src/core/hash.js';
import { copyFixture, startFixture, cleanUp, haveChrome, NO_BROWSER } from './support.mjs';

const HOW_MANY = 20;

/** Photographing twenty screens plus two cold browser starts needs room. */
const PLENTY = 300_000;

describe('the unstable app photographs the same every time', { skip: haveChrome() ? false : NO_BROWSER }, () => {
  /** @type {{url: string, close: () => Promise<void>}} */
  let server;
  /** @type {import('../src/types.js').Project} */
  let project;
  /** @type {import('../src/types.js').LaunchedApp} */
  let app;
  /** @type {string} */
  let dir;

  before(async () => {
    dir = await copyFixture();
    server = await startFixture(dir);
    project = await loadProject({ cwd: dir });
    app = await launchApp(project);
  });

  after(async () => {
    if (app) await app.close().catch(() => {});
    if (server) await server.close().catch(() => {});
    await cleanUp();
  });

  test(`${HOW_MANY} pictures of the front page are identical`, { timeout: PLENTY }, async () => {
    const screen = project.config.screens[0];
    assert.equal(screen.name, 'home');
    const settings = settingsForScreen(project.config, screen);

    /** @type {string[]} */
    const fingerprints = [];
    /** @type {import('../src/types.js').CaptureReport|null} */
    let first = null;

    for (let take = 1; take <= HOW_MANY; take += 1) {
      const shot = await captureScreen(app.page, screen, settings, {
        fixturesDir: project.paths.fixtures,
        record: false,
      });
      if (!first) first = shot;
      fingerprints.push(sha256(shot.png));
    }

    assert.ok(first, 'no picture was taken at all');
    // A blank or collapsed page would also be identical twenty times, which
    // would make this test pass while proving nothing.
    assert.equal(first.width, 900);
    assert.equal(first.height, 640);
    assert.ok(first.png.length > 5000, 'the picture is suspiciously small — is the page empty?');
    // A browser asking for a favicon the fixture does not serve is noise, not a
    // fault in the page.
    const realErrors = first.consoleErrors.filter((line) => !/favicon/.test(line));
    assert.deepEqual(realErrors, []);

    const different = new Set(fingerprints);
    const takes = [...different].map((f) => fingerprints.indexOf(f) + 1);
    assert.equal(
      different.size,
      1,
      `the same screen photographed ${HOW_MANY} times produced ${different.size} different pictures ` +
        `(first seen on takes ${takes.join(', ')}). Something on the page is still moving.`,
    );
  });

  test('the other two screens hold still as well', { timeout: PLENTY }, async () => {
    for (const screen of project.config.screens.slice(1)) {
      const settings = settingsForScreen(project.config, screen);
      /** @type {string[]} */
      const fingerprints = [];
      for (let take = 0; take < 4; take += 1) {
        const shot = await captureScreen(app.page, screen, settings, {
          fixturesDir: project.paths.fixtures,
          record: false,
        });
        fingerprints.push(sha256(shot.png));
      }
      assert.equal(new Set(fingerprints).size, 1, `${screen.name} did not photograph the same four times`);
    }
  });

  test('the three screens are genuinely different pictures', { timeout: PLENTY }, async () => {
    /** @type {Map<string,string>} */
    const byName = new Map();
    for (const screen of project.config.screens) {
      const settings = settingsForScreen(project.config, screen);
      const shot = await captureScreen(app.page, screen, settings, {
        fixturesDir: project.paths.fixtures,
        record: false,
      });
      byName.set(screen.name, sha256(shot.png));
    }
    assert.equal(new Set(byName.values()).size, byName.size, `two screens photographed the same: ${[...byName]}`);
  });

  test('a cold browser takes the same picture as a warm one', { timeout: PLENTY }, async () => {
    const screen = project.config.screens[0];
    const settings = settingsForScreen(project.config, screen);

    const warm = sha256(
      (await captureScreen(app.page, screen, settings, { fixturesDir: project.paths.fixtures, record: false })).png,
    );

    // A whole new browser process, started from nothing. This is what a run on a
    // build machine looks like, and it is where window geometry, the font cache
    // and first-paint rasterisation get their chance to differ.
    const second = await launchApp(project);
    try {
      const cold = sha256(
        (await captureScreen(second.page, screen, settings, { fixturesDir: project.paths.fixtures, record: false }))
          .png,
      );
      assert.equal(cold, warm, 'a freshly started browser photographed the same screen differently');
    } finally {
      await second.close().catch(() => {});
    }
  });

  test('captureOne hands back the same picture the capture loop takes', { timeout: PLENTY }, async (t) => {
    const run = await import('../src/run.js').catch(() => null);
    if (!run || typeof run.captureOne !== 'function') {
      t.skip('captureOne is not available, so it could not be checked against the capture loop.');
      return;
    }

    const screen = project.config.screens[0];
    const settings = settingsForScreen(project.config, screen);
    const direct = sha256(
      (await captureScreen(app.page, screen, settings, { fixturesDir: project.paths.fixtures, record: false })).png,
    );

    const shot = await run.captureOne(project, 'home', {});
    assert.equal(sha256(shot.png), direct, 'captureOne took a different picture from the capture loop');
  });
});
