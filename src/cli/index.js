/**
 * The command line.
 *
 * Argument parsing is hand-rolled on purpose: a tool whose whole promise is
 * "nothing changes underneath you" should not take a dependency to read `--only`.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { StaysFixedError, EXIT } from '../core/errors.js';
import { setLogLevel } from '../core/log.js';
import { V2_COMMANDS } from '../v2/cli.js';
import { SHIP_COMMANDS } from '../v2/ship.js';
import { INIT_COMMANDS } from '../v2/init.js';
import { BROWSERS_COMMAND } from '../v2/browsers.js';
export { watchFlags } from './watch-flags.js';

/** @type {{version?: string}} */
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

/** The version printed by `--version` and reported to an agent over MCP. */
export const VERSION = pkg.version ?? '0.0.0';

/**
 * @typedef {object} ArgSpec
 * @property {string[]} [booleans]
 * @property {string[]} [strings]
 * @property {string[]} [arrays]
 * @property {Record<string,string>} [alias]
 */

/**
 * @typedef {object} ParsedArgs
 * @property {string[]} args          Everything that was not a flag.
 * @property {Record<string, string|boolean|string[]>} flags
 * @property {string[]} passthrough   Everything after a bare `--`.
 */

/**
 * What every command is handed. The three little readers exist so a command can
 * ask for a value without repeating a type guard on every line.
 *
 * @typedef {object} CliContext
 * @property {string[]} args
 * @property {Record<string, string|boolean|string[]>} flags
 * @property {string[]} passthrough
 * @property {string} cwd
 * @property {string|undefined} configFile
 * @property {string} version
 * @property {(name: string) => boolean} bool
 * @property {(name: string) => string|undefined} str
 * @property {(name: string) => string[]} list
 */

/**
 * @typedef {object} CommandEntry
 * @property {string} summary                     One plain line, shown in the main help.
 * @property {string} usage
 * @property {string} describe                    A short paragraph, shown in the command's own help.
 * @property {[string, string][]} [options]
 * @property {string[]} [examples]
 * @property {ArgSpec} [spec]
 * @property {() => Promise<{run: (ctx: CliContext) => Promise<number>}>} [load]
 */

/**
 * The flags every command takes.
 *
 * `no-color` is declared as its own switch rather than as `color`, and that is not a
 * spelling choice. Colour is settled in bin/staysfixed.js, before anything else is
 * imported, because src/core/log.js decides once at load whether it may paint — so by the
 * time a command is parsed the answer is already fixed and nothing here could change it.
 * Declaring `color` made `--color` a real flag that turned nothing on, which is the worst
 * kind: a person types it, the tool accepts it, and nothing happens. There is no way to
 * force colour ON from here, so the only honest thing to offer is the half that works.
 * `--no-color` is named so `--help` and the parser agree; the work is already done.
 *
 * @type {ArgSpec}
 */
const GLOBAL_SPEC = {
  booleans: ['verbose', 'quiet', 'help', 'version', 'no-color'],
  strings: ['config', 'cwd'],
  alias: { v: 'verbose', q: 'quiet', h: 'help', V: 'version' },
};

/** Flags that swallow the next word, needed before we know which command it is. */
const GLOBAL_VALUE_FLAGS = new Set(['--config', '--cwd']);

/**
 * The live panel and the profiler. Both `check` and `walk` take them, and they
 * are declared once here so the two commands cannot drift apart.
 */
const WATCH_SPEC = {
  booleans: ['watch', 'watch-front', 'keep-open', 'profile', 'snap'],
  strings: ['watch-side', 'watch-width'],
};

/** @type {[string, string][]} */
const WATCH_OPTIONS = [
  ['--watch', 'Open a small panel beside your app and watch the run happen.'],
  ['--watch-side <side>', 'Which side of the app the panel sits on: left or right. Default right.'],
  ['--watch-width <n>', 'How wide the panel is, in pixels. Default 460.'],
  ['--no-keep-open', 'Close the panel as soon as the run finishes.'],
  ['--no-snap', 'Leave both windows exactly where they are instead of putting them side by side.'],
  ['--watch-front', 'Bring the panel to the front. By default it opens behind your work.'],
  ['--profile', 'Print where the time went when the run is over.'],
];

