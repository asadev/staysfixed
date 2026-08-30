/**
 * Normalisation - the first of the four noise layers, and the only one that can
 * lie to you.
 *
 * Every rule here buys quiet by making some real differences invisible. That is
 * a trade, not a bug, and the only dishonest version of it is the one where
 * nobody wrote the cost down. The rules carry `wouldHide` for exactly that
 * reason, and this file holds them to it twice over: every rule must say what it
 * hides, and every rule must actually hide it. If somebody adds a rule and nobody
 * records its blind spot, the coverage test fails and names the rule.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RULES,
  OPTIONAL_RULES,
  ruleProblem,
  normalise,
  explain,
  normaliseObservation,
  describeRules,
  describeRuleChange,
  machineRules,
  mergeRules,
  rulesFingerprint,
  rulesScope,
} from '../../src/v2/normalise.js';

/** The character a terminal uses to start a colour code. Built rather than typed, so this file holds no control characters. */
const ESC = String.fromCharCode(27);

/**
 * @typedef {object} RuleCase
 * @property {[unknown, unknown]} quiets   Two volatile forms that must become the same thing.
 * @property {[unknown, unknown]} hides    Two GENUINELY different values this rule makes identical.
 * @property {string} cost                 The blind spot, in the words a person would use.
 */

/**
 * One entry per default rule, keyed by the rule's id.
 * @type {Record<string, RuleCase>}
 */
const CASES = {
  'clock.iso': {
    quiets: ['built at 2026-08-29T11:04:02.113Z', 'built at 2026-08-29T11:04:09.882Z'],
    hides: ['your booking is 2026-01-01T09:00:00.000Z', 'your booking is 2027-06-14T09:00:00.000Z'],
    cost: 'a date the product shows on purpose, like a booking or a due date',
  },
  'clock.epoch-ms': {
    quiets: ['saved 1756468802113', 'saved 1756468809882'],
    hides: ['account 1700000000001', 'account 1900000000009'],
    cost: 'a real number that happens to be thirteen digits - a large account number, or money in its smallest unit',
  },
  'clock.duration': {
    quiets: ['ready in 812ms', 'ready in 907ms'],
    hides: ['times out after 30s', 'times out after 5s'],
    cost: 'a duration the product deliberately shows and that ought to be fixed',
  },
  'mem.address': {
    quiets: ['object at 0x7f9c1a2b3c4d', 'object at 0x7f001a2b3c4d'],
    hides: ['flags 0xdeadbeefcafe', 'flags 0x000000000000'],
    cost: 'a long hex constant the product prints on purpose',
  },
  'id.uuid': {
    quiets: ['session 6f2a1b3c-4d5e-4f60-8a91-b2c3d4e5f607', 'session 11112222-3333-4444-5555-666677778888'],
    hides: ['fixture 6f2a1b3c-4d5e-4f60-8a91-b2c3d4e5f607', 'fixture 99998888-7777-6666-5555-444433332222'],
    cost: 'a uuid written into a fixture on purpose, where the whole point is that this exact id came back',
  },
  'id.hex': {
    quiets: ['request a1b2c3d4e5f60718', 'request 0918273645abcdef'],
    hides: ['handle deadbeefcafebabe', 'handle 0123456789abcdef'],
    cost: 'a hex value in that length range that was meant to stay the same',
  },
  'id.pid': {
    quiets: ['worker pid 41221 started', 'worker pid 9 started'],
    hides: ['worker pid 41221 started', 'worker pid 1 started'],
    cost: 'almost nothing - the label has to be there, so a bare number is never touched',
  },
  'net.port': {
    quiets: ['listening on localhost:53412', 'listening on localhost:61220'],
    hides: ['listening on localhost:3000', 'listening on localhost:8080'],
    cost: 'a service that moved to a different fixed port on purpose',
  },
  'path.temp': {
    quiets: ['wrote /tmp/staysfixed-a1b2c3/out.json', 'wrote /tmp/staysfixed-z9y8x7/out.json'],
    hides: ['wrote /tmp/mine/out.json', 'wrote /tmp/somebody-else/secrets.json'],
    cost: 'writing into the wrong temporary file',
  },
  'path.home': {
    quiets: ['opened /Users/asad/Projects/shop', 'opened /home/runner/Projects/shop'],
    hides: ['read /Users/asad/.ssh/id_ed25519', 'read /Users/somebody-else/.ssh/id_ed25519'],
    cost: 'a path that escaped into a different person’s home folder',
  },
  'token.bearer': {
    quiets: ['Authorization: Bearer abc123', 'Authorization: Bearer zzz999'],
    hides: ['Authorization: Bearer the-right-key', 'Authorization: Bearer the-wrong-key'],
    cost: 'sending the wrong credential - which is why what a call SENDS is watched by its address and by the sealed classes, never by its value',
  },
  'token.jwt': {
    quiets: ['token eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig1', 'token eyJhbGciOiJIUzI1NiJ9.eyJhIjoyfQ.sig2'],
    hides: ['token eyJhZG1pbiI6dHJ1ZQ.eyJhIjoxfQ.x', 'token eyJhZG1pbiI6ZmFsc2U.eyJhIjoxfQ.x'],
    cost: 'a token whose contents changed meaning - an admin claim flipping, for instance',
  },
  'text.ansi': {
    quiets: [ESC + '[32mok' + ESC + '[0m done', 'ok done'],
    hides: [ESC + '[32mok' + ESC + '[0m', ESC + '[31mok' + ESC + '[0m'],
    cost: 'a real change of colour - green success turning red',
  },
  'text.crlf': {
    quiets: ['first\r\nsecond\r\nthird', 'first\nsecond\nthird'],
    hides: ['saved with \r\n', 'saved with \n'],
    cost: 'a genuine CRLF regression on Windows',
  },
  'text.trailing-space': {
    quiets: ['total 12.50   ', 'total 12.50'],
    hides: ['name: Aisha  ', 'name: Aisha'],
    cost: 'a value that gained or lost trailing spaces on purpose, such as a padded column',
  },
  'number.float': {
    quiets: [0.1 + 0.2, 0.30000000000000004],
    hides: [1.0000000000000002, 1.0000000000000004],
    cost: 'a difference smaller than the rounding - which is the whole reason the rule exists',
  },
};

