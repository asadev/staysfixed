/**
 * Desktop apps built with Electron — the window AND the machinery behind it.
 *
 * A desktop app is two programs pretending to be one. There is a window, which is a web page
 * and can be read the same way any web page is read. And there is a MAIN PROCESS, which is
 * where nearly everything the app actually DOES happens: opening windows, writing files,
 * starting other programs, talking to the network, and answering the several hundred private
 * doors the window knocks on. Check only the window and you are checking the paint.
 *
 * WHAT THIS ADAPTER WATCHES, per journey:
 *
 *   the meaning tree     Every control the window offers, by what it IS and what it SAYS —
 *                        role, name, state. Never the markup: markup changes when nothing did.
 *   the doors            Every IPC channel the running app has actually registered. Terminal
 *                        Deck 0.15.0 registers 421 of them plus 26 listeners, and this reads
 *                        the list in a few milliseconds. A door that quietly stopped being
 *                        registered is invisible to every screenshot tool ever written.
 *   its windows          What windows exist, what they are called, how big they are.
 *   its menus            The whole application menu, with what is enabled and what is not.
 *   what it wrote        Every file it created or changed in its own settings folder.
 *   what it started      Every other program it ran.
 *   what it reached for  Every outbound connection it tried — and every one of them refused.
 *   what it complained about   Console errors from both halves, crashes, and how it exited.
 *   what it looked like  One picture, last, as evidence for a finding another channel made.
 *
 * HOW THE DOORS ARE READ, AND WHY IT IS NOT BY KNOCKING. The list of registered channels is
 * ASKED FOR, never tried. Invoking an unknown channel could do anything — send a message,
 * delete a project, spend money — and "it answered" is not worth finding out that way.
 * Registration is observable for free; behaviour is observable only for the channels a
 * journey deliberately names, and those are listed in the project's own config.
 *
 * THE SAFETY BOUNDARY. Before a single line of the app's own code runs, this adapter pauses
 * the main process at its very first statement and puts a boundary in place: every outbound
 * socket, every `fetch`, and every request through Electron's own network stack is recorded,
 * and anything reaching off this machine is refused. So an app that would charge a card is
 * watched asking, and never gets to ask. What could not be covered says so with
 * `covered: false` — a hole with a reason on it, never a pass.
 *
 * ONE COPY AT A TIME, PROVED. Two instances of one desktop app fight over the single-instance
 * lock, the settings folder, the debugging port and whatever identity the app registers
 * somewhere. That fight is not theoretical: it cost a day on this very machine on 2026-08-28,
 * and it looked exactly like a bug in the product. Every run here gets its own of all of
 * those, from `isolate.js`, and the previous run is PROVED gone before the next one starts.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { connect } from '../../drive/cdp.js';
import { resolveElectronBinary } from '../../drive/find.js';
import { splitPath } from '../observation.js';
import {
  countBucket, defineAdapter, howLongItTook, joinPath, notCovered, observation, sizeBucket,
  timeBucket, trimForStorage, undoOurFootprint,
} from './contract.js';
import { boundedCount, boundedMs, compareTrees, snapshotTree, withLimit } from './process.js';
import {
  describeIsolation, releaseEverything, releaseIsolation, reserveIsolation, startIsolated,
  verifyAlone,
} from './isolate.js';

/** @typedef {import('./contract.js').Observation} Observation */
/** @typedef {import('./contract.js').Journey} Journey */
/** @typedef {import('./contract.js').RunContext} RunContext */

/** @param {number} ms */
const rest = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Finding the app
// ---------------------------------------------------------------------------

/** Where a packaged Electron app usually ends up, in the order worth looking. */
const BUILT_APP_FOLDERS = ['dist', 'out', 'release', 'build', 'packages/desktop/dist'];

/**
 * Find the built app inside a build.
 *
 * The config wins when it says something, because a repo that produces five artifacts can
 * only be told apart by somebody who knows which one is meant. Otherwise the usual output
 * folders are looked in — and if nothing is there, that is not an error, it is a `Missing`
 * with the command that would produce one.
 *
 * @param {string} root
 * @param {Record<string, any>} [config]
 * @returns {Promise<{binary: string|null, bundle: string|null, why: string}>}
 */
