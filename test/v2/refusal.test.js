/**
 * A refusal is not an answer, and it may not be compared with one.
 *
 * Every test in here fails on the code as it stood on the morning of 2026-08-31, and each of
 * them is one of the three things measured that day on a Node command that threw on its first
 * line. The command was walked, `check` recorded it, `ship` blessed it, and from then on:
 *
 *   1. the tool reported a product that could not start as one where nothing had changed —
 *      because two refusals were stored as ordinary values, and two of those are equal;
 *   2. `ship` printed "All 7 addresses it was watched at answered the same way twice" and
 *      made that the definition of working;
 *   3. the day the product was fixed, four findings arrived that nobody had caused, and on a
 *      bigger fixture one of them landed in the money class, which no agent may wave through.
 *
 * The third one has a test of its own at the bottom, because it is the one that would be
 * quietly re-broken by anybody tidying the comparison up: "the reference has no answer here
 * and the build does" looks exactly like "this appeared", and it is the opposite of a
 * regression.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  NO_ANSWER_KEY,
  noAnswer,
  comparability,
  isNoAnswer,
  isAnswer,
  isNeverCompared,
  asMarkedValue,
  answeredAnything,
  refusalsIn,
  compareAnswers,
} from '../../src/v2/refusal.js';
import { diffCaptures, makeObservation } from '../../src/v2/observation.js';
import { openStore, ensureStore, saveBuild, saveCapture, latestCapture, setReference, newCaptureId } from '../../src/v2/store.js';
import { runCheck } from '../../src/v2/run.js';
import { scratchDir, cleanUp } from '../support.mjs';

after(cleanUp);

const PRODUCT = 'poisonshop';

/** The words `notCovered` in the adapter contract has always written. */
const OLD_STRING_FORM = 'not checked — the thing being observed fell over before it could be read';
/** The words `howLongItTook` writes. Never a hole, and never a difference either. */
const NEVER_COMPARED_FORM = 'not compared — a stopwatch measures how busy this machine was at least as much as it measures the product, so the number is recorded and never compared';

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

// ---------------------------------------------------------------------------
// The kind itself
// ---------------------------------------------------------------------------

describe('a refusal is a different kind of thing from a value', () => {
  test('the three kinds are told apart, in the new shape and in the one already on every disk', () => {
    assert.equal(comparability('total: 5'), 'answer');
    assert.equal(comparability(0), 'answer');
    assert.equal(comparability(null), 'answer');
    assert.equal(comparability({ ok: true }), 'answer');

    assert.equal(comparability(noAnswer('crashed', 'it fell over')), 'no-answer');
    assert.equal(comparability(OLD_STRING_FORM), 'no-answer', 'every store already holds refusals written as this string');

    assert.equal(comparability(NEVER_COMPARED_FORM), 'never-compared');
    assert.equal(comparability(noAnswer('measures the machine', 'a stopwatch')), 'never-compared');

    assert.equal(isNoAnswer(OLD_STRING_FORM), true);
    assert.equal(isAnswer(OLD_STRING_FORM), false);
    assert.equal(isNeverCompared(NEVER_COMPARED_FORM), true);
  });

  test('a product cannot print its way into being a refusal', () => {
    // The whole reason the kind is a marked object rather than a magic string: a product's
    // own output is a string, and any sentinel a product could print is a sentinel that
    // stops working the day somebody prints it. The two prefixes are recognised only
    // because they are what the tool itself has been writing.
    assert.equal(isAnswer('not checkedX something'), true);
    assert.equal(isAnswer('the file said "not checked" in it'), true);
    assert.equal(isAnswer({ [NO_ANSWER_KEY]: 7 }), true, 'the marker has to be a reason string, not any value at all');
  });

  test('the old string form becomes the marked form on the way out of the store, and nothing else moves', async () => {
    const root = await scratchDir('staysfixed-refusal-store');
    const store = openStore({ root });
    await ensureStore(store);
    await saveBuild(store, { id: 'build-1', product: PRODUCT });
    await saveCapture(
      store,
      capture({
        observations: [
          obs('cli.walk.ran at all', OLD_STRING_FORM, 'complaints'),
          obs('cli.walk.stdout', 'total: 5'),
          obs('count.walk.duration', NEVER_COMPARED_FORM, 'counters'),
        ],
      }),
    );

    const read = await latestCapture(store, { buildId: 'build-1', journey: 'walk' });
    assert.ok(read, 'the capture has to come back at all before anything can be said about its values');
    const byPath = new Map(read.observations.map((o) => [o.path, o.value]));
    assert.equal(comparability(byPath.get('cli.walk.ran at all')), 'no-answer');
    assert.deepEqual(byPath.get('cli.walk.ran at all'), {
      [NO_ANSWER_KEY]: 'refused',
      why: 'the thing being observed fell over before it could be read',
    });
    assert.equal(byPath.get('cli.walk.stdout'), 'total: 5', 'a real value must come back exactly as it was written');
    assert.equal(comparability(byPath.get('count.walk.duration')), 'never-compared');
  });

  test('asMarkedValue leaves an answer alone', () => {
    const value = { a: 1, b: [2, 3] };
    assert.equal(asMarkedValue(value), value);
    assert.equal(asMarkedValue('hello'), 'hello');
  });
});

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

