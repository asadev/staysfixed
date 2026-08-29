/**
 * Shared plumbing for the tests.
 *
 * Two rules hold this file together. Nothing is ever written inside the repo: a
 * test that leaves pictures in `fixtures/` makes the next run's "nothing changed"
 * a lie. And nothing fails because of the machine it ran on: if there is no
 * browser here, the tests that need one say so and skip.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findChrome } from '../src/drive/find.js';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fixtureRoot = path.join(repoRoot, 'fixtures', 'unstable-app');
export const cliPath = path.join(repoRoot, 'bin', 'staysfixed.js');

/** Everything a test made, so `cleanUp` can take it all away again. */
/** @type {string[]} */
const scratchDirs = [];

/**
 * A throwaway folder outside the repo.
 * @param {string} [label]
 * @returns {Promise<string>}
 */
export async function scratchDir(label = 'staysfixed') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  scratchDirs.push(dir);
  return dir;
}

/**
 * A private copy of the unstable fixture app, so a test can approve pictures,
 * write results and break things without touching the repo.
 * @returns {Promise<string>}
 */
export async function copyFixture() {
  const dir = await scratchDir('staysfixed-fixture');
  await fsp.cp(fixtureRoot, dir, { recursive: true });
  return dir;
}

/** Remove every scratch folder this process made. */
export async function cleanUp() {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Start the fixture app from a copy, and point the copy's config at it.
 *
 * The config reads its address from the environment, so setting it here is what
 * makes `loadProject` in this same process find the server we just started.
 *
 * @param {string} dir  A folder made by copyFixture.
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
export async function startFixture(dir) {
  const mod = await import(path.join(dir, 'server.mjs'));
  const server = await mod.startFixtureServer({ port: 0 });
  process.env.STAYSFIXED_FIXTURE_URL = server.url;
  return server;
}

/**
 * Is there a browser on this machine?
 * @returns {boolean}
 */
export function haveChrome() {
  try {
    return findChrome() !== null;
  } catch {
    return false;
  }
}

/** The sentence a skipped browser test prints, so nobody has to guess why. */
export const NO_BROWSER =
  'No Chrome, Chromium, Brave or Edge on this machine, so the tests that photograph a real app cannot run here. Install Google Chrome, or set STAYSFIXED_CHROME to a browser you have.';

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
