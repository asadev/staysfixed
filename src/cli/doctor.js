/**
 * `staysfixed doctor` — the "why will this not work" command.
 *
 * Every other command is allowed to give up on the first problem. This one is
 * not: somebody running doctor is already stuck, and being told about one broken
 * thing at a time is how people give up on a tool. So it collects everything and
 * never throws.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { loadProject } from '../core/config.js';
import { findConfigFile, GITIGNORE_LINES } from '../core/paths.js';
import { findChrome, resolveElectronBinary, platformTag } from '../drive/find.js';
import { listElectronWindows } from '../drive/electron.js';
import { loadGuards } from '../guard/load.js';
import { isRepo } from '../core/git.js';
import { messageOf, isExpected, EXIT } from '../core/errors.js';
import { say, ok, warn, fail, blank, heading, paint, mark, shortPath } from '../core/log.js';

/**
 * @typedef {object} Note
 * @property {'ok'|'warn'|'bad'} level
 * @property {string} text
 * @property {string[]} [more]
 */

/**
 * @param {import('./index.js').CliContext} ctx
 * @returns {Promise<number>}
 */
export async function run(ctx) {
  /** @type {Note[]} */
  const notes = [];
  const good = (/** @type {string} */ text, /** @type {string[]} */ more = []) => notes.push({ level: 'ok', text, more });
  const soso = (/** @type {string} */ text, /** @type {string[]} */ more = []) => notes.push({ level: 'warn', text, more });
  const bad = (/** @type {string} */ text, /** @type {string[]} */ more = []) => notes.push({ level: 'bad', text, more });
  const fix = ctx.bool('fix');

  heading('Stays Fixed — checking this project');
  blank();

  // 1. Settings.
  const configFile = ctx.configFile ? path.resolve(ctx.cwd, ctx.configFile) : findConfigFile(ctx.cwd);
  /** @type {import('../types.js').Project|null} */
  let project = null;

  if (!configFile) {
    bad('There are no settings here — Stays Fixed does not know what to open.', [
      'Run `staysfixed init` in this folder and it will write them for you.',
    ]);
  } else {
    good(`Settings found: ${shortPath(configFile)}`);
    try {
      project = await loadProject({ cwd: ctx.cwd, configFile });
      const screens = project.config.screens.length;
      good(`The settings read fine — ${screens} ${screens === 1 ? 'screen' : 'screens'} named in them.`);
      if (screens === 0) {
        soso('No screens are listed, so `staysfixed check` has no pictures to take.', [
          'Add one under `screens:` in your settings file.',
        ]);
      }
    } catch (error) {
      bad(messageOf(error), hintsOf(error));
    }
  }

  const root = project ? project.paths.root : ctx.cwd;

  // 2. The app itself.
  if (project) {
    const app = project.config.app;
    if (app.attach) {
      await checkAttached(app.attach, good, soso);
    } else if (app.kind === 'web') {
      await checkWebApp(app, good, soso, bad);
    } else {
      checkElectronApp(app, good, bad);
    }

    // 3. A browser to drive it with. Electron brings its own.
    if (app.kind === 'web' && !app.attach) {
      const browser = findChrome(app.browser ?? process.env.STAYSFIXED_CHROME);
      if (browser) good(`Browser it will use: ${browser}`);
      else
        bad('No Chrome, Chromium, Brave or Edge could be found on this machine.', [
          'Install Google Chrome, or point Stays Fixed at the one you have:',
          "set `app: { browser: '/path/to/chrome' }` in your settings, or the STAYSFIXED_CHROME environment variable.",
        ]);
    }
  }

  // 4. The folders, and 5. the pictures inside them.
  if (project) {
    const wanted = [
      ['the state folder', project.paths.dir],
      ['approved pictures', project.paths.approved],
      ['guards', project.paths.guards],
      ['markers', project.paths.markers],
    ];
    /** @type {string[]} */
    const missing = [];
    for (const [label, dir] of wanted) {
      if (!(await isDir(dir))) missing.push(`${label} (${shortPath(dir)})`);
    }
    if (missing.length === 0) {
      good('All the folders it needs are there.');
    } else if (fix) {
      for (const [, dir] of wanted) await fsp.mkdir(dir, { recursive: true }).catch(() => {});
      good(`Made the folders that were missing: ${missing.length}.`);
    } else {
      soso(`${missing.length} ${missing.length === 1 ? 'folder is' : 'folders are'} missing.`, [
        ...missing.map((m) => `${mark.info} ${m}`),
        'Run `staysfixed doctor --fix` to make them.',
      ]);
    }

    const pictures = await approvedPictures(project.paths.approved);
    if (pictures.length === 0) {
      soso('There are no approved pictures yet, so there is nothing to compare against.', [
        'Run `staysfixed check`, look at what it took, then `staysfixed approve --all`.',
      ]);
    } else {
      good(`${pictures.length} approved ${pictures.length === 1 ? 'picture' : 'pictures'} on disk.`);
    }

    // 9. Text is drawn differently on every operating system, so a picture taken
    // on a Mac will never match one taken on Linux. Worth saying out loud.
    const here = platformTag();
    const elsewhere = [...new Set(pictures.map((p) => p.platform).filter((p) => typeof p === 'string' && p !== here))];
    if (elsewhere.length > 0) {
      soso(`Some approved pictures were taken on a different system (${elsewhere.join(', ')}); this one is ${here}.`, [
        'Text is drawn differently on every operating system, so those will look changed here even when nothing is wrong.',
        'Approve them again on this machine, or take the pictures on one machine only — usually CI.',
      ]);
    } else if (pictures.length > 0) {
      good(`Every approved picture was taken on this kind of machine (${here}).`);
    }
  }

  // 6. Guards.
  if (project) {
    try {
      const guards = await loadGuards(project);
      if (guards.length === 0) {
        soso('No guards yet.', [
          'A guard is one check per bug you have already fixed, named in plain English.',
          'The next time something comes back, write one — that is the whole point of them.',
        ]);
      } else {
        good(`${guards.length} ${guards.length === 1 ? 'guard loads' : 'guards load'}, and every name reads like a sentence.`);
      }
    } catch (error) {
      bad('The guards could not be loaded.', [...messageOf(error).split('\n'), ...hintsOf(error)]);
    }
  }

  // 7. .gitignore.
  await checkGitignore(root, fix, good, soso);

  // 8. git.
  if (await isRepo(root)) good('This is a git repository, so a regression can be traced to a commit.');
  else
    soso('This folder is not a git repository.', [
      'Everything still works, but `staysfixed trace` cannot tell you which commit changed something.',
    ]);

  // A last word about the rule that matters most.
  if (project?.config.mcp.allowApprove) {
    soso('Your settings let an agent approve its own pictures (`mcp.allowApprove: true`).', [
      'That gives away the only thing this tool really guarantees. Turn it off unless you meant it.',
    ]);
  }

  return report(notes);
}