/** @param {any} value */
const clean = (value) => normalise(value, DEFAULT_RULES);

describe('the rules are auditable', () => {
  test('every rule ships usable', () => {
    for (const rule of [...DEFAULT_RULES, ...OPTIONAL_RULES]) {
      assert.equal(ruleProblem(rule), null, `${rule.id} is not usable as written`);
    }
  });

  test('a rule that does not say what it hides is refused', () => {
    const problem = ruleProblem({ id: 'test.no-cost', kind: 'replace', what: 'a thing', why: 'because', pattern: 'x', with: 'y' });
    assert.ok(problem, 'a rule with no wouldHide must be refused');
    assert.match(String(problem), /wouldHide/, 'and the refusal has to name the field that is missing');
  });

  test('every rule explains itself in plain words, not in labels', () => {
    for (const rule of [...DEFAULT_RULES, ...OPTIONAL_RULES]) {
      // `what` is a label and is allowed to be short. `why` and `wouldHide` are
      // arguments, and an argument nobody can read is the same as no argument.
      for (const [field, leastWords] of /** @type {[string, number][]} */ ([['what', 3], ['why', 6], ['wouldHide', 6]])) {
        const text = /** @type {any} */ (rule)[field];
        assert.ok(
          typeof text === 'string' && text.trim().split(/\s+/).length >= leastWords,
          `${rule.id}.${field} is not written for a person to read: ${String(text)}`
        );
        assert.doesNotMatch(
          text,
          /\b(regex|regexp|serialise|serialize|stdout|deterministic)\b/i,
          `${rule.id}.${field} uses jargon a person reading a report would not know`
        );
      }
    }
  });

  test('every default rule has its blind spot demonstrated here', () => {
    const undocumented = DEFAULT_RULES.map((r) => r.id).filter((id) => CASES[id] === undefined);
    assert.deepEqual(
      undocumented,
      [],
      `These rules quieten differences and this file does not prove what they hide: ${undocumented.join(', ')}.\n` +
        'Add a case for each to CASES in test/v2/normalise.test.js. A rule whose blind spot nobody demonstrated is a lie the tool tells later.'
    );

    const gone = Object.keys(CASES).filter((id) => !DEFAULT_RULES.some((r) => r.id === id));
    assert.deepEqual(gone, [], `These rules are described here but no longer exist: ${gone.join(', ')}.`);
  });

  test('describeRules says what is on AND what is deliberately off', () => {
    // The second list is the more useful one when a run reports nothing: it is
    // the difference between "your product is fine" and "nobody was looking".
    const described = describeRules([...DEFAULT_RULES, ...OPTIONAL_RULES]);
    assert.ok(Array.isArray(described.on) && described.on.length > 0);
    assert.ok(Array.isArray(described.off), 'the rules that are switched off have to be listed too');
    assert.ok(described.on.some((r) => r.id === DEFAULT_RULES[0].id), 'it has to name the rules, or nobody can scope one off');
    for (const one of described.on) {
      assert.ok(one.wouldHide.length > 0, `${one.id} is on and does not say what it is hiding`);
    }
    for (const one of described.off) {
      assert.ok(one.whyOff.length > 0, `${one.id} is off and does not say why`);
    }
  });
});

