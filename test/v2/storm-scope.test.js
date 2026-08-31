/**
 * A JOURNEY THAT PRODUCED NO ANSWER MAY NOT BE FOLDED INTO A PASSING RUN.
 *
 * The rule this file guards was already right and was being asked in the wrong place. When
 * the new build disagrees with itself about MORE addresses than it holds still at, every one
 * of those disagreements is subtracted before anything is compared, so the quiet that comes
 * out the other end is the quiet of nothing having been looked at. `wobbleStorm` says so in
 * those words — "there is no answer here" — and the README and `docs/mcp.md` both promise
 * that this state must never be reported as a pass.
 *
 * WHAT WAS HAPPENING. Measured 2026-08-31 on a real Next.js site with six pages, two of them
 * deliberately unsteady on the server where the browser freeze cannot reach them. One check,
 * one untouched tree:
 *
 *     "walk dashboard" could not be compared: ... 84 of the 137 addresses — 61% of them
 *     "walk home" could not be compared: ... 81 of the 83 addresses — 98% of them
 *     "open / and read what the screen says" ... 81 of the 83 addresses — 98% of them
 *     "open /dashboard and read what the screen says" ... 95 of the 95 addresses — 100%
 *     ok: true, exit code 0
 *
 * A page where EVERY SINGLE ADDRESS disagreed with itself came back inside a passing run,
 * with the sentence "there is no answer here" printed four times in the same output. The
 * share across the whole run was nowhere near half — the same shape the owner reported at
 * 179 unsteady out of 2849 — because nine journeys that behaved were being averaged with the
 * four that told you nothing.
 *
 * IT IS A SCOPE BUG, NOT A LOGIC BUG. Each journey is its own measurement: its own pages,
 * its own two walks, its own chance of falling over. Adding them together produces a number
 * that describes no journey at all. The same one comparison, asked once per journey, catches
 * all four.
 *
 * THE SECOND HALF is a journey with no answer of any kind. Two walks that each came back
 * empty agree with each other about everything — nought unsteady out of nought — and
 * `unstable <= steady` waved that through as calm weather. That is the same false all-clear
 * wearing the opposite clothes, and it is answered in the same place.
 *
 * The last two tests here are the guard on the guard: a product that behaves still passes,
 * and a journey that is only partly unsteady still gets a verdict. A rule that refuses
 * everything protects nobody, because it gets switched off inside a week.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeObservation,
  measureWobble,
  mergeWobble,
  noAnswerJourneys,
  populationDriftNote,
  unmeasuredWobble,
  wobbleShape,
  wobbleStorm,
} from '../../src/v2/observation.js';
import { openStore, ensureStore, saveBuild, saveCapture, setReference, newCaptureId } from '../../src/v2/store.js';
import { runCheck } from '../../src/v2/run.js';
import { scratchDir, cleanUp } from '../support.mjs';

after(cleanUp);

const PRODUCT = 'shop';

/**
 * @param {string} path
 * @param {any} value
 * @param {import('../../src/v2/types.js').Channel} [channel]
 * @returns {import('../../src/v2/types.js').Observation}
 */
function obs(path, value, channel = 'results') {
  return makeObservation(path, channel, value);
}

/**
 * One capture, in the shape the store and the engine both accept.
 *
 * @param {{journey?: string, build?: string, run?: any, observations: any[]}} spec
 * @returns {any}
 */
function capture(spec) {
  return {
    id: newCaptureId(spec.run ?? 'a'),
    journey: spec.journey ?? 'walk',
    build: { id: spec.build ?? 'build-1', product: PRODUCT },
    run: spec.run ?? 'a',
    startedAt: new Date().toISOString(),
    durationMs: 1,
    observations: spec.observations,
    complete: true,
  };
}

/**
 * A wobble of one journey, written as arithmetic so the tests read as the rule does.
 *
 * @param {string} journey
 * @param {number} unstable
 * @param {number} steady
 * @returns {any}
 */
function wobbleOf(journey, unstable, steady) {
  const paths = Array.from({ length: unstable }, (_, i) => `screen.${journey}.row${i}`);
  return {
    buildId: 'new',
    journey,
    runs: ['a', 'b'],
    entries: paths.map((path, i) => ({ path, channel: 'meaning', kind: 'changed', a: i, b: i + 1, distance: 1 })),
    unstable: paths,
    steady,
    measured: true,
  };
}

