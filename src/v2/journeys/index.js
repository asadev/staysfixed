/**
 * Where the steps come from — gathered, de-duplicated, and labelled with how much each one
 * is worth.
 *
 * A deep check needs journeys. If a person has to write them, the tool is a second job and
 * it gets abandoned in a fortnight, so this folder exists to make sure nobody ever does.
 * The sources are ranked, best first, and the ranking is not a preference — it is a
 * statement about evidence:
 *
 *   code      Read out of the source. Free, exact, and it sees every door there is,
 *             including the ones nobody has opened since they were written.
 *   suite     The project's own tests, run under instrumentation. Somebody already wrote
 *             them, they already walk real paths, and they cost one run to harvest.
 *   recorded  One session somebody actually performed. Real, and narrow, and it goes stale
 *             when the interface moves.
 *   explored  An agent opened one named gap and froze what it found. A fact about one path
 *             an agent happened to take — worth having, never worth confusing with the
 *             three above.
 *
 * Every journey that leaves this file says which of those it came from, because a finding
 * from a `code` journey is a fact about the product and a finding from an `explored` journey
 * is a fact about one path an agent chose, and a reader who cannot tell them apart will
 * eventually trust the wrong one.
 *
 * THE FRONT DOOR RULE. A journey that does not do the same thing twice on the same build is
 * rejected here, at birth, rather than admitted and condemned later as a flake. Version 1
 * learned this the expensive way: a flaky check does not get fixed, it gets ignored, and a
 * tool nobody trusts is worse than no tool because somebody believed it once.
 */

import path from 'node:path';

import { measureWobble } from '../observation.js';
import { journeysFromCode } from './from-routes.js';
import { harvestJourneys } from './from-suite.js';
import { loadJourneyFolder, whatWillNotReplay } from './record.js';

/** @typedef {import('../types.js').Journey} Journey */
/** @typedef {import('../types.js').JourneySource} JourneySource */
/** @typedef {import('../types.js').Surface} Surface */
/** @typedef {import('../types.js').Capture} Capture */
/** @typedef {import('../types.js').BuildFingerprint} BuildFingerprint */
/** @typedef {import('../types.js').CoverageGap} CoverageGap */
/** @typedef {import('../types.js').Channel} Channel */
/** @typedef {import('../adapters/contract.js').Missing} Missing */
/** @typedef {import('../adapters/source.js').Door} Door */

export { journeysFromCode, journeysFromDoors, irreversibility } from './from-routes.js';
export { detectRunner, harvestJourneys, listTestFiles } from './from-suite.js';
export { startRecording, recordSession, saveJourneys, loadJourneys, loadJourneyFolder, redact } from './record.js';

/**
 * A journey with everything this folder knows about where it came from.
 *
 * @typedef {Journey & {
 *   touched?: import('./from-suite.js').Touched,
 *   reproducible?: {how: string, at: string},
 *   replaced?: string[],
 * }} GatheredJourney
 */

// ---------------------------------------------------------------------------
// How much a source is worth
// ---------------------------------------------------------------------------

/** Best first. The order decides which copy survives when two sources describe one journey. */
export const SOURCE_TRUST = /** @type {JourneySource[]} */ (['code', 'suite', 'recorded', 'explored']);

/** One plain sentence per source, for anything that has to explain itself to a reader. */
export const PROVENANCE = Object.freeze({
  code: 'read straight out of the source, so it is exact and it costs nothing — but it only knocks on the door, it does not know what is behind it',
  suite: "harvested from the project's own tests, so it walks real paths with real arguments that somebody already thought about",
  recorded: 'a session somebody actually performed, so it is real — and narrow, and it will go stale when the interface moves',
  explored: 'an agent went looking and froze what it found, so it is one path an agent happened to take rather than a fact about the product',
});

/** What to call each source in the middle of a sentence. */
export const SOURCE_LABEL = Object.freeze({
  code: 'journey read out of the code',
  suite: 'journey harvested from the test suite',
  recorded: 'recorded session',
  explored: 'journey an agent found by exploring',
});

/**
 * @param {JourneySource} source
 * @returns {number} lower is more trustworthy
 */
export function trustOf(source) {
  const index = SOURCE_TRUST.indexOf(source);
  return index === -1 ? SOURCE_TRUST.length : index;
}

// ---------------------------------------------------------------------------
// Is this a usable journey at all?
// ---------------------------------------------------------------------------