describe('two refusals do not compare equal, and a refusal never becomes a finding', () => {
  test('THE BUG: the plain comparison calls two refusals the same, which is the silence that read as a pass', () => {
    // Kept as a test rather than a comment because it is the thing that was true and has to
    // stay visible: `diffCaptures` is right, and it is right about VALUES. It was being
    // handed refusals.
    const was = [obs('cli.walk.ran at all', OLD_STRING_FORM, 'complaints')];
    const now = [obs('cli.walk.ran at all', OLD_STRING_FORM, 'complaints')];
    assert.deepEqual(diffCaptures(was, now), [], 'two refusals are the same string, so nothing differs — and nothing is known either');
  });

  test('compareAnswers reports the same pair as an address that answered on neither build', () => {
    const was = capture({ observations: [obs('cli.walk.ran at all', OLD_STRING_FORM, 'complaints'), obs('cli.walk.stdout', 'total: 5')] });
    const now = capture({ build: 'build-2', observations: [obs('cli.walk.ran at all', OLD_STRING_FORM, 'complaints'), obs('cli.walk.stdout', 'total: 5')] });

    const { differences, uncompared } = compareAnswers(was, now);
    assert.deepEqual(differences, [], 'the addresses that answered on both sides really do agree');
    assert.equal(uncompared.length, 1);
    assert.equal(uncompared[0].path, 'cli.walk.ran at all');
    assert.equal(uncompared[0].kind, 'never-answered');
    assert.match(uncompared[0].why, /fell over/);
  });

  test('an answer where the standard has a refusal is NOT a finding — it is coverage that has just arrived', () => {
    const was = capture({ observations: [obs('api.pay.answered at all', OLD_STRING_FORM)] });
    const now = capture({ build: 'build-2', observations: [obs('api.pay.answered at all', 'charged: 10')] });

    const { differences, uncompared } = compareAnswers(was, now);
    assert.deepEqual(differences, [], 'this is the phantom: nobody caused it, and it used to arrive as a difference');
    assert.equal(uncompared.length, 1);
    assert.equal(uncompared[0].kind, 'recovered');
  });

  test('a refusal where the standard has an answer is NOT a finding either — it is coverage taken away', () => {
    const was = capture({ observations: [obs('api.pay.answered at all', 'charged: 10')] });
    const now = capture({ build: 'build-2', observations: [obs('api.pay.answered at all', OLD_STRING_FORM)] });

    const { differences, uncompared } = compareAnswers(was, now);
    assert.deepEqual(differences, [], 'there is no answer here to differ from, so calling it a change would be inventing one');
    assert.equal(uncompared.length, 1);
    assert.equal(uncompared[0].kind, 'lost', 'and this is the one that must take the verdict down');
  });

  test('a value the tool never compares is never a difference, in any direction', () => {
    // Measured 2026-08-31: `count.pay.duration` APPEARED — the reference had no record of
    // that journey at all — and came back as a finding in the money class, which no agent may
    // wave through. So a phantom went to a person and stayed there. The value is a fixed
    // string precisely so it can never differ; nothing had stopped it appearing or vanishing.
    const appeared = compareAnswers(capture({ observations: [] }), capture({ build: 'b2', observations: [obs('count.pay.duration', NEVER_COMPARED_FORM, 'counters')] }));
    assert.deepEqual(appeared.differences, []);
    assert.deepEqual(appeared.uncompared, [], 'and it is not a hole either — the coverage list already explains it');

    const vanished = compareAnswers(capture({ observations: [obs('count.pay.duration', NEVER_COMPARED_FORM, 'counters')] }), capture({ build: 'b2', observations: [] }));
    assert.deepEqual(vanished.differences, []);
    assert.deepEqual(vanished.uncompared, []);
  });

  test('real differences still come through untouched', () => {
    const was = capture({ observations: [obs('cli.walk.stdout', 'total: 5'), obs('cli.walk.gone', 'here')] });
    const now = capture({ build: 'b2', observations: [obs('cli.walk.stdout', 'total: 6'), obs('cli.walk.new', 'hello')] });

    const { differences } = compareAnswers(was, now);
    const byKind = Object.fromEntries(differences.map((d) => [d.path, d.kind]));
    assert.deepEqual(byKind, { 'cli.walk.stdout': 'changed', 'cli.walk.gone': 'vanished', 'cli.walk.new': 'appeared' });
  });
});

