/**
 * The naming rule for guards.
 *
 * A guard outlives the memory of the bug it was written for, so the name is the
 * whole handover. These tests are the rule: a table of names that must be
 * accepted, and one case for every reason a name is turned away.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkGuardName, NAME_RULE_EXPLAINER } from '../src/guard/name.js';

/** Names a person would actually write, all of which must be allowed. */
const GOOD = [
  'the sidebar still collapses',
  'prices still show two decimals',
  'logging out clears the session',
  'the export button still downloads a csv',
  'the empty state still explains itself',
  'a new session opens in under a second',
  'closing the last tab does not close the window',
  'the search box still finds a session by its name',
  'pasting into the terminal keeps the line breaks',
  'the update banner only appears once',
  'settings survive a restart',
  'two agents can run side by side',
];

/**
 * @param {unknown} name
 * @returns {import('../src/guard/name.js').NameVerdict}
 */
function refused(name) {
  const verdict = checkGuardName(name);
  assert.equal(verdict.ok, false, `expected ${JSON.stringify(name)} to be refused`);
  assert.ok(typeof verdict.why === 'string' && verdict.why.length > 0, 'a refusal has to say why');
  return verdict;
}

describe('names that must be allowed', () => {
  for (const name of GOOD) {
    test(JSON.stringify(name), () => {
      assert.deepEqual(checkGuardName(name), { ok: true });
    });
  }

  test('a name right at the length limit is still allowed', () => {
    const name = 'the sidebar still collapses ' + 'x'.repeat(120 - 'the sidebar still collapses '.length);
    assert.equal(name.length, 120);
    assert.equal(checkGuardName(name).ok, true);
  });
});

describe('names that must be refused', () => {
  test('nothing at all', () => {
    for (const empty of ['', '   ', null, undefined, 42, {}, []]) {
      assert.match(String(refused(empty).why), /A guard needs a name/);
    }
  });

  test('a paragraph', () => {
    const verdict = refused('x'.repeat(121));
    assert.match(String(verdict.why), /121 characters long/);
    assert.match(String(verdict.why), /"because"/);
    assert.equal(verdict.suggestion, undefined, 'there is nothing honest to suggest here');
  });

  test('a file name', () => {
    for (const name of ['src/sidebar.test.js', 'sidebar.js', 'tests\\sidebar_spec.rb', 'sidebar.py']) {
      assert.match(String(refused(name).why), /looks like a file name/);
    }
  });

  test('an issue number', () => {
    for (const name of ['482', '#482', 'ABC-123', 'BUG_77', 'issue 91']) {
      assert.match(String(refused(name).why), /issue number/);
    }
  });

  test('an issue number gets no suggestion, because it says nothing to rewrite', () => {
    assert.equal(refused('#482').suggestion, undefined);
  });

  test('a code reference', () => {
    assert.match(String(refused('Foo::bar').why), /read like code references/);
    assert.match(String(refused('Sidebar#collapse').why), /read like code references/);
  });

  test('shouting', () => {
    const verdict = refused('THE SIDEBAR STILL COLLAPSES');
    assert.match(String(verdict.why), /ALL CAPS/);
    assert.equal(verdict.suggestion, 'the sidebar still collapses');
  });

  test('a code identifier', () => {
    for (const name of ['sidebar_collapse_test', 'sidebarCollapseTest', 'sidebar-collapse', 'sidebar.collapse']) {
      const verdict = checkGuardName(name);
      assert.equal(verdict.ok, false, name);
      assert.ok(
        /code identifier/.test(String(verdict.why)) || /file name/.test(String(verdict.why)),
        `${name}: ${verdict.why}`,
      );
    }
  });

  test('test-speak at the front', () => {
    for (const name of [
      'test the sidebar collapse',
      'should collapse the sidebar',
      'it collapses the sidebar',
      'verifies the sidebar collapses',
      'checks that the sidebar collapses',
      'ensure the sidebar collapses',
    ]) {
      assert.match(String(refused(name).why), /describes a test, not the app/);
    }
  });

  test('fewer than three words', () => {
    assert.match(String(refused('sidebar').why), /only 1 word\./);
    assert.match(String(refused('sidebar collapses').why), /only 2 words\./);
  });
});

describe('the rewrites it offers', () => {
  test('an identifier becomes the sentence somebody meant to write', () => {
    assert.equal(checkGuardName('sidebar_collapse_test').suggestion, 'the sidebar still collapses');
    assert.equal(checkGuardName('sidebarCollapseTest').suggestion, 'the sidebar still collapses');
    assert.equal(checkGuardName('sidebar-collapse').suggestion, 'the sidebar still collapses');
  });

  test('a plural subject keeps its grammar', () => {
    assert.equal(checkGuardName('prices_show_test').suggestion, 'the prices still show');
  });

  test('a test word at the front is simply dropped when nothing better is available', () => {
    assert.equal(checkGuardName('should collapse the sidebar').suggestion, 'collapse the sidebar');
  });

  test('every suggestion it makes would itself be accepted', () => {
    const tries = [
      'sidebar_collapse_test',
      'sidebarCollapseTest',
      'sidebar-collapse',
      'THE SIDEBAR STILL COLLAPSES',
      'Sidebar#collapse',
      'should collapse the sidebar',
      'test the sidebar collapse',
      'export_button_download_spec',
      'session-restore-regression',
      'tab_close_bug',
      'settings_persist_e2e',
    ];
    for (const name of tries) {
      const { suggestion } = checkGuardName(name);
      if (suggestion === undefined) continue;
      assert.deepEqual(
        checkGuardName(suggestion),
        { ok: true },
        `it suggested ${JSON.stringify(suggestion)} for ${JSON.stringify(name)}, which it would then refuse`,
      );
    }
  });

  test('it says nothing rather than guessing a verb it does not know', () => {
    // "validation" is a noun; inventing "the login form still validations" is
    // exactly the kind of confident nonsense people accept without reading.
    assert.equal(checkGuardName('login_form_validation').suggestion, undefined);
  });
});

describe('the explainer', () => {
  test('is written for a person, not for a linter', () => {
    assert.ok(NAME_RULE_EXPLAINER.length > 200);
    assert.match(NAME_RULE_EXPLAINER, /the sidebar still collapses/);
    assert.ok(!/regex|regexp|assertion|token|camelCase/i.test(NAME_RULE_EXPLAINER), NAME_RULE_EXPLAINER);
  });
});
