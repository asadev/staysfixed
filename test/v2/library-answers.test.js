/**
 * A LIBRARY WHOSE FUNCTIONS ANSWER DIFFERENTLY MUST NOT PASS.
 *
 * This file exists because of one measured run on 2026-08-31. A four-line library —
 * `slug(text)` and `isReserved(word)` — was set up with this tool, checked, and shipped. Then
 * the separator inside `slug` was changed from "-" to "_" and one word was dropped from the
 * reserved list, so EVERY web address the library produces became a different string and
 * `isReserved('admin')` went from true to false. `staysfixed check` answered:
 *
 *     ok Nothing that worked has changed. 13 addresses checked against the stored record.
 *
 * and exited 0. Every channel in the tool had compared the NAMES and SHAPES of the exports,
 * and not one of them had ever called a function, while `init`, `doctor` and `coverage` all
 * told the owner that libraries were covered "in full".
 *
 * The tests below are the two halves of the fix, and neither is optional:
 *
 *   1. THE DEFAULT RUN CAN SEE IT. The exact reproduction above must come back as a failure,
 *      with a finding that names the function, the input and both answers — and an unchanged
 *      library must stay silent, because trading a false all-clear for a false alarm is not a
 *      fix.
 *   2. NOTHING CLAIMS MORE THAN IT COMPARED. An exported name that was read but never called
 *      is not an opened door, and the ledger has to say so in words, on a project that has no
 *      test suite as much as on one that has.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { buildLedger, doorFact, placeholdersIn, walkFromCapture, whatTheWalkDid } from '../../src/v2/coverage.js';
import {
  ANSWERS_END,
  ANSWERS_START,
  isAnAnswerJourney,
  journeysFromExports,
  splitAnswerSheet,
  whyItWouldNotBeCalled,
} from '../../src/v2/journeys/from-exports.js';
import { scratchDir, cleanUp, cliPath } from '../support.mjs';

const exec = promisify(execFile);

/** init, a check, a ship, a git export and two more walks. Slow, and worth every second. */
const REPRODUCTION_MS = 180_000;

/** The library exactly as it was when the false all-clear was measured. */
const GOOD = `const RESERVED = ['admin', 'api', 'login'];
export function slug(text) {
  const clean = String(text).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return RESERVED.includes(clean) ? \`\${clean}-1\` : clean;
}
export function isReserved(word) { return RESERVED.includes(String(word).toLowerCase()); }
`;

/**
 * The same library after the change that used to pass: a different separator, one word gone.
 *
 * Written out in full rather than derived from GOOD by a substitution. A substitution that
 * stopped matching would leave the two identical, the check would correctly pass, and the
 * test guarding against a false all-clear would fail with a message about an exit code — the
 * one shape of test failure nobody diagnoses correctly at eleven at night.
 */
const BROKEN = `const RESERVED = ['api', 'login'];
export function slug(text) {
  const clean = String(text).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return RESERVED.includes(clean) ? \`\${clean}-1\` : clean;
}
export function isReserved(word) { return RESERVED.includes(String(word).toLowerCase()); }
`;

/**
 * A git repository holding the library, set up with this tool and shipped once.
 *
 * Shipped, and not merely checked, because the reproduction is about a project somebody was
 * happy with: the whole failure was that the record of "working" had nothing in it about what
 * the functions answer.
 *
 * @param {string} source   The contents of index.js.
 * @returns {Promise<string>} The folder.
 */
async function aLibraryThatShipped(source) {
  const dir = await scratchDir('library-answers');
  await fsp.writeFile(path.join(dir, 'package.json'), '{"name":"slugly","version":"1.0.0","type":"module","main":"index.js"}\n');
  await fsp.writeFile(path.join(dir, 'index.js'), source);
  const git = (/** @type {string[]} */ args) => exec('git', args, { cwd: dir });
  await git(['init', '-q', '.']);
  await git(['add', '-A']);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one']);
  await run(dir, ['init']);
  await git(['add', '-A']);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'settings']);
  await run(dir, ['check']);
  await run(dir, ['ship']);
  return dir;
}

/**
 * The real command-line tool, run the way somebody would run it.
 *
 * Never `check()` called in-process for the reproduction tests: the defect being guarded
 * against was an EXIT CODE of 0 on a broken library, and an exit code is a thing only the
 * program itself produces.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{code: number, out: string}>}
 */
