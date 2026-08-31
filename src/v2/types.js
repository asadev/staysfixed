/**
 * Stays Fixed v2 — the whole contract, in one file.
 *
 * v1 photographed screens and compared pixels. v2 is a difference machine: it walks the
 * product, writes down what it observed as `path -> value` facts, and reports only the
 * facts that changed. Pictures become the seventh channel and the last one.
 *
 * Everything here is a JSDoc typedef. Nothing runs. It exists so the pieces built in
 * parallel fit together, and so `npm run typecheck` proves it before anything is wired up.
 *
 * THE ONE IDEA WORTH READING TWICE: every platform flattens to the same shape. A button on
 * an iPhone screen, an HTTP status, an exit code and an IPC channel are all one addressable
 * fact. That is why one comparison engine can serve seven platforms, and why the path
 * grammar below is the most load-bearing thing in the repository.
 */

// ---------------------------------------------------------------------------
// Channels — the seven ways we can observe a product
// ---------------------------------------------------------------------------

/**
 * The seven observation channels, in the order we trust them.
 *
 * - `meaning`     What the interface says a control is and does: role, name, state.
 *                 Never the raw DOM — the DOM changes when nothing did.
 * - `effects`     What went out: network calls, files written, processes spawned,
 *                 storage writes. Recorded at the CALL boundary, so an irreversible
 *                 effect is observed without being performed.
 * - `complaints`  Console messages, stderr, crashes, exit codes.
 * - `results`     What came back: stdout, HTTP bodies, the exported API surface.
 * - `contract`    Read statically out of the source: routes, exports, IPC channels.
 *                 Free, exact, and it sees doors no walkthrough ever opens.
 * - `counters`    Coarse counts and timing. Deliberately coarse: fine timing is wobble.
 * - `pixels`      What it looked like. Evidence for a finding another channel already
 *                 made — never the accusation itself.
 *
 * @typedef {'meaning'|'effects'|'complaints'|'results'|'contract'|'counters'|'pixels'} Channel
 */

/**
 * Where an observation came from, when it matters which platform produced it.
 * @typedef {'cli'|'library'|'server'|'web'|'electron'|'android'|'ios'|'windows'} Surface
 */

// ---------------------------------------------------------------------------
// Observations — one fact about the product at one moment
// ---------------------------------------------------------------------------

/**
 * A value we can write down, compare and store.
 *
 * `undefined` is deliberately not in this list. A fact we do not have is an ABSENT PATH,
 * not a path holding nothing — and telling those two apart is how appeared/vanished works.
 *
 * @typedef {string|number|boolean|null|any[]|Record<string, any>} ObservedValue
 */

/**
 * Anything extra that helps a human understand a difference, and nothing that is compared.
 *
 * Values in here are NEVER part of the comparison — they are context. Put the fact in
 * `value`; put the story in `meta`.
 *
 * @typedef {object} ObservationMeta
 * @property {string} [describe]      One plain sentence a person can read.
 * @property {string} [source]        Concretely where it came from: a file, a URL, a channel name.
 * @property {number} [line]          Line in `source`, for the contract channel.
 * @property {Surface} [surface]
 * @property {string} [journey]       Journey that produced it, when observations get mixed.
 * @property {string} [step]          Step within the journey.
 * @property {string} [evidence]      Path to a picture, a log, a HAR — proof, not comparison.
 * @property {boolean} [refused]      True when we stopped at the call boundary on purpose
 *                                    (money, a message, data loss). A refusal is missing
 *                                    coverage, never a pass.
 * @property {string} [refusedWhy]    Plain English: what we would have had to do.
 */

/**
 * One fact about the product at one moment.
 *
 * @typedef {object} Observation
 * @property {string} path            Stable dotted address. See PATH_RULES in observation.js.
 * @property {Channel} channel
 * @property {ObservedValue} value
 * @property {number} [at]            Milliseconds since the capture started. Never compared —
 *                                    it is a clock, and clocks are pure wobble.
 * @property {ObservationMeta} [meta]
 */

// ---------------------------------------------------------------------------
// Journeys — the named sequences that produce observations
// ---------------------------------------------------------------------------

/**
 * Where a journey came from, and it matters.
 *
 * - `code`      Read out of the source: routes, exports, IPC channels. Free and exact.
 * - `suite`     The project's own existing tests, run under instrumentation.
 * - `recorded`  A real session someone actually performed, frozen into a file.
 * - `explored`  The agent opened one named gap and froze what it found.
 *
 * Ranked by how much we trust them, best first. A finding from a `code` journey is a fact
 * about the product; a finding from an `explored` journey is a fact about one path an agent
 * happened to take, and it is reported that way.
 *
 * @typedef {'code'|'suite'|'recorded'|'explored'} JourneySource
 */

