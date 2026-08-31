/**
 * The silences — the class of bug that matters more than every other class put together.
 *
 * A difference machine has exactly one way to be catastrophically wrong, and it is not
 * reporting something that turns out to be fine. It is reporting NOTHING while something is
 * broken, because that answer is indistinguishable from the answer it gives when everything
 * really is fine, and the more this tool is trusted the more a clean run will be believed
 * without being read.
 *
 * Every test in this file was written on 2026-08-30 against a real defect found by reading
 * the whole of src/v2 looking for the same shape as the one that had already bitten: the
 * source reader silently skipping a 3.5MB bundle and then reporting that it had found no
 * source at all. Each one fails on the code as it was that morning.
 *
 * They are deliberately small and they are deliberately about the mechanism rather than the
 * end-to-end run: the corpus in src/v2/selfcheck.js proves the whole engine still catches
 * things, and this file proves the individual pieces cannot go quiet.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { howLongItTook, trimForStorage, NOT_COVERED_MEANING } from '../../src/v2/adapters/contract.js';
import { check } from '../../src/v2/check.js';
import { classify } from '../../src/v2/sealed.js';
import { proveCause } from '../../src/v2/cause.js';
import { subtractWobble, wobbleStorm } from '../../src/v2/observation.js';
import { duplicateGaps } from '../../src/v2/run.js';
import { readFileRoutes } from '../../src/v2/adapters/source.js';
import { journeysFrom, readPageRoutes } from '../../src/v2/adapters/web.js';
import { asAddress, readMeaning } from '../../src/v2/adapters/electron.js';
import { declaredObservations, findAppBundle, iosAdapter, readDeclaredDoors } from '../../src/v2/adapters/ios.js';

const run = promisify(execFile);

describe('a value too big to store cannot go quiet in the middle', () => {
  /**
   * Text with a distinct head, a distinct tail, and a middle that can be changed.
   * @param {string} middle
   * @returns {string}
   */
  const bigText = (middle) => `${'head line\n'.repeat(4000)}${middle}\n${'tail line\n'.repeat(4000)}`;

  test('a change in the discarded middle still changes the stored value', () => {
    const before = trimForStorage(bigText('row 3000: ok'));
    const after = trimForStorage(bigText('row 3000: could not be loaded at all'));

    assert.equal(before.truncated, true, 'the fixture has to be big enough to actually be trimmed, or this test proves nothing');
    assert.notEqual(
      before.text,
      after.text,
      'a break in the middle of a big output used to leave a byte-identical record, so the run reported that nothing had changed',
    );
  });

  test('it says exactly how many bytes it threw away, not a rough bucket', () => {
    const kept = trimForStorage(bigText('row 3000: ok'));
    assert.match(kept.text, /exactly \d+ bytes left out of the middle of \d+/);
  });

  test('a middle that changes without changing length is a hole, and the hole is not hidden', () => {
    // This is the honest limit, asserted so nobody later mistakes it for a promise. Only the
    // length survives normalisation; a digest of the whole text cannot be taken here because
    // the rules that rub out clocks and ids run afterwards, on the two ends.
    const before = trimForStorage(bigText('row 3000: aaa'));
    const after = trimForStorage(bigText('row 3000: bbb'));
    assert.equal(before.text, after.text, 'documented limit: same length, same record');
    assert.equal(before.truncated, true, 'and the caller marks a truncated value as not fully covered, so the gap is stated');
  });
});

