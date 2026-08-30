/**
 * The command line for version 2 — the difference engine.
 *
 * `staysfixed check` stays the front door, because it is the thing everybody
 * already types, but it now means something bigger: run the build you have
 * against the build you were happy with, and report only what changed that
 * nobody asked for.
 *
 * NOTHING THAT WORKED THIS MORNING MAY BREAK. Somebody installed this yesterday
 * and has `staysfixed check --guards` in a git hook. So the version 1 commands
 * are not removed, not renamed and not deprecated with a warning: the same flags
 * they always typed still reach the same code. `--pictures` and `--guards` are
 * the version 1 check, exactly as before. `check` with neither of them is the
 * difference engine. That is the whole migration.
 *
 * `--watch` is the one flag that moved, and deliberately. It opens the live panel
 * beside whatever is being checked, and that panel is now version 2's — the one
 * built for a difference engine, which draws journeys, wobble, findings and a
 * verdict. Version 1's panel drew approved pictures, which this tool no longer
 * has. `--pictures --watch` and `--guards --watch` still open version 1's panel
 * over version 1's run, so the only person whose command changed meaning is the
 * one who typed `--watch` on its own and got a picture check they did not ask for.
 *
 * This module deliberately holds no engine logic. It parses, it delegates, and
 * it says what came back in plain English — which is the one job that has to
 * sound the same whether a person or an agent is reading it.
 */

import { StaysFixedError, EXIT, messageOf } from '../core/errors.js';
import { say, ok, warn, fail, blank, heading, paint, duration, setLogLevel } from '../core/log.js';
import { openStore } from './store.js';
import { SHIP_COMMANDS } from './ship.js';
import { escalationBlock, escalationsFor, productFor, writeEscalations } from './escalate.js';
// The one reader of the panel flags, shared with version 1 so `--watch-side` cannot come
// to mean two different things depending on which check you ran. src/cli/index.js imports
// this file in turn; that circle is safe because nothing here touches it while either
// module is still being evaluated.
import { watchFlags } from '../cli/watch-flags.js';
import { INIT_COMMANDS } from './init.js';

/**
 * What comes back from a check. Everything that did not change never appears
 * here at all, which is the entire point of the tool. The full shape is
 * `Verdict` in src/v2/run.js; these are the parts the command line reads.
 *
 * @typedef {import('./types.js').Verdict} Verdict
 * @typedef {import('./types.js').Finding} Finding
 */

/**
 * How many lines any one list in the report is allowed to run to. Past this it
 * stops being something a person reads and starts being something they skim,
 * and the rest is one count away in --json.
 */
const MOST_LINES = 6;

/** The flags the difference engine adds. Declared once so help and parsing agree. */
const V2_SPEC = {
  booleans: ['paired', 'selfcheck', 'json'],
  strings: ['against', 'journeys', 'escalations', 'surface', 'at'],
};

/** @type {[string, string][]} */
const V2_OPTIONS = [
  ['--against <ref>', 'Compare against this marker, tag or commit instead of the newest reference.'],
  ['--paired', 'Boot the old build live from the start instead of trusting the stored record. Slower, and the strongest answer there is.'],
  ['--journeys <source>', 'Where the steps come from: suite, code, recorded, or a path to a journeys file.'],
  ['--surface <kind>', 'Check only one kind of product: cli, library, server, web, electron, android, ios or windows. Nothing else is walked, and a run that cannot reach it says so instead of quietly checking something else.'],
  ['--at <where>', 'Where that product is: a URL for the web, the built app for a desktop, the APK or the .app for a phone.'],
  ['--selfcheck', 'Run the deliberately broken builds and prove the engine still catches them.'],
  ['--json', 'Print the whole result as JSON and nothing else. This is what an agent reads.'],
  ['--escalations <file>', 'Write the handful of things a person has to rule on into a file, in plain English, ready to paste into a closing summary.'],
];

