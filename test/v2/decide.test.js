/**
 * Where the approval line sits, tested at the line itself.
 *
 * The engine finds differences; this is the layer that decides who gets to say a difference
 * is fine. Every assertion below is about the same worry: an agent under pressure to finish
 * declares the real regression intended, and the reason it writes reads perfectly plausible.
 * The four gates exist to make that particular sentence impossible to write rather than
 * merely discouraged, so each one is exercised as an agent would meet it — through the MCP
 * tool, in the exact words the refusal comes back in.
 *
 * WHY THE REFUSAL WORDING IS ASSERTED AND NOT ONLY THE REFUSAL. A gate that says no in a way
 * nobody can act on gets worked around. An agent told "refused" tries again with different
 * words; an agent told "this is outside what you sealed, seal a new intent that names it"
 * does the right thing. The sentence is the feature.
 *
 * Nothing here runs a product. The findings are written by hand, because what is being
 * tested is the arithmetic and the gates, and driving a real build to produce a money
 * difference would test the adapters instead and take a hundred times as long.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { openStore, ensureStore, saveBuild, setReference } from '../../src/v2/store.js';
import {
  WAIVER_BUDGET,
  decide,
  escalationBlock,
  escalationsFor,
  readCheckRecord,
  readDecisions,
  rememberCheck,
  writeEscalations,
} from '../../src/v2/escalate.js';
import { fingerprintFinding, waiverFor, waiversFile } from '../../src/v2/waiver.js';
import { clusterDifferences } from '../../src/v2/cluster.js';
import { sealIntent } from '../../src/v2/intent.js';
import { cutReference, referenceHistory } from '../../src/v2/reference.js';
import { callTool } from '../../src/v2/mcp/tools.js';
import { scratchDir, cleanUp } from '../support.mjs';

after(cleanUp);

const PRODUCT = 'demo';

/**
 * A project with a store in it and nothing else. No git repository on purpose: an intent
 * sealed outside one has to work and has to say what it cannot prove.
 *
 * @returns {Promise<{root: string, store: import('../../src/v2/types.js').Store, ctx: any}>}
 */
async function project() {
  const root = await scratchDir('staysfixed-decide');
  await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: PRODUCT, version: '1.0.0' }));
  const store = openStore({ root });
  await ensureStore(store);
  return { root, store, ctx: { root, cwd: root, version: '2.0.0-test', protocolVersion: '2025-06-18' } };
}

/**
 * One finding, in the shape the engine hands over after ranking.
 *
 * @param {{title: string, cls?: string, path?: string, was?: string, now?: string, near?: string[], distance?: number}} what
 * @returns {any}
 */
function finding(what) {
  const where = what.path ?? 'cli.help.out';
  const difference = {
    path: where,
    channel: 'results',
    kind: 'changed',
    reference: what.was ?? 'before',
    candidate: what.now ?? 'after',
    distance: 0.2,
  };
  return {
    id: 'engine-' + where,
    title: what.title,
    why: '',
    class: what.cls ?? 'ordinary',
    sealed: (what.cls ?? 'ordinary') !== 'ordinary',
    rank: 1,
    differences: [difference],
    paths: [where],
    sample: difference,
    count: 1,
    nearFiles: what.near ?? [],
    distance: what.distance ?? 1,
  };
}

/**
 * @param {any[]} findings
 * @param {{buildId?: string, unstable?: string[]}} [opts]
 * @returns {any}
 */
function verdictOver(findings, opts = {}) {
  return {
    runId: 'run-1',
    product: PRODUCT,
    ok: findings.length === 0,
    mode: 'paired',
    reference: { id: 'git-old', product: PRODUCT },
    candidate: { id: opts.buildId ?? 'work-new', product: PRODUCT },
    findings,
    differencesReal: findings.length,
    differencesNoise: 0,
    newlyUnstable: (opts.unstable ?? []).map((p) => ({ path: p, channel: 'results', kind: 'changed', distance: 0.5 })),
    coverage: { paths: 10, journeys: 1, byChannel: {}, gaps: [] },
    summary: 'Something changed.',
    durationMs: 1,
    startedAt: new Date().toISOString(),
  };
}

