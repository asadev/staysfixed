/**
 * The project's own test suite, as journeys — and the scratch copy every run happens in.
 *
 * Two things are held here, and they meet in the middle.
 *
 * The first is the suite harvest, finally attached to something. `harvestJourneys` reads a
 * project's tests and turns each file into a journey; until now the step it produced,
 * `run-tests`, had no handler in any adapter, so the highest-value journey source in the
 * tool walked precisely nothing. What these tests hold is the shape of the answer: which
 * checks a walked test file reported, why each failing one failed, and the fact that a
 * suite already red on both builds is not news while one that goes red on the new build
 * alone is the whole point.
 *
 * The second is `copyForScratch`, which was rewritten to clone rather than copy and shipped
 * without a test. It is the one function in this package that stands between a broken build
 * and somebody's real working tree, so what is checked here is not that it is fast — it is
 * that what it makes is a genuine copy and not a link pointing back at the original.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_HARVEST_BUDGET_MS, harvestJourneys, parseTap, parseTapChecks, quietenRunnerOutput,
  readChecks, testsNear, withoutRunnerTiming,
} from '../../src/v2/journeys/from-suite.js';
import {
  SKIP_BY_DEFAULT, copyForScratch, frozenEnvironment, processAdapter, readWatcher, runCommand,
  suiteObservations, testFileCommand, watcherScript,
} from '../../src/v2/adapters/process.js';
import { scratchDir, cleanUp } from '../support.mjs';

test.after(cleanUp);

// ---------------------------------------------------------------------------
// A tiny project with a real test suite
// ---------------------------------------------------------------------------

const TOTAL_WORKS = [
  'export function total(items) {',
  '  let sum = 0;',
  '  for (const item of items) sum += item.price;',
  '  return Math.round(sum * 100) / 100;',
  '}',
  '',
].join('\n');

const TOTAL_BROKEN = TOTAL_WORKS.replace('  return Math.round(sum * 100) / 100;', '  return sum;');

const TEST_FILE = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { total } from '../total.js';",
  '',
  "test('adds whole pounds', () => {",
  '  assert.equal(total([{ price: 2 }, { price: 3 }]), 5);',
  '});',
  '',
  "test('adds pennies without floating point dust', () => {",
  '  assert.equal(total([{ price: 0.1 }, { price: 0.2 }]), 0.3);',
  '});',
  '',
].join('\n');

/**
 * Write the little project, in whichever state is wanted.
 *
 * The real path, not the one `mkdtemp` handed back: on a Mac /tmp is a symlink to
 * /private/tmp, and a project reached through the symlink gets coverage back full of paths
 * that all look like files outside it.
 *
 * @param {{broken?: boolean, extraTests?: string}} [opts]
 * @returns {Promise<string>}
 */
async function tinyProject(opts = {}) {
  const dir = await fsp.realpath(await scratchDir('staysfixed-suite'));
  await fsp.mkdir(path.join(dir, 'test'), { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'widget', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2),
  );
  await fsp.writeFile(path.join(dir, 'total.js'), opts.broken ? TOTAL_BROKEN : TOTAL_WORKS);
  await fsp.writeFile(path.join(dir, 'test', 'total.test.js'), TEST_FILE);
  if (opts.extraTests) await fsp.writeFile(path.join(dir, 'test', 'more.test.js'), opts.extraTests);
  return dir;
}

/** Everything the adapter needs to walk one journey, pointed at a throwaway folder. */
async function walkingContext() {
  const base = await fsp.realpath(await scratchDir('staysfixed-walk'));
  return {
    signal: undefined,
    scratchDir: path.join(base, 'scratch'),
    evidenceDir: path.join(base, 'evidence'),
    seed: 1,
    clock: '2026-01-01T00:00:00.000Z',
  };
}

/** @param {string} file */
function suiteJourney(file) {
  return {
    name: 'the-suite',
    describe: `run the checks in ${file}`,
    source: /** @type {const} */ ('suite'),
    surface: /** @type {const} */ ('cli'),
    from: file,
    channels: /** @type {const} */ (['results', 'complaints', 'counters']),
    steps: [{
      act: 'run-tests',
      runner: 'node:test',
      file,
      command: 'node',
      argv: ['--test', '--test-reporter=tap', file],
    }],
  };
}

/**
 * Walk one test-file journey against a build and hand back what it said, addressed.
 *
 * @param {string} root
 * @returns {Promise<Map<string, unknown>>}
 */
