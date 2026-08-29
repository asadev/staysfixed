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

import { findConfigFile } from '../core/paths.js';
import { platformTag } from '../drive/find.js';
import { isRepo } from '../core/git.js';
import { surveyBrowsers, INSTALL_COMMAND, PORT_NEVER_USE } from './browsers.js';
import { messageOf, EXIT } from '../core/errors.js';
import { say, ok, warn, fail, blank, heading, paint, mark, shortPath, setLogLevel } from '../core/log.js';

const exec = promisify(execFile);

/** Nothing this file asks a question of is allowed to think about it for longer. */
const PROBE_MS = 5_000;
/** Reaching another machine is slower than reaching a binary, but not much. */
const REACH_MS = 8_000;
/** More hosts than this in one ssh config and we stop dialling; the list is a menu, not a queue. */
const MAX_HOSTS = 8;

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
 */

/**
 * @typedef {object} Need
 * @property {string} what
 * @property {string} why
 * @property {string} fix
 * @property {boolean} automatic    True when Stays Fixed could do it itself.
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
 */

/**
 * @typedef {object} Capabilities
 * @property {{name: string, version: string, generatedAt: string}} tool
 * @property {{platform: string, arch: string, release: string, node: string, cpus: number, memoryGb: number, tag: string}} machine
 * @property {{root: string, configFile: string|null, isGitRepo: boolean, hasReference: boolean, referenceNote: string}} project
 * @property {SurfaceReport[]} surfaces
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
 * @param {{cwd?: string, configFile?: string, offline?: boolean}} [opts]
 * @returns {Promise<Capabilities>}
 */
export async function capabilities(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const offline = opts.offline === true || process.env.STAYSFIXED_OFFLINE !== undefined;
  const configFile = opts.configFile ? path.resolve(cwd, opts.configFile) : findConfigFile(cwd);
  const root = configFile ? path.dirname(configFile) : cwd;

  // The browser survey comes first because three different answers below depend
  // on it, and asking this machine the same question three times would be both
  // slow and a way for the three answers to disagree.
  const browsers = await surveyBrowsers().catch(() => /** @type {import('./browsers.js').BrowserSurvey} */ ({ found: [], chosen: null, borrowingHis: false, note: 'The browsers on this machine could not be checked, so nothing here says whether a web page can be opened.', install: INSTALL_COMMAND }));
  const desktopApp = findDesktopApp(cwd);

  const [tools, hosts, repo, reference] = await Promise.all([
    findTools(cwd, browsers),
    offline ? Promise.resolve(/** @type {HostReport[]} */ ([])) : reachableHosts(),
    isRepo(root).catch(() => false),
    findReference(root),
  ]);

  const surfaces = describeSurfaces(tools, hosts, configFile !== null, browsers, desktopApp);

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
    covers: whatThisRunActuallyCovers(surfaces),
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
    wiring: WIRING,
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
 * @param {string} file
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok: boolean, out: string, why: string, hung: boolean}>}
 */
