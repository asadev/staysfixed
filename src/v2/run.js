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
  diffCaptures,
  measureWobble,
  mergeWobble,
  unmeasuredWobble,
  subtractWobble,
  sameValue,
  indexByPath,
} from './observation.js';
import { ensureStore, saveBuild, saveCapture, latestCapture, referenceFor, listBuilds } from './store.js';
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
    /** @type {Wobble[]} */
    const wobbles = [];
    /** @type {Wobble[]} */
    const referenceWobbles = [];
    /** @type {string[]} */
    const steadyInReference = [];
    let referenceWobbleMeasured = true;

    for (const journey of journeys) {
      stop();
      say({ type: 'journey:start', at: events.elapsed(), journey: journey.name, message: `Walking ${journey.describe || journey.name}.` });

      const a = await walkOnce(opts, journey, opts.candidate, 'a', 'candidate', undefined, events);
      const b = await walkOnce(opts, journey, opts.candidate, 'b', 'candidate', undefined, events);
      const wobble = measureWobble(a, b);
      walked.set(journey.name, { a, b, wobble });
      wobbles.push(wobble);
      say({
        type: 'journey:done',
        at: events.elapsed(),
        journey: journey.name,
        count: a.observations.length,
        message: `${a.observations.length} ${plural(a.observations.length, 'thing', 'things')} looked at, ${wobble.unstable.length} of which this build cannot answer the same way twice.`,
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
        before.set(journey.name, wasA);
        referenceWobbles.push(measureWobble(wasA, wasB));
        continue;
      }
      const stored = await storedReference(opts.store, reference.id, journey.name);
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
      // The rules stamp exists so a run can notice this, and until 2026-08-30 nothing ever
      // read it. A stored capture normalised under one set of rules compared against a fresh
      // one normalised under another produces differences that are about the RULES — either a
      // wall of noise that reads like a regression, or, when the change was to add a rule,
      // quiet where there should not be any. Either way the reader has to be told.
      if (stored.capture.rules && a.rules && stored.capture.rules !== a.rules) {
        gaps.push({
          what: `"${journey.describe || journey.name}" is being compared across a change to the normalisation rules.`,
          why:
            `The stored record of the old build was tidied up by rule set ${stored.capture.rules} and this run used ${a.rules}. ` +
            'Some of what you see may be the rules changing rather than the product, and a rule that was added since could be covering something up.',
          unlockedBy: 'Run a paired check, which walks the old build live under today\'s rules, or ship again to cut a fresh reference.',
          surface: journey.surface,
        });
      }
      if (stored.wobble) steadyInReference.push(...steadyPaths(stored.capture, stored.wobble));
      else referenceWobbleMeasured = false;
    }

    stop();
    const wobble = wobbles.length > 0 ? mergeWobble(wobbles) : unmeasuredWobble(opts.candidate.id, '*');
    say({
      type: 'wobble',
      at: events.elapsed(),
      count: wobble.unstable.length,
      message:
        wobble.unstable.length === 0
          ? 'This build gives the same answer twice, everywhere.'
          : `${wobble.unstable.length} ${plural(wobble.unstable.length, 'address', 'addresses')} this build cannot answer the same way twice. Subtracted, not counted.`,
    });

    await remember(opts, walked);

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
        summary: `Nothing to compare against yet: no build of ${opts.product} is on record as working. This run has been kept, so the next one has something to measure against. ${NO_REFERENCE_WARNING}`,
        startedAt,
        started,
        events,
      });
    }

    // 4 — compare, then subtract the noise.
    /** @type {Difference[]} */
    const raw = [];
    for (const journey of journeys) {
      const was = before.get(journey.name);
      const is = walked.get(journey.name);
      if (!was || !is) continue;
      raw.push(...diffCaptures(was, is.a));
    }
    const subtraction = subtractWobble(raw, wobble, {
      referenceWobble: referenceWobbles.length > 0 ? mergeWobble(referenceWobbles) : undefined,
      steadyInReference: referenceWobbleMeasured && steadyInReference.length > 0 ? steadyInReference : undefined,
    });
    say({
      type: 'suspicion',
      at: events.elapsed(),
      count: subtraction.real.length,
      message: subtraction.note,
    });
    stop();

    // 5 — expensive proof, only where it is owed. Everything the live old build
    // does too is dropped silently and counted. That silence is the point: it is
    // what keeps this list short enough to read every word of.
    let survivors = subtraction.real;
    const mode = /** @type {'paired'|'stored-record'} */ (live ? 'paired' : 'stored-record');
    let provedLive = Boolean(live);
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
    });

    const warning = modeWarning(mode, provedLive, reference);
    if (warning) gaps.push(...warningGaps(mode, provedLive));

    return finish(opts, {
      ok: ranked.findings.length === 0 && subtraction.newlyUnstable.length === 0,
      mode,
      modeWarning: warning,
      reference,
      findings: ranked.findings,
      real: subtraction.real.length,
      noise: subtraction.noise.length,
      newlyUnstable: subtraction.newlyUnstable,
      coverage: foldCoverage(walked, journeys, gaps),
      summary: summarise(ranked.findings, subtraction, wobble, warning, ranked.notes, reference, provedLive, dropped),
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
    const builds = await listBuilds(store, { product });
    const hit = builds.find((b) => namesBuild(b.fingerprint, wanted));
    if (!hit) {
      throw new StaysFixedError(`Nothing on record matches "${against}", so there is nothing to compare against.`, {
        hint:
          builds.length === 0
            ? 'No builds of this product have been stored yet. Run a check once to store one.'
            : `Builds on record: ${builds.slice(0, 8).map((b) => nameOf(b.fingerprint)).join(', ')}.`,
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
 * The reference build's stored record for one journey, and how steady it was.
 *
 * The second run matters as much as the first. Without it nothing can say
 * whether a path that wobbles now also wobbled then, and "your change made this
 * unpredictable" becomes a guess rather than a measurement.
 *
 * @param {Store} store
 * @param {string} buildId
 * @param {string} journey
 * @returns {Promise<{capture: Capture|null, wobble: Wobble|null}>}
 */
async function storedReference(store, buildId, journey) {
  const a = (await latestCapture(store, { buildId, journey, run: 'a' })) ?? (await latestCapture(store, { buildId, journey }));
  if (!a) return { capture: null, wobble: null };
  const b = await latestCapture(store, { buildId, journey, run: 'b' });
  if (!b || b.id === a.id) return { capture: a, wobble: null };
  try {
    return { capture: a, wobble: measureWobble(a, b) };
  } catch {
    // Two captures of different builds or journeys got into the same folder.
    // Losing the steadiness measurement is a shame; failing the run over it
    // would be worse.
    return { capture: a, wobble: null };
  }
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
    const walked = capture.observations.filter((o) => o.meta?.refused !== true);
    if (walked.length === 0) continue;
    liveIndex.set(name, indexByPath(walked));
  }
  /** @type {Map<string, Map<string, Observation>>} */
  const nowIndex = new Map();
  for (const [name, pair] of now) nowIndex.set(name, indexByPath(pair.a.observations));

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
 * @returns {Promise<boolean>}
 */
async function remember(opts, walked) {
  if (opts.remember === false) return false;
  try {
    await saveBuild(opts.store, opts.candidate, { captures: walked.size * 2 });
    for (const { a, b } of walked.values()) {
      await saveCapture(opts.store, a);
      await saveCapture(opts.store, b);
    }
    return true;
  } catch {
    return false;
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
 * @param {Wobble} wobble
 * @param {string|undefined} warning
 * @param {string[]} notes
 * @param {BuildFingerprint} reference
 * @param {boolean} provedLive
 * @param {number} dropped   Suspicions the old build turned out to have as well.
 * @returns {string}
 */
function summarise(findings, subtraction, wobble, warning, notes, reference, provedLive, dropped) {
  const against = provedLive ? `${nameOf(reference)}, run live` : `the stored record of ${nameOf(reference)}`;
  const parts = [];
  if (findings.length === 0) {
    parts.push(`Nothing that worked has changed. ${wobble.steady} ${plural(wobble.steady, 'address', 'addresses')} checked against ${against}.`);
  } else {
    const sealed = findings.filter((f) => f.sealed).length;
    parts.push(
      `${findings.length} ${plural(findings.length, 'thing behaves', 'things behave')} differently, checked against ${against}.` +
        (sealed > 0 ? ` ${sealed} of them ${plural(sealed, 'is', 'are')} in a class nobody may wave through.` : ''),
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
  return capture.observations.map((o) => o.path).filter((p) => !unstable.has(p));
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
