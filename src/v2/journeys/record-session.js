/**
 * Making a recording: open the product, follow what a person does, and keep only what repeats.
 *
 * WHY THIS EXISTS AT ALL. Everything else this tool checks it worked out by READING —
 * routes out of the source, exported names out of a package, screens out of a router. That
 * finds what the code SAYS it does, and it is free and exact, and it is blind to one thing:
 * the way a person actually uses the product. The four screens somebody opens every
 * morning, in that order, with that data, are nowhere in the source; the source only knows
 * that those four doors exist, the same as the two hundred nobody has touched since they
 * were written. A recorded session is the only channel that can learn it, and once learned
 * it is checked on every run for ever.
 *
 * WHAT THIS FILE IS NOT. It is not a second walker. The two walks that decide whether a
 * recording is worth keeping go through `walkerFor` in src/v2/check.js — the very same
 * adapters, scratch copies and normalisation a later `staysfixed check` will use — because a
 * recording judged by a simpler walker than the one that will later walk it is a recording
 * accepted on evidence nobody will ever collect again.
 *
 * THE ONE RULE THAT KEEPS THIS HONEST: A RECORDING THAT DOES NOT REPEAT IS REJECTED AT
 * BIRTH. Every session is walked twice against the same build before a single byte of it
 * reaches a file, and anything that differs between those two walks is not a step, it is
 * noise. A recording accepted without that check would inject a flapping journey into every
 * later run, and version 1 already proved where that ends: a flaky check does not get fixed,
 * it gets ignored, and a tool nobody trusts is worse than no tool because somebody believed
 * it once.
 *
 * A NAVIGATION THAT FOLLOWS A CLICK IS NOT A STEP. This is the sharpest trap in the whole
 * feature and it is worth reading twice. A person clicks "Open the orders list" and the
 * browser goes to /orders. Writing both down — click the link, then open /orders — produces
 * a journey that opens /orders whether or not the link works, so somebody breaks the button,
 * the replay walks straight past it to the right page, and the run comes back clean. That is
 * a false all-clear, which is the one answer this tool may never give. So a navigation that
 * arrives right after something the person did is dropped: it is the RESULT of the act, and
 * the act is the step.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { StaysFixedError, EXIT } from '../../core/errors.js';
import { say, ok, fail, blank, heading, paint, setLogLevel } from '../../core/log.js';
import { loadPlaywright, openWindow } from '../adapters/web-driver.js';
import { webAdapter } from '../adapters/web.js';
import { settingsFor, walkerFor } from '../check.js';
import { checkReproducible } from './index.js';
import { HIDDEN, RECORDINGS_DIR, saveJourneys, stepsFromEvents, whatWillNotReplay } from './record.js';

/** @typedef {import('../types.js').Journey} Journey */
/** @typedef {import('./index.js').GatheredJourney} GatheredJourney */
/** @typedef {import('../types.js').JourneyStep} JourneyStep */
/** @typedef {import('../types.js').Capture} Capture */
/** @typedef {import('./record.js').SessionEvent} SessionEvent */

/** How long a recording may run before it stops itself, when nobody says otherwise. */
export const DEFAULT_RECORD_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Watching a browser
// ---------------------------------------------------------------------------

/**
 * The script that rides inside the page and reports what somebody did.
 *
 * IT DESCRIBES THINGS BY WHAT THEY MEAN, NOT BY WHERE THEY SIT IN THE MARKUP. A recorded
 * click on `div > div:nth-child(3) > button` breaks the first time anybody moves a wrapper,
 * and then the journey fails for a reason that has nothing to do with the product. A click
 * on "the button called Save" survives every restyle and every rearrangement, and when it
 * DOES stop matching, that is a real fact about the product: the button a person uses every
 * morning is no longer called what it was called. That is the same thing the rest of this
 * tool compares — the roles, names and states a screen reader would read — so a recording
 * and a check disagree about nothing.
 *
 * It reports through a function this tool hands the page. Nothing is stored in the page and
 * nothing is read back out of it: a page that navigates loses everything it was holding, and
 * a recording that loses the first half of itself at the first click is worse than none.
 */
