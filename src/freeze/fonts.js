/**
 * Waiting for the page to finish arriving.
 *
 * The single most common cause of a picture that "randomly" fails is a font or an image
 * that had not landed yet. Text reflows when the real face replaces the fallback; a
 * missing image collapses a card. Neither is a bug in the app and neither is worth
 * waking a human for, so we wait for both before the shutter.
 *
 * Every wait in here races a real setTimeout rather than a clock reading, because the
 * clock is frozen: Date.now() would never move past the deadline.
 */

import { detail } from '../core/log.js';

/**
 * Page-side helper that resolves when the browser says every face is in.
 * @returns {string} JavaScript to evaluate in the page
 */
export function fontsScript() {
  return `(function () {
  if (window.__staysfixed_fontsReady) return;

  function faces() {
    var out = [];
    try { document.fonts.forEach(function (f) { out.push(f); }); } catch (e) { /* older set */ }
    return out;
  }

  // The trap that cost us the first green run, and it is worth spelling out.
  //
  // A face declared in @font-face is not fetched until layout actually needs it.
  // Until then its status is 'unloaded', NOTHING is pending, document.fonts.status
  // reads 'loaded' and document.fonts.ready resolves immediately — so a naive wait
  // returns at once, the shutter fires on the fallback font, and a moment later the
  // real face lands and every line of text shifts by a fraction of a pixel. That is
  // exactly what made take 1 of twenty differ from takes 2 to 20: one picture in
  // Helvetica, nineteen in the web font.
  //
  // So we do not wait for the fonts to arrive. We ask for them.
  function forceLoad() {
    var pending = [];
    faces().forEach(function (f) {
      try {
        if (f.status === 'unloaded') pending.push(f.load().catch(function () {}));
        else if (f.status === 'loading') pending.push(Promise.resolve(f.loaded).catch(function () {}));
      } catch (e) { /* a face the browser refuses to load is not our problem */ }
    });
    return Promise.all(pending);
  }

  window.__staysfixed_fontsReady = function (ms) {
    var limit = typeof ms === 'number' && ms > 0 ? ms : 5000;
    if (!document.fonts) return Promise.resolve('no-font-api');

    var ready = (async function () {
      // Loading one face can pull in another (a bold weight referenced by a rule that
      // only matched once the first face changed the layout), so go round a few times
      // until nothing is left unloaded.
      for (var round = 0; round < 5; round++) {
        await forceLoad();
        try { await document.fonts.ready; } catch (e) { /* ignore */ }
        var waiting = faces().some(function (f) { return f.status !== 'loaded'; });
        if (!waiting && document.fonts.status === 'loaded') break;
      }
      // Two frames, so the reflow the last face caused has actually been painted
      // rather than merely scheduled.
      await new Promise(function (r) {
        if (typeof requestAnimationFrame !== 'function') return r(undefined);
        requestAnimationFrame(function () { requestAnimationFrame(function () { r(undefined); }); });
      });
      return document.fonts.status || 'loaded';
    })();

    var timer = new Promise(function (resolve) {
      setTimeout(function () { resolve('timeout'); }, limit);
    });

    return Promise.race([ready, timer]);
  };
})();`;
}

/**
 * CSS that pins how text is rasterised.
 * @returns {string} CSS
 */
export function fontsCss() {
  // This trades a little fidelity for pictures that do not change when the OS decides to
  // smooth text differently. Subpixel antialiasing depends on the display, on whether the
  // window is on an external monitor, and on GPU driver version; geometricPrecision stops
  // glyph advances being rounded to whole pixels, which is what makes a line of text
  // reflow by one pixel between runs; font-synthesis: none stops a fake bold or fake
  // italic being invented when a weight is missing, which is a per-machine decision.
  return `* , *::before, *::after {
  -webkit-font-smoothing: antialiased !important;
  text-rendering: geometricPrecision !important;
  font-synthesis: none !important;
}
`;
}

/**
 * Insert the text-rendering CSS.
 *
 * Called once per capture, never cached. It used to be cached against the page in a
 * WeakSet, and that was a real bug with a very confusing signature: the first picture
 * of a fresh browser came out with smoothed (thinner) text and every picture after it
 * came out unsmoothed, because the stylesheet died with the document the screen recipe
 * navigated away from and the cache refused to put it back. Identical layout, different
 * pixels, one wrong picture in twenty. Insert it every time.
 *
 * @param {import('../types.js').PageHandle} page
 * @returns {Promise<string|null>} the stylesheet id, or null when the page refused it
 */
