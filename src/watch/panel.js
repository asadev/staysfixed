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
 * it has not earned. That gives four rules the whole layout follows.
 *
 *   1. The picture is the hero, and it is a REAL picture. The panel is itself a
 *      local page, so it loads the full-resolution PNG straight off the disk the
 *      run just wrote it to — `shotFile`, `approvedFile`, `diffFile`. The small
 *      preview that travels inside the event is only the frame or two before
 *      that file exists. A watch panel that shows you a blurred stamp of your
 *      own app is worse than useless: looking at the picture IS the product, so
 *      it has to survive being looked at closely.
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
 *
 *   4. Everything moves, and nothing waves. State never snaps: pictures cross
 *      fade, rows settle, numbers count, the verdict arrives. Every one of those
 *      is between 150 and 320 milliseconds on one easing curve, every one of
 *      them is tied to something that really happened, and every one of them is
 *      switched off for anyone who has asked their computer for less motion.
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

/** A cross: put the big picture away. */
const CLOSE = [
  '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor"',
  ' stroke-width="1.7" stroke-linecap="round" aria-hidden="true">',
  '<path d="M7 7l10 10M17 7L7 17"></path>',
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
    '<span class="sweep" aria-hidden="true"></span>',
    '<p class="blank" id="blank">The first picture appears the moment it is taken.</p>',
    '<span class="closer" aria-hidden="true">click to look closer</span>',
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

    // --- the viewer: the real picture, as big as the window goes ------------
    //
    // This is where a person decides whether to approve something, so it is the
    // most carefully built thing on the page: the full-resolution file, zoom to
    // eight times with the actual pixels showing rather than a smoothed guess,
    // drag to move around, and — for a screen that moved — the approved picture
    // and the new one under one draggable line, plus the difference.
    '<div class="viewer" id="viewer" hidden>',
    '<header class="vtop">',
    '<span class="vname mono" id="vname"></span>',
    '<div class="vmodes" id="vmodes"></div>',
    '<span class="vright">',
    '<span class="vzoom mono" id="vzoom" title="double-click the picture to fit it again">1.0&#215;</span>',
    `<button class="vclose" id="vclose" type="button" aria-label="close the picture">${CLOSE}</button>`,
    '</span>',
    '</header>',
    '<div class="vstage" id="vstage">',
    '<div class="vframe" id="vframe">',
    '<img class="vlayer" id="vApproved" alt="the approved picture">',
    '<img class="vlayer" id="vNow" alt="the picture just taken">',
    '<img class="vlayer" id="vDiff" alt="the difference between them">',
    '</div>',
    '<div class="vwipe" id="vwipe" hidden><span class="vgrip" aria-hidden="true"></span></div>',
    '</div>',
    '<footer class="vfoot" id="vfoot" hidden>',
    '<span class="vside">approved</span>',
    '<input class="vblend" id="vblend" type="range" min="0" max="100" value="100" aria-label="fade between the approved picture and the new one">',
    '<span class="vside">now</span>',
    '</footer>',
    '<p class="vhelp">scroll to zoom &#183; drag to move &#183; double-click to fit &#183; esc to close</p>',
    '</div>',

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

   One type scale, five steps, used everywhere. One easing curve, used by every
   moving thing on the page, so the whole panel moves like one object.

   Dark is the design — this window lives beside an editor all day. Light is a
   warm paper, never the white page with grey cards the brief rules out.
   -------------------------------------------------------------------------- */
:root {
  color-scheme: dark;

  --ground: #0a0c12;
  --lift: #12161f;
  --card: rgba(255, 255, 255, 0.03);
  --card-hover: rgba(255, 255, 255, 0.055);
  --well: #070910;
  --glass: rgba(10, 12, 18, 0.74);

  --ink: #e7eaf2;
  --soft: #939bad;
  --faint: #616a7d;

  --line: rgba(255, 255, 255, 0.06);
  --line-firm: rgba(255, 255, 255, 0.13);
  --sheen: rgba(255, 255, 255, 0.06);
  --shadow: rgba(0, 0, 0, 0.66);

  --accent: #6f9dff;
  --held: #55bd8c;
  --moved: #e2a84f;
  --broke: #ef6a61;
  --resting: rgba(255, 255, 255, 0.08);

  --radius: 20px;
  --radius-sm: 13px;
  --radius-xs: 9px;

  --pad: 18px;
  --tint: var(--accent);

  /* The type scale. Nothing on this page is set at a size that is not here. */
  --t-label: 10px;
  --t-meta: 10.5px;
  --t-body: 11.5px;
  --t-name: 12px;
  --t-lead: 17px;

  /* One curve. Everything that moves, moves on this. */
  --ease: cubic-bezier(0.22, 0.72, 0.24, 1);
  --quick: 170ms;
  --calm: 260ms;
  --slow: 320ms;
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
  --card: rgba(255, 255, 255, 0.78);
  --card-hover: rgba(255, 255, 255, 1);
  --well: #dad4c8;
  --glass: rgba(231, 226, 217, 0.82);

  --ink: #1c1a16;
  --soft: #6b665c;
  --faint: #8b8578;

  --line: rgba(28, 24, 18, 0.09);
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
  transition: background 620ms var(--ease);
}

.panel {
  position: relative; z-index: 1;
  display: flex; flex-direction: column;
  height: 100%;
}

/* --- header -------------------------------------------------------------- */
.top {
  flex: 0 0 auto;
  padding: 16px var(--pad) 15px;
  background: var(--glass);
  backdrop-filter: blur(22px) saturate(150%);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
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
  font-size: var(--t-label); font-weight: 600;
  letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--soft);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.elapsed { flex: 0 0 auto; font-size: var(--t-body); color: var(--faint); }

.target {
  display: flex; align-items: baseline; gap: 6px;
  margin-top: 13px;
  font-size: var(--t-name);
  white-space: nowrap; overflow: hidden;
}
.target .mono { color: var(--ink); flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
.target .sep { color: var(--faint); flex: 0 0 auto; }
.target .app { color: var(--faint); flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; font-size: var(--t-body); }

/* The sentence. The largest text on the page after the picture, because it is
   the one thing a person reads from four feet away. */
.state {
  margin-top: 9px;
  font-size: var(--t-lead); font-weight: 620; line-height: 1.32;
  letter-spacing: -0.011em;
  overflow-wrap: anywhere;
  transition: color var(--slow) var(--ease);
}
.state.held { color: var(--ink); }
.state.moved { color: var(--moved); }
.state.broke { color: var(--broke); }
.state.wait { color: var(--accent); }
/* The verdict arrives rather than appearing: it is the one sentence the whole
   run was for, and a run that ends by swapping a word looks like a page that
   was not paying attention. */
.state.arrive { animation: arrive 340ms var(--ease) both; }
@keyframes arrive {
  from { opacity: 0; transform: translateY(7px); filter: blur(4px); }
  to { opacity: 1; transform: none; filter: blur(0); }
}
.note { margin-top: 5px; font-size: var(--t-body); color: var(--faint); overflow-wrap: anywhere; }

/* One hairline, not a row of blocks. Each finished check adds its own slice of
   colour to a single continuous line, so progress and outcome are the same
   object and there is one fewer thing on the page. */
.meter { display: flex; align-items: center; gap: 10px; margin-top: 15px; }
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
  transition: background var(--slow) var(--ease), flex-basis var(--slow) var(--ease);
}
.slice.held { background: var(--held); }
.slice.moved { background: var(--moved); }
.slice.broke { background: var(--broke); }
.slice.wait { background: var(--accent); }
.slice.skip { background: color-mix(in srgb, var(--ink) 16%, transparent); }
.slice.running {
  background: var(--accent);
  animation: breathe 1.9s var(--ease) infinite;
}
/* A segment lights as it lands, once, and then it is just a colour. */
.slice.land { animation: land 520ms var(--ease) 1; }
@keyframes land { 0% { filter: brightness(2.1); } 100% { filter: none; } }
@keyframes breathe { 0%, 100% { opacity: 0.42; } 50% { opacity: 1; } }
.counts {
  flex: 0 1 auto; min-width: 0; max-width: 66%;
  font-size: var(--t-meta); color: var(--faint); letter-spacing: 0.02em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

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
    0 0 0 1px var(--line),
    0 26px 50px -30px var(--shadow);
  transition: box-shadow var(--slow) var(--ease);
}
.shot.empty { cursor: default; }
.layer {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  object-fit: contain;
  opacity: 0;
  transform: scale(1.014);
  transition: opacity var(--slow) var(--ease), transform 480ms var(--ease);
}
.layer.on { opacity: 1; transform: none; }
.layer.out { opacity: 0; transform: scale(0.996); }
.blank {
  position: relative;
  color: var(--faint); font-size: var(--t-body); line-height: 1.6;
  text-align: center; padding: 0 30px; max-width: 260px;
}

/* The shutter, made visible. One pass of soft light across the glass for
   exactly as long as the app is really being photographed — it starts when the
   screen starts and it is gone the instant the picture lands, so it is a report
   of what is happening rather than a decoration that never stops. */
.sweep {
  position: absolute; inset: 0;
  pointer-events: none; opacity: 0;
  background:
    linear-gradient(100deg,
      transparent 4%,
      color-mix(in srgb, var(--accent) 10%, transparent) 30%,
      color-mix(in srgb, var(--accent) 34%, transparent) 47%,
      color-mix(in srgb, var(--accent) 82%, transparent) 50%,
      color-mix(in srgb, var(--accent) 34%, transparent) 53%,
      color-mix(in srgb, var(--accent) 10%, transparent) 70%,
      transparent 96%);
  transform: translateX(-100%);
}
.shot.scanning .sweep { opacity: 1; animation: sweep 1.6s var(--ease) infinite; }
.shot.scanning {
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent),
    0 26px 50px -30px var(--shadow);
}
@keyframes sweep {
  from { transform: translateX(-100%); }
  to { transform: translateX(100%); }
}

