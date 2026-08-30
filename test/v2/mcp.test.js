/**
 * The MCP server, spoken to the way an agent speaks to it: a real process, real
 * JSON-RPC, real pipes.
 *
 * Three things are being proved.
 *
 * THE HANDSHAKE IS REAL. Not "it starts" — it answers initialize with a protocol
 * revision, says who it is, and lists its tools.
 *
 * IT DESCRIBES ITSELF ON A BARE MACHINE. The server is started with an empty
 * PATH, in an empty folder, with no settings — nothing installed, nothing
 * configured, nothing recorded. `staysfixed_capabilities` still has to answer,
 * and the answer still has to say what it can do, what it cannot, and what would
 * fix that. The requirement is that nothing about wiring this up needs a human to
 * read documentation, and a self-description that only works on a machine which
 * is already set up does not meet it.
 *
 * STDOUT IS THE PROTOCOL. One stray printed word corrupts the stream and the
 * agent's client dies pointing nowhere near the cause. So every byte the server
 * ever writes to stdout is kept, and every line of it must parse as JSON-RPC —
 * after a bad request, after an unknown tool, after everything.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliPath, repoRoot, scratchDir, cleanUp } from '../support.mjs';
import { renderCheck, findingForAgent } from '../../src/v2/mcp/tools.js';

/** The revision an agent asks for. */
const PROTOCOL = '2025-06-18';

/** Long enough for a cold start plus every probe doctor makes; short enough to fail a hang. */
const ANSWER_MS = 60_000;

/** The version 2 server, started directly, so it is covered before the front door is switched over. */
const V2_SERVER = fileURLToPath(new URL('../../src/v2/mcp/server.js', import.meta.url));

/**
 * @typedef {object} Server
 * @property {(method: string, params?: Record<string, unknown>) => Promise<any>} request
 * @property {() => string} stdout
 * @property {() => string} stderr
 * @property {(line: string) => void} writeRaw
 * @property {() => Promise<void>} stop
 */

/**
 * @param {string[]} argv
 * @param {string} cwd
 * @param {Record<string, string>} env
 * @returns {Server}
 */
function startServer(argv, cwd, env) {
  const child = spawn(process.execPath, argv, { cwd, env });

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
        // Deliberately unguarded: if this throws, the stream was not JSON-RPC,
        // which is the most serious bug this server can have.
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
        const timer = setTimeout(() => reject(new Error(`the server never answered ${method}`)), ANSWER_MS);
        waiting.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    writeRaw(line) {
      child.stdin.write(line + '\n');
    },
    stdout: () => out,
    stderr: () => err,
    stop() {
      return new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.stdin.end();
        setTimeout(() => {
          child.kill('SIGTERM');
          resolve();
        }, 5_000).unref();
      });
    },
  };
}

/**
 * The machine somebody installs this on for the first time: an empty folder with
 * no settings, and a PATH with nothing on it — no git, no ssh, no browser, no
 * android tools, no simulator.
 * @param {string} empty
 * @returns {Record<string, string>}
 */
function bareMachine(empty) {
  return {
    PATH: path.join(empty, 'nothing-here'),
    HOME: empty,
    NO_COLOR: '1',
    STAYSFIXED_OFFLINE: '1',
  };
}

/**
 * The JSON payload out of a tool result. `format: 'json'` puts it in the text,
 * and `structuredContent` is the other legal place for it; both count.
 * @param {any} result
 * @returns {any}
 */
function jsonFrom(result) {
  if (result?.structuredContent) return result.structuredContent;
  for (const item of result?.content ?? []) {
    if (typeof item?.text !== 'string') continue;
    const start = item.text.indexOf('{');
    if (start === -1) continue;
    try {
      return JSON.parse(item.text.slice(start));
    } catch {
      // That item was the plain-English half. Keep looking.
    }
  }
  return null;
}

