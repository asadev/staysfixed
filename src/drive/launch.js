/**
 * One door in. Everything that needs an app open — a picture check, a guard, a
 * walk, the MCP server — comes through here and gets back the same thing back:
 * a page it can drive and a `close()` that cleans up exactly what we started.
 */

import { StaysFixedError } from '../core/errors.js';
import { detail } from '../core/log.js';
import { fetchVersion, listTargets, connect } from './cdp.js';
import { createPage } from './page.js';
import { launchBrowser, startWebApp, delay } from './browser.js';
import { launchElectron } from './electron.js';

/**
 * Accept the endpoint however a person naturally writes it: a full address, a
 * host and port, or just the port.
 * @param {string} value
 * @returns {string}
 */
function normalizeEndpoint(value) {
  const v = String(value).trim();
  if (/^\d+$/.test(v)) return `http://127.0.0.1:${v}`;
  if (!/^https?:\/\//i.test(v)) return `http://${v}`;
  return v.replace(/\/+$/, '');
}

/**
 * @param {string} endpoint
 * @param {string|undefined} match
 * @param {number} deadline epoch ms
 * @returns {Promise<any>}
 */
async function pickTarget(endpoint, match, deadline) {
  /** @type {any[]} */
  let pages = [];
  for (;;) {
    const targets = /** @type {any[]} */ (await listTargets(endpoint));
    pages = targets.filter((t) => t && t.type === 'page' && !String(t.url ?? '').startsWith('devtools://'));
    const hit = match
      ? pages.find((t) => String(t.title ?? '').includes(match) || String(t.url ?? '').includes(match))
      : pages[0];
    if (hit) return hit;
    if (Date.now() > deadline) break;
    await delay(250);
  }
  const open = pages.map((t) => `  ${String(t.title ?? '(no title)')}  —  ${String(t.url ?? '')}`).join('\n');
  throw new StaysFixedError(
    match ? `Nothing open there matches "${match}".` : 'That app is running, but it has no window open to look at.',
    { hint: open ? `What it does have open:\n${open}` : undefined },
  );
}

/**
 * Attach to something that is already running.
 *
 * We did not start this process, so we must NEVER stop it. `close()` here only
 * hangs up the debugging socket. Killing a person's running app because a check
 * finished would be unforgivable, and it is a one-line mistake to make.
 * @param {import('../types.js').AppConfig} app
 * @returns {Promise<import('../types.js').LaunchedApp>}
 */
async function attachToApp(app) {
  const endpoint = normalizeEndpoint(String(app.attach));
  const timeoutMs = app.startTimeoutMs ?? 30_000;

  /** @type {any} */
  let version;
  try {
    version = await fetchVersion(endpoint);
  } catch (cause) {
    throw new StaysFixedError(`Nothing is answering at ${endpoint}.`, {
      hint: 'Start the app with a debugging port open, or remove `app.attach` to let Stays Fixed start it.',
      cause,
    });
  }
  const wsUrl = version?.webSocketDebuggerUrl;
  if (!wsUrl) {
    throw new StaysFixedError(`Something answered at ${endpoint}, but it is not an app I can drive.`);
  }

  const cdp = /** @type {import('../types.js').CdpSession} */ (await connect(wsUrl, { timeoutMs: 15_000 }));
  try {
    const target = await pickTarget(endpoint, app.windowMatch, Date.now() + timeoutMs);
    const targetId = String(target.id ?? target.targetId);
    detail(`attached to: ${String(target.title ?? '(no title)')} — ${String(target.url ?? '')}`);

    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = String(attached.sessionId);
    const page = await createPage(
      cdp,
      /** @type {any} */ ({ sessionId, targetId, baseUrl: app.url ?? null, timeoutMs }),
    );

    /** @type {Promise<void>|null} */
    let closing = null;
    const close = () => {
      closing ??= (async () => {
        try {
          await cdp.send('Target.detachFromTarget', { sessionId });
        } catch {
          // Detaching from something that already went away is fine.
        }
        try {
          await cdp.close();
        } catch {
          // Hanging up cannot meaningfully fail.
        }
        // Deliberately nothing else. We did not start it; we do not stop it.
      })();
      return closing;
    };

    return { cdp, page, close, endpoint, pid: null, kind: app.kind };
  } catch (e) {
    await cdp.close().catch(() => {});
    throw e;
  }
}

/**
 * Put the window at the size the pictures were approved at. Doing this before
 * anyone gets the handle means every caller starts from the same geometry.
 * @param {import('../types.js').LaunchedApp} launched
 * @param {import('../types.js').ViewportConfig} viewport
 * @returns {Promise<import('../types.js').LaunchedApp>}
 */
async function withViewport(launched, viewport) {
  try {
    await launched.page.setViewport(viewport);
    return launched;
  } catch (e) {
    // A half-launched app is a leaked process on somebody's machine.
    await launched.close().catch(() => {});
    throw e;
  }
}

/**
 * Open the project's app, whatever kind it is, and hand back a page to drive.
 * @param {import('../types.js').Project} project
 * @param {import('./browser.js').LaunchOptions} [opts]
 * @returns {Promise<import('../types.js').LaunchedApp>}
 */
export async function launchApp(project, opts = {}) {
  const { app, viewport, freeze } = project.config;

  /** @type {import('./browser.js').LaunchOptions} */
  const launchOpts = {
    ...opts,
    viewport: opts.viewport ?? viewport,
    // The clock's timezone and the locale have to be set on the process before
    // it starts, so they travel down from the freeze settings with the launch.
    timezone: opts.timezone ?? freeze.timezone,
    locale: opts.locale ?? freeze.locale,
  };

  if (app.attach) {
    return await withViewport(await attachToApp(app), viewport);
  }

  if (app.kind === 'electron') {
    return await withViewport(await launchElectron(app, launchOpts), viewport);
  }

  /** @type {{stop: () => Promise<void>, pid: number|null}|null} */
  let server = null;
  try {
    // The app has to be answering before the browser goes looking for it.
    if (app.start) server = await startWebApp(app, launchOpts);
    const browser = await launchBrowser(app, launchOpts);
    const startedServer = server;

    /** @type {import('../types.js').LaunchedApp} */
    const launched = {
      ...browser,
      close: async () => {
        // Browser first: the dev server is what it is looking at, and pulling
        // the floor out first produces a page of connection errors.
        await browser.close();
        if (startedServer) await startedServer.stop();
      },
    };
    return await withViewport(launched, viewport);
  } catch (e) {
    if (server) await server.stop().catch(() => {});
    throw e;
  }
}

/**
 * Settle a desktop app between checks.
 *
 * This deliberately does NOT reload the window, and the reason is worth keeping.
 *
 * Reloading looked like the obvious way to give a desktop app the isolation a web app
 * gets for free from its `goto`. It was tried, and it made a guard fail one run in two:
 * a complex Electron renderer re-initialises on reload and asks its main process for
 * state that the main process had already sent once and does not send again, so the app
 * sometimes came back half-wired — a window that looked right with half its controls
 * missing. A reset that works half the time is worse than no reset, because it turns a
 * green suite into a coin toss and teaches people to re-run until it passes.
 *
 * So a desktop app is left alone. Its screens run in the order they are written, the
 * pointer is parked, the DOM is allowed to go quiet, and a screen that changes something
 * the app SAVES puts it back with its own `after` steps. That is honest about what a
 * desktop app is, and it holds still.
 *
 * @param {import('../types.js').LaunchedApp} app
 * @returns {Promise<void>}
 */
export async function resetWindow(app) {
  try {
    await app.page.moveMouseAway();
    await waitForQuietDom(app, { quietMs: 150, timeoutMs: 3000 });
  } catch {
    // Nothing here is worth failing a check over.
  }
}

/**
 * Wait until the page stops changing itself.
 *
 * Resolves after `quietMs` with no DOM mutation, or gives up at `timeoutMs` — giving up
 * is not an error, it just means the app never stops fidgeting and the settle loop will
 * have to carry it.
 *
 * @param {import('../types.js').LaunchedApp} app
 * @param {{quietMs?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<void>}
 */
export async function waitForQuietDom(app, opts = {}) {
  const quietMs = opts.quietMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const source = `(() => new Promise((resolve) => {
    var done = false;
    var timer = null;
    var finish = function (why) {
      if (done) return;
      done = true;
      try { obs.disconnect(); } catch (e) {}
      if (timer) clearTimeout(timer);
      clearTimeout(cap);
      resolve(why);
    };
    var arm = function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { finish('quiet'); }, ${quietMs});
    };
    var obs = new MutationObserver(arm);
    try {
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    } catch (e) {
      return finish('no-observer');
    }
    var cap = setTimeout(function () { finish('gave-up'); }, ${timeoutMs});
    arm();
  }))()`;
  try {
    await app.page.evaluate(source);
  } catch {
    // A context that vanished mid-wait is not worth failing over.
  }
}
