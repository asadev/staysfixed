/**
 * The corpus of deliberately broken builds.
 *
 * A tool that reports "nothing changed" is indistinguishable from a tool that
 * is broken. Every green run this thing ever produces is worth exactly as much
 * as the evidence that it can still go red, and there is no other way to get
 * that evidence: you cannot test a difference engine by reading it.
 *
 * So this builds nine tiny products, each as a real repository with a working
 * commit and an uncommitted change on top - which is exactly the shape of the
 * thing an agent points this tool at - runs the engine over each, and fails
 * loudly if a break gets through.
 *
 * Six of the nine are breaks that MUST be caught. Three are the other half of
 * the same promise, and they matter just as much: pairs that must produce NO
 * findings at all. A tool that cries wolf gets switched off, and a tool that is
 * switched off catches nothing, so a false alarm fails this run exactly the way
 * a miss does.
 *
 *   staysfixed check --selfcheck
 *   node src/v2/selfcheck.js --only rounded --keep
 *
 * Exit codes from `main`: 0 every case behaved, 1 something got past the engine
 * or a clean pair raised a false alarm, 2 the corpus could not be run at all.
 * Two is not one: "I could not test this" must never be filed under "nothing
 * escaped".
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// The corpus finds the engine exactly the way the MCP surface does. If those two
// ever looked in different places, the corpus would be proving something other
// than what an agent actually runs, which is worse than having no corpus at all.
import { loadEngine } from './mcp/tools.js';

const run = promisify(execFile);

// ---------------------------------------------------------------------------
// The products, and the one thing wrong with each
// ---------------------------------------------------------------------------

/**
 * One case: a tiny product written twice, and what the engine has to say about
 * the pair.
 *
 * `mustSay` is matched against everything a finding carries - its sentence, its
 * addresses and its sample values - so a finding that names the right thing in
 * different words still passes. What it cannot do is pass by finding something
 * else entirely, which is the failure mode that makes a corpus worthless.
 *
 * @typedef {object} Case
 * @property {string} name           A sentence, because it is read back as one.
 * @property {string} breaks         What is wrong, in plain English.
 * @property {'a finding'|'nothing'|'no answer'} expect
 * @property {RegExp[]} [mustSay]
 * @property {boolean} [mustBeUnstable]  It has to land in `newlyUnstable`, not in the findings.
 * @property {'guard'|'crash'|'data-loss'|'money'|'sign-in'} [mustBeSealed]
 *   The finding has to land in a class no agent may wave through. A break that IS one of
 *   those and is filed `ordinary` is not caught, however loudly it is reported: `ordinary`
 *   is precisely the class an agent is allowed to close on its own, so a mislabelled
 *   crash or charge is a silence with a paragraph attached to it.
 * @property {RegExp[]} [summaryMustSay]
 *   Things the closing paragraph has to say. Some of what this tool owes a reader is not a
 *   finding at all — how much of the run was really compared, whether what it saw was
 *   saved — and the only place those appear is the sentence a person actually reads.
 * @property {Record<string, unknown>[]} [journeys]
 *   A journeys file of its own, for a case about what happens when a journey cannot be
 *   walked. Left out, every case gets the one-step "run it" journey.
 * @property {(dir: string, working: string) => Promise<{ready: boolean, why: string}>} [prepare]
 *   Bend the machine around the product before the engine runs — take away permission to
 *   write, for instance. Answering `ready: false` means this machine cannot be made to do
 *   it (running as root, or a filesystem that ignores permissions), and the case reports
 *   itself as untested rather than as a pass.
 * @property {(broken: boolean) => Record<string, string>} build
 */

/** Every fixture is its own tiny package, so nothing leaks between them. */
const PKG = JSON.stringify({ name: 'widget', version: '1.0.0', type: 'module', bin: { widget: 'cli.js' } }, null, 2) + '\n';

