/**
 * `staysfixed init` — setting this up for somebody who is not the person who wrote it.
 *
 * The owner said the requirement in one sentence: *some people will not have the device
 * access, so they will have to prepare it — the readme explains it to the AI, so the AI can
 * explain to the person: you need this and you need that.* Everything in this file follows
 * from that.
 *
 * So this command is written for an AGENT installing the tool into a stranger's repository,
 * and it holds itself to one rule: **never make a person do what the machine can do.** It
 * reads the project (detect.js), it reads the machine (doctor.js), it works out every setting
 * it can work out, it writes them down with an explanation beside each one, and then it sorts
 * everything still in the way into four buckets and hands the person only the last two:
 *
 *   1. ready                      — it works. Nobody hears about it.
 *   2. the agent can fix this     — a package to install, an app to build, a browser to
 *                                   download. The agent runs the command and never mentions it.
 *   3. only a person can do this  — a licence, a device, a password, a real customer id, a
 *                                   pair of hands. Said in plain words, with what it unlocks.
 *   4. not possible here          — no command on this machine changes the answer. Say the
 *                                   nearest honest alternative and stop offering it.
 *
 * THREE THINGS IT WILL NOT DO.
 *
 * It never overwrites. A settings file that is already there is somebody's work, and this
 * command will not touch it without being asked twice. What it would have written comes back
 * in the result instead, so an agent can merge the parts that are missing.
 *
 * It never demands journeys. A tool that opens with "now list the twenty things your app
 * does" gets closed. Every journey it can find on its own — the commands in package.json, the
 * routes and channels read out of the source, the pages read out of folder names, the test
 * suite already sitting there — is proposed, filled in and explained. What is left is a short
 * list with a reason on each item.
 *
 * And it never reports readiness it has not got. A project where only the website can be
 * checked is genuinely useful, and it must say "this covers your website; your iPhone app is
 * not being checked and here is why" rather than printing a tick and letting somebody believe
 * something wider.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { EXIT, messageOf } from '../core/errors.js';
import { say, ok, warn, fail, blank, heading, paint, mark, shortPath, setLogLevel } from '../core/log.js';
import { CONFIG_NAMES, DEFAULT_DIR, GITIGNORE_LINES, findConfigFile, rootForConfig } from '../core/paths.js';
import { PRODUCT_KINDS, detectProject } from './detect.js';

/** @typedef {import('./detect.js').ProjectShape} ProjectShape */
/** @typedef {import('./detect.js').Product} Product */
/** @typedef {import('./doctor.js').Capabilities} Capabilities */
/** @typedef {import('./doctor.js').SurfaceState} SurfaceState */

/**
 * Who has to act on one thing that is in the way.
 *
 * The word is in the object rather than worked out later from a sentence, because everything
 * downstream — what the agent silently clears, what reaches a person, what is dropped as
 * hopeless — turns on this one field, and a downstream guess about it would eventually be
 * wrong in the direction of bothering somebody.
 *
 * @typedef {'the agent'|'a person'|'nobody'} WhoFixes
 */

/**
 * One thing standing between this project and being checked.
 *
 * @typedef {object} Need
 * @property {string} what        Plain English, short: 'the built desktop app'.
 * @property {string} why         Why it is needed, in one sentence a non-programmer follows.
 * @property {string} unlocks     What becomes possible once it is there.
 * @property {string} fix         The exact command, or the exact words to say to a person.
 * @property {WhoFixes} who
 * @property {string} [product]   Which product this is about, when it is about one.
 * @property {string} [topic]     What it is ABOUT, in one word: 'data', 'start', 'app',
 *                                'samples', 'identity', 'browser'. Two needs on one topic are
 *                                one need said twice — doctor asks "what is missing on this
 *                                machine", this file asks "what is missing from these
 *                                settings", and on a server with no snapshot both answer.
 */

/**
 * One journey this project could walk, and where it came from.
 *
 * @typedef {object} Proposed
 * @property {string} name
 * @property {string} what        One plain sentence.
 * @property {string} from        'package.json', 'the source', 'the page folders', 'your own tests'.
 * @property {string} surface
 * @property {boolean} automatic  True when nothing has to be written down for it to happen.
 * @property {number} [howMany]   When this stands for many journeys of one shape.
 * @property {boolean} ready      False when something in `needs` has to land first.
 */

/**
 * What one product's situation adds up to.
 *
 * @typedef {object} Readiness
 * @property {string} product
 * @property {string} kind
 * @property {string} surface
 * @property {SurfaceState} state
 * @property {string} summary     One plain sentence.
 * @property {Need[]} needs
 * @property {string} [instead]   Only on 'not possible here': the nearest honest alternative.
 */

/**
 * Everything init worked out, with nothing written yet.
 *
 * @typedef {object} InitPlan
 * @property {string} root
 * @property {ProjectShape} project
 * @property {Readiness[]} readiness
 * @property {Proposed[]} journeys
 * @property {{agent: Need[], person: Need[], impossible: Need[]}} needs
 * @property {{file: string, exists: boolean, format: 'mjs'|'js'|'json', text: string, why: string}} config
 * @property {{covered: string[], partly: string[], notCovered: string[], short: string}} covers
 * @property {{mcp: Record<string, unknown>, next: {command: string, what: string}[]}} wiring
 * @property {string} summary     One paragraph, safe to repeat to a person word for word.
 */

/**
 * What init actually did.
 *
 * @typedef {object} InitResult
 * @property {InitPlan} plan
 * @property {string[]} written   Files created, absolute.
 * @property {string[]} kept      Files left exactly as they were, absolute.
 * @property {boolean} ok         False only when something was asked for and could not be done.
 * @property {string[]} problems
 */

// ---------------------------------------------------------------------------
// Working it all out
// ---------------------------------------------------------------------------

/**
 * Work out everything, write nothing.
 *
 * Separate from {@link init} on purpose: an agent that wants to know what would happen, a
 * `--dry-run`, and the real thing all have to agree, and the only way to guarantee that is
 * for the real thing to call this and then write down what it says.
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {boolean} [options.offline]   Do not dial other machines while reading this one.
 * @param {boolean} [options.readCode]  Read the source for routes and channels. Default true.
 * @returns {Promise<InitPlan>}
 */
export async function plan(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const existing = findConfigFile(cwd);
  const root = existing ? rootForConfig(existing) : cwd;

  const project = await detectProject({ root, readCode: options.readCode });
  const machine = await readMachine({ cwd: root, offline: options.offline });

  const readiness = readinessFor(project, machine);
  const journeys = proposeJourneys(project);
  const needs = sortNeeds(readiness, project, machine);
  const config = await planConfig(root, project, existing);
  const covers = whatItCovers(readiness);

  return {
    root,
    project,
    readiness,
    journeys,
    needs,
    config,
    covers,
    wiring: {
      mcp: { mcpServers: { staysfixed: { command: 'npx', args: ['-y', 'staysfixed', 'mcp'], cwd: root } } },
      next: nextCommands(readiness, project),
    },
    summary: `${project.summary} ${covers.short}`,
  };
}

/**
 * Work it out and write it down.
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {boolean} [options.offline]
 * @param {boolean} [options.readCode]
 * @param {boolean} [options.dryRun]     Work everything out and write nothing.
 * @param {boolean} [options.force]      Overwrite a settings file that is already there.
 * @param {boolean} [options.gitignore]  Add the throwaway folders to .gitignore. Default true.
 * @returns {Promise<InitResult>}
 */
