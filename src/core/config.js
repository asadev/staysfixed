/**
 * Loading, defaulting and validating a project's config.
 *
 * Two shapes are accepted on purpose:
 *  - staysfixed.config.js   — screens can use code (`do(page) { ... }`)
 *  - staysfixed.config.json — screens use declarative steps only
 *
 * The JSON form exists so a Rust, Python or Go project can use this tool
 * without anybody writing JavaScript.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StaysFixedError } from './errors.js';
import { findConfigFile, pathsFor, rootForConfig, DEFAULT_DIR } from './paths.js';

/** @type {Required<import('../types.js').ViewportConfig>} */
export const DEFAULT_VIEWPORT = {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
};

/** @type {Required<import('../types.js').SettleConfig>} */
export const DEFAULT_SETTLE = {
  frames: 2,
  intervalMs: 250,
  timeoutMs: 10_000,
  maxDriftPixels: 0,
};

/** @type {Required<Omit<import('../types.js').FreezeConfig,'settle'>> & {settle: Required<import('../types.js').SettleConfig>}} */
export const DEFAULT_FREEZE = {
  clock: '2026-01-01T12:00:00.000Z',
  timezone: 'UTC',
  locale: 'en-US',
  motion: true,
  random: 'seeded',
  seed: 20260101,
  fonts: true,
  network: 'block-external',
  networkAllow: [],
  hideScrollbars: true,
  hideCaret: true,
  settle: DEFAULT_SETTLE,
};

/** @type {Required<Omit<import('../types.js').ToleranceConfig,'maxPixels'>>} */
export const DEFAULT_TOLERANCE = {
  // Nothing is allowed through by default, and that is a change made after measuring.
  //
  // This used to be 0.0005 — 0.05% of the picture — with a comment saying it was "enough for
  // font hinting noise, nowhere near enough to hide a missing stylesheet". The first half was
  // a guess and the second half was wrong. On a 2880x1800 picture, 0.05% is **2,592 pixels**.
  // Changing `<h1>Welcome</h1>` to `<h1>Welcom</h1>` — one letter missing from the main
  // heading of the page, plainly visible to anybody looking at it — moves **593**. So the
  // check reported "Everything that worked still works" over a page that was visibly wrong.
  // That is the exact failure this tool exists to prevent, produced by the tool itself.
  //
  // The number that replaces it was measured rather than chosen. Ten fresh takes of the same
  // build, on a real page, compared against the approved picture: **zero differing pixels,
  // every time.** The freeze layer underneath — the stopped clock, the killed motion, the
  // seeded randomness, the pinned text rendering, and the settle loop that keeps shooting
  // until two frames come back identical — is what makes that true. Where nothing wobbles,
  // an allowance buys nothing at all and costs you the one thing you came for.
  //
  // Version 2 answers this properly by measuring each product's own wobble and subtracting
  // it, which is why it has no tolerance setting and never will. Version 1 cannot do that
  // without becoming version 2, so it does the honest next-best thing: allow nothing, and
  // let a project that genuinely wobbles say so out loud with `tolerance.pixels`. A run that
  // uses an allowance now says so, and says how much of it was used.
  pixels: 0,
  threshold: 0.12,
  antialiasing: true,
};

/** @type {Required<import('../types.js').McpConfig>} */
export const DEFAULT_MCP = {
  // An agent must never approve its own work. This default is the whole point.
  allowApprove: false,
  allowMark: false,
};

/**
 * The `app.kind` of a project that has nothing to open at all.
 *
 * A command-line tool, a library and a plain server are all perfectly ordinary products with
 * no screen anywhere in them, and every command that only READS what is on disk — status,
 * flake, mark, trace, approve — works on one exactly as well as it works on a website. They
 * were all refused anyway, because the only way to load settings was through a check that
 * insisted on something to open. This value is how a command says "I open nothing, so do not
 * ask", and it is a made-up word on purpose: nothing can accidentally match it, and anything
 * that reads it and does not understand it fails loudly rather than photographing a guess.
 */
export const NOTHING_TO_OPEN = 'nothing-to-open';

/**
 * Do these settings name anything this tool could open and photograph?
 *
 * Exported so a command can ask before it tries, and say something true about this project
 * instead of the same refusal for every shape of product.
 *
 * @param {import('../types.js').ResolvedConfig} config
 * @returns {boolean}
 */
export function hasSomethingToOpen(config) {
  // Read as a plain string on purpose. The declared shape of `app.kind` is version 1's two
  // words, and this third one is deliberately outside it — see NOTHING_TO_OPEN above.
  return /** @type {string} */ (config?.app?.kind) !== NOTHING_TO_OPEN;
}