const NAME_RULE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * What is wrong with this journey, in plain English. Empty means it is fine.
 *
 * Checked in one place rather than in each producer, so a journey that arrives from a file
 * somebody wrote by hand is held to exactly the same rules as one this tool generated.
 *
 * @param {Journey} journey
 * @returns {string[]}
 */
export function validateJourney(journey) {
  /** @type {string[]} */
  const problems = [];
  if (!journey || typeof journey !== 'object') return ['It is not an object.'];
  if (typeof journey.name !== 'string' || !NAME_RULE.test(journey.name)) {
    problems.push(
      `Its name ("${journey.name}") has to be lowercase letters, numbers and dashes — it becomes a folder name and the head of every address the journey produces.`,
    );
  }
  if (typeof journey.describe !== 'string' || journey.describe.trim() === '') {
    problems.push('It needs one plain sentence saying what it does. That sentence is what an agent reads when this journey finds something.');
  }
  if (!SOURCE_TRUST.includes(journey.source)) {
    problems.push(`It has to say where it came from — one of ${SOURCE_TRUST.join(', ')} — and it says "${journey.source}".`);
  }
  if (typeof journey.surface !== 'string' || journey.surface.trim().length === 0) {
    problems.push('It has to say which surface it runs against.');
  }
  const steps = journey.steps ?? [];
  if (steps.length === 0) {
    problems.push('It has no steps, so walking it would do nothing.');
  } else {
    for (const [index, step] of steps.entries()) {
      if (!step || typeof step.act !== 'string' || step.act.trim() === '') {
        problems.push(`Step ${index + 1} does not say what to do.`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The same journey, twice
// ---------------------------------------------------------------------------

/**
 * What makes two journeys the same journey: the same steps, in the same order.
 *
 * Not the name and not the sentence — those are how it is described. Two sources that
 * generated the same walk through the same doors produced one journey, however differently
 * they chose to name it, and walking it twice would cost twice and prove once.
 *
 * @param {Journey} journey
 * @returns {string}
 */
export function journeyKey(journey) {
  const steps = (journey.steps ?? []).map((step) => {
    /** @type {Record<string, unknown>} */
    const stripped = {};
    for (const key of Object.keys(step).sort()) {
      // `note` and `why` are prose for a reader. Two journeys that differ only in their
      // wording are the same journey.
      if (key === 'note' || key === 'why') continue;
      stripped[key] = /** @type {any} */ (step)[key];
    }
    return stripped;
  });
  return `${journey.surface}::${JSON.stringify(steps)}`;
}

/**
 * Keep one copy of each journey, and say which copies were dropped.
 *
 * The survivor is the one from the most trustworthy source, because that is the one whose
 * findings mean the most — and the names of the ones it replaced ride along on `replaced`,
 * so nothing disappears without a trace.
 *
 * @param {GatheredJourney[]} journeys
 * @returns {{journeys: GatheredJourney[], dropped: {name: string, insteadOf: string, why: string}[]}}
 */
export function dedupeJourneys(journeys) {
  /** @type {Map<string, GatheredJourney>} */
  const best = new Map();
  /** @type {{name: string, insteadOf: string, why: string}[]} */
  const dropped = [];
  /** @type {Set<string>} */
  const namesTaken = new Set();

  for (const journey of journeys) {
    const key = journeyKey(journey);
    const already = best.get(key);
    if (!already) {
      best.set(key, journey);
      continue;
    }
    const winner = trustOf(journey.source) < trustOf(already.source) ? journey : already;
    const loser = winner === journey ? already : journey;
    winner.replaced = [...(winner.replaced ?? []), loser.name];
    best.set(key, winner);
    dropped.push({
      name: loser.name,
      insteadOf: winner.name,
      why: `It walks exactly the same steps, and the copy that was kept came ${PROVENANCE[winner.source]}.`,
    });
  }

  /** @type {GatheredJourney[]} */
  const out = [];
  for (const journey of [...best.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (namesTaken.has(journey.name)) {
      // Two different journeys that chose the same name would land in one folder and
      // overwrite each other's record, which reads afterwards as the product changing.
      let suffix = 2;
      while (namesTaken.has(`${journey.name}-${suffix}`)) suffix++;
      journey.name = `${journey.name}-${suffix}`;
    }
    namesTaken.add(journey.name);
    out.push(journey);
  }
  return { journeys: out, dropped };
}

// ---------------------------------------------------------------------------
// Does it do the same thing twice?
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ReproducibilityResult
 * @property {GatheredJourney[]} kept        Journeys that repeat, or that already proved it.
 * @property {{journey: string, why: string}[]} rejected
 * @property {{journey: string, why: string}[]} unchecked
 *                                            Nothing here could be walked or regenerated, so
 *                                            nothing was proved. Missing evidence, never a pass.
 * @property {string} how                     Plain English: what was actually done.
 */

/**
 * Prove each journey does the same thing twice on the same build — or say plainly that
 * nothing proved it.
 *
 * Three ways, strongest first.
 *   - WALKED. Hand in something that can walk a journey, and each one is walked twice
 *     against the same build. Anything that appears or vanishes between two runs of
 *     identical bytes means the journey does not describe a repeatable thing. Values that
 *     wobble are fine and expected — that is what the wobble measurement is for — but a path
 *     that exists on one run and not the other is a journey arguing with itself.
 *   - REGENERATED. For journeys read out of the code there is a cheaper honest check: run
 *     the generator again and see whether it produces the same journeys. That catches a real
 *     failure — a generator whose output depends on the order a folder was read in — and it
 *     is not the same as walking, so it says which one it did.
 *   - NEITHER. Everything comes back `unchecked`, with the reason. It is not a pass.
 *
 * @param {GatheredJourney[]} journeys
 * @param {object} [opts]
 * @param {(req: {journey: Journey, build: BuildFingerprint, run: 'a'|'b'|'single', which: 'candidate'|'reference'}) => Promise<Capture>} [opts.walk]
 * @param {BuildFingerprint} [opts.build]         Required with `walk`.
 * @param {() => Promise<Journey[]>} [opts.regenerate]
 * @param {(message: string) => void} [opts.log]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<ReproducibilityResult>}
 */
export async function checkReproducible(journeys, opts = {}) {
  /** @type {ReproducibilityResult} */
  const result = { kept: [], rejected: [], unchecked: [], how: '' };
  const log = opts.log ?? (() => {});

  /** @type {Set<string>|null} */
  let regenerated = null;
  if (!opts.walk && opts.regenerate) {
    try {
      regenerated = new Set((await opts.regenerate()).map(journeyKey));
    } catch (error) {
      regenerated = null;
      log(`The journeys could not be generated a second time: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const journey of journeys) {
    if (opts.signal?.aborted) {
      result.unchecked.push({ journey: journey.name, why: 'The check was stopped before this journey was reached.' });
      continue;
    }
    if (journey.reproducible) {
      result.kept.push(journey);
      continue;
    }
    if (opts.walk && opts.build) {
      try {
        const a = await opts.walk({ journey, build: opts.build, run: 'a', which: 'candidate' });
        const b = await opts.walk({ journey, build: opts.build, run: 'b', which: 'candidate' });
        const wobble = measureWobble(a, b);
        const shapeChanged = wobble.entries.filter((entry) => entry.kind !== 'changed');
        if (a.observations.length === 0) {
          result.rejected.push({ journey: journey.name, why: 'Walking it produced nothing at all, so there is nothing it could ever prove.' });
          continue;
        }
        if (shapeChanged.length > 0) {
          const example = shapeChanged[0];
          result.rejected.push({
            journey: journey.name,
            why: `Two walks of the same build disagreed about what exists — "${example.path}" ${example.kind === 'appeared' ? 'turned up only the second time' : 'was there the first time and gone the second'}. A journey that argues with itself cannot say anything about a change.`,
          });
          continue;
        }
        if (wobble.steady === 0) {
          result.rejected.push({
            journey: journey.name,
            why: 'Every single thing it observed came out different on the second walk, so none of it can ever be evidence.',
          });
          continue;
        }
        journey.reproducible = {
          how: `It was walked twice against the same build: ${wobble.steady} of what it observed held still and ${wobble.unstable.length} did not.`,
          at: new Date().toISOString(),
        };
        result.kept.push(journey);
      } catch (error) {
        result.rejected.push({
          journey: journey.name,
          why: `Walking it failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      continue;
    }
    if (regenerated && journey.source === 'code') {
      if (regenerated.has(journeyKey(journey))) {
        journey.reproducible = {
          how: 'The code was read a second time and produced exactly this journey again.',
          at: new Date().toISOString(),
        };
        result.kept.push(journey);
      } else {
        result.rejected.push({
          journey: journey.name,
          why: 'Reading the code a second time produced a different journey, so what it walks depends on something other than the code.',
        });
      }
      continue;
    }
    // Kept, not rejected. Rejection is for a journey PROVED to argue with itself; a journey
    // nobody could check is missing evidence, and throwing those away would leave a project
    // with no walker holding no journeys at all — which looks exactly like a clean run.
    result.kept.push(journey);
    result.unchecked.push({
      journey: journey.name,
      why: journey.source === 'code'
        ? 'Nothing here could walk it, and the code was not read a second time, so whether it does the same thing twice is not known.'
        : `Nothing here could walk it, and a ${SOURCE_LABEL[journey.source]} cannot be generated a second time the way a journey read out of the code can, so whether it does the same thing twice is not known.`,
    });
  }

  result.how = opts.walk
    ? 'Each journey was walked twice against the same build, and anything that disagreed with itself about what exists was rejected.'
    : regenerated
      ? 'The journeys were generated a second time and compared. That proves the generator is steady; it does not prove the product is.'
      : 'Nothing proved these journeys repeat. That is missing evidence, not a pass.';
  return result;
}

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

/**
 * @typedef {object} GatherOptions
 * @property {string} root
 * @property {Surface} [surface]
 * @property {false|Parameters<typeof journeysFromCode>[0]['journeys']} [code]
 *   Journeys read out of the source. On by default: it reads files and runs nothing.
 * @property {false|true|Partial<import('./from-suite.js').HarvestOptions>} [suite]
 *   Journeys harvested from the project's own tests. OFF by default, and deliberately:
 *   harvesting RUNS the suite, which starts processes and takes minutes. Nothing that
 *   expensive should happen because somebody called a function called `gather`. When it is
 *   off, the report says what it would have unlocked.
 * @property {false|{dir?: string, files?: string[]}} [recorded]
 *   Recorded sessions. On by default: it only reads files. Defaults to `.staysfixed/journeys`.
 * @property {Journey[]} [explored]           Journeys an agent produced, handed straight in.
 * @property {boolean} [verify]               Check the code journeys repeat by generating them
 *                                            again. On by default; it costs one more read.
 * @property {(message: string) => void} [log]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} GatherReport
 * @property {Record<JourneySource, number>} bySource   How many journeys each source produced.
 * @property {number} total
 * @property {number} steps
 * @property {number} irreversible          Journeys with a step that must be stopped at the call.
 * @property {{name: string, problems: string[]}[]} invalid
 * @property {{name: string, insteadOf: string, why: string}[]} duplicates
 * @property {{journey: string, why: string}[]} rejected
 * @property {{journey: string, why: string}[]} unchecked
 * @property {string} reproducibility        Plain English: what was actually proved.
 * @property {CoverageGap[]} gaps            Everything not covered, ready to fold into Coverage.
 * @property {Missing[]} missing             What would unlock more, with the command where known.
 * @property {string[]} notes
 * @property {number} durationMs
 */

/**
 * Gather journeys from every source that is available, and report where each one came from.
 *
 * The doors come back alongside the journeys, and that is not a convenience. The coverage
 * ledger is a join between the doors the code reader found and the journeys anything
 * actually walked, and reading the source a second time to get the other half of that join
 * would let the two halves drift: a door added between the two reads would show up as a door
 * nothing covers, when the truth is that nothing had a chance to. One read, both halves.
 *
 * @param {GatherOptions} opts
 * @returns {Promise<{journeys: GatheredJourney[], report: GatherReport, doors: Door[]}>}
 */
export async function gather(opts) {
  const started = Date.now();
  const root = path.resolve(opts.root);
  const log = opts.log ?? (() => {});

  /** @type {GatheredJourney[]} */
  const collected = [];
  /** @type {CoverageGap[]} */
  const gaps = [];
  /** @type {Missing[]} */
  const missing = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {Door[]} */
  let doors = [];
  /** @type {(() => Promise<Journey[]>)|undefined} */
  let regenerate;

  // ---- read the code -------------------------------------------------------
  if (opts.code !== false) {
    log('Reading the doors out of the source.');
    const read = await journeysFromCode({ root, journeys: { surface: opts.surface, ...(opts.code || {}) } });
    collected.push(...read.journeys);
    doors = read.doors;
    for (const left of read.report.left) {
      gaps.push({
        what: left.what,
        why: left.why,
        unlockedBy: 'Nothing needs installing. These are doors this tool cannot knock on from outside, so a journey through the suite or a recorded session is the way to reach them.',
        channel: 'contract',
        doors: left.doors,
      });
    }
    notes.push(
      `The code reader found ${read.report.doors} doors in ${read.report.filesRead} files and turned ${read.report.doorsCovered} of them into ${read.report.journeys} journeys, in ${read.report.readMs}ms, without running anything.`,
    );
    regenerate = async () => {
      const again = await journeysFromCode({ root, journeys: { surface: opts.surface, ...(opts.code || {}) } });
      return again.journeys;
    };
  } else {
    gaps.push({
      what: 'The doors this product opens were never counted.',
      why: 'Reading the code was switched off, so there is no list of routes, exported names, commands and IPC channels to measure coverage against — and without a denominator a clean run means only that nothing anybody walked changed.',
      unlockedBy: 'Leave the code reader on. It reads files, runs nothing, and on Terminal Deck it finishes in under two seconds.',
      channel: 'contract',
    });
  }

  // ---- run the suite -------------------------------------------------------
  if (opts.suite) {
    log("Harvesting journeys from the project's own tests.");
    /** @type {import('./from-suite.js').HarvestOptions} */
    const suiteOptions = {
      surface: opts.surface,
      log: opts.log,
      signal: opts.signal,
      ...(opts.suite === true ? {} : opts.suite),
      // Last on purpose: whatever else a caller asked for, the suite is harvested from the
      // project this gather was pointed at, and nowhere else.
      root,
    };
    const harvest = await harvestJourneys(suiteOptions);
    collected.push(...harvest.journeys);
    gaps.push(...suiteGaps(harvest.report));
    missing.push(...harvest.report.missing);
    notes.push(...harvest.report.notes);
  } else {
    gaps.push({
      what: "The project's own test suite was not harvested, so every path its tests walk is invisible to this check.",
      why: 'Harvesting runs the suite one file at a time, which starts processes and takes minutes, so it never happens unless it is asked for.',
      unlockedBy: 'Ask for it: gather({suite: true}). Every test file that repeats twice becomes a journey nobody had to write.',
    });
  }

  // ---- recorded sessions ---------------------------------------------------
  if (opts.recorded !== false) {
    const dir = opts.recorded?.dir ?? path.join(root, '.staysfixed', 'journeys');
    const loaded = await loadJourneyFolder(dir);
    for (const journey of loaded.journeys) {
      const willNotReplay = whatWillNotReplay(journey);
      if (willNotReplay.length > 0) {
        gaps.push({
          what: `The recorded journey "${journey.name}" may not replay.`,
          why: willNotReplay.join(' '),
          unlockedBy: 'Record it again, or reach the same thing from the code or the test suite, where nothing goes stale.',
        });
      }
      collected.push(journey);
    }
    for (const problem of loaded.problems) notes.push(problem);
    if (loaded.files.length > 0) {
      notes.push(`${loaded.journeys.length} recorded journeys were read from ${loaded.files.length} files in ${path.relative(root, dir) || dir}.`);
    }
  }

  // ---- what an agent explored ---------------------------------------------
  for (const journey of opts.explored ?? []) {
    collected.push({ ...journey, source: 'explored' });
  }

  // ---- clean up ------------------------------------------------------------
  /** @type {{name: string, problems: string[]}[]} */
  const invalid = [];
  /** @type {GatheredJourney[]} */
  const valid = [];
  for (const journey of collected) {
    const problems = validateJourney(journey);
    if (problems.length > 0) invalid.push({ name: journey.name ?? '(no name)', problems });
    else valid.push(journey);
  }
  for (const bad of invalid) {
    gaps.push({
      what: `The journey "${bad.name}" was thrown away before it was walked.`,
      why: bad.problems.join(' '),
      unlockedBy: 'Fix the journey, or the thing that produced it.',
    });
  }

  const deduped = dedupeJourneys(valid);

  // ---- does it repeat? -----------------------------------------------------
  const verified =
    opts.verify === false
      ? { kept: deduped.journeys, rejected: [], unchecked: [], how: 'Nobody asked for the repeat check, so nothing proved these journeys do the same thing twice.' }
      : await checkReproducible(deduped.journeys, { regenerate, log: opts.log, signal: opts.signal });

  if (verified.unchecked.length > 0) {
    gaps.push({
      what: `${verified.unchecked.length} journeys are being used without anything having proved they do the same thing twice.`,
      why: 'Nothing here could walk them, and only journeys read out of the code can be checked by reading it again.',
      unlockedBy: 'Hand gather a way to walk a journey — checkReproducible({walk, build}) — and every one of them gets walked twice before it is used.',
    });
  }
  for (const rejection of verified.rejected) {
    gaps.push({
      what: `The journey "${rejection.journey}" was rejected before it was ever used.`,
      why: rejection.why,
      unlockedBy: 'Nothing to install. A journey that does not repeat has to be made steady, or left out on purpose.',
    });
  }

  /** @type {Record<JourneySource, number>} */
  const bySource = { code: 0, suite: 0, recorded: 0, explored: 0 };
  let steps = 0;
  let irreversible = 0;
  for (const journey of verified.kept) {
    bySource[journey.source] = (bySource[journey.source] ?? 0) + 1;
    steps += journey.steps?.length ?? 0;
    if (journey.irreversible) irreversible++;
  }

  /** @type {GatherReport} */
  const report = {
    bySource,
    total: verified.kept.length,
    steps,
    irreversible,
    invalid,
    duplicates: deduped.dropped,
    rejected: verified.rejected,
    unchecked: verified.unchecked,
    reproducibility: verified.how,
    gaps,
    missing,
    notes,
    durationMs: Date.now() - started,
  };
  return { journeys: verified.kept, report, doors };
}

/**
 * @param {import('./from-suite.js').HarvestReport} report
 * @returns {CoverageGap[]}
 */
function suiteGaps(report) {
  /** @type {CoverageGap[]} */
  const gaps = [];
  for (const rejected of report.rejected) {
    gaps.push({
      what: `The tests in ${rejected.file} are not being used as a journey.`,
      why: rejected.why,
      unlockedBy: 'Nothing to install. Either that file is not repeatable, or it needs something the harvest did not give it.',
    });
  }
  if (report.runner === 'none') {
    gaps.push({
      what: 'No test suite could be harvested.',
      why: report.why,
      unlockedBy: "Point the project at vitest or Node's own test runner, and every test file becomes a journey.",
    });
  }
  if (report.journeys > 0 && !report.touchedMeasured) {
    gaps.push({
      what: 'The harvested journeys do not know which files they touch.',
      why: 'Nothing could measure what the tests exercised, so these journeys cannot say which of the doors in the code they open.',
      unlockedBy: report.missing.find((m) => m.what.includes('coverage'))?.howToGet ?? 'Install the coverage package for the test runner.',
    });
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// Saying it in plain English
// ---------------------------------------------------------------------------

/**
 * What was gathered, said the way it should appear in a summary somebody actually reads.
 *
 * @param {GatherReport} report
 * @returns {string[]} one line each
 */
export function describeGathering(report) {
  /** @type {string[]} */
  const lines = [];
  const parts = SOURCE_TRUST.filter((source) => report.bySource[source] > 0).map(
    (source) => `${report.bySource[source]} ${source === 'code' ? 'from the code' : source === 'suite' ? 'from the test suite' : source === 'recorded' ? 'recorded' : 'found by an agent'}`,
  );
  lines.push(
    report.total === 0
      ? 'No journeys could be gathered, so a check now would prove nothing.'
      : `${report.total} journeys, ${parts.join(', ')} — ${report.steps} steps in all, and nobody wrote any of them.`,
  );
  lines.push(report.reproducibility);
  if (report.rejected.length > 0) {
    lines.push(`${report.rejected.length} were rejected for not doing the same thing twice on the same build.`);
  }
  if (report.unchecked.length > 0) {
    lines.push(`${report.unchecked.length} could not be checked for repeating at all, so nothing is claimed about them.`);
  }
  if (report.duplicates.length > 0) {
    lines.push(`${report.duplicates.length} were the same walk found by two different sources, so only the better-evidenced copy was kept.`);
  }
  if (report.irreversible > 0) {
    lines.push(`${report.irreversible} contain a step that would spend money, send a message or destroy data. Those are watched at the call and stopped there.`);
  }
  if (report.gaps.length > 0) {
    lines.push(`${report.gaps.length} things are not covered by these journeys, and each one says what would fix it.`);
  }
  return lines;
}
