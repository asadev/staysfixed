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

import { httpAdapter } from '../../src/v2/adapters/http.js';
import {
  addressesTouched, buildLedger, doorFact, isAStyleValue, justTheDoors, ledger, sourceFoldersFor,
  toCoverage, walkFromCapture,
} from '../../src/v2/coverage.js';
import { openStore } from '../../src/v2/store.js';
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

// ---------------------------------------------------------------------------
// The denominator
// ---------------------------------------------------------------------------

/**
 * THREE — THE TOTAL WAS DRAWN FROM A SMALLER PRODUCT THAN THE ONE BEING CHECKED.
 *
 * Every reassuring number this tool prints is a fraction of the door count, so a wrong door
 * count is every number wrong at once. Three ways it was wrong were measured on 2026-08-31,
 * on a real Next.js website somebody set up as a stranger would:
 *
 *   - the ledger re-read the source WITHOUT the folders the settings name, so it read 8 of
 *     the project's 20 files and then printed "25 of the 25 doors this product has have
 *     never been walked" — a total taken from a third of the product, offered as the whole;
 *   - eleven CSS custom properties, `--px` and its neighbours, were counted as command-line
 *     flags, so the total included things that are not ways into anything;
 *   - every page was missing from the count altogether, and the two pages behind a changing
 *     address were opened with one sample value each and counted as though the eleven real
 *     pages behind them had been walked.
 *
 * These tests are the guard on all three. They are about the DENOMINATOR, which is the one
 * number that has to be right before any of the others mean anything.
 */
