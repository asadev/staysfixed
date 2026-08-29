/**
 * Running it where merges happen.
 *
 * A check that only runs on the author's laptop catches what the author was already
 * looking for. The same check running on every pull request catches what nobody was
 * looking for, which is the entire class of thing this tool exists to find. So this file
 * is the part that makes a build server a first-class place to run from.
 *
 * CI IS NOT A WORSE MACHINE THAN A LAPTOP. It is a better one, for this specific job. A
 * fresh runner has the same fonts every time, the same operating system, nothing else
 * competing for a port or for memory, and no half-finished experiment left over from
 * yesterday afternoon. Everything version 2 does rests on "the difference was caused by the
 * change and nothing else", and a machine that is identical on every run is worth a great
 * deal to that claim.
 *
 * THE HARD PART IS THE REFERENCE, and it is worth stating why before reading any code.
 * On a laptop the reference is a build the owner shipped, remembered in a folder that has
 * been sitting there for weeks. A fresh runner has no folder and no memory. So the
 * reference has to be reconstructed out of what a build server does have, which is git —
 * and git turns out to be enough, because `check` accepts a commit and puts that commit
 * back on the machine with `git archive` before walking it. A pull request compared
 * against the commit it forked from is a FULL PAIRED RUN: two builds, one runner, minutes
 * apart. That is the strongest answer this tool can give, and it is available in CI from a
 * bare checkout with no stored record at all.
 *
 * Not every event can reach that, so `referenceForCI` works down a ranked list and says
 * out loud which rung it landed on. The modes are NOT equally strong and this file never
 * pretends they are: every report carries the mode, how it was found, and what would have
 * made it stronger.
 *
 * WHAT THIS FILE MAY NEVER DO: approve anything. It does not cut a reference, it does not
 * write a waiver, it does not record a build as checked in a way that would let one be cut
 * later. CI reports; a person ships. That line is the whole safeguard and a build server
 * sits on the wrong side of it — a green pipeline is not somebody saying "that is what my
 * product does now". So there is deliberately no import of `cutReference` or `setReference`
 * anywhere below, and there never should be.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { EXIT, messageOf } from '../core/errors.js';
import { check } from './check.js';
import { openStore, listBuilds, referencePointer } from './store.js';

const exec = promisify(execFile);

/** @typedef {import('./types.js').Finding} Finding */
/** @typedef {import('./check.js').CheckOutcome} CheckOutcome */

/** A plain map of environment variables. `process.env` is one; a fake one in a test is another. */
/** @typedef {Record<string, string|undefined>} Env */

// ---------------------------------------------------------------------------
// What the environment says
// ---------------------------------------------------------------------------

/**
 * Which build server this is, or none.
 *
 * `none` also covers "something set CI=true and we do not recognise it". That is deliberate:
 * claiming to be on a build server we cannot read the variables of would produce a confident
 * wrong answer about the base commit, which is worse than admitting we do not know.
 *
 * @typedef {'github'|'gitlab'|'circleci'|'none'} CIProvider
 */

/**
 * What a pull request is, said the same way whichever server described it.
 *
 * @typedef {object} CIPullRequest
 * @property {string|null} number    The number a person would quote.
 * @property {string|null} base      The branch it is aimed at, by name: 'main'.
 * @property {string|null} baseSha   The base commit, when the server told us one outright.
 * @property {string|null} headSha   The tip of the branch being proposed.
 */

/**
 * What this machine says about itself.
 *
 * @typedef {object} CIEnvironment
 * @property {boolean} on            Are we on a build server at all.
 * @property {CIProvider} provider
 * @property {string} name           What a person calls it: 'GitHub Actions'.
 * @property {string|null} commit    The commit being built. See the note on GitHub below.
 * @property {string|null} branch
 * @property {string|null} repo      'owner/name', when the server says.
 * @property {CIPullRequest|null} pullRequest
 * @property {string|null} beforeSha The commit that was on the branch before this push.
 * @property {string|null} runId
 * @property {string|null} runUrl    A link a person can open.
 * @property {string|null} summaryFile  A file the job summary is appended to, if there is one.
 * @property {string} note           One plain sentence describing all of the above.
 */

/**
 * Read what the environment says about the commit, the branch, the pull request and the base.
 *
 * ONE GOTCHA WORTH THE PARAGRAPH. On GitHub, a `pull_request` event does not build the tip of
 * your branch: it builds a temporary merge of your branch into the base, and `GITHUB_SHA`
 * names that merge commit, which exists nowhere in anybody's history. The tip of the branch
 * is in the event file under `pull_request.head.sha`. Getting this wrong makes every report
 * name a commit nobody can find, so both are read and both are kept.
 *
 * @param {Env} [env]
 * @returns {CIEnvironment}
 */
export function detectCI(env = process.env) {
  if (env.GITHUB_ACTIONS === 'true') return fromGitHub(env);
  if (env.GITLAB_CI === 'true') return fromGitLab(env);
  if (env.CIRCLECI === 'true') return fromCircle(env);

  const something = env.CI === 'true' || env.CI === '1';
  return {
    on: something,
    provider: 'none',
    name: something ? 'a build server we do not recognise' : 'this machine',
    commit: null,
    branch: null,
    repo: null,
    pullRequest: null,
    beforeSha: null,
    runId: null,
    runUrl: null,
    summaryFile: null,
    note: something
      ? 'Something says this is a build server, but not one whose variables we know how to read. Nothing here can work out what to compare against on its own, so the commit has to be named by hand.'
      : 'This is not a build server, so everything below falls back to what git can work out locally.',
  };
}

/**
 * @param {Env} env
 * @returns {CIEnvironment}
 */
