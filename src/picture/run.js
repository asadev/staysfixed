/**
 * The picture net: photograph every screen, compare each against its approved
 * picture, and report in plain language.
 *
 * Two decisions in here are deliberate and load-bearing.
 * First, a screen that looks different is photographed again before the tool
 * believes it — one bad frame must never be reported as a regression, and a
 * screen that only matched on the second try is flagged so the flake register
 * catches it and a human eventually deletes or fixes it.
 * Second, nothing is ever approved automatically. A screen with no approved
 * picture is reported as new and waits for a person to look at it.
 */

import { captureScreen } from './capture.js';
import { compareFast, describeDifference } from './compare.js';
import { readApproved, writeResult, writeDiff, approveFromResult, thumbnailOf } from './store.js';
import { settingsForScreen } from '../core/config.js';
import { approvedPicture, resultPicture } from '../core/paths.js';
import { platformTag } from '../drive/find.js';
import { resetWindow } from '../drive/launch.js';
import { gitInfo } from '../core/git.js';
import { messageOf } from '../core/errors.js';
import { detail } from '../core/log.js';
import { emitEvent, fileUrl } from '../core/events.js';

/**
 * A picture result plus the one extra fact the flake register needs: whether it
 * only agreed with the approved picture after being photographed again.
 * @typedef {import('../types.js').PictureResult & {retriedToPass?: boolean}} PictureRunResult
 */

/**
 * What a watcher is shown of one screen, filled in as it is worked on.
 *
 * Two kinds of thing, for two different moments. The `file://` addresses are the real
 * full-resolution pictures this run wrote, and they are what a person actually looks
 * at and zooms into; they cost nothing to fill in, so they are always filled in. The
 * base64 previews are the instant stand-in for the fraction of a second before a file
 * loads, they cost real milliseconds to make, and they are only made when a window is
 * open to show them in.
 *
 * All of it is kept apart from the result on purpose. A result is written to disk and
 * read back by `approve` and `status`, and a base64 picture in there would bloat
 * every saved run for the sake of a panel that was only open for a minute.
 *
 * @typedef {object} Thumbs
 * @property {string} [shot]         Instant preview of the picture just taken.
 * @property {string} [approved]     Instant preview of the approved picture, when this screen changed.
 * @property {string} [diff]         Instant preview of what moved, when this screen changed.
 * @property {string} [shotFile]     The picture just taken, on disk.
 * @property {string} [approvedFile] The approved picture, on disk, when there is one.
 * @property {string} [diffFile]     The difference picture, on disk, when one was written.
 */

/**
 * @param {import('../types.js').Project} project
 * @param {import('../types.js').LaunchedApp} app
 * @param {{
 *   only?: string[],
 *   record?: boolean,
 *   updateNew?: boolean,
 *   onResult?: (r: PictureRunResult) => void,
 *   retries?: number,
 *   tool?: string,
 *   signal?: AbortSignal,
 *   events?: import('../types.js').RunEvents,
 *   timings?: ReturnType<typeof import('../core/events.js').makeTimings>,
 *   thumbnail?: boolean,
 * }} [opts]
 * @returns {Promise<PictureRunResult[]>}
 */
export async function runPictures(project, app, opts = {}) {
  const { config } = project;
  // The launcher hands back the public page surface; the capture loop needs the
  // plumbing underneath it (init scripts, console buffer) that the same object carries.
  const page = /** @type {import('../types.js').PageHandle} */ (app.page);
  const only = opts.only && opts.only.length > 0 ? new Set(opts.only) : null;
  const retries = Math.max(0, opts.retries ?? config.retries);
  const here = platformTag();
  // A desktop app has no url to go back to between screens, so it gets a reload instead.
  // A web app does not need one: every screen starts with a `goto`.
  const reset = config.app.kind === 'electron' ? () => resetWindow(app) : undefined;
  const events = opts.events;

  // Which screens are being photographed is settled before the first shutter, so
  // anyone watching can be told how many there are and where each one sits in the
  // queue rather than watching a list of unknown length crawl past.
  const chosen = config.screens.filter((screen) => !only || only.has(screen.name));
  const total = chosen.length;

  /** @type {PictureRunResult[]} */
  const results = [];

  for (let i = 0; i < chosen.length; i++) {
    if (opts.signal?.aborted) break;
    const screen = chosen[i];

    emitEvent(events, {
      type: 'screen:start',
      name: screen.name,
      describe: screen.describe,
      index: i + 1,
      total,
    });

    if (screen.skip) {
      const skipped = finish(opts, {
        name: screen.name,
        describe: screen.describe,
        status: 'skipped',
        message: `${screen.name} is switched off in the config.`,
        durationMs: 0,
      });
      results.push(skipped);
      emitDone(events, skipped, {});
      continue;
    }

    // Filled in as the screen is worked on, and read once it is finished. The
    // thumbnails exist only while somebody is watching, so they travel beside the
    // result instead of inside it.
    /** @type {Thumbs} */
    const thumbs = {};

    const result = await runOneScreen(project, page, screen, {
      record: opts.record,
      updateNew: opts.updateNew,
      tool: opts.tool,
      onResult: opts.onResult,
      retries,
      here,
      reset,
      events,
      timings: opts.timings,
      thumbnail: opts.thumbnail === true,
      thumbs,
    });
    results.push(result);
    emitDone(events, result, thumbs);
  }

  return results;
}

