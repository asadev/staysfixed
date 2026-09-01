/**
 * The CLI adapter, and the silences it used to hand back as clean runs.
 *
 * Every test in here started as a bug that produced no output at all. That is the shape
 * worth guarding: a tool that says nothing is indistinguishable from a tool that looked and
 * found nothing, and the second one is the only one anybody wants.
 *
 * The big one is the coverage ledger. Every command in a project reported as never walked,
 * on runs that had just walked all of them — because a journey's observations are addressed
 * by the journey's NAME and a command door is addressed by the COMMAND, and nothing joined
 * the two. So "N of N ways into this product have never been walked through" was permanently
 * wrong in the one direction a coverage ledger is never allowed to be wrong in.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  BY_SIZE_ALONE, COULD_NOT_READ, apiSurface, commandDoorName, compareTrees, describeRun,
  importProbeCommand, processAdapter, readWatcher, runCommand, snapshotSkip, snapshotTree,
} from '../../src/v2/adapters/process.js';
import { trimForStorage } from '../../src/v2/adapters/contract.js';
import { doorFact, walkFromCapture, whatTheWalkDid } from '../../src/v2/coverage.js';
import { scratchDir, cleanUp } from '../support.mjs';

test.after(cleanUp);

/**
 * The observations this adapter really writes for a journey, by name.
 * @param {string} name
 * @returns {string[]}
 */
const pathsFor = (name) => ['stdout', 'stderr', 'exit', 'ran at all'].map((leaf) => `cli.${name}.${leaf}`);

/**
 * A journey shaped the way the engine wants one, for calls that only care about its name.
 * @param {string} name
 * @param {string} describe
 * @returns {import('../../src/v2/adapters/contract.js').Journey}
 */
const aJourney = (name, describe) => ({ name, describe, source: 'code', surface: 'cli' });

/**
 * The bits of an observation the tests assert on, without arguing about optional fields.
 * @param {import('../../src/v2/types.js').Observation[]} said
 * @param {string} at
 * @returns {{refused: boolean, says: string, value: unknown}}
 */
function readBack(said, at) {
  const one = said.find((o) => o.path === at);
  assert.ok(one, `nothing was said at ${at}`);
  return { refused: one.meta?.refused === true, says: String(one.meta?.describe ?? ''), value: one.value };
}

/** Everything `describeRun` needs beyond the part a test actually cares about. */
const nothingWatched = { inForce: true, ran: new Map(), reachedOut: [], settingsRead: [], torn: 0 };

/**
 * Ask the ledger what one journey did with one door, going through the real journey builder
 * rather than a hand-written step — the join being tested is the one between those two.
 *
 * @param {{kind: 'command'|'export', name: string, file?: string}} door
 * @param {Record<string, unknown>} config
 * @param {string} journeyName
 * @param {string[]} [paths]
 */
async function askTheLedger(door, config, journeyName, paths) {
  const journeys = await processAdapter.journeys({ root: '/nowhere', config });
  const journey = journeys.find((j) => j.name === journeyName);
  assert.ok(journey, `no journey called ${journeyName}`);
  const capture = /** @type {any} */ ({
    journey: journey.name,
    startedAt: '2026-08-30T00:00:00.000Z',
    observations: (paths ?? pathsFor(journey.name)).map((p) => ({ channel: 'results', path: p, value: 1 })),
  });
  const walk = walkFromCapture(capture, journey);
  return whatTheWalkDid(
    doorFact({ ...door, detail: '', file: door.file ?? 'package.json', line: 1, inTest: false, named: true, via: 'package.json' }),
    walk,
    new Set(walk.paths),
  );
}

