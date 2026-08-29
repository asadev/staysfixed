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
