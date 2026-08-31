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
import { warn, detail, shortPath } from '../core/log.js';
import { findConfigFile, rootForConfig } from '../core/paths.js';
import { sha256 } from '../core/hash.js';

import { openStore, ensureStore, saveBuild, newCaptureId, storeExists, referenceFor, listBuilds, pruneBuild, removeBuild, sweepIncomplete } from './store.js';
import { decide, noDecisions, readDecisions, rememberCheck, readCheckRecord } from './escalate.js';
import { sortObservations } from './observation.js';
import { DEFAULT_RULES, machineRules, mergeRules, normaliseCapture, loadRules } from './normalise.js';
import { runCheck, makeCheckEvents } from './run.js';
import { proveCause } from './cause.js';
import { whatChanged, NOT_THE_TOOLS_OWN_FOLDER } from './rank.js';

import { attachWatcher, watchOptionsFrom } from './watch/index.js';
import { guardTheScreen, describeGuard } from './watch/focus.js';
import {
  isOffScreen, moveWindowByPid, offScreen, windowBoundsByPid, withoutTakingTheScreen,
} from './watch/window.js';
import { onAppStarted, stillOpen } from './adapters/isolate.js';

import { isAnAnswerJourney, journeysFromExports, splitAnswerSheet } from './journeys/from-exports.js';
import { processAdapter } from './adapters/process.js';
import { sourceAdapter } from './adapters/source.js';
import { httpAdapter } from './adapters/http.js';
import { webAdapter } from './adapters/web.js';
import { electronAdapter } from './adapters/electron.js';
import { extensionAdapter } from './adapters/extension.js';

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
 * @typedef {Verdict & {blocked?: boolean, comparedNothing?: 'no reference'|'no stored record'|null, accounted?: import('./escalate.js').Accounting, target?: {surface: string, at: string|null}}} CheckOutcome
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
 * @property {string} [journeys]    A path to a journeys file, or 'code' / 'config' / 'suite'.
 *                                  'suite' RUNS the project's own tests — see gatherJourneys.
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
const BUILT_IN = [sourceAdapter, processAdapter, httpAdapter, webAdapter, electronAdapter, extensionAdapter];

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
  {
    surface: 'macos',
    file: './adapters/macos.js',
    exports: ['macosAdapter', 'adapter', 'default'],
    missing:
      'This copy has no native-Mac adapter in it, so nothing here can open a Swift or Objective-C app and read what is on its screen. That is usually fine: a Mac product built with Electron is driven over its own debugging port by the Electron adapter and needs nothing else.',
  },
  {
    surface: 'linux',
    file: './adapters/linux.js',
    exports: ['linuxAdapter', 'adapter', 'default'],
    missing:
      'This copy has no native-Linux adapter in it. That is usually fine: a Linux product built with Electron is driven over its own debugging port by the Electron adapter and needs nothing else.',
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
  extension: 'extension',
  android: 'android',
  ios: 'ios',
  windows: 'windows',
  linux: 'linux',
  macos: 'macos',
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

    // THE GUARDS. `settle` takes the names so that a difference touching a bug somebody
    // already had once is sealed and no agent may wave it through — and both call sites used
    // to hand it nothing, so that class was empty on every run this tool has ever done. The
    // one seal that exists because a person was burned before could never fire.
    //
    // Running them is version 1's job and needs its browser driver, which this path does not
    // have. That is a real hole and it is now SAID rather than left silent: measured on
    // 2026-08-30, a check on a project with a guard sitting in `.staysfixed/guards` printed
    // the word "guard" exactly zero times. A tool built to catch silent breakage must not do
    // nothing silently.
    const named = await guardNames(project.root);
    if (named.length > 0) {
      const walked = await walkTheGuards(project.root, options);
      if (walked.ran) {
        // A guard that failed is a bug somebody already had, coming back. It is sealed by
        // name — one of the five classes no agent may wave through, whatever the reason.
        for (const bad of walked.failed) {
          verdict.findings = [
            ...(verdict.findings ?? []),
            /** @type {any} */ ({
              id: `guard-${sha256(bad.name).slice(0, 6)}`,
              title: `A bug that was already fixed is back: ${bad.name}`,
              why: bad.message ?? 'The guard written for it does not hold any more.',
              class: 'named guard',
              guard: bad.name,
              differences: [],
              rank: 0,
              count: 1,
            }),
          ];
        }
        verdict.summary = `${walked.said} ${verdict.summary}`;
        if (walked.failed.length > 0) verdict.ok = false;
      } else if (verdict.coverage) {
        verdict.coverage.gaps = [
          ...(verdict.coverage.gaps ?? []),
          {
            what: `${named.length} guard${named.length === 1 ? '' : 's'} written against bugs that already happened once`,
            why: `They are sealed by name, so nothing touching one can be waved through quietly — but they were not RUN on this check: ${walked.why}`,
            unlockedBy: 'Give the settings an address to open — `url` beside `start` in the `web` block, or `electron.binary` — and every check walks them from then on.',
          },
        ];
      }
    }

    /** @type {CheckOutcome} */
    const outcome = await settle(verdict, project.store, project.product, named);
    // FIRST, before anything the run found. Which product was walked is the frame every
    // other sentence here has to be read inside, and a person who was told it at the end
    // has already read the clean result as being about the folder they are standing in.
    if (project.elsewhere !== '') outcome.summary = `${project.elsewhere} ${outcome.summary}`;
    // Only a run that really did reach the surface it was aimed at may say so. The
    // confirmation is what lets a caller tell "it went there and found nothing" from
    // "it checked something else and found nothing", and those are not the same answer.
    if (project.target) outcome.target = project.target;

    // The live window was told the engine's verdict the moment the loop finished — before
    // the gates were applied to it, before the waived findings were taken out, and before
    // the coverage sentence went on the end. Left there, a window would show a greener,
    // shorter answer than the terminal beside it, and the two would disagree about the same
    // run. So it is told again, with the settled one, and only then put away.
    // Housekeeping, after the answer is settled and never before it. It can only ever remove
    // recordings of builds nothing is comparing against, and if it says anything at all it
    // says it on the same summary as everything else.
    const tidied = await tidyTheStore(project, outcome);
    if (tidied) outcome.summary = `${outcome.summary} ${tidied}`;

    events.emit({ type: 'check:done', at: events.elapsed(), message: outcome.summary, verdict: outcome });
    if (screen) {
      await screen.finish();
      screen = null;
    }
    return outcome;
  } catch (e) {
    // A store that would not take this run's records is very often the whole reason the
    // run then failed — a reference named by a commit cannot be resolved if nothing could
    // register it — and without this the person is handed a bare permission error from a
    // folder they have never heard of, with nothing joining the two facts up.
    const outcome = blocked(options, e, project?.storeTrouble);
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
  /** @type {string} */
  let bookkeepingTrouble = '';
  try {
    decisions = await readDecisions(store, product);
  } catch (e) {
    // Unreadable bookkeeping means nothing is accounted for, which reports MORE than it
    // should rather than less. That is the only safe direction for this to fail in — and it
    // is still a fact the reader needs. Without it the accounting says nothing was waived,
    // which reads as "there were no waivers" rather than "nobody could read them", and an
    // agent looking at a wall of findings it waived last week has no idea why they are back.
    decisions = noDecisions(product);
    bookkeepingTrouble = `The record of what was already accounted for could not be read (${messageOf(e)}), so nothing was treated as accounted for. Anything you waived before is in this list again.`;
  }

  const decided = decide(verdict.findings ?? [], decisions, { guards: guards ?? [] });
  verdict.findings = decided.reported;
  verdict.accounted = decided.accounting;
  if (verdict.blocked !== true) {
    // `verdict.ok !== false` first, and it is the whole point of the line. Accounting may
    // take a pass AWAY — a finding nobody waived, an address that stopped being
    // predictable — and it may never hand one back. This assigned instead of narrowing, so
    // every not-a-pass the engine had already decided was thrown away here: a run where the
    // product never answered, and a run drowning in wobble, both came back through this line
    // as `ok: true`. Found by the refusal lane on 2026-08-31, and it had been quietly
    // discarding the wobble verdict before that.
    verdict.ok = verdict.ok !== false && decided.reported.length === 0 && (verdict.newlyUnstable ?? []).length === 0;
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
    const nothing = comparedNothing(verdict);
    // Carried as a FIELD, not only folded into a sentence. Every other surface has to be
    // able to ask this question without reading English: the MCP server rendered its own
    // headline from the difference count alone, never looked at `ok`, and answered a
    // machine "NOTHING UNACCOUNTED FOR. Everything that worked before still works" with
    // `ok: true` and `isError: false` on a project that had nothing on record at all —
    // while the terminal, on the same run, correctly said it was no answer. The agent is
    // the reader that matters most here, and it was the one being told the untrue thing.
    verdict.comparedNothing = nothing;
    if (nothing) {
      verdict.ok = false;
      verdict.summary =
        nothing === 'no reference'
          ? `NOTHING WAS ACTUALLY COMPARED. There is no build of this product on record as working, so this run had nothing whatever to hold today's behaviour against. This is not a pass and not a failure — it is no answer. ${verdict.summary}`
          : `NOTHING WAS ACTUALLY COMPARED. Every journey was walked on the build you have, and not one of them had anything on record from the build you were happy with, so there was nothing to hold them against. This is not a pass and not a failure — it is no answer. ${verdict.summary}`;
    }

    // THE CAUSE FIRST, when the cause is that the product never answered.
    //
    // A server that will not start produces a difference at every address it used to answer
    // at — the content type gone, the body gone, "answered at all" arriving. Measured
    // 2026-08-31 on a product whose start command throws: twelve findings, not one of them
    // saying the server had not started, and a person reads "12 things behave differently"
    // and goes looking for a regression in code that is fine. The symptoms are real and they
    // belong in the list; they are just not the news.
    const silent = didNotAnswer(verdict);
    if (silent.length > 0) {
      verdict.summary =
        `THE PRODUCT DID NOT ANSWER. ${silent.length} ${silent.length === 1 ? 'way in was' : 'ways in were'} not tried at all — ${silent.slice(0, 3).join('; ')}${silent.length > 3 ? '; and more' : ''}. Most of what follows is that one fact wearing different clothes, not ${silent.length === 1 ? 'a separate change' : 'separate changes'}: fix the start and check again before reading any of it as a regression. ` +
        verdict.summary;
    }

    // And what was NOT looked at, in the same breath as the good news, on every run
    // including the clean ones. A green verdict on a product with three hundred doors
    // nobody has ever opened is true and it is not what it looks like, and the only place
    // that difference can be made impossible to miss is inside the sentence everybody
    // already reads. It goes last so it is the thing left in the reader's head.
    verdict.summary = `${verdict.summary} ${whatWasNotChecked(verdict.coverage)}`;
  }
  if (bookkeepingTrouble) verdict.summary = `${verdict.summary} ${bookkeepingTrouble}`;

  try {
    await rememberCheck(store, { product, verdict, decided });
  } catch (e) {
    // Nothing here is worth failing a finished check over — but it is worth a sentence.
    // This record is the only thing that knows what the finding ids in this reply mean, so
    // when it is not written the agent's very next move, `staysfixed_explain <id>` or
    // `staysfixed_prove <id>`, answers "the last check has no finding called that". Which
    // is a flat denial of something it was handed thirty seconds earlier, and it used to
    // arrive with nothing anywhere explaining why.
    verdict.summary = `${verdict.summary} This run could not be written down (${messageOf(e)}), so asking to explain or to prove one of the ids above will say it has never heard of it.`;
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
  // `staysfixed coverage`, not `coverage.gaps`. This sentence is printed at a person as well
  // as returned to an agent, and a person at a terminal has no JSON field to open — being
  // told to read one is being told to go nowhere. The command is true for both readers, and
  // the agent already had that wording on its own reply.
  return `NOT EVERYTHING WAS CHECKED: ${parts.join(', and ')}. A clean result only covers what was walked — \`staysfixed coverage\` has the whole list.`;
}

/**
 * Was there anything on the other side to compare against at all?
 *
 * TWO WAYS TO COMPARE NOTHING, and only one of them was caught here.
 *
 * The first is per journey: the engine records one gap for each journey it had no stored
 * record for, and when that count reaches every journey walked, the run held nothing against
 * anything. The gaps are recognised by the words the engine writes into them, and a test
 * walks a real project into exactly this state, so a rewording fails loudly rather than
 * quietly switching the guard off.
 *
 * The second is the COLD START, and it never records a per-journey gap at all, so this used
 * to miss it completely. A product nobody has ever shipped with the hook in place has no
 * reference: there is no old build, so there is no journey to be missing a record FOR. The
 * run walked everything, compared none of it, found no differences, and set `ok: true`.
 *
 * The command line has always caught that one on its own and exits 2. `--json` and the MCP
 * surface do not read the command line's arithmetic — they read this verdict — so the two
 * interfaces an agent actually uses answered `ok: true` to "did I break anything" on a
 * project where nothing had been compared. That is the exact failure this whole tool exists
 * to prevent, produced by the tool, to a reader with no way of noticing.
 *
 * @param {CheckOutcome} verdict
 * @returns {'no reference'|'no stored record'|null}
 */
function comparedNothing(verdict) {
  if (!verdict.reference || verdict.reference.id === '') return 'no reference';
  const coverage = verdict.coverage;
  const walked = coverage?.journeys ?? 0;
  if (walked === 0) return null;
  const nothingToCompare = (coverage?.gaps ?? []).filter((gap) =>
    /never been walked against|no stored record of the old build/i.test(`${gap.what} ${gap.why}`),
  ).length;
  return nothingToCompare >= walked ? 'no stored record' : null;
}

/**
 * Walk the guards, if this project can be opened.
 *
 * Guards are the headline of this whole product — one plain-English rule per bug somebody
 * already had — and the default command never ran them. It said so, which was better than
 * pretending, but saying it is not doing it. Version 1 knows how to drive an app and run
 * them; what was missing was anybody calling it from here.
 *
 * It needs an address it can open. Where the settings only say how to START the product,
 * that is version 2's job and this path cannot do it — so it says so instead, and names the
 * one line that would change it.
 *
 * @param {string} root
 * @param {any} options
 * @returns {Promise<{ran: boolean, why: string, said: string, failed: {name: string, message?: string}[]}>}
 */
async function walkTheGuards(root, options) {
  try {
    const { loadProject } = await import('../core/config.js');
    const { runCheck } = await import('../run.js');
    const project = await loadProject({ cwd: root, configFile: options?.configFile });
    const run = await runCheck(project, { guardsOnly: true, writeReport: false, quiet: true, signal: options?.signal });
    const guards = run.guards ?? [];
    const failed = guards.filter((g) => g.status === 'failed').map((g) => ({ name: g.name, message: g.message }));
    const held = guards.length - failed.length;
    return {
      ran: true,
      why: '',
      said:
        failed.length === 0
          ? `All ${guards.length} guard${guards.length === 1 ? '' : 's'} still hold.`
          : `${failed.length} of ${guards.length} guards failed — ${failed.length === 1 ? 'a bug' : 'bugs'} that ${failed.length === 1 ? 'was' : 'were'} already fixed ${failed.length === 1 ? 'is' : 'are'} back, and no agent may wave ${failed.length === 1 ? 'it' : 'them'} through. ${held} still hold.`,
      failed,
    };
  } catch (e) {
    return { ran: false, why: messageOf(e), said: '', failed: [] };
  }
}

/**
 * The guards this project has, by name.
 *
 * Names only: sealing a difference by the guard it touches needs the name, and nothing on
 * this path can run one. `loadGuards` wants only the folder, and it is the same reader
 * version 1 uses, so a guard version 1 accepts is a guard this counts.
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export async function guardNames(root) {
  try {
    const { loadGuards } = await import('../guard/load.js');
    const guards = await loadGuards(/** @type {any} */ ({ paths: { guards: path.join(root, '.staysfixed', 'guards') } }));
    return guards.map((g) => String(g?.name ?? '')).filter(Boolean);
  } catch {
    // A guards folder that will not load must never stop a check running. Version 1 says the
    // same about the same folder, and a check that refuses is worse than one without a seal.
    return [];
  }
}