describe('every command door reading as never walked', () => {
  test('a journey named by a person still opens the command it runs', async () => {
    const did = await askTheLedger(
      { kind: 'command', name: 'npm run build' },
      { commands: [{ name: 'build the app', run: 'npm run build' }] },
      'build the app',
    );
    assert.ok(did, 'the door stayed shut, which is what the bug looked like');
    assert.equal(did.state, 'opened');
  });

  test('a journey named after the command opens it too — the name was never the join', async () => {
    const did = await askTheLedger(
      { kind: 'command', name: 'npm run build' },
      { commands: [{ run: 'npm run build' }] },
      'npm run build',
    );
    assert.equal(did?.state, 'opened');
  });

  test('a command the project installs is opened by a journey that runs it with arguments', async () => {
    const did = await askTheLedger(
      { kind: 'command', name: 'staysfixed' },
      { commands: [{ name: 'the self-check', run: 'staysfixed check --selfcheck' }] },
      'the self-check',
    );
    assert.equal(did?.state, 'opened');
  });

  test('it opens only the door it ran, never the one next to it', async () => {
    const did = await askTheLedger(
      { kind: 'command', name: 'npm run build' },
      { commands: [{ name: 'the self-check', run: 'staysfixed check --selfcheck' }] },
      'the self-check',
    );
    assert.equal(did, null);
  });

  test('a command line nobody can read plainly opens nothing rather than the wrong thing', () => {
    assert.equal(commandDoorName('npm run build && npm test'), null);
    assert.equal(commandDoorName('node bin/cli.js'), null);
    assert.equal(commandDoorName('sh -c "npm run build"'), null);
    assert.equal(commandDoorName(''), null);
  });

  test('the package manager in front of a script is not a second door', () => {
    assert.equal(commandDoorName('npm run build'), 'npm run build');
    assert.equal(commandDoorName('pnpm run build'), 'npm run build');
    assert.equal(commandDoorName('yarn run build'), 'npm run build');
    assert.equal(commandDoorName('npm test'), 'npm run test');
    assert.equal(commandDoorName('FOO=1 npx --yes staysfixed check'), 'staysfixed');
  });

  test('a project can name the door itself when the command line is too odd to read', async () => {
    const did = await askTheLedger(
      { kind: 'command', name: 'staysfixed' },
      { commands: [{ name: 'through a wrapper', run: 'sh -c ./run.sh', door: 'staysfixed' }] },
      'through a wrapper',
    );
    assert.equal(did?.state, 'opened');
  });

  test('an import journey still opens its exports through their own addresses', async () => {
    const did = await askTheLedger(
      { kind: 'export', name: 'check', file: 'src/index.js' },
      { imports: [{ name: 'the public entry', module: './src/index.js' }] },
      'the public entry',
      ['export.the public entry.check', 'count.the public entry.exports'],
    );
    assert.equal(did?.state, 'opened');
  });
});

describe('a file too big to read in one go', () => {
  test('a different big file is a difference, not a matching size bucket', async () => {
    const root = await scratchDir('staysfixed-big');
    const file = path.join(root, 'bundle.js');
    const size = 12 * 1024 * 1024;

    await fsp.writeFile(file, Buffer.alloc(size, 0x41));
    const before = await snapshotTree(root);
    await fsp.writeFile(file, Buffer.alloc(size, 0x42));
    const after = await snapshotTree(root);

    assert.notEqual(before.get('bundle.js'), after.get('bundle.js'));
    assert.deepEqual(compareTrees(before, after).map((c) => [c.file, c.what]), [['bundle.js', 'changed']]);
  });

  test('the same big file rewritten byte for byte is still not a change', async () => {
    const root = await scratchDir('staysfixed-big');
    const file = path.join(root, 'bundle.js');
    await fsp.writeFile(file, Buffer.alloc(9 * 1024 * 1024, 0x41));
    const before = await snapshotTree(root);
    await fsp.writeFile(file, Buffer.alloc(9 * 1024 * 1024, 0x41));
    const after = await snapshotTree(root);
    assert.deepEqual(compareTrees(before, after), []);
  });

  test('past the ceiling it says so, as a hole rather than as a match', async () => {
    const root = await scratchDir('staysfixed-huge');
    await fsp.writeFile(path.join(root, 'huge.bin'), Buffer.alloc(200_000, 0x41));
    const after = await snapshotTree(root, { maxBytes: 1000, ceilingBytes: 2000 });
    assert.ok(String(after.get('huge.bin')).startsWith(BY_SIZE_ALONE));

    const said = await describeRun({
      journey: aJourney('build', 'build the app'),
      result: { stdout: '', stderr: '', code: 0, signal: null, timedOut: false, ms: 1 },
      before: new Map(), after,
      watched: nothingWatched,
      ctx: /** @type {any} */ ({ clock: '2026-01-01T00:00:00Z', seed: 1, evidenceDir: root, scratchDir: root }),
      footprint: { dirs: [] },
    });
    const hole = readBack(said, 'file.build.compared by size alone');
    assert.equal(hole.refused, true, 'a file compared by size alone has to be a hole');
    assert.match(hole.says, /huge\.bin/);
  });
});

