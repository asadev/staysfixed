/**
 * The window that shows a product being proved unchanged.
 *
 * Version 1 photographed screens and compared pixels, and its panel showed exactly that: a
 * picture, a list of screens, a tick against each one. Version 2 is a different tool, so this
 * is a different window. It has different things to say.
 *
 *   WHAT IS BEING CHECKED, AND ON WHAT. One repository can build five products through five
 *   toolchains, and a change in shared code breaks the phone. So the walk is grouped by
 *   surface — a website, a desktop app, a phone in a simulator, a command-line tool, a server —
 *   and every journey says which one it is on.
 *
 *   THE REFERENCE, AND HOW GOOD IT IS. The build he last shipped, walked live on this machine
 *   in this minute, or the weaker fallback of a record stored the last time the old build ran.
 *   When it is the weaker one this window says so where it cannot be missed. A tool admitting
 *   it is less certain than usual is worth more than a tool that looks confident.
 *
 *   THE WOBBLE. How many addresses this build cannot answer the same way twice, measured by
 *   running it twice rather than guessed at with a tolerance, and subtracted arithmetically.
 *   It is the number that explains why the tool is quiet, and no other tool has it, so it gets
 *   a card of its own rather than a line in a log.
 *
 *   WHAT SURVIVED. Findings, ranked, worst first, clustered. One finding can stand for five
 *   hundred differences: the count is shown, the five hundred are not.
 *
 *   WHAT WAS NOT CHECKED. In counts and named gaps, never a percentage — a percentage invites
 *   a target and a target invites gaming. A green run on a product with hundreds of unopened
 *   doors says so in the same breath as the good news.
 *
 *   WHAT NEEDS A PERSON. The sealed classes an agent may never wave through, and nothing else.
 *
 * Two rules hold the shape of it, and both come straight from the owner.
 *
 *   IT MUST NEVER TAKE THE SCREEN. It opens, it sits there, and it never asks for attention it
 *   has not earned. Nothing here brings itself to the front, and minimising it changes nothing
 *   about the check: the run does not wait for a window, does not slow down without one, and
 *   does not notice when one goes away.
 *
 *   IT MUST LOOK LIKE THE ONE HE PICKED. Near-monochrome on a neutral black ground, flat
 *   surfaces, hairlines, small radii, no shadows and no tint. Colour only where something needs
 *   a person: green held, red broke, amber doubtful, sky blue waiting on you, and grey for what
 *   never ran. Monospace for names, numbers and commands. Everything switched off for anyone
 *   who has asked their computer for less movement.
 *
 * The document is self-contained: no address of any kind, no font downloaded, no framework, no
 * build step. Everything it will ever need is in the string this file returns. The one thing it
 * does load from outside is evidence — a picture, a before-and-after — and only when somebody
 * asks for it, off the local disk, because in version 2 pictures are the seventh channel and
 * the last one.
 */

import { SURFACE_WORDS, SOURCE_WORDS, surfaceWord } from './events.js';

/** @typedef {import('./events.js').PanelPlanShape} PanelPlan */
/** @typedef {import('./events.js').PanelJourney} PanelJourney */

/**
 * Text that is safe to put inside an element.
 *
 * Small and local on purpose: this file is the whole window, and a window that cannot be
 * rendered because a helper moved is not worth the shared line of code.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * JSON safe to sit inside a script tag. A closing tag inside a string would end the tag early
 * and leave half the plan on the page as text, so the one character that can do that never
 * survives.
 * @param {unknown} value
 * @returns {string}
 */
function embedJson(value) {
  return JSON.stringify(value ?? null).replace(/</g, '\\u003c');
}

/**
 * Keep only what the window draws, and only in shapes it can trust.
 * @param {PanelJourney[]|undefined} list
 * @returns {PanelJourney[]}
 */
function tidyJourneys(list) {
  if (!Array.isArray(list)) return [];
  /** @type {PanelJourney[]} */
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name ?? '').trim();
    if (!name) continue;
    out.push({
      name,
      describe: item.describe ? String(item.describe) : undefined,
      surface: item.surface,
      surfaceWord: item.surfaceWord ? String(item.surfaceWord) : undefined,
      source: item.source ? String(item.source) : undefined,
      sourceWord: item.sourceWord ? String(item.sourceWord) : undefined,
      skip: item.skip ? String(item.skip) : undefined,
    });
  }
  return out;
}

/**
 * The reference, in the one shape the window draws, whatever the host had to hand.
 *
 * @param {PanelPlan} plan
 * @returns {import('./events.js').PanelReference|null}
 */
function tidyReference(plan) {
  const given = plan.reference;
  const weak = plan.mode === 'stored-record';
  if (given && typeof given === 'object') {
    return { ...given, weak: given.weak ?? weak, warning: given.warning ?? plan.modeWarning };
  }
  const sentence = typeof given === 'string' ? given.trim() : '';
  if (!sentence && !plan.mode) return null;
  // The sentence is the explanation, never also the name: printing the same words twice, once
  // in the monospace and once underneath, reads as a mistake rather than as emphasis.
  return {
    name: weak ? 'a stored record' : 'the build you last shipped',
    mode: plan.mode ?? 'paired',
    weak,
    how: sentence,
    warning: plan.modeWarning,
  };
}

/**
 * The mark. A padlock with a tick inside it: the whole product in one shape — the thing that
 * was already fixed is still shut. Monoline, drawn on the 24 grid, inheriting its colour so it
 * can never fight the theme. No namespace attribute: inline SVG in an HTML document does not
 * need one, and this page is not allowed to name an address of any kind.
 */
const MARK = [
  '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor"',
  ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
  '<rect x="4.2" y="10" width="15.6" height="10.4" rx="3.6"></rect>',
  '<path d="M8.1 10V7.9a3.9 3.9 0 0 1 7.8 0V10"></path>',
  '<path d="M9.7 15.2l1.8 1.9 2.9-3.5"></path>',
  '</svg>',
].join('');

/** A cross: put the evidence away. */
const CLOSE = [
  '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor"',
  ' stroke-width="1.7" stroke-linecap="round" aria-hidden="true">',
  '<path d="M7 7l10 10M17 7L7 17"></path>',
  '</svg>',
].join('');

/**
 * The whole panel document.
 *
 * @param {PanelPlan} [plan]
 * @returns {string}
 */
