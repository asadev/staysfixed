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
 * @property {string} [leftBehind] Set when the scratch checkout could not be removed. It says
 *                                 exactly what is still on disk and how to get rid of it,
 *                                 because a cleanup that fails in silence leaves a stale
 *                                 entry in the real repository's worktree list and the next
 *                                 `git status` there is frightening for no reason.
 */

// EVERY difference in the finding is re-checked, and there is deliberately no ceiling.
//
// Until 2026-08-30 this checked the first five and then said "caused by that change" about
// the whole finding. A cluster of three hundred addresses where the first five went away and
// the other two hundred and ninety-five did not came back PROVED — the agent then had a
// machine-checked reason to wave the whole thing through, and the rest of the break went with
// it. That is this tool's worst failure shape: a confident sentence covering a silence.
//
// The comment that used to sit here said walking them all buys nothing. It buys the claim.
// And it costs nothing to buy: the journeys were re-walked already, the observations are in
// the map below, and each extra difference is one lookup in it.

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
  // "git could not hand over the diff" and "there is no diff" both left `hunks` empty, and
  // the sentence below was said about both. Telling somebody their tree is clean when it is
  // not is worse than telling them nothing, because they act on it.
  if (changed.patchUnread === true && changed.hunks.length === 0) {
    return cannot(
      `${changed.patchUnreadWhy ?? 'The working diff could not be read.'} That is not the same as nothing having changed — ${changed.files.length} tracked ${changed.files.length === 1 ? 'file has' : 'files have'} edits in ${changed.files.length === 1 ? 'it' : 'them'} — so no change could be undone and nothing here is proved either way.`,
      null,
    );
  }
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
  // The answer is held rather than only returned, so the tidy-up below can write on it. A
  // cleanup that fails after the verdict is decided must still reach whoever reads the
  // verdict; `gitQuiet` hands back whether it worked and nothing used to look.
  /** @type {{proof: CauseProof|null}} */
  const held = { proof: null };
  /**
   * @param {CauseProof} p
   * @returns {CauseProof}
   */
  const done = (p) => {
    held.proof = p;
    return p;
  };
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
    /** @type {string[]} */
    const notCarried = [];
    for (const file of changed.untracked) {
      if (file === hunk.file) continue;
      const copied = await copyInto(changed.root, tree, file);
      if (!copied.ok) notCarried.push(`${file} (${copied.why})`);
    }
    // A new file that did not make it into the scratch checkout is a file the re-walk runs
    // WITHOUT. The difference then disappears because the file is missing, not because the
    // suspect change caused it — and the proof comes back "caused by that change", stamped,
    // machine-checked and wrong. That is a verdict built on a silence, so there is no verdict.
    if (notCarried.length > 0) {
      return done(cannot(
        `${notCarried.length} new ${notCarried.length === 1 ? 'file' : 'files'} could not be copied into the scratch checkout: ${notCarried.join('; ')}. Anything that went away in a copy missing those files would have gone away for the wrong reason, so nothing is claimed here.`,
        hunk,
      ));
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
        return done(cannot(
          `That change could not be undone on its own: ${undone.why}. It probably overlaps another change in the same place.`,
          hunk,
        ));
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

    const differences = finding.differences;
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
            : disappeared > 0
              ? `Undoing that change in ${hunk.file} took away ${disappeared} of the ${differences.length} addresses in this finding and left ${differences.length - disappeared} exactly as ${differences.length - disappeared === 1 ? 'it was' : 'they were'}. So that change explains part of this and not the rest, and the rest has another cause nothing has looked for yet. It is not covered by undoing that one change.`
              : `This is still here with that change undone, so ${hunk.file} is not what caused it. Something else did, and nothing knows what yet.`,
      hunk: { file: hunk.file, header: hunk.header },
      checked: differences.length,
      disappeared,
    };
    if (opts.keep === true) result.worktree = tree;
    if (events) events.emit({ type: 'proof:done', at: events.elapsed(), message: result.what });
    return done(result);
  } catch (e) {
    return done(cannot(messageOf(e), hunk));
  } finally {
    // Even when it throws. A leftover worktree makes the next `git status`
    // confusing and the one after that frightening — and until 2026-08-30, if the removal
    // itself failed, it failed in complete silence and left one behind anyway.
    const mess = await tidyUp({ tree, base, root: changed.root, checkedOut, keep: opts.keep === true });
    if (mess) {
      if (held.proof) held.proof.leftBehind = mess;
      if (opts.events) opts.events.emit({ type: 'note', at: opts.events.elapsed(), message: mess });
    }
  }
}

