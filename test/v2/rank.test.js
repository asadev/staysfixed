/**
 * Ranking — the order the agent reads them in, which in practice is the only
 * order there is, because it will act on the first two and skim the rest.
 *
 * Two rules, and the second one beats the first.
 *
 * FAR FROM THE EDIT COMES FIRST. A difference inside the file you were just
 * working on is very probably the thing you meant to do. A difference on the
 * other side of the product, in code nobody touched, is the definition of a side
 * effect — so it sorts to the TOP. This is upside down compared with every
 * ordinary test runner, and it is deliberate.
 *
 * SEALED CLASSES BEAT EVERYTHING. Money, signing in, losing data, a crash, or a
 * bug somebody already reported once. No agent may wave one of those through, so
 * they can never be sitting below the fold.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { rankFindings, classOf, whatChanged, importGraph } from '../../src/v2/rank.js';
import { clusterDifferences } from '../../src/v2/cluster.js';
import { scratchDir, cleanUp } from '../support.mjs';

const run = promisify(execFile);

/**
 * A little repository with one commit in it, so what git says can be asked for real.
 * @param {Record<string, string>} files
 * @returns {Promise<string>}
 */
async function repoWith(files) {
  const dir = await scratchDir('staysfixed-rank-git');
  await run('git', ['init', '-q'], { cwd: dir });
  await run('git', ['config', 'user.email', 'test@staysfixed.local'], { cwd: dir });
  await run('git', ['config', 'user.name', 'Stays Fixed test'], { cwd: dir });
  for (const [name, body] of Object.entries(files)) {
    await fsp.mkdir(path.join(dir, path.dirname(name)), { recursive: true });
    await fsp.writeFile(path.join(dir, name), body);
  }
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['commit', '-qm', 'the build that works'], { cwd: dir });
  return dir;
}

/** A little project on disk, so distance is measured through real imports rather than mocked. */
let root = '';

/** What git would have told us, handed in directly so no test depends on a repository. */
function edited() {
  return { ok: true, files: ['src/ui/Settings.js'], untracked: [], hunks: [], patch: '', root, base: 'HEAD', committed: false };
}

before(async () => {
  root = await scratchDir('staysfixed-rank');
  const files = {
    'src/ui/Settings.js': 'export const settings = 1;\n',
    'src/ui/Panel.js': "import { settings } from './Settings.js';\nexport const panel = settings;\n",
    'src/app/Shell.js': "import { panel } from '../ui/Panel.js';\nexport const shell = panel;\n",
    'src/help/Page.js': "import { shell } from '../app/Shell.js';\nexport const page = shell;\n",
  };
  for (const [name, text] of Object.entries(files)) {
    await fsp.mkdir(path.join(root, path.dirname(name)), { recursive: true });
    await fsp.writeFile(path.join(root, name), text);
  }
});

after(cleanUp);

/**
 * @param {{title: string, channel?: any, kind?: any, paths?: string[], nearFiles?: string[], count?: number}} f
 * @returns {any}
 */
function finding(f) {
  const paths = f.paths ?? ['screen.home.thing.name'];
  const one = {
    title: f.title,
    id: f.title.slice(0, 12).replace(/\W+/g, ''),
    why: 'Not yet worked out.',
    class: 'ordinary',
    rank: 0,
    count: f.count ?? paths.length,
    signature: f.title,
    differences: paths.map((p) => ({
      path: p,
      channel: f.channel ?? 'meaning',
      kind: f.kind ?? 'changed',
      reference: 'a',
      candidate: 'b',
      journey: 'the shop opens',
      distance: 1,
    })),
  };
  return f.nearFiles ? { ...one, nearFiles: f.nearFiles } : one;
}

