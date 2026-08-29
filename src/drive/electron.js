/**
 * A real desktop app, opened and driven the same way a browser is.
 *
 * Electron is Chrome underneath, so the same debugging connection works — but
 * two things are different and both bite. An Electron app ignores most of
 * Chrome's command line, and an Electron app can have several windows, only one
 * of which is the one a person means.
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { StaysFixedError, isExpected } from '../core/errors.js';
import { detail } from '../core/log.js';
import { DEFAULT_VIEWPORT } from '../core/config.js';
import { waitForEndpoint, listTargets, connect } from './cdp.js';
import { resolveElectronBinary, freePort } from './find.js';
import { createPage } from './page.js';
import { childEnv, delay, keepOutput, stopProcess } from './browser.js';

/**
 * The flags Electron actually honours at launch. The rest of Chrome's
 * determinism switches are set from inside the page by the freeze layer.
 * @param {Required<import('../types.js').ViewportConfig>} viewport
 * @returns {string[]}
 */
function electronRenderingArgs(viewport) {
  return [
    // Same pixel grid every run.
    `--force-device-scale-factor=${viewport.deviceScaleFactor}`,
    '--force-color-profile=srgb',
    '--disable-lcd-text',
    '--font-render-hinting=none',
    // No animation is half-finished at the moment of the shutter.
    '--force-prefers-reduced-motion',
    // A window that is behind another window gets slowed down, which turns
    // "wait for the list" into a random timeout.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ];
}

/**
 * @param {any[]} windows
 * @returns {string|undefined}
 */
function describeWindows(windows) {
  if (windows.length === 0) return undefined;
  const lines = windows.map((w) => `  ${String(w.title ?? '(no title)')}  —  ${String(w.url ?? '')}`);
  return `Windows the app has open right now:\n${lines.join('\n')}`;
}

/**
 * Pick the window to drive.
 * @param {string} endpoint
 * @param {string|undefined} match
 * @param {number} deadline epoch ms to give up at
 * @returns {Promise<any>}
 */
async function findWindow(endpoint, match, deadline) {
  /** @type {any[]} */
  let pages = [];
  for (;;) {
    const targets = /** @type {any[]} */ (await listTargets(endpoint));
    pages = targets.filter((t) => t && t.type === 'page');
    if (match) {
      const hit = pages.find(
        (t) => String(t.title ?? '').includes(match) || String(t.url ?? '').includes(match),
      );
      if (hit) return hit;
    } else {
      const real = pages.find((t) => {
        const url = String(t.url ?? '');
        return !url.startsWith('devtools://') && url !== 'about:blank' && url !== '';
      });
      if (real) return real;
    }
    if (Date.now() > deadline) break;
    // An Electron window is blank for the first moment of its life. Asking
    // again a beat later is the difference between driving the app and
    // photographing an empty rectangle.
    await delay(250);
  }

  if (!match) {
    // It stayed blank the whole time. Drive it anyway — an app whose window is
    // genuinely empty is exactly the kind of thing a picture check should catch.
    const blank = pages.find((t) => !String(t.url ?? '').startsWith('devtools://'));
    if (blank) return blank;
    throw new StaysFixedError('The app started but never opened a window to look at.', {
      hint: 'If it shows a splash window first, give it longer with `app.startTimeoutMs`.',
    });
  }
  throw new StaysFixedError(`The app has no window matching "${match}".`, {
    hint: describeWindows(pages) ?? 'Check `app.windowMatch` against the real window title.',
  });
}

/**
 * Start a desktop app and attach to its main window.
 * @param {import('../types.js').AppConfig} app
 * @param {import('./browser.js').LaunchOptions} [opts]
 * @returns {Promise<import('../types.js').LaunchedApp>}
 */
export async function launchElectron(app, opts = {}) {
  if (opts.signal?.aborted) {
    throw new StaysFixedError('Stopped before the app could start.');
  }
  if (!app.binary) {
    throw new StaysFixedError('This app has no `app.binary`, so there is nothing to open.', {
      hint: 'On macOS point it inside the bundle: /Applications/Your App.app/Contents/MacOS/Your App',
    });
  }

  const binary = await resolveElectronBinary(app.binary);
  const port = await freePort(app.debugPort);
  const viewport = { ...DEFAULT_VIEWPORT, ...(opts.viewport ?? {}) };
  const startTimeoutMs = app.startTimeoutMs ?? 60_000;
  const extraArgs = app.args ?? [];

  // Never point a real app at a real person's data. If the caller or the config
  // already chose a profile we respect it; otherwise we make a scratch one and
  // delete it afterwards.
  const configured = extraArgs.some((a) => String(a).startsWith('--user-data-dir'));
  const ownProfile = !opts.userDataDir && !configured;
  const profileDir = opts.userDataDir ?? (ownProfile ? await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-app-')) : null);

  /** @type {string[]} */
  const args = [`--remote-debugging-port=${port}`, '--remote-allow-origins=*'];
  if (profileDir) args.push(`--user-data-dir=${profileDir}`);
  args.push(...electronRenderingArgs(viewport), ...extraArgs);

  detail(`app: ${binary}`);
  detail(`debugging port: ${port}`);

  const child = spawn(binary, args, {
    cwd: app.cwd,
    env: childEnv(app, opts),
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: opts.signal,
  });
  const output = keepOutput(child);

  const diedEarly = /** @type {Promise<never>} */ (
    new Promise((_resolve, reject) => {
      child.once('error', (cause) => {
        reject(
          new StaysFixedError(`Could not run the app at ${binary}.`, {
            hint: 'Check `app.binary` points at the executable, not the folder.',
            cause,
          }),
        );
      });
      child.once('exit', (code, signal) => {
        reject(
          new StaysFixedError(
            `The app quit before it was ready (${signal ? `signal ${signal}` : `exit code ${code}`}).`,
            { hint: output() ? `The last thing it said:\n${output()}` : undefined },
          ),
        );
      });
    })
  );
  // A normal quit later on must not crash the CLI with an unhandled rejection.
  diedEarly.catch(() => {});

  const endpoint = `http://127.0.0.1:${port}`;
  /** @type {import('../types.js').CdpSession|null} */
  let session = null;

  try {
    /** @type {any} */
    let version;
    try {
      version = await Promise.race([
        waitForEndpoint(endpoint, { timeoutMs: startTimeoutMs, intervalMs: 200 }),
        diedEarly,
      ]);
    } catch (cause) {
      if (isExpected(cause)) throw cause;
      throw new StaysFixedError('The app started but never opened its debugging connection.', {
        hint: output()
          ? `The last thing it said:\n${output()}`
          : 'Some apps only allow this in a development build. Check it starts with --remote-debugging-port by hand.',
        cause,
      });
    }

    const wsUrl = version?.webSocketDebuggerUrl;
    if (!wsUrl) {
      throw new StaysFixedError('The app answered but did not offer a debugging connection.');
    }

    const cdp = /** @type {import('../types.js').CdpSession} */ (await connect(wsUrl, { timeoutMs: 15_000 }));
    session = cdp;

    const chosen = await findWindow(endpoint, app.windowMatch, Date.now() + startTimeoutMs);
    const targetId = String(chosen.id ?? chosen.targetId);
    detail(`window: ${String(chosen.title ?? '(no title)')} — ${String(chosen.url ?? '')}`);

    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = String(attached.sessionId);
    const page = await createPage(
      cdp,
      /** @type {any} */ ({ sessionId, targetId, baseUrl: app.url ?? null, timeoutMs: startTimeoutMs }),
    );

    /** @type {Promise<void>|null} */
    let closing = null;
    const close = () => {
      // Safe to call twice: the second caller waits on the first close.
      closing ??= (async () => {
        try {
          await cdp.send('Target.detachFromTarget', { sessionId });
        } catch {
          // The window may already be gone, which is where we were heading.
        }
        try {
          await cdp.close();
        } catch {
          // Hanging up cannot meaningfully fail.
        }
        // A desktop app can take a moment to save its state on the way out, so
        // it gets longer than a browser does before we insist.
        await stopProcess(child, 5000);
        if (ownProfile && profileDir) {
          await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
        }
      })();
      return closing;
    };

    return { cdp, page, close, endpoint, pid: child.pid ?? null, kind: 'electron' };
  } catch (e) {
    // Half-launched means a leaked app window sitting on somebody's screen.
    if (session) await session.close().catch(() => {});
    await stopProcess(child, 2000);
    if (ownProfile && profileDir) await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Every window the app currently has open. `staysfixed doctor` prints this so a
 * person can see which one a check will drive, and what to put in `windowMatch`.
 * @param {string} endpoint
 * @returns {Promise<{id: string, title: string, url: string, type: string}[]>}
 */
export async function listElectronWindows(endpoint) {
  const targets = /** @type {any[]} */ (await listTargets(endpoint));
  const windows = targets.map((t) => ({
    id: String(t?.id ?? t?.targetId ?? ''),
    title: String(t?.title ?? ''),
    url: String(t?.url ?? ''),
    type: String(t?.type ?? ''),
  }));
  // Real windows first. An app also reports service workers and popups, and the
  // first row a person reads should be the one a check would actually drive.
  return windows.sort((a, b) => Number(b.type === 'page') - Number(a.type === 'page'));
}