/**
 * Is the thing that ran older than the code it was built from?
 *
 * This tool never builds anything — deliberately, because building somebody's project is not
 * its business. But a project whose start command runs `dist/server.js` and whose source
 * lives in `src/` will happily run YESTERDAY's build against today's source, compare it
 * against a reference cut from the same stale output, and answer "Nothing that worked has
 * changed" — about code it has never once executed. Measured 2026-08-31.
 *
 * It cannot be fixed by building; it can be SAID, which is all a coverage gap has to do.
 *
 * @param {string} root
 * @param {any} config
 * @returns {Promise<CoverageGap|null>}
 */
async function builtBeforeItsSource(root, config) {
  try {
    let pkg = {};
    try {
      pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
    } catch {
      return null;
    }
    const scripts = /** @type {any} */ (pkg).scripts ?? {};
    // `npm run start` says nothing about where the product lives; the answer is one level
    // down, in the script it runs. Following that indirection is the difference between this
    // check firing and never firing, because `init` writes exactly `npm run start`.
    const through = (/** @type {string} */ line) => {
      const run = /(?:npm run|yarn|pnpm run|pnpm)\s+([\w:-]+)/.exec(line);
      const named = run ? scripts[run[1]] : line.includes('npm start') ? scripts.start : null;
      return `${line} ${typeof named === 'string' ? named : ''}`;
    };
    const starts = [
      ...(config?.process?.commands ?? []).map((/** @type {any} */ c) => String(c?.run ?? '')),
      String(config?.http?.start ?? ''),
      String(config?.web?.start ?? ''),
    ].map(through).join(' ');
    const named = /\b(dist|build|out|lib)\b/.exec(starts);
    const builds = typeof scripts.build === 'string';
    if (!named || !builds) return null;

    const outDir = path.join(root, named[1]);
    const srcDir = path.join(root, 'src');
    const [built, source] = await Promise.all([newestUnder(outDir), newestUnder(srcDir)]);
    if (built === 0 || source === 0 || source <= built) return null;

    const behind = Math.round((source - built) / 1000);
    /** @param {number} n @param {string} unit */
    const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
    const howLong =
      behind > 86400 ? plural(Math.round(behind / 86400), 'day') : behind > 3600 ? plural(Math.round(behind / 3600), 'hour') : plural(Math.max(1, Math.round(behind / 60)), 'minute');
    return {
      what: `What ran is older than the code it was built from — \`${named[1]}/\` is ${howLong} behind \`src/\`.`,
      why: `This tool runs your product, it never builds it. So the build in \`${named[1]}/\` is what was walked, and your newer source was not executed at all. A clean result here says nothing whatever about the code you have just written — and the reference it was compared against was cut from the same stale output.`,
      unlockedBy: 'Run your build before the check — `npm run build && npx staysfixed check` — or put the build into the start command in your settings.',
    };
  } catch {
    return null;
  }
}

