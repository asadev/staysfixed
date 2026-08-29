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
    assert.match(String(seen.meta?.describe), /took half a minute|took a minute or so|took several seconds/);
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