// ---------------------------------------------------------------------------
// A whole walk that never reached the product
// ---------------------------------------------------------------------------

describe('a walk that never reached the product is not a side of a comparison', () => {
  test('a crash record is full of real facts and still means the product was never observed', () => {
    // This is the case a channel count cannot see, and it is the exact shape of the bug: a
    // command that throws on its first line fills the complaints channel with a genuine stack
    // trace and a genuine exit code. Both are facts about a crash. Two builds that crash the
    // same way then agree at every address.
    const crashed = capture({
      observations: [
        obs('cli.walk.ran at all', OLD_STRING_FORM, 'complaints'),
        obs('cli.walk.stderr', 'Error: ENOENT settings.json\n  at file:///app.js:3', 'complaints'),
        obs('cli.walk.exit', 1, 'complaints'),
        obs('cli.walk.stdout', ''),
      ],
    });
    assert.equal(answeredAnything(crashed), false, 'the adapter said it never got there, and that word has to win');
    assert.equal(refusalsIn(crashed).length, 1);
  });

  test('a walk with real answers is a side of a comparison, even where some of it refused', () => {
    const partly = capture({
      journey: 'walk',
      observations: [
        obs('cli.walk.stdout', 'total: 5'),
        obs('cli.walk.card', 'not checked — doing this for real would spend money, send a message, or destroy data'),
      ],
    });
    assert.equal(answeredAnything(partly), true);

    // And the refusal that stops a walk being a side of a comparison has to be THIS walk's
    // own. Anything else and one refusal shaped like the sentence takes down a journey it
    // says nothing about, and every real difference in that journey goes with it.
    const elsewhere = capture({
      journey: 'walk',
      observations: [obs('cli.walk.stdout', 'total: 5'), obs('api.pay.answered at all', OLD_STRING_FORM)],
    });
    assert.equal(answeredAnything(elsewhere), true);
  });

  test('a source read is neither evidence that it ran nor evidence that it would not', () => {
    const doorsOnly = capture({ observations: [obs('export.app%2Ejs.total', 'a function taking (a, b)', 'contract')] });
    assert.equal(answeredAnything(doorsOnly), true, 'a door read is the coverage ledger\'s business, not this one\'s');
  });
});

// ---------------------------------------------------------------------------
// The whole loop, end to end
// ---------------------------------------------------------------------------

/**
 * A check driven with a walk that hands back whatever the test says it saw.
 *
 * @param {{root: string, store: any}} where
 * @param {{build: string, byJourney: Record<string, any[]>}} now
 * @returns {Promise<any>}
 */
async function checkWith(where, now) {
  const journeys = Object.keys(now.byJourney).map((name) => ({
    name,
    describe: name,
    source: /** @type {const} */ ('code'),
    surface: /** @type {const} */ ('cli'),
    steps: [],
  }));
  return runCheck({
    store: where.store,
    product: PRODUCT,
    candidate: { id: now.build, product: PRODUCT },
    journeys: /** @type {any} */ (journeys),
    cwd: where.root,
    storedOnly: true,
    walk: async (/** @type {any} */ req) =>
      capture({ journey: req.journey.name, build: req.build.id, run: req.run, observations: now.byJourney[req.journey.name] }),
  });
}

/**
 * A store whose reference is a build that refused everywhere — which is what `ship` used to
 * let through, and what `--force` still lets through on purpose.
 *
 * @param {Record<string, any[]>} byJourney
 * @returns {Promise<{root: string, store: any}>}
 */
