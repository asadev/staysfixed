/**
 * Proof instead of a story.
 *
 * Ranking can say a difference is far from the edit. Ranking cannot say the edit
 * caused it — that is a guess dressed as a number, and an agent under pressure
 * to finish will believe whichever guess lets it stop. So this file does the one
 * thing that settles it: it takes the change you think is to blame, undoes just
 * that change in a scratch copy of the repository, walks the journey again, and
 * looks. If the difference goes away, the change caused it. If the difference is
 * still there, the assumption was wrong and the finding gets louder rather than
 * quieter.
 *
 * It is cheap — one hunk, one journey — and it is a fact rather than a story.
 *
 * Two rules hold this file up. It NEVER touches the real working tree: every
 * file it writes lives in a temporary folder, and the checkout is a `git
 * worktree` removed again even when something throws halfway. And it undoes the
 * change by reverse-applying the hunk on top of the full working diff, rather
 * than by building a patch with the hunk left out, because the line numbers are
 * exactly right that way round and only approximately right the other.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { StaysFixedError, messageOf } from '../core/errors.js';
import { indexByPath, sameValue } from './observation.js';
import { journeysOf } from './cluster.js';
import { whatChanged } from './rank.js';

/** @typedef {import('./types.js').Finding} Finding */
/** @typedef {import('./types.js').Difference} Difference */
/** @typedef {import('./types.js').Journey} Journey */
/** @typedef {import('./types.js').Capture} Capture */
/** @typedef {import('./types.js').Observation} Observation */
/** @typedef {import('./types.js').BuildFingerprint} BuildFingerprint */
/** @typedef {import('./rank.js').ChangedHunk} ChangedHunk */
/** @typedef {import('./rank.js').Changed} Changed */
/** @typedef {import('./run.js').Walker} Walker */
/** @typedef {import('./run.js').CheckEvents} CheckEvents */

const run = promisify(execFile);

/**
 * What came of the attempt.
 *
 * @typedef {object} CauseProof
 * @property {'caused by that change'|'not caused by that change'|'could not test'} verdict
 * @property {boolean} escalates   True when the difference outlived the revert. The agent's
 *                                 assumption was wrong and somebody has to look.
 * @property {string} what         One plain sentence, for whoever reads the summary.
 * @property {{file: string, header: string}|null} hunk
 * @property {number} checked      How many of the finding's differences were re-checked.
 * @property {number} disappeared  How many of them went away.
 * @property {string} [why]        Why it could not be tested, when it could not.
 * @property {ChangedHunk[]} [candidates]  Hunks it could have tested, when it could not choose.
 * @property {string} [worktree]   Where it ran, when `keep` was asked for.
 */

/**
 * How many of a finding's differences are worth re-checking. A finding can stand
 * for two hundred addresses; if the first handful come back the same way, the
 * two hundredth will too, and walking them all buys nothing.
 */
const CHECK_AT_MOST = 5;

/**
 * Prove, or disprove, that one change caused one finding.
 *
 * @param {Finding} finding
 * @param {{
 *   cwd: string,
 *   walk: Walker,
 *   journeys: Journey[],
 *   candidate: BuildFingerprint,
 *   hunk?: ChangedHunk,
 *   changed?: Changed,
 *   normalise?: (capture: Capture) => Capture,
 *   events?: CheckEvents,
 *   signal?: AbortSignal,
 *   keep?: boolean,
 * }} opts
 * @returns {Promise<CauseProof>}
 */
