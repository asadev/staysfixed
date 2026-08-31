/**
 * Journeys that CALL what a library exports, instead of only looking at it.
 *
 * THE HOLE THIS FILLS, measured 2026-08-31 on a four-line library. A project whose whole
 * product is `export function slug(text)` and `export function isReserved(word)` was set up,
 * checked and shipped with this tool. Then the separator inside `slug` was changed from "-"
 * to "_" and one word was dropped from the reserved list — so every web address the library
 * produces became a different string, and `isReserved('admin')` went from true to false. A
 * check answered:
 *
 *     ok Nothing that worked has changed. 13 addresses checked against the stored record.
 *
 * and exited 0. Nothing was broken about that run: it compared what it had, and what it had
 * was the NAMES and the SHAPES of the exports — "slug: a function taking 1 argument" — which
 * had not moved by one character. No channel anywhere in the tool had ever called the
 * function. On a library, the names and the shapes are the packaging; the answers are the
 * product. Comparing only the packaging and then saying "nothing that worked has changed" is
 * a false all-clear, which is the one answer this tool may never give.
 *
 * WHAT THIS FILE DOES. For every module the settings already name under `process.imports`, it
 * adds one more journey beside the existing shape journey: run `answers-probe.js` against
 * that module inside the same scratch copy, with the same stopped clock and the same watcher
 * refusing every outbound connection, and print one line per call. Those lines are ordinary
 * output and are compared like any other output, so an answer that changes fails the check
 * with the old value and the new one side by side.
 *
 * WHY ONE JOURNEY PER MODULE AND NOT ONE PER FUNCTION. One per function would give every
 * exported name its own address, which reads better in a report — and it costs one process
 * and two folder snapshots per function per build per run. Measured on this machine on
 * 2026-08-31: twelve extra journeys took a check from 1.4 to 8.2 seconds, about 570ms each,
 * on a project where the journeys did nothing at all. A library of forty exports would pay
 * half a minute on every check for a nicer heading. One journey per module costs one process,
 * and the printed block names the function and the input on every single line, so a
 * difference still says exactly which function changed and what it now answers.
 *
 * WHAT IS NEVER CALLED, and it is named in the output rather than skipped quietly: anything
 * whose name says it deletes, sends, publishes, charges or migrates; anything that is really
 * a class; and anything the probe ran out of time or budget to reach. See
 * `whyItWouldNotBeCalled` for the rule and `answers-probe.js` for the rest of the boundary.
 */

import { fileURLToPath } from 'node:url';

import { joinPath, notCovered, observation } from '../adapters/contract.js';
import { IRREVERSIBLE_WORDS, wordsIn } from './from-routes.js';

/** @typedef {import('../types.js').Journey} Journey */

// ---------------------------------------------------------------------------
// The contract between this file and the probe it runs
// ---------------------------------------------------------------------------

/**
 * How the answers are told apart from anything the module printed on its way in.
 *
 * The shape probe learned this the hard way: without a marker, one line printed at import
 * time — a dotenv banner, a deprecation warning, anything — was enough to make the whole
 * reading unusable. The same trap is here, so the same fence is.
 */
export const ANSWERS_START = '<<< staysfixed: what it answers >>>';

/** Where the answers stop and the accounting starts. */
export const ANSWERS_END = '<<< staysfixed: end of answers >>>';

/** The line naming every function that really was called. Read back by the coverage ledger. */
export const CALLED_PREFIX = 'called: ';

/** One line per function that was NOT called, and why. */
export const NOT_CALLED_PREFIX = 'not called: ';

/**
 * The kinds of hole a not-called line may claim, in brackets after the name.
 *
 * Checked against a list rather than trusted, because the value goes straight into the
 * sentence the owner reads and an unrecognised one would print as a reason nobody wrote.
 * Anything not in here falls back to a plain refusal, which is the weakest true statement.
 */
const REFUSAL_KINDS = new Set(['irreversible', 'not supported here', 'crashed', 'timed out', 'refused']);

