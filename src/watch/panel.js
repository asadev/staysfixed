/**
 * The page inside the watch window.
 *
 * This builds one self-contained HTML document as a string. It is written to a
 * temp file and opened over `file://`, so it can fetch nothing: no fonts, no
 * CDN, no framework, no build step. Everything it will ever need is in the
 * string this file returns — including the one icon, which is drawn here in
 * SVG rather than downloaded from anywhere.
 *
 * It is fed one `RunEvent` at a time by `window.__staysfixed_push`, which the
 * run calls over the debugging connection as things happen. The page keeps no
 * state of its own beyond what those events tell it, so a panel that opens late
 * and is handed the whole history catches up by replaying it.
 *
 * The look is deliberate, and it is not the report's. The report is a document
 * you read once and send to someone; this sits pinned against the app all day
 * while a person works, so it is dark, it is quiet, and it is built to be
 * recognised at a glance as a piece of equipment rather than mistaken for
 * another page of the app it is watching. Colour is the only thing that carries
 * meaning here: green held, amber moved, red broke, blue is waiting for a
 * person. Nothing else is coloured, and nothing else animates.
 */

import { escapeHtml } from '../report/html.js';

/**
 * One line in the list: a screen or a guard.
 * @typedef {object} PanelRow
 * @property {string} name
 * @property {string} [describe]
 */

/**
 * What the panel is told before the run starts.
 * @typedef {object} PanelPlan
 * @property {string} [project]     The project folder's name.
 * @property {string} [app]         What is being checked, in plain words.
 * @property {PanelRow[]} [screens] The screens, in the order they will be photographed.
 * @property {PanelRow[]} [guards]  The guards, in the order they will run.
 * @property {'dark'|'light'|'system'} [theme]  Default 'dark'. Stated, not sniffed — a fresh
 *                                  browser profile always claims the computer is in light mode.
 */

/**
 * JSON safe to sit inside a `<script>` tag. `</script>` inside a string would
 * end the tag early and leave half the plan on the page as text, so the one
 * character that can do that never survives.
 * @param {unknown} value
 * @returns {string}
 */
function embedJson(value) {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c');
}

/**
 * Keep only what the page uses. A screen config carries steps, masks and
 * tolerances; none of that belongs in a window that is only drawing a list.
 * @param {PanelRow[]|undefined} list
 * @returns {{name: string, describe: string}[]}
 */
function tidyRows(list) {
  if (!Array.isArray(list)) return [];
  /** @type {{name: string, describe: string}[]} */
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = String(/** @type {any} */ (item).name ?? '').trim();
    if (!name) continue;
    const describe = String(/** @type {any} */ (item).describe ?? '').trim();
    out.push({ name, describe });
  }
  return out;
}

/**
 * The mark. A padlock with a tick inside it: the whole product in one shape —
 * the thing that was already fixed is still shut. Monoline, drawn on the 24
 * grid, inheriting its colour so it can never fight the theme.
 *
 * It carries no `xmlns`: inline SVG in an HTML document does not need one, and
 * the panel is not allowed to name an address of any kind.
 */
const MARK = [
  '<svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor"',
  ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
  '<rect x="4.2" y="10" width="15.6" height="10.4" rx="3.4"></rect>',
  '<path d="M8.1 10V7.9a3.9 3.9 0 0 1 7.8 0V10"></path>',
  '<path d="M9.7 15.2l1.8 1.9 2.9-3.5"></path>',
  '</svg>',
].join('');

/**
 * The whole panel document.
 * @param {PanelPlan} [plan]
 * @returns {string}
 */
