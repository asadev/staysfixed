/**
 * Journeys harvested from the project's own test suite.
 *
 * This is the highest-value source in the tool, and the reason is arithmetic: Terminal Deck
 * has 693 test files that somebody already wrote, that already walk the real paths through
 * the real code, and that are sitting there being used for exactly one thing — saying pass
 * or fail. Run them once with the instrumentation on and you have hundreds of journeys
 * nobody had to write, each one already known to reach real code.
 *
 * THE ASSERTIONS ARE NOT THE POINT. A test that fails still exercised the product, and its
 * journey is still worth keeping — what is harvested is what the test TOUCHED, not what it
 * concluded. A suite that is red today is still a map of the product.
 *
 * HOW "WHAT IT TOUCHED" IS MEASURED. Node writes V8 coverage for a process and its children
 * when `NODE_V8_COVERAGE` is set: every script that executed, and every function inside it
 * that ran. That is exactly the question, answered by the runtime itself, with nothing
 * patched and nothing about the tests changed. Vitest is the exception — its tests run in
 * worker threads whose coverage never reaches that folder, verified here rather than
 * assumed — so vitest is asked for its own V8 coverage report instead, and when the package
 * that produces one is not installed the tool says so and hands over the exact command,
 * rather than quietly harvesting journeys that know nothing about what they touch.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not patch `fs`, `child_process` or `fetch` to
 * watch effects. Effects are the adapter's job when the journey is WALKED; a harvester that
 * rewrote the runtime under somebody's test suite would be changing the product in order to
 * measure it, and the first strange failure would cost a day of somebody's life.
 *
 * SEQUENTIAL, ALWAYS. One test file at a time, twice each. Two runs of the same suite at
 * once fight over ports, fixtures and temporary folders, and every difference that comes out
 * of that fight is a difference this tool would then report as real.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

/** @typedef {import('../types.js').Journey} Journey */
/** @typedef {import('../types.js').JourneyStep} JourneyStep */
/** @typedef {import('../types.js').Surface} Surface */
/** @typedef {import('../adapters/contract.js').Missing} Missing */

/**
 * A journey harvested from a test file, carrying what that test touched.
 *
 * `touched` is not compared and is not part of the journey's identity. It is what makes the
 * coverage ledger possible: match these files and function names against the doors the code
 * reader found, and "how deep is this really" stops being a claim and becomes a number.
 *
 * `reproducible` is the receipt for the rule that matters most here: a journey that does not
 * do the same thing twice on the same build is rejected at birth rather than admitted and
 * condemned later. Harvesting runs every file twice, so a harvested journey arrives with
 * that check already done, and `index.js` does not pay for it again.
 *
 * @typedef {Journey & {touched?: Touched, reproducible?: {how: string, at: string}}} SuiteJourney
 */

/**
 * @typedef {object} Touched
 * @property {string[]} files       Project files that executed, relative to the root.
 * @property {string[]} functions   Named functions that ran, as `file:name`.
 * @property {boolean} measured     False when nothing could be measured — see `why`.
 * @property {string} why           Plain English, always filled in.
 * @property {number} [ranButNotListed]
 *                                  Functions that ran and were cut from `functions` to keep
 *                                  the list readable. It has to be a number rather than a
 *                                  silent slice, because the coverage ledger reads this list
 *                                  to decide which doors were opened — and a truncated list
 *                                  read as a complete one reports work as still to do when
 *                                  it is already done.
 */

// ---------------------------------------------------------------------------
// Which runner
// ---------------------------------------------------------------------------

/**
 * @typedef {'vitest'|'node:test'|'none'} Runner
 */

/**
 * @typedef {object} RunnerDetection
 * @property {Runner} runner
 * @property {number} confidence      0..1.
 * @property {string} why             Plain English, always filled in, including for 'none'.
 * @property {string} [binary]        The program that runs one test file.
 * @property {string} [configFile]    Relative path to the runner's config, when there is one.
 * @property {Missing[]} missing      What would unlock more, with the command to get it.
 * @property {string[]} notes
 */

/** Folders never worth walking into looking for tests. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'release', 'coverage', '.next', '.turbo',
  '.staysfixed', '.cache', 'vendor', '__snapshots__', '.venv', 'venv', 'ios', 'android',
]);

/**
 * What a test file is called, in every convention either runner accepts.
 *
 * Deliberately not "anything inside a folder called test". That rule sweeps up the shared
 * helper every suite has — `test/support.mjs` in this very repository — and a helper is not
 * a journey: running it on its own reports nothing, and it would be rejected two minutes
 * later having cost a process launch to find out.
 */
