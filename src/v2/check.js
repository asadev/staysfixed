/**
 * The engine's front door.
 *
 * `run.js` owns the loop — run the new build twice, subtract the wobble, compare, prove,
 * cluster, rank. It deliberately knows nothing about where journeys come from, what a build
 * is on disk, or how to boot an old one. This file is the part that knows, and it is the
 * only thing the command line and the MCP server ever call.
 *
 * Everything above the loop lives here:
 *   - which adapters can drive this project, and which one owns each journey
 *   - where the steps come from: a journeys file, the project's config, or the code itself
 *   - what counts as "the build you have" and "the build you were happy with"
 *   - how the old build is put back on this machine so it can be walked live
 *
 * TWO PROMISES THIS FILE KEEPS.
 *
 * It never writes into the project being checked. The candidate is copied into a scratch
 * folder before anything runs, and the old build is exported out of git with `git archive`,
 * which reads history and touches neither the working tree nor `.git`.
 *
 * And it never reports "could not run" as "nothing changed". A check that was blocked comes
 * back with `blocked` set, and every reader — the command line, the MCP reply, the self-check
 * corpus — treats that as no answer at all rather than as a pass.
 */

import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { StaysFixedError, messageOf } from '../core/errors.js';
import { warn, detail } from '../core/log.js';
import { findConfigFile, rootForConfig } from '../core/paths.js';
import { sha256 } from '../core/hash.js';

import { openStore, ensureStore, saveBuild, newCaptureId, storeExists } from './store.js';
import { decide, noDecisions, readDecisions, rememberCheck, readCheckRecord } from './escalate.js';
import { sortObservations } from './observation.js';
import { DEFAULT_RULES, machineRules, mergeRules, normaliseCapture, loadRules } from './normalise.js';
import { runCheck, makeCheckEvents } from './run.js';
import { proveCause } from './cause.js';
import { whatChanged } from './rank.js';

import { attachWatcher, watchOptionsFrom } from './watch/index.js';
import { guardTheScreen, describeGuard } from './watch/focus.js';
import {
  isOffScreen, moveWindowByPid, offScreen, windowBoundsByPid, withoutTakingTheScreen,
} from './watch/window.js';
import { onAppStarted, stillOpen } from './adapters/isolate.js';

import { processAdapter } from './adapters/process.js';
import { sourceAdapter } from './adapters/source.js';
import { httpAdapter } from './adapters/http.js';
import { webAdapter } from './adapters/web.js';
import { electronAdapter } from './adapters/electron.js';

const exec = promisify(execFile);

/** @typedef {import('./types.js').Verdict} Verdict */
/** @typedef {import('./types.js').Journey} Journey */
/** @typedef {import('./types.js').Capture} Capture */
/** @typedef {import('./types.js').Observation} Observation */
/** @typedef {import('./types.js').BuildFingerprint} BuildFingerprint */
/** @typedef {import('./types.js').Coverage} Coverage */
/** @typedef {import('./types.js').Channel} Channel */
/** @typedef {import('./types.js').NormaliseRule} NormaliseRule */
/** @typedef {import('./types.js').Surface} Surface */
/** @typedef {import('./types.js').CoverageGap} CoverageGap */
/** @typedef {import('./adapters/contract.js').Adapter} Adapter */
/** @typedef {import('./run.js').LiveBuild} LiveBuild */
/** @typedef {import('./run.js').WalkRequest} WalkRequest */
/** @typedef {import('./run.js').CheckEvents} CheckEvents */
/** @typedef {import('./watch/index.js').PanelOptions} PanelOptions */
/** @typedef {import('./watch/index.js').WatchFlags} WatchFlags */
/** @typedef {import('./adapters/isolate.js').OpenedApp} OpenedApp */

/**
 * What a check hands back.
 *
 * A Verdict, plus the two states a Verdict has no room for.
 *
 * BLOCKED: "I could not test this" is neither a pass nor a failure, and filing it under
 * either is the exact failure this tool exists to prevent — so it travels as its own flag
 * with a plain sentence beside it.
 *
 * ACCOUNTED: how much of what the engine found never reached the reader, and why. A verdict
 * that quietly dropped fifty waived findings and a verdict that genuinely found nothing read
 * identically without this, and one of those is a safety net that has been switched off.
 *
 * AIMED AT: what the run says it went for. A caller that aimed the check at a web page or
 * a phone app has to be able to tell "it went there and found nothing" apart from "it
 * quietly checked something else and found nothing", and those two read identically
 * without this. It is only ever set when the run really did reach that surface.
 *
 * @typedef {Verdict & {blocked?: boolean, accounted?: import('./escalate.js').Accounting, target?: {surface: string, at: string|null}}} CheckOutcome
 */

/**
 * What the front door takes. Both spellings of the project folder are accepted because the
 * command line says `root` and the MCP surface says `cwd`, and neither is worth a rename.
 *
 * @typedef {object} CheckOptions
 * @property {string} [cwd]
 * @property {string} [root]
 * @property {string} [configFile]
 * @property {string} [against]     A commit, tag or stored build to compare against.
 * @property {boolean} [paired]     Boot the old build live from the start.
 * @property {boolean} [storedOnly] Never boot the old build, not even to prove a suspicion.
 * @property {string} [journeys]    A path to a journeys file, or 'code' / 'config'.
 * @property {Surface|'auto'} [surface]  Aim the whole run at one kind of product.
 * @property {string} [at]          Where that product is: a URL for the web, the built app
 *                                  for a desktop, an APK or an .app bundle for a phone.
 * @property {string[]} [only]      Just these journeys, by name.
 * @property {boolean} [remember]
 * @property {string} [product]
 * @property {CheckEvents} [events]
 * @property {AbortSignal} [signal]
 * @property {WatchFlags} [watch]   What the person typed about the live panel. The settings
 *                                  file has its say too, and this is merged over it.
 */

/** The adapters compiled into every copy, in the order the engine trusts them. Reading the code is free, so it is first. */
const BUILT_IN = [sourceAdapter, processAdapter, httpAdapter, webAdapter, electronAdapter];

/**
 * The platforms that arrive as a file of their own.
 *
 * They are looked for at run time rather than imported, for one reason: a copy of Stays
 * Fixed without the Android adapter in it must still run every other check, and must say
 * "there is nothing here that can drive an Android app" rather than dying on an import.
 * The alternative — handing an Android journey to whichever adapter happened to be in the
 * table — is the exact bug that bit web and Electron last phase, and it is the worst
 * failure this tool has: a journey nothing walked, reported as covered.
 *
 * @type {{surface: Surface, file: string, exports: string[], missing: string}[]}
 */
const SEPARATE_ADAPTERS = [
  {
    surface: 'android',
    file: './adapters/android.js',
    exports: ['androidAdapter', 'adapter', 'default'],
    missing: 'This copy has no Android adapter in it, so nothing here can install an APK on an emulator and read what is on its screen.',
  },
  {
    surface: 'ios',
    file: './adapters/ios.js',
    exports: ['iosAdapter', 'adapter', 'default'],
    missing: 'This copy has no iPhone adapter in it, so nothing here can boot the simulator and read what is on its screen.',
  },
  {
    surface: 'windows',
    file: './adapters/windows.js',
    exports: ['windowsAdapter', 'adapter', 'default'],
    missing:
      'This copy has no native-Windows adapter in it. That is usually fine: a Windows product built with Electron is driven over its own debugging port by the Electron adapter and needs nothing else.',
  },
];

/**
 * Every adapter this copy can actually use. Seeded with the built-in five and widened
 * once, on the first check, by whatever separate adapters are present.
 * @type {Adapter[]}
 */
const ADAPTERS = [...BUILT_IN];

/**
 * Surfaces there is no adapter for, and the plain sentence saying so. Read when a journey
 * cannot be walked, so the gap names what is missing instead of shrugging.
 * @type {Map<string, string>}
 */
const NO_ADAPTER_FOR = new Map();

let adaptersLoaded = false;

/**
 * Which adapter owns a journey, by the surface it says it walks.
 *
 * Every surface in the vocabulary appears here, and every one of them names an adapter
 * built for that surface — never a stand-in. A surface whose adapter is not in this copy
 * resolves to nothing, and nothing is walked and it is reported as a hole. A surface
 * pointed at the wrong adapter walks nothing and is reported as COVERED, which is the one
 * outcome this tool must never produce.
 *
 * @type {Record<Surface, string>}
 */
export const ADAPTER_FOR_SURFACE = {
  cli: 'process',
  library: 'process',
  server: 'http',
  web: 'web',
  electron: 'electron',
  android: 'android',
  ios: 'ios',
  windows: 'windows',
};

