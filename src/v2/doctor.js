/**
 * `staysfixed doctor` for v2 — the machine-readable answer to one question:
 * *what can this tool actually check on THIS machine, right now, and what is
 * stopping it from checking the rest?*
 *
 * v1's doctor explained why the tool could not run in one project. This one has
 * a bigger job. The requirement is that the tool describes itself to the AI that
 * installs it: nothing about wiring this up should ever need a human to read
 * documentation. So everything here comes back as data first and prose second —
 * `capabilities()` builds the object, `describeCapabilities()` turns it into
 * plain English, and both the CLI and the MCP tool `staysfixed_capabilities`
 * read the same object. There is only one source of truth about this machine.
 *
 * Two rules hold the file together.
 *
 * DETECT, NEVER ASK. An SSH host that already works must never be presented as
 * something to set up. Neither must a browser that is installed, a simulator
 * runtime that exists, or a repository that is already a git repository. Every
 * "needs" entry in the result had to fail a real probe first.
 *
 * IT NEVER THROWS AND IT NEVER HANGS. Somebody running doctor is already stuck.
 * Every probe has a timeout, every failure becomes a note, and the exit code
 * says how bad it is rather than crashing. `xcrun simctl` in particular has hung
 * on a Mac before — so the CoreSimulator binary is called directly where it
 * exists, and a hang is reported as a hang instead of taking the process with it.
 */

import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { existsSync, accessSync, readFileSync, readdirSync, constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { findConfigFile, rootForConfig } from '../core/paths.js';
import { platformTag } from '../drive/find.js';
import { isRepo } from '../core/git.js';
import { surveyBrowsers, INSTALL_COMMAND, PORT_NEVER_USE } from './browsers.js';
import { POWERSHELL_PATHS, describeRemote } from './remote.js';
import { deviceToMake } from './adapters/android.js';
import { describeWindows } from './adapters/windows.js';
import { messageOf, EXIT } from '../core/errors.js';
import { say, ok, warn, fail, blank, heading, paint, mark, shortPath, setLogLevel } from '../core/log.js';
import { loadPlaywright } from './adapters/web-driver.js';

const exec = promisify(execFile);

/** Nothing this file asks a question of is allowed to think about it for longer. */
const PROBE_MS = 5_000;
/** Reaching another machine is slower than reaching a binary, but not much. */
const REACH_MS = 8_000;
/**
 * More hosts than this in one ssh config and we stop dialling; the list is a menu, not a
 * queue. They are all dialled at once, so the number costs parallel ssh processes rather
 * than seconds - and anything past the cap is named in the answer instead of dropped.
 */
const MAX_HOSTS = 16;

/**
 * The seven ways this tool can watch a product, in the order the design puts
 * them: meaning first, pixels last and only ever as evidence.
 *
 * @type {{id: string, name: string, what: string}[]}
 */
export const CHANNELS = [
  { id: 'meaning', name: 'the meaning tree', what: 'What the screen says each control is, is called, and can do. Never the raw markup.' },
  { id: 'effects', name: 'effects out', what: 'Network calls made, files written, processes started, storage written.' },
  { id: 'complaints', name: 'complaints', what: 'Console messages, errors on stderr, crashes, exit codes.' },
  { id: 'results', name: 'results', what: 'What it printed, what the API answered, what it exports.' },
  { id: 'contract', name: 'the contract in the source', what: 'Routes, exported functions, IPC channels — read out of the code without running it.' },
  { id: 'counters', name: 'counters and timing', what: 'How many of a thing, and roughly how long — coarse on purpose.' },
  { id: 'pixels', name: 'pixels', what: 'A picture, last, and only as evidence for something another channel already found.' },
];

/**
 * @typedef {object} ToolReport
 * @property {string} id
 * @property {string} name          What a person calls it.
 * @property {boolean} found
 * @property {string} [where]       Full path, when we know it.
 * @property {string} [version]
 * @property {string} why           What this tool is needed for, in plain words.
 * @property {string} [fix]         The exact thing that would install it.
 * @property {boolean} [automatic]  True when the tool could install it without a person.
 */

/**
 * @typedef {object} HostReport
 * @property {string} name
 * @property {boolean} reachable
 * @property {string} how           How we found out, or why it did not answer.
 * @property {boolean} [windows]    Reaches a real Windows desktop through powershell.exe.
 * @property {string} [powershell]  The absolute path to powershell.exe that answered, when one did.
 *                                  Kept because it is the evidence: "there is Windows behind this
 *                                  host" is a claim, and this is the file that proves it.
 * @property {import('./remote.js').RemoteDescription} [detail]
 *   Everything the remote runner could learn about that machine once it was known to answer:
 *   what is installed on it, whether anybody is signed in, whether the desktop is locked, and
 *   a `missing[]` carrying the exact command for each thing that is not there.
 *
 *   WHY THE FOUR FIELDS ABOVE ARE NOT READ OUT OF IT. They come from the cheap probe, which
 *   is a plain `echo` down an ssh connection and needs nothing on the far machine at all.
 *   `detail` comes from the runner, which needs Node there. Letting the deeper answer
 *   overwrite the shallower one would report a perfectly reachable machine as unreachable the
 *   day somebody's Node is a version too old, and offer them the ssh config as the fix.
 *
 *   Absent when the host never answered, and when `doctor --offline` skipped dialling
 *   altogether. Absent is "nobody asked", never "there is nothing there".
 */

/**
 * @typedef {object} Need
 * @property {string} what
 * @property {string} why
 * @property {string} fix           The exact command, or the exact thing a person has to do.
 * @property {boolean} automatic    True when Stays Fixed could do it itself.
 * @property {string} [unlocks]     What becomes checkable once it is there, in plain English.
 *                                  A person asked to spend half an hour on a download deserves
 *                                  to be told what they get for it, in a sentence, before they
 *                                  start — and an agent relaying the ask needs the same sentence.
 */

/**
 * What THIS COPY of the tool can drive, which is a different question from what this
 * machine could run.
 *
 * A Mac with Xcode, a simulator and Appium on it can run an iPhone app. That says nothing
 * about whether Stays Fixed has an adapter that knows how to drive one. Answering the
 * first question and reporting it as the second is how a surface gets called ready while
 * every journey aimed at it walks nothing — and a journey nothing walked, reported as
 * covered, is the worst thing this tool can produce.
 *
 * @typedef {object} DriverReport
 * @property {string} surface
 * @property {boolean} present
 * @property {string} why           Plain English, filled in either way.
 */

/**
 * The four states of the design, and the fourth is the one that matters.
 *
 * - `ready`                     It works here now. Nothing to say.
 * - `the agent can fix this`    Everything in the way installs without a person:
 *                               the agent runs the commands and never mentions it.
 * - `only a person can do this` A licence, a device, a password, a pair of hands.
 *                               The needs say what to do, why, and what it unlocks.
 * - `not possible here`         No command on this machine changes the answer. Say
 *                               so, say the nearest honest alternative in `instead`,
 *                               and stop offering it.
 *
 * @typedef {'ready'|'the agent can fix this'|'only a person can do this'|'not possible here'} SurfaceState
 */

/**
 * @typedef {object} SurfaceReport
 * @property {string} id
 * @property {string} name
 * @property {'ready'|'partial'|'unavailable'} status   How much of it works: all, some, none.
 * @property {SurfaceState} state   Who has to act, which is a different question from
 *                                  how much works. A partly-covered surface still has
 *                                  somebody who can widen it.
 * @property {string} summary       One plain sentence.
 * @property {string[]} canCheck    Channel ids usable here on this machine.
 * @property {string[]} cannotCheck Channel ids that are out of reach here.
 * @property {Need[]} needs
 * @property {string} [instead]     Only on `not possible here`: the nearest honest
 *                                  alternative, so the answer is not just a refusal.
 * @property {boolean} [notInThisProject]  The reason is that there is nothing of this kind
 *                                  in this repository — NOT that the machine cannot do it.
 *                                  Told apart because "your Mac cannot check an iPhone app"
 *                                  is false on a Mac with Xcode on it, and a reader who is
 *                                  told that once stops believing the rest of the page.
 */

/**
 * @typedef {object} Capabilities
 * @property {{name: string, version: string, generatedAt: string}} tool
 * @property {{platform: string, arch: string, release: string, node: string, cpus: number, memoryGb: number, tag: string}} machine
 * @property {{root: string, configFile: string|null, isGitRepo: boolean, hasReference: boolean, referenceNote: string}} project
 * @property {SurfaceReport[]} surfaces
 * @property {DriverReport[]} drivers
 * @property {Covers} covers
 * @property {{willOpen: import('./browsers.js').BrowserFound|null, borrowingYourOwn: boolean, note: string, install: string|null, found: import('./browsers.js').BrowserFound[], neverTouches: string[], leftovers: string}} browsers
 * @property {{id: string, name: string, what: string, availableOn: string[]}[]} channels
 * @property {ToolReport[]} tools
 * @property {HostReport[]} hosts
 * @property {Need[]} nextSteps
 * @property {string[]} limits      Things it will never be able to see, on any machine.
 * @property {{mcp: Record<string, unknown>, commands: {command: string, what: string}[], results: Record<string, string>}} wiring
 */

/**
 * Everything this machine can and cannot do, as one JSON-safe object.
 *
 * This is what `staysfixed_capabilities` returns over MCP, unchanged. An agent
 * should be able to read it once and know what to call, what it will get back,
 * and what it must not bother asking for here.
 *
 * @param {{cwd?: string, configFile?: string, offline?: boolean, machines?: boolean,
 *   settingsText?: string}} [opts]
 * @returns {Promise<Capabilities>}
 */
export async function capabilities(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const offline = opts.offline === true || process.env.STAYSFIXED_OFFLINE !== undefined;
  const configFile = opts.configFile ? path.resolve(cwd, opts.configFile) : findConfigFile(cwd);
  // rootForConfig, never path.dirname: a config kept at `.staysfixed/config.json` — one of
  // the six names this tool looks for — would otherwise make the project root the
  // `.staysfixed` folder itself, and every adapter would be asked about an empty directory.
  // Measured on Terminal Deck: doctor reported "a built APK is still missing" with the APK
  // sitting two folders up, and told the agent to go and build one that was already there.
  const root = configFile ? rootForConfig(configFile) : cwd;

  // The settings, as text, from whichever of the two places they live in.
  //
  // `init` is the second place. It works out what it is about to write and only then asks
  // this function what the machine can do — so on a fresh project every question below was
  // answered against NO settings at all, and the answers went straight into the readiness
  // it printed. A plain Node command-line tool was told, by the same run that had just
  // wired `node cli.js --help` into its settings, that it still needed "a command to run".
  // Being sent to set up something the tool has already set up is how somebody decides this
  // page is not worth reading. Measured 2026-08-31.
  const settingsText = opts.settingsText ?? readTextOrNull(configFile);
  const settingsAreJson = opts.settingsText ? false : configFile !== null && configFile.endsWith('.json');
  const hasSettings = settingsText !== null;

  // The browser survey comes first because three different answers below depend
  // on it, and asking this machine the same question three times would be both
  // slow and a way for the three answers to disagree.
  const browsers = await surveyBrowsers().catch(() => /** @type {import('./browsers.js').BrowserSurvey} */ ({ found: [], chosen: null, borrowingHis: false, note: 'The browsers on this machine could not be checked, so nothing here says whether a web page can be opened.', install: INSTALL_COMMAND }));
  const desktopApp = findDesktopApp(cwd);

  const [tools, hosts, repo, reference, drivers, phones, asked] = await Promise.all([
    findTools(cwd, browsers),
    // Only a product that could actually run somewhere else is a reason to go looking for
    // somewhere else. A website or a command-line tool never needs a Windows desktop, and
    // the hosts list feeds exactly one surface: that one.
    offline
      ? Promise.resolve(/** @type {HostReport[]} */ ([]))
      : reachableHosts({ dial: opts.machines === true || desktopApp !== null }),
    isRepo(root).catch(() => false),
    findReference(root),
    whatThisCopyCanDrive(),
    phoneApps(root, settingsText),
    askTheAdapters(root, settingsText, settingsAreJson),
  ]);

  const wires = settingsText ? whatTheProcessBlockWires(settingsText) : { commands: 0, imports: 0 };
  const surfaces = describeSurfaces(tools, hosts, hasSettings, browsers, desktopApp, drivers, phones, asked, wires);

  /** @type {Capabilities} */
  const caps = {
    tool: { name: 'staysfixed', version: versionOfThisTool(), generatedAt: new Date().toISOString() },
    machine: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      node: process.version,
      cpus: os.cpus().length,
      memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      tag: platformTag(),
    },
    project: {
      root,
      configFile,
      isGitRepo: repo,
      hasReference: reference.found,
      referenceNote: reference.note,
    },
    surfaces,
    drivers,
    covers: whatThisRunActuallyCovers(surfaces, hasSettings),
    browsers: {
      willOpen: browsers.chosen,
      borrowingYourOwn: browsers.borrowingHis,
      note: browsers.note,
      install: browsers.install,
      found: browsers.found,
      neverTouches: [
        'It never opens your browser profile. Every run gets a throwaway one, and it is deleted afterwards.',
        `It never takes port ${PORT_NEVER_USE}, which another session on this machine already owns. It asks the operating system for a free one instead.`,
        'It never quits a browser it did not start. Anything it stops had to be running from a scratch profile this tool created.',
        'Nothing it opened outlives the run — not on a clean finish, not on an error, not on Ctrl-C.',
      ],
      leftovers: 'staysfixed browsers --clean quits anything an interrupted run left running, and only ever something started by this tool.',
    },
    channels: CHANNELS.map((channel) => ({
      ...channel,
      availableOn: surfaces.filter((s) => s.canCheck.includes(channel.id)).map((s) => s.id),
    })),
    tools,
    hosts,
    nextSteps: nextSteps(surfaces, reference, repo),
    limits: PERMANENT_LIMITS,
    // The wiring block, with the real folder in it.
    //
    // `WIRING` carries a placeholder, because it is written once as a constant and a constant
    // cannot know where it is being asked from. Handing that placeholder straight back is
    // how `doctor --json` came to answer an agent's "how do I wire this up" with the literal
    // words `/absolute/path/to/your/project` — a value that fails silently if pasted, and
    // one the tool knew the real answer to all along. `init` had always filled it in; this
    // is the same courtesy from the command an agent is told to call first.
    wiring: { ...WIRING, mcp: mcpWiringFor(root) },
  };

  return caps;
}