/**
 * One step of a journey. The driving lanes each extend this with their own keys —
 * a CLI step carries argv, a web step carries a selector — so the shape stays open.
 * @typedef {{act: string, note?: string} & Record<string, unknown>} JourneyStep
 */

/**
 * A named sequence of steps that produces observations.
 *
 * @typedef {object} Journey
 * @property {string} name            File-safe id. It becomes a folder name and the head of
 *                                    every path this journey produces.
 * @property {string} describe        One plain sentence: what this journey does.
 * @property {JourneySource} source
 * @property {Surface} surface
 * @property {string} [from]          Concretely where it came from — a test file, a recording,
 *                                    the source file a route was read out of.
 * @property {JourneyStep[]} [steps]
 * @property {Channel[]} [channels]   Channels this journey actually collects. Anything not
 *                                    listed is not claimed, and shows up in Coverage as a gap.
 * @property {boolean} [irreversible] A step here would spend money, send a message or destroy
 *                                    data. Observed at the call boundary, refused at the effect.
 * @property {string} [skip]          Why it is switched off. Skipped is missing coverage.
 * @property {number} [timeoutMs]
 */

// ---------------------------------------------------------------------------
// Captures — one run of one journey against one build
// ---------------------------------------------------------------------------

/**
 * Which build a capture ran against.
 *
 * `id` is content-addressed against the build artifact wherever that is possible — the
 * point being that two captures with the same `id` really did run the same bytes. Computing
 * it belongs to the build lane; this is only the shape it hands over.
 *
 * @typedef {object} BuildFingerprint
 * @property {string} id              File-safe. Content hash where we have one, else a run id.
 * @property {string} product         Which product this build is of. One repo can make five.
 * @property {Surface} [surface]
 * @property {string} [version]
 * @property {string|null} [gitSha]
 * @property {string|null} [branch]
 * @property {boolean} [dirty]        Working tree had uncommitted changes.
 * @property {string} [artifact]      Path to the built thing. NOT stored here — see store.js.
 * @property {string} [builtAt]       ISO timestamp.
 * @property {string} [platform]      e.g. 'darwin-arm64'. Comparing across platforms warns.
 * @property {string} [tool]          Stays Fixed version that captured it.
 */

/**
 * Which of the two runs of the same build this is.
 *
 * We run the new build TWICE, so `a` and `b` are the same bytes minutes apart, and anything
 * that disagrees between them is the product arguing with itself. `single` is one run with
 * no wobble measurement — honest, but weaker, and it has to say so.
 *
 * @typedef {'a'|'b'|'single'} CaptureRun
 */

/**
 * One run of one journey against one build.
 *
 * @typedef {object} Capture
 * @property {string} id              Sortable: '20260829-013245-a'.
 * @property {string} journey         Journey name.
 * @property {JourneySource} [source] Copied off the journey so a stored capture explains itself.
 * @property {BuildFingerprint} build
 * @property {CaptureRun} run
 * @property {string} startedAt       ISO timestamp.
 * @property {number} durationMs
 * @property {Observation[]} observations
 * @property {Coverage} [coverage]    What this capture did NOT manage to look at.
 * @property {boolean} [complete]     False when the file was read back torn — see store.js.
 * @property {string} [note]
 * @property {string} [rules]         Fingerprint of what the normalisation rules DO, if any
 *                                   were applied. Scope is stamped separately — see rulesScope.
 * @property {Record<string, string[]>} [rulesScope]
 *                                   Where each scoped rule applied, by rule id. Absent on
 *                                   captures written before this was stamped, which is a real
 *                                   state and says "cannot be compared" rather than "nothing".
 */

// ---------------------------------------------------------------------------
// Wobble — what a build disagrees with itself about
// ---------------------------------------------------------------------------

/**
 * One path that would not sit still between two runs of the SAME build.
 *
 * @typedef {object} WobbleEntry
 * @property {string} path
 * @property {Channel} channel
 * @property {DifferenceKind} kind   `appeared` / `vanished` is the worst kind: the product
 *                                   does not agree with itself about what exists.
 * @property {ObservedValue} [a]     Value in the first run, when it had one.
 * @property {ObservedValue} [b]     Value in the second run, when it had one.
 * @property {number} distance       Rough size of the disagreement, 0..1. For ranking and for
 *                                   reading. NEVER a threshold — v2 has no tolerances.
 */