/* Said once, on hover, and never in the way of the picture. */
.closer {
  position: absolute; right: 10px; bottom: 10px;
  font-size: var(--t-label); letter-spacing: 0.02em;
  color: var(--ink);
  background: color-mix(in srgb, var(--ground) 72%, transparent);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  border-radius: 999px; padding: 4px 10px;
  opacity: 0; transform: translateY(4px);
  transition: opacity var(--quick) var(--ease), transform var(--quick) var(--ease);
  pointer-events: none;
}
.shot:hover .closer { opacity: 1; transform: none; }
.shot.empty .closer { display: none; }

.caption {
  display: flex; align-items: baseline; gap: 10px;
  margin-top: 12px; min-height: 18px;
}
.shotname { flex: 0 1 auto; font-size: var(--t-name); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shotout { flex: 1 1 auto; min-width: 0; font-size: var(--t-body); color: var(--soft); text-align: right; overflow-wrap: anywhere; }
.shotout.moved { color: var(--moved); }
.shotout.broke { color: var(--broke); }
.shotout.wait { color: var(--accent); }

/* Approved / now / difference. Three quiet words with a line that slides
   between them — no pill, no box, because a screen that moved already has
   enough asking for the eye. */
.switch { display: flex; gap: 2px; margin-top: 10px; }
.switch button {
  position: relative;
  flex: 1 1 0; min-width: 0;
  font-size: var(--t-body); letter-spacing: 0.01em;
  color: var(--faint);
  background: transparent; border: 0;
  padding: 6px 4px 7px; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: color var(--quick) var(--ease);
}
.switch button::after {
  content: ''; position: absolute; left: 50%; right: 50%; bottom: 0; height: 1.5px;
  border-radius: 2px; background: var(--tone, var(--accent));
  transition: left var(--calm) var(--ease), right var(--calm) var(--ease), opacity var(--quick) var(--ease);
  opacity: 0;
}
.switch button:hover { color: var(--soft); }
.switch button.on { color: var(--ink); }
.switch button.on::after { left: 12%; right: 12%; opacity: 1; }

/* --- the list ------------------------------------------------------------ */
.scroll {
  flex: 1 1 auto; min-height: 70px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--soft) 22%, transparent) transparent;
  padding: 18px 5px 14px 0;
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

.group + .group { margin-top: 20px; }
.grouplabel {
  display: flex; align-items: baseline; gap: 9px;
  padding: 0 6px 9px 4px;
  font-size: var(--t-label); font-weight: 600;
  letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--faint);
}
.grouplabel .mono { font-size: var(--t-label); letter-spacing: 0.04em; color: color-mix(in srgb, var(--faint) 70%, transparent); }

.items {
  border-radius: var(--radius);
  background: var(--card);
  overflow: hidden;
}
.item + .item { box-shadow: inset 0 1px 0 var(--line); }
.item {
  transition: background var(--calm) var(--ease);
}
.item.attention { background: color-mix(in srgb, var(--tone, var(--accent)) 5%, transparent); }
.item.running { background: color-mix(in srgb, var(--accent) 5%, transparent); }
/* Something broke. It is said once, with weight, and then it sits still — a
   panel that keeps flashing beside your work is a panel you turn off. */
.item.alarm { animation: alarm 900ms var(--ease) 1; }
@keyframes alarm {
  0% { background: color-mix(in srgb, var(--tone, var(--broke)) 26%, transparent); }
  100% { background: color-mix(in srgb, var(--tone, var(--broke)) 5%, transparent); }
}

/* Big, quiet, touch-sized rows. At rest a check is a dot, a name and a time —
   that is the whole of it. */
.row {
  display: flex; align-items: center; gap: 11px;
  width: 100%; min-height: 44px;
  padding: 10px 14px;
  text-align: left;
  background: transparent; border: 0;
  cursor: pointer;
  transition: background var(--quick) var(--ease);
}
.row:hover { background: var(--card-hover); }
.row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.item.plain .row { cursor: default; }
.item.showing .row { box-shadow: inset 2px 0 0 var(--line-firm); }
.item.showing .rname { color: var(--ink); }
.item.plain .row:hover { background: transparent; }
/* Rows settle in rather than appearing, and they do it one after another, which
   is what makes a list of eleven screens read as one thing arriving. */