describe('what comes first', () => {
  test('a change far from the edit outranks one inside it', async () => {
    const inside = finding({ title: 'The settings heading is now called Preferences.', nearFiles: ['src/ui/Settings.js'] });
    const faraway = finding({ title: 'The help page no longer shows its heading.', nearFiles: ['src/help/Page.js'] });

    const out = await rankFindings([inside, faraway], { cwd: root, changed: edited() });
    assert.equal(out.findings[0].title, faraway.title, 'the one nobody was working on is the suspicious one, and it goes first');
    assert.equal(out.findings.length, 2, 'ranking orders findings, it never drops any');
  });

  test('the order does not depend on the order they arrived in', async () => {
    const inside = finding({ title: 'The settings heading is now called Preferences.', nearFiles: ['src/ui/Settings.js'] });
    const faraway = finding({ title: 'The help page no longer shows its heading.', nearFiles: ['src/help/Page.js'] });

    const one = await rankFindings([inside, faraway], { cwd: root, changed: edited() });
    const two = await rankFindings([faraway, inside], { cwd: root, changed: edited() });
    assert.deepEqual(
      one.findings.map((/** @type {any} */ f) => f.title),
      two.findings.map((/** @type {any} */ f) => f.title)
    );
  });

  test('every finding says in plain words why it sorted where it did', async () => {
    const inside = finding({ title: 'The settings heading is now called Preferences.', nearFiles: ['src/ui/Settings.js'] });
    const faraway = finding({ title: 'The help page no longer shows its heading.', nearFiles: ['src/help/Page.js'] });

    const out = await rankFindings([inside, faraway], { cwd: root, changed: edited() });
    for (const one of out.findings) {
      assert.ok(typeof one.why === 'string' && one.why.trim().split(/\s+/).length >= 6, `"${one.why}" is not an explanation`);
    }
    const near = /** @type {any} */ (out.findings.find((f) => f.title === inside.title));
    assert.match(near.why, /you just changed|you meant to do/i, 'the one inside the edit has to say so, or its low place looks arbitrary');
    const far = /** @type {any} */ (out.findings.find((f) => f.title === faraway.title));
    assert.match(far.why, /side effect|steps away|unknown/i);
  });

  test('with nothing edited it says so and still returns everything', async () => {
    const findings = [finding({ title: 'The help page no longer shows its heading.' }), finding({ title: 'The settings heading changed.' })];
    const out = await rankFindings(findings, { cwd: root, changed: { ok: true, files: [], untracked: [], hunks: [], patch: '', root, base: 'HEAD', committed: false } });
    assert.equal(out.findings.length, 2, 'not knowing what was edited makes ranking weaker, never destructive');
    assert.ok(
      out.notes.some((/** @type {string} */ n) => /nothing in the working tree has changed/i.test(n)),
      'and it has to say that out loud, because a reader will otherwise read the order as meaningful'
    );
  });

  test('it reports which files it treated as your edit', async () => {
    const out = await rankFindings([finding({ title: 'Something changed somewhere.' })], { cwd: root, changed: edited() });
    assert.deepEqual(out.youChanged, ['src/ui/Settings.js']);
  });
});

describe('the classes no agent may wave through', () => {
  /** @param {any} f */
  const classOfPlain = (f) => classOf(f, []);

  test('a crash outranks everything, even sitting inside the edit', async () => {
    const faraway = finding({ title: 'The help page no longer shows its heading.', nearFiles: ['src/help/Page.js'] });
    const crash = finding({
      title: 'The app crashed on the way to settings.',
      channel: 'complaints',
      paths: ['log.main.crash'],
      nearFiles: ['src/ui/Settings.js'],
    });

    // Handed in LAST and sitting in the very file that was edited — the two
    // things that would otherwise push it to the bottom.
    const out = await rankFindings([faraway, crash], { cwd: root, changed: edited() });
    assert.equal(out.findings[0].title, crash.title);
    assert.equal(out.findings[0].sealed, true, 'a sealed finding has to say so, or nobody downstream can enforce it');
    assert.equal(out.findings[0].class, 'crash');
  });

  test('money is sealed', () => {
    assert.equal(
      classOfPlain(finding({ title: 'A charge is now sent for a different amount.', channel: 'effects', paths: ['net.POST./v1/charges.amount'] })),
      'money'
    );
  });

  test('signing in is sealed', () => {
    assert.equal(
      classOfPlain(finding({ title: 'Logging in no longer stores an access token.', channel: 'effects', paths: ['store.session.token'] })),
      'sign-in'
    );
  });

  test('losing data is sealed', () => {
    assert.equal(
      classOfPlain(finding({ title: 'The tidy-up now runs a delete from the sessions table.', channel: 'effects', paths: ['net.POST./sql.text'] })),
      'data-loss'
    );
  });

  test('a bug already reported once is sealed by the guard that was written for it', () => {
    const f = finding({ title: 'This should still be true, and it is not: the sidebar still collapses.' });
    assert.equal(classOf(f, ['the sidebar still collapses']), 'guard');
    assert.equal(classOf(f, []), 'ordinary', 'without the guard there is nothing to recognise it by');
  });

  test('an ordinary finding is not sealed and does not pretend to be', () => {
    assert.equal(classOfPlain(finding({ title: 'The footer year is now 2027 where it was 2026.' })), 'ordinary');
  });

  test('a Delete button changing colour is not a data-loss incident', () => {
    // The softer words only seal when something actually went out or came back.
    // Sealing this would send an ordinary run to a person, and a safety net that
    // cries wolf is one nobody looks at.
    assert.equal(
      classOfPlain(finding({ title: 'The Delete button is now red where it was grey.', channel: 'meaning', paths: ['screen.settings.button:Delete.colour'] })),
      'ordinary'
    );
  });

  test('everything sealed comes before anything that is not', async () => {
    const ordinary = finding({ title: 'The footer year changed.', nearFiles: ['src/help/Page.js'] });
    const crash = finding({ title: 'The app crashed while opening.', channel: 'complaints', paths: ['log.main.crash'] });
    const charge = finding({ title: 'A payment is now sent twice.', channel: 'effects', paths: ['net.POST./v1/charges.count'] });

    const out = await rankFindings([ordinary, crash, charge], { cwd: root, changed: edited() });
    assert.equal(out.findings[0].sealed, true);
    assert.equal(out.findings[1].sealed, true);
    assert.equal(out.findings[2].sealed, false);
  });
});