/**
 * Find, import and resolve the config.
 * @param {{cwd?: string, configFile?: string, opening?: boolean}} [opts]
 *   `opening: false` is a command promising it will not open or photograph anything — it
 *   only reads what is already on disk. Settings with no screen in them are then a normal,
 *   correct shape rather than a reason to refuse.
 * @returns {Promise<import('../types.js').Project>}
 */
export async function loadProject(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const file = opts.configFile ? path.resolve(cwd, opts.configFile) : findConfigFile(cwd);
  if (!file) {
    throw new StaysFixedError('No Stays Fixed config found here.', {
      hint: 'Run `staysfixed init` in your project to make one.',
    });
  }
  const raw = await importConfig(file);
  const root = rootForConfig(file);
  const config = resolveConfig(raw, file, { opening: opts.opening });
  const paths = pathsFor(root, file, config.dir);
  // `guards` is the one folder a project is free to move, so the config wins over the
  // default layout. Without this the setting silently did nothing and the tool reported
  // "no guards yet" while staring straight at a folder full of them.
  paths.guards = path.isAbsolute(config.guards) ? config.guards : path.join(root, config.guards);
  return { config, paths };
}

/**
 * @param {string} file
 * @returns {Promise<unknown>}
 */
async function importConfig(file) {
  if (file.endsWith('.json')) {
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (cause) {
      throw new StaysFixedError(`Could not read ${path.basename(file)} — it is not valid JSON.`, { cause });
    }
  }
  try {
    // Cache-bust so a long-lived MCP server picks up config edits without restarting.
    const url = pathToFileURL(file).href + `?t=${(await fsp.stat(file)).mtimeMs}`;
    const mod = await import(url);
    return mod.default ?? mod.config ?? mod;
  } catch (cause) {
    throw new StaysFixedError(`Could not load ${path.basename(file)}.`, {
      hint: cause instanceof Error ? cause.message : undefined,
      cause,
    });
  }
}

/**
 * Fill in defaults and reject anything that would fail later in a confusing way.
 * @param {unknown} raw
 * @param {string} file
 * @param {{opening?: boolean}} [opts]
 *   `opening: false` from a command that only reads what is on disk. See {@link loadProject}.
 * @returns {import('../types.js').ResolvedConfig}
 */
