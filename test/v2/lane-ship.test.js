/**
 * The ship hook, held to the one thing it decides: what "working" is going to mean.
 *
 * Everything else in this tool reports. This is the single command that WRITES the answer
 * every later report is measured against, so the failures that matter here are not "it said
 * the wrong thing" — they are "it wrote down the wrong standard, and now every run after it
 * is wrong too, quietly, in the safe-looking direction".
 *
 * Two of those were measured on 2026-08-31 against a three-route server with a `throw` at the
 * top of it, so it could not start:
 *
 *   `staysfixed check` recorded three refusals — "not checked, the thing being observed fell
 *   over before it could be read" — and `staysfixed ship` answered "1.0.0 is now what
 *   poisonshop calls working. All 6 addresses it was watched at answered the same way twice."
 *   Two refusals do answer the same way twice. Leaving the server broken and running the next
 *   check then produced "Nothing that worked has changed. 6 addresses checked" about a product
 *   that cannot start — a clean result this tool had not earned, which is the one sentence it
 *   exists never to say. Fixing the server produced thirteen differences nobody caused.
 *
 *   And a second release that nobody had checked was told "Nothing about tinyshop is being
 *   compared against anything yet" while a reference sat in its store and the very next check
 *   used it. Telling somebody the net is off while it is on is how a broken build gets waved
 *   through: a person who believes nothing is watching stops reading what it says.
 *
 * The stores below are built by hand rather than by running a product. That is on purpose and
 * it is the same choice decide.test.js makes: what is under test is the decision, and booting
 * a server to produce a refusal would test the http adapter instead and take a hundred times
 * as long. The shapes written here are the shapes a real run wrote — copied off the store the
 * repro above left behind, refusal flag and all.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { openStore, ensureStore, saveBuild, saveCapture, referencePointer, setReference } from '../../src/v2/store.js';
import { recordCheck } from '../../src/v2/reference.js';
import { onShip } from '../../src/v2/ship.js';
import { scratchDir, cleanUp } from '../support.mjs';

after(cleanUp);

const PRODUCT = 'shoplane';

/**
 * A project with a store and a git-shaped build id, but no git repository.
 *
 * No repository on purpose: `detectRelease` then falls through to its last case and names the
 * release after the version in package.json, which keeps these tests about the decision rather
 * than about what git happened to say on the machine they ran on.
 *
 * @returns {Promise<{root: string, store: import('../../src/v2/types.js').Store}>}
 */
async function project(version = '1.0.0') {
  const root = await scratchDir('staysfixed-lane-ship');
  await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: PRODUCT, version }));
  await fsp.writeFile(
    path.join(root, 'staysfixed.config.json'),
    JSON.stringify({ product: PRODUCT }, null, 2),
  );
  const store = openStore({ root });
  await ensureStore(store);
  return { root, store };
}

/** @type {import('../../src/v2/types.js').BuildFingerprint} */
const BUILD = { id: 'git-abc123abc123', product: PRODUCT, version: '1.0.0' };

/**
 * One stored recording of one journey, in the shape the http adapter writes.
 *
 * `refused` picks between the two shapes that were actually measured. A walked route stores
 * what it gave back on the `results` channel and one refused `counters` observation, because
 * a stopwatch is never compared. A route that could not be reached stores one thing: a
 * refused `results` observation saying so. That single refused observation is the whole
 * poison — it is what a later check compares against, and what it equals is another refusal.
 *
 * @param {import('../../src/v2/types.js').Store} store
 * @param {{journey: string, refused: boolean, run?: 'a'|'b', at?: string}} what
 * @returns {Promise<void>}
 */
async function record(store, what) {
  const run = what.run ?? 'a';
  const name = what.journey;
  /** @type {import('../../src/v2/types.js').Observation[]} */
  const observations = what.refused
    ? [
        {
          path: `api.${name}.answered at all`,
          channel: 'results',
          value: 'not checked — the thing being observed fell over before it could be read',
          meta: { refused: true, describe: 'The server stopped before it answered — exit code 1.' },
        },
      ]
    : [
        { path: `api.${name}.status`, channel: 'results', value: 200 },
        { path: `api.${name}.body`, channel: 'results', value: { ok: true } },
        {
          path: `count.${name}.duration`,
          channel: 'counters',
          value: 'not compared — a stopwatch measures how busy this machine was',
          meta: { refused: true },
        },
      ];

  await saveCapture(store, {
    id: `${what.at ?? '20260831-120000'}-${run}-${name}`,
    journey: name,
    build: BUILD,
    run,
    startedAt: '2026-08-31T12:00:00.000Z',
    durationMs: 5,
    observations,
  });
  await saveBuild(store, BUILD, { journey: name });
}

