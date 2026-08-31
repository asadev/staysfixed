/**
 * A session somebody actually performed, replayed on every later check.
 *
 * This is the only channel in the tool that can learn how a person really uses a product.
 * Every other one reads: routes out of the source, exported names out of a package, screens
 * out of a router. Reading finds what the code SAYS it does, and it is blind to which four
 * doors somebody opens every morning and in which order. Until 2026-08-31 the recording code
 * existed and nothing on the check path called it, so asking for `--journeys recorded` threw
 * and the README said so out loud.
 *
 * What is held here is the whole of what makes it safe to switch on.
 *
 * THE FALSE ALL-CLEAR THIS FEATURE COULD HAVE SHIPPED. A person clicks a link and the
 * browser goes somewhere. Writing both down — click the link, then open that address —
 * produces a journey that opens the second page whether or not the link still works. Break
 * the button and the replay walks straight past it and comes back clean. That is the one
 * answer this tool may never give, and the first three tests below are about it.
 *
 * THE FRONT DOOR RULE, AT BIRTH. A recording is walked twice against the same build before a
 * byte of it reaches a file, and anything that differs between those two walks is thrown
 * away rather than saved. A journey that argues with itself goes red on somebody else's
 * laptop for no reason, and a check nobody trusts is worse than no check at all.
 *
 * And the end-to-end proof: on a two-page site, breaking the second page is completely
 * invisible to the journeys read out of the code — the run says "nothing that worked has
 * changed" — and the recorded session catches it. That contrast is the entire argument for
 * the feature, so it is checked rather than described.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { check } from '../../src/v2/check.js';
import { loadPlaywright } from '../../src/v2/adapters/web-driver.js';
import {
  RECORD_COMMANDS, acceptIfItRepeats, addressToWalk, dropNavigationsCausedByAnAct, recordAJourney,
  run as recordCommand, slug, webStepsFrom,
} from '../../src/v2/journeys/record-session.js';
import { loadJourneys } from '../../src/v2/journeys/record.js';
import { scratchDir, cleanUp } from '../support.mjs';

const run = promisify(execFile);

after(cleanUp);

/** One browser answer for the whole file: opening one costs seconds, and asking twice proves nothing. */
const browser = await loadPlaywright({});
const NO_BROWSER = browser.ok ? false : `No browser this tool can drive on this machine, so a session cannot be recorded here. ${browser.why}`;

// ---------------------------------------------------------------------------
// What survives from a session, and what must not
// ---------------------------------------------------------------------------

