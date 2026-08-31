/**
 * The bridge between a check and the window watching it.
 *
 * The engine already describes itself into one stream — the same stream v1 used, kept on
 * purpose, because its two rules are already written and already tested: a listener that
 * throws can never take a run down, and a listener that arrives late is handed everything it
 * missed. This file does not build a second one. It does three small things instead.
 *
 *   1. It names the few events v2 needs that v1 never had. A journey starting on a NAMED
 *      SURFACE, because one repository builds a website and a phone app and a command-line
 *      tool at once and the window has to say which one it is walking. An address count
 *      rising while a journey runs. A wobble measured. A finding clustered. Coverage folded.
 *
 *   2. It enriches. The engine says "walking checkout"; the panel needs to know that checkout
 *      is a journey on the website, the fourth of nine, read out of the test suite. All of
 *      that is already in the plan, so it is filled in here rather than being carried through
 *      the engine on every event.
 *
 *   3. It trims. A finding can stand for five hundred differences and a verdict can carry
 *      every one of them. None of that belongs in a window: the panel is handed the count and
 *      one example, never the five hundred.
 *
 * Everything here is data. Nothing in this file touches a browser, so it can be exercised
 * without opening one.
 */

/** @typedef {import('../types.js').Surface} Surface */
/** @typedef {import('../types.js').Journey} Journey */
/** @typedef {import('../types.js').Finding} Finding */
/** @typedef {import('../types.js').FindingClass} FindingClass */
/** @typedef {import('../types.js').Difference} Difference */
/** @typedef {import('../types.js').Coverage} Coverage */
/** @typedef {import('../types.js').CoverageGap} CoverageGap */
/** @typedef {import('../types.js').Verdict} Verdict */
/** @typedef {import('../types.js').Wobble} Wobble */
/** @typedef {import('../types.js').WobbleEntry} WobbleEntry */
/** @typedef {import('../types.js').ReferenceMode} ReferenceMode */
/** @typedef {import('../types.js').BuildFingerprint} BuildFingerprint */

// ---------------------------------------------------------------------------
// Surfaces, in words a person uses
// ---------------------------------------------------------------------------

/**
 * What each surface is called on screen.
 *
 * Not 'electron', not 'cli'. A person reading this window is being told what is being walked,
 * and "Desktop app" is what that is. The panel embeds this map rather than keeping its own
 * copy, so the two can never drift apart.
 *
 * @type {Readonly<Record<Surface, string>>}
 */
export const SURFACE_WORDS = Object.freeze({
  cli: 'Command line',
  library: 'Library',
  server: 'Server',
  web: 'Website',
  electron: 'Desktop app',
  android: 'Android phone',
  ios: 'iPhone',
  windows: 'Windows app',
  linux: 'Linux desktop app',
  macos: 'Mac app',
});

/**
 * One line describing a surface for somebody who has not seen the product.
 * @type {Readonly<Record<Surface, string>>}
 */
export const SURFACE_NOTES = Object.freeze({
  cli: 'run as a command, watched through what it printed, wrote and spawned',
  library: 'imported and called, watched through what it exported and returned',
  server: 'started on its own port, watched through what it answered',
  web: 'opened in a browser, watched through what the page says its controls do',
  electron: 'launched with its own data folder, watched through the app and its channels',
  android: 'installed on an emulator, watched through what is on the screen',
  ios: 'installed on a simulator, watched through what is on the screen',
  windows: 'driven on a real Windows desktop, watched through what is on the screen',
  linux: 'opened on a real Linux desktop, watched through what the accessibility bus says its controls do',
  macos: 'opened in the background on a Mac, watched through what is on the screen',
});

/**
 * The word for a surface, or the raw name when it is one we have not met.
 * @param {string|undefined} surface
 * @returns {string}
 */
export function surfaceWord(surface) {
  if (!surface) return 'Unknown surface';
  const known = /** @type {Record<string, string>} */ (SURFACE_WORDS)[surface];
  return known || surface;
}

/**
 * Where a journey came from, in words.
 * @type {Readonly<Record<string, string>>}
 */
export const SOURCE_WORDS = Object.freeze({
  code: 'read out of the code',
  suite: 'from the project’s own tests',
  recorded: 'a real session, recorded',
  explored: 'explored by an agent',
});

// ---------------------------------------------------------------------------
// The events
// ---------------------------------------------------------------------------

