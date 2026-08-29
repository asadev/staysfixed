/**
 * The watch window: one real window, beside the thing being checked, that redraws
 * itself while a check runs — and that a person can minimise, cover, move to
 * another desktop or close without the check noticing.
 *
 * That last sentence is the whole specification, and it is the owner's own:
 *
 *   "I don't want it to be completely invisible, then the user will not get to
 *    know what it is doing. That window should come up... But once we minimise
 *    it, it should keep working headless in the background. Not invisible. It
 *    should not keep bringing itself to the front."
 *
 * Four rules come out of that, and every awkward thing in this file is one of them.
 *
 * ONE. The check must never wait on the window. Every push is fire-and-forget with
 * a hard timeout on it, the queue lives on this side, and a window that is slow,
 * minimised, crashed or gone is a window that stops being pushed to — never a
 * check that stops. `push` returns nothing at all, so a caller cannot accidentally
 * await it.
 *
 * TWO. Minimised means minimised, not paused. A browser slows a hidden page's
 * timers right down, so anything the panel worked out on a clock of its own would
 * stall the moment you looked away. The fix is a division of labour: the ENGINE
 * works everything out and pushes it, the PANEL only draws. A page that has been
 * hidden for ten minutes catches up on one state message and has lost nothing.
 * When the queue backs up it is EVIDENCE that goes — pictures nobody had time to
 * look at — and never the newest state.
 *
 * THREE. It never takes the screen. Whoever was in front before this opened is put
 * back in front afterwards, and the same dance is exported so the adapters can use
 * it too — because the complaint that started all of this was not about this panel
 * at all, it was about an app, a simulator and an emulator jumping in front of him
 * while he worked.
 *
 * FOUR. It is our own window, not his. Chrome for Testing wherever there is one,
 * a throwaway profile every time, its own port, and nothing on this machine that
 * we did not start is ever touched.
 *
 * There is no server here and no port beyond the debugging one. The page is a
 * local file, opened as an app window — no tabs, no address bar — and every update
 * is one call into a function the page defines.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { warn, detail } from '../../core/log.js';
import { messageOf } from '../../core/errors.js';
import { waitForEndpoint, listTargets, connect } from '../../drive/cdp.js';
import { freePort } from '../../drive/find.js';
import { createPage } from '../../drive/page.js';
import { stopProcess, delay } from '../../drive/browser.js';
import { surveyBrowsers } from '../browsers.js';
import { planPlacement, panelBeside, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH } from '../../watch/place.js';

const execFileAsync = promisify(execFile);

/** @typedef {import('../../watch/place.js').Bounds} Bounds */
/** @typedef {import('./events.js').PanelEvent} PanelEvent */
/** @typedef {import('./events.js').PanelPlanShape} PanelPlan */

/** Every temp folder this file makes starts with this, so old ones can be found again. */
const TMP_PREFIX = 'staysfixed-v2-panel-';

/** A panel folder untouched for this long belongs to a window nobody has open any more. */
const STALE_MS = 24 * 60 * 60 * 1000;

/** How wide the panel is when nobody says otherwise. Legible down to 420. */
const DEFAULT_WIDTH = 480;

/** A panel shorter than this cannot show the state and the findings at the same time. */
const MIN_HEIGHT = 640;

/**
 * The gap between the app's edge and the panel's. None, on purpose: two windows
 * that touch read as one window, and a seam is what gives away that they are two
 * separate programs sitting next to each other.
 */
const GAP = 0;

/** How long to wait for the window to open before giving up on it. */
const OPEN_TIMEOUT_MS = 20_000;

/**
 * How long any one push may take before we stop waiting for it.
 *
 * This is the number that makes "the check never waits on the window" true rather
 * than merely intended. A minimised page, a page whose renderer has been suspended
 * by the operating system, a browser being swapped back in — all of them can make
 * one protocol call take seconds. After this we stop caring about that batch and
 * carry on. Deliberately short: nothing here is worth a second of a check's time.
 */
const PUSH_TIMEOUT_MS = 1500;

/** Updates sent in one call. More than this in flight means the run is outrunning the window. */
const MAX_BATCH = 32;

/**
 * The most updates that may be waiting at once.
 *
 * Past this the queue is folded down rather than grown: state messages collapse to
 * the newest, evidence is stripped, and only then are the oldest narrative lines
 * dropped. A check that runs for an hour behind a minimised window must not turn
 * into a hundred megabytes of queued JSON.
 */
const MAX_QUEUE = 600;

/** How many queued updates keep their pictures when the queue is backing up. */
const KEEP_EVIDENCE = 3;

/**
 * Pushes that may time out in a row before we treat the window as gone.
 *
 * Not one: a single slow call is a page being swapped back in, which is normal and
 * recovers. Several in a row is a window nobody is going to see again.
 */
const STALL_LIMIT = 8;

/**
 * The window's own background, painted before the document is. This must be the
 * panel's ground colour: it is the same surface, and a browser flashing white for
 * a fifth of a second is exactly what makes a purpose-built window look like a
 * browser tab.
 */
const GROUND = { r: 16, g: 16, b: 16, a: 1 };

/** A window off by less than this was nudged by a window manager, not by a person. */
const MOVE_TOLERANCE = 8;

/** How often the page looks at where it is. Slow on purpose: nobody is racing. */
const MOVE_WATCH_MS = 1000;

/** Where the window a person arranged is written down, inside the project's own folder. */
const REMEMBER_FILE = 'watch-window.json';

// ---------------------------------------------------------------------------
// Not taking the screen — the part the adapters need as much as this file does
// ---------------------------------------------------------------------------

/**
 * The name of the application currently in front, on macOS. Null anywhere else,
 * and null whenever the machine will not say.
 *
 * Call this BEFORE you open, boot, launch or move anything, and hand what it gives
 * you to `giveTheScreenBack` afterwards. Those two calls are the whole of the
 * promise that this tool does not take the screen out from under somebody.
 *
 * @returns {Promise<string|null>}
 */
export async function noteTheFrontmost() {
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
    // No Apple Events permission, or no window server at all. Not worth a word:
    // the worst case is that whatever we opened keeps the foreground, and the
    // person can click back. It is never worth failing a check over.
    return null;
  }
}