/**
 * Run the decision layer over some findings and write the record, exactly as `check` does
 * once the engine has finished ranking.
 *
 * @param {import('../../src/v2/types.js').Store} store
 * @param {any[]} findings
 * @param {{buildId?: string, unstable?: string[]}} [opts]
 * @returns {Promise<import('../../src/v2/escalate.js').Decided>}
 */
async function runCheckOver(store, findings, opts = {}) {
  const decisions = await readDecisions(store, PRODUCT);
  const decided = decide(findings, decisions);
  const verdict = verdictOver(decided.reported, opts);
  verdict.ok = decided.reported.length === 0 && verdict.newlyUnstable.length === 0;
  await rememberCheck(store, { product: PRODUCT, verdict, decided });
  return decided;
}

/**
 * Put waivers straight into the file, past the tool that would have judged them.
 *
 * Used for two things only: filling the budget without writing five plausible changes, and
 * proving that a waiver nobody should have been able to write still cannot hide a sealed
 * difference. A gate that lives only at the front door is a gate a text editor walks through.
 *
 * @param {import('../../src/v2/types.js').Store} store
 * @param {{fingerprint: string, reference: string, id?: string, why?: string}[]} waivers
 * @returns {Promise<void>}
 */
async function putWaivers(store, waivers) {
  const file = waiversFile(store, PRODUCT);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(
    file,
    JSON.stringify(
      waivers.map((w, i) => ({
        id: w.id ?? `waiver-hand-${i}`,
        product: PRODUCT,
        fingerprint: w.fingerprint,
        finding: '',
        summary: 'written straight into the file',
        paths: [],
        class: 'ordinary',
        why: w.why ?? 'written straight into the file',
        intentId: 'none',
        intentSummary: '',
        ordering: '',
        coverage: { covers: true, confidence: 'strong', why: '', matched: [] },
        at: new Date().toISOString(),
        reference: w.reference,
      })),
      null,
      2,
    ),
  );
}

/**
 * @param {any} result
 * @returns {string}
 */
function said(result) {
  return (result.content ?? []).map((/** @type {{text?: string}} */ c) => c.text ?? '').join('\n');
}

/**
 * @param {import('../../src/v2/types.js').Store} store
 * @param {string} title
 * @returns {Promise<string>}
 */
async function idOf(store, title) {
  const record = await readCheckRecord(store);
  const hit = record?.findings.find((f) => f.title === title);
  assert.ok(hit, `no finding called "${title}" was written down`);
  return hit.id;
}

// ---------------------------------------------------------------------------

