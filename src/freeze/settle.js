/**
 * Waiting until the screen stops moving.
 *
 * Everything else in the freeze layer removes a *reason* for the page to change. This is
 * the safety net for reasons we did not think of: a late render, a font swap, a chart
 * drawing itself, a layout that reflows once the scrollbar decides whether to exist.
 *
 * The rule is simple and it is the whole reason picture checks can be trusted: take the
 * photo, take it again, and only accept it once two photos in a row agree.
 *
 * Two photos of a retina window is a second of every screen's time, and almost all of it
 * is spent turning pixels into PNG and sending them down the wire — for pictures nobody
 * ever looks at, whose only job was to answer "did anything move". So a caller may hand
 * in a cheap `probe` for that question and keep the expensive capture for the one picture
 * that is actually kept. See `settleByProbe` for why a lossy probe is sound.
 */

import { PNG } from 'pngjs';
import { StaysFixedError } from '../core/errors.js';
import { detail } from '../core/log.js';

/**
 * @param {import('../types.js').PageHandle} page
 * @param {{
 *   frames?: number,
 *   intervalMs?: number,
 *   timeoutMs?: number,
 *   maxDriftPixels?: number,
 *   capture: () => Promise<Buffer>,
 *   probe?: () => Promise<Buffer>,
 * }} opts
 *   `capture` takes the picture that is kept. `probe`, when given, is a cheap shot used
 *   only to decide whether the page has stopped moving — never the picture itself.
 * @returns {Promise<{report: import('../types.js').SettleReport, png: Buffer}>}
 */
