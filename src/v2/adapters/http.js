/**
 * Servers and APIs.
 *
 * The shape of this one is the same as the CLI adapter's, with the expensive part moved:
 * booting a server is slow and answering a request is fast, so the boot happens once per
 * build in `prepare` and every route is walked against the one running copy. What each
 * route gives back — its status, the headers that mean something, its body — is the
 * results channel. What it QUIETLY DID while answering — the files it wrote, the services
 * it called — is the effects channel, and that is the half a response-body diff misses
 * entirely. A route that still returns `{"ok":true}` but has stopped writing the record is
 * broken, and only the second half sees it.
 *
 * WHERE THE ROUTES COME FROM. Out of the source, never out of a crawl. Crawling finds the
 * pages somebody linked to; the source lists every route there is, including the four
 * nobody links to and the one that was deleted this morning. It is also free, exact, and
 * does not need the server running to produce the list.
 *
 * THE PORT AND THE DATA. Every boot gets a port nobody else is on, a scratch copy of the
 * project, a scratch home folder and a restored fixture, so two builds walked minutes apart
 * see the same rows. The two builds are NEVER booted at the same time: two servers on one
 * machine fight over ports, locks and data directories, and that fight looks exactly like a
 * regression.
 *
 * WHAT IT REFUSES. Outbound connections, all of them, at the socket. The server may ask its
 * payment provider for a charge; the ask is recorded — same amount, same currency, same
 * endpoint — and the connection never completes. A migration that destroys data is not run
 * twice; it is not run at all, and the run says so. Neither refusal is ever reported as a
 * pass.
 */

import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {
  defineAdapter, joinPath, notCovered, observation, sizeBucket, stableValue,
  howLongItTook, timeBucket, trimForStorage, undoOurFootprint,
} from './contract.js';
import {
  compareTrees, copyForScratch, frozenEnvironment, readWatcher, snapshotTree, watcherScript,
} from './process.js';
import { readContract, readFileRoutes } from './source.js';
import { spawnServer, stopServer } from './child.js';

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/**
 * The headers worth comparing.
 *
 * Short on purpose. `date` changes every second, `content-length` is just the body counted
 * again, `server` and `connection` belong to the runtime rather than to the product. What
 * is left is the set a client's behaviour actually depends on: what type the body is, where
 * it was redirected to, what it is allowed to cache, who it may be shared with, and what it
 * says when it says no.
 */
const HEADERS_THAT_MATTER = new Set([
  'content-type', 'content-language', 'content-disposition', 'content-encoding',
  'cache-control', 'location', 'allow', 'vary', 'retry-after', 'www-authenticate',
  'access-control-allow-origin', 'access-control-allow-methods', 'x-frame-options',
  'content-security-policy', 'strict-transport-security', 'x-content-type-options',
]);

/**
 * Pull out the headers worth comparing, plus two derived facts.
 *
 * A cookie's VALUE is a session id — new on every request, and comparing it would report a
 * difference every single run. Its NAME is the promise, and a route that stopped setting
 * the session cookie is a real regression, so the names are kept and the values are not.
 * An etag is the same story one level down: whether there is one is a promise, what it says
 * is a hash of the body, which is already being compared.
 *
 * @param {Headers} headers
 * @returns {Record<string, string|string[]>}
 */
export function headersThatMatter(headers) {
  /** @type {Record<string, string|string[]>} */
  const kept = {};
  for (const [name, value] of headers) {
    if (HEADERS_THAT_MATTER.has(name.toLowerCase())) kept[name.toLowerCase()] = value;
  }
  const cookies = headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) {
    kept['sets cookies named'] = cookies.map((c) => c.split('=')[0].trim()).sort();
  }
  if (headers.has('etag')) kept['has an etag'] = 'yes';
  return kept;
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ReadBody
 * @property {import('./contract.js').JsonValue} value   What is compared.
 * @property {import('./contract.js').JsonValue} [shape] The key paths and their types, when
 *                                                       the body is JSON. Steady while the
 *                                                       values churn, so an added or removed
 *                                                       field shows up on its own.
 * @property {number} bytes
 * @property {boolean} truncated
 */

/**
 * Turn a response body into something comparable.
 *
 * JSON gets its keys sorted, because two runs can build the same object in a different
 * order and that is not a difference. Anything that is not text at all is reduced to its
 * size and a fingerprint: an image that changed says so, and nobody has to store the image
 * to find out.
 *
 * @param {string} contentType
 * @param {string} text
 * @returns {ReadBody}
 */
export function readBody(contentType, text) {
  const bytes = Buffer.byteLength(text, 'utf8');
  const type = contentType.toLowerCase();

  // A 204, a HEAD, a redirect. An empty body is a perfectly good answer and saying it
  // "claimed to be JSON and was not" would be a difference reported on every single run.
  if (text === '') return { value: 'nothing at all', bytes: 0, truncated: false };

  if (type.includes('json')) {
    try {
      const parsed = JSON.parse(text);
      return { value: stableValue(parsed), shape: shapeOf(parsed), bytes, truncated: false };
    } catch {
      // A route that claims JSON and sends something else is itself the finding.
      return { value: `said it was JSON but was not: ${trimForStorage(text, 2000).text}`, bytes, truncated: false };
    }
  }
  const kept = trimForStorage(text);
  return { value: kept.text, bytes, truncated: kept.truncated };
}