/**
 * Load the separate adapters, once per process.
 *
 * Exported so `doctor` and the tests can ask what this copy can actually drive without
 * running a check. A refresh is only useful while Stays Fixed itself is being built and an
 * adapter appears mid-session.
 *
 * @param {boolean} [refresh]
 * @returns {Promise<{adapters: Adapter[], missing: Map<string, string>}>}
 */
export async function loadAdapters(refresh = false) {
  if (adaptersLoaded && !refresh) return { adapters: ADAPTERS, missing: NO_ADAPTER_FOR };
  if (refresh) {
    ADAPTERS.length = 0;
    ADAPTERS.push(...BUILT_IN);
    NO_ADAPTER_FOR.clear();
  }

  for (const spec of SEPARATE_ADAPTERS) {
    const wanted = ADAPTER_FOR_SURFACE[spec.surface];
    if (ADAPTERS.some((a) => a.name === wanted)) continue;
    /** @type {Record<string, unknown>} */
    let module;
    try {
      // The specifier is built from a variable on purpose. A literal would be resolved
      // when this file is type-checked and fail there, in a copy where the file simply
      // has not been written yet — which is a fact about this build, not an error.
      const where = spec.file;
      module = await import(where);
    } catch (e) {
      // "It is not here" and "it is here and it is broken" are two different facts and
      // only one of them is fixed by installing a newer copy. Saying the first when the
      // second is true sends somebody to reinstall a tool that is already installed.
      NO_ADAPTER_FOR.set(
        spec.surface,
        existsSync(new URL(spec.file, import.meta.url))
          ? `The ${spec.surface} adapter is in this copy and it will not load: ${messageOf(e)}. Nothing ${spec.surface} can be walked until that is fixed.`
          : spec.missing,
      );
      continue;
    }
    const found = spec.exports.map((name) => module[name]).find((a) => a && typeof a === 'object' && typeof (/** @type {any} */ (a).run) === 'function');
    if (!found) {
      NO_ADAPTER_FOR.set(
        spec.surface,
        `${spec.missing} The file ${spec.file} is there, but it does not export ${spec.exports.join(' or ')}.`,
      );
      continue;
    }
    const adapter = /** @type {Adapter} */ (found);
    if (adapter.name !== wanted) {
      // A mismatch here would leave the adapter loaded and unreachable, which looks
      // exactly like coverage and is not.
      NO_ADAPTER_FOR.set(
        spec.surface,
        `${spec.file} exports an adapter called "${adapter.name}", and a ${spec.surface} journey looks for one called "${wanted}". Nothing will drive it until those agree.`,
      );
      continue;
    }
    ADAPTERS.push(adapter);
  }

  adaptersLoaded = true;
  return { adapters: ADAPTERS, missing: NO_ADAPTER_FOR };
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

/**
 * Prove that nothing which already worked has changed.
 *
 * @param {CheckOptions} [options]
 * @returns {Promise<CheckOutcome>}
 */
export async function check(options = {}) {
  const events = options.events ?? makeCheckEvents();
  /** @type {Project|null} */
  let project = null;
  /** @type {ScreenMinder|null} */
  let screen = null;
  try {
    project = await openProject(options);
    // Before a single thing is opened. Everything this run puts on somebody's screen —
    // the live panel, the desktop app under check — goes through here, and so does the
    // promise that none of it takes the screen off the person using the machine.
    screen = await mindTheScreen(project, events);
    const verdict = await runCheck({
      store: project.store,
      product: project.product,
      candidate: project.candidate,
      journeys: project.journeys,
      gaps: project.gaps,
      walk: project.walk,
      cwd: project.root,
      bootReference: project.bootReference,
      against: project.against,
      paired: options.paired === true,
      storedOnly: options.storedOnly === true,
      remember: options.remember,
      normalise: project.normalise,
      events,
      signal: options.signal,
    });
    // The screen is given back before the answer is written, so anything the guard had
    // to do lands in the sentence a person reads rather than in a log line after it.
    const minded = screen ? await screen.handBack() : null;
    if (minded) verdict.summary = `${verdict.summary} ${minded}`;

    // The real ledger, door by door, before anything says how much was covered. The loop
    // only knows how many doors it read out of the source and that no journey named one;
    // this reads what every capture of this build actually touched and works out which
    // doors were opened. Without it the coverage sentence is built on a count that says
    // "nothing was walked" on a run that walked plenty.
    await countTheDoors(verdict, project);

    /** @type {CheckOutcome} */
    const outcome = await settle(verdict, project.store, project.product);
    // Only a run that really did reach the surface it was aimed at may say so. The
    // confirmation is what lets a caller tell "it went there and found nothing" from
    // "it checked something else and found nothing", and those are not the same answer.
    if (project.target) outcome.target = project.target;

    // The live window was told the engine's verdict the moment the loop finished — before
    // the gates were applied to it, before the waived findings were taken out, and before
    // the coverage sentence went on the end. Left there, a window would show a greener,
    // shorter answer than the terminal beside it, and the two would disagree about the same
    // run. So it is told again, with the settled one, and only then put away.
    events.emit({ type: 'check:done', at: events.elapsed(), message: outcome.summary, verdict: outcome });
    if (screen) {
      await screen.finish();
      screen = null;
    }
    return outcome;
  } catch (e) {
    const outcome = blocked(options, e);
    // A run that never happened still has to reach a person, because "no answer" looks
    // exactly like "nothing changed" from the outside. It is only written down where a
    // store already exists: a check aimed at a folder that was never set up must not leave
    // a folder of its own behind as its parting gesture.
    const store = openStore({ root: projectRootFor(options) });
    if (storeExists(store)) await settle(outcome, store, outcome.product);
    // And the window hears it too. Without this a check that was blocked leaves a window
    // sitting there saying "running" for the rest of the day, which is the one thing worse
    // than no window: it looks like a check that is still going rather than one that never
    // got anywhere.
    events.emit({ type: 'check:done', at: events.elapsed(), message: outcome.summary, verdict: outcome });
    return outcome;
  } finally {
    // A check that threw is exactly when a scratch app is left standing on somebody's
    // screen and a guard is left polling for it, so this runs whatever happened.
    if (screen) await screen.finish().catch(() => {});
    if (project) await project.close();
    // Everything this run opened has to be gone. `project.close` tears the adapters down
    // and each of them releases its own isolations; if anything is still on the books
    // after that, the tool has left a copy of somebody's app running, and that is worth
    // saying out loud rather than discovering as a second app on the screen.
    const left = stillOpen();
    if (left > 0) {
      warn(
        `${left} ${left === 1 ? 'copy' : 'copies'} of an app this check opened could not be accounted for at the end. ` +
          'Look for a stray window before running it again: two copies of one app fight over the same settings and the same identity.',
      );
    }
  }
}

/**
 * The step between "what is different" and "what anybody has to read".
 *
 * The engine's job ends at finding differences. Deciding which of them an agent may stop
 * looking at is a separate job with its own rules, and it is done here rather than inside
 * the loop so that an engine bug can never widen a gate. Three things happen:
 *
 *   - findings already recorded as intended, against the reference that is in force NOW, are
 *     dropped from what anybody reads — and counted, out loud, on the verdict;
 *   - findings in a sealed class are marked unwaivable, so no later code has to re-derive
 *     that rule and no later code can get it wrong;
 *   - the whole thing is written down, so `staysfixed_explain`, `staysfixed_prove` and the
 *     escalation block can all be handed an id and answer honestly.
 *
 * Bookkeeping may never lose an answer. Everything after the arithmetic is wrapped, because
 * a full disk is a reason to lose a record and never a reason to lose a verdict.
 *
 * @param {CheckOutcome} verdict
 * @param {import('./types.js').Store} store
 * @param {string} product
 * @param {string[]} [guards]  Guard names, so a difference touching one is sealed by name.
 * @returns {Promise<CheckOutcome>}
 */
async function settle(verdict, store, product, guards) {
  /** @type {import('./escalate.js').Decisions} */
  let decisions;
  try {
    decisions = await readDecisions(store, product);
  } catch {
    // Unreadable bookkeeping means nothing is accounted for, which reports MORE than it
    // should rather than less. That is the only safe direction for this to fail in.
    decisions = noDecisions(product);
  }

  const decided = decide(verdict.findings ?? [], decisions, { guards: guards ?? [] });
  verdict.findings = decided.reported;
  verdict.accounted = decided.accounting;
  if (verdict.blocked !== true) {
    verdict.ok = decided.reported.length === 0 && (verdict.newlyUnstable ?? []).length === 0;
    // The count goes into the sentence a person and an agent both read, not into a field
    // one of them has to know to look for.
    if (decided.accounting.waived > 0 || decided.accounting.expiredWaivers > 0) {
      verdict.summary = `${verdict.summary} ${decided.accounting.note}`;
    }
    // The worst shape a reply can have: every journey walked, not one of them with
    // anything on the other side to compare against, and a verdict that reads "nothing
    // that worked has changed". It is arithmetically true — nothing was compared, so
    // nothing came back different — and it is the exact sentence that would let a real
    // regression through. It is not a pass. It is no answer at all.
    if (comparedNothing(verdict.coverage)) {
      verdict.ok = false;
      verdict.summary = `NOTHING WAS ACTUALLY COMPARED. Every journey was walked on the build you have, and not one of them had anything on record from the build you were happy with, so there was nothing to hold them against. This is not a pass and not a failure — it is no answer. ${verdict.summary}`;
    }

    // And what was NOT looked at, in the same breath as the good news, on every run
    // including the clean ones. A green verdict on a product with three hundred doors
    // nobody has ever opened is true and it is not what it looks like, and the only place
    // that difference can be made impossible to miss is inside the sentence everybody
    // already reads. It goes last so it is the thing left in the reader's head.
    verdict.summary = `${verdict.summary} ${whatWasNotChecked(verdict.coverage)}`;
  }

  try {
    await rememberCheck(store, { product, verdict, decided });
  } catch {
    // Nothing here is worth failing a finished check over.
  }
  return verdict;
}

/**
 * Replace this run's rough coverage count with the real one.
 *
 * `coverage.js` owns the arithmetic and one rule that makes it worth having: a door READ
 * out of the source is not a door that was WALKED, so every contract observation is
 * ignored when it works out what was opened. Getting that backwards would report perfect
 * coverage on a product nobody ever ran.
 *
 * It is loaded at run time and every failure is swallowed. This runs after the answer is
 * already in hand, and no bookkeeping is worth losing a finished check over — but the
 * count it replaces is the honest-if-crude one the loop produced, so failing here leaves
 * the reader with less detail and never with a rosier picture.
 *
 * @param {CheckOutcome} verdict
 * @param {Project} project
 * @returns {Promise<void>}
 */
async function countTheDoors(verdict, project) {
  try {
    const { ledger, toCoverage } = await import('./coverage.js');
    const led = await ledger(project.store, project.product, {
      root: project.root,
      journeys: project.journeys,
      builds: [project.candidate.id],
    });
    // No stored captures means the ledger saw none of this run's walking, and every door
    // would read as never opened. That is a worse answer than the one already in hand,
    // not a better one, so it is refused.
    if (led.captures === 0) return;

    const better = toCoverage(led);
    const run = verdict.coverage;
    /** @type {Coverage} */
    const merged = {
      // What THIS run walked stays this run's own number. The ledger counts every capture
      // of this build, including the second run of each journey, and doubling the address
      // count would make the run look twice as thorough as it was.
      paths: run?.paths ?? better.paths,
      journeys: run?.journeys ?? better.journeys,
      byChannel: run?.byChannel ?? better.byChannel,
      gaps: dedupe([...(run?.gaps ?? []).filter((g) => typeof g.doors !== 'number'), ...better.gaps]),
    };
    if (better.doorsKnown !== undefined) {
      merged.doorsKnown = better.doorsKnown;
      merged.doorsWalked = better.doorsWalked ?? 0;
    }
    verdict.coverage = merged;
  } catch {
    // The ledger could not be drawn up. The run's own count stands, and it errs towards
    // saying less was covered rather than more.
  }
}

/**
 * @param {CoverageGap[]} gaps
 * @returns {CoverageGap[]}
 */
function dedupe(gaps) {
  /** @type {CoverageGap[]} */
  const out = [];
  const seen = new Set();
  for (const gap of gaps) {
    const key = `${gap.what}|${gap.why}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(gap);
  }
  return out;
}

/**
 * What this run did NOT look at, in words, always.
 *
 * THIS IS THE MOST IMPORTANT SENTENCE THE TOOL PRODUCES, and the reason is arithmetic
 * rather than rhetoric: a tool that says "nothing changed" is indistinguishable from a
 * tool that looked at nothing, and the more useful this becomes the more a clean result
 * will be trusted without being read. So the sentence is never optional, never omitted on
 * a good run, and never phrased as "fully checked" — because nothing ever is. Even a run
 * that walked every door it knows about has only walked the doors it knows about.
 *
 * It returns a sentence in every case. There is deliberately no path through this function
 * that returns nothing, because a caller that could get an empty string back would sooner
 * or later drop the whole line on the runs where it matters most.
 *
 * @param {Coverage|undefined} coverage
 * @returns {string}
 */
export function whatWasNotChecked(coverage) {
  if (!coverage) {
    return 'This run did not say what it covered, so how much of your product was actually looked at is unknown — treat a clean result as unproven until it does.';
  }
  if ((coverage.paths ?? 0) === 0) {
    return 'Nothing was walked at all, so none of this says anything about your product either way.';
  }

  const known = coverage.doorsKnown ?? 0;
  const walked = coverage.doorsWalked ?? 0;
  const unopened = Math.max(0, known - walked);
  const gaps = coverage.gaps ?? [];

  /** @type {string[]} */
  const parts = [];
  if (unopened > 0) {
    parts.push(
      known === 1
        ? 'the only way into this product has never been walked through, so nothing here says anything about it'
        : `${unopened} of the ${known} ways into this product ${unopened === 1 ? 'has' : 'have'} never been walked through, so nothing here says anything about ${unopened === 1 ? 'it' : 'them'}`,
    );
  }
  // The doors gap is already counted above, in its own words. Counting it twice would
  // make the list look longer than it is, and a number a reader can catch out is a number
  // they stop believing. Several gaps can also share one sentence — the coverage count's
  // own caveats all do — and three identical lines read as three separate holes.
  const others = [...new Set(gaps.filter((g) => typeof g.doors !== 'number').map((g) => g.what))];
  if (others.length > 0) {
    // The example is the most concrete one there is. A caveat about how exact the count
    // is, chosen as the illustration, teaches a reader nothing about what was missed.
    const example = others.find((what) => !/less exact than it looks/i.test(what)) ?? others[0];
    parts.push(
      `${others.length} other ${others.length === 1 ? 'thing was' : 'things were'} not looked at (${plainly(example)}${others.length > 1 ? ', and more' : ''})`,
    );
  }

  if (parts.length === 0) {
    return `Everything this run knows how to walk was walked — ${coverage.paths} ${coverage.paths === 1 ? 'address' : 'addresses'} across ${coverage.journeys} ${coverage.journeys === 1 ? 'journey' : 'journeys'}. That is not every possible state of your product; nothing can enumerate that, and a clean result only covers what was walked.`;
  }
  return `NOT EVERYTHING WAS CHECKED: ${parts.join(', and ')}. A clean result only covers what was walked — the whole list is in coverage.gaps.`;
}

/**
 * Was there anything on the other side to compare against at all?
 *
 * The engine records one gap per journey it had no stored record for. When that count
 * reaches every journey that was walked, the run compared nothing whatever — and a run
 * that compared nothing produces zero differences, which is indistinguishable from a
 * product that did not change.
 *
 * The gaps are recognised by the words the engine writes into them. A test walks a real
 * project into exactly this state and requires the verdict not to read as a pass, so if
 * those words are ever reworded the guard fails loudly instead of quietly switching off.
 *
 * @param {Coverage|undefined} coverage
 * @returns {boolean}
 */
function comparedNothing(coverage) {
  const walked = coverage?.journeys ?? 0;
  if (walked === 0) return false;
  const nothingToCompare = (coverage?.gaps ?? []).filter((gap) =>
    /never been walked against|no stored record of the old build/i.test(`${gap.what} ${gap.why}`),
  ).length;
  return nothingToCompare >= walked;
}

/**
 * One gap's sentence, trimmed to something that fits inside another sentence.
 * @param {string} what
 * @returns {string}
 */
function plainly(what) {
  const one = String(what ?? '').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  return one.length > 120 ? `${one.slice(0, 117)}...` : one;
}

/**
 * A check that never happened, said in a shape every reader already understands.
 *
 * @param {CheckOptions} options
 * @param {unknown} e
 * @returns {CheckOutcome}
 */
function blocked(options, e) {
  const product = options.product ?? path.basename(path.resolve(options.cwd ?? options.root ?? process.cwd()));
  const empty = { id: '', product };
  return {
    runId: new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14),
    product,
    ok: false,
    blocked: true,
    mode: 'stored-record',
    modeWarning: 'Nothing was compared, so nothing here says anything about your product either way.',
    reference: empty,
    candidate: empty,
    findings: [],
    differencesReal: 0,
    differencesNoise: 0,
    newlyUnstable: [],
    coverage: { paths: 0, journeys: 0, byChannel: {}, gaps: [{ what: 'Everything.', why: messageOf(e) }] },
    // The hint is the half that tells a person what to DO about it, and dropping it
    // turns a helpful error into a dead end. Anything that blocks a run has to carry
    // both halves all the way out to whoever reads the summary.
    summary: `The check could not be run, so this is not a pass and not a failure. ${messageOf(e)}${
      e instanceof Error && /** @type {any} */ (e).hint ? ` ${/** @type {any} */ (e).hint}` : ''
    }`,
    durationMs: 0,
    startedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// prove
// ---------------------------------------------------------------------------

/**
 * Undo one change, walk the journey again, and see whether the difference goes away.
 *
 * This is the facade `src/v2/mcp/tools.js` asks for: it takes a finding id and a list of
 * files, both of which an agent already has, and does the loading `proveCause` cannot do
 * for itself.
 *
 * @param {CheckOptions & {finding?: string, revert?: string[]}} options
 * @returns {Promise<{gone: boolean, detail?: string, verdict?: string, escalates?: boolean}>}
 */
export async function prove(options = {}) {
  const root = projectRootFor(options);
  // The same record `check` writes and the MCP surface reads. One file, so a finding id an
  // agent was handed a moment ago still means the same finding here.
  const last = await readCheckRecord(openStore({ root }));
  const finding = last?.findings?.find((f) => f.id === options.finding);
  if (!finding) {
    return {
      gone: false,
      detail: `The last check has no finding called "${options.finding ?? ''}". Run a check first, then prove one of the ids it gives you.`,
    };
  }

  const project = await openProject(options);
  try {
    const changed = await whatChanged(project.root);
    const wanted = (options.revert ?? []).map((f) => f.replace(/^\.\//, ''));
    const narrowed = wanted.length
      ? { ...changed, hunks: changed.hunks.filter((h) => wanted.some((w) => h.file === w || h.file.startsWith(`${w}/`))) }
      : changed;

    const proof = await proveCause(finding, {
      cwd: project.root,
      walk: project.walk,
      journeys: project.journeys,
      candidate: project.candidate,
      changed: narrowed,
      normalise: project.normalise,
      signal: options.signal,
    });
    return {
      gone: proof.verdict === 'caused by that change',
      verdict: proof.verdict,
      escalates: proof.escalates,
      detail: proof.why ? `${proof.what} ${proof.why}` : proof.what,
    };
  } finally {
    await project.close();
  }
}

// ---------------------------------------------------------------------------
// explain
// ---------------------------------------------------------------------------

/**
 * One finding, with the detail a check reply deliberately left out.
 *
 * The check reply carries one sample value per finding, on purpose: five hundred differences
 * from one missing stylesheet must not cost an agent its whole context. This is where the
 * rest is kept, and it is only ever fetched, never pushed.
 *
 * @param {CheckOptions & {finding?: string, include?: string[]}} options
 * @returns {Promise<{text: string, pictures: string[]}>}
 */
export async function explain(options = {}) {
  const store = openStore({ root: projectRootFor(options) });
  const last = await readCheckRecord(store);
  const f = last?.findings?.find((x) => x.id === options.finding);
  if (!f) {
    return { text: `The last check has no finding called "${options.finding ?? ''}", so there is nothing to go deeper on.`, pictures: [] };
  }

  /** @type {string[]} */
  const out = [];
  const differences = f.differences ?? [];
  out.push(`${differences.length} ${differences.length === 1 ? 'address' : 'addresses'} in this finding, in full:`);
  for (const d of differences.slice(0, 40)) {
    if (d.kind === 'appeared') out.push(`  ${d.path} — was not there before, and now it is ${short(d.candidate)}`);
    else if (d.kind === 'vanished') out.push(`  ${d.path} — was ${short(d.reference)}, and now it is not there at all`);
    else out.push(`  ${d.path} — was ${short(d.reference)}, now ${short(d.candidate)}`);
  }
  if (differences.length > 40) out.push(`  and ${differences.length - 40} more.`);
  if (f.nearFiles?.length) out.push('', `Nearest code: ${f.nearFiles.slice(0, 6).join(', ')}.`);
  // No full stop of our own: the reason is already a whole sentence and adding one gave the
  // agent "...costs a real person real money.." on the reply it reads when it is trying to
  // understand something it is not allowed to waive.
  if (f.unwaivable === true) {
    const why = String(f.unwaivableWhy ?? 'a person has to look at it').trim();
    out.push('', `This cannot be recorded as intended by anyone: ${/[.!?]$/.test(why) ? why : `${why}.`}`);
  }
  if (f.waivedBecause) out.push('', `Already recorded as intended: ${f.waivedBecause}`);

  const pictures = differences.map((d) => d.evidence).filter((/** @type {string|undefined} */ e) => typeof e === 'string' && /\.png$/i.test(e));
  return { text: out.join('\n'), pictures: /** @type {string[]} */ (pictures) };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function short(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

// ---------------------------------------------------------------------------
// The screen, while a check is running
// ---------------------------------------------------------------------------

/**
 * The kinds of product that put something on somebody's screen.
 *
 * Everything else — a command, a library, an HTTP route, source read off disk — opens
 * nothing at all, and a run made only of those must not so much as ask macOS which
 * application is in front. Asking is not free: the first time anything on this machine
 * asks, the person gets a permission dialog, and getting one of those out of a check that
 * was never going to show them anything is its own small betrayal.
 *
 * Windows is deliberately NOT on this list even though it drives a real desktop. That probe
 * runs on another machine over SSH, so whatever it puts in front of anybody is in front of
 * somebody else's screen, and nothing here can reach it.
 *
 * @type {Set<string>}
 */
const PUTS_SOMETHING_ON_THE_SCREEN = new Set(['electron', 'ios', 'android']);

/**
 * How long to keep looking for the window of an app that has just been started.
 *
 * A desktop app takes a second or two to draw its first window, and on a cold machine it
 * takes longer. There is no event to wait for — the window belongs to the window server,
 * not to us — so this is looked for, slowly, and given up on without a word.
 */
const WAIT_FOR_A_WINDOW_MS = 20_000;

/** How often to look for it. Slow on purpose: nothing here is racing. */
const LOOK_FOR_A_WINDOW_MS = 400;

/**
 * Everything this run put on the screen, and the promise to give the screen back.
 *
 * Two steps rather than one, and the gap between them is the point: the screen is handed
 * back the moment the walking stops, and the window is left up long enough to be told the
 * settled answer.
 *
 * @typedef {object} ScreenMinder
 * @property {() => Promise<string|null>} handBack   Stop guarding, and hand back the one
 *   sentence worth saying — or null when there is nothing worth saying, which is the normal
 *   case and the whole rule: a person who was not interrupted is not told about the
 *   machinery that did not interrupt them.
 * @property {() => Promise<void>} finish   Put the window away. Safe at any point, safe
 *   twice, and safe without `handBack` ever having been called.
 */

/**
 * Look after the screen for the length of one check.
 *
 * Three jobs, and they are one job seen from three sides.
 *
 * THE GUARD. `watch/focus.js` watches who is in front and puts the person back the moment
 * something of ours pushes in front of them. It is the answer to the complaint that
 * started this: an app the tool opens may come up ONCE, because watching it work is most
 * of how you come to trust it, and after the person has chosen something else it never
 * comes forward again. Nothing else in this tool can do that job, because nothing else
 * knows which applications on this machine belong to the run.
 *
 * THE PANEL. `--watch` opens the live view beside the app, and the app is pinned to its
 * edge so the two of them read as one window.
 *
 * OUT OF SIGHT. With no panel, nobody asked to watch anything, so a desktop app this run
 * starts is moved off every screen once its window appears. It still runs, still answers
 * the debugging protocol and still photographs — the picture comes from the compositor,
 * which does not care where the window is — it simply never appears in front of anybody.
 *
 * Every part of this is best effort and every failure is swallowed. A machine with no
 * window server, no accessibility permission or no browser still runs the check; it just
 * does not get looked after, which is a disappointment and never a failed check.
 *
 * @param {Project} project
 * @param {CheckEvents} events
 * @returns {Promise<ScreenMinder|null>}
 */
async function mindTheScreen(project, events) {
  const watch = project.watch;
  const wantsPanel = watch.enabled === true;
  const couldShow = project.journeys.some((j) => PUTS_SOMETHING_ON_THE_SCREEN.has(String(j.surface)));
  // Nothing will appear and nobody asked for a window: there is no screen to look after.
  if (!wantsPanel && !couldShow) return null;

  const guard = guardTheScreen();
  // Said under --verbose rather than always, because a person who was not interrupted
  // should not be told about the machinery that did not interrupt them. It is here at all
  // so that "the guard is running" is something anybody can see rather than take on trust.
  detail(
    'The screen guard is watching. Anything this check opens may come to the front once; from the moment you pick something else, it stays behind you.',
  );

  const watcher = wantsPanel
    ? await attachWatcher(events, {
        product: project.product,
        project: project.root,
        journeys: project.journeys,
        watch,
        dir: project.store.dir,
        // The panel's own window is ours, so the guard has to know about it — with two
        // exceptions, and both of them are cases where pushing that window back would be
        // the tool overruling somebody.
        //
        // A BORROWED browser is the person's own. There was no Chrome for Testing here, so
        // the panel opened in the browser they actually use; claiming it would have the
        // guard shoving them out of their own tabs every time they clicked into them.
        //
        // AND --watch-front is somebody asking, in so many words, for this window in front.
        // Claiming it would have the guard undoing the flag a second after it was obeyed.
        onOpen: (browser) => {
          if (browser.borrowed || watch.foreground === true) return;
          guard.claim(browser.name);
        },
      })
    : null;

  /** @type {Promise<void>[]} */
  const placing = [];
  // Read by the wait below, so a check that ends while an app is still deciding whether
  // to draw a window does not sit there for another twenty seconds over the arrangement
  // of a window nobody is going to see.
  let stopped = false;
  const stopListening = onAppStarted((app) => {
    // Claimed the instant the process exists, before it has drawn anything. A moment
    // later and its first appearance is read as the person choosing it.
    guard.claim(app.name);
    events.emit({
      type: 'note',
      at: events.elapsed(),
      message: `${app.label} is open as "${app.name}". It is a scratch copy, on its own settings, and it is not your own install.`,
    });
    placing.push(place(app, watcher, events, () => stopped));
  });

  /** @type {Promise<string|null>|null} */
  let handingBack = null;
  /** @type {Promise<void>|null} */
  let finishing = null;

  const handBack = () => {
    handingBack ??= (async () => {
      stopped = true;
      stopListening();
      await guard.release();
      const line = describeGuard(guard.report());
      if (line) events.emit({ type: 'note', at: events.elapsed(), message: line });
      await Promise.allSettled(placing);
      return line;
    })();
    return handingBack;
  };

  return {
    handBack,
    finish: () => {
      finishing ??= (async () => {
        await handBack();
        if (watcher) {
          try {
            await watcher.stop();
          } catch {
            // A window that will not close is never a reason to change a verdict.
          }
          // The claim this whole arrangement makes — that the window never held the check
          // up — is worth a number rather than trust. Under --verbose, because a person who
          // is not asking how it went does not need to be told.
          const health = watcher.open() ? watcher.health() : null;
          // Silence here is the worst answer: somebody asked to watch this and got
          // nothing, with no idea whether the window failed or they typed it wrong. Every
          // way this can go actually WRONG says so in its own words as it happens, so the
          // only case left for this line is the one nothing else covers: a window called
          // off because it was going to be closed the moment it arrived.
          if (!health && watch.keepOpen === false) {
            warn(
              'You asked to watch this and no window came up. With --no-keep-open, a window still opening when the check finishes is ' +
                'called off, because it would only be closed again a second later. Leave --no-keep-open out and it waits, then comes up ' +
                'with the finished result on it.',
            );
          }
          if (health) {
            detail(
              `The watch window took ${health.delivered} of ${health.pushed} updates` +
                `${health.dropped > 0 ? `, folded ${health.dropped} away while it was catching up` : ''}` +
                `${health.stalls > 0 ? `, and gave up on ${health.stalls} that ran past their moment` : ''}` +
                '. The check waited on none of them.',
            );
          }
        }
      })();
      return finishing;
    },
  };
}

/**
 * Put one just-started desktop app where it belongs.
 *
 * With a panel: beside it, both windows pinned to one edge, one shape. Without: out of
 * sight, because nobody asked to watch anything.
 *
 * @param {OpenedApp} app
 * @param {import('./watch/index.js').Watcher|null} watcher
 * @param {CheckEvents} events
 * @param {() => boolean} stopped
 * @returns {Promise<void>}
 */
async function place(app, watcher, events, stopped) {
  if (watcher) {
    // The panel knows how to find the window itself, and it is the thing that has to be
    // moved either way, so the whole arrangement is done on that side.
    await watcher.snapTo({ pid: app.pid, hasWindow: true }).catch(() => {});
    return;
  }
  const where = await waitForItsWindow(app.pid, stopped);
  if (stopped()) return;
  if (!where) return;
  if (isOffScreen(where)) return;
  // Moving a window can pull the application it belongs to in front of everything else,
  // so whoever had the screen gets it straight back.
  const moved = await withoutTakingTheScreen(async () => moveWindowByPid(app.pid, where, offScreen(where)));
  if (moved) {
    events.emit({
      type: 'note',
      at: events.elapsed(),
      message: `Nobody asked to watch this run, so ${app.label} was moved off the screen. It is still running and still being read; it is just not in front of you. Run this with --watch to see it work.`,
    });
  } else {
    detail(`${app.label} could not be moved out of sight, so its window is on the screen. The screen guard will keep it from taking the foreground.`);
  }
}

/**
 * Wait for an app to draw its first window, and give up quietly.
 *
 * @param {number} pid
 * @param {() => boolean} stopped
 * @returns {Promise<import('../watch/place.js').Bounds|null>}
 */
async function waitForItsWindow(pid, stopped) {
  const deadline = Date.now() + WAIT_FOR_A_WINDOW_MS;
  for (;;) {
    if (stopped()) return null;
    const seen = await windowBoundsByPid(pid);
    if (seen) return seen;
    if (Date.now() > deadline || stopped()) return null;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, LOOK_FOR_A_WINDOW_MS);
      // Never the reason a finished program stays open.
      if (typeof timer.unref === 'function') timer.unref();
    });
  }
}

// ---------------------------------------------------------------------------
// Opening a project
// ---------------------------------------------------------------------------

/**
 * Everything the loop needs, gathered once.
 *
 * @typedef {object} Project
 * @property {string} root
 * @property {string} product
 * @property {import('./types.js').Store} store
 * @property {BuildFingerprint} candidate
 * @property {string} [against]   The reference build's own id, once a name has been resolved.
 * @property {Journey[]} journeys
 * @property {CoverageGap[]} gaps   Holes found while working out WHAT to walk, before a
 *   single journey ran. An adapter that fell over listing its journeys belongs here, and it
 *   has to reach the verdict: a channel that silently dropped out is the worst thing this
 *   tool can do.
 * @property {import('./run.js').Walker} walk
 * @property {(reference: BuildFingerprint, ctx: {events?: CheckEvents, signal?: AbortSignal}) => Promise<LiveBuild|null>} bootReference
 * @property {(capture: Capture) => Capture} normalise
 * @property {PanelOptions} watch   What the settings file and the command line, together,
 *   said about the live panel. Settled once here so the command line and the MCP server
 *   cannot disagree about what `--watch` meant.
 * @property {{surface: string, at: string|null}} [target]  Set only when the run was aimed
 *   at one kind of product AND something here can actually drive it.
 * @property {() => Promise<void>} close
 */

/**
 * @param {CheckOptions} options
 * @returns {string}
 */
function projectRootFor(options) {
  const from = path.resolve(options.cwd ?? options.root ?? process.cwd());
  const config = options.configFile ?? findConfigFile(from);
  return config ? rootForConfig(config) : from;
}

/**
 * @param {CheckOptions} options
 * @returns {Promise<Project>}
 */
async function openProject(options) {
  await loadAdapters();
  const root = projectRootFor(options);
  const configFile = options.configFile ?? findConfigFile(root) ?? null;
  const aim = aimOf(options);
  const config = aimAt(await readConfig(configFile), aim);
  const product = options.product ?? String(config.product ?? (await packageName(root)) ?? path.basename(root));

  const store = openStore({ root });
  await ensureStore(store);

  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-check-'));
  const evidenceDir = path.join(scratch, 'evidence');
  await fsp.mkdir(evidenceDir, { recursive: true });

  // Working out what there is to walk comes FIRST, before anything is asked of git. Somebody
  // standing in a folder they have not set up yet should be told to run `init`, not told
  // about a git requirement they have no reason to care about yet.
  const gathered = await gatherJourneys({ root, config, options });
  const journeys = narrowToTarget(gathered.journeys, aim);
  if (journeys.length === 0) {
    await fsp.rm(scratch, { recursive: true, force: true });
    // Two different situations wear the same symptom, and the difference is the
    // whole of what a person needs to hear. A project that has never been set up
    // should be told to set it up; one that IS set up and still has nothing to walk
    // has a settings file that says nothing, which is a different problem with a
    // different fix. Saying "nothing to walk" to the first is true and useless.
    if (!configFile) {
      throw new StaysFixedError('No Stays Fixed config found here, so there is nothing to check.', {
        hint: 'Run `staysfixed init` in your project to make one. It takes about thirty seconds.',
      });
    }
    throw new StaysFixedError('There is nothing to walk in this project, so a check would prove nothing.', {
      hint:
        'List the commands worth running under "process": {"commands": [{"name": "help", "run": "node bin/cli.js --help"}]} in your staysfixed config, ' +
        'or point the check at a journeys file with --journeys <file>.',
    });
  }

  const candidate = await fingerprintWorkingTree(root, product);
  await saveBuild(store, candidate);

  // A name like "HEAD", "v0.13.0" or a branch is what a person types; the store only knows
  // builds. Turning the name into a commit here, and putting that commit in the store, is
  // what lets a check be aimed at any point in history without every commit having been
  // walked before. Without it "HEAD" matches nothing and the check reports itself blocked.
  const reference = options.against ? await fingerprintCommit(root, product, options.against) : null;
  if (reference) await saveBuild(store, reference);

  const rules = mergeRules(DEFAULT_RULES, [
    ...machineRules({ root, home: os.homedir(), tmp: os.tmpdir() }),
    ...machineRules({ root: scratch }),
    ...(await loadRules(path.join(root, '.staysfixed', 'rules.json'))),
  ]);

  /** @type {(capture: Capture) => Capture} */
  const normalise = (capture) => normaliseCapture(capture, rules);

  /** @type {(() => Promise<void>)[]} */
  const cleanUps = [async () => fsp.rm(scratch, { recursive: true, force: true })];

  /** @type {import('./run.js').Walker} */
  const walk = async (req) => walkOne(req, { root, scratch, evidenceDir, config });

  /** @type {Project['bootReference']} */
  const bootReference = async (reference, ctx) => {
    const live = await exportBuild(root, reference, scratch);
    if (live) cleanUps.push(live.release);
    if (live) ctx.events?.emit({ type: 'note', at: ctx.events.elapsed(), message: live.why ?? 'The old build is on this machine.' });
    return live;
  };

  /** @type {Project} */
  const project = {
    root,
    product,
    store,
    candidate,
    against: reference ? reference.id : options.against,
    journeys,
    gaps: gathered.gaps,
    walk,
    bootReference,
    normalise,
    // The settings file first, then whatever was typed. `--watch` can only ever turn the
    // panel ON: somebody who did not type it has not said no to it, they have said nothing.
    watch: watchOptionsFrom(/** @type {{watch?: import('../types.js').WatchOptions|boolean}} */ (config), options.watch ?? null),
    close: async () => {
      for (const done of cleanUps.reverse()) {
        try {
          await done();
        } catch {
          // Cleaning up is best effort. A scratch folder left behind is untidy; failing a
          // finished check because of one is worse.
        }
      }
      for (const adapter of ADAPTERS) {
        try {
          await adapter.teardown();
        } catch {
          // Same again: an adapter that will not tidy up cannot be allowed to lose the answer.
        }
      }
    },
  };
  if (aim.surface) project.target = { surface: aim.surface, at: aim.at };
  return project;
}

// ---------------------------------------------------------------------------
// Aiming a run at one kind of product
// ---------------------------------------------------------------------------

/**
 * What the caller aimed this run at, if anything.
 *
 * @param {CheckOptions} options
 * @returns {{surface: Surface|null, at: string|null}}
 */
function aimOf(options) {
  const asked = options.surface && options.surface !== 'auto' ? String(options.surface) : null;
  const at = typeof options.at === 'string' && options.at.trim() !== '' ? options.at.trim() : null;
  if (asked !== null && !(asked in ADAPTER_FOR_SURFACE)) {
    throw new StaysFixedError(`There is no kind of product called "${asked}".`, {
      hint: `The kinds are: ${Object.keys(ADAPTER_FOR_SURFACE).join(', ')}.`,
    });
  }
  return { surface: /** @type {Surface|null} */ (asked), at };
}

/**
 * Which settings key each adapter reads for "where the product is".
 *
 * An `at` that reached no adapter would be quietly ignored, and the run would come back
 * clean about somewhere else entirely — the most dangerous shape a reply can have. So an
 * `at` with nowhere to put it is refused rather than dropped.
 *
 * @type {Record<string, string[]>}
 */
const WHERE_KEY = {
  web: ['url', 'baseUrl'],
  server: ['baseUrl', 'url'],
  electron: ['binary'],
  android: ['apk'],
  ios: ['app'],
};

/**
 * Put "where the product is" into the settings the aimed adapter will read.
 *
 * @param {Record<string, any>} config
 * @param {{surface: Surface|null, at: string|null}} aim
 * @returns {Record<string, any>}
 */
function aimAt(config, aim) {
  if (aim.at === null) return config;
  if (aim.surface === null) {
    throw new StaysFixedError(`You said where to look ("${aim.at}") without saying what kind of product is there.`, {
      hint: 'Name the surface too, e.g. surface: "web" with a URL, or surface: "electron" with the path to the built app.',
    });
  }
  const keys = WHERE_KEY[ADAPTER_FOR_SURFACE[aim.surface]] ?? WHERE_KEY[aim.surface];
  if (!keys) {
    throw new StaysFixedError(`A ${aim.surface} check has nowhere to put "${aim.at}", so it would have been ignored.`, {
      hint: 'Leave "at" out for this kind of product, and let the settings say what to run.',
    });
  }
  const name = ADAPTER_FOR_SURFACE[aim.surface];
  /** @type {Record<string, any>} */
  const slice = { ...(config[name] ?? {}) };
  for (const key of keys) slice[key] = aim.at;
  return { ...config, [name]: slice };
}

/**
 * Keep only the journeys that walk the surface this run was aimed at.
 *
 * Refusing loudly is the whole point. A run aimed at a phone app in a project with no
 * phone journeys, and no adapter that could drive one, must not come back green about the
 * command-line tool that happened to be sitting next to it.
 *
 * @param {Journey[]} journeys
 * @param {{surface: Surface|null, at: string|null}} aim
 * @returns {Journey[]}
 */
function narrowToTarget(journeys, aim) {
  if (aim.surface === null) return journeys;
  const wanted = ADAPTER_FOR_SURFACE[aim.surface];
  const driver = ADAPTERS.find((a) => a.name === wanted);
  if (!driver) {
    throw new StaysFixedError(
      `This run was aimed at ${aim.surface}, and nothing in this copy can drive ${aim.surface}. ${NO_ADAPTER_FOR.get(aim.surface) ?? ''}`.trim(),
      { hint: 'Run `staysfixed doctor` to see what this copy and this machine can drive, and what would unlock the rest.' },
    );
  }
  const kept = journeys.filter((j) => j.surface === aim.surface);
  if (kept.length === 0) {
    throw new StaysFixedError(`This run was aimed at ${aim.surface}, and this project has no ${aim.surface} journey to walk.`, {
      hint:
        `Nothing was checked rather than something else being checked and reported as though it were the ${aim.surface} one. ` +
        `Add ${/^[aeiou]/i.test(wanted) ? 'an' : 'a'} "${wanted}" section to your Stays Fixed settings naming where the product is, or leave the surface out to check everything this project does have.`,
    });
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Walking one journey
// ---------------------------------------------------------------------------

/**
 * Walk one journey once, and turn what the adapter saw into a capture.
 *
 * Every walk gets its OWN scratch copy of the build. That is more copying than an adapter
 * would do left to itself, and it is not negotiable: run one journey twice into the same
 * folder and the second run starts with the first run's files already written, so a file
 * the product creates every time looks like a file it created once. That reads as wobble,
 * and wobble is subtracted — which would switch off the whole "a file is no longer written"
 * class of finding without a word of warning.
 *
 * @param {WalkRequest} req
 * @param {{root: string, scratch: string, evidenceDir: string, config: Record<string, any>}} where
 * @returns {Promise<Capture>}
 */
async function walkOne(req, where) {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const adapter = adapterFor(req.journey);
  // A reference walk comes with the folder the old build was exported into. A candidate
  // walk reads the working tree.
  const from = req.dir ?? where.root;

  /** @type {Observation[]} */
  let observations = [];
  /** @type {import('./types.js').CoverageGap[]} */
  const gaps = [];

  if (!adapter) {
    gaps.push({
      what: `The journey "${req.journey.describe || req.journey.name}" was not walked, so nothing at all is known about it.`,
      // Naming the missing adapter matters more than it looks. "Nothing knows how to
      // drive this" is a shrug; "there is no Android adapter in this copy" is something
      // an agent can act on, and it is the difference between a hole somebody closes and
      // a hole somebody skims past.
      why: NO_ADAPTER_FOR.get(req.journey.surface) ?? `Nothing in this copy drives a ${req.journey.surface} journey.`,
      unlockedBy: `Install a copy of Stays Fixed that has the ${req.journey.surface} adapter in it, or write this journey against something that is here: a command, a module import, an HTTP route, a web page, or a desktop app.`,
      surface: req.journey.surface,
    });
  } else {
    const runId = `${req.build.id}-${req.run}-${req.journey.name}`;
    const ctx = {
      signal: req.signal,
      scratchDir: path.join(where.scratch, safeSegment(runId)),
      evidenceDir: where.evidenceDir,
      seed: 20260829,
      clock: '2026-08-29T09:00:00.000Z',
      config: where.config[adapter.name] ?? {},
      /** @param {string} message */
      log: (message) => req.events?.emit({ type: 'note', at: req.events.elapsed(), message }),
    };
    await fsp.mkdir(ctx.scratchDir, { recursive: true });

    /** @type {import('./adapters/contract.js').PreparedBuild|null} */
    let prepared = null;
    try {
      prepared = await adapter.prepare(
        {
          id: runId,
          label: req.which === 'reference' ? 'the build you were happy with' : 'the build you have',
          role: req.which,
          root: from,
          gitSha: req.build.gitSha ?? null,
        },
        ctx,
      );
      observations = await adapter.run(req.journey, prepared, ctx);
    } catch (e) {
      // A journey that fell over is a hole in the coverage, never a silent pass and never
      // the end of the run — the other journeys' work is worth keeping.
      gaps.push({
        what: `The journey "${req.journey.describe || req.journey.name}" stopped partway.`,
        why: messageOf(e),
        unlockedBy: 'Run that one journey on its own to see what it does.',
        surface: req.journey.surface,
      });
    } finally {
      if (prepared) {
        try {
          await prepared.dispose();
        } catch {
          // Best effort, as above.
        }
      }
      await fsp.rm(ctx.scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** @type {Partial<Record<Channel, number>>} */
  const byChannel = {};
  for (const o of observations) byChannel[o.channel] = (byChannel[o.channel] ?? 0) + 1;

  /** @type {Coverage} */
  const coverage = {
    paths: observations.length,
    journeys: 1,
    byChannel,
    gaps,
  };
  const doors = observations.filter((o) => o.channel === 'contract').length;
  if (doors > 0) {
    coverage.doorsKnown = doors;
    // Nothing walked through them: the contract channel reads doors out of the source, and
    // knowing a door exists is not the same as having opened it. Saying so is the coverage
    // ledger doing its job.
    coverage.doorsWalked = 0;
  }

  return {
    id: newCaptureId(req.run),
    journey: req.journey.name,
    source: req.journey.source,
    build: req.build,
    run: req.run,
    startedAt,
    durationMs: Date.now() - started,
    observations: sortObservations(observations),
    coverage,
    complete: true,
  };
}

/**
 * @param {Journey} journey
 * @returns {Adapter|null}
 */
function adapterFor(journey) {
  const step = /** @type {{act?: string}} */ (journey.steps?.[0] ?? {});
  if (step.act === 'read') return sourceAdapter;
  const wanted = /** @type {Record<string, string>} */ (ADAPTER_FOR_SURFACE)[journey.surface];
  return ADAPTERS.find((a) => a.name === wanted) ?? null;
}

// ---------------------------------------------------------------------------
// Where the steps come from
// ---------------------------------------------------------------------------

/**
 * Journeys, in the order the design ranks them: read out of the code first, because it is
 * free and exact, then whatever the project's own config or a journeys file names.
 *
 * The contract journey is always added. It costs one read of the source, it runs no code at
 * all, and it is the only channel that sees a door nobody has ever walked through.
 *
 * @param {{root: string, config: Record<string, any>, options: CheckOptions}} a
 * @returns {Promise<{journeys: Journey[], gaps: CoverageGap[]}>}
 */
async function gatherJourneys({ root, config, options }) {
  /** @type {Journey[]} */
  const journeys = [];
  /** @type {CoverageGap[]} */
  const gaps = [];

  const named = options.journeys && options.journeys !== 'code' && options.journeys !== 'config' ? options.journeys : null;
  if (named) journeys.push(...(await readJourneyFile(path.resolve(root, named))));

  for (const adapter of ADAPTERS) {
    if (adapter === sourceAdapter && named && options.journeys !== 'code') {
      // A journeys file names exactly what to walk. The contract read is still added,
      // because it cannot break anything and it sees what no journey does.
    }
    /** @type {import('./adapters/contract.js').AdapterProject} */
    const project = { root, config: config[adapter.name] ?? {} };
    let detection;
    try {
      detection = await adapter.detect(project);
    } catch (e) {
      // BOTH of these used to be swallowed without a word, and that is the same shape of
      // failure as the source reader skipping a 3.5MB bundle: a whole channel drops out of
      // the run, nothing is walked, and the verdict says "nothing that worked has changed".
      // An adapter that FALLS OVER is a hole. An adapter that says "this is not my kind of
      // project" is not, which is why only the throw is recorded here.
      gaps.push({
        what: `Nothing was checked through the "${adapter.name}" adapter, because it could not even work out whether it applies to this project.`,
        why: messageOf(e),
        unlockedBy: `Run \`staysfixed doctor\` to see what the ${adapter.name} adapter needs here. Until then, anything only it can see is not being watched.`,
      });
      continue;
    }
    if (!detection.applies) continue;
    if (adapter !== sourceAdapter && named) continue;
    try {
      journeys.push(...(await adapter.journeys(project)));
    } catch (e) {
      gaps.push({
        what: `The "${adapter.name}" adapter applies to this project and could not say what it would walk, so it walked nothing.`,
        why: messageOf(e),
        unlockedBy: `Fix what it is complaining about, or name the steps yourself in a journeys file. This is a hole, not a pass.`,
      });
    }
  }

  const only = options.only ?? [];
  const chosen = only.length > 0 ? journeys.filter((j) => only.some((n) => j.name === n || j.name.includes(n))) : journeys;
  if (only.length > 0) {
    for (const wanted of only) {
      if (chosen.some((j) => j.name === wanted || j.name.includes(wanted))) continue;
      gaps.push({
        what: `You asked for the journey "${wanted}" and there is no journey by that name, so it was not walked.`,
        why: 'A name that matches nothing narrows the run to nothing rather than to what you meant.',
        unlockedBy: `The journeys this project has are: ${journeys.map((j) => j.name).slice(0, 12).join(', ') || 'none'}.`,
      });
    }
  }

  // Two journeys with one name would write into one another's records.
  /** @type {Journey[]} */
  const out = [];
  const seen = new Set();
  for (const j of chosen) {
    if (seen.has(j.name)) continue;
    seen.add(j.name);
    out.push(j);
  }
  return { journeys: out, gaps };
}