// ---------------------------------------------------------------------------
// The rule, and the scope it is asked in
// ---------------------------------------------------------------------------

describe('the storm rule is asked of one journey at a time', () => {
  test('a journey where every address disagreed with itself is named, even inside a calm total', () => {
    // The measured shape, kept to its proportions: nine journeys that behaved, four that did
    // not, and a merged share that never gets near half. This is the exact arithmetic that
    // let 100% through.
    const calm = Array.from({ length: 9 }, (_, i) => wobbleOf(`fine-${i}`, 2, 300));
    const dead = [wobbleOf('dashboard', 137, 0), wobbleOf('home', 81, 2), wobbleOf('pricing', 60, 20)];
    const all = [...calm, ...dead];

    assert.equal(
      wobbleStorm(mergeWobble(all)).stormy,
      false,
      'the whole-run share really is calm here — if this ever fires, the fixture stopped proving what it is for',
    );

    const named = noAnswerJourneys(all).map((j) => j.journey);
    assert.deepEqual(named, ['dashboard', 'home', 'pricing']);
  });

  test('the merged record is never asked, because asking it is the bug', () => {
    const all = [wobbleOf('dashboard', 137, 0), wobbleOf('fine', 2, 300)];
    const merged = mergeWobble(all);
    assert.equal(merged.journey, '*');
    assert.equal(noAnswerJourneys([merged]).length, 0, 'the whole run wearing one journey\'s shape is not a journey');
  });

  test('a journey that walked twice and saw nothing at all is no answer either', () => {
    /** @type {any} */
    const empty = { buildId: 'new', journey: 'checkout', runs: ['a', 'b'], entries: [], unstable: [], steady: 0, measured: true };
    const storm = wobbleStorm(empty);
    assert.equal(storm.stormy, true, 'nought unsteady out of nought is not agreement, it is an empty walk');
    assert.match(storm.why, /neither run found a single address/);
    assert.match(storm.why, /no answer here/);
  });

  test('a wobble that was never taken is still not a storm — unmeasured and unsteady are different news', () => {
    assert.equal(wobbleStorm(unmeasuredWobble('new', 'checkout')).stormy, false);
    assert.equal(noAnswerJourneys([unmeasuredWobble('new', 'checkout')]).length, 0);
  });

  test('a journey that is only partly unsteady still gets a verdict', () => {
    // Half the comparison survived, so there is still an answer in it. A rule that refuses
    // everything protects nobody.
    assert.deepEqual(noAnswerJourneys([wobbleOf('weather', 30, 70), wobbleOf('about', 6, 6)]), []);
  });
});

// ---------------------------------------------------------------------------
// The drifting count
// ---------------------------------------------------------------------------

describe('the number of addresses a run looked at may not move in silence', () => {
  test('an answer that moved and an address that came and went are told apart', () => {
    const before = capture({ run: 'a', observations: [obs('cli.a.v', 1), obs('cli.b.v', 2), obs('cli.gone.v', 3)] });
    const after = capture({ run: 'b', observations: [obs('cli.a.v', 1), obs('cli.b.v', 99), obs('cli.new.v', 4)] });
    const shape = wobbleShape(measureWobble(before, after));

    assert.equal(shape.changed, 1, 'one address really did give two different answers');
    assert.equal(shape.vanished, 1);
    assert.equal(shape.appeared, 1);
    assert.equal(shape.drifted, 2, 'two addresses only one of the two passes ever reached');
    assert.equal(shape.bothPasses, 2, 'and only two were reached by both');
  });

  test('the drift is named in words, with the count both passes reached beside it', () => {
    const before = capture({ run: 'a', observations: [obs('cli.a.v', 1), obs('cli.gone.v', 3)] });
    const after = capture({ run: 'b', observations: [obs('cli.a.v', 1), obs('cli.new.v', 4)] });
    const note = populationDriftNote(measureWobble(before, after));

    assert.match(note, /DID NOT LOOK AT THE SAME ADDRESSES/);
    assert.match(note, /not a number that will be the same on the next run/);
    assert.match(note, /1 is the count both passes actually reached/);
  });

  test('nothing is said when both passes covered the same ground', () => {
    const before = capture({ run: 'a', observations: [obs('cli.a.v', 1), obs('cli.b.v', 2)] });
    const after = capture({ run: 'b', observations: [obs('cli.a.v', 1), obs('cli.b.v', 99)] });
    assert.equal(
      populationDriftNote(measureWobble(before, after)),
      '',
      'a sentence printed on every single run is a sentence people learn to skip, and this one has to land when it is true',
    );
  });
});