async function walkSuite(root) {
  const ctx = await walkingContext();
  const build = { id: `build-${path.basename(root)}`, label: 'the build', role: /** @type {const} */ ('candidate'), root };
  const prepared = await processAdapter.prepare(build, /** @type {any} */ (ctx));
  try {
    assert.equal(prepared.ready, true, prepared.why);
    const seen = await processAdapter.run(/** @type {any} */ (suiteJourney('test/total.test.js')), prepared, /** @type {any} */ (ctx));
    return new Map(seen.map((o) => [o.path, o.value]));
  } finally {
    await prepared.dispose();
    await processAdapter.teardown();
  }
}

// ---------------------------------------------------------------------------

describe('reading a test runner back', () => {
  const TAP = [
    'TAP version 13',
    '# Subtest: adds whole pounds',
    'ok 1 - adds whole pounds',
    '  ---',
    '  duration_ms: 0.464833',
    "  type: 'test'",
    '  ...',
    '# Subtest: adds pennies without floating point dust',
    'not ok 2 - adds pennies without floating point dust',
    '  ---',
    '  duration_ms: 0.598583',
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    '    Expected values to be strictly equal',
    '  ...',
    '1..2',
    '# duration_ms 61.85',
  ].join('\n');

  test('each check comes back by name, with whether it passed', () => {
    const checks = parseTapChecks(TAP);
    assert.deepEqual(checks.map((c) => [c.name, c.ok]), [
      ['adds whole pounds', true],
      ['adds pennies without floating point dust', false],
    ]);
  });

  test('a failing check brings back what the runner said about it', () => {
    const failed = parseTapChecks(TAP).find((c) => !c.ok);
    assert.match(String(failed?.detail), /Expected values to be strictly equal/);
    assert.doesNotMatch(
      String(failed?.detail),
      /duration_ms/,
      'the runner’s stopwatch is in there too, and comparing it would report a difference on every single run',
    );
  });

  test('a passing check carries no detail, so a pass is one small value and not a paragraph', () => {
    assert.equal(parseTapChecks(TAP)[0].detail, undefined);
  });

  test('the older name-only reader still answers the same question', () => {
    const summary = parseTap(TAP);
    assert.deepEqual(summary.tests, ['adds pennies without floating point dust', 'adds whole pounds']);
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 1);
  });

  test('taking the stopwatch out leaves every other line exactly where it was', () => {
    const quiet = withoutRunnerTiming(TAP);
    assert.doesNotMatch(quiet, /duration_ms/);
    assert.match(quiet, /not ok 2 - adds pennies/);
    assert.match(quiet, /# Subtest: adds whole pounds/);
    assert.equal(
      quiet.split('\n').length,
      TAP.split('\n').length - 3,
      'exactly the three timing lines and nothing else',
    );
  });

  test("vitest's clock keys are replaced by name, and nothing else in its report is touched", () => {
    const report = JSON.stringify({
      startTime: 1735689600000,
      testResults: [{
        endTime: 1735689601000,
        assertionResults: [
          { title: 'it adds up', status: 'passed', duration: 12.5, ancestorTitles: ['total'] },
          { title: 'it rounds', status: 'failed', duration: 3, failureMessages: ['expected 0.3'], ancestorTitles: ['total'] },
        ],
      }],
    });
    const quiet = quietenRunnerOutput('vitest', report);
    assert.doesNotMatch(quiet, /1735689600000/);
    assert.match(quiet, /a time, not compared/);
    assert.match(quiet, /it adds up/, 'the names survive');
    assert.match(quiet, /expected 0\.3/, 'and so does what a failure said');
  });

  test('output nobody recognises comes back with the line rule and no guessing', () => {
    const odd = 'this is not TAP and not JSON\nduration_ms: 4\nstill here';
    assert.equal(quietenRunnerOutput('node:test', odd), 'this is not TAP and not JSON\nstill here');
  });

  test('nothing readable is reported as "not known", never as a file with no checks in it', () => {
    const read = readChecks('node:test', 'Error: cannot find module\n');
    assert.equal(read.read, false);
    assert.equal(read.checks.length, 0);
    assert.match(read.why, /not known/);
  });
});

