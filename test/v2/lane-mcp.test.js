/**
 * What an agent is TOLD, over MCP.
 *
 * Every test here is a sentence the tool put in front of a coding agent that was not true.
 * They are grouped by the three ways that happened.
 *
 * A GATE THAT REFUSED THE ONE FILE IN THE PRODUCT. An agent holds absolute paths — that is
 * what its own editing tools hand it — so it seals `/Users/…/tiny/cli.js`, edits that exact
 * file, and `staysfixed_waive` answers "Refused. This is outside what you sealed." A gate
 * that refuses the change it was shown is not being strict, it is being wrong, and an agent
 * told that has no honest way forward at all.
 *
 * A FINDING ABOUT THE WORLD, WITH THE ANSWER FORCED. `staysfixed_coverage` asked the machine
 * survey with `offline: true` written into the code — which does not even read the ssh
 * config — and then printed "No Windows desktop is reachable from here" as a fact, while
 * `staysfixed doctor` on the same Mac named two machines and said nothing was known about
 * them. Same machine, opposite answers, depending on who asked.
 *
 * A COLD START MUST NEVER READ AS A PASS. Nothing has been compared, so nothing can be
 * clean. This is the one rule the whole tool exists for, so it is re-proved here on every
 * shape of reply a machine can read.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { scratchDir, cleanUp } from '../support.mjs';
import { callTool, toolDefinitions } from '../../src/v2/mcp/tools.js';

const exec = promisify(execFile);

/** Long enough to walk a two-command product twice on a busy machine. */
const RUN_MS = 180_000;

/** @param {any} reply */
const said = (reply) => reply.content.map((/** @type {any} */ c) => (c.type === 'text' ? c.text : '')).join('\n');

/** @param {string} root */
const ctxFor = (root) => ({ root, cwd: root, version: '2.0.0-test', protocolVersion: '2025-06-18' });

/**
 * The smallest honest product there is: one file, one command that runs it, one commit.
 *
 * @param {{extra?: Record<string, string>}} [opts]
 * @returns {Promise<string>}
 */
async function tinyProduct(opts = {}) {
  const root = await scratchDir('staysfixed-lane-mcp');
  await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'tiny', version: '1.0.0', type: 'module' }, null, 2));
  await fsp.writeFile(path.join(root, 'cli.js'), 'console.log("tiny - adds two numbers");\n');
  await fsp.writeFile(
    path.join(root, 'staysfixed.config.json'),
    JSON.stringify({ product: 'tiny', process: { commands: [{ name: 'help', run: 'node cli.js help' }] } }, null, 2)
  );
  for (const [where, what] of Object.entries(opts.extra ?? {})) {
    await fsp.mkdir(path.dirname(path.join(root, where)), { recursive: true });
    await fsp.writeFile(path.join(root, where), what);
  }
  await exec('git', ['init', '-q'], { cwd: root });
  await exec('git', ['add', '-A'], { cwd: root });
  await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'first'], { cwd: root });
  return root;
}

/** Change the one thing this product says, so there is exactly one difference to argue about. */
/** @param {string} root */
async function editIt(root) {
  await fsp.writeFile(path.join(root, 'cli.js'), 'console.log("tiny - a calculator");\n');
}

/**
 * Seal, edit, check, and hand back the id of the one finding.
 * @param {string} root
 * @param {string[]} touches
 * @returns {Promise<string>}
 */
async function sealEditCheck(root, touches) {
  const ctx = ctxFor(root);
  const sealed = said(await callTool('staysfixed_intent', { summary: 'change the help line wording', touches }, ctx));
  assert.match(sealed, /^Sealed as intent-/, `the intent was not sealed at all:\n${sealed}`);
  await editIt(root);
  const checked = said(await callTool('staysfixed_check', { against: 'HEAD', paired: true }, ctx));
  const ids = [...new Set([...checked.matchAll(/\bf-[a-z0-9]+/g)].map((m) => m[0]))];
  assert.equal(ids.length, 1, `expected exactly one difference to argue about, got ${ids.length}:\n${checked}`);
  return ids[0];
}

// ---------------------------------------------------------------------------
// The gate that refused the one file in the product
// ---------------------------------------------------------------------------

