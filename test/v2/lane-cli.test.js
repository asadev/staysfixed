/**
 * Two promises the command line was not keeping.
 *
 * ONE. A person and an agent must get the same answer about the same product. The MCP
 * server has had `staysfixed_coverage`, `staysfixed_explain`, `staysfixed_prove`,
 * `staysfixed_waive` and `staysfixed_intent` since version 2 landed, and the command line
 * had none of them — so somebody at a terminal could not see what was NOT checked, could
 * not open a finding, could not test whether their own edit caused it, and could not record
 * one as intended. The checks here hold the two surfaces level.
 *
 * TWO. `staysfixed flake` answered "No check here has ever changed its mind. That is
 * exactly how it should be." about a register whose own JSON showed a guard going from
 * passed to failed. That is the one thing this tool may never do: report a clean result it
 * has not earned. The checks here refuse the all-clear unless the record supports it.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';

import { EXIT } from '../../src/core/errors.js';
import { COMMANDS } from '../../src/cli/index.js';
import { report } from '../../src/v2/cli.js';
import { printFlakes } from '../../src/report/console.js';
import { toolDefinitions } from '../../src/v2/mcp/tools.js';
import { cliPath, repoRoot, scratchDir, cleanUp } from '../support.mjs';

after(cleanUp);

/**
 * Run the CLI the way a person runs it, and never throw on a non-zero exit — the exit code
 * is part of what is being checked.
 *
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
      }
    );
  });
}

/**
 * Everything a printer wrote to the terminal, as one string.
 *
 * src/core/log.js writes straight to the real stream on purpose — there is no logger to
 * inject — so the stream is what has to be borrowed for the length of one call.
 *
 * @param {() => void} printing
 * @returns {string}
 */
function printed(printing) {
  const real = process.stdout.write;
  /** @type {string[]} */
  const lines = [];
  /** @type {any} */ (process.stdout).write = (/** @type {any} */ chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    printing();
  } finally {
    /** @type {any} */ (process.stdout).write = real;
  }
  return lines.join('');
}

/**
 * One row of the flake register, the way `foldRun` in src/core/history.js writes it.
 *
 * `lastSha` is written by that function and is not on the `HistoryEntry` type, which is why
 * it is attached through a cast here as well.
 *
 * @param {{name: string, recent: import('../../src/types.js').CheckStatus[], flakes?: number, lastSha?: string|null, condemned?: boolean}} what
 * @returns {import('../../src/types.js').HistoryEntry}
 */
function entry(what) {
  /** @type {any} */
  const row = {
    name: what.name,
    kind: 'guard',
    runs: what.recent.length,
    flakes: what.flakes ?? 0,
    recent: what.recent,
    lastSha: what.lastSha === undefined ? null : what.lastSha,
  };
  if (what.condemned) row.condemned = true;
  if (what.flakes) row.lastFlakeAt = new Date().toISOString();
  return row;
}

