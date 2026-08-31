/**
 * The record of what "working" means may only be moved by shipping.
 *
 * The store keeps every capture a build ever produced, and the reader took the NEWEST of
 * them. So the moment anybody checked out the old commit and ran a check, the record the
 * whole comparison rests on quietly moved to whatever that run happened to see — a second
 * source of drift on top of the product's own, and a leak in the one rule this tool will not
 * bend: only `ship` decides what working means, and no agent may cut that reference.
 *
 * The two captures blessed at ship time are written down beside the cut. They are what a
 * later check reads. Found by the identical-runs lane, 2026-08-31.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, ensureStore, saveBuild, saveCapture, newCaptureId } from '../../src/v2/store.js';
import { makeObservation } from '../../src/v2/observation.js';
import { storedReference } from '../../src/v2/run.js';
import { scratchDir, cleanUp } from '../support.mjs';

after(cleanUp);

const PRODUCT = 'drifty';
const BUILD = 'build-1';

/**
 * @param {any} store
 * @param {'a'|'b'} run
 * @param {string} said
 * @param {Date} when   Explicit, because a capture id carries the second it was made and
 *                      three random characters — so two captures inside one second are
 *                      ordered by the random half, and "the newest" is a coin toss.
 * @returns {Promise<string>}
 */
async function capture(store, run, said, when) {
  const id = newCaptureId(run, when);
  await saveCapture(store, {
    id,
    journey: 'say-hello',
    build: { id: BUILD, product: PRODUCT, version: '1.0.0' },
    run,
    startedAt: new Date().toISOString(),
    durationMs: 1,
    observations: [makeObservation('cli.say-hello.stdout', 'results', said)],
    complete: true,
  });
  return id;
}

describe('which captures of the reference build are the record', () => {
  test('the pair ship blessed is used, not whatever the last check left behind', async () => {
    const store = openStore({ root: await scratchDir('staysfixed-drift') });
    await ensureStore(store);
    await saveBuild(store, { id: BUILD, product: PRODUCT, version: '1.0.0' }, { captures: 4 });

    const shipDay = new Date('2026-08-01T10:00:00Z');
    const blessedA = await capture(store, 'a', 'hello', shipDay);
    const blessedB = await capture(store, 'b', 'hello', shipDay);
    // Somebody checks out the old commit and runs a check a fortnight later. Same build, new
    // captures, and on this run the product said something else.
    const later = new Date('2026-08-15T10:00:00Z');
    await capture(store, 'a', 'hello, from a machine under load', later);
    await capture(store, 'b', 'hello, from a machine under load', later);

    const pinned = await storedReference(store, BUILD, 'say-hello', [blessedA, blessedB]);
    assert.equal(
      pinned.capture?.observations?.[0]?.value,
      'hello',
      'the record moved without anybody shipping',
    );
    assert.equal(pinned.capture?.id, blessedA);
  });

  test('a reference with no blessed pair written down still reads the newest', async () => {
    const store = openStore({ root: await scratchDir('staysfixed-drift-old') });
    await ensureStore(store);
    await saveBuild(store, { id: BUILD, product: PRODUCT, version: '1.0.0' }, { captures: 2 });
    const when = new Date('2026-08-01T10:00:00Z');
    await capture(store, 'a', 'hello', when);
    await capture(store, 'b', 'hello', when);

    const stored = await storedReference(store, BUILD, 'say-hello', undefined);
    assert.equal(
      stored.capture?.observations?.[0]?.value,
      'hello',
      'a reference cut before this was recorded has to go on working exactly as it did',
    );
  });
});
