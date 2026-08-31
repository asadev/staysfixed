/**
 * The whole modern family of websites was invisible, and every check on one was a false
 * all-clear.
 *
 * WHAT WAS MEASURED, on 2026-08-31, by somebody using this tool as a stranger. A three-page
 * SvelteKit site: `staysfixed init` reported 0 routes, wrote no screen list at all, and said
 * "a check here covers the website in full". `staysfixed check` opened the front page and
 * nothing else. Two of the three pages were never opened, and `staysfixed coverage` never
 * named them — so a run that walked one page in three came back reading exactly like a run
 * that walked all of them.
 *
 * THE CAUSE. Screens were found by reading code that DECLARES routes: a route table, a
 * `<Route path=...>`. That is right for Express and for the older React routers, and it finds
 * nothing whatever for every framework where the folder layout IS the routing — SvelteKit,
 * both Next.js routers, Nuxt, Astro and Remix. There was no table to find, so the answer was
 * "one page", and "one page" was reported as the whole site.
 *
 * Six families are read below, because each one is a different spelling of the same idea and
 * each one is a place an entire website can go unseen. Every test in this file was run
 * against the code as it was before this lane, and the SvelteKit, Nuxt, Astro and Remix ones
 * fail on it.
 *
 * AND THE PART THAT IS NOT ABOUT FINDING PAGES AT ALL. An address with a changing part in it
 * — `/blog/[slug]` — cannot be opened until somebody says which post. Skipping it quietly is
 * the same false all-clear in a smaller box: the ledger would count the pages it walked and
 * never mention the one it could not. So it is either opened with a value THIS PROJECT
 * already uses, with the source of that value written down beside it, or it is recorded as a
 * door that was found and not opened, by name, with the reason.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { detectProject } from '../../src/v2/detect.js';
import { readFileRoutes } from '../../src/v2/adapters/source.js';

/** Every folder this file made, cleaned up at the end. */
/** @type {string[]} */
const made = [];

/**
 * Write a little website to disk the way somebody's repository arrives.
 *
 * @param {string} label
 * @param {Record<string, string>} files
 * @returns {Promise<string>} the folder it was written to
 */
const siteOf = async (label, files) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `staysfixed-folder-routes-${label}-`));
  made.push(root);
  for (const [name, text] of Object.entries(files)) {
    await fsp.mkdir(path.join(root, path.dirname(name)), { recursive: true });
    await fsp.writeFile(path.join(root, name), text);
  }
  return root;
};

/**
 * The one website this repository makes, as detection sees it.
 *
 * @param {string} root
 */
const websiteIn = async (root) => {
  const found = await detectProject({ root });
  const web = found.products.find((p) => p.kind === 'web');
  assert.ok(web, 'no website was found at all, which is the failure this file is about');
  return web;
};

/**
 * The addresses `init` would write into the settings, in the order it writes them.
 *
 * @param {{suggest?: Record<string, any>}} web
 * @returns {string[]}
 */
const screenNames = (web) => (web.suggest?.screens ?? []).map((/** @type {{name: string}} */ s) => s.name).sort();

/**
 * The addresses that were found and could NOT be opened, which is the half of this that stops
 * a quiet skip reading like a pass.
 *
 * @param {{suggest?: Record<string, any>}} web
 * @returns {string[]}
 */
const waitingNames = (web) => (web.suggest?.screensNeedingValues ?? []).map((/** @type {{url: string}} */ s) => s.url).sort();

/**
 * The one sentence that says where the screen list came from and what is missing from it.
 * That sentence is copied straight into the settings file, so it is worth asserting on.
 *
 * @param {{router?: {why: string}}} web
 * @returns {string}
 */
const routerWhy = (web) => {
  assert.ok(web.router, 'a website with no reading behind it cannot explain itself to anybody');
  return web.router.why;
};

const SVELTE_PAGE = '<h1>a page</h1>\n';
const NEXT_PAGE = 'export default function Page() { return <main>a page</main>; }\n';

