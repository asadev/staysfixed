/**
 * The hook. One line in a release script, and a person never approves anything again.
 *
 * THE WHOLE IDEA IN ONE PARAGRAPH. Every regression tool ever built asks somebody to say
 * what "working" looks like, and then quietly rots when nobody keeps saying it. This one
 * takes the answer from an act the person already performs for their own reasons: shipping.
 * The build that went out is, by definition, the build they were happy with. So the moment
 * a release happens, this file writes that down, and from then on every check compares
 * against it. Nobody opens the tool. Nobody approves a picture. Nobody sees a list.
 *
 * THREE PROMISES THIS FILE KEEPS, and the third is the one that matters most.
 *
 *   IT IS SAFE TO CALL FROM ANYWHERE — a release script, a git hook, an npm lifecycle
 *   script, an agent skill. It takes no arguments it cannot work out for itself.
 *
 *   IT IS IDEMPOTENT. A hook that fires on the tag and again on the push, or a release
 *   script re-run after a network failure, records one release. It does not retire a
 *   second round of waivers or write a second entry that makes the history read as two
 *   releases where there was one.
 *
 *   IT NEVER FAILS A RELEASE. Not on a missing store, not on a broken config, not on a
 *   build it cannot find, not on a refusal, not on an exception it did not expect. A tool
 *   that blocks somebody's ship because it could not record something has made their day
 *   worse, which is the exact opposite of the point of this phase. Everything it could not
 *   do comes back as sentences in the result, and the caller decides whether to read them.
 *   `--strict` exists for somebody who genuinely wants the opposite, and it is off.
 *
 * WHAT IT REFUSES TO DO ANYWAY. It will not make a build the standard when that build was
 * never checked, or was checked and found broken. The refusal is not an error — the release
 * still succeeds, and the summary says the reference did NOT move and why. That combination
 * is deliberate: shipping is the person's call and never the tool's, but calling a broken
 * build "working" would poison every check that follows, so it declines and says so.
 *
 * WHAT IT DETECTS RATHER THAN BEING TOLD. A new git tag on the current commit, a version
 * bump in package.json, an npm publish it was called from. It says which of those it saw,
 * because a hook that silently guesses wrong is worse than one that asks.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { EXIT, messageOf } from '../core/errors.js';
import { say, warn, ok, blank, heading, setLogLevel } from '../core/log.js';
import { findConfigFile, rootForConfig } from '../core/paths.js';
import { openStore, ensureStore, listBuilds } from './store.js';
import { cutReference, shouldCut, referenceHistory, currentReference } from './reference.js';

const exec = promisify(execFile);

/** @typedef {import('./types.js').Store} Store */
/** @typedef {import('./types.js').BuildFingerprint} BuildFingerprint */
/** @typedef {import('./reference.js').ReferenceCut} ReferenceCut */
/** @typedef {import('./reference.js').CutDecision} CutDecision */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * What the hook worked out had just been released.
 *
 * @typedef {object} Release
 * @property {'told'|'npm-publish'|'git-tag'|'version-bump'|'commit'|'unknown'} how
 * @property {string} what            What to call this release: 'v0.13.0', 'a1b2c3d'.
 * @property {string} [version]
 * @property {string} [tag]
 * @property {string|null} [gitSha]
 * @property {string|null} [branch]
 * @property {boolean} [dirty]        The working tree had uncommitted changes when it shipped.
 * @property {string} describe        One plain sentence: what was detected, and how.
 */

/**
 * What `onShip` hands back. Always. It never throws.
 *
 * @typedef {object} ShipResult
 * @property {boolean} ok             Nothing went wrong. NOT the same as "a reference was cut".
 * @property {boolean} cut            The reference actually moved.
 * @property {boolean} unchanged      This build was already the standard; nothing to do.
 * @property {string} product
 * @property {string} root
 * @property {Release} [release]
 * @property {string} [buildId]
 * @property {ReferenceCut} [reference]
 * @property {CutDecision} [decision]
 * @property {string} [refused]       Why the reference did not move, in full.
 * @property {string} [error]         Something unexpected. The release is still fine.
 * @property {string[]} warnings
 * @property {string} summary         ONE line, for the closing summary he already reads.
 * @property {string[]} lines         The longer version, still plain English.
 */

