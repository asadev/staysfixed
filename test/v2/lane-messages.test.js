/**
 * What a person is handed when something goes wrong.
 *
 * Three refusals that were technically correct and practically useless. Every one of them is
 * the same fault wearing a different coat: the tool knew something the reader needed and did
 * not say it, or said it in the machine's words rather than in a sentence.
 *
 *   - the temporary folder would not take a new folder, and what came out was
 *     `ENOENT: no such file or directory, mkdtemp '/nowhere/staysfixed-check-FHwIxx'`, in
 *     the block this tool tells an agent to put in a summary for the person who owns the
 *     product;
 *   - `init` said a library "can be checked here now" and that a check "covers it in full",
 *     about an entry point that was not on the disk;
 *   - a check run inside a nested project quietly measured the PARENT'S product and came
 *     back with no hint that it had.
 *
 * All three are versions of the one rule this tool cannot bend: never hand back a clean or a
 * confident answer you have not earned, and never in words only its author could read.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { check, aboutSomewhereElse } from '../../src/v2/check.js';
import { plan, isThereOnDisk } from '../../src/v2/init.js';
import { scratchDir, cleanUp } from '../support.mjs';

const run = promisify(execFile);

after(cleanUp);

/**
 * A folder that is a real project: a git repository with one commit, a package, a program
 * and settings naming a command worth running.
 *
 * @param {string} label
 * @param {string} name  What package.json calls it.
 * @returns {Promise<string>}
 */
async function aProject(label, name) {
  const dir = await scratchDir(label);
  await fsp.mkdir(path.join(dir, 'bin'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'package.json'), `${JSON.stringify({ name, version: '1.0.0', type: 'module' }, null, 2)}\n`);
  await fsp.writeFile(path.join(dir, 'bin', 'cli.js'), `console.log('${name} v1');\n`);
  await fsp.writeFile(
    path.join(dir, 'staysfixed.config.json'),
    `${JSON.stringify({ product: name, process: { commands: [{ name: 'help', run: 'node bin/cli.js' }] } }, null, 2)}\n`,
  );
  await run('git', ['init', '-q'], { cwd: dir });
  await run('git', ['config', 'user.email', 'test@staysfixed.local'], { cwd: dir });
  await run('git', ['config', 'user.name', 'Stays Fixed test'], { cwd: dir });
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['commit', '-qm', 'the build that works'], { cwd: dir });
  return dir;
}

/**
 * Run something with TMPDIR pointed somewhere else, and put it back afterwards.
 *
 * The whole point of the defect is that `os.tmpdir()` reads this setting, so the only honest
 * way to reproduce it is to set it. It is restored in a `finally` because everything else in
 * this process — including the folders these tests clean up — works out of the same one.
 *
 * @template T
 * @param {string} where
 * @param {() => Promise<T>} body
 * @returns {Promise<T>}
 */
async function withTmpdir(where, body) {
  const before = process.env.TMPDIR;
  process.env.TMPDIR = where;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
}

describe('the temporary folder will not take a new folder', () => {
  test('a folder that is not there is refused in a sentence, not in an error code', async () => {
    const dir = await aProject('staysfixed-tmp-missing', 'tmp-missing-product');
    const nowhere = path.join(dir, 'not-a-folder', 'nor-this-one');

    const outcome = await withTmpdir(nowhere, () => check({ cwd: dir }));

    assert.equal(outcome.blocked, true, 'nothing was walked, so this may never read as a pass');
    // The exact string a person was handed before. If either of these comes back, the raw
    // errno has leaked into the block meant for somebody who does not write code.
    assert.ok(!/mkdtemp/i.test(outcome.summary), `the machine's own words reached the reader: ${outcome.summary}`);
    assert.ok(!/ENOENT/.test(outcome.summary), `the error code reached the reader: ${outcome.summary}`);
    assert.match(outcome.summary, /throwaway folder it works in/, outcome.summary);
    assert.match(outcome.summary, /There is no folder at/, outcome.summary);
    // And the half that says what to DO about it.
    assert.match(outcome.summary, /TMPDIR/, outcome.summary);
    assert.match(outcome.summary, /run the check again/, outcome.summary);
  });

  test('a folder this user cannot write in says exactly that', async () => {
    const dir = await aProject('staysfixed-tmp-readonly', 'tmp-readonly-product');
    const locked = path.join(dir, 'locked');
    await fsp.mkdir(locked, { recursive: true });
    await fsp.chmod(locked, 0o500);

    const outcome = await withTmpdir(locked, () => check({ cwd: dir }));
    await fsp.chmod(locked, 0o700).catch(() => {});

    assert.equal(outcome.blocked, true, 'nothing was walked, so this may never read as a pass');
    assert.ok(!/mkdtemp/i.test(outcome.summary), `the machine's own words reached the reader: ${outcome.summary}`);
    assert.ok(!/EACCES|EPERM/.test(outcome.summary), `the error code reached the reader: ${outcome.summary}`);
    assert.match(outcome.summary, /not allowed to write in it/, outcome.summary);
  });
});

