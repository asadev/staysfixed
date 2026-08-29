/**
 * The watch window: a real browser window, opened beside the app being checked,
 * that redraws itself as the run happens.
 *
 * There is no server here and no port beyond the debugging one. The page is
 * written to a temp file, opened over `file://` as an app window — no tabs, no
 * address bar — and every update is one call into a function the page defines.
 * That is the same machinery that drives everything else in this tool, so the
 * watch window adds no dependency and nothing new to go wrong.
 *
 * Three rules shape this file.
 *
 * The window must never change what the pictures look like. It is a separate
 * browser process with its own throwaway profile, launched with none of the
 * determinism flags, and it never touches the app being photographed. Moving
 * the app's WINDOW is allowed and is not the same thing: what a picture is of
 * comes from `Emulation.setDeviceMetricsOverride`, which does not care where on
 * the screen the window happens to be.
 *
 * It must never take the screen. Automation that steals the foreground takes
 * the window out from under whatever the person was actually doing, so the
 * panel opens behind them and the screen is handed straight back.
 *
 * And it must land where it belongs: the app hard against one edge of the
 * screen, the panel flush against it, no seam, so the two of them read as one
 * window with a side panel. The arithmetic for that lives next door in
 * `place.js`. Move the panel yourself and it stays where you put it, this run
 * and the next one — a window a person has arranged is theirs.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { warn, detail } from '../core/log.js';
import { messageOf } from '../core/errors.js';
import { DEFAULT_VIEWPORT } from '../core/config.js';
import { waitForEndpoint, listTargets, connect } from '../drive/cdp.js';
import { findChrome, freePort } from '../drive/find.js';
import { createPage } from '../drive/page.js';
import { stopProcess, delay } from '../drive/browser.js';
import { verdictFor } from '../report/console.js';
import { panelHtml } from './panel.js';
import { planPlacement, panelBeside, fitsAlongside, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH } from './place.js';

const execFileAsync = promisify(execFile);

/** Every temp folder this file makes starts with this, so old ones can be found again. */
const TMP_PREFIX = 'staysfixed-panel-';

/** A panel folder untouched for this long belongs to a window nobody has open any more. */
const STALE_MS = 24 * 60 * 60 * 1000;

/** How wide the panel is when nobody says otherwise. Legible down to 420. */
const DEFAULT_WIDTH = 460;

/** A panel shorter than this cannot show the picture and the list at the same time. */
const MIN_HEIGHT = 640;

/**
 * The gap between the app's edge and the panel's. None, on purpose: two windows
 * that touch read as one window, and a seam is what gives away that they are two
 * separate programs sitting next to each other.
 */
const GAP = 0;

/** How long to wait for the window to open before giving up on it. */
const OPEN_TIMEOUT_MS = 20_000;

/** Updates sent in one call. More than this in flight means the run is outrunning the window. */
const MAX_BATCH = 32;

/** How many queued updates keep their pictures when the queue is backing up. */
const KEEP_PICTURES = 3;

/**
 * The window's own background, painted before the document is. This must be the
 * panel's ground colour from `panel.js`: it is the same surface, and a browser
 * flashing white for a fifth of a second is exactly what makes a purpose-built
 * window look like a browser tab.
 */
const GROUND = { r: 21, g: 23, b: 25, a: 1 };

/** A window off by less than this was nudged by a window manager, not by a person. */
const MOVE_TOLERANCE = 8;

/** How often the page looks at where it is. Slow on purpose: nobody is racing. */
const MOVE_WATCH_MS = 1000;

/** Where the window a person arranged is written down, inside the project's own folder. */
const REMEMBER_FILE = 'watch-window.json';

/**
 * A watch window that is open and listening.
 * @typedef {object} Panel
 * @property {(event: import('../types.js').RunEvent) => Promise<void>} push
 * @property {() => Promise<void>} close
 * @property {string} url
 * @property {(app: import('../types.js').LaunchedApp) => Promise<void>} snapTo
 *           Put the app against its edge and the panel flush against it. Once per run.
 * @property {() => boolean} placedByHand
 *           True once the person has moved the window themselves. Nothing moves it after that.
 */

/**
 * What the panel is told before anything starts. Counts are accepted as well as
 * lists, so a caller that only knows how many there are still gets a header.
 * @typedef {object} PlanInput
 * @property {string} [project]
 * @property {string|import('../types.js').AppConfig} [app]
 * @property {import('./panel.js').PanelRow[]|number} [screens]
 * @property {import('./panel.js').PanelRow[]|number} [guards]
 */

/**
 * @typedef {object} OpenPanelOptions
 * @property {import('../types.js').Project} [project]
 * @property {PlanInput} [plan]
 * @property {import('../types.js').WatchOptions} [watch]
 * @property {{width: number, height: number}} [appViewport]
 */

/**
 * @param {number} value
 * @param {number} low
 * @param {number} high
 * @returns {number}
 */
function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * The opening guess: how big the panel is, and where it goes before anything
 * knows how big the screen is.
 *
 * Only a window can say what screen it is on (`readScreen`), and there is no
 * window yet when this is called — so the app is taken to be sitting at the top
 * left corner and the panel is put beside it. `snapTo` replaces this with the
 * real placement the moment the app is up.
 *
 * `watch.side` names the side the PANEL goes on, which is how the option has
 * always read. `planPlacement` names the screen edge the APP is pinned to. With
 * the app assumed to be in the corner those are the same arrangement said from
 * opposite ends — a panel to the right of the app IS an app pinned left — which
 * is why the side is mirrored on the way through.
 *
 * Pure on purpose, so the arithmetic can be checked without opening anything.
 *
 * @param {{width?: number, height?: number}} [appViewport]
 * @param {import('../types.js').WatchOptions} [watch]
 * @returns {{width: number, height: number, x: number, y: number}}
 */