describe('the four gates on a waiver', () => {
  test('GATE A — a sealed class is refused, and the refusal says which class and what to do instead', async () => {
    const { store, ctx } = await project();
    await runCheckOver(store, [finding({ title: 'The checkout total now says 9.99 where it said 10.00', cls: 'money', path: 'screen.checkout.total' })]);
    await sealIntent(store, { product: PRODUCT, summary: 'change the checkout total', files: ['screen.checkout.total'] });

    const id = await idOf(store, 'The checkout total now says 9.99 where it said 10.00');
    const reply = await callTool('staysfixed_waive', { finding: id, because: 'the new price is what I meant' }, ctx);

    assert.equal(reply.isError, true, 'a refused waiver has to come back as an error, or an agent skims past it');
    const text = said(reply);
    assert.match(text, /Refused/);
    assert.match(text, /money/, 'it has to name the class, so the agent can say which one to a person');
    assert.match(text, /asking again in different words will get the same answer/, 'it has to close the door rather than invite a retry');

    // And nothing was written down. A refusal that still records something is not a refusal.
    assert.equal((await readDecisions(store, PRODUCT)).live.length, 0);
  });

  test('GATE B — with no intent sealed at all, there is nothing to check the claim against', async () => {
    const { store, ctx } = await project();
    await runCheckOver(store, [finding({ title: 'The help text lost a line' })]);

    const reply = await callTool('staysfixed_waive', { finding: await idOf(store, 'The help text lost a line'), because: 'I meant that' }, ctx);
    assert.equal(reply.isError, true);
    assert.match(said(reply), /did not seal an intent before this run/);
    assert.equal((await readDecisions(store, PRODUCT)).live.length, 0);
  });

  test('GATE B — an intent sealed AFTER the check is refused, because it proves nothing', async () => {
    const { store, ctx } = await project();
    await runCheckOver(store, [finding({ title: 'The help text lost a line', near: ['src/help.js'], distance: 0 })]);

    // The order is the whole point. Sealing now, having seen what broke, is a
    // rationalisation written to fit the damage — which is exactly what reads plausible and
    // exactly what this gate exists to refuse.
    await sealIntent(store, { product: PRODUCT, summary: 'change the help text', files: ['src/help.js'] });

    const reply = await callTool('staysfixed_waive', { finding: await idOf(store, 'The help text lost a line'), because: 'I meant that' }, ctx);
    assert.equal(reply.isError, true);
    assert.match(said(reply), /sealed AFTER the check ran/);
    assert.match(said(reply), /Run the check again/, 'the way out has to be named, or the agent invents one');
    assert.equal((await readDecisions(store, PRODUCT)).live.length, 0);
  });

  test('GATE B — a difference outside what was sealed is refused, because that is what a side effect is', async () => {
    const { store, ctx } = await project();
    await sealIntent(store, { product: PRODUCT, summary: 'change the help text', files: ['src/help.js'] });
    await runCheckOver(store, [finding({ title: 'The sidebar no longer lists the recent files', path: 'screen.sidebar.items', near: ['src/sidebar/recent.js'], distance: 4 })]);

    const reply = await callTool('staysfixed_waive', { finding: await idOf(store, 'The sidebar no longer lists the recent files'), because: 'a knock-on of the help change' }, ctx);
    assert.equal(reply.isError, true);
    assert.match(said(reply), /outside what you sealed/);
    assert.match(said(reply), /seal a new intent that names it/, 'the honest route has to be offered, or the gate just looks arbitrary');
    assert.equal((await readDecisions(store, PRODUCT)).live.length, 0);
  });

  test('GATE C — the sixth waiver since the last ship is refused, whatever it is about', async () => {
    const { store, ctx } = await project();
    const stamp = (await readDecisions(store, PRODUCT)).stamp;
    await putWaivers(
      store,
      Array.from({ length: WAIVER_BUDGET }, (_, i) => ({ fingerprint: `spent-${i}`, reference: stamp, why: 'earlier in this same change' })),
    );

    await sealIntent(store, { product: PRODUCT, summary: 'change the help text', files: ['src/help.js'] });
    await runCheckOver(store, [finding({ title: 'The help text lost a line', near: ['src/help.js'], distance: 0 })]);

    const reply = await callTool('staysfixed_waive', { finding: await idOf(store, 'The help text lost a line'), because: 'I meant that too' }, ctx);
    assert.equal(reply.isError, true);
    assert.match(said(reply), /limit is 5/);
    assert.match(said(reply), /rewrite/, 'the reason for the limit has to be said, or it reads as an arbitrary number');
    assert.match(said(reply), /Sealing another intent will not give you more/, 'the obvious way round has to be closed in words');
    assert.equal((await readDecisions(store, PRODUCT)).live.length, WAIVER_BUDGET, 'and the refused one was not written down');
  });

  test('a waiver that passes all four gates is written down, counted, and drops the finding from the next run', async () => {
    const { store, ctx } = await project();
    await sealIntent(store, { product: PRODUCT, summary: 'change the help text', files: ['src/help.js'] });
    await runCheckOver(store, [finding({ title: 'The help text lost a line', near: ['src/help.js'], distance: 0 })]);

    const id = await idOf(store, 'The help text lost a line');
    const reply = await callTool('staysfixed_waive', { finding: id, because: 'I removed that line on purpose' }, ctx);
    assert.notEqual(reply.isError, true, said(reply));
    assert.match(said(reply), /4 of your 5 waivers left/);
    assert.match(said(reply), /not approval/i, 'a waiver must never be allowed to read as approval');

    // The next run over the same difference reports nothing — and says so out loud.
    const again = await runCheckOver(store, [finding({ title: 'The help text lost a line', near: ['src/help.js'], distance: 0 })]);
    assert.equal(again.reported.length, 0, 'the waived difference should not be reported again');
    assert.equal(again.waived.length, 1);
    assert.equal(again.accounting.waived, 1);
    assert.equal(again.accounting.expiredWaivers, 0, 'a waiver written a moment ago has not expired, and saying it has would be a lie in the summary');
    assert.equal(again.accounting.left, WAIVER_BUDGET - 1, 'the budget has to visibly go down, or an agent cannot see itself running out');
    assert.match(again.accounting.note, /recorded as intended/, 'silence has to be legible: the count is said in words');
    assert.equal(again.all.length, 1, 'and it is still on the record, so the waiver can be audited');
  });

  test('a sealed finding is never dropped by a waiver, even one hand-written into the file', async () => {
    const { store } = await project();
    const money = finding({ title: 'The refund amount changed', cls: 'money', path: 'api.POST./refund.body' });

    // Straight into the file, past the tool that would have refused it. A gate that lives
    // only at the front door is a gate that a text editor walks through.
    const decisions = await readDecisions(store, PRODUCT);
    await putWaivers(store, [{ id: 'waiver-forged', fingerprint: fingerprintFinding(money), reference: decisions.stamp }]);

    const after = await runCheckOver(store, [money]);
    assert.equal(after.reported.length, 1, 'a sealed finding must survive a waiver that should never have existed');
    assert.equal(after.waived.length, 0);
    assert.equal(after.reported[0].unwaivable, true);
  });
});