/**
 * @param {string} file
 * @returns {Promise<Journey[]>}
 */
async function readJourneyFile(file) {
  /** @type {string} */
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    throw new StaysFixedError(`There is no journeys file at ${file}.`, {
      hint: 'A journeys file is a JSON list, each entry with a name, a describe, a surface and its steps.',
    });
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new StaysFixedError(`The journeys file at ${file} is not readable JSON: ${messageOf(e)}`);
  }
  const list = Array.isArray(parsed) ? parsed : /** @type {{journeys?: unknown}} */ (parsed)?.journeys;
  if (!Array.isArray(list)) {
    throw new StaysFixedError(`The journeys file at ${file} has to be a list of journeys, or an object with a "journeys" list in it.`);
  }
  return list.map((entry, i) => {
    const j = /** @type {Record<string, any>} */ (entry);
    if (typeof j?.name !== 'string' || j.name === '') {
      throw new StaysFixedError(`The journey at position ${i + 1} in ${file} has no name, and a name is what its addresses are built from.`);
    }
    return /** @type {Journey} */ ({
      name: j.name,
      describe: String(j.describe ?? j.name),
      source: j.source ?? 'code',
      surface: j.surface ?? 'cli',
      from: j.from ?? file,
      steps: Array.isArray(j.steps) ? j.steps : [],
      channels: j.channels,
      irreversible: j.irreversible === true,
      skip: j.skip,
      timeoutMs: j.timeoutMs,
    });
  });
}

