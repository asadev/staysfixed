/**
 * Clustering — five hundred differences with three causes must arrive as three
 * things to look at, not five hundred.
 *
 * This is the layer that decides whether the tool is usable at all. An agent
 * handed five hundred lines spends its whole context reading them and then does
 * the wrong thing; handed three sentences it fixes the code. Renaming one label
 * that appears on every page is ONE change, and it has to read like one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  clusterDifferences, findRenames, signatureOf, smartLeaf, describeValue,
  describe as describeDifference,
} from '../../src/v2/cluster.js';

/**
 * @param {string} path
 * @param {any} channel
 * @param {any} kind
 * @param {unknown} reference
 * @param {unknown} candidate
 * @returns {any}
 */
function difference(path, channel, kind, reference, candidate) {
  /** @type {any} */
  const d = { path, channel, kind, journey: 'the shop opens', distance: 1 };
  if (reference !== undefined) d.reference = reference;
  if (candidate !== undefined) d.candidate = candidate;
  return d;
}

/**
 * Five hundred real-shaped differences with exactly three causes behind them:
 * one word changed in a shared component, one header added to every outgoing
 * call, and a set of routes that stopped existing.
 *
 * @returns {any[]}
 */
function fiveHundred() {
  /** @type {any[]} */
  const list = [];
  for (let i = 0; i < 300; i++) {
    list.push(difference(`screen.page-${i}.button:Save.name`, 'meaning', 'changed', 'Save', 'Store'));
  }
  for (let i = 0; i < 180; i++) {
    list.push(difference(`net.GET./thing-${i}.header:x-trace`, 'effects', 'appeared', undefined, 'on'));
  }
  for (let i = 0; i < 20; i++) {
    list.push(difference(`route.GET./billing/${i}.exists`, 'contract', 'vanished', true, undefined));
  }
  return list;
}

describe('many differences, few findings', () => {
  test('five hundred differences become a handful', () => {
    const findings = clusterDifferences(fiveHundred());
    assert.ok(
      findings.length <= 10,
      `five hundred differences with three causes should come back as a handful, and this came back as ${findings.length}`
    );
    assert.ok(findings.length >= 3, 'three genuinely different causes must not be squashed into fewer');
  });

  test('nothing is lost on the way', () => {
    const all = fiveHundred();
    const findings = clusterDifferences(all);
    const covered = new Set();
    for (const finding of findings) for (const d of finding.differences) covered.add(d.path);
    assert.equal(
      covered.size,
      all.length,
      'a difference that vanishes during clustering is a regression nobody will ever be told about'
    );
  });

  test('each finding counts how many places it stands for', () => {
    const findings = clusterDifferences(fiveHundred());
    const total = findings.reduce((/** @type {number} */ sum, /** @type {any} */ f) => sum + f.count, 0);
    assert.equal(total, 500);
  });

  test('the same input twice gives the same list in the same order', () => {
    // Two runs that found the same things must hand back the same list, or a
    // waiver pinned to a finding id stops matching the thing it was written for.
    const first = clusterDifferences(fiveHundred()).map((/** @type {any} */ f) => f.id);
    const second = clusterDifferences(fiveHundred()).map((/** @type {any} */ f) => f.id);
    assert.deepEqual(first, second);
  });

  test('each finding says what happened in a plain sentence', () => {
    for (const finding of clusterDifferences(fiveHundred())) {
      assert.equal(typeof finding.title, 'string');
      assert.ok(finding.title.trim().split(/\s+/).length >= 4, `"${finding.title}" is not a sentence`);
      assert.doesNotMatch(
        finding.title,
        /\b(assert|expect|toBe|snapshot|testid|data-test|regex)\b/i,
        'findings are read by people and by agents deciding what to spend tokens on; no test jargon'
      );
    }
  });

  test('two differences with nothing in common are never merged', () => {
    const findings = clusterDifferences([
      difference('log.main.crash', 'complaints', 'appeared', undefined, 'TypeError: cannot read properties of undefined'),
      difference('screen.settings.heading.name', 'meaning', 'changed', 'Settings', 'Preferences'),
    ]);
    assert.equal(findings.length, 2, 'a crash and a renamed heading are two problems, not one');
  });

  test('one difference is one finding, and it still reads properly', () => {
    const findings = clusterDifferences([difference('cli.build.exit', 'results', 'changed', 0, 1)]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].count, 1);
    assert.equal(findings[0].differences.length, 1, 'a finding carries its own evidence, so nobody has to fetch anything');
  });

  test('nothing in, nothing out', () => {
    assert.deepEqual(clusterDifferences([]), []);
  });

  test('a finding points at the source file when it can', () => {
    const findings = clusterDifferences([difference('cli.build.exit', 'results', 'changed', 0, 1)], {
      sources: { 'cli.build.exit': 'src/build/run.js' },
    });
    assert.deepEqual(findings[0].nearFiles, ['src/build/run.js'], 'without this, ranking cannot tell how far it is from the edit');
  });
});

