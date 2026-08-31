/**
 * The loop this whole tool exists to perform.
 *
 * Run the build you just changed TWICE, so the product's own wobble is measured
 * instead of guessed at. Compare what it did against the record of the build you
 * were last happy with. Subtract the wobble arithmetically. Whatever still looks
 * different gets the old build booted for real and walked again, and only what
 * survives that reaches anybody. Then group it, order it, hand back a short list.
 *
 * Everything platform-shaped sits behind one function — `walk` — so this file
 * never learns whether it is looking at a CLI tool, a browser, a desktop app or
 * a phone. The loop is the same on all of them and is worth writing once.
 *
 * Two things this file refuses to do, both on purpose. It never guesses a
 * tolerance: a difference is real or it is wobble, and running twice is what
 * decides. And it never quietly downgrades — when the old build could not be
 * booted, the verdict says so in plain words on every single run, because a
 * weaker check that looks like a strong one is worse than no check at all.
 */

import { createRequire } from 'node:module';

import { makeEvents } from '../core/events.js';
import { StaysFixedError, messageOf } from '../core/errors.js';
import {
  findDuplicatePaths,
  measureWobble,
  mergeWobble,
  unmeasuredWobble,
  subtractWobble,
  sameValue,
  indexByPath,
  wobbleStorm,
} from './observation.js';
// `diffCaptures` is no longer called from here directly. Everything goes through
// `compareAnswers`, which is that same comparison with one rule around it: an address where
// either side holds a refusal is not compared at all. Reaching past it would put the bug of
// 2026-08-31 straight back — two refusals compared equal and a product that could not start
// came back "Nothing that worked has changed".
import { compareAnswers, answeredAnything, isAnswer, refusalsIn, whyNoAnswer } from './refusal.js';
import { ensureStore, saveBuild, saveCapture, latestCapture, loadCapture, referenceFor, listBuilds } from './store.js';
import { describeRuleChange } from './normalise.js';
import { currentReference } from './reference.js';
import { clusterDifferences } from './cluster.js';
import { rankFindings } from './rank.js';

const require = createRequire(import.meta.url);

/** Read off package.json so what a verdict claims about itself can never drift from what shipped. */
const VERSION = /** @type {{version?: string}} */ (require('../../package.json')).version ?? '0.0.0';

/** @typedef {import('./types.js').Store} Store */
/** @typedef {import('./types.js').Capture} Capture */
/** @typedef {import('./types.js').CaptureRun} CaptureRun */
/** @typedef {import('./types.js').Observation} Observation */
/** @typedef {import('./types.js').Journey} Journey */
/** @typedef {import('./types.js').BuildFingerprint} BuildFingerprint */
/** @typedef {import('./types.js').Difference} Difference */
/** @typedef {import('./types.js').Finding} Finding */
/** @typedef {import('./types.js').Verdict} Verdict */
/** @typedef {import('./types.js').Wobble} Wobble */
/** @typedef {import('./types.js').WobbleEntry} WobbleEntry */
/** @typedef {import('./types.js').Coverage} Coverage */
/** @typedef {import('./types.js').CoverageGap} CoverageGap */
/** @typedef {import('./types.js').Channel} Channel */

// ---------------------------------------------------------------------------
// The one door between this loop and every platform
// ---------------------------------------------------------------------------

/**
 * The old build, built and running, ready to be walked.
 *
 * @typedef {object} LiveBuild
 * @property {BuildFingerprint} build
 * @property {string} [dir]                  A checkout it was built from, if any.
 * @property {() => Promise<void>} release   Always called, including when the run throws.
 * @property {string} [why]                  Anything the summary should say about it.
 */

/**
 * One request to walk one journey against one build.
 *
 * @typedef {object} WalkRequest
 * @property {Journey} journey
 * @property {BuildFingerprint} build
 * @property {CaptureRun} run          'a' and 'b' are the two passes of the same build.
 * @property {'candidate'|'reference'} which
 * @property {LiveBuild} [live]        Present when the reference has been booted.
 * @property {string} [dir]            A checkout to build and run from instead of the
 *                                     working tree. The causal proof uses this.
 * @property {CheckEvents} [events]
 * @property {AbortSignal} [signal]
 */

/**
 * Walk one journey and flatten everything seen to path and value.
 *
 * Everything platform-specific lives behind this signature: a child process for
 * a CLI, Playwright for the web, the CDP driver for Electron, a simulator for a
 * phone. It must never refuse to come back — a journey that broke returns a
 * capture whose coverage says so, because a thrown error loses the other
 * journeys' work.
 *
 * @typedef {(req: WalkRequest) => Promise<Capture>} Walker
 */

/**
 * What a check needs to run.
 *
 * @typedef {object} CheckRun
 * @property {Store} store
 * @property {string} product              One repo can build five products. This names one.
 * @property {BuildFingerprint} candidate  The build you just made.
 * @property {Journey[]} journeys
 * @property {CoverageGap[]} [gaps]      Holes found before any journey ran — an adapter that
 *                                       fell over while listing what it would walk, a name
 *                                       that matched nothing. They belong in the coverage.
 * @property {Walker} walk
 * @property {string} cwd                  Project root — where the working diff is read.
 * @property {(candidate: BuildFingerprint, ctx: {events?: CheckEvents, signal?: AbortSignal}) => Promise<LiveBuild|null>} [bootReference]
 *   Build and boot the reference build so it can be walked live. Absent, or
 *   answering null, means the run falls back to the stored record and says so.
 * @property {string} [against]            A marker, tag, version or commit naming the
 *                                         reference instead of the stored pointer.
 * @property {boolean} [paired]            Boot the old build live from the start.
 * @property {boolean} [storedOnly]        Never boot the old build, not even to prove a suspicion.
 * @property {boolean} [remember]          Default true: keep this run's captures for next time.
 * @property {string[]} [guards]           Guard names, so a difference touching one is sealed.
 * @property {(capture: Capture) => Capture} [normalise]  The rules from normalise.js, already bound.
 * @property {CheckEvents} [events]
 * @property {AbortSignal} [signal]
 */

/**
 * The v1 event stream, carrying v2's vocabulary.
 *
 * @typedef {object} CheckEvent
 * @property {'check:start'|'reference'|'journey:start'|'journey:done'|'wobble'|'suspicion'|'proof:start'|'proof:done'|'cluster'|'note'|'check:done'} type
 * @property {number} at
 * @property {string} [message]   Always plain English. This is the line a person reads.
 * @property {string} [journey]
 * @property {string} [run]
 * @property {number} [count]
 * @property {number} [steady]    Only on 'wobble'. Addresses this build answered the same
 *                                way twice, counted rather than inferred by subtraction.
 * @property {boolean} [measured] Only on 'wobble'. False when the wobble was never taken,
 *                                which is not the same as a wobble of nothing.
 * @property {number} [durationMs]
 * @property {Verdict} [verdict]
 */

/**
 * @typedef {object} CheckEvents
 * @property {(event: CheckEvent) => void} emit
 * @property {(listener: (event: CheckEvent) => void) => () => void} on
 * @property {() => number} elapsed
 * @property {() => CheckEvent[]} history
 */

/**
 * A stream for one check.
 *
 * It is v1's stream underneath, deliberately. The two rules that make it worth
 * having — a late listener is handed everything it missed, and a listener that
 * throws can never take the run down — are already written and already tested,
 * and a second copy would only be a second thing to get wrong.
 *
 * @returns {CheckEvents}
 */
