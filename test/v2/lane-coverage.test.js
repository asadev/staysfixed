/**
 * Two things the coverage ledger was doing that this tool cannot afford.
 *
 * ONE — IT DISAGREED WITH ITSELF BETWEEN TWO IDENTICAL RUNS.
 *
 * The whole method here is running the same thing twice and subtracting what disagrees. So a
 * report that comes out different on the second identical run is not untidy: it is the
 * measurement contradicting the method, and a reader who notices has no reason to believe
 * anything else in it either.
 *
 * The cause was one line in the store, working exactly as designed. A capture id ends in
 * three random characters so that two captures written inside the same second cannot
 * overwrite each other — and captures are handed back in id order, so those random characters
 * decide which walk the ledger reads first. Measured 2026-08-31, three runs of one unchanged
 * product, the order coming back each time:
 *
 *     help, the-code, the-code, help
 *     the-code, help, the-code, help
 *     help, the-code, the-code, help
 *
 * Everything built in that order came out shuffled with it: which six of eight shut doors got
 * named in a caveat, the order of the gaps, the key order of the tallies. These tests hand the
 * SAME evidence in different orders and insist the report is identical, because that is the
 * property — the answer is a function of what was seen, never of what arrived first.
 *
 * TWO — IT COUNTED DOORS AS WALKED THAT NOTHING HAD KNOCKED ON.
 *
 * Every adapter has branches where it runs nothing and says so — the server never came up,
 * the route has a `:id` nobody supplied a value for, the command spends money and there is
 * nothing watching to stop it. Each writes one observation marked `refused` and returns. No
 * status comes back because no request went out, and the ledger read a missing status as an
 * answer it was happy with. Measured 2026-08-31 with the HTTP adapter's own output: one
 * route, one journey, the server never started, and the ledger said doorsWalked 1 of 1 — full
 * coverage of a product that had not been run — in the same report whose only line read
 * "was not tried: It never started."
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { describeRequest, httpAdapter } from '../../src/v2/adapters/http.js';
import { addressesTouched, buildLedger, doorFact, toCoverage, walkFromCapture } from '../../src/v2/coverage.js';
import { scratchDir, cleanUp } from '../support.mjs';

/**
 * A door of the shape the code reader hands over.
 * @param {string} name
 * @param {string} verb
 * @returns {any}
 */
const routeDoor = (name, verb) =>
  doorFact({ kind: 'route', name, detail: verb, file: 'server.js', line: 1, inTest: false, named: true, via: 'literal' });

/**
 * One walk, written the way the engine builds one.
 * @param {string} journey
 * @param {any} extra
 * @returns {any}
 */
const walk = (journey, extra) => ({ journey, at: '2026-08-31T00:00:00.000Z', paths: [], ...extra });

/**
 * The whole report, as `--json` would print it.
 * @param {any[]} walks
 * @param {any[]} doors
 * @returns {string}
 */
const reportFor = (walks, doors) =>
  JSON.stringify(
    toCoverage(
      buildLedger({
        product: 'shop',
        doors,
        walks,
        // A fixed stamp, so the only thing that can differ between two of these is the thing
        // being tested. The clock is the ledger's one honest source of difference.
        at: '2026-08-31T00:00:00.000Z',
        byChannel: { results: 4, contract: 9, effects: 1 },
        captures: walks.length,
        builds: 1,
      }),
    ),
  );

