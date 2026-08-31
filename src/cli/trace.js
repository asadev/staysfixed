/**
 * `staysfixed trace` — "when did this stop looking right?"
 */

import { loadProject } from '../core/config.js';
import { projectStatus } from '../run.js';
import { traceScreens } from '../marker/trace.js';
import { printTrace } from '../report/console.js';
import { say, blank, paint } from '../core/log.js';
import { resultPicture } from '../core/paths.js';
import { sha256File } from '../core/hash.js';
import { EXIT } from '../core/errors.js';

/**
 * @param {import('./index.js').CliContext} ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  // `opening: false` — tracing compares fingerprints already written down against markers
  // already written down. It opens nothing. Where there is nothing recorded to trace, the
  // report says so in its own words further down; being refused before it could even look
  // was the wrong answer, and it named a settings key that version 2 never writes.
  const project = await loadProject({ cwd: ctx.cwd, configFile: ctx.configFile, opening: false });

  const asked = ctx.args.filter((a) => a.trim() !== '');
  const changed = asked.length > 0 ? [] : await changedInLastRun(project);
  const names = asked.length > 0 ? asked : changed;

  // A project with nothing to photograph cannot be traced, and it is owed a sentence saying
  // why rather than a shrug and a suggestion it has already followed.
  //
  // The generic ending is "There is nothing to trace yet. Pin a good version first with
  // `staysfixed mark`." — which, on a project that had just pinned one, told somebody to go
  // and do the thing they had done thirty seconds earlier. Measured 2026-08-31 on a Python
  // command-line tool. Tracing follows a SCREEN backwards, so on a product with no screen
  // the answer is not "not yet", it is "not this kind of project", and saying the second one
  // stops somebody working through a list that was never going to end.
  if (asked.length === 0 && names.length === 0 && project.config.screens.length === 0) {
    blank();
    say('There is no screen in this project to trace.');
    say(paint.grey('Tracing follows one screen back through your markers to the commit where it stopped'));
    say(paint.grey('looking right, so it needs a picture to follow. These settings name none.'));
    blank();
    say(`For what changed in a project without a screen, run ${paint.cyan('staysfixed check')} — it compares every`);
    say('word a command printed, what it exited with and every file it touched.');
    blank();
    return EXIT.ok;
  }

  if (asked.length === 0) {
    if (names.length === 0) {
      say(paint.grey('Nothing is different right now, so this looks at every screen there is a record of.'));
    } else {
      say(paint.grey(`Tracing what the last check said had changed: ${names.join(', ')}`));
    }
  }

  // When a screen has just gone wrong, the picture worth tracing is the one the
  // failing run took — not the approved one, which is by definition the old, good
  // version and would trace as "nothing has changed".
  const current = await fingerprintsOfLastRun(project, names);

  /** @type {{names?: string[], current?: Record<string,string>}} */
  const options = { names };
  if (Object.keys(current).length > 0) options.current = current;

  const report = await traceScreens(project, options);

  printTrace(report);
  return report.findings.some((f) => f.verdict === 'changed') ? EXIT.failed : EXIT.ok;
}

/**
 * @param {import('../types.js').Project} project
 * @returns {Promise<string[]>}
 */
async function changedInLastRun(project) {
  const status = /** @type {any} */ (await projectStatus(project));
  /** @type {import('../types.js').PictureResult[]} */
  const pictures = status?.lastRun?.pictures ?? [];
  return pictures.filter((p) => p.status === 'changed').map((p) => p.name);
}

/**
 * Fingerprints of the pictures this project's last run actually took.
 * @param {import('../types.js').Project} project
 * @param {string[]} names
 * @returns {Promise<Record<string,string>>}
 */
async function fingerprintsOfLastRun(project, names) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const name of names) {
    const hash = await sha256File(resultPicture(project.paths, name).png);
    if (hash) out[name] = hash;
  }
  return out;
}