export async function findAppBinary(root, config = {}) {
  /** @type {string[]} */
  const tried = [];

  /** @param {string} candidate */
  const accept = async (candidate) => {
    const full = path.isAbsolute(candidate) ? candidate : path.join(root, candidate);
    tried.push(full);
    try {
      await fsp.stat(full);
      const binary = resolveElectronBinary(full);
      return { binary, bundle: full.endsWith('.app') ? full : null };
    } catch {
      return null;
    }
  };

  if (config.binary || config.app) {
    const hit = await accept(String(config.binary ?? config.app));
    if (hit) return { ...hit, why: `The config says the app is at ${hit.binary}.` };
    return {
      binary: null,
      bundle: null,
      why: `The config points at "${config.binary ?? config.app}", and there is nothing there.`,
    };
  }

  for (const folder of BUILT_APP_FOLDERS) {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try { entries = await fsp.readdir(path.join(root, folder), { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const looksRight = entry.name.endsWith('.app')
        || (process.platform !== 'darwin' && /\.(exe|AppImage)$/.test(entry.name));
      if (!looksRight) continue;
      const hit = await accept(path.join(folder, entry.name));
      if (hit) return { ...hit, why: `Found the built app at ${path.join(folder, entry.name)}.` };
    }
  }

  return {
    binary: null,
    bundle: null,
    why: tried.length > 0
      ? `No built app was found. Looked in: ${tried.join(', ')}.`
      : `No built app was found under ${BUILT_APP_FOLDERS.join(', ')}.`,
  };
}

// ---------------------------------------------------------------------------
// The probe that rides inside the main process
// ---------------------------------------------------------------------------

/**
 * The script that goes into the main process before the app's own code runs.
 *
 * It is installed while the process is paused at its very first statement, which is the only
 * moment at which it can honestly claim to have seen everything: a boundary that arrives
 * after the app has already booted has already missed whatever the app did on the way up.
 *
 * It patches four things, and knowing WHY it is four rather than one is the difference
 * between a boundary and a suggestion:
 *
 *   `net.Socket.prototype.connect`  Every HTTP client, database driver and SDK anybody has
 *                                   ever written in Node ends up here, however it was
 *                                   imported. This is where a relay dial, a websocket and an
 *                                   ordinary https request are all seen.
 *   `fetch`                         Electron's main process has its own `fetch`, which goes
 *                                   through Chromium's network stack and never touches a Node
 *                                   socket. Missing it would leave a wide open door.
 *   `net.request` (Electron's)      Same stack, older spelling. Auto-updaters use it.
 *   `child_process`                 Recorded, never refused. An app that starts a shell is
 *                                   doing its job; an app that started a DIFFERENT one after
 *                                   a change is the finding.
 *
 * Anything reaching off this machine is refused. Anything on this machine is allowed through
 * untouched, because a desktop app talking to its own helper is not an effect on the world.
 *
 * @returns {string} JavaScript, ready to be evaluated inside the paused main process
 */
export function mainProbeScript() {
  return `(() => {
  const g = globalThis;
  if (g.__staysFixed) return 'already watching';
  const seen = { connects: [], spawns: [], refused: [], watching: [], couldNotWatch: [] };
  g.__staysFixed = seen;
  const req = typeof require === 'function' ? require : (process.mainModule && process.mainModule.require);
  if (typeof req !== 'function') { seen.couldNotWatch.push('nothing at all — this app would not let us load a module'); return 'not watching'; }

  const onThisMachine = (host) => {
    const h = String(host || '').toLowerCase();
    if (h === '' || h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
    if (h.startsWith('127.')) return true;
    if (h.startsWith('/') || h.startsWith('\\\\\\\\.')) return true;   // a socket file, not a network
    return false;
  };
  const note = (host, port, kind) => { seen.connects.push({ host: String(host), port: port == null ? null : Number(port), kind }); };

  try {
    const net = req('node:net');
    const real = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
      const first = args[0];
      const host = (first && typeof first === 'object') ? (first.host || first.path || '') : (typeof args[1] === 'string' ? args[1] : '');
      const port = (first && typeof first === 'object') ? first.port : (typeof first === 'number' ? first : null);
      note(host || '127.0.0.1', port, 'socket');
      if (!onThisMachine(host)) {
        seen.refused.push(String(host));
        const socket = this;
        process.nextTick(() => { try { socket.destroy(Object.assign(new Error('refused by Stays Fixed: this would leave the machine'), { code: 'ECONNREFUSED' })); } catch (e) { void e; } });
        return this;
      }
      return real.apply(this, args);
    };
    seen.watching.push('every outbound socket');
  } catch (e) { seen.couldNotWatch.push('outbound sockets (' + e.message + ')'); }

  try {
    const cp = req('node:child_process');
    const promisified = Symbol.for('nodejs.util.promisify.custom');
    for (const name of ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync']) {
      const real = cp[name];
      if (typeof real !== 'function') continue;
      const watched = function (...args) { seen.spawns.push(String(args[0])); return real.apply(this, args); };
      // Everything hanging off the original function comes with it. This line is not
      // housekeeping — leaving it out breaks the app being checked. "execFile" carries a
      // hidden promise version on a symbol, and "util.promisify(execFile)" uses it to
      // resolve { stdout, stderr }; a bare wrapper loses the symbol, promisify falls back to
      // callback rules and resolves with stdout ALONE, and every caller that wrote
      // "const { stdout } = await ..." gets undefined and throws. Measured on Terminal Deck
      // 0.15.0: the window went blank with one React error and nothing said why.
      for (const key of Reflect.ownKeys(real)) {
        if (key === 'length' || key === 'name' || key === 'prototype') continue;
        try { watched[key] = real[key]; } catch (e) { void e; }
      }
      const custom = real[promisified];
      if (typeof custom === 'function') {
        watched[promisified] = function (...args) { seen.spawns.push(String(args[0])); return custom.apply(this, args); };
      }
      cp[name] = watched;
    }
    seen.watching.push('every program it starts');
  } catch (e) { seen.couldNotWatch.push('the programs it starts (' + e.message + ')'); }

  try {
    const real = g.fetch;
    if (typeof real === 'function') {
      g.fetch = function (input, ...rest) {
        const url = String(input && typeof input === 'object' ? input.url : input);
        note(url, null, 'fetch');
        try { if (!onThisMachine(new URL(url).hostname)) { seen.refused.push(url); return Promise.reject(new TypeError('refused by Stays Fixed: this would leave the machine')); } } catch (e) { void e; }
        return real.call(this, input, ...rest);
      };
      seen.watching.push('fetch in the main process');
    }
  } catch (e) { seen.couldNotWatch.push('fetch in the main process (' + e.message + ')'); }

  try {
    const electron = req('electron');
    const real = electron.net.request;
    electron.net.request = function (options, ...rest) {
      let url = typeof options === 'string' ? options : String((options && options.url) || '');
      if (!url && options && typeof options === 'object') {
        url = String(options.protocol || 'https:') + '//' + String(options.hostname || options.host || '') + String(options.path || '');
      }
      note(url, null, 'electron net');
      return real.call(this, options, ...rest);
    };
    if (electron.net.request !== real) seen.watching.push("requests through Electron's own network");
    else seen.couldNotWatch.push("requests through Electron's own network (it would not let us)");
  } catch (e) { seen.couldNotWatch.push("requests through Electron's own network (" + e.message + ')'); }

  return seen.watching.join(', ');
})()`;
}

/**
 * The expression that reads everything out of the main process, once it is up.
 *
 * Every part of it is wrapped on its own. An app with no application menu, or one that has
 * not opened a window yet, must produce a shorter answer — never an exception that loses the
 * other twelve things this asks for.
 *
 * The IPC list is the reason this file exists. Electron keeps the answering handlers in a
 * Map on `ipcMain` and the listeners on the emitter, so both lists can be READ. Nothing is
 * called. Nothing is knocked on.
 *
 * @returns {string}
 */
export function mainReadScript() {
  return `(() => {
  const out = { problems: [] };
  const safe = (name, fn) => { try { out[name] = fn(); } catch (e) { out.problems.push(name + ': ' + e.message); } };
  const req = typeof require === 'function' ? require : (process.mainModule && process.mainModule.require);
  const electron = req('electron');

  safe('app', () => ({
    name: electron.app.getName(),
    version: electron.app.getVersion(),
    packaged: electron.app.isPackaged === true,
    userData: electron.app.getPath('userData'),
    locale: electron.app.getLocale(),
  }));

  safe('ipc', () => {
    const answers = electron.ipcMain._invokeHandlers ? [...electron.ipcMain._invokeHandlers.keys()].map(String) : null;
    const listens = electron.ipcMain.eventNames().map(String);
    return { answers, listens };
  });

  safe('windows', () => electron.BrowserWindow.getAllWindows().map((w) => {
    const size = w.getSize();
    return {
      title: w.getTitle(),
      visible: w.isVisible(),
      width: size[0],
      height: size[1],
      resizable: w.isResizable(),
      fullScreen: w.isFullScreen(),
      alwaysOnTop: w.isAlwaysOnTop(),
      url: w.webContents ? w.webContents.getURL() : '',
    };
  }));

  safe('menu', () => {
    const walk = (items, prefix) => {
      const rows = [];
      for (const item of items || []) {
        const label = String(item.label || item.role || item.type || '');
        const here = prefix ? prefix + ' > ' + label : label;
        if (item.type !== 'separator') {
          rows.push({ at: here, enabled: item.enabled !== false, visible: item.visible !== false, key: String(item.accelerator || ''), kind: String(item.type || 'normal') });
        }
        if (item.submenu && item.submenu.items) rows.push(...walk(item.submenu.items, here));
      }
      return rows;
    };
    const menu = electron.Menu.getApplicationMenu();
    return menu ? walk(menu.items, '') : [];
  });

  safe('helpers', () => electron.app.getAppMetrics().map((m) => String(m.type || '') + (m.name ? ' (' + m.name + ')' : '')).sort());

  safe('effects', () => {
    const seen = globalThis.__staysFixed;
    if (!seen) return null;
    const tally = (list, key) => {
      const counts = new Map();
      for (const item of list) { const k = key(item); counts.set(k, (counts.get(k) || 0) + 1); }
      return [...counts.entries()].sort().map(([what, times]) => ({ what, times }));
    };
    return {
      connects: tally(seen.connects, (c) => c.port ? c.host + ':' + c.port : c.host),
      spawns: tally(seen.spawns, (s) => s),
      refused: [...new Set(seen.refused)].sort(),
      watching: seen.watching,
      couldNotWatch: seen.couldNotWatch,
    };
  });

  return out;
})()`;
}

// ---------------------------------------------------------------------------
// Talking to a running app
// ---------------------------------------------------------------------------

/**
 * @param {string} url
 * @returns {Promise<any>}
 */
async function askFor(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`answered ${response.status}`);
  return response.json();
}

/**
 * Wait for the main process to open its own debugging connection.
 *
 * Deliberately not the same call as the one used for the window. The window's port answers
 * `/json/version` with a socket to connect to; the main process's port does not, and only
 * `/json/list` has anything useful in it. Getting that wrong looks exactly like an app that
 * never started.
 *
 * @param {number} port
 * @param {object} opts
 * @param {number} opts.timeoutMs
 * @param {() => string|null} opts.died   A sentence when the app has already quit, else null.
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{webSocketDebuggerUrl: string, title: string}>}
 */
async function waitForMainProcess(port, opts) {
  // `boundedMs` and not the number as given, because this limit comes from a project's own
  // settings file. A limit of NaN — which is what `startTimeoutMs: "60s"` becomes — makes
  // `Date.now() > until` false for ever, and this loop would then poll a dead port until
  // somebody killed the tool, with no output and no explanation.
  const until = Date.now() + boundedMs(opts.timeoutMs, 60_000);
  for (;;) {
    if (opts.signal?.aborted) throw new Error('The run was stopped while waiting for the app to open its main-process debugging connection.');
    const gone = opts.died();
    if (gone) throw new Error(gone);
    try {
      const list = await askFor(`http://127.0.0.1:${port}/json/list`);
      const target = Array.isArray(list) ? list.find((t) => t && typeof t.webSocketDebuggerUrl === 'string') : null;
      if (target) return target;
    } catch { /* not up yet */ }
    if (Date.now() > until) break;
    await rest(150);
  }
  throw new Error(`The app never opened its main-process debugging connection on port ${port}.`);
}

/**
 * Wait for a real window to exist, and pick the one meant.
 *
 * An Electron window is blank for the first moment of its life, so asking again a beat later
 * is the difference between reading the app and reading an empty rectangle.
 *
 * @param {number} port
 * @param {string|undefined} match
 * @param {object} opts
 * @param {number} opts.timeoutMs
 * @param {() => string|null} opts.died
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{id: string, title: string, url: string}>}
 */
async function waitForWindow(port, match, opts) {
  // Guarded for the same reason as the wait above it: a limit that is not a number turns this
  // endless-looking loop into a genuinely endless one.
  const until = Date.now() + boundedMs(opts.timeoutMs, 60_000);
  /** @type {any[]} */
  let pages = [];
  for (;;) {
    if (opts.signal?.aborted) throw new Error('The run was stopped while waiting for the app to open a window.');
    const gone = opts.died();
    if (gone) throw new Error(gone);
    try {
      const list = await askFor(`http://127.0.0.1:${port}/json/list`);
      pages = (Array.isArray(list) ? list : []).filter((t) => t && t.type === 'page' && !String(t.url ?? '').startsWith('devtools://'));
      const chosen = match
        ? pages.find((t) => String(t.title ?? '').includes(match) || String(t.url ?? '').includes(match))
        : pages.find((t) => String(t.url ?? '') !== '' && String(t.url ?? '') !== 'about:blank');
      if (chosen) return { id: String(chosen.id), title: String(chosen.title ?? ''), url: String(chosen.url ?? '') };
    } catch { /* not up yet */ }
    if (Date.now() > until) break;
    await rest(200);
  }
  if (!match && pages.length > 0) return { id: String(pages[0].id), title: String(pages[0].title ?? ''), url: String(pages[0].url ?? '') };
  throw new Error(
    match
      ? `The app opened, but no window matches "${match}". Windows it has open: ${pages.map((p) => `"${p.title}"`).join(', ') || 'none'}.`
      : 'The app started but never opened a window to look at.',
  );
}

/**
 * One app, open and readable.
 *
 * @typedef {object} OpenApp
 * @property {import('./isolate.js').Isolation} isolation
 * @property {import('./isolate.js').StartedApp} started
 * @property {import('../../types.js').CdpSession} main       The main process.
 * @property {import('../../types.js').CdpSession} browser    The window's connection.
 * @property {string} sessionId                               Which window, on that connection.
 * @property {{id: string, title: string, url: string}} window
 * @property {string} watching        Plain English: what the boundary is covering.
 * @property {string[]} couldNotWatch
 * @property {string[]} complaints    Console errors and crashes, both halves, as they arrive.
 * @property {{url: string, refused: boolean}[]} requests      What the window asked the network for.
 * @property {number} openedInMs
 */

/**
 * Open one app, alone, with the boundary in place before its own code runs.
 *
 * @param {object} opts
 * @param {string} opts.binary
 * @param {import('./isolate.js').Isolation} opts.isolation
 * @param {string} [opts.windowMatch]
 * @param {string[]} [opts.extraArgs]
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 * @param {(message: string) => void} [opts.log]
 * @returns {Promise<OpenApp>}
 */
export async function openApp(opts) {
  // The whole open, on ONE clock, on top of the clock each individual step already has.
  //
  // Every step below is bounded on its own, and that was still not enough: a run that gives up
  // on eight things in a row for sixty seconds each has waited eight minutes, and the recorded
  // symptom this file is being fixed for — an Electron check on 2026-08-30 that produced no
  // output at all and never came back — is indistinguishable from a very long wait. So there
  // is an outer limit as well, and because a bare "it timed out" sends somebody looking in
  // every wrong place first, it names the step it was actually stuck in.
  const timeoutMs = boundedMs(opts.timeoutMs, 60_000);
  const stage = { at: 'the app to be started' };
  return withLimit(openTheApp(opts, timeoutMs, stage), {
    limitMs: timeoutMs * 3,
    what: () => `${stage.at}. Nothing about this build was checked.`,
  });
}

/**
 * The steps of opening one app. Wrapped by `openApp`, which owns the outer limit.
 *
 * @param {Parameters<typeof openApp>[0]} opts
 * @param {number} timeoutMs
 * @param {{at: string}} stage   Updated as it goes, so a give-up can name where it stopped.
 * @returns {Promise<OpenApp>}
 */
async function openTheApp(opts, timeoutMs, stage) {
  const isolation = opts.isolation;
  const startedAt = Date.now();

  stage.at = 'the previous copy of this app to be proved gone';
  const alone = await verifyAlone(isolation);
  if (!alone.alone) throw new Error(`${alone.why} Nothing was started, because two copies of one app fight over the same lock and the same settings.`);

  const started = startIsolated(isolation, { binary: opts.binary, extraArgs: opts.extraArgs, signal: opts.signal });
  const died = () => {
    const end = started.finished();
    if (!end) return null;
    return `The app quit before it was ready (${end.signal ? `it was stopped by ${end.signal}` : `exit code ${end.code}`}). The last thing it said: ${trimForStorage(started.said(), 1200).text || '(nothing)'}`;
  };

  // ---- the main process, paused at its first statement
  stage.at = `the app to open its main-process debugging connection on port ${isolation.inspectPort}`;
  const mainTarget = await waitForMainProcess(isolation.inspectPort, { timeoutMs, died, signal: opts.signal });
  stage.at = 'the app to finish accepting a debugging connection to its main process';
  const main = await connect(mainTarget.webSocketDebuggerUrl, { timeoutMs: 20_000 });
  isolation.closeFirst(() => main.close());

  /** @type {string[]} */
  const complaints = [];
  const complain = (/** @type {string} */ text) => {
    const line = text.trim();
    if (line && complaints.length < 50 && !complaints.includes(line)) complaints.push(line);
  };
  main.on('Runtime.exceptionThrown', (params) => {
    complain(`the app itself threw: ${String(params?.exceptionDetails?.exception?.description ?? params?.exceptionDetails?.text ?? 'an error with no message')}`.split('\n')[0]);
  });
  main.on('Runtime.consoleAPICalled', (params) => {
    if (params?.type !== 'error' && params?.type !== 'assert') return;
    const text = (params.args ?? []).map((/** @type {any} */ a) => String(a?.value ?? a?.description ?? '')).join(' ');
    complain(`the app printed an error: ${text}`.split('\n')[0]);
  });

  stage.at = 'the app to answer the first question about its main process';
  await main.send('Runtime.enable');
  await main.send('Debugger.enable');

  /** @type {string|null} */
  let frameId = null;
  const stopListening = main.on('Debugger.paused', (params) => {
    if (frameId === null) frameId = String(params?.callFrames?.[0]?.callFrameId ?? '') || null;
  });
  stage.at = 'the app to stop at its first line so the safety boundary can be put in place';
  await main.send('Runtime.runIfWaitingForDebugger');
  // Five seconds, and it gives up rather than waits: an app that never stops at its first line
  // is still worth checking, just with a hole in the report where the boundary would have been.
  for (let i = 0; i < 100 && frameId === null; i += 1) await rest(50);

  let watching = '';
  /** @type {string[]} */
  let couldNotWatch = [];
  if (frameId) {
    stage.at = 'the safety boundary to be put in place inside the app';
    const result = await main.send('Debugger.evaluateOnCallFrame', {
      callFrameId: frameId,
      expression: mainProbeScript(),
      returnByValue: true,
      includeCommandLineAPI: true,
    });
    watching = String(result?.result?.value ?? '');
    if (result?.exceptionDetails) couldNotWatch.push(`the boundary could not be put in place: ${String(result.exceptionDetails.text ?? 'it threw')}`);
    await main.send('Debugger.resume').catch(() => {});
  } else {
    couldNotWatch.push('the main process never stopped at its first line, so nothing was watching it from the inside');
  }
  stopListening();
  await main.send('Debugger.disable').catch(() => {});
  opts.log?.(watching ? `Watching ${watching}.` : 'Nothing is watching the main process from the inside.');

  // ---- the window
  stage.at = opts.windowMatch
    ? `the app to open a window matching "${opts.windowMatch}"`
    : 'the app to open a window to look at';
  const window = await waitForWindow(isolation.debugPort, opts.windowMatch, { timeoutMs, died, signal: opts.signal });
  stage.at = 'the app to say which window connection to use';
  const version = await askFor(`http://127.0.0.1:${isolation.debugPort}/json/version`);
  stage.at = 'the app to accept a debugging connection to its window';
  const browser = await connect(String(version.webSocketDebuggerUrl), { timeoutMs: 20_000 });
  isolation.closeFirst(() => browser.close());
  const attached = await browser.send('Target.attachToTarget', { targetId: window.id, flatten: true });
  const sessionId = String(attached.sessionId);

  for (const domain of ['Runtime', 'Page', 'Log', 'DOM', 'Accessibility']) {
    await browser.send(`${domain}.enable`, {}, sessionId).catch(() => {
      couldNotWatch.push(`${domain.toLowerCase()} in the window`);
    });
  }

  browser.on('Runtime.consoleAPICalled', (params, sid) => {
    if (sid !== sessionId) return;
    if (params?.type !== 'error' && params?.type !== 'assert') return;
    const text = (params.args ?? []).map((/** @type {any} */ a) => String(a?.value ?? a?.description ?? '')).join(' ');
    complain(`the window printed an error: ${text}`.split('\n')[0]);
  });
  browser.on('Log.entryAdded', (params, sid) => {
    if (sid !== sessionId || params?.entry?.level !== 'error') return;
    complain(`the window logged an error: ${String(params.entry.text ?? '')}`.split('\n')[0]);
  });
  browser.on('Runtime.exceptionThrown', (params, sid) => {
    if (sid !== sessionId) return;
    complain(`the window threw: ${String(params?.exceptionDetails?.exception?.description ?? params?.exceptionDetails?.text ?? '')}`.split('\n')[0]);
  });
  browser.on('Inspector.targetCrashed', (_params, sid) => {
    if (sid === sessionId) complain('the window crashed');
  });

  // ---- the boundary in front of the window's own requests
  /** @type {{url: string, refused: boolean}[]} */
  const requests = [];
  browser.on('Fetch.requestPaused', (params, sid) => {
    if (sid !== sessionId) return;
    const url = String(params?.request?.url ?? '');
    const off = leavesTheMachine(url);
    requests.push({ url, refused: off });
    // Every paused request MUST be answered, whatever happens, or the app hangs on it.
    const answer = off
      ? browser.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sessionId)
      : browser.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId);
    answer.catch(() => {
      browser.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId).catch(() => {});
    });
  });
  stage.at = "the window to accept the boundary in front of its own network requests";
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId).catch(() => {
    couldNotWatch.push("the window's own network requests");
  });

  return {
    isolation,
    started,
    main,
    browser,
    sessionId,
    window,
    watching,
    couldNotWatch,
    complaints,
    requests,
    openedInMs: Date.now() - startedAt,
  };
}