export function resolveConfig(raw, file = '(inline)', opts = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new StaysFixedError(`${path.basename(file)} did not export a config object.`, {
      hint: 'It should `export default { app: { ... }, screens: [ ... ] }`.',
    });
  }
  const c = /** @type {import('../types.js').StaysFixedConfig} */ (raw);

  // Version 2's settings describe a website under `web:` and a desktop app under
  // `electron:`. These commands are version 1's and only ever knew about `app:` — so on the
  // settings file `staysfixed init` writes for a website, `status`, `walk` and `flake` all
  // answered "these settings do not name anything to open", and then listed `process,
  // source` as the shape of the project. `init` had said, one command earlier, "The website
  // can be checked here now ... watched by opening it in a throwaway browser". Both about
  // the same file, seconds apart, and `status` is the command whose whole promise is to say
  // instantly what is set up here.
  //
  // Where the address is actually knowable, take it and let the command work. Booting is
  // version 2's job and these commands cannot do it, so `web.start` alone is not enough —
  // that case falls through to the message below, which now says so honestly.
  const v2 = /** @type {Record<string, any>} */ (/** @type {unknown} */ (c));
  if ((!c.app || typeof c.app !== 'object')) {
    if (v2.web && typeof v2.web === 'object' && typeof v2.web.url === 'string' && v2.web.url) {
      c.app = { kind: 'web', url: v2.web.url };
    } else if (v2.electron && typeof v2.electron === 'object' && typeof v2.electron.binary === 'string' && v2.electron.binary) {
      c.app = { kind: 'electron', binary: v2.electron.binary };
    }
  }

  // The screens come across with the address, and they did not before.
  //
  // Half a bridge is worse than none: on a version 2 website `walk` and `approve` were
  // handed the address and then found nothing to photograph, because version 2 keeps its
  // screens under `web` and these commands only ever looked at the top level. So the
  // commands ran, opened a browser, and reported an empty walk of a site with six pages in
  // its settings — measured 2026-08-31. Only a screen with a name and a plain address is
  // carried over; anything reached by clicking is version 2's to walk, not this half's, and
  // inventing a journey out of one would put a screen in the report nobody can reach.
  if (c.app && typeof c.app === 'object' && !Array.isArray(c.screens)) {
    const fromV2 = Array.isArray(v2.web?.screens) ? v2.web.screens : [];
    const carried = fromV2.filter((/** @type {any} */ s) => s && typeof s.name === 'string' && typeof s.url === 'string' && s.url !== '');
    if (carried.length > 0) c.screens = carried.map((/** @type {any} */ s) => ({ name: s.name, url: s.url }));
  }

  // A command that opens nothing must never be refused for having nothing to open.
  //
  // `status`, `flake`, `mark`, `trace` and `approve` all do their whole job by reading files
  // this tool has already written. Every one of them was dead on the settings this tool's own
  // `init` writes for a command-line tool, a library or a server — five commands offered in
  // `--help`, all answering with a paragraph about an `app` key that version 2 never writes
  // and that nobody running them had ever seen. Measured 2026-08-31 on a Python command-line
  // tool and on a plain Node one; both were set up by `staysfixed init` seconds earlier.
  if ((!c.app || typeof c.app !== 'object') && opts.opening === false) {
    c.app = /** @type {any} */ ({ kind: NOTHING_TO_OPEN });
  }

  if (!c.app || typeof c.app !== 'object') {
    // Only the commands that really do open something land here now — `walk`, and
    // `check --pictures`. They photograph a screen, so a project with no screen anywhere in
    // it genuinely cannot be walked, and the honest thing is to say which product this is
    // and stop offering it.
    //
    // What this message must never do is name a key the person has not got. `app` is version
    // 1's word for the thing to open; the settings `staysfixed init` writes today have no
    // `app` in them and never will, so telling somebody to add one sends them editing a file
    // against a shape nothing else in the tool uses. Where there IS advice worth giving, it
    // is given in the words their own settings file already uses — `url` inside the `web`
    // block — and only for a file that is written that way.
    const anything = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (c));
    const versionTwo = ['process', 'source', 'http', 'web', 'electron', 'android', 'ios', 'windows']
      .filter((k) => anything[k] && typeof anything[k] === 'object');
    const notVisual = ['process', 'http', 'source', 'android', 'ios', 'windows'].filter((k) => versionTwo.includes(k));
    // A project that DOES have a screen, described the version 2 way, must never be told it
    // has none. It is told the true thing instead: this half of the tool photographs an
    // address you can point it at, and version 2 finds the address by booting the product,
    // which is why `check` covers it and these do not.
    const started = anything.web && typeof anything.web === 'object' && typeof (/** @type {any} */ (anything.web).start) === 'string';
    if (started) {
      throw new StaysFixedError('This project has a website, but these settings start it rather than name an address, and this command photographs an address.', {
        hint: "`staysfixed check` covers it exactly as it is — it boots `web.start` and finds the address itself. These picture commands need one they can point at, so add `url: 'http://localhost:3000'` beside `start` in the `web` block if you want them too.",
      });
    }
    if (versionTwo.length > 0) {
      throw new StaysFixedError(
        `This command photographs a screen, and this project has none — these settings describe ${plainList(versionTwo.map(describeBlock))}.`,
        {
          hint: `Nothing is missing and nothing needs adding. Run \`staysfixed check\`, which covers ${notVisual.length === versionTwo.length ? 'exactly what is here' : 'all of it'} without a picture.`
            + (versionTwo.includes('web') ? " If you want the picture commands on the site too, add `url: 'http://localhost:3000'` inside the `web` block so there is an address to point at." : ''),
        },
      );
    }
    throw new StaysFixedError('These settings do not name anything to open, and this command works by opening your product and photographing it.', {
      hint: "Add `app: { kind: 'web', url: 'http://localhost:3000' }` or `app: { kind: 'electron', binary: '...' }`. If your product has no screen at all, `staysfixed check` covers it without one.",
    });
  }
  // Read as a plain string, because a project with nothing to open carries a third value
  // that is deliberately outside version 1's two — see NOTHING_TO_OPEN at the top.
  const kind = /** @type {string} */ (c.app.kind);
  // A command that told us it opens nothing gets no further questions. Asking a project with
  // no screen for an address or a binary is the refusal this whole branch exists to stop.
  if (kind !== NOTHING_TO_OPEN) {
    if (kind !== 'web' && kind !== 'electron') {
      throw new StaysFixedError(`app.kind must be 'web' or 'electron' (found ${JSON.stringify(kind)}).`);
    }
    if (kind === 'web' && !c.app.url && !c.app.attach) {
      throw new StaysFixedError('A web app needs `app.url` — the address to open.');
    }
    if (kind === 'electron' && !c.app.binary && !c.app.attach) {
      throw new StaysFixedError('An Electron app needs `app.binary` — the path to the executable.', {
        hint: 'On macOS that is inside the bundle: /Applications/Your App.app/Contents/MacOS/Your App',
      });
    }
  }

  const screens = (c.screens ?? []).map((s, i) => resolveScreen(s, i));
  const names = new Set();
  for (const s of screens) {
    if (names.has(s.name)) {
      throw new StaysFixedError(`Two screens are both called "${s.name}". Screen names have to be unique.`);
    }
    names.add(s.name);
  }

  const freeze = {
    ...DEFAULT_FREEZE,
    ...(c.freeze ?? {}),
    settle: { ...DEFAULT_SETTLE, ...(c.freeze?.settle ?? {}) },
  };
  if (freeze.clock !== false && typeof freeze.clock === 'string' && Number.isNaN(Date.parse(freeze.clock))) {
    throw new StaysFixedError(`freeze.clock is not a time I can read: ${JSON.stringify(freeze.clock)}.`, {
      hint: "Use an ISO timestamp like '2026-01-01T12:00:00.000Z', or false to leave the clock alone.",
    });
  }
  if (freeze.network !== 'replay' && freeze.network !== 'block-external' && freeze.network !== 'live') {
    throw new StaysFixedError(`freeze.network must be 'replay', 'block-external' or 'live'.`);
  }

  return {
    ...c,
    app: { ...c.app, args: c.app.args ?? [], env: c.app.env ?? {} },
    viewport: { ...DEFAULT_VIEWPORT, ...(c.viewport ?? {}) },
    freeze,
    tolerance: { ...DEFAULT_TOLERANCE, ...(c.tolerance ?? {}) },
    masks: c.masks ?? [],
    screens,
    guards: c.guards ?? path.join(c.dir ?? DEFAULT_DIR, 'guards'),
    walk: c.walk ?? {},
    mcp: { ...DEFAULT_MCP, ...(c.mcp ?? {}) },
    dir: c.dir ?? DEFAULT_DIR,
    flakeLimit: c.flakeLimit ?? 2,
    retries: c.retries ?? 1,
    concurrency: Math.max(1, c.concurrency ?? 1),
  };
}

