/**
 * The page inside the watch window — the calm companion.
 *
 * This builds one self-contained HTML document as a string. It is written to a
 * temp file and opened over a local file address, so it can fetch nothing: no
 * fonts, no CDN, no framework, no build step. Everything it will ever need is
 * in the string this file returns, including every icon, which are drawn here
 * in SVG rather than downloaded from anywhere.
 *
 * It is fed one `RunEvent` at a time by `window.__staysfixed_push`, which the
 * run calls over the debugging connection as things happen. The page keeps no
 * state of its own beyond what those events tell it, so a panel that opens late
 * and is handed the whole history catches up by replaying it.
 *
 * The design brief, in one line: this thing is pinned against a person's work
 * all day, so it must be pleasant to have open and never once demand attention
 * it has not earned. That gives three rules the whole layout follows.
 *
 *   1. The picture is the hero. It is the only large thing on the page, and
 *      everything else is sized to defer to it. A watch panel that shows you a
 *      photograph of your own app the instant the shutter fires is alive; a
 *      watch panel that shows you a list of names is a log file with a border.
 *
 *   2. Nothing is said twice, and detail is earned. At rest every check is one
 *      quiet line — a dot, a name, a time. The description, the outcome, the
 *      claim that failed and the story of why a guard exists all live one click
 *      away, and open by themselves only for the checks that need a person. A
 *      run where everything held is therefore almost silent, which is exactly
 *      how often it deserves to be read.
 *
 *   3. Colour is state and nothing else. One accent (blue: something is
 *      happening, or someone is needed), one green (held), one amber (moved),
 *      one red (broke). The timing breakdown, which is information rather than
 *      state, is drawn in shades of the text colour — so a screenful of colour
 *      always means a screenful of things to look at.
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
 * JSON safe to sit inside a script tag. A closing tag inside a string would end
 * the tag early and leave half the plan on the page as text, so the one
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
 * A caller who has counted rather than listed hands us a number, which is not
 * a list and is not an error either — it becomes an empty list here, and the
 * counts arrive separately on `run:start`.
 * @param {PanelRow[]|number|undefined} list
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
 * It carries no namespace attribute: inline SVG in an HTML document does not
 * need one, and the panel is not allowed to name an address of any kind.
 */
const MARK = [
  '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor"',
  ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
  '<rect x="4.2" y="10" width="15.6" height="10.4" rx="3.6"></rect>',
  '<path d="M8.1 10V7.9a3.9 3.9 0 0 1 7.8 0V10"></path>',
  '<path d="M9.7 15.2l1.8 1.9 2.9-3.5"></path>',
  '</svg>',
].join('');

/** A chevron, used for every "there is more underneath this" control. */
const CHEVRON = [
  '<svg class="glyph chev" viewBox="0 0 24 24" fill="none" stroke="currentColor"',
  ' stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
  '<path d="M8.5 10.5l3.5 3.5 3.5-3.5"></path>',
  '</svg>',
].join('');

