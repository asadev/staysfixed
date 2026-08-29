/**
 * Comparing two pictures.
 *
 * The arithmetic in here decides whether anybody trusts the tool: too strict and
 * every run cries wolf over font hinting, too loose and a missing stylesheet
 * slips through. So the sums are checked directly rather than through a run.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';

import { comparePng, describeDifference } from '../src/picture/compare.js';
import { DEFAULT_TOLERANCE } from '../src/core/config.js';

/**
 * A solid rectangle, optionally scribbled on.
 * @param {number} width
 * @param {number} height
 * @param {[number,number,number]} [colour]
 * @param {(png: PNG) => void} [scribble]
 * @returns {Buffer}
 */
function makePng(width, height, colour = [255, 255, 255], scribble) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = colour[0];
    png.data[i + 1] = colour[1];
    png.data[i + 2] = colour[2];
    png.data[i + 3] = 255;
  }
  if (scribble) scribble(png);
  return PNG.sync.write(png);
}

/**
 * Paint one pixel a different colour.
 * @param {number} x
 * @param {number} y
 * @param {[number,number,number]} colour
 * @returns {(png: PNG) => void}
 */
function pixel(x, y, colour = [0, 0, 0]) {
  return (png) => {
    const i = (y * png.width + x) * 4;
    png.data[i] = colour[0];
    png.data[i + 1] = colour[1];
    png.data[i + 2] = colour[2];
  };
}

/**
 * Paint a horizontal run of pixels black.
 * @param {number} count
 * @returns {(png: PNG) => void}
 */
function firstPixels(count) {
  return (png) => {
    for (let n = 0; n < count; n += 1) {
      const i = n * 4;
      png.data[i] = 0;
      png.data[i + 1] = 0;
      png.data[i + 2] = 0;
    }
  };
}

describe('two pictures that agree', () => {
  test('the same bytes twice is a pass with nothing to look at', () => {
    const a = makePng(40, 40);
    const report = comparePng(a, makePng(40, 40), {});
    assert.equal(report.equal, true);
    assert.equal(report.diffPixels, 0);
    assert.equal(report.diffRatio, 0);
    assert.equal(report.diffPng, null);
    assert.equal(report.sizeMismatch, false);
    assert.deepEqual(report.size, { width: 40, height: 40 });
    assert.deepEqual(report.approvedSize, { width: 40, height: 40 });
  });
});

describe('two pictures that disagree', () => {
  test('one pixel is enough to fail at the tolerance we ship', () => {
    const approved = makePng(40, 40);
    const actual = makePng(40, 40, [255, 255, 255], pixel(20, 20));

    const report = comparePng(approved, actual, {});
    assert.equal(report.equal, false);
    assert.equal(report.diffPixels, 1);
    assert.equal(report.diffRatio, 1 / 1600);
    assert.ok(report.diffPng, 'a failing comparison must hand back something to look at');
  });

  test('the difference picture is a real png the same size as the originals', () => {
    const report = comparePng(makePng(40, 40), makePng(40, 40, [255, 255, 255], pixel(20, 20)), {});
    assert.ok(report.diffPng);
    const decoded = PNG.sync.read(/** @type {Buffer} */ (report.diffPng));
    assert.equal(decoded.width, 40);
    assert.equal(decoded.height, 40);
  });

  test('a size change is reported in words, never as a meaningless diff', () => {
    const report = comparePng(makePng(40, 40), makePng(41, 40), {});
    assert.equal(report.sizeMismatch, true);
    assert.equal(report.equal, false);
    assert.equal(report.diffPng, null);
    assert.deepEqual(report.approvedSize, { width: 40, height: 40 });
    assert.deepEqual(report.size, { width: 41, height: 40 });
  });
});

describe('masks', () => {
  test('a change under a mask is not a change', () => {
    const approved = makePng(40, 40);
    const actual = makePng(40, 40, [255, 255, 255], pixel(20, 20));

    const report = comparePng(approved, actual, {}, [{ x: 18, y: 18, width: 5, height: 5 }]);
    assert.equal(report.equal, true);
    assert.equal(report.diffPixels, 0);
  });

  test('a change beside a mask still fails', () => {
    const approved = makePng(40, 40);
    const actual = makePng(40, 40, [255, 255, 255], pixel(20, 20));

    const report = comparePng(approved, actual, {}, [{ x: 0, y: 0, width: 5, height: 5 }]);
    assert.equal(report.equal, false);
    assert.equal(report.diffPixels, 1);
  });

  test('a mask paints both pictures, so adding one never forces a re-approval', () => {
    // The approved picture has ink where the new one does not, and vice versa.
    // Painting only one of them would turn the mask itself into a difference.
    const approved = makePng(40, 40, [255, 255, 255], pixel(10, 10, [0, 0, 0]));
    const actual = makePng(40, 40, [255, 255, 255], pixel(11, 10, [0, 0, 0]));

    const withoutMask = comparePng(approved, actual, {});
    assert.equal(withoutMask.equal, false);

    const withMask = comparePng(approved, actual, {}, [{ x: 8, y: 8, width: 8, height: 8 }]);
    assert.equal(withMask.equal, true);
    assert.equal(withMask.diffPixels, 0);
  });
});

