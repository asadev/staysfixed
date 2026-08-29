/**
 * Killing movement.
 *
 * Anything that moves is a picture that disagrees with itself. Three layers, because
 * each one catches what the others miss:
 *
 *  - CSS kills declared animations and transitions, including ones that have not started.
 *  - Page script kills what CSS cannot: running Web Animations, playing video, and
 *    element.animate() calls the app makes at runtime.
 *  - The protocol tells the page it is on a machine set to "reduce motion", which is the
 *    only thing that stops well-behaved apps starting an animation in the first place.
 *
 * What none of this stops is an animated GIF or an autoplaying canvas draw loop that
 * ignores requestAnimationFrame. Mask those.
 */

/**
 * @param {{hideScrollbars?: boolean, hideCaret?: boolean}} [opts]
 * @returns {string} CSS
 */
export function motionCss(opts = {}) {
  const hideScrollbars = opts.hideScrollbars !== false;
  const hideCaret = opts.hideCaret !== false;

  const parts = [
    // animation-duration 0 alone is not enough: a delayed animation still fires later,
    // and an infinite one still holds a compositor layer. Say all of it.
    `*, *::before, *::after {
  animation: none !important;
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  animation-play-state: paused !important;
  transition: none !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
}`,
    // will-change promotes an element to its own compositor layer, and a promoted layer
    // is rasterised on slightly different pixel boundaries. Take the promotion away and
    // the same element lands on the same pixels every run.
    `*, *::before, *::after {
  will-change: auto !important;
}`,
    `html {
  scroll-behavior: auto !important;
}`,
    `video, marquee {
  animation-play-state: paused !important;
}`,
  ];

  if (hideCaret) {
    // A text cursor blinks. Half the runs catch it on, half catch it off.
    parts.push(`*, *::before, *::after {
  caret-color: transparent !important;
}`);
  }

  if (hideScrollbars) {
    // Scrollbars appear and disappear with content height and with the OS setting for
    // overlay scrollbars. Hiding them costs a few pixels of width and buys a picture
    // that does not depend on the machine that took it.
    parts.push(`::-webkit-scrollbar {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}`);
    parts.push(`html, body {
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
}`);
  }

  return parts.join('\n\n') + '\n';
}

/**
 * Page-side source that stops movement CSS cannot reach.
 * @returns {string} JavaScript to evaluate in the page
 */
export function motionScript() {
  return `(function () {
  if (window.__staysfixed_motion) return;
  window.__staysfixed_motion = true;

  // A finished-looking stub. Libraries await animation.finished before showing the next
  // thing; if we simply removed animate() those apps would hang half-rendered forever.
  function stubAnimation() {
    var done = Promise.resolve();
    return {
      id: '',
      effect: null,
      playState: 'finished',
      playbackRate: 1,
      currentTime: 0,
      startTime: 0,
      finished: done,
      ready: done,
      onfinish: null,
      oncancel: null,
      play: function () {},
      pause: function () {},
      cancel: function () {},
      finish: function () {},
      reverse: function () {},
      persist: function () {},
      commitStyles: function () {},
      updatePlaybackRate: function () {},
      addEventListener: function () {},
      removeEventListener: function () {},
      dispatchEvent: function () { return true; }
    };
  }

  try {
    if (window.Element && Element.prototype && Element.prototype.animate) {
      Element.prototype.animate = function () { return stubAnimation(); };
    }
  } catch (e) {}

  function quiet(root) {
    try {
      var vids = root && root.querySelectorAll ? root.querySelectorAll('video') : [];
      for (var i = 0; i < vids.length; i++) {
        try {
          vids[i].autoplay = false;
          vids[i].pause();
          // Seek to the first frame so the poster-or-frame-0 question has one answer.
          if (vids[i].currentTime !== 0) vids[i].currentTime = 0;
        } catch (e) {}
      }
    } catch (e) {}
    try {
      if (typeof document.getAnimations === 'function') {
        var anims = document.getAnimations();
        for (var j = 0; j < anims.length; j++) {
          var a = anims[j];
          var forever = false;
          try {
            var t = a.effect && a.effect.getTiming ? a.effect.getTiming() : null;
            forever = Boolean(t && t.iterations === Infinity);
          } catch (e) {}
          if (forever) {
            // A spinner has no end state, so hold it at its first frame. Every run then
            // photographs the same frame instead of whichever one the shutter caught.
            try { a.pause(); a.currentTime = 0; } catch (e) { try { a.cancel(); } catch (e2) {} }
          } else {
            // finish(), NOT cancel(). This one cost a wrong picture of a real app.
            //
            // cancel() throws the animation away and puts the element back where it
            // STARTED. So a sidebar that collapses with a 200ms slide was photographed
            // still open — the click worked, the content moved, and the panel snapped
            // back to its opening position the instant we cancelled. finish() jumps to
            // the end state, which is what a person would see a moment later, and that
            // is the picture worth keeping.
            try { a.finish(); } catch (e) { try { a.cancel(); } catch (e2) {} }
          }
        }
      }
    } catch (e) {}
  }

  function sweep() { quiet(document); }
  sweep();
  try { document.addEventListener('DOMContentLoaded', sweep); } catch (e) {}
  try { window.addEventListener('load', sweep); } catch (e) {}

  // Anything rendered after load brings its own animations with it — a spinner mounted by
  // a router, a toast, a lazy image fading in. Re-sweep whenever the page changes, but on
  // the next microtask so we are not mutating inside the mutation we are being told about.
  try {
    var queued = false;
    var observer = new MutationObserver(function () {
      if (queued) return;
      queued = true;
      Promise.resolve().then(function () { queued = false; sweep(); });
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });
    window.__staysfixed_motionObserver = observer;
  } catch (e) {}
})();`;
}

/**
 * Tell the page it is running on a machine set to reduce motion, and optionally pin the
 * colour scheme so a picture does not flip to dark because the CI box prefers dark.
 *
 * @param {import('../types.js').PageHandle} page
 * @param {{colorScheme?: 'light'|'dark'}} [opts]
 * @returns {Promise<void>}
 */
export async function reduceMotionCdp(page, opts = {}) {
  /** @type {{name: string, value: string}[]} */
  const features = [{ name: 'prefers-reduced-motion', value: 'reduce' }];
  if (opts.colorScheme) features.push({ name: 'prefers-color-scheme', value: opts.colorScheme });
  try {
    await page.send('Emulation.setEmulatedMedia', { features });
  } catch {
    // Not every target carries Emulation.setEmulatedMedia. The CSS layer still applies.
  }
}
