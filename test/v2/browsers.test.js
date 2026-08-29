/**
 * The browser hygiene rules, held to account.
 *
 * These are not tests about a feature. They are tests about a promise: while this
 * tool is running, the machine it is running on must not get worse. That promise
 * was broken once on a real Mac — every scratch browser the tool opened shared an
 * application slot with the owner's own Chrome, so clicking his browser icon woke
 * one of our invisible copies and his window never appeared.
 *
 * So four things are proved here, and each one is a way that promise could break
 * again:
 *
 *   1. It picks a browser that is not his when there is one, and says plainly
 *      when there is not.
 *   2. It never opens his profile, and never the port another session owns.
 *   3. Nothing it opened outlives the run — including when the run is killed.
 *   4. It never quits a browser it did not start, even when a stale record with
 *      somebody else's process id says it should.
 *
 * Everything here uses real processes. A mocked browser cannot prove any of it.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  surveyBrowsers,
  openBrowser,
  reserveBrowser,
  closeEverything,
  openBrowserCount,
  findStrays,
  cleanStrays,
  describeBrowsers,
  probeBrowser,
  BROWSERS_COMMAND,
  INSTALL_COMMAND,
  PORT_NEVER_USE,
  SCRATCH_ROOT,
} from '../../src/v2/browsers.js';

const BROWSERS_MODULE = fileURLToPath(new URL('../../src/v2/browsers.js', import.meta.url));

/** Long enough for a cold browser start on a busy laptop. */
const START_MS = 90_000;

/** @type {import('../../src/v2/browsers.js').BrowserSurvey} */
let survey;

/**
 * Start a throwaway Node process that opens a browser and then refuses to tidy
 * up, so the cleanup guarantees can be tested against a run that really does die
 * without closing anything.
 *
 * @param {'block'|'throw'} how
 * @returns {Promise<{node: import('node:child_process').ChildProcess, browserPid: number, profile: string}>}
 */
function startALeakingRun(how) {
  const source = `
    const m = await import(${JSON.stringify(BROWSERS_MODULE)});
    const b = await m.openBrowser();
    console.log('READY ' + b.pid + ' ' + b.userDataDir);
    ${how === 'throw' ? "throw new Error('a run that fell over');" : 'await new Promise(() => {});'}
  `;
  const node = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const giveUp = setTimeout(() => reject(new Error(`the throwaway run never opened a browser. It said: ${out}`)), START_MS);
    node.stdout.setEncoding('utf8');
    node.stdout.on('data', (chunk) => {
      out += chunk;
      const hit = /READY (\d+) (.+)/.exec(out);
      if (!hit) return;
      clearTimeout(giveUp);
      resolve({ node, browserPid: Number(hit[1]), profile: hit[2].trim() });
    });
    node.once('exit', () => {
      if (!/READY/.test(out)) {
        clearTimeout(giveUp);
        reject(new Error(`the throwaway run stopped before it opened anything: ${out}`));
      }
    });
  });
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {number} pid
 * @param {number} ms
 * @returns {Promise<boolean>} true when it went away in time
 */
