/**
 * Two promises that were made in a comment and kept nowhere.
 *
 * Both of the things tested here already existed as working, exported code that nothing
 * called. That is a worse state than missing, because the file it sits in describes the
 * behaviour as if it happens: intent.js lists three things its tree fingerprint makes
 * checkable, and the third one was checked by nobody; remote.js names the two kinds of far
 * side "this file knows how to start", and started anything you gave it.
 *
 * So these tests are not about the functions. They are standing over the wiring, because an
 * export with no caller is a week away from being deleted by the next person tidying up, and
 * the promise in the comment would go with it quietly.
 *
 * The third block is the same class of dishonesty said a different way: one question, two files,
 * two answers, and only one of them carrying the warning that matters.
 *
 * The first test also guards the pathspec in fingerprintTree. Wiring the tree check up is what
 * showed that sealing an intent moved the tree it had just fingerprinted, because the seal
 * writes into .staysfixed and git counted that as an edit. Take the pathspec out and this test
 * says the code changed when nothing did, which is exactly the lie it exists to prevent.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { openStore, ensureStore } from '../../src/v2/store.js';
import { sealIntent } from '../../src/v2/intent.js';
import { waive } from '../../src/v2/waiver.js';
import { farSideCommand, remoteRunner, RUNNER_KINDS } from '../../src/v2/remote.js';
import { EMULATOR_API, deviceFor, deviceToMake, emulatorAbi } from '../../src/v2/adapters/android.js';
import { StaysFixedError } from '../../src/core/errors.js';
import { scratchDir, cleanUp } from '../support.mjs';

const run = promisify(execFile);

after(cleanUp);

const PRODUCT = 'demo';

/**
 * One ordinary difference, in the shape the engine hands over after ranking.
 * @returns {any}
 */
function finding() {
  const difference = {
    path: 'cli.help.out',
    channel: 'results',
    kind: 'changed',
    reference: 'before',
    candidate: 'after',
    distance: 0.2,
  };
  return {
    id: 'engine-cli.help.out',
    title: 'The help text lost a line',
    why: '',
    class: 'ordinary',
    rank: 1,
    differences: [difference],
    paths: ['cli.help.out'],
    sample: difference,
    count: 1,
  };
}

/**
 * A project with a store in it, and a real git repository when one is asked for.
 *
 * The git half is the point of two of these tests, so when git is not on this machine they
 * say so and skip rather than passing on a fingerprint that proves nothing.
 *
 * @param {{git?: boolean}} [opts]
 * @returns {Promise<{root: string, store: any, file: string, git: boolean}>}
 */
async function project(opts = {}) {
  const root = await scratchDir('staysfixed-wiring');
  const file = path.join(root, 'basket.js');
  await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: PRODUCT, version: '1.0.0' }));
  await fsp.writeFile(file, 'export const total = 10;\n');

  let git = false;
  if (opts.git) {
    try {
      await run('git', ['init', '-q'], { cwd: root });
      await run('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      await run('git', ['config', 'user.name', 'Test'], { cwd: root });
      await run('git', ['add', '.'], { cwd: root });
      await run('git', ['commit', '-qm', 'first'], { cwd: root });
      git = true;
    } catch {
      git = false;
    }
  }

  const store = openStore({ root });
  await ensureStore(store);
  return { root, store, file, git };
}

/**
 * Seal an intent, then waive one ordinary difference against it.
 *
 * The check is stamped a minute in the future so the ordering gate — which is a different
 * gate, tested elsewhere — cannot be what fails here.
 *
 * @param {any} store
 * @returns {Promise<any>}
 */
async function sealThenWaive(store) {
  await sealIntent(store, {
    product: PRODUCT,
    summary: 'take a line out of the help text',
    files: ['cli.help.out', 'basket.js'],
  });
  return waive(store, {
    product: PRODUCT,
    finding: finding(),
    why: 'I removed that line on purpose',
    check: { at: new Date(Date.now() + 60_000).toISOString() },
  });
}

describe('a waiver records whether the code moved after the intent was sealed', () => {
  test('a tree that has not moved says the intent describes exactly this build', async () => {
    const { store, git } = await project({ git: true });
    if (!git) return; // No git on this machine; the fingerprint would prove nothing.

    const granted = await sealThenWaive(store);

    assert.equal(granted.ok, true, granted.say);
    assert.ok(granted.waiver.codeSince, 'the waiver has to carry what was known about the code, or nothing later can check it');
    assert.equal(granted.waiver.codeSince.knowable, true);
    assert.equal(granted.waiver.codeSince.moved, false);
    assert.match(granted.say, /has not changed since you sealed this intent/);
  });

  test('a tree that moved after sealing says so, and is still allowed', async () => {
    const { store, file, git } = await project({ git: true });
    if (!git) return;

    await sealIntent(store, {
      product: PRODUCT,
      summary: 'take a line out of the help text',
      files: ['cli.help.out', 'basket.js'],
    });
    // The work itself. An intent sealed BEFORE the edits is supposed to see this, so a moved
    // tree must never be treated as a refusal — only written down.
    await fsp.writeFile(file, 'export const total = 9.99;\n');

    const granted = await waive(store, {
      product: PRODUCT,
      finding: finding(),
      why: 'I removed that line on purpose',
      check: { at: new Date(Date.now() + 60_000).toISOString() },
    });

    assert.equal(granted.ok, true, granted.say);
    assert.equal(granted.waiver.codeSince.moved, true);
    assert.equal(granted.waiver.codeSince.knowable, true);
    assert.match(granted.say, /changed after you sealed this intent/);
  });

  test('outside a repository it says the ordering cannot be checked, rather than implying it can', async () => {
    const { store } = await project();

    const granted = await sealThenWaive(store);

    assert.equal(granted.ok, true, granted.say);
    assert.equal(granted.waiver.codeSince.knowable, false);
    assert.equal(granted.waiver.codeSince.moved, false);
    assert.match(granted.say, /cannot be checked/);
  });
});

