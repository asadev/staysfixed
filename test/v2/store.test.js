/**
 * The store — the record of what the product did last time.
 *
 * One capture is one file: a header, then one observation per line, then an end
 * line. The only genuinely interesting thing about it is what happens when a
 * line is half written — and that is not a rare event. A laptop lid closing
 * mid-run, a kill signal, a disk that filled.
 *
 * A torn file must cost the torn line and NOTHING ELSE, and it must say so. If
 * it read as an empty capture instead, that is indistinguishable from
 * "everything vanished", which is the loudest finding the tool has — so a dead
 * laptop would report a catastrophe, and a catastrophe would be shrugged off as
 * a dead laptop.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

import {
  openStore,
  saveCapture,
  loadCapture,
  latestCapture,
  listCaptures,
  openCaptureWriter,
  sweepIncomplete,
  setReference,
  referenceFor,
  referencePointer,
} from '../../src/v2/store.js';
import { scratchDir, cleanUp } from '../support.mjs';

after(cleanUp);

/** A store in a folder of its own, so no test can see another's files. */
async function store() {
  return openStore({ root: await scratchDir('staysfixed-store') });
}

/**
 * @param {string} id
 * @param {Record<string, unknown>} values
 * @param {{build?: string, journey?: string, run?: any}} [opts]
 * @returns {any}
 */
function capture(id, values, opts = {}) {
  return {
    id,
    journey: opts.journey ?? 'the shop opens',
    build: { id: opts.build ?? 'build-1', product: 'shop' },
    run: opts.run ?? 'a',
    startedAt: '2026-08-29T10:00:00.000Z',
    durationMs: 120,
    observations: Object.entries(values).map(([path, value]) => ({ path, channel: 'results', value })),
  };
}

describe('writing and reading back', () => {
  test('a capture written is a capture read', async () => {
    const s = await store();
    const ref = await saveCapture(s, capture('20260829-100000-a-aaa', { 'cli.build.exit': 0, 'cli.build.log': 'ready' }));

    const back = /** @type {any} */ (await loadCapture(s, ref));
    assert.ok(back);
    assert.equal(back.journey, 'the shop opens');
    assert.equal(back.observations.length, 2);
    assert.equal(back.complete, true);
  });

  test('the newest is the newest, and the older ones are still there', async () => {
    const s = await store();
    await saveCapture(s, capture('20260829-100000-a-aaa', { 'cli.build.exit': 0 }));
    await saveCapture(s, capture('20260829-110000-a-bbb', { 'cli.build.exit': 1 }));

    const newest = /** @type {any} */ (await latestCapture(s, { buildId: 'build-1', journey: 'the shop opens' }));
    assert.ok(newest);
    assert.equal(newest.observations[0].value, 1);
    assert.equal((await listCaptures(s, { buildId: 'build-1' })).length, 2, 'the history is kept — a marker months old has to still be readable');
  });

  test('asking for a capture that is not there is null, not a crash', async () => {
    const s = await store();
    assert.equal(await loadCapture(s, { buildId: 'nope', journey: 'nowhere', captureId: 'never' }), null);
    assert.equal(await latestCapture(s, { buildId: 'nope', journey: 'nowhere' }), null);
  });

  test('the reference is remembered and can be read back', async () => {
    const s = await store();
    await saveCapture(s, capture('20260829-100000-a-aaa', { 'cli.build.exit': 0 }));
    await setReference(s, 'build-1', { product: 'shop', note: 'shipped' });

    const pointer = /** @type {any} */ (await referencePointer(s, 'shop'));
    assert.ok(pointer, 'the pointer says which build, who set it and when');
    assert.equal(pointer.buildId, 'build-1');

    const record = /** @type {any} */ (await referenceFor(s, 'shop'));
    assert.ok(record, 'and the record behind it is what the comparison actually reads');
    assert.equal(record.isReference, true);
  });

  test('a product nobody has ever shipped has no reference, and that is not an error', async () => {
    // The cold start. It is expected on every existing product, and the caller
    // has to say so out loud rather than quietly comparing against nothing.
    const s = await store();
    assert.equal(await referencePointer(s, 'never-shipped'), null);
    assert.equal(await referenceFor(s, 'never-shipped'), null);
  });
});

