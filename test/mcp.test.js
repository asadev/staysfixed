/**
 * The VERSION 1 MCP server — the picture tools — spoken to the way a coding agent
 * speaks to it: a real process, real JSON-RPC, over real pipes.
 *
 * It is reached with `staysfixed mcp --v1` now. `staysfixed mcp` on its own serves the
 * difference engine, which is what every document about this tool describes and what
 * test/v2/mcp.test.js holds it to. This file is the promise to everybody who wired the
 * picture tools up before that: they still work, unchanged, behind one flag. If this file
 * ever has to be deleted, that promise is being broken and it should be a decision rather
 * than a tidy-up.
 *
 * Two things matter more than the rest. Stdout is the protocol — one stray
 * printed word corrupts the stream and the agent's client dies with an error
 * pointing nowhere near the cause. And `staysfixed_approve` must not be on the
 * list unless the project opted in: an agent that can bless its own screenshots
 * would edit the code, notice the picture moved, approve it, and report success.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { cliPath, copyFixture, cleanUp } from './support.mjs';

/** The tools every project gets. */
const ALWAYS = [
  'staysfixed_check',
  'staysfixed_capture',
  'staysfixed_screens',
  'staysfixed_status',
  'staysfixed_trace',
];

/** The doors that stay shut unless a person opened them in the settings. */
const OPT_IN = ['staysfixed_approve', 'staysfixed_mark'];

/**
 * A live MCP server, with everything it ever wrote kept for inspection.
 * @typedef {object} Server
 * @property {(method: string, params?: Record<string, unknown>) => Promise<any>} request
 * @property {(method: string, params?: Record<string, unknown>) => void} notify
 * @property {() => string} stdout      Every byte it put on stdout.
 * @property {() => string} stderr
 * @property {() => Promise<void>} stop
 */

/**
 * @param {string} cwd
 * @returns {Server}
 */
