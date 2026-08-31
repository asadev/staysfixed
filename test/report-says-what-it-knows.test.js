/**
 * The HTML report may only say what the run actually established.
 *
 * "Still looks exactly as approved" has to mean exactly, or it is the most expensive
 * sentence on the page. A picture that differs and is waved through by `tolerance.pixels`
 * was listed in the same words as one that matched byte for byte — the terminal was taught
 * to say this in full on 2026-08-30, after a missing letter in a heading (593 plainly visible
 * pixels) was absorbed by an allowance of 2,592, and the report was not. The same run then
 * said two different things depending on where you read it.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeRunReport } from '../src/report/html.js';

/** @type {string[]} */
const made = [];
after(async () => {
  for (const dir of made) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** @param {any} run */
async function page(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-words-'));
  made.push(dir);
  const reportFile = path.join(dir, 'report.html');
  await writeRunReport(
    /** @type {any} */ ({ paths: { reportFile, root: dir, configFile: path.join(dir, 'staysfixed.config.js') } }),
    /** @type {any} */ ({ durationMs: 10, tool: '0.0.0', id: 'test', pictures: [], guards: [], ...run }),
  );
  return fsp.readFile(reportFile, 'utf8');
}

describe('a picture a tolerance let through', () => {
  test('is not listed as looking exactly as approved', async () => {
    const html = await page({
      pictures: [{ name: 'checkout', status: 'passed', diffPixels: 593, durationMs: 5 }],
    });
    assert.doesNotMatch(html, /exactly as approved/, 'a 593-pixel difference is not "exactly as approved"');
    assert.match(html, /593 pixels your tolerance allowed/);
    assert.match(html, /only because your tolerance allowed what changed/);
  });

  test('is not counted as unchanged in the summary', async () => {
    const html = await page({
      pictures: [{ name: 'checkout', status: 'passed', diffPixels: 593, durationMs: 5 }],
    });
    assert.doesNotMatch(html, /chip good">1 unchanged/, 'it changed; a setting allowed it');
  });

  test('and a picture that really did match still says so', async () => {
    const html = await page({
      pictures: [{ name: 'checkout', status: 'passed', diffPixels: 0, durationMs: 5 }],
    });
    assert.match(html, /exactly as approved/);
    assert.match(html, /1 unchanged/);
    assert.doesNotMatch(html, /tolerance allowed/);
  });
});

describe('the guards section of the report', () => {
  test('does not call a run of skipped guards all still fixed', async () => {
    const html = await page({
      guards: [
        { name: 'the invoice still totals up', status: 'skipped' },
        { name: 'the basket still empties', status: 'skipped' },
      ],
    });
    assert.doesNotMatch(html, /All 2 bugs that were fixed are still fixed/, 'neither of them was asked anything');
    assert.match(html, /never answered/);
  });

  test('counts a guard that ran out of time apart from a bug coming back', async () => {
    const html = await page({
      guards: [
        { name: 'the delivery note still shows', status: 'failed', failedAt: 'it is on the page' },
        { name: 'the basket still empties', status: 'failed', timedOut: true, message: 'ran out of time' },
        { name: 'the order button is still there', status: 'passed' },
      ],
    });
    assert.match(html, /1 of 3 bugs that were fixed is back/, 'one bug is back, not two');
    assert.doesNotMatch(html, /2 of 3 bugs/);
    assert.match(html, /1 guard was never answered/);
  });
});
