/**
 * `staysfixed walk` — the last look before a release.
 *
 * `--watch` opens the same live panel `check` uses, which is worth more here than
 * anywhere else: a walk is something you sit and look at. The panel snaps itself
 * flush against the app once the walk has opened it, so the two read as one
 * window; `--no-snap` leaves both where they are.
 */

import { spawn } from 'node:child_process';
import { loadProject } from '../core/config.js';
import { runWalk } from '../run.js';
import { makeEvents, makeTimings } from '../core/events.js';
import { attachWatcher, watchOptionsFrom } from '../watch/index.js';
import { printWalkReport, printTimings } from '../report/console.js';
import { say, warn, paint, shortPath } from '../core/log.js';
import { EXIT, messageOf } from '../core/errors.js';
import { watchFlags, watchSettings } from './index.js';

/**
 * @param {import('./index.js').CliContext} ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  const project = await loadProject({ cwd: ctx.cwd, configFile: ctx.configFile });

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

  const events = makeEvents();
  const timings = makeTimings();

  // Listening has to start before the walk does, or the panel misses the first
  // screen. It never gets to stop the walk: a panel is a nice-to-have.
  /** @type {import('../watch/index.js').Watcher|null} */
  let watcher = null;
  if (watching) {
    try {
      watcher = await attachWatcher(events, { project, watch: watchOptionsFrom(watchSettings(project), wanted) });
    } catch (error) {
      watching = false;
      warn(`The panel could not open, so the walk is going ahead without it. ${messageOf(error)}`);
    }
  }
  // Held as a const so the walk's callback below cannot be handed a null later.
  const panel = watcher;

  /** @type {import('../types.js').WalkReport} */
  let report;
  try {
    report = await runWalk(
      project,
      /** @type {any} */ ({
        only: ctx.list('only'),
        events,
        timings,
        watching,
        // How the panel meets the app: called once, the moment the app is open
        // and before anything is photographed.
        onApp: panel ? (/** @type {import('../types.js').LaunchedApp} */ app) => panel.snapTo(app) : undefined,
        tool: ctx.version,
      }),
    );
  } finally {
    if (watcher) {
      try {
        await watcher.stop();
      } catch {
        // A panel that will not close is not a reason to change the verdict.
      }
    }
  }

  printWalkReport(report);
  if (profile) printTimings(timings.get(), (report.steps ?? []).length);

  const sheet = report.reportFile || report.dir;
  if (ctx.bool('open')) {
    if (sheet) openIt(sheet);
    else warn('There is no contact sheet to open — the walk did not photograph anything.');
  } else if (sheet) {
    say(paint.grey(`  Open it with: staysfixed walk --open, or just open ${shortPath(sheet)}`));
  }

  return report.ok ? EXIT.ok : EXIT.failed;
}

/**
 * Hand the file to whatever the operating system uses to open things. It is
 * detached and ignored on purpose: the viewer outliving this command is the point.
 * @param {string} file
 * @returns {void}
 */
function openIt(file) {
  /** @type {[string, string[]]} */
  const opener =
    process.platform === 'darwin'
      ? ['open', [file]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', file]]
        : ['xdg-open', [file]];
  const [command, args] = opener;
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => warn(`Could not open it for you. The file is at ${shortPath(file)}`));
    child.unref();
  } catch {
    warn(`Could not open it for you. The file is at ${shortPath(file)}`);
  }
}