describe('what a waiver is pinned to', () => {
  /**
   * Three hundred rows of one screen, each holding its own long line of text. They arrive as
   * ONE finding because the grouping key is coarse on long values on purpose — two long
   * strings of about the same length are the same kind of change, not two hundred findings.
   *
   * @param {number} breakAt  Which row says something else. -1 for the run where none does.
   * @returns {any}
   */
  const threeHundredRows = (breakAt) => {
    const padding = '.'.repeat(80);
    /** @type {any[]} */
    const differences = [];
    for (let i = 0; i < 300; i += 1) {
      differences.push({
        path: `screen.orders.row-${i}.summary`,
        channel: 'meaning',
        kind: 'changed',
        reference: `row ${i}: was ${padding}`,
        candidate: `row ${i}: ${breakAt === i ? 'nil' : 'now'} ${padding}`,
        distance: 0.2,
      });
    }
    const findings = clusterDifferences(differences);
    assert.equal(findings.length, 1, 'the fixture is only worth anything while all three hundred stay one finding');
    return findings[0];
  };

  test('a value that changes past the fortieth address kills the waiver, wherever it sits', () => {
    const waivers = [{ fingerprint: fingerprintFinding(threeHundredRows(-1)), reference: 'ref-1' }];
    for (const row of [5, 41, 150, 299]) {
      assert.equal(
        waiverFor(/** @type {any} */ (waivers), threeHundredRows(row)),
        null,
        `row ${row} of 300 now says something else, and the old waiver went on covering it. Until 2026-08-30 only the first forty differences were pinned, so a break past the fortieth was filed as intended and nobody was ever shown it.`
      );
    }
  });

  test('the same three hundred values twice pin to the same thing, or no waiver would ever hold', () => {
    assert.equal(fingerprintFinding(threeHundredRows(-1)), fingerprintFinding(threeHundredRows(-1)));
  });

  test('a cluster that merely grew is a different pin', () => {
    /** @param {number} howMany @returns {any[]} */
    const rows = (/** @type {number} */ howMany) =>
      Array.from({ length: howMany }, (_, i) => ({
        path: `screen.orders.row-${i}.summary`,
        channel: 'meaning',
        kind: 'changed',
        reference: 'was',
        candidate: 'now',
        distance: 1,
      }));
    const small = clusterDifferences(rows(2));
    const grown = clusterDifferences(rows(3));
    assert.equal(small.length, 1);
    assert.equal(grown.length, 1);
    assert.notEqual(fingerprintFinding(small[0]), fingerprintFinding(grown[0]));
  });
});