describe('the flake register never gives an all-clear it has not earned', () => {
  test('a guard whose recorded answers flip is not reported as having never changed its mind', () => {
    // Exactly the register measured 2026-08-31 after two real runs of a flipping guard:
    // the statuses disagree, and nothing counted a wobble because the working tree was
    // dirty both times.
    const out = printed(() =>
      printFlakes({ 'guard:the total still adds up': entry({ name: 'the total still adds up', recent: ['passed', 'failed'] }) }, 2)
    );

    assert.doesNotMatch(out, /never changed its mind/i, 'gave a clean bill of health to a register holding a flip');
    assert.doesNotMatch(out, /exactly how it should be/i, 'called a contradicted register the way it should be');
    assert.match(out, /the total still adds up/, 'never named the check whose answers disagree');
    assert.match(out, /passed then failed/, 'never showed the sequence its own --json shows');
  });

  test('it says the tree may have been dirty, instead of claiming there is no commit', () => {
    const out = printed(() =>
      printFlakes({ 'guard:one': entry({ name: 'one', recent: ['passed', 'failed'], lastSha: null }) }, 2)
    );

    assert.match(out, /uncommitted changes/i, 'never mentions the reason that actually applied');
    // The old sentence stated one cause as fact. A folder WITH a commit and a dirty tree
    // hits this same path, so the reason has to allow for both or it is simply untrue.
    assert.doesNotMatch(out, /this folder has no commit to pin/i, 'still states one cause as though it were the only one');
  });

  test('a register with nothing disagreeing in it still gets the all-clear', () => {
    const out = printed(() =>
      printFlakes(
        {
          'guard:one': entry({ name: 'one', recent: ['passed', 'passed', 'passed'] }),
          'guard:two': entry({ name: 'two', recent: ['passed'] }),
        },
        2
      )
    );

    assert.match(out, /No check here has ever changed its mind/, 'withheld an all-clear that was genuinely earned');
  });

  test('a check that was skipped and then passed is not accused of anything', () => {
    // 'skipped', 'new' and 'missing' are checks that never reached a verdict. Reading the
    // move from one of those to 'passed' as a change of mind would put every check somebody
    // switched back on into the report, and a false accusation of flakiness costs the same
    // trust as a false failure.
    const out = printed(() =>
      printFlakes({ 'guard:one': entry({ name: 'one', recent: ['skipped', 'new', 'passed'] }) }, 2)
    );

    assert.match(out, /No check here has ever changed its mind/, 'accused a check that was merely switched back on');
  });

  test('a wobble that WAS counted still prints the register exactly as before', () => {
    const out = printed(() =>
      printFlakes(
        { 'guard:one': entry({ name: 'the sidebar still collapses', recent: ['passed', 'failed'], flakes: 2, lastSha: 'abc1234', condemned: true }) },
        2
      )
    );

    assert.match(out, /Checks that have changed their mind/, 'lost the register heading');
    assert.match(out, /the sidebar still collapses/, 'lost the check name');
    assert.match(out, /fix it or delete it/, 'lost the condemned verdict');
    // It is in the register, so it must not also appear in the list of things nothing can
    // judge — one check, said once.
    assert.doesNotMatch(out, /nothing can say why/i, 'listed one check twice, in both sections');
  });
});

describe('a person is offered what an agent is offered', () => {
  /**
   * Which command answers which tool. Two of them are answered by a command that already
   * existed under its own name, and those are written down rather than guessed at.
   *
   * @type {Record<string, string>}
   */
  const ANSWERED_BY = {
    staysfixed_capabilities: 'doctor',
    staysfixed_check: 'check',
    staysfixed_intent: 'intent',
    staysfixed_explain: 'explain',
    staysfixed_prove: 'prove',
    staysfixed_waive: 'waive',
    staysfixed_coverage: 'coverage',
  };

  test('every tool an agent can call has a command a person can type', () => {
    for (const tool of toolDefinitions()) {
      const command = ANSWERED_BY[tool.name];
      assert.ok(command, `${tool.name} is offered to an agent and nothing says which command answers it for a person`);
      assert.ok(COMMANDS[command], `an agent can call ${tool.name} and there is no \`staysfixed ${command}\``);
    }
  });

  test('each new command is registered the way the old ones are', () => {
    for (const name of ['coverage', 'explain', 'prove', 'waive', 'intent']) {
      const entry = COMMANDS[name];
      assert.ok(entry, `there is no \`staysfixed ${name}\``);
      assert.ok(entry.summary && entry.summary.length > 10, `${name} has no summary for the main help`);
      assert.match(entry.usage, new RegExp(`^staysfixed ${name}\\b`), `${name}'s usage line does not start with the command`);
      assert.ok(entry.describe && entry.describe.length > 80, `${name} has no paragraph in its own help`);
      assert.ok(entry.examples && entry.examples.length > 0, `${name} shows nobody how to use it`);
      assert.ok(entry.load, `${name} is listed and not wired up`);
    }
  });

  test('every flag these commands document is a flag the parser knows', () => {
    // A flag that prints in the help and does nothing is the same lie as a flag that does
    // not exist, and a slower one to find.
    for (const name of ['coverage', 'explain', 'prove', 'waive', 'intent']) {
      const entry = COMMANDS[name];
      const spec = entry.spec ?? {};
      const known = new Set([...(spec.booleans ?? []), ...(spec.strings ?? []), ...(spec.arrays ?? [])]);
      for (const [flag] of entry.options ?? []) {
        const match = /^--(?:no-)?([a-z-]+)/.exec(flag);
        if (!match) continue;
        assert.ok(known.has(match[1]), `\`staysfixed ${name}\` documents --${match[1]} and does not declare it`);
      }
    }
  });

  test('--help names them, so somebody can find them without reading the source', async () => {
    const { code, stdout } = await cli(['--help']);
    assert.equal(code, EXIT.ok);
    for (const name of ['coverage', 'explain', 'prove', 'waive', 'intent']) {
      assert.match(stdout, new RegExp(`\\n\\s+${name}\\s`), `--help never mentions "${name}"`);
    }
  });
});