describe('the command a harvested test file is walked with', () => {
  /**
   * One argument as THIS machine's shell would want it written.
   *
   * These three checks used to spell the quoting out as `'...'` and pass, on a Mac. `cmd.exe`
   * does not read a single quote as a quote at all, so the code they check now writes double
   * quotes on Windows — and a test that hard-codes one platform's quoting is a test that can
   * only ever be run on that platform. Measured on a real Windows 11 machine on 2026-08-31,
   * where this whole suite had never been run before.
   *
   * @param {string} text
   */
  const quoted = (text) => (process.platform === 'win32' ? `"${text.replace(/"/g, '""')}"` : `'${text}'`);

  test('every part is quoted, so a folder with a space in it is not a bug', () => {
    const line = testFileCommand({ command: process.execPath, argv: ['--test', 'test/my tests/a.test.js'] });
    assert.equal(line, `${quoted(process.execPath)} ${quoted('--test')} ${quoted('test/my tests/a.test.js')}`);
  });

  test('a Node that is not on this machine is replaced with the one that is', () => {
    const line = testFileCommand({ command: '/nowhere/at/all/node', argv: ['--test'] });
    assert.ok(
      line.startsWith(quoted(process.execPath)),
      `the command has to start with this machine's own Node, quoted for this machine's shell — it was ${line}`,
    );
    assert.doesNotMatch(
      line,
      /nowhere/,
      'left alone it would fail identically on BOTH builds, which produces no difference and reads exactly like a clean check',
    );
  });

  test('a program named rather than pathed is left for the shell to find', () => {
    assert.equal(
      testFileCommand({ command: 'npx', argv: ['vitest', 'run'] }),
      `${quoted('npx')} ${quoted('vitest')} ${quoted('run')}`,
    );
  });
});

describe('walking a test file the harvest found', () => {
  test('it names every check, and says which one failed', async () => {
    const broken = await walkSuite(await tinyProject({ broken: true }));
    assert.equal(broken.get('test.the-suite.adds whole pounds'), 'passed');
    assert.equal(broken.get('test.the-suite.adds pennies without floating point dust'), 'failed');
    assert.equal(broken.get('count.the-suite.checks that failed'), 1);
    assert.match(
      String(broken.get('test.the-suite.adds pennies without floating point dust.why it failed')),
      /strictly equal/,
    );
  });

  test('a suite that passes says so at every address, with no failure paragraphs', async () => {
    const fine = await walkSuite(await tinyProject());
    assert.equal(fine.get('test.the-suite.adds pennies without floating point dust'), 'passed');
    assert.equal(fine.get('count.the-suite.checks that failed'), 0);
    assert.equal(fine.get('test.the-suite.adds pennies without floating point dust.why it failed'), undefined);
  });

  test('a suite that fails on BOTH builds produces the same values twice, so it is not news', async () => {
    const first = await walkSuite(await tinyProject({ broken: true }));
    const second = await walkSuite(await tinyProject({ broken: true }));
    for (const key of ['test.the-suite.adds pennies without floating point dust', 'count.the-suite.checks that failed']) {
      assert.deepEqual(first.get(key), second.get(key), `${key} has to be identical, or an old failure reports as a new one`);
    }
  });

  test('a check that goes from passing to failing is the difference the whole feature exists for', async () => {
    const before = await walkSuite(await tinyProject());
    const after = await walkSuite(await tinyProject({ broken: true }));
    const address = 'test.the-suite.adds pennies without floating point dust';
    assert.equal(before.get(address), 'passed');
    assert.equal(after.get(address), 'failed');
  });

  test('what the runner printed is compared with its stopwatch out of it', async () => {
    const printed = String((await walkSuite(await tinyProject())).get('cli.the-suite.stdout'));
    assert.match(printed, /ok 1 - adds whole pounds/);
    assert.doesNotMatch(printed, /duration_ms/);
  });

  test('the test file names itself, so an edited test cannot look like a broken product', async () => {
    const asWritten = await tinyProject();
    const edited = await tinyProject();
    await fsp.writeFile(
      path.join(edited, 'test', 'total.test.js'),
      `${TEST_FILE}\ntest('and one more', () => {});\n`,
    );
    const a = await walkSuite(asWritten);
    const b = await walkSuite(edited);
    assert.notEqual(
      a.get('test.the-suite.the test file itself'),
      b.get('test.the-suite.the test file itself'),
      'without this, every difference under an edited test reads as a break in the product',
    );
    assert.deepEqual(
      a.get('test.the-suite.the checks it contains'),
      ['adds pennies without floating point dust', 'adds whole pounds'],
    );
  });

  test('a step with no file to run is a hole with a reason, never a quiet pass', async () => {
    const ctx = await walkingContext();
    const root = await tinyProject();
    const build = { id: 'nothing-to-run', label: 'the build', role: /** @type {const} */ ('candidate'), root };
    const prepared = await processAdapter.prepare(build, /** @type {any} */ (ctx));
    const journey = { ...suiteJourney('test/total.test.js'), steps: [{ act: 'run-tests', runner: 'node:test' }] };
    const seen = await processAdapter.run(/** @type {any} */ (journey), prepared, /** @type {any} */ (ctx));
    await prepared.dispose();
    await processAdapter.teardown();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].meta?.refused, true);
    assert.match(String(seen[0].meta?.describe), /a hole, not a pass/);
  });

  test('a runner that printed nothing readable is a hole too, and the run is still described', async () => {
    const seen = await suiteObservations({
      journey: /** @type {any} */ ({ name: 'the-suite', describe: 'run the checks' }),
      step: { file: 'test/total.test.js' },
      runner: 'node:test',
      result: /** @type {any} */ ({ stdout: 'command not found', stderr: '', code: 127, signal: null, timedOut: false, ms: 4 }),
      root: '/nowhere',
    });
    const byPath = new Map(seen.map((o) => [o.path, o]));
    assert.equal(byPath.get('test.the-suite.the checks it reported')?.meta?.refused, true);
    assert.equal(
      byPath.get('test.the-suite.the test file itself')?.value,
      'there is no such file in this build',
      'and it still says the test file is missing rather than saying nothing',
    );
  });
});

