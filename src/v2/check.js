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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { StaysFixedError, messageOf } from '../core/errors.js';
import { findConfigFile, rootForConfig } from '../core/paths.js';
import { sha256 } from '../core/hash.js';

import { openStore, ensureStore, saveBuild, newCaptureId, storeExists } from './store.js';
import { decide, noDecisions, readDecisions, rememberCheck, readCheckRecord } from './escalate.js';
import { sortObservations } from './observation.js';
import { DEFAULT_RULES, machineRules, mergeRules, normaliseCapture, loadRules } from './normalise.js';
import { runCheck, makeCheckEvents } from './run.js';
import { proveCause } from './cause.js';
import { whatChanged } from './rank.js';

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
  try {
    project = await openProject(options);
    const verdict = await runCheck({
      store: project.store,
      product: project.product,
      candidate: project.candidate,
      journeys: project.journeys,
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
    return outcome;
  } catch (e) {
    const outcome = blocked(options, e);
    // A run that never happened still has to reach a person, because "no answer" looks
    // exactly like "nothing changed" from the outside. It is only written down where a
    // store already exists: a check aimed at a folder that was never set up must not leave
    // a folder of its own behind as its parting gesture.
    const store = openStore({ root: projectRootFor(options) });
    if (storeExists(store)) await settle(outcome, store, outcome.product);
    return outcome;
  } finally {
    if (project) await project.close();
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
  if (f.unwaivable === true) out.push('', `This cannot be recorded as intended by anyone: ${f.unwaivableWhy ?? 'a person has to look at it'}.`);
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
 * @property {import('./run.js').Walker} walk
 * @property {(reference: BuildFingerprint, ctx: {events?: CheckEvents, signal?: AbortSignal}) => Promise<LiveBuild|null>} bootReference
 * @property {(capture: Capture) => Capture} normalise
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

  const candidate = await fingerprintWorkingTree(root, product);
  await saveBuild(store, candidate);

  // A name like "HEAD", "v0.13.0" or a branch is what a person types; the store only knows
  // builds. Turning the name into a commit here, and putting that commit in the store, is
  // what lets a check be aimed at any point in history without every commit having been
  // walked before. Without it "HEAD" matches nothing and the check reports itself blocked.
  const reference = options.against ? await fingerprintCommit(root, product, options.against) : null;
  if (reference) await saveBuild(store, reference);

  const journeys = narrowToTarget(await gatherJourneys({ root, config, options }), aim);
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
    walk,
    bootReference,
    normalise,
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
 * @returns {Promise<Journey[]>}
 */
async function gatherJourneys({ root, config, options }) {
  /** @type {Journey[]} */
  const journeys = [];

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
    } catch {
      continue;
    }
    if (!detection.applies) continue;
    if (adapter !== sourceAdapter && named) continue;
    try {
      journeys.push(...(await adapter.journeys(project)));
    } catch {
      // An adapter that cannot list its journeys contributes none. It is not a reason to
      // throw away the ones that could.
    }
  }

  const only = options.only ?? [];
  const chosen = only.length > 0 ? journeys.filter((j) => only.some((n) => j.name === n || j.name.includes(n))) : journeys;

  // Two journeys with one name would write into one another's records.
  /** @type {Journey[]} */
  const out = [];
  const seen = new Set();
  for (const j of chosen) {
    if (seen.has(j.name)) continue;
    seen.add(j.name);
    out.push(j);
  }
  return out;
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
  const diff = (await git(root, ['diff', 'HEAD'])) ?? '';
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard'])) ?? '';
  const dirty = diff.trim() !== '' || untracked.trim() !== '';
  const version = await packageVersion(root);

  /** @type {BuildFingerprint} */
  const build = {
    id: dirty ? `work-${sha256(`${sha ?? ''}\n${diff}\n${untracked}`).slice(0, 12)}` : `git-${(sha ?? 'unknown').slice(0, 12)}`,
    product,
    platform: `${process.platform}-${process.arch}`,
    builtAt: new Date().toISOString(),
  };
  if (sha) build.gitSha = sha;
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