/**
 * The newest modification time anywhere under a folder, or 0 if there is nothing there.
 * @param {string} dir
 * @returns {Promise<number>}
 */
async function newestUnder(dir) {
  let newest = 0;
  /** @param {string} at @param {number} depth */
  const walk = async (at, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = await fsp.readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else {
        try {
          const at2 = (await fsp.stat(full)).mtimeMs;
          if (at2 > newest) newest = at2;
        } catch {
          // gone between the listing and the question
        }
      }
    }
  };
  await walk(dir, 0);
  return newest;
}

/**
 * The ways into the product that were never tried, and why.
 *
 * A build that would not start does not produce one finding — it produces one at every
 * address it used to answer at, and the real news is nowhere in the list.
 *
 * @param {CheckOutcome} verdict
 * @returns {string[]}
 */
function didNotAnswer(verdict) {
  /** @type {Set<string>} */
  const said = new Set();
  for (const finding of verdict.findings ?? []) {
    for (const d of finding.differences ?? []) {
      const path = String(d.path ?? '');
      if (!path.endsWith('answered at all')) continue;
      const name = path.split('.').slice(1, -1).join('.') || path;
      const why = typeof d.candidate === 'string' ? d.candidate : typeof d.describe === 'string' ? d.describe : '';
      said.add(why ? `${name} (${String(why).slice(0, 90)})` : name);
    }
  }
  return [...said];
}

/**
 * Copies left behind by runs that never finished.
 *
 * A check copies the whole project into a scratch folder, and a run that is killed — Ctrl-C,
 * a laptop closing, a CI job cancelled — never gets to delete it. Nothing else ever did
 * either: measured on 2026-08-30, an ordinary machine had 777 MB of `staysfixed-check-*`
 * sitting in the temporary folder, one copy of it 485 MB, and a later run added to the pile
 * rather than clearing it. A tool that quietly fills somebody's disk is not one they keep.
 *
 * The rule is the one the browser sweep already uses: never touch something in use. A folder
 * whose owner is still running is left completely alone, and one with no owner recorded is
 * only taken once it is far older than any real run could be. A dead process id that has
 * since been reused reads as "still running" and the folder survives, which is the safe way
 * round to be wrong.
 *
 * @returns {Promise<void>}
 */
export async function sweepAbandonedScratch() {
  const AN_HOUR = 60 * 60 * 1000;
  const MOST_PER_RUN = 20;
  let names = [];
  try {
    names = await fsp.readdir(os.tmpdir());
  } catch {
    return;
  }
  // Programs whose folder has ALREADY gone are swept first, because the loop below can never
  // reach them: it walks folders, and theirs is not there any more. Fifteen `serve` processes
  // were found in exactly that state on 2026-08-31, out of scratch folders deleted the day
  // before. A folder that no longer exists is the strongest possible evidence that its run is
  // over, so nothing that is still going is at risk here.
  await stopRunsWhoseFolderHasGone();

  let taken = 0;
  for (const name of names) {
    if (taken >= MOST_PER_RUN) break;
    if (!name.startsWith('staysfixed-check-')) continue;
    const dir = path.join(os.tmpdir(), name);
    let abandoned = false;
    try {
      const owner = JSON.parse(await fsp.readFile(path.join(dir, 'owner.json'), 'utf8'));
      abandoned = typeof owner?.pid !== 'number' || !processAlive(owner.pid);
    } catch {
      // No owner recorded: either an older copy or one that died before it could say. Age is
      // all there is to go on, and an hour is well past the longest run this tool makes.
      try {
        abandoned = Date.now() - (await fsp.stat(dir)).mtimeMs > AN_HOUR;
      } catch {
        abandoned = false;
      }
    }
    if (!abandoned) continue;
    // The folder is not the whole of what was left behind. Four `vite preview` servers from
    // the day before were still running on this machine on 2026-08-31, out of scratch folders
    // that had already been deleted — started by a run that died before it could stop them.
    // Deleting the folder and leaving its programs running is a tool quietly consuming
    // somebody's machine, and this one is going to be installed on machines that are not its
    // author's. So the programs go first, and only then the folder.
    await stopWhateverIsStillRunningIn(dir);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    taken += 1;
  }
}

/**
 * Stop programs still running out of a scratch folder that has already been deleted.
 *
 * Every one of these was started by a check and outlived it. They hold ports and memory on a
 * machine that is usually not this tool's author's, and nothing else on it has a
 * `staysfixed-check-` path in its command line, so the match cannot catch a stranger.
 *
 * A folder that still exists is left completely alone here — a run that is going right now
 * has its folder, and stopping its own servers would be this function breaking the check that
 * called it.
 *
 * POSIX only, for the same reason as {@link stopWhateverIsStillRunningIn}: asking Windows
 * this question needs a different command, and a wrong one there could stop something else.
 *
 * @returns {Promise<void>}
 */
async function stopRunsWhoseFolderHasGone() {
  if (process.platform === 'win32') return;
  /** @type {string} */
  let listing = '';
  try {
    listing = (await exec('/bin/ps', ['-A', '-o', 'pid=,command='], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch {
    return;
  }
  for (const line of listing.split('\n')) {
    const folder = /(\S*staysfixed-check-[A-Za-z0-9]+)/.exec(line);
    if (!folder) continue;
    if (existsSync(folder[1])) continue;
    const pid = Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10);
    if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) continue;
    for (const signal of /** @type {const} */ (['SIGTERM', 'SIGKILL'])) {
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          // Gone already, or not ours to stop.
        }
      }
    }
  }
}

/**
 * Stop anything still running out of an abandoned scratch folder.
 *
 * Read from the process list rather than remembered, because the run that started these is
 * gone — that is what made the folder abandoned. A program is only killed when the folder
 * being reclaimed appears in its own command line, so nothing of anybody else's is touched.
 *
 * The whole group is signalled, not the one process: a server started through `npm run` is
 * a shell that started Node, and killing the shell alone leaves the server holding its port.
 *
 * POSIX only. Windows needs a different question asked of the machine, and a wrong one there
 * could kill something else, so it is left alone and said so rather than guessed at.
 *
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function stopWhateverIsStillRunningIn(dir) {
  if (process.platform === 'win32') return;
  /** @type {string} */
  let listing = '';
  try {
    listing = (await exec('/bin/ps', ['-A', '-o', 'pid=,command='], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch {
    return;
  }
  for (const line of listing.split('\n')) {
    if (!line.includes(dir)) continue;
    const pid = Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10);
    if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) continue;
    for (const signal of /** @type {const} */ (['SIGTERM', 'SIGKILL'])) {
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          // Already gone, or somebody else's to stop. Either way there is nothing to do.
        }
      }
    }
  }
}

/**
 * "There was nowhere to work", said the way every other refusal here is said.
 *
 * A check never runs anything against somebody's real folder: it copies the build into a
 * throwaway folder inside the machine's temporary directory first. When that folder cannot
 * be made, the run is over before it starts — and what a person was handed for it was the
 * operating system's own words, `ENOENT: no such file or directory, mkdtemp
 * '/nowhere/staysfixed-check-FHwIxx'`, pasted straight into the block this tool tells an
 * agent to put in a summary for the person who owns the product. Measured 2026-08-31 with
 * TMPDIR pointing at a folder that was not there, and again at one this user could not
 * write to. Every other refusal in this file is a plain sentence; that one was a stack.
 *
 * The three that actually happen each get their own sentence, because the thing to DO about
 * them is different every time: the folder is not there, the folder will not take writes, or
 * the disk is full. Anything else keeps the machine's own words, framed as the machine's —
 * when there is no sentence for it, the raw text is the only information there is, and
 * dropping it would leave somebody with nothing at all.
 *
 * @param {unknown} e
 * @returns {StaysFixedError}
 */
function noScratchFolder(e) {
  const tmp = os.tmpdir();
  const code = String(/** @type {any} */ (e)?.code ?? '');
  // Worth naming only when a setting in this shell is what chose the folder. On a machine
  // where nothing set it, saying "TMPDIR" sends somebody looking for a setting they have not
  // got, and the folder is the operating system's own.
  const yours = (process.env.TMPDIR ?? '').replace(/\/$/, '') === tmp.replace(/\/$/, '')
    ? ' That folder is whatever TMPDIR is set to in this shell.'
    : '';
  /** @type {{why: string, hint: string}} */
  const said =
    code === 'ENOENT'
      ? {
        why: `There is no folder at ${tmp}, so there was nowhere to put it.`,
        hint: `Make that folder, or point TMPDIR at one that exists — or unset TMPDIR to fall back to this machine's own — and run the check again.${yours}`,
      }
      : code === 'EACCES' || code === 'EPERM'
        ? {
          why: `${tmp} is there, but this user is not allowed to write in it.`,
          hint: `Give yourself write access to that folder, or point TMPDIR at one you can write to, and run the check again.${yours}`,
        }
        : code === 'EROFS'
          ? {
            why: `${tmp} is on a disk that is mounted read-only, so nothing can be written there at all.`,
            hint: `Point TMPDIR at a folder on a disk that takes writes and run the check again.${yours}`,
          }
          : code === 'ENOSPC'
            ? {
              why: `The disk holding ${tmp} is full.`,
              hint: 'Free some space and run the check again. A check copies your project, so it needs about as much room as the project takes.',
            }
            : {
              why: `${tmp} would not take it. The machine said: ${messageOf(e)}`,
              hint: `Check that ${tmp} exists and that you can write in it, then run the check again.${yours}`,
            };
  return new StaysFixedError(
    `Stays Fixed could not make the throwaway folder it works in, so nothing was opened, nothing was walked and nothing was compared. ${said.why}`,
    { hint: said.hint, cause: e },
  );
}

