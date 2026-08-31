/**
 * Headless Chrome, opened the same way every single time.
 *
 * A picture check is only worth anything if the browser that took today's
 * picture behaved exactly like the browser that took the approved one. Almost
 * everything in this file exists to remove a source of difference: a leftover
 * profile, a font smoothing setting, a background download, a throttled timer.
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { StaysFixedError, isExpected } from '../core/errors.js';
import { detail } from '../core/log.js';
import { stopTree, OWN_PROCESS_GROUP } from '../core/stop-tree.js';
import { DEFAULT_VIEWPORT } from '../core/config.js';
import { waitForEndpoint, listTargets, connect } from './cdp.js';
import { requireChrome, freePort } from './find.js';
import { createPage } from './page.js';

/**
 * @typedef {object} LaunchOptions
 * @property {AbortSignal} [signal]         Abort while we are waiting; the child is taken down with us.
 * @property {string} [userDataDir]         Use this profile instead of a throwaway one.
 * @property {import('../types.js').ViewportConfig} [viewport]
 * @property {string} [timezone]            IANA zone forced on the process (from freeze.timezone).
 * @property {string} [locale]              BCP-47 locale forced on the process (from freeze.locale).
 */

/** How many lines of the child's output we keep to quote back when it fails. */
const OUTPUT_KEEP = 40;

/**
 * Sleep. Deliberately a normal timer: every wait in this file is something we
 * are genuinely waiting for, and an unref'd one lets Node decide the program is
 * idle and walk out in the middle of a poll.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * A timer made for racing, which can be called off. Without the cancel, a
 * command that finishes early still sits in the terminal until the timeout it
 * already beat runs out.
 * @template T
 * @param {number} ms
 * @param {T} value
 * @returns {{promise: Promise<T>, cancel: () => void}}
 */
function raceTimer(ms, value) {
  /** @type {any} */
  let handle;
  const promise = /** @type {Promise<T>} */ (
    new Promise((resolve) => {
      handle = setTimeout(() => resolve(value), ms);
    })
  );
  return { promise, cancel: () => clearTimeout(handle) };
}

/**
 * Keep the tail of everything a child says. When a browser or a dev server
 * refuses to start, its last few lines are the only useful thing we can show a
 * person — "could not start" on its own helps nobody.
 * @param {import('node:child_process').ChildProcess} child
 * @returns {() => string} the last few lines, newest last
 */
export function keepOutput(child) {
  /** @type {string[]} */
  const lines = [];
  /** @param {string|Buffer} chunk */
  const take = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      lines.push(trimmed);
      if (lines.length > OUTPUT_KEEP) lines.shift();
    }
  };
  child.stdout?.on('data', take);
  child.stderr?.on('data', take);
  return () => lines.slice(-8).join('\n');
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @returns {boolean}
 */
function isGone(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<void>}
 */
export function whenExited(child) {
  if (isGone(child)) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
  });
}

/**
 * Ask a process to stop, then insist. Safe to call on something already gone.
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} graceMs how long politeness gets before SIGKILL
 * @returns {Promise<void>}
 */
export async function stopProcess(child, graceMs) {
  if (isGone(child)) return;
  const exited = whenExited(child);
  // The tree, not just this one process. A browser is never one process — it is a parent and
  // a renderer for every page — and on Windows killing only the parent leaves the renderers
  // running, still writing into the throwaway profile, so the profile folder cannot be
  // deleted and outlives the run. That is the one thing "nothing it opened outlives the run"
  // promises. Measured on a real Windows 11 machine on 2026-08-31.
  stopTree(child.pid, 'SIGTERM', { child });
  const grace = raceTimer(graceMs, false);
  const stopped = await Promise.race([exited.then(() => true), grace.promise]);
  grace.cancel();
  if (stopped) return;
  stopTree(child.pid, 'SIGKILL', { child });
  const last = raceTimer(1000, false);
  await Promise.race([exited, last.promise]);
  last.cancel();
}

/**
 * The environment a launched app runs in.
 * @param {import('../types.js').AppConfig} app
 * @param {LaunchOptions} opts
 * @returns {NodeJS.ProcessEnv}
 */
