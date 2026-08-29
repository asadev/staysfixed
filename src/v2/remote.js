/**
 * Running a check on another machine.
 *
 * This is the general mechanism, not a Windows special case. Android on a spare box, iOS on
 * a Mac mini and Windows on an office desktop are all the same shape:
 *
 *     THE ENGINE RUNS HERE. THE WALKING HAPPENS THERE. OBSERVATIONS COME BACK.
 *
 * Nothing is mounted, no shared filesystem is assumed, and nothing is installed on the far
 * machine. A small program is pushed down the connection at the start of a run, lives only in
 * the memory of the process it is running inside, and dies with it. That matters more than it
 * looks: a runner that has to be installed is a runner somebody has to maintain, and the first
 * time it is a version behind, the tool reports a difference that is really its own.
 *
 * WHY ONE HELD CONNECTION, MEASURED RATHER THAN ASSUMED.
 * A fresh `ssh host command` to the office machine takes 740-1130 ms, measured over five
 * dials on 2026-08-29. One request down an already-open connection to a probe that is already
 * running takes 12-24 ms. That is fifty to eighty times, and it is the whole design: open once,
 * hand the far side a program, then talk to it. A runner that shells out per step would spend
 * its entire budget on handshakes and would still be walking the first journey.
 *
 * WHAT THE FAR SIDE IS ALLOWED TO SEND BACK.
 * Lines. Each reply is one line of JSON with a `#SF#` sentinel in front of it. The sentinel is
 * not decoration and it is not paranoia: the login shell prints a message of the day, sudo
 * prints lecture text, PowerShell prints a `#< CLIXML` header the moment anything touches the
 * error stream, and every one of those arrived on the same stream during the checks that built
 * this file. Anything without the sentinel is kept as NOISE and reported, never parsed. A
 * transport that guesses which lines were meant for it is a transport that will one day read a
 * warning as an observation.
 *
 * THE HONESTY RULE THIS FILE EXISTS TO ENFORCE.
 * A connection can die in the middle of a walk — the laptop lid closes, the wifi drops, someone
 * reboots the office machine. When that happens the journey has NOT passed. It has not failed
 * either. It is missing coverage, and it says so, with the reason attached. There is exactly
 * one way for a remote journey to report a clean result, and that is for the far side to say so
 * out loud before the connection closes. Silence is never agreement.
 */

import { spawn } from 'node:child_process';
import { StaysFixedError } from '../core/errors.js';
import { howLongItTook, joinPath, notCovered, observation, sizeBucket, timeBucket, trimForStorage } from './adapters/contract.js';

/** @typedef {import('./types.js').Observation} Observation */
/** @typedef {import('./types.js').Journey} Journey */
/** @typedef {import('./types.js').Surface} Surface */
/** @typedef {import('./adapters/contract.js').Missing} Missing */

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/**
 * What every reply from the far side starts with.
 *
 * Four characters, chosen to be something no shell, no login banner and no runtime writes by
 * accident. Everything else on the stream is noise by definition.
 */
export const SENTINEL = '#SF#';

/** The kinds of far side this file knows how to start. */
export const RUNNER_KINDS = /** @type {const} */ (['posix', 'windows']);

/** @typedef {'posix'|'windows'} RunnerKind */

/**
 * Where PowerShell lives on a Windows machine, in the order worth trying.
 *
 * These are absolute paths on purpose, and it cost an hour to learn why. The office machine
 * has `appendWindowsPath = true` in its `/etc/wsl.conf`, and `powershell.exe` is STILL not on
 * the path of a non-interactive ssh session — the Windows path is added by the interactive
 * login shell, and ssh does not run one. Anything that probes with `command -v powershell.exe`
 * gets an empty answer and concludes, wrongly, that there is no Windows behind that host.
 * There is. Ask the filesystem, not the path.
 */
export const POWERSHELL_PATHS = [
  '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  '/mnt/c/Program Files/PowerShell/7/pwsh.exe',
  '/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
];

/** How long to wait for the far side to say hello before giving up. */
const HANDSHAKE_MS = 20_000;

/** How long one request may take before it is called a hole rather than an answer. */
const DEFAULT_CALL_MS = 60_000;

/** Past this, a reply is truncated rather than kept — a runaway far side must not fill memory. */
const MAX_REPLY_BYTES = 8 * 1024 * 1024;