/**
 * Is that process still running? Signal 0 asks without sending anything.
 * @param {number} pid
 * @returns {boolean}
 */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
 * @param {string} [storeTrouble]  What the store would not do earlier in this same run,
 *   when there was any. It goes in front of the error, because it usually IS the error's
 *   cause and the error on its own reads as something else entirely.
 * @returns {CheckOutcome}
 */
function blocked(options, e, storeTrouble) {
  // The basename of the ROOT, not of the folder the command was typed in. Those are the
  // same folder on almost every run, and on the one where they differ this record is
  // written into the root's store — so naming it after the folder somebody happened to be
  // standing in filed a run under a product that store has never heard of.
  const root = projectRootFor(options);
  const product = options.product ?? path.basename(root);
  const empty = { id: '', product };
  // Which folder this is about, said before the reason it could not be done. A blocked run
  // inside a sub-project is the easiest of all to misread: nothing was walked, so there is
  // nothing in the answer to give away that it was never about this folder in the first
  // place. `options.product` is passed rather than the name worked out above, because a name
  // taken from a folder is not a product name and quoting it as one would put a product in
  // front of somebody that nothing anywhere calls that.
  const elsewhere = aboutSomewhereElse({ from: startedIn(options), root, product: options.product })?.note ?? '';
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
    coverage: {
      paths: 0,
      journeys: 0,
      byChannel: {},
      gaps: [{ what: 'Everything.', why: storeTrouble ? `${storeTrouble} ${messageOf(e)}` : messageOf(e) }],
    },
    // The hint is the half that tells a person what to DO about it, and dropping it
    // turns a helpful error into a dead end. Anything that blocks a run has to carry
    // both halves all the way out to whoever reads the summary.
    summary: `${elsewhere ? `${elsewhere} ` : ''}The check could not be run, so this is not a pass and not a failure. ${storeTrouble ? `${storeTrouble} ` : ''}${messageOf(e)}${
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
    // From the commit the old build is at, not from the working tree. Without this, an agent
    // that committed its work before asking to prove a cause was told there was no change to
    // undo — about a change sitting one commit back, which git can hand over exactly.
    const changed = await whatChanged(project.root, { since: project.referenceSha });
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
  // The count goes on the end when the list was cut. Six file names with nothing after them
  // read as the whole list, so an agent that opened all six believed it had seen everywhere
  // this finding lives — and the file it needed was the seventh.
  if (f.nearFiles?.length) {
    const shown = f.nearFiles.slice(0, 6);
    const more = f.nearFiles.length - shown.length;
    out.push('', `Nearest code: ${shown.join(', ')}${more > 0 ? `, and ${more} more ${more === 1 ? 'file' : 'files'} this finding also comes from` : ''}.`);
  }
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
 * @property {number} keepBuilds  How many builds of this product other than the reference keep
 *   their full record. Everything older is thinned out at the end of a run.
 * @property {string} [referenceSha]  The commit the build you were happy with is at. It is
 *   what makes a COMMITTED change measurable: the change from that commit to the working
 *   tree is the change, and reading the working tree alone goes blind the moment an agent
 *   commits its work — which is what an agent does at the end of a task.
 * @property {Journey[]} journeys
 * @property {CoverageGap[]} gaps   Holes found while working out WHAT to walk, before a
 *   single journey ran. An adapter that fell over listing its journeys belongs here, and it
 *   has to reach the verdict: a channel that silently dropped out is the worst thing this
 *   tool can do.
 * @property {string} storeTrouble  Empty on a normal run. A plain sentence when the store
 *   would not take this run's records — the run went ahead anyway, and every answer it
 *   produces has to carry the admission that nothing about it was kept.
 * @property {string} elsewhere  Empty when the check is about the folder it was typed in.
 *   Otherwise the sentence naming which product this run is really about and where it is,
 *   which goes on the FRONT of the answer so nobody reads a clean result as being about a
 *   folder that was never walked.
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
  const from = startedIn(options);
  const config = options.configFile ?? findConfigFile(from);
  return config ? rootForConfig(config) : from;
}

/**
 * The folder the command was actually typed in.
 *
 * @param {CheckOptions} options
 * @returns {string}
 */
function startedIn(options) {
  return path.resolve(options.cwd ?? options.root ?? process.cwd());
}

/**
 * Files that mean "this folder is a project in its own right".
 *
 * Any one of them is enough. They are the files a person points at when asked "where does
 * this thing live", and every one of them is what a package manager or a language's own
 * tooling reads as the top of a project.
 */
const A_PROJECT_OF_ITS_OWN = [
  'package.json', '.git', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'deno.json',
];

/**
 * When a check is not about the folder somebody is standing in, say so.
 *
 * Settings are found by walking UP from where the command was typed, which is right: a
 * check run from `src/` is meant to be about the project `src/` is part of. But the same
 * walk reaches out of a project and into the one above it. Stand in a sub-folder that is
 * its own git repository with its own package.json, run a check, and the run quietly
 * measures the PARENT'S product and comes back clean — measured 2026-08-31, where a folder
 * holding `child-product` was reported on as `parent-product` with nothing said about the
 * swap. Somebody reading that has been handed a clean result about a product they were not
 * asking about, which is the exact failure this tool exists to prevent.
 *
 * So every run that is about somewhere else says which product it is about and where that
 * product is, and a run that stepped out of a project of its own says it loudly and says
 * what to do instead. Nothing is refused: reaching up is usually right, and being told what
 * happened is what makes it safe.
 *
 * Exported so a test can ask the question without running a whole check.
 *
 * @param {{from: string, root: string, product?: string}} where
 * @returns {{note: string, gap: CoverageGap|null}|null}  Null when the check really is
 *   about the folder it was typed in, which is the ordinary case.
 */
export function aboutSomewhereElse(where) {
  const from = path.resolve(where.from);
  const root = path.resolve(where.root);
  if (from === root) return null;
  const named = where.product ? `"${where.product}"` : path.basename(root);

  const itsOwn = A_PROJECT_OF_ITS_OWN.filter((name) => existsSync(path.join(from, name)));
  if (itsOwn.length === 0) {
    // Ordinary and usually wanted: somebody is standing inside the project they meant. One
    // sentence, so a clean answer still carries the name of what it is a clean answer about.
    return {
      note: `This check was aimed at ${named}, the project at ${shortPath(root)}; you ran it from ${shortPath(from)}, which is inside it.`,
      gap: null,
    };
  }

  const because = itsOwn.includes('.git') && itsOwn.length > 1
    ? `it is its own git repository and has its own ${itsOwn.filter((n) => n !== '.git').join(' and ')}`
    : itsOwn.includes('.git')
      ? 'it is its own git repository'
      : `it has its own ${itsOwn.join(' and ')}`;
  // "was aimed at", not "walked": this same sentence goes on the front of a blocked run,
  // where nothing was walked at all, and a frame that claims more than happened would be
  // the same kind of lie in miniature as the one it is here to stop.
  const note =
    `NOT THE FOLDER YOU ARE STANDING IN. This check was aimed at ${named}, the project at ${shortPath(root)} — ` +
    `not at ${shortPath(from)}, which is where you ran it. That folder is a project in its own right (${because}) ` +
    `and it has no Stays Fixed settings of its own, so the settings from the folder above it are what this run used. ` +
    `Nothing inside ${shortPath(from)} was checked, so nothing below says anything about it. ` +
    `Run \`staysfixed init\` there to check that project on its own.`;
  return {
    note,
    gap: {
      what: `Everything in ${shortPath(from)}, the folder this check was run from.`,
      why:
        `It is a project in its own right (${because}), and it has no Stays Fixed settings of its own. ` +
        `Settings are found by walking up, so the ones at ${shortPath(root)} were used and ${named} was walked instead.`,
      unlockedBy: `Run \`staysfixed init\` in ${shortPath(from)} to give that project its own settings, and check it from there.`,
    },
  };
}

/**
 * How many builds keep their whole record before the old ones are thinned out.
 *
 * A setting rather than a constant, because a project running fifty checks a day and one
 * running three a week want different answers and neither of them is wrong. Five is the
 * default: enough that `--against` and `staysfixed_prove` can still reach back over a few
 * commits, small enough that a record committed into somebody's repository stops growing.
 */
const KEEP_BUILDS = 5;

/**
 * The fewest captures any build keeps. One is still a stored record a later check can be
 * compared against; nought would delete the evidence that the build ever ran.
 */
const KEEP_CAPTURES_PER_JOURNEY = 1;