export const WATCHER_SCRIPT = `(() => {
  if (window.__staysfixedFollowing) return;
  window.__staysfixedFollowing = true;

  var say = function (event) {
    try { if (window.__staysfixedSaw) window.__staysfixedSaw(event); } catch (e) {}
  };

  var clean = function (text) {
    return String(text == null ? '' : text).replace(/\\s+/g, ' ').trim().slice(0, 80);
  };

  var roleOf = function (el) {
    var explicit = el.getAttribute ? el.getAttribute('role') : null;
    if (explicit) return clean(explicit);
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'a' && el.hasAttribute && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'input') {
      var type = String(el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return '';
  };

  var labelFor = function (el) {
    try {
      if (!el.id || !document.querySelector) return '';
      var found = document.querySelector('label[for="' + String(el.id).replace(/["\\\\]/g, '\\\\$&') + '"]');
      return found ? clean(found.textContent) : '';
    } catch (e) { return ''; }
  };

  var nameOf = function (el) {
    var attr = el.getAttribute ? (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt')) : '';
    if (attr) return clean(attr);
    var labelled = labelFor(el);
    if (labelled) return labelled;
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'input') {
      var type = String(el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') return clean(el.value);
      var placeholder = el.getAttribute('placeholder');
      if (placeholder) return clean(placeholder);
      return clean(el.getAttribute('name') || '');
    }
    return clean(el.innerText || el.textContent || '');
  };

  var idOf = function (el) {
    var id = el.getAttribute ? el.getAttribute('id') : '';
    return id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id) ? id : '';
  };

  // What to aim a replay at, best first. Meaning beats markup; an id beats a guess; a bare
  // tag name is the last resort and it is said out loud in the note so nobody mistakes it
  // for a considered choice.
  var describe = function (el) {
    var role = roleOf(el);
    var name = nameOf(el);
    if (role && name) {
      return {
        target: 'role=' + role + '[name=' + JSON.stringify(name) + ']',
        plain: 'the ' + role + ' called "' + name + '"',
      };
    }
    var id = idOf(el);
    if (id) return { target: '#' + id, plain: 'the thing called #' + id };
    if (name) return { target: 'text=' + JSON.stringify(name), plain: '"' + name + '"' };
    var tag = (el.tagName || 'element').toLowerCase();
    return { target: tag, plain: 'the first ' + tag + ' on the page' };
  };

  // The thing a person meant to click, not the pixel they hit. Clicking a word inside a
  // button reports the span the word is in, and a journey aimed at that span fails the
  // moment anybody wraps the label differently.
  var acted = function (el) {
    for (var n = 0; el && n < 6; n += 1) {
      var tag = (el.tagName || '').toLowerCase();
      var role = el.getAttribute ? el.getAttribute('role') : null;
      if (tag === 'a' || tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'summary') return el;
      if (role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem' || role === 'option') return el;
      el = el.parentElement;
      n += 1;
    }
    return null;
  };

  document.addEventListener('click', function (e) {
    var el = acted(e.target) || e.target;
    if (!el || !el.tagName) return;
    var said = describe(el);
    say({ act: 'click', target: said.target, note: 'click ' + said.plain });
  }, true);

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (!el || !el.tagName) return;
    var said = describe(el);
    var type = String((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      say({ act: 'click', target: said.target, note: 'click ' + said.plain });
      return;
    }
    say({ act: 'type', target: said.target, value: String(el.value == null ? '' : el.value), note: 'type into ' + said.plain });
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var el = e.target;
    if (!el || !el.tagName) return;
    var tag = String(el.tagName).toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return;
    say({ act: 'press', target: 'Enter', note: 'press Enter' });
  }, true);
})()`;

/**
 * Open the product and write down what somebody does in it.
 *
 * @param {object} opts
 * @param {string} opts.url                       Where the product is, right now.
 * @param {string} opts.scratchDir                A folder this may fill with a browser profile.
 * @param {string} [opts.projectRoot]             Which project's copy of Playwright to use.
 * @param {boolean} [opts.headed]                 Show the window. True for a person, false in a test.
 * @param {number} [opts.forMs]                   Stop after this long whatever happens.
 * @param {(page: any) => Promise<void>} [opts.drive]
 *   Something other than a person's hands. The events it produces are the same real browser
 *   events a person's clicks produce, which is what makes a test of this worth anything.
 * @param {(message: string) => void} [opts.log]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{events: SessionEvent[], why: string}>}
 */
