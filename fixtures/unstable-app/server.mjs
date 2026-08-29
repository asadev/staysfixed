/**
 * The tiny server behind the unstable fixture app.
 *
 * Zero dependencies on purpose: this has to start inside a test in a few
 * milliseconds, on any machine, with nothing installed. It serves four things —
 * the page, its stylesheet, its script, and two endpoints whose whole job is to
 * misbehave: a feed that answers differently every single time it is asked, and
 * a route that takes 400ms to reply.
 */

import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/** Only these files are reachable. Everything else in the folder stays private. */
const STATIC = new Set(['app.css', 'app.js']);

const WORDS = [
  'harbour', 'lantern', 'thicket', 'compass', 'granite', 'meadow', 'orbit',
  'saffron', 'tundra', 'velvet', 'wharf', 'zephyr', 'ember', 'furrow',
];

/**
 * Start the fixture app.
 *
 * @param {{port?: number, host?: string}} [opts]
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
export function startFixtureServer(opts = {}) {
  const host = opts.host ?? '127.0.0.1';
  const wanted = opts.port ?? 0;

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('the fixture server fell over');
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(wanted, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : wanted;
      resolve({
        url: `http://${host}:${port}`,
        port,
        close: () =>
          new Promise((done) => {
            // closeAllConnections, or a browser holding a keep-alive socket keeps
            // the whole test process alive after everything has passed.
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);

  res.setHeader('cache-control', 'no-store');

  if (name === 'index.html') {
    let html = await fsp.readFile(path.join(here, 'index.html'), 'utf8');
    // The deliberate break. Removing the stylesheet is not subtle to a human and
    // is completely invisible to a test suite that only checks behaviour — which
    // is the exact shape of the failure this whole tool exists to catch.
    if (url.searchParams.get('broken') === '1') {
      html = html.replace(/<link rel="stylesheet"[^>]*>/, '<!-- the stylesheet is gone -->');
    }
    res.writeHead(200, { 'content-type': TYPES['.html'] });
    res.end(html);
    return;
  }

  if (name === 'api/feed') {
    // Different every call, on purpose.
    const items = [];
    for (let i = 0; i < 6; i += 1) {
      items.push({
        id: Math.random().toString(36).slice(2, 10),
        word: WORDS[Math.floor(Math.random() * WORDS.length)],
        score: Math.round(Math.random() * 1000),
      });
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ askedAt: new Date().toISOString(), items }));
    return;
  }

  if (name === 'slow') {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ slow: true, waitedMs: 400 }));
    }, 400);
    return;
  }

  if (STATIC.has(name)) {
    const body = await fsp.readFile(path.join(here, name));
    res.writeHead(200, { 'content-type': TYPES[path.extname(name)] ?? 'application/octet-stream' });
    res.end(body);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not here');
}

// Runnable on its own, so a person can open the mess in a real browser and see it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8931);
  const started = await startFixtureServer({ port });
  process.stdout.write(`the unstable app is at ${started.url}\n`);
}
