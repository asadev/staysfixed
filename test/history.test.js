/**
 * The flake register.
 *
 * The definition of a flake is the whole argument: a check counts as unreliable
 * only when it changed its mind while the code stood still. Anything looser
 * blames a developer for their own edits, and a tool that does that gets ignored
 * within a week.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { loadHistory, saveHistory, foldRun, condemned, wobbly, clearFlakes } from '../src/core/history.js';
import { scratchDir, cleanUp } from './support.mjs';

after(cleanUp);

/**
 * @param {string|null} sha
 * @param {boolean} [dirty]
 * @returns {import('../src/types.js').GitInfo}
 */
function at(sha, dirty = false) {
  return { sha, shortSha: sha ? sha.slice(0, 7) : null, branch: 'main', dirty, user: 'Someone <s@example.com>' };
}

/**
 * @param {import('../src/types.js').CheckStatus} status
 * @param {boolean} [retriedToPass]
 */
function picture(status, retriedToPass = false) {
  return [{ name: 'home', kind: /** @type {'picture'} */ ('picture'), status, retriedToPass }];
}

const T1 = '2026-08-29T10:00:00.000Z';
const T2 = '2026-08-29T10:05:00.000Z';
const T3 = '2026-08-29T10:10:00.000Z';

describe('what counts as a flake', () => {
  test('a check that flips at the same commit is a flake', () => {
    const first = foldRun({}, picture('passed'), at('abc123'), T1, 2);
    const second = foldRun(first.history, picture('changed'), at('abc123'), T2, 2);

    assert.deepEqual(second.flakedNow, ['home']);
    assert.equal(second.history['picture:home'].flakes, 1);
    assert.equal(second.history['picture:home'].lastFlakeAt, T2);
    assert.equal(second.history['picture:home'].lastFlakeGitSha, 'abc123');
  });

  test('a check that flips after the code changed is not a flake', () => {
    const first = foldRun({}, picture('passed'), at('abc123'), T1, 2);
    const second = foldRun(first.history, picture('changed'), at('def456'), T2, 2);

    assert.deepEqual(second.flakedNow, []);
    assert.equal(second.history['picture:home'].flakes, 0);
    assert.equal(second.history['picture:home'].condemned, undefined);
  });

  test('a flip with uncommitted edits is not a flake either', () => {
    // A dirty tree means the code did move, whatever the sha says.
    const first = foldRun({}, picture('passed'), at('abc123', true), T1, 2);
    const second = foldRun(first.history, picture('changed'), at('abc123', true), T2, 2);
    assert.deepEqual(second.flakedNow, []);
    assert.equal(second.history['picture:home'].flakes, 0);
  });

  test('a flip outside a git repository is not a flake', () => {
    const first = foldRun({}, picture('passed'), at(null), T1, 2);
    const second = foldRun(first.history, picture('changed'), at(null), T2, 2);
    assert.deepEqual(second.flakedNow, []);
  });

  test('a check that only passed on the second photograph is always a flake', () => {
    // No history, no previous commit, nothing to compare with — and it still counts,
    // because the run itself watched it change its mind.
    const run = foldRun({}, picture('passed', true), at('abc123'), T1, 2);
    assert.deepEqual(run.flakedNow, ['home']);
    assert.equal(run.history['picture:home'].flakes, 1);
  });

  test('an undecided status never counts as flipping', () => {
    const first = foldRun({}, picture('passed'), at('abc123'), T1, 2);
    const second = foldRun(first.history, picture('skipped'), at('abc123'), T2, 2);
    const third = foldRun(second.history, picture('new'), at('abc123'), T3, 2);
    assert.deepEqual(second.flakedNow, []);
    assert.deepEqual(third.flakedNow, []);
  });

  test('the same verdict twice at the same commit is not a flake', () => {
    const first = foldRun({}, picture('changed'), at('abc123'), T1, 2);
    const second = foldRun(first.history, picture('changed'), at('abc123'), T2, 2);
    assert.deepEqual(second.flakedNow, []);
    assert.equal(second.history['picture:home'].flakes, 0);
  });

  test('pictures and guards with the same name are counted apart', () => {
    const run = foldRun(
      {},
      [
        { name: 'home', kind: 'picture', status: 'passed' },
        { name: 'home', kind: 'guard', status: 'failed' },
      ],
      at('abc123'),
      T1,
      2,
    );
    assert.equal(run.history['picture:home'].recent.at(-1), 'passed');
    assert.equal(run.history['guard:home'].recent.at(-1), 'failed');
  });
});

