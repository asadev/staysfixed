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
  // 0.05% of pixels. On a 1440x900 @2x picture that is about 1300 pixels — enough
  // for font hinting noise, nowhere near enough to hide a missing stylesheet.
  pixels: 0.0005,
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
 * Find, import and resolve the config.
 * @param {{cwd?: string, configFile?: string}} [opts]
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
  const config = resolveConfig(raw, file);
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
 * @returns {import('../types.js').ResolvedConfig}
 */
export function resolveConfig(raw, file = '(inline)') {
  if (!raw || typeof raw !== 'object') {
    throw new StaysFixedError(`${path.basename(file)} did not export a config object.`, {
      hint: 'It should `export default { app: { ... }, screens: [ ... ] }`.',
    });
  }
  const c = /** @type {import('../types.js').StaysFixedConfig} */ (raw);

  if (!c.app || typeof c.app !== 'object') {
    // Every command that lands here — status, walk, approve, mark, trace, flake, and
    // `check --pictures` — works by OPENING something and photographing it. A settings
    // file with no `app` in it is the normal, correct shape for a command-line tool, a
    // library or a server: there is nothing to open, and telling somebody to go and add a
    // web address they do not have sends them off inventing one. So the message says which
    // half of the tool needs it, and names the half that does not.
    const anything = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (c));
    const notVisual = ['process', 'http', 'source', 'android', 'ios', 'windows'].filter((k) => anything[k] && typeof anything[k] === 'object');
    throw new StaysFixedError('These settings do not name anything to open, and this command works by opening your product and photographing it.', {
      hint: notVisual.length
        ? `That is the right shape for what this project is — ${notVisual.join(', ')} settings need nothing to open. Run \`staysfixed check\`, which covers it without a picture. If there IS a screen here too, add \`app: { kind: 'web', url: 'http://localhost:3000' }\` or \`app: { kind: 'electron', binary: '...' }\`.`
        : "Add `app: { kind: 'web', url: 'http://localhost:3000' }` or `app: { kind: 'electron', binary: '...' }`. If your product has no screen at all, `staysfixed check` covers it without one.",
    });
  }
  const kind = c.app.kind;
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