/**
 * The link went away. Distinct from every other failure, because it means the opposite thing:
 * a failed call tells you something about the product, and a lost link tells you nothing at all.
 */
export class RemoteLinkLost extends StaysFixedError {
  /**
   * @param {string} host
   * @param {string} why      Plain English: what actually happened.
   * @param {string[]} [noise] Unsentinelled lines the far side wrote, which usually explain it.
   */
  constructor(host, why, noise = []) {
    super(`The connection to ${host} went away: ${why}`, {
      hint: noise.length > 0
        ? `The machine said: ${noise.slice(-3).join(' / ')}`
        : 'Nothing this run saw on that machine can be trusted. It is reported as unchecked, not as a pass.',
    });
    this.name = 'RemoteLinkLost';
    /** @type {string} */
    this.host = host;
    /** @type {string[]} */
    this.noise = noise;
  }
}

// ---------------------------------------------------------------------------
// Getting a program onto the far side without installing anything
// ---------------------------------------------------------------------------

/**
 * Turn a PowerShell script into what `-EncodedCommand` wants: base64 of UTF-16 little-endian.
 *
 * Encoding rather than quoting is not a style choice. The script travels through a POSIX shell
 * on the WSL side and then through Windows command-line parsing, and those two disagree about
 * quotes, backslashes, carets and percent signs. Base64 has none of those characters in it.
 *
 * @param {string} script
 * @returns {string}
 */
export function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * The two-line PowerShell program that reads the real probe off its own standard input.
 *
 * This exists because of a hard limit that is easy to trip over and unpleasant to debug: a
 * Windows command line is capped at 32,767 characters, and `-EncodedCommand` inflates a script
 * by about 2.7 times on its way to base64. A probe of any real size — the Windows one is well
 * past ten kilobytes — does not fit, and what you get is not a clear error but a truncated
 * script that fails somewhere in the middle.
 *
 * So the command line carries only this, 432 characters encoded, and the probe itself arrives
 * as the first line of standard input, where nothing limits its length. Measured working with
 * a 32,756-character payload on 2026-08-29.
 *
 * @returns {string}
 */
export function powerShellBootstrap() {
  return [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    '$b=[Console]::In.ReadLine()',
    'Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)))',
  ].join('\n');
}

/**
 * The same trick for a POSIX far side.
 *
 * Node has room on the command line that Windows does not, so this could have been inlined.
 * It is not, because one shape for both kinds means one thing to get right, one thing to test,
 * and one place where a payload could be truncated.
 *
 * @returns {string}
 */
export function nodeBootstrap() {
  return [
    "let line='';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', function onData(chunk) {",
    "  const cut = chunk.indexOf('\\n');",
    '  if (cut < 0) { line += chunk; return; }',
    '  line += chunk.slice(0, cut);',
    '  const rest = chunk.slice(cut + 1);',
    "  process.stdin.removeListener('data', onData);",
    "  const src = Buffer.from(line, 'base64').toString('utf8');",
    '  if (rest) process.stdin.unshift(rest);',
    "  const run = new Function('require', 'process', src);",
    "  run(require('node:module').createRequire(process.cwd() + '/x.cjs'), process);",
    '});',
  ].join('\n');
}

/**
 * The command to run on the far machine, as one string for its shell.
 *
 * For `windows` this is a POSIX shell command that starts PowerShell through WSL interop. The
 * `for` loop over candidate paths is there because the path that works is a fact about the
 * machine, not about Windows, and asking is cheaper than a round trip to find out first.
 *
 * @param {RunnerKind} kind
 * @param {{psPath?: string, node?: string}} [opts]
 * @returns {string}
 */
