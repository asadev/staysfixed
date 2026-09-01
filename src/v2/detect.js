/**
 * What IS this project?
 *
 * Everything else in version 2 answers "what changed". This file answers the question that
 * comes before it, and it answers it WITHOUT ASKING ANYBODY. An agent told to install this
 * tool into a stranger's repository should never have to type "is this a website or a
 * desktop app?" into a chat window. The repository already says. It says it in its
 * package.json, in its lockfile, in the shape of its folders, in the config files its
 * framework leaves lying around, in the built artifacts sitting in `out/`, in an `.xcodeproj`,
 * in a `gradlew`, in a Dockerfile, in the name of its test runner. All of that is free to
 * read and none of it needs a person.
 *
 * THE ANSWER IS USUALLY MORE THAN ONE THING, and that is the part every tool like this gets
 * wrong. A repository is not "a Node project". Terminal Deck is one repository that produces
 * a desktop app, an iPhone app, an Android app, a small web client and a relay server — five
 * products, five toolchains, one shared `src/`. A tool that picks the single best-matching
 * label and moves on will check the desktop app, report a clean run, and say nothing at all
 * about the phone. So this file returns a LIST of products, each with its own evidence, its
 * own confidence, its own adapter and its own reason. Several at once is the normal case.
 *
 * WHAT IT NEVER DOES. It never runs anything — no `npm install`, no build, no dev server, no
 * `node -e`. It only reads. That matters twice over: reading is safe to do inside somebody
 * else's repository while they have it open in an editor, and it is safe to do inside a
 * repository nobody has audited. It also never writes. `init.js` writes; this file looks.
 *
 * HOW SURE IT IS, SAID OUT LOUD. Every product carries `confidence` and, more usefully,
 * `evidence` — the actual files that made it say so. A wrong guess with its evidence attached
 * is a thirty-second fix for an agent. A wrong guess with no evidence is an argument.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { whatItCallsItself, pythonEntryPoints } from './init.js';
import { fileURLToPath } from 'node:url';

/** @typedef {import('./types.js').Surface} Surface */

// ---------------------------------------------------------------------------
// The kinds of thing a repository can produce
// ---------------------------------------------------------------------------

/**
 * Every kind of product this tool has a name for, what it means in plain English, which
 * observation surface it belongs to, and which adapter would drive it.
 *
 * `adapter` names the adapter that WOULD drive this kind of product. Whether that adapter is
 * actually in this copy of the tool is a separate question, answered at run time by looking
 * for the file — see {@link adaptersHere}. Six adapters are being written in parallel, and a
 * table that hard-coded which ones exist would start lying the day one of them landed: it
 * would tell somebody their Android app cannot be checked while the Android adapter sat right
 * there. `null` means no adapter is even planned, which is a different and permanent answer.
 *
 * @type {Readonly<Record<string, {name: string, surface: Surface, adapter: string|null, what: string}>>}
 */
export const PRODUCT_KINDS = Object.freeze({
  cli: { name: 'a command-line tool', surface: 'cli', adapter: 'process', what: 'Something you type at a terminal. Watched by running it and reading what it printed, what it exited with and what it wrote.' },
  library: { name: 'a library other code imports', surface: 'library', adapter: 'process', what: 'Code other projects import. Watched by importing it and comparing what it exports and what those exports do.' },
  server: { name: 'a server or an API', surface: 'server', adapter: 'http', what: 'Something that answers requests. Watched by booting it on a spare port and asking it for every route read out of its own source.' },
  web: { name: 'a website or web app', surface: 'web', adapter: 'web', what: 'Something people open in a browser. Watched by opening it in a throwaway browser and reading what the screen says each control is and does.' },
  electron: { name: 'a desktop app built with Electron', surface: 'electron', adapter: 'electron', what: 'A desktop app. Watched by opening the built app on its own, reading its window, its menus and every private channel it registers.' },
  ios: { name: 'an iPhone or iPad app', surface: 'ios', adapter: 'ios', what: 'An Apple app. Driven on the simulator; a real device in your hand can never be compared side by side.' },
  android: { name: 'an Android app', surface: 'android', adapter: 'android', what: 'An Android app. Driven on an emulator against the stored record.' },
  desktopNative: { name: 'a native desktop app', surface: 'windows', adapter: 'windows', what: 'A desktop app that is not Electron — Swift, WinUI, Tauri, Qt. Only readable from the operating system it runs on — Windows here; see desktopNativeLinux for Linux.' },
  extension: { name: 'a browser extension', surface: 'extension', adapter: 'extension', what: 'Something you install in a browser. Watched by reading its manifest as a contract, opening its own pages, and comparing a page with the extension loaded against the same page without it.' },
  macNative: { name: 'a native Mac app', surface: 'macos', adapter: 'macos', what: 'A Mac app that is not Electron — Swift or Objective-C, AppKit or SwiftUI. Readable only on a Mac, one build at a time, and one person has to allow it once under Privacy & Security.' },
  desktopNativeLinux: { name: 'a native Linux desktop app', surface: 'linux', adapter: 'linux', what: 'A Linux desktop app that is not Electron — GTK, Qt, Tauri. Read through the accessibility bus every screen reader already uses, on a machine somebody is logged in to.' },
  container: { name: 'a containerised service', surface: 'server', adapter: 'http', what: 'A service that ships as a container. Watched the same way as any server, once there is a command that starts it.' },
  other: { name: 'a product in a language this tool cannot drive yet', surface: 'cli', adapter: null, what: 'Recognised, named, and honestly not drivable here. It is listed so a clean run is never mistaken for full coverage.' },
});

/**
 * Which adapters are actually in this copy of the tool, found by looking for the file.
 *
 * Cheap, and deliberately not an import: importing every adapter to find out whether it is
 * there costs a second and can throw. The folder is the register, and it updates itself the
 * moment somebody adds one.
 *
 * @returns {Set<string>}
 */
export function adaptersHere() {
  /** @type {Set<string>} */
  const here = new Set();
  // `fileURLToPath` rather than reading `.pathname` off the URL: on Windows a module URL's
  // pathname is `/C:/...`, which is not a path any filesystem call accepts, so the listing
  // below threw and every adapter went missing on the one platform nobody tests on.
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'adapters');
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.js')) continue;
      const id = name.slice(0, -3);
      // Two files in there are not adapters: the interface every adapter is written against,
      // and the helpers two of them share.
      if (id === 'contract' || id === 'isolate' || id.endsWith('-driver')) continue;
      here.add(id);
    }
    return here;
  } catch {
    // Fall through. A listing can be refused where a single file can still be asked about.
  }
  // Second angle, and it is still a reading rather than a claim: ask about each adapter this
  // tool has a name for, one file at a time. A hard-coded answer here would be the thing this
  // whole file exists to avoid — it would go on saying "there is no iOS adapter" on the day
  // one landed, and a stranger would be told their iPhone app cannot be checked by a copy of
  // the tool that could check it.
  for (const id of everyAdapterNamed()) {
    try {
      if (fs.existsSync(path.join(dir, `${id}.js`))) here.add(id);
    } catch {
      // Nothing readable about this one either. It stays out, which is the honest direction.
    }
  }
  return here;
}

/**
 * Every adapter this tool has a name for, taken from the product table rather than typed out
 * a second time, so the two can never disagree.
 *
 * @returns {string[]}
 */
function everyAdapterNamed() {
  /** @type {Set<string>} */
  const names = new Set(['source']);
  for (const kind of Object.values(PRODUCT_KINDS)) if (kind.adapter) names.add(kind.adapter);
  return [...names];
}

/** Folders never worth walking into. Walking `node_modules` is how a detector takes a minute. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', 'release', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', 'vendor', 'Pods',
  '.venv', 'venv', '__pycache__', 'target', '.gradle', '.idea', '.vscode', 'DerivedData',
  '.staysfixed', 'tmp', 'temp', '.yarn', '.pnpm-store', 'Carthage',
]);

/** Folders that are worth looking INSIDE for a second product, even without a package.json. */
const PLATFORM_FOLDERS = [
  'ios', 'android', 'apple', 'mobile', 'app', 'apps', 'desktop', 'electron', 'main',
  'web', 'site', 'www', 'client', 'frontend', 'pwa', 'server', 'api', 'backend',
  'relay', 'service', 'services', 'packages', 'native', 'src-tauri', 'cmd',
];

/** How many files the artifact and test sweeps will look at before giving up and saying so. */
const MOST_FILES = 20_000;

/**
 * The folders a project's own code normally lives in. The same list the source reader falls
 * back to, kept here so this file can say WHICH folders it asked for instead of leaving the
 * reader to guess — see {@link whereTheCodeIs} for why that mattered.
 */
const USUAL_SOURCE_FOLDERS = ['src', 'lib', 'app', 'bin', 'server', 'pages', 'api', 'electron', 'main', 'packages'];

/**
 * Root-level files that are how a project is BUILT rather than what it ships. A packaging
 * config sitting beside `src/` is no reason to read the whole repository; a `server.js`
 * sitting beside `src/` is every reason.
 */
const ROOT_TOOLING_FILES = new Set([
  'gulpfile.js', 'gulpfile.mjs', 'gulpfile.cjs', 'gruntfile.js', 'karma.conf.js',
  'protractor.conf.js', 'gatsby-config.js', 'gatsby-node.js', 'gatsby-browser.js',
  'gatsby-ssr.js', 'webpack.mix.js',
]);

/**
 * Folders that are never a product of their own: either the contract channel already read
 * them as part of the root product, or they hold work about the project rather than the
 * project. Flagging one of these as "code nobody is checking" would be noise, and noise is
 * how an honest warning gets ignored.
 */
const ALREADY_COVERED = new Set([
  'src', 'lib', 'app', 'bin', 'server', 'pages', 'api', 'electron', 'main', 'packages',
  'scripts', 'tools', 'test', 'tests', '__tests__', 'spec', 'e2e', 'docs', 'doc',
  'examples', 'example', 'fixtures', 'types', 'typings', 'config', 'public', 'static',
  'assets', 'styles', 'migrations', 'benchmarks',
]);

// ---------------------------------------------------------------------------
// The shapes this file hands back
// ---------------------------------------------------------------------------

/**
 * One thing that was actually found on disk, and what it means.
 *
 * Kept as data rather than folded into a sentence because an agent correcting a wrong guess
 * wants the file, and a person reading the summary wants the sentence, and building the
 * sentence from the file means the two can never disagree.
 *
 * @typedef {object} Clue
 * @property {string} where          Path relative to the project root, or a key inside package.json.
 * @property {string} means          Plain English: what finding this tells us.
 */

/**
 * One product this repository makes.
 *
 * @typedef {object} Product
 * @property {string} kind           A key of PRODUCT_KINDS.
 * @property {string} name           Plain English, specific to this one: 'the desktop app'.
 * @property {Surface} surface
 * @property {string|null} adapter   Which adapter would drive it, or null when none can yet.
 * @property {number} confidence     0..1. How sure, and it is allowed to be unsure.
 * @property {string} why            One plain sentence naming what made us say so.
 * @property {string} where          Folder this product lives in, relative to the root. '.' for the root.
 * @property {Clue[]} evidence       Every file that contributed. The whole audit trail.
 * @property {{found: boolean, where: string|null, how: string}} built
 *                                   Whether a built artifact is sitting there ready to be opened.
 * @property {string[]} blockers     Plain sentences: what stands between this and being checked.
 * @property {Record<string, any>} [suggest]   The config slice init would write for it.
 * @property {Router} [router]       For a web app: how it decides which screen to show, and so
 *                                   whether a screen has an address at all or only a click.
 * @property {string} [startNote]    Why the start command is the one it is, so the settings can
 *                                   say it beside the line itself.
 * @property {{language: string, reads: string|null}} [sourceBlind]
 *                                   Set on a product this tool CAN boot and CAN run but cannot
 *                                   fully read. `reads` names the one thing the source channel
 *                                   does see, or is null when it sees nothing at all. The
 *                                   language is carried by name because "some of it is not
 *                                   checked" is useless and "nothing here reads Go" is not, and
 *                                   because a product that is partly covered and reported as
 *                                   covered is worse than one nothing looks at.
 */

/**
 * Everything read off a repository without running any of it.
 *
 * @typedef {object} ProjectShape
 * @property {string} root
 * @property {string} name
 * @property {string|null} version
 * @property {boolean} isGitRepo
 * @property {Product[]} products    Ranked, most certain first. Several is normal.
 * @property {string} summary        One plain sentence naming what this repository makes.
 * @property {{name: string, lockfile: string|null, why: string}} packageManager
 * @property {string[]} workspaces   Workspace globs, when it is a monorepo.
 * @property {{name: string, root: string}[]} members   Sub-packages actually found.
 * @property {string[]} languages    Languages seen, most-used first.
 * @property {{runner: string|null, command: string|null, files: number, folders: string[], why: string}} tests
 * @property {{dev: string|null, start: string|null, build: string|null, test: string|null, typecheck: string|null, package: string|null}} scripts
 * @property {{ipc: number, route: number, export: number, command: number, env: number, unnamed: number, filesRead: number, read: boolean, why: string}} doors
 * @property {{name: string, method: string, file: string}[]} routes   Every route, by name. Capped.
 * @property {{name: string, answers: boolean, file: string}[]} channels
 *                                   Every private channel between a desktop app's two halves,
 *                                   by name. Capped. `answers` is true for the ones that hand
 *                                   a value back, which are the only ones worth asking.
 * @property {string[]} envNames     Every setting the code reads out of the environment, by
 *                                   name. Capped. Asking for one that does not exist is how a
 *                                   set-up list gets a line nobody can ever tick off.
 * @property {string[]} sourceFolders  The folders the contract channel should read, worked out
 *                                   from where the products actually are.
 * @property {{bytes: number, files: number, capped: boolean, biggest: {folder: string, bytes: number}[], freeBytes: number|null, tooBig: boolean, why: string}} bulk
 *                                   What copying this project would cost, and whether there is
 *                                   room. Three adapters copy it before running anything.
 * @property {{url: string, file: string, needs: string[]}[]} pages
 * @property {{dockerfile: string|null, compose: string|null}} containers
 * @property {Clue[]} evidence       Everything found, including clues no product claimed.
 * @property {string[]} unsure       Things it could not work out, in plain English.
 * @property {number} durationMs
 */

// ---------------------------------------------------------------------------
// The front door
// ---------------------------------------------------------------------------

/**
 * Work out what a project is, by reading it.
 *
 * @param {object} [options]
 * @param {string} [options.root]        Folder to look at. Defaults to the current one.
 * @param {boolean} [options.readCode]   Read the source for routes, IPC channels and exports.
 *                                       On by default: it is the only way to see a door
 *                                       nobody linked to. Turn it off for a fast answer on a
 *                                       very large repository.
 * @param {boolean} [options.deep]       Look inside sub-folders for more products. On by default,
 *                                       and it is what finds the phone app in a desktop repo.
 * @returns {Promise<ProjectShape>}
 */