describe('a half-written file', () => {
  /**
   * Save a capture, then chop the tail off the file — a run that died while it
   * was being written.
   * @param {number} keepFraction
   */
  async function tornCapture(keepFraction) {
    const s = await store();
    const ref = await saveCapture(
      s,
      capture('20260829-100000-a-aaa', {
        'cli.build.exit': 0,
        'cli.build.log': 'ready',
        'cli.build.warnings': 0,
        'cli.build.files': 12,
      })
    );
    const whole = await fsp.readFile(ref.file, 'utf8');
    await fsp.writeFile(ref.file, whole.slice(0, Math.floor(whole.length * keepFraction)));
    return { s, ref };
  }

  test('costs the torn line and nothing else', async () => {
    const { s, ref } = await tornCapture(0.6);
    const back = /** @type {any} */ (await loadCapture(s, ref));
    assert.ok(back, 'a torn file must still read as a capture');
    assert.ok(back.observations.length >= 1, 'the complete lines survive');
    assert.ok(back.observations.length < 4, 'and the torn one does not');
  });

  test('and says out loud that it is not whole', async () => {
    const { s, ref } = await tornCapture(0.6);
    const back = /** @type {any} */ (await loadCapture(s, ref));
    assert.ok(back);
    assert.equal(back.complete, false, 'an incomplete capture claiming to be complete would report a dead laptop as a catastrophe');
    assert.ok(back.note && back.note.length > 0, 'and it has to be readable, not just a flag');
    assert.match(back.note, /never finished|could not be read/i);
  });

  test('a capture with no header at all is refused rather than read as empty', async () => {
    const s = await store();
    const ref = await saveCapture(s, capture('20260829-100000-a-aaa', { 'cli.build.exit': 0 }));
    await fsp.writeFile(ref.file, '{"path":"cli.build.exit","channel":"results","value":0}\n');
    await assert.rejects(() => loadCapture(s, ref), /not a Stays Fixed capture file/i);
  });

  test('one unreadable file does not take the whole reference with it', async () => {
    // The newest capture is torn so badly its header is gone. Walking back to
    // the one before it is the entire reason `latestCapture` walks backwards —
    // otherwise one interrupted run makes the reference unreadable, and the next
    // check reports "nothing to compare against" and lets a release through.
    const s = await store();
    await saveCapture(s, capture('20260829-100000-a-aaa', { 'cli.build.exit': 0 }));
    const second = await saveCapture(s, capture('20260829-110000-a-bbb', { 'cli.build.exit': 1 }));
    const whole = await fsp.readFile(second.file, 'utf8');
    await fsp.writeFile(second.file, whole.slice(0, 20));

    const newest = /** @type {any} */ (await latestCapture(s, { buildId: 'build-1', journey: 'the shop opens' }));
    assert.ok(newest, 'a capture that cannot be read has to be skipped, not thrown over');
    assert.equal(newest.id, '20260829-100000-a-aaa');
  });
});

describe('a capture that never finished being written', () => {
  test('is never mistaken for a capture', async () => {
    const s = await store();
    const writer = await openCaptureWriter(s, { build: { id: 'build-1', product: 'shop' }, journey: 'the shop opens', run: 'a' });
    await writer.append({ path: 'cli.build.exit', channel: 'results', value: 0 });
    // The run dies here. No close.
    assert.deepEqual(await listCaptures(s, { buildId: 'build-1' }), [], 'a capture still being written is not a capture');
    await writer.abandon();
  });

  test('and is cleared away rather than left to rot', async () => {
    const s = await store();
    const writer = await openCaptureWriter(s, { build: { id: 'build-1', product: 'shop' }, journey: 'the shop opens', run: 'a' });
    await writer.append({ path: 'cli.build.exit', channel: 'results', value: 0 });
    await writer.abandon();

    const swept = await sweepIncomplete(s, { buildId: 'build-1' });
    assert.ok(typeof swept === 'object', 'sweeping has to be able to report what it removed');
    assert.deepEqual(await listCaptures(s, { buildId: 'build-1' }), []);
  });

  test('one that is closed properly appears, complete', async () => {
    const s = await store();
    const writer = await openCaptureWriter(s, { build: { id: 'build-1', product: 'shop' }, journey: 'the shop opens', run: 'a' });
    await writer.append({ path: 'cli.build.exit', channel: 'results', value: 0 });
    await writer.append({ path: 'cli.build.log', channel: 'results', value: 'ready' });
    const ref = await writer.close({ durationMs: 90 });

    const back = /** @type {any} */ (await loadCapture(s, ref));
    assert.ok(back);
    assert.equal(back.complete, true);
    assert.equal(back.observations.length, 2);
  });
});