export async function followASession(opts) {
  const playwright = await loadPlaywright({ projectRoot: opts.projectRoot });
  if (!playwright.ok) {
    throw new StaysFixedError(`A session cannot be recorded here: ${playwright.why}`, {
      hint: playwright.howToGet ? `Run: ${playwright.howToGet}` : undefined,
    });
  }

  /** @type {SessionEvent[]} */
  const events = [];
  const startedAt = Date.now();
  /** @param {SessionEvent} event */
  const saw = (event) => {
    events.push({ ...event, at: Date.now() - startedAt });
  };

  const window = await openWindow({
    chromium: playwright.chromium,
    executable: playwright.executable,
    scratchDir: opts.scratchDir,
    headed: opts.headed !== false,
    label: 'recording',
  });

  /** @type {string} */
  let why = 'The window was closed.';
  try {
    await window.context.exposeBinding('__staysfixedSaw', (/** @type {any} */ _source, /** @type {any} */ event) => {
      if (event && typeof event === 'object') saw(/** @type {SessionEvent} */ (event));
    });
    await window.context.addInitScript(WATCHER_SCRIPT);

    // Every address the browser lands on, whoever asked for it. Which of these survives as a
    // step is decided later, in `webStepsFrom`, and the rule there is the one that keeps a
    // broken button catchable — read the note at the top of this file.
    window.page.on('framenavigated', (/** @type {any} */ frame) => {
      if (frame !== window.page.mainFrame()) return;
      saw({ act: 'navigate', target: String(frame.url()) });
    });

    await window.page.goto(opts.url, { waitUntil: 'load', timeout: 30000 });
    opts.log?.(`Recording. Do the thing you want checked for ever, then close the window.`);

    if (opts.drive) {
      await opts.drive(window.page);
      why = 'The session was driven to the end of what it was asked to do.';
    } else {
      why = await waitForTheEnd(window, { forMs: opts.forMs ?? DEFAULT_RECORD_MS, signal: opts.signal });
    }
    // A click that navigates is still settling when the person closes the window, and the
    // address it settled on is the last thing the recording needs. Measured 2026-08-31: without
    // this the final navigation was missed about one run in three on a fast local server.
    await window.page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
  } finally {
    await window.close().catch(() => {});
  }

  return { events, why };
}

/**
 * Wait for the person to finish: they close the window, they press Ctrl-C, or the time runs out.
 *
 * @param {{context: any, page: any}} window
 * @param {{forMs: number, signal?: AbortSignal}} opts
 * @returns {Promise<string>} plain English: what ended it
 */
function waitForTheEnd(window, opts) {
  return new Promise((resolve) => {
    let done = false;
    /** @param {string} why */
    const finish = (why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(why);
    };
    const timer = setTimeout(
      () => finish(`The recording stopped itself after ${Math.round(opts.forMs / 1000)} seconds, which is as long as one is allowed to run.`),
      opts.forMs,
    );
    // Unref'd on purpose: a recording that ended because the window closed must not hold the
    // process open for the rest of its time budget.
    if (typeof timer.unref === 'function') timer.unref();
    window.page.on('close', () => finish('The page was closed.'));
    window.context.on('close', () => finish('The window was closed.'));
    opts.signal?.addEventListener('abort', () => finish('You stopped the recording.'), { once: true });
  });
}

// ---------------------------------------------------------------------------
// From what happened to steps somebody can walk
// ---------------------------------------------------------------------------

/**
 * How long after an act a navigation still counts as that act's doing.
 *
 * Generous, because the alternative is dangerous in one direction only. Treating a
 * click's own navigation as a step of its own writes a `goto` that walks past a broken
 * button; treating a person's deliberate second address as part of the click loses one
 * step, which shows up immediately as a journey that does not reach where they went.
 */
const CAUSED_BY_THE_LAST_ACT_MS = 8000;