function fromGitHub(env) {
  const event = readEventFile(env.GITHUB_EVENT_PATH);
  const pr = /** @type {Record<string, any>|null} */ (event?.pull_request ?? null);
  // Three ways to know, and all three are used, because relying on the event file alone
  // would silently stop recognising a pull request the moment that file is unreadable —
  // and the whole strength of a CI run rests on knowing which base to fork from.
  const isPr = pr !== null || (env.GITHUB_EVENT_NAME ?? '').startsWith('pull_request') || Boolean(env.GITHUB_BASE_REF);

  /** @type {CIPullRequest|null} */
  const pullRequest = isPr
    ? {
        number: text(pr?.number) ?? text(event?.number),
        base: env.GITHUB_BASE_REF || text(pr?.base?.ref),
        baseSha: text(pr?.base?.sha),
        headSha: text(pr?.head?.sha),
      }
    : null;

  const repo = env.GITHUB_REPOSITORY ?? null;
  const server = env.GITHUB_SERVER_URL ?? 'https://github.com';
  const runId = env.GITHUB_RUN_ID ?? null;

  return {
    on: true,
    provider: 'github',
    name: 'GitHub Actions',
    // The head of the branch, not the throwaway merge commit, whenever we can tell them apart.
    commit: pullRequest?.headSha ?? env.GITHUB_SHA ?? null,
    branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || null,
    repo,
    pullRequest,
    beforeSha: usableSha(text(event?.before)),
    runId,
    runUrl: repo && runId ? `${server}/${repo}/actions/runs/${runId}` : null,
    summaryFile: env.GITHUB_STEP_SUMMARY ?? null,
    note: isPr
      ? `GitHub Actions, on pull request ${pullRequest?.number ?? '?'} into ${pullRequest?.base ?? 'the base branch'}.`
      : `GitHub Actions, on a push to ${env.GITHUB_REF_NAME ?? 'a branch'}.`,
  };
}

/**
 * @param {Env} env
 * @returns {CIEnvironment}
 */
function fromGitLab(env) {
  const isMr = Boolean(env.CI_MERGE_REQUEST_IID);
  return {
    on: true,
    provider: 'gitlab',
    name: 'GitLab CI',
    commit: env.CI_COMMIT_SHA ?? null,
    branch: env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || env.CI_COMMIT_REF_NAME || null,
    repo: env.CI_PROJECT_PATH ?? null,
    pullRequest: isMr
      ? {
          number: env.CI_MERGE_REQUEST_IID ?? null,
          base: env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME ?? null,
          // GitLab is the one server that hands over the fork point outright, already worked
          // out, with no fetching. Nothing else in this file gets an answer this cheaply.
          baseSha: usableSha(env.CI_MERGE_REQUEST_DIFF_BASE_SHA ?? null),
          headSha: env.CI_COMMIT_SHA ?? null,
        }
      : null,
    beforeSha: usableSha(env.CI_COMMIT_BEFORE_SHA ?? null),
    runId: env.CI_PIPELINE_ID ?? null,
    runUrl: env.CI_JOB_URL ?? env.CI_PIPELINE_URL ?? null,
    // GitLab has no job summary of its own. The report still gets written to a file and
    // uploaded, it just does not appear on the pipeline page.
    summaryFile: null,
    note: isMr
      ? `GitLab CI, on merge request ${env.CI_MERGE_REQUEST_IID} into ${env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME ?? 'the target branch'}.`
      : `GitLab CI, on a push to ${env.CI_COMMIT_REF_NAME ?? 'a branch'}.`,
  };
}

/**
 * @param {Env} env
 * @returns {CIEnvironment}
 */
function fromCircle(env) {
  const number = env.CIRCLE_PR_NUMBER ?? lastSegment(env.CIRCLE_PULL_REQUEST);
  const repo = env.CIRCLE_PROJECT_USERNAME && env.CIRCLE_PROJECT_REPONAME ? `${env.CIRCLE_PROJECT_USERNAME}/${env.CIRCLE_PROJECT_REPONAME}` : null;
  return {
    on: true,
    provider: 'circleci',
    name: 'CircleCI',
    commit: env.CIRCLE_SHA1 ?? null,
    branch: env.CIRCLE_BRANCH ?? null,
    repo,
    // CircleCI tells a job the pull request exists and refuses to say what it is aimed at.
    // Recording the number and admitting the base is unknown is the honest shape: the base
    // then has to come from git, and if git cannot supply it the report says so.
    pullRequest: number ? { number, base: null, baseSha: null, headSha: env.CIRCLE_SHA1 ?? null } : null,
    beforeSha: null,
    runId: env.CIRCLE_BUILD_NUM ?? null,
    runUrl: env.CIRCLE_BUILD_URL ?? null,
    summaryFile: null,
    note: number
      ? `CircleCI, on pull request ${number}. CircleCI does not tell a job which branch the request is aimed at, so the base has to be worked out from git.`
      : `CircleCI, on a push to ${env.CIRCLE_BRANCH ?? 'a branch'}.`,
  };
}

// ---------------------------------------------------------------------------
// The reference
// ---------------------------------------------------------------------------

/**
 * How a build server can get hold of something to compare against, best first.
 *
 * - `named`            Somebody said which commit. Nothing beats being told.
 * - `merge-base`       The commit this branch forked from. The right answer for a pull
 *                      request: it isolates what THIS branch did from everything else that
 *                      landed on the base while it was open.
 * - `released`         The commit the project's own reference points at — what its owner
 *                      last said ship to. The right answer for a push to a main branch.
 * - `last-tag`         The most recent tag in this history. Fair, not strong: other people's
 *                      merges since that tag show up as differences too.
 * - `previous-commit`  What the branch was before this push. Narrow: it proves this push,
 *                      not this branch.
 * - `stored-record`    Observations committed into the repository or restored from a cache.
 *                      No old build is booted at all. Weakest, and it carries a caveat about
 *                      the machine that took them.
 * - `none`             Nothing to compare against. Not a pass, and it must not exit zero.
 *
 * @typedef {'named'|'merge-base'|'released'|'last-tag'|'previous-commit'|'stored-record'|'none'} CIReferenceMode
 */

