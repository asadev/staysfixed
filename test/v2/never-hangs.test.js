/**
 * Nothing in these adapters is allowed to wait for ever.
 *
 * This file exists because of one recorded symptom: on 2026-08-30 an Electron check produced no
 * output at all and simply never came back. That is the worst outcome a tool like this has. A
 * person runs it before a release, and a run that never returns cannot be told apart from the
 * tool being broken, or from their own product being broken, or from a machine that is merely
 * slow. A run that gives up after a bounded wait and says exactly what it was waiting for is
 * worse news and better information, every time.
 *
 * On 2026-08-31 it was reproduced twice against a fake app — one that starts, prints one line,
 * and leaves a `sleep` behind that inherited its standard output. That is the shape a real
 * desktop app has: helpers for the screen and the network, plus whatever the app itself started,
 * and the app these adapters were built against starts shells for a living. Both reproductions
 * had the same cause and it was not a missing limit:
 *
 *   1. `runCommand` was asked for a two second limit and had not returned twenty seconds later.
 *      Its limit fired exactly on time — but the promise was settled by the child's `close`
 *      event, and `close` does not mean "the program ended", it means "nobody anywhere is
 *      holding its pipes any more". The orphan was holding them.
 *
 *   2. A run that had done all of its work — app opened, read, closed, and PROVED gone, with the
 *      teardown printing "the next run starts alone" — then sat there for ever, because a pipe
 *      that is being read keeps Node's event loop awake.
 *
 * So every case below asserts two different things, and both are needed. That the call comes
 * BACK, within a limit. And that when it gives up it says WHAT it was waiting for, because
 * "it timed out" and "it never came back" are the same non-answer.
 *
 * Every case is raced against a limit of its own, so that a regression fails this file loudly
 * instead of hanging whoever ran it — which would be the same bug in the test suite.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  boundedCount,
  boundedMs,
  endOfChild,
  letGoOf,
  runCommand,
  withLimit,
} from '../../src/v2/adapters/process.js';
import { openApp, settleTree, takeStep } from '../../src/v2/adapters/electron.js';
import { releaseIsolation, reserveIsolation, startIsolated } from '../../src/v2/adapters/isolate.js';
import { Device } from '../../src/v2/adapters/android-driver.js';
import { scratchDir, cleanUp } from '../support.mjs';

after(cleanUp);

/** Whether a program can be started at all the way these cases start one. */
const onWindows = process.platform === 'win32';

/**
 * Fail rather than hang.
 *
 * A test for "it always comes back" that hangs when it does not come back has reported the bug
 * by committing it. So every wait here is raced against a shorter one that throws a sentence.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} what
 * @returns {Promise<T>}
 */
function mustComeBack(promise, ms, what) {
  /** @type {ReturnType<typeof setTimeout>} */
  let timer;
  const tooLong = new Promise((_ok, fail) => {
    timer = setTimeout(() => fail(new Error(`${what} never came back. It was still waiting ${ms}ms later, which is the exact bug this file exists for.`)), ms);
  });
  return Promise.race([promise, tooLong]).finally(() => clearTimeout(timer));
}

/**
 * A fake program that starts, says one thing, and leaves an orphan holding its standard output.
 *
 * The orphan is made in a subshell that exits at once, so it is adopted by the system and is
 * nobody's descendant by the time anything comes looking — which is exactly what a desktop
 * app's double-forked helper looks like, and exactly what a sweep that walks the process tree
 * cannot find. It is what makes `close` never arrive.
 *
 * The sleeps are short so that a run of this file leaves nothing behind for long even if a
 * case fails half way.
 *
 * @param {string} dir
 * @returns {Promise<string>} the path to the fake program
 */
async function fakeProgramThatLeavesAnOrphan(dir) {
  const file = path.join(dir, 'leaves-an-orphan.sh');
  await fsp.writeFile(
    file,
    // Every flag it is handed is ignored, exactly as a real app ignores ones it does not know.
    '#!/bin/sh\necho "the fake app is up"\n( sleep 20 & )\nexec sleep 20\n',
    { mode: 0o755 },
  );
  return file;
}

