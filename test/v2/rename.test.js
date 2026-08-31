/**
 * A rename has two halves, and the report owes the reader the half that breaks their code.
 *
 * Renaming a field is the single most common way an agent breaks every caller of an API
 * without breaking anything it can see. `name` becomes `fullName`, every response still looks
 * plausible, every test that checks a status code still passes, and every screen reading
 * `user.name` goes blank. The whole reason this tool watches the SHAPE of a reply separately
 * from its values is to catch exactly that — the observation that carries it says so in its
 * own words: "a renamed or dropped field shows up on its own instead of buried in a diff of
 * the whole body."
 *
 * Two failures measured on 2026-08-30 and 2026-08-31, both proved end to end against a real
 * Node HTTP server before a line of this was written:
 *
 *   1. The sentence named only the field that ARRIVED. "GET /api/user / shape now has
 *      "fullName" reading "string" where it read nothing." The word `name` never appeared —
 *      not in the English, not in the JSON — so the reader was told what to start using and
 *      never told what had stopped existing.
 *
 *   2. An address the reference record holds a value for was reported as "there now and was
 *      not before", because the old build booted live was fetched by a different key than the
 *      record was filed under and had nothing at that address.
 *
 * Both are about the same thing: a difference described as less than it is.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { clusterDifferences, describe as describeDifference } from '../../src/v2/cluster.js';
import { proveAgainstLive } from '../../src/v2/run.js';

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
  const d = { path, channel, kind, journey: 'GET /api/user', distance: 1 };
  if (reference !== undefined) d.reference = reference;
  if (candidate !== undefined) d.candidate = candidate;
  return d;
}

/**
 * One observation, the shape the store keeps and the shape an adapter hands back.
 *
 * @param {string} path
 * @param {unknown} value
 * @returns {any}
 */
function observed(path, value) {
  return { path, channel: 'results', value, meta: {} };
}

// ---------------------------------------------------------------------------
// 1 — a renamed field, said as a rename
// ---------------------------------------------------------------------------

describe('a field renamed inside one reply', () => {
  /**
   * The exact values a six-field JSON reply produces on the shape channel when `name` is
   * renamed to `fullName`. Six fields matters: a set of details is summarised by its first
   * four field names, so with six of them both sides summarise to the SAME words and the
   * sentence falls through to the field-by-field wording, which is where the half that went
   * away was being dropped.
   */
  const shapeBefore = { address: 'string', avatar: 'string', created: 'string', email: 'string', id: 'number', name: 'string' };
  const shapeAfter = { address: 'string', avatar: 'string', created: 'string', email: 'string', fullName: 'string', id: 'number' };

  test('the sentence names the field that went away, not only the one that arrived', () => {
    const sentence = describeDifference(
      difference('api.GET /api/user.shape', 'results', 'changed', shapeBefore, shapeAfter),
      1,
    );
    assert.match(sentence, /"name"/, 'the half that breaks every caller was left out of the sentence');
    assert.match(sentence, /"fullName"/, 'and the new name has to be there too, or nobody knows what to read instead');
  });

  test('it is said as a rename, not as two unrelated bits of news', () => {
    const sentence = describeDifference(
      difference('api.GET /api/user.shape', 'results', 'changed', shapeBefore, shapeAfter),
      1,
    );
    assert.match(
      sentence,
      /no longer has "name".*under "fullName"/,
      'one edit a person would describe in four words has to read like one',
    );
  });

  test('it says what happens to code that still reads the old name', () => {
    // The reader is an agent deciding what to fix, or a person deciding whether to care.
    // "gets nothing" is the fact both of them act on.
    const sentence = describeDifference(
      difference('api.GET /api/user.shape', 'results', 'changed', shapeBefore, shapeAfter),
      1,
    );
    assert.match(sentence, /gets nothing/);
  });

  test('a rename in the body reads the same way, with the real values', () => {
    const before = { address: '12 Bridge St', avatar: '/a.png', created: '2020-01-01', email: 'ada@example.com', id: 1, name: 'Ada Lovelace' };
    const after = { address: '12 Bridge St', avatar: '/a.png', created: '2020-01-01', email: 'ada@example.com', fullName: 'Ada Lovelace', id: 1 };
    const sentence = describeDifference(difference('api.GET /api/user.body', 'results', 'changed', before, after), 1);
    assert.match(sentence, /"name"/);
    assert.match(sentence, /"fullName"/);
  });

  test('a short reply, where the two sides do NOT summarise alike, still says renamed', () => {
    // Three fields, so both summaries list every name and the old sentence read "is now a set
    // of details (3 fields: "email", "fullName", "id") where it was a set of details
    // (3 fields: "email", "id", "name")". Every fact was in there and the reader still had to
    // diff two lists by eye to find the one word that moved.
    const sentence = describeDifference(
      difference(
        'api.GET /api/user.shape',
        'results',
        'changed',
        { email: 'string', id: 'number', name: 'string' },
        { email: 'string', fullName: 'string', id: 'number' },
      ),
      1,
    );
    assert.match(sentence, /no longer has "name".*under "fullName"/);
  });

  test('a rename nested inside the reply carries the path to it', () => {
    const sentence = describeDifference(
      difference(
        'api.GET /api/user.shape',
        'results',
        'changed',
        { data: { id: 'number', name: 'string' }, ok: 'boolean' },
        { data: { fullName: 'string', id: 'number' }, ok: 'boolean' },
      ),
      1,
    );
    assert.match(sentence, /data \/ name/, 'an address without its path names nothing');
    assert.match(sentence, /data \/ fullName/);
  });

  test('the finding an agent reads carries it too, not only the console line', () => {
    const findings = clusterDifferences([
      difference('api.GET /api/user.shape', 'results', 'changed', shapeBefore, shapeAfter),
    ]);
    assert.equal(findings.length, 1);
    assert.match(findings[0].title, /"name"/, 'the JSON an agent reads must not be thinner than the English');
    assert.match(findings[0].title, /"fullName"/);
  });
});