/**
 * Every command, and the only list of them. `--help` is printed from this, and every
 * flag any command accepts is declared in its `spec` here — so a flag that prints in the
 * help and a flag the parser knows about cannot drift apart. It is exported so that can
 * be checked from outside rather than by reading two lists side by side.
 *
 * @type {Record<string, CommandEntry>}
 */
export const COMMANDS = {
  init: {
    summary: 'Set this project up. Takes about thirty seconds.',
    usage: 'staysfixed init [--force] [--json]',
    describe:
      'Looks at your project, writes a settings file you can read, makes the folders,\nand leaves you one starter guard to copy. It never overwrites a settings file\nyou already have unless you ask it to.',
    options: [
      ['--force', 'Overwrite a settings file that is already there.'],
      ['--json', 'Print what it did as JSON and no prose. For agents.'],
    ],
    examples: ['staysfixed init'],
    spec: { booleans: ['force', 'json'] },
    load: () => import('./init.js'),
  },
  check: {
    summary: 'Photograph the screens and run the guards. This is the one you run.',
    usage: 'staysfixed check [--only <name>] [--guards] [--pictures] [--watch] [--json]',
    describe:
      'Opens the real app, takes a picture of every screen you named, compares each one\nagainst the picture a human approved, and runs every guard. It stops on nothing:\nyou get the whole list of what changed, and the exact command to accept it.',
    options: [
      ['--only <name>', 'Just this screen or guard. Repeat it for several.'],
      ['--guards', 'Guards only, no pictures.'],
      ['--pictures', 'Pictures only, no guards.'],
      ['--record', 'Save the network replies this run, so later runs can replay them.'],
      ['--no-report', 'Skip writing the side-by-side HTML report.'],
      ['--json', 'Print the result as JSON and nothing else. For CI.'],
      ...WATCH_OPTIONS,
    ],
    examples: [
      'staysfixed check',
      'staysfixed check --only sessions-empty',
      'staysfixed check --guards',
      'staysfixed check --watch',
    ],
    spec: {
      booleans: ['guards', 'pictures', 'record', 'report', 'json', ...WATCH_SPEC.booleans],
      strings: [...WATCH_SPEC.strings],
      arrays: ['only'],
    },
    load: () => import('./check.js'),
  },
  approve: {
    summary: 'Say a new picture is correct. Only a person may do this.',
    usage: 'staysfixed approve <name...> | --all [--reason "<why>"]',
    describe:
      'Takes the picture from the last check and makes it the one everything is measured\nagainst from now on. Run it with nothing and it only lists what is waiting — it\nwill never approve anything you did not name.',
    options: [
      ['--all', 'Approve every picture that is waiting.'],
      ['--reason "<why>"', 'Why this change is correct. Saved next to the picture.'],
    ],
    examples: ['staysfixed approve', 'staysfixed approve sessions-empty', 'staysfixed approve --all --reason "new empty state"'],
    spec: { booleans: ['all'], strings: ['reason'] },
    load: () => import('./approve.js'),
  },
  walk: {
    summary: 'Open the real app and photograph every screen, in order, before you ship.',
    usage: 'staysfixed walk [--only <name>] [--open] [--watch]',
    describe:
      'A walk is not a test. It opens the app you are about to release, visits each screen\nand photographs it into one page you can scroll — the last look before a release,\nwithout clicking through the app yourself.',
    options: [
      ['--only <name>', 'Just this screen. Repeat it for several.'],
      ['--open', 'Open the contact sheet when it is done.'],
      ...WATCH_OPTIONS,
    ],
    examples: ['staysfixed walk --open', 'staysfixed walk --watch'],
    spec: {
      booleans: ['open', ...WATCH_SPEC.booleans],
      strings: [...WATCH_SPEC.strings],
      arrays: ['only'],
    },
    load: () => import('./walk.js'),
  },
  mark: {
    summary: 'Pin today as a known-good version you can trace back to.',
    usage: 'staysfixed mark <label> [--note "<text>"] | --list | --delete <label>',
    describe:
      'A marker remembers what every screen looked like at one moment, so months later\n`staysfixed trace` can say which commit broke it. Pin one at every release.',
    options: [
      ['--note "<text>"', 'A line about this version, for the you of six months from now.'],
      ['--force', 'Replace a marker with the same name.'],
      ['--list', 'List every marker, newest first.'],
      ['--delete <label>', 'Remove one marker.'],
    ],
    examples: ['staysfixed mark v0.15.0 --note "before the store work"', 'staysfixed mark --list'],
    spec: { booleans: ['force', 'list'], strings: ['note', 'delete'] },
    load: () => import('./mark.js'),
  },
  trace: {
    summary: 'Find the commit where a screen stopped looking right.',
    usage: 'staysfixed trace [screen]',
    describe:
      'Walks backwards through your markers to the last one where this screen still looked\nright, then lists the commits between there and the first one where it did not.\nWith no screen named it traces whatever the last check said had changed.',
    examples: ['staysfixed trace', 'staysfixed trace sessions-empty'],
    spec: {},
    load: () => import('./trace.js'),
  },
  status: {
    summary: 'What is set up here and how the last check went. Instant.',
    usage: 'staysfixed status',
    describe: 'Reads what is already on disk. It launches nothing and changes nothing.',
    examples: ['staysfixed status'],
    spec: {},
    load: () => import('./status.js'),
  },
  flake: {
    summary: 'List the checks that keep changing their mind.',
    usage: 'staysfixed flake [--clear <name>] [--json]',
    describe:
      'A check that passes and fails without the code changing is worse than no check.\nThis is the register of them. Fix them or delete them — and once one is genuinely\nfixed, forgive it with --clear.',
    options: [
      ['--clear <name>', 'Forgive a check that has been fixed.'],
      ['--json', 'Print the register as JSON.'],
    ],
    examples: ['staysfixed flake', 'staysfixed flake --clear sessions-empty'],
    spec: { booleans: ['json'], strings: ['clear'] },
    load: () => import('./flake.js'),
  },
  doctor: {
    summary: 'Explain why Stays Fixed cannot run here, in plain words.',
    usage: 'staysfixed doctor [--fix]',
    describe:
      'Goes through everything that has to be true — settings, the app, a browser, the\nfolders, the guards, git — and says which of them is fine and which is not. It\nnever launches your app and it never fails; it reports.',
    options: [['--fix', 'Repair the small things it can safely repair.']],
    examples: ['staysfixed doctor', 'staysfixed doctor --fix'],
    spec: { booleans: ['fix'] },
    load: () => import('./doctor.js'),
  },
  mcp: {
    summary: 'Run as an MCP server so a coding agent can check its own work.',
    usage: 'staysfixed mcp [--v1]',
    describe:
      'Speaks the Model Context Protocol on standard input and output, so Claude Code,\nCodex, Gemini or Cursor can check your product right after editing it. It serves\nthe difference engine: ask what can be checked here, seal what you meant to\nchange, check, explain one finding, prove a cause, and record one as intended.\nWhat "working" means is never an agent\'s to move — it is cut by shipping, by you.\n\n--v1 serves the older picture-checking tool set instead, unchanged, for anybody\nwho wired that up and is not ready to move.',
    options: [['--v1', 'Serve the version 1 picture tools instead of the difference engine.']],
    examples: ['staysfixed mcp', 'staysfixed mcp --v1'],
    spec: { booleans: ['v1'] },
  },

  /*
   * `browsers` was written, tested, given a finished command entry in src/v2/browsers.js
   * with a comment saying "wiring it up is one line" — and that line was never written.
   * README.md told people to run `npx staysfixed browsers` and `--clean` to tidy up after
   * an interrupted run, and both answered "There is no command called browsers". Somebody
   * whose disk was filling with abandoned browser profiles had no way to clear them and no
   * reason to doubt the page telling them there was.
   */
  browsers: BROWSERS_COMMAND,
};