const TEST_FILE = /(^|[./-])(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\/[^/]+\.[cm]?[jt]sx?$/;

/**
 * Work out which test runner this project uses, and say how sure that is.
 *
 * The `test` script wins over the dependency list, because a project can have vitest
 * installed for one workspace and run `node --test` in another, and the script is what the
 * person actually runs.
 *
 * @param {string} root
 * @returns {Promise<RunnerDetection>}
 */
export async function detectRunner(root) {
  /** @type {Record<string, any>} */
  let pkg = {};
  try {
    pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return {
      runner: 'none',
      confidence: 1,
      why: 'There is no package.json here, so there is no test suite this tool knows how to run.',
      missing: [],
      notes: [],
    };
  }

  const scripts = /** @type {Record<string, string>} */ (pkg.scripts ?? {});
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const testScript = String(scripts.test ?? '');
  const configFile = await firstExisting(root, [
    'vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.mts',
    'vite.config.ts', 'vite.config.js', 'vite.config.mjs',
  ]);

  /** @type {Missing[]} */
  const missing = [];
  /** @type {string[]} */
  const notes = [];

  const saysVitest = /\bvitest\b/.test(testScript);
  const saysNodeTest = /node\s+--test|--test\b/.test(testScript);
  const hasVitest = 'vitest' in deps;

  if (saysVitest || (hasVitest && !saysNodeTest)) {
    const binary = await firstExisting(root, [path.join('node_modules', '.bin', 'vitest')]);
    if (!binary) {
      missing.push({
        what: 'vitest, installed in this project',
        unlocks: 'running the suite one file at a time so each one becomes a journey',
        howToGet: 'npm install',
        blocking: true,
      });
    }
    if (!('@vitest/coverage-v8' in deps)) {
      // Verified on this machine: with vitest the tests run in worker threads, and Node's
      // own NODE_V8_COVERAGE folder comes back with the runner's own files in it and none
      // of the project's. Vitest's coverage package is the way to see what a test touched.
      missing.push({
        what: '@vitest/coverage-v8',
        unlocks: 'seeing which source files and functions each test file actually exercised, which is what turns a list of tests into a coverage ledger',
        howToGet: 'npm install --save-dev @vitest/coverage-v8',
      });
      notes.push('Without the coverage package the journeys are still harvested; they just do not know what they touched.');
    }
    return {
      runner: 'vitest',
      confidence: saysVitest ? 1 : 0.8,
      why: saysVitest
        ? `The test script runs vitest (${testScript}).`
        : 'vitest is installed as a dependency and nothing else claims the test script.',
      binary: binary ?? undefined,
      configFile: configFile ?? undefined,
      missing,
      notes,
    };
  }

  if (saysNodeTest || (await hasNodeTestFiles(root))) {
    return {
      runner: 'node:test',
      confidence: saysNodeTest ? 1 : 0.7,
      why: saysNodeTest
        ? `The test script uses Node's own test runner (${testScript}).`
        : "Test files import node:test, so Node's own runner will run them.",
      binary: process.execPath,
      missing,
      notes,
    };
  }

  return {
    runner: 'none',
    confidence: 0.9,
    why: testScript
      ? `The test script is "${testScript}", which is not a runner this tool knows how to instrument yet. Only vitest and Node's own test runner are supported.`
      : 'This project has no test script, so there is no suite to harvest journeys from.',
    missing: [
      {
        what: 'a test suite run by vitest or by Node\'s own test runner',
        unlocks: 'journeys nobody has to write — every test file becomes a journey through real code',
      },
    ],
    notes,
  };
}

/**
 * @param {string} root
 * @param {string[]} candidates
 * @returns {Promise<string|null>}
 */
async function firstExisting(root, candidates) {
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(root, candidate))) return candidate;
  }
  return null;
}

/**
 * @param {string} root
 * @returns {Promise<boolean>}
 */