export async function detectProject(options = {}) {
  const started = Date.now();
  const root = path.resolve(options.root ?? process.cwd());
  const readCode = options.readCode !== false;
  const deep = options.deep !== false;

  /** @type {Clue[]} */
  const evidence = [];
  /** @type {string[]} */
  const unsure = [];

  const pkg = await readJson(path.join(root, 'package.json'));
  if (pkg) evidence.push({ where: 'package.json', means: `This is an npm package called ${String(pkg.name ?? 'something with no name')}.` });

  const listing = await listOnce(root);
  const manager = packageManagerOf(listing, pkg);
  if (manager.lockfile) evidence.push({ where: manager.lockfile, means: `Dependencies are installed with ${manager.name}.` });

  const workspaces = workspaceGlobsOf(pkg, listing, root);
  const members = deep ? await findMembers(root, workspaces, listing) : [];
  for (const member of members) evidence.push({ where: member.root + '/package.json', means: `A second package inside this repository, called ${member.name}.` });

  // The source read, once, for two answers — how many doors there are, and what the routes
  // are called. Reading Terminal Deck's 1,416 files twice because two functions each wanted
  // their own copy cost a second and a half of the two this whole detection takes.
  // The folders are named here rather than left to the reader's own default, because the
  // default reads `src/` and its cousins and NOTHING at the top level — see
  // {@link whereTheCodeIs} for the server that went unread because of it.
  const firstFolders = whereTheCodeIs(listing);
  const reading = readCode ? await readTheSource(root, firstFolders) : { doors: notRead(), routes: [], channels: [], envNames: [] };
  const doors = reading.doors;
  const routes = reading.routes;
  const channels = reading.channels;
  const envNames = reading.envNames;
  const pages = readCode ? await readThePages(root) : [];
  if (doors.read && doors.route + doors.ipc > 0) {
    evidence.push({ where: 'the source', means: `${doors.route} route${doors.route === 1 ? '' : 's'} and ${doors.ipc} private channel${doors.ipc === 1 ? '' : 's'} are written in the code.` });
  }
  if (pages.length > 0) evidence.push({ where: 'the page folders', means: `${pages.length} page address${pages.length === 1 ? '' : 'es'} come from the names of folders, the way Next.js and its cousins do it.` });

  const tests = await findTests(root, pkg, listing);
  if (tests.runner) evidence.push({ where: tests.folders[0] ?? 'package.json', means: `Its own tests are written with ${tests.runner}, and there are ${tests.files} of them. Those are journeys this tool can walk instead of inventing its own.` });

  const containers = {
    dockerfile: listing.files.find((f) => f === 'Dockerfile' || f.startsWith('Dockerfile.')) ?? null,
    compose: listing.files.find((f) => /^(docker-)?compose\.ya?ml$/.test(f)) ?? null,
  };
  if (containers.dockerfile) evidence.push({ where: containers.dockerfile, means: 'It ships as a container, so there is a known way to start it and to put its data back.' });

  // Every place a product might live: the root, each workspace member, and each platform
  // folder that is plainly a product of its own even without a package.json — `ios/` holding
  // an Xcode project is the case that matters, and it has no package.json anywhere near it.
  /** @type {{root: string, pkg: any}[]} */
  const places = [{ root: '.', pkg }];
  for (const member of members) places.push({ root: member.root, pkg: member.pkg });
  if (deep) {
    for (const folder of listing.dirs) {
      if (SKIP_DIRS.has(folder)) continue;
      if (!PLATFORM_FOLDERS.includes(folder)) continue;
      if (places.some((p) => p.root === folder)) continue;
      places.push({ root: folder, pkg: await readJson(path.join(root, folder, 'package.json')) });
    }
  }

  const available = adaptersHere();
  /** @type {Product[]} */
  const products = [];
  for (const place of places) {
    const where = path.join(root, place.root);
    const local = place.root === '.' ? listing : await listOnce(where);
    products.push(...(await productsIn({
      root, where: place.root, listing: local, pkg: place.pkg,
      // Doors and pages were read from the root, so they only describe the root. A
      // sub-package gets credited with them only when it IS the root.
      doors: place.root === '.' ? theRootsOwnDoors(doors, routes, members) : notRead(),
      pages: place.root === '.' ? pages : [],
      containers: place.root === '.' ? containers : { dockerfile: null, compose: null },
      scripts: place.pkg?.scripts ?? {},
      available,
    })));
  }

  // Products no manifest advertises: a command-line program built into a folder nobody
  // commits, and a server that is three files and a socket. Both are real, both are shipped,
  // and both were invisible to everything above, which reads what a project SAYS about itself.
  if (deep) products.push(...(await findCommandPrograms({ root, listing, scripts: pkg?.scripts ?? {}, available, claimed: products.map((p) => p.where) })));
  if (deep) products.push(...(await findServersInCode({ root, listing, products, available })));

  const merged = mergeProducts(products);
  if (merged.length === 0) {
    unsure.push('Nothing here looks like a product this tool knows how to watch. If it is one, say so in the settings: put a "kind" under the adapter that fits, and everything else follows from that.');
  }
  const guessy = merged.filter((p) => p.confidence < 0.5).map((p) => p.name);
  if (guessy.length > 0) unsure.push(`These were guessed from weak evidence and are worth a second look: ${guessy.join(', ')}.`);
  if (!doors.read) unsure.push('The source was not read, so no routes, exported names or private channels were counted.');

  // A folder full of code that no product claimed is the most dangerous thing this file can
  // find, because everything else about the run will look complete. Terminal Deck's `relay/`
  // is exactly it: real source, no package.json, no framework, nothing to match on. Naming
  // the folder is honest and cheap; guessing what it is would be neither.
  if (deep) {
    const claimed = new Set(merged.map((p) => p.where));
    for (const folder of listing.dirs) {
      if (SKIP_DIRS.has(folder) || folder.startsWith('.') || claimed.has(folder)) continue;
      if (members.some((m) => m.root === folder)) continue;
      // Nor is a folder whose whole contents are already accounted for one level down. A
      // monorepo's `apps/` is a shelf: every product in it was found, named and is being
      // checked, and this warning would say the opposite in the plainest words on the page —
      // "nothing in it is being checked" — about the two products directly above it.
      const alreadyFound = (/** @type {string} */ p) => p.startsWith(`${folder}/`);
      if (merged.some((p) => alreadyFound(p.where)) || members.some((m) => alreadyFound(m.root))) continue;
      // The root product's own source is not an unclaimed folder. These are the folders the
      // contract channel already read, plus the ones that are never a product on their own.
      if (ALREADY_COVERED.has(folder)) continue;
      // And neither is a folder the root product simply imports from. `components/` in a
      // Next.js site holds a hundred files and is not a second product; flagging it would be
      // noise, and noise is how a real warning like `relay/` gets skimmed past. So only a
      // folder NAMED like a product, or one carrying its own container, is worth saying.
      const own = PLATFORM_FOLDERS.includes(folder) || fs.existsSync(path.join(root, folder, 'Dockerfile'));
      if (!own) continue;
      const codeFiles = await countMatching(path.join(root, folder), /\.[cm]?[jt]sx?$/);
      // Three is the line. Terminal Deck's relay is three files and it is a real running
      // service; one or two files is a helper somebody left lying about.
      if (codeFiles >= 3) {
        unsure.push(`${folder}/ holds ${codeFiles} source files and nothing here could work out what it produces, so nothing in it is being checked. If it is a product of its own, say what starts it in the settings.`);
      }
    }
  }

  for (const product of merged) evidence.push(...product.evidence);

  return {
    root,
    // The name the project GIVES ITSELF, not the folder it happens to sit in. Every
    // non-Node project was named after its folder, so a Python tool that calls itself
    // `lint-lens` was described to its owner as `pytool` throughout. Measured 2026-08-31.
    name: String(pkg?.name ?? whatItCallsItself(root).name),
    version: pkg?.version ? String(pkg.version) : null,
    isGitRepo: fs.existsSync(path.join(root, '.git')),
    products: merged,
    summary: summarise(merged, path.basename(root)),
    packageManager: manager,
    workspaces,
    members: members.map((m) => ({ name: m.name, root: m.root })),
    languages: await languagesIn(root),
    tests,
    scripts: scriptsOf(pkg?.scripts ?? {}),
    ...(await theSourceAgain({ root, readCode, merged, listing, firstFolders, first: { doors, routes, channels, envNames } })),
    bulk: await measureBulk(root),
    pages,
    containers,
    evidence: dedupeClues(evidence),
    unsure,
    durationMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Working out the products in one folder
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {string} input.root
 * @param {string} input.where              Relative folder, '.' for the project root.
 * @param {{files: string[], dirs: string[]}} input.listing
 * @param {any} input.pkg
 * @param {ProjectShape['doors']} input.doors
 * @param {ProjectShape['pages']} input.pages
 * @param {{dockerfile: string|null, compose: string|null}} input.containers
 * @param {Record<string, string>} input.scripts
 * @param {Set<string>} input.available   Adapters actually present in this copy of the tool.
 * @returns {Promise<Product[]>}
 */
async function productsIn(input) {
  const { root, where, listing, pkg, doors, pages, containers, scripts, available } = input;
  const dir = path.join(root, where);
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const has = (/** @type {string} */ name) => name in deps;
  const file = (/** @type {string} */ name) => listing.files.includes(name);
  const anyFile = (/** @type {RegExp} */ re) => listing.files.find((f) => re.test(f)) ?? null;
  const folder = (/** @type {string} */ name) => listing.dirs.includes(name);
  const at = (/** @type {string} */ rel) => (where === '.' ? rel : path.join(where, rel));

  /** @type {Product[]} */
  const found = [];

  /**
   * @param {string} kind
   * @param {object} spec
   * @param {string} spec.name
   * @param {number} spec.confidence
   * @param {string} spec.why
   * @param {Clue[]} spec.evidence
   * @param {{found: boolean, where: string|null, how: string}} [spec.built]
   * @param {string[]} [spec.blockers]
   * @param {Record<string, any>} [spec.suggest]
   * @param {Router} [spec.router]
   * @param {string} [spec.startNote]
   * @param {{language: string, reads: string|null}} [spec.sourceBlind]
   */
  const add = (kind, spec) => {
    const meta = PRODUCT_KINDS[kind];
    found.push({
      kind,
      name: spec.name,
      sourceBlind: spec.sourceBlind,
      surface: meta.surface,
      adapter: meta.adapter && available.has(meta.adapter) ? meta.adapter : null,
      confidence: spec.confidence,
      why: spec.why,
      where,
      evidence: spec.evidence,
      built: spec.built ?? { found: false, where: null, how: 'nothing to build — it runs from source' },
      blockers: spec.blockers ?? [],
      suggest: spec.suggest,
      router: spec.router,
      startNote: spec.startNote,
    });
  };

  // ── Electron ──────────────────────────────────────────────────────────────
  const builderFile = anyFile(/^electron-builder\.(ya?ml|json|js|cjs|ts)$/) ?? anyFile(/^forge\.config\.(js|cjs|mjs|ts)$/);
  const electronish = has('electron') || Boolean(builderFile) || Boolean(pkg?.build?.appId);
  if (electronish) {
    const app = await findBuiltApp(dir);
    /** @type {Clue[]} */
    const clues = [];
    if (has('electron')) clues.push({ where: at('package.json'), means: 'It depends on Electron, which is how desktop apps are built out of web code.' });
    if (builderFile) clues.push({ where: at(builderFile), means: 'There is a packaging config, so this repository produces an installable desktop app.' });
    // The application id lives in package.json in one project and in the packaging config in
    // the next, and Terminal Deck is the second kind — reading only the first said 'no id
    // here' about a repository whose id is on line one of electron-builder.yml.
    const appId = typeof pkg?.build?.appId === 'string' ? String(pkg.build.appId) : appIdInConfig(dir, builderFile);
    if (appId) clues.push({ where: at(typeof pkg?.build?.appId === 'string' ? 'package.json' : String(builderFile)), means: `It has an application id (${appId}), which only a packaged desktop app has.` });
    if (app.where) clues.push({ where: path.relative(root, app.where), means: 'A built desktop app is sitting here already, so it can be opened and read straight away.' });
    add('electron', {
      name: 'the desktop app',
      confidence: app.where ? 1 : 0.85,
      why: app.where ? `It depends on Electron and a built app is already sitting at ${path.relative(root, app.where)}.` : 'It depends on Electron, so it produces a desktop app — but no built copy was found, so there is nothing to open yet.',
      evidence: clues,
      built: { found: Boolean(app.where), where: app.where ? path.relative(root, app.where) : null, how: app.how },
      blockers: app.where ? [] : ['The app has not been built. A desktop app can only be checked once there is a built copy to open — build it the way you normally do, then point the settings at the result.'],
      // The application id goes in beside the binary when the manifest carries one. The
      // adapter uses it to find the window it opened rather than any other window of the same
      // app that was already on screen, and it is written in package.json already — asking
      // somebody for a value that is sitting in their own manifest is the exact shape of
      // question this command exists to stop asking.
      suggest: {
        ...(app.where ? { binary: path.relative(root, app.where) } : {}),
        ...(appId ? { appId } : {}),
      },
    });
  }

  // ── iOS ───────────────────────────────────────────────────────────────────
  const xcode = listing.dirs.find((d) => d.endsWith('.xcodeproj')) ?? listing.dirs.find((d) => d.endsWith('.xcworkspace')) ?? null;
  const swiftPackage = file('Package.swift');
  const podfile = file('Podfile');
  // An `.xcodeproj` is very often NOT committed. It is the one file in an Xcode repository no
  // two people can edit at once — it carries a random identity per file and settles conflicts
  // by corrupting itself — so a great many projects generate it from an XcodeGen spec and keep
  // only the spec in git. Terminal Deck does exactly that, and the effect was that the iPhone
  // app existed on the machine it was last built on and vanished from every fresh clone: three
  // products found where there are five, and no word said about the missing two.
  const xcodegen = isXcodeGenSpec(dir, listing);
  // React Native and Expo are one codebase that becomes two apps. Both are reported, because
  // reporting one would leave the other silently unchecked.
  const reactNative = has('react-native') || has('expo');
  if (xcode || (swiftPackage && (podfile || folder('Sources'))) || (podfile && !xcode) || xcodegen || reactNative) {
    /** @type {Clue[]} */
    const clues = [];
    if (xcode) clues.push({ where: at(xcode), means: 'An Xcode project, which is how an Apple app is built.' });
    if (swiftPackage) clues.push({ where: at('Package.swift'), means: 'Swift source organised as a package.' });
    if (podfile) clues.push({ where: at('Podfile'), means: 'CocoaPods dependencies, which are used by iOS apps.' });
    if (xcodegen) clues.push({ where: at('project.yml'), means: 'An XcodeGen spec. The Xcode project itself is generated from this and is usually not committed, which is why looking only for an .xcodeproj misses the app entirely on a fresh clone.' });
    if (reactNative) clues.push({ where: at('package.json'), means: 'It depends on React Native, so one codebase becomes both an iPhone app and an Android app.' });
    const ipa = await findFirst(dir, /\.(ipa|app)$/, ['build', 'DerivedData', 'Products']);
    add('ios', {
      name: 'the iPhone app',
      confidence: xcode ? 1 : xcodegen ? 0.95 : reactNative ? 0.8 : 0.6,
      why: xcode ? `There is an Xcode project at ${at(xcode)}.` : xcodegen ? `${at('project.yml')} is an XcodeGen spec, so the Xcode project is generated from it rather than committed.` : reactNative ? 'It depends on React Native, which builds an iPhone app.' : 'There is Swift and iOS tooling here, though no Xcode project was found in the usual place.',
      evidence: clues,
      built: { found: Boolean(ipa), where: ipa ? path.relative(root, ipa) : null, how: ipa ? 'a built app was found' : 'nothing built was found' },
      // Only a folder ending .app is worth naming: the simulator installs a bundle, and an
      // .ipa is a signed archive for a real phone, which is the one thing that can never be
      // driven two builds at a time anyway.
      suggest: {
        ...(ipa && ipa.endsWith('.app') ? { app: path.relative(root, ipa) } : {}),
        // The scheme, which is the one word `xcodebuild` cannot be run without. It is written
        // in the project name — in the XcodeGen spec where there is one, in the .xcodeproj's
        // own name otherwise — so handing somebody a command with a blank in it, for a value
        // sitting in their own repository, would be exactly the kind of asking this command
        // exists to stop.
        ...(schemeName(dir, listing, xcode) ? { scheme: schemeName(dir, listing, xcode) } : {}),
      },
      blockers: available.has('ios')
        ? ['It runs on the simulator. Two builds on a real phone in your hand can never be compared side by side, on any machine.']
        : ['Nothing in this copy of the tool can drive an iPhone app yet. When it can, it will run on the simulator; two builds on a real phone in your hand can never be compared side by side.'],
    });
  }

  // ── Android ───────────────────────────────────────────────────────────────
  const gradle = anyFile(/^build\.gradle(\.kts)?$/);
  const gradlew = file('gradlew');
  const manifest = folder('app') && fs.existsSync(path.join(dir, 'app', 'src', 'main', 'AndroidManifest.xml'));
  if ((gradle && gradlew) || manifest || reactNative) {
    /** @type {Clue[]} */
    const clues = [];
    if (gradle) clues.push({ where: at(gradle), means: 'A Gradle build, which is how an Android app is built.' });
    if (manifest) clues.push({ where: at('app/src/main/AndroidManifest.xml'), means: 'An Android manifest, which only an Android app has.' });
    if (reactNative) clues.push({ where: at('package.json'), means: 'It depends on React Native, so the same codebase also becomes an Android app.' });
    const apk = await findFirst(dir, /\.(apk|aab)$/, ['build', 'app']);
    add('android', {
      name: 'the Android app',
      confidence: manifest ? 1 : gradle && gradlew ? 0.8 : 0.7,
      why: manifest ? 'There is an Android manifest and a Gradle build here.' : gradle && gradlew ? 'There is a Gradle build with a wrapper script, which is the shape of an Android project.' : 'It depends on React Native, which builds an Android app.',
      evidence: clues,
      built: { found: Boolean(apk), where: apk ? path.relative(root, apk) : null, how: apk ? 'a built package was found' : 'nothing built was found' },
      // The command that would build one, carried out of here rather than worked out later.
      // Without it init could see that nothing was built and still had nothing to hand
      // anybody — so it said nothing at all, and an Android app with no APK anywhere read as
      // covered in full right up until the check said there was nothing to walk.
      suggest: {
        ...(apk ? { apk: path.relative(root, apk) } : {}),
        ...(gradlew || gradle ? { buildWith: `${gradlew ? './gradlew' : 'gradle'} ${folder('app') ? ':app:assembleDebug' : 'assembleDebug'}` } : {}),
      },
      blockers: available.has('android')
        ? ['It runs on an emulator. A snapshot restore was measured on 2026-08-31 and repeats — 301 of 309 addresses agreed across five pairs, and the eight that moved were the app\'s own identity code — so a paired run is offered. It needs a kept copy of the old build\'s APK ("reference" under "android"), because a checkout of the old commit contains no build output.']
        : ['Nothing in this copy of the tool can drive an Android app yet. When it can, it will run on an emulator against the stored record.'],
    });
  }

  // ── Native desktop that is not Electron ───────────────────────────────────
  if (folder('src-tauri') || (file('Cargo.toml') && folder('src-tauri'))) {
    // Whether a build is sitting there is a fact, and it was never looked for — so the answer
    // defaulted to "nothing to build, it runs from source", which is untrue of a native app
    // and left init with no reason to ask for one.
    const builtHere = await findBuiltApp(dir);
    add('desktopNative', {
      name: 'the Tauri desktop app',
      confidence: 0.9,
      why: 'There is a src-tauri folder, which is how a Tauri desktop app is built.',
      built: builtHere?.where
        ? { found: true, where: path.relative(root, builtHere.where), how: builtHere.how }
        : { found: false, where: null, how: 'nothing built was found' },
      evidence: [{ where: at('src-tauri'), means: 'Tauri wraps a web front end in a native window, so the window is not an Electron one.' }],
      blockers: available.has('windows')
        ? ['A native window can only be read from the operating system it runs on, so this needs a machine running that system — a reachable SSH host counts.']
        : ['A native desktop window can only be read from the operating system it runs on, and nothing in this copy of the tool drives one yet.'],
    });
  }

  // ── Web ───────────────────────────────────────────────────────────────────
  // Two tiers, because they are two different strengths of evidence. The first list only
  // ever builds websites, so finding one settles the question. The second is a rendering
  // library that turns up inside desktop apps and phone apps just as often, so on its own it
  // is a hint and the confidence says so.
  const onlyBuildsWebsites = ['next', 'nuxt', 'astro', '@remix-run/react', '@sveltejs/kit', 'gatsby', '11ty', '@11ty/eleventy'].find(has) ?? null;
  const webFramework = onlyBuildsWebsites ?? (['vue', 'svelte', 'solid-js', 'preact', 'react'].find(has) ?? null);
  const bundler = ['vite', 'webpack', 'parcel', 'esbuild', 'rollup', '@rsbuild/core'].find(has) ?? null;
  const indexHtml = file('index.html') || fs.existsSync(path.join(dir, 'public', 'index.html'));
  const hostConfig = anyFile(/^(vercel|netlify|firebase|now|wrangler)\.(json|toml)$/);
  // A folder that only ever exists because a framework routes out of it. `src/routes` is
  // SvelteKit's, `src/pages` is Astro's, `app/routes` is Remix's — and on 2026-08-31 none of
  // the three was on this list, so a project that had one but did not name its framework in
  // package.json was not read as a website at all.
  const routeFolders = folder('pages')
    || fs.existsSync(path.join(dir, 'src', 'routes'))
    || fs.existsSync(path.join(dir, 'src', 'pages'))
    || fs.existsSync(path.join(dir, 'app', 'routes'))
    || (folder('app') && (fs.existsSync(path.join(dir, 'app', 'page.tsx')) || fs.existsSync(path.join(dir, 'app', 'page.jsx')) || fs.existsSync(path.join(dir, 'app', 'layout.tsx'))));
  const webish = Boolean(webFramework) || indexHtml || Boolean(hostConfig) || routeFolders || pages.length > 0;
  if (webish) {
    /** @type {Clue[]} */
    const clues = [];
    if (webFramework) clues.push({ where: at('package.json'), means: `It depends on ${webFramework}, which builds web pages.` });
    if (bundler) clues.push({ where: at('package.json'), means: `It is bundled with ${bundler}, so there is a build step and usually a dev server.` });
    if (indexHtml) clues.push({ where: at(file('index.html') ? 'index.html' : 'public/index.html'), means: 'There is a page to open.' });
    if (hostConfig) clues.push({ where: at(hostConfig), means: 'It is configured for a hosting service, so it is deployed as a site.' });
    if (pages.length > 0) clues.push({ where: 'the page folders', means: `${pages.length} page address${pages.length === 1 ? '' : 'es'} were read out of folder names.` });

    // An Electron repository almost always has web code in it — that IS the window. Calling
    // the window a second, separate website is how one product gets checked twice and the
    // report doubles in size for nothing. So it only counts as a website of its own when it
    // has its own pages, its own host config, or its own package.
    const isTheElectronWindow = electronish && where === '.' && !hostConfig && pages.length === 0;
    if (!isTheElectronWindow) {
      // How to boot it. Build-then-serve wherever there is a way to, and the development
      // server only when there is not — see {@link startCommandFor} for why that order and
      // not the other one.
      const booting = startCommandFor({ scripts, has, dir, listing });
      const start = booting.command ? inFolder(booting.command, where) : null;
      // A site made of plain .html files has no framework and no dev server, and every one
      // of those files is a page somebody can open. Listing them is what turns "there is a
      // website here" into journeys that can actually be walked.
      const flat = listing.files.filter((f) => f.endsWith('.html')).map((f) => (f === 'index.html' ? '/' : `/${f}`));
      if (flat.length > 1) clues.push({ where: at('*.html'), means: `${flat.length} pages are plain HTML files sitting in this folder.` });

      // Where the screens come from, and this one call is the difference between a site being
      // walked and a site being glanced at. It asks the folder layout first, the router next,
      // and the strip of tabs last — see {@link readScreens}. The pages `readPageRoutes`
      // already found are handed in so they are not listed a second time: they are already
      // turned into journeys by the web adapter, and listing them again would walk every page
      // of a Next.js site twice.
      const reading = fromHere(await readScreens(dir, has, pages.map((page) => page.url)), where);
      /** @type {Screen[]} */
      const screens = flat.length > 1
        ? flat.map((url) => ({ name: url === '/' ? 'the front page' : url, url }))
        : reading.screens;
      // The sentence that says WHERE the screen list came from is evidence in its own right,
      // and the folder-layout reading was the one kind missing from this list — so a
      // SvelteKit site's addresses were found and then never explained to anybody.
      if (reading.router.where) {
        clues.push({ where: at(reading.router.where), means: reading.router.why });
      }

      add('web', {
        name: where === '.' ? 'the website' : `the website in ${where}/`,
        confidence: onlyBuildsWebsites || ((webFramework || indexHtml) && (bundler || hostConfig || pages.length > 0)) ? 0.95 : 0.6,
        why: [
          webFramework ? `It uses ${webFramework}` : 'There is a page here',
          pages.length > 0 ? ` and ${pages.length} page address${pages.length === 1 ? '' : 'es'} were read out of the folder names` : '',
          pages.length === 0 && screens.length > 0 ? ` and ${screens.length} screen${screens.length === 1 ? '' : 's'} were read out of ${reading.router.kind === 'tabs' ? 'the strip of tabs that switches between them' : reading.router.kind === 'files' ? 'the folder names' : 'its router'}` : '',
          // An address nobody can open yet belongs in the FIRST sentence about this product,
          // not only in the ledger further down. A summary that counts what was found and
          // stays quiet about what cannot be reached is how "covers the website in full"
          // ended up printed over a site with two unopened pages on 2026-08-31.
          reading.needValues.length > 0 ? ` and ${reading.needValues.length} more ${reading.needValues.length === 1 ? 'address is' : 'addresses are'} waiting on a real value before ${reading.needValues.length === 1 ? 'it' : 'they'} can be opened at all` : '',
          flat.length > 1 && pages.length === 0 ? ` and ${flat.length} more are plain HTML files` : '',
          hostConfig ? `, it is set up to deploy to ${hostConfig.split('.')[0]}` : '',
          start ? `, and \`${start}\` starts it` : '',
        ].join('') + '.',
        evidence: clues,
        // A site of plain .html files is the one case the screen reading has nothing to say
        // about: there is no framework, no router and no route folder, only files. Everywhere
        // else `reading.router` is kept, because it names the file it came from and says how
        // many addresses are waiting on a value — and that sentence is copied straight into
        // the settings. Overwriting it with a fixed line, which is what happened until
        // 2026-08-31, threw away the only place a person was told what was NOT being opened.
        router: flat.length > 1 && reading.router.kind !== 'files'
          ? { kind: 'files', where: null, why: 'Every page here is a file with an address of its own, so each one is opened directly.' }
          : reading.router,
        startNote: booting.why,
        blockers: start
          ? []
          : ['There is no command that starts it, so each build cannot be booted on its own. Without that, both halves of a comparison would read the same running copy and prove nothing. A static site only needs a static file server — anything that serves this folder on the PORT it is given will do.'],
        suggest: {
          ...(start ? { start } : {}),
          ...(screens.length > 0 ? { screens } : {}),
          ...(reading.needValues.length > 0 ? { screensNeedingValues: reading.needValues } : {}),
        },
      });
    }
  }

  // ── Server ────────────────────────────────────────────────────────────────
  const serverFramework = ['express', 'fastify', 'hono', 'koa', '@hapi/hapi', '@nestjs/core', 'polka', 'restify'].find(has) ?? null;
  // A hand-written server declares itself nowhere but in its own code, so the code is asked.
  // Without this, a repository that answers requests all day was read as making only the one
  // command in its package.json, and its whole HTTP surface went unwatched in silence.
  const handWritten = serverFramework ? { yes: false, file: null, readsPort: false } : await handWrittenServerIn(dir);
  const serverish = Boolean(serverFramework) || doors.route > 0 || handWritten.yes || Boolean(containers.dockerfile && scripts.start);
  if (serverish) {
    /** @type {Clue[]} */
    const clues = [];
    if (serverFramework) clues.push({ where: at('package.json'), means: `It depends on ${serverFramework}, which serves requests.` });
    if (doors.route > 0) clues.push({ where: 'the source', means: `${doors.route} route${doors.route === 1 ? '' : 's'} are declared in the code.` });
    if (handWritten.yes && handWritten.file) clues.push({ where: at(handWritten.file), means: 'It opens an HTTP server on node\'s own http module and starts listening, with no framework under it.' });
    if (containers.dockerfile) clues.push({ where: containers.dockerfile, means: 'It ships as a container, so there is a known way to start it.' });
    // Next.js and its cousins are a website first. Their API routes are real and worth
    // checking, but calling the whole thing "a server" as well as "a website" would report
    // one product twice.
    const alreadyAWebsite = found.some((p) => p.kind === 'web') && !serverFramework;
    // With no `start` script the entry file is the next best thing, and it is a real answer
    // rather than a guess: it is the file that was just proven to open the socket. Leaving
    // the start command empty because package.json was silent is how a server that IS
    // checkable ends up listed as one nothing can walk.
    const startsWith = scripts.start
      ? inFolder(npmRun(scripts, scripts.start), where)
      : handWritten.file ? inFolder(`node ${handWritten.file}`, where) : null;
    if (!alreadyAWebsite) {
      add('server', {
        name: where === '.' ? 'the server' : `the server in ${where}/`,
        confidence: serverFramework ? 0.9 : handWritten.yes ? 0.8 : doors.route > 3 ? 0.6 : 0.4,
        why: serverFramework
          ? `It uses ${serverFramework} and ${doors.route} route${doors.route === 1 ? '' : 's'} are written in the code.`
          : handWritten.yes
            ? `${handWritten.file} opens an HTTP server by hand and listens on it, and ${doors.route} route${doors.route === 1 ? '' : 's'} could be read out of the code.`
            : `${doors.route} route${doors.route === 1 ? '' : 's'} are written in the code, though no web framework is installed.`,
        evidence: clues,
        blockers: [
          ...(startsWith ? [] : ['There is no command that starts it. The routes can be listed from the source without one, but none of them can be walked.']),
          ...(handWritten.yes && !handWritten.readsPort ? [`${handWritten.file} names its port itself rather than taking one out of the environment. Two builds cannot be booted side by side on one port, so make it read PORT before this can be walked.`] : []),
        ],
        startNote: !scripts.start && startsWith ? `package.json names no start script, so this is the file that was found opening the socket: ${handWritten.file}.` : undefined,
        suggest: {
          ...(startsWith ? { start: startsWith } : {}),
          // Whether this server keeps anything. Both builds have to see the same rows, so a
          // server with a database needs a command that puts the data back — and a server
          // with NO database needs no such command, and must not be asked for one. Asking is
          // how a set-up list grows a line nobody can ever tick off.
          stateless: !keepsData(deps, containers),
        },
      });
    }
  }

  // ── Command-line tool ─────────────────────────────────────────────────────
  const bins = pkg?.bin ? (typeof pkg.bin === 'string' ? [String(pkg.name ?? 'the command')] : Object.keys(pkg.bin)) : [];
  if (bins.length > 0) {
    add('cli', {
      name: bins.length === 1 ? `the \`${bins[0]}\` command` : `${bins.length} command-line tools`,
      confidence: 1,
      why: `package.json installs ${bins.length === 1 ? `a command called \`${bins[0]}\`` : `${bins.length} commands: ${bins.join(', ')}`}.`,
      evidence: [{ where: at('package.json'), means: 'The "bin" field is what makes a package installable as a command you can type.' }],
      // `--help` and nothing else, deliberately. A command in package.json could deploy, could
      // publish, could wipe a database — running one because it was there would be the tool
      // causing the very kind of damage it exists to catch. Asking a command to describe
      // itself is the one thing every command-line tool does safely.
      suggest: { commands: bins.map((name) => ({ name: `${name} --help`, run: `${runnerFor(pkg, name)} --help`, describe: `ask ${name} to print its help, and compare every word of it` })) },
    });
  }

  // ── Library ───────────────────────────────────────────────────────────────
  // A package can be both. `staysfixed` itself installs a command AND publishes an entry
  // other code imports, and checking only the command would leave every exported name
  // unwatched — which is the whole `library` surface, gone quietly.
  const publishes = Boolean(pkg?.exports || pkg?.main || pkg?.module) && pkg?.private !== true;
  const declaresAnEntry = Boolean(pkg?.exports);
  if (publishes && (bins.length === 0 || declaresAnEntry) && !electronish && !webish) {
    const entry = entryPointOf(pkg);
    add('library', {
      name: 'the library other code imports',
      confidence: declaresAnEntry ? 0.85 : 0.5,
      why: declaresAnEntry ? 'It publishes an "exports" map, which is what other code imports.' : 'It has a main entry point and is not marked private, so other code can import it.',
      evidence: [{ where: at('package.json'), means: `Other projects import it, entering at ${entry}.` }],
      suggest: { imports: [{ name: 'the package entry', module: entry }] },
    });
  }

  // ── A product in a language nothing here READS ────────────────────────────
  // Reading it and driving it are two different questions, and answering the second with the
  // first is what made this tool turn away every Flask app it ever met. It can boot one and
  // it can run one; it just cannot read one. So the surfaces it CAN reach are offered, and
  // the one it cannot is carried on the product by name so nothing downstream can quietly
  // report a half-covered product as covered.
  const foreign = await foreignProjectIn(dir, listing);
  if (foreign) {
    // Python is the one whose addresses ARE read, so its server is half-sighted rather than
    // blind and has to say which half. Every other language here is read not at all.
    const readsAddresses = foreign.language === 'Python' && foreign.routes > 0;
    /** @param {boolean} server */
    const blindly = (server) => ({
      language: foreign.language,
      reads: server && readsAddresses ? 'the addresses it answers on, and nothing else' : null,
    });
    if (foreign.start) {
      add('server', {
        name: where === '.' ? `the ${foreign.language} server` : `the ${foreign.language} server in ${where}/`,
        confidence: 0.75,
        why: foreign.routes > 0
          ? `It serves requests with ${foreign.framework}, and ${foreign.routes} address${foreign.routes === 1 ? '' : 'es'} were read out of its own source.`
          : `${foreign.startWhy} Nothing here reads ${foreign.language} source, so its addresses are not known and only the boot itself is watched.`,
        evidence: foreign.evidence,
        sourceBlind: blindly(true),
        startNote: foreign.startWhy,
        blockers: foreign.readsPort ? [] : [`It names its own port rather than taking one out of the environment, so two builds cannot be booted side by side. Make it read PORT before this can be walked.`],
        suggest: { start: inFolder(foreign.start, where), stateless: !keepsData(deps, containers) },
      });
    }
    if (foreign.commands.length > 0) {
      add('cli', {
        name: foreign.commands.length === 1 ? `the \`${foreign.commands[0].name.replace(/ --help$/, '')}\` command` : `${foreign.commands.length} ${foreign.language} commands`,
        confidence: 0.7,
        why: `${foreign.language} commands were found that can be typed and asked to describe themselves, and running one needs no ${foreign.language} read at all.`,
        evidence: foreign.evidence,
        sourceBlind: blindly(false),
        suggest: { commands: foreign.commands },
      });
    }
  }

  // ── Something real that nothing here can drive ────────────────────────────
  const otherLanguage = file('Cargo.toml') ? 'Rust' : file('go.mod') ? 'Go' : file('pubspec.yaml') ? 'Flutter' : file('pyproject.toml') || file('requirements.txt') ? 'Python' : file('Gemfile') ? 'Ruby' : file('composer.json') ? 'PHP' : null;
  if (otherLanguage && found.length === 0) {
    add('other', {
      name: `a ${otherLanguage} project`,
      confidence: 0.8,
      why: `${otherLanguage} project files are here, and no adapter in this tool can drive ${otherLanguage} yet.`,
      evidence: [{ where: at(file('Cargo.toml') ? 'Cargo.toml' : file('go.mod') ? 'go.mod' : file('pubspec.yaml') ? 'pubspec.yaml' : file('Gemfile') ? 'Gemfile' : file('composer.json') ? 'composer.json' : 'pyproject.toml'), means: `This is how a ${otherLanguage} project declares itself.` }],
      blockers: [`Nothing drives ${otherLanguage} directly. If it produces a command you can type, list it under "process" in the settings and the whole command-line half of this tool works on it today.`],
    });
  }

  return found;
}