/** Two stacked sheets: copy. */
const COPY = [
  '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor"',
  ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
  '<rect x="9" y="9" width="11" height="11" rx="3"></rect>',
  '<path d="M15 6.2A2.2 2.2 0 0 0 12.8 4H7a3 3 0 0 0-3 3v5.8A2.2 2.2 0 0 0 6.2 15"></path>',
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
  const screens = tidyRows(/** @type {any} */ (plan.screens));
  const guards = tidyRows(/** @type {any} */ (plan.guards));

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
    // Just the name of the thing, because this string IS the window's title bar.
    // "tdproof — Stays Fixed" reads as a browser tab; "Stays Fixed" reads as an
    // application. What is being watched is said inside the panel, under the mark.
    '<title>Stays Fixed</title>',
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<div class="aura" aria-hidden="true"></div>',
    '<div class="panel">',

    // --- the header: whose window this is, and where the run has got to -----
    '<header class="top">',
    '<div class="brand">',
    `<span class="badge">${MARK}</span>`,
    '<span class="wordmark">Stays Fixed</span>',
    '<span class="elapsed mono" id="clock">0.0s</span>',
    '</div>',
    `<p class="target" id="target"><span class="mono" id="project">${escapeHtml(project)}</span>`,
    `<span class="sep"${app ? '' : ' hidden'} id="targetsep">&#183;</span>`,
    `<span class="app" id="app"${app ? '' : ' hidden'}>${escapeHtml(app)}</span></p>`,
    '<p class="state" id="state">getting ready</p>',
    '<p class="note" id="note" hidden></p>',
    '<div class="meter">',
    '<div class="track" id="track"><div class="fill" id="fill"></div></div>',
    '<span class="counts mono" id="counts"></span>',
    '</div>',
    '</header>',

    // --- the two columns. One on a narrow panel, two on a wide one. ---------
    '<div class="body">',

    // --- the hero: the picture that was just taken -------------------------
    '<section class="stage" id="stage">',
    '<div class="shot" id="shot">',
    '<img class="layer" id="layerA" alt="">',
    '<img class="layer" id="layerB" alt="">',
    '<p class="blank" id="blank">The first picture appears the moment it is taken.</p>',
    '</div>',
    '<div class="caption" id="caption">',
    '<span class="shotname mono" id="shotname"></span>',
    '<span class="shotout" id="shotout" hidden></span>',
    '</div>',
    '<div class="switch" id="tabs" hidden></div>',
    '</section>',

    // --- every check, one quiet line each ----------------------------------
    '<div class="scroll" id="scroll">',
    '<section class="group" id="groupScreens" hidden>',
    '<p class="grouplabel">Screens<span class="mono" id="countScreens"></span></p>',
    '<div class="items" id="listScreens"></div>',
    '</section>',
    '<section class="group" id="groupGuards" hidden>',
    '<p class="grouplabel">Guards<span class="mono" id="countGuards"></span></p>',
    '<div class="items" id="listGuards"></div>',
    '</section>',
    '<p class="nothing" id="nothing" hidden>Nothing is set up to be checked yet.<br>Run <span class="mono">staysfixed init</span> to pick the screens worth watching.</p>',
    '</div>',

    '</div>',

    '<button class="follow" id="follow" type="button" hidden>Follow the run</button>',

    // --- where the time went. One folded line, so it is always in sight and
    //     never in the way. ------------------------------------------------
    '<section class="timing" id="timing" hidden>',
    '<button class="tophead" id="thead" type="button" aria-expanded="false">',
    '<span class="tlabel">Where the time went</span>',
    '<span class="ttotal" id="ttotal"></span>',
    `${CHEVRON}`,
    '</button>',
    '<div class="tbar" id="tbar"></div>',
    '<ul class="tkey" id="tkey" hidden></ul>',
    '</section>',

    // --- the one thing left to do ------------------------------------------
    '<footer class="foot" id="footer" hidden>',
    '<p class="nextlabel" id="nextlabel">Your turn</p>',
    '<div class="cmd">',
    // The prompt mark is not decoration: it is what tells a person at a glance that
    // this line is something to type, not something to read. It is never copied.
    '<span class="prompt mono" aria-hidden="true">$</span>',
    '<code class="mono" id="cmd"></code>',
    `<button class="copy" id="copy" type="button" title="copy" aria-label="copy the command">${COPY}</button>`,
    '</div>',
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
   Tokens.

   Four colours carry meaning and nothing else does: accent blue for "this is
   happening" and "you are needed", green for held, amber for moved, red for
   broke. Everything structural is the ground, the ink, or a hairline. That is
   what lets a single amber dot be seen from across a desk.

   Dark is the design — this window lives beside an editor all day. Light is a
   warm paper, never the white page with grey cards the brief rules out.
   -------------------------------------------------------------------------- */
:root {
  color-scheme: dark;

  --ground: #0a0c12;
  --lift: #12161f;
  --card: rgba(255, 255, 255, 0.032);
  --card-hover: rgba(255, 255, 255, 0.055);
  --well: #070910;
  --glass: rgba(10, 12, 18, 0.74);

  --ink: #e7eaf2;
  --soft: #939bad;
  --faint: #616a7d;

  --line: rgba(255, 255, 255, 0.07);
  --line-firm: rgba(255, 255, 255, 0.13);
  --sheen: rgba(255, 255, 255, 0.06);
  --shadow: rgba(0, 0, 0, 0.66);

  --accent: #6f9dff;
  --held: #55bd8c;
  --moved: #e2a84f;
  --broke: #ef6a61;
  --resting: rgba(255, 255, 255, 0.09);

  --radius: 20px;
  --radius-sm: 13px;
  --radius-xs: 9px;

  --pad: 16px;
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

  --ground: #e3ded3;
  --lift: #fdfbf7;
  --card: rgba(255, 255, 255, 0.82);
  --card-hover: rgba(255, 255, 255, 1);
  --well: #dad4c8;
  --glass: rgba(231, 226, 217, 0.82);

  --ink: #1c1a16;
  --soft: #6b665c;
  --faint: #8b8578;

  --line: rgba(28, 24, 18, 0.1);
  --line-firm: rgba(28, 24, 18, 0.19);
  --sheen: rgba(255, 255, 255, 0.85);
  --shadow: rgba(58, 47, 30, 0.34);

  --accent: #2f57c9;
  --held: #1f7a4d;
  --moved: #94620a;
  --broke: #b52f23;
  --resting: rgba(28, 24, 18, 0.1);
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  background: var(--ground);
  color: var(--ink);
  font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}
/* The terminal character of the thing: every name, number and command is set
   in the monospace, and nothing else is. */
.mono, code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-variant-numeric: tabular-nums;
}
p, h2 { margin: 0; }
img { display: block; }
button { font: inherit; color: inherit; }
.glyph { width: 16px; height: 16px; flex: 0 0 auto; }

/* A single soft light from above, tinted by how the run is going. It is the
   only decoration on the page, it has no edge you could point at, and it is
   the thing that stops the dark reading as a hole in the screen. */
.aura {
  position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background:
    radial-gradient(120% 46% at 50% -8%, color-mix(in srgb, var(--tint) 15%, transparent), transparent 70%),
    radial-gradient(100% 60% at 50% 112%, var(--shadow), transparent 66%);
  transition: background 500ms ease;
}

.panel {
  position: relative; z-index: 1;
  display: flex; flex-direction: column;
  height: 100%;
}

/* --- header -------------------------------------------------------------- */
.top {
  flex: 0 0 auto;
  padding: 15px var(--pad) 14px;
  background: var(--glass);
  backdrop-filter: blur(22px) saturate(150%);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
  border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: 9px; }
.badge {
  flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center;
  width: 24px; height: 24px;
  border-radius: 8px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 13%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 24%, transparent);
}
.badge .glyph { width: 15px; height: 15px; }
.wordmark {
  flex: 1 1 auto; min-width: 0;
  font-size: 11px; font-weight: 600;
  letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--soft);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.elapsed { flex: 0 0 auto; font-size: 11.5px; color: var(--faint); }