/**
 * How many arguments a function is given at most.
 *
 * The ladder below has a dozen rungs. Every combination of it across three slots is over a
 * thousand calls for one function, which is a cost nobody agreed to for an answer nobody
 * reads, so each rung fills every slot with the same value instead.
 */
export const MAX_ARGS = 3;

/**
 * How many functions one module's probe will call.
 *
 * A cap that bites is printed as a hole with the names in it, so a big library is told what
 * was not looked at rather than being quietly half-checked.
 */
export const MAX_FUNCTIONS = 40;

/** How long one call may take before its answer is abandoned. */
export const PER_CALL_MS = 1000;

/** How long the whole probe may spend calling before it stops and names what it did not reach. */
export const WHOLE_RUN_MS = 20_000;

/**
 * The fixed inputs every function is called with.
 *
 * FIXED, and never generated. This tool throws away any address that cannot answer the same
 * way twice on one build, so a probe that fuzzed its inputs would produce a great deal of
 * noise and nothing that could ever be compared. These are ordinary values a library actually
 * receives, plus the empty and the wrong ones — "used to throw on null, now returns
 * undefined" is a real change and a ladder of only sensible inputs would never see it.
 *
 * The strings are chosen against what libraries actually do to strings: case, surrounding
 * space, a word products reserve, and one containing every separator a slug function might
 * join with — which is the exact shape of the change that produced the false all-clear this
 * file exists to stop.
 */
export const PROBE_INPUTS = Object.freeze([
  { shown: '""', value: '' },
  { shown: '"Hello World"', value: 'Hello World' },
  { shown: '"  Admin Panel  "', value: '  Admin Panel  ' },
  { shown: '"admin"', value: 'admin' },
  { shown: '"a-b_c.d e"', value: 'a-b_c.d e' },
  { shown: '0', value: 0 },
  { shown: '1', value: 1 },
  { shown: '-1', value: -1 },
  { shown: 'true', value: true },
  { shown: 'null', value: null },
  { shown: 'undefined', value: undefined },
  { shown: '[]', value: [] },
]);

/**
 * How one input is written in the output line.
 * @param {{shown: string}} input
 * @returns {string}
 */
export function describeInput(input) {
  return input.shown;
}

/**
 * Why this exported function will not be called, or empty when it will be.
 *
 * THE SAME GENEROUS GUESS THE TOOL ALREADY MAKES, in the same words. A route or a command
 * whose name contains "delete", "publish" or "charge" is never opened for real; an exported
 * function of that name is somebody's code that does the same thing, and calling it because
 * it happened to be exported would be this tool causing the exact kind of damage it exists to
 * catch. Refusing one that was actually harmless costs a little coverage and says so out
 * loud. Calling one that was not sends a real email. Those are the two mistakes available and
 * the first one is the one to make.
 *
 * This is deliberately NOT wired into `irreversibility()` in from-routes.js, and that is a
 * decision rather than an oversight. That function answers "should the ledger treat this door
 * as unwalkable", and it excludes exports on purpose: most exports are constants, and a
 * constant called `AGENTS_REMOVE_CHANNEL` is not dangerous to read. The rule here fires only
 * where the export turns out at run time to be a FUNCTION, which is the only case where the
 * word in the name is about to become an action.
 *
 * @param {string} name
 * @returns {string} Empty when it is safe to call.
 */
