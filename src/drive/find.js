/**
 * Finding the pieces we need on whatever machine this is running on:
 * a browser to drive, the real executable inside a Mac app bundle, and a free port.
 *
 * Everything here is best-effort and never throws unless the caller asked for a
 * guarantee (`requireChrome`, `resolveElectronBinary`).
 */

import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer, connect as netConnect } from 'node:net';
import { join, basename, sep } from 'node:path';
import { homedir } from 'node:os';

import { StaysFixedError } from '../core/errors.js';

/** Env vars people already set for other tools — honour them before guessing. */
const ENV_KEYS = ['STAYSFIXED_CHROME', 'CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH'];

/**
 * @param {string} p
 * @returns {boolean}
 */
function isFileOnDisk(p) {
  const s = statSync(p, { throwIfNoEntry: false });
  return Boolean(s && s.isFile());
}

/**
 * Bare names get looked up on PATH; anything with a separator is a real path.
 * @param {string} name
 * @returns {boolean}
 */
function isBareName(name) {
  return !name.includes('/') && !name.includes(sep);
}

/**
 * Every place a browser might be on this machine, best first.
 * @returns {string[]}
 */
export function chromeCandidates() {
  /** @type {string[]} */
  const out = [];
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value) out.push(value);
  }

  const home = homedir();

  if (process.platform === 'darwin') {
    const apps = [
      ['Google Chrome.app', 'Google Chrome'],
      ['Google Chrome Canary.app', 'Google Chrome Canary'],
      ['Chromium.app', 'Chromium'],
      ['Brave Browser.app', 'Brave Browser'],
      ['Microsoft Edge.app', 'Microsoft Edge'],
    ];
    for (const root of ['/Applications', join(home, 'Applications')]) {
      for (const [bundle, exe] of apps) {
        out.push(join(root, bundle, 'Contents', 'MacOS', exe));
      }
    }
  } else if (process.platform === 'win32') {
    const roots = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ].filter((/** @type {string|undefined} */ v) => Boolean(v));
    for (const root of /** @type {string[]} */ (roots)) {
      out.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      out.push(join(root, 'Google', 'Chrome SxS', 'Application', 'chrome.exe'));
      out.push(join(root, 'Chromium', 'Application', 'chrome.exe'));
      out.push(join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
      out.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    out.push('chrome.exe', 'msedge.exe');
  } else {
    const names = [
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
      'microsoft-edge',
      'microsoft-edge-stable',
      'brave-browser',
    ];
    for (const dir of ['/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/google/chrome']) {
      for (const name of names) out.push(join(dir, name));
    }
    // /opt/google/chrome ships the binary as plain "chrome".
    out.push('/opt/google/chrome/chrome');
    out.push(...names);
  }

  // Keep the order, drop repeats.
  return [...new Set(out)];
}

/**
 * Ask the shell where a bare command lives.
 * @param {string} name
 * @returns {string|null}
 */
function lookupOnPath(name) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const found = execFileSync(finder, [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const first = String(found)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (first && isFileOnDisk(first)) return first;
  } catch {
    // Not on PATH. That is an answer, not a failure.
  }
  return null;
}

/**
 * A path the user gave us may point at a Mac app bundle; unwrap it quietly.
 * @param {string} p
 * @returns {string}
 */
function unwrapIfBundle(p) {
  if (!p.endsWith('.app')) return p;
  try {
    return resolveElectronBinary(p);
  } catch {
    return p;
  }
}

/**
 * @param {string} [explicit]  A path from config or the command line.
 * @returns {string|null}
 */
export function findChrome(explicit) {
  if (explicit) {
    const unwrapped = unwrapIfBundle(explicit);
    if (existsSync(unwrapped)) return unwrapped;
    if (isBareName(explicit)) {
      const onPath = lookupOnPath(explicit);
      if (onPath) return onPath;
    }
    return null;
  }

  const candidates = chromeCandidates();
  for (const candidate of candidates) {
    if (isBareName(candidate)) continue;
    const unwrapped = unwrapIfBundle(candidate);
    if (isFileOnDisk(unwrapped)) return unwrapped;
  }
  for (const candidate of candidates) {
    if (!isBareName(candidate)) continue;
    const onPath = lookupOnPath(candidate);
    if (onPath) return onPath;
  }
  return null;
}

/**
 * @param {string} [explicit]
 * @returns {string}
 */