.target {
  display: flex; align-items: baseline; gap: 6px;
  margin-top: 12px;
  font-size: 12px;
  white-space: nowrap; overflow: hidden;
}
.target .mono { color: var(--ink); flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
.target .sep { color: var(--faint); flex: 0 0 auto; }
.target .app { color: var(--faint); flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; font-size: 11.5px; }

/* The sentence. The largest text on the page after the picture, because it is
   the one thing a person reads from four feet away. */
.state {
  margin-top: 9px;
  font-size: 17px; font-weight: 620; line-height: 1.32;
  letter-spacing: -0.011em;
  overflow-wrap: anywhere;
  transition: color 300ms ease;
}
.state.held { color: var(--ink); }
.state.moved { color: var(--moved); }
.state.broke { color: var(--broke); }
.state.wait { color: var(--accent); }
.note { margin-top: 5px; font-size: 11.5px; color: var(--faint); overflow-wrap: anywhere; }

/* One hairline, not a row of blocks. Each finished check adds its own slice of
   colour to a single continuous line, so progress and outcome are the same
   object and there is one fewer thing on the page. */
.meter { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
.track {
  flex: 1 1 auto; min-width: 0;
  height: 4px; border-radius: 999px;
  background: var(--resting);
  overflow: hidden;
}
.fill { display: flex; height: 100%; width: 100%; }
.slice {
  min-width: 0; height: 100%;
  background: var(--resting);
  transition: background 260ms ease, flex-basis 260ms ease;
}
.slice.held { background: var(--held); }
.slice.moved { background: var(--moved); }
.slice.broke { background: var(--broke); }
.slice.wait { background: var(--accent); }
.slice.skip { background: color-mix(in srgb, var(--ink) 16%, transparent); }
.slice.running {
  background: var(--accent);
  animation: breathe 1.9s ease-in-out infinite;
}
@keyframes breathe { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
.counts { flex: 0 0 auto; font-size: 10.5px; color: var(--faint); letter-spacing: 0.02em; }

/* --- the body: one column, or two when there is room --------------------- */
.body {
  flex: 1 1 auto; min-height: 0;
  display: flex; flex-direction: column;
  gap: 4px;
  padding: 0 var(--pad);
  overflow: hidden;
}

/* --- the hero ------------------------------------------------------------ */
.stage { flex: 0 0 auto; padding-top: 16px; }
.shot {
  position: relative;
  aspect-ratio: 16 / 10;
  max-height: 40vh;
  margin: 0 auto;
  border-radius: var(--radius);
  background: var(--well);
  overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  cursor: zoom-in;
  /* No border. The picture is the hero, so nothing is drawn around it that
     could compete with it — only a soft floor shadow and the faintest rim to
     keep a white screenshot from bleeding into a light ground. */
  box-shadow:
    0 1px 0 0 var(--sheen) inset,
    0 0 0 1px var(--line),
    0 26px 50px -30px var(--shadow);
  transition: box-shadow 300ms ease;
}
.shot.empty { cursor: default; }
.layer {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  object-fit: contain;
  opacity: 0;
  transition: opacity 260ms ease;
}
.layer.on { opacity: 1; }
.blank {
  position: relative;
  color: var(--faint); font-size: 11.5px; line-height: 1.6;
  text-align: center; padding: 0 30px; max-width: 260px;
}

.caption {
  display: flex; align-items: baseline; gap: 10px;
  margin-top: 11px; min-height: 18px;
}
.shotname { flex: 0 1 auto; font-size: 12px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shotout { flex: 1 1 auto; min-width: 0; font-size: 11.5px; color: var(--soft); text-align: right; overflow-wrap: anywhere; }
.shotout.moved { color: var(--moved); }
.shotout.broke { color: var(--broke); }
.shotout.wait { color: var(--accent); }

/* Approved / now / difference. One pill, three quiet words — the only control
   on the page that is ever shown without being asked for, because a screen
   that moved is the one moment there is a real decision to make. */
.switch {
  display: flex; gap: 2px;
  margin-top: 10px; padding: 2px;
  border-radius: 999px;
  background: var(--card);
  box-shadow: inset 0 0 0 1px var(--line);
}
.switch button {
  flex: 1 1 0; min-width: 0;
  font-size: 11px; letter-spacing: 0.01em;
  color: var(--soft);
  background: transparent; border: 0;
  border-radius: 999px;
  padding: 5px 6px; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: color 160ms ease, background 160ms ease;
}
.switch button:hover { color: var(--ink); }
.switch button.on {
  color: var(--ink);
  background: var(--card-hover);
  box-shadow: 0 1px 2px -1px var(--shadow), inset 0 0 0 1px var(--line);
}

/* --- the list ------------------------------------------------------------ */
.scroll {
  flex: 1 1 auto; min-height: 70px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--soft) 22%, transparent) transparent;
  padding: 16px 5px 14px 0;
  /* The list slides away under the header rather than being cut off by a box. */
  mask-image: linear-gradient(to bottom, transparent 0, #000 16px, #000 calc(100% - 12px), transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 16px, #000 calc(100% - 12px), transparent 100%);
}
.scroll::-webkit-scrollbar { width: 10px; }
.scroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--soft) 22%, transparent);
  border-radius: 8px; border: 3px solid transparent; background-clip: padding-box;
}
.scroll::-webkit-scrollbar-track { background: transparent; }

.group + .group { margin-top: 18px; }
.grouplabel {
  display: flex; align-items: baseline; gap: 9px;
  padding: 0 6px 8px 4px;
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--faint);
}
.grouplabel .mono { font-size: 10px; letter-spacing: 0.04em; color: color-mix(in srgb, var(--faint) 70%, transparent); }

.items {
  border-radius: var(--radius);
  background: var(--card);
  box-shadow: inset 0 0 0 1px var(--line), 0 18px 34px -30px var(--shadow);
  overflow: hidden;
}
.item + .item { box-shadow: inset 0 1px 0 var(--line); }
.item.attention { background: color-mix(in srgb, var(--tone, var(--accent)) 5%, transparent); }

/* Big, quiet, touch-sized rows. At rest a check is a dot, a name and a time —
   that is the whole of it. */
.row {
  display: flex; align-items: center; gap: 11px;
  width: 100%; min-height: 44px;
  padding: 10px 14px;
  text-align: left;
  background: transparent; border: 0;
  cursor: pointer;
  transition: background 160ms ease;
}
.row:hover { background: var(--card-hover); }
.row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.item.plain .row { cursor: default; }
.item.showing .row { box-shadow: inset 2px 0 0 var(--line-firm); }
.item.showing .rname { color: var(--ink); }
.item.plain .row:hover { background: transparent; }
.item.fresh { animation: settle 200ms ease both; }
@keyframes settle { from { opacity: 0; } to { opacity: 1; } }

.dot {
  flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%;
  background: var(--resting);
  transition: background 240ms ease, box-shadow 240ms ease;
}
.item.held .dot { background: color-mix(in srgb, var(--held) 78%, transparent); }
.item.moved .dot { background: var(--moved); box-shadow: 0 0 0 4px color-mix(in srgb, var(--moved) 15%, transparent); }
.item.broke .dot { background: var(--broke); box-shadow: 0 0 0 4px color-mix(in srgb, var(--broke) 15%, transparent); }
.item.wait .dot { background: var(--accent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 15%, transparent); }
.item.skip .dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--resting); }
.item.running .dot {
  background: transparent;
  box-shadow: inset 0 0 0 2px var(--accent);
  animation: ping 1.7s ease-out infinite;
}
@keyframes ping {
  0% { box-shadow: inset 0 0 0 2px var(--accent), 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent); }
  70%, 100% { box-shadow: inset 0 0 0 2px var(--accent), 0 0 0 7px color-mix(in srgb, var(--accent) 0%, transparent); }
}
.item.running .rname { color: var(--ink); }