describe('shipping is the only thing that says what working means', () => {
  test('a reference is cut by shipping, and every outstanding waiver dies with the move', async () => {
    const { store } = await project();
    await saveBuild(store, { id: 'work-new', product: PRODUCT });
    await sealIntent(store, { product: PRODUCT, summary: 'change the help text', files: ['src/help.js'] });
    await runCheckOver(store, [finding({ title: 'The help text lost a line', near: ['src/help.js'], distance: 0 })], { buildId: 'work-new' });

    const before = await readDecisions(store, PRODUCT);
    const ctx = { root: store.root, cwd: store.root, version: '2.0.0-test', protocolVersion: '2025-06-18' };
    const waived = await callTool(
      'staysfixed_waive',
      { finding: await idOf(store, 'The help text lost a line'), because: 'I removed that line on purpose' },
      ctx
    );
    assert.notEqual(waived.isError, true, said(waived));
    assert.equal((await readDecisions(store, PRODUCT)).live.length, 1, 'it should be live before the ship');

    // Nothing unaccounted for now, which is what makes the build shippable at all: a build
    // with differences nobody accounted for is REFUSED as a reference, and that refusal is
    // the difference between a safety net and a rubber stamp.
    await runCheckOver(store, [finding({ title: 'The help text lost a line', near: ['src/help.js'], distance: 0 })], { buildId: 'work-new' });

    // The one act that moves the line, and it is the act he already performs.
    const cut = await cutReference(store, { product: PRODUCT, build: 'work-new', why: '1.0.0 went out', setBy: 'ship-everywhere' });
    assert.ok(cut.buildId === 'work-new', 'the build that shipped is now what working means');

    const after = await readDecisions(store, PRODUCT);
    assert.equal(after.live.length, 0, 'every waiver written against the old reference has to stop covering anything');
    assert.equal(after.expired.length, 1);
    assert.equal(after.left, WAIVER_BUDGET, 'and the budget starts again, because this is a new change now');
    assert.notEqual(after.stamp, before.stamp, 'the stamp is what a waiver is pinned to, so it has to have moved');
  });

  test('six ships at once cut one reference, not several', async () => {
    // Measured on 2026-08-30 with six real `staysfixed ship` processes started together on
    // one project: all six reported success, FOUR of them each said "Nothing was being
    // compared against before this" because all four had read an empty reference and none
    // had seen the others, four records survived out of six, and the "already the reference,
    // change nothing" path — the one that stops a release script running twice from writing
    // history twice — never fired once. This is an MCP server; two agents shipping at the
    // same time is the design, and the file they race on is the one that defines what
    // "working" means.
    const { store } = await project();
    await saveBuild(store, { id: 'work-new', product: PRODUCT });
    await runCheckOver(store, [], { buildId: 'work-new' });

    const cuts = await Promise.all(
      Array.from({ length: 6 }, () =>
        cutReference(store, { product: PRODUCT, build: 'work-new', why: '1.0.0 went out', setBy: 'ship' }),
      ),
    );

    assert.equal(cuts.filter((c) => c.unchanged !== true).length, 1, 'exactly one of them may move what "working" means');
    assert.equal(cuts.filter((c) => c.unchanged === true).length, 5, 'and the other five have to say nothing changed');
    assert.equal((await referenceHistory(store, PRODUCT)).length, 1, 'one release, one entry in the history');
  });

  test('a waiver written before a ship no longer hides anything after it', async () => {
    const { store } = await project();
    await saveBuild(store, { id: 'work-new', product: PRODUCT });
    const one = finding({ title: 'The help text lost a line', near: ['src/help.js'], distance: 0 });

    const decisions = await readDecisions(store, PRODUCT);
    await putWaivers(store, [{ fingerprint: fingerprintFinding(one), reference: decisions.stamp }]);

    assert.equal((await runCheckOver(store, [one], { buildId: 'work-new' })).reported.length, 0, 'covered before the ship');

    await setReference(store, 'work-new', { product: PRODUCT, setBy: 'a person saying ship' });

    const after = await runCheckOver(store, [one], { buildId: 'work-new' });
    assert.equal(after.reported.length, 1, 'the reference moved, so the waiver covers nothing and the difference is reported again');
    assert.equal(after.accounting.waived, 0);
  });

  test('no agent has a tool that could move the reference', async () => {
    const { toolDefinitions } = await import('../../src/v2/mcp/tools.js');
    const names = toolDefinitions().map((t) => t.name);
    for (const forbidden of ['staysfixed_approve', 'staysfixed_reference', 'staysfixed_ship', 'staysfixed_accept']) {
      assert.ok(!names.includes(forbidden), `${forbidden} is on the tool list, so an agent can see a door to push on`);
    }
  });
});

