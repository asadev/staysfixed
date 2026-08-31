/**
 * A reference cut from a tree with uncommitted changes is NOT its commit.
 *
 * The record is filed under a fingerprint of the tree that was actually walked — an id like
 * `work-76ac0155c8b9`, deliberately different from the commit's `git-...` id, because the
 * files that were checked are not the files git has. Paired mode then exported the COMMIT,
 * booted it, and called it "the old build".
 *
 * Everything downstream believed it. An address the record holds a real value for was walked
 * against a build that never had that address; the silence was read as proof the address is
 * new; and the reply said "is there now and was not before" about a value sitting in the
 * record on disk. Measured 2026-08-31 on a two-route Node server, with the recorded value
 * still readable in the `work-...` folder under `.staysfixed/v2/builds`.
 *
 * Falling back to the stored record is weaker, and the run says so. A weaker comparison you
 * are told about beats a strong-looking comparison against the wrong build.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, '../../bin/staysfixed.js');

/** @type {string} */
let dir;

/** @param {string[]} args */
async function git(args) {
  await run('git', args, { cwd: dir });
}

describe('a reference cut from a dirty tree', () => {
  before(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-dirty-'));
    await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'dirty', version: '1.0.0', type: 'module' }) + '\n');
    await fsp.writeFile(path.join(dir, 'cli.js'), "console.log('one');\n");
    await fsp.writeFile(
      path.join(dir, 'staysfixed.config.js'),
      'export default { product: "dirty", process: { commands: [{ name: "run", run: "node cli.js" }] } };\n',
    );
    await git(['init', '-q']);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one']);
  });

  after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('is never walked live by exporting its commit', async () => {
    // The tree the reference is cut from is NOT what git has: the file is edited and left
    // uncommitted, which is the ordinary state of a project somebody is working in.
    await fsp.writeFile(path.join(dir, 'cli.js'), "console.log('two');\n");

    const first = await run('node', [CLI, 'check', '--json'], { cwd: dir }).catch((e) => e);
    JSON.parse(String(first.stdout));
    await run('node', [CLI, 'ship'], { cwd: dir }).catch((e) => e);

    const second = await run('node', [CLI, 'check', '--paired', '--json'], { cwd: dir }).catch((e) => e);
    const answer = JSON.parse(String(second.stdout));

    assert.equal(
      answer.mode,
      'stored-record',
      'the reference was cut from a tree git does not have, so there is no old build to boot — booting the commit walks different code and calls it the same build',
    );
  });
});