describe('turning what somebody did into steps', () => {
  test('the page move a click caused is NOT written down as a step of its own', () => {
    const steps = webStepsFrom(
      [
        { act: 'navigate', target: 'http://127.0.0.1:5000/', at: 0 },
        { act: 'click', target: 'role=link[name="Open the orders list"]', at: 400 },
        { act: 'navigate', target: 'http://127.0.0.1:5000/orders', at: 460 },
      ],
      { baseUrl: 'http://127.0.0.1:5000' },
    ).steps;

    assert.deepEqual(
      steps.map((s) => s.act),
      ['open', 'click'],
      'a `goto /orders` here would open the second page whether or not the link still works, so a broken button would come back clean',
    );
    assert.equal(steps[0].goto, '/');
    assert.equal(steps[1].click, 'role=link[name="Open the orders list"]');
  });

  test('an address somebody went to themselves, long after the last click, is kept', () => {
    const events = [
      { act: 'navigate', target: 'http://127.0.0.1:5000/', at: 0 },
      { act: 'click', target: '#go', at: 400 },
      { act: 'navigate', target: 'http://127.0.0.1:5000/orders', at: 460 },
      { act: 'navigate', target: 'http://127.0.0.1:5000/settings', at: 30000 },
    ];
    const kept = dropNavigationsCausedByAnAct(events).filter((e) => e.act === 'navigate');
    assert.deepEqual(kept.map((e) => e.target), ['http://127.0.0.1:5000/', 'http://127.0.0.1:5000/settings']);
  });

  test('the port is never baked into a step, because the next boot gets a different one', () => {
    assert.equal(addressToWalk('http://127.0.0.1:53119/orders?open=1', 'http://127.0.0.1:53119'), '/orders?open=1');
    // Somewhere else entirely is kept whole. It is not this product, and shortening it to a
    // path would silently point the step back at this product's own address.
    assert.equal(addressToWalk('https://example.com/pay', 'http://127.0.0.1:53119'), 'https://example.com/pay');
  });

  test('a password typed during a session never reaches the steps', () => {
    const built = webStepsFrom(
      [
        { act: 'navigate', target: 'http://localhost:3000/', at: 0 },
        { act: 'type', target: 'role=textbox[name="password"]', value: 'hunter2-for-real', at: 100 },
        { act: 'click', target: 'role=button[name="Sign in"]', at: 200 },
      ],
      { baseUrl: 'http://localhost:3000' },
    );
    const typed = built.steps.find((s) => s.act === 'type');
    assert.ok(typed);
    assert.equal(typed.text, '<hidden>');
    assert.equal(built.hidden, 1);
    assert.ok(JSON.stringify(built.steps).includes('hunter2') === false, 'the real password may not be anywhere in the file');
  });

  test('a name becomes something that can be a file, a folder and an address', () => {
    assert.equal(slug('The Morning Round!'), 'the-morning-round');
    assert.equal(slug('  signing in  '), 'signing-in');
  });
});

// ---------------------------------------------------------------------------
// Rejected at birth
// ---------------------------------------------------------------------------

/**
 * A journey with one act in it, which is the smallest thing worth replaying.
 * @param {string} name
 * @returns {import('../../src/v2/types.js').Journey}
 */
function aJourney(name = 'the-morning-round') {
  return {
    name,
    describe: 'a recorded session: click the link called "Open the orders list"',
    source: 'recorded',
    surface: 'web',
    steps: [
      { act: 'open', goto: '/' },
      { act: 'click', click: 'role=link[name="Open the orders list"]' },
    ],
  };
}

/**
 * One walk's worth of what a product said, in the shape the engine compares.
 *
 * @param {{journey: string, run: string, saw: Record<string, string>, couldNotWalk?: string}} input
 * @returns {import('../../src/v2/types.js').Capture}
 */
function aWalk(input) {
  /** @type {import('../../src/v2/types.js').Observation[]} */
  const observations = Object.entries(input.saw).map(([where, value]) => ({
    path: where,
    channel: /** @type {const} */ ('meaning'),
    value,
    meta: { describe: `${where} said ${value}` },
  }));
  if (input.couldNotWalk) {
    observations.push({
      path: `screen.${input.journey}.finished`,
      channel: 'meaning',
      value: 'not checked — it did not finish in the time allowed',
      meta: { describe: input.couldNotWalk, refused: true, refusedWhy: 'it did not finish in the time allowed (timed out)' },
    });
  }
  return {
    id: `walk-${input.run}`,
    journey: input.journey,
    build: { id: 'one-and-the-same-build', product: 'two-pager' },
    run: /** @type {any} */ (input.run),
    startedAt: '2026-08-31T10:00:00.000Z',
    durationMs: 10,
    observations,
    coverage: { paths: observations.length, journeys: 1, byChannel: {}, gaps: [] },
    complete: true,
  };
}

const ONE_BUILD = { id: 'one-and-the-same-build', product: 'two-pager', surface: /** @type {const} */ ('web') };

