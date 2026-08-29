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
    // Said once, plainly. Without it the list of names and times reads as a
    // speed report — which is exactly how it read to the first person who
    // looked at it. The times are how long a check took; the check is this.
    '<p class="what" id="what"></p>',
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
    // The working for whatever is on the glass. It belongs in the scrolling
    // column, not inside the picture's own box — put there it stole the
    // picture's height and squashed it to a sliver.
    '<section class="work-here" id="work" hidden></section>',
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
   Tokens — graphite and signal.

   The page is graphite. Ground, cards, glass, the picture's well and every
   piece of furniture on it are one family of greys, separated only by how much
   light they carry and by a hairline where two of them meet. Type does the
   rest: one monospace for names and numbers, one text face for sentences, one
   scale of five sizes.

   Colour is not decoration here and it is not a mood. It is reserved, entirely,
   for the three things a person has to be told: a screen MOVED, a guard BROKE,
   or something is WAITING for them to look at it. A check that held is not
   coloured — it is simply present, in grey. A check that is running is not
   coloured either; it is only lit. That is why the colours can be this pure:
   they are the only ones on the page, so one amber dot in a column of graphite
   is unmissable from across a desk.

   The five states are also a ladder of lightness, in even steps of about
   1.46:1, so they can be told apart with no colour vision at all — and each
   one carries its own silhouette as well: a hollow ring for a check nobody ran,
   a plain disc for one that held, a disc inside a crisp ring for one waiting,
   a disc in a soft halo for one that moved, a diamond for one that broke.

   Dark is the design — this window sits beside an editor all day. Light is
   quarried from the same rock: a stone ground with cards floating a shade
   above it, never a white page.
   -------------------------------------------------------------------------- */
