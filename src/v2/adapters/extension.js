/**
 * Browser extensions.
 *
 * An extension is a real product — people ship them, sell them, and break them the same way
 * everything else breaks — and until now this tool had no home for one. It needed almost no
 * new machinery. The web lane already starts a browser of its own with a throwaway profile;
 * an extension is loaded into exactly that browser with two command line flags, and from
 * then on its pages are ordinary pages the existing web machinery can read.
 *
 * An extension is four different things wearing one coat, and each one is a different
 * question. This lane answers three of them properly and says out loud where the fourth
 * stops:
 *
 *   THE MANIFEST      Its permissions, the sites it may touch, the pages it declares. This
 *                     is a CONTRACT with the person who installed it. A permission that
 *                     quietly appears, or a host permission that widens from one named site
 *                     to every site on the internet, is exactly the kind of change somebody
 *                     must be told about — and reading it costs nothing and runs nothing, so
 *                     it works on any machine with or without a browser.
 *   THE POPUP AND     Ordinary web pages at a `chrome-extension://.../...` address. Opened,
 *   THE OPTIONS PAGE  frozen and read for what the screen MEANS, exactly like any other page.
 *   THE CONTENT       What the extension DOES to somebody else's page. The only honest way
 *   SCRIPT            to watch that is to open the same page twice — once with the extension
 *                     loaded and once without — and record the DIFFERENCE. That difference
 *                     is the product. It is also the one thing that goes silently missing:
 *                     a content script that stopped firing leaves a page that looks entirely
 *                     normal, because it IS the normal page.
 *   THE BACKGROUND    What it asks the network for, and what it stores. Both are covered.
 *   WORKER            What it LOGS is not — see `theBackgroundWorker` for the measurement
 *                     that says why, in one sentence, on every single run.
 *
 * WHAT IT REFUSES TO GUESS. Every address a content script is tried against is served from
 * this machine, so nothing this lane does ever reaches the internet. When a project has not
 * said what the real page looks like, the page served is a blank stand-in at the address the
 * manifest itself names — enough to answer "did the content script fire at all", which is
 * the break that actually happens, and not enough to answer "did it put the banner in the
 * right place", which is said in as many words on every observation it produces.
 *
 * THE EXTENSION ID IS NOT A FACT ABOUT THE PRODUCT. Chrome makes the id of an unpacked
 * extension out of the folder it was loaded from, so the two builds of one comparison — which
 * live in two different scratch folders — get two different ids. Measured on 2026-08-31: the
 * same folder gives the same id every time, a copy of it somewhere else gives a different
 * one. So the id is never an address and never a value here; it is taken out of every line of
 * text before anything is written down. Leaving it in would report a difference on every run,
 * which is the fastest way to get a tool switched off.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  countBucket, defineAdapter, howLongItTook, joinPath, notCovered, observation, sizeBucket,
  timeBucket, trimForStorage, undoOurFootprint,
} from './contract.js';
import { copyForScratch, frozenEnvironment } from './process.js';
import { spawnServer, stopServer } from './child.js';
import { applyFreeze, prepareForShutter } from '../../freeze/index.js';
import { settle } from '../../freeze/settle.js';
import {
  countRoles, flattenAria, inkOf, loadPlaywright, openWindow, parseAria, short,
  typesIn, whereItIs, wirePattern, withLimit,
} from './web-driver.js';

/** @typedef {import('./contract.js').Journey} Journey */
/** @typedef {import('./contract.js').Observation} Observation */
/** @typedef {import('./contract.js').Missing} Missing */
/** @typedef {import('./web-driver.js').MeaningEntry} MeaningEntry */

/** How big the window is, unless a project says otherwise. */
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };

/**
 * Where a manifest lives, in the order worth looking.
 *
 * The root first, because an extension nobody bundles keeps it there. Then the folders a
 * bundler writes into, because the manifest that MATTERS is the one in the thing that
 * actually gets loaded — a source manifest that a build step rewrites is a description of
 * the product, not the product.
 */
const MANIFEST_SPOTS = ['dist', 'build', 'out', 'extension', 'unpacked', 'public', 'src', 'app', 'chrome', 'addon'];

// ---------------------------------------------------------------------------
// Reading a manifest — everything here is pure, so it can be tested without a browser
// ---------------------------------------------------------------------------

/**
 * Find the extension inside a project.
 *
 * @param {string} root
 * @param {string} [told]  A folder the project named, relative to the root or absolute.
 * @returns {{dir: string|null, file: string|null, why: string}}
 */
export function findExtension(root, told) {
  if (told) {
    const dir = path.isAbsolute(told) ? told : path.join(root, told);
    const file = path.join(dir, 'manifest.json');
    if (fs.existsSync(file)) return { dir, file, why: `The settings point at ${told}, and there is a manifest.json in it.` };
    return { dir: null, file: null, why: `The settings point at ${told}, and there is no manifest.json in it. Nothing here can be loaded as an extension until there is.` };
  }

  /** @type {{dir: string, file: string, where: string}[]} */
  const candidates = [{ dir: root, file: path.join(root, 'manifest.json'), where: 'the project folder itself' }];
  for (const spot of MANIFEST_SPOTS) {
    candidates.push({ dir: path.join(root, spot), file: path.join(root, spot, 'manifest.json'), where: `${spot}/` });
  }

  const there = candidates.filter((c) => fs.existsSync(c.file));
  const readable = there.find((c) => looksLikeAnExtension(c.file));
  if (readable) return { dir: readable.dir, file: readable.file, why: `There is a manifest.json in ${readable.where}.` };

  // A MANIFEST THAT IS THERE AND BROKEN IS NOT A MISSING MANIFEST. Measured on 2026-08-31:
  // an extension whose manifest.json had been truncated to half a line was reported as
  // "there is no manifest.json anywhere this looks" — which is false, and sends whoever reads
  // it looking for a folder rather than at the one broken line that is actually the problem.
  // So a manifest that exists is handed back even when nothing can be read out of it, and the
  // caller says exactly what is wrong with it.
  if (there.length > 0) {
    return { dir: there[0].dir, file: there[0].file, why: `There is a manifest.json in ${there[0].where}, and nothing could be read out of it.` };
  }
  return { dir: null, file: null, why: 'There is no manifest.json anywhere this looks, so there is nothing here to load as a browser extension.' };
}

/**
 * Is this manifest.json a BROWSER EXTENSION's manifest?
 *
 * `manifest.json` is one of the most reused file names there is: a web app manifest, a
 * Chrome app, a Firefox theme and half a dozen build tools all write one. Claiming a web
 * app's manifest as an extension would hand every journey to an adapter that cannot walk
 * it — and a journey nothing walked, reported as covered, is the one failure this tool
 * exists to prevent. So the test is the one field an extension always has and a web app
 * manifest never does.
 *
 * @param {string} file
 * @returns {boolean}
 */
function looksLikeAnExtension(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed?.manifest_version === 'number';
  } catch {
    // Unreadable or not JSON. `readManifest` says so properly; here it is simply not proof
    // that this is an extension, so the search carries on looking for one that is.
    return false;
  }
}

/**
 * Read a manifest, and say what is wrong with it in words somebody can act on.
 *
 * @param {string} text
 * @returns {{ok: true, manifest: Record<string, any>} | {ok: false, why: string}}
 */
