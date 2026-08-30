/**
 * The engine.
 *
 * The CLI and the MCP server both come through here, which is the point: what a
 * person sees when they type `staysfixed check` and what an agent sees when it
 * calls `staysfixed_check` are the same run, decided by the same rules. If the
 * two ever drift apart, the agent starts marking its own homework.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { StaysFixedError, messageOf } from './core/errors.js';
import { ensureDirs, clearResults, resultPicture, safeName } from './core/paths.js';
import { gitInfo } from './core/git.js';
import { loadHistory, saveHistory, foldRun, condemned } from './core/history.js';
import { warn, detail, shortPath } from './core/log.js';
import { makeTimings, emitEvent } from './core/events.js';
import { launchApp } from './drive/launch.js';
import { platformTag } from './drive/find.js';
import { runPictures } from './picture/run.js';
import { approveFromResult, listApproved } from './picture/store.js';
import { loadGuards } from './guard/load.js';
import { runGuards } from './guard/run.js';
import { walkApp, writeWalkContactSheet, countWalkSteps } from './walk/run.js';
import { listMarkers } from './marker/mark.js';
import { writeRunReport } from './report/html.js';
import { printPictureResult, printGuardResult } from './report/console.js';

const require = createRequire(import.meta.url);

/** The version of the tool, read off package.json so it can never drift from what shipped. */
export const VERSION = /** @type {{version?: string}} */ (require('../package.json')).version ?? '0.0.0';

/** How a run stamps itself into pictures, markers and reports. */
const TOOL = `staysfixed ${VERSION}`;

/** The verdict of the last run, parked where `status` and `approve` can read it without re-running anything. */
const LAST_RUN = 'last-run.json';

/**
 * @typedef {import('./picture/run.js').PictureRunResult} PictureRunResult
 */

/**
 * What `projectStatus` answers with. Nothing in here costs more than reading a
 * few small files — `staysfixed status` has to be instant or nobody types it.
 *
 * @typedef {object} StatusReport
 * @property {number} screens                  Screens described in the config.
 * @property {number} guards                   Guards found on disk.
 * @property {string|null} guardsError         Why the guards could not be counted, in plain language.
 * @property {number} approved                 Approved pictures on disk.
 * @property {string[]} missingApproved        Screens nobody has approved a picture for yet.
 * @property {number} markers                  Known-good markers written so far.
 * @property {{label: string, at: string}|null} lastMarker  The newest marker, ready for the status printer.
 * @property {import('./types.js').RunSummary|null} lastRun
 * @property {string[]} condemned              Checks that have flaked past the limit.
 * @property {string} configFile
 * @property {string} root
 * @property {'web'|'electron'} appKind
 */

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

/**
 * Run every net the project has: photograph the screens, then run the guards.
 *
 * Unless `quiet` is set this prints one line per check as it finishes, so a
 * person watching a long run sees it moving. It does not print the closing
 * summary — the caller owns that, so the CLI can add its own next steps.
 *
 * @param {import('./types.js').Project} project
 * @param {{
 *   only?: string[],
 *   picturesOnly?: boolean,
 *   guardsOnly?: boolean,
 *   record?: boolean,
 *   signal?: AbortSignal,
 *   quiet?: boolean,
 *   onPicture?: (result: import('./types.js').PictureResult) => void,
 *   onGuard?: (result: import('./types.js').GuardResult) => void,
 *   writeReport?: boolean,
 *   events?: import('./types.js').RunEvents,
 *   watching?: boolean,
 *   onApp?: (app: import('./types.js').LaunchedApp) => Promise<void>,
 *   timings?: ReturnType<typeof makeTimings>,
 * }} [opts]
 * @returns {Promise<import('./types.js').RunSummary>}
 */