/**
 * The version 1 flags, kept working word for word — plus `snap`, which never worked
 * anywhere.
 *
 * `--no-snap` is documented at the top of src/cli/check.js and read there as
 * `ctx.flags.snap`, and it was in no command's list of known flags, so typing it got
 * "I do not know the option --no-snap" from both `check` and `walk`. A flag that is
 * read but never declared is worse than one that does not exist: the code that reads
 * it looks finished.
 */
const V1_SPEC = {
  booleans: ['guards', 'pictures', 'record', 'report', 'watch', 'watch-front', 'keep-open', 'profile', 'snap'],
  strings: ['watch-side', 'watch-width'],
  arrays: ['only'],
};

/** @type {[string, string][]} */
const WATCH_OPTIONS = [
  ['--watch', 'Open a window beside what is being checked and watch it happen, live. Without this, a desktop app under check is moved off the screen rather than appearing in front of you.'],
  ['--watch-side <side>', 'Which side of the app the window sits on: left or right. Default right.'],
  ['--watch-width <px>', 'How wide that window is. Default 480.'],
  ['--watch-front', 'Let the window come to the front when it opens. Off by default, on purpose.'],
  ['--no-keep-open', 'Close the window when the check finishes instead of leaving the result up.'],
  ['--no-snap', 'Leave both windows where they are instead of putting them side by side.'],
];

/** @type {[string, string][]} */
const V1_OPTIONS = [
  ['--pictures', 'The version 1 picture check, unchanged.'],
  ['--guards', 'The version 1 guards, unchanged.'],
  ['--only <name>', 'Just this journey, screen or guard. Repeat it for several.'],
  ['--record', 'The version 1 run that records network fixtures.'],
  ['--report / --no-report', 'Write the version 1 HTML report. Version 1 checks only.'],
  ['--profile', 'Print where the time went. Version 1 checks only.'],
];

/**
 * Flags only version 1's check reads, by the name the parser knows them under.
 *
 * They are accepted on every `check` because the two halves share one spec — which is right,
 * since `--pictures --profile` has to work. What was wrong is that typing one WITHOUT
 * `--pictures` or `--guards` did nothing at all and said nothing at all: `staysfixed check
 * --profile` ran a perfectly ordinary difference-engine check, printed no profile, and gave
 * no hint that the flag had been ignored. A flag that is accepted and does nothing is the
 * same lie as a flag that does not exist, and a slower one to find.
 */
const V1_ONLY_FLAGS = [
  ['profile', '--profile'],
  ['report', '--report'],
  ['record', '--record'],
];

/**
 * The commands version 2 contributes. `src/cli/index.js` merges these over version 1's,
 * so `check` and `doctor` become the difference engine while everything version 1 did
 * stays reachable behind `--pictures`, `--guards` and `--watch`.
 */
