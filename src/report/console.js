/**
 * Everything Stays Fixed says in a terminal.
 *
 * The reader is not always a programmer, and never wants to be one at 1am, so
 * there are no stack traces, no check ids and no "assertion failed" here. Each
 * line says what happened and, when something is wrong, what to do about it.
 */

import {
  say,
  detail,
  warn,
  fail,
  ok,
  blank,
  heading,
  table,
  paint,
  mark,
  duration,
  shortPath,
  isVerbose,
} from '../core/log.js';
import { isExpected, messageOf } from '../core/errors.js';
import { wobbly } from '../core/history.js';

/** Names line up in a column so the eye can scan the outcomes. */
const NAME_WIDTH = 30;

/**
 * The symbol column is padded, not the name: without colour `mark.pass` is two
 * characters wide and everything after it would sit one space out of line.
 * @param {string} symbol
 * @returns {string}
 */
function sym(symbol) {
  return symbol.padEnd(2);
}

/** How many approve commands to spell out before summarising the rest. */
const MAX_COMMANDS = 10;

/** How many touched files a trace prints before summarising the rest. */
const MAX_TRACE_FILES = 12;

/**
 * Thousands separators, always. "1024 pixels" reads as noise; "1,024" reads as a number.
 * @param {number} n
 * @returns {string}
 */
export function countText(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return Math.round(v).toLocaleString('en-US');
}

/**
 * A total a person would actually say out loud. Never a clock range.
 * @param {number} ms
 * @returns {string}
 */