export function panelHtml(plan = {}) {
  const project = String(plan.project ?? '').trim() || 'this project';
  const app = String(plan.app ?? '').trim();
  const screens = tidyRows(plan.screens);
  const guards = tidyRows(plan.guards);

  // Dark unless somebody asks otherwise — see the note above the light palette.
  const wanted = String(plan.theme ?? 'dark');
  const themeAttr = wanted === 'light' || wanted === 'system' ? wanted : 'dark';

  const embedded = embedJson({ project, app, screens, guards });

  return [
    '<!doctype html>',
    `<html lang="en" data-theme="${themeAttr}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(project)} — Stays Fixed</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<div class="glowfield" aria-hidden="true"></div>',
    '<div class="panel">',

    // --- masthead: the part that answers "whose window is this?" -----------
    '<header class="head">',
    '<div class="masthead">',
    `<span class="marker">${MARK}</span>`,
    '<span class="wordmark">Stays Fixed</span>',
    '<span class="clock mono" id="clock">0.0s</span>',
    '</div>',
    '<div class="watching">',
    `<span class="watchlabel">watching</span><span class="project mono" id="project">${escapeHtml(project)}</span>`,
    '</div>',
    `<p class="what" id="app"${app ? '' : ' hidden'}>${escapeHtml(app)}</p>`,
    '<p class="state" id="state">getting ready</p>',
    '<p class="note" id="note" hidden></p>',
    '<div class="progress" id="progress"></div>',
    '<p class="counts mono" id="counts"></p>',
    '</header>',

    // --- the live picture --------------------------------------------------
    '<section class="stage" id="stage">',
    '<div class="frame" id="frame">',
    '<img class="layer" id="layerA" alt="">',
    '<img class="layer" id="layerB" alt="">',
    '<p class="empty" id="empty">The first picture appears here the moment it is taken.</p>',
    '<span class="bezel" aria-hidden="true"></span>',
    '</div>',
    '<div class="tabs" id="tabs" hidden></div>',
    '<p class="shotname mono" id="shotname"></p>',
    '<p class="shotdesc" id="shotdesc"></p>',
    '<p class="shotout" id="shotout" hidden></p>',
    '</section>',

    // --- every check, in order ---------------------------------------------
    '<div class="rail" id="rail">',
    '<div class="list" id="list">',
    '<p class="listempty" id="listempty" hidden>Nothing is set up to be checked yet. Run <span class="mono">staysfixed init</span> to pick the screens worth watching.</p>',
    '</div>',
    '<section class="timing" id="timing" hidden>',
    '<h2>Where the time went</h2>',
    '<div class="tbar" id="tbar"></div>',
    '<ul class="tkey" id="tkey"></ul>',
    '</section>',
    '</div>',
    '<button class="follow" id="follow" type="button" hidden>Follow the running check</button>',

    '<footer class="foot" id="footer" hidden>',
    '<p class="footverdict" id="footlead"></p>',
    '<p class="cmd" id="cmdrow" hidden><code class="mono" id="cmd"></code><button class="copy" id="copy" type="button">copy</button></p>',
    '</footer>',

    '</div>',
    '<div class="lightbox" id="lightbox" hidden><img id="lightimg" alt=""></div>',
    `<script type="application/json" id="staysfixed-plan">${embedded}</script>`,
    `<script>${SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

const STYLE = `
/* --------------------------------------------------------------------------
   Tokens. Dark is the design — he works dark and this window lives beside his
   editor. Light is handled properly underneath, on a warm off-white ground,
   never plain white paper.
   -------------------------------------------------------------------------- */
:root {
  color-scheme: dark;

  --ground: #0a0d14;
  --ground-lift: #10141f;
  --card: rgba(255, 255, 255, 0.035);
  --card-solid: #141926;
  --well: #080b11;
  --glass: rgba(14, 18, 28, 0.72);

  --ink: #e9ecf3;
  --soft: #8d95a8;
  --faint: #626b7d;

  --line: rgba(255, 255, 255, 0.075);
  --line-strong: rgba(255, 255, 255, 0.14);
  --sheen: rgba(255, 255, 255, 0.09);
  --shadow: rgba(0, 0, 0, 0.62);

  --good: #4fc98a;
  --warn: #e6b055;
  --bad: #f2685f;
  --wait: #6ea8ff;
  --idle: #39415280;

  --accent: #6ea8ff;
  --shade1: #8b8cf0;
  --shade2: #5f6b82;
  --shade3: #4bb3ae;
  --shade4: #38404f;

  --radius: 20px;
  --radius-sm: 12px;
  --tint: var(--accent);
}
/*
 * Light is opt-in, and that is deliberate.
 *
 * This window runs on a brand new browser profile, and a fresh profile answers
 * "prefers-color-scheme" with "light" whatever the computer around it is set to. So the
 * panel came up pale on a dark desktop, which is exactly the thing it was asked not to
 * do. The look is therefore stated on the html element rather than sniffed: dark unless
 * somebody asks for light, and 'system' for anyone who does want the browser's opinion.
 */
:root[data-theme='light'],
:root[data-theme='system'] {
  color-scheme: light;

    --ground: #ece8df;
    --ground-lift: #fbf9f4;
    --card: rgba(255, 255, 255, 0.88);
    --card-solid: #fffdf8;
    --well: #eae6dc;
    --glass: rgba(247, 244, 237, 0.78);

    --ink: #1b1a17;
    --soft: #6d675d;
    --faint: #8d8679;

    --line: rgba(28, 24, 18, 0.1);
    --line-strong: rgba(28, 24, 18, 0.18);
    --sheen: rgba(255, 255, 255, 0.9);
    --shadow: rgba(40, 34, 24, 0.26);

    --good: #217a4c;
    --warn: #8a5f00;
    --bad: #b52d21;
    --wait: #2f55c8;
    --idle: #cdc6b880;

    --accent: #2f55c8;
    --shade1: #6a5fd0;
    --shade2: #9a9182;
    --shade3: #2c8c88;
    --shade4: #cfc7b6;
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  background: var(--ground);
  color: var(--ink);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}
.mono, code, .clock, .counts, .rname, .rtime, .project, .shotname, .tkey b {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-variant-numeric: tabular-nums;
}
p { margin: 0; }
h1, h2 { margin: 0; }
img { display: block; }

/* The ground is never flat. A cool light from above and a dark floor, so the
   black reads as a lit surface rather than a hole in the screen. Nothing here
   has an edge you could see on purpose — a texture you can name is decoration,
   and decoration next to a person's work is noise. */
.glowfield {
  position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background:
    radial-gradient(135% 62% at 50% -14%, color-mix(in srgb, var(--accent) 13%, transparent), transparent 64%),
    radial-gradient(120% 70% at 50% 118%, var(--shadow), transparent 62%),
    radial-gradient(80% 40% at 12% 42%, rgba(255, 255, 255, 0.022), transparent 70%);
}

.panel {
  position: relative; z-index: 1;
  display: flex; flex-direction: column;
  height: 100%;
  padding: 0 13px;
  gap: 11px;
}

/* --- masthead ------------------------------------------------------------ */
.head {
  flex: 0 0 auto;
  position: relative; z-index: 3;
  margin: 0 -13px;
  padding: 13px 13px 11px;
  background: var(--glass);
  backdrop-filter: blur(20px) saturate(140%);
  -webkit-backdrop-filter: blur(20px) saturate(140%);
  border-bottom: 1px solid var(--line);
  box-shadow: inset 0 1px 0 var(--sheen), 0 12px 26px -22px var(--shadow);
}
.masthead { display: flex; align-items: center; gap: 8px; }
.marker {
  flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center;
  width: 26px; height: 26px;
  border-radius: 9px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 26%, transparent);
  box-shadow: inset 0 1px 0 var(--sheen);
}
.mark { width: 16px; height: 16px; }
.wordmark {
  flex: 1 1 auto; min-width: 0;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px; font-weight: 600;
  letter-spacing: 0.24em; text-transform: uppercase;
  color: var(--ink);
}
.clock { flex: 0 0 auto; font-size: 12px; color: var(--soft); }

.watching { display: flex; align-items: baseline; gap: 7px; margin-top: 10px; min-width: 0; }
.watchlabel {
  flex: 0 0 auto;
  font-size: 11px; letter-spacing: 0.13em; text-transform: uppercase; color: var(--faint);
}
.project { flex: 1 1 auto; min-width: 0; font-size: 13px; color: var(--ink); overflow-wrap: anywhere; }
.what { color: var(--soft); font-size: 11.5px; margin-top: 2px; overflow-wrap: anywhere; }

.state {
  margin-top: 11px;
  font-size: 15.5px; font-weight: 600; line-height: 1.35;
  letter-spacing: -0.005em;
  overflow-wrap: anywhere;
}
.state.good { color: var(--good); }
.state.bad { color: var(--bad); }
.state.warn { color: var(--warn); }
.state.wait { color: var(--wait); }
.note { margin-top: 4px; font-size: 11.5px; color: var(--soft); overflow-wrap: anywhere; }

.progress { display: flex; gap: 2px; margin-top: 11px; height: 6px; }
.seg {
  flex: 1 1 0; min-width: 0; border-radius: 3px;
  background: var(--idle);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.05);
  transition: background 180ms ease, box-shadow 180ms ease;
}
.seg.good { background: var(--good); }
.seg.warn { background: var(--warn); }
.seg.bad { background: var(--bad); }
.seg.wait { background: var(--wait); }
.seg.muted { background: var(--shade4); }
.seg.running {
  background: var(--accent);
  box-shadow: 0 0 10px -1px color-mix(in srgb, var(--accent) 65%, transparent);
}
.counts { margin-top: 7px; font-size: 11px; color: var(--faint); letter-spacing: 0.02em; }

/* --- the live picture ---------------------------------------------------- */
.stage { flex: 0 0 auto; position: relative; }
/* A soft light behind the glass, tinted by how the last screen came out. */
.stage::before {
  content: ''; position: absolute; z-index: 0;
  left: 14%; right: 14%; top: 12px; bottom: 34%;
  border-radius: 50%;
  background: color-mix(in srgb, var(--tint) 34%, transparent);
  filter: blur(30px);
  opacity: 0.62;
  transition: background 220ms ease;
  pointer-events: none;
}
.frame {
  position: relative; z-index: 1;
  height: clamp(148px, 25vh, 236px);
  border-radius: var(--radius);
  background: var(--well);
  border: 1px solid var(--line);
  overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  box-shadow:
    inset 0 1px 0 var(--sheen),
    inset 0 0 44px -18px #000,
    0 22px 44px -26px var(--shadow);
  cursor: zoom-in;
}
.frame.blank { cursor: default; }
/* The hairline that makes it read as a screen rather than a hole in the page. */
.bezel {
  position: absolute; inset: 5px; border-radius: 15px;
  border: 1px solid var(--line);
  pointer-events: none;
}
.layer {
  position: absolute; inset: 6px;
  width: calc(100% - 12px); height: calc(100% - 12px);
  object-fit: contain;
  opacity: 0;
  transition: opacity 200ms ease;
  border-radius: 14px;
}
.layer.on { opacity: 1; }
.empty { position: relative; color: var(--faint); font-size: 11.5px; text-align: center; padding: 0 28px; }

.tabs { display: flex; gap: 4px; margin-top: 9px; }
.tab {
  flex: 1 1 0; min-width: 0;
  font: inherit; font-size: 11px; letter-spacing: 0.04em;
  color: var(--soft);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 5px 4px;
  cursor: pointer;
  transition: color 140ms ease, background 140ms ease, border-color 140ms ease;
}
.tab:hover { color: var(--ink); border-color: var(--line-strong); }
.tab.on {
  color: var(--ink);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}
.shotname { margin-top: 9px; font-size: 12px; overflow-wrap: anywhere; }
.shotdesc { color: var(--soft); font-size: 11.5px; overflow-wrap: anywhere; }
.shotout { font-size: 11.5px; margin-top: 3px; overflow-wrap: anywhere; color: var(--soft); }
.shotout.bad { color: var(--bad); }
.shotout.warn { color: var(--warn); }
.shotout.wait { color: var(--wait); }

/* --- the list ------------------------------------------------------------ */
.rail {
  flex: 1 1 auto;
  min-height: 88px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  /* Rows fade out at both edges, so the list reads as sliding under the glass
     above and below it rather than being clipped by a box. */
  mask-image: linear-gradient(to bottom, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%);
  padding: 6px 0 8px;
}
.rail::-webkit-scrollbar { width: 9px; }
.rail::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--soft) 26%, transparent); border-radius: 8px; border: 3px solid transparent; background-clip: padding-box; }
.rail::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--soft) 46%, transparent); background-clip: padding-box; }
.rail::-webkit-scrollbar-track { background: transparent; }

.list {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: inset 0 1px 0 var(--sheen), 0 16px 34px -28px var(--shadow);
  padding: 4px 0;
  overflow: hidden;
}
.listempty { padding: 18px 15px; color: var(--faint); font-size: 11.5px; line-height: 1.6; }
.listempty .mono { color: var(--soft); font-size: 11px; }

.row {
  position: relative;
  display: flex; gap: 10px;
  padding: 8px 13px;
  border-left: 2px solid transparent;
  transition: background 160ms ease, transform 160ms ease;
}
.row + .row { border-top: 1px solid var(--line); }
.row.fresh { animation: settle 170ms ease both; }
@keyframes settle { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.row.running {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-left-color: var(--accent);
  box-shadow: 0 8px 20px -16px var(--shadow), inset 0 1px 0 var(--sheen);
  border-radius: 2px;
}
.dot {
  flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%;
  margin-top: 6px;
  background: var(--shade4);
  transition: background 160ms ease, box-shadow 160ms ease;
}
.row.good .dot { background: var(--good); }
.row.warn .dot { background: var(--warn); }
.row.bad .dot { background: var(--bad); }
.row.wait .dot { background: var(--wait); }
.row.muted .dot { background: var(--shade4); opacity: 0.6; }
.row.running .dot { background: var(--accent); animation: pulse 1.5s ease-in-out infinite; }
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); }
  55% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 0%, transparent); }
}

.rowmain { flex: 1 1 auto; min-width: 0; }
.rowtop { display: flex; gap: 8px; align-items: baseline; }
.rname { flex: 1 1 auto; font-size: 12px; overflow-wrap: anywhere; }
.row.muted .rname { color: var(--soft); }
.rtime { flex: 0 0 auto; font-size: 11px; color: var(--faint); }
.rdesc { color: var(--soft); font-size: 11.5px; overflow-wrap: anywhere; }
.rout { font-size: 11.5px; margin-top: 2px; overflow-wrap: anywhere; color: var(--soft); }
.rout.good { color: var(--soft); }
.rout.warn { color: var(--warn); }
.rout.bad { color: var(--bad); }
.rout.wait { color: var(--wait); }
.rwhy {
  margin-top: 7px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--well);
  border: 1px solid var(--line);
  font-size: 11.5px;
  overflow-wrap: anywhere;
}
.rclaim { color: var(--bad); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.rbecause { color: var(--soft); margin-top: 4px; }

.follow {
  flex: 0 0 auto; align-self: center;
  font: inherit; font-size: 11px; letter-spacing: 0.02em;
  color: var(--ink);
  background: var(--ground-lift);
  border: 1px solid var(--line-strong); border-radius: 999px;
  padding: 6px 14px; cursor: pointer;
  box-shadow: 0 10px 22px -16px var(--shadow), inset 0 1px 0 var(--sheen);
  transition: border-color 140ms ease, color 140ms ease;
}
.follow:hover { border-color: var(--accent); color: var(--accent); }

/* --- where the time went ------------------------------------------------- */
.timing {
  margin-top: 10px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: inset 0 1px 0 var(--sheen);
  padding: 12px 13px 13px;
}
.timing h2 {
  font-size: 11px; letter-spacing: 0.13em; text-transform: uppercase;
  color: var(--faint); font-weight: 600; margin-bottom: 9px;
}
.tbar { display: flex; gap: 2px; height: 8px; }
.tpart { min-width: 2px; border-radius: 3px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.08); }
.tkey { list-style: none; margin: 9px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11px; color: var(--soft); }
.tkey li { display: flex; align-items: center; gap: 6px; }
.tswatch { width: 8px; height: 8px; border-radius: 3px; flex: 0 0 auto; }
.tkey b { font-weight: 500; color: var(--ink); font-size: 11px; }

/* --- footer -------------------------------------------------------------- */
.foot {
  flex: 0 0 auto;
  margin: 0 -13px;
  padding: 11px 13px 13px;
  background: var(--glass);
  backdrop-filter: blur(20px) saturate(140%);
  -webkit-backdrop-filter: blur(20px) saturate(140%);
  border-top: 1px solid var(--line);
  box-shadow: 0 -12px 26px -24px var(--shadow);
}
.footverdict { font-size: 11.5px; color: var(--soft); overflow-wrap: anywhere; }
.footverdict.good { color: var(--good); }
.footverdict.bad { color: var(--bad); }
.footverdict.warn { color: var(--warn); }
.footverdict.wait { color: var(--wait); }
.cmd { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.cmd code {
  flex: 1 1 auto; min-width: 0;
  background: var(--well);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  padding: 7px 10px; font-size: 11.5px;
  color: var(--ink);
  overflow-wrap: anywhere;
  user-select: all;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
}
.copy {
  flex: 0 0 auto; font: inherit; font-size: 11px;
  color: var(--soft); background: transparent;
  border: 1px solid var(--line-strong); border-radius: 999px;
  padding: 5px 11px; cursor: pointer;
  transition: color 140ms ease, border-color 140ms ease;
}
.copy:hover { color: var(--ink); border-color: var(--soft); }

/* --- one picture, made big ---------------------------------------------- */
.lightbox {
  position: fixed; inset: 0; z-index: 10;
  background: color-mix(in srgb, var(--ground) 82%, #000);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: flex; align-items: center; justify-content: center;
  padding: 14px; cursor: zoom-out;
}
.lightbox img {
  max-width: 100%; max-height: 100%;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line-strong);
  box-shadow: 0 30px 60px -30px #000;
}

/* The panel has to stay readable when someone drags it narrow. */
@media (max-width: 420px) {
  .frame { height: clamp(120px, 20vh, 170px); }
  .state { font-size: 14px; }
}

@media (prefers-reduced-motion: reduce) {
  .row.running .dot { animation: none; }
  .row.fresh { animation: none; }
  .layer, .seg, .row, .tab, .copy, .follow, .stage::before { transition: none; }
}
`;

const SCRIPT = `
(function () {
  'use strict';

  // This page only ever runs in the browser window Stays Fixed just opened, so
  // there is no compatibility question to answer and nothing to load.

  var plan = { project: '', app: '', screens: [], guards: [] };
  try {
    var blob = document.getElementById('staysfixed-plan');
    if (blob && blob.textContent) plan = JSON.parse(blob.textContent) || plan;
  } catch (err) {
    // A plan we cannot read costs the opening list, not the panel. Rows will
    // still appear one by one as the run reaches them.
  }

  function el(id) { return document.getElementById(id); }

  var ui = {
    project: el('project'), app: el('app'),
    clock: el('clock'), state: el('state'), note: el('note'),
    progress: el('progress'), counts: el('counts'),
    rail: el('rail'), list: el('list'), listempty: el('listempty'), follow: el('follow'),
    stage: el('stage'), frame: el('frame'), layerA: el('layerA'), layerB: el('layerB'), empty: el('empty'),
    tabs: el('tabs'),
    shotname: el('shotname'), shotdesc: el('shotdesc'), shotout: el('shotout'),
    timing: el('timing'), tbar: el('tbar'), tkey: el('tkey'),
    footer: el('footer'), footlead: el('footlead'), cmdrow: el('cmdrow'), cmd: el('cmd'), copy: el('copy'),
    lightbox: el('lightbox'), lightimg: el('lightimg')
  };

  // -------------------------------------------------------------------------
  // Words. These match the terminal on purpose — the same run should not be
  // described two different ways depending on where you happen to be reading.
  // The originals live in src/report/console.js.
  // -------------------------------------------------------------------------

  function commas(n) {
    var v = Math.round(Number(n) || 0);
    return v.toLocaleString('en-US');
  }

  function fmt(ms) {
    var v = Number(ms);
    if (!isFinite(v) || v < 0) v = 0;
    if (v < 1000) return Math.round(v) + 'ms';
    if (v < 60000) return (v / 1000).toFixed(1) + 's';
    var m = Math.floor(v / 60000);
    var s = Math.round((v % 60000) / 1000);
    return m + 'm ' + s + 's';
  }

  function plural(n, one, many) { return n === 1 ? one : many; }

  // Colour is the only thing carrying state here, so the mapping is the whole
  // vocabulary: green held, amber moved, red broke, blue is waiting for a
  // person to look, grey was never run.
  function toneOf(status) {
    switch (status) {
      case 'running': return 'running';
      case 'passed': return 'good';
      case 'changed': case 'flaky': return 'warn';
      case 'failed': case 'missing': return 'bad';
      case 'new': return 'wait';
      case 'skipped': return 'muted';
      default: return '';
    }
  }

  function outcomeText(kind, ev) {
    var status = ev.status;
    if (kind === 'guard') {
      if (status === 'passed') return 'still holds';
      if (status === 'skipped') return 'left out on purpose';
      return ev.message || 'this one is broken again';
    }
    switch (status) {
      case 'passed': return 'still the same';
      case 'changed':
        var n = ev.diffPixels || 0;
        return 'looks different — ' + commas(n) + ' ' + plural(n, 'pixel', 'pixels') + ' changed';
      case 'new': return 'nobody has approved this picture yet';
      case 'missing': return 'the approved picture is gone';
      case 'failed': return ev.message || 'could not be photographed';
      case 'flaky': return 'changed its mind between tries';
      case 'skipped': return 'left out on purpose';
      default: return ev.message || '';
    }
  }

  // -------------------------------------------------------------------------
  // The list, and the progress bar that shadows it
  // -------------------------------------------------------------------------

  var rows = Object.create(null);
  var order = [];
  var outcomes = Object.create(null);

  function keyFor(kind, name) { return kind + ':' + name; }

  function addRow(kind, name, describe) {
    var root = document.createElement('div');
    root.className = 'row fresh';

    var dot = document.createElement('span');
    dot.className = 'dot';
    root.appendChild(dot);

    var main = document.createElement('div');
    main.className = 'rowmain';

    var top = document.createElement('div');
    top.className = 'rowtop';
    var rname = document.createElement('span');
    rname.className = 'rname';
    rname.textContent = name;
    var rtime = document.createElement('span');
    rtime.className = 'rtime';
    top.appendChild(rname);
    top.appendChild(rtime);
    main.appendChild(top);

    var rdesc = document.createElement('div');
    rdesc.className = 'rdesc';
    rdesc.textContent = describe || '';
    rdesc.hidden = !describe;
    main.appendChild(rdesc);

    var rout = document.createElement('div');
    rout.className = 'rout';
    rout.hidden = true;
    main.appendChild(rout);

    var rwhy = document.createElement('div');
    rwhy.className = 'rwhy';
    rwhy.hidden = true;
    main.appendChild(rwhy);

    root.appendChild(main);
    ui.list.appendChild(root);
    ui.listempty.hidden = true;

    var seg = document.createElement('span');
    seg.className = 'seg';
    ui.progress.appendChild(seg);

    var entry = { kind: kind, name: name, root: root, time: rtime, desc: rdesc, out: rout, why: rwhy, seg: seg };
    rows[keyFor(kind, name)] = entry;
    order.push(entry);
    return entry;
  }

  function ensureRow(kind, name, describe) {
    var entry = rows[keyFor(kind, name)];
    if (!entry) return addRow(kind, name, describe);
    if (describe && !entry.desc.textContent) {
      entry.desc.textContent = describe;
      entry.desc.hidden = false;
    }
    return entry;
  }

  function setTone(entry, tone) {
    entry.root.className = 'row' + (tone ? ' ' + tone : '');
    entry.seg.className = 'seg' + (tone ? ' ' + tone : '');
  }

  function updateCounts() {
    var done = 0;
    for (var i = 0; i < order.length; i++) {
      if (outcomes[keyFor(order[i].kind, order[i].name)]) done++;
    }
    var total = order.length;
    ui.counts.textContent = total
      ? commas(done) + ' of ' + commas(total) + ' done'
      : '';
    ui.listempty.hidden = total > 0;
  }

  // Auto-scroll follows the running row, and stops the moment the person
  // scrolls for themselves. Nothing is more annoying than a list that yanks
  // itself back while you are reading it.
  var following = true;
  function stopFollowing() {
    if (!following) return;
    following = false;
    ui.follow.hidden = false;
  }
  ['wheel', 'touchmove', 'pointerdown', 'keydown'].forEach(function (name) {
    ui.rail.addEventListener(name, stopFollowing, { passive: true });
  });
  ui.follow.addEventListener('click', function () {
    following = true;
    ui.follow.hidden = true;
    if (runningRow) runningRow.root.scrollIntoView({ block: 'nearest' });
  });

  var runningRow = null;
  function markRunning(entry) {
    runningRow = entry;
    setTone(entry, 'running');
    if (following) entry.root.scrollIntoView({ block: 'nearest' });
  }

  // -------------------------------------------------------------------------
  // The picture
  // -------------------------------------------------------------------------

  var frontIsA = false;
  var lastShot = '';
  var shownSrc = '';
  var shownAlt = '';

  function showShot(src, alt) {
    if (!src) return;
    // A run that turned out to have pictures after all gets its glass back.
    ui.stage.hidden = false;
    shownSrc = src;
    shownAlt = alt || '';
    ui.empty.hidden = true;
    ui.frame.classList.remove('blank');
    var next = frontIsA ? ui.layerB : ui.layerA;
    var current = frontIsA ? ui.layerA : ui.layerB;
    next.src = src;
    next.alt = shownAlt;
    next.classList.add('on');
    current.classList.remove('on');
    frontIsA = !frontIsA;
  }

  function nameTheShot(name, describe) {
    ui.shotname.textContent = name || '';
    ui.shotdesc.textContent = describe || '';
  }

  function tintStage(tone) {
    ui.stage.style.setProperty('--tint', tone ? 'var(--' + tone + ')' : 'var(--accent)');
  }

  function clearTabs() {
    ui.tabs.hidden = true;
    ui.tabs.textContent = '';
  }

  function singlePicture() {
    clearTabs();
    ui.shotout.hidden = true;
  }

  /**
   * The one line under the picture. Silent when a screen simply held, because a
   * panel that congratulates you on every screen is a panel you stop reading.
   */
  function sayOutcome(tone, text) {
    if (!text || !tone || tone === 'good' || tone === 'muted') {
      ui.shotout.hidden = true;
      return;
    }
    ui.shotout.textContent = text;
    ui.shotout.className = 'shotout ' + tone;
    ui.shotout.hidden = false;
  }

  // A screen that moved is the one moment a person has a real decision to make,
  // so all three pictures are one keypress away and the difference is the one
  // already on screen — that is the picture that answers the question.
  function comparePictures(ev) {
    var choices = [];
    if (ev.approvedThumb) choices.push({ label: 'Approved', src: ev.approvedThumb });
    var now = ev.thumbnail || lastShot;
    if (now) choices.push({ label: 'Now', src: now });
    if (ev.diffThumb) choices.push({ label: 'Difference', src: ev.diffThumb });
    // Two pictures is the whole point; one on its own says nothing a person
    // could act on, so leave the live picture up instead.
    if (choices.length < 2) return false;

    ui.tabs.textContent = '';
    var buttons = [];
    function select(index) {
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].className = i === index ? 'tab on' : 'tab';
      }
      showShot(choices[index].src, choices[index].label.toLowerCase() + ' picture of ' + (ev.name || 'this screen'));
    }
    choices.forEach(function (choice, index) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'tab';
      button.textContent = choice.label;
      button.addEventListener('click', function () { select(index); });
      buttons.push(button);
      ui.tabs.appendChild(button);
    });
    ui.tabs.hidden = false;

    var preferred = choices.length - 1;
    for (var i = 0; i < choices.length; i++) {
      if (choices[i].label === 'Difference') preferred = i;
    }
    select(preferred);
    return true;
  }

  function enlarge(src, alt) {
    if (!src) return;
    ui.lightimg.src = src;
    ui.lightimg.alt = alt || '';
    ui.lightbox.hidden = false;
  }
  ui.frame.addEventListener('click', function () { enlarge(shownSrc, shownAlt); });
  ui.lightbox.addEventListener('click', function () { ui.lightbox.hidden = true; });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') ui.lightbox.hidden = true;
  });

  // -------------------------------------------------------------------------
  // The clock
  // -------------------------------------------------------------------------

  var origin = null;
  var ticking = null;

  function startClock(at) {
    if (origin !== null) return;
    origin = performance.now() - (Number(at) || 0);
    ticking = setInterval(function () {
      ui.clock.textContent = fmt(performance.now() - origin);
    }, 100);
  }

  function stopClock(finalMs) {
    if (ticking) { clearInterval(ticking); ticking = null; }
    if (typeof finalMs === 'number' && isFinite(finalMs)) ui.clock.textContent = fmt(finalMs);
  }

  // -------------------------------------------------------------------------
  // Where the time went
  // -------------------------------------------------------------------------

  var TIMING_PARTS = [
    ['launch', 'opening the app', 'var(--accent)'],
    ['steps', 'clicking through the app', 'var(--shade1)'],
    ['prepare', 'waiting for fonts and pictures', 'var(--shade2)'],
    ['settle', 'waiting for the screen to hold still', 'var(--warn)'],
    ['compare', 'comparing the pictures', 'var(--good)'],
    ['guards', 'running the guards', 'var(--shade3)'],
    ['other', 'everything else', 'var(--shade4)']
  ];

  function showTiming(timings) {
    if (!timings || typeof timings !== 'object') return;
    var parts = [];
    var sum = 0;
    TIMING_PARTS.forEach(function (part) {
      var ms = Number(timings[part[0]]);
      if (!isFinite(ms) || ms <= 0) return;
      sum += ms;
      parts.push({ label: part[1], colour: part[2], ms: ms });
    });
    if (!parts.length || sum <= 0) return;

    ui.tbar.textContent = '';
    ui.tkey.textContent = '';
    parts.forEach(function (part) {
      var bar = document.createElement('span');
      bar.className = 'tpart';
      bar.style.flex = String(part.ms / sum) + ' 1 0';
      bar.style.background = part.colour;
      bar.title = part.label + ' — ' + fmt(part.ms);
      ui.tbar.appendChild(bar);

      var item = document.createElement('li');
      var swatch = document.createElement('span');
      swatch.className = 'tswatch';
      swatch.style.background = part.colour;
      var text = document.createElement('span');
      text.textContent = part.label + ' ';
      var value = document.createElement('b');
      value.textContent = fmt(part.ms);
      item.appendChild(swatch);
      item.appendChild(text);
      item.appendChild(value);
      ui.tkey.appendChild(item);
    });
    ui.timing.hidden = false;
  }

  // -------------------------------------------------------------------------
  // What to do next
  // -------------------------------------------------------------------------

  function showNextStep(summary, verdict, tone) {
    var pictures = (summary && summary.pictures) || [];
    var waiting = pictures.filter(function (p) {
      return p && (p.status === 'changed' || p.status === 'new' || p.status === 'missing');
    });
    ui.footer.hidden = false;
    ui.footlead.textContent = verdict || '';
    ui.footlead.className = 'footverdict' + (tone ? ' ' + tone : '');
    if (!waiting.length) {
      ui.cmdrow.hidden = true;
      return;
    }
    ui.cmd.textContent = waiting.length === 1
      ? 'staysfixed approve ' + waiting[0].name
      : 'staysfixed approve --all';
    ui.cmdrow.hidden = false;
  }

  ui.copy.addEventListener('click', function () {
    var text = ui.cmd.textContent || '';
    var original = ui.copy.textContent;
    function done() {
      ui.copy.textContent = 'copied';
      setTimeout(function () { ui.copy.textContent = original; }, 1200);
    }
    // A page opened from a file is not a secure context, so the modern
    // clipboard is usually refused here. The old way still works.
    var box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    try { document.execCommand('copy'); done(); } catch (err) { /* nothing to do */ }
    document.body.removeChild(box);
  });

  // -------------------------------------------------------------------------
  // The state line
  // -------------------------------------------------------------------------

  function setState(text, tone) {
    ui.state.textContent = text;
    ui.state.className = 'state' + (tone ? ' ' + tone : '');
  }

  function countOf(list) { return Array.isArray(list) ? list.length : 0; }

  var announcedScreens = false;
  var announcedGuards = false;

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  function handle(ev) {
    var type = ev.type;
    if (typeof ev.at === 'number') startClock(ev.at);

    if (type === 'run:start') {
      var planned = ev.plan || {};
      if (planned.project) ui.project.textContent = planned.project;
      if (planned.app) ui.app.textContent = planned.app;
      setState('opening the app');
      updateCounts();
      return;
    }

    if (type === 'phase') {
      if (ev.message) setState(ev.message);
      return;
    }

    if (type === 'note') {
      if (ev.message) { ui.note.textContent = ev.message; ui.note.hidden = false; }
      return;
    }

    if (type === 'screen:start') {
      if (!announcedScreens) {
        announcedScreens = true;
        var screens = ev.total || countOf(plan.screens);
        setState(screens ? 'photographing ' + commas(screens) + ' ' + plural(screens, 'screen', 'screens') : 'photographing the screens');
      }
      // The picture is deliberately left alone here. Nothing has been
      // photographed yet, so renaming the frame now would put this screen's
      // name under the last screen's picture — a caption that lies for a
      // second is worse than one that is a second behind.
      markRunning(ensureRow('picture', String(ev.name || ''), ev.describe));
      return;
    }

    if (type === 'screen:shot') {
      if (ev.thumbnail) {
        lastShot = ev.thumbnail;
        singlePicture();
        showShot(ev.thumbnail, 'the picture just taken of ' + (ev.name || 'this screen'));
      }
      if (ev.name) nameTheShot(ev.name, ev.describe);
      return;
    }

    if (type === 'screen:done') {
      var done = ensureRow('picture', String(ev.name || ''), ev.describe);
      var tone = finish(done, 'picture', ev);
      if (ev.thumbnail) lastShot = ev.thumbnail;
      // The name, the description and the colour behind the glass all move
      // together with the picture, or none of them move. A screen that could
      // not be photographed leaves the last real one up, correctly labelled,
      // rather than putting its own name under someone else's picture.
      var showed = false;
      if (ev.status === 'changed') {
        showed = comparePictures(ev);
        if (!showed && ev.thumbnail) {
          singlePicture();
          showShot(ev.thumbnail, 'the picture just taken of ' + (ev.name || 'this screen'));
          showed = true;
        }
      } else if (ev.thumbnail) {
        singlePicture();
        showShot(ev.thumbnail, 'the picture just taken of ' + (ev.name || 'this screen'));
        showed = true;
      }
      if (showed) {
        nameTheShot(ev.name, ev.describe);
        tintStage(tone === 'running' ? '' : tone);
        // Anything but "still the same" is said under the picture as well as in
        // the list, because the picture is where the person is looking and the
        // line under it is what tells them there is something to decide.
        sayOutcome(tone, outcomeText('picture', ev));
      }
      return;
    }

    if (type === 'guard:start') {
      if (!announcedGuards) {
        announcedGuards = true;
        var guards = ev.total || countOf(plan.guards);
        setState(guards ? 'running ' + commas(guards) + ' ' + plural(guards, 'guard', 'guards') : 'running the guards');
      }
      markRunning(ensureRow('guard', String(ev.name || ''), ev.describe));
      return;
    }

    if (type === 'guard:done') {
      finish(ensureRow('guard', String(ev.name || ''), ev.describe), 'guard', ev);
      return;
    }

    if (type === 'run:done') {
      runningRow = null;
      var summary = ev.summary || null;
      stopClock(typeof ev.at === 'number' ? ev.at : (summary && summary.durationMs));
      var verdict = ev.verdict || fallbackVerdict();
      var verdictTone = worstTone();
      setState(verdict, verdictTone);
      tintStage(verdictTone);
      showTiming(ev.timings || (summary && summary.timings));
      showNextStep(summary, verdict, verdictTone);
      updateCounts();
      // The timing card has just appeared under the list and taken room from
      // it, so the tail is put back in view — otherwise a run ends showing the
      // middle of itself, and the breakdown it just drew is below the fold.
      if (following) {
        requestAnimationFrame(function () {
          ui.rail.scrollTop = ui.rail.scrollHeight;
        });
      }
      return;
    }
    // Anything else is something a newer version of Stays Fixed knows about
    // and this page does not. Ignoring it is the only safe thing to do.
  }

  function finish(entry, kind, ev) {
    var tone = toneOf(ev.status);
    setTone(entry, tone);
    if (typeof ev.durationMs === 'number') entry.time.textContent = fmt(ev.durationMs);
    var text = outcomeText(kind, ev);
    if (text) {
      entry.out.textContent = text;
      entry.out.className = 'rout' + (tone ? ' ' + tone : '');
      entry.out.hidden = false;
    }
    if (kind === 'guard' && ev.status === 'failed') {
      entry.why.textContent = '';
      if (ev.failedAt) {
        var claim = document.createElement('div');
        claim.className = 'rclaim';
        claim.textContent = 'expected: ' + ev.failedAt;
        entry.why.appendChild(claim);
      }
      if (ev.because && ev.because !== entry.desc.textContent) {
        var why = document.createElement('div');
        why.className = 'rbecause';
        why.textContent = 'Why this guard exists: ' + ev.because;
        entry.why.appendChild(why);
      }
      entry.why.hidden = !entry.why.firstChild;
    }
    outcomes[keyFor(entry.kind, entry.name)] = tone || 'good';
    updateCounts();
    return tone;
  }

  // The worst thing that happened, as a colour. Red beats amber beats blue
  // beats green, because a person should see the most serious state first.
  function worstTone() {
    var rank = { bad: 4, warn: 3, wait: 2, good: 1, muted: 0 };
    var worst = 'good';
    for (var key in outcomes) {
      var tone = outcomes[key];
      if ((rank[tone] || 0) > (rank[worst] || 0)) worst = tone;
    }
    return worst === 'muted' ? '' : worst;
  }

  // Only used when a run finishes without the verdict the terminal printed —
  // an older run, or one that stopped early. It deliberately does not try to
  // reproduce those sentences; src/report/console.js owns them.
  function fallbackVerdict() {
    var total = order.length;
    var bad = 0;
    for (var key in outcomes) {
      if (outcomes[key] === 'bad' || outcomes[key] === 'warn' || outcomes[key] === 'wait') bad++;
    }
    if (!total) return 'finished';
    if (!bad) return 'Everything that worked still works.';
    return commas(bad) + ' of ' + commas(total) + ' ' + plural(total, 'check', 'checks') + ' needs a look.';
  }

  // -------------------------------------------------------------------------
  // The one thing the run calls
  // -------------------------------------------------------------------------

  window.__staysfixed_push = function (input) {
    try {
      var ev = typeof input === 'string' ? JSON.parse(input) : input;
      if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return;
      handle(ev);
    } catch (err) {
      // A watch window must never be the reason a run looks broken. Whatever
      // this event was, the next one still has to land.
    }
  };

  // Called when the run lets go of the window, so the clock does not tick on
  // forever next to a result that is already final.
  window.__staysfixed_detach = function () {
    stopClock();
    runningRow = null;
  };

  // Draw the plan before anything has happened, so the window is worth looking
  // at from the first frame instead of appearing empty.
  (function seed() {
    var i;
    for (i = 0; i < (plan.screens || []).length; i++) {
      addRow('picture', plan.screens[i].name, plan.screens[i].describe);
    }
    for (i = 0; i < (plan.guards || []).length; i++) {
      addRow('guard', plan.guards[i].name, plan.guards[i].describe);
    }
    updateCounts();
    if (!order.length) ui.frame.classList.add('blank');
    // Guards only: there will never be a picture, so the panel does not hold
    // a screen's worth of empty glass open waiting for one.
    if (!(plan.screens || []).length && (plan.guards || []).length) ui.stage.hidden = true;
  })();
})();
`;