describe('a recording is walked twice before it is ever kept', () => {
  test('two walks that agree about what exists is what "accepted" means, and it says how', async () => {
    const journey = aJourney();
    const verdict = await acceptIfItRepeats({
      journey,
      build: ONE_BUILD,
      walk: async (req) => aWalk({ journey: journey.name, run: req.run, saw: { 'screen.end.heading': 'Orders' } }),
    });
    assert.equal(verdict.accepted, true, verdict.why.join(' '));
    assert.match(verdict.how, /walked twice/i);
    assert.ok(verdict.journey.reproducible, 'an accepted recording carries the proof that it repeats');
  });

  test('a session that turns up something on one walk and not the other is refused', async () => {
    const journey = aJourney();
    const verdict = await acceptIfItRepeats({
      journey,
      build: ONE_BUILD,
      walk: async (req) =>
        aWalk({
          journey: journey.name,
          run: req.run,
          saw: req.run === 'a'
            ? { 'screen.end.heading': 'Orders' }
            : { 'screen.end.heading': 'Orders', 'screen.end.banner': 'Two people are looking at this' },
        }),
    });
    assert.equal(verdict.accepted, false);
    assert.ok(
      verdict.why.some((line) => /disagreed about what exists|argues with itself/i.test(line)),
      `it has to say the two walks disagreed: ${verdict.why.join(' | ')}`,
    );
  });

  test('a session that could not be walked through even once is refused, not called steady', async () => {
    // Both walks fail in exactly the same way, so the repeat check on its own would call this
    // perfectly reproducible. It is not: nothing was ever checked, and keeping it would put a
    // journey in every later run that reports a hole for ever.
    const journey = aJourney();
    const verdict = await acceptIfItRepeats({
      journey,
      build: ONE_BUILD,
      walk: async (req) =>
        aWalk({
          journey: journey.name,
          run: req.run,
          saw: { 'screen.end.heading': 'Front desk' },
          couldNotWalk: '"the morning round" did not finish. It got as far as: opened /',
        }),
    });
    assert.equal(verdict.accepted, false);
    assert.ok(
      verdict.why.some((line) => /did not get through the steps/i.test(line)),
      `it has to say the steps were never walked: ${verdict.why.join(' | ')}`,
    );
  });

  test('a session holding this afternoon\'s port is refused before anything is even walked', async () => {
    let walks = 0;
    const journey = aJourney();
    journey.steps = [{ act: 'open', goto: 'http://127.0.0.1:53119/orders' }, { act: 'click', click: '#go' }];
    const verdict = await acceptIfItRepeats({
      journey,
      build: ONE_BUILD,
      walk: async (req) => {
        walks += 1;
        return aWalk({ journey: journey.name, run: req.run, saw: {} });
      },
    });
    assert.equal(verdict.accepted, false);
    assert.equal(walks, 0, 'nothing should be booted to find out something that can be read');
    assert.ok(verdict.why.some((line) => /port number/i.test(line)), verdict.why.join(' | '));
  });
});

// ---------------------------------------------------------------------------
// Asking for recorded sessions when there are none
// ---------------------------------------------------------------------------

describe('asking for recorded sessions by name', () => {
  test('a project with no recordings is told so, and never comes back clean', async () => {
    const dir = await scratchDir('staysfixed-no-recordings');
    await fsp.writeFile(
      path.join(dir, 'staysfixed.config.json'),
      `${JSON.stringify({ product: 'nothing-recorded', web: { start: 'node server.js' } }, null, 2)}\n`,
    );
    const outcome = await check({ cwd: dir, journeys: 'recorded', only: [] });

    assert.equal(outcome.blocked, true, 'a run that checked nothing is not an answer');
    assert.equal(outcome.ok, false);
    assert.match(outcome.summary, /recorded sessions and there are none/i);
    assert.match(outcome.summary, /staysfixed record/, 'it has to say how to make one');
  });
});

// ---------------------------------------------------------------------------
// The command a person types
// ---------------------------------------------------------------------------

/**
 * A command line context, the shape src/cli/index.js builds.
 *
 * @param {{args?: string[], cwd: string, flags?: Record<string, any>}} input
 * @returns {any}
 */
