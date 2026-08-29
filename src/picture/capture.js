/**
 * Taking one picture of one screen.
 *
 * The order of operations here is the whole reason picture checks can be
 * trusted: freeze the world FIRST (clock, fonts, randomness, network), then
 * drive the app, then hold still until two frames in a row are identical, and
 * only then press the shutter. Do any of those out of order and the tool starts
 * crying wolf, which is worse than having no tool at all.
 */

import { PNG } from 'pngjs';
import { applyFreeze, prepareForShutter } from '../freeze/index.js';
import { settle } from '../freeze/settle.js';
import { resolveMasks, paintMasks } from '../freeze/mask.js';
import { StaysFixedError, isExpected, messageOf } from '../core/errors.js';

/**
 * Every instruction a declarative step is allowed to give, in the order they run
 * when a single step carries more than one. `goto` first, `wait` last — that way
 * `{ waitFor: '#list', click: '#list li', wait: 100 }` reads and behaves the same way.
 * @type {readonly (keyof import('../types.js').Step)[]}
 */
const ACTION_ORDER = [
  'goto',
  'waitFor',
  'scrollTo',
  'hover',
  'click',
  'type',
  'press',
  'evaluate',
  'waitForGone',
  'wait',
];

/** Keys allowed on a step that are not actions: `text` feeds `type`, `note` is for humans. */
const KNOWN_KEYS = new Set([...ACTION_ORDER, 'text', 'note']);

/**
 * Photograph one screen.
 *
 * @param {import('../types.js').PageHandle} page
 * @param {import('../types.js').ScreenConfig} screen
 * @param {{
 *   viewport: import('../types.js').ViewportConfig,
 *   tolerance: import('../types.js').ToleranceConfig,
 *   freeze: import('../types.js').FreezeConfig,
 *   masks: import('../types.js').Mask[],
 * }} settings
 * @param {{fixturesDir: string, record?: boolean, timeoutMs?: number}} ctx
 * @returns {Promise<import('../types.js').CaptureReport & {masks: import('../types.js').MaskRect[]}>}
 *   The standard report plus the mask rectangles that were painted, so the
 *   comparison can paint the exact same rectangles onto the approved picture.
 */
export async function captureScreen(page, screen, settings, ctx) {
  const deviceScaleFactor = settings.viewport.deviceScaleFactor ?? 2;
  const settleConfig = settings.freeze.settle ?? {};
  const timeoutMs = ctx.timeoutMs ?? settleConfig.timeoutMs ?? 10_000;

  await page.setViewport(settings.viewport);
  page.clearConsole();

  const frozen = await applyFreeze(page, settings.freeze, {
    fixturesDir: ctx.fixturesDir,
    screenName: screen.name,
    record: ctx.record ?? false,
    deviceScaleFactor,
  });

  try {
    if (typeof screen.do === 'function') {
      await screen.do(page);
    } else {
      await runSteps(page, screen.steps ?? []);
    }

    // Scrolling back to the top is the deterministic default, but a screen that
    // deliberately scrolled somewhere must be photographed where it landed.
    const scrolledOnPurpose =
      typeof screen.do === 'function' || (screen.steps ?? []).some((s) => s.scrollTo !== undefined);

    await prepareForShutter(page, {
      fonts: settings.freeze.fonts !== false,
      timeoutMs,
      keepScroll: scrolledOnPurpose,
    });

    /** @type {import('../types.js').CaptureOptions} */
    const shotOptions = {};
    if (screen.fullPage) shotOptions.fullPage = true;
    if (screen.clip) shotOptions.clip = screen.clip;

    const held = await settle(page, {
      frames: settleConfig.frames ?? 2,
      intervalMs: settleConfig.intervalMs ?? 250,
      timeoutMs: settleConfig.timeoutMs ?? 10_000,
      maxDriftPixels: settleConfig.maxDriftPixels ?? 0,
      capture: () => page.shoot(shotOptions),
    });

    const rects = await resolveMasks(page, settings.masks ?? [], { deviceScaleFactor });
    const png = rects.length > 0 ? paintInto(held.png, rects) : held.png;
    const size = pngSize(png);

    // The picture is taken; now put the app back if this screen asked us to.
    //
    // A reload between screens restores what the PAGE was holding, but not what the app
    // has written to disk. A screen that collapses a sidebar, switches a theme or turns
    // a setting off leaves that behind for everything after it, and the failure then
    // lands on some innocent check further down the list. `after` is where a screen
    // cleans up after itself. It runs even though the shutter has already fired, and a
    // failure here is reported rather than swallowed — a cleanup that quietly stopped
    // working would poison every run after it.
    if (screen.after && screen.after.length > 0) {
      await runSteps(page, screen.after);
    }

    return {
      png,
      width: size.width,
      height: size.height,
      settle: held.report,
      consoleErrors: page.consoleErrors(),
      freeze: frozen.stats(),
      masks: rects,
    };
  } finally {
    // Releasing must never be the thing that hides a real failure.
    try {
      await frozen.release();
    } catch {
      // ignored on purpose
    }
  }
}

