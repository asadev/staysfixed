/**
 * Stays Fixed over the Model Context Protocol, hand-rolled.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  STDOUT IS THE PROTOCOL. Nothing but JSON-RPC messages may EVER be written
 *  to it — one compact JSON object per line, newline-terminated. A single
 *  stray `console.log` anywhere in the process, in this tool or in somebody's
 *  guard file, corrupts the stream and the client's parser dies with an error
 *  that points nowhere near the real cause. Every human-readable word goes to
 *  stderr. `serveMcp` enforces this by swapping `process.stdout.write` for a
 *  diverter and keeping the real one to itself; do not undo that.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The transport is deliberately tiny: read stdin, split on newlines, answer.
 * That is the entire MCP stdio transport, and writing it by hand costs about a
 * hundred lines and saves the project its only heavy dependency.
 */

import { StringDecoder } from 'node:string_decoder';
import { loadProject, DEFAULT_MCP } from '../core/config.js';
import { setLogLevel } from '../core/log.js';
import { isExpected, messageOf } from '../core/errors.js';
import { toolDefinitions, callTool } from './tools.js';

/** Protocol revisions this server understands. Newest first. */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

/** JSON-RPC 2.0 error codes, plus the ones MCP leans on. */
const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
};

/**
 * A line this long without a newline is a stream that has gone wrong, not a
 * message. Incoming requests are small; only our replies carry screenshots.
 */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

/** How long we wait for a check that is mid-flight when the client hangs up. */
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * Anything that tries to print to stdout gets pushed to stderr instead.
 * @param {any} chunk
 * @param {any} [encoding]
 * @param {any} [callback]
 * @returns {boolean}
 */
function divertToStderr(chunk, encoding, callback) {
  return process.stderr.write(chunk, encoding, callback);
}

/**
 * Serve Stays Fixed on stdin/stdout until the client goes away.
 *
 * @param {{cwd?: string, configFile?: string, version?: string}} [opts]
 * @returns {Promise<void>}
 */
