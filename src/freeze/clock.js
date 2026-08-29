/**
 * Freezing time.
 *
 * Two layers, because neither is enough on its own:
 *
 *  - The protocol overrides (`clockCdp`) change what the browser itself believes about
 *    time zone and locale, so `Date.prototype.toString`, `getTimezoneOffset` and the
 *    ICU formatters all agree. Page script cannot reach those.
 *  - The injected script (`clockScript`) pins the *instant*. The protocol can only do
 *    that with `Emulation.setVirtualTimePolicy`, which we refuse to use (see below).
 *
 * The instant is frozen but not dead: a spinner that waits 300ms still finishes,
 * because real timers still fire. Only the *reading* of the clock is pinned, and a
 * screen recipe can step it forward on purpose.
 */

import { StaysFixedError } from '../core/errors.js';

/**
 * Page-side source that pins the clock. Meant to run before any app script.
 *
 * @param {{iso: string, timezone?: string, locale?: string, seed?: number}} opts
 * @returns {string} JavaScript to evaluate in the page
 */
export function clockScript(opts) {
  const base = Date.parse(opts.iso);
  if (Number.isNaN(base)) {
    throw new StaysFixedError(`I cannot read "${opts.iso}" as a time.`, {
      hint: "Use an ISO timestamp like '2026-01-01T12:00:00.000Z', or set freeze.clock to false.",
    });
  }
  const timezone = opts.timezone ?? 'UTC';
  const locale = opts.locale ?? 'en-US';

  return `(function () {
  if (window.__staysfixed_clock) return;

  var BASE = ${base};
  var TZ = ${JSON.stringify(timezone)};
  var LOCALE = ${JSON.stringify(locale)};

  var ticks = 0;        // virtual milliseconds elapsed since BASE
  var auto = false;     // when on, every animation frame moves time forward one frame
  var FRAME_MS = 16;

  var RealDate = Date;
  var realRaf = typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame.bind(window)
    : null;

  // A subclass rather than a Proxy: instanceof, every Date.prototype method and all
  // date maths keep working untouched, and only the two things that read "now" change.
  // The one thing this gives up is calling Date() with no 'new', which returns a string.
  // App code effectively never does that; minifiers never produce it.
  class FrozenDate extends RealDate {
    constructor() {
      var args = Array.prototype.slice.call(arguments);
      if (args.length === 0) super(BASE + ticks);
      else super(...args);
    }
  }
  FrozenDate.now = function () { return BASE + ticks; };
  try { Object.defineProperty(FrozenDate, 'name', { value: 'Date', configurable: true }); } catch (e) {}
  window.Date = FrozenDate;
  try { globalThis.Date = FrozenDate; } catch (e) {}

  // performance.now() and Date.now() must tell the same story, or code that mixes them
  // (almost every animation library does) computes a nonsense elapsed time and loops.
  if (window.performance) {
    try {
      Object.defineProperty(window.performance, 'timeOrigin', {
        get: function () { return BASE; },
        configurable: true
      });
    } catch (e) {}
    try { window.performance.now = function () { return ticks; }; } catch (e) {}
  }

  // A fixed frame timestamp is what stops requestAnimationFrame loops from drifting the
  // picture: every frame looks like the same moment, so nothing eases, tweens or scrolls.
  if (realRaf) {
    window.requestAnimationFrame = function (cb) {
      return realRaf(function () {
        if (auto) ticks += FRAME_MS;
        cb(ticks);
      });
    };
  }

  function withZone(options) {
    var o = {};
    if (options) { for (var k in options) o[k] = options[k]; }
    if (!o.timeZone) o.timeZone = TZ;
    return o;
  }

  var Intl_ = window.Intl;
  if (Intl_ && typeof Intl_.DateTimeFormat === 'function') {
    var RealDTF = Intl_.DateTimeFormat;
    // Works with and without 'new': returning an object from a call overrides 'this'.
    var PatchedDTF = function DateTimeFormat(locales, options) {
      return new RealDTF(locales === undefined ? LOCALE : locales, withZone(options));
    };
    PatchedDTF.prototype = RealDTF.prototype;
    if (RealDTF.supportedLocalesOf) {
      PatchedDTF.supportedLocalesOf = function (l, o) { return RealDTF.supportedLocalesOf(l, o); };
    }
    try { Intl_.DateTimeFormat = PatchedDTF; } catch (e) {}

    // toLocaleString and friends do NOT go through Intl.DateTimeFormat, so they need
    // their own patch. We only fill in the locale and the zone; the default set of
    // components stays exactly as the browser would have chosen it.
    var names = ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'];
    for (var n = 0; n < names.length; n++) {
      (function (name) {
        var real = RealDate.prototype[name];
        if (typeof real !== 'function') return;
        RealDate.prototype[name] = function (locales, options) {
          return real.call(this, locales === undefined ? LOCALE : locales, withZone(options));
        };
      })(names[n]);
    }
  }

  if (Intl_) {
    var localeOnly = ['NumberFormat', 'Collator', 'RelativeTimeFormat', 'ListFormat', 'PluralRules', 'DisplayNames', 'Segmenter'];
    for (var i = 0; i < localeOnly.length; i++) {
      (function (name) {
        var Real = Intl_[name];
        if (typeof Real !== 'function') return;
        var Patched = function (locales, options) {
          return new Real(locales === undefined ? LOCALE : locales, options);
        };
        Patched.prototype = Real.prototype;
        if (Real.supportedLocalesOf) {
          Patched.supportedLocalesOf = function (l, o) { return Real.supportedLocalesOf(l, o); };
        }
        try { Intl_[name] = Patched; } catch (e) {}
      })(localeOnly[i]);
    }
  }

  var realNumToLocale = Number.prototype.toLocaleString;
  if (typeof realNumToLocale === 'function') {
    Number.prototype.toLocaleString = function (locales, options) {
      return realNumToLocale.call(this, locales === undefined ? LOCALE : locales, options);
    };
  }

  // Apps branch on the browser language to pick a format. Pin it or the picture depends
  // on whichever machine took it.
  try {
    Object.defineProperty(window.navigator, 'language', {
      get: function () { return LOCALE; }, configurable: true
    });
    Object.defineProperty(window.navigator, 'languages', {
      get: function () { return Object.freeze([LOCALE]); }, configurable: true
    });
  } catch (e) {}

  window.__staysfixed_clock = {
    base: BASE,
    now: function () { return BASE + ticks; },
    elapsed: function () { return ticks; },
    // Step time forward deliberately, e.g. to photograph "5 minutes into the session".
    advance: function (ms) {
      var n = Number(ms);
      ticks += isFinite(n) ? n : 0;
      return BASE + ticks;
    },
    // Let time creep forward one frame at a time. Off by default: fully frozen is the
    // only setting that gives byte-identical pictures run after run.
    auto: function (on) { auto = on !== false; return auto; }
  };
})();`;
}