/**
 * The things this tool cannot see anywhere, on any machine, by design. They are
 * listed in the capabilities object on purpose: an agent that knows the blind
 * spots stops treating a clean run as proof of something it never covered.
 *
 * @type {string[]}
 */
const PERMANENT_LIMITS = [
  'Anything irreversible is watched at the moment it is asked for — the same charge, for the same amount, to the same place — and never allowed to happen. If a bug only appears after the payment settles or the email lands, this tool cannot see it.',
  'A migration that destroys data is refused rather than run twice. The refusal is reported as a gap in coverage, never as a pass.',
  'Subtracting the product’s own wobble hides intermittent bugs. A race that already existed and got worse will not show. Running the new build twice recovers half of this by flagging anything newly unstable — only half.',
  'It checks the journeys it has. It cannot enumerate every possible state, and the coverage ledger names the doors it has never opened rather than pretending they are covered.',
  'Two builds of a real phone in your hand cannot be run side by side. Real devices fall back to comparing against the stored record, and say so.',
  'If the old build can no longer be compiled, comparison falls back to the stored record from the last time it ran. That is genuinely weaker and announces itself on every run.',
  'It will not tell you your product got slower. How long something took is recorded and printed, and never compared: a stopwatch on a shared machine measures how busy the machine is at least as much as it measures the product, so comparing it invents a slowdown every time the machine is busy. A build that HANGS is still caught, because it is stopped for taking too long and how it finished is compared exactly.',
  'A change buried in the middle of an output larger than 64KB can be missed. The two ends are kept and compared along with the exact number of bytes discarded, so a middle that grew or shrank shows up; one that changed without changing length does not. The whole text is written to the evidence folder and the run says it only compared the ends.',
];

/**
 * Everything an agent needs to wire this up and to read what comes back.
 * Written once, here, so the README, the MCP server and `doctor --json` cannot
 * drift apart.
 */
const WIRING = {
  mcp: {
    mcpServers: {
      staysfixed: { command: 'npx', args: ['-y', 'staysfixed', 'mcp'], cwd: '/absolute/path/to/your/project' },
    },
  },
  commands: [
    { command: 'staysfixed check', what: 'Run the difference engine. Answers with only the differences it could not explain.' },
    { command: 'staysfixed check --against <ref>', what: 'Compare against a named marker or commit instead of the newest reference.' },
    { command: 'staysfixed check --paired', what: 'Boot the old build live from the start rather than trusting the stored record. Slower, stronger.' },
    { command: 'staysfixed check --journeys <source>', what: 'Where the steps come from: suite, code, recorded, or a path to a journeys file.' },
    { command: 'staysfixed check --json', what: 'The whole result as one JSON object and nothing else. This is the shape the MCP tool returns.' },
    { command: 'staysfixed check --selfcheck', what: 'Run the corpus of deliberately broken builds and prove the engine still catches them.' },
    { command: 'staysfixed check --pictures', what: 'The version 1 picture check, unchanged, for anyone who was already using it.' },
    { command: 'staysfixed doctor --json', what: 'This object. The first call any agent should make.' },
  ],
  // Field for field, this is the Verdict defined in src/v2/types.js. An agent
  // reads this to know what it will get back without being taught, so a name
  // here that the engine does not actually produce is worse than no entry at
  // all: it sends the agent looking for something that will never arrive.
  results: {
    shape: 'Every check answers with one Verdict object. `staysfixed check --json` prints exactly that and nothing else, and the MCP tool returns the same object.',
    ok: 'true when nothing unintended survived. false when something did, or when something that used to give the same answer every time stopped doing so.',
    mode: '"paired" means the old build was booted and walked here, in this minute. "stored-record" means it was compared against what the old build wrote down the last time it ran, which is genuinely weaker.',
    modeWarning: 'Present whenever the run was weaker than a full paired one, written in the words to repeat to a person. Absent on a paired run.',
    reference: 'Which build counted as working. An EMPTY id means nothing was on record as working, so the run proves nothing about the product either way.',
    candidate: 'Which build was checked.',
    findings: 'Ranked, worst first. Each one is a cluster of differences that share a cause, not a single path. This is the only part an agent needs to read.',
    'findings[].title': 'One plain sentence naming what changed. No test ids, no jargon.',
    'findings[].why': 'The likely cause, said plainly, and hedged when it is a guess.',
    'findings[].class': 'money, sign-in, data-loss, crash, guard, or ordinary.',
    'findings[].sealed': 'true when the class is one no agent may wave through. It goes to a person, whatever the agent believes it meant to change.',
    'findings[].rank': 'Higher is more urgent. Distance from the code you changed is the biggest term, because a break far from your edit is the definition of a side effect.',
    'findings[].differences': 'The addresses under this one finding, each with what it was, what it is, and whether the path appeared or vanished.',
    differencesReal: 'How many differences survived the wobble floor.',
    differencesNoise: 'How many were the product disagreeing with itself and were subtracted. Evidence that the quiet is earned.',
    newlyUnstable: 'Addresses that were steady before your change and disagree with themselves now. Treat these as findings even though no value "changed".',
    coverage: 'What was walked — and in coverage.gaps, everything that was not, each with what would unlock it. An unopened door is visible here instead of silently passing.',
    summary: 'One paragraph of plain English covering all of the above. Safe to quote to a person word for word.',
    durationMs: 'How long the whole check took.',
  },
};

/**
 * The wiring block for one project, with its folder filled in.
 *
 * @param {string} root
 * @returns {Record<string, unknown>}
 */
function mcpWiringFor(root) {
  return {
    mcpServers: {
      staysfixed: { command: 'npx', args: ['-y', 'staysfixed', 'mcp'], cwd: root },
    },
  };
}

/**
 * The version out of package.json, read without importing the CLI — doctor has
 * to work when everything else in the project is broken.
 * @returns {string}
 */
function versionOfThisTool() {
  try {
    /** @type {{version?: string}} */
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ── probes ──────────────────────────────────────────────────────────────────

/**
 * Is there an executable of this name on PATH? Answered by looking, not by
 * spawning `which`: doctor asks this a dozen times and a dozen processes to
 * answer a question the filesystem already knows is waste.
 *
 * @param {string} name
 * @returns {string|null}
 */
export function onPath(name) {
  const parts = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const suffixes = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of parts) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, name + suffix);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Not here, or not runnable by us. Both mean "keep looking".
      }
    }
  }
  return null;
}

/**
 * Ask a program what version it is. Never throws, never hangs, and treats a
 * timeout as its own answer — a tool that will not reply is not a tool that is
 * missing, and telling somebody to install it would be wrong.
 *
 * `out` merges the two streams because a version banner may come out of either -
 * Java announces itself on stderr. `stdout` and `stderr` are kept apart as well,
 * and anything that has to tell an ANSWER from a REFUSAL must read `stdout`. That
 * distinction is not fussiness: github.com refuses `ssh github-x 'echo hello'` by
 * writing `Invalid command: echo hello` to stderr, so a probe reading the merged
 * text finds its own word in the refusal and calls the refusal a reply.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok: boolean, out: string, stdout: string, stderr: string, why: string, hung: boolean}>}
 */
async function ask(file, args, timeoutMs = PROBE_MS) {
  try {
    const { stdout, stderr } = await exec(file, args, { timeout: timeoutMs, maxBuffer: 4 << 20, windowsHide: true });
    // Java and a few others announce their version on stderr. Take whichever spoke.
    return { ok: true, out: String(stdout || stderr).trim(), stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), why: '', hung: false };
  } catch (error) {
    const e = /** @type {{killed?: boolean, signal?: string, stdout?: string, stderr?: string}} */ (Object(error));
    const hung = e.killed === true || e.signal === 'SIGTERM';
    const spoke = String(e.stdout || e.stderr || '').trim();
    const streams = { stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
    // A non-zero exit that still printed a version is a success for our purposes.
    if (!hung && spoke !== '') return { ok: true, out: spoke, ...streams, why: '', hung: false };
    return { ok: false, out: '', ...streams, why: hung ? `it did not answer within ${Math.round(timeoutMs / 1000)}s` : messageOf(error), hung };
  }
}

/**
 * The first thing in a version banner that looks like a version.
 * @param {string} text
 * @returns {string|undefined}
 */
function versionIn(text) {
  const found = /\d+\.\d+(\.\d+)?/.exec(text);
  return found ? found[0] : undefined;
}

/**
 * Everything on this machine that could widen what the tool is able to watch.
 *
 * @param {string} cwd
 * @param {import('./browsers.js').BrowserSurvey} browsers   Already taken, because
 *        the browser question is asked in three places and must be answered once.
 * @returns {Promise<ToolReport[]>}
 */
