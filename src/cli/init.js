/**
 * `staysfixed init` — thirty seconds from nothing to a first check.
 *
 * It looks at the project before it writes anything, because a settings file
 * with your real dev server and your real app in it gets edited, and a generic
 * one gets deleted.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GITIGNORE_LINES, DEFAULT_DIR, findConfigFile, rootForConfig } from '../core/paths.js';
import { guardTemplate } from '../guard/load.js';
import { mcpConfigSnippet } from '../mcp/server.js';
import { say, ok, warn, blank, heading, paint, setLogLevel, shortPath } from '../core/log.js';
import { EXIT } from '../core/errors.js';

/**
 * What we worked out about the project before writing anything.
 * @typedef {object} Guess
 * @property {'web'|'electron'} kind
 * @property {string} name
 * @property {string} [url]
 * @property {string} [start]
 * @property {string} [binary]
 * @property {string} [why]        How we worked it out, said in one line.
 * @property {any} [pkg]
 */

/**
 * @param {import('./index.js').CliContext} ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  const asJson = ctx.bool('json');
  if (asJson) setLogLevel({ quiet: true, verbose: false });

  const root = ctx.cwd;
  const guess = await lookAround(root);

  /** @type {string[]} */
  const created = [];
  /** @type {string[]} */
  const kept = [];

  // 1. The settings file. A project that has not declared itself as ES modules
  // gets a .mjs file, so `export default` works without touching its package.json.
  const found = findConfigFile(root);
  const alreadyHere = found && rootForConfig(found) === root ? found : null;
  const suffix = guess.pkg?.type === 'module' ? 'js' : 'mjs';
  let configFile = alreadyHere ?? path.join(root, `staysfixed.config.${suffix}`);

  if (alreadyHere && !ctx.bool('force')) {
    kept.push(alreadyHere);
  } else {
    if (alreadyHere) configFile = alreadyHere;
    await fsp.writeFile(configFile, configTemplate(guess));
    created.push(configFile);
  }

  // 2. The folders.
  const dir = path.join(root, DEFAULT_DIR);
  for (const folder of [dir, path.join(dir, 'approved'), path.join(dir, 'guards'), path.join(dir, 'markers')]) {
    if (!existsSync(folder)) {
      await fsp.mkdir(folder, { recursive: true });
      created.push(folder);
    }
  }

  // 3. One starter guard, plus the page that explains what a guard even is.
  // The file name starts with an underscore so it is not run: it is a thing to
  // copy, not a check that would fail on day one against selectors you do not have.
  const example = path.join(dir, 'guards', '_example.js');
  if (!existsSync(example)) {
    await fsp.writeFile(example, guardTemplate());
    created.push(example);
  } else {
    kept.push(example);
  }

  const readme = path.join(dir, 'guards', 'README.md');
  if (!existsSync(readme)) {
    await fsp.writeFile(readme, guardsReadme());
    created.push(readme);
  } else {
    kept.push(readme);
  }

  // 4. Keep the throwaway files out of git.
  const ignored = await addIgnoreLines(root);
  if (ignored) created.push(path.join(root, '.gitignore'));

  // 5. The snippet that lets a coding agent check its own work.
  const snippet = snippetFor(root, guess.pkg);

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          root,
          configFile,
          kind: guess.kind,
          url: guess.url ?? null,
          binary: guess.binary ?? null,
          created,
          alreadyThere: kept,
          mcp: snippet,
          next: ['staysfixed check', 'staysfixed approve --all'],
        },
        null,
        2,
      ) + '\n',
    );
    return EXIT.ok;
  }

  blank();
  ok('Stays Fixed is set up here.');
  if (guess.why) say(paint.grey(`  ${guess.why}`));
  blank();

  for (const file of created) say(`  ${paint.green('made')} ${shortPath(file)}`);
  for (const file of kept) say(`  ${paint.grey('left alone (already there)')} ${shortPath(file)}`);
  if (alreadyHere && kept.includes(alreadyHere)) {
    blank();
    warn('You already had a settings file, so it was not touched. Pass --force to replace it.');
  }

  heading('Open the settings file and name the screens that matter');
  say(`  ${paint.cyan(shortPath(configFile))}`);
  say(paint.grey('  It is heavily commented. Three or four screens is a good start — the ones you would'));
  say(paint.grey('  be upset to find broken.'));

  heading('Then these two commands');
  say(`  1. ${paint.cyan('staysfixed check')}         takes the first pictures`);
  say(`  2. ${paint.cyan('staysfixed approve --all')} you look at them, and say they are right`);
  say(paint.grey('  From then on, `staysfixed check` tells you the moment one of them changes.'));

  heading('To let your coding agent check its own work');
  say(paint.grey('  Add this to the MCP settings of Claude Code, Codex, Gemini or Cursor:'));
  blank();
  for (const line of String(typeof snippet === 'string' ? snippet : JSON.stringify(snippet, null, 2)).split('\n')) {
    say(`  ${line}`);
  }
  blank();
  say(paint.grey('  It can take pictures and run guards. It cannot approve them — that stays yours.'));
  blank();

  return EXIT.ok;
}

