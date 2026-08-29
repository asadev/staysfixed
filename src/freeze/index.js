/**
 * The freeze layer, assembled.
 *
 * This is the part of Stays Fixed that makes it worth using. A picture check that fails
 * for no reason is worse than no check at all, because people learn to ignore it — and
 * once they ignore it, the real regression slides through with everything else.
 *
 * Order is not a style choice here; each stage depends on the one before it.
 */

import { clockScript, clockCdp } from './clock.js';
import { motionCss, motionScript, reduceMotionCdp } from './motion.js';
import { randomScript } from './random.js';
import { insertFontCss, fontsScript, waitForFonts, waitForImages } from './fonts.js';
import { installNetwork } from './network.js';
import { detail, warn } from '../core/log.js';

/** Used only when a caller asks for a frozen clock without saying which instant. */
const FALLBACK_INSTANT = '2026-01-01T12:00:00.000Z';

/** @type {import('../types.js').FreezeStats} */
const NO_NETWORK_STATS = {
  requestsAllowed: 0,
  requestsBlocked: 0,
  requestsReplayed: 0,
  requestsRecorded: 0,
  blockedUrls: [],
};

/**
 * Make a page behave the same way every time it is opened.
 *
 * @param {import('../types.js').PageHandle} page
 * @param {import('../types.js').FreezeConfig} freeze
 * @param {{fixturesDir?: string, screenName?: string, record?: boolean, deviceScaleFactor?: number, colorScheme?: 'light'|'dark'}} [ctx]
 * @returns {Promise<import('../types.js').FreezeHandle>}
 */
export async function applyFreeze(page, freeze, ctx = {}) {
  /** @type {string[]} */
  const scriptIds = [];
  /** @type {string[]} */
  const cssIds = [];
  /** @type {{release: () => Promise<void>, stats: () => import('../types.js').FreezeStats}|null} */
  let network = null;

  const wantClock = freeze.clock !== false;
  const wantMotion = freeze.motion !== false;
  const wantFonts = freeze.fonts !== false;
  const wantRandom = freeze.random !== 'off';

  // ---------------------------------------------------------------------------
  // 1. Protocol overrides first.
  //
  // These change what the renderer itself believes, and they take effect before a single
  // byte of the app is parsed. Nothing injected into the page can reach the time zone the
  // browser formats dates in, or the media query it answers for reduced motion.
  // ---------------------------------------------------------------------------
  if (wantClock) {
    await clockCdp(page, { timezone: freeze.timezone, locale: freeze.locale });
  }
  if (wantMotion) {
    await reduceMotionCdp(page, ctx.colorScheme ? { colorScheme: ctx.colorScheme } : {});
  }

  // Network interception belongs in this first stage too, and for the same reason: if it
  // goes up after the app navigates, the first page load has already pulled in the very
  // avatars, fonts and beacons we are trying to keep out.
  try {
    network = await installNetwork(page, {
      mode: freeze.network ?? 'block-external',
      allow: freeze.networkAllow ?? [],
      fixturesDir: ctx.fixturesDir,
      screenName: ctx.screenName,
      record: ctx.record,
    });
  } catch (e) {
    warn('Could not take control of this app\'s network requests, so pictures may change on their own.');
    detail(e instanceof Error ? e.message : String(e));
  }

  // ---------------------------------------------------------------------------
  // 2. Page scripts, registered to run before anything the app loads.
  //
  // Order inside this list matters less than the fact that all of it lands before the
  // app's own first line: a framework that reads Date.now() or Math.random() while it is
  // booting has already baked the answer into the DOM by the time we could patch it.
  // ---------------------------------------------------------------------------
  /** @type {string[]} */
  const sources = [];
  if (wantClock) {
    const iso = typeof freeze.clock === 'string' ? freeze.clock : FALLBACK_INSTANT;
    sources.push(clockScript({ iso, timezone: freeze.timezone, locale: freeze.locale, seed: freeze.seed }));
  }
  if (wantRandom) sources.push(randomScript(freeze.seed ?? 20260101));
  if (wantMotion) sources.push(motionScript());
  if (wantFonts) sources.push(fontsScript());

  for (const source of sources) {
    try {
      scriptIds.push(await page.addInitScript(source));
    } catch (e) {
      detail('freeze: could not register a page script —', e instanceof Error ? e.message : String(e));
    }
  }

  // An init script only reaches documents that have not loaded yet, and the caller may
  // already be sitting on a page. Run the same sources against the document we have.
  // Every one of them refuses to install itself twice, so this is safe either way.
  for (const source of sources) {
    try {
      await page.evaluate(source);
    } catch {
      // No document yet, or it navigated. The init script covers the next one.
    }
  }

  // ---------------------------------------------------------------------------
  // 3. CSS last, because a stylesheet needs a document to attach to.
  // ---------------------------------------------------------------------------
  if (wantMotion) {
    try {
      cssIds.push(
        await page.insertCss(
          motionCss({ hideScrollbars: freeze.hideScrollbars !== false, hideCaret: freeze.hideCaret !== false })
        )
      );
    } catch (e) {
      detail('freeze: could not insert the motion stylesheet —', e instanceof Error ? e.message : String(e));
    }
  }
  if (wantFonts) {
    const id = await insertFontCss(page);
    if (id) cssIds.push(id);
  }

  return {
    async release() {
      try {
        for (const id of cssIds) {
          try {
            await page.removeCss(id);
          } catch {
            // Already gone with the document.
          }
        }
        for (const id of scriptIds) {
          try {
            await page.removeInitScript(id);
          } catch {
            // Same.
          }
        }
        try {
          await page.evaluate(
            "(() => { const mo = window.__staysfixed_motionObserver; if (mo && mo.disconnect) mo.disconnect(); })()"
          );
        } catch {
          // The observer dies with the document anyway.
        }
      } finally {
        // Always, even if everything above threw: a live Fetch interception left behind
        // stalls the next navigation, and that looks like the app hanging.
        if (network) await network.release();
      }
    },
    stats() {
      return network ? network.stats() : { ...NO_NETWORK_STATS, blockedUrls: [] };
    },
  };
}