async function findTools(cwd, browsers) {
  /** @type {ToolReport[]} */
  const reports = [];

  /**
   * @param {ToolReport} report
   */
  const add = (report) => {
    reports.push(report);
  };

  add({ id: 'node', name: 'Node', found: true, where: process.execPath, version: process.version.replace(/^v/, ''), why: 'Runs the tool itself and every command-line product it watches.' });

  await Promise.all([
    (async () => {
      const where = onPath('git');
      const version = where ? versionIn((await ask(where, ['--version'])).out) : undefined;
      add({
        id: 'git',
        name: 'git',
        found: where !== null,
        where: where ?? undefined,
        version,
        why: 'Names the reference build, and ranks a difference by how far it sits from the code you changed.',
        fix: where ? undefined : 'Install git. Without it every difference is ranked as though you edited nothing.',
        automatic: false,
      });
    })(),

    (async () => {
      // One entry, not two. Whether the browser found is one we may open is a
      // real and separate question, but it belongs to the web surface and to the
      // browsers block, where it can be said in a sentence — a second row in a
      // flat list of tool names would read as two browsers rather than one fact
      // about the one we have.
      const chosen = browsers.chosen;
      add({
        id: 'browser',
        name: 'a browser to drive pages with',
        found: chosen !== null,
        where: chosen?.binary,
        version: chosen?.version,
        why: 'Opens a web page so what the screen says each control is and does can be read off it.',
        fix: chosen ? undefined : `${INSTALL_COMMAND}  — nothing to sign up for and nobody to ask.`,
        automatic: true,
      });
    })(),

    (async () => {
      // Ask the thing that actually opens the page, not the folder it might live in.
      //
      // This used to look for a `playwright` folder under the project being checked. That is
      // the wrong question in two directions at once. The driver now ships WITH this tool, so
      // it is present even when the project has never heard of it; and a project that keeps
      // its packages somewhere unusual has one when the folder walk says it does not.
      //
      // Getting this wrong is how 0.7.2 came to tell every agent that asked that web apps and
      // sites could be checked "here and now", and then answered every single website check
      // with "no web page can be opened". `loadPlaywright` is the one piece of code whose
      // answer is the truth, because it is the code the walk itself runs.
      const state = await loadPlaywright({ projectRoot: cwd });
      const downloaded = playwrightBrowsersDir();
      add({
        id: 'playwright',
        name: 'a browser to read pages with',
        found: state.ok,
        where: state.executable ?? downloaded ?? undefined,
        version: state.version,
        why: 'Reads a page’s meaning tree properly, and opens a browser that is not the one you use, so yours is left alone.',
        fix: state.ok ? undefined : `${state.howToGet ?? INSTALL_COMMAND}  — nothing to sign up for and nobody to ask.`,
        automatic: true,
      });
    })(),

    (async () => {
      const app = findDesktopApp(cwd);
      add({
        id: 'electron',
        name: 'a desktop app to check',
        found: app !== null,
        where: app?.where,
        why: 'A desktop app is driven straight over its own debugging port, so no browser is needed for it — only the app itself.',
        // `electron.binary`, not `app.binary`.
        //
        // Both keys exist and they belong to different halves of the tool: `app.binary` is
        // what version 1's picture engine reads, and `electron.binary` is what the difference
        // engine reads. `doctor` describes the difference engine, so telling somebody to set
        // `app.binary` sent them to write a setting the adapter they are about to run never
        // looks at — and the next run says there is no desktop app, for a reason they have
        // just ruled out.
        fix: app ? undefined : 'Only needed if the product you are watching is a desktop app. If it is, name the built app in your settings under electron.binary.',
        automatic: false,
      });
    })(),

    (async () => {
      const where = onPath('adb') ?? androidSdkTool('platform-tools', 'adb');
      add({
        id: 'adb',
        name: 'adb',
        found: where !== null,
        where: where ?? undefined,
        why: 'Installs an APK on an emulator and reads what it is doing.',
        fix: where ? undefined : 'Install the Android platform tools, then add them to PATH (usually ~/Library/Android/sdk/platform-tools).',
        automatic: true,
      });
    })(),

    (async () => {
      const where = onPath('emulator') ?? androidSdkTool('emulator', 'emulator');
      add({
        id: 'emulator',
        name: 'the Android emulator',
        found: where !== null,
        where: where ?? undefined,
        why: 'The only place two builds of an Android app can be run one after the other on this machine.',
        fix: where ? undefined : 'Install the Android SDK emulator and one system image.',
        automatic: true,
      });

      // An emulator with no virtual device on it is a program that cannot start
      // anything, and reporting it as a runner would send a check off to boot a phone
      // that does not exist. Two separate facts, so they get two separate answers.
      const avds = where ? await ask(where, ['-list-avds'], PROBE_MS) : null;
      const names = (avds?.out ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.includes(' '));
      add({
        id: 'avd',
        name: 'an Android phone to run it on',
        found: names.length > 0,
        where: where ?? undefined,
        version: names[0],
        why: 'The emulator is the program; a virtual device is the phone it runs. Without one there is nothing to install the app onto.',
        // Asked of the Android adapter, never written out again here.
        //
        // There were two copies of this command, one in each file, and they had drifted in
        // two ways at once. They named different Android versions, so doctor and the adapter
        // disagreed about which device to make. And both hardcoded `arm64-v8a`, so anybody on
        // an Intel Mac or an x86 Linux box was handed a command naming an image that does not
        // exist for their machine — and the failure talks about the image, which sends them
        // looking for the wrong thing entirely. `deviceToMake` reads this machine's processor
        // and carries the Play-Store warning in the same string, so neither half can be
        // separated from the other again.
        fix: names.length > 0 ? undefined : deviceToMake().both,
        automatic: true,
      });
    })(),

    (async () => {
      if (process.platform !== 'darwin') {
        add({ id: 'simulator', name: 'the iOS simulator', found: false, why: 'Runs the iPhone build.', fix: 'iOS can only be watched from a Mac.', automatic: false });
        return;
      }
      const sim = await simulatorReport();
      add(sim);
    })(),

    (async () => {
      const where = onPath('ssh');
      add({
        id: 'ssh',
        name: 'ssh',
        found: where !== null,
        where: where ?? undefined,
        why: 'Reaches the other machines you already have, so a platform this Mac cannot run is checked where it can.',
        fix: where ? undefined : 'Install an SSH client.',
        automatic: false,
      });
    })(),

    (async () => {
      const where = onPath('docker');
      // The binary being there is not the question. Docker only restores a snapshot when
      // its engine is actually RUNNING, and on a Mac the command sits on the path all day
      // while Docker Desktop is shut. Asking the engine for its version is the difference
      // between detecting and assuming, and assuming here promises a server comparison
      // that would fall over the moment it was asked for.
      const engine = where ? await ask(where, ['version', '--format', '{{.Server.Version}}']) : null;
      const running = engine !== null && engine.ok && /\d/.test(engine.stdout);
      add({
        id: 'docker',
        name: 'Docker',
        found: running,
        where: where ?? undefined,
        version: running ? versionIn(engine.stdout) : undefined,
        why: 'The usual way to restore the same database snapshot twice, which is what a server comparison needs.',
        fix: running
          ? undefined
          : where
            ? 'Docker is installed but its engine is not answering — start Docker Desktop, or the docker service, and run this again. Only needed to watch a server whose behaviour depends on its data.'
            : 'Only needed to watch a server whose behaviour depends on its data.',
        automatic: false,
      });
    })(),
  ]);

  reports.sort((a, b) => a.id.localeCompare(b.id));
  return reports;
}

/**
 * The iOS simulator, asked carefully.
 *
 * `xcrun simctl` has hung on a Mac in this house before and taken the caller
 * with it, so CoreSimulator's own binary is preferred when it is there, and a
 * hang is reported as a hang rather than as an absence.
 *
 * @returns {Promise<ToolReport>}
 */
async function simulatorReport() {
  const direct = '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl';
  const binary = existsSync(direct) ? direct : onPath('xcrun');
  if (!binary) {
    return {
      id: 'simulator',
      name: 'the iOS simulator',
      found: false,
      why: 'Runs the iPhone build so its screens can be read.',
      fix: 'Install Xcode and its command line tools.',
      automatic: false,
    };
  }
  const args = binary === direct ? ['list', 'runtimes', '-j'] : ['simctl', 'list', 'runtimes', '-j'];
  const answer = await ask(binary, args, PROBE_MS);
  if (answer.hung) {
    return {
      id: 'simulator',
      name: 'the iOS simulator',
      found: false,
      where: binary,
      why: 'Runs the iPhone build so its screens can be read.',
      fix: 'simctl is installed but did not answer. Open Simulator.app once, or run `sudo xcode-select --reset`, then try again.',
      automatic: false,
    };
  }
  /** @type {string[]} */
  let runtimes = [];
  try {
    const parsed = /** @type {{runtimes?: {name?: string, isAvailable?: boolean}[]}} */ (JSON.parse(answer.out));
    runtimes = (parsed.runtimes ?? []).filter((r) => r.isAvailable !== false).map((r) => String(r.name ?? '')).filter(Boolean);
  } catch {
    runtimes = [];
  }
  return {
    id: 'simulator',
    name: 'the iOS simulator',
    found: runtimes.length > 0,
    where: binary,
    version: runtimes[0],
    why: 'Runs the iPhone build so its screens can be read.',
    fix: runtimes.length > 0 ? undefined : 'Install at least one iOS runtime in Xcode under Settings, Platforms.',
    automatic: false,
  };
}

/**
 * Is a package installed for this project?
 * @param {string} cwd
 * @param {string} name
 * @returns {boolean}
 */
function hasModule(cwd, name) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, 'node_modules', name, 'package.json'))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/**
 * The settings file with everything commented out taken away.
 *
 * `staysfixed init` writes a settings file whose whole point is that the options which do
 * NOT apply to your project are commented out rather than left out, so nothing is hidden
 * from the person reading it. Doctor reads that file as TEXT — never by loading it, because
 * a settings file may be JavaScript and doctor must not run somebody's code to answer a
 * question about their machine — and it used to search the raw text.
 *
 * Which means it found the examples. On a folder containing one `cli.js` and nothing else,
 * doctor announced "Electron desktop apps: Covered. It opens release/mac-arm64/Your App.app"
 * and "An Android app is here", both read out of commented-out lines, and both false. A
 * surface reported as covered when nothing will ever be walked on it is the worst answer
 * this tool can give.
 *
 * Strings are respected, so an address like "http://localhost:3000" survives: the two
 * slashes inside it are not the start of a comment.
 *
 * @param {string} text
 * @returns {string}   The same text with comments blanked, line numbering unchanged.
 */
export function withoutComments(text) {
  let out = '';
  /** @type {"code"|"line"|"block"|"'"|'"'|'`'} */
  let mode = 'code';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (mode === 'code') {
      if (c === '/' && next === '/') { mode = 'line'; out += '  '; i += 1; continue; }
      if (c === '/' && next === '*') { mode = 'block'; out += '  '; i += 1; continue; }
      if (c === "'" || c === '"' || c === '`') mode = /** @type {any} */ (c);
      out += c;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; continue; }
      out += ' ';
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') { mode = 'code'; out += '  '; i += 1; continue; }
      out += c === '\n' ? c : ' ';
      continue;
    }
    // Inside a string. A backslash escapes whatever comes next, quote included.
    if (c === '\\') { out += c + (next ?? ''); i += 1; continue; }
    if (c === mode) mode = 'code';
    out += c;
  }
  return out;
}

/**
 * Is there a desktop app in this project to check?
 *
 * Asked without running anything and without importing the project's settings.
 * A settings file may be JavaScript, and doctor must never execute a person's
 * code to answer a question about their machine — so the file is READ as text
 * and looked at, never loaded.
 *
 * Three answers count, in order of how sure they make us: settings that name an
 * app, a built app sitting in the usual output folder, and Electron in the
 * project's dependencies.
 *
 * @param {string} cwd
 * @returns {{where: string, how: string}|null}
 */
function findDesktopApp(cwd) {
  const configFile = findConfigFile(cwd);
  if (configFile) {
    try {
      // Comments taken away first. See `withoutComments`: the examples in a settings file
      // are commented out on purpose, and reading them as settings reported a desktop app
      // in a folder that contains one script.
      const text = withoutComments(readFileSync(configFile, 'utf8'));
      const named = /["']?binary["']?\s*:\s*["'`]([^"'`]+)["'`]/.exec(text);
      if (named) return { where: named[1], how: 'your settings name it under electron.binary' };
      if (/["']?kind["']?\s*:\s*["'`]electron["'`]/.test(text)) {
        return { where: configFile, how: 'your settings say this project is a desktop app' };
      }
    } catch {
      // Unreadable settings are not an answer either way; keep looking.
    }
  }

  // rootForConfig, never path.dirname: a config kept at `.staysfixed/config.json` — one of
  // the six names this tool looks for — would otherwise make the project root the
  // `.staysfixed` folder itself, and every adapter would be asked about an empty directory.
  // Measured on Terminal Deck: doctor reported "a built APK is still missing" with the APK
  // sitting two folders up, and told the agent to go and build one that was already there.
  const root = configFile ? rootForConfig(configFile) : cwd;
  const ext = process.platform === 'darwin' ? '.app' : process.platform === 'win32' ? '.exe' : '.AppImage';
  for (const folder of ['dist', 'out', 'release', 'build']) {
    const dir = path.join(root, folder);
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.endsWith(ext)) return { where: path.join(dir, entry.name), how: 'it is built and sitting in ' + folder + '/' };
      // electron-builder puts the app one level down, in a per-platform folder.
      if (!entry.isDirectory()) continue;
      try {
        for (const inner of readdirSync(path.join(dir, entry.name))) {
          if (inner.endsWith(ext)) return { where: path.join(dir, entry.name, inner), how: 'it is built and sitting in ' + folder + '/' + entry.name + '/' };
        }
      } catch {
        // Not readable. Not an answer.
      }
    }
  }

  if (hasModule(cwd, 'electron')) {
    return { where: root, how: 'this project depends on Electron, so it makes one — but nothing says where the built app is' };
  }
  return null;
}

/**
 * A built thing this tool could be pointed at, and how we know it is there.
 * @typedef {{where: string, how: string}} FoundApp
 */

/**
 * Is there a phone app in this project to check?
 *
 * The same three answers as the desktop app, in the same order of how sure they make us:
 * settings that name one, a built artifact sitting where the toolchain puts it, and a
 * project layout that says one gets made. Settings are READ as text and never loaded — a
 * settings file may be JavaScript, and doctor must never run somebody's code to answer a
 * question about their machine.
 *
 * Asking this at all is the point. A Mac with Xcode on it can run an iPhone app; that says
 * nothing about whether THIS project has one. Telling somebody with a website to go and
 * install thirty gigabytes of Xcode is asking for work that changes nothing, and the whole
 * design turns on never doing that.
 *
 * @param {string} root
 * @param {string|null} settingsText
 * @returns {Promise<{android: FoundApp|null, ios: FoundApp|null}>}
 */