/**
 * How much an answer from this mode is worth. Four words rather than a number, because a
 * number invites somebody to set a threshold on it and there are no thresholds in version 2.
 * @typedef {'strong'|'fair'|'weak'|'none'} CIStrength
 */

/**
 * One mode that was thought about, and what happened.
 * @typedef {object} CIConsidered
 * @property {CIReferenceMode} mode
 * @property {boolean} available
 * @property {string} why            Why it was used, or why it could not be.
 * @property {string} [unlockedBy]   The concrete thing that would make it available.
 */

/**
 * What a build server found to compare against, and how much it is worth.
 *
 * @typedef {object} CIReference
 * @property {CIReferenceMode} mode
 * @property {string|null} against   Hand this straight to `check({against})`. A commit.
 * @property {boolean} paired        Can the old build be booted and walked here.
 * @property {CIStrength} strength
 * @property {string} how            Plain English: how this reference was found.
 * @property {string} why            Plain English: why this one and not a stronger one.
 * @property {string} [caveat]       The warning that belongs on every report of this run.
 * @property {string} [unlockedBy]   The concrete thing that would make it stronger.
 * @property {CIConsidered[]} considered
 * @property {boolean} shallow       The checkout has no full history, which rules a lot out.
 * @property {'same'|'different'|'unknown'} [machine]
 *                                   Only for a stored record: was it taken on a machine like
 *                                   this one. A record from a different machine reintroduces
 *                                   every difference that comes from the machine being
 *                                   different, which is the thing pairing exists to remove.
 */

/**
 * Work out what this build server can compare against.
 *
 * Runs no network calls and writes nothing. A shallow checkout is detected and REPORTED
 * rather than quietly deepened: fetching more history is a thing a workflow file should say
 * it is doing, in the open, not something a library does behind a job's back.
 *
 * @param {{cwd?: string, env?: Env, against?: string, product?: string}} [opts]
 * @returns {Promise<CIReference>}
 */
