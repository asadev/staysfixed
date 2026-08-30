/**
 * The products this tool could not see.
 *
 * Two holes, both found by installing the published tool and pointing it at something real.
 *
 * A server written straight on node's own http module registered nothing — there was no
 * `app.get` to find — so the reader found no routes, detect found no server, and init said
 * the repository made one command and that "nothing is being left out". That sentence was
 * printed over an entire uncovered HTTP surface, which is the worst thing a tool like this
 * can say.
 *
 * A Flask app was recognised, named, and turned away: "a Python project is in a language
 * nothing here drives". The honesty was right and the conclusion was wrong. Two of this
 * tool's adapters never read a line of anybody's source — one runs a command and compares
 * what it printed, the other boots a server and asks it for routes — so a Flask app was
 * always checkable here.
 *
 * Every test below fails on the code as it was before 2026-08-30. Most of them are about the
 * OPPOSITE error, because the way a route reader dies is not by missing a route: it is by
 * inventing one, and then sending everybody to look at a break in a product that never had
 * that address at all.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readFile } from '../../src/v2/adapters/source.js';
import { readPythonFile, changingParts, addressFromRegex, withoutCommentsAndDocstrings } from '../../src/v2/adapters/python.js';
import { detectProject } from '../../src/v2/detect.js';
import { plan, readinessFor } from '../../src/v2/init.js';

/**
 * Every route one file declares, as "METHOD path", sorted so a test can compare a whole set.
 * @param {string} name @param {string} text
 */
const routesIn = (name, text) => readFile(name, text).doors
  .filter((d) => d.kind === 'route')
  .map((d) => `${d.detail} ${d.name}`)
  .sort();

/** The same, for Python. @param {string} name @param {string} text */
const pythonRoutesIn = (name, text) => readPythonFile(name, text).doors
  .map((d) => `${d.detail} ${d.name}`)
  .sort();

