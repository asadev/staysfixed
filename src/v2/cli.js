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
 * they always typed still reach the same code. `--pictures`, `--guards` and
 * `--watch` are the version 1 check, exactly as before. `check` with none of
 * them is the difference engine. That is the whole migration.
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
  strings: ['against', 'journeys', 'escalations'],
};

/** @type {[string, string][]} */
const V2_OPTIONS = [
  ['--against <ref>', 'Compare against this marker, tag or commit instead of the newest reference.'],
  ['--paired', 'Boot the old build live from the start instead of trusting the stored record. Slower, and the strongest answer there is.'],
  ['--journeys <source>', 'Where the steps come from: suite, code, recorded, or a path to a journeys file.'],
  ['--selfcheck', 'Run the deliberately broken builds and prove the engine still catches them.'],
  ['--json', 'Print the whole result as JSON and nothing else. This is what an agent reads.'],
  ['--escalations <file>', 'Write the handful of things a person has to rule on into a file, in plain English, ready to paste into a closing summary.'],
];

/** The version 1 flags, kept working word for word. */
const V1_SPEC = {
  booleans: ['guards', 'pictures', 'record', 'report', 'watch', 'watch-front', 'keep-open', 'profile'],
  strings: ['watch-side', 'watch-width'],
  arrays: ['only'],
};

/** @type {[string, string][]} */
const V1_OPTIONS = [
  ['--pictures', 'The version 1 picture check, unchanged.'],
  ['--guards', 'The version 1 guards, unchanged.'],
  ['--only <name>', 'Just this journey, screen or guard. Repeat it for several.'],
  ['--watch', 'Open the version 1 panel beside your app and watch it happen.'],
];

/**
 * The commands version 2 replaces, in exactly the shape `src/cli/index.js`
 * already uses for its own. Merging this over the existing table is the whole
 * of the wiring:
 *
 *     import { V2_COMMANDS } from '../v2/cli.js';
 *     Object.assign(COMMANDS, V2_COMMANDS);
 *
 * @type {Record<string, {summary: string, usage: string, describe: string, options: [string,string][], examples: string[], spec: {booleans?: string[], strings?: string[], arrays?: string[]}, load: () => Promise<{run: (ctx: any) => Promise<number>}>}>}
 */
export const V2_COMMANDS = {
  // `staysfixed ship` comes from src/v2/ship.js. It is merged in here rather than into the
  // version 1 command table so that wiring version 2 into the front door stays the one
  // import it has always been.
  ...SHIP_COMMANDS,

  check: {
    summary: 'Prove nothing that already worked has changed. This is the one you run.',
    usage: 'staysfixed check [--against <ref>] [--paired] [--journeys <source>] [--json]',
    describe:
      'Runs your product through the same steps twice, compares it against the build you\nwere last happy with, subtracts anything the product disagrees with itself about,\nand reports only the differences that are left. Nothing that was already the same\nis mentioned at all — that is the point, and it is what keeps the answer short\nenough for an agent to read every word of it.\n\nSaying what you meant to change, and marking a difference as intended, are not\ndone from here. They need the files you expect to touch, and they are checked\nand counted, so they live where an agent works: the staysfixed_intent and\nstaysfixed_waive tools on the MCP server.\n\nThe version 1 picture check is still here: add --pictures, --guards or --watch\nand nothing about your old command changes.',
    options: [...V2_OPTIONS, ...V1_OPTIONS],
    examples: [
      'staysfixed check',
      'staysfixed check --json',
      'staysfixed check --against v0.13.0',
      'staysfixed check --paired',
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
  return ctx.bool('pictures') || ctx.bool('guards') || ctx.bool('watch') || ctx.bool('record');
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
 * @returns {{cwd: string, configFile: string|undefined, against: string|undefined, paired: boolean, journeys: string|undefined, only: string[]}}
 */
export function checkOptions(ctx) {
  return {
    cwd: ctx.cwd,
    configFile: ctx.configFile,
    against: ctx.str('against'),
    paired: ctx.bool('paired'),
    journeys: ctx.str('journeys'),
    only: ctx.list('only'),
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

  if (asJson) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return result.passed ? EXIT.ok : EXIT.failed;
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
  const wrong = result.cases.filter((one) => !one.caught).length;
  fail(`It got ${wrong} of ${result.cases.length} wrong. Until that is fixed, a clean check means nothing.`);
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
  missingLine(verdict);
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
 * What it did NOT look at. Said every time, including on a clean run: a gap that
 * is only mentioned when something fails is a gap nobody ever sees.
 * @param {Verdict} verdict
 */
function missingLine(verdict) {
  const gaps = verdict.coverage?.gaps ?? [];
  for (const gap of gaps.slice(0, MOST_LINES)) {
    say(paint.grey(`  Not covered: ${gap.what}${gap.unlockedBy ? ` — ${gap.unlockedBy}` : ''}`));
  }
  if (gaps.length > MOST_LINES) {
    say(paint.grey(`  and ${gaps.length - MOST_LINES} more things it did not look at. All of them: staysfixed check --json`));
  }
}