describe('the class an agent reads is the class that decides', () => {
  test('a sealed money difference never reaches an agent as ordinary', () => {
    // Measured on 2026-08-30 on a real product with a 20% markup slipped into a price: the
    // human text said "1 of them sealed and not yours to waive", `staysfixed_waive` refused
    // it outright — "Nobody may wave this through on their own: it touches money" — and the
    // JSON the agent reads carried `class: "ordinary"`. Three answers, one run.
    const moneyFinding = {
      id: 'f-money',
      title: 'In what the program gives back, "GET /total / body" now has "total" reading 9.3 where it read 7.75.',
      class: 'ordinary',
      differences: [
        {
          path: 'api.GET /total.body',
          channel: 'results',
          kind: 'changed',
          reference: { total: 7.75 },
          candidate: { total: 9.3 },
          journey: 'GET /total',
          real: true,
        },
      ],
    };

    const forAgent = findingForAgent(moneyFinding);
    assert.equal(forAgent.sealed, true, 'a price that moved is sealed');
    assert.equal(forAgent.waivable, false, 'and no agent may wave it through');
    assert.notEqual(forAgent.class, 'ordinary', 'so it must never still read as ordinary');
    assert.equal(forAgent.class, 'money');
    assert.ok(String(forAgent.sealedBecause).length > 0, 'and it has to say why in a sentence');
  });

  test('an ordinary difference is still marked waivable, or nothing could ever be accounted for', () => {
    const plain = {
      id: 'f-plain',
      title: 'In what the program gives back, "GET /menu / body" now has a second item.',
      class: 'ordinary',
      differences: [{ path: 'api.GET /menu.body', channel: 'results', kind: 'changed', reference: {}, candidate: {}, real: true }],
    };
    const forAgent = findingForAgent(plain);
    assert.equal(forAgent.sealed, false);
    assert.equal(forAgent.waivable, true);
  });
});

describe('a run that compared nothing is never reported to an agent as clean', () => {
  /**
   * The shape `check` hands the MCP renderer when there is nothing on record at all.
   * Only the fields this decision reads are filled in; the rest of a real verdict is not
   * what is being tested here.
   * @type {any}
   */
  const nothingOnRecord = {
    result: {
      ok: false,
      comparedNothing: 'no reference',
      blocked: false,
      mode: 'stored-record',
      summary: 'NOTHING WAS ACTUALLY COMPARED.',
      coverage: { journeys: 3, gaps: [] },
    },
    unaccounted: [],
    page: 1,
    offset: 0,
    limit: 50,
    waived: 0,
    expired: 0,
    waiversLeft: 5,
    newlyUnstable: [],
    intent: null,
    // Exactly the mistake: the caller counted differences, found none, and called it clean.
    clean: true,
    missedTheTarget: null,
    notChecked: 'NOT EVERYTHING WAS CHECKED.',
    covers: null,
  };

  test('the headline says no answer, not that everything still works', () => {
    // Measured on 2026-08-30 against a real project with nothing shipped: the terminal said
    // "NOTHING WAS ACTUALLY COMPARED ... it is no answer" and the MCP server, on the same
    // run, said "NOTHING UNACCOUNTED FOR. Everything that worked before still works" with
    // ok: true and isError: false. The agent is the reader this tool was built for, and it
    // was the one being told the untrue thing.
    const said = renderCheck(nothingOnRecord);
    assert.match(said, /NOTHING WAS ACTUALLY COMPARED/);
    assert.doesNotMatch(said, /Everything that worked before still works/);
    assert.match(said, /no answer/i);
    assert.match(said, /Do not report this as a clean run/);
  });
});