describe('a server written by hand, with no framework under it', () => {
  test('the routes of a plain node:http server are read', () => {
    const found = routesIn('server.js', `
      import http from 'node:http';
      http.createServer((req, res) => {
        if (req.url === '/notes') { res.end('[]'); return; }
        if (req.url === '/health') { res.end('{}'); return; }
        res.writeHead(404); res.end();
      }).listen(process.env.PORT || 4321);
    `);
    assert.deepEqual(found, ['ANY /health', 'ANY /notes']);
  });

  test('a verb is only claimed when the code actually checks one', () => {
    const found = routesIn('server.js', `
      import http from 'node:http';
      http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/orders') { res.end(); return; }
        if (req.url === '/orders') { res.end('[]'); return; }
      }).listen(process.env.PORT);
    `);
    // The unguarded one must NOT come back as GET. Writing GET on a route that answers every
    // verb puts a fact in the report that is not in the code.
    assert.deepEqual(found, ['ANY /orders', 'POST /orders']);
  });

  test('the query string being cut off first does not hide the route', () => {
    const found = routesIn('server.js', `
      import http from 'node:http';
      http.createServer((req, res) => {
        const path = req.url.split('?')[0];
        if (path === '/widgets') { res.end('[]'); return; }
      }).listen(process.env.PORT);
    `);
    assert.deepEqual(found, ['ANY /widgets']);
  });

  test('a switch over the parsed path is read, and so is a URL built from it', () => {
    const found = routesIn('index.js', `
      import { createServer } from 'node:http';
      createServer((req, res) => {
        const { pathname } = new URL(req.url, 'http://localhost');
        switch (pathname) {
          case '/a': res.end('a'); return;
          case '/b': res.end('b'); return;
          default: break;
        }
        if (new URL(req.url, 'http://localhost').pathname === '/c') { res.end('c'); return; }
      }).listen(process.env.PORT);
    `);
    assert.deepEqual(found, ['ANY /a', 'ANY /b', 'ANY /c']);
  });

  test('a prefix is a family of routes, written the way the tool asks about one', () => {
    const found = routesIn('server.js', `
      import http from 'node:http';
      http.createServer((req, res) => {
        if (req.url.startsWith('/widgets/')) { res.end('{}'); return; }
      }).listen(process.env.PORT);
    `);
    // Everything under here is answered, and nobody has said which one to ask for. Written as
    // a changing part it joins the flow that already exists for /users/:id, so the tool asks
    // for a real value instead of quietly reporting the whole family as checked.
    assert.deepEqual(found, ['ANY /widgets/:rest']);
  });

  test('a handler in its own file is read from the shape of its arguments', () => {
    const found = routesIn('routes.js', `
      export function handle(req, res) {
        if (req.url === '/ping') { res.end('pong'); return; }
      }
    `);
    assert.deepEqual(found, ['ANY /ping']);
  });

  describe('and the strings that only look like routes', () => {
    test('a path compared against anything but the request address is not a route', () => {
      const found = routesIn('shapes.js', `
        export function pick(name) {
          if (name === '/admin') return 1;
          if (name.startsWith('/queue/')) return 2;
          switch (name) { case '/never': return 3; }
          return null;
        }
      `);
      assert.deepEqual(found, [], 'a lone parameter is not a request, so none of these are routes');
    });

    test('a header, a file on disk and a mime type are not routes', () => {
      const found = routesIn('server.js', `
        import http from 'node:http';
        const CONFIG = '/etc/app/config.json';
        http.createServer((req, res) => {
          if (req.headers.accept === '/anything') { res.end(); return; }
          if (req.headers['content-type'] === '/json') { res.end(); return; }
          if (CONFIG === '/etc/app/config.json') { res.end(); return; }
          if (req.url === '/real') { res.end(); return; }
        }).listen(process.env.PORT);
      `);
      assert.deepEqual(found, ['ANY /real']);
    });

    test('an address built while it runs is not claimed under a name it might not have', () => {
      const found = routesIn('server.js', `
        import http from 'node:http';
        const BUILT = \`/built/\${process.env.HOME}\`;
        http.createServer((req, res) => {
          if (req.url === BUILT) { res.end(); return; }
        }).listen(process.env.PORT);
      `);
      assert.deepEqual(found, [], 'half of that address is only known while it runs, so no address can be reported');
    });

    test('a file with no request handler in it produces nothing at all', () => {
      const found = routesIn('util.js', `
        const routes = ['/a', '/b'];
        export const first = routes[0];
        if (routes[0] === '/a') { console.log('yes'); }
      `);
      assert.deepEqual(found, []);
    });
  });
});