// ---------------------------------------------------------------------------
// A limit that is not a number
// ---------------------------------------------------------------------------

describe('a limit that somebody mistyped', () => {
  test('a limit written as text becomes the default rather than no limit at all', () => {
    // This is the whole reason `boundedMs` exists. `Number("30s")` is NaN; `Date.now() + NaN`
    // is NaN; `Date.now() > NaN` is false every single time round a loop. A limit that is not
    // a number does not shorten a wait, it REMOVES it, silently, in a way that reads in the
    // source exactly like a wait that is bounded.
    assert.equal(boundedMs('30s', 5000), 5000, 'a limit written as text was used as a limit');
    assert.equal(boundedMs(undefined, 5000), 5000);
    assert.equal(boundedMs(null, 5000), 5000);
    assert.equal(boundedMs(Number.NaN, 5000), 5000);
    assert.equal(boundedMs(0, 5000), 5000, 'zero switches off the limit in every API that takes one');
    assert.equal(boundedMs(-1, 5000), 5000);
    assert.equal(boundedMs(Infinity, 5000), 5000, 'for ever is not a limit');
    assert.equal(boundedMs(1234, 5000), 1234, 'a real limit was not honoured');
    assert.equal(boundedMs(999_999_999, 5000, 60_000), 60_000, 'an absurd limit was not capped');
  });

  test('a count that somebody mistyped becomes the default too', () => {
    assert.equal(boundedCount('eight', 8, 200), 8);
    assert.equal(boundedCount(0, 8, 200), 8, 'zero tries reads the screen never and reports it empty');
    assert.equal(boundedCount(3, 8, 200), 3);
    assert.equal(boundedCount(10_000, 8, 200), 200, 'an absurd count was not capped');
  });
});

// ---------------------------------------------------------------------------
// Waiting for a program
// ---------------------------------------------------------------------------

