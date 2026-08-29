/**
 * The failure this whole tool exists for.
 *
 * The fixture app has a `?broken=1` address that serves the same page with the
 * stylesheet taken out. Every button still clicks, every element is still in the
 * document, and a behaviour suite of any size stays green. Only a picture
 * notices — so this test approves the picture, breaks the page in exactly that
 * way, and insists the run goes red with something to look at.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { PNG } from 'pngjs';

import { loadProject } from '../src/core/config.js';
import { runCheck, approveScreens } from '../src/run.js';
import { approvedPicture } from '../src/core/paths.js';
import { copyFixture, startFixture, cleanUp, haveChrome, NO_BROWSER } from './support.mjs';

const PLENTY = 300_000;

describe('a picture check catches what behaviour tests cannot', { skip: haveChrome() ? false : NO_BROWSER }, () => {
  /** @type {{url: string, close: () => Promise<void>}} */
  let server;
  /** @type {import('../src/types.js').Project} */
  let project;

  before(async () => {
    const dir = await copyFixture();
    server = await startFixture(dir);
    project = await loadProject({ cwd: dir });
  });

  after(async () => {
    if (server) await server.close().catch(() => {});
    await cleanUp();
  });

  test('the whole loop: new, approved, passing, then broken', { timeout: PLENTY }, async () => {
    // 1. Nothing has ever been approved, so nothing is a pass yet. A tool that
    //    called an unseen screen "green" would be lying about what it knows.
    const first = await runCheck(project, { quiet: true, writeReport: false });
    assert.equal(first.ok, false);
    assert.equal(first.pictures.length, 3);
    assert.deepEqual(
      first.pictures.map((p) => p.status),
      ['new', 'new', 'new'],
    );
    assert.match(String(first.pictures[0].message), /staysfixed approve home/);
    assert.equal(first.guards.length, 1);
    assert.equal(first.guards[0].status, 'passed');

    // 2. A person looks at them and says yes.
    const said = await approveScreens(project, [], { all: true });
    assert.deepEqual(said.approved.sort(), ['details', 'home', 'home-scrolled']);
    assert.deepEqual(said.skipped, []);

    const approved = approvedPicture(project.paths, 'home');
    const meta = JSON.parse(await fsp.readFile(approved.json, 'utf8'));
    assert.equal(meta.name, 'home');
    assert.equal(meta.width, 900);
    assert.equal(meta.height, 640);
    assert.equal(meta.describe, 'the front page, with the clock, the chart and the feed');

    // 3. Nothing has changed, so the same pages must still match.
    const second = await runCheck(project, { quiet: true, writeReport: false });
    assert.equal(second.ok, true, second.pictures.map((p) => `${p.name}: ${p.message}`).join(' / '));
    assert.deepEqual(
      second.pictures.map((p) => p.status),
      ['passed', 'passed', 'passed'],
    );
    assert.equal(second.pictures[0].diffPixels, 0);

    // 4. Now take the stylesheet away. Nothing about the page's behaviour moves.
    const home = project.config.screens.find((s) => s.name === 'home');
    assert.ok(home);
    home.steps = [{ goto: '/?broken=1' }];

    const third = await runCheck(project, { quiet: true, writeReport: false });
    assert.equal(third.ok, false, 'losing the whole stylesheet must not be a pass');

    const result = third.pictures.find((p) => p.name === 'home');
    assert.ok(result);
    assert.equal(result.status, 'changed');
    assert.ok(
      typeof result.diffPixels === 'number' && result.diffPixels > 1000,
      `only ${result.diffPixels} pixels moved`,
    );
    assert.match(String(result.message), /looks different/);
    assert.match(String(result.message), /staysfixed approve home/);

    // The guard still passes, and so do the screens nobody broke — which is the
    // whole point: one screen went red and the report says which.
    assert.equal(third.guards[0].status, 'passed');
    assert.equal(third.pictures.find((p) => p.name === 'details')?.status, 'passed');

    // 5. There has to be something a person can actually look at.
    assert.ok(result.diffPath, 'a changed screen must leave a difference picture behind');
    const diff = PNG.sync.read(await fsp.readFile(String(result.diffPath)));
    assert.equal(diff.width, 900);
    assert.equal(diff.height, 640);

    // The new picture is kept too, so `approve` has something to promote if the
    // new look turns out to be the wanted one.
    assert.ok(result.actualPath);
    assert.ok((await fsp.stat(String(result.actualPath))).size > 0);

    // 6. And the approved picture is untouched — a check never quietly rewrites
    //    the thing it is checking against.
    const stillThere = JSON.parse(await fsp.readFile(approved.json, 'utf8'));
    assert.equal(stillThere.sha256, meta.sha256);
  });

  test('the deliberate break is put back, and the screen passes again', { timeout: PLENTY }, async () => {
    const home = project.config.screens.find((s) => s.name === 'home');
    assert.ok(home);
    home.steps = [{ goto: '/' }];

    const run = await runCheck(project, { quiet: true, writeReport: false });
    assert.equal(run.ok, true, run.pictures.map((p) => `${p.name}: ${p.message}`).join(' / '));
    assert.deepEqual(
      run.pictures.map((p) => p.status),
      ['passed', 'passed', 'passed'],
    );
  });
});

describe('one screen on its own agrees with the whole run', { skip: haveChrome() ? false : NO_BROWSER }, () => {
  /** @type {{url: string, close: () => Promise<void>}} */
  let server;
  /** @type {import('../src/types.js').Project} */
  let project;

  before(async () => {
    const dir = await copyFixture();
    server = await startFixture(dir);
    project = await loadProject({ cwd: dir });
  });

  after(async () => {
    if (server) await server.close().catch(() => {});
    await cleanUp();
  });

  test('a picture approved from a single-screen run still matches a full one', { timeout: PLENTY }, async () => {
    // Somebody fixes the details page, runs `staysfixed check details`, looks at
    // it and approves it. Tomorrow the whole suite runs. The picture must still
    // match — if the position of a screen in the run changes how it is
    // photographed, every approval is a coin toss.
    const alone = await runCheck(project, { only: ['details'], quiet: true, writeReport: false });
    assert.equal(alone.pictures[0].status, 'new');
    await approveScreens(project, ['details']);

    const everything = await runCheck(project, { quiet: true, writeReport: false });
    const details = everything.pictures.find((p) => p.name === 'details');
    assert.ok(details);
    assert.equal(
      details.status,
      'passed',
      `details was approved on its own and then looked different in a full run: ${details.message}`,
    );
  });
});