export async function runCheck(project, opts = {}) {
  const { config, paths } = project;
  const startedAt = new Date();
  const started = Date.now();
  const events = opts.events;
  const watching = opts.watching === true;
  // A run always knows where its time went, whether or not anybody asked. It
  // costs two numbers per phase, and the alternative is being unable to answer
  // "why did that take three minutes" without running it all again.
  const timings = opts.timings ?? makeTimings();

  await ensureDirs(paths);
  // Yesterday's evidence goes in the bin before today's is taken. A stale diff
  // image sitting next to a fresh picture is the most convincing lie this tool
  // could tell, and somebody would act on it.
  await clearResults(paths);

  const terms = normaliseOnly(opts.only);
  const wantPictures = opts.guardsOnly !== true;
  const wantGuards = opts.picturesOnly !== true;

  // Guards are loaded before anything is launched, on purpose. A guard with a
  // name nobody can read, or with no run function, is a mistake in the project
  // — catching it now costs two seconds, catching it after a browser and a dev
  // server have started costs two minutes of somebody's afternoon.
  const allGuards = wantGuards ? await loadGuards(project) : [];
  const guards = terms ? allGuards.filter((g) => terms.some((t) => matches(g.name, t))) : allGuards;

  const allScreens = wantPictures ? config.screens : [];
  const screens = terms ? allScreens.filter((s) => terms.some((t) => matches(s.name, t))) : allScreens;

  if (terms && screens.length === 0 && guards.length === 0) {
    throw new StaysFixedError(`Nothing here is called ${terms.map((t) => `"${t}"`).join(' or ')}.`, {
      hint: nameHint(config, allGuards),
    });
  }

  emitEvent(events, {
    type: 'run:start',
    plan: {
      screens: screens.length,
      guards: guards.length,
      app: describeApp(config.app),
      project: path.basename(paths.root),
      watching,
    },
  });

  const onPicture = opts.onPicture ?? (opts.quiet ? undefined : (/** @type {import('./types.js').PictureResult} */ r) => printPictureResult(r));
  const onGuard = opts.onGuard ?? (opts.quiet ? undefined : (/** @type {import('./types.js').GuardResult} */ r) => printGuardResult(r));

  /** @type {PictureRunResult[]} */
  let pictures = [];
  /** @type {import('./types.js').GuardResult[]} */
  let guardResults = [];

  // Nothing to look at means nothing to open. Starting a browser to check zero
  // screens is thirty seconds of somebody's life for no answer.
  if (screens.length > 0 || guards.length > 0) {
    await withApp(
      project,
      async (app) => {
        if (screens.length > 0) {
          emitEvent(events, { type: 'phase', message: 'photographing' });
          pictures = await runPictures(project, app, {
            only: screens.map((s) => s.name),
            record: opts.record ?? false,
            retries: config.retries,
            tool: TOOL,
            onResult: onPicture,
            signal: opts.signal,
            events,
            timings,
            // Small pictures cost time to make, so they are only made when there
            // is a window open to show them in.
            thumbnail: Boolean(events && watching),
          });
        }
        if (guards.length > 0) {
          emitEvent(events, { type: 'phase', message: 'running the guards' });
          const stopGuards = timings.mark('guards');
          try {
            guardResults = await runGuards(project, app, guards, {
              onResult: onGuard,
              signal: opts.signal,
              events,
            });
          } finally {
            stopGuards();
          }
        }
      },
      { events, timings, onApp: opts.onApp },
    );
  }

  const git = await gitInfo(paths.root);
  const finishedAt = new Date().toISOString();

  /** @type {string[]} */
  let condemnedNames = [];
  try {
    const history = await loadHistory(paths.historyFile);
    const result = foldRun(history, foldable(pictures, guardResults), git, finishedAt, config.flakeLimit);
    await saveHistory(paths.historyFile, result.history);
    condemnedNames = condemned(result.history).map((e) => e.name);
    for (const name of result.newlyCondemned) {
      warn(
        `"${name}" has now changed its mind ${config.flakeLimit} times while the code stood still. ` +
          'Fix it or delete it — a check people re-run until it goes green is worse than no check at all.',
      );
    }
  } catch (e) {
    // The register is a nice-to-have. Losing it must never lose the verdict.
    warn(`The run finished, but the flaky-check register could not be updated. ${messageOf(e)}`);
  }

  const totals = countUp(pictures, guardResults);

  /** @type {import('./types.js').RunSummary & {timings?: import('./types.js').Timings}} */
  const summary = {
    id: runId(startedAt),
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - started,
    pictures,
    guards: guardResults,
    totals,
    // A picture nobody has ever approved is not a pass: the tool has no opinion
    // about whether that screen is right, only a person does. So `new` keeps a
    // run out of the green exactly the way `changed` does.
    ok: totals.changed === 0 && totals.failed === 0 && totals.missing === 0 && totals.new === 0,
    git,
    tool: TOOL,
    platform: platformTag(),
    condemned: condemnedNames,
    // What `--only` left out. A narrowed run that says "everything that worked still works"
    // is describing a slice and sounding like the whole: measured 2026-08-30 with five of
    // six guards filtered away and one of the five failing, and the run still exited 0
    // saying everything works. A pass has to carry the size of what it looked at.
    leftOut: terms
      ? {
          screens: Math.max(0, allScreens.length - screens.length),
          guards: Math.max(0, allGuards.length - guards.length),
          terms,
        }
      : undefined,
    // Read here rather than at the very end: what follows is writing files, and
    // where the run spent its time is a fact about the run, not about the report.
    timings: timings.get(),
  };

  if (opts.writeReport !== false) {
    try {
      const file = await writeRunReport(project, summary);
      detail(`Report written to ${shortPath(file)}`);
    } catch (e) {
      warn(`The run finished, but the report page could not be written. ${messageOf(e)}`);
    }
  }

  try {
    await fsp.writeFile(lastRunFile(paths), JSON.stringify(summary, null, 2) + '\n');
  } catch (e) {
    warn(`The run finished, but its result could not be saved for \`staysfixed status\`. ${messageOf(e)}`);
  }

  // Last, so anything watching that closes on the verdict does not race the
  // report being written.
  emitEvent(events, { type: 'run:done', summary });

  return summary;
}