/**
 * A name a picture can be saved under, cut with a fingerprint of the whole on the end so two
 * long names can never land on one file.
 *
 * @param {string} name
 * @returns {string}
 */
function pictureName(name) {
  const clean = String(name).replace(/[^a-zA-Z0-9._-]+/g, '-');
  if (clean === '') return 'a-walk';
  if (clean.length <= 60) return clean;
  return `${clean.slice(0, 51)}-${crypto.createHash('sha256').update(clean).digest('hex').slice(0, 8)}`;
}

/**
 * Would this request leave the machine?
 *
 * The app's own files, its own data URLs and anything on this computer are its business.
 * Everything else is the world, and the world is where the irreversible things live.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function leavesTheMachine(url) {
  try {
    const parsed = new URL(url);
    if (['file:', 'data:', 'blob:', 'devtools:', 'chrome:', 'chrome-extension:', 'about:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    return !(host === '' || host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.startsWith('127.'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The meaning tree
// ---------------------------------------------------------------------------

/**
 * Cut one part of an address down to something a path can hold.
 *
 * A command line, a file path or a menu trail can run to hundreds of characters, and an
 * address has a limit. Cutting alone would merge two different things into one address — two
 * different long commands becoming the same fact — so what is cut off leaves a short
 * fingerprint behind. Long and different stays different; long and identical stays identical.
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function asAddress(text, limit = 110) {
  const clean = String(text).replace(/[\r\n\t]+/g, ' ').trim();
  if (clean.length <= limit) return clean || '(nothing)';
  const mark = crypto.createHash('sha256').update(clean).digest('hex').slice(0, 8);
  return `${clean.slice(0, limit - 12)}… (${mark})`;
}

/**
 * How much of one control's own text is kept at its address.
 *
 * It protects the store and the diff: a text area holding a whole document would otherwise put
 * that document into every capture and into every sentence written about it. Two hundred bytes
 * is enough to recognise a field by. What breaks if it is wrong is nothing silent — the two
 * ends and the exact byte count are kept either way, so getting this number wrong makes the
 * record bigger or smaller, never quieter.
 */