describe('clustering hands straight to ranking', () => {
  test('what one produces is what the other takes, with nothing in between', async () => {
    // The two halves are built separately, so this is the seam most likely to
    // drift. If it ever breaks, every finding reaches the agent unranked and the
    // whole "read the first two" promise is gone.
    const differences = [
      { path: 'log.main.crash', channel: 'complaints', kind: 'appeared', candidate: 'TypeError: undefined is not a function', journey: 'the shop opens', distance: 1 },
      { path: 'screen.home.heading.name', channel: 'meaning', kind: 'changed', reference: 'Your shop', candidate: 'Your store', journey: 'the shop opens', distance: 1 },
    ];
    const clustered = clusterDifferences(/** @type {any} */ (differences), { sources: { 'screen.home.heading.name': 'src/ui/Settings.js' } });
    const out = await rankFindings(/** @type {any} */ (clustered), { cwd: root, changed: edited() });

    assert.equal(out.findings.length, 2);
    assert.equal(out.findings[0].class, 'crash', 'the crash has to come out on top of a straight cluster-then-rank');
    for (const one of out.findings) {
      assert.notEqual(one.why, 'Not yet worked out.', 'ranking has to replace the placeholder sentence clustering leaves behind');
      assert.equal(typeof one.rank, 'number');
    }
  });
});


describe('what the tool wrote about your project is never part of your project', () => {
  test('the store this tool writes on every run is not counted as something you changed', async () => {
    // The whole design rests on two runs of unchanged source being the same build. The
    // fingerprint was taught to ignore .staysfixed; the distance measure reads the same two
    // git calls and was not, so the tool's own output was one of the places the walk out
    // from "your edit" started, and a clean tree never got the sentence saying it was clean.
    const dir = await repoWith({ 'src/a.js': 'export const a = 1;\n' });
    await fsp.mkdir(path.join(dir, '.staysfixed', 'v2', 'builds', 'work-abc'), { recursive: true });
    await fsp.writeFile(path.join(dir, '.staysfixed', 'v2', 'builds', 'work-abc', 'build.json'), '{"x":1}\n');

    const changed = await whatChanged(dir);
    assert.deepEqual(changed.files, [], 'nothing tracked was edited');
    assert.deepEqual(changed.untracked, [], "the tool's own folder is not an edit somebody made");

    const out = await rankFindings([finding({ title: 'The footer year changed.' })], { cwd: dir });
    assert.deepEqual(out.youChanged, [], 'a person must never be shown .staysfixed as a file they edited');
    assert.ok(
      out.notes.some((/** @type {string} */ n) => /nothing in the working tree has changed/i.test(n)),
      'a genuinely clean tree has to be told it is clean, and it never was while the store counted as an edit'
    );
  });

  test('a real edit is still found beside it', async () => {
    const dir = await repoWith({ 'src/a.js': 'export const a = 1;\n' });
    await fsp.writeFile(path.join(dir, 'src/a.js'), 'export const a = 2;\n');
    await fsp.mkdir(path.join(dir, '.staysfixed', 'v2'), { recursive: true });
    await fsp.writeFile(path.join(dir, '.staysfixed', 'v2', 'notes.json'), '{}\n');

    const changed = await whatChanged(dir);
    assert.deepEqual(changed.files, ['src/a.js']);
    assert.deepEqual(changed.untracked, []);
    assert.equal(changed.hunks.length, 1, 'excluding the store must not cost the real diff');
  });

  test('run from a subfolder, new files still come back under a path that exists', async () => {
    // `git diff` answers for the whole repository wherever it runs; `git ls-files --others`
    // lists only what is under the folder it was run in, and names it relative to that
    // folder. Asked from a subfolder, this used to hand back "new.js" — which resolves
    // against the repository root to a file that is not there — and never mentioned an
    // untracked file anywhere else at all.
    const dir = await repoWith({ 'src/a.js': 'export const a = 1;\n' });
    await fsp.writeFile(path.join(dir, 'src', 'new.js'), 'export const n = 1;\n');
    await fsp.writeFile(path.join(dir, 'top.js'), 'export const t = 1;\n');

    const changed = await whatChanged(path.join(dir, 'src'));
    assert.deepEqual([...changed.untracked].sort(), ['src/new.js', 'top.js']);
    for (const file of changed.untracked) {
      await fsp.stat(path.resolve(changed.root, file));
    }
  });
});