.item.fresh { animation: settle 300ms var(--ease) both; }
@keyframes settle {
  from { opacity: 0; transform: translateY(7px); }
  to { opacity: 1; transform: none; }
}

.dot {
  flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%;
  background: var(--resting);
  transition: background var(--calm) var(--ease), box-shadow var(--calm) var(--ease);
}
.item.held .dot { background: color-mix(in srgb, var(--held) 78%, transparent); }
.item.moved .dot { background: var(--moved); box-shadow: 0 0 0 4px color-mix(in srgb, var(--moved) 15%, transparent); }
.item.broke .dot { background: var(--broke); box-shadow: 0 0 0 4px color-mix(in srgb, var(--broke) 15%, transparent); }
.item.wait .dot { background: var(--accent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 15%, transparent); }
.item.skip .dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--resting); }
.item.running .dot {
  background: transparent;
  box-shadow: inset 0 0 0 2px var(--accent);
  animation: ping 1.8s var(--ease) infinite;
}
@keyframes ping {
  0% { box-shadow: inset 0 0 0 2px var(--accent), 0 0 0 0 color-mix(in srgb, var(--accent) 42%, transparent); }
  70%, 100% { box-shadow: inset 0 0 0 2px var(--accent), 0 0 0 7px color-mix(in srgb, var(--accent) 0%, transparent); }
}
.item.running .rname { color: var(--ink); }