export function farSideCommand(kind, opts = {}) {
  if (kind === 'windows') {
    const encoded = encodePowerShell(powerShellBootstrap());
    if (opts.psPath) return `exec "${opts.psPath}" -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
    const candidates = POWERSHELL_PATHS.map((p) => `"${p}"`).join(' ');
    return [
      `for p in ${candidates}; do`,
      `  if [ -x "$p" ]; then exec "$p" -NoProfile -NonInteractive -EncodedCommand ${encoded}; fi;`,
      'done;',
      'echo "no powershell.exe on this machine" >&2; exit 127',
    ].join(' ');
  }
  const node = opts.node ?? 'node';
  // The bootstrap goes through `$( )` so the far shell hands it over as one argument and never
  // re-reads it, and it travels as base64 so the shell has no quotes, dollars or backslashes of
  // its own to get wrong. Nothing is written to that machine's disk at any point.
  const encoded = Buffer.from(nodeBootstrap(), 'utf8').toString('base64');
  return `${node} -e "$(printf %s '${encoded}' | base64 -d)"`;
}

/**
 * The full argument list for ssh.
 *
 * `BatchMode=yes` is the important one. Without it, a host whose key is missing sits there
 * asking for a password that nobody is going to type, and the run hangs instead of reporting
 * an honest "that machine did not let me in".
 *
 * @param {string} host
 * @param {string} remoteCommand
 * @param {{connectTimeoutSec?: number, extra?: string[]}} [opts]
 * @returns {string[]}
 */
export function sshCommand(host, remoteCommand, opts = {}) {
  return [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${opts.connectTimeoutSec ?? 10}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    ...(opts.extra ?? []),
    host,
    remoteCommand,
  ];
}

// ---------------------------------------------------------------------------
// Reading the stream
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Framed
 * @property {Record<string, any>[]} frames  Replies, already parsed.
 * @property {string[]} noise                Lines that were not ours, kept verbatim.
 */

/**
 * Split an arriving stream into replies and noise.
 *
 * Kept as its own function with its own state so it can be tested without a machine, and so
 * the rule it encodes is visible: a line either starts with the sentinel and is parsed, or it
 * does not and is kept as noise. There is no third case and no heuristic.
 *
 * @returns {{push: (chunk: string) => Framed, rest: () => string}}
 */
export function makeFrames() {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      /** @type {Record<string, any>[]} */
      const frames = [];
      /** @type {string[]} */
      const noise = [];
      let cut = buffer.indexOf('\n');
      while (cut >= 0) {
        const line = buffer.slice(0, cut).replace(/\r$/, '');
        buffer = buffer.slice(cut + 1);
        cut = buffer.indexOf('\n');
        if (line.startsWith(SENTINEL)) {
          try {
            frames.push(JSON.parse(line.slice(SENTINEL.length)));
          } catch {
            // A sentinelled line we cannot parse is worse than noise, because something on the
            // far side thinks it is talking to us and is not. Keep it where a person will see it.
            noise.push(`unreadable reply: ${line.slice(0, 200)}`);
          }
        } else if (line.trim() !== '') {
          noise.push(line);
        }
      }
      return { frames, noise };
    },
    rest: () => buffer,
  };
}

// ---------------------------------------------------------------------------
// The generic POSIX agent
// ---------------------------------------------------------------------------

/**
 * The program that runs on a POSIX far side.
 *
 * Deliberately small. It runs commands, reports what they printed, what they exited with and
 * how long they took, and it says hello with enough facts for `doctor` to describe the machine.
 * It does NOT try to be the CLI adapter over a wire: the process adapter watches a run from
 * inside the child with a loader, and that machinery belongs where the engine is, not scattered
 * across every machine the tool can reach.
 *
 * Written as text rather than shipped as a file because it must never be installed. It exists
 * in the memory of one `node -e` for the length of one run.
 *
 * @returns {string}
 */
export function posixAgentScript() {
  return `
const { execFile } = require('node:child_process');
const os = require('node:os');
const fs = require('node:fs');
const S = ${JSON.stringify(SENTINEL)};
const emit = (o) => { try { process.stdout.write(S + JSON.stringify(o) + '\\n'); } catch (e) {} };

emit({ id: 'hello', ok: true, kind: 'posix', platform: process.platform, arch: process.arch,
       node: process.version, host: os.hostname(), user: os.userInfo().username,
       home: os.homedir(), tmp: os.tmpdir(), cpus: os.cpus().length,
       memoryGb: Math.round(os.totalmem() / 1e9), release: os.release() });

const ops = {
  ping: (req, done) => done({ ok: true }),
  which: (req, done) => {
    const found = {};
    for (const name of req.names || []) {
      let where = null;
      for (const dir of (process.env.PATH || '').split(':')) {
        try { const p = dir + '/' + name; fs.accessSync(p, fs.constants.X_OK); where = p; break; } catch (e) {}
      }
      found[name] = where;
    }
    done({ ok: true, found });
  },
  read: (req, done) => {
    try { done({ ok: true, text: fs.readFileSync(req.file, 'utf8').slice(0, req.limit || 65536) }); }
    catch (e) { done({ ok: false, error: String(e.message) }); }
  },
  sh: (req, done) => {
    const started = Date.now();
    execFile(req.shell || '/bin/sh', ['-c', req.command], {
      cwd: req.cwd || undefined,
      env: req.env ? Object.assign({}, process.env, req.env) : process.env,
      timeout: req.timeoutMs || 120000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      done({
        ok: true,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        killed: Boolean(err && err.killed),
        ms: Date.now() - started,
      });
    });
  },
};

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let cut = pending.indexOf('\\n');
  while (cut >= 0) {
    const line = pending.slice(0, cut); pending = pending.slice(cut + 1); cut = pending.indexOf('\\n');
    if (!line.trim()) continue;
    let req; try { req = JSON.parse(line); } catch (e) { emit({ id: '?', ok: false, error: 'bad json' }); continue; }
    if (req.op === 'bye') { emit({ id: req.id, ok: true }); process.exit(0); }
    const op = ops[req.op];
    if (!op) { emit({ id: req.id, ok: false, error: 'unknown op ' + req.op }); continue; }
    try { op(req, (reply) => emit(Object.assign({ id: req.id }, reply))); }
    catch (e) { emit({ id: req.id, ok: false, error: String(e && e.message || e) }); }
  }
});
process.stdin.on('end', () => process.exit(0));
`;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RemoteFacts
 * What the far side said about itself at handshake. Everything in here came from the machine,
 * never from a config file, because a config file is a claim and this is a measurement.
 * @property {string} [host]
 * @property {string} [user]
 * @property {string} [platform]
 * @property {string} [kind]
 * @property {boolean} [locked]      Windows only: is the desktop locked right now.
 * @property {number} [session]      Windows only: which logon session the probe landed in.
 * @property {boolean} [loggedIn]    Windows only: is anybody signed in. UI Automation reads the
 *                                   desktop in front of it, and there is no desktop without a
 *                                   session — so this decides whether a walk is possible at all.
 * @property {string} [screen]       Windows only: what the screen is doing — 'locked', 'unlocked'.
 *                                   A locked screen still yields per-window pictures but not a
 *                                   whole-desktop one, so the difference has to be recorded.
 * @property {string} [release]      What the far side calls its own version.
 */

/**
 * @typedef {object} RemoteRunnerOptions
 * @property {string} host                   An entry in the ssh config that already works.
 * @property {RunnerKind} [kind]             Default 'posix'.
 * @property {string} [agent]                The program to push down. Defaults to the POSIX one.
 * @property {Surface} [surface]             What surface observations from here belong to.
 * @property {string} [psPath]               A known powershell.exe path, to skip the search.
 * @property {number} [callTimeoutMs]
 * @property {(message: string) => void} [log]
 * @property {string[]} [sshExtra]           Extra ssh options, for a port or an identity file.
 */

/**
 * Open a runner on another machine.
 *
 * The returned object is not a full adapter and does not pretend to be one. It is the half an
 * adapter cannot write for itself: a live connection, a request-and-reply channel over it, and
 * an honest account of what happened if it breaks. An adapter — the Windows one, an Android one
 * later — supplies the program that runs on the far side and the knowledge of what its replies
 * mean.
 *
 * @param {RemoteRunnerOptions} opts
 */
export function remoteRunner(opts) {
  const kind = opts.kind ?? 'posix';
  const host = opts.host;
  const say = opts.log ?? (() => {});
  const surface = opts.surface;
  const agentSource = opts.agent ?? posixAgentScript();

  /** @type {import('node:child_process').ChildProcessWithoutNullStreams|null} */
  let child = null;
  /** @type {RemoteFacts} */
  let facts = {};
  /** @type {string[]} */
  const noise = [];
  /** @type {Map<string, {resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout}>} */
  const waiting = new Map();
  /** @type {RemoteLinkLost|null} */
  let dead = null;
  let counter = 0;
  let bytesIn = 0;

  const frames = makeFrames();

  /**
   * Everything in flight gives up at once, with the same reason.
   * @param {string} why
   */
  function die(why) {
    if (dead) return;
    dead = new RemoteLinkLost(host, why, noise);
    for (const [, entry] of waiting) {
      clearTimeout(entry.timer);
      entry.reject(dead);
    }
    waiting.clear();
  }

  /** @param {string} chunk */
  function absorb(chunk) {
    bytesIn += chunk.length;
    if (bytesIn > MAX_REPLY_BYTES) {
      die(`it sent more than ${sizeBucket(MAX_REPLY_BYTES)} of replies, which is not a conversation any more`);
      if (child) child.kill();
      return;
    }
    const { frames: got, noise: extra } = frames.push(chunk);
    for (const line of extra) {
      noise.push(line);
      if (noise.length > 200) noise.shift();
    }
    for (const reply of got) {
      const id = String(reply.id ?? '');
      if (id === 'hello') {
        facts = /** @type {RemoteFacts} */ (reply);
        const hello = waiting.get('hello');
        if (hello) { clearTimeout(hello.timer); waiting.delete('hello'); hello.resolve(reply); }
        continue;
      }
      const entry = waiting.get(id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      waiting.delete(id);
      entry.resolve(reply);
    }
  }

  const runner = {
    host,
    kind,
    /** What the far side said about itself. Empty until `open` has finished. */
    get facts() { return facts; },
    /** Lines the far side wrote that were not replies. Usually the explanation for a failure. */
    get noise() { return noise.slice(); },
    /** False the moment anything makes the link untrustworthy. */
    get alive() { return child !== null && dead === null; },
    /** The reason it stopped being trustworthy, or null. */
    get lost() { return dead; },

    /**
     * Dial the machine, push the program down, and wait for it to say hello.
     *
     * @returns {Promise<RemoteFacts>}
     */
    async open() {
      if (child) return facts;
      const command = farSideCommand(kind, { psPath: opts.psPath });
      const args = sshCommand(host, command, { extra: opts.sshExtra });
      say(`opening ${host} (${kind})`);
      child = /** @type {any} */ (spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] }));
      const proc = /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */ (child);
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', absorb);
      proc.stderr.on('data', (/** @type {string} */ text) => {
        for (const line of text.split('\n')) if (line.trim()) noise.push(line.trim());
      });
      proc.on('error', (e) => die(`ssh itself would not run (${e.message})`));
      proc.on('close', (code, signal) => {
        die(signal ? `it was stopped by ${signal}` : `it closed with code ${code}`);
      });

      const hello = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => { waiting.delete('hello'); reject(new RemoteLinkLost(host, `it did not answer within ${timeBucket(HANDSHAKE_MS)}`, noise)); },
          HANDSHAKE_MS
        );
        waiting.set('hello', { resolve, reject, timer });
      });

      // The program itself, on the first line of standard input, where no command-line limit
      // applies. See powerShellBootstrap for why this is not on the command line.
      proc.stdin.write(`${Buffer.from(agentSource, 'utf8').toString('base64')}\n`);
      await hello;
      say(`${host} answered: ${describeFacts(facts)}`);
      return facts;
    },

    /**
     * One request, one reply.
     *
     * A timeout here is NOT an error about the product. It is a hole, and the caller is
     * expected to record it as one — which is why this rejects with a link-lost error carrying
     * the reason rather than resolving with something that could be mistaken for an answer.
     *
     * @param {string} op
     * @param {Record<string, unknown>} [payload]
     * @param {{timeoutMs?: number}} [callOpts]
     * @returns {Promise<Record<string, any>>}
     */
    async call(op, payload = {}, callOpts = {}) {
      if (dead) throw dead;
      if (!child) throw new StaysFixedError(`Cannot talk to ${host} before opening the connection.`);
      const id = `r${++counter}`;
      const timeoutMs = callOpts.timeoutMs ?? opts.callTimeoutMs ?? DEFAULT_CALL_MS;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new RemoteLinkLost(host, `"${op}" did not answer within ${timeBucket(timeoutMs)}`, noise));
        }, timeoutMs);
        waiting.set(id, { resolve, reject, timer });
      });
      /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */ (child).stdin.write(
        `${JSON.stringify({ ...payload, id, op })}\n`
      );
      return /** @type {Record<string, any>} */ (await promise);
    },

    /**
     * Run a command over there and get back what it printed.
     *
     * The convenience the mobile lanes will actually use: `adb devices`, `xcrun simctl list`,
     * `git rev-parse HEAD` on the machine that has the checkout.
     *
     * @param {string} command
     * @param {{cwd?: string, env?: Record<string,string>, timeoutMs?: number}} [shellOpts]
     * @returns {Promise<{stdout: string, stderr: string, code: number, ms: number, killed: boolean}>}
     */
    async shell(command, shellOpts = {}) {
      const reply = await runner.call('sh', { command, ...shellOpts }, { timeoutMs: shellOpts.timeoutMs });
      return {
        stdout: String(reply.stdout ?? ''),
        stderr: String(reply.stderr ?? ''),
        code: Number(reply.code ?? 0),
        ms: Number(reply.ms ?? 0),
        killed: Boolean(reply.killed),
      };
    },

    /**
     * Walk a journey made of shell steps and report what was seen.
     *
     * The generic walk, for a far side running the POSIX agent. A platform adapter with a
     * richer far side — Windows, and Android when it lands — walks its own way and uses this
     * only for the shape of the answer.
     *
     * If the link dies part way through, everything already collected is KEPT and everything
     * remaining is reported as a hole. Throwing the collected half away would be tidier and
     * would also delete the evidence of what happened just before the machine went.
     *
     * @param {Journey} journey
     * @param {{command: string, cwd?: string, note?: string}[]} steps
     * @returns {Promise<Observation[]>}
     */
    async walk(journey, steps) {
      /** @type {Observation[]} */
      const seen = [];
      for (const [index, step] of steps.entries()) {
        const label = step.note ?? step.command;
        try {
          const result = await runner.shell(step.command, { cwd: step.cwd });
          const printed = trimForStorage(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`);
          seen.push(observation({
            channel: 'results',
            path: joinPath('remote', host, journey.name, String(index), 'printed'),
            value: printed.text,
            says: `On ${host}, "${label}" printed this.`,
            journey: journey.name,
            surface,
          }));
          seen.push(observation({
            channel: 'complaints',
            path: joinPath('remote', host, journey.name, String(index), 'exit'),
            value: result.killed ? 'killed' : result.code,
            says: result.killed
              ? `On ${host}, "${label}" had to be stopped — it did not finish on its own.`
              : `On ${host}, "${label}" finished with ${result.code}.`,
            journey: journey.name,
            surface,
          }));
          seen.push(howLongItTook({
            channel: 'counters',
            path: joinPath('remote', host, journey.name, String(index), 'took'),
            ms: result.ms,
            what: `On ${host}, "${label}"`,
            journey: journey.name,
          }));
        } catch (error) {
          // The link went. Everything from here on is unchecked, and it says so.
          return [...seen, ...linkLostHoles({
            host,
            journey,
            surface,
            why: error instanceof RemoteLinkLost ? error.message : String(error),
            from: index,
            total: steps.length,
          })];
        }
      }
      return seen;
    },

    /**
     * Close the connection and leave the machine as it was found.
     *
     * Nothing was installed and nothing was written, so there is nothing to clean up except the
     * conversation itself. `bye` is sent first and given a moment, because a probe that exits on
     * its own leaves no orphan; killing ssh and hoping is how a stray process ends up on
     * somebody's desk.
     */
    async close() {
      if (!child) return;
      const proc = /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */ (child);
      try {
        if (!dead) await runner.call('bye', {}, { timeoutMs: 3000 });
      } catch { /* already gone, which is the outcome we wanted */ }
      try { proc.stdin.end(); } catch { /* nothing to end */ }
      await new Promise((resolve) => {
        const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } resolve(undefined); }, 3000);
        proc.on('close', () => { clearTimeout(timer); resolve(undefined); });
        if (proc.exitCode !== null) { clearTimeout(timer); resolve(undefined); }
      });
      child = null;
    },
  };

  return runner;
}

