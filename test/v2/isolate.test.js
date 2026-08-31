/**
 * Running a copy of somebody's app without touching the one they are using.
 *
 * Everything in this file is about one promise: the app this tool opens gets its own
 * settings, its own cache, its own ports and its own name, and when the check is over it is
 * gone. Breaking that promise does not fail a check — it quietly eats a person's real
 * settings, or leaves a scratch copy of their app sitting on their screen, and neither of
 * those shows up as a red line anywhere.
 *
 * The second promise is smaller and just as easy to lose: the tool SAYS what it is opening,
 * before the thing appears. Whatever is looking after the person's screen during a check has
 * to know that this application belongs to the tool before its window arrives, or the app's
 * first appearance is read as the person having chosen it and it is never handed back.
 *
 * Nothing here needs a real desktop app. Where a process genuinely has to be started, Node
 * itself is started — it is on every machine that can run this test at all, it does exactly
 * what it is told, and it proves the same things a real app would about announcing, keeping
 * what was said, and being closed properly afterwards.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  PORTS_THAT_ARE_NOT_OURS,
  appNameFor,
  describeIsolation,
  isolationArgs,
  onAppStarted,
  portFree,
  releaseIsolation,
  reserveIsolation,
  startIsolated,
  stillOpen,
  takePort,
} from '../../src/v2/adapters/isolate.js';
import { scratchDir, cleanUp, TEMP_ENV_VAR } from '../support.mjs';
import { sweepAbandonedScratch, guardNames } from '../../src/v2/check.js';
import { spawnServer, stopServer } from '../../src/v2/adapters/child.js';

after(cleanUp);

/**
 * The same isolation with the browser flags taken off.
 *
 * What is being started below is Node, because Node is on every machine this test can run on
 * at all and does exactly what it is told. It refuses Chromium's flags outright, and the
 * flags are not what these cases are about — that they are right is its own test above. The
 * folders, the environment and the announcement are untouched.
 *
 * @param {any} isolation
 * @returns {any}
 */
function plainly(isolation) {
  return { ...isolation, args: [] };
}

/**
 * One isolation in a throwaway folder, closed again by the caller.
 * @param {object} [over]
 * @returns {Promise<any>}
 */
async function reserve(over = {}) {
  const root = await scratchDir('staysfixed-isolate');
  return reserveIsolation({ scratchDir: root, label: 'the old build', appId: 'com.example.shop', ...over });
}

// ---------------------------------------------------------------------------
// Its own everything
// ---------------------------------------------------------------------------

