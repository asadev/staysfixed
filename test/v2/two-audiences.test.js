/**
 * One answer, two readers — and neither one handed the other's instructions.
 *
 * Stays Fixed has exactly two audiences: an agent calling MCP tools, and a person typing
 * commands. They are supposed to get the SAME TRUTH about the same product, in the words
 * each of them can act on. Until 2026-08-31 four of the seven tools had no command at all,
 * so the question never came up. The moment `coverage`, `explain`, `prove`, `waive` and
 * `intent` became commands, two seams opened, and both are held shut here.
 *
 * SEAM ONE — THE RECORD NAMED THE WRONG ACTOR. An intent sealed by a person at their own
 * terminal was written to `.staysfixed/v2/intents/<product>.json` as `"by": "an agent, over
 * MCP"`, because that string was a constant in the tool. Measured with a real
 * `staysfixed intent "..." --touches src/total.js` run on a scratch project. That record is
 * the thing a waiver is judged against months later, by somebody deciding whether "I meant
 * that" is worth anything — and a record naming the wrong actor is one nobody can use. The
 * same constant sat on waivers.
 *
 * SEAM TWO — MCP-ONLY INSTRUCTIONS PRINTED AT A PERSON. The same run signed off with "Now
 * run staysfixed_check." — the name of a tool the reader does not have, cannot type, and
 * will not find in `staysfixed --help`. `explain` offered `include: ["evidence"]`, `prove`
 * asked for `{ "revert": [...] }`, `coverage` sent them to `staysfixed_capabilities`, and a
 * refusal on a sealed class told them "No agent can wave this through … put it in front of a
 * person" when they were the person, sitting right there.
 *
 * AND THE MIRROR. An agent must never be handed a person's furniture either: no ANSI colour,
 * no drawn box, no "run this command" line where the reader cannot run commands. That sweep
 * is the last describe block.
 *
 * The rule every check below enforces: the words may change, the facts may not.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { callTool, loadEngine, voiceFor, renderCheck } from '../../src/v2/mcp/tools.js';
import { sayRefusal, classify } from '../../src/v2/sealed.js';
import { sealIntent } from '../../src/v2/intent.js';
import { openStore } from '../../src/v2/store.js';
import { cliPath, scratchDir, cleanUp } from '../support.mjs';

after(cleanUp);

/** The product name every fixture below uses. It is the folder's own basename. */
const PRODUCT = 'basket';

/**
 * Anything that only makes sense to an agent holding an MCP client.
 *
 * Each of these was measured in real person-facing output on 2026-08-31, so none of them is
 * a hypothetical: `staysfixed_check` closed the `intent` reply, `include: ["evidence"]` and
 * `include: ["pixels"]` closed `explain`, and `{ "revert": [...] }` was what `prove` asked
 * for when it was not given one.
 */