async function storeWithReference(byJourney) {
  const root = await scratchDir('staysfixed-refusal-loop');
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

describe('the run this whole file is about', () => {
  test('a product that refuses on both builds is NOT reported as a product where nothing has changed', async () => {
    const refused = [
      obs('cli.add-up.ran at all', OLD_STRING_FORM, 'complaints'),
      obs('cli.add-up.stderr', 'Error: ENOENT settings.json', 'complaints'),
      obs('cli.add-up.exit', 1, 'complaints'),
    ];
    const where = await storeWithReference({ 'add-up': refused });

    // The new build is broken in the same way AND its behaviour has been rewritten
    // underneath — which is what makes this the dangerous case rather than merely a sad one.
    const verdict = await checkWith(where, {
      build: 'work-build',
      byJourney: {
        'add-up': [
          obs('cli.add-up.ran at all', OLD_STRING_FORM, 'complaints'),
          obs('cli.add-up.stderr', 'Error: ENOENT settings.json', 'complaints'),
          obs('cli.add-up.exit', 1, 'complaints'),
        ],
      },
    });

    assert.equal(verdict.findings.length, 0, 'there is nothing here to report, and that is not the same as everything being fine');
    assert.equal(verdict.ok, false, 'no answer is not a pass');
    assert.doesNotMatch(verdict.summary, /Nothing that worked has changed/, 'the one sentence this tool may never say about a product that cannot start');
    assert.match(verdict.summary, /NO ANSWER FROM THIS RUN/);
    const gaps = verdict.coverage.gaps.map((/** @type {any} */ g) => `${g.what} ${g.why}`).join(' | ');
    assert.match(gaps, /never got the product to do anything/);
  });

  test('fixing the product produces NO findings nobody caused', async () => {
    const where = await storeWithReference({
      'add-up': [
        obs('cli.add-up.ran at all', OLD_STRING_FORM, 'complaints'),
        obs('cli.add-up.exit', 1, 'complaints'),
      ],
      greet: [obs('cli.greet.stdout', 'greeting: hello')],
    });

    const verdict = await checkWith(where, {
      build: 'work-build',
      byJourney: {
        // The product now works. Every one of these is an answer the standard has no record
        // of, and every one of them arrived as a difference before 2026-08-31.
        'add-up': [
          obs('cli.add-up.stdout', 'total: 5'),
          obs('cli.add-up.exit', 0, 'complaints'),
          obs('count.add-up.duration', NEVER_COMPARED_FORM, 'counters'),
          obs('file.add-up.total.txt', { what: 'created', contents: '5' }, 'effects'),
        ],
        greet: [obs('cli.greet.stdout', 'greeting: hello')],
      },
    });

    assert.equal(verdict.findings.length, 0, 'a product that started working is not a pile of regressions');
    const gaps = verdict.coverage.gaps.map((/** @type {any} */ g) => `${g.what} ${g.why}`).join(' | ');
    assert.match(gaps, /never got the product to do anything there/, 'and it has to be said out loud, not simply left out');
    assert.match(verdict.summary, /add-up|not compared|coverage/i);
  });

  test('a build that stops answering at one address, while the rest of the journey still runs, is not a pass', async () => {
    // The journey itself still reaches the product — this is one address inside it going
    // dark, which is the quiet version and the one nothing would have said a word about.
    const where = await storeWithReference({
      pay: [obs('api.pay.status', 200), obs('api.pay.receipt', 'receipt-7'), obs('api.pay.body', '{"ok":true}')],
    });

    const verdict = await checkWith(where, {
      build: 'work-build',
      byJourney: {
        pay: [
          obs('api.pay.status', 200),
          obs('api.pay.receipt', OLD_STRING_FORM),
          obs('api.pay.body', '{"ok":true}'),
        ],
      },
    });

    assert.equal(verdict.findings.length, 0, 'there is no answer here to differ from, so inventing a change would be worse');
    assert.equal(verdict.ok, false, 'coverage this build took away is not a pass');
    assert.doesNotMatch(verdict.summary, /^Nothing that worked has changed/);
    assert.match(verdict.summary, /coverage this build has taken away/);
  });

  test('a real regression is still caught, with refusals sitting beside it', async () => {
    const where = await storeWithReference({
      shop: [
        obs('cli.shop.stdout', 'total: 10.00'),
        obs('api.pay.answered at all', OLD_STRING_FORM),
      ],
    });

    const verdict = await checkWith(where, {
      build: 'work-build',
      byJourney: {
        shop: [
          obs('cli.shop.stdout', 'total: 9.99'),
          obs('api.pay.answered at all', OLD_STRING_FORM),
        ],
      },
    });

    assert.equal(verdict.ok, false);
    assert.equal(verdict.findings.length, 1, 'the refusal must not swallow the difference next to it');
    assert.match(String(verdict.findings[0].title), /9\.99/);
  });
});

// ---------------------------------------------------------------------------
// Nothing may quietly turn a refusal back into a string
// ---------------------------------------------------------------------------

describe('the kind cannot fall back to being a string', () => {
  test('every place in v2 that compares an observed value goes through the refusal rule', async () => {
    // A grep standing over the design. `diffCaptures` and `sameValue` are the tool's one
    // comparison and they are right to be value-blind; what must not happen is a second
    // caller appearing that hands them refusals. The two that may is observation.js itself
    // (which owns them) and refusal.js (which filters first).
    const dir = path.join(process.cwd(), 'src', 'v2');
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.js'));
    /** @type {string[]} */
    const callers = [];
    for (const file of files) {
      if (file === 'observation.js' || file === 'refusal.js') continue;
      const text = await fsp.readFile(path.join(dir, file), 'utf8');
      // Only real calls count. The word appearing in a comment is somebody explaining the
      // rule, which is the opposite of breaking it.
      const lines = text.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'));
      if (lines.some((line) => /\bdiffCaptures\s*\(/.test(line))) callers.push(file);
    }
    assert.deepEqual(callers, [], `these call diffCaptures directly and would compare refusals as values: ${callers.join(', ')}`);
  });
});
