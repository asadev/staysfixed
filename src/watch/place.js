/**
 * Where the two windows go.
 *
 * The panel is meant to read as part of the app it is checking, not as a second
 * program that happened to open next to it: the app goes hard against one edge
 * of the screen and the panel sits flush against it, no seam, tops lined up. One
 * shape, two windows.
 *
 * Every bit of that is arithmetic, so it lives here on its own, with no browser
 * and no protocol in it. `src/watch/window.js` does the moving; this file only
 * says where. That split is what lets the placement be checked in an ordinary
 * Node process instead of by opening two windows and looking at them.
 *
 * All numbers are screen CSS pixels, and every rectangle that comes out of here
 * is whole pixels — a window manager rounds them anyway, and a half pixel is how
 * you end up with a one-pixel line of wallpaper between two windows that are
 * supposed to be touching.
 */

/**
 * A rectangle on the screen.
 *
 * `left`/`top` and `x`/`y` are the same two numbers under both of the names a
 * window position goes by — the debugging protocol says left and top, most of
 * the rest of the world says x and y — so whichever one a caller already speaks,
 * it can read this without a conversion step in the middle. Everything built
 * here carries both; anything handed in only has to carry one.
 *
 * @typedef {object} Bounds
 * @property {number} left
 * @property {number} top
 * @property {number} width
 * @property {number} height
 * @property {number} [x]
 * @property {number} [y]
 */

/**
 * What the placement needs to know.
 *
 * `screen` is the usable area — the work area, menu bar and dock already taken
 * off — not the whole display. `appSize` is null for a check with no window of
 * its own to sit beside (a headless web check), and `side` names the screen edge
 * the app is pinned to: 'right' puts the app at the far right and the panel on
 * its left, which is the arrangement this was built for.
 *
 * @typedef {object} PlacementInput
 * @property {Bounds} screen
 * @property {{width: number, height: number}|null} [appSize]   The app's window size.
 * @property {{width: number, height: number}|null} [app]       The same thing, under the shorter name.
 * @property {number} [panelWidth]
 * @property {number} [width]                                   The same thing, under the shorter name.
 * @property {'right'|'left'} [side]
 * @property {number} [gap]   Pixels between the two windows. 0 — flush — unless somebody asks otherwise.
 */

/**
 * @typedef {object} Placement
 * @property {Bounds|null} app     Where the app's window should go. Null when there is no app window.
 * @property {Bounds} panel        Where the panel should go.
 */

/** Narrower than this and the panel cannot show a picture and a list at once. */
export const PANEL_MIN_WIDTH = 240;

/** Wider than this and it stops being a side panel. */
export const PANEL_MAX_WIDTH = 900;

/** How wide the panel is when nobody says otherwise. Legible down to 420. */
export const PANEL_DEFAULT_WIDTH = 460;