.rname {
  flex: 1 1 auto; min-width: 0;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 12px; color: var(--ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.item.pending .rname, .item.skip .rname { color: var(--faint); }
.rtime {
  flex: 0 0 auto;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 10.5px; color: var(--faint);
}
.row .chev {
  flex: 0 0 auto; width: 14px; height: 14px;
  color: var(--faint); opacity: 0;
  transition: transform 200ms ease, opacity 160ms ease;
}
.row:hover .chev, .item.open .chev { opacity: 1; }
.item.open .chev { transform: rotate(180deg); }
.item.plain .chev { display: none; }

/* Everything a person did not ask for lives here. */
.detail {
  padding: 0 14px 13px 33px;
  font-size: 11.5px; line-height: 1.6;
  overflow-wrap: anywhere;
}
.detail .why { color: var(--soft); }
.detail .out { color: var(--soft); margin-top: 3px; }
.detail .out.moved { color: var(--moved); }
.detail .out.broke { color: var(--broke); }
.detail .out.wait { color: var(--accent); }
.detail .claim {
  margin-top: 9px; padding: 9px 12px;
  border-radius: var(--radius-xs);
  background: var(--well);
  box-shadow: inset 2px 0 0 var(--broke), inset 0 0 0 1px var(--line);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; color: var(--ink);
}
.detail .claim em { font-style: normal; color: var(--faint); }
.detail .story { margin-top: 7px; color: var(--faint); }

.nothing { padding: 26px 16px; color: var(--faint); font-size: 11.5px; line-height: 1.7; text-align: center; }
.nothing .mono { color: var(--soft); }

/* --- where the time went ------------------------------------------------- */
.timing {
  flex: 0 0 auto;
  padding: 11px var(--pad) 12px;
  border-top: 1px solid var(--line);
  background: var(--glass);
  backdrop-filter: blur(22px) saturate(150%);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
}
.tophead {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 0 0 8px;
  background: transparent; border: 0; cursor: pointer;
  text-align: left;
}
.tlabel {
  flex: 1 1 auto;
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--faint);
}
.ttotal {
  flex: 0 1 auto; min-width: 0;
  font-size: 10.5px; color: var(--faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ttotal b {
  font-weight: 500; color: var(--soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums;
}
.tophead .chev { color: var(--faint); width: 13px; height: 13px; transition: transform 200ms ease; }
.tophead[aria-expanded='true'] .chev { transform: rotate(180deg); }
.tophead:hover .tlabel, .tophead:hover .ttotal, .tophead:hover .chev { color: var(--soft); }

/* Deliberately not coloured. Where the time went is information, not state,
   and colour on this page only ever means something needs a person. */
.tbar { display: flex; gap: 1px; height: 6px; border-radius: 999px; overflow: hidden; background: var(--resting); }
.tpart { min-width: 2px; }
.tkey { list-style: none; margin: 11px 0 1px; padding: 0; }
.tkey li { display: flex; align-items: center; gap: 9px; padding: 3px 4px; font-size: 11px; color: var(--soft); }
.tkey .tswatch { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 2px; }
.tkey .tlabelled { flex: 1 1 auto; min-width: 0; }
.tkey b {
  flex: 0 0 auto; font-weight: 500; color: var(--ink); font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums;
}

/* --- follow ------------------------------------------------------------- */
.follow {
  position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%);
  z-index: 4;
  font-size: 11px;
  color: var(--ink);
  background: var(--lift);
  border: 1px solid var(--line-firm); border-radius: 999px;
  padding: 6px 15px; cursor: pointer;
  box-shadow: 0 12px 24px -14px var(--shadow);
  transition: border-color 160ms ease, color 160ms ease;
}
.follow:hover { border-color: var(--accent); color: var(--accent); }

/* --- the one thing left to do ------------------------------------------- */
.foot {
  flex: 0 0 auto;
  padding: 13px var(--pad) 15px;
  background: var(--glass);
  backdrop-filter: blur(22px) saturate(150%);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
  border-top: 1px solid var(--line);
}
.nextlabel {
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--faint);
  margin-bottom: 8px;
}
.cmd { display: flex; align-items: stretch; gap: 7px; }
.cmd code {
  flex: 1 1 auto; min-width: 0;
  display: flex; align-items: center;
  background: var(--well);
  border-radius: var(--radius-xs);
  box-shadow: inset 0 0 0 1px var(--line-firm);
  padding: 8px 11px; font-size: 11.5px;
  color: var(--ink);
  overflow-wrap: anywhere;
  user-select: all;
}
.prompt { flex: 0 0 auto; color: var(--held); opacity: 0.75; user-select: none; }
.copy {
  flex: 0 0 auto; width: 36px;
  display: flex; align-items: center; justify-content: center;
  color: var(--soft); background: transparent;
  border: 1px solid var(--line-firm); border-radius: var(--radius-xs);
  cursor: pointer;
  transition: color 160ms ease, border-color 160ms ease;
}
.copy:hover { color: var(--ink); border-color: var(--soft); }
.copy.done { color: var(--held); border-color: color-mix(in srgb, var(--held) 45%, transparent); }

/* --- one picture, made big ---------------------------------------------- */
.lightbox {
  position: fixed; inset: 0; z-index: 10;
  background: color-mix(in srgb, var(--ground) 78%, #000);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  display: flex; align-items: center; justify-content: center;
  padding: 18px; cursor: zoom-out;
}
.lightbox img {
  max-width: 100%; max-height: 100%;
  border-radius: var(--radius-sm);
  box-shadow: 0 0 0 1px var(--line-firm), 0 36px 70px -34px #000;
}

/* --- the range it has to survive ---------------------------------------- */

/* Dragged narrow. Everything stays, nothing wraps into a mess. */
@media (max-width: 330px) {
  :root { --pad: 11px; --radius: 16px; }
  .state { font-size: 15px; }
  .target .app, .target .sep { display: none; }
  .row { gap: 9px; padding: 9px 11px; }
  .detail { padding: 0 11px 12px 28px; }
  .shot { max-height: 30vh; }
  .switch button { font-size: 10px; padding: 5px 3px; }
  .ttotal { display: none; }
  .caption { display: block; }
  .shotname { display: block; white-space: normal; overflow-wrap: anywhere; }
  .shotout { display: block; text-align: left; margin-top: 2px; }
  .timing { padding: 10px var(--pad) 11px; }
}

/* Pulled wide. Two columns rather than one very long thin one, so the picture
   gets the room and the list stays beside it instead of below the fold. */
@media (min-width: 720px) {
  :root { --pad: 22px; }
  .body { flex-direction: row; gap: 26px; padding-bottom: 4px; }
  .stage { flex: 1 1 54%; min-width: 0; align-self: center; padding-top: 0; }
  .scroll { flex: 1 1 46%; min-width: 0; padding-top: 20px; }
  .shot { max-height: 58vh; }
  .state { font-size: 19px; }
  .timing { margin-top: 22px; }
}

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
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
    clock: el('clock'), project: el('project'), app: el('app'), targetsep: el('targetsep'),
    state: el('state'), note: el('note'),
    track: el('track'), fill: el('fill'), counts: el('counts'),
    stage: el('stage'), shot: el('shot'), layerA: el('layerA'), layerB: el('layerB'), blank: el('blank'),
    caption: el('caption'), shotname: el('shotname'), shotout: el('shotout'), tabs: el('tabs'),
    scroll: el('scroll'), follow: el('follow'), nothing: el('nothing'),
    groupScreens: el('groupScreens'), listScreens: el('listScreens'), countScreens: el('countScreens'),
    groupGuards: el('groupGuards'), listGuards: el('listGuards'), countGuards: el('countGuards'),
    timing: el('timing'), thead: el('thead'), ttotal: el('ttotal'), tbar: el('tbar'), tkey: el('tkey'),
    footer: el('footer'), cmd: el('cmd'), copy: el('copy'),
    aura: document.querySelector('.aura'),
    lightbox: el('lightbox'), lightimg: el('lightimg')
  };

  var CHEVRON = '<svg class="glyph chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 10.5l3.5 3.5 3.5-3.5"></path></svg>';

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

  // The whole colour vocabulary, in one place: green held, amber moved, red
  // broke, blue is waiting for a person to look, and a check nobody ran has no
  // colour at all.
  function toneOf(status) {
    switch (status) {
      case 'running': return 'running';
      case 'passed': return 'held';
      case 'changed': case 'flaky': return 'moved';
      case 'failed': case 'missing': return 'broke';
      case 'new': return 'wait';
      case 'skipped': return 'skip';
      default: return '';
    }
  }

  // A tone that means "somebody has to look at this". These are the rows that
  // open themselves; everything else waits to be asked.
  function needsPerson(tone) { return tone === 'moved' || tone === 'broke' || tone === 'wait'; }

  // The terse form, for the line beside the picture. The colour and the compare
  // control have already said most of it there.
  function outcomeShort(ev) {
    switch (ev.status) {
      case 'changed':
        var n = ev.diffPixels || 0;
        return commas(n) + ' ' + plural(n, 'pixel', 'pixels') + ' moved';
      case 'new': return 'not approved yet';
      case 'missing': return 'no approved picture';
      case 'failed': return ev.message || 'could not be photographed';
      case 'flaky': return 'changed between tries';
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
  // The list. One line per check at rest; everything else on request.
  // -------------------------------------------------------------------------

  var items = Object.create(null);
  var order = [];
  var outcomes = Object.create(null);
  var expected = { picture: 0, guard: 0 };

  function keyFor(kind, name) { return kind + ':' + name; }

  function addItem(kind, name, describe) {
    var root = document.createElement('div');
    root.className = 'item fresh pending';

    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'row';
    row.setAttribute('aria-expanded', 'false');

    var dot = document.createElement('span');
    dot.className = 'dot';
    var rname = document.createElement('span');
    rname.className = 'rname';
    rname.textContent = name;
    var rtime = document.createElement('span');
    rtime.className = 'rtime';
    row.appendChild(dot);
    row.appendChild(rname);
    row.appendChild(rtime);
    row.insertAdjacentHTML('beforeend', CHEVRON);

    var detail = document.createElement('div');
    detail.className = 'detail';
    detail.hidden = true;

    root.appendChild(row);
    root.appendChild(detail);

    var entry = {
      kind: kind, name: name, root: root, row: row, time: rtime,
      detail: detail, describe: describe || '', open: false, hasDetail: false
    };

    // One rule, so a click is never a surprise: the first click brings this
    // check forward — its picture on the glass, its detail open. The second
    // click, on the row that is already forward, folds it away again. That is
    // what makes the whole run browsable afterwards instead of only the last
    // screen photographed.
    row.addEventListener('click', function () {
      var forward = entry.pics && !entry.root.classList.contains('showing');
      if (forward) {
        recall(entry);
        setOpen(entry, true);
        return;
      }
      toggle(entry);
    });
    redraw(entry);

    (kind === 'guard' ? ui.listGuards : ui.listScreens).appendChild(root);
    (kind === 'guard' ? ui.groupGuards : ui.groupScreens).hidden = false;

    items[keyFor(kind, name)] = entry;
    order.push(entry);
    return entry;
  }

  function ensureItem(kind, name, describe) {
    var entry = items[keyFor(kind, name)];
    if (!entry) return addItem(kind, name, describe);
    if (describe && !entry.describe) { entry.describe = describe; redraw(entry); }
    return entry;
  }

  /**
   * Rebuild what is hidden under a row. Written out every time rather than
   * patched, because the same row is drawn twice at most and a rebuilt block
   * can never disagree with the event that caused it.
   */
  function redraw(entry) {
    var d = entry.detail;
    d.textContent = '';

    if (entry.describe) {
      var why = document.createElement('div');
      why.className = 'why';
      why.textContent = entry.describe;
      d.appendChild(why);
    }
    // "Still the same" is not worth a line of anybody's attention, so a check
    // that held says only what it is for.
    if (entry.outText && entry.tone !== 'held') {
      var out = document.createElement('div');
      out.className = 'out' + (entry.tone ? ' ' + entry.tone : '');
      out.textContent = entry.outText;
      d.appendChild(out);
    }
    if (entry.failedAt) {
      var claim = document.createElement('div');
      claim.className = 'claim';
      var label = document.createElement('em');
      label.textContent = 'expected ';
      claim.appendChild(label);
      claim.appendChild(document.createTextNode(entry.failedAt));
      d.appendChild(claim);
    }
    if (entry.story && entry.story !== entry.describe) {
      var story = document.createElement('div');
      story.className = 'story';
      story.textContent = 'Why this guard exists: ' + entry.story;
      d.appendChild(story);
    }

    entry.hasDetail = !!d.firstChild;
    entry.root.classList.toggle('plain', !entry.hasDetail);
    if (!entry.hasDetail) setOpen(entry, false);
  }

  /** Put a screen's pictures back in the hero, with the words that went with them. */
  function recall(entry) {
    var pics = entry.pics;
    if (!pics) return;
    var showed = false;
    if (pics.status === 'changed') showed = comparePictures(pics);
    if (!showed && pics.thumbnail) {
      singlePicture();
      showShot(pics.thumbnail, 'the picture taken of ' + entry.name);
      showed = true;
    }
    if (!showed) return;
    nameTheShot(entry.name);
    sayOutcome(entry.tone, outcomeShort(pics));
    for (var i = 0; i < order.length; i++) order[i].root.classList.remove('showing');
    entry.root.classList.add('showing');
  }

  function setOpen(entry, open) {
    entry.open = !!open && entry.hasDetail;
    entry.detail.hidden = !entry.open;
    entry.root.classList.toggle('open', entry.open);
    entry.row.setAttribute('aria-expanded', entry.open ? 'true' : 'false');
  }

  function toggle(entry) {
    if (!entry.hasDetail) return;
    setOpen(entry, !entry.open);
  }

  function setTone(entry, tone) {
    entry.tone = tone;
    var classes = ['item'];
    if (tone) classes.push(tone);
    if (!tone) classes.push('pending');
    if (needsPerson(tone)) classes.push('attention');
    if (entry.open) classes.push('open');
    if (!entry.hasDetail) classes.push('plain');
    if (entry.root.classList.contains('showing')) classes.push('showing');
    entry.root.className = classes.join(' ');
    entry.root.style.setProperty('--tone', tone ? 'var(--' + tone + ')' : 'var(--accent)');
    paintMeter();
  }

  // -------------------------------------------------------------------------
  // The meter: one hairline, sliced by outcome.
  // -------------------------------------------------------------------------

  function meterTotal() {
    var planned = (expected.picture || 0) + (expected.guard || 0);
    return Math.max(order.length, planned, 1);
  }

  function paintMeter() {
    var total = meterTotal();
    var width = (100 / total) + '%';
    var slices = ui.fill.children;
    // One slice per known check, in order. The rest of the track stays empty,
    // which is what tells you how much is still to come.
    while (slices.length > order.length) ui.fill.removeChild(ui.fill.lastChild);
    while (slices.length < order.length) {
      var span = document.createElement('span');
      span.className = 'slice';
      ui.fill.appendChild(span);
    }
    for (var i = 0; i < order.length; i++) {
      var tone = order[i].tone || '';
      slices[i].className = 'slice' + (tone ? ' ' + tone : '');
      slices[i].style.width = width;
    }
  }

  function updateCounts() {
    var done = 0;
    for (var i = 0; i < order.length; i++) {
      if (outcomes[keyFor(order[i].kind, order[i].name)]) done++;
    }
    var total = meterTotal();
    // Say what happened, not just how far along it is. "11/11" tells a person the
    // run finished and nothing else; they still have to read the whole list to find
    // out whether they can walk away. The tally answers that in four words.
    var tally = { changed: 0, failed: 0, waiting: 0, skipped: 0 };
    for (var t = 0; t < order.length; t++) {
      var st = outcomes[keyFor(order[t].kind, order[t].name)];
      if (st === 'changed') tally.changed++;
      else if (st === 'failed' || st === 'missing') tally.failed++;
      else if (st === 'new') tally.waiting++;
      else if (st === 'skipped') tally.skipped++;
    }
    var parts = [];
    if (tally.failed) parts.push(commas(tally.failed) + ' broke');
    if (tally.changed) parts.push(commas(tally.changed) + ' moved');
    if (tally.waiting) parts.push(commas(tally.waiting) + ' needs you');
    if (tally.skipped) parts.push(commas(tally.skipped) + ' skipped');
    var counted = commas(done) + ' of ' + commas(total);
    if (done === total && total > 0 && parts.length === 0) counted += ' — all held';
    ui.counts.textContent = order.length ? counted + (parts.length ? ' · ' + parts.join(' · ') : '') : '';
    ui.countScreens.textContent = countIn('picture');
    ui.countGuards.textContent = countIn('guard');
    ui.nothing.hidden = order.length > 0;
    paintMeter();
  }

  function countIn(kind) {
    var n = 0;
    for (var i = 0; i < order.length; i++) if (order[i].kind === kind) n++;
    return n ? String(n) : '';
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
  ['wheel', 'touchmove', 'keydown'].forEach(function (name) {
    ui.scroll.addEventListener(name, stopFollowing, { passive: true });
  });
  ui.follow.addEventListener('click', function () {
    following = true;
    ui.follow.hidden = true;
    if (runningItem) runningItem.root.scrollIntoView({ block: 'nearest' });
  });

  /** Which row the picture on the glass belongs to. */
  function markShowing(entry) {
    for (var i = 0; i < order.length; i++) order[i].root.classList.remove('showing');
    if (entry) entry.root.classList.add('showing');
  }

  var runningItem = null;
  function markRunning(entry) {
    runningItem = entry;
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
    ui.blank.hidden = true;
    ui.shot.classList.remove('empty');
    var next = frontIsA ? ui.layerB : ui.layerA;
    var current = frontIsA ? ui.layerA : ui.layerB;
    next.src = src;
    next.alt = shownAlt;
    next.classList.add('on');
    current.classList.remove('on');
    frontIsA = !frontIsA;
  }

  function nameTheShot(name) {
    ui.shotname.textContent = name || '';
  }

  // The light behind everything takes the colour of the worst thing that has
  // happened so far. It is the one piece of the panel a person reads without
  // looking at it.
  function tint(tone) {
    var value = tone && tone !== 'held' && tone !== 'skip' ? 'var(--' + tone + ')' : 'var(--accent)';
    document.documentElement.style.setProperty('--tint', value);
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
   * The line beside the picture's name. Silent when a screen simply held,
   * because a panel that congratulates you on every screen is a panel you stop
   * reading.
   */
  function sayOutcome(tone, text) {
    if (!text || !tone || tone === 'held' || tone === 'skip') {
      ui.shotout.hidden = true;
      return;
    }
    ui.shotout.textContent = text;
    ui.shotout.className = 'shotout ' + tone;
    ui.shotout.hidden = false;
  }

  // A screen that moved is the one moment a person has a real decision to make,
  // so all three pictures are one click away and the difference is the one
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
        buttons[i].className = i === index ? 'on' : '';
        buttons[i].setAttribute('aria-pressed', i === index ? 'true' : 'false');
      }
      showShot(choices[index].src, choices[index].label.toLowerCase() + ' picture of ' + (ev.name || 'this screen'));
    }
    choices.forEach(function (choice, index) {
      var button = document.createElement('button');
      button.type = 'button';
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
  ui.shot.addEventListener('click', function () { enlarge(shownSrc, shownAlt); });
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
  // Where the time went. Folded shut, because it is a thing you go and look at
  // once in a while rather than something you need on screen all day.
  // -------------------------------------------------------------------------

  var TIMING_PARTS = [
    ['launch', 'opening the app'],
    ['steps', 'clicking through the app'],
    ['prepare', 'waiting for fonts and pictures'],
    ['settle', 'waiting for the screen to hold still'],
    ['compare', 'comparing the pictures'],
    ['guards', 'running the guards'],
    ['other', 'everything else']
  ];

  // Shades of the text colour, darkest first. Not a palette — a ramp, so the
  // breakdown reads as one object and never competes with the four colours
  // that actually mean something.
  function shade(index, count) {
    var top = 46;
    var bottom = 11;
    var step = count > 1 ? (top - bottom) / (count - 1) : 0;
    return 'color-mix(in srgb, var(--ink) ' + (top - step * index).toFixed(1) + '%, transparent)';
  }

  var timingOpen = false;
  ui.thead.addEventListener('click', function () {
    timingOpen = !timingOpen;
    ui.tkey.hidden = !timingOpen;
    ui.thead.setAttribute('aria-expanded', timingOpen ? 'true' : 'false');
  });

  function showTiming(timings) {
    if (!timings || typeof timings !== 'object') return;
    var parts = [];
    var sum = 0;
    TIMING_PARTS.forEach(function (part) {
      var ms = Number(timings[part[0]]);
      if (!isFinite(ms) || ms <= 0) return;
      sum += ms;
      parts.push({ label: part[1], ms: ms });
    });
    if (!parts.length || sum <= 0) return;

    // Biggest first: the answer to "where did the time go" is the first row.
    parts.sort(function (a, b) { return b.ms - a.ms; });

    ui.tbar.textContent = '';
    ui.tkey.textContent = '';
    parts.forEach(function (part, index) {
      var colour = shade(index, parts.length);

      var bar = document.createElement('span');
      bar.className = 'tpart';
      bar.style.flex = String(part.ms / sum) + ' 1 0';
      bar.style.background = colour;
      bar.title = part.label + ' — ' + fmt(part.ms);
      ui.tbar.appendChild(bar);

      var item = document.createElement('li');
      var swatch = document.createElement('span');
      swatch.className = 'tswatch';
      swatch.style.background = colour;
      var text = document.createElement('span');
      text.className = 'tlabelled';
      text.textContent = part.label;
      var value = document.createElement('b');
      value.textContent = fmt(part.ms);
      item.appendChild(swatch);
      item.appendChild(text);
      item.appendChild(value);
      ui.tkey.appendChild(item);
    });
    ui.ttotal.textContent = '';
    var most = document.createElement('b');
    most.textContent = fmt(parts[0].ms);
    ui.ttotal.appendChild(most);
    ui.ttotal.appendChild(document.createTextNode(' ' + parts[0].label));
    ui.timing.hidden = false;
  }

  // -------------------------------------------------------------------------
  // What to do next
  // -------------------------------------------------------------------------

  function showNextStep(summary) {
    var pictures = (summary && summary.pictures) || [];
    var waiting = pictures.filter(function (p) {
      return p && (p.status === 'changed' || p.status === 'new' || p.status === 'missing');
    });
    // The verdict is already the biggest sentence on the page. The footer only
    // ever exists when there is something for a person to actually type.
    if (!waiting.length) { ui.footer.hidden = true; return; }
    ui.cmd.textContent = waiting.length === 1
      ? 'staysfixed approve ' + waiting[0].name
      : 'staysfixed approve --all';
    ui.footer.hidden = false;
  }

  ui.copy.addEventListener('click', function () {
    var text = ui.cmd.textContent || '';
    // A page opened from a file is not a secure context, so the modern
    // clipboard is usually refused here. The old way still works.
    var box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    try {
      document.execCommand('copy');
      ui.copy.classList.add('done');
      setTimeout(function () { ui.copy.classList.remove('done'); }, 1300);
    } catch (err) { /* nothing to do */ }
    document.body.removeChild(box);
  });

  // -------------------------------------------------------------------------
  // The sentence at the top
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
      if (planned.app) {
        ui.app.textContent = planned.app;
        ui.app.hidden = false;
        ui.targetsep.hidden = false;
      }
      // A caller who counted instead of listing still gets a truthful meter.
      if (typeof planned.screens === 'number') expected.picture = planned.screens;
      if (typeof planned.guards === 'number') expected.guard = planned.guards;
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
      if (typeof ev.total === 'number' && ev.total > expected.picture) expected.picture = ev.total;
      if (!announcedScreens) {
        announcedScreens = true;
        var screens = ev.total || expected.picture || countOf(plan.screens);
        setState(screens ? 'photographing ' + commas(screens) + ' ' + plural(screens, 'screen', 'screens') : 'photographing the screens');
      }
      // The picture is deliberately left alone here. Nothing has been
      // photographed yet, so renaming the frame now would put this screen's
      // name under the last screen's picture — a caption that lies for a
      // second is worse than one that is a second behind.
      markRunning(ensureItem('picture', String(ev.name || ''), ev.describe));
      return;
    }

    if (type === 'screen:shot') {
      var shotRow = ev.name ? ensureItem('picture', String(ev.name), ev.describe) : null;
      if (ev.thumbnail) {
        lastShot = ev.thumbnail;
        if (shotRow) shotRow.pics = { name: ev.name, status: '', thumbnail: ev.thumbnail };
        singlePicture();
        showShot(ev.thumbnail, 'the picture just taken of ' + (ev.name || 'this screen'));
      }
      if (ev.name) nameTheShot(ev.name);
      markShowing(shotRow);
      return;
    }

    if (type === 'screen:done') {
      var done = ensureItem('picture', String(ev.name || ''), ev.describe);
      var tone = finish(done, 'picture', ev);
      if (ev.thumbnail) lastShot = ev.thumbnail;
      // The name, the caption and the light behind the glass all move together
      // with the picture, or none of them move. A screen that could not be
      // photographed leaves the last real one up, correctly labelled, rather
      // than putting its own name under someone else's picture.
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
        markShowing(done);
        nameTheShot(ev.name);
        // Anything but "still the same" is said beside the picture as well as
        // in the list, because the picture is where the person is looking and
        // that line is what tells them there is something to decide.
        sayOutcome(tone, outcomeShort(ev));
      }
      tint(worstTone());
      return;
    }

    if (type === 'guard:start') {
      if (typeof ev.total === 'number' && ev.total > expected.guard) expected.guard = ev.total;
      if (!announcedGuards) {
        announcedGuards = true;
        var guards = ev.total || expected.guard || countOf(plan.guards);
        setState(guards ? 'running ' + commas(guards) + ' ' + plural(guards, 'guard', 'guards') : 'running the guards');
      }
      markRunning(ensureItem('guard', String(ev.name || ''), ev.describe));
      return;
    }

    if (type === 'guard:done') {
      finish(ensureItem('guard', String(ev.name || ''), ev.describe), 'guard', ev);
      tint(worstTone());
      return;
    }

    if (type === 'run:done') {
      runningItem = null;
      ui.follow.hidden = true;
      var summary = ev.summary || null;
      stopClock(typeof ev.at === 'number' ? ev.at : (summary && summary.durationMs));
      var verdict = ev.verdict || fallbackVerdict();
      var worst = worstTone();
      setState(verdict, worst);
      tint(worst);
      showTiming(ev.timings || (summary && summary.timings));
      showNextStep(summary);
      updateCounts();
      if (following) {
        requestAnimationFrame(function () {
          var first = null;
          for (var i = 0; i < order.length && !first; i++) {
            if (needsPerson(order[i].tone)) first = order[i];
          }
          if (first) first.root.scrollIntoView({ block: 'center' });
          else ui.scroll.scrollTop = 0;
        });
      }
      return;
    }
    // Anything else is something a newer version of Stays Fixed knows about
    // and this page does not. Ignoring it is the only safe thing to do.
  }

  function finish(entry, kind, ev) {
    var tone = toneOf(ev.status);
    if (kind === 'picture') {
      entry.pics = {
        name: ev.name, status: ev.status,
        thumbnail: ev.thumbnail || (entry.pics && entry.pics.thumbnail) || '',
        approvedThumb: ev.approvedThumb || '',
        diffThumb: ev.diffThumb || '',
        diffPixels: ev.diffPixels, message: ev.message
      };
      if (!entry.pics.thumbnail && !entry.pics.approvedThumb && !entry.pics.diffThumb) entry.pics = null;
    }
    entry.outText = outcomeText(kind, ev);
    entry.failedAt = (kind === 'guard' && ev.status === 'failed' && ev.failedAt) ? ev.failedAt : '';
    entry.story = (kind === 'guard' && ev.status === 'failed' && ev.because) ? ev.because : '';
    if (typeof ev.durationMs === 'number') entry.time.textContent = fmt(ev.durationMs);
    entry.tone = tone;
    redraw(entry);
    setTone(entry, tone);
    // Only the checks that want a person open themselves. Everything else stays
    // one line, which is what keeps a clean run quiet.
    if (needsPerson(tone)) setOpen(entry, true);
    outcomes[keyFor(entry.kind, entry.name)] = tone || 'held';
    updateCounts();
    return tone;
  }

  // The worst thing that happened, as a colour. Red beats amber beats blue
  // beats green, because a person should see the most serious state first.
  function worstTone() {
    var rank = { broke: 4, moved: 3, wait: 2, held: 1, skip: 0 };
    var worst = 'held';
    for (var key in outcomes) {
      var tone = outcomes[key];
      if ((rank[tone] || 0) > (rank[worst] || 0)) worst = tone;
    }
    return worst === 'skip' ? '' : worst;
  }

  // Only used when a run finishes without the verdict the terminal printed —
  // an older run, or one that stopped early. It deliberately does not try to
  // reproduce those sentences; src/report/console.js owns them.
  function fallbackVerdict() {
    var total = order.length;
    var bad = 0;
    for (var key in outcomes) {
      if (outcomes[key] === 'broke' || outcomes[key] === 'moved' || outcomes[key] === 'wait') bad++;
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
    runningItem = null;
  };

  // Draw the plan before anything has happened, so the window is worth looking
  // at from the first frame instead of appearing empty.
  (function seed() {
    var i;
    for (i = 0; i < (plan.screens || []).length; i++) {
      addItem('picture', plan.screens[i].name, plan.screens[i].describe);
    }
    for (i = 0; i < (plan.guards || []).length; i++) {
      addItem('guard', plan.guards[i].name, plan.guards[i].describe);
    }
    updateCounts();
    if (!order.length) ui.shot.classList.add('empty');
    // Guards only: there will never be a picture, so the panel does not hold a
    // screen's worth of empty glass open waiting for one.
    if (!(plan.screens || []).length && (plan.guards || []).length) ui.stage.hidden = true;
  })();
})();
`;