describe('condemnation', () => {
  test('a check is condemned the moment it reaches the limit, and announced once', () => {
    let history = foldRun({}, picture('passed'), at('abc123'), T1, 2).history;

    const second = foldRun(history, picture('changed'), at('abc123'), T2, 2);
    assert.deepEqual(second.newlyCondemned, [], 'one flake is not yet a pattern');
    history = second.history;

    const third = foldRun(history, picture('passed'), at('abc123'), T3, 2);
    assert.deepEqual(third.newlyCondemned, ['home']);
    assert.equal(third.history['picture:home'].condemned, true);
    history = third.history;

    // Still condemned, but nobody needs telling twice.
    const fourth = foldRun(history, picture('changed'), at('abc123'), T3, 2);
    assert.deepEqual(fourth.newlyCondemned, []);
    assert.equal(fourth.history['picture:home'].condemned, true);
  });

  test('a project can set its own patience', () => {
    const first = foldRun({}, picture('passed'), at('abc123'), T1, 1);
    const second = foldRun(first.history, picture('changed'), at('abc123'), T2, 1);
    assert.deepEqual(second.newlyCondemned, ['home']);
  });

  test('condemned lists exactly the checks past the limit', () => {
    let history = foldRun(
      {},
      [
        { name: 'home', kind: 'picture', status: 'passed' },
        { name: 'about', kind: 'picture', status: 'passed' },
      ],
      at('abc123'),
      T1,
      1,
    ).history;
    history = foldRun(
      history,
      [
        { name: 'home', kind: 'picture', status: 'changed' },
        { name: 'about', kind: 'picture', status: 'passed' },
      ],
      at('abc123'),
      T2,
      1,
    ).history;

    assert.deepEqual(
      condemned(history).map((e) => e.name),
      ['home'],
    );
  });

  test('wobbly lists everything that has ever flaked, worst first', () => {
    let history = foldRun(
      {},
      [
        { name: 'home', kind: 'picture', status: 'passed', retriedToPass: true },
        { name: 'about', kind: 'picture', status: 'passed', retriedToPass: true },
        { name: 'steady', kind: 'picture', status: 'passed' },
      ],
      at('abc123'),
      T1,
      9,
    ).history;
    history = foldRun(
      history,
      [{ name: 'home', kind: 'picture', status: 'passed', retriedToPass: true }],
      at('abc123'),
      T2,
      9,
    ).history;

    const order = wobbly(history).map((e) => `${e.name}:${e.flakes}`);
    assert.deepEqual(order, ['home:2', 'about:1']);
  });
});

describe('forgiving a check', () => {
  test('clearing a flake wipes the count, the condemnation and the trail', () => {
    let history = foldRun({}, picture('passed'), at('abc123'), T1, 1).history;
    history = foldRun(history, picture('changed'), at('abc123'), T2, 1).history;
    assert.equal(history['picture:home'].condemned, true);

    const cleared = clearFlakes(history, 'home');
    assert.equal(cleared['picture:home'].flakes, 0);
    assert.equal(cleared['picture:home'].condemned, false);
    assert.equal(cleared['picture:home'].lastFlakeAt, undefined);
    assert.equal(cleared['picture:home'].lastFlakeGitSha, undefined);
    // What actually happened is still on the record.
    assert.equal(cleared['picture:home'].runs, 2);
  });

  test('clearing one check leaves the others alone', () => {
    let history = foldRun(
      {},
      [
        { name: 'home', kind: 'picture', status: 'passed', retriedToPass: true },
        { name: 'about', kind: 'picture', status: 'passed', retriedToPass: true },
      ],
      at('abc123'),
      T1,
      1,
    ).history;
    history = clearFlakes(history, 'home');
    assert.equal(history['picture:home'].flakes, 0);
    assert.equal(history['picture:about'].flakes, 1);
  });

  test('clearing something nobody has heard of changes nothing', () => {
    const history = foldRun({}, picture('passed'), at('abc123'), T1, 2).history;
    assert.deepEqual(clearFlakes(history, 'nothing-like-this'), history);
  });
});

describe('the register on disk', () => {
  test('it survives a round trip', async () => {
    const dir = await scratchDir('staysfixed-history');
    const file = path.join(dir, 'deeper', 'history.json');
    const history = foldRun({}, picture('passed'), at('abc123'), T1, 2).history;

    await saveHistory(file, history);
    assert.deepEqual(await loadHistory(file), history);
  });

  test('a missing or damaged register reads as empty rather than exploding', async () => {
    const dir = await scratchDir('staysfixed-history-bad');
    assert.deepEqual(await loadHistory(path.join(dir, 'nothing.json')), {});

    const broken = path.join(dir, 'broken.json');
    await fsp.writeFile(broken, 'not json at all');
    assert.deepEqual(await loadHistory(broken), {});
  });

  test('only the last dozen verdicts are kept, so the file never grows without end', () => {
    /** @type {import('../src/types.js').History} */
    let history = {};
    for (let i = 0; i < 30; i += 1) {
      history = foldRun(history, picture('passed'), at(`sha${i}`), T1, 99).history;
    }
    assert.equal(history['picture:home'].runs, 30);
    assert.equal(history['picture:home'].recent.length, 12);
  });

  test('folding a run does not change the register it was handed', () => {
    const before = foldRun({}, picture('passed'), at('abc123'), T1, 2).history;
    const snapshot = structuredClone(before);
    foldRun(before, picture('changed'), at('abc123'), T2, 2);
    assert.deepEqual(before, snapshot);
  });
});
