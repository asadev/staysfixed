/**
 * A web app, checked end to end.
 *
 * Copy this to the root of your project as `staysfixed.config.js`, point it at
 * your dev server, and delete the parts you do not need. Every option here is
 * optional except `app` and `screens` — the defaults are chosen so that a config
 * of five lines already works.
 */

/** @type {import('../src/types.js').StaysFixedConfig} */
const config = {
  // ---------------------------------------------------------------------------
  // What to open
  // ---------------------------------------------------------------------------
  app: {
    kind: 'web',

    // The address the app answers on. Relative screen urls hang off this, so
    // `url: '/settings'` on a screen below means http://localhost:3000/settings.
    url: 'http://localhost:3000',

    // Optional: the command that starts the app. Leave it out if you start the
    // server yourself — Stays Fixed simply waits for `url` to answer either way.
    // Use a production-like build, not a hot-reloading dev server: a dev overlay
    // that pops up for half a second is a picture that disagrees with itself.
    start: 'npm run preview',
    cwd: '.',

    // Extra environment for the command above. Handy for pointing the app at a
    // seeded database, which is the single biggest thing you can do to make
    // pictures repeatable.
    env: {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://localhost:5432/myapp_pictures',
    },

    // How long to wait for the app to answer before giving up.
    startTimeoutMs: 60_000,

    // Leave `browser` out and the tool finds Chrome, Chromium, Edge or Brave on
    // this machine. Set it to pin one exact binary, which is what you want when
    // more than one person approves pictures.
    // browser: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',

    // Headless is the default. Turn it off while you are writing a screen recipe
    // and want to watch the browser do it.
    headless: true,
  },

  // ---------------------------------------------------------------------------
  // How big the window is
  //
  // Change this and every approved picture stops matching, so pick a size once.
  // deviceScaleFactor 2 gives retina-sharp pictures; it is still deterministic.
  // ---------------------------------------------------------------------------
  viewport: {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  },

  // ---------------------------------------------------------------------------
  // Holding the app still
  //
  // These are the defaults spelled out. You can delete this whole block.
  // docs/how-it-stays-stable.md explains what each one is protecting you from.
  // ---------------------------------------------------------------------------
  freeze: {
    // The instant the app always believes it is. Timers still fire; only the
    // reading of the clock is pinned. Set to false to leave time alone.
    clock: '2026-01-01T12:00:00.000Z',
    timezone: 'UTC',
    locale: 'en-US',

    // Stop animations, transitions, video and the blinking text cursor.
    motion: true,

    // Seed Math.random, crypto.getRandomValues and crypto.randomUUID, so a
    // shuffled list is shuffled the same way every time.
    random: 'seeded',
    seed: 20260101,

    // Wait for web fonts and images to land, and pin how text is rasterised.
    fonts: true,

    // 'block-external' lets the app's own origin and localhost through and
    // blocks everybody else's servers — the usual choice.
    // 'replay' records every reply once into .staysfixed/fixtures and then
    // serves those same bytes forever, which is what you want when the app
    // cannot render at all without its API.
    // 'live' lets everything through, and your pictures then depend on the
    // internet.
    network: 'block-external',

    // Globs that get out even in 'block-external'. The `*` stops at a path
    // separator; `**` crosses them.
    networkAllow: ['https://fonts.gstatic.com/**'],

    hideScrollbars: true,
    hideCaret: true,

    // Take the photo, take it again, and only accept it once two in a row
    // agree. This is the safety net for anything the rest of the list missed.
    settle: {
      frames: 2,
      intervalMs: 250,
      timeoutMs: 10_000,
      maxDriftPixels: 0,
    },
  },

  // ---------------------------------------------------------------------------
  // How much difference is allowed
  //
  // 0.0005 is 0.05% of the pixels — on a 1440x900 at 2x picture that is about
  // 1,300 pixels. Enough to absorb font hinting noise, nowhere near enough to
  // hide a missing stylesheet or a shifted column.
  // ---------------------------------------------------------------------------
  tolerance: {
    pixels: 0.0005,
    threshold: 0.12,
    antialiasing: true,
    // maxPixels: 500,   // a hard cap, overrides `pixels` when set
  },

  // ---------------------------------------------------------------------------
  // Things that are allowed to change
  //
  // A CSS selector paints over every element that matches; a rectangle paints
  // over an exact area in CSS pixels. Mask a live clock, a session id, a
  // "3 minutes ago" — never mask something just because it keeps failing.
  // ---------------------------------------------------------------------------
  masks: ['[data-live-clock]', '.session-id', { x: 0, y: 0, width: 240, height: 32 }],

  // ---------------------------------------------------------------------------
  // The screens
  // ---------------------------------------------------------------------------
  screens: [
    // The simplest possible screen: a name and an address.
    {
      name: 'home',
      describe: 'The landing page, signed out',
      url: '/',
    },

    // Declarative steps. This form also works in staysfixed.config.json, so a
    // project in any language can use it without writing JavaScript.
    {
      name: 'signed-in-dashboard',
      describe: 'The dashboard after a normal sign-in',
      steps: [
        { goto: '/login' },
        { type: 'input[name="email"]', text: 'demo@example.com' },
        { type: 'input[name="password"]', text: 'demo-password' },
        { click: 'button[type="submit"]' },
        { waitFor: '[data-testid="dashboard"]' },
        { note: 'The greeting shows the account name, which is seeded data.' },
      ],
      masks: ['[data-testid="last-seen"]'],
    },

    // Or write it as code, when the steps need a decision.
    {
      name: 'settings-notifications',
      describe: 'Notification settings with the daily digest switched on',
      async do(page) {
        await page.goto('/settings');
        await page.click('[data-tab="notifications"]');
        await page.waitFor('#daily-digest');
        const alreadyOn = await page.evaluate(
          'document.querySelector("#daily-digest").checked === true',
        );
        if (!alreadyOn) await page.click('#daily-digest');
        await page.waitFor('[data-saved="true"]');
      },
    },

    // Capture one element instead of the whole window.
    {
      name: 'pricing-card-pro',
      describe: 'The Pro pricing card on its own',
      url: '/pricing',
      clip: '[data-plan="pro"]',
    },

    // A long page, photographed all the way down. Full-page shots are more
    // fragile than viewport shots: anything lazy-loading below the fold has to
    // finish first, so give it a longer settle if it wobbles.
    {
      name: 'changelog-full',
      describe: 'The whole changelog page, top to bottom',
      url: '/changelog',
      fullPage: true,
      freeze: {
        settle: { timeoutMs: 20_000 },
      },
    },

    // A screen with its own size and its own tolerance.
    {
      name: 'home-narrow',
      describe: 'The landing page at a narrow width, where the nav collapses',
      url: '/',
      viewport: { width: 720, height: 900 },
      tolerance: { pixels: 0.001 },
    },

    // Leave a screen out for now without deleting it. `check` says it was left
    // out on purpose, so nobody thinks it is passing.
    {
      name: 'billing-empty',
      describe: 'Billing with no invoices yet',
      url: '/billing',
      skip: true,
    },
  ],

  // ---------------------------------------------------------------------------
  // Guards — one check per bug that was already fixed once.
  //
  // A folder of plain JavaScript files. See examples/guards/ and docs/guards.md.
  // ---------------------------------------------------------------------------
  guards: '.staysfixed/guards',

  // ---------------------------------------------------------------------------
  // The pre-release walk. Leave `steps` out and it walks every screen above.
  // ---------------------------------------------------------------------------
  walk: {
    describe: 'The path a new customer takes, opened for real before a release',
    steps: [
      { name: 'walk-home', describe: 'Landing page', url: '/' },
      { name: 'walk-pricing', describe: 'Pricing', url: '/pricing' },
      {
        name: 'walk-signup',
        describe: 'Sign-up form, filled in but not submitted',
        steps: [
          { goto: '/signup' },
          { type: 'input[name="email"]', text: 'demo@example.com' },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // What an AI agent is allowed to do through the MCP server.
  //
  // Both default to false and both should stay false. An agent that can approve
  // its own pictures has no safety net at all: it edits the code, notices the
  // picture moved, blesses the new picture, and reports success.
  // ---------------------------------------------------------------------------
  mcp: {
    allowApprove: false,
    allowMark: false,
  },

  // ---------------------------------------------------------------------------
  // Housekeeping
  // ---------------------------------------------------------------------------

  // Where approved pictures, guards, markers and results live.
  dir: '.staysfixed',

  // How many times a check may change its mind before it is condemned and the
  // tool starts saying so in red. Fix it or delete it — never tolerate it.
  flakeLimit: 2,

  // Re-photograph a failing screen this many times before calling it a real
  // change. A screen that only passes on the retry is recorded as a flake.
  retries: 1,

  // Screens photographed at once. One, on purpose: two browsers competing for
  // the same machine is exactly how pictures start disagreeing with themselves.
  concurrency: 1,
};

export default config;
