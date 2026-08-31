/**
 * The surface a guard is handed.
 *
 * Everything here exists to make a failure readable a long time after the person
 * who wrote it has forgotten the bug. That is why assertions are a sentence plus
 * a check, and never a bare comparison: `expect('the sidebar is hidden', ...)`
 * fails with "expected: the sidebar is hidden", which anyone can act on.
 *
 * Those sentences are also the answer to the fairest question anyone asks about
 * this tool: "is it only about how things look?" It is not — a guard drives the
 * app and asserts what it still does — but that was invisible, because a guard
 * reported one line however many things it proved. So every claim, and every
 * action between the claims, now says itself out loud the moment it happens:
 * announced as it starts, settled as it finishes. The list a person watches tick
 * off IS the guard's own words, in the guard's own order.
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

/**
 * The run has given up on this guard, and the guard is still going.
 *
 * Every door in the object a guard is handed throws this once the attempt that opened it has
 * been abandoned. Measured on 2026-08-31: a guard with `timeoutMs: 200`, ticking every 25
 * milliseconds, had written 7 lines to a file by the time the run reported it and 26 half a
 * second later — the timeout is a `Promise.race`, and losing a race does not stop the loser.
 * It went on clicking, reading and holding a page that the guard after it was already using.
 *
 * Nobody prints this. By the time it is thrown the verdict for this guard is already written,
 * and the point of it is only to unwind a body the run has stopped listening to.
 */
export class GuardAbandoned extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GuardAbandoned';
  }
}

const DEFAULT_RUN_TIMEOUT = 60_000;

/** Commands can print a lot; 10MB before we cut them off. */
const MAX_OUTPUT = 10 * 1024 * 1024;

/** Longest a selector, path or command is shown before it is cut short. */
const MAX_LABEL = 80;

/**
 * How a step's id says what kind of step it is.
 *
 * An assertion is the point of a guard; opening a page or clicking a button is
 * the setup that gets there. `CheckStep` has no room for that difference — and
 * should not grow one for the sake of a colour — so it rides on the id, which
 * every step needs anyway. Anything watching can draw `claim-` lines loud and
 * `did-` lines quiet; anything that does not care sees a perfectly ordinary list.
 */
const CLAIM = 'claim';
const ACTION = 'did';

/**
 * What a guard is told to report to, when anyone is collecting.
 * @typedef {object} GuardApiOptions
 * @property {(step: import('../types.js').CheckStep) => void} [onStep]
 *           Called as each claim and each action starts, and again as it settles.
 *           The two calls carry the same `key`.
 * @property {AbortSignal} [signal]
 *           Raised when the run has given up on this guard — its clock ran out, or its
 *           attempt has simply already returned. Every door here refuses from then on, so
 *           the body stops at its very next step instead of driving the app behind a run
 *           that has moved on.
 */

/**
 * Build the object passed to a guard's `run`.
 *
 * @param {import('../types.js').PageApi} page
 * @param {import('../types.js').Project} project
 * @param {GuardApiOptions} [opts]
 * @returns {import('../types.js').GuardApi}
 */
