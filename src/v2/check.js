/**
 * The engine's front door.
 *
 * `run.js` owns the loop — run the new build twice, subtract the wobble, compare, prove,
 * cluster, rank. It deliberately knows nothing about where journeys come from, what a build
 * is on disk, or how to boot an old one. This file is the part that knows, and it is the
 * only thing the command line and the MCP server ever call.
 *
 * Everything above the loop lives here:
 *   - which adapters can drive this project, and which one owns each journey
 *   - where the steps come from: a journeys file, the project's config, or the code itself
 *   - what counts as "the build you have" and "the build you were happy with"
 *   - how the old build is put back on this machine so it can be walked live
 *
 * TWO PROMISES THIS FILE KEEPS.
 *
 * It never writes into the project being checked. The candidate is copied into a scratch
 * folder before anything runs, and the old build is exported out of git with `git archive`,
 * which reads history and touches neither the working tree nor `.git`.
 *
 * And it never reports "could not run" as "nothing changed". A check that was blocked comes
 * back with `blocked` set, and every reader — the command line, the MCP reply, the self-check
 * corpus — treats that as no answer at all rather than as a pass.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { StaysFixedError, messageOf } from '../core/errors.js';
import { findConfigFile, rootForConfig } from '../core/paths.js';
import { sha256 } from '../core/hash.js';

import { openStore, ensureStore, saveBuild, newCaptureId } from './store.js';
import { sortObservations } from './observation.js';
import { DEFAULT_RULES, machineRules, mergeRules, normaliseCapture, loadRules } from './normalise.js';
import { runCheck, makeCheckEvents } from './run.js';
import { proveCause } from './cause.js';
import { whatChanged } from './rank.js';

import { processAdapter } from './adapters/process.js';
import { sourceAdapter } from './adapters/source.js';
import { httpAdapter } from './adapters/http.js';

const exec = promisify(execFile);

/** @typedef {import('./types.js').Verdict} Verdict */
/** @typedef {import('./types.js').Journey} Journey */
/** @typedef {import('./types.js').Capture} Capture */
/** @typedef {import('./types.js').Observation} Observation */
/** @typedef {import('./types.js').BuildFingerprint} BuildFingerprint */
/** @typedef {import('./types.js').Coverage} Coverage */
/** @typedef {import('./types.js').Channel} Channel */
/** @typedef {import('./types.js').NormaliseRule} NormaliseRule */
/** @typedef {import('./adapters/contract.js').Adapter} Adapter */
/** @typedef {import('./run.js').LiveBuild} LiveBuild */
/** @typedef {import('./run.js').WalkRequest} WalkRequest */
/** @typedef {import('./run.js').CheckEvents} CheckEvents */

/**
 * What a check hands back.
 *
 * A Verdict, plus the one state a Verdict has no room for: BLOCKED. "I could not test this"
 * is neither a pass nor a failure, and filing it under either is the exact failure this tool
 * exists to prevent — so it travels as its own flag with a plain sentence beside it.
 *
 * @typedef {Verdict & {blocked?: boolean}} CheckOutcome
 */

/**
 * What the front door takes. Both spellings of the project folder are accepted because the
 * command line says `root` and the MCP surface says `cwd`, and neither is worth a rename.
 *
 * @typedef {object} CheckOptions
 * @property {string} [cwd]
 * @property {string} [root]
 * @property {string} [configFile]
 * @property {string} [against]     A commit, tag or stored build to compare against.
 * @property {boolean} [paired]     Boot the old build live from the start.
 * @property {boolean} [storedOnly] Never boot the old build, not even to prove a suspicion.
 * @property {string} [journeys]    A path to a journeys file, or 'code' / 'config'.
 * @property {string[]} [only]      Just these journeys, by name.
 * @property {boolean} [remember]
 * @property {string} [product]
 * @property {CheckEvents} [events]
 * @property {AbortSignal} [signal]
 */

/** The adapters, in the order the engine trusts them. Reading the code is free, so it is first. */
const ADAPTERS = [sourceAdapter, processAdapter, httpAdapter];

/** Which adapter owns a journey, by the surface it says it walks. */
const ADAPTER_FOR_SURFACE = {
  cli: 'process',
  library: 'process',
  server: 'http',
  web: 'http',
  electron: 'process',
  android: 'process',
  ios: 'process',
  windows: 'process',
};

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

