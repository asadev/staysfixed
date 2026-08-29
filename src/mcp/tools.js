/**
 * The Stays Fixed tool set, as an agent sees it.
 *
 * Everything here is written for a reader who is not human: a coding agent that
 * has just edited some files and needs to know, in as few tokens as possible,
 * whether it broke something that used to work. So the text output leads with the
 * verdict and then says only what is NOT passing. A wall of green lines costs the
 * agent money and tells it nothing.
 *
 * The one rule that shapes this whole file: an agent must not approve its own
 * pictures. `staysfixed_approve` is not merely refused when the project has not
 * opted in — it is not offered at all, so the agent never sees a door to push on.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { runCheck, captureOne } from '../run.js';
import { listApproved, approveFromResult, approvedHashes } from '../picture/store.js';
import { loadGuards } from '../guard/load.js';
import { loadHistory, condemned } from '../core/history.js';
import { safeName, approvedPicture, resultPicture } from '../core/paths.js';
import { sha256File } from '../core/hash.js';
import { gitInfo, commitsBetween, filesBetween, commitExists } from '../core/git.js';
import { platformTag } from '../drive/find.js';
import { isExpected, messageOf } from '../core/errors.js';

/**
 * What every tool call is handed. `reload` re-reads the config from disk, so an
 * agent that just edited staysfixed.config.js sees its own edit on the next call
 * instead of being told a stale story by a server that started an hour ago.
 * @typedef {object} ToolContext
 * @property {import('../types.js').Project} project
 * @property {() => Promise<import('../types.js').Project>} reload
 * @property {string} version
 */

/** @typedef {{type: 'text', text: string}|{type: 'image', data: string, mimeType: string}} ContentItem */
/** @typedef {{content: ContentItem[], isError?: boolean}} ToolResult */

/** How many diff pictures we are willing to push into an agent's context at once. */
const MAX_IMAGES = 4;

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * The `tools/list` payload, shaped by what this project has opted into.
 *
 * @param {import('../types.js').ResolvedConfig} config
 * @returns {{name: string, description: string, inputSchema: Record<string, any>}[]}
 */