async function waitUntilGone(pid, ms = 10_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

describe('choosing a browser', () => {
  before(async () => {
    survey = await surveyBrowsers();
  });

  test('it finds something to work with, or says exactly what would fix that', async () => {
    if (survey.chosen === null) {
      // No browser is a legitimate state on a bare machine. What is not legitimate
      // is a shrug: the answer has to carry the command that fixes it.
      assert.match(survey.note, /npm install/, 'with no browser at all, the note has to carry the command that gets one');
      assert.equal(survey.install, INSTALL_COMMAND);
      return;
    }
    assert.ok(survey.chosen.binary.length > 0);
    assert.ok(survey.chosen.usable, 'the browser it chose has to be one that actually runs');
  });

  test('a browser that is on disk but will not run is never chosen', async () => {
    // The real case this comes from: a half-downloaded Chrome for Testing sat in
    // Playwright's cache on the owner's Mac. Every check that looked at the
    // filesystem said yes, and it died on its first library load.
    const notABrowser = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-notabrowser-')), 'browser');
    await fsp.writeFile(notABrowser, '#!/bin/sh\necho "cannot load framework"\n');
    await fsp.chmod(notABrowser, 0o755);

    const answer = await probeBrowser(notABrowser);
    assert.equal(answer.ok, false, 'something that prints no version is not a browser, whatever its name is');
    assert.ok((answer.why ?? '').length > 0, 'and the reason has to be quotable to a person');

    for (const found of survey.found) {
      if (found === survey.chosen) assert.ok(found.usable);
    }
    await fsp.rm(path.dirname(notABrowser), { recursive: true, force: true });
  });

  test('his own browser is the last resort, never the first choice', async () => {
    const others = survey.found.filter((b) => b.usable && !b.everyday);
    if (others.length > 0) {
      assert.equal(survey.chosen?.everyday, false, 'there is a browser here that is not his, so it must not have picked his');
      assert.equal(survey.borrowingHis, false);
    }
    // Whatever it picked, his own can never outrank one that is not his.
    const order = survey.found.filter((b) => b.usable).map((b) => b.everyday);
    const firstHis = order.indexOf(true);
    if (firstHis !== -1) {
      assert.ok(order.slice(firstHis).every((isHis) => isHis === true), 'once his own browser appears in the ranking, nothing may come after it');
    }
  });

  test('when his is the only one, it says so in words a person can act on', async () => {
    // A machine with no downloaded test browsers is simulated by pointing home
    // and the browser cache at empty folders. His own Chrome lives at an absolute
    // path and is still found, which is exactly the situation being tested.
    const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-nohome-'));
    const realHome = process.env.HOME;
    const realCache = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.HOME = empty;
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(empty, 'no-browsers-here');
    try {
      const bare = await surveyBrowsers({ refresh: true });
      if (bare.chosen === null) return; // No everyday browser here either. Nothing to prove.
      assert.equal(bare.chosen.everyday, true, 'with the downloaded browsers hidden, the only one left is his');
      assert.equal(bare.borrowingHis, true);
      assert.match(bare.note, /throwaway/, 'it has to say his profile is not being used');
      assert.match(bare.note, /application slot|icon/, 'it has to say what the cost is, in the words of the thing he actually saw');
      assert.equal(bare.install, INSTALL_COMMAND, 'and it has to carry the one command that ends it');
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      if (realCache === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = realCache;
      survey = await surveyBrowsers({ refresh: true });
    }
  });

  test('what it says out loud names the browser and the reason', () => {
    const said = describeBrowsers(survey).join('\n');
    assert.ok(said.includes(survey.note));
    if (survey.chosen) assert.ok(said.includes(survey.chosen.binary), 'a person has to be able to see which file it will open');
  });
});

describe('opening one', () => {
  /** @type {import('../../src/v2/browsers.js').OpenBrowser|null} */
  let open = null;

  after(async () => {
    await closeEverything();
  });

  test('it opens, answers, and is nowhere near his profile or the port another session owns', { timeout: START_MS }, async () => {
    if (!survey.chosen) return; // Nothing to open on this machine. Reported above.

    open = await openBrowser({ survey });
    assert.equal(openBrowserCount(), 1);

    assert.notEqual(open.port, PORT_NEVER_USE, 'port 9333 belongs to another session on this machine and is never ours to take');
    assert.match(open.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/, 'it listens on this machine only');

    assert.ok(open.userDataDir.startsWith(SCRATCH_ROOT), 'every profile lives under the throwaway root, which is what makes it safe to delete');
    const home = os.homedir();
    for (const theirs of [path.join(home, 'Library', 'Application Support', 'Google'), path.join(home, '.config', 'google-chrome')]) {
      assert.ok(!open.userDataDir.startsWith(theirs), `it must never open the profile at ${theirs}`);
    }

    // It is not enough that a process started. It has to be a browser that answers.
    const said = await (await fetch(`${open.endpoint}/json/version`)).json();
    assert.match(String(said.Browser), /Chrom/i, 'whatever answered on that port has to be the browser we started');
  });

  test('closing it takes the process and the profile away with it', { timeout: START_MS }, async () => {
    if (!open) return;
    const pid = open.pid;
    const profile = open.userDataDir;

    await closeEverything();
    assert.equal(openBrowserCount(), 0);

    if (pid) assert.ok(await waitUntilGone(pid), 'the browser we started has to be gone, not merely asked to go');
    assert.equal(fs.existsSync(profile), false, 'and its throwaway profile has to be gone too');
    open = null;
  });

  test('closing twice is not an error', async () => {
    await closeEverything();
    await closeEverything();
    assert.equal(openBrowserCount(), 0);
  });
});

describe('nothing it opened outlives the run', () => {
  test('not when the run is interrupted', { timeout: START_MS }, async () => {
    if (!survey.chosen) return;
    const { node, browserPid, profile } = await startALeakingRun('block');
    assert.ok(alive(browserPid), 'the browser has to be running before this proves anything');

    // Ctrl-C, which is how most runs actually end.
    node.kill('SIGINT');

    assert.ok(await waitUntilGone(browserPid), 'a browser still running after Ctrl-C is a browser the person now has to hunt down');
    assert.equal(fs.existsSync(profile), false, 'and its profile goes with it');
  });

  test('not when the run falls over', { timeout: START_MS }, async () => {
    if (!survey.chosen) return;
    const { browserPid, profile } = await startALeakingRun('throw');
    assert.ok(await waitUntilGone(browserPid), 'a run that throws must not leave a browser behind either');
    assert.equal(fs.existsSync(profile), false);
  });
});

describe('leftovers from a run that crashed', () => {
  test('a browser orphaned by a killed run is found and quit', { timeout: START_MS }, async () => {
    if (!survey.chosen) return;
    const { node, browserPid } = await startALeakingRun('block');

    // SIGKILL: the laptop died. No handler of ours can possibly run, which is the
    // only case the escape hatch exists for.
    node.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(alive(browserPid), 'the orphan should still be running — that is the whole problem being solved');

    const strays = await findStrays();
    const mine = strays.find((s) => s.pid === browserPid);
    assert.ok(mine, 'the orphan has to be findable, or nobody will ever clear it up');
    assert.equal(mine.running, true);

    const swept = await cleanStrays();
    assert.ok(swept.quit.some((s) => s.pid === browserPid), 'and cleaning has to actually quit it');
    assert.ok(await waitUntilGone(browserPid));
    assert.equal((await findStrays()).some((s) => s.pid === browserPid), false, 'and stop reporting it afterwards');
  });

  test('a browser another Stays Fixed run is still using is left completely alone', { timeout: 30_000 }, async () => {
    // Several agents share this machine and run checks at once. One of them
    // tidying up must never reach into another one's live check and close its
    // browser: that is the two-things-fighting-over-one-resource bug all over
    // again, caused by the tool that exists to catch it.
    const otherRun = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const otherBrowser = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 200));

    const id = 'a-run-that-is-still-going';
    const home = path.join(SCRATCH_ROOT, id);
    await fsp.mkdir(path.join(home, 'profile'), { recursive: true });
    await fsp.writeFile(
      path.join(home, 'open.json'),
      JSON.stringify({ id, pid: otherBrowser.pid, binary: '/somewhere/a-browser', userDataDir: path.join(home, 'profile'), port: 1234, startedAt: new Date().toISOString(), owner: otherRun.pid })
    );

    const mine = (await findStrays()).find((s) => s.id === id);
    assert.ok(mine);
    assert.equal(mine.inUseByAnotherRun, true, 'the run that opened it is still alive, so this is not a leftover at all');

    const swept = await cleanStrays();
    assert.ok(swept.busy.some((s) => s.id === id), 'and cleaning has to say it left it alone rather than silently skipping it');
    assert.ok(alive(otherBrowser.pid ?? 0), 'the other run’s browser must still be running');
    assert.equal(fs.existsSync(home), true, 'and its profile must still be there, because it is still being used');

    otherRun.kill('SIGKILL');
    otherBrowser.kill('SIGKILL');
    await waitUntilGone(otherRun.pid ?? 0);
    await fsp.rm(home, { recursive: true, force: true });
  });

  test('a stale record naming somebody else’s process is never acted on', { timeout: 30_000 }, async () => {
    // The dangerous case. Process ids are recycled within hours, so a record left
    // by a crash three days ago can name a process that now belongs to somebody
    // else entirely. Nothing may be killed on the strength of an id alone.
    const innocent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(innocent.pid && alive(innocent.pid), 'the stand-in for somebody else’s program has to be running');

    const id = 'a-stale-record-from-days-ago';
    const home = path.join(SCRATCH_ROOT, id);
    await fsp.mkdir(path.join(home, 'profile'), { recursive: true });
    await fsp.writeFile(
      path.join(home, 'open.json'),
      // No owner recorded, and a process id that now belongs to somebody else:
      // the shape a record left by a crash three days ago actually has.
      JSON.stringify({ id, pid: innocent.pid, binary: '/somewhere/a-browser', userDataDir: path.join(home, 'profile'), port: 1234, startedAt: '2026-08-01T00:00:00.000Z' })
    );

    const strays = await findStrays();
    const stale = strays.find((s) => s.id === id);
    assert.ok(stale, 'the record should still be listed — it is a leftover folder and it should be swept');
    assert.equal(stale.running, false, 'but the process it names is not ours, so it must never be reported as one of our browsers');

    await cleanStrays();
    assert.ok(alive(innocent.pid), 'and it must still be running: killing it would have been killing a stranger’s program');
    assert.equal(fs.existsSync(home), false, 'the stale folder itself is cleared away, which is the part that was ours');

    innocent.kill('SIGKILL');
  });
});

