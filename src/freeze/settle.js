/**
 * Waiting until the screen stops moving.
 *
 * Everything else in the freeze layer removes a *reason* for the page to change. This is
 * the safety net for reasons we did not think of: a late render, a font swap, a chart
 * drawing itself, a layout that reflows once the scrollbar decides whether to exist.
 *
 * The rule is simple and it is the whole reason picture checks can be trusted: take the
 * photo, take it again, and only accept it once two photos in a row agree.
 */

import { PNG } from 'pngjs';
import { StaysFixedError } from '../core/errors.js';
import { detail } from '../core/log.js';

/**
 * @param {import('../types.js').PageHandle} page
 * @param {{frames?: number, intervalMs?: number, timeoutMs?: number, maxDriftPixels?: number, capture: () => Promise<Buffer>}} opts
 * @returns {Promise<{report: import('../types.js').SettleReport, png: Buffer}>}
 */
export async function settle(page, opts) {
  const frames = Math.max(1, opts.frames ?? 2);
  const intervalMs = Math.max(0, opts.intervalMs ?? 250);
  const timeoutMs = Math.max(0, opts.timeoutMs ?? 10_000);
  const maxDriftPixels = Math.max(0, opts.maxDriftPixels ?? 0);
  const capture = opts.capture;

  // Host-side Date.now, not the page's — the page's clock is frozen on purpose.
  const started = Date.now();

  await waitUntilQuiet(page, Math.min(timeoutMs, 5000));

  /** @type {Buffer|null} */
  let previous = null;
  /** @type {unknown} */
  let lastError = null;
  let stable = 0;
  let attempts = 0;
  let lastDrift = 0;

  for (;;) {
    /** @type {Buffer|null} */
    let shot = null;
    try {
      shot = await capture();
      attempts += 1;
    } catch (e) {
      lastError = e;
    }

    if (shot) {
      if (!previous) {
        stable = 1;
        lastDrift = 0;
      } else {
        lastDrift = driftBetween(previous, shot);
        stable = lastDrift <= maxDriftPixels ? stable + 1 : 1;
      }
      previous = shot;

      if (stable >= frames) {
        return {
          report: { settled: true, attempts, lastDriftPixels: lastDrift, waitedMs: Date.now() - started },
          png: shot,
        };
      }
    }

    if (Date.now() - started >= timeoutMs) break;
    if (intervalMs > 0) await sleep(intervalMs);
  }

  if (!previous) {
    // Nothing to hand back. This is the one case we do throw: a caller cannot decide
    // anything about a photo that does not exist.
    if (lastError instanceof Error) throw lastError;
    throw new StaysFixedError('I could not take a picture of this screen at all.', {
      hint: 'The window may have closed, or the app may have crashed mid-run.',
    });
  }

  detail('settle: gave up after', String(attempts), 'tries;', String(lastDrift), 'pixels still moving');
  return {
    report: { settled: false, attempts, lastDriftPixels: lastDrift, waitedMs: Date.now() - started },
    png: previous,
  };
}

/**
 * How many pixels differ between two photos.
 *
 * The fast path is the one that runs almost every time: two settled photos are byte-for-
 * byte identical, and comparing the compressed bytes costs nothing. Only when they differ
 * do we pay to decode both.
 *
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {number}
 */
function driftBetween(a, b) {
  if (a.length === b.length && a.equals(b)) return 0;
  try {
    const pa = PNG.sync.read(a);
    const pb = PNG.sync.read(b);
    if (pa.width !== pb.width || pa.height !== pb.height) {
      // The window resized between shots. That is movement by any definition.
      return Number.MAX_SAFE_INTEGER;
    }
    const da = pa.data;
    const db = pb.data;
    let differing = 0;
    for (let i = 0; i < da.length; i += 4) {
      if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2] || da[i + 3] !== db[i + 3]) {
        differing += 1;
      }
    }
    return differing;
  } catch {
    // A truncated photo from a window that closed mid-capture. Treat it as maximum
    // movement so we try again rather than accepting it.
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Let the page finish what it was already doing before the first photo. Skipping this
 * means the first two shots differ every time and the whole settle loop pays for it.
 *
 * @param {import('../types.js').PageHandle} page
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitUntilQuiet(page, timeoutMs) {
  const source = `(async () => {
  const LIMIT = ${Math.max(0, Math.round(timeoutMs))};

  if (document.readyState !== 'complete') {
    await Promise.race([
      new Promise(function (r) { window.addEventListener('load', r, { once: true }); }),
      new Promise(function (r) { setTimeout(r, LIMIT); })
    ]);
  }

  // Anything the freeze layer missed gets a short grace period to end on its own. The
  // count is bounded rather than timed because the page clock is frozen.
  if (typeof document.getAnimations === 'function') {
    for (var i = 0; i < 20; i++) {
      var running = 0;
      try { running = document.getAnimations().length; } catch (e) { running = 0; }
      if (running === 0) break;
      await new Promise(function (r) { setTimeout(r, 25); });
    }
  }

  // Two frames, not one: the first lets the browser run whatever was scheduled, the
  // second only arrives after that work has actually been painted.
  await new Promise(function (r) {
    requestAnimationFrame(function () { requestAnimationFrame(function () { r(undefined); }); });
  });
  return true;
})()`;

  try {
    await page.evaluate(source);
  } catch {
    // Not being able to ask the page is not a reason to skip the photo.
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