/**
 * Prove that nothing which already worked has changed.
 *
 * @param {CheckOptions} [options]
 * @returns {Promise<CheckOutcome>}
 */
export async function check(options = {}) {
  const events = options.events ?? makeCheckEvents();
  /** @type {Project|null} */
  let project = null;
  try {
    project = await openProject(options);
    const verdict = await runCheck({
      store: project.store,
      product: project.product,
      candidate: project.candidate,
      journeys: project.journeys,
      walk: project.walk,
      cwd: project.root,
      bootReference: project.bootReference,
      against: project.against,
      paired: options.paired === true,
      storedOnly: options.storedOnly === true,
      remember: options.remember,
      normalise: project.normalise,
      events,
      signal: options.signal,
    });
    return verdict;
  } catch (e) {
    return blocked(options, e);
  } finally {
    if (project) await project.close();
  }
}

/**
 * A check that never happened, said in a shape every reader already understands.
 *
 * @param {CheckOptions} options
 * @param {unknown} e
 * @returns {CheckOutcome}
 */
function blocked(options, e) {
  const product = options.product ?? path.basename(path.resolve(options.cwd ?? options.root ?? process.cwd()));
  const empty = { id: '', product };
  return {
    runId: new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14),
    product,
    ok: false,
    blocked: true,
    mode: 'stored-record',
    modeWarning: 'Nothing was compared, so nothing here says anything about your product either way.',
    reference: empty,
    candidate: empty,
    findings: [],
    differencesReal: 0,
    differencesNoise: 0,
    newlyUnstable: [],
    coverage: { paths: 0, journeys: 0, byChannel: {}, gaps: [{ what: 'Everything.', why: messageOf(e) }] },
    // The hint is the half that tells a person what to DO about it, and dropping it
    // turns a helpful error into a dead end. Anything that blocks a run has to carry
    // both halves all the way out to whoever reads the summary.
    summary: `The check could not be run, so this is not a pass and not a failure. ${messageOf(e)}${
      e instanceof Error && /** @type {any} */ (e).hint ? ` ${/** @type {any} */ (e).hint}` : ''
    }`,
    durationMs: 0,
    startedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// prove
// ---------------------------------------------------------------------------

/**
 * Undo one change, walk the journey again, and see whether the difference goes away.
 *
 * This is the facade `src/v2/mcp/tools.js` asks for: it takes a finding id and a list of
 * files, both of which an agent already has, and does the loading `proveCause` cannot do
 * for itself.
 *
 * @param {CheckOptions & {finding?: string, revert?: string[]}} options
 * @returns {Promise<{gone: boolean, detail?: string, verdict?: string, escalates?: boolean}>}
 */
export async function prove(options = {}) {
  const root = projectRootFor(options);
  const last = await readLastCheck(root);
  const finding = last?.findings?.find((/** @type {{id?: string}} */ f) => f.id === options.finding);
  if (!finding) {
    return {
      gone: false,
      detail: `The last check has no finding called "${options.finding ?? ''}". Run a check first, then prove one of the ids it gives you.`,
    };
  }

  const project = await openProject(options);
  try {
    const changed = await whatChanged(project.root);
    const wanted = (options.revert ?? []).map((f) => f.replace(/^\.\//, ''));
    const narrowed = wanted.length
      ? { ...changed, hunks: changed.hunks.filter((h) => wanted.some((w) => h.file === w || h.file.startsWith(`${w}/`))) }
      : changed;

    const proof = await proveCause(finding, {
      cwd: project.root,
      walk: project.walk,
      journeys: project.journeys,
      candidate: project.candidate,
      changed: narrowed,
      normalise: project.normalise,
      signal: options.signal,
    });
    return {
      gone: proof.verdict === 'caused by that change',
      verdict: proof.verdict,
      escalates: proof.escalates,
      detail: proof.why ? `${proof.what} ${proof.why}` : proof.what,
    };
  } finally {
    await project.close();
  }
}

/**
 * @param {string} root
 * @returns {Promise<{findings?: any[]}|null>}
 */
async function readLastCheck(root) {
  try {
    return JSON.parse(await fsp.readFile(path.join(root, '.staysfixed', 'v2', 'last-check.json'), 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Opening a project
// ---------------------------------------------------------------------------

/**
 * Everything the loop needs, gathered once.
 *
 * @typedef {object} Project
 * @property {string} root
 * @property {string} product
 * @property {import('./types.js').Store} store
 * @property {BuildFingerprint} candidate
 * @property {string} [against]   The reference build's own id, once a name has been resolved.
 * @property {Journey[]} journeys
 * @property {import('./run.js').Walker} walk
 * @property {(reference: BuildFingerprint, ctx: {events?: CheckEvents, signal?: AbortSignal}) => Promise<LiveBuild|null>} bootReference
 * @property {(capture: Capture) => Capture} normalise
 * @property {() => Promise<void>} close
 */

/**
 * @param {CheckOptions} options
 * @returns {string}
 */
function projectRootFor(options) {
  const from = path.resolve(options.cwd ?? options.root ?? process.cwd());
  const config = options.configFile ?? findConfigFile(from);
  return config ? rootForConfig(config) : from;
}

/**
 * @param {CheckOptions} options
 * @returns {Promise<Project>}
 */
async function openProject(options) {
  const root = projectRootFor(options);
  const configFile = options.configFile ?? findConfigFile(root) ?? null;
  const config = await readConfig(configFile);
  const product = options.product ?? String(config.product ?? (await packageName(root)) ?? path.basename(root));

  const store = openStore({ root });
  await ensureStore(store);

  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-check-'));
  const evidenceDir = path.join(scratch, 'evidence');
  await fsp.mkdir(evidenceDir, { recursive: true });

  const candidate = await fingerprintWorkingTree(root, product);
  await saveBuild(store, candidate);

  // A name like "HEAD", "v0.13.0" or a branch is what a person types; the store only knows
  // builds. Turning the name into a commit here, and putting that commit in the store, is
  // what lets a check be aimed at any point in history without every commit having been
  // walked before. Without it "HEAD" matches nothing and the check reports itself blocked.
  const reference = options.against ? await fingerprintCommit(root, product, options.against) : null;
  if (reference) await saveBuild(store, reference);

  const journeys = await gatherJourneys({ root, config, options });
  if (journeys.length === 0) {
    await fsp.rm(scratch, { recursive: true, force: true });
    // Two different situations wear the same symptom, and the difference is the
    // whole of what a person needs to hear. A project that has never been set up
    // should be told to set it up; one that IS set up and still has nothing to walk
    // has a settings file that says nothing, which is a different problem with a
    // different fix. Saying "nothing to walk" to the first is true and useless.
    if (!configFile) {
      throw new StaysFixedError('No Stays Fixed config found here, so there is nothing to check.', {
        hint: 'Run `staysfixed init` in your project to make one. It takes about thirty seconds.',
      });
    }
    throw new StaysFixedError('There is nothing to walk in this project, so a check would prove nothing.', {
      hint:
        'List the commands worth running under "process": {"commands": [{"name": "help", "run": "node bin/cli.js --help"}]} in your staysfixed config, ' +
        'or point the check at a journeys file with --journeys <file>.',
    });
  }

  const rules = mergeRules(DEFAULT_RULES, [
    ...machineRules({ root, home: os.homedir(), tmp: os.tmpdir() }),
    ...machineRules({ root: scratch }),
    ...(await loadRules(path.join(root, '.staysfixed', 'rules.json'))),
  ]);

  /** @type {(capture: Capture) => Capture} */
  const normalise = (capture) => normaliseCapture(capture, rules);

  /** @type {(() => Promise<void>)[]} */
  const cleanUps = [async () => fsp.rm(scratch, { recursive: true, force: true })];

  /** @type {import('./run.js').Walker} */
  const walk = async (req) => walkOne(req, { root, scratch, evidenceDir, config });

  /** @type {Project['bootReference']} */
  const bootReference = async (reference, ctx) => {
    const live = await exportBuild(root, reference, scratch);
    if (live) cleanUps.push(live.release);
    if (live) ctx.events?.emit({ type: 'note', at: ctx.events.elapsed(), message: live.why ?? 'The old build is on this machine.' });
    return live;
  };

  return {
    root,
    product,
    store,
    candidate,
    against: reference ? reference.id : options.against,
    journeys,
    walk,
    bootReference,
    normalise,
    close: async () => {
      for (const done of cleanUps.reverse()) {
        try {
          await done();
        } catch {
          // Cleaning up is best effort. A scratch folder left behind is untidy; failing a
          // finished check because of one is worse.
        }
      }
      for (const adapter of ADAPTERS) {
        try {
          await adapter.teardown();
        } catch {
          // Same again: an adapter that will not tidy up cannot be allowed to lose the answer.
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Walking one journey
// ---------------------------------------------------------------------------

/**
 * Walk one journey once, and turn what the adapter saw into a capture.
 *
 * Every walk gets its OWN scratch copy of the build. That is more copying than an adapter
 * would do left to itself, and it is not negotiable: run one journey twice into the same
 * folder and the second run starts with the first run's files already written, so a file
 * the product creates every time looks like a file it created once. That reads as wobble,
 * and wobble is subtracted — which would switch off the whole "a file is no longer written"
 * class of finding without a word of warning.
 *
 * @param {WalkRequest} req
 * @param {{root: string, scratch: string, evidenceDir: string, config: Record<string, any>}} where
 * @returns {Promise<Capture>}
 */
async function walkOne(req, where) {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const adapter = adapterFor(req.journey);
  // A reference walk comes with the folder the old build was exported into. A candidate
  // walk reads the working tree.
  const from = req.dir ?? where.root;

  /** @type {Observation[]} */
  let observations = [];
  /** @type {import('./types.js').CoverageGap[]} */
  const gaps = [];

  if (!adapter) {
    gaps.push({
      what: `The journey "${req.journey.describe || req.journey.name}" was not walked.`,
      why: `Nothing here knows how to drive a ${req.journey.surface} journey yet.`,
      unlockedBy: 'Wait for that platform, or write the journey against one that is here: a command, a module import, or an HTTP route.',
      surface: req.journey.surface,
    });
  } else {
    const runId = `${req.build.id}-${req.run}-${req.journey.name}`;
    const ctx = {
      signal: req.signal,
      scratchDir: path.join(where.scratch, safeSegment(runId)),
      evidenceDir: where.evidenceDir,
      seed: 20260829,
      clock: '2026-08-29T09:00:00.000Z',
      config: where.config[adapter.name] ?? {},
      /** @param {string} message */
      log: (message) => req.events?.emit({ type: 'note', at: req.events.elapsed(), message }),
    };
    await fsp.mkdir(ctx.scratchDir, { recursive: true });

    /** @type {import('./adapters/contract.js').PreparedBuild|null} */
    let prepared = null;
    try {
      prepared = await adapter.prepare(
        {
          id: runId,
          label: req.which === 'reference' ? 'the build you were happy with' : 'the build you have',
          role: req.which,
          root: from,
          gitSha: req.build.gitSha ?? null,
        },
        ctx,
      );
      observations = await adapter.run(req.journey, prepared, ctx);
    } catch (e) {
      // A journey that fell over is a hole in the coverage, never a silent pass and never
      // the end of the run — the other journeys' work is worth keeping.
      gaps.push({
        what: `The journey "${req.journey.describe || req.journey.name}" stopped partway.`,
        why: messageOf(e),
        unlockedBy: 'Run that one journey on its own to see what it does.',
        surface: req.journey.surface,
      });
    } finally {
      if (prepared) {
        try {
          await prepared.dispose();
        } catch {
          // Best effort, as above.
        }
      }
      await fsp.rm(ctx.scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** @type {Partial<Record<Channel, number>>} */
  const byChannel = {};
  for (const o of observations) byChannel[o.channel] = (byChannel[o.channel] ?? 0) + 1;

  /** @type {Coverage} */
  const coverage = {
    paths: observations.length,
    journeys: 1,
    byChannel,
    gaps,
  };
  const doors = observations.filter((o) => o.channel === 'contract').length;
  if (doors > 0) {
    coverage.doorsKnown = doors;
    // Nothing walked through them: the contract channel reads doors out of the source, and
    // knowing a door exists is not the same as having opened it. Saying so is the coverage
    // ledger doing its job.
    coverage.doorsWalked = 0;
  }

  return {
    id: newCaptureId(req.run),
    journey: req.journey.name,
    source: req.journey.source,
    build: req.build,
    run: req.run,
    startedAt,
    durationMs: Date.now() - started,
    observations: sortObservations(observations),
    coverage,
    complete: true,
  };
}

/**
 * @param {Journey} journey
 * @returns {Adapter|null}
 */
function adapterFor(journey) {
  const step = /** @type {{act?: string}} */ (journey.steps?.[0] ?? {});
  if (step.act === 'read') return sourceAdapter;
  const wanted = /** @type {Record<string, string>} */ (ADAPTER_FOR_SURFACE)[journey.surface];
  return ADAPTERS.find((a) => a.name === wanted) ?? null;
}

// ---------------------------------------------------------------------------
// Where the steps come from
// ---------------------------------------------------------------------------

/**
 * Journeys, in the order the design ranks them: read out of the code first, because it is
 * free and exact, then whatever the project's own config or a journeys file names.
 *
 * The contract journey is always added. It costs one read of the source, it runs no code at
 * all, and it is the only channel that sees a door nobody has ever walked through.
 *
 * @param {{root: string, config: Record<string, any>, options: CheckOptions}} a
 * @returns {Promise<Journey[]>}
 */
async function gatherJourneys({ root, config, options }) {
  /** @type {Journey[]} */
  const journeys = [];

  const named = options.journeys && options.journeys !== 'code' && options.journeys !== 'config' ? options.journeys : null;
  if (named) journeys.push(...(await readJourneyFile(path.resolve(root, named))));

  for (const adapter of ADAPTERS) {
    if (adapter === sourceAdapter && named && options.journeys !== 'code') {
      // A journeys file names exactly what to walk. The contract read is still added,
      // because it cannot break anything and it sees what no journey does.
    }
    /** @type {import('./adapters/contract.js').AdapterProject} */
    const project = { root, config: config[adapter.name] ?? {} };
    let detection;
    try {
      detection = await adapter.detect(project);
    } catch {
      continue;
    }
    if (!detection.applies) continue;
    if (adapter !== sourceAdapter && named) continue;
    try {
      journeys.push(...(await adapter.journeys(project)));
    } catch {
      // An adapter that cannot list its journeys contributes none. It is not a reason to
      // throw away the ones that could.
    }
  }

  const only = options.only ?? [];
  const chosen = only.length > 0 ? journeys.filter((j) => only.some((n) => j.name === n || j.name.includes(n))) : journeys;

  // Two journeys with one name would write into one another's records.
  /** @type {Journey[]} */
  const out = [];
  const seen = new Set();
  for (const j of chosen) {
    if (seen.has(j.name)) continue;
    seen.add(j.name);
    out.push(j);
  }
  return out;
}

/**
 * @param {string} file
 * @returns {Promise<Journey[]>}
 */
async function readJourneyFile(file) {
  /** @type {string} */
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    throw new StaysFixedError(`There is no journeys file at ${file}.`, {
      hint: 'A journeys file is a JSON list, each entry with a name, a describe, a surface and its steps.',
    });
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new StaysFixedError(`The journeys file at ${file} is not readable JSON: ${messageOf(e)}`);
  }
  const list = Array.isArray(parsed) ? parsed : /** @type {{journeys?: unknown}} */ (parsed)?.journeys;
  if (!Array.isArray(list)) {
    throw new StaysFixedError(`The journeys file at ${file} has to be a list of journeys, or an object with a "journeys" list in it.`);
  }
  return list.map((entry, i) => {
    const j = /** @type {Record<string, any>} */ (entry);
    if (typeof j?.name !== 'string' || j.name === '') {
      throw new StaysFixedError(`The journey at position ${i + 1} in ${file} has no name, and a name is what its addresses are built from.`);
    }
    return /** @type {Journey} */ ({
      name: j.name,
      describe: String(j.describe ?? j.name),
      source: j.source ?? 'code',
      surface: j.surface ?? 'cli',
      from: j.from ?? file,
      steps: Array.isArray(j.steps) ? j.steps : [],
      channels: j.channels,
      irreversible: j.irreversible === true,
      skip: j.skip,
      timeoutMs: j.timeoutMs,
    });
  });
}

/**
 * @param {string|null} configFile
 * @returns {Promise<Record<string, any>>}
 */
async function readConfig(configFile) {
  if (!configFile) return {};
  try {
    if (configFile.endsWith('.json')) return JSON.parse(await fsp.readFile(configFile, 'utf8'));
    const module = await import(`file://${configFile}`);
    const raw = module.default ?? module.config ?? module;
    return /** @type {Record<string, any>} */ (raw);
  } catch (e) {
    throw new StaysFixedError(`The settings in ${configFile} could not be read: ${messageOf(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Which build is which
// ---------------------------------------------------------------------------

/**
 * The build you have, named by what is actually in it.
 *
 * A dirty working tree gets an id that includes a digest of the diff, so editing a file
 * makes a new build rather than adding observations to the record of the last one. That is
 * what "content-addressed against the build artifact" means when the artifact is source.
 *
 * @param {string} root
 * @param {string} product
 * @returns {Promise<BuildFingerprint>}
 */
async function fingerprintWorkingTree(root, product) {
  const sha = await git(root, ['rev-parse', 'HEAD']);
  const diff = (await git(root, ['diff', 'HEAD'])) ?? '';
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard'])) ?? '';
  const dirty = diff.trim() !== '' || untracked.trim() !== '';
  const version = await packageVersion(root);

  /** @type {BuildFingerprint} */
  const build = {
    id: dirty ? `work-${sha256(`${sha ?? ''}\n${diff}\n${untracked}`).slice(0, 12)}` : `git-${(sha ?? 'unknown').slice(0, 12)}`,
    product,
    platform: `${process.platform}-${process.arch}`,
    builtAt: new Date().toISOString(),
  };
  if (sha) build.gitSha = sha;
  if (version) build.version = dirty ? `${version} with uncommitted changes` : version;
  if (dirty) build.dirty = true;
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch && branch !== 'HEAD') build.branch = branch;
  return build;
}

/**
 * The build you were happy with, found by whatever a person calls it.
 *
 * @param {string} root
 * @param {string} product
 * @param {string} name    A commit, a tag, a branch, or a build id already in the store.
 * @returns {Promise<BuildFingerprint|null>}
 */
async function fingerprintCommit(root, product, name) {
  const sha = await git(root, ['rev-parse', '--verify', `${name}^{commit}`]);
  if (!sha) return null;
  /** @type {BuildFingerprint} */
  const build = {
    id: `git-${sha.slice(0, 12)}`,
    product,
    gitSha: sha,
    platform: `${process.platform}-${process.arch}`,
  };
  const described = await git(root, ['describe', '--tags', '--exact-match', sha]);
  if (described) build.version = described;
  return build;
}

/**
 * Put the old build back on this machine so it can be walked live.
 *
 * `git archive` is used rather than a checkout or a worktree for one reason: it reads
 * history and writes nothing at all into the repository it reads from. A worktree adds
 * bookkeeping inside somebody's `.git`, and this tool has no business leaving anything
 * behind in the project it is checking.
 *
 * @param {string} root
 * @param {BuildFingerprint} reference
 * @param {string} scratch
 * @returns {Promise<LiveBuild|null>}
 */
async function exportBuild(root, reference, scratch) {
  const sha = reference.gitSha;
  if (!sha) return null;
  const dir = path.join(scratch, `reference-${sha.slice(0, 12)}`);
  await fsp.mkdir(dir, { recursive: true });
  try {
    // Straight through a pipe: the archive is never written to disk, so a big repository
    // does not cost twice the space to look at.
    await exec('/bin/sh', ['-c', `git -C ${quote(root)} archive --format=tar ${quote(sha)} | tar -x -C ${quote(dir)}`], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw new StaysFixedError(`${sha.slice(0, 7)} could not be put back on this machine, so it cannot be walked live. ${messageOf(e)}`, {
      hint: 'Check the commit is still in this repository. Without it the check falls back to the stored record, which is weaker.',
    });
  }
  return {
    build: reference,
    dir,
    why: `The old build was exported out of git into a scratch folder. Your working tree was not touched, and nothing was written into .git.`,
    release: async () => {
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Small things
// ---------------------------------------------------------------------------

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string|null>}
 */
async function git(cwd, args) {
  try {
    const { stdout } = await exec('git', args, { cwd, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
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
async function packageName(root) {
  const pkg = await packageJson(root);
  return typeof pkg?.name === 'string' ? pkg.name : null;
}

/**
 * @param {string} root
 * @returns {Promise<string|null>}
 */
async function packageVersion(root) {
  const pkg = await packageJson(root);
  return typeof pkg?.version === 'string' ? pkg.version : null;
}

/** @param {string} text */
function quote(text) {
  return `'${text.split("'").join(`'\\''`)}'`;
}

/** @param {string} name */
function safeSegment(name) {
  return name.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'run';
}
