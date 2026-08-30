/**
 * Two halves of the tool that were written and never called, and one that could not do the
 * job it was called to do.
 *
 * THE STORE GREW FOR EVER. `.staysfixed/` is deliberately kept in git, so its growth is
 * permanent and it is in somebody's history: one build FOLDER per check. The only
 * housekeeping that existed thinned the captures inside a folder and could never remove one,
 * so the thing that actually grows was never touched. These tests hold down the retention
 * policy — three tiers, and the two refusals that must survive it.
 *
 * NOBODY SWEPT THE SCRAPS. A run that died left `.part` files behind. Nothing reads them and
 * nothing removed them, which is the worst combination: invisible and permanent.
 *
 * A REMOTE MACHINE ANSWERED "REACHABLE" AND NOTHING ELSE. `describeRemote` had the rest of
 * the answer — what is installed there, whether anybody is signed in, what is missing and the
 * command for each — and doctor called none of it. The merge between the cheap probe and the
 * deep one is the part worth pinning: the cheap probe needs nothing on the far machine, the
 * deep one needs Node, and letting the deeper answer win on reachability reports a working
 * machine as unreachable the day somebody's Node is a version too old.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { check, suiteBudgetFrom } from '../../src/v2/check.js';
import { openStore, setReference, listBuilds } from '../../src/v2/store.js';
import { withRemoteDetail, capabilities } from '../../src/v2/doctor.js';
import { missingOn, notesOn } from '../../src/v2/remote.js';
import { describeWindows } from '../../src/v2/adapters/windows.js';
import { deviceToMake } from '../../src/v2/adapters/android.js';
import { scratchDir, cleanUp } from '../support.mjs';

const run = promisify(execFile);

after(async () => {
  await cleanUp();
});

/**
 * A tiny product with one journey, a commit to call working, and a settings file that keeps
 * almost no history — so the removal tier is reached in seconds rather than in a fortnight.
 *
 * @param {number} keepBuilds
 * @returns {Promise<{dir: string, working: string, journeys: string}>}
 */
