/**
 * TWO IDENTICAL RUNS MUST NOT DISAGREE WITH EACH OTHER.
 *
 * The whole method of this tool is running the same thing twice and subtracting whatever the
 * product cannot agree with itself about. So a run that reports a change on a tree nobody
 * touched is not untidy — it is the measurement contradicting the method, and an owner who
 * sees it once has no reason to believe the next report either.
 *
 * WHAT WAS HAPPENING. Measured 2026-08-31 on a stock Next.js app with two pages and a link
 * between them, and again on a four-second stand-in built to the same shape. Nothing was
 * edited between the runs — `git status` was clean and the tree was byte-identical — and run
 * after run the report said:
 *
 *     In what the program complains about, "never finished" is there now and was not before.
 *     It says "net::ERR_ABORTED".
 *       net.page /.GET /books?_rsc.never finished
 *     X 1 thing behaves differently
 *
 * That address is Next.js's own link prefetch. The browser starts it and, when the page is
 * torn down at the end of the walk, cancels it — so whether it is there at all depends on
 * which of the two finished first. It lands in about four runs out of five.
 *
 * THE PART THAT MADE IT A LIE. When nothing has been edited, the build being checked and the
 * build on record as working are THE SAME BUILD — same id, same folder of stored runs. The
 * record of "the old build" is read back as the newest run in that folder, which is the
 * PREVIOUS check's. So an everyday check on an untouched tree was comparing this run against
 * the last run of the very same build, and calling every flicker between them a change that
 * nobody asked for. Ten checks of one unchanged product, minutes apart, produced three
 * reports of a difference, one report that "the change made something non-deterministic", and
 * six clean ones — from identical bytes.
 *
 * WHAT IS TRUE INSTEAD. Two runs of one build are a WOBBLE MEASUREMENT. That is the tool's
 * own word for it, and `measureWobble` already refuses to be handed two different builds
 * because the distinction matters. Nothing measured that way can be a change, because there
 * was no change; and nothing measured that way can be a change that "made something
 * unpredictable" either, because the address was already unpredictable and all that happened
 * is that it was watched for longer.
 *
 * Nothing is hidden by this. Every difference is still counted and still named — it moves
 * from the change list to the wobble list, where it says the true thing about the product:
 * this address does not sit still. That is more information than "1 thing behaves
 * differently", not less.
 *
 * The last two tests are the guard on the guard: with a genuinely different build on the
 * other side, every one of these differences is real again and newly-unstable still fires.
 * A quiet report is only allowed when the two sides really are one build.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { diffCaptures, measureWobble, subtractWobble } from '../../src/v2/observation.js';

/**
 * A capture, written as short as the shape allows so the tests read as arithmetic.
 *
 * @param {'a'|'b'} which
 * @param {Record<string, unknown>} values   path -> value
 * @param {{build?: string}} [opts]
 * @returns {any}
 */
function capture(which, values, opts = {}) {
  return {
    id: `2026-run-${which}-${Math.random().toString(36).slice(2, 5)}`,
    journey: 'page /',
    build: { id: opts.build ?? 'git-04befe5', product: 'nextapp' },
    run: which,
    startedAt: '2026-08-31T08:00:00.000Z',
    durationMs: 100,
    observations: Object.entries(values).map(([path, value]) => ({
      path,
      channel: path.endsWith('never finished') ? 'complaints' : 'results',
      value,
    })),
  };
}

/** The address the Next.js app actually flickered at, spelled the way the report spells it. */
const PREFETCH = 'net.page /.GET /books?_rsc.never finished';

