/**
 * What a reference is allowed to be made of.
 *
 * A reference is not a label, it is a record: the observations everything afterwards is
 * compared with. So the one thing it may never hold is the words "could not be read" —
 * because from the moment it does, "working" means "cannot be reached", every later check
 * compares one hole with another, and the day the product starts running, everything it does
 * is a difference nobody caused.
 *
 * All of this was measured on 2026-08-31 on a Node command that threw on its first line.
 * `staysfixed ship` answered, in these words: "1.0.0 is now what broken-app calls working.
 * All 7 addresses it was watched at answered the same way twice." Both halves of that
 * sentence were true. Two refusals do answer the same way twice, and the build was watched at
 * seven addresses — it just answered at none of them.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { measureStability, cutReference, shouldCut, recordCheck } from '../../src/v2/reference.js';
import { openStore, ensureStore, saveBuild, saveCapture, newCaptureId } from '../../src/v2/store.js';
import { makeObservation } from '../../src/v2/observation.js';
import { scratchDir, cleanUp } from '../support.mjs';

after(cleanUp);

const PRODUCT = 'broken-app';
const REFUSED = 'not checked — the thing being observed fell over before it could be read';

/**
 * @param {string} path
 * @param {any} value
 * @param {import('../../src/v2/types.js').Channel} [channel]
 */
function obs(path, value, channel = 'results') {
  return makeObservation(path, channel, value);
}

/**
 * A store holding one build, walked twice per journey exactly as a real check walks it.
 *
 * @param {{buildId?: string, journeys: Record<string, any[]>}} spec
 * @returns {Promise<{root: string, store: any, buildId: string}>}
 */
async function storeWith(spec) {
  const root = await scratchDir('staysfixed-reference');
  const store = openStore({ root });
  await ensureStore(store);
  const buildId = spec.buildId ?? 'build-1';
  const names = Object.keys(spec.journeys);
  await saveBuild(store, { id: buildId, product: PRODUCT, version: '1.0.0' }, { captures: names.length * 2 });
  for (const [journey, observations] of Object.entries(spec.journeys)) {
    for (const run of /** @type {const} */ (['a', 'b'])) {
      await saveCapture(store, {
        id: newCaptureId(run),
        journey,
        build: { id: buildId, product: PRODUCT, version: '1.0.0' },
        run,
        startedAt: new Date().toISOString(),
        durationMs: 1,
        observations,
        complete: true,
      });
    }
  }
  return { root, store, buildId };
}

// ---------------------------------------------------------------------------

describe('a refusal is not an address that answered the same way twice', () => {
  test('the stability record counts answers, not refusals', async () => {
    const { store, buildId } = await storeWith({
      journeys: {
        'add-up': [
          obs('cli.add-up.ran at all', REFUSED, 'complaints'),
          obs('cli.add-up.exit', 1, 'complaints'),
          obs('cli.add-up.stdout', ''),
        ],
      },
    });

    const stability = await measureStability(store, buildId);
    // Three addresses gave the same answer twice. One of them is not an answer.
    assert.equal(stability.steady, 2, 'the refusal must come off the steady count');
    assert.equal(stability.paths, 2);
    assert.match(stability.note, /not counted at all/, 'and what came off has to be said, not silently subtracted');
    assert.match(stability.note, /a refusal is not an answer that held still/);
  });

  test('a build that answered at nothing says so instead of reporting calm', async () => {
    const { store, buildId } = await storeWith({
      journeys: {
        'add-up': [obs('cli.add-up.ran at all', REFUSED, 'complaints')],
      },
    });

    const stability = await measureStability(store, buildId);
    assert.equal(stability.steady, 0);
    assert.match(stability.note, /NOT ONE address answered/);
    assert.doesNotMatch(stability.note, /answered the same way twice/);
  });

  test('a healthy build is unaffected', async () => {
    const { store, buildId } = await storeWith({
      journeys: { greet: [obs('cli.greet.stdout', 'hello'), obs('cli.greet.exit', 0, 'complaints')] },
    });
    const stability = await measureStability(store, buildId);
    assert.equal(stability.steady, 2);
    assert.match(stability.note, /all 2 addresses it answered at/i);
  });
});

// ---------------------------------------------------------------------------

describe('what "working" may be cut from', () => {
  test('a build whose every journey refused is refused, however clean the check looked', async () => {
    const { store, buildId } = await storeWith({
      journeys: {
        'add-up': [
          obs('cli.add-up.ran at all', REFUSED, 'complaints'),
          obs('cli.add-up.exit', 1, 'complaints'),
        ],
      },
    });
    // The run really did conclude, really was not blocked, and really found nothing
    // unaccounted for. All three of those are true of a run in which every journey refused,
    // which is why the first three gates let it through.
    await recordCheck(store, { buildId, product: PRODUCT, ok: true, findings: 0, unaccounted: 0 });

    const decision = await shouldCut(store, PRODUCT, buildId);
    assert.equal(decision.ok, false);
    assert.equal(decision.state, 'nothing-observed');
    assert.equal(decision.needsForce, true);
    assert.match(String(decision.refusal), /never got the product to do anything/);
    assert.match(String(decision.refusal), /rubber stamp/);
  });

  test('a truncated value is a real answer, and must not be mistaken for a refusal', async () => {
    // `meta.refused` is stamped on an observation whose value was only PARTLY read — a
    // stdout too big to keep whole. The gate used to read that flag, so a journey whose only
    // product-channel observation was a large log was filed as having refused and a perfectly
    // healthy release was blocked. What matters is whether there is an answer here at all.
    const big = makeObservation('cli.greet.stdout', 'results', 'hello…and a great deal more', {
      describe: 'what it printed',
      refused: true,
      refusedWhy: 'the value was too large to keep, so only a fingerprint of it was kept (too big)',
    });
    const { store, buildId } = await storeWith({ journeys: { greet: [big] } });
    await recordCheck(store, { buildId, product: PRODUCT, ok: true, findings: 0, unaccounted: 0 });

    const decision = await shouldCut(store, PRODUCT, buildId);
    assert.equal(decision.ok, true, 'a large log is not a product that would not start');
  });

  test('the cut says what it counted, and never claims a refusal answered', async () => {
    const { store, buildId } = await storeWith({
      journeys: {
        greet: [obs('cli.greet.stdout', 'hello')],
        pay: [obs('cli.pay.ran at all', REFUSED, 'complaints')],
      },
    });
    await recordCheck(store, { buildId, product: PRODUCT, ok: true, findings: 0, unaccounted: 0 });

    const cut = await cutReference(store, { product: PRODUCT, build: buildId, why: '1.0.0' });
    assert.equal(cut.unchanged, undefined);
    assert.match(cut.summary, /answered at/);
    assert.doesNotMatch(cut.summary, /addresses it was watched at answered/, 'the old wording counted refusals as answers');
  });
});
