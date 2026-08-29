/**
 * Cutting the page off from the internet.
 *
 * This is the single biggest reason a picture stays the same tomorrow. A page that fetches
 * an avatar from a CDN, a font from a third party, an analytics beacon or a live feed is a
 * page whose picture depends on somebody else's server, today's weather in their data
 * centre, and the office wifi. Block all of it and the picture only depends on your code.
 *
 * Three modes:
 *   live           - let everything through (still counted, so --verbose can show it)
 *   block-external - only the app's own origin, localhost and an allow list get out
 *   replay         - record every reply once, then serve those same bytes forever
 *
 * Every paused request gets exactly one answer — continue, fail or fulfil. A request that
 * is paused and never answered stalls the page silently, which looks like a hung app.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../core/hash.js';
import { safeName } from '../core/paths.js';
import { StaysFixedError } from '../core/errors.js';
import { detail } from '../core/log.js';

/**
 * @typedef {object} Fixture
 * @property {string} url
 * @property {string} method
 * @property {number} status
 * @property {Record<string,string>} headers
 * @property {string} bodyBase64
 */

/**
 * Headers we never replay. The body we recorded was handed to us already decoded and
 * already whole, so telling the browser it is gzipped or 4021 bytes long makes it throw
 * the reply away — and a "replayed" run then shows a blank page for no visible reason.
 */
const SKIP_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

const MAX_BLOCKED_LISTED = 20;

/** @type {Map<string, RegExp>} */
const globCache = new Map();

/**
 * A tiny glob: `*` stops at a path separator, `**` crosses them, everything else is
 * matched literally. Small enough to read, which matters more here than being complete.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  const re = new RegExp('^' + out + '$');
  globCache.set(glob, re);
  return re;
}

/**
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
function originOf(url) {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Is this request allowed out in `block-external` mode?
 *
 * @param {string} url
 * @param {string|null} ownOrigin
 * @param {RegExp[]} allow
 * @returns {boolean}
 */
function isAllowed(url, ownOrigin, allow) {
  if (!url) return true;
  const lower = url.toLowerCase();
  // Already local by definition — the bytes are in the page or on this disk.
  if (
    lower.startsWith('data:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('file:') ||
    lower.startsWith('about:') ||
    lower.startsWith('chrome-extension:')
  ) {
    return true;
  }

  let u = null;
  try {
    u = new URL(url);
  } catch {
    // Not something we can reason about. Letting it through is the safer mistake:
    // blocking a URL we failed to parse would break apps for no benefit.
    return true;
  }

  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    host === '::1'
  ) {
    return true;
  }

  if (ownOrigin && u.origin === ownOrigin) return true;

  // Match the whole URL and the bare host, so both 'https://cdn.example.com/**' and
  // '*.example.com' do what a person expects when they write them.
  for (const re of allow) {
    if (re.test(url) || re.test(host)) return true;
  }
  return false;
}

/**
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function hasFixtures(dir) {
  try {
    const files = await fsp.readdir(dir);
    return files.some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @param {Map<string, Fixture>} into
 * @returns {Promise<void>}
 */
async function loadFixtures(dir, into) {
  /** @type {string[]} */
  let files = [];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await fsp.readFile(path.join(dir, f), 'utf8');
      into.set(f.slice(0, -5), /** @type {Fixture} */ (JSON.parse(raw)));
    } catch {
      // A half-written fixture from a killed run. Treat it as missing.
    }
  }
}

/**
 * Put network interception in place. Must be called before the app navigates, or the very
 * first page load pulls in exactly the things we are trying to keep out.
 *
 * @param {import('../types.js').PageHandle} page
 * @param {{mode?: 'live'|'block-external'|'replay', allow?: string[], fixturesDir?: string, screenName?: string, record?: boolean}} opts
 * @returns {Promise<{release: () => Promise<void>, stats: () => import('../types.js').FreezeStats}>}
 */
