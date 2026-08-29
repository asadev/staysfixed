/**
 * Wobble subtraction — the idea the whole tool stands on.
 *
 * There is no tolerance setting in version 2 and there is never going to be one.
 * Instead the new build is run TWICE, and anything the product cannot agree with
 * itself about is subtracted arithmetically. Nobody guesses a number.
 *
 * Three things have to be true, and this file is here to hold them:
 *   the noise goes away,
 *   a real difference survives it,
 *   and something that was steady before and is not steady now is a FINDING —
 *   because a change that made a product unpredictable has broken something,
 *   even though no single value can be pointed at.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { diffCaptures, measureWobble, subtractWobble, unmeasuredWobble, mergeWobble } from '../../src/v2/observation.js';

/**
 * A capture, as short as the shape allows, so the tests read as arithmetic.
 *
 * @param {'a'|'b'|'single'} which
 * @param {Record<string, unknown>} values   path -> value
 * @param {{build?: string, journey?: string}} [opts]
 * @returns {any}
 */
function capture(which, values, opts = {}) {
  return {
    id: `2026-run-${which}`,
    journey: opts.journey ?? 'the shop opens',
    build: { id: opts.build ?? 'new', product: 'shop' },
    run: which,
    startedAt: '2026-08-29T10:00:00.000Z',
    durationMs: 100,
    observations: Object.entries(values).map(([path, value]) => ({ path, channel: channelFor(path), value })),
  };
}

/** The channel is written on every observation; the address's first word tells us which. */
function channelFor(/** @type {string} */ path) {
  if (path.startsWith('screen.')) return 'meaning';
  if (path.startsWith('net.') || path.startsWith('file.')) return 'effects';
  if (path.startsWith('log.')) return 'complaints';
  if (path.startsWith('count.')) return 'counters';
  if (path.startsWith('route.') || path.startsWith('ipc.')) return 'contract';
  return 'results';
}

describe('measuring what a build disagrees with itself about', () => {
  test('two runs that agree wobble about nothing', () => {
    const wobble = measureWobble(capture('a', { 'cli.build.exit': 0 }), capture('b', { 'cli.build.exit': 0 }));
    assert.deepEqual(wobble.unstable, []);
    assert.equal(wobble.steady, 1, 'and it counts what DID sit still, so the quiet can be shown to be earned');
    assert.equal(wobble.measured, true);
  });

  test('it names every address the two runs disagreed about, and only those', () => {
    const a = capture('a', { 'count.boot.ms': 812, 'cli.build.exit': 0 });
    const b = capture('b', { 'count.boot.ms': 907, 'cli.build.exit': 0 });
    assert.deepEqual(measureWobble(a, b).unstable, ['count.boot.ms']);
  });

  test('an address only one of the two runs saw at all is wobble', () => {
    const wobble = measureWobble(capture('a', { 'net.GET./health.status': 200 }), capture('b', {}));
    assert.deepEqual(wobble.unstable, ['net.GET./health.status']);
  });

  test('it refuses to measure across two different builds', () => {
    // Two builds disagreeing is a DIFFERENCE. Calling it wobble would subtract
    // the very thing the tool exists to report.
    assert.throws(
      () => measureWobble(capture('a', { 'cli.build.exit': 0 }, { build: 'old' }), capture('b', { 'cli.build.exit': 1 }, { build: 'new' })),
      /different builds/i
    );
  });

  test('a build that was only run once says so instead of claiming a clean list', () => {
    const wobble = unmeasuredWobble('new', 'the shop opens');
    assert.equal(wobble.measured, false);
    const out = subtractWobble([], wobble);
    assert.match(out.note, /only run once/i, 'the summary has to admit that nothing was subtracted');
  });

  test('one unmeasured journey makes the whole merged record unmeasured', () => {
    // Anything else would be a summary claiming a clean subtraction over a list
    // that is partly raw.
    const measured = measureWobble(capture('a', { 'cli.build.exit': 0 }), capture('b', { 'cli.build.exit': 0 }));
    assert.equal(mergeWobble([measured, unmeasuredWobble('new', 'another journey')]).measured, false);
  });
});