/**
 * @param {import('../types.js').ScreenConfig} s
 * @param {number} i
 * @returns {import('../types.js').ScreenConfig}
 */
function resolveScreen(s, i) {
  if (!s || typeof s !== 'object') {
    throw new StaysFixedError(`screens[${i}] is not an object.`);
  }
  if (!s.name || typeof s.name !== 'string') {
    throw new StaysFixedError(`screens[${i}] has no name. Every screen needs one, e.g. name: 'sessions-empty'.`);
  }
  if (!s.url && !s.steps && !s.do) {
    throw new StaysFixedError(`Screen "${s.name}" says nothing about how to get there.`, {
      hint: "Give it a `url`, a list of `steps`, or a `do(page)` function.",
    });
  }
  const steps = s.steps ? [...s.steps] : [];
  if (s.url) steps.unshift({ goto: s.url });
  return { ...s, steps };
}

/**
 * Merge a screen's overrides on top of the project settings.
 * @param {import('../types.js').ResolvedConfig} config
 * @param {import('../types.js').ScreenConfig} screen
 */
export function settingsForScreen(config, screen) {
  return {
    viewport: { ...config.viewport, ...(screen.viewport ?? {}) },
    tolerance: { ...config.tolerance, ...(screen.tolerance ?? {}) },
    freeze: {
      ...config.freeze,
      ...(screen.freeze ?? {}),
      settle: { ...config.freeze.settle, ...(screen.freeze?.settle ?? {}) },
    },
    masks: [...config.masks, ...(screen.masks ?? [])],
  };
}

/**
 * What one block of version 2 settings actually is, in words somebody who did not write this
 * tool would use. Said out loud in a refusal so the sentence names this project rather than
 * naming a missing key.
 *
 * @param {string} key
 * @returns {string}
 */
function describeBlock(key) {
  return /** @type {Record<string,string>} */ ({
    process: 'commands to run and libraries to import',
    source: 'code to read without running it',
    http: 'a server to boot and ask for its routes',
    web: 'a website to open',
    electron: 'a desktop app to open',
    android: 'an Android app',
    ios: 'an iPhone app',
    windows: 'a native Windows app',
  })[key] ?? key;
}

/**
 * A list a person reads out loud: "a, b and c". Two commas and an "and" beats three commas.
 * @param {string[]} items
 * @returns {string}
 */
function plainList(items) {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