describe('a way in that package.json promises and the folder has not got', () => {
  /**
   * A package that says other code should import a file it does not have.
   * @param {{entry: string, create?: boolean, build?: string}} how
   * @returns {Promise<string>}
   */
  async function aLibrary(how) {
    const dir = await scratchDir('staysfixed-library');
    await fsp.mkdir(path.join(dir, 'src'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'src', 'thing.js'), 'export const thing = 1;\n');
    await fsp.writeFile(
      path.join(dir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'half-built-lib',
          version: '0.1.0',
          type: 'module',
          exports: { '.': how.entry },
          ...(how.build ? { scripts: { build: how.build } } : {}),
        },
        null,
        2,
      )}\n`,
    );
    if (how.create) await fsp.writeFile(path.join(dir, how.entry), 'export const hello = 1;\n');
    return dir;
  }

  test('it is not "ready", and a check here does not "cover it in full"', async () => {
    const dir = await aLibrary({ entry: './index.js' });
    const made = await plan({ cwd: dir, offline: true, readCode: false });

    const library = made.readiness.find((r) => r.kind === 'library');
    assert.ok(library, 'the library surface was not found at all');
    assert.notEqual(library.state, 'ready', `a file that is not there was reported as ready: ${library.summary}`);
    assert.ok(
      !/can be checked here now/.test(library.summary),
      `the entry point does not exist and this still said it could be checked: ${library.summary}`,
    );
    assert.ok(
      !made.covers.covered.includes(library.product),
      `"covers ... in full" about an entry point that is not on the disk: ${made.covers.short}`,
    );
    assert.ok(!/Nothing is being left out/.test(made.covers.short), made.covers.short);

    const said = library.needs.map((n) => `${n.what} ${n.why} ${n.fix}`).join(' | ');
    assert.match(said, /index\.js/, said);
    assert.match(said, /not there/, said);

    // And the list of what it would walk stops promising that entry too. A journey printed
    // as ready is a promise that a check will walk it.
    const entry = made.journeys.find((j) => j.surface === 'library');
    assert.ok(entry, 'the library journey was not proposed at all');
    assert.equal(entry.ready, false, 'a journey through a file that does not exist was listed as ready');
  });

  test('a build script makes it the agent\'s job, not the person\'s', async () => {
    const dir = await aLibrary({ entry: './dist/index.js', build: 'node -e "1"' });
    const made = await plan({ cwd: dir, offline: true, readCode: false });

    const library = made.readiness.find((r) => r.kind === 'library');
    assert.ok(library, 'the library surface was not found at all');
    const missing = library.needs.find((n) => /not there/.test(n.what));
    assert.ok(missing, 'the missing entry point was not reported at all');
    assert.equal(missing.who, 'the agent', 'there is a build script, so nobody needs to be asked for anything');
    assert.match(missing.fix, /npm run build/, missing.fix);
  });

  test('an entry point that IS there raises nothing', async () => {
    const dir = await aLibrary({ entry: './index.js', create: true });
    const made = await plan({ cwd: dir, offline: true, readCode: false });

    const library = made.readiness.find((r) => r.kind === 'library');
    assert.ok(library, 'the library surface was not found at all');
    // The direction that matters here is the false alarm. A settings file has not been
    // written yet, so there is still an honest thing outstanding — what there must not be
    // is a line about an entry point that is sitting right there.
    const said = library.needs.map((n) => `${n.what} ${n.why} ${n.fix}`).join(' | ');
    assert.ok(!/not there/.test(said), `a file that exists was reported missing: ${said}`);
    const entry = made.journeys.find((j) => j.surface === 'library');
    assert.equal(entry?.ready, true, 'the file is there, so walking it is a promise that can be kept');
  });

  test('the shorthands package.json is allowed to use are not read as missing', async () => {
    const dir = await scratchDir('staysfixed-entry-shapes');
    await fsp.mkdir(path.join(dir, 'lib'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'lib', 'index.js'), 'export const a = 1;\n');
    await fsp.writeFile(path.join(dir, 'plain.js'), 'export const b = 2;\n');

    assert.equal(isThereOnDisk(dir, '.', './lib'), true, 'a folder with an index.js in it is a way in');
    assert.equal(isThereOnDisk(dir, '.', './plain'), true, 'a name with the extension left off is a way in');
    assert.equal(isThereOnDisk(dir, '.', './plain.js'), true);
    assert.equal(isThereOnDisk(dir, '.', './nowhere.js'), false);
  });
});

describe('a check run inside a project of its own', () => {
  test('it says which product it went for, and that it was not this folder', () => {
    const said = aboutSomewhereElse({ from: '/repo/sub', root: '/repo', product: 'parent-product' });
    assert.ok(said, 'standing in a different folder from the one being checked said nothing at all');
  });

  test('nothing is said when the check really is about the folder it was typed in', () => {
    assert.equal(aboutSomewhereElse({ from: '/repo', root: '/repo', product: 'p' }), null);
  });

  test('the parent\'s product is named, and the folder that was NOT checked is named too', async () => {
    const parent = await aProject('staysfixed-parent', 'parent-product');
    const child = path.join(parent, 'sub');
    await fsp.mkdir(path.join(child, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(child, 'package.json'), `${JSON.stringify({ name: 'child-product', version: '2.0.0', type: 'module' }, null, 2)}\n`);
    await fsp.writeFile(path.join(child, 'bin', 'cli.js'), "console.log('child v1');\n");
    await run('git', ['init', '-q'], { cwd: child });
    await run('git', ['config', 'user.email', 'test@staysfixed.local'], { cwd: child });
    await run('git', ['config', 'user.name', 'Stays Fixed test'], { cwd: child });
    await run('git', ['add', '-A'], { cwd: child });
    await run('git', ['commit', '-qm', 'a product of its own'], { cwd: child });

    const outcome = await check({ cwd: child });

    // The whole defect in one assertion: the answer is about the parent, and it says so
    // before it says anything else.
    assert.equal(outcome.product, 'parent-product', 'the parent is what got walked, which is the thing to be honest about');
    assert.match(outcome.summary, /^NOT THE FOLDER YOU ARE STANDING IN\./, outcome.summary);
    assert.match(outcome.summary, /parent-product/, outcome.summary);
    assert.match(outcome.summary, /sub/, outcome.summary);
    assert.match(outcome.summary, /Nothing inside .*sub was checked/, outcome.summary);
    assert.match(outcome.summary, /staysfixed init/, outcome.summary);

    // And it is in the coverage list, which is the one list a build server's table and the
    // closing count both read.
    const gaps = outcome.coverage?.gaps ?? [];
    assert.ok(
      gaps.some((g) => /sub/.test(g.what) && /run from/.test(g.what)),
      `the folder nobody checked is missing from the coverage list: ${JSON.stringify(gaps.map((g) => g.what))}`,
    );
  });

  test('standing in an ordinary sub-folder still names the product, without the alarm', async () => {
    const parent = await aProject('staysfixed-plain-subfolder', 'plain-parent');

    const outcome = await check({ cwd: path.join(parent, 'bin') });

    assert.match(outcome.summary, /^This check was aimed at "plain-parent"/, outcome.summary);
    assert.ok(!/NOT THE FOLDER YOU ARE STANDING IN/.test(outcome.summary), `a folder that is plainly part of this project raised the alarm: ${outcome.summary}`);
  });
});
