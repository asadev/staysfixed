/**
 * The click-through you do before you ship.
 *
 * A walk is not a test. It opens the real app, visits every screen in order and
 * photographs each one into a fresh dated folder, so a person can scroll one page
 * and see the whole app the way a user would. Nothing here compares against an
 * approved picture and nothing here can ever write into `approved/` — a walk is
 * evidence for a human, not a promise the tool is keeping.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { captureScreen } from '../picture/capture.js';
import { accountForCapture } from '../picture/run.js';
import { settingsForScreen } from '../core/config.js';
import { gitInfo } from '../core/git.js';
import { StaysFixedError, messageOf } from '../core/errors.js';
import { safeName } from '../core/paths.js';
import { emitEvent, fileUrl } from '../core/events.js';

/**
 * Progress handed to `opts.onStep`, once when a step starts and once when it is done.
 * @typedef {object} WalkProgress
 * @property {'start'|'done'} phase
 * @property {number} index                        1-based, matching the number on the photo file.
 * @property {number} total
 * @property {string} name
 * @property {string} [describe]
 * @property {import('../types.js').WalkStep} [step]  The finished step, on 'done'.
 */

/**
 * Walk the app and photograph every screen in order.
 *
 * @param {import('../types.js').Project} project
 * @param {import('../types.js').LaunchedApp} app
 * @param {{
 *   onStep?: (update: WalkProgress) => void,
 *   only?: string|string[],
 *   signal?: AbortSignal,
 *   record?: boolean,
 *   events?: import('../types.js').RunEvents,
 *   thumbnail?: boolean,
 *   timings?: ReturnType<typeof import('../core/events.js').makeTimings>,
 * }} [opts]
 * @returns {Promise<import('../types.js').WalkReport>}
 */
export async function walkApp(project, app, opts = {}) {
  const { config, paths } = project;
  const chosen = chooseSteps(config, opts.only);
  const events = opts.events;

  const id = walkId(new Date());
  const dir = await makeWalkDir(paths.results, id);

  // A walk drives the same page object the whole way through, on purpose: the
  // point is to see the app as a person moving through it would, not to open a
  // clean tab per screen.
  const page = /** @type {import('../types.js').PageHandle} */ (app.page);

  /** @type {import('../types.js').WalkStep[]} */
  const steps = [];
  let stopped = false;

  for (let i = 0; i < chosen.length; i++) {
    if (opts.signal?.aborted) {
      stopped = true;
      break;
    }
    const screen = chosen[i];
    const index = i + 1;
    opts.onStep?.({
      phase: 'start',
      index,
      total: chosen.length,
      name: screen.name,
      ...(screen.describe !== undefined ? { describe: screen.describe } : {}),
    });

    // A walk goes through the same events as a check, so the live window draws a
    // walkthrough exactly the way it draws a run of picture checks.
    emitEvent(events, {
      type: 'screen:start',
      name: screen.name,
      describe: screen.describe,
      index,
      total: chosen.length,
    });

    /** @type {{shot?: string, shotFile?: string}} */
    const thumbs = {};
    const step = await walkOneStep(page, screen, {
      index,
      dir,
      settings: settingsForScreen(config, screen),
      fixturesDir: paths.fixtures,
      record: opts.record ?? false,
      events,
      thumbnail: opts.thumbnail === true,
      thumbs,
      timings: opts.timings,
    });
    steps.push(step);

    emitEvent(events, {
      type: 'screen:done',
      name: step.name,
      describe: step.describe,
      // A walk has nothing to compare against, so a step either happened or it
      // did not. Anything the app complained about is said in the message.
      status: step.error ? 'failed' : 'passed',
      durationMs: step.durationMs,
      message: stepMessage(step),
      thumbnail: thumbs.shot,
      // The real photo of this step, at full resolution. A walk has nothing to compare
      // against, so there is no approved picture and no difference to point at.
      shotFile: thumbs.shotFile,
    });

    opts.onStep?.({
      phase: 'done',
      index,
      total: chosen.length,
      name: screen.name,
      ...(screen.describe !== undefined ? { describe: screen.describe } : {}),
      step,
    });
  }

  const ok = !stopped && steps.every((s) => !s.error && (s.consoleErrors ?? []).length === 0);

  return {
    id,
    dir,
    steps,
    ok,
    git: await gitInfo(paths.root),
  };
}

/**
 * Photograph one screen. This never throws: a step that cannot be reached is
 * recorded and the walk carries on. One broken screen must not hide the other
 * eleven — hiding them is exactly how a release goes out with three things wrong
 * instead of one.
 *
 * @param {import('../types.js').PageHandle} page
 * @param {import('../types.js').ScreenConfig} screen
 * @param {{
 *   index: number,
 *   dir: string,
 *   settings: ReturnType<typeof settingsForScreen>,
 *   fixturesDir: string,
 *   record: boolean,
 *   events?: import('../types.js').RunEvents,
 *   thumbnail?: boolean,
 *   thumbs?: {shot?: string, shotFile?: string},
 *   timings?: ReturnType<typeof import('../core/events.js').makeTimings>,
 * }} ctx
 * @returns {Promise<import('../types.js').WalkStep>}
 */