export function whyItWouldNotBeCalled(name) {
  const words = new Set(wordsIn(name));
  for (const entry of IRREVERSIBLE_WORDS) {
    if (words.has(entry.word)) {
      return `its name contains "${entry.word}", so ${entry.why}, and this tool never calls a stranger's code that might do that.`;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Building the journeys
// ---------------------------------------------------------------------------

/** Where the probe program lives, as an absolute path on this machine. */
export function answersProbePath() {
  return fileURLToPath(new URL('./answers-probe.js', import.meta.url));
}

/**
 * Quoted so a path with a space in it is still one argument.
 *
 * Double quotes rather than single ones, because the command is handed to whatever shell the
 * machine has and single quotes mean nothing at all to the Windows one. A path containing a
 * double quote would still break this — and it would break loudly, as a probe that printed
 * nothing and exited non-zero, which the run already reports as a hole rather than a pass.
 *
 * @param {string} text
 * @returns {string}
 */
function quoted(text) {
  return `"${String(text).split('"').join('')}"`;
}

/**
 * The command line that calls one module's exports and prints the answers.
 *
 * It runs the Node that is running this tool. A bare `node` would take whatever version the
 * scratch shell happens to find, and two builds walked on two different Node versions is a
 * difference nobody caused arriving as a finding.
 *
 * @param {string} moduleId
 * @returns {string}
 */
export function answersCommand(moduleId) {
  return `${quoted(process.execPath)} ${quoted(answersProbePath())} ${quoted(moduleId)}`;
}

/**
 * The name of the answers journey for one configured import.
 * @param {string} entryName
 * @returns {string}
 */
export function answersJourneyName(entryName) {
  return `what ${entryName} answers`;
}

/**
 * One answers journey for every module the settings already name.
 *
 * Nothing new has to be configured for this to work, and that is the point: `staysfixed init`
 * already writes `process.imports` for any project that is a library, so every library
 * already set up with this tool gets the answers compared the next time it is checked,
 * without anybody editing a settings file they do not know exists.
 *
 * @param {object} input
 * @param {Record<string, any>} [input.config]   The `process` section of the settings.
 * @returns {{journeys: Journey[], gaps: import('../types.js').CoverageGap[]}}
 */
export function journeysFromExports(input) {
  /** @type {Journey[]} */
  const journeys = [];
  /** @type {import('../types.js').CoverageGap[]} */
  const gaps = [];

  const imports = Array.isArray(input.config?.imports) ? input.config.imports : [];
  for (const entry of imports) {
    if (!entry || typeof entry !== 'object' || !entry.module) continue;
    const entryName = String(entry.name ?? entry.module);
    const moduleId = String(entry.module);
    journeys.push({
      name: answersJourneyName(entryName),
      describe: `call everything ${moduleId} exports, with fixed inputs, and compare the answers`,
      source: 'code',
      surface: 'library',
      from: 'the project config',
      channels: ['results', 'complaints', 'effects', 'counters'],
      steps: [{ act: 'run', run: answersCommand(moduleId) }],
      // Long enough for the probe's own budget plus the cost of starting Node and importing a
      // module that may itself be slow to load. The probe stops itself first in the ordinary
      // case; this is only the outer stop for a module that hangs on import.
      timeoutMs: WHOLE_RUN_MS + 25_000,
    });
  }

  if (imports.length > 0) {
    // Said on every run that has one of these journeys, because it is true on every one of
    // them and a reader who is told "the answers are compared" will otherwise assume all of
    // them are.
    gaps.push({
      what: 'The exported functions are called with a fixed list of inputs, and only those.',
      why:
        `Each one is called with no arguments and then with ${PROBE_INPUTS.length} fixed values — the empty string, ` +
        'some ordinary text, a number, true, null, undefined and an empty list. A function that only answers ' +
        'differently on an input that is not in that list would answer identically here. Functions whose names say ' +
        'they delete, send, publish, charge or migrate are never called at all, and neither are classes; each one is ' +
        'named in the printed answer sheet with the reason.',
      unlockedBy:
        'Write a journeys file that calls them with the inputs that matter to this product and pass it with --journeys, ' +
        'or point the check at the tests you already have with --journeys suite.',
      surface: 'library',
    });
  }

  return { journeys, gaps };
}

// ---------------------------------------------------------------------------
// Reading the answer sheet back
// ---------------------------------------------------------------------------

/**
 * ONE ADDRESS PER CALL, not one address for the whole sheet.
 *
 * The process adapter reports whatever a command printed as a single value at
 * `cli.<journey>.stdout`, and the first working version of this feature left it that way. It
 * caught the regression — and the finding read:
 *
 *     "what the package entry answers / stdout" now reads "…eserved(\"admin\") -> false\n…"
 *     where it read "…eserved(\"admin\") -> true\n…"
 *
 * which is a true statement nobody outside this codebase can act on. It is a window onto the
 * middle of a wall of text, it names no function, and a library where ten functions changed
 * reads exactly the same as one where a single character did.
 *
 * So the sheet is taken apart here. Every call becomes its own observation at
 * `export.<module>.<function>.<the input it was given>`, and the finding then reads
 * "index.js / slug / (\"Hello World\") now reads \"hello_world\" where it read \"hello-world\"",
 * which is a sentence an owner can act on without knowing anything about this tool.
 *
 * THE ADDRESS IS NOT DECORATION. `export.<file>.<name>` is exactly the address the code
 * reader writes down for that same exported name, so the coverage ledger joins the two on its
 * own and the function counts as genuinely opened — because it genuinely was called. A
 * function the probe refused is written down at that address as a refusal instead, which the
 * ledger deliberately does NOT count as opened, so a refused function stays visible as a hole.
 *
 * The raw sheet is dropped once it has been taken apart, because keeping it would report
 * every change twice: once per call, and again as a wall of text. Anything the module printed
 * on its way in sits in front of the marker and is kept, because a library that starts
 * printing a warning on import has changed and that is worth knowing.
 *
 * @param {import('../adapters/contract.js').Observation[]} observations
 * @param {import('../types.js').Journey} journey
 * @returns {import('../adapters/contract.js').Observation[]}
 */
export function splitAnswerSheet(observations, journey) {
  const stdoutPath = joinPath('cli', journey.name, 'stdout');
  const sheet = observations.find((o) => o.path === stdoutPath);
  const text = typeof sheet?.value === 'string' ? sheet.value : '';
  const start = text.indexOf(ANSWERS_START);
  const end = text.indexOf(ANSWERS_END);
  // No marker, or no closing marker, means the probe never finished. That is a hole and it is
  // already reported as one by the run around this — the command printed nothing usable and
  // its exit code is compared — so the sheet is left exactly as it is rather than being half
  // read. A half-finished sheet read as a full one is how a function that was never called
  // ends up counted as covered.
  if (!sheet || start === -1 || end === -1 || end < start) return observations;

  const body = text.slice(start, end).split('\n');
  const after = text.slice(end).split('\n');
  const moduleId = (body.find((l) => l.startsWith('module: ')) ?? '').slice('module: '.length).trim() || journey.name;

  /** @type {import('../adapters/contract.js').Observation[]} */
  const out = [];
  /** @type {string[]} */
  const unreadable = [];
  const calledNames = new Set();

  for (const line of body) {
    if (line === '' || line === ANSWERS_START || line.startsWith('module: ')) continue;
    const close = line.indexOf(') -> ');
    const open = line.indexOf('(');
    if (close < 0 || open <= 0 || close < open) {
      // Not a call, so it is an exported VALUE: `NAME = "something"`. Its address is the
      // exported name itself with nothing after it, because there is no input — and that is
      // the same address the code reader writes down, so a constant whose value moved is a
      // finding and the door counts as genuinely opened.
      const equals = line.indexOf(' = ');
      if (equals <= 0) { unreadable.push(line); continue; }
      const constant = line.slice(0, equals);
      const held = line.slice(equals + 3);
      calledNames.add(constant);
      out.push(observation({
        channel: 'results',
        path: ['export', moduleId, constant],
        value: held,
        says: `${moduleId} exports ${constant}, and it holds ${held}. If this changes, everything reading it gets a different value without asking for one.`,
        journey: journey.name,
      }));
      continue;
    }
    const name = line.slice(0, open);
    const given = line.slice(open, close + 1);
    const answer = line.slice(close + ') -> '.length);
    calledNames.add(name);
    out.push(observation({
      channel: 'results',
      // THE LAST SEGMENT CARRIES THE WHOLE CALL, and that is not decoration either. The
      // report writes its headline from the last part of an address, so a segment holding
      // only the input produced 'In what the program gives back, "("admin")" is now "false"
      // where it was "true"' — a sentence with no function in it, on a library that exports
      // six of them. With the name in front it reads 'isReserved("admin") is now false where
      // it was true', which is the whole finding in one line. The name is still its own
      // segment in front, so the coverage ledger goes on matching this to the exported name
      // the code reader found.
      path: ['export', moduleId, name, `${name}${given}`],
      value: answer,
      says: `${moduleId} — calling ${name}${given} answers ${answer}. If this changes, everything that calls it gets a different answer without asking for one.`,
      journey: journey.name,
    }));
  }

  for (const line of after) {
    if (!line.startsWith(NOT_CALLED_PREFIX)) continue;
    const rest = line.slice(NOT_CALLED_PREFIX.length);
    const dash = rest.indexOf(' — ');
    if (dash <= 0) { unreadable.push(line); continue; }
    const head = rest.slice(0, dash).trim();
    const why = rest.slice(dash + 3).trim();
    // "name (kind)". The kind picks the sentence the owner reads. Reporting a refusal to call
    // `deleteEverything` under the same words as a class this tool cannot construct — "the
    // project asked us not to" — is true of neither and reads as a setting somebody chose.
    const bracket = /^(.*?)\s+\(([^)]+)\)$/.exec(head);
    const name = (bracket ? bracket[1] : head).trim();
    const kind = bracket ? bracket[2].trim() : '';
    const reason = /** @type {import('../adapters/contract.js').NotCoveredReason} */ (
      REFUSAL_KINDS.has(kind) ? kind : 'refused'
    );
    out.push(notCovered({
      channel: 'results',
      path: ['export', moduleId, name],
      reason,
      says: `${moduleId} exports ${name} and nothing called it: ${why} Its name and its shape are compared; what it does is not, so a version of it that behaves differently would look identical here. This is a hole, not a pass.`,
    }));
  }

  out.push(observation({
    channel: 'counters',
    path: ['count', moduleId, 'functions called'],
    value: calledNames.size,
    says: `${calledNames.size} of the functions ${moduleId} exports were called and had their answers compared.`,
    journey: journey.name,
  }));

  if (unreadable.length > 0) {
    // A line this file could not read is a call whose answer is not being compared, and the
    // only wrong thing to do with it is nothing. It is counted as a hole with the lines in it,
    // so a change to the probe's own output format shows up as missing coverage rather than as
    // a quietly smaller number of addresses.
    out.push(notCovered({
      channel: 'results',
      path: ['export', moduleId, 'the answer sheet'],
      reason: 'not supported here',
      says:
        `${unreadable.length} ${unreadable.length === 1 ? 'line' : 'lines'} of the answer sheet could not be read back, so ` +
        `${unreadable.length === 1 ? 'that call is' : 'those calls are'} not compared: ${unreadable.slice(0, 3).join(' / ')}` +
        `${unreadable.length > 3 ? `, and ${unreadable.length - 3} more` : ''}. This is a hole, not a pass.`,
    }));
  }

  // What the module printed on its way IN, which is everything before the marker. Kept at the
  // address it already had, so a library that starts printing a deprecation warning on import
  // is still caught. Empty is fine and is compared as empty.
  const before = text.slice(0, start);
  return [
    ...observations.filter((o) => o !== sheet),
    observation({
      channel: sheet.channel,
      path: stdoutPath,
      value: before,
      says: `What "${journey.describe}" printed before it started calling anything. A library normally prints nothing here.`,
      journey: journey.name,
    }),
    ...out,
  ];
}

/**
 * Is this journey one of the answer sheets this file makes?
 * @param {import('../types.js').Journey} journey
 * @returns {boolean}
 */
export function isAnAnswerJourney(journey) {
  return journey?.surface === 'library' && typeof journey?.name === 'string' && journey.name.startsWith('what ') && journey.name.endsWith(' answers');
}