describe('SvelteKit — the site that was measured', () => {
  /** @type {Awaited<ReturnType<typeof websiteIn>>} */
  let web;

  test('all three pages and the one with a changing part are found, where none were before', async () => {
    const root = await siteOf('sveltekit', {
      'package.json': JSON.stringify({ name: 'three-page-site', devDependencies: { '@sveltejs/kit': '^2.0.0', svelte: '^5.0.0', vite: '^5.0.0' }, scripts: { dev: 'vite dev', build: 'vite build', preview: 'vite preview' } }),
      'src/routes/+layout.svelte': '<nav><a href="/about">About</a> <a href="/blog/hello-world">A post</a></nav>\n',
      'src/routes/+page.svelte': SVELTE_PAGE,
      'src/routes/about/+page.svelte': SVELTE_PAGE,
      'src/routes/contact/+page.svelte': SVELTE_PAGE,
      'src/routes/blog/[slug]/+page.svelte': SVELTE_PAGE,
    });
    web = await websiteIn(root);
    assert.deepEqual(screenNames(web), ['/about', '/blog/[slug]', '/contact', 'the front page']);
  });

  test('the changing part is filled from an address this project links to, and says so', () => {
    const post = (web.suggest?.screens ?? []).find((/** @type {{name: string}} */ s) => s.name === '/blog/[slug]');
    assert.equal(post.url, '/blog/hello-world', 'the address written down has to be one a browser can actually open');
    assert.match(post.describe, /links to/, 'a value with no stated source is indistinguishable from a guess');
    assert.match(post.describe, /\+layout\.svelte/, 'the file the value came out of has to be named');
    assert.deepEqual(waitingNames(web), [], 'nothing is waiting: the project supplied the value itself');
  });

  test('with no value anywhere, the address is named as found-and-not-opened rather than dropped', async () => {
    const root = await siteOf('sveltekit-no-value', {
      'package.json': JSON.stringify({ name: 'no-value', devDependencies: { '@sveltejs/kit': '^2.0.0' } }),
      'src/routes/+page.svelte': SVELTE_PAGE,
      'src/routes/blog/[slug]/+page.svelte': SVELTE_PAGE,
    });
    const site = await websiteIn(root);
    assert.deepEqual(screenNames(site), ['the front page']);
    assert.deepEqual(waitingNames(site), ['/blog/[slug]'], 'a page nobody can open is the one thing that must never disappear quietly');
    const waiting = (site.suggest?.screensNeedingValues ?? [])[0];
    assert.deepEqual(waiting.names, ['slug'], 'the ledger has to be able to say WHICH value it is short of');
    assert.match(routerWhy(site), /waiting on a real value/);
  });

  test('groups, parameters with a checker, optional parts and layout resets are all read right', async () => {
    const root = await siteOf('sveltekit-spellings', {
      'package.json': JSON.stringify({ name: 'spellings', devDependencies: { '@sveltejs/kit': '^2.0.0' } }),
      'src/routes/+page.svelte': SVELTE_PAGE,
      // A folder in brackets groups files and is never part of the address.
      'src/routes/(app)/dashboard/+page.svelte': SVELTE_PAGE,
      // The part after the @ picks a layout, never an address.
      'src/routes/settings/+page@.svelte': SVELTE_PAGE,
      // `=integer` names a checker for the value, not a second value.
      'src/routes/orders/[id=integer]/+page.svelte': SVELTE_PAGE,
      // An optional catch-all answers on its own parent address, so it can be opened today.
      'src/routes/shop/[[...rest]]/+page.svelte': SVELTE_PAGE,
      // A layout and an endpoint are not screens and must not be walked as if they were.
      'src/routes/+layout.svelte': '<slot />\n',
      'src/routes/api/health/+server.js': 'export function GET() { return new Response("{}"); }\n',
    });
    const site = await websiteIn(root);
    // `/shop/[[...rest]]` is ONE route, not two: the same file answers on `/shop` and on
    // everything under it. It is listed once, under the name the framework gives it, and the
    // address written beside it is the one a browser can open with nothing filled in.
    assert.deepEqual(screenNames(site), ['/dashboard', '/settings', '/shop/[[...rest]]', 'the front page'].sort());
    assert.deepEqual(waitingNames(site), ['/orders/[id=integer]']);
    const shop = (site.suggest?.screens ?? []).find((/** @type {{name: string}} */ s) => s.name === '/shop/[[...rest]]');
    assert.equal(shop.url, '/shop', 'an optional catch-all answers on its parent address with nothing filled in');
  });

  test('its endpoints and its form handlers are read as routes, where zero were reported before', async () => {
    const root = await siteOf('sveltekit-doors', {
      'package.json': JSON.stringify({ name: 'doors', devDependencies: { '@sveltejs/kit': '^2.0.0' } }),
      'src/routes/api/health/+server.js': 'export function GET() { return new Response("{}"); }\nexport function POST() { return new Response("{}"); }\n',
      'src/routes/contact/+page.server.js': 'export const actions = { default: async () => ({ ok: true }) };\n',
      // A loader is not a door somebody can knock on, and counting it as one would be a route
      // that never answers anything.
      'src/routes/blog/+page.server.js': 'export function load() { return { posts: [] }; }\n',
    });
    const reading = await readFileRoutes(root);
    const doors = reading.doors.map((d) => `${d.detail} ${d.name}`).sort();
    assert.deepEqual(doors, ['GET /api/health', 'POST /api/health', 'POST /contact']);
  });
});