function typed(input) {
  const flags = input.flags ?? {};
  return {
    args: input.args ?? [],
    flags,
    passthrough: [],
    cwd: input.cwd,
    configFile: undefined,
    version: 'test',
    bool: (/** @type {string} */ name) => flags[name] === true,
    str: (/** @type {string} */ name) => (typeof flags[name] === 'string' ? flags[name] : undefined),
    list: () => [],
  };
}

describe('staysfixed record, as a person types it', () => {
  test('it is a real command with the flags its help promises', () => {
    assert.ok(RECORD_COMMANDS.record.load, 'a command that is listed and not wired up is worse than one that is missing');
    const declared = RECORD_COMMANDS.record.options.map(([flag]) => flag.replace(/^--/, '').split(/[ <]/)[0]);
    const known = new Set([...(RECORD_COMMANDS.record.spec.booleans ?? []), ...(RECORD_COMMANDS.record.spec.strings ?? [])]);
    for (const flag of declared) assert.ok(known.has(flag), `--${flag} is documented and the parser does not know it`);
  });

  test('with no name it says what to type, rather than recording something nobody can find again', async () => {
    const dir = await scratchDir('staysfixed-record-cli');
    await assert.rejects(recordCommand(typed({ cwd: dir })), /needs a name/i);
  });

  test('in a project with no web app it says so before it opens anything', async () => {
    const dir = await scratchDir('staysfixed-record-cli');
    await fsp.writeFile(path.join(dir, 'staysfixed.config.json'), `${JSON.stringify({ product: 'nothing-here' }, null, 2)}\n`);
    await assert.rejects(recordCommand(typed({ args: ['signing-in'], cwd: dir })), /nothing to record against/i);
  });
});

// ---------------------------------------------------------------------------
// End to end, on a real product, in a real browser
// ---------------------------------------------------------------------------

const FRONT_DESK = `<!doctype html><html><head><title>Front desk</title></head><body>
    <h1>Front desk</h1>
    <p>Everything starts here.</p>
    <a id="go" href="/orders">Open the orders list</a>
  </body></html>`;

/**
 * A two-page site whose second page nothing can find by reading the source.
 *
 * The pages are strings inside one file, so no folder name anywhere says that /orders
 * exists. That is not a trick to make the test pass: it is the ordinary case for every
 * product whose routes are not spelled out in its folder names, and it is exactly the shape
 * of hole a recorded session is for.
 *
 * @param {{orders?: string}} [opts]
 * @returns {Promise<string>}
 */