const CONTROL_TEXT_BYTES = 200;

/**
 * The states worth writing down.
 *
 * Short, and it is short on purpose. These are the things a person can SEE about a control:
 * whether they can use it, whether it is on, whether it is open. `focused` is deliberately
 * absent — which control has the keyboard is different on every run and would report a
 * difference every single time.
 */
const STATES_THAT_MATTER = ['disabled', 'checked', 'pressed', 'expanded', 'selected', 'required', 'invalid', 'readonly', 'level', 'modal', 'multiselectable'];

/**
 * Roles that carry no meaning on their own and would triple the size of every reading.
 * A `generic` div is not a control; it is the box the control came in.
 */
const ROLES_WORTH_NOTHING = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'Iframe', 'RootWebArea']);

/**
 * Turn the window's accessibility tree into one plain reading: what is on screen, by what it
 * IS and what it SAYS.
 *
 * This is the meaning channel, and the reason it is the meaning channel rather than the
 * markup: a class name change, a wrapper div, a whole styling rewrite all leave this
 * identical, while a button that lost its label, went missing or went grey all show up as
 * exactly one difference each.
 *
 * NOTHING HERE IS CUT WITHOUT SAYING SO. A control's own text used to be kept as its first
 * two hundred characters and nothing else — no length, no fingerprint — so two builds whose
 * text differed only past character two hundred recorded the same string and compared equal.
 * A total, a message or an error at the end of a long field could change completely and the
 * run would report that nothing had changed. `trimForStorage` had already solved this exactly
 * once, for the output of a command: keep both ends and the EXACT number of bytes discarded,
 * because a length survives normalisation while a digest of the whole text would not. It was
 * never applied here. It is now, and what is still not covered — a change in the middle that
 * leaves the length identical — is counted on `trimmed` and reported as a hole by the caller.
 *
 * The NAME is no longer cut here at all. It is part of an address, and cutting an address
 * merges two things into one: two paragraphs sharing their first hundred and twenty
 * characters became one address, so an edit further along either of them was invisible.
 * `asAddress` already cuts addresses properly, leaving a fingerprint of the whole behind, and
 * the caller passes every address through it.
 *
 * @param {any[]} nodes    Straight from Accessibility.getFullAXTree.
 * @param {(text: string) => string} [tidy]   Rubs our own footprint out of the names.
 * @returns {{address: string, role: string, name: string, state: Record<string, string|number|boolean>, trimmed: boolean}[]}
 */
export function readMeaning(nodes, tidy = (t) => t) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {{address: string, role: string, name: string, state: Record<string, string|number|boolean>, trimmed: boolean}[]} */
  const rows = [];

  for (const node of nodes ?? []) {
    if (!node || node.ignored) continue;
    const role = String(node.role?.value ?? '');
    if (!role || ROLES_WORTH_NOTHING.has(role)) continue;
    const name = tidy(String(node.name?.value ?? '')).trim().replace(/\s+/g, ' ');

    /** @type {Record<string, string|number|boolean>} */
    const state = {};
    for (const property of node.properties ?? []) {
      const key = String(property?.name ?? '');
      if (!STATES_THAT_MATTER.includes(key)) continue;
      const value = property?.value?.value;
      if (value === undefined || value === false || value === 'false') continue;
      state[key] = typeof value === 'object' ? String(value) : value;
    }
    let trimmed = false;
    const own = node.value?.value;
    if (own !== undefined && own !== null && String(own) !== '') {
      const kept = trimForStorage(tidy(String(own)), CONTROL_TEXT_BYTES);
      state.value = kept.text;
      trimmed = trimmed || kept.truncated;
    }
    if (node.description?.value) {
      const kept = trimForStorage(tidy(String(node.description.value)), CONTROL_TEXT_BYTES);
      state.described = kept.text;
      trimmed = trimmed || kept.truncated;
    }

    // A control with no name is only worth an address when it says something else about
    // itself; an anonymous, stateless box is noise in every reading it appears in.
    if (name === '' && Object.keys(state).length === 0) continue;

    const base = `${role}: ${name || '(no name)'}`;
    const times = (seen.get(base) ?? 0) + 1;
    seen.set(base, times);
    rows.push({
      address: times === 1 ? base : `${base} #${times}`,
      role,
      name,
      state,
      trimmed,
    });
  }
  return rows;
}

/**
 * Read the window until it stops changing.
 *
 * Generalised from the picture check that reads until two frames agree: it works on any
 * observation, and it is what stops an animation, a spinner or a list still loading from
 * being reported as a difference. Whether it settled is itself written down, because a
 * window that never stops moving is worth knowing about.
 *
 * @param {() => Promise<any[]>} read
 * @param {{tries?: number, gapMs?: number}} [opts]
 * @returns {Promise<{nodes: any[], settled: boolean, reads: number}>}
 */
export async function settleTree(read, opts = {}) {
  // Both of these are settable from a project's own settings file, so both are guarded. A
  // gap of NaN is a `setTimeout` of one millisecond, which turns "read until it stops moving"
  // into a spin; a count that is not a number stops the loop running at all and silently
  // reports an empty screen. Neither says anything out loud, which is why they are pinned.
  const tries = boundedCount(opts.tries, 8, 200);
  const gapMs = boundedMs(opts.gapMs, 350, 60_000);
  let previous = '';
  /** @type {any[]} */
  let nodes = [];
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    nodes = await read();
    const now = JSON.stringify(readMeaning(nodes));
    if (attempt > 1 && now === previous) return { nodes, settled: true, reads: attempt };
    previous = now;
    await rest(gapMs);
  }
  return { nodes, settled: false, reads: tries };
}

// ---------------------------------------------------------------------------
// Driving it
// ---------------------------------------------------------------------------

/** The handful of keys a journey ever names, with what CDP needs to send them. */
const KEYS = /** @type {Record<string, {key: string, code: string, keyCode: number}>} */ ({
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
});

/**
 * Do one step of a journey, and say in plain English what happened.
 *
 * Controls are found by what they SAY, never by a selector. A journey written against
 * `#sidebar > div:nth-child(3)` breaks when somebody adds a div and reports it as a
 * regression; a journey written against "New session" breaks only when the button called
 * "New session" is gone, which is a real finding.
 *
 * @param {OpenApp} app
 * @param {Record<string, any>} step
 * @returns {Promise<{did: string, ok: boolean}>}
 */