export function childEnv(app, opts) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, ...(app.env ?? {}) };
  // The timezone has to be settled before the process starts. A timestamp
  // rendered in Karachi and the same timestamp rendered in UTC are two
  // different pictures, and the page can only override so much after the fact.
  if (opts.timezone) env.TZ = opts.timezone;
  if (opts.locale) {
    // BCP-47 ('en-US') is what the page speaks; POSIX ('en_US.UTF-8') is what
    // the process speaks. Same locale, two spellings.
    const posix = opts.locale.replace('-', '_');
    env.LANG = `${posix}.UTF-8`;
    env.LC_ALL = `${posix}.UTF-8`;
  }
  return env;
}

/**
 * The flags. Each group removes one way today's picture could differ from the
 * approved one for a reason that has nothing to do with the code.
 * @param {import('../types.js').AppConfig} app
 * @param {{port: number, profileDir: string, viewport: Required<import('../types.js').ViewportConfig>}} ctx
 * @returns {string[]}
 */
function chromeArgs(app, ctx) {
  const { port, profileDir, viewport } = ctx;
  /** @type {string[]} */
  const args = [];

  if (app.headless !== false) args.push('--headless=new');
  args.push(
    `--remote-debugging-port=${port}`,
    // Node's WebSocket sends no Origin header, but Electron-era Chrome refuses
    // sockets from an unknown one; saying "any" costs nothing on a throwaway browser.
    '--remote-allow-origins=*',
    // Never, ever the user's real profile: their cookies, extensions and
    // half-open tabs are exactly the kind of difference this tool must not have.
    `--user-data-dir=${profileDir}`,
  );

  // Pixels must land in the same place run after run. Subpixel text, the GPU's
  // idea of anti-aliasing and a colour profile read from the monitor are the
  // three classic reasons an identical page photographs differently.
  args.push(
    `--force-device-scale-factor=${viewport.deviceScaleFactor}`,
    '--force-color-profile=srgb',
    '--font-render-hinting=none',
    '--disable-lcd-text',
    '--disable-font-subpixel-positioning',
    '--disable-gpu',
    '--disable-skia-runtime-opts',
    '--disable-partial-raster',
    '--disable-composited-antialiasing',
    '--hide-scrollbars',
    '--disable-smooth-scrolling',
    '--force-prefers-reduced-motion',
  );

  // Nothing may pop up in front of the app, and nothing may go out to the
  // network on Chrome's own account. Both would show up in the picture, and the
  // second one also makes runs depend on somebody else's server being awake.
  args.push(
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--metrics-recording-only',
    '--disable-client-side-phishing-detection',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain',
    '--mute-audio',
    '--disable-notifications',
    '--deny-permission-prompts',
  );

  // A headless window counts as hidden, and Chrome slows hidden pages down.
  // That turns "wait for the list to load" into a flaky timeout.
  args.push(
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-ipc-flooding-protection',
  );

  // Containers give /dev/shm 64MB, which crashes tabs mid-screenshot.
  args.push('--disable-dev-shm-usage');
  // Chrome refuses to run as root with a sandbox. CI images often are root;
  // a person's laptop never is, so this stays off unless we truly have to.
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');

  args.push(`--window-size=${Math.round(viewport.width)},${Math.round(viewport.height)}`);
  // Open on a blank page on purpose: the new-tab page talks to Google and
  // renders differently depending on who is signed in.
  args.push('about:blank');
  return args;
}

/**
 * Find the tab we are going to drive. A freshly started Chrome sometimes lists
 * its page a beat after it starts answering, so we ask again rather than fail.
 * @param {string} endpoint
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
async function firstPageTarget(endpoint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const targets = /** @type {any[]} */ (await listTargets(endpoint));
    const page = targets.find(
      (t) => t && t.type === 'page' && !String(t.url ?? '').startsWith('devtools://'),
    );
    if (page) return page;
    if (Date.now() > deadline) {
      throw new StaysFixedError('The browser started but never opened a page to look at.', {
        hint: 'This usually means Chrome was killed while starting. Try running the same check again.',
      });
    }
    await delay(150);
  }
}