describe('one run, on its own', () => {
  test('it gets its own folders, and they really exist before anything starts', async () => {
    const one = await reserve();
    try {
      for (const folder of [one.userDataDir, one.homeDir, one.tmpDir, one.cacheDir, one.crashDir]) {
        const there = await fsp.stat(folder);
        assert.ok(there.isDirectory(), `${folder} is not a folder`);
        assert.ok(folder.startsWith(one.dir), `${folder} is outside the run's own folder`);
      }
    } finally {
      await releaseIsolation(one);
    }
  });

  test('nothing it is handed points anywhere near a real settings folder', async () => {
    const one = await reserve();
    try {
      const home = os.homedir();
      const throwaway = path.resolve(os.tmpdir()) + path.sep;
      // The folder has to be one the operating system itself calls temporary. That is the
      // real promise, and it is the one that means the same thing everywhere.
      assert.ok(
        path.resolve(one.userDataDir).startsWith(throwaway),
        `the settings folder has to be inside this machine's own throwaway folder, and it is at ${one.userDataDir}`,
      );
      for (const real of ['Library/Application Support', '.config', 'AppData']) {
        const forbidden = path.join(home, real) + path.sep;
        // On Windows the throwaway folder lives INSIDE AppData — it is
        // `C:\Users\me\AppData\Local\Temp` — so "under AppData" and "somebody's real
        // settings" are not the same question there, and asking the first one failed this
        // case on a real Windows 11 machine on 2026-08-31 about a folder that was correct.
        // Where the two overlap, the line above is the assertion that still means something.
        if (throwaway.startsWith(forbidden)) continue;
        assert.ok(!one.userDataDir.startsWith(forbidden), `the settings folder is inside ${forbidden}`);
        assert.ok(!String(one.env.HOME).startsWith(forbidden), `HOME is inside ${forbidden}`);
      }
      assert.equal(one.env.HOME, one.homeDir, 'the app would have read the real home folder');
      assert.equal(one.env.TMPDIR, one.tmpDir);
    } finally {
      await releaseIsolation(one);
    }
  });

  test('a scratch folder that is really somebody\'s settings is refused outright', async () => {
    // The whole rule, checked at the one place it can be checked: a run must never be
    // pointed at a folder where real settings live, whatever told it to.
    for (const real of [path.join(os.homedir(), '.config'), path.join(os.homedir(), 'Library', 'Application Support')]) {
      await assert.rejects(
        () => reserveIsolation({ scratchDir: real, label: 'no' }).then((one) => releaseIsolation(one)),
        /real settings live|will not point an app at/,
        `a run was allowed to make its folder inside ${real}`,
      );
    }
  });

  test('two runs never share a port, and neither ever takes the paired browser\'s', async () => {
    const a = await reserve();
    const b = await reserve();
    try {
      const ports = [a.debugPort, a.inspectPort, b.debugPort, b.inspectPort];
      assert.equal(new Set(ports).size, 4, `two runs were handed the same port: ${ports.join(', ')}`);
      for (const port of ports) {
        assert.ok(!PORTS_THAT_ARE_NOT_OURS.has(port), `port ${port} belongs to the person's own browser`);
      }
    } finally {
      await releaseIsolation(a);
      await releaseIsolation(b);
    }
  });

  test('a port handed out is one nothing was listening on', async () => {
    const port = await takePort();
    assert.equal(await portFree(port), true, `port ${port} was handed out with something already on it`);
  });

  test('the name is the SAME every time the same app is checked, on purpose', async () => {
    const a = await reserve({ appId: 'com.example.shop' });
    const b = await reserve({ appId: 'com.example.shop' });
    const c = await reserve({ appId: 'com.example.other' });
    try {
      assert.equal(a.identity, b.identity, 'a new name each run would report as a difference on every single run');
      assert.notEqual(a.identity, c.identity, 'two different apps were given one name and would fight over it');
    } finally {
      for (const one of [a, b, c]) await releaseIsolation(one);
    }
  });

  test('anywhere the app signs in is told the throwaway name, not the real one', async () => {
    const one = await reserve({ identityEnv: { RELAY_SLOT: 'slot-{identity}' } });
    try {
      assert.equal(one.env.RELAY_SLOT, `slot-${one.identity}`);
      assert.ok(one.notes.some((/** @type {string} */ n) => n.includes('registers as itself')), one.notes.join(' '));
    } finally {
      await releaseIsolation(one);
    }
  });

  test('an app told nothing about who it is says so, rather than looking fine', async () => {
    const one = await reserve();
    try {
      assert.ok(
        one.notes.some((/** @type {string} */ n) => n.includes('identityEnv')),
        'nothing warned that the scratch copy may sign in as the real install',
      );
    } finally {
      await releaseIsolation(one);
    }
  });

  test('the flags point at the run\'s own folders and its own ports', async () => {
    const one = await reserve();
    try {
      const args = isolationArgs(one);
      assert.ok(args.includes(`--user-data-dir=${one.userDataDir}`), args.join(' '));
      assert.ok(args.includes(`--disk-cache-dir=${one.cacheDir}`), args.join(' '));
      assert.ok(args.includes(`--remote-debugging-port=${one.debugPort}`), args.join(' '));
      assert.ok(args.some((/** @type {string} */ a) => a.includes(`=${one.inspectPort}`)), args.join(' '));
      // Determinism, not isolation: a window that is still animating is a window read
      // halfway through something.
      assert.ok(args.includes('--force-prefers-reduced-motion'), args.join(' '));
    } finally {
      await releaseIsolation(one);
    }
  });

  test('and it can say all that in plain English', async () => {
    const one = await reserve();
    try {
      const said = describeIsolation(one);
      assert.ok(said.includes('the old build'), said);
      assert.ok(said.includes(String(one.debugPort)), said);
      assert.ok(said.includes(one.identity), said);
    } finally {
      await releaseIsolation(one);
    }
  });
});

// ---------------------------------------------------------------------------
// What it is called on a screen
// ---------------------------------------------------------------------------

describe('what to call the thing that just opened', () => {
  test('a Mac app is called by its bundle, never by the executable buried inside it', () => {
    assert.equal(appNameFor('/Applications/Terminal Deck.app/Contents/MacOS/Electron'), 'Terminal Deck');
    assert.equal(appNameFor('/Applications/Foo.app/Contents/MacOS/Foo'), 'Foo');
  });

  test('and anything else is called by its own name, without the extension', () => {
    assert.equal(appNameFor('/usr/local/bin/shop'), 'shop');
    assert.equal(appNameFor('C:\\Program Files\\shop\\shop.exe'.split('\\').join(path.sep)), 'shop');
    assert.equal(appNameFor(''), '');
  });
});

// ---------------------------------------------------------------------------
// Saying what it opened, before it appears
// ---------------------------------------------------------------------------