describe('staysfixed_waive and the file the agent actually edited', () => {
  after(async () => {
    await cleanUp();
  });

  test('an absolute path is the same file as the relative one, and waive knows it', { timeout: RUN_MS }, async () => {
    const root = await tinyProduct();
    // Exactly what an agent has in its hand after editing a file: the absolute path.
    const id = await sealEditCheck(root, [path.join(root, 'cli.js')]);
    const answer = said(await callTool('staysfixed_waive', { finding: id, because: 'I changed the help line on purpose.' }, ctxFor(root)));
    assert.doesNotMatch(
      answer,
      /Refused/,
      `the only file in the product, the one that was just edited, was reported as outside what the agent sealed:\n${answer}`
    );
    assert.match(answer, /Recorded as intended/, answer);
    assert.match(answer, /cli\.js/, 'the reply has to name the file it matched, or nobody can check the match');
  });

  test('what was sealed is said back relative to the project, not as a machine path', { timeout: RUN_MS }, async () => {
    const root = await tinyProduct();
    const reply = said(await callTool('staysfixed_intent', { summary: 'x', touches: [path.join(root, 'cli.js')] }, ctxFor(root)));
    assert.match(reply, /Expecting to affect: cli\.js\./, reply);
  });

  test('a named area is passed through word for word', { timeout: RUN_MS }, async () => {
    // `touches` takes areas as well as files - "the basket page" is a legitimate answer -
    // and rewriting one of those would break the very match it is there to make.
    const root = await tinyProduct();
    const reply = said(await callTool('staysfixed_intent', { summary: 'x', touches: ['the basket page', 'src/checkout'] }, ctxFor(root)));
    assert.match(reply, /Expecting to affect: the basket page, src\/checkout\./, reply);
  });

  test('a path outside the project is left exactly as the agent wrote it', { timeout: RUN_MS }, async () => {
    const root = await tinyProduct();
    const elsewhere = path.join(os.tmpdir(), 'somewhere-else', 'other.js');
    const reply = said(await callTool('staysfixed_intent', { summary: 'x', touches: [elsewhere] }, ctxFor(root)));
    assert.ok(reply.includes(elsewhere), `a file outside the project must not be rewritten into one inside it:\n${reply}`);
  });

  test('and the gate still refuses a difference the agent never declared', { timeout: RUN_MS }, async () => {
    // The fix must not have widened the gate. Same absolute-path spelling, pointing at a
    // file that has nothing to do with the difference: still refused, in the same words.
    const root = await tinyProduct({ extra: { 'docs/notes.md': '# notes\n' } });
    const id = await sealEditCheck(root, [path.join(root, 'docs', 'notes.md')]);
    const answer = said(await callTool('staysfixed_waive', { finding: id, because: 'I meant this too, honestly.' }, ctxFor(root)));
    assert.match(answer, /Refused/, `a difference outside what was declared was waved through:\n${answer}`);
  });
});

// ---------------------------------------------------------------------------
// A finding about the world, with the answer forced
// ---------------------------------------------------------------------------