/**
 * THE RETENTION POLICY, and why it is a count rather than an age.
 *
 * Thinning was never enough on its own. `pruneBuild` throws away captures INSIDE a build and
 * can never remove the folder, so the thing that actually grows — one build folder per check,
 * in a directory this tool asks people to commit — grew anyway. Nine folders in one afternoon
 * on a throwaway project, and nothing in the tool could ever have removed one.
 *
 * So there are three tiers, and this is the third:
 *
 *   1. The newest `keepBuilds` keep every recording they took. This is the working set —
 *      `--against` and `staysfixed_prove` reach back over these.
 *   2. Everything behind them is thinned to one recording per journey. The build is still
 *      there and can still be compared against; it just stops holding every take.
 *   3. Past `keepBuilds` times this number, the folder goes altogether — oldest first.
 *
 * WHY NOT AN AGE. An age bounds nothing. A project checked on every commit writes fifty
 * folders a day, so thirty days of them is fifteen hundred folders in somebody's git history
 * — and the same rule on a project checked twice a week deletes a two-month-old build that is
 * the only other thing in the store. The count is what grows, so the count is what is capped.
 *
 * WHY A SECOND TIER AT ALL, rather than removing everything past `keepBuilds`. The thinned
 * tier IS the grace period, and it is a cheap one: a thinned build holds one recording per
 * journey, so fifteen of them cost about what one untouched build costs. It buys back the
 * case this policy would otherwise get wrong — somebody who ran thirty checks in an afternoon
 * and then wants `--against` on the build from before lunch.
 *
 * Four, so a `keepBuilds` of five means at most twenty folders of this product, and the
 * sentence a person reads has one number in it rather than two.
 */
const KEEP_THINNED_MULTIPLE = 4;

/**
 * @param {Record<string, any>} config
 * @returns {number}
 */
function keepBuildsFrom(config) {
  const asked = Number(config?.keepBuilds);
  return Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : KEEP_BUILDS;
}

/**
 * How long the test-suite harvest gets, out of the settings file: `suite: {budgetMs}`.
 *
 * Ninety seconds is the right DEFAULT — it is a statement about how long anybody waits inside
 * an edit-and-check loop before switching the tool off — but it was also the only answer
 * available. A project whose suite takes four minutes got ninety seconds and the rest of its
 * files named as gaps, with no way anywhere in the tool to say "I am willing to wait". A
 * limit that decides something has to be visible and, where it safely can be, adjustable.
 *
 * Zero means no budget: harvest every file however long it takes. That is a thing to ask for
 * on purpose and it is never a default.
 *
 * Nothing said comes back as null rather than as the default, so the number lives in one
 * place — `DEFAULT_HARVEST_BUDGET_MS`, in the file that applies it — instead of being copied
 * here where the two could drift.
 *
 * Exported so the reading of the setting can be tested on its own. Everything downstream of
 * it costs a real test suite being run twice, and a setting nobody can check the reading of
 * is a setting that will one day quietly stop being read.
 *
 * @param {Record<string, any>} config
 * @returns {number|null}  Null when the settings say nothing, or say something that is not a
 *   number of milliseconds.
 */
export function suiteBudgetFrom(config) {
  const asked = Number(config?.suite?.budgetMs);
  return Number.isFinite(asked) && asked >= 0 ? Math.floor(asked) : null;
}

/**
 * How long the harvest gets when NOBODY asked for it.
 *
 * A quarter of what somebody who typed `--journeys suite` gets, and that gap is the whole
 * design. Measured on this machine on 2026-08-31: twelve near-empty test files harvested in
 * 3.1 seconds. Twenty seconds therefore covers a small suite outright and takes a useful bite
 * out of a large one, and every file it does not reach is named in the coverage list with the
 * command that would reach it. The alternative — deciding from a file count whether to run at
 * all — guesses at how slow somebody's tests are and is wrong in both directions.
 */
const AUTO_HARVEST_BUDGET_MS = 20_000;

/**
 * How many harvested test files an unasked-for run will then WALK.
 *
 * The harvest budget bounds the harvest and not what comes after it: each harvested journey
 * is walked twice on the new build and again on the old one. Measured on this machine on
 * 2026-08-31, twelve harvested journeys took a check from 1.4 seconds to 8.2. Twelve is
 * therefore the cap, and the files past it are named rather than dropped in silence.
 */
const AUTO_HARVEST_JOURNEY_CAP = 12;

/**
 * How long ONE test file gets on an unasked-for run, harvesting and walking alike.
 *
 * The budget above is checked before a file STARTS, never in the middle of one, so without
 * this a single slow test file could walk straight through a twenty-second budget and spend
 * the runner's default two minutes doing it — turning a bounded default into an unbounded
 * one on exactly the projects where that hurts most. Thirty seconds is generous for one file
 * of a suite somebody runs on every change, and a file that needs longer is named as a hole
 * with the reason, which is the honest outcome rather than a silent wait.
 */
const AUTO_FILE_TIMEOUT_MS = 30_000;

/**
 * Should this run harvest the project's own tests without being asked?
 *
 * The question is only ever "can this be done at all", never "is this project's suite worth
 * it" — a suite that is too slow is handled by the budget and the cap above, not by refusing
 * to look. Everything here is cheap: package.json is read, a few filenames are tested for
 * existence, and nothing is run.
 *
 * IT CAN BE SWITCHED OFF, in two ways, because a default that cannot be turned off is a
 * default somebody works around by uninstalling. `--journeys code` says "read the source and
 * nothing else" for one run; `suite: { auto: false }` in the settings says it for good. Both
 * are reported as a hole in that run's coverage, so switching it off never quietly turns into
 * believing a check that no longer looks.
 *
 * @param {string} root
 * @param {Record<string, any>} config
 * @returns {Promise<{run: boolean, gap?: CoverageGap}>}
 */
async function suiteWorthRunningByDefault(root, config) {
  if (config?.suite?.auto === false) {
    return {
      run: false,
      gap: {
        what: "This project's own tests were not run, because the settings switch that off.",
        why: 'suite: { auto: false } in your settings file. Nothing your tests can see is being compared on this run, which on a library is most of what there is to see.',
        unlockedBy: 'Remove that line, or run `staysfixed check --journeys suite` once to see what it would find.',
      },
    };
  }
  try {
    const { detectRunner } = await import('./journeys/from-suite.js');
    const found = await detectRunner(root);
    if (found.runner === 'none') {
      // Said out loud, on every run, rather than passed over as "there was nothing to do".
      // A project with no tests is not a project where the tests are fine — it is a project
      // where a whole channel is empty, and on a library that channel is most of what there
      // is to look at. The reader is told which it is.
      return {
        run: false,
        gap: {
          what: "None of this project's own tests were run, because there are none this tool can find.",
          why: `${found.why} A test suite is the only source that walks this product with the arguments somebody actually thought about, so without one the check compares what it can read and call for itself, and no more.`,
          unlockedBy: "Point the project at vitest or Node's own test runner and every test file becomes a journey, run twice on each build and compared.",
        },
      };
    }
    const blocking = (found.missing ?? []).filter((m) => m.blocking);
    if (blocking.length > 0) {
      return {
        run: false,
        gap: {
          what: "This project has a test suite and none of it was run, so nothing here says anything about what those tests cover.",
          why: `${blocking.map((m) => m.what).join(', ')} ${blocking.length === 1 ? 'is' : 'are'} missing, and the harvest cannot run one test file at a time without ${blocking.length === 1 ? 'it' : 'them'}.`,
          unlockedBy: blocking.map((m) => m.howToGet).join(' '),
        },
      };
    }
    return { run: true };
  } catch (e) {
    // Being unable to work out whether a suite exists is a hole like any other. It must never
    // read as "this project has no tests", which is the same silence wearing a different hat.
    return {
      run: false,
      gap: {
        what: "Nothing could work out whether this project has a test suite, so none of it was run.",
        why: messageOf(e),
        unlockedBy: 'Run `staysfixed check --journeys suite` to see what it says, or `staysfixed doctor` for what this folder is missing.',
      },
    };
  }
}

/**
 * Thin out the record of builds nobody is going to ask about again.
 *
 * WHY THIS EXISTS AT ALL. `.staysfixed/` is deliberately kept in git — the record of what
 * working means is the promise, and a fresh checkout with no record has nothing to compare
 * against. That decision is right and it has a bill attached: one build folder per check,
 * for ever, inside somebody's repository history. Measured on a throwaway Express project
 * after about ten checks: 492KB across 118 files and nine build folders in one afternoon.
 *
 * WHAT IS NEVER TOUCHED. The build this product calls working — `pruneBuild` and `removeBuild`
 * both refuse it outright and this refuses it again before asking. The build just walked. The
 * build named by `--against`, because somebody is plainly still using it. And the newest few
 * after that. See `KEEP_THINNED_MULTIPLE` for what happens to everything else, and why.
 *
 * WHEN IT DOES NOT RUN. On a blocked run there is no answer to trust and nothing is touched.
 * And, most importantly, when the list of builds came back with anything missing from it: a
 * damaged record is now reported rather than silently omitted, and deciding what is old on a
 * list that is short is how the evidence for "this used to work" gets deleted. That holds for
 * the removal tier above all — a folder that is thinned can be walked again, a folder that is
 * gone cannot. It is said out loud rather than skipped quietly, because a housekeeping step
 * that stops running is exactly the sort of thing nobody notices for a year.
 *
 * @param {Project} project
 * @param {CheckOutcome} outcome
 * @returns {Promise<string>}  One plain sentence when something was removed or when it was
 *   deliberately not attempted. Empty when there was simply nothing to do.
 */
