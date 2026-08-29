/**
 * Running guards.
 *
 * A guard is a promise that a fixed bug stays fixed, so the run is arranged
 * around one idea: the result must be trustworthy on its own. Every guard starts
 * from the same clean state, a guard that needs a second go is recorded as
 * wobbly rather than green, and the failure message carries the story of the
 * original bug so nobody has to go looking for it.
 */

import { makeGuardApi, ExpectationFailed } from './api.js';
import { resetWindow } from '../drive/launch.js';
import { emitEvent } from '../core/events.js';

const DEFAULT_TIMEOUT = 30_000;

/**
 * @typedef {import('../types.js').GuardResult & {retriedToPass?: boolean}} GuardRunResult
 */

/**
 * @typedef {object} AttemptOutcome
 * @property {boolean} ok
 * @property {string} [message]
 * @property {string} [failedAt]
 */

/**
 * Run every guard against an app that is already open.
 *
 * @param {import('../types.js').Project} project
 * @param {import('../types.js').LaunchedApp} app
 * @param {import('../types.js').Guard[]} guards
 * @param {{
 *   onResult?: (result: GuardRunResult) => void,
 *   retries?: number,
 *   signal?: AbortSignal,
 *   events?: import('../types.js').RunEvents,
 * }} [opts]
 * @returns {Promise<import('../types.js').GuardResult[]>}
 */
export async function runGuards(project, app, guards, opts = {}) {
  const retries = Math.max(0, Math.trunc(opts.retries ?? 0));
  const events = opts.events;
  const total = guards.length;

  // Electron apps have no address to go back to; for the web the configured url
  // is the guard's starting line.
  const baseUrl = project.config.app.kind === 'web' ? project.config.app.url : undefined;

  /** @type {GuardRunResult[]} */
  const results = [];

  for (let i = 0; i < guards.length; i++) {
    const guard = guards[i];
    // Between guards only — stopping one halfway would leave the app in a state
    // the next run cannot reason about.
    if (opts.signal?.aborted) break;

    const startedAt = Date.now();

    // The story of the bug goes out with the start, not only with a failure: a
    // person watching a guard run wants to know what it is protecting while it is
    // still running, not after it has already gone red.
    emitEvent(events, {
      type: 'guard:start',
      name: guard.name,
      because: guard.because,
      index: i + 1,
      total,
    });

    if (guard.skip === true) {
      /** @type {GuardRunResult} */
      const skipped = {
        name: guard.name,
        status: 'skipped',
        message: 'Left out on purpose (this guard is marked skip).',
        file: guard.file,
        because: guard.because,
        durationMs: Date.now() - startedAt,
        attempts: 0,
      };
      results.push(skipped);
      opts.onResult?.(skipped);
      emitGuardDone(events, skipped);
      continue;
    }

    const timeoutMs = guard.timeoutMs ?? DEFAULT_TIMEOUT;
    /** @type {AttemptOutcome} */
    let outcome = { ok: false, message: 'This guard did not run.' };
    let attempts = 0;

    while (attempts < retries + 1) {
      attempts += 1;
      outcome = await attemptGuard(project, app, guard, baseUrl, timeoutMs);
      if (outcome.ok) break;
      if (opts.signal?.aborted) break;
    }

    /** @type {GuardRunResult} */
    const result = {
      name: guard.name,
      status: outcome.ok ? 'passed' : 'failed',
      file: guard.file,
      because: guard.because,
      durationMs: Date.now() - startedAt,
      attempts,
    };

    if (outcome.ok) {
      // Passing only on the second go is not passing. The flake register picks
      // this up and condemns the guard, because a guard nobody trusts is worse
      // than no guard: people learn to re-run it until it goes green.
      if (attempts > 1) result.retriedToPass = true;
    } else {
      if (outcome.failedAt) result.failedAt = outcome.failedAt;
      result.message = withStory(outcome.message ?? 'This guard failed.', guard.because);
    }

    results.push(result);
    opts.onResult?.(result);
    emitGuardDone(events, result);
  }

  return results;
}