/**
 * Everything the window understands.
 *
 * The first eleven are the engine's own words, unchanged. The four after them are v2's new
 * ones, and they exist because the window has something to draw that the terminal never
 * needed: which surface is being walked, how many addresses have been watched so far, each
 * finding as it is formed, and the coverage once it is folded.
 *
 * @typedef {'plan'|'check:start'|'reference'|'journey:start'|'journey:done'|'wobble'|'suspicion'|'proof:start'|'proof:done'|'cluster'|'note'|'check:done'|'journey:addresses'|'finding'|'coverage'} PanelEventType
 */

/**
 * One thing said to the window.
 *
 * Every field but `type` and `at` is optional, and every field is JSON-safe, because this
 * crosses into a browser as text. `message` is the line a person reads and is always plain
 * English; everything else is what the panel draws around it.
 *
 * @typedef {object} PanelEvent
 * @property {PanelEventType} type
 * @property {number} at                    Milliseconds since the check started.
 * @property {string} [message]             Plain English. Always safe to show on its own.
 * @property {string} [journey]
 * @property {string} [describe]            What the journey does, in one sentence.
 * @property {Surface} [surface]
 * @property {string} [surfaceWord]         'Website', 'iPhone'. Filled in here, not upstream.
 * @property {string} [source]              code / suite / recorded / explored.
 * @property {string} [run]                 'a', 'b' or 'single' — which pass this is.
 * @property {number} [index]               1-based position in the walk.
 * @property {number} [total]               How many journeys there are.
 * @property {number} [count]               Whatever this event is counting.
 * @property {number} [watched]             Addresses watched so far, across every journey.
 * @property {number} [steady]              Only on 'wobble'. Addresses answered the same way
 *                                          twice, as the engine measured them.
 * @property {boolean} [measured]           Only on 'wobble'. False when no wobble was taken.
 * @property {string[]} [findingIds]        Only on 'check:done', and only when the whole
 *                                          verdict was to hand: every finding that survived,
 *                                          so a window can drop one that has been waived.
 * @property {number} [durationMs]
 * @property {PanelReference} [reference]   Only on 'reference'.
 * @property {PanelWobble} [wobble]         Only on 'wobble'.
 * @property {Finding|PanelFinding} [finding]      Only on 'finding'. Whole on the way in, cut
 *                                          down on the way out: the mapper is the only place
 *                                          that trims, so an event a window receives is always
 *                                          the small shape.
 * @property {Coverage|PanelCoverage} [coverage]   Only on 'coverage'. Same rule.
 * @property {Verdict|PanelVerdict} [verdict]      Only on 'check:done'. Same rule.
 * @property {PanelPlanShape} [plan]        Only on 'plan'.
 */

/**
 * Which build this one is being measured against, and how much that is worth.
 *
 * `weak` is the whole reason this shape exists. A run compared against a stored record is a
 * genuinely weaker run, and the tool admitting that is more important than it looking
 * confident — so the panel is handed a flag it cannot miss rather than a sentence it might
 * put in small type.
 *
 * @typedef {object} PanelReference
 * @property {string} name                  What to call it: a version, a marker, a short sha.
 * @property {ReferenceMode|'none'} mode
 * @property {boolean} weak                 True for a stored record, and for no reference at all.
 * @property {string} how                   Plain English: how this build came to be the reference.
 * @property {string} [warning]             Present whenever `weak`. The sentence to show loudly.
 * @property {string} [setAt]               When it became the reference.
 * @property {string} [setBy]               'ship-everywhere', a person, a command.
 * @property {string} [candidate]           What to call the build being checked.
 */

/**
 * What the build could not answer the same way twice.
 * @typedef {object} PanelWobble
 * @property {boolean} measured             False when only one pass ran, so nothing was measured.
 * @property {number} unstable              Addresses that would not sit still. Subtracted.
 * @property {number} steady                Addresses that gave the same answer both times.
 * @property {number} newlyUnstable         Steady in the old build, wobbling now. A bug, even
 *                                          though no value is wrong.
 * @property {boolean} [couldTellNewly]     False when there was no stability record to compare
 *                                          against, so a zero means no evidence, not no problem.
 * @property {string[]} [newlyUnstablePaths] A few of them, for reading. Never all of them.
 * @property {string} [note]                One plain sentence.
 */

