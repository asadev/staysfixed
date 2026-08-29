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
// The words a step is described by, and the two builders that turn what is known at
// this instant into one line of the list. Imported rather than written again here so
// the line a person watches tick is the same line, in the same words, that the
// finished list hands back a moment later.
import { CHECK_KEYS, CHECK_LABELS, checkStep, runningStep } from '../core/events.js';
// store.js reads `pngSize` back out of this file. Two modules about the same pictures
// leaning on each other is fine here — both sides are plain functions, so neither is
// half-built when the other asks for it.
import { thumbnailOf } from './store.js';

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
 * @param {{
 *   fixturesDir: string,
 *   record?: boolean,
 *   timeoutMs?: number,
 *   thumbnail?: boolean,
 *   onStep?: (step: import('../types.js').CheckStep) => void,
 * }} ctx
 *   `thumbnail` is asked for only while somebody is watching the run happen; it costs a
 *   decode of the picture that was just taken (skipped when the masks already decoded it)
 *   plus about forty milliseconds of shrinking, so it is off unless it is wanted.
 *
 *   `onStep` is the same idea for words instead of pixels: hand one in and this says
 *   what it is doing as it does it — each phase named the moment it starts and named
 *   again the moment it settles — so a watcher can tick the list off live instead of
 *   being shown a finished table. Gated exactly the way `thumbnail` is: the run hands
 *   one in only while a panel is open, so the ordinary case is one `typeof` check per
 *   phase and nothing allocated at all.
 * @returns {Promise<import('../types.js').CaptureReport & {
 *   masks: import('../types.js').MaskRect[],
 *   timings: {steps: number, prepare: number, settle: number},
 *   spent: {steps: number, prepare: number, settle: number},
 *   frozen: import('../core/events.js').FrozenPlan,
 *   loaded?: import('../core/events.js').LoadedReport,
 *   thumbnail?: string,
 * }>}
 *   The standard report, plus the mask rectangles that were painted so the comparison can
 *   paint the exact same rectangles onto the approved picture, plus where the time went.
 *   Only this function knows how its own milliseconds were spent, so it says, rather than
 *   leaving the run to guess by wrapping things it cannot see inside.
 *
 *   `frozen` and `loaded` are here so the run can tell a person what was actually done to
 *   this screen. `frozen` is what the freeze layer was ASKED for — the only place that
 *   knows a check was switched off in the config, and therefore the only way the list can
 *   say so instead of quietly claiming success. `loaded` is what the page itself said was
 *   still loading at the moment the shutter fired: a measurement, taken here because it
 *   cannot be recovered afterwards, and gone the instant the app moves on.
 */