export async function referenceForCI(opts = {}) {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const env = opts.env ?? process.env;
  const ci = detectCI(env);
  const shallow = (await git(cwd, ['rev-parse', '--is-shallow-repository'])) === 'true';
  const deepen = 'Check out the full history. On GitHub that is `fetch-depth: 0` on actions/checkout; on GitLab it is `GIT_DEPTH: 0`.';
  const headSha = await resolveCommit(cwd, 'HEAD');

  /**
   * A reference that turns out to BE the build under test is the most dangerous answer this
   * file could give: everything matches, nothing is reported, and the run looks like the
   * strongest possible pass. It is how a shallow clone kills the whole tool silently — clone
   * at depth one and the fork point of every branch comes back as HEAD.
   *
   * So every candidate goes through here, and one that is the same commit is thrown away.
   *
   * @param {string|null} sha
   * @returns {string|null}
   */
  const notThisBuild = (sha) => (sha && headSha && sha === headSha ? null : sha);
  const sameBuild = 'is this exact build. Comparing something against itself proves nothing, so it was not used.';

  /** @type {CIConsidered[]} */
  const considered = [];

  /**
   * @param {CIReferenceMode} mode
   * @param {string} why
   * @param {string} [unlockedBy]
   */
  const missed = (mode, why, unlockedBy) => {
    /** @type {CIConsidered} */
    const entry = { mode, available: false, why };
    if (unlockedBy) entry.unlockedBy = unlockedBy;
    considered.push(entry);
  };

  // ---- named -------------------------------------------------------------
  if (opts.against) {
    const named = await resolveCommit(cwd, opts.against);
    const sha = notThisBuild(named);
    if (named && !sha) {
      missed('named', `You named ${opts.against}, and that ${sameBuild}`, 'Name an earlier commit, tag or release.');
    } else if (sha) {
      considered.push({ mode: 'named', available: true, why: `Somebody named ${opts.against} outright.` });
      return {
        mode: 'named',
        against: sha,
        paired: true,
        strength: 'strong',
        how: `You named ${opts.against}, and it is in this checkout.`,
        why: 'Nothing beats being told which build counts as working.',
        considered,
        shallow,
      };
    }
    else missed('named', `${opts.against} was named, but there is no such commit in this checkout.`, shallow ? deepen : 'Check the tag or commit still exists in this repository.');
  } else {
    missed('named', 'Nobody named a commit to compare against.');
  }

  const wantsMergeBase = ci.pullRequest !== null;

  // ---- merge base --------------------------------------------------------
  if (wantsMergeBase) {
    const found = await findMergeBase(cwd, ci);
    if (found && !notThisBuild(found.sha)) {
      // A depth-one clone answers every merge-base question with HEAD. This is the exact
      // shape of the silent green run, and it has to be caught here rather than reported
      // as the strongest mode there is.
      missed(
        'merge-base',
        shallow
          ? `The fork point came back as this same commit, which ${sameBuild} A clone with no history always answers this way, so nothing has really been worked out.`
          : `This branch has nothing of its own on top of its base yet, so the fork point ${sameBuild}`,
        shallow ? deepen : 'Push a commit to the branch, or aim the check at a different base.',
      );
    } else if (found) {
      considered.push({ mode: 'merge-base', available: true, why: found.how });
      return {
        mode: 'merge-base',
        against: found.sha,
        paired: true,
        strength: 'strong',
        how: found.how,
        why: 'This is the right one for a pull request: it compares what this branch did, and nothing that landed on the base branch while it was open.',
        considered,
        shallow,
      };
    }
    else
      missed(
        'merge-base',
        shallow
          ? 'This is a pull request, but the checkout has no history, so the commit this branch forked from cannot be worked out.'
          : 'This is a pull request, but the base branch is not in this checkout, so the fork point cannot be worked out.',
        deepen,
      );
  } else {
    missed('merge-base', ci.on ? 'This run is not a pull request, so there is no branch to find a fork point for.' : 'Not on a build server, so there is no pull request to read.');
  }

  // ---- released ----------------------------------------------------------
  const released = await releasedCommit(cwd, opts.product);
  if (released) {
    const found = await resolveCommit(cwd, released.sha);
    const sha = notThisBuild(found);
    if (found && !sha) {
      missed('released', `The build this project last said ship to ${sameBuild}`, 'Nothing is wrong: you are checking the build you already shipped.');
    } else if (sha) {
      considered.push({ mode: 'released', available: true, why: `The project's reference points at ${short(sha)}, and it is in this checkout.` });
      /** @type {CIReference} */
      const result = {
        mode: 'released',
        against: sha,
        paired: true,
        strength: 'strong',
        how: `The build this project last said ship to: ${short(sha)}${released.note ? ` — ${released.note}` : ''}.`,
        why: 'This is the definition of working for this product, set by a person shipping, not by anything on this build server.',
        considered,
        shallow,
      };
      // On a pull request this is the second choice for a reason worth saying: everything
      // merged since the release counts as a difference too, so the list is longer than the
      // branch is responsible for.
      if (wantsMergeBase) {
        result.strength = 'fair';
        result.caveat =
          'The fork point of this branch could not be worked out, so this was compared against the last shipped build instead. Anything else that was merged since that release will show up here as well, even though this branch did not do it.';
        result.unlockedBy = deepen;
      }
      return result;
    }
    else missed('released', `The project's reference points at ${short(released.sha)}, and that commit is not in this checkout.`, shallow ? deepen : 'Make sure the commit that was shipped is still in this repository.');
  } else {
    missed('released', 'This project has no build on record as working. Only its owner can set one, by shipping.');
  }

  // ---- last tag ----------------------------------------------------------
  const tag = await lastTag(cwd);
  if (tag) {
    considered.push({ mode: 'last-tag', available: true, why: `The most recent tag in this history is ${tag.name}.` });
    return {
      mode: 'last-tag',
      against: tag.sha,
      paired: true,
      strength: 'fair',
      how: `The most recent tag in this history: ${tag.name} (${short(tag.sha)}).`,
      why: 'There is no pull request base and nothing on record as working, so the last tag is the nearest thing to a build somebody was happy with.',
      caveat:
        'A tag is not the same as a build somebody said ship to. Everything merged since that tag shows up here as a difference, whoever wrote it.',
      unlockedBy: 'Record a reference when you release, so this compares against what you actually shipped.',
      considered,
      shallow,
    };
  }
  missed('last-tag', shallow ? 'No tags are in this checkout, and a shallow clone fetches none.' : 'This repository has no tags.', shallow ? deepen : 'Tag your releases.');

  // ---- previous commit ---------------------------------------------------
  const before = notThisBuild(ci.beforeSha ? await resolveCommit(cwd, ci.beforeSha) : await resolveCommit(cwd, 'HEAD^'));
  if (before) {
    considered.push({ mode: 'previous-commit', available: true, why: `The branch was at ${short(before)} before this push.` });
    return {
      mode: 'previous-commit',
      against: before,
      paired: true,
      strength: 'fair',
      how: `What this branch was immediately before: ${short(before)}.`,
      why: 'Nothing stronger was available, and one commit back is still a real build that can be booted and walked here.',
      caveat:
        'This proves what this one push did, not what this branch did. A break introduced three pushes ago is in both builds, so it will not appear here at all.',
      unlockedBy: 'Run this on pull requests as well, where the fork point of the whole branch is available.',
      considered,
      shallow,
    };
  }
  missed('previous-commit', 'There is no earlier commit in this checkout.', shallow ? deepen : undefined);

  // ---- stored record -----------------------------------------------------
  const stored = await storedRecord(cwd, opts.product);
  if (stored) {
    considered.push({ mode: 'stored-record', available: true, why: `There are stored observations for ${stored.buildId}.` });
    const same = stored.machine === 'same';
    return {
      mode: 'stored-record',
      // Null on purpose. The engine finds a stored record through its own reference pointer;
      // handing it a commit it cannot boot would turn a weak answer into a blocked run.
      against: null,
      paired: false,
      strength: same ? 'fair' : 'weak',
      how: `No old build could be put back on this machine, so this used the observations stored for ${stored.buildId}.`,
      why: 'Nothing in this checkout could be booted and walked, so all that is left is the record the old build left the last time it ran.',
      caveat: same
        ? 'No old build was run here. This compares against a record, which cannot catch anything that only shows up when the old build is actually running. The record was taken on a machine like this one, so at least the fonts and the operating system match.'
        : 'No old build was run here, and the stored record was taken on a DIFFERENT machine. Different fonts, a different operating system and different paths all count as differences, so expect noise this run cannot tell apart from a real change.',
      unlockedBy: same ? deepen : 'Take the stored record on a runner like this one — cache the .staysfixed folder from a job on your main branch — or check out the full history so an old build can be booted here instead.',
      considered,
      shallow,
      machine: stored.machine,
    };
  }
  missed('stored-record', 'There are no stored observations in this checkout either.', 'Commit the .staysfixed folder, or restore it from a cache written by a job on your main branch.');

  // ---- nothing -----------------------------------------------------------
  return {
    mode: 'none',
    against: null,
    paired: false,
    strength: 'none',
    how: 'Nothing was found to compare against.',
    why: 'No named commit, no pull request base, no reference, no tag, no earlier commit and no stored record. There is nothing in this checkout that says what this product used to do.',
    caveat: 'This run proves nothing about your product either way. It is not a pass.',
    unlockedBy: deepen,
    considered,
    shallow,
  };
}

/**
 * The commit this branch forked from.
 *
 * Three ways, in order of how right the answer is. `git merge-base` is the true fork point.
 * The base commit the server hands over is the tip of the base branch at the moment the
 * event fired, which is close but not the same thing — if the base has moved since the
 * branch was cut, it includes work this branch never touched.
 *
 * @param {string} cwd
 * @param {CIEnvironment} ci
 * @returns {Promise<{sha: string, how: string}|null>}
 */