describe('the escape hatch as a command', () => {
  test('it is a command entry the command line can take as it is', async () => {
    for (const key of ['summary', 'usage', 'describe']) {
      assert.equal(typeof (/** @type {any} */ (BROWSERS_COMMAND)[key]), 'string', `a command entry needs a ${key}`);
      assert.ok(/** @type {any} */ (BROWSERS_COMMAND)[key].length > 0);
    }
    assert.ok(Array.isArray(BROWSERS_COMMAND.options));
    assert.ok(BROWSERS_COMMAND.spec.booleans.includes('clean'), '--clean is the whole point of it');
    assert.ok(BROWSERS_COMMAND.spec.booleans.includes('json'));
    const loaded = await BROWSERS_COMMAND.load();
    assert.equal(typeof loaded.run, 'function');
  });

  test('what it promises about other people’s browsers is written into it', () => {
    // The words matter here. Somebody reading `--help` has to be able to tell
    // that running this cannot take away a browser they are using. Matched with
    // the line breaks flattened, because where the help text wraps is a layout
    // decision and this test is about the promise, not the layout.
    const promise = BROWSERS_COMMAND.describe.replace(/\s+/g, ' ');
    assert.match(promise, /only ever touches something started by this tool/);
    assert.match(promise, /your own browser and anybody else’s cannot be caught by it/);
  });
});

