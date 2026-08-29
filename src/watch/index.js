/**
 * The live watch window, from the run's point of view.
 *
 * A run describes itself into an event stream and carries on. This subscribes to
 * that stream, opens a panel beside the app, and forwards everything to it. It
 * has no other effect on the run: it takes nothing away from it, it holds
 * nothing up, and when the window cannot open the run does not notice.
 *
 * Because the stream hands a new listener everything that already happened, a
 * panel that takes two seconds to open still draws the screens photographed
 * before it was there.
 *
 * The panel opens before the run does, and the app it belongs beside is opened
 * inside the run — so the two are introduced afterwards, through `snapTo`. That
 * is the whole of the seam: the run says "here is the app", the panel moves
 * itself flush against it, and nothing about the app's page is touched either way.
 */

import path from 'node:path';

import { warn, detail } from '../core/log.js';
import { messageOf } from '../core/errors.js';
import { loadGuards } from '../guard/load.js';
import { openPanel } from './window.js';

/** Panel width when nobody says otherwise. */
const DEFAULT_WIDTH = 460;

/**
 * What the panel is told to do.
 *
 * `snap` is written down here rather than in `src/types.js` so that whether the
 * two windows are pushed together stays a decision of the watch code. When
 * `WatchOptions` grows a `snap` of its own this intersection quietly becomes a
 * no-op.
 *
 * @typedef {import('../types.js').WatchOptions & {snap?: boolean}} PanelOptions
 */

/**
 * What the CLI hands over. Anything the person did not type is left out, so the
 * settings file still gets a say.
 * @typedef {object} WatchFlags
 * @property {boolean} [enabled]
 * @property {'left'|'right'} [side]
 * @property {number} [width]
 * @property {number} [height]
 * @property {boolean} [keepOpen]
 * @property {boolean} [foreground]
 * @property {boolean} [snap]
 * @property {'dark'|'light'|'system'} [theme]
 */

/**
 * @typedef {object} AttachOptions
 * @property {import('../types.js').Project} [project]
 * @property {import('./window.js').PlanInput} [plan]  Given only when the caller knows better than the project does.
 * @property {PanelOptions} [watch]
 * @property {{width: number, height: number}} [appViewport]
 */

/**
 * A run's handle on its panel.
 *
 * `snapTo` is how the run introduces the app once it is open. It is safe to call
 * when there is no panel, when the panel cannot move windows, and when the
 * person asked for `--no-snap`: in every one of those cases it does nothing.
 *
 * @typedef {object} Watcher
 * @property {() => Promise<void>} stop
 * @property {(app: import('../types.js').LaunchedApp) => Promise<void>} snapTo
 */

/**
 * The one part of a panel this file asks for by name.
 *
 * `snapTo` is built in `window.js` and is optional here on purpose: a panel that
 * cannot move windows is still a perfectly good panel, and is simply never asked
 * to move.
 *
 * @typedef {{snapTo?: (app: import('../types.js').LaunchedApp) => Promise<void>}} Snappable
 */

/**
 * A watcher that is not watching anything. Handed back whenever the panel could
 * not open, so every caller has the same shape to stop, whatever happened.
 * @returns {Watcher}
 */
function noWatcher() {
  return { stop: async () => {}, snapTo: async () => {} };
}

/**
 * The guards, for the opening list.
 *
 * They live in files, so this reads the folder the same way the run will. It is
 * cheap, and it is the difference between a window that shows the whole plan
 * from the first frame and one that fills in as it goes. A guards folder that
 * will not load is the run's problem to report, not the panel's — here it just
 * means the guards appear as they start.
 *
 * @param {import('../types.js').Project|undefined} project
 * @returns {Promise<import('./panel.js').PanelRow[]>}
 */
async function guardRows(project) {
  if (!project) return [];
  try {
    const guards = await loadGuards(project);
    return guards
      .filter((guard) => guard && guard.skip !== true)
      .map((guard) => ({ name: String(guard.name), describe: guard.because ? String(guard.because) : undefined }));
  } catch {
    return [];
  }
}

/**
 * @param {import('../types.js').Project|undefined} project
 * @returns {import('./panel.js').PanelRow[]}
 */
function screenRows(project) {
  const screens = project?.config?.screens ?? [];
  return screens
    .filter((screen) => screen && screen.skip !== true)
    .map((screen) => ({ name: String(screen.name), describe: screen.describe ? String(screen.describe) : undefined }));
}

/**
 * @param {AttachOptions} opts
 * @returns {Promise<import('./window.js').PlanInput>}
 */
async function planFor(opts) {
  const given = opts.plan ?? {};
  const project = opts.project;
  return {
    project: given.project ?? (project ? path.basename(project.paths.root) : undefined),
    app: given.app ?? project?.config?.app,
    screens: given.screens ?? screenRows(project),
    guards: given.guards ?? (await guardRows(project)),
  };
}