export function panelBounds(appViewport, watch) {
  const opts = watch ?? {};
  const appWidth = Math.round(Number(appViewport?.width) || DEFAULT_VIEWPORT.width);
  const appHeight = Math.round(Number(appViewport?.height) || DEFAULT_VIEWPORT.height);

  const asked = Number(opts.width);
  const width = clamp(
    Math.round(Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_WIDTH),
    PANEL_MIN_WIDTH,
    PANEL_MAX_WIDTH,
  );

  const askedHeight = Number(opts.height);
  const height = Math.max(
    MIN_HEIGHT,
    Math.round(Number.isFinite(askedHeight) && askedHeight > 0 ? askedHeight : appHeight),
  );

  const plan = planPlacement({
    // A screen exactly big enough for the two of them, because there is no real
    // one to ask yet. It keeps the windows adjacent and keeps every bit of the
    // arithmetic in one file.
    screen: { left: 0, top: 0, width: appWidth + GAP + width, height: Math.max(appHeight, height) },
    appSize: { width: appWidth, height: appHeight },
    panelWidth: width,
    side: opts.side === 'left' ? 'right' : 'left',
    gap: GAP,
  });

  return { width, height, x: plan.panel.left, y: plan.panel.top };
}

// ---------------------------------------------------------------------------
// The screen, and the windows standing on it
// ---------------------------------------------------------------------------

/**
 * A window we can move: anything with a CDP connection and a target on it.
 * Both the panel's page and the app's page are one of these.
 * @typedef {object} WindowRef
 * @property {(method: string, params?: Record<string, unknown>) => Promise<any>} send
 * @property {string} targetId
 */

/**
 * The usable screen area, in screen pixels — menu bar and dock already taken off.
 *
 * Always ask the PANEL's page and never the app's. The app is photographed
 * through `Emulation.setDeviceMetricsOverride`, which makes its page believe it
 * is on a screen exactly the size of the viewport we asked for. That is what
 * makes the pictures the same on every machine, and it is also why the app is
 * the last thing here you should ask how big the screen is.
 *
 * @param {{evaluate: (js: string) => Promise<any>}} page  The panel's page.
 * @returns {Promise<import('./place.js').Bounds>}
 */
export async function readScreen(page) {
  /** A desk-sized screen, for a window that will not say. */
  const fallback = { left: 0, top: 0, width: 1440, height: 900 };
  try {
    const raw = await page.evaluate(
      '(function(){var s=window.screen||{};return {' +
        'left:s.availLeft,top:s.availTop,' +
        'width:s.availWidth||s.width,height:s.availHeight||s.height};})()',
    );
    if (!raw || typeof raw !== 'object') return fallback;
    const width = Math.round(Number(raw.width));
    const height = Math.round(Number(raw.height));
    if (!(width > 0) || !(height > 0)) return fallback;
    const left = Number(raw.left);
    const top = Number(raw.top);
    return {
      // Not every browser reports availLeft/availTop; a single screen starts at zero.
      left: Number.isFinite(left) ? Math.round(left) : 0,
      top: Number.isFinite(top) ? Math.round(top) : 0,
      width,
      height,
    };
  } catch {
    return fallback;
  }
}

/**
 * Where a window is right now. Null when the target will not say.
 * @param {WindowRef} page
 * @returns {Promise<import('./place.js').Bounds|null>}
 */
export async function readWindowBounds(page) {
  try {
    const found = await page.send('Browser.getWindowForTarget', { targetId: page.targetId });
    const bounds = found?.bounds;
    if (!bounds) return null;
    const width = Math.round(Number(bounds.width));
    const height = Math.round(Number(bounds.height));
    if (!(width > 0) || !(height > 0)) return null;
    return { left: Math.round(Number(bounds.left) || 0), top: Math.round(Number(bounds.top) || 0), width, height };
  } catch {
    return null;
  }
}

/**
 * Move a window, and say whether it went.
 *
 * Never throws. Not every window can be moved — Electron builds differ on this,
 * and a window manager is entitled to say no — and where a window sits is a
 * nicety that is never worth a failed run, nor a warning in the middle of a
 * clean one.
 *
 * @param {WindowRef} page
 * @param {import('./place.js').Bounds} bounds
 * @returns {Promise<boolean>}
 */