export function panelHtml(plan = {}) {
  const product = String(plan.product ?? '').trim() || 'this product';
  const project = String(plan.project ?? '').trim();
  const journeys = tidyJourneys(plan.journeys);

  /** @type {string[]} */
  const surfaces = [];
  for (const word of plan.surfaces ?? []) {
    const clean = String(word ?? '').trim();
    if (clean && !surfaces.includes(clean)) surfaces.push(clean);
  }
  // A check that walks exactly one surface can just name it, rather than building a list of one.
  if (plan.surface) {
    const one = surfaceWord(String(plan.surface));
    if (!surfaces.includes(one)) surfaces.push(one);
  }
  for (const j of journeys) {
    if (j.surfaceWord && !surfaces.includes(j.surfaceWord)) surfaces.push(j.surfaceWord);
  }

  // The reference, however the host has it. A whole shape is drawn in full; a bare sentence is
  // shown as the sentence, and is treated as the weaker kind whenever the mode says so —
  // a run measured against a stored record must never look like the strong one.
  const reference = tidyReference(plan);

  // Dark unless somebody asks otherwise. This window opens on a brand new browser profile, and
  // a fresh profile insists the computer is in light mode however it is really set — so the
  // look is stated rather than sniffed.
  const wanted = String(plan.theme ?? 'dark');
  const themeAttr = wanted === 'light' || wanted === 'system' ? wanted : 'dark';

  const embedded = embedJson({
    product,
    project,
    journeys,
    surfaces,
    reference,
    words: SURFACE_WORDS,
    sources: SOURCE_WORDS,
  });

  const subtitle = surfaces.length ? surfaces.join(' · ') : '';

  return [
    '<!doctype html>',
    `<html lang="en" data-theme="${themeAttr}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // Just the name of the thing, because this string IS the window's title bar.
    '<title>Stays Fixed</title>',
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<div class="aura" aria-hidden="true"></div>',
    '<div class="panel">',

    // --- the header: whose window this is, and where the check has got to ---
    '<header class="top">',
    '<div class="brand">',
    `<span class="badge">${MARK}</span>`,
    '<span class="wordmark">Stays Fixed</span>',
    '<span class="elapsed mono" id="clock">0.0s</span>',
    '</div>',
    `<p class="target"><span class="mono" id="product">${escapeHtml(product)}</span>`,
    `<span class="sep" id="targetsep"${subtitle ? '' : ' hidden'}>&#183;</span>`,
    `<span class="app" id="surfaces"${subtitle ? '' : ' hidden'}>${escapeHtml(subtitle)}</span></p>`,
    // The one sentence a person reads from four feet away.
    '<p class="state" id="state">getting ready</p>',
    '<p class="what" id="what"></p>',
    '<div class="meter">',
    '<div class="track" id="track"><div class="fill" id="fill"></div></div>',
    '<span class="counts mono" id="counts"></span>',
    '</div>',
    '</header>',

    '<div class="scroll" id="scroll">',

    // --- what this is being measured against, and how good that is ---------
    //
    // High on the page and never folded away. Everything below it is only worth what this
    // line says it is worth, and a run compared against a stored record is worth less.
    '<section class="reference" id="refstrip" hidden>',
    '<div class="refrow">',
    '<span class="refdot" id="refdot" aria-hidden="true"></span>',
    '<p class="reflabel">Measured against</p>',
    '<span class="refname mono" id="refname"></span>',
    '</div>',
    '<p class="refhow" id="refhow"></p>',
    '<p class="refwarn" id="refwarn" hidden></p>',
    '</section>',

    // --- the walk, live ----------------------------------------------------
    '<section class="group" id="groupWalk" hidden>',
    '<p class="grouplabel"><span class="glabel">The walk</span><span class="gcount mono" id="countWalk"></span></p>',
    '<div id="surfaceList"></div>',
    '</section>',

    // --- the wobble --------------------------------------------------------
    '<section class="group" id="groupWobble" hidden>',
    '<p class="grouplabel"><span class="glabel">This build against itself</span></p>',
    '<div class="card">',
    '<div class="figures">',
    '<div class="figure" id="wSteadyWrap"><b class="mono" id="wSteady">0</b><span>answered the same way twice</span></div>',
    '<div class="figure doubt" id="wUnstableWrap"><b class="mono" id="wUnstable">0</b><span>would not sit still &#8212; subtracted, not counted</span></div>',
    '<div class="figure doubt" id="wNewWrap" hidden><b class="mono" id="wNew">0</b><span>were steady before this change and wobble now</span></div>',
    '</div>',
    '<p class="cardnote" id="wobbleNote"></p>',
    '<ul class="paths mono" id="wobblePaths" hidden></ul>',
    '</div>',
    '</section>',

    // --- what survived -----------------------------------------------------
    '<section class="group" id="groupFindings" hidden>',
    '<p class="grouplabel"><span class="glabel">What survived</span><span class="gcount mono" id="countFindings"></span></p>',
    '<div class="items" id="findingList"></div>',
    '</section>',

    // --- what was not checked ----------------------------------------------
    '<section class="group" id="groupCoverage" hidden>',
    '<p class="grouplabel"><span class="glabel">What was not checked</span></p>',
    '<div class="card">',
    '<div class="figures" id="covFigures"></div>',
    '<p class="cardnote" id="covNote"></p>',
    '<ul class="gaps" id="gapList"></ul>',
    '<p class="cardnote" id="gapMore" hidden></p>',
    '</div>',
    '</section>',

    '<p class="nothing" id="nothing">Nothing has been walked yet.<br>The window fills in as the check runs.</p>',
    '</div>',

    // --- the only thing that ever reaches a person -------------------------
    '<footer class="foot" id="footer" hidden>',
    '<p class="nextlabel">Needs a person</p>',
    '<div id="needs"></div>',
    '<p class="footwhy">No agent is allowed to wave these through.</p>',
    '</footer>',

    '</div>',

    // --- evidence, fetched rather than pushed -------------------------------
    //
    // Version 2 is mostly not about pictures, so nothing here loads until somebody asks. The
    // address is a local file the run has already written; the window opens it at full size.
    '<div class="viewer" id="viewer" hidden>',
    '<header class="vtop">',
    '<span class="vname mono" id="vname"></span>',
    `<button class="vclose" id="vclose" type="button" aria-label="close the evidence">${CLOSE}</button>`,
    '</header>',
    '<div class="vstage" id="vstage"><img class="vimg" id="vimg" alt="evidence for this finding"></div>',
    '<p class="vhelp">esc to close</p>',
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
   Tokens — graphite and signal. Taken from the panel the owner picked, whole.

   The page is graphite. Ground, cards and every piece of furniture on them are
   one family of greys, separated only by how much light they carry and by a
   hairline where two of them meet. Type does the rest: one monospace for names
   and numbers, one text face for sentences, one scale of six sizes.

   Colour is not decoration and it is not a mood. It is reserved for the things
   a person has to be told: something BROKE, something is DOUBTFUL, something is
   WAITING for them. A check that held wears green because a person scanning a
   list wants to SEE that it held rather than infer it from an absence. Grey is
   only for what never ran.
   -------------------------------------------------------------------------- */
:root {
  color-scheme: dark;

  /* Neutral black. No warm cast, no cool cast. */
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
  --doubt: #e8b85c;

  --line: rgba(255, 255, 255, 0.055);
  --line-firm: rgba(255, 255, 255, 0.17);
  --shadow: rgba(0, 0, 0, 0.5);

  /* The brand mark, the thing that is running, and whatever wants a person are
     all this one colour — so on a page that is otherwise grey, this means you. */
  --accent: #4fb3f0;
  --held: #25d366;
  --broke: #ff4438;
  --wait: #4fb3f0;
  --moved: #ffc24d;

  --resting: rgba(255, 255, 255, 0.09);
  --running: var(--accent);

  --radius: 10px;
  --radius-sm: 8px;
  --radius-xs: 6px;

  --pad: 16px;
  --tint: var(--accent);

  --t-label: 10px;
  --t-meta: 10.5px;
  --t-small: 11px;
  --t-body: 11.5px;
  --t-name: 12px;
  --t-fig: 21px;
  --t-lead: 18px;

  --ease: cubic-bezier(0.22, 0.72, 0.24, 1);
  --quick: 170ms;
  --calm: 260ms;
  --slow: 320ms;
}
/*
 * Light is opt-in. This window opens on a brand new browser profile, and a fresh profile
 * answers "prefers-color-scheme" with "light" whatever the computer around it is set to —
 * so the look is stated on the html element rather than sniffed. The same rock lit from the
 * other side: a stone ground, cards a shade brighter than it, the signal colours taken down
 * until they hold on paper.
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
  --doubt: #8a5f06;

  --line: rgba(20, 22, 26, 0.11);
  --line-firm: rgba(20, 22, 26, 0.24);
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
/* The terminal character of the thing: every name, number and address is set in
   the monospace, and nothing else is. */
.mono, code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-variant-numeric: tabular-nums;
}
p, h2, ul { margin: 0; }
ul { padding: 0; list-style: none; }
img { display: block; }
button { font: inherit; color: inherit; }
.glyph { width: 16px; height: 16px; flex: 0 0 auto; }

/* One light above, one shadow below, and the tint of the worst thing that has
   happened — which on a run where nothing broke is no colour at all. */
.aura {
  position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background:
    radial-gradient(126% 42% at 50% -12%, color-mix(in srgb, var(--tint) 12%, transparent), transparent 70%),
    radial-gradient(128% 56% at 50% 116%, var(--shadow), transparent 62%);
  transition: background 620ms var(--ease);
}

.panel { position: relative; z-index: 1; display: flex; flex-direction: column; height: 100%; }

/* --- header -------------------------------------------------------------- */
.top {
  flex: 0 0 auto;
  padding: 16px var(--pad) 15px;
  background: var(--glass);
  backdrop-filter: blur(22px) saturate(120%);
  -webkit-backdrop-filter: blur(22px) saturate(120%);
  box-shadow: 0 1px 0 var(--line);
}
.brand { display: flex; align-items: center; gap: 9px; }
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
  margin-top: 13px; font-size: var(--t-name);
  white-space: nowrap; overflow: hidden;
}
.target .mono { color: var(--ink); flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
.target .sep { color: var(--faintest); flex: 0 0 auto; }
.target .app {
  color: var(--faint); flex: 1 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; font-size: var(--t-body);
}

/* The sentence. The largest text on the page, because it is the one thing read
   from four feet away. It stays white; a mark in front of it carries the news. */
.state {
  margin-top: 10px;
  font-size: var(--t-lead); font-weight: 600; line-height: 1.3;
  letter-spacing: -0.014em; overflow-wrap: anywhere;
  transition: color var(--slow) var(--ease);
}
.state.moved::before, .state.wait::before, .state.broke::before {
  content: ''; display: inline-block;
  width: 10px; height: 10px; border-radius: 50%;
  margin-right: 13px; vertical-align: 0.1em;
}
.state.moved::before { background: var(--moved); box-shadow: 0 0 0 5px color-mix(in srgb, var(--moved) 17%, transparent); }
.state.wait::before {
  background: var(--wait);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--wait) 42%, transparent), 0 0 0 5px color-mix(in srgb, var(--wait) 12%, transparent);
}
.state.broke::before {
  background: var(--broke); border-radius: 2px; transform: rotate(45deg);
  box-shadow: 0 0 0 5px color-mix(in srgb, var(--broke) 17%, transparent);
}
.state.arrive { animation: arrive 340ms var(--ease) both; }
@keyframes arrive {
  from { opacity: 0; transform: translateY(7px); filter: blur(4px); }
  to { opacity: 1; transform: none; filter: blur(0); }
}
.what { margin: 7px 0 0; font-size: var(--t-small); color: var(--faint); line-height: 1.5; overflow-wrap: anywhere; }