export async function init(options = {}) {
  const made = await plan(options);
  /** @type {string[]} */
  const written = [];
  /** @type {string[]} */
  const kept = [];
  /** @type {string[]} */
  const problems = [];

  if (options.dryRun) {
    return { plan: made, written, kept, ok: true, problems };
  }

  // The settings file. Never over the top of one that is already there — what would have
  // been written is in `plan.config.text` either way, so nothing is lost by refusing.
  if (made.config.exists && !options.force) {
    kept.push(made.config.file);
  } else {
    try {
      await fsp.mkdir(path.dirname(made.config.file), { recursive: true });
      await fsp.writeFile(made.config.file, made.config.text, 'utf8');
      written.push(made.config.file);
    } catch (error) {
      problems.push(`The settings could not be written to ${made.config.file}: ${messageOf(error)}`);
    }
  }

  // The ignore lines. Appending lines that are not there is not overwriting, and leaving a
  // folder of run evidence to turn up in somebody's next commit is a real nuisance — but it
  // is still somebody else's file, so only the missing lines are added and the result says so.
  if (options.gitignore !== false) {
    const added = await addIgnoreLines(made.root);
    if (added.file) (added.changed ? written : kept).push(added.file);
    if (added.problem) problems.push(added.problem);
  }

  return { plan: made, written, kept, ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

/**
 * What this machine can drive, asked of `doctor` so there is one answer to that question in
 * the whole tool rather than two that disagree.
 *
 * It is allowed to fail. Init has to work on a machine where a probe hangs or a browser
 * survey throws, and the honest degradation is "nothing is known about this machine", which
 * makes every surface a person's problem rather than silently a ready one.
 *
 * @param {{cwd: string, offline?: boolean}} opts
 * @returns {Promise<Capabilities|null>}
 */
async function readMachine(opts) {
  try {
    const { capabilities } = await import('./doctor.js');
    return await capabilities({ cwd: opts.cwd, offline: opts.offline });
  } catch {
    return null;
  }
}

/** Which of doctor's surfaces answers for one of detect's products. */
const SURFACE_FOR_PRODUCT = /** @type {Record<string, string>} */ ({
  cli: 'cli', library: 'cli', server: 'server', web: 'web', electron: 'electron',
  ios: 'ios', android: 'android', windows: 'windows',
});

/**
 * What each product's situation adds up to: who has to act, and what they have to do.
 *
 * @param {ProjectShape} project
 * @param {Capabilities|null} machine
 * @returns {Readiness[]}
 */
function readinessFor(project, machine) {
  /** @type {Readiness[]} */
  const out = [];

  for (const product of project.products) {
    const kind = PRODUCT_KINDS[product.kind];
    const surface = machine?.surfaces.find((s) => s.id === SURFACE_FOR_PRODUCT[product.surface]) ?? null;

    // No adapter means no argument. This is the fourth state, and it is the one that has to
    // be said rather than dressed up: there is nothing to install and nothing to ask for.
    //
    // The product's own `adapter` is read, never the static table: whether an adapter exists
    // is worked out by looking at the folder, so the day the iOS one lands this stops saying
    // no without anybody editing this file — and until it lands, an iPhone app is never
    // reported as ready just because the simulator happens to be installed.
    if (product.adapter === null) {
      out.push({
        product: product.name,
        kind: product.kind,
        surface: product.surface,
        state: 'not possible here',
        summary: `${sentenceCase(product.name)} is not being checked. ${kind.what}`,
        needs: [],
        instead: insteadFor(product, project),
      });
      continue;
    }

    const mine = productNeeds(product, project);
    /** @type {Need[]} */
    const needs = [...mine, ...machineNeeds(surface, product, mine)];

    if (needs.length === 0) {
      out.push({
        product: product.name,
        kind: product.kind,
        surface: product.surface,
        state: 'ready',
        summary: `${sentenceCase(product.name)} can be checked here now. ${kind.what}`,
        needs,
      });
      continue;
    }

    const everythingIsACommand = needs.every((need) => need.who === 'the agent');
    out.push({
      product: product.name,
      kind: product.kind,
      surface: product.surface,
      state: everythingIsACommand ? 'the agent can fix this' : 'only a person can do this',
      summary: everythingIsACommand
        ? `${sentenceCase(product.name)} needs ${needs.length === 1 ? 'one thing' : `${needs.length} things`} setting up, and all of it can be done without asking anybody.`
        : `${sentenceCase(product.name)} needs ${needs.filter((n) => n.who === 'a person').length === 1 ? 'one thing' : 'a few things'} only you can supply.`,
      needs,
    });
  }

  return out;
}

/**
 * The nearest honest alternative for a product nothing here can drive.
 *
 * This is the sentence that stops a limitation reading as a refusal. A phone app whose
 * screens cannot be read is still sharing code with something that CAN be checked, and
 * saying where the cover actually is beats saying no.
 *
 * @param {Product} product
 * @param {ProjectShape} project
 * @returns {string}
 */
function insteadFor(product, project) {
  const sharedCode = project.products.some((p) => PRODUCT_KINDS[p.kind].adapter !== null);
  const shared = sharedCode
    ? ' The code this repository shares between its products IS checked, and shared code is where most breaks start — so a change that breaks the phone very often shows up there first.'
    : '';
  switch (product.kind) {
    case 'ios':
      return `An iPhone app can only be driven on the simulator, and this copy of the tool has no iOS adapter in it. Two builds on a real phone in your hand can never be compared side by side, on any machine, ever.${shared}`;
    case 'android':
      return `An Android app is driven on an emulator, and this copy of the tool has no Android adapter in it.${shared}`;
    case 'desktopNative':
      return `A native window can only be read from the operating system it runs on, and this copy of the tool has nothing that drives one.${shared}`;
    case 'other':
      return `${sentenceCase(product.name)} is in a language nothing here drives. If it also produces a command you can type, list that under "process" in the settings and the whole command-line half of this tool works on it today.${shared}`;
    default:
      return `This copy of the tool has nothing in it that drives ${product.name}.${shared}`;
  }
}

/**
 * What this particular product is short of, from what was actually found on disk.
 *
 * Built from facts rather than from the sentences detect wrote, because who has to fix a
 * thing is a decision and a decision should be made once, here, where it can be read.
 *
 * @param {Product} product
 * @param {ProjectShape} project
 * @returns {Need[]}
 */
function productNeeds(product, project) {
  /** @type {Need[]} */
  const needs = [];
  const suggest = product.suggest ?? {};

  if (product.kind === 'electron') {
    if (!product.built.found) {
      needs.push({
        what: 'the built desktop app',
        why: 'A desktop app is checked by opening the built copy, not the source. There is no built copy here yet.',
        unlocks: 'the window, its menus, every private channel it registers, and everything it writes',
        fix: `Build it the way this project normally does${project.scripts.build ? ` — \`${project.scripts.build}\`${project.scripts.package ? ` then \`${project.scripts.package}\`` : ''}` : ''}, then set electron.binary in the settings to the result.`,
        who: 'the agent',
        product: product.name,
        topic: 'app',
      });
    }
    // Whether this app has a device identity to keep apart is a question the source already
    // answers, so it is answered here rather than asked.
    //
    // WHY THIS ONE MATTERS MORE THAN IT LOOKS. It was written because of a real bug: two
    // copies of a desktop app claiming one identity displaced each other on a relay's single
    // slot, over and over, and it read exactly like a broken product. Asking for it is right
    // — when there is something to ask for. On Terminal Deck there is not: every one of the
    // settings its main process reads was listed and not one of them carries a device or
    // machine id, because the identity is generated into the settings folder and the adapter
    // already gives every run a settings folder of its own. Asking anyway put a line on a
    // set-up list that nobody could ever tick off, and a list with an impossible item on it
    // is a list people stop reading.
    const identity = identityVariables(project.envNames);
    if (identity.length > 0) {
      needs.push({
        what: `whether ${identity.length === 1 ? `${identity[0]} is` : `${identity.slice(0, 3).join(', ')} are`} how this app says who it is`,
        why: 'If the app registers itself somewhere with a device id, two runs claiming the same id would fight over the same slot — and that fight looks exactly like a bug in the product.',
        unlocks: 'running the old build and the new one safely, one after the other',
        fix: `${identity.length === 1 ? 'This name was' : 'These names were'} read out of your own source. If ${identity.length === 1 ? 'it carries' : 'one of them carries'} a device or machine id, put {"identityEnv": {"${identity[0]}": "{identity}"}} under "electron" in the settings and each run gets its own. If not, leave it out and nothing is lost.`,
        who: 'the agent',
        product: product.name,
        topic: 'identity',
      });
    }
  }

  // An iPhone app with no built bundle. Without this the readiness verdict said the iPhone
  // app "can be checked here now" on a fresh clone that contains no built app at all — a
  // ready state that nothing could act on, printed beside four honest ones.
  if (product.kind === 'ios' && !product.built.found) {
    const generated = product.evidence.some((clue) => /project\.ya?ml$/.test(clue.where));
    const scheme = typeof product.suggest?.scheme === 'string' ? String(product.suggest.scheme) : null;
    needs.push({
      what: 'the app built for the simulator',
      why: 'An iPhone app is checked by installing a built bundle on a simulator. There is no built bundle here yet, and a repository usually does not commit one.',
      unlocks: 'opening the app on a simulator and reading what the screen says every control is and does',
      fix: scheme
        ? `cd ${product.where} && ${generated ? 'xcodegen generate && ' : ''}xcodebuild -scheme ${scheme} -sdk iphonesimulator -configuration Debug -derivedDataPath build build    (then set ios.app in the settings to the .app it wrote)`
        : `cd ${product.where} && ${generated ? 'xcodegen generate && ' : ''}xcodebuild -list    (that names the schemes; build one for the simulator, then set ios.app in the settings to the .app it wrote)`,
      who: 'the agent',
      product: product.name,
      topic: 'app',
    });
  }

  // A command-line program that has to be built before it can be run. This is what a product
  // nothing in package.json names looks like on a fresh clone: the source is there, the
  // program is real, and the file that would be run does not exist yet.
  if (product.kind === 'cli' && !product.built.found) {
    const build = typeof suggest.buildWith === 'string' ? String(suggest.buildWith) : null;
    needs.push({
      what: `${product.name}, built`,
      why: 'It is built into a folder that is not committed, so on a fresh copy of this repository there is nothing to run yet. Nothing in package.json names it either, which is why it is easy to miss entirely.',
      unlocks: 'every word of its help, what it exits with, and every file it touches',
      fix: build
        ? `${build}, then \`staysfixed init --force\` — the commands are filled in exactly from what the build wrote, and nothing has been edited by hand yet.`
        : `Nothing in package.json says how to build it. Name the command that builds it and the command that runs the result under "process" in the settings.`,
      who: build ? 'the agent' : 'a person',
      product: product.name,
      topic: 'app',
    });
  }

  if (product.kind === 'web') {
    if (!suggest.start) {
      const hasDev = Boolean(project.scripts.dev);
      needs.push({
        what: 'a command that starts the site',
        why: 'Each build has to be booted on its own. One address can only ever serve one build, so without a command both halves of the comparison read the same running copy and prove nothing.',
        unlocks: 'a real comparison between the build you shipped and the build you have',
        fix: hasDev
          ? `Put {"start": "${project.scripts.dev}"} under "web" in the settings, and make sure it listens on the PORT it is given.`
          : 'This is a site made of files rather than a program, so put a static server under "web" in the settings — anything that serves this folder on the PORT it is given, such as {"start": "npx --yes serve -l $PORT ."}.',
        who: 'the agent',
        product: product.name,
        topic: 'start',
      });
    }
    // Addresses with a changing part in them, whether they came from folder names or from a
    // router. Both are the same problem and both go in one item, because being asked for the
    // same thing twice under two headings is how somebody stops reading a list.
    const fromRouter = /** @type {{url: string, names: string[]}[]} */ (suggest.screensNeedingValues ?? []);
    const needing = [
      ...project.pages.filter((p) => p.needs.length > 0),
      ...fromRouter.map((one) => ({ url: one.url, file: 'the router', needs: one.names })),
    ];
    if (needing.length > 0) {
      const names = [...new Set(needing.flatMap((p) => p.needs))];
      needs.push({
        what: `a real value for ${names.slice(0, 3).map((n) => `"${n}"`).join(', ')}${names.length > 3 ? ' and others' : ''}`,
        why: `${needing.length} page address${needing.length === 1 ? '' : 'es'} ${needing.length === 1 ? 'has' : 'have'} a part that changes — an id, a slug — and only somebody who knows the data knows a value that really exists.`,
        unlocks: `opening ${needing.length === 1 ? 'that page' : 'those pages'} at all, instead of reporting ${needing.length === 1 ? 'it' : 'them'} as never looked at`,
        fix: `Put {"samples": {${names.slice(0, 3).map((n) => `"${n}": "a real one"`).join(', ')}}} under "web" in the settings — one value per name, and it must be a record that exists.`,
        who: 'a person',
        product: product.name,
        topic: 'samples',
      });
    }
  }

  if (product.kind === 'server') {
    if (!suggest.start) {
      // The product's own blocker where it has one: a server found by reading the code often
      // has the answer written down beside it, in a deploy script or a container file. That
      // is work for the agent — it can read the script — rather than a question for a person
      // who would have to go and read the same script themselves.
      const written = product.blockers.find((line) => /start/i.test(line) && /\.(sh|bash|ya?ml|mjs|js|ts)\b|Dockerfile/.test(line)) ?? null;
      needs.push({
        what: 'the command that starts the server',
        why: 'The routes can be listed by reading the code, but none of them can be asked anything until something is listening.',
        unlocks: `walking ${project.doors.route > 0 ? `all ${project.doors.route} routes` : 'every route'} and seeing what each one quietly does while answering`,
        fix: written ?? 'Put {"start": "..."} under "http" in the settings, and have it listen on the PORT it is given.',
        who: project.scripts.start || written ? 'the agent' : 'a person',
        product: product.name,
        topic: 'start',
      });
    }
    // A server with nothing to store needs no way of putting anything back, and asking for
    // one is the same fault as asking for a device id that does not exist: an item on a
    // set-up list that can never be ticked off, sitting beside items that can.
    if (suggest.stateless !== true) {
      needs.push({
        what: 'a way to put the data back how it was',
        why: 'Both builds have to see the same rows. Without that, the second run sees whatever the first one wrote, and every difference after the first write means nothing.',
        unlocks: 'comparing two builds fairly instead of comparing two different sets of data',
        fix: 'Put {"restore": "..."} under "http" in the settings: a command that resets the database or the data folder to a known state. It must not be one that destroys data it cannot rebuild — a command that looks destructive is refused rather than run.',
        who: 'a person',
        product: product.name,
        topic: 'data',
      });
    }
    const withParts = project.routes.filter((route) => /:[A-Za-z_$]|\[[^\]]+\]|\{[^}]+\}/.test(route.name));
    if (withParts.length > 0) {
      const names = [...new Set(withParts.flatMap((route) => [...route.name.matchAll(/:([A-Za-z_$][\w$]*)|\[\.{0,3}([^\]]+)\]|\{([^}]+)\}/g)].map((hit) => hit[1] ?? hit[2] ?? hit[3])))];
      needs.push({
        what: `a real value for ${names.slice(0, 3).map((n) => `"${n}"`).join(', ')}${names.length > 3 ? ' and others' : ''}`,
        why: `${count(withParts.length, 'route has', 'routes have')} a part that changes — an id, a slug — and only somebody who knows the data knows a value that really exists.`,
        unlocks: `asking ${withParts.length === 1 ? 'that route' : 'those routes'} anything at all, instead of reporting ${withParts.length === 1 ? 'it' : 'them'} as never looked at`,
        fix: `Put {"samples": {${names.slice(0, 3).map((n) => `"${n}": "a real one"`).join(', ')}}} under "http" in the settings — one value per name, and it must be a record that exists.`,
        who: 'a person',
        product: product.name,
        topic: 'samples',
      });
    }
  }

  if (product.kind === 'server' || product.kind === 'web') {
    const risky = riskyRoutes(project);
    if (risky.length > 0) {
      needs.push({
        what: risky.length === 1
          ? 'a yes or no on one route that looks like it does something that cannot be undone'
          : `a yes or no on ${risky.length} routes that look like they do something that cannot be undone`,
        why: risky.length === 1
          ? `${risky[0].name} is named like something that spends money, sends a message or deletes data. The name is only a guess — only you know what it really does.`
          : `${risky.slice(0, 3).map((r) => r.name).join(', ')}${risky.length > 3 ? ' and others' : ''} are named like things that spend money, send a message or delete data. The names are only a guess — only you know what they really do.`,
        unlocks: 'walking every other route without worrying, and watching these ones ask without letting them succeed',
        fix: `They have been written into the settings under "irreversible" already. Take out any that are actually safe, and add any that are not on the list. A route listed there is watched at the moment it asks and stopped before anything happens.`,
        who: 'a person',
        product: product.name,
        topic: 'irreversible',
      });
    }
  }

  return needs;
}

