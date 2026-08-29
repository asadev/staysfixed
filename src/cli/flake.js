/**
 * `staysfixed flake` — the register of checks that cannot make up their mind.
 *
 * A check that cries wolf gets ignored, and then the real one gets ignored too.
 * So this command exists to make wobbling visible rather than tolerable.
 */

import { loadProject } from '../core/config.js';
import { loadHistory, saveHistory, clearFlakes, condemned, blindWithoutGit } from '../core/history.js';
import { printFlakes } from '../report/console.js';
import { say, ok, warn, blank, paint } from '../core/log.js';
import { gitInfo } from '../core/git.js';
import { EXIT } from '../core/errors.js';

/**
 * @param {import('./index.js').CliContext} ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  const project = await loadProject({ cwd: ctx.cwd, configFile: ctx.configFile });
  const history = await loadHistory(project.paths.historyFile);

  const forgive = ctx.str('clear');
  if (forgive) {
    const known = Object.values(history).some((entry) => entry.name === forgive);
    if (!known) {
      blank();
      warn(`No check called "${forgive}" has ever wobbled, so there is nothing to forgive.`);
      blank();
      return EXIT.failed;
    }
    await saveHistory(project.paths.historyFile, clearFlakes(history, forgive));
    blank();
    ok(`"${forgive}" starts again with a clean record.`);
    say(paint.grey('If it wobbles again, it is not fixed.'));
    blank();
    return EXIT.ok;
  }

  if (ctx.bool('json')) {
    process.stdout.write(JSON.stringify(history, null, 2) + '\n');
    return EXIT.ok;
  }

  printFlakes(history, project.config.flakeLimit);

  // A register that looks clean for the wrong reason is worse than one that admits what
  // it cannot see. Comparing a check's verdict between two runs only means something if
  // the code stood still in between, and only git can say that.
  if (blindWithoutGit(await gitInfo(project.paths.root))) {
    say(
      paint.grey(
        'Note: this folder has no commit to pin results to, so a wobble is only counted when a\n' +
          'check needs a second try inside one run. Commit your work and the register sees more.',
      ),
    );
    blank();
  }

  return condemned(history).length > 0 ? EXIT.failed : EXIT.ok;
}