export function plainTime(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return 'no time at all';
  if (v < 1500) return 'under a second';
  if (v < 60_000) return `about ${Math.round(v / 1000)} seconds`;
  const minutes = Math.round(v / 60_000);
  if (minutes === 1) return 'about a minute';
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'about an hour' : `about ${hours} hours`;
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 * @returns {string}
 */
function plural(n, one, many) {
  return n === 1 ? one : many;
}

/**
 * @param {string} iso
 * @returns {string}
 */
function ago(iso) {
  const then = Date.parse(String(iso));
  if (Number.isNaN(then)) return 'at an unknown time';
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${countText(minutes)} ${plural(minutes, 'minute', 'minutes')} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${countText(hours)} ${plural(hours, 'hour', 'hours')} ago`;
  const days = Math.round(hours / 24);
  if (days <= 30) return `${countText(days)} ${plural(days, 'day', 'days')} ago`;
  return `on ${new Date(then).toISOString().slice(0, 10)}`;
}

/**
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function shorten(s, max) {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/**
 * The counts every verdict is built from. Taken from the results themselves
 * rather than `totals`, so the sentence can never disagree with the list above it.
 * @param {import('../types.js').RunSummary} run
 */
function tally(run) {
  const pictures = run.pictures ?? [];
  const guards = run.guards ?? [];
  return {
    pictures: pictures.length,
    guards: guards.length,
    changed: pictures.filter((p) => p.status === 'changed').length,
    fresh: pictures.filter((p) => p.status === 'new').length,
    missing: pictures.filter((p) => p.status === 'missing').length,
    broken: pictures.filter((p) => p.status === 'failed').length,
    wobbled: pictures.filter((p) => p.status === 'flaky').length,
    // Two different things wear the same status, and calling both of them "a bug is back"
    // sends somebody hunting a regression that never happened. A guard that asked no
    // question at all has not caught anything; it has admitted it cannot.
    guardsFailed: guards.filter((g) => g.status === 'failed' && !(/** @type {any} */ (g).assertedNothing)).length,
    guardsEmpty: guards.filter((g) => /** @type {any} */ (g).assertedNothing === true).length,
  };
}

/**
 * The one-line verdict, in the words a human would use.
 * @param {import('../types.js').RunSummary} run
 * @returns {string}
 */
export function verdictFor(run) {
  const t = tally(run);
  /** @type {{n: number, text: string}[]} */
  const parts = [];
  if (t.guardsFailed === 1) parts.push({ n: 1, text: '1 guard failed — a bug that was already fixed is back.' });
  else if (t.guardsFailed > 1) parts.push({ n: t.guardsFailed, text: `${countText(t.guardsFailed)} guards failed — bugs that were already fixed are back.` });
  // Said even on a green run, because that is the run it changes the meaning of.
  const left = /** @type {any} */ (run).leftOut;
  if (left && (left.screens > 0 || left.guards > 0)) {
    const bits = [];
    if (left.screens > 0) bits.push(`${left.screens} ${left.screens === 1 ? 'screen' : 'screens'}`);
    if (left.guards > 0) bits.push(`${left.guards} ${left.guards === 1 ? 'guard' : 'guards'}`);
    const how_many = (left.screens ?? 0) + (left.guards ?? 0);
    parts.push({
      n: 0,
      text: `${bits.join(' and ')} ${how_many === 1 ? 'was' : 'were'} left out by --only, so this covers a slice and not the whole.`,
    });
  }
  if (t.guardsEmpty === 1) parts.push({ n: 1, text: '1 guard checks nothing, so it is not protecting anything.' });
  else if (t.guardsEmpty > 1) parts.push({ n: t.guardsEmpty, text: `${countText(t.guardsEmpty)} guards check nothing, so they are not protecting anything.` });
  if (t.changed === 1) parts.push({ n: 1, text: '1 thing changed. Look at it before you ship.' });
  else if (t.changed > 1) parts.push({ n: t.changed, text: `${countText(t.changed)} things changed. Look at them before you ship.` });
  if (t.fresh === 1) parts.push({ n: 1, text: '1 new screen is waiting for a person to approve it.' });
  else if (t.fresh > 1) parts.push({ n: t.fresh, text: `${countText(t.fresh)} new screens are waiting for a person to approve them.` });
  if (t.missing === 1) parts.push({ n: 1, text: '1 approved picture has gone missing.' });
  else if (t.missing > 1) parts.push({ n: t.missing, text: `${countText(t.missing)} approved pictures have gone missing.` });
  if (t.broken === 1) parts.push({ n: 1, text: '1 screen could not be photographed at all.' });
  else if (t.broken > 1) parts.push({ n: t.broken, text: `${countText(t.broken)} screens could not be photographed at all.` });
  if (parts.length === 0 && t.wobbled > 0) {
    parts.push({ n: t.wobbled, text: `${countText(t.wobbled)} ${plural(t.wobbled, 'check', 'checks')} could not make up ${plural(t.wobbled, 'its', 'their')} mind.` });
  }
  if (parts.length === 0) return 'Everything that worked still works.';
  // Two sentences is as much as anyone reads standing up; the table underneath
  // still names every single one, so nothing is hidden by shortening this.
  if (parts.length <= 2) return parts.map((p) => p.text).join(' ');
  const rest = parts.slice(2).reduce((sum, p) => sum + p.n, 0);
  return `${parts[0].text} ${parts[1].text} And ${countText(rest)} other ${plural(rest, 'screen needs', 'screens need')} a look.`;
}

/**
 * @param {import('../types.js').RunSummary} run
 * @returns {boolean}
 */
export function allClear(run) {
  const t = tally(run);
  // `guardsEmpty` counts too. Splitting it out of `guardsFailed` was so the SENTENCE could
  // tell a returned bug from a guard that asks nothing — not so that one of them could
  // quietly become a pass.
  return t.changed + t.fresh + t.missing + t.broken + t.wobbled + t.guardsFailed + t.guardsEmpty === 0;
}

/**
 * @param {import('../types.js').PictureResult} p
 * @returns {string}
 */
function pictureOutcome(p) {
  switch (p.status) {
    case 'passed':
      return 'still the same';
    case 'changed':
      return `looks different — ${countText(p.diffPixels ?? 0)} ${plural(p.diffPixels ?? 0, 'pixel', 'pixels')} changed`;
    case 'new':
      return 'nobody has approved this picture yet';
    case 'missing':
      return 'the approved picture is gone';
    case 'failed':
      return p.message || 'could not be photographed';
    case 'flaky':
      return 'changed its mind between tries';
    case 'skipped':
      return 'left out on purpose';
    default:
      return String(p.status);
  }
}

/**
 * @param {import('../types.js').PictureResult} p
 * @returns {string}
 */
function whereToLook(p) {
  const file = p.diffPath || p.actualPath || p.approvedPath;
  return file ? shortPath(file) : '';
}

/**
 * One line as each screen finishes.
 * @param {import('../types.js').PictureResult} r
 * @returns {void}
 */
export function printPictureResult(r) {
  const time = paint.grey(duration(r.durationMs ?? 0));
  const line = `${r.name.padEnd(NAME_WIDTH)} ${pictureOutcome(r)}`;
  switch (r.status) {
    case 'passed': {
      // "Still the same" has to mean the same, or it is the most expensive sentence here.
      //
      // A picture that differs and is waved through by an allowance was reported as
      // identical, in the same words as one that matched byte for byte. That is how a
      // missing letter in a heading — 593 pixels, plainly visible — came back as "still the
      // same" while an allowance of 2,592 quietly absorbed it. Nothing is allowed through by
      // default any more, so this is rare; when a project sets `tolerance.pixels` because its
      // product genuinely wobbles, the line says what its setting just swallowed.
      const swallowed = r.diffPixels ?? 0;
      const note = swallowed > 0
        ? paint.grey(`the same, apart from ${swallowed} ${swallowed === 1 ? 'pixel your tolerance allowed' : 'pixels your tolerance allowed'}`)
        : paint.grey('still the same');
      say(`${paint.green(sym(mark.pass))} ${r.name.padEnd(NAME_WIDTH)} ${note} ${time}`);
      break;
    }
    case 'changed':
      say(`${paint.red(sym(mark.fail))} ${paint.red(line)} ${time}`);
      if (r.approvedSize && r.size && (r.approvedSize.width !== r.size.width || r.approvedSize.height !== r.size.height)) {
        say(paint.red(`    it is a different size now: ${r.approvedSize.width}×${r.approvedSize.height} ${mark.arrow} ${r.size.width}×${r.size.height}`));
      }
      break;
    case 'new':
      say(`${paint.yellow(sym(mark.warn))} ${paint.yellow(line)} ${time}`);
      say(paint.yellow(`    look at it, then run: staysfixed approve ${r.name}`));
      break;
    case 'missing':
      say(`${paint.red(sym(mark.fail))} ${paint.red(line)} ${time}`);
      say(paint.red(`    take a new one and approve it: staysfixed approve ${r.name}`));
      break;
    case 'failed':
      say(`${paint.red(sym(mark.fail))} ${paint.red(line)} ${time}`);
      break;
    case 'flaky':
      say(`${paint.yellow(sym(mark.warn))} ${paint.yellow(line)} ${time}`);
      break;
    case 'skipped':
      say(`${paint.grey(sym(mark.info))} ${paint.grey(line)}`);
      break;
    default:
      say(`${sym(mark.info)} ${line} ${time}`);
  }
  for (const message of r.consoleErrors ?? []) detail(`    the app logged: ${shorten(message, 160)}`);
}

/**
 * One line per guard; a failure also tells the story of the bug it watches.
 * @param {import('../types.js').GuardResult} r
 * @returns {void}
 */
export function printGuardResult(r) {
  const time = paint.grey(duration(r.durationMs ?? 0));
  const name = r.name.padEnd(NAME_WIDTH);
  if (r.status === 'passed') {
    say(`${paint.green(sym(mark.pass))} ${name} ${paint.grey('still holds')} ${time}`);
    return;
  }
  if (r.status === 'skipped') {
    say(`${paint.grey(sym(mark.info))} ${paint.grey(`${name} left out on purpose`)}`);
    return;
  }
  say(`${paint.red(sym(mark.fail))} ${paint.red(`${name} ${r.message || 'this one is broken again'}`)} ${time}`);
  if (r.failedAt) say(paint.red(`    expected: ${r.failedAt}`));
  if (r.because) say(paint.grey(`    why this guard exists: ${r.because}`));
  if (r.file) detail(`    ${shortPath(r.file)}`);
}

/**
 * The closing block of `staysfixed check`.
 * @param {import('../types.js').RunSummary} run
 * @param {import('../types.js').Project} [project]
 * @param {{profile?: boolean, timings?: import('../types.js').Timings|null}} [opts]
 *        Ask for the timing block with --profile; pass `timings` when the caller
 *        kept its own record rather than reading it back off the summary.
 * @returns {void}
 */
export function printRunSummary(run, project, opts = {}) {
  const pictures = run.pictures ?? [];
  const guards = run.guards ?? [];
  const verdict = verdictFor(run);

  blank();
  if (allClear(run)) ok(verdict);
  else fail(verdict);

  const counted = [];
  if (pictures.length) counted.push(`${countText(pictures.length)} ${plural(pictures.length, 'screen', 'screens')}`);
  if (guards.length) counted.push(`${countText(guards.length)} ${plural(guards.length, 'guard', 'guards')}`);
  if (counted.length) say(paint.grey(`  ${counted.join(', ')}, ${plainTime(run.durationMs ?? 0)}.`));

  // Nobody asked for numbers unless they asked for numbers. The run reads the
  // same with or without this block.
  if (opts.profile) {
    const measured = opts.timings ?? /** @type {{timings?: import('../types.js').Timings}} */ (run).timings;
    printTimings(measured, pictures.length);
  }

  /** @type {string[][]} */
  const rows = [];
  for (const p of pictures) {
    if (p.status === 'passed' || p.status === 'skipped') continue;
    rows.push([p.name, pictureOutcome(p), paint.grey(whereToLook(p))]);
  }
  for (const g of guards) {
    if (g.status === 'passed' || g.status === 'skipped') continue;
    const what = g.failedAt ? `expected: ${g.failedAt}` : g.message || 'this one is broken again';
    rows.push([g.name, what, paint.grey(g.file ? shortPath(g.file) : '')]);
  }
  if (rows.length) {
    heading('What is not right');
    table([[paint.grey('name'), paint.grey('what happened'), paint.grey('where to look')], ...rows], { indent: 2 });
  }

  const stubborn = run.condemned ?? [];
  if (stubborn.length) {
    heading(paint.red('These checks keep changing their mind'));
    for (const name of stubborn) say(paint.red(`  ${mark.warn} ${name}`));
    say(paint.grey('  Fix them or delete them. A check that cannot make up its mind is never worth tolerating.'));
  }

  const needApproval = pictures.filter((p) => p.status === 'changed' || p.status === 'new' || p.status === 'missing');
  if (needApproval.length || project) heading('What to do next');
  if (needApproval.length) {
    say('  Look at each picture in the report. If the new one is what you meant, approve it:');
    for (const p of needApproval.slice(0, MAX_COMMANDS)) {
      say(`    ${paint.cyan(`staysfixed approve ${p.name}`)}`);
    }
    const rest = needApproval.length - MAX_COMMANDS;
    if (rest > 0) say(paint.grey(`    ...and ${countText(rest)} more`));
    if (needApproval.length > 1) say(`  Or accept every one of them: ${paint.cyan('staysfixed approve --all')}`);
  }
  if (project) {
    say(`  The pictures, side by side: ${paint.cyan(shortPath(project.paths.reportFile))}`);
  }
  blank();
}

/**
 * Where the seconds went, in the order of biggest first, because the only reason
 * anyone reads this is to find the one part worth speeding up.
 *
 * The names are what each phase actually does, not what the code calls it: nobody
 * outside this repository knows what "settle" or "prepare" mean.
 */
const TIMING_LABELS = /** @type {[string, string][]} */ ([
  ['launch', 'opening the app'],
  ['steps', 'running the steps'],
  ['prepare', 'waiting for fonts and images'],
  ['settle', 'taking the pictures until two agree'],
  ['compare', 'comparing against the approved pictures'],
  ['guards', 'running the guards'],
  ['other', 'everything else'],
]);

/**
 * The `--profile` block. Rounded to something a person would say out loud: this
 * is here to point at the slow part, not to be a benchmark.
 *
 * @param {import('../types.js').Timings|null|undefined} timings
 * @param {number} [screenCount]   Screens photographed, for the per-screen average.
 * @returns {void}
 */
export function printTimings(timings, screenCount = 0) {
  if (!timings) {
    heading('Where the time went');
    say(paint.grey('  This run did not record its timings.'));
    return;
  }

  // Timings is a fixed shape, but reading it by name keeps the table and the
  // type from drifting apart.
  const t = /** @type {Record<string, number>} */ (/** @type {unknown} */ (timings));
  const total = Number(t.total) || 0;

  /** @type {string[][]} */
  const rows = [];
  const parts = TIMING_LABELS.map(([key, label]) => ({ label, ms: Number(t[key]) || 0 }))
    .filter((part) => part.ms > 0)
    .sort((a, b) => b.ms - a.ms);

  for (const part of parts) {
    const share = total > 0 ? `${Math.round((part.ms / total) * 100)}%` : '';
    rows.push([part.label, duration(part.ms), paint.grey(share)]);
  }

  heading('Where the time went');
  if (rows.length === 0) {
    say(paint.grey('  Nothing took long enough to measure.'));
    return;
  }
  table(rows, { indent: 2 });

  // The two closing lines are written by hand rather than added as rows, so the
  // totals sit under the parts instead of being sorted in among them.
  const labelWidth = Math.max(...rows.map((row) => row[0].length));
  say(paint.grey(`  ${'in total'.padEnd(labelWidth)}  ${duration(total)}`));
  if (screenCount > 0) {
    const each = duration(total / screenCount);
    say(
      paint.grey(
        `  ${'each screen'.padEnd(labelWidth)}  ${each} on average, across ${countText(screenCount)} ${plural(screenCount, 'screen', 'screens')}`,
      ),
    );
  }
}

/**
 * The closing block of `staysfixed walk`.
 * @param {import('../types.js').WalkReport} report
 * @returns {void}
 */
export function printWalkReport(report) {
  const steps = report.steps ?? [];
  const broken = steps.filter((s) => Boolean(s.error));
  blank();
  if (report.ok && broken.length === 0) {
    ok(`Walked ${countText(steps.length)} ${plural(steps.length, 'screen', 'screens')} and every one of them opened.`);
  } else {
    fail(`${countText(broken.length)} of ${countText(steps.length)} ${plural(steps.length, 'screen', 'screens')} did not open properly.`);
  }

  if (broken.length) {
    heading('Where it went wrong');
    table(
      broken.map((s) => [s.name, shorten(s.error ?? 'did not open', 70), paint.grey(s.file ? shortPath(s.file) : '')]),
      { indent: 2 },
    );
  }

  const noisy = steps.filter((s) => (s.consoleErrors?.length ?? 0) > 0);
  if (noisy.length) {
    warn(`${countText(noisy.length)} ${plural(noisy.length, 'screen', 'screens')} printed errors of ${plural(noisy.length, 'its', 'their')} own while open.`);
    for (const s of noisy) detail(`  ${s.name}: ${shorten((s.consoleErrors ?? [])[0] ?? '', 160)}`);
  }

  const sheet = report.reportFile || report.dir;
  if (sheet) say(`  Every screen it photographed: ${paint.cyan(shortPath(sheet))}`);
  blank();
}

/**
 * @param {import('../types.js').TraceFinding} f
 * @returns {string}
 */
function traceSentence(f) {
  if (f.message) return f.message;
  const good = f.lastGood ? `"${f.lastGood.label}"` : null;
  const bad = f.firstBad ? `"${f.firstBad.label}"` : null;
  if (f.verdict === 'unchanged') {
    return good
      ? `This looks exactly as it did at ${good}, so nothing here has drifted.`
      : 'This looks the same everywhere I have a record of it.';
  }
  if (f.verdict === 'changed') {
    if (good && bad) return `It was still right at ${good} and already different by ${bad}. The change is in between.`;
    if (good) return `It was still right at ${good} and is different now.`;
    return 'It is different from every record I have.';
  }
  return 'There is no marker recording this one, so there is nothing to compare it against.';
}

/**
 * The output of `staysfixed trace`.
 * @param {import('../types.js').TraceReport} report
 * @returns {void}
 */
export function printTrace(report) {
  const findings = report.findings ?? [];
  blank();
  if (report.message) say(report.message);
  if (findings.length === 0) {
    say('There is nothing to trace yet. Pin a good version first with `staysfixed mark`.');
    blank();
    return;
  }

  for (const f of findings) {
    heading(f.name);
    say(`  ${traceSentence(f)}`);
    const commits = f.commits ?? [];
    if (commits.length) {
      say(paint.grey(`  ${countText(commits.length)} ${plural(commits.length, 'commit', 'commits')} landed in between:`));
      table(
        commits.map((c) => [paint.grey(c.shortSha), paint.grey(c.date), shorten(c.subject, 62), paint.grey(c.author)]),
        { indent: 4 },
      );
    }
    const files = f.files ?? [];
    if (files.length) {
      say(paint.grey('  files those commits touched:'));
      for (const file of files.slice(0, MAX_TRACE_FILES)) say(`    ${file}`);
      const rest = files.length - MAX_TRACE_FILES;
      if (rest > 0) say(paint.grey(`    ...and ${countText(rest)} more`));
    }
  }

  blank();
  say(paint.grey(`Looked through ${countText(report.markersSearched ?? 0)} ${plural(report.markersSearched ?? 0, 'marker', 'markers')}.`));
  blank();
}

/**
 * The flake register, for `staysfixed flake`.
 * @param {import('../types.js').History} history
 * @param {number} [flakeLimit]
 * @returns {void}
 */
export function printFlakes(history, flakeLimit = 2) {
  const entries = wobbly(history ?? {});
  blank();
  if (entries.length === 0) {
    ok('No check here has ever changed its mind. That is exactly how it should be.');
    blank();
    return;
  }

  heading('Checks that have changed their mind');
  /** @type {string[][]} */
  const rows = [[paint.grey('check'), paint.grey('wobbled'), paint.grey('last time'), paint.grey('verdict')]];
  for (const e of entries) {
    const left = Math.max(1, flakeLimit - e.flakes);
    rows.push([
      e.name,
      `${countText(e.flakes)} ${plural(e.flakes, 'time', 'times')}`,
      e.lastFlakeAt ? ago(e.lastFlakeAt) : 'unknown',
      e.condemned
        ? paint.red('fix it or delete it')
        : paint.yellow(`${countText(left)} more and it gets condemned`),
    ]);
  }
  table(rows, { indent: 2 });

  if (entries.some((e) => e.condemned)) {
    blank();
    say(paint.red('A condemned check is not a warning to live with. Fix it, or delete it.'));
    say(paint.grey('Once it is genuinely fixed, forgive it with: ') + paint.cyan('staysfixed flake --clear <name>'));
  }
  blank();
}

/**
 * What `staysfixed status` prints. The CLI gathers this; the shape is deliberately
 * forgiving so it can report on a half-set-up project without special cases.
 *
 * @typedef {object} StatusInfo
 * @property {number} [approved]      Approved pictures on disk.
 * @property {number} [screens]       Screens named in the config.
 * @property {number} [guards]        Guards loaded from the guards folder.
 * @property {number} [markers]       Known-good markers saved.
 * @property {{label: string, at?: string}|null} [lastMarker]
 * @property {import('../types.js').RunSummary|null} [lastRun]
 * @property {{at: string, verdict: string, reference: string|null, findings: number}|null} [v2]
 *   What version 2 has recorded here. Version 1's counts say nothing about it.
 * @property {string[]} [condemned]   Names from the flake register, if the CLI already has them.
 * @property {string} [configFile]
 * @property {string} [root]
 */

/**
 * @param {StatusInfo} status
 * @returns {void}
 */
export function printStatus(status) {
  const s = /** @type {StatusInfo} */ (status || {});
  heading('Stays Fixed');
  if (s.root) say(paint.grey(`  watching ${shortPath(s.root)}`));
  if (s.configFile) say(paint.grey(`  settings in ${shortPath(s.configFile)}`));

  /** @type {string[][]} */
  const rows = [];
  rows.push([`${countText(s.approved ?? 0)}`, plural(s.approved ?? 0, 'approved picture', 'approved pictures')]);
  if (s.screens !== undefined) rows.push([`${countText(s.screens)}`, `${plural(s.screens, 'screen', 'screens')} in the settings`]);
  rows.push([`${countText(s.guards ?? 0)}`, plural(s.guards ?? 0, 'guard', 'guards')]);
  rows.push([`${countText(s.markers ?? 0)}`, plural(s.markers ?? 0, 'known-good marker', 'known-good markers')]);
  blank();
  table(rows, { indent: 2 });

  if (s.lastMarker) {
    say(paint.grey(`  newest marker: ${s.lastMarker.label}${s.lastMarker.at ? ` — pinned ${ago(s.lastMarker.at)}` : ''}`));
  }

  blank();
  const run = s.lastRun ?? null;
  if (!run && s.v2) {
    // Version 2 has run here even though version 1's picture record has not. Saying
    // "nothing has been checked here yet" one command after a real run is the sort of
    // wrongness that costs a person their trust in everything else the tool says.
    say(paint.grey(`  last checked ${ago(s.v2.at)} — ${s.v2.verdict}`));
    if (s.v2.findings > 0) say(paint.grey(`  ${s.v2.findings} ${plural(s.v2.findings, 'thing', 'things')} nobody had accounted for`));
    if (s.v2.reference) say(paint.grey(`  compared against ${s.v2.reference}`));
    else say(`  Nothing is on record as working yet — run ${paint.cyan('staysfixed check')}, then ${paint.cyan('staysfixed ship')}.`);
  } else if (!run) {
    say('  Nothing has been checked here yet.');
    say(`  Start with: ${paint.cyan('staysfixed check')}`);
  } else {
    const where = run.git?.shortSha ? ` at ${run.git.shortSha}${run.git.branch ? ` on ${run.git.branch}` : ''}` : '';
    say(paint.grey(`  last checked ${ago(run.startedAt)}${where}, took ${plainTime(run.durationMs ?? 0)}`));
    if (allClear(run)) ok(verdictFor(run));
    else fail(verdictFor(run));
  }

  const stubborn = s.condemned ?? run?.condemned ?? [];
  if (stubborn.length) {
    heading(paint.red('These checks keep changing their mind'));
    for (const name of stubborn) say(paint.red(`  ${mark.warn} ${name}`));
    say(paint.grey('  Fix them or delete them. Never tolerate them.'));
  }
  blank();
}

/**
 * Turn any thrown thing into something worth reading.
 * @param {unknown} err
 * @returns {void}
 */
export function errorReport(err) {
  if (isExpected(err)) {
    fail(err.message);
    if (err.hint) warn(err.hint);
    if (isVerbose() && err.cause instanceof Error) detail(err.cause.stack ?? err.cause.message);
    return;
  }
  fail(messageOf(err));
  warn('This is a bug in Stays Fixed, not something you did wrong.');
  if (isVerbose() && err instanceof Error && err.stack) {
    detail(err.stack);
  } else {
    warn('Run the same command again with --verbose for the technical details, then report it at https://github.com/asadev/staysfixed/issues');
  }
}