/** @type {Case[]} */
export const CASES = [
  {
    name: 'a route that starts failing',
    breaks: 'A route that used to answer with the orders now fails with a 500.',
    expect: 'a finding',
    mustSay: [/orders/i, /500/],
    build: (broken) => ({
      'package.json': PKG,
      'cli.js': [
        "import http from 'node:http';",
        '',
        'const server = http.createServer((req, res) => {',
        "  if (req.url === '/orders') {",
        broken
          ? "    res.writeHead(500, { 'content-type': 'application/json' });\n    res.end('{\"error\":\"could not load orders\"}');\n    return;"
          : "    res.writeHead(200, { 'content-type': 'application/json' });\n    res.end('{\"orders\":2}');\n    return;",
        '  }',
        '  res.writeHead(404);',
        "  res.end('not found');",
        '});',
        '',
        "await new Promise((done) => server.listen(0, '127.0.0.1', done));",
        'const address = server.address();',
        "const port = typeof address === 'object' && address ? address.port : 0;",
        'const reply = await fetch(`http://127.0.0.1:${port}/orders`);',
        'console.log(`GET /orders -> ${reply.status}`);',
        'console.log(await reply.text());',
        'server.close();',
        '',
      ].join('\n'),
    }),
  },

  {
    name: 'a field dropped from a reply',
    breaks: 'A field quietly disappeared from a reply that everything downstream reads.',
    expect: 'a finding',
    mustSay: [/email/i],
    build: (broken) => ({
      'package.json': PKG,
      'cli.js': [
        'const person = {',
        '  id: 7,',
        "  name: 'Ada',",
        broken ? null : "  email: 'ada@example.com',",
        "  city: 'London',",
        '};',
        'console.log(JSON.stringify(person));',
        '',
      ]
        .filter((line) => line !== null)
        .join('\n'),
    }),
  },

  {
    name: 'a different exit code',
    breaks: 'The program still prints the same thing but stops with a failure code.',
    expect: 'a finding',
    mustSay: [/exit|stopped|status|code/i],
    build: (broken) => ({
      'package.json': PKG,
      'cli.js': ["console.log('report written');", ...(broken ? ['process.exit(3);'] : []), ''].join('\n'),
    }),
  },

  {
    name: 'a file that is no longer written',
    breaks: 'A file that used to be written on every run is not written any more. Nothing errors.',
    expect: 'a finding',
    mustSay: [/report/i],
    build: (broken) => ({
      'package.json': PKG,
      'cli.js': [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        '',
        "const out = path.join(process.cwd(), 'out');",
        'fs.mkdirSync(out, { recursive: true });',
        broken ? '// the report is no longer written' : "fs.writeFileSync(path.join(out, 'report.txt'), 'two orders\\n');",
        "console.log('done');",
        '',
      ].join('\n'),
    }),
  },

  {
    name: 'a door removed from the desktop app',
    breaks: 'A channel the desktop app exposes was deleted. Nothing has to run for this one - it is read straight out of the source.',
    expect: 'a finding',
    mustSay: [/save-note/i],
    build: (broken) => ({
      'package.json': PKG,
      'cli.js': "console.log('desktop shell');\n",
      'main.js': [
        "import { ipcMain } from 'electron';",
        '',
        "ipcMain.handle('list-notes', async () => []);",
        broken ? null : "ipcMain.handle('save-note', async (_e, note) => note);",
        "ipcMain.handle('delete-note', async (_e, id) => id);",
        '',
      ]
        .filter((line) => line !== null)
        .join('\n'),
    }),
  },

  {
    name: 'a total quietly rounded',
    breaks: 'A total is rounded. Nothing errors, nothing looks wrong, and the number is different.',
    expect: 'a finding',
    mustSay: [/10\.0/],
    build: (broken) => ({
      'package.json': PKG,
      'cli.js': [
        'const lines = [3.335, 3.335, 3.335];',
        'const total = lines.reduce((sum, n) => sum + n, 0);',
        broken ? 'console.log(`total ${(Math.round(total * 100) / 100).toFixed(2)}`);' : 'console.log(`total ${total}`);',
        '',
      ].join('\n'),
    }),
  },

  {
    name: 'two identical builds stay silent',
    breaks: 'Nothing at all. The engine has to say so by saying nothing.',
    expect: 'nothing',
    build: () => ({
      'package.json': PKG,
      'cli.js': ["console.log('total 10.005');", "console.log('two orders');", ''].join('\n'),
    }),
  },

  {
    name: 'a product that wobbles stays silent',
    breaks:
      'Nothing, but the product disagrees with itself on every run - a timestamp and a random number. Running the new build twice is what tells that apart from a real difference, and the report has to come back empty.',
    expect: 'nothing',
    build: () => ({
      'package.json': PKG,
      'cli.js': ['console.log(`built ${new Date().toISOString()}`);', 'console.log(`run ${Math.floor(Math.random() * 1e9)}`);', "console.log('total 10.005');", ''].join('\n'),
    }),
  },

  {
    name: 'a break buried in the middle of a huge output',
    breaks:
      'A program prints more than the tool will store, and the thing that broke is in the middle — past the head it keeps and before the tail it keeps. This is the case the tool used to be blind to: it kept the two ends and a COARSE size, so a change in the discarded middle left a byte-identical record and the run reported that nothing had changed. Exactly the shape of failure this whole thing exists to prevent, and it survived until 2026-08-30.',
    expect: 'a finding',
    // The marker in the middle is what has to have caught it. If some other part of the value
    // reported instead, this case has stopped testing what it was written to test.
    mustSay: [/bytes left out of the middle/],
    build: (broken) => ({
      'package.json': PKG,
      'cli.js': [
        "console.log('report begins');",
        'for (let i = 0; i < 6000; i += 1) {',
        broken
          ? "  console.log(i === 3000 ? `row ${i}: could not be loaded at all` : `row ${i}: ok`);"
          : '  console.log(`row ${i}: ok`);',
        '}',
        "console.log('report ends');",
        '',
      ].join('\n'),
    }),
  },

  {
    name: 'a build that takes ten times longer stays silent',
    breaks:
      'Nothing, and the product is markedly slower. How long something took is recorded and never compared, because a stopwatch on a shared machine measures the machine as much as the product — and comparing it is what made this corpus fail one case out of nine on a busy laptop while passing five times in a row on a quiet one. This case exists so that decision cannot be quietly undone: put timing back into the comparison and this goes red.',
    expect: 'nothing',
    build: (broken) => ({
      'package.json': PKG,
      'cli.js': [
        // A sleep, deliberately, and never a busy loop. Loading the machine to test timing
        // is how you take four other things down with you.
        `await new Promise((done) => setTimeout(done, ${broken ? 900 : 40}));`,
        "console.log('total 10.005');",
        '',
      ].join('\n'),
    }),
  },

  {
    name: 'a value that used to be steady is now random',
    breaks:
      'A value that was the same on every single run is now different every run. Nothing is obviously broken, which is exactly why this class of bug survives for months.',
    expect: 'a finding',
    // No `mustSay` here, and that is deliberate. A newly unpredictable address
    // is reported as an address, not as a value, and this corpus does not get to
    // dictate what the engine names its addresses. What it does get to demand is
    // that SOMETHING was flagged as having stopped sitting still, and that it was
    // not quietly filed as an ordinary changed value.
    mustBeUnstable: true,
    build: (broken) => ({
      'package.json': PKG,
      'cli.js': [broken ? 'console.log(`batch id ${Math.floor(Math.random() * 1e9)}`);' : 'console.log(`batch id 4242`);', "console.log('two orders');", ''].join('\n'),
    }),
  },

  {
    name: 'a run that could not answer says so instead of passing',
    breaks:
      'The break is real and it is hidden by the product itself: this build writes a fresh set of randomly named files on every run and stamps a random id on what it prints, so the same build disagrees with itself about nearly every address it has. Everything that wobbles is subtracted before anything is compared — which is right, and which here removes the comparison altogether. The only honest answer is that this run says nothing, and until 2026-08-30 the engine said "nothing that already worked has changed", which is the same sentence it uses when a product is genuinely fine.',
    expect: 'no answer',
    build: (broken) => ({
      'package.json': PKG,
      'cli.js': [
        "import fs from 'node:fs';",
        "fs.mkdirSync('out', { recursive: true });",
        '// A build tool writing hash-named artefacts. Nothing unusual, and every one of them',
        '// is a new address that was not there on the last run.',
        'for (let i = 0; i < 30; i += 1) {',
        "  fs.writeFileSync(`out/chunk-${Math.random().toString(36).slice(2, 10)}.txt`, 'x');",
        '}',
        'console.log(`request ${Math.random().toString(36).slice(2, 10)}`);',
        broken ? "console.log('orders: could not be loaded');" : "console.log('orders: 2');",
        '',
      ].join('\n'),
    }),
  },

  {
    name: 'a crash that only shows in what the program said',
    breaks:
      'The program starts complaining about something fatal, and nothing about WHERE it complained says so. The address is just "stderr"; the finding\'s own sentence carries the first seventy characters of the value and the word is past them. Until 2026-08-30 the words that seal a finding were matched against the addresses and the sentences written about a finding, never against the values themselves — so a crash appearing in the output was filed `ordinary`, which is exactly the class an agent may close on its own without telling anybody.',
    expect: 'a finding',
    mustBeSealed: 'crash',
    build: (broken) => ({
      'package.json': PKG,
      'cli.js': [
        "console.log('report written');",
        broken
          ? "console.error('index: 3 of 4 shards answered within the usual time, and one did not, so the run took longer than normal; fatal: the order index is corrupt');"
          : "console.error('index: 4 of 4 shards answered within the usual time, so the run took about as long as it normally does; all good, the order index is fine');",
        '',
      ].join('\n'),
    }),
  },

  {
    name: 'a charge that moved, where nothing in the address mentions money',
    breaks:
      'What goes out to the payment company changed. The address is a plain stdout line and the word that makes this a money question sits deep inside the value, past everything any sentence about the finding quotes. Same blindness as the crash above, and this is the class the design says goes to a person whatever caused it.',
    expect: 'a finding',
    mustBeSealed: 'money',
    build: (broken) => ({
      'package.json': PKG,
      'cli.js': [
        'const order = { id: 7, lines: 3, note: "the customer asked for it to be sent to the office address instead" };',
        `console.log('sending order ' + JSON.stringify(order) + ' to the till with {"currency":"aed","amount":${broken ? '1200' : '1000'}}');`,
        '',
      ].join('\n'),
    }),
  },

  {
    name: 'a journey nothing could walk is named, not counted as clean',
    breaks:
      'Nothing is wrong with the product, and the only journey anybody wrote cannot be walked at all — its step says to run something and never says what. So the closing sentence is about a fraction of what was asked for, and it used to read exactly like a sentence about all of it: "Nothing that worked has changed", followed by a count of every address the new build produced. A clean answer covering less than it appears to is how a check gets trusted for work it never did.',
    expect: 'nothing',
    summaryMustSay: [/not compared at all/],
    journeys: [
      {
        name: 'run-it',
        describe: 'A journey somebody wrote wrong: it says to run something and never says what.',
        source: 'code',
        surface: 'cli',
        steps: [{ act: 'run', note: 'and nothing to run' }],
      },
    ],
    build: () => ({
      'package.json': PKG,
      'cli.js': "console.log('two orders');\n",
    }),
  },

  {
    name: 'a run that could only compare half of itself says which half',
    breaks:
      'Two journeys, and only one of them can be walked. The break in the walkable one is found — and the closing sentence used to quote every address the new build produced, as though the whole product had been put beside the old one. Half a run reported as a whole one is how a clean-looking answer gets trusted for more than it covers.',
    expect: 'a finding',
    mustSay: [/email/i],
    summaryMustSay: [/not compared at all/],
    journeys: [
      {
        name: 'run-it',
        describe: 'Run the product once and watch everything it does.',
        source: 'code',
        surface: 'cli',
        steps: [{ act: 'run', run: 'node cli.js', note: 'the whole product, start to finish' }],
      },
      {
        name: 'the-other-half',
        describe: 'A second journey nobody finished writing.',
        source: 'code',
        surface: 'cli',
        steps: [{ act: 'run', note: 'and nothing to run' }],
      },
    ],
    build: (broken) => ({
      'package.json': PKG,
      'cli.js': [
        'const person = {',
        '  id: 7,',
        "  name: 'Ada',",
        broken ? null : "  email: 'ada@example.com',",
        "  city: 'London',",
        '};',
        'console.log(JSON.stringify(person));',
        '',
      ]
        .filter((line) => line !== null)
        .join('\n'),
    }),
  },

  {
    name: 'a run whose record could not be saved says so',
    breaks:
      'The disk will not take the captures. The comparison still happens and the break is still found — and until 2026-08-30 the failure to save was swallowed whole, so the run looked identical to one that had saved everything, and the NEXT run found no record and reported the entire product as never having been walked. His disk hit zero bytes on the night this was written.',
    expect: 'a finding',
    mustSay: [/email/i],
    summaryMustSay: [/was NOT saved/i],
    prepare: makeStoreUnwritable,
    build: (broken) => ({
      'package.json': PKG,
      'cli.js': [
        'const person = {',
        '  id: 7,',
        "  name: 'Ada',",
        broken ? null : "  email: 'ada@example.com',",
        "  city: 'London',",
        '};',
        'console.log(JSON.stringify(person));',
        '',
      ]
        .filter((line) => line !== null)
        .join('\n'),
    }),
  },
];