export function readManifest(text) {
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    return { ok: false, why: `The manifest is not valid JSON, so the browser will refuse to load this extension at all: ${said}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, why: 'The manifest is valid JSON but is not an object, so there is nothing in it a browser could read.' };
  }
  if (typeof parsed.manifest_version !== 'number') {
    return { ok: false, why: 'The manifest has no "manifest_version" in it. Every browser refuses an extension without one, so nothing here would load.' };
  }
  return { ok: true, manifest: parsed };
}

/**
 * Chrome's own id for an extension loaded from a folder.
 *
 * Not a guess: this is the documented rule, and it is checked against the real thing on
 * every run that has a background worker to ask. Chrome hashes the ABSOLUTE path of the
 * folder with SHA-256, takes the first sixteen bytes, and turns each half-byte into a letter
 * by adding it to 'a'. Which is why the id changes when the folder does.
 *
 * It matters because an extension with no background worker has no running thing to ask, and
 * without an id there is no address at which to open its popup. Measured on 2026-08-31: an
 * extension with nothing but a popup and a content script has no service worker at all, and
 * the popup opened at the predicted address first time.
 *
 * The REAL path is hashed, not the one we were handed. On a Mac `/tmp` is a link to
 * `/private/tmp` and Chrome resolves it before hashing; hashing the unresolved path gave an
 * id that was wrong in exactly the case a scratch folder is used, which is every run.
 *
 * @param {string} dir
 * @returns {string}
 */
export function idForUnpacked(dir) {
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {
    // Not there yet, or not readable. The unresolved path is the best answer available and
    // the run checks the id against the browser anyway before trusting it.
  }
  const bytes = process.platform === 'win32' ? Buffer.from(real, 'utf16le') : Buffer.from(real, 'utf8');
  const hex = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/**
 * What each permission actually lets an extension do, in plain English.
 *
 * The names are for programmers and several of them are alarming in ways the word does not
 * show: "management" is the power to switch your other extensions off, "debugger" is the
 * power to read and change any page you have open. The whole point of watching the manifest
 * is that a person can be told what changed, so the report says what the word means.
 *
 * @type {Record<string, string>}
 */
export const WHAT_A_PERMISSION_ALLOWS = Object.freeze({
  activeTab: 'read and change the tab you are looking at, but only after you click the extension',
  alarms: 'wake itself up on a timer',
  bookmarks: 'read and change your bookmarks',
  browsingData: 'delete your browsing history, cookies and cached files',
  clipboardRead: 'read whatever you have copied',
  clipboardWrite: 'put things on your clipboard',
  contextMenus: 'add items to the right-click menu',
  cookies: 'read and change the cookies that keep you signed in to sites',
  debugger: 'attach to any page as a debugger, which is total control of everything you have open',
  declarativeNetRequest: 'block and rewrite requests as pages load',
  downloads: 'start downloads and read what you have downloaded',
  geolocation: 'ask for where you are',
  history: 'read and change your browsing history',
  identity: 'sign you in to an account on its own behalf',
  management: 'see, switch off and uninstall your other extensions',
  nativeMessaging: 'talk to a program installed on this computer, outside the browser',
  notifications: 'show desktop notifications',
  privacy: 'change your browser privacy settings',
  proxy: 'route everything you browse through a server of its choosing',
  scripting: 'run its own code inside other people\'s pages',
  storage: 'keep its own data in the browser',
  tabs: 'read the address and title of every tab you have open',
  topSites: 'read the sites you visit most',
  unlimitedStorage: 'store as much as it likes',
  webNavigation: 'watch every page you go to',
  webRequest: 'watch every request the browser makes',
  webRequestBlocking: 'stop or change requests before they go out',
});

/**
 * How wide the reach of a list of host patterns is, as one plain sentence.
 *
 * This is the headline the whole manifest check exists for. Somebody reading a report will
 * not spot that `https://mail.example.com/*` became `<all_urls>` in a list of forty lines,
 * and that single change is the difference between an extension that reads one site and one
 * that reads their bank. So the width is written down as a fact of its own, in words, and a
 * change to it is a change to one short line at the top rather than a change buried in a list.
 *
 * @param {string[]} patterns
 * @returns {{value: string, says: string}}
 */
export function howWideTheReachIs(patterns) {
  // THE STAR HAS TO BE THE WHOLE HOST. Written as `https://*` followed by anything, this
  // matched `https://*.github.com/*` — a wildcard SUBDOMAIN of one named site — and reported
  // an extension that reaches one site as one that reaches every site on the internet. Caught
  // on 2026-08-31 by the test that asks about a subdomain wildcard. A false alarm on the
  // loudest line in the whole report is the fastest way to get this tool switched off.
  const all = patterns.filter((p) => p === '<all_urls>' || /^(\*|https?|file|ftp):\/\/\*(\/|$)/.test(p));
  if (all.length > 0) {
    return {
      value: 'every site',
      says: `This extension asks to reach EVERY site, through ${all.map((p) => `"${p}"`).join(' and ')}. That is the widest thing an extension can ask for: every page you open, including your bank and your email, is one it may read and change.`,
    };
  }
  /** @type {Set<string>} */
  const hosts = new Set();
  for (const pattern of patterns) {
    const host = hostOfPattern(pattern);
    if (host) hosts.add(host);
  }
  if (hosts.size === 0) return { value: 'no sites', says: 'This extension asks to reach no sites of its own. It can only touch a page after you click it, if it can touch one at all.' };
  const named = [...hosts].sort();
  return {
    value: named.length === 1 ? 'one named site' : `${named.length} named sites`,
    says: `This extension asks to reach ${named.length === 1 ? 'one site' : `${named.length} sites`}: ${named.join(', ')}. Nothing else. If this ever says "every site", something has widened and somebody should be told before it ships.`,
  };
}

/**
 * The host out of a match pattern, or null when the pattern names every host.
 *
 * @param {string} pattern
 * @returns {string|null}
 */
function hostOfPattern(pattern) {
  const text = String(pattern);
  if (text === '<all_urls>') return null;
  const match = /^[^:]+:\/\/([^/]*)/.exec(text);
  if (!match) return null;
  const host = match[1];
  if (host === '' || host === '*') return null;
  return host.startsWith('*.') ? host.slice(2) : host;
}

/**
 * Every page the extension declares, whichever manifest version it is written in.
 *
 * Both spellings are read on purpose. Manifest v2 is still what a great many published
 * extensions are written in, and an adapter that only understood v3 would quietly find no
 * pages at all in one — which reads exactly like an extension with no pages.
 *
 * @param {Record<string, any>} manifest
 * @returns {{what: string, file: string}[]}
 */
export function declaredPages(manifest) {
  /** @type {{what: string, file: string}[]} */
  const pages = [];
  /** @param {string} what @param {unknown} file */
  const add = (what, file) => {
    if (typeof file !== 'string' || file.trim() === '') return;
    const clean = file.replace(/^\.?\//, '').split('#')[0].split('?')[0];
    if (!/\.html?$/i.test(clean)) return;
    if (pages.some((p) => p.file === clean)) return;
    pages.push({ what, file: clean });
  };

  add('the popup', manifest.action?.default_popup);
  add('the popup', manifest.browser_action?.default_popup);
  add('the popup', manifest.page_action?.default_popup);
  add('the options page', typeof manifest.options_ui?.page === 'string' ? manifest.options_ui.page : undefined);
  add('the options page', manifest.options_page);
  add('the side panel', manifest.side_panel?.default_path);
  add('the sidebar', manifest.sidebar_action?.default_panel);
  add('the developer-tools page', manifest.devtools_page);
  for (const [what, file] of Object.entries(manifest.chrome_url_overrides ?? {})) {
    add(`the page it puts in place of ${what}`, file);
  }
  add('the background page', manifest.background?.page);
  return pages;
}

/**
 * An address to try one content script against, worked out from what it says it runs on.
 *
 * The address is never visited for real — it is served from this machine — so what matters
 * is only that it MATCHES the pattern the manifest wrote, because matching is the whole
 * question. A pattern that names every site gets a stand-in address, and says so.
 *
 * @param {string} pattern
 * @returns {{url: string, exact: boolean, why: string} | {url: null, why: string}}
 */
export function addressForMatch(pattern) {
  const text = String(pattern ?? '').trim();
  if (text === '') return { url: null, why: 'the pattern is empty' };
  if (text.startsWith('file://')) {
    return { url: null, why: 'it runs on files on your own disk, and a browser only lets an extension do that after somebody ticks a box by hand, so it cannot be checked here' };
  }
  if (text === '<all_urls>' || text === '*://*/*' || /^(\*|https?):\/\/\*\/?\*?$/.test(text)) {
    return { url: 'https://example.com/', exact: false, why: 'this content script says it runs on EVERY site, so one stand-in address is used to represent all of them' };
  }
  const parts = /^([^:]+):\/\/([^/]+)(\/.*)?$/.exec(text);
  if (!parts) return { url: null, why: `"${text}" is not a match pattern this understands` };
  const scheme = parts[1] === '*' ? 'https' : parts[1];
  if (scheme !== 'http' && scheme !== 'https') return { url: null, why: `it runs on "${scheme}" addresses, which are not pages a browser can be sent to here` };
  const host = parts[2].startsWith('*.') ? parts[2].slice(2) : parts[2];
  if (host === '*' || host === '') return { url: 'https://example.com/', exact: false, why: 'this content script says it runs on every host, so one stand-in address is used to represent all of them' };
  const where = (parts[3] ?? '/').replace(/\*+$/, '');
  return { url: `${scheme}://${host}${where.startsWith('/') ? where : `/${where}`}`, exact: true, why: `this is the address the manifest itself names in "${text}"` };
}

/**
 * One address per content script, with the reason it was chosen.
 *
 * One per SCRIPT rather than one per pattern: a script listing twelve subdomains is one
 * behaviour, and twelve near-identical journeys would triple the length of the report while
 * saying the same thing twelve times. The other patterns are still written down in the
 * manifest contract, where a change to any of them shows up.
 *
 * @param {Record<string, any>} manifest
 * @returns {{url: string|null, pattern: string, exact: boolean, why: string, files: string[]}[]}
 */
export function contentScriptTargets(manifest) {
  /** @type {{url: string|null, pattern: string, exact: boolean, why: string, files: string[]}[]} */
  const out = [];
  /** @type {Set<string>} */
  const already = new Set();
  for (const script of manifest.content_scripts ?? []) {
    const patterns = /** @type {string[]} */ (Array.isArray(script?.matches) ? script.matches : []);
    const files = [...(script?.js ?? []), ...(script?.css ?? [])].map((f) => String(f));
    /** @type {{url: string|null, pattern: string, exact: boolean, why: string, files: string[]}|null} */
    let best = null;
    for (const pattern of patterns) {
      const tried = addressForMatch(pattern);
      const entry = { url: tried.url, pattern, exact: 'exact' in tried ? tried.exact : false, why: tried.why, files };
      if (entry.url && entry.exact) { best = entry; break; }
      if (!best || (entry.url && !best.url)) best = entry;
    }
    if (!best) {
      out.push({ url: null, pattern: '(none)', exact: false, why: 'this content script does not say which pages it runs on, so there is no page to try it against', files });
      continue;
    }
    const key = best.url ?? `no address:${best.pattern}`;
    if (already.has(key)) continue;
    already.add(key);
    out.push(best);
  }
  return out;
}

/**
 * The manifest as flat facts, one address each.
 *
 * One address per permission rather than one list, because a list compares as one value: add
 * a permission and the whole list reads as changed, with the new one somewhere inside it.
 * One address each means a permission that appeared is a NEW address — which is how this
 * tool says "somebody added this" rather than "this list is different now".
 *
 * @param {Record<string, any>} manifest
 * @returns {{path: string[], value: any, says: string}[]}
 */
export function manifestContract(manifest) {
  /** @type {{path: string[], value: any, says: string}[]} */
  const facts = [];
  /** @param {string[]} at @param {any} value @param {string} says */
  const fact = (at, value, says) => facts.push({ path: at, value, says });

  fact(['what it is called'], String(manifest.name ?? ''), `The extension is called "${manifest.name ?? ''}". This is the name in the browser's own list of what is installed, so a change to it is a change somebody will see.`);
  fact(['which manifest it is written in'], Number(manifest.manifest_version), `It is written in manifest version ${manifest.manifest_version}. Going from 2 to 3 changes what the extension is allowed to do, so it is never a quiet change.`);
  if (typeof manifest.description === 'string') {
    fact(['what it says it does'], manifest.description, `Its description reads: "${short(manifest.description, 120)}". This is what somebody sees in the store, and it is compared as written.`);
  }
  // The version NUMBER is left out and its SHAPE kept instead. Every release changes the
  // version, so comparing it would report a difference on every single release — a tool that
  // is loudest on the days when nothing is wrong gets switched off. The shape still catches
  // the real break, which is a version that stopped being a version at all.
  fact(['the shape of its version'], shapeOfAVersion(String(manifest.version ?? '')), `Its version is written as ${shapeOfAVersion(String(manifest.version ?? ''))}. The number itself is deliberately not compared — it changes on every release, and a check that complains every release is a check nobody reads.`);

  const permissions = [...(manifest.permissions ?? [])].map(String).sort();
  for (const permission of permissions) {
    const means = WHAT_A_PERMISSION_ALLOWS[permission];
    fact(['what it is allowed to do', permission], true, means
      ? `It asks for "${permission}", which lets it ${means}.`
      : `It asks for the "${permission}" permission.`);
  }
  fact(['how many things it is allowed to do'], permissions.length, `It asks for ${permissions.length} permission${permissions.length === 1 ? '' : 's'}. Counted as well as listed, because the count is the line a person reads first.`);

  const optional = [...(manifest.optional_permissions ?? [])].map(String).sort();
  for (const permission of optional) {
    const means = WHAT_A_PERMISSION_ALLOWS[permission];
    fact(['what it may ask you for later', permission], true, means
      ? `It may ask you for "${permission}" later, which would let it ${means}.`
      : `It may ask you for the "${permission}" permission later.`);
  }

  const hosts = [...(manifest.host_permissions ?? []), ...(manifest.manifest_version === 2 ? (manifest.permissions ?? []).filter((/** @type {unknown} */ p) => /:\/\//.test(String(p)) || p === '<all_urls>') : [])].map(String).sort();
  for (const host of hosts) {
    fact(['which sites it may touch', host], true, `It asks to reach "${host}".`);
  }
  const reach = howWideTheReachIs(hosts);
  fact(['how wide its reach is'], reach.value, reach.says);

  const optionalHosts = [...(manifest.optional_host_permissions ?? [])].map(String).sort();
  for (const host of optionalHosts) {
    fact(['which sites it may ask for later', host], true, `It may ask to reach "${host}" later.`);
  }

  for (const page of declaredPages(manifest)) {
    fact(['the pages it declares', page.what], page.file, `${page.what[0].toUpperCase()}${page.what.slice(1)} is ${page.file}. A page named here that is not in the built folder is an extension with a dead button.`);
  }

  const scripts = /** @type {any[]} */ (manifest.content_scripts ?? []);
  scripts.forEach((script, index) => {
    const matches = [...(script?.matches ?? [])].map(String).sort();
    const at = ['what it changes on other people\'s pages', matches[0] ?? `the ${index + 1}${index === 0 ? 'st' : 'th'} one`];
    fact([...at, 'runs on'], matches, `This content script runs on ${matches.length === 0 ? 'nothing it names' : matches.join(', ')}. Every address here is a page it may read and change.`);
    fact([...at, 'the files it injects'], [...(script?.js ?? []), ...(script?.css ?? [])].map(String), 'The files it injects into those pages. A file that disappeared from this list is code that stopped running on somebody\'s page.');
    fact([...at, 'when it runs'], String(script?.run_at ?? 'document_idle'), 'When in the page\'s life it runs. Moving this earlier or later is one of the ways a working content script starts missing the thing it was reading.');
    if (script?.all_frames !== undefined) fact([...at, 'in every frame'], script.all_frames === true, `It ${script.all_frames === true ? 'does' : 'does not'} run inside embedded frames as well as the main page.`);
  });
  fact(['how many things it injects into other pages'], scripts.length, `It injects into other people's pages in ${scripts.length} place${scripts.length === 1 ? '' : 's'}.`);

  const background = manifest.background ?? null;
  fact(['does it run something in the background'], background !== null, background === null
    ? 'It runs nothing in the background.'
    : `It runs ${background.service_worker ? `a background worker (${background.service_worker})` : background.page ? `a background page (${background.page})` : `background scripts (${[...(background.scripts ?? [])].join(', ')})`}.`);

  for (const entry of manifest.web_accessible_resources ?? []) {
    const resources = typeof entry === 'string' ? [entry] : [...(entry?.resources ?? [])].map(String);
    const to = typeof entry === 'string' ? ['every site'] : [...(entry?.matches ?? [])].map(String);
    fact(['what other pages may load out of it', resources.sort().join(', ')], to.sort(), `Pages on ${to.join(', ')} are allowed to load ${resources.join(', ')} out of this extension. Widening who may is the same shape of change as widening a permission.`);
  }

  if (manifest.externally_connectable) {
    const who = [...(manifest.externally_connectable.matches ?? [])].map(String).sort();
    fact(['who may talk to it from outside'], who, `${who.length === 0 ? 'Nothing' : who.join(', ')} may send messages into this extension from an ordinary web page.`);
  }

  const csp = manifest.content_security_policy;
  if (csp !== undefined) {
    fact(['the rules it sets for its own pages'], typeof csp === 'string' ? csp : typesIn(csp) === 'nothing' ? 'nothing' : JSON.stringify(csp), 'The content security policy its own pages run under. Loosening this is how an extension page becomes somewhere else\'s code can run.');
  }

  const commands = Object.keys(manifest.commands ?? {}).sort();
  for (const command of commands) {
    const keys = manifest.commands[command]?.suggested_key;
    fact(['the keyboard shortcuts it takes', command], typeof keys === 'string' ? keys : keys ? JSON.stringify(keys) : 'no suggested key', `It asks for a keyboard shortcut called "${command}".`);
  }

  const rules = /** @type {any[]} */ (manifest.declarative_net_request?.rule_resources ?? []);
  for (const set of rules) {
    fact(['the request rules it gives the browser', String(set?.id ?? 'a rule set')], { file: String(set?.path ?? ''), 'switched on by default': set?.enabled === true }, `A set of rules that blocks or rewrites requests as pages load, from ${set?.path}. These run without the extension being open.`);
  }

  return facts;
}

/**
 * The shape of a version string, with the numbers taken out.
 *
 * @param {string} version
 * @returns {string}
 */
export function shapeOfAVersion(version) {
  const text = String(version ?? '').trim();
  if (text === '') return 'nothing at all';
  if (/^\d+(\.\d+){0,3}$/.test(text)) {
    const parts = text.split('.').length;
    return `${parts} number${parts === 1 ? '' : 's'} separated by dots`;
  }
  return 'something that is not a plain dotted version number';
}

/**
 * What one build did to a page, worked out by comparing the page with it and without it.
 *
 * Addressed by what each thing IS and what it SAYS — the address `flattenAria` builds — never
 * by where it sits in the list. An extension that adds a banner at the top of a page shifts
 * everything below it down by one, and addressing by position would report the entire page
 * as changed every time.
 *
 * @param {MeaningEntry[]} without
 * @param {MeaningEntry[]} with_
 * @returns {{added: MeaningEntry[], removed: MeaningEntry[], changed: {at: string, was: any, now: any}[]}}
 */
export function differenceMade(without, with_) {
  /** @param {MeaningEntry[]} entries */
  const byAddress = (entries) => {
    /** @type {Map<string, MeaningEntry>} */
    const map = new Map();
    for (const entry of entries) map.set(entry.at.join(' > '), entry);
    return map;
  };
  const before = byAddress(without);
  const after = byAddress(with_);

  /** @type {MeaningEntry[]} */
  const added = [];
  /** @type {MeaningEntry[]} */
  const removed = [];
  /** @type {{at: string, was: any, now: any}[]} */
  const changed = [];

  for (const [at, entry] of after) {
    const was = before.get(at);
    if (!was) added.push(entry);
    else if (JSON.stringify(was.value) !== JSON.stringify(entry.value)) changed.push({ at, was: was.value, now: entry.value });
  }
  for (const [at, entry] of before) {
    if (!after.has(at)) removed.push(entry);
  }
  added.sort((a, b) => a.at.join(' > ').localeCompare(b.at.join(' > ')));
  removed.sort((a, b) => a.at.join(' > ').localeCompare(b.at.join(' > ')));
  changed.sort((a, b) => a.at.localeCompare(b.at));
  return { added, removed, changed };
}

/**
 * Take the extension's id out of a line of text.
 *
 * See the note at the top of this file: the id is made out of the folder the extension was
 * loaded from, so it is different for every build in every run. Left in, it would turn every
 * console message and every address into a difference. Replaced, what is left is the part
 * that is actually about the product.
 *
 * @param {string} text
 * @param {string|null} id
 * @returns {string}
 */
export function withoutTheId(text, id) {
  const said = String(text ?? '');
  if (!id) return said.replace(/chrome-extension:\/\/[a-p]{32}/g, 'chrome-extension://the-extension');
  return said.split(id).join('the-extension').replace(/chrome-extension:\/\/[a-p]{32}/g, 'chrome-extension://the-extension');
}

// ---------------------------------------------------------------------------
// Booting one build
// ---------------------------------------------------------------------------

/**
 * What each prepared build is holding. Keyed by build id, emptied on teardown.
 * @type {Map<string, {dir: string, manifest: Record<string, any>, playwright: any, config: Record<string, any>, base: string, work: string|null, footprint: {dirs: string[], ports: number[], projectRoot?: string}}>}
 */
const running = new Map();

/**
 * @param {Record<string, any>} config
 * @returns {{width: number, height: number, deviceScaleFactor: number}}
 */
function viewportFrom(config) {
  return {
    width: Number(config.viewport?.width ?? VIEWPORT.width),
    height: Number(config.viewport?.height ?? VIEWPORT.height),
    deviceScaleFactor: Number(config.viewport?.deviceScaleFactor ?? VIEWPORT.deviceScaleFactor),
  };
}

/**
 * The web lane's window opener, told to load one extension.
 *
 * `openWindow` owns every promise this tool makes about somebody's machine: a throwaway
 * profile under the scratch folder, the right browser rather than the one the person uses,
 * the window closed afterwards whatever happened. None of that should be written twice, and
 * a second browser launcher in this repository is a second place for those promises to rot.
 *
 * So the browser DRIVER handed to it is wrapped rather than the launcher forked. Three
 * things have to be different for an extension and nothing else does:
 *
 *   - `--disable-extensions` has to come out. It is in the launcher's list for a good reason
 *     — a browser running somebody's extensions is a browser whose screen depends on
 *     yesterday — and it is exactly the flag that would stop this lane working.
 *   - `--disable-extensions-except` and `--load-extension` go in, naming the one folder. The
 *     first is what keeps the promise the flag it replaced was making: no extension but this
 *     one is loaded, ever.
 *   - service workers have to be allowed to run. The launcher blocks them, and in an
 *     extension the background worker IS a service worker, so blocking them switches off the
 *     whole background half of the product.
 *
 * When `web-driver.js` grows a way to pass extra flags through, this wrapper is three lines
 * to delete. Until then it is the smaller of the two mistakes available.
 *
 * @param {any} chromium
 * @param {string|null} extensionDir  Null opens a plain browser with no extension in it.
 * @returns {any}
 */
export function chromiumThatLoads(chromium, extensionDir) {
  if (!extensionDir) return chromium;
  return {
    /**
     * @param {string} dir
     * @param {Record<string, any>} options
     */
    launchPersistentContext: (dir, options) =>
      chromium.launchPersistentContext(dir, {
        ...options,
        args: [
          ...(options.args ?? []).filter((/** @type {string} */ flag) => flag !== '--disable-extensions'),
          `--disable-extensions-except=${extensionDir}`,
          `--load-extension=${extensionDir}`,
        ],
        serviceWorkers: 'allow',
      }),
  };
}

/**
 * Open a browser with the extension in it, and find out what the browser called it.
 *
 * Two ways to the id, and the second checks the first. A running background worker's address
 * IS the id, said by the browser itself. An extension with no background worker has nothing
 * to ask, so the id is worked out from the folder — and then PROVED, by asking the browser
 * for the extension's own manifest at that address. An id that cannot be proved is reported
 * as an extension that did not load, never as one that loaded and did nothing.
 *
 * @param {object} input
 * @param {any} input.playwright
 * @param {string} input.scratchDir
 * @param {{width: number, height: number, deviceScaleFactor: number}} input.viewport
 * @param {string} input.label
 * @param {string|null} input.extensionDir
 * @param {'light'|'dark'} [input.colorScheme]
 * @param {(context: any) => Promise<void>} [input.watch]
 *   Run the instant the browser exists and BEFORE anything else here touches it. It is a
 *   separate hook rather than something the caller does afterwards because of a measurement
 *   on 2026-08-31: an extension's background worker does its startup work — storing things,
 *   calling home — in the moment the browser comes up, and a caller that started listening
 *   after this function had finished proving the extension loaded had already missed it, and
 *   reported an extension that calls one address as an extension that calls none.
 * @returns {Promise<{window: any, id: string|null, loaded: boolean, why: string}>}
 */
async function openWithTheExtension(input) {
  const window = await openWindow({
    chromium: chromiumThatLoads(input.playwright.chromium, input.extensionDir),
    executable: input.playwright.executable,
    scratchDir: input.scratchDir,
    viewport: input.viewport,
    colorScheme: input.colorScheme ?? 'light',
    label: input.label,
  });
  if (input.watch) await input.watch(window.context);

  if (!input.extensionDir) return { window, id: null, loaded: false, why: 'This window was opened with no extension in it on purpose, to see what the page looks like without one.' };

  const context = window.context;
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 8000 }).catch(() => null));
  let id = null;
  try {
    if (worker) id = new URL(String(worker.url())).host;
  } catch {
    // A worker address that will not parse tells us nothing. The folder gives an id too.
  }
  if (!id) id = idForUnpacked(input.extensionDir);

  // The proof. A manifest that comes back is an extension the browser accepted and loaded;
  // anything else means it refused it — a broken manifest, a permission it will not grant, a
  // file that is not there — and every one of those must read as "not checked", not as "fine".
  const probe = await context.newPage();
  try {
    // WHAT COMES BACK IS THE PROOF, NOT WHAT THE NAVIGATION RETURNED. Measured on
    // 2026-08-31: the moment anything in this file is listening to network requests, this
    // navigation hands back nothing at all where a second earlier it handed back a 200 — the
    // page is there, fully loaded, and the driver simply has no response object for an
    // address that never went over the network. Trusting the return value reported a working
    // extension as one the browser had refused to load, and it did it only in the journey
    // that watches the background worker, which is exactly the kind of bug nobody finds.
    await probe.goto(`chrome-extension://${id}/manifest.json`, { timeout: 10000 });
    const ok = String(await probe.content()).includes('manifest_version');
    await probe.close().catch(() => {});
    if (ok) return { window, id, loaded: true, why: `The browser loaded the extension and calls it ${id}.` };
    return { window, id, loaded: false, why: 'The browser answered at the extension\'s own address but did not give back a manifest, so whatever is loaded there is not this extension.' };
  } catch (error) {
    await probe.close().catch(() => {});
    return {
      window,
      id,
      loaded: false,
      why: `The browser refused to load this extension: ${error instanceof Error ? short(error.message, 160) : String(error)}. A browser refuses an extension when its manifest is broken, when it names a file that is not in the folder, or when it asks for something the browser will not give. Nothing about this extension was checked in this window.`,
    };
  }
}

/**
 * The blank stand-in page served at an address a content script says it runs on.
 *
 * Deliberately plain, and deliberately the same every time and on every machine. It exists to
 * answer one question — did the content script fire — and it says what it is, so nobody
 * mistakes a stand-in for the real site.
 *
 * @param {string} url
 * @returns {string}
 */
export function standInPage(url) {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Not a parseable address. The whole thing is a fine heading.
  }
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    `<title>${host}</title></head><body><main><h1>${host}</h1>`,
    '<p>A stand-in page served from this machine. Nothing was fetched from the internet.</p>',
    '</main></body></html>',
  ].join('');
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const extensionAdapter = defineAdapter({
  name: 'extension',
  title: 'Browser extensions, loaded into a real browser',
  describe:
    "Reads the manifest as a contract - every permission, every site it may touch, every page and content script it declares - and then loads the extension into a throwaway browser with the clock stopped and the internet cut off. Its popup and options pages are walked like any other page, for what the screen MEANS rather than how it looks. What its content scripts DO to somebody else's page is measured by opening the same page twice, with the extension and without it, and writing down the difference. The background worker's storage and the calls it makes are recorded. It cannot read what the background worker logs, it never visits a real site, and unless a project supplies the real page the content script is tried against a blank stand-in - which answers whether the script fired, not whether it put things in the right place.",
  channels: ['contract', 'meaning', 'effects', 'complaints', 'counters', 'pixels'],

  /** @param {import('./contract.js').AdapterProject} project */
  async detect(project) {
    const config = project.config ?? {};
    /** @type {Missing[]} */
    const missing = [];

    const found = findExtension(project.root, config.dir);
    if (!found.file) {
      return {
        applies: false,
        confidence: 0,
        why: found.why,
        missing: [
          {
            what: 'a folder with a manifest.json in it',
            unlocks: 'checking this as a browser extension at all',
            howToGet: 'Put {"dir": "dist"} under "extension" in the settings, pointing at the folder you would load unpacked in the browser.',
            blocking: true,
          },
        ],
      };
    }

    const read = readManifest(await fsp.readFile(found.file, 'utf8').catch(() => ''));
    if (!read.ok) {
      return {
        applies: true,
        confidence: 0.5,
        why: `${found.why} ${read.why}`,
        missing: [{ what: 'a manifest a browser would accept', unlocks: 'everything - a browser refuses to load this extension as it stands', howToGet: 'Fix the manifest.json named above.', blocking: true }],
      };
    }

    const playwright = await loadPlaywright({ projectRoot: project.root });
    if (!playwright.ok) {
      missing.push({
        what: playwright.state === 'no package' ? 'Playwright, the thing that drives the browser' : "Playwright's Chromium",
        unlocks: 'loading the extension at all. The manifest is still read and compared without it, which is the half that catches a permission somebody widened',
        howToGet: playwright.howToGet,
      });
    }

    // A page named in the manifest that is not in the folder is an extension with a dead
    // button, and it is worth saying before anything is run rather than after.
    /** @type {string[]} */
    const notThere = [];
    for (const page of declaredPages(read.manifest)) {
      if (!fs.existsSync(path.join(/** @type {string} */ (found.dir), page.file))) notThere.push(page.file);
    }
    for (const script of read.manifest.content_scripts ?? []) {
      for (const file of [...(script?.js ?? []), ...(script?.css ?? [])]) {
        if (!fs.existsSync(path.join(/** @type {string} */ (found.dir), String(file)))) notThere.push(String(file));
      }
    }
    if (notThere.length > 0) {
      missing.push({
        what: `the ${notThere.length === 1 ? 'file' : `${notThere.length} files`} the manifest names that ${notThere.length === 1 ? 'is' : 'are'} not in that folder: ${[...new Set(notThere)].slice(0, 5).join(', ')}`,
        unlocks: 'loading the extension at all — a browser refuses an extension whose manifest names a file that is not there',
        howToGet: config.build
          ? 'Run the build command in the settings and check it writes into the folder "extension.dir" points at.'
          : 'Point "extension.dir" at your BUILT folder, or put {"build": "npm run build"} under "extension" so each build is built before it is loaded.',
      });
    }

    const targets = contentScriptTargets(read.manifest);
    const standIns = targets.filter((t) => t.url && !t.exact).length + targets.filter((t) => t.url && t.exact && !hasSuppliedPage(config, t.url)).length;
    if (standIns > 0) {
      missing.push({
        what: `what the real page looks like for ${standIns === 1 ? 'the site' : `the ${standIns} sites`} the content scripts run on`,
        unlocks: 'checking what the content script does to a real page instead of a blank one. Without it, what is checked is whether the script fired at all — which is the break that usually happens, but not the only one',
        howToGet: `Put {"pages": [{"url": "${targets.find((t) => t.url)?.url ?? 'https://example.com/'}", "file": "test/fixtures/that-page.html"}]} under "extension" in the settings — a saved copy of the page, served from this machine.`,
      });
    }

    const pages = declaredPages(read.manifest).length;
    return {
      applies: true,
      confidence: 1,
      why: `${found.why} It is a manifest version ${read.manifest.manifest_version} extension called "${read.manifest.name ?? 'something with no name'}", with ${pages} page${pages === 1 ? '' : 's'} of its own and ${(read.manifest.content_scripts ?? []).length} thing${(read.manifest.content_scripts ?? []).length === 1 ? '' : 's'} it injects into other people's pages. ${playwright.ok ? playwright.why : playwright.why}`,
      missing,
      notes: [
        'The manifest is read as a contract. A permission that appears, or a host permission that widens from one named site to every site, is reported as a change somebody has to agree to — and reading it needs no browser at all.',
        "What a content script does is measured by opening the same page twice, once with the extension and once without, and comparing the difference. A content script that quietly stopped firing leaves a page that looks perfectly normal, because it is the normal page.",
        'Nothing ever reaches the internet. Every page a content script is tried against is served from this machine at the address the manifest itself names.',
        'The extension id is not compared. A browser makes it out of the folder the extension was loaded from, so the two builds of one comparison always have different ids, and comparing them would report a difference on every run.',
      ],
    };
  },

  /** @param {import('./contract.js').AdapterProject} project */
  async journeys(project) {
    const config = project.config ?? {};
    const found = findExtension(project.root, config.dir);
    if (!found.file) return [];

    const read = readManifest(await fsp.readFile(found.file, 'utf8').catch(() => ''));
    if (!read.ok) {
      return [
        {
          name: 'the manifest',
          describe: 'read the manifest as a contract',
          source: 'code',
          surface: 'extension',
          from: path.relative(project.root, found.file),
          channels: [],
          steps: [],
          skip: `${read.why} Nothing about this extension was listed, walked or counted, because a manifest is the only thing that says what an extension IS. This is a hole, not a pass.`,
        },
      ];
    }

    const manifest = read.manifest;
    /** @type {Journey[]} */
    const journeys = [
      {
        name: 'the manifest',
        describe: 'read the manifest as a contract — the permissions, the sites, the pages',
        source: 'code',
        surface: 'extension',
        from: path.relative(project.root, found.file),
        channels: ['contract'],
        steps: /** @type {any} */ ([{ act: 'read', kind: 'manifest', note: 'read the manifest' }]),
      },
    ];

    for (const page of declaredPages(manifest)) {
      journeys.push({
        name: page.what,
        describe: `open ${page.what} (${page.file}) and read what the screen says`,
        source: 'code',
        surface: 'extension',
        from: `${path.relative(project.root, found.file)} → ${page.file}`,
        channels: ['meaning', 'complaints', 'counters', 'pixels'],
        steps: /** @type {any} */ ([{ act: 'open', kind: 'page', file: page.file, what: page.what, note: `open ${page.file}` }]),
      });
    }

    for (const target of contentScriptTargets(manifest)) {
      if (!target.url) {
        journeys.push({
          name: `what it does to the pages matching ${target.pattern}`,
          describe: `what the content script does to ${target.pattern}`,
          source: 'code',
          surface: 'extension',
          from: path.relative(project.root, found.file),
          channels: [],
          steps: [],
          skip: `The content script that runs on "${target.pattern}" was not tried, because ${target.why}. Whatever it does to those pages is not in this check, and is not in the count of what is.`,
        });
        continue;
      }
      journeys.push({
        name: `what it does to ${target.url}`,
        describe: `open ${target.url} with the extension and without it, and write down the difference`,
        source: 'code',
        surface: 'extension',
        from: path.relative(project.root, found.file),
        channels: ['meaning', 'effects', 'counters'],
        steps: /** @type {any} */ ([{ act: 'open', kind: 'content', url: target.url, pattern: target.pattern, exact: target.exact, why: target.why, files: target.files, note: `open ${target.url}` }]),
      });
    }

    if (manifest.background) {
      journeys.push({
        name: 'the background worker',
        describe: 'start the extension and watch what its background worker stores',
        source: 'code',
        surface: 'extension',
        from: path.relative(project.root, found.file),
        // Only what it actually fills. A journey that claims a channel it never collects
        // makes the coverage ledger say a question was answered when nobody asked it, and
        // that ledger is the one place a person goes to find out what was NOT looked at.
        channels: ['effects', 'counters', 'complaints'],
        steps: /** @type {any} */ ([{ act: 'open', kind: 'background', note: 'let the background worker start' }]),
      });
    }

    return journeys;
  },

  /**
   * Get one build ready to be loaded.
   *
   * Nothing is opened here. A browser is opened per journey, each with a profile of its own,
   * for the same reason the web lane does it: an extension that wrote something to storage in
   * one journey must not be able to change what the next journey sees.
   *
   * @param {import('./contract.js').Build} build
   * @param {import('./contract.js').RunContext} ctx
   */
  async prepare(build, ctx) {
    const config = ctx.config ?? {};
    const base = path.join(ctx.scratchDir, `extension-${build.id.slice(0, 12).replace(/[^A-Za-z0-9_-]/g, '-')}`);
    await fsp.mkdir(base, { recursive: true });

    /** @param {string} why */
    const notReady = (why) => ({
      build,
      root: base,
      ready: false,
      why,
      dispose: async () => {
        await fsp.rm(base, { recursive: true, force: true });
      },
    });

    const playwright = await loadPlaywright({ projectRoot: build.root });

    // Where the extension is read from. With a build command it is built in a scratch copy
    // first, because the folder a browser loads is the folder the bundler wrote — reading
    // the source folder instead would compare a description of the product rather than the
    // product. Without one, the build's own folder is read and never written to.
    let root = build.root;
    /** @type {string|null} */
    let work = null;
    /** @type {string[]} */
    const notes = [];
    if (config.build) {
      work = path.join(base, 'work');
      const copy = await copyForScratch(build.root, work);
      if (!copy.copied) return notReady(copy.why);
      const env = frozenEnvironment({
        clock: ctx.clock,
        seed: ctx.seed,
        home: path.join(base, 'home'),
        tmp: path.join(base, 'tmp'),
        extra: { NODE_ENV: config.nodeEnv ?? 'production', ...config.env },
      });
      await fsp.mkdir(path.join(base, 'home'), { recursive: true });
      await fsp.mkdir(path.join(base, 'tmp'), { recursive: true });
      /** @type {Buffer[]} */
      const said = [];
      const child = spawnServer(String(config.build), { cwd: work, env });
      child.stdout?.on('data', (c) => said.push(c));
      child.stderr?.on('data', (c) => said.push(c));
      const code = await withLimit(
        new Promise((resolve) => {
          child.on('error', () => resolve(-1));
          child.on('close', (status) => resolve(status ?? -1));
        }),
        Number(config.buildTimeoutMs ?? 300000),
        'ran out of time',
      );
      await stopServer(child);
      if (code !== 0) {
        return notReady(
          `The command that builds this extension ("${config.build}") ${code === 'ran out of time' ? `did not finish within ${timeBucket(Number(config.buildTimeoutMs ?? 300000))}` : `failed with exit code ${code}`}, so there is nothing built to load. What it printed: ${trimForStorage(Buffer.concat(said).toString('utf8'), 1500).text || '(nothing)'}`,
        );
      }
      root = work;
      notes.push(`It was built first with "${config.build}".`);
    }

    const found = findExtension(root, config.dir);
    if (!found.file || !found.dir) return notReady(found.why);
    const read = readManifest(await fsp.readFile(found.file, 'utf8').catch(() => ''));
    if (!read.ok) return notReady(read.why);

    running.set(build.id, {
      dir: found.dir,
      manifest: read.manifest,
      playwright,
      config,
      base,
      work,
      footprint: { dirs: [base, root].filter(Boolean), ports: [], projectRoot: build.root },
    });

    return {
      build,
      root: found.dir,
      ready: true,
      why: `${found.why}${notes.length > 0 ? ` ${notes.join(' ')}` : ''} ${playwright.ok ? 'It will be loaded into a browser with a throwaway profile, and no other extension will be loaded with it.' : `${playwright.why} The manifest is still read and compared; nothing that needs a browser is.`}`,
      facts: { dir: found.dir, manifestVersion: Number(read.manifest.manifest_version) },
      dispose: async () => {
        running.delete(build.id);
        await fsp.rm(base, { recursive: true, force: true });
      },
    };
  },

  /**
   * Walk one journey against one prepared build.
   *
   * @param {Journey} journey
   * @param {import('./contract.js').PreparedBuild} build
   * @param {import('./contract.js').RunContext} ctx
   * @returns {Promise<Observation[]>}
   */
  async run(journey, build, ctx) {
    const held = running.get(build.build.id);
    if (!build.ready || !held) {
      return [
        notCovered({
          channel: 'contract',
          path: joinPath('extension', journey.name, 'looked at at all'),
          reason: /playwright|chromium|browser/i.test(build.why) ? 'missing tool' : 'crashed',
          says: `"${journey.describe}" was not looked at: ${build.why}`,
        }),
      ];
    }

    const step = /** @type {Record<string, any>} */ ((journey.steps ?? [])[0] ?? {});
    const kind = String(step.kind ?? '');

    // The manifest is read, never run, so it works on a machine with no browser on it at
    // all — which is most build servers. It is deliberately the first thing here.
    if (kind === 'manifest') return theManifest(journey, held);

    if (!held.playwright.ok) {
      return [
        notCovered({
          channel: kind === 'content' ? 'meaning' : 'meaning',
          path: joinPath('extension', journey.name, 'opened at all'),
          reason: 'missing tool',
          says: `"${journey.describe}" needs a browser and there is not one this can open. ${held.playwright.why}${held.playwright.howToGet ? ` Run: ${held.playwright.howToGet}` : ''} The manifest was still read and compared.`,
        }),
      ];
    }

    if (kind === 'page') return await onePage(journey, step, held, ctx, build.build.id);
    if (kind === 'content') return await whatItDoesToAPage(journey, step, held, ctx);
    if (kind === 'background') return await theBackgroundWorker(journey, held, ctx);

    return [
      notCovered({
        channel: 'contract',
        path: joinPath('extension', journey.name, 'looked at at all'),
        reason: 'not supported here',
        says: `"${journey.name}" asks for something this lane does not know how to do ("${kind}"), so nothing about it was checked.`,
      }),
    ];
  },

  async teardown() {
    running.clear();
  },
});

// ---------------------------------------------------------------------------
// The manifest — the contract
// ---------------------------------------------------------------------------

/**
 * @param {Journey} journey
 * @param {NonNullable<ReturnType<typeof running.get>>} held
 * @returns {Observation[]}
 */
function theManifest(journey, held) {
  /** @type {Observation[]} */
  const out = [];
  for (const fact of manifestContract(held.manifest)) {
    out.push(
      observation({
        channel: 'contract',
        path: joinPath('contract', 'the manifest', ...fact.path),
        value: fact.value,
        says: fact.says,
        journey: journey.name,
        surface: 'extension',
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// The popup and the options page — ordinary pages at an unusual address
// ---------------------------------------------------------------------------

/**
 * Open one of the extension's own pages and write down what it means.
 *
 * @param {Journey} journey
 * @param {Record<string, any>} step
 * @param {NonNullable<ReturnType<typeof running.get>>} held
 * @param {import('./contract.js').RunContext} ctx
 * @param {string} buildId
 * @returns {Promise<Observation[]>}
 */
async function onePage(journey, step, held, ctx, buildId) {
  /** @type {Observation[]} */
  const out = [];
  const file = String(step.file);
  const viewport = viewportFrom(held.config);
  const opened = await openWithTheExtension({
    playwright: held.playwright,
    scratchDir: ctx.scratchDir,
    viewport,
    label: journey.name,
    extensionDir: held.dir,
    colorScheme: held.config.colorScheme ?? 'light',
  });

  try {
    if (!opened.loaded) {
      return [
        notCovered({
          channel: 'meaning',
          path: joinPath('screen', journey.name, 'opened at all'),
          reason: 'crashed',
          says: `${journey.name} was not opened. ${opened.why}`,
        }),
      ];
    }

    const id = /** @type {string} */ (opened.id);
    const handle = opened.window.handle;
    const address = `chrome-extension://${id}/${file}`;
    handle.baseUrl = `chrome-extension://${id}`;

    // The freeze goes on before the page is fetched, exactly as it does for a web page. The
    // one difference is the allow list: an extension page loads its own scripts and styles
    // out of the extension, and "block everything that is not this app's own origin" does not
    // know that a chrome-extension address is this app. Without this line the popup opens
    // with none of its own code in it, which reads as a popup that lost all its buttons.
    const frozen = await applyFreeze(
      handle,
      {
        clock: ctx.clock,
        seed: ctx.seed,
        timezone: held.config.timezone ?? 'UTC',
        locale: held.config.locale ?? 'en-US',
        network: 'block-external',
        networkAllow: ['chrome-extension://**', ...(held.config.allowHosts ?? [])],
        hideScrollbars: true,
        hideCaret: true,
      },
      { fixturesDir: ctx.evidenceDir, screenName: journey.name, deviceScaleFactor: viewport.deviceScaleFactor },
    );

    const started = Date.now();
    const page = opened.window.page;
    try {
      await page.goto(address, { timeout: Number(held.config.timeoutMs ?? 30000), waitUntil: 'load' });
    } catch (error) {
      out.push(
        notCovered({
          channel: 'meaning',
          path: joinPath('screen', journey.name, 'opened at all'),
          reason: 'crashed',
          says: `${journey.name} is named in the manifest as ${file}, and the browser would not open it: ${error instanceof Error ? short(withoutTheId(error.message, id), 200) : String(error)}. A page the manifest names that will not open is a button in this extension that does nothing.`,
        }),
      );
      await withLimit(frozen.release(), 10000, undefined);
      return out;
    }

    out.push(...(await readTheScreen({ window: opened.window, journey, checkpoint: 'end', ctx, config: held.config, footprint: held.footprint, id, buildId, at: `${file}` })));
    out.push(...complaintsFrom(journey, handle.consoleErrors(), id));
    out.push(
      howLongItTook({
        channel: 'counters',
        path: joinPath('count', journey.name, 'how long it took to open'),
        ms: Date.now() - started,
        what: `Opening ${journey.name}`,
        andAlso: 'This does not count starting the browser or loading the extension, which is our time and not the product\'s.',
        journey: journey.name,
      }),
    );
    await withLimit(frozen.release(), 10000, undefined);
  } finally {
    await opened.window.close();
  }
  return out;
}

// ---------------------------------------------------------------------------
// The content script — the difference IS the product
// ---------------------------------------------------------------------------

/**
 * Has the project supplied a real page for this address?
 *
 * @param {Record<string, any>} config
 * @param {string} url
 * @returns {boolean}
 */
function hasSuppliedPage(config, url) {
  return Boolean(suppliedPageFor(config, url));
}

/**
 * The page a project supplied for one address, if it supplied one.
 *
 * Matched on the exact address first and the site second, because a project that saves one
 * copy of a site's page means it for that site, and asking somebody to write out every
 * address is asking them not to bother.
 *
 * @param {Record<string, any>} config
 * @param {string} url
 * @returns {{url: string, file?: string, html?: string}|null}
 */
export function suppliedPageFor(config, url) {
  const pages = /** @type {any[]} */ (config.pages ?? []);
  const exact = pages.find((p) => String(p?.url ?? '') === url);
  if (exact) return exact;
  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  return pages.find((p) => {
    try {
      return new URL(String(p?.url ?? '')).origin === origin;
    } catch {
      return false;
    }
  }) ?? null;
}

/**
 * Open one page twice — with the extension and without it — and write down the difference.
 *
 * THE TWO WINDOWS ARE NEVER OPEN AT ONCE, for the same reason the two builds never are. Two
 * browsers on one machine compete for memory and for the processor, and a page that rendered
 * late because the other browser was busy looks exactly like a content script that stopped
 * firing. The plain window goes first and is shut before the second is opened.
 *
 * The page itself is served from this machine at the address the manifest names, so the
 * address matches what the content script says it runs on and nothing leaves the machine.
 * Measured on 2026-08-31: with the freeze layer told to allow that one address and the page
 * answered locally, the content script fired and the banner it adds was in the meaning tree.
 *
 * @param {Journey} journey
 * @param {Record<string, any>} step
 * @param {NonNullable<ReturnType<typeof running.get>>} held
 * @param {import('./contract.js').RunContext} ctx
 * @returns {Promise<Observation[]>}
 */
async function whatItDoesToAPage(journey, step, held, ctx) {
  /** @type {Observation[]} */
  const out = [];
  const url = String(step.url);
  const viewport = viewportFrom(held.config);
  const head = ['extension', journey.name];

  const supplied = suppliedPageFor(held.config, url);
  /** @type {string} */
  let html;
  /** @type {string} */
  let whatThePageIs;
  if (supplied?.html !== undefined) {
    html = String(supplied.html);
    whatThePageIs = 'the page the project supplied in its settings';
  } else if (supplied?.file !== undefined) {
    const file = path.isAbsolute(String(supplied.file)) ? String(supplied.file) : path.join(held.dir, '..', String(supplied.file));
    const read = await fsp.readFile(file, 'utf8').catch(() => null);
    if (read === null) {
      html = standInPage(url);
      whatThePageIs = `a blank stand-in, because the page the settings point at (${supplied.file}) could not be read`;
    } else {
      html = read;
      whatThePageIs = `the saved copy of the page at ${supplied.file}`;
    }
  } else {
    html = standInPage(url);
    whatThePageIs = 'a blank stand-in page served from this machine';
  }

  const standIn = whatThePageIs.startsWith('a blank stand-in');

  /**
   * Open one window, put the page in front of it, and read what the screen means.
   *
   * @param {string|null} extensionDir
   * @param {string} label
   * @returns {Promise<{entries: MeaningEntry[], asked: {method: string, pattern: string}[], loaded: boolean, why: string, id: string|null}>}
   */
  const look = async (extensionDir, label) => {
    const opened = await openWithTheExtension({
      playwright: held.playwright,
      scratchDir: ctx.scratchDir,
      viewport,
      label: `${journey.name} ${label}`,
      extensionDir,
      colorScheme: held.config.colorScheme ?? 'light',
    });
    /** @type {{method: string, pattern: string}[]} */
    const asked = [];
    try {
      if (extensionDir && !opened.loaded) return { entries: [], asked, loaded: false, why: opened.why, id: opened.id };

      const handle = opened.window.handle;
      handle.baseUrl = url;
      const frozen = await applyFreeze(
        handle,
        {
          clock: ctx.clock,
          seed: ctx.seed,
          timezone: held.config.timezone ?? 'UTC',
          locale: held.config.locale ?? 'en-US',
          network: 'block-external',
          // The freeze layer would refuse this address as somebody else's server, which it
          // is. It is allowed through so that our OWN answer below can be the thing that
          // serves it — the request is answered inside this process and never goes out.
          networkAllow: [url, `${url}**`, 'chrome-extension://**', ...(held.config.allowHosts ?? [])],
          hideScrollbars: true,
          hideCaret: true,
        },
        { fixturesDir: ctx.evidenceDir, screenName: journey.name, deviceScaleFactor: viewport.deviceScaleFactor },
      );

      // One answer for everything that goes over the network, given here rather than fetched.
      // The page the content script runs on is served; everything else the page or the script
      // then asks for is written down and refused, because a content script that phones home
      // would otherwise make this check depend on somebody else's server being awake.
      //
      // ONLY http AND https ARE MATCHED, and that is not tidiness. An extension loads its own
      // scripts, styles and worker from `chrome-extension://` addresses, and those are not
      // network requests anything here can hand back. Measured on 2026-08-31: catching them
      // and calling `route.continue()` left the extension's background worker unable to
      // answer at all, so what it had in storage came back as "it fell over" on an extension
      // that was working perfectly. Never intercepting them fixes it outright.
      await opened.window.context.route(/^https?:\/\//, async (/** @type {any} */ route) => {
        const request = route.request();
        const asking = String(request.url());
        if (asking === url || asking === `${url}/`) {
          await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }).catch(() => {});
          return;
        }
        asked.push({ method: String(request.method()).toUpperCase(), pattern: wirePattern(asking, null) });
        await route.abort().catch(() => {});
      });

      await opened.window.page.goto(url, { timeout: Number(held.config.timeoutMs ?? 30000), waitUntil: 'load' }).catch(() => {});
      // A content script that runs at `document_idle` has not run when `load` fires. Waiting
      // for the page to stop moving is what makes this fair to a script that runs late — and
      // reading the tree too early is how a tool reports a content script as missing when it
      // was simply not there yet.
      await settle(handle, { frames: 2, intervalMs: 150, timeoutMs: Number(held.config.settleTimeoutMs ?? 8000), capture: () => handle.shoot() }).catch(() => {});

      /** @type {MeaningEntry[]} */
      let entries = [];
      try {
        entries = flattenAria(parseAria(await opened.window.page.locator('body').ariaSnapshot()));
      } catch {
        // Reported by the caller, which knows which of the two windows this was.
      }
      await withLimit(frozen.release(), 10000, undefined);
      return { entries, asked, loaded: true, why: opened.why, id: opened.id };
    } finally {
      await opened.window.close();
    }
  };

  const plain = await look(null, 'without the extension');
  const withIt = await look(held.dir, 'with the extension');

  if (!withIt.loaded) {
    return [
      notCovered({
        channel: 'meaning',
        path: joinPath(...head, 'what it changes'),
        reason: 'crashed',
        says: `What this extension does to ${url} was not checked. ${withIt.why} Nothing is being claimed about that page either way — in particular, this is NOT a report that the extension leaves the page alone.`,
      }),
    ];
  }

  if (plain.entries.length === 0 && withIt.entries.length === 0) {
    return [
      notCovered({
        channel: 'meaning',
        path: joinPath(...head, 'what it changes'),
        reason: 'crashed',
        says: `Neither the page with the extension nor the page without it could be read at ${url}, so there is no difference to report and nothing about this content script was checked.`,
      }),
    ];
  }

  const difference = differenceMade(plain.entries, withIt.entries);
  const touched = difference.added.length > 0 || difference.removed.length > 0 || difference.changed.length > 0;

  // THE HEADLINE. Everything else in this journey is detail; this one line is what flips
  // when a content script stops firing, and it flips whatever the page it was firing on
  // happened to contain.
  out.push(
    observation({
      channel: 'meaning',
      path: joinPath(...head, 'does it change this page at all'),
      value: touched,
      says: touched
        ? `With the extension loaded, ${url} is different from the same page without it. That difference is what this extension does, and it is written out below.`
        : `With the extension loaded, ${url} is EXACTLY the same page as without it. The manifest says a content script runs there. If this used to be true and is now false, the content script has stopped firing — and a page whose content script stopped firing looks completely normal, because it is the normal page.`,
      journey: journey.name,
      surface: 'extension',
    }),
  );

  out.push(
    observation({
      channel: 'meaning',
      path: joinPath(...head, 'what the page it was tried against was'),
      value: standIn ? 'a blank stand-in' : 'a saved copy of the real page',
      says: standIn
        ? `The page at ${url} was ${whatThePageIs}, not the real site — nothing here ever reaches the internet. That is enough to answer whether the content script fired and what it puts on a page; it is NOT enough to answer whether it put things in the right place on the real site, and that part is not checked. ${step.exact === false ? `The manifest says this script runs on every site, so this one address stands in for all of them.` : ''}`.trim()
        : `The page at ${url} was ${whatThePageIs}, served from this machine. Nothing reached the internet.`,
      journey: journey.name,
      surface: 'extension',
    }),
  );

  for (const entry of difference.added) {
    out.push(
      observation({
        channel: 'meaning',
        path: joinPath(...head, 'what it adds to the page', ...entry.at),
        value: typeof entry.value === 'string' ? undoOurFootprint(withoutTheId(entry.value, withIt.id), held.footprint) : entry.value,
        says: `The extension puts this on the page: ${entry.describe}`,
        journey: journey.name,
        surface: 'extension',
      }),
    );
  }
  for (const entry of difference.removed) {
    out.push(
      observation({
        channel: 'meaning',
        path: joinPath(...head, 'what it takes off the page', ...entry.at),
        value: typeof entry.value === 'string' ? undoOurFootprint(withoutTheId(entry.value, withIt.id), held.footprint) : entry.value,
        says: `The extension takes this off the page: ${entry.describe}. An extension that removes something from somebody else's page is doing the most invasive thing an extension can do, so it is written down on its own.`,
        journey: journey.name,
        surface: 'extension',
      }),
    );
  }
  for (const change of difference.changed) {
    out.push(
      observation({
        channel: 'meaning',
        path: joinPath(...head, 'what it rewrites on the page', change.at),
        value: { was: change.was, now: change.now },
        says: `The extension changes what "${change.at}" says on this page.`,
        journey: journey.name,
        surface: 'extension',
      }),
    );
  }

  out.push(
    observation({
      channel: 'counters',
      path: joinPath('count', journey.name, 'things it adds to the page'),
      value: countBucket(difference.added.length),
      says: `The extension adds ${difference.added.length} thing${difference.added.length === 1 ? '' : 's'} a person could act on to ${url}. Small counts are exact, because one going to none IS the finding.`,
      journey: journey.name,
      surface: 'extension',
    }),
  );
  out.push(
    observation({
      channel: 'counters',
      path: joinPath('count', journey.name, 'things on the page before it touched it'),
      value: countBucket(plain.entries.length),
      says: `Without the extension there were ${plain.entries.length} things on that page. This is the control: if it moves, the page being tried against changed, and nothing below should be blamed on the extension.`,
      journey: journey.name,
      surface: 'extension',
    }),
  );

  /** @type {Map<string, number>} */
  const grouped = new Map();
  for (const call of withIt.asked) {
    const key = `${call.method} ${call.pattern}`;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  for (const call of plain.asked) {
    // Anything the plain page asked for is the PAGE's own traffic, not the extension's, and
    // blaming the extension for it would be wrong on every run.
    grouped.delete(`${call.method} ${call.pattern}`);
  }
  for (const [asked, times] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(
      observation({
        channel: 'effects',
        path: joinPath('net', journey.name, asked),
        value: { 'asked for': countBucket(times) },
        says: `On that page, and only because the extension was loaded, something asked for ${asked}. It was refused — nothing here reaches the internet — but that it was asked for at all is recorded, because a call that used to go out and no longer does is one of the most common ways a thing keeps looking right while having stopped working.`,
        journey: journey.name,
        surface: 'extension',
      }),
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// The background worker
// ---------------------------------------------------------------------------

/**
 * Start the extension and watch what its background worker does.
 *
 * WHAT IS COVERED: whether it is running at all, what it puts in storage, and what it asks
 * the network for.
 *
 * WHAT IS NOT, and this is said on every run rather than left for somebody to discover: what
 * it LOGS. Measured on 2026-08-31 — the browser driver will not open a debugging session onto
 * a service worker ("expected Page or Frame"), and by the time this lane has a handle on the
 * extension at all, the worker has already started and already logged whatever it logs when
 * it starts, which is most of it. Attaching later and reporting only the tail would be worse
 * than reporting nothing: it would look like the whole log.
 *
 * WHAT IS STORED IS RECORDED BY SHAPE, NOT BY VALUE. Measured the same day: a worker that
 * writes `installedAt: Date.now()` writes a different number every single run, because the
 * frozen clock is installed on the PAGE and a service worker is not a page. Comparing the
 * values would report a difference on every run of an extension that has never changed.
 * The keys and the types are the promise; today's numbers are not.
 *
 * @param {Journey} journey
 * @param {NonNullable<ReturnType<typeof running.get>>} held
 * @param {import('./contract.js').RunContext} ctx
 * @returns {Promise<Observation[]>}
 */
async function theBackgroundWorker(journey, held, ctx) {
  /** @type {Observation[]} */
  const out = [];
  const viewport = viewportFrom(held.config);
  const head = ['extension', journey.name];

  /** Every background worker that appeared while this window was open. @type {string[]} */
  const everStarted = [];

  const opened = await openWithTheExtension({
    playwright: held.playwright,
    scratchDir: ctx.scratchDir,
    viewport,
    label: journey.name,
    extensionDir: held.dir,
    watch: async (context) => {
      // A background worker that has gone to sleep is a HEALTHY background worker — the
      // whole design of a manifest v3 worker is that it starts, does its work and stops. So
      // what is written down is whether one ever started, not whether one happens to be
      // awake at the moment somebody looked. Asking the second question would report a
      // perfectly working extension as broken, on a timing coin toss.
      context.on('serviceworker', (/** @type {any} */ worker) => everStarted.push(String(worker.url())));
      // THE WIRE IS CUT, and nothing is claimed about what went down it. This lane does not
      // freeze this window — there is no page here to freeze — so this is what stops a
      // background worker phoning home from a check. Every http and https request is refused
      // and none of them is reported; see the note where that hole is written down. Only
      // http and https are matched, never `chrome-extension://` — see the note on the same
      // call in `whatItDoesToAPage` for what intercepting the extension's own files did.
      await context.route(/^https?:\/\//, async (/** @type {any} */ route) => {
        await route.abort().catch(() => {});
      });
    },
  });

  try {
    if (!opened.loaded) {
      return [
        notCovered({
          channel: 'effects',
          path: joinPath(...head, 'started at all'),
          reason: 'crashed',
          says: `The background worker was not watched. ${opened.why}`,
        }),
      ];
    }

    const context = opened.window.context;

    // Give it a moment of its own. A worker's install work is asynchronous, and reading
    // storage the instant the extension loads reads it before the worker has written
    // anything — which looks exactly like a worker that stopped writing.
    await new Promise((done) => {
      const timer = setTimeout(done, Number(held.config.backgroundSettleMs ?? 2000));
      if (typeof timer.unref === 'function') timer.unref();
    });

    const started = everStarted.length > 0 || context.serviceWorkers().length > 0;
    const wanted = Boolean(held.manifest.background?.service_worker);
    out.push(
      observation({
        channel: 'effects',
        path: joinPath(...head, 'did it start'),
        value: started,
        says: started
          ? 'The background worker started. This is the half of an extension nobody can see, and an extension whose background stopped starting looks completely normal until the thing it was doing quietly stops happening. Whether it is awake right now is deliberately not recorded: a manifest v3 worker is MEANT to stop when it has nothing to do.'
          : wanted
            ? 'The manifest declares a background worker and NO background worker ever started. Everything this extension does in the background is not happening.'
            : 'This extension declares its background the old way (a page or a set of scripts rather than a worker), and nothing this lane can ask for started. What its background does is not covered here.',
        journey: journey.name,
        surface: 'extension',
      }),
    );

    if (started) {
      // WHAT IS IN STORAGE IS ASKED OF A PAGE, NOT OF THE WORKER. Measured on 2026-08-31, and
      // it cost an hour: a manifest v3 worker goes to sleep within seconds of finishing its
      // work, and asking a sleeping worker ANYTHING — even two plus two — does not fail, it
      // hangs until something else happens to wake it. Six questions in a row timed out
      // against an extension that was working perfectly, and the check reported that its
      // storage "fell over". So the question is put to a document at the extension's own
      // address instead. It has exactly the same access to the extension's storage, it
      // answers in about twenty-five milliseconds, and the document used is the extension's
      // own manifest — which runs none of the extension's code, so asking cannot change what
      // is being measured.
      /** @type {any} */
      let stored = null;
      const asker = await context.newPage();
      try {
        await asker.goto(`chrome-extension://${opened.id}/manifest.json`, { timeout: 10000 });
        stored = await withLimit(
          asker.evaluate(async () => {
            const browser = /** @type {any} */ (globalThis).chrome;
            if (!browser?.storage) return null;
            const local = browser.storage.local ? await browser.storage.local.get(null).catch(() => ({})) : {};
            const sync = browser.storage.sync ? await browser.storage.sync.get(null).catch(() => ({})) : {};
            return { local, sync };
          }),
          10000,
          null,
        );
      } catch {
        // Reported below as a hole rather than as an empty store, because "it stores nothing"
        // and "we could not ask" must never be allowed to look alike.
      } finally {
        await asker.close().catch(() => {});
      }

      if (stored === null) {
        out.push(
          notCovered({
            channel: 'effects',
            path: joinPath(...head, 'what it keeps in storage'),
            reason: 'crashed',
            says: 'Nothing here could be told what this extension has in storage — either it does not ask for the storage permission at all, or the browser would not answer. What it keeps is not in this check, and this is NOT a report that it keeps nothing.',
          }),
        );
      } else {
        for (const where of /** @type {const} */ (['local', 'sync'])) {
          const kept = /** @type {Record<string, any>} */ (stored[where] ?? {});
          const keys = Object.keys(kept).sort();
          for (const key of keys) {
            out.push(
              observation({
                channel: 'effects',
                path: joinPath(...head, `what it keeps in ${where === 'local' ? 'storage on this machine' : 'storage that follows you between machines'}`, key),
                value: typesIn(kept[key]),
                says: `It keeps something called "${key}", and this is the shape of it. The shape is compared and the value is not: a worker that writes the time it was installed writes a different number every run, and comparing that would report a difference every single time.`,
                journey: journey.name,
                surface: 'extension',
              }),
            );
          }
          out.push(
            observation({
              channel: 'counters',
              path: joinPath('count', journey.name, `things it keeps in ${where} storage`),
              value: countBucket(keys.length),
              says: `It keeps ${keys.length} thing${keys.length === 1 ? '' : 's'} in ${where === 'local' ? 'storage on this machine' : 'storage that follows you between machines'}.`,
              journey: journey.name,
              surface: 'extension',
            }),
          );
        }
      }
    }

    // WHAT IT ASKS THE NETWORK FOR IS NOT COVERED, and this is the measurement that decided
    // it, on 2026-08-31. A background worker does its calling-home in the instant the browser
    // starts, which is BEFORE anything here exists to listen with: the extension is loaded as
    // part of starting the browser, and the earliest moment this lane can attach is after the
    // browser has finished starting. Watching from that moment caught the extension's one
    // outgoing call on one run and missed it on the next, on nothing but timing — and a
    // channel that reports a call on Monday and no call on Tuesday, about a product that did
    // not change, is worse than no channel at all. It would have been a false alarm every
    // other run, and a false alarm is what gets this tool switched off.
    //
    // What a CONTENT SCRIPT asks for IS covered, in the journey that opens a page: there the
    // listening is in place before the page is opened, so nought really means nought.
    out.push(
      notCovered({
        channel: 'effects',
        path: joinPath('net', journey.name, 'what it asks the network for'),
        reason: 'not supported here',
        says:
          'What this extension asks the network for in the background is not checked. It does that in the instant the browser starts it, before anything here can be listening, and a count that catches it on one run and misses it on the next would report a difference about timing rather than about the product. Nothing left this machine either way — every request was refused at the wire. This is a hole, and it is NOT a report that the extension calls nothing.',
      }),
    );

    // Said every run, on purpose. A hole nobody is told about is a hole that reads as a pass.
    out.push(
      notCovered({
        channel: 'complaints',
        path: joinPath('log', journey.name, 'what the background worker logged'),
        reason: 'not supported here',
        says:
          'What the background worker writes to its own log is not read. The browser driver will not open a debugging session onto a service worker, and by the time anything here can hold on to the extension the worker has already started and already said most of what it says. Reading only what came after that would look like the whole log, which is worse than reading none of it. Errors on the extension\'s own PAGES are read normally.',
      }),
    );
  } finally {
    await opened.window.close();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading one screen
// ---------------------------------------------------------------------------

/**
 * Hold still, then write down everything the screen means, plus one picture as evidence.
 *
 * The same shape as the web lane's checkpoint, and for the same reasons: settle before
 * reading, because a control that was simply not painted yet reads as a control that
 * disappeared; and the picture is evidence for a finding another channel already made,
 * never the accusation itself.
 *
 * @param {object} input
 * @param {any} input.window
 * @param {Journey} input.journey
 * @param {string} input.checkpoint
 * @param {import('./contract.js').RunContext} input.ctx
 * @param {Record<string, any>} input.config
 * @param {{dirs: string[], ports: number[], projectRoot?: string}} input.footprint
 * @param {string} input.id
 * @param {string} input.buildId
 * @param {string} input.at
 * @returns {Promise<Observation[]>}
 */
async function readTheScreen(input) {
  const { journey, checkpoint, footprint, id } = input;
  const handle = input.window.handle;
  const page = input.window.page;
  /** @type {Observation[]} */
  const out = [];
  const head = ['screen', journey.name, checkpoint];

  await prepareForShutter(handle, { fonts: true, timeoutMs: Number(input.config.settleTimeoutMs ?? 10000) });

  /** @type {Buffer|null} */
  let png = null;
  try {
    const stilled = await settle(handle, {
      frames: 2,
      intervalMs: 120,
      timeoutMs: Number(input.config.settleTimeoutMs ?? 8000),
      capture: () => handle.shoot(),
    });
    png = stilled.png;
  } catch {
    // A page that will not hold still is still worth reading. The picture is evidence; the
    // meaning is the check.
  }

  // The address WITHOUT the id in it. `chrome-extension://gikmlpj.../popup.html` would be a
  // different value for every build in every run; `popup.html` is the fact worth keeping.
  out.push(
    observation({
      channel: 'meaning',
      path: joinPath(...head, 'which of its pages this is'),
      value: withoutTheId(whereItIs(String(page.url()), `chrome-extension://${id}`), id),
      says: `This is the extension's own page at ${input.at}. The browser's id for the extension is deliberately left out — a browser makes that id out of the folder the extension was loaded from, so it is different for every build and comparing it would report a difference on every run.`,
      journey: journey.name,
      surface: 'extension',
    }),
  );

  const title = await page.title().catch(() => '');
  out.push(
    observation({
      channel: 'meaning',
      path: joinPath(...head, 'what the page is called'),
      value: withoutTheId(String(title), id),
      says: `The page is called "${title}".`,
      journey: journey.name,
      surface: 'extension',
    }),
  );

  /** @type {MeaningEntry[]} */
  let entries = [];
  try {
    entries = flattenAria(parseAria(await page.locator('body').ariaSnapshot()));
  } catch (error) {
    out.push(
      notCovered({
        channel: 'meaning',
        path: joinPath(...head, 'what the screen says'),
        reason: 'crashed',
        says: `The screen could not be read: ${error instanceof Error ? error.message : String(error)}. Nothing about this page is being claimed either way.`,
      }),
    );
  }

  for (const entry of entries) {
    const where = joinPath(...head, 'tree', ...entry.at);
    out.push(
      observation({
        channel: 'meaning',
        path: where,
        value: typeof entry.value === 'string' ? undoOurFootprint(withoutTheId(entry.value, id), footprint) : entry.value,
        says: entry.describe,
        journey: journey.name,
        surface: 'extension',
      }),
    );
    for (const [state, value] of Object.entries(entry.states)) {
      out.push(
        observation({
          channel: 'meaning',
          path: `${where}.${state}`,
          value,
          says: `${entry.name ? `"${short(entry.name)}"` : `The ${entry.role}`} is ${state}${value === true ? '' : ` ${value}`}.`,
          journey: journey.name,
          surface: 'extension',
        }),
      );
    }
  }

  for (const [role, howMany] of countRoles(entries)) {
    out.push(
      observation({
        channel: 'counters',
        path: joinPath('count', journey.name, checkpoint, role),
        value: countBucket(howMany),
        says: `There ${howMany === 1 ? 'was 1' : `were ${howMany}`} ${role}${howMany === 1 ? '' : 's'} on this page. Small counts are exact, because three going to two IS the finding.`,
        journey: journey.name,
        surface: 'extension',
      }),
    );
  }
  out.push(
    observation({
      channel: 'counters',
      path: joinPath('count', journey.name, checkpoint, 'everything on the page'),
      value: countBucket(entries.length),
      says: `${entries.length} things on this page had a role and a name a person could act on.`,
      journey: journey.name,
      surface: 'extension',
    }),
  );

  if (png) {
    const file = path.join(input.ctx.evidenceDir, `${fileSafe(`${input.buildId}-${journey.name}-${checkpoint}`)}.png`);
    await fsp.writeFile(file, png).catch(() => {});
    const ink = inkOf(png);
    out.push(
      observation({
        channel: 'pixels',
        path: joinPath('picture', journey.name, checkpoint),
        value: { wide: ink.wide, tall: ink.tall, 'how full the screen is': ink.ink },
        says: `The page was ${ink.wide} by ${ink.tall} and ${ink.ink}. The picture itself is kept as evidence and is never compared — only whether anything was drawn at all, which is the one thing no other channel can see. It is ${sizeBucket(png.length)}.`,
        evidence: file,
        journey: journey.name,
        surface: 'extension',
      }),
    );
  }

  return out;
}

/**
 * What the page complained about, with the extension's id taken out.
 *
 * @param {Journey} journey
 * @param {string[]} messages
 * @param {string|null} id
 * @returns {Observation[]}
 */
function complaintsFrom(journey, messages, id) {
  /** @type {Map<string, {text: string, times: number}>} */
  const grouped = new Map();
  for (const message of messages) {
    const clean = withoutTheId(message, id);
    const key = short(
      clean
        .replace(/https?:\/\/[^\s)'"]+/g, 'an address')
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'an id')
        .replace(/\b\d+\b/g, 'a number')
        .replace(/\s+/g, ' ')
        .trim(),
      70,
    ) || 'something it would not say';
    const found = grouped.get(key);
    if (found) found.times += 1;
    else grouped.set(key, { text: clean, times: 1 });
  }
  return [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, held]) =>
      observation({
        channel: 'complaints',
        path: joinPath('log', journey.name, key),
        value: held.text,
        says: `This page of the extension complained: ${short(held.text, 160)}`,
        journey: journey.name,
        surface: 'extension',
      }),
    );
}

/**
 * A name a picture can be saved under. Cut with a fingerprint on the end, never cut alone:
 * two names that agree for eighty characters would be saved over each other, and the picture
 * offered as evidence for one finding would be a photograph of a different screen.
 *
 * @param {string} name
 * @returns {string}
 */
function fileSafe(name) {
  const clean = String(name).replace(/[^A-Za-z0-9._-]+/g, '-');
  if (clean === '') return 'checkpoint';
  if (clean.length <= 80) return clean;
  const mark = crypto.createHash('sha256').update(clean).digest('hex').slice(0, 8);
  return `${clean.slice(0, 71)}-${mark}`;
}

export default extensionAdapter;
