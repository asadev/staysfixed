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
  desktopNative: { name: 'a native desktop app', surface: 'windows', adapter: 'windows', what: 'A desktop app that is not Electron — Swift, WinUI, Tauri, Qt. Only readable from the operating system it runs on.' },
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
  try {
    const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'adapters');
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.js')) continue;
      const id = name.slice(0, -3);
      // Two files in there are not adapters: the interface every adapter is written against,
      // and the helpers two of them share.
      if (id === 'contract' || id === 'isolate' || id.endsWith('-driver')) continue;
      here.add(id);
    }
  } catch {
    // A copy of the tool whose own folder cannot be read tells us nothing, and claiming no
    // adapter exists would be a worse answer than claiming the usual ones do.
    return new Set(['process', 'source', 'http', 'web', 'electron']);
  }
  return here;
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
  const reading = readCode ? await readTheSource(root) : { doors: notRead(), routes: [] };
  const doors = reading.doors;
  const routes = reading.routes;
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
      doors: place.root === '.' ? doors : notRead(),
      pages: place.root === '.' ? pages : [],
      containers: place.root === '.' ? containers : { dockerfile: null, compose: null },
      scripts: place.pkg?.scripts ?? {},
      available,
    })));
  }

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
    name: String(pkg?.name ?? path.basename(root)),
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
    doors,
    routes,
    pages,
    containers,
    evidence: dedupeClues(evidence),
    unsure,
    durationMs: Date.now() - started,
  };
}

/**
 * The same thing, said out loud, short enough to paste into a message to a person.
 *
 * @param {ProjectShape} shape
 * @returns {string[]}
 */
export function describeShape(shape) {
  /** @type {string[]} */
  const lines = [];
  lines.push(shape.summary);
  lines.push('');
  for (const product of shape.products) {
    const sure = product.confidence >= 0.8 ? '' : product.confidence >= 0.5 ? ' (fairly sure)' : ' (a guess)';
    lines.push(`${product.name}${sure} — ${product.why}`);
    if (product.built.found) lines.push(`    built and ready: ${product.built.where}`);
    for (const blocker of product.blockers) lines.push(`    in the way: ${blocker}`);
  }
  if (shape.products.length > 0) lines.push('');
  if (shape.tests.runner) {
    const how = shape.tests.command ? `, run by \`${short(shape.tests.command)}\`` : '';
    lines.push(`Its own tests: ${shape.tests.files} file${shape.tests.files === 1 ? '' : 's'} written with ${shape.tests.runner}${how}. Those are journeys this tool can borrow instead of inventing its own.`);
  } else {
    lines.push('No test suite was found, so every journey has to come from the code or from a recording.');
  }
  if (shape.doors.read) {
    const many = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ lots) => `${n} ${n === 1 ? one : lots}`;
    lines.push(`Read out of the code without running any of it: ${many(shape.doors.route, 'route', 'routes')}, ${many(shape.doors.ipc, 'private channel', 'private channels')}, ${many(shape.doors.export, 'exported name', 'exported names')}, ${many(shape.doors.command, 'command', 'commands')}.`);
  }
  for (const doubt of shape.unsure) lines.push(doubt);
  return lines;
}

/**
 * The single most important product, when something has to pick one — the front page of a
 * report, the default when a command takes one name. It is the most certain, and ties break
 * towards the one a person would name first.
 *
 * @param {ProjectShape} shape
 * @returns {Product|null}
 */