async function product(keepBuilds) {
  const dir = await scratchDir('staysfixed-tidy');
  await run('git', ['init', '-q'], { cwd: dir });
  await run('git', ['config', 'user.email', 'test@staysfixed.local'], { cwd: dir });
  await run('git', ['config', 'user.name', 'Stays Fixed test'], { cwd: dir });
  await fsp.writeFile(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'tidy', version: '1.0.0' }, null, 2)}\n`);
  await fsp.writeFile(path.join(dir, 'staysfixed.config.json'), `${JSON.stringify({ product: 'tidy', keepBuilds }, null, 2)}\n`);
  await fsp.writeFile(path.join(dir, 'cli.js'), "console.log(JSON.stringify({ id: 0, name: 'Ada' }));\n");
  const journeys = path.join(dir, 'journeys.json');
  await fsp.writeFile(
    journeys,
    `${JSON.stringify(
      [
        {
          name: 'run-it',
          describe: 'Run it once and watch everything it does.',
          source: 'code',
          surface: 'cli',
          steps: [{ act: 'run', run: 'node cli.js', note: 'the whole product' }],
        },
      ],
      null,
      2,
    )}\n`,
  );
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['commit', '-qm', 'the build that works'], { cwd: dir });
  const working = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  return { dir, working, journeys };
}

/**
 * The build folders this store is holding, newest first is not promised — the names are.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function folders(dir) {
  return (await fsp.readdir(path.join(dir, '.staysfixed', 'v2', 'builds'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

describe('the stored record stops growing, in folders and not only in files', () => {
  test('builds past the cap are removed outright, and the run says how much evidence went', async () => {
    // keepBuilds of 1 means: one build kept whole, four more kept thinned, and everything
    // behind those removed. Reached in seven checks rather than in a fortnight.
    const { dir, working, journeys } = await product(1);
    /** @param {number} i */
    const editAndCheck = async (i) => {
      await fsp.writeFile(path.join(dir, 'cli.js'), `console.log(JSON.stringify({ id: ${i}, name: 'Ada' }));\n`);
      return check({ cwd: dir, against: working, paired: true, journeys, only: [] });
    };

    await editAndCheck(1);
    // The oldest build becomes the one this product calls working. It is now the build most
    // likely to be swept up by anything that goes by age, and its recordings are the only
    // evidence of what working looks like.
    const store = openStore({ root: dir });
    // The committed build, which is the one anybody would call working. Named by its prefix
    // rather than by position: readdir order is not an order, and a test that picks the wrong
    // folder here proves the opposite of what it says.
    const first = (await folders(dir)).find((name) => name.startsWith('git-')) ?? '';
    assert.notEqual(first, '', 'the fixture has to have a committed build in it, or nothing here is about a reference');
    await setReference(store, first, { setBy: 'a test' });

    /** @type {string} */
    let last = '';
    for (let i = 2; i < 12; i += 1) last = (await editAndCheck(i)).summary;

    const held = await folders(dir);
    assert.ok(held.includes(first), 'the build somebody shipped is never removed, however far down the list it falls');
    assert.match(last, /removed from the stored record altogether/, 'a removal nobody is told about is a deletion');
    assert.match(last, /recordings? with them|recordings? with it/, 'it has to say how much evidence went, not just how many folders');
    // One reference + one kept whole + four thinned. Anything more than that and the cap is
    // not a cap; the point of the whole policy is that this number stops going up.
    assert.ok(held.length <= 6, `the store is holding ${held.length} folders (${held.join(', ')}), so nothing is capped`);

    // And the records still line up with the folders. A removal that took the folder and left
    // the record behind would leave `listBuilds` describing evidence that is not there.
    const listed = await listBuilds(store, { product: 'tidy' });
    assert.equal(listed.length, held.length, 'every build folder has a record and every record has a folder');
  });

  test('nothing is removed at all when a stored record cannot be read', async () => {
    const { dir, working, journeys } = await product(1);
    /** @param {number} i */
    const editAndCheck = async (i) => {
      await fsp.writeFile(path.join(dir, 'cli.js'), `console.log(JSON.stringify({ id: ${i}, name: 'Ada' }));\n`);
      return check({ cwd: dir, against: working, paired: true, journeys, only: [] });
    };
    for (let i = 1; i < 9; i += 1) await editAndCheck(i);

    const before = await folders(dir);
    // One damaged record, which is the one state where nobody knows what would be deleted.
    // It has to be a build of the working tree: the committed one is walked again as the
    // reference on every run, so its record is rewritten and the damage does not survive to
    // the moment being tested.
    const builds = path.join(dir, '.staysfixed', 'v2', 'builds');
    const damaged = before.find((name) => name.startsWith('work-')) ?? '';
    assert.notEqual(damaged, '', 'there has to be a build of the working tree to damage');
    await fsp.writeFile(path.join(builds, damaged, 'build.json'), '{ this is not json');

    const out = await editAndCheck(99);
    assert.match(out.summary, /Nothing old was cleared out/, 'it has to say it stopped, or a housekeeping step that quietly stopped running is never noticed');
    const after = await folders(dir);
    for (const name of before) {
      assert.ok(after.includes(name), `${name} was removed on a run that could not read the whole list`);
    }
  });

  test("a run clears away the half-written files an earlier run died holding", async () => {
    const { dir, working, journeys } = await product(5);
    await fsp.writeFile(path.join(dir, 'cli.js'), "console.log(JSON.stringify({ id: 1, name: 'Ada' }));\n");
    const first = await check({ cwd: dir, against: working, paired: true, journeys, only: [] });

    // A scrap in this build's own folder, exactly as an interrupted write leaves one.
    const builds = path.join(dir, '.staysfixed', 'v2', 'builds');
    const mine = (await folders(dir)).find((name) => name.startsWith(first.candidate.id.slice(0, 8))) ?? (await folders(dir))[0];
    const scrap = path.join(builds, mine, 'build.json.part');
    await fsp.writeFile(scrap, 'half a record');

    const again = await check({ cwd: dir, against: working, paired: true, journeys, only: [] });
    assert.equal(await exists(scrap), false, 'a run has to clear up after itself, or the pile is invisible and permanent');
    assert.match(again.summary, /half-written/, 'and say so, because an invisible cleanup is how a tool gets blamed for a full disk');
  });
});

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function exists(file) {
  try {
    await fsp.stat(file);
    return true;
  } catch {
    return false;
  }
}

describe('how long the test-suite harvest is allowed to take is a setting', () => {
  test('nothing said leaves the harvest to apply its own default', () => {
    assert.equal(suiteBudgetFrom({}), null);
    assert.equal(suiteBudgetFrom({ suite: {} }), null);
    assert.equal(suiteBudgetFrom({ suite: { budgetMs: 'ages' } }), null, 'nonsense in a settings file must not become a budget of NaN');
    assert.equal(suiteBudgetFrom({ suite: { budgetMs: -1 } }), null, 'a negative budget would stop the harvest before it started');
  });

  test('a number is taken, and zero means no budget rather than no time', () => {
    assert.equal(suiteBudgetFrom({ suite: { budgetMs: 240_000 } }), 240_000);
    assert.equal(suiteBudgetFrom({ suite: { budgetMs: 0 } }), 0, 'zero is a real answer — walk all of them — and it is not the same as saying nothing');
    assert.equal(suiteBudgetFrom({ suite: { budgetMs: 1500.7 } }), 1500);
  });
});

describe('doctor says which Android image to make, and it exists on this machine', () => {
  test('the command it prints is the adapter\'s own, so the two can never drift again', async () => {
    const caps = await capabilities({ cwd: process.cwd(), offline: true });
    const avd = caps.tools.find((t) => t.id === 'avd');
    assert.ok(avd, 'doctor has to have an opinion about whether there is a phone to run an app on');
    if (avd.found) return; // Nothing to fix on a machine that already has one.
    assert.equal(avd.fix, deviceToMake().both);
    assert.ok(avd.fix?.includes(process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64'), 'naming an arm image to somebody on an Intel box fails talking about the image rather than about the machine');
    assert.match(avd.fix ?? '', /refuses root/, 'the Play Store warning has to travel with the command');
  });
});

describe('a machine that answers gets described, not just counted', () => {
  /**
   * @param {Partial<import('../../src/v2/remote.js').RemoteDescription>} over
   * @returns {import('../../src/v2/remote.js').RemoteDescription}
   */
  const description = (over = {}) => ({
    host: 'office',
    reachable: true,
    runnerStarted: true,
    how: 'it answered over ssh with the key already in the config',
    os: 'linux 5.15',
    windows: false,
    windowsVersion: null,
    powershell: null,
    desktopLoggedIn: null,
    desktopLocked: null,
    tools: { node: '/usr/bin/node', git: '/usr/bin/git' },
    missing: [],
    notes: [],
    ...over,
  });

  test('the deep probe never takes away what the cheap one proved', () => {
    // The cheap probe is a plain `echo` and needs nothing on the far machine. The deep one
    // needs Node there. A machine whose Node is a version too old used to come back as
    // "could not be reached", and the fix offered was the ssh config that had just worked.
    const cheap = { name: 'office', reachable: true, how: 'it answered over ssh with the key you already have', windows: true, powershell: '/mnt/c/x/powershell.exe' };
    const merged = withRemoteDetail(cheap, description({ reachable: true, runnerStarted: false, windows: false, how: 'a shell on it answers, but the small program this tool sends down the connection would not start there (node: not found)', tools: {} }));
    assert.equal(merged.reachable, true, 'a machine whose shell answers is reachable, whatever else is missing from it');
    assert.equal(merged.windows, true, 'the filesystem said powershell.exe is there; a probe that could not ask must not overrule it');
    assert.equal(merged.powershell, '/mnt/c/x/powershell.exe');
    assert.match(merged.how, /would not start there/, 'and the reason it could not be described further has to reach the reader');
  });

  test('the deep probe can add Windows that the cheap one missed', () => {
    const cheap = { name: 'office', reachable: true, how: 'it answered', windows: false };
    const merged = withRemoteDetail(cheap, description({ windows: true, powershell: '/mnt/c/x/powershell.exe', windowsVersion: 'Windows 11 10.0.22631', desktopLoggedIn: true }));
    assert.equal(merged.windows, true);
    assert.equal(merged.powershell, '/mnt/c/x/powershell.exe');
    assert.equal(merged.detail?.windowsVersion, 'Windows 11 10.0.22631');
  });

  test('a reachable machine with no runner is a Node problem, and it says the command', () => {
    const d = description({ runnerStarted: false, tools: {} });
    const missing = missingOn(d);
    const node = missing.find((m) => m.what.includes('Node'));
    assert.ok(node, 'the one thing that would help must not be the one thing left unsaid');
    assert.match(String(node.howToGet), /node --version/, 'a Node that is present but too old looks identical from here, so the version has to be asked for');
    assert.equal(missing.some((m) => m.what.includes('ssh connection')), false, 'never send somebody to fix a connection that just answered');

    const notes = notesOn(d);
    assert.ok(notes.some((n) => /unknown rather than absent/.test(n)), 'an empty list of tools that does not say why reads as "there is nothing there"');
  });

  test('an unreachable machine is still an ssh problem, with the command to test it', () => {
    const missing = missingOn(description({ reachable: false, runnerStarted: false, tools: {} }));
    assert.equal(missing.length, 1, 'nothing else can be known about a machine that never answered, so nothing else is claimed');
    assert.match(String(missing[0].howToGet), /ssh office true/);
    assert.equal(missing[0].blocking, true);
  });

  test('what the Windows adapter says about a machine is what doctor prints about it', () => {
    // One paragraph, from the adapter that knows. Two descriptions of one machine kept in
    // two files is how they end up disagreeing about whether it can be used.
    assert.match(describeWindows(description({ windows: true, desktopLoggedIn: false })), /nobody is signed in/);
    assert.match(describeWindows(description({ windows: true, desktopLoggedIn: true, desktopLocked: true, windowsVersion: 'Windows 11' })), /locked/);
    assert.match(describeWindows(description({ reachable: false })), /cannot be checked from/);
  });
});