/** Something has to be assumed when a window cannot say how big the screen is. */
const FALLBACK_SCREEN = { left: 0, top: 0, width: 1440, height: 900 };

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function whole(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

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
 * A rectangle under both of its names, in whole pixels.
 * @param {number} left
 * @param {number} top
 * @param {number} width
 * @param {number} height
 * @returns {Bounds}
 */
function rect(left, top, width, height) {
  const l = Math.round(left);
  const t = Math.round(top);
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return { left: l, top: t, width: w, height: h, x: l, y: t };
}

/**
 * A screen we can do arithmetic with, whatever we were handed.
 * @param {Bounds|undefined|null} screen
 * @returns {Bounds}
 */
function readScreenRect(screen) {
  const width = Math.max(1, whole(screen?.width, FALLBACK_SCREEN.width));
  const height = Math.max(1, whole(screen?.height, FALLBACK_SCREEN.height));
  return { left: whole(screen?.left, 0), top: whole(screen?.top, 0), width, height };
}

/**
 * A window size, or nothing.
 * @param {{width?: number, height?: number}|null|undefined} size
 * @returns {{width: number, height: number}|null}
 */
function readSize(size) {
  if (!size || typeof size !== 'object') return null;
  const width = whole(size.width, 0);
  const height = whole(size.height, 0);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * The panel's width, kept sane and kept on the screen.
 * @param {unknown} asked
 * @param {number} screenWidth
 * @returns {number}
 */
function panelWidthFor(asked, screenWidth) {
  const wanted = clamp(whole(asked, PANEL_DEFAULT_WIDTH), PANEL_MIN_WIDTH, PANEL_MAX_WIDTH);
  // On a screen narrower than the panel, the screen wins. A window can be pushed
  // off the edge; a window with a negative width cannot exist.
  return Math.max(1, Math.min(wanted, screenWidth));
}

/**
 * Work out where both windows go.
 *
 * When the two of them do not fit side by side, the panel keeps its width and
 * its edge and the app is pushed off the far edge of the screen. That is
 * deliberate and it is the one rule here worth remembering: **the app being
 * photographed is never resized.** Its window size is part of what the pictures
 * are of, so shrinking it to make room would quietly change every screen in the
 * run — which is the one thing this tool exists to notice.
 *
 * @param {PlacementInput} input
 * @returns {Placement}
 */
export function planPlacement(input) {
  const screen = readScreenRect(input?.screen);
  const side = input?.side === 'left' ? 'left' : 'right';
  const gap = Math.max(0, whole(input?.gap, 0));
  const panelWidth = panelWidthFor(input?.panelWidth ?? input?.width, screen.width);
  const app = readSize(input?.appSize ?? input?.app);
  const screenRight = screen.left + screen.width;

  // Nothing to sit beside: the panel goes hard against the chosen edge and is as
  // tall as the screen. A headless web check looks like this.
  if (!app) {
    const left = side === 'right' ? screenRight - panelWidth : screen.left;
    return { app: null, panel: rect(left, screen.top, panelWidth, screen.height) };
  }

  // When they do not both fit, the PANEL gives way — never the app.
  //
  // Resizing the thing being photographed would change every picture, so that is out.
  // The first version pushed the app off the far edge instead, and on a real 1800px
  // screen with a 1440px app that put a 460px panel straight on top of the app's left
  // third: two windows fighting over the same pixels, which is worse than either.
  // So the panel takes whatever room is left beside the app and narrows into it. It
  // only goes back to pushing the app when the leftover strip is too narrow to read.
  const room = screen.width - app.width - gap;
  const width = room >= panelWidth ? panelWidth : Math.max(PANEL_MIN_WIDTH, room);
  const fits = app.width + gap + width <= screen.width;

  let appLeft;
  let panelLeft;
  if (side === 'right') {
    if (fits) {
      appLeft = screenRight - app.width;
      panelLeft = appLeft - gap - width;
    } else {
      // Even a minimum-width panel does not fit beside it. The panel takes the far
      // edge and the app starts where the panel ends, running off the other side.
      panelLeft = screen.left;
      appLeft = screen.left + width + gap;
    }
  } else if (fits) {
    appLeft = screen.left;
    panelLeft = appLeft + app.width + gap;
  } else {
    panelLeft = screenRight - width;
    appLeft = panelLeft - gap - app.width;
  }

  return {
    app: rect(appLeft, screen.top, app.width, app.height),
    // The panel is as tall as the app, so the two of them read as one window —
    // but never taller than the screen it has to stand on.
    panel: rect(panelLeft, screen.top, width, Math.min(app.height, screen.height)),
  };
}

/**
 * The panel flush against an app that is where it is.
 *
 * Not every app can be moved — a desktop app usually cannot (see `window.js`) —
 * and an app nobody can move is not a reason to give up on the arrangement. The
 * panel goes against whichever side of the app there is room for, matching its
 * top and its height, because matching those is most of what makes two windows
 * read as one.
 *
 * @param {Bounds} appWindow   Where the app's window actually is.
 * @param {Bounds} screen
 * @param {number} panelWidth
 * @param {'right'|'left'} [side]   'right' means the app is meant to be the right of the pair.
 * @returns {Bounds}
 */
export function panelBeside(appWindow, screen, panelWidth, side) {
  const area = readScreenRect(screen);
  const width = panelWidthFor(panelWidth, area.width);
  const app = {
    left: whole(appWindow?.left, area.left),
    top: whole(appWindow?.top, area.top),
    width: Math.max(1, whole(appWindow?.width, 1)),
    height: Math.max(1, whole(appWindow?.height, area.height)),
  };
  const screenRight = area.left + area.width;

  const onLeft = app.left - width;
  const onRight = app.left + app.width;
  const wanted = side === 'left' ? onRight : onLeft;
  const other = side === 'left' ? onLeft : onRight;
  /** @param {number} left */
  const roomFor = (left) => left >= area.left && left + width <= screenRight;

  const left = roomFor(wanted)
    ? wanted
    : roomFor(other)
      ? other
      : // No room on either side of it. Stay on the screen; a panel nobody can
        // see is worse than a panel that overlaps.
        clamp(wanted, area.left, screenRight - width);

  const top = Math.max(area.top, app.top);
  return rect(left, top, width, Math.min(app.height, area.top + area.height - top));
}

/**
 * Is there room for the app and the panel side by side on this screen?
 *
 * Worth asking before promising somebody a side-by-side view: when the answer is
 * no, `planPlacement` still returns something usable, but part of the app ends
 * up off the edge of the screen.
 *
 * @param {Bounds} screen
 * @param {{width: number, height: number}|null} appSize
 * @param {number} panelWidth
 * @returns {boolean}
 */
export function fitsAlongside(screen, appSize, panelWidth) {
  const area = readScreenRect(screen);
  const width = panelWidthFor(panelWidth, area.width);
  const app = readSize(appSize);
  if (!app) return width <= area.width;
  return app.width + width <= area.width;
}