describe('the two Next.js routers, which were the only ones ever read', () => {
  test('the app router still reads, and groups, private folders and slots stay out of the address', async () => {
    const root = await siteOf('next-app', {
      'package.json': JSON.stringify({ name: 'shop', dependencies: { next: '^15.0.0', react: '^19.0.0' } }),
      'app/page.tsx': NEXT_PAGE,
      'app/(marketing)/about/page.tsx': NEXT_PAGE,
      'app/products/[id]/page.tsx': NEXT_PAGE,
      'app/docs/[[...slug]]/page.tsx': NEXT_PAGE,
      // Private, a slot and an intercepting route: none of the three is an address of its own.
      'app/_components/widget/page.tsx': NEXT_PAGE,
      'app/@modal/page.tsx': NEXT_PAGE,
      'app/feed/(.)photo/page.tsx': NEXT_PAGE,
      'app/api/orders/route.ts': 'export function GET() { return Response.json([]); }\n',
    });
    const site = await websiteIn(root);
    // Every one of these is already turned into a journey by the page reader in the web
    // adapter, so they are deliberately not repeated in the settings — listing them twice
    // walks every page of the site twice. The sentence about the router still counts them all.
    assert.match(routerWhy(site), /^4 addresses are built out of the folder layout, the way the Next\.js app router does it/);
    assert.match(routerWhy(site), /3 of them can be opened/);
    assert.deepEqual(screenNames(site), [], 'a page the web adapter already walks must not be listed a second time');
  });

  test('the pages router still reads, and its hooks and its api folder stay out', async () => {
    const root = await siteOf('next-pages', {
      'package.json': JSON.stringify({ name: 'blog', dependencies: { next: '^14.0.0', react: '^18.0.0' } }),
      'pages/index.tsx': NEXT_PAGE,
      'pages/about.tsx': NEXT_PAGE,
      'pages/posts/[slug].tsx': NEXT_PAGE,
      'pages/_app.tsx': NEXT_PAGE,
      'pages/_document.tsx': NEXT_PAGE,
      'pages/api/health.ts': 'export default function handler(req, res) { res.json({ ok: true }); }\n',
    });
    const site = await websiteIn(root);
    assert.match(routerWhy(site), /3 addresses are built out of the folder layout, the way the Next\.js pages router does it/);
    assert.doesNotMatch(routerWhy(site), /_app|_document|\/api\//);
  });
});

describe('Nuxt, Astro and Remix — three more whole families that were unseen', () => {
  test('Nuxt reads .vue pages out of a folder called pages, which the old reader skipped entirely', async () => {
    const root = await siteOf('nuxt', {
      'package.json': JSON.stringify({ name: 'nuxt-site', devDependencies: { nuxt: '^3.0.0' } }),
      'pages/index.vue': '<template><h1>home</h1></template>\n',
      'pages/about.vue': '<template><h1>about</h1></template>\n',
      'pages/users/[id].vue': '<template><h1>a user</h1></template>\n',
      'pages/blog/index.vue': '<template><h1>blog</h1></template>\n',
    });
    const site = await websiteIn(root);
    assert.deepEqual(screenNames(site), ['/about', '/blog', 'the front page']);
    assert.deepEqual(waitingNames(site), ['/users/[id]']);
    assert.match(routerWhy(site), /the way Nuxt does it/);
  });

  test('Nuxt server routes are read as doors, with the verb taken out of the filename', async () => {
    const root = await siteOf('nuxt-doors', {
      'package.json': JSON.stringify({ name: 'nuxt-doors', devDependencies: { nuxt: '^3.0.0' } }),
      'server/api/users.get.ts': 'export default defineEventHandler(() => []);\n',
      'server/api/users.post.ts': 'export default defineEventHandler(() => ({}));\n',
      'server/api/health/index.ts': 'export default defineEventHandler(() => ({ ok: true }));\n',
      'server/routes/sitemap.ts': 'export default defineEventHandler(() => "");\n',
    });
    const reading = await readFileRoutes(root);
    const doors = reading.doors.map((d) => `${d.detail} ${d.name}`).sort();
    assert.deepEqual(doors, ['ANY /api/health', 'ANY /sitemap', 'GET /api/users', 'POST /api/users']);
  });

  test('Astro reads .astro pages, and a plain script beside them is an endpoint rather than a page', async () => {
    const root = await siteOf('astro', {
      'package.json': JSON.stringify({ name: 'astro-site', dependencies: { astro: '^5.0.0' } }),
      'src/pages/index.astro': '<h1>home</h1>\n',
      'src/pages/about.astro': '<h1>about</h1>\n',
      'src/pages/blog/[slug].astro': '<h1>a post</h1>\n',
      'src/pages/blog/index.md': '# the blog\n',
      // A script in src/pages is a server endpoint in Astro. Walking it as a page would
      // photograph a JSON body and call it a screen.
      'src/pages/api/health.ts': 'export function GET() { return new Response("{}"); }\n',
    });
    const site = await websiteIn(root);
    assert.deepEqual(screenNames(site), ['/about', '/blog', 'the front page']);
    assert.deepEqual(waitingNames(site), ['/blog/[slug]']);
    assert.match(routerWhy(site), /the way Astro does it/);
    const reading = await readFileRoutes(root);
    assert.deepEqual(reading.doors.map((d) => `${d.detail} ${d.name}`), ['GET /api/health']);
  });

  test('Remix reads its flat route files, where the dots in the filename are the slashes', async () => {
    const root = await siteOf('remix', {
      'package.json': JSON.stringify({ name: 'remix-site', dependencies: { '@remix-run/react': '^2.0.0', '@remix-run/node': '^2.0.0' } }),
      'app/routes/_index.tsx': NEXT_PAGE,
      'app/routes/about.tsx': NEXT_PAGE,
      // A leading underscore is a layout with no address of its own, so this is /login.
      'app/routes/_auth.login.tsx': NEXT_PAGE,
      // A trailing underscore only opts out of the parent's layout; the address is unchanged.
      'app/routes/app_.projects.tsx': NEXT_PAGE,
      // Brackets escape a real full stop, so this is /sitemap.xml and not /sitemap/xml.
      'app/routes/sitemap[.]xml.tsx': NEXT_PAGE,
      'app/routes/blog.$slug.tsx': NEXT_PAGE,
      // The folder form of the same thing, with its helpers kept beside it.
      'app/routes/settings.billing/route.tsx': NEXT_PAGE,
      'app/routes/settings.billing/card.tsx': NEXT_PAGE,
    });
    const site = await websiteIn(root);
    assert.deepEqual(screenNames(site), ['/about', '/app/projects', '/login', '/settings/billing', '/sitemap.xml', 'the front page'].sort());
    assert.deepEqual(waitingNames(site), ['/blog/[slug]']);
    assert.match(routerWhy(site), /the way Remix file routes does it/);
  });
});

describe('and the findings this must not undo', () => {
  test('a single-page app with a strip of tabs is still read off the tabs, not off its folders', async () => {
    // The failure that came BEFORE this one: one index.html and four screens reached by
    // clicking. Reading folder names there finds one screen and calls it the whole product.
    const root = await siteOf('tabs', {
      'package.json': JSON.stringify({ name: 'phone-client', dependencies: { vite: '^5.0.0' } }),
      'index.html': '<!doctype html><div id="app"></div>\n',
      'src/main.js': `const tabs = [
        { screen: 'sessions', label: 'Sessions' },
        { screen: 'files', label: 'Files' },
        { screen: 'settings', label: 'Settings' },
      ];\n`,
    });
    const site = await websiteIn(root);
    assert.equal(site.router?.kind, 'tabs');
    assert.ok(screenNames(site).length >= 4, 'the tab reading still has to find the screens nobody can address');
  });

  test('a project with a route table and no route folders is still read off the table', async () => {
    const root = await siteOf('declared', {
      'package.json': JSON.stringify({ name: 'spa', dependencies: { react: '^18.0.0', 'react-router-dom': '^6.0.0' } }),
      'src/App.jsx': `const routes = [
        { path: '/', element: <Home /> },
        { path: '/pricing', element: <Pricing /> },
        { path: '/docs', element: <Docs /> },
      ];\n`,
    });
    const site = await websiteIn(root);
    assert.equal(site.router?.kind, 'declared');
    assert.deepEqual(screenNames(site), ['/docs', '/pricing', 'the front page']);
  });

  test('a folder called routes with nothing routable in it does not invent a website', async () => {
    // `src/routes` is a normal name for a folder of Express handlers, and reading it as a page
    // tree would list a screen for every one of them and photograph a JSON body.
    const root = await siteOf('express-routes', {
      'package.json': JSON.stringify({ name: 'api', dependencies: { express: '^4.0.0' } }),
      'src/routes/orders.js': "import { Router } from 'express';\nconst r = Router();\nr.get('/orders', (req, res) => res.json([]));\nexport default r;\n",
      'src/server.js': "import express from 'express';\nconst app = express();\napp.listen(process.env.PORT || 3000);\n",
    });
    const found = await detectProject({ root });
    const web = found.products.find((p) => p.kind === 'web');
    assert.equal(web?.suggest?.screens ?? undefined, undefined, 'an Express handler is not a screen');
    assert.ok(found.products.some((p) => p.kind === 'server'), 'and it is still read as the server it is');
  });

  test('a folder of components beside a SvelteKit tree does not become invented addresses', async () => {
    // A project routes ONE way. `src/pages` in a SvelteKit app is a folder of components, and
    // reading `src/pages/utils.ts` as the address `/utils` would put a page that does not
    // exist into the settings and then report its 404 as a difference nobody caused.
    const root = await siteOf('sveltekit-plus-pages', {
      'package.json': JSON.stringify({ name: 'kit-with-pages', devDependencies: { '@sveltejs/kit': '^2.0.0' } }),
      'src/routes/+page.svelte': SVELTE_PAGE,
      'src/routes/about/+page.svelte': SVELTE_PAGE,
      'src/pages/utils.ts': 'export const helper = () => 1;\n',
      'src/pages/Card.tsx': NEXT_PAGE,
    });
    const site = await websiteIn(root);
    assert.deepEqual(screenNames(site), ['/about', 'the front page']);
  });

  test('a Next.js project using both of its routers keeps the pages from both', async () => {
    // The one case where two families really do share a repository: half the site in `app/`
    // and half in `pages/`. Letting the first one found rule out the second would lose
    // whichever half was read second, silently.
    const root = await siteOf('next-both-routers', {
      'package.json': JSON.stringify({ name: 'half-migrated', dependencies: { next: '^15.0.0', react: '^19.0.0' } }),
      'app/page.tsx': NEXT_PAGE,
      'app/dashboard/page.tsx': NEXT_PAGE,
      'pages/legacy.tsx': NEXT_PAGE,
      'pages/settings.tsx': NEXT_PAGE,
    });
    const site = await websiteIn(root);
    assert.match(routerWhy(site), /^4 addresses are built out of the folder layout/);
    assert.match(routerWhy(site), /the Next\.js app router and the Next\.js pages router/);
  });

  test('an Express handler under server/api is not read a second time as a Nuxt address', async () => {
    // `server/api/orders.js` is an ordinary place to keep an Express handler, and its real
    // route is already read out of the call inside it. Walking the folder as well would
    // invent `/api/orders` beside the true `/orders` — two doors where one exists, which
    // makes the door count a number nobody can trust in either direction.
    const root = await siteOf('express-server-api', {
      'package.json': JSON.stringify({ name: 'plain-api', dependencies: { express: '^4.0.0' } }),
      'server/api/orders.js': "import { Router } from 'express';\nconst r = Router();\nr.get('/orders', (req, res) => res.json([]));\nexport default r;\n",
    });
    const reading = await readFileRoutes(root);
    assert.deepEqual(reading.doors.map((d) => d.name), [], 'the folder walk must stay out of a project that does not route by folder');
  });

  test('a folder that will not open is named, because a hole must never read like an empty site', async () => {
    const root = await siteOf('unreadable', {
      'package.json': JSON.stringify({ name: 'locked', devDependencies: { '@sveltejs/kit': '^2.0.0' } }),
      'src/routes/+page.svelte': SVELTE_PAGE,
      'src/routes/private/+page.svelte': SVELTE_PAGE,
    });
    const locked = path.join(root, 'src', 'routes', 'private');
    await fsp.chmod(locked, 0o000);
    try {
      const site = await websiteIn(root);
      // On a machine running as root the chmod does not bite, and the folder opens anyway.
      // The test is about what is SAID when it does not, so it only asserts when it did.
      if (!screenNames(site).includes('/private')) {
        assert.match(routerWhy(site), /could not be opened/);
        assert.match(routerWhy(site), /private/);
      }
    } finally {
      await fsp.chmod(locked, 0o755);
    }
  });
});

test('everything this file wrote is cleaned up', async () => {
  for (const dir of made) await fsp.rm(dir, { recursive: true, force: true });
});