/*
 * Version 2 takes over `check`, `doctor` and `init`, and adds `ship`.
 *
 * It is a takeover rather than a second set of names because the answer to "did I
 * break anything" should be one command, not two — and because everything version 1
 * did is still reachable from it: `--pictures`, `--guards` and `--watch` behave
 * exactly as they always have. Anyone who installed this yesterday types the same
 * thing tomorrow.
 *
 * `init` was the last one left out, and leaving it out was not a decision — it was
 * an omission with a cost. docs/getting-started.md is written entirely around what
 * version 2's `init --json` returns: `plan.project`, `plan.readiness`,
 * `plan.needs.person`, `plan.journeys`, `plan.covers.short`. Version 1's init
 * returns none of that and tells whoever ran it to go and approve pictures. So an
 * agent following this project's own installation page got an answer with none of
 * the fields the page told it to read.
 */
Object.assign(COMMANDS, V2_COMMANDS);
Object.assign(COMMANDS, SHIP_COMMANDS);
Object.assign(COMMANDS, INIT_COMMANDS);

/**
 * @param {string[]} argv
 * @returns {Promise<number>} the exit code
 */
export async function main(argv) {
  const { command, rest } = splitCommand(argv);

  if (command === null) {
    const parsed = parseArgs(rest, GLOBAL_SPEC);
    if (parsed.flags.version === true) return printVersion();
    printHelp();
    return EXIT.ok;
  }

  const entry = COMMANDS[command];
  if (!entry) {
    const near = closest(command, Object.keys(COMMANDS));
    throw new StaysFixedError(`There is no command called "${command}".`, {
      hint: near ? `Did you mean \`staysfixed ${near}\`?` : 'Run `staysfixed --help` to see what it can do.',
    });
  }

  const parsed = parseArgs(rest, mergeSpec(GLOBAL_SPEC, entry.spec ?? {}));
  if (parsed.flags.help === true) {
    printCommandHelp(command, entry);
    return EXIT.ok;
  }
  if (parsed.flags.version === true) return printVersion();

  const cwd = moveTo(parsed.flags.cwd);
  const configFile = typeof parsed.flags.config === 'string' ? parsed.flags.config : undefined;

  // An MCP server talks JSON-RPC on stdout. One stray friendly line would break
  // the conversation, so the logger is silenced before the server ever starts.
  //
  // `mcp` serves VERSION 2 — the difference engine — because that is what every
  // document about this tool describes, what `staysfixed_capabilities` explains, and
  // the only surface where an agent can check without being able to approve. This
  // line pointed at version 1's picture tools for a day, which meant an agent that
  // followed the README's own wiring block got a set of tools none of the
  // documentation mentions, and never reached the engine at all. Version 1's server
  // is still here behind `--v1` so nobody who wired it up is stranded.
  if (command === 'mcp') {
    setLogLevel({ quiet: true, verbose: false });
    if (parsed.flags.v1 === true) {
      const { serveMcp } = await import('../mcp/server.js');
      await serveMcp({ cwd, configFile, version: VERSION });
      return EXIT.ok;
    }
    const { serveMcp } = await import('../v2/mcp/server.js');
    const { rootForConfig } = await import('../core/paths.js');
    // A `--config` pointing somewhere else names the project, so it decides the root.
    // Dropping the flag silently would have the server answer about the wrong folder.
    await serveMcp({ cwd, root: configFile ? rootForConfig(path.resolve(cwd, configFile)) : undefined, version: VERSION });
    return EXIT.ok;
  }

  setLogLevel({ verbose: parsed.flags.verbose === true, quiet: parsed.flags.quiet === true });

  if (!entry.load) throw new StaysFixedError(`The command "${command}" is not wired up.`);
  const mod = await entry.load();
  return await mod.run(contextFor(parsed, cwd, configFile));
}

