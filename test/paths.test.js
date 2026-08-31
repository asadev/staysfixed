/**
 * Where things live, and the one rule underneath all of it: approved pictures
 * are the promise and belong in git; results are only evidence from the last run
 * and must be thrown away before the next one, or a stale diff gets mistaken for
 * a fresh one.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  findConfigFile,
  rootForConfig,
  pathsFor,
  ensureDirs,
  approvedPicture,
  resultPicture,
  safeName,
  clearResults,
  CONFIG_NAMES,
  DEFAULT_DIR,
  GITIGNORE_LINES,
} from '../src/core/paths.js';
import { scratchDir, cleanUp } from './support.mjs';

after(cleanUp);

describe('findConfigFile', () => {
  test('finds a config sitting right here', async () => {
    const dir = await scratchDir('staysfixed-here');
    const file = path.join(dir, 'staysfixed.config.js');
    await fsp.writeFile(file, 'export default {};');
    assert.equal(findConfigFile(dir), file);
  });

  test('walks up from a folder deep inside the project', async () => {
    const dir = await scratchDir('staysfixed-deep');
    const file = path.join(dir, 'staysfixed.config.js');
    await fsp.writeFile(file, 'export default {};');
    const deep = path.join(dir, 'src', 'components', 'sidebar');
    await fsp.mkdir(deep, { recursive: true });
    assert.equal(findConfigFile(deep), file);
  });

  test('finds one tucked inside .staysfixed too', async () => {
    const dir = await scratchDir('staysfixed-inside');
    await fsp.mkdir(path.join(dir, DEFAULT_DIR), { recursive: true });
    const file = path.join(dir, DEFAULT_DIR, 'config.js');
    await fsp.writeFile(file, 'export default {};');
    assert.equal(findConfigFile(dir), file);
  });

  test('prefers the name earliest in the list when a project has two', async () => {
    const dir = await scratchDir('staysfixed-two');
    await fsp.writeFile(path.join(dir, 'staysfixed.config.json'), '{}');
    await fsp.writeFile(path.join(dir, 'staysfixed.config.js'), 'export default {};');
    assert.equal(findConfigFile(dir), path.join(dir, CONFIG_NAMES[0]));
  });

  test('says null rather than guessing when there is nothing', async () => {
    const dir = await scratchDir('staysfixed-none');
    assert.equal(findConfigFile(dir), null);
  });
});

describe('rootForConfig', () => {
  test('a config at the top means the project is that folder', () => {
    assert.equal(rootForConfig('/work/app/staysfixed.config.js'), '/work/app');
  });

  test('a config inside .staysfixed means the project is the folder above it', () => {
    assert.equal(rootForConfig(`/work/app/${DEFAULT_DIR}/config.js`), '/work/app');
  });

  test('a folder that merely ends in something similar is not mistaken for it', () => {
    assert.equal(rootForConfig('/work/my.staysfixed/staysfixed.config.js'), '/work/my.staysfixed');
  });
});

describe('pathsFor', () => {
  // These are folders on the machine the tool is running on, so the separator between them is
  // whichever one this machine uses. Spelling the expected answers with `/` said "the project
  // folder is C:\work\app but its state folder is /work/app/.staysfixed", which is not a
  // folder Windows can open — four cases here failed on a real Windows 11 machine on
  // 2026-08-31 for that reason and no other. `path.join` asks the same question the product
  // answers, on every machine.
  const at = (/** @type {string[]} */ ...parts) => path.join(...parts);

  test('everything hangs off the state folder', () => {
    const p = pathsFor('/work/app', '/work/app/staysfixed.config.js');
    assert.equal(p.root, '/work/app');
    assert.equal(p.dir, at('/work/app', DEFAULT_DIR));
    assert.equal(p.approved, at('/work/app', DEFAULT_DIR, 'approved'));
    assert.equal(p.results, at('/work/app', DEFAULT_DIR, 'results'));
    // Diffs live under results, so clearing results clears the diffs with them.
    assert.equal(p.diffs, at('/work/app', DEFAULT_DIR, 'results', 'diffs'));
    assert.equal(p.markers, at('/work/app', DEFAULT_DIR, 'markers'));
    assert.equal(p.guards, at('/work/app', DEFAULT_DIR, 'guards'));
    assert.equal(p.fixtures, at('/work/app', DEFAULT_DIR, 'fixtures'));
    assert.equal(p.historyFile, at('/work/app', DEFAULT_DIR, 'history.json'));
    assert.equal(p.configFile, '/work/app/staysfixed.config.js');
  });

  test('a project can name its own folder', () => {
    const p = pathsFor('/work/app', '/work/app/staysfixed.config.js', 'visual');
    assert.equal(p.dir, at('/work/app', 'visual'));
    assert.equal(p.approved, at('/work/app', 'visual', 'approved'));
  });

  test('an absolute folder is taken as it is', () => {
    const p = pathsFor('/work/app', '/work/app/staysfixed.config.js', '/var/staysfixed');
    assert.equal(p.dir, '/var/staysfixed');
  });
});