describe('a rename is one change, not two', () => {
  test('one address gone and one arrived with the same value is a rename', () => {
    const differences = [
      difference('screen.home.actions.Save', 'meaning', 'vanished', 'on', undefined),
      difference('screen.home.actions.Store', 'meaning', 'appeared', undefined, 'on'),
    ];
    const renames = findRenames(differences);
    assert.equal(renames.size, 2, 'both halves of the pair know they are a rename');

    const findings = clusterDifferences(differences);
    assert.equal(findings.length, 1, 'and they arrive as one thing to look at');
    assert.equal(findings[0].count, 1, 'one rename is one place, not two rows');
    assert.match(findings[0].title, /Save.*Store/, 'the sentence names both the old and the new name');
  });

  test('two gone and two arrived is a rewrite, and guessing the pairs would be fiction', () => {
    const renames = findRenames([
      difference('screen.home.actions.Save', 'meaning', 'vanished', 'on', undefined),
      difference('screen.home.actions.Cancel', 'meaning', 'vanished', 'on', undefined),
      difference('screen.home.actions.Store', 'meaning', 'appeared', undefined, 'on'),
      difference('screen.home.actions.Back', 'meaning', 'appeared', undefined, 'on'),
    ]);
    assert.equal(renames.size, 0);
  });

  test('one gone and one arrived holding DIFFERENT values is two unrelated edits', () => {
    const renames = findRenames([
      difference('screen.home.actions.Save', 'meaning', 'vanished', 'on', undefined),
      difference('screen.home.actions.Store', 'meaning', 'appeared', undefined, 'off'),
    ]);
    assert.equal(renames.size, 0, 'they landed side by side; that is not the same as one becoming the other');
  });
});

describe('the sentence has to name something', () => {
  /**
   * One real address of every shape the adapters produce, and the half of it a reader can
   * act on. Written out rather than derived, because the point is to notice when a new
   * adapter ends an address in a word that is the same on every journey in the product.
   *
   * @type {[string, string][]}
   */
  const shapes = [
    // Doors, from the source reader. Every one of them used to come back as the word the
    // tool wrote — "declared" — with the route, the command or the channel one segment to
    // the left, unread. A renamed route reported as "declared is gone".
    ['route.ANY./notes.declared', '/notes'],
    ['ipc.session:create.registered', 'session:create'],
    ['cli.build.declared', 'build'],
    ['export.src/help%2Ejs.renderHelp', 'renderHelp'],
    ['proc.env.PORT', 'PORT'],
    ['door.saveButton.declared', 'saveButton'],
    ['door.saveButton.reached', 'saveButton'],
    // What was asked of something, and what it answered.
    ['api.the shop opens.status', 'the shop opens'],
    ['api.the shop opens.body', 'the shop opens'],
    ['api.the shop opens.shape', 'the shop opens'],
    ['api.the shop opens.answered', 'the shop opens'],
    ['net.GET.api%2Eexample%2Ecom/orders.asked', 'api.example.com/orders'],
    ['cli.build.exit', 'build'],
    ['cli.build.stdout', 'build'],
    ['cli.build.ran at all', 'build'],
    ['screen.home.opened at all', 'home'],
    ['screen.home.picture', 'home'],
    ['screen.checkout.end.held still', 'end'],
    ['file.report%2Etxt.written', 'report.txt'],
    ['permission.NSCameraUsageDescription.reason', 'NSCameraUsageDescription'],
    // And the ones that already named something: a leaf the PRODUCT chose is left alone.
    ['screen.home.checkpoint 1.button:Save.enabled', 'button:Save'],
    ['screen.home.end.tree.under:Main.link:Docs', 'link:Docs'],
    ['api.the shop opens.header.content-type', 'content-type'],
    ['store.settings.theme.value', 'theme'],
  ];

  test('smartLeaf names the half a reader can act on', () => {
    for (const [address, names] of shapes) {
      assert.ok(
        smartLeaf(address).includes(names),
        `"${address}" reads as "${smartLeaf(address)}", which never mentions ${names}. A word this tool wrote is the same word on every journey in the product, so a sentence built out of it names nothing — and that sentence goes to a person, not only to an agent.`
      );
    }
  });

  test('a value made of fields reads as fields, not as prose', () => {
    // "a set of details (a list of, each one)" was a real sentence about the shape of a
    // reply. Nobody can picture it; the field names had run into the words around them.
    assert.equal(describeValue({ 'a list of': 3, 'each one': {} }), 'a set of details (2 fields: "a list of", "each one")');
    assert.equal(describeValue({ error: 'gone' }), 'a set of details (one field: "error")');
  });
});