// ---------------------------------------------------------------------------
// Reading the repository
// ---------------------------------------------------------------------------

/**
 * One directory listing, split into files and folders, read once and passed around.
 * @param {string} dir
 * @returns {Promise<{files: string[], dirs: string[]}>}
 */
async function listOnce(dir) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { files: [], dirs: [] };
  }
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const dirs = [];
  for (const entry of entries) {
    if (entry.isDirectory()) dirs.push(entry.name);
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(entry.name);
  }
  files.sort();
  dirs.sort();
  return { files, dirs };
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
 * Which package manager installs this project, from the lockfile that is actually there.
 * The lockfile is the truth: a `packageManager` field says what somebody INTENDED, and a
 * lockfile says what happened.
 *
 * @param {{files: string[], dirs: string[]}} listing
 * @param {any} pkg
 * @returns {{name: string, lockfile: string|null, why: string}}
 */
function packageManagerOf(listing, pkg) {
  /** @type {[string, string][]} */
  const known = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
  ];
  for (const [lockfile, name] of known) {
    if (listing.files.includes(lockfile)) return { name, lockfile, why: `${lockfile} is here, so this project is installed with ${name}.` };
  }
  const declared = typeof pkg?.packageManager === 'string' ? String(pkg.packageManager).split('@')[0] : null;
  if (declared) return { name: declared, lockfile: null, why: `package.json asks for ${declared}, though no lockfile was found.` };
  return { name: 'npm', lockfile: null, why: 'No lockfile was found, so npm is assumed.' };
}

/**
 * Workspace globs, from either of the two places they live.
 * @param {any} pkg
 * @param {{files: string[], dirs: string[]}} listing
 * @param {string} root
 * @returns {string[]}
 */
function workspaceGlobsOf(pkg, listing, root) {
  /** @type {string[]} */
  const globs = [];
  const declared = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
  if (Array.isArray(declared)) globs.push(...declared.map(String));
  if (listing.files.includes('pnpm-workspace.yaml')) {
    try {
      const text = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
      for (const line of text.split('\n')) {
        const found = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line);
        if (found) globs.push(found[1].trim());
      }
    } catch {
      // An unreadable workspace file is not worth an error; the folder scan finds the
      // members anyway, and finding them twice is harmless.
    }
  }
  return [...new Set(globs)].filter(Boolean);
}

/**
 * The sub-packages that really exist, from the workspace globs and from a plain look at the
 * usual folders. Only the one level of glob everybody actually uses is expanded — `packages/*`
 * and `apps/*` — because implementing a glob engine to find a folder that is right there
 * would be a lot of code to answer a question `readdir` answers.
 *
 * @param {string} root
 * @param {string[]} globs
 * @param {{files: string[], dirs: string[]}} listing
 * @returns {Promise<{name: string, root: string, pkg: any}[]>}
 */
async function findMembers(root, globs, listing) {
  /** @type {Set<string>} */
  const folders = new Set();
  for (const glob of globs) {
    if (glob.endsWith('/*') || glob.endsWith('/**')) {
      const parent = glob.replace(/\/\*+$/, '');
      const inner = await listOnce(path.join(root, parent));
      // `${parent}/${dir}`, not path.join. This is a repository-relative ADDRESS: it comes
      // out of the workspace globs written with forward slashes, is compared against things
      // like `apps/` further down, is stored in the record and is shown to people. On Windows
      // path.join gave it a backslash, so a product under `packages/api` was not found at all
      // and `apps/` was reported as code nobody was checking while every package inside it
      // was being checked. Measured on a real Windows 11 machine, 2026-08-31.
      for (const dir of inner.dirs) folders.add(`${parent}/${dir}`);
    } else if (!glob.includes('*')) {
      folders.add(glob);
    }
  }
  // A repository can hold a second package without ever declaring a workspace — Terminal
  // Deck's web client is exactly that. One level of readdir finds it, and missing it would
  // mean reporting a repository as one product when it makes two.
  for (const dir of listing.dirs) {
    if (SKIP_DIRS.has(dir) || dir.startsWith('.')) continue;
    folders.add(dir);
  }

  /** @type {{name: string, root: string, pkg: any}[]} */
  const members = [];
  for (const folder of [...folders].sort()) {
    const pkg = await readJson(path.join(root, folder, 'package.json'));
    if (!pkg) continue;
    members.push({ name: String(pkg.name ?? folder), root: folder, pkg });
  }
  return members;
}

/**
 * The doors that are the ROOT'S, once the ones belonging to sub-packages are handed back.
 *
 * The source is read once, from the top, which is what keeps this fast — but the routes it
 * comes back with are the whole repository's, and the root is then judged on them. In a
 * workspaces monorepo that made the root itself "the server", off the strength of routes
 * written in `packages/api`: a shelf holding two packages, reported as a third product that
 * ships nothing. `packages/api` was already in the list, correctly, one line above it.
 *
 * Only a clean sweep counts. The moment ONE route was read outside every member, the root has
 * routes of its own and keeps the full count — losing a real server is far worse than listing
 * a doubtful one, so the doubt goes that way. The route list is capped at 200 names, so this
 * is a sample rather than a census on a repository with more than that; a root with routes of
 * its own would have to contribute none of the first 200 to be missed, and its framework
 * dependency or its own `server.js` says it is a server anyway.
 *
 * @param {ProjectShape['doors']} doors
 * @param {ProjectShape['routes']} routes
 * @param {{name: string, root: string}[]} members
 * @returns {ProjectShape['doors']}
 */
function theRootsOwnDoors(doors, routes, members) {
  if (members.length === 0 || routes.length === 0 || doors.route === 0) return doors;
  const slashed = (/** @type {string} */ p) => p.split(path.sep).join('/');
  const theirs = members.map((m) => slashed(m.root));
  const inAMember = (/** @type {string} */ file) =>
    theirs.some((their) => slashed(file).startsWith(`${their}/`));
  if (!routes.every((one) => inAMember(one.file))) return doors;
  return { ...doors, route: 0 };
}

/**
 * Does the project keep code of its own at the top level, outside every folder below it?
 *
 * A repository whose whole server is one `server.js` beside `package.json` is completely
 * normal, and it is the shape this file used to go blind on the moment somebody added a
 * `src/` folder for something else.
 *
 * Only files that are the PRODUCT count. A build config, a declaration file and a test all
 * sit at the top level of nearly every repository, and treating any of them as "the project
 * keeps code up here" would make this true everywhere and so worth nothing.
 *
 * @param {{files: string[], dirs: string[]}} listing
 * @returns {boolean}
 */
function rootHoldsItsOwnCode(listing) {
  return listing.files.some((name) => {
    if (!/\.[cm]?[jt]sx?$/.test(name)) return false;
    if (name.startsWith('.')) return false;
    if (/\.d\.[cm]?ts$/.test(name)) return false;              // a declaration describes, it opens nothing
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) return false;
    if (/\.(config|conf)\.[cm]?[jt]sx?$/.test(name)) return false;
    return !ROOT_TOOLING_FILES.has(name.toLowerCase());
  });
}

/**
 * Which folders to hand the source reader.
 *
 * THE FAILURE THIS EXISTS TO STOP, and it is the worst kind this tool has. The reader is
 * pointed at a list of folders, and it reads THOSE and nothing else. So a project with its
 * server in `server.js` at the top level and a `src/` folder holding anything at all had its
 * server never opened: four routes read as zero, and every later question about them answered
 * "nothing that worked has changed". A deleted route and a route that started returning 500
 * both came back clean, exit 0. Measured on a four-route express server: 4 routes with no
 * `src/` folder, 0 routes the moment an unrelated `src/` folder existed beside it.
 *
 * The reader can only be aimed at folders, never at single files, and the top-level files sit
 * outside every folder there is. So when the project keeps code up there, the answer is the
 * whole project — which is exactly what the reader already does for a project that has no
 * `src/` at all. The two cases now behave the same way instead of one of them going silent.
 *
 * The cost of that is a wider read: an `examples/` folder gets opened too, and a route written
 * in an example is counted. That is the right direction to be wrong in. An extra route makes a
 * check ask for an address that answers 404 both times, which changes nothing and alarms
 * nobody; a MISSING route makes the tool say "nothing that worked has changed" about a product
 * whose orders endpoint has gone. Aiming the reader at single files would fix both, and that
 * lives in `collectFiles` in the source adapter rather than here.
 *
 * @param {{files: string[], dirs: string[]}} listing
 * @returns {string[]}   Folders to read. Empty means the reader falls back to the whole
 *                       project, which is its own long-standing behaviour.
 */
function whereTheCodeIs(listing) {
  if (rootHoldsItsOwnCode(listing)) return ['.'];
  return USUAL_SOURCE_FOLDERS.filter((name) => listing.dirs.includes(name));
}

/**
 * Every door in the source, counted AND named, using the same reader the contract channel
 * uses so the number here and the number in a check can never disagree.
 *
 * @param {string} root
 * @param {string[]} [folders]   Which folders to read. Left out, the reader uses its own usual
 *                               list, which is right for a repository that makes one thing and
 *                               misses whole products in one that makes several.
 * @returns {Promise<{doors: ProjectShape['doors'], routes: ProjectShape['routes'], channels: ProjectShape['channels'], envNames: ProjectShape['envNames']}>}
 */
async function readTheSource(root, folders) {
  try {
    const { readContract, readFileRoutes, readPackageCommands } = await import('./adapters/source.js');
    const reading = await readContract({ root, folders });
    const fileRoutes = await readFileRoutes(root);
    const commands = await readPackageCommands(root);
    const doors = [...reading.doors, ...fileRoutes.doors, ...commands];
    /** @type {Record<string, number>} */
    const counts = {};
    for (const door of doors) counts[door.kind] = (counts[door.kind] ?? 0) + 1;

    // The route names, capped: a settings file listing five thousand routes helps nobody, and
    // the count above is the honest total either way.
    /** @type {Map<string, {name: string, method: string, file: string}>} */
    const routes = new Map();
    for (const door of doors) {
      if (door.kind !== 'route') continue;
      const method = door.detail === 'MOUNT' || door.detail === 'ANY' ? 'GET' : door.detail;
      const key = `${method} ${door.name}`;
      if (!routes.has(key)) routes.set(key, { name: door.name, method, file: door.file });
      if (routes.size >= 200) break;
    }

    // The private channels, by name, and whether each one hands a value back. Kept because
    // the count alone cannot answer the only question worth asking about them — which ones
    // are safe to knock on — and because a settings file that lists them saves somebody
    // reading four hundred and fifty registrations by hand.
    /** @type {Map<string, {name: string, answers: boolean, file: string}>} */
    const channels = new Map();
    for (const door of doors) {
      if (door.kind !== 'ipc' || !door.named || door.inTest) continue;
      if (channels.has(door.name)) continue;
      channels.set(door.name, { name: door.name, answers: door.detail.startsWith('answers'), file: door.file });
      if (channels.size >= 800) break;
    }

    // Every setting the code reads out of the environment. This is what stops the set-up list
    // asking for a variable that does not exist: a name nobody can find is a line nobody can
    // ever tick off, and it makes every other line on the list less believable.
    /** @type {Set<string>} */
    const envNames = new Set();
    for (const door of doors) {
      if (door.kind !== 'env' || !door.named) continue;
      envNames.add(door.name);
      if (envNames.size >= 400) break;
    }

    return {
      channels: [...channels.values()],
      envNames: [...envNames].sort(),
      doors: {
        ipc: counts.ipc ?? 0,
        route: counts.route ?? 0,
        export: counts.export ?? 0,
        command: counts.command ?? 0,
        env: counts.env ?? 0,
        unnamed: reading.report.unnamed,
        filesRead: reading.report.filesRead,
        read: true,
        why: reading.report.filesRead === 1
          ? '1 source file was read without running it.'
          : `${reading.report.filesRead} source files were read without running any of them.`,
      },
      routes: [...routes.values()],
    };
  } catch (error) {
    return {
      doors: { ...notRead(), why: `The source could not be read: ${error instanceof Error ? error.message : String(error)}` },
      routes: [],
      channels: [],
      envNames: [],
    };
  }
}

/** @returns {ProjectShape['doors']} */
function notRead() {
  return { ipc: 0, route: 0, export: 0, command: 0, env: 0, unnamed: 0, filesRead: 0, read: false, why: 'The source was not read.' };
}

/**
 * The page addresses a framework builds out of folder names, which no amount of reading
 * calls will ever find.
 *
 * @param {string} root
 * @returns {Promise<ProjectShape['pages']>}
 */
async function readThePages(root) {
  try {
    const { readPageRoutes } = await import('./adapters/web.js');
    return await readPageRoutes(root);
  } catch {
    return [];
  }
}