/**
 * @param {string|null} configFile
 * @returns {Promise<Record<string, any>>}
 */
async function readConfig(configFile) {
  if (!configFile) return {};
  try {
    if (configFile.endsWith('.json')) return JSON.parse(await fsp.readFile(configFile, 'utf8'));
    const module = await import(`file://${configFile}`);
    const raw = module.default ?? module.config ?? module;
    return /** @type {Record<string, any>} */ (raw);
  } catch (e) {
    throw new StaysFixedError(`The settings in ${configFile} could not be read: ${messageOf(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Which build is which
// ---------------------------------------------------------------------------

/**
 * Everything this tool writes about your project, kept out of what your project IS.
 *
 * This one line is load-bearing and it was missing, and the bug it caused reached all the
 * way to the front door. A build is told from another build by what git says is in the
 * working tree — the diff, plus the list of files git does not know about. Stays Fixed's own
 * folder is a file git does not know about, and it gains files every single time the tool
 * runs. So the untracked list changed on every run, the digest changed with it, and every
 * run of an UNCHANGED project produced a brand new build id.
 *
 * The consequences were all silent. Two runs on identical source were two different builds,
 * so the second could never find the first one's record. A clean checkout was never clean, so
 * it never got its commit's id, so `--against HEAD` matched nothing and the stored-record
 * comparison — the fast path the whole design rests on — could not work at all. Measured on
 * a scratch product: five runs, one unchanged source file, five different build ids and five
 * runs reporting NOTHING WAS ACTUALLY COMPARED.
 *
 * Excluded rather than gitignored, and that difference matters: gitignoring it would fix the
 * fingerprint and would also throw away the observation files the design says to keep
 * forever. What a project's own tooling wrote about a project is never part of the project.
 */
const NOT_THE_TOOLS_OWN_FOLDER = ':(exclude).staysfixed';

/**
 * The build you have, named by what is actually in it.
 *
 * A dirty working tree gets an id that includes a digest of the diff, so editing a file
 * makes a new build rather than adding observations to the record of the last one. That is
 * what "content-addressed against the build artifact" means when the artifact is source.
 *
 * @param {string} root
 * @param {string} product
 * @returns {Promise<BuildFingerprint>}
 */
async function fingerprintWorkingTree(root, product) {
  const sha = await git(root, ['rev-parse', 'HEAD']);
  if (!sha) {
    // REFUSING IS THE ONLY HONEST ANSWER HERE, and the alternative is the worst bug this
    // tool could have. Without git there is nothing to tell one build from another, so every
    // run would be fingerprinted identically, the build you just changed would carry the same
    // id as the build you were happy with, and comparing a build against itself produces zero
    // differences — a permanent, confident, completely false all-clear.
    throw new StaysFixedError(
      'This folder is not a git repository with a commit in it, and Stays Fixed tells one build from another by what git says is in it.',
      {
        hint:
          'Run it inside your project (or `git init && git commit` first). Without git every run would look like the same build, ' +
          'and a check that compares a build against itself always comes back clean — which would be a lie, so it is refused instead.',
      },
    );
  }
  // Streamed into a hash rather than read into a string. `git diff` used to go through a
  // buffer with a 32MB ceiling, and a diff over the ceiling made the git call FAIL — which
  // was caught, treated as an empty diff, and the working tree was then declared clean. A
  // big uncommitted change therefore got the id of the commit it sat on top of; if that
  // commit was the reference, the check compared the build against itself and reported that
  // nothing had changed. Nothing about a diff's size may ever decide whether a change exists.
  const diff = await gitDigest(root, ['diff', 'HEAD', '--', NOT_THE_TOOLS_OWN_FOLDER]);
  const untracked = await gitDigest(root, ['ls-files', '--others', '--exclude-standard', '--', NOT_THE_TOOLS_OWN_FOLDER]);
  if (!diff.ok || !untracked.ok) {
    throw new StaysFixedError(
      `Git could not say what has changed in this working tree, so there is no way to tell this build apart from the last one. ${diff.why ?? untracked.why ?? ''}`.trim(),
      { hint: 'Fix that and run again. Guessing "nothing has changed" here would make every later answer worthless.' },
    );
  }
  const dirty = !diff.empty || !untracked.empty;
  const version = await packageVersion(root);

  /** @type {BuildFingerprint} */
  const build = {
    id: dirty ? `work-${sha256(`${sha}\n${diff.digest}\n${untracked.digest}`).slice(0, 12)}` : `git-${sha.slice(0, 12)}`,
    product,
    platform: `${process.platform}-${process.arch}`,
    builtAt: new Date().toISOString(),
  };
  build.gitSha = sha;
  if (version) build.version = dirty ? `${version} with uncommitted changes` : version;
  if (dirty) build.dirty = true;
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch && branch !== 'HEAD') build.branch = branch;
  return build;
}

/**
 * The build you were happy with, found by whatever a person calls it.
 *
 * @param {string} root
 * @param {string} product
 * @param {string} name    A commit, a tag, a branch, or a build id already in the store.
 * @returns {Promise<BuildFingerprint|null>}
 */
async function fingerprintCommit(root, product, name) {
  const sha = await git(root, ['rev-parse', '--verify', `${name}^{commit}`]);
  if (!sha) return null;
  /** @type {BuildFingerprint} */
  const build = {
    id: `git-${sha.slice(0, 12)}`,
    product,
    gitSha: sha,
    platform: `${process.platform}-${process.arch}`,
  };
  const described = await git(root, ['describe', '--tags', '--exact-match', sha]);
  if (described) build.version = described;
  return build;
}

/**
 * Put the old build back on this machine so it can be walked live.
 *
 * `git archive` is used rather than a checkout or a worktree for one reason: it reads
 * history and writes nothing at all into the repository it reads from. A worktree adds
 * bookkeeping inside somebody's `.git`, and this tool has no business leaving anything
 * behind in the project it is checking.
 *
 * @param {string} root
 * @param {BuildFingerprint} reference
 * @param {string} scratch
 * @returns {Promise<LiveBuild|null>}
 */
async function exportBuild(root, reference, scratch) {
  const sha = reference.gitSha;
  if (!sha) return null;
  const dir = path.join(scratch, `reference-${sha.slice(0, 12)}`);
  await fsp.mkdir(dir, { recursive: true });
  try {
    // Straight through a pipe: the archive is never written to disk, so a big repository
    // does not cost twice the space to look at.
    await exec('/bin/sh', ['-c', `git -C ${quote(root)} archive --format=tar ${quote(sha)} | tar -x -C ${quote(dir)}`], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw new StaysFixedError(`${sha.slice(0, 7)} could not be put back on this machine, so it cannot be walked live. ${messageOf(e)}`, {
      hint: 'Check the commit is still in this repository. Without it the check falls back to the stored record, which is weaker.',
    });
  }
  return {
    build: reference,
    dir,
    why: `The old build was exported out of git into a scratch folder. Your working tree was not touched, and nothing was written into .git.`,
    release: async () => {
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Small things
// ---------------------------------------------------------------------------

/**
 * Run a git command and hash its output as it arrives, without ever holding it in memory.
 *
 * This exists because of a specific failure: reading `git diff` into a string through a
 * buffer with a ceiling turns "your change is enormous" into "the command failed", and the
 * caller then has to guess. A hash costs nothing, has no ceiling, and answers the only two
 * questions the fingerprint asks — was there anything, and was it the same thing as last time.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ok: boolean, empty: boolean, digest: string, why?: string}>}
 */
function gitDigest(cwd, args) {
  return new Promise((resolve) => {
    const hash = createHash('sha256');
    let bytes = 0;
    /** @type {string[]} */
    const complaints = [];
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    child.stderr.on('data', (chunk) => complaints.push(String(chunk)));
    child.on('error', (e) => resolve({ ok: false, empty: true, digest: '', why: messageOf(e) }));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, empty: true, digest: '', why: complaints.join(' ').trim() || `git exited with ${code}` });
        return;
      }
      resolve({ ok: true, empty: bytes === 0, digest: hash.digest('hex') });
    });
  });
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string|null>}
 */
async function git(cwd, args) {
  try {
    const { stdout } = await exec('git', args, { cwd, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * @param {string} root
 * @returns {Promise<Record<string, any>|null>}
 */
async function packageJson(root) {
  try {
    return JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} root
 * @returns {Promise<string|null>}
 */
async function packageName(root) {
  const pkg = await packageJson(root);
  return typeof pkg?.name === 'string' ? pkg.name : null;
}

/**
 * @param {string} root
 * @returns {Promise<string|null>}
 */
async function packageVersion(root) {
  const pkg = await packageJson(root);
  return typeof pkg?.version === 'string' ? pkg.version : null;
}

/** @param {string} text */
function quote(text) {
  return `'${text.split("'").join(`'\\''`)}'`;
}

/** @param {string} name */
function safeSegment(name) {
  return name.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'run';
}