describe('what is not a rename', () => {
  test('two fields gone and two arrived is a rewrite, and pairing them would be fiction', () => {
    const sentence = describeDifference(
      difference(
        'api.GET /api/user.shape',
        'results',
        'changed',
        { a: 'string', b: 'string', keep: 'number' },
        { keep: 'number', x: 'string', y: 'string' },
      ),
      1,
    );
    assert.doesNotMatch(sentence, /the same value is under/, 'guessing which of two became which of two is an invention');
  });

  test('one gone and one arrived holding DIFFERENT values is two edits side by side', () => {
    const sentence = describeDifference(
      difference(
        'api.GET /api/user.shape',
        'results',
        'changed',
        { id: 'number', name: 'string' },
        { count: 'number', id: 'number' },
      ),
      1,
    );
    assert.doesNotMatch(sentence, /the same value is under/);
  });

  test('a field dropped with nothing put in its place says it is gone, in those words', () => {
    // "now has "name" reading nothing" was the old sentence. It is not true — the reply does
    // not HAVE that field any more — and it is the loudest thing this tool can find.
    const sentence = describeDifference(
      difference(
        'api.GET /api/user.shape',
        'results',
        'changed',
        { address: 'string', avatar: 'string', created: 'string', email: 'string', id: 'number', name: 'string' },
        { address: 'string', avatar: 'string', created: 'string', email: 'string', id: 'number' },
      ),
      1,
    );
    assert.match(sentence, /has lost "name"/);
    assert.doesNotMatch(sentence, /now has "name"/, 'it does not have it — that is the whole finding');
  });

  test('a field added with nothing taken away says that, and does not claim a rename', () => {
    const sentence = describeDifference(
      difference(
        'api.GET /api/user.shape',
        'results',
        'changed',
        { address: 'string', avatar: 'string', created: 'string', email: 'string', id: 'number' },
        { address: 'string', avatar: 'string', created: 'string', email: 'string', id: 'number', nickname: 'string' },
      ),
      1,
    );
    assert.match(sentence, /gained "nickname"/);
    assert.doesNotMatch(sentence, /the same value is under/);
  });

  test('the same field names with a value that moved is untouched, as before', () => {
    // The tool's flagship example. This sentence was already right and has to stay right.
    const sentence = describeDifference(
      difference(
        'api.GET /invoice.body',
        'results',
        'changed',
        { line: 'A desk lamp ......... £49.99' },
        { line: 'A desk lamp ......... 49.99 GBP' },
      ),
      1,
    );
    assert.match(sentence, /"line"/);
    assert.match(sentence, /49\.99 GBP/);
    assert.match(sentence, /£49\.99/);
  });
});