// ---------------------------------------------------------------------------
// one screen
// ---------------------------------------------------------------------------

/**
 * Open the app, photograph one screen, compare it if there is something to
 * compare against, and shut down again.
 *
 * This is what an agent gets when it wants to look at what it just built. It
 * writes the picture into `results/` like a normal run does, which is what makes
 * `staysfixed approve <name>` work afterwards — the agent takes the photo, a
 * person says yes to it.
 *
 * @param {import('./types.js').Project} project
 * @param {string} screenName
 * @param {{
 *   record?: boolean,
 *   retries?: number,
 *   signal?: AbortSignal,
 *   onResult?: (r: import('./types.js').PictureResult) => void,
 *   events?: import('./types.js').RunEvents,
 *   watching?: boolean,
 *   timings?: ReturnType<typeof makeTimings>,
 * }} [opts]
 * @returns {Promise<{png: Buffer, result: import('./types.js').PictureResult, path: string}>}
 */
export async function captureOne(project, screenName, opts = {}) {
  const { config, paths } = project;
  const wanted = String(screenName ?? '').trim();
  const screen =
    config.screens.find((s) => s.name === wanted) ??
    config.screens.find((s) => s.name.toLowerCase() === wanted.toLowerCase());

  if (!screen) {
    throw new StaysFixedError(`There is no screen called "${wanted}" in this project.`, {
      hint: nameHint(config, []),
    });
  }

  await ensureDirs(paths);

  const events = opts.events;
  const watching = opts.watching === true;
  const timings = opts.timings ?? makeTimings();

  // One screen is still a run as far as anyone watching is concerned, so it
  // describes itself the same way. This is what lets an agent's own capture be
  // watched in the same window as a full check.
  emitEvent(events, {
    type: 'run:start',
    plan: {
      screens: 1,
      guards: 0,
      app: describeApp(config.app),
      project: path.basename(paths.root),
      watching,
    },
  });

  const results = await withApp(
    project,
    (app) => {
      emitEvent(events, { type: 'phase', message: 'photographing' });
      return runPictures(project, app, {
        only: [screen.name],
        record: opts.record ?? false,
        retries: opts.retries ?? config.retries,
        tool: TOOL,
        onResult: opts.onResult,
        signal: opts.signal,
        events,
        timings,
        thumbnail: Boolean(events && watching),
      });
    },
    { events, timings },
  );

  // Said as soon as the app is shut. What is left is reading a file off disk,
  // and a watcher should not be left with a spinner turning through it.
  emitEvent(events, { type: 'run:done' });

  const result = results[0];
  if (!result) {
    throw new StaysFixedError(`"${screen.name}" was not photographed.`, {
      hint: 'It may be switched off in the config with `skip: true`.',
    });
  }

  const file = result.actualPath ?? resultPicture(paths, screen.name).png;
  try {
    return { png: await fsp.readFile(file), result, path: file };
  } catch (cause) {
    throw new StaysFixedError(result.message ?? `"${screen.name}" could not be photographed.`, { cause });
  }
}

// ---------------------------------------------------------------------------
// walk
// ---------------------------------------------------------------------------