async function walkOneStep(page, screen, ctx) {
  const startedAt = Date.now();
  const target = path.join(
    ctx.dir,
    `${String(ctx.index).padStart(2, '0')}-${safeName(screen.name)}.png`,
  );

  /** @type {string} */
  let file = '';
  /** @type {string|undefined} */
  let error;
  /** @type {string[]} */
  let consoleErrors = [];

  try {
    const shot = await captureScreen(page, screen, ctx.settings, {
      fixturesDir: ctx.fixturesDir,
      record: ctx.record,
      thumbnail: ctx.thumbnail === true,
    });
    accountForCapture(ctx.timings, shot);
    await fsp.writeFile(target, shot.png);
    file = target;
    consoleErrors = shot.consoleErrors;
    announceShot(ctx, screen.name, target, shot.thumbnail);
  } catch (cause) {
    error = messageOf(cause);
    consoleErrors = readConsole(page);
    // Even a failed step is worth a photo — seeing where the app actually got to
    // is usually the whole diagnosis. If the page is too far gone to photograph,
    // the step simply has no picture and says so.
    try {
      await fsp.writeFile(target, await page.shoot());
      file = target;
      // No preview for this one: the picture was taken by hand after the capture
      // broke, so nothing shrank it. The panel loads the real file instead, which is
      // the one a person needs to see anyway.
      announceShot(ctx, screen.name, target, undefined);
    } catch {
      file = '';
    }
  }

  /** @type {import('../types.js').WalkStep} */
  const step = {
    index: ctx.index,
    name: screen.name,
    file,
    durationMs: Date.now() - startedAt,
  };
  if (screen.describe !== undefined) step.describe = screen.describe;
  if (error !== undefined) step.error = error;
  if (consoleErrors.length > 0) step.consoleErrors = consoleErrors;

  const url = await quietly(() => page.url());
  if (url) step.url = url;
  const title = await quietly(() => page.title());
  if (title) step.title = title;

  return step;
}

/**
 * Tell anyone watching that this step has a picture now.
 *
 * Called only once the photo is ON DISK. The watch panel loads the real file so a
 * person can zoom into true pixels, and an <img> pointed at a file that does not exist
 * yet draws a torn page and never tries again — so the address is never announced early.
 * The shrunken preview rides along on the same event and covers the moment the real
 * file takes to load.
 *
 * @param {{events?: import('../types.js').RunEvents, thumbs?: {shot?: string, shotFile?: string}}} ctx
 * @param {string} name
 * @param {string} file      Absolute path to the photo, already written.
 * @param {string|undefined} thumbnail
 * @returns {void}
 */
function announceShot(ctx, name, file, thumbnail) {
  if (ctx.thumbs) {
    if (thumbnail) ctx.thumbs.shot = thumbnail;
    ctx.thumbs.shotFile = fileUrl(file);
  }
  emitEvent(ctx.events, { type: 'screen:shot', name, thumbnail, shotFile: fileUrl(file) });
}

/**
 * How many screens a walk is about to visit.
 *
 * The engine needs this before it opens anything, so it can tell a watcher how
 * long the list will be. It asks the same function the walk itself asks, because
 * two places counting the same thing differently is how a progress bar starts
 * lying.
 *
 * @param {import('../types.js').ResolvedConfig} config
 * @param {string|string[]} [only]
 * @returns {number}
 */
export function countWalkSteps(config, only) {
  return chooseSteps(config, only).length;
}

/**
 * What to say about a finished step, in plain language, or nothing when it went
 * through cleanly.
 *
 * @param {import('../types.js').WalkStep} step
 * @returns {string|undefined}
 */
function stepMessage(step) {
  if (step.error) return step.error;
  const complaints = (step.consoleErrors ?? []).length;
  if (complaints === 0) return undefined;
  return complaints === 1
    ? 'The app logged one error while this screen was open.'
    : `The app logged ${complaints} errors while this screen was open.`;
}

/**
 * Which screens the walk visits: `walk.steps` when the project spelled one out,
 * otherwise every screen it already checks, in the order they are written.
 *
 * @param {import('../types.js').ResolvedConfig} config
 * @param {string|string[]} [only]
 * @returns {import('../types.js').ScreenConfig[]}
 */