describe('waiting for a program that leaves something behind', () => {
  test('runCommand comes back on time even when an orphan holds its pipes, and says it gave up', { skip: onWindows ? 'these process groups do not exist on Windows' : false }, async () => {
    const dir = await scratchDir('staysfixed-never-hangs');
    const program = await fakeProgramThatLeavesAnOrphan(dir);

    const started = Date.now();
    const ran = await mustComeBack(
      runCommand(`sh ${JSON.stringify(program)}`, { cwd: dir, env: /** @type {any} */ (process.env), timeoutMs: 1500 }),
      15_000,
      'runCommand, asked for a limit of one and a half seconds',
    );
    const took = Date.now() - started;

    // Measured before the fix: this same call was still waiting twenty seconds later, because
    // it settled on `close` and the orphan was holding the pipes open.
    assert.ok(took < 10_000, `runCommand took ${took}ms for a limit of 1500ms`);
    assert.equal(ran.timedOut, true, 'it ran out of time and reported a clean run');
    assert.match(
      ran.stderr,
      /gave up waiting for/,
      `giving up said nothing about what it was waiting for: ${JSON.stringify(ran.stderr)}`,
    );
    assert.match(ran.stderr, /leaves-an-orphan/, 'the sentence did not name the command it gave up on');
    assert.ok(ran.stdout.includes('the fake app is up'), 'what it did manage to say was thrown away');
  });

  test('endOfChild names what it was waiting for', { skip: onWindows ? 'these process groups do not exist on Windows' : false }, async () => {
    const child = spawn('/bin/sh', ['-c', 'echo hello; ( sleep 20 & ); exec sleep 20'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdout?.resume();
    child.stderr?.resume();
    const ended = await mustComeBack(
      endOfChild(child, { limitMs: 800, graceMs: 200, group: true, what: 'the pretend build step' }),
      12_000,
      'endOfChild with a limit of 800ms',
    );
    assert.equal(ended.gaveUp, true, 'it ran out of time and said it had not');
    assert.match(ended.why, /the pretend build step/, `the sentence did not name what it waited for: ${ended.why}`);
    assert.match(ended.why, /Nothing it would have done after that point was checked/);
    // And nothing it started may still be holding this process open afterwards.
    assert.equal(child.stdout?.destroyed, true, 'the pipes were left open for an orphan to hold');
  });

  test('a program that ends normally is not reported as having run out of time', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("done"); process.exit(0)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let said = '';
    child.stdout?.on('data', (b) => { said += String(b); });
    child.stderr?.resume();
    const ended = await mustComeBack(endOfChild(child, { limitMs: 20_000, what: 'a program that behaves' }), 25_000, 'endOfChild on a well-behaved program');
    assert.equal(ended.gaveUp, false, 'a program that finished on its own was reported as killed');
    assert.equal(ended.code, 0);
    assert.equal(said, 'done', 'the last of its output was lost');
  });
});

// ---------------------------------------------------------------------------
// Waiting for anything else
// ---------------------------------------------------------------------------

describe('waiting for something that is not a program', () => {
  test('withLimit gives up with a sentence naming what it waited for', async () => {
    await assert.rejects(
      () => mustComeBack(withLimit(new Promise(() => {}), { limitMs: 300, what: 'the app to open a window' }), 8000, 'withLimit'),
      /gave up after .* waiting for the app to open a window/,
    );
  });

  test('withLimit lets a wait that finishes in time through untouched', async () => {
    const answer = await withLimit(Promise.resolve('here'), { limitMs: 5000, what: 'something quick' });
    assert.equal(answer, 'here');
  });

  test('withLimit can name the step it was actually stuck in', async () => {
    // A wait made of several steps that says "it timed out" sends somebody looking in every
    // wrong place first. This is how `openApp` names the one it stopped at.
    const stage = { at: 'the first thing' };
    const waiting = withLimit(new Promise(() => {}), { limitMs: 400, what: () => stage.at });
    stage.at = 'the app to open a window';
    await assert.rejects(() => mustComeBack(waiting, 8000, 'a staged wait'), /waiting for the app to open a window/);
  });
});

// ---------------------------------------------------------------------------
// The desktop adapter
// ---------------------------------------------------------------------------

describe('the desktop adapter never waits for ever', () => {
  test('a wait step whose limit was mistyped still gives up, and names the control', async () => {
    // Before this was guarded, `Number("10s")` was NaN, `Date.now() + NaN` was NaN, and this
    // loop asked the app for its whole accessibility tree five times a second until somebody
    // killed the tool — with no output and no reason, looking exactly like the app hanging
    // rather than the journey being mistyped.
    const app = /** @type {any} */ ({
      browser: { send: async () => ({ nodes: [] }) },
      sessionId: 'a-session',
    });
    const outcome = await mustComeBack(
      takeStep(app, { act: 'wait', control: 'A button that is not there', timeoutMs: '10s' }),
      20_000,
      'a wait step with a mistyped limit',
    );
    assert.equal(outcome.ok, false);
    assert.match(outcome.did, /A button that is not there/, `the sentence did not name the control: ${outcome.did}`);
    assert.match(outcome.did, /never did/);
  });

  test('a wait step with a real limit gives up on time', async () => {
    const app = /** @type {any} */ ({ browser: { send: async () => ({ nodes: [] }) }, sessionId: 'a-session' });
    const started = Date.now();
    const outcome = await mustComeBack(
      takeStep(app, { act: 'wait', control: 'Nothing', timeoutMs: 900 }),
      10_000,
      'a wait step with a limit of 900ms',
    );
    assert.ok(Date.now() - started < 6000, 'a bounded wait step took far longer than its limit');
    assert.equal(outcome.ok, false);
  });

  test('settling the screen still stops when its settings are nonsense', async () => {
    let reads = 0;
    const settled = await mustComeBack(
      settleTree(async () => { reads += 1; return []; }, /** @type {any} */ ({ tries: 'lots', gapMs: 'quickly' })),
      15_000,
      'settleTree with settings that are not numbers',
    );
    assert.ok(reads > 0, 'it never read the screen at all');
    assert.ok(reads <= 8, `it read the screen ${reads} times when eight is the default`);
    assert.equal(typeof settled.settled, 'boolean');
  });

  test('opening an app that never opens its debugging port gives up, and says which port and which step', { skip: onWindows ? 'the fake app here is a shell script' : false }, async () => {
    const root = await scratchDir('staysfixed-never-hangs-open');
    const program = await fakeProgramThatLeavesAnOrphan(root);
    const isolation = await reserveIsolation({ scratchDir: root, label: 'a build that will not talk', appId: 'com.example.silent' });
    try {
      const started = Date.now();
      await assert.rejects(
        () => mustComeBack(
          openApp({ binary: program, isolation, timeoutMs: 1200 }),
          30_000,
          'openApp against an app that never opens a debugging port',
        ),
        (/** @type {Error} */ error) => {
          assert.match(
            error.message,
            /main-process debugging connection/,
            `giving up did not say what it was waiting for: ${error.message}`,
          );
          assert.match(error.message, new RegExp(String(isolation.inspectPort)), 'the sentence did not name the port');
          return true;
        },
      );
      assert.ok(Date.now() - started < 25_000, 'opening took far longer than its limit');
    } finally {
      await releaseIsolation(isolation);
    }
  });

  test('closing a run lets go of the pipes, so nothing it left behind can hold the tool open', { skip: onWindows ? 'the fake app here is a shell script' : false }, async () => {
    // The second reproduction, on 2026-08-31, in one assertion. Every step of the teardown
    // succeeded and the report read "the app was closed and is gone ... the next run starts
    // alone" — and then the tool never returned, because the orphan was still holding the
    // writing end of a pipe this process was reading, and a pipe being read keeps Node's event
    // loop awake. Proving the app gone is not the same as letting go of it.
    const root = await scratchDir('staysfixed-never-hangs-close');
    const program = await fakeProgramThatLeavesAnOrphan(root);
    const isolation = await reserveIsolation({ scratchDir: root, label: 'a build that leaves an orphan', appId: 'com.example.orphan' });
    const app = startIsolated(isolation, { binary: program });
    await new Promise((go) => setTimeout(go, 400));

    const report = await mustComeBack(releaseIsolation(isolation), 60_000, 'releasing a run whose app left an orphan behind');

    assert.ok(report.why.length > 0, 'the teardown said nothing about what it did');
    assert.equal(app.child.stdout?.destroyed, true, "the app's standard output was left open for an orphan to hold");
    assert.equal(app.child.stderr?.destroyed, true, "the app's standard error was left open for an orphan to hold");
  });
});

// ---------------------------------------------------------------------------
// The Android driver
// ---------------------------------------------------------------------------

describe('asking a device for bytes never waits for ever', () => {
  test('a device that never finishes gives up with a sentence naming what was asked', { skip: onWindows ? 'the fake adb here is a shell script' : false }, async () => {
    // `adb` keeps a server daemon of its own that inherits the pipes, so this settling on
    // `close` was the same hang wearing a different hat — and it had no limit at all.
    const dir = await scratchDir('staysfixed-never-hangs-adb');
    const fakeAdb = await fakeProgramThatLeavesAnOrphan(dir);
    const device = new Device(fakeAdb, 'emulator-9999');
    await assert.rejects(
      () => mustComeBack(device.bytes('screencap -p', { timeoutMs: 900 }), 15_000, 'asking a device that never answers for bytes'),
      (/** @type {Error} */ error) => {
        assert.match(error.message, /gave up waiting for/, `giving up said nothing: ${error.message}`);
        assert.match(error.message, /screencap -p/, `the sentence did not name what was asked: ${error.message}`);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Letting go
// ---------------------------------------------------------------------------

describe('letting go of a child', () => {
  test('the pipes are torn down rather than trusted to close', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { stdio: ['pipe', 'pipe', 'pipe'] });
    letGoOf(child);
    assert.equal(child.stdout?.destroyed, true);
    assert.equal(child.stderr?.destroyed, true);
    assert.equal(child.stdin?.destroyed, true);
    child.kill('SIGKILL');
  });

  test('letting go of nothing is not an error', () => {
    assert.doesNotThrow(() => letGoOf(null));
    assert.doesNotThrow(() => letGoOf(undefined));
  });
});