/* One hairline, not a row of blocks: each journey adds its own slice, so
   progress and outcome are the same object. A walk where everything held ends
   as one unbroken green rule. */
.meter { display: flex; align-items: center; gap: 10px; margin-top: 15px; }
.track { flex: 1 1 auto; min-width: 0; height: 4px; border-radius: 999px; background: var(--resting); overflow: hidden; }
.fill { display: flex; height: 100%; width: 100%; }
.slice {
  min-width: 0; height: 100%; background: var(--resting);
  transition: background var(--slow) var(--ease), flex-grow var(--slow) var(--ease);
}
.slice.held { background: var(--held); }
.slice.moved { background: var(--moved); }
.slice.broke { background: var(--broke); }
.slice.wait { background: var(--wait); }
.slice.running { background: var(--accent); animation: breathe 1.9s var(--ease) infinite; }
@keyframes breathe { 0%, 100% { opacity: 0.34; } 50% { opacity: 1; } }
.counts {
  flex: 0 1 auto; min-width: 0; max-width: 68%;
  font-size: var(--t-meta); color: var(--faint); letter-spacing: 0.02em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* --- the scrolling body -------------------------------------------------- */
.scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 0 var(--pad) 18px; }
.scroll::-webkit-scrollbar { width: 9px; }
.scroll::-webkit-scrollbar-thumb { background: var(--resting); border-radius: 999px; }
.scroll::-webkit-scrollbar-track { background: transparent; }

.group { margin-top: 18px; }
.grouplabel {
  display: flex; align-items: baseline; gap: 8px;
  margin-bottom: 8px; padding: 0 2px;
  font-size: var(--t-label); font-weight: 600;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--faint);
}
.grouplabel .glabel { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.grouplabel .gcount { flex: 0 0 auto; font-weight: 500; letter-spacing: 0.02em; text-transform: none; color: var(--faintest); }

/* --- the reference ------------------------------------------------------- */
/* Quiet when the old build was booted live on this machine in this minute.
   Loud, in amber, when it was not — a run measured against a stored record is
   genuinely weaker, and it must never look like the strong one. */
.reference {
  margin-top: 16px; padding: 12px 14px;
  border-radius: var(--radius);
  background: var(--card);
  box-shadow: inset 0 0 0 1px var(--line);
  transition: box-shadow var(--calm) var(--ease), background var(--calm) var(--ease);
}
.reference.weak {
  background: color-mix(in srgb, var(--doubt) 7%, transparent);
  box-shadow: inset 3px 0 0 var(--doubt), inset 0 0 0 1px var(--line);
}
.refrow { display: flex; align-items: center; gap: 9px; }
.refdot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--held); }
.reference.weak .refdot { background: var(--doubt); box-shadow: 0 0 0 4px color-mix(in srgb, var(--doubt) 17%, transparent); }
.reflabel {
  flex: 0 0 auto; font-size: var(--t-label); font-weight: 600;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--faint);
}
.refname {
  flex: 1 1 auto; min-width: 0; text-align: right;
  font-size: var(--t-name); color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.refhow { margin-top: 7px; font-size: var(--t-body); color: var(--faint); line-height: 1.55; }
.refwarn { margin-top: 8px; font-size: var(--t-name); color: var(--ink); font-weight: 560; line-height: 1.5; }

/* --- surfaces and journeys ----------------------------------------------- */
/* A repository builds a website and a phone app and a command-line tool at
   once. Grouping the walk by surface is the difference between a list of names
   and a picture of what is being proved. */
.surface + .surface { margin-top: 12px; }
.surfacehead {
  display: flex; align-items: baseline; gap: 8px;
  padding: 0 3px 6px;
}
.surfacename { flex: 0 0 auto; font-size: var(--t-name); font-weight: 600; color: var(--soft); }
.surfacenote {
  flex: 1 1 auto; min-width: 0; text-align: right;
  font-size: var(--t-meta); color: var(--faintest);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.items { border-radius: var(--radius); background: var(--card); overflow: hidden; box-shadow: inset 0 0 0 1px var(--line); }
.item + .item { box-shadow: inset 0 1px 0 var(--line); }
.item { transition: background var(--calm) var(--ease); }
.item.running { background: color-mix(in srgb, var(--accent) 4%, transparent); }
.item.attention { background: color-mix(in srgb, var(--tone, var(--accent)) 3.5%, transparent); }
.item.attention .row { box-shadow: inset 2px 0 0 var(--tone, var(--accent)); }
.item.fresh { animation: settle 300ms var(--ease) both; }
@keyframes settle { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: none; } }

.row {
  display: flex; align-items: center; gap: 11px;
  width: 100%; min-height: 42px; padding: 9px 13px;
  text-align: left; background: transparent; border: 0; cursor: pointer;
  transition: background var(--quick) var(--ease);
}
.row:hover { background: var(--card-hover); }
.row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.item.plain .row { cursor: default; }
.item.plain .row:hover { background: transparent; }

/* Five states, five silhouettes, five rungs of a lightness ladder — readable
   with no colour vision at all:
     nobody ran it   a hollow ring, barely there
     it held         a plain green disc
     it is waiting   a disc inside a crisp ring
     it is doubtful  a disc in a soft wide halo
     it broke        a diamond in a soft wide halo */
.dot {
  flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%;
  background: transparent; box-shadow: inset 0 0 0 1.5px var(--resting);
  transition: background var(--calm) var(--ease), box-shadow var(--calm) var(--ease);
}
.item.held .dot { width: 7px; height: 7px; background: var(--held); box-shadow: none; }
.item.wait .dot {
  background: var(--wait);
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--wait) 42%, transparent), 0 0 0 4px color-mix(in srgb, var(--wait) 12%, transparent);
}
.item.moved .dot { background: var(--moved); box-shadow: 0 0 0 4px color-mix(in srgb, var(--moved) 17%, transparent); }
.item.broke .dot {
  background: var(--broke); border-radius: 2px; transform: rotate(45deg);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--broke) 17%, transparent);
}
.item.running .dot {
  background: transparent; box-shadow: inset 0 0 0 2px var(--accent);
  animation: ping 1.8s var(--ease) infinite;
}
@keyframes ping {
  0% { box-shadow: inset 0 0 0 2px var(--accent), 0 0 0 0 color-mix(in srgb, var(--accent) 34%, transparent); }
  70%, 100% { box-shadow: inset 0 0 0 2px var(--accent), 0 0 0 7px color-mix(in srgb, var(--accent) 0%, transparent); }
}

