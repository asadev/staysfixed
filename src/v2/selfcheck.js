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
 * @property {'a finding'|'nothing'} expect
 * @property {RegExp[]} [mustSay]
 * @property {boolean} [mustBeUnstable]  It has to land in `newlyUnstable`, not in the findings.
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
];

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CaseResult
 * @property {string} name
 * @property {boolean} caught      True when the case behaved: the break was found, or the clean pair stayed silent.
 * @property {string} [why]        Why it did not, in one plain sentence.
 * @property {'caught'|'quiet'|'escaped'|'false alarm'|'could not run'} verdict
 */

/**
 * @typedef {object} SelfcheckResult
 * @property {boolean} passed
 * @property {CaseResult[]} cases
 * @property {boolean} ran         False when the engine could not be driven at all.
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
    const dir = path.join(workDir, safe(c.name));
    /** @type {string} */
    let working;
    try {
      working = await plant(dir, c);
    } catch (e) {
      cases.push({ name: c.name, caught: false, verdict: 'could not run', why: `the product could not be built: ${why(e)}` });
      continue;
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
      cases.push({ name: c.name, caught: false, verdict: 'could not run', why: `the engine threw: ${why(e)}` });
      continue;
    }

    cases.push(judge(c, result));
  }

  if (!opts.keep) await fsp.rm(workDir, { recursive: true, force: true });

  return {
    passed: cases.length > 0 && cases.every((r) => r.caught),
    ran: true,
    cases,
    ...(opts.keep ? { workDir } : {}),
  };
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

  if (c.expect === 'nothing') {
    if (findings.length === 0 && unstable.length === 0) return { name: c.name, caught: true, verdict: 'quiet' };
    const what = findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'}: ${describe(findings[0])}` : `${unstable.length} newly unpredictable address${unstable.length === 1 ? '' : 'es'}: ${unstable[0]}`;
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
  await fsp.writeFile(path.join(dir, 'journeys.json'), JSON.stringify(journeysFor(c), null, 2) + '\n');
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
    return result.passed ? 0 : result.ran ? 1 : 2;
  }

  if (!result.ran) {
    process.stderr.write(`Could not run the self-check.\n${result.why ?? ''}\n`);
    return 2;
  }

  /** @type {string[]} */
  const out = ['Stays Fixed - checking that it can still catch things', ''];
  for (const r of result.cases) {
    out.push(`${(r.caught ? 'ok' : 'FAILED').padEnd(8)} ${r.name}`);
    if (!r.caught) out.push(`         ${r.why ?? 'it did not behave, and said nothing useful about why'}`);
  }
  out.push('');
  if (result.passed) {
    out.push(`All ${result.cases.length} behaved: every break was caught, and every pair that should have been silent was silent.`);
  } else {
    const bad = result.cases.filter((r) => !r.caught);
    out.push(`${bad.length} of ${result.cases.length} did not behave. Until that is fixed, a clean check from this tool does not mean what it says.`);
  }
  if (result.workDir) out.push(`The products were left in ${result.workDir}.`);

  process.stdout.write(out.join('\n') + '\n');
  return result.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