describe('how long something took is recorded and never compared', () => {
  test('two runs that differ wildly in speed record the identical value', () => {
    const quick = howLongItTook({ channel: 'counters', path: 'count.build.duration', ms: 40, what: 'the build' });
    const slow = howLongItTook({ channel: 'counters', path: 'count.build.duration', ms: 40_000, what: 'the build' });

    assert.deepEqual(
      quick.value,
      slow.value,
      'a stopwatch on a shared machine measures the machine; comparing it made the self-check fail one case in nine on a busy laptop',
    );
  });

  test('the measurement is still there to read, in the sentence', () => {
    const seen = howLongItTook({ channel: 'counters', path: 'count.build.duration', ms: 40_000, what: 'the build' });
    // The bucket, not the word "took": the sentence stopped saying "took" on 2026-08-31
    // because two of the rungs read wrong behind it ("took quick", "took instant") and this
    // sentence is printed at a person. What this test is about is that the measurement is
    // still there to read, and it is.
    assert.match(String(seen.meta?.describe), /half a minute|a minute or so|several seconds/);
    assert.match(String(seen.meta?.describe), /^the build[:.]/, 'the thing measured has to be named before the measurement');
  });

  test('it counts as missing coverage rather than as a pass', () => {
    const seen = howLongItTook({ channel: 'counters', path: 'count.build.duration', ms: 40, what: 'the build' });
    assert.equal(seen.meta?.refused, true);
    assert.match(String(seen.meta?.refusedWhy), /measures the machine/);
    assert.ok(NOT_COVERED_MEANING['measures the machine'], 'the reason has to be in the counted vocabulary, not free text');
  });
});

describe('a check that cannot tell one build from another refuses instead of passing', () => {
  test('a folder with no git in it is blocked, not cleared', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-nogit-'));
    try {
      await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'widget', version: '1.0.0', type: 'module' }));
      await fsp.writeFile(path.join(dir, 'cli.js'), "console.log('hello');\n");
      await fsp.writeFile(
        path.join(dir, 'journeys.json'),
        JSON.stringify([
          { name: 'run-it', describe: 'Run it once.', source: 'code', surface: 'cli', steps: [{ act: 'run', run: 'node cli.js' }] },
        ]),
      );

      const outcome = await check({ cwd: dir, journeys: path.join(dir, 'journeys.json'), only: [] });

      assert.equal(outcome.blocked, true, 'without git every build carries the same id, so a check would compare a build against itself and always come back clean');
      assert.equal(outcome.ok, false);
      assert.match(outcome.summary, /not a git repository/i);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('asking for a journey that does not exist is a stated hole, not a quiet clean run', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-only-'));
    try {
      await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'widget', version: '1.0.0', type: 'module' }));
      await fsp.writeFile(path.join(dir, 'cli.js'), "console.log('hello');\n");
      await fsp.writeFile(
        path.join(dir, 'journeys.json'),
        JSON.stringify([
          { name: 'run-it', describe: 'Run it once.', source: 'code', surface: 'cli', steps: [{ act: 'run', run: 'node cli.js' }] },
        ]),
      );
      await run('git', ['init', '-q'], { cwd: dir });
      await run('git', ['config', 'user.email', 'test@staysfixed.local'], { cwd: dir });
      await run('git', ['config', 'user.name', 'test'], { cwd: dir });
      await run('git', ['add', '-A'], { cwd: dir });
      await run('git', ['commit', '-q', '-m', 'first'], { cwd: dir });

      const outcome = await check({ cwd: dir, journeys: path.join(dir, 'journeys.json'), only: ['a-journey-that-is-not-there'] });

      // Either it refuses outright or it says so in the coverage. What it must never do is
      // walk nothing and report that nothing has changed.
      const said = `${outcome.summary} ${(outcome.coverage?.gaps ?? []).map((g) => `${g.what} ${g.why}`).join(' ')}`;
      assert.match(said, /a-journey-that-is-not-there|nothing to walk|could not be run/i);
      assert.equal(outcome.ok, false, 'a run that walked nothing is not a pass');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The second sweep, 2026-08-30. Five more places where a silence could pass for
// an all-clear, each one found by reading src/v2 with the first five in mind.
// ---------------------------------------------------------------------------