describe('announcing every app it launches', () => {
  test('the launch is said out loud, with the name the screen will use', async () => {
    const one = await reserve({ label: 'shop 1.0.0' });
    /** @type {any[]} */
    const heard = [];
    const stopListening = onAppStarted((app) => heard.push(app));
    try {
      const app = startIsolated(plainly(one), { binary: process.execPath, extraArgs: ['-e', 'setTimeout(()=>{},50)'] });
      assert.equal(heard.length, 1, 'an app was opened and nothing was told about it');
      assert.equal(heard[0].name, appNameFor(process.execPath));
      assert.equal(heard[0].binary, process.execPath);
      assert.equal(heard[0].label, 'shop 1.0.0');
      assert.equal(heard[0].pid, app.pid, 'the announcement named a different process than the one that started');
      assert.ok(app.pid > 0);
    } finally {
      stopListening();
      await releaseIsolation(one);
    }
  });

  test('a listener that throws never takes the launch down with it', async () => {
    const one = await reserve();
    const stopBad = onAppStarted(() => {
      throw new Error('a watcher fell over');
    });
    /** @type {any[]} */
    const heard = [];
    const stopGood = onAppStarted((app) => heard.push(app));
    try {
      const app = startIsolated(plainly(one), { binary: process.execPath, extraArgs: ['-e', 'setTimeout(()=>{},50)'] });
      assert.ok(app.pid > 0, 'a broken watcher stopped the app from opening');
      assert.equal(heard.length, 1, 'a broken watcher stopped everybody else being told');
    } finally {
      stopBad();
      stopGood();
      await releaseIsolation(one);
    }
  });

  test('nobody is told after they have stopped listening', async () => {
    const one = await reserve();
    /** @type {any[]} */
    const heard = [];
    onAppStarted((app) => heard.push(app))();
    try {
      startIsolated(plainly(one), { binary: process.execPath, extraArgs: ['-e', 'setTimeout(()=>{},50)'] });
      assert.equal(heard.length, 0);
    } finally {
      await releaseIsolation(one);
    }
  });

  test('what the app said is kept, and so is how it ended', async () => {
    const one = await reserve();
    try {
      const app = startIsolated(plainly(one), {
        binary: process.execPath,
        extraArgs: ['-e', 'process.stdout.write("open for business"); process.exit(3)'],
      });
      await new Promise((done) => app.child.once('exit', done));
      // The exit and the last of the output can land a tick apart.
      await new Promise((go) => setTimeout(go, 50));
      assert.ok(app.said().includes('open for business'), `nothing was kept: ${JSON.stringify(app.said())}`);
      assert.equal(app.finished()?.code, 3, 'how the app ended was not written down');
    } finally {
      await releaseIsolation(one);
    }
  });

  test('the app is started inside the run\'s own world, not this process\'s', async () => {
    const one = await reserve();
    try {
      const app = startIsolated(plainly(one), {
        binary: process.execPath,
        extraArgs: ['-e', 'process.stdout.write(JSON.stringify({home: process.env.HOME, id: process.env.STAYSFIXED_IDENTITY}))'],
      });
      await new Promise((done) => app.child.once('exit', done));
      await new Promise((go) => setTimeout(go, 50));
      const said = JSON.parse(app.said().trim());
      assert.equal(said.home, one.homeDir, 'the app could see the real home folder');
      assert.equal(said.id, one.identity);
    } finally {
      await releaseIsolation(one);
    }
  });
});

// ---------------------------------------------------------------------------
// And gone afterwards
// ---------------------------------------------------------------------------

describe('proving it is gone', () => {
  test('the app is stopped, its folder is taken away, and it says so', async () => {
    const one = await reserve();
    const app = startIsolated(plainly(one), { binary: process.execPath, extraArgs: ['-e', 'setInterval(()=>{}, 1000)'] });
    assert.ok(app.pid > 0);

    const report = await releaseIsolation(one);
    assert.equal(report.proved, true, report.why);
    assert.ok(report.why.includes('The next run starts alone.'), report.why);
    await assert.rejects(() => fsp.stat(one.dir), "the run's folder was left behind");
    assert.equal(await portFree(one.debugPort), true, 'the debugging port is still held');
  });

  test('a run that is closed is no longer counted as open', async () => {
    const before = stillOpen();
    const one = await reserve();
    assert.equal(stillOpen(), before + 1);
    await releaseIsolation(one);
    assert.equal(stillOpen(), before, 'a closed run is still being counted, so the safety net would chase it');
  });

  test('closing twice is safe, because a check that threw closes everything again', async () => {
    const one = await reserve();
    await releaseIsolation(one);
    const again = await releaseIsolation(one);
    assert.equal(again.proved, true, again.why);
  });
});

