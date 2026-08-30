/**
 * Where everything lives inside a project.
 *
 * Committed (belongs in git):   approved/  guards/  markers/  fixtures/  config
 * Not committed (throwaway):    results/   diffs/   report.html  last-run.json
 *
 * The split matters: approved pictures are the promise, results are just the
 * evidence from the last run.
 */

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

export const CONFIG_NAMES = [
  'staysfixed.config.js',
  'staysfixed.config.mjs',
  'staysfixed.config.json',
  '.staysfixed/config.js',
  '.staysfixed/config.mjs',
  '.staysfixed/config.json',
];

export const DEFAULT_DIR = '.staysfixed';

/**
 * Walk up from `from` looking for a config file.
 * @param {string} [from]
 * @returns {string|null} absolute path to the config file, or null
 */
export function findConfigFile(from = process.cwd()) {
  let dir = path.resolve(from);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The project root for a config file: the folder holding it, or its parent
 * when the config lives inside `.staysfixed/`.
 * @param {string} configFile
 */
export function rootForConfig(configFile) {
  const dir = path.dirname(configFile);
  return path.basename(dir) === DEFAULT_DIR ? path.dirname(dir) : dir;
}

/**
 * @param {string} root
 * @param {string} configFile
 * @param {string} [dirName]
 * @returns {import('../types.js').ProjectPaths}
 */
export function pathsFor(root, configFile, dirName = DEFAULT_DIR) {
  const dir = path.isAbsolute(dirName) ? dirName : path.join(root, dirName);
  return {
    root,
    dir,
    approved: path.join(dir, 'approved'),
    results: path.join(dir, 'results'),
    diffs: path.join(dir, 'results', 'diffs'),
    markers: path.join(dir, 'markers'),
    guards: path.join(dir, 'guards'),
    fixtures: path.join(dir, 'fixtures'),
    historyFile: path.join(dir, 'history.json'),
    reportFile: path.join(dir, 'report.html'),
    configFile,
  };
}

/**
 * Create the folders that must exist before a run.
 * @param {import('../types.js').ProjectPaths} paths
 */
export async function ensureDirs(paths) {
  for (const d of [paths.dir, paths.approved, paths.results, paths.diffs, paths.markers]) {
    await fsp.mkdir(d, { recursive: true });
  }
}

/**
 * File name for an approved picture and its metadata.
 * @param {import('../types.js').ProjectPaths} paths
 * @param {string} name
 */
export function approvedPicture(paths, name) {
  return {
    png: path.join(paths.approved, `${safeName(name)}.png`),
    json: path.join(paths.approved, `${safeName(name)}.json`),
  };
}

/**
 * File names for this run's output for one screen.
 * @param {import('../types.js').ProjectPaths} paths
 * @param {string} name
 */
export function resultPicture(paths, name) {
  return {
    png: path.join(paths.results, `${safeName(name)}.png`),
    diff: path.join(paths.diffs, `${safeName(name)}.diff.png`),
  };
}

/**
 * Screen names become file names, so keep them boring.
 * @param {string} name
 */
export function safeName(name) {
  return String(name)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'unnamed';
}

/**
 * Clear the previous run's evidence so a stale diff can never be mistaken for a fresh one.
 * @param {import('../types.js').ProjectPaths} paths
 */
export async function clearResults(paths) {
  await fsp.rm(paths.results, { recursive: true, force: true });
  await fsp.mkdir(paths.diffs, { recursive: true });
}

/**
 * The .gitignore lines a project needs. Written by `init`, checked by `doctor`.
 */
export const GITIGNORE_LINES = [
  '# Stays Fixed — evidence from the last run, not the promise',
  '.staysfixed/results/',
  '.staysfixed/report.html',
  // Where one person dragged the watch panel on one screen. Nobody else's business,
  // and it would otherwise turn up in their commits.
  '.staysfixed/watch-window.json',
  // Version 2's evidence, which none of the lines above match — they were all written for
  // version 1's folders. Measured 2026-08-30 on a Next.js project: 151 untracked files and
  // 1.9 MB of run evidence sitting in `git status` after nine checks, and every release then
  // warning that it was made from a dirty tree. `builds/` is the bulk of it: one folder per
  // build, holding what each run observed.
  '.staysfixed/v2/builds/',
  '.staysfixed/v2/last-check.json',
  // The lock a run holds while it changes the record. Never anybody's to commit.
  '.staysfixed/**/*.lock',
];

/*
 * Deliberately NOT ignored: `references.json` and `reference-log.json`. Those are the record
 * of what this product calls working and which release said so — the one thing here a team
 * genuinely shares, and the thing a new clone needs in order to compare against anything.
 */