/**
 * What differed between two runs of the same build: the product's own noise, measured
 * rather than guessed.
 *
 * @typedef {object} Wobble
 * @property {string} buildId
 * @property {string} journey
 * @property {[string, string]} runs  The two capture ids that were compared.
 * @property {WobbleEntry[]} entries  Sorted by path.
 * @property {string[]} unstable      Just the paths, for fast set arithmetic.
 * @property {number} steady          How many paths agreed. The denominator that makes the
 *                                    unstable count mean something.
 * @property {boolean} measured       False when only one run exists, so nothing was measured
 *                                    and the run must say so out loud.
 */

/**
 * What came out of subtracting the wobble from the differences.
 *
 * @typedef {object} WobbleSubtraction
 * @property {Difference[]} real      Differences at paths the build holds steady. These are
 *                                    the only ones worth an agent's tokens.
 * @property {Difference[]} noise     Differences at paths that wobble anyway.
 * @property {WobbleEntry[]} newlyUnstable
 *                                    Steady in the reference, wobbling now. Nobody else's tool
 *                                    catches this: the change made something unpredictable,
 *                                    which is a bug even though no value is "wrong".
 * @property {boolean} couldTellNewlyUnstable
 *                                    False when we had no stability record for the reference,
 *                                    so `newlyUnstable` is empty for lack of evidence rather
 *                                    than because nothing became unstable.
 * @property {boolean} [sameBuild]    True when the build being checked and the build on record
 *                                    as working are the same build. Nothing has been edited, so
 *                                    the two runs compared are two runs of ONE build and no
 *                                    difference between them can be a change. Everything found
 *                                    is in `noise`, still counted and still named.
 * @property {boolean} [couldNotTell] True when the wobble measurement was too big to be a
 *                                    measurement — the same build answered differently at
 *                                    most of its own addresses, so subtracting it subtracts
 *                                    the answer. A run in this state has no verdict, and it
 *                                    must never be reported as a clean one.
 * @property {string} [couldNotTellWhy]  Said plainly, with the numbers in it.
 * @property {string} note            One plain sentence stating exactly that.
 */

// ---------------------------------------------------------------------------
// Differences — reference against candidate
// ---------------------------------------------------------------------------

/**
 * `appeared` and `vanished` are the important ones. A path that stopped existing is a door
 * that closed, and no pixel comparison has ever noticed one.
 * @typedef {'changed'|'appeared'|'vanished'} DifferenceKind
 */

/**
 * One path that differs between the reference and the candidate.
 *
 * @typedef {object} Difference
 * @property {string} path
 * @property {Channel} channel
 * @property {DifferenceKind} kind
 * @property {ObservedValue} [reference]  Absent when the path appeared.
 * @property {ObservedValue} [candidate]  Absent when the path vanished.
 * @property {number} distance            Rough size, 0..1. Ranking only.
 * @property {string} [journey]
 * @property {boolean} [real]             Survived the wobble floor. Set by subtractWobble.
 * @property {boolean} [wobbling]         This path does not sit still in this build anyway.
 * @property {boolean} [proven]           Re-checked against the old build booted live, and it
 *                                        survived. Cheap suspicion, expensive proof.
 * @property {string} [describe]          One plain sentence, carried from the observation.
 * @property {string} [evidence]          A picture or log that shows it, for a human.
 */

// ---------------------------------------------------------------------------
// Findings — differences clustered into something worth acting on
// ---------------------------------------------------------------------------

/**
 * The classes an agent may never wave through on its own. Anything in one of these goes to a
 * person, whatever the agent believes it meant to change.
 * @typedef {'money'|'sign-in'|'data-loss'|'crash'|'guard'|'ordinary'} FindingClass
 */