const AGENT_ONLY = [
  /staysfixed_[a-z]+/,
  /include:\s*\[/,
  /\{\s*"(finding|revert|because|summary|touches|detail|offset|limit)"/,
];

/**
 * A project on disk with a store in it, outside the repo.
 *
 * @param {string} label
 * @returns {Promise<{root: string, store: ReturnType<typeof openStore>}>}
 */
async function project(label) {
  const root = await scratchDir(`staysfixed-${label}`);
  const real = await fsp.realpath(root);
  await fsp.writeFile(path.join(real, 'package.json'), JSON.stringify({ name: PRODUCT, version: '1.0.0' }));
  await fsp.mkdir(path.join(real, 'src'), { recursive: true });
  await fsp.writeFile(path.join(real, 'src', 'total.js'), 'export const total = 10;\n');
  const store = openStore({ root: real });
  await fsp.mkdir(store.dir, { recursive: true });
  return { root: real, store };
}

/**
 * The context a tool call is handed, with only the audience varying.
 *
 * @param {string} root
 * @param {'agent'|'person'} [audience]
 * @returns {any}
 */
function ctxFor(root, audience) {
  const ctx = { root, cwd: root, version: '0.0.0-test', protocolVersion: '2025-06-18' };
  return audience ? { ...ctx, audience } : ctx;
}

/**
 * Everything a tool result said, as one string. Images carry no words, so only the text
 * parts are joined — which is also the only part either reader reads as a sentence.
 *
 * @param {any} result
 * @returns {string}
 */
function said(result) {
  return (result.content ?? [])
    .filter((/** @type {any} */ c) => c.type === 'text')
    .map((/** @type {any} */ c) => c.text)
    .join('\n');
}

/**
 * One finding, shaped the way the engine writes them into the check record.
 *
 * @param {Partial<any>} [over]
 * @returns {any}
 */
function finding(over = {}) {
  return {
    id: 'f-a1b2c3',
    fingerprint: 'fp-a1b2c3',
    title: 'the help text lost a line',
    class: 'ordinary',
    channel: 'results',
    paths: ['cli.help.out'],
    sample: { path: 'cli.help.out', reference: 'usage: basket', candidate: 'usage:' },
    distance: 0,
    ...over,
  };
}

/**
 * Write the record `explain`, `prove` and `waive` all read, without running a check.
 *
 * These three tools only ever read it back, so a fixture is the honest way to reach their
 * wording: running a real check to produce one finding would test the engine, which is not
 * what is in question here.
 *
 * @param {ReturnType<typeof openStore>} store
 * @param {any[]} findings
 * @param {string} [at]
 * @returns {Promise<void>}
 */
async function rememberACheck(store, findings, at) {
  await fsp.writeFile(
    path.join(store.dir, 'last-check.json'),
    JSON.stringify({
      at: at ?? new Date().toISOString(),
      product: PRODUCT,
      reference: 'no-reference-yet',
      verdict: 'differences found',
      findings,
      newlyUnstable: [],
      accounting: { reported: findings.length, waived: 0, unwaivable: 0, budget: 5, spent: 0 },
      result: { runId: 'run-test', ok: false },
    })
  );
}

/**
 * Run the real command line, the way a person does, and never throw on a non-zero exit.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function cli(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd, env: { ...process.env, NO_COLOR: '1' }, timeout: 120_000 },
      (error, stdout, stderr) => {
        const code = error && typeof (/** @type {any} */ (error).code) === 'number' ? /** @type {any} */ (error).code : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Seam one: the record of who did it
// ---------------------------------------------------------------------------

describe('a record names whoever actually made the call', () => {
  test('an intent sealed from the command line is not recorded as an agent', async () => {
    // The exact reproduction, run through the real binary: before the fix this file came
    // back holding "by": "an agent, over MCP" on a run nobody but a person had made.
    const { root, store } = await project('by-cli');
    const { code } = await cli(['intent', 'the basket total now includes VAT', '--touches', 'src/total.js'], root);
    assert.equal(code, 0, 'sealing an intent from the command line did not succeed');

    const sealed = JSON.parse(await fsp.readFile(path.join(store.dir, 'intents', `${PRODUCT}.json`), 'utf8'));
    assert.equal(sealed.length, 1, 'the run did not write exactly one intent');
    assert.equal(
      sealed[0].by,
      'a person, at the command line',
      'an intent sealed at a terminal is on the record as somebody who was not there'
    );
    assert.doesNotMatch(sealed[0].by, /over MCP/, 'the record still claims MCP for a run that never spoke it');
  });

  test('an intent sealed over MCP is still recorded as an agent', async () => {
    // The fix must not swing the other way. Records written before today say "an agent, over
    // MCP" and that has to keep meaning exactly what it meant.
    const { root, store } = await project('by-mcp');
    await callTool('staysfixed_intent', { summary: 'the basket total now includes VAT', touches: ['src/total.js'] }, ctxFor(root, 'agent'));

    const sealed = JSON.parse(await fsp.readFile(path.join(store.dir, 'intents', `${PRODUCT}.json`), 'utf8'));
    assert.equal(sealed[0].by, 'an agent, over MCP');
  });

  test('a caller that says nothing is taken for an agent, not for a person', async () => {
    // Every caller that is not the command line is a program. Defaulting the other way would
    // put "a person, at the command line" on records nobody was present for, which is the
    // same untrue record pointing the other way.
    const { root, store } = await project('by-default');
    await callTool('staysfixed_intent', { summary: 'the basket total now includes VAT', touches: ['src/total.js'] }, ctxFor(root));

    const sealed = JSON.parse(await fsp.readFile(path.join(store.dir, 'intents', `${PRODUCT}.json`), 'utf8'));
    assert.equal(sealed[0].by, 'an agent, over MCP');
  });

  test('a waiver recorded from the command line is not recorded as an agent', async () => {
    const { root, store } = await project('waiver-by');
    const f = finding();
    // A minute in the past, so the intent sealed next comes AFTER it and the ordering gate
    // is not what decides this test.
    await rememberACheck(store, [f], new Date(Date.now() + 60_000).toISOString());
    await sealIntent(store, { product: PRODUCT, summary: 'take a line out of the help text', files: ['cli.help.out'] });

    const reply = await callTool('staysfixed_waive', { finding: f.id, because: 'I took that line out on purpose' }, ctxFor(root, 'person'));
    assert.equal(reply.isError, undefined, `the waiver was refused: ${said(reply)}`);

    const written = JSON.parse(await fsp.readFile(path.join(store.dir, 'waivers', `${PRODUCT}.json`), 'utf8'));
    assert.equal(written.length, 1, 'the call did not write exactly one waiver');
    assert.equal(written[0].by, 'a person, at the command line', 'a waiver recorded at a terminal names an agent who was not there');
  });
});

// ---------------------------------------------------------------------------
// Seam two: instructions addressed to the reader who got them
// ---------------------------------------------------------------------------

describe('nothing addressed to an agent is printed at a person', () => {
  /**
   * Every reply the five commands can produce, asked as a person, in one place — so a new
   * sentence added to any of them cannot quietly reintroduce an MCP tool name.
   *
   * @returns {Promise<{what: string, text: string}[]>}
   */
  async function everythingAPersonSees() {
    const { root, store } = await project('person-sweep');
    const f = finding({ evidence: 'evidence/help.txt' });
    await rememberACheck(store, [f], new Date(Date.now() + 60_000).toISOString());

    /** @type {{what: string, text: string}[]} */
    const seen = [];
    const person = ctxFor(root, 'person');

    seen.push({ what: 'intent', text: said(await callTool('staysfixed_intent', { summary: 'the total now includes VAT', touches: ['src/total.js'] }, person)) });
    seen.push({ what: 'explain', text: said(await callTool('staysfixed_explain', { finding: f.id, include: ['values', 'paths'] }, person)) });
    seen.push({ what: 'explain, no id', text: said(await callTool('staysfixed_explain', {}, person)) });
    seen.push({ what: 'explain, unknown id', text: said(await callTool('staysfixed_explain', { finding: 'f-nope' }, person)) });
    seen.push({ what: 'prove, no id', text: said(await callTool('staysfixed_prove', {}, person)) });
    seen.push({ what: 'prove, no revert', text: said(await callTool('staysfixed_prove', { finding: f.id }, person)) });
    seen.push({ what: 'prove, unknown id', text: said(await callTool('staysfixed_prove', { finding: 'f-nope', revert: ['src/total.js'] }, person)) });
    seen.push({ what: 'waive, no id', text: said(await callTool('staysfixed_waive', {}, person)) });
    seen.push({ what: 'waive', text: said(await callTool('staysfixed_waive', { finding: f.id, because: 'I took that line out on purpose' }, person)) });
    seen.push({ what: 'coverage', text: said(await callTool('staysfixed_coverage', { offline: true }, person)) });

    // A copy with nothing recorded at all, which is the state most first refusals come from.
    const empty = await project('person-sweep-empty');
    const bare = ctxFor(empty.root, 'person');
    seen.push({ what: 'explain, never checked', text: said(await callTool('staysfixed_explain', { finding: 'f-a1b2c3' }, bare)) });
    seen.push({ what: 'waive, never checked', text: said(await callTool('staysfixed_waive', { finding: 'f-a1b2c3', because: 'me' }, bare)) });

    return seen;
  }

  test('not one of the five replies hands a person a tool only an agent has', async () => {
    for (const { what, text } of await everythingAPersonSees()) {
      for (const pattern of AGENT_ONLY) {
        assert.doesNotMatch(text, pattern, `\`staysfixed ${what.split(',')[0]}\` printed something only an agent could act on:\n${text}`);
      }
    }
  });

  test('the person is given the terminal equivalent, not simply left with nothing', async () => {
    // Deleting the instruction would pass the check above and leave the reader worse off. The
    // point is the same next step, in words they can type.
    const seen = await everythingAPersonSees();
    /** @param {string} what */
    const textOf = (what) => seen.find((s) => s.what === what)?.text ?? '';

    assert.match(textOf('intent'), /Now run staysfixed check\./, 'the intent reply stopped naming the next step at all');
    assert.match(textOf('explain, never checked'), /Run staysfixed check first/, 'a person is told a check is needed and not how to run one');
    assert.match(textOf('prove, unknown id'), /Run staysfixed check first/, 'prove stopped saying how to get an id');
    assert.match(textOf('waive, never checked'), /Run staysfixed check first/, 'waive stopped saying how to get a finding');
    assert.match(textOf('explain, no id'), /staysfixed explain f-a1b2c3/, 'the example call is no longer one a person could type');
    assert.match(textOf('prove, no revert'), /--revert/, 'prove no longer shows how to name what to put back');
    assert.match(textOf('coverage'), /staysfixed doctor/, 'coverage stopped saying where the machine limits are written down');
  });

  test('the agent keeps the calls it can actually make', async () => {
    // The mirror of the check above: fixing the person's words must not have quietly
    // rewritten the agent's, which are the ones it has to be able to copy verbatim.
    const { root, store } = await project('agent-sweep');
    const f = finding();
    await rememberACheck(store, [f]);
    const agent = ctxFor(root, 'agent');

    const intent = said(await callTool('staysfixed_intent', { summary: 'the total now includes VAT', touches: ['src/total.js'] }, agent));
    assert.match(intent, /Now run staysfixed_check\./, "the agent's next step lost its tool name");

    const explain = said(await callTool('staysfixed_explain', {}, agent));
    assert.match(explain, /\{ "finding": "f-a1b2c3" \}/, 'the agent lost the example arguments it copies');

    const prove = said(await callTool('staysfixed_prove', { finding: f.id }, agent));
    assert.match(prove, /\{ "revert": \[/, 'the agent lost the shape of the revert argument');
  });

  test('a sealed class is refused to whoever asks, in words about them', async () => {
    // "No agent can wave this through … put it in front of a person" is exactly right for an
    // agent and says nothing to the person who has just typed the command themselves — they
    // ARE the person it points at, and it reads as a rule with an obvious way round it.
    const money = finding({ title: 'the price on the checkout button changed', paths: ['results/checkout.total'], class: 'money' });
    const verdict = classify(money);
    assert.ok(verdict, 'the fixture stopped being classified as a sealed difference, so this proves nothing');

    const toAgent = sayRefusal(verdict, money);
    const toPerson = sayRefusal(verdict, money, 'person');

    assert.match(toAgent, /No agent can wave this through/, "the agent's wording changed");
    assert.doesNotMatch(toPerson, /^No agent can/m, 'a person is still told a rule about somebody else');
    assert.match(toPerson, /not you here/, 'the person is not told the rule applies to them');
    // The verdict itself — the part that is a fact — has to be identical either way.
    assert.equal(toAgent.split('\n')[0], toPerson.split('\n')[0], 'the two readers were given different reasons for the same refusal');
  });

  test('the refusal a person reads comes through the gate, not just the helper', async () => {
    // sayRefusal being right is worth nothing if `waive` never passes the audience down.
    const { root, store } = await project('sealed-through-waive');
    const money = finding({ title: 'the price on the checkout button changed', paths: ['results/checkout.total'], class: 'money' });
    await rememberACheck(store, [money], new Date(Date.now() + 60_000).toISOString());
    await sealIntent(store, { product: PRODUCT, summary: 'change the checkout total', files: ['results/checkout.total'] });

    const reply = await callTool('staysfixed_waive', { finding: money.id, because: 'the total is meant to include VAT now' }, ctxFor(root, 'person'));
    assert.equal(reply.isError, true, 'a money difference was not refused');
    assert.doesNotMatch(said(reply), /^No agent can/m, 'the refusal reaching a terminal is still addressed to an agent');
  });

  test('waiving is still refused for the same reasons whoever asks', async () => {
    // The whole point: the WORDS move, the RULES do not. Both readers get the same verdict on
    // the same difference, and a person cannot get through a gate an agent cannot.
    const money = finding({ title: 'the price on the checkout button changed', paths: ['results/checkout.total'], class: 'money' });

    for (const audience of /** @type {const} */ (['agent', 'person'])) {
      const { root, store } = await project(`gates-${audience}`);
      await rememberACheck(store, [money], new Date(Date.now() + 60_000).toISOString());
      await sealIntent(store, { product: PRODUCT, summary: 'change the checkout total', files: ['results/checkout.total'] });
      const reply = await callTool('staysfixed_waive', { finding: money.id, because: 'the total is meant to include VAT now' }, ctxFor(root, audience));
      assert.equal(reply.isError, true, `a money difference was waived for ${audience}`);
      const waivers = path.join(store.dir, 'waivers', `${PRODUCT}.json`);
      await assert.rejects(() => fsp.readFile(waivers, 'utf8'), `${audience} got a sealed difference written down as waived`);
    }
  });
});

describe('the two readers are told the same thing', () => {
  test('one coverage answer, differing only where a next step is named', async () => {
    // The strongest form of the promise this lane exists to keep. `coverage` is the longest
    // reply either reader gets and it is assembled once, so the two texts must come out
    // identical once the handful of next-step phrases are translated back. Anything else
    // that differs is a fact that moved with the audience, which is the bug.
    const { root } = await project('same-answer');
    const agent = voiceFor(/** @type {any} */ ({ audience: 'agent' }));
    const person = voiceFor(/** @type {any} */ ({ audience: 'person' }));

    // offline, so nothing here depends on which machines answered today.
    const toAgent = said(await callTool('staysfixed_coverage', { offline: true }, ctxFor(root, 'agent')));
    const toPerson = said(await callTool('staysfixed_coverage', { offline: true }, ctxFor(root, 'person')));

    let translated = toPerson;
    for (const key of /** @type {const} */ (['check', 'capabilities', 'askForMachines', 'askForEvidence'])) {
      translated = translated.split(/** @type {any} */ (person)[key]).join(/** @type {any} */ (agent)[key]);
    }

    assert.equal(translated, toAgent, 'a person and an agent were told different things about the same product');
  });
});

// ---------------------------------------------------------------------------
// The phrasebook itself
// ---------------------------------------------------------------------------

describe('the phrasebook cannot grow a sentence for only one reader', () => {
  test('both voices answer to exactly the same set of names', () => {
    const agent = voiceFor(/** @type {any} */ ({ audience: 'agent' }));
    const person = voiceFor(/** @type {any} */ ({ audience: 'person' }));
    assert.deepEqual(
      Object.keys(agent).sort(),
      Object.keys(person).sort(),
      'one reader has a phrase the other does not, so some sentence has no words for them'
    );
  });

  test('nothing in the person half names a tool a person does not have', () => {
    const person = voiceFor(/** @type {any} */ ({ audience: 'person' }));
    for (const [key, value] of Object.entries(person)) {
      if (typeof value !== 'string') continue;
      assert.doesNotMatch(value, /staysfixed_[a-z]+/, `the person's \`${key}\` names an MCP tool`);
      assert.doesNotMatch(value, /include:\s*\[/, `the person's \`${key}\` is written as MCP arguments`);
    }
  });

  test('the two halves genuinely differ, so nothing has been left half-translated', () => {
    const agent = voiceFor(/** @type {any} */ ({ audience: 'agent' }));
    const person = voiceFor(/** @type {any} */ ({ audience: 'person' }));
    for (const key of ['by', 'check', 'capabilities', 'explainCall', 'proveCall', 'revertArg', 'waiveCall', 'askForEvidence']) {
      assert.notEqual(
        /** @type {any} */ (agent)[key],
        /** @type {any} */ (person)[key],
        `\`${key}\` is the same for both readers, which means one of them is reading the other's words`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The mirror: a person's furniture must not reach an agent
// ---------------------------------------------------------------------------

describe('nothing written for a terminal is handed to an agent', () => {
  /** Colour, cursor moves, and anything else that only means something to a terminal. */
  const ANSI = /\[/;
  /** The box-drawing and rule characters a console report is built out of. */
  const DRAWN = /[─-╿▀-▟]/;

  test('no MCP reply carries colour codes or a drawn box', async () => {
    const { root, store } = await project('mirror');
    const f = finding({ evidence: 'evidence/help.txt' });
    await rememberACheck(store, [f]);
    const agent = ctxFor(root, 'agent');

    /** @type {{what: string, text: string}[]} */
    const replies = [
      { what: 'intent', text: said(await callTool('staysfixed_intent', { summary: 'the total now includes VAT', touches: ['src/total.js'] }, agent)) },
      { what: 'explain', text: said(await callTool('staysfixed_explain', { finding: f.id }, agent)) },
      { what: 'prove, no revert', text: said(await callTool('staysfixed_prove', { finding: f.id }, agent)) },
      { what: 'waive', text: said(await callTool('staysfixed_waive', { finding: f.id, because: 'I meant it' }, agent)) },
      { what: 'coverage', text: said(await callTool('staysfixed_coverage', { offline: true }, agent)) },
      { what: 'capabilities', text: said(await callTool('staysfixed_capabilities', { offline: true }, agent)) },
      { what: 'an unknown tool', text: said(await callTool('staysfixed_nonsense', {}, agent)) },
    ];

    for (const { what, text } of replies) {
      assert.doesNotMatch(text, ANSI, `${what} sent an agent terminal colour codes, which are tokens it pays for and cannot use`);
      assert.doesNotMatch(text, DRAWN, `${what} sent an agent a drawn box`);
    }
  });

  test('the check report an agent reads is plain text as well', () => {
    // renderCheck is the one reply an agent gets on every single run, so it is the most
    // expensive place for a stray rule line or a colour code to live.
    const text = renderCheck({
      result: /** @type {any} */ ({ ok: false, product: PRODUCT, coverage: { paths: 4, journeys: 1, doorsKnown: 2, doorsWalked: 1, gaps: [] } }),
      unaccounted: [finding()],
      page: [finding()],
      offset: 0,
      limit: 10,
      waived: 0,
      expired: 0,
      waiversLeft: 5,
      newlyUnstable: [],
      intent: null,
      clean: false,
      missedTheTarget: null,
      notChecked: '',
      covers: null,
    });

    assert.doesNotMatch(text, ANSI, 'the check reply an agent reads carries terminal colour');
    assert.doesNotMatch(text, DRAWN, 'the check reply an agent reads is drawn as a box');
  });
});

describe('prove gives three answers, and only two of them are answers', () => {
  /**
   * Measured 2026-08-31 on a real website, by somebody using the tool as a stranger.
   *
   * `staysfixed prove <finding> --revert <file>`, asked about a one-line heading change that
   * had definitely caused the finding, replied: "Your edit did not cause this, so fixing
   * that file will not help." Naming a completely unrelated file produced the word-for-word
   * identical denial. It came back in five seconds on a project where a real check takes
   * eleven to twenty minutes, with zero server starts in the run log — it had re-run nothing.
   *
   * `toolProve` branched on `gone === true`, so the engine's three-state verdict was read as
   * a boolean and "could not test" was printed as "your edit is innocent". That is the false
   * all-clear this product exists to prevent, wearing the smallest possible hat: not a clean
   * check over a broken product, but a clean bill of health for one file, which sends
   * somebody to go and look somewhere else.
   *
   * These tests hold the three apart by their words, because the words are what anybody
   * acts on.
   */

  /**
   * Ask `staysfixed_prove` with the engine's answer pinned to one verdict.
   *
   * `loadEngine` caches and hands back the same object every time, so replacing one part on
   * it is enough to put a known answer in front of the wording — which is the half under
   * test here. Running a real proof would test src/v2/cause.js, which has its own tests in
   * test/v2/silences.test.js.
   *
   * @param {any} answer  What the engine's `prove` facade returns.
   * @returns {Promise<{text: string, isError: boolean, structured: any}>}
   */
  async function proveSaying(answer) {
    const { root, store } = await project('prove-three');
    await rememberACheck(store, [finding()]);
    const engine = await loadEngine();
    const before = engine.parts.prove;
    engine.parts.prove = async () => answer;
    try {
      const result = await callTool('staysfixed_prove', { finding: 'f-a1b2c3', revert: ['src/total.js'] }, ctxFor(root, 'person'));
      return { text: said(result), isError: result.isError === true, structured: result.structuredContent };
    } finally {
      if (before) engine.parts.prove = before;
      else delete engine.parts.prove;
    }
  }

  const CAUSED = { verdict: 'caused by that change', gone: true, detail: 'Undoing that one change in src/total.js made this go away.', reran: 1, checked: 1 };
  const NOT_CAUSED = { verdict: 'not caused by that change', gone: false, escalates: true, detail: 'This is still here with that change undone.', reran: 1, checked: 1 };
  const COULD_NOT = { verdict: 'could not test', gone: false, detail: 'Nothing in the working tree has changed, so there is no change to undo. Nothing was re-run: no build was started and no journey was walked again.', reran: 0, checked: 0 };

  test('the three verdicts are three different sentences', async () => {
    const caused = await proveSaying(CAUSED);
    const notCaused = await proveSaying(NOT_CAUSED);
    const couldNot = await proveSaying(COULD_NOT);

    const heads = [caused, notCaused, couldNot].map((r) => r.text.split('\n')[0].trim());
    assert.equal(new Set(heads).size, 3, `all three outcomes have to open differently, and two of them used to be identical: ${JSON.stringify(heads)}`);
  });

  test('"could not test" never says the edit did not cause it', async () => {
    const { text } = await proveSaying(COULD_NOT);

    // The exact sentence measured on 2026-08-31, and the shape of it.
    assert.doesNotMatch(
      text,
      /Your edit did not cause this, so fixing that file will not help/,
      'this is the word-for-word denial an untested claim used to come back wearing, and an unrelated file got the same one',
    );
    assert.doesNotMatch(text, /^NOT PROVEN: it survived the revert/m, 'nothing survived a revert, because no revert happened');
    assert.match(text, /NOT TESTED/, 'it has to name itself as the outcome it is');
    assert.match(text, /has not been cleared/, 'the file named must be left under suspicion, not acquitted');
  });

  test('"could not test" says nothing was re-run, and comes back non-zero', async () => {
    const { text, isError, structured } = await proveSaying(COULD_NOT);

    assert.match(text, /Nothing was re-run/, 'five seconds is not a measurement of an eleven-minute product, and the reply has to say which it was');
    assert.equal(isError, true, 'the CLI turns this into exit 2, which is the promise `staysfixed prove --help` has always made: 0 when it could test the claim, 2 when it could not');
    assert.equal(structured.verdict, 'could not test');
    assert.equal(structured.reran, 0);
  });

  test('the two real answers say what they were measured on, and come back clean', async () => {
    const caused = await proveSaying(CAUSED);
    const notCaused = await proveSaying(NOT_CAUSED);

    for (const { text, isError } of [caused, notCaused]) {
      assert.match(text, /1 journey walked again/, 'a verdict that cost a real re-run says what it cost, so a cheap reply cannot pass for an expensive one');
      assert.equal(isError, false, 'both of these are answers — "your edit was innocent" is not a failure and must not be read as one');
    }
    assert.match(notCaused.text, /PROVEN NOT CAUSED/);
    assert.match(caused.text, /PROVEN CAUSED/);
  });

  test('an engine that forgets to say which verdict is treated as not tested', async () => {
    // An older facade returning only `{gone: false}` cannot tell the two apart, and the
    // unknown has to fall to the answer that claims nothing. Reporting "could not test"
    // about something that was really tested costs one more command; reporting "your edit
    // did not cause this" about something nobody measured is what sent somebody to fix the
    // wrong file.
    const { text, isError } = await proveSaying({ gone: false, detail: 'no verdict field here' });

    assert.match(text, /NOT TESTED/);
    assert.equal(isError, true);
    assert.doesNotMatch(text, /did not cause this/);
  });
});
