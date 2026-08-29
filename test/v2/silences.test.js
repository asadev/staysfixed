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
