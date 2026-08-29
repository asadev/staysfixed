/**
 * Where the two windows go.
 *
 * The whole point of the panel is that it reads as a side panel of the app it is
 * checking: the app hard against one edge of the screen, the panel flush against
 * it, the two looking like one window. That is arithmetic, and arithmetic can be
 * checked without opening anything — which is the only reason this file can run
 * in an ordinary Node process with no browser and no screen.
 *
 * Two promises are being kept here, and they are worth saying out loud. Nothing
 * is ever resized: the app keeps the size it asked for and the panel keeps the
 * width it was given, even when the two together do not fit. And nothing is ever
 * placed off the screen, because a window at a negative x is a window nobody can
 * find.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { planPlacement } from '../src/watch/place.js';

/**
 * The planner lives in another file and this test only cares how it behaves, so
 * it is called through a loose type rather than pinning down a shape that file
 * is free to change.
 * @type {(input: any) => any}
 */
const plan = planPlacement;

/** An ordinary laptop display. */
const SCREEN = { width: 1920, height: 1080 };

/** An ordinary app window on it, with room left over for a panel. */
const APP = { width: 1280, height: 860 };

/** The panel width nobody has to know about, and the ends it is held between. */
const DEFAULT_WIDTH = 460;
const MIN_WIDTH = 240;
const MAX_WIDTH = 900;

/**
 * One call, with the everyday answers filled in. Pass `app: null` to ask what
 * happens when there is no app to sit beside.
 *
 * Everything this file knows about the planner's shape is in this one function,
 * on purpose: if that shape moves, one place here moves with it.
 *
 * @param {{screen?: any, app?: any, side?: any, width?: any, gap?: any}} [input]
 * @returns {{panel: any, app: any}}
 */
function place(input = {}) {
  const result = plan({
    screen: input.screen ?? SCREEN,
    app: 'app' in input ? input.app : APP,
    side: input.side,
    width: input.width,
    gap: input.gap,
  });
  return { panel: result.panel, app: result.app ?? null };
}

/**
 * A rectangle a window manager could actually be handed.
 * @param {any} rect
 * @param {string} what
 * @returns {void}
 */
function assertUsable(rect, what) {
  assert.ok(rect && typeof rect === 'object', `${what}: there is no rectangle here at all`);
  for (const key of ['x', 'y', 'width', 'height']) {
    const value = rect[key];
    assert.equal(typeof value, 'number', `${what}: ${key} is not a number`);
    assert.ok(Number.isFinite(value), `${what}: ${key} is ${value}`);
    assert.equal(Math.round(value), value, `${what}: ${key} is ${value}, which is not a whole pixel`);
  }
  assert.ok(rect.width > 0, `${what}: a window with no width is not a window`);
  assert.ok(rect.height > 0, `${what}: a window with no height is not a window`);
  // A window at a negative position is a window nobody can find again.
  assert.ok(rect.x >= 0, `${what}: starts at x ${rect.x}, off the left of the screen`);
  assert.ok(rect.y >= 0, `${what}: starts at y ${rect.y}, above the top of the screen`);
}

/**
 * @param {any} rect
 * @param {string} what
 * @returns {void}
 */
function assertOnScreen(rect, what) {
  assertUsable(rect, what);
  assert.ok(rect.x + rect.width <= SCREEN.width, `${what}: runs ${rect.x + rect.width - SCREEN.width}px off the right`);
  assert.ok(
    rect.y + rect.height <= SCREEN.height,
    `${what}: runs ${rect.y + rect.height - SCREEN.height}px off the bottom`,
  );
}

/**
 * The seam the planner leaves between the two windows when nobody asks for one.
 * Read off the planner rather than written down, so this file pins the shape of
 * the layout and not a number somebody is allowed to tune.
 */
const DEFAULT_GAP = (() => {
  const { panel, app } = place();
  return app ? app.x - (panel.x + panel.width) : 0;
})();

