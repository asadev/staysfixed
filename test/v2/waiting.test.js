/**
 * Waiting for a server to come up — and, far more importantly, giving up out loud.
 *
 * These tests exist because of a measured failure on the most ordinary project there is.
 * On 2026-08-31, on a Mac, on an app scaffolded thirty seconds earlier with
 * `npm create vite@latest -- --template react-ts`, `staysfixed check --paired` took
 * 3 minutes 2 seconds and reported "The server never answered on port 64912 within 90..."
 * — which names the port and nothing else. The server had been up the whole time. It was
 * listening on `[::1]` because Vite binds `localhost` and this machine resolves that name
 * to the IPv6 loopback first, and the check was knocking on `127.0.0.1`, where the operating
 * system refused every knock in under a millisecond, four hundred and fifty times, for
 * ninety seconds, on each side of the comparison.
 *
 * So there are two separate things being held in place here and the second one matters more:
 *
 *   1. A server on either loopback address is FOUND, and the address that answered is the
 *      one handed to the browser afterwards.
 *   2. A wait that is going to fail says so within a second or two and names the command it
 *      ran, the address it waited on, and the address the command printed instead. Ninety
 *      seconds of silence is indistinguishable from a broken tool, which is the real damage.
 *
 * Nothing here needs Vite, or a browser, or a framework. The same code path is driven with
 * six-line Node scripts that listen where they are told to listen and print what they are
 * told to print, because that is all Vite was ever doing.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { announcedAddresses, freePort, loopbackUrl, waitForServer } from '../../src/v2/adapters/http.js';
import { spawnServer, stopServer } from '../../src/v2/adapters/child.js';

/** @type {string} */
let scratch;
/** @type {import('node:child_process').ChildProcess[]} */
const started = [];

before(async () => {
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'sfx-waiting-'));
});

after(async () => {
  for (const child of started) await stopServer(child);
  if (scratch) await fsp.rm(scratch, { recursive: true, force: true });
});

/**
 * Write a tiny program and start it the way a real `start` command is started.
 *
 * Through `spawnServer` on purpose: the shell, the process group and the pipes are part of
 * what is being tested, and a plain `spawn` would test a path nothing uses.
 *
 * @param {string} name
 * @param {string} source
 * @param {Record<string, string>} [env]
 * @returns {Promise<{command: string, printed: () => string, exited: () => string|null}>}
 */
async function run(name, source, env = {}) {
  const file = path.join(scratch, name);
  await fsp.writeFile(file, source, 'utf8');
  const command = `node ${name}`;
  const child = spawnServer(command, { cwd: scratch, env: { ...process.env, ...env } });
  started.push(child);
  /** @type {Buffer[]} */
  const said = [];
  child.stdout?.on('data', (c) => said.push(c));
  child.stderr?.on('data', (c) => said.push(c));
  /** @type {string|null} */
  let gone = null;
  child.on('close', (code) => {
    gone = `It stopped before it answered - exit code ${code}.`;
  });
  return { command, printed: () => Buffer.concat(said).toString('utf8'), exited: () => gone };
}

/** Does this machine have an IPv6 loopback at all? Some do not, and that is not a failure. */
async function hasIpv6Loopback() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.on('error', () => resolve(false));
    try {
      probe.listen(0, '::1', () => probe.close(() => resolve(true)));
    } catch {
      resolve(false);
    }
  });
}

describe('reading the address a server printed', () => {
  test('finds the one Vite prints, colour codes and all', () => {
    const vite = '[32m  [39m[32m➜[39m  [1mLocal[22m:   [36mhttp://localhost:[1m5173[22m/[39m\n';
    const found = announcedAddresses(vite.replace('[1m5173[22m', '5173'));
    assert.deepEqual(found.map((one) => one.port), [5173]);
    assert.equal(found[0].host, 'localhost');
  });

  test('finds the ones Next, uvicorn and a bare listener print', () => {
    const text = [
      '- Local:        http://localhost:3000',
      'INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)',
      'listening on http://[::1]:4321/',
    ].join('\n');
    assert.deepEqual(announcedAddresses(text).map((one) => one.port), [3000, 8000, 4321]);
  });

  test('says the same address once, however many times it was printed', () => {
    const text = 'up at http://localhost:5173/ ... still at http://localhost:5173/health';
    assert.equal(announcedAddresses(text).length, 1);
  });

  test('ignores a link with no port in it, which is most of what npm prints', () => {
    const text = 'npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.0.2';
    assert.deepEqual(announcedAddresses(text), []);
  });

  test('an IPv6 address gets its brackets and nothing else does', () => {
    assert.equal(loopbackUrl('::1', 5173), 'http://[::1]:5173');
    assert.equal(loopbackUrl('[::1]', 5173), 'http://[::1]:5173');
    assert.equal(loopbackUrl('127.0.0.1', 5173), 'http://127.0.0.1:5173');
    assert.equal(loopbackUrl('localhost', 5173), 'http://localhost:5173');
  });
});