/**
 * Take away the store's permission to be written to, and say honestly when this machine
 * will not let that happen.
 *
 * Running as root ignores the mode, and so do some filesystems, and on Windows it means
 * nothing at all. Any of those and the case is not testable HERE — which is a different
 * answer from passing, and gets its own word in the report.
 *
 * @param {string} dir
 * @param {string} working   The commit the warm-up run compares against - the build this
 *                           corpus case has already recorded as working.
 * @returns {Promise<{ready: boolean, why: string}>}
 */
async function makeStoreUnwritable(dir, working) {
  const builds = path.join(dir, '.staysfixed', 'v2', 'builds');
  await fsp.mkdir(builds, { recursive: true });

  // Proved, not assumed. A chmod that returns without doing anything is exactly the shape
  // that would turn this case into a green light that tests nothing.
  const probe = path.join(builds, 'probe');
  await fsp.mkdir(probe, { recursive: true });
  try {
    await fsp.chmod(probe, 0o555);
    await fsp.writeFile(path.join(probe, 'x.txt'), 'x');
    await fsp.chmod(probe, 0o755);
    await fsp.rm(probe, { recursive: true, force: true });
    return {
      ready: false,
      why: 'this account can write into a folder it has no permission to write into — running as root, or a filesystem that ignores permissions',
    };
  } catch {
    await fsp.chmod(probe, 0o755).catch(() => {});
    await fsp.rm(probe, { recursive: true, force: true }).catch(() => {});
  }

  // One warm-up run, so every folder the real run will write into already exists.
  //
  // The store is not made unwritable wholesale, deliberately. Doing that stops the check
  // before it starts — which is honest behaviour and says so in those words — and this case
  // is about the OTHER failure: the disk giving out part-way, after the product has been
  // walked and compared and there is a real answer to hand back. So the folders where the
  // captures land are made read-only and everything else is left alone.
  const engine = await loadEngine();
  if (!engine.parts.check) return { ready: false, why: 'the difference engine is not in this build' };
  try {
    await engine.parts.check({ cwd: dir, configFile: undefined, against: working, paired: true, journeys: path.join(dir, 'journeys.json'), only: [] });
  } catch (e) {
    return { ready: false, why: `the warm-up run did not work: ${why(e)}` };
  }

  /** @type {string[]} */
  const shut = [];
  for (const build of await fsp.readdir(builds, { withFileTypes: true })) {
    if (!build.isDirectory()) continue;
    const inside = path.join(builds, build.name);
    for (const journey of await fsp.readdir(inside, { withFileTypes: true })) {
      if (!journey.isDirectory()) continue;
      const folder = path.join(inside, journey.name);
      await fsp.chmod(folder, 0o555);
      shut.push(folder);
    }
  }
  if (shut.length === 0) return { ready: false, why: 'the warm-up run stored nothing, so there was nothing to make read-only' };
  return { ready: true, why: '' };
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CaseResult
 * @property {string} name
 * @property {boolean} caught      True when the case behaved: the break was found, or the clean pair stayed silent.
 * @property {string} [why]        Why it did not, in one plain sentence.
 * @property {'caught'|'quiet'|'escaped'|'false alarm'|'could not run'|'could not tell'|'said it could not tell'|'not testable here'} verdict
 */

/**
 * @typedef {object} SelfcheckResult
 * @property {boolean} passed
 * @property {CaseResult[]} cases
 * @property {number} [notTestableHere]  Cases this machine could not be made to perform —
 *                                       not passes, not failures, and named as neither.
 * @property {boolean} ran         False when the engine could not be driven at all.
 * @property {boolean} [certain]   False when at least one case could not be told either way.
 *                                 A run that is not certain is NOT a pass and NOT a failure.
 * @property {string} [why]        Why it could not run.
 * @property {string} [workDir]
 */

/**
 * Build every case, run the engine over each, and report what got through.
 *
 * The shape of the answer is the one `staysfixed check --selfcheck` prints, so
 * the command and this function can never drift apart.
 *
 * @param {{cwd?: string, configFile?: string, only?: string[], keep?: boolean}} [opts]
 * @returns {Promise<SelfcheckResult>}
 */
export async function selfcheck(opts = {}) {
  const engine = await loadEngine();
  const check = engine.parts.check;

  if (!check) {
    return {
      passed: false,
      ran: false,
      cases: [],
      why: 'The difference engine is not in this build, so nothing could be tested. This is NOT a pass. src/v2/check.js has to export check({cwd, configFile, against, paired, journeys, only}).',
    };
  }

  if (!(await haveGit())) {
    return {
      passed: false,
      ran: false,
      cases: [],
      why: 'The corpus needs git: each product is a real repository with a working commit and an uncommitted change on top, because that is the shape an agent actually points this tool at. Install git and run it again. This is NOT a pass.',
    };
  }

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-selfcheck-'));
  const wanted = opts.only?.length ? CASES.filter((c) => opts.only?.some((n) => c.name.toLowerCase().includes(n.toLowerCase()))) : CASES;

  /** @type {CaseResult[]} */
  const cases = [];

  for (const c of wanted) {
    const first = await runOne(check, workDir, c, 1);
    if (first.caught) {
      cases.push(first);
      continue;
    }

    // IT FAILED. Before that becomes an accusation, it has to reproduce.
    //
    // This is the same rule the engine itself lives by, turned on the corpus: a difference
    // that will not happen twice is not a difference. On the night of 2026-08-29 this corpus
    // came back "1 of 9 wrong" while the test suite was running beside it and then passed
    // five times in a row on a quiet machine — and a corpus that can be perturbed by a busy
    // laptop is worth nothing on a busy laptop, because nobody can tell its noise from its
    // signal. The cause was found and removed (see howLongItTook in adapters/contract.js),
    // and this stays anyway, because the next machine-shaped thing to creep in should land
    // as "I could not tell" rather than as a false accusation somebody learns to ignore.
    //
    // A second run that agrees is a real failure and is reported as one. A second run that
    // disagrees is filed as UNTELLABLE, which is not a pass: the exit code is 2, the same
    // one used for "the corpus could not be run at all", because both mean no answer.
    const second = await runOne(check, workDir, c, 2);
    if (!second.caught) {
      cases.push({ ...second, why: `${second.why ?? 'it did not behave'} (it did this twice in a row, so it is real)` });
      continue;
    }
    cases.push({
      name: c.name,
      caught: false,
      verdict: 'could not tell',
      why:
        `it behaved on the second run and not on the first, so this says nothing either way. ` +
        `The first time: ${first.why ?? 'it did not behave'}. ` +
        `This machine's load was ${loadNow()} — something that comes and goes with how busy the machine is is not evidence about the engine. ` +
        `Run it again on a quiet machine before believing either answer.`,
    });
  }

  // Some cases take permissions away to make their point, and a folder nobody may write into
  // is a folder nobody may delete a file out of either. Handing them back first is what stops
  // the corpus leaving its own wreckage in the temp folder — or, as it did the first time this
  // case ran, taking the whole self-check down with an unlink it was not allowed to perform.
  await relax(workDir);
  if (!opts.keep) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});

  const untellable = cases.some((r) => r.verdict === 'could not tell');
  const notTestableHere = cases.filter((r) => r.verdict === 'not testable here').length;
  return {
    passed: cases.length > 0 && cases.every((r) => r.caught),
    ran: true,
    certain: !untellable,
    ...(notTestableHere > 0 ? { notTestableHere } : {}),
    cases,
    ...(opts.keep ? { workDir } : {}),
  };
}

