/**
 * `staysfixed status` — reads what is on disk and says it. Launches nothing.
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadProject } from '../core/config.js';
import { projectStatus } from '../run.js';
import { printStatus } from '../report/console.js';
import { say, blank, heading, paint } from '../core/log.js';
import { EXIT } from '../core/errors.js';

/**
 * What version 2 has recorded here, if anything.
 *
 * `status` only ever counted version 1's things — approved pictures, screens, guards,
 * markers — so on a project that had just been checked and shipped it said "Nothing has been
 * checked here yet. Start with: staysfixed check". Measured on 2026-08-30, one command after
 * a run that walked 36 addresses and a ship that cut the reference. The command whose whole
 * promise is to say instantly what is going on here was the one saying nothing had happened.
 *
 * @param {string} root
 * @returns {{at: string, verdict: string, reference: string|null, findings: number}|null}
 */
export function versionTwoState(root) {
  try {
    const file = path.join(root, '.staysfixed', 'v2', 'last-check.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw.at !== 'string') return null;
    // The reference is read from where it is KEPT, not from the last check's memory of it.
    // A check writes what it compared against at the time; ship cuts a reference after
    // that, so on the ordinary first-run order — check, then ship — the check's field still
    // says "no-reference-yet" while a reference plainly exists.
    let reference = null;
    try {
      const cuts = JSON.parse(fs.readFileSync(path.join(root, '.staysfixed', 'v2', 'reference-log.json'), 'utf8'));
      const newest = Array.isArray(cuts) && cuts.length ? cuts[cuts.length - 1] : null;
      if (newest && typeof newest.id === 'string') reference = newest.id;
    } catch {
      if (typeof raw.reference === 'string' && raw.reference !== 'no-reference-yet') reference = raw.reference;
    }
    return {
      at: raw.at,
      verdict: typeof raw.verdict === 'string' ? raw.verdict : 'ran',
      reference,
      findings: Array.isArray(raw.findings) ? raw.findings.length : 0,
    };
  } catch {
    // Nothing recorded, or nothing readable. Either way there is nothing to add.
    return null;
  }
}

/**
 * @param {import('./index.js').CliContext} ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  // `opening: false` — this command reads files and prints them. It says so in its own first
  // line. Loading the settings through the check that insists on something to open made the
  // fastest command in the tool refuse outright on every command-line tool, library and
  // server it had just set up, with a paragraph about an `app` key version 2 never writes.
  const project = await loadProject({ cwd: ctx.cwd, configFile: ctx.configFile, opening: false });
  const status = await projectStatus(project);
  printStatus(/** @type {any} */ ({ ...status, v2: versionTwoState(project.paths?.root ?? ctx.cwd) }));
  printWhatIsSetUp(project.config);
  return EXIT.ok;
}

/**
 * What these settings actually cover, in one short list.
 *
 * The promise of this command is "what is set up here", and on a project with no screen the
 * picture counters answer it with four zeroes — every one of them true, and together they
 * read as "nothing is set up" about a project whose settings name three commands and two
 * folders of source. So the settings are read back in the words they were written in.
 *
 * Everything here is read out of the settings file. Nothing is inferred and nothing is
 * counted that is not there, because a status line that overstates what is covered is the
 * one kind of wrong this tool cannot afford.
 *
 * @param {import('../types.js').ResolvedConfig} config
 * @returns {void}
 */
function printWhatIsSetUp(config) {
  const any = /** @type {Record<string, any>} */ (/** @type {unknown} */ (config));
  /** @type {string[]} */
  const lines = [];

  const commands = Array.isArray(any.process?.commands) ? any.process.commands.filter((/** @type {any} */ c) => c && !c.skip) : [];
  const imports = Array.isArray(any.process?.imports) ? any.process.imports : [];
  if (commands.length > 0) lines.push(`${commands.length} ${commands.length === 1 ? 'command' : 'commands'} to run and compare word for word`);
  if (imports.length > 0) lines.push(`${imports.length} ${imports.length === 1 ? 'library entry' : 'library entries'} to import and compare what ${imports.length === 1 ? 'it exports' : 'they export'}`);
  if (any.source && typeof any.source === 'object') {
    const folders = Array.isArray(any.source.folders) ? any.source.folders : [];
    lines.push(folders.length > 0 ? `the code in ${folders.join(', ')}, read without running it` : 'the code, read without running it');
  }
  if (any.http && typeof any.http === 'object') lines.push('a server, booted on a spare port and asked for every route');
  if (any.web && typeof any.web === 'object') {
    const screens = Array.isArray(any.web.screens) ? any.web.screens.length : 0;
    lines.push(screens > 0 ? `a website, and ${screens} ${screens === 1 ? 'screen' : 'screens'} of it` : 'a website');
  }
  if (any.electron && typeof any.electron === 'object') lines.push('a desktop app');
  if (any.android && typeof any.android === 'object') lines.push('an Android app');
  if (any.ios && typeof any.ios === 'object') lines.push('an iPhone app');
  if (any.windows && typeof any.windows === 'object') lines.push('a native Windows app');

  if (lines.length === 0) return;
  heading('What these settings cover');
  for (const line of lines) say(`  ${paint.grey('·')} ${line}`);
  blank();
  say(paint.grey(`  Run ${paint.cyan('staysfixed check')} to walk it, and ${paint.cyan('staysfixed coverage')} for what a run did NOT look at.`));
  blank();
}