function chooseSteps(config, only) {
  const spelledOut = config.walk?.steps;
  const source = spelledOut && spelledOut.length > 0 ? spelledOut : config.screens ?? [];
  if (source.length === 0) {
    throw new StaysFixedError('There is nothing to walk through — no screens are set up yet.', {
      hint: 'Add screens to your config, or a `walk: { steps: [ ... ] }` list of the ones to walk before a release.',
    });
  }

  const wanted = only === undefined ? null : new Set((Array.isArray(only) ? only : [only]).map(safeName));

  const chosen = source
    .map((s, i) => normaliseStep(s, i))
    .filter((s) => !s.skip)
    .filter((s) => wanted === null || wanted.has(safeName(s.name)));

  if (chosen.length === 0) {
    throw new StaysFixedError(
      wanted === null
        ? 'Every screen is switched off, so the walkthrough has nothing to show.'
        : 'None of the screens you asked for are in this project.',
      { hint: 'Run `staysfixed status` to see the screen names this project knows about.' },
    );
  }
  return chosen;
}

/**
 * `walk.steps` comes straight off the raw config, so unlike `screens` its `url`
 * shorthand has not been turned into a first step yet. Expand it here, but only
 * when it is not already there, or a screen borrowed from `screens` would be
 * told to navigate twice.
 *
 * @param {import('../types.js').ScreenConfig} screen
 * @param {number} i
 * @returns {import('../types.js').ScreenConfig}
 */
function normaliseStep(screen, i) {
  if (!screen || typeof screen !== 'object') {
    throw new StaysFixedError(`walk.steps[${i}] is not a screen.`, {
      hint: "Each one looks like { name: 'sessions', url: '/sessions' }.",
    });
  }
  const named = screen.name ? screen : { ...screen, name: `step-${i + 1}` };
  if (!named.url) return named;
  const steps = named.steps ?? [];
  if (steps.length > 0 && steps[0]?.goto === named.url) return named;
  return { ...named, steps: [{ goto: named.url }, ...steps] };
}

/**
 * @param {import('../types.js').PageHandle} page
 * @returns {string[]}
 */
function readConsole(page) {
  try {
    return page.consoleErrors();
  } catch {
    return [];
  }
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T|null>}
 */
async function quietly(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * Sortable, readable, and the same shape a run id uses: 20260829-014530.
 * @param {Date} at
 * @returns {string}
 */
function walkId(at) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  );
}

/**
 * Two walks in the same second must not photograph into each other's folder.
 * @param {string} resultsDir
 * @param {string} id
 * @returns {Promise<string>}
 */
async function makeWalkDir(resultsDir, id) {
  await fsp.mkdir(resultsDir, { recursive: true });
  for (let n = 0; n < 50; n++) {
    const dir = path.join(resultsDir, n === 0 ? `walk-${id}` : `walk-${id}-${n + 1}`);
    try {
      // Deliberately not recursive: a clash must be caught, not silently shared.
      await fsp.mkdir(dir, { recursive: false });
      return dir;
    } catch (cause) {
      if (/** @type {NodeJS.ErrnoException} */ (cause).code !== 'EEXIST') throw cause;
    }
  }
  throw new StaysFixedError('Could not make a folder for this walkthrough.', {
    hint: `Too many walks already sit in ${resultsDir}.`,
  });
}

// ---------------------------------------------------------------------------
// The contact sheet
// ---------------------------------------------------------------------------

/**
 * Write one self-contained HTML page showing every photo in order.
 *
 * Everything is inlined — the pictures as data URIs, the styling in a <style>
 * block — so the file can be dragged into a chat, attached to a release, or
 * opened months later on a machine that never had this project on it.
 *
 * @param {import('../types.js').WalkReport} report
 * @param {string} file  Absolute path to write.
 * @returns {Promise<string>} the file written
 */
