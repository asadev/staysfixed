/**
 * "Which change broke this?"
 *
 * Markers hold a fingerprint of every screen at moments a human trusted. So when
 * a screen looks wrong today, we can walk backwards through the markers to find
 * the newest one where it still looked the way it does now, and the very next one
 * where it did not. The commits between those two are the suspects — usually a
 * handful, instead of a week of work.
 *
 * The honest answer is often "I cannot tell", and this file says so out loud
 * rather than guessing. A trace that points at the wrong commit costs more time
 * than no trace at all.
 */

import { listMarkers } from './mark.js';
import { approvedHashes } from '../picture/store.js';
import { commitsBetween, filesBetween, commitExists } from '../core/git.js';

/** More than this many commits is a wall of text, not an answer. */
const COMMIT_CAP = 40;

/**
 * @param {import('../types.js').Project} project
 * @param {{names?: string[], current?: Record<string,string>}} [opts]
 *   `current` defaults to the fingerprints of today's approved pictures. When
 *   tracing a live failure the CLI passes the fingerprints of the pictures the
 *   failing run actually took, so the trace follows the broken thing, not the
 *   thing that was approved.
 * @returns {Promise<import('../types.js').TraceReport>}
 */
export async function traceScreens(project, opts = {}) {
  const markers = await listMarkers(project);
  const current = opts.current ?? (await approvedHashes(project.paths));
  const names =
    opts.names && opts.names.length > 0 ? [...opts.names] : Object.keys(current).sort();

  /** @type {import('../types.js').TraceFinding[]} */
  const findings = [];
  for (const name of names) {
    findings.push(await traceOne(project, markers, name, current[name]));
  }

  /** @type {import('../types.js').TraceReport} */
  const report = { findings, markersSearched: markers.length };
  if (markers.length === 0) {
    report.message =
      'There are no known-good markers in this project yet, so there is no history to search. Mark a release you trust with `staysfixed mark v1.2.3` and the next trace will have something to work with.';
  } else if (names.length === 0) {
    report.message = 'There are no approved pictures to trace.';
  }
  return report;
}

/**
 * @param {import('../types.js').Project} project
 * @param {import('../types.js').Marker[]} markers  newest first
 * @param {string} name
 * @param {string|undefined} now  fingerprint of how the screen looks right now
 * @returns {Promise<import('../types.js').TraceFinding>}
 */
async function traceOne(project, markers, name, now) {
  const who = readable(name);

  if (now === undefined) {
    return {
      name,
      verdict: 'unknown',
      message: `There is no picture of ${who} to compare against — nothing has been approved for it yet.`,
    };
  }
  if (markers.length === 0) {
    return {
      name,
      verdict: 'unknown',
      message: `There are no known-good markers yet, so there is nothing to compare ${who} against.`,
    };
  }

  const lastGoodIndex = markers.findIndex((m) => m.pictures?.[name] === now);
  if (lastGoodIndex === -1) {
    const oldest = markers[markers.length - 1];
    return {
      name,
      verdict: 'unknown',
      message: `None of the ${markers.length} markers show ${who} looking the way it does now. Either it is brand new, or it changed before the oldest marker (${oldest.label}).`,
    };
  }

  const lastGood = markers[lastGoodIndex];
  if (lastGoodIndex === 0) {
    return {
      name,
      verdict: 'unchanged',
      lastGood,
      message: `${capitalise(who)} looks exactly as it did at ${lastGood.label}, the newest marker.`,
    };
  }

  // The boundary is the first marker written AFTER lastGood that actually
  // recorded this screen and recorded it differently. Markers that never saw
  // this screen are skipped rather than blamed.
  let firstBad;
  for (let j = lastGoodIndex - 1; j >= 0; j--) {
    const seen = markers[j].pictures?.[name];
    if (seen !== undefined && seen !== now) {
      firstBad = markers[j];
      break;
    }
  }
  if (!firstBad) {
    return {
      name,
      verdict: 'unknown',
      lastGood,
      message: `${capitalise(who)} last matched at ${lastGood.label}, and no marker written after that one recorded this screen at all.`,
    };
  }

  const from = lastGood.git?.sha;
  const to = firstBad.git?.sha;
  if (!from || !to) {
    const which = !from ? lastGood.label : firstBad.label;
    return {
      name,
      verdict: 'unknown',
      lastGood,
      firstBad,
      message: `${capitalise(who)} changed between ${lastGood.label} and ${firstBad.label}, but ${which} was not marked inside a git repository, so there is no list of commits to show.`,
    };
  }

  const root = project.paths.root;
  const missing = [];
  if (!(await commitExists(root, from))) missing.push(`${lastGood.label} (${short(from)})`);
  if (!(await commitExists(root, to))) missing.push(`${firstBad.label} (${short(to)})`);
  if (missing.length > 0) {
    return {
      name,
      verdict: 'unknown',
      lastGood,
      firstBad,
      message: `${capitalise(who)} changed between ${lastGood.label} and ${firstBad.label}, but git here cannot find ${missing.join(' or ')}. That usually means the branch was rebuilt or this is a shallow clone.`,
    };
  }

  const allCommits = await commitsBetween(root, from, to);
  const files = await filesBetween(root, from, to);
  const commits = allCommits.slice(0, COMMIT_CAP);

  let message = `${capitalise(who)} looked right at ${lastGood.label} and wrong by ${firstBad.label}. ${countOf(allCommits.length, 'commit')} landed in between`;
  message += files.length > 0 ? `, touching ${countOf(files.length, 'file')}.` : '.';
  if (allCommits.length > commits.length) {
    // A silent cap reads as "that's all of them", which would send someone
    // looking in the wrong half of the range.
    message += ` Only the newest ${COMMIT_CAP} commits are listed here.`;
  }

  return { name, verdict: 'changed', lastGood, firstBad, commits, files, message };
}