/**
 * Settings this app reads that could be how it says who it is.
 *
 * A guess about meaning, but never a guess about existence: every name here was read out of
 * the project's own source, so the worst case is a question about a real variable rather than
 * a request for one that was never there.
 *
 * @param {string[]} envNames
 * @returns {string[]}
 */
export function identityVariables(envNames) {
  const looksLikeAnIdentity = /(DEVICE|MACHINE|INSTANCE|INSTALL|CLIENT|NODE|HOST|AGENT|PEER|REPLICA)[_-]?(ID|UUID|GUID|KEY|NAME|SLOT)\b/i;
  return envNames.filter((name) => looksLikeAnIdentity.test(name));
}

/**
 * Routes whose NAME says they do something that cannot be taken back.
 *
 * A guess, and it says so. Guessing wrong in this direction costs a route being watched
 * rather than walked; guessing wrong in the other direction costs somebody real money. The
 * asymmetry is the whole argument for erring towards the list.
 *
 * @param {ProjectShape} project
 * @returns {ProjectShape['routes']}
 */
export function riskyRoutes(project) {
  const dangerous = /(charge|payment|pay\b|refund|invoice|subscribe|checkout|purchase|order\b|billing|send|email|sms|notify|message|invite|publish|deploy|delete|destroy|purge|drop|wipe|reset|migrate)/i;
  return project.routes.filter((route) => dangerous.test(route.name) || (route.method !== 'GET' && route.method !== 'HEAD' && dangerous.test(route.name)));
}

/**
 * What this MACHINE is short of for one product, taken straight from doctor so the two can
 * never say different things. `automatic` is doctor's word for "no person needs to hear
 * about this", and it maps onto who has to act without any interpretation.
 *
 * @param {import('./doctor.js').SurfaceReport|null} surface
 * @param {Product} product
 * @param {Need[]} covered   What this file has already said about the same product.
 * @returns {Need[]}
 */
function machineNeeds(surface, product, covered) {
  if (!surface) {
    return [{
      what: 'a look at this machine',
      why: 'The check of what is installed here did not finish, so nothing is known about what this machine can drive.',
      unlocks: 'knowing which of your products can actually be checked here',
      fix: 'staysfixed doctor',
      who: 'the agent',
      product: product.name,
    }];
  }
  /** @type {Set<string|undefined>} */
  const already = new Set(covered.map((need) => need.topic).filter(Boolean));
  // A server with nothing to store has no data to put back, and doctor cannot know that: it
  // answers "what is missing on this machine", so it asks for a way to restore a database on
  // behalf of every server it sees. Telling somebody to install Docker for a switchboard that
  // keeps nothing is the same fault as asking for a device id that does not exist — an item on
  // a set-up list that can never be ticked off, sitting beside items that can.
  if (product.suggest?.stateless === true) already.add('data');
  return surface.needs
    // Doctor answers "what is missing on this machine right now", and right now is before
    // this command has written anything. A need whose whole fix is "run staysfixed init",
    // asked while staysfixed init is running and already holding the value, is not a need —
    // it is an echo, and repeating it back at somebody is how a set-up list never empties.
    .filter((need) => !(/staysfixed init/.test(need.fix) && alreadyAnswered(product)))
    .map((need) => ({
      what: need.what,
      why: need.why,
      unlocks: `checking ${product.name} the way it is meant to be checked`,
      fix: need.fix,
      who: /** @type {WhoFixes} */ (need.automatic ? 'the agent' : 'a person'),
      product: product.name,
      topic: topicOf(need.what + ' ' + need.fix),
    }))
    .filter((need) => !(need.topic && already.has(need.topic)));
}

/**
 * What a sentence is ABOUT, in one word, so the same problem said two ways is said once.
 * Deliberately a short list: a topic nothing recognises stays undefined and nothing is
 * merged, which is the safe direction — a repeated line is untidy, a swallowed one is a lie.
 *
 * @param {string} text
 * @returns {string|undefined}
 */
function topicOf(text) {
  const words = text.toLowerCase();
  if (/snapshot|restore|database|the same data|data folder/.test(words)) return 'data';
  if (/starts it|command that starts|start\b/.test(words)) return 'start';
  if (/built app|app\.binary|electron\.binary/.test(words)) return 'app';
  if (/device id|identity|identityenv/.test(words)) return 'identity';
  if (/sample|real value/.test(words)) return 'samples';
  if (/browser|playwright|chromium/.test(words)) return 'browser';
  return undefined;
}

/**
 * Does the settings file this command is about to write already carry what that need asked
 * for? Only the things init genuinely fills in count.
 *
 * @param {Product} product
 * @returns {boolean}
 */
function alreadyAnswered(product) {
  const suggest = product.suggest ?? {};
  if (product.kind === 'electron') return Boolean(suggest.binary);
  if (product.kind === 'web' || product.kind === 'server') return Boolean(suggest.start);
  return Object.keys(suggest).length > 0;
}

/**
 * Everything in the way, sorted by who has to act, plus the two things that are about the
 * project as a whole rather than about any one product.
 *
 * @param {Readiness[]} readiness
 * @param {ProjectShape} project
 * @param {Capabilities|null} machine
 * @returns {{agent: Need[], person: Need[], impossible: Need[]}}
 */
function sortNeeds(readiness, project, machine) {
  /** @type {Need[]} */
  const all = [];

  if (machine && !machine.project.hasReference) {
    all.push({
      what: 'one build on record as working',
      why: 'Until one build has been recorded there is nothing to compare a new one against, and a clean result would mean nothing at all.',
      unlocks: 'every check from then on',
      fix: 'staysfixed check --paired    (or ship once with `staysfixed ship` at the end of your release)',
      who: 'the agent',
    });
  }
  // Room to work. Three of the adapters copy the whole project into a scratch folder before
  // running anything — which is right, a check must never write into somebody's working copy
  // — and a repository carrying gigabytes of build output cannot be copied twice on a laptop
  // that is nearly full. It is not a failure anybody could diagnose from the error: the copy
  // simply stops. The whole answer is one command, and it is the agent's to run.
  if (project.bulk.tooBig) {
    all.push({
      what: 'somewhere with room to copy this project into',
      why: `${project.bulk.why} A check copies the project so a run can write anywhere it likes without touching your working copy, and there is not room here for the two copies a comparison needs.`,
      unlocks: 'every check that runs a command or boots a server or a website',
      fix: `git worktree add ../${path.basename(project.root)}-check HEAD    (then copy the settings across and run the check in there — a worktree holds the tracked files and none of the build output)`,
      who: 'the agent',
      topic: 'room',
    });
  }
  if (!project.isGitRepo) {
    all.push({
      what: 'this folder being a git repository',
      why: 'Without it a difference cannot be ranked by how far it sits from the code that changed — which is the whole way an accidental side effect rises to the top of the list.',
      unlocks: 'ranking, and comparing against a tag or a commit',
      fix: 'git init',
      who: 'a person',
    });
  }

  for (const item of readiness) all.push(...item.needs);

  /** @type {Need[]} */
  const impossible = readiness
    .filter((r) => r.state === 'not possible here')
    .map((r) => ({
      what: r.product,
      why: r.summary,
      unlocks: 'nothing that any command on this machine can turn on',
      fix: r.instead ?? 'There is nothing to do here.',
      who: 'nobody',
      product: r.product,
    }));

  return {
    agent: dedupeNeeds(all.filter((n) => n.who === 'the agent')),
    person: dedupeNeeds(all.filter((n) => n.who === 'a person')),
    impossible,
  };
}