describe('staysfixed_coverage and the machines it never asked', () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let fakeHome;
  /** @type {string|undefined} */
  let realHome;
  /** @type {string|undefined} */
  let realProfile;
  /** Whether this platform actually took the fake home. */
  let homeIsFake = false;

  before(async () => {
    root = await tinyProduct();
    fakeHome = await scratchDir('staysfixed-lane-mcp-home');
    await fsp.mkdir(path.join(fakeHome, '.ssh'), { recursive: true });
    // Two machines named and nothing else. Nothing here is ever dialled: a project with no
    // desktop app in it needs no second machine, so the survey only ever reads the file.
    await fsp.writeFile(path.join(fakeHome, '.ssh', 'config'), 'Host imza-pc-linux\n  HostName 127.0.0.1\n\nHost demo-box\n  HostName 127.0.0.1\n');
    realHome = process.env.HOME;
    realProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    homeIsFake = os.homedir() === fakeHome;
  });

  after(async () => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realProfile;
    await cleanUp();
  });

  test('machines named in the ssh config are named to the agent too, as not asked', { timeout: RUN_MS }, async () => {
    if (!homeIsFake) return; // Somebody else's real ssh config is not something to read in a test.
    const text = said(await callTool('staysfixed_coverage', {}, ctxFor(root)));
    assert.match(
      text,
      /imza-pc-linux/,
      `the agent was told what this machine cannot reach without ever being told which machines were never asked:\n${text}`
    );
    assert.match(text, /not dialled/, text);
  });

  test('and asking for offline says so rather than pretending the machines are not there', { timeout: RUN_MS }, async () => {
    if (!homeIsFake) return;
    const on = /** @type {any} */ ((await callTool('staysfixed_coverage', { format: 'json' }, ctxFor(root))).structuredContent);
    const off = /** @type {any} */ ((await callTool('staysfixed_coverage', { format: 'json', offline: true }, ctxFor(root))).structuredContent);
    assert.equal(on.machinesNotDialled.length, 2, JSON.stringify(on.machinesNotDialled));
    assert.equal(on.machinesNotLookedFor, false);
    // Offline is a real answer and a caller may want it. What it may never be is the
    // answer the tool forces on every caller and then reports as a fact about the world -
    // so an empty machine list has to say whether nobody looked or there was nobody there.
    assert.equal(off.machinesNotDialled.length, 0);
    assert.equal(off.machinesNotLookedFor, true);
    const offText = said(await callTool('staysfixed_coverage', { offline: true }, ctxFor(root)));
    assert.match(offText, /without looking for any other machine/, offText);
  });

  test('"there is no Android app here" is not reported as "this machine cannot reach one"', { timeout: RUN_MS }, async () => {
    const text = said(await callTool('staysfixed_coverage', {}, ctxFor(root)));
    const outOfReach = text.split('Cannot be reached from this machine at all')[1] ?? '';
    const upToThere = outOfReach.split('\n\n')[0];
    assert.doesNotMatch(
      upToThere,
      /no Android app was found in this project|no desktop app was found in this project|no iPhone app was found in this project/,
      `a project with no phone app in it was reported as a machine that cannot reach one:\n${text}`
    );
    assert.match(text, /nothing of these kinds in this project/i, `and the real reason has to be said somewhere:\n${text}`);
  });

  test('the JSON keeps the two apart as well', { timeout: RUN_MS }, async () => {
    const payload = /** @type {any} */ ((await callTool('staysfixed_coverage', { format: 'json' }, ctxFor(root))).structuredContent);
    assert.ok(Array.isArray(payload.surfacesNotInThisProject), 'no field says which surfaces are simply absent from the project');
    const names = payload.surfacesOutOfReach.map((/** @type {any} */ s) => s.name).join(', ');
    assert.doesNotMatch(names, /Android|iPhone|Electron/, `these are absent from the project, not out of reach: ${names}`);
  });

  test('and the tool says out loud that offline is a choice the caller can make', () => {
    const coverage = toolDefinitions().find((t) => t.name === 'staysfixed_coverage');
    assert.ok(coverage, 'staysfixed_coverage is not in the list');
    assert.ok(coverage.inputSchema.properties.offline, 'a caller cannot ask for the cheap survey, so the code would have to force one');
  });
});

// ---------------------------------------------------------------------------
// A cold start must never read as a pass
// ---------------------------------------------------------------------------

describe('a copy where nothing has ever been compared', () => {
  /** @type {string} */
  let root;

  before(async () => {
    root = await tinyProduct();
  });

  after(async () => {
    await cleanUp();
  });

  for (const args of [{}, { paired: true }, { offset: 5 }, { surface: 'cli' }]) {
    test(`staysfixed_check ${JSON.stringify(args)} does not answer ok to a machine`, { timeout: RUN_MS }, async () => {
      await fsp.rm(path.join(root, '.staysfixed'), { recursive: true, force: true });
      const reply = await callTool('staysfixed_check', { ...args, format: 'json' }, ctxFor(root));
      const payload = /** @type {any} */ (reply.structuredContent);
      assert.equal(payload.ok, false, `nothing was compared and it came back as a pass:\n${payload.verdict}`);
      assert.equal(reply.isError, true, 'and the flag every client puts in front of the agent said the call was fine');
      assert.notEqual(payload.verdict, 'nothing unaccounted for', payload.verdict);
    });
  }

  test('staysfixed_coverage says nothing has been covered, in a field and not only in prose', { timeout: RUN_MS }, async () => {
    await fsp.rm(path.join(root, '.staysfixed'), { recursive: true, force: true });
    const payload = /** @type {any} */ ((await callTool('staysfixed_coverage', { format: 'json' }, ctxFor(root))).structuredContent);
    // Empty lists and nulls are what a product with no holes in it looks like too. A
    // machine reading this has to be able to tell "nothing was missed" from "nothing was
    // measured" without parsing an English sentence.
    assert.equal(payload.anyCheckHasRun, false, 'a cold start looked exactly like a fully covered product');
    assert.equal(typeof payload.note, 'string');
    assert.match(payload.note, /No check has run/i, payload.note);
  });
});