/**
 * The source reader's own recording: doors listed out of the code, and a count of them.
 *
 * Nothing here was run. It is written into these tests because it is written into every real
 * store — the code reader walks on every check — and a gate that mistook it for the product
 * having started would pass every one of the cases below while changing nothing.
 *
 * @param {import('../../src/v2/types.js').Store} store
 * @returns {Promise<void>}
 */
async function recordTheCodeReader(store) {
  await saveCapture(store, {
    id: '20260831-120000-a-the-code',
    journey: 'the-code',
    build: BUILD,
    run: 'a',
    startedAt: '2026-08-31T12:00:00.000Z',
    durationMs: 1,
    observations: [
      { path: 'count.contract.environment', channel: 'counters', value: 2 },
      { path: 'proc.env.PORT', channel: 'contract', value: 'read from the environment' },
      { path: 'proc.env.HOST', channel: 'contract', value: 'read from the environment' },
    ],
  });
  await saveBuild(store, BUILD, { journey: 'the-code' });
}

/**
 * A check that concluded cleanly about this build — which is exactly what a run where every
 * journey refused DOES conclude, and why nothing upstream of `ship` catches this.
 *
 * @param {import('../../src/v2/types.js').Store} store
 * @returns {Promise<void>}
 */
async function checkedClean(store) {
  await recordCheck(store, {
    buildId: BUILD.id,
    product: PRODUCT,
    ok: true,
    blocked: false,
    findings: 0,
    unaccounted: 0,
    waived: 0,
    sealed: 0,
    by: 'staysfixed check',
  });
}

describe('a build nothing was observed of never becomes the standard', () => {
  test('every journey refused: the reference does not move, and the release still succeeds', async () => {
    const { root, store } = await project();
    await recordTheCodeReader(store);
    for (const journey of ['health', 'orders', 'products']) {
      await record(store, { journey, refused: true });
      await record(store, { journey, refused: true, run: 'b' });
    }
    await checkedClean(store);

    const result = await onShip({ root, product: PRODUCT, why: '1.0.0 went out' });

    assert.equal(result.cut, false, 'a run that observed nothing must not become what "working" means');
    assert.equal(result.ok, true, 'refusing to cut is not an error — the release itself is fine');
    assert.match(String(result.refused), /never got the product to do anything/);
    // The journeys are named. A refusal nobody can act on gets forced past, and the names are
    // the difference between "something was wrong" and "your server did not start".
    assert.match(String(result.refused), /health, orders, products/);
    assert.equal(
      await referencePointer(store, PRODUCT),
      null,
      'nothing may be written to the reference pointer by a refused cut',
    );
  });

  test('the same build, actually observed, does become the standard', async () => {
    const { root, store } = await project();
    await recordTheCodeReader(store);
    for (const journey of ['health', 'orders', 'products']) {
      await record(store, { journey, refused: false });
      await record(store, { journey, refused: false, run: 'b' });
    }
    await checkedClean(store);

    const result = await onShip({ root, product: PRODUCT, why: '1.0.0 went out' });

    assert.equal(result.cut, true, 'the gate must refuse a run that saw nothing, not every run');
    const pointer = await referencePointer(store, PRODUCT);
    assert.equal(pointer?.buildId, BUILD.id);
  });

  test('the code reader alone is not evidence the product ran', async () => {
    const { root, store } = await project();
    await recordTheCodeReader(store);
    for (const journey of ['health', 'orders']) await record(store, { journey, refused: true });
    await checkedClean(store);

    const result = await onShip({ root, product: PRODUCT, why: '1.0.0 went out' });

    assert.equal(result.cut, false, 'doors read out of the source have never been opened');
  });

  test('a project with nothing but the code reader still ships', async () => {
    // No journey refused here, because nothing was asked to run. That is a weak reference and
    // an honest one — it compares the doors the code declares — and this gate is about
    // refusals, not about weakness, so it must leave this alone.
    const { root, store } = await project();
    await recordTheCodeReader(store);
    await checkedClean(store);

    const result = await onShip({ root, product: PRODUCT, why: '1.0.0 went out' });

    assert.equal(result.cut, true);
  });

  test('--force cuts past it, and the forcing goes on the record for good', async () => {
    const { root, store } = await project();
    for (const journey of ['health', 'orders']) await record(store, { journey, refused: true });
    await checkedClean(store);

    const result = await onShip({ root, product: PRODUCT, why: '1.0.0 went out', force: true });

    assert.equal(result.cut, true, 'shipping is the person\'s call and never the tool\'s');
    const pointer = await referencePointer(store, PRODUCT);
    assert.equal(pointer?.buildId, BUILD.id);
    assert.match(result.lines.join(' '), /This was FORCED/);
    // And in the store, not only on the screen somebody watched go by once. Months later the
    // question is "why is this reference full of could-not-be-read", and the answer has to be
    // sitting next to the reference rather than in a terminal nobody kept.
    assert.match(String(pointer?.note), /FORCED: nothing was observed of this build/);
  });

  test('some refused and some walked: it cuts, and says which ones are going in blind', async () => {
    const { root, store } = await project();
    await recordTheCodeReader(store);
    await record(store, { journey: 'health', refused: false });
    await record(store, { journey: 'products', refused: false });
    await record(store, { journey: 'orders', refused: true });
    await checkedClean(store);

    const result = await onShip({ root, product: PRODUCT, why: '1.0.0 went out' });

    assert.equal(result.cut, true, 'a reference with a hole in it is still worth cutting');
    const said = result.lines.join(' ');
    assert.match(said, /1 of 3 journeys refused/);
    assert.match(said, /orders/);
    // And it says what that will cost, rather than only that it happened.
    assert.match(said, /report it as changed/);
  });
});