:root {
  color-scheme: dark;

  /* Neutral black. No warm cast, no cool cast — every tint I tried made the
     panel look like it was lit by something that was not in the room. The
     character comes from the three state colours and nothing else. */
  --ground: #101010;
  --lift: #191919;
  --card: rgba(255, 255, 255, 0.035);
  --card-hover: rgba(255, 255, 255, 0.06);
  --well: #0a0a0a;
  --glass: rgba(16, 16, 16, 0.9);

  --ink: #ededed;
  --soft: #b2b2b2;
  --faint: #8d8d8d;
  --faintest: #6d6d6d;
  /* Not sure yet: it wobbled, it needed a second go, or the answer is soft. */
  --doubt: #e8b85c;

  --line: rgba(255, 255, 255, 0.055);
  --line-firm: rgba(255, 255, 255, 0.17);
  --sheen: rgba(255, 255, 255, 0.03);
  --shadow: rgba(0, 0, 0, 0.5);

  /* Activity, not state. Something is happening — the shutter, a running dot,
     a live segment of the meter. Deliberately colourless: "happening" is not
     news, and the moment it has news it has a colour instead. */
  /* The brand mark, the thing that is running, and the check that wants a person
     are all this one colour — so on a page that is otherwise grey, this means
     "you". A clear sky blue: bright enough to find at a glance, cool enough not
     to be mistaken for the amber that means something moved. */
  --accent: #4fb3f0;

  /* Held is green, and visibly so.
     It was a grey at first, on the argument that a check which passed has
     nothing to say. True of a whole run — the verdict line and the meter are
     quiet when all is well — but wrong of the individual check: a person
     scanning a list of thirty things wants to SEE that twenty-nine of them
     held, not infer it from an absence. Green passed, red broke, amber not
     sure. Grey is only for what never ran. */
  --held: #25d366;

  /* The three that have something to say. Pure, because they are alone. */
  --broke: #ff4438;
  /* Waiting for a person is the brand colour itself. */
  --wait: #4fb3f0;
  --moved: #ffc24d;

  /* Nobody ran it. Barely there on purpose. */
  --resting: rgba(255, 255, 255, 0.09);
  --skip: var(--faintest);
  --pending: var(--faintest);
  --running: var(--accent);
  --waiting: var(--wait);

  /* Small radii, flat surfaces. The app this sits beside uses 8px and almost no
     shadow; a panel with 20px corners and floating cards read as a different
     product bolted on to the side of it. */
  --radius: 10px;
  --radius-sm: 8px;
  --radius-xs: 6px;

  --pad: 16px;
  --tint: var(--accent);

  /* The type scale. Nothing on this page is set at a size that is not here. */
  --t-label: 10px;
  --t-meta: 10.5px;
  --t-small: 11px;
  --t-body: 11.5px;
  --t-name: 12px;
  --t-lead: 18px;

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
 *
 * The same rock, lit from the other side: a stone ground, cards a shade brighter
 * than it rather than the other way round, and the three signal colours taken
 * down until they hold on paper. The ladder inverts with the ground — the
 * quietest state is now the lightest — and the steps stay wide enough to read
 * with no colour vision.
 */
:root[data-theme='light'],
:root[data-theme='system'] {
  color-scheme: light;

  --ground: #d9dade;
  --lift: #eef0f3;
  --card: rgba(255, 255, 255, 0.6);
  --card-hover: #ffffff;
  --well: #c7c9cf;
  --glass: rgba(232, 234, 238, 0.9);

  --ink: #14161a;
  --soft: #545a62;
  --faint: #5e646c;
  --faintest: #6f757d;

  --line: rgba(20, 22, 26, 0.11);
  --line-firm: rgba(20, 22, 26, 0.24);
  --sheen: rgba(255, 255, 255, 0.9);
  --shadow: rgba(26, 30, 38, 0.34);

  --accent: #474d56;
  --held: #757b83;
  --broke: #7e1105;
  --wait: #0e5588;
  --moved: #8a5f06;

  --resting: rgba(20, 22, 26, 0.13);
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

/* One light above, one shadow below. Nothing else.
   There was a five-bloom mesh here with warm and coloured washes in it; on a
   neutral black ground it read as a stain rather than as depth. What is left is
   the least that stops a page of greys looking like flat paint, plus the tint of
   the worst thing that has happened — which on a run where everything held is no
   colour at all. */
.aura {
  position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background:
    radial-gradient(126% 42% at 50% -12%, color-mix(in srgb, var(--tint) 12%, transparent), transparent 70%),
    radial-gradient(128% 56% at 50% 116%, var(--shadow), transparent 62%);
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
  backdrop-filter: blur(22px) saturate(120%);
  -webkit-backdrop-filter: blur(22px) saturate(120%);
  /* Separated from the list by a hairline and nothing else. */
  box-shadow: 0 1px 0 var(--line);
}
.brand { display: flex; align-items: center; gap: 9px; }
/* The mark sits on a milled square of the same graphite, lit along its top
   edge. It is the product's own face, so it is never one of the three colours
   that mean something is wrong. */
.badge {
  flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center;
  width: 24px; height: 24px;
  border-radius: 8px;
  color: var(--ink);
  background: var(--lift);
  box-shadow: inset 0 0 0 1px var(--line-firm);
}
.badge .glyph { width: 15px; height: 15px; }
.wordmark {
  flex: 1 1 auto; min-width: 0;
  font-size: var(--t-label); font-weight: 600;
  letter-spacing: 0.22em; text-transform: uppercase;
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
.target .sep { color: var(--faintest); flex: 0 0 auto; }
.target .app { color: var(--faint); flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; font-size: var(--t-body); }

/* The sentence. The largest text on the page after the picture, because it is
   the one thing a person reads from four feet away. It is white while the news
   is good and takes a colour only when there is news. */
.state {
  margin-top: 10px;
  font-size: var(--t-lead); font-weight: 600; line-height: 1.3;
  letter-spacing: -0.014em;
  overflow-wrap: anywhere;
  transition: color var(--slow) var(--ease);
}
.state.held, .state.moved, .state.broke, .state.wait { color: var(--ink); }
/* The sentence stays white; a signal sits in front of it. It is the same mark
   the row it is about carries — a haloed disc for a screen that moved, a disc
   in a ring for one waiting on a person, a diamond for a guard that broke — so
   the top of the window and the list underneath speak one language. The words
   are what you read from four feet away; the mark is what you see before you
   have read anything at all. */
.state.moved::before, .state.wait::before, .state.broke::before {
  content: ''; display: inline-block;
  width: 10px; height: 10px; border-radius: 50%;
  margin-right: 13px; vertical-align: 0.1em;
}
.state.moved::before {
  background: var(--moved);
  box-shadow: 0 0 0 5px color-mix(in srgb, var(--moved) 17%, transparent);
}
.state.wait::before {
  background: var(--wait);
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--wait) 42%, transparent),
    0 0 0 5px color-mix(in srgb, var(--wait) 12%, transparent);
}
.state.broke::before {
  background: var(--broke); border-radius: 2px; transform: rotate(45deg);
  box-shadow: 0 0 0 5px color-mix(in srgb, var(--broke) 17%, transparent);
}
/* The verdict arrives rather than appearing: it is the one sentence the whole
   run was for, and a run that ends by swapping a word looks like a page that
   was not paying attention. */
.state.arrive { animation: arrive 340ms var(--ease) both; }
@keyframes arrive {
  from { opacity: 0; transform: translateY(7px); filter: blur(4px); }
  to { opacity: 1; transform: none; filter: blur(0); }
}
.what {
  margin: 7px 0 0; font-size: var(--t-small); color: var(--faint);
  line-height: 1.5; overflow-wrap: anywhere;
}
.rverdict {
  flex: 0 0 auto; font-size: var(--t-small); color: var(--faint);
  white-space: nowrap; padding-left: 10px;
}
.item.held .rverdict { color: var(--faint); }
.item.moved .rverdict { color: var(--moved); }
.item.broke .rverdict { color: var(--broke); }
.item.wait .rverdict { color: var(--wait); }
.item.waiting .rverdict { color: var(--waiting); }
.item.pending .rverdict, .item.skip .rverdict { color: var(--faintest); }
.note { margin-top: 6px; font-size: var(--t-body); color: var(--faint); overflow-wrap: anywhere; }

/* One hairline, not a row of blocks. Each finished check adds its own slice of
   colour to a single continuous line, so progress and outcome are the same
   object and there is one fewer thing on the page. A run where everything held
   finishes as one unbroken grey rule — which is the point. */
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
.slice.wait { background: var(--wait); }
.slice.skip { background: color-mix(in srgb, var(--ink) 13%, transparent); }
.slice.running {
  background: var(--accent);
  animation: breathe 1.9s var(--ease) infinite;
}
/* A segment lights as it lands, once, and then it is just a colour. */
.slice.land { animation: land 520ms var(--ease) 1; }
@keyframes land { 0% { filter: brightness(2.1); } 100% { filter: none; } }
@keyframes breathe { 0%, 100% { opacity: 0.34; } 50% { opacity: 1; } }
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
  box-shadow: 0 0 0 1px var(--line);
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

/* The shutter, made visible. One pass of plain light across the glass for
   exactly as long as the app is really being photographed — it starts when the
   screen starts and it is gone the instant the picture lands. It is light, not
   colour: nothing has been found out yet, so there is nothing to say. */
.sweep {
  position: absolute; inset: 0;
  pointer-events: none; opacity: 0;
  background:
    linear-gradient(100deg,
      transparent 4%,
      color-mix(in srgb, var(--accent) 8%, transparent) 30%,
      color-mix(in srgb, var(--accent) 28%, transparent) 47%,
      color-mix(in srgb, var(--accent) 72%, transparent) 50%,
      color-mix(in srgb, var(--accent) 28%, transparent) 53%,
      color-mix(in srgb, var(--accent) 8%, transparent) 70%,
      transparent 96%);
  transform: translateX(-100%);
}
.shot.scanning .sweep { opacity: 1; animation: sweep 1.6s var(--ease) infinite; }
.shot.scanning {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 34%, transparent);
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
  background: color-mix(in srgb, var(--ground) 76%, transparent);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  box-shadow: inset 0 0 0 1px var(--line-firm);
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
.shotout.wait { color: var(--wait); }

/* Approved / now / difference. Three quiet words with a line that slides
   between them — no pill, no box, because a screen that moved already has
   enough asking for the eye. The line under the chosen word is the one place
   the screen's own colour appears in the furniture. */
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
  border-radius: 2px; background: var(--ink);
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
  scrollbar-color: color-mix(in srgb, var(--soft) 20%, transparent) transparent;
  padding: 18px 5px 14px 0;
  /* The list slides away under the header rather than being cut off by a box. */
  mask-image: linear-gradient(to bottom, transparent 0, #000 16px, #000 calc(100% - 12px), transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 16px, #000 calc(100% - 12px), transparent 100%);
}
.scroll::-webkit-scrollbar { width: 10px; }
.scroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--soft) 20%, transparent);
  border-radius: 8px; border: 3px solid transparent; background-clip: padding-box;
}
.scroll::-webkit-scrollbar-track { background: transparent; }