/**
 * The protocol half. Stronger than script patching because it changes what the renderer
 * itself believes, before a single byte of the app is parsed.
 *
 * @param {import('../types.js').PageHandle} page
 * @param {{iso?: string, timezone?: string, locale?: string}} [opts]
 * @returns {Promise<void>}
 */
export async function clockCdp(page, opts = {}) {
  const timezone = opts.timezone ?? 'UTC';
  const locale = opts.locale ?? 'en-US';

  // Older targets and some Electron builds do not carry every Emulation command.
  // A missing override is a slightly less frozen page, never a failed run.
  await tolerate(page, 'Emulation.setTimezoneOverride', { timezoneId: timezone });
  await tolerate(page, 'Emulation.setLocaleOverride', { locale });

  // Emulation.setVirtualTimePolicy is deliberately NOT used. It hands the clock to the
  // browser and only advances it when the renderer says it is idle — an app holding a
  // long-poll or a WebSocket open never goes idle, so virtual time never advances and
  // the whole run deadlocks with no error. The injected clock has no such failure mode.
}

/**
 * @param {import('../types.js').PageHandle} page
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @returns {Promise<void>}
 */
async function tolerate(page, method, params) {
  try {
    await page.send(method, params);
  } catch {
    // Command not supported here. Carry on.
  }
}