describe('ship never claims the safety net is off while it is on', () => {
  /**
   * A release of a version nothing in the store was ever recorded against — the shape that
   * reaches the "no record of this build" branch, which is where the wrong sentence lived.
   * The project's package.json says 9.9.9 and everything stored says 1.0.0, so there is
   * nothing for the version join to land on.
   *
   * @param {{withReference: boolean}} how
   * @returns {Promise<import('../../src/v2/ship.js').ShipResult>}
   */
  async function shipSomethingNobodyChecked(how) {
    const { root, store } = await project('9.9.9');
    await recordTheCodeReader(store);
    for (const journey of ['health', 'orders']) await record(store, { journey, refused: false });
    await checkedClean(store);
    if (how.withReference) {
      await setReference(store, BUILD.id, { product: PRODUCT, setBy: 'staysfixed ship', at: '2026-08-20T09:00:00.000Z' });
    }
    const result = await onShip({ root, product: PRODUCT, why: '9.9.9 went out' });
    assert.equal(result.buildId, undefined, 'this test only means anything on the no-record branch');
    return result;
  }

  test('a release nobody checked names the standard that is still in force', async () => {
    const result = await shipSomethingNobodyChecked({ withReference: true });

    assert.equal(result.cut, false);
    const said = result.summary + ' ' + result.lines.join(' ');
    assert.doesNotMatch(
      said,
      /is being compared against anything yet/,
      'a reference exists and the next check uses it — saying otherwise is the wrong answer in the dangerous direction',
    );
    assert.match(said, /go on comparing against/);
    assert.match(said, /2026-08-20/, 'name the standard, so somebody can tell whether it is the right one');
  });

  test('and still says so plainly when there really is no reference', async () => {
    const result = await shipSomethingNobodyChecked({ withReference: false });

    assert.equal(result.cut, false);
    assert.match(result.summary + ' ' + result.lines.join(' '), /is being compared against anything yet/);
  });

  test('a refused first release does not promise a previous reference that was never cut', async () => {
    const { root, store } = await project();
    await recordTheCodeReader(store);
    await checkedClean(store);

    // Told the exact build id, so this lands on the store's own "nothing was ever observed
    // against it" refusal — the other way into a sentence about what checks compare against.
    const result = await onShip({ root, product: PRODUCT, build: 'git-999999999999', why: '1.0.0 went out' });

    assert.equal(result.cut, false);
    assert.doesNotMatch(
      result.summary,
      /still compare against the previous reference/,
      'there is no previous reference on a first release, and promising one is a net that is not there',
    );
    assert.match(result.summary, /is being compared against anything yet/);
  });
});