/**
 * The key paths in a JSON value and the type at each, with every array collapsed to "a list
 * of N things shaped like this".
 *
 * This is the channel that catches a field being renamed while every value stays plausible.
 * Comparing the body alone catches it too, but it catches it buried inside a diff of the
 * whole body; comparing the shape separately makes it a finding of its own with a name.
 *
 * @param {unknown} value
 * @param {string} [at]
 * @returns {import('./contract.js').JsonValue}
 */
export function shapeOf(value, at = '') {
  if (value === null) return 'nothing';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'an empty list';
    return { 'a list of': value.length, 'each one': shapeOf(value[0], `${at}[]`) };
  }
  if (typeof value === 'object') {
    /** @type {Record<string, import('./contract.js').JsonValue>} */
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = shapeOf(/** @type {any} */ (value)[key], `${at}.${key}`);
    return out;
  }
  return typeof value;
}

// ---------------------------------------------------------------------------
// Ports and booting
// ---------------------------------------------------------------------------

/**
 * The two things "this machine" can mean, and why both have to be knocked on.
 *
 * A server told to listen on `localhost` does not choose between IPv4 and IPv6 — the
 * operating system chooses, when it resolves the name, and the two answers are different
 * addresses. Measured on this Mac on 2026-08-31 against a stock Vite app: `vite preview`
 * bound `[::1]:PORT` and NOTHING was listening on `127.0.0.1:PORT`. A boot check that
 * knocked only on `127.0.0.1` was refused instantly, two hundred milliseconds apart, for
 * the whole ninety seconds — on the most ordinary kind of project there is. So both are
 * knocked on, and whichever one answers is the address the rest of the run uses.
 */
const LOOPBACK = ['127.0.0.1', '::1'];

/**
 * An address written the way a URL has to have it.
 *
 * IPv6 needs square brackets and nothing else may have them, and getting it wrong is
 * silent rather than loud: `http://::1:5173/` parses as a hostname nobody has.
 *
 * @param {string} host
 * @param {number} port
 * @returns {string}
 */
export function loopbackUrl(host, port) {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return bare.includes(':') ? `http://[${bare}]:${port}` : `http://${bare}:${port}`;
}

/**
 * Knock once on one address, and say which of the three things happened.
 *
 * "Refused" is worth keeping apart from "timed out" because they mean opposite things.
 * Refused is this machine answering straight away that nothing is listening on that port;
 * no amount of waiting changes that while it stays true. Timed out is something that never
 * answered at all, which really can be a server still starting up.
 *
 * @param {number} port
 * @param {string} host
 * @param {number} [timeoutMs]
 * @returns {Promise<{open: boolean, refused: boolean}>}
 */
function knock(port, host, timeoutMs = 1000) {
  return new Promise((resolve) => {
    /** @type {import('node:net').Socket} */
    let socket;
    try {
      socket = net.connect({ port, host });
    } catch {
      // No IPv6 on this machine at all, or an address that cannot be parsed. Either way
      // nothing is listening there, which is the answer this function exists to give.
      resolve({ open: false, refused: false });
      return;
    }
    let settled = false;
    /**
     * @param {boolean} open
     * @param {boolean} refused
     */
    const done = (open, refused) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
      resolve({ open, refused });
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true, false));
    socket.on('error', (/** @type {any} */ error) => done(false, error?.code === 'ECONNREFUSED' || error?.code === 'EADDRNOTAVAIL'));
    socket.on('timeout', () => done(false, false));
  });
}

/**
 * Take one port off the operating system by briefly being the one using it.
 * @returns {Promise<number>}
 */
function claimPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('the operating system did not give us a port'))));
    });
  });
}

/**
 * Find a port nobody is using.
 *
 * There is a gap between letting go of the port and the server taking it, and something
 * else can slip in. Nothing can close that gap on any operating system, so the boot retries
 * instead of pretending it cannot happen.
 *
 * The second half of this is new on 2026-08-31, and it is here to stop a false all-clear
 * rather than to make anything work. Claiming a port on `127.0.0.1` says nothing at all
 * about IPv6: a port can be free on one family and held by somebody else's program on the
 * other. Now that the boot check knocks on `::1` too, a port free on IPv4 and taken on IPv6
 * would have this tool connect to a STRANGER'S server and walk it as though it were the
 * build being checked — the worst kind of wrong answer this tool can give. So the port is
 * only handed back once both families are quiet.
 *
 * @returns {Promise<number>}
 */