/**
 * Build one case fresh and put the engine through it once.
 *
 * A fresh folder every attempt, deliberately. Re-running inside the same folder would leave
 * the first attempt's stored captures sitting there, and the second attempt would be
 * comparing against those rather than against the build that works.
 *
 * @param {any} check
 * @param {string} workDir
 * @param {Case} c
 * @param {number} attempt
 * @returns {Promise<CaseResult>}
 */
async function runOne(check, workDir, c, attempt) {
  const dir = path.join(workDir, `${safe(c.name)}${attempt > 1 ? `-again-${attempt}` : ''}`);
  /** @type {string} */
  let working;
  try {
    working = await plant(dir, c);
  } catch (e) {
    return { name: c.name, caught: false, verdict: 'could not run', why: `the product could not be built: ${why(e)}` };
  }

  if (c.prepare) {
    /** @type {{ready: boolean, why: string}} */
    let ready;
    try {
      ready = await c.prepare(dir, working);
    } catch (e) {
      return { name: c.name, caught: false, verdict: 'could not run', why: `the machine could not be set up for this one: ${why(e)}` };
    }
    if (!ready.ready) {
      // Not a pass. `caught` is true only so one machine's limits cannot be read as the
      // engine having broken — the count is reported separately and out loud.
      return { name: c.name, caught: true, verdict: 'not testable here', why: ready.why };
    }
  }

  /** @type {any} */
  let result;
  try {
    // Exactly the call an agent makes, with exactly the arguments an agent
    // sends. A corpus that reached past the front door would prove the engine
    // works when driven in a way nobody drives it.
    result = await check({
      cwd: dir,
      configFile: undefined,
      against: working,
      paired: true,
      journeys: path.join(dir, 'journeys.json'),
      only: [],
    });
  } catch (e) {
    return { name: c.name, caught: false, verdict: 'could not run', why: `the engine threw: ${why(e)}` };
  }

  return judge(c, result);
}

