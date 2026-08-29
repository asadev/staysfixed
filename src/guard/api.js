/**
 * The surface a guard is handed.
 *
 * Everything here exists to make a failure readable a long time after the person
 * who wrote it has forgotten the bug. That is why assertions are a sentence plus
 * a check, and never a bare comparison: `expect('the sidebar is hidden', ...)`
 * fails with "expected: the sidebar is hidden", which anyone can act on.
 */

import { exec } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StaysFixedError } from '../core/errors.js';

/** A plain-language expectation that did not hold. */
export class ExpectationFailed extends Error {
  /** @param {string} claim  The sentence the guard wrote. */
  constructor(claim) {
    super(`expected: ${claim}`);
    this.name = 'ExpectationFailed';
    /** @type {string} */
    this.claim = claim;
  }
}

const DEFAULT_RUN_TIMEOUT = 60_000;

/** Commands can print a lot; 10MB before we cut them off. */
const MAX_OUTPUT = 10 * 1024 * 1024;

/**
 * Build the object passed to a guard's `run`.
 *
 * @param {import('../types.js').PageApi} page
 * @param {import('../types.js').Project} project
 * @returns {import('../types.js').GuardApi}
 */
export function makeGuardApi(page, project) {
  const root = project.paths.root;

  return {
    page,
    project,

    /**
     * @param {string} to
     * @returns {Promise<void>}
     */
    open(to) {
      return page.goto(to);
    },

    /**
     * @param {string} selector
     * @returns {Promise<void>}
     */
    click(selector) {
      return page.click(selector);
    },

    /**
     * @param {string} claim
     * @param {() => unknown | Promise<unknown>} check
     * @returns {Promise<void>}
     */
    async expect(claim, check) {
      if (typeof claim !== 'string' || claim.trim() === '') {
        throw new StaysFixedError('An expectation needs a sentence in front of it.', {
          hint: 'Write it the way you would say it: expect("the sidebar is hidden", () => ...). That sentence is what a person reads when the guard fails.',
        });
      }
      if (typeof check !== 'function') {
        throw new StaysFixedError(`The expectation "${claim}" was not given anything to check.`, {
          hint: 'Pass a function as the second argument: expect("the sidebar is hidden", async () => !(await page.visible(".sidebar"))).',
        });
      }

      let result;
      try {
        result = await check();
      } catch (cause) {
        // A nested expectation already reads well — do not bury it in another layer.
        if (cause instanceof ExpectationFailed) throw cause;
        throw new Error(`while checking '${claim}': ${cause instanceof Error ? cause.message : String(cause)}`, {
          cause,
        });
      }

      if (isNegative(result)) throw new ExpectationFailed(claim);
    },

    /**
     * Run a shell command. Guards that are not about the screen — a build that
     * must still succeed, a file that must still be generated — live here.
     *
     * A non-zero exit is returned, never thrown: whether it means failure is the
     * guard's decision, not ours.
     *
     * @param {string} cmd
     * @param {{cwd?: string, timeoutMs?: number}} [runOpts]
     * @returns {Promise<{code: number, stdout: string, stderr: string}>}
     */
    run(cmd, runOpts = {}) {
      const cwd = runOpts.cwd ? path.resolve(root, runOpts.cwd) : root;
      const timeoutMs = runOpts.timeoutMs ?? DEFAULT_RUN_TIMEOUT;

      /** @type {Promise<{code: number, stdout: string, stderr: string}>} */
      const finished = new Promise((resolve) => {
        exec(
          cmd,
          { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, encoding: 'utf8' },
          (error, stdout, stderr) => {
            const out = String(stdout ?? '');
            let err = String(stderr ?? '');
            let code = 0;

            if (error) {
              const e = /** @type {any} */ (error);
              if (e.killed || e.signal) {
                // 124 is what `timeout(1)` uses, so a guard can spot it.
                code = 124;
                err += `\n(the command was stopped after ${humanTime(timeoutMs)})`;
              } else {
                code = typeof e.code === 'number' ? e.code : 1;
              }
            }

            resolve({ code, stdout: out, stderr: err });
          },
        );
      });
      return finished;
    },

    /**
     * Read a file from the project.
     *
     * @param {string} file
     * @returns {Promise<string>}
     */
    async read(file) {
      const full = path.resolve(root, file);
      const relative = path.relative(root, full);
      // A guard belongs to one project; reading outside it makes the guard depend
      // on whoever's machine it happens to be running on.
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new StaysFixedError(`A guard can only read files inside the project, and "${file}" is outside it.`, {
          hint: 'Use a path relative to the project root, like "package.json" or "src/app.js".',
        });
      }

      try {
        return await fsp.readFile(full, 'utf8');
      } catch (cause) {
        const code = /** @type {any} */ (cause)?.code;
        if (code === 'ENOENT') {
          throw new StaysFixedError(`There is no file called "${relative}" in the project.`, { cause });
        }
        if (code === 'EISDIR') {
          throw new StaysFixedError(`"${relative}" is a folder, not a file.`, { cause });
        }
        throw new StaysFixedError(`Could not read "${relative}": ${cause instanceof Error ? cause.message : String(cause)}`, {
          cause,
        });
      }
    },
  };
}

/**
 * What counts as "no".
 *
 * The empty array is in here because a check that gathers matches and finds none
 * has not proved anything — `expect('the rows are there', () => findRows())`
 * must fail on an empty list, not quietly pass. NaN is in here for the same
 * reason: a measurement that went wrong must never be mistaken for a good one.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isNegative(value) {
  if (value === false || value === null || value === undefined) return true;
  if (value === 0 || value === '') return true;
  if (typeof value === 'number' && Number.isNaN(value)) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/**
 * @param {number} ms
 * @returns {string}
 */
function humanTime(ms) {
  if (ms < 1000) return `${Math.round(ms)} milliseconds`;
  const seconds = Math.round(ms / 1000);
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}