/** @typedef {ReturnType<typeof remoteRunner>} RemoteRunner */

/**
 * The observations that stand in for a walk that did not finish.
 *
 * The whole reason this file exists in the form it does. A journey interrupted by a dead
 * connection has not passed, and there is a real temptation in code like this to return what
 * was collected and let the engine compare it — which would report the missing half as
 * "unchanged" and be exactly the quietly-worthless green run the tool is supposed to make
 * impossible.
 *
 * @param {object} spec
 * @param {string} spec.host
 * @param {Journey} spec.journey
 * @param {string} spec.why
 * @param {number} spec.from       Step it stopped at.
 * @param {number} spec.total
 * @param {Surface} [spec.surface]
 * @returns {Observation[]}
 */
export function linkLostHoles(spec) {
  const left = Math.max(0, spec.total - spec.from);
  return [
    notCovered({
      channel: 'results',
      path: joinPath('remote', spec.host, spec.journey.name, 'finished'),
      reason: 'timed out',
      says: `"${spec.journey.describe}" did not finish on ${spec.host}. ${spec.why}. `
        + `${left} of ${spec.total} step${spec.total === 1 ? '' : 's'} were never walked, so nothing here is a pass — `
        + 'it is simply unchecked.',
    }),
    notCovered({
      channel: 'complaints',
      path: joinPath('remote', spec.host, spec.journey.name, 'link'),
      reason: 'timed out',
      says: `The connection to ${spec.host} broke part way through. Whatever the product did after that, nobody saw it.`,
    }),
  ];
}

