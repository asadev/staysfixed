/**
 * `staysfixed trace` — "when did this stop looking right?"
 */

import { loadProject } from '../core/config.js';
import { projectStatus } from '../run.js';
import { traceScreens } from '../marker/trace.js';
import { printTrace } from '../report/console.js';
import { say, paint } from '../core/log.js';
import { resultPicture } from '../core/paths.js';
import { sha256File } from '../core/hash.js';
import { EXIT } from '../core/errors.js';

/**
 * @param {import('./index.js').CliContext} ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  const project = await loadProject({ cwd: ctx.cwd, configFile: ctx.configFile });

  const asked = ctx.args.filter((a) => a.trim() !== '');
  const changed = asked.length > 0 ? [] : await changedInLastRun(project);
  const names = asked.length > 0 ? asked : changed;

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
