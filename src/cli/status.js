/**
 * `staysfixed status` — reads what is on disk and says it. Launches nothing.
 */

import { loadProject } from '../core/config.js';
import { projectStatus } from '../run.js';
import { printStatus } from '../report/console.js';
import { EXIT } from '../core/errors.js';

/**
 * @param {import('./index.js').CliContext} ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  const project = await loadProject({ cwd: ctx.cwd, configFile: ctx.configFile });
  const status = await projectStatus(project);
  printStatus(/** @type {any} */ (status));
  return EXIT.ok;
}