/**
 * One plain sentence about a single finding.
 *
 * @param {import('../types.js').TraceFinding} finding
 * @returns {string}
 */
export function summariseTrace(finding) {
  const who = readable(finding.name);

  if (finding.verdict === 'unchanged') {
    return finding.lastGood
      ? `${who} still looks the way it did at ${finding.lastGood.label}.`
      : `${who} has not changed.`;
  }

  if (finding.verdict === 'changed' && finding.lastGood && finding.firstBad) {
    const commits = finding.commits ?? [];
    let line = `${who} looked right at ${finding.lastGood.label} and wrong by ${finding.firstBad.label} — ${countOf(commits.length, 'commit')} in between`;
    const hot = busiestFolder(finding.files ?? []);
    if (hot) {
      line += hot.all
        ? `, and all ${hot.count} changed files are under ${hot.dir}.`
        : `, and ${hot.count} of the changed files are under ${hot.dir}.`;
    } else {
      line += '.';
    }
    return line;
  }

  return finding.message ?? `There is not enough history to say when ${who} changed.`;
}

/**
 * The folder the changed files sit in — the quickest hint about where to look
 * first. Counting is inclusive of sub-folders, so the sentence it feeds is
 * literally true: saying "5 of the files are under src" while nine of them are
 * would send someone looking in the wrong place.
 *
 * @param {string[]} files
 * @returns {{dir: string, count: number, all: boolean}|null}
 */
function busiestFolder(files) {
  if (files.length < 2) return null;

  const shared = sharedFolder(files);
  if (shared) return { dir: shared, count: files.length, all: true };

  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const file of files) {
    const parts = file.split('/');
    for (let depth = 1; depth <= Math.min(2, parts.length - 1); depth++) {
      const dir = parts.slice(0, depth).join('/');
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }

  /** @type {{dir: string, count: number, all: boolean}|null} */
  let best = null;
  for (const [dir, count] of counts) {
    // A deeper folder wins a tie: 'src/renderer' is an answer, 'src' is a shrug.
    const better = !best || count > best.count || (count === best.count && dir.length > best.dir.length);
    if (better) best = { dir, count, all: false };
  }
  return best && best.count >= 2 ? best : null;
}

/**
 * The deepest folder that contains every one of these files, or null when they
 * are scattered across the repository.
 * @param {string[]} files
 * @returns {string|null}
 */
function sharedFolder(files) {
  /** @type {string[]|null} */
  let common = null;
  for (const file of files) {
    const parts = file.split('/').slice(0, -1);
    if (common === null) {
      common = parts;
      continue;
    }
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
    if (common.length === 0) return null;
  }
  return common && common.length > 0 ? common.join('/') : null;
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 * @returns {string}
 */
function countOf(n, one, many) {
  if (n === 0) return `no ${many ?? one + 's'}`;
  return `${n} ${n === 1 ? one : many ?? one + 's'}`;
}

/**
 * 'sessions-list' -> 'the sessions list'. Screen names are file-safe ids; people
 * are not, so nothing a person reads should be an id.
 * @param {string} name
 * @returns {string}
 */
function readable(name) {
  const words = String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!words) return 'this screen';
  return /^(the|a|an) /.test(words) ? words : `the ${words}`;
}

/**
 * @param {string} s
 * @returns {string}
 */
function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * @param {string} sha
 * @returns {string}
 */
function short(sha) {
  return sha.slice(0, 7);
}