/**
 * Put the scratch checkout away, and say so plainly when it will not go.
 *
 * `git worktree remove` fails for ordinary reasons — a file still open, a folder the run
 * itself is sitting in, a permission. When it does, the folder is deleted directly and the
 * registration is pruned, which is the same outcome by another road. If even that does not
 * work, the one thing left worth doing is saying exactly what is on disk and the one command
 * that clears it, rather than leaving the person to find it themselves in a month.
 *
 * @param {{tree: string, base: string, root: string, checkedOut: boolean, keep: boolean}} where
 * @returns {Promise<string>} empty when everything was cleared away
 */
async function tidyUp(where) {
  if (where.keep) return '';
  /** @type {string[]} */
  const problems = [];

  if (where.checkedOut) {
    const removed = await gitQuiet(['worktree', 'remove', '--force', where.tree], where.root);
    if (!removed.ok && (await stillThere(where.tree))) {
      if (!(await wipe(where.tree))) problems.push(`the scratch checkout is still at ${where.tree} (${removed.why})`);
    }
  }
  const pruned = await gitQuiet(['worktree', 'prune'], where.root);
  if (!pruned.ok) {
    problems.push(`the stale worktree entry could not be pruned from ${where.root} (${pruned.why}), so \`git worktree list\` there may still name a folder that is gone`);
  }
  if (!(await wipe(where.base)) && (await stillThere(where.base))) {
    problems.push(`the temporary folder ${where.base} could not be deleted`);
  }

  if (problems.length === 0) return '';
  return (
    `Proving the cause left something behind: ${problems.join('; ')}. ` +
    `Nothing of yours was touched — all of it is inside a temporary folder — but it will not clear itself. ` +
    `To remove it: git -C ${where.root} worktree prune && rm -rf ${where.base}`
  );
}

/**
 * @param {string} dir
 * @returns {Promise<boolean>} true when it was removed or was never there
 */
async function wipe(dir) {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function stillThere(dir) {
  try {
    await fsp.stat(dir);
    return true;
  } catch {
    return false;
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
 *
 * A file that vanished between git listing it and this copying it really is nothing to fail
 * a proof over — it is not in the working tree any more either, so the scratch checkout is
 * right to be without it. Every OTHER failure is different in kind: the file IS there, the
 * scratch copy does not have it, and the re-walk is therefore running a different product.
 * Those two used to be the same empty catch.
 *
 * @param {string} from
 * @param {string} to
 * @param {string} file  repo-relative
 * @returns {Promise<{ok: boolean, why: string}>}
 */
async function copyInto(from, to, file) {
  const source = path.resolve(from, file);
  const target = path.resolve(to, file);
  // A path that climbs out of the scratch tree is never copied.
  if (!target.startsWith(path.resolve(to) + path.sep)) {
    return { ok: false, why: 'its path points outside the scratch checkout' };
  }
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(source, target);
    return { ok: true, why: '' };
  } catch (e) {
    const code = /** @type {{code?: string}} */ (e).code;
    if (code === 'ENOENT' && !(await exists(source))) return { ok: true, why: '' };
    if (code === 'EISDIR') {
      // git only lists a bare directory when it is asked for untracked directories rather
      // than untracked files, which is not how this asks — but if it ever happens, a folder
      // silently not copied is a whole subtree the re-walk does not have.
      return { ok: false, why: 'it is a folder, not a file' };
    }
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function exists(file) {
  try {
    await fsp.stat(file);
    return true;
  } catch {
    return false;
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