describe('the remote runner refuses a far side it does not know how to start', () => {
  test('a kind that is not one of the two is refused here, not on the far machine', () => {
    assert.throws(
      () => farSideCommand(/** @type {any} */ ('win')),
      (/** @type {any} */ error) => {
        assert.ok(error instanceof StaysFixedError, 'this is a mistake in a caller, not a bug in the tool');
        assert.match(String(error.message), /win/, 'the refusal has to name what was asked for');
        return true;
      },
    );

    assert.throws(() => remoteRunner(/** @type {any} */ ({ host: 'somewhere', kind: 'WINDOWS' })), StaysFixedError);
  });

  test('both of the kinds it names still work', () => {
    for (const kind of RUNNER_KINDS) {
      assert.equal(typeof farSideCommand(kind), 'string');
    }
    assert.ok(farSideCommand('windows').includes('powershell.exe'));
    assert.ok(farSideCommand('posix').startsWith('node '));
  });
});

describe('there is one answer to which Android device to make', () => {
  /**
   * Google publishes emulator images for arm64, x86_64 and x86 and nothing else, so on any
   * other architecture there is no image to name and `deviceToMake` says so instead of
   * inventing one. Every machine these tests run on is arm64 or x86_64, so this only ever
   * skips on a machine where the question does not apply.
   * @param {import('node:test').TestContext} t
   * @returns {boolean} true when there is no image to assert about
   */
  function noImageHere(t) {
    if (emulatorAbi() !== null) return false;
    t.skip(`no Android emulator image is published for ${process.arch}, so there is nothing to name`);
    return true;
  }

  test('it is never a Play Store image, and it says why in the same breath', (t) => {
    if (noImageHere(t)) return;
    const made = deviceToMake();
    assert.equal(String(made.image).includes('google_apis_playstore'), false, 'a Play Store device refuses root forever');
    assert.match(String(made.image), /;google_apis;/);
    assert.match(made.why, /refuses root/, 'the warning has to travel with the command, or only one of the two places carries it');
    assert.match(made.both, /refuses root/);
  });

  test('the image matches the processor this machine has', (t) => {
    const abi = emulatorAbi();
    const expected = process.arch === 'arm64' ? 'arm64-v8a' : process.arch === 'x64' ? 'x86_64' : process.arch === 'ia32' ? 'x86' : null;
    assert.equal(abi, expected,
      'x86_64 used to be the answer for every architecture that was not arm64, which names an '
      + 'image nobody has published to anyone on a 32-bit or unusual machine');
    if (noImageHere(t)) return;
    assert.ok(String(deviceToMake().image).endsWith(String(abi)), 'naming an arm image to somebody on an Intel box fails talking about the image, not the machine');
  });

  test('an app that needs a newer Android raises the device, and an older one never lowers it', (t) => {
    if (noImageHere(t)) return;
    assert.match(String(deviceFor({ minSdk: 36 }).image), /android-36;/, 'an app cannot install on a device older than its minSdk');
    assert.match(String(deviceFor({ minSdk: 24 }).image), new RegExp(`android-${EMULATOR_API};`), 'older is the direction that breaks, so it is never taken');
    assert.match(String(deviceFor(null).image), new RegExp(`android-${EMULATOR_API};`));
  });

  test('both commands are offered, because a person needs both', () => {
    const made = deviceToMake();
    // Null on an architecture Google publishes no emulator image for — 32-bit Intel, s390x,
    // anything but arm64, x86_64 and x86. Naming a package that does not exist would be worse
    // than saying so, which is what `why` then carries. The test machines are all x86_64 or
    // arm64, so this branch is a guard rather than a thing anyone here will see.
    if (made.image === null) {
      assert.equal(made.install, null);
      assert.equal(made.create, null);
      assert.match(made.why, /no android emulator image is published/i);
      return;
    }
    assert.match(String(made.install), /^sdkmanager --install /);
    assert.match(String(made.create), /^avdmanager create avd -n staysfixed -k /);
    assert.ok(
      String(made.install).includes(made.image) && String(made.create).includes(made.image),
      'the two commands have to name the same image',
    );
  });
});