export function toolDefinitions(config) {
  const allowApprove = config.mcp?.allowApprove === true;
  const allowMark = config.mcp?.allowMark === true;

  const approvalNote = allowApprove
    ? ' This project has opted in to letting you approve a new picture yourself. Do it only when you are certain the new look is what the person asked for, and say why.'
    : ' You cannot approve a new picture — only a person can, by running `staysfixed approve <screen>` in their terminal. That is deliberate. If a picture changed on purpose, say so and let them approve it; if it changed by accident, fix your code and check again.';

  /** @type {{name: string, description: string, inputSchema: Record<string, any>}[]} */
  const tools = [
    {
      name: 'staysfixed_check',
      description:
        'Prove that what already worked still works. Call this after you finish editing and BEFORE you tell anyone you are done. It opens the real app, photographs every screen this project watches, compares each against the approved picture, and runs every guard (one check per bug that was already fixed once). You get a short verdict, a line for anything that is not passing, and the diff image of each changed screen so you can see what moved.' +
        approvalNote,
      inputSchema: {
        type: 'object',
        properties: {
          only: {
            type: 'array',
            items: { type: 'string' },
            description: 'Check only these screens and guards, by name. Leave it out to check everything.',
          },
          guardsOnly: {
            type: 'boolean',
            description: 'Skip the pictures and run only the guards. Much faster; use it when your edit could not change how anything looks.',
          },
          picturesOnly: {
            type: 'boolean',
            description: 'Skip the guards and only compare pictures.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'staysfixed_capture',
      description:
        'Photograph one screen of the real app right now and hand you the picture, without comparing it to anything. Use it to see what your change actually looks like, or to look at a screen before you touch it. It approves nothing and changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          screen: { type: 'string', description: 'The screen name. Call staysfixed_screens if you do not know it.' },
        },
        required: ['screen'],
        additionalProperties: false,
      },
    },
    {
      name: 'staysfixed_screens',
      description:
        'List the screens and the guards this project watches, each with its plain-language description. Cheap — it does not open the app. Call this first, so you know what is protected before you change anything.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'staysfixed_status',
      description:
        'A quick read on the project: how many approved pictures and guards exist, the known-good markers, how the last check went, and any check that has been condemned for flaking. Does not open the app.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'staysfixed_trace',
      description:
        'Find out which change broke a screen. Compares how the screen looks now against the known-good markers and reports the last marker where it still looked right, the first one where it did not, and the commits in between. Use it when staysfixed_check says something changed and you did not expect it to.',
      inputSchema: {
        type: 'object',
        properties: {
          screen: { type: 'string', description: 'One screen name. Leave it out to trace every screen that has moved.' },
        },
        additionalProperties: false,
      },
    },
  ];

  // Deliberately absent unless the project opted in. An agent that can approve its
  // own screenshots has no safety net at all: it would edit the code, notice the
  // picture moved, bless the new picture, and report success. The whole tool is
  // built around a human standing at this one door.
  if (allowApprove) {
    tools.push({
      name: 'staysfixed_approve',
      description:
        'Accept the new picture of a screen as the correct one from now on. This project has turned this on for agents; it is off by default, because approving is normally a human decision. Only use it when the change was asked for and you can say plainly why the new look is right.',
      inputSchema: {
        type: 'object',
        properties: {
          screen: { type: 'string', description: 'The screen whose new picture becomes the approved one.' },
          reason: { type: 'string', description: 'Why the new look is correct, in one plain sentence. It is written to the approval log.' },
        },
        required: ['screen', 'reason'],
        additionalProperties: false,
      },
    });
  }

  if (allowMark) {
    tools.push({
      name: 'staysfixed_mark',
      description:
        'Pin this moment as known-good, so a future regression can be traced back to it. Everything is checked first and the marker is refused if anything is not passing. Use it at a release, or just before you start something risky.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: "A name for this point, e.g. 'v0.15.0' or 'before-the-store-work'." },
          note: { type: 'string', description: 'Optional one-line note about what this point is.' },
        },
        required: ['label'],
        additionalProperties: false,
      },
    });
  }

  return tools;
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/**
 * Run one tool.
 *
 * A tool that fails is a RESULT with `isError: true`, never a JSON-RPC error —
 * the agent is supposed to read the failure and act on it, and a protocol-level
 * error would be swallowed by its client before it ever saw the words.
 *
 * @param {string} name
 * @param {any} args
 * @param {ToolContext} ctx
 * @returns {Promise<ToolResult>}
 */
export async function callTool(name, args, ctx) {
  /** @type {Record<string, any>} */
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};

  try {
    // Re-read the config every call. An agent editing staysfixed.config.js and then
    // calling a tool should see its own edit, not a snapshot from server start.
    const project = await ctx.reload();

    switch (name) {
      case 'staysfixed_check':
        return await toolCheck(project, input);
      case 'staysfixed_capture':
        return await toolCapture(project, input);
      case 'staysfixed_screens':
        return await toolScreens(project);
      case 'staysfixed_status':
        return await toolStatus(project);
      case 'staysfixed_trace':
        return await toolTrace(project, input);
      case 'staysfixed_approve':
        return await toolApprove(project, input, ctx);
      case 'staysfixed_mark':
        return await toolMark(project, input, ctx);
      default:
        return problem(`There is no Stays Fixed tool called "${name}".`);
    }
  } catch (e) {
    return problem(explain(e));
  }
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

/**
 * @param {import('../types.js').Project} project
 * @param {Record<string, any>} input
 * @returns {Promise<ToolResult>}
 */
