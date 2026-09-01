/**
 * Web apps.
 *
 * The engine wants a flat list of `path -> value` facts. A web page is the hardest thing in
 * this repository to turn into one, because almost everything a browser will tell you about
 * a page is different the second time you ask: the markup, the class names, the ids, the
 * pixels, the timings, the request order. Ask any of those and the tool cries wolf, and a
 * tool that cries wolf gets switched off inside a week.
 *
 * So this adapter asks for none of them. What it reads is:
 *
 *   MEANING     the accessibility tree - what the screen says each control IS and DOES.
 *               Roles, names and states, addressed through the landmarks and headings above
 *               them, so a page that was rearranged reports nothing at all. This is the
 *               channel that catches a button that stopped being a button, a form that lost
 *               a field, a control that went disabled, a dialog that never opened.
 *   EFFECTS     every call the page made, with the changing parts of the address taken out
 *               and the body reduced to its shape. A page that quietly stopped saving still
 *               looks perfect in every other channel.
 *   COMPLAINTS  console errors, uncaught errors, requests that failed.
 *   RESULTS     what the app's own back end answered.
 *   COUNTERS    how many of each kind of thing, and a rough time bucket - never milliseconds.
 *   PIXELS      one picture per checkpoint, kept as EVIDENCE for a finding another channel
 *               already made. Never the accusation.
 *
 * THE TWO BUILDS ARE NEVER OPEN AT ONCE. Each is prepared, walked and shut down before the
 * other starts: its own port, its own profile folder, its own scratch copy. Two copies of one
 * app running side by side fight over ports, single-instance locks and stored sessions, and
 * that fight looks exactly like a regression - which is the two-hosts-over-one-relay-slot
 * bug that cost a real evening on 2026-08-28, recreated by the very tool meant to catch it.
 *
 * WHAT IT REFUSES. Everything the freeze layer refuses - all outbound traffic to anywhere
 * that is not the app itself - plus a second boundary this adapter owns: any call that looks
 * like it spends money, sends a message or destroys data, and any write at all to an address
 * that is not on this machine. The call is recorded as ASKED FOR and stopped at the wire.
 * Every refusal is reported as a hole in the check. None of them is ever reported as a pass.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  countBucket, defineAdapter, howLongItTook, joinPath, notCovered, observation, sizeBucket,
  timeBucket, trimForStorage, undoOurFootprint, whatItSaid,
} from './contract.js';
import { copyForScratch, frozenEnvironment } from './process.js';
import { freePort, looksDestructive, waitForServer } from './http.js';
import { applyFreeze, prepareForShutter } from '../../freeze/index.js';
import { settle } from '../../freeze/settle.js';
import { spawnServer, stopServer } from './child.js';
import {
  actOf, countRoles, flattenAria, inkOf, loadPlaywright, openWindow, parseAria, runStep, short,
  watchTheWire, whereItIs, withLimit,
} from './web-driver.js';

/** @typedef {import('./contract.js').Journey} Journey */
/** @typedef {import('./contract.js').Observation} Observation */
/** @typedef {import('./contract.js').Missing} Missing */
/** @typedef {import('./web-driver.js').MeaningEntry} MeaningEntry */
/** @typedef {import('./web-driver.js').WireCall} WireCall */

/** How big the window is, unless a project says otherwise. */
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };

// ---------------------------------------------------------------------------
// Where the journeys come from
// ---------------------------------------------------------------------------

/** Folders that never hold a page worth walking. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', '.staysfixed']);

/**
 * Why a folder would not open, in words somebody can act on.
 *
 * The code alone is no use to the person who has to fix it: `EACCES` on its own has sent
 * more than one person looking for a bug in the tool.
 *
 * @param {unknown} error
 * @returns {string}
 */
function whyNotOpened(error) {
  const code = String(/** @type {any} */ (error)?.code ?? '');
  if (code === 'EACCES' || code === 'EPERM') return 'this account does not have permission to open it';
  if (code === 'ENOENT') return 'it was there when the walk started and is not there now';
  if (code === 'ENOTDIR') return 'something in the way is a file, not a folder';
  if (code === 'ELOOP') return 'the links in it point round in a circle';
  if (code === 'EMFILE' || code === 'ENFILE') return 'this machine ran out of open files while reading it';
  const said = String(/** @type {any} */ (error)?.message ?? error ?? '').trim();
  return said === '' ? 'the reason was not given' : said;
}

/**
 * The pages a project has, read out of its folder names.
 *
 * Free, exact, and it finds the four pages nobody links to. A crawl finds only what
 * somebody remembered to link, which is the set of pages least likely to be broken.
 *
 * Both of the layouts in the wild are handled: an `app` folder, where a `page` file makes
 * the folder it sits in a route, and a `pages` folder, where the file itself is the route.
 * A folder in brackets is a grouping and is not part of the address; one starting with an
 * underscore is private and is not routed at all. A folder with a parameter in it is
 * reported as needing a sample value rather than guessed at, because "we did not check
 * this" and "this is fine" must never be allowed to look alike.
 *
 * A FOLDER THIS CANNOT OPEN IS NAMED, not skipped. It used to `continue` on the read that
 * failed, which threw away that folder and every page underneath it without one word — and
 * a page that was never listed is never walked, never counted, and never missed. The run
 * then reported that nothing had changed about a section of the site it had not looked at.
 * This is the same shape of bug as three others that were found and closed elsewhere in the
 * tool; this was the fourth place it was living.
 *
 * @param {string} root
 * @param {{unreadable?: {folder: string, why: string}[]}} [collect]
 *   Hand in an object and every folder that could not be opened is pushed onto
 *   `collect.unreadable`, with the reason in plain English. Callers that pass nothing get
 *   the old shape back and lose the holes, so the two callers inside this file both pass
 *   one; `detect` turns them into something a person can act on and `journeys` turns them
 *   into missing coverage, which is what stops a folder nobody could read reading as a
 *   folder with nothing in it.
 * @returns {Promise<{url: string, file: string, needs: string[]}[]>}
 */