/**
 * What somebody has to paste into their own release script to make this work.
 *
 * @typedef {object} WiringAdvice
 * @property {string} line            The one line. This is the answer to the question.
 * @property {string} npmScript       For a package.json that publishes to npm.
 * @property {string} gitHook         For somebody who tags releases by hand.
 * @property {string} agent           For an agent's own release skill.
 * @property {string} explain         Why it goes there, in two sentences, for a person.
 */

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

/**
 * Record that a build shipped, and make it the new definition of working.
 *
 * @param {object} [opts]
 * @param {string} [opts.root]      Project folder. Defaults to where we were started.
 * @param {string} [opts.product]   Which product shipped. One repo can build five.
 * @param {string|BuildFingerprint} [opts.build]  The exact build, when the caller knows it.
 * @param {string} [opts.note]      What the release was, in a person's words.
 * @param {string} [opts.why]       The same thing under the name the rest of the tool uses.
 * @param {string} [opts.version]   Tell it the version instead of letting it detect one.
 * @param {string} [opts.tag]       Tell it the tag instead of letting it detect one.
 * @param {string} [opts.setBy]     Who did it: 'ship-everywhere', 'staysfixed ship', a person.
 * @param {boolean} [opts.force]    Cut past a refusal. It goes on the record as forced.
 * @param {string} [opts.at]        ISO, for recording a release that already happened.
 * @returns {Promise<ShipResult>}
 */
export async function onShip(opts = {}) {
  const root = projectRoot(opts.root);
  /** @type {string[]} */
  const warnings = [];

  /** @type {ShipResult} */
  const result = {
    ok: true,
    cut: false,
    unchanged: false,
    product: '',
    root,
    warnings,
    summary: '',
    lines: [],
  };

  try {
    const product = opts.product ?? (await productName(root));
    result.product = product;

    const release = await detectRelease({ root, version: opts.version, tag: opts.tag, build: opts.build });
    result.release = release;

    if (release.dirty) {
      warnings.push(
        'This release was made from a working tree with uncommitted changes, so what shipped and what is in git are not the same thing. The reference points at what was actually checked.'
      );
    }

    const store = openStore({ root });
    await ensureStore(store);

    /** @type {string[]} */
    const unreadable = [];
    const build = await resolveBuild(store, product, release, opts.build, (/** @type {string} */ why) => unreadable.push(String(why)));
    if (unreadable.length > 0) {
      // Said whether or not a build was found, because a damaged record changes what the
      // answer is worth either way: if none was found it may be the reason, and if one was
      // found it may not be the right one.
      result.lines.push(
        `${unreadable.length} stored ${unreadable.length === 1 ? 'record' : 'records'} of ${product} could not be read, so ${unreadable.length === 1 ? 'it was' : 'they were'} left out of this decision: ${unreadable.join('; ')}`,
      );
    }
    if (!build) {
      result.cut = false;
      const because = unreadable.length > 0
        ? ` ${unreadable.length} of its stored ${unreadable.length === 1 ? 'record' : 'records'} could not be read, which may be why.`
        : '';
      result.lines = [
        `${product} ${release.describe}`,
        `Stays Fixed has no record of this build, so it did not become the reference. Nothing about ${product} is being compared against anything yet.${because}`,
        'Run `staysfixed check` once before the next release and it will record itself from then on.',
        ...(unreadable.length > 0 ? [`What could not be read: ${unreadable.join('; ')}`] : []),
      ];
      result.summary = `${product} shipped ${release.what}, but Stays Fixed had never seen this build, so what "working" means has not moved.${because} Run a check before the next release.`;
      return result;
    }

    result.buildId = build.id;

    const decision = await shouldCut(store, product, build);
    result.decision = decision;

    if (!decision.ok && opts.force !== true) {
      result.cut = false;
      result.refused = decision.refusal ?? decision.why;
      result.lines = [
        `${product} ${release.describe}`,
        `The reference did NOT move. ${result.refused}`,
        'Your release is unaffected — this only decides what future checks compare against.',
      ];
      result.summary = `${product} shipped ${release.what}. What "working" means did NOT move: ${decision.why} Future checks still compare against the previous reference.`;
      return result;
    }

    const cut = await cutReference(store, {
      product,
      build,
      why: opts.why ?? opts.note ?? release.describe,
      setBy: opts.setBy ?? 'staysfixed ship',
      force: opts.force === true,
      at: opts.at,
    });
    result.reference = cut;
    result.cut = cut.unchanged !== true;
    result.unchanged = cut.unchanged === true;

    const missed = await whatTheCheckMissed(store);

    if (cut.unchanged) {
      result.lines = [
        `${product} ${release.describe}`,
        `That build was already what ${product} calls working, so nothing moved and no waivers were retired. Recording a release twice is safe.`,
        ...(missed ? [missed] : []),
      ];
      result.summary = `${product} ${release.what} was already the reference — nothing changed.`;
      return result;
    }

    result.lines = [
      `${product} ${release.describe}`,
      cut.summary,
      // The summary already carries one sentence about steadiness. The long form only
      // earns its place when it says something the summary cannot: that some journeys
      // ran only once, so part of this reference has no steadiness record behind it.
      ...(cut.stability.measuredJourneys < cut.stability.journeys ? [cut.stability.note] : []),
      'Nobody has to approve anything. The next check compares against this.',
      // Said in the same breath as the good news, exactly as every other surface says it.
      ...(missed ? [missed] : []),
    ];
    result.summary = cut.summary;
    return result;
  } catch (e) {
    // The one thing this function may never do is take a release down with it. Whatever
    // went wrong, it goes back as words and the caller carries on shipping.
    result.ok = false;
    result.error = messageOf(e);
    result.lines = [
      `Stays Fixed could not record this release: ${result.error}`,
      'Your release is unaffected. What this means is that future checks are still comparing against the previous reference, so a regression introduced by this build would be reported rather than adopted — the safe direction.',
    ];
    result.summary = `Stays Fixed could not record this release (${result.error}). Nothing about the release is affected; future checks still compare against the previous reference.`;
    return result;
  }
}

