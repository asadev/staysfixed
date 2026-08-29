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

import { rankFindings, classOf } from '../../src/v2/rank.js';
import { clusterDifferences } from '../../src/v2/cluster.js';
import { scratchDir, cleanUp } from '../support.mjs';

/** A little project on disk, so distance is measured through real imports rather than mocked. */
let root = '';

/** What git would have told us, handed in directly so no test depends on a repository. */
function edited() {
  return { ok: true, files: ['src/ui/Settings.js'], untracked: [], hunks: [], patch: '', root };
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
    const out = await rankFindings(findings, { cwd: root, changed: { ok: true, files: [], untracked: [], hunks: [], patch: '', root } });
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
