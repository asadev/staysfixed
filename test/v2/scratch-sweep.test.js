/**
 * Reclaiming a scratch folder has to stop what is still running inside it.
 *
 * A check copies the build into a throwaway folder and starts the product there. When the run
 * dies before it can stop them, those programs keep going — four `vite preview` servers from
 * the previous day were still running on this machine on 2026-08-31, out of scratch folders
 * that had already been deleted, holding four ports. Deleting the folder and walking away
 * from its programs is a tool quietly eating somebody's machine, and this one gets installed
 * on machines that are not its author's.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { sweepAbandonedScratch } from '../../src/v2/check.js';

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** @param {number} ms */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('an abandoned scratch folder', () => {
  test('has its leftover programs stopped, not just its files deleted', { skip: process.platform === 'win32' ? 'the process list is asked for differently on Windows' : false }, async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-check-'));
    // An owner that is not running is what "abandoned" means here.
    await fsp.writeFile(path.join(dir, 'owner.json'), JSON.stringify({ pid: 0x7ffffff }));
    const script = path.join(dir, 'server.js');
    await fsp.writeFile(script, 'setInterval(() => {}, 1000);\n');

    const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = /** @type {number} */ (child.pid);
    await wait(400);
    assert.equal(alive(pid), true, 'the stand-in for a leaked server never started');

    await sweepAbandonedScratch();
    await wait(800);

    assert.equal(alive(pid), false, 'the folder was reclaimed and its server left running — that is the leak, not the fix');
    assert.equal(
      await fsp.stat(dir).then(() => true).catch(() => false),
      false,
      'the folder itself is still there',
    );
  });

  test('a folder whose owner is alive is left completely alone', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-check-'));
    await fsp.writeFile(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid }));
    await sweepAbandonedScratch();
    assert.equal(
      await fsp.stat(dir).then(() => true).catch(() => false),
      true,
      'a run that is still going had its own working folder deleted underneath it',
    );
    await fsp.rm(dir, { recursive: true, force: true });
  });
});