describe('the three ways of not knowing where a finding lives', () => {
  test('a journey too broad to place a finding says that, not "nothing says"', async () => {
    // A journey through four hundred files touches everything, so it is refused as evidence
    // of where a finding lives — rightly. What it said afterwards was untrue: "nothing says
    // which code this comes from", when in fact plenty did and all of it was too broad.
    const touches = { 'the shop opens': Array.from({ length: 40 }, (_, i) => `src/ui/File${i}.js`) };
    const out = await rankFindings([finding({ title: 'Something changed somewhere.' })], {
      cwd: root,
      changed: edited(),
      touches,
    });
    assert.match(out.findings[0].why, /goes through 40 files/);
    assert.doesNotMatch(out.findings[0].why, /^Nothing says which code/);
  });

  test('with nothing to go on at all it still says nothing says', async () => {
    const out = await rankFindings([finding({ title: 'Something changed somewhere.' })], { cwd: root, changed: edited() });
    assert.match(out.findings[0].why, /Nothing says which code this comes from/);
  });
});

describe('a value nobody can read is not a value with nothing in it', () => {
  /** @param {unknown} value */
  const withValue = (value) => ({
    ...finding({ title: 'Something came back different.' }),
    differences: [{ path: 'net.POST./x.body', channel: 'effects', kind: 'changed', reference: 'before', candidate: value, journey: 'the shop opens', distance: 1 }],
  });

  test('a value that will not turn into text is reported, not spent as nothing-found', async () => {
    // A value holding a loop threw inside JSON.stringify, came back as the empty string, and
    // was searched alongside the real ones. Nothing matched, so the finding was filed
    // ordinary — which is precisely the class an agent may wave through on its own.
    /** @type {any} */
    const loop = { name: 'charges' };
    loop.self = loop;

    /** @type {string[]} */
    const blind = [];
    const klass = classOf(/** @type {any} */ (withValue(loop)), [], (what) => blind.push(what));
    assert.equal(klass, 'ordinary', 'it genuinely could not find anything, and it must not invent a class');
    assert.equal(blind.length, 1, 'and it has to say it could not look');
    assert.match(blind[0], /could not be read as text/i);

    const out = await rankFindings([/** @type {any} */ (withValue(loop))], { cwd: root, changed: edited() });
    assert.ok(
      out.notes.some((/** @type {string} */ n) => /could not be read as text/i.test(n)),
      'and the note has to reach whoever reads the run'
    );
  });

  test('a value that really has no words in it is not reported as unreadable', async () => {
    /** @type {string[]} */
    const blind = [];
    classOf(/** @type {any} */ (withValue(undefined)), [], (what) => blind.push(what));
    assert.deepEqual(blind, [], 'undefined has no words in it and that is a true answer, not a failure');
  });

  test('a BigInt is still searched, because it can still be read', async () => {
    /** @type {string[]} */
    const blind = [];
    const klass = classOf(/** @type {any} */ (withValue(12n)), ['12'], (what) => blind.push(what));
    assert.deepEqual(blind, []);
    assert.equal(klass, 'guard', 'JSON cannot hold it, but String can, so the guard still catches it');
  });
});

