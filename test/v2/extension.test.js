/**
 * Browser extensions, without a browser.
 *
 * Everything in here runs against fixture data on disk, on purpose. The manifest half of the
 * extension surface — the permissions, the sites it may touch, the pages it declares, the
 * addresses its content scripts run on — is the half that needs no browser at all, and it is
 * the half that catches the change a person most needs to be told about: an extension whose
 * reach quietly widened from one named site to every site on the internet.
 *
 * The browser half is proved by running it. What is held here is the reasoning: what the
 * adapter decides, what it refuses to guess, and the two facts it must never write down —
 * the extension's id, which a browser makes out of the folder it was loaded from and which is
 * therefore different for every build, and the version number, which changes on every release.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  addressForMatch, chromiumThatLoads, contentScriptTargets, declaredPages, differenceMade,
  extensionAdapter, findExtension, howWideTheReachIs, idForUnpacked, manifestContract,
  readManifest, shapeOfAVersion, standInPage, suppliedPageFor, withoutTheId,
} from '../../src/v2/adapters/extension.js';
import { checkAdapter } from '../../src/v2/adapters/contract.js';
import { CHANNELS } from '../../src/v2/observation.js';

/** A manifest with one of everything worth watching in it. */
const NOTEWELL = {
  manifest_version: 3,
  name: 'Notewell',
  version: '1.0.0',
  description: 'Keeps notes.',
  permissions: ['storage'],
  host_permissions: ['https://example.com/*'],
  action: { default_popup: 'popup.html' },
  options_page: 'options.html',
  background: { service_worker: 'background.js' },
  content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'], run_at: 'document_idle' }],
};

/**
 * Write a folder that really is an extension, so the adapter can be asked about a real one.
 *
 * @param {Record<string, any>|string} manifest  A string here is a manifest that is meant to be broken.
 * @param {Record<string, string>} [files]
 * @returns {Promise<string>}
 */
async function anExtension(manifest, files = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-ext-test-'));
  await fsp.writeFile(path.join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2));
  for (const [name, body] of Object.entries({ 'popup.html': '<h1>Notewell</h1>', 'options.html': '<h1>Options</h1>', 'background.js': '', 'content.js': '', ...files })) {
    await fsp.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fsp.writeFile(path.join(dir, name), body);
  }
  return dir;
}

/** @param {{path: string[], value: any, says: string}[]} facts @param {string} at */
const valueAt = (facts, at) => facts.find((f) => f.path.join(' / ') === at)?.value;

// ---------------------------------------------------------------------------

describe('the adapter is one the engine will hold', () => {
  test('it says which of the seven channels it fills, and they are real ones', () => {
    assert.deepEqual(checkAdapter(extensionAdapter), [], 'the engine refuses an adapter with anything wrong with it');
    for (const channel of extensionAdapter.channels) {
      assert.ok(CHANNELS.includes(channel), `"${channel}" is not one of the seven`);
    }
  });

  test('what it says it cannot see is written down where an agent will read it', () => {
    // The describe line is the first thing an agent installing this reads, and a surface that
    // claims four parts and checks two is the exact failure this tool exists to prevent.
    assert.match(extensionAdapter.describe, /cannot read what the background worker logs/i);
    assert.match(extensionAdapter.describe, /stand-in/i);
    assert.match(extensionAdapter.describe, /never visits a real site/i);
  });
});

