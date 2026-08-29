/**
 * `staysfixed walk` — the last look before a release.
 */

import { spawn } from 'node:child_process';
import { loadProject } from '../core/config.js';
import { runWalk } from '../run.js';
import { printWalkReport } from '../report/console.js';
import { say, warn, paint, shortPath } from '../core/log.js';
import { EXIT } from '../core/errors.js';

/**
 * @param {import('./index.js').CliContext} ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  const project = await loadProject({ cwd: ctx.cwd, configFile: ctx.configFile });

  /** @type {import('../types.js').WalkReport} */
  const report = await runWalk(project, /** @type {any} */ ({ only: ctx.list('only'), tool: ctx.version }));

  printWalkReport(report);

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