/**
 * Put the screen back where it was.
 *
 * The other half of `noteTheFrontmost`, and the one implementation of it —
 * the web, Electron, iOS, Android and Windows adapters all call this rather than
 * each writing their own AppleScript, because three copies of this is how one of
 * them ends up subtly not doing it.
 *
 * Safe to call with null, on any platform, at any time. Never throws.
 *
 * @param {string|null|undefined} who  Whatever `noteTheFrontmost` gave you.
 * @returns {Promise<void>}
 */
export async function giveTheScreenBack(who) {
  if (!who || process.platform !== 'darwin') return;
  try {
    await execFileAsync(
      'osascript',
      [
        '-e',
        `tell application "System Events" to set frontmost of first application process whose name is ${JSON.stringify(who)} to true`,
      ],
      { timeout: 4000 },
    );
    detail(`the screen was handed back to ${who}`);
  } catch {
    // Worst case whatever we opened keeps the foreground. Never a reason to fail.
  }
}

/**
 * Do something that might take the screen, and hand the screen back afterwards.
 *
 * The whole dance in one call, for the common case: booting a simulator, starting
 * a desktop app, moving a window. Whatever the work returns comes straight back
 * out, and the screen is handed back even when the work throws.
 *
 * @template T
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withoutTakingTheScreen(work) {
  const who = await noteTheFrontmost();
  try {
    return await work();
  } finally {
    await giveTheScreenBack(who);
  }
}

/**
 * How far past the corner of every screen an off-screen window is put.
 *
 * Big enough that no arrangement of real monitors reaches it — a wall of 8K panels
 * stacked up and to the left is still nowhere near — and small enough to stay a
 * sane whole number for a window manager to store.
 */
export const OFF_SCREEN_ORIGIN = -32_000;

/**
 * Coordinates that no display covers.
 *
 * This is the answer for anything that CANNOT be run without a window. Electron is
 * the case that matters: a desktop app has no headless mode, so the choice is a
 * window on somebody's screen or a window nowhere, and "nowhere" is the one that
 * lets him keep working. A window placed here still exists, still lays out, still
 * runs its code, still answers the debugging protocol and still photographs — the
 * picture comes from the compositor, which does not care where the window is — it
 * simply never appears in front of anybody.
 *
 * Above and to the left, never below and to the right. A second monitor is nearly
 * always placed to the right or above the main one and nearly never thirty
 * thousand pixels away, so the negative corner is the one that stays empty. The
 * whole window is put past the corner, not just its origin, so not even a title
 * bar shows.
 *
 * Pass `displays` when you actually know where the screens are and the window goes
 * just past the furthest one instead, which is gentler on a window manager that
 * dislikes very large numbers.
 *
 * @param {{width?: number, height?: number}} [size]  The window's size. Its position is ignored.
 * @param {Bounds[]} [displays]  Every screen, when the caller can measure them.
 * @returns {Bounds}  Same size, somewhere nobody can see.
 */
export function offScreen(size, displays) {
  const width = Math.max(1, Math.round(Number(size?.width) || 1280));
  const height = Math.max(1, Math.round(Number(size?.height) || 800));

  let left = OFF_SCREEN_ORIGIN;
  let top = OFF_SCREEN_ORIGIN;
  const known = (displays ?? []).filter((d) => d && Number.isFinite(Number(d.left)) && Number.isFinite(Number(d.top)));
  if (known.length > 0) {
    const margin = 200;
    left = Math.min(...known.map((d) => Math.round(Number(d.left)))) - width - margin;
    top = Math.min(...known.map((d) => Math.round(Number(d.top)))) - height - margin;
  }
  return { left, top, width, height, x: left, y: top };
}

/**
 * Is this window somewhere nobody can see it?
 *
 * For an adapter that wants to say so out loud — "the app ran off-screen, so
 * nothing appeared in front of you" is worth a line in a report, and a claim
 * nobody checked is worth nothing.
 *
 * @param {Bounds|null|undefined} bounds
 * @param {Bounds[]} [displays]
 * @returns {boolean}
 */
export function isOffScreen(bounds, displays) {
  if (!bounds) return false;
  const right = Number(bounds.left) + Number(bounds.width);
  const bottom = Number(bounds.top) + Number(bounds.height);
  const screens = displays ?? [];
  if (screens.length === 0) return right <= 0 || bottom <= 0;
  return !screens.some((screen) => {
    const sr = Number(screen.left) + Number(screen.width);
    const sb = Number(screen.top) + Number(screen.height);
    return right > Number(screen.left) && Number(bounds.left) < sr && bottom > Number(screen.top) && Number(bounds.top) < sb;
  });
}

/**
 * Move a window through macOS itself, naming the process by its unix id.
 *
 * The way to put a window somewhere when the thing owning it cannot be asked.
 * Electron does not implement the part of the debugging protocol that moves
 * windows — `Browser.getWindowForTarget` is simply not there — so a desktop app
 * cannot be placed over the connection, and placing it is the entire point of
 * `offScreen`.
 *
 * Two hard rules, both learned the expensive way. It names the process BY ITS
 * UNIX ID, never by its name: a person's own copy of an app and the scratch copy
 * under test have the same name, and a script that says `process "Terminal Deck"`
 * moves whichever one macOS hands it. And it moves only the window that is exactly
 * where the caller says it is, so an app with a second window open keeps it where
 * it was.
 *
 * Position only. The size of a window being observed is part of what is being
 * observed, and is never ours to change.
 *
 * @param {number} pid       The process THIS run started. Never one we attached to.
 * @param {Bounds} current   Where the window is now.
 * @param {{left: number, top: number}} target
 * @returns {Promise<boolean>}
 */
export async function moveWindowByPid(pid, current, target) {
  if (process.platform !== 'darwin') return false;
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) return false;
  const script = [
    `tell application "System Events" to tell (first application process whose unix id is ${Math.round(pid)})`,
    '  repeat with w in windows',
    `    if (item 1 of (get position of w)) is ${Math.round(current.left)} and (item 2 of (get position of w)) is ${Math.round(current.top)} then`,
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
    // scripted. Report it as not moved and let the caller say so.
    return false;
  }
}

// ---------------------------------------------------------------------------
// The screen, and the windows standing on it
// ---------------------------------------------------------------------------

/**
 * A window we can move: anything with a debugging connection and a target on it.
 * @typedef {object} WindowRef
 * @property {(method: string, params?: Record<string, unknown>) => Promise<any>} send
 * @property {string} targetId
 */