async function toolCheck(project, input) {
  const only = stringList(input.only);
  const guardsOnly = input.guardsOnly === true;
  const picturesOnly = input.picturesOnly === true;

  if (guardsOnly && picturesOnly) {
    return problem('You asked for guards only and pictures only at the same time. Pick one, or neither to check everything.');
  }

  /** @type {any} */
  const runOpts = {};
  if (only) runOpts.only = only;
  if (guardsOnly) runOpts.guardsOnly = true;
  if (picturesOnly) runOpts.picturesOnly = true;

  // `runCheck` opens the real app and closes it again on its own way out, success
  // or failure. That matters more here than in the CLI: the CLI process dies after
  // one run, while this server lives for the whole coding session, so a single
  // leaked Electron process would sit there for hours and a leak per call would
  // fill the machine.
  /** @type {import('../types.js').RunSummary} */
  const summary = await runCheck(project, runOpts);

  if (summary.pictures.length === 0 && summary.guards.length === 0) {
    const known = project.config.screens.map((s) => s.name);
    return problem(
      only
        ? `Nothing matched ${only.map(quote).join(', ')}.` +
            (known.length ? ` This project watches: ${known.join(', ')}.` : '') +
            ' Call staysfixed_screens to see the screens and guards with descriptions.'
        : 'This project has no screens and no guards yet, so there is nothing to check. Someone needs to add a screen to the config first.'
    );
  }

  /** @type {ContentItem[]} */
  const content = [{ type: 'text', text: renderCheck(summary, project) }];

  for (const item of await diffImages(summary)) content.push(item);

  // A regression is reported as an error result on purpose. Protocol-wise the call
  // succeeded, but `isError` is the flag every client puts in front of the agent,
  // and an agent that skims past "SOMETHING MOVED" is exactly the failure this
  // whole tool exists to prevent.
  return { content, isError: !summary.ok };
}

/**
 * @param {import('../types.js').RunSummary} summary
 * @param {import('../types.js').Project} project
 * @returns {string}
 */
function renderCheck(summary, project) {
  const t = summary.totals;
  /** @type {string[]} */
  const out = [];

  if (summary.ok) {
    out.push(`ALL GOOD — nothing that worked before has moved. ${count(t.passed, 'check')} passed.`);
  } else {
    /** @type {string[]} */
    const bad = [];
    if (t.changed) bad.push(`${count(t.changed, 'screen')} changed`);
    if (t.failed) bad.push(`${count(t.failed, 'check')} failed`);
    if (t.new) bad.push(`${count(t.new, 'screen')} never approved`);
    if (t.missing) bad.push(`${count(t.missing, 'picture')} missing`);
    out.push(`SOMETHING MOVED — ${bad.join(', ')}. ${t.passed} passed.`);
  }

  const changed = summary.pictures.filter((p) => p.status === 'changed');
  if (changed.length) {
    out.push('');
    out.push('Screens that look different now:');
    for (const p of changed) out.push(`- ${p.name}${describeOf(p)} — ${changeLine(p)}`);
  }

  const brokePictures = summary.pictures.filter((p) => p.status === 'failed');
  if (brokePictures.length) {
    out.push('');
    out.push('Screens that could not be photographed at all:');
    for (const p of brokePictures) {
      out.push(`- ${p.name} — ${p.message ?? 'it failed and said nothing useful.'}`);
      for (const e of (p.consoleErrors ?? []).slice(0, 2)) out.push(`    the app logged: ${trim(e, 160)}`);
    }
  }

  const fresh = summary.pictures.filter((p) => p.status === 'new' || p.status === 'missing');
  if (fresh.length) {
    out.push('');
    out.push('Screens with no approved picture yet (nobody has said what they should look like):');
    for (const p of fresh) out.push(`- ${p.name}${describeOf(p)}`);
  }

  const brokeGuards = summary.guards.filter((g) => g.status !== 'passed' && g.status !== 'skipped');
  if (brokeGuards.length) {
    out.push('');
    out.push('Guards that broke (each one is a bug that was already fixed once — it is back):');
    for (const g of brokeGuards) {
      out.push(`- ${g.name} — ${g.failedAt ? `expected ${quote(g.failedAt)}, and it was not true` : g.message ?? 'it failed.'}`);
      if (g.failedAt && g.message) out.push(`    ${trim(g.message, 200)}`);
      if (g.because) out.push(`    why this guard exists: ${trim(g.because, 200)}`);
    }
  }

  if (summary.condemned && summary.condemned.length) {
    out.push('');
    out.push(
      `These checks change their mind without the code changing, so their verdict cannot be trusted: ${summary.condemned.join(', ')}. Tell the person; they need fixing or deleting.`
    );
  }

  if (changed.length && project.config.mcp?.allowApprove !== true) {
    out.push('');
    out.push(
      'A changed picture is not automatically a bug. If the new look is what was asked for, say so and ask the person to run `staysfixed approve <screen>` — approving is theirs to do, not yours. If it was not asked for, fix it and check again.'
    );
  }

  return out.join('\n');
}