/**
 * Give every folder under here its write permission back.
 *
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function relax(dir) {
  /** @type {import('node:fs').Dirent[]} */
  let inside = [];
  try {
    await fsp.chmod(dir, 0o755);
    inside = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of inside) {
    if (entry.isDirectory()) await relax(path.join(dir, entry.name));
  }
}

/** How busy this machine is, in words, so an untellable result can name the likely reason. */
function loadNow() {
  const [one] = os.loadavg();
  const cores = os.cpus().length || 1;
  const per = one / cores;
  const how = per < 0.4 ? 'quiet' : per < 0.9 ? 'busy' : 'very busy';
  return `${one.toFixed(1)} across ${cores} cores, which is ${how}`;
}

/**
 * Did the engine do what this case demands?
 *
 * The two failing verdicts are named differently on purpose. "escaped" is a
 * break that got through; "false alarm" is a clean pair that raised findings.
 * They are equally fatal and they need completely different fixes, so they must
 * never be reported under one word.
 *
 * @param {Case} c
 * @param {any} result
 * @returns {CaseResult}
 */
function judge(c, result) {
  if (result?.verdict === 'blocked') {
    return { name: c.name, caught: false, verdict: 'could not run', why: `the engine was blocked${result.note ? `: ${result.note}` : ''}` };
  }

  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const unstable = Array.isArray(result?.newlyUnstable) ? result.newlyUnstable : [];

  // The third expectation, and the one the other two cannot express: a run that is entitled
  // to no verdict at all. What is demanded here is narrow on purpose — not that it found the
  // break, which it cannot, but that it refused to call the run clean and said why in words a
  // person can read.
  if (c.expect === 'no answer') {
    const said = String(result?.summary ?? '');
    if (result?.ok === false && /no answer|not a pass/i.test(said)) {
      for (const pattern of c.summaryMustSay ?? []) {
        if (pattern.test(said)) continue;
        return {
          name: c.name,
          caught: false,
          verdict: 'escaped',
          why: `it refused to call the run clean, and never said what it owed the reader (${pattern}): ${said.slice(0, 300)}`,
        };
      }
      return { name: c.name, caught: true, verdict: 'said it could not tell' };
    }
    return {
      name: c.name,
      caught: false,
      verdict: 'escaped',
      why:
        result?.ok === false
          ? `it did not pass, but it never said why in a way anybody could read: ${said.slice(0, 200)}`
          : `it reported a clean run over a comparison that had been thrown away: ${said.slice(0, 200)}`,
    };
  }

  if (c.expect === 'nothing') {
    if (findings.length === 0 && unstable.length === 0) {
      const said = String(result?.summary ?? '');
      for (const pattern of c.summaryMustSay ?? []) {
        if (pattern.test(said)) continue;
        return {
          name: c.name,
          caught: false,
          verdict: 'escaped',
          why: `it was rightly silent about the product and never said what it owed the reader (${pattern}). It said: ${said.slice(0, 300)}`,
        };
      }
      return { name: c.name, caught: true, verdict: 'quiet' };
    }
    // `unstable` holds WobbleEntry objects, not strings. Interpolating one printed
    // "[object Object]" and turned the most important line in a failure report — the one
    // saying WHAT went wrong — into nothing at all.
    const named = unstable.map((/** @type {any} */ u) => (typeof u === 'string' ? u : `${u?.path ?? 'an address'} (was ${JSON.stringify(u?.a)}, then ${JSON.stringify(u?.b)})`));
    const what = findings.length
      ? `${findings.length} finding${findings.length === 1 ? '' : 's'}: ${describe(findings[0])}`
      : `${unstable.length} newly unpredictable address${unstable.length === 1 ? '' : 'es'}: ${named.slice(0, 3).join('; ')}`;
    return { name: c.name, caught: false, verdict: 'false alarm', why: `two builds that should have looked the same produced ${what}` };
  }

  // The one case that must NOT arrive as an ordinary finding. A value that stopped
  // sitting still is a loss of determinism, and reporting it as a changed value
  // would let an agent waive it as "the number is meant to be different now".
  if (c.mustBeUnstable) {
    if (unstable.length > 0) return { name: c.name, caught: true, verdict: 'caught' };
    if (findings.length > 0) {
      return {
        name: c.name,
        caught: false,
        verdict: 'escaped',
        why: 'it reported this as an ordinary changed value instead of as a loss of determinism, so an agent could wave it through as intended',
      };
    }
    return { name: c.name, caught: false, verdict: 'escaped', why: 'it reported nothing at all' };
  }

  if (findings.length === 0) return { name: c.name, caught: false, verdict: 'escaped', why: 'it reported nothing at all' };

  const patterns = c.mustSay ?? [];
  const matching = findings.filter((/** @type {any} */ f) => {
    const haystack = describe(f);
    return patterns.every((p) => p.test(haystack));
  });
  if (matching.length === 0) {
    return {
      name: c.name,
      caught: false,
      verdict: 'escaped',
      why: `it reported ${findings.length} thing${findings.length === 1 ? '' : 's'}, none of them this one. The first was: ${describe(findings[0])}`,
    };
  }

  // Reported is not the same as reported to the right person. A crash or a charge filed
  // `ordinary` is a finding an agent may close on its own, so the break reaches nobody —
  // loudly written down and quietly waived is still quiet.
  if (c.mustBeSealed) {
    const sealed = matching.filter((/** @type {any} */ f) => f.class === c.mustBeSealed);
    if (sealed.length === 0) {
      const classes = [...new Set(matching.map((/** @type {any} */ f) => String(f.class ?? 'unlabelled')))];
      return {
        name: c.name,
        caught: false,
        verdict: 'escaped',
        why: `it found this and filed it as ${classes.join(' and ')} rather than "${c.mustBeSealed}", so an agent is allowed to close it without anybody being told. ${describe(matching[0])}`,
      };
    }
  }

  const said = String(result?.summary ?? '');
  for (const pattern of c.summaryMustSay ?? []) {
    if (pattern.test(said)) continue;
    return {
      name: c.name,
      caught: false,
      verdict: 'escaped',
      why: `it found the break, and the paragraph a person actually reads never said what it owed them (${pattern}). It said: ${said.slice(0, 300)}`,
    };
  }

  return { name: c.name, caught: true, verdict: 'caught' };
}