export async function takeStep(app, step) {
  const act = String(step.act ?? '');
  const say = (/** @type {string} */ did, /** @type {boolean} */ ok = true) => ({ did, ok });

  if (act === 'wait') {
    if (step.control) {
      // `boundedMs` and not `Number(...)`, and this is the one loop in this file that could
      // genuinely run for ever. A journey is written by hand, and `timeoutMs: "10s"` is
      // `Number("10s")`, which is NaN — at which point `Date.now() + NaN` is NaN, `Date.now()
      // > NaN` is false every single time round, and this loop asks the app for its whole
      // accessibility tree five times a second until somebody kills the tool. No output, no
      // reason, and it looks exactly like the app hanging rather than the journey being
      // mistyped. Capped at five minutes as well: a step that waits longer than that for a
      // control to appear is a mistake in the journey, not patience.
      const limitMs = boundedMs(step.timeoutMs, 10_000, 5 * 60_000);
      const until = Date.now() + limitMs;
      for (;;) {
        const tree = await app.browser.send('Accessibility.getFullAXTree', {}, app.sessionId).catch(() => ({ nodes: [] }));
        if (readMeaning(tree.nodes ?? []).some((row) => row.name === String(step.control))) return say(`waited until "${step.control}" appeared`);
        if (Date.now() > until) return say(`waited ${timeBucket(limitMs)} for "${step.control}" to appear, and it never did`, false);
        await rest(200);
      }
    }
    const restMs = boundedMs(step.ms, 500, 5 * 60_000);
    await rest(restMs);
    return say(`waited ${timeBucket(restMs)}`);
  }

  if (act === 'click' || act === 'focus') {
    const tree = await app.browser.send('Accessibility.getFullAXTree', {}, app.sessionId);
    const wanted = String(step.control ?? step.name ?? '');
    const node = (tree.nodes ?? []).find((/** @type {any} */ n) => {
      if (!n || n.ignored || !n.backendDOMNodeId) return false;
      const name = String(n.name?.value ?? '').trim();
      if (name !== wanted) return false;
      return step.role ? String(n.role?.value ?? '') === String(step.role) : true;
    });
    if (!node) return say(`could not find anything called "${wanted}" to ${act}`, false);
    const resolved = await app.browser.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId }, app.sessionId);
    const objectId = resolved?.object?.objectId;
    if (!objectId) return say(`found "${wanted}" but could not reach it`, false);
    await app.browser.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: act === 'click'
        ? 'function () { this.scrollIntoView({ block: "center" }); this.click ? this.click() : this.dispatchEvent(new MouseEvent("click", { bubbles: true })); }'
        : 'function () { this.focus && this.focus(); }',
      awaitPromise: false,
    }, app.sessionId);
    return say(`${act === 'click' ? 'clicked' : 'focused'} "${wanted}"`);
  }

  if (act === 'type') {
    await app.browser.send('Input.insertText', { text: String(step.text ?? '') }, app.sessionId);
    return say(`typed "${String(step.text ?? '').slice(0, 40)}"`);
  }

  if (act === 'press') {
    const key = KEYS[String(step.key ?? '')];
    if (!key) return say(`does not know how to press "${step.key}"`, false);
    for (const type of /** @type {const} */ (['keyDown', 'keyUp'])) {
      await app.browser.send('Input.dispatchKeyEvent', {
        type,
        key: key.key,
        code: key.code,
        windowsVirtualKeyCode: key.keyCode,
        nativeVirtualKeyCode: key.keyCode,
      }, app.sessionId);
    }
    return say(`pressed ${key.key}`);
  }

  if (act === 'evaluate') {
    const result = await app.browser.send('Runtime.evaluate', {
      expression: String(step.js ?? ''),
      awaitPromise: true,
      returnByValue: true,
    }, app.sessionId);
    if (result?.exceptionDetails) return say(`ran the project's own step and it threw: ${String(result.exceptionDetails.text ?? '')}`, false);
    return say('ran the project\'s own step');
  }

  return say(`does not know how to "${act}"`, false);
}

/**
 * Ask ONE named door to answer, on purpose.
 *
 * This is the only place anything is invoked rather than read, and it happens only for a
 * channel the project itself named in its config. The handler is called inside the main
 * process with the real window as its sender, so it behaves exactly as it would for the app
 * — and the boundary in front of the network is still in force while it does.
 *
 * @param {OpenApp} app
 * @param {string} channel
 * @param {any[]} args
 * @returns {Promise<{answered: boolean, value: unknown, why: string}>}
 */
export async function exerciseChannel(app, channel, args) {
  const expression = `(async () => {
    const req = typeof require === 'function' ? require : process.mainModule.require;
    const electron = req('electron');
    const handler = electron.ipcMain._invokeHandlers && electron.ipcMain._invokeHandlers.get(${JSON.stringify(channel)});
    if (!handler) return { answered: false, why: 'nothing is registered on that channel' };
    const win = electron.BrowserWindow.getAllWindows()[0];
    if (!win) return { answered: false, why: 'the app has no window to ask on behalf of' };
    let reply, thrown;
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame, frameId: 0, processId: 0, _reply: (v) => { reply = v; }, _throw: (e) => { thrown = e; } };
    // Electron has stored the handler two different ways across versions: one wraps the
    // project's function and calls _reply, the other stores the function itself and hands
    // the answer straight back. Both are read, so neither version reports "it answered
    // nothing" when it answered perfectly well.
    const returned = await handler(event, ...${JSON.stringify(args)});
    if (reply === undefined && returned !== undefined) reply = returned;
    if (thrown) return { answered: false, why: 'it threw: ' + String(thrown && thrown.message || thrown) };
    return { answered: true, value: reply === undefined ? null : reply, why: 'it answered' };
  })()`;
  // On a clock of its own, and it says which door it was knocking on. This is the only place
  // in this adapter that makes the app RUN something, so it is the only place where the app's
  // own code can decide never to answer — a handler that awaits a promise nobody resolves
  // holds this open, and without a name in the sentence the report would say "the app did not
  // answer" about an app with four hundred doors.
  /** @type {any} */
  let result;
  try {
    result = await withLimit(
      app.main.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      { limitMs: 30_000, what: `the private channel "${channel}" to answer` },
    );
  } catch (e) {
    return { answered: false, value: null, why: e instanceof Error ? e.message : String(e) };
  }
  if (result?.exceptionDetails) {
    return { answered: false, value: null, why: `asking it threw: ${String(result.exceptionDetails.text ?? '')}` };
  }
  const value = result?.result?.value ?? {};
  return { answered: value.answered === true, value: value.value ?? null, why: String(value.why ?? '') };
}

// ---------------------------------------------------------------------------
// Turning one open app into observations
// ---------------------------------------------------------------------------

/**
 * Everything the app is, right now, written down.
 *
 * Split fine on purpose, exactly as the CLI adapter is. One observation holding "here is the
 * whole app" means any change anywhere reports as one enormous difference and an agent has to
 * work out for itself which part moved. One observation per control, per door, per menu item,
 * per file means the difference names itself.
 *
 * @param {object} input
 * @param {OpenApp} input.app
 * @param {Journey} input.journey
 * @param {RunContext} input.ctx
 * @param {any} input.reading            What the main process said about itself.
 * @param {any[]} input.axNodes
 * @param {boolean} input.settled
 * @param {import('./process.js').TreeSnapshot} input.before
 * @param {import('./process.js').TreeSnapshot} input.after
 * @param {string[]} input.declaredChannels   IPC channels the source said exist.
 * @param {string[]} input.did            What the journey's steps actually managed.
 * @param {string} [input.projectRoot]
 * @returns {Observation[]}
 */
