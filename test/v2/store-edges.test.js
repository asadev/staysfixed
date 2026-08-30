/**
 * The edges of the store — where bookkeeping fails and the answer must survive it.
 *
 * Everything in this file is one shape of bug. A record that cannot be written, a record
 * that is there and damaged, a journey that cannot be walked again: each of them ends with
 * the tool knowing LESS than usual, and each of them used to end with the tool saying
 * something as confidently as it says everything else.
 *
 * The rule these tests hold down is that losing the record must cost the record and nothing
 * else. The check still runs, the verdict still stands, and the sentence a person reads says
 * plainly what was lost — because "this run was not kept" and "this run was kept" look
 * identical from the outside, and only one of them leaves the next run with anything.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { check, explain, pathRules } from '../../src/v2/check.js';
import { referenceForCI, runCI } from '../../src/v2/ci.js';
import { productsKnown } from '../../src/v2/reference.js';
import { proveCause } from '../../src/v2/cause.js';
import { openStore, saveBuild, setReference } from '../../src/v2/store.js';
import { DEFAULT_RULES, mergeRules, rulesFingerprint } from '../../src/v2/normalise.js';
import { scratchDir, cleanUp } from '../support.mjs';

const run = promisify(execFile);

/** Folders taken away from this process, so `after` can hand them back whatever happened. */
/** @type {string[]} */
const shut = [];

after(async () => {
  while (shut.length > 0) {
    const dir = shut.pop();
    if (dir) await relax(dir);
  }
  await cleanUp();
});

/**
 * Take the write permission off every folder under here, and remember to give it back.
 *
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function tighten(dir) {
  shut.push(dir);
  /** @type {string[]} */
  const all = [];
  /** @param {string} d */
  const walk = async (d) => {
    for (const entry of await fsp.readdir(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const inside = path.join(d, entry.name);
        await walk(inside);
        all.push(inside);
      }
    }
  };
  await walk(dir);
  all.push(dir);
  for (const one of all) await fsp.chmod(one, 0o555);
}

/**
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function relax(dir) {
  /** @param {string} d */
  const walk = async (d) => {
    await fsp.chmod(d, 0o755).catch(() => {});
    for (const entry of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await walk(path.join(d, entry.name));
    }
  };
  await walk(dir);
}

/**
 * Can this account actually be denied a write? Running as root ignores the mode, and so do
 * some filesystems. Any of those and the tests below would pass without testing anything,
 * which is worse than not running them.
 *
 * @returns {Promise<boolean>}
 */
async function permissionsAreReal() {
  const dir = await scratchDir('staysfixed-perm-probe');
  await fsp.chmod(dir, 0o555);
  try {
    await fsp.writeFile(path.join(dir, 'x'), 'x');
    return false;
  } catch {
    return true;
  } finally {
    await fsp.chmod(dir, 0o755).catch(() => {});
  }
}

/**
 * A tiny product in a real repository: one commit that works, one uncommitted change that
 * drops a field. That is the shape an agent actually points this tool at.
 *
 * @returns {Promise<{dir: string, working: string, journeys: string}>}
 */