/**
 * Everything one finding says, flattened, so a pattern can be matched against
 * the whole of it rather than against a field name somebody guessed.
 * @param {any} f
 * @returns {string}
 */
function describe(f) {
  if (!f || typeof f !== 'object') return String(f);
  // `title` is the finding's sentence and `reference`/`candidate` are the two values,
  // both straight out of the contract in src/v2/types.js. This used to read `summary`,
  // `was` and `now`, which nothing produces - so every pattern here would have been
  // matched against the word "undefined" and the corpus would have failed for a reason
  // that had nothing to do with the engine.
  const sample = f.sample ? `${f.sample.path} ${JSON.stringify(f.sample.reference)} ${JSON.stringify(f.sample.candidate)}` : '';
  const everyValue = Array.isArray(f.differences)
    ? f.differences.map((/** @type {any} */ d) => `${d.path} ${JSON.stringify(d.reference)} ${JSON.stringify(d.candidate)}`)
    : [];
  return [f.title ?? f.summary, ...(Array.isArray(f.paths) ? f.paths : []), sample, ...everyValue].filter(Boolean).join(' | ');
}

// ---------------------------------------------------------------------------
// Building one product
// ---------------------------------------------------------------------------

/**
 * Write the working product, commit it, then apply the break on top and leave it
 * uncommitted.
 *
 * Uncommitted on purpose: that is the state an agent is in when it calls this
 * tool, and it is the state the ranking needs, because "how far is this from the
 * code you just edited" is answered from the uncommitted diff.
 *
 * @param {string} dir
 * @param {Case} c
 * @returns {Promise<string>} the commit that counts as working
 */
