/**
 * The coverage ledger, and the one promise the whole tool rests on:
 *
 *   A GREEN RUN MUST NEVER READ AS MORE THAN IT IS.
 *
 * A tool that says "nothing changed" is indistinguishable, from the outside, from a tool
 * that looked at nothing. The more useful this becomes the less anybody will read past the
 * headline — so the sentence naming what was NOT checked has to arrive in the same breath
 * as the good news, on every reply, in every mode, whether a person or an agent is reading.
 *
 * These tests are about honesty rather than function. Each one is a specific way the tool
 * could quietly start meaning less than it appears to:
 *
 *   - a verdict on a product with unopened doors that reads as fully checked
 *   - a run that compared nothing at all and came back as a pass
 *   - a journey handed to an adapter that would never open the thing it names
 *   - a run aimed at a phone that quietly checks the command-line tool next to it
 *   - a machine survey that calls a surface ready when this copy has nothing to drive it
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { check, whatWasNotChecked, loadAdapters, ADAPTER_FOR_SURFACE } from '../../src/v2/check.js';
import { buildLedger, doorFact, toCoverage, walkFromCapture } from '../../src/v2/coverage.js';
import { httpAdapter } from '../../src/v2/adapters/http.js';
import { capabilities } from '../../src/v2/doctor.js';
import { callTool } from '../../src/v2/mcp/tools.js';
import { scratchDir, cleanUp } from '../support.mjs';

const exec = promisify(execFile);

/** Two runs of two journeys plus a git export. Slow enough to need saying, fast enough to keep. */
const RUN_MS = 120_000;

/** Every probe the machine survey makes, on a laptop that may be busy. */
const SURVEY_MS = 60_000;

/**
 * Which adapter every surface is supposed to reach, written out here rather than derived
 * from the table under test — a test that derives its expectation from the thing it is
 * testing agrees with any answer at all. This is what a new platform has to be added to.
 *
 * `cli` and `library` share the process adapter deliberately: both are a child process
 * with its output read, and one adapter really does open both. Everything else has an
 * adapter built for it and nothing else will do.
 */
const WALKED_BY = {
  cli: 'process',
  library: 'process',
  server: 'http',
  web: 'web',
  electron: 'electron',
  android: 'android',
  ios: 'ios',
  windows: 'windows',
  linux: 'linux',
  macos: 'macos',
  extension: 'extension',
};

// ---------------------------------------------------------------------------
// The sentence
// ---------------------------------------------------------------------------