/**
 * Diff pictures for the screens that moved, biggest change first, capped so a
 * broken stylesheet cannot blow an agent's whole context on twenty screenshots.
 * @param {import('../types.js').RunSummary} summary
 * @returns {Promise<ContentItem[]>}
 */
async function diffImages(summary) {
  const changed = summary.pictures
    .filter((p) => p.status === 'changed' && p.diffPath)
    .sort((a, b) => (b.diffRatio ?? 0) - (a.diffRatio ?? 0));

  /** @type {ContentItem[]} */
  const out = [];
  for (const p of changed.slice(0, MAX_IMAGES)) {
    const png = await readMaybe(/** @type {string} */ (p.diffPath));
    if (!png) continue;
    out.push({ type: 'text', text: `Difference in "${p.name}" — pink is what moved:` });
    out.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
  }

  const left = changed.length - Math.min(changed.length, MAX_IMAGES);
  if (left > 0) {
    out.push({
      type: 'text',
      text: `${count(left, 'more changed screen')} not pictured here. Call staysfixed_check again with only: [${changed
        .slice(MAX_IMAGES)
        .map((p) => `"${p.name}"`)
        .join(', ')}] to see them.`,
    });
  }
  return out;
}

/**
 * @param {import('../types.js').PictureResult} p
 * @returns {string}
 */