async function plant(dir, c) {
  await fsp.mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'selfcheck@staysfixed.local']);
  await git(dir, ['config', 'user.name', 'Stays Fixed self-check']);

  await writeAll(dir, c.build(false));
  await fsp.writeFile(path.join(dir, 'journeys.json'), JSON.stringify(c.journeys ?? journeysFor(c), null, 2) + '\n');
  await fsp.writeFile(path.join(dir, '.gitignore'), 'out/\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'the build that works']);
  const working = (await git(dir, ['rev-parse', 'HEAD'])).trim();

  await writeAll(dir, c.build(true));
  return working;
}

/**
 * How to walk each fixture.
 *
 * Every one of them is a program you run, deliberately: a corpus that needed a
 * browser, a simulator or a database could not run on a machine that has none of
 * those, and a self-check nobody can run is a self-check nobody runs.
 *
 * @param {Case} c
 * @returns {Record<string, unknown>[]}
 */
function journeysFor(c) {
  return [
    {
      name: 'run-it',
      describe: `Run ${c.name} once and watch everything it does.`,
      source: 'code',
      surface: 'cli',
      steps: [{ act: 'run', run: 'node cli.js', note: 'the whole product, start to finish' }],
    },
  ];
}

/**
 * @param {string} dir
 * @param {Record<string, string>} files
 */