describe('what was not checked, said out loud', () => {
  test('there is no way to get nothing back', () => {
    // A caller that could receive an empty string would, sooner or later, drop the whole
    // line on the runs where it matters most.
    for (const coverage of [
      undefined,
      { paths: 0, journeys: 0, byChannel: {}, gaps: [] },
      { paths: 10, journeys: 1, byChannel: {}, gaps: [] },
      { paths: 10, journeys: 1, byChannel: {}, gaps: [], doorsKnown: 5, doorsWalked: 5 },
      { paths: 10, journeys: 1, byChannel: {}, gaps: [{ what: 'a thing', why: 'a reason' }] },
    ]) {
      const said = whatWasNotChecked(/** @type {any} */ (coverage));
      assert.equal(typeof said, 'string');
      assert.ok(said.trim().length > 40, `too short to mean anything: ${said}`);
    }
  });

  test('a product with unopened doors can never produce a verdict that reads as fully checked', () => {
    const said = whatWasNotChecked({ paths: 601, journeys: 12, byChannel: {}, gaps: [], doorsKnown: 452, doorsWalked: 61 });
    assert.match(said, /NOT EVERYTHING WAS CHECKED/, 'the words that stop a clean result being over-read have to be in there');
    assert.match(said, /391/, 'and the actual number of doors nobody has opened, not a vague admission');
    assert.match(said, /452/);
    // "NOT EVERYTHING WAS CHECKED" is the sentence we want, so the claim being looked for
    // is one that is not preceded by a NOT.
    assert.equal(/(?<!NOT )EVERYTHING WAS CHECKED/.test(said), false, `it must never claim completeness: ${said}`);
    assert.equal(/fully checked|everything is covered/i.test(said), false, `it must never claim completeness: ${said}`);
  });

  test('even a run that walked everything it knows about refuses to claim it checked everything', () => {
    const said = whatWasNotChecked({ paths: 601, journeys: 12, byChannel: {}, gaps: [], doorsKnown: 61, doorsWalked: 61 });
    assert.match(said, /not every possible state/i, 'the honest limit is that nothing can enumerate every state, and it has to be said even on the best run');
  });

  test('a run that reported no coverage at all says the thoroughness is unknown', () => {
    assert.match(whatWasNotChecked(undefined), /unknown/i);
    assert.match(whatWasNotChecked(undefined), /unproven/i);
  });

  test('a run that walked nothing says so, rather than saying nothing changed', () => {
    assert.match(whatWasNotChecked({ paths: 0, journeys: 0, byChannel: {}, gaps: [] }), /Nothing was walked at all/);
  });

  test('the doors gap is counted once, not twice', () => {
    // foldCoverage adds a gap FOR the unopened doors. Counting it again in "other things"
    // makes the hole look bigger than it is, and a number a reader can catch out is a
    // number they stop believing.
    const said = whatWasNotChecked({
      paths: 10,
      journeys: 1,
      byChannel: {},
      doorsKnown: 10,
      doorsWalked: 4,
      gaps: [{ what: '6 of the 10 doors the code opens have never been walked through.', why: 'No journey reaches them.', doors: 6 }],
    });
    assert.equal(/other thing/.test(said), false, `the doors gap was counted a second time: ${said}`);
  });
});

// ---------------------------------------------------------------------------
// Which adapter walks what
// ---------------------------------------------------------------------------

describe('every journey reaches an adapter built for it, or is reported as a hole', () => {
  test('every surface in the vocabulary is in the table', () => {
    for (const surface of Object.keys(WALKED_BY)) {
      assert.ok(surface in ADAPTER_FOR_SURFACE, `nothing says which adapter walks a ${surface} journey, so one would silently walk nothing`);
    }
  });

  test('no surface is pointed at a stand-in', async () => {
    // This is the bug that bit web and Electron: a web journey handed to the HTTP adapter
    // never opens a browser, and an Electron journey handed to the process adapter never
    // opens the app. Both walk nothing and both report it as covered, which is the one
    // outcome this tool must never produce. A phone must not inherit it.
    assert.deepEqual({ ...ADAPTER_FOR_SURFACE }, WALKED_BY);
  });

  test('an adapter this copy does not have is named, not guessed at', async () => {
    const { adapters, missing } = await loadAdapters();
    for (const [surface, name] of Object.entries(ADAPTER_FOR_SURFACE)) {
      const here = adapters.some((a) => a.name === name);
      if (here) continue;
      const why = missing.get(surface);
      assert.ok(typeof why === 'string' && why.length > 40, `there is no ${name} adapter here and nothing says so in words anybody could act on`);
    }
    // Whatever is here really is here, and really answers to the name journeys look for.
    for (const adapter of adapters) {
      assert.equal(typeof adapter.run, 'function', `the "${adapter.name}" adapter cannot walk anything`);
      assert.ok(Array.isArray(adapter.channels) && adapter.channels.length > 0, `the "${adapter.name}" adapter does not say which channels it fills`);
    }
  });
});

// ---------------------------------------------------------------------------
// A real run, on a real product
// ---------------------------------------------------------------------------