describe('reading a manifest', () => {
  test('a manifest that is not JSON says so, and says a browser would refuse it', () => {
    const read = readManifest('{ "manifest_version": 3, ');
    assert.equal(read.ok, false);
    assert.match(read.why, /not valid JSON/);
    assert.match(read.why, /refuse to load/, 'the consequence matters more than the syntax error');
  });

  test('a web app manifest is not an extension manifest', () => {
    const read = readManifest(JSON.stringify({ name: 'My site', icons: [], start_url: '/' }));
    assert.equal(read.ok, false);
    assert.match(read.why, /manifest_version/);
  });

  test('a manifest that IS there and broken is never reported as a missing one', async () => {
    // Measured on 2026-08-31: a truncated manifest.json was reported as "there is no
    // manifest.json anywhere this looks", which sends whoever reads it looking for a folder
    // instead of at the one broken line.
    const dir = await anExtension('{ "manifest_version": 3, ');
    const found = findExtension(dir);
    assert.equal(found.file, path.join(dir, 'manifest.json'), 'the file it found is the file that is there');
    assert.doesNotMatch(found.why, /no manifest\.json anywhere/);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('a folder with nothing in it says there is nothing to load', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-empty-'));
    const found = findExtension(dir);
    assert.equal(found.dir, null);
    assert.match(found.why, /no manifest\.json/);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('a built folder is preferred over a source one, because the browser loads the built one', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-built-'));
    await fsp.mkdir(path.join(dir, 'dist'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'dist', 'manifest.json'), JSON.stringify(NOTEWELL));
    const found = findExtension(dir);
    assert.equal(found.dir, path.join(dir, 'dist'));
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe('the manifest as a contract', () => {
  test('every permission gets an address of its own, so a new one is a NEW address', () => {
    const facts = manifestContract(NOTEWELL);
    assert.equal(valueAt(facts, 'what it is allowed to do / storage'), true);
    // If permissions were one list, adding "tabs" would report the whole list as changed with
    // the new one somewhere inside it. One address each is how the report says who added what.
    const widened = manifestContract({ ...NOTEWELL, permissions: ['storage', 'tabs'] });
    assert.equal(valueAt(widened, 'what it is allowed to do / tabs'), true);
    assert.equal(valueAt(facts, 'what it is allowed to do / tabs'), undefined);
  });

  test('a permission is explained in words, not left as a word for programmers', () => {
    const facts = manifestContract({ ...NOTEWELL, permissions: ['tabs', 'management', 'debugger'] });
    /** @param {string} name */
    const says = (name) => facts.find((f) => f.path.join(' / ') === `what it is allowed to do / ${name}`)?.says ?? '';
    assert.match(says('tabs'), /every tab you have open/);
    assert.match(says('management'), /uninstall your other extensions/);
    assert.match(says('debugger'), /total control/);
  });

  test('how wide its reach is, is a fact of its own', () => {
    // The line somebody actually reads. A host permission widening from one site to all sites
    // in a list of forty is invisible; one short line going from "one named site" to
    // "every site" is not.
    assert.equal(howWideTheReachIs(['https://example.com/*']).value, 'one named site');
    assert.equal(howWideTheReachIs(['https://a.com/*', 'https://b.com/*']).value, '2 named sites');
    assert.equal(howWideTheReachIs(['<all_urls>']).value, 'every site');
    assert.equal(howWideTheReachIs(['*://*/*']).value, 'every site');
    assert.equal(howWideTheReachIs(['https://*/*']).value, 'every site');
    assert.equal(howWideTheReachIs([]).value, 'no sites');
    assert.match(howWideTheReachIs(['<all_urls>']).says, /your bank/, 'it has to say what that means');
  });

  test('a subdomain wildcard is counted as its site, not as a new one', () => {
    assert.equal(howWideTheReachIs(['https://*.github.com/*', 'https://github.com/*']).value, 'one named site');
  });

  test('the version NUMBER is never compared, only its shape', () => {
    // Every release changes the version. A check that complains on every release is a check
    // nobody reads, and this tool's whole value is being believed when it does complain.
    const facts = manifestContract(NOTEWELL);
    const values = facts.map((f) => JSON.stringify(f.value));
    assert.ok(!values.includes('"1.0.0"'), 'the version number itself must not be written down');
    assert.equal(valueAt(facts, 'the shape of its version'), '3 numbers separated by dots');
    assert.equal(shapeOfAVersion('2.1'), '2 numbers separated by dots');
    assert.equal(shapeOfAVersion(''), 'nothing at all');
    assert.equal(shapeOfAVersion('v3-beta'), 'something that is not a plain dotted version number');
  });

  test('manifest v2 host permissions are read too, because half the extensions in the world are v2', () => {
    const v2 = { manifest_version: 2, name: 'Old', version: '1.0', permissions: ['storage', 'https://example.com/*'], browser_action: { default_popup: 'popup.html' } };
    const facts = manifestContract(v2);
    assert.equal(valueAt(facts, 'which sites it may touch / https://example.com/*'), true);
    assert.equal(valueAt(facts, 'how wide its reach is'), 'one named site');
  });

  test('what other pages may load out of it is watched, because widening that is widening a permission', () => {
    const facts = manifestContract({ ...NOTEWELL, web_accessible_resources: [{ resources: ['banner.css'], matches: ['<all_urls>'] }] });
    assert.deepEqual(valueAt(facts, 'what other pages may load out of it / banner.css'), ['<all_urls>']);
  });

  test('who may talk to it from an ordinary web page is watched', () => {
    const facts = manifestContract({ ...NOTEWELL, externally_connectable: { matches: ['https://partner.example/*'] } });
    assert.deepEqual(valueAt(facts, 'who may talk to it from outside'), ['https://partner.example/*']);
  });
});

describe('the pages an extension declares', () => {
  test('both manifest versions are read, so a v2 extension does not look like one with no pages', () => {
    assert.deepEqual(declaredPages(NOTEWELL), [{ what: 'the popup', file: 'popup.html' }, { what: 'the options page', file: 'options.html' }]);
    const v2 = { manifest_version: 2, browser_action: { default_popup: 'popup.html' }, options_ui: { page: 'settings.html' } };
    assert.deepEqual(declaredPages(v2), [{ what: 'the popup', file: 'popup.html' }, { what: 'the options page', file: 'settings.html' }]);
  });

  test('a side panel, a devtools page and a page it puts over a browser page all count', () => {
    const pages = declaredPages({
      manifest_version: 3,
      side_panel: { default_path: 'panel.html' },
      devtools_page: 'devtools.html',
      chrome_url_overrides: { newtab: 'newtab.html' },
    });
    assert.deepEqual(pages.map((p) => p.file).sort(), ['devtools.html', 'newtab.html', 'panel.html']);
  });

  test('something that is not a page is not counted as one', () => {
    assert.deepEqual(declaredPages({ manifest_version: 3, action: { default_icon: 'icon.png' }, options_page: '' }), []);
  });
});

describe('the address a content script is tried against', () => {
  test('the manifest names it, and it is used as written', () => {
    const at = addressForMatch('https://mail.example.com/inbox/*');
    assert.equal(at.url, 'https://mail.example.com/inbox/');
    assert.equal('exact' in at && at.exact, true);
  });

  test('a wildcard subdomain becomes the site itself', () => {
    assert.equal(addressForMatch('*://*.github.com/*').url, 'https://github.com/');
  });

  test('"every site" gets one stand-in address, and says out loud that it is one', () => {
    for (const pattern of ['<all_urls>', '*://*/*', 'https://*/*']) {
      const at = addressForMatch(pattern);
      assert.equal(at.url, 'https://example.com/');
      assert.equal('exact' in at && at.exact, false, 'it is a stand-in, not the address itself');
      assert.match(at.why, /every site|every host/i);
    }
  });

  test('a content script on your own files is a hole, not a guess', () => {
    // A browser only lets an extension touch file:// after somebody ticks a box by hand, so
    // there is no honest way to check it here. Saying so is the answer; pretending is not.
    const at = addressForMatch('file:///*');
    assert.equal(at.url, null);
    assert.match(at.why, /files on your own disk/);
  });

  test('one address per content script, not one per pattern', () => {
    // A script listing twelve subdomains is one behaviour. Twelve near-identical journeys
    // would treble the length of the report to say the same thing twelve times.
    const targets = contentScriptTargets({
      content_scripts: [{ matches: ['https://a.example/*', 'https://b.example/*', 'https://c.example/*'], js: ['a.js'] }],
    });
    assert.equal(targets.length, 1);
    assert.equal(targets[0].url, 'https://a.example/');
  });

  test('a real address is preferred over a stand-in when a script names both', () => {
    const targets = contentScriptTargets({ content_scripts: [{ matches: ['<all_urls>', 'https://real.example/*'], js: ['a.js'] }] });
    assert.equal(targets[0].url, 'https://real.example/');
    assert.equal(targets[0].exact, true);
  });

  test('a content script that names no pages at all is reported, never dropped', () => {
    const targets = contentScriptTargets({ content_scripts: [{ js: ['a.js'] }] });
    assert.equal(targets.length, 1);
    assert.equal(targets[0].url, null);
    assert.match(targets[0].why, /does not say which pages/);
  });

  test('the stand-in page is the same on every machine and says what it is', () => {
    const page = standInPage('https://mail.example.com/inbox/');
    assert.equal(page, standInPage('https://mail.example.com/inbox/'));
    assert.match(page, /stand-in page served from this machine/);
    assert.match(page, /mail\.example\.com/);
  });

  test('a page the project supplied is matched by address, and failing that by site', () => {
    const config = { pages: [{ url: 'https://example.com/one', file: 'one.html' }] };
    assert.equal(suppliedPageFor(config, 'https://example.com/one')?.file, 'one.html');
    assert.equal(suppliedPageFor(config, 'https://example.com/two')?.file, 'one.html', 'same site is close enough to be worth using');
    assert.equal(suppliedPageFor(config, 'https://elsewhere.example/')?.file, undefined);
  });
});

describe('what the extension did to the page', () => {
  /** @param {string[]} names */
  const asAPage = (names) => names.map((name) => ({ at: [name], role: 'button', name, value: name, states: {}, describe: `a button called "${name}"` }));

  test('what it adds, what it takes away, and what it rewrites are three different answers', () => {
    const before = asAPage(['Sign in', 'Help']);
    const after = [...asAPage(['Sign in', 'Save to Notewell']), { at: ['Help'], role: 'button', name: 'Help', value: 'Help me', states: {}, describe: 'a button' }];
    const difference = differenceMade(before, after);
    assert.deepEqual(difference.added.map((e) => e.name), ['Save to Notewell']);
    assert.deepEqual(difference.removed.map((e) => e.name), []);
    assert.deepEqual(difference.changed.map((c) => c.at), ['Help']);
  });

  test('an extension that takes something OFF somebody else\'s page is reported on its own', () => {
    const difference = differenceMade(asAPage(['Adverts', 'Sign in']), asAPage(['Sign in']));
    assert.deepEqual(difference.removed.map((e) => e.name), ['Adverts']);
  });

  test('adding something at the top does not report the rest of the page as changed', () => {
    // Addressed by what a thing IS and what it SAYS, never by where it sits. A banner
    // prepended to a page shifts everything below it, and addressing by position would report
    // the entire page as different every single time.
    const before = asAPage(['One', 'Two', 'Three']);
    const after = asAPage(['Banner', 'One', 'Two', 'Three']);
    const difference = differenceMade(before, after);
    assert.equal(difference.added.length, 1);
    assert.equal(difference.changed.length, 0);
    assert.equal(difference.removed.length, 0);
  });

  test('an extension that changes nothing is a difference of nothing', () => {
    const same = asAPage(['One', 'Two']);
    const difference = differenceMade(same, same);
    assert.deepEqual([difference.added.length, difference.removed.length, difference.changed.length], [0, 0, 0]);
  });
});

describe('the extension id is never a fact about the product', () => {
  test('the id is worked out from the folder, the way a browser works it out', () => {
    // Chrome hashes the folder's real path. Two builds of one comparison live in two
    // different scratch folders, which is exactly why this must never be compared.
    const dir = fs.realpathSync(os.tmpdir());
    const id = idForUnpacked(dir);
    assert.match(id, /^[a-p]{32}$/, 'an extension id is thirty-two letters between a and p');
    assert.equal(idForUnpacked(dir), id, 'the same folder always gives the same id');
    assert.notEqual(idForUnpacked(path.join(dir, 'somewhere-else')), id, 'a different folder gives a different one');
  });

  test('the id is taken out of anything written down', () => {
    const id = 'gikmlpjmmpijablmaoiipopgpogdbjki';
    const said = `Uncaught error at chrome-extension://${id}/popup.js:4`;
    assert.equal(withoutTheId(said, id), 'Uncaught error at chrome-extension://the-extension/popup.js:4');
  });

  test('an id nobody handed us is still taken out', () => {
    // The address is recognisable on its own — thirty-two letters between a and p — so a
    // message that mentions an id we were never told about is cleaned up too.
    const said = 'blocked chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.js';
    assert.equal(withoutTheId(said, null), 'blocked chrome-extension://the-extension/x.js');
  });
});

describe('loading the extension into the browser', () => {
  test('the flag that switches extensions off is taken out, and the one that loads ours put in', () => {
    /** @type {any} */
    let got = null;
    const fake = { launchPersistentContext: async (/** @type {string} */ _dir, /** @type {any} */ options) => { got = options; return {}; } };
    const wrapped = chromiumThatLoads(fake, '/somewhere/the-extension');
    return wrapped.launchPersistentContext('/profile', { args: ['--no-first-run', '--disable-extensions'], serviceWorkers: 'block' }).then(() => {
      assert.ok(!got.args.includes('--disable-extensions'), 'that flag is exactly what would stop this working');
      assert.ok(got.args.includes('--disable-extensions-except=/somewhere/the-extension'), 'and no OTHER extension may load — that promise is kept');
      assert.ok(got.args.includes('--load-extension=/somewhere/the-extension'));
      assert.ok(got.args.includes('--no-first-run'), 'everything else the window opener asked for survives');
      assert.equal(got.serviceWorkers, 'allow', 'a background worker IS a service worker — blocking them switches off half the product');
    });
  });

  test('with no extension to load, the browser driver is handed over untouched', () => {
    const fake = { launchPersistentContext: async () => ({}) };
    assert.equal(chromiumThatLoads(fake, null), fake, 'the window with no extension in it must be an ordinary window');
  });
});

describe('what it says about a project before it runs anything', () => {
  test('a project with no manifest is not an extension, and says what would make it one', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-none-'));
    const detection = await extensionAdapter.detect({ root: dir, config: {} });
    assert.equal(detection.applies, false);
    assert.equal(detection.missing[0].blocking, true);
    assert.match(String(detection.missing[0].howToGet), /"dir"/);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('a file the manifest names that is not in the folder is named before anything is run', async () => {
    // A browser refuses an extension whose manifest names a file that is not there, and the
    // reason is much easier to act on now than after a run that could not open anything.
    const dir = await anExtension(NOTEWELL);
    await fsp.rm(path.join(dir, 'content.js'));
    const detection = await extensionAdapter.detect({ root: dir, config: {} });
    const said = detection.missing.map((m) => m.what).join(' ');
    assert.match(said, /content\.js/);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('it says out loud that the page a content script is tried against is a stand-in', async () => {
    const dir = await anExtension(NOTEWELL);
    const detection = await extensionAdapter.detect({ root: dir, config: {} });
    assert.ok(detection.missing.some((m) => /what the real page looks like/.test(m.what)));
    assert.ok(detection.notes?.some((n) => /content script that quietly stopped firing|with the extension and once without/i.test(n)));
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe('the journeys it makes', () => {
  test('one for the manifest, one per page, one per content script, one for the background', async () => {
    const dir = await anExtension(NOTEWELL);
    const journeys = await extensionAdapter.journeys({ root: dir, config: {} });
    assert.deepEqual(journeys.map((j) => j.name), [
      'the manifest',
      'the popup',
      'the options page',
      'what it does to https://example.com/',
      'the background worker',
    ]);
    assert.deepEqual(journeys[0].channels, ['contract'], 'the manifest needs no browser, so it fills one channel and claims no more');
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('a content script nothing can be tried against becomes a hole, never a missing journey', async () => {
    // A journey that is simply not listed is never walked, never counted and never missed —
    // which reads exactly like a journey that passed.
    const dir = await anExtension({ ...NOTEWELL, content_scripts: [{ matches: ['file:///*'], js: ['content.js'] }] });
    const journeys = await extensionAdapter.journeys({ root: dir, config: {} });
    const hole = journeys.find((j) => j.skip);
    assert.ok(hole, 'it has to be there, saying it was not checked');
    assert.match(String(hole?.skip), /not tried/);
    assert.match(String(hole?.skip), /is not in the count/);
    assert.deepEqual(hole?.channels, [], 'a journey that walked nothing claims no channels');
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('a manifest a browser would refuse produces one journey that says so, not silence', async () => {
    const dir = await anExtension('{ "manifest_version": 3, ');
    const journeys = await extensionAdapter.journeys({ root: dir, config: {} });
    assert.equal(journeys.length, 1);
    assert.match(String(journeys[0].skip), /not valid JSON/);
    assert.match(String(journeys[0].skip), /a hole, not a pass/);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('an extension with no background worker gets no background journey to fail', async () => {
    const { background, ...noBackground } = NOTEWELL;
    const dir = await anExtension(noBackground);
    const journeys = await extensionAdapter.journeys({ root: dir, config: {} });
    assert.ok(!journeys.some((j) => j.name === 'the background worker'));
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe('a build that could not be prepared never reads as a build that was fine', () => {
  test('every journey handed a build that is not ready comes back as not checked', async () => {
    const journey = { name: 'the popup', describe: 'open the popup', source: 'code', surface: 'extension', channels: ['meaning'], steps: [{ kind: 'page', file: 'popup.html' }] };
    const build = { build: { id: 'nope', label: 'x', role: 'candidate', root: '/nowhere' }, root: '/nowhere', ready: false, why: 'The manifest is not valid JSON.', dispose: async () => {} };
    const out = await extensionAdapter.run(/** @type {any} */ (journey), /** @type {any} */ (build), /** @type {any} */ ({ scratchDir: '/tmp', evidenceDir: '/tmp', seed: 1, clock: '2026-08-29T09:00:00.000Z' }));
    assert.equal(out.length, 1);
    assert.equal(out[0].meta?.refused, true, 'it is a hole');
    assert.match(String(out[0].meta?.describe), /not valid JSON/, 'and it repeats the reason rather than shrugging');
  });
});