export async function freePort() {
  /** @type {number} */
  let port = 0;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    port = await claimPort();
    const alreadyThere = await knock(port, '::1', 250);
    if (!alreadyThere.open) return port;
  }
  throw new Error(`every port this machine offered was already in use on IPv6 (the last one tried was ${port})`);
}

/** Colour codes a terminal eats, which a plain-text search should not have to see. */
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;

/** `http://host:port` inside something a server printed. The port is the part that matters. */
const PRINTED_ADDRESS = /https?:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+):(\d{2,5})/g;

/**
 * Every address a starting server said about itself.
 *
 * This is the whole answer to "why did it wait ninety seconds". A server that came up
 * somewhere else almost always SAYS so on its first line: Vite prints
 * `Local:   http://localhost:5173/`, Next prints `- Local: http://localhost:3000`,
 * uvicorn prints `Uvicorn running on http://127.0.0.1:8000`. If it printed a port that is
 * not the port it was handed, then nothing is ever going to answer where the check is
 * knocking, and that is knowable a second after it starts rather than a minute and a half
 * later.
 *
 * @param {string|null|undefined} text  Everything the process has printed so far.
 * @returns {{host: string, port: number, url: string}[]}
 */
export function announcedAddresses(text) {
  /** @type {{host: string, port: number, url: string}[]} */
  const found = [];
  const seen = new Set();
  for (const match of String(text ?? '').replace(ANSI, '').matchAll(PRINTED_ADDRESS)) {
    const host = match[1].toLowerCase();
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    const url = loopbackUrl(host, port);
    if (seen.has(url)) continue;
    seen.add(url);
    found.push({ host, port, url });
  }
  return found;
}

/**
 * @typedef {object} WaitResult
 * @property {boolean} up
 * @property {string} why            Plain English, whether it worked or not.
 * @property {number} ms
 * @property {'answered'|'exited'|'wrong address'|'never answered'} outcome
 * @property {string} [host]         The address that actually answered.
 * @property {string} [baseUrl]      That address, written as a URL.
 */

/**
 * Wait until something is listening, or say — quickly, and in words — why it never will be.
 *
 * ## The defect this was rewritten for, 2026-08-31
 *
 * On a stock Vite app on macOS this waited the full ninety seconds and then gave back a
 * sentence nobody could act on. Two separate things were wrong, and only the first is about
 * Vite. The server was listening on `[::1]` while the check knocked on `127.0.0.1`; and
 * every one of those knocks came back REFUSED in under a millisecond, which is this machine
 * saying "there is nothing here", not "not yet". Ninety seconds of that, on each side of the
 * comparison, is three minutes in which the tool is indistinguishable from a broken one.
 *
 * Three things are knowable early, and all three are now said early:
 *
 * 1. The command exited. That was already handled, and still is.
 * 2. The command printed an address on a DIFFERENT port from the one it was handed. It
 *    ignored `$PORT`, so nothing will ever answer where the check is knocking. Stop now,
 *    and name the command, the address it printed and the address that was waited on.
 * 3. Nothing has answered yet and every knock was refused. That one is deliberately NOT
 *    stopped early, because a server that has not opened its port yet is refused in exactly
 *    the same way, and cutting the wait short there would turn a slow build into a failure.
 *    Instead the wait says out loud what it is waiting for while it waits, so that the
 *    difference between working and hung is visible rather than guessed at.
 *
 * @param {number} port
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {() => string|null} [opts.crashed]   Called between tries; a string means stop now.
 * @param {() => string} [opts.announced]      Everything the process has printed so far.
 * @param {string} [opts.command]              The command that was run, for the message.
 * @param {string[]} [opts.hosts]              Addresses to knock on. Both loopbacks by default.
 * @param {(message: string) => void} [opts.say]  Told what is being waited for, as it waits.
 * @returns {Promise<WaitResult>}
 */
