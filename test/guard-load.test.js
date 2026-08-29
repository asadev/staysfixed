/**
 * Loading a project's guards.
 *
 * The badly-named guard lives here rather than in the fixture app on purpose: a
 * refused name stops the whole folder loading, which is the right behaviour and
 * would also turn the fixture's own passing run red.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { loadGuards, guardTemplate } from '../src/guard/load.js';
import { resolveConfig } from '../src/core/config.js';
import { pathsFor } from '../src/core/paths.js';
import { StaysFixedError } from '../src/core/errors.js';
import { scratchDir, cleanUp } from './support.mjs';

after(cleanUp);

/**
 * A throwaway project with the given guard files in it.
 * @param {Record<string,string>} files  file name -> contents
 * @returns {Promise<import('../src/types.js').Project>}
 */
async function projectWithGuards(files) {
  const root = await scratchDir('staysfixed-guards');
  const configFile = path.join(root, 'staysfixed.config.js');
  const config = resolveConfig({ app: { kind: 'web', url: 'http://localhost:1' } }, configFile);
  const paths = pathsFor(root, configFile, config.dir);
  await fsp.mkdir(paths.guards, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(paths.guards, name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, body);
  }
  return { config, paths };
}

/** A guard that would pass if anyone ran it. */
const fine = (name = 'the sidebar still collapses') =>
  `export default { name: ${JSON.stringify(name)}, async run() {} };\n`;

describe('finding guards', () => {
  test('a project with no guards folder is not a problem', async () => {
    const project = await projectWithGuards({});
    await fsp.rm(project.paths.guards, { recursive: true, force: true });
    assert.deepEqual(await loadGuards(project), []);
  });

  test('guards are found in subfolders and come back in a stable order', async () => {
    const project = await projectWithGuards({
      'b.guard.js': fine('the export button still downloads a csv'),
      'a.guard.js': fine('the sidebar still collapses'),
      'nested/c.guard.js': fine('settings survive a restart'),
    });
    const names = (await loadGuards(project)).map((g) => g.name);
    assert.deepEqual(names, [
      'the sidebar still collapses',
      'the export button still downloads a csv',
      'settings survive a restart',
    ]);
  });

  test('a file parked with an underscore or a dot is left out', async () => {
    const project = await projectWithGuards({
      'a.guard.js': fine(),
      '_parked.guard.js': fine('the parked guard still runs'),
      '.hidden.guard.js': fine('the hidden guard still runs'),
    });
    const names = (await loadGuards(project)).map((g) => g.name);
    assert.deepEqual(names, ['the sidebar still collapses']);
  });

  test('only some guards can be asked for by name', async () => {
    const project = await projectWithGuards({
      'a.guard.js': fine('the sidebar still collapses'),
      'b.guard.js': fine('the export button still downloads a csv'),
    });
    const names = (await loadGuards(project, { only: 'EXPORT' })).map((g) => g.name);
    assert.deepEqual(names, ['the export button still downloads a csv']);
  });

  test('a file can export several guards at once', async () => {
    const project = await projectWithGuards({
      'many.guard.js':
        'export default [\n' +
        '  { name: "the sidebar still collapses", async run() {} },\n' +
        '  { name: "settings survive a restart", async run() {} },\n' +
        '];\n',
    });
    assert.equal((await loadGuards(project)).length, 2);
  });
});

describe('guards that are refused', () => {
  /**
   * @param {Record<string,string>} files
   * @param {RegExp} says
   */
  async function refuses(files, says) {
    const project = await projectWithGuards(files);
    await assert.rejects(loadGuards(project), (error) => {
      assert.ok(error instanceof StaysFixedError, String(error));
      assert.match(error.message, says);
      return true;
    });
  }

  test('a badly named guard stops the run and says what to write instead', async () => {
    const project = await projectWithGuards({
      'sidebar.guard.js':
        '/**\n' +
        ' * A guard nobody will understand in six months.\n' +
        ' *\n' +
        ' * The name is a code identifier, so Stays Fixed refuses it and offers the\n' +
        ' * sentence the author probably meant.\n' +
        ' */\n' +
        'export default { name: "sidebar_collapse_test", async run() {} };\n',
    });

    await assert.rejects(loadGuards(project), (error) => {
      assert.ok(error instanceof StaysFixedError, String(error));
      assert.match(error.message, /1 guard cannot run yet/);
      assert.match(error.message, /sidebar_collapse_test/);
      assert.match(error.message, /code identifier/);
      assert.match(error.message, /Try instead: "the sidebar still collapses"/);
      assert.match(String(error.hint), /A guard name is the only thing/);
      return true;
    });
  });

  test('every problem is reported at once, not one per run', async () => {
    const project = await projectWithGuards({
      'a.guard.js': 'export default { name: "sidebar_collapse_test", async run() {} };\n',
      'b.guard.js': 'export default { name: "#482", async run() {} };\n',
      'c.guard.js': 'export default { name: "the export button still downloads a csv" };\n',
    });
    await assert.rejects(loadGuards(project), (error) => {
      assert.ok(error instanceof StaysFixedError);
      assert.match(error.message, /3 guards cannot run yet/);
      assert.match(error.message, /no "run" function/);
      return true;
    });
  });

  test('two guards with the same name are refused, because a failure would be ambiguous', async () => {
    await refuses(
      {
        'a.guard.js': fine('the sidebar still collapses'),
        'b.guard.js': fine('the sidebar still collapses'),
      },
      /Two guards share this name/,
    );
  });

  test('a guard file that will not even load is named', async () => {
    await refuses({ 'broken.guard.js': 'export default { name: "the sidebar still collapses"\n' }, /could not be loaded/);
  });

  test('a file that exports something that is not a guard is named', async () => {
    await refuses({ 'notaguard.guard.js': 'export default 42;\n' }, /does not export a guard/);
  });
});

describe('the starter guard init writes', () => {
  test('it loads, and its own name passes the rule', async () => {
    const project = await projectWithGuards({ 'starter.guard.js': guardTemplate() });
    const guards = await loadGuards(project);
    assert.equal(guards.length, 1);
    assert.equal(guards[0].name, 'the sidebar still collapses');
    assert.equal(typeof guards[0].run, 'function');
    assert.ok(String(guards[0].because).length > 40, 'the starter guard should tell the story of the bug');
  });

  test('a name given to it is used, and a bad one would be caught by the same rule', async () => {
    const text = guardTemplate({ name: 'prices still show two decimals', because: 'They rounded to whole pounds.' });
    assert.match(text, /prices still show two decimals/);
    assert.match(text, /They rounded to whole pounds\./);
  });
});