export async function readPageRoutes(root, collect = {}) {
  /** @type {Map<string, {url: string, file: string, needs: string[]}>} */
  const found = new Map();
  const unreadable = collect.unreadable;
  /** @type {Set<string>} */
  const alreadySaid = new Set();

  /**
   * @param {string} base
   * @param {(rel: string, full: string) => void} visit
   */
  const walk = (base, visit) => {
    if (!fs.existsSync(base)) return;
    /** @type {string[]} */
    const stack = [base];
    while (stack.length > 0) {
      const dir = /** @type {string} */ (stack.pop());
      /** @type {import('node:fs').Dirent[]} */
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        const folder = path.relative(root, dir) || '.';
        if (unreadable && !alreadySaid.has(folder)) {
          alreadySaid.add(folder);
          unreadable.push({ folder, why: whyNotOpened(error) });
        }
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push(full);
        } else if (entry.isFile()) {
          visit(path.relative(base, full).split(path.sep).join('/'), full);
        }
      }
    }
  };

  /**
   * @param {string} url
   * @param {string} file
   */
  const add = (url, file) => {
    const clean = url === '' ? '/' : url;
    if (found.has(clean)) return;
    const needs = [...clean.matchAll(/\[\.{0,3}([A-Za-z0-9_]+)\]|:([A-Za-z0-9_]+)/g)].map((m) => m[1] ?? m[2]);
    found.set(clean, { url: clean, file: path.relative(root, file), needs });
  };

  for (const appDir of ['app', 'src/app']) {
    walk(path.join(root, appDir), (rel, full) => {
      if (!/(^|\/)page\.[cm]?[jt]sx?$/.test(rel)) return;
      const url =
        '/' +
        rel
          .split('/')
          .slice(0, -1)
          .filter((s) => s !== '' && !(s.startsWith('(') && s.endsWith(')')) && !s.startsWith('_') && s !== '@')
          .join('/');
      add(url.replace(/\/+$/, ''), full);
    });
  }

  for (const pagesDir of ['pages', 'src/pages']) {
    walk(path.join(root, pagesDir), (rel, full) => {
      if (!/\.[cm]?[jt]sx?$/.test(rel)) return;
      if (rel.startsWith('api/') || rel.startsWith('_')) return;
      const stem = rel.replace(/\.[cm]?[jt]sx?$/, '');
      add(`/${stem.replace(/(^|\/)index$/, '')}`.replace(/\/+$/, ''), full);
    });
  }

  return [...found.values()].sort((a, b) => a.url.localeCompare(b.url));
}

/**
 * Turn a project's settings and its pages into journeys.
 *
 * Three sources, in the order the design ranks them: the project's own screen list if it has
 * one (a person wrote those on purpose, and a project that already does picture checks
 * already has them), a journeys file if one was named, and the pages read out of the folder
 * names for everything neither of those covers. Never invented, never crawled.
 *
 * TWO SCREENS WITH ONE NAME ARE TWO SCREENS. They used to be one: the list is built in a
 * Map keyed by name, so the second `set` overwrote the first, and the screen that lost was
 * never walked, never compared and never counted as a door nobody opened — missing from the
 * very ledger that exists to catch exactly this. Now the second one is told apart by a
 * number and both are walked. Two entries that are the same in every respect really are one
 * screen written down twice, and only those are folded together.
 *
 * @param {object} input
 * @param {Record<string, any>} input.config
 * @param {{url: string, file: string, needs: string[]}[]} input.pages
 * @param {{folder: string, why: string}[]} [input.unreadable]
 *   Folders `readPageRoutes` could not open. Each becomes a journey that says it was not
 *   walked and why, which the engine records as missing coverage. A page behind one of them
 *   was never listed, so nothing else in the run would ever mention it.
 * @returns {Journey[]}
 */