/**
 * A finding, cut down to what a window shows.
 * @typedef {object} PanelFinding
 * @property {string} id
 * @property {string} title
 * @property {string} why
 * @property {FindingClass} class
 * @property {boolean} sealed               No agent may wave this through.
 * @property {number} count                 Differences this one finding stands for.
 * @property {number} rank
 * @property {string[]} paths               At most a handful. The count above says the real size.
 * @property {string[]} [nearFiles]
 * @property {string} [summary]
 * @property {string} [sample]              One difference, written out as a line.
 * @property {string} [evidence]            A file address. Fetched when asked for, never pushed.
 * @property {string} [journey]
 * @property {Surface} [surface]
 */

/**
 * Coverage, cut down, and deliberately without a percentage.
 *
 * A percentage invites a target and a target invites gaming. Counts and named gaps cannot be
 * gamed without the number of named gaps going down, which is the thing anybody would notice.
 *
 * @typedef {object} PanelCoverage
 * @property {number} paths
 * @property {number} journeys
 * @property {Record<string, number>} byChannel
 * @property {number} [doorsKnown]
 * @property {number} [doorsWalked]
 * @property {number} [doorsUnopened]       Worked out here so the window never does arithmetic.
 * @property {PanelGap[]} gaps
 * @property {number} [gapsHidden]          Gaps beyond the ones listed.
 */

/**
 * One hole, and what would fill it.
 * @typedef {object} PanelGap
 * @property {string} what
 * @property {string} why
 * @property {string} [unlockedBy]
 * @property {number} [doors]
 * @property {Surface} [surface]
 * @property {string} [surfaceWord]
 */

/**
 * The end of a run, as much of it as a window needs.
 * @typedef {object} PanelVerdict
 * @property {boolean} ok
 * @property {ReferenceMode} mode
 * @property {string} [modeWarning]
 * @property {string} summary
 * @property {number} findings
 * @property {number} sealed                How many need a person.
 * @property {number} newlyUnstable         Addresses that were steady before this change and
 *                                          are not now. A run can be `ok: false` on these
 *                                          alone, with no findings at all.
 * @property {number} differencesReal
 * @property {number} differencesNoise
 * @property {number} durationMs
 * @property {string} [reference]
 * @property {string} [candidate]
 */

/**
 * One journey, as the window lists it before anything has happened.
 * @typedef {object} PanelJourney
 * @property {string} name
 * @property {string} [describe]
 * @property {Surface} [surface]
 * @property {string} [surfaceWord]
 * @property {string} [source]
 * @property {string} [sourceWord]
 * @property {string} [skip]                Switched off, and therefore missing coverage.
 */

/**
 * What the window is told before the check starts.
 * @typedef {object} PanelPlanShape
 * @property {string} [product]             One repository can build five. This names one.
 * @property {string} [project]             The folder it is being run in.
 * @property {PanelJourney[]} [journeys]
 * @property {string[]} [surfaces]          The surfaces in play, in words.
 * @property {Surface|string} [surface]     When a check walks exactly one, naming it here is
 *                                          enough and the list above can be left out.
 * @property {PanelReference|string} [reference]   The shape, or just the sentence when that is
 *                                          all the host has.
 * @property {ReferenceMode} [mode]         Filled in when the reference is known up front.
 * @property {string} [modeWarning]         Present whenever the mode is the weaker one.
 * @property {'dark'|'light'|'system'} [theme]
 */

/**
 * Anywhere an event can be dropped.
 *
 * Loose about the event on purpose: the engine types its own stream narrowly, and a lane that
 * wants to say one of v2's new events should not have to widen a typedef it does not own to be
 * allowed to say it.
 *
 * @typedef {object} EventSink
 * @property {(event: any) => void} emit
 * @property {() => number} [elapsed]
 */

/**
 * Anything that can be listened to. Only `on` is asked for, because that is all a window needs
 * and asking for less is what lets the engine's own stream be handed straight over.
 *
 * @typedef {object} Watchable
 * @property {(listener: (event: any) => void) => (() => void)} on
 */

