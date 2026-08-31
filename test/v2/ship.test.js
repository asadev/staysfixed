/**
 * Ship and check have to be talking about the same product.
 *
 * The name is not a label, it is the key: references are filed under it and builds are listed
 * by it. Two commands that work it out two different ways do not disagree politely — they
 * file into two drawers that never meet, and the project can sit like that for its entire
 * life, shipping and checking and never once comparing anything.
 *
 * Measured 2026-08-31 driving a native Windows app over ssh. `staysfixed ship` read `product`
 * out of the settings ONLY when the file ended in `.json`, and every settings file
 * `staysfixed init` writes is JavaScript. So:
 *
 *     settings say  product: "notepad"      package.json says  "win-proof"
 *     check records the run under            notepad
 *     ship blesses under                     win-proof   -> "Stays Fixed had never seen this build"
 *     every later check                      "no build of notepad is on record as working", exit 2
 *
 * `ship --product notepad` cut the reference immediately, which is the proof that the name
 * was the whole cause. Nothing anywhere said the two names disagreed.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { productNameFor, openStore, ensureStore, saveBuild, referencePointer } from '../../src/v2/store.js';
import { onShip } from '../../src/v2/ship.js';
import { recordCheck } from '../../src/v2/reference.js';
import { makeObservation } from '../../src/v2/observation.js';
import { saveCapture, newCaptureId } from '../../src/v2/store.js';
import { scratchDir, cleanUp } from '../support.mjs';

after(cleanUp);

/**
 * A project folder with a package.json and, optionally, a settings file of a given shape.
 *
 * @param {{settings?: string, settingsName?: string, packageName?: string}} spec
 * @returns {Promise<string>}
 */
async function project(spec) {
  const root = await scratchDir('staysfixed-ship-name');
  await fsp.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: spec.packageName ?? 'win-proof', version: '1.0.0', private: true }, null, 2),
  );
  if (spec.settings !== undefined) {
    await fsp.writeFile(path.join(root, spec.settingsName ?? 'staysfixed.config.js'), spec.settings);
  }
  return root;
}

// ---------------------------------------------------------------------------

describe('one reader for what this product is called', () => {
  test('a JavaScript settings file is read — the shape `staysfixed init` actually writes', async () => {
    const root = await project({ settings: "export default { product: 'notepad' };\n" });
    const naming = await productNameFor(root);
    assert.equal(naming.name, 'notepad', 'this is the bug: it used to fall straight through to the package name');
    assert.equal(naming.from, 'settings');
    assert.equal(naming.settings, 'notepad');
    assert.equal(naming.package, 'win-proof');
  });

  test('an .mjs settings file too', async () => {
    const root = await project({ settings: "export const config = { product: 'notepad' };\n", settingsName: 'staysfixed.config.mjs' });
    assert.equal((await productNameFor(root)).name, 'notepad');
  });

  test('a JSON settings file goes on working exactly as before', async () => {
    const root = await project({ settings: JSON.stringify({ product: 'notepad' }), settingsName: 'staysfixed.config.json' });
    assert.equal((await productNameFor(root)).name, 'notepad');
  });

  test('what the caller was told beats everything, and the folder is the last resort', async () => {
    const root = await project({ settings: "export default { product: 'notepad' };\n" });
    assert.equal((await productNameFor(root, { product: 'said-so' })).name, 'said-so');

    const bare = await scratchDir('staysfixed-nameless');
    const naming = await productNameFor(bare);
    assert.equal(naming.name, path.basename(bare));
    assert.equal(naming.from, 'folder');
  });

  test('a settings file that will not load never fails a release', async () => {
    const root = await project({ settings: 'this is not javascript {{{\n' });
    const naming = await productNameFor(root);
    assert.equal(naming.name, 'win-proof', 'it falls through to the package name rather than throwing');
    assert.equal(naming.settings, null);
  });
});

// ---------------------------------------------------------------------------

describe('ship files under the same name check does', () => {
  test('a build recorded by check under the settings name is found and blessed by ship', async () => {
    const root = await project({ settings: "export default { product: 'notepad' };\n" });
    const store = openStore({ root });
    await ensureStore(store);

    // What `check` leaves behind: a build filed under the name the settings give.
    const build = { id: 'build-1', product: 'notepad', version: '1.0.0' };
    await saveBuild(store, build, { captures: 2 });
    for (const run of /** @type {const} */ (['a', 'b'])) {
      await saveCapture(store, {
        id: newCaptureId(run),
        journey: 'greet',
        build,
        run,
        startedAt: new Date().toISOString(),
        durationMs: 1,
        observations: [makeObservation('cli.greet.stdout', 'results', 'hello')],
        complete: true,
      });
    }
    await recordCheck(store, { buildId: 'build-1', product: 'notepad', ok: true, findings: 0, unaccounted: 0 });

    const result = await onShip({ root, build: 'build-1', why: '1.0.0' });
    assert.equal(result.product, 'notepad', 'ship used to answer win-proof here, and then look in an empty drawer');
    assert.equal(result.cut, true, 'and so what "working" means never moved, on every release, forever');
    assert.equal((await referencePointer(store, 'notepad'))?.buildId, 'build-1', 'the pointer has to land in the drawer check reads from');
  });

  test('when nothing is found, ship says WHICH name it looked under and where the other one is', async () => {
    const root = await project({ settings: "export default { product: 'notepad' };\n" });
    const store = openStore({ root });
    await ensureStore(store);
    await saveBuild(store, { id: 'build-1', product: 'notepad', version: '1.0.0' });

    // Somebody wired the hook up with the package name, which is exactly what the old
    // `productName` would have handed them.
    const result = await onShip({ root, product: 'win-proof', why: '1.0.0' });
    assert.equal(result.cut, false);
    const said = `${result.summary} ${result.lines.join(' ')}`;
    assert.match(said, /no record of a build of win-proof/, '"Stays Fixed had never seen this build" named neither drawer');
    assert.match(said, /notepad/, 'and the other name is the answer, so it has to appear');
    assert.match(said, /staysfixed ship --product notepad/, 'with the one line that fixes it');
  });

  test('a genuinely unseen build is still reported as unseen, with no invented clash', async () => {
    const root = await project({ settings: "export default { product: 'notepad' };\n" });
    const store = openStore({ root });
    await ensureStore(store);

    const result = await onShip({ root, why: '1.0.0' });
    assert.equal(result.cut, false);
    const said = `${result.summary} ${result.lines.join(' ')}`;
    assert.match(said, /no record of a build of notepad/);
    assert.doesNotMatch(said, /filed under/, 'there is no other drawer here, and pointing at one would be a wrong answer');
  });
});