describe('running a stranger’s suite is held to a budget', () => {
  test('when the budget runs out, the files it never reached are named one by one', async () => {
    const root = await tinyProject({ extraTests: "import { test } from 'node:test';\ntest('another', () => {});\n" });
    const harvest = await harvestJourneys({ root, budgetMs: 1, surface: 'cli' });

    assert.equal(harvest.report.testFilesFound, 2);
    assert.ok(harvest.report.notReached.length >= 1, 'a budget of one millisecond has to stop it');
    for (const file of harvest.report.notReached) assert.match(file, /^test\/.+\.test\.js$/);
    assert.equal(
      harvest.journeys.length + harvest.report.notReached.length + harvest.report.rejected.length,
      harvest.report.testFilesFound,
      'every file found is either a journey, a named rejection or a named miss - nothing may just disappear',
    );
    assert.match(harvest.report.notes.join(' '), /budget/i);
  });

  test('a budget of zero is asking for no budget, and is never the default', async () => {
    const root = await tinyProject();
    const harvest = await harvestJourneys({ root, budgetMs: 0, surface: 'cli' });
    assert.equal(harvest.report.notReached.length, 0);
    assert.equal(harvest.report.journeys, 1);
    assert.equal(harvest.report.budgetMs, undefined);
    assert.equal(typeof DEFAULT_HARVEST_BUDGET_MS, 'number');
    assert.ok(DEFAULT_HARVEST_BUDGET_MS > 0, 'the default has to be a real ceiling, or there is no decision here at all');
  });

  test('what a test file touched is measured even when the project is reached through a symlink', async () => {
    const real = await tinyProject();
    const parent = await fsp.realpath(await scratchDir('staysfixed-link'));
    const link = path.join(parent, 'project');
    await fsp.symlink(real, link, 'dir');
    const harvest = await harvestJourneys({ root: link, surface: 'cli' });
    assert.equal(harvest.report.touchedMeasured, true, 'reached through a link it used to report, calmly, that the tests touched nothing');
    assert.ok(harvest.journeys[0]?.touched?.files.includes('total.js'));
  });
});

