/**
 * `staysfixed approve` — the human gate.
 *
 * This is the one command an agent is not allowed to run for you. So it is also
 * the one command that must never guess: with no name and no --all it lists what
 * is waiting and stops. Approving is a person saying "yes, that is what I meant".
 */

import { loadProject } from '../core/config.js';
import { approveScreens, projectStatus } from '../run.js';
import { say, ok, blank, heading, table, paint, mark } from '../core/log.js';
import { EXIT } from '../core/errors.js';

/**
 * @param {import('./index.js').CliContext} ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  const project = await loadProject({ cwd: ctx.cwd, configFile: ctx.configFile });
  const all = ctx.bool('all');
  const names = ctx.args.filter((a) => a.trim() !== '');

  if (!all && names.length === 0) return listWhatIsWaiting(project);

  const result = await approveScreens(
    project,
    names,
    /** @type {any} */ ({ all, reason: ctx.str('reason'), tool: ctx.version }),
  );

  const approved = namesFrom(result, names);

  blank();
  if (approved.length === 0) {
    say('Nothing was waiting, so nothing changed.');
    say(paint.grey('Run `staysfixed check` first — approving only ever accepts a picture the last check took.'));
    blank();
    return EXIT.ok;
  }

  const one = approved.length === 1;
  ok(`${one ? 'This picture is' : 'These pictures are'} the new normal now:`);
  for (const name of approved) say(`  ${paint.green(mark.pass)} ${name}`);
  const reason = ctx.str('reason');
  if (reason) say(paint.grey(`  reason saved with ${one ? 'it' : 'them'}: ${reason}`));
  blank();
  say(paint.grey(`From now on every check measures against ${one ? 'it' : 'them'}. Commit ${one ? 'it' : 'them'} with your code.`));
  blank();
  return EXIT.ok;
}

/**
 * With nothing named, say what could be approved and how — never approve.
 * @param {import('../types.js').Project} project
 * @returns {Promise<number>}
 */
async function listWhatIsWaiting(project) {
  const status = /** @type {any} */ (await projectStatus(project));
  /** @type {import('../types.js').PictureResult[]} */
  const pictures = status?.lastRun?.pictures ?? [];
  const waiting = pictures.filter((p) => p.status === 'changed' || p.status === 'new' || p.status === 'missing');

  if (!status?.lastRun) {
    blank();
    say('Nothing has been checked here yet, so there is nothing to approve.');
    say(`Run ${paint.cyan('staysfixed check')} first.`);
    blank();
    return EXIT.ok;
  }
  if (waiting.length === 0) {
    blank();
    ok('Nothing is waiting for you. Every picture already matches the approved one.');
    blank();
    return EXIT.ok;
  }

  heading('Waiting for you to look at');
  table(
    waiting.map((p) => [p.name, paint.grey(whatHappened(p))]),
    { indent: 2 },
  );
  blank();
  say('Look at each one, then accept the ones that are right:');
  for (const p of waiting.slice(0, 10)) say(`  ${paint.cyan(`staysfixed approve ${p.name}`)}`);
  if (waiting.length > 10) say(paint.grey(`  ...and ${waiting.length - 10} more`));
  if (waiting.length > 1) say(`Or accept every one of them: ${paint.cyan('staysfixed approve --all')}`);
  blank();
  say(paint.grey('Nothing was approved just now. Approving is deliberate, on purpose.'));
  blank();
  return EXIT.ok;
}

/**
 * @param {import('../types.js').PictureResult} p
 * @returns {string}
 */
function whatHappened(p) {
  if (p.status === 'new') return 'brand new — there is no approved picture yet';
  if (p.status === 'missing') return 'the approved picture is gone';
  return 'it looks different from the approved picture';
}

/**
 * The runner may hand back names, picture results, or a small report. Read all
 * three, so this command never has to guess which one it got.
 *
 * @param {unknown} result
 * @param {string[]} asked
 * @returns {string[]}
 */
function namesFrom(result, asked) {
  /** @type {any} */
  const value = result;
  /** @type {unknown[]} */
  let list = [];
  if (Array.isArray(value)) list = value;
  else if (Array.isArray(value?.approved)) list = value.approved;
  else if (Array.isArray(value?.names)) list = value.names;
  else if (Array.isArray(value?.pictures)) list = value.pictures;
  else if (value === undefined || value === null) return asked;

  const names = list
    .map((item) => (typeof item === 'string' ? item : /** @type {any} */ (item)?.name))
    .filter((name) => typeof name === 'string' && name !== '');
  return /** @type {string[]} */ (names);
}