// ---------------------------------------------------------------------------
// The whole loop, end to end — where the pass was actually being handed out
// ---------------------------------------------------------------------------

/**
 * A store holding a reference build that answered everywhere, twice.
 *
 * @param {Record<string, any[]>} byJourney
 * @returns {Promise<{root: string, store: any}>}
 */
async function storeWithReference(byJourney) {
  const root = await scratchDir('staysfixed-storm-scope');
  const store = openStore({ root });
  await ensureStore(store);
  await saveBuild(store, { id: 'ref-build', product: PRODUCT, version: '1.0.0' }, { captures: 2 });
  for (const [journey, observations] of Object.entries(byJourney)) {
    for (const run of /** @type {const} */ (['a', 'b'])) {
      await saveCapture(store, capture({ journey, build: 'ref-build', run, observations }));
    }
  }
  await setReference(store, 'ref-build', { product: PRODUCT });
  return { root, store };
}

/**
 * A check whose walk hands back a different list for the second pass, so a journey can be
 * made to disagree with itself the way a real one does.
 *
 * @param {{root: string, store: any}} where
 * @param {Record<string, {a: any[], b: any[]}>} byJourney
 * @returns {Promise<any>}
 */
async function checkWith(where, byJourney) {
  const journeys = Object.keys(byJourney).map((name) => ({
    name,
    describe: name,
    source: /** @type {const} */ ('code'),
    surface: /** @type {const} */ ('cli'),
    steps: [],
  }));
  return runCheck({
    store: where.store,
    product: PRODUCT,
    candidate: { id: 'work-build', product: PRODUCT },
    journeys: /** @type {any} */ (journeys),
    cwd: where.root,
    storedOnly: true,
    remember: false,
    walk: async (/** @type {any} */ req) =>
      capture({
        journey: req.journey.name,
        build: req.build.id,
        run: req.run,
        observations: byJourney[req.journey.name][req.run === 'b' ? 'b' : 'a'],
      }),
  });
}

/**
 * A journey that answers the same way twice, so it counts towards the calm side of the total.
 *
 * @param {string} name
 * @param {number} howMany
 * @returns {any[]}
 */
function steadyRows(name, howMany) {
  return Array.from({ length: howMany }, (_, i) => obs(`cli.${name}.row${i}`, `row ${i}`));
}

/**
 * A journey that answers differently every time it is asked — a page rendered on the server
 * from a random number, which is what the fixture site does on purpose.
 *
 * @param {string} name
 * @param {number} howMany
 * @param {string} pass
 * @returns {any[]}
 */
function shiftingRows(name, howMany, pass) {
  return Array.from({ length: howMany }, (_, i) => obs(`cli.${name}.row${i}`, `order ${pass}-${i}`));
}

