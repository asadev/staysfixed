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

import { pathToFileURL } from 'node:url';

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
  /**
   * A folder that looks like something. `init` reads a project rather than assuming one,
   * so an empty directory is a fair question with a boring answer — and these tests are
   * about what it writes when there IS something to watch.
   *
   * @param {string} name
   * @returns {Promise<string>}
   */
  async function aTinyProject(name) {
    const dir = await scratchDir(name);
    // A real repository, because half of what `init` writes only makes sense in one — a
    // .gitignore for the throwaway results, and a reference that is named by a commit.
    await new Promise((resolve) => execFile('git', ['init', '-q'], { cwd: dir }, () => resolve(null)));
    await fsp.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'tiny', version: '1.0.0', type: 'module', bin: { tiny: 'cli.js' } }, null, 2) + '\n',
    );
    await fsp.writeFile(path.join(dir, 'cli.js'), "console.log('hello');\n");
    return dir;
  }

  test('everything it says it wrote is actually there, and the settings load', async () => {
    const dir = await aTinyProject('staysfixed-init');
    const { code, stdout } = await cli(['init'], { cwd: dir });
    assert.equal(code, EXIT.ok);

    // It lists what it wrote. Every one of those has to exist, or the first thing
    // somebody does is go looking for a file that was never written.
    const line = /^\s*(?:ok\s+)?Written: (.+)$/m.exec(stdout);
    assert.ok(line, `init never said what it wrote. It said:\n${stdout}`);
    const written = line[1].split(',').map((f) => f.trim()).filter(Boolean);
    assert.ok(written.length >= 1, `init claimed to write nothing: ${line[1]}`);
    for (const made of written) {
      assert.ok(fs.existsSync(path.resolve(dir, made)), `init said it wrote ${made}, and it is not there`);
    }

    const configFile = findConfigFile(dir);
    assert.ok(configFile, 'init did not leave a settings file behind');

    // The settings it wrote have to be settings the tool can actually read back — as a
    // module, because they are JavaScript, and with the product it found named in them.
    const settings = (await import(`${pathToFileURL(String(configFile)).href}?t=${Date.now()}`)).default;
    assert.equal(typeof settings, 'object');
    assert.equal(settings.product, 'tiny');
    assert.ok(Array.isArray(settings.process?.commands) && settings.process.commands.length > 0, 'it found a command to run and did not write it down');

    // Results are throwaway and must never be committed. Nothing else in that folder is
    // ignored, because the record of what working looks like belongs in the repository.
    const gitignore = await fsp.readFile(path.join(dir, '.gitignore'), 'utf8');
    assert.match(gitignore, /\.staysfixed\/results\//);
    assert.ok(!/^\.staysfixed\/$/m.test(gitignore), 'the whole folder must not be ignored — the stored record lives in it');
  });

  test('running it twice does not overwrite what is already there', async () => {
    const dir = await aTinyProject('staysfixed-init-twice');
    await cli(['init'], { cwd: dir });

    const configFile = String(findConfigFile(dir));
    const mine = await fsp.readFile(configFile, 'utf8');
    await fsp.writeFile(configFile, `${mine}\n// a line somebody added by hand\n`);

    const again = await cli(['init'], { cwd: dir });
    assert.equal(again.code, EXIT.ok);
    // Both streams: "written" is good news and goes to stdout, "left alone" is a warning
    // and goes to stderr, and a reader of this test should not have to know which.
    assert.match(again.stdout + again.stderr, /Left exactly as it was/);

    const kept = await fsp.readFile(configFile, 'utf8');
    assert.match(kept, /a line somebody added by hand/, 'init overwrote settings somebody had already edited');
  });

  test('the picture commands say plainly why they do not apply to a product with no screen', async () => {
    // `status`, `walk`, `approve`, `mark`, `trace` and `check --pictures` all work by
    // opening something and photographing it, and settings written for a command-line tool
    // name nothing to open — which is correct, not a mistake. What they must never do is
    // tell somebody to go and add a web address they do not have.
    const dir = await aTinyProject('staysfixed-status');
    await cli(['init'], { cwd: dir });

    const { stdout, stderr } = await cli(['status'], { cwd: dir });
    const said = stdout + stderr;
    assert.match(said, /do not name anything to open/);
    assert.match(said, /staysfixed check/, 'it has to name the half of the tool that DOES cover this project');
  });

  test('status still works where there is something to open', async () => {
    // The version 1 promise, held: a project with an `app` block keeps every picture
    // command exactly as it was. Nobody who was using them has to stop.
    const dir = await scratchDir('staysfixed-status-pictures');
    await fsp.writeFile(
      path.join(dir, 'staysfixed.config.js'),
      "export default { app: { kind: 'web', url: 'http://localhost:3000' }, screens: [{ name: 'home', url: '/' }] };\n",
    );
    const project = await loadProject({ cwd: dir });
    assert.equal(project.paths.root, dir);

    const { code, stdout } = await cli(['status'], { cwd: dir });
    assert.equal(code, EXIT.ok);
    assert.match(stdout, /Stays Fixed/);
    assert.match(stdout, /Nothing has been checked here yet/);
  });

  test('the settings file it writes is commented for a person to edit', async () => {
    const dir = await aTinyProject('staysfixed-init-comments');
    await cli(['init'], { cwd: dir });
    const text = await fsp.readFile(String(findConfigFile(dir)), 'utf8');
    assert.ok(text.split('\n').filter((l) => /^\s*(\/\/|\*|\/\*)/.test(l)).length > 10, text.slice(0, 400));
  });

  test('and it says the same thing as one object, which is what an agent reads', async () => {
    // docs/getting-started.md is written entirely around these fields. A page that tells
    // an agent to read `plan.readiness` against a command that does not produce it is
    // worse than no page, so the names are asserted here rather than trusted.
    const dir = await aTinyProject('staysfixed-init-json');
    const { code, stdout } = await cli(['init', '--json'], { cwd: dir });
    assert.equal(code, EXIT.ok);
    const answer = JSON.parse(stdout);
    assert.equal(answer.ok, true, stdout.slice(0, 400));
    for (const field of ['project', 'readiness', 'needs', 'journeys', 'config', 'covers', 'wiring']) {
      assert.ok(field in answer.plan, `init --json has no plan.${field}, and getting-started.md tells an agent to read it`);
    }
    assert.ok(Array.isArray(answer.plan.project.products), 'a repository usually makes more than one thing, so this is a list');
    for (const who of ['agent', 'person', 'impossible']) {
      assert.ok(Array.isArray(answer.plan.needs[who]), `needs.${who} has to be a list, even an empty one`);
    }
    assert.equal(typeof answer.plan.covers.short, 'string');
    assert.ok(answer.plan.covers.short.length > 20, 'the paragraph an agent repeats to a person cannot be empty');
  });

  test('nobody is asked for a build step on a script that runs from source', async () => {
    // A plain Node command-line tool is recorded as "not built", because there is nothing
    // to build — and that used to be read as "it has not been built yet", so a fresh
    // install told its owner to go and name the command that builds a file sitting right
    // there, which the same run had already worked out how to run. Being sent shopping for
    // nothing is the fastest way to make somebody stop reading this page.
    const dir = await aTinyProject('staysfixed-init-nobuild');
    const { stdout } = await cli(['init', '--json'], { cwd: dir });
    const answer = JSON.parse(stdout);
    const asked = [...answer.plan.needs.person, ...answer.plan.needs.agent];
    for (const need of asked) {
      assert.ok(!/built$/.test(String(need.what)), `it asked for "${need.what}" on a script that runs straight from source`);
    }
    assert.ok(
      answer.plan.readiness.some((/** @type {{state: string}} */ r) => r.state === 'ready'),
      'a command-line tool it can already run has to read as ready',
    );
  });

  test('--dry-run works everything out and writes nothing', async () => {
    const dir = await aTinyProject('staysfixed-init-dry');
    const { code } = await cli(['init', '--dry-run'], { cwd: dir });
    assert.equal(code, EXIT.ok);
    assert.equal(findConfigFile(dir), null, '--dry-run wrote a settings file');
  });
});

describe('the exit codes are the contract', () => {
  test('they are the three a script can rely on', () => {
    assert.equal(EXIT.ok, 0);
    assert.equal(EXIT.failed, 1);
    assert.equal(EXIT.error, 2);
  });
});