export function makeCheckEvents() {
  return /** @type {CheckEvents} */ (/** @type {unknown} */ (makeEvents()));
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Prove that nothing which already worked has changed.
 *
 * @param {CheckRun} opts
 * @returns {Promise<Verdict>}
 */
export async function runCheck(opts) {
  const startedAt = new Date();
  const started = Date.now();
  const events = opts.events ?? makeCheckEvents();
  /** @param {CheckEvent} e */
  const say = (e) => events.emit(e);
  const stop = () => {
    if (opts.signal?.aborted) throw new StaysFixedError('The check was stopped before it finished.');
  };

  const journeys = (opts.journeys ?? []).filter((j) => !j.skip);
  /** @type {CoverageGap[]} */
  const gaps = [...(opts.gaps ?? [])];
  for (const skipped of (opts.journeys ?? []).filter((j) => j.skip)) {
    // A switched-off journey is missing coverage, never a pass. Anything else
    // lets a product go quiet by having its checks turned off one at a time.
    gaps.push({
      what: `The journey "${skipped.describe || skipped.name}" was not walked.`,
      why: skipped.skip || 'It is switched off in the journeys file.',
      unlockedBy: 'Switch it back on, or delete it if it is no longer true of the product.',
      surface: skipped.surface,
    });
  }
  if (journeys.length === 0) {
    throw new StaysFixedError('There are no journeys to walk, so there is nothing this check could prove.', {
      hint: 'Point it at your test suite with --journeys suite, or read the doors out of the source with --journeys code.',
    });
  }

  say({ type: 'check:start', at: 0, message: 'Checking that nothing which already worked has changed.' });

  await ensureStore(opts.store);

  // 1 — what counts as working.
  const reference = await resolveReference(opts.store, opts.product, opts.against);

  // WHICH captures of the reference build are the record.
  //
  // The store keeps every capture a build ever produced, and the reader took the NEWEST of
  // them. So the moment somebody checked out the old commit and ran a check, the record the
  // whole comparison rests on quietly moved to whatever that run happened to see. Only `ship`
  // may decide what "working" means, and a record that drifts on its own is that rule leaking.
  // The two captures blessed at ship time are already written down beside the cut; they are
  // used when they are still there, and the newest is the fallback for a reference cut before
  // this was recorded. Found by the identical-runs lane, 2026-08-31.
  const blessedRuns = await blessedCapturePairs(opts.store, opts.product, reference);
  say({
    type: 'reference',
    at: events.elapsed(),
    message: reference
      ? `Comparing against ${nameOf(reference)}.`
      : 'There is no build on record as working yet, so there is nothing to compare against.',
  });
  stop();

  /** @type {LiveBuild|null} */
  let live = null;
  try {
    // 2 — the same build, twice. This is the wobble measurement, not a retry.
    if (opts.paired === true && reference) {
      live = await bootReference(opts, reference, events);
      if (!live) {
        throw new StaysFixedError(`A paired run was asked for, but ${nameOf(reference)} cannot be built here.`, {
          hint: 'Run without --paired to compare against the stored record instead.',
        });
      }
    }

    /** @type {Map<string, {a: Capture, b: Capture, wobble: Wobble}>} */
    const walked = new Map();
    /** @type {Map<string, Capture>} */
    const before = new Map();
    // Counted rather than inferred. Both the live build and the stored record carry the SAME
    // build id — they are two ways of looking at one build — so nothing about a capture in
    // `before` says which of the two it came from, and the mode has to be recorded as it
    // happens or not at all.
    let liveWalks = 0;
    // Which journeys really got compared against the old build, by either road. An empty
    // `before` used to produce an empty difference list, which produced no findings, which
    // produced "Nothing that worked has changed" — the tool's all-clear sentence, said about
    // a run in which nothing was compared with anything. Counted here so the two can never
    // come out of the same exit again.
    /** @type {string[]} */
    const comparedJourneys = [];
    /** @type {Wobble[]} */
    const wobbles = [];
    /** @type {Wobble[]} */
    const referenceWobbles = [];
    /** @type {string[]} */
    const steadyInReference = [];
    let referenceWobbleMeasured = true;
    // One fact about one pair of rule sets, gathered here and said once at the end.
    /** @type {Set<string>} */
    const rulesMoved = new Set();
    /** @type {string[]} */
    const rulesMovedOn = [];

    for (const journey of journeys) {
      stop();
      say({ type: 'journey:start', at: events.elapsed(), journey: journey.name, message: `Walking ${journey.describe || journey.name}.` });

      const a = await walkOnce(opts, journey, opts.candidate, 'a', 'candidate', undefined, events);
      gaps.push(...duplicateGaps(a.observations, journey));
      const b = await walkOnce(opts, journey, opts.candidate, 'b', 'candidate', undefined, events);
      // The second pass too. A collision that only happens on the second run still eats a
      // fact — the wobble measurement indexes by path exactly the same way — and only the
      // first pass was ever checked.
      gaps.push(...duplicateGaps(b.observations, journey, 'on the second run of the new build'));
      const wobble = measureWobble(a, b);
      walked.set(journey.name, { a, b, wobble });
      wobbles.push(wobble);
      // Per journey, not only over the whole run. The share is worked out again at the end
      // across everything, and one journey that threw its whole comparison away hides inside
      // nine that did not: ten journeys, one of them stormy, and the merged share never gets
      // near half. That journey's answer is gone all the same, and this is where it is said.
      // A journey that came back with nothing at all. It IS in `walked`, so the "produced
      // nothing" check at the end never fires for it; it compares an empty list against an
      // empty list, finds no differences, and counts as a journey that was walked. An
      // adapter that started, found nothing to look at and returned politely is exactly how
      // a whole surface goes dark without one sentence being written about it.
      if (a.observations.length === 0) {
        gaps.push({
          what: `"${journey.describe || journey.name}" was walked and came back with nothing at all to look at.`,
          why:
            `${a.note ?? 'The adapter that drives this ran and produced no observations.'} ` +
            'An empty walk compares to an empty walk and finds no differences, which is not the same as there being none.',
          unlockedBy: 'Run this journey on its own to see what it does. If the product really has nothing to observe here, the journey is not covering anything and should say so or go.',
          surface: journey.surface,
        });
      }
      const weather = wobbleStorm(wobble);
      if (weather.stormy) {
        gaps.push({
          what: `"${journey.describe || journey.name}" could not be compared: the new build did not answer it the same way twice.`,
          why: weather.why,
          unlockedBy: 'Run it again on a quiet machine. If it happens twice, something in the product does not survive being started a second time.',
          surface: journey.surface,
        });
      }
      // ADDRESSES, not rows. This used to send `a.observations.length`, which counts every
      // observation the adapter wrote down — and two observations at the SAME address are one
      // address written down twice, not two addresses. Every other number on the page is
      // counted by address: `foldCoverage` builds a Set, and the wobble arithmetic indexes by
      // path. So a walk with two duplicate addresses put "18 addresses watched" in the header
      // beside "14 addresses watched" in the coverage ledger and "18 answered the same way
      // twice" for a build that only ever had 14 addresses to answer at. Three numbers about
      // one run, disagreeing, on a page whose entire job is being believed. The duplicates
      // themselves are not swallowed — `duplicateGaps` above reports each one.
      const addresses = new Set(a.observations.map((o) => o.path)).size;
      say({
        type: 'journey:done',
        at: events.elapsed(),
        journey: journey.name,
        count: addresses,
        message: `${addresses} ${plural(addresses, 'thing', 'things')} looked at, ${wobble.unstable.length} of which this build cannot answer the same way twice.`,
      });

      if (!reference) continue;

      // 3 — what the old build did. Live if we booted it, otherwise the record
      // it left the last time it ran.
      if (live) {
        // The old build is walked TWICE as well, for one reason that is worth the
        // extra run: without knowing what the old build could not answer the same
        // way twice, "your change made this unpredictable" cannot be said at all.
        // Walking it once leaves the sharpest finding this tool has permanently
        // switched off, and nothing in the output would say so.
        const wasA = await walkOnce(opts, journey, live.build, 'a', 'reference', live, events);
        const wasB = await walkOnce(opts, journey, live.build, 'b', 'reference', live, events);
        // The old build being ON this machine is not the same as the old build having been
        // WALKED. When every observation it came back with is a hole, it was not walked, and
        // treating that as the reference makes the whole product look newly invented: every
        // address in the new build has nothing opposite it, so every one of them 'appeared'.
        //
        // Measured on Terminal Deck's Android app on 2026-08-30. `--paired` exports the old
        // commit with `git archive`; an APK is a build output and is gitignored, so the export
        // has no app in it; the adapter honestly reported one hole per journey; and the run
        // came back with seventeen sealed escalations claiming the sign-in screen and every
        // permission had appeared out of nowhere, with nothing anywhere saying the old build
        // had never run. Falling back to the stored record here is weaker and says so, which
        // is the whole difference between a weaker answer and a wrong one.
        if (wasA.observations.some((o) => o.meta?.refused !== true)) {
          before.set(journey.name, wasA);
          comparedJourneys.push(journey.name);
          gaps.push(...duplicateGaps(wasA.observations, journey, 'while walking the old build'));
          referenceWobbles.push(measureWobble(wasA, wasB));
          liveWalks += 1;
          continue;
        }
        gaps.push({
          what: `The old build could not be walked for "${journey.describe || journey.name}", so this was not a paired comparison after all.`,
          why:
            `${nameOf(reference)} was put back on this machine, and then there was nothing there to run: ${whyNothingRan(wasA)} ` +
            'This usually means the product is BUILT rather than committed — an APK, a .app, a packaged desktop app — and a checkout of the old commit does not contain one.',
          unlockedBy:
            'Build the old commit before the run, or point the settings at a kept copy of the old build\'s artifact. Until then this journey falls back to the record the old build left last time.',
          surface: journey.surface,
        });
      }
      const stored = await storedReference(opts.store, reference.id, journey.name, blessedRuns.get(journey.name));
      for (const problem of stored.problems) {
        gaps.push({
          what: `Part of the old build's record of "${journey.describe || journey.name}" could not be read.`,
          why: problem,
          unlockedBy: 'Run a paired check, which walks the old build live rather than reading a record, or ship again to cut a fresh reference.',
          surface: journey.surface,
        });
      }
      if (!stored.capture) {
        gaps.push({
          what: `The journey "${journey.describe || journey.name}" has never been walked against ${nameOf(reference)}.`,
          why: 'There is no stored record of the old build doing this, so there is nothing to compare against.',
          unlockedBy: 'Run a paired check once, or ship again with the journey in place.',
          surface: journey.surface,
        });
        continue;
      }
      before.set(journey.name, stored.capture);
      comparedJourneys.push(journey.name);
      gaps.push(...duplicateGaps(stored.capture.observations, journey, 'in the stored record of the old build'));
      // A torn record of the old build is missing addresses, and every one of them reads as
      // an address that has just APPEARED in the new build. The candidate's own torn captures
      // were already reported; the reference's never were, and it is the side whose absences
      // turn into findings.
      if (stored.capture.complete === false) {
        gaps.push({
          what: `The stored record of "${journey.describe || journey.name}" against ${nameOf(reference)} was read back torn.`,
          why: `${stored.capture.note ?? 'The run that wrote it stopped partway.'} Part of what the old build did is missing from it, so anything in that part looks like something the new build has just invented.`,
          unlockedBy: 'Run a paired check, which walks the old build live instead of trusting the record, or ship again to cut a fresh reference.',
          surface: journey.surface,
        });
      }
      // The rules stamp exists so a run can notice this, and until 2026-08-30 nothing ever
      // read it. A stored capture normalised under one set of rules compared against a fresh
      // one normalised under another produces differences that are about the RULES — either a
      // wall of noise that reads like a regression, or, when the change was to add a rule,
      // quiet where there should not be any. Either way the reader has to be told.
      //
      // WHAT changed, not two hashes. This used to print "v1-fcf4b8000217 versus
      // v1-29141a9ec069" and nothing else, which tells an agent nothing it can act on, so it
      // acts on nothing. `describeRuleChange` owns the judgement — a rule that rewrites
      // something differently makes the whole comparison suspect; a rule that merely reaches
      // one more address makes only that address suspect and names it; and a record older
      // than the scope stamp says so rather than reporting every glob as new.
      //
      // ONCE PER RUN, not once per journey. It is one fact about one pair of rule sets, and
      // it was being written out again for every journey — four identical paragraphs in the
      // coverage list on a four-journey project, on every run, saying the same thing. The
      // coverage list is the one section that must never be skimmed, and nothing teaches a
      // reader to skim it faster than a block that is always there and always the same.
      const ruleChange = describeRuleChange(
        { fingerprint: stored.capture.rules, scope: stored.capture.rulesScope },
        { fingerprint: a.rules, scope: a.rulesScope },
      );
      if (!ruleChange.same) {
        rulesMoved.add(ruleChange.say);
        rulesMovedOn.push(journey.describe || journey.name);
      }
      if (stored.wobble) steadyInReference.push(...steadyPaths(stored.capture, stored.wobble));
      else referenceWobbleMeasured = false;
    }

    if (rulesMovedOn.length > 0) {
      const which =
        rulesMovedOn.length === 1
          ? `"${rulesMovedOn[0]}" is`
          : `${rulesMovedOn.length} journeys are`;
      gaps.push({
        what: `${which} being compared across a change to the normalisation rules.`,
        why: [...rulesMoved].join(' '),
        unlockedBy: 'Run a paired check, which walks the old build live under today\'s rules, or ship again to cut a fresh reference.',
      });
    }

    stop();
    // Booting the old build is not the same as having walked it. When every live walk came
    // back holes-only — a built artifact that no checkout of the old commit contains — the
    // run falls back to the stored record, and calling that a paired run would be the
    // report's single most misleading sentence. See the gap pushed in the walk loop.
    const walkedLive = liveWalks > 0;
    const mode = /** @type {'paired'|'stored-record'} */ (walkedLive ? 'paired' : 'stored-record');
    const wobble = wobbles.length > 0 ? mergeWobble(wobbles) : unmeasuredWobble(opts.candidate.id, '*');
    // `steady` and `measured` are sent because they were MEASURED here, and nothing
    // downstream can work them out. Anything drawing this event had to guess steady as
    // "everything watched, minus the unstable ones" — a subtraction across two different
    // populations, so it reported addresses as having answered the same way twice when the
    // build had never been asked at them. And `measured: false` is the difference between a
    // build that wobbled about nothing and a build whose wobble was never taken; two noughts
    // cannot tell those apart, and only the first one is good news.
    say({
      type: 'wobble',
      at: events.elapsed(),
      count: wobble.unstable.length,
      steady: wobble.steady,
      measured: wobble.measured,
      message:
        wobble.unstable.length === 0
          ? 'This build gives the same answer twice, everywhere.'
          : `${wobble.unstable.length} ${plural(wobble.unstable.length, 'address', 'addresses')} this build cannot answer the same way twice. Subtracted, not counted.`,
    });

    // Things the closing paragraph owes the reader that are not findings and not coverage.
    // The paragraph is what a person reads and what an agent quotes; a fact that only lands
    // in the gap list is a fact most readers will never meet.
    /** @type {string[]} */
    const runNotes = [];
    const kept = await remember(opts, walked);
    if (kept.why) {
      runNotes.push(
        `WHAT THIS RUN SAW WAS NOT SAVED: ${kept.why} The answer here still stands — everything was walked and compared — but nothing reached the disk, so the next check will report these journeys as never having been walked.`,
      );
      gaps.push({
        what: 'What this run saw was NOT saved, so the next run has nothing from today to compare against.',
        why: `${kept.why} The answer below is still good — everything was walked and compared — but none of it reached the disk, so the next check will report these journeys as never having been walked.`,
        unlockedBy: 'Free some disk space, or fix the permissions on the .staysfixed folder, and run the check again.',
      });
      say({ type: 'note', at: events.elapsed(), message: `This run could not be saved. ${kept.why}` });
    }

    // Nothing on record to compare against. That is the cold start on any
    // product that has not been shipped once with the hook in place, and it is
    // not a failure — but it must never look like a pass either.
    if (!reference) {
      return finish(opts, {
        ok: true,
        mode: 'stored-record',
        modeWarning: NO_REFERENCE_WARNING,
        reference: emptyFingerprint(opts.product),
        findings: [],
        real: 0,
        noise: 0,
        newlyUnstable: [],
        coverage: foldCoverage(walked, journeys, gaps),
        summary: [
          `Nothing to compare against yet: no build of ${opts.product} is on record as working.`,
          // "This run has been kept" was said unconditionally, including on the runs where
          // it had not been. On a cold start that sentence is the entire value of the run.
          kept.kept
            ? 'This run has been kept, so the next one has something to measure against.'
            : opts.remember === false
              ? 'It was not asked to keep this run, so the next one will start from nothing as well.'
              : 'AND IT COULD NOT BE KEPT, so the next run will start from nothing as well.',
          NO_REFERENCE_WARNING,
          ...runNotes,
        ].join(' '),
        startedAt,
        started,
        events,
      });
    }

    // There IS a build on record as working, and not one journey could be put beside it.
    //
    // Every road out of the loop above that fails — the old build had no record for this
    // journey, or it was booted and there was nothing in it to run — ends in `continue`, and
    // an empty `before` map makes an empty difference list, no findings, ok: true, and the
    // sentence "Nothing that worked has changed." That sentence is this tool's whole promise
    // and it was being said about a run that compared nothing with anything. It is the same
    // shape as the wobble storm: not a pass, not a failure, no answer.
    if (comparedJourneys.length === 0) {
      const why =
        `NO ANSWER FROM THIS RUN. None of the ${journeys.length} ${plural(journeys.length, 'journey', 'journeys')} could be put beside ${nameOf(reference)}: ` +
        `there is no record of the old build doing any of them, and it could not be booted and walked either. ` +
        `Nothing was compared with anything, so this run says nothing at all about whether the product still works — which is not the same as it being fine. ` +
        `The coverage list below names each journey and what is missing for it.`;
      gaps.push({
        what: 'Nothing at all was compared on this run.',
        why: `${journeys.length} ${plural(journeys.length, 'journey was', 'journeys were')} walked against the new build, and none of them had anything on the old build's side to be compared against.`,
        unlockedBy: 'Run a paired check so the old build is built and walked here, or ship once with the reference hook in place so a record exists.',
      });
      return finish(opts, {
        ok: false,
        mode,
        modeWarning: modeWarning(mode, walkedLive, reference),
        reference,
        findings: [],
        real: 0,
        noise: 0,
        newlyUnstable: [],
        coverage: foldCoverage(walked, journeys, gaps),
        summary: [why, ...runNotes].join(' '),
        startedAt,
        started,
        events,
      });
    }

    // 4 — compare, then subtract the noise.
    /** @type {Difference[]} */
    const raw = [];
    // The addresses that really were put side by side. `wobble.steady` used to stand in for
    // this in the closing sentence, and it is a different number: it counts what the NEW
    // build answered the same way twice, whether or not the old build had anything to say
    // about it. On a run where nine journeys of ten had no record, the summary still quoted
    // every address the new build produced and read like a full comparison.
    /** @type {Set<string>} */
    const comparedAddresses = new Set();
    // Addresses that could not be put side by side because one side of them is a refusal.
    // Until 2026-08-31 there was no such list: a refusal was a value like any other, so two
    // of them compared EQUAL and vanished into the silence that this tool reads as "nothing
    // changed", while a refusal opposite a real value came back as a difference nobody
    // caused. Both are now counted here and neither is a finding.
    /** @type {import('./refusal.js').Uncompared[]} */
    const uncompared = [];
    // The same thing one level up: a whole walk that never got the product to say anything.
    /** @type {string[]} */
    const standardHasNoRecordOf = [];
    /** @type {{journey: string, why: string}[]} */
    const thisBuildWouldNotAnswer = [];
    for (const journey of journeys) {
      const was = before.get(journey.name);
      const is = walked.get(journey.name);
      if (!was || !is) continue;

      // A WALK THAT ONLY EVER MET A REFUSAL IS NOT A SIDE OF A COMPARISON.
      //
      // Handled here as a whole rather than address by address because that is the shape it
      // has. When the old build's record of a journey is nothing but refusals, EVERY address
      // this build now answers at has nothing opposite it, so every one of them reports as
      // having appeared out of nowhere: four findings on a two-journey fixture, thirteen on a
      // three-route server, and the ones whose names say money or signing in land in a class
      // no agent may wave through — so a phantom goes to a person and stays there. And the
      // other way round is worse, not better: when THIS build is the one that would not
      // answer, every address the old build had reports as vanished, and the real news — the
      // product does not start — is nowhere in a list of forty findings. One sentence each,
      // in the coverage list, is the honest form of both.
      const standardAnswered = answeredAnything(was);
      const thisBuildAnswered = answeredAnything(is.a);
      if (!standardAnswered || !thisBuildAnswered) {
        const name = journey.describe || journey.name;
        if (!standardAnswered) standardHasNoRecordOf.push(name);
        if (!thisBuildAnswered) {
          const first = refusalsIn(is.a)[0];
          thisBuildWouldNotAnswer.push({
            journey: name,
            why: first ? whyNoAnswer(first.value, first) : 'nothing it was asked answered.',
          });
        }
        continue;
      }

      const compared = compareAnswers(was, is.a);
      // Counted over answers only. The number goes into the closing sentence as "N addresses
      // checked", and an address holding a refusal was never checked at anything.
      for (const o of was.observations) if (isAnswer(o.value)) comparedAddresses.add(`${journey.name} ${o.path}`);
      for (const o of is.a.observations) if (isAnswer(o.value)) comparedAddresses.add(`${journey.name} ${o.path}`);
      raw.push(...compared.differences);
      uncompared.push(...compared.uncompared);
    }

    // What the refusals cost, said in the coverage list where nothing is allowed to be
    // skimmed past. Grouped by journey and by which side was missing, because one line per
    // address on a product with a dead surface is a wall nobody reads.
    const lost = uncompared.filter((u) => u.kind === 'lost');
    const recovered = uncompared.filter((u) => u.kind === 'recovered');
    const neverAnswered = uncompared.filter((u) => u.kind === 'never-answered');
    for (const [kind, list] of /** @type {const} */ ([['lost', lost], ['recovered', recovered], ['never-answered', neverAnswered]])) {
      if (list.length === 0) continue;
      const names = unique(list.map((u) => u.journey ?? '')).filter(Boolean);
      const where = names.length > 0 ? ` in ${names.slice(0, 4).join(', ')}${names.length > 4 ? ', and more' : ''}` : '';
      const some = list.slice(0, 4).map((u) => u.path).join(', ');
      const andMore = list.length > 4 ? `, and ${list.length - 4} more` : '';
      if (kind === 'lost') {
        gaps.push({
          what: `${list.length} ${plural(list.length, 'address', 'addresses')} the old build answers at could not be answered by this build${where}, so ${plural(list.length, 'it was', 'they were')} not compared: ${some}${andMore}.`,
          why: `${list[0].why} An address that used to be checked and cannot be now is coverage this build has taken away. It is not reported as a difference, because there is no answer here to differ from — but it is not a pass either.`,
          unlockedBy: 'Get the product answering there again and run the check. Until then nothing about those addresses is being watched.',
        });
      } else if (kind === 'recovered') {
        gaps.push({
          what: `${list.length} ${plural(list.length, 'address', 'addresses')} this build answers at ${plural(list.length, 'has', 'have')} no answer in the standard${where}, so ${plural(list.length, 'it was', 'they were')} not compared: ${some}${andMore}.`,
          why: `The build on record as working never answered here — ${list[0].why} There is nothing to hold today's answer against, so this is new coverage rather than a change. It used to arrive as a difference nobody caused.`,
          unlockedBy: 'Ship once from a run that saw these, and from then on they are part of what "working" means and are compared like everything else.',
        });
      } else {
        gaps.push({
          what: `${list.length} ${plural(list.length, 'address', 'addresses')} answered on neither build${where}, so nothing was compared there: ${some}${andMore}.`,
          why: `${list[0].why} Two refusals used to compare equal, which read exactly like two matching answers and counted towards "nothing has changed". They are counted here instead.`,
          unlockedBy: 'Make the product answerable there — supply what the adapter said was missing — and these start being watched.',
        });
      }
    }
    if (standardHasNoRecordOf.length > 0) {
      gaps.push({
        what: `${standardHasNoRecordOf.length} ${plural(standardHasNoRecordOf.length, 'journey', 'journeys')} could not be compared, because the build on record as working never got the product to do anything there: ${standardHasNoRecordOf.join(', ')}.`,
        why: 'Everything this build did on those journeys is new coverage, not a change: there is nothing on the old build\'s side of it. Reported as findings until 2026-08-31, which is how a product that started working came back as a pile of regressions nobody had caused.',
        unlockedBy: 'Ship once from a run in which these journeys actually ran, and they become part of what "working" means.',
      });
    }
    for (const dead of thisBuildWouldNotAnswer) {
      gaps.push({
        what: `"${dead.journey}" was not compared: this build never got the product to do anything there.`,
        why: `${dead.why} The old build has a record of what this journey does and this build has none, so there is nothing to compare — which is not the same as nothing having changed, and is not a pass.`,
        unlockedBy: 'Run that one journey on its own and see what stops it. Nothing behind it is being watched until it runs.',
      });
    }
    // The two build ids, because whether they are the SAME build decides whether any of this
    // can be a change at all. When nothing has been edited they match, the stored record of
    // "the old build" is the previous check's own run out of that build's folder, and every
    // flicker between the two runs used to be reported as a change nobody asked for. See the
    // long note on subtractWobble: it files them as this build arguing with itself instead.
    const subtraction = subtractWobble(raw, wobble, {
      referenceWobble: referenceWobbles.length > 0 ? mergeWobble(referenceWobbles) : undefined,
      steadyInReference: referenceWobbleMeasured && steadyInReference.length > 0 ? steadyInReference : undefined,
      referenceBuildId: reference.id,
      candidateBuildId: opts.candidate.id,
    });
    say({
      type: 'suspicion',
      at: events.elapsed(),
      count: subtraction.real.length,
      message: subtraction.note,
    });
    // A wobble big enough to swallow the comparison is not a result. It is recorded as a hole
    // here and it takes the verdict down at the bottom of this function, because the one thing
    // that must never come out of it is a clean sentence resting on a subtraction that removed
    // most of what was looked at.
    if (subtraction.couldNotTell === true) {
      gaps.push({
        what: 'This run could not tell you anything, because the new build did not answer the same way twice.',
        why: subtraction.couldNotTellWhy ?? 'Most of the addresses it was asked about were unsteady, so almost everything was dropped before it was compared.',
        unlockedBy: 'Run it again when the machine is quiet. If it happens twice, look at what the product does differently on a second start.',
      });
    }
    stop();

    // 5 — expensive proof, only where it is owed. Everything the live old build
    // does too is dropped silently and counted. That silence is the point: it is
    // what keeps this list short enough to read every word of.
    let survivors = subtraction.real;
    let provedLive = walkedLive;
    // How many suspicions the old build turned out to have as well. Naming this
    // number is what makes the short list believable: it says how much work the
    // expensive half did rather than leaving the reader to assume it did none.
    let dropped = 0;
    if (survivors.length > 0 && !live && opts.storedOnly !== true) {
      live = await bootReference(opts, reference, events);
      if (live) {
        const touched = unique(survivors.map((d) => d.journey));
        say({
          type: 'proof:start',
          at: events.elapsed(),
          count: touched.length,
          message: `Booting ${nameOf(reference)} and walking ${touched.length} ${plural(touched.length, 'journey', 'journeys')} again, to see which of these are real.`,
        });
        /** @type {Map<string, Capture>} */
        const liveNow = new Map();
        for (const name of touched) {
          const journey = journeys.find((j) => j.name === name);
          if (!journey) continue;
          liveNow.set(name, await walkOnce(opts, journey, live.build, 'single', 'reference', live, events));
        }
        const kept = proveAgainstLive(survivors, liveNow, walked);
        dropped = survivors.length - kept.length;
        survivors = kept;
        provedLive = true;
        say({
          type: 'proof:done',
          at: events.elapsed(),
          count: survivors.length,
          message:
            dropped === 0
              ? `All ${survivors.length} survived the old build being run again.`
              : `${dropped} of them were the old build's own behaviour and have been dropped. ${survivors.length} left.`,
        });
      }
    }

    // 6 — group it, order it, explain it.
    const clustered = clusterDifferences(survivors, { sources: sourceMap(walked) });
    say({
      type: 'cluster',
      at: events.elapsed(),
      count: clustered.length,
      message:
        clustered.length === survivors.length
          ? `${clustered.length} ${plural(clustered.length, 'finding', 'findings')}.`
          : `${survivors.length} differences are ${clustered.length} actual ${plural(clustered.length, 'finding', 'findings')}.`,
    });
    const ranked = await rankFindings(clustered, {
      cwd: opts.cwd,
      guards: opts.guards ?? [],
      touches: touchMap(walked),
      // Where "your change" starts.
      //
      // Without this, "the change" means the working tree and nothing else — so the moment
      // an agent commits its work, which is exactly what an agent does at the end of a task,
      // the distance measure goes blind, the ranking loses its ordering, and every finding
      // carries the sentence "nothing in the working tree has changed, so there is no edit
      // to measure this against" over a change that is perfectly well known. The reference
      // is a shipped build, which is a commit; the diff from there to here is the change,
      // whether it has been committed or not.
      since: reference?.gitSha ?? undefined,
    });

    const warning = modeWarning(mode, provedLive, reference);
    if (warning) gaps.push(...warningGaps(mode, provedLive));

    // COVERAGE THIS BUILD TOOK AWAY IS NOT A PASS. An address the standard answers at and
    // this build cannot is not a difference — there is no answer here to differ from — so it
    // produces no finding, and before this it produced nothing at all: the run came back
    // `ok: true` with the hole three paragraphs down in the coverage list. `recovered` and
    // `never-answered` deliberately do NOT come in here. One is good news and the other was
    // already true of the build on record, and neither is something this change caused.
    const answersLost = lost.length + thisBuildWouldNotAnswer.length;
    // BY NAME, not by adding two lists. A journey where NEITHER side reached the product is
    // in both lists, and subtracting both counts took it off the compared total twice — one
    // journey compared out of two came out as nought of two, which is a different and worse
    // claim than the true one.
    const notReallyCompared = new Set([...standardHasNoRecordOf, ...thisBuildWouldNotAnswer.map((d) => d.journey)]);
    return finish(opts, {
      ok:
        ranked.findings.length === 0 &&
        subtraction.newlyUnstable.length === 0 &&
        subtraction.couldNotTell !== true &&
        answersLost === 0 &&
        // AND SOMETHING HAS TO HAVE BEEN COMPARED. There is already a branch above for the
        // case where no journey had an old-build side at all; this is the same law one notch
        // finer, for the run where every journey HAD a record and every address in it holds
        // a refusal on one side or the other. Measured 2026-08-31: a product fixed after a
        // reference had been cut from a crash came back with nought findings, nought
        // addresses compared, and `ok: true`.
        comparedAddresses.size > 0,
      mode,
      modeWarning: warning,
      reference,
      findings: ranked.findings,
      real: subtraction.real.length,
      noise: subtraction.noise.length,
      newlyUnstable: subtraction.newlyUnstable,
      coverage: foldCoverage(walked, journeys, gaps),
      summary:
        (subtraction.couldNotTell === true ? `NO ANSWER FROM THIS RUN. ${subtraction.couldNotTellWhy} ` : '') +
        summarise(ranked.findings, subtraction, warning, [...runNotes, ...ranked.notes], reference, provedLive, dropped, {
          compared: comparedJourneys.length - notReallyCompared.size,
          asked: journeys.length,
          addresses: comparedAddresses.size,
          // The headline has to carry this. "Nothing that worked has changed" beside a
          // hundred addresses that could not be answered is a sentence somebody stops
          // reading after, and the whole reason two refusals comparing equal went unnoticed
          // for as long as it did is that the silence looked exactly like agreement.
          unanswered: uncompared.length,
          lost: answersLost,
        }),
      startedAt,
      started,
      events,
    });
  } finally {
    // Whatever happened, put the old build away. A left-behind app is the thing
    // that makes the NEXT run look broken.
    if (live) {
      try {
        await live.release();
      } catch (e) {
        say({ type: 'note', at: events.elapsed(), message: `The old build did not shut down cleanly. ${messageOf(e)}` });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The reference
// ---------------------------------------------------------------------------

/**
 * Which build counts as working.
 *
 * With no `against`, this is whatever the store's reference pointer names — and
 * that pointer is only ever moved by a person saying ship. With an `against`, it
 * is the stored build whose version, tag, commit or id matches, so a check can
 * be aimed at any build the store still knows about without rebuilding history.
 *
 * @param {Store} store
 * @param {string} product
 * @param {string} [against]
 * @returns {Promise<BuildFingerprint|null>}
 */
export async function resolveReference(store, product, against) {
  if (against) {
    const wanted = against.trim();
    /** @type {string[]} */
    const skipped = [];
    const builds = await listBuilds(store, { product, onProblem: (m) => skipped.push(m) });
    const hit = builds.find((b) => namesBuild(b.fingerprint, wanted));
    if (!hit) {
      // Saying "nothing on record matches" while a build folder was skipped for being
      // unreadable is an answer that sounds certain and is not. The skipped ones are named,
      // because one of them may well be the build being asked for.
      const couldNotRead = skipped.length > 0 ? ` ${skipped.length} build ${skipped.length === 1 ? 'folder was' : 'folders were'} skipped and one of them may be the one you mean: ${skipped.join(' ')}` : '';
      throw new StaysFixedError(`Nothing on record matches "${against}", so there is nothing to compare against.`, {
        hint:
          (builds.length === 0
            ? 'No builds of this product have been stored yet. Run a check once to store one.'
            : `Builds on record: ${builds.slice(0, 8).map((b) => nameOf(b.fingerprint)).join(', ')}${builds.length > 8 ? `, and ${builds.length - 8} more` : ''}.`) + couldNotRead,
      });
    }
    return hit.fingerprint;
  }
  const record = await referenceFor(store, product);
  return record ? record.fingerprint : null;
}

/**
 * Does this name pick out this build? Version, tag, commit or store id — the
 * things a person actually types.
 *
 * @param {BuildFingerprint} build
 * @param {string} wanted
 */
function namesBuild(build, wanted) {
  if (build.id === wanted || build.version === wanted) return true;
  if (build.gitSha && (build.gitSha === wanted || build.gitSha.startsWith(wanted))) return true;
  return false;
}

/**
 * The two captures `ship` blessed, per journey.
 *
 * Empty when there is no cut record — a reference set before this was written down, or one
 * pointed at by hand — and the caller falls back to the newest capture, which is what every
 * run did before.
 *
 * @param {Store} store
 * @param {string} product
 * @param {BuildFingerprint|null} reference
 * @returns {Promise<Map<string, [string, string]>>}
 */
async function blessedCapturePairs(store, product, reference) {
  /** @type {Map<string, [string, string]>} */
  const out = new Map();
  if (!reference?.id) return out;
  try {
    const current = await currentReference(store, product);
    if (!current?.cut || current.cut.buildId !== reference.id) return out;
    for (const journey of current.cut.stability?.byJourney ?? []) {
      if (journey.runs && journey.runs.length === 2) out.set(journey.journey, journey.runs);
    }
  } catch {
    // A reference log that cannot be read is somebody else's problem to report. Falling back
    // to the newest capture keeps the check running, which is the honest degradation.
  }
  return out;
}

/**
 * One capture by its id, or null when it is no longer there.
 *
 * @param {Store} store
 * @param {string} buildId
 * @param {string} journey
 * @param {string} id
 * @param {(m: string) => void} onProblem
 * @returns {Promise<Capture|null>}
 */
async function captureById(store, buildId, journey, id, onProblem) {
  if (!id) return null;
  try {
    return await loadCapture(store, { buildId, journey, captureId: id });
  } catch (e) {
    onProblem(`The capture ${id}, which is part of what this product calls working, could not be read. ${messageOf(e)}`);
    return null;
  }
}

/**
 * The reference build's stored record for one journey, and how steady it was.
 *
 * The second run matters as much as the first. Without it nothing can say
 * whether a path that wobbles now also wobbled then, and "your change made this
 * unpredictable" becomes a guess rather than a measurement.
 *
 * @param {Store} store
 * @param {string} buildId
 * @param {string} journey
 * @param {[string, string]} [blessed]  The two captures `ship` blessed, when it wrote them down.
 * @returns {Promise<{capture: Capture|null, wobble: Wobble|null, problems: string[]}>}
 */
export async function storedReference(store, buildId, journey, blessed) {
  /** @type {string[]} */
  const problems = [];
  /** @param {string} m */
  const onProblem = (m) => problems.push(m);
  // The blessed pair first. These are the captures that were the product's definition of
  // working at the moment somebody shipped, and nothing since may replace them.
  if (blessed) {
    const pinnedA = await captureById(store, buildId, journey, blessed[0], onProblem);
    const pinnedB = await captureById(store, buildId, journey, blessed[1], onProblem);
    if (pinnedA) {
      if (!pinnedB || pinnedB.id === pinnedA.id) return { capture: pinnedA, wobble: null, problems };
      try {
        return { capture: pinnedA, wobble: measureWobble(pinnedA, pinnedB), problems };
      } catch {
        return { capture: pinnedA, wobble: null, problems };
      }
    }
  }
  const a =
    (await latestCapture(store, { buildId, journey, run: 'a', onProblem })) ??
    (await latestCapture(store, { buildId, journey, onProblem }));
  if (!a) return { capture: null, wobble: null, problems };
  const b = await latestCapture(store, { buildId, journey, run: 'b', onProblem });
  if (!b || b.id === a.id) return { capture: a, wobble: null, problems };
  try {
    return { capture: a, wobble: measureWobble(a, b), problems };
  } catch {
    // Two captures of different builds or journeys got into the same folder.
    // Losing the steadiness measurement is a shame; failing the run over it
    // would be worse.
    return { capture: a, wobble: null, problems };
  }
}

/**
 * Two facts written down at one address, with two different answers.
 *
 * Every index in this engine keeps the FIRST observation at a path and ignores the rest, so
 * the second fact has no address of its own: it is never compared with anything, and a door
 * that broke behind it is invisible while the run still says "nothing that already worked has
 * changed". The detector for this existed from the first day of v2 and until 2026-08-30
 * nothing ever called it, which is why it is a named hole now rather than a comment.
 *
 * Identical repeats are not reported. Two log lines that tidy down to the same address AND the
 * same value hide nothing, and reporting those would bury the ones that do.
 *
 * @param {Observation[]} observations
 * @param {Journey} journey
 * @param {string} [where]  Which pass this was, when it was not the first walk of the new
 *                          build — the same clash on the old build's record means something
 *                          different to the reader and has to say so.
 * @returns {CoverageGap[]}
 */
export function duplicateGaps(observations, journey, where = '') {
  return findDuplicatePaths(observations).map((clash) => ({
    what: `Two different answers were written down at the same address, ${clash.path}, while walking "${journey.describe || journey.name}"${where ? ` ${where}` : ''}.`,
    why:
      `Only the first is kept, so ${clash.values.slice(1).map((v) => JSON.stringify(v)).join(' and ')} ` +
      `${clash.values.length > 2 ? 'were' : 'was'} never compared against anything at all. Whatever produced that address is giving one name to more than one thing.`,
    unlockedBy: 'The adapter that made that address has to give those two things two different names.',
    surface: journey.surface,
  }));
}

/**
 * @param {CheckRun} opts
 * @param {BuildFingerprint} reference
 * @param {CheckEvents} events
 * @returns {Promise<LiveBuild|null>}
 */
async function bootReference(opts, reference, events) {
  if (!opts.bootReference) return null;
  try {
    return await opts.bootReference(reference, { events, signal: opts.signal });
  } catch (e) {
    events.emit({
      type: 'note',
      at: events.elapsed(),
      message: `${nameOf(reference)} could not be started, so this run falls back to the stored record. ${messageOf(e)}`,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Walking, and what comes back
// ---------------------------------------------------------------------------

/**
 * @param {CheckRun} opts
 * @param {Journey} journey
 * @param {BuildFingerprint} build
 * @param {CaptureRun} run
 * @param {'candidate'|'reference'} which
 * @param {LiveBuild|undefined} live
 * @param {CheckEvents} events
 * @returns {Promise<Capture>}
 */
async function walkOnce(opts, journey, build, run, which, live, events) {
  const capture = await opts.walk({
    journey,
    build,
    run,
    which,
    live,
    dir: live?.dir,
    events,
    signal: opts.signal,
  });
  // Normalisation happens here rather than inside every collector, so one rule
  // set covers every platform and a rule can never be applied to one side of a
  // comparison and not the other.
  return opts.normalise ? opts.normalise(capture) : capture;
}

/**
 * The expensive half: the old build was booted and walked again, so a real
 * difference can be told apart from one the old build had as well.
 *
 * @param {Difference[]} suspicions
 * @param {Map<string, Capture>} live      Journey name to what the old build just did.
 * @param {Map<string, {a: Capture}>} now
 * @returns {Difference[]}
 */
export function proveAgainstLive(suspicions, live, now) {
  /** @type {Map<string, Map<string, Observation>>} */
  const liveIndex = new Map();
  for (const [name, capture] of live) {
    // A capture that came back with nothing it could actually observe is NOT a walk of the
    // old build, and treating it as one is the worst mistake this function can make: every
    // stored before-value is thrown away, every difference is relabelled 'appeared' with no
    // before-value at all, and the whole lot is stamped proven, which the report then reads
    // out as "re-checked against the old build booted live, so none of it is drift".
    //
    // Measured on Terminal Deck's Android app on 2026-08-30. The old build is exported with
    // `git archive`, an APK is a build output and is gitignored, so the exported checkout has
    // no APK in it, prepare gives up, and the adapter correctly returns one uncovered
    // observation saying so. A control that went from greyed out to usable — the exact
    // regression the run was meant to catch — was reported as a control that had appeared out
    // of nowhere, with `false` never mentioned. Any platform whose artifact is built rather
    // than committed hits this, not only phones.
    // `covered` is the ADAPTER's word for this and it does not survive onto an Observation:
    // `observation()` in adapters/contract.js turns `covered: false` into `meta.refused`.
    // Filtering on `o.covered` therefore matched everything and did nothing at all — the
    // fix above was written correctly and then read the wrong field.
    //
    // The test is now the VALUE rather than `meta.refused`, and the two are not the same
    // thing. `meta.refused` is also set on an observation holding a real value that was only
    // partly read — a stdout too big to keep whole is still an answer, and filtering it out
    // here threw away a comparison that works perfectly well. What has to go is an
    // observation with no answer in it at all.
    const walked = capture.observations.filter((o) => isAnswer(o.value));
    if (walked.length === 0) continue;
    liveIndex.set(name, indexByPath(walked));
  }
  /** @type {Map<string, Map<string, Observation>>} */
  const nowIndex = new Map();
  // Answers only on this side too. Without it, an address the new build now refuses at came
  // back from the expensive proof stamped `proven: true` with the words "not checked" in it
  // as its candidate value — a refusal dressed as a re-verified regression, which is the
  // strongest claim this tool can make about anything.
  for (const [name, pair] of now) nowIndex.set(name, indexByPath(pair.a.observations.filter((o) => isAnswer(o.value))));

  /** @type {Difference[]} */
  const kept = [];
  for (const d of suspicions) {
    const journey = d.journey ?? '';
    const wasLive = liveIndex.get(journey);
    if (!wasLive) {
      // The old build could not walk this journey. Never call that a pass: the
      // difference stays, and says it is still only suspected.
      kept.push({ ...d, proven: false });
      continue;
    }
    const was = wasLive.get(d.path);
    const is = nowIndex.get(journey)?.get(d.path);
    if (!was && !is) continue;
    if (was && is && sameValue(was.value, is.value)) continue;
    if (!was && is) {
      // AN ADDRESS THE RECORD HOLDS A VALUE FOR IS NEVER "was not there before".
      //
      // A live walk of the old build answering DIFFERENTLY from its own record is drift, and
      // subtracting it is the whole reason this function exists. A live walk that does not
      // answer at that address AT ALL is not drift — it is the booted build failing to
      // reproduce its own record, and the two are not the same news.
      //
      // Measured 2026-08-31 on a Node API. `ship` cut the reference from a working tree with
      // uncommitted changes and said so; the record was filed under the build fingerprint of
      // the tree that was actually walked, `work-76ac0155c8b9`, and it holds
      // `api.GET /api/session.shape` with the value `{"token":"string"}` on disk. `bootReference`
      // then fetched "the old build" by a DIFFERENT key off the same reference object — its
      // `gitSha` — and `git archive` of that commit has no `/api/session` route in it at all,
      // so nothing was observed at that address. This branch then threw the recorded value
      // away and the run printed: `"GET /api/session / shape" is there now and was not before.`
      // The record was sitting in the repository saying the opposite, and the difference was
      // stamped `proven: true` on top, which the summary reads out as re-checked against the
      // old build. A confident sentence, contradicted by this tool's own evidence.
      //
      // So the record wins where the live walk is silent: the difference keeps the values it
      // came in with and goes back unproven, which is what the tool already says for every
      // journey the old build could not walk.
      if (d.reference !== undefined) {
        kept.push({ ...d, proven: false });
        continue;
      }
      kept.push({ ...d, kind: 'appeared', reference: undefined, candidate: is.value, proven: true });
      continue;
    }
    if (was && !is) {
      kept.push({ ...d, kind: 'vanished', reference: was.value, candidate: undefined, proven: true });
      continue;
    }
    if (!was || !is) continue;
    kept.push({ ...d, kind: 'changed', reference: was.value, candidate: is.value, proven: true });
  }
  return kept;
}

/**
 * Keep this run's captures, so the next run has something to compare against and
 * so the wobble measured today can be checked against the wobble measured then.
 *
 * Storing is never allowed to fail a check: a full disk is a reason to say so,
 * not a reason to throw away the answer somebody just waited for.
 *
 * @param {CheckRun} opts
 * @param {Map<string, {a: Capture, b: Capture}>} walked
 * @returns {Promise<{kept: boolean, why: string}>}  `why` is empty when it worked, and empty
 *   when nobody asked for it to be kept. It carries a sentence only when it was asked for
 *   and failed, because that is the only case anybody has to be told about.
 */
async function remember(opts, walked) {
  if (opts.remember === false) return { kept: false, why: '' };
  try {
    await saveBuild(opts.store, opts.candidate, { captures: walked.size * 2 });
    for (const { a, b } of walked.values()) {
      await saveCapture(opts.store, a);
      await saveCapture(opts.store, b);
    }
    return { kept: true, why: '' };
  } catch (e) {
    // The doc above has always said a full disk is a reason to SAY SO. It was not: the
    // failure was swallowed here and the one caller threw the answer away, so a run whose
    // captures never reached the disk looked exactly like one whose captures did — and the
    // next run, finding no record, reported the whole product as never having been walked.
    // His disk hit zero bytes on 2026-08-30, so this is not a thought experiment.
    return { kept: false, why: messageOf(e) };
  }
}

// ---------------------------------------------------------------------------
// Saying what happened
// ---------------------------------------------------------------------------

/** The words the design insists on, said the same way every time this run is the weaker kind. */
const STORED_ONLY_WARNING =
  'This run compared against the stored record from the last time the old build ran, not against the old build run live. That is genuinely weaker: every difference that came from the days in between is still in this list.';

const PROVEN_LIVE_WARNING =
  'Everything reported here was re-checked against the old build booted live, so none of it is drift. What is NOT reported rests on the stored record from the last time the old build ran — a difference the store never captured cannot show up in this list.';

const NO_REFERENCE_WARNING =
  'Until you ship once with the reference hook in place there is nothing to compare against, so this run proves nothing about what still works.';

/**
 * Why the old build came back with nothing that could be walked.
 *
 * The adapter always says why. It says it in the observation's own sentence, which
 * `observation()` in adapters/contract.js files under `meta.describe` — "there is no APK in
 * the exported checkout", "the runtime this needs is not on this machine". Reading only
 * `observations[0]` threw that away in the two cases that matter most: a capture that came
 * back completely EMPTY has no observation nought to read, so the reader got the generic
 * "the adapter could not open it" while the real reason sat in the capture's note; and a
 * capture whose first observation happens to be one the adapter did cover names the wrong
 * hole. So the first REFUSED observation is the one that answers the question, its reason
 * category stands in when it has no sentence of its own, and the capture's note is read
 * before anything generic is said.
 *
 * The sentence is also finished properly. The adapter's `says` is already a whole sentence,
 * and the old template appended a full stop of its own — the same fault already fixed once
 * in check.js's explain reply, which was giving agents "...real money..".
 *
 * @param {Capture} was   The walk of the old build that produced nothing usable.
 * @returns {string}      One finished sentence.
 */
function whyNothingRan(was) {
  const refused = was?.observations?.find((o) => o.meta?.refused === true);
  const said = refused?.meta?.describe || refused?.meta?.refusedWhy || was?.note || 'the adapter could not open it';
  const text = String(said).trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * @param {'paired'|'stored-record'} mode
 * @param {boolean} provedLive
 * @param {BuildFingerprint} reference
 * @returns {string|undefined}
 */
function modeWarning(mode, provedLive, reference) {
  if (mode === 'paired') return undefined;
  return provedLive ? PROVEN_LIVE_WARNING : `${STORED_ONLY_WARNING} The old build here is ${nameOf(reference)}.`;
}

/**
 * A weaker run is missing coverage, not just a warning. Putting it in the
 * coverage list is what makes it countable rather than a sentence somebody
 * skims past.
 *
 * @param {'paired'|'stored-record'} mode
 * @param {boolean} provedLive
 * @returns {CoverageGap[]}
 */
function warningGaps(mode, provedLive) {
  if (mode === 'paired') return [];
  if (provedLive) {
    return [
      {
        what: 'Anything the old build never had a record for.',
        why: 'The old build was only booted to re-check the differences already suspected, not to walk everything.',
        unlockedBy: 'Run with --paired to boot the old build and walk every journey against it.',
      },
    ];
  }
  return [
    {
      what: 'Every difference that came from the days between the two builds.',
      why: 'The old build was not run live, so nothing separates a real change from a change in the machine around it.',
      unlockedBy: 'Make the old build buildable here, or run with --paired.',
    },
  ];
}

/**
 * The paragraph a person reads and an agent quotes. One place, so no two exits
 * can describe the same run differently.
 *
 * @param {Finding[]} findings
 * @param {import('./types.js').WobbleSubtraction} subtraction
 * @param {string|undefined} warning
 * @param {string[]} notes
 * @param {BuildFingerprint} reference
 * @param {boolean} provedLive
 * @param {number} dropped   Suspicions the old build turned out to have as well.
 * @param {{compared: number, asked: number, addresses: number, unanswered?: number, lost?: number}} how
 *   How much of the run this sentence covers: journeys that were really put beside the old
 *   build, journeys asked for, the addresses really compared, and the addresses that could
 *   not be compared because one side of them was a refusal rather than an answer.
 * @returns {string}
 */
function summarise(findings, subtraction, warning, notes, reference, provedLive, dropped, how) {
  const against = provedLive ? `${nameOf(reference)}, run live` : `the stored record of ${nameOf(reference)}`;
  const parts = [];
  // How much of the run this sentence is actually about. A run that compared four of its
  // seventeen journeys is not a run that found nothing; it is a run that mostly did not look,
  // and the first sentence is the only one some readers get.
  const missed = how.asked - how.compared;
  const reach =
    missed > 0
      ? ` ${how.compared} of ${how.asked} journeys had anything on the old build's side to be compared against; the other ${missed} ${plural(missed, 'was', 'were')} not compared at all, and ${plural(missed, 'is', 'are')} named in the coverage list.`
      : '';
  if (subtraction.sameBuild === true) {
    // The first sentence is the only one some readers get, so it may not be "Nothing that
    // worked has changed. N addresses checked against the stored record of 1.0.0" when the
    // record and the run are the same build. Nothing was held against anything: the tool ran
    // the shipped build again and compared it with itself. Measured 2026-08-31 on an untouched
    // Next.js app, where that sentence sat on top of a comparison that had no other side.
    parts.push(
      `This is the build that is already on record as working, run again and compared with itself, so nothing here could be a change. ` +
        `${how.addresses} ${plural(how.addresses, 'address was', 'addresses were')} watched.${reach}`,
    );
  } else if (findings.length === 0 && subtraction.newlyUnstable.length > 0) {
    // Findings and newly unpredictable addresses are two different lists, and only the first
    // one was ever in the headline. A run with no findings and four addresses that have
    // stopped sitting still opened with "Nothing that worked has changed", which is the
    // sentence somebody stops reading after — while `ok` was false and the reason sat three
    // sentences down. Reported on 2026-08-30 as the tool announcing all-clear over a verdict
    // that needed a person.
    const n = subtraction.newlyUnstable.length;
    parts.push(
      `Nothing behaves differently, but ${n} ${plural(n, 'address', 'addresses')} that used to give the same answer every time ${plural(n, 'does', 'do')} not any more. ` +
        `That is a change too: something is now unpredictable that was not. ${how.addresses} ${plural(how.addresses, 'address was', 'addresses were')} compared against ${against}.${reach}`,
    );
  } else if (findings.length === 0 && how.addresses === 0) {
    // Nought compared is never a pass. "Nothing that worked has changed. 0 addresses
    // checked" is the exact sentence measured on 2026-08-31 over a product that threw on its
    // first line, and it is arithmetically true and completely false as an answer.
    parts.push(
      `NO ANSWER FROM THIS RUN. Not one address could be put beside ${against}: every one of them holds a refusal on one side or the other, so nothing at all was compared. This is not a pass and not a failure.${reach}`,
    );
  } else if (findings.length === 0 && (how.lost ?? 0) > 0) {
    // The all-clear may not be said over coverage this build took away. It is not a finding
    // — there is no answer here to differ from — and until 2026-08-31 that made it nothing
    // at all: the headline read "Nothing that worked has changed" and the hole sat three
    // paragraphs down in a list.
    const n = how.lost ?? 0;
    parts.push(
      `Nothing that COULD be compared has changed — but ${n} ${plural(n, 'address', 'addresses')} the old build answers at could not be answered by this build at all, so ${plural(n, 'it was', 'they were')} not compared. That is coverage this build has taken away, and it is not a pass. ${how.addresses} ${plural(how.addresses, 'address was', 'addresses were')} really put beside ${against}.${reach}`,
    );
  } else if (findings.length === 0) {
    parts.push(`Nothing that worked has changed. ${how.addresses} ${plural(how.addresses, 'address', 'addresses')} checked against ${against}.${reach}`);
  } else {
    const sealed = findings.filter((f) => f.sealed).length;
    parts.push(
      `${findings.length} ${plural(findings.length, 'thing behaves', 'things behave')} differently, checked against ${against}.` +
        (sealed > 0 ? ` ${sealed} of them ${plural(sealed, 'is', 'are')} in a class nobody may wave through.` : '') +
        reach,
    );
  }
  // Said in the same breath as the headline, never further down. A refusal is not an answer,
  // so an address holding one was not checked at all — and until 2026-08-31 two of them
  // compared equal, which is silence, which reads exactly like agreement. This sentence is
  // what makes the difference visible to somebody who reads one line.
  const unanswered = how.unanswered ?? 0;
  if (unanswered > 0) {
    const lostCount = how.lost ?? 0;
    parts.push(
      `${unanswered} ${plural(unanswered, 'address', 'addresses')} could not be compared at all, because one side of ${plural(unanswered, 'it', 'them')} is a refusal rather than an answer` +
        (lostCount > 0
          ? `, and ${lostCount} of ${plural(unanswered, 'those is', 'those are')} coverage this build has taken away — the old build answers there and this one does not.`
          : '. Nothing about them is being watched, and none of them is a finding.'),
    );
  }
  parts.push(subtraction.note);
  if (dropped > 0) {
    parts.push(
      `${dropped} of those turned out to be things the old build does too, once it was booted and walked again, and ${dropped === 1 ? 'it was' : 'they were'} dropped.`,
    );
  }
  for (const note of notes) parts.push(note);
  if (warning) parts.push(warning);
  return parts.join(' ');
}

/**
 * @param {CheckRun} opts
 * @param {{
 *   ok: boolean,
 *   mode: 'paired'|'stored-record',
 *   modeWarning: string|undefined,
 *   reference: BuildFingerprint,
 *   findings: Finding[],
 *   real: number,
 *   noise: number,
 *   newlyUnstable: WobbleEntry[],
 *   coverage: Coverage,
 *   summary: string,
 *   startedAt: Date,
 *   started: number,
 *   events: CheckEvents,
 * }} parts
 * @returns {Verdict}
 */
function finish(opts, parts) {
  /** @type {Verdict} */
  const verdict = {
    runId: runId(parts.startedAt),
    product: opts.product,
    ok: parts.ok,
    mode: parts.mode,
    reference: parts.reference,
    candidate: opts.candidate,
    findings: parts.findings,
    differencesReal: parts.real,
    differencesNoise: parts.noise,
    newlyUnstable: parts.newlyUnstable,
    coverage: parts.coverage,
    summary: parts.summary,
    durationMs: Date.now() - parts.started,
    startedAt: parts.startedAt.toISOString(),
    tool: `staysfixed ${VERSION}`,
  };
  if (parts.modeWarning) verdict.modeWarning = parts.modeWarning;
  parts.events.emit({ type: 'check:done', at: parts.events.elapsed(), message: verdict.summary, verdict });
  return verdict;
}

// ---------------------------------------------------------------------------
// Small things
// ---------------------------------------------------------------------------

/**
 * Everything this run could not see, gathered in one place. Never empty on a
 * real run, because a coverage list that comes back clean is a coverage list
 * nobody is filling in.
 *
 * @param {Map<string, {a: Capture}>} walked
 * @param {Journey[]} journeys
 * @param {CoverageGap[]} extra
 * @returns {Coverage}
 */
export function foldCoverage(walked, journeys, extra) {
  /** @type {Partial<Record<Channel, number>>} */
  const byChannel = {};
  /** @type {Set<string>} */
  const paths = new Set();
  /** @type {CoverageGap[]} */
  const gaps = [...extra];
  let doorsKnown = 0;
  let doorsWalked = 0;

  for (const { a } of walked.values()) {
    for (const o of a.observations) {
      paths.add(o.path);
      byChannel[o.channel] = (byChannel[o.channel] ?? 0) + 1;
      if (o.meta?.refused) {
        // A refusal is the one thing that must never be silently rolled into a
        // pass. It is what the tool did NOT do, said out loud.
        gaps.push({
          what: o.meta.describe ?? `"${o.path}" was observed at the call and stopped there.`,
          why: o.meta.refusedWhy ?? 'Going further would have done something that cannot be undone.',
          unlockedBy: 'Nothing. This is deliberate and permanent — the effect is watched at the call, never at the result.',
          channel: o.channel,
        });
      }
    }
    if (a.coverage) {
      doorsKnown += a.coverage.doorsKnown ?? 0;
      doorsWalked += a.coverage.doorsWalked ?? 0;
      gaps.push(...(a.coverage.gaps ?? []));
    }
    if (a.complete === false) {
      gaps.push({
        what: `The record of "${a.journey}" was read back torn.`,
        why: 'The run that wrote it stopped partway, so some of what it saw is missing.',
        unlockedBy: 'Run the check again; a complete capture replaces the torn one.',
      });
    }
  }

  /** @type {Coverage} */
  const coverage = {
    paths: paths.size,
    journeys: walked.size,
    byChannel,
    gaps: dedupeGaps(gaps),
  };
  if (doorsKnown > 0) {
    coverage.doorsKnown = doorsKnown;
    coverage.doorsWalked = doorsWalked;
    if (doorsWalked < doorsKnown) {
      coverage.gaps.push({
        what: `${doorsKnown - doorsWalked} of the ${doorsKnown} doors the code opens have never been walked through.`,
        why: 'No journey reaches them, so a break behind one of them is invisible to this tool.',
        unlockedBy: 'Add a journey that opens them, or point the check at the test suite that already does.',
        doors: doorsKnown - doorsWalked,
      });
    }
  }
  // Journeys that were asked for and never produced a capture at all.
  for (const journey of journeys) {
    if (walked.has(journey.name)) continue;
    coverage.gaps.push({
      what: `The journey "${journey.describe || journey.name}" produced nothing.`,
      why: 'It was asked for and no capture came back.',
      unlockedBy: 'Run it on its own to see what it does.',
      surface: journey.surface,
    });
  }
  return coverage;
}

/**
 * @param {CoverageGap[]} gaps
 * @returns {CoverageGap[]}
 */
function dedupeGaps(gaps) {
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
 * Address to the source file it came from, so ranking can measure distance.
 * @param {Map<string, {a: Capture}>} walked
 * @returns {Record<string, string>}
 */
function sourceMap(walked) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const { a } of walked.values()) {
    for (const o of a.observations) {
      const source = o.meta?.source;
      if (source && out[o.path] === undefined) out[o.path] = source;
    }
  }
  return out;
}

/**
 * Journey to the source files it went through. Only useful when the list is
 * short — see distanceFor in rank.js for why a long one is thrown away.
 *
 * @param {Map<string, {a: Capture}>} walked
 * @returns {Record<string, string[]>}
 */
function touchMap(walked) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [name, { a }] of walked) {
    const files = unique(a.observations.map((o) => o.meta?.source));
    if (files.length > 0) out[name] = files;
  }
  return out;
}

/**
 * The addresses a stored reference held steady, so a path that wobbles now can
 * be told apart from one that always did.
 *
 * @param {Capture} capture
 * @param {Wobble} wobble
 * @returns {string[]}
 */
function steadyPaths(capture, wobble) {
  const unstable = new Set(wobble.unstable);
  // Answers only. An address that held a refusal on both runs is not an address the build
  // answered the same way twice; it is an address the build was never able to answer, and
  // counting it as steady is the same mistake in miniature that let `ship` print "all 7
  // addresses it was watched at answered the same way twice" about a product that threw on
  // its first line (measured 2026-08-31).
  return capture.observations.filter((o) => isAnswer(o.value)).map((o) => o.path).filter((p) => !unstable.has(p));
}

/**
 * A build, named the way a person would name it.
 * @param {BuildFingerprint} build
 */
export function nameOf(build) {
  if (build.version) return build.version;
  if (build.gitSha) return build.gitSha.slice(0, 7);
  return build.id || 'the build with no name';
}

/**
 * A stand-in for "there is no reference". An empty id is the signal, and every
 * reader of a Verdict can check it in one comparison.
 *
 * @param {string} product
 * @returns {BuildFingerprint}
 */
function emptyFingerprint(product) {
  return { id: '', product };
}

/** @param {Date} at */
function runId(at) {
  const p = (n = 0) => String(n).padStart(2, '0');
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
}

/**
 * @param {(string|undefined)[]} values
 * @returns {string[]}
 */
function unique(values) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const v of values) {
    if (typeof v !== 'string' || v.length === 0 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 */
function plural(n, one, many) {
  return n === 1 ? one : many;
}
