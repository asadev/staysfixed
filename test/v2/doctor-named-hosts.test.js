/**
 * A machine the settings name is a machine the project has asked about.
 *
 * Doctor does not dial anybody's ssh config unasked, and that rule is right: the first
 * command a stranger runs must not open connections to their production servers. But "you
 * have not asked me to look" and "your own settings name this machine" are different
 * situations, and doctor answered them with the same sentence — "No Windows desktop is
 * reachable from here" — on a project whose settings said `windows: { host: "imza-pc" }`,
 * with that machine reachable, signed in and unlocked the whole time. Measured 2026-08-31.
 *
 * A sentence stating as a fact about the world an answer that came from a decision not to
 * look is the exact failure this whole tool exists to prevent, and it is worse here than
 * almost anywhere else: it tells somebody a platform cannot be checked when it can.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { hostsNamedInSettings } from '../../src/v2/doctor.js';

describe('machines the settings name', () => {
  test('a host under the windows block is one the project asked about', () => {
    const found = hostsNamedInSettings(`export default {
      product: "notepad",
      windows: { host: "imza-pc", remoteExe: "C:\\Windows\\notepad.exe" },
    };`);
    assert.deepEqual(found, ['imza-pc']);
  });

  test('a commented-out host is an example, not an ask', () => {
    const found = hostsNamedInSettings(`export default {
      // windows: { host: "some-machine" },
      product: "x",
    };`);
    assert.deepEqual(found, [], 'a machine somebody has commented out must never be dialled');
  });

  test('settings that name no machine ask for nothing', () => {
    assert.deepEqual(hostsNamedInSettings('export default { product: "x" };'), []);
    assert.deepEqual(hostsNamedInSettings(null), [], 'a project with no settings has asked for nothing');
  });

  test('two blocks naming the same machine ask about it once', () => {
    const found = hostsNamedInSettings(`export default {
      windows: { host: "box" },
      remote: { host: "box" },
    };`);
    assert.deepEqual(found, ['box'], 'the same machine dialled twice is a slower answer, not a better one');
  });
});