async function run(cwd, args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cliPath, ...args], { cwd, maxBuffer: 40 * 1024 * 1024 });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { code: typeof err.code === 'number' ? err.code : 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** @param {string} dir @param {string} source */
async function rewrite(dir, source) {
  await fsp.writeFile(path.join(dir, 'index.js'), source);
  await exec('git', ['add', '-A'], { cwd: dir });
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'changed'], { cwd: dir });
}

after(async () => {
  await cleanUp();
});

// ---------------------------------------------------------------------------
// The reproduction
// ---------------------------------------------------------------------------

describe('a library whose answers changed', () => {
  test('fails the check, and names the function and both answers', { timeout: REPRODUCTION_MS }, async () => {
    const dir = await aLibraryThatShipped(GOOD);
    await rewrite(dir, BROKEN);

    const { code, out } = await run(dir, ['check']);

    assert.notEqual(code, 0, `a library where every address it makes came out different exited ${code}. This is the defect: ${out.slice(0, 2000)}`);
    assert.equal(/Nothing that worked has changed/.test(out), false, 'it said nothing changed about a product whose every answer changed');
    // Not merely "something differs" — the finding has to be one a person who does not read
    // code can act on, which means the function, the input, and both answers in one sentence.
    assert.match(out, /slug\("Hello World"\)/, 'the finding has to name the call, not a byte range in a wall of text');
    assert.match(out, /hello-world/, 'and what it used to answer');
    assert.match(out, /hello_world/, 'and what it answers now');
    assert.match(out, /isReserved\("admin"\)/, 'the dropped reserved word is a second, separate break and has to arrive as one');
  });

  test('a library that really has not changed stays silent, three runs in a row', { timeout: REPRODUCTION_MS }, async () => {
    // The other half of the promise. A tool that fails on everything is as useless as one
    // that passes on everything, and the calls this feature makes run a stranger's code —
    // which is exactly the sort of thing that answers differently on the second go.
    const dir = await aLibraryThatShipped(GOOD);
    await fsp.writeFile(path.join(dir, 'README.md'), '# slugly\n');
    await fsp.appendFile(path.join(dir, 'index.js'), '\n// a comment, and nothing else\n');
    await exec('git', ['add', '-A'], { cwd: dir });
    await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'a comment'], { cwd: dir });

    for (const attempt of [1, 2, 3]) {
      const { code, out } = await run(dir, ['check']);
      assert.equal(code, 0, `run ${attempt} invented a difference nobody caused: ${out.slice(0, 2000)}`);
      assert.match(out, /Nothing that worked has changed/, `run ${attempt} should have been clean`);
    }
  });
});

// ---------------------------------------------------------------------------
// What is never called
// ---------------------------------------------------------------------------

describe('calling a stranger\'s code stops where the tool always stops', () => {
  test('a function whose name says it does something irreversible is refused, with the reason', () => {
    for (const name of ['deleteAccount', 'sendInvite', 'chargeCard', 'publishRelease', 'wipeAll', 'migrateSchema']) {
      const why = whyItWouldNotBeCalled(name);
      assert.notEqual(why, '', `${name} would have been called for real`);
      assert.match(why, /never calls/, 'and the refusal has to say what it is, in words, because it is reported to the owner as a hole');
    }
  });

  test('an ordinary function is not refused, or the feature covers nothing', () => {
    // The guess is deliberately generous and generous is not the same as useless. These are
    // the names real libraries use, and a rule that caught them would leave the feature
    // refusing everything and reporting a hole where it should be reporting an answer.
    for (const name of ['slug', 'isReserved', 'format', 'parse', 'render', 'compare', 'toString']) {
      assert.equal(whyItWouldNotBeCalled(name), '', `${name} was refused and should not have been`);
    }
  });

  test('word by word, so undelete does not read as delete', () => {
    assert.equal(whyItWouldNotBeCalled('resendable'), '', 'substring matching would catch this and it is not a send');
  });
});

// ---------------------------------------------------------------------------
// One address per call
// ---------------------------------------------------------------------------