async function phoneApps(root, settingsText) {
  // Comments taken away first, for the same reason `findDesktopApp` does it: a
  // commented-out `apk:` line is an example, not an Android app.
  const settings = settingsText ? withoutComments(settingsText) : '';

  /**
   * @param {string} key
   * @returns {FoundApp|null}
   */
  const named = (key) => {
    const found = new RegExp(`["']?${key}["']?\\s*:\\s*["'\`]([^"'\`]+)["'\`]`).exec(settings);
    return found ? { where: found[1], how: `your settings name it under ${key}` } : null;
  };

  /**
   * A named key whose value has to look right, so one settings word cannot be mistaken for
   * another block's.
   * @param {string} key
   * @param {(value: string) => boolean} looksRight
   * @returns {FoundApp|null}
   */
  const namedPath = (key, looksRight) => {
    const found = new RegExp(`["']?${key}["']?\\s*:\\s*["'\`]([^"'\`]+)["'\`]`).exec(settings);
    return found && looksRight(found[1]) ? { where: found[1], how: `your settings name it under ${key}` } : null;
  };

  /**
   * @param {string[]} folders
   * @param {(name: string) => boolean} wanted
   * @returns {FoundApp|null}
   */
  const built = (folders, wanted) => {
    for (const folder of folders) {
      const dir = path.join(root, folder);
      /** @type {string[]} */
      let entries = [];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (wanted(entry)) return { where: path.join(dir, entry), how: `it is built and sitting in ${folder}/` };
      }
    }
    return null;
  };

  /** @param {string} rel */
  const there = (rel) => existsSync(path.join(root, rel));

  const android =
    named('apk') ??
    built(['dist', 'out', 'build', 'release', path.join('android', 'app', 'build', 'outputs', 'apk', 'release')], (name) => name.endsWith('.apk')) ??
    (there(path.join('android', 'build.gradle')) || there(path.join('android', 'build.gradle.kts')) || there('build.gradle') || there('build.gradle.kts')
      ? { where: path.join(root, 'android'), how: 'this project builds one, but nothing says where the built APK is' }
      : null);

  const ios =
    // `ios.app` FIRST, because that is the key the adapter reads and the key this very file
    // tells people to write: "name the built .app in your settings under ios.app". It then
    // looked only for `xcworkspace`, so a settings file naming a real built app was invisible
    // and doctor answered "no iPhone app was found in this project, and the settings do not
    // name one" about a project whose settings named one. Measured 2026-08-31 against a real
    // TerminalDeck.app. The value has to end in `.app` so a bare `app:` belonging to some
    // other block can never be mistaken for this one.
    namedPath('app', (v) => v.endsWith('.app')) ??
    named('xcworkspace') ??
    built(['dist', 'out', 'build', 'release'], (name) => name.endsWith('.app')) ??
    (there(path.join('ios', 'Podfile')) || readdirSafe(path.join(root, 'ios')).some((n) => n.endsWith('.xcodeproj') || n.endsWith('.xcworkspace'))
      ? { where: path.join(root, 'ios'), how: 'this project builds one, but nothing says where the built app is' }
      : readdirSafe(root).some((n) => n.endsWith('.xcodeproj') || n.endsWith('.xcworkspace'))
        ? { where: root, how: 'there is an Xcode project here, but nothing says where the built app is' }
        : null);

  return { android, ios };
}

/**
 * "an electron journey", not "a electron journey". A small thing, and the sort of small
 * thing that makes a reader trust the rest of the sentence less.
 * @param {string} word
 * @returns {string}
 */