/**
 * The advice an expected error carries, as lines. Anything else has none.
 * @param {unknown} error
 * @returns {string[]}
 */
function hintsOf(error) {
  if (!isExpected(error) || !error.hint) return [];
  return error.hint.split('\n');
}

/**
 * @param {Note[]} notes
 * @returns {number}
 */
function report(notes) {
  for (const note of notes) {
    if (note.level === 'ok') ok(note.text);
    else if (note.level === 'warn') warn(note.text);
    else fail(note.text);
    for (const line of note.more ?? []) say(paint.grey(`    ${line}`));
  }

  const bad = notes.filter((n) => n.level === 'bad').length;
  const warns = notes.filter((n) => n.level === 'warn').length;

  blank();
  if (bad > 0) {
    fail(`${bad} ${bad === 1 ? 'thing has' : 'things have'} to be fixed before Stays Fixed can run here.`);
    blank();
    return EXIT.failed;
  }
  if (warns > 0) {
    warn(`It will run. ${warns} ${warns === 1 ? 'thing is' : 'things are'} worth a look.`);
    blank();
    return EXIT.ok;
  }
  ok('Everything it needs is in place.');
  blank();
  return EXIT.ok;
}

/**
 * @param {import('../types.js').AppConfig} app
 * @param {(t: string, more?: string[]) => void} good
 * @param {(t: string, more?: string[]) => void} soso
 * @param {(t: string, more?: string[]) => void} bad
 */