async function product() {
  const dir = await scratchDir('staysfixed-store-edges');
  await run('git', ['init', '-q'], { cwd: dir });
  await run('git', ['config', 'user.email', 'test@staysfixed.local'], { cwd: dir });
  await run('git', ['config', 'user.name', 'Stays Fixed test'], { cwd: dir });
  await fsp.writeFile(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'edges', version: '1.0.0' }, null, 2)}\n`);
  await fsp.writeFile(
    path.join(dir, 'cli.js'),
    "const person = { id: 7, name: 'Ada', email: 'ada@example.com', city: 'London' };\nconsole.log(JSON.stringify(person));\n",
  );
  const journeys = path.join(dir, 'journeys.json');
  await fsp.writeFile(
    journeys,
    `${JSON.stringify(
      [
        {
          name: 'run-it',
          describe: 'Run it once and watch everything it does.',
          source: 'code',
          surface: 'cli',
          steps: [{ act: 'run', run: 'node cli.js', note: 'the whole product' }],
        },
      ],
      null,
      2,
    )}\n`,
  );
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['commit', '-qm', 'the build that works'], { cwd: dir });
  const working = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  await fsp.writeFile(
    path.join(dir, 'cli.js'),
    "const person = { id: 7, name: 'Ada', city: 'London' };\nconsole.log(JSON.stringify(person));\n",
  );
  return { dir, working, journeys };
}

describe('a check whose record cannot be saved still answers', () => {
  test('the break is still found, and the run says out loud that it was not kept', async (t) => {
    if (!(await permissionsAreReal())) {
      t.skip('this account can write into a folder it has no permission to write into, so nothing here would be tested');
      return;
    }
    const { dir, working, journeys } = await product();
    const args = () => ({ cwd: dir, against: working, paired: true, journeys, only: [] });

    const first = await check(args());
    assert.equal(first.blocked, undefined, 'the warm-up run has to work, or the real one proves nothing');

    await tighten(path.join(dir, '.staysfixed', 'v2'));
    const second = await check(args());

    // Until 2026-08-30 `openProject` saved the build record unguarded, so this threw before
    // a single journey was walked: no answer at all, where the product could have been
    // opened, walked twice, compared, and the only thing genuinely lost was the note saying
    // it happened.
    assert.notEqual(second.blocked, true, 'a store that will not take a record must not cost the answer');
    assert.equal(second.findings.length, 1, 'the missing email address is still a finding');
    assert.match(second.summary, /NOT SAVED|NOT written down/i, 'and the run has to admit nothing reached the disk');
  });

  test('a store that was never writable at all still names the store as the reason', async (t) => {
    if (!(await permissionsAreReal())) {
      t.skip('permissions do not bite on this machine');
      return;
    }
    const { dir, working, journeys } = await product();
    const builds = path.join(dir, '.staysfixed', 'v2', 'builds');
    await fsp.mkdir(builds, { recursive: true });
    shut.push(builds);
    await fsp.chmod(builds, 0o555);

    const outcome = await check({ cwd: dir, against: working, paired: true, journeys, only: [] });

    // Nothing could be registered, so the reference named by a commit cannot be resolved and
    // the run really is blocked. What it must not do is hand somebody a bare permission
    // error from a folder they have never heard of with nothing joining the two up.
    assert.equal(outcome.blocked, true);
    assert.match(outcome.summary, /could not be written/i);
    assert.match(outcome.summary, /\.staysfixed/);
  });
});

describe('a build record that is there and damaged is not a build that never existed', () => {
  /**
   * A store holding one good build and one folder whose record is unreadable.
   * @returns {Promise<{cwd: string}>}
   */
  async function storeWithDamage() {
    const cwd = await scratchDir('staysfixed-damaged');
    await fsp.writeFile(path.join(cwd, 'package.json'), `${JSON.stringify({ name: 'edges' })}\n`);
    const store = openStore({ root: cwd });
    await saveBuild(store, { id: 'git-aaaaaaaaaaaa', product: 'edges', gitSha: 'a'.repeat(40) });
    await setReference(store, 'git-aaaaaaaaaaaa', { setBy: 'a test' });
    const broken = path.join(store.buildsDir, 'git-bbbbbbbbbbbb');
    await fsp.mkdir(broken, { recursive: true });
    await fsp.writeFile(path.join(broken, 'build.json'), '{ this is not json');
    return { cwd };
  }

  test('the build server says what it could not read instead of "nothing on record"', async () => {
    const { cwd } = await storeWithDamage();
    // No git repository here, so every commit-based mode misses and the file gets all the
    // way to its last line — the one that says a whole checkout holds nothing to compare
    // against. That line must not be said over the top of records nobody could open.
    const reference = await referenceForCI({ cwd, env: {} });
    const said = `${reference.caveat ?? ''} ${reference.considered.map((c) => c.why).join(' ')}`;
    assert.match(said, /could not be read/i, 'a skipped build record has to reach the report');
    assert.match(said, /git-bbbbbbbbbbbb/, 'and it has to name the folder, because it may be the one you meant');
  });

  test('the list of products a store knows says which records it could not read', async () => {
    const { cwd } = await storeWithDamage();
    const known = await productsKnown(openStore({ root: cwd }));
    assert.deepEqual(
      known.products.map((p) => p.product),
      ['edges'],
    );
    assert.equal(known.problems.length, 1, 'a damaged record can hide a whole product from this list');
    assert.match(known.problems[0], /git-bbbbbbbbbbbb/);
  });
});

describe('proving a cause never claims about a journey it did not walk', () => {
  /**
   * @param {string[]} journeys  One per difference.
   * @returns {any}
   */
  const findingAcross = (journeys) => ({
    id: 'f1',
    title: 'two addresses, two journeys',
    why: '',
    class: 'ordinary',
    rank: 0,
    count: journeys.length,
    differences: journeys.map((journey, i) => ({
      path: `x.${i}`,
      channel: 'results',
      kind: 'changed',
      reference: 'a',
      candidate: 'b',
      journey,
    })),
  });

  /** A walk that always reports the reference value back, so everything it sees is "gone". */
  const walk = async () => ({
    id: 'c',
    journey: 'here',
    build: { id: 'b', product: 'p' },
    run: 'single',
    startedAt: new Date().toISOString(),
    durationMs: 1,
    observations: [{ path: 'x.0', channel: 'results', value: 'a' }],
  });

  /** @returns {Promise<string>} */
  async function editedRepo() {
    const dir = await scratchDir('staysfixed-cause-edges');
    await run('git', ['init', '-q'], { cwd: dir });
    await run('git', ['config', 'user.email', 'test@staysfixed.local'], { cwd: dir });
    await run('git', ['config', 'user.name', 'Stays Fixed test'], { cwd: dir });
    await fsp.writeFile(path.join(dir, 'a.js'), 'export const a = 1;\n');
    await run('git', ['add', '-A'], { cwd: dir });
    await run('git', ['commit', '-qm', 'one'], { cwd: dir });
    await fsp.writeFile(path.join(dir, 'a.js'), 'export const a = 2;\n');
    return dir;
  }

  const here = [{ name: 'here', describe: 'here', source: 'code', surface: 'cli', steps: [] }];

  test('an address whose journey is not available is not reported as one that survived', async () => {
    const cwd = await editedRepo();
    const proof = await proveCause(findingAcross(['here', 'gone']), {
      cwd,
      walk: /** @type {any} */ (walk),
      journeys: /** @type {any} */ (here),
      candidate: { id: 'cand', product: 'p' },
    });

    // Everything walkable went away. The other address was never walked at all — and the old
    // arithmetic folded it in with the survivors, so the proof said it was "left exactly as
    // it was" and had "another cause nothing has looked for yet".
    assert.equal(proof.verdict, 'could not test', 'half a re-walk is not a proof either way');
    assert.equal(proof.escalates, false);
    assert.equal(proof.checked, 1, 'checked must count what was re-walked, not what was in the finding');
    assert.match(proof.what, /not re-checked at all/i);
    assert.match(proof.what, /gone/, 'the journey nobody could walk has to be named');
  });

  test('with every journey available it still gives a straight answer', async () => {
    const cwd = await editedRepo();
    const proof = await proveCause(findingAcross(['here']), {
      cwd,
      walk: /** @type {any} */ (walk),
      journeys: /** @type {any} */ (here),
      candidate: { id: 'cand', product: 'p' },
    });
    assert.equal(proof.verdict, 'caused by that change');
    assert.equal(proof.checked, 1);
    assert.equal(proof.disappeared, 1);
  });
});

describe('what a reply leaves out, it says it left out', () => {
  test('the nearest-code list says how many more files there are', async () => {
    const cwd = await scratchDir('staysfixed-explain');
    const store = openStore({ root: cwd });
    const { rememberCheck } = await import('../../src/v2/escalate.js');
    /** @type {any} */
    const verdict = {
      runId: '1',
      product: 'edges',
      ok: false,
      mode: 'paired',
      reference: { id: 'git-a', product: 'edges' },
      candidate: { id: 'work-a', product: 'edges' },
      findings: [
        {
          id: 'wide',
          title: 'It comes from everywhere.',
          why: '',
          class: 'ordinary',
          rank: 1,
          count: 1,
          nearFiles: Array.from({ length: 9 }, (_, i) => `src/file${i}.js`),
          differences: [{ path: 'a.b', channel: 'meaning', kind: 'changed', reference: '1', candidate: '2', journey: 'j' }],
        },
      ],
      differencesReal: 1,
      differencesNoise: 0,
      newlyUnstable: [],
      coverage: { paths: 1, journeys: 1, byChannel: {}, gaps: [] },
      summary: 'one thing changed',
      durationMs: 1,
      startedAt: new Date().toISOString(),
    };
    await rememberCheck(store, {
      product: 'edges',
      verdict,
      decided: /** @type {any} */ ({
        all: verdict.findings,
        reported: verdict.findings,
        accounting: { reported: 1, waived: 0, unwaivable: 0, expiredWaivers: 0, budget: 0, spent: 0, left: 0, intent: null, note: '' },
      }),
    });

    const out = await explain({ cwd, finding: 'wide' });
    // Six names with nothing after them read as the whole list, and an agent that opened all
    // six believed it had seen everywhere this finding lives.
    assert.match(out.text, /and 3 more files/);
  });
});

describe('a build server that loses its evidence says so on the report', () => {
  test('the run still exits on the verdict, and the report stops pointing at a folder that was never written', async (t) => {
    if (!(await permissionsAreReal())) {
      t.skip('permissions do not bite on this machine');
      return;
    }
    const { dir, journeys } = await product();
    // Somewhere the evidence cannot possibly be written: a folder with no write permission.
    const locked = await scratchDir('staysfixed-evidence-shut');
    shut.push(locked);
    await fsp.chmod(locked, 0o555);

    const result = await runCI({
      cwd: dir,
      env: {},
      journeys,
      evidenceDir: path.join(locked, 'evidence'),
      quiet: true,
    });

    assert.equal(result.evidence, null);
    // The report says in so many words that the rest of the gaps are "in the evidence
    // attached to this run". A run that swallowed this printed that sentence pointing at a
    // folder that does not exist.
    assert.match(result.report.text, /EVIDENCE FOR THIS RUN WAS NOT SAVED/i);
    assert.match(result.report.markdown, /EVIDENCE FOR THIS RUN WAS NOT SAVED/i);
  });
});


describe('a run that compared nothing never comes back looking like a pass', () => {
  test('a cold start is not ok, on the field an agent reads', async () => {
    // The command line has always caught this and exits 2. `--json` and the MCP surface read
    // the verdict, not the command line, so both answered ok: true to "did I break anything"
    // on a product where nothing whatever had been compared. That is this tool producing the
    // exact failure it exists to prevent, to the only two readers who cannot notice.
    const { dir, journeys } = await product();
    const outcome = await check({ cwd: dir, journeys, only: [] });

    assert.equal(outcome.reference.id, '', 'the fixture has to be a real cold start, or this proves nothing');
    assert.equal(outcome.blocked, undefined, 'the run itself worked — it is the answer that is empty');
    assert.equal(outcome.ok, false, 'a run that compared nothing is not a pass');
    assert.match(outcome.summary, /NOTHING WAS ACTUALLY COMPARED/);
  });
});

describe('the stored record stops growing', () => {
  /**
   * How many recordings each build is holding, journey by journey.
   * @param {string} dir
   * @returns {Promise<Record<string, number[]>>}
   */
  async function recordings(dir) {
    const builds = path.join(dir, '.staysfixed', 'v2', 'builds');
    /** @type {Record<string, number[]>} */
    const out = {};
    for (const name of await fsp.readdir(builds)) {
      /** @type {number[]} */
      const per = [];
      for (const inside of await fsp.readdir(path.join(builds, name), { withFileTypes: true })) {
        if (inside.isDirectory()) per.push((await fsp.readdir(path.join(builds, name, inside.name))).length);
      }
      out[name] = per;
    }
    return out;
  }

  test('old builds are thinned out, the reference is not, and the run says what it removed', async () => {
    // `.staysfixed/` is deliberately kept in git, so the growth is permanent and it is in
    // somebody's history: one build folder per check, for ever. `pruneBuild` was written to
    // stop that and was never called from anywhere in the tool.
    const { dir, working, journeys } = await product();
    /** @param {number} i */
    const editAndCheck = async (i) => {
      await fsp.writeFile(
        path.join(dir, 'cli.js'),
        `const person = { id: ${i}, name: 'Ada', city: 'London' };\nconsole.log(JSON.stringify(person));\n`,
      );
      return check({ cwd: dir, against: working, paired: true, journeys, only: [] });
    };

    await editAndCheck(0);
    // Make the oldest build the one this product calls working. It is now the build most
    // likely to be swept up by anything that goes by age, and it is the one whose recordings
    // are the only evidence of what working looks like.
    const before = Object.keys(await recordings(dir)).filter((n) => n.startsWith('work-'));
    assert.equal(before.length, 1);
    await setReference(openStore({ root: dir }), before[0], { setBy: 'a test' });

    /** @type {string} */
    let last = '';
    for (let i = 1; i < 9; i += 1) last = (await editAndCheck(i)).summary;

    const held = await recordings(dir);
    /** @param {string} name */
    const most = (name) => Math.max(0, ...(held[name] ?? [0]));

    assert.match(last, /cleared out of/i, 'it has to say so in one line when it removes something');
    assert.equal(most(before[0]), 2, 'the build somebody shipped keeps its pair, however old it gets — without it nothing can say how steady that build was');
    const thinned = Object.keys(held).filter((name) => name !== before[0] && most(name) === 1);
    assert.ok(thinned.length >= 2, `the oldest builds have to be thinned, and ${JSON.stringify(held)} says none were`);
    for (const name of Object.keys(held)) {
      assert.ok(most(name) <= 2, `${name} is holding ${most(name)} recordings of one journey, so nothing is capped`);
    }
  });
});

describe('two folders normalised in one run, two rule ids', () => {
  test('the real checkout still has a rule of its own', () => {
    // `mergeRules` keys by id and the later one wins, so calling `machineRules` twice handed
    // `path.project-root` to both folders and the scratch copy deleted the real one. The rule
    // meant to rewrite somebody's actual checkout was in no run this tool has ever done.
    const rules = mergeRules(DEFAULT_RULES, pathRules({ root: '/Users/a/demo', scratch: '/tmp/staysfixed-check-aaa' }));
    const byId = new Map(rules.map((r) => [r.id, r]));
    assert.equal(byId.get('path.project-root')?.pattern, '/Users/a/demo');
    assert.equal(byId.get('path.scratch-copy')?.pattern, '/tmp/staysfixed-check-aaa');
  });

  test('a fresh scratch folder every run does not move the rule fingerprint', () => {
    const one = rulesFingerprint(mergeRules(DEFAULT_RULES, pathRules({ root: '/Users/a/demo', scratch: '/tmp/staysfixed-check-aaa' })));
    const two = rulesFingerprint(mergeRules(DEFAULT_RULES, pathRules({ root: '/Users/a/demo', scratch: '/tmp/staysfixed-check-bbb' })));
    assert.equal(one, two, 'otherwise every clean run reports itself as compared across a change to the rules, for ever');
  });
});