async function hasNodeTestFiles(root) {
  const files = await listTestFiles(root, { limit: 20 });
  for (const rel of files.files) {
    try {
      const text = await fsp.readFile(path.join(root, rel), 'utf8');
      if (/from\s+['"]node:test['"]|require\(['"]node:test['"]\)/.test(text)) return true;
    } catch { /* an unreadable file answers nothing */ }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Which files
// ---------------------------------------------------------------------------

/**
 * Every test file in the project, in a fixed order.
 *
 * Ordered, because the order journeys come out in ends up as the order they are walked in,
 * and an order that changes between runs is one more thing that looks like a difference.
 *
 * @param {string} root
 * @param {{limit?: number, only?: string[], skipDirs?: Set<string>}} [opts]
 * @returns {Promise<{files: string[], scanned: number, cappedAt?: number}>}
 */
export async function listTestFiles(root, opts = {}) {
  const skip = opts.skipDirs ?? SKIP_DIRS;
  /** @type {string[]} */
  const found = [];
  let scanned = 0;
  /** @type {string[]} */
  const stack = [root];
  while (stack.length > 0) {
    const dir = /** @type {string} */ (stack.pop());
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name) && !entry.name.startsWith('.')) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned++;
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (!TEST_FILE.test(rel)) continue;
      if (opts.only && !opts.only.some((pattern) => rel.includes(pattern))) continue;
      found.push(rel);
    }
  }
  found.sort();
  if (opts.limit !== undefined && found.length > opts.limit) {
    return { files: found.slice(0, opts.limit), scanned, cappedAt: opts.limit };
  }
  return { files: found, scanned };
}

// ---------------------------------------------------------------------------
// Running one file, watched
// ---------------------------------------------------------------------------

/**
 * @typedef {object} OneRun
 * @property {string[]} tests        Names of the checks that reported, in a fixed order.
 * @property {number} passed
 * @property {number} failed
 * @property {number} exitCode
 * @property {boolean} ran           False means the file never got as far as reporting anything.
 * @property {Touched} touched
 * @property {number} durationMs
 * @property {string} [trouble]     One plain sentence when something went wrong.
 */

/**
 * The command that runs exactly one test file. Kept in one place because the harvested
 * journey carries it, and whatever walks the journey later has to run the same thing —
 * a journey that is walked differently from the way it was harvested is not the same journey.
 *
 * @param {Runner} runner
 * @param {string} file             Relative to the root.
 * @param {{binary?: string, root: string, coverageDir?: string, resultFile?: string}} opts
 * @returns {{command: string, argv: string[]}}
 */
export function runnerCommand(runner, file, opts) {
  if (runner === 'vitest') {
    const command = opts.binary ? path.resolve(opts.root, opts.binary) : 'npx';
    const argv = opts.binary ? [] : ['vitest'];
    argv.push('run', '--pool=forks', '--no-file-parallelism', '--reporter=json');
    if (opts.resultFile) argv.push(`--outputFile=${opts.resultFile}`);
    if (opts.coverageDir) {
      argv.push(
        '--coverage',
        '--coverage.provider=v8',
        '--coverage.reporter=json',
        '--coverage.all=false',
        `--coverage.reportsDirectory=${opts.coverageDir}`,
      );
    }
    argv.push(file);
    return { command, argv };
  }
  return {
    command: opts.binary ?? process.execPath,
    argv: ['--test', '--test-reporter=tap', file],
  };
}

/**
 * Run one test file and watch what it touches.
 *
 * Never throws. A test file that hangs, crashes or refuses to start comes back as a run
 * that did not happen, with the reason in plain English, because one bad file must not cost
 * the other six hundred.
 *
 * @param {object} opts
 * @param {string} opts.root
 * @param {string} opts.file            Relative to the root.
 * @param {Runner} opts.runner
 * @param {string} opts.scratchDir      Somewhere to write coverage and reports. Not the project.
 * @param {string} [opts.binary]
 * @param {boolean} [opts.coverage]     Default true.
 * @param {number} [opts.timeoutMs]     Default two minutes.
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<OneRun>}
 */
export async function runOneFile(opts) {
  const started = Date.now();
  const stamp = `${path.basename(opts.file).replace(/[^a-zA-Z0-9]+/g, '-')}-${started}-${Math.random().toString(36).slice(2, 8)}`;
  const coverageDir = path.join(opts.scratchDir, `cov-${stamp}`);
  const resultFile = path.join(opts.scratchDir, `result-${stamp}.json`);
  await fsp.mkdir(coverageDir, { recursive: true });

  const wantCoverage = opts.coverage !== false;
  const { command, argv } = runnerCommand(opts.runner, opts.file, {
    binary: opts.binary,
    root: opts.root,
    coverageDir: wantCoverage ? coverageDir : undefined,
    resultFile: opts.runner === 'vitest' ? resultFile : undefined,
  });

  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, STAYSFIXED_HARVEST: '1' };
  // Node's own test runner marks the processes it starts with NODE_TEST_CONTEXT, and a test
  // file that finds it switches from TAP to a private binary stream meant for its parent. Let
  // that through and every file we run comes back having reported nothing at all, and the
  // harvest says - calmly, one line per file - that this project's suite cannot be walked.
  // It bites whenever the harvest is itself started from inside a test run, which is exactly
  // where anybody would first try it.
  delete env.NODE_TEST_CONTEXT;
  // Node's own runner writes coverage for the process and every child it spawns, which is
  // exactly how a test file's own run gets measured. Vitest is asked for its own instead.
  if (wantCoverage && opts.runner === 'node:test') env.NODE_V8_COVERAGE = coverageDir;
  else delete env.NODE_V8_COVERAGE;

  const result = await runToEnd(command, argv, {
    cwd: opts.root,
    env,
    timeoutMs: opts.timeoutMs ?? 120_000,
    signal: opts.signal,
  });

  /** @type {OneRun} */
  const run = {
    tests: [],
    passed: 0,
    failed: 0,
    exitCode: result.code,
    ran: false,
    touched: { files: [], functions: [], measured: false, why: 'Nothing was measured.' },
    durationMs: Date.now() - started,
  };
  if (result.trouble) run.trouble = result.trouble;

  if (opts.runner === 'vitest') {
    const parsed = await readVitestResults(resultFile);
    run.tests = parsed.tests;
    run.passed = parsed.passed;
    run.failed = parsed.failed;
    run.ran = parsed.tests.length > 0;
    run.touched = wantCoverage
      ? await readVitestCoverage(path.join(coverageDir, 'coverage-final.json'), opts.root)
      : { files: [], functions: [], measured: false, why: 'Coverage was switched off for this run.' };
  } else {
    const parsed = parseTap(result.stdout);
    run.tests = parsed.tests;
    run.passed = parsed.passed;
    run.failed = parsed.failed;
    run.ran = parsed.tests.length > 0;
    run.touched = wantCoverage
      ? await readNodeCoverage(coverageDir, opts.root)
      : { files: [], functions: [], measured: false, why: 'Coverage was switched off for this run.' };
  }

  if (!run.ran && !run.trouble) {
    run.trouble =
      result.code === 0
        ? 'It finished without reporting a single check, so there is nothing here to walk.'
        : `It stopped with exit code ${result.code} before reporting anything.`;
  }

  await fsp.rm(coverageDir, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(resultFile, { force: true }).catch(() => {});
  return run;
}

/**
 * Run a command to the end and keep what it said. Kills the whole process group on a
 * timeout, because a test runner that hangs usually has children hanging with it.
 *
 * @param {string} command
 * @param {string[]} argv
 * @param {{cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal}} opts
 * @returns {Promise<{code: number, stdout: string, stderr: string, trouble?: string}>}
 */
function runToEnd(command, argv, opts) {
  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(command, argv, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: '', trouble: `It could not be started: ${String(error)}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    /** @type {string|undefined} */
    let trouble;

    const stop = () => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* it had already gone */ }
    };

    const timer = setTimeout(() => {
      trouble = `It was still running after ${Math.round(opts.timeoutMs / 1000)} seconds, so it was stopped.`;
      stop();
    }, opts.timeoutMs);

    const onAbort = () => {
      trouble = 'The harvest was stopped before this file finished.';
      stop();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk) => { if (stdout.length < 4_000_000) stdout += chunk; });
    child.stderr?.on('data', (chunk) => { if (stderr.length < 1_000_000) stderr += chunk; });

    /** @param {number} code */
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, trouble });
    };

    child.on('error', (error) => {
      trouble = `It could not be started: ${error.message}`;
      done(-1);
    });
    child.on('close', (code) => done(code ?? -1));
  });
}

// ---------------------------------------------------------------------------
// Reading what came back
// ---------------------------------------------------------------------------

/**
 * One check a test file reported.
 *
 * `detail` is only filled in for a check that failed, and it is the whole of what the runner
 * said about it. It matters because "this test is still failing" and "this test is failing
 * for a completely different reason now" are two different facts, and a pass-or-fail flag
 * alone cannot tell them apart - which is exactly the half an exit code misses.
 *
 * @typedef {object} Check
 * @property {string} name
 * @property {boolean} ok
 * @property {string} [detail]
 */

/**
 * Pull the checks out of TAP, each with whether it passed and what it said when it did not.
 *
 * Names rather than counts, because two runs producing thirteen checks each is not the same
 * evidence as two runs producing the same thirteen checks.
 *
 * @param {string} output
 * @returns {Check[]} in the order the runner reported them
 */
export function parseTapChecks(output) {
  /** @type {Check[]} */
  const checks = [];
  const lines = String(output).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(not )?ok\s+\d+\s*-?\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const name = match[2].replace(/\s*#\s*(SKIP|TODO).*$/i, '').trim();
    if (name === '') continue;
    const ok = !match[1];
    if (ok) {
      checks.push({ name, ok });
      continue;
    }
    // A failing check is followed by an indented block holding what went wrong. It opens on
    // `---` and closes on `...`, and everything between is the reason this check is worth
    // reading rather than counting.
    /** @type {string[]} */
    const said = [];
    let j = i + 1;
    if (/^\s*---\s*$/.test(lines[j] ?? '')) {
      j++;
      while (j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j])) {
        said.push(lines[j]);
        j++;
      }
      i = j;
    }
    const detail = withoutRunnerTiming(said.join('\n')).trim();
    checks.push(detail === '' ? { name, ok } : { name, ok, detail });
  }
  return checks;
}

/**
 * Pull the check names out of TAP.
 *
 * @param {string} output
 * @returns {{tests: string[], passed: number, failed: number}}
 */
export function parseTap(output) {
  const checks = parseTapChecks(output);
  return {
    tests: checks.map((c) => c.name).sort(),
    passed: checks.filter((c) => c.ok).length,
    failed: checks.filter((c) => !c.ok).length,
  };
}

/**
 * The runner's own stopwatch, taken back out of what it printed.
 *
 * Measured rather than assumed: two runs of the same three-check file, on the same bytes,
 * minutes apart, differ in exactly four lines and every one of them is a `duration_ms`.
 * Nothing else moves. So this one small rule turns the whole of what a test runner printed
 * from noise into something worth comparing word for word - and comparing it is the point,
 * because a program that starts printing a deprecation warning under a test that still
 * passes is invisible to an exit code.
 *
 * WHAT THIS COULD HIDE, said plainly: a test that got slower. That is already the one thing
 * this tool refuses to report on principle - see `howLongItTook` in adapters/contract.js -
 * so nothing is lost here that was ever going to be claimed.
 *
 * @param {string} text
 * @returns {string}
 */
export function withoutRunnerTiming(text) {
  return String(text)
    .split('\n')
    .filter((line) => !/^\s*#?\s*duration_ms[:\s]/.test(line))
    .join('\n');
}

/** The keys vitest fills in from a clock. A named list, so nothing else is touched. */
const VITEST_CLOCK_KEYS = new Set([
  'duration', 'startTime', 'endTime', 'start', 'end', 'setupDuration', 'collectDuration',
  'prepareDuration', 'environmentSetupDuration', 'runtime', 'heap',
]);

/**
 * Everything a test runner printed, with its own stopwatch out of it and nothing else.
 *
 * Node's runner narrates its timings as `duration_ms` lines, which come straight out. Vitest
 * hands back a JSON report with the times scattered through it under named keys, so it is
 * parsed and those exact keys - a named list, never a pattern over the text - are replaced.
 * Replaced rather than deleted, because a key vanishing and a key holding a different number
 * are two different facts and only one of them is the clock.
 *
 * Anything that will not parse comes back with the line rule applied and no more. Guessing
 * at the shape of text nobody recognises is how a real change gets rubbed out.
 *
 * @param {Runner} runner
 * @param {string} text
 * @returns {string}
 */
export function quietenRunnerOutput(runner, text) {
  const plain = withoutRunnerTiming(text);
  if (runner !== 'vitest') return plain;
  const start = plain.indexOf('{');
  if (start < 0) return plain;
  try {
    const report = JSON.parse(plain.slice(start));
    return `${plain.slice(0, start)}${JSON.stringify(hushClock(report), null, 2)}`;
  } catch {
    return plain;
  }
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function hushClock(value) {
  if (Array.isArray(value)) return value.map(hushClock);
  if (value === null || typeof value !== 'object') return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = VITEST_CLOCK_KEYS.has(key) && typeof inner === 'number' ? 'a time, not compared' : hushClock(inner);
  }
  return out;
}

/**
 * @param {string} file
 * @returns {Promise<{tests: string[], passed: number, failed: number}>}
 */
async function readVitestResults(file) {
  try {
    const checks = checksFromVitestReport(JSON.parse(await fsp.readFile(file, 'utf8')));
    return {
      tests: checks.map((c) => c.name).sort(),
      passed: checks.filter((c) => c.ok).length,
      failed: checks.filter((c) => !c.ok).length,
    };
  } catch {
    return { tests: [], passed: 0, failed: 0 };
  }
}

/**
 * Vitest's own JSON report, as checks.
 *
 * @param {any} report
 * @returns {Check[]}
 */
export function checksFromVitestReport(report) {
  /** @type {Check[]} */
  const checks = [];
  for (const suite of report?.testResults ?? []) {
    for (const assertion of suite?.assertionResults ?? []) {
      const name = [assertion.ancestorTitles?.join(' > '), assertion.title].filter(Boolean).join(' > ');
      if (name === '') continue;
      const ok = assertion.status === 'passed';
      const detail = withoutRunnerTiming(
        Array.isArray(assertion.failureMessages) ? assertion.failureMessages.join('\n') : '',
      ).trim();
      checks.push(ok || detail === '' ? { name, ok } : { name, ok, detail });
    }
  }
  return checks;
}

/**
 * The checks a walked test file reported, read out of whatever the runner printed.
 *
 * This is the walking half of the harvest. `runOneFile` reads a runner it started itself and
 * knows exactly where the report went; a journey being walked months later has only the text
 * the command printed. The two live next to each other on purpose - a journey read
 * differently from the way it was harvested is not the same journey.
 *
 * `read` false is not "no checks". It means nothing here could tell, and the caller has to
 * report that as a hole rather than as a file with nothing in it.
 *
 * @param {Runner} runner
 * @param {string} stdout
 * @returns {{checks: Check[], read: boolean, why: string}}
 */
export function readChecks(runner, stdout) {
  const text = String(stdout ?? '');
  if (runner === 'vitest') {
    // Asked for `--reporter=json` with nowhere to put it, vitest prints the report to the
    // screen, sometimes after a banner. The first `{` that parses is the report.
    const start = text.indexOf('{');
    if (start >= 0) {
      try {
        const checks = checksFromVitestReport(JSON.parse(text.slice(start)));
        if (checks.length > 0) return { checks, read: true, why: `Vitest reported ${checks.length} checks.` };
      } catch { /* fall through to TAP, which some vitest setups print instead */ }
    }
  }
  const checks = parseTapChecks(text);
  if (checks.length > 0) return { checks, read: true, why: `${checks.length} checks reported.` };
  return {
    checks: [],
    read: false,
    why: 'The test runner printed nothing this could read as a list of checks, so which checks passed is not known.',
  };
}

/**
 * How many functions from one file are worth writing down. A journey that lists nine
 * hundred function names is not evidence, it is a wall, and nobody reads a wall.
 */
export const TOUCHED_FUNCTION_LIMIT = 400;

/**
 * What a run of Node's own test runner touched, out of the raw V8 coverage it wrote.
 *
 * @param {string} dir       Folder NODE_V8_COVERAGE was pointed at.
 * @param {string} root      Project root, so paths come back relative and readable.
 * @returns {Promise<Touched>}
 */
export async function readNodeCoverage(dir, root) {
  /** @type {Set<string>} */
  const files = new Set();
  /** @type {Set<string>} */
  const functions = new Set();
  /** @type {string[]} */
  let entries = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return { files: [], functions: [], measured: false, why: 'Node wrote no coverage folder, so what the tests touched is not known.' };
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    /** @type {any} */
    let report;
    try {
      report = JSON.parse(await fsp.readFile(path.join(dir, entry), 'utf8'));
    } catch {
      continue;
    }
    for (const script of report.result ?? []) {
      const rel = relativeIfInside(script.url, root);
      if (!rel) continue;
      files.add(rel);
      for (const fn of script.functions ?? []) {
        if (!fn.functionName) continue;
        const ran = (fn.ranges ?? []).some((/** @type {any} */ range) => range.count > 0);
        if (ran) functions.add(`${rel}:${fn.functionName}`);
      }
    }
  }
  if (files.size === 0) {
    return {
      files: [],
      functions: [],
      measured: false,
      why: 'Coverage came back with none of the project\'s own files in it, so what the tests touched is not known.',
    };
  }
  return keptFunctions(files, functions, `Node reported ${files.size} of the project's own files executing.`);
}

/**
 * The function list, cut to something readable, saying out loud how much was cut.
 *
 * The cut itself is old: a journey listing nine hundred function names is a wall and nobody
 * reads a wall. Announcing it is not. The coverage ledger matches this list against the
 * doors the code reader found, so a list quietly missing three hundred entries makes the
 * ledger ask for work that has already been done — which is the same failure as a green run
 * that means less than it looks like, pointed the other way.
 *
 * @param {Set<string>} files
 * @param {Set<string>} functions
 * @param {string} why
 * @returns {Touched}
 */
function keptFunctions(files, functions, why) {
  const all = [...functions].sort();
  const kept = all.slice(0, TOUCHED_FUNCTION_LIMIT);
  /** @type {Touched} */
  const touched = { files: [...files].sort(), functions: kept, measured: true, why };
  if (all.length > kept.length) {
    touched.ranButNotListed = all.length - kept.length;
    touched.why = `${why} ${all.length} named functions ran and the ${kept.length} listed here are the first of them in alphabetical order, so ${touched.ranButNotListed} that really did run are not named. Anything reading this list to work out what was covered will undercount by that much.`;
  }
  return touched;
}

/**
 * The same question, answered by vitest's own coverage report.
 *
 * @param {string} file      coverage-final.json
 * @param {string} root
 * @returns {Promise<Touched>}
 */
export async function readVitestCoverage(file, root) {
  /** @type {any} */
  let report;
  try {
    report = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return {
      files: [],
      functions: [],
      measured: false,
      why: 'Vitest wrote no coverage report. Its tests run in worker threads, so this needs @vitest/coverage-v8 installed — without it the journey is still good, it just does not know what it touched.',
    };
  }
  /** @type {Set<string>} */
  const files = new Set();
  /** @type {Set<string>} */
  const functions = new Set();
  for (const [absolute, entry] of Object.entries(/** @type {Record<string, any>} */ (report))) {
    const rel = relativeIfInside(absolute, root);
    if (!rel) continue;
    files.add(rel);
    for (const [id, meta] of Object.entries(/** @type {Record<string, any>} */ (entry.fnMap ?? {}))) {
      const hits = entry.f?.[id] ?? 0;
      if (hits > 0 && meta?.name) functions.add(`${rel}:${meta.name}`);
    }
  }
  if (files.size === 0) {
    return { files: [], functions: [], measured: false, why: 'The coverage report named none of the project\'s own files.' };
  }
  return keptFunctions(files, functions, `Vitest reported ${files.size} of the project's own files executing.`);
}

/**
 * A path inside the project, relative and readable — or null for anything outside it, which
 * is node's own internals and everybody's dependencies.
 *
 * @param {string} url    A file URL or an absolute path.
 * @param {string} root
 * @returns {string|null}
 */
export function relativeIfInside(url, root) {
  let absolute = String(url);
  if (absolute.startsWith('file://')) {
    try {
      // `fileURLToPath`, never `.pathname`. On Windows the pathname of
      // `file:///D:/a/project/total.js` is `/D:/a/project/total.js` — with a leading slash —
      // which is absolute enough to pass the test below and yet matches no root, so
      // `path.relative` answered `..\..` and every touched file was thrown away. The
      // coverage measured from a test suite was therefore empty on Windows, quietly. Found by
      // the automated checks on 2026-09-01, the first time they ran on Windows, on a runner
      // that allows symbolic links where the machine it was developed against does not.
      absolute = fileURLToPath(absolute);
    } catch {
      return null;
    }
  }
  if (!path.isAbsolute(absolute)) return null;
  const rel = path.relative(root, absolute).split(path.sep).join('/');
  if (rel === '' || rel.startsWith('..')) return null;
  if (rel.includes('node_modules/')) return null;
  // Node reports a script it was handed on the command line as `[eval1]`, resolved against
  // the working folder, so it arrives looking exactly like a file in the project. It is not
  // one, and a file that does not exist cannot be a door anything walked through.
  if (!/\.[cm]?[jt]sx?$/.test(rel)) return null;
  return rel;
}

// ---------------------------------------------------------------------------
// The harvest
// ---------------------------------------------------------------------------

/**
 * @typedef {object} HarvestOptions
 * @property {string} root
 * @property {Runner} [runner]          Detected when not given.
 * @property {string} [binary]
 * @property {Surface} [surface]        Default 'library'.
 * @property {string[]} [files]         Exact files, relative to the root. Overrides listing.
 * @property {string[]} [only]          Substrings a test file's path must contain.
 * @property {number} [limit]           Stop after this many files. Coverage says so out loud.
 * @property {number} [budgetMs]        Stop harvesting once this much time has gone, and name
 *                                      every file that was not reached. Default
 *                                      `DEFAULT_HARVEST_BUDGET_MS`. Zero means no budget,
 *                                      which is a thing to ask for on purpose and never a
 *                                      default.
 * @property {1|2} [repeat]             Runs per file. Two is the default and it is the point:
 *                                      a journey that does not reproduce twice on the same
 *                                      build is rejected at birth rather than admitted and
 *                                      condemned later.
 * @property {boolean} [coverage]       Measure what each file touched. Default true.
 * @property {number} [timeoutMs]
 * @property {string} [scratchDir]      Somewhere to write. A temp folder by default. NEVER
 *                                      the project.
 * @property {(message: string) => void} [log]
 * @property {AbortSignal} [signal]
 * @property {boolean} [dryRun]         List what would be run and run nothing.
 */

/**
 * @typedef {object} HarvestReport
 * @property {Runner} runner
 * @property {string} why                  Why that runner, in plain English.
 * @property {number} testFilesFound
 * @property {number} testFilesRun
 * @property {number} journeys
 * @property {number} checks               Individual checks the harvested files contain.
 * @property {number} touchedFiles         Distinct project files the suite reached.
 * @property {boolean} touchedMeasured     False when nothing could see what was touched.
 * @property {{file: string, why: string}[]} rejected
 *                                         Files that produced no journey, and why. This is
 *                                         missing coverage, not a pass.
 * @property {{file: string, failed: number}[]} failing
 *                                         Files whose checks did not all pass. Kept anyway —
 *                                         what a test exercises is useful even when it is red.
 * @property {string[]} notReached
 *                                         Test files the budget ran out before. Named one by
 *                                         one, never counted: "some of your tests were
 *                                         skipped" tells a reader nothing they can act on, and
 *                                         a reader who cannot tell which half of their suite is
 *                                         being watched will assume it is all of it.
 * @property {number} [budgetMs]           The budget this harvest was held to, when it had one.
 * @property {Missing[]} missing
 * @property {string[]} notes
 * @property {number} durationMs
 */

/**
 * How long a harvest gets before it stops and says what it did not reach.
 *
 * WHY THERE IS A BUDGET AT ALL. This whole tool is worth using because it is cheap enough to
 * run on every change. A stranger's test suite is not cheap: twenty minutes is an ordinary
 * number for a real one, and the harvest runs every file TWICE to prove it repeats. A check
 * that costs three quarters of an hour is a check nobody runs, and a check nobody runs
 * catches nothing - which is a worse failure than any bug it could have found.
 *
 * Ninety seconds is not a guess about how long suites take. It is a statement about how long
 * somebody will wait inside an edit-and-check loop before deciding to switch the thing off.
 *
 * The budget stops the harvest. It never stops it QUIETLY: every file it did not reach is
 * named in the report and lands in the coverage ledger by name, because a partial harvest
 * reported as a whole one is the tool lying about how much of the product it is watching.
 */
export const DEFAULT_HARVEST_BUDGET_MS = 90_000;

/**
 * Harvest journeys out of a project's own test suite.
 *
 * @param {HarvestOptions} opts
 * @returns {Promise<{journeys: SuiteJourney[], report: HarvestReport}>}
 */
export async function harvestJourneys(opts) {
  const started = Date.now();
  // The real path, never the one we were handed. On a Mac /tmp is a symlink to /private/tmp,
  // so a project reached through /tmp runs its tests and gets coverage back full of
  // /private/tmp paths - every one of which looks like a file outside the project, and every
  // one of which is thrown away. The harvest then says, perfectly calmly, that the tests
  // touched nothing at all. That is a silence, and a silence is the one failure this tool
  // exists to prevent, so the path is resolved once, here, before anything is measured
  // against it.
  const root = await realRoot(opts.root);
  const log = opts.log ?? (() => {});
  const detection = opts.runner
    ? { runner: opts.runner, why: 'The runner was named by the caller.', binary: opts.binary, missing: [], notes: [] }
    : await detectRunner(root);
  const runner = /** @type {Runner} */ (detection.runner);

  /** @type {HarvestReport} */
  const report = {
    runner,
    why: detection.why,
    testFilesFound: 0,
    testFilesRun: 0,
    journeys: 0,
    checks: 0,
    touchedFiles: 0,
    touchedMeasured: false,
    rejected: [],
    failing: [],
    notReached: [],
    missing: [...(detection.missing ?? [])],
    notes: [...(detection.notes ?? [])],
    durationMs: 0,
  };
  const budgetMs = opts.budgetMs ?? DEFAULT_HARVEST_BUDGET_MS;
  if (budgetMs > 0) report.budgetMs = budgetMs;

  if (runner === 'none') {
    report.durationMs = Date.now() - started;
    return { journeys: [], report };
  }

  const listed = opts.files
    ? { files: opts.files, scanned: opts.files.length, cappedAt: undefined }
    : await listTestFiles(root, { limit: opts.limit, only: opts.only });
  report.testFilesFound = listed.files.length;
  if (listed.cappedAt !== undefined) {
    report.notes.push(
      `Only the first ${listed.cappedAt} test files were harvested. The rest of the suite is not covered by these journeys.`,
    );
  }

  if (opts.dryRun) {
    report.notes.push('This was a dry run: the files were listed and none of them were run.');
    report.durationMs = Date.now() - started;
    return { journeys: [], report };
  }

  const scratchDir = opts.scratchDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-harvest-')));
  await fsp.mkdir(scratchDir, { recursive: true });
  const repeat = opts.repeat ?? 2;

  /** @type {SuiteJourney[]} */
  const journeys = [];
  /** @type {Set<string>} */
  const touchedEverything = new Set();

  for (const file of listed.files) {
    if (opts.signal?.aborted) {
      report.rejected.push({ file, why: 'The harvest was stopped before this file was reached.' });
      continue;
    }
    // Checked before starting a file rather than after finishing one, so the budget is a
    // ceiling on when the harvest STARTS work and not a suggestion that one slow file can
    // blow through by ten minutes. What it costs: a file that would just have fitted is left
    // out. What it buys: the number in the budget is the truth.
    if (budgetMs > 0 && Date.now() - started >= budgetMs) {
      report.notReached.push(file);
      continue;
    }
    log(`Running ${file}${repeat > 1 ? ' (twice, to see whether it repeats)' : ''}.`);

    /** @type {OneRun[]} */
    const runs = [];
    for (let i = 0; i < repeat; i++) {
      // Sequential on purpose. Two runs of the same test file at the same time share
      // ports, fixtures and temporary folders, and every difference that comes out of
      // that fight is one this tool would go on to report as real.
      runs.push(
        await runOneFile({
          root,
          file,
          runner,
          scratchDir,
          binary: detection.binary,
          coverage: opts.coverage,
          timeoutMs: opts.timeoutMs,
          signal: opts.signal,
        }),
      );
    }
    report.testFilesRun++;

    const first = runs[0];
    if (!first.ran) {
      report.rejected.push({ file, why: first.trouble ?? 'It reported nothing at all.' });
      continue;
    }
    const disagreement = repeat > 1 ? disagree(runs[0], runs[1]) : null;
    if (disagreement) {
      report.rejected.push({ file, why: disagreement });
      continue;
    }

    const touched = first.touched.measured ? first.touched : runs[runs.length - 1].touched;
    for (const touchedFile of touched.files) touchedEverything.add(touchedFile);
    if (first.failed > 0) report.failing.push({ file, failed: first.failed });
    report.checks += first.tests.length;

    journeys.push(journeyForTestFile({
      root,
      file,
      runner,
      surface: opts.surface ?? 'library',
      binary: detection.binary,
      run: first,
      repeated: repeat > 1,
      timeoutMs: opts.timeoutMs,
    }));
  }

  if (!opts.scratchDir) await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => {});

  if (report.notReached.length > 0) {
    report.notes.push(
      `The harvest stopped after ${Math.round((Date.now() - started) / 1000)} seconds, which is its budget, with ` +
      `${report.notReached.length} test ${report.notReached.length === 1 ? 'file' : 'files'} still to go. Whatever ` +
      `those walk is not being watched. They are named one by one, and a bigger budget or a narrower list of files ` +
      `is how they get in.`,
    );
  }

  report.journeys = journeys.length;
  report.touchedFiles = touchedEverything.size;
  report.touchedMeasured = journeys.some((j) => j.touched?.measured === true);
  if (!report.touchedMeasured && journeys.length > 0) {
    report.notes.push(
      'These journeys do not know which files they touch, so they cannot say which of the doors in the code they open.',
    );
  }
  report.durationMs = Date.now() - started;
  return { journeys, report };
}

/**
 * Did the same test file do the same thing twice?
 *
 * The comparison is on WHAT WAS EXERCISED — the checks that reported and the files that
 * executed — and never on how long anything took or how many times a line ran. A test that
 * reports different checks, or reaches different code, on two runs of identical bytes is
 * not a journey: whatever it later says about a change, it was already saying about nothing.
 *
 * @param {OneRun} a
 * @param {OneRun} b
 * @returns {string|null} the reason it is rejected, or null when it repeats
 */
export function disagree(a, b) {
  if (!b.ran) return 'It reported checks the first time and nothing the second, so it does not repeat.';
  const missingNames = onlyIn(a.tests, b.tests);
  const extraNames = onlyIn(b.tests, a.tests);
  if (missingNames.length > 0 || extraNames.length > 0) {
    const example = missingNames[0] ?? extraNames[0];
    return `Two runs of the same code reported different checks (for instance "${example}"), so this file does not repeat.`;
  }
  if (a.touched.measured && b.touched.measured) {
    const missingFiles = onlyIn(a.touched.files, b.touched.files);
    const extraFiles = onlyIn(b.touched.files, a.touched.files);
    if (missingFiles.length > 0 || extraFiles.length > 0) {
      const example = missingFiles[0] ?? extraFiles[0];
      return `Two runs of the same code went through different files (for instance ${example}), so this file does not repeat.`;
    }
  }
  return null;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {string[]}
 */
function onlyIn(a, b) {
  const other = new Set(b);
  return a.filter((item) => !other.has(item));
}

/**
 * One test file, as a journey.
 *
 * @param {object} spec
 * @param {string} spec.root
 * @param {string} spec.file
 * @param {Runner} spec.runner
 * @param {Surface} spec.surface
 * @param {string} [spec.binary]
 * @param {OneRun} spec.run
 * @param {boolean} spec.repeated
 * @param {number} [spec.timeoutMs]
 * @returns {SuiteJourney}
 */
export function journeyForTestFile(spec) {
  const { command, argv } = runnerCommand(spec.runner, spec.file, { binary: spec.binary, root: spec.root });
  const count = spec.run.tests.length;
  /** @type {JourneyStep} */
  const step = {
    act: 'run-tests',
    runner: spec.runner,
    file: spec.file,
    command,
    argv,
    tests: spec.run.tests,
    note: 'Run this exactly as it was harvested. A test file run a different way is a different journey.',
  };
  /** @type {SuiteJourney} */
  const journey = {
    name: `suite-${slugPath(spec.file)}`,
    describe: `run the ${count} ${count === 1 ? 'check' : 'checks'} in ${spec.file} and watch what they touch`,
    source: 'suite',
    surface: spec.surface,
    from: spec.file,
    channels: ['results', 'complaints', 'counters'],
    steps: [step],
    timeoutMs: spec.timeoutMs,
    touched: spec.run.touched,
  };
  if (spec.repeated) {
    journey.reproducible = {
      how: 'It was run twice while it was harvested, and both runs reported the same checks and went through the same files.',
      at: new Date().toISOString(),
    };
  }
  return journey;
}

/**
 * A file path as a journey name: readable, file-safe, and unique to that path.
 * @param {string} file
 * @returns {string}
 */
export function slugPath(file) {
  return String(file)
    .replace(/\.[cm]?[jt]sx?$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The path a project really lives at, with every symlink on the way resolved.
 *
 * @param {string} root
 * @returns {Promise<string>}
 */
async function realRoot(root) {
  const absolute = path.resolve(root);
  try {
    return await fsp.realpath(absolute);
  } catch {
    return absolute;
  }
}

// ---------------------------------------------------------------------------
// Only the tests near the change
// ---------------------------------------------------------------------------

/**
 * Split harvested journeys into the ones worth walking for this change and the ones that
 * cannot have been touched by it.
 *
 * WHY THIS IS ALLOWED TO BE A FILTER AT ALL. Skipping tests to go faster is normally how a
 * safety net gets holes cut in it, and the usual version of this - guess from the name, walk
 * `total.test.js` because `total.js` changed - earns that reputation, because a name is not
 * evidence.
 *
 * This is not that. Harvesting a file MEASURES what it executed: Node writes the coverage
 * itself, and every harvested journey arrives carrying the list of project files that
 * actually ran. A test file whose measured list holds not one file you touched cannot have
 * run different code, so walking it proves nothing and costs a process launch.
 *
 * THE TWO WAYS THIS COULD BE WRONG, and what is done about each. A test that reaches code by
 * a path the coverage never saw - a child process, a native module - would be dropped on
 * false evidence, so a journey that does not KNOW what it touched is always walked and never
 * filtered. And code reached only on some runs would make the measurement itself unsteady,
 * which is exactly what the harvest's two runs reject a file for. What is left is filtered on
 * a measurement, not on a hunch.
 *
 * Nothing here decides quietly: the ones left out come back named, for the ledger.
 *
 * @param {SuiteJourney[]} journeys
 * @param {string[]} changed          Project files that changed, relative to the root.
 * @returns {{walk: SuiteJourney[], skipped: {journey: string, why: string}[]}}
 */
export function testsNear(journeys, changed) {
  const changedFiles = new Set(changed.map((file) => String(file).split(path.sep).join('/')));
  /** @type {SuiteJourney[]} */
  const walk = [];
  /** @type {{journey: string, why: string}[]} */
  const skipped = [];

  for (const journey of journeys) {
    const touched = journey.touched;
    if (!touched?.measured || touched.files.length === 0) {
      walk.push(journey);
      continue;
    }
    // Its own file counts. A test you edited is the most interesting one there is.
    const reaches = [...touched.files, journey.from ?? ''].some((file) => changedFiles.has(file));
    if (reaches) walk.push(journey);
    else {
      skipped.push({
        journey: journey.name,
        why: 'Nothing it was measured going through was changed, so it would run exactly the same code twice.',
      });
    }
  }
  return { walk, skipped };
}
