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
  // So we do not wait for the fonts to arrive. We ask for them. The list of promises is
  // handed back rather than awaited here, because how many faces needed asking is the
  // thing that decides whether there is anything left to wait for at all.
  function forceLoad() {
    var pending = [];
    faces().forEach(function (f) {
      try {
        if (f.status === 'unloaded') pending.push(f.load().catch(function () {}));
        else if (f.status === 'loading') pending.push(Promise.resolve(f.loaded).catch(function () {}));
      } catch (e) { /* a face the browser refuses to load is not our problem */ }
    });
    return pending;
  }

  window.__staysfixed_fontsReady = function (ms) {
    var limit = typeof ms === 'number' && ms > 0 ? ms : 5000;
    if (!document.fonts) return Promise.resolve('no-font-api');

    var ready = (async function () {
      var asked = 0;
      // Loading one face can pull in another (a bold weight referenced by a rule that
      // only matched once the first face changed the layout), so go round a few times
      // until nothing is left unloaded.
      //
      // A round that asks for nothing is the finish line, and it is worth leaving on it
      // rather than going round again: if no face is unloaded or loading then every face
      // is in, document.fonts.ready would resolve on the spot, and asking it anyway costs
      // a whole trip through the page for an answer we already have. Most screens of most
      // apps land here on the first round, and every screen after the first one does,
      // because the fonts arrived for the screen before it.
      for (var round = 0; round < 5; round++) {
        var pending = forceLoad();
        // The one case where "nothing to ask for" is not the finish line: a document that
        // is still parsing has not met its @font-face rules yet, so the face list can be
        // empty and still grow. There, wait the old way at least once.
        if (pending.length === 0 && (round > 0 || document.readyState === 'complete')) break;
        asked += pending.length;
        await Promise.all(pending);
        try { await document.fonts.ready; } catch (e) { /* ignore */ }
      }
      // Two frames, so the reflow the last face caused has actually been painted rather
      // than merely scheduled. No face needed loading means no face changed the layout,
      // so there is no reflow to wait for — and the shutter code waits two frames of its
      // own after clearing focus and scroll, which is the real paint barrier.
      if (asked > 0) {
        await new Promise(function (r) {
          if (typeof requestAnimationFrame !== 'function') return r(undefined);
          requestAnimationFrame(function () { requestAnimationFrame(function () { r(undefined); }); });
        });
      }
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

  // The cheap questions are asked first and the expensive one is earned.
  //
  // The expensive one is background images. There is no list of them anywhere, so the
  // only honest way to find them is to read the computed style of every element — and on
  // almost every app that walk costs more than the whole rest of the shutter and comes
  // back with nothing, because no rule on the page ever says url(). So the stylesheets
  // are asked first, in one pass that stops at the first sign of an image, and elements
  // are only walked when the answer is yes. When they are walked, it is the ones on
  // screen: an image below the fold is not what delays this paint.
  //
  // Being less than exhaustive here cannot produce a wrong picture. This is a head start,
  // not the guarantee — the guarantee is the settle loop, which refuses to accept any
  // photograph until two frames in a row are the same frame. An image nobody waited for
  // costs one more round of settling and nothing else.
  const source = `(async () => {
  var LIMIT = ${timeoutMs};
  var MAX_ELEMENTS = 4000;
  var MAX_STYLES = 1200;
  var MAX_RULES = 4000;
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

  // Does any style on this page mention an image at all? One pass, stopping early, over
  // the declarations themselves rather than their serialised text.
  var budget = MAX_RULES;
  function mentionsUrl(style) {
    if (!style) return false;
    var props = ['backgroundImage', 'borderImageSource', 'maskImage', 'webkitMaskImage', 'listStyleImage', 'content'];
    for (var p = 0; p < props.length; p++) {
      var v = '';
      try { v = style[props[p]]; } catch (err) { v = ''; }
      if (v && String(v).indexOf('url(') !== -1) return true;
    }
    return false;
  }
  function scanRules(rules) {
    for (var i = 0; i < rules.length; i++) {
      if (budget <= 0) return true;
      budget--;
      var rule = rules[i];
      if (mentionsUrl(rule.style)) return true;
      // @media, @supports and @layer hold their rules inside themselves; @import holds a
      // whole other stylesheet, which never appears in document.styleSheets on its own.
      var inner = null;
      try { inner = rule.cssRules || (rule.styleSheet && rule.styleSheet.cssRules); } catch (err) { inner = null; }
      if (inner === null) return true;
      if (inner && inner.length && scanRules(inner)) return true;
    }
    return false;
  }
  function anyImageInCss() {
    // Inline styles are not in document.styleSheets at all, and this is one indexed query.
    try { if (document.querySelector('[style*="url("]')) return true; } catch (err) { }
    // Sheets a framework adopted straight onto the document are not in styleSheets.
    var sheets = Array.prototype.slice.call(document.styleSheets || []);
    if (document.adoptedStyleSheets) sheets = sheets.concat(Array.prototype.slice.call(document.adoptedStyleSheets));
    for (var s = 0; s < sheets.length; s++) {
      var rules = null;
      try { rules = sheets[s].cssRules; } catch (err) { rules = null; }
      // A sheet from another origin will not show its rules. Assume it could be hiding an
      // image rather than pretend it cannot.
      if (rules === null) return true;
      if (scanRules(rules)) return true;
    }
    return false;
  }

  if (anyImageInCss()) {
    var urls = {};
    var vw = window.innerWidth || 0;
    var vh = window.innerHeight || 0;
    var all = document.querySelectorAll('*');
    var count = Math.min(all.length, MAX_ELEMENTS);
    var looked = 0;
    for (var e = 0; e < count && looked < MAX_STYLES; e++) {
      var node = all[e];
      var box = null;
      try { box = node.getBoundingClientRect(); } catch (err) { box = null; }
      if (!box || box.width <= 0 || box.height <= 0) continue;
      // On screen, or one screenful below it — far enough to cover a full-page picture's
      // first fold without reading the style of a thousand things nobody can see.
      if (box.bottom < 0 || box.right < 0 || box.left > vw || box.top > vh * 2) continue;
      looked++;
      var bg = '';
      try { bg = getComputedStyle(node).backgroundImage; } catch (err) { bg = ''; }
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