// ---------------------------------------------------------------------------
// What just shipped?
/**
 * What the last check did NOT look at, said here too.
 *
 * `ship` is the one command that decides what "working" MEANS from now on, and it printed no
 * coverage caveat at all — not in the text, not in `--json`. Every other surface says it, in
 * the same breath as the good news, because a green result on a product with doors nobody has
 * ever opened is true and is not what it looks like. The command that turns that result into
 * the standard is the last place that should stay quiet about it.
 *
 * @param {Store} store
 * @returns {Promise<string|null>}
 */
async function whatTheCheckMissed(store) {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(store.dir, 'last-check.json'), 'utf8'));
    const coverage = raw?.result?.coverage ?? null;
    if (!coverage) return null;
    const { whatWasNotChecked } = await import('./check.js');
    const said = whatWasNotChecked(coverage);
    return typeof said === 'string' && said.trim() ? said.trim() : null;
  } catch {
    // No record, or unreadable. Saying nothing is right here — inventing a caveat would be
    // its own kind of lie.
    return null;
  }
}

// ---------------------------------------------------------------------------

/**
 * Work out what was released, rather than being told.
 *
 * The order is by how much each signal actually means. Somebody who names the version means
 * it. An npm publish is unambiguous. A tag on the current commit is what almost everybody's
 * release does. A version bump in the last commit is the fallback for people who tag later.
 * And if none of that is there, this says so plainly instead of pretending it knows.
 *
 * @param {{root: string, version?: string, tag?: string, build?: string|BuildFingerprint}} opts
 * @returns {Promise<Release>}
 */