/**
 * Paint the masks into a screenshot and re-encode it.
 * @param {Buffer} buffer
 * @param {import('../types.js').MaskRect[]} rects
 * @returns {Buffer}
 */
function paintInto(buffer, rects) {
  const image = PNG.sync.read(buffer);
  paintMasks(image, rects);
  return PNG.sync.write(image);
}

/**
 * Run the declarative steps from a JSON config, in order.
 *
 * @param {import('../types.js').PageApi} page
 * @param {import('../types.js').Step[]} steps
 * @returns {Promise<void>}
 */
export async function runSteps(page, steps) {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const n = i + 1;
    if (!step || typeof step !== 'object') {
      throw new StaysFixedError(`Step ${n} is not an instruction.`, {
        hint: 'Each step is an object, for example { click: "#save" }.',
      });
    }
    for (const key of Object.keys(step)) {
      if (!KNOWN_KEYS.has(/** @type {keyof import('../types.js').Step} */ (key))) {
        throw new StaysFixedError(`Step ${n} says \`${key}\` — I do not know that instruction.`, {
          hint: `The instructions I know are: ${ACTION_ORDER.join(', ')}, text, note.`,
        });
      }
    }
    try {
      await runStep(page, step, n);
    } catch (cause) {
      if (isExpected(cause)) throw cause;
      throw new StaysFixedError(`${describeStep(step, n)} did not work.`, {
        hint: messageOf(cause),
        cause,
      });
    }
  }
}

/**
 * @param {import('../types.js').PageApi} page
 * @param {import('../types.js').Step} step
 * @param {number} n
 * @returns {Promise<void>}
 */
async function runStep(page, step, n) {
  let did = false;
  if (step.goto !== undefined) {
    await page.goto(step.goto);
    did = true;
  }
  if (step.waitFor !== undefined) {
    await page.waitFor(step.waitFor);
    did = true;
  }
  if (step.scrollTo !== undefined) {
    await page.scrollTo(step.scrollTo);
    did = true;
  }
  if (step.hover !== undefined) {
    await page.hover(step.hover);
    did = true;
  }
  if (step.click !== undefined) {
    await page.click(step.click);
    did = true;
  }
  if (step.type !== undefined) {
    if (typeof step.text !== 'string') {
      throw new StaysFixedError(`Step ${n} says to type into \`${step.type}\` but never says what to type.`, {
        hint: 'Add `text` to that step, for example { type: "#search", text: "hello" }.',
      });
    }
    await page.type(step.type, step.text);
    did = true;
  }
  if (step.press !== undefined) {
    await page.press(step.press);
    did = true;
  }
  if (step.evaluate !== undefined) {
    await page.evaluate(step.evaluate);
    did = true;
  }
  if (step.waitForGone !== undefined) {
    await page.waitForGone(step.waitForGone);
    did = true;
  }
  if (step.wait !== undefined) {
    await page.wait(step.wait);
    did = true;
  }
  if (!did && step.note === undefined) {
    throw new StaysFixedError(`Step ${n} does not say what to do.`, {
      hint: `Give it one of: ${ACTION_ORDER.join(', ')}.`,
    });
  }
}

/**
 * A step named the way a human would say it out loud.
 * @param {import('../types.js').Step} step
 * @param {number} n
 * @returns {string}
 */
function describeStep(step, n) {
  for (const key of ACTION_ORDER) {
    const value = step[key];
    if (value !== undefined) return `Step ${n} (${key} ${JSON.stringify(value)})`;
  }
  return `Step ${n}`;
}

/**
 * Width and height straight out of the PNG header.
 *
 * Settle compares a frame every quarter second; decoding a whole retina
 * screenshot just to learn its size would dominate the run. The IHDR chunk always
 * starts at byte 8, so width and height sit at bytes 16 and 20, big-endian.
 *
 * @param {Buffer} buffer
 * @returns {{width: number, height: number}}
 */
export function pngSize(buffer) {
  if (!buffer || buffer.length < 24) {
    throw new StaysFixedError('That screenshot came back empty — there is no picture to measure.');
  }
  if (buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
    throw new StaysFixedError('That screenshot is not a PNG picture.');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