// ---------------------------------------------------------------------------
// WHY THERE IS NO say*() FAMILY HERE ANY MORE  (removed 2026-08-30)
// ---------------------------------------------------------------------------
//
// This file used to export a second way of talking to a window: sayPlan, sayReference,
// sayJourneyStart, sayAddresses, sayJourneyDone, sayWobble, sayFinding, sayCoverage,
// sayNote and sayCheckDone, each one wrapping an emit. Nothing anywhere ever called a
// single one of them. The engine emits its own plain CheckEvents and `makeMapper` below
// translates them, so the tool carried two vocabularies for one window and only one of
// them was wired.
//
// They were deleted rather than adopted, and the reason is the paragraph at the top of
// watch/index.js: the ENGINE works everything out and the PANEL only draws. Every say*()
// would have had run.js reach for the window's vocabulary at the moment it is meant to be
// running a difference machine — and it would only have covered the one stream that
// remembered to call them, where the mapper covers ANY stream, v1's events included. Dead
// code in a tool whose job is telling the truth about a product is its own small lie: it
// reads like a supported road and is a road nobody has ever driven down.
//
// What was NOT deleted is the vocabulary the window really needs. CLASS_WORDS and
// SURFACE_NOTES are now embedded in the page by panel.js, exactly the way SURFACE_WORDS
// and SOURCE_WORDS already were. CLASS_WORDS had to be: the panel was keeping a second
// hand-written copy of the same map, and the two had already drifted — the panel said "a
// bug already reported once" where this file says "a bug you already reported", and the
// panel had no word for 'ordinary' at all.

// ---------------------------------------------------------------------------
// Trimming — what crosses into the window, and what stays out
// ---------------------------------------------------------------------------

/** How many addresses of a finding travel with it. The count says the real size. */
const PATHS_SHOWN = 6;
/** How many gaps travel with the coverage. The rest are counted. */
const GAPS_SHOWN = 12;
/** How many unstable addresses are named. */
const WOBBLE_PATHS_SHOWN = 5;

/**
 * A finding, cut down to what a window can show without becoming a database viewer.
 *
 * One missing stylesheet is ONE finding standing for four hundred differences. The window is
 * told the four hundred and shown one of them: a list of four hundred lines is not
 * information, it is a place information goes to hide.
 *
 * Takes whatever arrives, including a finding that has already been through here once: this
 * is the boundary between the engine's shapes and the window's, and a boundary that refuses
 * unexpected input is a boundary that breaks the window it was meant to protect.
 *
 * @param {any} finding
 * @returns {PanelFinding}
 */
export function trimFinding(finding) {
  const differences = Array.isArray(finding.differences) ? finding.differences : [];
  const paths =
    Array.isArray(finding.paths) && finding.paths.length
      ? finding.paths.slice(0, PATHS_SHOWN)
      : differences.slice(0, PATHS_SHOWN).map((/** @type {any} */ d) => String(d?.path ?? ''));
  const sample = finding.sample || differences[0];
  return {
    id: String(finding.id ?? ''),
    title: String(finding.title ?? 'Something changed.'),
    why: String(finding.why ?? ''),
    class: finding.class || 'ordinary',
    sealed: Boolean(finding.sealed) || isSealedClass(finding.class),
    count: Number(finding.count ?? differences.length ?? 0) || differences.length,
    rank: Number(finding.rank ?? 0),
    paths: paths.filter(Boolean),
    nearFiles: Array.isArray(finding.nearFiles) ? finding.nearFiles.slice(0, 3) : undefined,
    summary: finding.summary,
    sample: sample ? differenceLine(sample) : undefined,
    evidence: finding.evidence,
    journey: differences.find((/** @type {any} */ d) => d && d.journey)?.journey,
  };
}

/**
 * The classes an agent may never wave through.
 * @param {string|undefined} klass
 * @returns {boolean}
 */
export function isSealedClass(klass) {
  return klass === 'money' || klass === 'sign-in' || klass === 'data-loss' || klass === 'crash' || klass === 'guard';
}

/**
 * What each class is called on screen, for somebody who is not a programmer.
 * @type {Readonly<Record<string, string>>}
 */
export const CLASS_WORDS = Object.freeze({
  money: 'money',
  'sign-in': 'signing in',
  'data-loss': 'losing data',
  crash: 'a crash',
  guard: 'a bug you already reported',
  ordinary: 'ordinary',
});

/**
 * One difference, written out as a line somebody can read.
 * @param {Difference|string} d
 * @returns {string}
 */
export function differenceLine(d) {
  // Already written out once. Trimming is allowed to happen twice and must not lose anything.
  if (typeof d === 'string') return d;
  if (!d || typeof d !== 'object') return '';
  const path = String(d.path ?? '');
  if (d.kind === 'appeared') return `${path} — appeared: ${short(d.candidate)}`;
  if (d.kind === 'vanished') return `${path} — no longer there (was ${short(d.reference)})`;
  return `${path} — was ${short(d.reference)}, now ${short(d.candidate)}`;
}

