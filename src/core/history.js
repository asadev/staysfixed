/**
 * The flake register.
 *
 * Asad's rule, and it is the right one: a check that flakes twice gets fixed or
 * deleted, never tolerated. So the tool has to remember. Every run appends a
 * status per check; when a check changes its mind while the code stood still,
 * that is a flake. Past the limit the check is condemned and `check` says so in
 * red until a human deals with it.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

const KEEP_RECENT = 12;

/**
 * @param {string} file
 * @returns {Promise<import('../types.js').History>}
 */
export async function loadHistory(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} file
 * @param {import('../types.js').History} history
 */
export async function saveHistory(file, history) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(history, null, 2) + '\n');
}

/**
 * Fold one run into the register.
 *
 * A flake is: this check passed and then failed (or the reverse) while the git
 * sha and the working-tree state did not change. That is the only honest
 * definition — anything else blames the developer for their own edits.
 *
 * @param {import('../types.js').History} history
 * @param {{name: string, kind: 'picture'|'guard', status: import('../types.js').CheckStatus, retriedToPass?: boolean}[]} results
 * @param {import('../types.js').GitInfo} git
 * @param {string} at ISO timestamp
 * @param {number} flakeLimit
 * @returns {{history: import('../types.js').History, newlyCondemned: string[], flakedNow: string[]}}
 */
export function foldRun(history, results, git, at, flakeLimit) {
  const next = /** @type {import('../types.js').History} */ (structuredClone(history));
  const newlyCondemned = [];
  const flakedNow = [];
  // What "the code did not change" means.
  //
  // Only a clean tree at a known commit proves it. Without git there is no way to tell a
  // wobble from an edit, and guessing costs more than it gives: treating consecutive runs
  // in a repo-less folder as "the same state" made a deliberately broken stylesheet, and
  // then its repair, register as two flakes on every screen in the project — the register
  // shouting about eleven perfectly good checks. A false accusation of flakiness is
  // exactly as corrosive as a false failure.
  //
  // So a run with no git evidence still records its status, and still catches the
  // unambiguous signal (a check that needed a retry to pass INSIDE one run). It just does
  // not compare across runs. `staysfixed flake` says so out loud rather than looking
  // clean — see `blindWithoutGit`.
  const stamp = git.dirty ? null : git.sha;

  for (const r of results) {
    const key = `${r.kind}:${r.name}`;
    const entry = next[key] ?? {
      name: r.name,
      kind: r.kind,
      runs: 0,
      flakes: 0,
      recent: [],
    };

    const previous = entry.recent.length ? entry.recent[entry.recent.length - 1] : null;
    const previousSha = /** @type {any} */ (entry).lastSha ?? null;

    // Two ways to catch a wobble:
    //  1. it needed a retry to pass inside this very run — unambiguous;
    //  2. it flipped between runs at the same commit, clean tree both times.
    const flippedAtSameCommit =
      previous !== null &&
      previous !== r.status &&
      stamp !== null &&
      previousSha === stamp &&
      isDecided(previous) &&
      isDecided(r.status);

    if (r.retriedToPass || flippedAtSameCommit) {
      entry.flakes += 1;
      entry.lastFlakeAt = at;
      entry.lastFlakeGitSha = git.sha ?? undefined;
      flakedNow.push(r.name);
      if (entry.flakes >= flakeLimit && !entry.condemned) {
        entry.condemned = true;
        newlyCondemned.push(r.name);
      }
    }

    entry.runs += 1;
    entry.recent = [...entry.recent, r.status].slice(-KEEP_RECENT);
    /** @type {any} */ (entry).lastSha = stamp;
    next[key] = entry;
  }

  return { history: next, newlyCondemned, flakedNow };
}

/**
 * A status that means the check actually reached a verdict.
 * @param {import('../types.js').CheckStatus} s
 */
function isDecided(s) {
  return s === 'passed' || s === 'changed' || s === 'failed';
}

/**
 * @param {import('../types.js').History} history
 * @returns {import('../types.js').HistoryEntry[]}
 */
export function condemned(history) {
  return Object.values(history).filter((e) => e.condemned);
}

/**
 * @param {import('../types.js').History} history
 * @returns {import('../types.js').HistoryEntry[]}
 */
export function wobbly(history) {
  return Object.values(history)
    .filter((e) => e.flakes > 0)
    .sort((a, b) => b.flakes - a.flakes);
}

/**
 * Forgive a check — used by `staysfixed flake --clear <name>` once it has been fixed.
 * @param {import('../types.js').History} history
 * @param {string} name
 * @returns {import('../types.js').History}
 */
export function clearFlakes(history, name) {
  const next = /** @type {import('../types.js').History} */ (structuredClone(history));
  for (const [key, entry] of Object.entries(next)) {
    if (entry.name === name || key === name) {
      entry.flakes = 0;
      entry.condemned = false;
      delete entry.lastFlakeAt;
      delete entry.lastFlakeGitSha;
    }
  }
  return next;
}

/**
 * Whether the register can only see wobbles inside a single run.
 *
 * True when there is no commit to pin a status to — no git, or a dirty tree. The `flake`
 * command prints this, because a register that looks empty for the wrong reason is worse
 * than one that admits what it cannot see.
 *
 * @param {import('../types.js').GitInfo} git
 * @returns {boolean}
 */
export function blindWithoutGit(git) {
  return git.sha === null || git.dirty;
}