describe('the verdict a run with a dead journey in it is allowed to give', () => {
  test('one journey out of ten with no answer in it takes the pass away, and says so first', async () => {
    /** @type {Record<string, any[]>} */
    const reference = {};
    /** @type {Record<string, {a: any[], b: any[]}>} */
    const now = {};
    for (let i = 0; i < 9; i += 1) {
      reference[`fine-${i}`] = steadyRows(`fine-${i}`, 30);
      now[`fine-${i}`] = { a: steadyRows(`fine-${i}`, 30), b: steadyRows(`fine-${i}`, 30) };
    }
    reference.dashboard = steadyRows('dashboard', 20);
    now.dashboard = { a: shiftingRows('dashboard', 20, 'first'), b: shiftingRows('dashboard', 20, 'second') };

    const verdict = await checkWith(await storeWithReference(reference), now);

    // 20 unsteady addresses against 270 steady ones. The whole-run share is 7%, which is
    // exactly why this used to come back clean.
    assert.equal(verdict.ok, false, 'a journey where every address disagreed with itself is not a pass');
    assert.match(verdict.summary, /^NO ANSWER FOR 1 OF THE 10 JOURNEYS HERE: dashboard\./);
    assert.doesNotMatch(
      verdict.summary,
      /Nothing that worked has changed/,
      'the one sentence this tool may never say over a journey it could not read',
    );
    const gaps = verdict.coverage.gaps.map((/** @type {any} */ g) => `${g.what} ${g.why}`).join(' | ');
    assert.match(gaps, /"dashboard" could not be compared/);
    assert.match(gaps, /there is no answer here/);
  });

  test('a journey that walked twice and came back with nothing is not a pass either', async () => {
    const verdict = await checkWith(await storeWithReference({ home: steadyRows('home', 20), checkout: steadyRows('checkout', 5) }), {
      home: { a: steadyRows('home', 20), b: steadyRows('home', 20) },
      checkout: { a: [], b: [] },
    });

    assert.equal(verdict.ok, false, 'an empty walk agrees with an empty walk about everything, which is not the same as there being nothing wrong');
    assert.match(verdict.summary, /NO ANSWER FOR 1 OF THE 2 JOURNEYS HERE: checkout\./);
    const gaps = verdict.coverage.gaps.map((/** @type {any} */ g) => `${g.what} ${g.why}`).join(' | ');
    assert.match(gaps, /came back with nothing at all to look at/);
  });

  test('a run where every journey answered twice is still a pass, and still says so', async () => {
    const verdict = await checkWith(await storeWithReference({ home: steadyRows('home', 20), about: steadyRows('about', 12) }), {
      home: { a: steadyRows('home', 20), b: steadyRows('home', 20) },
      about: { a: steadyRows('about', 12), b: steadyRows('about', 12) },
    });

    assert.equal(verdict.ok, true, 'a rule that refuses everything protects nobody');
    assert.match(verdict.summary, /Nothing that worked has changed/);
    assert.doesNotMatch(verdict.summary, /NO ANSWER FOR/);
  });

  test('a real regression in a journey that DID answer is still reported beside the one that did not', async () => {
    // The guard on the guard, and the one that matters most. Refusing the pass must not turn
    // into refusing to look: a page that behaved and broke is still a finding, and it still
    // has to be readable next to the page that told you nothing.
    const verdict = await checkWith(await storeWithReference({ home: steadyRows('home', 20), dashboard: steadyRows('dashboard', 20) }), {
      home: {
        a: [...steadyRows('home', 19), obs('cli.home.row19', 'the Buy button is gone')],
        b: [...steadyRows('home', 19), obs('cli.home.row19', 'the Buy button is gone')],
      },
      dashboard: { a: shiftingRows('dashboard', 20, 'first'), b: shiftingRows('dashboard', 20, 'second') },
    });

    assert.equal(verdict.ok, false);
    assert.equal(verdict.findings.length, 1, 'the healthy journey is still compared and its regression still comes out');
    assert.match(JSON.stringify(verdict.findings[0]), /Buy button is gone/);
    assert.match(verdict.summary, /^NO ANSWER FOR 1 OF THE 2 JOURNEYS HERE: dashboard\./);
  });

  test('a run whose two passes walked over different addresses says so in the ledger', async () => {
    const verdict = await checkWith(await storeWithReference({ home: steadyRows('home', 20) }), {
      home: {
        a: [...steadyRows('home', 20), obs('cli.home.prefetch', 'started')],
        b: steadyRows('home', 20),
      },
    });

    const gaps = verdict.coverage.gaps.map((/** @type {any} */ g) => `${g.what} ${g.why}`).join(' | ');
    assert.match(gaps, /did not walk over the same addresses/);
    assert.match(gaps, /will not be the same number next time/);
    assert.match(verdict.summary, /DID NOT LOOK AT THE SAME ADDRESSES/, 'the closing paragraph carries it too, because most readers never open the coverage list');
  });
});