describe('Python, whose addresses are read even though the rest of it is not', () => {
  test('Flask route decorators, including the ones that name a verb', () => {
    const found = pythonRoutesIn('app.py', [
      'from flask import Flask',
      'app = Flask(__name__)',
      '',
      '@app.route("/products")',
      'def products(): return []',
      '',
      '@app.route("/products/<int:pid>")',
      'def one(pid): return {}',
      '',
      '@app.post("/orders")',
      'def order(): return {}',
      '',
      '@app.route("/multi", methods=["POST", "PUT"])',
      'def multi(): return {}',
    ].join('\n'));
    assert.deepEqual(found, ['GET /products', 'GET /products/:pid', 'POST /multi', 'POST /orders', 'PUT /multi']);
  });

  test('a FastAPI router serves its routes under the prefix it was built with', () => {
    const found = pythonRoutesIn('main.py', [
      'from fastapi import FastAPI, APIRouter',
      'app = FastAPI()',
      'router = APIRouter(prefix="/v1")',
      '',
      '@app.get("/health")',
      'def health(): return {}',
      '',
      '@router.post("/users/{user_id}/rename")',
      'def rename(user_id): return {}',
    ].join('\n'));
    // Leaving the prefix off would name an address the product answers 404 on.
    assert.deepEqual(found, ['GET /health', 'POST /v1/users/:user_id/rename']);
  });

  test("Django's urlpatterns list, and no verb is invented for it", () => {
    const found = pythonRoutesIn('urls.py', [
      'from django.urls import path, re_path',
      'from . import views',
      '',
      'urlpatterns = [',
      '    path("posts/", views.index),',
      '    path("posts/<int:post_id>/", views.detail),',
      '    re_path(r"^archive/(?P<year>[0-9]{4})/$", views.archive),',
      ']',
    ].join('\n'));
    // A Django view is handed every verb and decides for itself, so nothing in this list says
    // which one answers.
    assert.deepEqual(found, ['ANY /archive/:year/', 'ANY /posts/', 'ANY /posts/:post_id/']);
  });

  test('every spelling of a changing part becomes the one the tool asks about', () => {
    assert.equal(changingParts('/products/<int:pid>'), '/products/:pid');
    assert.equal(changingParts('/posts/<slug:name>'), '/posts/:name');
    assert.equal(changingParts('/files/<path:rest>'), '/files/:rest');
    assert.equal(changingParts('/users/{user_id}'), '/users/:user_id');
    assert.equal(changingParts('/users/{rest:path}'), '/users/:rest');
  });

  test('a regular expression nobody could ask for is refused rather than guessed at', () => {
    assert.equal(addressFromRegex('^archive/(?P<year>[0-9]{4})/$'), 'archive/:year/');
    assert.equal(
      addressFromRegex('^posts/[0-9]+/(edit|delete)$'),
      null,
      'an address still full of regex punctuation is one nobody can ask for, and asking for it would report a 404 as a break',
    );
  });

  describe('and the Python that only looks like a route', () => {
    test('a docstring showing somebody how to use the library is not a list of routes', () => {
      const found = pythonRoutesIn('app.py', [
        'from flask import Flask',
        'app = Flask(__name__)',
        '',
        '@app.route("/real")',
        'def real():',
        '    """How to use this.',
        '',
        '        @app.route("/from-a-docstring")',
        '        @app.get("/also-not-real")',
        '    """',
        '    return "ok"',
      ].join('\n'));
      assert.deepEqual(found, ['GET /real']);
    });

    test('a commented-out route is not a route', () => {
      const found = pythonRoutesIn('app.py', [
        'from flask import Flask',
        'app = Flask(__name__)',
        '# @app.route("/commented-out")',
        '@app.route("/real")',
        'def real(): return "ok"',
      ].join('\n'));
      assert.deepEqual(found, ['GET /real']);
    });

    test('an ordinary decorator that happens to be given a path is not a route', () => {
      const found = pythonRoutesIn('app.py', [
        'from flask import Flask',
        'app = Flask(__name__)',
        'cache = Cache()',
        '',
        '@cache.memo("/looks-like-a-path")',
        'def cached(): return 1',
        '',
        '@retry(3)',
        'def flaky(): return 2',
      ].join('\n'));
      assert.deepEqual(found, []);
    });

    test('an address assembled while it runs is not claimed', () => {
      const found = pythonRoutesIn('app.py', [
        'from flask import Flask',
        'app = Flask(__name__)',
        'SECTION = "/admin"',
        '',
        '@app.route(f"/built/{SECTION}")',
        'def built(): return "ok"',
      ].join('\n'));
      assert.deepEqual(found, []);
    });

    test('a file with no web framework anywhere in it produces nothing', () => {
      const found = pythonRoutesIn('helpers.py', [
        'import json',
        '',
        '@app.route("/not-real")',
        'def nope(): return 1',
      ].join('\n'));
      assert.deepEqual(found, [], 'nothing here imports a web framework, so "app" is just a name');
    });

    test('blanking a docstring keeps every line where it was', () => {
      const text = 'a = 1\n"""\nthree\nlines\n"""\nb = 2\n';
      const blanked = withoutCommentsAndDocstrings(text);
      assert.equal(blanked.split('\n').length, text.split('\n').length, 'a line number that moves points at the wrong line for the rest of the file');
      assert.match(blanked, /^a = 1$/m);
      assert.match(blanked, /^b = 2$/m);
      assert.doesNotMatch(blanked, /three/);
    });
  });
});