describe('a sentence that says nothing changed, about a change', () => {
  test('when both sides summarise to the same words, it names the field that moved', () => {
    // The tool's own flagship example: a shared formatter is "improved" from £49.99 to
    // 49.99 GBP and the invoice printer three hops away still uses it. The ranking put the
    // forgotten corner first and sealed it as money — and the sentence it came with said
    // "is now a set of details (one field: line) where it was a set of details (one field:
    // line)". The same words on both sides of "where it was", in the paragraph a person
    // reads rather than an agent.
    const sentence = describeDifference(
      difference('api.GET /invoice.body', 'results', 'changed', { line: 'A desk lamp ......... £49.99' }, { line: 'A desk lamp ......... 49.99 GBP' }),
      1,
    );
    assert.match(sentence, /49\.99 GBP/, 'the sentence never said what the new value was');
    assert.match(sentence, /£49\.99/, 'the sentence never said what the old value was');
    assert.match(sentence, /"line"/, 'and it never named the field that moved');
  });

  test('two long pieces of text that agree at the start point at where they part', () => {
    const same = 'row '.repeat(30);
    const sentence = describeDifference(
      difference('cli.report.stdout', 'results', 'changed', `${same}total 10.00`, `${same}total  0.00`),
      1,
    );
    assert.match(sentence, /total {2}0\.00/);
    assert.match(sentence, /total 10\.00/);
  });

  test('when the two sides really do read differently, nothing changes', () => {
    const sentence = describeDifference(difference('screen.checkout.total', 'meaning', 'changed', 10, 9.99), 1);
    assert.equal(sentence, 'On screen, "total" is now 9.99 where it was 10.');
  });
});

describe('what a finding carries with it', () => {
  test('every address is on the finding, not the first twenty', () => {
    /** @type {any[]} */
    const differences = [];
    for (let i = 0; i < 300; i++) {
      differences.push(difference(`screen.page-${i}.button:Save.name`, 'meaning', 'changed', 'Save', 'Store'));
    }
    const [finding] = clusterDifferences(differences);
    assert.equal(finding.count, 300);
    assert.equal(
      (finding.paths ?? []).length,
      300,
      'the reply an agent reads prints the length of this list under "every address that moved", and a waiver is pinned partly to it'
    );
  });
});

describe('the grouping key', () => {
  test('row numbers and ids do not make two hundred rows into two hundred findings', () => {
    const one = difference('screen.table.row-1.name', 'meaning', 'changed', 'a', 'b');
    const two = difference('screen.table.row-947.name', 'meaning', 'changed', 'a', 'b');
    assert.equal(signatureOf(one), signatureOf(two));
  });

  test('but a different move from one value to another is a different finding', () => {
    const one = difference('screen.table.row-1.name', 'meaning', 'changed', 'a', 'b');
    const two = difference('screen.table.row-2.name', 'meaning', 'changed', 'a', 'c');
    assert.notEqual(signatureOf(one), signatureOf(two));
  });

  test('a vague last word is read together with the one before it', () => {
    // "enabled" tells a reader nothing. "button:Save / enabled" tells them everything.
    const sentence = describeDifference(difference('screen.settings.button:Save.enabled', 'meaning', 'changed', true, false), 1);
    assert.match(sentence, /button:Save/);
  });
});
