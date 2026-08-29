/**
 * The one page a human actually looks at before deciding.
 *
 * It is a single file with everything inside it — pictures as data URIs, styles
 * and the comparison sliders inline — because it has to open by double-clicking
 * it on a laptop with no internet, out of a CI artifact, or over a screen share.
 * That rules out fonts, CDNs and frameworks; nothing here fetches anything.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { verdictFor, plainTime, countText } from './console.js';

/**
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Read a PNG into a data URI. A missing file is not fatal — the report says so
 * instead of failing, because a half-report still beats no report.
 * @param {string|undefined} file
 * @returns {Promise<string|null>}
 */
async function dataUri(file) {
  if (!file) return null;
  try {
    const buf = await fsp.readFile(file);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * A timestamp written the way a person writes one, without depending on the
 * machine's locale (two machines must produce the same report).
 * @param {string} iso
 * @returns {string}
 */
function stampText(iso) {
  const t = Date.parse(String(iso));
  if (Number.isNaN(t)) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = new Date(t);
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 * @returns {string}
 */
function plural(n, one, many) {
  return n === 1 ? one : many;
}

/**
 * @param {import('../types.js').PictureResult} p
 * @returns {string}
 */
function changeSentence(p) {
  const pixels = p.diffPixels ?? 0;
  const share = typeof p.diffRatio === 'number' ? ` — ${(p.diffRatio * 100).toFixed(2)}% of the picture` : '';
  const resized =
    p.approvedSize && p.size && (p.approvedSize.width !== p.size.width || p.approvedSize.height !== p.size.height)
      ? ` It is also a different size now: ${p.approvedSize.width}×${p.approvedSize.height} became ${p.size.width}×${p.size.height}.`
      : '';
  return `${countText(pixels)} ${plural(pixels, 'pixel', 'pixels')} moved${share}.${resized}`;
}

/**
 * @param {string|null} uri
 * @param {string} label
 * @returns {string}
 */
function figure(uri, label) {
  const body = uri
    ? `<img src="${uri}" alt="${escapeHtml(label)}" loading="lazy">`
    : `<p class="gone">This picture is not on disk any more.</p>`;
  return `<figure><figcaption>${escapeHtml(label)}</figcaption>${body}</figure>`;
}

/**
 * @param {string} command
 * @returns {string}
 */
function commandRow(command) {
  return `<p class="cmd"><code>${escapeHtml(command)}</code><button class="copy" type="button" data-copy="${escapeHtml(command)}">copy</button></p>`;
}

/**
 * @param {import('../types.js').PictureResult} p
 * @param {{approved: string|null, actual: string|null, diff: string|null}} shots
 * @returns {string}
 */
function changedCard(p, shots) {
  const out = [];
  out.push('<section class="card change">');
  out.push(`<h3><code>${escapeHtml(p.name)}</code> <span class="tag bad">changed</span></h3>`);
  if (p.describe) out.push(`<p class="desc">${escapeHtml(p.describe)}</p>`);
  out.push(`<p class="what">${escapeHtml(changeSentence(p))}</p>`);

  out.push('<div class="three">');
  out.push(figure(shots.approved, 'Approved'));
  out.push(figure(shots.actual, 'Now'));
  out.push(figure(shots.diff, 'What moved'));
  out.push('</div>');

  if (shots.approved && shots.actual) {
    out.push('<h4>Drag the line to compare</h4>');
    out.push('<div class="compare" data-compare style="--pos:50">');
    out.push('<div class="slider-stack">');
    out.push(`<img src="${shots.approved}" alt="approved">`);
    out.push(`<img class="after" src="${shots.actual}" alt="now">`);
    out.push('<div class="bar"></div>');
    out.push('<span class="edge left">approved</span><span class="edge right">now</span>');
    out.push('</div>');
    out.push('<input type="range" min="0" max="100" value="50" aria-label="Compare approved and now">');
    out.push('</div>');

    out.push('<h4>Or fade one into the other</h4>');
    out.push('<div class="fadebox" data-fadebox style="--fade:0.5">');
    out.push('<div class="fade-stack">');
    out.push(`<img src="${shots.approved}" alt="approved">`);
    out.push(`<img class="over" src="${shots.actual}" alt="now">`);
    out.push('</div>');
    out.push('<input type="range" min="0" max="100" value="50" aria-label="Fade between approved and now">');
    out.push('</div>');
  }

  out.push(errorsBlock(p.consoleErrors));
  out.push('<p class="hint">If this is what you meant to change, approve it. If it is not, you found a regression.</p>');
  out.push(commandRow(`staysfixed approve ${p.name}`));
  out.push('</section>');
  return out.join('\n');
}

/**
 * @param {string[]|undefined} errors
 * @returns {string}
 */
function errorsBlock(errors) {
  const list = errors ?? [];
  if (list.length === 0) return '';
  const items = list.slice(0, 8).map((e) => `<li>${escapeHtml(e)}</li>`).join('');
  const more = list.length > 8 ? `<li class="muted">and ${countText(list.length - 8)} more</li>` : '';
  return `<div class="errors"><p>The app itself printed ${countText(list.length)} ${plural(list.length, 'error', 'errors')} while this screen was open:</p><ul>${items}${more}</ul></div>`;
}

/**
 * @param {import('../types.js').PictureResult} p
 * @param {string|null} actual
 * @returns {string}
 */
function newCard(p, actual) {
  const out = [];
  out.push('<section class="card fresh">');
  out.push(`<h3><code>${escapeHtml(p.name)}</code> <span class="tag warn">new</span></h3>`);
  if (p.describe) out.push(`<p class="desc">${escapeHtml(p.describe)}</p>`);
  out.push('<p class="what">Nobody has ever approved this screen, so there is nothing to compare it against. Look at it. If it is right, approve it — and from then on Stays Fixed will tell you the day it stops looking like this.</p>');
  out.push('<div class="one">');
  out.push(figure(actual, 'This is what it looks like now'));
  out.push('</div>');
  out.push(errorsBlock(p.consoleErrors));
  out.push(commandRow(`staysfixed approve ${p.name}`));
  out.push('</section>');
  return out.join('\n');
}

/**
 * @param {import('../types.js').PictureResult} p
 * @param {string|null} actual
 * @returns {string}
 */
function troubleCard(p, actual) {
  const label = p.status === 'missing' ? 'the approved picture is gone' : p.status === 'flaky' ? 'changed its mind between tries' : 'could not be photographed';
  const out = [];
  out.push('<section class="card trouble">');
  out.push(`<h3><code>${escapeHtml(p.name)}</code> <span class="tag bad">${escapeHtml(p.status)}</span></h3>`);
  if (p.describe) out.push(`<p class="desc">${escapeHtml(p.describe)}</p>`);
  out.push(`<p class="what">${escapeHtml(p.message || label)}</p>`);
  if (actual) out.push(`<div class="one">${figure(actual, 'What the run managed to capture')}</div>`);
  out.push(errorsBlock(p.consoleErrors));
  if (p.status === 'missing') out.push(commandRow(`staysfixed approve ${p.name}`));
  out.push('</section>');
  return out.join('\n');
}

/**
 * @param {import('../types.js').GuardResult[]} guards
 * @returns {string}
 */
function guardsSection(guards) {
  if (guards.length === 0) return '';
  const failed = guards.filter((g) => g.status === 'failed');
  const out = [];
  out.push('<h2>Guards</h2>');
  out.push(
    `<p class="lead">${
      failed.length === 0
        ? `All ${countText(guards.length)} ${plural(guards.length, 'bug', 'bugs')} that were fixed are still fixed.`
        : `${countText(failed.length)} of ${countText(guards.length)} bugs that were fixed ${plural(failed.length, 'is', 'are')} back.`
    }</p>`,
  );
  out.push('<section class="card guards"><ul class="guardlist">');
  for (const g of guards) {
    const state = g.status === 'passed' ? 'good' : g.status === 'skipped' ? 'muted' : 'bad';
    out.push(`<li class="${state}">`);
    out.push(`<span class="dot"></span><span class="gname">${escapeHtml(g.name)}</span>`);
    if (g.status === 'failed') {
      if (g.failedAt) out.push(`<div class="claim">expected: ${escapeHtml(g.failedAt)}</div>`);
      if (g.message && g.message !== g.failedAt) out.push(`<div class="claim">${escapeHtml(g.message)}</div>`);
      if (g.because) out.push(`<div class="because">Why this guard exists: ${escapeHtml(g.because)}</div>`);
    } else if (g.status === 'skipped') {
      out.push('<div class="note">left out on purpose</div>');
    }
    out.push('</li>');
  }
  out.push('</ul></section>');
  return out.join('\n');
}

/**
 * @param {string[]} names
 * @returns {string}
 */
function condemnedSection(names) {
  if (names.length === 0) return '';
  const items = names.map((n) => `<li><code>${escapeHtml(n)}</code></li>`).join('');
  return [
    '<h2>These checks keep changing their mind</h2>',
    '<section class="card condemned">',
    `<ul class="plain">${items}</ul>`,
    '<p>Each of these has passed and failed without the code changing. Fix them or delete them — never tolerate them, or one day a real regression will look like more of the same noise.</p>',
    '</section>',
  ].join('\n');
}

/**
 * @param {import('../types.js').PictureResult[]} passed
 * @returns {string}
 */
function passedSection(passed) {
  if (passed.length === 0) return '';
  const items = passed.map((p) => `<li><code>${escapeHtml(p.name)}</code></li>`).join('');
  return [
    '<details class="card quiet">',
    `<summary>${countText(passed.length)} ${plural(passed.length, 'screen', 'screens')} still ${plural(passed.length, 'looks', 'look')} exactly as approved</summary>`,
    `<ul class="plain columns">${items}</ul>`,
    '</details>',
  ].join('\n');
}

/**
 * Build the whole page.
 * @param {import('../types.js').Project} project
 * @param {import('../types.js').RunSummary} run
 * @returns {Promise<string>}
 */
async function buildHtml(project, run) {
  const pictures = run.pictures ?? [];
  const guards = run.guards ?? [];
  const changed = pictures.filter((p) => p.status === 'changed');
  const fresh = pictures.filter((p) => p.status === 'new');
  const trouble = pictures.filter((p) => p.status === 'missing' || p.status === 'failed' || p.status === 'flaky');
  const passed = pictures.filter((p) => p.status === 'passed');
  const verdict = verdictFor(run);
  const clear = verdict === 'Everything that worked still works.';

  const body = [];

  body.push('<header class="top">');
  body.push(`<p class="brand">Stays Fixed</p>`);
  body.push(`<h1 class="${clear ? 'good' : 'bad'}">${escapeHtml(verdict)}</h1>`);
  const meta = [];
  if (run.git?.branch) meta.push(`branch <code>${escapeHtml(run.git.branch)}</code>`);
  if (run.git?.shortSha) meta.push(`commit <code>${escapeHtml(run.git.shortSha)}</code>${run.git.dirty ? ' with uncommitted changes' : ''}`);
  if (run.startedAt) meta.push(escapeHtml(stampText(run.startedAt)));
  meta.push(`took ${escapeHtml(plainTime(run.durationMs ?? 0))}`);
  if (run.platform) meta.push(`on ${escapeHtml(run.platform)}`);
  body.push(`<p class="meta">${meta.join(' &middot; ')}</p>`);
  const chips = [];
  if (passed.length) chips.push(`<span class="chip good">${countText(passed.length)} unchanged</span>`);
  if (changed.length) chips.push(`<span class="chip bad">${countText(changed.length)} changed</span>`);
  if (fresh.length) chips.push(`<span class="chip warn">${countText(fresh.length)} new</span>`);
  if (trouble.length) chips.push(`<span class="chip bad">${countText(trouble.length)} could not be checked</span>`);
  if (guards.length) {
    const bad = guards.filter((g) => g.status === 'failed').length;
    chips.push(`<span class="chip ${bad ? 'bad' : 'good'}">${countText(guards.length)} ${plural(guards.length, 'guard', 'guards')}${bad ? `, ${countText(bad)} failed` : ' holding'}</span>`);
  }
  if (chips.length) body.push(`<p class="chips">${chips.join('')}</p>`);
  body.push('</header>');

  if (changed.length) {
    body.push(`<h2>Screens that look different</h2>`);
    body.push('<p class="lead">Approved is what a person signed off. Now is what the app draws today. Decide which one is right.</p>');
    for (const p of changed) {
      const shots = {
        approved: await dataUri(p.approvedPath),
        actual: await dataUri(p.actualPath),
        diff: await dataUri(p.diffPath),
      };
      body.push(changedCard(p, shots));
    }
  }

  if (fresh.length) {
    body.push('<h2>Screens waiting for a person</h2>');
    for (const p of fresh) body.push(newCard(p, await dataUri(p.actualPath)));
  }

  if (trouble.length) {
    body.push('<h2>Screens that could not be checked</h2>');
    for (const p of trouble) body.push(troubleCard(p, await dataUri(p.actualPath)));
  }

  body.push(guardsSection(guards));
  body.push(condemnedSection(run.condemned ?? []));
  body.push(passedSection(passed));

  const approvable = [...changed, ...fresh, ...trouble.filter((p) => p.status === 'missing')];
  body.push('<footer>');
  if (approvable.length) {
    body.push('<h2>What to do next</h2>');
    body.push('<p class="lead">Approving is a person’s job. Nothing here approves itself, and no agent can do it for you.</p>');
    for (const p of approvable.slice(0, 40)) body.push(commandRow(`staysfixed approve ${p.name}`));
    if (approvable.length > 40) body.push(`<p class="muted">and ${countText(approvable.length - 40)} more</p>`);
    if (approvable.length > 1) {
      body.push('<p class="lead">Or accept every one of them at once:</p>');
      body.push(commandRow('staysfixed approve --all'));
    }
  } else {
    body.push('<p class="lead">Nothing needs your approval. Carry on.</p>');
  }
  body.push(`<p class="muted">Written by Stays Fixed ${escapeHtml(run.tool ?? '')} &middot; ${escapeHtml(path.basename(project.paths.configFile))} &middot; run ${escapeHtml(run.id ?? '')}</p>`);
  body.push('</footer>');

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(clear ? 'Everything still works' : verdict)} — Stays Fixed</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    body.join('\n'),
    '</main>',
    `<script>${SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * Write the report next to the run's evidence.
 * @param {import('../types.js').Project} project
 * @param {import('../types.js').RunSummary} run
 * @returns {Promise<string>} the file it wrote
 */
export async function writeRunReport(project, run) {
  const file = project.paths.reportFile;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, await buildHtml(project, run));
  return file;
}

const STYLE = `
:root {
  color-scheme: light dark;
  --ground: #f3f1ec;
  --card: #fffdf9;
  --ink: #1c1a17;
  --soft: #6b655c;
  --line: #e4dfd6;
  --good: #2f7a4f;
  --bad: #b02a20;
  --warn: #8a6100;
  --accent: #3f5bd0;
  --radius: 18px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: #151719;
    --card: #1d2023;
    --ink: #e9e6e0;
    --soft: #9d968d;
    --line: #2c3035;
    --good: #74cf97;
    --bad: #ff8f85;
    --warn: #e3b45c;
    --accent: #94a9ff;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--ground);
  color: var(--ink);
  font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 1180px; margin: 0 auto; padding: 32px 20px 80px; }
code, .cmd code, pre { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; font-size: 0.92em; }
h1 { font-size: 1.7rem; line-height: 1.25; margin: 4px 0 10px; font-weight: 650; }
h2 { font-size: 1.12rem; margin: 40px 0 6px; font-weight: 620; letter-spacing: 0.01em; }
h3 { font-size: 1rem; margin: 0 0 6px; font-weight: 600; }
h4 { font-size: 0.82rem; margin: 22px 0 8px; font-weight: 600; color: var(--soft); text-transform: uppercase; letter-spacing: 0.06em; }
p { margin: 0 0 10px; }
.brand { font-size: 0.75rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--soft); margin: 0; }
.top { padding: 8px 0 4px; }
h1.good { color: var(--good); }
h1.bad { color: var(--bad); }
.meta, .muted { color: var(--soft); font-size: 0.86rem; }
.lead { color: var(--soft); max-width: 62ch; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.chip { border: 1px solid var(--line); background: var(--card); border-radius: 999px; padding: 3px 12px; font-size: 0.8rem; }
.chip.good { color: var(--good); }
.chip.bad { color: var(--bad); }
.chip.warn { color: var(--warn); }
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 22px;
  margin: 14px 0 22px;
}
.card.change { border-left: 3px solid var(--bad); }
.card.fresh { border-left: 3px solid var(--warn); }
.card.trouble { border-left: 3px solid var(--bad); }
.card.condemned { border-left: 3px solid var(--bad); }
.tag { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; border-radius: 999px; padding: 2px 9px; border: 1px solid var(--line); vertical-align: 2px; }
.tag.bad { color: var(--bad); }
.tag.warn { color: var(--warn); }
.desc { color: var(--soft); }
.what { font-weight: 500; }
.hint { color: var(--soft); margin-top: 18px; }
.three { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin: 16px 0 4px; }
.one { margin: 16px 0 4px; }
figure { margin: 0; }
figcaption { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--soft); margin-bottom: 6px; }
figure img { width: 100%; height: auto; display: block; border-radius: 10px; border: 1px solid var(--line); background: #fff; }
.gone { color: var(--soft); font-size: 0.86rem; border: 1px dashed var(--line); border-radius: 10px; padding: 18px; }
.slider-stack, .fade-stack { position: relative; border-radius: 12px; overflow: hidden; border: 1px solid var(--line); background: #fff; }
.slider-stack { touch-action: none; cursor: ew-resize; user-select: none; }
.slider-stack img, .fade-stack img { width: 100%; height: auto; display: block; }
.slider-stack img.after { position: absolute; inset: 0; clip-path: inset(0 0 0 calc(var(--pos) * 1%)); }
.slider-stack .bar { position: absolute; top: 0; bottom: 0; left: calc(var(--pos) * 1%); width: 2px; background: var(--accent); pointer-events: none; }
.slider-stack .edge { position: absolute; bottom: 8px; font-size: 0.7rem; letter-spacing: 0.06em; text-transform: uppercase; background: rgba(0,0,0,0.55); color: #fff; padding: 2px 8px; border-radius: 999px; pointer-events: none; }
.slider-stack .edge.left { left: 8px; }
.slider-stack .edge.right { right: 8px; }
.fade-stack img.over { position: absolute; inset: 0; opacity: var(--fade); }
input[type=range] { width: 100%; margin: 12px 0 0; accent-color: var(--accent); }
.cmd { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 10px 0; }
.cmd code { background: var(--ground); border: 1px solid var(--line); border-radius: 10px; padding: 7px 12px; }
.copy { font: inherit; font-size: 0.78rem; color: var(--soft); background: transparent; border: 1px solid var(--line); border-radius: 999px; padding: 5px 12px; cursor: pointer; }
.copy:hover { color: var(--ink); border-color: var(--soft); }
.errors { margin-top: 16px; border-top: 1px solid var(--line); padding-top: 12px; font-size: 0.88rem; color: var(--soft); }
.errors ul { margin: 6px 0 0; padding-left: 18px; }
.guardlist { list-style: none; margin: 0; padding: 0; }
.guardlist li { padding: 10px 0; border-bottom: 1px solid var(--line); }
.guardlist li:last-child { border-bottom: 0; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 10px; background: var(--soft); vertical-align: 1px; }
.guardlist li.good .dot { background: var(--good); }
.guardlist li.bad .dot { background: var(--bad); }
.guardlist li.bad .gname { color: var(--bad); }
.gname { font-weight: 500; }
.claim { margin: 6px 0 0 18px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.84rem; color: var(--bad); }
.because { margin: 4px 0 0 18px; color: var(--soft); font-size: 0.88rem; }
.note { margin: 4px 0 0 18px; color: var(--soft); font-size: 0.86rem; }
/* A guard name or a CSS selector can be arbitrarily long; nothing may push the page sideways. */
code, .claim, .gname, .errors li, .plain li { overflow-wrap: anywhere; }
.cmd code { max-width: 100%; }
.guardlist li.muted .gname { color: var(--soft); font-weight: 400; }
.card.condemned .plain { margin-bottom: 14px; }
.plain { list-style: none; margin: 10px 0 0; padding: 0; }
.plain li { padding: 3px 0; }
.columns { columns: 3 200px; }
details.quiet { color: var(--soft); }
details.quiet summary { cursor: pointer; }
footer { margin-top: 48px; border-top: 1px solid var(--line); padding-top: 24px; }
@media (max-width: 640px) {
  main { padding: 20px 14px 60px; }
  h1 { font-size: 1.35rem; }
  .columns { columns: 1; }
}
`;

const SCRIPT = `
(function () {
  function wireCompare(box) {
    var stack = box.querySelector('.slider-stack');
    var range = box.querySelector('input');
    if (!stack || !range) return;
    var dragging = false;
    function set(v) {
      var p = Math.max(0, Math.min(100, v));
      box.style.setProperty('--pos', String(p));
      range.value = String(p);
    }
    function fromEvent(e) {
      var r = stack.getBoundingClientRect();
      return r.width ? ((e.clientX - r.left) / r.width) * 100 : 50;
    }
    range.addEventListener('input', function () { set(Number(range.value)); });
    stack.addEventListener('pointerdown', function (e) {
      dragging = true;
      if (stack.setPointerCapture) { try { stack.setPointerCapture(e.pointerId); } catch (err) {} }
      set(fromEvent(e));
      e.preventDefault();
    });
    stack.addEventListener('pointermove', function (e) { if (dragging) set(fromEvent(e)); });
    stack.addEventListener('pointerup', function () { dragging = false; });
    stack.addEventListener('pointercancel', function () { dragging = false; });
  }
  function wireFade(box) {
    var range = box.querySelector('input');
    if (!range) return;
    range.addEventListener('input', function () {
      box.style.setProperty('--fade', String(Number(range.value) / 100));
    });
  }
  function copyText(text, btn) {
    var original = btn.textContent;
    function done() {
      btn.textContent = 'copied';
      setTimeout(function () { btn.textContent = original; }, 1200);
    }
    function legacy() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (err) {}
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, legacy);
    } else {
      legacy();
    }
  }
  var i;
  var sliders = document.querySelectorAll('[data-compare]');
  for (i = 0; i < sliders.length; i++) wireCompare(sliders[i]);
  var fades = document.querySelectorAll('[data-fadebox]');
  for (i = 0; i < fades.length; i++) wireFade(fades[i]);
  var buttons = document.querySelectorAll('[data-copy]');
  for (i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('click', function () {
      copyText(this.getAttribute('data-copy') || '', this);
    });
  }
})();
`;