async function findMergeBase(cwd, ci) {
  const pr = ci.pullRequest;
  // The tip of the branch, and it must be a commit this checkout actually has. A server can
  // name a commit that was never fetched — a shallow clone, or a merge commit built somewhere
  // else — and `git merge-base` against a name git has never heard of fails with no useful
  // message. Falling back to HEAD is right: HEAD is what is about to be walked either way.
  /** @type {string|null} */
  let head = null;
  for (const candidate of [pr?.headSha, ci.commit, 'HEAD']) {
    if (!candidate) continue;
    head = await resolveCommit(cwd, candidate);
    if (head) break;
  }
  if (!head) return null;

  /** @type {string[]} */
  const bases = [];
  if (pr?.base) bases.push(`origin/${pr.base}`, `refs/remotes/origin/${pr.base}`, pr.base);
  // No base branch was named — CircleCI does this — so try the names a main branch usually has.
  if (bases.length === 0) bases.push('origin/main', 'origin/master', 'origin/HEAD');

  for (const base of bases) {
    if (!(await resolveCommit(cwd, base))) continue;
    const found = await git(cwd, ['merge-base', base, head]);
    if (found) return { sha: found, how: `The commit this branch forked from ${base}: ${short(found)}.` };
  }

  if (pr?.baseSha) {
    const sha = await resolveCommit(cwd, pr.baseSha);
    if (sha) {
      const merged = await git(cwd, ['merge-base', sha, head]);
      const use = merged ?? sha;
      return {
        sha: use,
        how: merged
          ? `The commit this branch forked from, worked out from the base ${ci.name} named: ${short(use)}.`
          : `The tip of the base branch when this pull request was opened: ${short(use)}. That is close to the fork point, not exactly it.`,
      };
    }
  }
  return null;
}

/**
 * The commit this project's own reference points at — the build somebody shipped.
 *
 * Read only. Nothing in this file may move that pointer.
 *
 * @param {string} cwd
 * @param {string} [product]
 * @returns {Promise<{sha: string, note: string}|null>}
 */
async function releasedCommit(cwd, product) {
  try {
    const store = openStore({ root: cwd });
    const name = product ?? (await productName(cwd));
    if (!name) return null;
    const pointer = await referencePointer(store, name);
    if (!pointer) return null;
    const builds = await listBuilds(store, { product: name });
    const hit = builds.find((b) => b.fingerprint.id === pointer.buildId);
    const sha = hit?.fingerprint.gitSha ?? shaFromBuildId(pointer.buildId);
    if (!sha) return null;
    return { sha, note: hit?.fingerprint.version ? `version ${hit.fingerprint.version}` : '' };
  } catch {
    // A store that will not open is a reason to try the next mode, never a reason to fail.
    return null;
  }
}

/**
 * Is there a stored record here at all, and was it taken on a machine like this one.
 *
 * @param {string} cwd
 * @param {string} [product]
 * @returns {Promise<{buildId: string, machine: 'same'|'different'|'unknown'}|null>}
 */