export async function moveWindow(page, bounds) {
  try {
    const found = await page.send('Browser.getWindowForTarget', { targetId: page.targetId });
    const windowId = found?.windowId;
    if (typeof windowId !== 'number') return false;

    // A maximised or minimised window refuses a size, and Chrome answers with an
    // error rather than quietly restoring it for you. So it is put back to a
    // normal window first, in a call of its own: the same call cannot both
    // restore a window and place it.
    const state = String(found?.bounds?.windowState ?? 'normal');
    if (state !== 'normal') {
      await page.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    }

    await page.send('Browser.setWindowBounds', {
      windowId,
      bounds: {
        windowState: 'normal',
        left: Math.round(bounds.left),
        top: Math.round(bounds.top),
        width: Math.max(1, Math.round(bounds.width)),
        height: Math.max(1, Math.round(bounds.height)),
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a window is, as its own page sees it.
 *
 * `screenX`, `screenY`, `outerWidth` and `outerHeight` describe the window, not
 * the page, and they keep describing the window with
 * `Emulation.setDeviceMetricsOverride` applied — measured on a real app being
 * photographed at 1440x900, they still report the window it is actually in. This
 * is the only measurement a desktop app will give us at all.
 *
 * @param {{evaluate: (js: string) => Promise<any>}} page
 * @returns {Promise<import('./place.js').Bounds|null>}
 */
async function readPageWindow(page) {
  try {
    const raw = await page.evaluate(
      '({left:window.screenX,top:window.screenY,width:window.outerWidth,height:window.outerHeight})',
    );
    if (!raw || typeof raw !== 'object') return null;
    const width = Math.round(Number(raw.width));
    const height = Math.round(Number(raw.height));
    if (!(width > 0) || !(height > 0)) return null;
    return { left: Math.round(Number(raw.left) || 0), top: Math.round(Number(raw.top) || 0), width, height };
  } catch {
    return null;
  }
}

/**
 * Move a window through macOS itself, when the app has no way to be asked.
 *
 * Electron does not implement the part of the protocol that moves windows —
 * `Browser.getWindowForTarget` is simply not there — so a desktop app cannot be
 * placed over the debugging connection, and placing it is the entire point.
 * macOS can do it, under two hard rules.
 *
 * It names the process BY ITS UNIX ID, never by its name. A person's own copy of
 * an app and the scratch copy under test have the same name, and a script that
 * says `process "Terminal Deck"` moves whichever one macOS hands it. The id is
 * the one this run started itself, so nothing else on the machine can be caught
 * by it — and an app we merely attached to has no id here and is never moved.
 *
 * And it moves only the window that is exactly where the page says it is, so an
 * app with a second window open keeps it where it was. Position only: the size
 * of the window being photographed is never ours to change.
 *
 * @param {number} pid
 * @param {import('./place.js').Bounds} current  Where the page says the window is now.
 * @param {import('./place.js').Bounds} target
 * @returns {Promise<boolean>}
 */
async function moveMacWindow(pid, current, target) {
  if (process.platform !== 'darwin') return false;
  const script = [
    `tell application "System Events" to tell (first application process whose unix id is ${Math.round(pid)})`,
    '  repeat with w in windows',
    `    if (item 1 of (get position of w)) is ${current.left} and (item 2 of (get position of w)) is ${current.top} then`,
    `      set position of w to {${Math.round(target.left)}, ${Math.round(target.top)}}`,
    '    end if',
    '  end repeat',
    'end tell',
  ].join('\n');
  try {
    await execFileAsync('osascript', ['-e', script], { timeout: 8000 });
    return true;
  } catch {
    // Usually no accessibility permission, sometimes an app that will not be
    // scripted. The panel goes beside it where it stands instead.
    return false;
  }
}

/**
 * Paint the window's own background before the document paints its own.
 *
 * The page sets its ground the moment it loads; the browser paints the window
 * before that, and white for a fifth of a second is the single thing that makes
 * a purpose-built window look like a browser opening. `--force-dark-mode` would
 * cover it too and is not an option: it repaints pages, and nothing in this
 * process may ever be able to change what something looks like.
 *
 * @param {{send: (method: string, params?: Record<string, unknown>) => Promise<any>}} page
 * @returns {Promise<void>}
 */
async function darkenWindow(page, theme = 'dark') {
  try {
    // It lives in Emulation, not Page, despite being about the window rather
    // than about emulating anything. Applied to the PANEL's own page only.
    await page.send('Emulation.setDefaultBackgroundColorOverride', { color: GROUND });
  } catch {
    // An older build without it just flashes. Not worth a word.
  }
  if (theme === 'system') return;
  try {
    // Say which look we want rather than asking.
    //
    // The panel is written dark first, with a light palette behind
    // `prefers-color-scheme: light`. But this window runs on a brand new browser
    // profile, and a fresh profile answers that question with "light" whatever the
    // computer around it is set to — so the panel came up pale on a dark desktop.
    // This is our own window, not a page on somebody's site, so it does not have to
    // guess: it is told. `--watch-theme light` or `system` for anyone who wants the
    // other behaviour.
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: theme }],
    });
  } catch (e) {
    // A build that will not be told keeps whatever it chose.
    detail('watch window: could not set the look —', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Watch the panel's window for a hand on it.
 *
 * The page checks its own position on a slow interval — four numbers, once a
 * second, no protocol traffic at all — and remembers the moment they stop
 * matching what we last set. Reading that is then one call, made only when we
 * are about to move the window or write down where it ended up.
 *
 * @param {{evaluate: (js: string) => Promise<any>}} page
 * @param {import('./place.js').Bounds} expected  Where we have just put it.
 * @returns {Promise<void>}
 */
async function watchForHandMove(page, expected) {
  const source =
    '(function(){var e=' +
    JSON.stringify(expected) +
    ';var w=window.__staysfixed_place;' +
    'if(w){w.expected=e;return true;}' +
    'w=window.__staysfixed_place={moved:false,bounds:null,expected:e};' +
    'w.look=function(){' +
    'var b={left:window.screenX,top:window.screenY,width:window.outerWidth,height:window.outerHeight};' +
    'w.bounds=b;var x=w.expected;if(!x)return;' +
    'if(Math.abs(b.left-x.left)>' +
    MOVE_TOLERANCE +
    '||Math.abs(b.top-x.top)>' +
    MOVE_TOLERANCE +
    '||Math.abs(b.width-x.width)>' +
    MOVE_TOLERANCE +
    '||Math.abs(b.height-x.height)>' +
    MOVE_TOLERANCE +
    ')w.moved=true;};' +
    'w.timer=setInterval(w.look,' +
    MOVE_WATCH_MS +
    ');return true;})()';
  await page.evaluate(source).catch(() => {});
}

/**
 * Has the person moved it, and where is it now?
 * @param {{evaluate: (js: string) => Promise<any>}} page
 * @returns {Promise<{moved: boolean, bounds: import('./place.js').Bounds|null}>}
 */
async function readHandMove(page) {
  try {
    const raw = await page.evaluate(
      '(function(){var w=window.__staysfixed_place;if(!w)return null;' +
        // Look once more before answering, so a window moved a moment ago still counts.
        'if(typeof w.look==="function")w.look();' +
        'return {moved:!!w.moved,bounds:w.bounds};})()',
    );
    if (!raw || typeof raw !== 'object') return { moved: false, bounds: null };
    const b = raw.bounds;
    const bounds =
      b && Number.isFinite(Number(b.width)) && Number(b.width) > 0
        ? {
            left: Math.round(Number(b.left) || 0),
            top: Math.round(Number(b.top) || 0),
            width: Math.round(Number(b.width)),
            height: Math.round(Number(b.height)),
          }
        : null;
    return { moved: raw.moved === true, bounds };
  } catch {
    return { moved: false, bounds: null };
  }
}

/**
 * Stop the page watching itself. Called on the way out, so a window left open
 * after the run is not still running a timer nobody reads.
 * @param {{evaluate: (js: string) => Promise<any>}} page
 * @returns {Promise<void>}
 */
async function stopWatchingMoves(page) {
  await page
    .evaluate(
      '(function(){var w=window.__staysfixed_place;' +
        'if(w&&w.timer){clearInterval(w.timer);w.timer=null;}return true;})()',
    )
    .catch(() => {});
}

/**
 * Would this window still make sense on this screen?
 * @param {import('./place.js').Bounds} bounds
 * @param {import('./place.js').Bounds} screen
 * @returns {boolean}
 */
function fitsOnScreen(bounds, screen) {
  // A window is allowed to hang slightly over an edge — people put them there on
  // purpose. A window remembered from a bigger monitor is not.
  const slack = 24;
  if (!(bounds.width > 0) || !(bounds.height > 0)) return false;
  return (
    bounds.left >= screen.left - slack &&
    bounds.top >= screen.top - slack &&
    bounds.left + bounds.width <= screen.left + screen.width + slack &&
    bounds.top + bounds.height <= screen.top + screen.height + slack
  );
}

/**
 * The window the person arranged last time, if there is one.
 * @param {import('../types.js').Project|undefined|null} project
 * @returns {Promise<import('./place.js').Bounds|null>}
 */
async function readRemembered(project) {
  const dir = project?.paths?.dir;
  if (!dir) return null;
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(dir, REMEMBER_FILE), 'utf8'));
    const width = Math.round(Number(raw?.width));
    const height = Math.round(Number(raw?.height));
    if (!(width > 0) || !(height > 0)) return null;
    return { left: Math.round(Number(raw.left) || 0), top: Math.round(Number(raw.top) || 0), width, height };
  } catch {
    // No file, or a file somebody has been editing. Either way: place it ourselves.
    return null;
  }
}

/**
 * Write down where the person left the window.
 *
 * A window somebody has arranged is theirs, and it should still be theirs
 * tomorrow — so the next run opens it there instead of dragging it back to
 * where the arithmetic says it belongs. The screen is written down beside it so
 * a position remembered from a second monitor can be recognised and ignored.
 *
 * @param {import('../types.js').Project|undefined|null} project
 * @param {import('./place.js').Bounds} bounds
 * @param {import('./place.js').Bounds} screen
 * @returns {Promise<void>}
 */
async function writeRemembered(project, bounds, screen) {
  const dir = project?.paths?.dir;
  if (!dir) return;
  try {
    await fsp.mkdir(dir, { recursive: true });
    const body = { ...bounds, screen, at: new Date().toISOString() };
    await fsp.writeFile(path.join(dir, REMEMBER_FILE), JSON.stringify(body, null, 2) + '\n');
  } catch {
    // Remembering is a courtesy. A read-only folder is not a failed run.
  }
}

/**
 * A Mac app bundle is named by its folder, not by the program inside it.
 * @param {string} binary
 * @returns {string}
 */
function appNameFrom(binary) {
  const bundle = binary.match(/([^/\\]+)\.app(?:[/\\]|$)/);
  return bundle ? bundle[1] : path.basename(binary);
}

/**
 * What is being checked, said the way a person would say it.
 * @param {string|import('../types.js').AppConfig|undefined} app
 * @returns {string}
 */
function describeApp(app) {
  if (typeof app === 'string') return app.trim();
  if (!app || typeof app !== 'object') return '';
  const a = /** @type {any} */ (app);
  if (a.kind === 'electron' && a.binary) return `the desktop app ${appNameFrom(String(a.binary))}`;
  if (a.url) return `the app at ${String(a.url)}`;
  if (a.attach) return `the app already running at ${String(a.attach)}`;
  return a.kind === 'electron' ? 'a desktop app' : 'a web app';
}

/**
 * Rows, whether the caller had the list or only the count. A count becomes
 * placeholder rows that fill themselves in as the run names them.
 * @param {import('./panel.js').PanelRow[]|number|undefined} value
 * @returns {import('./panel.js').PanelRow[]}
 */
function rowsFrom(value) {
  if (Array.isArray(value)) {
    return value
      .filter((row) => row && typeof row === 'object' && typeof (/** @type {any} */ (row).name) === 'string')
      .map((row) => ({
        name: String(/** @type {any} */ (row).name),
        describe: /** @type {any} */ (row).describe ? String(/** @type {any} */ (row).describe) : undefined,
      }));
  }
  return [];
}

/**
 * @param {OpenPanelOptions} opts
 * @returns {import('./panel.js').PanelPlan}
 */
function planFor(opts) {
  const plan = opts.plan ?? {};
  const root = opts.project?.paths?.root;
  return {
    project: String(plan.project ?? (root ? path.basename(root) : '')).trim(),
    app: describeApp(plan.app ?? opts.project?.config?.app),
    screens: rowsFrom(plan.screens),
    guards: rowsFrom(plan.guards),
  };
}

/**
 * The flags. Short, because nothing here is being photographed: the panel needs
 * a clean window, a profile of its own, and nothing on it that says "browser".
 * @param {{port: number, profileDir: string, url: string, bounds: import('./place.js').Bounds}} ctx
 * @returns {string[]}
 */
function panelArgs(ctx) {
  return [
    `--remote-debugging-port=${ctx.port}`,
    // Node's WebSocket sends no Origin header, and recent Chrome refuses a
    // socket from an unknown one.
    '--remote-allow-origins=*',
    // Never the browser the person actually uses: their tabs, their extensions,
    // their signed-in session. This one is thrown away afterwards.
    `--user-data-dir=${ctx.profileDir}`,
    // An app window: no tabs, no address bar, nothing but the panel.
    `--app=${ctx.url}`,
    `--window-size=${ctx.bounds.width},${ctx.bounds.height}`,
    `--window-position=${ctx.bounds.left},${ctx.bounds.top}`,
    // Everything a browser puts on a window that this is not: the first-run
    // page, the default-browser question, the translate strip, the cast icon,
    // the "Chrome didn't shut down properly" bubble, and the info bar that
    // announces automation. With a throwaway profile as well, what opens is a
    // rectangle with our page in it.
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    '--hide-crash-restore-bubble',
    '--disable-features=Translate,MediaRouter',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--metrics-recording-only',
    '--disable-client-side-phishing-detection',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain',
    '--mute-audio',
    '--disable-notifications',
    '--deny-permission-prompts',
    // A window sitting behind another one gets its timers slowed down, which
    // would make the elapsed clock in the panel visibly wrong.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
}

/**
 * The name of the application currently in front, on macOS. Null anywhere else.
 * @returns {Promise<string|null>}
 */
async function frontmostApp() {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync(
      'osascript',
      ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
      { timeout: 4000 },
    );
    const name = stdout.trim();
    return name.length > 0 ? name : null;
  } catch {
    // No Apple Events permission, or no window server at all. Not worth a word.
    return null;
  }
}

/**
 * Put the screen back where it was before the panel opened.
 * @param {string} name
 * @returns {Promise<void>}
 */
async function giveFocusBack(name) {
  if (process.platform !== 'darwin') return;
  try {
    await execFileAsync(
      'osascript',
      [
        '-e',
        `tell application "System Events" to set frontmost of first application process whose name is ${JSON.stringify(name)} to true`,
      ],
      { timeout: 4000 },
    );
    detail(`the watch window is open behind ${name}`);
  } catch {
    // Worst case the panel keeps the foreground. Never a reason to fail a run.
  }
}

/**
 * Take away the folders left by panels that were kept open and then closed by
 * hand. A window we leave up owns its profile until the browser exits, and by
 * then this process is usually gone, so the tidying happens next time instead.
 * @returns {Promise<void>}
 */
async function sweepOldPanels() {
  try {
    const parent = os.tmpdir();
    const now = Date.now();
    for (const name of await fsp.readdir(parent)) {
      if (!name.startsWith(TMP_PREFIX)) continue;
      const full = path.join(parent, name);
      // The profile is what a live browser keeps writing to, so it is the
      // honest measure of whether anyone still has this window open.
      const stat =
        (await fsp.stat(path.join(full, 'profile')).catch(() => null)) ?? (await fsp.stat(full).catch(() => null));
      if (!stat || now - stat.mtimeMs < STALE_MS) continue;
      await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    // Housekeeping. Never worth a word, never worth a failure.
  }
}

/**
 * Find the window showing our page.
 * @param {string} endpoint
 * @param {number} deadline  epoch ms
 * @returns {Promise<any>}
 */
async function findPanelTarget(endpoint, deadline) {
  for (;;) {
    const targets = /** @type {any[]} */ (await listTargets(endpoint).catch(() => []));
    const hit = targets.find((t) => t && t.type === 'page' && String(t.url ?? '').startsWith('file://'));
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await delay(120);
  }
}

/**
 * Open the panel beside the app.
 *
 * Returns null — never throws — when there is no browser to open it with or the
 * window will not start. A run without a live view is a run; a run that fails
 * because its live view failed would be indefensible.
 *
 * @param {OpenPanelOptions} [opts]
 * @returns {Promise<Panel|null>}
 */
export async function openPanel(opts = {}) {
  const watch = opts.watch ?? {};
  const chrome = findChrome();
  if (!chrome) {
    warn(
      'There is no Chrome, Chromium, Edge or Brave on this machine, so the watch window cannot open. The check itself carries on as normal.',
    );
    return null;
  }

  await sweepOldPanels();

  const size = panelBounds(opts.appViewport, watch);
  // Where it was left last time, if anywhere. Opening there is the difference
  // between a window that comes back and a window that jumps.
  const remembered = await readRemembered(opts.project);
  const opening = remembered ?? { left: size.x, top: size.y, width: size.width, height: size.height };
  // How big the app's window is expected to be, when it is going to have one.
  // A guess, and only ever used to open the panel near where it will settle.
  const expectedApp = appHasAWindow(opts.project?.config?.app)
    ? {
        width: Math.round(Number(opts.appViewport?.width) || DEFAULT_VIEWPORT.width),
        height: Math.round(Number(opts.appViewport?.height) || DEFAULT_VIEWPORT.height),
      }
    : null;
  /** @type {string|null} */
  let temp = null;
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  /** @type {import('../types.js').CdpSession|null} */
  let cdp = null;

  try {
    temp = await fsp.mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
    const pageFile = path.join(temp, 'panel.html');
    const profileDir = path.join(temp, 'profile');
    await fsp.mkdir(profileDir, { recursive: true });
    await fsp.writeFile(pageFile, panelHtml({ ...planFor(opts), theme: watch.theme ?? 'dark' }));
    const url = pathToFileURL(pageFile).href;

    const port = await freePort();
    detail(`watch window: ${chrome}`);
    detail(`watch window port: ${port}`);

    // Remember who has the screen before anything opens, so it can be handed
    // straight back. `watch.foreground` is for when you want to watch it work.
    const previousApp = watch.foreground === true ? null : await frontmostApp();

    child = spawn(chrome, panelArgs({ port, profileDir, url, bounds: opening }), {
      // The window outlives this command when it is kept open, so it cannot be
      // tied to our process group or our pipes.
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    // A browser that dies later must not crash the run with an unhandled error.
    child.on('error', () => {});

    const endpoint = `http://127.0.0.1:${port}`;
    const version = await waitForEndpoint(endpoint, { timeoutMs: OPEN_TIMEOUT_MS, intervalMs: 100 });
    const wsUrl = version?.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error('the window opened but offered no debugging connection');

    cdp = /** @type {import('../types.js').CdpSession} */ (await connect(wsUrl, { timeoutMs: 15_000 }));

    const target = await findPanelTarget(endpoint, Date.now() + OPEN_TIMEOUT_MS);
    if (!target) throw new Error('the window opened but never showed the panel');

    const targetId = String(target.id ?? target.targetId);
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = String(attached.sessionId);
    const page = await createPage(
      cdp,
      /** @type {any} */ ({ sessionId, targetId, baseUrl: null, timeoutMs: 15_000 }),
    );

    // Before the document paints, so the window is never a white rectangle.
    await darkenWindow(page, watch.theme ?? 'dark');

    // Now there is a window, there is finally something that can say how big the
    // screen is. A position on the command line is a guess; this is the answer.
    const screen = await readScreen(page);
    const kept = remembered && fitsOnScreen(remembered, screen) ? remembered : null;
    const first = kept ?? firstPlace(screen, size, watch, expectedApp);
    await moveWindow(page, first);
    await watchForHandMove(page, first);

    // The page defines its own update function as it loads; until it exists
    // there is nothing to push into.
    await waitForPanelReady(page, Date.now() + OPEN_TIMEOUT_MS);

    if (previousApp) await giveFocusBack(previousApp);

    return makePanel({
      cdp,
      page,
      sessionId,
      child,
      temp,
      url,
      keepOpen: watch.keepOpen !== false,
      project: opts.project ?? null,
      side: watch.side === 'left' ? 'left' : 'right',
      panelWidth: size.width,
      askedHeight: askedHeight(watch),
      placed: first,
      // Opened where they left it, so it is already theirs: nothing snaps it.
      byHand: kept !== null,
      foreground: watch.foreground === true,
    });
  } catch (e) {
    warn(`The watch window could not open, so this run has no live view. The check itself carries on. ${messageOf(e)}`);
    if (cdp) await cdp.close().catch(() => {});
    if (child) await stopProcess(child, 2000).catch(() => {});
    if (temp) await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

/**
 * The height the person asked for, or nothing — in which case the panel is as
 * tall as whatever it is standing next to.
 * @param {import('../types.js').WatchOptions} watch
 * @returns {number|null}
 */
function askedHeight(watch) {
  const asked = Number(watch?.height);
  return Number.isFinite(asked) && asked > 0 ? Math.round(asked) : null;
}

/**
 * Will this app put a window on the screen at all?
 *
 * A headless browser has a window on paper and nothing on the screen, and
 * snapping the panel against one would leave it hugging thin air.
 *
 * @param {import('../types.js').AppConfig|undefined} app
 * @returns {boolean}
 */
function appHasAWindow(app) {
  if (!app) return false;
  if (app.kind === 'electron') return true;
  return app.headless === false;
}

/**
 * Where the panel goes before the app is open.
 *
 * `snapTo` places it properly once the app's real window can be measured, so
 * this only has to be close: given the size the app is expected to be, it opens
 * within a few pixels of where it will stay, and the correction is a nudge
 * rather than a leap across the screen.
 *
 * @param {import('./place.js').Bounds} screen
 * @param {{width: number, height: number}} size
 * @param {import('../types.js').WatchOptions} watch
 * @param {{width: number, height: number}|null} [expectedApp]
 * @returns {import('./place.js').Bounds}
 */
function firstPlace(screen, size, watch, expectedApp = null) {
  const plan = planPlacement({
    screen,
    appSize: expectedApp,
    panelWidth: size.width,
    side: watch?.side === 'left' ? 'left' : 'right',
    gap: GAP,
  });
  const height = askedHeight(watch);
  return height ? { ...plan.panel, height: Math.min(height, screen.height) } : plan.panel;
}

/**
 * @param {import('../types.js').PageHandle} page
 * @param {number} deadline epoch ms
 * @returns {Promise<void>}
 */
async function waitForPanelReady(page, deadline) {
  for (;;) {
    const ready = await page.evaluate('typeof window.__staysfixed_push === "function"').catch(() => false);
    if (ready === true) return;
    if (Date.now() > deadline) throw new Error('the panel page never finished loading');
    await delay(80);
  }
}

/**
 * Add the one thing the page cannot work out for itself: the verdict, in the
 * exact words the terminal prints. Those sentences live in one place
 * (`verdictFor`) and this is how the window gets them.
 * @param {import('../types.js').RunEvent} event
 * @returns {any}
 */
function enrich(event) {
  if (event.type !== 'run:done' || !event.summary) return event;
  try {
    return { ...event, verdict: verdictFor(event.summary) };
  } catch {
    // A summary we cannot read still deserves to reach the window.
    return event;
  }
}

/**
 * @param {{
 *   cdp: import('../types.js').CdpSession,
 *   page: import('../types.js').PageHandle,
 *   sessionId: string,
 *   child: import('node:child_process').ChildProcess,
 *   temp: string,
 *   url: string,
 *   keepOpen: boolean,
 *   project: import('../types.js').Project|null,
 *   side: 'left'|'right',
 *   panelWidth: number,
 *   askedHeight: number|null,
 *   placed: import('./place.js').Bounds,
 *   byHand: boolean,
 *   foreground: boolean,
 * }} ctx
 * @returns {Panel}
 */
function makePanel(ctx) {
  /** @type {any[]} */
  const queue = [];
  let sending = false;
  let dead = false;

  /** Where we last put the window ourselves — or where the person last left it. */
  let placed = ctx.placed;
  /** Once this is true, nothing in here moves the window again. */
  let byHand = ctx.byHand;
  /** The snap happens once a run, whether or not it worked. */
  let snapped = false;

  // A window we leave up owns its folder until the browser finally exits.
  ctx.child.once('exit', () => {
    fsp.rm(ctx.temp, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * When updates arrive faster than the window can take them, it is the
   * pictures of the ones already overtaken that go — never the words, never an
   * outcome. A row that stayed on "running" would be a lie; a missing thumbnail
   * is a picture nobody had time to look at anyway.
   */
  function trimQueue() {
    for (let i = 0; i < queue.length - KEEP_PICTURES; i++) {
      const event = queue[i];
      if (!event.thumbnail && !event.approvedThumb && !event.diffThumb) continue;
      queue[i] = { ...event, thumbnail: undefined, approvedThumb: undefined, diffThumb: undefined };
    }
  }

  /**
   * One call, however many updates are waiting. The page is handed JSON as a
   * string and parses it itself, so nothing a screen name contains can ever be
   * read as code.
   * @param {any[]} batch
   * @returns {Promise<void>}
   */
  async function send(batch) {
    const payload = JSON.stringify(JSON.stringify(batch));
    await ctx.page.evaluate(
      '(function(){var list;try{list=JSON.parse(' +
        payload +
        ');}catch(e){return 0;}' +
        'if(typeof window.__staysfixed_push!=="function")return 0;' +
        'for(var i=0;i<list.length;i++){window.__staysfixed_push(list[i]);}' +
        'return list.length;})()',
    );
  }

  async function drain() {
    if (sending || dead) return;
    sending = true;
    try {
      while (queue.length > 0 && !dead) {
        // Taken off the queue before it is sent, on purpose: an update that
        // fails is dropped, never retried into a run it would hold up.
        const batch = queue.splice(0, MAX_BATCH);
        try {
          await send(batch);
        } catch {
          // Usually the person closed the window. Stop rather than complain
          // once a second for the rest of the run.
          if (!ctx.cdp.isOpen()) dead = true;
        }
      }
    } finally {
      sending = false;
    }
  }

  /**
   * Has the person taken hold of the window since we last put it somewhere?
   * @returns {Promise<boolean>}
   */
  async function handHasIt() {
    if (byHand) return true;
    const seen = await readHandMove(ctx.page);
    if (seen.moved) {
      byHand = true;
      if (seen.bounds) placed = seen.bounds;
    }
    return byHand;
  }

  /**
   * Put the app hard against its edge of the screen and the panel flush against
   * it, so the two of them read as one window with a side panel.
   *
   * Once a run, and never over the top of a window the person has already moved:
   * a window somebody has arranged is theirs, and a tool that drags it back is a
   * tool you close. Everything here is best-effort — a window that will not move
   * is a disappointment, never a failed check.
   *
   * @param {import('../types.js').LaunchedApp} app
   * @returns {Promise<void>}
   */
  async function snapTo(app) {
    if (dead || snapped) return;
    snapped = true;
    try {
      if (await handHasIt()) return;

      // Moving windows can pull one to the front. Note who has the screen so it
      // can be handed back, the same way opening the panel does.
      const previousApp = ctx.foreground ? null : await frontmostApp();

      const screen = await readScreen(ctx.page);
      // A headless browser reports a window with a size and shows nothing, so it
      // is treated as no window at all: the panel takes the screen edge instead.
      const appPage = appHasAWindow(ctx.project?.config?.app) ? (app.page ?? null) : null;
      // Ask the protocol first and the page second: a browser answers the first,
      // and a desktop app only ever answers the second.
      const current = appPage ? ((await readWindowBounds(appPage)) ?? (await readPageWindow(appPage))) : null;

      const plan = planPlacement({
        screen,
        // Its own size, always. The size of the app's window is part of what the
        // pictures are of, so this may move it and may never resize it.
        appSize: current ? { width: current.width, height: current.height } : null,
        panelWidth: ctx.panelWidth,
        side: ctx.side,
        gap: GAP,
      });

      if (plan.app && current && !fitsAlongside(screen, current, ctx.panelWidth)) {
        // Said out loud, because otherwise part of the app quietly hangs off the
        // screen and it looks like something went wrong.
        detail(
          `the app's window is ${current.width} wide and the panel is ${ctx.panelWidth}, ` +
            `which is more than this ${screen.width} screen: part of the app sits off the edge. ` +
            'A narrower panel (--watch-width) or a smaller app window fixes it.',
        );
      }

      let moved = false;
      if (plan.app && appPage && current) {
        // Two ways to move a window, tried in order. A web app is driven by a
        // browser, which does it over the protocol; a desktop app is Electron,
        // which cannot, and on a Mac goes through macOS instead. `app.pid` is
        // the process this run started — an app we merely attached to has none,
        // and is left exactly where its owner put it.
        moved = await moveWindow(appPage, plan.app);
        if (!moved && typeof app.pid === 'number') moved = await moveMacWindow(app.pid, current, plan.app);
        if (moved) {
          // Some windows take the call and ignore it. Believe the window, not
          // the answer it gave.
          const after = (await readPageWindow(appPage)) ?? (await readWindowBounds(appPage));
          if (after) moved = Math.abs(after.left - plan.app.left) <= MOVE_TOLERANCE * 2;
        }
      }

      // Flush against the app either way: against where we put it if it moved,
      // and against where it stands if it would not budge. Only with no app
      // window to find at all does the panel fall back to the screen's edge.
      const target = moved
        ? plan.panel
        : current
          ? panelBeside(current, screen, ctx.panelWidth, ctx.side)
          : planPlacement({ screen, appSize: null, panelWidth: ctx.panelWidth, side: ctx.side, gap: GAP }).panel;
      const bounds = ctx.askedHeight
        ? { ...target, height: Math.min(ctx.askedHeight, screen.height) }
        : target;

      if (await moveWindow(ctx.page, bounds)) {
        placed = bounds;
        // Tell the page where we just put it, so our own move is not read as theirs.
        await watchForHandMove(ctx.page, bounds);
      }

      if (previousApp) await giveFocusBack(previousApp);
    } catch {
      // Where the windows sit is a nicety. It is never worth a failed run.
    }
  }

  /**
   * @param {import('../types.js').RunEvent} event
   * @returns {Promise<void>}
   */
  async function push(event) {
    if (dead || !event || typeof event !== 'object') return;
    queue.push(enrich(event));
    trimQueue();
    // Deliberately not awaited. A check must never wait on a window whose only
    // job is to be looked at.
    void drain();
  }

  /**
   * Let whatever is queued land, but not for long.
   * @returns {Promise<void>}
   */
  async function settle() {
    const deadline = Date.now() + 2000;
    while ((queue.length > 0 || sending) && !dead && Date.now() < deadline) {
      await drain();
      if (queue.length > 0) await delay(50);
    }
  }

  /** @type {Promise<void>|null} */
  let closing = null;

  /** @returns {Promise<void>} */
  function close() {
    closing ??= (async () => {
      await settle().catch(() => {});

      // Last look before the connection goes: if they moved it, that is where it
      // belongs from now on.
      try {
        const seen = await readHandMove(ctx.page);
        if (seen.moved && seen.bounds) {
          byHand = true;
          placed = seen.bounds;
        }
        if (byHand) await writeRemembered(ctx.project, placed, await readScreen(ctx.page));
      } catch {
        // A window that has already gone cannot say where it was.
      }
      await stopWatchingMoves(ctx.page);

      // Stop the clock in the page, so a window left up does not sit there
      // counting seconds next to a result that is already final.
      await ctx.page.evaluate('window.__staysfixed_detach && window.__staysfixed_detach()').catch(() => {});
      dead = true;

      try {
        await ctx.cdp.send('Target.detachFromTarget', { sessionId: ctx.sessionId });
      } catch {
        // The window may already be gone, which is where we were heading.
      }

      if (!ctx.keepOpen) {
        try {
          await ctx.cdp.send('Browser.close');
        } catch {
          // Asking politely can fail if it is already quitting.
        }
      }

      try {
        await ctx.cdp.close();
      } catch {
        // Hanging up cannot meaningfully fail.
      }

      if (ctx.keepOpen) {
        // Leave it up. The result is what the person opened the panel to read,
        // and it should still be there when they look over.
        return;
      }
      await stopProcess(ctx.child, 3000);
      await fsp.rm(ctx.temp, { recursive: true, force: true }).catch(() => {});
    })();
    return closing;
  }

  return { push, close, url: ctx.url, snapTo, placedByHand: () => byHand };
}