/**
 * Work out what this project is, from what is already in the folder.
 * @param {string} root
 * @returns {Promise<Guess>}
 */
async function lookAround(root) {
  const pkg = await readJson(path.join(root, 'package.json'));
  const name = typeof pkg?.name === 'string' ? pkg.name : path.basename(root);
  const scripts = /** @type {Record<string,string>} */ (pkg?.scripts ?? {});
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };

  const bundle = findAppBundle(root, name, pkg);
  if (deps.electron || bundle) {
    return {
      kind: 'electron',
      name,
      pkg,
      binary: bundle ?? '/Applications/Your App.app',
      why: bundle
        ? `Found your built app at ${bundle}, so the settings open that.`
        : 'This looks like an Electron app, so the settings open a built app rather than a browser.',
    };
  }

  const [scriptName, scriptBody] = pickDevScript(scripts);
  const port = guessPort(scriptBody, deps);
  return {
    kind: 'web',
    name,
    pkg,
    url: `http://localhost:${port}`,
    start: scriptName ? `npm run ${scriptName}` : undefined,
    why: scriptName
      ? `Found "npm run ${scriptName}" in package.json, so the settings start that and open port ${port}.`
      : `No dev script found, so the settings assume your app is already running on port ${port}.`,
  };
}

/**
 * @param {Record<string,string>} scripts
 * @returns {[string|null, string]}
 */
function pickDevScript(scripts) {
  for (const name of ['dev', 'start', 'serve', 'develop']) {
    if (typeof scripts[name] === 'string') return [name, scripts[name]];
  }
  return [null, ''];
}

/**
 * The port a dev server will most likely answer on. An explicit port in the
 * script always wins over a framework's habit.
 * @param {string} script
 * @param {Record<string, unknown>} deps
 * @returns {number}
 */
function guessPort(script, deps) {
  const explicit =
    /(?:--port[= ]|-p[= ]|PORT[= ])(\d{2,5})/.exec(script) ?? /localhost:(\d{2,5})/.exec(script);
  if (explicit) return Number(explicit[1]);

  if (deps.vite || deps.vitest || deps['@sveltejs/kit']) return 5173;
  if (deps['@angular/core']) return 4200;
  if (deps.gatsby) return 8000;
  if (deps.astro) return 4321;
  if (deps.nuxt || deps.next || deps.remix || deps['@remix-run/dev']) return 3000;
  return 3000;
}

/**
 * A built Mac app matching this project, if there is one sitting around.
 * @param {string} root
 * @param {string} name
 * @param {any} pkg
 * @returns {string|null}
 */
function findAppBundle(root, name, pkg) {
  if (process.platform !== 'darwin') return null;
  /** @type {string[]} */
  const titles = [];
  for (const candidate of [pkg?.build?.productName, pkg?.productName, name]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') titles.push(candidate.trim());
  }
  titles.push(...titles.map(titleCase));

  for (const title of [...new Set(titles)]) {
    for (const where of ['/Applications', path.join(root, 'dist'), path.join(root, 'out'), path.join(root, 'release')]) {
      const bundle = path.join(where, `${title}.app`);
      if (existsSync(bundle)) return bundle;
    }
  }
  return null;
}

/**
 * @param {string} text
 * @returns {string}
 */