describe('safeName', () => {
  test('a boring name is left alone', () => {
    assert.equal(safeName('home'), 'home');
    assert.equal(safeName('sessions-empty'), 'sessions-empty');
    assert.equal(safeName('file.name_v2-x'), 'file.name_v2-x');
  });

  test('spaces and punctuation become one hyphen', () => {
    assert.equal(safeName('Sessions Empty'), 'Sessions-Empty');
    assert.equal(safeName('a   b'), 'a-b');
  });

  test('nothing can escape the folder it is written into', () => {
    assert.equal(safeName('a/b/c'), 'a-b-c');
    assert.equal(safeName('../../etc/passwd'), '..-..-etc-passwd');
    assert.ok(!safeName('../../etc/passwd').includes('/'));
  });

  test('surrounding hyphens and whitespace are trimmed off', () => {
    assert.equal(safeName('  spaced  '), 'spaced');
    assert.equal(safeName('-lead-'), 'lead');
  });

  test('a name with nothing usable in it still gets a file name', () => {
    assert.equal(safeName(''), 'unnamed');
    assert.equal(safeName('   '), 'unnamed');
    assert.equal(safeName('!!!'), 'unnamed');
    assert.equal(safeName('---'), 'unnamed');
  });

  test('a very long name is cut to something a file system will take', () => {
    const long = safeName('a'.repeat(400));
    assert.equal(long.length, 120);
  });
});

describe('the picture files for a screen', () => {
  const paths = pathsFor('/work/app', '/work/app/staysfixed.config.js');

  test('an approved picture comes with a note beside it', () => {
    const files = approvedPicture(paths, 'sessions empty');
    assert.equal(files.png, path.join('/work/app', DEFAULT_DIR, 'approved', 'sessions-empty.png'));
    assert.equal(files.json, path.join('/work/app', DEFAULT_DIR, 'approved', 'sessions-empty.json'));
  });

  test('a result and its difference picture sit apart from the approved one', () => {
    const files = resultPicture(paths, 'sessions empty');
    assert.equal(files.png, path.join('/work/app', DEFAULT_DIR, 'results', 'sessions-empty.png'));
    assert.equal(files.diff, path.join('/work/app', DEFAULT_DIR, 'results', 'diffs', 'sessions-empty.diff.png'));
  });
});

describe('making and clearing folders', () => {
  test('ensureDirs makes everything a run needs and is safe to repeat', async () => {
    const root = await scratchDir('staysfixed-dirs');
    const paths = pathsFor(root, path.join(root, 'staysfixed.config.js'));
    await ensureDirs(paths);
    await ensureDirs(paths);
    for (const dir of [paths.dir, paths.approved, paths.results, paths.diffs, paths.markers]) {
      assert.ok(fs.statSync(dir).isDirectory(), `${dir} should exist`);
    }
  });

  test('clearing the results never touches the approved pictures', async () => {
    const root = await scratchDir('staysfixed-clear');
    const paths = pathsFor(root, path.join(root, 'staysfixed.config.js'));
    await ensureDirs(paths);
    await fsp.writeFile(approvedPicture(paths, 'home').png, 'the promise');
    await fsp.writeFile(resultPicture(paths, 'home').png, 'last run');
    await fsp.writeFile(resultPicture(paths, 'home').diff, 'last run');

    await clearResults(paths);

    assert.equal(fs.existsSync(approvedPicture(paths, 'home').png), true);
    assert.equal(fs.existsSync(resultPicture(paths, 'home').png), false);
    assert.equal(fs.existsSync(resultPicture(paths, 'home').diff), false);
    // The empty folders have to come back, or the next run writes into nowhere.
    assert.ok(fs.statSync(paths.diffs).isDirectory());
  });
});

describe('the gitignore lines', () => {
  test('the throwaway evidence is ignored and the promise is not', () => {
    const text = GITIGNORE_LINES.join('\n');
    assert.match(text, /results\//);
    assert.match(text, /report\.html/);
    assert.ok(!/approved/.test(text), 'approved pictures belong in git');
    assert.ok(!/guards/.test(text), 'guards belong in git');
  });
});
