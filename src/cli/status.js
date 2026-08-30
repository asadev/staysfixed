/**
 * `staysfixed status` — reads what is on disk and says it. Launches nothing.
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadProject } from '../core/config.js';
import { projectStatus } from '../run.js';
import { printStatus } from '../report/console.js';
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
  const project = await loadProject({ cwd: ctx.cwd, configFile: ctx.configFile });
  const status = await projectStatus(project);
  printStatus(/** @type {any} */ ({ ...status, v2: versionTwoState(project.paths?.root ?? ctx.cwd) }));
  return EXIT.ok;
}