/**
 * The usable screen area, in screen pixels — menu bar and dock already taken off.
 *
 * Always ask the PANEL's page and never the app's: an app being observed is often
 * told it is on a screen exactly the size of the viewport we asked for, which is
 * what makes an observation the same on every machine, and is also why it is the
 * last thing to ask how big the real screen is.
 *
 * @param {{evaluate: (js: string) => Promise<any>}} page  The panel's page.
 * @returns {Promise<Bounds>}
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
 * Where a window is right now, over the debugging protocol. Null when the target
 * will not say — which is every Electron window there has ever been.
 * @param {WindowRef} page
 * @returns {Promise<Bounds|null>}
 */
export async function readWindowBounds(page) {
  try {
    const found = await page.send('Browser.getWindowForTarget', { targetId: page.targetId });
    const bounds = found?.bounds;
    if (!bounds) return null;
    const width = Math.round(Number(bounds.width));
    const height = Math.round(Number(bounds.height));
    if (!(width > 0) || !(height > 0)) return null;
    return {
      left: Math.round(Number(bounds.left) || 0),
      top: Math.round(Number(bounds.top) || 0),
      width,
      height,
    };
  } catch {
    return null;
  }
}

/**
 * Where a window is, as its own page sees it.
 *
 * `screenX`, `screenY`, `outerWidth` and `outerHeight` describe the window rather
 * than the page, and they keep describing the window even with a device-metrics
 * override applied. This is the only measurement a desktop app will give at all.
 *
 * @param {{evaluate: (js: string) => Promise<any>}} page
 * @returns {Promise<Bounds|null>}
 */
export async function readPageWindow(page) {
  try {
    const raw = await page.evaluate(
      '({left:window.screenX,top:window.screenY,width:window.outerWidth,height:window.outerHeight})',
    );
    if (!raw || typeof raw !== 'object') return null;
    const width = Math.round(Number(raw.width));
    const height = Math.round(Number(raw.height));
    if (!(width > 0) || !(height > 0)) return null;
    return {
      left: Math.round(Number(raw.left) || 0),
      top: Math.round(Number(raw.top) || 0),
      width,
      height,
    };
  } catch {
    return null;
  }
}

/**
 * Move a window, and say whether it went.
 *
 * Never throws. Not every window can be moved — Electron builds differ on this,
 * and a window manager is entitled to say no — and where a window sits is a nicety
 * that is never worth a failed check, nor a warning in the middle of a clean one.
 *
 * @param {WindowRef} page
 * @param {Bounds} bounds
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

// ---------------------------------------------------------------------------
// Where the panel opens
// ---------------------------------------------------------------------------

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
 * The opening guess: how big the panel is, and where it goes before anything knows
 * how big the screen is.
 *
 * Only a window can say what screen it is on, and there is no window yet when this
 * is called — so the thing being checked is taken to be sitting in the top left
 * corner and the panel is put beside it. `snapTo` replaces this with the real
 * placement the moment there is something to sit beside.
 *
 * Pure on purpose, so the arithmetic can be checked without opening anything.
 *
 * @param {{width?: number, height?: number}} [appViewport]
 * @param {import('../../types.js').WatchOptions} [watch]
 * @returns {{width: number, height: number, x: number, y: number}}
 */
export function panelBounds(appViewport, watch) {
  const opts = watch ?? {};
  const appWidth = Math.round(Number(appViewport?.width) || 1280);
  const appHeight = Math.round(Number(appViewport?.height) || 800);

  const asked = Number(opts.width);
  const width = clamp(
    Math.round(Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_WIDTH),
    PANEL_MIN_WIDTH,
    PANEL_MAX_WIDTH,
  );

  const askedTall = Number(opts.height);
  const height = Math.max(
    MIN_HEIGHT,
    Math.round(Number.isFinite(askedTall) && askedTall > 0 ? askedTall : appHeight),
  );

  const plan = planPlacement({
    // A screen exactly big enough for the two of them, because there is no real
    // one to ask yet. It keeps the windows adjacent and keeps every bit of the
    // arithmetic in one file.
    screen: { left: 0, top: 0, width: appWidth + GAP + width, height: Math.max(appHeight, height) },
    appSize: { width: appWidth, height: appHeight },
    panelWidth: width,
    // `watch.side` names the side the PANEL goes on; `planPlacement` names the
    // screen edge the APP is pinned to. With the app assumed to be in the corner
    // those are the same arrangement said from opposite ends.
    side: opts.side === 'left' ? 'right' : 'left',
    gap: GAP,
  });

  return { width, height, x: plan.panel.left, y: plan.panel.top };
}

/**
 * The height the person asked for, or nothing — in which case the panel is as tall
 * as whatever it is standing next to.
 * @param {import('../../types.js').WatchOptions|undefined} watch
 * @returns {number|null}
 */
function askedHeight(watch) {
  const asked = Number(watch?.height);
  return Number.isFinite(asked) && asked > 0 ? Math.round(asked) : null;
}

/**
 * Where the panel goes before there is anything to sit beside.
 *
 * @param {Bounds} screen
 * @param {{width: number, height: number}} size
 * @param {import('../../types.js').WatchOptions|undefined} watch
 * @param {{width: number, height: number}|null} [expectedApp]
 * @returns {Bounds}
 */
function firstPlace(screen, size, watch, expectedApp = null) {
  const plan = planPlacement({
    screen,
    appSize: expectedApp,
    panelWidth: size.width,
    side: watch?.side === 'left' ? 'left' : 'right',
    gap: GAP,
  });
  const tall = askedHeight(watch);
  return tall ? { ...plan.panel, height: Math.min(tall, screen.height) } : plan.panel;
}

/**
 * Would this window still make sense on this screen?
 * @param {Bounds} bounds
 * @param {Bounds} screen
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
 * @param {string|null|undefined} dir
 * @returns {Promise<Bounds|null>}
 */
async function readRemembered(dir) {
  if (!dir) return null;
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(dir, REMEMBER_FILE), 'utf8'));
    const width = Math.round(Number(raw?.width));
    const height = Math.round(Number(raw?.height));
    if (!(width > 0) || !(height > 0)) return null;
    return {
      left: Math.round(Number(raw.left) || 0),
      top: Math.round(Number(raw.top) || 0),
      width,
      height,
    };
  } catch {
    // No file, or a file somebody has been editing. Either way: place it ourselves.
    return null;
  }
}