export async function waitForServer(port, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const named = opts.command ? `\`${opts.command}\`` : 'the start command';
  /** @type {string[]} */
  const hosts = [...(opts.hosts ?? LOOPBACK)];
  const started = Date.now();
  /** Every knock so far was refused outright, so nothing has ever been listening there. */
  let onlyRefusals = true;
  /** So the running commentary is written every few seconds, not five times a second. */
  let saidAt = 0;

  const where = () => hosts.map((host) => loopbackUrl(host, port)).join(' or ');

  for (;;) {
    const crash = opts.crashed?.();
    if (crash) {
      return {
        up: false,
        outcome: 'exited',
        ms: Date.now() - started,
        why: `${crash} It was started with ${named}, and nothing ever listened at ${where()}.`,
      };
    }

    for (const host of hosts) {
      const hit = await knock(port, host, 1000);
      if (hit.open) {
        const baseUrl = loopbackUrl(host, port);
        return {
          up: true,
          outcome: 'answered',
          host,
          baseUrl,
          ms: Date.now() - started,
          why: `The server answered at ${baseUrl}.`,
        };
      }
      if (!hit.refused) onlyRefusals = false;
    }

    // What it said about itself. This is the fast answer, and the reason the wait no longer
    // spends a minute and a half proving something it could have read off the first line.
    const printed = announcedAddresses(opts.announced?.() ?? '');
    if (printed.length > 0 && !printed.some((one) => one.port === port)) {
      const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
      return {
        up: false,
        outcome: 'wrong address',
        ms: Date.now() - started,
        why: `${named} came up at ${printed.map((one) => one.url).join(', ')}, not on the port it was handed (${port}). Nothing was ever going to answer at ${where()}, so the wait was stopped after ${seconds} second${seconds === 1 ? '' : 's'} instead of running out the clock. Make the command listen on the PORT it is given: for Vite that is \`--port $PORT --strictPort --host 127.0.0.1\`, and for most other things reading process.env.PORT is enough.`,
      };
    }
    // It named an address on OUR port but on a host nobody is knocking on — a server told to
    // listen on the network rather than on loopback. The port is one this tool handed out and
    // proved free, so what is there is its own child. Knock there too rather than time out
    // beside a server that is up.
    for (const one of printed) {
      if (one.port !== port) continue;
      const bare = one.host.startsWith('[') && one.host.endsWith(']') ? one.host.slice(1, -1) : one.host;
      if (bare === 'localhost' || bare === '0.0.0.0' || bare === '::' || hosts.includes(bare)) continue;
      hosts.push(bare);
    }

    const waited = Date.now() - started;
    if (waited > timeoutMs) {
      return {
        up: false,
        outcome: 'never answered',
        ms: waited,
        why: `Nothing answered at ${where()} in ${Math.round(timeoutMs / 1000)} seconds. ${named} was still running${onlyRefusals ? ', and every single knock was refused outright — that is this machine saying nothing is listening on that port at all, rather than that the server is slow' : ''}. ${printed.length > 0 ? `The only address it printed was ${printed.map((one) => one.url).join(', ')}.` : 'It never printed an address saying where it came up.'}`,
      };
    }
    if (opts.say && waited - saidAt >= 5000) {
      saidAt = waited;
      opts.say(`Still waiting for ${named} to answer at ${where()} — ${Math.round(waited / 1000)} seconds so far${onlyRefusals ? ', with every knock refused, which means nothing has opened that port yet' : ''}.`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Commands that would destroy data if they were run.
 *
 * Deliberately blunt. The cost of stopping a restore that was actually safe is a line in the
 * report saying so; the cost of running one that was not is somebody's data, twice.
 */
const DESTRUCTIVE = /\b(drop\s+(database|schema|table)|truncate\b|delete\s+from\b(?![^;]*\bwhere\b)|rm\s+-rf|--force-reset|db\s+push\s+--accept-data-loss|migrate\s+reset)\b/i;

/**
 * @param {string} command
 * @returns {{safe: boolean, why: string}}
 */
export function looksDestructive(command) {
  const match = DESTRUCTIVE.exec(command);
  if (!match) return { safe: true, why: 'Nothing in this command destroys data.' };
  return {
    safe: false,
    why: `This command contains "${match[0]}", which destroys data. It was not run. Everything that depended on it is reported as not checked, which is a hole in the check, not a pass.`,
  };
}

// ---------------------------------------------------------------------------
// Routes, out of the source
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RouteJourneyDetail
 * @property {string} method
 * @property {string} route              The route as the code writes it, params and all.
 * @property {string} url                The route with sample values filled in.
 * @property {string[]} unfilled         Parameters nobody gave us a value for.
 * @property {Record<string,string>} [headers]
 * @property {import('./contract.js').JsonValue} [body]
 */

/** The two ways a route says "a value goes here". */
const PARAM = /:([A-Za-z0-9_]+)|\[\.{3}?([A-Za-z0-9_]+)\]/g;

/**
 * Fill a route's parameters in from the samples the project supplied.
 *
 * A route with a parameter nobody has given a sample for is NOT quietly skipped and NOT
 * guessed at with a 1. It is walked as far as it can be and reported as needing a sample,
 * because "we did not check this" and "this is fine" are the two answers that must never be
 * allowed to look alike.
 *
 * @param {string} route
 * @param {Record<string,string>} samples
 * @returns {{url: string, unfilled: string[]}}
 */
export function fillRoute(route, samples) {
  /** @type {string[]} */
  const unfilled = [];
  const url = route.replace(PARAM, (whole, colon, bracket) => {
    const name = colon ?? bracket;
    const sample = samples[name];
    if (sample === undefined) { unfilled.push(name); return whole; }
    return encodeURIComponent(sample);
  });
  return { url, unfilled };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** What one prepared build is holding open. */
const running = new Map();

export const httpAdapter = defineAdapter({
  name: 'http',
  title: 'Servers and APIs',
  describe:
    'Boots the server once on a port nobody else is on, with a restored fixture and a scratch copy of the project, then walks every route read out of the source and reports what came back and what the server quietly did while answering. Every outbound connection is recorded and refused, and a restore command that would destroy data is not run at all. Routes with a parameter nobody has given a sample value for are reported as needing one, never skipped silently.',
  channels: ['results', 'complaints', 'effects', 'counters'],

  /** @param {import('./contract.js').AdapterProject} project */
  async detect(project) {
    const config = project.config ?? {};
    /** @type {import('./contract.js').Missing[]} */
    const missing = [];

    let pkg = null;
    try { pkg = JSON.parse(await fsp.readFile(path.join(project.root, 'package.json'), 'utf8')); } catch { /* fine */ }
    const dependencies = { ...pkg?.dependencies, ...pkg?.devDependencies };
    const framework = ['express', 'fastify', 'hono', 'koa', 'next', 'polka', '@hapi/hapi']
      .find((name) => name in dependencies);

    const reading = await readContract({ root: project.root });
    const routes = [...reading.doors.filter((d) => d.kind === 'route'), ...(await readFileRoutes(project.root)).doors];

    if (!config.start) {
      missing.push({
        what: 'the command that starts the server',
        unlocks: 'everything — the routes can be listed from the source without it, but none of them can be walked',
        howToGet: pkg?.scripts?.start
          ? `This project has "npm start". Put {"start": "npm start"} under "http" in the config if that is the right one.`
          : 'Put {"start": "..."} under "http" in the config, and use the PORT environment variable it is given.',
        blocking: true,
      });
    }
    if (!config.restore) {
      missing.push({
        what: 'a way to put the data back how it was',
        unlocks: 'comparing two builds against the same rows — without it the two runs see whatever the first one left behind, and every difference after the first write is meaningless',
        howToGet: 'Put {"restore": "..."} under "http" in the config: a command that resets the database or the data folder to a known state. It must not be one that destroys data it cannot rebuild.',
      });
    }
    const withParams = routes.filter((r) => PARAM.test(r.name)).length;
    PARAM.lastIndex = 0;
    if (withParams > 0 && !config.samples) {
      missing.push({
        what: `sample values for the parameters in ${withParams} route${withParams === 1 ? '' : 's'}`,
        unlocks: `walking ${withParams === 1 ? 'that route' : 'those routes'} at all instead of reporting ${withParams === 1 ? 'it' : 'them'} as unchecked`,
        howToGet: 'Put {"samples": {"id": "1", "slug": "..."}} under "http" in the config — one real value per parameter name.',
      });
    }

    const applies = routes.length > 0 || Boolean(config.start) || Boolean(framework);
    return {
      applies,
      confidence: config.start ? (routes.length > 0 ? 1 : 0.6) : 0.3,
      why: applies
        ? `${routes.length} route${routes.length === 1 ? '' : 's'} ${routes.length === 1 ? 'was' : 'were'} read out of the source${framework ? `, and this project uses ${framework}` : ''}. ${config.start ? 'There is a command to start it.' : 'There is no command to start it yet, so nothing can be walked.'}`
        : 'No routes were found in the source and no web framework is installed, so this does not look like a server.',
      missing,
      notes: [
        'Routes come from reading the code, not from crawling — so a route nobody links to is checked like any other.',
        'The two builds are booted one after the other, never at the same time. Two servers on one machine fight over the port and the data, and that fight looks exactly like a regression.',
      ],
    };
  },

  /** @param {import('./contract.js').AdapterProject} project */
  async journeys(project) {
    const config = project.config ?? {};
    const samples = config.samples ?? {};
    const reading = await readContract({ root: project.root });
    const routes = [...reading.doors.filter((d) => d.kind === 'route'), ...(await readFileRoutes(project.root)).doors];

    /** @type {Map<string, import('./contract.js').Journey>} */
    const journeys = new Map();
    for (const route of routes) {
      const method = route.detail === 'MOUNT' || route.detail === 'ANY' ? 'GET' : route.detail;
      const { url, unfilled } = fillRoute(route.name, samples);
      const id = `${method} ${route.name}`;
      if (journeys.has(id)) continue;
      journeys.set(id, {
        name: id,
        describe: `ask the server for ${method} ${route.name}`,
        source: 'code',
        surface: 'server',
        from: route.file,
        channels: ['results', 'complaints', 'effects', 'counters'],
        // `door` and `doorDetail` are how the coverage ledger learns that this journey walked
        // that route. Without them a route counted as opened only if an observation happened to
        // land at its own address, and this adapter writes its observations under `api.<journey
        // name>` — so every route on every server read as never walked, on runs that had just
        // asked the server for all of them. The verb is part of it: GET /basket and POST
        // /basket are two doors.
        steps: [{ act: 'request', method, route: route.name, url, unfilled, door: route.name, kind: 'route', doorDetail: route.detail ?? method }],
        // A route that changes something is walked — against a restored fixture, that is
        // the whole point. Only a route the project itself marks as irreversible is held
        // back, and even then only when nothing is watching to refuse the effect.
        irreversible: (config.irreversible ?? []).includes(route.name),
      });
    }

    for (const extra of config.requests ?? []) {
      const { url, unfilled } = fillRoute(String(extra.url ?? extra.route), samples);
      const id = String(extra.name ?? `${extra.method ?? 'GET'} ${extra.url}`);
      journeys.set(id, {
        name: id,
        describe: String(extra.describe ?? extra.why ?? `ask the server for ${extra.method ?? 'GET'} ${extra.url}`),
        source: 'code',
        surface: 'server',
        from: 'the project config',
        channels: ['results', 'complaints', 'effects', 'counters'],
        // A request written by hand in the settings names its own route, so it opens the same
        // door the code reader found — as long as the url is the route's pattern rather than a
        // filled-in one, which is the shape the settings ask for.
        steps: [{ act: 'request', method: String(extra.method ?? 'GET'), route: String(extra.url), url, unfilled, headers: extra.headers, body: extra.body, door: String(extra.route ?? extra.url), kind: 'route', doorDetail: String(extra.method ?? 'GET') }],
        irreversible: extra.irreversible === true,
      });
    }

    return [...journeys.values()].sort((a, b) => a.name.localeCompare(b.name));
  },

  /**
   * @param {import('./contract.js').Build} build
   * @param {import('./contract.js').RunContext} ctx
   */
  async prepare(build, ctx) {
    const config = ctx.config ?? /** @type {any} */ (build).config ?? {};
    const base = path.join(ctx.scratchDir, `server-${build.id.slice(0, 12)}`);
    const work = path.join(base, 'work');
    const home = path.join(base, 'home');
    const tmp = path.join(base, 'tmp');
    await fsp.mkdir(home, { recursive: true });
    await fsp.mkdir(tmp, { recursive: true });

    /** @type {string[]} */
    const notes = [];
    const copy = await copyForScratch(build.root, work);
    if (!copy.copied) {
      return { build, root: work, ready: false, why: copy.why, dispose: async () => { await fsp.rm(base, { recursive: true, force: true }); } };
    }

    const port = await freePort();
    const reportFile = path.join(base, 'watch.jsonl');
    const watcher = path.join(base, 'watcher.mjs');
    await fsp.writeFile(watcher, watcherScript({ reportFile, allowLoopback: true }), 'utf8');

    const env = frozenEnvironment({
      clock: ctx.clock,
      seed: ctx.seed,
      home,
      tmp,
      extra: {
        PORT: String(port),
        HOST: '127.0.0.1',
        NODE_ENV: config.nodeEnv ?? 'production',
        ...config.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import file://${watcher.split(path.sep).join('/')}`.trim(),
      },
    });

    // Put the data back before booting, but never with a command that destroys something it
    // cannot rebuild. A refused restore does not stop the run; it makes every finding after
    // it suspect, and the run says exactly that.
    let restored = 'No restore command was given, so the server booted against whatever data was in the scratch copy.';
    if (config.restore) {
      const verdict = looksDestructive(String(config.restore));
      if (!verdict.safe) {
        restored = verdict.why;
        notes.push(verdict.why);
      } else {
        const result = await new Promise((resolve) => {
          const child = spawnServer(String(config.restore), { cwd: work, env });
          /** @type {Buffer[]} */
          const err = [];
          child.stderr?.on('data', (c) => err.push(c));
          child.on('error', (e) => resolve({ code: null, stderr: e.message }));
          child.on('close', (code) => resolve({ code, stderr: Buffer.concat(err).toString('utf8') }));
        });
        restored = result.code === 0
          ? 'The data was put back to a known state before booting.'
          : `The restore command failed, so the data is not in a known state: ${trimForStorage(result.stderr, 500).text}`;
        if (result.code !== 0) notes.push(restored);
      }
    }

    if (!config.start) {
      return {
        build, root: work, ready: false,
        why: 'There is no command to start the server, so nothing can be walked. The routes are still listed from the source.',
        dispose: async () => { await fsp.rm(base, { recursive: true, force: true }); },
      };
    }

    /** @type {Buffer[]} */
    const bootErr = [];
    /** @type {Buffer[]} */
    const bootOut = [];
    let exited = /** @type {string|null} */ (null);
    const child = spawnServer(String(config.start), { cwd: work, env });
    child.stdout?.on('data', (c) => bootOut.push(c));
    child.stderr?.on('data', (c) => bootErr.push(c));
    child.on('close', (code, signal) => {
      exited = `The server stopped before it answered — exit code ${code}${signal ? `, killed by ${signal}` : ''}.`;
    });

    // The same handover the web adapter makes, for the same reason and against the same
    // measurement of 2026-08-31: a wait that only knows a port number can only ever report a
    // port number, and "nothing answered on 64912" is not something a person can act on. With
    // the command and its output in hand, a server that ignored `$PORT` or came up on the
    // other loopback address is named in the first second or two instead of the sixtieth.
    const up = await waitForServer(port, {
      timeoutMs: config.startTimeoutMs ?? 60000,
      crashed: () => exited,
      command: String(config.start),
      announced: () => Buffer.concat([...bootOut, ...bootErr]).toString('utf8'),
      say: (message) => ctx.log?.(message),
    });

    if (!up.up) {
      await stopServer(child);
      return {
        build, root: work, ready: false,
        why: `${up.why} What it printed while trying: ${trimForStorage(Buffer.concat(bootErr).toString('utf8') || Buffer.concat(bootOut).toString('utf8'), 1500).text || '(nothing)'}`,
        dispose: async () => { await stopServer(child); await fsp.rm(base, { recursive: true, force: true }); },
      };
    }

    // Whether anything is watching from the inside is a fact, not a guess: the watcher
    // writes one line the moment it loads, so the file existing after boot is the proof. It
    // decides whether a route the project called irreversible may be walked at all.
    const watcherInForce = (await readWatcher(reportFile)).inForce;
    // The address that ANSWERED, kept so every route is asked for at the place the server
    // really is. A server that listened on `localhost` is on the IPv6 loopback on this Mac,
    // and every request sent to a hard-coded `127.0.0.1` would be refused by a machine that
    // is running the server perfectly well.
    const baseUrl = up.baseUrl ?? `http://127.0.0.1:${port}`;
    running.set(build.id, { base, work, home, tmp, port, baseUrl, reportFile, child, config, bootErr, watcherInForce });

    return {
      build,
      root: work,
      ready: true,
      why: `${copy.why} ${restored} It came up at ${baseUrl} in ${timeBucket(up.ms)}. ${watcherInForce ? 'Outbound connections are being watched and refused, so a route that calls a payment provider can be walked safely.' : 'Nothing is watching this server from the inside — it is not a Node program, or it replaced the environment it was started with — so routes that reach off this machine are left alone.'}${notes.length > 0 ? ` ${notes.join(' ')}` : ''}`,
      facts: { port, work, base: baseUrl },
      dispose: async () => {
        const held = running.get(build.id);
        running.delete(build.id);
        if (!held) return;
        // Only ever the process we started. Somebody else's server on this machine is
        // somebody else's business.
        await stopServer(held.child);
        await fsp.rm(base, { recursive: true, force: true });
      },
    };
  },

  /**
   * @param {import('./contract.js').Journey} journey
   * @param {import('./contract.js').PreparedBuild} build
   * @param {import('./contract.js').RunContext} ctx
   * @returns {Promise<import('./contract.js').Observation[]>}
   */
  async run(journey, build, ctx) {
    const held = running.get(build.build.id);
    if (!build.ready || !held) {
      return [notCovered({
        channel: 'results',
        path: joinPath('api', journey.name, 'answered at all'),
        reason: 'crashed',
        says: `"${journey.describe}" was not tried: ${build.why}`,
      })];
    }

    const detail = /** @type {RouteJourneyDetail} */ (/** @type {any} */ (journey.steps?.[0] ?? {}));

    if (detail.unfilled?.length > 0) {
      return [notCovered({
        channel: 'results',
        path: joinPath('api', journey.name, 'answered at all'),
        reason: 'needs a sample',
        says: `${detail.method} ${detail.route} was not tried, because nobody has said what ${detail.unfilled.map((p) => `"${p}"`).join(' and ')} should be. Put a real value under "http.samples" in the config and this route starts being checked.`,
      })];
    }

    // A route the project called irreversible is still WALKED, as long as the refusal
    // boundary is proven to be in force. That is the design: the ask is what gets compared —
    // same endpoint, same amount, same currency — and the connection carrying it never
    // completes. Skipping the route entirely would throw away the one observation that
    // matters. With nothing watching, though, there is no boundary, and it is left alone.
    if (journey.irreversible && !held.watcherInForce && ctx.allowIrreversible !== true) {
      return [notCovered({
        channel: 'effects',
        path: joinPath('api', journey.name, 'answered at all'),
        reason: 'irreversible',
        says: `${detail.method} ${detail.route} was left alone. The project marked it as spending money, sending a message or destroying data, and nothing is watching this server from the inside, so there is no way to stop it happening for real. This is a hole in what was checked, not a pass.`,
      })];
    }

    const watchFolders = held.config.watch ?? ['.'];
    const before = await snapshotForFolders(held.work, watchFolders);
    const watchedBefore = (await readWatcher(held.reportFile)).reachedOut.length;

    const started = Date.now();
    /** @type {Response|null} */
    let answer = null;
    /** @type {string} */
    let text = '';
    /** @type {string|null} */
    let failure = null;
    try {
      answer = await fetch(`${held.baseUrl ?? `http://127.0.0.1:${held.port}`}${detail.url}`, {
        method: detail.method,
        headers: { accept: '*/*', ...detail.headers },
        body: detail.body === undefined || detail.method === 'GET' || detail.method === 'HEAD'
          ? undefined
          : JSON.stringify(detail.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(journey.timeoutMs ?? 30000),
      });
      text = await answer.text();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const ms = Date.now() - started;

    const after = await snapshotForFolders(held.work, watchFolders);
    const watched = await readWatcher(held.reportFile);

    return describeRequest({
      journey, detail, answer, text, failure, ms,
      changes: compareTrees(before, after),
      reachedOut: watched.reachedOut.slice(watchedBefore),
      footprint: { dirs: [held.base, held.tmp, held.home], projectRoot: build.build.root, ports: [held.port] },
    });
  },

  async teardown() {
    for (const [, held] of running) {
      await stopServer(held.child);
    }
    running.clear();
  },
});

/**
 * @param {string} root
 * @param {string[]} folders
 */
async function snapshotForFolders(root, folders) {
  /** @type {Map<string,string>} */
  const all = new Map();
  for (const folder of folders) {
    const full = path.resolve(root, folder);
    for (const [file, mark] of await snapshotTree(full)) {
      all.set(path.join(path.relative(root, full), file), mark);
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Turning one request into observations
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {import('./contract.js').Journey} input.journey
 * @param {RouteJourneyDetail} input.detail
 * @param {Response|null} input.answer
 * @param {string} input.text
 * @param {string|null} input.failure
 * @param {number} input.ms
 * @param {import('./process.js').FileChange[]} input.changes
 * @param {Array<{host: string, port: number|null}>} input.reachedOut
 * @param {{dirs: string[], projectRoot?: string, ports?: number[]}} input.footprint
 * @returns {import('./contract.js').Observation[]}
 */
export function describeRequest(input) {
  const { journey, detail, answer, failure, ms, footprint } = input;
  const id = journey.name;
  /** @type {import('./contract.js').Observation[]} */
  const out = [];
  const asked = `${detail.method} ${detail.route}`;

  if (!answer) {
    out.push(observation({
      channel: 'complaints',
      path: joinPath('api', id, 'answered'),
      value: `no answer: ${failure}`,
      says: `${asked} gave no answer at all: ${failure}. A route that used to answer and now does not is the loudest kind of regression.`,
    }));
    return out;
  }

  out.push(observation({
    channel: 'results',
    path: joinPath('api', id, 'status'),
    value: answer.status,
    says: `${asked} answered ${answer.status}${answer.status >= 400 ? ', which is a refusal' : ''}.`,
  }));

  const headers = headersThatMatter(answer.headers);
  for (const [name, value] of Object.entries(headers)) {
    out.push(observation({
      channel: 'results',
      path: joinPath('api', id, 'header', name),
      value: undoOurFootprint(Array.isArray(value) ? value.join(', ') : value, footprint),
      says: `${asked} answered with ${name}: ${Array.isArray(value) ? value.join(', ') : value}.`,
    }));
  }

  const body = readBody(answer.headers.get('content-type') ?? '', undoOurFootprint(input.text, footprint));
  out.push(observation({
    channel: 'results',
    path: joinPath('api', id, 'body'),
    value: body.value,
    says: body.truncated
      ? `What ${asked} sent back, with the middle left out — the whole of it is ${sizeBucket(body.bytes)}.`
      : `What ${asked} sent back.`,
  }));
  if (body.shape !== undefined) {
    out.push(observation({
      channel: 'results',
      path: joinPath('api', id, 'shape'),
      value: body.shape,
      says: `The fields ${asked} sends back and what type each one is. This stays the same while the values change, so a renamed or dropped field shows up on its own instead of buried in a diff of the whole body.`,
    }));
  }

  for (const change of input.changes) {
    out.push(observation({
      channel: 'effects',
      path: joinPath('file', id, change.file),
      value: change.what === 'deleted' ? 'deleted' : { what: change.what, contents: change.now ?? '' },
      says: change.what === 'deleted'
        ? `Answering ${asked} deleted ${change.file}.`
        : `Answering ${asked} ${change.what} ${change.file}. A route that still answers correctly but has stopped writing this file is broken, and only this line sees it.`,
    }));
  }

  /** @type {Map<string, number>} */
  const hosts = new Map();
  for (const attempt of input.reachedOut) {
    const key = attempt.port ? `${attempt.host}:${attempt.port}` : attempt.host;
    hosts.set(key, (hosts.get(key) ?? 0) + 1);
  }
  for (const [host, times] of [...hosts].sort()) {
    out.push(observation({
      channel: 'effects',
      path: joinPath('net', id, host),
      value: `tried ${times} time${times === 1 ? '' : 's'}, refused every time`,
      says: `While answering ${asked} the server tried to call ${host} and was refused. That it asked, and what it asked for, are compared; what would have come back is not, because it was never allowed to happen.`,
      covered: false,
      reason: 'irreversible',
    }));
  }

  out.push(howLongItTook({
    channel: 'counters',
    path: joinPath('count', id, 'duration'),
    ms,
    what: asked,
    journey: id,
  }));

  return out;
}
