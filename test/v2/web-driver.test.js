/**
 * The browser the walk actually opens.
 *
 * These tests exist because of a real failure, not a hypothetical one. `playwright` was
 * removed from this package's dependencies on the reasonable-looking grounds that nothing
 * under `src/` imported it. Nothing does, statically — `web-driver.js` reaches it through
 * `await import('playwright')`, and a search for a static import cannot see that.
 *
 * What shipped was 0.7.2, which told every agent that asked that web apps and sites could be
 * checked "here and now", and then answered every website check with "Playwright is not
 * installed, so no web page can be opened". The tool being wrong about its own headline
 * ability is the worst failure this product has, because the whole point of it is to be the
 * thing you believe when it says something still works.
 *
 * So the dependency is held in place by name here, and the two answers that must agree —
 * what `doctor` says about a browser and what the walk can actually do — are checked against
 * each other rather than each against a guess.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, runStep } from '../../src/v2/adapters/web-driver.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

describe('a step that does nothing says so', () => {
  /** Enough of a page to prove which calls were made, and no more. */
  const stubPage = () => {
    /** @type {string[]} */
    const did = [];
    return {
      did,
      async goto(/** @type {string} */ u) { did.push(`goto ${u}`); },
      async click(/** @type {string} */ w) { did.push(`click ${w}`); },
      async type(/** @type {string} */ w, /** @type {string} */ t) { did.push(`type ${w} ${t}`); },
      async press(/** @type {string} */ k) { did.push(`press ${k}`); },
      async hover(/** @type {string} */ w) { did.push(`hover ${w}`); },
      async scrollTo(/** @type {string} */ w) { did.push(`scrollTo ${w}`); },
      async waitFor(/** @type {string} */ w) { did.push(`waitFor ${w}`); },
      async waitForGone(/** @type {string} */ w) { did.push(`waitForGone ${w}`); },
      async wait(/** @type {number} */ ms) { did.push(`wait ${ms}`); },
      async evaluate(/** @type {string} */ x) { did.push(`evaluate ${x}`); },
    };
  };

  test('a word the tool does not know is refused, not skipped in silence', async () => {
    // `staysfixed init` shipped exactly this as its sign-in example: `fill` and `with`,
    // neither of which is in the vocabulary. The step was skipped without a word, so the
    // form was never filled, Sign in was clicked on an empty form, and every screen behind
    // the login wall photographed the login page — and the run came back clean.
    const page = stubPage();
    await assert.rejects(
      () => runStep(/** @type {any} */ (page), { fill: '#email', with: 'a@b.c' }),
      (/** @type {any} */ error) => {
        assert.match(String(error.message), /does nothing/);
        assert.match(String(error.message), /`fill`/, 'it has to name the word it did not know');
        assert.match(String(error.message), /type/, 'and the word it should have been');
        return true;
      },
    );
    assert.deepEqual(page.did, [], 'and nothing was done to the page');
  });

  test('the vocabulary it does know still works, and typing carries its text', async () => {
    const page = stubPage();
    const did = await runStep(/** @type {any} */ (page), { type: '#email', text: 'a@b.c' });
    assert.deepEqual(page.did, ['type #email a@b.c']);
    assert.equal(did.length, 1);
  });

  test('a step carrying only a note is not an error', async () => {
    const page = stubPage();
    const did = await runStep(/** @type {any} */ (page), { name: 'just a label' });
    assert.deepEqual(did, []);
  });
});

describe('the browser driver', () => {
  test('a driver is a real dependency of this package, not something a stranger has to know to install', async () => {
    const pkg = JSON.parse(await fsp.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    const deps = pkg.dependencies ?? {};
    const has = 'playwright-core' in deps || 'playwright' in deps;
    assert.ok(
      has,
      'Neither playwright-core nor playwright is in dependencies. web-driver.js loads one of them with a dynamic import(), '
      + 'which no grep for an import statement will find — removing it makes every website check fail on a fresh install '
      + 'while capabilities still claims web pages can be read.',
    );
  });

  test('the driver loads, and says which browser it would open', async () => {
    const state = await loadPlaywright({});
    // On a machine with no browser at all this is a legitimate "no". What is never legitimate
    // is not being able to load the driver, because that is the package this repo depends on.
    assert.notEqual(state.state, 'no package', `the driver package itself did not load: ${state.why}`);
    assert.equal(typeof state.why, 'string');
    assert.ok(state.why.length > 0);
    if (state.ok) {
      assert.ok(state.executable, 'it said pages can be opened without naming a browser to open them with');
      await assert.doesNotReject(fsp.access(String(state.executable)), 'it named a browser that is not on disk');
    } else {
      assert.equal(state.state, 'no browser');
      assert.ok(state.howToGet, 'it refused without saying what would fix it');
    }
  });

  test('when it cannot open a page it says the one command that fixes it, and that command installs nothing into your project', async () => {
    const { INSTALL_COMMAND } = await import('../../src/v2/browsers.js');
    assert.ok(!/--save-dev|npm install/.test(INSTALL_COMMAND),
      `the fix must not put a package into a stranger's dependencies to solve a problem this tool already solved: ${INSTALL_COMMAND}`);
    assert.match(INSTALL_COMMAND, /playwright install/);
  });

  test('doctor and the walk give the same answer about whether a page can be opened', async () => {
    const { capabilities } = await import('../../src/v2/doctor.js');
    const [state, caps] = await Promise.all([loadPlaywright({}), capabilities({ cwd: repoRoot })]);
    const probe = (caps.tools ?? []).find((t) => t && t.id === 'playwright');
    if (!probe) return; // the shape of the report is another test's business
    assert.equal(
      Boolean(probe.found), Boolean(state.ok),
      `doctor says a browser is ${probe.found ? 'there' : 'missing'} and the walk says ${state.ok ? 'it can open a page' : 'it cannot'}. `
      + 'These two disagreeing is exactly the bug that shipped in 0.7.2.',
    );
  });
});