function changeLine(p) {
  if (p.size && p.approvedSize && (p.size.width !== p.approvedSize.width || p.size.height !== p.approvedSize.height)) {
    return `it is a different size now: ${p.approvedSize.width}x${p.approvedSize.height} before, ${p.size.width}x${p.size.height} now.`;
  }
  const share = p.diffRatio !== undefined ? formatShare(p.diffRatio) : null;
  const pixels = p.diffPixels !== undefined ? `${p.diffPixels.toLocaleString('en-US')} pixels` : null;
  if (share && pixels) return `${share} of the picture differs (${pixels}).`;
  return p.message ?? 'it does not match the approved picture.';
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

/**
 * @param {import('../types.js').Project} project
 * @param {Record<string, any>} input
 * @returns {Promise<ToolResult>}
 */
async function toolCapture(project, input) {
  const screen = text(input.screen);
  if (!screen) return problem('Tell me which screen to photograph, e.g. { "screen": "sessions-empty" }.');

  const known = project.config.screens.map((s) => s.name);
  if (!known.includes(screen)) {
    return problem(
      `This project has no screen called ${quote(screen)}.` +
        (known.length ? ` It watches: ${known.join(', ')}.` : ' It has no screens at all yet.') +
        ' Call staysfixed_screens for the descriptions.'
    );
  }

  // Same contract as toolCheck: captureOne closes the app it opened, whatever happens.
  /** @type {{png: Buffer, result: import('../types.js').PictureResult}} */
  const shot = await captureOne(project, screen, /** @type {any} */ ({}));

  const size = shot.result.size;
  const where = size ? ` (${size.width}x${size.height} pixels)` : '';
  /** @type {ContentItem[]} */
  const content = [
    {
      type: 'text',
      text: `Here is ${quote(screen)} as it looks right now${where}. Nothing was compared and nothing was approved.`,
    },
    { type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png' },
  ];
  return { content };
}

// ---------------------------------------------------------------------------
// screens
// ---------------------------------------------------------------------------

/**
 * @param {import('../types.js').Project} project
 * @returns {Promise<ToolResult>}
 */
async function toolScreens(project) {
  const approved = new Set(await listApproved(project.paths));
  const guards = await loadGuards(project);
  const screens = project.config.screens;

  /** @type {string[]} */
  const out = [];
  out.push(`This project watches ${count(screens.length, 'screen')} and ${count(guards.length, 'guard')}.`);

  if (screens.length) {
    out.push('');
    out.push('Screens (photographed and compared against an approved picture):');
    for (const s of screens) {
      const flags = [];
      if (s.skip) flags.push('turned off for now');
      else if (!approved.has(s.name)) flags.push('no approved picture yet');
      out.push(`- ${s.name}${s.describe ? ` — ${s.describe}` : ''}${flags.length ? ` [${flags.join('; ')}]` : ''}`);
    }
  }

  if (guards.length) {
    out.push('');
    out.push('Guards (each is a bug that was already fixed; it fails the day the bug comes back):');
    for (const g of guards) {
      out.push(`- ${g.name}${g.skip ? ' [turned off for now]' : ''}`);
      if (g.because) out.push(`    ${trim(g.because, 220)}`);
    }
  }

  if (!screens.length && !guards.length) {
    out.push('');
    out.push('Nothing is protected yet. Adding a screen to the config is the first step.');
  }

  return { content: [{ type: 'text', text: out.join('\n') }] };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * @param {import('../types.js').Project} project
 * @returns {Promise<ToolResult>}
 */
async function toolStatus(project) {
  const approved = await listApproved(project.paths);
  const guards = await loadGuards(project).catch(() => []);
  const markers = await readMarkers(project.paths);
  const history = await loadHistory(project.paths.historyFile);
  const stuck = condemned(history);
  const last = await readLastRun(project.paths);

  /** @type {string[]} */
  const out = [];
  out.push(`${count(approved.length, 'approved picture')}, ${count(guards.length, 'guard')}, ${count(markers.length, 'known-good marker')}.`);

  if (last) {
    const when = last.startedAt ? ` on ${day(last.startedAt)}` : '';
    const at = last.git?.shortSha ? `, at commit ${last.git.shortSha}` : '';
    const t = last.totals;
    const detail = t ? ` (${t.passed} passed, ${t.changed} changed, ${t.failed} failed)` : '';
    out.push(`Last check${when}${at}: ${last.ok ? 'everything passed' : 'something moved'}${detail}.`);
  } else {
    out.push('Nothing has been checked yet in this copy of the project.');
  }

  if (markers.length) {
    const newest = markers.slice(-3).reverse();
    out.push('Newest markers: ' + newest.map((m) => `${m.label}${m.at ? ` (${day(m.at)})` : ''}`).join(', ') + '.');
  }

  if (stuck.length) {
    out.push(
      `Condemned — these change their mind without the code changing, so ignore their verdict until a person fixes or deletes them: ${stuck
        .map((e) => e.name)
        .join(', ')}.`
    );
  }

  const missing = project.config.screens.filter((s) => !s.skip && !approved.includes(s.name)).map((s) => s.name);
  if (missing.length) out.push(`Screens still waiting for a first approved picture: ${missing.join(', ')}.`);

  return { content: [{ type: 'text', text: out.join('\n') }] };
}

// ---------------------------------------------------------------------------
// trace
// ---------------------------------------------------------------------------

/**
 * @param {import('../types.js').Project} project
 * @param {Record<string, any>} input
 * @returns {Promise<ToolResult>}
 */
async function toolTrace(project, input) {
  const wanted = text(input.screen);
  const markers = await readMarkers(project.paths);

  if (markers.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'There are no known-good markers yet, so there is no history to trace against. Someone needs to run `staysfixed mark <label>` at a moment when everything passes; after that, a regression can be pinned to the commits between two markers.',
        },
      ],
    };
  }

  const names = wanted ? [wanted] : Array.from(new Set(markers.flatMap((m) => Object.keys(m.pictures ?? {}))));
  if (names.length === 0) return problem('The markers do not record any screens, so there is nothing to trace.');

  /** @type {import('../types.js').TraceFinding[]} */
  const findings = [];
  for (const name of names) findings.push(await traceOne(project, name, markers));

  const moved = findings.filter((f) => f.verdict === 'changed');
  const report = wanted ? findings : moved;

  /** @type {string[]} */
  const out = [];
  if (report.length === 0) {
    out.push(`Every screen still looks the way it did at the newest marker. Nothing to trace across ${count(markers.length, 'marker')}.`);
  } else {
    out.push(
      wanted
        ? `Traced ${quote(wanted)} across ${count(markers.length, 'marker')}.`
        : `${count(moved.length, 'screen')} no longer look${moved.length === 1 ? 's' : ''} the way it did at the newest marker.`
    );
    for (const f of report) {
      out.push('');
      out.push(...renderFinding(f));
    }
  }

  return { content: [{ type: 'text', text: out.join('\n') }] };
}

