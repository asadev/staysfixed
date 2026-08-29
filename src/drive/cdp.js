/**
 * A tiny Chrome DevTools Protocol client.
 *
 * Chrome, Edge and Electron all speak the same protocol over one WebSocket, so
 * this is the only "driver" the tool needs — no puppeteer, no playwright.
 * Node 22 gives us `fetch` and `WebSocket` as globals, so there is nothing to install.
 */

import { StaysFixedError } from '../core/errors.js';
import { warn } from '../core/log.js';

/** Trim a trailing slash so `${endpoint}/json/version` never doubles up. */
function tidyEndpoint(/** @type {string} */ endpoint) {
  return String(endpoint).replace(/\/+$/, '');
}

/**
 * Combine an optional caller signal with our own deadline, so a hung port
 * cannot wedge a run forever.
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 * @returns {AbortSignal}
 */
function deadline(timeoutMs, signal) {
  const own = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([own, signal]) : own;
}

/**
 * @param {number} ms
 * @returns {string}
 */
function seconds(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s} second${s === 1 ? '' : 's'}`;
}

/**
 * Ask the app which WebSocket to talk to.
 * @param {string} endpoint  e.g. "http://127.0.0.1:9333"
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<{webSocketDebuggerUrl: string, Browser: string} & Record<string, any>>}
 */
export async function fetchVersion(endpoint, opts = {}) {
  const base = tidyEndpoint(endpoint);
  /** @type {Response} */
  let res;
  try {
    res = await fetch(`${base}/json/version`, {
      signal: deadline(opts.timeoutMs ?? 5000, opts.signal),
      headers: { Accept: 'application/json' },
    });
  } catch (e) {
    throw new StaysFixedError(`Nothing is answering at ${base}.`, {
      hint: 'The app is either not running yet or is listening somewhere else.',
      cause: e,
    });
  }
  if (!res.ok) {
    throw new StaysFixedError(
      `The app answered on ${base} but would not say what it is (it replied ${res.status}).`,
      { hint: 'Something else may be listening on that port. Pick another one with app.debugPort.' },
    );
  }
  const body = /** @type {any} */ (await res.json());
  if (!body || typeof body.webSocketDebuggerUrl !== 'string') {
    throw new StaysFixedError(
      `The app on ${base} did not offer a debug connection.`,
      { hint: 'Start it with --remote-debugging-port so Stays Fixed can drive it.' },
    );
  }
  return body;
}

/**
 * Poll until the app opens its debug port. Apps take a moment to boot; this is
 * the difference between "flaky" and "reliable" on a cold machine.
 * @param {string} endpoint
 * @param {{timeoutMs?: number, intervalMs?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<{webSocketDebuggerUrl: string, Browser: string} & Record<string, any>>}
 */
export async function waitForEndpoint(endpoint, opts = {}) {
  const base = tidyEndpoint(endpoint);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 200;
  const until = Date.now() + timeoutMs;
  /** @type {unknown} */
  let last = null;

  for (;;) {
    if (opts.signal?.aborted) {
      throw new StaysFixedError('Stopped while waiting for the app to open its debug port.');
    }
    try {
      return await fetchVersion(base, { timeoutMs: Math.min(3000, timeoutMs), signal: opts.signal });
    } catch (e) {
      last = e;
    }
    if (Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new StaysFixedError(
    `The app never opened its debug port at ${base}. Stays Fixed waited ${seconds(timeoutMs)}.`,
    {
      hint: 'Check that the app really starts (run the start command yourself), that it is not already running on that port, and that app.startTimeoutMs is long enough.',
      cause: last,
    },
  );
}

/**
 * List the tabs / windows the app is showing.
 * @param {string} endpoint
 * @returns {Promise<Array<{id: string, type: string, title: string, url: string, webSocketDebuggerUrl?: string, attached?: boolean}>>}
 */
export async function listTargets(endpoint) {
  const base = tidyEndpoint(endpoint);
  /** @type {Response} */
  let res;
  try {
    res = await fetch(`${base}/json/list`, {
      signal: deadline(5000),
      headers: { Accept: 'application/json' },
    });
  } catch (e) {
    throw new StaysFixedError(`Nothing is answering at ${base}, so Stays Fixed cannot see the app's windows.`, {
      cause: e,
    });
  }
  if (!res.ok) {
    throw new StaysFixedError(
      `Could not ask ${base} what windows it has open (it replied ${res.status}).`,
    );
  }
  const body = /** @type {any} */ (await res.json());
  if (!Array.isArray(body)) {
    throw new StaysFixedError(`The app on ${base} sent back a window list Stays Fixed could not read.`);
  }
  return body;
}

/**
 * Turn a CDP error object into something a human can act on.
 * @param {string} method
 * @param {any} err
 */
function protocolError(method, err) {
  const detail = err && typeof err === 'object' ? String(err.message ?? 'no reason given') : String(err);
  const extra = err && typeof err === 'object' && err.data ? ` (${String(err.data)})` : '';
  return new StaysFixedError(`The app refused the request "${method}": ${detail}${extra}`);
}