export async function detectRelease(opts) {
  const root = opts.root;
  const sha = await git(root, ['rev-parse', 'HEAD']);
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  // The tool's own store lives at .staysfixed/ and is usually untracked, so a plain
  // `git status --porcelain` calls every single release dirty and the warning stops meaning
  // anything. What matters is whether the PRODUCT had uncommitted changes.
  const status = await git(root, ['status', '--porcelain']);
  const changed = (status ?? '')
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((file) => file !== '' && !file.startsWith('.staysfixed/') && file !== '.staysfixed');
  const dirty = changed.length > 0;
  const short = sha ? sha.slice(0, 7) : null;

  /** @type {Release} */
  const base = {
    how: 'unknown',
    what: short ?? 'this build',
    describe: '',
  };
  if (sha) base.gitSha = sha;
  if (branch && branch !== 'HEAD') base.branch = branch;
  if (dirty) base.dirty = true;

  // 1 — told.
  if (opts.tag || opts.version || (opts.build && typeof opts.build !== 'string' && opts.build.version)) {
    const version = opts.version ?? (typeof opts.build === 'object' ? opts.build.version : undefined);
    const what = opts.tag ?? version ?? base.what;
    return {
      ...base,
      how: 'told',
      what,
      ...(version ? { version } : {}),
      ...(opts.tag ? { tag: opts.tag } : {}),
      describe: `released ${what} — you told it so.`,
    };
  }

  // 2 — npm publish. npm sets these while running a lifecycle script, so a `postpublish`
  // hook knows exactly what it is without being passed anything.
  const lifecycle = process.env.npm_lifecycle_event ?? '';
  const npmCommand = process.env.npm_command ?? '';
  const npmVersion = process.env.npm_package_version;
  if (npmCommand === 'publish' || lifecycle === 'postpublish' || lifecycle === 'publish') {
    const version = npmVersion ?? (await packageVersion(root)) ?? undefined;
    return {
      ...base,
      how: 'npm-publish',
      what: version ? `v${version}` : base.what,
      ...(version ? { version } : {}),
      describe: `was published to npm${version ? ` as ${version}` : ''}.`,
    };
  }

  // 3 — a tag on this exact commit. The commonest shape of a real release.
  const tags = sha ? await git(root, ['tag', '--points-at', sha]) : null;
  const tag = tags ? tags.split('\n').map((t) => t.trim()).filter(Boolean).sort().pop() : null;
  if (tag) {
    const version = (await packageVersion(root)) ?? undefined;
    return {
      ...base,
      how: 'git-tag',
      what: tag,
      tag,
      ...(version ? { version } : {}),
      describe: `was tagged ${tag}${short ? ` on commit ${short}` : ''}.`,
    };
  }

  // 4 — the last commit changed the version in package.json.
  const bumped = await versionBump(root);
  if (bumped) {
    return {
      ...base,
      how: 'version-bump',
      what: `v${bumped.to}`,
      version: bumped.to,
      describe: `had its version bumped from ${bumped.from} to ${bumped.to} in the last commit${short ? ` (${short})` : ''}.`,
    };
  }

  // 5 — nothing that looks like a release. Say so; do not invent one.
  const version = (await packageVersion(root)) ?? undefined;
  return {
    ...base,
    how: 'commit',
    what: short ?? 'this build',
    ...(version ? { version } : {}),
    describe: short
      ? `shipped at commit ${short}. There was no new tag, no version bump and no npm publish to go on, so this is being recorded as the release because somebody said it shipped.`
      : 'shipped. This is not a git repository, so there is nothing to name the release by beyond the fact that somebody said so.',
  };
}

/**
 * Did the last commit change the version in package.json?
 * @param {string} root
 * @returns {Promise<{from: string, to: string}|null>}
 */