describe('copies left behind by a run that never finished', () => {
  test('an abandoned copy is reclaimed and one still in use is left completely alone', async () => {
    // A check copies the whole project into a scratch folder, and a killed run never gets to
    // delete it. Nothing else ever did either: measured on 2026-08-30, an ordinary machine
    // had 777 MB of them sitting in the temporary folder, one copy 485 MB, and later runs
    // added to the pile rather than clearing it.
    const here = await scratchDir('staysfixed-sweeproot');
    // The variable this operating system actually reads. Windows reads TEMP, not TMPDIR, so
    // setting TMPDIR there left the sweep looking at the machine's real temporary folder and
    // the three folders written below were never in front of it. Measured on a real Windows 11
    // machine on 2026-08-31.
    const realTmp = process.env[TEMP_ENV_VAR];
    process.env[TEMP_ENV_VAR] = here;
    try {
      const dead = path.join(here, 'staysfixed-check-dead');
      const busy = path.join(here, 'staysfixed-check-busy');
      const nameless = path.join(here, 'staysfixed-check-nameless');
      for (const d of [dead, busy, nameless]) await fsp.mkdir(d, { recursive: true });
      // 999997 is not a process. This one is: we are it.
      await fsp.writeFile(path.join(dead, 'owner.json'), JSON.stringify({ pid: 999997 }));
      await fsp.writeFile(path.join(busy, 'owner.json'), JSON.stringify({ pid: process.pid }));

      await sweepAbandonedScratch();

      assert.equal(fs.existsSync(dead), false, 'a copy whose owner is gone is the whole point');
      assert.equal(fs.existsSync(busy), true, 'and one still in use must never be touched');
      // No owner recorded and made moments ago: too young to judge, so it stays. Deleting it
      // would be exactly the mistake this guards against, one directory along.
      assert.equal(fs.existsSync(nameless), true, 'a fresh copy with no owner is not evidence of abandonment');
    } finally {
      if (realTmp === undefined) delete process.env[TEMP_ENV_VAR];
      else process.env[TEMP_ENV_VAR] = realTmp;
    }
  });
});

describe('the guards a project has', () => {
  test('their names are found, so the seal that exists because somebody was burned can fire', async () => {
    // `settle` takes guard names so a difference touching a bug somebody already had once is
    // sealed and no agent may wave it through. Both call sites handed it nothing, so that
    // class was empty on every run this tool has ever done — and a check on a project with a
    // guard sitting in `.staysfixed/guards` printed the word "guard" exactly zero times.
    // Measured 2026-08-30.
    const root = await scratchDir('staysfixed-guards');
    const dir = path.join(root, '.staysfixed', 'guards');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'order-button.guard.mjs'),
      [
        'export default {',
        "  name: 'the order button is still on the front page',",
        "  fixed: '2026-08-30',",
        "  because: 'It was removed once by a careless edit and nobody noticed for a week.',",
        '  async run() {},',
        '}',
        '',
      ].join('\n'),
    );

    assert.deepEqual(await guardNames(root), ['the order button is still on the front page']);
  });

  test('a project with no guards is not an error, it is just none', async () => {
    const root = await scratchDir('staysfixed-noguards');
    assert.deepEqual(await guardNames(root), []);
  });
});

describe('stopping the product, and everything the product started', () => {
  test('a server the start command spawned as its own child is stopped too', async (t) => {
    // A start command is run through a shell, because that is what people write. So the
    // thing spawned is the SHELL and the server is its child — `npm run dev` is npm, which
    // runs next, which runs node. Killing the shell left the server running, and because the
    // shell's stdout is a pipe every survivor inherits the writing end of it, so the pipe
    // never closed, the event loop never emptied, and `staysfixed check` printed its whole
    // answer and then hung for ever. Measured 2026-08-30: the verdict in about thirty
    // seconds, and the command never came back.
    if (process.platform === 'win32') return t.skip('process groups work differently on Windows');

    const dir = await scratchDir('staysfixed-stop');
    const pidFile = path.join(dir, 'grandchild.pid');
    // The shell starts a long-lived grandchild and then waits, which is the shape that broke.
    const child = spawnServer(
      `node -e 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)' ${JSON.stringify(pidFile)} & wait`,
      { cwd: dir, env: process.env },
    );

    // Wait for the grandchild to say who it is.
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        pid = Number(await fsp.readFile(pidFile, 'utf8'));
      } catch {
        pid = 0;
      }
    }
    assert.ok(pid > 0, 'the grandchild has to be running before this proves anything');
    assert.equal(alive(pid), true);

    await stopServer(child);

    // It may take the kernel a moment to reap it.
    for (let i = 0; i < 100 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(pid), false, 'the server the start command started has to go with it');
  });
});

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