export function describeApp(input) {
  const { app, journey, reading, axNodes, settled, declaredChannels, did } = input;
  const id = journey.name;
  const tidy = (/** @type {string} */ text) => undoOurFootprint(text, {
    dirs: [app.isolation.dir],
    ports: [app.isolation.debugPort, app.isolation.inspectPort],
    projectRoot: input.projectRoot,
  });
  /** @type {Observation[]} */
  const out = [];

  // ---- what the window says it offers
  const meaning = readMeaning(axNodes, tidy);
  for (const row of meaning) {
    out.push(observation({
      channel: 'meaning',
      path: joinPath('screen', id, asAddress(row.address)),
      value: Object.keys(row.state).length === 0 ? 'there, and nothing special about it' : row.state,
      says: `The window offers ${row.role === 'StaticText' ? 'the words' : `a ${row.role}`} "${row.name || '(with no name)'}"${
        Object.keys(row.state).length === 0 ? '.' : `, and it is ${Object.entries(row.state).map(([k, v]) => (v === true ? k : `${k}: ${v}`)).join(', ')}.`}`,
      journey: id,
      surface: 'electron',
    }));
  }
  const tooLong = meaning.filter((row) => row.trimmed).length;
  if (tooLong > 0) {
    out.push(notCovered({
      channel: 'meaning',
      path: joinPath('count', id, 'controls holding more text than is kept'),
      reason: 'too big',
      says:
        `${tooLong} control${tooLong === 1 ? '' : 's'} on this screen ${tooLong === 1 ? 'holds' : 'hold'} more text than is kept at one address. ` +
        'Both ends of it are compared and so is the exact number of bytes in between, so a change to either end, or one that makes the text longer or shorter, is still caught. ' +
        'A change buried in the middle that leaves the length exactly the same is not, and that is a hole rather than a pass.',
    }));
  }
  out.push(observation({
    channel: 'counters',
    path: joinPath('count', id, 'things on screen'),
    value: countBucket(meaning.length),
    says: `The window offers ${meaning.length} named things. A big drop here usually means a screen did not finish loading.`,
    journey: id,
  }));
  out.push(observation({
    channel: 'counters',
    path: joinPath('count', id, 'window stopped moving'),
    value: settled,
    says: settled
      ? 'The window was read twice in a row and said the same thing both times, so nothing was still animating when it was read.'
      : 'The window never stopped changing, so what was read is one moment of something still moving. Anything that differs here may be timing rather than a real change.',
    journey: id,
  }));

  // ---- the doors the running app answers on
  const answers = reading?.ipc?.answers;
  const listens = reading?.ipc?.listens;
  if (Array.isArray(answers)) {
    for (const channel of [...answers].sort()) {
      out.push(observation({
        channel: 'contract',
        path: joinPath('ipc', asAddress(String(channel)), 'answering'),
        value: 'registered, and answers when asked',
        says: `The running app answers on the private channel "${channel}". If this stops being registered, everything in the window that used it stops working, and nothing on screen looks any different.`,
        journey: id,
        surface: 'electron',
      }));
    }
  } else {
    out.push(notCovered({
      channel: 'contract',
      path: joinPath('ipc', id, 'readable at all'),
      reason: 'not supported here',
      says: 'This version of Electron does not let the list of answering channels be read, so which private doors the running app opens is not known. The list the source declares is still checked.',
    }));
  }
  if (Array.isArray(listens)) {
    for (const channel of [...listens].sort()) {
      out.push(observation({
        channel: 'contract',
        path: joinPath('ipc', asAddress(String(channel)), 'listening'),
        value: 'registered, and listens',
        says: `The running app listens on the private channel "${channel}" — it takes messages there but does not reply.`,
        journey: id,
        surface: 'electron',
      }));
    }
  }
  const registered = new Set([...(Array.isArray(answers) ? answers : []), ...(Array.isArray(listens) ? listens : [])].map(String));
  out.push(observation({
    channel: 'counters',
    path: joinPath('count', id, 'doors the app answers on'),
    value: registered.size,
    says: `${registered.size} private channels are registered in the running app.`,
    journey: id,
  }));

  // ---- the ledger: what the code declares against what the app actually registered
  if (declaredChannels.length > 0 && registered.size > 0) {
    const missing = declaredChannels.filter((name) => !registered.has(name));
    const exercised = (journey.steps ?? []).filter((s) => String(/** @type {any} */ (s).act) === 'ipc').length;
    out.push(observation({
      channel: 'counters',
      path: joinPath('count', id, 'doors declared but not registered'),
      value: missing.length,
      says: missing.length === 0
        ? 'Every channel the code declares is registered in the running app.'
        : `${missing.length} channels are written in the code but not registered while the app runs — ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', and more' : ''}. That is normal for channels only registered on some screens, and worth a look when it changes.`,
      journey: id,
    }));
    out.push(notCovered({
      channel: 'contract',
      path: joinPath('count', id, 'doors actually opened'),
      reason: 'not supported here',
      says: `${registered.size} doors are registered and ${exercised} of them were actually asked to answer. The rest are known to EXIST and are not known to WORK — opening one blindly could do anything, including something that cannot be undone, so a channel is only tried when the project names it in its config.`,
    }));
  }

  // ---- its windows
  for (const window of reading?.windows ?? []) {
    out.push(observation({
      channel: 'meaning',
      path: joinPath('window', id, asAddress(String(window.title || '(untitled)'))),
      // Position is left out on purpose: where the operating system puts a window differs
      // every time and would report a difference on every run.
      value: {
        visible: window.visible === true,
        size: `${window.width} by ${window.height}`,
        resizable: window.resizable === true,
        fullScreen: window.fullScreen === true,
      },
      says: `The app has a window called "${window.title || '(untitled)'}", ${window.visible ? 'shown' : 'hidden'}, ${window.width} by ${window.height}. Where it sits on screen is not compared, because that differs every run.`,
      journey: id,
      surface: 'electron',
    }));
  }
  out.push(observation({
    channel: 'counters',
    path: joinPath('count', id, 'windows open'),
    value: (reading?.windows ?? []).length,
    says: `The app has ${(reading?.windows ?? []).length} window${(reading?.windows ?? []).length === 1 ? '' : 's'} open.`,
    journey: id,
  }));

  // ---- its menus
  for (const item of reading?.menu ?? []) {
    out.push(observation({
      channel: 'meaning',
      path: joinPath('menu', id, asAddress(String(item.at))),
      value: { enabled: item.enabled === true, visible: item.visible === true, shortcut: String(item.key || 'none') },
      says: `The menu has "${item.at}"${item.key ? ` (${item.key})` : ''}, ${item.enabled ? 'usable' : 'greyed out'}. A menu item that quietly went grey is a control that stopped working with nothing on screen to say so.`,
      journey: id,
      surface: 'electron',
    }));
  }

  // ---- what it wrote in its own settings folder
  const changes = compareTrees(input.before, input.after);
  for (const change of changes) {
    out.push(observation({
      channel: 'effects',
      path: joinPath('file', id, asAddress(change.file)),
      value: change.what === 'deleted' ? 'deleted' : { what: change.what, contents: change.now ?? '' },
      says: change.what === 'deleted'
        ? `The app deleted ${change.file} from its own settings folder.`
        : `The app ${change.what} ${change.file} in its own settings folder. Only the contents are compared, so rewriting the same bytes is not a change.`,
      journey: id,
    }));
  }
  out.push(observation({
    channel: 'counters',
    path: joinPath('count', id, 'files it wrote'),
    value: countBucket(changes.length),
    says: `The app created or changed ${changes.length} file${changes.length === 1 ? '' : 's'} in its own settings folder while this journey ran.`,
    journey: id,
  }));

  // ---- what it started, and what it reached for
  const effects = reading?.effects;
  if (effects) {
    for (const spawned of effects.spawns ?? []) {
      out.push(observation({
        channel: 'effects',
        path: joinPath('proc', id, asAddress(tidy(String(spawned.what)))),
        value: spawned.times,
        says: `The app started ${tidy(String(spawned.what))}${spawned.times > 1 ? ` ${spawned.times} times` : ''}. A program appearing here that was not here before means the app started depending on something new.`,
        journey: id,
      }));
    }
    const refused = new Set((effects.refused ?? []).map(String));
    for (const attempt of effects.connects ?? []) {
      const where = tidy(String(attempt.what));
      const wasRefused = [...refused].some((r) => where.includes(r));
      out.push(observation({
        channel: 'effects',
        path: joinPath('net', id, asAddress(where)),
        value: wasRefused
          ? `tried ${attempt.times} time${attempt.times === 1 ? '' : 's'}, refused every time`
          : `tried ${attempt.times} time${attempt.times === 1 ? '' : 's'}, on this machine`,
        says: wasRefused
          ? `The app tried to reach ${where}, which is off this machine, and was refused. What it asked for is compared; whether it would have worked is not, because it was never allowed to happen.`
          : `The app connected to ${where}, which is on this machine, so it was allowed through.`,
        covered: wasRefused ? false : undefined,
        reason: wasRefused ? 'irreversible' : undefined,
        journey: id,
      }));
    }
    for (const hole of effects.couldNotWatch ?? []) {
      out.push(notCovered({
        channel: 'effects',
        path: joinPath('net', id, asAddress(`not watched: ${hole}`, 80)),
        reason: 'not supported here',
        says: `Nothing was watching ${hole}, so anything the app did that way was neither seen nor stopped.`,
      }));
    }
  } else {
    out.push(notCovered({
      channel: 'effects',
      path: joinPath('net', id, 'watched at all'),
      reason: 'not supported here',
      says: 'Nothing was watching the main process from the inside, so what the app started and what it reached for were not seen, and nothing was refused. Its window, its doors and its files were still read exactly.',
    }));
  }

  // ---- what the window asked the network for
  const offMachine = app.requests.filter((r) => r.refused);
  if (offMachine.length > 0) {
    /** @type {Map<string, number>} */
    const hosts = new Map();
    for (const request of offMachine) {
      let host = request.url;
      try { host = new URL(request.url).host; } catch { /* keep the whole thing */ }
      hosts.set(host, (hosts.get(host) ?? 0) + 1);
    }
    for (const [host, times] of [...hosts].sort()) {
      out.push(observation({
        channel: 'effects',
        path: joinPath('net', id, asAddress(`window asked ${host}`)),
        value: `asked ${times} time${times === 1 ? '' : 's'}, refused every time`,
        says: `The window itself tried to reach ${host} and was refused. The ask is compared; the answer never happened.`,
        covered: false,
        reason: 'irreversible',
        journey: id,
      }));
    }
  }

  // ---- what it complained about
  out.push(observation({
    channel: 'complaints',
    path: joinPath('app', id, 'errors'),
    value: app.complaints.length === 0 ? 'none' : app.complaints.map((c) => tidy(c)),
    says: app.complaints.length === 0
      ? 'Neither the window nor the main process complained about anything while this journey ran.'
      : `${app.complaints.length} error${app.complaints.length === 1 ? '' : 's'} came out of the app while this journey ran. A screen can look perfect and still be on fire.`,
    journey: id,
  }));
  const ended = app.started.finished();
  out.push(observation({
    channel: 'complaints',
    path: joinPath('app', id, 'still running at the end'),
    value: ended === null ? true : `it quit on its own: ${ended.signal ? `stopped by ${ended.signal}` : `exit code ${ended.code}`}`,
    says: ended === null
      ? 'The app was still running when the journey finished, which is what should happen.'
      : 'The app quit on its own before the journey finished. That is a crash, whatever it printed on the way out.',
    journey: id,
  }));

  // ---- how it went
  out.push(observation({
    channel: 'results',
    path: joinPath('app', id, 'steps'),
    value: did.length === 0 ? 'just opened it and looked' : did,
    says: did.length === 0
      ? 'This journey opened the app and read it, without touching anything.'
      : `What this journey did, in order: ${did.join('; ')}.`,
    journey: id,
  }));
  out.push(howLongItTook({
    channel: 'counters',
    path: joinPath('count', id, 'time to open'),
    ms: app.openedInMs,
    what: 'Opening the app and getting a window on screen',
    journey: id,
  }));
  if (reading?.helpers) {
    out.push(observation({
      channel: 'counters',
      path: joinPath('count', id, 'helper processes'),
      value: reading.helpers.length,
      says: `The app is running as ${reading.helpers.length} processes: ${reading.helpers.join(', ')}. A desktop app is never one program.`,
      journey: id,
    }));
  }

  for (const problem of reading?.problems ?? []) {
    out.push(notCovered({
      channel: 'meaning',
      path: joinPath('app', id, asAddress(`could not read ${String(problem).split(':')[0]}`, 80)),
      reason: 'crashed',
      says: `Part of the app could not be read: ${problem}`,
    }));
  }

  return out;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * What each prepared build needs to open itself, kept out of the engine's way.
 * @type {Map<string, {binary: string, config: Record<string, any>, projectRoot: string}>}
 */
const recipes = new Map();

/**
 * Every app opened by this adapter that has not been closed yet.
 * @type {Set<OpenApp>}
 */
const openNow = new Set();

/**
 * The IPC channels the source adapter read out of the code, remembered from `journeys` so
 * `run` can say how many of them the running app actually registered. The engine hands the
 * contract to `journeys` and not to `run`, so this is where it has to be caught.
 * @type {string[]}
 */
let channelsFromTheCode = [];

/**
 * Close one app and prove it is gone. Used at the end of every journey, and again on the way
 * out of a check that threw.
 *
 * @param {OpenApp} app
 * @param {(message: string) => void} [log]
 * @returns {Promise<import('./isolate.js').TeardownReport>}
 */
async function closeApp(app, log) {
  openNow.delete(app);
  const report = await releaseIsolation(app.isolation);
  log?.(report.why);
  return report;
}

/**
 * The channels the source said this app opens, pulled out of the contract the source adapter
 * already read. Free, and it is what turns "421 doors" into "421 doors and here are the three
 * that stopped answering".
 *
 * @param {Observation[]} [contract]
 * @returns {string[]}
 */
export function declaredChannels(contract) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const item of contract ?? []) {
    const parts = splitPath(item.path);
    if (parts[0] === 'ipc' && parts.length >= 2 && parts[parts.length - 1] === 'registered') {
      names.add(parts.slice(1, -1).join('.'));
    }
  }
  return [...names].sort();
}