export function makeGuardApi(page, project, opts = {}) {
  const root = project.paths.root;
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : null;
  const givenUp = opts.signal;
  let counted = 0;

  /**
   * Refuse to do anything more once the run has given up on this guard.
   *
   * This is what makes a timeout mean something. Before it, a guard that ran out of time
   * kept its whole body running: measured on 2026-08-31, 7 file writes by the time the run
   * reported it and 26 half a second later, every one of them free to click the page the
   * next guard had just started on. Refusing at the door is the only stopping there is —
   * JavaScript cannot take a promise back — but it is enough, because a guard reaches the
   * app through this object, and it reaches it constantly.
   *
   * @returns {void}
   */
  function stopHere() {
    if (!givenUp?.aborted) return;
    throw refusal();
  }

  /** @returns {GuardAbandoned} */
  function refusal() {
    return new GuardAbandoned(
      'The run had already given up on this guard and moved on, so this step was refused rather than run.',
    );
  }

  /**
   * The page with one extra rule: once the run has given up on this guard, it refuses.
   *
   * `app.page` is documented as "the whole page", so a guard that drives the app itself
   * never passes through the five methods below — and those were exactly the guards left
   * holding a page after their own timeout. The wrapper belongs to this attempt and dies
   * with it; the real handle is untouched, and every other part of the tool keeps using it.
   *
   * @param {import('../types.js').PageApi} handle
   * @returns {import('../types.js').PageApi}
   */
  function refusable(handle) {
    if (!givenUp) return handle;
    /** @type {Record<string, unknown>} */
    const doors = {};
    for (const key of Object.keys(handle)) {
      const value = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (handle))[key];
      if (typeof value !== 'function') {
        doors[key] = value;
        continue;
      }
      // Refused in the same shape the door answers in. `goto` is awaited and `consoleErrors`
      // is read, and a refusal that arrives as a thrown error where a value was expected —
      // or as a rejected promise where none was — is a second surprise on top of the first.
      const answersWithAPromise = value.constructor?.name === 'AsyncFunction';
      doors[key] = (/** @type {unknown[]} */ ...args) => {
        if (!givenUp.aborted) return /** @type {(...a: unknown[]) => unknown} */ (value).apply(handle, args);
        if (answersWithAPromise) return Promise.reject(refusal());
        throw refusal();
      };
    }
    return /** @type {import('../types.js').PageApi} */ (/** @type {unknown} */ (doors));
  }

  /**
   * Hand one step out, and never let that matter.
   *
   * Reporting is a convenience laid over a check; a listener that throws must not
   * change whether a bug that was fixed is still fixed.
   *
   * @param {import('../types.js').CheckStep} step
   * @returns {void}
   */
  function tell(step) {
    if (!onStep) return;
    try {
      onStep(step);
    } catch {
      // Watching is never worth a guard.
    }
  }

  /**
   * Say a thing has started, and hand back the way to say how it went.
   *
   * When nobody is collecting this allocates nothing and returns a function that
   * does nothing, so a guard run with no watcher costs exactly what it did before.
   *
   * @param {string} kind   CLAIM or ACTION.
   * @param {string} label  Plain language, already final — the same words settle it.
   * @returns {(state: import('../types.js').CheckStep['state'], detail?: string) => void}
   */
  function announce(kind, label) {
    if (!onStep) return () => {};
    counted += 1;
    const key = `${kind}-${counted}`;
    tell({ key, label, state: 'running' });
    return (state, detail) => {
      tell(detail ? { key, label, detail, state } : { key, label, state });
    };
  }

  return {
    page: refusable(page),
    project,

    /**
     * @param {string} to
     * @returns {Promise<void>}
     */
    async open(to) {
      stopHere();
      const settle = announce(ACTION, `opened ${short(to)}`);
      try {
        await page.goto(to);
      } catch (error) {
        settle('bad', reasonOf(error));
        throw error;
      }
      settle('ok');
    },

    /**
     * @param {string} selector
     * @returns {Promise<void>}
     */
    async click(selector) {
      stopHere();
      const settle = announce(ACTION, `clicked ${short(selector)}`);
      try {
        await page.click(selector);
      } catch (error) {
        settle('bad', reasonOf(error));
        throw error;
      }
      settle('ok');
    },

    /**
     * @param {string} claim
     * @param {() => unknown | Promise<unknown>} check
     * @returns {Promise<void>}
     */
    async expect(claim, check) {
      stopHere();
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

      // The claim goes out before it is checked, not after. A person watching
      // sees what is being asked while it is being asked — which is the whole
      // difference between a list that ticks and a table that appears.
      const settle = announce(CLAIM, claim.trim());

      let result;
      try {
        result = await check();
      } catch (cause) {
        // A nested expectation already reads well — do not bury it in another layer.
        if (cause instanceof ExpectationFailed) {
          settle('bad', cause.claim === claim.trim() ? undefined : `inside it: ${cause.claim}`);
          throw cause;
        }
        const why = cause instanceof Error ? cause.message : String(cause);
        settle('bad', firstLine(why));
        throw new Error(`while checking '${claim}': ${why}`, {
          cause,
        });
      }

      if (isNegative(result)) {
        settle('bad', 'this is not true any more');
        throw new ExpectationFailed(claim);
      }
      settle('ok');
    },

    /**
     * Run a shell command. Guards that are not about the screen — a build that
     * must still succeed, a file that must still be generated — live here.
     *
     * A non-zero exit is returned, never thrown: whether it means failure is the
     * guard's decision, not ours. The step says so the same way — a command that
     * came back unhappy is worth noticing, and is still not a verdict.
     *
     * @param {string} cmd
     * @param {{cwd?: string, timeoutMs?: number}} [runOpts]
     * @returns {Promise<{code: number, stdout: string, stderr: string}>}
     */
    async run(cmd, runOpts = {}) {
      // Before the command is started, not after. A guard the run has given up on must not
      // be able to leave a process of its own behind it.
      stopHere();
      const cwd = runOpts.cwd ? path.resolve(root, runOpts.cwd) : root;
      const timeoutMs = runOpts.timeoutMs ?? DEFAULT_RUN_TIMEOUT;
      const settle = announce(ACTION, `ran ${short(cmd)}`);

      /** @type {Promise<{code: number, stdout: string, stderr: string}>} */
      const finished = new Promise((resolve, reject) => {
        exec(
          cmd,
          // `signal` is what actually kills the child. A guard that shells out to something
          // long-running was the clearest case of a timed-out guard holding a real resource:
          // the run had reported and moved on, and the command was still going.
          { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, encoding: 'utf8', signal: givenUp },
          (error, stdout, stderr) => {
            const out = String(stdout ?? '');
            let err = String(stderr ?? '');
            let code = 0;

            if (error) {
              const e = /** @type {any} */ (error);
              // Stopped because the run gave up on this guard, not because the command ran
              // long. Saying "stopped after 60 seconds" here would be a made-up reason.
              if (givenUp?.aborted && (e.name === 'AbortError' || e.killed)) {
                reject(
                  new GuardAbandoned(
                    'The run gave up on this guard while this command was still going, so the command was stopped.',
                  ),
                );
                return;
              }
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

      const outcome = await finished;
      if (outcome.code === 0) settle('ok', 'finished cleanly, code 0');
      else if (outcome.code === 124) {
        settle('warn', `stopped after ${humanTime(timeoutMs)}, code 124`);
      } else settle('warn', `came back with code ${outcome.code}`);
      return outcome;
    },

    /**
     * Read a file from the project.
     *
     * @param {string} file
     * @returns {Promise<string>}
     */
    async read(file) {
      stopHere();
      const full = path.resolve(root, file);
      const relative = path.relative(root, full);
      // A guard belongs to one project; reading outside it makes the guard depend
      // on whoever's machine it happens to be running on.
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new StaysFixedError(`A guard can only read files inside the project, and "${file}" is outside it.`, {
          hint: 'Use a path relative to the project root, like "package.json" or "src/app.js".',
        });
      }

      const settle = announce(ACTION, `read ${short(relative)}`);
      /** @type {string} */
      let text;
      try {
        text = await fsp.readFile(full, 'utf8');
      } catch (cause) {
        const code = /** @type {any} */ (cause)?.code;
        if (code === 'ENOENT') {
          settle('bad', 'there is no such file');
          throw new StaysFixedError(`There is no file called "${relative}" in the project.`, { cause });
        }
        if (code === 'EISDIR') {
          settle('bad', 'that is a folder, not a file');
          throw new StaysFixedError(`"${relative}" is a folder, not a file.`, { cause });
        }
        settle('bad', reasonOf(cause));
        throw new StaysFixedError(`Could not read "${relative}": ${cause instanceof Error ? cause.message : String(cause)}`, {
          cause,
        });
      }

      const lines = text === '' ? 0 : text.split('\n').length;
      settle('ok', `${count(lines)} ${lines === 1 ? 'line' : 'lines'}`);
      return text;
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
 * A selector, path or command, short enough to read in a list.
 *
 * @param {string} text
 * @returns {string}
 */
function short(text) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (one === '') return 'nothing';
  return one.length > MAX_LABEL ? `${one.slice(0, MAX_LABEL - 1)}…` : one;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function reasonOf(error) {
  return firstLine(error instanceof Error ? error.message : String(error));
}

/**
 * @param {string} text
 * @returns {string}
 */
function firstLine(text) {
  const line = String(text ?? '').split('\n')[0].trim();
  if (line === '') return 'it did not say why';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/**
 * @param {number} n
 * @returns {string}
 */
function count(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : String(n);
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