describe('reserving one for something else to start', () => {
  test('the choice, the profile and the flags come from here even when Playwright does the launching', { timeout: START_MS }, async () => {
    if (!survey.chosen) return;
    const held = await reserveBrowser({ survey });
    try {
      assert.equal(held.browser.binary, survey.chosen.binary, 'whoever launches it, the browser picked is the same one');
      assert.ok(held.userDataDir.startsWith(SCRATCH_ROOT), 'and the profile is still a throwaway one under our own root');
      assert.ok(fs.existsSync(held.userDataDir));

      const flags = held.args.join(' ');
      assert.ok(flags.includes(`--user-data-dir=${held.userDataDir}`), 'the profile flag has to be handed over, not left to the caller to remember');
      assert.equal(/--remote-debugging-port/.test(flags), false, 'a port we are not choosing must not be named, or two things end up fighting over it');
      assert.match(flags, /--force-color-profile=srgb/, 'the determinism flags travel with the reservation');
    } finally {
      await held.release();
    }
    assert.equal(fs.existsSync(held.userDataDir), false, 'giving a reservation back with nothing opened leaves nothing behind');
  });

  test('once handed over, it is covered by everything else in here', { timeout: START_MS }, async () => {
    if (!survey.chosen) return;
    const held = await reserveBrowser({ survey });

    // Stand in for Playwright: something else owns the process and hands back
    // only a way to stop it.
    let stopped = false;
    const pretendProcess = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    held.startedBy(async () => {
      stopped = true;
      pretendProcess.kill('SIGKILL');
    }, pretendProcess.pid ?? null);

    assert.equal(openBrowserCount(), 1, 'a handed-over browser counts as open, or nothing will ever close it');

    await closeEverything();
    assert.equal(stopped, true, 'closeEverything has to use the way out the launcher gave it');
    assert.equal(openBrowserCount(), 0);
    assert.equal(fs.existsSync(held.userDataDir), false, 'and the throwaway profile goes too');
    assert.ok(await waitUntilGone(pretendProcess.pid ?? 0));
  });
});