/** Acts that make a page move on their own. A navigation just after one of these is its result. */
const MAKES_THE_PAGE_MOVE = new Set(['click', 'press', 'type']);

/**
 * Turn a watched browser session into steps the web adapter already knows how to walk.
 *
 * The vocabulary is version 1's — `goto`, `click`, `type` with `text`, `press` — and that is
 * deliberate: it is what `runStep` in src/v2/adapters/web-driver.js reads, so a recording
 * needs no new code anywhere on the walking side, and a project that already writes screens
 * by hand can read a recording and recognise every line of it.
 *
 * @param {SessionEvent[]} events
 * @param {{baseUrl?: string}} [opts]
 * @returns {{steps: JourneyStep[], dropped: number, collapsed: number, hidden: number, hiddenWhat: string[], acts: number}}
 */
export function webStepsFrom(events, opts = {}) {
  const kept = dropNavigationsCausedByAnAct(events);
  // The cleaning is `record.js`'s, unchanged and on purpose: a mouse path is not a journey,
  // ten keystrokes into one box are one thing that happened, and a recorded pause is a timing
  // from one machine that will be wrong on the next one. That reasoning is written down once,
  // where it belongs, and this file does not get a second opinion about it.
  const cleaned = stepsFromEvents(kept);

  /** @type {JourneyStep[]} */
  const steps = [];
  let acts = 0;
  for (const step of cleaned.steps) {
    const target = typeof step.target === 'string' ? step.target : '';
    if (step.act === 'navigate') {
      const where = addressToWalk(target, opts.baseUrl);
      steps.push({ act: 'open', goto: where, note: `open ${where}` });
      continue;
    }
    if (step.act === 'click') {
      steps.push({ act: 'click', click: target, note: step.note ?? `click ${target}` });
      acts += 1;
      continue;
    }
    if (step.act === 'type') {
      steps.push({ act: 'type', type: target, text: String(step.value ?? ''), note: step.note ?? `type into ${target}` });
      acts += 1;
      continue;
    }
    if (step.act === 'press') {
      steps.push({ act: 'press', press: target || 'Enter', note: step.note ?? 'press Enter' });
      acts += 1;
      continue;
    }
    // Anything else is kept exactly as the cleaner left it. A step this file does not
    // recognise is not a step to throw away silently — the walk says out loud when it meets a
    // word it does not know, and that sentence is worth more than a quiet deletion here.
    steps.push(step);
  }
  return { steps, dropped: cleaned.dropped, collapsed: cleaned.collapsed, hidden: cleaned.hidden, hiddenWhat: cleaned.hiddenWhat, acts };
}

/**
 * Drop every navigation that was somebody's click arriving, and keep the ones they asked for.
 *
 * READ THE NOTE AT THE TOP OF THIS FILE BEFORE CHANGING THIS. A `goto` written down after a
 * click re-opens the page that click was supposed to reach, so a broken button lands on the
 * right page anyway and the check comes back clean about a product that no longer works.
 *
 * @param {SessionEvent[]} events
 * @returns {SessionEvent[]}
 */
export function dropNavigationsCausedByAnAct(events) {
  /** @type {SessionEvent[]} */
  const kept = [];
  /** @type {SessionEvent|null} */
  let lastAct = null;
  for (const event of events) {
    if (event.act === 'navigate') {
      const since = (event.at ?? 0) - (lastAct?.at ?? 0);
      if (lastAct && since <= CAUSED_BY_THE_LAST_ACT_MS) continue;
      kept.push(event);
      continue;
    }
    if (MAKES_THE_PAGE_MOVE.has(String(event.act))) lastAct = event;
    kept.push(event);
  }
  return kept;
}

/**
 * The address as a journey should keep it: the path, not the whole URL.
 *
 * A recorded `http://127.0.0.1:53119/orders` is a fact about one afternoon — the port is
 * handed out fresh on every boot, so the journey would open nothing on the next run, and
 * `whatWillNotReplay` says so by name. The path survives, and the web adapter puts it back
 * on whichever address the app came up at this time.
 *
 * @param {string} url
 * @param {string} [baseUrl]
 * @returns {string}
 */