describe('what a repository is offered, and what it is honestly refused', () => {
  /** @type {string[]} */
  const made = [];

  /**
   * Write a throwaway project and read it the way `init` does.
   * @param {Record<string, string>} files
   */
  const detect = async (files) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-languages-'));
    made.push(root);
    for (const [name, text] of Object.entries(files)) {
      await fsp.mkdir(path.join(root, path.dirname(name)), { recursive: true });
      await fsp.writeFile(path.join(root, name), text);
    }
    return await detectProject({ root });
  };

  test.after(async () => {
    for (const root of made) await fsp.rm(root, { recursive: true, force: true });
  });

  test('a plain node:http server is a server, even with no route anybody can read', async () => {
    const shape = await detect({
      'package.json': '{"name":"bare","type":"module"}',
      'index.js': [
        "import { createServer } from 'node:http';",
        'const table = new Map();',
        'createServer((req, res) => { res.end(table.get(req.url) ?? ""); }).listen(process.env.PORT || 4325);',
      ].join('\n'),
    });
    const server = shape.products.find((p) => p.kind === 'server');
    assert.ok(server, 'this repository answers requests all day and used to be reported as making nothing at all');
    assert.equal(server.suggest?.start, 'node index.js', 'with no start script the file that opens the socket is the answer, not a shrug');
  });

  test('a port probe is not a server', async () => {
    const shape = await detect({
      'package.json': '{"name":"probe","type":"module"}',
      'index.js': [
        "import net from 'node:net';",
        'export const free = () => new Promise((go) => {',
        '  const probe = net.createServer();',
        '  probe.listen(0, "127.0.0.1", () => { const a = probe.address(); probe.close(); go(a.port); });',
        '});',
      ].join('\n'),
    });
    assert.equal(
      shape.products.find((p) => p.kind === 'server'),
      undefined,
      'this tool\'s own source does exactly this five times over, and every one of them called the whole repository a server',
    );
  });

  test('a server standing in a fixtures folder belongs to somebody\'s test, not to the product', async () => {
    const shape = await detect({
      'package.json': '{"name":"lib","type":"module","exports":"./src/index.js"}',
      'src/index.js': 'export const hello = () => 1;',
      'fixtures/app/server.js': [
        "import http from 'node:http';",
        'http.createServer((req, res) => { if (req.url === "/x") res.end("x"); }).listen(process.env.PORT);',
      ].join('\n'),
    });
    assert.equal(shape.products.find((p) => p.kind === 'server'), undefined);
  });

  test('a Flask project is offered both surfaces instead of being turned away', async () => {
    const shape = await detect({
      'requirements.txt': 'flask==3.0.0\n',
      'app.py': [
        'from flask import Flask',
        'app = Flask(__name__)',
        '',
        '@app.route("/products")',
        'def products(): return []',
      ].join('\n'),
      'cli.py': 'import sys\nprint(sys.argv)\n',
    });
    const server = shape.products.find((p) => p.kind === 'server');
    const cli = shape.products.find((p) => p.kind === 'cli');
    assert.ok(server, 'the HTTP adapter boots a server and asks it for routes, and it never reads a line of anybody\'s source');
    assert.ok(cli, 'the process adapter runs a command and compares what it printed, and it never reads a line either');
    assert.match(String(server.suggest?.start), /flask/);
    assert.equal(shape.products.find((p) => p.kind === 'other'), undefined, 'there is nothing left here that nothing can drive');
  });

  test('a Go server is offered a boot, and told plainly that its code is never read', async () => {
    const shape = await detect({
      'go.mod': 'module gosrv\n\ngo 1.22\n',
      'main.go': [
        'package main',
        '',
        'import "net/http"',
        '',
        'func main() {',
        '\thttp.HandleFunc("/widgets", nil)',
        '\thttp.ListenAndServe(":8080", nil)',
        '}',
      ].join('\n'),
    });
    const server = shape.products.find((p) => p.kind === 'server');
    assert.ok(server, 'it can be booted and watched, and being unable to READ it is a different question');
    assert.equal(server.sourceBlind?.language, 'Go', 'the language has to be named, or "some of it is not checked" is all anybody ever hears');
    assert.equal(server.sourceBlind?.reads, null, 'nothing of Go is read, and saying otherwise would be the overclaim this whole change is about');
  });

  test('a Python server says which half of it IS read, because some of it is', async () => {
    const shape = await detect({
      'requirements.txt': 'flask==3.0.0\n',
      'app.py': 'from flask import Flask\napp = Flask(__name__)\n\n@app.route("/x")\ndef x(): return 1\n',
    });
    const server = shape.products.find((p) => p.kind === 'server');
    assert.equal(server?.sourceBlind?.language, 'Python');
    assert.match(String(server?.sourceBlind?.reads), /addresses/, 'its routes ARE read, and reporting it as fully blind would be its own kind of lie');
  });

  test('a language with nothing to offer is still refused honestly rather than half-claimed', async () => {
    const shape = await detect({ 'Cargo.toml': '[package]\nname = "thing"\nversion = "0.1.0"\n', 'src/lib.rs': 'pub fn add(a: i32) -> i32 { a }\n' });
    const other = shape.products.find((p) => p.kind === 'other');
    assert.ok(other, 'a Rust library opens no port and installs no command, so there is genuinely nothing here to offer');
    assert.equal(other.adapter, null);
  });

  test('an Android project with nothing built carries the command that would build one', async () => {
    const shape = await detect({
      'settings.gradle.kts': 'rootProject.name = "Hello"\ninclude(":app")\n',
      'gradlew': '#!/bin/sh\n',
      'app/build.gradle.kts': 'android {\n    namespace = "com.example.hello"\n}\n',
      'app/src/main/AndroidManifest.xml': '<manifest><application android:label="Hello" /></manifest>\n',
    });
    const android = shape.products.find((p) => p.kind === 'android');
    assert.ok(android);
    assert.equal(android.built.found, false);
    // Without a command to hand over, init could see that nothing was built and still had
    // nothing to say, so it said the app was covered in full and the next command said there
    // was nothing to walk.
    assert.match(String(android.suggest?.buildWith), /gradlew.*assembleDebug/);
  });
});