export const V2_COMMANDS = {
  // Version 2's init replaces version 1's.
  //
  // It was held back on the grounds that somebody might have `staysfixed init` in a
  // setup script and would get a different file. True, and not a reason: the old one
  // writes settings for photographing screens, which is not what this tool does any
  // more, so leaving it in place hands a new project the wrong shape and calls it done.
  // The three tests in test/cli.test.js were rewritten in the same change to say what
  // the new one actually does.
  ...INIT_COMMANDS,
  ...SHIP_COMMANDS,

  check: {
    summary: 'Prove nothing that already worked has changed. This is the one you run.',
    usage: 'staysfixed check [--against <ref>] [--paired] [--journeys <source>] [--watch] [--json]',
    describe:
      'Runs your product through the same steps twice, compares it against the build you\nwere last happy with, subtracts anything the product disagrees with itself about,\nand reports only the differences that are left. Nothing that was already the same\nis mentioned at all — that is the point, and it is what keeps the answer short\nenough for an agent to read every word of it.\n\nSaying what you meant to change, and marking a difference as intended, are not\ndone from here. They need the files you expect to touch, and they are checked\nand counted, so they live where an agent works: the staysfixed_intent and\nstaysfixed_waive tools on the MCP server.\n\nWith --watch it opens a window beside what is being checked and draws the run as\nit happens. Nothing this tool opens is allowed to keep taking your screen: it may\ncome up once, and from the moment you pick something else it stays behind you.\n\nThe version 1 picture check is still here: add --pictures or --guards and nothing\nabout your old command changes.',
    options: [...V2_OPTIONS, ...WATCH_OPTIONS, ...V1_OPTIONS],
    examples: [
      'staysfixed check',
      'staysfixed check --json',
      'staysfixed check --against v0.13.0',
      'staysfixed check --paired',
      'staysfixed check --surface web --at http://localhost:3000',
      'staysfixed check --watch',
      'staysfixed check --selfcheck',
      'staysfixed check --pictures        # exactly what version 1 did',
    ],
    spec: {
      booleans: [...V2_SPEC.booleans, ...V1_SPEC.booleans],
      strings: [...V2_SPEC.strings, ...V1_SPEC.strings],
      arrays: [...V1_SPEC.arrays],
    },
    load: async () => ({ run }),
  },

  doctor: {
    summary: 'What this tool can and cannot check on this machine, and what would unlock more.',
    usage: 'staysfixed doctor [--json] [--offline] [--fix]',
    describe:
      'Looks at this machine rather than at your project: what is installed, which other\nmachines it can already reach, what each of those lets it watch, and what exactly\nis in the way of the rest. It never asks you to set up something that already\nworks — everything it lists as missing failed a real check first.\n\n--json is the same answer as an object, and it is the first thing an agent\nshould call. --fix repairs the small things version 1 could repair.',
    options: [
      ['--json', 'The whole answer as one JSON object. For agents.'],
      ['--offline', 'Do not dial any other machine. Faster, and reports no runners.'],
      ['--fix', 'Repair the small local things that can be repaired safely.'],
    ],
    examples: ['staysfixed doctor', 'staysfixed doctor --json'],
    spec: { booleans: ['json', 'offline', 'fix'] },
    load: async () => ({ run: doctorRun }),
  },
};

/**
 * `staysfixed doctor`. `--fix` is version 1's repair pass, which is still the
 * only thing in the tool that changes a file on disk without being asked twice.
 *
 * @param {import('../cli/index.js').CliContext} ctx
 * @returns {Promise<number>}
 */
export async function doctorRun(ctx) {
  if (ctx.bool('fix')) {
    const v1 = await import('../cli/doctor.js');
    return await v1.run(ctx);
  }
  const v2 = await import('./doctor.js');
  return await v2.run(ctx);
}

/**
 * `staysfixed check`.
 *
 * @param {import('../cli/index.js').CliContext} ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  // Version 1 first. Anybody whose command line names pictures, guards or the
  // watch panel gets exactly the run they got yesterday, byte for byte.
  if (wantsVersionOne(ctx)) {
    const v1 = await import('../cli/check.js');
    return await v1.run(ctx);
  }

  // Say so when a flag was accepted and will do nothing.
  //
  // This goes to standard error, so it cannot corrupt --json, and it is a warning rather
  // than a refusal: the person asked for a real check and they should still get one.
  for (const [flag, written] of V1_ONLY_FLAGS) {
    if (ctx.flags[flag] !== undefined) {
      warn(`${written} only applies to the version 1 check. This run is the difference engine, so it was ignored — add --pictures or --guards if that is what you wanted.`);
    }
  }

  // --json means the answer belongs to a machine. Every line meant for a person
  // is switched off before anything else runs, rather than trusted not to
  // print: one stray sentence on standard output and the JSON will not parse.
  // Warnings and errors still go to standard error, where they cannot corrupt
  // it.
  const asJson = ctx.bool('json');
  if (asJson) setLogLevel({ quiet: true });

  if (ctx.bool('selfcheck')) return await runSelfCheck(ctx, asJson);

  const check = await engineCheck();
  /** @type {Verdict} */
  const verdict = await check(checkOptions(ctx));

  // Write down what this check concluded, before printing anything.
  //
  // `shouldCut` refuses to make a build the reference unless that build was
  // actually checked — which is the whole safeguard against a broken build
  // quietly becoming the definition of working. Without this line a person who
  // checks on the command line and then ships is told their build was "never
  // checked", and the safeguard fires on the honest case instead of the careless
  // one. The agent surface records its own; this is the command line's half.
  try {
    const { recordCheck } = await import('./reference.js');
    const { openStore } = await import('./store.js');
    await recordCheck(openStore({ root: ctx.cwd ?? process.cwd() }), {
      buildId: verdict.candidate?.id,
      product: verdict.product,
      ok: verdict.ok,
      blocked: /** @type {any} */ (verdict).blocked === true,
      findings: verdict.findings.length,
      by: 'staysfixed check',
    });
  } catch {
    // Never let bookkeeping cost somebody the result they came for.
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(verdict) + '\n');
  } else {
    report(verdict);
  }

  await sayWhatNeedsAPerson(ctx, verdict, asJson);

  // A run with nothing on record to compare against has not proved your product
  // is fine — it has proved nothing at all, and it must not exit 0 and let a
  // release through on the strength of it.
  if (nothingToCompare(verdict)) return EXIT.error;
  return verdict.ok ? EXIT.ok : EXIT.failed;
}