function startServer(cwd) {
  // No `stdio` option on purpose: the default is a pipe on all three, and it is
  // the only shape that guarantees the streams are there to listen to.
  const child = spawn(process.execPath, [cliPath, 'mcp', '--v1'], {
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
  });

  let out = '';
  let err = '';
  let pending = '';
  let nextId = 0;
  /** @type {Map<number, (message: any) => void>} */
  const waiting = new Map();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
    pending += chunk;
    let at = pending.indexOf('\n');
    while (at !== -1) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (line.trim() !== '') {
        const message = JSON.parse(line);
        const settle = typeof message.id === 'number' ? waiting.get(message.id) : undefined;
        if (settle) {
          waiting.delete(message.id);
          settle(message);
        }
      }
      at = pending.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });

  return {
    request(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the server never answered ${method}`)), 120_000);
        waiting.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method, params = {}) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    stdout: () => out,
    stderr: () => err,
    stop() {
      return new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.stdin.end();
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      });
    },
  };
}

describe('the MCP server', () => {
  /** @type {Server} */
  let server;
  /** @type {string} */
  let dir;

  before(async () => {
    dir = await copyFixture();
    server = startServer(dir);
  });

  after(async () => {
    if (server) await server.stop();
    await cleanUp();
  });

  test('it introduces itself', async () => {
    const reply = await server.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'the test suite', version: '1.0.0' },
    });

    assert.equal(reply.jsonrpc, '2.0');
    assert.equal(reply.error, undefined);
    assert.match(String(reply.result.protocolVersion), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(reply.result.serverInfo.name, 'staysfixed');
    assert.match(String(reply.result.serverInfo.version), /^\d+\.\d+\.\d+/);
    assert.ok(reply.result.capabilities.tools, 'a server with no tools is no use to an agent');

    server.notify('notifications/initialized');
  });

  test('the tool list is exactly what this project has opted into', async () => {
    const reply = await server.request('tools/list');
    assert.equal(reply.error, undefined);

    const names = reply.result.tools.map((/** @type {{name: string}} */ t) => t.name);
    assert.deepEqual(names.slice().sort(), ALWAYS.slice().sort());

    for (const shut of OPT_IN) {
      assert.ok(
        !names.includes(shut),
        `${shut} is on the list by default. An agent must never be shown a door it is not allowed through.`,
      );
    }
  });

  test('every tool tells an agent what it is for and what it takes', async () => {
    const reply = await server.request('tools/list');
    for (const tool of reply.result.tools) {
      assert.ok(tool.description.length > 60, `${tool.name} barely describes itself`);
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.inputSchema.properties, `${tool.name} has no input schema`);
    }

    const check = reply.result.tools.find((/** @type {{name: string}} */ t) => t.name === 'staysfixed_check');
    // The one thing the agent has to be told, every time it reads the list.
    assert.match(check.description, /only a person can|cannot approve/i);
  });

  test('a tool that does not open the app answers with something useful', async () => {
    const reply = await server.request('tools/call', { name: 'staysfixed_screens', arguments: {} });
    assert.equal(reply.error, undefined);
    const text = reply.result.content.map((/** @type {any} */ c) => c.text ?? '').join('\n');
    assert.match(text, /home/);
    assert.match(text, /details/);
    assert.match(text, /the details button still opens the details page/);
  });

  test('asking for a tool that is not offered is refused, not quietly obeyed', async () => {
    const reply = await server.request('tools/call', {
      name: 'staysfixed_approve',
      arguments: { screen: 'home', reason: 'because I said so' },
    });
    // Either shape is fine — a protocol error or a tool result that says no —
    // as long as nothing was approved.
    const said = reply.error
      ? String(reply.error.message)
      : reply.result.content.map((/** @type {any} */ c) => c.text ?? '').join('\n');
    assert.match(said, /approve|not|unknown/i);
    assert.equal(reply.result?.isError ?? true, true);

    const approved = await fsp
      .readdir(path.join(dir, '.staysfixed', 'approved'))
      .catch(() => /** @type {string[]} */ ([]));
    assert.deepEqual(approved.filter((f) => f.endsWith('.png')), []);
  });

  test('a method it does not know is answered properly, not by falling over', async () => {
    const reply = await server.request('resources/list');
    assert.ok(reply.error || reply.result, 'the server must answer something');
    if (reply.error) assert.equal(typeof reply.error.code, 'number');
  });

  test('nothing but JSON-RPC has ever appeared on stdout', () => {
    const lines = server.stdout().split('\n').filter((l) => l.trim() !== '');
    assert.ok(lines.length > 0, 'the server said nothing at all');
    for (const line of lines) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        assert.fail(`stdout carried something that is not JSON, which breaks every client: ${line.slice(0, 200)}`);
      }
      assert.equal(parsed.jsonrpc, '2.0', `a line on stdout was not a JSON-RPC message: ${line.slice(0, 200)}`);
    }
  });
});

describe('a project that opted in', () => {
  /** @type {Server} */
  let server;

  after(async () => {
    if (server) await server.stop();
    await cleanUp();
  });

  test('sees the approve tool, and is told plainly what it is agreeing to', async () => {
    const dir = await copyFixture();
    const configFile = path.join(dir, 'staysfixed.config.js');
    const text = await fsp.readFile(configFile, 'utf8');
    await fsp.writeFile(
      configFile,
      text.replace('export default {', 'export default {\n  mcp: { allowApprove: true, allowMark: true },'),
    );

    server = startServer(dir);
    await server.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'the test suite', version: '1.0.0' },
    });
    server.notify('notifications/initialized');

    const reply = await server.request('tools/list');
    const names = reply.result.tools.map((/** @type {{name: string}} */ t) => t.name);
    for (const opted of OPT_IN) assert.ok(names.includes(opted), `${opted} should be offered now`);

    const approve = reply.result.tools.find((/** @type {{name: string}} */ t) => t.name === 'staysfixed_approve');
    assert.match(approve.description, /off by default|normally a human decision/i);
    assert.deepEqual(approve.inputSchema.required.slice().sort(), ['reason', 'screen']);
  });
});