/**
 * @param {import('../types.js').TraceFinding} f
 * @returns {string[]}
 */
function renderFinding(f) {
  /** @type {string[]} */
  const out = [];
  if (f.verdict === 'unchanged') {
    out.push(`${quote(f.name)} is unchanged${f.lastGood ? ` — it still matches marker "${f.lastGood.label}"` : ''}.`);
    return out;
  }
  if (f.verdict === 'unknown') {
    out.push(`${quote(f.name)}: ${f.message ?? 'no history for this screen.'}`);
    return out;
  }

  out.push(`${quote(f.name)} changed.`);
  if (f.lastGood && f.firstBad) {
    out.push(
      `  It last looked right at marker "${f.lastGood.label}" (${day(f.lastGood.at)}${markerSha(f.lastGood)}) and was already different at "${f.firstBad.label}" (${day(
        f.firstBad.at
      )}${markerSha(f.firstBad)}).`
    );
  } else if (f.message) {
    out.push(`  ${f.message}`);
  }

  const commits = f.commits ?? [];
  if (commits.length) {
    out.push(`  ${count(commits.length, 'commit')} sit between those two markers — the break is in one of them:`);
    for (const c of commits.slice(0, 12)) out.push(`    ${c.shortSha}  ${trim(c.subject, 80)}  (${c.author}, ${c.date})`);
    if (commits.length > 12) out.push(`    ...and ${commits.length - 12} more.`);
  }

  const files = f.files ?? [];
  if (files.length) {
    out.push(`  Files touched in that window: ${files.slice(0, 10).join(', ')}${files.length > 10 ? `, and ${files.length - 10} more` : ''}.`);
  }
  return out;
}

/**
 * Work out where a screen stopped looking the way it used to.
 *
 * "How it looks now" is the picture from the last run when there is one, and the
 * approved picture otherwise — so this answers the question straight after a
 * failing check, which is when anybody actually asks it.
 *
 * @param {import('../types.js').Project} project
 * @param {string} name
 * @param {import('../types.js').Marker[]} markers oldest first
 * @returns {Promise<import('../types.js').TraceFinding>}
 */
async function traceOne(project, name, markers) {
  const now = await currentLook(project.paths, name);
  if (!now) {
    return { name, verdict: 'unknown', message: 'There is no picture of this screen on disk, so there is nothing to compare against history.' };
  }

  const seen = markers.filter((m) => m.pictures && typeof m.pictures[name] === 'string');
  if (seen.length === 0) {
    return { name, verdict: 'unknown', message: 'No marker has ever recorded this screen, so its history starts today.' };
  }

  const newest = seen[seen.length - 1];
  if (newest.pictures[name] === now) return { name, verdict: 'unchanged', lastGood: newest };

  let goodIndex = -1;
  for (let i = seen.length - 1; i >= 0; i -= 1) {
    if (seen[i].pictures[name] === now) {
      goodIndex = i;
      break;
    }
  }

  if (goodIndex === -1) {
    return {
      name,
      verdict: 'changed',
      firstBad: seen[0],
      message: `It does not match any of the ${seen.length} markers that recorded it, so it has never looked like this at a known-good point.`,
    };
  }

  const lastGood = seen[goodIndex];
  const firstBad = seen[goodIndex + 1];

  /** @type {import('../types.js').TraceFinding} */
  const finding = { name, verdict: 'changed', lastGood, firstBad };

  const from = lastGood.git?.sha;
  const to = firstBad.git?.sha;
  const root = project.paths.root;
  if (from && to && (await commitExists(root, from)) && (await commitExists(root, to))) {
    finding.commits = await commitsBetween(root, from, to);
    finding.files = await filesBetween(root, from, to);
  }
  return finding;
}

