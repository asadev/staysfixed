/**
 * Covering up the parts that are allowed to change.
 *
 * Some things on a screen are genuinely different every run and always will be: a live
 * clock, a session id, a "3 minutes ago", a randomly-picked hero image. Masking them is
 * how a picture check stays honest — the alternative is a tolerance so loose it would
 * also hide a broken layout.
 *
 * Two ways to do it, and the difference matters:
 *   paintMasks - paints over the finished photo. The layout is real, only the pixels go.
 *   maskCss    - hides the content in the page before the photo. Use it only when the
 *                changing content also changes the LAYOUT, because hiding content can
 *                move everything around it, and then the mask is not the only difference.
 */

/**
 * Turn selectors and rectangles into rectangles in device pixels.
 *
 * A selector that matches nothing is silently skipped: masking "the toast" on a screen
 * with no toast is normal, not a mistake worth failing a run over.
 *
 * @param {import('../types.js').PageHandle} page
 * @param {import('../types.js').Mask[]} masks
 * @param {{deviceScaleFactor?: number, fullPage?: boolean}} [opts]
 * @returns {Promise<import('../types.js').MaskRect[]>}
 */
export async function resolveMasks(page, masks, opts = {}) {
  const dpr = opts.deviceScaleFactor && opts.deviceScaleFactor > 0 ? opts.deviceScaleFactor : 1;
  const fullPage = opts.fullPage === true;

  /** @type {string[]} */
  const selectors = [];
  /** @type {import('../types.js').MaskRect[]} */
  const out = [];

  for (const mask of masks ?? []) {
    if (typeof mask === 'string') {
      if (mask.trim()) selectors.push(mask);
    } else if (mask && typeof mask === 'object') {
      out.push(toDevicePixels(mask, dpr));
    }
  }

  if (selectors.length === 0) return out;

  // getBoundingClientRect is relative to the viewport, which is exactly what a viewport
  // screenshot uses. A full-page shot is relative to the document, so the scroll offset
  // has to go back in.
  const source = `(() => {
  const selectors = ${JSON.stringify(selectors)};
  const addScroll = ${fullPage ? 'true' : 'false'};
  const out = [];
  for (const selector of selectors) {
    let nodes = [];
    try { nodes = Array.prototype.slice.call(document.querySelectorAll(selector)); }
    catch (e) { continue; }
    for (const el of nodes) {
      let r = null;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (!r || (r.width <= 0 && r.height <= 0)) continue;
      out.push({
        x: r.left + (addScroll ? (window.scrollX || 0) : 0),
        y: r.top + (addScroll ? (window.scrollY || 0) : 0),
        width: r.width,
        height: r.height
      });
    }
  }
  return out;
})()`;

  /** @type {any} */
  let found = [];
  try {
    found = await page.evaluate(source);
  } catch {
    // A page that navigated mid-resolve. No masks is better than a failed run; the
    // comparison will show the moving content, which is at least honest.
    return out;
  }

  if (Array.isArray(found)) {
    for (const r of found) {
      if (!r || typeof r.x !== 'number') continue;
      out.push(toDevicePixels(r, dpr));
    }
  }
  return out;
}

/**
 * Scale a CSS-pixel rectangle into device pixels, rounding outward so a mask never leaves
 * a one-pixel sliver of the thing it was meant to cover.
 *
 * @param {import('../types.js').MaskRect} rect
 * @param {number} dpr
 * @returns {import('../types.js').MaskRect}
 */
function toDevicePixels(rect, dpr) {
  const left = Math.max(0, Math.floor(Number(rect.x) * dpr));
  const top = Math.max(0, Math.floor(Number(rect.y) * dpr));
  const right = Math.max(left, Math.ceil((Number(rect.x) + Number(rect.width)) * dpr));
  const bottom = Math.max(top, Math.ceil((Number(rect.y) + Number(rect.height)) * dpr));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Paint rectangles into a decoded picture, in place.
 *
 * Magenta on purpose. If a mask ever drifts off the thing it was covering, a human sees a
 * screaming pink block sitting in the wrong place instantly — which is the whole point of
 * a tool whose job is to make changes impossible to miss.
 *
 * @param {import('pngjs').PNG} png
 * @param {import('../types.js').MaskRect[]} rects
 * @param {{color?: {r: number, g: number, b: number}}} [opts]
 * @returns {import('pngjs').PNG} the same picture, painted
 */
export function paintMasks(png, rects, opts = {}) {
  const color = opts.color ?? { r: 255, g: 0, b: 255 };
  const width = png.width;
  const height = png.height;
  const data = png.data;

  for (const rect of rects ?? []) {
    const x0 = clamp(Math.round(rect.x), 0, width);
    const y0 = clamp(Math.round(rect.y), 0, height);
    const x1 = clamp(Math.round(rect.x + rect.width), 0, width);
    const y1 = clamp(Math.round(rect.y + rect.height), 0, height);
    if (x1 <= x0 || y1 <= y0) continue;

    for (let y = y0; y < y1; y += 1) {
      let i = (width * y + x0) * 4;
      for (let x = x0; x < x1; x += 1) {
        data[i] = color.r;
        data[i + 1] = color.g;
        data[i + 2] = color.b;
        data[i + 3] = 255;
        i += 4;
      }
    }
  }
  return png;
}

/**
 * @param {number} n
 * @param {number} low
 * @param {number} high
 * @returns {number}
 */
function clamp(n, low, high) {
  if (!Number.isFinite(n)) return low;
  return Math.min(high, Math.max(low, Math.round(n)));
}

/**
 * CSS that flattens the named elements before the photo is taken.
 *
 * Painting afterwards is the better tool almost always, because the layout in the picture
 * stays exactly what the app really did. Reach for this only when the changing content
 * changes the size of things around it — a name that is sometimes short and sometimes
 * long, a count that grows a column. Keeping the box and blanking what is inside it means
 * the rest of the screen stops moving.
 *
 * @param {string[]} selectors
 * @returns {Promise<string>} CSS
 */
export async function maskCss(selectors) {
  const list = (selectors ?? []).filter((s) => typeof s === 'string' && s.trim());
  if (list.length === 0) return '';
  const joined = list.join(', ');
  const children = list.map((s) => `${s} *`).join(', ');
  return `${joined} {
  background-color: #ff00ff !important;
  background-image: none !important;
  color: transparent !important;
  text-shadow: none !important;
  border-color: #ff00ff !important;
  box-shadow: none !important;
}

${children} {
  visibility: hidden !important;
}
`;
}