describe('the answer sheet is taken apart before anything compares it', () => {
  const journey = { name: 'what the package entry answers', describe: 'call everything index.js exports', surface: 'library' };
  const sheet = [
    ANSWERS_START,
    'module: index.js',
    'slug("Hello World") -> "hello-world"',
    'isReserved("admin") -> true',
    ANSWERS_END,
    'called: isReserved, slug',
    'not called: deleteAll (irreversible) — its name contains "delete", so it sounds like it destroys data.',
  ].join('\n');

  /** @param {string} printed */
  const walked = (printed) =>
    splitAnswerSheet(
      [{ path: 'cli.what the package entry answers.stdout', channel: 'results', value: printed, meta: { describe: 'what it printed' } }],
      /** @type {any} */ (journey),
    );

  test('every call gets the exported name\'s own address, so the coverage ledger can join them', () => {
    const out = walked(sheet);
    const paths = out.map((o) => o.path);
    assert.ok(paths.some((p) => p.startsWith('export.index%2Ejs.slug.')), `no address for slug: ${paths.join(' | ')}`);
    assert.ok(paths.some((p) => p.startsWith('export.index%2Ejs.isReserved.')), `no address for isReserved: ${paths.join(' | ')}`);
  });

  test('the last part of the address is the whole call, because that is what the report prints', () => {
    const out = walked(sheet);
    const call = out.find((o) => String(o.path).includes('slug.slug('));
    assert.ok(call, 'the headline would otherwise read \'"("Hello World")" is now …\' with no function in it');
    assert.equal(call?.value, '"hello-world"');
  });

  test('a function that was refused is written down as a hole at its own address, never as a pass', () => {
    const out = walked(sheet);
    const refused = out.find((o) => o.path === 'export.index%2Ejs.deleteAll');
    assert.ok(refused, 'a refused function vanished instead of being reported');
    assert.equal(refused?.meta?.refused, true, 'a refusal that is not marked as one is counted as coverage');
    // The KIND matters as much as the fact. "the project asked us not to" is what a plain
    // refusal reads as, and nobody asked: this tool decided, because the name said the call
    // would destroy data. The owner has to be shown the reason that is true.
    assert.match(String(refused?.meta?.refusedWhy), /destroy data/, `the wrong reason was reported: ${refused?.meta?.refusedWhy}`);
  });

  test('a kind nobody recognises falls back to a plain refusal rather than printing itself', () => {
    const out = walked(sheet.replace('(irreversible)', '(something new)'));
    const refused = out.find((o) => o.path === 'export.index%2Ejs.deleteAll');
    assert.ok(refused, 'the line stopped being read at all');
    assert.match(String(refused?.meta?.refusedWhy), /\(refused\)/);
  });

  test('the raw sheet is not compared twice', () => {
    const out = walked(sheet);
    const stdout = out.find((o) => o.path === 'cli.what the package entry answers.stdout');
    assert.ok(stdout, 'what the module printed on its way in still has to be compared');
    assert.equal(String(stdout?.value).includes('hello-world'), false, 'the answers were left in the wall of text as well, so every change is now reported twice');
  });

  test('a probe that was killed halfway is left alone rather than read as a full sheet', () => {
    // Without the closing marker there is no way to know which calls never happened, and a
    // half-finished sheet read as a finished one credits functions nobody called.
    const half = sheet.slice(0, sheet.indexOf(ANSWERS_END));
    const out = walked(half);
    assert.equal(out.length, 1, 'a half-written sheet was taken apart anyway');
    assert.equal(out[0].value, half, 'and the raw output must survive so somebody can see what happened');
  });

  test('the journeys are made from the imports the settings already carry', () => {
    const { journeys, gaps } = journeysFromExports({ config: { imports: [{ name: 'the package entry', module: 'index.js' }] } });
    assert.equal(journeys.length, 1);
    assert.ok(isAnAnswerJourney(journeys[0]), 'the walk would not know to take its sheet apart');
    assert.match(String(journeys[0].steps?.[0]?.run), /answers-probe\.js/);
    assert.ok(gaps.length > 0, 'a fixed ladder of inputs is a limit and has to be reported as one on every run');
    assert.match(gaps[0].why, /fixed values/);
  });

  test('a project with nothing to import gets no journeys and claims nothing', () => {
    assert.deepEqual(journeysFromExports({ config: {} }).journeys, []);
    assert.deepEqual(journeysFromExports({}).gaps, []);
  });
});