describe('what reaches a person, and nothing else', () => {
  test('a sealed class reaches the escalation block, in three sentences, with no jargon', async () => {
    const { store } = await project();
    await runCheckOver(store, [
      finding({ title: 'The checkout total now says 9.99 where it said 10.00', cls: 'money', path: 'screen.checkout.total' }),
      finding({ title: 'The help text lost a line', near: ['src/help.js'], distance: 0 }),
    ]);

    const escalations = await escalationsFor(store, PRODUCT);
    assert.equal(escalations.items.length, 1, 'the ordinary difference is the agent\'s problem, not his');

    const item = escalations.items[0];
    assert.equal(item.kind, 'sealed');
    assert.match(item.what, /9\.99/);
    assert.match(item.why, /money/);
    assert.ok(item.todo.length > 20, 'an item with nothing to do about it is a notification, not a decision');
    for (const sentence of [item.what, item.why, item.todo]) {
      assert.ok(!/finding|fingerprint|verdict|waiver id|f-[0-9a-f]{6}/i.test(sentence), `this reads like a tool talking to itself: "${sentence}"`);
    }

    const block = escalationBlock(escalations);
    assert.match(block, /1 thing needs your word/);
    assert.ok(block.split('\n').length < 12, 'this goes inside a closing summary, so it has to be short enough to belong there');
    assert.ok(!block.includes('http'), 'it is a block of text, never a link to somewhere he has to go and look');
  });

  test('a clean run asks him for nothing, and says so in one line', async () => {
    const { store } = await project();
    await runCheckOver(store, []);
    const escalations = await escalationsFor(store, PRODUCT);
    assert.deepEqual(escalations.items, []);
    assert.equal(escalationBlock(escalations).split('\n').length, 1, 'nothing to decide is one sentence, not a report saying so');
    assert.match(escalationBlock(escalations), /nothing on demo needs your word/i);
  });

  test('a run that could not happen reaches him, because no answer must never look like a pass', async () => {
    const { store } = await project();
    const blocked = verdictOver([]);
    blocked.blocked = true;
    blocked.ok = false;
    blocked.summary = 'The check could not be run: no browser could be started.';
    await rememberCheck(store, { product: PRODUCT, verdict: blocked, decided: decide([], await readDecisions(store, PRODUCT)) });

    const escalations = await escalationsFor(store, PRODUCT);
    assert.equal(escalations.items.length, 1);
    assert.equal(escalations.items[0].kind, 'blocked');
    assert.match(escalations.items[0].why, /not a pass and not a failure/);
  });

  test('something that used to be predictable and is not any more reaches him, because no waiver can cover it', async () => {
    const { store } = await project();
    await runCheckOver(store, [], { unstable: ['cli.build.duration', 'api.GET./users.order'] });

    const escalations = await escalationsFor(store, PRODUCT);
    assert.equal(escalations.items.length, 1);
    assert.equal(escalations.items[0].kind, 'unpredictable');
    assert.match(escalations.items[0].what, /same answer every single run/);
  });

  test('the block can be written to a file for a release script to pick up', async () => {
    const { store, root } = await project();
    await runCheckOver(store, [finding({ title: 'Signing out no longer clears the session', cls: 'sign-in', path: 'api.POST./logout.body' })]);

    const written = await writeEscalations(store, PRODUCT, 'escalations.txt');
    assert.equal(written.count, 1);
    assert.equal(written.file, path.join(root, 'escalations.txt'));
    assert.match(await fsp.readFile(written.file, 'utf8'), /signing in/i);
  });

  test('a product nobody has checked says so, rather than saying nothing is wrong', async () => {
    const { store } = await project();
    const escalations = await escalationsFor(store, 'a-product-never-checked');
    assert.deepEqual(escalations.items, []);
    assert.match(escalations.note, /has not checked/, '"never looked" and "nothing wrong" must never read the same');
  });
});