describe('a place that could not be read', () => {
  test('a folder that will not open is recorded, not dropped along with everything under it', async (t) => {
    if (process.getuid?.() === 0) return t.skip('root can read anything, so there is nothing to test here');
    const root = await scratchDir('staysfixed-unread');
    await fsp.mkdir(path.join(root, 'out'));
    await fsp.writeFile(path.join(root, 'out', 'app.js'), 'one');
    await fsp.chmod(path.join(root, 'out'), 0o000);
    let after;
    try {
      after = await snapshotTree(root);
    } finally {
      await fsp.chmod(path.join(root, 'out'), 0o755);
    }
    assert.equal(after.get('out'), `${COULD_NOT_READ}no permission to read it`);

    const said = await describeRun({
      journey: aJourney('build', 'build the app'),
      result: { stdout: '', stderr: '', code: 0, signal: null, timedOut: false, ms: 1 },
      before: new Map(), after,
      watched: nothingWatched,
      ctx: /** @type {any} */ ({ clock: '2026-01-01T00:00:00Z', seed: 1, evidenceDir: root, scratchDir: root }),
      footprint: { dirs: [] },
    });
    assert.equal(readBack(said, 'file.build.could not be looked at').refused, true, 'an unreadable folder has to be named');
  });

  test('a file that vanished between the listing and the read is not reported as unreadable', async () => {
    const root = await scratchDir('staysfixed-gone');
    await fsp.writeFile(path.join(root, 'kept.txt'), 'here');
    const seen = await snapshotTree(root);
    assert.equal([...seen.values()].filter((v) => v.startsWith(COULD_NOT_READ)).length, 0);
  });
});