.rname {
  flex: 1 1 auto; min-width: 0;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: var(--t-name); color: var(--ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.item.pending .rname, .item.skip .rname { color: var(--faint); }
.rtime {
  flex: 0 0 auto;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: var(--t-meta); color: var(--faint);
}
.row .chev {
  flex: 0 0 auto; width: 14px; height: 14px;
  color: var(--faint); opacity: 0;
  transition: transform var(--calm) var(--ease), opacity var(--quick) var(--ease);
}
.row:hover .chev, .item.open .chev { opacity: 1; }
.item.open .chev { transform: rotate(180deg); }
.item.plain .chev { display: none; }

/* Everything a person did not ask for lives here. */
.detail {
  padding: 0 14px 13px 33px;
  font-size: var(--t-body); line-height: 1.6;
  overflow-wrap: anywhere;
}
.item.open .detail { animation: unfold 240ms var(--ease) both; }
@keyframes unfold { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.detail .why { color: var(--soft); }
.detail .out { color: var(--soft); margin-top: 3px; }
.detail .out.moved { color: var(--moved); }
.detail .out.broke { color: var(--broke); }
.detail .out.wait { color: var(--accent); }
.detail .claim {
  margin-top: 9px; padding: 9px 12px;
  border-radius: var(--radius-xs);
  background: var(--well);
  box-shadow: inset 2px 0 0 var(--broke);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--t-body); color: var(--ink);
}
.detail .claim em { font-style: normal; color: var(--faint); }
.detail .story { margin-top: 7px; color: var(--faint); }

.nothing { padding: 26px 16px; color: var(--faint); font-size: var(--t-body); line-height: 1.7; text-align: center; }
.nothing .mono { color: var(--soft); }

/* --- where the time went ------------------------------------------------- */
.timing {
  flex: 0 0 auto;
  padding: 12px var(--pad) 13px;
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
  font-size: var(--t-label); font-weight: 600;
  letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--faint);
}
.ttotal {
  flex: 0 1 auto; min-width: 0;
  font-size: var(--t-meta); color: var(--faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ttotal b {
  font-weight: 500; color: var(--soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums;
}
.tophead .chev { color: var(--faint); width: 13px; height: 13px; transition: transform var(--calm) var(--ease); }
.tophead[aria-expanded='true'] .chev { transform: rotate(180deg); }
.tophead:hover .tlabel, .tophead:hover .ttotal, .tophead:hover .chev { color: var(--soft); }

/* Deliberately not coloured. Where the time went is information, not state,
   and colour on this page only ever means something needs a person. */
.tbar { display: flex; gap: 1px; height: 6px; border-radius: 999px; overflow: hidden; background: var(--resting); }
.tpart { min-width: 2px; transition: flex-grow var(--slow) var(--ease); }
.tkey { list-style: none; margin: 12px 0 1px; padding: 0; }
.tkey li { display: flex; align-items: center; gap: 9px; padding: 3px 4px; font-size: var(--t-body); color: var(--soft); }
.tkey .tswatch { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 2px; }
.tkey .tlabelled { flex: 1 1 auto; min-width: 0; }
.tkey b {
  flex: 0 0 auto; font-weight: 500; color: var(--ink); font-size: var(--t-body);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums;
}

/* --- follow ------------------------------------------------------------- */
.follow {
  position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%);
  z-index: 4;
  font-size: var(--t-body);
  color: var(--ink);
  background: var(--lift);
  border: 1px solid var(--line-firm); border-radius: 999px;
  padding: 6px 15px; cursor: pointer;
  box-shadow: 0 12px 24px -14px var(--shadow);
  animation: settle 240ms var(--ease) both;
  transition: border-color var(--quick) var(--ease), color var(--quick) var(--ease);
}
.follow:hover { border-color: var(--accent); color: var(--accent); }

/* --- the one thing left to do ------------------------------------------- */
.foot {
  flex: 0 0 auto;
  padding: 14px var(--pad) 16px;
  background: var(--glass);
  backdrop-filter: blur(22px) saturate(150%);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
  border-top: 1px solid var(--line);
  animation: arrive 340ms var(--ease) both;
}
.nextlabel {
  font-size: var(--t-label); font-weight: 600;
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
  padding: 9px 11px; font-size: var(--t-body);
  color: var(--ink);
  overflow-wrap: anywhere;
  user-select: all;
}
.prompt { flex: 0 0 auto; color: var(--held); opacity: 0.75; user-select: none; }
.copy {
  flex: 0 0 auto; width: 36px;
  display: flex; align-items: center; justify-content: center;
  color: var(--soft); background: var(--well);
  border: 0; border-radius: var(--radius-xs);
  cursor: pointer;
  transition: color var(--quick) var(--ease), background var(--quick) var(--ease);
}
.copy:hover { color: var(--ink); background: var(--card-hover); }
.copy.done { color: var(--held); }

/* --------------------------------------------------------------------------
   The viewer.

   The one screen a person uses to decide whether to approve something, so it
   gets the whole window, the real file at its real resolution, and — when a
   screen moved — the approved picture and the new one under a line you drag.
   Past about two times, the smoothing comes off: somebody zooming in is asking
   to see the actual pixels, not a guess at what is between them.
   -------------------------------------------------------------------------- */
.viewer {
  position: fixed; inset: 0; z-index: 20;
  display: flex; flex-direction: column;
  background: color-mix(in srgb, var(--ground) 92%, #000);
  animation: viewerin 220ms var(--ease) both;
}
@keyframes viewerin { from { opacity: 0; } to { opacity: 1; } }

.vtop {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 10px;
  padding: 11px 12px 11px var(--pad);
}
/* Three parts, and the outer two share what is left over, so the words stay in
   the middle and the way out stays hard right whether there are four pictures
   to choose between or one. */
.vname {
  flex: 1 1 0; min-width: 0;
  font-size: var(--t-name); color: var(--ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.vmodes {
  flex: 0 1 auto; min-width: 0;
  display: flex; justify-content: center; gap: 3px;
  overflow-x: auto; scrollbar-width: none;
}
.vmodes::-webkit-scrollbar { display: none; }
.vright { flex: 1 1 0; display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.vmodes button {
  position: relative;
  font-size: var(--t-body); color: var(--faint);
  background: transparent; border: 0; cursor: pointer;
  padding: 5px 9px 6px; white-space: nowrap;
  transition: color var(--quick) var(--ease);
}
.vmodes button::after {
  content: ''; position: absolute; left: 50%; right: 50%; bottom: 1px; height: 1.5px;
  border-radius: 2px; background: var(--accent); opacity: 0;
  transition: left var(--calm) var(--ease), right var(--calm) var(--ease), opacity var(--quick) var(--ease);
}
.vmodes button:hover { color: var(--soft); }
.vmodes button.on { color: var(--ink); }
.vmodes button.on::after { left: 14%; right: 14%; opacity: 1; }
.vzoom { flex: 0 0 auto; font-size: var(--t-meta); color: var(--faint); }
.vclose {
  flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 8px;
  color: var(--soft); background: transparent; border: 0; cursor: pointer;
  transition: color var(--quick) var(--ease), background var(--quick) var(--ease);
}
.vclose:hover { color: var(--ink); background: var(--card-hover); }

.vstage {
  position: relative;
  flex: 1 1 auto; min-height: 0;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
}
.vstage.dragging { cursor: grabbing; }
.vframe {
  position: relative;
  will-change: transform;
  box-shadow: 0 0 0 1px var(--line-firm), 0 40px 80px -50px #000;
  /* Opacity only. An animation that also names the transform wins against the
     inline transform the zoom writes, and the picture would never move again. */
  animation: viewerpic 260ms var(--ease) both;
}
@keyframes viewerpic { from { opacity: 0; } to { opacity: 1; } }
.vlayer {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  object-fit: contain;
  display: none;
}
.vlayer.show { display: block; }
.vframe.sharp .vlayer { image-rendering: pixelated; }

/* The line you drag. It lives in the window rather than in the picture, so it
   stays one hair wide however far in you have zoomed. */
.vwipe {
  position: absolute; top: 0; width: 22px;
  margin-left: -11px;
  display: flex; align-items: center; justify-content: center;
  cursor: ew-resize;
  touch-action: none;
}
.vwipe::before {
  content: ''; position: absolute; top: 0; height: 100%; width: 1.5px;
  background: color-mix(in srgb, #fff 78%, transparent);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
}
.vgrip {
  position: relative;
  width: 22px; height: 22px; border-radius: 50%;
  background: color-mix(in srgb, #fff 88%, transparent);
  box-shadow: 0 2px 10px -2px rgba(0, 0, 0, 0.7);
  transition: transform var(--quick) var(--ease);
}
.vwipe:hover .vgrip, .vwipe.holding .vgrip { transform: scale(1.14); }

.vfoot {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 12px;
  padding: 12px var(--pad) 6px;
}
.vhelp {
  flex: 0 0 auto;
  padding: 10px var(--pad) 15px;
  text-align: center;
  font-size: var(--t-label); letter-spacing: 0.03em;
  color: var(--faint);
}
.vside { flex: 0 0 auto; font-size: var(--t-label); letter-spacing: 0.14em; text-transform: uppercase; color: var(--faint); }
.vblend {
  flex: 1 1 auto; min-width: 0;
  -webkit-appearance: none; appearance: none;
  height: 3px; border-radius: 999px;
  background: linear-gradient(to right, var(--moved), var(--accent));
  outline: none; cursor: pointer;
}
.vblend::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 15px; height: 15px; border-radius: 50%;
  background: var(--ink);
  box-shadow: 0 2px 8px -2px var(--shadow);
  transition: transform var(--quick) var(--ease);
}
.vblend:active::-webkit-slider-thumb { transform: scale(1.15); }

/* --- the range it has to survive ---------------------------------------- */

/* Dragged narrow. Everything stays, nothing wraps into a mess. */
@media (max-width: 330px) {
  :root { --pad: 12px; --radius: 16px; --t-lead: 15px; }
  .target .app, .target .sep { display: none; }
  .row { gap: 9px; padding: 9px 11px; }
  .detail { padding: 0 11px 12px 28px; }
  .shot { max-height: 30vh; }
  .switch button { font-size: var(--t-meta); padding: 6px 2px 7px; }
  .ttotal { display: none; }
  .caption { display: block; }
  .shotname { display: block; white-space: normal; overflow-wrap: anywhere; }
  .shotout { display: block; text-align: left; margin-top: 2px; }
  .timing { padding: 10px var(--pad) 11px; }
  .vname { display: none; }
}

/* Pulled wide. Two columns rather than one very long thin one, so the picture
   gets the room and the list stays beside it instead of below the fold. */
@media (min-width: 720px) {
  :root { --pad: 24px; --t-lead: 19px; }
  .body { flex-direction: row; gap: 28px; padding-bottom: 4px; }
  .stage { flex: 1 1 54%; min-width: 0; align-self: center; padding-top: 0; }
  .scroll { flex: 1 1 46%; min-width: 0; padding-top: 22px; }
  .shot { max-height: 58vh; }
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

  /**
   * Point an image at a file, or at nothing at all.
   * @param {HTMLImageElement} img
   * @param {string|undefined|null} url
   */
  function setSource(img, url) {
    if (!img) return;
    if (url) img.setAttribute('src', url);
    else img.removeAttribute('src');
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
    viewer: el('viewer'), vname: el('vname'), vmodes: el('vmodes'), vzoom: el('vzoom'),
    vclose: el('vclose'), vstage: el('vstage'), vframe: el('vframe'),
    vApproved: el('vApproved'), vNow: el('vNow'), vDiff: el('vDiff'),
    vwipe: el('vwipe'), vfoot: el('vfoot'), vblend: el('vblend')
  };

  var CHEVRON = '<svg class="glyph chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 10.5l3.5 3.5 3.5-3.5"></path></svg>';

  // Somebody who has asked their computer for less movement gets none of it:
  // the CSS switches every animation off, and everything this file animates in
  // JavaScript jumps straight to its final value instead.
  var CALM = false;
  try { CALM = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { CALM = false; }

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
  // Numbers count rather than jump.
  //
  // A tally that flicks from 3 to 7 has to be re-read; one that counts up to 7
  // has already been read by the time it stops. Four hundred milliseconds, the
  // same curve as everything else, and nothing at all for anyone who asked for
  // less motion.
  // -------------------------------------------------------------------------

  function tweenTo(node, to, format) {
    var target = Number(to);
    if (!isFinite(target)) return;
    var from = typeof node.__from === 'number' ? node.__from : 0;
    if (node.__raf) { cancelAnimationFrame(node.__raf); node.__raf = 0; }
    if (CALM || from === target) {
      node.__from = target;
      node.textContent = format(target);
      return;
    }
    var began = performance.now();
    var span = 420;
    function step(now) {
      var k = (now - began) / span;
      if (k > 1) k = 1;
      var eased = 1 - Math.pow(1 - k, 3);
      var value = k === 1 ? target : from + (target - from) * eased;
      node.__from = value;
      node.textContent = format(value);
      if (k < 1) node.__raf = requestAnimationFrame(step);
      else { node.__raf = 0; node.__from = target; }
    }
    node.__raf = requestAnimationFrame(step);
  }

  // -------------------------------------------------------------------------
  // Pictures.
  //
  // The panel is a local page, so it can load the real PNG the run just wrote
  // to disk. That is the whole difference between a picture you can look at and
  // a smudge: the small preview inside the event is 320 pixels wide, and this
  // window is wider than that before anybody zooms in. So the preview is only
  // ever what fills the frame for the moment before the file is on disk, and it
  // is replaced by the real thing the instant that file will load.
  // -------------------------------------------------------------------------

  var known = Object.create(null);   // src -> 1 loaded, 2 refused
  var held = [];                     // keep the decoded pictures alive

  function preload(src, then) {
    if (!src) { if (then) then(false); return; }
    if (known[src] === 1) { if (then) then(true); return; }
    if (known[src] === 2) { if (then) then(false); return; }
    var img = new Image();
    img.onload = function () { known[src] = 1; if (then) then(true); };
    img.onerror = function () { known[src] = 2; if (then) then(false); };
    img.src = src;
    held.push(img);
    if (held.length > 24) held.shift();
  }

  function preloadAll(p) {
    if (!p) return;
    preload(p.shotFile);
    preload(p.approvedFile);
    preload(p.diffFile);
  }

  // What to show for each of the three pictures: the real file when there is
  // one, the preview until then.
  function nowOf(p) { return (p && (p.shotFile || p.thumbnail)) || ''; }
  function approvedOf(p) { return (p && (p.approvedFile || p.approvedThumb)) || ''; }
  function diffOf(p) { return (p && (p.diffFile || p.diffThumb)) || ''; }

  // -------------------------------------------------------------------------
  // The list. One line per check at rest; everything else on request.
  // -------------------------------------------------------------------------

  var items = Object.create(null);
  var order = [];
  var outcomes = Object.create(null);
  var expected = { picture: 0, guard: 0 };
  var seeding = false;
  var TONES = ['held', 'moved', 'broke', 'wait', 'skip', 'running', 'pending'];

  function keyFor(kind, name) { return kind + ':' + name; }

  function addItem(kind, name, describe) {
    var root = document.createElement('div');
    root.className = 'item fresh pending';
    // Rows arrive one after another rather than all at once. Only while the
    // opening list is being drawn — a row that appears mid-run is on its own
    // and has nothing to be staggered against.
    var wait = seeding ? Math.min(order.length, 16) * 24 : 0;
    if (wait && !CALM) root.style.animationDelay = wait + 'ms';
    setTimeout(function () {
      root.classList.remove('fresh');
      root.style.animationDelay = '';
    }, 420 + wait);

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
    var p = entry.pics;
    if (!p) return;
    var showed = false;
    if (p.status === 'changed') showed = comparePictures(p);
    if (!showed && nowOf(p)) {
      singlePicture(p, entry.name);
      showed = true;
    }
    if (!showed) return;
    nameTheShot(entry.name);
    sayOutcome(entry.tone, outcomeShort(p));
    markShowing(entry);
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
    var list = entry.root.classList;
    for (var i = 0; i < TONES.length; i++) list.remove(TONES[i]);
    list.add(tone || 'pending');
    list.toggle('attention', needsPerson(tone));
    entry.root.style.setProperty('--tone', tone ? 'var(--' + tone + ')' : 'var(--accent)');
    paintMeter();
  }

  // -------------------------------------------------------------------------
  // The meter: one hairline, sliced by outcome. Each slice lights once as it
  // lands, in its own colour, and then it is just a colour.
  // -------------------------------------------------------------------------

  var painted = [];

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
      var settled = tone && tone !== 'running';
      var lands = settled && painted[i] !== tone && !CALM;
      slices[i].className = 'slice' + (tone ? ' ' + tone : '') + (lands ? ' land' : '');
      slices[i].style.width = width;
      painted[i] = tone;
    }
  }

  var doneTicker = { __from: 0, textContent: '' };

  function tally() {
    var counted = { done: 0, changed: 0, failed: 0, waiting: 0, skipped: 0 };
    for (var i = 0; i < order.length; i++) {
      var status = outcomes[keyFor(order[i].kind, order[i].name)];
      if (!status) continue;
      counted.done++;
      if (status === 'moved') counted.changed++;
      else if (status === 'broke') counted.failed++;
      else if (status === 'wait') counted.waiting++;
      else if (status === 'skip') counted.skipped++;
    }
    return counted;
  }

  // Say what happened, not just how far along it is. "11 of 11" tells a person the
  // run finished and nothing else; they still have to read the whole list to find
  // out whether they can walk away. The tally answers that in four words.
  function countsLine(done, counted, total) {
    var parts = [];
    if (counted.failed) parts.push(commas(counted.failed) + ' broke');
    if (counted.changed) parts.push(commas(counted.changed) + ' moved');
    if (counted.waiting) parts.push(commas(counted.waiting) + ' needs you');
    if (counted.skipped) parts.push(commas(counted.skipped) + ' skipped');
    var line = commas(done) + ' of ' + commas(total);
    if (counted.done === total && total > 0 && parts.length === 0) line += ' — all held';
    return line + (parts.length ? ' · ' + parts.join(' · ') : '');
  }

  function updateCounts() {
    var counted = tally();
    var total = meterTotal();
    if (!order.length) {
      ui.counts.textContent = '';
      doneTicker.__from = 0;
    } else {
      tweenTo(doneTicker, counted.done, function (value) {
        ui.counts.textContent = countsLine(Math.round(value), counted, total);
        return '';
      });
    }
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
    if (runningItem) runningItem.root.scrollIntoView({ block: 'nearest', behavior: CALM ? 'auto' : 'smooth' });
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
    if (following) entry.root.scrollIntoView({ block: 'nearest', behavior: CALM ? 'auto' : 'smooth' });
  }

  // -------------------------------------------------------------------------
  // The hero
  // -------------------------------------------------------------------------

  var frontIsA = false;
  var shownSrc = '';
  var shownAlt = '';
  var showSeq = 0;

  // What is on the glass right now, so the viewer opens on the same thing.
  // Whether the person picked that picture themselves: it is the
  // difference between continuing what they were looking at and second-guessing
  // a default the panel chose for them.
  var onGlass = { pics: null, name: '', mode: 'now', touched: false };

  function paint(src, alt) {
    if (!src) return;
    // A run that turned out to have pictures after all gets its glass back.
    ui.stage.hidden = false;
    ui.blank.hidden = true;
    ui.shot.classList.remove('empty');
    shownAlt = alt || '';
    if (src === shownSrc) return;
    shownSrc = src;
    var next = frontIsA ? ui.layerB : ui.layerA;
    var current = frontIsA ? ui.layerA : ui.layerB;
    next.classList.remove('on');
    next.classList.remove('out');
    next.src = src;
    next.alt = shownAlt;
    // Read a layout value so the browser starts the fade from where the layer
    // rests rather than skipping straight to the end of it.
    void next.offsetWidth;
    next.classList.add('on');
    current.classList.remove('on');
    current.classList.add('out');
    frontIsA = !frontIsA;
  }

  /**
   * Show a picture: the real file if it will load, the small preview until it
   * does. The swap between the two is the same cross-fade as any other change
   * of picture, so a screen going from blurred to sharp reads as the panel
   * finishing a thought rather than as a glitch.
   */
  function showPicture(sharp, preview, alt) {
    var mine = ++showSeq;
    if (sharp && known[sharp] === 1) { paint(sharp, alt); return; }
    if (preview) paint(preview, alt);
    if (!sharp || sharp === preview) return;
    preload(sharp, function (ok) {
      if (!ok || mine !== showSeq) return;
      paint(sharp, alt);
    });
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

  // The shutter. On while the app is really being photographed, off the instant
  // the picture lands — never a loop that runs when nothing is happening.
  function scanning(on) {
    ui.shot.classList.toggle('scanning', !!on);
  }

  function clearTabs() {
    ui.tabs.hidden = true;
    ui.tabs.textContent = '';
  }

  /** One picture, no comparison to make: the one that was just taken. */
  function singlePicture(p, name) {
    clearTabs();
    ui.shotout.hidden = true;
    onGlass.pics = p || null;
    onGlass.name = name || '';
    onGlass.mode = 'now';
    onGlass.touched = false;
    showPicture(p && p.shotFile, p && p.thumbnail, 'the picture taken of ' + (name || 'this screen'));
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
  function comparePictures(p) {
    var choices = [];
    if (approvedOf(p)) choices.push({ mode: 'approved', label: 'Approved', sharp: p.approvedFile, preview: p.approvedThumb });
    if (nowOf(p)) choices.push({ mode: 'now', label: 'Now', sharp: p.shotFile, preview: p.thumbnail });
    if (diffOf(p)) choices.push({ mode: 'diff', label: 'Difference', sharp: p.diffFile, preview: p.diffThumb });
    // Two pictures is the whole point; one on its own says nothing a person
    // could act on, so leave the live picture up instead.
    if (choices.length < 2) return false;

    onGlass.pics = p;
    onGlass.name = p.name || '';
    onGlass.touched = false;
    ui.tabs.textContent = '';
    ui.tabs.style.setProperty('--tone', 'var(--moved)');

    var buttons = [];
    function select(index) {
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].className = i === index ? 'on' : '';
        buttons[i].setAttribute('aria-pressed', i === index ? 'true' : 'false');
      }
      var choice = choices[index];
      onGlass.mode = choice.mode;
      showPicture(choice.sharp, choice.preview,
        choice.label.toLowerCase() + ' picture of ' + (p.name || 'this screen'));
    }
    choices.forEach(function (choice, index) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = choice.label;
      button.addEventListener('click', function () { onGlass.touched = true; select(index); });
      buttons.push(button);
      ui.tabs.appendChild(button);
    });
    ui.tabs.hidden = false;

    var preferred = choices.length - 1;
    for (var i = 0; i < choices.length; i++) {
      if (choices[i].mode === 'diff') preferred = i;
    }
    select(preferred);
    return true;
  }

  // -------------------------------------------------------------------------
  // The viewer.
  //
  // The panel is a local page, so this is the real file at its real size. Wheel
  // or pinch to zoom, drag to move around, double-click to fit, Escape to put
  // it away. Past about twice the size it fits at, the smoothing comes off —
  // somebody who has zoomed in is asking to see the pixels themselves.
  //
  // For a screen that moved, this is also where the decision gets made, so the
  // approved picture and the new one sit under one line you can drag across
  // them, with a fade for the changes a hard edge hides, and the difference is
  // one word away.
  // -------------------------------------------------------------------------

  var view = {
    open: false, mode: '', z: 1, px: 0, py: 0,
    natW: 0, natH: 0, frameW: 0, frameH: 0, fit: 1,
    wipe: 50, blend: 100, pics: null, name: ''
  };

  function viewerSources(p) {
    return {
      now: p ? (p.shotFile || p.thumbnail || '') : '',
      approved: p ? (p.approvedFile || p.approvedThumb || '') : '',
      diff: p ? (p.diffFile || p.diffThumb || '') : ''
    };
  }

  var MODE_WORDS = { now: 'Now', approved: 'Approved', compare: 'Before & after', diff: 'Difference' };

  function openViewer(p, name, wanted) {
    var src = viewerSources(p);
    if (!src.now && !src.approved && !src.diff) return;

    view.pics = p;
    view.name = name || '';
    view.wipe = 50;
    view.blend = 100;
    ui.vblend.value = '100';
    ui.vname.textContent = view.name;

    // An empty src is not "no picture" — the browser resolves it against the page's
    // own address and fetches the panel document as though it were an image, which
    // fails and leaves a broken element sitting in the viewer. Take the attribute off.
    setSource(ui.vApproved, src.approved);
    setSource(ui.vNow, src.now);
    setSource(ui.vDiff, src.diff);

    var modes = [];
    if (src.now) modes.push('now');
    if (src.approved) modes.push('approved');
    if (src.approved && src.now) modes.push('compare');
    if (src.diff) modes.push('diff');

    ui.vmodes.textContent = '';
    modes.forEach(function (mode) {
      var button = document.createElement('button');
      button.type = 'button';
      button.dataset.mode = mode;
      button.textContent = MODE_WORDS[mode];
      button.addEventListener('click', function () { setMode(mode); });
      ui.vmodes.appendChild(button);
    });
    ui.vmodes.hidden = modes.length < 2;

    // The size everything is laid out at: whichever real picture we have.
    var measuring = src.now || src.approved || src.diff;
    view.natW = 0; view.natH = 0;
    var probe = new Image();
    probe.onload = function () {
      view.natW = probe.naturalWidth || 0;
      view.natH = probe.naturalHeight || 0;
      fitPicture();
    };
    probe.onerror = function () { view.natW = 0; view.natH = 0; fitPicture(); };
    probe.src = measuring;

    view.open = true;
    ui.viewer.hidden = false;

    var start = wanted && modes.indexOf(wanted) >= 0 ? wanted
      : (modes.indexOf('compare') >= 0 ? 'compare' : modes[0]);
    setMode(start);
    resetZoom(true);
  }

  function closeViewer() {
    if (!view.open) return;
    view.open = false;
    ui.viewer.hidden = true;
    ui.vNow.style.clipPath = '';
    ui.vwipe.hidden = true;
  }

  function setMode(mode) {
    view.mode = mode;
    var buttons = ui.vmodes.children;
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].className = buttons[i].dataset.mode === mode ? 'on' : '';
    }
    var comparing = mode === 'compare';
    ui.vApproved.classList.toggle('show', mode === 'approved' || comparing);
    ui.vNow.classList.toggle('show', mode === 'now' || comparing);
    ui.vDiff.classList.toggle('show', mode === 'diff');
    ui.vwipe.hidden = !comparing;
    ui.vfoot.hidden = !comparing;
    ui.vNow.style.opacity = comparing ? String(view.blend / 100) : '1';
    ui.vNow.style.clipPath = comparing ? 'inset(0 0 0 ' + view.wipe + '%)' : '';
    placeWipe();
  }

  /** How big the frame is when the whole picture fits in the window. */
  function fitPicture() {
    var wide = ui.vstage.clientWidth;
    var tall = ui.vstage.clientHeight;
    var natW = view.natW || 16;
    var natH = view.natH || 10;
    var room = 0.94;
    view.fit = Math.min((wide * room) / natW, (tall * room) / natH);
    view.frameW = Math.max(1, Math.round(natW * view.fit));
    view.frameH = Math.max(1, Math.round(natH * view.fit));
    ui.vframe.style.width = view.frameW + 'px';
    ui.vframe.style.height = view.frameH + 'px';
    applyView();
  }

  function clampPan() {
    var wide = ui.vstage.clientWidth;
    var tall = ui.vstage.clientHeight;
    var w = view.frameW * view.z;
    var h = view.frameH * view.z;
    var mx = Math.max(0, (w - wide) / 2) + 20;
    var my = Math.max(0, (h - tall) / 2) + 20;
    if (view.px > mx) view.px = mx;
    if (view.px < -mx) view.px = -mx;
    if (view.py > my) view.py = my;
    if (view.py < -my) view.py = -my;
  }

  function applyView() {
    clampPan();
    ui.vframe.style.transform =
      'translate3d(' + Math.round(view.px) + 'px,' + Math.round(view.py) + 'px,0) scale(' + view.z + ')';
    ui.vzoom.textContent = view.z.toFixed(1) + '×';
    // Once one pixel of the picture is covering about two pixels of the screen,
    // the smoothing comes off and the real pixels show. Not a moment before: a
    // picture being made SMALLER, which is what a retina screenshot in a narrow
    // panel is doing even at four times, is wrecked by turning smoothing off.
    // The screen's own density counts, which is why it is in the sum.
    var dense = view.fit * view.z * (window.devicePixelRatio || 1);
    ui.vframe.classList.toggle('sharp', dense >= 1.9);
    placeWipe();
  }

  // The line lives in the window rather than in the picture, so it stays one
  // hair wide however far in somebody has zoomed — which means its position has
  // to be worked out again every time the picture moves.
  function placeWipe() {
    if (ui.vwipe.hidden) return;
    var wide = ui.vstage.clientWidth;
    var tall = ui.vstage.clientHeight;
    var x = wide / 2 + view.px + view.z * (view.frameW * (view.wipe / 100) - view.frameW / 2);
    ui.vwipe.style.left = Math.round(x) + 'px';
    // It is only ever as long as the picture is, so it never draws a line
    // through the empty space above and below one.
    var height = view.frameH * view.z;
    var top = tall / 2 + view.py - height / 2;
    var bottom = top + height;
    if (top < 0) top = 0;
    if (bottom > tall) bottom = tall;
    ui.vwipe.style.top = Math.round(top) + 'px';
    ui.vwipe.style.height = Math.round(Math.max(0, bottom - top)) + 'px';
    ui.vNow.style.clipPath = 'inset(0 0 0 ' + view.wipe + '%)';
  }

  function resetZoom(quiet) {
    view.z = 1; view.px = 0; view.py = 0;
    if (!quiet && !CALM) {
      ui.vframe.style.transition = 'transform 260ms cubic-bezier(0.22,0.72,0.24,1)';
      setTimeout(function () { ui.vframe.style.transition = ''; }, 300);
    }
    applyView();
  }

  function zoomAt(factor, clientX, clientY) {
    var rect = ui.vstage.getBoundingClientRect();
    var cx = clientX - rect.left - rect.width / 2;
    var cy = clientY - rect.top - rect.height / 2;
    var next = view.z * factor;
    if (next < 1) next = 1;
    if (next > 8) next = 8;
    if (next === view.z) return;
    // Keep whatever is under the pointer under the pointer.
    var fx = (cx - view.px) / view.z;
    var fy = (cy - view.py) / view.z;
    view.px = cx - next * fx;
    view.py = cy - next * fy;
    view.z = next;
    applyView();
  }

  ui.vstage.addEventListener('wheel', function (e) {
    if (!view.open) return;
    e.preventDefault();
    // A trackpad pinch arrives here as a wheel with the control key held, and
    // it wants a finer touch than a mouse wheel does.
    var rate = e.ctrlKey ? 0.011 : 0.0026;
    zoomAt(Math.exp(-e.deltaY * rate), e.clientX, e.clientY);
  }, { passive: false });

  ui.vstage.addEventListener('dblclick', function () { resetZoom(false); });

  var panning = null;
  ui.vstage.addEventListener('pointerdown', function (e) {
    if (!view.open || e.button !== 0) return;
    if (ui.vwipe.contains(e.target)) return;
    panning = { x: e.clientX, y: e.clientY, px: view.px, py: view.py, id: e.pointerId };
    ui.vstage.classList.add('dragging');
    try { ui.vstage.setPointerCapture(e.pointerId); } catch (err) { /* a pointer we cannot hold is still a pointer we can follow */ }
  });
  ui.vstage.addEventListener('pointermove', function (e) {
    if (!panning || e.pointerId !== panning.id) return;
    view.px = panning.px + (e.clientX - panning.x);
    view.py = panning.py + (e.clientY - panning.y);
    applyView();
  });
  function endPan(e) {
    if (!panning) return;
    ui.vstage.classList.remove('dragging');
    try { ui.vstage.releasePointerCapture(panning.id); } catch (err) { /* already gone */ }
    panning = null;
  }
  ui.vstage.addEventListener('pointerup', endPan);
  ui.vstage.addEventListener('pointercancel', endPan);

  var wiping = null;
  ui.vwipe.addEventListener('pointerdown', function (e) {
    e.stopPropagation();
    wiping = e.pointerId;
    ui.vwipe.classList.add('holding');
    try { ui.vwipe.setPointerCapture(e.pointerId); } catch (err) { /* as above */ }
  });
  ui.vwipe.addEventListener('pointermove', function (e) {
    if (wiping === null || e.pointerId !== wiping) return;
    var rect = ui.vstage.getBoundingClientRect();
    var cx = e.clientX - rect.left - rect.width / 2;
    var inFrame = (cx - view.px) / view.z + view.frameW / 2;
    var pct = (inFrame / view.frameW) * 100;
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    view.wipe = pct;
    placeWipe();
  });
  function endWipe(e) {
    if (wiping === null) return;
    ui.vwipe.classList.remove('holding');
    try { ui.vwipe.releasePointerCapture(wiping); } catch (err) { /* already gone */ }
    wiping = null;
  }
  ui.vwipe.addEventListener('pointerup', endWipe);
  ui.vwipe.addEventListener('pointercancel', endWipe);

  ui.vblend.addEventListener('input', function () {
    view.blend = Number(ui.vblend.value) || 0;
    if (view.mode === 'compare') ui.vNow.style.opacity = String(view.blend / 100);
  });

  ui.vclose.addEventListener('click', closeViewer);

  window.addEventListener('resize', function () {
    if (view.open) fitPicture();
  });

  // The picture on the glass opens at the same picture, so clicking it is a
  // continuation rather than a jump.
  ui.shot.addEventListener('click', function () {
    if (ui.shot.classList.contains('empty')) return;
    if (onGlass.pics) {
      // A screen that moved opens on the comparison, because that is the
      // question being asked — unless the person has already chosen which of
      // the three pictures they wanted to look at, in which case they get that.
      var wanted = onGlass.mode;
      if (!onGlass.touched && onGlass.pics.status === 'changed') wanted = 'compare';
      openViewer(onGlass.pics, onGlass.name, wanted);
      return;
    }
    if (shownSrc) openViewer({ shotFile: shownSrc }, onGlass.name || ui.shotname.textContent, 'now');
  });

  document.addEventListener('keydown', function (e) {
    if (!view.open) return;
    if (e.key === 'Escape') { closeViewer(); return; }
    if (e.key === '0') { resetZoom(false); return; }
    if (e.key === '+' || e.key === '=') {
      var rect = ui.vstage.getBoundingClientRect();
      zoomAt(1.35, rect.left + rect.width / 2, rect.top + rect.height / 2);
      return;
    }
    if (e.key === '-' || e.key === '_') {
      var box = ui.vstage.getBoundingClientRect();
      zoomAt(1 / 1.35, box.left + box.width / 2, box.top + box.height / 2);
    }
  });

  // -------------------------------------------------------------------------
  // The clock
  // -------------------------------------------------------------------------

  var origin = null;
  var ticking = 0;
  var finished = false;
  var lastPrinted = '';

  function startClock(at) {
    if (origin !== null || finished) return;
    origin = performance.now() - (Number(at) || 0);
    var tick = function () {
      var text = fmt(performance.now() - origin);
      if (text !== lastPrinted) { lastPrinted = text; ui.clock.textContent = text; }
      ticking = requestAnimationFrame(tick);
    };
    ticking = requestAnimationFrame(tick);
  }

  function stopClock(finalMs) {
    if (ticking) { cancelAnimationFrame(ticking); ticking = 0; }
    finished = true;
    if (typeof finalMs !== 'number' || !isFinite(finalMs)) return;
    // It counts the last stretch out rather than jumping to the total, which is
    // what makes the end of a run read as an arrival instead of a cut.
    ui.clock.__from = origin === null ? finalMs : performance.now() - origin;
    tweenTo(ui.clock, finalMs, fmt);
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

  function setState(text, tone, arriving) {
    ui.state.textContent = text;
    ui.state.className = 'state' + (tone ? ' ' + tone : '');
    if (!arriving || CALM) return;
    // Restart the animation rather than letting a second class do nothing.
    ui.state.classList.remove('arrive');
    void ui.state.offsetWidth;
    ui.state.classList.add('arrive');
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
      scanning(true);
      return;
    }

    if (type === 'screen:shot') {
      scanning(false);
      var shotRow = ev.name ? ensureItem('picture', String(ev.name), ev.describe) : null;
      if (ev.thumbnail || ev.shotFile) {
        var taken = { name: ev.name, status: '', thumbnail: ev.thumbnail || '', shotFile: ev.shotFile || '' };
        if (shotRow) shotRow.pics = taken;
        singlePicture(taken, String(ev.name || ''));
      }
      if (ev.name) nameTheShot(ev.name);
      markShowing(shotRow);
      return;
    }

    if (type === 'screen:done') {
      scanning(false);
      var done = ensureItem('picture', String(ev.name || ''), ev.describe);
      var tone = finish(done, 'picture', ev);
      // The name, the caption and the light behind the glass all move together
      // with the picture, or none of them move. A screen that could not be
      // photographed leaves the last real one up, correctly labelled, rather
      // than putting its own name under someone else's picture.
      var showed = false;
      var p = done.pics;
      if (p) {
        if (ev.status === 'changed') showed = comparePictures(p);
        if (!showed && nowOf(p)) {
          singlePicture(p, String(ev.name || ''));
          showed = true;
        }
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
      scanning(false);
      var summary = ev.summary || null;
      stopClock(typeof ev.at === 'number' ? ev.at : (summary && summary.durationMs));
      var verdict = ev.verdict || fallbackVerdict();
      var worst = worstTone();
      setState(verdict, worst, true);
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
          if (first) first.root.scrollIntoView({ block: 'center', behavior: CALM ? 'auto' : 'smooth' });
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
      var before = entry.pics || {};
      entry.pics = {
        name: ev.name, status: ev.status,
        thumbnail: ev.thumbnail || before.thumbnail || '',
        shotFile: ev.shotFile || before.shotFile || '',
        approvedThumb: ev.approvedThumb || '',
        approvedFile: ev.approvedFile || '',
        diffThumb: ev.diffThumb || '',
        diffFile: ev.diffFile || '',
        diffPixels: ev.diffPixels, message: ev.message
      };
      if (!nowOf(entry.pics) && !approvedOf(entry.pics) && !diffOf(entry.pics)) entry.pics = null;
      // Everything this screen owns is fetched now, so the viewer opens on a
      // picture that is already decoded and the swap never flashes.
      preloadAll(entry.pics);
    }
    entry.outText = outcomeText(kind, ev);
    entry.failedAt = (kind === 'guard' && ev.status === 'failed' && ev.failedAt) ? ev.failedAt : '';
    entry.story = (kind === 'guard' && ev.status === 'failed' && ev.because) ? ev.because : '';
    if (typeof ev.durationMs === 'number') tweenTo(entry.time, ev.durationMs, fmt);
    entry.tone = tone;
    redraw(entry);
    setTone(entry, tone);
    // Only the checks that want a person open themselves. Everything else stays
    // one line, which is what keeps a clean run quiet. A row that has just
    // opened is worth seeing all of, so the list makes room for it — unless the
    // person has taken hold of the list, in which case nothing moves.
    if (needsPerson(tone)) {
      setOpen(entry, true);
      if (following) {
        requestAnimationFrame(function () {
          entry.root.scrollIntoView({ block: 'nearest', behavior: CALM ? 'auto' : 'smooth' });
        });
      }
    }
    // Something that broke says so once, with weight, and then sits still.
    if (tone === 'broke' && !CALM) {
      entry.root.classList.remove('alarm');
      void entry.root.offsetWidth;
      entry.root.classList.add('alarm');
      setTimeout(function () { entry.root.classList.remove('alarm'); }, 1000);
    }
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
    scanning(false);
    runningItem = null;
  };

  // Draw the plan before anything has happened, so the window is worth looking
  // at from the first frame instead of appearing empty.
  (function seed() {
    var i;
    seeding = true;
    for (i = 0; i < (plan.screens || []).length; i++) {
      addItem('picture', plan.screens[i].name, plan.screens[i].describe);
    }
    for (i = 0; i < (plan.guards || []).length; i++) {
      addItem('guard', plan.guards[i].name, plan.guards[i].describe);
    }
    seeding = false;
    updateCounts();
    if (!order.length) ui.shot.classList.add('empty');
    // Guards only: there will never be a picture, so the panel does not hold a
    // screen's worth of empty glass open waiting for one.
    if (!(plan.screens || []).length && (plan.guards || []).length) ui.stage.hidden = true;
  })();
})();
`;