/**
 * Tell anyone watching how a screen turned out, with the pictures if there are any.
 *
 * @param {import('../types.js').RunEvents|undefined} events
 * @param {PictureRunResult} result
 * @param {Thumbs} thumbs
 * @returns {void}
 */
function emitDone(events, result, thumbs) {
  emitEvent(events, {
    type: 'screen:done',
    name: result.name,
    describe: result.describe,
    status: result.status,
    durationMs: result.durationMs,
    diffPixels: result.diffPixels,
    diffRatio: result.diffRatio,
    message: result.message,
    thumbnail: thumbs.shot,
    approvedThumb: thumbs.approved,
    diffThumb: thumbs.diff,
    // The real pictures. Only ever set for a file that was written or read a moment
    // ago, so anything that arrives here can be opened; a screen that was skipped, or
    // one that could not be photographed at all, sends none of them.
    shotFile: thumbs.shotFile,
    approvedFile: thumbs.approvedFile,
    diffFile: thumbs.diffFile,
  });
}

/**
 * Everything one screen needs, including where to leave what it learns.
 *
 * `thumbs` is written into rather than returned because a screen can finish down
 * half a dozen different paths, and threading a second return value through all
 * of them would bury the thing this function is actually for.
 *
 * @typedef {object} ScreenCtx
 * @property {boolean} [record]
 * @property {boolean} [updateNew]
 * @property {string} [tool]
 * @property {(r: PictureRunResult) => void} [onResult]
 * @property {number} retries
 * @property {string} here
 * @property {() => Promise<void>} [reset]
 * @property {import('../types.js').RunEvents} [events]
 * @property {ReturnType<typeof import('../core/events.js').makeTimings>} [timings]
 * @property {boolean} [thumbnail]        Make the small pictures a watcher needs.
 * @property {Thumbs} [thumbs]            Where those small pictures are left.
 */

/**
 * @param {import('../types.js').Project} project
 * @param {import('../types.js').PageHandle} page
 * @param {import('../types.js').ScreenConfig} screen
 * @param {ScreenCtx} ctx
 * @returns {Promise<PictureRunResult>}
 */