/**
 * The handful of things a person has to rule on, and nothing else.
 *
 * This is the whole of what version 2 asks of him. Everything else — what is different,
 * whether it is noise, whether the agent caused it — is answered by the machine or by the
 * agent. What lands here is the small class no agent may wave through, and it is written to
 * be pasted straight into a closing summary rather than read from a screen.
 *
 * @param {import('../cli/index.js').CliContext} ctx
 * @param {Verdict} verdict
 * @param {boolean} asJson
 * @returns {Promise<void>}
 */
async function sayWhatNeedsAPerson(ctx, verdict, asJson) {
  const store = openStore({ root: ctx.cwd });
  const product = verdict.product || (await productFor(ctx.cwd));
  const escalations = await escalationsFor(store, product).catch(() => null);
  if (!escalations) return;

  const file = ctx.str('escalations');
  if (file) {
    const written = await writeEscalations(store, product, file);
    if (!asJson) {
      say(paint.grey(`  ${written.count === 0 ? 'Nothing needs a person' : `${written.count} thing${written.count === 1 ? '' : 's'} for a person`} — written to ${written.file}`));
      blank();
    }
  }

  if (asJson || escalations.items.length === 0) return;
  heading('Put this in your summary');
  blank();
  for (const line of escalationBlock(escalations).split('\n')) say(line === '' ? '' : `  ${line}`);
  blank();
}

/**
 * Was there anything to compare this build against at all?
 *
 * The engine says there was not by handing back a reference with an empty id.
 * That is the cold start, and it happens on every product that has not been
 * shipped once with the reference hook in place.
 *
 * @param {Verdict} verdict
 * @returns {boolean}
 */
function nothingToCompare(verdict) {
  return !verdict.reference || verdict.reference.id === '';
}

/**
 * A build, named the way a person would name it.
 *
 * The same rule as `nameOf` in src/v2/run.js, written again rather than
 * imported: this file has to keep working, and keep explaining itself, on a
 * copy where the engine will not even load.
 *
 * @param {import('./types.js').BuildFingerprint} build
 * @returns {string}
 */
function nameOfBuild(build) {
  if (!build) return 'the build with no name';
  if (build.version) return build.version;
  if (build.gitSha) return build.gitSha.slice(0, 7);
  return build.id || 'the build with no name';
}

/**
 * Did the person ask for the version 1 run? Only an explicit version 1 flag
 * counts. Guessing here — "no journeys are configured, so they probably meant
 * pictures" — is how a tool quietly does something other than what it was told.
 *
 * @param {import('../cli/index.js').CliContext} ctx
 * @returns {boolean}
 */
export function wantsVersionOne(ctx) {
  return ctx.bool('pictures') || ctx.bool('guards') || ctx.bool('record');
}