describe('a check of a build against itself', () => {
  test('reports no change at all, because there was no change', () => {
    // The previous check's run, read back out of the same build's folder as "the old build".
    const before = capture('a', { 'api.page /.GET /.answered': 200 });
    // This check's two runs. Both of them saw the cancelled prefetch, so the two-run wobble
    // measurement inside this check cannot see anything wrong — which is exactly why the
    // phantom survived it.
    const nowA = capture('a', { 'api.page /.GET /.answered': 200, [PREFETCH]: 'net::ERR_ABORTED' });
    const nowB = capture('b', { 'api.page /.GET /.answered': 200, [PREFETCH]: 'net::ERR_ABORTED' });

    const differences = diffCaptures(before, nowA);
    assert.equal(differences.length, 1, 'the two runs really did differ — that part was never in doubt');

    const out = subtractWobble(differences, measureWobble(nowA, nowB), {
      referenceBuildId: 'git-04befe5',
    });

    assert.deepEqual(
      out.real.map((d) => d.path),
      [],
      'nothing may be called a change when both sides are the same build',
    );
    assert.equal(out.noise.length, 1, 'and it is still counted — moved, never dropped in silence');
    assert.equal(out.noise[0].path, PREFETCH, 'and still named, so an owner can go and look at it');
    assert.equal(out.sameBuild, true);
  });

  test('says in plain words that it compared one build with itself', () => {
    const before = capture('a', { 'api.page /.GET /.answered': 200 });
    const nowA = capture('a', { 'api.page /.GET /.answered': 200, [PREFETCH]: 'net::ERR_ABORTED' });
    const nowB = capture('b', { 'api.page /.GET /.answered': 200, [PREFETCH]: 'net::ERR_ABORTED' });

    const out = subtractWobble(diffCaptures(before, nowA), measureWobble(nowA, nowB), {
      referenceBuildId: 'git-04befe5',
    });

    assert.match(
      out.note,
      /one build/i,
      'the reader has to be told why the answer is quiet, or the quiet is worth nothing',
    );
    assert.match(out.note, /1 address/, 'and told how many addresses would not sit still across the two');
    assert.match(out.note, /ship again/, 'and told the one thing that would give the next run something to compare against');
  });

  test('never claims a change made something unpredictable, because there was no change', () => {
    // The address was steady in the run being used as the record, and flickers across this
    // check's two runs. That is the exact shape that used to print "the change made something
    // non-deterministic" on a tree with nothing changed in it.
    const before = capture('a', { 'api.page /.GET /books.answered': 200 });
    const nowA = capture('a', { 'api.page /.GET /books.answered': 200 });
    const nowB = capture('b', {});

    const out = subtractWobble(diffCaptures(before, nowA), measureWobble(nowA, nowB), {
      referenceBuildId: 'git-04befe5',
      steadyInReference: ['api.page /.GET /books.answered'],
    });

    assert.deepEqual(out.newlyUnstable, []);
    assert.equal(
      out.couldTellNewlyUnstable,
      false,
      'and it says it could not tell, rather than saying nothing became unstable',
    );
    assert.doesNotMatch(out.note, /the change made something non-deterministic/);
  });

  test('a wobble the check could not measure is still not a change against the same build', () => {
    // One run only. Without the fix this is the worst version of the phantom: nothing was
    // subtracted at all, so every flicker between two runs of one build came back as real.
    const before = capture('a', { 'api.page /.GET /.answered': 200 });
    const now = capture('a', { 'api.page /.GET /.answered': 200, [PREFETCH]: 'net::ERR_ABORTED' });

    const out = subtractWobble(diffCaptures(before, now), measureWobble(now, capture('b', { 'api.page /.GET /.answered': 200, [PREFETCH]: 'net::ERR_ABORTED' })), {
      referenceBuildId: 'git-04befe5',
    });
    assert.deepEqual(out.real, []);
  });
});

describe('a check against a genuinely different build still catches everything', () => {
  test('the same difference is real when the other side is another build', () => {
    const before = capture('a', { 'api.page /.GET /.answered': 200 }, { build: 'git-cc72f41' });
    const nowA = capture('a', { 'api.page /.GET /.answered': 500 });
    const nowB = capture('b', { 'api.page /.GET /.answered': 500 });

    const out = subtractWobble(diffCaptures(before, nowA), measureWobble(nowA, nowB), {
      referenceBuildId: 'git-cc72f41',
    });

    assert.equal(out.real.length, 1, 'a page that started refusing is exactly what this tool is for');
    assert.equal(out.real[0].path, 'api.page /.GET /.answered');
    assert.equal(out.sameBuild, undefined);
    assert.doesNotMatch(out.note, /same build/i);
  });

  test('newly unpredictable still fires across two different builds', () => {
    const before = capture('a', { 'api.page /.GET /books.answered': 200 }, { build: 'git-cc72f41' });
    const nowA = capture('a', { 'api.page /.GET /books.answered': 200 });
    const nowB = capture('b', {});

    const out = subtractWobble(diffCaptures(before, nowA), measureWobble(nowA, nowB), {
      referenceBuildId: 'git-cc72f41',
      steadyInReference: ['api.page /.GET /books.answered'],
    });

    assert.equal(out.couldTellNewlyUnstable, true);
    assert.deepEqual(
      out.newlyUnstable.map((e) => e.path),
      ['api.page /.GET /books.answered'],
      'somebody made this unpredictable, and that is a finding even though no value is wrong',
    );
  });

  test('with no build id given at all, nothing changes from how it behaved before', () => {
    // Every caller that has not been told about this keeps the old behaviour exactly.
    const before = capture('a', { 'api.page /.GET /.answered': 200 });
    const nowA = capture('a', { 'api.page /.GET /.answered': 500 });
    const nowB = capture('b', { 'api.page /.GET /.answered': 500 });

    const out = subtractWobble(diffCaptures(before, nowA), measureWobble(nowA, nowB));
    assert.equal(out.real.length, 1);
    assert.equal(out.sameBuild, undefined);
  });
});