export function requireChrome(explicit) {
  const found = findChrome(explicit);
  if (found) return found;

  if (explicit) {
    throw new StaysFixedError(`There is no browser at "${explicit}".`, {
      hint: 'Check the path in your config under app.browser, or remove it and let Stays Fixed find one.',
    });
  }

  const looked = chromeCandidates()
    .filter((c) => !isBareName(c))
    .slice(0, 6)
    .map((c) => `  ${c}`)
    .join('\n');

  throw new StaysFixedError('Stays Fixed could not find Chrome, Chromium, Brave or Edge on this machine.', {
    hint:
      'Install Google Chrome, or point Stays Fixed at the browser you have: set app.browser in your config, or the STAYSFIXED_CHROME environment variable.\n' +
      `It looked in places like:\n${looked}`,
  });
}

/**
 * Turn a Mac `.app` bundle into the executable inside it. Anything else is
 * handed straight back, so this is safe to call on every platform.
 * @param {string} p
 * @returns {string}
 */
export function resolveElectronBinary(p) {
  if (!p) {
    throw new StaysFixedError('No app was given to open.', {
      hint: 'Set app.binary in your config to the app you want checked.',
    });
  }
  const stat = statSync(p, { throwIfNoEntry: false });
  if (!stat) {
    throw new StaysFixedError(`There is nothing at "${p}".`, {
      hint: 'Check app.binary in your config — it should point at your built app.',
    });
  }
  if (stat.isFile()) return p;

  const macos = join(p, 'Contents', 'MacOS');
  const macosStat = statSync(macos, { throwIfNoEntry: false });
  if (!macosStat || !macosStat.isDirectory()) {
    throw new StaysFixedError(`"${p}" is a folder, not an app Stays Fixed can open.`, {
      hint: 'Point app.binary at the built app itself — on a Mac that is the .app bundle, elsewhere the executable file.',
    });
  }

  // Info.plist is usually XML; a plain regex beats adding a plist library.
  // When it is the binary format the regex simply misses and we fall through.
  const plist = join(p, 'Contents', 'Info.plist');
  try {
    const text = readFileSync(plist, 'utf8');
    const match = text.match(/<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/);
    if (match) {
      const named = join(macos, match[1].trim());
      if (isFileOnDisk(named)) return named;
    }
  } catch {
    // No readable Info.plist. Fall back to looking in the folder.
  }

  const entries = readdirSync(macos).filter((name) => isFileOnDisk(join(macos, name)));
  if (entries.length === 1) return join(macos, entries[0]);

  const wanted = basename(p).replace(/\.app$/, '');
  const guess = entries.find((name) => name === wanted);
  if (guess) return join(macos, guess);

  throw new StaysFixedError(`Stays Fixed could not tell which program to run inside "${p}".`, {
    hint: `Point app.binary straight at the executable, for example ${join(macos, entries[0] ?? wanted)}.`,
  });
}

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function canBind(port) {
  return new Promise((resolve) => {
    const server = createServer();
    const done = (/** @type {boolean} */ answer) => {
      server.removeAllListeners();
      try {
        server.close();
      } catch {
        /* already closed */
      }
      resolve(answer);
    };
    server.once('error', () => done(false));
    server.once('listening', () => done(true));
    try {
      server.listen(port, '127.0.0.1');
    } catch {
      done(false);
    }
  });
}

/**
 * A port nothing else is using. Asking the operating system for one beats
 * guessing — two runs at once must never fight over the same number.
 * @param {number} [preferred]
 * @returns {Promise<number>}
 */
export async function freePort(preferred) {
  if (typeof preferred === 'number' && Number.isInteger(preferred) && preferred > 0 && preferred < 65_536) {
    if (await canBind(preferred)) return preferred;
  }
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (e) => {
      reject(new StaysFixedError('Stays Fixed could not reserve a port to talk to the app on.', { cause: e }));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => {
        if (port) resolve(port);
        else reject(new StaysFixedError('Stays Fixed could not reserve a port to talk to the app on.'));
      });
    });
  });
}

/**
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
export function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = netConnect({ port, host });
    let answered = false;
    const done = (/** @type {boolean} */ answer) => {
      if (answered) return;
      answered = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Pictures are tagged with this because text is drawn differently on every
 * operating system — a Mac picture will never match a Linux one.
 * @returns {string}
 */
export function platformTag() {
  return `${process.platform}-${process.arch}`;
}