/**
 * What the person typed about the live panel.
 *
 * The flags themselves are read by version 1's reader, so the two checks cannot drift
 * apart on what `--watch-side left` means. Only `--no-snap` is added here, and only
 * because it is the one panel flag whose whole meaning is "change nothing at all" — it
 * has to be left undefined when it was not typed, so the settings file still decides.
 *
 * @param {import('../cli/index.js').CliContext} ctx
 * @returns {import('./watch/index.js').WatchFlags}
 */
function panelFlags(ctx) {
  /** @type {import('./watch/index.js').WatchFlags} */
  const wanted = { ...watchFlags(ctx) };
  if (ctx.flags.snap !== undefined) wanted.snap = ctx.flags.snap === true;
  return wanted;
}

/**
 * The command line, turned into what the engine takes. Kept separate from `run`
 * so the MCP server can build the same object from its own arguments and be
 * certain the two front doors mean identical things.
 *
 * The key names are the ones the two shipped callers of the engine's front door
 * already use — src/v2/selfcheck.js and src/v2/mcp/tools.js both pass `cwd`. A
 * command line that sent the same value under a different name would be the one
 * caller in three getting a silent undefined.
 *
 * @param {import('../cli/index.js').CliContext} ctx
 * @returns {{cwd: string, configFile: string|undefined, against: string|undefined, paired: boolean, journeys: string|undefined, surface: string|undefined, at: string|undefined, only: string[], watch: import('./watch/index.js').WatchFlags}}
 */
export function checkOptions(ctx) {
  const watch = panelFlags(ctx);
  // A window to look at and output for a script want opposite things, and one stray
  // sentence on standard output is a JSON reply that will not parse. Saying so is better
  // than quietly picking one.
  if (watch.enabled === true && ctx.bool('json')) {
    warn('--watch and --json want opposite things: a window to look at, and output a script can read. Carrying on without the window.');
    watch.enabled = false;
  }
  return {
    cwd: ctx.cwd,
    configFile: ctx.configFile,
    against: ctx.str('against'),
    paired: ctx.bool('paired'),
    journeys: ctx.str('journeys'),
    surface: ctx.str('surface'),
    at: ctx.str('at'),
    only: ctx.list('only'),
    watch,
  };
}

/**
 * `--selfcheck`: run the corpus of deliberately broken builds and require the
 * engine to catch every one.
 *
 * A tool that reports "nothing changed" looks exactly like a tool that is
 * broken, and there is no way to tell the two apart from the outside. This is
 * the only way to tell them apart from the inside — which is why "it could not
 * run" is reported as a failure here and never as a quiet pass.
 *
 * @param {import('../cli/index.js').CliContext} ctx
 * @param {boolean} asJson
 * @returns {Promise<number>}
 */
async function runSelfCheck(ctx, asJson) {
  const { selfcheck } = await import('./selfcheck.js');
  const result = await selfcheck({ only: ctx.list('only') });

  // Three outcomes, not two. "Every break was caught", "a break got through", and "one case
  // behaved on the second run and not the first, so nobody knows" are different facts, and
  // the third one has to be able to say so instead of being rounded to either neighbour.
  const untellable = result.cases.filter((one) => one.verdict === 'could not tell');
  const reallyWrong = result.cases.filter((one) => !one.caught && one.verdict !== 'could not tell');

  if (asJson) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return result.passed ? EXIT.ok : reallyWrong.length > 0 ? EXIT.failed : EXIT.error;
  }

  heading('Stays Fixed — checking that it can still catch things');
  blank();

  if (!result.ran) {
    fail(result.why ?? 'The engine could not be driven, so nothing was tested.');
    blank();
    fail('This is not a pass. Until it can run, a clean check means nothing.');
    return EXIT.failed;
  }

  if (result.cases.length === 0) {
    // "Nothing matched" and "everything behaved" both leave an empty list, and
    // filing the first one under the second is exactly the silence this whole
    // corpus exists to make impossible.
    fail('Nothing matched what --only asked for, so no product was tested. This is not a pass.');
    return EXIT.failed;
  }

  for (const one of result.cases) {
    if (one.caught) ok(`${one.name} — ${saidOf(one)}`);
    // A false alarm is as fatal as a miss: a tool that cries wolf gets switched
    // off, and a tool that is switched off catches nothing. It is not a warning.
    else fail(`${one.name} — ${saidOf(one)}`);
  }
  blank();

  if (result.passed) {
    ok(`All ${result.cases.length} of them behaved: every break caught, every clean pair silent.`);
    return EXIT.ok;
  }
  if (reallyWrong.length === 0) {
    fail(
      `${untellable.length} of ${result.cases.length} could not be told either way: ${untellable.length === 1 ? 'it' : 'they'} behaved on the second run and not on the first. ` +
        'That is not a pass and not a failure — it is no answer. Run it again on a machine that is not busy.',
    );
    return EXIT.error;
  }
  fail(`It got ${reallyWrong.length} of ${result.cases.length} wrong, twice in a row each. Until that is fixed, a clean check means nothing.`);
  if (untellable.length > 0) fail(`${untellable.length} more could not be told either way.`);
  return EXIT.failed;
}