describe('the new commands, run for real', () => {
  test('coverage answers about a folder nobody has ever checked, and says so', async () => {
    const dir = await scratchDir('lane-cli-coverage');
    const { code, stdout } = await cli(['coverage'], { cwd: dir });
    assert.equal(code, EXIT.ok);
    assert.match(stdout, /WHAT WAS NOT CHECKED/);
    assert.match(stdout, /No check has run/i, 'did not admit that nothing has ever been checked here');
  });

  test('a waiver that was refused never answers 0', async () => {
    // Whatever the reason — a refusal, an unknown id, a project that has never been checked
    // — the waiver was NOT recorded, and anything reading the exit code has to be told that.
    const dir = await scratchDir('lane-cli-waive');
    const { code } = await cli(['waive', 'f-nothing', '--because', 'it was me'], { cwd: dir });
    assert.notEqual(code, EXIT.ok, 'a waiver that was not recorded reported success');
  });

  test('explain with no id says what to type instead of a stack trace', async () => {
    const dir = await scratchDir('lane-cli-explain');
    const { code, stderr } = await cli(['explain'], { cwd: dir });
    assert.equal(code, EXIT.error);
    assert.match(stderr, /staysfixed explain f-/, 'never showed the shape of the command');
    assert.doesNotMatch(stderr, /at .*\.js:\d+/, 'answered a person with a stack trace');
  });
});

describe('the report hands over the ids the new commands take', () => {
  test('a finding is printed with the id explain and waive want', () => {
    /** @type {any} */
    const verdict = {
      runId: 'r1',
      product: 'widget',
      ok: false,
      mode: 'paired',
      reference: { id: 'git-abc', version: '1.0.0' },
      candidate: { id: 'work-def' },
      findings: [
        {
          id: 'f-a1b2c3',
          title: 'The basket total is no longer the sum of its lines.',
          why: '',
          class: 'ordinary',
          differences: [],
          rank: 1,
          paths: ['cli.run-it.stdout'],
        },
      ],
      differencesReal: 1,
      differencesNoise: 0,
      newlyUnstable: [],
      coverage: { paths: 1, journeys: 1, doorsKnown: 1, doorsWalked: 1, gaps: [] },
      summary: '1 thing behaves differently.',
      durationMs: 10,
      startedAt: new Date().toISOString(),
    };

    const out = printed(() => report(verdict));

    assert.match(out, /\[f-a1b2c3\]/, 'the id every follow-up command takes was never shown to the person');
    assert.match(out, /staysfixed explain f-a1b2c3/, 'nothing tells a person what the id is for');
  });
});