/**
 * @param {Need[]} needs
 * @returns {Need[]}
 */
function dedupeNeeds(needs) {
  /** @type {Map<string, Need>} */
  const seen = new Map();
  for (const need of needs) {
    const key = `${need.what}|${need.fix}`;
    if (!seen.has(key)) seen.set(key, need);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Journeys, proposed rather than demanded
// ---------------------------------------------------------------------------

/**
 * Everything this project could walk, and where each one came from.
 *
 * Ranked exactly the way the design ranks the sources of a journey: read out of the code
 * first because it is free and exact, then the project's own test suite because somebody
 * already wrote it and already keeps it working, then anything a person would have to write.
 * Nothing here is invented, and nothing here is asked for.
 *
 * @param {ProjectShape} project
 * @returns {Proposed[]}
 */
export function proposeJourneys(project) {
  /** @type {Proposed[]} */
  const out = [];

  const doorsFound = project.doors.route + project.doors.ipc + project.doors.export + project.doors.command;
  if (project.doors.read && doorsFound > 0) {
    out.push({
      name: 'the-code',
      what: `read every door out of the source without running any of it — ${count(project.doors.route, 'route', 'routes')}, ${count(project.doors.ipc, 'private channel', 'private channels')}, ${count(project.doors.export, 'exported name', 'exported names')}, ${count(project.doors.command, 'command', 'commands')}`,
      from: 'the source',
      surface: 'any',
      automatic: true,
      ready: true,
    });
  }

  for (const product of project.products) {
    const suggest = product.suggest ?? {};
    if (product.kind === 'cli' && Array.isArray(suggest.commands)) {
      for (const command of suggest.commands) {
        out.push({
          name: String(command.name),
          what: `run \`${String(command.run)}\` and compare what it printed, what it exited with and every file it touched`,
          from: product.where === '.' ? 'package.json' : `the program built in ${product.where}/`,
          surface: 'cli',
          automatic: false,
          ready: true,
        });
      }
    }
    if (product.kind === 'library' && Array.isArray(suggest.imports)) {
      for (const entry of suggest.imports) {
        out.push({
          name: String(entry.name),
          what: `import ${String(entry.module)} and compare what it exports`,
          from: 'package.json',
          surface: 'library',
          automatic: false,
          ready: true,
        });
      }
    }
    if (product.kind === 'server' && project.doors.route > 0) {
      out.push({
        name: 'every route',
        what: `ask the server for each of the ${project.doors.route} routes written in its own source, and watch what it quietly does while answering`,
        from: 'the source',
        surface: 'server',
        automatic: true,
        howMany: project.doors.route,
        ready: Boolean(suggest.start),
      });
    }
    if (product.kind === 'web') {
      if (project.pages.length > 0) {
        out.push({
          name: 'every page',
          what: `open each of the ${project.pages.length} page addresses read out of the folder names and read what the screen says each control is and does`,
          from: 'the page folders',
          surface: 'web',
          automatic: true,
          howMany: project.pages.length,
          ready: Boolean(suggest.start),
        });
      }
      if (Array.isArray(suggest.screens) && suggest.screens.length > 0) {
        const many = suggest.screens.length;
        const router = product.router?.kind ?? 'files';
        // Where each screen came from decides what to call it, and one of these is the whole
        // point: screens reached by clicking are NOT addresses, and a line that calls them
        // pages would be describing something the run does not do.
        const from = router === 'tabs' ? 'the strip of tabs in the source'
          : router === 'hash' ? 'the router in the source'
            : router === 'declared' ? 'the router in the source'
              : 'the folder itself';
        out.push({
          name: many === 1 ? 'the screen this app has' : 'every screen this app has',
          what: router === 'tabs'
            ? `open the app and reach each of its ${many} screens the way a person does — by clicking the control that names it — reading what the screen says every control is and does. The address never changes, so opening one is not an option.`
            : many === 1 ? 'open the single page in this folder' : `open each of the ${many} addresses this app answers on and read what the screen says every control is and does`,
          from,
          surface: 'web',
          automatic: router !== 'files',
          howMany: many,
          ready: Boolean(suggest.start),
        });
      }
    }
    if (product.kind === 'android' && product.adapter === 'android') {
      out.push({
        name: `open ${product.name}`,
        what: 'install the app on an emulator of its own, open it, read what the screen says every control is and does, then take it off again',
        from: 'the app itself',
        surface: 'android',
        automatic: true,
        ready: product.built.found,
      });
    }
    if (product.kind === 'desktopNative' && product.adapter === 'windows') {
      out.push({
        name: 'open-the-window',
        what: 'open the app on a Windows machine over ssh and read what its window says every control is and does',
        from: 'the app itself',
        surface: 'windows',
        automatic: true,
        ready: false,
      });
    }
    if (product.kind === 'electron') {
      out.push({
        name: `open ${product.name}`,
        what: `open the app and read everything it shows and all ${project.doors.ipc} channels it registers`,
        from: 'the source',
        surface: 'electron',
        automatic: true,
        ready: product.built.found,
      });
    }
  }

  if (project.tests.files > 0) {
    out.push({
      name: 'your own tests',
      what: `run the ${project.tests.files} test file${project.tests.files === 1 ? '' : 's'} this project already has, under instrumentation, and compare what each one saw — journeys somebody already wrote and already keeps working`,
      from: 'your own tests',
      surface: 'any',
      automatic: false,
      howMany: project.tests.files,
      ready: true,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// The settings file
// ---------------------------------------------------------------------------

/**
 * Where the settings would go, what would be in them, and whether anything is there already.
 *
 * @param {string} root
 * @param {ProjectShape} project
 * @param {string|null} existing
 * @returns {Promise<InitPlan['config']>}
 */
async function planConfig(root, project, existing) {
  const mine = existing && rootForConfig(existing) === root ? existing : null;
  const pkg = await readJson(path.join(root, 'package.json'));
  // A project that has not said it is ES modules gets a .mjs file, so `export default` works
  // without anybody having to edit their package.json to install a checking tool.
  const format = /** @type {'mjs'|'js'} */ (pkg?.type === 'module' ? 'js' : 'mjs');
  const file = mine ?? path.join(root, `staysfixed.config.${format}`);
  return {
    file,
    exists: mine !== null,
    format: mine ? formatOf(mine) : format,
    text: configText(project),
    why: mine
      ? `There are already settings at ${shortPath(mine)}, and they will not be touched. What would have been written is here in full, so anything missing can be copied across by hand.`
      : `The settings will be written to ${shortPath(file)}, with an explanation beside every option.`,
  };
}

/**
 * @param {string} file
 * @returns {'mjs'|'js'|'json'}
 */
function formatOf(file) {
  const ext = path.extname(file);
  return ext === '.json' ? 'json' : ext === '.mjs' ? 'mjs' : 'js';
}

/**
 * The settings file, written out.
 *
 * Every option that matters is in here, with a sentence saying what it does and what happens
 * without it. The ones that do not apply to this project are present and commented out rather
 * than left out: a setting somebody cannot see is a setting they will never turn on, and the
 * list of what this tool can be told is exactly the list of what it can be made to check.
 *
 * @param {ProjectShape} project
 * @returns {string}
 */
export function configText(project) {
  const has = (/** @type {string} */ kind) => project.products.find((p) => p.kind === kind) ?? null;
  // Several of a kind is normal, and it is the case that goes wrong quietly. One repository
  // here makes two command-line programs; writing the first one's commands and stopping would
  // have left the second unchecked with nothing anywhere saying so.
  const all = (/** @type {string} */ kind) => project.products.filter((p) => p.kind === kind);
  const electron = has('electron');
  const web = has('web');
  const server = has('server');
  const library = has('library');
  const ios = has('ios');

  /** @type {string[]} */
  const out = [];
  const w = (/** @type {string} */ line) => out.push(line);

  w('/**');
  w(' * Stays Fixed — settings for this project.');
  w(' *');
  w(` * Written by \`staysfixed init\` on ${new Date().toISOString().slice(0, 10)}, from what is actually in this`);
  w(' * repository. Everything below was read out of the code, the folder names and package.json;');
  w(' * nothing was guessed, and nothing was asked.');
  w(' *');
  w(` * WHAT THIS REPOSITORY MAKES: ${project.summary}`);
  w(' *');
  w(' * WHAT THE TOOL DOES WITH THIS FILE. It runs your product through the same steps twice,');
  w(' * compares the result against the build you were last happy with, subtracts anything your');
  w(' * product disagrees with itself about, and reports only what is left. Everything that did');
  w(' * not change is never mentioned.');
  w(' *');
  w(' * EVERY OPTION THAT MATTERS IS IN THIS FILE. The ones that do not apply to this project are');
  w(' * commented out rather than left out, so nothing is hidden from you. Delete freely.');
  if (project.products.length > 1) {
    w(' *');
    w(' * EACH ONE, AND WHAT SAID SO:');
    for (const product of project.products) {
      w(` *   ${padTo(product.name, 34)} ${product.why}`);
    }
  }
  if (project.bulk.tooBig || project.bulk.capped) {
    w(' *');
    w(' * BEFORE THE FIRST RUN, one fact about this folder. Commands, servers and websites are');
    w(' * checked in a scratch COPY of the project, so a run can write anywhere it likes without');
    w(' * touching your working copy.');
    for (const line of wrapProse(project.bulk.why, 92)) w(` * ${line}`);
    if (project.bulk.tooBig) {
      w(' * So run the check somewhere with room, which is one command:');
      w(' *');
      w(` *     git worktree add ../${path.basename(project.root)}-check HEAD`);
      w(` *     cp ${path.basename(project.root)}/staysfixed.config.* ../${path.basename(project.root)}-check/`);
      w(` *     cd ../${path.basename(project.root)}-check && npx staysfixed check`);
    }
  }
  w(' */');
  w('');
  w('export default {');
  w('  // The name this record is kept under. Each product keeps its own record of what');
  w('  // "working" means, so the name is how two of them are told apart.');
  if (project.products.length > 1) {
    w('  // This repository makes more than one thing. A check covers whichever of them the');
    w('  // settings below describe; run the others with `staysfixed check --product <name>`.');
  }
  w(`  product: ${JSON.stringify(project.name)},`);
  w('');

  // ── source ────────────────────────────────────────────────────────────────
  w('  // ───────────────────────────────────────────────────────────────────────');
  w('  // Reading the code. Free, exact, runs nothing, and it cannot break anything.');
  w('  // This is the only channel that sees a door nobody has ever opened.');
  w('  // ───────────────────────────────────────────────────────────────────────');
  w('  source: {');
  w('    // Folders to read. Left out, it reads the usual ones — src, lib, app, bin, server,');
  w('    // pages, api, electron, main, packages — which is right for a repository that makes');
  w('    // one thing, and misses whole products in a repository that makes several. These are');
  w('    // the folders the products above actually live in, plus any folder of source that no');
  w('    // product claimed, because an unclaimed folder is exactly where a silent gap lives.');
  if (project.sourceFolders.length > 0) {
    w(`    folders: [${project.sourceFolders.map((f) => JSON.stringify(f)).join(', ')}],`);
  } else {
    w("    // folders: ['src', 'lib'],");
  }
  if (project.doors.read) {
    w(`    // Last read: ${project.doors.route} routes, ${project.doors.ipc} private channels, ${project.doors.export} exported names, ${project.doors.command} commands, ${project.doors.env} settings it reads.`);
  }
  w('  },');
  w('');

  // ── process ───────────────────────────────────────────────────────────────
  w('  // ───────────────────────────────────────────────────────────────────────');
  w('  // Commands and libraries. Each one runs in a throwaway copy of this project —');
  w('  // never your working copy — with the clock stopped and every outbound');
  w('  // connection recorded and then refused.');
  w('  // ───────────────────────────────────────────────────────────────────────');
  w('  process: {');
  w('    // Commands worth running. Only ever `--help`, and that is deliberate: a command listed');
  w('    // in a manifest could deploy, could publish, could wipe a database, and running one');
  w('    // because it was there would be this tool causing the very kind of damage it exists to');
  w('    // catch. Asking a program to describe itself is the one thing every command-line tool');
  w('    // does safely — and its help text is a precise description of everything it offers, so');
  w('    // a command that quietly disappears is caught by comparing it.');
  const cliProducts = all('cli');
  /** @type {any[]} */
  const commands = [];
  for (const one of cliProducts) for (const command of /** @type {any[]} */ (one.suggest?.commands ?? [])) commands.push(command);
  const unbuilt = cliProducts.filter((one) => !one.built.found);
  if (commands.length > 0) {
    w('    commands: [');
    for (const command of commands) {
      w(`      { name: ${JSON.stringify(String(command.name))}, run: ${JSON.stringify(String(command.run))}, describe: ${JSON.stringify(String(command.describe ?? ''))} },`);
    }
    w('    ],');
    w('    // Add any other command whose output you would notice changing. Each entry also takes:');
    w('    // cwd, stdin, env, timeoutMs, and irreversible: true for a command that would spend');
    w('    // money or send a message — that one is watched asking and never allowed to ask.');
  } else {
    w("    // commands: [{ name: 'help', run: 'node bin/cli.js --help', describe: 'print the help' }],");
    w('    commands: [],');
  }
  for (const one of unbuilt) {
    const build = typeof one.suggest?.buildWith === 'string' ? String(one.suggest.buildWith) : null;
    w('');
    w(`    // ${one.where}/ holds a real command-line program that nothing in package.json names, so it`);
    w('    // was found by reading the code rather than the manifest — and it has not been built here');
    w(`    // yet${one.suggest?.outDir ? `, so ${String(one.suggest.outDir)}/ is empty` : ''}. There is nothing to run until it is:`);
    w(`    //     ${build ?? 'build it the way this project builds it'}`);
    w('    //     staysfixed init --force');
    w('    // The second line fills these commands in exactly from what the build wrote. Nothing');
    w('    // in this file has been edited by hand yet, so nothing is lost by rewriting it.');
  }
  const imports = /** @type {any[]} */ (library?.suggest?.imports ?? []);
  w('');
  w('    // Modules to import and compare the exports of.');
  if (imports.length > 0) {
    w('    imports: [');
    for (const entry of imports) w(`      { name: ${JSON.stringify(String(entry.name))}, module: ${JSON.stringify(String(entry.module))} },`);
    w('    ],');
  } else {
    w("    // imports: [{ name: 'the package entry', module: './src/index.js' }],");
  }
  w('  },');
  w('');

  // ── http ──────────────────────────────────────────────────────────────────
  w('  // ───────────────────────────────────────────────────────────────────────');
  w('  // Servers and APIs. Every route is read out of your own source, so a route');
  w('  // nobody links to is checked like any other. Booted on a spare port, one');
  w('  // build at a time, never two at once.');
  w('  // ───────────────────────────────────────────────────────────────────────');
  w(server ? '  http: {' : '  // http: {');
  const httpOn = server ? '    ' : '  //   ';
  if (server && server.where !== '.') {
    w(`${httpOn}// This is ${server.name}. ${server.why}`);
  }
  w(`${httpOn}// The command that starts it. It must listen on the PORT it is given.`);
  const httpStart = server?.suggest?.start;
  if (httpStart) {
    w(`${httpOn}start: ${JSON.stringify(String(httpStart))},`);
  } else {
    // The one thing that has to be filled in, and where the answer already is. A server found
    // by reading the code usually has a deploy script or a container file beside it that says
    // exactly how it is built and run — naming that file is the difference between work an
    // agent can finish on its own and a question somebody has to go and answer.
    for (const line of server?.blockers ?? []) for (const wrapped of wrapProse(line, 76)) w(`${httpOn}// ${wrapped}`);
    w(`${httpOn}// start: 'npm start',`);
  }
  if (server && server.suggest?.stateless === true) {
    w(`${httpOn}// NO "restore", and that is an answer rather than something left out. A restore command`);
    w(`${httpOn}// puts the data back so both builds see the same rows — and nothing this server installs`);
    w(`${httpOn}// stores anything, and there is no database beside it, so there is nothing to put back.`);
    w(`${httpOn}// If it does keep something in a way nothing here recognised, add it:`);
    w(`${httpOn}// restore: 'npm run db:reset',`);
  } else {
    w(`${httpOn}// A command that puts the data back how it was, so both builds see the same rows.`);
    w(`${httpOn}// Without it the second run sees whatever the first one wrote. A command that looks`);
    w(`${httpOn}// like it destroys data it cannot rebuild is refused rather than run.`);
    w(`${httpOn}// restore: 'npm run db:reset',`);
  }
  w(`${httpOn}// One real value per changing part of a route address. A route with a part nobody`);
  w(`${httpOn}// has given a value for is reported as never looked at, never quietly skipped.`);
  w(`${httpOn}// samples: { id: '1', slug: 'a-real-one' },`);
  w(`${httpOn}// Extra requests the source cannot show — anything needing a body or a header.`);
  w(`${httpOn}// requests: [{ name: 'sign in', method: 'POST', url: '/api/session', body: { email: '...' } }],`);
  w(`${httpOn}// Routes that spend money, send a message or destroy data. Watched at the moment`);
  w(`${httpOn}// they are asked for, and stopped before anything happens.`);
  const risky = riskyRoutes(project);
  if (server && risky.length > 0) {
    w(`${httpOn}// These were picked out by their NAMES, which is a guess. Take out any that are`);
    w(`${httpOn}// really safe; add any that are missing. Erring towards the list costs a route`);
    w(`${httpOn}// being watched instead of walked. Erring the other way costs somebody money.`);
    w(`${httpOn}irreversible: [${risky.map((r) => JSON.stringify(r.name)).join(', ')}],`);
  } else {
    w(`${httpOn}// irreversible: ['/api/charge'],`);
  }
  w(`${httpOn}// Also: env, nodeEnv, startTimeoutMs, watch (folders to notice writes in).`);
  w(server ? '  },' : '  // },');
  w('');

  // ── web ───────────────────────────────────────────────────────────────────
  w('  // ───────────────────────────────────────────────────────────────────────');
  w('  // Websites. Opened in a throwaway browser with the clock stopped, motion');
  w('  // killed, randomness seeded and the internet cut off. What is compared is');
  w('  // what the screen MEANS — the roles, names and states a screen reader would');
  w('  // read — never the markup, so a restyled page reports nothing at all.');
  w('  // ───────────────────────────────────────────────────────────────────────');
  w(web ? '  web: {' : '  // web: {');
  const webOn = web ? '    ' : '  //   ';
  w(`${webOn}// The command that starts it, listening on the PORT it is given. Much better than`);
  w(`${webOn}// an address: one address can only serve one build, so with an address alone both`);
  w(`${webOn}// halves of the comparison read the same running copy and prove nothing.`);
  const webStart = web?.suggest?.start;
  const flatSite = !webStart && Array.isArray(web?.suggest?.screens) && web.suggest.screens.length > 0;
  if (webStart) {
    // Why this command and not the obvious one. A development server never exits, serves
    // unbundled source, and wires a live-reload connection into every page — a second thing
    // moving under the comparison for reasons that have nothing to do with the change. So
    // wherever there is a way to build and then serve the build, that is what is written, and
    // the reason is written beside it.
    if (web?.startNote) for (const line of wrapProse(web.startNote, 76)) w(`${webOn}// ${line}`);
    w(`${webOn}start: ${JSON.stringify(String(webStart))},`);
  } else if (flatSite) {
    w(`${webOn}// This is a site made of files rather than a program, so anything that serves this`);
    w(`${webOn}// folder on the PORT it is given will do. Left commented because it fetches a`);
    w(`${webOn}// package the first time it runs, and that is a decision rather than a default.`);
    w(`${webOn}// start: 'npx --yes serve -l $PORT .',`);
  } else {
    w(`${webOn}// start: 'npm run dev',`);
  }
  w(`${webOn}// Or, if it is already running somewhere and you accept the weaker answer:`);
  w(`${webOn}// url: 'http://localhost:3000',`);
  const screens = /** @type {any[]} */ (web?.suggest?.screens ?? []);
  if (screens.length > 0) {
    // WHERE THESE CAME FROM, and it is the most important comment in this file. Reading the
    // folder names finds one screen in a single-page app and reports it as the whole product.
    // So the router is read instead; and where there is no router at all, the screens are read
    // off the strip of tabs that switches between them and reached by CLICKING, because a
    // made-up address would land on the same screen every time and report it as checked.
    if (web?.router?.why) for (const line of wrapProse(web.router.why, 76)) w(`${webOn}// ${line}`);
    w(`${webOn}screens: [`);
    for (const screen of screens.slice(0, 40)) {
      const steps = Array.isArray(screen.steps) && screen.steps.length > 0
        ? `, steps: [${screen.steps.map((/** @type {Record<string, string>} */ step) => `{ ${Object.entries(step).map(([key, value]) => `${key}: ${JSON.stringify(String(value))}`).join(', ')} }`).join(', ')}]`
        : '';
      const describe = typeof screen.describe === 'string' ? `, describe: ${JSON.stringify(String(screen.describe))}` : '';
      w(`${webOn}  { name: ${JSON.stringify(String(screen.name))}, url: ${JSON.stringify(String(screen.url))}${steps}${describe} },`);
    }
    w(`${webOn}],`);
    if (screens.some((screen) => Array.isArray(screen.steps) && screen.steps.length > 0)) {
      w(`${webOn}// A click that finds nothing is reported as a screen that was NOT looked at, never as`);
      w(`${webOn}// a screen that was fine. If one of these names is not what the control actually says,`);
      w(`${webOn}// the run says so by name and the fix is one word here.`);
    }
  } else if (project.pages.length > 0) {
    w(`${webOn}// ${project.pages.length} page address${project.pages.length === 1 ? '' : 'es'} are read out of your folder names automatically — nothing to list here.`);
    w(`${webOn}// Add a screen only for something a walk has to DO rather than just open:`);
    w(`${webOn}// screens: [{ name: 'signing in', url: '/login', steps: [{ fill: '#email', with: 'a@b.c' }, { click: 'Sign in' }] }],`);
  } else {
    w(`${webOn}// screens: [{ name: 'the front page', url: '/' }],`);
  }
  const waiting = /** @type {{url: string, names: string[]}[]} */ (web?.suggest?.screensNeedingValues ?? []);
  if (waiting.length > 0) {
    const names = [...new Set(waiting.flatMap((one) => one.names))];
    w(`${webOn}// ${waiting.length === 1 ? 'One more address is' : `${waiting.length} more addresses are`} declared and NOT in the list above, because ${waiting.length === 1 ? 'it has' : 'they have'} a part that`);
    w(`${webOn}// changes — an id, a slug — and only somebody who knows the data knows a value that really`);
    w(`${webOn}// exists. ${waiting.slice(0, 6).map((one) => one.url).join(', ')}${waiting.length > 6 ? ' and others' : ''}.`);
    w(`${webOn}// Fill one value in per name and they start being opened. Until then they are reported as`);
    w(`${webOn}// never looked at, which is the point of naming them here rather than dropping them.`);
    w(`${webOn}// samples: { ${names.slice(0, 4).map((name) => `${name}: 'a-real-one'`).join(', ')} },`);
  } else {
    w(`${webOn}// One real value per changing part of a page address.`);
    w(`${webOn}// samples: { slug: 'a-real-one' },`);
  }
  w(`${webOn}// Also: viewport { width, height, deviceScaleFactor }, colorScheme, timezone, locale,`);
  w(`${webOn}// allowHosts (addresses the page is allowed to reach), refuse, allowWrites,`);
  w(`${webOn}// timeoutMs, settleTimeoutMs, startTimeoutMs, env, nodeEnv, restore, everyStep.`);
  w(web ? '  },' : '  // },');
  w('');

  // ── electron ──────────────────────────────────────────────────────────────
  w('  // ───────────────────────────────────────────────────────────────────────');
  w('  // Desktop apps. Opened on their own — own settings folder, own ports, own');
  w('  // name — and read on both sides: the window, and the private channels behind');
  w('  // it. A channel is only ever ASKED to answer when you name it here, because');
  w('  // knocking on an unknown door could do anything.');
  w('  // ───────────────────────────────────────────────────────────────────────');
  w(electron ? '  electron: {' : '  // electron: {');
  const elOn = electron ? '    ' : '  //   ';
  w(`${elOn}// The built app. On a Mac that is the .app; on Windows the .exe.`);
  const binary = electron?.suggest?.binary;
  w(binary ? `${elOn}binary: ${JSON.stringify(String(binary))},` : `${elOn}// binary: 'release/mac-arm64/Your App.app',`);
  const appId = electron?.suggest?.appId;
  if (appId) {
    w(`${elOn}// The application id, read out of your own packaging config. It is how the run tells the`);
    w(`${elOn}// window it opened from a window of the same app that was already on your screen.`);
    w(`${elOn}appId: ${JSON.stringify(String(appId))},`);
  }
  // The identity question, answered rather than asked. See identityVariables() for why this
  // is the shape it is: the whole point of a set-up list is that every line on it can be
  // ticked off, and a line asking for a variable that does not exist can never be.
  const identity = electron ? identityVariables(project.envNames) : [];
  if (identity.length > 0) {
    w(`${elOn}// This app reads ${identity.length === 1 ? 'a setting' : 'settings'} that could be how it says who it is: ${identity.slice(0, 4).join(', ')}.`);
    w(`${elOn}// If one of them carries a device or machine id, name it here and every run gets its own,`);
    w(`${elOn}// so two runs never claim one slot and fight over it — which looks exactly like a bug.`);
    w(`${elOn}// identityEnv: { ${identity[0]}: '{identity}' },`);
  } else if (electron && project.doors.read) {
    w(`${elOn}// NO "identityEnv", and this is an answer rather than something left out. If an app tells`);
    w(`${elOn}// a server who it is with a device id from its environment, two runs would claim one slot`);
    w(`${elOn}// and fight over it — that exact bug has happened to a real product. Every setting this app`);
    w(`${elOn}// reads out of its environment was listed by name, and not one of them carries a device or`);
    w(`${elOn}// machine id, so there is nothing to pass through. Every run already gets a settings folder`);
    w(`${elOn}// of its own, which is where an identity generated at first start would live.`);
  } else {
    w(`${elOn}// If your app tells a server who it is, name the setting that carries the id and it`);
    w(`${elOn}// is given a different one per run. Without this, two runs can claim the same slot`);
    w(`${elOn}// and fight over it — which looks exactly like a bug in your product.`);
    w(`${elOn}// identityEnv: { YOUR_APP_DEVICE_ID: '{identity}' },`);
  }
  const askable = electron ? channelsSafeToAsk(project.channels) : { safe: [], skipped: 0 };
  w(`${elOn}// Private channels asked to answer. Each becomes a journey of its own, so a channel that`);
  w(`${elOn}// stops ANSWERING is caught and not only one that stops existing.`);
  if (askable.safe.length > 0) {
    w(`${elOn}// These were picked out of the ${project.doors.ipc} channels in your source by NAME — every one of them`);
    w(`${elOn}// asks for something rather than doing something: get, list, status, read, about. The other`);
    w(`${elOn}// ${askable.skipped} were left out because their names say they write, or that they carry a secret. That is a`);
    w(`${elOn}// reading of a name and not a promise: if one of these turns out to change something,`);
    w(`${elOn}// delete the line. Nothing is ever asked of a channel that is not written here.`);
    w(`${elOn}exercise: [`);
    for (const line of chunk(askable.safe, 4)) w(`${elOn}  ${line.map((name) => JSON.stringify(name)).join(', ')},`);
    w(`${elOn}],`);
  } else {
    w(`${elOn}// A channel is only ever asked when it is named here, because knocking on an unknown door`);
    w(`${elOn}// could do anything.`);
    w(`${elOn}// exercise: ['settings:read', 'sessions:list'],`);
  }
  w(`${elOn}// Walks through the window itself.`);
  w(`${elOn}// journeys: [{ name: 'opening a session', steps: [{ click: 'New session' }] }],`);
  w(`${elOn}// Also: ${appId ? '' : 'appId, '}args, env, windowMatch, startTimeoutMs, settleTries, settleGapMs.`);
  w(electron ? '  },' : '  // },');
  w('');

  // ── android ───────────────────────────────────────────────────────────────
  const android = has('android');
  const androidHere = android?.adapter === 'android';
  w('  // ───────────────────────────────────────────────────────────────────────');
  w('  // Android apps. Installed on an emulator of its own, walked, then removed.');
  w('  // Compared against the stored record — whether two emulator snapshots come');
  w('  // back byte for byte is unproven, and a run says which mode it used.');
  w('  // ───────────────────────────────────────────────────────────────────────');
  w(androidHere ? '  android: {' : '  // android: {');
  const andOn = androidHere ? '    ' : '  //   ';
  const apk = android?.suggest?.apk;
  w(`${andOn}// The built package. Left out, it looks in the usual build folders.`);
  w(apk ? `${andOn}apk: ${JSON.stringify(String(apk))},` : `${andOn}// apk: 'app/build/outputs/apk/debug/app-debug.apk',`);
  w(`${andOn}// Which emulator to use. Left out, it takes the first one that is not a Play Store image.`);
  w(`${andOn}// avd: 'Pixel_7_API_35',`);
  w(`${andOn}// Or a device already plugged in or already running.`);
  w(`${andOn}// serial: 'emulator-5554',`);
  w(`${andOn}// Walks through the app. Left out, it opens the app and reads the first screen.`);
  w(`${andOn}// journeys: [{ name: 'signing in', steps: [{ tap: 'Sign in' }] }],`);
  w(`${andOn}// Also: headless (false shows the emulator window), timezone, locale, reset,`);
  w(`${andOn}// allowTo (addresses the app is allowed to reach), settleTries.`);
  w(androidHere ? '  },' : '  // },');
  w('');

  // ── windows ───────────────────────────────────────────────────────────────
  const windows = has('desktopNative');
  const windowsHere = windows?.adapter === 'windows';
  w('  // ───────────────────────────────────────────────────────────────────────');
  w('  // Native Windows apps. A Windows window can only be read from Windows, so');
  w('  // this needs a machine running it — an ssh host you already have counts, and');
  w('  // no VM and no CI account is needed. Two builds can never run at once, because');
  w('  // Windows only ever shows one desktop, so runs are one after the other.');
  w('  // ───────────────────────────────────────────────────────────────────────');
  w(windowsHere ? '  windows: {' : '  // windows: {');
  const winOn = windowsHere ? '    ' : '  //   ';
  w(`${winOn}// The ssh host that reaches a logged-in Windows desktop.`);
  w(`${winOn}// host: 'your-windows-box',`);
  w(`${winOn}// The built .exe here, which is copied over — or one already on that machine.`);
  w(`${winOn}// exe: 'release/YourApp.exe',`);
  w(`${winOn}// remoteExe: 'C:\\Users\\you\\YourApp\\YourApp.exe',`);
  w(`${winOn}// Folders on that machine to watch for files the app writes.`);
  w(`${winOn}// watchDirs: ['C:\\Users\\you\\AppData\\Roaming\\YourApp'],`);
  w(`${winOn}// Also: args, cwd, journeys.`);
  w(windowsHere ? '  },' : '  // },');
  w('');

  // ── ios ───────────────────────────────────────────────────────────────────
  const iosHere = ios?.adapter === 'ios';
  w('  // ───────────────────────────────────────────────────────────────────────');
  w('  // iPhone and iPad apps. Installed on a simulator, opened, and read — the same');
  w('  // roles, names and states a person hears read out to them. One build at a time.');
  w('  // Two builds on a real phone in your hand can never be compared side by side,');
  w('  // on any machine, ever — that is a fact about phones, not about this tool.');
  w('  // ───────────────────────────────────────────────────────────────────────');
  w(iosHere ? '  ios: {' : '  // ios: {');
  const iosOn = iosHere ? '    ' : '  //   ';
  const iosApp = ios?.suggest?.app;
  w(`${iosOn}// The built app bundle for the simulator. Left out, it looks where builds land.`);
  w(iosApp ? `${iosOn}app: ${JSON.stringify(String(iosApp))},` : `${iosOn}// app: 'build/Debug-iphonesimulator/YourApp.app',`);
  w(`${iosOn}// Which simulator to use, and which system to run it on. Left out, it takes a sensible`);
  w(`${iosOn}// one and says which.`);
  w(`${iosOn}// deviceType: 'iPhone 17', runtime: 'iOS 26.4',`);
  w(`${iosOn}// Walks through the app. Left out, it opens the app and reads the first screen.`);
  w(`${iosOn}// journeys: [{ name: 'signing in', steps: [{ tap: 'Sign in' }] }],`);
  w(`${iosOn}// Addresses to open the app with, for a screen that is reached by a link.`);
  w(`${iosOn}// openUrls: ['yourapp://sessions'],`);
  w(`${iosOn}// Also: device, appearance, reset, logProcess.`);
  w(iosHere ? '  },' : '  // },');
  w('');

  // Anything this repository makes that this copy of the tool has nothing to drive. Read from
  // what is actually loaded, never stated. A sentence hard-coded here would go on telling
  // somebody their iPhone app cannot be checked on the day the adapter that checks it landed —
  // and it would contradict the readiness this same command printed two lines earlier.
  const undrivable = project.products.filter((product) => product.adapter === null);
  if (undrivable.length > 0) {
    const one = undrivable.length === 1;
    w(`  // ${one ? 'One thing this repository makes has no section here' : `${undrivable.length} things this repository makes have no section here`}, and that is not an oversight.`);
    w(`  // This copy of the tool has nothing in it that can drive ${one ? 'it' : 'them'}, so a setting would do`);
    w(`  // nothing at all. ${one ? 'It is' : 'They are'} not being checked, \`staysfixed init\` says so every time it`);
    w(`  // runs, and every clean result stays silent about ${one ? 'it' : 'them'}:`);
    for (const product of undrivable) {
      w(`  //   ${padTo(product.name, 30)} ${PRODUCT_KINDS[product.kind].what}`);
    }
    w('');
  }

  // ── the rest ──────────────────────────────────────────────────────────────
  w('  // ───────────────────────────────────────────────────────────────────────');
  w('  // Two things that are NOT settings in this tool, said here so nobody looks:');
  w('  //');
  w('  // There is no tolerance, and there never will be. How much your product');
  w('  // disagrees with itself is MEASURED, by running the new build twice, and');
  w('  // subtracted. A number you tune by hand is how a tool like this dies: too');
  w('  // loose to catch the real thing, too tight to leave switched on.');
  w('  //');
  w('  // There is nothing to approve. The build you say `staysfixed ship` about');
  w('  // becomes what "working" means. Nobody opens this tool to bless a picture.');
  w('  //');
  w('  // What normalisation hides — a version number in a footer, a timestamp — is');
  w('  // data too, kept in .staysfixed/rules.json so it can be read in a pull');
  w('  // request. Each rule has to say what real change it could wrongly hide.');
  w('  // ───────────────────────────────────────────────────────────────────────');
  w('};');
  w('');

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Honest degradation
// ---------------------------------------------------------------------------

/**
 * What a clean run in this project would actually mean, in the words to repeat to a person.
 *
 * This is the paragraph the whole design turns on. A project where only the website can be
 * checked is useful; a project where only the website can be checked and the report says
 * "all good" is worse than nothing.
 *
 * @param {Readiness[]} readiness
 * @returns {InitPlan['covers']}
 */
function whatItCovers(readiness) {
  const covered = readiness.filter((r) => r.state === 'ready').map((r) => r.product);
  const partly = readiness.filter((r) => r.state === 'the agent can fix this' || r.state === 'only a person can do this').map((r) => r.product);
  const notCovered = readiness.filter((r) => r.state === 'not possible here').map((r) => r.product);

  /** @type {string[]} */
  const parts = [];
  if (covered.length > 0) parts.push(`Right now a check here covers ${plainList(covered)} in full.`);
  else parts.push('Right now a check here covers nothing in full.');
  if (partly.length > 0) parts.push(`${plainList(partly, true)} ${partly.length === 1 ? 'is' : 'are'} not covered yet, and the list below says exactly what is in the way and who has to do it.`);
  if (notCovered.length > 0) parts.push(`${plainList(notCovered, true)} ${notCovered.length === 1 ? 'is' : 'are'} not checked at all, so a clean result says nothing whatever about ${notCovered.length === 1 ? 'it' : 'them'}.`);
  if (partly.length === 0 && notCovered.length === 0 && covered.length > 0) parts.push('Nothing is being left out.');

  return { covered, partly, notCovered, short: parts.join(' ') };
}

/**
 * The commands to run next, in order, each with what it is for.
 *
 * @param {Readiness[]} readiness
 * @param {ProjectShape} project
 * @returns {{command: string, what: string}[]}
 */
function nextCommands(readiness, project) {
  /** @type {{command: string, what: string}[]} */
  const next = [];
  next.push({ command: 'staysfixed doctor --json', what: 'What this machine can and cannot drive, as one object. The first call an agent should make.' });
  // The first run is worth taking as soon as ANYTHING here can be reached, not only once
  // everything can. Holding it back until every product is ready meant a project waiting on
  // one sample value was never told to start, and a first run that records three products out
  // of four is three products more than nothing — the reply says which ones it left out.
  const reachable = readiness.filter((r) => r.state !== 'not possible here');
  if (reachable.length > 0) {
    next.push({
      command: 'staysfixed check --paired',
      what: reachable.some((r) => r.state === 'ready')
        ? 'The first real run. It records what working looks like, so later runs have something to compare against.'
        : 'The first real run. Nothing here is fully set up yet, so it records what it can reach and says plainly what it left out — which is more useful than waiting.',
    });
  }
  if (project.tests.files > 0) {
    next.push({ command: 'staysfixed check --journeys suite', what: `Walk the ${project.tests.files} test${project.tests.files === 1 ? '' : 's'} this project already has, under instrumentation.` });
  }
  next.push({ command: 'staysfixed check --json', what: 'The everyday run. Only what changed comes back.' });
  next.push({ command: 'staysfixed ship', what: 'Run this at the end of your release script. The build that went out becomes what "working" means.' });
  return next;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/**
 * The plan, said out loud, short.
 *
 * Short is a requirement rather than a preference. Everything here also exists as data in the
 * plan object, and an agent reads that; a person reads this, and a person reading twenty lines
 * reads none of them.
 *
 * @param {InitPlan} plan
 * @returns {string[]}
 */
export function describePlan(plan) {
  /** @type {string[]} */
  const lines = [];
  lines.push(plan.project.summary);
  lines.push('');
  lines.push(plan.covers.short);

  if (plan.needs.person.length > 0) {
    lines.push('');
    lines.push(plan.needs.person.length === 1 ? 'One thing needs you:' : `${plan.needs.person.length} things need you:`);
    for (const need of plan.needs.person) {
      lines.push(`  ${need.what} — ${need.why} It unlocks ${need.unlocks}.`);
      lines.push(`    ${need.fix}`);
    }
  }
  for (const need of plan.needs.impossible) {
    lines.push('');
    lines.push(`Not possible here: ${need.what}. ${need.fix}`);
  }
  // Code nothing could account for is the quietest way a run over-claims, so it is said in
  // the summary a person reads rather than left in the data an agent might not open.
  if (plan.project.unsure.length > 0) {
    lines.push('');
    lines.push('Worth knowing:');
    for (const doubt of plan.project.unsure) lines.push(`  ${doubt}`);
  }
  return lines;
}

/**
 * @param {InitResult} result
 * @returns {string[]}
 */
export function describeResult(result) {
  const lines = describePlan(result.plan);
  lines.push('');
  if (result.written.length > 0) lines.push(`Written: ${result.written.map((f) => shortPath(f)).join(', ')}.`);
  if (result.kept.length > 0) lines.push(`Left exactly as it was: ${result.kept.map((f) => shortPath(f)).join(', ')}.`);
  for (const problem of result.problems) lines.push(problem);
  return lines;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Add the throwaway folders to .gitignore, and only the lines that are not there already.
 *
 * @param {string} root
 * @returns {Promise<{file: string|null, changed: boolean, problem?: string}>}
 */
async function addIgnoreLines(root) {
  const file = path.join(root, '.gitignore');
  let text = '';
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    if (!existsSync(path.join(root, '.git'))) return { file: null, changed: false };
  }
  const missing = GITIGNORE_LINES.filter((line) => line.startsWith('#') === false && !text.includes(line));
  if (missing.length === 0) return { file, changed: false };
  try {
    const prefix = text === '' || text.endsWith('\n') ? '' : '\n';
    await fsp.writeFile(file, `${text}${prefix}\n${GITIGNORE_LINES[0]}\n${missing.join('\n')}\n`, 'utf8');
    return { file, changed: true };
  } catch (error) {
    return { file, changed: false, problem: `The ignore list at ${shortPath(file)} could not be added to: ${messageOf(error)}` };
  }
}

/**
 * @param {string} file
 * @returns {Promise<any|null>}
 */
async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * "a, b and c" — a comma-separated list reads like a machine wrote it.
 * @param {string[]} items
 * @param {boolean} [capitalise]
 * @returns {string}
 */
function plainList(items, capitalise = false) {
  const list = items.length <= 1 ? (items[0] ?? 'nothing') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  return capitalise ? list.charAt(0).toUpperCase() + list.slice(1) : list;
}

/**
 * "1 route" and "3 routes", so no sentence in this tool ever reads like a machine wrote it.
 * @param {number} n
 * @param {string} one
 * @param {string} many
 * @returns {string}
 */
function count(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function sentenceCase(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * `staysfixed init`, in the same shape the rest of the command table uses. Merged into the
 * front door the same way version 2's other commands are:
 *
 *     import { INIT_COMMANDS } from '../v2/init.js';
 *     Object.assign(COMMANDS, INIT_COMMANDS);
 *
 * @type {Record<string, {summary: string, usage: string, describe: string, options: [string,string][], examples: string[], spec: {booleans?: string[], strings?: string[], arrays?: string[]}, load: () => Promise<{run: (ctx: any) => Promise<number>}>}>}
 */
export const INIT_COMMANDS = {
  init: {
    summary: 'Set this up for this project, working out everything that can be worked out.',
    usage: 'staysfixed init [--json] [--dry-run] [--force] [--offline]',
    describe:
      'Reads your project — package.json, the folder shapes, the framework config, the built\nartifacts, the test suite, and every route and channel written in the source — and works\nout what it makes. Then it reads this machine and works out what can be driven here.\nThen it writes settings with an explanation beside every option.\n\nIt never overwrites settings that are already there. It never asks you for anything it\ncould work out on its own. And it tells you, in plain words, what is left: what the tool\nwill install itself, what genuinely needs you, and what is not possible here at all.\n\n--json is the whole answer as one object, and it is what an agent installing this should\nread. Everything in the printed version is in there, plus the settings it would write.',
    options: [
      ['--json', 'The whole answer as one JSON object and nothing else. For agents.'],
      ['--dry-run', 'Work everything out and write nothing.'],
      ['--force', 'Overwrite settings that are already there. Off by default, on purpose.'],
      ['--offline', 'Do not dial any other machine while looking at this one. Faster.'],
      ['--no-gitignore', 'Do not add the throwaway folders to .gitignore.'],
      ['--shallow', 'Do not read the source. Much faster on a very large repository, and it sees less.'],
    ],
    examples: ['staysfixed init', 'staysfixed init --json', 'staysfixed init --dry-run'],
    spec: { booleans: ['json', 'dry-run', 'force', 'offline', 'gitignore', 'shallow'] },
    load: async () => ({ run }),
  },
};

/**
 * `staysfixed init`.
 *
 * @param {import('../cli/index.js').CliContext} ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  const asJson = ctx.bool('json');
  // Nothing meant for a person may reach standard output when an agent asked for JSON. One
  // stray sentence in front of the object is a parse error rather than a warning.
  if (asJson) setLogLevel({ quiet: true });

  const result = await init({
    cwd: ctx.cwd,
    offline: ctx.bool('offline'),
    readCode: !ctx.bool('shallow'),
    dryRun: ctx.bool('dry-run'),
    force: ctx.bool('force'),
    gitignore: ctx.flags['gitignore'] !== false,
  });

  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.ok ? EXIT.ok : EXIT.error;
  }

  heading('Stays Fixed — setting up for this project');
  blank();
  say(result.plan.project.summary);
  blank();

  for (const item of result.plan.readiness) {
    if (item.state === 'ready') ok(item.summary);
    else if (item.state === 'not possible here') fail(item.summary);
    else warn(item.summary);
    if (item.state === 'not possible here') {
      if (item.instead) say(paint.grey(`    ${mark.info} ${item.instead}`));
      continue;
    }
    for (const need of item.needs) {
      say(paint.grey(`    ${mark.info} ${need.what} — ${need.who === 'the agent' ? 'the tool can do this itself: ' : 'somebody has to: '}${need.fix}`));
    }
  }

  blank();
  say(paint.grey(`  ${mark.info} ${result.plan.covers.short}`));
  for (const doubt of result.plan.project.unsure) say(paint.grey(`  ${mark.info} ${doubt}`));

  if (result.plan.journeys.length > 0) {
    blank();
    heading('What it would walk');
    for (const journey of result.plan.journeys) {
      say(`  ${journey.name}`);
      say(paint.grey(`    ${journey.what} — from ${journey.from}${journey.ready ? '' : ', once the things above are in place'}`));
    }
  }

  blank();
  if (result.written.length > 0) ok(`Written: ${result.written.map((f) => shortPath(f)).join(', ')}`);
  if (result.kept.length > 0) warn(`Left exactly as it was: ${result.kept.map((f) => shortPath(f)).join(', ')}`);
  for (const problem of result.problems) fail(problem);

  blank();
  heading('What to run next');
  for (const step of result.plan.wiring.next) {
    say(`  ${step.command}`);
    say(paint.grey(`    ${step.what}`));
  }
  blank();
  say(paint.grey('  The same answer as JSON, which is what an agent should read: staysfixed init --json'));
  blank();

  return result.ok ? EXIT.ok : EXIT.error;
}

// Named so a reader of this file can see, in one place, where the settings may live and what
// the folder inside a project is called — both owned by src/core/paths.js, both re-stated
// here because init is the one command whose whole job is those two facts.
export { CONFIG_NAMES, DEFAULT_DIR };

/**
 * Which private channels are safe to knock on, read off their names.
 *
 * THE RULE THIS BENDS, AND WHY IT IS STILL THE RIGHT CALL. A channel between a desktop app's
 * two halves is only ever asked to answer when it is named in the settings, because knocking
 * on an unknown door could do anything. That rule stays. What changes is who does the naming:
 * leaving the list empty means somebody reads four hundred and fifty registrations by hand
 * before a single one of them is watched, and until they do, a channel that stops answering is
 * invisible. Nobody does that, so nothing gets watched.
 *
 * So the list is filled in from names that ASK for something rather than do something, and the
 * settings say plainly that it is a reading of a name rather than a promise about behaviour.
 * Three lines hold it:
 *
 *   - only channels that hand a value back — a listener that answers nothing has nothing to
 *     compare, and asking it is all risk and no reading;
 *   - only names whose last word is one of a short list of asking words;
 *   - and never a name with a secret in it. `browser-password:get` reads as an asking word and
 *     would put somebody's password into a stored observation, which is the one mistake here
 *     that cannot be taken back by deleting a line.
 *
 * @param {ProjectShape['channels']} channels
 * @returns {{safe: string[], skipped: number}}
 */
export function channelsSafeToAsk(channels) {
  const asks = /(^|[:.\-/])(get|list|read|status|state|about|info|paths?|version|capabilities|count|summary|describe|available)$/i;
  // Anything whose name says it DOES something, wherever in the name it appears — not only at
  // the end. `settings:open-path` ends in a word that reads like asking and opens a window in
  // front of somebody; `chrome-import:open-privacy-settings` ends in "settings" and opens a
  // browser page. Both got through a rule that only looked at the last word, and both are the
  // kind of mistake that has to be impossible rather than unlikely.
  const acts = /(^|[:.\-/])(open|set|write|save|delete|remove|clear|reset|start|stop|launch|install|uninstall|send|import|export|sync|run|kill|restart|approve|revoke|pair|unpair|update|create|add|apply|move|rename|copy|quit|close|sign|login|logout|connect|disconnect|enable|disable|toggle|upload|download|share|unshare|grant|deny|prompt|ask|select|choose|pick|reveal|focus|show|hide)([:.\-/]|$)/i;
  // And anything that could hand back something private. A stored observation is written to
  // disk and read by an agent; a password or an ssh key in one is the single mistake here that
  // cannot be undone by deleting a line afterwards. Erring wide costs a channel going
  // unwatched, which is visible in the coverage ledger. Erring narrow costs a secret.
  const secret = /(password|secret|token|credential|api-?key|\bkeys?\b|keychain|passphrase|cookie|auth|login|account|identity|session-?id|private)/i;
  /** @type {string[]} */
  const safe = [];
  let skipped = 0;
  for (const channel of channels) {
    if (!channel.answers) {
      skipped += 1;
      continue;
    }
    if (secret.test(channel.name) || acts.test(channel.name) || !asks.test(channel.name)) {
      skipped += 1;
      continue;
    }
    safe.push(channel.name);
  }
  safe.sort();
  // A ceiling, because a settings file with four hundred lines of one array in it is a file
  // nobody scrolls past, and the coverage ledger names what was left out either way.
  const most = 60;
  if (safe.length > most) skipped += safe.length - most;
  return { safe: safe.slice(0, most), skipped };
}

/**
 * A name padded out so a column of them lines up. Purely so a person can read the list.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
function padTo(text, width) {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * A sentence broken into lines that fit inside a comment.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
function wrapProse(text, width) {
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  let current = [];
  let length = 0;
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (length > 0 && length + 1 + word.length > width) {
      lines.push(current.join(' '));
      current = [];
      length = 0;
    }
    current.push(word);
    length += (length > 0 ? 1 : 0) + word.length;
  }
  if (current.length > 0) lines.push(current.join(' '));
  return lines;
}

/**
 * A list broken into rows of a size, so a long array reads as a block rather than a column.
 *
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
function chunk(items, size) {
  /** @type {T[][]} */
  const rows = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}