describe('the same evidence, whichever order it comes back in', () => {
  test('which doors get named in the caveats does not depend on which capture was read first', () => {
    const doors = ['/a', '/b', '/c', '/d', '/e', '/f', '/g', '/h'].map((name) => routeDoor(name, 'GET'));
    const first = walk('help', {
      knockedShut: ['/a', '/b', '/c', '/d'].map((door) => ({ door: `GET ${door}`, status: 404 })),
      onlyRedirected: ['/p', '/q', '/r'].map((door) => ({ door: `GET ${door}`, status: 302 })),
    });
    const second = walk('the-code', {
      knockedShut: ['/e', '/f', '/g', '/h'].map((door) => ({ door: `GET ${door}`, status: 404 })),
      onlyRedirected: ['/x', '/y', '/z'].map((door) => ({ door: `GET ${door}`, status: 302 })),
    });

    // Both caveats name only the first few doors. Which few used to be decided by chance.
    assert.equal(
      reportFor([first, second], doors),
      reportFor([second, first], doors),
      'the same run, read back in the other order, described itself differently',
    );
  });

  test('the whole report is the same however the walks arrive', () => {
    const doors = [routeDoor('/reports', 'GET'), routeDoor('/reports', 'POST'), doorFact({ kind: 'ipc', name: 'session.save', file: 'src/main.js', line: 3, detail: '', inTest: false, named: true, via: 'literal' })];
    const walks = [
      walk('GET /reports', { paths: ['route', 'route.GET', 'route.GET./reports'], source: 'code' }),
      walk('save the session', { paths: ['ipc', 'ipc.session', 'ipc.session.save'], source: 'suite' }),
      walk('POST /reports', { paths: [], knockedShut: [{ door: 'POST /reports', status: 404 }] }),
    ];

    const straight = reportFor(walks, doors);
    for (const order of [[2, 0, 1], [1, 2, 0], [0, 2, 1], [2, 1, 0], [1, 0, 2]]) {
      assert.equal(reportFor(order.map((i) => walks[i]), doors), straight, `read back as ${order.join(',')} it said something else`);
    }
  });

  test('the tallies keep one key order, because JSON keeps the order keys were added in', () => {
    const doors = [routeDoor('/reports', 'GET')];
    const one = buildLedger({
      product: 'shop', doors, walks: [walk('a', { source: 'suite' }), walk('b', { source: 'code' })],
      byChannel: { effects: 1, results: 2, contract: 3 }, captures: 2, builds: 1, at: 'fixed',
    });
    const two = buildLedger({
      product: 'shop', doors, walks: [walk('b', { source: 'code' }), walk('a', { source: 'suite' })],
      byChannel: { contract: 3, results: 2, effects: 1 }, captures: 2, builds: 1, at: 'fixed',
    });
    assert.deepEqual(Object.keys(one.byChannel), Object.keys(two.byChannel));
    assert.deepEqual(Object.keys(one.byJourneySource), Object.keys(two.byJourneySource));
    assert.equal(JSON.stringify(one.byChannel), JSON.stringify(two.byChannel));
  });

  test('two families that score the same are always listed the same way round', () => {
    // Ten folders of four unopened exports each score identically and hold the same number of
    // doors, so the whole queue is one long tie. A tie settled by whichever came out of the
    // map first reorders the work queue for no reason anybody could explain.
    const doors = [];
    for (const folder of ['zulu', 'alpha', 'mike', 'bravo', 'yankee']) {
      for (const name of ['one', 'two', 'three', 'four']) {
        doors.push(doorFact({ kind: 'export', name: `${folder}${name}`, file: `src/${folder}/index.js`, line: 1, detail: '', inTest: false, named: true, via: 'literal' }));
      }
    }
    // Doors do not always arrive sorted. Read back out of a store rather than out of the
    // source, they arrive in capture order — which is the order the random end of a capture
    // id put them in.
    const jobsOf = (/** @type {string} */ json) => JSON.parse(json).gaps.map((/** @type {any} */ g) => g.what);
    assert.deepEqual(
      jobsOf(reportFor([], [...doors].reverse())),
      jobsOf(reportFor([], doors)),
      'the same families came back as a differently ordered work queue',
    );
  });
});