describe('what each rule quietens, and what it hides', () => {
  for (const [id, one] of Object.entries(CASES)) {
    test(`${id}: two runs that differ only by noise read the same`, () => {
      assert.deepEqual(
        clean(one.quiets[0]),
        clean(one.quiets[1]),
        `these two should normalise to the same thing:\n  ${JSON.stringify(one.quiets[0])}\n  ${JSON.stringify(one.quiets[1])}`
      );
    });

    test(`${id}: and it hides ${one.cost}`, () => {
      assert.deepEqual(
        clean(one.hides[0]),
        clean(one.hides[1]),
        `The rule "${id}" is supposed to make these two look identical, and it does not any more.\n` +
          'That may well be an improvement - but the blind spot recorded here has changed, and the trade has to be written down again.'
      );
    });
  }
});

describe('normalising answers for itself', () => {
  test('explain names the rule that fired and what it admits to hiding', () => {
    const out = explain('built at 2026-08-29T11:04:02.113Z', DEFAULT_RULES);
    assert.ok(out.replacements.length > 0, 'something was rewritten, so something has to be on the receipt');
    const one = out.replacements[0];
    assert.equal(one.ruleId, 'clock.iso');
    assert.ok(one.wouldHide.length > 0, 'the receipt carries the cost, so a quiet run can be argued with');
    assert.ok(one.before.length > 0 && one.after.length > 0);
    assert.match(out.summary, /clock\.iso/);
  });

  test('a value nothing touched says so, rather than saying nothing', () => {
    const out = explain('The sidebar collapsed and the settings page opened.', DEFAULT_RULES);
    assert.deepEqual(out.replacements, []);
    assert.ok(out.summary.length > 0, 'silence and "nothing was rewritten" are different answers');
  });

  test('a value with nothing volatile in it comes back word for word', () => {
    const plain = 'The sidebar collapsed and the settings page opened.';
    assert.equal(clean(plain), plain);
  });

  test('booleans and null are left alone', () => {
    assert.equal(clean(true), true);
    assert.equal(clean(null), null);
  });

  test('normalising an observation keeps its address and its channel', () => {
    const observation = { path: 'cli.build.log', channel: 'results', value: 'built at 2026-08-29T11:04:02.113Z' };
    const out = normaliseObservation(/** @type {any} */ (observation), DEFAULT_RULES);
    assert.equal(out.path, observation.path, 'an address must never be rewritten - it is what two runs are matched on');
    assert.equal(out.channel, observation.channel);
    assert.notEqual(out.value, observation.value);
  });

  test('normalising does not change the observation it was handed', () => {
    const observation = { path: 'cli.build.log', channel: 'results', value: 'built at 2026-08-29T11:04:02.113Z' };
    normaliseObservation(/** @type {any} */ (observation), DEFAULT_RULES);
    assert.equal(observation.value, 'built at 2026-08-29T11:04:02.113Z', 'normalising must not edit its input');
  });

  test('a timestamp three levels down is still a timestamp', () => {
    const out = clean({ lines: ['built at 2026-08-29T11:04:02.113Z', 'ok'], count: 2 });
    assert.equal(JSON.stringify(out).includes('2026-08-29T11:04:02.113Z'), false);
  });
});

/**
 * The stamp that decides whether a stored comparison is trustworthy.
 *
 * This is a warning-fatigue test more than a correctness one. The caveat this stamp feeds fired
 * on EVERY run of the published 0.7.2 — same binary, minutes apart, nothing edited — because a
 * per-run temp folder was baked into a rule's pattern and hashed along with it. A warning that
 * is always on is a warning nobody reads on the day it is true, so these hold the line in both
 * directions: it must not move when nothing meaningful changed, and it must still move when
 * something did.
 */