export function mainProduct(shape) {
  return shape.products[0] ?? null;
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
   */
  const add = (kind, spec) => {
    const meta = PRODUCT_KINDS[kind];
    found.push({
      kind,
      name: spec.name,
      surface: meta.surface,
      adapter: meta.adapter && available.has(meta.adapter) ? meta.adapter : null,
      confidence: spec.confidence,
      why: spec.why,
      where,
      evidence: spec.evidence,
      built: spec.built ?? { found: false, where: null, how: 'nothing to build — it runs from source' },
      blockers: spec.blockers ?? [],
      suggest: spec.suggest,
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
    if (pkg?.build?.appId) clues.push({ where: at('package.json'), means: `It has an application id (${String(pkg.build.appId)}), which only a packaged desktop app has.` });
    if (app.where) clues.push({ where: path.relative(root, app.where), means: 'A built desktop app is sitting here already, so it can be opened and read straight away.' });
    add('electron', {
      name: 'the desktop app',
      confidence: app.where ? 1 : 0.85,
      why: app.where ? `It depends on Electron and a built app is already sitting at ${path.relative(root, app.where)}.` : 'It depends on Electron, so it produces a desktop app — but no built copy was found, so there is nothing to open yet.',
      evidence: clues,
      built: { found: Boolean(app.where), where: app.where ? path.relative(root, app.where) : null, how: app.how },
      blockers: app.where ? [] : ['The app has not been built. A desktop app can only be checked once there is a built copy to open — build it the way you normally do, then point the settings at the result.'],
      suggest: app.where ? { binary: path.relative(root, app.where) } : {},
    });
  }

  // ── iOS ───────────────────────────────────────────────────────────────────
  const xcode = listing.dirs.find((d) => d.endsWith('.xcodeproj')) ?? listing.dirs.find((d) => d.endsWith('.xcworkspace')) ?? null;
  const swiftPackage = file('Package.swift');
  const podfile = file('Podfile');
  const xcodegen = file('project.yml') && listing.dirs.some((d) => /^[A-Z]/.test(d));
  // React Native and Expo are one codebase that becomes two apps. Both are reported, because
  // reporting one would leave the other silently unchecked.
  const reactNative = has('react-native') || has('expo');
  if (xcode || (swiftPackage && (podfile || folder('Sources'))) || (podfile && !xcode) || (xcodegen && podfile) || reactNative) {
    /** @type {Clue[]} */
    const clues = [];
    if (xcode) clues.push({ where: at(xcode), means: 'An Xcode project, which is how an Apple app is built.' });
    if (swiftPackage) clues.push({ where: at('Package.swift'), means: 'Swift source organised as a package.' });
    if (podfile) clues.push({ where: at('Podfile'), means: 'CocoaPods dependencies, which are used by iOS apps.' });
    if (reactNative) clues.push({ where: at('package.json'), means: 'It depends on React Native, so one codebase becomes both an iPhone app and an Android app.' });
    const ipa = await findFirst(dir, /\.(ipa|app)$/, ['build', 'DerivedData', 'Products']);
    add('ios', {
      name: 'the iPhone app',
      confidence: xcode ? 1 : reactNative ? 0.8 : 0.6,
      why: xcode ? `There is an Xcode project at ${at(xcode)}.` : reactNative ? 'It depends on React Native, which builds an iPhone app.' : 'There is Swift and iOS tooling here, though no Xcode project was found in the usual place.',
      evidence: clues,
      built: { found: Boolean(ipa), where: ipa ? path.relative(root, ipa) : null, how: ipa ? 'a built app was found' : 'nothing built was found' },
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
      suggest: apk ? { apk: path.relative(root, apk) } : {},
      blockers: available.has('android')
        ? ['It runs on an emulator. Whether two emulator snapshots restore identically is unproven, so a run says which mode it used.']
        : ['Nothing in this copy of the tool can drive an Android app yet. When it can, it will run on an emulator against the stored record.'],
    });
  }

  // ── Native desktop that is not Electron ───────────────────────────────────
  if (folder('src-tauri') || (file('Cargo.toml') && folder('src-tauri'))) {
    add('desktopNative', {
      name: 'the Tauri desktop app',
      confidence: 0.9,
      why: 'There is a src-tauri folder, which is how a Tauri desktop app is built.',
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
  const routeFolders = folder('pages') || (folder('app') && (fs.existsSync(path.join(dir, 'app', 'page.tsx')) || fs.existsSync(path.join(dir, 'app', 'page.jsx')) || fs.existsSync(path.join(dir, 'app', 'layout.tsx'))));
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
      const dev = scripts.dev ?? scripts.start ?? scripts.serve ?? null;
      const start = dev ? inFolder(npmRun(scripts, dev), where) : null;
      // A site made of plain .html files has no framework and no dev server, and every one
      // of those files is a page somebody can open. Listing them is what turns "there is a
      // website here" into journeys that can actually be walked.
      const flat = listing.files.filter((f) => f.endsWith('.html')).map((f) => (f === 'index.html' ? '/' : `/${f}`));
      if (flat.length > 1) clues.push({ where: at('*.html'), means: `${flat.length} pages are plain HTML files sitting in this folder.` });
      add('web', {
        name: where === '.' ? 'the website' : `the website in ${where}/`,
        confidence: onlyBuildsWebsites || ((webFramework || indexHtml) && (bundler || hostConfig || pages.length > 0)) ? 0.95 : 0.6,
        why: [
          webFramework ? `It uses ${webFramework}` : 'There is a page here',
          pages.length > 0 ? ` and ${pages.length} page address${pages.length === 1 ? '' : 'es'} were read out of the folder names` : '',
          flat.length > 1 && pages.length === 0 ? ` and ${flat.length} more are plain HTML files` : '',
          hostConfig ? `, it is set up to deploy to ${hostConfig.split('.')[0]}` : '',
          start ? `, and \`${start}\` starts it` : '',
        ].join('') + '.',
        evidence: clues,
        blockers: start
          ? []
          : ['There is no command that starts it, so each build cannot be booted on its own. Without that, both halves of a comparison would read the same running copy and prove nothing. A static site only needs a static file server — anything that serves this folder on the PORT it is given will do.'],
        suggest: {
          ...(start ? { start } : {}),
          ...(flat.length > 0 && pages.length === 0 ? { screens: flat.map((url) => ({ name: url === '/' ? 'the front page' : url, url })) } : {}),
        },
      });
    }
  }

  // ── Server ────────────────────────────────────────────────────────────────
  const serverFramework = ['express', 'fastify', 'hono', 'koa', '@hapi/hapi', '@nestjs/core', 'polka', 'restify'].find(has) ?? null;
  const serverish = Boolean(serverFramework) || doors.route > 0 || Boolean(containers.dockerfile && scripts.start);
  if (serverish) {
    /** @type {Clue[]} */
    const clues = [];
    if (serverFramework) clues.push({ where: at('package.json'), means: `It depends on ${serverFramework}, which serves requests.` });
    if (doors.route > 0) clues.push({ where: 'the source', means: `${doors.route} route${doors.route === 1 ? '' : 's'} are declared in the code.` });
    if (containers.dockerfile) clues.push({ where: containers.dockerfile, means: 'It ships as a container, so there is a known way to start it.' });
    // Next.js and its cousins are a website first. Their API routes are real and worth
    // checking, but calling the whole thing "a server" as well as "a website" would report
    // one product twice.
    const alreadyAWebsite = found.some((p) => p.kind === 'web') && !serverFramework;
    if (!alreadyAWebsite) {
      add('server', {
        name: where === '.' ? 'the server' : `the server in ${where}/`,
        confidence: serverFramework ? 0.9 : doors.route > 3 ? 0.6 : 0.4,
        why: serverFramework ? `It uses ${serverFramework} and ${doors.route} route${doors.route === 1 ? '' : 's'} are written in the code.` : `${doors.route} route${doors.route === 1 ? '' : 's'} are written in the code, though no web framework is installed.`,
        evidence: clues,
        blockers: scripts.start ? [] : ['There is no command that starts it. The routes can be listed from the source without one, but none of them can be walked.'],
        suggest: scripts.start ? { start: inFolder(npmRun(scripts, scripts.start), where) } : {},
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
      for (const dir of inner.dirs) folders.add(path.join(parent, dir));
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
 * Every door in the source, counted AND named, using the same reader the contract channel
 * uses so the number here and the number in a check can never disagree.
 *
 * @param {string} root
 * @returns {Promise<{doors: ProjectShape['doors'], routes: ProjectShape['routes']}>}
 */
async function readTheSource(root) {
  try {
    const { readContract, readFileRoutes, readPackageCommands } = await import('./adapters/source.js');
    const reading = await readContract({ root });
    const fileRoutes = await readFileRoutes(root);
    const commands = await readPackageCommands(root);
    const doors = [...reading.doors, ...fileRoutes, ...commands];
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

    return {
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
 * A command short enough to read. The whole of it stays in the data; only the sentence is cut.
 * @param {string} text
 * @returns {string}
 */
function short(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 70 ? flat : `${flat.slice(0, 67)}...`;
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
