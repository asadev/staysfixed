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
 *   assertedNothing?: boolean,
 *   timedOut?: boolean,
 *   checks?: import('../types.js').CheckStep[],
 * }} GuardRunResult
 */

/**
 * @typedef {object} AttemptOutcome
 * @property {boolean} ok
 * @property {string} [message]
 * @property {string} [failedAt]
 * @property {boolean} [timedOut]  The clock ran out before the guard answered. Not the same
 *                                 as the answer being no — see the note on the result below.
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

    // A guard that asserted NOTHING has not held. It cannot hold, and it cannot fail — it is
    // a name over an empty room. Measured on 2026-08-30: a guard called "the checkout total
    // is never charged twice", whose `run()` was an empty function, came back as
    // "ok ... still holds". That is a false all-clear wearing the friendliest face this tool
    // has, and it would go on saying it every day for ever. The whole promise here is one
    // plain-English rule per bug somebody already had; a rule that checks nothing is worse
    // than no rule, because somebody believes it.
    // Its OWN questions, not the runner's. Every guard gets a "fresh start" step from this
    // file whether it asks anything or not, so counting the whole list would always find one.
    const asked = checks.filter((c) => c.key !== FRESH_KEY && !String(c.key ?? '').endsWith(`-${FRESH_KEY}`));
    const assertedNothing = outcome.ok && asked.length === 0;

    /** @type {GuardRunResult} */
    const result = {
      name: guard.name,
      status: outcome.ok && !assertedNothing ? 'passed' : 'failed',
      file: guard.file,
      because: guard.because,
      durationMs: Date.now() - startedAt,
      attempts,
    };
    if (checks.length > 0) result.checks = checks;

    if (assertedNothing) {
      result.assertedNothing = true;
      result.message =
        `This guard checked nothing. Its \`run()\` finished without asking a single question, so it cannot fail ` +
        `and it is not protecting anything — it would report "still holds" every day for ever. ` +
        `Give it at least one \`expect(...)\`. ${guard.because ? `What it is meant to protect: ${guard.because}` : ''}`.trim();
    } else if (outcome.timedOut) {
      // A third thing wearing the same status, for the same reason as the second one.
      // Measured on 2026-08-31 against a healthy shop with three guards — one genuinely broken,
      // one whose `run()` slept six seconds against its own limit of one and a half: the run
      // announced "2 guards failed — bugs that were already fixed are back." One bug was back.
      // The other guard was never answered, and somebody reading that line goes hunting a
      // regression in checkout that never happened. Running out of time is the guard failing to
      // report, not the product failing — the same distance as "nothing changed" from "nothing
      // was compared".
      //
      // The status stays 'failed' on purpose. A question nobody got an answer to must never
      // count as a pass, or a stuck guard becomes the quietest way there is to go green. The
      // flag is what lets the words be right without letting the verdict go soft.
      result.timedOut = true;
      result.message = outcome.message ?? 'This guard ran out of time before it answered.';
      // The story of the original bug is deliberately left off. It is printed beside every
      // failure to say whether the failure matters — and here nothing yet says the bug is
      // back, so leading with its story is the exact wrong impression to give.
    } else if (outcome.ok) {
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
    // Out of time is its own answer, and it is not "no". The guard was still going when the
    // clock stopped, so all anyone knows is that nobody asked it anything it managed to
    // finish. Said in those words rather than as a returned bug.
    if (error instanceof TookTooLong) {
      return {
        ok: false,
        timedOut: true,
        message:
          `This guard ran out of time after ${humanSeconds(timeoutMs)} and never gave an answer, so nothing ` +
          `here says the bug is back — only that the guard could not be asked. Either it genuinely needs ` +
          `longer than its own \`timeoutMs\`, or it is waiting for something that never arrives. ` +
          `Its \`run()\` was left going when the clock stopped, so anything odd in the guards after it ` +
          `may be this one still moving around.${consoleNote(app)}`,
      };
    }
    const raw = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `${explainApiSlip(plainly(raw), app.page, project)}${consoleNote(app)}` };
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

/**
 * Fragments that only ever come out of the debugging protocol talking to itself.
 *
 * Chrome's parameter reader answers in its own vocabulary — the byte it got stuck on, the
 * name of an internal binding, a JSON-RPC error number. Measured on 2026-08-31: a guard that
 * passed the wrong sort of value to `app.page.send` failed with `Invalid parameters (Failed to
 * deserialize params.expression - BINDINGS: string value expected at position 19)` printed at
 * the person as the whole explanation. Nothing in the bracket is about their app, their guard
 * or their bug.
 */
const PROTOCOL_CHATTER = /Failed to deserialize|BINDINGS:|at position \d|-32\d{3}|"method"\s*:|"params"\s*:/;

/** Past this a failure message stops being something anyone reads and starts being a wall. */
const MAX_MESSAGE = 400;

/**
 * Say a failure in words, with the machinery's own muttering taken out.
 *
 * Three things had to go, all of them seen printed at somebody:
 *
 *  - **More than one line.** A stack trace, a browser library's "Call log" block or a dump of
 *    the debugging protocol all arrive as one long message with newlines in it, and the
 *    results table this sits inside is built of rows — the second line lands in the next
 *    column and the table comes apart. The same lesson `explainApiSlip` above learned by
 *    printing thirty method names inline.
 *  - **The protocol's own diagnostics**, which Chrome hangs off the end in brackets.
 *  - **`[object Object]`**, which is what a guard that throws something other than an error
 *    turns into. It was, on its own, the entire reason given for a failing guard.
 *
 * @param {string} raw
 * @returns {string}
 */
export function plainly(raw) {
  const text = String(raw ?? '').trim();

  if (text === '' || text === '[object Object]' || text === '[object Undefined]') {
    return (
      'This guard threw something that is not an error, so there is no message to read. ' +
      "Throw `new Error('what went wrong')`, or better, use `app.expect(...)` — it fails with the " +
      'plain sentence you wrote, which is the sentence that gets printed.'
    );
  }

  // One line. Everything after it is the machinery describing itself.
  let line = text.split('\n')[0].trim();

  // A whole protocol frame, pasted in as if it were a sentence.
  if (/^[[{]/.test(line) && PROTOCOL_CHATTER.test(line)) {
    return 'The app answered this guard with a raw debugging-protocol message rather than a result, so the guard could not finish.';
  }

  // Chrome's own diagnostics, bracketed on the end. Only dropped when the bracket really is
  // protocol talk — plenty of failures put something useful in brackets.
  line = line.replace(/\s*\([^()]*\)$/, (blob) => (PROTOCOL_CHATTER.test(blob) ? '' : blob)).trim();

  if (line.length > MAX_MESSAGE) return `${line.slice(0, MAX_MESSAGE).trimEnd()}… (cut short)`;
  return line;
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
  // Rounded to whole seconds, `timeoutMs: 1500` came back as "did not finish within 2
  // seconds" — a number the person cannot find anywhere in their own guard, which reads
  // as the tool having waited longer than it did. One decimal place, so it matches what
  // they typed: 1.5, 8, 30.
  const seconds = Math.round(ms / 100) / 10;
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}