/**
 * One case of the corpus, in a sentence.
 *
 * The corpus only writes a reason when a case misbehaved, so the two good
 * outcomes are named here — and named differently, because catching a break and
 * staying silent on a clean pair are two separate promises.
 *
 * @param {import('./selfcheck.js').CaseResult} one
 * @returns {string}
 */
function saidOf(one) {
  if (one.why) return one.why;
  if (one.verdict === 'caught') return 'caught, as it has to be';
  if (one.verdict === 'quiet') return 'said nothing, which is the right answer here';
  return one.verdict;
}

/**
 * The engine's front door.
 *
 * The engine is assembled alongside this file rather than inside it, so a
 * missing module is a real possibility while version 2 is being built and it has
 * to read as itself. An agent told "the engine is not wired up in this copy" can
 * act on that; an agent handed a module resolution stack trace cannot.
 *
 * It looks in exactly the place src/v2/mcp/tools.js looks, on purpose. If the
 * command line and the MCP server ever found the engine in different places,
 * they would be checking two different things and reporting it as one.
 *
 * @returns {Promise<(options: any) => Promise<Verdict>>}
 */
async function engineCheck() {
  /** @type {unknown} */
  let missing = null;

  // The specifiers are built from a variable rather than written as literals.
  // src/v2/check.js is the small piece that turns a command line into a run, and
  // it may not be written yet; a literal would be resolved when this file is
  // type-checked and fail there, instead of being explained in words here.
  for (const where of ['./check.js', './run.js']) {
    /** @type {Record<string, unknown>} */
    let module;
    try {
      module = await import(where);
    } catch (cause) {
      const code = /** @type {{code?: string}} */ (Object(cause)).code;
      if (code !== 'ERR_MODULE_NOT_FOUND') {
        throw new StaysFixedError(`The difference engine could not be loaded: ${messageOf(cause)}`, { cause });
      }
      missing = cause;
      continue;
    }
    const check = module.check;
    if (typeof check === 'function') return /** @type {(options: any) => Promise<Verdict>} */ (check);
  }

  throw new StaysFixedError('The difference engine has no front door for the command line to call.', {
    hint:
      'src/v2/run.js has runCheck(), but that takes a run somebody has already assembled: a store, the journeys, and something that can walk them. What is missing is the piece in between — check({cwd, configFile, against, paired, journeys, only}) returning a Verdict, exported from src/v2/check.js, which is where src/v2/mcp/tools.js and src/v2/selfcheck.js both look for it. Until it lands, `staysfixed check --pictures` and `--guards` do everything version 1 did.',
    cause: missing ?? undefined,
  });
}

// ── saying what happened ────────────────────────────────────────────────────

/**
 * The verdict, in words.
 *
 * Everything unchanged is silent on purpose. A list of things that are fine is
 * the exact thing this design exists to stop producing: it costs an agent its
 * context and it teaches a person to skim.
 *
 * @param {Verdict} verdict
 */
