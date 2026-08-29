/**
 * An Electron desktop app, checked end to end.
 *
 * The difference from a web app is small on purpose: instead of an address, you
 * give it the executable to launch. Everything after that — screens, freezing,
 * masks, guards — works exactly the same way, because an Electron window is a
 * Chromium window with a different frame around it.
 */

import path from 'node:path';

/**
 * Point this at the app you actually ship, not at `electron .`. A packaged build
 * loads the real bundle, the real stylesheets and the real assets; running from
 * source loads whatever the dev server felt like serving that second.
 *
 * On macOS the executable is inside the bundle:
 *   /Applications/Your App.app/Contents/MacOS/Your App
 * On Linux it is the AppImage or the binary in the unpacked folder.
 * On Windows it is the .exe. (Windows is untested — see the README.)
 */
const APP_BINARY =
  process.platform === 'darwin'
    ? path.resolve('dist/mac-arm64/Your App.app/Contents/MacOS/Your App')
    : path.resolve('dist/linux-unpacked/your-app');

/** @type {import('../src/types.js').StaysFixedConfig} */
const config = {
  app: {
    kind: 'electron',
    binary: APP_BINARY,

    // Extra argv the app is launched with. A flag that puts the app into a
    // known state is worth more than any amount of tolerance tuning.
    args: ['--staysfixed', '--skip-onboarding'],

    // Working directory for the launched process.
    cwd: '.',

    // A separate data directory is not optional. Without it the run opens YOUR
    // installed copy's settings, your real sessions and your real window size —
    // and then writes to them. Point the app at a throwaway folder and every run
    // starts from the same place.
    env: {
      YOUR_APP_DATA_DIR: '.staysfixed/tmp/app-data',
      YOUR_APP_TELEMETRY: 'off',
    },

    // An Electron app usually opens more than one window: a splash, a hidden
    // background window, sometimes a devtools window. This picks the one whose
    // title or url contains this text, so the tool never photographs the splash.
    windowMatch: 'Your App',

    // How long to wait for the window to appear.
    startTimeoutMs: 60_000,

    // Leave `debugPort` out and a free port is chosen. Set it if your app opens
    // its remote debugging port itself and you have already fixed the number.
    // debugPort: 9333,

    // Or attach to an app that is already running with a debugging port open,
    // instead of launching one. Nothing you attach to is ever closed by the tool.
    // attach: 'http://127.0.0.1:9333',
  },

  // A desktop window is usually smaller than a browser viewport. Pick a size
  // once — changing it later means re-approving every picture.
  viewport: {
    width: 1280,
    height: 800,
    deviceScaleFactor: 2,
  },

  freeze: {
    clock: '2026-01-01T12:00:00.000Z',
    timezone: 'UTC',
    locale: 'en-US',
    motion: true,
    random: 'seeded',
    fonts: true,

    // Desktop apps talk to their own backend constantly — updates, licence
    // checks, sync. 'replay' records each reply once and then serves the same
    // bytes forever, which is usually the only way a desktop app renders the
    // same screen twice. The recordings live in .staysfixed/fixtures and belong
    // in git.
    network: 'replay',
    networkAllow: ['file://**', 'app://**'],
  },

  tolerance: {
    pixels: 0.0005,
    threshold: 0.12,
    antialiasing: true,
  },

  // Window chrome, an update banner and a clock in the status bar are all
  // allowed to change. The layout underneath is not.
  masks: ['.titlebar-buttons', '#update-banner', '[data-clock]'],

  screens: [
    {
      name: 'welcome',
      describe: 'The first window a new user sees',
      steps: [{ waitFor: '[data-view="welcome"]' }],
    },
    {
      name: 'workspace-empty',
      describe: 'An open workspace with nothing in it yet',
      steps: [
        { click: '[data-action="new-workspace"]' },
        { type: 'input[name="workspace-name"]', text: 'Demo' },
        { press: 'Enter' },
        { waitFor: '[data-view="workspace"]' },
        { waitForGone: '.spinner' },
      ],
    },
    {
      name: 'settings-appearance',
      describe: 'Settings, on the Appearance tab',
      async do(page) {
        await page.press('Escape');
        await page.click('[data-action="open-settings"]');
        await page.click('[data-tab="appearance"]');
        await page.waitFor('[data-settings-pane="appearance"]');
        // Scroll the pane so the theme picker is on screen, then let the list
        // finish settling before the shutter.
        await page.scrollTo('[data-setting="theme"]');
      },
      masks: ['[data-setting="version"]'],
    },
    {
      name: 'sidebar-collapsed',
      describe: 'The workspace with the sidebar collapsed',
      steps: [
        { click: '[data-action="toggle-sidebar"]' },
        { waitForGone: '.sidebar--open' },
      ],
    },
  ],

  guards: '.staysfixed/guards',

  walk: {
    describe: 'What a reviewer clicks through before a release goes out',
    steps: [
      { name: 'walk-welcome', describe: 'Welcome window', steps: [{ waitFor: '[data-view="welcome"]' }] },
      {
        name: 'walk-workspace',
        describe: 'A workspace, opened',
        steps: [{ click: '[data-action="new-workspace"]' }, { press: 'Enter' }, { waitFor: '[data-view="workspace"]' }],
      },
      {
        name: 'walk-settings',
        describe: 'Settings',
        steps: [{ click: '[data-action="open-settings"]' }, { waitFor: '[data-view="settings"]' }],
      },
    ],
  },

  mcp: {
    allowApprove: false,
    allowMark: false,
  },

  dir: '.staysfixed',
  flakeLimit: 2,
  retries: 1,
  concurrency: 1,
};

export default config;