describe('only the tests near the change', () => {
  /** @param {string} name @param {string[]} files */
  const measured = (name, files) => /** @type {any} */ ({
    name, from: `test/${name}.test.js`, source: 'suite', surface: 'cli', describe: name, steps: [],
    touched: { files, functions: [], measured: true, why: 'measured' },
  });

  test('a test measured going nowhere near the change is left out, and named', () => {
    const split = testsNear(
      [measured('total', ['total.js']), measured('label', ['label.js'])],
      ['total.js'],
    );
    assert.deepEqual(split.walk.map((j) => j.name), ['total']);
    assert.deepEqual(split.skipped.map((s) => s.journey), ['label']);
  });

  test('a test whose own file you edited is walked, because that is the interesting one', () => {
    const split = testsNear([measured('label', ['label.js'])], ['test/label.test.js']);
    assert.deepEqual(split.walk.map((j) => j.name), ['label']);
  });

  test('a journey that does not KNOW what it touched is always walked, never filtered on nothing', () => {
    const blind = /** @type {any} */ ({
      name: 'blind', from: 'test/blind.test.js', source: 'suite', surface: 'cli', describe: 'blind', steps: [],
      touched: { files: [], functions: [], measured: false, why: 'nothing could measure it' },
    });
    assert.deepEqual(testsNear([blind], ['total.js']).walk.map((j) => j.name), ['blind']);
  });
});

// ---------------------------------------------------------------------------
// The scratch copy
// ---------------------------------------------------------------------------

