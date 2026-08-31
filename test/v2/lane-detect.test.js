/**
 * Two ways detection found the wrong thing, and both of them ended in a clean run nobody had
 * earned.
 *
 * THE SERVER NOBODY READ. The source reader is aimed at a list of folders and reads those and
 * nothing else. A project whose whole server is `server.js` at the top level, with a `src/`
 * folder beside it holding something unrelated, had its server never opened. Measured on a
 * four-route express server: four routes with no `src/` folder, zero routes the moment an
 * unrelated `src/` existed. Downstream, a deleted route and a route that had started returning
 * 500 both came back "Nothing that worked has changed", exit 0.
 *
 * THE PRODUCT THAT DOES NOT EXIST. Both server readings open files three folders deep, which
 * is right for a product folder and wrong for a shelf. In a workspaces monorepo,
 * `packages/api/src/server.js` was read as evidence about `packages/` itself, and a folder
 * that ships nothing was announced as "the server in packages/" at 0.8 confidence — sitting in
 * the list beside the real products. The same routes then made the repository ROOT "the
 * server" as well: three products reported where two exist.
 *
 * Every test below was run against the code as it was before this lane and fails on it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { detectProject } from '../../src/v2/detect.js';

/** Every folder this file made, cleaned up at the end. */
/** @type {string[]} */
const made = [];

/**
 * Write a whole little product to disk and detect it, the way somebody's repository arrives.
 * @param {string} label
 * @param {Record<string, string>} files
 */
const productOf = async (label, files) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `staysfixed-lane-detect-${label}-`));
  made.push(root);
  for (const [name, text] of Object.entries(files)) {
    await fsp.mkdir(path.join(root, path.dirname(name)), { recursive: true });
    await fsp.writeFile(path.join(root, name), text);
  }
  return await detectProject({ root });
};

/** The four-route express server that started this. */
const EXPRESS_SERVER = `import express from 'express';
const app = express();
app.get('/api/orders', (req, res) => res.json([]));
app.get('/api/orders/:id', (req, res) => res.json({ id: req.params.id }));
app.post('/api/orders', (req, res) => res.status(201).json({ ok: true }));
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.listen(process.env.PORT || 3000);
`;

/** A server on node's own http module, which is what a package inside a monorepo often is. */
const BARE_SERVER = `import http from 'node:http';
const server = http.createServer((req, res) => res.end('ok'));
server.listen(process.env.PORT || 4000);
`;

test.after(async () => {
  for (const root of made) await fsp.rm(root, { recursive: true, force: true });
});

describe('a server at the top level, with folders beside it', () => {
  test('its routes are read even though the project also has a src/ folder', async () => {
    const shape = await productOf('rootserver', {
      'package.json': '{"name":"shopdesk","type":"module","main":"server.js","scripts":{"start":"node server.js"},"dependencies":{"express":"^4.19.0"}}',
      'server.js': EXPRESS_SERVER,
      'src/ui/format.js': 'export const money = (n) => `$${n.toFixed(2)}`;\n',
    });

    assert.equal(shape.doors.route, 4, 'the routes are in server.js at the top level, and a src/ folder beside it must not hide them');
    assert.deepEqual(
      shape.routes.map((r) => `${r.method} ${r.name}`).sort(),
      ['GET /api/health', 'GET /api/orders', 'GET /api/orders/:id', 'POST /api/orders'],
      'every route by name, because a count alone cannot notice which one was deleted',
    );
  });

  test('and the settings it writes go on reading it', async () => {
    const shape = await productOf('rootserver-settings', {
      'package.json': '{"name":"shopdesk","type":"module","dependencies":{"express":"^4.19.0"}}',
      'server.js': EXPRESS_SERVER,
      'src/ui/format.js': 'export const money = (n) => n;\n',
    });

    // The reader can be aimed at folders and never at single files, and a top-level file sits
    // outside every folder there is. So the only honest answer is the whole project — reading
    // the four routes once and then writing settings that never look at them again would put
    // the same silence back the next time anybody runs a check.
    assert.deepEqual(shape.sourceFolders, ['.'], 'settings that name only src/ would leave server.js unread for good');
  });

  test('but a build config at the top level is not the product, and does not widen the read', async () => {
    const shape = await productOf('configonly', {
      'package.json': '{"name":"site","type":"module","devDependencies":{"vite":"^5.0.0"}}',
      'vite.config.js': "export default { build: { outDir: 'dist' } };\n",
      'eslint.config.js': 'export default [];\n',
      // The file every project that installs THIS tool ends up with. If it counted as the
      // project keeping code at the top level, every user of the tool would have their whole
      // repository read from the day they set it up, which is nobody's intention.
      'staysfixed.config.mjs': 'export default { project: { name: "site" } };\n',
      'gulpfile.js': "exports.build = () => {};\n",
      'src/main.js': "document.title = 'site';\n",
    });

    assert.deepEqual(shape.sourceFolders, ['src'], 'a packaging config beside src/ is how the project is built, not what it ships');
  });
});