export function addressToWalk(url, baseUrl) {
  try {
    const there = new URL(url);
    if (!baseUrl) return `${there.pathname}${there.search}${there.hash}`;
    const own = new URL(baseUrl);
    if (there.origin !== own.origin) return there.toString();
    return `${there.pathname}${there.search}${there.hash}`;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Does it do the same thing twice?
// ---------------------------------------------------------------------------

/** A walk that met something it could not do. The reason word is what the adapter wrote down. */
const COULD_NOT_WALK_IT = /\((timed out|crashed|missing tool|refused)\)/;

/**
 * @typedef {object} Acceptance
 * @property {boolean} accepted
 * @property {string} how            Plain English: what was actually done to decide.
 * @property {string[]} why          Why it was refused. Empty when it was accepted.
 * @property {GatheredJourney} journey  With `reproducible` filled in when it was accepted.
 */

/**
 * Walk a fresh recording twice against the same build, and only then say it may be kept.
 *
 * Three ways a recording fails here, and each one is a real thing that happens:
 *   - IT DESCRIBES NOTHING THAT WILL BE TRUE TOMORROW. A port, a one-off id, a timestamp,
 *     a path into a temporary folder. Said by `whatWillNotReplay`, before anything is run.
 *   - IT COULD NOT BE WALKED EVEN ONCE. A step aimed at something that is not there any
 *     more, or was never there under that name. Both walks fail the same way, so the repeat
 *     check alone would call that steady — which is why the walks are read for holes as
 *     well as compared with each other.
 *   - IT ARGUES WITH ITSELF. Two walks of identical bytes disagreed about what exists. That
 *     is `checkReproducible`, and it is the same front-door rule every other journey source
 *     is held to.
 *
 * @param {object} opts
 * @param {GatheredJourney} opts.journey
 * @param {(req: any) => Promise<Capture>} opts.walk
 * @param {import('../types.js').BuildFingerprint} opts.build
 * @param {(message: string) => void} [opts.log]
 * @returns {Promise<Acceptance>}
 */
export async function acceptIfItRepeats(opts) {
  /** @type {string[]} */
  const why = [];

  const willNotReplay = whatWillNotReplay(opts.journey);
  if (willNotReplay.length > 0) {
    return {
      accepted: false,
      how: 'It was read before it was walked, and it holds something that will not mean the same thing tomorrow.',
      why: willNotReplay,
      journey: opts.journey,
    };
  }

  /** @type {Capture[]} */
  const seen = [];
  opts.log?.('Walking it twice against this build, to prove it does the same thing both times.');
  const verdict = await checkReproducible([opts.journey], {
    build: opts.build,
    walk: async (req) => {
      const capture = await opts.walk(req);
      seen.push(capture);
      return capture;
    },
    log: opts.log,
  });

  for (const capture of seen) {
    for (const observation of capture.observations) {
      const refusedWhy = observation.meta?.refusedWhy;
      if (typeof refusedWhy === 'string' && COULD_NOT_WALK_IT.test(refusedWhy)) {
        why.push(`Walking it did not get through the steps: ${observation.meta?.describe ?? refusedWhy}`);
      }
    }
    for (const hole of capture.coverage?.gaps ?? []) why.push(`${hole.what} ${hole.why}`);
  }
  for (const rejection of verdict.rejected) why.push(rejection.why);

  const unique = [...new Set(why)];
  if (unique.length > 0) {
    return {
      accepted: false,
      how: 'It was walked twice against the same build, exactly as a later check would walk it.',
      why: unique,
      journey: opts.journey,
    };
  }
  return {
    accepted: true,
    how: verdict.kept[0]?.reproducible?.how ?? 'It was walked twice against the same build and did the same thing both times.',
    why: [],
    journey: verdict.kept[0] ?? opts.journey,
  };
}

// ---------------------------------------------------------------------------
// The whole thing, end to end
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RecordingResult
 * @property {boolean} accepted
 * @property {string} name
 * @property {string} [file]           Where it was written. Absent when it was refused.
 * @property {GatheredJourney} journey
 * @property {string} how              What was done to decide, in plain English.
 * @property {string[]} why            Why it was refused. Empty when it was kept.
 * @property {string[]} notes          Anything worth saying either way.
 * @property {number} events           Raw things the browser reported.
 * @property {number} hidden           Values taken out because they were secret.
 */

/**
 * Record one session against this project's web app, prove it repeats, and write it down.
 *
 * The app is booted the same way a check boots it — the web adapter's own `prepare`, into a
 * scratch copy of the project, on a port nobody else is on. Recording against the copy the
 * person happens to have running would capture whatever state that copy is in, and the first
 * replay in a clean copy would then disagree with it for reasons that are nobody's fault.
 *
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {string} opts.name                     What to call it. Lowercase letters, numbers and dashes.
 * @param {string} [opts.describe]               One plain sentence. Worked out from the steps if absent.
 * @param {string} [opts.at]                     The address to record against, instead of booting.
 * @param {boolean} [opts.headed]                Show the window. True unless a test says otherwise.
 * @param {number} [opts.forMs]
 * @param {(page: any) => Promise<void>} [opts.drive]
 * @param {(message: string) => void} [opts.log]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<RecordingResult>}
 */
export async function recordAJourney(opts) {
  const name = slug(opts.name);
  if (name === '') {
    throw new StaysFixedError('A recording needs a name, and it becomes a file name and the head of every address the journey produces.', {
      hint: 'Try: staysfixed record signing-in',
    });
  }
  const log = opts.log ?? (() => {});
  const { root, config } = await settingsFor({ cwd: opts.cwd });
  const webConfig = { ...(config.web ?? {}) };
  if (opts.at) webConfig.url = opts.at;

  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-record-'));
  /** @type {string[]} */
  const notes = [];
  /** @type {(() => Promise<void>)[]} */
  const cleanUps = [async () => fsp.rm(scratch, { recursive: true, force: true }).catch(() => {})];

  try {
    const where = await bootTheProduct({ root, scratch, config: webConfig, log, cleanUps });
    log(`Opening ${where.baseUrl}.`);
    const session = await followASession({
      url: where.baseUrl,
      scratchDir: scratch,
      projectRoot: root,
      headed: opts.headed,
      forMs: opts.forMs,
      drive: opts.drive,
      log,
      signal: opts.signal,
    });
    notes.push(session.why);

    const built = webStepsFrom(session.events, { baseUrl: where.baseUrl });
    if (built.acts === 0) {
      return {
        accepted: false,
        name,
        journey: journeyFrom({ name, describe: opts.describe, steps: built.steps, built }),
        how: 'The session was watched from the moment the product opened until the window closed.',
        why: [
          'Nothing was done in it. The product was opened and nothing was clicked, typed or pressed, so there is no journey here — replaying it would only open the front page, which reading the code already does for free.',
        ],
        notes,
        events: session.events.length,
        hidden: built.hidden,
      };
    }
    if (built.hidden > 0) {
      notes.push(
        `${built.hidden} ${built.hidden === 1 ? 'value was' : 'values were'} taken out because ${built.hidden === 1 ? 'it was' : 'they were'} secret (${built.hiddenWhat.join(', ')}). ` +
          `A replay types "${HIDDEN}" into those boxes rather than the real thing, so a recording of a sign-in does not sign in — put the value in your settings and point the step at it instead.`,
      );
    }

    const journey = journeyFrom({ name, describe: opts.describe, steps: built.steps, built });
    // The same settings the recording was made against, `--at` included, so the two walks
    // that decide its fate open exactly what the person was looking at.
    const walker = await walkerFor({ cwd: root, config: { ...config, web: webConfig } });
    cleanUps.push(walker.close);
    const verdict = await acceptIfItRepeats({
      journey,
      walk: walker.walk,
      build: { id: `recording-${name}`, product: String(config.product ?? path.basename(root)), surface: 'web' },
      log,
    });

    if (!verdict.accepted) {
      return { accepted: false, name, journey: verdict.journey, how: verdict.how, why: verdict.why, notes, events: session.events.length, hidden: built.hidden };
    }

    const file = path.join(root, RECORDINGS_DIR, `${name}.json`);
    const written = await saveJourneys(file, [verdict.journey], {
      product: String(config.product ?? path.basename(root)),
      note: 'Recorded sessions. Commit these: they are the promise, not the evidence. `staysfixed check --journeys recorded` walks them.',
    });
    return {
      accepted: true,
      name,
      file: written.file,
      journey: verdict.journey,
      how: verdict.how,
      why: [],
      notes,
      events: session.events.length,
      hidden: built.hidden,
    };
  } finally {
    for (const done of cleanUps.reverse()) await done().catch(() => {});
  }
}

/**
 * Boot this project's web app so there is something to record against.
 *
 * @param {object} opts
 * @param {string} opts.root
 * @param {string} opts.scratch
 * @param {Record<string, any>} opts.config
 * @param {(message: string) => void} opts.log
 * @param {(() => Promise<void>)[]} opts.cleanUps
 * @returns {Promise<{baseUrl: string}>}
 */
async function bootTheProduct(opts) {
  const address = opts.config.url ?? opts.config.baseUrl ?? null;
  if (!opts.config.start && !address) {
    throw new StaysFixedError('There is nothing to record against: this project has no command that starts its web app and no address it is already running at.', {
      hint: 'Put {"start": "npm run dev"} under "web" in your settings — it should listen on the PORT it is given — or pass --at http://localhost:3000 for something already running.',
    });
  }
  if (!opts.config.start && address) {
    // Recording against an app somebody else started is allowed, and it is worth one line.
    // Nothing here can put that app back the way it was found, so a recording made against it
    // carries whatever state it happened to be in.
    opts.log(`Recording against the app already running at ${address}. Whatever state that app is in is the state this recording will expect to find.`);
    return { baseUrl: String(address) };
  }

  opts.log('Starting your app in a copy of this project, so nothing you have open is touched.');
  const prepared = await webAdapter.prepare(
    { id: `record-${Date.now().toString(36)}`, label: 'the build you have', role: 'candidate', root: opts.root, gitSha: null },
    {
      scratchDir: path.join(opts.scratch, 'boot'),
      evidenceDir: path.join(opts.scratch, 'evidence'),
      config: opts.config,
      seed: 20260829,
      clock: '2026-08-29T09:00:00.000Z',
      log: opts.log,
    },
  );
  opts.cleanUps.push(async () => prepared.dispose());
  if (!prepared.ready) throw new StaysFixedError(`Your app could not be started, so there is nothing to record against: ${prepared.why}`);
  const baseUrl = prepared.facts?.baseUrl;
  if (typeof baseUrl !== 'string' || baseUrl === '') {
    throw new StaysFixedError('Your app started but never said what address it came up at, so nothing could be opened.');
  }
  return { baseUrl };
}

/**
 * @param {{name: string, describe?: string, steps: JourneyStep[], built: ReturnType<typeof webStepsFrom>}} input
 * @returns {Journey}
 */
function journeyFrom(input) {
  const doing = input.steps
    .filter((step) => step.act !== 'open')
    .map((step) => String(step.note ?? step.act))
    .slice(0, 4);
  return {
    name: input.name,
    describe: input.describe ?? (doing.length > 0 ? `a recorded session: ${doing.join(', then ')}` : 'a recorded session with nothing in it'),
    source: 'recorded',
    surface: 'web',
    from: 'a session somebody performed',
    channels: ['meaning', 'effects', 'complaints', 'results', 'counters', 'pixels'],
    steps: input.steps,
  };
}

/**
 * A name that can be a file, a folder and the head of an address.
 * @param {string} wanted
 * @returns {string}
 */
export function slug(wanted) {
  return String(wanted ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * `staysfixed record`, in the shape src/cli/index.js merges.
 *
 * @type {Record<string, {summary: string, usage: string, describe: string, options: [string,string][], examples: string[], spec: {booleans?: string[], strings?: string[], arrays?: string[]}, load: () => Promise<{run: (ctx: any) => Promise<number>}>}>}
 */
export const RECORD_COMMANDS = {
  record: {
    summary: 'Do the thing you care about once, and have it checked for ever.',
    usage: 'staysfixed record <name> [--at <url>] [--describe "<what it does>"] [--for <seconds>] [--json]',
    describe:
      'Opens your product, follows what you do in it, and writes it down as a journey every\nlater check walks. Close the window when you are done.\n\nThis is the one thing reading your source cannot do. The code says which doors exist;\nit never says which four you open every morning, in which order, with what in the\nboxes. A recording is how the tool learns that, and it only has to be told once.\n\nBefore a recording is kept it is walked TWICE against the same build, and anything\nthat differs between those two walks is thrown away rather than saved — a journey that\nargues with itself would go red for no reason on somebody else\'s laptop, and a check\nnobody trusts is worse than no check at all. If it does not repeat, it is refused and you\nare told why.\n\nPasswords, tokens, card numbers and one-time codes are taken out on the way to the\nfile, and the count of what was hidden is written into it. Recordings belong in git:\nthey are the promise, not the evidence.\n\nToday this records a WEB app, in a browser of the tool\'s own. Checking a recording\nis not limited that way - `--journeys recorded` walks whatever surface the file names -\nbut nothing yet follows your hands around a desktop or a phone, and saying so is better\nthan opening a browser at a product that is not one.',
    options: [
      ['--at <url>', 'Record against something already running at this address instead of starting your app.'],
      ['--describe "<text>"', 'One plain sentence saying what this session does. Worked out from the steps if you leave it out.'],
      ['--for <seconds>', 'Stop recording after this long, whatever happens. Ten minutes by default.'],
      ['--json', 'The whole answer as one JSON object and nothing else. For agents.'],
    ],
    examples: [
      'staysfixed record signing-in',
      'staysfixed record the-morning-round --describe "the four screens I open every morning"',
      'staysfixed record checkout --at http://localhost:3000',
    ],
    spec: { booleans: ['json'], strings: ['at', 'describe', 'for'] },
    load: async () => ({ run }),
  },
};

/**
 * @param {import('../../cli/index.js').CliContext} ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  const asJson = ctx.bool('json');
  // Nothing meant for a person may reach standard output when an agent asked for JSON. One
  // stray sentence in front of the object is a parse error rather than a warning.
  if (asJson) setLogLevel({ quiet: true });

  const wanted = ctx.args[0];
  if (!wanted) {
    throw new StaysFixedError('A recording needs a name, so that later runs can say which session found something.', {
      hint: 'Try: staysfixed record signing-in',
    });
  }

  const stop = new AbortController();
  const onInterrupt = () => stop.abort();
  process.once('SIGINT', onInterrupt);

  /** @type {RecordingResult} */
  let result;
  try {
    result = await recordAJourney({
      cwd: ctx.cwd,
      name: wanted,
      describe: ctx.str('describe'),
      at: ctx.str('at'),
      forMs: seconds(ctx.str('for')),
      log: (message) => {
        if (!asJson) say(paint.grey(`  ${message}`));
      },
      signal: stop.signal,
    });
  } finally {
    process.off('SIGINT', onInterrupt);
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.accepted ? EXIT.ok : EXIT.error;
  }

  blank();
  if (!result.accepted) {
    fail(`"${result.name}" was not kept.`);
    say(`  ${result.how}`);
    for (const line of result.why) say(paint.grey(`  ${line}`));
    blank();
    say('Nothing was written. A recording that does not repeat would go red on somebody else\'s machine for no reason, and this tool would stop being believed.');
    for (const note of result.notes) say(paint.grey(`  ${note}`));
    return EXIT.error;
  }

  ok(`"${result.name}" was recorded and kept.`);
  say(`  ${result.journey.describe}`);
  say(paint.grey(`  ${result.how}`));
  heading('The steps');
  for (const step of result.journey.steps ?? []) say(`  ${step.note ?? step.act}`);
  for (const note of result.notes) say(paint.grey(`  ${note}`));
  blank();
  say(`Written to ${result.file}. Commit it: it is the promise, not the evidence.`);
  say('From now on: `staysfixed check --journeys recorded` walks it.');
  return EXIT.ok;
}

/**
 * @param {string|undefined} value
 * @returns {number|undefined}
 */
function seconds(value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new StaysFixedError(`"--for ${value}" is not a number of seconds.`, { hint: 'Try: --for 120' });
  }
  return n * 1000;
}