export function journeysFrom(input) {
  const config = input.config ?? {};
  const samples = config.samples ?? {};
  /** @type {Map<string, Journey>} */
  const journeys = new Map();
  /** @type {Map<string, string>} name -> what that journey is, so a true duplicate is spotted */
  const shapes = new Map();

  /**
   * A name nothing else is using. Numbering rather than overwriting: a screen that is
   * dropped here is dropped everywhere, silently, for the rest of the run.
   *
   * @param {string} wanted
   * @returns {string}
   */
  const freeName = (wanted) => {
    if (!journeys.has(wanted)) return wanted;
    for (let n = 2; ; n += 1) {
      const tried = `${wanted} (${n})`;
      if (!journeys.has(tried)) return tried;
    }
  };

  // v1 called these "screens" and this reads them unchanged, on purpose: nobody should have
  // to write their steps twice to get a second kind of check out of them.
  for (const screen of [...(config.screens ?? []), ...(config.journeys ?? [])]) {
    if (!screen || typeof screen !== 'object') continue;
    const wanted = String(screen.name ?? screen.url ?? 'a screen');
    /** @type {Record<string, any>[]} */
    const steps = [];
    if (screen.url !== undefined) steps.push({ act: 'open', goto: String(screen.url), note: `open ${screen.url}` });
    for (const step of screen.steps ?? []) steps.push({ act: actOf(step), ...step });

    // The same name AND the same steps is one screen listed twice — the settings and the
    // journeys file both naming it, most often — and folding those together loses nothing.
    // A different set of steps under the same name is a different screen.
    const shape = JSON.stringify(steps);
    if (shapes.get(wanted) === shape) continue;
    const name = freeName(wanted);
    shapes.set(name, shape);
    journeys.set(name, {
      name,
      describe: String(
        screen.describe ??
        screen.why ??
        (name === wanted
          ? `walk ${name}`
          : `walk ${name} — the settings name two different screens "${wanted}", so this is the second of them`)
      ),
      source: 'code',
      surface: 'web',
      from: 'the project settings',
      channels: ['meaning', 'effects', 'complaints', 'results', 'counters', 'pixels'],
      steps: /** @type {any} */ (steps),
      irreversible: screen.irreversible === true,
      timeoutMs: screen.timeoutMs,
    });
  }

  for (const page of input.pages) {
    let url = page.url;
    /** @type {string[]} */
    const unfilled = [];
    for (const need of page.needs) {
      const sample = samples[need];
      if (sample === undefined) unfilled.push(need);
      else url = url.replace(new RegExp(`\\[\\.{0,3}${need}\\]|:${need}`), encodeURIComponent(String(sample)));
    }
    const name = freeName(`page ${page.url}`);
    journeys.set(name, {
      name,
      describe: `open ${page.url} and read what the screen says`,
      source: 'code',
      surface: 'web',
      from: page.file,
      channels: ['meaning', 'effects', 'complaints', 'results', 'counters', 'pixels'],
      // `door`, `kind` and `doorDetail` are how the coverage ledger learns that this journey
      // walked that page. Without them a page counted as opened only if an observation happened
      // to land at the page's own address, and this adapter writes everything under
      // `screen.<journey name>` — so every page of every site read as never walked, on runs
      // that had just opened all of them. The HTTP adapter has named its doors this way since
      // it was written; this is the same three fields, for the same reason. A page is reached
      // by asking for its address, so the verb is GET.
      steps: /** @type {any} */ ([
        { act: 'open', goto: url, note: `open ${page.url}`, unfilled, door: page.url, kind: 'route', doorDetail: 'GET' },
      ]),
    });
  }

  if (journeys.size === 0 && (config.url || config.baseUrl || config.start)) {
    journeys.set('the front page', {
      name: 'the front page',
      describe: 'open the front page and read what the screen says',
      source: 'code',
      surface: 'web',
      from: 'the address in the project settings',
      channels: ['meaning', 'effects', 'complaints', 'results', 'counters', 'pixels'],
      steps: /** @type {any} */ ([{ act: 'open', goto: '/', note: 'open the front page' }]),
    });
  }

  // Last, and after the front-page fallback so a project made entirely of holes still gets
  // one real journey. A folder nobody could open is a journey that says out loud it was not
  // walked: the engine turns a journey carrying `skip` into missing coverage, which is the
  // only route from here to the ledger. Without it, a page behind that folder was never
  // listed, so nothing anywhere in the run would ever have mentioned it — and a page nobody
  // listed reads exactly like a page that is fine.
  for (const hole of input.unreadable ?? []) {
    const name = freeName(`the pages under ${hole.folder}`);
    journeys.set(name, {
      name,
      describe: `the pages under ${hole.folder}`,
      source: 'code',
      surface: 'web',
      from: hole.folder,
      channels: [],
      steps: /** @type {any} */ ([]),
      skip:
        `"${hole.folder}" could not be opened while looking for this project's pages — ${hole.why} — so nothing under it was listed. ` +
        'Any page in there was not walked and is not in the count of pages that were. This is a hole, not a pass.',
    });
  }

  return [...journeys.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Booting one build
// ---------------------------------------------------------------------------

/** What each prepared build is holding open. Keyed by build id, emptied on teardown. */
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

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const webAdapter = defineAdapter({
  name: 'web',
  title: 'Web apps, in a real browser',
  describe:
    'Opens the app in a throwaway Chromium with the clock stopped, motion killed, randomness seeded and the internet cut off, then walks each journey and writes down what the screen MEANS - the roles, names and states a screen reader would read - along with every call the page made, everything it complained about, what its own back end answered, and one picture per checkpoint kept only as evidence. It never reads the markup, so a page that was restyled or rearranged reports nothing. It cannot see anything a journey never opened, and anything that would spend money, send a message or destroy data is stopped at the wire and reported as unchecked rather than done.',
  channels: ['meaning', 'effects', 'complaints', 'results', 'counters', 'pixels'],

  /** @param {import('./contract.js').AdapterProject} project */
  async detect(project) {
    const config = project.config ?? {};
    /** @type {Missing[]} */
    const missing = [];

    const playwright = await loadPlaywright({ projectRoot: project.root });
    if (!playwright.ok) {
      missing.push({
        what: playwright.state === 'no package' ? 'Playwright, the thing that drives the browser' : "Playwright's Chromium",
        unlocks: 'opening the app at all - every other kind of check still works without it',
        howToGet: playwright.howToGet,
        blocking: true,
      });
    }

    /** @type {any} */
    let pkg = null;
    try {
      pkg = JSON.parse(await fsp.readFile(path.join(project.root, 'package.json'), 'utf8'));
    } catch {
      // A project with no package.json can still be a web app somebody points an address at.
    }
    const dependencies = { ...pkg?.dependencies, ...pkg?.devDependencies };
    const framework = ['next', 'react', 'vue', 'svelte', 'astro', '@remix-run/react', 'nuxt', 'solid-js', 'preact', 'vite']
      .find((name) => name in dependencies);

    /** @type {{unreadable: {folder: string, why: string}[]}} */
    const collect = { unreadable: [] };
    const pages = await readPageRoutes(project.root, collect);
    if (collect.unreadable.length > 0) {
      missing.push({
        what: `permission to read ${collect.unreadable.length === 1 ? 'a folder' : `${collect.unreadable.length} folders`} this project's pages live in: ${collect.unreadable.map((u) => `${u.folder} (${u.why})`).join(', ')}`,
        unlocks: 'listing the pages under them at all. Nothing under a folder that will not open is walked, counted, or missed, so the run is quiet about that part of the site',
        howToGet: `Give this account permission to read ${collect.unreadable.length === 1 ? 'it' : 'them'} — on a Mac or Linux that is: chmod +rx ${collect.unreadable[0].folder}`,
      });
    }
    const address = config.url ?? config.baseUrl ?? null;

    if (!config.start && !address) {
      missing.push({
        what: 'either a command that starts the app, or the address it is already running at',
        unlocks: 'walking any of it - the pages can be listed from the folder names without this, but none of them can be opened',
        howToGet: pkg?.scripts?.dev
          ? 'Put {"start": "npm run dev"} under "web" in the settings, and have it read the PORT it is given. That is the better of the two: a command means each build is booted and walked on its own, which is what makes a comparison mean anything.'
          : 'Put {"start": "..."} under "web" in the settings (it should listen on the PORT it is given), or {"url": "http://localhost:3000"} if it is already running.',
        blocking: true,
      });
    } else if (!config.start && address) {
      missing.push({
        what: 'a command that starts the app',
        unlocks: 'comparing two builds properly. One address can only ever serve one build, so with an address alone both halves of the comparison read the SAME running app, and a paired run proves nothing',
        howToGet: 'Put {"start": "..."} under "web" in the settings - a command that boots this build and listens on the PORT it is given.',
      });
    }

    const needing = pages.filter((p) => p.needs.length > 0);
    if (needing.length > 0 && !config.samples) {
      missing.push({
        what: `a real value for the parts that vary in ${needing.length} page address${needing.length === 1 ? '' : 'es'}`,
        unlocks: `opening ${needing.length === 1 ? 'that page' : 'those pages'} at all instead of reporting ${needing.length === 1 ? 'it' : 'them'} as unchecked`,
        howToGet: `Put {"samples": {${[...new Set(needing.flatMap((p) => p.needs))].slice(0, 3).map((n) => `"${n}": "..."`).join(', ')}}} under "web" in the settings - one real value per name.`,
      });
    }

    const screens = (config.screens ?? []).length + (config.journeys ?? []).length;
    const applies = Boolean(address) || Boolean(config.start) || pages.length > 0 || screens > 0 || Boolean(framework);
    return {
      applies,
      confidence: (config.start || address) && (pages.length > 0 || screens > 0) ? 1 : applies ? 0.5 : 0,
      why: applies
        ? `${pages.length > 0 ? `${pages.length} page${pages.length === 1 ? '' : 's'} were read out of the folder names` : 'No pages were found in the folder names'}${screens > 0 ? `, and the settings name ${screens} screen${screens === 1 ? '' : 's'}` : ''}${framework ? `. This project uses ${framework}` : ''}. ${playwright.why}`
        : 'Nothing here looks like a web app: no pages in the folder names, no address in the settings and no browser framework installed.',
      missing,
      notes: [
        'What is compared is what the screen MEANS - the roles, names and states a screen reader would read - never the markup. A page that was restyled or rearranged reports nothing.',
        'The two builds are opened one after the other, never at the same time. Two copies of one app on one machine fight over the port, the profile and the stored session, and that fight looks exactly like a regression.',
        'Nothing that spends money, sends a message or destroys data is allowed to happen. It is watched at the moment it is asked for, stopped at the wire, and reported as unchecked.',
      ],
    };
  },

  /** @param {import('./contract.js').AdapterProject} project */
  async journeys(project) {
    /** @type {{unreadable: {folder: string, why: string}[]}} */
    const collect = { unreadable: [] };
    const pages = await readPageRoutes(project.root, collect);
    return journeysFrom({ config: project.config ?? {}, pages, unreadable: collect.unreadable });
  },

  /**
   * Get one build ready to be walked.
   *
   * Two shapes, and the difference between them matters enough that the run says which one
   * it got. With a `start` command each build is booted from its own scratch copy on a port
   * nobody else is on, which is a real paired comparison. With only an address, both builds
   * are read from the same running app - which cannot tell them apart, and is reported that
   * way on every single journey rather than quietly passing.
   *
   * @param {import('./contract.js').Build} build
   * @param {import('./contract.js').RunContext} ctx
   */
  async prepare(build, ctx) {
    const config = ctx.config ?? {};
    const base = path.join(ctx.scratchDir, `web-${build.id.slice(0, 12).replace(/[^A-Za-z0-9_-]/g, '-')}`);
    await fsp.mkdir(base, { recursive: true });

    const playwright = await loadPlaywright({ projectRoot: build.root });
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

    if (!playwright.ok) return notReady(`${playwright.why}${playwright.howToGet ? ` Run: ${playwright.howToGet}` : ''}`);

    const address = config.url ?? config.baseUrl ?? null;
    if (!config.start) {
      if (!address) return notReady('There is no command to start this app and no address it is already running at, so no page can be opened.');
      running.set(build.id, { base, baseUrl: String(address), port: 0, child: null, config, playwright, paired: false });
      return {
        build,
        root: base,
        ready: true,
        why: `Reading the app at ${address}. There is no command to start it, so BOTH builds are read from that one running app and it cannot tell them apart - a comparison made this way proves nothing about a change. Every journey says so in its own results.`,
        facts: { baseUrl: String(address), paired: false },
        dispose: async () => {
          running.delete(build.id);
          await fsp.rm(base, { recursive: true, force: true });
        },
      };
    }

    const work = path.join(base, 'work');
    const home = path.join(base, 'home');
    const tmp = path.join(base, 'tmp');
    await fsp.mkdir(home, { recursive: true });
    await fsp.mkdir(tmp, { recursive: true });

    const copy = await copyForScratch(build.root, work);
    if (!copy.copied) return notReady(copy.why);

    const port = await freePort();
    const env = frozenEnvironment({
      clock: ctx.clock,
      seed: ctx.seed,
      home,
      tmp,
      extra: {
        PORT: String(port),
        // Asked for, not relied on. Plenty of dev servers never look at HOST — Vite is one,
        // measured on 2026-08-31: it ignores both HOST and PORT and binds the name
        // `localhost`, which this Mac resolves to the IPv6 loopback. That is why the boot
        // check knocks on both loopback addresses and uses whichever one answers, rather
        // than trusting this line to have been obeyed.
        HOST: '127.0.0.1',
        NODE_ENV: config.nodeEnv ?? 'production',
        ...config.env,
      },
    });

    /** @type {string[]} */
    const notes = [];
    if (config.restore) {
      const verdict = looksDestructive(String(config.restore));
      if (!verdict.safe) notes.push(verdict.why);
      else {
        const done = await new Promise((resolve) => {
          const child = spawnServer(String(config.restore), { cwd: work, env, stdio: 'ignore' });
          child.on('error', () => resolve(false));
          child.on('close', (code) => resolve(code === 0));
        });
        notes.push(done ? 'The data was put back to a known state before booting.' : 'The command that puts the data back failed, so the data is not in a known state and every difference after the first write is suspect.');
      }
    }

    /** @type {Buffer[]} */
    const said = [];
    /** @type {string|null} */
    let exited = null;
    const child = spawnServer(String(config.start), { cwd: work, env });
    child.stdout?.on('data', (c) => said.push(c));
    child.stderr?.on('data', (c) => said.push(c));
    child.on('close', (code, signal) => {
      exited = `The app stopped before it answered - exit code ${code}${signal ? `, killed by ${signal}` : ''}.`;
    });

    // WHY THIS HANDS OVER SO MUCH. Measured on 2026-08-31 on a freshly scaffolded Vite app:
    // this wait took 90.6 seconds and then said "the server never answered on port 64912",
    // which names neither the command that was run nor the fact that the server was up the
    // whole time on the other loopback address. A whole `check --paired` on that app took
    // 3 minutes 2 seconds and reported nothing a person could act on. So the wait is now
    // given the command, everything the command has printed, and somewhere to say what it is
    // waiting for while it waits — that is what turns ninety seconds of silence into a
    // sentence, usually in the first second or two.
    const up = await waitForServer(port, {
      timeoutMs: config.startTimeoutMs ?? 90000,
      crashed: () => exited,
      command: String(config.start),
      announced: () => Buffer.concat(said).toString('utf8'),
      say: (message) => ctx.log?.(message),
    });
    if (!up.up) {
      await stopServer(child);
      // The app's own words go first, ahead of the wait's account of which loopback address it
      // knocked on. Same measurement, same date as the HTTP adapter's copy of this: the reason
      // a site will not boot is one line the runtime printed, the sentence built from this is
      // trimmed to 160 characters where a person reads it, and anything after the first
      // sentence was therefore never seen by anybody.
      const printed = Buffer.concat(said).toString('utf8');
      const headline = whatItSaid(printed, { mostLines: 1 });
      return {
        build,
        root: work,
        ready: false,
        why: `${headline ? `It said: ${headline}. ` : ''}${up.why} What it printed while trying, in full: ${
          trimForStorage(printed, 1500).text || '(nothing)'
        }`,
        dispose: async () => {
          await stopServer(child);
          await fsp.rm(base, { recursive: true, force: true });
        },
      };
    }

    // The address that ANSWERED, not the address that was assumed. A server told to listen on
    // `localhost` lands on whichever of the two loopback addresses this machine resolves that
    // name to, and on this Mac that is the IPv6 one — so handing the browser a hard-coded
    // `http://127.0.0.1:...` would open a page that cannot load even though the app is up.
    const baseUrl = up.baseUrl ?? `http://127.0.0.1:${port}`;
    running.set(build.id, { base, baseUrl, port, child, config, playwright, paired: true, work, home, tmp });
    return {
      build,
      root: work,
      ready: true,
      why: `${copy.why} It came up at ${baseUrl} in ${timeBucket(up.ms)}, in a browser profile nobody else is using.${notes.length > 0 ? ` ${notes.join(' ')}` : ''}`,
      facts: { baseUrl, port, paired: true },
      dispose: async () => {
        const held = running.get(build.id);
        running.delete(build.id);
        if (!held) return;
        // Only ever the process we started ourselves.
        await stopServer(held.child);
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
          channel: 'meaning',
          path: joinPath('screen', journey.name, 'opened at all'),
          reason: /playwright|chromium|browser/i.test(build.why) ? 'missing tool' : 'crashed',
          says: `"${journey.describe}" was not walked: ${build.why}`,
        }),
      ];
    }

    const config = held.config ?? {};
    const steps = /** @type {Record<string, any>[]} */ (journey.steps ?? []);
    const unfilled = steps.flatMap((s) => /** @type {string[]} */ (s.unfilled ?? []));
    if (unfilled.length > 0) {
      return [
        notCovered({
          channel: 'meaning',
          path: joinPath('screen', journey.name, 'opened at all'),
          reason: 'needs a sample',
          says: `${journey.name} was not opened, because nobody has said what ${unfilled.map((p) => `"${p}"`).join(' and ')} should be. Put a real value under "web.samples" in the settings and this page starts being checked.`,
        }),
      ];
    }

    /** @type {Observation[]} */
    const out = [];
    if (held.paired === false) {
      out.push(
        notCovered({
          channel: 'meaning',
          path: joinPath('screen', journey.name, 'which build this was'),
          reason: 'not supported here',
          says: 'Both builds were read from the same running app, because the settings give an address but no command to start it. Everything below is a true description of whatever is running at that address - it just is not evidence about the change, because the same app answered both times. Add a "start" command under "web" and this becomes a real comparison.',
        }),
      );
    }

    const viewport = viewportFrom(config);
    const window = await openWindow({
      chromium: held.playwright.chromium,
      // Which browser was chosen for this machine. Without it a driver that downloads no
      // browser of its own looks for one that is not there.
      executable: held.playwright.executable,
      scratchDir: ctx.scratchDir,
      viewport,
      colorScheme: config.colorScheme ?? 'light',
      label: journey.name,
    });

    /** @type {{dirs: string[], ports: number[], projectRoot?: string}} */
    const footprint = { dirs: [held.base, held.tmp, held.home].filter(Boolean), ports: [held.port].filter(Boolean), projectRoot: build.build.root };

    // Nothing below may run for ever. A browser can leave a promise pending with nothing
    // visibly wrong, and a journey that never finishes takes the whole check with it -
    // including the answers of every journey that already worked. So the walk gets a
    // deadline, and running out of it is reported the way every other hole is: as something
    // that was not checked, with the reason attached, never as a pass.
    const deadline = journey.timeoutMs ?? config.timeoutMs ?? 180000;
    /** @type {string|null} */
    let ranOut = null;

    try {
      const handle = window.handle;
      handle.baseUrl = held.baseUrl;

      // The freeze goes on BEFORE a single byte of the app is fetched. A frozen clock
      // applied after the app has booted is a clock the app already read.
      const frozen = await applyFreeze(
        handle,
        {
          clock: ctx.clock,
          seed: ctx.seed,
          timezone: config.timezone ?? 'UTC',
          locale: config.locale ?? 'en-US',
          network: config.network ?? 'block-external',
          networkAllow: config.allowHosts ?? [],
          hideScrollbars: true,
          hideCaret: true,
          settle: { frames: 2, intervalMs: 120, timeoutMs: config.settleTimeoutMs ?? 8000 },
        },
        { fixturesDir: ctx.evidenceDir, screenName: journey.name, deviceScaleFactor: viewport.deviceScaleFactor },
      );

      // The stopwatch starts HERE, not when this method was called. Everything before this
      // line - downloading nothing, launching a browser, freezing it - is our own time, and
      // it is cold on the first walk of a run and warm afterwards. Timing that would report
      // "this got slower" about the first journey of every single run, which is a lie the
      // wobble measurement should not have to keep cleaning up after.
      const started = Date.now();

      const wire = await watchTheWire(window.page, {
        baseUrl: held.baseUrl,
        refuse: config.refuse ?? [],
        allow: config.allowed ?? [],
        allowWrites: config.allowWrites === true,
        allowIrreversible: ctx.allowIrreversible === true,
      });

      /** @type {string[]} */
      const did = [];
      /** @type {Set<string>} */
      const taken = new Set();

      /**
       * @param {string} name
       * @returns {Promise<void>}
       */
      const checkpoint = async (name) => {
        let id = name;
        for (let n = 2; taken.has(id); n += 1) id = `${name} ${n}`;
        taken.add(id);
        out.push(...(await lookAt({ page: window.page, handle, journey, checkpoint: id, ctx, config, held, footprint, buildId: build.build.id })));
      };

      const walked = withLimit(
        (async () => {
          for (let i = 0; i < steps.length; i += 1) {
            const step = steps[i];
            did.push(...(await runStep(handle, step, { baseUrl: held.baseUrl })));
            const named = step.name ?? step.checkpoint;
            if (named) await checkpoint(String(named));
            else if (config.everyStep === true && i < steps.length - 1) await checkpoint(`after ${i + 1} ${actOf(step)}`);
          }
          // Always one at the end, and by default only one: a checkpoint per step reads well
          // until somebody inserts a step, at which point every address after it is renamed
          // and one small change reports as hundreds. Name a step, or switch "everyStep" on,
          // to look in the middle as well.
          await checkpoint('end');
          return 'finished';
        })(),
        deadline,
        'ran out of time',
      );
      if ((await walked) === 'ran out of time') {
        ranOut = `"${journey.describe}" did not finish within ${timeBucket(deadline)}. It got as far as: ${did.join(', ') || 'opening the browser'}. Everything it did manage to look at is below; the rest was not checked.`;
      }

      await wire.settled();
      out.push(...describeTraffic(journey, wire.calls(), footprint));
      out.push(...describeComplaints(journey, handle.consoleErrors()));

      out.push(
        howLongItTook({
          channel: 'counters',
          path: joinPath('count', journey.name, 'how long the steps took'),
          ms: Date.now() - started,
          what: `Walking the steps of "${journey.name}"`,
          andAlso: 'This does not count opening the browser, which is our time and not the app\'s.',
          journey: journey.name,
        }),
      );

      if (ranOut) {
        out.push(
          notCovered({
            channel: 'meaning',
            path: joinPath('screen', journey.name, 'finished'),
            reason: 'timed out',
            says: ranOut,
          }),
        );
      }

      await wire.stop();
      // Undoing the freeze also talks to the browser, and a browser that has stopped
      // answering must not be able to hold the check open. It is being thrown away anyway.
      await withLimit(frozen.release(), 10000, undefined);
    } finally {
      // Only the window we opened ourselves, and always, even when a step threw.
      await window.close();
    }

    return out;
  },

  async teardown() {
    for (const [, held] of running) await stopServer(held.child);
    running.clear();
  },
});