export function report(verdict) {
  if (nothingToCompare(verdict)) {
    // One sentence, and no table. There is no build on record as working, so
    // there are no findings, no counts and no coverage worth printing — laying
    // out half a report around an empty middle is how a run that proved nothing
    // gets read as a run that proved everything is fine.
    warn(verdict.summary);
    return;
  }

  // The weakening admission goes first, and it is labelled, because this is the
  // tool telling you it is less sure than usual. A reader who has already seen a
  // green tick does not come back up the page for it. It is said again at the
  // end: the engine puts it into the summary itself, so it lands either side of
  // everything below.
  if (verdict.modeWarning) {
    warn('This was not a full paired run, so it is weaker than usual. Read this before anything below it:');
    warn(verdict.modeWarning);
  }

  const sealed = verdict.findings.filter((f) => f.sealed);
  const rest = verdict.findings.filter((f) => !f.sealed);

  if (sealed.length > 0) {
    heading('A person has to look at these');
    blank();
    for (const finding of sealed) printFinding(finding);
    blank();
  }

  if (rest.length > 0) {
    heading(sealed.length > 0 ? 'And these' : 'What changed that nobody asked for');
    blank();
    for (const finding of rest) printFinding(finding);
    blank();
  }

  // Paths that were steady before the change and disagree with themselves now.
  // Nothing here has a "wrong" value, which is exactly why it needs its own
  // section: without it a run can come back failed with no findings and no
  // explanation of what failed.
  const unstable = verdict.newlyUnstable ?? [];
  if (unstable.length > 0) {
    heading('These used to give the same answer every time, and now they do not');
    blank();
    for (const entry of unstable.slice(0, MOST_LINES)) {
      say(`  ${entry.path}`);
      say(paint.grey('      two runs of this same build disagree about it, and the old build did not'));
    }
    if (unstable.length > MOST_LINES) say(paint.grey(`  and ${unstable.length - MOST_LINES} more.`));
    blank();
  }

  if (verdict.ok) ok(`${verdict.summary}${verdict.durationMs ? ` — ${duration(verdict.durationMs)}` : ''}`);
  else fail(verdict.summary);

  sizeLine(verdict);
  provenLine(verdict);
  blank();
  notCheckedBlock(verdict);
  blank();
}

/**
 * @param {Finding} finding
 */
function printFinding(finding) {
  const label = finding.sealed ? paint.red(`[${finding.class}] `) : '';
  say(`  ${label}${finding.title}`);

  const example = finding.differences?.[0];
  if (example) {
    // "was undefined" is how a tool tells you nothing. Something that was not
    // there before, or is not there now, has to say so in those words.
    const { path: where, reference: was, candidate: now } = example;
    if (example.kind === 'appeared') say(paint.grey(`      ${where}: was not there before, and now it is ${show(now)}`));
    else if (example.kind === 'vanished') say(paint.grey(`      ${where}: was ${show(was)}, and now it is not there at all`));
    else say(paint.grey(`      ${where}: was ${show(was)}, now ${show(now)}`));
  }

  // The count is optional, so it is only worth a line when the engine actually
  // filled it in and it says more than the list above already did.
  const count = finding.count ?? finding.differences.length;
  if (count > 1) say(paint.grey(`      the same thing in ${count} places`));
  if (finding.why) say(paint.grey(`      ${finding.why}`));
  if (finding.evidence) say(paint.grey(`      evidence: ${finding.evidence}`));
}

/**
 * A value, short enough to read on one line.
 * @param {unknown} value
 * @returns {string}
 */