/**
 * Open a connection to the app and keep it alive.
 * @param {string} webSocketDebuggerUrl
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<import('../types.js').CdpSession>}
 */
export async function connect(webSocketDebuggerUrl, opts = {}) {
  const callTimeoutMs = opts.timeoutMs ?? 30_000;

  /** @type {WebSocket} */
  let ws;
  try {
    ws = new WebSocket(webSocketDebuggerUrl);
  } catch (e) {
    throw new StaysFixedError(`Stays Fixed could not open a debug connection to the app.`, { cause: e });
  }

  /** @type {Map<number, {resolve: (v: any) => void, reject: (e: unknown) => void, timer: ReturnType<typeof setTimeout>, method: string}>} */
  const pending = new Map();
  /** @type {Map<string, Set<(params: any, sessionId?: string) => void>>} */
  const listeners = new Map();

  let nextId = 0;
  let shut = false;
  let warnedAboutJunk = false;

  // A socket with no error listener throws at the top level and kills the run.
  ws.addEventListener('error', () => {});

  /**
   * @param {string} event
   * @param {any} params
   * @param {string|undefined} sessionId
   */
  function dispatch(event, params, sessionId) {
    const exact = listeners.get(event);
    if (exact) {
      for (const handler of [...exact]) {
        try {
          handler(params, sessionId);
        } catch {
          // A misbehaving listener must never take the connection down with it.
        }
      }
    }
    const all = listeners.get('*');
    if (all) {
      for (const handler of [...all]) {
        try {
          handler({ method: event, params, sessionId }, sessionId);
        } catch {
          /* same */
        }
      }
    }
  }

  ws.addEventListener('message', (/** @type {MessageEvent<any>} */ event) => {
    // Screenshots come back as one very large text frame; parsing is the only cost.
    const raw = typeof event.data === 'string' ? event.data : String(event.data ?? '');
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      if (!warnedAboutJunk) {
        warnedAboutJunk = true;
        warn('The app sent something Stays Fixed could not read. Ignoring it and carrying on.');
      }
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.id !== undefined && msg.id !== null) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(protocolError(entry.method, msg.error));
      else entry.resolve(msg.result ?? {});
      return;
    }

    if (typeof msg.method === 'string') {
      dispatch(msg.method, msg.params ?? {}, typeof msg.sessionId === 'string' ? msg.sessionId : undefined);
    }
  });

  ws.addEventListener('close', () => {
    shut = true;
    const dead = new StaysFixedError(
      "The app's debug connection closed while Stays Fixed was still talking to it.",
      { hint: 'The app probably quit or crashed. Check that it stays open on its own.' },
    );
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(dead);
    }
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      done();
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      reject(
        new StaysFixedError('The app accepted a debug connection but never finished opening it.', {
          hint: 'Try starting the app again, or give it longer with app.startTimeoutMs.',
        }),
      );
    }, callTimeoutMs);

    const onOpen = () => {
      done();
      resolve(undefined);
    };
    const onFail = () => {
      done();
      reject(
        new StaysFixedError('Stays Fixed could not open a debug connection to the app.', {
          hint: 'The app may have closed the port again. Check nothing else is using it.',
        }),
      );
    };
    function done() {
      clearTimeout(timer);
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onFail);
      ws.removeEventListener('close', onFail);
    }
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onFail);
    ws.addEventListener('close', onFail);
  });

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {string} [sessionId]
   * @returns {Promise<any>}
   */
  function send(method, params, sessionId) {
    if (shut || ws.readyState !== 1) {
      return Promise.reject(
        new StaysFixedError(
          `Stays Fixed tried to ask the app for "${method}", but the debug connection is closed.`,
        ),
      );
    }
    const id = ++nextId;
    /** @type {Record<string, unknown>} */
    const message = { id, method, params: params ?? {} };
    // Flat sessions: one socket, many pages, told apart only by this field.
    if (sessionId) message.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new StaysFixedError(`The app did not answer "${method}" within ${seconds(callTimeoutMs)}.`, {
            hint: 'The page may be stuck on a dialog or a request that never finishes.',
          }),
        );
      }, callTimeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      try {
        ws.send(JSON.stringify(message));
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new StaysFixedError(`Stays Fixed could not send "${method}" to the app.`, { cause: e }));
      }
    });
  }

  /**
   * @param {string} event
   * @param {(params: any, sessionId?: string) => void} handler
   * @returns {() => void}
   */
  function on(event, handler) {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler);
    return () => {
      const current = listeners.get(event);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) listeners.delete(event);
    };
  }

  /** @returns {Promise<void>} */
  function close() {
    if (shut || ws.readyState === 3) {
      shut = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        ws.removeEventListener('close', finish);
        shut = true;
        resolve();
      };
      // Never hang a run on a socket that refuses to say goodbye.
      const timer = setTimeout(finish, 2000);
      ws.addEventListener('close', finish);
      try {
        ws.close();
      } catch {
        finish();
      }
    });
  }

  function isOpen() {
    return !shut && ws.readyState === 1;
  }

  return { send, on, close, isOpen };
}