async function runOneScreen(project, page, screen, ctx) {
  const { config, paths } = project;
  const started = Date.now();
  const settings = settingsForScreen(config, screen);
  const approvedPaths = approvedPicture(paths, screen.name);
  const resultPaths = resultPicture(paths, screen.name);

  const approved = await readApproved(paths, screen.name);
  const platformNote = platformWarning(approved?.meta?.platform, ctx.here);

  // We have just read it, so it is certainly there. Pointed out even for a screen that
  // ends up matching: "show me what this is supposed to look like" is a fair question
  // about a screen that passed, and answering it costs one string.
  if (approved && ctx.thumbs) ctx.thumbs.approvedFile = fileUrl(approvedPaths.png);

  /** @type {string[]} */
  let consoleErrors = [];
  /** @type {{width: number, height: number}|undefined} */
  let size;
  /** @type {import('../types.js').CompareReport|null} */
  let compare = null;
  let attempts = 0;

  try {
    // Photograph, and if it disagrees with the approved picture, photograph again
    // before believing it. One flickering frame is not a regression.
    for (let attempt = 1; attempt <= ctx.retries + 1; attempt++) {
      attempts = attempt;
      // Every screen starts from the same place.
      //
      // A web screen begins with a `goto`, so it is naturally isolated. A desktop app
      // has no front door, and without this the ORDER of the screens quietly decides
      // the result — the screen that collapses a sidebar left it collapsed for every
      // screen and every guard after it. (A walk deliberately does NOT do this: a walk
      // is one journey through the app, in order.)
      if (ctx.reset) await ctx.reset();
      const shot = await captureScreen(page, screen, settings, {
        fixturesDir: paths.fixtures,
        record: ctx.record ?? false,
        timeoutMs: settings.freeze.settle?.timeoutMs,
        thumbnail: ctx.thumbnail === true,
      });
      accountForCapture(ctx.timings, shot);
      consoleErrors = shot.consoleErrors;
      size = { width: shot.width, height: shot.height };

      const shotFile = await writeResult(paths, screen.name, shot.png, {
        deviceScaleFactor: settings.viewport.deviceScaleFactor,
        describe: screen.describe,
      });

      // Said out loud before anything is compared, so a person watching sees the
      // picture appear while the run is still deciding what it thinks of it — but
      // AFTER the PNG is on disk, not the instant the shutter fires. The panel opens
      // the real file to show true pixels, and an <img> pointed at a file that does
      // not exist yet draws a torn page and never retries. The preview travels on the
      // same event and covers the moment the file takes to load.
      if (ctx.thumbs) {
        if (shot.thumbnail) ctx.thumbs.shot = shot.thumbnail;
        ctx.thumbs.shotFile = fileUrl(shotFile);
      }
      emitEvent(ctx.events, {
        type: 'screen:shot',
        name: screen.name,
        thumbnail: shot.thumbnail,
        shotFile: fileUrl(shotFile),
      });

      if (!approved) break;

      const stopCompare = ctx.timings?.mark('compare');
      // compareFast, not comparePng: identical bytes are answered from the PNG header
      // instead of decoding two retina images pixel by pixel. Nothing changed on most
      // screens on most runs, so this is the case that actually happens — it took the
      // comparing stage from about a quarter of a second a screen to nothing at all.
      compare = compareFast(approved.png, shot.png, settings.tolerance, shot.masks);
      stopCompare?.();
      if (compare.equal) break;
      if (attempt <= ctx.retries) {
        detail(`${screen.name} looked different on attempt ${attempt} — taking it again.`);
      }
    }
  } catch (error) {
    return finish(ctx, {
      name: screen.name,
      describe: screen.describe,
      status: 'failed',
      message: join(`${screen.name} could not be photographed. ${messageOf(error)}`, platformNote),
      durationMs: Date.now() - started,
      attempts,
      consoleErrors: consoleErrors.length > 0 ? consoleErrors : undefined,
    });
  }

  /** @type {PictureRunResult} */
  const base = {
    name: screen.name,
    describe: screen.describe,
    status: 'passed',
    durationMs: Date.now() - started,
    attempts,
    actualPath: resultPaths.png,
    size,
    consoleErrors: consoleErrors.length > 0 ? consoleErrors : undefined,
  };

  if (!approved) {
    if (ctx.updateNew) {
      // Only ever reached from a flag a person typed, and only for a screen that
      // has never been approved. A picture that already exists always needs eyes.
      const git = await gitInfo(paths.root);
      const meta = await approveFromResult(paths, screen.name, {
        git,
        tool: ctx.tool,
        describe: screen.describe,
        deviceScaleFactor: settings.viewport.deviceScaleFactor,
      });
      // It exists now, because that call is what wrote it.
      if (ctx.thumbs) ctx.thumbs.approvedFile = fileUrl(approvedPaths.png);
      return finish(ctx, {
        ...base,
        status: 'new',
        approvedPath: approvedPaths.png,
        approvedSize: { width: meta.width, height: meta.height },
        message: join(`${screen.name} had no approved picture — this one was saved as the first.`, platformNote),
      });
    }
    return finish(ctx, {
      ...base,
      status: 'new',
      message: join(
        `${screen.name} has no approved picture yet — look at it and run \`staysfixed approve ${screen.name}\` if it is right.`,
        platformNote,
      ),
    });
  }

  if (!compare) {
    // Cannot happen: with an approved picture every attempt compares. Kept so a
    // future edit that breaks that assumption fails loudly instead of silently passing.
    return finish(ctx, {
      ...base,
      status: 'failed',
      message: join(`${screen.name} was photographed but never compared.`, platformNote),
    });
  }

  const common = {
    ...base,
    approvedPath: approvedPaths.png,
    approvedSize: compare.approvedSize,
    diffPixels: compare.diffPixels,
    diffRatio: compare.diffRatio,
  };

  if (compare.equal) {
    const retriedToPass = attempts > 1;
    return finish(ctx, {
      ...common,
      status: 'passed',
      retriedToPass,
      message: retriedToPass
        ? join(
            `${screen.name} matched, but only when it was photographed again — it may be unreliable.`,
            platformNote,
          )
        : platformNote || undefined,
    });
  }

  /** @type {string|undefined} */
  let diffPath;
  if (compare.diffPng) {
    diffPath = await writeDiff(paths, screen.name, compare.diffPng);
    // Set only inside this branch: a screen that matched has no difference picture, and
    // a stale one from a previous run is deleted before every run for exactly that
    // reason. Pointing at one that is not there is how a panel starts lying.
    if (ctx.thumbs) ctx.thumbs.diffFile = fileUrl(diffPath);
  }

  // Only for a screen that actually moved, and only when somebody is watching:
  // this is the one moment a person wants the approved picture and the difference
  // side by side with the new one.
  //
  // Both are made at the same size as the new picture's preview, because a person
  // comparing three pictures must not be shown one sharp one and two blurred ones.
  // Each costs a decode plus a shrink — about an eighth of a second on a retina
  // screenshot — so this stays behind both gates, and behind `changed`. A run where
  // everything held pays none of it.
  if (ctx.thumbnail === true && ctx.thumbs) {
    ctx.thumbs.approved = (await thumbnailOf(approved.png)) ?? undefined;
    if (compare.diffPng) ctx.thumbs.diff = (await thumbnailOf(compare.diffPng)) ?? undefined;
  }

  const what = describeDifference(compare, screen.name);
  const next = compare.sizeMismatch
    ? 'There is no difference picture for a size change — open the new picture and look at it.'
    : `Open the difference picture, and if the new look is right run \`staysfixed approve ${screen.name}\`.`;

  return finish(ctx, {
    ...common,
    status: 'changed',
    diffPath,
    message: join(what, next, platformNote),
  });
}