/**
 * One line about a machine, for a log.
 * @param {RemoteFacts} f
 * @returns {string}
 */
export function describeFacts(f) {
  const parts = [];
  if (f.host) parts.push(f.host);
  if (f.platform) parts.push(f.platform);
  if (f.user) parts.push(`as ${f.user}`);
  if (f.locked === true) parts.push('desktop locked');
  if (f.locked === false) parts.push('desktop unlocked');
  return parts.length > 0 ? parts.join(', ') : 'no facts offered';
}

// ---------------------------------------------------------------------------
// Describing a machine, for doctor
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RemoteDescription
 * @property {string} host
 * @property {boolean} reachable
 * @property {string} how                 Plain English: what answered, or why nothing did.
 * @property {string|null} os
 * @property {boolean} windows            A real Windows desktop sits behind this host.
 * @property {string|null} windowsVersion
 * @property {string|null} powershell     The absolute path that works, when one does.
 * @property {boolean|null} desktopLoggedIn  Is anybody logged in for UI Automation to read.
 * @property {boolean|null} desktopLocked    Locked desktops read fine but photograph black.
 * @property {Record<string, string|null>} tools   What is installed there that we care about.
 * @property {Missing[]} missing          What would unlock more, and who has to do it.
 * @property {string[]} notes
 */