async function writeAll(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, body);
  }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function git(cwd, args) {
  const { stdout } = await run('git', args, { cwd, timeout: 20_000 });
  return stdout;
}

/** @returns {Promise<boolean>} */
async function haveGit() {
  try {
    await run('git', ['--version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} e */
function why(e) {
  return e instanceof Error ? e.message : String(e);
}

/** @param {string} s */
function safe(s) {
  return s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'case';
}

// ---------------------------------------------------------------------------
// Running it on its own
// ---------------------------------------------------------------------------

/**
 * `node src/v2/selfcheck.js`. `staysfixed check --selfcheck` calls `selfcheck`
 * directly and prints it in the CLI's own voice; this exists so the corpus can
 * be run before anybody has wired a command up for it.
 *
 * @param {string[]} [argv]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const keep = argv.includes('--keep');
  /** @type {string[]} */
  const only = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--only' && argv[i + 1]) only.push(argv[i + 1]);
  }

  const result = await selfcheck({ only, keep });

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.passed) return 0;
    if (!result.ran) return 2;
    return result.certain === false && result.cases.every((r) => r.caught || r.verdict === 'could not tell') ? 2 : 1;
  }

  if (!result.ran) {
    process.stderr.write(`Could not run the self-check.\n${result.why ?? ''}\n`);
    return 2;
  }
  const untellable = result.cases.filter((r) => r.verdict === 'could not tell');

  /** @type {string[]} */
  const out = ['Stays Fixed - checking that it can still catch things', ''];
  for (const r of result.cases) {
    const word = r.verdict === 'not testable here' ? 'n/a' : r.caught ? 'ok' : 'FAILED';
    out.push(`${word.padEnd(8)} ${r.name}`);
    if (r.verdict === 'not testable here') out.push(`         not tested on this machine: ${r.why ?? 'no reason recorded'}`);
    else if (!r.caught) out.push(`         ${r.why ?? 'it did not behave, and said nothing useful about why'}`);
  }
  out.push('');
  const na = result.notTestableHere ?? 0;
  const tested = result.cases.length - na;
  if (result.passed) {
    // The count that is claimed is the count that was actually run. Folding a case this
    // machine could not perform into "all of them behaved" would be the corpus telling the
    // same kind of lie it exists to catch.
    out.push(`All ${tested} behaved: every break was caught, and every pair that should have been silent was silent.`);
    if (na > 0) {
      out.push(`${na} more could not be set up on this machine and ${na === 1 ? 'was' : 'were'} not tested at all — see the n/a ${na === 1 ? 'line' : 'lines'} above. That is neither a pass nor a failure.`);
    }
  } else if (untellable.length > 0 && untellable.length === result.cases.filter((r) => !r.caught).length) {
    // Nothing failed twice. Saying "wrong" here would be an accusation the evidence does not
    // support, and saying "fine" would be worse.
    out.push(
      `${untellable.length} of ${result.cases.length} could not be told either way — ${untellable.length === 1 ? 'it' : 'they'} behaved on the second run and not on the first. ` +
        'That is not a pass and not a failure. Run it again on a quiet machine.',
    );
  } else {
    const bad = result.cases.filter((r) => !r.caught && r.verdict !== 'could not tell');
    out.push(`${bad.length} of ${result.cases.length} did not behave, twice in a row each. Until that is fixed, a clean check from this tool does not mean what it says.`);
    if (untellable.length > 0) out.push(`${untellable.length} more could not be told either way.`);
  }
  if (result.workDir) out.push(`The products were left in ${result.workDir}.`);

  process.stdout.write(out.join('\n') + '\n');
  if (result.passed) return 0;
  // "I could not test this" is exit 2 and never exit 0, and it is not exit 1 either: one of
  // those says the engine is broken and the other says nobody knows, and they need different
  // reactions from whoever is reading.
  return result.certain === false && result.cases.every((r) => r.caught || r.verdict === 'could not tell') ? 2 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
