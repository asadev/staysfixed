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
import { fileURLToPath, pathToFileURL } from 'node:url';

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
    if (dir) await removeAll(dir).catch(() => {});
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
  // A file URL, never a bare path. On Windows an absolute path starts `C:\`, and Node's
  // loader reads `C:` as a protocol it does not know — ERR_UNSUPPORTED_ESM_URL_SCHEME, which
  // failed every test that starts the fixture app on a real Windows 11 machine on 2026-08-31.
  const mod = await import(pathToFileURL(path.join(dir, 'server.mjs')).href);
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

/**
 * Delete a folder, allowing for a machine that has not let go of it yet.
 *
 * Windows will not delete a file anything still has open, and "still has open" lasts a moment
 * longer than the program that had it open: a test that stops its server and immediately
 * deletes the folder underneath it gets EBUSY. Measured on a real Windows 11 machine on
 * 2026-08-31, where `waiting.test.js` failed as a whole file on exactly this. The retries are
 * Node's own, and on a Mac or Linux the first attempt always succeeds, so they cost nothing.
 *
 * @param {string} dir
 * @returns {Promise<void>}
 */
export async function removeAll(dir) {
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

/**
 * Try to make a folder genuinely unreadable, and say whether it worked.
 *
 * Several tests here prove something valuable: a folder the tool cannot open is REPORTED,
 * rather than quietly skipped along with everything under it. Building that fixture needs a
 * folder that really cannot be read, and `chmod` is the only portable way to ask — except it
 * is not portable. On Windows Node maps `chmod` to the read-only attribute, which does not
 * apply to folders at all, so the folder stays perfectly readable and the test then proves
 * nothing while claiming to. Measured on a real Windows 11 machine on 2026-08-31.
 *
 * So the answer is checked rather than assumed, and a caller that gets `false` should skip:
 * the product behaviour is real, this machine simply cannot build the situation that shows it.
 *
 * @param {string} dir
 * @returns {Promise<boolean>} true when the folder really cannot be read now
 */
export async function madeUnreadable(dir) {
  await fsp.chmod(dir, 0o000).catch(() => {});
  try {
    await fsp.readdir(dir);
    return false;
  } catch {
    return true;
  }
}

/** The sentence a test prints when this machine will not lock a folder. */
export const CANNOT_LOCK_A_FOLDER =
  'This operating system will not make a folder unreadable with chmod, so the situation this proves cannot be built here.';

/**
 * The environment variable this operating system reads for its temporary folder.
 *
 * Windows reads `TEMP` (and `TMP`); everything else reads `TMPDIR`. A test that sets the wrong
 * one changes nothing and then measures a run that was never affected.
 */
export const TEMP_ENV_VAR = process.platform === 'win32' ? 'TEMP' : 'TMPDIR';

/**
 * Can this machine make a symbolic link at all?
 *
 * Windows refuses one to an ordinary account unless Developer Mode is on, and answers EPERM.
 * That is a fact about the machine, not about the tool, so a test that needs one asks first.
 *
 * @returns {Promise<boolean>}
 */
export async function canSymlink() {
  const dir = await scratchDir('staysfixed-can-link');
  try {
    await fsp.symlink(dir, path.join(dir, 'self'), 'dir');
    return true;
  } catch {
    return false;
  }
}

/** The sentence a test prints when this machine refuses symbolic links. */
export const NO_SYMLINKS =
  'This machine will not make a symbolic link (Windows refuses one without Developer Mode), so a project reached through a link cannot be built here.';

/**
 * Run something with a different home folder, on any operating system.
 *
 * `os.homedir()` — which is what the product asks — does NOT read `HOME` on Windows; it reads
 * `USERPROFILE`. So a test that sets only `HOME` changes nothing there, and then measures a
 * run that was looking at the real person's real home folder the whole time. Measured on a
 * real Windows 11 machine on 2026-08-31, where the ssh-config case read the machine's own
 * `~/.ssh/config` instead of the two-line one the test had just written.
 *
 * Both are set, and both are put back, so the same test says the same thing everywhere.
 *
 * @template T
 * @param {string} home
 * @param {() => Promise<T>} body
 * @returns {Promise<T>}
 */
export async function withHome(home, body) {
  const names = process.platform === 'win32' ? ['HOME', 'USERPROFILE'] : ['HOME'];
  /** @type {(string|undefined)[]} */
  const before = names.map((n) => process.env[n]);
  for (const n of names) process.env[n] = home;
  try {
    return await body();
  } finally {
    names.forEach((n, i) => {
      const was = before[i];
      if (was === undefined) delete process.env[n];
      else process.env[n] = was;
    });
  }
}

/**
 * Will a process this one started outlive being killed?
 *
 * On Linux and a Mac it will: killing a parent leaves its children running with a new parent,
 * which is exactly how a crashed run leaves a browser behind. On Windows it will not —
 * measured on a real Windows 11 machine on 2026-08-31, a grandchild was gone within a second
 * of its parent being killed — so the situation a test needs in order to prove the leftover is
 * found and cleared cannot be created there at all.
 *
 * @returns {Promise<boolean>}
 */
export async function orphansSurviveHere() {
  return process.platform !== 'win32';
}

/** The sentence a test prints when this machine will not leave an orphan behind. */
export const NO_ORPHANS_HERE =
  'On this operating system a process is taken with the one that started it, so a run cannot leave a browser behind and the leftover this proves cannot be created.';

/** The sentence a test prints when a signal cannot be delivered as a signal. */
export const NO_REAL_SIGNALS =
  'On this operating system one program cannot send another a catchable signal — child.kill() is always an outright terminate — so a run cannot be interrupted in a way its own handlers could answer.';

/** Can one process send another a signal it is able to catch and act on? */
export const SIGNALS_ARE_CATCHABLE = process.platform !== 'win32';