/**
 * Open a panel and point it at a run.
 *
 * Never throws. A live view is worth having and worth nothing next to the
 * pictures, so every way this can go wrong ends the same way: a warning in
 * plain words, a watcher that does nothing, and a run that carries on.
 *
 * @param {import('../types.js').RunEvents} events
 * @param {AttachOptions} [opts]
 * @returns {Promise<Watcher>}
 */
export async function attachWatcher(events, opts = {}) {
  const watch = opts.watch ?? {};
  if (watch.enabled === false) return noWatcher();
  if (!events || typeof events.on !== 'function') return noWatcher();

  /** @type {import('./window.js').Panel|null} */
  let panel = null;
  try {
    panel = await openPanel({
      project: opts.project,
      plan: await planFor(opts),
      watch,
      appViewport: opts.appViewport ?? opts.project?.config?.viewport,
    });
  } catch (e) {
    // openPanel reports its own trouble and hands back null; this is only here
    // for whatever it could not have seen coming.
    warn(`The watch window could not open, so this run has no live view. ${messageOf(e)}`);
    panel = null;
  }
  if (!panel) return noWatcher();
  const open = panel;

  // Everything that already happened arrives here first, in order, before the
  // first live event does.
  const unsubscribe = events.on((event) => {
    // Queued, never awaited: the run must not wait on a window.
    void open.push(event);
  });

  // `--no-snap` is honoured here, not in the panel, so that "leave both windows
  // exactly where they are" holds however the panel is built.
  const maySnap = watch.snap !== false;
  const snappable = /** @type {Snappable} */ (/** @type {unknown} */ (open));

  /** @type {Promise<void>|null} */
  let stopping = null;

  return {
    stop: () => {
      stopping ??= (async () => {
        try {
          unsubscribe();
        } catch {
          // Already gone. Nothing left to stop listening to.
        }
        await open.close().catch(() => {});
      })();
      return stopping;
    },

    snapTo: async (app) => {
      if (!maySnap || typeof snappable.snapTo !== 'function') return;
      try {
        await snappable.snapTo(app);
      } catch (e) {
        // Where two windows sit is a nicety. Losing it must never cost a run,
        // and it is not worth a warning in the middle of a clean one.
        detail(`The panel could not put itself beside the app. ${messageOf(e)}`);
      }
    },
  };
}

/**
 * Settle what the panel should do: the settings file first, then anything typed
 * on the command line, then the defaults written down in `src/types.js`.
 *
 * `--watch` can only ever turn the panel on. A person who did not type it has
 * not said no to it — they have said nothing — so it never switches off a panel
 * the settings file asked for.
 *
 * @param {{watch?: import('../types.js').WatchOptions|boolean}|null} [config]
 * @param {WatchFlags|null} [cli]
 * @returns {PanelOptions}
 */
export function watchOptionsFrom(config, cli) {
  const raw = config?.watch;
  // Read as a PanelOptions on the way in: a settings file is free to carry a
  // `snap` that the shared `WatchOptions` shape does not yet describe.
  const settings = /** @type {PanelOptions} */ (
    raw === true ? { enabled: true } : raw && typeof raw === 'object' ? raw : {}
  );
  const flags = cli ?? {};

  const width = firstNumber(flags.width, settings.width) ?? DEFAULT_WIDTH;
  const height = firstNumber(flags.height, settings.height);
  const side = flags.side ?? settings.side ?? 'right';
  const theme = /** @type {any} */ (flags).theme ?? settings.theme;

  /** @type {PanelOptions} */
  const merged = {
    enabled: flags.enabled === true || settings.enabled === true,
    width,
    side: side === 'left' ? 'left' : 'right',
    keepOpen: firstBoolean(flags.keepOpen, settings.keepOpen) ?? true,
    foreground: firstBoolean(flags.foreground, settings.foreground) ?? false,
    // On by default: the point of the panel is that it reads as a side panel of
    // the app it is checking, and it cannot do that sitting somewhere else.
    snap: firstBoolean(flags.snap, settings.snap) ?? true,
    // Dark unless somebody asks otherwise. The panel opens on a brand new browser
    // profile, and a fresh profile insists the computer is in light mode however it
    // is actually set, so this is stated rather than detected.
    theme: theme === 'light' || theme === 'system' ? theme : 'dark',
  };
  // Left out rather than guessed: with no height the panel is as tall as the app.
  if (height !== undefined) merged.height = height;
  return merged;
}

/**
 * @param {...unknown} values
 * @returns {number|undefined}
 */
function firstNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return undefined;
}

/**
 * @param {...unknown} values
 * @returns {boolean|undefined}
 */
function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}