// ---------------------------------------------------------------------------
// One checkpoint
// ---------------------------------------------------------------------------

/**
 * Hold still, then write down everything the screen means.
 *
 * `settle` is the one that makes this trustworthy: it photographs, photographs again, and
 * only carries on once two pictures in a row agree. Everything else in the freeze layer
 * removes a REASON for the page to move; this waits for the ones nobody thought of - a late
 * render, a font swapping in, a chart drawing itself, an image that turns up on a timer.
 * Reading the meaning tree before the page has stopped moving is how a tool ends up
 * reporting a control that was simply not painted yet.
 *
 * @param {object} input
 * @param {any} input.page
 * @param {any} input.handle
 * @param {Journey} input.journey
 * @param {string} input.checkpoint
 * @param {import('./contract.js').RunContext} input.ctx
 * @param {Record<string, any>} input.config
 * @param {any} input.held
 * @param {{dirs: string[], ports: number[], projectRoot?: string}} input.footprint
 * @param {string} input.buildId
 * @returns {Promise<Observation[]>}
 */
async function lookAt(input) {
  const { handle, journey, checkpoint, footprint } = input;
  /** @type {Observation[]} */
  const out = [];
  const head = ['screen', journey.name, checkpoint];

  await prepareForShutter(handle, { fonts: true, timeoutMs: input.config.settleTimeoutMs ?? 10000 });

  /** @type {Buffer|null} */
  let png = null;
  try {
    const held = await settle(handle, {
      frames: 2,
      intervalMs: 120,
      timeoutMs: input.config.settleTimeoutMs ?? 8000,
      capture: () => handle.shoot(),
    });
    png = held.png;
  } catch {
    // A page that will not hold still is still worth reading. The picture is evidence; the
    // meaning is the check, and refusing to look because the picture wobbled would throw
    // away the whole finding to protect the least important channel.
  }

  const at = whereItIs(String(input.page.url()), input.held.baseUrl);
  out.push(
    observation({
      channel: 'meaning',
      path: joinPath(...head, 'where the browser ended up'),
      value: at,
      says: `After "${journey.describe}" the browser was at ${at}.`,
      journey: journey.name,
      surface: 'web',
    }),
  );

  const title = await input.page.title().catch(() => '');
  out.push(
    observation({
      channel: 'meaning',
      path: joinPath(...head, 'what the tab is called'),
      value: String(title),
      says: `The browser tab was called "${title}".`,
      journey: journey.name,
      surface: 'web',
    }),
  );

  /** @type {MeaningEntry[]} */
  let entries = [];
  try {
    entries = flattenAria(parseAria(await input.page.locator('body').ariaSnapshot()));
  } catch (error) {
    out.push(
      notCovered({
        channel: 'meaning',
        path: joinPath(...head, 'what the screen says'),
        reason: 'crashed',
        says: `The screen could not be read at "${checkpoint}": ${error instanceof Error ? error.message : String(error)}. Nothing about this checkpoint is being claimed either way.`,
      }),
    );
  }

  for (const entry of entries) {
    const where = joinPath(...head, 'tree', ...entry.at);
    out.push(
      observation({
        channel: 'meaning',
        path: where,
        value: typeof entry.value === 'string' ? undoOurFootprint(entry.value, footprint) : entry.value,
        says: entry.describe,
        journey: journey.name,
        surface: 'web',
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
          surface: 'web',
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
        says: `There ${howMany === 1 ? 'was 1' : `were ${howMany}`} ${role}${howMany === 1 ? '' : 's'} on the screen. Small counts are exact, because three going to four IS the finding; big ones are rounded, because they are not.`,
        journey: journey.name,
        surface: 'web',
      }),
    );
  }
  out.push(
    observation({
      channel: 'counters',
      path: joinPath('count', journey.name, checkpoint, 'everything on the screen'),
      value: countBucket(entries.length),
      says: `${entries.length} things on the screen had a role and a name a person could act on.`,
      journey: journey.name,
      surface: 'web',
    }),
  );

  if (png) {
    // The build id goes in the name because both builds write into one evidence folder,
    // and a picture of the change overwriting the picture of what it changed FROM is the one
    // way this folder could be worse than useless.
    const file = path.join(input.ctx.evidenceDir, `${fileSafe(`${input.buildId}-${journey.name}-${checkpoint}`)}.png`);
    await fsp.writeFile(file, png).catch(() => {});
    const ink = inkOf(png);
    out.push(
      observation({
        channel: 'pixels',
        path: joinPath('picture', journey.name, checkpoint),
        value: { wide: ink.wide, tall: ink.tall, 'how full the screen is': ink.ink },
        says: `The screen was ${ink.wide} by ${ink.tall} and ${ink.ink}. The picture itself is kept as evidence and is never compared - only whether anything was drawn at all, which is the one thing no other channel can see. It is ${sizeBucket(png.length)}.`,
        evidence: file,
        journey: journey.name,
        surface: 'web',
      }),
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Traffic and complaints
// ---------------------------------------------------------------------------

/**
 * Everything the page sent, and what came back.
 *
 * The half a screen comparison misses entirely: a page that still shows the right thing and
 * has quietly stopped saving it looks perfect in every other channel.
 *
 * @param {Journey} journey
 * @param {WireCall[]} calls
 * @param {{dirs: string[], ports: number[], projectRoot?: string}} footprint
 * @returns {Observation[]}
 */
export function describeTraffic(journey, calls, footprint) {
  /** @type {Observation[]} */
  const out = [];
  /** Addresses that only exist because of a request WE cancelled. See below. */
  const ourOwnFootprint = [];
  for (const call of calls) {
    const asked = `${call.method} ${call.pattern}`;
    const where = joinPath('net', journey.name, asked);

    // A REQUEST OUR OWN TEARDOWN CANCELLED IS NOT PART OF THE PRODUCT'S ADDRESS LIST.
    //
    // Next.js starts a prefetch behind every internal link, on its own, with nobody asking.
    // Closing the page cancels whatever is still in flight. Whether a given prefetch got far
    // enough to become a call at all is therefore a race between it and our own teardown — so
    // the ADDRESSES it produces exist on one pass of a build and not on the other. Measured
    // 2026-08-31 across eight runs a side: with nothing timing out the total is 852 every time,
    // and about 90 of those 852 — roughly one in nine — were reached by only one of the two
    // passes. Two byte-identical passes disagreeing about which addresses exist is the
    // measurement contradicting its own method.
    //
    // An earlier fix stopped these being reported as the product complaining, which killed the
    // phantom findings; it could not stop them moving the count, because the address is still
    // created on the pass that saw it. This is that fix taken one step further: the whole call
    // contributes nothing, because none of it is a fact about the product — it is a fact about
    // when we closed the browser. Nothing is dropped silently: how many there were, and which,
    // is said in one observation at a fixed address at the end of this function.
    if (call.unfinishedAtTeardown && !call.refused && !call.failed) {
      ourOwnFootprint.push(asked);
      continue;
    }

    if (call.refused) {
      out.push(
        notCovered({
          channel: 'effects',
          path: where,
          reason: 'irreversible',
          says: `The page asked for ${asked} and was stopped at the wire. ${call.why} That it asked, and the shape of what it was sending, are compared; what would have come back is not, because it was never allowed to happen.`,
        }),
      );
      if (call.sends !== undefined) {
        out.push(
          observation({
            channel: 'effects',
            path: `${where}.what it was sending`,
            value: call.sends,
            says: `The fields the page was sending to ${asked}, and what type each one is. The values are not kept - they are somebody's name and address; the shape is the promise, and a field that disappeared from it is a real break.`,
            journey: journey.name,
            surface: 'web',
          }),
        );
      }
      continue;
    }

    out.push(
      observation({
        channel: 'effects',
        path: where,
        value: { 'asked for': countBucket(call.times), what: call.kind },
        says: `The page asked for ${asked}${call.times > 1 ? ` ${call.times} times` : ''}. A call that used to go out and no longer does is one of the most common ways a page keeps looking right while having stopped working.`,
        journey: journey.name,
        surface: 'web',
      }),
    );
    if (call.sends !== undefined) {
      out.push(
        observation({
          channel: 'effects',
          path: `${where}.what it sends`,
          value: call.sends,
          says: `The fields the page sends to ${asked}, and what type each one is. The values themselves are not kept.`,
          journey: journey.name,
          surface: 'web',
        }),
      );
    }
    if (call.failed) {
      out.push(
        observation({
          channel: 'complaints',
          path: `${where}.never finished`,
          value: call.failed,
          says: `${asked} never finished: ${call.failed}.`,
          journey: journey.name,
          surface: 'web',
        }),
      );
    }
    if (call.status !== undefined) {
      out.push(
        observation({
          channel: 'results',
          path: joinPath('api', journey.name, asked, 'answered'),
          value: call.status,
          says: `${asked} answered ${call.status}${call.status >= 400 ? ', which is a refusal' : ''}.`,
          journey: journey.name,
          surface: 'web',
        }),
      );
    }
    if (call.shape !== undefined) {
      out.push(
        observation({
          channel: 'results',
          path: joinPath('api', journey.name, asked, 'the fields it sends back'),
          value: call.shape,
          says: `The fields ${asked} sends back and what type each one is. This holds still while the values churn, so a renamed or dropped field shows up on its own instead of buried inside a diff of the whole answer.`,
          journey: journey.name,
          surface: 'web',
        }),
      );
    }
    if (call.answered !== undefined) {
      const value = typeof call.answered === 'string' ? undoOurFootprint(call.answered, footprint) : call.answered;
      out.push(
        observation({
          channel: 'results',
          path: joinPath('api', journey.name, asked, 'what it sent back'),
          value,
          says: `What ${asked} sent back.`,
          journey: journey.name,
          surface: 'web',
        }),
      );
    }
  }

  // Said out loud, at ONE address that does not move, rather than at an address per request.
  // The count and the list live in the sentence, which is never compared, so this can report a
  // different number on two passes without ever reporting a difference. It is a hole, and it is
  // named as one: something was being asked for and how it ended was never seen.
  if (ourOwnFootprint.length > 0) {
    const many = ourOwnFootprint.length !== 1;
    out.push(
      notCovered({
        channel: 'effects',
        path: joinPath('net', journey.name, 'requests still in flight when the walk ended'),
        reason: 'refused',
        says:
          `${ourOwnFootprint.length} request${many ? 's were' : ' was'} still in flight when this walk ended, and ` +
          `${many ? 'they were' : 'it was'} cancelled by this tool closing the page rather than by anything the ` +
          `product did — a framework that prefetches behind every link starts these on its own. How ${many ? 'they' : 'it'} ` +
          `would have finished was never seen: ${ourOwnFootprint.sort().slice(0, 8).join(', ')}` +
          `${ourOwnFootprint.length > 8 ? `, and ${ourOwnFootprint.length - 8} more` : ''}. ` +
          `Each one is kept out of the address list on purpose, because whether a cancelled request got far enough ` +
          `to make an address is a race with our own teardown, and two passes of one build must not disagree about ` +
          `which addresses exist.`,
        }),
    );
  }
  return out;
}

/**
 * What the page complained about.
 *
 * Addressed by a stripped-down version of the message rather than by the order the messages
 * arrived in, so a new error is a new address and an existing one stays where it is however
 * many others turn up around it.
 *
 * @param {Journey} journey
 * @param {string[]} messages
 * @returns {Observation[]}
 */
export function describeComplaints(journey, messages) {
  /** @type {Map<string, {text: string, times: number}>} */
  const grouped = new Map();
  for (const message of messages) {
    const key = complaintKey(message);
    const found = grouped.get(key);
    if (found) found.times += 1;
    else grouped.set(key, { text: message, times: 1 });
  }
  return [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, held]) =>
      observation({
        channel: 'complaints',
        path: joinPath('log', journey.name, key),
        value: held.text,
        says: `The page complained: ${short(held.text, 160)}`,
        journey: journey.name,
        surface: 'web',
      }),
    );
}

/**
 * The shape of a complaint, with everything that changes between runs taken out of it.
 * Two runs of the same broken code produce the same key; the message itself is the value.
 *
 * @param {string} message
 * @returns {string}
 */
export function complaintKey(message) {
  return (
    short(
      String(message)
        .replace(/https?:\/\/[^\s)'"]+/g, 'an address')
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'an id')
        .replace(/\b\d+\b/g, 'a number')
        .replace(/\s+/g, ' ')
        .trim(),
      70,
    ) || 'something it would not say'
  );
}

/**
 * A name a picture can be saved under.
 *
 * Cut with a fingerprint on the end, never cut alone. This is a FILE name: two checkpoints
 * whose names agreed for eighty characters were saved over each other, so the picture
 * offered as evidence for one finding was a photograph of a different screen — and nothing
 * about it looked wrong. Long file names are the normal case here, because the name is the
 * build, the journey and the checkpoint run together.
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