/** Things worth knowing about on any far machine, and what each one unlocks. */
const TOOLS_WORTH_ASKING_ABOUT = ['node', 'git', 'adb', 'emulator', 'java', 'python3', 'xcrun'];

/**
 * What is actually on the other end of an ssh host name.
 *
 * This is the `doctor` half, and it obeys the rule the design put above everything: DETECT,
 * NEVER ASK. A host that already answers must never be reported as something to set up, and
 * the Windows desktop behind a WSL host must never be missed because `powershell.exe` was not
 * on a non-interactive path. Both of those are real failures that happened while this was
 * being written.
 *
 * It never throws. Somebody running doctor is already stuck.
 *
 * @param {string} host
 * @param {{timeoutMs?: number, log?: (m: string) => void}} [opts]
 * @returns {Promise<RemoteDescription>}
 */
export async function describeRemote(host, opts = {}) {
  /** @type {RemoteDescription} */
  const out = {
    host,
    reachable: false,
    how: 'it did not answer',
    os: null,
    windows: false,
    windowsVersion: null,
    powershell: null,
    desktopLoggedIn: null,
    desktopLocked: null,
    tools: {},
    missing: [],
    notes: [],
  };

  const runner = remoteRunner({ host, kind: 'posix', callTimeoutMs: opts.timeoutMs ?? 20_000, log: opts.log });
  try {
    const facts = await runner.open();
    out.reachable = true;
    out.how = 'it answered over ssh with the key already in the config';
    out.os = [facts.platform, facts.release].filter(Boolean).join(' ') || null;

    const found = await runner.call('which', { names: TOOLS_WORTH_ASKING_ABOUT });
    out.tools = /** @type {Record<string, string|null>} */ (found.found ?? {});

    // The Windows question, asked of the filesystem rather than of $PATH. See POWERSHELL_PATHS.
    const test = await runner.shell(
      POWERSHELL_PATHS.map((p) => `if [ -x "${p}" ]; then echo "${p}"; fi`).join('; ')
    );
    const psPath = test.stdout.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? null;
    if (psPath) {
      out.powershell = psPath;
      out.windows = true;
      // One PowerShell call for everything, because each one costs about a second of Windows
      // start-up and there is no reason to pay it three times.
      // Encoded rather than quoted. The script passes through a POSIX shell AND then Windows
      // command-line parsing, and a single quote written for one of them is eaten by the other;
      // the first version of this line came back empty for exactly that reason.
      const script = [
        '$os=(Get-CimInstance Win32_OperatingSystem)',
        '$e=@(Get-Process explorer -ErrorAction SilentlyContinue).Count',
        '$l=@(Get-Process LogonUI -ErrorAction SilentlyContinue).Count',
        'Write-Output ($os.Caption + "|" + $os.Version + "|" + $e + "|" + $l)',
      ].join('; ');
      const probe = await runner.shell(
        `"${psPath}" -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(script)}`,
        { timeoutMs: 45_000 }
      );
      const line = probe.stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
      const [caption, version, explorers, logonui] = line.split('|');
      if (version) {
        out.windowsVersion = `${caption} ${version}`.trim();
        out.desktopLoggedIn = Number(explorers) > 0;
        out.desktopLocked = Number(logonui) > 0;
      } else {
        out.notes.push('PowerShell is there but did not answer a question about the desktop, so how much of Windows is usable is unknown.');
      }
    }
    await runner.close();
  } catch (error) {
    out.how = error instanceof RemoteLinkLost ? error.message : `it could not be reached (${String(error)})`;
    try { await runner.close(); } catch { /* nothing to close */ }
  }

  out.missing = missingOn(out);
  out.notes.push(...notesOn(out));
  return out;
}