export const electronAdapter = defineAdapter({
  name: 'electron',
  title: 'Desktop apps built with Electron',
  describe:
    'Opens a built desktop app on its own — its own settings folder, its own ports, its own name — and reads both halves of it: every control in the window by what it says it is, every private channel the app has registered, its windows and menus, the files it writes, the programs it starts and everything it tries to reach. It never knocks on a door it was not told to knock on, and it refuses every connection that would leave this machine. It cannot see what a channel DOES unless a journey names it, and it cannot check an app that has not been built yet.',
  channels: ['meaning', 'effects', 'complaints', 'results', 'contract', 'counters', 'pixels'],

  /** @param {import('./contract.js').AdapterProject} project */
  async detect(project) {
    const config = project.config ?? {};
    const found = await findAppBinary(project.root, config);
    /** @type {import('./contract.js').Missing[]} */
    const missing = [];

    let usesElectron = false;
    try {
      const pkg = JSON.parse(await fsp.readFile(path.join(project.root, 'package.json'), 'utf8'));
      usesElectron = Boolean(pkg.dependencies?.electron || pkg.devDependencies?.electron || pkg.build?.appId);
    } catch { /* a project with no package.json can still be a built app somebody pointed at */ }

    if (!found.binary) {
      missing.push({
        what: 'the built app',
        unlocks: 'checking the desktop app at all — the window, its private channels, its menus and everything it writes',
        howToGet: usesElectron
          ? 'Build it the way you normally do (often `npm run build` then `npm run package`), then point "electron.binary" in the config at the result. On a Mac that is the .app; on Windows the .exe.'
          : 'Point "electron.binary" in the config at your built desktop app.',
        blocking: true,
      });
    }
    if (!config.identityEnv) {
      missing.push({
        what: 'the name of the setting this app uses to know who it is',
        unlocks: 'running two builds safely when the app signs in to something with a device id or takes a slot on a server',
        howToGet: 'Put {"identityEnv": {"YOUR_APP_DEVICE_ID": "{identity}"}} under "electron" in the config. Without it, two runs could both claim the same slot — which is the exact bug that cost a day on this machine on 2026-08-28.',
      });
    }

    const applies = Boolean(found.binary) || usesElectron;
    return {
      applies,
      confidence: found.binary ? 1 : (usesElectron ? 0.5 : 0),
      why: found.binary
        ? `${found.why} It will be opened on its own, read, and closed again — one copy at a time, never two.`
        : usesElectron
          ? `This is an Electron project, but no built app was found, so there is nothing to open yet. ${found.why}`
          : 'This does not look like an Electron desktop app.',
      missing,
      notes: [
        'The list of private channels is read out of the running app, never knocked on. Asking an unknown channel to answer could do anything, including something that cannot be undone.',
        'Every connection that would leave this machine is refused, and refusals are reported as holes in what was checked — never as a pass.',
        'The two builds are opened one after the other, never at the same time, and the first one is proved gone before the second starts.',
      ],
    };
  },

  /** @param {import('./contract.js').AdapterProject} project */
  async journeys(project) {
    const config = project.config ?? {};
    channelsFromTheCode = declaredChannels(project.contract ?? config.contract);
    /** @type {Journey[]} */
    const journeys = [{
      name: 'open-the-app',
      describe: 'open the app and read everything it shows and everything it registers',
      source: 'code',
      surface: 'electron',
      channels: ['meaning', 'effects', 'complaints', 'results', 'contract', 'counters', 'pixels'],
      steps: [],
    }];

    for (const written of config.journeys ?? []) {
      journeys.push({
        name: String(written.name ?? 'a journey with no name'),
        describe: String(written.describe ?? written.why ?? `walk ${written.name}`),
        source: 'recorded',
        surface: 'electron',
        from: 'the project config',
        channels: ['meaning', 'effects', 'complaints', 'results', 'counters', 'pixels'],
        steps: Array.isArray(written.steps) ? written.steps : [],
        irreversible: written.irreversible === true,
        timeoutMs: written.timeoutMs,
      });
    }

    // A channel the project has named as safe to ask gets its own journey, because a door
    // that is registered and a door that answers are two different facts and only one of
    // them is free.
    for (const asked of config.exercise ?? []) {
      const channel = typeof asked === 'string' ? asked : String(asked.channel ?? '');
      if (!channel) continue;
      journeys.push({
        name: `ask ${channel}`,
        describe: `ask the private channel "${channel}" to answer, and compare what it says`,
        source: 'code',
        surface: 'electron',
        from: 'the project config',
        channels: ['results', 'complaints', 'effects', 'counters'],
        steps: [{ act: 'ipc', channel, args: (typeof asked === 'object' && Array.isArray(asked.args)) ? asked.args : [] }],
        irreversible: typeof asked === 'object' && asked.irreversible === true,
      });
    }

    return journeys;
  },

  /**
   * Get one build ready. Nothing is opened here.
   *
   * The app is opened FRESH for every journey rather than once per build, and that is a
   * deliberate trade. Booting is normally the expensive part — but a desktop app measured
   * here opens in about a second, while a journey that clicked three things leaves the next
   * journey looking at a different app. Paying a second to have every journey start from the
   * same place is the better half of that bargain, and it makes "nothing is ever left
   * running" true by construction rather than by care.
   *
   * @param {import('./contract.js').Build} build
   * @param {RunContext} ctx
   */
  async prepare(build, ctx) {
    const config = ctx.config ?? {};
    const found = await findAppBinary(build.root, config);
    if (!found.binary) {
      return {
        build,
        root: build.root,
        ready: false,
        why: `${found.why} There is nothing to open, so this build cannot be walked. Build the app and point "electron.binary" at it.`,
        dispose: async () => {},
      };
    }
    recipes.set(build.id, { binary: found.binary, config, projectRoot: build.root });
    return {
      build,
      root: build.root,
      ready: true,
      why: `The app at ${found.binary} will be opened fresh for each journey, on its own settings folder and its own ports, and closed and proved gone afterwards.`,
      facts: { binary: found.binary },
      dispose: async () => {
        recipes.delete(build.id);
        for (const app of [...openNow]) await closeApp(app);
      },
    };
  },

  /**
   * @param {Journey} journey
   * @param {import('./contract.js').PreparedBuild} build
   * @param {RunContext} ctx
   * @returns {Promise<Observation[]>}
   */
  async run(journey, build, ctx) {
    const recipe = recipes.get(build.build.id);
    if (!build.ready || !recipe) {
      return [notCovered({
        channel: 'meaning',
        path: joinPath('app', journey.name, 'opened at all'),
        reason: 'refused',
        says: `"${journey.describe}" was not walked: ${build.why}`,
      })];
    }
    if (journey.irreversible && ctx.allowIrreversible !== true) {
      return [notCovered({
        channel: 'effects',
        path: joinPath('app', journey.name, 'opened at all'),
        reason: 'irreversible',
        says: `"${journey.describe}" was left alone because it spends money, sends a message or destroys data. This is a hole in what was checked, not a pass.`,
      })];
    }

    const config = recipe.config ?? {};
    const isolation = await reserveIsolation({
      scratchDir: ctx.scratchDir,
      label: build.build.label,
      appId: config.appId ?? recipe.binary,
      clock: ctx.clock,
      seed: ctx.seed,
      identityEnv: config.identityEnv,
      env: config.env,
    });

    /** @type {OpenApp|null} */
    let app = null;
    let closed = false;
    try {
      app = await openApp({
        binary: recipe.binary,
        isolation,
        windowMatch: config.windowMatch,
        extraArgs: config.args,
        timeoutMs: config.startTimeoutMs ?? 60_000,
        signal: ctx.signal,
        log: ctx.log,
      });
      openNow.add(app);
      ctx.log?.(describeIsolation(isolation));

      const before = await snapshotTree(isolation.userDataDir);

      // ---- do whatever this journey does
      /** @type {string[]} */
      const did = [];
      /** @type {Observation[]} */
      const extra = [];
      for (const step of journey.steps ?? []) {
        const asAny = /** @type {any} */ (step);
        if (String(asAny.act) === 'ipc') {
          const asked = await exerciseChannel(app, String(asAny.channel), Array.isArray(asAny.args) ? asAny.args : []);
          did.push(`asked "${asAny.channel}" to answer — ${asked.why}`);
          extra.push(observation({
            channel: 'results',
            path: joinPath('ipc', asAddress(String(asAny.channel)), 'answers'),
            value: asked.answered ? asked.value : `did not answer — ${asked.why}`,
            says: asked.answered
              ? `The private channel "${asAny.channel}" was asked to answer, and this is what it said. This is the only kind of door whose BEHAVIOUR is checked; the rest are only known to be registered.`
              : `The private channel "${asAny.channel}" was asked to answer and did not: ${asked.why}.`,
            journey: journey.name,
            surface: 'electron',
          }));
          continue;
        }
        const outcome = await takeStep(app, asAny);
        did.push(outcome.ok ? outcome.did : `${outcome.did} — and that is a failure, not a skip`);
        if (!outcome.ok) {
          extra.push(observation({
            channel: 'results',
            path: joinPath('app', journey.name, asAddress(`step: ${String(asAny.act)}`, 60)),
            value: `could not: ${outcome.did}`,
            says: `A step of "${journey.describe}" could not be carried out: ${outcome.did}. Everything after it in this journey happened somewhere the journey did not mean to be.`,
            journey: journey.name,
          }));
        }
      }

      // ---- read it, once it has stopped moving
      const opened = app;
      const settledTree = await settleTree(async () => {
        const tree = await opened.browser.send('Accessibility.getFullAXTree', {}, opened.sessionId).catch(() => ({ nodes: [] }));
        return tree?.nodes ?? [];
      }, { tries: config.settleTries ?? 8, gapMs: config.settleGapMs ?? 350 });

      // Bounded, and it degrades rather than throws. Everything the window said has already
      // been collected by this point, and losing all of it because the main process went quiet
      // would turn one hole into a whole unchecked build.
      const read = await withLimit(
        app.main.send('Runtime.evaluate', { expression: mainReadScript(), returnByValue: true, awaitPromise: true }),
        { limitMs: 30_000, what: 'the main process to say what it is, what doors it has open and what it did' },
      ).catch((e) => ({ result: { value: { problems: [e instanceof Error ? e.message : String(e)] } } }));
      const reading = read?.result?.value ?? { problems: ['the main process would not say anything about itself'] };
      if (Array.isArray(app.couldNotWatch) && app.couldNotWatch.length > 0) {
        reading.effects = reading.effects ?? {};
        reading.effects.couldNotWatch = [...(reading.effects.couldNotWatch ?? []), ...app.couldNotWatch];
      }

      const after = await snapshotTree(isolation.userDataDir);

      const observations = describeApp({
        app,
        journey,
        ctx,
        reading,
        axNodes: settledTree.nodes,
        settled: settledTree.settled,
        before,
        after,
        declaredChannels: channelsFromTheCode,
        did,
        projectRoot: recipe.projectRoot,
      });
      observations.push(...extra);

      // ---- and last of all, the picture
      observations.push(await takePicture(app, journey, ctx));

      const teardown = await closeApp(app, ctx.log);
      closed = true;
      observations.push(observation({
        channel: 'counters',
        path: joinPath('app', journey.name, 'closed cleanly'),
        value: teardown.proved,
        says: teardown.why,
        journey: journey.name,
      }));
      return observations;
    } finally {
      // A check that threw must never leave somebody's screen with a scratch copy of their
      // own app sitting on it. Opening can fail halfway — a process started and no window —
      // so the isolation is released either way, and only ever once.
      if (!closed) {
        if (app) await closeApp(app, ctx.log);
        else await releaseIsolation(isolation).catch(() => {});
      }
    }
  },

  async teardown() {
    for (const app of [...openNow]) await closeApp(app);
    recipes.clear();
    await releaseEverything();
  },
});