export async function serveMcp(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const configFile = opts.configFile;
  const version = opts.version ?? '0.1.0';

  // Two layers of the same guard. `quiet` stops the tool's own reporting; the
  // diverter catches everything else, including a `console.log` left in a guard
  // file by somebody debugging at two in the morning.
  setLogLevel({ quiet: true });
  const writeToClient = process.stdout.write.bind(process.stdout);
  const realStdoutWrite = process.stdout.write;
  /** @type {any} */ (process.stdout).write = divertToStderr;

  /** @type {import('../types.js').Project|null} */
  let project = null;
  let configComplaint = false;

  /**
   * Read the config fresh. Called on every tool call so an agent that just
   * edited staysfixed.config.js is answered from the file it wrote, not from a
   * snapshot taken when its editor started this server hours ago.
   * @returns {Promise<import('../types.js').Project>}
   */
  async function reload() {
    project = await loadProject({ cwd, configFile });
    return project;
  }

  /** The config as far as we know it, for shaping `tools/list`. Never throws. */
  async function configForListing() {
    try {
      const loaded = project ?? (await reload());
      return loaded.config;
    } catch (e) {
      // A broken config must not stop the server from starting or from listing
      // its tools — the agent needs to be able to CALL one and read the real
      // complaint, which is the only way it can fix the file.
      if (!configComplaint) {
        configComplaint = true;
        log(`config not loaded yet: ${messageOf(e)}`);
      }
      return /** @type {any} */ ({ mcp: { ...DEFAULT_MCP } });
    }
  }

  /**
   * One JSON-RPC message out. The ONLY function allowed to touch real stdout.
   * @param {Record<string, any>} message
   */
  function send(message) {
    try {
      writeToClient(JSON.stringify(message) + '\n');
    } catch (e) {
      // The client hung up mid-answer. There is nowhere left to report it but here.
      log(`could not write a reply: ${messageOf(e)}`);
    }
  }

  /**
   * @param {string|number} id
   * @param {any} result
   */
  function reply(id, result) {
    send({ jsonrpc: '2.0', id, result });
  }

  /**
   * @param {string|number|null} id
   * @param {number} code
   * @param {string} message
   */
  function replyError(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** @param {string} line */
  function log(line) {
    process.stderr.write(`[staysfixed] ${line}\n`);
  }

  // Tool calls run one at a time. Two of them at once would mean two copies of
  // the app fighting over the same debug port, and the pictures would be
  // nonsense — determinism is the product, so the queue is not optional.
  /** @type {Promise<void>} */
  let queue = Promise.resolve();
  /** @type {Set<Promise<void>>} */
  const inFlight = new Set();

  /**
   * @param {() => Promise<void>} job
   * @returns {Promise<void>}
   */
  function enqueue(job) {
    const run = queue.then(job);
    const settled = run.then(
      () => {},
      () => {}
    );
    queue = settled;
    inFlight.add(settled);
    settled.then(() => inFlight.delete(settled));
    return run;
  }

  /**
   * @param {any} msg
   */
  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      replyError(null, RPC.invalidRequest, 'Each line must be one JSON-RPC request object. Batched arrays are not supported.');
      return;
    }

    const method = typeof msg.method === 'string' ? msg.method : null;
    // No `id` member means a notification, and a notification never gets an
    // answer — replying to one is the classic way to wedge a strict client.
    const isNotification = !('id' in msg);
    const id = /** @type {string|number} */ (msg.id);

    if (!method) {
      if (!isNotification) replyError(id, RPC.invalidRequest, 'That message has no method name.');
      return;
    }

    if (isNotification) {
      if (method === 'notifications/cancelled') log('client cancelled a request');
      // 'notifications/initialized' and anything else: acknowledged by silence.
      return;
    }

    switch (method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        const client = msg.params?.clientInfo?.name;
        reply(id, {
          // Speak the client's revision when we know it; otherwise answer with
          // ours and let it decide whether it can live with that.
          protocolVersion: typeof asked === 'string' && SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'staysfixed', version },
          instructions:
            'Stays Fixed proves that what already worked still works. Call staysfixed_screens once to learn what this project protects, then call staysfixed_check after you finish editing and before you report that you are done. If a picture changed, look at the diff image and decide whether you broke it or whether it was meant to change — approving a new picture is a human decision unless this project has explicitly handed it to you.',
        });
        log(`connected${client ? ` to ${client}` : ''}`);
        return;
      }

      case 'ping':
        reply(id, {});
        return;

      case 'tools/list': {
        const config = await configForListing();
        reply(id, { tools: toolDefinitions(config) });
        return;
      }

      case 'tools/call': {
        const name = msg.params?.name;
        if (typeof name !== 'string' || name === '') {
          replyError(id, RPC.invalidParams, 'A tools/call needs the name of the tool to run.');
          return;
        }
        const args = msg.params?.arguments ?? {};
        if (Array.isArray(args)) {
          replyError(id, RPC.invalidParams, 'Tool arguments must be an object, not a list.');
          return;
        }
        await enqueue(async () => {
          try {
            // `project` may still be null on the very first call, or after a config
            // edit broke the file. That is on purpose: callTool reloads, and a broken
            // config then reaches the agent as words it can act on.
            const result = await callTool(name, args, { project: /** @type {any} */ (project), reload, version });
            reply(id, result);
          } catch (e) {
            // A tool that blows up is still a RESULT, not a protocol error: the
            // agent is meant to read what went wrong and try to fix it.
            reply(id, {
              content: [{ type: 'text', text: isExpected(e) ? messageOf(e) : `Stays Fixed could not finish that: ${messageOf(e)}` }],
              isError: true,
            });
          }
        });
        return;
      }

      default:
        replyError(id, RPC.methodNotFound, `This server does not handle "${method}".`);
    }
  }

  // ── the stdio loop ────────────────────────────────────────────────────────

  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let overlong = false;

  /** @type {() => void} */
  let finish = () => {};
  /** @type {Promise<void>} */
  const done = new Promise((resolve) => {
    finish = resolve;
  });

  let closing = false;

  /** @param {string} why */
  async function shutdown(why) {
    if (closing) return;
    closing = true;
    log(`shutting down (${why})`);
    // Wait for whatever is mid-flight so the app it opened gets closed properly.
    // Past the grace period we stop waiting; a hung app must not hold the editor.
    if (inFlight.size > 0) {
      /** @type {NodeJS.Timeout|undefined} */
      let timer;
      const grace = new Promise((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
      });
      await Promise.race([Promise.all([...inFlight]), grace]);
      if (timer) clearTimeout(timer);
    }
    /** @type {any} */ (process.stdout).write = realStdoutWrite;
    setLogLevel({ quiet: false });
    finish();
  }

  /** @param {string} line */
  function onLine(line) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (trimmed.trim() === '') return;
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      replyError(null, RPC.parseError, 'That line was not valid JSON. Each message must be one JSON object on one line.');
      return;
    }
    // Handling is async; a throw escaping it would take the server down, so it
    // is caught here and reported as an internal error against that one message.
    Promise.resolve()
      .then(() => handle(msg))
      .catch((e) => {
        const id = msg && typeof msg === 'object' && 'id' in msg ? msg.id : null;
        log(`internal error: ${messageOf(e)}`);
        if (id !== null && id !== undefined) replyError(id, RPC.internalError, `Something went wrong inside Stays Fixed: ${messageOf(e)}`);
      });
  }

  process.stdin.on('data', (chunk) => {
    buffer += decoder.write(/** @type {Buffer} */ (chunk));

    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (overlong) {
        // We already gave up on this message; the newline ends it.
        overlong = false;
        continue;
      }
      onLine(line);
    }

    // A line that never ends is a broken stream, not a big request. Drop what we
    // are holding rather than growing until the process runs out of memory.
    if (!overlong && buffer.length > MAX_LINE_BYTES) {
      overlong = true;
      buffer = '';
      replyError(null, RPC.parseError, 'That message was too long to read. Each message must be one JSON object on one line.');
    }
  });

  process.stdin.on('error', (e) => {
    log(`stdin error: ${messageOf(e)}`);
    void shutdown('stdin error');
  });
  process.stdin.on('end', () => void shutdown('the client closed the connection'));
  process.stdin.on('close', () => void shutdown('the client closed the connection'));

  /** @type {(() => void)[]} */
  const signalHandlers = [];
  for (const signal of /** @type {NodeJS.Signals[]} */ (['SIGINT', 'SIGTERM'])) {
    const onSignal = () => void shutdown(signal);
    process.on(signal, onSignal);
    signalHandlers.push(() => process.removeListener(signal, onSignal));
  }

  process.stdin.resume();
  log(`Stays Fixed ${version} ready — talking MCP on stdin and stdout, saying everything else here.`);

  await done;
  for (const off of signalHandlers) off();
  process.stdin.pause();
}

/**
 * The block a person pastes into their editor's MCP settings.
 *
 * Printed by `staysfixed init` and quoted in the README, so it is written once,
 * here, and never re-typed into three places that then drift apart.
 *
 * @param {{command: string, args?: string[], cwd?: string}} opts
 * @returns {string}
 */
export function mcpConfigSnippet({ command, args = [], cwd }) {
  /** @type {Record<string, any>} */
  const server = { command, args };
  if (cwd) server.cwd = cwd;
  return JSON.stringify({ mcpServers: { staysfixed: server } }, null, 2);
}