// ---------------------------------------------------------------------------
// 2 — an address the record holds a value for is never "was not there before"
// ---------------------------------------------------------------------------

describe('the live old build cannot outvote the record about whether something existed', () => {
  /**
   * The situation, exactly as it was measured on 2026-08-31.
   *
   * The reference record is filed under the fingerprint of the tree that was WALKED. The old
   * build is later booted by a different key off the same reference — its git sha — and when
   * the reference was cut from a working tree with uncommitted changes those two name
   * different source trees. The booted build then has no route at that address at all.
   */
  const suspicions = [
    difference('api.GET /api/session.shape', 'results', 'changed', { token: 'string' }, { kind: 'string', token: 'string' }),
  ];
  const now = new Map([['GET /api/user', { a: { observations: [observed('api.GET /api/session.shape', { kind: 'string', token: 'string' })] } }]]);

  test('a silent live walk does not turn a recorded value into "was not there before"', () => {
    // The old build answered at ANOTHER address, so it was genuinely walked — this is not the
    // "nothing could be observed" case the filter above already catches.
    const live = new Map([['GET /api/user', { observations: [observed('api.GET /api/user.status', 200)] } ]]);
    const kept = proveAgainstLive(/** @type {any} */ (suspicions), /** @type {any} */ (live), /** @type {any} */ (now));
    assert.equal(kept.length, 1);
    assert.notEqual(kept[0].kind, 'appeared', 'the record says it was there, with a value, and the record is the evidence');
    assert.deepEqual(kept[0].reference, { token: 'string' }, 'the recorded value must survive — it is what the sentence is built from');
  });

  test('and it is not stamped as proven, because nothing proved it', () => {
    const live = new Map([['GET /api/user', { observations: [observed('api.GET /api/user.status', 200)] } ]]);
    const kept = proveAgainstLive(/** @type {any} */ (suspicions), /** @type {any} */ (live), /** @type {any} */ (now));
    assert.equal(kept[0].proven, false, 'a confident sentence over a silence is this tool\'s worst failure');
  });

  test('the sentence it ends up printing agrees with what is on disk', () => {
    // The record holds `{"token":"string"}` at this address. The honest sentence is that a
    // field was added to it — never that the address itself has just been invented.
    const live = new Map([['GET /api/user', { observations: [observed('api.GET /api/user.status', 200)] } ]]);
    const kept = proveAgainstLive(/** @type {any} */ (suspicions), /** @type {any} */ (live), /** @type {any} */ (now));
    const sentence = describeDifference(/** @type {any} */ (kept[0]), 1);
    assert.doesNotMatch(sentence, /is there now and was not before/, 'the record on disk holds a value for this address');
    assert.match(sentence, /gained "kind"/, 'what actually changed is one added field');
  });

  test('an address the record really did NOT have is still reported as appeared', () => {
    // The other half of the same rule. Absence in the record is what "was not there before"
    // is FOR, and blunting that would trade one silence for another.
    const brandNew = [difference('api.GET /api/session.trace', 'results', 'appeared', undefined, 'on')];
    const nowWithIt = new Map([['GET /api/user', { a: { observations: [observed('api.GET /api/session.trace', 'on')] } }]]);
    const live = new Map([['GET /api/user', { observations: [observed('api.GET /api/user.status', 200)] } ]]);
    const kept = proveAgainstLive(/** @type {any} */ (brandNew), /** @type {any} */ (live), /** @type {any} */ (nowWithIt));
    assert.equal(kept.length, 1);
    assert.equal(kept[0].kind, 'appeared');
    assert.equal(kept[0].proven, true);
  });

  test('a live build that answers differently is still drift, and is still subtracted', () => {
    // Nothing here may weaken the reason this function exists: the old build doing the same
    // thing today as the new one means there is no news.
    const drifting = [difference('api.GET /api/user.body', 'results', 'changed', { at: 'monday' }, { at: 'tuesday' })];
    const nowSame = new Map([['GET /api/user', { a: { observations: [observed('api.GET /api/user.body', { at: 'tuesday' })] } }]]);
    const live = new Map([['GET /api/user', { observations: [observed('api.GET /api/user.body', { at: 'tuesday' })] } ]]);
    const kept = proveAgainstLive(/** @type {any} */ (drifting), /** @type {any} */ (live), /** @type {any} */ (nowSame));
    assert.equal(kept.length, 0, 'the old build does this too, so it is not the change');
  });
});