describe('a real check on a small product', () => {
  /** @type {string} */
  let root;

  before(async () => {
    root = await scratchDir('staysfixed-coverage');
    await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'tiny', version: '1.0.0', type: 'module' }, null, 2));
    await fsp.writeFile(
      path.join(root, 'cli.js'),
      ['const what = process.argv[2] ?? "help";', 'if (what === "help") console.log("tiny — adds two numbers");', 'else console.log(String(Number(process.argv[3]) + Number(process.argv[4])));', ''].join('\n')
    );
    await fsp.writeFile(
      path.join(root, 'staysfixed.config.json'),
      JSON.stringify({ product: 'tiny', process: { commands: [{ name: 'help', run: 'node cli.js help' }] } }, null, 2)
    );
    await exec('git', ['init', '-q'], { cwd: root });
    await exec('git', ['add', '-A'], { cwd: root });
    await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'first'], { cwd: root });
  });

  after(async () => {
    await cleanUp();
  });

  test('every verdict carries what it did not look at, including the clean ones', { timeout: RUN_MS }, async () => {
    const verdict = await check({ cwd: root, against: 'HEAD', paired: true });
    assert.equal(verdict.blocked, undefined, verdict.summary);
    assert.ok(verdict.coverage, 'a verdict with no coverage is a verdict nobody can size');
    // The sentence rides inside the paragraph a person quotes and an agent reads. Putting
    // it in a field of its own would make it something you have to know to go and look at.
    assert.ok(verdict.summary.includes(whatWasNotChecked(verdict.coverage)), `the coverage sentence never reached the summary:\n${verdict.summary}`);
  });

  test('a run with nothing on record to compare against is not a pass', { timeout: RUN_MS }, async () => {
    // The worst shape a reply can have: every journey walked, nothing on the other side,
    // zero differences, and a verdict that reads "nothing that worked has changed".
    await fsp.rm(path.join(root, '.staysfixed'), { recursive: true, force: true });
    const verdict = await check({ cwd: root, against: 'HEAD' });
    assert.equal(verdict.ok, false, `nothing was compared and it came back as a pass:\n${verdict.summary}`);
    assert.match(verdict.summary, /NOTHING WAS ACTUALLY COMPARED/);
    assert.match(verdict.summary, /not a pass/);
  });

  test('a run aimed at a surface this project does not have refuses by name', { timeout: RUN_MS }, async () => {
    // There is no desktop app in this project. The dangerous answer would be to walk the
    // command-line tool sitting next to it and hand back a clean result, which is true
    // and is about something else entirely.
    const verdict = await check({ cwd: root, surface: 'electron' });
    assert.equal(verdict.blocked, true, 'it must not check the command-line tool and report that as the answer about a desktop app');
    assert.equal(verdict.ok, false);
    assert.match(verdict.summary, /aimed at electron/);
    assert.equal(verdict.target, undefined, 'and it must never confirm it went somewhere it did not go');
  });

  test('an "at" with nowhere to go is refused rather than quietly ignored', { timeout: RUN_MS }, async () => {
    // An engine that does not understand where it was pointed does not fail — it checks
    // whatever it was going to check anyway and hands back a clean result about the
    // wrong thing. So an address no adapter would ever read is a refusal.
    const verdict = await check({ cwd: root, surface: 'cli', at: '/somewhere/else' });
    assert.equal(verdict.blocked, true);
    assert.match(verdict.summary, /nowhere to put/);
  });

  test('a run aimed at a surface nothing here can drive refuses, and says which adapter is missing', { timeout: RUN_MS }, async () => {
    const { adapters } = await loadAdapters();
    const absent = Object.entries(ADAPTER_FOR_SURFACE).find(([, name]) => !adapters.some((a) => a.name === name));
    if (!absent) return; // Every adapter is here. Nothing to refuse, and that is a good day.
    const verdict = await check({ cwd: root, surface: /** @type {any} */ (absent[0]) });
    assert.equal(verdict.blocked, true);
    assert.match(verdict.summary, new RegExp(`aimed at ${absent[0]}`));
  });

  test('a run that did go where it was aimed says so, so a clean result can be trusted to be about it', { timeout: RUN_MS }, async () => {
    const verdict = await check({ cwd: root, surface: 'cli', against: 'HEAD', paired: true });
    assert.equal(verdict.blocked, undefined, verdict.summary);
    assert.deepEqual(verdict.target, { surface: 'cli', at: null });
  });

  test('the agent is told what was not checked in the check reply itself', { timeout: RUN_MS }, async () => {
    const ctx = { root, cwd: root, version: '2.0.0-test', protocolVersion: '2025-06-18' };
    const reply = await callTool('staysfixed_check', {}, ctx);
    const text = reply.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
    assert.ok(
      /NOT EVERYTHING WAS CHECKED|not every possible state/.test(text),
      `an agent could read this whole reply and never learn what was left out:\n${text.slice(0, 800)}`
    );
  });

  test('and as machine-readable fields, not only inside a paragraph', { timeout: RUN_MS }, async () => {
    const ctx = { root, cwd: root, version: '2.0.0-test', protocolVersion: '2025-06-18' };
    const reply = await callTool('staysfixed_check', { format: 'json' }, ctx);
    const payload = /** @type {any} */ (reply.structuredContent);
    assert.ok(payload, 'the JSON shape is what an agent acts on');
    assert.equal(typeof payload.notChecked, 'string');
    assert.ok(payload.notChecked.length > 40);
    assert.equal(typeof payload.doorsNeverOpened, 'number');
  });

  test('a clean run says what a clean run on this machine actually means', { timeout: RUN_MS }, async () => {
    // A product with a website and an iPhone app, checked on a machine that can only open
    // the website, produces a perfectly clean result that says nothing about the phone.
    // Nothing inside the run can know that, so the machine's own statement has to arrive
    // beside it — otherwise an agent reads "nothing changed" and reports a change as safe.
    const ctx = { root, cwd: root, version: '2.0.0-test', protocolVersion: '2025-06-18' };
    const reply = await callTool('staysfixed_check', { format: 'json' }, ctx);
    const payload = /** @type {any} */ (reply.structuredContent);
    if (payload.ok !== true) return; // Something really did change; that agent has work to do and nothing to over-read.
    assert.ok(typeof payload.covers === 'string' && payload.covers.length > 60, 'a clean reply has to say what a clean result here covers, and what it does not');
    assert.match(payload.covers, /does NOT check|covers nothing in full|Nothing is being left out/);
  });
});