function titleCase(text) {
  return text
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * @param {string} root
 * @returns {Promise<boolean>} true when lines were added
 */
async function addIgnoreLines(root) {
  const file = path.join(root, '.gitignore');
  let current = '';
  try {
    current = await fsp.readFile(file, 'utf8');
  } catch {
    current = '';
  }
  const present = new Set(current.split('\n').map((line) => line.trim()));
  const missing = GITIGNORE_LINES.filter((line) => line.startsWith('#') || !present.has(line.trim()));
  const realMissing = GITIGNORE_LINES.filter((line) => !line.startsWith('#') && !present.has(line.trim()));
  if (realMissing.length === 0) return false;

  const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
  await fsp.writeFile(file, `${current}${prefix}\n${missing.join('\n')}\n`);
  return true;
}

/**
 * How this machine should invoke the MCP server, written so it still works
 * tomorrow: a project that depends on the package gets `npx`, a one-off run
 * through npx gets the package name back, and a checkout gets its own path.
 * @param {string} root
 * @param {any} pkg
 * @returns {unknown}
 */
function snippetFor(root, pkg) {
  const bin = fileURLToPath(new URL('../../bin/staysfixed.js', import.meta.url));
  const declared = Boolean(pkg?.dependencies?.staysfixed || pkg?.devDependencies?.staysfixed);

  let command = process.execPath;
  let args = [bin, 'mcp'];
  if (declared || bin.startsWith(path.join(root, 'node_modules') + path.sep)) {
    command = 'npx';
    args = ['staysfixed', 'mcp'];
  } else if (bin.includes(`${path.sep}_npx${path.sep}`)) {
    command = 'npx';
    args = ['github:asadev/staysfixed', 'mcp'];
  }
  return mcpConfigSnippet({ command, args, cwd: root });
}

/**
 * @param {string} file
 * @returns {Promise<any>}
 */
async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @returns {string}
 */
function guardsReadme() {
  return `# Guards

A guard is one check for one bug you have already fixed.

Its only job is to fail the day that bug comes back. Nothing else. It is not a
unit test, it does not prove a feature works, and it should not try to.

The name is the important part. Write what should still be true, in the words
you would say out loud:

    "the sidebar still collapses"
    "signing out really does sign you out"
    "the long file name no longer pushes the buttons off screen"

Six months from now that sentence is the only thing that will tell you what
broke, so it is worth ten seconds of thought.

## How to add one

Copy \`_example.js\` to a new file without the underscore — files starting with
\`_\` are ignored, which is why the example never runs. Then:

1. Put the app back in the state where the bug used to happen.
2. Say, in plain words, what must still be true.

    await expect('the sidebar is hidden', async () => !(await page.visible('.sidebar')));

When that turns out false, the failure reads as the sentence you wrote.

## When to add one

The moment you fix something. Especially the second time you fix it — a bug
that came back once will come back again, and this is the cheapest way to hear
about it before your users do.
`;
}

/**
 * A single-quoted JavaScript string, so the file we write reads like the rest of
 * the file we write.
 * @param {string} [text]
 * @returns {string}
 */
function quoted(text) {
  return `'${String(text ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * The settings file. It is long because it is meant to be read: every option
 * that matters is in here as a commented-out example, so nobody has to go
 * looking for documentation to change the window size.
 *
 * @param {Guess} guess
 * @returns {string}
 */
function configTemplate(guess) {
  const appBlock =
    guess.kind === 'electron'
      ? `  app: {
    kind: 'electron',

    // The app to open. On a Mac this can be the .app bundle itself.
    binary: ${quoted(guess.binary ?? '/Applications/Your App.app')},

    // args: ['--some-flag'],
    // env: { NODE_ENV: 'test' },
    // cwd: '.',

    // Your app probably opens more than one window. Name a word from the title
    // of the one that matters, so a check never photographs a splash screen.
    // windowMatch: 'Main Window',

    // Already running with remote debugging on? Attach instead of launching.
    // Stays Fixed never closes anything it only attached to.
    // attach: 'http://127.0.0.1:9333',

    // startTimeoutMs: 60000,
  },`
      : `  app: {
    kind: 'web',

    // Where your app answers.
    url: ${quoted(guess.url ?? 'http://localhost:3000')},
${
  guess.start
    ? `
    // Stays Fixed runs this and waits for the address above to answer. Remove it
    // if you would rather start the app yourself.
    start: ${quoted(guess.start)},`
    : `
    // Let Stays Fixed start the app itself and wait for the address above:
    // start: 'npm run dev',`
}

    // env: { NODE_ENV: 'test' },
    // cwd: '.',

    // A specific browser, instead of the one found on this machine.
    // browser: '/Applications/Google Chrome.app',

    // headless: true,

    // Attach to a browser that is already running instead of launching one.
    // attach: 'http://127.0.0.1:9222',

    // startTimeoutMs: 60000,
  },`;

  return `/**
 * Stays Fixed — settings for ${guess.name}.
 *
 * This file says what to open and which screens matter. Everything else has a
 * sensible default and is left commented out below, so you can see what exists
 * without going to look it up.
 *
 * Two commands are all you need:
 *   staysfixed check     take the pictures and compare them
 *   staysfixed approve   say a new picture is the correct one
 */

export default {
${appBlock}

  /**
   * The screens worth photographing. Start with three or four: the ones you
   * would be upset to find broken. Every screen needs a name — it becomes the
   * file name of its picture — and a way to get there.
   */
  screens: [
    {
      name: 'home',
      describe: 'The first thing anybody sees',
      url: '/',
    },

    // A screen you have to click your way to:
    // {
    //   name: 'settings-open',
    //   describe: 'The settings panel, open, with nothing typed in it',
    //   url: '/',
    //   steps: [
    //     { click: '[data-test="open-settings"]' },
    //     { waitFor: '.settings-panel' },
    //     { note: 'the panel animates in; settle waits for it to stop moving' },
    //   ],
    // },

    // Or the same thing in code, since this file is JavaScript:
    // {
    //   name: 'signed-in',
    //   async do(page) {
    //     await page.goto('/login');
    //     await page.type('#email', 'someone@example.com');
    //     await page.type('#password', 'hunter2');
    //     await page.click('button[type=submit]');
    //     await page.waitFor('.dashboard');
    //   },
    //   // Only photograph one part of the screen:
    //   // clip: '.dashboard',
    //   // Or the whole scrollable page:
    //   // fullPage: true,
    //   // Hide something that is genuinely different every time:
    //   // masks: ['.last-updated', { x: 0, y: 0, width: 200, height: 40 }],
    //   // Be stricter or looser on this one screen only:
    //   // tolerance: { pixels: 0 },
    //   // A different window size for this one screen only:
    //   // viewport: { width: 390, height: 844, mobile: true },
    //   // Temporarily leave it out without deleting it:
    //   // skip: true,
    // },
  ],

  // The window size every picture is taken at.
  // viewport: { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },

  /**
   * Freezing is what makes a picture repeatable. Without it the clock, the
   * animations and the random numbers change every run and every check cries
   * wolf. These defaults are on already — they are here so you can see them.
   */
  // freeze: {
  //   clock: '2026-01-01T12:00:00.000Z',  // the time your app always believes it is; false leaves it alone
  //   timezone: 'UTC',
  //   locale: 'en-US',
  //   motion: true,                        // no animations, no transitions, no blinking cursor
  //   random: 'seeded',                    // Math.random and crypto give the same answers every run
  //   seed: 20260101,
  //   fonts: true,                         // wait for web fonts before the shutter
  //   network: 'block-external',           // 'block-external' | 'replay' | 'live'
  //   networkAllow: ['https://fonts.gstatic.com/*'],
  //   hideScrollbars: true,
  //   hideCaret: true,
  //   settle: {
  //     frames: 2,          // this many identical frames in a row before the shutter
  //     intervalMs: 250,
  //     timeoutMs: 10000,
  //     maxDriftPixels: 0,
  //   },
  // },

  // How different two pictures may be before it counts as a change.
  // The default is about one twentieth of one percent of the pixels.
  // tolerance: { pixels: 0.0005, threshold: 0.12, antialiasing: true },
  // tolerance: { maxPixels: 200 },   // or a hard cap, in pixels

  // Painted over on every screen before comparing. Use it for the things that
  // are honestly different every time: a clock, a version number, an avatar.
  // masks: ['.timestamp', '[data-live]'],

  // The click-through before a release: staysfixed walk.
  // Leave it out and the walk visits every screen above, in order.
  // walk: {
  //   describe: 'The path a new user takes',
  //   steps: [
  //     { name: 'landing', url: '/' },
  //     { name: 'pricing', url: '/pricing' },
  //   ],
  // },

  // What a coding agent is allowed to do through the MCP server.
  // Approving stays off on purpose: an agent must never approve its own work.
  // mcp: { allowApprove: false, allowMark: false },

  // Where guards live.
  // guards: '.staysfixed/guards',

  // Where everything else lives.
  // dir: '.staysfixed',

  // A check that changes its mind this many times gets condemned: fix it or
  // delete it. Never tolerate it.
  // flakeLimit: 2,

  // Re-takes of a failing screen before calling it a real change.
  // retries: 1,

  // Screens photographed at once. One, on purpose — a machine under load takes
  // different pictures, and a check that cries wolf is worse than no check.
  // concurrency: 1,
};
`;
}