export async function writeWalkContactSheet(report, file) {
  /** @type {string[]} */
  const cards = [];
  for (const step of report.steps) {
    cards.push(await cardHtml(step));
  }

  const problems = report.steps.filter(
    (s) => s.error || (s.consoleErrors ?? []).length > 0,
  ).length;
  const where = [report.git.branch, report.git.shortSha].filter(Boolean).join(' · ');

  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Walkthrough ${escapeHtml(report.id)}</title>
<style>
  :root {
    color-scheme: light dark;
    --ground: #f6f6f4;
    --card: #ffffff;
    --ink: #1a1a19;
    --soft: #6b6b66;
    --line: #e2e2dd;
    --bad: #b02a1e;
    --good: #2f6f43;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #14140f;
      --card: #1e1e1a;
      --ink: #ecece6;
      --soft: #9a9a92;
      --line: #33332c;
      --bad: #ff8a7a;
      --good: #7fd39b;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding: 32px 24px 64px;
  }
  header { max-width: 1100px; margin: 0 auto 28px; }
  h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: -0.01em; }
  .meta { color: var(--soft); font-size: 13px; }
  .meta b { color: var(--ink); font-weight: 600; }
  .meta b.ok { color: var(--good); }
  .grid {
    max-width: 1100px;
    margin: 0 auto;
    display: grid;
    gap: 22px;
    grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: 14px;
    overflow: hidden;
  }
  .head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
  .num {
    font: 600 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--soft);
    background: var(--ground);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 5px 8px;
  }
  .name { font-weight: 600; }
  .desc { color: var(--soft); font-size: 13px; margin: 2px 0 10px; }
  .where {
    color: var(--soft);
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    margin: 10px 0 0;
    word-break: break-all;
  }
  .zoomer { position: absolute; opacity: 0; pointer-events: none; }
  .frame { display: block; cursor: zoom-in; }
  .frame img {
    display: block;
    width: 100%;
    height: auto;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: var(--ground);
  }
  .zoomer:checked + .frame {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.88);
    cursor: zoom-out;
    overflow: auto;
  }
  .zoomer:checked + .frame img {
    width: auto;
    max-width: 100%;
    max-height: 100%;
    border-radius: 4px;
  }
  .nopic {
    border: 1px dashed var(--line);
    border-radius: 10px;
    padding: 34px 14px;
    text-align: center;
    color: var(--soft);
    font-size: 13px;
  }
  .problem {
    margin-top: 12px;
    border-left: 3px solid var(--bad);
    padding: 6px 0 6px 10px;
    color: var(--bad);
    font-size: 13px;
  }
  .problem h3 { font-size: 13px; margin: 0 0 4px; }
  .problem ul { margin: 0; padding-left: 16px; }
  .problem li { word-break: break-word; }
  footer { max-width: 1100px; margin: 34px auto 0; color: var(--soft); font-size: 12px; }
</style>
<header>
  <h1>Walkthrough — ${escapeHtml(readableId(report.id))}</h1>
  <p class="meta">
    <b>${report.steps.length}</b> screen${report.steps.length === 1 ? '' : 's'} ·
    ${problems === 0 ? '<b class="ok">nothing went wrong</b>' : `<b>${problems}</b> with something to look at`}
    ${where ? ` · ${escapeHtml(where)}` : ''}${report.git.dirty ? ' · uncommitted changes' : ''}
  </p>
  <p class="meta">Click any picture to see it full size. Click it again to come back.</p>
</header>
<main class="grid">
${cards.join('\n')}
</main>
<footer>Taken by Stays Fixed. The pictures are inside this file, so it works anywhere.</footer>
<script>
  // Escape closes whichever picture is open. That is the whole script.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.zoomer:checked').forEach(function (box) { box.checked = false; });
  });
</script>
</html>
`;

  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, html);
  report.reportFile = file;
  return file;
}

/**
 * @param {import('../types.js').WalkStep} step
 * @returns {Promise<string>}
 */
async function cardHtml(step) {
  const id = `zoom-${step.index}`;
  const src = await dataUri(step.file);
  const picture = src
    ? `<input class="zoomer" type="checkbox" id="${id}">` +
      `<label class="frame" for="${id}"><img alt="${escapeHtml(step.name)}" src="${src}"></label>`
    : `<div class="nopic">No picture — the app never got this far.</div>`;

  /** @type {string[]} */
  const problems = [];
  if (step.error) problems.push(`<h3>This screen could not be reached</h3><p>${escapeHtml(step.error)}</p>`);
  if ((step.consoleErrors ?? []).length > 0) {
    const list = (step.consoleErrors ?? [])
      .slice(0, 20)
      .map((e) => `<li>${escapeHtml(e)}</li>`)
      .join('');
    problems.push(`<h3>The app complained while this screen was open</h3><ul>${list}</ul>`);
  }

  return `  <section class="card">
    <div class="head"><span class="num">${String(step.index).padStart(2, '0')}</span><span class="name">${escapeHtml(step.name)}</span></div>
    ${step.describe ? `<p class="desc">${escapeHtml(step.describe)}</p>` : ''}
    ${picture}
    ${step.url || step.title ? `<p class="where">${escapeHtml([step.title, step.url].filter(Boolean).join('  —  '))}</p>` : ''}
    ${problems.length ? `<div class="problem">${problems.join('')}</div>` : ''}
  </section>`;
}

/**
 * @param {string} file
 * @returns {Promise<string|null>}
 */
async function dataUri(file) {
  if (!file) return null;
  try {
    const png = await fsp.readFile(file);
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * '20260829-014530' -> '29 Aug 2026 at 01:45'.
 * @param {string} id
 * @returns {string}
 */
function readableId(id) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(id);
  if (!m) return id;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[Number(m[2]) - 1] ?? m[2];
  return `${Number(m[3])} ${month} ${m[1]} at ${m[4]}:${m[5]}`;
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