describe('the folders a run does not watch', () => {
  test('node_modules is left out, and every run says so', async () => {
    const root = await scratchDir('staysfixed-skip');
    const said = await describeRun({
      journey: aJourney('build', 'build the app'),
      result: { stdout: '', stderr: '', code: 0, signal: null, timedOut: false, ms: 1 },
      before: new Map(), after: new Map(),
      watched: nothingWatched,
      ctx: /** @type {any} */ ({ clock: '2026-01-01T00:00:00Z', seed: 1, evidenceDir: root, scratchDir: root }),
      footprint: { dirs: [] },
      skipped: [...snapshotSkip(undefined)].sort(),
    });
    const named = readBack(said, 'file.build.folders left unwatched');
    assert.equal(named.refused, true, 'a folder nobody watched has to be named in the run that did not watch it');
    assert.match(named.says, /node_modules/);
  });

  test('a project that needs node_modules watched can take it off the list', () => {
    assert.ok(snapshotSkip(undefined).has('node_modules'));
    assert.equal(snapshotSkip({ alsoWatch: ['node_modules'] }).has('node_modules'), false);
    assert.ok(snapshotSkip({ alsoWatch: ['node_modules'] }).has('.git'), 'the rest of the list stays');
  });

  test('a file written into node_modules is seen once the project asks for it', async () => {
    const root = await scratchDir('staysfixed-nm');
    await fsp.mkdir(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
    const patched = path.join(root, 'node_modules', 'left-pad', 'index.js');
    await fsp.writeFile(patched, 'before');
    const skip = snapshotSkip({ alsoWatch: ['node_modules'] });
    const before = await snapshotTree(root, { skip });
    await fsp.writeFile(patched, 'after the patch');
    const after = await snapshotTree(root, { skip });
    assert.deepEqual(compareTrees(before, after).map((c) => c.file), [path.join('node_modules', 'left-pad', 'index.js')]);
  });
});

describe('the rest of the silences', () => {
  test('a command that never started says so instead of reporting an exit code of nothing', async () => {
    const result = await runCommand('this-command-does-not-exist-anywhere', {
      cwd: process.cwd(), env: /** @type {any} */ ({ PATH: '' }), timeoutMs: 20000,
    });
    // Through a shell this comes back as 127; without one it never starts at all. Either way
    // the run must not look clean.
    if (result.couldNotStart) {
      const said = await describeRun({
        journey: aJourney('go', 'run the thing'),
        result,
        before: new Map(), after: new Map(),
        watched: { ...nothingWatched, inForce: false },
        ctx: /** @type {any} */ ({ clock: '2026-01-01T00:00:00Z', seed: 1, evidenceDir: await scratchDir('e'), scratchDir: '.' }),
        footprint: { dirs: [] },
      });
      assert.equal(readBack(said, 'cli.go.ran at all').refused, true);
    } else {
      assert.notEqual(result.code, 0, 'a command that is not there must not look like a clean run');
    }
  });

  test('a half-written line in the watcher report is counted, not dropped', async () => {
    const root = await scratchDir('staysfixed-torn');
    const file = path.join(root, 'watch.jsonl');
    await fsp.writeFile(file, [
      JSON.stringify({ kind: 'ran', what: { command: 'git' } }),
      '{"kind":"reached ou',
      '',
    ].join('\n'));
    const seen = await readWatcher(file);
    assert.equal(seen.torn, 1);
    assert.equal(seen.ran.get('git'), 1);

    const said = await describeRun({
      journey: aJourney('go', 'run the thing'),
      result: { stdout: '', stderr: '', code: 0, signal: null, timedOut: false, ms: 1 },
      before: new Map(), after: new Map(),
      watched: seen,
      ctx: /** @type {any} */ ({ clock: '2026-01-01T00:00:00Z', seed: 1, evidenceDir: root, scratchDir: root }),
      footprint: { dirs: [] },
    });
    assert.equal(readBack(said, 'proc.go.events that could not be read back').refused, true);
  });

  test('a module that prints something on the way in still reports what it exports', async () => {
    const dir = await scratchDir('staysfixed-import');
    await fsp.writeFile(
      path.join(dir, 'mod.js'),
      'console.log("[dotenv] injected 3 vars");\nexport const check = (a) => a;\n',
    );
    const result = await runCommand(importProbeCommand('./mod.js'), {
      cwd: dir, env: /** @type {any} */ (process.env), timeoutMs: 60000,
    });
    const said = apiSurface(aJourney('the entry', 'import it'), result);
    assert.equal(
      readBack(said, 'export.the entry.check').value, 'a function taking 1 argument',
      'a banner on stdout used to hide the whole exported surface',
    );
  });

  test('a module that really cannot be imported is still reported as a hole', async () => {
    const dir = await scratchDir('staysfixed-import');
    await fsp.writeFile(path.join(dir, 'bad.js'), 'throw new Error("no");\n');
    const result = await runCommand(importProbeCommand('./bad.js'), {
      cwd: dir, env: /** @type {any} */ (process.env), timeoutMs: 60000,
    });
    const said = apiSurface(aJourney('the entry', 'import it'), result);
    assert.equal(said.length, 1);
    assert.equal(readBack(said, 'export.the entry.readable at all').refused, true);
  });

  test('a journey with more steps than this adapter walks names the ones it left', async () => {
    const journeys = await processAdapter.journeys({
      root: '/nowhere', config: { commands: [{ name: 'two things', run: 'echo one' }] },
    });
    const journey = { ...journeys[0], steps: [...(journeys[0].steps ?? []), { act: 'run', run: 'echo two' }] };
    const scratch = await scratchDir('staysfixed-steps');
    await fsp.writeFile(path.join(scratch, 'package.json'), '{"name":"tiny"}');
    const prepared = await processAdapter.prepare(
      { id: 'abc123abc123', label: 'the build', role: 'candidate', root: scratch },
      /** @type {any} */ ({ scratchDir: await scratchDir('staysfixed-run'), evidenceDir: await scratchDir('staysfixed-ev'), seed: 1, clock: '2026-01-01T00:00:00Z' }),
    );
    const said = await processAdapter.run(journey, prepared, /** @type {any} */ ({
      scratchDir: prepared.root, evidenceDir: await scratchDir('staysfixed-ev'), seed: 1, clock: '2026-01-01T00:00:00Z',
    }));
    await prepared.dispose();
    const hole = readBack(said, 'cli.two things.the rest of its steps');
    assert.equal(hole.refused, true, 'a step nobody walked has to be named');
    assert.match(hole.says, /echo two/);
  });
});

describe('keeping a big piece of text', () => {
  test('the cut is made in bytes, so text that is not plain ASCII is not stored twice', () => {
    const text = '─'.repeat(30000);                     // 90,000 bytes, 30,000 characters
    const kept = trimForStorage(text);
    assert.equal(kept.truncated, true);
    assert.ok(
      Buffer.byteLength(kept.text, 'utf8') < Buffer.byteLength(text, 'utf8'),
      'the whole text used to come back twice, over the limit, under a marker claiming bytes had been dropped',
    );
    assert.equal(kept.text.includes('�'), false, 'a character cut in half would move about between runs');
  });

  test('the number of bytes it says it left out is the number it left out', () => {
    for (const text of ['x'.repeat(90_000), '─'.repeat(30_000), '😀'.repeat(20_000)]) {
      const kept = trimForStorage(text);
      const [, claimed] = kept.text.match(/exactly (\d+) bytes left out/) ?? [];
      const [head, tail] = kept.text.split(/\n\.\.\..*\.\.\.\n/);
      assert.equal(
        Number(claimed),
        kept.bytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8'),
      );
    }
  });

  test('text that fits is handed back untouched', () => {
    assert.deepEqual(trimForStorage('short'), { text: 'short', truncated: false, bytes: 5 });
  });
});

describe('importing the package entry a project actually has', () => {
  test('a bare file name is a file, not a package nobody has', async () => {
    // The rule was "starts with a dot, or has a slash in it, otherwise it is a package".
    // `index.js` has neither — so Node was asked for a PACKAGE called "index.js" and answered
    // ERR_MODULE_NOT_FOUND. `staysfixed init` writes exactly `{ module: "index.js" }` for an
    // ordinary package entry, so on those projects this journey failed on EVERY run, failed
    // the same way on both builds, produced no difference at all, and the check said
    // "Nothing that worked has changed" for ever while checking nothing. Measured 2026-08-30.
    const dir = await scratchDir('staysfixed-import');
    await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', type: 'module' }));
    await fsp.writeFile(path.join(dir, 'index.js'), 'export const add = (a, b) => a + b\nexport const title = "x"\n');

    const ran = await runCommand(importProbeCommand('index.js'), { cwd: dir, env: /** @type {any} */ (process.env), timeoutMs: 60000 });
    assert.equal(ran.code, 0, `the entry could not be imported at all: ${ran.stderr}`);
    assert.doesNotMatch(String(ran.stderr), /ERR_MODULE_NOT_FOUND/);
    assert.match(ran.stdout, /add/, 'and what it exports has to come back');
    assert.match(ran.stdout, /title/);
  });

  test('a real package name is still treated as a package', async () => {
    // The fix must not turn every bare word into a path: `{ module: "node:path" }` and an
    // installed dependency both still have to resolve the way they always did.
    const dir = await scratchDir('staysfixed-import-pkg');
    await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'y', type: 'module' }));
    const ran = await runCommand(importProbeCommand('node:path'), { cwd: dir, env: /** @type {any} */ (process.env), timeoutMs: 60000 });
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /join/, 'node:path exports join, so the package route still works');
  });
});