describe('the app on one edge, the panel against it', () => {
  test('the seam between them is nothing, or close enough to read as nothing', () => {
    assert.ok(DEFAULT_GAP >= 0, `the panel overlaps the app by ${-DEFAULT_GAP}px`);
    assert.ok(DEFAULT_GAP <= 16, `there is a ${DEFAULT_GAP}px gap between them, which reads as two windows`);
  });

  test('by default the app goes hard against the right edge and the panel sits on its left', () => {
    const { panel, app } = place();
    assertOnScreen(app, 'the app');
    assertOnScreen(panel, 'the panel');

    assert.equal(app.x + app.width, SCREEN.width, 'the app is not against the right edge of the screen');
    assert.equal(panel.x + panel.width + DEFAULT_GAP, app.x, 'the panel is not flush against the app');
    assert.equal(panel.width, DEFAULT_WIDTH, 'the panel did not keep its width');
    assert.equal(app.width, APP.width, 'the app was resized');
    assert.equal(app.height, APP.height, 'the app was resized');
  });

  test('on the left it is the mirror image', () => {
    const { panel, app } = place({ side: 'left' });
    assertOnScreen(app, 'the app');
    assertOnScreen(panel, 'the panel');

    assert.equal(app.x, 0, 'the app is not against the left edge of the screen');
    assert.equal(app.x + app.width + DEFAULT_GAP, panel.x, 'the panel is not flush against the app');
    assert.equal(app.width, APP.width, 'the app was resized');

    // And the two sides really are opposite ends of the desk.
    assert.ok(place({ side: 'left' }).panel.x > place({ side: 'right' }).panel.x, 'both sides put the panel in the same place');
  });

  test('asked for no seam at all, it leaves none', () => {
    const right = place({ gap: 0 });
    assert.equal(right.panel.x + right.panel.width, right.app.x, 'there is still a seam on the right');

    const left = place({ side: 'left', gap: 0 });
    assert.equal(left.app.x + left.app.width, left.panel.x, 'there is still a seam on the left');
  });
});

describe('when it cannot have what it wants', () => {
  test('with no app at all the panel still has somewhere to be', () => {
    // A web app that never reported a size, a run that failed before the app
    // opened, or `--no-snap`. The panel is still a window and still needs a spot.
    for (const missing of [null, undefined]) {
      const { panel, app } = place({ app: missing, side: 'right' });
      assert.equal(app, null, 'it invented an app window that is not there');
      assertOnScreen(panel, 'the panel with no app');
      assert.equal(panel.width, DEFAULT_WIDTH, 'the panel did not keep its width');
    }
    assertOnScreen(place({ app: null, side: 'left' }).panel, 'the panel with no app, on the left');
  });

  test('an app too wide to share the screen keeps its size; the panel narrows', () => {
    // 1800 and 460 do not both fit across 1920. Something has to give, and it is
    // never the app: resizing the thing being photographed changes every picture.
    // So the panel takes the strip that is left. Overlapping the app instead was
    // the first behaviour and it was worse than either — two windows fighting over
    // the same pixels, with the panel sitting on top of the app's left third.
    // 1600 across 1920 leaves a 320px strip: narrower than the panel wants, wide
    // enough to read.
    const wide = { width: 1600, height: 900 };
    const { panel, app } = place({ app: wide });

    assert.equal(app.width, wide.width, 'the app was resized to make room');
    assert.equal(app.height, wide.height, 'the app was resized to make room');
    assert.equal(panel.width, SCREEN.width - wide.width, 'the panel did not take the room that was left');
    assert.equal(panel.x + panel.width, app.x, 'the panel and the app are not flush');

    assertUsable(app, 'the too-wide app');
    assertUsable(panel, 'the panel beside a too-wide app');
  });

  test('an app that leaves no readable strip pushes itself off the edge instead', () => {
    // Below the minimum the panel cannot show a before and an after side by side,
    // which is the only reason to open it. At that point the app is the one that
    // moves — off the far edge, still its own size.
    const enormous = { width: SCREEN.width - 120, height: 900 };
    const { panel, app } = place({ app: enormous });

    assert.equal(app.width, enormous.width, 'the app was resized');
    assert.equal(panel.width, MIN_WIDTH, 'the panel went below the width a person can read');
    assert.equal(panel.x + panel.width, app.x, 'the panel and the app are not flush');
  });

  test('the width is held between 240 and 900', () => {
    // Narrower than 240 and the before-and-after pictures cannot sit side by
    // side, which is the only reason to open the panel. Wider than 900 and it
    // is not a side panel any more.
    // With no app beside it, the width is purely what was asked for — which is what
    // the clamp is about. Next to an app the strip that is left can be narrower, and
    // that is the test above.
    assert.equal(place({ app: null, width: 10 }).panel.width, MIN_WIDTH);
    assert.equal(place({ app: null, width: MIN_WIDTH }).panel.width, MIN_WIDTH);
    assert.equal(place({ app: null, width: 5000 }).panel.width, MAX_WIDTH);
    assert.equal(place({ app: null, width: MAX_WIDTH }).panel.width, MAX_WIDTH);
    assert.equal(place({ width: 520 }).panel.width, 520, 'a width it should have honoured was changed');
  });
});