async function storedRecord(cwd, product) {
  try {
    const store = openStore({ root: cwd });
    const name = product ?? (await productName(cwd));
    if (!name) return null;
    const pointer = await referencePointer(store, name);
    const builds = await listBuilds(store, { product: name });
    if (builds.length === 0) return null;
    const hit = (pointer && builds.find((b) => b.fingerprint.id === pointer.buildId)) || builds[0];
    const here = `${process.platform}-${process.arch}`;
    /** @type {'same'|'different'|'unknown'} */
    const machine = !hit.fingerprint.platform ? 'unknown' : hit.fingerprint.platform === here ? 'same' : 'different';
    return { buildId: hit.fingerprint.id, machine };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * What a build server prints, writes and exits with.
 *
 * @typedef {object} CIReport
 * @property {boolean} ok
 * @property {boolean} blocked      The check did not run. Neither a pass nor a failure.
 * @property {number} exitCode      0 nothing changed, 1 something did, 2 no answer at all.
 * @property {string} headline      One sentence, the thing a person reads first.
 * @property {string} markdown      For a job summary page.
 * @property {string} text          For the job log, where markdown is just noise.
 */

/**
 * Turn a verdict into the table a build server shows, and the code it exits with.
 *
 * THE EXIT CODES ARE THE POINT OF THE WHOLE FILE, so they are the part to get right:
 *
 *   0  Nothing that already worked has changed. Merge away.
 *   1  Something changed that nobody accounted for. A person or an agent has to look.
 *   2  The check could not run, or there was nothing to compare against. This is NOT a
 *      pass. A run that proved nothing exiting zero is the exact failure this tool exists
 *      to prevent, and it would be an easy and invisible one to ship.
 *
 * @param {CheckOutcome} verdict
 * @param {{reference?: CIReference, env?: CIEnvironment, durationMs?: number, remembered?: boolean}} [extra]
 * @returns {CIReport}
 */
export function reportForCI(verdict, extra = {}) {
  const reference = extra.reference;
  const blocked = verdict.blocked === true;
  const nothingToCompare = !verdict.reference || verdict.reference.id === '';
  const sealed = (verdict.findings ?? []).filter((f) => f.sealed);
  const rest = (verdict.findings ?? []).filter((f) => !f.sealed);
  const unstable = verdict.newlyUnstable ?? [];

  const exitCode = blocked || nothingToCompare ? EXIT.error : verdict.ok ? EXIT.ok : EXIT.failed;

  const headline = blocked
    ? 'The check could not run, so nothing here says anything about your product either way.'
    : nothingToCompare
      ? 'There was nothing to compare against, so this run proved nothing. It is not a pass.'
      : verdict.ok
        ? 'Nothing that already worked has changed.'
        : sealed.length > 0
          ? `${count(sealed.length, 'thing', 'things')} changed that no agent may wave through, and a person has to look.`
          : `${count(verdict.findings.length, 'thing', 'things')} changed that nobody asked for.`;

  /** @type {string[]} */
  const md = [];
  md.push('## Stays Fixed');
  md.push('');
  md.push(`**${headline}**`);
  md.push('');

  // The admission that this run is weaker than usual goes above the table, not below it.
  // Nobody scrolls back up past a green tick to find out it was not worth much.
  const warnings = [reference?.caveat, verdict.modeWarning].filter((w) => typeof w === 'string' && w !== '');
  for (const w of warnings) md.push(`> **Read this first.** ${w}`, '>');
  if (warnings.length > 0) md.push('');

  md.push('| | |');
  md.push('| --- | --- |');
  if (reference) {
    md.push(row('Compared against', reference.how));
    md.push(row('How that was chosen', reference.why));
    md.push(
      row(
        'How much it is worth',
        reference.mode === 'none'
          ? 'nothing — there was no old build and no record of one, so this run did not compare anything'
          : `${reference.strength} — ${reference.paired ? 'the old build was put back on this runner and walked again' : 'no old build was run; this is a stored record'}`,
      ),
    );
  } else if (!nothingToCompare) {
    md.push(row('Compared against', nameOfBuild(verdict.reference)));
  }
  if (!blocked && !nothingToCompare) {
    const paths = verdict.coverage?.paths ?? 0;
    const journeys = verdict.coverage?.journeys ?? 0;
    md.push(row('Looked at', `${count(paths, 'address', 'addresses')} across ${count(journeys, 'journey', 'journeys')}`));
    md.push(row('Differences', `${count(verdict.differencesReal ?? 0, 'real one', 'real ones')}, and ${count(verdict.differencesNoise ?? 0, 'thing', 'things')} the product disagrees with itself about anyway`));
    if (unstable.length > 0) md.push(row('Newly unpredictable', `${count(unstable.length, 'address', 'addresses')} that used to give the same answer every time`));
    const waived = verdict.accounted?.waived ?? 0;
    if (waived > 0) md.push(row('Already accounted for', `${count(waived, 'finding was', 'findings were')} dropped because an agent had recorded them as intended before the run`));
  }
  const took = extra.durationMs ?? verdict.durationMs;
  if (typeof took === 'number' && took > 0) md.push(row('Took', minutes(took)));
  if (extra.env?.runUrl) md.push(row('This run', extra.env.runUrl));
  md.push('');

  if (sealed.length > 0) {
    md.push('### A person has to look at these');
    md.push('');
    for (const f of sealed) md.push(...findingLines(f));
    md.push('');
  }
  if (rest.length > 0) {
    md.push(sealed.length > 0 ? '### And these' : '### What changed that nobody asked for');
    md.push('');
    for (const f of rest) md.push(...findingLines(f));
    md.push('');
  }
  if (unstable.length > 0) {
    md.push('### These used to give the same answer every time, and now they do not');
    md.push('');
    for (const u of unstable.slice(0, 10)) md.push(`- \`${u.path}\` — two runs of this same build disagree about it, and the old build did not`);
    if (unstable.length > 10) md.push(`- and ${unstable.length - 10} more.`);
    md.push('');
  }

  // Said on a clean run too. A gap that is only mentioned when something fails is a gap
  // nobody ever sees, and quiet that cannot be shown to be earned is worth nothing.
  const gaps = verdict.coverage?.gaps ?? [];
  if (gaps.length > 0) {
    md.push('### What it did not look at');
    md.push('');
    for (const g of gaps.slice(0, 12)) md.push(`- ${g.what} ${g.why}${g.unlockedBy ? ` **${g.unlockedBy}**` : ''}`);
    if (gaps.length > 12) md.push(`- and ${gaps.length - 12} more. All of them are in the evidence attached to this run.`);
    md.push('');
  }

  if (reference?.unlockedBy) {
    md.push('### What would make this run stronger');
    md.push('');
    md.push(reference.unlockedBy);
    md.push('');
  }

  md.push('---');
  md.push('');
  md.push(oneLine(verdict.summary ?? ''));
  md.push('');
  // The engine writes its own closing sentence assuming it was allowed to keep what it saw,
  // because on a laptop it always is. On a build server it is not, and a paragraph saying
  // "this run has been kept" when nothing was kept is exactly the quiet untruth this whole
  // tool exists to stop. So it is corrected here, in the open, rather than edited out.
  if (extra.remembered === false) {
    md.push('Nothing from this run was stored. A build server never writes this product\'s record — only a run on the machine that owns the project does that — so anything above about this run being kept for next time does not apply here.');
    md.push('');
  }
  md.push('_Stays Fixed reports. It never approves anything: only a person shipping can say what "working" means._');
  md.push('');

  const markdown = md.join('\n');
  return { ok: verdict.ok === true && !blocked && !nothingToCompare, blocked, exitCode, headline, markdown, text: plainText(markdown) };
}

/**
 * @param {Finding} f
 * @returns {string[]}
 */
function findingLines(f) {
  /** @type {string[]} */
  const out = [];
  out.push(`- **${f.sealed ? `[${f.class}] ` : ''}${f.title}**`);
  const example = f.differences?.[0];
  if (example) {
    const where = `\`${example.path}\``;
    if (example.kind === 'appeared') out.push(`  - ${where}: was not there before, and now it is ${show(example.candidate)}`);
    else if (example.kind === 'vanished') out.push(`  - ${where}: was ${show(example.reference)}, and now it is not there at all`);
    else out.push(`  - ${where}: was ${show(example.reference)}, now ${show(example.candidate)}`);
  }
  const n = f.count ?? f.differences?.length ?? 0;
  if (n > 1) out.push(`  - the same thing in ${n} places`);
  if (f.why) out.push(`  - ${f.why}`);
  return out;
}

// ---------------------------------------------------------------------------
// Writing it down
// ---------------------------------------------------------------------------

/**
 * Append the report to the job summary, when the build server has one.
 *
 * Returns the file it wrote to, or null when there is nowhere to write. Null is a normal
 * answer on GitLab and CircleCI, neither of which has a summary page.
 *
 * @param {CIReport} report
 * @param {CIEnvironment} [env]
 * @returns {Promise<string|null>}
 */
export async function writeJobSummary(report, env) {
  const where = (env ?? detectCI()).summaryFile;
  if (!where) return null;
  try {
    await fsp.appendFile(where, `${report.markdown}\n`);
    return where;
  } catch {
    // A summary page is a nicety. Losing it must never cost the exit code, which is the
    // half that actually stops the merge.
    return null;
  }
}

/**
 * Everything worth keeping from this run, in one folder a workflow can upload.
 *
 * WHAT IS IN HERE, HONESTLY: the verdict, the reference decision, the summary, and the
 * store — which holds every observation both builds produced, as JSONL. That is the real
 * evidence and it is enough to work out what happened after the runner is gone.
 *
 * WHAT IS NOT IN HERE: pictures. The engine writes its evidence images into a scratch
 * folder and deletes that folder when the run ends, so by the time this is called they no
 * longer exist. Saying so is better than shipping an empty folder called evidence.
 *
 * @param {{cwd?: string, dir?: string, verdict: CheckOutcome, reference: CIReference, report: CIReport, env?: CIEnvironment}} what
 * @returns {Promise<string>}
 */
export async function saveEvidence(what) {
  const cwd = path.resolve(what.cwd ?? process.cwd());
  const dir = path.resolve(cwd, what.dir ?? path.join('.staysfixed', 'ci'));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'verdict.json'), `${JSON.stringify(what.verdict, null, 2)}\n`);
  await fsp.writeFile(path.join(dir, 'reference.json'), `${JSON.stringify(what.reference, null, 2)}\n`);
  await fsp.writeFile(path.join(dir, 'summary.md'), `${what.report.markdown}\n`);
  if (what.env) await fsp.writeFile(path.join(dir, 'where-it-ran.json'), `${JSON.stringify(what.env, null, 2)}\n`);
  await fsp.writeFile(
    path.join(dir, 'README.md'),
    [
      '# What is in here',
      '',
      '- `summary.md` — the same report that was written into the job summary.',
      '- `verdict.json` — everything the check concluded, including every gap in what it looked at.',
      '- `reference.json` — what it compared against, how that was chosen, and what would have made it stronger.',
      '- `where-it-ran.json` — the commit, the branch and the pull request this was.',
      '',
      'There are no pictures in here. The engine writes its evidence images into a scratch',
      'folder and clears that folder when the run ends, so nothing is left to collect by the',
      'time the job packs its results up. The observations in the store are the evidence.',
      '',
    ].join('\n'),
  );
  return dir;
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

/**
 * Work out the reference, run the check, write the report, hand back an exit code.
 *
 * This is what a workflow file calls, and it is one function on purpose: everything a
 * build server needs to do is here, in this order, with no way to accidentally leave the
 * exit code behind.
 *
 * `staysfixed ci` is not a command yet because the command table belongs to another file.
 * When it becomes one, it is this function and nothing else.
 *
 * @param {{cwd?: string, env?: Env, against?: string, paired?: boolean, journeys?: string, only?: string[], product?: string, evidenceDir?: string, quiet?: boolean, remember?: boolean}} [opts]
 * @returns {Promise<{exitCode: number, report: CIReport, reference: CIReference, verdict: CheckOutcome, evidence: string|null}>}
 */
export async function runCI(opts = {}) {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const env = opts.env ?? process.env;
  const where = detectCI(env);
  const reference = await referenceForCI({ cwd, env, against: opts.against, product: opts.product });

  const started = Date.now();
  /** @type {CheckOutcome} */
  const verdict = await check({
    cwd,
    product: opts.product,
    // Null means "use whatever the project's own reference points at", which for the
    // stored-record mode is exactly right and for every other mode never happens.
    against: reference.against ?? undefined,
    // A build server has a whole machine to itself and nothing else to do with it. Where the
    // old build can be booted, boot it: the expensive answer is the only one worth blocking
    // a merge on, and this is the one place where paying for it costs nobody any waiting.
    paired: opts.paired ?? reference.paired,
    journeys: opts.journeys,
    only: opts.only,
    // A pull request job must never write this product's record. Its observations were taken
    // on a machine nobody will see again, off a branch nobody has merged, and letting them
    // become "what the old build did" would move the standard sideways every time a runner
    // changed. So this is off unless a job asks for it in so many words.
    //
    // The one job that should ask is a job on your main branch whose purpose is to LEAVE a
    // record for later pull requests to compare against — see the caching section in
    // docs/running-it-in-ci.md. That is the only shape where remembering is right, and it is
    // a deliberate flag rather than a default because getting it the wrong way round turns
    // every red pull request into the new definition of working.
    remember: opts.remember === true,
  });

  const report = reportForCI(verdict, { reference, env: where, durationMs: Date.now() - started, remembered: opts.remember === true });

  /** @type {string|null} */
  let evidence = null;
  try {
    evidence = await saveEvidence({ cwd, dir: opts.evidenceDir, verdict, reference, report, env: where });
  } catch {
    // Losing the attachment must never change the answer.
  }
  await writeJobSummary(report, where);

  if (opts.quiet !== true) process.stdout.write(`${report.text}\n`);
  return { exitCode: report.exitCode, report, reference, verdict, evidence };
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
    const { stdout } = await exec('git', args, { cwd, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
    const out = stdout.trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/**
 * A name a person typed, turned into the commit it means — or null if this checkout has never
 * heard of it.
 * @param {string} cwd
 * @param {string} name
 * @returns {Promise<string|null>}
 */
async function resolveCommit(cwd, name) {
  return await git(cwd, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`]);
}

/**
 * The most recent tag in this history, and what it points at.
 * @param {string} cwd
 * @returns {Promise<{name: string, sha: string}|null>}
 */
async function lastTag(cwd) {
  // HEAD itself being tagged is the release-just-happened case, and comparing a build
  // against itself proves nothing, so step back one commit before asking.
  for (const from of ['HEAD^', 'HEAD']) {
    const name = await git(cwd, ['describe', '--tags', '--abbrev=0', from]);
    if (!name) continue;
    const sha = await resolveCommit(cwd, name);
    if (!sha) continue;
    const head = await resolveCommit(cwd, 'HEAD');
    if (sha === head) continue;
    return { name, sha };
  }
  return null;
}

/**
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function productName(cwd) {
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(cwd, 'package.json'), 'utf8'));
    return typeof pkg?.name === 'string' ? pkg.name : path.basename(cwd);
  } catch {
    return path.basename(cwd);
  }
}

/**
 * Build ids made from a commit look like `git-a1b2c3d4e5f6`. Getting the commit back out of
 * one is how a reference set on another machine still names something this checkout has.
 * @param {string} buildId
 * @returns {string|null}
 */
function shaFromBuildId(buildId) {
  const m = /^git-([0-9a-f]{7,40})$/.exec(buildId ?? '');
  return m ? m[1] : null;
}

/**
 * The file GitHub drops the whole event into. It is the only place the tip of the branch and
 * the base commit can be read from without asking the network.
 *
 * Read synchronously on purpose: `detectCI` is called from places that are not async, it
 * happens once, and it is a few kilobytes on a local disk.
 *
 * @param {string|undefined} file
 * @returns {Record<string, any>|null}
 */
function readEventFile(file) {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // No event file, an unreadable one, or one this server writes in some other shape. Every
    // caller below already copes with not knowing, so this is a shrug and not a failure.
    return null;
  }
}

/**
 * A commit that is all zeros means "there was nothing here before" — the first push to a new
 * branch. It is a real value in the environment and a useless one to compare against.
 * @param {string|null} sha
 * @returns {string|null}
 */
function usableSha(sha) {
  if (!sha) return null;
  return /^0+$/.test(sha) ? null : sha;
}

/**
 * @param {unknown} v
 * @returns {string|null}
 */
function text(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === '' ? null : s;
}

/**
 * @param {string|undefined} url
 * @returns {string|null}
 */
function lastSegment(url) {
  if (!url) return null;
  const parts = url.split('/').filter((p) => p !== '');
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

/** @param {string} sha */
function short(sha) {
  return sha.slice(0, 7);
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 */
function count(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Time as a plain total, never a clock range.
 * @param {number} ms
 * @returns {string}
 */
function minutes(ms) {
  const secs = Math.round(ms / 1000);
  if (secs < 90) return `about ${count(secs, 'second', 'seconds')}`;
  const mins = Math.round(secs / 60);
  return `about ${count(mins, 'minute', 'minutes')}`;
}

/**
 * @param {string} label
 * @param {string} value
 */
function row(label, value) {
  return `| ${label} | ${value.split('|').join('\\|')} |`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function show(value) {
  const t = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  // A real newline inside a markdown list item ends the item, so the rest of the value
  // silently falls out of the report. Writing them the way code writes them keeps a
  // difference like "ready" becoming "READY" on one readable line.
  const flat = t.split('\r\n').join('\\n').split('\n').join('\\n').split('\t').join('\\t');
  const trimmed = flat.length > 80 ? `${flat.slice(0, 77)}…` : flat;
  return `\`${trimmed.split('`').join("'")}\``;
}

/**
 * @param {import('./types.js').BuildFingerprint|undefined} build
 * @returns {string}
 */
function nameOfBuild(build) {
  if (!build) return 'the build with no name';
  if (build.version) return build.version;
  if (build.gitSha) return build.gitSha.slice(0, 7);
  return build.id || 'the build with no name';
}

/**
 * @param {string} s
 * @returns {string}
 */
function oneLine(s) {
  return s.split(/\s+/).join(' ').trim();
}

/**
 * The same report, with the markdown taken off, for a job log where markdown is just noise.
 * @param {string} markdown
 * @returns {string}
 */
function plainText(markdown) {
  return markdown
    .split('\n')
    .filter((line) => !/^\|\s*-+\s*\|/.test(line))
    .map((line) => {
      if (/^\|/.test(line)) {
        const cells = line.split('|').slice(1, -1).map((c) => c.trim());
        return cells.filter((c) => c !== '').join(': ');
      }
      return line
        .replace(/^#+\s*/, '')
        .replace(/^>\s?/, '')
        .split('**').join('')
        .split('`').join('')
        .replace(/^_(.*)_$/, '$1');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------------------
// Running this file directly
// ---------------------------------------------------------------------------

/**
 * `node src/v2/ci.js` runs the whole thing and exits with the code that stops the merge.
 *
 * It is here rather than in the command table because that table lives in another file. A
 * workflow can call this path directly today and switch to `staysfixed ci` the day it exists,
 * with no change to what happens.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split('=');
    if (inline !== undefined) flags[name] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[name] = argv[(i += 1)];
    else flags[name] = true;
  }
  try {
    const result = await runCI({
      cwd: typeof flags.cwd === 'string' ? flags.cwd : undefined,
      against: typeof flags.against === 'string' ? flags.against : undefined,
      journeys: typeof flags.journeys === 'string' ? flags.journeys : undefined,
      product: typeof flags.product === 'string' ? flags.product : undefined,
      evidenceDir: typeof flags.evidence === 'string' ? flags.evidence : undefined,
      paired: flags.paired === true ? true : undefined,
      remember: flags.remember === true,
    });
    return result.exitCode;
  } catch (e) {
    // Anything that reaches here never ran a check, so it is exit 2. Never 1, which a reader
    // would take to mean the product changed, and never 0.
    process.stderr.write(`Stays Fixed could not run on this build server. ${messageOf(e)}\n`);
    return EXIT.error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