.group + .group { margin-top: 22px; }
.grouplabel {
  display: flex; align-items: baseline; gap: 9px;
  padding: 0 6px 9px 4px;
  font-size: var(--t-label); font-weight: 600;
  letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--faint);
}
.grouplabel .mono { font-size: var(--t-label); letter-spacing: 0.06em; color: var(--faintest); }

/* A card, floating: a shade of graphite above the ground, lit along its top
   edge, one hairline round it and a soft floor under it. Nothing but light
   separates it from the page. */
.items {
  border-radius: var(--radius);
  background: var(--card);
  overflow: hidden;
  box-shadow: inset 0 0 0 1px var(--line);
}
.item + .item { box-shadow: inset 0 1px 0 var(--line); }
.item {
  transition: background var(--calm) var(--ease);
}
.item.attention { background: color-mix(in srgb, var(--tone, var(--accent)) 3.5%, transparent); }
.item.running { background: color-mix(in srgb, var(--accent) 4%, transparent); }
/* Something broke. It is said once, with weight, and then it sits still — a
   panel that keeps flashing beside your work is a panel you turn off. */
.item.alarm { animation: alarm 900ms var(--ease) 1; }
@keyframes alarm {
  0% { background: color-mix(in srgb, var(--tone, var(--broke)) 22%, transparent); }
  100% { background: color-mix(in srgb, var(--tone, var(--broke)) 3.5%, transparent); }
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
.item.showing .row, .item.working .row { box-shadow: inset 2px 0 0 var(--line-firm); }
.item.showing .rname, .item.working .rname { color: var(--ink); }
/* A check that wants a person is marked with a line down its edge in its own
   colour, not a wash across it. A wash over graphite is a stain; a line is a
   flag, and it reads at the same glance as the dot beside the name. */
.item.attention .row { box-shadow: inset 2px 0 0 var(--tone, var(--accent)); }
.item.plain .row:hover { background: transparent; }
/* Rows settle in rather than appearing, and they do it one after another, which
   is what makes a list of eleven screens read as one thing arriving. */
.item.fresh { animation: settle 300ms var(--ease) both; }
@keyframes settle {
  from { opacity: 0; transform: translateY(7px); }
  to { opacity: 1; transform: none; }
}

/* The mark beside a name. Five states, five silhouettes, five rungs of a
   lightness ladder — so it can be read with no colour vision, in a photocopy,
   or out of the corner of an eye:
     nobody ran it   a hollow ring, barely there
     it held         a plain disc, grey, nothing around it
     it is waiting   a disc inside a crisp ring
     it moved        a disc in a soft wide halo
     it broke        a diamond in a soft wide halo
*/
.dot {
  flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%;
  background: var(--resting);
  transition: background var(--calm) var(--ease), box-shadow var(--calm) var(--ease);
}
.item.held .dot { width: 7px; height: 7px; background: var(--held); box-shadow: none; }
.item.held .rverdict { color: color-mix(in srgb, var(--held) 78%, var(--faint)); }
.item.wait .dot { background: var(--wait); box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--wait) 42%, transparent), 0 0 0 4px color-mix(in srgb, var(--wait) 12%, transparent); }
.item.moved .dot { background: var(--moved); box-shadow: 0 0 0 4px color-mix(in srgb, var(--moved) 17%, transparent); }
.item.broke .dot {
  background: var(--broke);
  border-radius: 2px; transform: rotate(45deg);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--broke) 17%, transparent);
}
.item.skip .dot, .item.pending .dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--resting); }
.item.running .dot {
  background: transparent;
  box-shadow: inset 0 0 0 2px var(--accent);
  animation: ping 1.8s var(--ease) infinite;
}
@keyframes ping {
  0% { box-shadow: inset 0 0 0 2px var(--accent), 0 0 0 0 color-mix(in srgb, var(--accent) 34%, transparent); }
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
.rtime { margin-left: 12px; }
.rtime {
  flex: 0 0 auto;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: var(--t-meta); color: var(--faintest);
}
.row .chev {
  flex: 0 0 auto; width: 14px; height: 14px;
  color: var(--faintest); opacity: 0;
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
.detail .why { color: var(--faint); }
/* Grey, whatever happened. The row above it has already said so in colour and
   the working below colours the step that did it — a page that says the same
   thing three times in the same colour is a page nobody scans. */
.detail .out { color: var(--soft); margin-top: 3px; }
.detail .claim {
  margin-top: 9px; padding: 9px 12px;
  border-radius: var(--radius-xs);
  background: var(--well);
  box-shadow: inset 2px 0 0 var(--broke), inset 0 0 0 1px var(--line);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--t-body); color: var(--ink);
}
.detail .claim em { font-style: normal; color: var(--faint); }
.detail .story { margin-top: 7px; color: var(--faint); }

/* The working, shown.
   A verdict and a stopwatch do not tell anybody what was actually done to a
   screen — which is exactly what the first person to look at this panel said.
   So every step of a picture check is written out here in the order it
   happened, numbered, with the number behind it on the right. It reads like a
   receipt: quiet, aligned, and only ever seen by somebody who opened the row.
   The spine down the left is built one segment per step, so the step that
   moved or broke colours its own piece of it — the same idea as the meter at
   the top of the window. */
.work-here { padding: 2px var(--pad) 10px; }
.work-here .worklabel { margin: 0 0 6px; }
.detail .worklabel { margin: 11px 0 6px; }
/* The heading of a working list: what it is, and — quietly, on the right —
   which check it belongs to. The name matters now that the list is live: a
   guard's claims can be ticking off while the last screen's picture is still
   on the glass, and a heading with no name would leave a person guessing
   whose working they are reading. */
.worklabel {
  display: flex; align-items: baseline; gap: 8px;
  font-size: var(--t-label); font-weight: 600;
  letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--faint);
}
/* The heading never wraps: three words that never change. Anything that has to
   give is the name beside it, which ellipses. */