/**
 * What would make this machine more useful, and who has to do it.
 *
 * Written to the design's four states: anything an agent can install is said with the exact
 * command and no `blocking` flag, and anything only a person can do says what it unlocks so the
 * agent can relay one clear sentence instead of inventing instructions.
 *
 * @param {RemoteDescription} d
 * @returns {Missing[]}
 */
export function missingOn(d) {
  /** @type {Missing[]} */
  const missing = [];
  if (!d.reachable) {
    missing.push({
      what: `a working ssh connection to ${d.host}`,
      unlocks: 'running checks on that machine at all — its platform is invisible from here without it',
      howToGet: `Check the entry for ${d.host} in ~/.ssh/config, and that the machine is switched on. `
        + `Test it with: ssh ${d.host} true`,
      blocking: true,
    });
    return missing;
  }
  if (!d.tools.node) {
    missing.push({
      what: 'Node on that machine',
      unlocks: 'the general remote runner, which is how any platform there is walked',
      howToGet: `ssh ${d.host} 'sudo apt-get install -y nodejs' — or whatever that machine installs packages with.`,
      blocking: true,
    });
  }
  if (d.windows && d.desktopLoggedIn === false) {
    missing.push({
      what: 'somebody logged in on that Windows desktop',
      unlocks: 'reading native Windows windows at all — there is nothing to read on a desktop nobody has signed into',
      howToGet: 'Sign in on that machine once and leave the session running. Locking the screen afterwards is fine; signing out is not.',
      blocking: true,
    });
  }
  if (d.windows && d.desktopLocked === true) {
    missing.push({
      what: 'that Windows desktop left unlocked',
      unlocks: 'full-screen pictures as evidence — a locked desktop photographs as solid black, though individual windows still photograph correctly and everything else works',
      howToGet: 'Only a person can unlock it. Nothing else about the check needs this, so it is usually not worth doing.',
    });
  }
  return missing;
}

/**
 * The honest small print about one machine.
 * @param {RemoteDescription} d
 * @returns {string[]}
 */
export function notesOn(d) {
  /** @type {string[]} */
  const notes = [];
  if (!d.reachable) return notes;
  notes.push('Nothing is installed on that machine. The program that does the watching is sent down the connection each run and dies with it.');
  if (d.windows) {
    notes.push(`Windows is reached through ${d.powershell}, called from the Linux side. That absolute path is used deliberately: powershell.exe is not on the path of a non-interactive ssh session even when the machine is configured to add it.`);
    notes.push('Windows shows one desktop, so two builds can never run there at the same time. Runs are one after the other, and that is a real weakening of the same-machine guarantee, not a detail.');
  }
  if (d.desktopLocked === true) notes.push('That desktop is locked right now. Windows can still be read; it just cannot be photographed whole.');
  return notes;
}
