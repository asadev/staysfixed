/**
 * The sentence a person is asked to rule on has to describe what actually happened.
 *
 * Found on 2026-09-01, on a real `staysfixed check` against a real product, by watching the
 * live window rather than by reading any of this code. The run printed, as item 2 of 25:
 *
 *     In the doors the code opens, "SessionBar" is there now and was not before.
 *     No agent may wave this through: it touches losing data.
 *     Say whether that deletion is meant to happen.
 *
 * Nothing had been deleted. `SessionBar` had been ADDED. The two lines contradict each other
 * across one line break, and the second one is the sentence the whole escalation exists to
 * put in front of somebody: it is what they read, and it is what they answer.
 *
 * THE CAUSE, and it is worth naming because it is a shape that recurs. A sealed class says
 * what a change TOUCHES — money, signing in, losing data, a crash. It says nothing at all
 * about which WAY the thing moved. `sealedTodo` had one fixed sentence per class, so every
 * data-loss finding was described as a deletion, whether it was an arrival, a departure or a
 * change. The class was doing a job it does not have the information for.
 *
 * There is no way to write this test as a unit test of a sentence: the whole point is that
 * the sentence has to agree with the finding it is attached to, so the check has to run the
 * decision layer and read what came out the other end. That is what these three do.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { decide, readDecisions, rememberCheck, escalationsFor } from '../../src/v2/escalate.js';
import { openStore } from '../../src/v2/store.js';
import { scratchDir, cleanUp } from '../support.mjs';

after(cleanUp);

const PRODUCT = 'demo';

/** @returns {Promise<import('../../src/v2/types.js').Store>} */
async function store() {
  const root = await scratchDir('staysfixed-ruling');
  await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: PRODUCT, version: '1.0.0' }));
  return openStore(root);
}

/**
 * One data-loss finding whose differences all moved the given way.
 *
 * @param {'appeared'|'vanished'|'changed'} kind
 * @param {string} title
 * @returns {any}
 */
function lossFinding(kind, title) {
  const where = 'exports.SessionBar';
  const difference = {
    path: where,
    channel: 'exports',
    kind,
    reference: kind === 'appeared' ? undefined : 'a class',
    candidate: kind === 'vanished' ? undefined : 'a class',
    distance: 0.4,
  };
  return {
    id: 'engine-' + kind,
    title,
    why: '',
    class: 'data-loss',
    sealed: true,
    rank: 1,
    differences: [difference],
    paths: [where],
    sample: difference,
    count: 1,
    nearFiles: [],
    distance: 1,
  };
}

/**
 * @param {import('../../src/v2/types.js').Store} s
 * @param {any} f
 * @returns {Promise<string>} the sentence the person is asked to answer
 */
async function rulingFor(s, f) {
  const decided = decide([f], await readDecisions(s, PRODUCT));
  await rememberCheck(s, {
    product: PRODUCT,
    verdict: {
      runId: 'run-1',
      product: PRODUCT,
      ok: false,
      mode: 'paired',
      reference: { id: 'git-old', product: PRODUCT },
      candidate: { id: 'work-new', product: PRODUCT },
      findings: [f],
      differencesReal: 1,
      differencesNoise: 0,
      newlyUnstable: [],
      coverage: { paths: 10, journeys: 1, byChannel: {}, gaps: [] },
      summary: 'Something changed.',
      durationMs: 1,
      startedAt: '2026-09-01T00:00:00.000Z',
    },
    decided,
  });
  const book = await escalationsFor(s, PRODUCT);
  const sealed = book.items.find((i) => i.kind === 'sealed');
  assert.ok(sealed, 'a data-loss finding has to reach a person');
  return String(sealed.todo);
}

describe('the ruling sentence agrees with the finding above it', () => {
  test('something that ARRIVED is never called a deletion', async () => {
    const s = await store();
    const todo = await rulingFor(s, lossFinding('appeared', '"SessionBar" is there now and was not before.'));
    assert.ok(
      !/deletion/i.test(todo),
      `an addition was described as a deletion, which is the bug this file exists for: ${todo}`,
    );
    // And it still has to say why a person is being stopped, or the sentence has lost the
    // thing that made it worth interrupting somebody over.
    assert.match(todo, /lose data/i);
    assert.match(todo, /before anything ships/i);
  });

  test('something that WENT AWAY is still called a deletion', async () => {
    const s = await store();
    const todo = await rulingFor(s, lossFinding('vanished', '"DIPS-journal" is gone.'));
    assert.match(todo, /deletion/i);
    assert.match(todo, /before anything ships/i);
  });

  test('a change that is neither says so rather than guessing', async () => {
    const s = await store();
    const todo = await rulingFor(s, lossFinding('changed', '"SessionBar" now reads differently.'));
    assert.ok(!/deletion/i.test(todo), `a change was described as a deletion: ${todo}`);
    assert.match(todo, /lose data/i);
  });
});