async function twoPageSite(opts = {}) {
  const dir = await fsp.realpath(await scratchDir('staysfixed-recorded'));
  await run('git', ['init', '-q'], { cwd: dir });
  await run('git', ['config', 'user.email', 'test@staysfixed.local'], { cwd: dir });
  await run('git', ['config', 'user.name', 'Stays Fixed test'], { cwd: dir });
  await fsp.writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'two-pager', version: '1.0.0', type: 'module', private: true }, null, 2)}\n`,
  );
  await fsp.writeFile(
    path.join(dir, 'staysfixed.config.json'),
    `${JSON.stringify({ product: 'two-pager', web: { start: 'node server.js', startTimeoutMs: 20000 } }, null, 2)}\n`,
  );
  await writeSite(dir, opts.orders ?? 'Three orders are waiting.');
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['commit', '-qm', 'the build that works'], { cwd: dir });
  return dir;
}

/**
 * @param {string} dir
 * @param {string} sentence   What the orders page says. Changing it is the break.
 * @returns {Promise<void>}
 */
async function writeSite(dir, sentence) {
  const orders = `<!doctype html><html><head><title>Orders</title></head><body>
    <h1>Orders</h1>
    <p>${sentence}</p>
    <a href="/">Back to the front desk</a>
  </body></html>`;
  await fsp.writeFile(
    path.join(dir, 'server.js'),
    [
      "import http from 'node:http';",
      `const PAGES = { '/': ${JSON.stringify(FRONT_DESK)}, '/orders': ${JSON.stringify(orders)} };`,
      "const port = Number(process.env.PORT || 4321);",
      'http.createServer((req, res) => {',
      "  const body = PAGES[new URL(req.url, 'http://localhost').pathname];",
      "  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });",
      "  res.end(body ?? '<!doctype html><html><body><h1>Not here</h1></body></html>');",
      "}).listen(port, '127.0.0.1', () => console.log('up on ' + port));",
      '',
    ].join('\n'),
  );
}

describe('recording a real session and checking with it', { skip: NO_BROWSER }, () => {
  test('the click is kept, the page it landed on is not, and it repeats', async () => {
    const dir = await twoPageSite();
    const result = await recordAJourney({
      cwd: dir,
      name: 'the morning round',
      headed: false,
      drive: async (page) => {
        await page.click('#go');
        await page.waitForLoadState('load');
      },
    });

    assert.equal(result.accepted, true, result.why.join(' | '));
    assert.equal(result.name, 'the-morning-round');
    assert.deepEqual(
      (result.journey.steps ?? []).map((s) => s.act),
      ['open', 'click'],
      `the page the click landed on must not be a step of its own: ${JSON.stringify(result.journey.steps)}`,
    );
    assert.match(String(result.journey.steps?.[1].click), /Open the orders list/);

    // It is on the disk, under the folder a check reads, in the format a check reads.
    const read = await loadJourneys(path.join(dir, '.staysfixed', 'journeys', 'the-morning-round.json'));
    assert.deepEqual(read.problems, []);
    assert.equal(read.journeys.length, 1);
    assert.equal(read.journeys[0].source, 'recorded');
  });

  test('opening the product and doing nothing is refused, and nothing is written', async () => {
    const dir = await twoPageSite();
    const result = await recordAJourney({ cwd: dir, name: 'nothing-happened', headed: false, drive: async () => {} });

    assert.equal(result.accepted, false);
    assert.ok(result.why.some((line) => /nothing was done/i.test(line)), result.why.join(' | '));
    await assert.rejects(fsp.stat(path.join(dir, '.staysfixed', 'journeys', 'nothing-happened.json')));
  });

  test('a break the code reader cannot see is caught by the session somebody recorded', async () => {
    const dir = await twoPageSite();
    const recorded = await recordAJourney({
      cwd: dir,
      name: 'the morning round',
      headed: false,
      drive: async (page) => {
        await page.click('#go');
        await page.waitForLoadState('load');
      },
    });
    assert.equal(recorded.accepted, true, recorded.why.join(' | '));
    await run('git', ['add', '-A'], { cwd: dir });
    await run('git', ['commit', '-qm', 'the session everybody walks every morning'], { cwd: dir });
    const working = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();

    // The break. The front page does not change by one character; the second page does, and
    // nothing in the source names that page, so no journey read out of the code opens it.
    await writeSite(dir, 'Something went wrong.');

    const byReading = await check({ cwd: dir, against: working, paired: true, only: [] });
    assert.notEqual(byReading.blocked, true, byReading.summary);
    assert.equal(
      byReading.findings.length,
      0,
      `reading the code cannot see this one, which is the whole reason recordings exist: ${byReading.findings.map((f) => f.title).join(' | ')}`,
    );

    const byWalkingWhatSomebodyDid = await check({ cwd: dir, against: working, paired: true, journeys: 'recorded', only: [] });
    assert.notEqual(byWalkingWhatSomebodyDid.blocked, true, byWalkingWhatSomebodyDid.summary);
    assert.equal(byWalkingWhatSomebodyDid.ok, false, 'the page a person opens every morning changed and nobody asked for it');
    assert.ok(
      byWalkingWhatSomebodyDid.findings.some((f) =>
        /Something went wrong/.test(`${f.title} ${f.differences.map((d) => JSON.stringify(d)).join(' ')}`),
      ),
      `the sentence that changed has to be named: ${byWalkingWhatSomebodyDid.findings.map((f) => f.title).join(' | ')}`,
    );
  });
});