// ---------------------------------------------------------------------------
// The machine, and this copy of the tool
// ---------------------------------------------------------------------------

describe('what this machine and this copy can honestly claim', () => {
  /** @type {import('../../src/v2/doctor.js').Capabilities} */
  let caps;

  before(async () => {
    caps = await capabilities({ cwd: process.cwd(), offline: true });
  });

  test('what this copy can drive is answered separately from what this machine could run', { timeout: SURVEY_MS }, () => {
    assert.ok(Array.isArray(caps.drivers) && caps.drivers.length > 0, 'a Mac with Xcode on it can run an iPhone app; that says nothing about whether there is an adapter here that opens one');
    for (const driver of caps.drivers) {
      assert.equal(typeof driver.present, 'boolean');
      assert.ok(driver.why.length > 30, `"${driver.surface}" does not say why in words anybody could act on`);
    }
  });

  test('a surface with no adapter behind it is never called ready', { timeout: SURVEY_MS }, () => {
    const undrivable = new Set(caps.drivers.filter((d) => !d.present).map((d) => d.surface));
    for (const surface of caps.surfaces) {
      if (!undrivable.has(surface.id)) continue;
      assert.notEqual(surface.status, 'ready', `${surface.id} is called ready and nothing in this copy could open one`);
      assert.notEqual(surface.status, 'partial', `${surface.id} is called partly covered and nothing in this copy could open one`);
    }
  });

  test('nobody is asked to install a phone toolchain for a product that has no phone app in it', { timeout: SURVEY_MS }, () => {
    // Stays Fixed itself has no Android or iPhone app. Asking for Java, an emulator or
    // thirty gigabytes of Xcode here is asking somebody to do work that changes nothing,
    // and never doing that is the whole point of the four states.
    const asked = caps.nextSteps.map((s) => `${s.what} ${s.fix}`).join(' | ');
    assert.equal(/Xcode|emulator|adb|Temurin|JDK/i.test(asked), false, `this project has no phone app and somebody is being sent shopping anyway: ${asked}`);
  });

  test('what a phone or a Windows box needs is asked of its adapter, never kept as a second opinion here', { timeout: SURVEY_MS }, () => {
    // This file used to keep its own list of program names for Android — Java, adb, the
    // emulator, Appium — and the adapter that arrived does not use Appium at all. Two
    // statements of one truth, one of them quietly wrong, is the exact bug this whole tool
    // exists to catch, and it would have cost somebody twenty minutes installing something
    // nothing here touches. The wording below is the only wording askTheAdapters writes.
    const writtenByTheAsker = /^(Nothing on this platform can be checked at all without it\.|It widens what can be watched here\.)$/;
    for (const id of ['android', 'ios', 'windows']) {
      const surface = caps.surfaces.find((s) => s.id === id);
      assert.ok(surface, `${id} is not being reported at all`);
      for (const need of surface.needs) {
        assert.match(need.why, writtenByTheAsker, `${id} is asking for "${need.what}" out of a list kept in doctor.js rather than out of the adapter that knows`);
      }
    }
  });

  test('nobody is sent to install something this tool does not use', { timeout: SURVEY_MS }, () => {
    const everythingAskedFor = [
      ...caps.tools.map((t) => `${t.name} ${t.fix ?? ''}`),
      ...caps.surfaces.flatMap((s) => s.needs.map((n) => `${n.what} ${n.fix}`)),
      ...caps.nextSteps.map((n) => `${n.what} ${n.fix}`),
    ].join(' ');
    assert.equal(/appium/i.test(everythingAskedFor), false, 'nothing in this tool uses Appium, so asking anybody to install it costs them time for nothing');
  });

  test('anything a person is asked for says what they get for it', { timeout: SURVEY_MS }, () => {
    for (const surface of caps.surfaces) {
      for (const need of surface.needs) {
        if (need.automatic) continue;
        assert.ok(
          typeof need.unlocks === 'string' && need.unlocks.length > 20,
          `a person is being asked to do "${need.what}" and has not been told what it buys them`
        );
      }
    }
  });
});

