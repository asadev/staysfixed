/**
 * Finding and loading a project's guards.
 *
 * Every problem found here is reported at once. Fixing guard names one error at
 * a time, re-running between each, is the kind of chore that makes people delete
 * the guards instead of naming them properly.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StaysFixedError } from '../core/errors.js';
import { shortPath } from '../core/log.js';
import { checkGuardName, NAME_RULE_EXPLAINER } from './name.js';

/**
 * @typedef {object} GuardProblem
 * @property {string} file
 * @property {string} label     What the guard called itself, quoted back.
 * @property {string} why
 * @property {string} [suggestion]
 * @property {boolean} [naming]
 */

/**
 * Load every guard in the project.
 *
 * A missing guards folder is not a problem — plenty of projects start with
 * pictures only and add guards the first time something comes back.
 *
 * @param {import('../types.js').Project} project
 * @param {{only?: string}} [opts]
 * @returns {Promise<import('../types.js').Guard[]>}
 */
export async function loadGuards(project, opts = {}) {
  const dir = project.paths.guards;
  const files = (await collectFiles(dir)).sort();
  if (files.length === 0) return [];

  /** @type {import('../types.js').Guard[]} */
  const guards = [];
  /** @type {GuardProblem[]} */
  const problems = [];

  for (const file of files) {
    const exported = await importGuards(file);
    for (const raw of exported) {
      const named = /** @type {any} */ (raw);
      const label = typeof named.name === 'string' && named.name.trim() !== '' ? named.name : '(no name)';

      const verdict = checkGuardName(named.name);
      if (!verdict.ok) {
        problems.push({
          file,
          label,
          why: verdict.why ?? 'That name cannot be used.',
          suggestion: verdict.suggestion,
          naming: true,
        });
        continue;
      }

      if (typeof named.run !== 'function') {
        problems.push({
          file,
          label,
          why: 'This guard has no "run" function, so there is nothing for it to do. Give it `async run(app) { ... }`.',
        });
        continue;
      }

      guards.push(/** @type {import('../types.js').Guard} */ ({ ...named, file }));
    }
  }

  // Two guards with the same name make a failure ambiguous: the report says the
  // name, and nobody can tell which of the two actually broke.
  /** @type {Map<string, string|undefined>} */
  const seen = new Map();
  /** @type {Set<string>} */
  const reported = new Set();
  for (const guard of guards) {
    const first = seen.get(guard.name);
    if (first === undefined) {
      seen.set(guard.name, guard.file);
      continue;
    }
    if (reported.has(guard.name)) continue;
    reported.add(guard.name);
    const where =
      first === guard.file
        ? 'Both are in this file.'
        : `One is in ${shortPath(String(first))} and one is in ${shortPath(String(guard.file))}.`;
    problems.push({
      file: guard.file ?? first,
      label: guard.name,
      why: `Two guards share this name. ${where} When it fails nobody could tell which one broke, so give them different names.`,
    });
  }

  if (problems.length > 0) throw problemsError(problems);

  const only = typeof opts.only === 'string' ? opts.only.trim().toLowerCase() : '';
  const chosen = only === '' ? guards : guards.filter((g) => g.name.toLowerCase().includes(only));

  // A stable order, so two runs of the same project read the same way.
  return chosen.sort((a, b) => {
    const byFile = String(a.file).localeCompare(String(b.file));
    return byFile !== 0 ? byFile : a.name.localeCompare(b.name);
  });
}