async function ask(file, args, timeoutMs = PROBE_MS) {
  try {
    const { stdout, stderr } = await exec(file, args, { timeout: timeoutMs, maxBuffer: 4 << 20, windowsHide: true });
    // Java and a few others announce their version on stderr. Take whichever spoke.
    return { ok: true, out: String(stdout || stderr).trim(), why: '', hung: false };
  } catch (error) {
    const e = /** @type {{killed?: boolean, signal?: string, stdout?: string, stderr?: string}} */ (Object(error));
    const hung = e.killed === true || e.signal === 'SIGTERM';
    const spoke = String(e.stdout || e.stderr || '').trim();
    // A non-zero exit that still printed a version is a success for our purposes.
    if (!hung && spoke !== '') return { ok: true, out: spoke, why: '', hung: false };
    return { ok: false, out: '', why: hung ? `it did not answer within ${Math.round(timeoutMs / 1000)}s` : messageOf(error), hung };
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
      const installed = hasModule(cwd, 'playwright') || hasModule(cwd, 'playwright-core');
      // The browsers Playwright downloads live outside any project and survive
      // every reinstall, so finding them means half the work is already done and
      // telling somebody to download them again would be wrong.
      const downloaded = playwrightBrowsersDir();
      add({
        id: 'playwright',
        name: 'Playwright',
        found: installed,
        where: downloaded ?? undefined,
        why: 'Reads a page’s meaning tree properly, and brings a browser of its own so yours is left alone.',
        fix: installed
          ? undefined
          : downloaded
            ? `Its browsers are already downloaded in ${downloaded}, so only the package is missing: npm install --save-dev playwright`
            : INSTALL_COMMAND,
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
        fix: app ? undefined : 'Only needed if the product you are watching is a desktop app. If it is, name the built app in your settings under app.binary.',
        automatic: false,
      });
    })(),

    (async () => {
      const where = onPath('java');
      const answer = where ? await ask(where, ['-version']) : null;
      add({
        id: 'java',
        name: 'Java',
        found: where !== null && answer?.ok === true,
        where: where ?? undefined,
        version: answer?.ok ? versionIn(answer.out) : undefined,
        why: 'Android tooling is written in it. Nothing about Android works without it.',
        fix: where ? undefined : 'brew install --cask temurin  (macOS), or install any JDK 17 or newer.',
        automatic: true,
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
    })(),

    (async () => {
      const where = onPath('appium');
      add({
        id: 'appium',
        name: 'Appium',
        found: where !== null,
        where: where ?? undefined,
        why: 'Reads the meaning tree of a phone app on Android, and on the iOS simulator.',
        fix: where ? undefined : 'npm install -g appium && appium driver install uiautomator2',
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
      const where = onPath('dotnet');
      add({
        id: 'dotnet',
        name: '.NET',
        found: where !== null,
        where: where ?? undefined,
        why: 'Builds the small probe that reads a native Windows window. Not needed for an Electron app on Windows.',
        fix: where ? undefined : 'Only needed if you ship a native Windows product that is not Electron.',
        automatic: false,
      });
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
      add({
        id: 'docker',
        name: 'Docker',
        found: where !== null,
        where: where ?? undefined,
        why: 'The usual way to restore the same database snapshot twice, which is what a server comparison needs.',
        fix: where ? undefined : 'Only needed to watch a server whose behaviour depends on its data.',
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
      const text = readFileSync(configFile, 'utf8');
      const named = /["']?binary["']?\s*:\s*["'`]([^"'`]+)["'`]/.exec(text);
      if (named) return { where: named[1], how: 'your settings name it under app.binary' };
      if (/["']?kind["']?\s*:\s*["'`]electron["'`]/.test(text)) {
        return { where: configFile, how: 'your settings say this project is a desktop app' };
      }
    } catch {
      // Unreadable settings are not an answer either way; keep looking.
    }
  }

  const root = configFile ? path.dirname(configFile) : cwd;
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
 * @returns {Promise<HostReport[]>}
 */
export async function reachableHosts() {
  if (!onPath('ssh')) return [];
  const names = (await sshConfigHosts()).slice(0, MAX_HOSTS);
  if (names.length === 0) return [];

  return await Promise.all(
    names.map(async (name) => {
      const answer = await ask('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', name, 'echo staysfixed-reachable'], REACH_MS);
      if (!answer.ok || !answer.out.includes('staysfixed-reachable')) {
        return /** @type {HostReport} */ ({ name, reachable: false, how: answer.why || 'it did not answer' });
      }
      // A Linux shell that can see powershell.exe is a real Windows desktop
      // behind it — the cheapest Windows runner there is, and one nobody has to
      // provision. Worth one extra round trip to find out.
      const windows = await ask('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', name, 'command -v powershell.exe || command -v pwsh.exe'], REACH_MS);
      return /** @type {HostReport} */ ({
        name,
        reachable: true,
        how: 'it answered over ssh with the key you already have',
        windows: windows.ok && windows.out.trim() !== '',
      });
    })
  );
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
 * @returns {SurfaceReport[]}
 */
function describeSurfaces(tools, hosts, configured, browsers, desktopApp) {
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

  surfaces.push({
    id: 'cli',
    name: 'command-line tools and libraries',
    status: 'ready',
    summary: 'Fully covered here. What it printed, what it exited with, what it wrote, what it called out to, and what it exports.',
    canCheck: withoutADriver,
    cannotCheck: ['meaning', 'pixels'],
    needs: [],
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
      : [{ what: 'a database snapshot that can be restored twice', why: 'Both builds have to see identical data or every difference is really a data difference.', fix: 'Install Docker, or point the settings at a dump file the tool may restore.', automatic: false }],
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
              fix: `Run \`staysfixed init\`, or set app.binary to ${desktopApp.where}.`,
              automatic: true,
            },
          ],
  });
  if (desktopApp === null) {
    impossible.set('electron', 'This project has no desktop app in it. If yours is built somewhere else, name the built app in your settings under app.binary and this becomes available — nothing else is needed, and no browser is needed for it at all.');
  }

  const androidMissing = ['java', 'adb', 'emulator', 'appium'].filter((id) => !have(id));
  surfaces.push({
    id: 'android',
    name: 'Android apps',
    status: androidMissing.length === 0 ? 'ready' : 'unavailable',
    summary:
      androidMissing.length === 0
        ? 'Covered against the stored record. Whether two emulator snapshots restore identically is still unproven, and the run says which mode it used.'
        : `Cannot run here yet. Missing: ${androidMissing.map((id) => tools.find((t) => t.id === id)?.name ?? id).join(', ')}. ${androidMissing.length === 1 ? 'It installs' : 'They all install'} without anybody clicking anything.`,
    canCheck: androidMissing.length === 0 ? [...withoutADriver, 'meaning', 'pixels'] : [],
    cannotCheck: androidMissing.length === 0 ? [] : CHANNELS.map((c) => c.id),
    needs: androidMissing.map((id) => {
      const tool = tools.find((t) => t.id === id);
      return { what: tool?.name ?? id, why: tool?.why ?? '', fix: tool?.fix ?? '', automatic: tool?.automatic === true };
    }),
  });

  const iosReady = process.platform === 'darwin' && have('simulator');
  if (process.platform !== 'darwin') {
    impossible.set('ios', 'An iPhone build can only be run on a Mac. Everything else on this list is unaffected — check the iPhone app from a Mac, and let this machine cover the rest.');
  }
  surfaces.push({
    id: 'ios',
    name: 'iPhone apps, on the simulator',
    status: iosReady ? (have('appium') ? 'ready' : 'partial') : 'unavailable',
    summary: iosReady
      ? have('appium')
        ? 'Covered on the simulator. Real iPhones cannot be compared side by side and never will be.'
        : 'The simulator is here, but nothing can read what is on its screen yet.'
      : process.platform === 'darwin'
        ? 'Cannot run here: no usable iOS runtime was found.'
        : 'Cannot run here: iOS needs a Mac.',
    canCheck: iosReady ? [...withoutADriver, ...(have('appium') ? ['meaning'] : []), 'pixels'] : [],
    cannotCheck: iosReady ? (have('appium') ? [] : ['meaning']) : CHANNELS.map((c) => c.id),
    needs: [
      ...(iosReady && !have('appium')
        ? [{ what: 'Appium with the XCUITest driver', why: 'It is what reads the meaning tree off a simulator screen.', fix: 'npm install -g appium && appium driver install xcuitest', automatic: true }]
        : []),
      // Xcode and its runtimes are a download nobody can do for you: it needs an
      // Apple ID, a licence agreement and about thirty gigabytes.
      ...(process.platform === 'darwin' && !have('simulator')
        ? [
            {
              what: 'Xcode with at least one iOS runtime',
              why: 'The simulator is the only place two builds of an iPhone app can be run one after the other.',
              fix: 'Install Xcode from the App Store, open it once to accept the licence, then add an iOS runtime under Settings, Platforms.',
              automatic: false,
            },
          ]
        : []),
    ],
  });

  surfaces.push({
    id: 'windows',
    name: 'native Windows apps',
    status: windowsHost ? 'partial' : 'unavailable',
    summary: windowsHost
      ? `A real Windows desktop is already reachable through ${windowsHost.name}. Two builds still cannot run at once — Windows only shows one desktop — so runs are one after the other.`
      : 'No Windows desktop is reachable from here. This is usually fine: an Electron product on Windows is watched over the debug port instead.',
    canCheck: windowsHost ? withoutADriver : [],
    cannotCheck: windowsHost ? ['meaning', 'pixels'] : CHANNELS.map((c) => c.id),
    needs: windowsHost
      ? [{ what: 'the native Windows probe', why: 'Reading a native window needs a small program running on Windows itself.', fix: 'Not built yet. Only needed if you ship a Windows product that is not Electron.', automatic: false }]
      : [],
  });
  if (!windowsHost) {
    impossible.set(
      'windows',
      'A native Windows window can only be read from Windows itself, and no Windows desktop answers from here. If your Windows product is Electron — most are — it is already covered over its debug port and you need nothing. If it is genuinely native, this becomes possible the day an SSH host in your config reaches a Windows machine.'
    );
  }

  return surfaces.map((surface) => {
    const instead = impossible.get(surface.id);
    return instead ? { ...surface, state: stateOf(surface, true), instead } : { ...surface, state: stateOf(surface, false) };
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
 * @returns {Covers}
 */
function whatThisRunActuallyCovers(surfaces) {
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
  parts.push(full.length > 0 ? `A check here covers ${plainList(out.covered)} in full.` : 'A check here covers nothing in full.');
  if (some.length > 0) parts.push(`It covers ${plainList(some.map((s) => s.name))} only partly — read the summary for each before treating a clean result as proof.`);
  if (missing.length > 0) {
    parts.push(`It does NOT check ${plainList(missing.map((s) => s.name))} at all, so a clean result says nothing whatever about ${missing.length === 1 ? 'that' : 'those'}.`);
    // Naming who can fix it is what turns a limitation into an action. The agent
    // clears its own list without mentioning it; only the rest reaches a person.
    const fixable = missing.filter((s) => s.state === 'the agent can fix this').map((s) => s.name);
    const needsPerson = missing.filter((s) => s.state === 'only a person can do this').map((s) => s.name);
    const never = missing.filter((s) => s.state === 'not possible here').map((s) => s.name);
    if (fixable.length) parts.push(`${plainList(fixable, true)} could be added here without asking anybody — the commands are in nextSteps.`);
    if (needsPerson.length) parts.push(`${plainList(needsPerson, true)} needs a person to do something first, and what that is is written out in full.`);
    // "here" rather than "on this machine", because sometimes it is the project
    // and not the machine — a project with no desktop app in it needs no runner,
    // and telling somebody their Mac cannot do it would be false.
    if (never.length) parts.push(`${plainList(never, true)} cannot be done here at all, and the reason for each is in notCovered.`);
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
      fix: 'staysfixed check --paired',
      automatic: true,
    });
  }
  if (!repo) {
    steps.push({
      what: 'make this a git repository',
      why: 'Without it, a difference cannot be ranked by how far it sits from the code you changed — which is the whole way side effects rise to the top.',
      fix: 'git init',
      automatic: false,
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
    // "here" rather than "on this machine": sometimes it is the machine, and
    // sometimes it is this project — a project with no desktop app in it needs
    // no Electron runner, and telling somebody their Mac cannot do it would be wrong.
    lines.push(`Not possible here: ${surface.name}. ${surface.instead ?? surface.summary}`);
  }
  if (byAgent.length > 0 || byPerson.length > 0 || never.length > 0) lines.push('');

  if (!caps.project.hasReference) {
    lines.push(caps.project.referenceNote);
    lines.push('');
  }

  const runners = caps.hosts.filter((h) => h.reachable);
  if (runners.length > 0) {
    lines.push(`Other machines it can already reach: ${runners.map((h) => h.name + (h.windows ? ' (has a real Windows desktop behind it)' : '')).join(', ')}.`);
    lines.push('');
  }

  if (caps.nextSteps.length > 0) {
    lines.push('What would unlock more:');
    for (const step of caps.nextSteps) {
      lines.push(`  ${step.what} — ${step.why}`);
      lines.push(`    ${step.automatic ? 'the tool can do this itself: ' : 'somebody has to: '}${step.fix}`);
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
  const caps = await capabilities({ cwd: ctx.cwd, configFile: ctx.configFile, offline: ctx.bool('offline') });

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
    }
  }

  blank();
  say(paint.grey('  The same thing as JSON, which is what an agent should read: staysfixed doctor --json'));
  blank();

  return EXIT.ok;
}
