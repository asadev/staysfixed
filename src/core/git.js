/**
 * Just enough git to answer "which commit was this true at?".
 *
 * Every call is read-only and every call is allowed to fail — Stays Fixed works
 * in a folder that is not a git repository, it just cannot trace history there.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function git(args, cwd) {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * @param {string} cwd
 * @returns {Promise<import('../types.js').GitInfo>}
 */
export async function gitInfo(cwd) {
  const sha = await git(['rev-parse', 'HEAD'], cwd);
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const status = await git(['status', '--porcelain'], cwd);
  const name = await git(['config', 'user.name'], cwd);
  const email = await git(['config', 'user.email'], cwd);
  return {
    sha,
    shortSha: sha ? sha.slice(0, 7) : null,
    branch: branch === 'HEAD' ? null : branch,
    dirty: status !== null && status.length > 0,
    user: name ? (email ? `${name} <${email}>` : name) : null,
  };
}

/**
 * Commits between two points, newest first. The heart of `staysfixed trace`.
 * @param {string} cwd
 * @param {string} from  older sha
 * @param {string} to    newer sha
 * @returns {Promise<{sha: string, shortSha: string, subject: string, author: string, date: string}[]>}
 */
export async function commitsBetween(cwd, from, to) {
  const out = await git(['log', '--no-merges', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ad', '--date=short', `${from}..${to}`], cwd);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, subject, author, date] = line.split('\x1f');
      return { sha, shortSha, subject, author, date };
    });
}

/**
 * Files touched between two commits — narrows "which change did it" further.
 * @param {string} cwd
 * @param {string} from
 * @param {string} to
 * @returns {Promise<string[]>}
 */
export async function filesBetween(cwd, from, to) {
  const out = await git(['diff', '--name-only', `${from}..${to}`], cwd);
  return out ? out.split('\n').filter(Boolean) : [];
}

/**
 * @param {string} cwd
 * @param {string} sha
 */
export async function commitExists(cwd, sha) {
  return (await git(['cat-file', '-e', `${sha}^{commit}`], cwd)) !== null;
}

/**
 * @param {string} cwd
 */
export async function isRepo(cwd) {
  return (await git(['rev-parse', '--is-inside-work-tree'], cwd)) === 'true';
}