describe('a door nothing knocked on is never a walked door', () => {
  test("a journey the adapter refused before it ran opens nothing, and doorsWalked says so", async () => {
    const root = await scratchDir('lane-coverage-untried');
    await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { express: '^4' } }));
    await fsp.writeFile(
      path.join(root, 'server.js'),
      "import express from 'express';\nconst app = express();\napp.get('/reports', (q, r) => r.json([]));\n",
    );

    // The adapter's own journey and the adapter's own refusal. Nothing here is written by
    // hand, because a test that invents the observation proves only that the invention works.
    const journeys = await httpAdapter.journeys(/** @type {any} */ ({ root, config: {} }));
    const journey = journeys.find((j) => j.name === 'GET /reports');
    assert.ok(journey, 'the adapter has to offer a journey for a route it found');
    const observations = await httpAdapter.run(
      /** @type {any} */ (journey),
      /** @type {any} */ ({ build: { id: 'b' }, ready: false, why: 'It never started.' }),
      /** @type {any} */ ({}),
    );
    assert.equal(observations.length, 1, 'the shape this test is about is one refusal and nothing else');
    assert.equal(observations[0].meta?.refused, true);
    assert.match(String(observations[0].meta?.describe), /was not tried/);

    const one = walkFromCapture(
      /** @type {any} */ ({ journey: 'GET /reports', startedAt: '2026-08-31T00:00:00.000Z', build: { id: 'b' }, observations }),
      /** @type {any} */ (journey),
    );
    assert.equal(one.doorAddresses, undefined, 'nothing knocked, so nothing may be recorded as knocked on');
    assert.equal(one.doors, undefined);
    assert.deepEqual(one.notTried, ['GET /reports'], 'and it must be named rather than quietly dropped');

    const led = buildLedger({
      product: 'shop', doors: [routeDoor('/reports', 'GET')], walks: [one],
      byChannel: {}, captures: 1, builds: 1, at: 'fixed',
    });
    const coverage = toCoverage(led);
    assert.equal(coverage.doorsKnown, 1);
    assert.equal(coverage.doorsWalked, 0, 'the server never started; a report cannot say one of its doors was walked');
    assert.match(led.entries[0].how, /Nothing has ever opened it/);
    // The two numbers agreeing is the point, but the reason has to be readable too.
    assert.ok(
      led.caveats.some((c) => /never tried at all/.test(c) && c.includes('GET /reports')),
      `the door stopped being counted as walked and nothing said why:\n${led.caveats.join('\n')}`,
    );
    await cleanUp();
  });

  test('a refusal recorded at a door is not evidence the door was opened', () => {
    // The refusal is written at the address it would have looked at. Left in the walked set,
    // the note saying "we did not look here" became the proof that we did.
    const touched = addressesTouched(/** @type {any} */ ([
      { path: 'ipc.session.save', channel: 'results', value: 1, meta: { refused: true, refusedWhy: 'it spends money' } },
      { path: 'ipc.session.load', channel: 'results', value: 1 },
    ]));
    assert.equal(touched.paths.includes('ipc.session.save'), false, 'a refusal must never fill in for an answer');
    assert.equal(touched.paths.includes('ipc.session.load'), true, 'and a real answer still has to count');
    // It was written down, so it is still counted as something written down.
    assert.equal(touched.byChannel.results, 2);
  });

  test('a journey that really did run still opens its doors', () => {
    // The guard above must not become "refuse everything". A capture with one refusal beside
    // real observations is a journey that ran, and its steps opened what they knocked on.
    const journey = { steps: [{ act: 'request', method: 'GET', door: '/reports', kind: 'route', doorDetail: 'GET' }] };
    const one = walkFromCapture(
      /** @type {any} */ ({
        journey: 'GET /reports',
        startedAt: '2026-08-31T00:00:00.000Z',
        build: { id: 'b' },
        observations: [
          { path: 'api.GET /reports.status', channel: 'results', value: 200 },
          { path: 'net.GET /reports.reached out', channel: 'effects', value: 'stopped', meta: { refused: true } },
        ],
      }),
      /** @type {any} */ (journey),
    );
    assert.deepEqual(one.doorAddresses, ['route.GET./reports']);
    assert.equal(one.notTried, undefined);
  });
});