describe('setting up must never promise more than a run can deliver', () => {
  /** @type {string[]} */
  const made = [];

  /**
   * Write a throwaway project and work out what `staysfixed init` would say about it.
   * @param {Record<string, string>} files
   */
  const planFor = async (files) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-promise-'));
    made.push(root);
    for (const [name, text] of Object.entries(files)) {
      await fsp.mkdir(path.join(root, path.dirname(name)), { recursive: true });
      await fsp.writeFile(path.join(root, name), text);
    }
    return await plan({ cwd: root, offline: true });
  };

  test.after(async () => {
    for (const root of made) await fsp.rm(root, { recursive: true, force: true });
  });

  const gradleProject = {
    'settings.gradle.kts': 'rootProject.name = "Hello"\ninclude(":app")\n',
    'gradlew': '#!/bin/sh\n',
    'app/build.gradle.kts': 'android {\n    namespace = "com.example.hello"\n}\n',
    'app/src/main/AndroidManifest.xml': '<manifest><application android:label="Hello" /></manifest>\n',
  };

  test('an Android app with nothing built is never called covered in full', async () => {
    const made = await planFor(gradleProject);
    const android = made.readiness.find((r) => r.kind === 'android');
    assert.ok(android, 'the Android app has to be in the readiness list at all');
    // It said "the Android app can be checked here now" and "Nothing is being left out", and
    // the very next command said there was nothing to walk in this project.
    assert.notEqual(android.state, 'ready');
    assert.doesNotMatch(made.covers.short, /Nothing is being left out/);
    assert.ok(android.needs.some((n) => n.topic === 'app'), 'the missing package has to be named, not merely implied');
  });

  test('and it is handed the command that builds one, the way the iPhone one is', async () => {
    const made = await planFor(gradleProject);
    const android = made.readiness.find((r) => r.kind === 'android');
    const build = android?.needs.find((n) => n.topic === 'app');
    assert.match(String(build?.fix), /gradlew.*assembleDebug/);
    assert.match(String(build?.fix), /android\.apk/, 'naming the command without naming where the result goes leaves the job half done');
  });

  test('a surface the machine check has nothing to say about is still never called ready', async () => {
    const shape = await detectProject({ root: await (async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-tauri-'));
      made.push(root);
      await fsp.mkdir(path.join(root, 'src-tauri', 'src'), { recursive: true });
      await fsp.writeFile(path.join(root, 'package.json'), '{"name":"t","type":"module"}');
      await fsp.writeFile(path.join(root, 'src-tauri', 'tauri.conf.json'), '{"productName":"T"}');
      await fsp.writeFile(path.join(root, 'src-tauri', 'src', 'main.rs'), 'fn main() {}\n');
      return root;
    })() });
    const native = shape.products.find((p) => p.kind === 'desktopNative');
    if (!native || native.adapter === null) return;   // no windows adapter here, nothing to say

    // Doctor returns NO Windows needs at all when there is no Windows host — which is exactly
    // the machine that has to be told. Empty needs met an empty machine list and the whole
    // product read as "covered in full", and then the run said there was nowhere to open it.
    const readiness = readinessFor(shape, /** @type {any} */ ({ surfaces: [{ id: 'windows', needs: [] }] }));
    const found = readiness.find((r) => r.kind === 'desktopNative');
    assert.notEqual(found?.state, 'ready');
    assert.ok(found?.needs.some((n) => n.topic === 'host'), 'nowhere to open it is the first thing to say, not the last');
  });

  test('but it steps aside when the machine check DID have something to say', async () => {
    const shape = await detectProject({ root: await (async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-tauri2-'));
      made.push(root);
      await fsp.mkdir(path.join(root, 'src-tauri'), { recursive: true });
      await fsp.writeFile(path.join(root, 'package.json'), '{"name":"t","type":"module"}');
      await fsp.writeFile(path.join(root, 'src-tauri', 'tauri.conf.json'), '{"productName":"T"}');
      return root;
    })() });
    const native = shape.products.find((p) => p.kind === 'desktopNative');
    if (!native || native.adapter === null) return;

    const readiness = readinessFor(shape, /** @type {any} */ ({
      surfaces: [{ id: 'windows', needs: [{ what: 'the name of a machine with a Windows desktop on it', why: 'w', fix: 'Put {"host": "the-box"} under "windows" in the config.', automatic: true }] }],
    }));
    const about = readiness.find((r) => r.kind === 'desktopNative')?.needs.filter((n) => n.topic === 'host') ?? [];
    assert.equal(about.length, 1, 'saying it twice, once generically and once with the real host name, is the duplicate this file already had to fix once');
    assert.match(about[0].fix, /the-box/, 'the machine check has actually looked at this machine, so its answer is the one worth keeping');
  });

  test('one missing build is one line, however many places notice it', async () => {
    const made = await planFor({
      'Hello.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n{\n\tobjectVersion = 56;\n}\n',
      'Hello.xcodeproj/xcshareddata/xcschemes/Hello.xcscheme': '<?xml version="1.0"?><Scheme version="1.7"></Scheme>\n',
      'Hello/HelloApp.swift': 'import SwiftUI\n\nstruct HelloApp {}\n',
    });
    const ios = made.readiness.find((r) => r.kind === 'ios');
    if (!ios) return;   // no iOS adapter in this copy of the tool, so there is nothing to say
    const aboutTheBuild = ios.needs.filter((n) => n.topic === 'app');
    assert.equal(
      aboutTheBuild.length,
      1,
      'the same missing file was asked for twice — once with a command to run and once with a paragraph saying the tool would never run it, which reads as a flat contradiction to anybody who does not write code',
    );
  });
});