describe('the unwaivable classes are decided from the whole finding, not the top of it', () => {
  /**
   * A cluster of `count` addresses where exactly one — deliberately deep in the list —
   * is about money.
   * @param {number} count
   * @param {number} at
   * @returns {any}
   */
  const bigCluster = (count, at) => ({
    id: 'f-big',
    title: 'A lot of addresses changed at once',
    why: 'One cluster.',
    class: 'ordinary',
    rank: 1,
    signature: 'many',
    differences: Array.from({ length: count }, (_, i) => ({
      path: `api.GET./row${i}.body`,
      channel: 'results',
      kind: 'changed',
      journey: 'a walk',
      reference: i === at ? { refund: '12.00' } : { row: i },
      candidate: i === at ? { refund: '0.00' } : { row: i },
    })),
  });

  test('a refund buried at address 150 of 300 still seals the finding', () => {
    const verdict = classify(bigCluster(300, 150), { trustEngine: false });
    assert.ok(
      verdict,
      'until 2026-08-30 only the first 80 differences were read, so this came back ordinary — waivable by an agent, and it would never have reached a person',
    );
    assert.equal(verdict?.class, 'money');
  });

  test('and it is the same answer whether it sits at address 1 or address 299', () => {
    assert.equal(classify(bigCluster(300, 1), { trustEngine: false })?.class, 'money');
    assert.equal(classify(bigCluster(300, 299), { trustEngine: false })?.class, 'money');
  });
});