describe('what the product said for itself, kept instead of thrown away', () => {
  /**
   * Everything `describeRun` writes for one command, as { path: sentence }.
   *
   * @param {{stdout?: string, stderr?: string, code?: number|null, couldNotStart?: string}} result
   */
  const sentencesFor = async (result) => {
    const out = await describeRun({
      journey: /** @type {any} */ ({ name: 'help', describe: 'ask it to print its help' }),
      result: /** @type {any} */ ({
        stdout: '', stderr: '', code: 1, signal: null, timedOut: false, ms: 5, ...result,
      }),
      before: new Map(),
      after: new Map(),
      watched: /** @type {any} */ ({ inForce: false, ran: new Map(), reachedOut: [], torn: 0, settingsRead: [] }),
      ctx: /** @type {any} */ ({ evidenceDir: await scratchDir('staysfixed-said-evidence') }),
      footprint: { dirs: [] },
    });
    return out;
  };

  // Measured 2026-08-31 on three deliberately broken products. All three were correctly
  // refused — the tool never claimed they were fine — and a grep of the whole reply, with
  // --verbose on, found none of these three words anywhere in it. The owner was told "the
  // thing being observed fell over before it could be read", six times over, and had to go
  // and find the reason themselves.
  for (const [what, stderr, wanted] of /** @type {[string, string, RegExp][]} */ ([
    [
      'a JavaScript syntax error',
      'file:///p/server.js:18\n\n\nSyntaxError: Unexpected end of input\n    at compileSourceTextModule (node:internal/modules/esm/utils:355:16)\n\nNode.js v26.5.1\n',
      /SyntaxError: Unexpected end of input/,
    ],
    [
      'a Python module that is not installed',
      'Traceback (most recent call last):\n  File "/p/cli.py", line 4, in <module>\n    import tabulate\n    ^^^^^^^^^^^^^^^\nModuleNotFoundError: No module named \'tabulate\'\n',
      /ModuleNotFoundError: No module named 'tabulate'/,
    ],
    [
      'a Node package that is not installed',
      "node:internal/modules/package_json_reader:301\n  throw new ERR_MODULE_NOT_FOUND(x);\n        ^\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'chalk' imported from /p/cli.js\n    at Object.getPackageJSONURL (node:x:301:9) {\n  code: 'ERR_MODULE_NOT_FOUND'\n}\n\nNode.js v26.5.1\n",
      /ERR_MODULE_NOT_FOUND/,
    ],
  ])) {
    test(`${what} is named in the reply, not just "it fell over"`, async () => {
      const out = await sentencesFor({ stderr, code: 1 });
      const crash = out.find((o) => o.path === 'cli.help.ran at all');
      assert.ok(crash, 'a command that printed nothing and died must still say it never reached the product');
      assert.match(String(crash.meta?.describe), wanted, 'the product printed the reason; the reply has to carry it');
      // And it has to survive being trimmed. `staysfixed coverage` prints this sentence with a
      // 160 character budget, so a reason parked at the end of a long sentence is a reason
      // nobody ever reads.
      assert.match(String(crash.meta?.describe).slice(0, 160), wanted, 'it has to be inside the first 160 characters');
      assert.match(String(crash.meta?.refusedWhy), wanted, 'and the refusal reason carries the fuller quote');
    });
  }

  test('the reason goes in the sentence and never in the value, so two crashes are not a difference', async () => {
    const one = await sentencesFor({ stderr: 'SyntaxError: Unexpected end of input\n', code: 1 });
    const two = await sentencesFor({ stderr: "ModuleNotFoundError: No module named 'tabulate'\n", code: 1 });
    const valueOf = (/** @type {any[]} */ o) => o.find((x) => x.path === 'cli.help.ran at all')?.value;
    // Two builds that fall over for two different reasons must not report a difference AT THIS
    // ADDRESS. What went wrong is a fact about the crash; the run says so in words, and the
    // comparison stays out of it.
    assert.deepEqual(valueOf(one), valueOf(two), 'the compared value has to be the same fixed sentence either way');
  });

  test('a command that printed something is still a real observation and is not touched', async () => {
    const out = await sentencesFor({ stdout: 'usage: thing [options]\n', stderr: 'warning: old flag\n', code: 1 });
    assert.equal(out.find((o) => o.path === 'cli.help.ran at all'), undefined,
      'a linter that exits 1 with a list of problems reached the product, and must go on being compared');
  });

  test('a module that will not import says why, instead of pointing at another channel', () => {
    const out = apiSurface(
      /** @type {any} */ ({ name: 'the entry', describe: 'import the package entry' }),
      /** @type {any} */ ({ stdout: '', stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'chalk'\n    at x\n" }),
    );
    assert.match(String(out[0].meta?.describe), /ERR_MODULE_NOT_FOUND/);
  });
});

describe('the command line is quoted the way this machine reads quotes', () => {
  test('the import probe carries no newline, because cmd.exe cannot pass one', () => {
    // Measured on a real Windows 11 machine on 2026-08-31: the probe is many lines long, the
    // first newline ended the command, and what ran was a fragment. The run then reported the
    // product broken when nothing had been run at all.
    const line = importProbeCommand('./index.js');
    assert.doesNotMatch(line, /\n/, 'a command line with a newline in it is truncated by cmd.exe');
  });

  test('the probe still works when it is carried, which is the whole point of carrying it', async () => {
    const dir = await scratchDir('staysfixed-probe-carried');
    await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', type: 'module' }));
    await fsp.writeFile(path.join(dir, 'index.js'), 'export const add = (a, b) => a + b\n');
    const ran = await runCommand(importProbeCommand('index.js'), { cwd: dir, env: /** @type {any} */ (process.env), timeoutMs: 60000 });
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /add/);
  });
});