/**
 * @param {import('../types.js').RunEvents|undefined} events
 * @param {GuardRunResult} result
 * @returns {void}
 */
function emitGuardDone(events, result) {
  emitEvent(events, {
    type: 'guard:done',
    name: result.name,
    status: result.status,
    durationMs: result.durationMs,
    message: result.message,
    failedAt: result.failedAt,
    because: result.because,
  });
}

/**
 * One attempt at one guard, from a clean start.
 *
 * @param {import('../types.js').Project} project
 * @param {import('../types.js').LaunchedApp} app
 * @param {import('../types.js').Guard} guard
 * @param {string|undefined} baseUrl
 * @param {number} timeoutMs
 * @returns {Promise<AttemptOutcome>}
 */
async function attemptGuard(project, app, guard, baseUrl, timeoutMs) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;

  try {
    await Promise.race([
      (async () => {
        // Guards must be independent. A guard that passes only because the guard
        // before it left a dialog open will lie the day somebody runs it alone
        // with --only, and that is exactly the day they are trusting it.
        //
        // A web app has a front door to walk back through. A desktop app does not —
        // and leaving that as "nothing happens" cost real time: a guard about the
        // sidebar failed only when it ran after another guard, and passed on its
        // own, which is the single most confusing shape a failure can take. So an
        // Electron window is reloaded instead. Its main process keeps whatever it
        // was holding; only the screen goes back to how it opened.
        if (baseUrl) await app.page.goto(baseUrl);
        else await resetWindow(app);
        clearConsole(app);
        await guard.run(makeGuardApi(app.page, project));
      })(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new TookTooLong(`'${guard.name}' did not finish within ${humanSeconds(timeoutMs)}.`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof ExpectationFailed) {
      return {
        ok: false,
        failedAt: error.claim,
        message: `This should still be true, and it is not: "${error.claim}".${consoleNote(app)}`,
      };
    }
    const raw = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `${raw}${consoleNote(app)}` };
  } finally {
    // The losing side of the race keeps running otherwise, and a stray timer
    // holds the process open long after the run is reported.
    if (timer) clearTimeout(timer);
  }

  return { ok: true };
}

/** A timeout, kept apart from a real error so the wording stays ours. */
class TookTooLong extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'TookTooLong';
  }
}

/**
 * The page keeps console errors for whoever asks; clearing them here means the
 * ones we report belong to this guard and not to the one before it.
 *
 * @param {import('../types.js').LaunchedApp} app
 */
function clearConsole(app) {
  const handle = /** @type {{clearConsole?: () => void}} */ (/** @type {unknown} */ (app.page));
  handle.clearConsole?.();
}

/**
 * @param {import('../types.js').LaunchedApp} app
 * @returns {string}
 */
function consoleNote(app) {
  /** @type {string[]} */
  let errors = [];
  try {
    errors = app.page.consoleErrors() ?? [];
  } catch {
    return '';
  }
  if (errors.length === 0) return '';
  const first = String(errors[0]).split('\n')[0].slice(0, 200);
  const rest = errors.length === 1 ? '' : ` (and ${errors.length - 1} more)`;
  return `\nThe page also logged an error while this guard ran: ${first}${rest}`;
}

/**
 * The story of the original bug is the single most useful thing to print when a
 * guard fails — it says whether the failure matters.
 *
 * @param {string} message
 * @param {string|undefined} because
 * @returns {string}
 */
function withStory(message, because) {
  if (typeof because !== 'string' || because.trim() === '') return message;
  return `${message}\n\nWhy this guard exists: ${because.trim()}`;
}

/**
 * @param {number} ms
 * @returns {string}
 */
function humanSeconds(ms) {
  if (ms < 1000) return `${Math.round(ms)} milliseconds`;
  const seconds = Math.round(ms / 1000);
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}