describe('a folder the distance measure cannot open', () => {
  test('everything behind it is missing from the graph, and it says so', async () => {
    const dir = await scratchDir('staysfixed-rank-shut');
    await fsp.mkdir(path.join(dir, 'src', 'open'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'src', 'locked'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'src', 'open', 'a.js'), 'export const a = 1;\n');
    await fsp.writeFile(path.join(dir, 'src', 'locked', 'b.js'), 'export const b = 1;\n');
    await fsp.chmod(path.join(dir, 'src', 'locked'), 0o000);
    try {
      const graph = await importGraph(dir);
      // Unavoidable: it cannot be read. What was avoidable was doing it without a word, and
      // a folder is not one file — it is a whole branch of somebody's product.
      assert.ok(!graph.files.some((f) => f.endsWith(`${path.sep}b.js`)), 'the fixture has to actually be unreadable, or this proves nothing');
      assert.equal(graph.unreadableDirs.length, 1);
      assert.match(graph.unreadableDirs[0], /locked/);

      const out = await rankFindings([finding({ title: 'Something changed somewhere.' })], {
        cwd: dir,
        changed: { ok: true, files: ['src/open/a.js'], untracked: [], hunks: [], patch: '', root: dir, base: 'HEAD', committed: false },
      });
      assert.ok(
        out.notes.some((/** @type {string} */ n) => /could not be opened for the distance measure/i.test(n) && /folder/i.test(n)),
        'the run has to carry the fact that a whole folder is missing from the measure'
      );
    } finally {
      await fsp.chmod(path.join(dir, 'src', 'locked'), 0o755).catch(() => {});
    }
  });
});


describe('a change that has been committed is still a change', () => {
  /**
   * The shape an agent actually leaves behind: the reference is a shipped build, which is a
   * commit, and the agent committed its work before asking whether it broke anything.
   * @returns {Promise<{dir: string, reference: string}>}
   */
  async function committedEdit() {
    const dir = await repoWith({ 'src/a.js': 'export const a = 1;\n' });
    const reference = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    await fsp.writeFile(path.join(dir, 'src', 'a.js'), 'export const a = 2;\n');
    await run('git', ['add', '-A'], { cwd: dir });
    await run('git', ['commit', '-qm', 'the change'], { cwd: dir });
    return { dir, reference };
  }

  test('told which commit the old build is at, it finds the change and measures from it', async () => {
    const { dir, reference } = await committedEdit();
    const changed = await whatChanged(dir, { since: reference });
    assert.deepEqual(changed.files, ['src/a.js']);
    assert.equal(changed.hunks.length, 1, 'a committed change still has to produce a hunk, or nothing can be undone to prove a cause');
    assert.equal(changed.committed, true);
    assert.equal(changed.base, reference, 'the patch only applies to a checkout of the commit it was measured from, so it has to say which');
  });

  test('the ordering works off it, instead of saying there is no edit', async () => {
    const { dir, reference } = await committedEdit();
    const one = finding({ title: 'A link is called something else now.', nearFiles: ['src/a.js'] });

    const blind = await rankFindings([one], { cwd: dir });
    // The old behaviour, kept as the "without" half of the proof. It is still what happens
    // when nobody names the reference commit — but the sentence no longer claims more than
    // it looked at.
    assert.match(blind.findings[0].why, /nothing here looked at what may already be committed/i);

    const seeing = await rankFindings([one], { cwd: dir, since: reference });
    assert.match(seeing.findings[0].why, /in a file you just changed/i);
    assert.deepEqual(seeing.youChanged, ['src/a.js']);
  });

  test('with the same commit on both sides and a clean tree, nothing has changed is true', async () => {
    const { dir } = await committedEdit();
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    const out = await rankFindings([finding({ title: 'Something changed somewhere.' })], { cwd: dir, since: head });
    assert.ok(
      out.notes.some((/** @type {string} */ n) => /not in a commit and not in the working tree/i.test(n)),
      'this is the one case where "nothing has changed" is a claim the code is entitled to make'
    );
  });

  test('a reference commit this checkout does not have is said out loud, not shrugged off', async () => {
    const { dir } = await committedEdit();
    const out = await rankFindings([finding({ title: 'Something changed somewhere.' })], {
      cwd: dir,
      since: '0'.repeat(40),
    });
    assert.ok(
      out.notes.some((/** @type {string} */ n) => /not in this checkout/i.test(n)),
      'falling back to the working tree alone changes what every number below means'
    );
  });
});
