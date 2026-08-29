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
import { comparePng, describeDifference } from './compare.js';
import { readApproved, writeResult, writeDiff, approveFromResult } from './store.js';
import { settingsForScreen } from '../core/config.js';
import { approvedPicture, resultPicture } from '../core/paths.js';
import { platformTag } from '../drive/find.js';
import { resetWindow } from '../drive/launch.js';
import { gitInfo } from '../core/git.js';
import { messageOf } from '../core/errors.js';
import { detail } from '../core/log.js';

/**
 * A picture result plus the one extra fact the flake register needs: whether it
 * only agreed with the approved picture after being photographed again.
 * @typedef {import('../types.js').PictureResult & {retriedToPass?: boolean}} PictureRunResult
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

  /** @type {PictureRunResult[]} */
  const results = [];

  for (const screen of config.screens) {
    if (opts.signal?.aborted) break;
    if (only && !only.has(screen.name)) continue;

    if (screen.skip) {
      results.push(
        finish(opts, {
          name: screen.name,
          describe: screen.describe,
          status: 'skipped',
          message: `${screen.name} is switched off in the config.`,
          durationMs: 0,
        }),
      );
      continue;
    }

    results.push(
      await runOneScreen(project, page, screen, {
        record: opts.record,
        updateNew: opts.updateNew,
        tool: opts.tool,
        onResult: opts.onResult,
        retries,
        here,
        reset,
      }),
    );
  }

  return results;
}

/**
 * @param {import('../types.js').Project} project
 * @param {import('../types.js').PageHandle} page
 * @param {import('../types.js').ScreenConfig} screen
 * @param {{record?: boolean, updateNew?: boolean, tool?: string, onResult?: (r: PictureRunResult) => void, retries: number, here: string, reset?: () => Promise<void>}} ctx
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
      });
      consoleErrors = shot.consoleErrors;
      size = { width: shot.width, height: shot.height };

      await writeResult(paths, screen.name, shot.png, {
        deviceScaleFactor: settings.viewport.deviceScaleFactor,
        describe: screen.describe,
      });

      if (!approved) break;

      compare = comparePng(approved.png, shot.png, settings.tolerance, shot.masks);
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
  if (compare.diffPng) diffPath = await writeDiff(paths, screen.name, compare.diffPng);

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