/**
 * Every `.js` / `.mjs` file under a folder, skipping `_`-prefixed and hidden
 * entries (a handy way to park a guard) and anything inside node_modules.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function collectFiles(dir) {
  /** @type {string[]} */
  const out = [];
  let entries = /** @type {import('node:fs').Dirent[]} */ ([]);
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);

    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const target = await fsp.stat(full);
        isDir = target.isDirectory();
        isFile = target.isFile();
      } catch {
        continue;
      }
    }

    if (isDir) out.push(...(await collectFiles(full)));
    else if (isFile && /\.(js|mjs)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Import one guard file and pull the guard objects out of it.
 *
 * @param {string} file
 * @returns {Promise<unknown[]>}
 */
async function importGuards(file) {
  /** @type {any} */
  let mod = undefined;
  try {
    // The modified time is part of the import url so a long-lived process — the
    // MCP server, mostly — picks up an edited guard instead of a cached one,
    // while an unchanged file still hits the module cache.
    const stat = await fsp.stat(file);
    mod = await import(`${pathToFileURL(file).href}?v=${Math.round(stat.mtimeMs)}`);
  } catch (cause) {
    throw new StaysFixedError(`The guard file ${shortPath(file)} could not be loaded: ${messageOfCause(cause)}`, {
      cause,
      hint: 'Guard files are plain JavaScript modules. Open the file and check it runs on its own — a typo or a bad import will stop the whole run.',
    });
  }

  const fallback = mod?.default;
  if (Array.isArray(fallback)) return fallback;
  if (looksLikeGuard(fallback)) return [fallback];

  /** @type {unknown[]} */
  const found = [];
  for (const [key, value] of Object.entries(mod ?? {})) {
    if (key === 'default') continue;
    if (Array.isArray(value)) {
      for (const item of value) if (looksLikeGuard(item)) found.push(item);
    } else if (looksLikeGuard(value)) {
      found.push(value);
    }
  }

  if (found.length === 0 && fallback !== undefined) {
    throw new StaysFixedError(`The guard file ${shortPath(file)} does not export a guard.`, {
      hint: 'Export the guard as the default: `export default { name: "the sidebar still collapses", async run(app) { ... } }`. An array of guards, or several named exports, work too.',
    });
  }

  return found;
}

/**
 * Loose enough to catch a half-written guard so we can explain what is missing,
 * strict enough to ignore an exported constant that happens to sit alongside.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function looksLikeGuard(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = /** @type {Record<string, unknown>} */ (value);
  return 'run' in obj || 'name' in obj;
}

/**
 * @param {unknown} cause
 * @returns {string}
 */
function messageOfCause(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * One error carrying every problem, so a person fixes them in a single pass.
 *
 * @param {GuardProblem[]} problems
 * @returns {StaysFixedError}
 */
function problemsError(problems) {
  const count = problems.length;
  const lines = [
    `${count} guard${count === 1 ? '' : 's'} cannot run yet.`,
    '',
  ];

  /** @type {Map<string, GuardProblem[]>} */
  const byFile = new Map();
  for (const p of problems) {
    const list = byFile.get(p.file);
    if (list) list.push(p);
    else byFile.set(p.file, [p]);
  }

  for (const [file, list] of byFile) {
    lines.push(`  ${shortPath(file)}`);
    for (const p of list) {
      lines.push(`    "${p.label}"`);
      lines.push(`    ${p.why}`);
      if (p.suggestion) lines.push(`    Try instead: "${p.suggestion}"`);
      lines.push('');
    }
  }

  const naming = problems.some((p) => p.naming);
  return new StaysFixedError(lines.join('\n').trimEnd(), {
    hint: naming ? NAME_RULE_EXPLAINER : undefined,
  });
}

/**
 * The starter guard file written by `staysfixed init`, and the example in the docs.
 *
 * It is deliberately a whole worked example rather than a stub: the first guard
 * somebody writes sets the tone for every guard after it.
 *
 * @param {{name?: string, because?: string, fixed?: string}} [opts]
 * @returns {string}
 */
export function guardTemplate(opts = {}) {
  const name = opts.name && opts.name.trim() !== '' ? opts.name : 'the sidebar still collapses';
  const fixed = opts.fixed && opts.fixed.trim() !== '' ? opts.fixed : today();
  const because =
    opts.because && opts.because.trim() !== ''
      ? opts.because
      : 'Clicking the collapse arrow left the sidebar half open, so the main panel never got its width back. It came back twice after being fixed, which is why this guard exists.';

  return `/**
 * One guard per bug that has already been fixed. Its only job is to fail the day
 * that bug comes back.
 *
 * The name is the whole point. Write what should still be true, in the words you
 * would say out loud — six months from now that sentence is the only thing that
 * will tell you what broke.
 */

export default {
  name: ${JSON.stringify(name)},

  // When it was fixed. Handy when you are trying to remember the release.
  fixed: ${JSON.stringify(fixed)},

  // The story of the original bug. This gets printed when the guard fails, and
  // it is usually the most useful line in the whole report.
  because:
    ${JSON.stringify(because)},

  // link: 'https://github.com/you/your-app/issues/482',

  async run({ open, click, expect, page }) {
    await open('/');

    // Put the app back in the state where the bug used to happen.
    await click('[data-sf="sidebar-toggle"]');

    // Then say, in plain words, what must still be true. If one of these turns
    // out false, the failure reads as the sentence you wrote here.
    await expect('the sidebar is hidden', async () => !(await page.visible('.sidebar')));

    await expect('the main panel fills the window', async () => {
      const box = await page.boxOf('.main');
      return box !== null && box.width > 900;
    });
  },
};
`;
}

/**
 * Today where the person is sitting, not in UTC — somebody running `init` late
 * at night should not see yesterday's date in their first guard.
 * @returns {string}
 */
function today() {
  const now = new Date();
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