/**
 * The join the whole ledger rests on: a door read out of the code, and an address the running
 * product answered at.
 *
 * These are pure and fast on purpose. The bug they exist for was silent and total — every route
 * on every server read as never walked, on runs that had just asked the server for all of them,
 * because the HTTP adapter writes its observations under `api.<journey name>` and a route door's
 * address is `route.<VERB>.<url>`. Nothing failed, nothing was slow, and the one number in this
 * tool that must never be optimistic was instead wrong in the honest direction while the SENTENCE
 * built from it was wrong in the direction that makes a person go and redo work already done.
 */
describe('a door and the address a walk touched', () => {
  /**
   * @param {string} name
   * @param {string} verb
   * @returns {any}
   */
  const routeDoor = (name, verb) =>
    doorFact({ kind: 'route', name, detail: verb, file: 'server.js', line: 1, inTest: false, named: true, via: 'literal' });

  /**
   * A walk built the way the engine builds one, from a capture and the journey behind it.
   * @param {string} journeyName
   * @param {any} journey
   * @returns {any}
   */
  const walkOf = (journeyName, journey) =>
    walkFromCapture(
      /** @type {any} */ ({
        id: 'c', journey: journeyName, build: { id: 'b', product: 'shop' }, run: 'single',
        startedAt: '2026-08-30T00:00:00Z', durationMs: 1,
        observations: ['status', 'body', 'shape'].map((leaf) => ({ path: `api.${journeyName}.${leaf}`, channel: 'results', value: 1 })),
      }),
      journey,
    );

  test('the HTTP adapter says which route each of its journeys knocks on', async () => {
    const root = await scratchDir('staysfixed-doors');
    await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { express: '^4' } }));
    await fsp.writeFile(
      path.join(root, 'server.js'),
      "import express from 'express';\nconst app = express();\napp.get('/products', (q, r) => r.json([]));\napp.post('/products', (q, r) => r.json({}));\n",
    );

    const journeys = await httpAdapter.journeys(/** @type {any} */ ({ root, config: {} }));
    const get = journeys.find((j) => j.name === 'GET /products');
    assert.ok(get, 'the adapter has to offer a journey for a route it found');
    const step = /** @type {any} */ (get?.steps?.[0]);
    assert.equal(step.door, '/products');
    assert.equal(step.kind, 'route');
    assert.equal(step.doorDetail, 'GET', 'without the verb, walking GET would report POST as walked too');
  });

  test('walking GET opens GET and leaves POST shut', async () => {
    const root = await scratchDir('staysfixed-doors');
    await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { express: '^4' } }));
    await fsp.writeFile(
      path.join(root, 'server.js'),
      "import express from 'express';\nconst app = express();\napp.get('/products', (q, r) => r.json([]));\napp.post('/products', (q, r) => r.json({}));\n",
    );
    const journeys = await httpAdapter.journeys(/** @type {any} */ ({ root, config: {} }));

    const led = buildLedger({
      product: 'shop',
      doors: [routeDoor('/products', 'GET'), routeDoor('/products', 'POST')],
      walks: [walkOf('GET /products', journeys.find((j) => j.name === 'GET /products'))],
      byChannel: {}, captures: 1, builds: 1, caveats: [], gaps: [],
    });

    assert.equal(led.doors, 2, 'two verbs on one url are two doors, and a break behind either is a break');
    assert.equal(led.opened, 1);
    assert.equal(led.never, 1);
    const shut = led.entries.find((e) => e.state === 'never');
    assert.equal(shut?.address, 'route.POST./products', 'the door left shut has to be the one nothing walked');
  });

  test('a route nothing walked is still counted, so a clean run cannot read as full coverage', () => {
    const led = buildLedger({
      product: 'shop', doors: [routeDoor('/health', 'GET')], walks: [],
      byChannel: {}, captures: 0, builds: 1, caveats: [], gaps: [],
    });
    assert.equal(led.never, 1);
    assert.match(toCoverage(led).gaps[0].what, /only door has never been opened/, 'and it reads as English on a one-door product');
  });
});