async function tidyTheStore(project, outcome) {
  /** @type {string[]} */
  const said = [];

  // A run clears up after itself first, and before the `blocked` gate, because a run that was
  // blocked is exactly the kind that died holding a half-written file. Scoped to the build
  // this run just wrote: clearing up after itself must never reach into another product's
  // folder in the same store. They are invisible — nothing reads a `.part` file — and an
  // invisible pile of half-written megabytes is how a tool gets blamed for a full disk.
  try {
    const swept = await sweepIncomplete(project.store, { buildId: project.candidate.id, olderThanMs: 0 });
    if (swept.removed > 0) {
      said.push(`${swept.removed} half-written ${swept.removed === 1 ? 'file' : 'files'} left behind by an earlier run that died were cleared away.`);
    }
  } catch (e) {
    // Never fatal. A folder that will not be swept costs disk; losing the verdict over it
    // would cost the whole run.
    said.push(`Half-written files from earlier runs could not be cleared away: ${messageOf(e)}`);
  }

  if (outcome.blocked === true) return said.join(' ');

  /** @type {string[]} */
  const problems = [];
  /** @type {import('./types.js').BuildRecord[]} */
  let builds;
  try {
    builds = await listBuilds(project.store, { product: project.product, onProblem: (m) => problems.push(m) });
  } catch (e) {
    said.push(`The stored record could not be listed, so nothing old was cleared out of it: ${messageOf(e)}`);
    return said.join(' ');
  }
  if (problems.length > 0) {
    said.push(`Nothing old was cleared out of the stored record this time. ${problems.join(' ')} Deciding what is old from a list that is missing something is how the evidence for "this used to work" gets deleted, so it was not attempted.`);
    return said.join(' ');
  }

  const spared = new Set([project.candidate.id]);
  if (project.against) spared.add(project.against);
  for (const record of builds) if (record.isReference) spared.add(record.fingerprint.id);

  // `listBuilds` hands them back newest first, so the newest few survive the slice.
  const unspared = builds.filter((b) => !spared.has(b.fingerprint.id));
  const cap = project.keepBuilds * KEEP_THINNED_MULTIPLE;
  const thinning = unspared.slice(project.keepBuilds, cap);
  const doomed = unspared.slice(cap);
  if (thinning.length === 0 && doomed.length === 0) return said.join(' ');

  let removed = 0;
  let thinned = 0;
  let folders = 0;
  let evidence = 0;
  /** @type {string[]} */
  const refused = [];
  for (const record of thinning) {
    try {
      const done = await pruneBuild(project.store, record.fingerprint.id, { keepPerJourney: KEEP_CAPTURES_PER_JOURNEY });
      if (done.removed > 0) {
        removed += done.removed;
        thinned += 1;
      }
    } catch (e) {
      // A build that will not be pruned is kept, which is the safe direction — and it is
      // still worth naming, because a store that quietly stops being tidied grows for ever.
      refused.push(`${record.fingerprint.id} (${messageOf(e)})`);
    }
  }
  // Oldest first, which is what `unspared` already is once the newest have been sliced off
  // the front. A removal that stops half way therefore leaves the NEWER of the old builds
  // standing, which is the direction anybody would choose if asked.
  for (const record of doomed.slice().reverse()) {
    try {
      const done = await removeBuild(project.store, record.fingerprint.id);
      folders += 1;
      evidence += done.captures;
    } catch (e) {
      refused.push(`${record.fingerprint.id} (${messageOf(e)})`);
    }
  }

  if (removed > 0) {
    said.push(
      `${removed} old ${removed === 1 ? 'recording was' : 'recordings were'} cleared out of ${thinned} ${thinned === 1 ? 'build' : 'builds'} nobody is comparing against any more.`,
    );
  }
  if (folders > 0) {
    said.push(
      // "at most `cap`" counts only the ones this is allowed to touch. The build you called
      // working, the one just walked and anything named by --against are outside the count
      // entirely, so the sentence says so rather than quoting a number that is not the number
      // of folders on the disk.
      `${folders} ${folders === 1 ? 'build older than that was' : 'builds older than that were'} removed from the stored record altogether, taking ${evidence} ${evidence === 1 ? 'recording' : 'recordings'} with ${evidence === 1 ? 'it' : 'them'}: besides the ones never touched, this product keeps at most ${cap} builds, and ${folders === 1 ? 'that one had' : 'those had'} fallen off the end.`,
    );
  }
  if (removed > 0 || folders > 0) {
    said.push(`The build you were happy with, the one just walked and the newest ${project.keepBuilds} were left alone.`);
  }
  if (refused.length > 0) {
    said.push(`${refused.length} older ${refused.length === 1 ? 'build was' : 'builds were'} left as ${refused.length === 1 ? 'it is' : 'they are'} because ${refused.length === 1 ? 'it' : 'they'} could not be tidied: ${refused.join('; ')}`);
  }
  return said.join(' ');
}

/**
 * The rules that rewrite the two folders this run happens to be using.
 *
 * TWO ROOTS, TWO IDS, and that is the whole of this function. `mergeRules` keys by rule id
 * and the later one wins, so calling `machineRules` twice for two different folders handed
 * the same id — `path.project-root` — to both, and the second one, the scratch copy, deleted
 * the first. The rule that was supposed to rewrite somebody's real checkout to `<project>`
 * was therefore not in the rule set on any run this tool has ever done, and an absolute path
 * under their actual project was compared literally.
 *
 * Both are wanted. A product's output carries paths under the real checkout AND under the
 * throwaway copy it is walked in, and neither of those is a fact about the product.
 *
 * Exported so the collision can be tested for directly. It came back the moment two folders
 * were normalised in one run, and it will come back again the moment there are three.
 *
 * @param {{root: string, scratch: string}} where
 * @returns {NormaliseRule[]}
 */