describe('subtracting it from a comparison', () => {
  test('noise is removed and never reported', () => {
    // The clock differs from the reference AND differs between the two new runs.
    // That is the product disagreeing with itself, not the change doing something.
    const reference = capture('single', { 'cli.build.log': 'started 11:00:01' }, { build: 'old' });
    const a = capture('a', { 'cli.build.log': 'started 12:31:44' });
    const b = capture('b', { 'cli.build.log': 'started 12:31:59' });

    const out = subtractWobble(diffCaptures(reference, a), measureWobble(a, b));
    assert.deepEqual(out.real, [], 'a value the product cannot agree with itself about proves nothing');
    assert.equal(out.noise.length, 1, 'and it is counted as noise, so the quiet can be shown to be earned');
    assert.equal(out.noise[0].wobbling, true);
  });

  test('a real difference survives it', () => {
    // Both new runs agree with each other and disagree with the reference.
    // Nothing can explain that away.
    const reference = capture('single', { 'screen.settings.button:Save.enabled': true }, { build: 'old' });
    const a = capture('a', { 'screen.settings.button:Save.enabled': false });
    const b = capture('b', { 'screen.settings.button:Save.enabled': false });

    const out = subtractWobble(diffCaptures(reference, a), measureWobble(a, b));
    assert.equal(out.real.length, 1);
    assert.equal(out.real[0].path, 'screen.settings.button:Save.enabled');
    assert.equal(out.real[0].kind, 'changed');
    assert.equal(out.real[0].reference, true);
    assert.equal(out.real[0].candidate, false);
  });

  test('a door that closed is a difference, not an absence', () => {
    const reference = capture('single', { 'route.GET./billing.exists': true }, { build: 'old' });
    const now = capture('a', {});

    const differences = diffCaptures(reference, now);
    assert.equal(differences.length, 1, 'a route that used to exist and now does not is the loudest finding there is');
    assert.equal(differences[0].kind, 'vanished');
    assert.equal(differences[0].candidate, undefined);
  });

  test('a call going out that never went out before is a difference too', () => {
    const differences = diffCaptures(capture('single', {}, { build: 'old' }), capture('a', { 'net.POST./track.count': 1 }));
    assert.equal(differences.length, 1);
    assert.equal(differences[0].kind, 'appeared');
    assert.equal(differences[0].reference, undefined);
  });

  test('nothing is mutated on the way through', () => {
    const reference = capture('single', { 'cli.build.exit': 0 }, { build: 'old' });
    const a = capture('a', { 'cli.build.exit': 1 });
    const differences = diffCaptures(reference, a);
    subtractWobble(differences, measureWobble(a, capture('b', { 'cli.build.exit': 1 })));
    assert.equal('real' in differences[0], false, 'a flag written into the caller’s list becomes a fact nobody can trace back');
  });

  test('one noisy address does not hide a real change sitting next to it', () => {
    const reference = capture('single', { 'count.boot.ms': 800, 'screen.home.heading.name': 'Your shop' }, { build: 'old' });
    const a = capture('a', { 'count.boot.ms': 812, 'screen.home.heading.name': 'Your store' });
    const b = capture('b', { 'count.boot.ms': 907, 'screen.home.heading.name': 'Your store' });

    const out = subtractWobble(diffCaptures(reference, a), measureWobble(a, b));
    assert.deepEqual(
      out.real.map((/** @type {any} */ d) => d.path),
      ['screen.home.heading.name']
    );
  });
});

describe('what was steady before and is not steady now', () => {
  test('is reported, and it is a finding in its own right', () => {
    const a = capture('a', { 'screen.list.first.name': 'Aisha' });
    const b = capture('b', { 'screen.list.first.name': 'Bilal' });
    const referenceWobble = measureWobble(
      capture('a', { 'screen.list.first.name': 'Aisha' }, { build: 'old' }),
      capture('b', { 'screen.list.first.name': 'Aisha' }, { build: 'old' })
    );

    const out = subtractWobble([], measureWobble(a, b), { referenceWobble });
    assert.equal(out.couldTellNewlyUnstable, true);
    assert.deepEqual(
      out.newlyUnstable.map((/** @type {any} */ e) => e.path),
      ['screen.list.first.name']
    );
  });

  test('even when one of the two runs happens to match the old build exactly', () => {
    // The nastiest shape there is: a plain comparison sees nothing at all,
    // because one run agrees with the reference. The product has still become
    // unpredictable, and that IS the finding.
    const reference = capture('single', { 'cli.total.line': 'total 12.50' }, { build: 'old' });
    const a = capture('a', { 'cli.total.line': 'total 12.50' });
    const b = capture('b', { 'cli.total.line': 'total 12.5' });
    const referenceWobble = measureWobble(
      capture('a', { 'cli.total.line': 'total 12.50' }, { build: 'old' }),
      capture('b', { 'cli.total.line': 'total 12.50' }, { build: 'old' })
    );

    assert.deepEqual(diffCaptures(reference, a), [], 'nothing changed, as far as one run can tell');

    const out = subtractWobble(diffCaptures(reference, a), measureWobble(a, b), { referenceWobble });
    assert.equal(out.newlyUnstable.length, 1, 'and yet the change made it unpredictable, which is the whole point of running twice');
  });

  test('something that was never steady becoming unsteady is not news', () => {
    const a = capture('a', { 'count.boot.ms': 812 });
    const b = capture('b', { 'count.boot.ms': 907 });
    const referenceWobble = measureWobble(
      capture('a', { 'count.boot.ms': 800 }, { build: 'old' }),
      capture('b', { 'count.boot.ms': 850 }, { build: 'old' })
    );

    const out = subtractWobble([], measureWobble(a, b), { referenceWobble });
    assert.deepEqual(out.newlyUnstable, []);
  });

  test('with no record of the old build it says it cannot tell, rather than claiming nothing', () => {
    const a = capture('a', { 'screen.list.first.name': 'Aisha' });
    const b = capture('b', { 'screen.list.first.name': 'Bilal' });

    const out = subtractWobble([], measureWobble(a, b));
    assert.equal(out.couldTellNewlyUnstable, false);
    assert.deepEqual(out.newlyUnstable, []);
    assert.match(out.note, /no record of how steady the old build was/i, 'silence and "I could not tell" are different answers');
  });
});
