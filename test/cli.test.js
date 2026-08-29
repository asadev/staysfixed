/**
 * The command line, run the way a person runs it: as a separate process, with
 * nothing mocked.
 *
 * The exit codes are part of the contract — 0 when nothing changed, 1 when
 * something did, 2 when the tool could not run — so scripts and build machines
 * can rely on them.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { EXIT } from '../src/core/errors.js';
import { VERSION } from '../src/run.js';
import { findConfigFile } from '../src/core/paths.js';
import { loadProject } from '../src/core/config.js';
import { cliPath, repoRoot, scratchDir, cleanUp } from './support.mjs';

/** Every command the help is supposed to name. */
const COMMANDS = ['init', 'check', 'approve', 'walk', 'mark', 'trace', 'status', 'flake', 'doctor', 'mcp'];

after(cleanUp);

/**
 * Run the CLI and wait for it, whatever it exits with.
 * @param {string[]} args
 * @param {{cwd?: string}} [opts]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function cli(args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd: opts.cwd ?? repoRoot, env: { ...process.env, NO_COLOR: '1' }, timeout: 120_000 },
      (error, stdout, stderr) => {
        const code = error && typeof (/** @type {any} */ (error).code) === 'number' ? /** @type {any} */ (error).code : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

describe('the front door', () => {
  test('the CLI file is where package.json says it is', () => {
    assert.ok(fs.existsSync(cliPath), `${cliPath} is missing`);
  });

  test('--help names every command and answers with success', async () => {
    const { code, stdout } = await cli(['--help']);
    assert.equal(code, EXIT.ok);
    for (const command of COMMANDS) {
      assert.match(stdout, new RegExp(`\\b${command}\\b`), `--help never mentions "${command}"`);
    }
    assert.match(stdout, /Usage/);
    assert.match(stdout, /Stays Fixed/);
  });

  test('-h says the same thing', async () => {
    const long = await cli(['--help']);
    const short = await cli(['-h']);
    assert.equal(short.code, EXIT.ok);
    assert.equal(short.stdout, long.stdout);
  });

  test('the help is written in plain words', async () => {
    const { stdout } = await cli(['--help']);
    assert.ok(
      !/\b(assertion|regex|stdout|serializ|deterministic)\b/i.test(stdout),
      'the help should read like English, not like a manual page',
    );
  });

  test('--version prints the version and nothing else', async () => {
    const { code, stdout } = await cli(['--version']);
    assert.equal(code, EXIT.ok);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
    assert.equal(stdout.trim(), VERSION);

    const pkg = JSON.parse(await fsp.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(stdout.trim(), pkg.version);
  });

  test('a command nobody has heard of is refused, and points at the help', async () => {
    const { code, stderr } = await cli(['wibble']);
    assert.equal(code, EXIT.error);
    assert.match(stderr, /no command called "wibble"/);
    assert.match(stderr, /--help/);
  });

  test('a project with no settings is told to run init, not shown a stack trace', async () => {
    const dir = await scratchDir('staysfixed-bare');
    const { code, stderr } = await cli(['check'], { cwd: dir });
    assert.equal(code, EXIT.error);
    assert.match(stderr, /No Stays Fixed config found/);
    assert.match(stderr, /staysfixed init/);
    assert.ok(!/at Object\.|node:internal/.test(stderr), 'a setup problem must not print a stack trace');
  });
});

describe('init', () => {
  test('everything it says it made is actually there, and the settings load', async () => {
    const dir = await scratchDir('staysfixed-init');
    const { code, stdout } = await cli(['init'], { cwd: dir });
    assert.equal(code, EXIT.ok);

    // It lists what it made. Every one of those has to exist, or the first thing
    // a new user does is look for a file that was never written.
    const promised = [...stdout.matchAll(/^\s*made (.+)$/gm)].map((m) => m[1].trim());
    assert.ok(promised.length >= 4, `init only claimed to make ${promised.length} things`);
    for (const made of promised) {
      assert.ok(fs.existsSync(path.join(dir, made)), `init said it made ${made}, and it is not there`);
    }

    // The things a project cannot work without, named rather than inferred.
    const configFile = findConfigFile(dir);
    assert.ok(configFile, 'init did not leave a settings file behind');
    assert.ok(fs.statSync(path.join(dir, '.staysfixed')).isDirectory());
    assert.ok(fs.statSync(path.join(dir, '.staysfixed', 'guards')).isDirectory());

    // The settings it wrote have to be settings the tool can actually read.
    const project = await loadProject({ cwd: dir });
    assert.ok(project.config.app.kind === 'web' || project.config.app.kind === 'electron');
    assert.equal(project.paths.root, dir);

    // Results are throwaway and must never be committed; approved pictures must.
    const gitignore = await fsp.readFile(path.join(dir, '.gitignore'), 'utf8');
    assert.match(gitignore, /\.staysfixed\/results\//);
    assert.ok(!/approved/.test(gitignore));
  });

  test('running it twice does not overwrite what is already there', async () => {
    const dir = await scratchDir('staysfixed-init-twice');
    await cli(['init'], { cwd: dir });

    const configFile = String(findConfigFile(dir));
    await fsp.writeFile(
      configFile,
      "export default { app: { kind: 'web', url: 'http://localhost:9999' }, screens: [] };\n",
    );

    const again = await cli(['init'], { cwd: dir });
    assert.equal(again.code, EXIT.ok);
    assert.match(again.stdout, /left alone/);

    const kept = await fsp.readFile(configFile, 'utf8');
    assert.match(kept, /localhost:9999/, 'init overwrote settings somebody had already edited');
  });

  test('status works in a freshly made project and says nothing has been checked', async () => {
    const dir = await scratchDir('staysfixed-status');
    await cli(['init'], { cwd: dir });

    const { code, stdout } = await cli(['status'], { cwd: dir });
    assert.equal(code, EXIT.ok);
    assert.match(stdout, /Stays Fixed/);
    assert.match(stdout, /Nothing has been checked here yet/);
  });

  test('the settings file it writes is commented for a person to edit', async () => {
    const dir = await scratchDir('staysfixed-init-comments');
    await cli(['init'], { cwd: dir });
    const text = await fsp.readFile(String(findConfigFile(dir)), 'utf8');
    assert.ok(text.split('\n').filter((l) => /^\s*(\/\/|\*|\/\*)/.test(l)).length > 10, text.slice(0, 400));
  });
});

describe('the exit codes are the contract', () => {
  test('they are the three a script can rely on', () => {
    assert.equal(EXIT.ok, 0);
    assert.equal(EXIT.failed, 1);
    assert.equal(EXIT.error, 2);
  });
});