describe('the suite that proves all this does not itself take his browser', () => {
  test('while these tests run, the browser they open is not the one he uses', async () => {
    // The rule has to hold for this repository too, and for two and a half minutes
    // of every run it did not: the version 1 picture tests opened his own Chrome,
    // headless, which is the exact thing that took his browser away from him. The
    // `npm test` script now picks one of our own and hands it down through
    // STAYSFIXED_CHROME, which version 1 already honours.
    const chosen = process.env.STAYSFIXED_CHROME;
    if (!chosen) {
      // Somebody ran the raw runner (`npm run test:in-your-browser`) or has no
      // other browser. Both are legitimate; neither proves anything here.
      return;
    }
    const his = survey.found.filter((b) => b.everyday).map((b) => b.binary);
    assert.equal(his.includes(chosen), false, `these tests are running in ${chosen}, which is the browser he uses`);
  });
});

describe('when his is the only browser here', () => {
  test('a visible window is quietly downgraded to an invisible one — and it is not quiet about it', { timeout: START_MS }, async () => {
    // Asking for a visible copy of his own browser IS the incident: that is what
    // put a window-less Chrome in his application slot. It is downgraded rather
    // than refused, because refusing would stop a check that is otherwise fine.
    const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-nohome-'));
    const realHome = process.env.HOME;
    const realCache = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.HOME = empty;
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(empty, 'no-browsers-here');
    try {
      const bare = await surveyBrowsers({ refresh: true, headless: false });
      if (!bare.chosen?.everyday) return; // Something of our own is still reachable here.

      const held = await reserveBrowser({ survey: bare, headless: false });
      try {
        assert.equal(held.browser.everyday, true);
        assert.equal(held.headless, true, 'a visible copy of his own browser is the exact thing that must never happen');
        assert.ok(held.notes.length >= 2, 'and it has to say both that it borrowed his browser and that it overruled the request');
        assert.match(held.notes.join(' '), /run invisibly instead/);
        assert.equal(held.args.includes('--headless=new'), true);
      } finally {
        await held.release();
      }
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      if (realCache === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = realCache;
      survey = await surveyBrowsers({ refresh: true });
    }
  });
});