describe('a workspaces monorepo', () => {
  /** A shelf holding two packages, which is what nearly every monorepo root looks like. */
  const SHELF = {
    'package.json': '{"name":"acme","private":true,"workspaces":["packages/*"]}',
    'packages/api/package.json': '{"name":"@acme/api","type":"module","main":"src/server.js","scripts":{"start":"node src/server.js"}}',
    'packages/api/src/server.js': BARE_SERVER,
    'packages/web/package.json': '{"name":"@acme/web","type":"module","scripts":{"dev":"vite"},"devDependencies":{"vite":"^5.0.0"}}',
    'packages/web/src/main.js': "export const boot = () => document.title = 'acme';\n",
  };

  test('the folder the packages sit in is not itself a product', async () => {
    const shape = await productOf('shelf', SHELF);

    const shelf = shape.products.filter((p) => p.where === 'packages');
    assert.deepEqual(shelf, [], `packages/ holds other packages and ships nothing itself, so nothing here is its product — got ${shelf.map((p) => p.name).join(', ')}`);
    assert.ok(!shape.products.some((p) => p.name === 'the server in packages/'), `the exact sentence a person was shown: ${shape.summary}`);
  });

  test('the real package inside it is still found, with its server', async () => {
    const shape = await productOf('shelf-real', SHELF);

    const api = shape.products.find((p) => p.where === 'packages/api' && p.kind === 'server');
    assert.ok(api, 'the package that DOES open a socket is the product, and losing it would be the worse mistake of the two');
  });

  test('and the repository root is not called a server on its members routes', async () => {
    const shape = await productOf('shelf-root', {
      ...SHELF,
      'packages/api/src/routes.js': "import express from 'express';\nexport const app = express();\napp.get('/api/things', (req, res) => res.json([]));\n",
    });

    const atRoot = shape.products.filter((p) => p.where === '.' && p.kind === 'server');
    assert.deepEqual(atRoot, [], 'the root holds the workspace list and no code of its own; the routes belong to packages/api');
    assert.ok(shape.doors.route > 0, 'the repository-wide count stays honest — the route is real, it just is not the root\'s');
  });

  test('a container called apps/ is not a product either, and is not reported as unchecked code', async () => {
    const shape = await productOf('appsmono', {
      'package.json': '{"name":"bravo","private":true,"workspaces":["apps/*"]}',
      'apps/api/package.json': '{"name":"@bravo/api","type":"module","scripts":{"start":"node src/server.js"}}',
      'apps/api/src/server.js': BARE_SERVER,
      'apps/api/src/db.js': 'export const rows = [];\n',
      'apps/web/package.json': '{"name":"@bravo/web","type":"module","scripts":{"dev":"vite"},"devDependencies":{"vite":"^5.0.0"}}',
      'apps/web/index.html': '<div id="app"></div>\n',
      'apps/web/src/main.js': "export const boot = () => document.title = 'bravo';\n",
    });

    assert.deepEqual(shape.products.filter((p) => p.where === 'apps'), [], 'apps/ is a shelf, exactly like packages/');
    // And the other direction: having stopped calling it a product, nothing may start calling
    // it abandoned code. Everything in it is already found, one folder down.
    assert.deepEqual(shape.unsure.filter((line) => line.startsWith('apps/')), [], 'its packages are all being checked, so saying nothing in it is checked would be false');
  });
});

describe('and the finding this must not undo', () => {
  test('a folder with no manifest that really does open a socket is still a server', async () => {
    const shape = await productOf('relay', {
      'package.json': '{"name":"deck","type":"module","bin":{"deck":"src/cli.js"}}',
      'src/cli.js': "export const main = () => 'ok';\n",
      'relay/server.ts': "import http from 'node:http';\nconst server = http.createServer((req, res) => res.end('ok'));\nserver.listen(Number(process.env.PORT ?? 8080));\n",
      'relay/pair.ts': 'export const pair = (url: string): string => url.slice(1);\n',
      'relay/slots.ts': 'export const slots = new Map<string, string>();\n',
    });

    const relay = shape.products.find((p) => p.where === 'relay' && p.kind === 'server');
    assert.ok(relay, 'three files, no package.json, no framework — and it is a real running service. Refusing to reach into a package must not turn into refusing to look at all.');
  });
});