export async function insertFontCss(page) {
  try {
    return await page.insertCss(fontsCss());
  } catch {
    return null;
  }
}

/**
 * Wait until every font face has loaded. Tolerates a page with no font API at all.
 * @param {import('../types.js').PageHandle} page
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<void>}
 */
export async function waitForFonts(page, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;

  const source = `(async () => {
  if (typeof window.__staysfixed_fontsReady === 'function') {
    return await window.__staysfixed_fontsReady(${timeoutMs});
  }
  if (!document.fonts) return 'no-font-api';
  await Promise.race([
    Promise.resolve(document.fonts.ready),
    new Promise(function (r) { setTimeout(r, ${timeoutMs}); })
  ]);
  return document.fonts.status || 'unknown';
})()`;

  try {
    const status = await page.evaluate(source);
    if (status === 'timeout') {
      detail('fonts: gave up waiting after', `${timeoutMs}ms`, '— a face never finished loading');
    } else {
      detail('fonts:', String(status));
    }
  } catch {
    // A page that navigated out from under us. The settle loop will catch any wobble.
  }
}

/**
 * Wait until pictures and stylesheets have landed: every <img> complete, every CSS
 * background image fetched, no stylesheet still on its way.
 * @param {import('../types.js').PageHandle} page
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<void>}
 */
export async function waitForImages(page, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10000;

  // Walking every element to read computed styles is the expensive part, so it is capped.
  // Background images below the first few thousand elements are almost always off-screen.
  const source = `(async () => {
  var LIMIT = ${timeoutMs};
  var MAX_ELEMENTS = 4000;
  var waits = [];

  var imgs = document.images ? Array.prototype.slice.call(document.images) : [];
  for (var i = 0; i < imgs.length; i++) {
    (function (img) {
      if (img.complete) return;
      waits.push(new Promise(function (r) {
        img.addEventListener('load', r, { once: true });
        img.addEventListener('error', r, { once: true });
      }));
    })(imgs[i]);
  }

  var urls = {};
  var all = document.querySelectorAll('*');
  var count = Math.min(all.length, MAX_ELEMENTS);
  for (var e = 0; e < count; e++) {
    var bg = '';
    try { bg = getComputedStyle(all[e]).backgroundImage; } catch (err) { bg = ''; }
    if (!bg || bg === 'none' || bg.indexOf('url(') === -1) continue;
    var chunks = bg.split('url(');
    for (var c = 1; c < chunks.length; c++) {
      var end = chunks[c].indexOf(')');
      if (end < 0) continue;
      var u = chunks[c].slice(0, end).trim();
      var first = u.charAt(0);
      var last = u.charAt(u.length - 1);
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) u = u.slice(1, -1);
      // data: URLs are already here by definition; nothing to wait for.
      if (u && u.slice(0, 5) !== 'data:') urls[u] = true;
    }
  }
  Object.keys(urls).forEach(function (u) {
    waits.push(new Promise(function (r) {
      var probe = new Image();
      probe.onload = r;
      probe.onerror = r;
      probe.src = u;
    }));
  });

  // A stylesheet still in flight repaints the whole page the instant it applies — the
  // worst possible moment for that is one millisecond after the shutter.
  var links = document.querySelectorAll('link[rel~="stylesheet"]');
  for (var l = 0; l < links.length; l++) {
    (function (link) {
      var loaded = false;
      // A cross-origin sheet that HAS loaded exposes a sheet object but throws on its
      // rules; a sheet that has not loaded exposes nothing. Presence is the right test.
      try { loaded = Boolean(link.sheet); } catch (err) { loaded = true; }
      if (loaded || link.disabled) return;
      waits.push(new Promise(function (r) {
        link.addEventListener('load', r, { once: true });
        link.addEventListener('error', r, { once: true });
      }));
    })(links[l]);
  }

  if (waits.length === 0) return 0;
  await Promise.race([
    Promise.all(waits),
    new Promise(function (r) { setTimeout(r, LIMIT); })
  ]);
  return waits.length;
})()`;

  try {
    const waited = await page.evaluate(source);
    if (waited) detail('waited on', String(waited), 'image or stylesheet loads');
  } catch {
    // Same as above: a navigation mid-wait is not a reason to fail a run.
  }
}