// ---------------------------------------------------------------------------
// The ledger stops calling a label an opened door
// ---------------------------------------------------------------------------

describe('reading a name off a module is not walking through it', () => {
  const door = doorFact(/** @type {any} */ ({ kind: 'export', name: 'slug', file: 'index.js', line: 2, via: '', named: true, inTest: false, detail: '' }));

  test('the shape reading counts as reached, never as opened', () => {
    // This one word is the whole defect. `export.<journey>.<name>` is written by the import
    // journey, which imports the module and looks at it. Nothing called anything.
    const walk = walkFromCapture(
      /** @type {any} */ ({ journey: 'the package entry', observations: [], startedAt: '2026-08-31T00:00:00.000Z' }),
      /** @type {any} */ (undefined),
    );
    const did = whatTheWalkDid(door, walk, new Set(['export.the package entry.slug']));
    assert.equal(did?.state, 'reached', 'a name read off a module was counted as an opened door');
    assert.match(String(did?.how), /nothing called it/, 'and the reader has to be told why in the same sentence');
  });

  test('a call at the exported name\'s own address does count as opened', () => {
    const walk = walkFromCapture(
      /** @type {any} */ ({ journey: 'what the package entry answers', observations: [], startedAt: '2026-08-31T00:00:00.000Z' }),
      /** @type {any} */ (undefined),
    );
    const did = whatTheWalkDid(door, walk, new Set(['export.index%2Ejs.slug']));
    assert.equal(did?.state, 'opened', 'a function that really was called has to count, or the queue never empties');
  });

  test('the ledger says in words that a name-only reading compared nothing about what it does', () => {
    const led = buildLedger({
      product: 'slugly',
      doors: [door],
      walks: [{ journey: 'the package entry', paths: ['export.the package entry.slug'], at: '2026-08-31T00:00:00.000Z' }],
    });
    assert.equal(led.opened, 0);
    assert.equal(led.reached, 1);
    const said = led.caveats.join(' ');
    assert.match(said, /read but never called/, `the ledger let a label pass for coverage: ${said}`);
    assert.match(said, /DIFFERENT ANSWER/, 'and it has to say what that costs, not just name a state');
  });
});

// ---------------------------------------------------------------------------
// A door with a gap in its address
// ---------------------------------------------------------------------------

describe('a page nobody can open without a value says so', () => {
  /** @param {string} name */
  const route = (name) => doorFact(/** @type {any} */ ({ kind: 'route', name, detail: 'GET', file: 'src/routes.js', line: 1, via: '', named: true, inTest: false }));

  test('every framework\'s way of writing a placeholder is recognised', () => {
    // Six families write this six ways and all of them mean "there is nothing here to ask
    // for yet". Missing one means that framework's pages read as ordinary unopened doors.
    for (const [name, expected] of [
      ['/blog/[slug]', 'slug'],
      ['/docs/[...path]', 'path'],
      ['/shop/[[...all]]', 'all'],
      ['/users/:id', 'id'],
      ['/notes/$noteId', 'noteId'],
      ['/team/{member}', 'member'],
    ]) {
      assert.deepEqual(placeholdersIn(route(String(name))), [expected], `${name} was not recognised`);
    }
  });

  test('an ordinary address has no placeholder and gets the ordinary sentence', () => {
    assert.deepEqual(placeholdersIn(route('/about')), []);
    const led = buildLedger({ product: 'site', doors: [route('/about')], walks: [] });
    assert.match(led.entries[0].how, /Nothing has ever opened it/);
    assert.equal(/should be/.test(led.entries[0].how), false);
  });

  test('an unopened parameterised route is named as found-and-not-opened, with what would open it', () => {
    const led = buildLedger({ product: 'site', doors: [route('/blog/[slug]')], walks: [] });
    assert.equal(led.never, 1, 'it has to be counted as a door nobody opened, not quietly dropped');
    assert.match(led.entries[0].how, /"slug"/, 'the reader has to be told which value is missing');
    assert.match(led.entries[0].how, /samples/, 'and where to put it, or the job never gets done');
  });

  test('a route with two gaps names both', () => {
    const led = buildLedger({ product: 'site', doors: [route('/[org]/[repo]')], walks: [] });
    assert.match(led.entries[0].how, /"org" and "repo"/);
  });
});