describe('a route that refused the call is not a route that was walked', () => {
  /**
   * One request, described the way the adapter describes a real one.
   *
   * @param {object} input
   * @param {string} input.method
   * @param {number} input.status
   * @param {string} [input.text]
   * @param {any} [input.body]     What the tool sent, when it sent anything.
   */
  const walk = ({ method, status, text = '{}', body }) =>
    describeRequest({
      journey: /** @type {any} */ ({ name: `${method} /api/quote`, describe: `ask for ${method} /api/quote` }),
      detail: /** @type {any} */ ({ method, route: '/api/quote', url: '/api/quote', unfilled: [], body }),
      answer: /** @type {any} */ ({
        status,
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
      text,
      failure: null,
      ms: 4,
      changes: [],
      reachedOut: [],
      footprint: { dirs: [] },
    });

  // Measured 2026-08-31 on a small quote API. The source says a route's address and its verb
  // and nothing about the body it takes, so POST /api/quote was asked with no body, answered
  // 400 correctly, and the 400 was written down as the route's behaviour. Every later run
  // compared 400 against 400, agreed, and the ledger presented the route as walked — while the
  // arithmetic that decides what a customer is charged had never once run.
  test('a POST refused for having no body is a hole, not the route answering', () => {
    const out = walk({ method: 'POST', status: 400, text: '{"error":"qty and unitPrice are required numbers"}' });
    assert.equal(out.find((o) => o.path === 'api.POST /api/quote.status'), undefined,
      'the 400 is this tool being turned away, and must not be stored as what the route does');
    const hole = out.find((o) => o.path === 'api.POST /api/quote.answered at all');
    assert.ok(hole, 'and it has to be recorded as a door found and not opened');
    assert.equal(hole.meta?.refused, true);
    assert.match(String(hole.meta?.describe), /not really walked/);
    assert.match(String(hole.meta?.describe), /qty and unitPrice/, 'what the route said is the fastest way to fix it');
    assert.match(String(hole.meta?.describe), /"requests"/, 'and it has to say where to put the body');
  });

  test('nothing at all is left un-refused, so the ledger counts the door as never tried', () => {
    const out = walk({ method: 'POST', status: 400 });
    const real = out.filter((o) => o.channel !== 'contract' && o.meta?.refused !== true);
    assert.deepEqual(real, [], 'one plain observation here would put the route back in the walked column');
    const walked = walkFromCapture(
      /** @type {any} */ ({ journey: 'POST /api/quote', observations: out, build: { id: 'b' } }),
      /** @type {any} */ ({ steps: [{ door: '/api/quote', kind: 'route', doorDetail: 'POST' }] }),
    );
    assert.deepEqual(walked.notTried, ['POST /api/quote']);
    assert.equal(walked.doorAddresses, undefined, 'it must not be counted as a door this walk opened');
  });

  test('a 400 to a body somebody wrote themselves is the product answering, and is compared', () => {
    const out = walk({ method: 'POST', status: 400, body: { qty: 'not a number' } });
    const status = out.find((o) => o.path === 'api.POST /api/quote.status');
    assert.ok(status, 'the request was properly formed, so what came back is a real observation');
    assert.equal(status.value, 400);
  });

  test('a GET that answers 400 is untouched, and so is a POST that answers 200', () => {
    const get = walk({ method: 'GET', status: 400 });
    assert.equal(get.find((o) => o.path === 'api.GET /api/quote.status')?.value, 400);
    const ok = walk({ method: 'POST', status: 200 });
    assert.equal(ok.find((o) => o.path === 'api.POST /api/quote.status')?.value, 200);
  });

  test('401 is left alone, because "you are not signed in" is a different hole with a different fix', () => {
    const out = walk({ method: 'POST', status: 401 });
    assert.equal(out.find((o) => o.path === 'api.POST /api/quote.status')?.value, 401);
  });
});