/**
 * One picture, written to the evidence folder and pointed at.
 *
 * Channel seven, and it behaves like channel seven: what is COMPARED is a fingerprint and the
 * size, so a screen that really did change says so — and the picture itself is only ever
 * there so a person can look at what the other six channels already said.
 *
 * @param {OpenApp} app
 * @param {Journey} journey
 * @param {RunContext} ctx
 * @returns {Promise<Observation>}
 */
async function takePicture(app, journey, ctx) {
  try {
    const shot = await app.browser.send('Page.captureScreenshot', { format: 'png' }, app.sessionId);
    const bytes = Buffer.from(String(shot?.data ?? ''), 'base64');
    if (bytes.length === 0) throw new Error('the app sent back an empty picture');
    // Fingerprinted rather than simply cut. Two journeys whose names agreed for sixty
    // characters saved their pictures over each other, and the evidence offered for one
    // finding was then a photograph of a different window, with nothing about it looking wrong.
    const file = path.join(ctx.evidenceDir, `${pictureName(journey.name)}.png`);
    await fsp.mkdir(ctx.evidenceDir, { recursive: true });
    await fsp.writeFile(file, bytes);
    return observation({
      channel: 'pixels',
      path: joinPath('screen', journey.name, 'picture'),
      value: { looks: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16), size: sizeBucket(bytes.length) },
      says: 'What the window looked like. This is evidence for a finding one of the other channels already made — never the accusation itself.',
      evidence: file,
      journey: journey.name,
    });
  } catch (e) {
    return notCovered({
      channel: 'pixels',
      path: joinPath('screen', journey.name, 'picture'),
      reason: 'crashed',
      says: `No picture could be taken of the window: ${e instanceof Error ? e.message : String(e)}. Everything else about the window was still read.`,
    });
  }
}