.rname {
  flex: 1 1 auto; min-width: 0;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: var(--t-name); color: var(--ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.item.pending .rname { color: var(--faint); }
.item.running .rname, .item.held .rname { color: var(--ink); }
/* The address count, ticking up while a journey walks. On a run where nothing
   is wrong this is the only thing moving, and it is the proof that anything is
   happening at all. */
.rcount {
  flex: 0 0 auto; font-size: var(--t-meta); color: var(--faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums;
}
.rtime { flex: 0 0 auto; margin-left: 2px; font-size: var(--t-meta); color: var(--faintest);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
.row .chev { flex: 0 0 auto; width: 14px; height: 14px; color: var(--faintest); opacity: 0;
  transition: transform var(--calm) var(--ease), opacity var(--quick) var(--ease); }
.row:hover .chev, .item.open .chev { opacity: 1; }
.item.open .chev { transform: rotate(180deg); }
.item.plain .chev { display: none; }

.detail { padding: 0 14px 12px 32px; font-size: var(--t-body); line-height: 1.6; overflow-wrap: anywhere; }
.item.open .detail { animation: unfold 240ms var(--ease) both; }
@keyframes unfold { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.detail .why { color: var(--faint); }
.detail .out { color: var(--soft); margin-top: 4px; }
.detail .meta { margin-top: 6px; font-size: var(--t-meta); color: var(--faintest); }

/* --- cards: the wobble and the coverage ---------------------------------- */
.card { border-radius: var(--radius); background: var(--card); box-shadow: inset 0 0 0 1px var(--line); padding: 14px; }
.figures { display: flex; flex-wrap: wrap; gap: 14px 20px; }
.figure { flex: 1 1 120px; min-width: 110px; }
.figure b {
  display: block; font-size: var(--t-fig); font-weight: 600; line-height: 1.15;
  letter-spacing: -0.02em; color: var(--ink);
}
.figure span { display: block; margin-top: 3px; font-size: var(--t-small); color: var(--faint); line-height: 1.45; }
/* An amber number only when there is something amber to say. A wobble of zero
   is not doubtful, it is excellent, so it is not coloured. */
.figure.doubt.on b { color: var(--doubt); }
.figure.wait.on b { color: var(--wait); }
.cardnote { margin-top: 12px; font-size: var(--t-body); color: var(--faint); line-height: 1.55; }
.paths { margin-top: 10px; }
.paths li {
  padding: 4px 0 4px 11px; box-shadow: inset 1px 0 0 var(--line);
  font-size: var(--t-meta); color: var(--faint);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* --- what was not checked ------------------------------------------------ */
.gaps { margin-top: 12px; }
.gap { padding: 9px 0 9px 12px; box-shadow: inset 1.5px 0 0 var(--resting); }
.gap + .gap { margin-top: 2px; }
.gapwhat { font-size: var(--t-name); color: var(--soft); line-height: 1.5; }
.gapwhy { margin-top: 2px; font-size: var(--t-body); color: var(--faintest); line-height: 1.5; }
/* What would fix it, in the words an agent can act on without being taught.
   Blue, because it is the one thing on the card that is waiting on somebody. */
.gapfix { margin-top: 4px; font-size: var(--t-body); color: var(--wait); line-height: 1.5; }
/* Some holes are permanent and deliberate — money is watched at the call and never at the
   effect, and always will be. Painting that blue would offer somebody an action that does
   not exist. */
.gapfix.permanent { color: var(--faintest); }
.gapdoors { margin-left: 6px; font-size: var(--t-meta); color: var(--faintest); }

/* --- findings ------------------------------------------------------------ */
.fclass {
  flex: 0 0 auto; padding: 2px 7px; border-radius: 999px;
  font-size: var(--t-label); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--faint); box-shadow: inset 0 0 0 1px var(--line-firm);
}
.item.sealed .fclass { color: var(--wait); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--wait) 45%, transparent); }
.item.broke .fclass { color: var(--broke); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--broke) 45%, transparent); }
.ftitle {
  flex: 1 1 auto; min-width: 0; font-size: var(--t-name); color: var(--ink);
  line-height: 1.45; font-weight: 560;
}
/* One finding can stand for five hundred differences. The count is shown; the
   five hundred are not — a list nobody can read is where information hides. */
.fcount { flex: 0 0 auto; font-size: var(--t-meta); color: var(--faintest);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
.frow { align-items: flex-start; }
.frow .dot { margin-top: 5px; }
.evidence {
  margin-top: 9px; padding: 5px 11px; border: 0; border-radius: 999px;
  font-size: var(--t-body); color: var(--soft); background: var(--well);
  box-shadow: inset 0 0 0 1px var(--line); cursor: pointer;
  transition: color var(--quick) var(--ease), background var(--quick) var(--ease);
}
.evidence:hover { color: var(--ink); background: var(--card-hover); }

.nothing { padding: 30px 16px; color: var(--faint); font-size: var(--t-body); line-height: 1.8; text-align: center; }

/* --- the only thing that ever reaches a person --------------------------- */
.foot {
  flex: 0 0 auto;
  padding: 13px var(--pad) 15px;
  background: var(--glass);
  backdrop-filter: blur(22px) saturate(120%);
  -webkit-backdrop-filter: blur(22px) saturate(120%);
  border-top: 1px solid var(--line);
  animation: arrive 340ms var(--ease) both;
}
.nextlabel {
  font-size: var(--t-label); font-weight: 600; letter-spacing: 0.2em;
  text-transform: uppercase; color: var(--wait); margin-bottom: 8px;
}
.need { display: flex; align-items: flex-start; gap: 10px; padding: 5px 0; }
.need .dot {
  margin-top: 5px; background: var(--wait);
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--wait) 42%, transparent), 0 0 0 4px color-mix(in srgb, var(--wait) 12%, transparent);
}
.needtext { flex: 1 1 auto; min-width: 0; font-size: var(--t-name); color: var(--ink); line-height: 1.5; }
.needwhy { display: block; margin-top: 2px; font-size: var(--t-body); color: var(--faint); }
.footwhy { margin-top: 8px; font-size: var(--t-meta); color: var(--faintest); }