/**
 * Put the time one picture took into the buckets it belongs in. The walk uses
 * this too, so a walkthrough and a check file their time the same way.
 *
 * Only capture knows how its own milliseconds went, so it says, and this puts
 * what it said where the profile can find it. If it ever stops saying, the one
 * number still worth claiming is how long the screen was held still before the
 * shutter; the rest goes unclaimed into `other` rather than being guessed at,
 * because a made-up profile is worse than a missing one.
 *
 * @param {ReturnType<typeof import('../core/events.js').makeTimings>|undefined} timings
 * @param {Awaited<ReturnType<typeof captureScreen>>} shot
 * @returns {void}
 */
export function accountForCapture(timings, shot) {
  if (!timings) return;
  const reported = shot.timings;
  if (reported) {
    timings.add('steps', reported.steps);
    timings.add('prepare', reported.prepare);
    timings.add('settle', reported.settle);
    return;
  }
  if (shot.settle) timings.add('settle', shot.settle.waitedMs);
}

/**
 * Font rendering differs between operating systems, so a picture approved on one
 * and checked on another is the single most common false alarm. Say it; never
 * fail on it alone.
 * @param {string|undefined} approvedOn
 * @param {string} here
 * @returns {string}
 */
function platformWarning(approvedOn, here) {
  if (!approvedOn || approvedOn === here) return '';
  return `Careful: this picture was approved on ${approvedOn} and checked on ${here}. Text is drawn differently on each, so a small difference here may mean nothing.`;
}

/**
 * @param {{onResult?: (r: PictureRunResult) => void}} ctx
 * @param {PictureRunResult} result
 * @returns {PictureRunResult}
 */
function finish(ctx, result) {
  if (ctx.onResult) ctx.onResult(result);
  return result;
}

/**
 * @param {...(string|undefined)} parts
 * @returns {string}
 */
function join(...parts) {
  return parts.filter(Boolean).join(' ');
}
