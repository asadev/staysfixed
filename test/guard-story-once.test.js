/**
 * The story of the bug a guard watches is said once, in one place.
 *
 * Measured on 2026-08-31. A guard that genuinely failed rendered like this:
 *
 *     X  the delivery note still shows   This should still be true, and it is not: "...".
 *
 *     Why this guard exists: The delivery note vanished for two days after a template change. 1ms
 *         expected: the delivery note is on the page
 *         why this guard exists: The delivery note vanished for two days after a template change.
 *
 * Twice, because the runner appended it to `message` and every renderer prints `because`
 * itself — and the blank line it appended pushed the duration into the middle of a sentence
 * and put a newline inside a value that is also a cell in the results table.
 *
 * The story is not printed at all under a guard that ran out of time: it is there to say
 * whether a failure matters, and a timeout says nothing about the bug, so printing it under
 * a red line is read as that bug being back.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runGuards } from '../src/guard/run.js';
import { printGuardResult, printRunSummary } from '../src/report/console.js';
import { writeRunReport } from '../src/report/html.js';

/** @type {string[]} */
const made = [];
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-story-'));
  made.push(dir);
  return dir;
}
after(async () => {
  for (const dir of made) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
});

const fakeApp = () => /** @type {any} */ ({
  page: { goto: async () => {}, consoleErrors: () => [], clearConsole: () => {}, exists: async () => true },
});
const project = /** @type {any} */ ({
  config: { app: { kind: 'web', url: 'http://127.0.0.1:1' } },
  paths: { root: os.tmpdir() },
});

/**
 * Everything printed while `show` ran, with the colour taken out.
 * @param {() => void} show
 * @returns {string}
 */
function rendered(show) {
  let out = '';
  const real = process.stdout.write.bind(process.stdout);
  /** @type {any} */ (process.stdout).write = (/** @type {any} */ chunk) => {
    out += String(chunk);
    return true;
  };
  try {
    show();
  } finally {
    /** @type {any} */ (process.stdout).write = real;
  }
  return out.replace(/\x1b\[\d+m/g, '');
}

/** @param {string} haystack @param {string} needle */
function times(haystack, needle) {
  return haystack.toLowerCase().split(needle.toLowerCase()).length - 1;
}

const STORY = 'The delivery note vanished for two days after a template change.';

const broken = {
  name: 'the delivery note still shows',
  because: STORY,
  timeoutMs: 2000,
  /** @param {any} app */
  async run(app) {
    await app.expect('the delivery note is on the page', async () => false);
  },
};

const stuck = {
  name: 'the basket still empties after checkout',
  because: 'Checking out twice used to leave the old basket behind.',
  timeoutMs: 120,
  /** @param {any} app */
  async run(app) {
    await new Promise((r) => setTimeout(r, 3000));
    await app.expect('the basket is empty', async () => true);
  },
};

const empty = {
  name: 'the checkout total is never charged twice',
  because: 'A double click charged two people twice in one afternoon.',
  timeoutMs: 2000,
  async run() {},
};

describe('the story of the bug', () => {
  test('is printed once beside a guard that really did fail', async () => {
    const [result] = /** @type {any[]} */ (await runGuards(project, fakeApp(), [broken], {}));
    const said = rendered(() => printGuardResult(result));
    assert.equal(times(said, 'why this guard exists'), 1, `printed ${times(said, 'why this guard exists')} times:\n${said}`);
    assert.equal(times(said, STORY), 1, `the story itself appears more than once:\n${said}`);
  });

  test('is still carried on the result, and no longer buried in the message', async () => {
    const [result] = /** @type {any[]} */ (await runGuards(project, fakeApp(), [broken], {}));
    assert.equal(result.because, STORY, 'the story must not be thrown away');
    assert.doesNotMatch(result.message, /Why this guard exists/);
  });

  test('leaves the message on one line, because it is also a cell in the table', async () => {
    // A message with a newline in it puts its second line in the next column and takes the
    // results table apart — the lesson `plainly()` in src/guard/run.js is built around.
    const [result] = /** @type {any[]} */ (await runGuards(project, fakeApp(), [broken], {}));
    assert.ok(!result.message.includes('\n'), `the message still has a newline in it: ${JSON.stringify(result.message)}`);

    const table = rendered(() => printRunSummary(/** @type {any} */ ({ pictures: [], guards: [result], durationMs: 5 })));
    for (const line of table.split('\n')) {
      assert.ok(line.length < 400, `one line of the summary ran to ${line.length} characters`);
    }
  });

  test('is not printed under a guard that only ran out of time', async () => {
    const [result] = /** @type {any[]} */ (await runGuards(project, fakeApp(), [stuck], {}));
    assert.equal(result.timedOut, true);
    const said = rendered(() => printGuardResult(result));
    assert.equal(times(said, 'why this guard exists'), 0, `it implies the bug is back:\n${said}`);
    assert.ok(!said.includes(stuck.because), `the story was printed under a timeout:\n${said}`);
  });

  test('is printed once in the HTML report, and not at all for a timeout', async () => {
    const dir = scratch();
    const reportFile = path.join(dir, 'report.html');
    const [back] = /** @type {any[]} */ (await runGuards(project, fakeApp(), [broken], {}));
    const [never] = /** @type {any[]} */ (await runGuards(project, fakeApp(), [stuck], {}));
    await writeRunReport(
      /** @type {any} */ ({ paths: { reportFile, root: dir, configFile: path.join(dir, 'staysfixed.config.js') } }),
      /** @type {any} */ ({ pictures: [], guards: [back, never], durationMs: 10 }),
    );
    const html = await fsp.readFile(reportFile, 'utf8');
    assert.equal(times(html, STORY), 1, 'the story is in the page more than once');
    assert.ok(!html.includes(stuck.because), 'the timed-out guard was given the story of its bug');
  });

  test('an empty guard is told what it was meant to protect, once', async () => {
    const [result] = /** @type {any[]} */ (await runGuards(project, fakeApp(), [empty], {}));
    assert.equal(result.assertedNothing, true);
    const said = rendered(() => printGuardResult(result));
    assert.equal(times(said, empty.because), 1, `said ${times(said, empty.because)} times:\n${said}`);
    assert.doesNotMatch(result.message, /A double click charged/);
  });
});