/**
 * A cluster of differences with one likely cause, written for someone to act on.
 *
 * The whole point of clustering: one missing stylesheet is one finding, not four hundred
 * differences. An agent should be able to read the title and know what to go and look at.
 *
 * @typedef {object} Finding
 * @property {string} id              Stable across runs while the cause persists, so the same
 *                                    finding is not reported as new every time.
 * @property {string} title           Plain English, no jargon, no test ids: "Saving a session
 *                                    no longer writes the file."
 * @property {string} why             The likely cause, said plainly, and hedged when it is a guess.
 * @property {FindingClass} class
 * @property {Difference[]} differences
 * @property {number} rank            Higher is more urgent. Distance from the changed code is
 *                                    the biggest term: a break far from the edit is the very
 *                                    definition of a side effect.
 * @property {string} [signature]     What the cluster was grouped on.
 * @property {string[]} [nearFiles]   Source files the cluster points at, nearest first.
 * @property {boolean} [sealed]       In an unwaivable class. Goes to a person, full stop.
 * @property {string} [evidence]      A picture, a log, a diff — for the human, at the end.
 * @property {number} [count]         How many differences this one finding stands for. Five hundred
 *                                    differences are not five hundred findings, and the count is
 *                                    what stops a cluster hiding its own size.
 * @property {string} [summary]       One line, for a list. `title` is the headline; this is the
 *                                    sentence under it.
 * @property {string[]} [paths]       The addresses involved, for an agent that wants to look.
 * @property {Difference} [sample]    One representative difference, so a reader sees the shape
 *                                    without being handed all of them.
 * @property {number} [distance]      How far from the code that changed. Bigger is more suspicious:
 *                                    a break far from the edit is the definition of a side effect.
 */

// ---------------------------------------------------------------------------
// Coverage — and mostly, what was NOT checked
// ---------------------------------------------------------------------------

/**
 * One thing we did not look at, and what it would take to look at it.
 *
 * This shape carries the self-description requirement: an agent installing the tool reads
 * `unlockedBy` and knows exactly what to install, start or supply. Nobody should have to read
 * documentation to wire this up.
 *
 * @typedef {object} CoverageGap
 * @property {string} what            What is not covered, in plain English.
 * @property {string} why             Why not: missing runtime, refused effect, no snapshot,
 *                                    old build will not compile.
 * @property {string} [unlockedBy]    The concrete thing that would fix it: "install a Java
 *                                    runtime", "add an SSH host", "supply a database snapshot".
 * @property {Channel} [channel]
 * @property {Surface} [surface]
 * @property {number} [doors]         How many addressable things this gap hides, when countable.
 */

/**
 * What was checked and, much more importantly, what was not.
 *
 * A tool that reports "nothing changed" is indistinguishable from a broken tool. Coverage is
 * how the difference is made visible instead of pretended away.
 *
 * @typedef {object} Coverage
 * @property {number} paths           Addresses observed.
 * @property {number} journeys        Journeys walked.
 * @property {Partial<Record<Channel, number>>} byChannel   Paths observed per channel.
 * @property {number} [doorsKnown]    Doors the contract channel found in the source.
 * @property {number} [doorsWalked]   How many of those any journey actually opened.
 * @property {CoverageGap[]} gaps     Everything we could not see. Never empty on a real run.
 */

// ---------------------------------------------------------------------------
// Verdict — what a whole run concluded
// ---------------------------------------------------------------------------

/**
 * How the reference was obtained, because it changes how much the answer is worth.
 *
 * - `paired`         The old build was booted live on this machine, in this minute.
 * - `stored-record`  Compared against observations stored the last time the old build ran.
 *                    Genuinely weaker: it lets back in every difference that comes from the
 *                    day being different. It must announce itself in those words, every run.
 *
 * @typedef {'paired'|'stored-record'} ReferenceMode
 */

/**
 * What a whole run concluded.
 *
 * @typedef {object} Verdict
 * @property {string} runId
 * @property {string} product
 * @property {boolean} ok             Nothing unintended survived the wobble floor.
 * @property {ReferenceMode} mode
 * @property {string} [modeWarning]   Present whenever `mode` is 'stored-record'.
 * @property {BuildFingerprint} reference
 * @property {BuildFingerprint} candidate
 * @property {Finding[]} findings     Ranked, worst first. The only thing an agent should read.
 * @property {number} differencesReal
 * @property {number} differencesNoise
 * @property {WobbleEntry[]} newlyUnstable
 * @property {Coverage} coverage
 * @property {string} summary         One paragraph of plain English. What changed, what did not,
 *                                    what was not looked at.
 * @property {number} durationMs
 * @property {string} startedAt
 * @property {string} [tool]
 */

export {};

// ---------------------------------------------------------------------------
// Normalisation — the rules that decide what is a difference and what is churn
// ---------------------------------------------------------------------------

/**
 * What a rule does to a value.
 *
 * - `replace`  Rewrite text that matches a pattern. The workhorse.
 * - `round`    Cut a float back to a sane number of digits.
 * - `sort`     Put an unordered collection in a fixed order.
 * - `drop`     Remove a piece of the value entirely. The dangerous one — it does not
 *              normalise a difference, it deletes the ability to see one. Ships unused.
 *
 * @typedef {'replace'|'round'|'sort'|'drop'} RuleKind
 */

