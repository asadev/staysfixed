/**
 * `staysfixed check` — the one command people actually run.
 *
 * Results are printed the moment each one lands, because a run that goes quiet
 * for two minutes feels broken. The summary at the end is the part that matters.
 */

import { loadProject } from '../core/config.js';
import { runCheck } from '../run.js';
import { printPictureResult, printGuardResult, printRunSummary } from '../report/console.js';
import { setLogLevel } from '../core/log.js';
import { EXIT } from '../core/errors.js';

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
    tool: ctx.version,
  });

  /** @type {import('../types.js').RunSummary} */
  const summary = await runCheck(project, opts);

  if (asJson) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    for (const picture of summary.pictures ?? []) showPicture(picture);
    for (const guard of summary.guards ?? []) showGuard(guard);
    printRunSummary(summary, project);
  }

  return summary.ok ? EXIT.ok : EXIT.failed;
}