export async function proveCause(finding, opts) {
  if (!opts || typeof opts.walk !== 'function') {
    throw new StaysFixedError('There is nothing to walk the journey with.', {
      hint: 'Pass the same walk function the check ran with. The shape is Walker in src/v2/run.js.',
    });
  }

  const changed = opts.changed ?? (await whatChanged(opts.cwd));
  if (!changed.ok) return cannot(changed.why ?? 'The working tree could not be read.', null);
  if (changed.hunks.length === 0 && changed.untracked.length === 0) {
    return cannot('Nothing in the working tree has changed, so there is no change to undo.', null);
  }

  /** @type {{hunk: ChangedHunk|null, candidates: ChangedHunk[]}} */
  const chosen = opts.hunk ? { hunk: opts.hunk, candidates: [] } : pickSuspect(finding, changed);
  if (!chosen.hunk) {
    return {
      ...cannot(
        chosen.candidates.length === 0
          ? 'None of your changes look related to this finding, so there is nothing obvious to undo. Name the change you suspect and it will be tested.'
          : 'More than one of your changes could have caused this. Name the one you suspect and it will be tested.',
        null,
      ),
      candidates: chosen.candidates,
    };
  }
  const hunk = chosen.hunk;

  const names = journeysOf(finding);
  const journeys = opts.journeys.filter((j) => names.includes(j.name));
  if (journeys.length === 0) {
    return cannot('None of the journeys this finding came from are available to walk again.', hunk);
  }

  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-cause-'));
  const tree = path.join(base, 'tree');
  // Belt and braces. Everything below writes files and reverts changes, and the
  // one thing that must never happen is any of it landing in the real project.
  if (!path.resolve(tree).startsWith(path.resolve(os.tmpdir()))) {
    throw new StaysFixedError('Refusing to run the proof outside a temporary folder.');
  }

  let checkedOut = false;
  try {
    await gitOrThrow(['worktree', 'add', '--detach', tree, 'HEAD'], changed.root);
    checkedOut = true;

    // Everything you changed, applied to a clean copy of the last commit.
    if (changed.patch.trim().length > 0) {
      const workingPatch = path.join(base, 'working.patch');
      await fsp.writeFile(workingPatch, endWithNewline(changed.patch), 'utf8');
      await gitOrThrow(['apply', '--whitespace=nowarn', workingPatch], tree);
    }

    // New files git has never seen are not in the diff, so they are carried over
    // by hand — all of them except the suspect, which is left out, because
    // leaving a file out IS undoing the change that added it.
    const suspectIsNew = changed.untracked.includes(hunk.file);
    for (const file of changed.untracked) {
      if (file === hunk.file) continue;
      await copyInto(changed.root, tree, file);
    }

    // And now undo the one change under suspicion.
    if (!suspectIsNew) {
      const suspectPatch = path.join(base, 'suspect.patch');
      await fsp.writeFile(suspectPatch, endWithNewline(hunk.patch), 'utf8');
      // Straight first. `--recount` is the fallback for a hunk whose header
      // counts are off — it fixes those and breaks a hunk whose counts were
      // right, so it is never the first thing tried.
      let undone = await gitQuiet(['apply', '--reverse', '--whitespace=nowarn', suspectPatch], tree);
      if (!undone.ok) {
        undone = await gitQuiet(['apply', '--reverse', '--recount', '--whitespace=nowarn', suspectPatch], tree);
      }
      if (!undone.ok) {
        return cannot(
          `That change could not be undone on its own: ${undone.why}. It probably overlaps another change in the same place.`,
          hunk,
        );
      }
    }

    const events = opts.events;
    if (events) {
      events.emit({
        type: 'proof:start',
        at: events.elapsed(),
        message: `Undoing one change in ${hunk.file} in a scratch copy and walking ${names.join(', ')} again, to see whether it was the cause.`,
      });
    }

    /** @type {Map<string, Map<string, Observation>>} */
    const without = new Map();
    for (const journey of journeys) {
      const capture = await opts.walk({
        journey,
        build: opts.candidate,
        run: 'single',
        which: 'candidate',
        dir: tree,
        events,
        signal: opts.signal,
      });
      const settled = opts.normalise ? opts.normalise(capture) : capture;
      without.set(journey.name, indexByPath(settled.observations));
    }

    const differences = finding.differences.slice(0, CHECK_AT_MOST);
    let disappeared = 0;
    for (const d of differences) if (gone(d, without)) disappeared += 1;

    const proved = differences.length > 0 && disappeared === differences.length;
    /** @type {CauseProof} */
    const result = {
      verdict:
        differences.length === 0 ? 'could not test' : proved ? 'caused by that change' : 'not caused by that change',
      escalates: differences.length > 0 && !proved,
      what:
        differences.length === 0
          ? 'This finding carries no differences, so there was nothing to re-check.'
          : proved
            ? `Undoing that one change in ${hunk.file} made this go away. It is yours, and it is explained.`
            : `This is still here with that change undone, so ${hunk.file} is not what caused it. Something else did, and nothing knows what yet.`,
      hunk: { file: hunk.file, header: hunk.header },
      checked: differences.length,
      disappeared,
    };
    if (opts.keep === true) result.worktree = tree;
    if (events) events.emit({ type: 'proof:done', at: events.elapsed(), message: result.what });
    return result;
  } catch (e) {
    return cannot(messageOf(e), hunk);
  } finally {
    // Even when it throws. A leftover worktree makes the next `git status`
    // confusing and the one after that frightening.
    if (checkedOut && opts.keep !== true) await gitQuiet(['worktree', 'remove', '--force', tree], changed.root);
    await gitQuiet(['worktree', 'prune'], changed.root);
    if (opts.keep !== true) await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Is this particular difference gone now?
 *
 * @param {Difference} d
 * @param {Map<string, Map<string, Observation>>} without  Journey name, then what it did with the change undone.
 * @returns {boolean}
 */
export function gone(d, without) {
  const here = without.get(d.journey ?? '');
  // The journey did not run. Never call that a pass.
  if (!here) return false;
  const seen = here.get(d.path);

  switch (d.kind) {
    case 'appeared':
      // It was not there before the change. It is gone if it is not there now.
      return seen === undefined;
    case 'vanished':
    case 'changed':
      return seen !== undefined && sameValue(seen.value, d.reference);
    default:
      return false;
  }
}

/**
 * Which of your changes is the obvious suspect for this finding.
 *
 * It only answers when the answer is unambiguous. Guessing between three hunks
 * and testing the wrong one produces a confident "not caused by that change",
 * which is worse than no answer at all — so when it cannot tell, it says so and
 * hands back the shortlist.
 *
 * @param {Finding} finding
 * @param {Changed} changed
 * @returns {{hunk: ChangedHunk|null, candidates: ChangedHunk[]}}
 */
export function pickSuspect(finding, changed) {
  const files = finding.nearFiles ?? [];
  if (files.length > 0) {
    const near = changed.hunks.filter((h) => files.some((f) => sameFile(f, h.file)));
    if (near.length === 1) return { hunk: near[0], candidates: near };
    if (near.length > 1) return { hunk: null, candidates: near };
  }

  // Nothing says where the finding lives. One change in the whole tree is still
  // an unambiguous answer; more than one is not.
  if (changed.hunks.length === 1) return { hunk: changed.hunks[0], candidates: changed.hunks };
  return { hunk: null, candidates: changed.hunks };
}

/**
 * Two paths naming the same file, one of them possibly absolute.
 * @param {string} a
 * @param {string} b
 */
function sameFile(a, b) {
  if (a === b) return true;
  const left = a.replace(/\\/g, '/');
  const right = b.replace(/\\/g, '/');
  return left.endsWith('/' + right) || right.endsWith('/' + left);
}

/**
 * @param {string} why
 * @param {ChangedHunk|null} hunk
 * @returns {CauseProof}
 */
function cannot(why, hunk) {
  return {
    verdict: 'could not test',
    // Not proven either way is not the same as proven innocent, and it must
    // never be reported as if it were.
    escalates: false,
    what: `This could not be tested by undoing a change. ${why}`,
    hunk: hunk ? { file: hunk.file, header: hunk.header } : null,
    checked: 0,
    disappeared: 0,
    why,
  };
}

/**
 * Copy one file from the real project into the scratch checkout, folders and all.
 * @param {string} from
 * @param {string} to
 * @param {string} file  repo-relative
 */
async function copyInto(from, to, file) {
  const source = path.resolve(from, file);
  const target = path.resolve(to, file);
  // A path that climbs out of the scratch tree is never copied.
  if (!target.startsWith(path.resolve(to))) return;
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(source, target);
  } catch {
    // A file that vanished between listing it and copying it is not worth
    // failing a proof over.
  }
}

/** @param {string} text */
function endWithNewline(text) {
  return text.endsWith('\n') ? text : text + '\n';
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string>}
 */
async function gitOrThrow(args, cwd) {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const said = /** @type {{stderr?: string}} */ (e).stderr;
    throw new StaysFixedError(`git ${args[0]} failed. ${String(said ?? messageOf(e)).trim()}`);
  }
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ok: boolean, why: string}>}
 */
async function gitQuiet(args, cwd) {
  try {
    await run('git', args, { cwd, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, why: '' };
  } catch (e) {
    const said = /** @type {{stderr?: string}} */ (e).stderr;
    return { ok: false, why: String(said ?? messageOf(e)).trim() };
  }
}
