/*
 * The config for the unstable fixture app.
 *
 * The address is read from the environment because the tests start the server on
 * a free port; running `node server.mjs` by hand uses the same default port, so
 * `staysfixed check` in this folder works with no environment at all.
 */

export default {
  app: {
    kind: 'web',
    url: process.env.STAYSFIXED_FIXTURE_URL || 'http://127.0.0.1:8931',
    headless: true,
  },

  // Small and at one device pixel per CSS pixel: this app is photographed
  // hundreds of times in the test suite, and a retina 1440x900 picture is eight
  // times the bytes to decode on every settle comparison.
  viewport: { width: 900, height: 640, deviceScaleFactor: 1 },

  freeze: {
    settle: { frames: 2, intervalMs: 120, timeoutMs: 8000 },
  },

  // The feed is genuinely different on every load — the server makes sure of it.
  // Masking it is the honest answer: the rectangle is painted over BOTH pictures,
  // so nothing is being hidden from the comparison that could ever have matched.
  masks: ['#feed-rows'],

  guards: '.staysfixed/guards',

  screens: [
    {
      name: 'home',
      describe: 'the front page, with the clock, the chart and the feed',
      url: '/',
    },
    {
      name: 'details',
      describe: 'the details page, reached by clicking the button',
      url: '/',
      steps: [
        { click: '[data-sf="go-details"]', note: 'open the second route' },
        { waitFor: '[data-sf="details-heading"]' },
        // The details page asks a route that takes 400ms to answer. Waiting for
        // the answer is what makes this screen photograph the same on a fast
        // laptop and on a loaded CI box.
        { waitFor: '[data-sf="slow-note"]' },
      ],
    },
    {
      name: 'home-scrolled',
      describe: 'the front page scrolled down to the chart',
      url: '/',
      steps: [{ scrollTo: '#chart' }],
    },
  ],
};