/**
 * @param {ParsedArgs} parsed
 * @param {string} cwd
 * @param {string|undefined} configFile
 * @returns {CliContext}
 */
function contextFor(parsed, cwd, configFile) {
  const flags = parsed.flags;
  return {
    args: parsed.args,
    flags,
    passthrough: parsed.passthrough,
    cwd,
    configFile,
    version: VERSION,
    bool: (name) => flags[name] === true,
    str: (name) => (typeof flags[name] === 'string' ? /** @type {string} */ (flags[name]) : undefined),
    list: (name) => {
      const value = flags[name];
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') return [value];
      return [];
    },
  };
}

/**
 * What the panel flags on the command line asked for. Anything the person did
 * not mention is left undefined on purpose, so the settings file still decides it.
 *
 * @typedef {object} WatchFlags
 * @property {boolean} enabled          Whether --watch was asked for at all.
 * @property {'left'|'right'} [side]
 * @property {number} [width]
 * @property {boolean} [keepOpen]
 * @property {boolean} [foreground]
 */

// `watchFlags` moved to ./watch-flags.js — see the note there about the import cycle.


/**
 * The panel settings a project's settings file carries, if it carries any.
 *
 * A settings file may hold a `watch` block, and the resolved config type does not
 * describe one, so it is read through a shape that names exactly what is being
 * looked for rather than reaching in through `any`.
 *
 * @param {import('../types.js').Project} project
 * @returns {{watch?: import('../types.js').WatchOptions|boolean}}
 */