.worklabel .worktitle { flex: 0 0 auto; white-space: nowrap; }
.worklabel .workwho {
  flex: 1 1 auto; min-width: 0;
  font-weight: 500; letter-spacing: 0.02em; text-transform: none;
  text-align: right;
  color: var(--faintest);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* Said only while a list is empty, so a check that has just started does not
   look like a check that found nothing to do. */
.workwait {
  padding: 4px 0 3px 11px;
  box-shadow: inset 1px 0 0 var(--line);
  font-size: var(--t-body); color: var(--faint);
}
.work { list-style: none; margin: 0; padding: 0; }
.step {
  display: flex; align-items: baseline; gap: 9px;
  padding: 4px 0 4px 11px;
  box-shadow: inset 1px 0 0 var(--line);
}
.step.warn { box-shadow: inset 1.5px 0 0 var(--doubt); }
.step.bad { box-shadow: inset 1.5px 0 0 var(--broke); }
.step.skipped, .step.ended { box-shadow: inset 1px 0 0 var(--resting); }
.step.running { box-shadow: inset 1.5px 0 0 color-mix(in srgb, var(--accent) 66%, transparent); }
/* A line arrives once, quietly, and then never moves again. */
.step.arrive { animation: stepin 240ms var(--ease) both; }
@keyframes stepin { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

/* The tick. This is the thing a person actually watches: each line takes its
   mark the moment it settles, so a screen being checked reads as a list
   ticking off rather than a table that appears when it is all over. A step
   still running carries a soft dot that breathes — an honest "this one is
   happening", with nothing that spins on after the step it belongs to.
   A check that passed wears a filled green disc with a white tick in it. The
   first version drew a bare grey tick on the argument that twenty green ticks
   is a Christmas tree — true of a colour used for decoration, wrong here: a
   person scanning the list wants to SEE that these held, and a disc reads as
   done from further away than a hairline tick ever will. */
.stepmark {
  /* Level with the first line of the label, never floating between the label
     and the number under it. */
  flex: 0 0 16px; align-self: flex-start;
  display: flex; align-items: center; justify-content: center;
  width: 16px; height: 18px; color: var(--faint);
  transition: color var(--calm) var(--ease);
}
.stepmark .glyph { width: 13px; height: 13px; }

/* The disc. Only for a settled verdict — a step still running keeps its bare
   mark, because a filled circle would say it had finished. */
.step.ok .stepmark, .step.warn .stepmark, .step.bad .stepmark {
  width: 16px; height: 16px; margin-top: 1px;
  border-radius: 50%;
  color: #0b1a10;
}
.step.ok .stepmark .glyph, .step.warn .stepmark .glyph, .step.bad .stepmark .glyph {
  width: 11px; height: 11px;
}
.step.ok .stepmark { background: var(--held); color: #06230f; }
.step.warn .stepmark { background: var(--doubt); color: #2a1c00; }
.step.bad .stepmark { background: var(--broke); color: #2a0703; }
.step.skipped .stepmark, .step.ended .stepmark { color: var(--faintest); }
.step.running .stepmark { color: var(--accent); }
.step.running .stepmark .glyph { animation: markpulse 1.6s var(--ease) infinite; }
@keyframes markpulse { 0%, 100% { opacity: 0.34; } 50% { opacity: 1; } }
.step.running .stepwhat { color: var(--ink); }

/* Guards: the claims are what a guard is for, so they carry the weight, and
   the actions that get the app into position sit back a little.
   Named 'stepclaim' rather than 'claim' on purpose — a bare 'claim' inside a
   detail is already the boxed expectation that failed, and these lines would
   have been swept up by it. */
.step.stepclaim .stepwhat { color: var(--ink); font-weight: 560; }
.step.stepact .stepwhat { color: var(--soft); }
.step.stepact .stepno, .step.stepact .stepnum { color: var(--faintest); }
.step.stepact .stepmark { opacity: 0.8; }
/* The numeral keeps its own column whatever happens to the right of it — a
   number that has been left behind on a line of its own is not a sequence any
   more, which is what a long label does to it on a panel dragged narrow. */
.stepno { flex: 0 0 15px; text-align: right; font-size: var(--t-label); color: var(--faintest); }
/* Label on one line, its number under it.
   They used to share a line and wrap to a second, right-aligned one whenever the
   number was long — which at 460px was most of them, and the column came out
   ragged. Stacked, it reads down the page like a receipt: what was done, then
   what it came to. */
.stepbody { flex: 1 1 auto; min-width: 0; }
/* One size, whether the working is beside the picture or under a row: the same
   size the check names are set at, so the two lists read as one thing. */
.stepwhat { color: var(--soft); font-size: var(--t-name); line-height: 1.5; }
.stepnum {
  display: block; margin-top: 1px;
  font-size: var(--t-meta); color: var(--faint);
  overflow-wrap: anywhere;
}
/* A step that wants a person is the one thing in the list that is allowed to
   be read from across the row: its words go to full strength, its number takes
   the colour of what happened. */
.step.warn .stepwhat, .step.bad .stepwhat { color: var(--ink); font-weight: 560; }
.step.warn .stepno, .step.warn .stepnum { color: var(--doubt); }
.step.bad .stepno, .step.bad .stepnum { color: var(--broke); }
.step.skipped .stepwhat, .step.skipped .stepno, .step.skipped .stepnum,
.step.ended .stepwhat, .step.ended .stepno, .step.ended .stepnum { color: var(--faintest); }

.nothing { padding: 26px 16px; color: var(--faint); font-size: var(--t-body); line-height: 1.7; text-align: center; }
.nothing .mono { color: var(--soft); }

/* --- where the time went ------------------------------------------------- */
.timing {
  flex: 0 0 auto;
  padding: 12px var(--pad) 13px;
  border-top: 1px solid var(--line);
  background: var(--glass);
  backdrop-filter: blur(22px) saturate(120%);
  -webkit-backdrop-filter: blur(22px) saturate(120%);
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
  letter-spacing: 0.2em; text-transform: uppercase;
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
.tophead .chev { color: var(--faintest); width: 13px; height: 13px; transition: transform var(--calm) var(--ease); }
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
  /* Clear of the pinned strip at the bottom, not on top of it. At 16px it sat
     squarely over the timing line and covered the words it floated above. */
  position: fixed; left: 50%; bottom: 62px; transform: translateX(-50%);
  z-index: 4;
  font-size: var(--t-body);
  color: var(--soft);
  background: var(--lift);
  border: 0; border-radius: 999px;
  padding: 7px 15px; cursor: pointer;
  box-shadow: inset 0 0 0 1px var(--line-firm);
  animation: settle 240ms var(--ease) both;
  transition: color var(--quick) var(--ease), background var(--quick) var(--ease);
}
.follow:hover { color: var(--ink); background: var(--card-hover); }

/* --- the one thing left to do ------------------------------------------- */
.foot {
  flex: 0 0 auto;
  padding: 14px var(--pad) 16px;
  background: var(--glass);
  backdrop-filter: blur(22px) saturate(120%);
  -webkit-backdrop-filter: blur(22px) saturate(120%);
  border-top: 1px solid var(--line);
  animation: arrive 340ms var(--ease) both;
}
.nextlabel {
  font-size: var(--t-label); font-weight: 600;
  letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--faint);
  margin-bottom: 8px;
}
.cmd { display: flex; align-items: stretch; gap: 7px; }
.cmd code {
  flex: 1 1 auto; min-width: 0;
  display: flex; align-items: center;
  background: var(--well);
  border-radius: var(--radius-xs);
  box-shadow: inset 0 0 0 1px var(--line);
  padding: 9px 11px; font-size: var(--t-body);
  color: var(--ink);
  overflow-wrap: anywhere;
  user-select: all;
}
.prompt { flex: 0 0 auto; color: var(--faint); user-select: none; }
.copy {
  flex: 0 0 auto; width: 36px;
  display: flex; align-items: center; justify-content: center;
  color: var(--soft); background: var(--well);
  border: 0; border-radius: var(--radius-xs);
  box-shadow: inset 0 0 0 1px var(--line);
  cursor: pointer;
  transition: color var(--quick) var(--ease), background var(--quick) var(--ease);
}
.copy:hover { color: var(--ink); background: var(--card-hover); }
/* Copied. Not a colour — colour means something is wrong — but a hard invert,
   which is louder than any tint and gone again in a second. */
.copy.done { color: var(--ground); background: var(--ink); }

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
  background: color-mix(in srgb, var(--ground) 88%, #000);
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
  border-radius: 2px; background: var(--ink); opacity: 0;
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
  color: var(--faintest);
}
.vside { flex: 0 0 auto; font-size: var(--t-label); letter-spacing: 0.16em; text-transform: uppercase; color: var(--faint); }
/* Grey at the approved end, the screen's own amber at the new one: the slider
   itself says which way is "what changed". */
.vblend {
  flex: 1 1 auto; min-width: 0;
  -webkit-appearance: none; appearance: none;
  height: 3px; border-radius: 999px;
  background: linear-gradient(to right, var(--line-firm), var(--moved));
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
  :root { --pad: 12px; --radius: 16px; --t-lead: 16px; }
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
  :root { --pad: 24px; --t-lead: 20px; }
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
    track: el('track'), fill: el('fill'), counts: el('counts'), what: el('what'), work: el('work'),
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

  /**
   * Two or three words for the row itself.
   *
   * The long sentence stays in the detail; this is what a person reads while
   * scanning the column. A check that held has to say so — silence next to a
   * duration is what made the panel look like it was timing page loads.
   */
  function shortOutcome(kind, ev) {
    var status = ev.status;
    if (kind === 'guard') {
      if (status === 'passed') return 'still holds';
      if (status === 'skipped') return 'left out';
      return 'broken again';
    }
    switch (status) {
      case 'passed': return 'unchanged';
      case 'changed':
        var n = ev.diffPixels || 0;
        return commas(n) + ' ' + plural(n, 'pixel', 'pixels') + ' moved';
      case 'new': return 'needs your eyes';
      case 'missing': return 'no approved picture';
      case 'failed': return 'no picture taken';
      case 'flaky': return 'would not settle';
      case 'skipped': return 'left out';
      default: return '';
    }
  }

  /**
   * The one line that says what a run is, in the words a person would use.
   */
  function describeWork(screens, guards) {
    var bits = [];
    if (screens) {
      bits.push(
        screens + ' ' + plural(screens, 'screen', 'screens') +
        ' photographed and compared, pixel for pixel, with the picture you approved',
      );
    }
    if (guards) {
      bits.push(
        guards + ' ' + plural(guards, 'guard', 'guards') +
        ' — one per bug that was already fixed once',
      );
    }
    return bits.join(' · ');
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
    var rverdict = document.createElement('span');
    rverdict.className = 'rverdict';
    var rtime = document.createElement('span');
    rtime.className = 'rtime';
    row.appendChild(dot);
    row.appendChild(rname);
    row.appendChild(rverdict);
    row.appendChild(rtime);
    row.insertAdjacentHTML('beforeend', CHEVRON);

    var detail = document.createElement('div');
    detail.className = 'detail';
    detail.hidden = true;

    root.appendChild(row);
    root.appendChild(detail);

    var entry = {
      kind: kind, name: name, root: root, row: row, time: rtime, verdict: rverdict,
      detail: detail, describe: describe || '', open: false, hasDetail: false
    };

    // One rule, so a click is never a surprise: the first click brings this
    // check forward — its picture on the glass, its detail open. The second
    // click, on the row that is already forward, folds it away again. That is
    // what makes the whole run browsable afterwards instead of only the last
    // screen photographed.
    row.addEventListener('click', function () {
      // Its picture, or its working, or both — whichever this check has. A
      // guard has no picture and its claims are the whole point of it, so a
      // guard row brings its own working back exactly like a screen does.
      var forward =
        (entry.pics && !entry.root.classList.contains('showing')) ||
        ((hasWork(entry) || entry.running) && workOwner !== entry);
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
    // The working. Everything that was really done to this check, in the order
    // it happened, numbered so it reads as a sequence rather than a bag of
    // facts. The heading and the list are the SAME two elements every time —
    // built once for this row and put back — so a redraw in the middle of a
    // run never tears down lines that are still ticking.
    if (hasWork(entry)) {
      var ol = detailWork(entry);
      d.appendChild(entry.workLabel);
      d.appendChild(ol);
      renderWork(ol, entry.checks, entry.kind);
    }
    // The expectation that failed, boxed — unless the working above already
    // ends on it, which it does now that a guard shows its claims. Nothing on
    // this page is said twice.
    if (entry.failedAt && !inWork(entry, entry.failedAt)) {
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

  // -------------------------------------------------------------------------
  // The working, ticked off live.
  //
  // A table that appears once a screen has already finished tells nobody what
  // is happening — which is exactly what the first person to watch this said.
  // So the run now announces each thing as it reaches it, and this is the part
  // of the panel that draws them: the names of what is being checked on the
  // check that is running right now, each one taking its mark as it settles.
  //
  // Two rules hold it up. Every line is found again by its own id rather than
  // redrawn, so a list that is already right is never torn down and rebuilt —
  // that is what stops it flickering when the verdict arrives carrying the
  // whole list again. And a step whose outcome needs a person shows the number
  // behind it the moment it lands, because that is the moment somebody is
  // looking.
  // -------------------------------------------------------------------------

  // The marks, drawn here like every other icon on this page. A tick for a
  // thing that held, a cross for one that broke, a stroke for a thing that was
  // deliberately not done, and a soft dot for the one happening now.
  var MARKS = {
    ok: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.4 12.6l4.3 4.3 8.9-9.8"></path></svg>',
    warn: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5.4v8.4"></path><path d="M12 18.3h.01"></path></svg>',
    bad: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6.6 6.6l10.8 10.8M17.4 6.6L6.6 17.4"></path></svg>',
    skipped: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6.4 12h11.2"></path></svg>',
    ended: '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6.4 12h11.2"></path></svg>',
    running: '<svg class="glyph" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="4.1" fill="currentColor"></circle></svg>'
  };

  var STEP_STATES = { running: 1, ok: 1, warn: 1, bad: 1, skipped: 1, ended: 1 };

  function labelOf(step) { return String(step && step.label == null ? '' : step.label).trim(); }
  function detailOf(step) { return String(step && step.detail == null ? '' : step.detail).trim(); }
  function stateOf(step) {
    var s = step && step.state;
    return STEP_STATES[s] ? s : 'ok';
  }

  // How a step is found again. The run gives a stable id to anything it will
  // announce twice — once as it starts, once as it settles — and without one
  // the words themselves have to do it.
  function idOf(step) {
    var key = step && step.key != null ? String(step.key).trim() : '';
    return key ? 'k:' + key : 'l:' + labelOf(step);
  }

  // Guards only. A guard is a promise about behaviour, and the promises are
  // the claims it makes — 'the sidebar column is gone' — with actions in
  // between to get the app into position. The claims are what the guard is
  // for, so they are the ones that carry the weight.
  var CLAIM_KEY = /^(expect|claim|assert|expected)([^a-z0-9]|$)/i;
  var ACT_KEY = /^(do|did|act|action|step|fresh|run|ran|open|click|type|press|hover|scroll|wait|read|note)([^a-z0-9]|$)/i;
  // A step that had to be tried twice is the same step, and its id says so.
  var RETRY = /^try[0-9]+[^a-z0-9]/i;
  var ACT_WORD = /^(opened|clicked|typed|pressed|hovered|scrolled|waited|went|ran|read|reached|took|started|closed|filled|chose|picked|dragged|reloaded|moved|set|gave)([^a-z0-9]|$)/i;

  function weightOf(kind, step) {
    if (kind !== 'guard') return '';
    var key = step && step.key != null ? String(step.key).trim() : '';
    if (RETRY.test(key)) key = key.replace(RETRY, '');
    if (CLAIM_KEY.test(key)) return 'stepclaim';
    if (ACT_KEY.test(key)) return 'stepact';
    return ACT_WORD.test(labelOf(step)) ? 'stepact' : 'stepclaim';
  }

  /** One line, built once and then only ever updated in place. */
  function makeLine() {
    var li = document.createElement('li');
    li.className = 'step';
    var no = document.createElement('span');
    no.className = 'stepno mono';
    var mark = document.createElement('span');
    mark.className = 'stepmark';
    var body = document.createElement('span');
    body.className = 'stepbody';
    var what = document.createElement('span');
    what.className = 'stepwhat';
    var num = document.createElement('span');
    num.className = 'stepnum mono';
    num.hidden = true;
    body.appendChild(what);
    body.appendChild(num);
    li.appendChild(no);
    li.appendChild(mark);
    li.appendChild(body);
    li.__no = no; li.__mark = mark; li.__what = what; li.__num = num;
    li.__state = ''; li.__weight = '';
    return li;
  }

  function fillLine(li, step, n, kind, fresh) {
    var state = stateOf(step);
    var weight = weightOf(kind, step);
    var said = labelOf(step);
    var behind = detailOf(step);

    if (li.__no.textContent !== String(n)) li.__no.textContent = String(n);
    if (li.__state !== state) {
      li.__state = state;
      li.__mark.innerHTML = MARKS[state] || MARKS.ok;
    }
    li.__weight = weight;
    li.className = 'step ' + state + (weight ? ' ' + weight : '') + (fresh ? ' arrive' : '');
    if (li.__what.textContent !== said) li.__what.textContent = said;
    // The number behind a step is shown the instant the step has one — a line
    // that has just gone amber or red is the one moment somebody needs it.
    if (li.__num.textContent !== behind) li.__num.textContent = behind;
    li.__num.hidden = !behind;
  }

  /**
   * Draw a list of steps into a list element, reconciling by id.
   *
   * Lines already on the page are found and updated; new ones settle in at
   * their place; anything the authoritative list no longer mentions goes. So
   * the same function serves a step arriving on its own and the whole array
   * that comes with the verdict, and the second one changes nothing a watcher
   * already had right.
   *
   * @param {any} ol
   * @param {any} checks
   * @param {string} kind
   * @returns {number} How many lines are shown.
   */
  function renderWork(ol, checks, kind) {
    var steps = Array.isArray(checks) ? checks : [];
    var lines = ol.__lines || (ol.__lines = Object.create(null));
    var seen = Object.create(null);
    var n = 0;
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      if (!step || typeof step !== 'object') continue;
      if (!labelOf(step)) continue;
      n++;
      var id = idOf(step);
      // Two steps that answer to the same name in one list still get a line
      // each, rather than one of them quietly replacing the other.
      if (seen[id]) id = id + '#' + n;
      seen[id] = true;

      var li = lines[id];
      var fresh = false;
      if (!li) { li = makeLine(); lines[id] = li; fresh = !CALM; }
      fillLine(li, step, n, kind, fresh);
      if (fresh) forget(li);
      var at = ol.children[n - 1];
      if (at !== li) ol.insertBefore(li, at || null);
    }
    for (var gone in lines) {
      if (seen[gone]) continue;
      if (lines[gone].parentNode === ol) ol.removeChild(lines[gone]);
      delete lines[gone];
    }
    return n;
  }

  // The arriving animation is worn once and then taken off, so a line that is
  // later moved or updated never plays it again.
  function forget(li) {
    setTimeout(function () { li.classList.remove('arrive'); }, 420);
  }

  function hasWork(entry) {
    return !!(entry && Array.isArray(entry.checks) && entry.checks.length);
  }

  /** Is this sentence already one of the lines of the working? */
  function inWork(entry, said) {
    var want = String(said == null ? '' : said).trim();
    if (!want || !hasWork(entry)) return false;
    for (var i = 0; i < entry.checks.length; i++) {
      if (labelOf(entry.checks[i]) === want) return true;
    }
    return false;
  }

  /** This row's own copy of the list, for under the row. Built once. */
  function detailWork(entry) {
    if (!entry.workOl) {
      var label = document.createElement('p');
      label.className = 'worklabel';
      var title = document.createElement('span');
      title.className = 'worktitle';
      label.appendChild(title);
      entry.workLabel = label;
      entry.workTitle = title;
      entry.workOl = document.createElement('ol');
      entry.workOl.className = 'work';
    }
    entry.workTitle.textContent = entry.running ? 'What is being checked' : 'What was done';
    return entry.workOl;
  }

  // -------------------------------------------------------------------------
  // The working on the glass: whichever check the panel is showing.
  // -------------------------------------------------------------------------

  var workOwner = null;
  // Whether this run says anything as it goes. An older Stays Fixed only ever
  // hands over the whole list at the end, and a heading promising that things
  // will appear as they are checked would be a promise nobody kept.
  var sawSteps = false;

  // Built once, into the section that already sits at the top of the scrolling
  // column. It has to stay there: put inside the picture's own box it steals
  // the picture's height and squashes the screenshot to a sliver.
  var workShell = (function () {
    var label = document.createElement('p');
    label.className = 'worklabel';
    var title = document.createElement('span');
    title.className = 'worktitle';
    var who = document.createElement('span');
    who.className = 'workwho mono';
    label.appendChild(title);
    label.appendChild(who);
    var waiting = document.createElement('p');
    waiting.className = 'workwait';
    waiting.hidden = true;
    var list = document.createElement('ol');
    list.className = 'work';
    ui.work.appendChild(label);
    ui.work.appendChild(waiting);
    ui.work.appendChild(list);
    return { title: title, who: who, waiting: waiting, list: list };
  })();

  /**
   * Bring one check's working onto the glass.
   *
   * A bring is for a check that has just STARTED: the list is about to tick off
   * and it is no use doing that below the fold, so the column goes back to the
   * top where the working lives — unless the person has taken hold of the list,
   * in which case nothing moves under them, like everywhere else on this page.
   * A click never brings: somebody who reached for a row is already looking at
   * it, and the row opening under their finger is the answer.
   */
  function openWork(entry, bring) {
    if (!entry) return;
    if (workOwner && workOwner !== entry) workOwner.root.classList.remove('working');
    workOwner = entry;
    entry.root.classList.add('working');
    syncWork(entry);
    if (bring && following && ui.scroll.scrollTop > 0) {
      ui.scroll.scrollTo({ top: 0, behavior: CALM ? 'auto' : 'smooth' });
    }
  }

  /** Redraw wherever this check's working is on show. */
  function syncWork(entry) {
    if (!entry) return;
    if (workOwner === entry) {
      var n = renderWork(workShell.list, entry.checks, entry.kind);
      workShell.title.textContent = entry.running ? 'What is being checked' : 'What was done';
      workShell.who.textContent = entry.name || '';
      workShell.waiting.textContent = entry.running
        ? 'Each thing appears here as it is checked.'
        : 'Nothing was written down for this one.';
      workShell.waiting.hidden = n > 0 || !sawSteps;
      workShell.list.hidden = n === 0;
      // Nothing to show and nothing promised: the section stays out of the way.
      ui.work.hidden = n === 0 && !sawSteps;
    }
    // Under the row. Cheap once the list is on the page; the first step of a
    // check has to go the long way round, because that is what turns a row
    // with nothing under it into one worth opening.
    if (entry.workOl && entry.workOl.parentNode) {
      detailWork(entry);
      renderWork(entry.workOl, entry.checks, entry.kind);
    } else if (hasWork(entry)) {
      redraw(entry);
    }
  }

  /**
   * One step, as it happens. Announced as running, found again by its id and
   * settled when it is done.
   */
  function applyStep(entry, step) {
    if (!entry || !step || typeof step !== 'object') return;
    if (!labelOf(step)) return;
    if (!Array.isArray(entry.checks)) entry.checks = [];
    var id = idOf(step);
    var kept = {
      label: labelOf(step),
      detail: detailOf(step),
      state: stateOf(step),
      key: step.key == null ? '' : String(step.key)
    };
    var found = -1;
    for (var i = 0; i < entry.checks.length; i++) {
      if (idOf(entry.checks[i]) === id) { found = i; break; }
    }
    if (found >= 0) entry.checks[found] = kept;
    else entry.checks.push(kept);
    syncWork(entry);
  }

  /**
   * Take the authoritative list that arrives with a verdict.
   *
   * Steps keep the id they were announced with wherever the final list does not
   * carry one, so a line a watcher has already been ticking is found again and
   * updated rather than thrown away and drawn a second time. That is what makes
   * the moment a check finishes look like nothing happened at all.
   */
  function adopt(entry, checks) {
    var live = Array.isArray(entry.checks) ? entry.checks : [];
    var known = Object.create(null);
    var i;
    for (i = 0; i < live.length; i++) {
      if (live[i] && live[i].key) known[labelOf(live[i])] = String(live[i].key);
    }
    var out = [];
    for (i = 0; i < checks.length; i++) {
      var step = checks[i];
      if (!step || typeof step !== 'object') continue;
      var said = labelOf(step);
      if (!said) continue;
      var key = step.key == null ? '' : String(step.key);
      out.push({
        label: said,
        detail: detailOf(step),
        state: stateOf(step),
        key: key || known[said] || ''
      });
    }
    entry.checks = out;
  }

  /**
   * A check has stopped. Anything still marked as happening is not happening
   * any more, and a mark that keeps breathing next to a finished result is a
   * lie — so those lines settle to a plain, colourless end.
   */
  function hush(entry) {
    if (!entry || !Array.isArray(entry.checks)) return;
    for (var i = 0; i < entry.checks.length; i++) {
      var step = entry.checks[i];
      if (stateOf(step) !== 'running') continue;
      entry.checks[i] = { label: labelOf(step), detail: detailOf(step), state: 'ended', key: step.key || '' };
    }
  }

  /**
   * The claim a guard died on, as the last line of its working.
   *
   * A guard that failed has to show every claim that held before the one that
   * did not, and this makes sure the one that did not is there even when the
   * run only reported it in the verdict.
   */
  function markFailedClaim(entry, claim) {
    var said = String(claim == null ? '' : claim).trim();
    if (!said) return;
    if (!Array.isArray(entry.checks)) entry.checks = [];
    for (var i = 0; i < entry.checks.length; i++) {
      if (labelOf(entry.checks[i]) !== said) continue;
      entry.checks[i] = {
        label: said, detail: detailOf(entry.checks[i]), state: 'bad', key: entry.checks[i].key || ''
      };
      return;
    }
    entry.checks.push({ label: said, detail: '', state: 'bad', key: 'claim:failed' });
  }

  /** Put a check back on the glass: its pictures if it has any, its working always. */
  function recall(entry) {
    var p = entry.pics;
    if (p) {
      var showed = false;
      if (p.status === 'changed') showed = comparePictures(p);
      if (!showed && nowOf(p)) {
        singlePicture(p, entry.name);
        showed = true;
      }
      if (showed) {
        nameTheShot(entry.name);
        sayOutcome(entry.tone, outcomeShort(p));
        markShowing(entry);
      }
    }
    openWork(entry);
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
    var nScreens = 0, nGuards = 0;
    for (var w = 0; w < order.length; w++) {
      if (order[w].kind === 'guard') nGuards++; else nScreens++;
    }
    ui.what.textContent = describeWork(nScreens, nGuards);
    ui.what.hidden = order.length === 0;
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
  var runOver = false;
  function stopFollowing() {
    if (!following) return;
    following = false;
    // Nothing to follow once the run has ended, so the pill would be an offer
    // to do nothing — and it sits over the list while it makes it.
    ui.follow.hidden = runOver;
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
    if (runningItem && runningItem !== entry) {
      runningItem.running = false;
      hush(runningItem);
      syncWork(runningItem);
    }
    runningItem = entry;
    entry.running = true;
    // A check that is starting again starts with an empty list, so nothing is
    // left over from the last time it ran.
    entry.checks = [];
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
      var starting = ensureItem('picture', String(ev.name || ''), ev.describe);
      markRunning(starting);
      // The working area clears and takes this screen's name, so the list that
      // ticks off from here is unmistakably about the screen being checked now.
      openWork(starting, true);
      scanning(true);
      return;
    }

    // One thing, the moment it happens. This is the whole point of the panel:
    // the names of what is being checked right now, each taking its mark as it
    // settles, instead of a table that lands when it is already over.
    if (type === 'screen:step' || type === 'guard:step') {
      sawSteps = true;
      var stepKind = type === 'guard:step' ? 'guard' : 'picture';
      var stepping = ensureItem(stepKind, String(ev.name || ''), ev.describe);
      applyStep(stepping, ev.step);
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
        // And what was actually done to it, in the list beside the picture,
        // while the person is looking at it.
        openWork(done);
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
      var guarding = ensureItem('guard', String(ev.name || ''), ev.describe);
      markRunning(guarding);
      // Guards have working too: the claims this one makes, ticking off as
      // each is checked. Shown the same way a screen's steps are.
      openWork(guarding, true);
      return;
    }

    if (type === 'guard:done') {
      finish(ensureItem('guard', String(ev.name || ''), ev.describe), 'guard', ev);
      tint(worstTone());
      return;
    }

    if (type === 'run:done') {
      // Nothing is happening any more, so nothing may still say it is.
      for (var q = 0; q < order.length; q++) {
        order[q].running = false;
        hush(order[q]);
        syncWork(order[q]);
      }
      runningItem = null;
      runOver = true;
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
    // What was actually done to this check. The list that comes with the
    // verdict is the one that is right — a watcher that opened halfway through,
    // or missed an event, ends up correct here whatever it saw on the way.
    entry.running = false;
    if (Array.isArray(ev.checks)) adopt(entry, ev.checks);
    // Anything the run left mid-flight stops looking like it is still going.
    hush(entry);
    // And a guard that broke shows the claim it broke on, under every claim
    // that held before it.
    if (kind === 'guard' && ev.status === 'failed') markFailedClaim(entry, ev.failedAt);
    entry.outText = outcomeText(kind, ev);
    if (entry.verdict) entry.verdict.textContent = shortOutcome(kind, ev);
    entry.failedAt = (kind === 'guard' && ev.status === 'failed' && ev.failedAt) ? ev.failedAt : '';
    entry.story = (kind === 'guard' && ev.status === 'failed' && ev.because) ? ev.because : '';
    if (typeof ev.durationMs === 'number') tweenTo(entry.time, ev.durationMs, fmt);
    entry.tone = tone;
    redraw(entry);
    syncWork(entry);
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
      // this event was, the next one still has to land. It is still said out
      // loud where anyone would look for it — a panel that swallows its own
      // mistakes in silence is a panel nobody can mend.
      if (window.console && console.error) console.error('stays fixed: ' + (err && err.message ? err.message : err));
    }
  };

  // Called when the run lets go of the window, so the clock does not tick on
  // forever next to a result that is already final.
  window.__staysfixed_detach = function () {
    stopClock();
    scanning(false);
    if (runningItem) {
      runningItem.running = false;
      hush(runningItem);
      syncWork(runningItem);
    }
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
