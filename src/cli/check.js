/**
 * `staysfixed check` — the one command people actually run.
 *
 * Results are printed the moment each one lands, because a run that goes quiet
 * for two minutes feels broken. The summary at the end is the part that matters.
 *
 * With `--watch` the same run is also drawn in a panel beside the app. The panel
 * is a listener and nothing more: it reads the event stream, it never touches the
 * app being photographed, and if it fails to open the run carries on without it.
 *
 * The app it belongs beside is opened inside the run, so the run hands it over
 * through `onApp` and the panel snaps itself flush against that window. Moving
 * windows around a desk is all that is: `--no-snap` turns even that off.
 */

import { loadProject } from '../core/config.js';
import { runCheck } from '../run.js';
import { makeEvents, makeTimings } from '../core/events.js';
import { attachWatcher, watchOptionsFrom } from '../watch/index.js';
import { printPictureResult, printGuardResult, printRunSummary } from '../report/console.js';
import { setLogLevel, warn } from '../core/log.js';
import { EXIT, messageOf } from '../core/errors.js';
import { watchFlags, watchSettings } from './index.js';

/**
 * @param {import('./index.js').CliContext} ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  const asJson = ctx.bool('json');
  // With --json the only thing on stdout may be the JSON itself.
  if (asJson) setLogLevel({ quiet: true, verbose: false });

  const project = await loadProject({ cwd: ctx.cwd, configFile: ctx.configFile });

  const onlyGuards = ctx.bool('guards');
  const onlyPictures = ctx.bool('pictures');
  const profile = ctx.bool('profile');

  /**
   * `--no-snap` is read here rather than in the shared flag reader because it is
   * the only panel flag that says "change nothing at all", and it has to reach
   * the panel from both commands identically.
   * @type {import('../watch/index.js').WatchFlags}
   */
  const wanted = { ...watchFlags(ctx) };
  if (ctx.flags.snap !== undefined) wanted.snap = ctx.flags.snap === true;

  let watching = wanted.enabled === true;
  if (watching && asJson) {
    // One asks for a window to look at, the other asks for output a script can
    // read. Saying so is better than quietly picking one.
    warn('--watch and --json want opposite things: a window to look at, and output for a script. Carrying on without the panel.');
    watching = false;
  }

  /** Printed once, whether it arrived live or only in the summary. */
  const shown = new Set();

  /** @param {import('../types.js').PictureResult} result */
  const showPicture = (result) => {
    const key = `picture:${result.name}`;
    if (shown.has(key)) return;
    shown.add(key);
    if (!asJson) printPictureResult(result);
  };

  /** @param {import('../types.js').GuardResult} result */
  const showGuard = (result) => {
    const key = `guard:${result.name}`;
    if (shown.has(key)) return;
    shown.add(key);
    if (!asJson) printGuardResult(result);
  };

  const events = makeEvents();
  const timings = makeTimings();

  // The panel has to be listening before the run starts, or it misses the plan
  // and the first screen. A panel that will not open is a disappointment, never
  // a failed check: the whole point of the run is the pictures.
  /** @type {import('../watch/index.js').Watcher|null} */
  let watcher = null;
  if (watching) {
    try {
      watcher = await attachWatcher(events, { project, watch: watchOptionsFrom(watchSettings(project), wanted) });
    } catch (error) {
      watching = false;
      warn(`The panel could not open, so the run is going ahead without it. ${messageOf(error)}`);
    }
  }
  // Held as a const so the run's callback below cannot be handed a null later.
  const panel = watcher;

  const opts = /** @type {any} */ ({
    only: ctx.list('only'),
    // These names are the contract runCheck reads. They were `pictures` and `guards`
    // here once, which typechecked fine and silently did nothing: `--guards` still
    // photographed all thirteen screens.
    guardsOnly: onlyGuards && !onlyPictures,
    picturesOnly: onlyPictures && !onlyGuards,
    record: ctx.bool('record'),
    writeReport: ctx.flags.report !== false && !asJson,
    onPicture: showPicture,
    onGuard: showGuard,
    events,
    timings,
    // Only true when a panel really is up: it is what tells the run whether the
    // extra work of making thumbnails is worth doing.
    watching,
    // How the panel meets the app: called once, the moment the app is open and
    // before anything is photographed.
    onApp: panel ? (/** @type {import('../types.js').LaunchedApp} */ app) => panel.snapTo(app) : undefined,
    tool: ctx.version,
  });

  /** @type {import('../types.js').RunSummary} */
  let summary;
  try {
    summary = await runCheck(project, opts);
  } finally {
    if (watcher) {
      try {
        await watcher.stop();
      } catch {
        // A panel that will not close is not a reason to change the verdict.
      }
    }
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    for (const picture of summary.pictures ?? []) showPicture(picture);
    for (const guard of summary.guards ?? []) showGuard(guard);
    printRunSummary(summary, project, { profile, timings: profile ? timings.get() : undefined });
  }

  return summary.ok ? EXIT.ok : EXIT.failed;
}