function an(word) {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Does this stop everything, or only narrow it? Read out of the sentence written for it in
 * {@link askTheAdapters}, which is the only place that sentence comes from.
 * @param {Need} need
 * @returns {boolean}
 */
function blocks(need) {
  return need.why.startsWith('Nothing on this platform');
}

/**
 * One adapter's — or one machine's — `Missing` in the shape the rest of this file reads.
 *
 * The two shapes exist for good reasons and neither is going away: an adapter says what it
 * needs and what that unlocks, and doctor has to say additionally whether a person is
 * required. The translation between them is the only place that decision is made, so both
 * callers make it the same way and `blocks` above keeps reading the sentence it expects.
 *
 * @param {import('./adapters/contract.js').Missing} m
 * @returns {Need}
 */
function needFromMissing(m) {
  return {
    what: String(m.what),
    why: m.blocking === true ? 'Nothing on this platform can be checked at all without it.' : 'It widens what can be watched here.',
    fix: String(m.howToGet ?? ''),
    // Whether a person is needed is read out of the words, because the adapter
    // contract has no field for it. A licence, an account, a pair of hands or a
    // device is a person; everything else is a command the agent just runs. Being
    // wrong in this direction only ever means telling somebody about a step they
    // did not have to take, which is far cheaper than the other way round.
    automatic: !/licen[cs]e|apple id|app store|plug|pair of hands|somebody has to|a person|sign in|log in|only a person/i.test(String(m.howToGet ?? '')),
    unlocks: String(m.unlocks ?? ''),
  };
}

/**
 * What one platform reports when the adapter that answers for it did not answer.
 *
 * Written as blocking on purpose. It is not a claim that the platform cannot be checked — it
 * is the honest opposite, that nobody here knows — and between the two ways of being wrong,
 * saying less is covered than really is costs somebody a second look, while saying more is
 * covered than really is costs them a green run that means nothing.
 *
 * @param {string} name
 * @param {string} why
 * @returns {Need}
 */
function couldNotAsk(name, why) {
  return {
    what: `an answer from the ${name} adapter about what it needs`,
    why: 'Nothing on this platform can be checked at all without it.',
    fix: `The ${name} adapter was asked what it needs here and ${why}, so nothing on this page says whether it would work. Run \`staysfixed doctor\` again; if it keeps happening, run a check aimed at ${name} and read what that says.`,
    automatic: true,
    unlocks: `an honest answer about whether your ${name} product can be checked on this machine — right now there is none, in either direction`,
  };
}

/**
 * The platforms that arrive as an adapter of their own, and know their own requirements.
 * The built-in five are described by hand above, because they are older than this
 * mechanism and their wording is tested; these three answer for themselves.
 */
const ADAPTERS_THAT_ANSWER_FOR_THEMSELVES = ['android', 'ios', 'windows'];

/**
 * Ask each separate adapter what IT is missing, in its own words.
 *
 * This is "detect rather than ask" carried all the way through. An adapter knows what it
 * needs; this file does not, and a list of program names kept here is a second opinion
 * about the same question — the shape of bug this whole tool exists to catch. It was
 * already wrong once: this file asked for Appium on behalf of an Android adapter that does
 * not use Appium, and somebody would have spent twenty minutes installing it for nothing.
 *
 * Every call is raced against a timeout and every failure becomes silence. Doctor is what
 * somebody runs when they are already stuck, and an adapter that will not answer must not
 * take the rest of the answer with it.
 *
 * @param {string} root
 * @param {string|null} [settingsText]   The settings as text — from disk, or from what
 *                                       `init` is about to write.
 * @param {boolean} [settingsAreJson]
 * @returns {Promise<Map<string, Need[]>>}
 */
async function askTheAdapters(root, settingsText = null, settingsAreJson = false) {
  /** @type {Map<string, Need[]>} */
  const out = new Map();
  /** @type {{adapters: {name: string, detect: (p: any) => Promise<any>}[]}} */
  let engine;
  try {
    engine = /** @type {any} */ (await import('./check.js')).loadAdapters ? await (await import('./check.js')).loadAdapters() : { adapters: [] };
  } catch {
    return out;
  }

  /** @type {Record<string, any>} */
  let config = {};
  try {
    // Read as text and parsed only when it is JSON. Doctor never runs a person's code to
    // answer a question about their machine, and a settings file may be JavaScript.
    if (settingsText && settingsAreJson) config = JSON.parse(settingsText);
    // But "not JSON" was being treated as "says nothing", and `init` writes JavaScript — so
    // for almost every project every adapter was asked what it needs while being handed an
    // EMPTY config. It then asked for the very thing the settings already named: a project
    // whose settings pointed at a real built TerminalDeck.app was told, in one sentence,
    // "the app is here. What is missing is a built iPhone app to check". Measured 2026-08-31.
    //
    // The few values the adapters need to answer honestly are read out of the TEXT instead,
    // scoped to their own block so one block's `app` can never be read as another's. Still no
    // code is run, which was the whole point of the rule.
    else if (settingsText) config = { ...config, ...settingsFromText(settingsText) };
  } catch {
    config = {};
  }

  await Promise.all(
    ADAPTERS_THAT_ANSWER_FOR_THEMSELVES.map(async (name) => {
      const adapter = engine.adapters.find((a) => a.name === name);
      if (!adapter) return;
      try {
        /** @type {{missing?: {what?: string, unlocks?: string, howToGet?: string, blocking?: boolean}[]}|null} */
        const detection = await Promise.race([
          adapter.detect({ root, config: config[name] ?? {} }),
          // Null, not an empty answer. "The adapter says it needs nothing" and "the adapter
          // never answered" reached this line as the same empty list, and an empty list is
          // what makes a surface READY: an Android adapter that hung for sixteen seconds
          // produced "Covered against the stored record" on a machine where nothing had been
          // asked at all. A silence that turns into an all-clear is the exact failure this
          // whole tool exists to prevent, so silence now has a value of its own.
          new Promise((resolve) => setTimeout(() => resolve(null), REACH_MS * 2)),
        ]);
        out.set(name, detection === null ? [couldNotAsk(name, `it did not answer within ${Math.round((REACH_MS * 2) / 1000)} seconds`)] : (detection.missing ?? [])
          .filter((m) => typeof m.what === 'string' && m.what !== '')
          .map((m) => needFromMissing(/** @type {import('./adapters/contract.js').Missing} */ (m)))
          .filter((need) => need.fix !== ''));
      } catch (e) {
        // Same again for an adapter that fell over. It contributes a hole, never a silence:
        // the machine survey stands, and this platform says plainly that nothing here knows
        // whether it would work.
        out.set(name, [couldNotAsk(name, messageOf(e))]);
      }
    }),
  );
  return out;
}

/**
 * What THIS COPY of Stays Fixed knows how to drive.
 *
 * Asked of the engine rather than assumed, and asked in a try/catch, because doctor is the
 * call somebody makes when everything else is broken and it must answer even then. A
 * surface with no adapter behind it can never be reported as ready, whatever this machine
 * has installed on it: the machine could run the app, and nothing here would open it.
 *
 * @returns {Promise<DriverReport[]>}
 */
async function whatThisCopyCanDrive() {
  /** @type {DriverReport[]} */
  const out = [];
  try {
    const engine = await import('./check.js');
    const { adapters, missing } = await engine.loadAdapters();
    for (const [surface, name] of Object.entries(engine.ADAPTER_FOR_SURFACE)) {
      const present = adapters.some((a) => a.name === name);
      out.push({
        surface,
        present,
        why: present
          ? `The ${name} adapter is in this copy, so ${an(surface)} journey has something to walk it.`
          : missing.get(surface) ?? `There is no ${name} adapter in this copy, so nothing would walk ${an(surface)} journey.`,
      });
    }
  } catch (e) {
    // The engine would not load. The surfaces that arrive as a separate adapter are the
    // ones that must not be guessed at, so they are reported as absent with the real
    // reason rather than left to default to a yes. The built-in five live in the very
    // file that would not load, so a check on this copy is not running at all — and both
    // the command line and the MCP surface say that in their own words already.
    const why = `This copy could not be asked what it can drive: ${messageOf(e)}`;
    for (const surface of ['android', 'ios', 'windows']) out.push({ surface, present: false, why });
  }
  return out;
}

/**
 * Where Playwright keeps the browsers it downloaded, if it has downloaded any.
 * @returns {string|null}
 */
function playwrightBrowsersDir() {
  const home = os.homedir();
  const candidates =
    process.platform === 'darwin'
      ? [path.join(home, 'Library', 'Caches', 'ms-playwright')]
      : process.platform === 'win32'
        ? [path.join(home, 'AppData', 'Local', 'ms-playwright')]
        : [path.join(home, '.cache', 'ms-playwright')];
  for (const dir of candidates) if (existsSync(dir)) return dir;
  return null;
}

/**
 * An Android SDK tool in the place the SDK normally puts it.
 * @param {string} folder
 * @param {string} name
 * @returns {string|null}
 */
function androidSdkTool(folder, name) {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(os.homedir(), 'Library', 'Android', 'sdk'), path.join(os.homedir(), 'Android', 'Sdk')];
  for (const root of roots) {
    if (!root) continue;
    const candidate = path.join(root, folder, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ── other machines ──────────────────────────────────────────────────────────

/**
 * The hosts this machine can already reach, found by reading the SSH config and
 * then actually dialling them.
 *
 * This is the sharpest form of "detect rather than ask" in the file. A host that
 * answers is a runner the tool already has, and it must never appear in the
 * result as something to go and set up.
 *
 * @param {{dial?: boolean}} [opts]
 * @returns {Promise<HostReport[]>}
 */
export async function reachableHosts(opts = {}) {
  if (!onPath('ssh')) return [];
  const names = await sshConfigHosts();
  if (names.length === 0) return [];

  // READING the ssh config is free and tells nobody anything. DIALLING is neither, and it
  // is not something this tool may do to somebody who has just installed it.
  //
  // The first command a stranger runs is `doctor`. On a brand-new scratch project with no
  // settings file and nothing that could possibly need a second machine, this opened ssh
  // connections to every host in their `~/.ssh/config` and ran a command on each — measured
  // on 2026-08-30: ten hosts configured, connections out within seconds of the first run,
  // nothing said before or after. Those are production servers in a lot of people's configs,
  // and in a lot of workplaces that alone is a policy breach. `--offline` existed, but a way
  // out you only learn about afterwards is not consent.
  //
  // So it is asked for now rather than assumed, and the machines are still NAMED either way,
  // because a machine quietly left out of the answer is the same bug as a folder quietly
  // skipped while reading source: the list looks complete and the runner somebody needed is
  // simply not in it.
  if (opts.dial !== true) {
    return names.map(
      (name) =>
        /** @type {HostReport} */ ({
          name,
          reachable: false,
          how: 'named in your ssh config and deliberately NOT dialled. Nothing here needs a second machine, and this tool does not connect to yours unasked. `staysfixed doctor --machines` checks them.',
        })
    );
  }

  const dialled = await Promise.all(names.slice(0, MAX_HOSTS).map((name) => describeHost(name)));
  // Anything past the cap is NAMED rather than dropped. A machine quietly left out of
  // this list is the same shape of bug as a folder quietly skipped while reading source:
  // the answer looks complete, and the runner somebody needed is simply not in it.
  const skipped = names.slice(MAX_HOSTS).map(
    (name) =>
      /** @type {HostReport} */ ({
        name,
        reachable: false,
        how: `not dialled — your ssh config names ${names.length} machines and this stops after ${MAX_HOSTS} so doctor stays quick. Nothing is known about this one either way.`,
      })
  );
  return [...dialled, ...skipped];
}

/**
 * The word a machine has to say back before anything it reports is believed, and
 * it has to say it on standard output, on a line of its own.
 *
 * All three halves of that sentence were bought with a wrong answer on this Mac.
 * `ssh github-imza 'echo staysfixed-reachable'` is refused by github.com with
 * `Invalid command: echo staysfixed-reachable` — on stderr, and containing the word,
 * because the refusal quotes the command back. A probe that looked for the word
 * anywhere in either stream therefore listed github.com among the machines this tool
 * could run checks on, twice over: once as reachable, and once as a Windows desktop.
 */
const ALIVE = 'staysfixed-reachable';

/**
 * What is on the other end of one ssh host name.
 *
 * Two rules, and both of them are scar tissue.
 *
 * READ STANDARD OUTPUT, AND MATCH THE WHOLE LINE. See `ALIVE`. A host that refuses
 * commands is not a machine that can run them, and it must not be listed as one.
 *
 * NO SHELL VARIABLES, NO LOOPS, NOTHING BUT LITERAL ARGUMENTS. `imza-pc` in this
 * machine's ssh config reaches a Windows box whose OpenSSH hands the command down
 * through a second shell, and every `$p` is expanded to nothing before the shell that
 * was meant to read it ever sees it: `for p in "A"; do echo "$p"; done` prints an empty
 * line there. `ls -d` with the paths written out is the same question asked in a way
 * no extra layer can eat.
 *
 * @param {string} name
 * @returns {Promise<HostReport>}
 */
async function describeHost(name) {
  const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'];
  const alive = await ask('ssh', [...ssh, name, `echo ${ALIVE}`], REACH_MS);
  if (!answered(alive)) return readHostProbe(name, alive, null);
  // Nothing more is asked of a machine that will not even echo. Everything below costs a
  // second connection, and spending it on a host that did not answer the first one is how
  // doctor stops being the quick command somebody runs when they are already stuck.

  // A shell that can SEE powershell.exe on the filesystem has a real Windows desktop
  // behind it — the cheapest Windows runner there is, and one nobody has to provision.
  // Asked of the filesystem, never of the path: powershell.exe is not on the PATH of a
  // non-interactive ssh session even on a machine configured to put it there, so
  // `command -v powershell.exe` answers "no" on a box with Windows sitting right behind
  // it. The one list of places to look lives in remote.js, which is the file that later
  // has to actually run one.
  const look = await ask('ssh', [...ssh, name, `ls -d ${POWERSHELL_PATHS.map((p) => `'${p}'`).join(' ')}`], REACH_MS);
  const report = readHostProbe(name, alive, look);

  // And then the half that was written and never called.
  //
  // "Reachable" on its own is not an answer anybody can act on. The requirement this whole
  // file exists to meet is that a stranger's AI can read what the tool needs and tell the
  // person, with the exact commands — and a remote machine that comes back as one boolean
  // and a sentence fails that completely. `describeRemote` answers the rest: what is
  // installed there, whether anybody is signed in on the Windows desktop, whether it is
  // locked, and a list of what is missing with the command for each.
  //
  // It never throws, but it does open a connection, so it is still wrapped: doctor answering
  // less is a bad day, and doctor not answering is the command somebody runs when they are
  // already stuck failing on them.
  try {
    const detail = await describeRemote(name, {
      // What the cheap probe already proved, handed over rather than asked again. Without
      // this, a machine with no Node on it comes back "could not be reached" and the fix
      // offered is the ssh config that just worked.
      answered: true,
      powershell: report.powershell ?? null,
      timeoutMs: REACH_MS * 2,
      windowsTimeoutMs: REACH_MS * 4,
    });
    return withRemoteDetail(report, detail);
  } catch (e) {
    return { ...report, how: `${report.how}, but nothing more could be learned about it (${messageOf(e)})` };
  }
}

/**
 * Fold what the runner learned into what the cheap probe proved.
 *
 * Split out and exported so the merge can be tested without a network: the rule that the
 * shallow answer wins on reachability is the whole point of it, and a rule that only exists
 * inside a function nothing can call without an ssh key is a rule nobody will notice
 * breaking.
 *
 * @param {HostReport} report   What the plain `echo` and `ls` probes established.
 * @param {import('./remote.js').RemoteDescription} detail
 * @returns {HostReport}
 */
export function withRemoteDetail(report, detail) {
  /** @type {HostReport} */
  const out = { ...report, detail };
  // Windows, only ever added. The cheap probe asks the filesystem for powershell.exe and is
  // right whether or not anything else on that machine works; the deep one cannot ask at all
  // unless the runner started. So a `false` from the deep probe is "could not tell", and
  // letting it clear a `true` would lose the Windows runner somebody already has.
  if (detail.windows === true && out.windows !== true) {
    out.windows = true;
    if (detail.powershell) out.powershell = detail.powershell;
  }
  // `detail.how` already opens with the fact that a shell answers, so it replaces the
  // shallower sentence rather than being appended to it. Two sentences saying the same thing
  // in different words is how a reader starts wondering which of them is the real answer.
  if (!detail.runnerStarted) out.how = detail.how;
  return out;
}

/**
 * Did that machine actually say the word, on its own line, on standard output?
 * @param {{stdout: string}} alive
 * @returns {boolean}
 */
function answered(alive) {
  return alive.stdout.split('\n').some((line) => line.trim() === ALIVE);
}

/**
 * Turn the two probe answers into what we will say about that machine.
 *
 * Split out from the dialling so the decision can be tested against the exact bytes real
 * machines send back — a github.com refusal, an OpenSSH warning banner on stderr, a WSL
 * shell with Windows behind it — without any test needing a network or an ssh key.
 *
 * @param {string} name
 * @param {{stdout: string, stderr: string, why: string}} alive   The `echo` probe.
 * @param {{stdout: string}|null} look   The PowerShell probe, or null if we never got that far.
 * @returns {HostReport}
 */
export function readHostProbe(name, alive, look) {
  if (!answered(alive)) {
    // Three different silences, and they mean different things to whoever reads this.
    // A host that talked but would not run the command is a git remote, not a machine
    // with a shell on it, and telling somebody their ssh key is broken would send them
    // off fixing something that already works.
    const spoke = (alive.stdout + alive.stderr).trim() !== '';
    return {
      name,
      reachable: false,
      how: spoke
        ? 'it answered, but it does not give you a shell — nothing can be run on it. A git host such as github.com looks exactly like this.'
        : alive.why || 'it did not answer',
    };
  }

  const powershell = (look?.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => POWERSHELL_PATHS.includes(line));

  /** @type {HostReport} */
  const report = { name, reachable: true, how: 'it answered over ssh with the key you already have', windows: powershell !== undefined };
  if (powershell !== undefined) report.powershell = powershell;
  return report;
}

/**
 * The settings as text, or null when there are none to read yet.
 *
 * Null and empty are different answers here. "There is no settings file" is what makes a
 * surface unready; "the settings say nothing about this surface" is a different sentence.
 *
 * @param {string|null} file
 * @returns {string|null}
 */
function readTextOrNull(file) {
  if (!file) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * How much of this project is actually wired for the command-line surface.
 *
 * The `cli` surface was hard-coded READY with "Fully covered here" — it never looked at the
 * project at all. So on a settings file whose `process` block wires no commands and nothing
 * to import, doctor said command-line tools were fully covered, and a check then answered
 * "Nothing that worked has changed" having run not one command. Measured 2026-08-31.
 *
 * Counted out of the text, like everything else here, because the settings may be JavaScript
 * and doctor never runs a person's code to answer a question about their machine.
 *
 * @param {string} text
 * @returns {{commands: number, imports: number}}
 */
function whatTheProcessBlockWires(text) {
  const clean = withoutComments(text);
  const at = /["']?process["']?\s*:\s*\{/.exec(clean);
  if (!at) return { commands: 0, imports: 0 };
  let depth = 0;
  let end = at.index + at[0].length;
  for (; end < clean.length; end += 1) {
    if (clean[end] === '{') depth += 1;
    else if (clean[end] === '}') {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  const inside = clean.slice(at.index + at[0].length, end);
  return {
    commands: (inside.match(/["']?run["']?\s*:/g) ?? []).length,
    imports: (inside.match(/["']?module["']?\s*:/g) ?? []).length,
  };
}

/**
 * The handful of settings an adapter needs to say what it is missing, read out of a
 * JavaScript settings file WITHOUT running it.
 *
 * Scoped per block on purpose: `app` means one thing under `ios` and nothing under `web`, and
 * a flat search would hand the wrong path to the wrong adapter.
 *
 * @param {string} text
 * @returns {Record<string, any>}
 */
function settingsFromText(text) {
  const clean = withoutComments(text);
  /** @type {Record<string, any>} */
  const out = {};
  /** @type {Record<string, string[]>} */
  const wanted = {
    ios: ['app'],
    android: ['apk', 'package'],
    electron: ['binary'],
    web: ['url', 'start'],
    http: ['start', 'url'],
  };
  for (const [block, keys] of Object.entries(wanted)) {
    const at = new RegExp(`["']?${block}["']?\\s*:\\s*\\{`).exec(clean);
    if (!at) continue;
    // The block's own text: from its brace to the matching one, counted rather than guessed,
    // so a nested object cannot end the block early.
    let depth = 0;
    let end = at.index + at[0].length;
    for (; end < clean.length; end += 1) {
      if (clean[end] === '{') depth += 1;
      else if (clean[end] === '}') {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    const inside = clean.slice(at.index + at[0].length, end);
    /** @type {Record<string, string>} */
    const found = {};
    for (const key of keys) {
      const hit = new RegExp(`["']?${key}["']?\\s*:\\s*["'\`]([^"'\`]+)["'\`]`).exec(inside);
      if (hit) found[key] = hit[1];
    }
    if (Object.keys(found).length > 0) out[block] = found;
  }
  return out;
}

/**
 * Host names out of ~/.ssh/config. Patterns are skipped: `Host *` is a rule, not
 * a machine, and dialling it would be meaningless.
 * @returns {Promise<string[]>}
 */
async function sshConfigHosts() {
  /** @type {string[]} */
  const names = [];
  let text = '';
  try {
    text = await fsp.readFile(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
  } catch {
    return names;
  }
  for (const line of text.split('\n')) {
    const found = /^\s*Host\s+(.+?)\s*$/i.exec(line);
    if (!found) continue;
    for (const word of found[1].split(/\s+/)) {
      if (word.includes('*') || word.includes('?') || word.startsWith('!')) continue;
      if (!names.includes(word)) names.push(word);
    }
  }
  return names;
}

/**
 * Is there a reference to compare against yet?
 *
 * The cold start is real and worth saying out loud: on an existing product there
 * is nothing to compare against until it has been shipped once with the hook in
 * place, and pretending otherwise is how a tool reports a false all-clear.
 *
 * @param {string} root
 * @returns {Promise<{found: boolean, note: string}>}
 */
async function findReference(root) {
  // The store owns where it keeps things, so this asks it rather than guessing
  // at folder names. Guessing is how doctor ends up telling somebody with a
  // perfectly good reference to go and record one.
  /** @type {import('./types.js').Store|null} */
  let store = null;
  try {
    const { openStore } = await import('./store.js');
    store = openStore({ root });
  } catch {
    store = null;
  }
  if (!store) {
    return { found: false, note: 'This copy has no store to look in, so nothing has been recorded and there is nothing to compare a new build against.' };
  }

  /** @type {Record<string, {buildId?: string, setAt?: string, setBy?: string}>} */
  let pointers = {};
  try {
    const parsed = JSON.parse(await fsp.readFile(store.referencesFile, 'utf8'));
    if (parsed && typeof parsed === 'object') pointers = parsed;
  } catch {
    // No file, or an unreadable one. Both mean no reference, and neither is
    // worth an error: the answer below is the same either way.
  }

  const named = Object.entries(pointers).filter(([, p]) => typeof p?.buildId === 'string' && p.buildId !== '');
  if (named.length > 0) {
    const said = named
      .map(([product, p]) => `${product} is on ${p.buildId}${p.setAt ? `, set ${p.setAt.slice(0, 10)}` : ''}${p.setBy ? ` by ${p.setBy}` : ''}`)
      .join('; ');
    return { found: true, note: `A build is on record as working: ${said}. The records are in ${shortPath(store.dir)}.` };
  }

  // Captures with no pointer is a real and different state: the tool has been
  // run, but nobody has said which build counts as working yet.
  let builds = 0;
  try {
    builds = (await fsp.readdir(store.buildsDir)).length;
  } catch {
    builds = 0;
  }
  if (builds > 0) {
    return {
      found: false,
      note: `${builds} ${builds === 1 ? 'build has' : 'builds have'} been recorded in ${shortPath(store.dir)}, but none of them is marked as the one that works, so there is still nothing to compare against. The mark is made when you ship.`,
    };
  }
  return {
    found: false,
    note: 'Nothing recorded yet, so there is nothing to compare against. Run `staysfixed check --paired` once, or ship once with the reference hook in place.',
  };
}

// ── what that adds up to ────────────────────────────────────────────────────

/**
 * Turn the raw findings into the only thing anybody actually wants: for each
 * kind of product, can this machine watch it, and if not, what exactly is in
 * the way.
 *
 * @param {ToolReport[]} tools
 * @param {HostReport[]} hosts
 * @param {boolean} configured
 * @param {import('./browsers.js').BrowserSurvey} browsers
 * @param {{where: string, how: string}|null} desktopApp
 * @param {DriverReport[]} drivers      What this copy of the tool can drive at all.
 * @param {{android: FoundApp|null, ios: FoundApp|null}} phones
 * @param {Map<string, Need[]>} asked   What each separate adapter says IT is missing.
 * @param {{commands: number, imports: number}} [wires]
 *   What this project's own settings wire for the command-line surface. A surface with
 *   nothing wired covers nothing here, whatever this machine could do.
 * @returns {SurfaceReport[]}
 */
function describeSurfaces(tools, hosts, configured, browsers, desktopApp, drivers, phones, asked, wires = { commands: 0, imports: 0 }) {
  /** @param {string} surface */
  const canDrive = (surface) => drivers.find((d) => d.surface === surface)?.present !== false;
  /** @param {string} surface */
  const noDriver = (surface) => drivers.find((d) => d.surface === surface)?.why ?? '';
  /** @param {string} id */
  const have = (id) => tools.some((t) => t.id === id && t.found);
  const browser = browsers.chosen !== null;
  const ownBrowser = browsers.chosen !== null && !browsers.chosen.everyday;
  const windowsHost = hosts.find((h) => h.reachable && h.windows === true);

  /** Every channel that needs no driver at all — a child process is enough. */
  const withoutADriver = ['effects', 'complaints', 'results', 'contract', 'counters'];

  /** @type {Omit<SurfaceReport, 'state'>[]} */
  const surfaces = [];

  /** Surfaces nothing on this machine could ever unlock, and what to do instead. */
  /** @type {Map<string, string>} */
  const impossible = new Map();

  /**
   * Of those, the ones whose reason is the PROJECT rather than the machine. A repository
   * with no iPhone app in it needs no simulator, and saying "iPhone apps cannot be done
   * here" on a Mac with Xcode installed is simply untrue.
   * @type {Set<string>}
   */
  const notInThisProject = new Set();

  // READY is about this PROJECT, not about this machine. Hard-coded ready meant doctor said
  // command-line tools were "fully covered here" on a settings file that wires no commands
  // and nothing to import — and a check then answered "Nothing that worked has changed"
  // having run not one command.
  const wiredForCli = configured && wires.commands + wires.imports > 0;
  surfaces.push({
    id: 'cli',
    name: 'command-line tools and libraries',
    status: wiredForCli ? 'ready' : 'partial',
    summary: wiredForCli
      ? 'Fully covered here. What it printed, what it exited with, what it wrote, what it called out to, and what it exports.'
      : configured
        ? 'This machine can cover it in full — what a command printed, what it exited with, what it wrote, what it called out to, what it exports — but these settings wire no command to run and nothing to import, so a check runs none of it and a clean result says nothing about any of it.'
        : 'This machine can cover it in full, but nothing is set up in this folder yet, so a check cannot run here at all.',
    canCheck: withoutADriver,
    cannotCheck: ['meaning', 'pixels'],
    needs: wiredForCli
      ? []
      : [{
          what: 'a command to run, or something to import',
          why: 'Nothing here is walked otherwise, and a run that walks nothing still finishes and still says nothing changed.',
          fix: 'Add `process: { commands: [{ name: "help", run: "node bin/cli.js --help" }] }` to your settings, or `imports: [{ name: "the package entry", module: "index.js" }]`.',
          automatic: true,
          unlocks: 'Everything a command does — what it printed, what it exited with, what it wrote to disk, what it reached for.',
        }],
  });

  surfaces.push({
    id: 'server',
    name: 'servers and APIs',
    status: have('docker') ? 'ready' : 'partial',
    summary: have('docker')
      ? 'Covered. Requests and answers are compared, and the schema is compared after any migration.'
      : 'Mostly covered. Without a way to restore the same data twice, anything that depends on stored data cannot be compared fairly.',
    canCheck: withoutADriver,
    cannotCheck: ['meaning', 'pixels'],
    needs: have('docker')
      ? []
      : [
          {
            what: 'a database snapshot that can be restored twice',
            why: 'Both builds have to see identical data or every difference is really a data difference.',
            fix: 'Install Docker, or point the settings at a dump file the tool may restore.',
            automatic: false,
            unlocks: 'Anything on your server that depends on stored data — totals, lists, permissions — gets compared fairly instead of being left out.',
          },
        ],
  });

  surfaces.push({
    id: 'web',
    name: 'web apps and sites',
    // A machine with only the person's own browser CAN check a website, so this is
    // not "unavailable" — but it is not "ready" either, because running it borrows
    // the browser they use. Calling that ready is how a tool ends up making somebody's
    // machine worse and reporting a clean run while it does.
    status: ownBrowser ? 'ready' : browser ? 'partial' : 'unavailable',
    summary: ownBrowser
      ? `Covered, including what the screen says each control is and does. It opens ${browsers.chosen?.name}, which is a separate application from the browser you use.`
      : browser
        ? 'Can be checked, but only by opening the browser you use yourself. It runs invisibly on a throwaway profile, so your settings and tabs are safe — but on a Mac it shares an application slot with your browser, so clicking your browser icon during a check may wake the hidden copy instead of opening your window.'
        : 'Cannot run here: there is no browser on this machine that will open a page.',
    canCheck: browser ? [...withoutADriver, 'meaning', 'pixels'] : [],
    cannotCheck: browser ? [] : CHANNELS.map((c) => c.id),
    needs: ownBrowser
      ? []
      : [
          {
            what: browser ? 'a browser of its own, so yours is left alone' : 'a browser to open pages with',
            why: browser
              ? 'Two copies of one browser share a single slot on a Mac. Its own browser is what stops a check in the background answering when you click your browser icon.'
              : 'A page has to actually open before anything can be read off it.',
            fix: INSTALL_COMMAND,
            automatic: true,
            unlocks: browser
              ? 'Checks stop borrowing the browser you use, so a run in the background can never answer when you click your own browser icon.'
              : 'Your website gets checked: every page, what each control says it is and does, what calls go out, and what the console complains about.',
          },
        ],
  });

  // A desktop app needs NO browser. It is its own Chromium and it opens its own
  // debugging port; the tool speaks to that port directly. Version 1's doctor said
  // otherwise and it was simply wrong — it would have told somebody with a perfectly
  // checkable Electron app to go and install Chrome.
  const namedApp = configured && desktopApp !== null && desktopApp.how.startsWith('your settings');
  surfaces.push({
    id: 'electron',
    name: 'Electron desktop apps',
    status: desktopApp === null ? 'unavailable' : namedApp ? 'ready' : 'partial',
    summary:
      desktopApp === null
        ? 'Nothing to check: no desktop app was found in this project, and the settings do not name one.'
        : namedApp
          ? `Covered. It opens ${desktopApp.where} with its own scratch data folder, drives it over its own debugging port — no browser involved — and reads the IPC channels straight out of the source.`
          : `A desktop app was found (${desktopApp.how}), but nothing says which built app to open, so a check would have to guess.`,
    canCheck: desktopApp === null ? [] : [...withoutADriver, 'meaning', 'pixels'],
    cannotCheck: desktopApp === null ? CHANNELS.map((c) => c.id) : [],
    needs:
      desktopApp === null || namedApp
        ? []
        : [
            {
              what: 'settings naming the built app',
              why: 'Two builds of one desktop app fight over its single-instance lock and its data folder, so the tool has to know exactly which file to open and give each run its own folder.',
              fix: `Run \`staysfixed init\`, or set electron.binary to ${desktopApp.where}.`,
              automatic: true,
              unlocks: 'Your desktop app gets checked end to end, including every IPC channel the code registers — the doors no screenshot has ever seen.',
            },
          ],
  });
  if (desktopApp === null) {
    notInThisProject.add('electron');
    impossible.set('electron', 'This project has no desktop app in it. If yours is built somewhere else, name the built app in your settings under electron.binary and this becomes available — nothing else is needed, and no browser is needed for it at all.');
  }

  // Three separate questions, and folding any two of them together is how a surface gets
  // called ready while nothing is ever walked on it: is there an Android app here to
  // check, does this copy of the tool know how to drive one, and does this machine have
  // what it takes to run it.
  // What Android needs is asked of the Android adapter, never guessed at from a list of
  // program names kept here. A second opinion about the same question is how a tool ends
  // up telling somebody to install Appium for an adapter that does not use Appium — and
  // being sent shopping for something that changes nothing is the fastest way to make a
  // person stop reading this page.
  const androidWants = asked.get('android') ?? [];
  const androidMissing = androidWants.map((need) => need.what);
  const androidBlocked = androidWants.some(blocks);
  const androidReady = androidWants.length === 0 && canDrive('android');
  // Missing something that stops everything and missing something that only narrows what
  // is watched are different answers, and rolling the second into the first tells somebody
  // their Android app cannot be checked when most of it can.
  const androidPartly = !androidReady && !androidBlocked && canDrive('android') && phones.android !== null;
  surfaces.push({
    id: 'android',
    name: 'Android apps',
    status: phones.android === null || !canDrive('android') ? 'unavailable' : androidReady ? 'ready' : androidPartly ? 'partial' : 'unavailable',
    summary:
      phones.android === null
        ? 'Nothing to check: no Android app was found in this project, and the settings do not name one.'
        : !canDrive('android')
          ? `An Android app is here (${phones.android.how}), and this copy of Stays Fixed cannot drive one. ${noDriver('android')}`
          : androidReady
            ? `Covered against the stored record. It installs ${phones.android.where} on a virtual device, walks it, and reads what each control on the screen is and does. Whether two emulator snapshots restore identically is still unproven, so a paired run is not offered — and the run says which mode it used.`
            : androidPartly
              ? `Most of your Android app can be checked: every screen another app can reach is opened and read. What is missing is ${plainList(androidMissing)}, and without ${androidMissing.length === 1 ? 'it' : 'them'} nothing is typed, pressed or saved — so a clean result covers the screens and not what the app DOES.`
              : `An Android app is here (${phones.android.how}), and ${plainList(androidMissing)} ${androidMissing.length === 1 ? 'is' : 'are'} still missing. ${androidWants.every((n) => n.automatic) ? `${androidMissing.length === 1 ? 'It installs' : 'They all install'} without anybody clicking anything, so nobody needs to be asked.` : 'Some of it needs a person, and each one says what it is and what it unlocks.'}`,
    canCheck: androidReady || androidPartly ? [...withoutADriver, 'meaning', 'pixels'] : [],
    cannotCheck: androidReady || androidPartly ? [] : CHANNELS.map((c) => c.id),
    needs: phones.android === null || !canDrive('android') ? [] : androidWants,
  });
  if (phones.android === null) {
    notInThisProject.add('android');
    impossible.set(
      'android',
      'This project has no Android app in it, so there is nothing here for an emulator to run. If yours is built somewhere else, name the built APK in your settings under android.apk and this becomes available — nothing else is needed.'
    );
  } else if (!canDrive('android')) {
    impossible.set(
      'android',
      `${noDriver('android')} Nothing you install on this machine changes that. Update Stays Fixed to a copy that has it; until then your Android app is not being checked by anything, and everything else on this list still is.`
    );
  }

  const onAMac = process.platform === 'darwin';
  const iosMachine = onAMac && have('simulator');
  // Whatever the iPhone adapter says it is missing, in its own words — the same as Android
  // and Windows. Nothing here keeps a list of program names on its behalf: this file asked
  // for Appium on Android's behalf once, for an adapter that does not use Appium, and it
  // would have cost somebody twenty minutes for nothing.
  const iosWants = asked.get('ios') ?? [];
  const iosBlocked = iosWants.some(blocks);
  const iosReady = iosMachine && canDrive('ios') && phones.ios !== null && iosWants.length === 0;
  const iosPartly = iosMachine && canDrive('ios') && phones.ios !== null && !iosReady && !iosBlocked;
  if (!onAMac) {
    impossible.set('ios', 'An iPhone build can only be run on a Mac. Everything else on this list is unaffected — check the iPhone app from a Mac, and let this machine cover the rest.');
  } else if (phones.ios === null) {
    notInThisProject.add('ios');
    impossible.set(
      'ios',
      'This project has no iPhone app in it, so there is nothing for the simulator to run. If yours is built somewhere else, name the built .app in your settings under ios.app and this becomes available.'
    );
  } else if (!canDrive('ios')) {
    impossible.set(
      'ios',
      `${noDriver('ios')} Nothing you install on this machine changes that. Update Stays Fixed to a copy that has it; until then your iPhone app is not being checked by anything, and everything else on this list still is.`
    );
  }
  surfaces.push({
    id: 'ios',
    name: 'iPhone apps, on the simulator',
    status: iosReady ? 'ready' : iosPartly ? 'partial' : 'unavailable',
    summary: !onAMac
      ? 'Cannot run here: iOS needs a Mac.'
      : phones.ios === null
        ? 'Nothing to check: no iPhone app was found in this project, and the settings do not name one.'
        : !canDrive('ios')
          ? `An iPhone app is here (${phones.ios.how}), and this copy of Stays Fixed cannot drive one. ${noDriver('ios')}`
          : !iosMachine
            ? 'Cannot run here: no usable iOS runtime was found, so there is no simulator to boot the app on.'
            : iosReady
              ? `Covered on the simulator, against the stored record. It boots ${phones.ios.where} on a simulator of its own and reads what each control on the screen is and does. A real iPhone in your hand cannot be compared side by side and never will be — two builds cannot exist on it at once.`
              : // "and the app is here" was said because a PATH was found, while the adapter was
                // still asking for a built app — so one sentence claimed the app was present and
                // missing at once. Measured 2026-08-31 on a settings file pointing at a
                // TerminalDeck.app that turned out to be an empty folder left by an old build.
                // A path is not a bundle, and only the adapter can tell the difference.
                iosWants.some((n) => /built iPhone app/i.test(String(n.what)))
                ? `The simulator is here and the settings name an app, but there is no built app bundle at that path — an empty folder from an old build looks exactly like this. What is missing is ${plainList(iosWants.map((n) => n.what))}.`
                : `The simulator is here and the app is here. What is missing is ${plainList(iosWants.map((n) => n.what))}, so a clean result would cover less than it looks like.`,
    canCheck: iosReady || iosPartly ? [...withoutADriver, 'meaning', 'pixels'] : [],
    cannotCheck: iosReady || iosPartly ? [] : CHANNELS.map((c) => c.id),
    needs:
      !onAMac || phones.ios === null || !canDrive('ios')
        ? []
        : [
            // Xcode and its runtimes are a download nobody can do for you: it needs an
            // Apple ID, a licence agreement and about thirty gigabytes.
            ...(!have('simulator')
              ? [
                  {
                    what: 'Xcode with at least one iOS runtime',
                    why: 'The simulator is the only place two builds of an iPhone app can be run one after the other.',
                    fix: 'Install Xcode from the App Store, open it once to accept the licence, then add an iOS runtime under Settings, Platforms. It is about thirty gigabytes and it needs an Apple ID, which is why nobody can do it for you.',
                    automatic: false,
                    unlocks: 'Your iPhone app gets checked before every release, on a simulator, without you opening anything.',
                  },
                ]
              : []),
            ...iosWants,
          ],
  });

  // A native Windows window can only be read from Windows. The tool does not need a
  // Windows machine of its own: any ssh host that reaches one — including a WSL shell on
  // it — is a runner, and one of those is usually already in somebody's ssh config. That
  // is "detect rather than ask" at its sharpest: a runner that already answers must never
  // be presented as something to go and set up.
  const windowsDriver = canDrive('windows');
  // A Windows desktop nobody has signed into is not a runner. There is nothing on it to read
  // — no windows, no controls — so calling it "partly covered" would be the exact over-claim
  // this file exists to prevent. The question can only be asked when the runner started
  // there, so `undefined` means nobody could tell and the older, more generous answer stands.
  const windowsSignedOut = windowsHost?.detail?.desktopLoggedIn === false;
  const windowsUsable = windowsHost !== undefined && windowsDriver && !windowsSignedOut;
  surfaces.push({
    id: 'windows',
    name: 'native Windows apps',
    status: windowsUsable ? 'partial' : 'unavailable',
    summary: !windowsHost
      ? 'No Windows desktop is reachable from here. This is usually fine: an Electron product on Windows is watched over the debug port instead, from any machine.'
      : !windowsDriver
        ? `A real Windows desktop is reachable through ${windowsHost.name}, and this copy of Stays Fixed cannot drive one. ${noDriver('windows')}`
        // The adapter's own paragraph, not a second one written here. It knows whether
        // anybody is signed in and whether the screen is locked, and those two change the
        // answer completely; a summary kept in this file could only ever guess at them, and
        // two descriptions of one machine will eventually disagree.
        : windowsHost.detail
          ? `${describeWindows(windowsHost.detail)} Nothing has to be installed on it either — the program that reads the screen is sent down the ssh connection each run and disappears when it closes.`
          : `A real Windows desktop is already reachable through ${windowsHost.name}, and nothing has to be installed on it — the program that reads the screen is sent down the ssh connection each run and disappears when it closes. Two builds still cannot run at once, because Windows shows one desktop, so runs are one after the other and the comparison is weaker here than anywhere else.`,
    canCheck: windowsUsable ? withoutADriver : [],
    cannotCheck: windowsUsable ? ['meaning', 'pixels'] : CHANNELS.map((c) => c.id),
    // Asked of the Windows adapter, which knows what it needs — the name of a machine and
    // the built program — rather than kept as a second opinion here. The one thing added
    // is the host name, because doctor found it by dialling and the adapter cannot.
    //
    // Plus whatever the machine itself is missing, which only the dial could find out: a
    // desktop nobody has signed into, a screen that is locked. Those come with the sentence
    // saying what each one unlocks, so an agent can relay one clear line to a person instead
    // of inventing instructions.
    needs:
      windowsHost && windowsDriver
        ? [
            ...(windowsHost.detail?.missing ?? []).map(needFromMissing),
            ...(asked.get('windows') ?? []).map((need) => ({ ...need, fix: need.fix.replace(/"the-ssh-host-name"/g, `"${windowsHost.name}"`) })),
          ]
        : [],
  });
  if (windowsSignedOut && windowsHost) {
    impossible.set(
      'windows',
      `${windowsHost.name} is a Windows machine and this copy can drive one, but nobody is signed in on that desktop. Nothing can be read off a desktop nobody has signed into. Sign in on it once and leave the session running — locking the screen afterwards is fine — and this becomes available.`,
    );
  }
  if (windowsHost && !windowsDriver) {
    impossible.set('windows', `${noDriver('windows')} Nothing you install on that machine changes it. Update Stays Fixed to a copy that has it.`);
  }
  if (!windowsHost) {
    impossible.set(
      'windows',
      'A native Windows window can only be read from Windows itself, and no Windows desktop answers from here. If your Windows product is Electron — most are — it is already covered over its debug port and you need nothing. If it is genuinely native, this becomes possible the day an SSH host in your config reaches a Windows machine.'
    );
  }

  return surfaces.map((surface) => {
    const instead = impossible.get(surface.id);
    if (!instead) return { ...surface, state: stateOf(surface, false) };
    /** @type {SurfaceReport} */
    const out = { ...surface, state: stateOf(surface, true), instead };
    if (notInThisProject.has(surface.id)) out.notInThisProject = true;
    return out;
  });
}

/**
 * What a green run on this machine would and would not actually mean.
 *
 * @typedef {object} Covers
 * @property {string} short          A short paragraph, safe to repeat to a person word for word.
 * @property {string[]} covered      Kinds of product a check here looks at in full.
 * @property {{name: string, why: string}[]} partly   Looked at, but not completely, and why.
 * @property {{name: string, why: string, whoFixes: SurfaceState}[]} notCovered
 * @property {boolean} everything    True only when nothing at all is left out.
  * @property {boolean} [canRunHere]
 *   False when nothing is set up in this folder, so a check cannot run here at all
 *   whatever this machine could otherwise drive.
 */

/**
 * The honest-degradation sentence, and the whole reason it exists.
 *
 * A project where only the web adapter works is still useful. What it must never
 * do is report a clean run that quietly means less than it looks like. So the
 * capabilities object carries, in one place, the words to say instead: this
 * covers your website; your iPhone app is not being checked, and here is why.
 *
 * @param {SurfaceReport[]} surfaces
 * @param {boolean} setUpHere   Whether a check can actually run in this folder at all.
 * @returns {Covers}
 */
function whatThisRunActuallyCovers(surfaces, setUpHere = true) {
  // Three buckets, not two. Folding "partly" into "covered" is exactly the
  // over-claim this function exists to stop: an iPhone app whose screens cannot
  // be read is not a covered iPhone app.
  const full = surfaces.filter((s) => s.status === 'ready');
  const some = surfaces.filter((s) => s.status === 'partial');
  const missing = surfaces.filter((s) => s.status === 'unavailable');

  /** @type {Covers} */
  const out = {
    short: '',
    covered: full.map((s) => s.name),
    partly: some.map((s) => ({ name: s.name, why: s.summary })),
    notCovered: missing.map((s) => ({ name: s.name, why: s.instead ?? s.summary, whoFixes: s.state })),
    everything: missing.length === 0 && some.length === 0,
  };

  if (full.length === 0 && some.length === 0) {
    out.short = 'Nothing on this machine can be checked yet, so a run here would prove nothing at all about your product.';
    return out;
  }

  /** @type {string[]} */
  const parts = [];
  // What this MACHINE can drive and what a check in THIS FOLDER would cover are two
  // different questions, and only one of them was being answered. In an empty folder — no
  // settings, no code — this said "A check here covers command-line tools and libraries and
  // web apps and sites in full" and doctor exited 0, while `check` in that same folder
  // refused to run at all: "No Stays Fixed config found here, so there is nothing to check."
  // Measured 2026-08-30. `doctor --json` is the first call an agent is told to make, which
  // is the worst place there is for a sentence with "here" in it to mean somewhere else.
  //
  // Everything below still says what it said — a reader needs the whole picture either way —
  // it is just no longer written as though a check could run.
  if (!setUpHere) {
    out.canRunHere = false;
    parts.push('Nothing is set up in this folder, so a check cannot run here at all and would cover nothing. Run `staysfixed init` first.');
    parts.push(full.length > 0 ? `Once it is set up, this machine could cover ${plainList(out.covered)} in full.` : 'Even set up, this machine could cover nothing in full.');
  } else {
    parts.push(full.length > 0 ? `A check here covers ${plainList(out.covered)} in full.` : 'A check here covers nothing in full.');
  }
  if (some.length > 0) parts.push(`It covers ${plainList(some.map((s) => s.name))} only partly — read the summary for each before treating a clean result as proof.`);
  if (missing.length > 0) {
    parts.push(`It does NOT check ${plainList(missing.map((s) => s.name))} at all, so a clean result says nothing whatever about ${missing.length === 1 ? 'that' : 'those'}.`);
    // Naming who can fix it is what turns a limitation into an action. The agent
    // clears its own list without mentioning it; only the rest reaches a person.
    const fixable = missing.filter((s) => s.state === 'the agent can fix this').map((s) => s.name);
    const needsPerson = missing.filter((s) => s.state === 'only a person can do this').map((s) => s.name);
    const never = missing.filter((s) => s.state === 'not possible here');
    if (fixable.length) parts.push(`${plainList(fixable, true)} could be added here without asking anybody — the commands are in nextSteps.`);
    if (needsPerson.length) parts.push(`${plainList(needsPerson, true)} needs a person to do something first, and what that is is written out in full.`);
    // Two different reasons, said as two different sentences. Rolling them together put
    // "iPhone apps cannot be done here at all" on a Mac with Xcode and three simulator
    // runtimes on it, where the real reason was that this repository has no iPhone app in
    // it. Both sentences are true; only one of them was.
    const noSuchProduct = never.filter((s) => s.notInThisProject === true).map((s) => s.name);
    const noSuchMachine = never.filter((s) => s.notInThisProject !== true).map((s) => s.name);
    if (noSuchProduct.length) {
      parts.push(`There is nothing of ${noSuchProduct.length === 1 ? 'that kind' : 'those kinds'} in this repository — ${plainList(noSuchProduct)} — so there is nothing here to check, and that is not a limit of this machine.`);
    }
    if (noSuchMachine.length) parts.push(`${plainList(noSuchMachine, true)} cannot be done here at all, and the reason for each is in notCovered.`);
  }
  if (out.everything) parts.push('Nothing is being left out on this machine.');
  out.short = parts.join(' ');
  return out;
}

/**
 * "a, b and c" — because a comma-separated list reads like a machine wrote it.
 * @param {string[]} items
 * @param {boolean} [capitalise]
 * @returns {string}
 */
function plainList(items, capitalise = false) {
  const list = items.length <= 1 ? (items[0] ?? 'nothing') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  return capitalise ? list.charAt(0).toUpperCase() + list.slice(1) : list;
}

/**
 * Who has to act, which is a different question from how much works.
 *
 * A surface with nothing in the way is ready. A surface whose every obstacle is
 * a command belongs to the agent, and a person should never hear about it. One
 * obstacle needing a licence, a device or a pair of hands makes the whole thing
 * a person's. And a surface that is blocked with nothing that would unblock it
 * is not a to-do list — it is a no, and it says so.
 *
 * @param {Omit<SurfaceReport, 'state'>} surface
 * @param {boolean} impossible
 * @returns {SurfaceState}
 */
function stateOf(surface, impossible) {
  if (surface.status === 'ready') return 'ready';
  if (impossible) return 'not possible here';
  if (surface.needs.length === 0) return 'not possible here';
  return surface.needs.every((need) => need.automatic) ? 'the agent can fix this' : 'only a person can do this';
}

/**
 * The shortest list of things that would widen coverage most, most useful first.
 * Only ever built from things that actually failed a probe.
 *
 * @param {SurfaceReport[]} surfaces
 * @param {{found: boolean, note: string}} reference
 * @param {boolean} repo
 * @returns {Need[]}
 */
function nextSteps(surfaces, reference, repo) {
  /** @type {Need[]} */
  const steps = [];

  if (!reference.found) {
    steps.push({
      what: 'record a reference',
      why: 'Until one build has been recorded there is nothing to compare a new one against, and a clean result would mean nothing.',
      // Both halves of this were wrong, and they were wrong in the direction that matters.
      // `check --paired` cannot record a reference — run it twice on a fresh project and
      // both runs answer that there is no build on record, with the reference id still
      // empty — so anybody following this went round in a circle. And `automatic: true` told
      // the agent this was its to do, when the one rule underneath this whole product is
      // that only shipping cuts a reference and no agent may bless its own work. Saying an
      // agent can do the single thing it must never do is worse than saying nothing.
      fix: 'staysfixed ship    (only shipping records what "working" means — no agent may cut that reference)',
      automatic: false,
      unlocks: 'Every check after this one has something to compare against, so "nothing changed" starts meaning something.',
    });
  }
  if (!repo) {
    steps.push({
      what: 'make this a git repository',
      why: 'Without it, a difference cannot be ranked by how far it sits from the code you changed — which is the whole way side effects rise to the top.',
      fix: 'git init',
      automatic: false,
      unlocks: 'Differences get sorted by how far they sit from your edit, so a side effect lands at the top instead of somewhere in the middle.',
    });
  }
  for (const surface of surfaces) {
    // A surface nothing on this machine can unlock has no next step. Listing one
    // would be asking somebody to do work that changes nothing.
    if (surface.state === 'not possible here') continue;
    for (const need of surface.needs) {
      if (!steps.some((s) => s.what === need.what)) steps.push(need);
    }
  }
  // The ones the tool can do itself go first: an agent should clear those before
  // it bothers a person with the rest.
  steps.sort((a, b) => Number(b.automatic) - Number(a.automatic));
  return steps;
}

// ── words ───────────────────────────────────────────────────────────────────

/**
 * What one reachable machine actually is, in the plainest words there are.
 *
 * Every one of these facts was already being collected and thrown away: `describeRemote`
 * returns what is installed there, whether anybody is signed in, whether the desktop is
 * locked and what each missing thing would unlock, and doctor was printing a host name.
 *
 * Nothing is invented when the answer is unknown. A machine whose runner would not start has
 * an empty tools list because nothing could ask, not because nothing is installed, and the
 * note that says so comes from the same place the facts do.
 *
 * @param {HostReport} host
 * @returns {string[]}
 */
function hostLines(host) {
  /** @type {string[]} */
  const lines = [];
  const detail = host.detail;
  if (!detail) {
    lines.push(`${host.name}: ${host.how}. Nothing further was asked of it.`);
    return lines;
  }
  const has = Object.entries(detail.tools).filter(([, where]) => typeof where === 'string' && where !== '').map(([name]) => name);
  const head = [detail.os, has.length > 0 ? `has ${plainList(has)}` : null].filter(Boolean).join(', ');
  lines.push(`${host.name}: ${head || detail.how}.`);
  if (detail.windows) {
    lines.push(
      `  Windows behind it${detail.windowsVersion ? ` (${detail.windowsVersion})` : ''}, ` +
        `${detail.desktopLoggedIn === false ? 'with nobody signed in on the desktop' : detail.desktopLoggedIn === true ? 'signed in' : 'and whether anybody is signed in could not be read'}` +
        `${detail.desktopLocked === true ? ', screen locked — controls still read correctly, only whole-screen pictures come back black' : ''}.`,
    );
  }
  // Each one with the exact command, because "you need Node there" and "run this" are not the
  // same message, and only one of them can be relayed to somebody who is not a programmer.
  for (const missing of detail.missing) {
    lines.push(`  ${missing.blocking === true ? 'needs' : 'would help'}: ${missing.what} — ${missing.howToGet}`);
  }
  if (!detail.runnerStarted) {
    lines.push('  What is installed on it is unknown rather than absent: the program this tool sends down the connection did not start, so nothing could be asked.');
  }
  return lines;
}

/**
 * The same object, said out loud. Used by the CLI, and quoted verbatim into the
 * MCP answer so an agent and a person are never told different things.
 *
 * @param {Capabilities} caps
 * @returns {string[]}
 */
export function describeCapabilities(caps) {
  /** @type {string[]} */
  const lines = [];
  const ready = caps.surfaces.filter((s) => s.status === 'ready').map((s) => s.name);
  const partial = caps.surfaces.filter((s) => s.status === 'partial').map((s) => s.name);
  const out = caps.surfaces.filter((s) => s.status === 'unavailable').map((s) => s.name);

  lines.push(`Stays Fixed ${caps.tool.version} on ${caps.machine.tag}, Node ${caps.machine.node}.`);
  lines.push('');
  lines.push(ready.length > 0 ? `It can check, here and now: ${ready.join('; ')}.` : 'It cannot fully check anything on this machine yet.');
  if (partial.length > 0) lines.push(`Partly: ${partial.join('; ')}.`);
  if (out.length > 0) lines.push(`Not here: ${out.join('; ')}.`);
  lines.push('');
  // What a clean run would actually mean. This is the one paragraph that must
  // never be dropped: without it, "nothing changed" reads as "your product is
  // fine" on a machine that never opened half of it.
  if (caps.covers?.short) {
    lines.push('WHAT A CLEAN RUN HERE WOULD MEAN');
    lines.push(caps.covers.short);
    lines.push('');
  }
  if (caps.browsers) {
    lines.push(caps.browsers.note);
    lines.push('');
  }

  // Who has to act. The whole point of splitting these out is that the first
  // list is nobody's problem — the agent just does it and never mentions it —
  // and the last list is not a to-do at all.
  const byAgent = caps.surfaces.filter((s) => s.state === 'the agent can fix this').map((s) => s.name);
  const byPerson = caps.surfaces.filter((s) => s.state === 'only a person can do this').map((s) => s.name);
  const never = caps.surfaces.filter((s) => s.state === 'not possible here');
  if (byAgent.length > 0) {
    lines.push(`Nobody needs to be asked about these — the tool can set them up itself: ${byAgent.join('; ')}.`);
  }
  if (byPerson.length > 0) {
    lines.push(`These need a person, and only for the steps listed further down: ${byPerson.join('; ')}.`);
  }
  for (const surface of never) {
    // Which of the two reasons it is, in the heading rather than buried in the sentence
    // after it. Sometimes it is the machine, and sometimes it is this project — and a
    // project with no desktop app in it is not a Mac that cannot open one.
    const why = surface.notInThisProject === true ? 'Nothing of this kind in this repository' : 'Not possible here';
    lines.push(`${why}: ${surface.name}. ${surface.instead ?? surface.summary}`);
  }
  if (byAgent.length > 0 || byPerson.length > 0 || never.length > 0) lines.push('');

  // What this COPY can drive, said separately from what this machine can run. They are
  // two different questions and folding them together is how somebody ends up aiming a
  // check at a phone on a machine that could run one, and getting a clean answer about
  // nothing at all.
  const noAdapter = (caps.drivers ?? []).filter((d) => !d.present);
  if (noAdapter.length > 0) {
    lines.push('This copy of Stays Fixed has no adapter for these, so a check aimed at one would walk nothing whatever. It refuses by name rather than checking something else:');
    for (const driver of noAdapter) lines.push(`  ${driver.surface} — ${driver.why}`);
    lines.push('');
  }

  if (!caps.project.hasReference) {
    lines.push(caps.project.referenceNote);
    lines.push('');
  }

  const runners = caps.hosts.filter((h) => h.reachable);
  if (runners.length > 0) {
    lines.push(`Other machines it can already reach: ${runners.map((h) => h.name + (h.windows ? ' (has a real Windows desktop behind it)' : '')).join(', ')}.`);
    // And then what each of them actually is. A name and the word "reachable" is not
    // something anybody can act on — the requirement is that an agent reading this can tell
    // a person what a machine needs, with the command, and a one-word answer fails that.
    for (const host of runners) for (const line of hostLines(host)) lines.push(`  ${line}`);
    lines.push('');
  }
  // Said out loud, because a machine left undialled is a runner somebody may be
  // looking for, and a list that quietly stops short reads as a list that finished.
  const undialled = caps.hosts.filter((h) => h.how.startsWith('not dialled'));
  if (undialled.length > 0) {
    lines.push(`${undialled.length} more ${undialled.length === 1 ? 'machine in your ssh config was' : 'machines in your ssh config were'} not dialled: ${undialled.map((h) => h.name).join(', ')}. Nothing here says anything about ${undialled.length === 1 ? 'it' : 'them'}.`);
    lines.push('');
  }

  if (caps.nextSteps.length > 0) {
    lines.push('What would unlock more:');
    for (const step of caps.nextSteps) {
      lines.push(`  ${step.what} — ${step.why}`);
      lines.push(`    ${step.automatic ? 'the tool can do this itself: ' : 'somebody has to: '}${step.fix}`);
      // What they get for it. A person asked to spend half an hour on a download and not
      // told what it buys them has been given a chore rather than a choice.
      if (step.unlocks) lines.push(`    what that gets you: ${step.unlocks}`);
    }
    lines.push('');
  }

  lines.push('What it will never see, on any machine:');
  for (const limit of caps.limits) lines.push(`  ${limit}`);
  return lines;
}

/**
 * `staysfixed doctor` — the command.
 *
 * @param {import('../cli/index.js').CliContext} ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  const caps = await capabilities({ cwd: ctx.cwd, configFile: ctx.configFile, offline: ctx.bool('offline'), machines: ctx.bool('machines') });

  if (ctx.bool('json')) {
    // Nothing but the object may reach standard output. Doctor is the first call
    // an agent makes, and one stray human sentence in front of it is a parse
    // error rather than a warning.
    setLogLevel({ quiet: true });
    process.stdout.write(JSON.stringify(caps, null, 2) + '\n');
    return caps.surfaces.some((s) => s.status !== 'unavailable') ? EXIT.ok : EXIT.failed;
  }

  heading('Stays Fixed — what it can check on this machine');
  blank();

  for (const surface of caps.surfaces) {
    if (surface.status === 'ready') ok(`${surface.name}: ${surface.summary}`);
    else if (surface.status === 'partial') warn(`${surface.name}: ${surface.summary}`);
    else fail(`${surface.name}: ${surface.summary}`);

    if (surface.state === 'not possible here') {
      // No list of things to install. There is nothing to install; there is only
      // the nearest honest alternative, and then this stops being offered.
      if (surface.instead) say(paint.grey(`    ${mark.info} ${surface.instead}`));
      continue;
    }
    for (const need of surface.needs) {
      say(paint.grey(`    ${mark.info} ${need.what} — ${need.automatic ? 'the tool can do this itself: ' : 'somebody has to: '}${need.fix}`));
    }
  }

  blank();
  if (caps.covers?.short) {
    say(paint.grey(`  ${mark.info} ${caps.covers.short}`));
    blank();
  }
  if (caps.browsers?.borrowingYourOwn) warn(caps.browsers.note);
  else if (caps.browsers?.willOpen) ok(caps.browsers.note);
  else if (caps.browsers) fail(caps.browsers.note);

  blank();
  const found = caps.tools.filter((t) => t.found);
  say(paint.grey(`  found: ${found.map((t) => t.name + (t.version ? ` ${t.version}` : '')).join(', ') || 'nothing but Node'}`));
  const missing = caps.tools.filter((t) => !t.found);
  if (missing.length > 0) say(paint.grey(`  missing: ${missing.map((t) => t.name).join(', ')}`));

  const runners = caps.hosts.filter((h) => h.reachable);
  if (runners.length > 0) {
    say(paint.grey(`  machines it can already reach: ${runners.map((h) => h.name).join(', ')}`));
    for (const host of runners) for (const line of hostLines(host)) say(paint.grey(`    ${line}`));
  }
  const undialled = caps.hosts.filter((h) => h.how.startsWith('not dialled'));
  if (undialled.length > 0) {
    say(paint.grey(`  not dialled, so nothing is known about them: ${undialled.map((h) => h.name).join(', ')}`));
  }

  const noAdapter = (caps.drivers ?? []).filter((d) => !d.present);
  if (noAdapter.length > 0) {
    blank();
    say(paint.grey(`  no adapter in this copy for: ${noAdapter.map((d) => d.surface).join(', ')} — a check aimed at one refuses by name rather than checking something else`));
  }

  blank();
  if (!caps.project.hasReference) warn(caps.project.referenceNote);
  else ok(caps.project.referenceNote);

  if (caps.nextSteps.length > 0) {
    blank();
    heading('What would unlock more');
    for (const step of caps.nextSteps) {
      say(`  ${step.what}`);
      say(paint.grey(`    ${step.why}`));
      say(paint.grey(`    ${step.automatic ? 'the tool can do this itself: ' : 'somebody has to: '}${step.fix}`));
      if (step.unlocks) say(paint.grey(`    what that gets you: ${step.unlocks}`));
    }
  }

  blank();
  say(paint.grey('  The same thing as JSON, which is what an agent should read: staysfixed doctor --json'));
  blank();

  return EXIT.ok;
}
