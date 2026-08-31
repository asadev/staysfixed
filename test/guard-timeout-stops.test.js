/**
 * A guard the run has given up on has to actually stop.
 *
 * The timeout is a `Promise.race`, and losing a race does not stop the loser. Measured on
 * 2026-08-31: a guard with `timeoutMs: 200`, ticking every 25 milliseconds, had written 7
 * lines to a file by the time the run reported it — and 26 half a second later. It was still
 * clicking, still reading, still holding the page, behind a run that had printed its verdict
 * and started the guard after it. That is how one slow guard makes the next three wobble,
 * and the wobble gets blamed on the product.
 *
 * A promise cannot be taken back. What can be shut is every door the guard reaches the app
 * through, which is what these tests hold in place: the body unwinds at its next step, a
 * command it started is killed rather than orphaned, and nothing is said on its behalf after
 * the verdict has been printed.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runGuards } from '../src/guard/run.js';
import { makeGuardApi, GuardAbandoned } from '../src/guard/api.js';

/** @type {string[]} */
const made = [];

/** A throwaway folder outside the repo — nothing here is ever written inside it. */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-timeout-'));
  made.push(dir);
  return dir;
}

after(async () => {
  for (const dir of made) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** A page that answers instantly, so these tests measure the runner and nothing else. */
const fakeApp = () => /** @type {any} */ ({
  page: { goto: async () => {}, consoleErrors: () => [], clearConsole: () => {}, exists: async () => true },
});

/** @param {string} root */
const projectAt = (root) => /** @type {any} */ ({
  config: { app: { kind: 'web', url: 'http://127.0.0.1:1' } },
  paths: { root },
});

/** @param {number} ms */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('a guard that runs out of time', () => {
  test('stops, instead of carrying on behind the run that gave up on it', async () => {
    const dir = scratch();
    const ledger = path.join(dir, 'ticks.log');
    fs.writeFileSync(ledger, '');

    const keepsGoing = {
      name: 'the basket still empties after checkout',
      because: 'Checking out twice used to leave the old basket behind.',
      timeoutMs: 200,
      /** @param {any} app */
      async run(app) {
        for (let i = 0; i < 60; i++) {
          await wait(25);
          await app.expect(`tick ${i}`, async () => {
            fs.appendFileSync(ledger, `tick ${i}\n`);
            return true;
          });
        }
      },
    };

    const [result] = /** @type {any[]} */ (await runGuards(projectAt(dir), fakeApp(), [keepsGoing], {}));
    assert.equal(result.timedOut, true);
    const whenReported = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length;
    assert.ok(whenReported > 0, 'the guard has to have been running, or this proves nothing');

    // Long enough for twenty more ticks, if anything were still ticking.
    await wait(500);
    const later = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length;
    assert.equal(
      later,
      whenReported,
      `the guard was still running after the run reported it: ${whenReported} ticks then, ${later} now`,
    );
  });

  test('does not claim its body was left running, because it was not', async () => {
    const dir = scratch();
    const stuck = {
      name: 'the receipt still prints one line per item',
      because: 'Receipts used to collapse duplicate items into one line.',
      timeoutMs: 150,
      /** @param {any} app */
      async run(app) {
        await wait(2000);
        await app.expect('the receipt has one line per item', async () => true);
      },
    };
    const [result] = /** @type {any[]} */ (await runGuards(projectAt(dir), fakeApp(), [stuck], {}));
    assert.doesNotMatch(result.message, /left going/);
    assert.match(result.message, /cut off/);
    // And it still refuses to be read as a returned bug, which is the older fix this sits on.
    assert.doesNotMatch(result.message, /This should still be true, and it is not/);
  });

  test('says nothing on its own behalf after the verdict has been printed', async () => {
    // A step arriving after the guard is reported reads, to anything watching, as a guard
    // that is still going — and it lands in the list of whichever guard is running now.
    const dir = scratch();
    /** @type {{at: number, label: string}[]} */
    const steps = [];
    let reportedAt = Number.POSITIVE_INFINITY;

    const chatty = {
      name: 'the sidebar still collapses',
      because: 'The collapse arrow left the sidebar half open.',
      timeoutMs: 200,
      /** @param {any} app */
      async run(app) {
        for (let i = 0; i < 40; i++) {
          await wait(25);
          await app.expect(`still going ${i}`, async () => true);
        }
      },
    };

    await runGuards(projectAt(dir), fakeApp(), [chatty], {
      onResult: () => {
        reportedAt = Date.now();
      },
      events: /** @type {any} */ ({
        emit: (/** @type {any} */ ev) => {
          if (ev.type === 'guard:step') steps.push({ at: Date.now(), label: String(ev.step?.label ?? '') });
        },
        on: () => () => {},
        elapsed: () => 0,
        history: () => [],
      }),
    });

    await wait(400);
    const afterwards = steps.filter((s) => s.at > reportedAt + 5);
    assert.deepEqual(afterwards, [], `steps were still being announced after the verdict: ${JSON.stringify(afterwards)}`);
  });
});

describe('the object a guard is handed', () => {
  test('refuses every door once the run has given up', async () => {
    const dir = scratch();
    const stop = new AbortController();
    const api = makeGuardApi(/** @type {any} */ (fakeApp().page), projectAt(dir), { signal: stop.signal });
    stop.abort();

    await assert.rejects(() => api.open('/'), GuardAbandoned);
    await assert.rejects(() => api.click('#save'), GuardAbandoned);
    await assert.rejects(() => api.expect('the page is there', async () => true), GuardAbandoned);
    await assert.rejects(() => api.read('package.json'), GuardAbandoned);
    // Never even started, so a guard the run has finished with cannot leave a process behind.
    await assert.rejects(() => api.run('node --version'), GuardAbandoned);
    // `app.page` is documented as "the whole page", so a guard that drives the app itself
    // never passes through the five above — and those were the ones left holding a page.
    await assert.rejects(() => api.page.goto('http://127.0.0.1:1'), GuardAbandoned);
  });

  test('kills a command that was still running when the run gave up', async () => {
    const dir = scratch();
    const marker = path.join(dir, 'it-finished-anyway.txt');
    const script = path.join(dir, 'slow.cjs');
    // Written to a file rather than passed inline: a command with brackets or quotes in it
    // means one thing to `sh` and another to `cmd.exe`, and this has to hold on both.
    fs.writeFileSync(
      script,
      `setTimeout(function () { require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); }, 800);\n`,
    );

    const stop = new AbortController();
    const api = makeGuardApi(/** @type {any} */ (fakeApp().page), projectAt(dir), { signal: stop.signal });
    const running = api.run(`"${process.execPath}" "${script}"`);
    setTimeout(() => stop.abort(), 100);

    await assert.rejects(() => running, GuardAbandoned);
    await wait(1200);
    assert.equal(fs.existsSync(marker), false, 'the command outlived the guard the run had given up on');
  });

  test('with no signal it behaves exactly as it always did', async () => {
    // Nothing is passed when a guard is run outside the runner, and that has to keep working.
    const dir = scratch();
    const api = makeGuardApi(/** @type {any} */ (fakeApp().page), projectAt(dir), {});
    await api.expect('the page is there', async () => true);
    await api.open('/');
    await api.page.goto('http://127.0.0.1:1');
  });
});