async function versionBump(root) {
  const now = await packageVersion(root);
  if (!now) return null;
  const before = await git(root, ['show', 'HEAD~1:package.json']);
  if (!before) return null;
  try {
    const parsed = JSON.parse(before);
    const was = typeof parsed?.version === 'string' ? parsed.version : null;
    if (!was || was === now) return null;
    return { from: was, to: now };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Which stored build is the one that shipped?
// ---------------------------------------------------------------------------

/**
 * Find the build in the store that the release corresponds to.
 *
 * The store is keyed by what was actually observed, and the release is described by git. The
 * join between them is the commit: a clean tree is stored as `git-<sha>`, so the same commit
 * checked yesterday and shipped today is one build.
 *
 * It deliberately does NOT fall back to "the newest build of this product". That would make
 * the reference point at whatever was last walked — often a scratch edit from twenty minutes
 * ago — and be indistinguishable from working correctly. When it cannot make the join it
 * says so and cuts nothing.
 *
 * @param {Store} store
 * @param {string} product
 * @param {Release} release
 * @param {string|BuildFingerprint} [told]
 * @param {(why: string) => void} [onProblem]  Told about any stored record that would not open.
 * @returns {Promise<BuildFingerprint|null>}
 */
async function resolveBuild(store, product, release, told, onProblem) {
  // A record nobody could read must never be silently absent here.
  //
  // This function decides which build becomes the definition of "working" for a whole
  // product. `listBuilds` skips a damaged record rather than failing, which is right for a
  // listing and wrong here twice over: a build whose record will not open looks exactly like
  // a build that was never walked, so the answer is "Stays Fixed has never seen this build"
  // when the truth is "it has, and the record is broken"; and where two builds share a
  // commit, losing the clean one to a damaged record leaves the dirty one to be blessed in
  // its place. Neither is a thing to work out from an empty list.
  const builds = await listBuilds(store, { product, onProblem });

  if (told) {
    const id = typeof told === 'string' ? told : told.id;
    const hit = builds.find((b) => b.fingerprint.id === id);
    if (hit) return hit.fingerprint;
    return typeof told === 'string' ? { id: told, product } : told;
  }

  // WHAT IS ACTUALLY HERE, before what the commit says is here.
  //
  // Matching on the commit alone blesses the wrong thing the moment the tree is dirty:
  // several builds share one commit, this took the first of them, and that is usually an
  // EARLIER build — one that was checked and came back clean. So editing a file and running
  // `staysfixed ship` answered "was already the reference — nothing changed" and exited 0,
  // about a tree nothing had ever looked at. Measured 2026-08-30 by deleting a button and
  // shipping without a check.
  //
  // A dirty tree therefore has to match EXACTLY, on the fingerprint of what is on disk right
  // now. If nothing on record is that tree, then this tree has not been checked, and the
  // honest answer is the one the tool already knows how to give: no record of this build, so
  // the reference does not move.
  try {
    const { fingerprintWorkingTree } = await import('./check.js');
    const here = await fingerprintWorkingTree(store.root, product);
    if (here?.id) {
      const exact = builds.find((b) => b.fingerprint.id === here.id);
      if (exact) return exact.fingerprint;
      if (here.dirty) return null;
    }
  } catch {
    // No git, or the tree could not be read. The joins below are all that is left, and they
    // are better than refusing to record a release at all.
  }

  const sha = release.gitSha;
  if (sha) {
    const sameCommit = builds.filter((b) => b.fingerprint.gitSha === sha);
    // A clean checkout of the commit beats a build made from the same commit with edits on
    // top: the second one is not what shipped.
    const clean = sameCommit.find((b) => !b.fingerprint.dirty);
    if (clean) return clean.fingerprint;
    if (sameCommit.length > 0) return sameCommit[0].fingerprint;

    const byId = builds.find((b) => b.fingerprint.id === `git-${sha.slice(0, 12)}`);
    if (byId) return byId.fingerprint;

    // We know the commit and nothing in the store was built from it. Matching on the version
    // number instead would be a guess, and it is the guess that goes wrong: a release commit
    // usually carries the version that was ALREADY in package.json, so the version match
    // would happily hand back the previous build and the reference would never move. Found
    // by a smoke test that shipped a second commit and was told it was already the standard.
    return null;
  }

  // No git at all — a tarball, a copied folder, a build machine with no history. Then the
  // version is the only join there is, and saying so is better than refusing outright.
  if (release.version) {
    const byVersion = builds.find((b) => b.fingerprint.version === release.version || b.fingerprint.version === `v${release.version}`);
    if (byVersion) return byVersion.fingerprint;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Working out where we are, without being told
// ---------------------------------------------------------------------------

/**
 * @param {string} [from]
 * @returns {string}
 */
function projectRoot(from) {
  const start = path.resolve(from ?? process.cwd());
  const config = findConfigFile(start);
  return config ? rootForConfig(config) : start;
}

/**
 * Which product is this? The settings file first, because one repo builds five things and
 * only the settings file knows what they are called.
 *
 * @param {string} root
 * @returns {Promise<string>}
 */
async function productName(root) {
  const configFile = findConfigFile(root);
  if (configFile && configFile.endsWith('.json')) {
    try {
      const parsed = JSON.parse(await fsp.readFile(configFile, 'utf8'));
      if (typeof parsed?.product === 'string' && parsed.product) return parsed.product;
    } catch {
      // A settings file nobody can parse is somebody else's problem to report. Falling
      // through to the package name keeps the release recorded either way.
    }
  }
  const pkg = await packageJson(root);
  if (typeof pkg?.name === 'string' && pkg.name) return pkg.name;
  return path.basename(root);
}

/**
 * @param {string} root
 * @returns {Promise<Record<string, any>|null>}
 */
async function packageJson(root) {
  try {
    return JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} root
 * @returns {Promise<string|null>}
 */
async function packageVersion(root) {
  const pkg = await packageJson(root);
  return typeof pkg?.version === 'string' ? pkg.version : null;
}

/**
 * Read-only git, and every call is allowed to fail: this tool works in folders that are not
 * repositories, it just cannot name the release as precisely there.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string|null>}
 */
async function git(cwd, args) {
  try {
    const { stdout } = await exec('git', args, { cwd, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The one line a stranger has to paste
// ---------------------------------------------------------------------------

/**
 * What to put in your own release script, written for somebody who has never seen this tool.
 *
 * This exists because the design says the tool must describe itself to whoever installs it.
 * A hook nobody knows how to install is a feature that does not exist, and "read the docs"
 * is not an answer when the reader is an agent wiring this up for a person who is not a
 * programmer.
 *
 * @param {{root?: string, product?: string}} [opts]
 * @returns {WiringAdvice}
 */
export function wiringAdvice(opts = {}) {
  const product = opts.product ? ` --product ${shellArg(opts.product)}` : '';
  return {
    line: `npx staysfixed ship${product}`,
    npmScript: `"postpublish": "npx staysfixed ship${product} || true"`,
    gitHook: [
      '# .git/hooks/post-tag is not a thing, so put it where you actually tag:',
      `git tag -a "$VERSION" -m "$VERSION" && git push --tags && npx staysfixed ship${product} --why "$VERSION"`,
    ].join('\n'),
    agent: `After the release goes out, run: npx staysfixed ship${product} --why "<what you shipped>"`,
    explain: [
      'Put that line at the END of whatever you already run to release — after the upload, the publish or the tag push, so it only records builds that really went out.',
      'It never fails: if it cannot work something out it prints a sentence and exits 0, so it can never be the reason a release stops.',
    ].join(' '),
  };
}

/**
 * @param {string} value
 * @returns {string}
 */
function shellArg(value) {
  return /^[A-Za-z0-9._@\/-]+$/.test(value) ? value : `'${value.split("'").join(`'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/**
 * `staysfixed ship`, in exactly the shape `src/cli/index.js` already uses, so wiring it in
 * is one merge:
 *
 *     import { SHIP_COMMANDS } from '../v2/ship.js';
 *     Object.assign(COMMANDS, SHIP_COMMANDS);
 *
 * @type {Record<string, {summary: string, usage: string, describe: string, options: [string,string][], examples: string[], spec: {booleans?: string[], strings?: string[], arrays?: string[]}, load: () => Promise<{run: (ctx: any) => Promise<number>}>}>}
 */
export const SHIP_COMMANDS = {
  ship: {
    summary: 'Say a build went out. That build becomes what "working" means from now on.',
    usage: 'staysfixed ship [--product <name>] [--why "<what you shipped>"] [--json]',
    describe:
      'Run this at the end of your release script, after the thing has actually gone out.\nThe build you shipped becomes the standard every later check is compared against,\nso nobody ever has to open this tool and approve anything.\n\nIt works out what was released on its own — a new git tag, a version bump, an npm\npublish — and says which of those it saw. It never fails your release: if it cannot\nwork something out it says so in plain English and exits 0.\n\nIt will refuse to make a build the standard if that build was never checked, or was\nchecked and found broken. Your release still succeeds; it just tells you that what\n"working" means did not move, and why. Cutting a broken build as the standard is how\na safety net turns into a rubber stamp.',
    options: [
      ['--product <name>', 'Which product shipped. One repository can build five of them.'],
      ['--why "<text>"', 'What the release was, in your own words. It is kept with the reference.'],
      ['--build <id>', 'The exact build that shipped, when you already know its id.'],
      ['--version <v>', 'Name the version instead of letting it detect one.'],
      ['--tag <tag>', 'Name the tag instead of letting it detect one.'],
      ['--force', 'Cut the reference past a refusal. It is recorded as forced, with the refusal beside it.'],
      ['--history', 'Print every reference ever cut for this product and change nothing.'],
      ['--wire-up', 'Print the one line to paste into your own release script.'],
      ['--strict', 'Exit non-zero when the reference did not move. Off by default, on purpose.'],
      ['--json', 'The whole answer as one JSON object. This is what an agent reads.'],
    ],
    examples: [
      'staysfixed ship',
      'staysfixed ship --why "0.14.0 to TestFlight"',
      'staysfixed ship --product terminaldeck-ios',
      'staysfixed ship --history',
      'staysfixed ship --wire-up',
    ],
    spec: {
      booleans: ['json', 'force', 'history', 'wire-up', 'strict'],
      strings: ['product', 'why', 'build', 'version', 'tag'],
    },
    load: async () => ({ run }),
  },
};

/**
 * `staysfixed ship`.
 *
 * The exit code is 0 unless somebody asked for `--strict`. That is not sloppiness: this
 * command is designed to sit at the end of a release script, and a release script that
 * stops because a bookkeeping tool was unhappy is a worse product than one that does not.
 *
 * @param {import('../cli/index.js').CliContext} ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  const asJson = ctx.bool('json');
  if (asJson) setLogLevel({ quiet: true });

  const root = projectRoot(ctx.cwd);

  if (ctx.bool('wire-up')) {
    const advice = wiringAdvice({ root, product: ctx.str('product') });
    if (asJson) {
      process.stdout.write(JSON.stringify(advice, null, 2) + '\n');
      return EXIT.ok;
    }
    heading('Put this at the end of your release script');
    say(`  ${advice.line}`);
    blank();
    say(advice.explain);
    blank();
    say('If you publish to npm, this does it for you:');
    say(`  ${advice.npmScript}`);
    return EXIT.ok;
  }

  if (ctx.bool('history')) return await printHistory(ctx, root, asJson);

  const result = await onShip({
    root,
    product: ctx.str('product'),
    why: ctx.str('why'),
    build: ctx.str('build'),
    version: ctx.str('version'),
    tag: ctx.str('tag'),
    force: ctx.bool('force'),
    setBy: 'staysfixed ship',
  });

  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    // The headline is always `summary`, and it is always the one line somebody would
    // paste into a closing summary. Everything else follows it, once, in order.
    if (result.cut) ok(result.summary);
    else if (result.unchanged) say(result.summary);
    else warn(result.summary);
    for (const line of result.lines) {
      if (line !== result.summary) say(line);
    }
    for (const line of result.warnings) warn(line);
  }

  if (!ctx.bool('strict')) return EXIT.ok;
  if (!result.ok) return EXIT.error;
  return result.cut || result.unchanged ? EXIT.ok : EXIT.failed;
}

/**
 * Every reference ever cut, newest first — which is how a regression gets traced back to
 * the release that introduced it.
 *
 * @param {import('../cli/index.js').CliContext} ctx
 * @param {string} root
 * @param {boolean} asJson
 * @returns {Promise<number>}
 */
async function printHistory(ctx, root, asJson) {
  const store = openStore({ root });
  const product = ctx.str('product') ?? (await productName(root));
  const history = await referenceHistory(store, product, { includeArchive: true });
  const current = await currentReference(store, product);

  if (asJson) {
    process.stdout.write(JSON.stringify({ product, current: current?.pointer ?? null, history }, null, 2) + '\n');
    return EXIT.ok;
  }

  if (history.length === 0) {
    warn(`${product} has never had a reference cut, so there is nothing to compare any build against yet.`);
    say('Ship once with `staysfixed ship` at the end of your release script and the next check has a standard to work from.');
    return EXIT.ok;
  }

  heading(`What ${product} has called working`);
  for (const cut of history) {
    const marker = current?.pointer.buildId === cut.buildId ? '→ ' : '  ';
    say(`${marker}${cut.at.slice(0, 16).replace('T', ' ')}  ${cut.build?.version ?? cut.buildId}${cut.forced ? '  (FORCED)' : ''}`);
    say(`     ${cut.summary}`);
  }
  return EXIT.ok;
}