describe('a server on the other loopback address', () => {
  test('is found, and the address that answered is the one given back', async (t) => {
    if (!(await hasIpv6Loopback())) {
      t.skip('this machine has no IPv6 loopback, so there is no second address to find');
      return;
    }
    const port = await freePort();
    // This is exactly what `vite preview` does on this Mac and nothing more: bind the name
    // `localhost`, which resolves to the IPv6 loopback first, and print where it landed.
    const app = await run('binds-ipv6.cjs', [
      "const net = require('node:net');",
      'const port = Number(process.env.PORT);',
      "net.createServer((s) => s.end()).listen(port, '::1', () => console.log('  Local:   http://localhost:' + port + '/'));",
    ].join('\n'), { PORT: String(port) });

    const began = Date.now();
    const up = await waitForServer(port, {
      timeoutMs: 15000,
      command: app.command,
      announced: app.printed,
      crashed: app.exited,
    });
    assert.equal(up.up, true, `it should have been found: ${up.why}`);
    assert.equal(up.baseUrl, `http://[::1]:${port}`);
    assert.ok(Date.now() - began < 10000, 'it should have been found in seconds, not after a timeout');
  });
});

describe('a wait that is going to fail says so at once, in words', () => {
  test('a command that came up on a different port is named within seconds', async () => {
    const port = await freePort();
    // A command that ignored the PORT it was given. Nothing will ever answer where the check
    // is knocking, and the command said so on its first line. Before 2026-08-31 this cost
    // ninety seconds and gave back a sentence containing only a port number.
    const app = await run('prints-elsewhere.cjs', [
      "console.log('  Local:   http://localhost:5173/');",
      'setInterval(() => {}, 1000);',
    ].join('\n'));

    const began = Date.now();
    const up = await waitForServer(port, {
      timeoutMs: 90000,
      command: app.command,
      announced: app.printed,
      crashed: app.exited,
    });
    const took = Date.now() - began;

    assert.equal(up.up, false);
    assert.equal(up.outcome, 'wrong address');
    assert.ok(took < 10000, `it should have given up in seconds; it took ${Math.round(took / 1000)}s`);
    // The three facts a person needs and never had: what was run, where it came up, where
    // the check was waiting.
    assert.ok(up.why.includes(app.command), `it must name the command it ran: ${up.why}`);
    assert.ok(up.why.includes('http://localhost:5173'), `it must name the address the command printed: ${up.why}`);
    assert.ok(up.why.includes(`http://127.0.0.1:${port}`), `it must name the address it waited on: ${up.why}`);
    assert.ok(/PORT/.test(up.why), `it must say what to do about it: ${up.why}`);
  });

  test('a command that exited is named, along with the address nothing ever answered at', async () => {
    const port = await freePort();
    const app = await run('gives-up.cjs', ["console.error('boom');", 'process.exit(1);'].join('\n'));

    const began = Date.now();
    const up = await waitForServer(port, {
      timeoutMs: 90000,
      command: app.command,
      announced: app.printed,
      crashed: app.exited,
    });
    const took = Date.now() - began;

    assert.equal(up.up, false);
    assert.equal(up.outcome, 'exited');
    assert.ok(took < 10000, `it should have given up as soon as the command died; it took ${Math.round(took / 1000)}s`);
    assert.ok(up.why.includes(app.command), `it must name the command it ran: ${up.why}`);
    assert.ok(up.why.includes(`http://127.0.0.1:${port}`), `it must name the address it waited on: ${up.why}`);
  });

  test('a silent server that never comes up is talked about while it is waited for', async () => {
    const port = await freePort();
    // Deliberately NOT stopped early. A server that has not opened its port yet is refused in
    // exactly the same way as one that never will be, and cutting this short would turn a slow
    // build into a reported failure - which is the one thing this product may never do. What
    // changed is that the wait says what it is waiting for while it waits.
    const app = await run('says-nothing.cjs', ['setInterval(() => {}, 1000);'].join('\n'));

    /** @type {string[]} */
    const spoken = [];
    const up = await waitForServer(port, {
      timeoutMs: 6000,
      command: app.command,
      announced: app.printed,
      crashed: app.exited,
      say: (message) => spoken.push(message),
    });

    assert.equal(up.up, false);
    assert.equal(up.outcome, 'never answered');
    assert.ok(spoken.length > 0, 'it must say what it is waiting for rather than going silent');
    assert.ok(spoken[0].includes(app.command), `the running commentary must name the command: ${spoken[0]}`);
    assert.ok(spoken[0].includes(`http://127.0.0.1:${port}`), `the running commentary must name the address: ${spoken[0]}`);
    assert.ok(up.why.includes(app.command), `the verdict must name the command: ${up.why}`);
    assert.ok(up.why.includes(`http://127.0.0.1:${port}`), `the verdict must name the address: ${up.why}`);
    assert.ok(/refused/.test(up.why), `the verdict must say nothing was listening, not that it was slow: ${up.why}`);
    assert.ok(/never printed an address/.test(up.why), `the verdict must say the command named no address: ${up.why}`);
  });
});

describe('the port that is handed out', () => {
  test('is free on BOTH families, not just the one it was claimed on', async () => {
    // Now that a server is looked for on `::1` as well, a port that is free on IPv4 and taken
    // on IPv6 would have this tool connect to a STRANGER'S program and walk it as though it
    // were the build being checked. That is a false all-clear, which is the one thing this
    // product exists not to do.
    const ipv6 = await hasIpv6Loopback();
    for (let i = 0; i < 5; i += 1) {
      const port = await freePort();
      for (const host of ipv6 ? ['127.0.0.1', '::1'] : ['127.0.0.1']) {
        const busy = await new Promise((resolve) => {
          const socket = net.connect({ port, host });
          const done = (/** @type {boolean} */ answer) => {
            socket.destroy();
            resolve(answer);
          };
          socket.setTimeout(500);
          socket.on('connect', () => done(true));
          socket.on('error', () => done(false));
          socket.on('timeout', () => done(false));
        });
        assert.equal(busy, false, `port ${port} was already in use on ${host}`);
      }
    }
  });
});
