/**
 * Running guards.
 *
 * A guard is a promise that a fixed bug stays fixed, so the run is arranged
 * around one idea: the result must be trustworthy on its own. Every guard starts
 * from the same clean state, a guard that needs a second go is recorded as
 * wobbly rather than green, and the failure message carries the story of the
 * original bug so nobody has to go looking for it.
 *
 * A guard also has to be watchable while it happens. It is the part of this tool
 * that checks behaviour rather than looks — it drives the app and asserts what it
 * still does — and reporting it as a single line hid every one of those
 * assertions. So each claim and each action is passed straight out as it starts
 * and again as it settles, and the whole list travels with the result. A guard
 * that fails on its fifth claim still shows the four that held: "these are fine,
 * this one is not" is most of the value of running it at all.
 */

import { makeGuardApi, ExpectationFailed } from './api.js';
import { resetWindow } from '../drive/launch.js';
import { emitEvent } from '../core/events.js';

const DEFAULT_TIMEOUT = 30_000;

/** How the runner names its own first step — the clean start every guard gets. */
const FRESH_KEY = 'fresh';

/**
 * @typedef {import('../types.js').GuardResult & {
 *   retriedToPass?: boolean,
 *   checks?: import('../types.js').CheckStep[],
 * }} GuardRunResult
 */

/**
 * @typedef {object} AttemptOutcome
 * @property {boolean} ok
 * @property {string} [message]
 * @property {string} [failedAt]
 */

/** @typedef {(step: import('../types.js').CheckStep) => void} StepSink */

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
    /** @type {import('../types.js').CheckStep[]} */
    let checks = [];

    while (attempts < retries + 1) {
      attempts += 1;
      // A second go starts the list again. What a person needs to see is what the
      // verdict was actually made on, and that is the last attempt — the earlier
      // one is already recorded, more usefully, as "it only passed on try 2".
      const attempt = attempts;
      /** @type {import('../types.js').CheckStep[]} */
      const collected = [];
      checks = collected;

      /** @type {StepSink} */
      const onStep = (step) => {
        // Keys are unique inside one attempt; a retry re-announces the same
        // claims, and a watcher must not mistake the second run of a claim for
        // the settling of the first.
        const stamped =
          attempt > 1 && step.key ? { ...step, key: `try${attempt}-${step.key}` } : step;
        record(collected, stamped);
        emitEvent(events, { type: 'guard:step', name: guard.name, step: stamped });
      };

      outcome = await attemptGuard(project, app, guard, baseUrl, timeoutMs, onStep);
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
    if (checks.length > 0) result.checks = checks;

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
 * Put one step into the list it belongs to.
 *
 * A step is said twice — once as it starts, once as it finishes — and the list
 * should hold one line per thing, not two. The settled version replaces the
 * running one in place, so the order stays the order it happened in.
 *
 * @param {import('../types.js').CheckStep[]} into
 * @param {import('../types.js').CheckStep} step
 * @returns {void}
 */
function record(into, step) {
  if (step.key) {
    for (let i = 0; i < into.length; i++) {
      if (into[i].key === step.key) {
        into[i] = step;
        return;
      }
    }
  }
  into.push(step);
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
    // Everything this guard actually asserted, in its own words and its own
    // order — so a listener that arrived late, or one that only keeps the
    // verdicts, still has the working.
    checks: result.checks,
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
 * @param {StepSink} [onStep]
 * @returns {Promise<AttemptOutcome>}
 */
async function attemptGuard(project, app, guard, baseUrl, timeoutMs, onStep) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;

  /**
   * @param {import('../types.js').CheckStep} step
   * @returns {void}
   */
  const tell = (step) => {
    if (!onStep) return;
    try {
      onStep(step);
    } catch {
      // Watching a guard must never be able to fail one.
    }
  };

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
        const fresh = 'started from a clean screen';
        tell({ key: FRESH_KEY, label: fresh, state: 'running' });
        try {
          if (baseUrl) await app.page.goto(baseUrl);
          else await resetWindow(app);
        } catch (error) {
          tell({
            key: FRESH_KEY,
            label: fresh,
            detail: error instanceof Error ? error.message : String(error),
            state: 'bad',
          });
          throw error;
        }
        tell({
          key: FRESH_KEY,
          label: fresh,
          detail: baseUrl ? 'back to the front door' : 'the window was reloaded',
          state: 'ok',
        });

        clearConsole(app);
        await guard.run(makeGuardApi(app.page, project, onStep ? { onStep } : {}));
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
    return { ok: false, message: `${explainApiSlip(raw, app.page, project)}${consoleNote(app)}` };
  } finally {
    // The losing side of the race keeps running otherwise, and a stray timer
    // holds the process open long after the run is reported.
    if (timer) clearTimeout(timer);
  }

  return { ok: true };
}

/**
 * Turn "page.goto is not a function" into one sentence a person can act on.
 *
 * A guard is the first code most people write against this tool, and the object it is handed
 * is not the shape anybody arrives expecting. Reach for a name from a browser library that is
 * not there and JavaScript answers with its own sentence, which is true, useless, and exactly
 * the kind of raw error this project promises never to print. The first guard written against
 * it while proving the tool still worked failed this way.
 *
 * Two things it must not do, both learned by getting them wrong first:
 *
 *  - **Do not trust the receiver's name.** The guard above called its one parameter `page`,
 *    so the error read `page.goto is not a function` — but the parameter holds `app`, and the
 *    honest answer is `app.open()`. Reading that name as if it meant the page suggested
 *    "did you mean goto()", which is the very thing they had just written.
 *  - **Do not list every method.** An earlier version printed all thirty names on the page
 *    handle inline. It was complete, unreadable, and it destroyed the results table it sat in.
 *
 * So: name the six things on `app`, say where the rest live, and stop.
 *
 * @param {string} raw
 * @param {import('../types.js').PageHandle} page
 * @param {import('../types.js').Project} project
 * @returns {string}
 */
export function explainApiSlip(raw, page, project) {
  const missing = /^(?:\w+\.)?(\w+) is not a function$/.exec(String(raw || ''));
  if (!missing) return raw;
  const method = missing[1];
  const api = makeGuardApi(page, project, {});
  const onApp = Object.keys(api).filter((k) => typeof (/** @type {any} */ (api))[k] === 'function').sort();
  if (onApp.includes(method)) return raw;

  // Only ever suggested from what `app` itself offers, and only when one name is clearly the
  // one meant. A guess between three is worse than no guess.
  const near = onApp.filter((n) => n.toLowerCase().includes(method.toLowerCase()) || method.toLowerCase().includes(n.toLowerCase()));
  const browserish = /^(goto|navigate|visit|load|open|click|type|fill|press|hover|wait|screenshot|querySelector|\$)/i.test(method);
  const meant = near.length === 1 ? ` You probably want \`app.${near[0]}()\`.`
    : browserish ? ' To go to a page it is `app.open(\'/path\')`; anything a browser does is on `app.page`.'
    : '';

  return (
    `This guard called \`${method}()\` on what it was handed, and there is no such thing there.${meant} ` +
    `A guard is given one object — call it \`app\` — with ${onApp.map((n) => `\`${n}()\``).join(', ')}. ` +
    'The whole page is `app.page`. There is a worked example in `examples/guards/`.'
  );
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