/**
 * Open the real app, walk it end to end, and leave behind one page of photos
 * anyone can open — the thing you look at before you press release.
 *
 * @param {import('./types.js').Project} project
 * @param {{
 *   only?: string|string[],
 *   record?: boolean,
 *   signal?: AbortSignal,
 *   onStep?: (update: import('./walk/run.js').WalkProgress) => void,
 *   writeReport?: boolean,
 *   events?: import('./types.js').RunEvents,
 *   watching?: boolean,
 *   onApp?: (app: import('./types.js').LaunchedApp) => Promise<void>,
 *   timings?: ReturnType<typeof makeTimings>,
 * }} [opts]
 * @returns {Promise<import('./types.js').WalkReport>}
 */
export async function runWalk(project, opts = {}) {
  await ensureDirs(project.paths);

  const events = opts.events;
  const watching = opts.watching === true;
  // The caller's stopwatch when it brought one — `--profile` reads it back out
  // afterwards, so a walk that quietly kept its own would print all zeros.
  const timings = opts.timings ?? makeTimings();

  emitEvent(events, {
    type: 'run:start',
    plan: {
      // Counted before anything is opened so the window can draw the whole list
      // straight away. A walk with nothing to walk through says nothing here and
      // fails a moment later, in one place, with a sentence a person can act on.
      screens: countWalk(project.config, opts.only),
      guards: 0,
      app: describeApp(project.config.app),
      project: path.basename(project.paths.root),
      watching,
    },
  });

  const report = await withApp(
    project,
    (app) => {
      emitEvent(events, { type: 'phase', message: 'photographing' });
      return walkApp(project, app, {
        only: opts.only,
        record: opts.record ?? false,
        onStep: opts.onStep,
        signal: opts.signal,
        events,
        thumbnail: Boolean(events && watching),
        timings,
      });
    },
    { events, timings, onApp: opts.onApp },
  );

  // A walk has no verdict to hand over — the pictures are the point — so this
  // says only that it is over. Said here, with the app shut and every photo
  // taken; the page that shows them is written after.
  emitEvent(events, { type: 'run:done' });

  if (opts.writeReport === false) return report;

  try {
    // Beside the photos, not in the project root: a walkthrough belongs with the
    // pictures it is made of, and both are throwaway evidence.
    const file = await writeWalkContactSheet(report, path.join(report.dir, 'walkthrough.html'));
    return { ...report, reportFile: file };
  } catch (e) {
    warn(`The walkthrough was photographed, but the page showing it could not be written. ${messageOf(e)}`);
    return report;
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * What this project has set up and where it stood after the last run.
 *
 * Deliberately opens nothing: `status` is the question you ask when you are not
 * sure the tool is even wired up, and it has to answer immediately.
 *
 * @param {import('./types.js').Project} project
 * @returns {Promise<StatusReport>}
 */
export async function projectStatus(project) {
  const { config, paths } = project;

  let guardCount = 0;
  /** @type {string|null} */
  let guardsError = null;
  try {
    guardCount = (await loadGuards(project)).length;
  } catch (e) {
    // A broken guard file must not stop somebody finding out what else is here.
    guardsError = messageOf(e);
  }

  const approved = await listApproved(paths).catch(() => /** @type {string[]} */ ([]));
  const approvedSet = new Set(approved);
  const missingApproved = config.screens
    .filter((s) => !s.skip && !approvedSet.has(safeName(s.name)))
    .map((s) => s.name);

  const markers = await listMarkers(project).catch(() => /** @type {import('./types.js').Marker[]} */ ([]));
  const history = await loadHistory(paths.historyFile);

  return {
    screens: config.screens.length,
    guards: guardCount,
    guardsError,
    approved: approved.length,
    missingApproved,
    markers: markers.length,
    lastMarker: markers.length > 0 ? { label: markers[0].label, at: markers[0].at } : null,
    lastRun: await readLastRun(paths),
    condemned: condemned(history).map((e) => e.name),
    configFile: paths.configFile,
    root: paths.root,
    appKind: config.app.kind,
  };
}

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

/**
 * Promote pictures from the last run to being the approved ones.
 *
 * This is the only door a new look walks through, and a person is always the one
 * holding it open. Names with nothing behind them are refused with a reason
 * rather than quietly ignored, because "approved" printed next to a name that
 * was never actually approved is how trust in the whole tool goes.
 *
 * With no names (or `all`), everything the last run called changed or new is
 * approved together.
 *
 * @param {import('./types.js').Project} project
 * @param {string[]} names
 * @param {{all?: boolean, tool?: string}} [opts]
 * @returns {Promise<{approved: string[], skipped: {name: string, why: string}[]}>}
 */
export async function approveScreens(project, names, opts = {}) {
  const { config, paths } = project;
  const last = await readLastRun(paths);

  let wanted = unique((names ?? []).map((n) => String(n ?? '').trim()).filter(Boolean));

  if (opts.all === true || wanted.length === 0) {
    if (!last) {
      throw new StaysFixedError('There is nothing to approve — no check has been run in this project yet.', {
        hint: 'Run `staysfixed check` first, look at what it found, then approve what is right.',
      });
    }
    wanted = unique(
      last.pictures.filter((p) => p.status === 'changed' || p.status === 'new').map((p) => p.name),
    );
  }

  /** @type {string[]} */
  const approved = [];
  /** @type {{name: string, why: string}[]} */
  const skipped = [];

  const git = await gitInfo(paths.root);
  const tool = opts.tool ?? TOOL;

  for (const asked of wanted) {
    const screen =
      config.screens.find((s) => s.name === asked) ??
      config.screens.find((s) => s.name.toLowerCase() === asked.toLowerCase());
    const name = screen ? screen.name : asked;

    if (!(await exists(resultPicture(paths, name).png))) {
      skipped.push({
        name,
        why: screen
          ? `There is no picture of "${name}" from the last run, so there is nothing to approve. Run \`staysfixed check\` first.`
          : `Nothing here is called "${name}", and there is no picture of it from the last run either.`,
      });
      continue;
    }

    try {
      await approveFromResult(paths, name, { git, tool, describe: screen?.describe });
      approved.push(name);
    } catch (e) {
      skipped.push({ name, why: messageOf(e) });
    }
  }

  return { approved, skipped };
}

// ---------------------------------------------------------------------------
// the plumbing
// ---------------------------------------------------------------------------

/**
 * Open the app, do the work, and always close it again — a browser or an
 * Electron window left running is a leaked process on somebody's machine, and
 * the next run will fight it for the debug port.
 *
 * `onApp` is the one hook in here. It is handed the app the moment it is open
 * and before a single picture is taken, which is what lets the watch panel put
 * itself beside a window that did not exist when the panel opened. It moves
 * windows around a desk; it never touches the page, and the picture comes from
 * the viewport the capture sets, not from the window — so where the window ends
 * up cannot change what was photographed.
 *
 * @template T
 * @param {import('./types.js').Project} project
 * @param {(app: import('./types.js').LaunchedApp) => Promise<T>} work
 * @param {{
 *   events?: import('./types.js').RunEvents,
 *   timings?: ReturnType<typeof makeTimings>,
 *   onApp?: (app: import('./types.js').LaunchedApp) => Promise<void>,
 * }} [ctx]
 * @returns {Promise<T>}
 */
async function withApp(project, work, ctx = {}) {
  emitEvent(ctx.events, { type: 'phase', message: 'opening the app' });
  const stopLaunch = ctx.timings?.mark('launch');
  // Stopped even when the app never opened: a launch that gave up after fifty
  // seconds is exactly the number somebody wants to see.
  const app = await launchApp(project).finally(() => stopLaunch?.());
  if (ctx.onApp) {
    try {
      await ctx.onApp(app);
    } catch (e) {
      // Whatever wanted a look at the app is a spectator. A spectator that
      // trips over must not take the run down with it, and is not worth a
      // warning in the middle of a clean one.
      detail(`Something watching this run could not be shown the app. ${messageOf(e)}`);
    }
  }
  try {
    return await work(app);
  } finally {
    emitEvent(ctx.events, { type: 'phase', message: 'closing' });
    try {
      await app.close();
    } catch (e) {
      warn(`The app could not be closed cleanly. ${messageOf(e)}`);
    }
  }
}

/**
 * How many screens a walk will visit, or none when there is nothing to walk.
 *
 * @param {import('./types.js').ResolvedConfig} config
 * @param {string|string[]} [only]
 * @returns {number}
 */
function countWalk(config, only) {
  try {
    return countWalkSteps(config, only);
  } catch {
    // Nothing to walk through. The walk itself says so properly, in one place.
    return 0;
  }
}

/**
 * The app being opened, in a few words: what kind it is and which one it is.
 *
 * A watcher shows this at the top of a narrow panel, so the whole path or the
 * whole address would be noise — the name of the binary, or the host being
 * opened, is what a person recognises.
 *
 * @param {import('./types.js').AppConfig} app
 * @returns {string}
 */
function describeApp(app) {
  if (app.kind === 'electron') {
    const binary = app.binary ?? app.attach ?? '';
    return binary ? `electron — ${path.basename(binary)}` : 'electron';
  }
  const url = app.url ?? app.attach ?? '';
  if (!url) return 'web';
  try {
    // A web address has no useful last part — "/" is not a name — so the host is
    // what gets shown: "web — localhost:5173".
    return `web — ${new URL(url).host || url}`;
  } catch {
    return `web — ${url}`;
  }
}

/**
 * Flatten both kinds of result into the one shape the flake register folds.
 * @param {PictureRunResult[]} pictures
 * @param {import('./types.js').GuardResult[]} guards
 * @returns {{name: string, kind: 'picture'|'guard', status: import('./types.js').CheckStatus, retriedToPass?: boolean}[]}
 */
function foldable(pictures, guards) {
  return [
    ...pictures.map((p) => ({
      name: p.name,
      kind: /** @type {'picture'} */ ('picture'),
      status: p.status,
      retriedToPass: p.retriedToPass,
    })),
    ...guards.map((g) => ({
      name: g.name,
      kind: /** @type {'guard'} */ ('guard'),
      status: g.status,
      // The guard runner records this the same way the picture runner does; it
      // just is not part of the shared result shape.
      retriedToPass: /** @type {{retriedToPass?: boolean}} */ (g).retriedToPass,
    })),
  ];
}

/**
 * @param {PictureRunResult[]} pictures
 * @param {import('./types.js').GuardResult[]} guards
 * @returns {import('./types.js').RunSummary['totals']}
 */
function countUp(pictures, guards) {
  const totals = { passed: 0, changed: 0, new: 0, failed: 0, missing: 0, skipped: 0 };
  for (const status of [...pictures.map((p) => p.status), ...guards.map((g) => g.status)]) {
    switch (status) {
      case 'passed':
        totals.passed += 1;
        break;
      case 'changed':
        totals.changed += 1;
        break;
      case 'new':
        totals.new += 1;
        break;
      case 'failed':
        totals.failed += 1;
        break;
      case 'missing':
        totals.missing += 1;
        break;
      case 'skipped':
        totals.skipped += 1;
        break;
      // 'flaky' is what the history says about a check over time, never a
      // verdict one run hands down, so it is not a column here.
      case 'flaky':
        break;
    }
  }
  return totals;
}

/**
 * A sortable stamp off the local clock, so runs read in order in a folder
 * listing and a person recognises the time they ran it.
 * @param {Date} at
 * @returns {string}
 */
function runId(at) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}

/**
 * @param {string[]|undefined} only
 * @returns {string[]|null}
 */
function normaliseOnly(only) {
  if (!only) return null;
  const terms = only.map((t) => String(t ?? '').trim()).filter(Boolean);
  return terms.length > 0 ? terms : null;
}

/**
 * `--only sessions` should find "sessions-empty" as well as "sessions", because
 * nobody types a screen name out exactly, and nobody should have to.
 * @param {string} name
 * @param {string} term
 * @returns {boolean}
 */
function matches(name, term) {
  const haystack = name.toLowerCase();
  const needle = term.toLowerCase();
  return haystack === needle || haystack.includes(needle);
}

/**
 * @param {import('./types.js').ResolvedConfig} config
 * @param {import('./types.js').Guard[]} guards
 * @returns {string}
 */
function nameHint(config, guards) {
  const screens = config.screens.map((s) => s.name);
  const parts = [];
  if (screens.length > 0) parts.push(`Screens: ${screens.join(', ')}.`);
  if (guards.length > 0) parts.push(`Guards: ${guards.map((g) => `"${g.name}"`).join(', ')}.`);
  if (parts.length === 0) return 'This project has no screens and no guards yet.';
  return parts.join(' ');
}

/**
 * @param {import('./types.js').ProjectPaths} paths
 * @returns {string}
 */
function lastRunFile(paths) {
  return path.join(paths.results, LAST_RUN);
}

/**
 * @param {import('./types.js').ProjectPaths} paths
 * @returns {Promise<import('./types.js').RunSummary|null>}
 */
async function readLastRun(paths) {
  try {
    const parsed = JSON.parse(await fsp.readFile(lastRunFile(paths), 'utf8'));
    return parsed && typeof parsed === 'object' ? /** @type {import('./types.js').RunSummary} */ (parsed) : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string[]} list
 * @returns {string[]}
 */
function unique(list) {
  return [...new Set(list)];
}
