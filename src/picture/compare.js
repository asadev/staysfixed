/**
 * Comparing a fresh picture with the approved one.
 *
 * Two things here decide whether the tool is believed or ignored:
 * the masks are painted onto BOTH pictures (so hiding a clock hides it on the
 * old picture too, and adding a mask never forces a re-approval), and the
 * verdict is a pixel count against an explicit allowance rather than a vague
 * "looks close enough".
 */

import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { paintMasks } from '../freeze/mask.js';
import { DEFAULT_TOLERANCE } from '../core/config.js';
import { StaysFixedError } from '../core/errors.js';
import { pngSize } from './capture.js';

/**
 * Whether two pictures are the very same file.
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {boolean}
 */
export function sameBytes(a, b) {
  return Boolean(a) && Boolean(b) && a.length === b.length && a.equals(b);
}

/**
 * The same comparison, without the work when there is nothing to compare.
 *
 * On a healthy project every screen is unchanged, which means the new picture is the very
 * same file as the approved one — the encoder is deterministic, so identical pixels
 * produce identical bytes. Decoding two full retina PNGs to prove that costs a quarter of
 * a second per screen, every run, to reach a conclusion the file lengths already gave
 * away.
 *
 * This is not a looser check, it is the same answer arrived at honestly. Identical bytes
 * are identical pixels, so nothing differs, so nothing can exceed any allowance. Masks do
 * not change that: a mask paints the same rectangle onto both pictures, and painting the
 * same thing onto two identical pictures leaves them identical. The size comes out of the
 * PNG header, which is where `comparePng` would have got it too.
 *
 * @param {Buffer} approvedBuf
 * @param {Buffer} actualBuf
 * @param {import('../types.js').ToleranceConfig} tolerance
 * @param {import('../types.js').MaskRect[]} [maskRects]
 * @returns {import('../types.js').CompareReport}
 */
export function compareFast(approvedBuf, actualBuf, tolerance, maskRects = []) {
  if (sameBytes(approvedBuf, actualBuf)) {
    try {
      const size = pngSize(actualBuf);
      const allowed =
        tolerance.maxPixels ??
        Math.floor(size.width * size.height * (tolerance.pixels ?? DEFAULT_TOLERANCE.pixels));
      // A negative allowance is a setting that says even a perfect match is a failure.
      // Nonsense, but it is the caller's nonsense, and the long way round is the only one
      // that can answer it the same way it always has.
      if (allowed >= 0) {
        return {
          equal: true,
          diffPixels: 0,
          diffRatio: 0,
          diffPng: null,
          sizeMismatch: false,
          size,
          approvedSize: { width: size.width, height: size.height },
        };
      }
    } catch {
      // Not a readable PNG header. Let the full path throw the sentence it always throws.
    }
  }
  return comparePng(approvedBuf, actualBuf, tolerance, maskRects);
}

/**
 * @param {Buffer} approvedBuf
 * @param {Buffer} actualBuf
 * @param {import('../types.js').ToleranceConfig} tolerance
 * @param {import('../types.js').MaskRect[]} [maskRects]
 * @returns {import('../types.js').CompareReport}
 */
export function comparePng(approvedBuf, actualBuf, tolerance, maskRects = []) {
  const approved = decode(approvedBuf, 'the approved picture');
  const actual = decode(actualBuf, 'the new picture');

  const approvedSize = { width: approved.width, height: approved.height };
  const size = { width: actual.width, height: actual.height };

  if (approvedSize.width !== size.width || approvedSize.height !== size.height) {
    // Different sizes cannot be compared pixel by pixel at all. The caller
    // explains it in words instead of showing a meaningless diff.
    return { equal: false, diffPixels: 0, diffRatio: 0, diffPng: null, sizeMismatch: true, size, approvedSize };
  }

  if (maskRects.length > 0) {
    paintMasks(approved, maskRects);
    paintMasks(actual, maskRects);
  }

  const { width, height } = size;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(approved.data, actual.data, diff.data, width, height, {
    threshold: tolerance.threshold ?? DEFAULT_TOLERANCE.threshold,
    // Read this one carefully: includeAA:true INCLUDES anti-aliased pixels in the
    // count, which is stricter. So "ignore anti-aliasing noise" means includeAA:false.
    includeAA: !(tolerance.antialiasing ?? DEFAULT_TOLERANCE.antialiasing),
    alpha: 0.3,
    diffColor: [255, 0, 0],
    diffColorAlt: [255, 140, 0],
  });

  const total = width * height;
  const allowed = tolerance.maxPixels ?? Math.floor(total * (tolerance.pixels ?? DEFAULT_TOLERANCE.pixels));
  const equal = diffPixels <= allowed;

  return {
    equal,
    diffPixels,
    diffRatio: total > 0 ? diffPixels / total : 0,
    diffPng: equal ? null : PNG.sync.write(diff),
    sizeMismatch: false,
    size,
    approvedSize,
  };
}

/**
 * @param {Buffer} buffer
 * @param {string} what
 * @returns {PNG}
 */
function decode(buffer, what) {
  try {
    return PNG.sync.read(buffer);
  } catch (cause) {
    throw new StaysFixedError(`I could not open ${what} — the file is damaged or is not a PNG.`, {
      hint: 'Delete it and take the picture again.',
      cause,
    });
  }
}

/**
 * One sentence a non-technical person can act on.
 * @param {import('../types.js').CompareReport} report
 * @param {string} name
 * @returns {string}
 */
export function describeDifference(report, name) {
  if (report.sizeMismatch) {
    const was = `${report.approvedSize.width}x${report.approvedSize.height}`;
    const now = `${report.size.width}x${report.size.height}`;
    return `${name} changed size — it was ${was}, now it is ${now}.`;
  }
  if (report.equal) {
    return `${name} looks exactly like the approved picture.`;
  }
  const pixels = report.diffPixels.toLocaleString('en-US');
  const percent = (report.diffRatio * 100).toFixed(2);
  return `${name} looks different — ${pixels} pixels changed (${percent}% of the picture).`;
}