async function checkWebApp(app, good, soso, bad) {
  const url = app.url;
  if (!url) {
    bad('The settings do not say which address to open.');
    return;
  }
  const answered = await answers(url);
  if (answered.ok) {
    good(`Your app answered at ${url}.`);
    return;
  }
  if (app.start) {
    soso(`Nothing is answering at ${url} right now.`, [
      `That is fine — Stays Fixed will start it itself with: ${app.start}`,
      `It could not reach it just now because: ${answered.why}`,
    ]);
    return;
  }
  bad(`Nothing is answering at ${url}.`, [
    `Tried it and got: ${answered.why}`,
    'Start your app first, or add `app: { start: "npm run dev" }` to your settings so Stays Fixed starts it for you.',
  ]);
}

/**
 * @param {import('../types.js').AppConfig} app
 * @param {(t: string, more?: string[]) => void} good
 * @param {(t: string, more?: string[]) => void} bad
 */
function checkElectronApp(app, good, bad) {
  try {
    const binary = resolveElectronBinary(app.binary ?? '');
    good(`The app it will open: ${binary}`);
  } catch (error) {
    bad(messageOf(error), hintsOf(error));
  }
}

/**
 * @param {string} endpoint
 * @param {(t: string, more?: string[]) => void} good
 * @param {(t: string, more?: string[]) => void} soso
 */
async function checkAttached(endpoint, good, soso) {
  try {
    const windows = await listElectronWindows(endpoint);
    const pages = windows.filter((w) => w.type === 'page');
    good(`Attached to what is already running at ${endpoint} — ${pages.length} ${pages.length === 1 ? 'window' : 'windows'} open.`);
    for (const window of pages.slice(0, 6)) {
      say(paint.grey(`    ${window.title || '(no title)'} ${paint.grey(window.url)}`));
    }
    if (pages.length > 1) {
      say(paint.grey('    More than one window is open. Put a word from the right title in `app.windowMatch`.'));
    }
  } catch (error) {
    soso(`Nothing is listening at ${endpoint} right now.`, [
      `Tried it and got: ${messageOf(error)}`,
      'Start the app with remote debugging on before running a check, or drop `app.attach` and let Stays Fixed launch it.',
    ]);
  }
}

/**
 * @param {string} root
 * @param {boolean} fix
 * @param {(t: string, more?: string[]) => void} good
 * @param {(t: string, more?: string[]) => void} soso
 */
async function checkGitignore(root, fix, good, soso) {
  const file = path.join(root, '.gitignore');
  let current = '';
  try {
    current = await fsp.readFile(file, 'utf8');
  } catch {
    current = '';
  }
  const lines = new Set(current.split('\n').map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((line) => !line.startsWith('#') && !lines.has(line.trim()));

  if (missing.length === 0) {
    good('Your .gitignore already keeps the throwaway files out of git.');
    return;
  }
  if (fix) {
    const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
    await fsp.writeFile(file, `${current}${prefix}\n${GITIGNORE_LINES.join('\n')}\n`);
    good(`Added ${missing.length} ${missing.length === 1 ? 'line' : 'lines'} to .gitignore.`);
    return;
  }
  soso('Your .gitignore is missing the lines that keep throwaway files out of git.', [
    ...missing.map((line) => `${mark.info} ${line}`),
    'Run `staysfixed doctor --fix` to add them.',
  ]);
}

/**
 * @param {string} url
 * @returns {Promise<{ok: boolean, why: string}>}
 */
async function answers(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'manual' });
    return { ok: response.status < 500, why: `${response.status}` };
  } catch (error) {
    return { ok: false, why: messageOf(error) };
  }
}

/**
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function isDir(dir) {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The metadata next to every approved picture, so doctor can spot pictures that
 * were taken somewhere else.
 * @param {string} dir
 * @returns {Promise<import('../types.js').PictureMeta[]>}
 */
async function approvedPictures(dir) {
  /** @type {import('../types.js').PictureMeta[]} */
  const out = [];
  /** @type {string[]} */
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.png')) continue;
    const meta = await readMeta(path.join(dir, name.replace(/\.png$/, '.json')));
    out.push(meta ?? /** @type {any} */ ({ name: name.replace(/\.png$/, '') }));
  }
  return out;
}

/**
 * @param {string} file
 * @returns {Promise<import('../types.js').PictureMeta|null>}
 */
async function readMeta(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}