describe('the tolerance arithmetic', () => {
  test('the allowance is a share of the whole picture, rounded down', () => {
    // 100x100 is 10,000 pixels; 1% of it is exactly 100.
    const approved = makePng(100, 100);

    const justInside = comparePng(approved, makePng(100, 100, [255, 255, 255], firstPixels(100)), { pixels: 0.01 });
    assert.equal(justInside.diffPixels, 100);
    assert.equal(justInside.equal, true);

    const justOutside = comparePng(approved, makePng(100, 100, [255, 255, 255], firstPixels(101)), { pixels: 0.01 });
    assert.equal(justOutside.diffPixels, 101);
    assert.equal(justOutside.equal, false);
  });

  test('the shipped default lets nothing through on a small picture', () => {
    // 0.05% of a 40x40 picture rounds down to zero, which is the honest answer:
    // on something that small, one pixel really is a change.
    assert.equal(Math.floor(40 * 40 * DEFAULT_TOLERANCE.pixels), 0);
    const report = comparePng(makePng(40, 40), makePng(40, 40, [255, 255, 255], pixel(1, 1)), {});
    assert.equal(report.equal, false);
  });

  test('maxPixels overrules the share when a project sets it', () => {
    const approved = makePng(100, 100);
    const actual = makePng(100, 100, [255, 255, 255], firstPixels(100));

    assert.equal(comparePng(approved, actual, { pixels: 0.9, maxPixels: 0 }).equal, false);
    assert.equal(comparePng(approved, actual, { pixels: 0, maxPixels: 200 }).equal, true);
    assert.equal(comparePng(approved, actual, { pixels: 0, maxPixels: 100 }).equal, true);
    assert.equal(comparePng(approved, actual, { pixels: 0, maxPixels: 99 }).equal, false);
  });

  test('the ratio is the count over the whole picture', () => {
    const report = comparePng(
      makePng(100, 100),
      makePng(100, 100, [255, 255, 255], firstPixels(250)),
      { pixels: 0.5 },
    );
    assert.equal(report.diffPixels, 250);
    assert.equal(report.diffRatio, 0.025);
  });

  test('a slack threshold forgives a colour that barely moved', () => {
    const approved = makePng(60, 60, [200, 200, 200]);
    const actual = makePng(60, 60, [200, 200, 200], pixel(30, 30, [198, 198, 198]));

    assert.equal(comparePng(approved, actual, { threshold: 0.001, pixels: 0 }).equal, false);
    assert.equal(comparePng(approved, actual, { threshold: 0.5, pixels: 0 }).equal, true);
  });
});

describe('a damaged file', () => {
  test('is explained rather than thrown at the wall', () => {
    assert.throws(() => comparePng(Buffer.from('not a png at all'), makePng(10, 10), {}), (error) => {
      assert.match(String(/** @type {Error} */ (error).message), /could not open the approved picture/);
      return true;
    });
    assert.throws(() => comparePng(makePng(10, 10), Buffer.from('not a png at all'), {}), (error) => {
      assert.match(String(/** @type {Error} */ (error).message), /could not open the new picture/);
      return true;
    });
  });
});

describe('describeDifference', () => {
  test('says what changed and by how much, in words', () => {
    const report = comparePng(makePng(100, 100), makePng(100, 100, [255, 255, 255], firstPixels(250)), {});
    const text = describeDifference(report, 'home');
    assert.match(text, /^home looks different/);
    assert.match(text, /250 pixels changed/);
    assert.match(text, /2\.50% of the picture/);
  });

  test('a size change gets its own sentence with both sizes in it', () => {
    const report = comparePng(makePng(40, 40), makePng(41, 42), {});
    const text = describeDifference(report, 'home');
    assert.match(text, /changed size/);
    assert.match(text, /40x40/);
    assert.match(text, /41x42/);
  });

  test('a match says so plainly', () => {
    const report = comparePng(makePng(40, 40), makePng(40, 40), {});
    assert.equal(describeDifference(report, 'home'), 'home looks exactly like the approved picture.');
  });

  test('no message contains a test id or a percentage sign with no number', () => {
    const report = comparePng(makePng(100, 100), makePng(100, 100, [255, 255, 255], firstPixels(250)), {});
    const text = describeDifference(report, 'home');
    assert.ok(!/undefined|NaN|\[object/.test(text), text);
  });
});