/**
 * The last-moment checks, run immediately before the shutter.
 *
 * @param {import('../types.js').PageHandle} page
 * @param {{fonts?: boolean, timeoutMs?: number, keepScroll?: boolean, keepHover?: boolean}} [opts]
 * @returns {Promise<void>}
 */
export async function prepareForShutter(page, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10_000;

  if (opts.fonts !== false) await waitForFonts(page, { timeoutMs: Math.min(timeoutMs, 5000) });
  await waitForImages(page, { timeoutMs });

  // Park the mouse before anything else.
  //
  // The pointer stays wherever the last click left it, and the thing under it stays
  // hovered: a highlighted row, a tooltip that fades in a beat later, a button that is
  // a different colour than it will be tomorrow when the recipe clicks in a slightly
  // different order. The first real app this tool was pointed at photographed a tooltip
  // reading "Keep the sidebar open" that nobody meant to be in the picture, and a
  // sidebar that had refused to collapse *because the mouse was still resting on it*.
  //
  // So: move the pointer out to the far corner, then let the page settle. The corner is
  // (1,1) rather than (0,0) because some apps treat the exact origin as "no pointer" and
  // never fire the leave.
  if (opts.keepHover !== true) await page.moveMouseAway();

  // A focus ring is a real source of wobble. Whichever element happened to be focused when
  // the last step finished draws an outline the approved picture may not have — and which
  // element that is depends on click timing, so it changes between runs on the same code.
  const blur = `try {
    var el = document.activeElement;
    if (el && el !== document.body && typeof el.blur === 'function') el.blur();
  } catch (e) {}`;

  // Unless the recipe scrolled somewhere on purpose, start from the top: a page that was
  // left scrolled by a click-into-view photographs differently every run.
  const scroll = opts.keepScroll
    ? ''
    : `try {
    window.scrollTo(0, 0);
    if (document.documentElement) document.documentElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
  } catch (e) {}`;

  const source = `(async () => {
  ${blur}
  ${scroll}
  // Read a layout property to force the browser to flush whatever the blur and the scroll
  // changed, then wait two frames so it is actually on screen and not merely calculated.
  try { void document.documentElement.offsetHeight; } catch (e) {}
  await new Promise(function (r) {
    requestAnimationFrame(function () { requestAnimationFrame(function () { r(undefined); }); });
  });
  return true;
})()`;

  try {
    await page.evaluate(source);
  } catch {
    // Nothing here is worth failing a run over; the settle loop is the real guarantee.
  }
}