/**
 * Start a browser and attach to its first page.
 * @param {import('../types.js').AppConfig} app
 * @param {LaunchOptions} [opts]
 * @returns {Promise<import('../types.js').LaunchedApp>}
 */
export async function launchBrowser(app, opts = {}) {
  if (opts.signal?.aborted) {
    throw new StaysFixedError('Stopped before the browser could start.');
  }

  const chrome = await requireChrome(app.browser);
  const port = await freePort(app.debugPort);
  const viewport = { ...DEFAULT_VIEWPORT, ...(opts.viewport ?? {}) };
  const startTimeoutMs = app.startTimeoutMs ?? 60_000;

  // A throwaway profile is what lets us promise we never touched the browser
  // the person actually uses.
  const ownProfile = !opts.userDataDir;
  const profileDir = opts.userDataDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-chrome-')));

  const args = chromeArgs(app, { port, profileDir, viewport });
  detail(`browser: ${chrome}`);
  detail(`debugging port: ${port}`);

  const child = spawn(chrome, args, {
    cwd: app.cwd,
    env: childEnv(app, opts),
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: opts.signal,
  });
  const output = keepOutput(child);

  /**
   * If the browser dies while we are waiting, say so immediately instead of
   * sitting out the whole timeout.
   */
  const diedEarly = /** @type {Promise<never>} */ (
    new Promise((_resolve, reject) => {
      child.once('error', (cause) => {
        reject(
          new StaysFixedError(`Could not run the browser at ${chrome}.`, {
            hint: 'Set `app.browser` in your config to the Chrome or Chromium you want used.',
            cause,
          }),
        );
      });
      child.once('exit', (code, signal) => {
        reject(
          new StaysFixedError(
            `The browser quit before it was ready (${signal ? `signal ${signal}` : `exit code ${code}`}).`,
            { hint: quote(output()) },
          ),
        );
      });
    })
  );
  // The browser exiting later, on purpose, must not crash the CLI with an
  // unhandled rejection. This catch does not stop the race below from seeing it.
  diedEarly.catch(() => {});

  const endpoint = `http://127.0.0.1:${port}`;
  /** @type {import('../types.js').CdpSession|null} */
  let session = null;

  try {
    // waitForEndpoint hands back the browser's own description of itself,
    // which is where the debugging address lives.
    /** @type {any} */
    let version;
    try {
      version = await Promise.race([
        waitForEndpoint(endpoint, { timeoutMs: startTimeoutMs, intervalMs: 100 }),
        diedEarly,
      ]);
    } catch (cause) {
      if (isExpected(cause)) throw cause;
      throw new StaysFixedError('The browser started but never answered, so nothing could be photographed.', {
        hint: quote(output()) || 'Run the same command again with --verbose to see what the browser printed.',
        cause,
      });
    }

    const wsUrl = version?.webSocketDebuggerUrl;
    if (!wsUrl) {
      throw new StaysFixedError('The browser answered but did not offer a debugging connection.');
    }

    const cdp = /** @type {import('../types.js').CdpSession} */ (await connect(wsUrl, { timeoutMs: 15_000 }));
    session = cdp;

    const target = await firstPageTarget(endpoint, Math.min(startTimeoutMs, 20_000));
    const targetId = String(target.id ?? target.targetId);
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
          // The page may already be gone; that is the outcome we wanted anyway.
        }
        try {
          await cdp.send('Browser.close');
        } catch {
          // Asking politely can fail if it is already quitting. The signals below finish the job.
        }
        try {
          await cdp.close();
        } catch {
          // Hanging up cannot meaningfully fail.
        }
        await stopProcess(child, 3000);
        if (ownProfile) {
          // Throwaway profiles are small but a check runs hundreds of times.
          await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
        }
      })();
      return closing;
    };

    return { cdp, page, close, endpoint, pid: child.pid ?? null, kind: 'web' };
  } catch (e) {
    // Never leave a browser behind because starting failed halfway.
    if (session) await session.close().catch(() => {});
    await stopProcess(child, 2000);
    if (ownProfile) await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/**
 * @param {string} text
 * @returns {string|undefined}
 */
function quote(text) {
  return text ? `The last thing it said:\n${text}` : undefined;
}

/**
 * Does anything answer at this address? Any HTTP reply counts, including a 404
 * or a 500 — a dev server that says "not found" is a dev server that is up.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function answers(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(3000) });
      // Let the body go, otherwise the socket stays open for the whole run.
      await res.body?.cancel().catch(() => {});
      return true;
    } catch {
      // HEAD is refused by some dev servers; GET gets a second chance below.
    }
  }
  return false;
}

/**
 * Start the app's own dev server and wait until it answers.
 * @param {import('../types.js').AppConfig} app
 * @param {LaunchOptions} [opts]
 * @returns {Promise<{stop: () => Promise<void>, pid: number|null}>}
 */
export async function startWebApp(app, opts = {}) {
  if (!app.start) {
    throw new StaysFixedError('There is no start command to run.', {
      hint: 'Set `app.start` in your config, or start the app yourself before running this.',
    });
  }
  const url = app.url;
  if (!url) {
    throw new StaysFixedError('`app.url` is missing, so there is no address to wait for.');
  }

  const child = spawn(app.start, {
    cwd: app.cwd ?? process.cwd(),
    env: childEnv(app, opts),
    shell: true,
    // Its own process group. A dev server is really a shell that spawns a
    // bundler that spawns a watcher; killing only the shell leaves the port held
    // and the next run fails for a reason nobody can see.
    //
    // Not on Windows, where `detached: true` means something else entirely — a console
    // WINDOW of its own, flashing up on the person's screen in the middle of a check.
    // Windows stops the tree a different way, in `stopTree`, and needs nothing at spawn time.
    detached: OWN_PROCESS_GROUP,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = keepOutput(child);
  // A shell that cannot even be started emits 'error' and never 'exit', so we
  // hold on to it and report it from the wait loop instead of waiting it out.
  /** @type {{ failure: Error|null }} */
  const startFailure = { failure: null };
  child.on('error', (e) => {
    startFailure.failure = e;
  });

  const pid = child.pid ?? null;

  /** @type {Promise<void>|null} */
  let stopping = null;
  const stop = () => {
    stopping ??= (async () => {
      if (isGone(child)) return;
      const exited = whenExited(child);
      // The whole tree, not just the shell. On Linux and a Mac that is the process group;
      // on Windows it is `taskkill /T`, which is what `stopTree` reaches for. Before this,
      // Windows killed `cmd.exe` and left the dev server holding the port, so the next run
      // failed for a reason nobody could see — the exact outcome the comment above warns
      // about, on the one operating system where the code did not do it. Found 2026-08-31.
      stopTree(pid, 'SIGTERM', { child });
      const grace = raceTimer(5000, false);
      const gone = await Promise.race([exited.then(() => true), grace.promise]);
      grace.cancel();
      if (gone) return;
      stopTree(pid, 'SIGKILL', { child });
      const last = raceTimer(1000, false);
      await Promise.race([exited, last.promise]);
      last.cancel();
    })();
    return stopping;
  };

  detail(`starting the app: ${app.start}`);
  const deadline = Date.now() + (app.startTimeoutMs ?? 60_000);
  for (;;) {
    if (await answers(url)) {
      detail(`the app answered at ${url}`);
      return { stop, pid };
    }
    if (startFailure.failure) {
      throw new StaysFixedError(`Could not run the start command: ${app.start}`, {
        hint: 'Check `app.start` and `app.cwd` in your config.',
        cause: startFailure.failure,
      });
    }
    if (isGone(child)) {
      throw new StaysFixedError(`The start command stopped before ${url} answered.`, {
        hint: quote(output()) ?? 'Try running the start command yourself to see what it says.',
      });
    }
    if (Date.now() > deadline) {
      await stop();
      throw new StaysFixedError(`Waited for ${url} but nothing answered.`, {
        hint:
          quote(output()) ??
          'Check that `app.start` really serves `app.url`, or raise `app.startTimeoutMs` if it is just slow.',
      });
    }
    await delay(250);
  }
}
