/**
 * The front door — what a person can actually ask `check` for.
 *
 * The harvest that reads a project's own tests is proved by the corpus and by
 * suite-journeys.test.js, both of which hand the engine a journeys file full of `run-tests`
 * steps. Neither of them can prove anybody can REACH it: the front door read `suite` as the
 * name of a file and went looking for one, so a finished, tested, documented feature was
 * unreachable from the only words anybody would type to ask for it.
 *
 * This is the wiring, and the test is deliberately end to end, because end to end is the
 * only place the wiring exists.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { check } from '../../src/v2/check.js';
import { scratchDir, cleanUp } from '../support.mjs';

const run = promisify(execFile);

after(cleanUp);

/**
 * A product whose break is invisible from the outside.
 *
 * `total` rounds to pennies and the command line only ever adds whole pounds, so taking the
 * rounding away does not move one character of what the product prints. Its own test sees it
 * immediately. That gap is the whole argument for harvesting a suite at all.
 *
 * @returns {Promise<{dir: string, working: string}>}
 */
async function productWithATest() {
  const dir = await scratchDir('staysfixed-suite');
  await fsp.mkdir(path.join(dir, 'test'), { recursive: true });
  await run('git', ['init', '-q'], { cwd: dir });
  await run('git', ['config', 'user.email', 'test@staysfixed.local'], { cwd: dir });
  await run('git', ['config', 'user.name', 'Stays Fixed test'], { cwd: dir });
  await fsp.writeFile(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'suite-demo', version: '1.0.0' }, null, 2)}\n`);
  await fsp.writeFile(path.join(dir, 'total.js'), 'export function total(rows) { return Math.round(rows.reduce((a, b) => a + b, 0) * 100) / 100; }\n');
  await fsp.writeFile(
    path.join(dir, 'test', 'total.test.js'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { total } from '../total.js';",
      "test('it rounds to pennies', () => { assert.equal(total([0.1, 0.2]), 0.3); });",
      '',
    ].join('\n'),
  );
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['commit', '-qm', 'the build that works'], { cwd: dir });
  const working = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  await fsp.writeFile(path.join(dir, 'total.js'), 'export function total(rows) { return rows.reduce((a, b) => a + b, 0); }\n');
  return { dir, working };
}

describe('asking for the suite by name', () => {
  test('it is harvested and walked, not looked for as a file called "suite"', async () => {
    const { dir, working } = await productWithATest();
    const outcome = await check({ cwd: dir, against: working, paired: true, journeys: 'suite', only: [] });

    assert.notEqual(outcome.blocked, true, outcome.summary);
    assert.equal(outcome.ok, false, 'the rounding is gone and this project\'s own test says so');
    assert.ok(outcome.findings.length > 0, 'nothing else about this product moves by one character, so these can only have come from the suite');
    assert.ok(
      outcome.findings.some((f) => /rounds to pennies/i.test(`${f.title} ${f.differences.map((d) => d.path).join(' ')}`)),
      `the check that turned red has to be named: ${outcome.findings.map((f) => f.title).join(' | ')}`,
    );
  });
});