describe('the fingerprint of a rule set', () => {
  /**
   * The rule set a real check builds, including the scratch folder that is fresh every run.
   * @param {string} scratch
   * @returns {any[]}
   */
  function asACheckWouldBuildIt(scratch) {
    return mergeRules(DEFAULT_RULES, [
      ...machineRules({ root: '/somewhere/demo', home: '/home/somebody', tmp: '/var/tmp' }),
      ...machineRules({ root: scratch }),
    ]);
  }

  test('does not move because this run got a different temp folder', () => {
    const first = rulesFingerprint(asACheckWouldBuildIt('/var/tmp/staysfixed-check-aaaaaa'));
    const second = rulesFingerprint(asACheckWouldBuildIt('/var/tmp/staysfixed-check-zzzzzz'));
    assert.equal(first, second, 'a fresh scratch folder is a fact about the run, not a change to the rules');
  });

  test('does not move because the same rules ran on a different machine', () => {
    const here = rulesFingerprint(mergeRules(DEFAULT_RULES, machineRules({ root: '/Users/a/demo', home: '/Users/a', tmp: '/var/folders/x' })));
    const there = rulesFingerprint(mergeRules(DEFAULT_RULES, machineRules({ root: '/home/b/demo', home: '/home/b', tmp: '/tmp' })));
    assert.equal(here, there, 'both machines rewrite their own checkout to <project>, so both comparisons mean the same thing');
  });

  test('still moves when a rule actually rewrites something differently', () => {
    const before = rulesFingerprint(DEFAULT_RULES);
    const after = rulesFingerprint(mergeRules(DEFAULT_RULES, [{ id: 'clock.iso', pattern: 'something-else' }]));
    assert.notEqual(before, after, 'this is the case the stamp exists for and it must never go quiet');
  });

  test('a rule shipped switched off changes nothing, which is the way to add one without churn', () => {
    const before = rulesFingerprint(DEFAULT_RULES);
    const withNewRule = rulesFingerprint([
      ...DEFAULT_RULES,
      { id: 'hash.sha', kind: 'replace', what: 'x', why: 'y', wouldHide: 'z', pattern: '[0-9a-f]{40}', with: '<sha>', off: true },
    ]);
    assert.equal(before, withNewRule);
  });

  test('scope is not behaviour: narrowing a rule leaves the comparison trustworthy', () => {
    const scoped = mergeRules(DEFAULT_RULES, [{ id: 'clock.iso', paths: ['screen.**'] }]);
    assert.equal(rulesFingerprint(DEFAULT_RULES), rulesFingerprint(scoped), 'where a rule applies is not what it does');
    assert.deepEqual(rulesScope(scoped)['clock.iso'], ['screen.**']);
  });

  test('a rule that applies everywhere says nothing about scope', () => {
    assert.equal('clock.iso' in rulesScope(DEFAULT_RULES), false);
  });

  test('changing one field of a shipped rule needs only its id', () => {
    const merged = mergeRules(DEFAULT_RULES, [{ id: 'clock.iso', off: true }]);
    assert.equal(merged.find((r) => r.id === 'clock.iso')?.off, true);
    assert.equal(merged.find((r) => r.id === 'clock.iso')?.kind, 'replace', 'the rest of the rule has to survive');
  });

  test('a part-rule naming a rule that does not exist is refused, not quietly kept', () => {
    assert.throws(
      () => mergeRules(DEFAULT_RULES, [{ id: 'clock.izo', off: true }]),
      /no normalisation rule called "clock.izo"/,
      'kept, it became a rule with no kind that every branch skips - a typo that looks exactly like a rule that works',
    );
  });
});

describe('saying what changed about the rules, rather than printing two hashes', () => {
  test('nothing changed is nothing said', () => {
    const change = describeRuleChange({ fingerprint: 'v1-aaa', scope: {} }, { fingerprint: 'v1-aaa', scope: {} });
    assert.equal(change.same, true);
    assert.equal(change.say, '');
  });

  test('a behaviour change says the comparison itself may be the rules', () => {
    const change = describeRuleChange({ fingerprint: 'v1-aaa', scope: {} }, { fingerprint: 'v1-bbb', scope: {} });
    assert.equal(change.behaviourChanged, true);
    assert.match(change.say, /rather than the product/);
  });

  test('a rule reaching a new address names the address', () => {
    const change = describeRuleChange(
      { fingerprint: 'v1-aaa', scope: {} },
      { fingerprint: 'v1-aaa', scope: { 'clock.iso': ['screen.checkout.total'] } },
    );
    assert.equal(change.same, false);
    assert.equal(change.behaviourChanged, false, 'adding scope does not change how anything already covered is tidied');
    assert.deepEqual(change.addressesNewlyCovered, ['clock.iso now also covers screen.checkout.total']);
    assert.match(change.say, /screen\.checkout\.total/, 'an agent cannot act on "somewhere"');
    assert.match(change.say, /Everything else compares normally/);
  });

  test('a rule that stopped covering an address is not news', () => {
    const change = describeRuleChange(
      { fingerprint: 'v1-aaa', scope: { 'clock.iso': ['screen.**'] } },
      { fingerprint: 'v1-aaa', scope: {} },
    );
    assert.equal(change.same, true, 'less normalisation can only show differences that were hidden, which is the safe direction');
  });

  test('a record written before the scope stamp says so instead of inventing a diff', () => {
    const change = describeRuleChange({ fingerprint: 'v1-aaa' }, { fingerprint: 'v1-bbb', scope: { 'clock.iso': ['screen.**'] } });
    assert.equal(change.scopeChanged, false, 'everything would look new, and none of it would be true');
    assert.match(change.say, /predates the scope stamp/);
  });

  test('an unstamped capture is not accused of anything', () => {
    assert.equal(describeRuleChange({}, { fingerprint: 'v1-bbb' }).same, true);
  });
});