function show(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/**
 * How much was looked at. Said on a clean run as well as a dirty one: quiet that
 * cannot be shown to be earned is indistinguishable from a broken tool.
 *
 * How much was SUBTRACTED is deliberately not repeated here. The engine already
 * spells that arithmetic out inside `summary`, in its own words, and two
 * differently-worded versions of one number on two neighbouring lines is how a
 * reader starts wondering which of them to believe. Nor is there a line for how
 * many suspicions the old build turned out to share: the verdict carries no such
 * figure, and inventing one would be worse than the sentence that is already true.
 *
 * @param {Verdict} verdict
 */
function sizeLine(verdict) {
  const paths = verdict.coverage?.paths ?? 0;
  const journeys = verdict.coverage?.journeys ?? 0;
  if (paths === 0) return;
  say(paint.grey(`  Looked at ${paths} ${paths === 1 ? 'address' : 'addresses'} across ${journeys} ${journeys === 1 ? 'journey' : 'journeys'}.`));
}

/**
 * What it was compared against, and how. Two facts, and they are not the same
 * one: the fingerprint names WHICH build, and the mode names whether that build
 * was actually booted here or only remembered.
 * @param {Verdict} verdict
 */
function provenLine(verdict) {
  const how = verdict.mode === 'paired' ? 'booted and walked again on this machine' : 'the record it left the last time it ran';
  say(paint.grey(`  Compared against ${nameOfBuild(verdict.reference)} — ${how}.`));
}

/**
 * What it did NOT look at, under its own heading, every single time.
 *
 * This used to be a few grey lines at the bottom, and grey lines at the bottom are what a
 * reader skips. The whole honesty of the tool rests on this block: a clean run on a
 * product with three hundred doors nobody has ever opened is TRUE and it is not what it
 * looks like. So it gets a heading, it is printed on good runs as well as bad ones, and
 * the count of unopened doors goes first — it is the number that most often turns "it is
 * fine" back into "it is fine as far as anybody looked".
 *
 * The engine says the same thing in one sentence inside `summary`, which is printed just
 * above. That is not a duplicate: the sentence is what somebody quotes, and this is the
 * list they act on.
 *
 * @param {Verdict} verdict
 */
function notCheckedBlock(verdict) {
  const coverage = verdict.coverage;
  if (!coverage) {
    warn('This run did not say what it covered, so how much of your product was actually looked at is unknown. Treat the result above as unproven.');
    return;
  }

  heading('What this run did not check');
  blank();

  const known = coverage.doorsKnown ?? 0;
  const unopened = Math.max(0, known - (coverage.doorsWalked ?? 0));
  if (unopened > 0) {
    say(
      known === 1
        ? '  The only way into this product has never been walked through.'
        : `  ${unopened} of the ${known} ways into this product ${unopened === 1 ? 'has' : 'have'} never been walked through.`,
    );
    say(
      paint.grey(
        `      A break behind ${unopened === 1 ? 'it' : 'any of them'} is invisible to this tool. Point a journey at ${unopened === 1 ? 'it' : 'them'} — name the steps in a journeys file and pass it with --journeys.`,
      ),
    );
  }

  // Several holes can share one sentence — the coverage count's own caveats all do — and
  // printing that sentence three times reads as three separate holes rather than as one
  // heading with three reasons under it.
  /** @type {Map<string, string[]>} */
  const gaps = new Map();
  for (const gap of coverage.gaps ?? []) {
    if (typeof gap.doors === 'number') continue;
    const reasons = gaps.get(gap.what) ?? [];
    reasons.push(`${gap.why}${gap.unlockedBy ? ` ${gap.unlockedBy}` : ''}`);
    gaps.set(gap.what, reasons);
  }
  let shown = 0;
  for (const [what, reasons] of gaps) {
    if (shown >= MOST_LINES) break;
    shown += 1;
    say(`  ${what}`);
    for (const reason of reasons) say(paint.grey(`      ${reason}`));
  }
  if (gaps.size > shown) {
    say(paint.grey(`  and ${gaps.size - shown} more. All of them: staysfixed check --json`));
  }

  if (unopened === 0 && gaps.size === 0) {
    say('  Everything this run knows how to walk was walked.');
    say(paint.grey('      That is not every possible state of your product — nothing can enumerate that. It is every way in this tool knows about.'));
  }
}