/**
 * Write down where the person left the window.
 *
 * A window somebody has arranged is theirs, and it should still be theirs
 * tomorrow. The screen is written down beside it so a position remembered from a
 * second monitor can be recognised and ignored.
 *
 * @param {string|null|undefined} dir
 * @param {Bounds} bounds
 * @param {Bounds} screen
 * @returns {Promise<void>}
 */
async function writeRemembered(dir, bounds, screen) {
  if (!dir) return;
  try {
    await fsp.mkdir(dir, { recursive: true });
    const body = { ...bounds, screen, at: new Date().toISOString() };
    await fsp.writeFile(path.join(dir, REMEMBER_FILE), JSON.stringify(body, null, 2) + '\n');
  } catch {
    // Remembering is a courtesy. A read-only folder is not a failed check.
  }
}

// ---------------------------------------------------------------------------
// The page inside the window
// ---------------------------------------------------------------------------

/**
 * The panel's own document.
 *
 * The design of that page belongs in `panel.js` next door — the look the owner chose after
 * seeing four rendered side by side, and corrected twice — and the words it draws belong in
 * `events.js`. This file only puts the result in a window.
 *
 * Asked for by name rather than imported at the top, and with a stand-in behind it, for one
 * reason: a window that cannot be built must never be a check that cannot run. That has to
 * hold for a page with a mistake in it exactly as much as it holds for a machine with no
 * browser on it, and a plain `import` would take the whole tool down with the page.
 *
 * @param {PanelPlan} plan
 * @returns {Promise<string>}
 */
async function documentFor(plan) {
  // Deliberately not a literal specifier: this has to typecheck, load and run whether or not
  // the designed page is there.
  const beside = new URL('./panel.js', import.meta.url).href;
  try {
    const mod = /** @type {Record<string, unknown>} */ (await import(beside));
    const make = mod.panelHtml;
    if (typeof make === 'function') {
      const html = /** @type {(p: PanelPlan) => unknown} */ (make)(plan);
      if (typeof html === 'string' && html.length > 0) return html;
    }
    detail('watch window: panel.js did not hand back a page, so the plain one is being used.');
  } catch (e) {
    detail(`watch window: the panel page could not be built, so the plain one is being used. ${messageOf(e)}`);
  }
  return plainPanelHtml(plan);
}

/**
 * The stand-in page: what opens when the designed panel could not be built.
 *
 * Deliberately the least that is honest — what is being checked, the plain-English line for
 * everything that has happened, and the verdict when there is one. It borrows the palette and
 * the restraint from the real panel, so a window that has fallen back to this still looks like
 * part of the same tool, and it says at the top that it IS the fallback rather than letting
 * somebody think this is the product.
 *
 * Self-contained by rule: inline style, inline script, no address of any kind in it, no
 * framework, nothing to fetch.
 *
 * @param {PanelPlan} plan
 * @returns {string}
 */
