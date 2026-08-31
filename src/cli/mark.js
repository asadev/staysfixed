/**
 * `staysfixed mark` — pin a version that was good, so a regression has somewhere
 * to be traced back to.
 */

import { loadProject } from '../core/config.js';
import { writeMarker, listMarkers, deleteMarker, describeMarker } from '../marker/mark.js';
import { say, ok, warn, blank, heading, paint } from '../core/log.js';
import { StaysFixedError, EXIT } from '../core/errors.js';

/**
 * @param {import('./index.js').CliContext} ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  // `opening: false` — a marker is a commit, a date and a set of fingerprints written to a
  // file. Nothing is opened and nothing is photographed, so a project with no screen can pin
  // a known-good version exactly like any other. It was refused on every one of them until
  // 2026-08-31, which took `trace` down with it: there was nothing to trace back to.
  const project = await loadProject({ cwd: ctx.cwd, configFile: ctx.configFile, opening: false });

  if (ctx.bool('list')) return showAll(project);

  const toDelete = ctx.str('delete');
  if (toDelete) {
    const removed = await deleteMarker(project, toDelete);
    blank();
    if (removed) ok(`The marker "${toDelete}" is gone.`);
    else warn(`There is no marker called "${toDelete}". Run \`staysfixed mark --list\` to see the ones there are.`);
    blank();
    return removed ? EXIT.ok : EXIT.failed;
  }

  const label = ctx.args.join(' ').trim();
  if (!label) {
    throw new StaysFixedError('A marker needs a name.', {
      hint: 'Something you will recognise in three months: `staysfixed mark v0.15.0`.',
    });
  }

  const marker = await writeMarker(project, label, { note: ctx.str('note'), force: ctx.bool('force'), tool: ctx.version });

  blank();
  ok(`Pinned "${marker.label}" as a version that was good.`);
  say(`  ${paint.grey(describeMarker(marker))}`);
  if (marker.note) say(`  ${paint.grey(marker.note)}`);
  blank();
  say(paint.grey('If a screen goes wrong later, `staysfixed trace` can now name the commits in between.'));
  blank();
  return EXIT.ok;
}

/**
 * @param {import('../types.js').Project} project
 * @returns {Promise<number>}
 */
async function showAll(project) {
  const markers = await listMarkers(project);
  if (markers.length === 0) {
    blank();
    say('No versions have been pinned here yet.');
    say(`Pin one at your next release: ${paint.cyan('staysfixed mark v1.0.0')}`);
    blank();
    return EXIT.ok;
  }
  heading('Versions pinned as good, newest first');
  for (const marker of markers) {
    say(`  ${describeMarker(marker)}`);
    if (marker.note) say(`    ${paint.grey(marker.note)}`);
  }
  blank();
  return EXIT.ok;
}