/**
 * The project's own test suite: what runs it, how many there are, and where they live.
 *
 * This is the most valuable thing in the whole detection, and it is worth saying why. A test
 * suite is a set of journeys somebody already wrote, already keeps working, and already
 * trusts. Borrowing them is free. Inventing journeys is not.
 *
 * @param {string} root
 * @param {any} pkg
 * @param {{files: string[], dirs: string[]}} listing
 * @returns {Promise<ProjectShape['tests']>}
 */
async function findTests(root, pkg, listing) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const command = typeof pkg?.scripts?.test === 'string' ? String(pkg.scripts.test) : null;

  /** @type {string|null} */
  let runner = null;
  for (const [name, label] of /** @type {[string, string][]} */ ([
    ['vitest', 'Vitest'], ['jest', 'Jest'], ['mocha', 'Mocha'], ['ava', 'AVA'],
    ['@playwright/test', 'Playwright Test'], ['cypress', 'Cypress'], ['tap', 'tap'], ['uvu', 'uvu'], ['@japa/runner', 'Japa'],
  ])) {
    if (name in deps) { runner = label; break; }
  }
  // Node's own runner is often buried inside a wrapper script rather than typed plainly, so
  // the flag is what is looked for, not the shape of the line around it.
  if (!runner && command && /(^|\s|')--test(\s|'|$)|node:test/.test(command)) runner = "Node's own test runner";
  if (!runner && command && command.trim() !== '' && !/^echo\b/.test(command)) runner = 'a command in package.json';

  const folders = listing.dirs.filter((d) => ['test', 'tests', '__tests__', 'spec', 'e2e', 'cypress'].includes(d));
  const files = await countMatching(root, /\.(test|spec)\.[cm]?[jt]sx?$/);
  return {
    runner,
    command,
    files,
    folders,
    why: runner
      ? `${files} test file${files === 1 ? '' : 's'} were found, run with ${runner}. Each one is a journey this tool can walk under instrumentation instead of inventing its own.`
      : 'No test runner was found, so every journey has to come from reading the code or from a recording.',
  };
}

/**
 * How many files in this project match a pattern. Capped, and the cap is real: a repository
 * with a hundred thousand files is not worth two seconds to count its tests.
 *
 * @param {string} root
 * @param {RegExp} pattern
 * @returns {Promise<number>}
 */
async function countMatching(root, pattern) {
  let count = 0;
  let seen = 0;
  /** @param {string} dir */
  const walk = async (dir) => {
    if (seen > MOST_FILES) return;
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen > MOST_FILES) return;
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path.join(dir, entry.name));
        continue;
      }
      seen++;
      if (pattern.test(entry.name)) count++;
    }
  };
  await walk(root);
  return count;
}

/**
 * The first file under here matching a pattern, looking only in the folders named — because
 * a built artifact is always in one of four places, and searching a whole repository for a
 * `.apk` is how a detector takes twenty seconds.
 *
 * @param {string} dir
 * @param {RegExp} pattern
 * @param {string[]} folders
 * @returns {Promise<string|null>}
 */
async function findFirst(dir, pattern, folders) {
  /** @type {string[]} */
  const queue = folders.map((f) => path.join(dir, f));
  let looked = 0;
  while (queue.length > 0 && looked < 400) {
    const here = /** @type {string} */ (queue.shift());
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await fsp.readdir(here, { withFileTypes: true });
    } catch {
      continue;
    }
    looked++;
    for (const entry of entries) {
      const full = path.join(here, entry.name);
      if (pattern.test(entry.name)) return full;
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) queue.push(full);
    }
  }
  return null;
}

/**
 * A built desktop app, in the folders packagers actually use.
 *
 * Deliberately its own function rather than a call into the Electron adapter: detection has
 * to work on a project the Electron adapter would refuse, and it must never depend on an
 * adapter being loadable to say what a repository is.
 *
 * @param {string} dir
 * @returns {Promise<{where: string|null, how: string}>}
 */
async function findBuiltApp(dir) {
  const suffix = process.platform === 'darwin' ? '.app' : process.platform === 'win32' ? '.exe' : '.AppImage';
  for (const folder of ['out', 'dist', 'release', 'build']) {
    const here = path.join(dir, folder);
    const listing = await listOnce(here);
    for (const name of [...listing.dirs, ...listing.files]) {
      if (name.endsWith(suffix)) return { where: path.join(here, name), how: `it is built and sitting in ${folder}/` };
    }
    // electron-builder puts the app one level down, in a folder named after the platform.
    for (const inner of listing.dirs) {
      const deeper = await listOnce(path.join(here, inner));
      for (const name of [...deeper.dirs, ...deeper.files]) {
        if (name.endsWith(suffix)) return { where: path.join(here, inner, name), how: `it is built and sitting in ${folder}/${inner}/` };
      }
    }
  }
  return { where: null, how: 'no built app was found in out/, dist/, release/ or build/' };
}

/**
 * Which languages this repository is written in, most-used first, by counting extensions.
 *
 * Three files of a language before it is named at all: one stray `.py` script in a
 * JavaScript repository is not "a Python project", and a list that says it is makes every
 * other line on the report less believable.
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function languagesIn(root) {
  /** @type {Record<string, string>} */
  const byExtension = {
    '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
    '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.swift': 'Swift', '.kt': 'Kotlin',
    '.java': 'Java', '.go': 'Go', '.rs': 'Rust', '.py': 'Python', '.rb': 'Ruby',
    '.php': 'PHP', '.cs': 'C#', '.dart': 'Dart', '.m': 'Objective-C', '.mm': 'Objective-C',
  };
  /** @type {Record<string, number>} */
  const counts = {};
  let seen = 0;
  /** @param {string} dir */
  const walk = async (dir) => {
    if (seen > MOST_FILES) return;
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen > MOST_FILES) return;
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path.join(dir, entry.name));
        continue;
      }
      seen++;
      const language = byExtension[path.extname(entry.name)];
      if (language) counts[language] = (counts[language] ?? 0) + 1;
    }
  };
  await walk(root);
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .filter(([, n]) => n >= 3)
    .map(([language]) => language);
}

// ---------------------------------------------------------------------------
// Tidying up
// ---------------------------------------------------------------------------

/**
 * The scripts that mean something to this tool, picked out of the pile.
 * @param {Record<string, string>} scripts
 * @returns {ProjectShape['scripts']}
 */
function scriptsOf(scripts) {
  /** @param {string[]} names */
  const first = (names) => names.map((n) => (typeof scripts[n] === 'string' ? `npm run ${n}` : null)).find(Boolean) ?? null;
  return {
    dev: first(['dev', 'develop', 'serve', 'watch']),
    start: first(['start', 'serve', 'dev']),
    build: first(['build', 'compile', 'bundle']),
    test: first(['test']),
    typecheck: first(['typecheck', 'types', 'tsc', 'check-types']),
    package: first(['package', 'dist', 'pack', 'make']),
  };
}

/**
 * `npm run dev` when the thing named is a script, and the command itself when it is not.
 * @param {Record<string, string>} scripts
 * @param {string} candidate
 * @returns {string}
 */
function npmRun(scripts, candidate) {
  if (candidate.startsWith('npm run ') || candidate.startsWith('npm ')) return candidate;
  const name = Object.keys(scripts).find((key) => scripts[key] === candidate);
  return name ? `npm run ${name}` : candidate;
}

/**
 * A command that runs in a sub-folder, written so it works from the project root.
 *
 * No adapter takes a "which folder" setting — they all run the command from a scratch copy of
 * the whole project — so the folder has to be part of the command itself. Putting it in a
 * setting nobody reads would look right in the file and silently start the wrong thing.
 *
 * @param {string} command
 * @param {string} where
 * @returns {string}
 */
function inFolder(command, where) {
  return where === '.' ? command : `cd ${where} && ${command}`;
}

/**
 * How you would actually run one of this package's commands, without installing it globally.
 * @param {any} pkg
 * @param {string} name
 * @returns {string}
 */
function runnerFor(pkg, name) {
  const bin = typeof pkg?.bin === 'string' ? pkg.bin : pkg?.bin?.[name];
  return typeof bin === 'string' ? `node ${bin}` : `npx ${name}`;
}

/**
 * One product per kind per folder, keeping the most confident of any duplicates, ranked so
 * the thing a person would name first comes first.
 *
 * @param {Product[]} products
 * @returns {Product[]}
 */
function mergeProducts(products) {
  /** @type {Map<string, Product>} */
  const best = new Map();
  for (const product of products) {
    const key = `${product.kind}:${product.where}`;
    const already = best.get(key);
    if (!already || product.confidence > already.confidence) best.set(key, product);
  }
  /** @type {Record<string, number>} */
  const order = { electron: 0, ios: 1, android: 2, web: 3, server: 4, cli: 5, library: 6, desktopNative: 7, container: 8, other: 9 };
  return [...best.values()].sort((a, b) => {
    const byConfidence = Math.round(b.confidence * 10) - Math.round(a.confidence * 10);
    if (byConfidence !== 0) return byConfidence;
    return (order[a.kind] ?? 99) - (order[b.kind] ?? 99);
  });
}

/**
 * One sentence naming everything this repository makes.
 * @param {Product[]} products
 * @param {string} fallbackName
 * @returns {string}
 */