/* --- evidence, at full size ---------------------------------------------- */
.viewer {
  position: fixed; inset: 0; z-index: 20; display: flex; flex-direction: column;
  background: color-mix(in srgb, var(--ground) 92%, #000);
  animation: arrive 220ms var(--ease) both;
}
.vtop { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 11px var(--pad); border-bottom: 1px solid var(--line); }
.vname { flex: 1 1 auto; min-width: 0; font-size: var(--t-name); color: var(--soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vclose {
  flex: 0 0 auto; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
  color: var(--soft); background: transparent; border: 0; border-radius: var(--radius-xs); cursor: pointer;
}
.vclose:hover { color: var(--ink); background: var(--card-hover); }
.vstage { flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 14px; overflow: auto; }
.vimg { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: var(--radius-xs); }
.vhelp { flex: 0 0 auto; padding: 0 var(--pad) 12px; text-align: center; font-size: var(--t-meta); color: var(--faintest); }

/* Two columns when the window is dragged wide. The walk on the left, what came
   out of it on the right. */
@media (min-width: 900px) {
  .scroll { display: grid; grid-template-columns: 1fr 1fr; gap: 0 26px; align-content: start; }
  #refstrip { grid-column: 1 / -1; }
  #groupWalk { grid-column: 1; }
  #groupWobble { grid-column: 1; }
  #groupFindings { grid-column: 2; }
  #groupCoverage { grid-column: 2; }
  #nothing { grid-column: 1 / -1; }
}

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
`;

const SCRIPT = `
(function () {
  'use strict';

  // This page only ever runs in the window Stays Fixed just opened, so there is no
  // compatibility question to answer and nothing to load.

  var plan = { product: '', project: '', journeys: [], surfaces: [], reference: null, words: {}, sources: {} };
  try {
    var blob = document.getElementById('staysfixed-plan');
    if (blob && blob.textContent) plan = JSON.parse(blob.textContent) || plan;
  } catch (err) {
    // A plan we cannot read costs the opening list, not the window. Rows still appear one
    // by one as the check reaches them.
  }

  function el(id) { return document.getElementById(id); }

  var ui = {
    clock: el('clock'), product: el('product'), surfaces: el('surfaces'), targetsep: el('targetsep'),
    state: el('state'), what: el('what'), track: el('track'), fill: el('fill'), counts: el('counts'),
    refstrip: el('refstrip'), refname: el('refname'), refhow: el('refhow'), refwarn: el('refwarn'),
    groupWalk: el('groupWalk'), surfaceList: el('surfaceList'), countWalk: el('countWalk'),
    groupWobble: el('groupWobble'), wSteady: el('wSteady'), wUnstable: el('wUnstable'),
    wUnstableWrap: el('wUnstableWrap'), wNew: el('wNew'), wNewWrap: el('wNewWrap'),
    wobbleNote: el('wobbleNote'), wobblePaths: el('wobblePaths'), wSteadyWrap: el('wSteadyWrap'),
    groupFindings: el('groupFindings'), findingList: el('findingList'), countFindings: el('countFindings'),
    groupCoverage: el('groupCoverage'), covFigures: el('covFigures'), covNote: el('covNote'),
    gapList: el('gapList'), gapMore: el('gapMore'),
    nothing: el('nothing'), scroll: el('scroll'),
    footer: el('footer'), needs: el('needs'),
    aura: document.querySelector('.aura'),
    viewer: el('viewer'), vname: el('vname'), vimg: el('vimg'), vclose: el('vclose')
  };

  var CHEVRON = '<svg class="glyph chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 10.5l3.5 3.5 3.5-3.5"></path></svg>';

  // Somebody who has asked their computer for less movement gets none of it: the CSS
  // switches every animation off, and everything animated here jumps to its final value.
  var CALM = false;
  try { CALM = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { CALM = false; }

  // -------------------------------------------------------------------------
  // Words and numbers
  // -------------------------------------------------------------------------

  function commas(n) {
    var v = Math.round(Number(n) || 0);
    if (!isFinite(v)) v = 0;
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

  function plural(n, one, many) { return (Number(n) === 1) ? one : many; }

  function text(node, value) { if (node) node.textContent = String(value == null ? '' : value); }

  function show(node, on) { if (node) node.hidden = !on; }

  function surfaceWord(surface, given) {
    if (given) return String(given);
    if (!surface) return 'Everything else';
    return (plan.words && plan.words[surface]) || String(surface);
  }

  function sourceWord(source, given) {
    if (given) return String(given);
    if (!source) return '';
    return (plan.sources && plan.sources[source]) || String(source);
  }

  // A number that counts rather than jumps. It is the one piece of movement on a clean
  // run, and it is tied to something that really happened: an address really was watched.
  function countTo(node, to) {
    if (!node) return;
    var target = Math.round(Number(to) || 0);
    if (CALM) { text(node, commas(target)); return; }
    var from = Number(node.getAttribute('data-n') || 0);
    node.setAttribute('data-n', String(target));
    if (from === target) { text(node, commas(target)); return; }
    var started = 0;
    var span = 380;
    function step(stamp) {
      if (!started) started = stamp;
      var k = Math.min(1, (stamp - started) / span);
      var eased = 1 - Math.pow(1 - k, 3);
      text(node, commas(from + (target - from) * eased));
      if (k < 1 && Number(node.getAttribute('data-n')) === target) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // -------------------------------------------------------------------------
  // The state of the window
  // -------------------------------------------------------------------------

  var startedAt = Date.now();
  var elapsedMs = 0;
  var ticking = null;
  var journeys = {};      // name -> row record
  var order = [];         // names, in the order they were first seen
  var surfaces = {};      // word -> { box, items }
  var watched = 0;
  var findings = [];
  var sealedFindings = [];
  var finished = false;
  var walkingName = '';

  function startClock() {
    if (ticking) return;
    ticking = setInterval(function () {
      if (finished) return;
      elapsedMs = Date.now() - startedAt;
      text(ui.clock, fmt(elapsedMs));
    }, 100);
  }

  function stopClock() {
    if (ticking) { clearInterval(ticking); ticking = null; }
  }

  function setState(sentence, tone) {
    if (!ui.state) return;
    ui.state.className = 'state' + (tone ? ' ' + tone : '');
    text(ui.state, sentence);
    if (!CALM) {
      ui.state.classList.remove('arrive');
      void ui.state.offsetWidth;
      ui.state.classList.add('arrive');
    }
    tintAura(tone);
  }

  // The worst thing that has happened, as the faintest wash at the top of the page. On a
  // run where nothing is wrong it is the brand colour, which is to say no news at all.
  function tintAura(tone) {
    if (!ui.aura) return;
    var map = { broke: 'var(--broke)', moved: 'var(--moved)', wait: 'var(--wait)', held: 'var(--held)' };
    ui.aura.style.setProperty('--tint', map[tone] || 'var(--accent)');
  }

  function setWhat(sentence) {
    text(ui.what, sentence || '');
    show(ui.what, !!sentence);
  }

  function updateCounts() {
    var done = 0;
    var i;
    for (i = 0; i < order.length; i++) if (journeys[order[i]].done) done++;
    var total = order.length;
    var bits = [];
    bits.push(commas(watched) + ' ' + plural(watched, 'address', 'addresses') + ' watched');
    if (total) bits.push(commas(done) + ' of ' + commas(total) + ' ' + plural(total, 'journey', 'journeys'));
    text(ui.counts, bits.join('  ·  '));
    // The header already counts the journeys. This says the thing it does not: how many
    // separate products this one repository is being proved across.
    var kinds = 0;
    for (var k in surfaces) if (Object.prototype.hasOwnProperty.call(surfaces, k)) kinds++;
    text(ui.countWalk, kinds ? commas(kinds) + ' ' + plural(kinds, 'surface', 'surfaces') : '');
  }

  // -------------------------------------------------------------------------
  // The meter: one slice per journey
  // -------------------------------------------------------------------------

  function sliceFor(record) {
    if (record.slice) return record.slice;
    var s = document.createElement('div');
    s.className = 'slice';
    s.style.flex = '1 1 0';
    if (ui.fill) ui.fill.appendChild(s);
    record.slice = s;
    return s;
  }

  function paintSlice(record, tone) {
    var s = sliceFor(record);
    s.className = 'slice' + (tone ? ' ' + tone : '');
  }

  // -------------------------------------------------------------------------
  // The walk
  // -------------------------------------------------------------------------

  function surfaceBox(word, note) {
    if (surfaces[word]) return surfaces[word];
    var box = document.createElement('section');
    box.className = 'surface';
    var head = document.createElement('div');
    head.className = 'surfacehead';
    var name = document.createElement('span');
    name.className = 'surfacename';
    name.textContent = word;
    var hint = document.createElement('span');
    hint.className = 'surfacenote';
    hint.textContent = note || '';
    head.appendChild(name);
    head.appendChild(hint);
    var items = document.createElement('div');
    items.className = 'items';
    box.appendChild(head);
    box.appendChild(items);
    if (ui.surfaceList) ui.surfaceList.appendChild(box);
    show(ui.groupWalk, true);
    show(ui.nothing, false);
    surfaces[word] = { box: box, items: items, hint: hint, count: 0 };
    return surfaces[word];
  }

  function journeyRow(name, meta) {
    if (journeys[name]) return journeys[name];
    var info = meta || {};
    var word = surfaceWord(info.surface, info.surfaceWord);
    var group = surfaceBox(word);
    group.count++;
    group.hint.textContent = commas(group.count) + ' ' + plural(group.count, 'journey', 'journeys');

    var item = document.createElement('div');
    item.className = 'item pending fresh';
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'row';

    var dot = document.createElement('span');
    dot.className = 'dot';
    var rname = document.createElement('span');
    rname.className = 'rname';
    rname.textContent = name;
    var rcount = document.createElement('span');
    rcount.className = 'rcount';
    rcount.textContent = '';
    var rtime = document.createElement('span');
    rtime.className = 'rtime';
    rtime.textContent = '';
    row.appendChild(dot);
    row.appendChild(rname);
    row.appendChild(rcount);
    row.appendChild(rtime);
    row.insertAdjacentHTML('beforeend', CHEVRON);

    var detail = document.createElement('div');
    detail.className = 'detail';
    detail.hidden = true;

    item.appendChild(row);
    item.appendChild(detail);
    group.items.appendChild(item);

    var record = {
      name: name, item: item, row: row, dot: dot, count: rcount, time: rtime,
      detail: detail, addresses: 0, done: false, slice: null, meta: info, open: false
    };
    row.addEventListener('click', function () {
      record.open = !record.open;
      detail.hidden = !record.open;
      item.classList.toggle('open', record.open);
    });
    fillJourneyDetail(record);
    journeys[name] = record;
    order.push(name);
    sliceFor(record);
    return record;
  }

  function fillJourneyDetail(record) {
    var info = record.meta || {};
    record.detail.textContent = '';
    if (info.describe) {
      var why = document.createElement('p');
      why.className = 'why';
      why.textContent = info.describe;
      record.detail.appendChild(why);
    }
    var bits = [];
    var word = surfaceWord(info.surface, info.surfaceWord);
    if (word) bits.push(word);
    var src = sourceWord(info.source, info.sourceWord);
    if (src) bits.push(src);
    if (bits.length) {
      var meta = document.createElement('p');
      meta.className = 'meta';
      meta.textContent = bits.join('  ·  ');
      record.detail.appendChild(meta);
    }
    if (info.skip) {
      var skip = document.createElement('p');
      skip.className = 'out';
      skip.textContent = 'Not walked: ' + info.skip;
      record.detail.appendChild(skip);
    }
    record.row.parentNode.classList.toggle('plain', !record.detail.childNodes.length);
  }

  function markJourney(record, tone, attention) {
    var cls = 'item ' + tone;
    if (attention) cls += ' attention';
    if (record.open) cls += ' open';
    record.item.className = cls;
    if (tone === 'moved' || tone === 'broke' || tone === 'wait') {
      record.item.style.setProperty('--tone', 'var(--' + tone + ')');
    } else {
      record.item.style.removeProperty('--tone');
    }
    record.tone = tone;
    paintSlice(record, tone === 'running' ? 'running' : tone);
  }

  // -------------------------------------------------------------------------
  // The events
  // -------------------------------------------------------------------------

  function handle(ev) {
    switch (ev.type) {
      case 'plan': return onPlan(ev);
      case 'check:start': return onStart(ev);
      case 'reference': return onReference(ev);
      case 'journey:start': return onJourneyStart(ev);
      case 'journey:addresses': return onAddresses(ev);
      case 'journey:done': return onJourneyDone(ev);
      case 'wobble': return onWobble(ev);
      case 'suspicion': case 'proof:start': case 'proof:done': case 'cluster': case 'note':
        return onNote(ev);
      case 'finding': return onFinding(ev);
      case 'coverage': return onCoverage(ev);
      case 'check:done': return onDone(ev);
      default: return undefined;   // not our vocabulary, and not an error either
    }
  }

  function onPlan(ev) {
    var next = ev.plan || {};
    if (next.product) { text(ui.product, next.product); plan.product = next.product; }
    if (next.words) plan.words = next.words;
    if (next.sources) plan.sources = next.sources;
    var list = next.journeys || [];
    for (var i = 0; i < list.length; i++) {
      var row = journeyRow(list[i].name, list[i]);
      row.meta = list[i];
      fillJourneyDetail(row);
    }
    if (next.surfaces && next.surfaces.length) {
      text(ui.surfaces, next.surfaces.join(' · '));
      show(ui.surfaces, true);
      show(ui.targetsep, true);
    }
    updateCounts();
  }

  function onStart(ev) {
    startedAt = Date.now() - (Number(ev.at) || 0);
    startClock();
    setState(ev.message || 'Checking that nothing which already worked has changed.', '');
  }

  function onReference(ev) {
    var r = ev.reference;
    show(ui.refstrip, true);
    if (!r) {
      text(ui.refname, '');
      text(ui.refhow, ev.message || '');
      show(ui.refwarn, false);
      return;
    }
    text(ui.refname, r.name || '');
    text(ui.refhow, r.how || '');
    ui.refstrip.classList.toggle('weak', !!r.weak);
    if (r.weak && r.warning) {
      text(ui.refwarn, r.warning);
      show(ui.refwarn, true);
    } else {
      show(ui.refwarn, false);
    }
  }

  function onJourneyStart(ev) {
    if (!ev.journey) return;
    var record = journeyRow(ev.journey, ev);
    if (ev.describe || ev.surface || ev.source) {
      record.meta = { describe: ev.describe || (record.meta || {}).describe,
                      surface: ev.surface || (record.meta || {}).surface,
                      surfaceWord: ev.surfaceWord || (record.meta || {}).surfaceWord,
                      source: ev.source || (record.meta || {}).source,
                      sourceWord: ev.sourceWord || (record.meta || {}).sourceWord };
      fillJourneyDetail(record);
    }
    walkingName = ev.journey;
    markJourney(record, 'running');
    setState(ev.message || ('Walking ' + ev.journey + '.'), '');
    var where = [];
    if (ev.index && ev.total) where.push('journey ' + ev.index + ' of ' + ev.total);
    if (ev.run === 'a') where.push('first pass');
    if (ev.run === 'b') where.push('second pass of the same build, to measure its own wobble');
    if (ev.run === 'single') where.push('the old build, booted live');
    setWhat(where.join('  ·  '));
    updateCounts();
  }

  function onAddresses(ev) {
    if (!ev.journey) return;
    var record = journeys[ev.journey] || journeyRow(ev.journey, ev);
    record.addresses = Number(ev.count) || 0;
    text(record.count, commas(record.addresses));
    if (typeof ev.watched === 'number') watched = ev.watched;
    updateCounts();
  }

  function onJourneyDone(ev) {
    if (!ev.journey) return;
    var record = journeys[ev.journey] || journeyRow(ev.journey, ev);
    record.addresses = Number(ev.count) || record.addresses;
    record.done = true;
    text(record.count, commas(record.addresses));
    if (ev.durationMs) text(record.time, fmt(ev.durationMs));
    if (typeof ev.watched === 'number') watched = ev.watched;
    markJourney(record, 'held');
    if (walkingName === ev.journey) walkingName = '';
    updateCounts();
  }

  function onWobble(ev) {
    var w = ev.wobble || {};
    show(ui.groupWobble, true);
    if (!finished) setState('Working out what actually changed.', '');
    // A build that was only run once has no wobble to show. Two noughts would read as
    // "nothing wobbled", which is the opposite of what happened: nothing was measured.
    var measured = w.measured !== false;
    show(ui.wSteadyWrap, measured);
    show(ui.wUnstableWrap, measured);
    countTo(ui.wSteady, w.steady || 0);
    countTo(ui.wUnstable, w.unstable || 0);
    if (ui.wUnstableWrap) ui.wUnstableWrap.classList.toggle('on', (w.unstable || 0) > 0);
    var newly = Number(w.newlyUnstable || 0);
    show(ui.wNewWrap, measured && (newly > 0 || w.couldTellNewly === false));
    if (ui.wNewWrap) ui.wNewWrap.classList.toggle('on', newly > 0);
    var newLabel = ui.wNewWrap ? ui.wNewWrap.querySelector('span') : null;
    if (w.couldTellNewly === false) {
      // A bare nought here would read as good news. Nothing was measured, so nothing is
      // claimed: the figure says so rather than showing a number nobody earned.
      text(ui.wNew, '—');
      if (newLabel) text(newLabel, 'could not be told — nothing on record about what the old build held steady');
    } else {
      countTo(ui.wNew, newly);
      if (newLabel) text(newLabel, 'were steady before this change and wobble now');
    }
    // The window says this in its own words when nobody handed it any. An empty card where
    // the wobble should be is the one place this thing must never go quiet: it is the
    // number that explains why everything else on the page is so short.
    var note = w.note || ev.message || wobbleWords(w);
    text(ui.wobbleNote, note);
    var paths = w.newlyUnstablePaths || [];
    ui.wobblePaths.textContent = '';
    for (var i = 0; i < paths.length; i++) {
      var li = document.createElement('li');
      li.textContent = paths[i];
      ui.wobblePaths.appendChild(li);
    }
    show(ui.wobblePaths, paths.length > 0);
  }

  function wobbleWords(w) {
    if (w.measured === false) {
      return 'This build was only run once, so its own wobble was never measured. Anything below could be the product arguing with itself rather than something you changed.';
    }
    var n = Number(w.unstable || 0);
    if (!n) return 'This build gives the same answer twice, everywhere.';
    return commas(n) + ' ' + plural(n, 'address', 'addresses') + ' this build cannot answer the same way twice. Subtracted, not counted.';
  }

  function onNote(ev) {
    if (!ev.message) return;
    if (!finished) setWhat(ev.message);
  }

  function onFinding(ev) {
    var f = ev.finding;
    if (!f) return;
    for (var i = 0; i < findings.length; i++) if (findings[i].id === f.id) return;
    findings.push(f);
    if (f.sealed) sealedFindings.push(f);
    show(ui.groupFindings, true);
    show(ui.nothing, false);
    ui.findingList.appendChild(findingRow(f));
    text(ui.countFindings, commas(findings.length));
    renderNeeds();

    // The walk and the findings speak one language: the journey a finding was found on wears
    // the same mark the finding does, so a person scanning the list upstairs sees where the
    // trouble is without reading a word.
    var tone = f.sealed ? 'wait' : (f['class'] === 'crash' ? 'broke' : 'moved');
    var on = f.journey && journeys[f.journey];
    if (on && on.done && rank(tone) > rank(on.tone)) markJourney(on, tone, true);

    if (!finished) {
      var sealedNow = sealedFindings.length;
      if (sealedNow > 0) setState(commas(sealedNow) + ' ' + plural(sealedNow, 'thing needs', 'things need') + ' you.', 'wait');
      else setState(commas(findings.length) + ' ' + plural(findings.length, 'finding', 'findings') + ' so far.', 'moved');
    }
    if (walkingName && journeys[walkingName] && !journeys[walkingName].done) markJourney(journeys[walkingName], 'running');
  }

  // Red beats blue beats amber beats green, because a person should see the most serious
  // state first and nothing should ever be quietly downgraded.
  function rank(tone) {
    var order = { broke: 4, wait: 3, moved: 2, held: 1, running: 0, pending: 0 };
    return order[tone] || 0;
  }

  function findingRow(f) {
    var tone = f.sealed ? 'wait' : (f['class'] === 'crash' ? 'broke' : 'moved');
    var item = document.createElement('div');
    item.className = 'item fresh attention ' + tone + (f.sealed ? ' sealed' : '');
    item.style.setProperty('--tone', 'var(--' + (tone === 'wait' ? 'wait' : tone === 'broke' ? 'broke' : 'moved') + ')');

    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'row frow';
    var dot = document.createElement('span');
    dot.className = 'dot';
    var title = document.createElement('span');
    title.className = 'ftitle';
    title.textContent = f.title || 'Something changed.';
    var count = document.createElement('span');
    count.className = 'fcount';
    count.textContent = f.count > 1 ? commas(f.count) : '';
    row.appendChild(dot);
    row.appendChild(title);
    row.appendChild(count);
    row.insertAdjacentHTML('beforeend', CHEVRON);

    var detail = document.createElement('div');
    detail.className = 'detail';
    detail.hidden = true;

    if (f.why) {
      var why = document.createElement('p');
      why.className = 'why';
      why.textContent = f.why;
      detail.appendChild(why);
    }
    if (f.count > 1) {
      var stands = document.createElement('p');
      stands.className = 'out';
      stands.textContent = 'One cause behind ' + commas(f.count) + ' differences.';
      detail.appendChild(stands);
    }
    if (f.sample) {
      var sample = document.createElement('ul');
      sample.className = 'paths mono';
      var one = document.createElement('li');
      one.textContent = f.sample;
      sample.appendChild(one);
      detail.appendChild(sample);
    }
    // The addresses, minus the one already written out above it. A finding that stands for a
    // single difference has already been shown whole, and printing its address again
    // underneath is a window repeating itself.
    var others = [];
    for (var p = 0; p < (f.paths || []).length; p++) {
      if (f.sample && String(f.sample).indexOf(f.paths[p]) === 0) continue;
      others.push(f.paths[p]);
    }
    if (others.length && f.count > 1) {
      var list = document.createElement('ul');
      list.className = 'paths mono';
      for (var i = 0; i < others.length; i++) {
        var li = document.createElement('li');
        li.textContent = others[i];
        list.appendChild(li);
      }
      if (f.count > others.length + (f.sample ? 1 : 0)) {
        var more = document.createElement('li');
        more.textContent = 'and ' + commas(f.count - others.length - (f.sample ? 1 : 0)) + ' more';
        list.appendChild(more);
      }
      detail.appendChild(list);
    }
    var meta = [];
    if (f['class'] && f['class'] !== 'ordinary') meta.push('touches ' + classWord(f['class']));
    if (f.nearFiles && f.nearFiles.length) meta.push('nearest code: ' + f.nearFiles.join(', '));
    if (f.journey) meta.push('found while walking ' + f.journey);
    if (meta.length) {
      var m = document.createElement('p');
      m.className = 'meta';
      m.textContent = meta.join('  ·  ');
      detail.appendChild(m);
    }
    // Evidence is fetched, never pushed: version 2 is mostly not about pictures, so the
    // file is only opened when somebody asks to look at it.
    if (f.evidence) {
      var look = document.createElement('button');
      look.type = 'button';
      look.className = 'evidence';
      look.textContent = 'Look at the evidence';
      look.addEventListener('click', function (e) {
        e.stopPropagation();
        openEvidence(f.title || 'evidence', f.evidence);
      });
      detail.appendChild(look);
    }

    item.appendChild(row);
    item.appendChild(detail);
    var open = false;
    row.addEventListener('click', function () {
      open = !open;
      detail.hidden = !open;
      item.classList.toggle('open', open);
    });
    // Anything a person has to decide opens itself. Everything else waits to be asked.
    if (f.sealed) {
      open = true;
      detail.hidden = false;
      item.classList.add('open');
    }
    return item;
  }

  function classWord(name) {
    var words = {
      money: 'money', 'sign-in': 'signing in', 'data-loss': 'losing data',
      crash: 'a crash', guard: 'a bug already reported once'
    };
    return words[name] || name;
  }

  function onCoverage(ev) {
    var c = ev.coverage;
    if (!c) return;
    show(ui.groupCoverage, true);
    show(ui.nothing, false);
    ui.covFigures.textContent = '';
    addFigure(commas(c.paths), plural(c.paths, 'address watched', 'addresses watched'));
    addFigure(commas(c.journeys), plural(c.journeys, 'journey walked', 'journeys walked'));
    if (typeof c.doorsUnopened === 'number') {
      // The number that has to arrive in the same breath as the good news: doors the code
      // declares that no journey has ever opened. Never a percentage — a percentage invites
      // a target, and a target invites gaming.
      addFigure(commas(c.doorsUnopened), plural(c.doorsUnopened, 'door in the code never opened', 'doors in the code never opened'), c.doorsUnopened > 0);
    }
    text(ui.covNote, ev.message || '');
    ui.gapList.textContent = '';
    var gaps = c.gaps || [];
    for (var i = 0; i < gaps.length; i++) ui.gapList.appendChild(gapRow(gaps[i]));
    if (c.gapsHidden) {
      text(ui.gapMore, commas(c.gapsHidden) + ' more ' + plural(c.gapsHidden, 'gap', 'gaps') + ' not listed here.');
      show(ui.gapMore, true);
    } else {
      show(ui.gapMore, false);
    }
  }

  function addFigure(value, label, doubtful) {
    var box = document.createElement('div');
    box.className = 'figure doubt' + (doubtful ? ' on' : '');
    var b = document.createElement('b');
    b.className = 'mono';
    b.textContent = value;
    var s = document.createElement('span');
    s.textContent = label;
    box.appendChild(b);
    box.appendChild(s);
    ui.covFigures.appendChild(box);
  }

  function gapRow(gap) {
    var li = document.createElement('li');
    li.className = 'gap';
    var what = document.createElement('p');
    what.className = 'gapwhat';
    what.textContent = gap.what || '';
    if (gap.doors) {
      var doors = document.createElement('span');
      doors.className = 'gapdoors mono';
      doors.textContent = commas(gap.doors) + ' ' + plural(gap.doors, 'door', 'doors');
      what.appendChild(doors);
    }
    li.appendChild(what);
    if (gap.why) {
      var why = document.createElement('p');
      why.className = 'gapwhy';
      why.textContent = gap.why;
      li.appendChild(why);
    }
    if (gap.unlockedBy) {
      // No escape sequences in here: this whole script is carried inside a template literal,
      // where a backslash-b would be read as a backspace long before the regular expression
      // ever sees it. It cost one silent failure to find that out.
      var permanent = /^nothing[^a-z]/i.test(String(gap.unlockedBy).trim() + ' ');
      var fix = document.createElement('p');
      fix.className = 'gapfix' + (permanent ? ' permanent' : '');
      fix.textContent = permanent ? gap.unlockedBy : 'Would be covered by: ' + gap.unlockedBy;
      li.appendChild(fix);
    }
    return li;
  }

  function renderNeeds() {
    if (!sealedFindings.length) { show(ui.footer, false); return; }
    ui.needs.textContent = '';
    for (var i = 0; i < sealedFindings.length; i++) {
      var f = sealedFindings[i];
      var need = document.createElement('div');
      need.className = 'need';
      var dot = document.createElement('span');
      dot.className = 'dot';
      var body = document.createElement('p');
      body.className = 'needtext';
      body.textContent = f.title || 'Something changed.';
      var why = document.createElement('span');
      why.className = 'needwhy';
      why.textContent = 'It touches ' + classWord(f['class']) + '.';
      body.appendChild(why);
      need.appendChild(dot);
      need.appendChild(body);
      ui.needs.appendChild(need);
    }
    show(ui.footer, true);
  }

  function onDone(ev) {
    finished = true;
    stopClock();
    if (typeof ev.durationMs === 'number') text(ui.clock, fmt(ev.durationMs));
    else if (typeof ev.at === 'number') text(ui.clock, fmt(ev.at));

    // Anything still marked as running never finished. Saying so is the honest thing: a
    // row left breathing beside a final verdict is a window lying about its own state.
    for (var i = 0; i < order.length; i++) {
      var record = journeys[order[i]];
      if (!record.done) markJourney(record, 'pending');
    }

    var v = ev.verdict;
    if (!v) {
      setState(ev.message || 'Finished.', '');
      setWhat('');
      return;
    }

    var tone = v.sealed > 0 ? 'wait' : (v.findings > 0 ? 'moved' : 'held');
    var sentence;
    if (v.sealed > 0) {
      sentence = commas(v.sealed) + ' ' + plural(v.sealed, 'thing needs', 'things need') + ' you.';
    } else if (v.findings > 0) {
      sentence = commas(v.findings) + ' ' + plural(v.findings, 'finding', 'findings') + ' the agent has to deal with.';
    } else {
      sentence = 'Everything that worked still works.';
    }
    setState(sentence, tone);

    // The caveat travels with the good news, never after it. A green run on a product with
    // hundreds of unopened doors, or measured against a stored record, is a smaller claim
    // than it looks, and the smaller claim is the true one.
    var caveats = [];
    if (v.modeWarning) caveats.push(v.modeWarning);
    if (v.differencesNoise) {
      caveats.push(commas(v.differencesNoise) + ' ' + plural(v.differencesNoise, 'difference was', 'differences were') + ' this build arguing with itself, and were subtracted.');
    }
    if (v.summary) caveats.unshift(v.summary);
    setWhat(caveats.join(' '));
    renderNeeds();
  }

  // -------------------------------------------------------------------------
  // Evidence, at full size
  // -------------------------------------------------------------------------

  function openEvidence(name, address) {
    if (!address) return;
    text(ui.vname, name);
    ui.vimg.setAttribute('src', address);
    show(ui.viewer, true);
  }

  function closeEvidence() {
    show(ui.viewer, false);
    ui.vimg.removeAttribute('src');
  }

  if (ui.vclose) ui.vclose.addEventListener('click', closeEvidence);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && ui.viewer && !ui.viewer.hidden) closeEvidence();
  });

  // -------------------------------------------------------------------------
  // The one thing the check calls
  // -------------------------------------------------------------------------

  window.__staysfixed_push = function (input) {
    try {
      var ev = typeof input === 'string' ? JSON.parse(input) : input;
      if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return;
      handle(ev);
    } catch (err) {
      // A window must never be the reason a check looks broken. Whatever this event was,
      // the next one still has to land. It is said out loud where anyone would look for
      // it — a window that swallows its own mistakes is a window nobody can mend.
      if (window.console && console.error) console.error('stays fixed: ' + (err && err.message ? err.message : err));
    }
  };

  // Called when the check lets go of the window, so the clock does not tick on forever
  // next to a result that is already final.
  window.__staysfixed_detach = function () {
    finished = true;
    stopClock();
    for (var i = 0; i < order.length; i++) {
      var record = journeys[order[i]];
      if (!record.done) markJourney(record, 'pending');
    }
  };

  // Draw the plan before anything has happened, so the window is worth looking at from the
  // first frame instead of appearing empty.
  (function seed() {
    if (plan.product) text(ui.product, plan.product);
    if (plan.surfaces && plan.surfaces.length) {
      text(ui.surfaces, plan.surfaces.join(' · '));
      show(ui.surfaces, true);
      show(ui.targetsep, true);
    }
    var list = plan.journeys || [];
    for (var i = 0; i < list.length; i++) journeyRow(list[i].name, list[i]);
    if (plan.reference) onReference({ type: 'reference', at: 0, reference: plan.reference });
    updateCounts();
    show(ui.nothing, order.length === 0);
    startClock();
  })();
})();
`;