describe('the door count is the product, all of it, and only doors', () => {
  test('the ledger reads the folders the settings name, not the ones it would guess at', async () => {
    const root = await scratchDir('lane-coverage-folders');
    await fsp.mkdir(path.join(root, 'features'), { recursive: true });
    await fsp.mkdir(path.join(root, 'app'), { recursive: true });
    await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'shop' }));
    // `app` is on the reader's own list of usual folders. `features` is not, and that is
    // exactly the shape that went wrong: half the project outside the guessed list.
    await fsp.writeFile(path.join(root, 'app', 'inside.js'), 'export function insideTheUsualFolders() { return 1; }\n');
    await fsp.writeFile(path.join(root, 'features', 'outside.js'), 'export function outsideThem() { return 2; }\n');
    await fsp.writeFile(
      path.join(root, 'staysfixed.config.json'),
      JSON.stringify({ product: 'shop', source: { folders: ['app', 'features'] } }),
    );

    const guessed = await sourceFoldersFor(root, undefined);
    assert.deepEqual(guessed.folders, ['app', 'features'], 'the settings are the answer, and they were not being asked');
    assert.equal(guessed.why, '', 'nothing to apologise for when the settings could be read');

    const led = await ledger(openStore({ root }), 'shop', { root });
    const names = led.entries.map((e) => e.name);
    assert.ok(names.includes('outsideThem'), `a door outside the guessed folders is missing from the ledger:\n${names.join(', ')}`);
    assert.ok(names.includes('insideTheUsualFolders'));
    assert.ok(
      led.caveats.some((c) => c.includes('files in app, features')),
      `the ledger has to say WHICH folders its total came from:\n${led.caveats.join('\n')}`,
    );
    await cleanUp();
  });

  test('with no settings to read, it says the total may be smaller than the product', async () => {
    const root = await scratchDir('lane-coverage-no-settings');
    await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'shop' }));
    const answer = await sourceFoldersFor(root, undefined);
    assert.equal(answer.folders, undefined);
    assert.match(answer.why, /no Stays Fixed settings file/i);
    assert.match(answer.why, /not in this ledger|doors that are not/i);
  });

  test('a CSS custom property is not a command, and leaving it out is said out loud', () => {
    const styleValue = doorFact(/** @type {any} */ ({
      kind: 'command', name: '--px', detail: 'a flag this file mentions',
      file: 'components/Price.tsx', line: 2, inTest: false, named: true, via: 'literal',
    }));
    const realFlag = doorFact(/** @type {any} */ ({
      kind: 'command', name: '--dry-run', detail: 'a flag this file mentions',
      file: 'src/cli.js', line: 40, inTest: false, named: true, via: 'literal',
    }));
    assert.equal(isAStyleValue(styleValue), true);
    assert.equal(isAStyleValue(realFlag), false, 'a flag in a program is a real door and dropping it would be the silence this tool exists to prevent');

    const only = justTheDoors([styleValue, realFlag]);
    assert.deepEqual(only.doors.map((d) => d.name), ['--dry-run']);
    assert.equal(only.styleValues.length, 1);

    const led = buildLedger({
      product: 'shop', doors: only.doors, walks: [], byChannel: {}, captures: 0, builds: 1, at: 'fixed',
    });
    assert.equal(led.doors, 1, 'a style value in the total makes the product look bigger than it is');
    void led;
  });

  test('the same door mentioned in four files is one door, the way the contract channel already counts it', () => {
    const mentions = ['a.js', 'b.js', 'c.js', 'd.js'].map((file) =>
      doorFact(/** @type {any} */ ({ kind: 'env', name: 'NODE_ENV', detail: 'read', file, line: 1, inTest: false, named: true, via: 'literal' })),
    );
    const only = justTheDoors(mentions);
    assert.equal(only.doors.length, 1, 'a setting read in four files is one setting');
    assert.equal(only.folded, 3);

    // And two doors that only LOOK alike stay two. GET and POST on one path are two doors,
    // and folding them would be the ledger lying in the direction it must never lie in.
    const both = justTheDoors([routeDoor('/basket', 'GET'), routeDoor('/basket', 'POST')]);
    assert.equal(both.doors.length, 2);
    assert.equal(both.folded, 0);
  });

  test('a page opened with one sample value is one page opened, and the ledger says which address', () => {
    // The step the HTTP adapter writes when a sample value filled the gap in an address.
    const journey = {
      steps: [{ act: 'request', method: 'GET', route: '/blog/[slug]', url: '/blog/hello-world', unfilled: [], door: '/blog/[slug]', kind: 'route', doorDetail: 'GET' }],
    };
    const one = walkFromCapture(
      /** @type {any} */ ({
        journey: 'GET /blog/[slug]', startedAt: '2026-08-31T00:00:00.000Z', build: { id: 'b' },
        observations: [{ path: 'api.GET /blog/[slug].status', channel: 'results', value: 200 }],
      }),
      /** @type {any} */ (journey),
    );
    assert.deepEqual(one.sampledAt, [{ door: 'route.GET./blog/[slug]', at: '/blog/hello-world' }]);

    const led = buildLedger({
      product: 'shop', doors: [routeDoor('/blog/[slug]', 'GET'), routeDoor('/about', 'GET')],
      walks: [one], byChannel: {}, captures: 1, builds: 1, at: 'fixed',
    });
    const family = led.entries.find((e) => e.name === '/blog/[slug]');
    assert.ok(family);
    assert.equal(family.state, 'opened', 'one address really was opened, and saying otherwise would be its own lie');
    assert.equal(family.sampled, true, 'and it must never read as the whole family being covered');
    assert.equal(family.openedAt, '/blog/hello-world');
    assert.match(family.how, /one address, \/blog\/hello-world/);
    assert.equal(led.sampled, 1);
    assert.ok(
      led.caveats.some((c) => /changing part in the address/.test(c) && c.includes('/blog/hello-world')),
      `the one-value opening has to be disclosed, not inferred:\n${led.caveats.join('\n')}`,
    );

    // And it has to survive into the list a person and an agent actually read.
    const gap = toCoverage(led).gaps.find((g) => /opened at one value/.test(g.what));
    assert.ok(gap, 'the disclosure never reached the coverage list, which is the only place anybody reads it');
    assert.equal(gap.doors, undefined, 'a doors count here folds this line into the door arithmetic and deletes it from the summary');
  });

  test('a door with a gap nobody filled is still a door nothing opened', () => {
    // The other half of the same rule. A step that was refused for want of a value opened
    // nothing at all, and must not be dressed up as "opened at one address".
    const journey = {
      steps: [{ act: 'request', method: 'GET', route: '/blog/[slug]', url: '/blog/[slug]', unfilled: ['slug'], door: '/blog/[slug]', kind: 'route', doorDetail: 'GET' }],
    };
    const one = walkFromCapture(
      /** @type {any} */ ({
        journey: 'GET /blog/[slug]', startedAt: '2026-08-31T00:00:00.000Z', build: { id: 'b' },
        observations: [{ path: 'api.GET /blog/[slug].status', channel: 'results', value: 200, meta: { refused: true } }],
      }),
      /** @type {any} */ (journey),
    );
    assert.equal(one.sampledAt, undefined);
    const led = buildLedger({
      product: 'shop', doors: [routeDoor('/blog/[slug]', 'GET')], walks: [one],
      byChannel: {}, captures: 1, builds: 1, at: 'fixed',
    });
    assert.equal(led.sampled, 0);
    assert.equal(led.opened, 0, 'nothing was asked for, so nothing was opened');
  });
});