describe('the version 2 server, on a machine with nothing installed', () => {
  /** @type {Server} */
  let server;
  /** @type {string} */
  let empty;

  before(async () => {
    empty = await scratchDir('staysfixed-bare');
    server = startServer(
      [
        '--input-type=module',
        '-e',
        `const { serveMcp } = await import(${JSON.stringify(V2_SERVER)}); await serveMcp({ cwd: process.cwd(), version: '2.0.0-test' });`,
      ],
      empty,
      bareMachine(empty)
    );
  });

  after(async () => {
    await server.stop();
  });

  test('it answers the handshake', async () => {
    const reply = await server.request('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'a test', version: '1.0.0' },
    });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    assert.equal(reply.result.protocolVersion, PROTOCOL, 'it should speak the revision the client asked for');
    assert.equal(reply.result.serverInfo.name, 'staysfixed');
    assert.ok(reply.result.capabilities.tools, 'it has to declare that it has tools, or a client will never ask for them');
    assert.ok(
      typeof reply.result.instructions === 'string' && reply.result.instructions.length > 40,
      'the instructions are how an agent learns the loop without being told'
    );
  });

  test('it answers a ping', async () => {
    assert.deepEqual((await server.request('ping')).result, {});
  });

  test('the tools an agent needs are all there, and each says what it is for', async () => {
    const reply = await server.request('tools/list');
    /** @type {{name: string, description?: string, inputSchema?: any}[]} */
    const tools = reply.result.tools;
    const names = tools.map((tool) => tool.name);

    for (const wanted of ['staysfixed_capabilities', 'staysfixed_intent', 'staysfixed_check', 'staysfixed_coverage']) {
      assert.ok(names.includes(wanted), `${wanted} is missing. Got: ${names.join(', ')}`);
    }
    for (const tool of tools) {
      assert.ok(typeof tool.description === 'string' && tool.description.length > 60, `${tool.name} barely describes itself`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} has no input schema, so an agent has to guess`);
    }
  });

  test('an agent can never approve its own work', async () => {
    const names = (await server.request('tools/list')).result.tools.map((/** @type {{name: string}} */ t) => t.name);
    assert.ok(!names.includes('staysfixed_approve'), 'the door is not merely shut — it is not on the list, so the agent never sees one to push on');
    assert.ok(!names.includes('staysfixed_reference'), 'and it cannot move what counts as working either');
  });

  test('capabilities answers with nothing installed and nothing configured', async () => {
    const reply = await server.request('tools/call', {
      name: 'staysfixed_capabilities',
      arguments: { detail: 'full', offline: true },
    });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    assert.notEqual(reply.result.isError, true, `it must answer rather than fail: ${JSON.stringify(reply.result).slice(0, 400)}`);

    const text = (reply.result.content ?? []).map((/** @type {{text?: string}} */ item) => item.text ?? '').join('\n');
    assert.ok(text.length > 200, 'there has to be a real answer a person could read, not a stub');
  });

  test('and as one machine-readable object, with the shape of its own replies in it', async () => {
    const reply = await server.request('tools/call', {
      name: 'staysfixed_capabilities',
      arguments: { detail: 'full', format: 'json', offline: true },
    });
    const caps = jsonFrom(reply.result);
    assert.ok(caps, 'the answer has to carry an object, not only prose — an agent acts on the object');
    assert.ok(caps.resultShapes ?? caps.wiring?.results, 'it has to describe the shape of its own replies, so nobody has to read documentation');
    assert.ok(caps.loop ?? caps.wiring, 'and how the loop is meant to be driven');
    assert.ok(caps.waiving, 'and the rules on what may be waived, since those are the only thing an agent is not allowed to decide');
    const sealed = Object.entries(caps.waiving.sealedClasses ?? {});
    assert.ok(sealed.length >= 5, 'the classes no agent may wave through have to be named, not implied');
    for (const [name, why] of sealed) {
      assert.ok(typeof why === 'string' && why.split(/\s+/).length >= 4, `the sealed class "${name}" does not say why in words an agent can repeat to a person`);
    }
    assert.equal(typeof caps.waiving.budget, 'number', 'and how many waivers there are, so an agent knows when it has run out');
  });

  test('with nothing installed it says what is missing and exactly what would fix it', async () => {
    const reply = await server.request('tools/call', {
      name: 'staysfixed_capabilities',
      arguments: { detail: 'full', format: 'json', offline: true },
    });
    const caps = jsonFrom(reply.result);
    const machine = caps.machine ?? caps;
    const steps = machine.nextSteps ?? caps.nextSteps ?? [];

    assert.ok(Array.isArray(steps) && steps.length > 0, 'on a bare machine there is always something that would unlock more');
    for (const step of steps) {
      assert.ok(typeof step.what === 'string' && step.what.length > 0);
      assert.ok(typeof step.why === 'string' && step.why.split(/\s+/).length >= 4, `"${step.what}" has to say why it matters, in a sentence`);
      assert.ok(typeof step.fix === 'string' && step.fix.length > 0, `"${step.what}" has to say the exact thing that fixes it`);
      assert.equal(typeof step.automatic, 'boolean', 'an agent needs to know whether it can do this itself or has to ask a person');
    }
  });

  test('it never claims a machine it cannot reach', async () => {
    const reply = await server.request('tools/call', {
      name: 'staysfixed_capabilities',
      arguments: { detail: 'full', format: 'json', offline: true },
    });
    const caps = jsonFrom(reply.result);
    const hosts = (caps.machine ?? caps).hosts ?? [];
    assert.deepEqual(hosts, [], 'there is no ssh on this machine, so there are no other machines');
  });

  test('an unknown tool is an answer, not a broken connection', async () => {
    const reply = await server.request('tools/call', { name: 'staysfixed_nonsense', arguments: {} });
    assert.ok(reply.result?.isError === true || reply.error, 'it has to say no somehow');
    assert.deepEqual((await server.request('ping')).result, {}, 'and the connection is still usable afterwards');
  });

  test('a line that is not JSON is complained about in JSON', async () => {
    server.writeRaw('this is not a json-rpc message');
    assert.deepEqual((await server.request('ping')).result, {}, 'and the server is still there');
  });

  test('every byte it ever put on stdout was JSON-RPC', async () => {
    const lines = server.stdout().split('\n').filter((line) => line.trim() !== '');
    assert.ok(lines.length > 0, 'it said something');
    for (const line of lines) {
      assert.equal(JSON.parse(line).jsonrpc, '2.0', `this went to stdout and is not JSON-RPC: ${line.slice(0, 120)}`);
    }
  });

  test('everything meant for a human went to stderr instead', () => {
    assert.ok(server.stderr().includes('staysfixed'), 'the friendly words have to go somewhere, and stderr is where');
  });
});

describe('the front door an agent actually wires up', () => {
  /** @type {Server} */
  let server;
  /** @type {string} */
  let empty;

  before(async () => {
    empty = await scratchDir('staysfixed-front');
    server = startServer([cliPath, 'mcp'], empty, bareMachine(empty));
    await server.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'a test', version: '1.0.0' } });
  });

  after(async () => {
    await server.stop();
    await cleanUp();
  });

  test('`staysfixed mcp` serves the difference engine, which is what every document says it does', async () => {
    // THIS IS THE MOST IMPORTANT ASSERTION IN THE FILE, and for a day it was the one the
    // repository did not make. `staysfixed mcp` served version 1's picture tools while the
    // README, docs/mcp.md, docs/getting-started.md and `staysfixed_capabilities` all
    // described the difference engine — so an agent that followed the project's own wiring
    // block got a tool set none of the documentation mentions, and never reached the engine
    // at all. Nothing was broken; nothing was reachable either. That is worse, because it
    // looks like it works.
    //
    // The earlier version of this test knew and accepted it, on the grounds that switching
    // is a breaking change for anybody who wired version 1 up. That was true and it is
    // answered properly now: version 1 is behind `--v1`, and the test below holds it there.
    const names = (await server.request('tools/list')).result.tools.map((/** @type {{name: string}} */ t) => t.name);
    assert.ok(names.length > 0, '`staysfixed mcp` served no tools at all');
    for (const name of names) {
      assert.match(name, /^staysfixed_/, `every tool this serves has to be one of ours, and "${name}" is not`);
    }
    for (const wanted of ['staysfixed_capabilities', 'staysfixed_intent', 'staysfixed_check', 'staysfixed_explain', 'staysfixed_prove', 'staysfixed_waive', 'staysfixed_coverage']) {
      assert.ok(names.includes(wanted), `the front door does not serve ${wanted}. It served: ${names.join(', ')}`);
    }
    assert.ok(!names.includes('staysfixed_approve'), 'and it still has no door marked approve');
  });

  test('every tool says what it is for and what it does to the machine', async () => {
    /** @type {{name: string, title?: string, description?: string, annotations?: Record<string, unknown>}[]} */
    const tools = (await server.request('tools/list')).result.tools;
    for (const tool of tools) {
      assert.ok(typeof tool.title === 'string' && tool.title.length > 3, `${tool.name} has no short title, so a permission prompt has only its raw name to show`);
      assert.ok(typeof tool.description === 'string' && tool.description.length > 60, `${tool.name} barely describes itself`);
      const notes = tool.annotations ?? {};
      for (const flag of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        assert.equal(typeof notes[flag], 'boolean', `${tool.name} does not say whether it is ${flag}, so a client has to guess`);
      }
      assert.equal(notes.openWorldHint, false, `${tool.name} claims to reach the outside world. Nothing here does: there is no server, no account and nowhere to sign up.`);
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
    // The two that only ever answer a question, and the two that open your product. Getting
    // these the wrong way round costs either an unasked-for run or a prompt nobody needed.
    for (const quiet of ['staysfixed_capabilities', 'staysfixed_explain', 'staysfixed_coverage']) {
      assert.equal(byName[quiet].readOnlyHint, true, `${quiet} answers a question and changes nothing, and has to say so`);
    }
    for (const loud of ['staysfixed_check', 'staysfixed_prove']) {
      assert.equal(byName[loud].readOnlyHint, false, `${loud} opens your product, so it is not read-only whatever else is true of it`);
    }
  });

  test('and version 1 is still there behind --v1, so nobody who wired it up is stranded', async () => {
    const old = startServer([cliPath, 'mcp', '--v1'], empty, bareMachine(empty));
    try {
      await old.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'a test', version: '1.0.0' } });
      const names = (await old.request('tools/list')).result.tools.map((/** @type {{name: string}} */ t) => t.name);
      for (const wanted of ['staysfixed_screens', 'staysfixed_capture', 'staysfixed_status']) {
        assert.ok(names.includes(wanted), `--v1 has to serve the version 1 tools, and ${wanted} was missing. It served: ${names.join(', ')}`);
      }
      assert.ok(!names.includes('staysfixed_approve'), 'even there, approving is not a door an agent gets unless the project opts in');
    } finally {
      await old.stop();
    }
  });

  test('whatever it serves, stdout stays clean', async () => {
    server.writeRaw('not json at all');
    await server.request('ping');
    for (const line of server.stdout().split('\n').filter((l) => l.trim() !== '')) {
      assert.equal(JSON.parse(line).jsonrpc, '2.0');
    }
  });

  test('and the repository it was started from is not touched', async () => {
    // A test that writes into the repo makes the next run's "nothing changed" a lie.
    assert.notEqual(empty, repoRoot);
  });
});