export function watchSettings(project) {
  return /** @type {{watch?: import('../types.js').WatchOptions|boolean}} */ (
    /** @type {unknown} */ (project.config ?? {})
  );
}

/**
 * Change into `--cwd` so every relative path in the run means the same thing.
 * @param {string|boolean|string[]|undefined} value
 * @returns {string}
 */
function moveTo(value) {
  if (typeof value !== 'string') return process.cwd();
  const target = path.resolve(process.cwd(), value);
  try {
    process.chdir(target);
  } catch (cause) {
    throw new StaysFixedError(`There is no folder at "${value}".`, {
      hint: 'Check the path you passed to --cwd.',
      cause,
    });
  }
  return process.cwd();
}

/**
 * Pull the command word out, without mistaking the value of a global flag for it.
 * @param {string[]} argv
 * @returns {{command: string|null, rest: string[]}}
 */
function splitCommand(argv) {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') break;
    if (token.startsWith('-') && token !== '-') {
      if (GLOBAL_VALUE_FLAGS.has(token)) i++;
      continue;
    }
    return { command: token, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
  }
  return { command: null, rest: [...argv] };
}

/**
 * The global flags plus one command's own — with the command winning any name they share.
 *
 * That last part is the whole reason this is not a concatenation. `--version` is global and
 * means "print the tool's version"; `staysfixed ship --version 0.14.0` means "the release
 * that went out was called 0.14.0", and it is in that command's own help. Merged naively,
 * the name landed in both lists, the parser reads booleans first, and `staysfixed ship
 * --version 0.14.0` printed `0.7.2` and shipped nothing at all — no error, no clue, and the
 * release script that called it carried on. A command's own list of flags is the more
 * specific statement of what that command means, so it wins.
 *
 * @param {ArgSpec} base
 * @param {ArgSpec} extra
 * @returns {ArgSpec}
 */
function mergeSpec(base, extra) {
  const claimed = new Set([...(extra.booleans ?? []), ...(extra.strings ?? []), ...(extra.arrays ?? [])]);
  /** @param {string[]|undefined} names */
  const keep = (names) => (names ?? []).filter((name) => !claimed.has(name));
  return {
    booleans: [...keep(base.booleans), ...(extra.booleans ?? [])],
    strings: [...keep(base.strings), ...(extra.strings ?? [])],
    arrays: [...keep(base.arrays), ...(extra.arrays ?? [])],
    alias: { ...(base.alias ?? {}), ...(extra.alias ?? {}) },
  };
}

/**
 * `--flag`, `--key=value`, `--key value`, `-v`, `--no-flag`, `--` passthrough,
 * and a repeated flag collecting into a list.
 *
 * @param {string[]} argv
 * @param {ArgSpec} spec
 * @returns {ParsedArgs}
 */