export function pathRules(where) {
  return [
    ...machineRules({ root: where.root, home: os.homedir(), tmp: os.tmpdir() }),
    ...machineRules({ root: where.scratch }).map((rule) => ({
      ...rule,
      id: 'path.scratch-copy',
      what: 'The throwaway folder this run copied the build into to walk it.',
      why: 'It is a fresh temporary folder every run, so any path under it differs between two runs of the same build.',
      wouldHide: 'Nothing about the product. It only ever replaces a prefix this tool chose a moment ago.',
    })),
  ];
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
  const fromPackage = await packageName(root);
  const product = options.product ?? String(config.product ?? fromPackage.name ?? path.basename(root));

  const store = openStore({ root });
  /** Everything about the store that would not work, in the words the reader gets. */
  /** @type {string[]} */
  const storeTrouble = [];
  // A damaged package.json only matters when it was going to be what named this product —
  // and then it matters a great deal, because the name is the key everything is stored
  // under. Said out loud rather than fixed silently: guessing the old name would be worse.
  // It is NOT store trouble: the run is written down perfectly well, just under a name
  // nothing else in this project's history uses.
  const namingTrouble =
    fromPackage.damaged !== '' && options.product === undefined && config.product === undefined
      ? fromPackage.damaged
      : '';
  try {
    await ensureStore(store);
  } catch (e) {
    storeTrouble.push(`The folder Stays Fixed keeps its records in could not be made: ${messageOf(e)}`);
  }

  await sweepAbandonedScratch();
  /** @type {string} */
  let scratch;
  /** @type {string} */
  let evidenceDir;
  try {
    scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-check-'));
    evidenceDir = path.join(scratch, 'evidence');
    await fsp.mkdir(evidenceDir, { recursive: true });
  } catch (e) {
    throw noScratchFolder(e);
  }
  // Who this belongs to, so a later run can tell an abandoned copy from one in use.
  await fsp.writeFile(path.join(scratch, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() })).catch(() => {});

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
  // BOOKKEEPING MAY NOT COST THE ANSWER. Until 2026-08-30 these two writes were unguarded,
  // so a store that would not take them — a full disk, a permission taken away, a read-only
  // checkout — stopped the check dead before it had walked a single thing. What that threw
  // away is much larger than what it protected: the run could have opened the product,
  // walked it twice, compared it against the old build and handed back a real answer, and
  // all that was really lost was the note saying it had happened.
  //
  // So a failure here is remembered and said out loud, and the run carries on. Where the
  // record turns out to have been load-bearing after all — a reference named by a commit
  // that nothing can now register — the run still ends blocked, but it ends blocked SAYING
  // the store is the reason, instead of handing somebody a bare permission error from a
  // folder they have never heard of.
  try {
    await saveBuild(store, candidate);
  } catch (e) {
    storeTrouble.push(`The record of the build you have could not be written: ${messageOf(e)}`);
  }

  // A name like "HEAD", "v0.13.0" or a branch is what a person types; the store only knows
  // builds. Turning the name into a commit here, and putting that commit in the store, is
  // what lets a check be aimed at any point in history without every commit having been
  // walked before. Without it "HEAD" matches nothing and the check reports itself blocked.
  const reference = options.against ? await fingerprintCommit(root, product, options.against) : null;
  if (reference) {
    try {
      await saveBuild(store, reference);
    } catch (e) {
      storeTrouble.push(`The record of ${nameOfReference(reference, options.against)} could not be written, so a check aimed at it by name may find nothing on record to match: ${messageOf(e)}`);
    }
  }

  // Which commit the build you were happy with is at. With `--against` it is the commit that
  // was just named; without it, it is whatever the store's own reference pointer holds, which
  // is the usual case because a reference is cut by a person shipping. Either way it is the
  // thing that makes a committed change measurable, and nothing here had ever asked for it.
  /** @type {string|undefined} */
  let referenceSha = reference?.gitSha ?? undefined;
  if (!referenceSha) {
    try {
      const record = await referenceFor(store, product);
      referenceSha = record?.fingerprint?.gitSha ?? undefined;
    } catch (e) {
      // A damaged reference pointer is loud elsewhere. Here it costs the ordering, not the run.
      storeTrouble.push(`Which build counts as working could not be read, so a change you have already committed cannot be measured: ${messageOf(e)}`);
    }
  }

  // It goes in the coverage list because that is the one list every reader already meets —
  // the command line prints it, the build server's table prints it, and the closing sentence
  // counts it. A fact that only exists on a field somebody has to know to look for is a fact
  // most readers never meet.
  /** @type {CoverageGap[]} */
  const gaps = [...gathered.gaps];
  if (namingTrouble !== '') {
    gaps.push({
      what: `This run was recorded against a product called "${product}", which is the name of the folder rather than the name of the project.`,
      why: `${namingTrouble} Nothing else names this product either, so the folder name was used. Anything recorded under the name inside that file is a different product as far as this run is concerned, including the build you called working.`,
      unlockedBy: `Fix package.json, or put the name you want in your settings file as product: '<name>'. Until then every comparison starts from nothing.`,
    });
  }
  // Which folder this answer is about, when it is not the one the command was typed in.
  // It goes in the coverage list as well as on the front of the summary because the list is
  // what a build server's table and the closing count both read, and a fact that lives on
  // one field somebody has to know to look for is a fact most readers never meet.
  const elsewhere = aboutSomewhereElse({ from: startedIn(options), root, product });
  if (elsewhere?.gap) gaps.push(elsewhere.gap);
  const stale = await builtBeforeItsSource(root, config);
  if (stale) gaps.push(stale);
  if (storeTrouble.length > 0) {
    gaps.push({
      what: 'This run was NOT written down, so the next check has nothing from today to compare against.',
      why: `${storeTrouble.join(' ')} Whatever this run reports below still stands — the product was walked and compared exactly as usual — but none of it reached the disk.`,
      unlockedBy: 'Free some disk space, or fix the permissions on the .staysfixed folder, and run the check again.',
    });
  }

  const rules = mergeRules(DEFAULT_RULES, [
    ...pathRules({ root, scratch }),
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
    keepBuilds: keepBuildsFrom(config),
    referenceSha,
    against: reference ? reference.id : options.against,
    journeys,
    gaps,
    storeTrouble: storeTrouble.join(' '),
    elsewhere: elsewhere?.note ?? '',
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
      // An answer sheet arrives as one wall of text at one address, because that is what the
      // process adapter does with anything a command prints. Left that way, a library whose
      // every return value changed produced ONE finding, worded as a window onto the middle of
      // a string: "…eserved(\"admin\") -> false…" where it read "…eserved(\"admin\") -> true…".
      // True, and useless to the person who has to decide whether to ship. Taken apart, every
      // call gets the exported name's own address and the finding names the function, the
      // input and both answers. Measured 2026-08-31 — see `splitAnswerSheet`.
      if (isAnAnswerJourney(req.journey)) observations = splitAnswerSheet(observations, req.journey);
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
 * Something that can walk one journey in this project, right now, without a whole check.
 *
 * A check is the only thing that walked a journey until 2026-08-31, and that left the
 * recording command with a choice between running a full check to find out whether a fresh
 * recording repeats — minutes, a store write, a verdict nobody asked for — or writing a
 * second, simpler walker of its own, which would then be the walker that never gets fixed
 * when the real one is. Neither is acceptable, so the walk is handed out instead: the same
 * adapters, the same scratch-copy-per-walk rule, and the same normalisation a real check
 * applies, so what a recording is judged on is exactly what a later check will see.
 *
 * The caller closes it. Everything it made lives in one throwaway folder and `close` takes
 * that folder away.
 *
 * @param {{cwd?: string, root?: string, configFile?: string, config?: Record<string, any>}} [options]
 * @returns {Promise<{root: string, config: Record<string, any>, walk: (req: WalkRequest) => Promise<Capture>, close: () => Promise<void>}>}
 */
export async function walkerFor(options = {}) {
  await loadAdapters();
  const root = projectRootFor(options);
  const config = options.config ?? (await readConfig(options.configFile ?? findConfigFile(root)));
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-walk-'));
  const evidenceDir = path.join(scratch, 'evidence');
  await fsp.mkdir(evidenceDir, { recursive: true });
  // The same rewriting a check does, and for the same reason: every walk gets its own
  // throwaway folder, so a product that prints where it is running from would otherwise
  // look different on every single walk — including the two walks that are meant to prove a
  // recording repeats, which would then never repeat and no recording would ever be
  // accepted.
  const rules = mergeRules(DEFAULT_RULES, [
    ...pathRules({ root, scratch }),
    ...(await loadRules(path.join(root, '.staysfixed', 'rules.json'))),
  ]);
  return {
    root,
    config,
    walk: async (req) => normaliseCapture(await walkOne(req, { root, scratch, evidenceDir, config }), rules),
    close: async () => {
      await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * This project's settings, found the way a check finds them.
 *
 * Exported so that nothing else has to re-implement "walk up from here looking for a config
 * file, and read it whether it is JSON or a module". Two readers of one settings file that
 * disagree about where it is, is a bug that only shows up in somebody else's repository.
 *
 * @param {{cwd?: string, root?: string, configFile?: string}} [options]
 * @returns {Promise<{root: string, configFile: string|null, config: Record<string, any>}>}
 */
export async function settingsFor(options = {}) {
  const root = projectRootFor(options);
  const configFile = options.configFile ?? findConfigFile(root) ?? null;
  return { root, configFile, config: await readConfig(configFile) };
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

  const named =
    options.journeys && !['code', 'config', 'suite', 'recorded'].includes(options.journeys) ? options.journeys : null;

  // Sessions somebody actually performed, read back off the disk and walked like anything
  // else. This is the one source that knows how a person really uses the product — the four
  // screens they open every morning, in that order — and no amount of reading the source can
  // work that out, because the source only says which doors exist, never which ones anybody
  // opens. Until 2026-08-31 asking for it threw: the code to make a recording existed, and
  // nothing on the check path ever read one.
  //
  // A run that was ASKED for recorded sessions and found none stops and says so. Carrying on
  // with the journeys read out of the code would walk something the person did not ask for
  // and then report "nothing that worked has broken" — a clean answer about the wrong steps,
  // which is the one shape of reply this tool may never produce.
  if (options.journeys === 'recorded') {
    const { RECORDINGS_DIR, loadJourneyFolder, whatWillNotReplay } = await import('./journeys/record.js');
    const dir = path.join(root, RECORDINGS_DIR);
    const loaded = await loadJourneyFolder(dir);
    if (loaded.journeys.length === 0) {
      throw new StaysFixedError(
        `You asked for recorded sessions and there are none in ${shortPath(dir)}, so nothing was checked.`,
        {
          hint:
            'Make one: `staysfixed record <a-name-for-it>` opens your product, follows what you do, walks it twice to prove it repeats, and writes it there. ' +
            `${loaded.problems.length > 0 ? `Something is already in that folder and could not be read: ${loaded.problems.join(' ')} ` : ''}` +
            'Or leave --journeys out to use the steps each adapter reads from your source.',
        },
      );
    }
    for (const journey of loaded.journeys) {
      // Said before it is walked, not after it fails. A recording rots quietly: the ids,
      // ports and timestamps captured on the afternoon somebody made it go stale, and the
      // replay then fails for a reason that has nothing to do with the product.
      const willNotReplay = whatWillNotReplay(journey);
      if (willNotReplay.length > 0) {
        gaps.push({
          what: `The recorded session "${journey.name}" may not replay.`,
          why: willNotReplay.join(' '),
          unlockedBy: 'Record it again with `staysfixed record`, or reach the same thing from the code or the test suite, where nothing goes stale.',
          surface: journey.surface,
        });
      }
    }
    for (const problem of loaded.problems) {
      gaps.push({
        what: 'A file in the recordings folder was not walked.',
        why: problem,
        unlockedBy: 'Fix that file, or record the session again. A recording nothing can read is a hole, not a pass.',
      });
    }
    journeys.push(...loaded.journeys);
  }

  if (named) journeys.push(...(await readJourneyFile(path.resolve(root, named))));

  // ---- The project's own test suite.
  //
  // WHY THIS USED TO BE OFF BY DEFAULT, and the reasoning was right as far as it went: this
  // RUNS somebody else's tests — every file twice to harvest, and then every harvested
  // journey twice more on each build — and charging a stranger for that on a command they
  // ran to get a fast answer is how a tool gets uninstalled. So it waited for
  // `--journeys suite`.
  //
  // WHY IT IS NOW ON BY DEFAULT ANYWAY. The cost was measured against the wrong thing. It was
  // weighed against a slower check; it should have been weighed against a WRONG one. Measured
  // 2026-08-31 on a four-line library: two exported functions were rewritten so that every
  // web address the product produces came out different, and the default check answered
  // "Nothing that worked has changed" and exited 0, because no default channel had ever
  // called a function. A flag that is off by default cannot save anybody, and a false
  // all-clear is not a cheaper answer than a slow one — it is the one answer this tool may
  // never give.
  //
  // WHERE THE LINE IS DRAWN, and the measurement that drew it. Default-on is held to a
  // TIGHTER budget than an explicit `--journeys suite`, and to a cap on how many harvested
  // journeys are then walked, so the cost of a check nobody asked to slow down is bounded by
  // construction instead of by a guess about somebody's suite. Measured on this machine on
  // 2026-08-31, with twelve near-empty test files: harvesting them took 3.1 seconds, and the
  // whole check went from 1.4 seconds to 8.2 — about 570ms per test file, and that is the
  // FLOOR, because those tests did nothing. So the automatic path gets 20 seconds of harvest
  // and walks at most 12 of what comes out, which lands a default check at well under half a
  // minute on a project of that shape. Everything the budget or the cap left out is named as
  // a hole with the command that would reach it — never dropped quietly.
  //
  // Asking for it by name still gets the full, uncapped ninety seconds, because somebody who
  // typed `--journeys suite` has said what they are willing to wait for.
  //
  // Loaded here rather than at the top of the file: a copy of this tool without the harvest
  // in it still runs every other kind of check, and saying so is better than failing to start.
  const askedForTheSuite = options.journeys === 'suite';
  let autoSuite = null;
  if (!askedForTheSuite && !named && options.journeys !== 'recorded' && options.journeys !== 'code') {
    autoSuite = await suiteWorthRunningByDefault(root, config);
    if (autoSuite.gap) gaps.push(autoSuite.gap);
  }
  if (askedForTheSuite || autoSuite?.run) {
    const automatic = !askedForTheSuite;
    try {
      const { journeysFromSuite, DEFAULT_HARVEST_BUDGET_MS } = await import('./journeys/index.js');
      // The settings file gets a say in how long this is allowed to take. Left out, the
      // harvest applies its own default, which is why nothing is passed rather than the
      // default being copied to here — see `suiteBudgetFrom`. On the automatic path the
      // tighter budget is used unless the settings ask for something of their own, because a
      // number somebody wrote down beats a number this file guessed.
      const asked = suiteBudgetFrom(config);
      const budgetMs = asked ?? (automatic ? AUTO_HARVEST_BUDGET_MS : null);
      const suiteOptions = {
        ...(budgetMs === null ? {} : { budgetMs }),
        ...(automatic ? { timeoutMs: AUTO_FILE_TIMEOUT_MS } : {}),
      };
      const suite = await journeysFromSuite({
        root,
        surface: options.surface === 'auto' ? undefined : options.surface,
        ...(Object.keys(suiteOptions).length === 0 ? {} : { suite: suiteOptions }),
        // The harvest talks while it works, and it can take most of a minute. Its sentences
        // go into the same stream as everything else rather than nowhere.
        log: (message) => options.events?.emit({ type: 'note', at: options.events.elapsed(), message }),
        signal: options.signal,
      });
      // Said out loud, always, and before the harvest's own findings. A run held to ninety
      // seconds and a run allowed four minutes produce different amounts of coverage, and if
      // the number that decided it is invisible the two runs read as the same run.
      const applied = budgetMs ?? DEFAULT_HARVEST_BUDGET_MS;
      options.events?.emit({
        type: 'note',
        at: options.events.elapsed(),
        message:
          applied === 0
            ? 'The test-suite harvest was given no time budget at all, so every test file was run however long it took. Your settings asked for that with suite.budgetMs: 0.'
            : `The test-suite harvest was held to ${Math.round(applied / 1000)} seconds${
                asked !== null ? ', which your settings asked for' : automatic ? ', which is what an automatic run gets' : ', which is the default'
              }. Anything it did not reach in that time is named below rather than skipped quietly; change it with suite.budgetMs.`,
      });
      // The cap, and only on the automatic path. Somebody who typed the flag gets everything
      // their suite produced. Whoever did not type anything gets a bounded run and a list of
      // exactly which of their test files are therefore not being watched.
      let kept = suite.journeys;
      if (automatic && kept.length > AUTO_HARVEST_JOURNEY_CAP) {
        const dropped = kept.slice(AUTO_HARVEST_JOURNEY_CAP);
        kept = kept.slice(0, AUTO_HARVEST_JOURNEY_CAP);
        gaps.push({
          what: `${dropped.length} of this project's test files were harvested and then not walked, so nothing here says anything about what they cover: ${dropped.map((j) => j.name).join(', ')}.`,
          why: `A check nobody asked to slow down walks at most ${AUTO_HARVEST_JOURNEY_CAP} harvested test files, because each one is run twice on every build and the bill for a big suite would land on somebody who only wanted a quick answer.`,
          unlockedBy: 'Run `staysfixed check --journeys suite` to walk all of them, or narrow the suite to the files that matter.',
        });
      }
      journeys.push(...kept);
      gaps.push(...suite.gaps);
    } catch (e) {
      // A harvest that fell over is a hole, never a pass. Everything else this project has is
      // still walked, and the verdict carries the fact that its tests were not among it.
      gaps.push({
        what: 'Nothing was checked through this project\'s own test suite, because it could not be harvested.',
        why: messageOf(e),
        unlockedBy: 'Run the suite yourself to see what it does, or point the check at a journeys file instead. Nothing your tests can see is being watched until this works.',
      });
    }
  }

  // ---- Calling what a library exports, rather than only reading its labels.
  //
  // See `from-exports.js` for the false all-clear that put this here. In one sentence: a
  // library was checked, shipped, rewritten so that every value it returns came out
  // different, and checked again — and the check passed, because every channel in the tool
  // compared the NAMES and SHAPES of the exports and none of them had ever called one.
  //
  // It costs one extra process per configured module per build, which is the cheapest thing
  // on this page, and it needs nothing configured that is not configured already: `init`
  // writes `process.imports` for every library it sets up.
  if (!named && options.journeys !== 'recorded') {
    const answers = journeysFromExports({ config: config.process });
    journeys.push(...answers.journeys);
    gaps.push(...answers.gaps);
  }

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
    // A journeys file and a recorded session both name exactly what to walk, so no adapter
    // adds journeys of its own on top of them. The source reader is the exception: it runs
    // nothing, it cannot break anything, and it is the only channel that sees a door nobody
    // has ever walked through.
    if (adapter !== sourceAdapter && (named || options.journeys === 'recorded')) continue;
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
        // The count goes on the end when the list was cut. Twelve names with nothing after
        // them read as the whole list, and somebody hunting for a name they mistyped would
        // conclude it is not there — when it is, at number thirteen.
        unlockedBy: `The journeys this project has are: ${journeys.map((j) => j.name).slice(0, 12).join(', ') || 'none'}${journeys.length > 12 ? `, and ${journeys.length - 12} more` : ''}.`,
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

// The pathspec that keeps Stays Fixed's own folder out of "what has changed here" lives in
// rank.js, next to the other reader of the same two git calls. One name, so the fingerprint
// and the distance measure can never disagree about what counts as the agent's edit — they
// did for a fortnight, and only the fingerprint half had been fixed.

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
export async function fingerprintWorkingTree(root, product) {
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
 * What to call a reference build in a sentence: the name a person typed, or its id.
 *
 * @param {BuildFingerprint} reference
 * @param {string} [asked]
 * @returns {string}
 */
function nameOfReference(reference, asked) {
  return asked && asked.trim() !== '' ? `${asked} (${reference.id})` : reference.id;
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
  // A reference cut from a tree with uncommitted changes is filed under a fingerprint of
  // that TREE — an id like `work-76ac0155c8b9`, deliberately not the commit's — because the
  // files that were checked are not the files git has. Exporting the commit and calling it
  // "the old build" walked different code, and everything downstream believed it: an address
  // the record holds a real value for was walked against a build that never had it, the
  // silence was read as proof the address is new, and the reply said "is there now and was
  // not before" about a value sitting in the record on disk. Measured 2026-08-31.
  //
  // Falling back to the stored record is weaker, and the run says so. That is the same choice
  // this tool already makes everywhere the old build cannot be walked, and it is the honest
  // one: a weaker comparison you are told about beats a strong-looking comparison against
  // the wrong build.
  if (reference.dirty === true) return null;
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
 * The project's package.json, and — separately — whether there is one that could not be read.
 *
 * NO PACKAGE.JSON AND A DAMAGED ONE USED TO BE THE SAME NULL, and the difference decides what
 * a product is CALLED. With nothing else naming it, the name falls back to the folder name, so
 * a package.json with a stray comma in it silently renames the product: the store keys every
 * record under the new name, and every record kept under the real one — including the build
 * somebody called working — is orphaned. The run then says, perfectly calmly, that nothing has
 * ever been recorded here.
 *
 * @param {string} root
 * @returns {Promise<{pkg: Record<string, any>|null, damaged: string}>}
 *   `damaged` is empty except when the file is there and unreadable, when it is the sentence
 *   a person gets.
 */
async function packageJson(root) {
  const file = path.join(root, 'package.json');
  /** @type {string} */
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (e) {
    const code = /** @type {{code?: string}} */ (e)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { pkg: null, damaged: '' };
    return { pkg: null, damaged: `${file} is there and could not be read: ${messageOf(e)}` };
  }
  try {
    return { pkg: JSON.parse(raw), damaged: '' };
  } catch (e) {
    return { pkg: null, damaged: `${file} is not readable as JSON: ${messageOf(e)}` };
  }
}

/**
 * @param {string} root
 * @returns {Promise<{name: string|null, damaged: string}>}
 */
async function packageName(root) {
  const { pkg, damaged } = await packageJson(root);
  return { name: typeof pkg?.name === 'string' ? pkg.name : null, damaged };
}

/**
 * @param {string} root
 * @returns {Promise<string|null>}
 */
async function packageVersion(root) {
  const { pkg } = await packageJson(root);
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