export async function captureScreen(page, screen, settings, ctx) {
  const deviceScaleFactor = settings.viewport.deviceScaleFactor ?? 2;
  const settleConfig = settings.freeze.settle ?? {};
  const timeoutMs = ctx.timeoutMs ?? settleConfig.timeoutMs ?? 10_000;

  await page.setViewport(settings.viewport);
  page.clearConsole();

  // What the freeze layer is being ASKED for. Worked out before it is asked, because a
  // line announced as it starts can only be worded from what is already known — and a
  // project that switched the clock freezing off has to be told that at the moment it
  // does not happen, not have a freeze claimed and then taken back.
  /** @type {import('../core/events.js').FrozenPlan} */
  const plan = {
    clock: settings.freeze.clock !== false,
    motion: settings.freeze.motion !== false,
    random: settings.freeze.random !== 'off',
    fonts: settings.freeze.fonts !== false,
    network: settings.freeze.network ?? 'block-external',
    frames: settleConfig.frames ?? 2,
    maxDriftPixels: settleConfig.maxDriftPixels ?? 0,
  };
  const masksAsked = (settings.masks ?? []).length;

  // Gated exactly the way `thumbnail` is: the run hands an `onStep` in only while a
  // panel is open. Nobody watching means this is null, every announcement below is one
  // `if` that does nothing, and not a single object is made.
  const onStep = typeof ctx.onStep === 'function' ? ctx.onStep : null;
  /**
   * The line announced as started and not yet settled — so a failure can close it
   * instead of leaving a row spinning forever on somebody's screen.
   * @type {import('../types.js').CheckStep|null}
   */
  let pending = null;

  /**
   * Name a phase as it begins.
   * @param {import('../core/events.js').CheckKey} key
   * @param {import('../core/events.js').ChecksInput} input
   * @returns {void}
   */
  const begins = (key, input) => {
    if (!onStep) return;
    const step = runningStep(key, input);
    pending = step ?? null;
    if (step) onStep(step);
  };

  /**
   * Name the same phase again, settled, under the same key.
   * @param {import('../core/events.js').CheckKey} key
   * @param {import('../core/events.js').ChecksInput} input
   * @param {import('../types.js').CheckStep} [instead]  For a line whose number is not
   *   knowable yet; the finished list fills that in.
   * @returns {void}
   */
  const settled = (key, input, instead) => {
    if (!onStep) return;
    pending = null;
    const step = instead ?? checkStep(key, input);
    if (step) onStep(step);
  };

  /**
   * Close whatever was in flight when something went wrong.
   * @param {unknown} error
   * @returns {void}
   */
  const closePending = (error) => {
    if (!onStep || !pending) return;
    const why = messageOf(error);
    // Where a phase has its own wording for going wrong, use it: "could not reach the
    // screen" is what happened, and leaving "reached the screen" up with a cross beside
    // it says the opposite of the truth for as long as anybody is reading it.
    const label = pending.key === CHECK_KEYS.steps ? CHECK_LABELS.stepsFailed : pending.label;
    onStep({ ...pending, label, state: 'bad', detail: why });
    pending = null;
  };

  begins(CHECK_KEYS.frozen, { screen, frozen: plan });
  const frozen = await applyFreeze(page, settings.freeze, {
    fixturesDir: ctx.fixturesDir,
    screenName: screen.name,
    record: ctx.record ?? false,
    deviceScaleFactor,
  }).catch((error) => {
    closePending(error);
    throw error;
  });
  settled(CHECK_KEYS.frozen, { screen, frozen: plan });

  // A frozen clock cannot time anything, so the stopwatch is the host's own, and it is
  // the monotonic one: a machine that adjusts its clock mid-run must not be able to
  // report that a screen took a negative amount of time.
  const clock = process.hrtime.bigint;
  const startedSteps = clock();
  /** @type {{steps: number, prepare: number, settle: number}} */
  const spent = { steps: 0, prepare: 0, settle: 0 };

  try {
    begins(CHECK_KEYS.steps, { screen });
    if (typeof screen.do === 'function') {
      await screen.do(page);
    } else {
      await runSteps(page, screen.steps ?? []);
    }
    settled(CHECK_KEYS.steps, { screen });

    // Scrolling back to the top is the deterministic default, but a screen that
    // deliberately scrolled somewhere must be photographed where it landed.
    const scrolledOnPurpose =
      typeof screen.do === 'function' || (screen.steps ?? []).some((s) => s.scrollTo !== undefined);

    const startedPrepare = clock();
    spent.steps = since(startedSteps, startedPrepare);

    // Waiting for the page to be ready. WHAT was still loading can only be read off the
    // frame that ends up being kept, which does not exist yet, so this line settles on
    // the one thing that is true here — the shutter waited — and the finished list fills
    // in the count of faces and pictures a moment later, on the same line.
    begins(CHECK_KEYS.loaded, { screen, frozen: plan });
    await prepareForShutter(page, {
      fonts: settings.freeze.fonts !== false,
      timeoutMs,
      keepScroll: scrolledOnPurpose,
    });
    settled(
      CHECK_KEYS.loaded,
      { screen, frozen: plan },
      plan.fonts ? { key: CHECK_KEYS.loaded, label: CHECK_LABELS.loaded, state: 'ok' } : undefined,
    );

    /** @type {import('../types.js').CaptureOptions} */
    const shotOptions = {};
    if (screen.fullPage) shotOptions.fullPage = true;
    if (screen.clip) shotOptions.clip = screen.clip;

    // The same frame, asked for cheaply. The settle loop shoots the screen over and over
    // to find out whether anything moved and throws every one of those pictures away, so
    // it gets a small lossy one; the picture that is kept and compared is always the PNG.
    /** @type {import('../types.js').CaptureOptions & {format: 'jpeg', quality: number}} */
    const probeOptions = { ...shotOptions, format: 'jpeg', quality: 50 };

    const startedSettle = clock();
    spent.prepare = since(startedPrepare, startedSettle);

    // Holding still — and the shutter is inside it. The settle loop photographs the
    // screen over and over until two frames in a row are identical and keeps the last of
    // them, so this is ONE line rather than two: there is one thing happening.
    begins(CHECK_KEYS.settle, { screen, frozen: plan });
    const held = await settle(page, {
      frames: settleConfig.frames ?? 2,
      intervalMs: settleConfig.intervalMs ?? 250,
      timeoutMs: settleConfig.timeoutMs ?? 10_000,
      maxDriftPixels: settleConfig.maxDriftPixels ?? 0,
      capture: () => page.shoot(shotOptions),
      probe: () => page.shoot(probeOptions),
    });
    spent.settle = since(startedSettle, clock());
    settled(CHECK_KEYS.settle, { screen, settle: held.report, frozen: plan });

    // Asked the moment the picture exists, and never before: this is a statement about
    // the frame that was kept. Reading it is a single round trip that touches nothing —
    // no styles, no scroll, no focus — so it cannot change what the picture looks like,
    // and at a couple of milliseconds against a screen that takes seconds it is not
    // worth gating behind whether anybody is watching. Nobody can ask the page this
    // question later; by then the app has moved on.
    const loaded = await readLoaded(page);

    begins(CHECK_KEYS.masks, { screen, masksAsked });
    const rects = await resolveMasks(page, settings.masks ?? [], { deviceScaleFactor });
    // Masks force us to decode the picture; hold on to those pixels. The preview a
    // watcher is shown is made from the very same ones — the picture that gets
    // compared, blackout boxes and all — so a masked screen decodes a retina
    // screenshot once instead of twice, which is about eighty milliseconds a screen.
    const painted = rects.length > 0 ? paintInto(held.png, rects) : null;
    const png = painted ? painted.png : held.png;
    const size = pngSize(png);
    // Said after the painting, not after the finding: the line claims the boxes are on
    // the picture, so it waits until they are.
    settled(CHECK_KEYS.masks, { screen, masks: rects, masksAsked });

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

    // Requests are not a phase — the outside world is kept out for the whole capture —
    // so this is one line, said once, at the end. Counted here rather than a few lines
    // earlier so the number a watcher sees is the same number the finished list carries,
    // including anything the putting-back steps asked for.
    const stats = frozen.stats();
    settled(CHECK_KEYS.network, { screen, freeze: stats, frozen: plan });

    /** @type {import('../types.js').CaptureReport & {masks: import('../types.js').MaskRect[], timings: typeof spent, spent: typeof spent, frozen: import('../core/events.js').FrozenPlan, loaded?: import('../core/events.js').LoadedReport, thumbnail?: string}} */
    const report = {
      png,
      width: size.width,
      height: size.height,
      settle: held.report,
      consoleErrors: page.consoleErrors(),
      freeze: stats,
      masks: rects,
      // What was asked of the freeze layer, in the same words the config used. Worked
      // out at the top rather than here, because by the time anybody reports on this
      // screen the settings have been merged away — and because the live list needs the
      // same answer before any of this happens, and the two must never disagree.
      frozen: plan,
      // The same three numbers under both names the rest of the tool asks for them by.
      timings: spent,
      spent,
    };
    if (loaded) report.loaded = loaded;
    if (ctx.thumbnail === true) {
      const small = await thumbnailOf(painted ? painted.image : png);
      if (small) report.thumbnail = small;
    }
    return report;
  } catch (error) {
    // A row that stays "running" for the rest of the run is a lie about what happened.
    // The run reports the failure itself; this only closes the line it fell over on.
    closePending(error);
    throw error;
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
 * What the page says is still loading, at the moment the picture was taken.
 *
 * The shutter already waited for fonts and images before it fired; this asks the page
 * whether that wait actually finished, so a run can say "nothing still loading" and mean
 * it. Read-only by construction — it looks at `document.fonts.status` and the `complete`
 * flag of every `<img>`, and touches nothing else, which is what makes it safe to run
 * against a page whose picture has already been kept.
 *
 * A page that navigated, closed or crashed answers nothing, and nothing is what gets
 * reported: a missing measurement must never be dressed up as a passing one.
 *
 * @param {import('../types.js').PageHandle} page
 * @returns {Promise<import('../core/events.js').LoadedReport|undefined>}
 */
async function readLoaded(page) {
  const source = `(() => {
  var out = { fonts: 'none', images: 0, imagesPending: 0 };
  try {
    if (document.fonts && document.fonts.status) out.fonts = String(document.fonts.status);
  } catch (e) {}
  try {
    var imgs = document.images ? Array.prototype.slice.call(document.images) : [];
    out.images = imgs.length;
    for (var i = 0; i < imgs.length; i++) {
      if (!imgs[i].complete) out.imagesPending++;
    }
  } catch (e) {}
  return out;
})()`;

  try {
    const seen = await page.evaluate(source);
    if (!seen || typeof seen !== 'object') return undefined;
    return {
      fonts: typeof seen.fonts === 'string' ? seen.fonts : undefined,
      images: Number(seen.images) || 0,
      imagesPending: Number(seen.imagesPending) || 0,
    };
  } catch {
    // The page is gone. Say nothing rather than guess.
    return undefined;
  }
}

/**
 * Milliseconds between two readings of the monotonic clock.
 * @param {bigint} from
 * @param {bigint} to
 * @returns {number}
 */
function since(from, to) {
  return Number(to - from) / 1e6;
}

/**
 * Paint the masks into a screenshot and re-encode it.
 *
 * Hands back the decoded picture as well as the bytes. Whoever wants a preview of this
 * screen would otherwise decode the very same megapixels a second time, and on a retina
 * screenshot that is the most expensive thing either of them does.
 *
 * @param {Buffer} buffer
 * @param {import('../types.js').MaskRect[]} rects
 * @returns {{png: Buffer, image: import('pngjs').PNG}}
 */
function paintInto(buffer, rects) {
  const image = PNG.sync.read(buffer);
  paintMasks(image, rects);
  return { png: PNG.sync.write(image), image };
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
