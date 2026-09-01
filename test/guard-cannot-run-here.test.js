/**
 * "Not proved" is a third answer, and a guard needs to be able to give it.
 *
 * Found on 2026-09-02, writing fifty guards for a real product in one night. Four of them
 * failed on this machine for reasons that had nothing to do with the product: one wanted a
 * paired second machine, one an Android phone, two a session in a state nothing had put it in.
 * Nothing was broken. The guards were being asked somewhere that could not answer them.
 *
 * Until this existed, a guard in that position had two ways out and both were wrong.
 *
 *   PASSING IS A LIE. It reports that a bug did not come back, having looked for nothing. That
 *   is the false all-clear this whole tool exists to prevent, wearing the friendliest face it
 *   has, and it would say it again every day for ever.
 *
 *   FAILING IS A FALSE ALARM, and worse than it sounds: the line a run prints over a failed
 *   guard is "bugs that were already fixed are back". Somebody goes hunting a regression that
 *   never happened, and after that happens twice they stop believing any of them.
 *
 * So there is a third answer now, reported as `skipped` and never counted as either — the same
 * distance a pass is from "nothing was compared", which is the distinction this tool is built
 * on and which had a hole in it exactly here.
 *
 * The last test is the important one. A door out of a failing check is a door somebody will
 * eventually walk through to make a red run green, so it has to be impossible to use that way:
 * an expectation that has already failed cannot be taken back by declining afterwards.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { runGuards } from '../src/guard/run.js';

const fakeApp = () => /** @type {any} */ ({
  page: { goto: async () => {}, consoleErrors: () => [], clearConsole: () => {}, exists: async () => true },
});
const project = /** @type {any} */ ({
  config: { app: { kind: 'web', url: 'http://127.0.0.1:1' } },
  paths: { root: os.tmpdir() },
});

/** @param {any} guard */
const runOne = async (guard) => /** @type {any} */ ((await runGuards(project, fakeApp(), [guard], {}))[0]);

describe('a guard that cannot be answered here', () => {
  test('is neither a pass nor a failure', async () => {
    const result = await runOne({
      name: 'the phone stays silent while the app is in front',
      because: 'Notifications drew over the app he was already looking at.',
      file: 'x.guard.js',
      async run(/** @type {any} */ { cannotRunHere }) {
        cannotRunHere('no Android phone or emulator is attached to this machine.');
      },
    });
    assert.equal(result.status, 'skipped', `status was "${result.status}"`);
    assert.equal(result.cannotRunHere, true);
    assert.match(String(result.message), /Not proved here/);
    // What is missing has to survive into the message, or nobody reading a run can tell
    // whether plugging a phone in would fix it.
    assert.match(String(result.message), /Android phone or emulator/);
    // And it must not claim anything about the bug.
    assert.match(String(result.message), /nothing here says it has not come back/i);
  });

  test('is not reported as a guard that checked nothing', async () => {
    // The rule that catches an empty `run()` would otherwise catch this too, and say the guard
    // is "not protecting anything" — true of an empty guard, and the wrong thing to say about
    // one that deliberately declined.
    const result = await runOne({
      name: 'a session on a paired machine can be controlled from the bar',
      because: 'Every control on a remote session was drawn and then refused.',
      file: 'y.guard.js',
      async run(/** @type {any} */ { cannotRunHere }) {
        cannotRunHere('no machine is paired with this install.');
      },
    });
    assert.notEqual(result.assertedNothing, true);
    assert.doesNotMatch(String(result.message), /checked nothing/i);
  });

  test('CANNOT be used to take back an expectation that already failed', async () => {
    // The one way this feature could make things worse. A guard that has already discovered
    // the bug is back must not be able to walk it back by declining on the next line.
    const result = await runOne({
      name: 'a guard that fails and then tries to excuse itself',
      because: 'A door out of a red run is a door somebody will eventually use.',
      file: 'z.guard.js',
      async run(/** @type {any} */ { expect, cannotRunHere }) {
        await expect('something that is not true', async () => false);
        cannotRunHere('and now let me out of it');
      },
    });
    assert.equal(result.status, 'failed', `a failed guard escaped as "${result.status}"`);
    assert.notEqual(result.cannotRunHere, true);
  });

  test('a guard that still asserts things is unaffected', async () => {
    const result = await runOne({
      name: 'an ordinary guard',
      because: 'It holds.',
      file: 'w.guard.js',
      async run(/** @type {any} */ { expect }) {
        await expect('this is true', async () => true);
      },
    });
    assert.equal(result.status, 'passed');
    assert.notEqual(result.cannotRunHere, true);
  });
});