/**
 * @param {import('../types.js').ProjectPaths} paths
 * @param {string} name
 * @returns {Promise<string|null>}
 */
async function currentLook(paths, name) {
  const fresh = await sha256File(resultPicture(paths, name).png);
  if (fresh) return fresh;
  return sha256File(approvedPicture(paths, name).png);
}

/**
 * @param {import('../types.js').Marker} m
 */
function markerSha(m) {
  return m.git?.shortSha ? `, commit ${m.git.shortSha}` : '';
}

// ---------------------------------------------------------------------------
// approve  (only reachable when the project opted in)
// ---------------------------------------------------------------------------

/**
 * @param {import('../types.js').Project} project
 * @param {Record<string, any>} input
 * @param {ToolContext} ctx
 * @returns {Promise<ToolResult>}
 */
async function toolApprove(project, input, ctx) {
  // Belt and braces: the tool is not even listed when this is off, but a client
  // can still send any name it likes, and this is the one door worth bolting twice.
  if (project.config.mcp?.allowApprove !== true) {
    return problem(
      'Approving a picture is a human decision in this project, so this tool is not available to you. Tell the person what changed and why, and let them run `staysfixed approve <screen>`.'
    );
  }

  const screen = text(input.screen);
  const reason = text(input.reason);
  if (!screen) return problem('Say which screen to approve, e.g. { "screen": "sessions-empty", "reason": "..." }.');
  if (!reason) return problem('Say why the new picture is correct. An approval with no reason is worth nothing to the person reading it later.');

  const git = await gitInfo(project.paths.root);
  const meta = await approveFromResult(project.paths, screen, { git, tool: `staysfixed ${ctx.version} (agent)` });

  // A trail, because this is the one place an agent overrules the safety net.
  await appendApprovalLog(project.paths, {
    at: meta.approvedAt,
    screen,
    reason,
    by: 'agent, over MCP',
    tool: meta.tool,
    gitSha: git.shortSha,
    sha256: meta.sha256,
  });

  return {
    content: [
      {
        type: 'text',
        text: `Approved: ${quote(screen)} now looks the way it should. Reason recorded: ${reason}\nThe new picture is committed to the project, so mention this in what you report back — a person should know a picture was re-approved by an agent.`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// mark  (only reachable when the project opted in)
// ---------------------------------------------------------------------------

/**
 * @param {import('../types.js').Project} project
 * @param {Record<string, any>} input
 * @param {ToolContext} ctx
 * @returns {Promise<ToolResult>}
 */
async function toolMark(project, input, ctx) {
  if (project.config.mcp?.allowMark !== true) {
    return problem('Writing a known-good marker is a human decision in this project. Ask the person to run `staysfixed mark <label>`.');
  }

  const label = text(input.label);
  const note = text(input.note);
  if (!label) return problem("Give the marker a name, e.g. { \"label\": \"v0.15.0\" }.");

  // A marker is a promise that everything worked here. Checking first is the only
  // way that promise means anything later, when someone traces a bug back to it.
  /** @type {import('../types.js').RunSummary} */
  const summary = await runCheck(project, /** @type {any} */ ({}));
  if (!summary.ok) {
    return problem(
      `Not marking ${quote(label)} — this is not a known-good point yet.\n\n${renderCheck(summary, project)}`
    );
  }

  const git = await gitInfo(project.paths.root);
  /** @type {Record<string, import('../types.js').CheckStatus>} */
  const guards = {};
  for (const g of summary.guards) guards[g.name] = g.status;

  /** @type {import('../types.js').Marker} */
  const marker = {
    label,
    at: new Date().toISOString(),
    git,
    pictures: await approvedHashes(project.paths),
    guards,
    tool: `staysfixed ${ctx.version}`,
    platform: platformTag(),
  };
  if (note) marker.note = note;

  await fsp.mkdir(project.paths.markers, { recursive: true });
  await fsp.writeFile(path.join(project.paths.markers, `${safeName(label)}.json`), JSON.stringify(marker, null, 2) + '\n');

  // A marker on a dirty tree points at a commit that never contained this code, so
  // a later trace would blame the wrong change. Worth saying out loud.
  const dirtyNote = git.dirty
    ? ' Note: there are uncommitted changes, so this marker points at a commit that does not contain them. Committing first makes it far more useful.'
    : '';

  return {
    content: [
      {
        type: 'text',
        text: `Marked ${quote(label)} as known-good: ${count(Object.keys(marker.pictures).length, 'picture')} and ${count(
          Object.keys(guards).length,
          'guard'
        )} recorded${git.shortSha ? ` at commit ${git.shortSha}` : ''}. If something breaks later, staysfixed_trace can now point at the commits after this point.${dirtyNote}`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Disk helpers
// ---------------------------------------------------------------------------

/**
 * Read every marker in the folder, forgiving anything unreadable — a trace is
 * still useful when one marker file has been hand-edited into nonsense.
 * @param {import('../types.js').ProjectPaths} paths
 * @returns {Promise<import('../types.js').Marker[]>} oldest first
 */
async function readMarkers(paths) {
  /** @type {import('../types.js').Marker[]} */
  const out = [];
  /** @type {string[]} */
  let files;
  try {
    files = await fsp.readdir(paths.markers);
  } catch {
    return out;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(paths.markers, file), 'utf8'));
      if (raw && typeof raw === 'object' && typeof raw.label === 'string') {
        const m = /** @type {import('../types.js').Marker} */ (raw);
        if (!m.pictures || typeof m.pictures !== 'object') m.pictures = {};
        out.push(m);
      }
    } catch {
      // Unreadable marker: skipped on purpose, never fatal.
    }
  }
  out.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
  return out;
}

/**
 * @param {import('../types.js').ProjectPaths} paths
 * @returns {Promise<import('../types.js').RunSummary|null>}
 */
async function readLastRun(paths) {
  for (const file of [path.join(paths.dir, 'last-run.json'), path.join(paths.results, 'last-run.json')]) {
    try {
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (raw && typeof raw === 'object') return /** @type {import('../types.js').RunSummary} */ (raw);
    } catch {
      // Not there, or not readable. Either way there is simply no last run to show.
    }
  }
  return null;
}

/**
 * @param {import('../types.js').ProjectPaths} paths
 * @param {Record<string, unknown>} entry
 */
async function appendApprovalLog(paths, entry) {
  try {
    await fsp.mkdir(paths.dir, { recursive: true });
    await fsp.appendFile(path.join(paths.dir, 'approvals.log'), JSON.stringify(entry) + '\n');
  } catch {
    // The approval itself succeeded; failing to write the note about it must not
    // turn into an error the agent reports as a failed approval.
  }
}

/**
 * @param {string} file
 * @returns {Promise<Buffer|null>}
 */
async function readMaybe(file) {
  try {
    return await fsp.readFile(file);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} e
 * @returns {string}
 */
function explain(e) {
  const message = messageOf(e);
  if (isExpected(e)) {
    const hint = /** @type {import('../core/errors.js').StaysFixedError} */ (e).hint;
    return hint ? `${message}\n${hint}` : message;
  }
  return `Stays Fixed could not finish that: ${message}`;
}

/**
 * @param {string} message
 * @returns {ToolResult}
 */
function problem(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * @param {unknown} v
 * @returns {string|null}
 */
function text(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
}

/**
 * @param {unknown} v
 * @returns {string[]|undefined}
 */
function stringList(v) {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => String(x).trim());
  return out.length ? out : undefined;
}

/**
 * @param {number} n
 * @param {string} word
 */
function count(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** @param {string} s */
function quote(s) {
  return `"${s}"`;
}

/**
 * @param {string} s
 * @param {number} max
 */
function trim(s, max) {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

/** @param {number} ratio */
function formatShare(ratio) {
  const pct = ratio * 100;
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  if (pct >= 0.01) return `${pct.toFixed(2)}%`;
  return 'less than 0.01%';
}

/** @param {string} iso */
function day(iso) {
  const s = String(iso ?? '');
  return s.length >= 10 ? s.slice(0, 10) : s || 'an unknown date';
}

/**
 * @param {{describe?: string}} p
 */
function describeOf(p) {
  return p.describe ? ` (${p.describe})` : '';
}