function summarise(products, fallbackName) {
  if (products.length === 0) return `Nothing in ${fallbackName} looks like a product this tool knows how to watch yet.`;
  const names = products.map((p) => p.name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  if (products.length === 1) return `This repository makes one thing: ${list}.`;
  return `This repository makes ${products.length} things at once: ${list}. A change in shared code can break any of them, so all of them are worth checking.`;
}

/**
 * Where `import` would actually enter this package.
 * @param {any} pkg
 * @returns {string}
 */
function entryPointOf(pkg) {
  const dot = pkg?.exports?.['.'] ?? pkg?.exports;
  if (typeof dot === 'string') return dot;
  if (dot && typeof dot === 'object') {
    for (const key of ['import', 'default', 'require', 'node']) {
      if (typeof dot[key] === 'string') return dot[key];
    }
  }
  if (typeof pkg?.module === 'string') return pkg.module;
  if (typeof pkg?.main === 'string') return pkg.main;
  return '.';
}

/**
 * @param {Clue[]} clues
 * @returns {Clue[]}
 */
function dedupeClues(clues) {
  /** @type {Map<string, Clue>} */
  const seen = new Map();
  for (const clue of clues) {
    const key = `${clue.where}|${clue.means}`;
    if (!seen.has(key)) seen.set(key, clue);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Reading what the code IS, rather than what package.json advertises
// ---------------------------------------------------------------------------

/**
 * Where a build puts what it made. Looked in for products that exist only after a build —
 * the ones no manifest at the top of the repository mentions.
 */
const BUILD_OUTPUT_DIRS = ['out', 'dist', 'build', 'lib', 'release', 'target', 'bin', '.output'];

/**
 * Folders whose command-line-looking files are machinery rather than a product: the scripts
 * that release the thing, the tests that check it, the samples that show it off. Every one of
 * these normally holds a file with a shebang on it, and calling those a product would fill the
 * report with things nobody ships.
 */
const NOT_A_SHIPPED_PROGRAM = new Set([
  'scripts', 'script', 'tools', 'tooling', 'build', 'ci', 'test', 'tests', '__tests__', 'spec',
  'e2e', 'fixtures', 'examples', 'example', 'demo', 'demos', 'docs', 'doc', 'benchmarks', 'bench',
  'migrations', 'seeds', 'infra', 'deploy', 'types', 'typings', 'assets', 'public', 'static',
]);

/**
 * How much of one file is worth reading to work out what kind of thing it is.
 *
 * Two megabytes, and the number was chosen by measuring rather than by feel. A single-page
 * app that keeps its whole client in one file is normal — the phone client this was tested
 * against is 315KB in one file, and it holds the entire list of screens. At the 400KB this
 * started at, an app half again as big would have had its router go unread, and the answer
 * would have been "this is one page" with nothing anywhere saying a file had been skipped.
 * That is the exact shape of silence this whole tool exists to remove, so the ceiling is
 * generous AND anything above it is named out loud.
 */
const MOST_BYTES_PER_FILE = 2_000_000;

/**
 * Read a file, but only if it is small enough to be worth reading.
 *
 * @param {string} file
 * @param {number} [limit]
 * @returns {Promise<string|null>}
 */
async function readTextIfSmall(file, limit = MOST_BYTES_PER_FILE) {
  try {
    const info = await fsp.stat(file);
    if (!info.isFile() || info.size > limit) return null;
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Every source file under one folder, bounded, with its text.
 *
 * Bounded twice over — a file count and a byte ceiling per file — because this runs inside
 * somebody else's repository, and a detector that takes twenty seconds is a detector people
 * turn off.
 *
 * @param {string} dir
 * @param {object} [opts]
 * @param {RegExp} [opts.match]      Which filenames are worth opening.
 * @param {number} [opts.most]       How many files to open before stopping.
 * @param {number} [opts.depth]      How deep to go.
 * @returns {Promise<{files: {file: string, rel: string, text: string}[], tooBig: string[]}>}
 *   `tooBig` names anything skipped for size. Every reading built on this has to be able to
 *   say what it did not open, because a reader that quietly skips a file and then reports
 *   what it found is indistinguishable from one that found nothing.
 */
async function readSome(dir, opts = {}) {
  const match = opts.match ?? /\.([cm]?[jt]sx?|svelte|vue)$/;
  const most = opts.most ?? 300;
  const maxDepth = opts.depth ?? 4;
  /** @type {{file: string, rel: string, text: string}[]} */
  const out = [];
  /** @type {string[]} */
  const tooBig = [];
  /**
   * @param {string} here
   * @param {number} depth
   * @returns {Promise<void>}
   */
  const walk = async (here, depth) => {
    if (out.length >= most || depth > maxDepth) return;
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await fsp.readdir(here, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= most) return;
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(here, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
        continue;
      }
      if (!match.test(entry.name)) continue;
      const text = await readTextIfSmall(full);
      if (text === null) {
        tooBig.push(path.relative(dir, full));
        continue;
      }
      out.push({ file: full, rel: path.relative(dir, full), text });
    }
  };
  await walk(dir, 0);
  return { files: out, tooBig };
}

/**
 * The first bytes of a file, for the one question a shebang answers.
 *
 * @param {string} file
 * @param {number} bytes
 * @returns {Promise<string>}
 */
async function readHead(file, bytes) {
  /** @type {import('node:fs/promises').FileHandle|null} */
  let handle = null;
  try {
    handle = await fsp.open(file, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, read.bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Which script builds the thing in this folder, and where it lands.
 *
 * Matched on the folder's own word — `src/headless` against `build:headless` against
 * `vite.headless.config.ts` — because that is how every repository that builds a second
 * program out of one tree actually names things. The output folder is read out of the build
 * config rather than guessed, so what the settings say is where the file will be.
 *
 * @param {string} root
 * @param {string} where
 * @param {{files: string[], dirs: string[]}} listing
 * @param {Record<string, string>} scripts
 * @returns {{command: string|null, outDir: string|null}}
 */
function buildFor(root, where, listing, scripts) {
  const word = path.basename(where).toLowerCase();
  /** @type {string|null} */
  let command = null;
  for (const [name, line] of Object.entries(scripts)) {
    if (typeof line !== 'string') continue;
    const lower = name.toLowerCase();
    if (lower.includes(word) && /build|bundle|compile|dist|pack/.test(lower)) {
      command = `npm run ${name}`;
      break;
    }
  }
  if (!command) {
    for (const [name, line] of Object.entries(scripts)) {
      if (typeof line !== 'string') continue;
      const lower = line.toLowerCase();
      if (lower.includes(word) && /build|bundle|compile|esbuild|tsc|vite|rollup|webpack/.test(lower)) {
        command = `npm run ${name}`;
        break;
      }
    }
  }

  /** @type {string|null} */
  let outDir = null;
  for (const file of listing.files) {
    if (!file.toLowerCase().includes(word)) continue;
    if (!/\.(js|cjs|mjs|ts|mts|json|yml|yaml)$/.test(file)) continue;
    /** @type {string} */
    let text = '';
    try {
      const info = fs.statSync(path.join(root, file));
      if (info.size > MOST_BYTES_PER_FILE) continue;
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    const hit = /out(?:Dir|dir|put|putDir|putDirectory|File|file)\s*[:=]\s*['"]([^'"]+)['"]/.exec(text);
    if (hit) {
      const named = hit[1].replace(/\/+$/, '');
      // Some builds name the file rather than the folder — `outfile: 'dist/bundle.js'`. The
      // folder is what is wanted either way, and a folder with a .js on the end of it would
      // read like a mistake in the settings.
      outDir = /\.[a-z]{1,4}$/i.test(named) ? path.posix.dirname(named) : named;
      break;
    }
  }
  return { command, outDir };
}

/**
 * The command-line programs this repository makes, found by what the code IS.
 *
 * THIS IS THE ANSWER TO A PRODUCT GOING MISSING. Terminal Deck ships a headless host: a real
 * command-line program with its own help, its own `status`, `devices`, `pair`, `folders` and
 * `stop`, which runs agent sessions on a server with no window. Nothing in the repository's
 * own `package.json` mentions it — no `bin`, no entry point — because it is built by a config
 * of its own into an `out/` folder nobody commits, and the manifest naming its commands is
 * written BY that build. A detector that reads only the manifest at the top of the repository
 * reports four products out of five, says nothing at all about the fifth, and the clean run
 * that follows looks complete.
 *
 * So three readings, strongest first.
 *
 *   1. A MANIFEST A BUILD WROTE. A `package.json` inside a build output folder with a `bin`
 *      map in it. Exact: it names each command and the file that runs it. It also draws the
 *      line the build drew — Terminal Deck's build emits a third program, a public demo host,
 *      and deliberately keeps it out of `bin`. Reading `bin` inherits that decision; scanning
 *      for shebangs would have proposed running it.
 *   2. A BUILT FILE THAT ANNOUNCES ITSELF. A JavaScript file in a build output folder whose
 *      first line is a shebang. That is what makes a file something an operating system will
 *      run, and nothing else puts one there.
 *   3. SOURCE THAT READS ITS OWN ARGUMENTS. A folder holding a file that reads the command
 *      line and a file that mentions a help flag. That is a command-line program before
 *      anybody has built it, and saying so is what turns silence into "build it first".
 *
 * A shipped program and a release script look identical from a distance — both are a file
 * with a shebang on it. They are told apart by where they live: {@link NOT_A_SHIPPED_PROGRAM}.
 *
 * @param {object} input
 * @param {string} input.root
 * @param {{files: string[], dirs: string[]}} input.listing
 * @param {Record<string, string>} input.scripts
 * @param {Set<string>} input.available
 * @param {string[]} input.claimed   Folders another product already spoke for. A phone app folder
 *                                   holds build scripts with shebangs on them, and calling one
 *                                   of those a second product would report the same tree twice.
 * @returns {Promise<Product[]>}
 */
async function findCommandPrograms(input) {
  const { root, listing, scripts, available, claimed } = input;
  const spokenFor = (/** @type {string} */ where) =>
    claimed.some((taken) => taken !== "." && (where === taken || where.startsWith(`${taken}/`)));
  /** @type {Product[]} */
  const found = [];

  // ── 1 and 2: what a build left behind ─────────────────────────────────────
  //
  // "Built" is decided by the repository's own ignore list rather than by the folder's name.
  // `build/` in one repository is where a bundler writes and in the next it is committed
  // artwork scripts; the difference is whether git is told to leave it alone. Reading the
  // ignore list is exact, free, and it is the project's own answer rather than this file's
  // opinion — without it, a folder of committed release scripts gets reported as a product.
  const ignored = await readIgnoreList(root);
  /** @type {string[]} */
  const outputFolders = [];
  for (const name of BUILD_OUTPUT_DIRS) {
    if (!listing.dirs.includes(name)) continue;
    const inner = await listOnce(path.join(root, name));
    /** @type {string[]} */
    const here = [name, ...inner.dirs.filter((deeper) => !deeper.startsWith('.')).map((deeper) => path.posix.join(name, deeper))];
    if (ignored.has(name)) {
      outputFolders.push(...here);
      continue;
    }
    // Not ignored, so the shebang reading would be guessing. A manifest with a `bin` map in it
    // is not a guess, so those folders still go in and the shebang reading skips them.
    for (const folder of here) {
      if (fs.existsSync(path.join(root, folder, 'package.json'))) outputFolders.push(folder);
    }
  }

  for (const where of outputFolders) {
    const dir = path.join(root, where);
    const manifest = await readJson(path.join(dir, 'package.json'));
    /** @type {{command: string, file: string}[]} */
    const commands = [];
    /** @type {Clue[]} */
    const clues = [];

    if (manifest?.bin) {
      const bins = typeof manifest.bin === 'string'
        ? { [String(manifest.name ?? path.basename(where))]: manifest.bin }
        : manifest.bin;
      for (const [command, file] of Object.entries(bins)) {
        if (typeof file !== 'string') continue;
        const full = path.join(dir, file);
        if (!fs.existsSync(full)) continue;
        commands.push({ command, file: path.relative(root, full) });
      }
      if (commands.length > 0) {
        clues.push({
          where: path.posix.join(where, 'package.json'),
          means: `A package written by a build, installing ${commands.length === 1 ? 'a command' : `${commands.length} commands`}: ${commands.map((c) => c.command).join(', ')}. Nothing at the top of this repository mentions any of them.`,
        });
      }
    }

    if (commands.length < 1 && ignored.has(where.split('/')[0])) {
      const inner = await listOnce(dir);
      for (const name of inner.files) {
        if (!/\.[cm]?js$/.test(name)) continue;
        const head = await readHead(path.join(dir, name), 64);
        if (!head.startsWith('#!')) continue;
        commands.push({ command: name.replace(/\.[cm]?js$/, ''), file: path.posix.join(where, name) });
      }
      if (commands.length > 0) {
        clues.push({
          where: commands[0].file,
          means: `${commands.length === 1 ? 'A built file starts' : `${commands.length} built files start`} with a shebang, which is the thing that makes a file runnable as a command.`,
        });
      }
    }

    if (commands.length === 0) continue;
    found.push({
      kind: 'cli',
      name: commands.length === 1 ? `the \`${commands[0].command}\` command` : `the command-line program in ${where}/`,
      surface: 'cli',
      adapter: available.has('process') ? 'process' : null,
      confidence: 1,
      why: `${where}/ holds a built command-line program that nothing in this repository's own package.json names: ${commands.map((c) => `\`${c.command}\``).join(', ')}.`,
      where,
      evidence: clues,
      built: { found: true, where, how: `it is built and sitting in ${where}/` },
      blockers: [],
      // `--help` and nothing else, exactly as for a command named in package.json. A command
      // this tool found for itself has even less business being run: nobody wrote it down, so
      // nobody has said it is safe.
      suggest: {
        commands: commands.map((one) => ({
          name: `${one.command} --help`,
          run: `node ${one.file} --help`,
          describe: `ask ${one.command} to print its help, and compare every word of it`,
        })),
      },
    });
  }

  // ── 3: source that reads its own arguments ────────────────────────────────
  const holdsOtherFolders = new Set(['src', 'source', 'lib', 'packages', 'apps', 'app']);
  /** @type {string[]} */
  const sourceFolders = [];
  for (const top of ['src', 'source', 'lib', 'packages', 'apps', '.']) {
    if (top !== '.' && !listing.dirs.includes(top)) continue;
    const inner = top === '.' ? listing : await listOnce(path.join(root, top));
    for (const name of inner.dirs) {
      if (SKIP_DIRS.has(name) || name.startsWith('.') || NOT_A_SHIPPED_PROGRAM.has(name)) continue;
      // A folder that only holds other folders is not itself the program. Descending into it
      // is what finds the program; naming it as well reports the same one twice, under a name
      // that tells nobody anything.
      if (top === '.' && holdsOtherFolders.has(name)) continue;
      sourceFolders.push(top === '.' ? name : path.posix.join(top, name));
    }
  }

  for (const where of sourceFolders) {
    if (spokenFor(where)) continue;
    const dir = path.join(root, where);
    const files = (await readSome(dir, { most: 60, depth: 1 })).files.filter((f) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(f.rel));
    if (files.length === 0) continue;
    // The file that reads the command line has to be one somebody would run — the entry
    // point, by the name every project gives it. Any file at all reading `process.argv` is
    // far too weak: a test helper does it, a build script does it, and each one of those
    // would arrive as a product this repository does not make.
    const readsArguments = files.find((f) => /^(cli|main|bin|index|program|command|cmd|run|app)\.[cm]?[jt]sx?$/.test(path.basename(f.rel)) && /process\.argv|Deno\.args|Bun\.argv/.test(f.text));
    const printsHelp = files.find((f) => /(['"`])(-h|--help|help)\1|Usage:|usage:/.test(f.text));
    if (!readsArguments || !printsHelp) continue;

    const build = buildFor(root, where, listing, scripts);
    // A built copy of this same program was already found above. The built one is the exact
    // answer and this one is the guess, so the guess stays quiet.
    if (build.outDir && found.some((p) => p.where === build.outDir || p.where.startsWith(`${build.outDir}/`))) continue;

    found.push({
      kind: 'cli',
      name: `the command-line program in ${where}/`,
      surface: 'cli',
      adapter: available.has('process') ? 'process' : null,
      confidence: 0.8,
      why: `${path.posix.join(where, readsArguments.rel)} reads the command line and ${path.posix.join(where, printsHelp.rel)} carries a help text, which is a command-line program whatever package.json says.`,
      where,
      evidence: [
        { where: path.posix.join(where, readsArguments.rel), means: 'This file reads the arguments it was started with, which only a program somebody types does.' },
        { where: path.posix.join(where, printsHelp.rel), means: 'This file holds the help text, so the program describes itself when asked — the one thing every command-line tool can safely be asked to do.' },
      ],
      built: { found: false, where: null, how: build.outDir ? `it builds into ${build.outDir}/, and there is nothing there yet` : 'nothing built was found' },
      blockers: [
        build.command
          ? `It has not been built yet. Run \`${build.command}\`${build.outDir ? `, which puts it in ${build.outDir}/,` : ''} and then \`staysfixed init --force\`: the commands are filled in exactly from what the build wrote. Nothing has been edited by hand at that point, so nothing is lost.`
          : 'It has not been built, and nothing in package.json says how. Name the command that builds it and the command that runs the result under "process" in the settings.',
      ],
      suggest: { buildWith: build.command, outDir: build.outDir },
    });
  }

  return found;
}

/**
 * How each language declares itself, and what it takes to start and to type.
 *
 * Not a table of languages this tool understands. It is a table of what can be OFFERED, and
 * the difference is the whole point of it. Two of this tool's adapters never read a line of
 * anybody's source — one runs a command and compares what it printed, the other boots a
 * server on a spare port and asks it for routes — so a Go server and a Ruby app have always
 * been checkable here, and were being turned away with "a language nothing here drives".
 * That sentence was true of the source reader and false of everything else, and the person
 * went away with nothing rather than with most of what they came for.
 */
const FOREIGN_LANGUAGES = Object.freeze({
  Python: { manifests: ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py'], sources: /\.py$/ },
  Go: { manifests: ['go.mod'], sources: /\.go$/ },
  Rust: { manifests: ['Cargo.toml'], sources: /\.rs$/ },
  Ruby: { manifests: ['Gemfile', 'config.ru'], sources: /\.rb$/ },
  PHP: { manifests: ['composer.json'], sources: /\.php$/ },
});

/**
 * What can honestly be offered for a project in a language this tool does not read.
 *
 * Python is read properly — its addresses come out of its own source, so the HTTP half works
 * the way it does for JavaScript. The other four are offered a boot and a command and
 * nothing more, and that limit is carried out of here by name rather than left to be
 * noticed. Going further into reading four more route syntaxes would multiply the places
 * this tool can invent an address that does not exist, and inventing one is worse than
 * missing one.
 *
 * @param {string} dir
 * @param {{files: string[], dirs: string[]}} listing
 * @returns {Promise<null|{language: string, manifest: string, framework: string|null, start: string|null, startWhy: string, readsPort: boolean, commands: {name: string, run: string, describe: string}[], routes: number, evidence: Clue[]}>}
 */
async function foreignProjectIn(dir, listing) {
  const language = Object.keys(FOREIGN_LANGUAGES).find(
    (name) => FOREIGN_LANGUAGES[/** @type {keyof typeof FOREIGN_LANGUAGES} */ (name)].manifests.some((m) => listing.files.includes(m)),
  );
  if (!language) return null;
  const spec = FOREIGN_LANGUAGES[/** @type {keyof typeof FOREIGN_LANGUAGES} */ (language)];
  const manifest = spec.manifests.find((m) => listing.files.includes(m)) ?? spec.manifests[0];
  // Read for the languages below that still scrape their manifest by hand. Python no longer
  // does — its entry points are read by `pythonEntryPoints`, which knows all three of the
  // places a Python project can declare them.
  const manifestText = await readTextIfSmall(path.join(dir, manifest)) ?? '';
  void manifestText;
  /** @type {Clue[]} */
  const evidence = [{ where: manifest, means: `This is how a ${language} project declares itself.` }];
  /** @type {{name: string, run: string, describe: string}[]} */
  const commands = [];
  let framework = null;
  let start = null;
  let startWhy = '';
  let readsPort = false;
  let routes = 0;

  if (language === 'Python') {
    const { readPython } = await import('./adapters/python.js');
    const reading = await readPython(dir);
    routes = reading.doors.length;
    // Always the plain interpreter, never the one inside the project's environment folder,
    // and this was learned the hard way rather than chosen.
    //
    // Pointing the start command at `./.venv/bin/python` worked beautifully on the build in
    // front of you and failed on every other one. An environment folder is not committed, so
    // the OLD build — a clean checkout, which is the entire point of a paired run — has no
    // such file, and every paired comparison quietly degraded to an unpaired one. The same
    // path also runs commands inside a throwaway copy of the project, where the link out to
    // the real interpreter is deliberately not followed.
    //
    // `python3` is whatever the person's shell has, which inside an activated environment is
    // the environment's own. Same answer on both builds, every time, is worth more here than
    // a cleverer answer that is only right on one of them.
    const py = 'python3';
    const typed = 'python3';
    framework = reading.frameworks[0] ?? null;
    if (framework === 'flask' && reading.appTarget) {
      start = `${py} -m flask --app ${reading.appTarget} run --port $PORT`;
      startWhy = `${reading.appFile} builds a Flask application, and this is how Flask is asked to serve one on a port it is given.`;
    } else if (framework === 'fastapi' && reading.appTarget) {
      start = `${py} -m uvicorn ${reading.appTarget} --port $PORT`;
      startWhy = `${reading.appFile} builds a FastAPI application, and uvicorn is what serves one.`;
    } else if (framework === 'django' && reading.managePy) {
      start = `${py} ${reading.managePy} runserver $PORT`;
      startWhy = `${reading.managePy} is Django's own way in, and runserver takes the port it is given.`;
    }
    if (start) {
      readsPort = true;
      evidence.push({ where: reading.appFile ?? reading.managePy ?? manifest, means: `It serves requests with ${framework}, and ${routes} address${routes === 1 ? '' : 'es'} were read out of its own source.` });
    }
    for (const entry of reading.entries) {
      const name = path.basename(entry, '.py');
      // Written as the plain path here, deliberately. `commandsThatRun` in init.js judges every
      // suggested command against the project and repairs it — turning a module run by path
      // into one Python can actually import, and carrying a src layout as PYTHONPATH rather
      // than in front of the command. Repairing it twice, in two places, is how the two come
      // to disagree: doing it here as well dropped the PYTHONPATH that the repair adds.
      // Measured by the gate on 2026-09-01.
      commands.push({ name: `${name} --help`, run: `${typed} ${entry} --help`, describe: `ask ${name} to print its help, and compare every word of it` });
    }
    // A console script is a command somebody types AFTER INSTALLING — pip writes those files
    // at install time, so on a checkout the name is simply not there. `judgeCommand` knows
    // that and rewrites it into something runnable; what matters here is that Poetry's and
    // setuptools' own spellings are read at all, because reading only `[project.scripts]`
    // meant a Poetry project had no commands worked out for it whatsoever.
    for (const [scriptName] of pythonEntryPoints(dir)) {
      if (commands.some((c) => c.name.startsWith(`${scriptName} `))) continue;
      commands.push({
        name: `${scriptName} --help`,
        run: `${scriptName} --help`,
        describe: `ask ${scriptName} to print its help, and compare every word of it`,
      });
    }
  } else {
    const listens = await foreignServerIn(dir, spec.sources, language);
    framework = listens.framework;
    readsPort = listens.readsPort;
    if (listens.yes) {
      if (language === 'Go') { start = 'go run .'; startWhy = 'go.mod makes this a module go can build and run where it stands.'; }
      if (language === 'Rust') { start = 'cargo run'; startWhy = 'Cargo.toml makes this a crate cargo can build and run where it stands.'; }
      if (language === 'Ruby') {
        start = listing.files.includes('config.ru') ? 'bundle exec rackup -p $PORT' : 'bundle exec bin/rails server -p $PORT';
        startWhy = listing.files.includes('config.ru') ? 'config.ru is the file rack serves.' : 'A Rails app is served by its own bin/rails.';
      }
      if (language === 'PHP') {
        const web = listing.dirs.includes('public') ? ' -t public' : '';
        start = `php -S 127.0.0.1:$PORT${web}`;
        startWhy = 'PHP has a server of its own, and it takes the address it is given.';
      }
      if (listens.file) evidence.push({ where: listens.file, means: `It opens a server and listens on it${framework ? `, using ${framework}` : ''}.` });
    }
  }

  // A Makefile target is a command somebody types, in any language at all. Only `help` is
  // taken, and for the same reason package.json's commands are only ever asked for their
  // help: `make deploy` is sitting right there in the same file, and running one because it
  // was there would be this tool causing the very kind of damage it exists to catch.
  if (listing.files.includes('Makefile')) {
    const makefile = await readTextIfSmall(path.join(dir, 'Makefile')) ?? '';
    if (/^help\s*:/m.test(makefile)) {
      commands.push({ name: 'make help', run: 'make help', describe: 'ask the Makefile to print its help, and compare every word of it' });
    }
  }

  if (!start && commands.length === 0) return null;
  return { language, manifest, framework, start, startWhy, readsPort, commands, routes, evidence };
}

/**
 * Does a folder hold a server in a language this tool cannot read?
 *
 * This looks for one thing only — that a server is started — and never for what it answers.
 * Knowing a server is there is enough to boot it and watch it come up; claiming to know its
 * addresses without reading them would be the invention this whole file exists to avoid.
 *
 * @param {string} dir
 * @param {RegExp} sources
 * @param {string} language
 * @returns {Promise<{yes: boolean, file: string|null, framework: string|null, readsPort: boolean}>}
 */
async function foreignServerIn(dir, sources, language) {
  const listens = /** @type {Record<string, RegExp>} */ ({
    Go: /\bhttp\.ListenAndServe\b|\bhttp\.Server\s*\{|\.ListenAndServe\s*\(/,
    Rust: /\bHttpServer::new\b|\baxum::(Server|serve)\b|\brocket::(build|ignite)\b|\bwarp::serve\b|\bTcpListener::bind\b/,
    Ruby: /\bSinatra::Base\b|\brun\s+Sinatra\b|\bRails\.application\b|\bRack::Server\b/,
    PHP: /\$app\s*->\s*run\s*\(|\bApp::run\b|\bKernel::handle\b|\brequire.*autoload/,
  })[language];
  const names = /** @type {Record<string, RegExp>} */ ({
    Go: /\b(gin-gonic\/gin|labstack\/echo|go-chi\/chi|gofiber\/fiber|gorilla\/mux)\b/,
    Rust: /\b(actix-web|axum|rocket|warp|tide)\b/,
    Ruby: /\b(sinatra|rails|hanami|roda)\b/,
    PHP: /\b(laravel\/framework|symfony\/framework-bundle|slim\/slim|laminas)\b/,
  })[language];
  if (!listens) return { yes: false, file: null, framework: null, readsPort: false };

  const { files } = await readSome(dir, { match: sources, most: 80, depth: 3 });
  for (const one of files) {
    const where = one.rel.split(path.sep).join('/');
    if (/(^|\/)(tests?|spec|fixtures|examples?|vendor)\//.test(where)) continue;
    if (!listens.test(one.text)) continue;
    return {
      yes: true,
      file: one.rel,
      framework: names?.exec(one.text)?.[1] ?? null,
      readsPort: /\bPORT\b/.test(one.text),
    };
  }
  return { yes: false, file: null, framework: null, readsPort: false };
}

/**
 * Does this file belong to a package sitting INSIDE the folder being looked at?
 *
 * THE FAILURE THIS EXISTS TO STOP. Both server readings below open files three folders deep,
 * which is right for a product folder and wrong for a shelf. In a workspaces monorepo it made
 * `packages/api/src/server.js` count as evidence about `packages/` itself, and a folder that
 * ships nothing at all was announced as "the server in packages/" with 0.8 confidence — a
 * product that does not exist, sitting in the list beside four that do. The same file had
 * already been read correctly one folder down, where it actually lives.
 *
 * A `package.json` on the way down is the line. Everything below it is that package's, and
 * that package is looked at in its own right.
 *
 * @param {string} dir           The folder being asked about.
 * @param {string} rel           A file inside it, relative to it.
 * @param {Map<string, boolean>} seen   Answers already worked out, so one walk costs one look.
 * @returns {boolean}
 */
function insideAnotherPackage(dir, rel, seen) {
  const parts = rel.split(path.sep);
  parts.pop();                                   // the filename itself is never a folder
  let sofar = '';
  for (const part of parts) {
    sofar = sofar ? path.join(sofar, part) : part;
    let itsOwn = seen.get(sofar);
    if (itsOwn === undefined) {
      itsOwn = fs.existsSync(path.join(dir, sofar, 'package.json'));
      seen.set(sofar, itsOwn);
    }
    if (itsOwn) return true;
  }
  return false;
}

/**
 * Does a folder hold a server somebody wrote by hand, on node's own http module?
 *
 * A product with no framework in its package.json used to be invisible here, and the whole
 * HTTP half of it went unwatched while init said the repository made one command and nothing
 * was being left out. There is no dependency to find, so the code itself has to say it.
 *
 * Three things have to be true in one file, and the third is the one that matters. This
 * tool's own source imports node:net, calls createServer and calls listen — five files do —
 * and not one of them is a server: they are port probes, `createServer()` with nothing
 * inside the brackets. A server is handed something to answer requests with. That single
 * character of difference is what keeps this from calling every repository a server.
 *
 * @param {string} dir
 * @returns {Promise<{yes: boolean, file: string|null, readsPort: boolean}>}
 */
async function handWrittenServerIn(dir) {
  const { files } = await readSome(dir, { most: 80, depth: 3 });
  /** @type {Map<string, boolean>} */
  const packagesInside = new Map();
  for (const one of files) {
    const where = one.rel.split(path.sep).join('/');
    // Somebody else's package, read on the way past. It is a product in its own right and is
    // found as one; borrowing its server for the folder above invents a second product.
    if (insideAnotherPackage(dir, one.rel, packagesInside)) continue;
    // A server standing in a fixtures folder is a prop for somebody's test, not the product.
    // This tool's own repository has one, and without this line it reported ITSELF as a
    // server — which is exactly the kind of confident wrong answer that gets a tool switched
    // off. The filename rule alone is not enough; the folder is what gives it away.
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(where)) continue;
    if (/(^|\/)(__tests__|__mocks__|tests?|e2e|fixtures|examples?|samples?|demos?)\//.test(where)) continue;
    if (!/\bnode:(http|https|net)\b|require\(\s*['"](?:node:)?(?:http|https|net)['"]\s*\)/.test(one.text)) continue;
    if (!/\bcreateServer\s*\(\s*[^)\s]/.test(one.text)) continue;
    if (!/\.listen\s*\(/.test(one.text)) continue;
    // And it has to listen somewhere a person could go. A server on `listen(0)` took whatever
    // port was free, which is what a program does when it is talking to itself — this tool's
    // own Android driver stands up a real HTTP server that way to catch an app's outbound
    // calls, and it is nobody's product. A server this tool can drive has to take the port it
    // is given, or at least name one.
    const readsPort = /process\.env\.PORT|env\.PORT|Deno\.env\.get\(\s*['"]PORT/.test(one.text);
    const namesAPort = /\.listen\s*\(\s*[1-9][0-9]{2,4}\b/.test(one.text);
    if (!readsPort && !namesAPort) continue;
    return { yes: true, file: one.rel, readsPort };
  }
  return { yes: false, file: null, readsPort: false };
}

/**
 * Does a folder hold something that listens on a port?
 *
 * The third product a manifest never mentions. Terminal Deck's relay is three TypeScript
 * files, no package.json, no framework and no script — and it is the one machine every phone
 * depends on. Everything before this reported it as "a folder nothing could work out", which
 * is honest and useless. What the code says plainly is that it opens a socket and reads the
 * port out of the environment, and that is a server whatever else is missing.
 *
 * @param {string} dir
 * @returns {Promise<{yes: boolean, file: string|null, readsPort: boolean, why: string}>}
 */
async function looksLikeAServer(dir) {
  const { files } = await readSome(dir, { most: 60, depth: 3 });
  /** @type {Map<string, boolean>} */
  const packagesInside = new Map();
  for (const one of files) {
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(one.rel)) continue;
    // The same line as above: a socket opened inside a package of its own says nothing about
    // the folder that package happens to sit in. `apps/` is not a server because `apps/api` is.
    if (insideAnotherPackage(dir, one.rel, packagesInside)) continue;
    const listens = /\.listen\s*\(|createServer\s*\(|Deno\.serve\s*\(|Bun\.serve\s*\(|serve\s*\(\s*\{[^}]*port/.test(one.text);
    if (!listens) continue;
    const readsPort = /process\.env\.PORT|Deno\.env\.get\(\s*['"]PORT|env\.PORT/.test(one.text);
    return {
      yes: true,
      file: one.rel,
      readsPort,
      why: readsPort
        ? `${one.rel} opens a socket and takes its port out of the environment, which is a server that can be booted on a spare port.`
        : `${one.rel} opens a socket, which is a server — though it does not read a PORT out of the environment, so the port it uses has to be given to it another way.`,
    };
  }
  return { yes: false, file: null, readsPort: false, why: 'Nothing here opens a socket.' };
}

// ---------------------------------------------------------------------------
// Routes the folder layout declares
// ---------------------------------------------------------------------------

/**
 * One address a framework builds out of a folder or a filename.
 *
 * @typedef {object} FolderRoute
 * @property {string} url       The address as the framework spells it, changing parts and
 *                              all — `/blog/[slug]`. This is the identity of the route, and
 *                              it is what the coverage ledger names when nobody can open it.
 * @property {string|null} open The address that can actually be typed into a browser, or
 *                              null when a changing part still has no value. Never guessed.
 * @property {string[]} needs   The changing parts still waiting on a value, by name.
 * @property {string|null} from Where the value came from, in plain English, so nobody has to
 *                             wonder whether the tool invented it.
 * @property {string} file      The file the address came out of, relative to the app folder.
 * @property {string} family    Which framework's spelling this was read in.
 */

/**
 * How many route files are read before the walk stops and says so. A route tree is filenames
 * only — nothing is opened — so this is generous; it exists to stop a walk that has wandered
 * into somebody's photo library, not to ration normal work.
 */
const MOST_ROUTE_FILES = 5_000;

/** How deep a route tree is followed. Real ones are five or six folders; twelve is slack. */
const DEEPEST_ROUTE = 12;

/** Files that sit beside a route for company and are not addresses of their own. */
const NOT_A_ROUTE_FILE = /\.(test|spec|stories|d)\.|\.(css|scss|sass|less|styl|json|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|txt|map)$|\.(server|client)\.[cm]?[jt]sx?$/;

/**
 * Every filename under one folder, as POSIX paths relative to it, plus the folders that would
 * not open.
 *
 * A folder that refuses to open is a hole in the route list, and the route list is the thing
 * that decides how much of a website gets walked — so it is carried back rather than
 * swallowed. On 2026-08-31 a three-page SvelteKit site reported "0 routes" and walked one
 * page; a reader that hides its own blind spots is how that stays invisible.
 *
 * @param {string} base
 * @returns {Promise<{files: string[], unreadable: string[], hitTheCap: boolean}>}
 */
async function everyFileUnder(base) {
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const unreadable = [];
  let hitTheCap = false;
  if (!fs.existsSync(base)) return { files, unreadable, hitTheCap };
  /** @type {{dir: string, depth: number}[]} */
  const stack = [{ dir: base, depth: 0 }];
  while (stack.length > 0) {
    const here = /** @type {{dir: string, depth: number}} */ (stack.pop());
    if (here.depth > DEEPEST_ROUTE) continue;
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await fsp.readdir(here.dir, { withFileTypes: true });
    } catch {
      unreadable.push(path.relative(base, here.dir) || '.');
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const whole = path.join(here.dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        stack.push({ dir: whole, depth: here.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= MOST_ROUTE_FILES) { hitTheCap = true; continue; }
      files.push(path.relative(base, whole).split(path.sep).join('/'));
    }
  }
  return { files, unreadable, hitTheCap };
}

/**
 * The changing parts of an address, by name, and whether the address works without them.
 *
 * Every family in this file spells the same idea differently — `[slug]`, `[...path]`,
 * `[[...slug]]` — and the difference that matters is not the spelling. It is whether the
 * address can be opened at all with nothing filled in. An OPTIONAL catch-all (`[[...slug]]`)
 * answers on its own parent address, so it can be opened today. A required one cannot, and
 * saying which is which is the whole job.
 *
 * @param {string} url
 * @returns {{names: string[], optionalOnly: boolean}}
 */
function changingPartsOf(url) {
  /** @type {string[]} */
  const names = [];
  let optionalOnly = true;
  for (const segment of url.split('/')) {
    if (segment === '' || !segment.startsWith('[')) continue;
    const optional = /^\[\[.*\]\]$/.test(segment);
    const inner = optional ? segment.slice(2, -2) : segment.slice(1, -1);
    // `[slug=integer]` in SvelteKit names a checker for the value, never a second value.
    const bare = inner.replace(/^\.{3}/, '').replace(/=.*$/, '');
    names.push(bare === '' ? 'the rest of the address' : bare);
    if (!optional) optionalOnly = false;
  }
  return { names, optionalOnly };
}

/**
 * The address an optional catch-all answers on when nothing is filled in.
 *
 * `/shop/[[...slug]]` is `/shop`, and `/shop` is a page somebody can open right now. Dropping
 * it into the "waiting on a value" pile would be true of the deeper addresses and false of
 * this one, and it would leave a page that works today reported as never looked at.
 *
 * @param {string} url
 * @returns {string}
 */
function withoutTheOptionalParts(url) {
  const kept = url.split('/').filter((segment) => !/^\[\[.*\]\]$/.test(segment));
  const joined = kept.join('/').replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  return joined === '' ? '/' : joined;
}

/**
 * A route folder name turned into one address segment, or nothing at all.
 *
 * The three things every one of these families does with a folder name, in the same order:
 * a grouping that is not part of the address, a folder that is not routed at all, and a
 * changing part that is. Getting the first two wrong invents addresses that 404, and an
 * address that 404s reports a difference nobody caused.
 *
 * @param {string} name
 * @returns {string|null}   The segment, or null when the name contributes nothing to the URL.
 */
function segmentFromFolder(name) {
  if (name === '' || name === '.') return null;
  // `(marketing)` in Next, `(app)` in SvelteKit: a grouping that organises files and never
  // appears in the address.
  if (name.startsWith('(') && name.endsWith(')')) return null;
  // `(.)photo`, `(..)photo`: Next's intercepting routes. They re-use another route's address
  // rather than adding one, so counting them would list the same page twice.
  if (/^\(\.{1,3}\)/.test(name)) return null;
  // `@modal`: a parallel slot. It renders INSIDE its parent's address and has none of its own.
  if (name.startsWith('@')) return null;
  // `_components`: private, and never routed.
  if (name.startsWith('_')) return null;
  // `[x+2e]`: SvelteKit's way of writing a character that cannot be a folder name. Decoded
  // rather than treated as a changing part, because it is a literal full stop.
  const escaped = name.match(/^\[x\+([0-9a-fA-F]{2})\]$/);
  if (escaped) return String.fromCharCode(parseInt(escaped[1], 16));
  return name;
}

/**
 * Read every address this app builds out of its folder layout.
 *
 * WHY THIS EXISTS, AND IT IS THE POINT OF THE WHOLE SECTION. Until 2026-08-31 this tool found
 * a site's pages by reading code that DECLARES routes — a route table, a `<Route path=...>`.
 * That works for Express and for the older React routers and finds nothing whatever for the
 * entire modern family where the folder layout IS the routing. Measured that day by somebody
 * using the tool as a stranger: a three-page SvelteKit site reported 0 routes, opened the
 * front page, and called that the website covered in full. Two of its three pages were never
 * opened and the coverage ledger never named them. One page walked out of three, reported as
 * all of them, is the exact false all-clear this product exists to make impossible.
 *
 * Six spellings of one idea, and each one is a place a whole site can go unseen:
 *
 *   SvelteKit          src/routes/about/+page.svelte     becomes  /about
 *   Next app router    app/(marketing)/about/page.tsx    becomes  /about
 *   Next pages router  pages/about.tsx                   becomes  /about
 *   Nuxt               pages/about.vue                   becomes  /about
 *   Astro              src/pages/about.astro             becomes  /about
 *   Remix              app/routes/blog.$slug.tsx         becomes  /blog/[slug]
 *
 * Nothing is opened and nothing is run. This reads filenames.
 *
 * @param {string} dir
 * @param {(name: string) => boolean} [has]   Is this a dependency? Three frameworks own a
 *   folder called `pages`, and a `.ts` file inside it is a page in one of them and a server
 *   endpoint in another. package.json is the only thing that can settle that.
 * @returns {Promise<{routes: FolderRoute[], families: string[], where: string|null, unreadable: string[], hitTheCap: boolean}>}
 */
async function readFolderRoutes(dir, has = () => false) {
  /** @type {Map<string, FolderRoute>} */
  const found = new Map();
  /** @type {Set<string>} */
  const families = new Set();
  /** @type {string[]} */
  const unreadable = [];
  /** @type {string|null} */
  let where = null;
  let hitTheCap = false;

  /**
   * @param {string} url
   * @param {string} file
   * @param {string} family
   */
  const add = (url, file, family) => {
    // Every family joins a folder path to a filename, and a page at the top of the tree makes
    // that "/" plus "about". Collapsing the repeats here rather than in six callers is the
    // difference between `/about` and `//about`, and `//about` is an address that 404s.
    const clean = url === '' ? '/' : url.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
    if (found.has(clean)) return;
    const { names, optionalOnly } = changingPartsOf(clean);
    found.set(clean, {
      url: clean,
      // An address with nothing changing in it opens as written. One whose only changing
      // parts are optional opens on its parent address. Anything else waits for a value, and
      // waits VISIBLY — `needs` is carried all the way into the settings file and the ledger.
      open: names.length === 0 ? clean : optionalOnly ? withoutTheOptionalParts(clean) : null,
      needs: names.length === 0 || optionalOnly ? [] : names,
      from: names.length > 0 && optionalOnly
        ? 'the changing part of this address may be left out entirely, so this is the address it answers on with nothing filled in'
        : null,
      file,
      family,
    });
    families.add(family);
    where = where ?? file;
  };

  /**
   * @param {string} folder
   * @returns {Promise<string[]>}
   */
  const filesUnder = async (folder) => {
    const reading = await everyFileUnder(path.join(dir, folder));
    for (const bad of reading.unreadable) unreadable.push(bad === '.' ? folder : path.posix.join(folder, bad));
    hitTheCap = hitTheCap || reading.hitTheCap;
    return reading.files;
  };

  /**
   * Fold a route file's folder path into an address, dropping the parts that are not in it.
   *
   * @param {string} rel
   * @returns {string|null}  Null when the file sits under a folder that is not routed at all,
   *   in which case the file has no address rather than an address one level up.
   */
  const urlFromFolders = (rel) => {
    const folders = rel.split('/').slice(0, -1);
    /** @type {string[]} */
    const kept = [];
    for (const part of folders) {
      const segment = segmentFromFolder(part);
      // A private, slot or intercepting folder does not just lose a segment — nothing under
      // it is an address, so the whole file is dropped rather than hoisted up a level.
      if (segment === null && (part.startsWith('_') || part.startsWith('@') || /^\(\.{1,3}\)/.test(part))) return null;
      if (segment !== null) kept.push(segment);
    }
    return `/${kept.join('/')}`;
  };

  // ── SvelteKit: src/routes/**/+page.svelte ────────────────────────────────
  // The `+` files are SvelteKit's whole vocabulary, and only `+page.svelte` renders something
  // a person can open. `+layout` wraps other routes and has no address of its own; `+server`
  // answers requests rather than showing a screen. Both are left to the door reader in
  // adapters/source.js, because walking them as screens would photograph a JSON body and
  // call it a page.
  for (const routesDir of ['src/routes', 'routes']) {
    const files = await filesUnder(routesDir);
    for (const rel of files) {
      const name = rel.split('/').pop() ?? '';
      // `+page@.svelte` and `+page@named.svelte` reset which layout wraps the page. The part
      // after the @ says which layout, never which address, so it is ignored here.
      if (!/^\+page(@[^.]*)?\.(svelte|md|svx)$/.test(name)) continue;
      const url = urlFromFolders(rel);
      if (url === null) continue;
      add(url, path.posix.join(routesDir, rel), 'SvelteKit');
    }
    if (found.size > 0) break;
  }

  // ── Next.js app router: app/**/page.tsx ─────────────────────────────────
  for (const appDir of ['app', 'src/app']) {
    const files = await filesUnder(appDir);
    for (const rel of files) {
      const name = rel.split('/').pop() ?? '';
      if (!/^page\.([cm]?[jt]sx?|mdx?)$/.test(name)) continue;
      const url = urlFromFolders(rel);
      if (url === null) continue;
      add(url, path.posix.join(appDir, rel), 'the Next.js app router');
    }
  }

  // ── Remix and React Router file routes: app/routes/** ───────────────────
  // The dots in `blog.$slug.tsx` are the slashes. This is read only when the project says it
  // uses one of these routers, or when nothing in `app/` looks like a Next.js page — both
  // families own a folder called `app/`, and guessing between them invents addresses.
  const remixish = has('@remix-run/react') || has('@remix-run/node') || has('@remix-run/dev')
    || has('react-router') || has('@react-router/dev') || has('@react-router/fs-routes') || has('@remix-run/router');
  if (fs.existsSync(path.join(dir, 'app', 'routes')) && (remixish || !has('next'))) {
    const files = await filesUnder('app/routes');
    /** @type {Set<string>} */
    const ids = new Set();
    for (const rel of files) {
      const parts = rel.split('/');
      const name = /** @type {string} */ (parts[parts.length - 1]);
      if (NOT_A_ROUTE_FILE.test(name) || !/\.([cm]?[jt]sx?|mdx?)$/.test(name)) continue;
      const stem = name.replace(/\.([cm]?[jt]sx?|mdx?)$/, '');
      // Two shapes mean the same route: `blog.$slug.tsx` sitting on its own, and
      // `blog.$slug/route.tsx` with its helpers beside it. Anything else inside a route
      // folder is a file kept next to its route rather than a route.
      if (parts.length === 1) ids.add(stem);
      else if (stem === 'route' && parts.length === 2) ids.add(/** @type {string} */ (parts[0]));
    }
    for (const id of ids) {
      const url = remixUrl(id);
      if (url === null) continue;
      add(url, `app/routes/${id}`, 'Remix file routes');
    }
  }

  // ── Nuxt, Astro and the Next.js pages router: a folder called `pages` ───
  // Three frameworks, one folder name. Which one it is decides whether `pages/thing.ts` is a
  // page or a server endpoint, and only package.json knows. Where package.json says nothing,
  // the file extension does: `.vue` is Nuxt's and `.astro` is Astro's, and neither is ever
  // the other's.
  const astroish = has('astro');
  const nuxtish = has('nuxt') || has('nuxt3') || has('nuxt-edge');
  // A project routes one way, not three. Once SvelteKit's or Remix's tree has answered, a
  // folder called `pages` beside it is a folder of components — and reading `src/pages/utils.ts`
  // in a SvelteKit app as the address `/utils` would put a page that does not exist into the
  // settings and then report a 404 as a difference nobody caused.
  // Next.js is the exception: an app router and a pages router genuinely coexist in one
  // project, and half the site lives in each. Only the two families that own the WHOLE tree
  // rule the `pages` folder out.
  const alreadyRouted = families.has('SvelteKit') || families.has('Remix file routes');
  // `app/pages` is Nuxt 4's home and nobody else's. A Next.js app-router project with a real
  // folder called `app/pages` would otherwise gain an invented `/page` address on top of the
  // `/pages` one it genuinely has.
  const pagesFolders = alreadyRouted ? [] : nuxtish ? ['src/pages', 'pages', 'app/pages'] : ['src/pages', 'pages'];
  for (const pagesDir of pagesFolders) {
    const files = await filesUnder(pagesDir);
    for (const rel of files) {
      const name = rel.split('/').pop() ?? '';
      if (NOT_A_ROUTE_FILE.test(name) || name.startsWith('.')) continue;
      // `pages/api/**` is the Next.js pages router's server half, and there is no screen
      // behind it. It is a door, and doors are read in adapters/source.js.
      if (rel.startsWith('api/')) continue;

      const astroPage = /\.(astro|mdx?|markdown|html)$/.test(name);
      const vuePage = /\.vue$/.test(name);
      const scriptPage = /\.[cm]?[jt]sx?$/.test(name);
      /** @type {string|null} */
      let family = null;
      if (astroPage && (astroish || !nuxtish)) family = 'Astro';
      else if (vuePage) family = 'Nuxt';
      // A plain script in `src/pages` is an Astro ENDPOINT rather than a page, so under Astro
      // it is skipped here and left to the door reader. Under everything else this folder
      // belongs to a router where a script IS the page.
      else if (scriptPage && !astroish) family = nuxtish ? 'Nuxt' : 'the Next.js pages router';
      if (family === null) continue;

      const stem = name.replace(/\.[^.]+$/, '');
      if (stem.startsWith('_')) {
        // Nuxt 2 spelled a changing part `_id.vue` where everything else writes `[id]`. Under
        // Nuxt that underscore is a parameter; under everything else it is a framework hook
        // like `_app` or `_document`. Reading it the wrong way either invents an address or
        // loses one.
        const nuxtParam = family === 'Nuxt' && stem.length > 1 && !['_app', '_document', '_error', '_middleware'].includes(stem);
        if (!nuxtParam) continue;
      }
      const folders = urlFromFolders(rel);
      if (folders === null) continue;
      const leaf = stem === 'index' ? null : segmentFromLeaf(stem, family);
      if (stem !== 'index' && leaf === null) continue;
      add(leaf === null ? folders : `${folders}/${leaf}`, path.posix.join(pagesDir, rel), family);
    }
  }

  return {
    routes: [...found.values()].sort((a, b) => a.url.localeCompare(b.url)),
    families: [...families],
    where,
    unreadable,
    hitTheCap,
  };
}

/**
 * The last part of a page's address, taken from the filename rather than the folder.
 *
 * Only Nuxt 2 needs a rule of its own here: it wrote a changing part as `_id.vue` where every
 * other family writes `[id]`. Translating it means the coverage ledger names it the same way
 * as all the others and asks for a value in the same sentence.
 *
 * @param {string} stem
 * @param {string} family
 * @returns {string|null}
 */
function segmentFromLeaf(stem, family) {
  if (family === 'Nuxt' && stem.startsWith('_') && stem.length > 1) return `[${stem.slice(1)}]`;
  return segmentFromFolder(stem);
}

/**
 * A Remix route id turned into an address.
 *
 * Remix writes the whole path in the filename and uses dots for slashes, which makes five
 * rules that look like typos and are not:
 *
 *   `_index`          the index of whatever it sits under, so it adds nothing to the address
 *   `_auth.login`     a leading underscore is a layout with no address, so this is /login
 *   `app_.projects`   a trailing underscore only opts out of a layout, so this is /app/projects
 *   `sitemap[.]xml`   brackets escape a real full stop, so this is /sitemap.xml
 *   `$slug` and `$`   a changing part, and a catch-all for everything below
 *
 * @param {string} id
 * @returns {string|null}
 */
function remixUrl(id) {
  // Escaped literals come out first, because the dots inside them are full stops while every
  // other dot in the name is a slash. A space cannot appear in a route id, so it is safe to
  // stand in for one while the rest is split.
  /** @type {string[]} */
  const literals = [];
  const masked = id.replace(/\[([^\]]*)\]/g, (_, inner) => {
    literals.push(String(inner));
    return ` ${literals.length - 1} `;
  });
  /** @type {string[]} */
  const kept = [];
  for (const raw of masked.split('.')) {
    const piece = raw.replace(/ (\d+) /g, (_, n) => literals[Number(n)] ?? '');
    if (piece === '' || piece === '_index') continue;
    // A leading underscore is a layout that wraps other routes without adding to the address.
    if (piece.startsWith('_')) continue;
    // A trailing underscore says "do not nest inside the parent's layout". The address is the
    // same either way.
    const bare = piece.replace(/_$/, '');
    if (bare === '') continue;
    if (bare === '$') { kept.push('[...rest]'); continue; }
    if (bare.startsWith('$')) { kept.push(`[${bare.slice(1)}]`); continue; }
    kept.push(bare);
  }
  return `/${kept.join('/')}`.replace(/(.)\/$/, '$1');
}

/**
 * Values this project itself uses for the changing parts of its own addresses.
 *
 * WHY GUESSING IS NOT ALLOWED HERE. `/blog/[slug]` cannot be opened until somebody says which
 * post. Inventing one opens a page that does not exist, and a 404 compared against a 404
 * agrees with itself forever — a green tick over a page nobody has ever seen. So a value is
 * only ever taken from somewhere the project already wrote it down, and where it came from is
 * carried beside it and printed. Two places, in this order:
 *
 *   1. A LINK. `<a href="/blog/hello-world">` in the project's own source. The strongest
 *      evidence there is: the project ships that address to a person to click.
 *   2. A NAMED VALUE. `slug: 'hello-world'` in the project's own code, tests or fixtures.
 *      Weaker, so it is only used when no link fits, and it is only accepted when it is
 *      short and plainly a value rather than a sentence or a path.
 *
 * When neither exists the address is left unopened ON PURPOSE and reported as a door that was
 * found and not opened. That is the difference between this tool and a green tick.
 *
 * @param {{rel: string, text: string}[]} source
 * @returns {{links: {url: string, file: string}[], named: Map<string, {value: string, file: string}>}}
 */
function valuesTheProjectUses(source) {
  /** @type {Map<string, string>} url -> the file it was written in */
  const links = new Map();
  /** @type {Map<string, {value: string, file: string}>} */
  const named = new Map();

  // Only places that are unmistakably an address. A bare string beginning with a slash turns
  // up as a file path, a glob and a regular expression far more often than as a link, and
  // three wrong values are worse than none.
  const asAddress = /(?:href|to|action|formaction|goto|pathname)\s*[=:]\s*["'`](\/[^"'`\s{}]*)["'`]|(?:goto|push|replace|redirect|navigate|visit)\s*\(\s*(?:\d+\s*,\s*)?["'`](\/[^"'`\s{}]*)["'`]/gi;
  const asNamedValue = /\b(?:"|')?([A-Za-z_$][\w$]{0,40})(?:"|')?\s*[:=]\s*["'`]([A-Za-z0-9][A-Za-z0-9._~-]{0,63})["'`]/g;

  for (const one of source) {
    for (const hit of one.text.matchAll(asAddress)) {
      const url = (hit[1] ?? hit[2] ?? '').replace(/[?#].*$/, '').replace(/(.)\/$/, '$1');
      if (url === '' || url === '/' || url.includes('//')) continue;
      if (!links.has(url)) links.set(url, one.rel);
    }
    for (const hit of one.text.matchAll(asNamedValue)) {
      const name = /** @type {string} */ (hit[1]);
      if (named.has(name)) continue;
      named.set(name, { value: /** @type {string} */ (hit[2]), file: one.rel });
    }
  }
  return { links: [...links].map(([url, file]) => ({ url, file })), named };
}

/**
 * Fill in the changing parts of an address from a value the project itself uses, or leave it
 * unopened and say why.
 *
 * @param {FolderRoute[]} routes
 * @param {{links: {url: string, file: string}[], named: Map<string, {value: string, file: string}>}} known
 * @returns {FolderRoute[]}  The same routes, with `open` and `from` filled in where a real
 *   value was found. Anything still unopened keeps its `needs` so the ledger can name it.
 */
function fillChangingParts(routes, known) {
  // An address that is a route in its own right is never used as a value for another one.
  // `/blog/archive` beside `/blog/[slug]` is a page, not a slug, and borrowing it would open
  // the wrong page and call the changing one covered.
  const realRoutes = new Set(routes.map((route) => route.url));
  return routes.map((route) => {
    if (route.open !== null || route.needs.length === 0) return route;

    for (const link of known.links) {
      if (realRoutes.has(link.url)) continue;
      const values = matchAddress(route.url, link.url);
      if (values === null) continue;
      return {
        ...route,
        open: link.url,
        from: `${describeValues(values)}, which is the address ${link.file} links to`,
      };
    }

    // No link fits, so each changing part is asked for by name. All of them have to be
    // answered: half an address is not an address, and opening `/blog/[slug]` with the slug
    // still in it would ask the site for a page whose name is a pair of square brackets.
    /** @type {Record<string, string>} */
    const values = {};
    /** @type {string[]} */
    const files = [];
    for (const need of route.needs) {
      const guessFree = known.named.get(need);
      if (guessFree === undefined) return route;
      values[need] = guessFree.value;
      if (!files.includes(guessFree.file)) files.push(guessFree.file);
    }
    let open = route.url;
    for (const [name, value] of Object.entries(values)) {
      open = open.replace(new RegExp(`\\[\\.{0,3}${name}(=[^\\]]*)?\\]`), encodeURIComponent(value));
    }
    return { ...route, open, from: `${describeValues(values)}, taken from ${plainly(files)} where this project sets it` };
  });
}

/**
 * Does this literal address fit that pattern, and if so what does each changing part become?
 *
 * @param {string} pattern  `/blog/[slug]`
 * @param {string} literal  `/blog/hello-world`
 * @returns {Record<string, string>|null}
 */
function matchAddress(pattern, literal) {
  const want = pattern.split('/').filter((s) => s !== '');
  const got = literal.split('/').filter((s) => s !== '');
  /** @type {Record<string, string>} */
  const values = {};
  for (let i = 0; i < want.length; i += 1) {
    const segment = /** @type {string} */ (want[i]);
    if (!segment.startsWith('[')) {
      if (got[i] !== segment) return null;
      continue;
    }
    const inner = segment.replace(/^\[\[(.*)\]\]$/, '$1').replace(/^\[(.*)\]$/, '$1');
    const name = inner.replace(/^\.{3}/, '').replace(/=.*$/, '');
    if (inner.startsWith('...')) {
      // A catch-all swallows everything left, so it has to be last and there has to be
      // something for it to swallow.
      const rest = got.slice(i);
      if (i !== want.length - 1 || rest.length === 0) return null;
      values[name] = rest.join('/');
      return values;
    }
    const value = got[i];
    if (value === undefined || value === '') return null;
    values[name] = value;
  }
  return got.length === want.length ? values : null;
}

/**
 * "the slug is hello-world" — the sentence that goes beside an address so nobody has to
 * wonder whether a value was invented.
 *
 * @param {Record<string, string>} values
 * @returns {string}
 */
function describeValues(values) {
  return plainly(Object.entries(values).map(([name, value]) => `${name} is "${value}"`));
}

// ---------------------------------------------------------------------------
// Screens: read whatever this app actually uses to decide what to show
// ---------------------------------------------------------------------------

/**
 * How this web app decides what to show, and what that means for reaching a screen.
 *
 * @typedef {object} Router
 * @property {'files'|'declared'|'hash'|'tabs'|'single'} kind
 * @property {string|null} where   The file the answer came out of.
 * @property {string} why          One plain sentence, safe to put in front of a person.
 */

/**
 * One screen worth walking, and how to get to it.
 *
 * @typedef {object} Screen
 * @property {string} name
 * @property {string} url
 * @property {Record<string, string>[]} [steps]
 * @property {string} [describe]
 */

/**
 * Every route a router declares, plus the screens a router does not declare at all.
 *
 * TWO FAILURES THIS EXISTS TO STOP, and they are opposite halves of one mistake.
 *
 * READING ONLY THE FOLDERS. A single-page app is one HTML file, so reading folder names finds
 * one screen and reports it as the whole product. Terminal Deck's phone client is exactly
 * that: one `index.html`, and four screens a person moves between all day. It was checked for
 * months of pretend coverage — one page walked, three unwatched, and a clean run every time.
 *
 * READING ONLY THE ROUTERS. The correction to the first one went too far, and for a year this
 * function looked for a route TABLE and nothing else. Every modern framework builds its
 * addresses out of the folder layout instead, and there is no table anywhere to find.
 * Measured on 2026-08-31 by somebody using the tool as a stranger: a three-page SvelteKit
 * site, 0 routes reported, the front page opened, "the website covered in full". Two pages
 * of three never opened, and the coverage ledger never named them.
 *
 * Five readings, in order of how much the app itself has settled the question, and every one
 * names the file it came from:
 *
 *   1. THE FOLDER LAYOUT — SvelteKit, both Next.js routers, Nuxt, Astro, Remix. Where the
 *      folders ARE the routing there is nothing to interpret: the layout is the answer.
 *   2. DECLARED ROUTES — `path: '/x'` in a route table, `<Route path="/x">`, the shape every
 *      router library from React Router to Vue Router to Angular writes.
 *   3. HASH ROUTES — a `#name` compared against the address bar. A real address, reachable by
 *      opening it, and only reported when the code actually reads `location.hash`.
 *   4. TABS — an object literal pairing a screen name with the label on the control that
 *      switches to it. Not an address: a click, and it is written as one. A made-up
 *      `#address` that silently lands on the same page is worse than nothing: it turns three
 *      unchecked screens into three identical checks that agree with each other forever.
 *   5. NOTHING FOUND — one page, said plainly, so the coverage ledger can say so too.
 *
 * @param {string} dir
 * @param {(name: string) => boolean} [has]   Is this package a dependency? A project that
 *   installs a router library is a project whose route tables mean what they say, and that
 *   fact lives in package.json rather than in the file the table is written in.
 * @param {string[]} [alreadyListed]   Addresses something else in this run already turns into
 *   a journey — today that is the page reader in adapters/web.js, which knows the two Next.js
 *   routers. Those are not repeated in the settings, because a page listed twice is walked
 *   twice and every run costs double for nothing. They are still COUNTED, so the sentence
 *   this function writes about the router is about the whole site rather than the remainder.
 * @returns {Promise<{screens: Screen[], router: Router, needValues: {url: string, names: string[]}[]}>}
 */
async function readScreens(dir, has = () => false, alreadyListed = []) {
  const { files, tooBig } = await readSome(dir, { most: 200, depth: 5 });
  const source = files.filter((f) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(f.rel));

  // ── 1: the folder layout, where the folder layout IS the routing ──────────
  // This runs first and, when it finds anything, it is the final answer. A SvelteKit project
  // that also happens to install a router library still gets its addresses from its folders,
  // and reading the library's table instead would invent a second, wrong list.
  const layout = await readFolderRoutes(dir, has);
  if (layout.routes.length > 0) {
    // Values are hunted for in the project's OWN files, tests and fixtures included — a test
    // that opens `/blog/hello-world` is the project telling us that post exists. Nothing is
    // ever invented; see {@link valuesTheProjectUses}.
    const filled = fillChangingParts(layout.routes, valuesTheProjectUses(files));
    const already = new Set(alreadyListed);
    /** @type {Screen[]} */
    const screens = [];
    /** @type {{url: string, names: string[]}[]} */
    const needValues = [];
    for (const route of filled) {
      if (route.open === null) {
        // FOUND AND NOT OPENED, and named as such. Skipping it silently would be the same
        // false all-clear in a smaller box: the ledger would count the pages it walked and
        // never mention the one it could not.
        needValues.push({ url: route.url, names: route.needs });
        continue;
      }
      if (already.has(route.url)) continue;
      screens.push({
        name: route.url === '/' ? 'the front page' : route.url,
        url: route.open,
        describe: route.from === null
          ? `open ${route.open} and read what the screen says every control is and does`
          : `open ${route.open} and read what the screen says every control is and does — ${route.from}`,
      });
    }
    const walked = filled.filter((route) => route.open !== null).length;
    const holes = [
      layout.unreadable.length > 0
        ? ` ${plainly(layout.unreadable.slice(0, 3))}${layout.unreadable.length > 3 ? ' and others' : ''} could not be opened, so any page under ${layout.unreadable.length === 1 ? 'it' : 'them'} is missing from this list entirely.`
        : '',
      layout.hitTheCap ? ` There were more than ${MOST_ROUTE_FILES} files in the route folders, so the walk stopped early and this list may be short.` : '',
    ].join('');
    return {
      screens,
      needValues,
      router: {
        kind: 'files',
        where: layout.where,
        why: `${filled.length} address${filled.length === 1 ? ' is' : 'es are'} built out of the folder layout, the way ${plainly(layout.families)} does it — starting at ${layout.where}. ${walked} of them can be opened as ${walked === 1 ? 'it stands' : 'they stand'}${needValues.length > 0 ? `, and ${needValues.length} ${needValues.length === 1 ? 'has a changing part in it and is' : 'have a changing part in them and are'} waiting on a real value, listed below rather than dropped` : ''}.${holes}`,
      },
    };
  }

  // ── 2: routes a router library declares ───────────────────────────────────
  /** @type {Map<string, Screen>} */
  const declared = new Map();
  /** @type {string|null} */
  let declaredIn = null;
  const routerInstalled = ['react-router', 'react-router-dom', 'vue-router', '@tanstack/react-router', '@tanstack/router', 'wouter', 'svelte-spa-router', 'svelte-routing', '@reach/router', '@angular/router', 'vue-router-next'].some(has);
  const looksLikeARouter = /react-router|vue-router|@tanstack\/(react-)?router|wouter|svelte-spa-router|@angular\/router|createBrowserRouter|createHashRouter|createMemoryRouter|createRouter|createWebHistory|useRoutes|RouterModule|\b[Rr]outes\s*[:=]\s*\[|defineRoutes/;
  for (const one of source) {
    /** @type {string[]} */
    const paths = [];
    // A JSX route element says what it is on its own. A bare `path:` does not — it turns up in
    // build configs, in file helpers, in anything — so it only counts inside a file that names
    // a router. Two path-shaped strings in an unrelated file were enough to invent a list of
    // screens and to hide the fact that the app had no addresses at all.
    for (const hit of one.text.matchAll(/<Route\b[^>]*\bpath\s*=\s*["'{`]([^"'`}]+)/g)) paths.push(hit[1]);
    if (routerInstalled || looksLikeARouter.test(one.text)) {
      for (const hit of one.text.matchAll(/\bpath\s*:\s*['"]([^'"]*)['"]/g)) paths.push(hit[1]);
      for (const hit of one.text.matchAll(/^\s*['"](\/[^'"]*)['"]\s*:\s*[A-Za-z_$]/gm)) paths.push(hit[1]);
    }
    for (const raw of paths) {
      const url = tidyRoute(raw);
      if (!url) continue;
      if (declared.has(url)) continue;
      declared.set(url, { name: url === '/' ? 'the front page' : url, url });
      declaredIn = declaredIn ?? one.rel;
    }
    if (declared.size >= 60) break;
  }
  if (declared.size >= 2) {
    // An address with a changing part in it — /reports/:id — cannot be opened until somebody
    // says which report. Writing it into the settings as it stands would open a page that
    // does not exist and report a difference nobody caused, so it is held back and named
    // instead: the settings say which addresses are waiting on a value, and the set-up list
    // asks for one. Dropping them silently would be the worse half of the same choice.
    /** @type {{url: string, names: string[]}[]} */
    const needValues = [];
    /** @type {Screen[]} */
    const openable = [];
    for (const screen of declared.values()) {
      const names = [...screen.url.matchAll(/:([A-Za-z_$][\w$]*)|\[\.{0,3}([^\]]+)\]|\{([^}]+)\}/g)].map((hit) => hit[1] ?? hit[2] ?? hit[3]);
      if (names.length > 0) needValues.push({ url: screen.url, names });
      else openable.push(screen);
    }
    return {
      screens: openable,
      needValues,
      router: {
        kind: 'declared',
        where: declaredIn,
        why: `${declared.size} addresses are declared in a router, starting in ${declaredIn}. Each one is opened directly${needValues.length > 0 ? (needValues.length === 1 ? ', except one that has a changing part in it and is waiting on a real value' : `, except ${needValues.length} that have a changing part in them and are waiting on a real value`) : ''}.`,
      },
    };
  }

  // ── 3: hash routes ────────────────────────────────────────────────────────
  const readsHash = source.find((f) => /location\.hash|hashchange|useHashLocation|createWebHashHistory|HashRouter/.test(f.text));
  if (readsHash) {
    /** @type {Map<string, Screen>} */
    const hashes = new Map();
    for (const one of source) {
      for (const hit of one.text.matchAll(/['"`]#([A-Za-z][\w-]{0,40})['"`]/g)) {
        const url = `/#${hit[1]}`;
        if (!hashes.has(url)) hashes.set(url, { name: `the ${hit[1]} screen`, url });
      }
      if (hashes.size >= 40) break;
    }
    if (hashes.size >= 2) {
      return {
        screens: [{ name: 'the front page', url: '/' }, ...hashes.values()],
        needValues: [],
        router: {
          kind: 'hash',
          where: readsHash.rel,
          why: `${readsHash.rel} switches screens on the part of the address after the #, so each screen has an address of its own and is opened directly.`,
        },
      };
    }
  }

  // ── 4: a strip of tabs ────────────────────────────────────────────────────
  /** @type {Map<string, Screen>} */
  const tabs = new Map();
  /** @type {string|null} */
  let tabsIn = null;
  const pair = /\{[^{}]*?\b(?:screen|view|tab|page|panel|route)\s*:\s*['"]([A-Za-z][\w-]{0,40})['"][^{}]*?\b(?:label|title|text|name|caption)\s*:\s*['"]([^'"]{1,40})['"][^{}]*?\}/g;
  const flipped = /\{[^{}]*?\b(?:label|title|text|caption)\s*:\s*['"]([^'"]{1,40})['"][^{}]*?\b(?:screen|view|tab|page|panel|route)\s*:\s*['"]([A-Za-z][\w-]{0,40})['"][^{}]*?\}/g;
  for (const one of source) {
    for (const hit of one.text.matchAll(pair)) {
      if (!tabs.has(hit[1])) tabs.set(hit[1], tabScreen(hit[1], hit[2]));
      tabsIn = tabsIn ?? one.rel;
    }
    for (const hit of one.text.matchAll(flipped)) {
      if (!tabs.has(hit[2])) tabs.set(hit[2], tabScreen(hit[2], hit[1]));
      tabsIn = tabsIn ?? one.rel;
    }
    if (tabs.size >= 20) break;
  }
  if (tabs.size >= 2) {
    return {
      screens: [{ name: 'the page as it opens', url: '/' }, ...tabs.values()],
      needValues: [],
      router: {
        kind: 'tabs',
        where: tabsIn,
        why: `The address never changes: ${tabsIn} switches between ${tabs.size} screens in code, and each one is reached by clicking the control that says its name. That is why they are written as clicks and not as addresses — opening a made-up address would land on the same screen every time and report it as checked. The list below is the page as it opens, and then those ${tabs.size}.`,
      },
    };
  }

  return {
    screens: [],
    needValues: [],
    router: {
      kind: 'single',
      where: null,
      why: tooBig.length > 0
        ? `Nothing that was read declares an address for a second screen, so this is read as one page — but ${plainly(tooBig.slice(0, 3))}${tooBig.length > 3 ? ' and others' : ''} ${tooBig.length === 1 ? 'was' : 'were'} too big to open, and a router in there would not have been seen. Name the screens under "web.screens" rather than trusting this.`
        : 'Nothing here declares an address for a second screen, so this is read as one page. If it has more, name them under "web.screens" with the clicks that reach them.',
    },
  };
}

/**
 * One screen reached by clicking the tab that names it.
 *
 * The click is written as Playwright's text selector rather than a CSS one, because the name
 * on the control is the only thing known here — and it is the right thing to aim at anyway,
 * since it is what a person reads and what a screen reader says.
 *
 * @param {string} id
 * @param {string} label   The words actually on the control, taken from the same object the
 *                         screen's own name came out of. Reconstructing a label from the id
 *                         would guess at capitalisation and spacing and be wrong about both.
 * @returns {Screen}
 */
function tabScreen(id, label) {
  return {
    name: `the ${id.replace(/[-_]/g, ' ')} screen`,
    url: '/',
    steps: [{ click: `text=${label}` }],
    describe: `open the front page, click ${label}, and read what that screen says every control is and does`,
  };
}

/**
 * A route as an address somebody can open, or nothing at all.
 *
 * Route tables are full of strings that are not addresses — a `path` in a build config, a
 * relative fragment, a catch-all. Anything that is not plainly an address is dropped rather
 * than opened, because an address that 404s reports a difference nobody caused.
 *
 * @param {string} raw
 * @returns {string|null}
 */
function tidyRoute(raw) {
  const text = String(raw).trim();
  if (text === '' || text === '*' || text === '**') return null;
  if (!text.startsWith('/')) return null;
  if (/[\\<>{}()\s]/.test(text)) return null;
  if (/\.(js|ts|tsx|jsx|css|json|png|svg|html)$/.test(text)) return null;
  if (text.includes('*')) return null;
  if (text.length > 120) return null;
  return text;
}

// ---------------------------------------------------------------------------
// Starting a web app without hanging
// ---------------------------------------------------------------------------

/**
 * The command that boots this web app for a check, and why it is that one.
 *
 * THE FAULT THIS FIXES. The first answer here was "whatever `npm run dev` is", and a dev
 * server never exits. That is fine for the browser check, which waits for the port and then
 * walks the page — and it is a hang anywhere the same command is treated as something that
 * finishes. Worse, a dev server is not the thing anybody ships: it serves unbundled source
 * with a live-reload socket wired into every page, which is a second thing changing under the
 * comparison for reasons that have nothing to do with the change.
 *
 * So the order is: build it and then serve what was built; and only if there is no way to do
 * that, the dev server — with the reason written down, because the run has to say which of
 * the two it used.
 *
 * @param {object} input
 * @param {Record<string, string>} input.scripts
 * @param {(name: string) => boolean} input.has     Is this package a dependency?
 * @param {string} input.dir                        The folder this product lives in, absolute.
 * @param {{files: string[], dirs: string[]}} input.listing
 * @returns {{command: string|null, kind: 'build-and-serve'|'build-and-start'|'dev'|'static'|'none', why: string}}
 */
function startCommandFor(input) {
  const { scripts, has, dir, listing } = input;
  const script = (/** @type {string} */ name) => (typeof scripts[name] === 'string' ? `npm run ${name}` : null);
  const build = script('build');

  // A framework that serves its own build, and reads PORT while doing it. `next start`,
  // `nuxt start` and their cousins are the real thing a person deploys, not an approximation
  // of it.
  const servesItsOwnBuild = ['next', 'nuxt', '@remix-run/serve', '@remix-run/node', '@adonisjs/core'].some(has);
  if (build && servesItsOwnBuild && script('start')) {
    return {
      command: `${build} && ${script('start')}`,
      kind: 'build-and-start',
      why: 'It is built and then started the way it is deployed, so what is checked is what ships. The framework reads the PORT it is given.',
    };
  }

  // Vite and everything built on it ship a `preview` command whose whole job is to serve the
  // build. It takes the port as a flag, so nothing has to be downloaded to serve the files.
  if (build && script('preview') && (has('vite') || has('astro') || has('@sveltejs/kit'))) {
    return {
      // `--host 127.0.0.1` is not decoration. Measured on 2026-08-31 on an app scaffolded a
      // minute earlier with `npm create vite@latest -- --template react-ts`: Vite ignores both
      // the PORT and the HOST it is handed in the environment and binds the NAME `localhost`,
      // which macOS resolves to the IPv6 loopback — so the site came up on `[::1]` and nothing
      // whatever was listening on `127.0.0.1`. Naming the address makes the command land where
      // the settings say it will, instead of wherever name resolution happens to put it.
      command: `${build} && ${script('preview')} -- --port $PORT --strictPort --host 127.0.0.1`,
      kind: 'build-and-serve',
      why: 'It is built, and then the build is served by the tool that made it. That is what ships — a dev server serves unbundled source with a live-reload connection in every page, which is a second thing moving under the comparison.',
    };
  }

  // Built, but with nothing that serves the result. Anything that serves a folder on the port
  // it is given will do, and the folder is read out of the build config rather than guessed.
  if (build) {
    const outDir = staticOutputOf(dir, listing, has);
    if (outDir) {
      return {
        command: `${build} && npx --yes serve -s ${outDir} -l $PORT`,
        kind: 'build-and-serve',
        why: `It is built into ${outDir}/, and those files are then served on the port the check gives it. \`serve\` is fetched the first time this runs and cached after that.`,
      };
    }
  }

  const dev = script('dev') ?? script('serve') ?? script('start');
  if (dev) {
    return {
      command: dev,
      kind: 'dev',
      why: 'Nothing here builds a copy that can be served on its own, so the development server is used. It never exits, and it is not meant to: the check knows it is ready when the port answers, not when the command finishes. What is checked is the development build rather than the one that ships.',
    };
  }

  const flat = listing.files.filter((f) => f.endsWith('.html'));
  if (flat.length > 0) {
    return {
      command: 'npx --yes serve -l $PORT .',
      kind: 'static',
      why: 'These are plain files with nothing to build, so anything that serves this folder on the port it is given will do.',
    };
  }

  return { command: null, kind: 'none', why: 'Nothing here says how to start it.' };
}

/**
 * Where a build puts the files a browser asks for, read out of the build config where it says
 * so and taken from the framework's own habit where it does not.
 *
 * @param {string} dir
 * @param {{files: string[], dirs: string[]}} listing
 * @param {(name: string) => boolean} has
 * @returns {string|null}
 */
function staticOutputOf(dir, listing, has) {
  for (const file of listing.files) {
    if (!/^(vite|rollup|webpack|rsbuild|parcel|astro|svelte)\.config\.[cm]?[jt]s$/.test(file)) continue;
    /** @type {string} */
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    const hit = /out(?:Dir|dir|put(?:Dir|Path))\s*:\s*['"]([^'"]+)['"]/.exec(text);
    if (hit) return hit[1].replace(/\/+$/, '');
  }
  /** @type {string[]} */
  const guesses = has('react-scripts') ? ['build', 'dist'] : ['dist', 'build', 'public', 'out'];
  for (const guess of guesses) {
    if (fs.existsSync(path.join(dir, guess, 'index.html'))) return guess;
  }
  // Nothing built yet, so the habit of whatever built it is the best that can be said, and
  // the settings say which one was assumed.
  if (has('vite') || has('astro') || has('rollup') || has('parcel')) return 'dist';
  if (has('react-scripts')) return 'build';
  if (has('webpack')) return 'dist';
  return null;
}

// ---------------------------------------------------------------------------
// How big this repository is, which decides whether a check can copy it
// ---------------------------------------------------------------------------

/**
 * What copying this project would cost, and whether there is room for it.
 *
 * Three of the adapters copy the whole project into a scratch folder before running it, which
 * is the right thing to do — a check must never write into somebody's working copy. It also
 * means a repository carrying nine gigabytes of Xcode build output and a folder of installers
 * cannot be checked in place on a laptop with twelve gigabytes free. That is not a bug in the
 * copy, it is a fact about the folder, and the only useful moment to say it is now: the whole
 * answer is one line — run the check from a `git worktree`, which holds the tracked files and
 * nothing else.
 *
 * Bounded and early-stopping: the question is only "is this big", and once the answer is yes
 * there is nothing left to learn by counting further.
 *
 * @param {string} root
 * @returns {Promise<{bytes: number, files: number, capped: boolean, biggest: {folder: string, bytes: number}[], freeBytes: number|null, tooBig: boolean, why: string}>}
 */
async function measureBulk(root) {
  /** @type {number|null} */
  let freeBytes = null;
  try {
    const stats = await fsp.statfs(root);
    freeBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    freeBytes = null;
  }

  // Stop as soon as the answer is settled rather than at a round number. A paired run holds
  // two copies at once, so the moment two and a half copies would not fit, counting further
  // tells nobody anything new — and on a folder that is genuinely enormous, counting further
  // is the slowest thing this file does.
  const wouldNotFit = freeBytes === null ? 25 * 1024 * 1024 * 1024 : freeBytes / 2.5;
  const STOP_AT = Math.min(25 * 1024 * 1024 * 1024, Math.max(wouldNotFit * 1.05, 2 * 1024 * 1024 * 1024));
  const MOST = 60_000;
  let bytes = 0;
  let files = 0;
  let capped = false;
  /** @type {Map<string, number>} */
  const perFolder = new Map();

  const top = await listOnce(root);
  for (const folder of [...top.dirs, '.']) {
    if (folder === '.git' || (folder !== '.' && folder.startsWith('.') && folder !== '.output')) continue;
    let here = 0;
    /**
     * @param {string} dir
     * @param {number} depth
     * @returns {Promise<void>}
     */
    const walk = async (dir, depth) => {
      if (files > MOST || bytes > STOP_AT || depth > 12) return;
      /** @type {import('node:fs').Dirent[]} */
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files > MOST || bytes > STOP_AT) {
          capped = true;
          return;
        }
        if (entry.isSymbolicLink() || entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (folder === '.' && depth === 0) continue;   // the top-level folders get their own turn
          await walk(full, depth + 1);
          continue;
        }
        files += 1;
        try {
          const info = await fsp.stat(full);
          bytes += info.size;
          here += info.size;
        } catch {
          // A file that cannot be measured is a file that will not copy either; the copy says
          // so at the time, and guessing a size for it here would help nobody.
        }
      }
    };
    await walk(folder === '.' ? root : path.join(root, folder), 0);
    if (here > 0) perFolder.set(folder === '.' ? 'the files at the top' : folder, here);
  }

  const biggest = [...perFolder.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([folder, size]) => ({ folder, bytes: size }));

  // Two copies at once is the shape a paired run takes, so the room needed is twice the size
  // plus a margin. Under a gigabyte nothing is worth saying.
  const tooBig = bytes > 1024 * 1024 * 1024 && (freeBytes === null || freeBytes < bytes * 2.5);
  return {
    bytes,
    files,
    capped,
    biggest,
    freeBytes,
    tooBig,
    why: tooBig
      ? `This folder is ${inGigabytes(bytes)}${capped ? ' or more' : ''}${biggest.length > 0 ? ` — most of it in ${plainly(biggest.map((b) => `${b.folder}/ (${inGigabytes(b.bytes)})`))}` : ''}, and a check copies the whole thing before running it${freeBytes === null ? '' : `, with only ${inGigabytes(freeBytes)} free on this disk`}. Two copies will not fit.`
      : capped
        ? `This folder is at least ${inGigabytes(bytes)}${biggest.length > 0 ? `, most of it in ${plainly(biggest.map((b) => `${b.folder}/`))}` : ''}, and counting stopped there. A check copies the whole thing before running it${freeBytes === null ? '' : `, and there is ${inGigabytes(freeBytes)} free`}. If one ever runs out of room, run it from a \`git worktree\` copy, which holds only the tracked files.`
        : `This folder is ${inGigabytes(bytes)}, which copies without trouble.`,
  };
}

/**
 * A size a person can read.
 * @param {number} bytes
 * @returns {string}
 */
function inGigabytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/**
 * Which folders the contract channel should read.
 *
 * The default list is the usual ones — src, lib, app and so on — and on a repository that
 * makes one thing that is right. On a repository that makes five, it reads the desktop app
 * and misses the phone client, the relay and the host, and every door behind them is counted
 * as absent rather than unread. So the folders every product lives in are named, plus any
 * folder holding real source that no product claimed, because an unclaimed folder is exactly
 * where a silent gap lives.
 *
 * @param {string} root
 * @param {Product[]} products
 * @param {{files: string[], dirs: string[]}} listing
 * @returns {Promise<string[]>}
 */
async function proposeSourceFolders(root, products, listing) {
  // Code at the top level belongs to no folder, and the reader only takes folders. So the
  // settings this writes have to say "the whole project" rather than name a folder that would
  // leave the project's own `server.js` unopened for good — the same silence
  // {@link whereTheCodeIs} exists to stop, except written down and kept.
  if (rootHoldsItsOwnCode(listing)) return ['.'];

  /** @type {Set<string>} */
  const folders = new Set();
  for (const name of USUAL_SOURCE_FOLDERS) if (listing.dirs.includes(name)) folders.add(name);

  for (const product of products) {
    if (product.where === '.' || product.where === '') continue;
    if (BUILD_OUTPUT_DIRS.some((out) => product.where === out || product.where.startsWith(`${out}/`))) continue;
    // A phone app is Swift or Kotlin, and this reader reads neither. Its own adapter reads
    // it. Naming its folder here would send the contract channel into a tree it can find
    // nothing in, and a folder that answers with nothing reads exactly like one that has
    // gone empty.
    if (product.kind === 'ios' || product.kind === 'android' || product.kind === 'desktopNative') continue;
    // A product's own source, one level in where there is one, so a folder of build output
    // beside it is not read as source.
    /** @type {string|null} */
    let pick = null;
    for (const inner of ['src', 'source', 'lib']) {
      if (fs.existsSync(path.join(root, product.where, inner))) {
        pick = path.posix.join(product.where, inner);
        break;
      }
    }
    folders.add(pick ?? product.where);
  }

  for (const folder of listing.dirs) {
    if (SKIP_DIRS.has(folder) || folder.startsWith('.')) continue;
    if (NOT_A_SHIPPED_PROGRAM.has(folder) && folder !== 'scripts' && folder !== 'tools') continue;
    // Already covered, either by name or by something more precise inside it. A product that
    // said "read pwa/src" must not have "read pwa" added over the top of it — that would pull
    // in pwa/dist, and a folder of bundled output read as source is thousands of doors that
    // do not exist.
    if ([...folders].some((f) => f === folder || f.startsWith(`${folder}/`))) continue;
    // A folder a product already spoke for is not an unclaimed one. A phone app's folder
    // holds a handful of build scripts, which is enough files to look like source, and it is
    // read by the adapter that understands the language it is written in.
    if (products.some((p) => p.where === folder)) continue;
    const code = await countMatching(path.join(root, folder), /\.[cm]?[jt]sx?$/);
    if (code >= 3) folders.add(folder);
  }

  // Only folders with code the reader can actually read, and never one that sits inside
  // another one already on the list. An iPhone app's Swift and an Android app's Kotlin are
  // real source and are read by their own adapters; naming them here would put two folders in
  // the settings that the contract channel opens, walks and finds nothing in, which reads
  // exactly like a folder that has gone empty.
  /** @type {string[]} */
  const kept = [];
  for (const folder of [...folders].sort()) {
    if (kept.some((already) => folder === already || folder.startsWith(`${already}/`))) continue;
    const code = await countMatching(path.join(root, folder), /\.[cm]?[jt]sx?$/);
    if (code === 0) continue;
    kept.push(folder);
  }
  return kept;
}

/**
 * Servers hiding in folders nothing claimed.
 *
 * Runs after every other reading, on the folders nobody spoke for. Terminal Deck's `relay/` is
 * the case: three TypeScript files, no package.json, no framework, no script — and it is the
 * switchboard every phone in the product connects through. It was reported as "a folder
 * nothing could work out", which is honest and useless, while its routes went uncounted and a
 * clean run said nothing about it.
 *
 * @param {object} input
 * @param {string} input.root
 * @param {{files: string[], dirs: string[]}} input.listing
 * @param {Product[]} input.products
 * @param {Set<string>} input.available
 * @returns {Promise<Product[]>}
 */
async function findServersInCode(input) {
  const { root, listing, products, available } = input;
  /** @type {Product[]} */
  const found = [];
  const claimed = new Set(products.map((p) => p.where));

  for (const folder of listing.dirs) {
    if (SKIP_DIRS.has(folder) || folder.startsWith('.') || claimed.has(folder)) continue;
    if (ALREADY_COVERED.has(folder) || NOT_A_SHIPPED_PROGRAM.has(folder)) continue;
    const dir = path.join(root, folder);
    const reading = await looksLikeAServer(dir);
    if (!reading.yes) continue;

    // How it is started, if anything here says. A shell script or a container file beside the
    // code is not a command this tool can run, but it IS the answer written down — so it is
    // named, and the agent that reads it can write one line of settings instead of a person
    // being asked a question they would have to go and look up.
    const local = await listOnce(dir);
    const recipe = local.files.find((f) => /^(deploy|start|run|serve)\.(sh|bash|mjs|js|ts)$/.test(f))
      ?? local.files.find((f) => f === 'Dockerfile' || /^(docker-)?compose\.ya?ml$/.test(f))
      ?? null;

    found.push({
      kind: 'server',
      name: `the server in ${folder}/`,
      surface: 'server',
      adapter: available.has('http') ? 'http' : null,
      confidence: 0.7,
      why: reading.why.replace(reading.file ?? '', path.posix.join(folder, reading.file ?? '')),
      where: folder,
      evidence: [
        { where: path.posix.join(folder, reading.file ?? ''), means: 'This file opens a socket and waits for requests, which is a server whatever else is or is not here.' },
        ...(recipe ? [{ where: path.posix.join(folder, recipe), means: `${recipe} says how this is built and started. It is not a command this tool can run, but it is the answer written down.` }] : []),
      ],
      built: { found: false, where: null, how: 'nothing to build — it runs from source' },
      blockers: [
        recipe
          ? `Nothing in package.json starts it. ${path.posix.join(folder, recipe)} already says how it is built and run — read that, and put the one command it comes down to under "http" in the settings, with the port taken from PORT.`
          : `Nothing here says how to start it, so its routes can be listed from the source but none of them can be asked anything. Put {"start": "..."} under "http" in the settings, listening on the PORT it is given.`,
      ],
      suggest: { stateless: true },
    });
  }
  return found;
}

/**
 * Is `project.yml` here an XcodeGen spec, rather than some other project's `project.yml`?
 *
 * Read rather than assumed, because `project.yml` is a common enough filename that treating
 * every one of them as an Apple project would report an iPhone app in repositories that have
 * never seen a Mac. An XcodeGen spec always names the project and always lists either targets
 * or schemes, and it is a small file, so the certain answer is two lines away.
 *
 * @param {string} dir
 * @param {{files: string[], dirs: string[]}} listing
 * @returns {boolean}
 */
function isXcodeGenSpec(dir, listing) {
  const name = listing.files.find((f) => f === 'project.yml' || f === 'project.yaml');
  if (!name) return false;
  /** @type {string} */
  let text = '';
  try {
    const info = fs.statSync(path.join(dir, name));
    if (info.size > 400_000) return false;
    text = fs.readFileSync(path.join(dir, name), 'utf8');
  } catch {
    return false;
  }
  if (!/^\s*name\s*:/m.test(text)) return false;
  return /^\s*(targets|schemes|packages|settingGroups)\s*:/m.test(text)
    || /bundleIdPrefix|deploymentTarget|SDKROOT|xcodegen/i.test(text);
}

/**
 * The folder names this repository tells git to leave alone.
 *
 * Used for one question only: is this folder something a build wrote, or something somebody
 * committed? A name is not enough to answer it — `build/` is a bundler's output in one
 * repository and hand-written artwork scripts in the next — and the repository has already
 * written the answer down.
 *
 * Deliberately shallow: only plain folder names, no globs, no negations, no nested ignore
 * files. Anything cleverer would be re-implementing git's matching to answer a question where
 * being unsure costs nothing — a folder that is missed here is simply not read for a second
 * product, and everything else about the run is unchanged.
 *
 * @param {string} root
 * @returns {Promise<Set<string>>}
 */
async function readIgnoreList(root) {
  /** @type {Set<string>} */
  const names = new Set();
  const text = await readTextIfSmall(path.join(root, '.gitignore'), 200_000);
  if (text === null) return names;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    if (line.includes('?') || line.includes('[')) continue;
    // `dist/**` and `dist/*` say the same thing about the folder as `dist` does. Anything
    // else with a star in it is a pattern rather than a folder and is left alone.
    const withoutGlob = line.replace(/\/\*+$/, '');
    if (withoutGlob.includes('*')) continue;
    const name = withoutGlob.replace(/^\/+/, '').replace(/\/+$/, '');
    if (name === '' || name.includes('/')) continue;
    names.add(name);
  }
  return names;
}

/**
 * The application id out of a packaging config, when package.json does not carry one.
 *
 * electron-builder reads either, and plenty of projects keep everything about packaging in
 * its own file. The id is what lets the desktop adapter tell the window it opened from a
 * window of the same app that was already there, so losing it is not cosmetic.
 *
 * @param {string} dir
 * @param {string|null} builderFile
 * @returns {string|null}
 */
function appIdInConfig(dir, builderFile) {
  if (!builderFile) return null;
  const text = (() => {
    try {
      const info = fs.statSync(path.join(dir, builderFile));
      if (info.size > 400_000) return '';
      return fs.readFileSync(path.join(dir, builderFile), 'utf8');
    } catch {
      return '';
    }
  })();
  const hit = /^\s*["']?appId["']?\s*[:=]\s*["']?([A-Za-z0-9_.-]+)["']?/m.exec(text);
  return hit ? hit[1] : null;
}

/**
 * Does this thing keep anything between runs?
 *
 * Read off what it installs and what it is deployed beside, because that is where a database
 * announces itself. Wrong in the cautious direction: something that stores data in a way
 * nothing here recognises is treated as if it does keep data, which costs one question rather
 * than one silently unfair comparison.
 *
 * @param {Record<string, any>} deps
 * @param {{dockerfile: string|null, compose: string|null}} containers
 * @returns {boolean}
 */
function keepsData(deps, containers) {
  const stores = [
    'pg', 'postgres', 'mysql', 'mysql2', 'mariadb', 'sqlite3', 'better-sqlite3', 'mongodb',
    'mongoose', 'redis', 'ioredis', 'prisma', '@prisma/client', 'drizzle-orm', 'typeorm',
    'sequelize', 'knex', 'kysely', '@supabase/supabase-js', 'firebase-admin', 'level',
    'lowdb', 'nedb', '@libsql/client',
  ];
  if (stores.some((name) => name in deps)) return true;
  return Boolean(containers.compose);
}

/**
 * "a, b and c" — a list joined with "and" three times reads like a machine wrote it.
 *
 * @param {string[]} items
 * @returns {string}
 */
function plainly(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The source read a second time, once it is known where the products actually are.
 *
 * A chicken and an egg, resolved by reading twice. The first read has to happen before
 * anything is known about this repository, so it reads the usual folders — src, lib, app and
 * the rest — which is exactly right for a repository that makes one thing. On a repository
 * that makes five, it reads the desktop app and nothing else, and then reports "0 routes"
 * about a tree that contains a relay with routes in it. Every door behind the folders it did
 * not open is counted as absent rather than as unread, and that is the shape of silence this
 * whole tool exists to remove.
 *
 * So once the products are known, the folders they live in are known too, and if those are
 * not the ones already read, it is read again. Only then — a second full read of a large
 * repository is a second or two, and paying it when the first answer was already right would
 * be paying it for nothing.
 *
 * @param {object} input
 * @param {string} input.root
 * @param {boolean} input.readCode
 * @param {Product[]} input.merged
 * @param {{files: string[], dirs: string[]}} input.listing
 * @param {string[]} input.firstFolders   The folders the first read was actually given. Worked
 *   out again from the usual list, this said "src was read" about a run that had in fact been
 *   pointed at the whole project, and the whole project then got read a second time for nothing.
 * @param {{doors: ProjectShape['doors'], routes: ProjectShape['routes'], channels: ProjectShape['channels'], envNames: ProjectShape['envNames']}} input.first
 * @returns {Promise<{doors: ProjectShape['doors'], routes: ProjectShape['routes'], channels: ProjectShape['channels'], envNames: ProjectShape['envNames'], sourceFolders: string[]}>}
 */
async function theSourceAgain(input) {
  const { root, readCode, merged, listing, firstFolders, first } = input;
  const sourceFolders = await proposeSourceFolders(root, merged, listing);
  const alreadyRead = new Set(firstFolders);
  const missed = sourceFolders.filter((folder) => !alreadyRead.has(folder));
  if (!readCode || missed.length === 0) return { ...first, sourceFolders };

  const second = await readTheSource(root, sourceFolders);
  // A second read that went worse than the first is not an improvement. This cannot normally
  // happen, and if it ever does the honest answer is the one that saw more, not the newer one.
  if (!second.doors.read || second.doors.filesRead < first.doors.filesRead) return { ...first, sourceFolders };
  return { ...second, sourceFolders };
}

/**
 * The scheme `xcodebuild` would be given, read out of the project rather than left blank.
 *
 * @param {string} dir
 * @param {{files: string[], dirs: string[]}} listing
 * @param {string|null} xcode
 * @returns {string|null}
 */
function schemeName(dir, listing, xcode) {
  if (xcode) return xcode.replace(/\.(xcodeproj|xcworkspace)$/, '');
  const spec = listing.files.find((f) => f === 'project.yml' || f === 'project.yaml');
  if (!spec) return null;
  try {
    const info = fs.statSync(path.join(dir, spec));
    if (info.size > 400_000) return null;
    const hit = /^\s*name\s*:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/m.exec(fs.readFileSync(path.join(dir, spec), 'utf8'));
    return hit ? hit[1] : null;
  } catch {
    return null;
  }
}

/**
 * A screen reading whose file names are written the way somebody would type them from the
 * project root.
 *
 * The reader works inside one product's folder and names files relative to it, which is
 * right for the reader and wrong for the report: `src/main.ts` is the phone client's router
 * AND the desktop app's entry point, and in a repository that holds both, an unqualified one
 * sends whoever reads it to the wrong file.
 *
 * @template {{router: Router}} T
 * @param {T} reading
 * @param {string} where
 * @returns {T}
 */
function fromHere(reading, where) {
  if (where === '.' || !reading.router.where) return reading;
  const full = path.posix.join(where, reading.router.where);
  return {
    ...reading,
    router: {
      ...reading.router,
      where: full,
      why: reading.router.why.split(reading.router.where).join(full),
    },
  };
}