export function parseArgs(argv, spec) {
  const booleans = new Set(spec.booleans ?? []);
  const strings = new Set(spec.strings ?? []);
  const arrays = new Set(spec.arrays ?? []);
  const alias = spec.alias ?? {};
  const known = [...booleans, ...strings, ...arrays];

  /** @type {Record<string, string|boolean|string[]>} */
  const flags = {};
  /** @type {string[]} */
  const args = [];
  /** @type {string[]} */
  const passthrough = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === '--') {
      passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (token === '-' || !token.startsWith('-')) {
      args.push(token);
      continue;
    }

    let name = token.startsWith('--') ? token.slice(2) : token.slice(1);
    /** @type {string|undefined} */
    let inline;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (alias[name]) name = alias[name];

    // `--no-report` is the plain-English way to turn a switch off.
    if (!known.includes(name) && name.startsWith('no-') && booleans.has(name.slice(3))) {
      flags[name.slice(3)] = false;
      continue;
    }

    if (booleans.has(name)) {
      flags[name] = inline === undefined ? true : !/^(0|false|no)$/i.test(inline);
      continue;
    }

    if (strings.has(name) || arrays.has(name)) {
      let value = inline;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('--') && next !== '--')) {
          throw new StaysFixedError(`${token} needs something after it.`, {
            hint: `Write it as \`${token} <value>\`.`,
          });
        }
        value = next;
        i++;
      }
      if (arrays.has(name)) {
        const previous = flags[name];
        const list = /** @type {string[]} */ (Array.isArray(previous) ? previous : []);
        list.push(value);
        flags[name] = list;
      } else {
        flags[name] = value;
      }
      continue;
    }

    const near = closest(name, known);
    throw new StaysFixedError(`I do not know the option ${token}.`, {
      hint: near ? `Did you mean --${near}?` : 'Run the command with --help to see the options it takes.',
    });
  }

  return { args, flags, passthrough };
}

/**
 * How many single-character edits turn one word into the other. Only ever used
 * to say "did you mean" — never to decide anything.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  /** @type {number[]} */
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    /** @type {number[]} */
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = row;
  }
  return previous[b.length];
}

/**
 * @param {string} word
 * @param {string[]} choices
 * @returns {string|null}
 */
function closest(word, choices) {
  /** @type {string|null} */
  let best = null;
  let score = Number.POSITIVE_INFINITY;
  for (const choice of choices) {
    const d = editDistance(word.toLowerCase(), choice.toLowerCase());
    if (d < score) {
      score = d;
      best = choice;
    }
  }
  // Anything further away than a third of the word is a different word, not a typo.
  return score <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

/** @param {string} text */
function out(text) {
  process.stdout.write(text + '\n');
}

/** @returns {number} */
function printVersion() {
  out(VERSION);
  return EXIT.ok;
}

/** Help always prints, even under --quiet. Somebody asking for help wants help. */
function printHelp() {
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  out('');
  out('Stays Fixed — proves that what already worked still works after the code changed.');
  out('');
  out('Usage');
  out('  staysfixed <command> [options]');
  out('');
  out('Commands');
  for (const [name, entry] of Object.entries(COMMANDS)) {
    out(`  ${name.padEnd(width)}  ${entry.summary}`);
  }
  out('');
  out('Options');
  out('  --config <file>  Use this settings file instead of looking for one.');
  out('  --cwd <dir>      Work in this folder.');
  out('  -v, --verbose    Show the technical detail as well.');
  out('  -q, --quiet      Only say what went wrong.');
  out('  --no-color       Plain text, no colour.');
  out('  --version        Print the version.');
  out('  -h, --help       This help. Add it to a command for that command.');
  out('');
  out('Examples');
  out('  staysfixed init                     set this project up');
  out('  staysfixed check                    check every screen and guard');
  out('  staysfixed approve sessions-empty   accept one new picture as correct');
  out('  staysfixed walk --open              photograph the whole app before a release');
  out('  staysfixed check --watch            watch it work in a panel beside your app');
  out('');
  out('It answers with 0 when nothing changed, 1 when something changed or broke,');
  out('and 2 when it could not run at all.');
  out('');
}

/**
 * @param {string} name
 * @param {CommandEntry} entry
 */
function printCommandHelp(name, entry) {
  out('');
  out(`staysfixed ${name} — ${entry.summary}`);
  out('');
  out('Usage');
  out(`  ${entry.usage}`);
  if (entry.describe) {
    out('');
    for (const line of entry.describe.split('\n')) out(`  ${line}`);
  }
  if (entry.options?.length) {
    const width = Math.max(...entry.options.map(([flag]) => flag.length));
    out('');
    out('Options');
    for (const [flag, text] of entry.options) out(`  ${flag.padEnd(width)}  ${text}`);
  }
  if (entry.examples?.length) {
    out('');
    out('Examples');
    for (const example of entry.examples) out(`  ${example}`);
  }
  out('');
}