/**
 * One normalisation rule.
 *
 * Rules are DATA, not code: every field here survives `JSON.stringify`, so a project keeps
 * its own rules in git beside its config, reviews them in a pull request, and can see exactly
 * what its tool is choosing not to look at.
 *
 * `wouldHide` is required by convention rather than by the type system, and no rule should
 * ship without one. A rule set nobody can audit is how a difference machine goes quiet.
 *
 * @typedef {object} NormaliseRule
 * @property {string} id              Stable, dotted: 'clock.iso', 'id.uuid'.
 * @property {RuleKind} kind
 * @property {string} what            Plain English: what this rewrites.
 * @property {string} why             Plain English: why it churns without this.
 * @property {string} wouldHide       Plain English: the real change this would wrongly hide.
 * @property {string} [pattern]       replace: a regular expression, as a string.
 * @property {string} [flags]         replace: default 'g'.
 * @property {string} [with]          replace: what to put in its place. '$1' works.
 * @property {boolean} [numbers]      replace: also test numeric values, whole-value only.
 * @property {boolean} [keys]         replace: also rewrite object keys. Can merge two entries
 *                                    into one — off unless a rule says otherwise.
 * @property {number} [digits]        round: significant digits to keep.
 * @property {string[]} [paths]       Path globs this rule applies to. Default: every path.
 * @property {Channel[]} [channels]   Channels this rule applies to. Default: every channel.
 * @property {string[]} [at]          Globs over the position INSIDE the value, written
 *                                    '$.items.3.name'. Used by sort, round and drop.
 * @property {boolean} [off]          Shipped, documented, and not switched on.
 * @property {string} [whyOff]        Why it is not on by default.
 * @property {boolean} [machine]      This rule's pattern is a fact about THIS machine — where
 *                                    the project is checked out, where home is, where the temp
 *                                    folder went today — rather than a decision about what to
 *                                    tidy. Two machines running the same rule write the same
 *                                    placeholder, so the rule is the same rule and its pattern
 *                                    must not reach the fingerprint. See rulesFingerprint.
 */

/**
 * One thing a rule actually changed, so a difference hidden by normalisation can be audited.
 * @typedef {object} Replacement
 * @property {string} ruleId
 * @property {string} what
 * @property {string} why
 * @property {string} wouldHide
 * @property {string} at              Where inside the value: '$', '$.items.3.id'.
 * @property {string} before
 * @property {string} after
 */

/**
 * @typedef {object} Explanation
 * @property {ObservedValue} value            The value after normalising.
 * @property {Replacement[]} replacements     Every change, in the order they were made.
 * @property {string} summary                 One plain sentence for a report.
 */

// ---------------------------------------------------------------------------
// Store — where observations live on disk
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Store
 * @property {string} root            Project root.
 * @property {string} dir             The v2 folder: <root>/.staysfixed/v2.
 * @property {string} buildsDir       <dir>/builds — one folder per build fingerprint.
 * @property {string} referencesFile  <dir>/references.json — which build is 'working', per product.
 */

/**
 * Enough to find one stored capture again.
 * @typedef {object} CaptureRef
 * @property {string} buildId
 * @property {string} journey
 * @property {string} captureId
 * @property {string} file            Absolute path to the JSONL file.
 */

/**
 * What the store remembers about a build. The build ARTIFACT is not kept here — a paired
 * system that stored every binary would run to tens of gigabytes a year. Artifacts are kept
 * only at markers, by another part of the tool; this record just says where one was.
 *
 * @typedef {object} BuildRecord
 * @property {BuildFingerprint} fingerprint
 * @property {string} firstSeenAt
 * @property {string} lastSeenAt
 * @property {number} captures        How many capture files are stored for it.
 * @property {string[]} journeys      Journey names captured against it.
 * @property {boolean} [isReference]  Filled in by referenceFor / listBuilds.
 */

/**
 * Which build a product currently calls 'working'.
 *
 * Cut by an act Asad already performs — saying ship — never by an agent, and never by the
 * tool deciding on its own that a run looked fine.
 *
 * @typedef {object} ReferencePointer
 * @property {string} product
 * @property {string} buildId
 * @property {string} setAt
 * @property {string} [setBy]         'ship-everywhere', a person, a command.
 * @property {string} [note]
 */