describe('knocking is not walking', () => {
  /** @param {any} extra */
  const capture = (extra) => ({
    journey: 'GET /reports',
    startedAt: '2026-08-31T00:00:00.000Z',
    build: { id: 'work-1' },
    observations: [{ path: 'api.GET /reports.status', channel: 'results', value: extra.status }],
  });
  const journey = () => ({
    steps: [{ act: 'request', method: 'GET', door: '/reports', kind: 'route', doorDetail: 'GET' }],
  });

  test('a route the build answers 404 to is not a walked door', () => {
    // Behind a login wall every door bounced, and a route whose handler had been deleted
    // answered 404 — and both counted as WALKED, so the run reported full coverage of a
    // product it had never been inside. The coverage ledger lying in that direction is the
    // one thing this file says it must never do. Measured 2026-08-31.
    const walk = walkFromCapture(/** @type {any} */ (capture({ status: 404 })), /** @type {any} */ (journey()));
    assert.equal(walk.doorAddresses, undefined, 'nothing was proved about it, so it stays shut');
    assert.deepEqual(walk.knockedShut, [{ door: 'GET /reports', status: 404 }]);
  });

  test('a route that answers is walked', () => {
    const walk = walkFromCapture(/** @type {any} */ (capture({ status: 200 })), /** @type {any} */ (journey()));
    assert.equal(walk.doorAddresses?.length, 1, 'or nothing could ever be covered');
    assert.equal(walk.knockedShut, undefined);
  });

  test('a 500 is walked — the route exists and it broke, which is the whole point', () => {
    const walk = walkFromCapture(/** @type {any} */ (capture({ status: 500 })), /** @type {any} */ (journey()));
    assert.equal(walk.doorAddresses?.length, 1);
    assert.equal(walk.knockedShut, undefined);
  });

  test('a redirect is walked, and said out loud, because the bounce is not what is behind it', () => {
    const walk = walkFromCapture(/** @type {any} */ (capture({ status: 302 })), /** @type {any} */ (journey()));
    assert.equal(walk.doorAddresses?.length, 1);
    assert.deepEqual(walk.onlyRedirected, [{ door: 'GET /reports', status: 302 }]);
  });
});