export async function installNetwork(page, opts) {
  const mode = opts.mode ?? 'block-external';
  const allow = (opts.allow ?? []).map(globToRegExp);
  const ownOrigin = originOf(page.baseUrl);

  /** @type {import('../types.js').FreezeStats} */
  const counts = {
    requestsAllowed: 0,
    requestsBlocked: 0,
    requestsReplayed: 0,
    requestsRecorded: 0,
    blockedUrls: [],
  };
  /** @type {Set<string>} */
  const blockedOrigins = new Set();

  /** @type {string|null} */
  let screenDir = null;
  /** @type {Map<string, Fixture>} */
  const fixtures = new Map();
  let recording = false;

  if (mode === 'replay') {
    if (!opts.fixturesDir || !opts.screenName) {
      throw new StaysFixedError('Replay mode needs to know which screen it is recording for.', {
        hint: 'This is a wiring problem inside Stays Fixed, not something in your config.',
      });
    }
    screenDir = path.join(opts.fixturesDir, safeName(opts.screenName));
    if (opts.record === true) {
      // Re-recording keeps nothing: a leftover reply for a URL the app no longer asks for
      // would sit in the folder forever, and nobody would ever know it was stale.
      await fsp.rm(screenDir, { recursive: true, force: true });
      recording = true;
    } else {
      recording = !(await hasFixtures(screenDir));
      if (!recording) await loadFixtures(screenDir, fixtures);
    }
    detail('network: replay', recording ? '(recording this run)' : `(${fixtures.size} saved replies)`);
  }

  /** One decision per pause, ever. Keyed by stage as well as id, because a single request
   * can legitimately pause twice: once on the way out, once on the way back. */
  /** @type {Set<string>} */
  const decided = new Set();
  /** Requests paused right now and not yet answered. @type {Set<string>} */
  const paused = new Set();
  /** Requests we let out purely so we could record the reply. @type {Map<string, {url: string, method: string, key: string}>} */
  const awaitingBody = new Map();
  let closed = false;

  /**
   * @param {string} url
   */
  function noteBlocked(url) {
    const origin = originOf(url) ?? url;
    if (blockedOrigins.has(origin)) return;
    blockedOrigins.add(origin);
    if (counts.blockedUrls.length < MAX_BLOCKED_LISTED) counts.blockedUrls.push(origin);
  }

  /**
   * @param {string} id
   * @param {boolean} [interceptResponse]
   */
  async function letThrough(id, interceptResponse = false) {
    try {
      await page.send(
        'Fetch.continueRequest',
        interceptResponse ? { requestId: id, interceptResponse: true } : { requestId: id }
      );
    } catch {
      // The tab navigated away and took the request with it.
    }
  }

  /** @param {string} id */
  async function letResponseThrough(id) {
    try {
      await page.send('Fetch.continueResponse', { requestId: id });
    } catch {
      try {
        await page.send('Fetch.continueRequest', { requestId: id });
      } catch {
        // Gone. Nothing left to answer.
      }
    }
  }

  /** @param {string} id */
  async function refuse(id) {
    try {
      await page.send('Fetch.failRequest', { requestId: id, errorReason: 'BlockedByClient' });
    } catch {
      // Same as above.
    }
  }

  /**
   * @param {string} id
   * @param {Fixture} fx
   */
  async function serveRecorded(id, fx) {
    const responseHeaders = Object.entries(fx.headers ?? {})
      .filter(([name]) => !SKIP_HEADERS.has(name.toLowerCase()))
      .map(([name, value]) => ({ name, value: String(value) }));
    try {
      await page.send('Fetch.fulfillRequest', {
        requestId: id,
        responseCode: fx.status || 200,
        responseHeaders,
        body: fx.bodyBase64 ?? '',
      });
    } catch {
      await refuse(id);
    }
  }

  /** @param {any} ev */
  async function onRequestStage(ev) {
    const id = String(ev.requestId);
    const url = String(ev.request?.url ?? '');
    const method = String(ev.request?.method ?? 'GET');

    if (mode === 'live') {
      counts.requestsAllowed += 1;
      await letThrough(id);
      return;
    }

    if (mode === 'replay') {
      const key = sha256(`${method} ${url}`);
      if (!recording) {
        const fx = fixtures.get(key);
        if (fx) {
          counts.requestsReplayed += 1;
          await serveRecorded(id, fx);
          return;
        }
        // Nothing recorded for this one. Failing is the honest answer: quietly going to
        // the real network would put the picture back at the internet's mercy.
        noteBlocked(url);
        counts.requestsBlocked += 1;
        await refuse(id);
        return;
      }
      awaitingBody.set(id, { url, method, key });
      counts.requestsAllowed += 1;
      await letThrough(id, true);
      return;
    }

    if (isAllowed(url, ownOrigin, allow)) {
      counts.requestsAllowed += 1;
      await letThrough(id);
      return;
    }
    noteBlocked(url);
    counts.requestsBlocked += 1;
    await refuse(id);
  }

  /** @param {any} ev */
  async function onResponseStage(ev) {
    const id = String(ev.requestId);
    const info = awaitingBody.get(id);
    awaitingBody.delete(id);

    if (info && screenDir) {
      try {
        const body = await page.send('Fetch.getResponseBody', { requestId: id });
        const bodyBase64 = body?.base64Encoded
          ? String(body.body ?? '')
          : Buffer.from(String(body?.body ?? ''), 'utf8').toString('base64');
        /** @type {Record<string,string>} */
        const headers = {};
        for (const h of ev.responseHeaders ?? []) {
          headers[String(h.name).toLowerCase()] = String(h.value);
        }
        /** @type {Fixture} */
        const fx = {
          url: info.url,
          method: info.method,
          status: Number(ev.responseStatusCode ?? 200),
          headers,
          bodyBase64,
        };
        await fsp.mkdir(screenDir, { recursive: true });
        await fsp.writeFile(path.join(screenDir, `${info.key}.json`), JSON.stringify(fx, null, 2));
        fixtures.set(info.key, fx);
        counts.requestsRecorded += 1;
      } catch {
        // Some replies have no readable body (a redirect, a 204, a stream the browser
        // already consumed). Not recording it is better than failing the run.
      }
    }

    await letResponseThrough(id);
  }

  /** @param {any} ev */
  async function handle(ev) {
    if (closed) return;
    const id = ev?.requestId ? String(ev.requestId) : '';
    if (!id) return;
    // The response stage is the one that carries a status or an error reason.
    const isResponse = ev.responseStatusCode !== undefined || ev.responseErrorReason !== undefined;
    const key = `${isResponse ? 'res' : 'req'}:${id}`;
    if (decided.has(key)) return;
    decided.add(key);
    paused.add(id);
    try {
      if (isResponse) await onResponseStage(ev);
      else await onRequestStage(ev);
    } catch (e) {
      detail('network: could not answer a paused request —', e instanceof Error ? e.message : String(e));
      await letThrough(id);
    } finally {
      paused.delete(id);
    }
  }

  const off = page.on('Fetch.requestPaused', (params) => {
    void handle(params);
  });

  try {
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  } catch (cause) {
    off();
    throw new StaysFixedError('This app would not let me watch its network requests.', {
      hint: "Set freeze.network to 'live' in your config to run without network control.",
      cause,
    });
  }

  return {
    async release() {
      closed = true;
      off();
      // Answer anything still hanging before turning interception off. Fetch.disable does
      // release paused requests, but a request that was paused and then abandoned can
      // stall the next navigation, and that looks exactly like a hung app.
      for (const id of Array.from(paused)) {
        await letThrough(id);
      }
      paused.clear();
      try {
        await page.send('Fetch.disable');
      } catch {
        // Target already gone.
      }
    },
    stats() {
      return {
        requestsAllowed: counts.requestsAllowed,
        requestsBlocked: counts.requestsBlocked,
        requestsReplayed: counts.requestsReplayed,
        requestsRecorded: counts.requestsRecorded,
        blockedUrls: [...counts.blockedUrls],
      };
    },
  };
}