describe('the scratch copy a run happens in', () => {
  /** @returns {Promise<string>} a small project with something in every corner */
  async function projectToCopy() {
    const from = await fsp.realpath(await scratchDir('staysfixed-from'));
    await fsp.mkdir(path.join(from, 'src'), { recursive: true });
    await fsp.mkdir(path.join(from, '.git'), { recursive: true });
    await fsp.mkdir(path.join(from, 'coverage'), { recursive: true });
    await fsp.mkdir(path.join(from, 'huge'), { recursive: true });
    await fsp.writeFile(path.join(from, 'src', 'index.js'), 'export const answer = 42;\n');
    await fsp.writeFile(path.join(from, 'package.json'), '{"name":"widget"}\n');
    await fsp.writeFile(path.join(from, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fsp.writeFile(path.join(from, 'coverage', 'lcov.info'), 'TN:\n');
    await fsp.writeFile(path.join(from, 'huge', 'blob.bin'), 'x'.repeat(1024));
    return from;
  }

  test('what it makes is a copy, not a link back at the real project', async () => {
    const from = await projectToCopy();
    const to = path.join(await scratchDir('staysfixed-to'), 'work');
    const copy = await copyForScratch(from, to);
    assert.equal(copy.copied, true, copy.why);

    const original = path.join(from, 'src', 'index.js');
    const clone = path.join(to, 'src', 'index.js');
    const there = await fsp.lstat(clone);
    assert.equal(there.isSymbolicLink(), false, 'a symlink would put every write straight into the real working tree');
    assert.notEqual(
      there.ino,
      (await fsp.lstat(original)).ino,
      'a hardlink shares the inode, so writing to one writes to the other - which is the one thing this function exists to prevent',
    );
  });

  test('a write into the copy cannot reach the original', async () => {
    const from = await projectToCopy();
    const to = path.join(await scratchDir('staysfixed-to'), 'work');
    await copyForScratch(from, to);

    await fsp.writeFile(path.join(to, 'src', 'index.js'), 'export const answer = 0; // a broken build did this\n');
    await fsp.writeFile(path.join(to, 'src', 'brand-new.js'), 'made during a run\n');
    await fsp.rm(path.join(to, 'package.json'));

    assert.equal(await fsp.readFile(path.join(from, 'src', 'index.js'), 'utf8'), 'export const answer = 42;\n');
    assert.equal(fs.existsSync(path.join(from, 'src', 'brand-new.js')), false);
    assert.equal(fs.existsSync(path.join(from, 'package.json')), true);
  });

  test('the folders nobody reads are left behind, and it says which', async () => {
    const from = await projectToCopy();
    const to = path.join(await scratchDir('staysfixed-to'), 'work');
    const copy = await copyForScratch(from, to);

    for (const name of ['.git', 'coverage']) {
      assert.equal(fs.existsSync(path.join(to, name)), false, `${name} is regenerated on demand and read by nothing`);
      assert.ok(copy.skipped.includes(name));
      assert.match(copy.why, new RegExp(name.replace('.', '\\.')));
    }
    assert.equal(fs.existsSync(path.join(to, 'src', 'index.js')), true, 'and everything a command could read is still there');
    assert.equal(fs.existsSync(path.join(to, 'huge')), true, 'nothing is skipped for being big unless the project said so');
  });

  test('`also` adds to the defaults and never replaces them', async () => {
    const from = await projectToCopy();
    const to = path.join(await scratchDir('staysfixed-to'), 'work');
    const copy = await copyForScratch(from, to, { also: ['huge'] });

    assert.equal(fs.existsSync(path.join(to, 'huge')), false, 'the project asked for this one to be left behind');
    assert.equal(fs.existsSync(path.join(to, '.git')), false, 'and asking must not switch the defaults off');
    assert.deepEqual(copy.skipped.sort(), ['.git', 'coverage', 'huge']);
    assert.ok(SKIP_BY_DEFAULT.includes('.git'));
  });

  test('`skip` given on its own is the whole list, for a caller that means it', async () => {
    const from = await projectToCopy();
    const to = path.join(await scratchDir('staysfixed-to'), 'work');
    const copy = await copyForScratch(from, to, { skip: ['huge'] });
    assert.deepEqual(copy.skipped, ['huge']);
    assert.equal(fs.existsSync(path.join(to, '.git')), true);
  });

  test('where the filesystem refuses to clone, it copies, and the answer is the same', async () => {
    const from = await projectToCopy();
    const to = path.join(await scratchDir('staysfixed-to'), 'work');

    // Force the fallback the only way that proves anything: take `cp` off the path, so the
    // clone cannot even be attempted. A machine without reflinks has to end up with exactly
    // the same folder, only slower - if it does not, this function is a coin toss that lands
    // on somebody's real project.
    const realPath = process.env.PATH;
    process.env.PATH = path.join(from, 'no-programs-here');
    /** @type {Awaited<ReturnType<typeof copyForScratch>>} */
    let copy;
    try {
      copy = await copyForScratch(from, to);
    } finally {
      process.env.PATH = realPath;
    }

    assert.equal(copy.copied, true, copy.why);
    assert.equal(copy.cloned, false, 'nothing could have been cloned with no `cp` to do it');
    assert.match(copy.why, /copied into a scratch folder/);
    assert.equal(await fsp.readFile(path.join(to, 'src', 'index.js'), 'utf8'), 'export const answer = 42;\n');
    assert.equal(fs.existsSync(path.join(to, '.git')), false, 'and the skips still hold on the slow path');
    assert.equal(
      (await fsp.lstat(path.join(to, 'src', 'index.js'))).isSymbolicLink(),
      false,
    );
  });

  test('a project that is not there is a plain sentence, not a thrown error', async () => {
    const to = path.join(await scratchDir('staysfixed-to'), 'work');
    const copy = await copyForScratch(path.join(to, 'no-such-project'), to);
    assert.equal(copy.copied, false);
    assert.match(copy.why, /could not be read/);
  });
});

// ---------------------------------------------------------------------------
// The watcher has to observe without changing anything
// ---------------------------------------------------------------------------

describe('the watcher that rides inside every run', () => {
  /**
   * Run a command under the real generated watcher, in a folder of its own.
   *
   * @param {string} command
   * @param {string} [program]   Written to `program.mjs` beside it first, for anything too
   *                             long to survive being quoted onto a command line.
   * @returns {Promise<{code: number|null, stdout: string, stderr: string, watched: import('../../src/v2/adapters/process.js').WatchedEvents}>}
   */
  async function under(command, program) {
    const dir = await fsp.realpath(await scratchDir('staysfixed-watch'));
    const watcher = path.join(dir, 'watcher.mjs');
    const reportFile = path.join(dir, 'watched.jsonl');
    await fsp.writeFile(watcher, watcherScript({ reportFile, allowLoopback: true }), 'utf8');
    if (program) await fsp.writeFile(path.join(dir, 'program.mjs'), program);
    const env = frozenEnvironment({
      clock: '2026-01-01T00:00:00.000Z',
      seed: 1,
      home: dir,
      tmp: dir,
      extra: { NODE_OPTIONS: `--import file://${watcher}` },
    });
    const result = await runCommand(command, { cwd: dir, env, timeoutMs: 120000 });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr, watched: await readWatcher(reportFile) };
  }

  test('a program can still write to its own environment and read it back', async () => {
    // Read back inside a CHILD, because that is what actually broke: the assignment has to
    // reach the real environment object, not a proxy sitting in front of it.
    const ran = await under(
      `node -e "process.env.WIDGET_MODE='live'; require('child_process').execSync('node -e ' + JSON.stringify('process.stdout.write(String(process.env.WIDGET_MODE))'), {stdio:'inherit'})"`,
    );
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stdout, 'live');
  });

  test('every trap the environment proxy needs is really there, deleting included', async () => {
    const ran = await under(
      `node -e "process.env.A='1'; delete process.env.A; process.stdout.write(JSON.stringify(['A' in process.env, Object.keys(process.env).length > 0]))"`,
    );
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stdout, '[false,true]');
  });

  test('a connection to anywhere but this machine is written down and then refused', async () => {
    // Every client anybody uses, because they end up on one prototype by three different
    // routes, and until 2026-08-30 all three of them walked straight out: Node hands
    // `Socket.prototype.connect` the normalised [options, callback] ARRAY, reading `.host`
    // off an array gives nothing, and nothing counted as "this machine".
    const ran = await under('node program.mjs', [
      "import net from 'node:net';",
      "import http from 'node:http';",
      'const said = [];',
      'const tried = (how) => new Promise((done) => {',
      "  if (how === 'fetch') { fetch('http://blocked.invalid/pay').then(() => { said.push('fetch got out'); done(); }, () => { said.push('fetch refused'); done(); }); return; }",
      "  if (how === 'http') { const r = http.get('http://blocked.invalid/pay', () => { said.push('http got out'); done(); }); r.on('error', () => { said.push('http refused'); done(); }); return; }",
      "  const s = net.connect(80, 'blocked.invalid');",
      "  s.on('connect', () => { said.push('net got out'); s.destroy(); done(); });",
      "  s.on('error', () => { said.push('net refused'); done(); });",
      '});',
      "for (const how of ['fetch', 'http', 'net']) await tried(how);",
      'console.log(said.join(", "));',
    ].join('\n'));

    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stdout.trim(), 'fetch refused, http refused, net refused');
    assert.equal(
      ran.watched.reachedOut.filter((a) => a.host === 'blocked.invalid').length,
      3,
      'refusing it and never writing it down would leave the run looking like one that never reached for anything',
    );
  });

  test('refusing a connection does not kill the program that made it', async () => {
    // The refusal has to arrive the way a real one does. Emitting 'error' on the socket
    // ourselves looked right and killed the product: at that moment nothing is listening on
    // the socket yet, and in Node an 'error' event with no listener is a thrown exception.
    // Nobody attaches a handler to the socket underneath `http.get`, and plenty of ordinary
    // code never attaches one at all — so a product that so much as pinged something died
    // with exit 1, and the run then reported the product as broken. A tool blaming a product
    // for something the tool did is the whole thing this package exists to prevent.
    const ran = await under('node program.mjs', [
      "import net from 'node:net';",
      "import http from 'node:http';",
      '// Not one error handler on a socket anywhere, which is how most code is written.',
      "net.connect(80, 'blocked.invalid');",
      "http.get('http://blocked.invalid/pay').on('error', () => {});",
      "await new Promise((done) => setTimeout(done, 600));",
      "console.log('the product finished its own work');",
    ].join('\n'));

    assert.equal(ran.code, 0, `the product was killed by the boundary meant to protect it: ${ran.stderr}`);
    assert.equal(ran.stdout.trim(), 'the product finished its own work');
    assert.equal(
      ran.watched.reachedOut.filter((a) => a.host === 'blocked.invalid').length,
      2,
      'and both attempts still have to be written down, or the run looks like one that reached for nothing',
    );
  });

  test('this machine is still reachable, or nothing with a server of its own could be checked', async () => {
    const ran = await under('node program.mjs', [
      "import http from 'node:http';",
      'const server = http.createServer((_q, s) => s.end("hello from the product"));',
      'await new Promise((ready) => server.listen(0, "127.0.0.1", ready));',
      'const { port } = server.address();',
      'const reply = await fetch(`http://127.0.0.1:${port}/`);',
      'console.log(await reply.text());',
      'server.close();',
    ].join('\n'));
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stdout.trim(), 'hello from the product');
  });

  test('npm runs under it — the default start command `init` writes goes through npm', async (t) => {
    const version = await runCommand('npm --version', { cwd: process.cwd(), env: /** @type {any} */ (process.env), timeoutMs: 60000 });
    if (version.code !== 0) {
      t.skip('there is no npm on this machine');
      return;
    }
    const ran = await under('npm --version');
    assert.equal(
      ran.code,
      0,
      `npm died under the watcher. It exits 1 and prints nothing at all when the environment proxy will not take a write, and every product started with \`npm run start\` then looks like a product that will not boot. It said: ${ran.stderr}`,
    );
    assert.match(ran.stdout.trim(), /^\d+\./);
  });
});