export async function settle(page, opts) {
  const frames = Math.max(1, opts.frames ?? 2);
  const intervalMs = Math.max(0, opts.intervalMs ?? 250);
  const timeoutMs = Math.max(0, opts.timeoutMs ?? 10_000);
  const maxDriftPixels = Math.max(0, opts.maxDriftPixels ?? 0);
  const capture = opts.capture;

  // A probe can only ever answer yes or no: it is not the picture, so counting how many
  // pixels of it moved would be counting the wrong pixels. A project that allows a few
  // drifting pixels is asking for a count, so it goes the long way round on real photos.
  const probe = maxDriftPixels === 0 ? opts.probe : undefined;

  // Host-side Date.now, not the page's — the page's clock is frozen on purpose.
  const started = Date.now();

  await waitUntilQuiet(page, Math.min(timeoutMs, 5000));

  if (probe) {
    return await settleByProbe({ probe, capture, frames, intervalMs, timeoutMs, started });
  }

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
 * The same rule, asked cheaply.
 *
 * WHY a lossy probe is safe. The probe is never the picture and never reaches disk; the
 * only thing asked of it is "are these two frames the same frame". A JPEG encoder is
 * deterministic, so two JPEGs of one unchanged frame are byte-for-byte identical, and two
 * JPEGs that differ can only differ because the pixels underneath them did. That is
 * exactly the question, and it is answered for about half the cost of a full-size retina
 * PNG — and the picture that used to be thrown away is not taken at all.
 *
 * WHY the photograph is taken in the middle. The old loop shot the screen, waited, shot it
 * again, and kept the second one. This one probes, takes the real photograph, and probes
 * once more: the kept picture sits BETWEEN two frames that agree, instead of being the
 * later of them. If anything moved while the shutter was open, the probe after it
 * disagrees and the whole thing goes round again — which the old loop could not notice,
 * because it kept a picture nothing had checked since.
 *
 * WHY there is no pause between agreeing frames. The old quarter-second sat between the
 * two photographs so they could not both land inside one painted frame. Taking the real
 * photograph between the probes already separates them by longer than a screenshot takes,
 * so the separation is still bought and no longer paid for twice. The pause is kept for
 * where it earns its keep: after two probes have actually disagreed, which is the only
 * time a page is worth waiting for.
 *
 * @param {{
 *   probe: () => Promise<Buffer>,
 *   capture: () => Promise<Buffer>,
 *   frames: number,
 *   intervalMs: number,
 *   timeoutMs: number,
 *   started: number,
 * }} o
 * @returns {Promise<{report: import('../types.js').SettleReport, png: Buffer}>}
 */
async function settleByProbe(o) {
  // One frame is all this project asks for, so there is nothing to compare it against.
  if (o.frames <= 1) {
    const only = await o.capture();
    return {
      report: { settled: true, attempts: 0, lastDriftPixels: 0, waitedMs: Date.now() - o.started },
      png: only,
    };
  }

  // The photograph itself stands in for the last frame, so one fewer probe is needed than
  // the number of agreeing frames the project asked for.
  const probesNeeded = o.frames - 1;

  /** @type {Buffer|null} */
  let previous = null;
  /** @type {Buffer|null} */
  let taken = null;
  /** @type {unknown} */
  let lastError = null;
  let agreed = 0;
  let attempts = 0;

  for (;;) {
    /** @type {Buffer|null} */
    let shot = null;
    try {
      shot = await o.probe();
      attempts += 1;
    } catch (e) {
      lastError = e;
    }

    // Only a pair of frames that disagreed earns a pause before the next look.
    let moved = true;
    if (shot) {
      moved = previous ? !sameBytes(previous, shot) : false;
      agreed = moved ? 1 : agreed + 1;
      previous = shot;
    }

    if (shot && !moved && agreed >= probesNeeded) {
      const png = await o.capture();
      /** @type {Buffer|null} */
      let after = null;
      try {
        after = await o.probe();
        attempts += 1;
      } catch (e) {
        // The window went away right after the shutter. The picture is already in hand and
        // there is nothing left that could contradict it.
        lastError = e;
      }
      // `shot` is the frame this picture was promised to match; it is also `previous`.
      if (!after || sameBytes(shot, after)) {
        return {
          report: { settled: true, attempts, lastDriftPixels: 0, waitedMs: Date.now() - o.started },
          png,
        };
      }
      // It moved while the shutter was open — something the old loop could not notice,
      // because it kept the last photograph it took rather than one it had checked
      // afterwards. Hold on to it only as a last resort and start counting again.
      taken = png;
      previous = after;
      agreed = 1;
      moved = true;
    }

    if (Date.now() - o.started >= o.timeoutMs) break;
    if (moved && o.intervalMs > 0) await sleep(o.intervalMs);
  }

  if (!taken) {
    try {
      taken = await o.capture();
    } catch (e) {
      lastError = e;
    }
  }
  if (!taken) {
    if (lastError instanceof Error) throw lastError;
    throw new StaysFixedError('I could not take a picture of this screen at all.', {
      hint: 'The window may have closed, or the app may have crashed mid-run.',
    });
  }

  detail('settle: gave up after', String(attempts), 'tries; the screen was still moving');
  // Probes answer yes or no, so the drift is reported as "something moved" rather than a
  // figure nobody measured.
  return {
    report: { settled: false, attempts, lastDriftPixels: 1, waitedMs: Date.now() - o.started },
    png: taken,
  };
}

/**
 * Whether two shots are the very same bytes.
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {boolean}
 */
function sameBytes(a, b) {
  return a.length === b.length && a.equals(b);
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
  if (sameBytes(a, b)) return 0;
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
  //
  // This reads like an easy half-second to save and it is not. On a real app two
  // animations sit on this list permanently — a spinner, a pulse — so the loop runs all
  // twenty rounds every screen and looks like pure waiting for nothing. It was cut to stop
  // as soon as the count stopped falling, and the fixture app that exists to be
  // impossible to photograph immediately produced two different pictures out of twenty.
  // What the loop is really buying is time for things that arrive late and announce
  // themselves to nobody: the fixture sets an image source on a timer, and until that
  // fires there is no request, no pending resource and nothing on any page API to wait
  // for. Only elapsed time finds it. So the half-second stays; the savings in this file
  // come from the photographs, which used to be full-size and are now mostly probes.
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