describe('a causal proof covers every address in the finding it clears', () => {
  test('five addresses going away does not prove three hundred did', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-cause-test-'));
    try {
      await fsp.writeFile(path.join(dir, 'app.js'), 'export const answer = 1;\n');
      await run('git', ['init', '-q'], { cwd: dir });
      await run('git', ['config', 'user.email', 'test@staysfixed.local'], { cwd: dir });
      await run('git', ['config', 'user.name', 'test'], { cwd: dir });
      await run('git', ['add', '-A'], { cwd: dir });
      await run('git', ['commit', '-q', '-m', 'first'], { cwd: dir });
      // The one uncommitted change, which is what will be undone.
      await fsp.writeFile(path.join(dir, 'app.js'), 'export const answer = 2;\n');

      const total = 12;
      const healed = 5;
      /** @type {any} */
      const finding = {
        id: 'f-1',
        title: 'Twelve addresses changed',
        why: 'One cluster.',
        class: 'ordinary',
        rank: 1,
        nearFiles: ['app.js'],
        differences: Array.from({ length: total }, (_, i) => ({
          path: `cli.row${i}.value`,
          channel: 'results',
          kind: 'changed',
          journey: 'the walk',
          reference: 'was',
          candidate: 'now',
        })),
      };

      // With the change undone, only the first five addresses go back to what they were.
      // The other seven are still wrong, so this change explains part of the finding at most.
      const proof = await proveCause(finding, {
        cwd: dir,
        journeys: [/** @type {any} */ ({ name: 'the walk', describe: 'the walk', surface: 'cli', steps: [] })],
        candidate: /** @type {any} */ ({ id: 'candidate' }),
        walk: async () =>
          /** @type {any} */ ({
            id: 'without',
            journey: 'the walk',
            build: { id: 'without' },
            observations: Array.from({ length: total }, (_, i) => ({
              path: `cli.row${i}.value`,
              channel: 'results',
              value: i < healed ? 'was' : 'now',
            })),
          }),
      });

      assert.equal(
        proof.verdict,
        'not caused by that change',
        'it used to re-check only the first five addresses and then say the whole finding was explained, which is a machine-checked reason for an agent to wave the rest of a break through',
      );
      assert.equal(proof.checked, total, 'every address in the finding has to be re-checked, not a sample of them');
      assert.equal(proof.disappeared, healed);
      assert.equal(proof.escalates, true);
      assert.match(proof.what, /5 of the 12|part of this/);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('a wobble big enough to swallow the comparison is not a clean run', () => {
  /**
   * @param {number} unstable
   * @param {number} steady
   * @returns {any}
   */
  const wobbleOf = (unstable, steady) => ({
    buildId: 'new',
    journey: '*',
    runs: ['a', 'b'],
    entries: Array.from({ length: unstable }, (_, i) => ({
      path: `cli.row${i}.value`,
      channel: 'results',
      kind: 'vanished',
      a: i,
      distance: 1,
    })),
    unstable: Array.from({ length: unstable }, (_, i) => `cli.row${i}.value`),
    steady,
    measured: true,
  });

  test('a handful of unsteady addresses is an ordinary product and says nothing', () => {
    const storm = wobbleStorm(wobbleOf(3, 300));
    assert.equal(storm.stormy, false);
  });

  test('a second run that fell over takes the verdict with it', () => {
    const differences = Array.from({ length: 40 }, (_, i) => ({
      path: `cli.row${i}.value`,
      channel: /** @type {const} */ ('results'),
      kind: /** @type {const} */ ('changed'),
      journey: 'the walk',
      reference: 'was',
      candidate: 'now',
      distance: 1,
    }));
    const out = subtractWobble(differences, wobbleOf(90, 10));

    assert.equal(out.real.length, 0, 'the fixture has to actually swallow everything, or this proves nothing');
    assert.equal(
      out.couldNotTell,
      true,
      'every difference was dropped as noise because the same build answered differently at 90 of its 100 addresses — that is a run that went wrong, and it used to come back as a clean one',
    );
    assert.match(String(out.couldNotTellWhy), /90 of the 100|not a product wobbling/);
    assert.match(out.note, /no answer|not a pass/i);
  });

  test('a build that is only unsteady about a third of itself still gets a verdict', () => {
    const out = subtractWobble([], wobbleOf(30, 70));
    assert.notEqual(out.couldNotTell, true);
  });

  test('ten of eleven addresses wobbling is a storm, floor or no floor', () => {
    // There used to be a floor: below twelve addresses the share was ignored altogether, so a
    // journey that threw ten of its eleven addresses away came back clean about the one that
    // was left. Small is not the same as unmeasurable.
    const differences = Array.from({ length: 10 }, (_, i) => ({
      path: `cli.row${i}.value`,
      channel: /** @type {const} */ ('results'),
      kind: /** @type {const} */ ('changed'),
      journey: 'the walk',
      reference: 'was',
      candidate: 'now',
      distance: 1,
    }));
    const out = subtractWobble(differences, wobbleOf(10, 1));
    assert.equal(out.real.length, 0, 'the fixture has to actually swallow everything, or this proves nothing');
    assert.equal(out.couldNotTell, true, 'ten differences were dropped and one address was compared — that is not a pass');
  });

  test('three of four is one too, because it leaves a single address standing', () => {
    assert.equal(wobbleStorm(wobbleOf(3, 1)).stormy, true);
  });

  test('half wobbling still gets a verdict — half of the comparison survived', () => {
    assert.equal(wobbleStorm(wobbleOf(6, 6)).stormy, false);
  });
});

describe('two answers at one address are a hole, not a quiet overwrite', () => {
  test('the second answer is named, because nothing will ever compare it', () => {
    /** @type {any} */
    const journey = { name: 'the walk', describe: 'the walk', surface: 'cli', steps: [] };
    const gaps = duplicateGaps(
      /** @type {any} */ ([
        { path: 'log.app.said', channel: 'complaints', value: 'starting up' },
        { path: 'log.app.said', channel: 'complaints', value: 'could not reach the database' },
      ]),
      journey,
    );
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].what, /log\.app\.said/);
    assert.match(gaps[0].why, /could not reach the database/);
  });

  test('the same answer twice hides nothing and is not reported', () => {
    /** @type {any} */
    const journey = { name: 'the walk', describe: 'the walk', surface: 'cli', steps: [] };
    const gaps = duplicateGaps(
      /** @type {any} */ ([
        { path: 'log.app.said', channel: 'complaints', value: 'starting up' },
        { path: 'log.app.said', channel: 'complaints', value: 'starting up' },
      ]),
      journey,
    );
    assert.equal(gaps.length, 0);
  });
});

describe('a folder the route reader cannot open takes every route behind it, and says so', () => {
  test('the routes are missing and the folder is named', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-routes-'));
    try {
      await fsp.mkdir(path.join(dir, 'app', 'orders'), { recursive: true });
      await fsp.mkdir(path.join(dir, 'app', 'locked', 'refunds'), { recursive: true });
      await fsp.writeFile(path.join(dir, 'app', 'orders', 'route.js'), 'export function GET() {}\n');
      await fsp.writeFile(path.join(dir, 'app', 'locked', 'refunds', 'route.js'), 'export function POST() {}\n');
      await fsp.chmod(path.join(dir, 'app', 'locked'), 0o000);

      const reading = await readFileRoutes(dir);
      const names = reading.doors.map((d) => d.name);

      // The point of the test: the refunds route is invisible. That is unavoidable — it cannot
      // be read. What is NOT unavoidable is doing that quietly, which is what it used to do.
      assert.ok(names.includes('/orders'));
      assert.ok(!names.includes('/locked/refunds'));
      assert.equal(reading.problems.length, 1, 'a folder that could not be opened has to be named');
      assert.match(reading.problems[0], /locked/);
      assert.match(reading.problems[0], /invisible/);
    } finally {
      await fsp.chmod(path.join(dir, 'app', 'locked'), 0o755).catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});


describe('a website\'s pages cannot go missing quietly', () => {
  /**
   * A tiny Next-shaped project with four pages, one of them behind a folder this account
   * will not be allowed to open.
   *
   * @returns {Promise<{root: string, locked: string, done: () => Promise<void>}>}
   */
  const project = async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-pages-'));
    for (const where of ['app', 'app/orders', 'app/admin', 'app/admin/settings']) {
      await fsp.mkdir(path.join(root, where), { recursive: true });
      await fsp.writeFile(path.join(root, where, 'page.tsx'), 'export default function P() { return null; }\n');
    }
    const locked = path.join(root, 'app', 'admin');
    return {
      root,
      locked,
      done: async () => {
        await fsp.chmod(locked, 0o755).catch(() => {});
        await fsp.rm(root, { recursive: true, force: true });
      },
    };
  };

  test('a folder that will not open is named, and the pages behind it become missing coverage', async (t) => {
    const { root, locked, done } = await project();
    try {
      await fsp.chmod(locked, 0o000);
      // Running as root, or on a filesystem that ignores permissions, this cannot be set up.
      // Saying so is better than passing on a machine where the fixture did nothing.
      let stillReadable = true;
      try {
        await fsp.readdir(locked);
      } catch {
        stillReadable = false;
      }
      if (stillReadable) return t.skip('this machine can read a folder with no permissions on it, so the hole cannot be made here');

      /** @type {{unreadable: {folder: string, why: string}[]}} */
      const collect = { unreadable: [] };
      const pages = await readPageRoutes(root, collect);

      assert.deepEqual(pages.map((p) => p.url).sort(), ['/', '/orders'], 'the fixture has to actually hide two pages, or this proves nothing');
      assert.equal(collect.unreadable.length, 1, 'the folder was skipped and nothing anywhere said so');
      assert.match(collect.unreadable[0].folder, /admin/);
      assert.match(collect.unreadable[0].why, /permission/i, 'a person has to be able to act on the reason, so it cannot be an error code');

      const journeys = journeysFrom({ config: {}, pages, unreadable: collect.unreadable });
      const hole = journeys.find((j) => j.skip);
      assert.ok(hole, 'the engine turns a journey carrying skip into missing coverage, and that is the only route from here to the ledger');
      assert.match(String(hole.skip), /admin/);
      assert.match(String(hole.skip), /hole, not a pass/);
    } finally {
      await done();
    }
  });

  test('two screens with one name are two screens, and neither is thrown away', () => {
    const journeys = journeysFrom({
      config: {
        screens: [
          { name: 'checkout', url: '/checkout' },
          { name: 'checkout', url: '/checkout/pay' },
        ],
      },
      pages: [],
    });
    assert.equal(journeys.length, 2, 'the second used to overwrite the first in a Map keyed by name, and the loser was never walked and never counted as a gap');
    const opens = journeys.map((j) => /** @type {any[]} */ (j.steps)[0].goto).sort();
    assert.deepEqual(opens, ['/checkout', '/checkout/pay']);
  });

  test('the same screen written down twice really is one screen', () => {
    const journeys = journeysFrom({
      config: {
        screens: [{ name: 'checkout', url: '/checkout' }],
        journeys: [{ name: 'checkout', url: '/checkout' }],
      },
      pages: [],
    });
    assert.equal(journeys.length, 1, 'folding two identical entries together loses nothing; numbering them would walk one screen twice');
  });
});


describe('a desktop control cannot hide a change in its own text', () => {
  /**
   * One control out of Chrome's accessibility tree, with whatever text you give it.
   *
   * @param {string} own
   * @param {string} [name]
   * @returns {any[]}
   */
  const control = (own, name = 'Notes') => [
    { role: { value: 'textbox' }, name: { value: name }, value: { value: own }, properties: [] },
  ];

  test('text that differs only past character 200 does not record identically', () => {
    // It used to be kept as its first two hundred characters and nothing else — no length,
    // no fingerprint — so a total at the end of a long field could change completely and the
    // comparison saw two identical strings.
    const head = 'x'.repeat(200);
    const before = readMeaning(control(`${head}the order total is 10.00`));
    const after = readMeaning(control(`${head}the order total is  0.00`));
    assert.notDeepEqual(before, after, 'two different fields recorded the same string, so the run could only ever say nothing had changed');
    assert.match(String(before[0].state.value), /bytes left out of the middle/, 'what was dropped has to be stated, not implied');
    assert.equal(before[0].trimmed, true, 'the caller reports the remaining hole from this flag');
  });

  test('a change that makes long text longer is caught by the byte count alone', () => {
    const head = 'x'.repeat(300);
    const before = readMeaning(control(head));
    const after = readMeaning(control(`${head}x`));
    assert.notDeepEqual(before, after);
  });

  test('two long paragraphs are two addresses, not one', () => {
    // The name is half of an address, and cutting an address merges two things into one.
    const long = 'y'.repeat(400);
    const one = readMeaning(control('', `${long}one`))[0];
    const two = readMeaning(control('', `${long}two`))[0];
    assert.notEqual(asAddress(one.address), asAddress(two.address));
  });
});


describe('a phone check cannot stop counting without saying so', () => {
  /**
   * A tiny iPhone project: two controls named in the code, one of them behind a folder this
   * account will not be allowed to open.
   *
   * @returns {Promise<{root: string, locked: string, done: () => Promise<void>}>}
   */
  const project = async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-ios-'));
    await fsp.mkdir(path.join(root, 'Sources', 'Secret'), { recursive: true });
    await fsp.writeFile(path.join(root, 'Sources', 'App.swift'), 'Button().accessibilityIdentifier("saveButton")\n');
    await fsp.writeFile(path.join(root, 'Sources', 'Secret', 'Pay.swift'), 'Button().accessibilityIdentifier("payButton")\n');
    const locked = path.join(root, 'Sources', 'Secret');
    return {
      root,
      locked,
      done: async () => {
        await fsp.chmod(locked, 0o755).catch(() => {});
        await fsp.rm(root, { recursive: true, force: true });
      },
    };
  };

  test('a folder that will not open is named, and the controls behind it are a hole in the ledger', async (t) => {
    const { root, locked, done } = await project();
    try {
      await fsp.chmod(locked, 0o000);
      let stillReadable = true;
      try {
        await fsp.readdir(locked);
      } catch {
        stillReadable = false;
      }
      if (stillReadable) return t.skip('this machine can read a folder with no permissions on it, so the hole cannot be made here');

      const read = await readDeclaredDoors(root);
      assert.deepEqual(read.doors.map((d) => d.id), ['saveButton'], 'the fixture has to actually hide a control, or this proves nothing');
      assert.equal(read.limits.length, 1);
      assert.match(read.limits[0], /Secret/);
      assert.match(read.limits[0], /permission/i);

      // The count of declared controls is the denominator the ledger measures a walk against,
      // so a search that quietly missed a folder flatters every run made with it.
      const holes = declaredObservations(
        /** @type {any} */ ({
          bundleId: 'com.example.app', name: 'App', version: '1.0', build: '1', minimumOS: '15.0',
          deviceFamilies: ['iPhone'], urlSchemes: [], permissions: [], backgroundModes: [],
        }),
        read.doors,
        'what-the-app-declares',
        read.limits,
      ).filter((o) => o.meta?.refused === true);
      assert.equal(holes.length, 1, 'a limit that changed the answer has to reach the coverage ledger, not only a sentence');
      assert.match(String(holes[0].meta?.describe), /Secret/);
    } finally {
      await done();
    }
  });

  test('stopping at the limit, or at a depth, is said out loud', async () => {
    const { root, done } = await project();
    try {
      assert.match((await readDeclaredDoors(root, { limit: 0 })).limits.join(' '), /stopped after 0 named controls/);
      assert.match((await readDeclaredDoors(root, { deepest: 0 })).limits.join(' '), /not looked in/);
      assert.deepEqual((await readDeclaredDoors(root)).limits, [], 'a search that finished has nothing to report, or every run cries wolf');
    } finally {
      await done();
    }
  });

  test('"no built app was found" says where the search stopped', async () => {
    const { root, done } = await project();
    try {
      const found = await findAppBundle(root);
      assert.equal(found.ok, false);
      // Nothing was in the way here, so there is nothing to add. The point of the field is
      // that when something IS in the way, the sentence changes.
      assert.deepEqual(found.limits, []);
      const shallow = await findAppBundle(root, {});
      assert.equal(shallow.ok, false);
      assert.doesNotMatch(shallow.why, /Where this search stopped/);
    } finally {
      await done();
    }
  });

  test('the app\'s own interface tests are not offered a setting that does not exist', async (t) => {
    if (process.platform !== 'darwin') return t.skip('detect stops before this on a machine that cannot run an iPhone app at all');
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-ios-tests-'));
    try {
      await fsp.mkdir(path.join(root, 'AppUITests'), { recursive: true });
      await fsp.writeFile(
        path.join(root, 'AppUITests', 'LoginTests.swift'),
        'import XCTest\nclass LoginTests: XCTestCase { func testSignIn() { let app = XCUIApplication(); app.launch() } }\n',
      );
      const found = await iosAdapter.detect(/** @type {any} */ ({ root, config: {} }));
      const about = found.missing.find((m) => /interface test/.test(m.what));
      if (!about) return t.skip('this machine cannot run an iPhone app at all, so detect never gets as far as the tests');
      // It used to end "put {"suite": {"scheme": "..."}} under "ios" in the settings and they
      // become journeys". Nothing anywhere read that setting. Somebody following the sentence
      // would have written it, seen the identical message next run, and had no way to tell
      // whether the tool or their spelling was at fault.
      assert.doesNotMatch(String(about.howToGet), /under "ios" in the settings/, 'a setting nothing reads must not be advertised');
      assert.match(String(about.howToGet), /nothing to switch on/i);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe('a proof that measured nothing does not get to sound like one that did', () => {
  /**
   * Measured on 2026-08-31, by somebody using the tool as a stranger on a real website.
   *
   * `staysfixed prove <finding> --revert <file>` was asked about a one-line heading change
   * that had definitely caused the finding, and answered "Your edit did not cause this, so
   * fixing that file will not help." Two controls settle what that sentence was worth:
   * naming a completely unrelated file produced the word-for-word identical denial, and the
   * other half of the same edit came back PROVEN. It returned in five seconds on a project
   * where a real check takes eleven to twenty minutes, and the run log recorded zero server
   * starts. It had not re-run anything at all.
   *
   * The cause was already written down in the code. `cannot()` in src/v2/cause.js carries a
   * comment saying "not proven either way is not the same as proven innocent, and it must
   * never be reported as if it were" — and `toolProve` in src/v2/mcp/tools.js branched on
   * `gone === true`, so everything that was not a proof, including "could not test", got the
   * confident denial. Three genuinely different outcomes, two sentences, and the missing one
   * was the only one that was not an answer.
   */

  /**
   * A git project with exactly one uncommitted change in it.
   *
   * @param {string} edited  What app.js is changed to. Leave it as the committed text and
   *                         there is nothing to undo, which is one of the ways this used to
   *                         come back as a confident denial.
   * @returns {Promise<string>}
   */
  async function projectWithOneChange(edited) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-cause-ran-'));
    await fsp.writeFile(path.join(dir, 'app.js'), 'export const answer = 1;\n');
    await run('git', ['init', '-q'], { cwd: dir });
    await run('git', ['config', 'user.email', 'test@staysfixed.local'], { cwd: dir });
    await run('git', ['config', 'user.name', 'test'], { cwd: dir });
    await run('git', ['add', '-A'], { cwd: dir });
    await run('git', ['commit', '-q', '-m', 'the build that worked'], { cwd: dir });
    await fsp.writeFile(path.join(dir, 'app.js'), edited);
    return dir;
  }

  /** @returns {any} */
  const oneFinding = () => ({
    id: 'f-1',
    title: 'the heading changed',
    why: 'One address.',
    class: 'ordinary',
    rank: 1,
    nearFiles: ['app.js'],
    differences: [
      { path: 'cli.head.out', channel: 'results', kind: 'changed', journey: 'the walk', reference: 'was', candidate: 'now' },
    ],
  });

  /** @returns {any} */
  const oneJourney = () => ({ name: 'the walk', describe: 'the walk', surface: 'cli', steps: [] });

  test('a proof that never walked anything says so, and says it in its own sentence', async () => {
    const dir = await projectWithOneChange('export const answer = 1;\n');
    try {
      let walks = 0;
      const proof = await proveCause(oneFinding(), {
        cwd: dir,
        journeys: [oneJourney()],
        candidate: /** @type {any} */ ({ id: 'candidate' }),
        walk: async () => {
          walks += 1;
          throw new Error('this must never be reached: there was no change to undo');
        },
      });

      assert.equal(walks, 0, 'the fixture has to actually reach the give-up path, or this test proves nothing');
      assert.equal(proof.verdict, 'could not test');
      assert.equal(proof.reran, 0, 'nothing was walked again, and the number that says so is what tells a five-second reply from an eleven-minute one');
      assert.equal(proof.checked, 0);
      assert.match(
        proof.what,
        /Nothing was re-run/,
        'the fact has to be in the sentence as well as in the field: src/v2/check.js forwards only the words to the MCP surface, so a fact kept only in a number never reaches the person reading it',
      );
      assert.match(proof.what, /neither cleared nor blamed/, 'it must not read as an acquittal of the file that was named');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('a proof that did walk the journey counts the walking', async () => {
    const dir = await projectWithOneChange('export const answer = 2;\n');
    try {
      const proof = await proveCause(oneFinding(), {
        cwd: dir,
        journeys: [oneJourney()],
        candidate: /** @type {any} */ ({ id: 'candidate' }),
        walk: async () =>
          /** @type {any} */ ({
            id: 'without',
            journey: 'the walk',
            build: { id: 'without' },
            observations: [{ path: 'cli.head.out', channel: 'results', value: 'was' }],
          }),
      });

      assert.equal(proof.verdict, 'caused by that change');
      assert.equal(proof.reran, 1, 'one journey was walked again and the answer rests on it');
      assert.match(proof.what, /1 journey was walked again/, 'a verdict that cost a real re-run should say what it cost');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('a walk that threw halfway does not claim nothing was run', async () => {
    // The catch block in `proveCause` answers with `cannot()` too, and it is reached AFTER a
    // walk may already have happened. Saying "nothing was re-run" there would be its own
    // small lie, of exactly the kind this whole file exists to stop.
    const dir = await projectWithOneChange('export const answer = 2;\n');
    try {
      let walks = 0;
      // The finding has to REACH both journeys, or the second one is filtered out before
      // anything is walked and the throw never happens.
      const across = oneFinding();
      across.differences.push({
        path: 'cli.foot.out', channel: 'results', kind: 'changed',
        journey: 'the second walk', reference: 'was', candidate: 'now',
      });
      const proof = await proveCause(across, {
        cwd: dir,
        journeys: [oneJourney(), { ...oneJourney(), name: 'the second walk' }],
        candidate: /** @type {any} */ ({ id: 'candidate' }),
        walk: async () => {
          walks += 1;
          if (walks > 1) throw new Error('the browser fell over');
          return /** @type {any} */ ({
            id: 'without',
            journey: 'the walk',
            build: { id: 'without' },
            observations: [{ path: 'cli.head.out', channel: 'results', value: 'was' }],
          });
        },
      });

      assert.equal(proof.verdict, 'could not test');
      assert.equal(proof.reran, 1, 'one journey really was walked before it fell over');
      assert.doesNotMatch(proof.what, /Nothing was re-run/, 'a walk did happen, and saying otherwise is the same defect pointing the other way');
      assert.match(proof.what, /1 journey was walked again/);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