export function plainPanelHtml(plan = {}) {
  const wanted = String(plan.theme ?? 'dark');
  const theme = wanted === 'light' || wanted === 'system' ? wanted : 'dark';
  const product = String(plan.product ?? '').trim() || 'this product';
  const surfaces = (plan.surfaces ?? []).map((w) => String(w)).filter(Boolean).join(' \u00b7 ');
  // Embedded as a JSON string the page parses, so nothing a journey is called can ever be read
  // as code.
  const seed = JSON.stringify(JSON.stringify({ product, surfaces })).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stays Fixed</title>
<style>
:root {
  color-scheme: dark;
  --ground: #101010; --card: rgba(255,255,255,0.035);
  --ink: #ededed; --soft: #b2b2b2; --faint: #8d8d8d; --faintest: #6d6d6d;
  --line: rgba(255,255,255,0.055);
  --accent: #4fb3f0; --held: #25d366; --broke: #ff4438; --doubt: #e8b85c;
  --resting: rgba(255,255,255,0.09);
}
:root[data-theme='light'], :root[data-theme='system'] {
  color-scheme: light;
  --ground: #d9dade; --card: rgba(255,255,255,0.6);
  --ink: #14161a; --soft: #545a62; --faint: #5e646c; --faintest: #6f757d;
  --line: rgba(20,22,26,0.11);
  --accent: #474d56; --held: #757b83; --broke: #7e1105; --doubt: #8a5f06;
  --resting: rgba(20,22,26,0.13);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  background: var(--ground); color: var(--ink); overflow: hidden;
  font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
.panel { display: flex; flex-direction: column; height: 100%; }
.top { padding: 16px; border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 8px; font-size: 10px; letter-spacing: 0.13em; text-transform: uppercase; color: var(--faint); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: 0 0 auto; }
.dot.held { background: var(--held); } .dot.broke { background: var(--broke); } .dot.rest { background: var(--resting); }
h1 { margin: 8px 0 2px; font-size: 18px; font-weight: 560; letter-spacing: -0.01em; }
.sub { margin: 0; font-size: 11.5px; color: var(--soft); }
.note { margin-top: 10px; padding: 9px 11px; border-radius: 8px; background: var(--card);
  box-shadow: inset 2px 0 0 var(--doubt), inset 0 0 0 1px var(--line); font-size: 11.5px; color: var(--soft); }
.body { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; padding: 8px 12px 14px; }
.row { display: flex; gap: 9px; align-items: baseline; padding: 6px 4px; }
.row + .row { box-shadow: inset 0 1px 0 var(--line); }
.row .t { color: var(--faintest); font-size: 11px; flex: 0 0 46px; }
.row .m { flex: 1 1 auto; font-size: 11.5px; color: var(--soft); overflow-wrap: anywhere; }
.row.last .m { color: var(--ink); }
.foot { border-top: 1px solid var(--line); padding: 10px 16px; font-size: 11px; color: var(--faint);
  display: flex; justify-content: space-between; align-items: center; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
</style>
</head>
<body>
<div class="panel">
  <div class="top">
    <div class="brand"><span class="dot" id="dot"></span><span>Stays Fixed</span></div>
    <h1 id="head">this product</h1>
    <p class="sub" id="sub"></p>
    <div class="note">This is the plain window. The designed panel could not be built on this
      machine, so what you are looking at is every line the check has said, in order. The check
      itself is unaffected.</div>
  </div>
  <div class="body" id="lines"></div>
  <div class="foot"><span id="verdict">Running</span><span class="mono" id="clock">0.0s</span></div>
</div>
<script>
(function () {
  var seed = {};
  try { seed = JSON.parse(${seed}); } catch (e) { seed = {}; }
  var lines = [];
  var done = null;
  var detached = false;
  var el = function (id) { return document.getElementById(id); };
  function text(node, value) { node.textContent = value == null ? '' : String(value); }

  text(el('head'), seed.product || 'this product');
  text(el('sub'), seed.surfaces || '');

  function draw() {
    var host = el('lines');
    host.textContent = '';
    for (var i = 0; i < lines.length; i++) {
      var r = document.createElement('div');
      r.className = 'row' + (i === lines.length - 1 ? ' last' : '');
      var t = document.createElement('div');
      t.className = 't mono';
      text(t, (Math.round((lines[i].at || 0) / 100) / 10).toFixed(1) + 's');
      var m = document.createElement('div');
      m.className = 'm';
      text(m, lines[i].message);
      r.appendChild(t); r.appendChild(m);
      host.appendChild(r);
    }
    host.scrollTop = host.scrollHeight;
    var dot = el('dot');
    dot.className = 'dot' + (done ? (done.ok ? ' held' : ' broke') : '');
    if (done) text(el('verdict'), done.summary || (done.ok ? 'Nothing that worked has changed.' : 'Something changed.'));
  }

  var ticking = null;
  function schedule() {
    if (ticking) return;
    ticking = requestAnimationFrame(function () { ticking = null; draw(); });
  }

  window.__staysfixed_push = function (input) {
    if (detached || !input || typeof input !== 'object') return;
    if (input.type === 'check:done' && input.verdict) done = input.verdict;
    if (typeof input.message === 'string' && input.message.length > 0) {
      lines.push({ at: input.at || 0, message: input.message });
      if (lines.length > 500) lines.splice(0, lines.length - 500);
    }
    schedule();
  };
  window.__staysfixed_detach = function () { detached = true; };

  // The clock is the one thing here on a timer, and it is the one thing allowed to be wrong
  // while the window is hidden: a browser slows a hidden page right down. Everything that
  // matters is worked out by the engine and pushed, so nothing else can drift at all.
  var born = Date.now();
  setInterval(function () {
    if (detached) return;
    var ms = done ? (done.durationMs || 0) : Date.now() - born;
    text(el('clock'), (Math.round(ms / 100) / 10).toFixed(1) + 's');
  }, 200);

  draw();
})();
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Opening it
// ---------------------------------------------------------------------------

/**
 * A watch window that is open and listening.
 *
 * `push` hands back nothing on purpose. There is no promise here to accidentally
 * await, no error to accidentally catch, and therefore no way for a check to end
 * up waiting on a window.
 *
 * @typedef {object} Panel
 * @property {(event: PanelEvent) => void} push
 * @property {() => Promise<void>} close
 * @property {string} url
 * @property {(beside: BesideThis) => Promise<void>} snapTo
 * @property {() => boolean} placedByHand
 * @property {() => PanelHealth} health
 */

/**
 * How the window is bearing up. For the check's own report, and for tests: a
 * claim that the panel never held the run up is worth having a number behind.
 *
 * @typedef {object} PanelHealth
 * @property {boolean} alive       We still think there is a window to push to.
 * @property {number} pushed       Events handed over.
 * @property {number} delivered    Events the window actually took.
 * @property {number} dropped      Events folded away because the queue was backing up.
 * @property {number} stalls       Pushes that ran past their timeout and were abandoned.
 * @property {number} queued       Waiting right now.
 */

/**
 * Something for the panel to sit beside.
 *
 * Every field optional, because what an adapter can offer differs: a browser
 * answers the debugging protocol, a desktop app answers only its own page, and a
 * phone answers neither.
 *
 * @typedef {object} BesideThis
 * @property {number|null} [pid]   The process THIS run started. Never one we attached to.
 * @property {any} [page]          Its page, when it has one we can ask.
 * @property {Bounds} [window]     Where its window is, when the caller already knows.
 * @property {boolean} [hasWindow] False for anything headless, which is most things.
 */

/**
 * @typedef {object} OpenPanelOptions
 * @property {PanelPlan} [plan]
 * @property {import('../../types.js').WatchOptions} [watch]
 * @property {string} [dir]   Where to remember the window position. The project's own folder.
 * @property {{width: number, height: number}} [appViewport]
 * @property {AbortSignal} [signal]  Give up on opening. See `givenUp` below.
 */

/**
 * Giving up on a window that is still opening.
 *
 * A window takes a second or two to appear, and on a busy machine it takes longer. A check
 * that finishes inside that — a small check, or a check somebody stopped — must not then sit
 * waiting for a window it no longer wants. Worse, every one of the three waits below holds
 * the program open on a timer, so without this a finished run keeps the terminal for another
 * twenty seconds with nothing left to say.
 *
 * So opening takes a signal. When it is raised every wait stops at once, the browser we
 * started is stopped, the throwaway folder goes, and `openPanel` hands back null exactly as
 * it does for a machine with no browser on it. Nothing is reported: this is somebody
 * finishing, not something going wrong.
 *
 * @param {AbortSignal|undefined} signal
 * @returns {boolean}
 */
function givenUp(signal) {
  return signal?.aborted === true;
}

/** Thrown to leave the opening sequence when the caller has given up. Never shown to anybody. */
const GIVEN_UP = 'the watch window was given up on before it opened';

/**
 * The flags. Short, because nothing here is being observed: the panel needs a
 * clean window, a profile of its own, and nothing on it that says "browser".
 *
 * The three throttling flags at the end are the ones this file exists for. A
 * window sitting behind another one, or minimised, normally has its timers slowed
 * to a crawl and its renderer put to sleep; these keep it awake enough to take an
 * update. They are a courtesy, not the guarantee — the guarantee is that the
 * engine holds the state and the page only draws, so a page that DOES fall asleep
 * loses nothing.
 *
 * @param {{port: number, profileDir: string, url: string, bounds: Bounds}} ctx
 * @returns {string[]}
 */
function panelArgs(ctx) {
  return [
    `--remote-debugging-port=${ctx.port}`,
    // Node's WebSocket sends no Origin header, and recent Chrome refuses a socket
    // from an unknown one.
    '--remote-allow-origins=*',
    // Never the browser the person actually uses: their tabs, their extensions,
    // their signed-in session. This one is thrown away afterwards.
    `--user-data-dir=${ctx.profileDir}`,
    // An app window: no tabs, no address bar, nothing but the panel.
    `--app=${ctx.url}`,
    `--window-size=${ctx.bounds.width},${ctx.bounds.height}`,
    `--window-position=${ctx.bounds.left},${ctx.bounds.top}`,
    // Everything a browser puts on a window that this is not.
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
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
}

/**
 * Take away the folders left by panels that were kept open and then closed by
 * hand. A window we leave up owns its profile until the browser exits, and by then
 * this process is usually gone, so the tidying happens next time instead.
 * @returns {Promise<void>}
 */
async function sweepOldPanels() {
  try {
    const parent = os.tmpdir();
    const now = Date.now();
    for (const name of await fsp.readdir(parent)) {
      if (!name.startsWith(TMP_PREFIX)) continue;
      const full = path.join(parent, name);
      // The profile is what a live browser keeps writing to, so it is the honest
      // measure of whether anyone still has this window open.
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
 * @param {AbortSignal} [signal]
 * @returns {Promise<any>}
 */
async function findPanelTarget(endpoint, deadline, signal) {
  for (;;) {
    if (givenUp(signal)) return null;
    const targets = /** @type {any[]} */ (await listTargets(endpoint).catch(() => []));
    const hit = targets.find((t) => t && t.type === 'page' && String(t.url ?? '').startsWith('file://'));
    if (hit) return hit;
    if (Date.now() > deadline || givenUp(signal)) return null;
    await delay(120);
  }
}

/**
 * Paint the window's own background before the document paints its own, and tell
 * it which look to use.
 *
 * The panel opens on a brand new browser profile, and a fresh profile answers
 * "which colour scheme do you prefer" with "light" however the computer around it
 * is set — so the look is stated rather than asked for.
 *
 * @param {{send: (method: string, params?: Record<string, unknown>) => Promise<any>}} page
 * @param {'dark'|'light'|'system'} theme
 * @returns {Promise<void>}
 */
async function darkenWindow(page, theme) {
  try {
    await page.send('Emulation.setDefaultBackgroundColorOverride', { color: GROUND });
  } catch {
    // An older build without it just flashes. Not worth a word.
  }
  if (theme === 'system') return;
  try {
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: theme }],
    });
  } catch (e) {
    detail(`watch window: could not set the look. ${messageOf(e)}`);
  }
}

/**
 * Watch the panel's window for a hand on it.
 *
 * The page checks its own position on a slow interval — four numbers, once a
 * second, no protocol traffic at all — and remembers the moment they stop matching
 * what we last set. Reading that is then one call, made only when we are about to
 * move the window or write down where it ended up.
 *
 * @param {{evaluate: (js: string) => Promise<any>}} page
 * @param {Bounds} expected  Where we have just put it.
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
 * @returns {Promise<{moved: boolean, bounds: Bounds|null}>}
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
 * @param {{evaluate: (js: string) => Promise<any>}} page
 * @param {number} deadline epoch ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
async function waitForPanelReady(page, deadline, signal) {
  for (;;) {
    if (givenUp(signal)) throw new Error(GIVEN_UP);
    const ready = await page.evaluate('typeof window.__staysfixed_push === "function"').catch(() => false);
    if (ready === true) return;
    if (givenUp(signal)) throw new Error(GIVEN_UP);
    if (Date.now() > deadline) throw new Error('the panel page never finished loading');
    await delay(80);
  }
}

/**
 * The browser to open the panel with.
 *
 * Chrome for Testing wherever there is one — it is a separate application from
 * the browser he uses, so opening it cannot take his own browser over. His own is
 * the last resort, and even then it gets a throwaway profile of its own and is a
 * separate process, so his tabs and his session are never touched.
 *
 * @returns {Promise<{binary: string, name: string, borrowed: boolean}|null>}
 */
async function browserForPanel() {
  try {
    // A window that shows nothing is no use for a panel, so the headless-only
    // shells are dropped by asking for a visible one.
    const survey = await surveyBrowsers({ headless: false });
    const chosen = survey.chosen;
    if (!chosen) return null;
    return { binary: chosen.binary, name: chosen.name, borrowed: chosen.everyday === true };
  } catch {
    return null;
  }
}

/**
 * Open the watch window.
 *
 * Returns null — never throws — when there is no browser to open it with, or the
 * window will not start. A check without a live view is a check; a check that
 * failed because its live view failed would be indefensible.
 *
 * @param {OpenPanelOptions} [opts]
 * @returns {Promise<Panel|null>}
 */
export async function openPanel(opts = {}) {
  const watch = opts.watch ?? {};
  const signal = opts.signal;
  if (givenUp(signal)) return null;
  const theme = /** @type {'dark'|'light'|'system'} */ (
    watch.theme === 'light' || watch.theme === 'system' ? watch.theme : 'dark'
  );
  const chrome = await browserForPanel();
  if (!chrome) {
    warn(
      'There is no browser on this machine that the watch window can open, so this check has no live view. The check itself carries on as normal.',
    );
    return null;
  }
  if (chrome.borrowed) {
    detail(
      'The watch window is opening in your own browser, because there is no Chrome for Testing here. It gets a throwaway profile of its own, so your tabs and your session are untouched.',
    );
  }

  await sweepOldPanels();

  const size = panelBounds(opts.appViewport, watch);
  // Where it was left last time, if anywhere. Opening there is the difference
  // between a window that comes back and a window that jumps.
  const remembered = await readRemembered(opts.dir);
  const opening = remembered ?? { left: size.x, top: size.y, width: size.width, height: size.height };

  /** @type {string|null} */
  let temp = null;
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  /** @type {import('../../types.js').CdpSession|null} */
  let cdp = null;

  try {
    temp = await fsp.mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
    const pageFile = path.join(temp, 'panel.html');
    const profileDir = path.join(temp, 'profile');
    await fsp.mkdir(profileDir, { recursive: true });
    await fsp.writeFile(pageFile, await documentFor({ ...(opts.plan ?? {}), theme }));
    const url = pathToFileURL(pageFile).href;

    const port = await freePort();
    detail(`watch window: ${chrome.name}`);
    detail(`watch window port: ${port}`);

    // Remember who has the screen before anything opens, so it can be handed
    // straight back. `watch.foreground` is for when you WANT to watch it work.
    const previousApp = watch.foreground === true ? null : await noteTheFrontmost();

    child = spawn(chrome.binary, panelArgs({ port, profileDir, url, bounds: opening }), {
      // The window outlives this command when it is kept open, so it cannot be
      // tied to our process group or our pipes.
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    // A browser that dies later must not crash the check with an unhandled error.
    child.on('error', () => {});

    const endpoint = `http://127.0.0.1:${port}`;
    // Every wait from here down can be called off. A run that finishes while the window is
    // still coming up stops waiting the moment it says so, rather than holding the terminal
    // open for another twenty seconds over a window nobody wants any more.
    const version = await waitForEndpoint(endpoint, {
      timeoutMs: OPEN_TIMEOUT_MS,
      intervalMs: 100,
      ...(signal ? { signal } : {}),
    });
    if (givenUp(signal)) throw new Error(GIVEN_UP);
    const wsUrl = version?.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error('the window opened but offered no debugging connection');

    cdp = /** @type {import('../../types.js').CdpSession} */ (await connect(wsUrl, { timeoutMs: 15_000 }));
    if (givenUp(signal)) throw new Error(GIVEN_UP);

    const target = await findPanelTarget(endpoint, Date.now() + OPEN_TIMEOUT_MS, signal);
    if (givenUp(signal)) throw new Error(GIVEN_UP);
    if (!target) throw new Error('the window opened but never showed the panel');

    const targetId = String(target.id ?? target.targetId);
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = String(attached.sessionId);
    const page = await createPage(
      cdp,
      /** @type {any} */ ({ sessionId, targetId, baseUrl: null, timeoutMs: 15_000 }),
    );

    // Before the document paints, so the window is never a white rectangle.
    await darkenWindow(page, theme);

    // Now there is a window, there is finally something that can say how big the
    // screen is. A position on the command line is a guess; this is the answer.
    const screen = await readScreen(page);
    const kept = remembered && fitsOnScreen(remembered, screen) ? remembered : null;
    const first = kept ?? firstPlace(screen, size, watch, null);
    await moveWindow(page, first);
    await watchForHandMove(page, first);

    // The page defines its own update function as it loads; until it exists there
    // is nothing to push into.
    await waitForPanelReady(page, Date.now() + OPEN_TIMEOUT_MS, signal);

    // Last, and every time — including when this is a re-open. Whoever was in
    // front before goes back in front.
    await giveTheScreenBack(previousApp);

    return makePanel({
      cdp,
      page,
      sessionId,
      child,
      temp,
      url,
      keepOpen: watch.keepOpen !== false,
      dir: opts.dir ?? null,
      side: watch.side === 'left' ? 'left' : 'right',
      panelWidth: size.width,
      askedHeight: askedHeight(watch),
      placed: first,
      // Opened where they left it, so it is already theirs: nothing snaps it.
      byHand: kept !== null,
      foreground: watch.foreground === true,
    });
  } catch (e) {
    // Somebody finishing is not something going wrong. A run that ends before its window
    // finished opening is the ordinary case for a short check, and it deserves silence.
    if (givenUp(signal)) {
      detail('The check finished before the watch window had opened, so the window was called off.');
    } else {
      warn(
        `The watch window could not open, so this check has no live view. The check itself carries on. ${messageOf(e)}`,
      );
    }
    if (cdp) await cdp.close().catch(() => {});
    if (child) await stopProcess(child, 2000).catch(() => {});
    if (temp) await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

/**
 * Give up on a promise after a while.
 *
 * The whole of "the check never waits on the window", in six lines. The promise
 * itself is not cancelled — nothing in the debugging protocol can be — it is
 * simply stopped being waited for, and whatever it eventually does is ignored.
 *
 * @template T
 * @param {Promise<T>} work
 * @param {number} ms
 * @returns {Promise<T|undefined>}  undefined means it ran out of time.
 */
function within(work, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    // Never hold the process open waiting for a window's answer.
    if (typeof timer.unref === 'function') timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/**
 * What may be thrown away when the window cannot keep up, and what may never be.
 *
 * The panel builds its picture out of this stream in order, so most of it is load-bearing: a
 * lost `journey:done` leaves a journey stuck on "running" for the rest of the check, which is
 * worse than no window at all. Two kinds are not.
 *
 * A RUNNING COUNT is superseded the moment the next one arrives — only the last one per
 * journey was ever going to be drawn — so all but the newest can go.
 *
 * A NOTE is a line in a list. A line nobody read while the window was minimised is a line
 * worth losing, and the oldest is the one to lose.
 *
 * Nothing else is ever dropped. That is the rule the whole queue is built around: coalesce
 * the counters, drop the oldest chatter, never touch the newest state.
 */

/** A counter that the next one of its kind replaces outright. */
const SUPERSEDED_BY_THE_NEXT = 'journey:addresses';

/** Chatter. Worth showing, never worth holding a check up for. */
const CHATTER = 'note';

/** How many notes are kept when the queue is folded down. */
const KEEP_NOTES = 120;

/**
 * @param {{
 *   cdp: import('../../types.js').CdpSession,
 *   page: import('../../types.js').PageHandle,
 *   sessionId: string,
 *   child: import('node:child_process').ChildProcess,
 *   temp: string,
 *   url: string,
 *   keepOpen: boolean,
 *   dir: string|null,
 *   side: 'left'|'right',
 *   panelWidth: number,
 *   askedHeight: number|null,
 *   placed: Bounds,
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
  let stalls = 0;
  let pushed = 0;
  let delivered = 0;
  let dropped = 0;

  /** Where we last put the window ourselves — or where the person last left it. */
  let placed = ctx.placed;
  /** Once this is true, nothing in here moves the window again. */
  let byHand = ctx.byHand;
  /** The snap happens once a check, whether or not it worked. */
  let snapped = false;

  // A window we leave up owns its folder until the browser finally exits.
  ctx.child.once('exit', () => {
    fsp.rm(ctx.temp, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * Fold the queue down when the window cannot keep up.
   *
   * In order, and the order is the rule: EVIDENCE first — a path to a picture nobody had time
   * to look at — then the RUNNING COUNTS, of which only the newest per journey was ever going
   * to be drawn, and only then the oldest CHATTER. State is never touched, which is what makes
   * a minimised window correct the instant it is looked at rather than merely eventually.
   *
   * When the queue is still long after all of that, it stays long. A window falling behind is
   * a window falling behind; it is not a reason to start lying to it.
   */
  function fold() {
    // Evidence first: a path to a picture nobody had time to look at.
    for (let i = 0; i < queue.length - KEEP_EVIDENCE; i++) {
      if (queue[i]?.evidence === undefined) continue;
      queue[i] = { ...queue[i], evidence: undefined };
    }
    if (queue.length <= MAX_QUEUE) return;

    // Then the running counts, of which only the newest per journey was ever going to be drawn.
    /** @type {Map<string, number>} */
    const newestCount = new Map();
    for (let i = 0; i < queue.length; i++) {
      if (queue[i]?.type !== SUPERSEDED_BY_THE_NEXT) continue;
      newestCount.set(String(queue[i]?.journey ?? ''), i);
    }
    if (newestCount.size > 0) {
      const keep = new Set(newestCount.values());
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i]?.type === SUPERSEDED_BY_THE_NEXT && !keep.has(i)) {
          queue.splice(i, 1);
          dropped += 1;
        }
      }
    }
    if (queue.length <= MAX_QUEUE) return;

    // Then the oldest chatter, and only chatter. Everything left is state the panel
    // needs in order, and it stays even if that means the queue stays long.
    let notes = 0;
    for (const item of queue) if (item?.type === CHATTER) notes += 1;
    let overspill = Math.max(0, Math.min(queue.length - MAX_QUEUE, notes - KEEP_NOTES));
    for (let i = 0; i < queue.length && overspill > 0; ) {
      if (queue[i]?.type !== CHATTER) {
        i += 1;
        continue;
      }
      queue.splice(i, 1);
      dropped += 1;
      overspill -= 1;
    }
  }

  /**
   * One call, however many updates are waiting. The page is handed JSON as a
   * string and parses it itself, so nothing a journey is called can ever be read
   * as code.
   * @param {any[]} batch
   * @returns {Promise<boolean>}  false when it ran out of time or the window refused it.
   */
  async function send(batch) {
    const payload = JSON.stringify(JSON.stringify(batch));
    const answer = await within(
      ctx.page.evaluate(
        '(function(){var list;try{list=JSON.parse(' +
          payload +
          ');}catch(e){return 0;}' +
          'if(typeof window.__staysfixed_push!=="function")return 0;' +
          'for(var i=0;i<list.length;i++){window.__staysfixed_push(list[i]);}' +
          'return list.length;})()',
      ),
      PUSH_TIMEOUT_MS,
    );
    return answer !== undefined;
  }

  async function drain() {
    if (sending || dead) return;
    sending = true;
    try {
      while (queue.length > 0 && !dead) {
        // Taken off the queue before it is sent, on purpose: an update that fails
        // is dropped, never retried into a check it would hold up.
        const batch = queue.splice(0, MAX_BATCH);
        const landed = await send(batch);
        if (landed) {
          delivered += batch.length;
          stalls = 0;
          continue;
        }
        stalls += 1;
        dropped += batch.length;
        // A window that has gone is a window to stop pushing to. So is one that
        // has been too slow too many times in a row: whatever is wrong with it,
        // it is not going to be read, and a check has better things to do.
        if (!ctx.cdp.isOpen() || stalls >= STALL_LIMIT) {
          dead = true;
          detail(
            ctx.cdp.isOpen()
              ? 'The watch window stopped keeping up, so nothing more is being sent to it. The check is unaffected.'
              : 'The watch window has gone. The check is unaffected.',
          );
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
   * Put the panel flush against the thing being checked, so the two of them read
   * as one window with a side panel.
   *
   * Once a check, and never over the top of a window the person has already moved:
   * a window somebody has arranged is theirs, and a tool that drags it back is a
   * tool you close. Everything here is best-effort — a window that will not move
   * is a disappointment, never a failed check — and the screen is handed back
   * afterwards, because moving windows can pull one to the front.
   *
   * @param {BesideThis} beside
   * @returns {Promise<void>}
   */
  async function snapTo(beside) {
    if (dead || snapped) return;
    snapped = true;
    try {
      if (await handHasIt()) return;

      const previousApp = ctx.foreground ? null : await noteTheFrontmost();
      const screen = await readScreen(ctx.page);

      // Anything headless has a window on paper and nothing on the screen, and
      // snapping against one would leave the panel hugging thin air.
      const appPage = beside?.hasWindow === false ? null : (beside?.page ?? null);
      // Ask the protocol first and the page second: a browser answers the first,
      // and a desktop app only ever answers the second.
      const current =
        beside?.window ??
        (appPage ? ((await readWindowBounds(appPage)) ?? (await readPageWindow(appPage))) : null);

      const target = current
        ? panelBeside(current, screen, ctx.panelWidth, ctx.side)
        : planPlacement({ screen, appSize: null, panelWidth: ctx.panelWidth, side: ctx.side, gap: GAP }).panel;
      const bounds = ctx.askedHeight ? { ...target, height: Math.min(ctx.askedHeight, screen.height) } : target;

      if (await moveWindow(ctx.page, bounds)) {
        placed = bounds;
        // Tell the page where we just put it, so our own move is not read as theirs.
        await watchForHandMove(ctx.page, bounds);
      }

      await giveTheScreenBack(previousApp);
    } catch {
      // Where the windows sit is a nicety. It is never worth a failed check.
    }
  }

  /**
   * Hand one update over. Returns nothing, waits for nothing, throws nothing.
   * @param {PanelEvent} event
   * @returns {void}
   */
  function push(event) {
    if (dead || !event || typeof event !== 'object') return;
    pushed += 1;
    queue.push(event);
    fold();
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
        if (byHand) await writeRemembered(ctx.dir, placed, await readScreen(ctx.page));
      } catch {
        // A window that has already gone cannot say where it was.
      }

      // Stop the clock in the page, so a window left up does not sit there
      // counting seconds next to a result that is already final.
      await within(
        ctx.page.evaluate(
          '(function(){var w=window.__staysfixed_place;if(w&&w.timer){clearInterval(w.timer);w.timer=null;}' +
            'if(typeof window.__staysfixed_detach==="function")window.__staysfixed_detach();return true;})()',
        ),
        PUSH_TIMEOUT_MS,
      );
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
        // Leave it up. The result is what the person opened the panel to read, and
        // it should still be there when they look over.
        return;
      }
      await stopProcess(ctx.child, 3000);
      await fsp.rm(ctx.temp, { recursive: true, force: true }).catch(() => {});
    })();
    return closing;
  }

  return {
    push,
    close,
    url: ctx.url,
    snapTo,
    placedByHand: () => byHand,
    health: () => ({ alive: !dead, pushed, delivered, dropped, stalls, queued: queue.length }),
  };
}