/**
 * A value, short enough to sit on one line.
 * @param {unknown} value
 * @returns {string}
 */
function short(value) {
  if (value === null) return 'nothing';
  if (value === undefined) return 'absent';
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = String(text ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

/**
 * Coverage, cut down, and still without a percentage. Safe to run twice.
 * @param {any} coverage
 * @returns {PanelCoverage}
 */
export function trimCoverage(coverage) {
  const gaps = Array.isArray(coverage?.gaps) ? coverage.gaps : [];
  const doorsKnown = numberOr(coverage?.doorsKnown);
  const doorsWalked = numberOr(coverage?.doorsWalked);
  /** @type {Record<string, number>} */
  const byChannel = {};
  const source = coverage?.byChannel ?? {};
  for (const key of Object.keys(source)) {
    const n = Number(/** @type {Record<string, unknown>} */ (source)[key]);
    if (Number.isFinite(n)) byChannel[key] = n;
  }
  return {
    paths: Number(coverage?.paths ?? 0) || 0,
    journeys: Number(coverage?.journeys ?? 0) || 0,
    byChannel,
    doorsKnown,
    doorsWalked,
    doorsUnopened:
      doorsKnown !== undefined && doorsWalked !== undefined ? Math.max(0, doorsKnown - doorsWalked) : undefined,
    gaps: gaps.slice(0, GAPS_SHOWN).map((/** @type {any} */ g) => ({
      what: String(g?.what ?? ''),
      why: String(g?.why ?? ''),
      unlockedBy: g?.unlockedBy,
      doors: numberOr(g?.doors),
      surface: g?.surface,
      surfaceWord: g?.surface ? surfaceWord(g.surface) : undefined,
    })),
    gapsHidden: Math.max(0, gaps.length - GAPS_SHOWN),
  };
}

/**
 * A whole verdict, cut down to the handful of numbers a window states. Safe to run twice.
 * @param {any} verdict
 * @returns {PanelVerdict}
 */
export function trimVerdict(verdict) {
  // A verdict that has already been cut down carries a COUNT of findings where a whole one
  // carries the list. Both are accepted, because trimming twice must never quietly report
  // that a run with four findings had none.
  const list = Array.isArray(verdict?.findings) ? verdict.findings : [];
  const counted = typeof verdict?.findings === 'number' ? verdict.findings : list.length;
  const sealed =
    typeof verdict?.sealed === 'number'
      ? Number(verdict.sealed)
      : list.filter((/** @type {any} */ f) => f?.sealed || isSealedClass(f?.class)).length;
  // Addresses that used to be steady and are not any more. A run can have NO findings and
  // still not be a pass because of these, and without the number the window cannot tell that
  // apart from a run that compared nothing — the two look identical from `ok: false` and a
  // finding count of nought, and they need opposite sentences.
  const newlyUnstable =
    typeof verdict?.newlyUnstable === 'number'
      ? verdict.newlyUnstable
      : Array.isArray(verdict?.newlyUnstable)
        ? verdict.newlyUnstable.length
        : 0;
  return {
    ok: Boolean(verdict?.ok),
    mode: verdict?.mode ?? 'stored-record',
    modeWarning: verdict?.modeWarning,
    summary: String(verdict?.summary ?? ''),
    findings: counted,
    sealed,
    newlyUnstable,
    differencesReal: Number(verdict?.differencesReal ?? 0) || 0,
    differencesNoise: Number(verdict?.differencesNoise ?? 0) || 0,
    durationMs: Number(verdict?.durationMs ?? 0) || 0,
    reference: verdict?.reference ? buildName(verdict.reference) : undefined,
    candidate: verdict?.candidate ? buildName(verdict.candidate) : undefined,
  };
}

/**
 * What to call a build on screen.
 *
 * Takes a name that has already been worked out as readily as the whole fingerprint, because
 * trimming can happen twice and a build must not lose its name the second time round.
 *
 * @param {BuildFingerprint|string|undefined} build
 * @returns {string}
 */
export function buildName(build) {
  if (typeof build === 'string') return build || 'an unnamed build';
  if (!build || typeof build !== 'object') return 'an unnamed build';
  if (build.version) return build.version;
  if (build.gitSha) return String(build.gitSha).slice(0, 8);
  return String(build.id ?? 'an unnamed build');
}

/**
 * The wobble, as one sentence.
 * @param {PanelWobble} w
 * @returns {string}
 */
export function wobbleSentence(w) {
  if (!w.measured) {
    return 'This build was only run once, so its own wobble was never measured. Anything below could be the product arguing with itself.';
  }
  if (w.unstable === 0) return 'This build gives the same answer twice, everywhere.';
  return `${plural(w.unstable, 'address', 'addresses')} this build cannot answer the same way twice. Subtracted, not counted.`;
}

/**
 * Coverage, as one sentence — the one that has to arrive in the same breath as the good news.
 * @param {PanelCoverage} c
 * @returns {string}
 */
export function coverageSentence(c) {
  const parts = [`${plural(c.paths, 'address', 'addresses')} watched across ${plural(c.journeys, 'journey', 'journeys')}`];
  if (c.doorsUnopened !== undefined && c.doorsUnopened > 0) {
    parts.push(`${plural(c.doorsUnopened, 'door', 'doors')} in the code that no journey has ever opened`);
  }
  const holes = c.gaps.length + (c.gapsHidden ?? 0);
  if (holes > 0) parts.push(`${plural(holes, 'thing', 'things')} that could not be checked at all`);
  return `${parts.join(', ')}.`;
}

/**
 * "1 address", "17 addresses". With the number, because a bare word is not a count.
 * @param {number|undefined} n
 * @param {string} one
 * @param {string} many
 * @returns {string}
 */
export function plural(n, one, many) {
  const v = Math.round(Number(n) || 0);
  return `${v.toLocaleString('en-US')} ${v === 1 ? one : many}`;
}

/**
 * @param {unknown} value
 * @returns {number|undefined}
 */
function numberOr(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// The plan the window opens with
// ---------------------------------------------------------------------------

/**
 * Build the opening plan from what a check already knows.
 *
 * A window that opens empty and fills up looks broken for the first few seconds. This is what
 * it draws before anything has happened: the product, the surfaces in play, and every journey
 * it is about to walk, in order.
 *
 * @param {object} input
 * @param {string} [input.product]
 * @param {string} [input.project]
 * @param {Journey[]} [input.journeys]
 * @param {PanelReference} [input.reference]
 * @param {'dark'|'light'|'system'} [input.theme]
 * @returns {PanelPlanShape}
 */
export function panelPlan(input) {
  const journeys = Array.isArray(input?.journeys) ? input.journeys : [];
  /** @type {PanelJourney[]} */
  const rows = [];
  /** @type {string[]} */
  const surfaces = [];
  for (const j of journeys) {
    if (!j || typeof j !== 'object' || !j.name) continue;
    const word = j.surface ? surfaceWord(j.surface) : undefined;
    if (word && !surfaces.includes(word)) surfaces.push(word);
    rows.push({
      name: String(j.name),
      describe: j.describe ? String(j.describe) : undefined,
      surface: j.surface,
      surfaceWord: word,
      source: j.source,
      sourceWord: j.source ? /** @type {Record<string, string>} */ (SOURCE_WORDS)[j.source] : undefined,
      skip: j.skip,
    });
  }
  return {
    product: input?.product ? String(input.product) : undefined,
    project: input?.project ? String(input.project) : undefined,
    journeys: rows,
    surfaces,
    reference: input?.reference,
    theme: input?.theme,
  };
}

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

/**
 * Turns the engine's stream into what the window draws.
 *
 * It carries a little memory — the plan, which journey is where, how many addresses have gone
 * by — because the alternative is threading all of that through the engine on every event, and
 * the engine has a difference machine to run.
 *
 * @typedef {object} Mapper
 * @property {(event: any) => PanelEvent[]} map
 * @property {PanelPlanShape} plan
 */

/**
 * A mapper, holding the plan it was opened with.
 *
 * @param {PanelPlanShape} [plan]
 * @returns {Mapper}
 */
export function makeMapper(plan = {}) {
  /** @type {Map<string, PanelJourney>} */
  const known = new Map();
  for (const j of plan.journeys ?? []) known.set(j.name, j);

  /** @type {Map<string, number>} */
  const perJourney = new Map();
  /** @type {Set<string>} */
  const started = new Set();
  let watched = 0;
  let announcedWobble = false;

  /** @param {string|undefined} name */
  function about(name) {
    return (name && known.get(name)) || undefined;
  }

  /**
   * @param {any} event
   * @returns {PanelEvent[]}
   */
  function map(event) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return [];
    const at = Number(event.at) || 0;
    const type = /** @type {string} */ (event.type);
    const message = typeof event.message === 'string' ? event.message : undefined;

    switch (type) {
      case 'plan': {
        const next = /** @type {PanelPlanShape} */ (event.plan ?? {});
        for (const j of next.journeys ?? []) known.set(j.name, j);
        return [{ type: 'plan', at, plan: next, message }];
      }

      case 'check:start':
        return [{ type: 'check:start', at, message }];

      case 'reference': {
        const reference = /** @type {PanelReference|undefined} */ (event.reference);
        return [{ type: 'reference', at, message, reference: reference ?? inferReference(message) }];
      }

      case 'journey:start': {
        const name = str(event.journey);
        const meta = about(name);
        if (name && !started.has(name)) started.add(name);
        return [
          {
            type: 'journey:start',
            at,
            message,
            journey: name,
            describe: str(event.describe) ?? meta?.describe,
            surface: event.surface ?? meta?.surface,
            surfaceWord: event.surfaceWord ?? meta?.surfaceWord,
            source: str(event.source) ?? meta?.source,
            run: str(event.run),
            index: numberOr(event.index) ?? started.size,
            total: numberOr(event.total) ?? (plan.journeys?.length || undefined),
          },
        ];
      }

      case 'journey:addresses': {
        const name = str(event.journey) ?? '';
        const count = Number(event.count) || 0;
        const before = perJourney.get(name) ?? 0;
        if (count > before) {
          watched += count - before;
          perJourney.set(name, count);
        }
        return [{ type: 'journey:addresses', at, journey: name, count, watched }];
      }

      case 'journey:done': {
        const name = str(event.journey) ?? '';
        const count = Number(event.count) || 0;
        const before = perJourney.get(name) ?? 0;
        if (count > before) {
          watched += count - before;
          perJourney.set(name, count);
        }
        const meta = about(name);
        return [
          {
            type: 'journey:done',
            at,
            message,
            journey: name,
            count,
            watched,
            durationMs: numberOr(event.durationMs),
            surface: event.surface ?? meta?.surface,
            surfaceWord: event.surfaceWord ?? meta?.surfaceWord,
          },
        ];
      }

      case 'wobble': {
        announcedWobble = true;
        // What the ENGINE measured, wherever it said it. `steady` used to be guessed here as
        // "everything watched so far, minus the unstable ones", and those are two different
        // populations: `watched` counts what the adapters wrote down, while the wobble is
        // measured over addresses. The guess therefore claimed addresses had answered the
        // same way twice that the build had never been asked at. It is kept only as a
        // fallback, for a stream that says nothing about steadiness at all.
        const said = numberOr(event.steady);
        const wobble = /** @type {PanelWobble|undefined} */ (event.wobble) ?? {
          measured: event.measured !== false,
          unstable: Number(event.count) || 0,
          steady: said ?? Math.max(0, watched - (Number(event.count) || 0)),
          newlyUnstable: 0,
        };
        return [{ type: 'wobble', at, message: message ?? wobbleSentence(wobble), wobble, count: wobble.unstable }];
      }

      case 'suspicion':
      case 'proof:start':
      case 'proof:done':
      case 'cluster':
        return [{ type: /** @type {PanelEventType} */ (type), at, message, count: numberOr(event.count) }];

      case 'note':
        return message ? [{ type: 'note', at, message }] : [];

      case 'finding': {
        if (!event.finding) return [];
        const finding = trimFinding(event.finding);
        return [{ type: 'finding', at, finding, message: finding.title }];
      }

      case 'coverage': {
        if (!event.coverage) return [];
        const coverage = trimCoverage(event.coverage);
        return [{ type: 'coverage', at, coverage, message: message ?? coverageSentence(coverage) }];
      }

      case 'check:done':
        return finish(event, at, message);

      default:
        // v1's own events can land on this stream. They are not v2's vocabulary and they are
        // not an error either: they are simply not drawn.
        return [];
    }
  }

  /**
   * The end, fanned out.
   *
   * A verdict carries everything — every finding, every difference, the whole coverage — and
   * the window wants it as a handful of things it can draw one after another. Findings first,
   * then what was not checked, then the verdict itself, so the last thing to land is the
   * sentence a person reads.
   *
   * @param {any} event
   * @param {number} at
   * @param {string|undefined} message
   * @returns {PanelEvent[]}
   */
  function finish(event, at, message) {
    /** @type {PanelEvent[]} */
    const out = [];
    const verdict = /** @type {Verdict|undefined} */ (event.verdict);
    if (verdict) {
      const findings = Array.isArray(verdict.findings) ? verdict.findings : [];
      const noise = Number(verdict.differencesNoise ?? 0) || 0;
      for (const f of findings) out.push({ type: 'finding', at, finding: trimFinding(f), message: f?.title });
      if (verdict.coverage) {
        const coverage = trimCoverage(verdict.coverage);
        out.push({ type: 'coverage', at, coverage, message: coverageSentence(coverage) });
      }
      if (!announcedWobble && Array.isArray(verdict.newlyUnstable)) {
        /** @type {PanelWobble} */
        const wobble = {
          measured: true,
          unstable: noise,
          steady: Math.max(0, watched - noise),
          newlyUnstable: verdict.newlyUnstable.length,
          newlyUnstablePaths: verdict.newlyUnstable.slice(0, WOBBLE_PATHS_SHOWN).map((e) => String(e?.path ?? '')),
        };
        out.push({ type: 'wobble', at, wobble, message: wobbleSentence(wobble), count: wobble.unstable });
      }
      out.push({
        type: 'check:done',
        at,
        verdict: trimVerdict(verdict),
        // WHICH findings, not just how many. A finding only ever ARRIVES at a window; there
        // was no way to take one away again, and findings are taken away — the engine's
        // verdict carries every difference it found, and the gates in check.js then remove
        // the ones an agent has recorded as intended and hand back the settled list. Both
        // verdicts reach the window, in that order, so a waived finding stayed drawn beside
        // a terminal that had already stopped reporting it. Naming the survivors is what
        // lets the window agree: anything drawn that is not on this list is gone.
        findingIds: findings.map((/** @type {any} */ f) => String(f?.id ?? '')).filter(Boolean),
        durationMs: verdict.durationMs,
        message: message ?? verdict.summary,
      });
      return out;
    }
    out.push({ type: 'check:done', at, message, verdict: /** @type {PanelVerdict|undefined} */ (event.panelVerdict) });
    return out;
  }

  return { map, plan };
}

/**
 * When the engine says something about the reference but hands over no shape, take it at its
 * word rather than inventing a build name.
 *
 * @param {string|undefined} message
 * @returns {PanelReference|undefined}
 */
function inferReference(message) {
  if (!message) return undefined;
  const nothing = /no build on record/i.test(message);
  if (!nothing) return undefined;
  return {
    name: 'nothing yet',
    mode: 'none',
    weak: true,
    how: 'Nothing has been recorded as working yet, so this run has nothing to measure against.',
    warning: 'There is no reference. This run can describe the product, but it cannot prove anything is unchanged.',
  };
}

/**
 * @param {unknown} value
 * @returns {string|undefined}
 */
function str(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Wiring a window to a check
// ---------------------------------------------------------------------------

/**
 * Point a window at a check.
 *
 * `push` is whatever gets one event into the page — over a debugging connection, down a pipe,
 * into a test's array. This file never opens a browser and never knows there is one.
 *
 * The window is a convenience and is treated like one throughout: a push that throws is
 * swallowed, and the check carries on. Minimising the window, closing it, or never opening it
 * changes nothing about what gets checked.
 *
 * @param {Watchable} events
 * @param {(event: PanelEvent) => void} push
 * @param {object} [options]
 * @param {PanelPlanShape} [options.plan]
 * @param {(problem: unknown) => void} [options.onProblem]  Told when a push fails. Optional.
 * @returns {() => void}  Call it to stop listening.
 */
export function attachPanel(events, push, options = {}) {
  const mapper = makeMapper(options.plan ?? {});
  let stopped = false;

  const off = events.on((event) => {
    if (stopped) return;
    for (const drawn of mapper.map(event)) {
      try {
        push(drawn);
      } catch (problem) {
        // Never the reason a check looks broken.
        if (options.onProblem) {
          try {
            options.onProblem(problem);
          } catch {
            // Even the complaint is optional.
          }
        }
      }
    }
  });

  return () => {
    stopped = true;
    try {
      off();
    } catch {
      // Already gone.
    }
  };
}
