/**
 * The order is the product.
 *
 * An agent that has just edited three files does not need to be told that those
 * three files behave differently — it made them behave differently on purpose.
 * What it needs is the thing that changed somewhere it never touched, because
 * that is the definition of a side effect and it is the only reason this tool
 * exists. So findings are ordered by DISTANCE from the edit: a difference far
 * away sorts to the top, and a difference inside the edit sorts to the bottom.
 *
 * Distance is measured by walking imports out from the files the working tree
 * has changed. It is a cheap graph and a rough number, and rough is fine: the
 * gap between "in the file you edited" and "six modules away" is enormous and
 * easy to see, and nothing here depends on telling four hops from five.
 *
 * Above all of it sit the sealed classes. Money, signing in, losing data, a
 * crash, or anything touching a bug already reported once: those go first
 * whatever the distance says, and no agent may wave them through.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { splitPath } from './observation.js';
import { journeysOf } from './cluster.js';

/** @typedef {import('./types.js').Finding} Finding */
/** @typedef {import('./types.js').FindingClass} FindingClass */
/** @typedef {import('./types.js').Channel} Channel */

const run = promisify(execFile);

/** Folders that are never anybody's source code. Skipping them is most of what makes the graph cheap. */
const NOT_SOURCE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.staysfixed',
  'vendor',
  'Pods',
  'DerivedData',
  '__pycache__',
  '.venv',
  'target',
]);

const SOURCE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte'];

/** Ceilings, so a check on a very large repo never turns into a crawl of it. */
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 400_000;
const MAX_HOPS = 8;

/**
 * The classes nobody may wave through, worst first. A guard leads because a
 * guard means a bug he already reported once has come back, and that is the
 * fastest way there is to lose trust in a product.
 *
 * @type {FindingClass[]}
 */
const SEALED_ORDER = ['guard', 'crash', 'data-loss', 'money', 'sign-in'];

/**
 * What each sealed class is called when it has to be said in a sentence.
 * @type {Record<FindingClass, string>}
 */
const SEAL_WORDS = {
  guard: 'a bug you already reported once',
  crash: 'a crash',
  'data-loss': 'losing data',
  money: 'money',
  'sign-in': 'signing in',
  ordinary: 'nothing sealed',
};

const MONEY =
  /\b(charge|charged|charging|payment|payments|invoice|refund|price|pricing|billing|billed|subscription|checkout|stripe|paypal|currency|card number|credit card|amount due|total due|payout)\b/i;
const SIGN_IN =
  /\b(sign ?in|sign ?out|sign ?up|log ?in|log ?out|login|logout|signin|signup|auth|oauth|session token|access token|refresh token|password|passcode|credential|credentials|api key|permission|permissions)\b/i;
const DATA_LOSS_ALWAYS =
  /(\bdrop table\b|\btruncate\b|\bdelete from\b|\brm -rf\b|\bunlink\b|\bwipe\b|\bpurge\b|\berase\b|\bdata loss\b|\bdestroy\b)/i;
const DATA_LOSS_IN_EFFECTS = /\b(delete|deleted|remove all|clear all|migration|migrate|overwrite)\b/i;
const CRASH =
  /\b(crash|crashed|uncaught|unhandled|fatal|segfault|panic|out of memory|stack overflow|core dumped|nonzero exit|exit code)\b/i;

/**
 * How much each channel is worth when nothing else separates two findings. A
 * call that went out or an error that appeared deserves more attention than a
 * count that moved; a picture is worth least, because by the time it reaches
 * here it is only evidence for something another channel already said.
 *
 * @type {Record<Channel, number>}
 */
const CHANNEL_WEIGHT = {
  effects: 5,
  complaints: 5,
  results: 4,
  contract: 4,
  meaning: 3,
  counters: 2,
  pixels: 1,
};

/**
 * How far a finding sits from the edit, and — when the answer is "we do not know" — WHICH
 * kind of not knowing it is. Three different states used to arrive as one `null`:
 * nothing names the finding's source, the file is known and the edit never reaches it, and
 * the graph was never built. Only the middle one is a side effect, and it is the loudest
 * signal this tool has.
 *
 * @typedef {object} HowFar
 * @property {number|null} distance  Hops from the nearest changed file, or null.
 * @property {boolean} beyond        The source file is in this project and no path of at
 *                                   most `maxHops` imports leads to it from anything changed.
 * @property {string} [beyondFile]   Which file, so the sentence can name it.
 */

/**
 * @typedef {object} ChangedHunk
 * @property {string} file        Repo-relative, the "after" side.
 * @property {string} header      The hunk header line, exactly as git wrote it.
 * @property {string} fileHeader  The "diff --git" block this hunk belongs to.
 * @property {string} text        The hunk, header line included.
 * @property {string} patch       A complete one-hunk patch, ready for `git apply`.
 * @property {number} newStart
 * @property {number} newLines
 */

/**
 * @typedef {object} Changed
 * @property {boolean} ok
 * @property {string} [why]        Why we could not tell, in plain language.
 * @property {string[]} files      Tracked files with changes, repo-relative.
 * @property {string[]} untracked  New files git has never seen, repo-relative.
 * @property {ChangedHunk[]} hunks
 * @property {string} patch        The whole working diff, as one patch.
 * @property {string} root         Absolute repo root.
 * @property {boolean} [patchUnread]  True when git could not hand the working diff over at
 *                                    all — it timed out, or the diff was larger than the
 *                                    buffer set aside for it. `hunks` and `patch` are then
 *                                    empty for a reason that is NOT "nothing changed", and
 *                                    everything downstream has to be told which of the two
 *                                    it is looking at.
 * @property {string} [patchUnreadWhy]
 */

/**
 * Put the findings in the order somebody should read them, and fill in the class
 * and the sentence explaining the placing.
 *
 * @param {Finding[]} findings
 * @param {{
 *   cwd: string,
 *   guards?: string[],
 *   touches?: Record<string, string[]>,
 *   changed?: Changed,
 *   maxHops?: number,
 * }} opts
 * @returns {Promise<{findings: Finding[], notes: string[], youChanged: string[]}>}
 */
export async function rankFindings(findings, opts) {
  /** @type {string[]} */
  const notes = [];
  const guards = opts.guards ?? [];
  const changed = opts.changed ?? (await whatChanged(opts.cwd));
  if (!changed.ok && changed.why) {
    notes.push(
      `${changed.why} Findings are ordered by what kind of thing they are instead of by how far they sit from your edit.`,
    );
  }

  if (changed.patchUnread === true) {
    notes.push(
      `${changed.patchUnreadWhy ?? 'git could not hand over the working diff.'} So the list of files you changed is being used, but the individual changes inside them are not known here — and nothing can be proved by undoing one of them until git can hand the diff over.`,
    );
  }

  const hops = opts.maxHops ?? MAX_HOPS;
  const seeds = [...changed.files, ...changed.untracked].map((f) => path.resolve(changed.root, f));
  /** @type {Map<string, number>} */
  let distances = new Map();
  /** @type {Set<string>} */
  let known = new Set();
  if (seeds.length > 0) {
    const graph = await importGraph(changed.root);
    known = new Set(graph.files);
    if (graph.truncated) {
      notes.push(
        `This project has more than ${MAX_FILES} source files, which is as many as the distance measure will walk, so some findings say their distance is unknown.`,
      );
    }
    if (graph.tooBig.length > 0) {
      notes.push(
        `${graph.tooBig.length} source ${graph.tooBig.length === 1 ? 'file was' : 'files were'} too large to read for the distance measure (over ${Math.round(MAX_FILE_BYTES / 1000)}KB): ${graph.tooBig.slice(0, 3).join(', ')}${graph.tooBig.length > 3 ? ', and others' : ''}. Anything only they import looks unconnected to your edit, so it may be ranked lower than it deserves.`,
      );
    }
    if (graph.unreadable.length > 0) {
      notes.push(
        `${graph.unreadable.length} source ${graph.unreadable.length === 1 ? 'file' : 'files'} could not be opened for the distance measure: ${graph.unreadable.slice(0, 3).join(', ')}. The same warning applies — what they import looks unconnected.`,
      );
    }
    distances = distancesFrom(graph.neighbours, seeds, hops);
  } else if (changed.ok && changed.patchUnread !== true) {
    notes.push('Nothing in the working tree has changed, so none of this can be blamed on an edit you just made.');
  }

  const ranked = findings.map((finding) => {
    const sealedClass = classOf(finding, guards);
    const how = distanceFor(finding, distances, changed.root, opts.touches ?? {}, known);
    /** @type {Finding} */
    const out = {
      ...finding,
      class: sealedClass,
      sealed: sealedClass !== 'ordinary',
      rank: scoreOf(finding, sealedClass, how),
      why: explain(finding, sealedClass, how, seeds.length > 0, hops),
    };
    const near = nearestFiles(finding, distances, changed.root);
    if (near.length > 0) out.nearFiles = near;
    return out;
  });

  ranked.sort((a, b) => b.rank - a.rank || (b.count ?? 0) - (a.count ?? 0) || a.id.localeCompare(b.id));
  return { findings: ranked, notes, youChanged: [...changed.files, ...changed.untracked] };
}

// ---------------------------------------------------------------------------
// The sealed classes
// ---------------------------------------------------------------------------

/**
 * Which class of "nobody may wave this through" a finding falls in.
 *
 * The words are matched against everything the finding says about itself, not
 * only its addresses, because a difference in what a call SENDS is as much a
 * money difference as a difference in what a screen calls a button.
 *
 * @param {Finding} finding
 * @param {string[]} guards  Guard names, so a difference touching one is sealed by name.
 * @returns {FindingClass}
 */
export function classOf(finding, guards) {
  const haystack = [
    finding.title,
    finding.signature ?? '',
    ...finding.differences.map((d) => d.path),
    ...finding.differences.map((d) => d.describe ?? ''),
    ...journeysOf(finding),
  ].join(' \n ');

  // The VALUES as well, and this is the half that was missing.
  //
  // The doc above this function has always said the words are matched against everything the
  // finding says about itself. They were not: only its addresses and the sentences written
  // about it. A finding's title carries at most the first seventy characters of the value, so
  // a stack trace whose "fatal" is on line four, or a request body whose "currency" comes
  // after a long url, said nothing at all — and a crash, a charge or a sign-in that changed
  // was filed `ordinary`, which is precisely the class an agent is allowed to wave through
  // on its own. Every one of the five sealed classes was blind in the same place.
  //
  // Nothing is truncated here and nothing is sampled. A cap would put the blindness back in a
  // new place, and the cost is one pass over values that have already been normalised, stored
  // and diffed several times over.
  /** @type {string[]} */
  const values = [];
  for (const d of finding.differences) {
    if (d.reference !== undefined) values.push(asText(d.reference));
    if (d.candidate !== undefined) values.push(asText(d.candidate));
  }
  /** @param {RegExp} rx */
  const says = (rx) => rx.test(haystack) || values.some((v) => rx.test(v));

  const channels = new Set(finding.differences.map((d) => d.channel));
  for (const name of guards) {
    if (!name) continue;
    const wanted = name.toLowerCase();
    if (haystack.toLowerCase().includes(wanted)) return 'guard';
    if (values.some((v) => v.toLowerCase().includes(wanted))) return 'guard';
  }
  if (finding.differences.some((d) => splitPath(d.path)[0] === 'guard')) return 'guard';
  if (channels.has('complaints') && says(CRASH)) return 'crash';
  if (says(DATA_LOSS_ALWAYS)) return 'data-loss';
  // The softer words — "delete", "migrate" — only seal when something actually
  // went out or came back. A button labelled Delete that changed colour is not a
  // data-loss incident, and treating it as one is how a safety net gets ignored.
  if (
    says(DATA_LOSS_IN_EFFECTS) &&
    (channels.has('effects') || channels.has('results') || channels.has('contract'))
  ) {
    return 'data-loss';
  }
  if (says(MONEY)) return 'money';
  if (says(SIGN_IN)) return 'sign-in';
  return 'ordinary';
}

/**
 * One observed value as searchable text.
 *
 * A string is itself; anything else is its JSON, so a word inside a nested body is found the
 * same way as a word in a log line. A value that cannot be turned into JSON — which nothing
 * that reached here should be, since observations are validated at birth — comes back as the
 * empty string rather than taking the run down over a sealing check.
 *
 * @param {unknown} value
 * @returns {string}
 */
function asText(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * @param {Finding} finding
 * @param {FindingClass} sealedClass
 * @param {HowFar} how
 */
function scoreOf(finding, sealedClass, how) {
  if (sealedClass !== 'ordinary') {
    // Sealed findings live above everything else, ordered among themselves by
    // how much damage the class can do. The gap is deliberately enormous, so no
    // amount of distance or spread can lift an ordinary finding into them.
    const rank = SEALED_ORDER.indexOf(sealedClass);
    return 10_000 - rank * 100 + Math.min(finding.count ?? 1, 50);
  }

  // Far from the edit is suspicious. Inside the edit is expected, and sorts last.
  // `beyond` is farther than the measure walks — the MOST suspicious thing there is — and it
  // used to be filed as "unknown" and scored in the middle, alongside a finding whose source
  // file nobody could name. Those are opposite answers.
  const far = how.beyond ? 14 : how.distance === null ? 3 : how.distance === 0 ? 0 : Math.min(2 + how.distance * 2, 12);
  // A reduce, not `Math.max(...list)`. Spreading an array into a call blows the stack at
  // somewhere over a hundred thousand items, and a cluster that big is not hypothetical on a
  // product whose reference holds fifteen thousand addresses across seventeen journeys.
  const channel = finding.differences.reduce((best, d) => Math.max(best, CHANNEL_WEIGHT[d.channel] ?? 2), 0);
  // Something appearing or vanishing is worth more than something moving: a
  // whole address arriving or leaving is a shape change, not a value change.
  const shape = finding.differences.some((d) => d.kind !== 'changed') ? 4 : 0;
  const spread = Math.min(4, Math.floor(Math.log2((finding.count ?? 1) + 1)));
  return far * 10 + channel * 3 + shape + spread;
}

/**
 * @param {Finding} finding
 * @param {FindingClass} sealedClass
 * @param {HowFar} how
 * @param {boolean} knewWhatChanged
 * @param {number} hops   How far out the measure walked before it stopped.
 */
function explain(finding, sealedClass, how, knewWhatChanged, hops) {
  if (sealedClass !== 'ordinary') {
    return `Nobody may wave this through on their own: it touches ${SEAL_WORDS[sealedClass]}. It goes to a person whatever caused it.`;
  }
  if (!knewWhatChanged) {
    return 'Nothing in the working tree has changed, so there is no edit to measure this against.';
  }
  if (how.beyond) {
    return `This comes from ${how.beyondFile}, which is source code the project has and which nothing you changed reaches within ${hops} steps. That is as far from your edit as this measure goes — the strongest shape a side effect has.`;
  }
  if (how.distance === null) {
    return 'Nothing says which code this comes from, so how far it sits from your edit is unknown. Treat it as unexplained until you have checked.';
  }
  if (how.distance === 0) return 'This is in a file you just changed, so it is most likely what you meant to do.';
  if (how.distance === 1) return 'This is one step away from a file you changed, so your edit probably reaches it.';
  return `This is ${how.distance} steps away from anything you changed. That is what a side effect looks like.`;
}

/**
 * How far a finding sits from the nearest thing the agent edited.
 *
 * The finding's own source files are trusted first. When it has none, the
 * journey's list of files is used — but only when that list is short. A journey
 * that went through four hundred files touches everything, and letting it answer
 * would put every finding at distance zero and quietly switch the ranking off.
 *
 * @param {Finding} finding
 * @param {Map<string, number>} distances
 * @param {string} root
 * @param {Record<string, string[]>} touches
 * @param {Set<string>} known    Every source file the graph walked, so "we never heard of
 *                               this file" can be told from "we heard of it and your edit
 *                               does not reach it".
 * @returns {HowFar}
 */
function distanceFor(finding, distances, root, touches, known) {
  if (distances.size === 0) return { distance: null, beyond: false };
  /** @type {number[]} */
  const found = [];
  /** @type {string[]} */
  const seenButUnreached = [];

  /** @param {string|undefined} file */
  const look = (file) => {
    if (!file) return;
    const abs = path.isAbsolute(file) ? file : path.resolve(root, file);
    const hops = distances.get(abs);
    if (typeof hops === 'number') found.push(hops);
    // The file IS in the project and the walk out from the edit never arrived at it. That is
    // the farthest a finding can be, and until 2026-08-30 it was scored and worded exactly
    // like "we have no idea where this came from" — the mid-table answer. So the single most
    // suspicious finding this tool can produce sorted below one whose source was simply
    // unknown, and the sentence beside it said nothing named the code, which was untrue.
    else if (known.has(abs)) seenButUnreached.push(path.relative(root, abs) || abs);
  };

  for (const file of finding.nearFiles ?? []) look(file);

  if (found.length === 0 && seenButUnreached.length === 0) {
    for (const journey of journeysOf(finding)) {
      const files = touches[journey];
      if (!files || files.length === 0 || files.length > 25) continue;
      for (const file of files) look(file);
    }
  }
  // A reduce for the same reason `scoreOf` uses one: spreading a list into a call has a
  // ceiling, and a list that is bounded today is bounded by a constant somebody may raise.
  if (found.length > 0) return { distance: found.reduce((best, n) => (n < best ? n : best), found[0]), beyond: false };
  if (seenButUnreached.length > 0) return { distance: null, beyond: true, beyondFile: seenButUnreached[0] };
  return { distance: null, beyond: false };
}

/**
 * The finding's source files, nearest to the edit first, so a reader opens the
 * most useful one.
 *
 * @param {Finding} finding
 * @param {Map<string, number>} distances
 * @param {string} root
 * @returns {string[]}
 */
function nearestFiles(finding, distances, root) {
  const files = finding.nearFiles ?? [];
  if (files.length < 2 || distances.size === 0) return files;
  return [...files].sort((a, b) => {
    const da = distances.get(path.resolve(root, a)) ?? Number.MAX_SAFE_INTEGER;
    const db = distances.get(path.resolve(root, b)) ?? Number.MAX_SAFE_INTEGER;
    return da - db;
  });
}

// ---------------------------------------------------------------------------
// What the agent just changed
// ---------------------------------------------------------------------------

/**
 * Read the working tree's diff: which files, and which hunks inside them.
 *
 * Read-only, and allowed to fail. A project that is not in git still gets
 * checked - it just gets its findings ordered by kind rather than by distance,
 * and it is told so.
 *
 * @param {string} cwd
 * @returns {Promise<Changed>}
 */
export async function whatChanged(cwd) {
  const root = await git(['rev-parse', '--show-toplevel'], cwd);
  if (!root) {
    return {
      ok: false,
      why: 'This folder is not inside a git repository, so there is no way to know what you have just changed.',
      files: [],
      untracked: [],
      hunks: [],
      patch: '',
      root: cwd,
    };
  }
  const head = await git(['rev-parse', '--verify', 'HEAD'], cwd);
  if (!head) {
    return {
      ok: false,
      why: 'This repository has no commits yet, so there is nothing to compare the working tree against.',
      files: [],
      untracked: [],
      hunks: [],
      patch: '',
      root,
    };
  }

  const diff = await gitTry(['diff', 'HEAD', '-U3', '--no-color', '--no-ext-diff'], cwd);
  const names = await gitTry(['diff', 'HEAD', '--name-only'], cwd);
  const others = await gitTry(['ls-files', '--others', '--exclude-standard'], cwd);

  // Not knowing WHICH files changed is a different and worse failure than not being able to
  // read the diff of them, so it is reported as not knowing anything rather than as an empty
  // list — an empty list reads as "you changed nothing", and ranking would then quietly stop
  // measuring distance while saying it had.
  if (!names.ok) {
    return {
      ok: false,
      why: `git could not say which files you have changed: ${names.why}`,
      files: [],
      untracked: lines(others.text),
      hunks: [],
      patch: '',
      root,
    };
  }

  /** @type {Changed} */
  const changed = {
    ok: true,
    files: lines(names.text),
    untracked: lines(others.text),
    hunks: diff.ok ? parseHunks(diff.text) : [],
    patch: diff.ok ? diff.text : '',
    root,
  };
  if (!diff.ok) {
    // A diff that is too big for the buffer, or a git that took too long, used to come back
    // as the empty string — which every reader downstream read as "the working tree is
    // clean". The causal proof then answered "nothing has changed, so there is nothing to
    // undo" on a tree with a hundred edits in it, and sounded certain doing it.
    changed.patchUnread = true;
    changed.patchUnreadWhy = `git could not hand over the working diff: ${diff.why}`;
  }
  return changed;
}

/**
 * Split a unified diff into hunks, each carrying enough of its file's header to
 * be applied - or reversed - on its own.
 *
 * @param {string} patch
 * @returns {ChangedHunk[]}
 */
export function parseHunks(patch) {
  /** @type {ChangedHunk[]} */
  const hunks = [];
  if (!patch) return hunks;

  const all = patch.split('\n');
  /** @type {string[]} */
  let header = [];
  let file = '';
  /** @type {string[]|null} */
  let body = null;
  let at = '';
  let newStart = 0;
  let newLines = 0;

  const flush = () => {
    if (body === null) return;
    // The final split of the whole patch leaves an empty string on the end. Left
    // in, it becomes a phantom context line and `git apply --recount` refuses the
    // hunk. A real empty context line in a diff is a single space, never nothing.
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    const text = body.join('\n');
    hunks.push({
      file,
      header: at,
      fileHeader: header.join('\n'),
      text,
      patch: `${header.join('\n')}\n${text}\n`,
      newStart,
      newLines,
    });
    body = null;
  };

  for (const line of all) {
    if (line.startsWith('diff --git ')) {
      flush();
      header = [line];
      file = '';
      continue;
    }
    if (body === null && !line.startsWith('@@')) {
      // Still in the file's header: index lines, mode lines, --- and +++.
      if (header.length > 0) header.push(line);
      if (line.startsWith('+++ b/')) file = line.slice(6);
      else if (line.startsWith('--- a/') && file === '') file = line.slice(6);
      continue;
    }
    if (line.startsWith('@@')) {
      flush();
      at = line;
      const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      newStart = m ? Number(m[1]) : 0;
      newLines = m && m[2] !== undefined ? Number(m[2]) : 1;
      body = [line];
      continue;
    }
    if (body === null) continue;
    body.push(line);
  }
  flush();
  return hunks;
}

// ---------------------------------------------------------------------------
// The import graph
// ---------------------------------------------------------------------------

/**
 * A cheap map of who imports whom.
 *
 * Regexes, not a parser. It will miss a dynamic import built out of a variable
 * and it will not follow a bundler alias, and neither matters: this number is
 * only ever used to sort a list. Being approximately right instantly beats being
 * exactly right in a minute.
 *
 * @param {string} root
 * @param {{maxFiles?: number}} [opts]
 * @returns {Promise<{neighbours: Map<string, Set<string>>, files: string[], truncated: boolean, tooBig: string[], unreadable: string[]}>}
 */
export async function importGraph(root, opts = {}) {
  const limit = opts.maxFiles ?? MAX_FILES;
  const files = await sourceFiles(root, limit);
  /** @type {Map<string, Set<string>>} */
  const neighbours = new Map();
  const known = new Set(files.list);
  // A file skipped for being large, and a file skipped because it would not open, used to be
  // the same silent `continue`. That is the exact shape that already cost this project once:
  // the source reader stepped over a 3.5MB bundle and then reported it had found no source.
  // Here it does not fake a finding, it warps the ranking — every module that only that file
  // imports looks unconnected, so a side effect in it sorts as if nothing reached it.
  /** @type {string[]} */
  const tooBig = [];
  /** @type {string[]} */
  const unreadable = [];

  /** @param {string} a @param {string} b */
  const join = (a, b) => {
    const set = neighbours.get(a) ?? new Set();
    set.add(b);
    neighbours.set(a, set);
  };

  for (const file of files.list) {
    let text = '';
    try {
      const stat = await fsp.stat(file);
      if (stat.size > MAX_FILE_BYTES) {
        tooBig.push(path.relative(root, file));
        continue;
      }
      text = await fsp.readFile(file, 'utf8');
    } catch {
      unreadable.push(path.relative(root, file));
      continue;
    }
    for (const spec of specifiersIn(text)) {
      if (!spec.startsWith('.')) continue;
      const target = resolveNearby(path.dirname(file), spec, known);
      if (!target || target === file) continue;
      // Undirected: a side effect travels both ways along an import, and for a
      // number that only orders a list, direction is not worth the extra pass.
      join(file, target);
      join(target, file);
    }
  }

  return { neighbours, files: files.list, truncated: files.truncated, tooBig, unreadable };
}

/**
 * How many imports away each file is from the nearest thing that changed.
 *
 * @param {Map<string, Set<string>>} neighbours
 * @param {string[]} seeds
 * @param {number} maxHops
 * @returns {Map<string, number>}
 */
export function distancesFrom(neighbours, seeds, maxHops) {
  /** @type {Map<string, number>} */
  const distance = new Map();
  /** @type {string[]} */
  let edge = [];
  for (const seed of seeds) {
    distance.set(seed, 0);
    edge.push(seed);
  }
  let hops = 0;
  while (edge.length > 0 && hops < maxHops) {
    hops += 1;
    /** @type {string[]} */
    const next = [];
    for (const file of edge) {
      for (const neighbour of neighbours.get(file) ?? []) {
        if (distance.has(neighbour)) continue;
        distance.set(neighbour, hops);
        next.push(neighbour);
      }
    }
    edge = next;
  }
  return distance;
}

/**
 * Every source file under a root, without ever walking into somebody else's.
 *
 * @param {string} root
 * @param {number} limit
 * @returns {Promise<{list: string[], truncated: boolean}>}
 */
async function sourceFiles(root, limit) {
  /** @type {string[]} */
  const list = [];
  /** @type {string[]} */
  const queue = [root];
  let truncated = false;
  while (queue.length > 0) {
    const dir = queue.pop();
    if (dir === undefined) break;
    /** @type {import('node:fs').Dirent[]} */
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Hidden folders are tooling, not product. Walking them costs time and
        // adds nothing a distance measure can use.
        if (entry.name.startsWith('.') || NOT_SOURCE.has(entry.name)) continue;
        queue.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.includes(path.extname(entry.name))) continue;
      if (list.length >= limit) {
        truncated = true;
        return { list, truncated };
      }
      list.push(path.join(dir, entry.name));
    }
  }
  return { list, truncated };
}

/**
 * Every module specifier a file mentions.
 * @param {string} text
 * @returns {string[]}
 */
export function specifiersIn(text) {
  /** @type {string[]} */
  const out = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    /** @type {RegExpExecArray|null} */
    let m = null;
    while ((m = pattern.exec(text)) !== null) out.push(m[1]);
  }
  return out;
}

/**
 * Turn a relative specifier into a file we actually know about.
 *
 * The `.js` to `.ts` fallback is here because TypeScript projects import a file
 * by the name it will have after it is built, which is not the name it has on
 * disk. Without this the graph is empty on half the projects it will meet.
 *
 * @param {string} from
 * @param {string} spec
 * @param {Set<string>} known
 * @returns {string|null}
 */
function resolveNearby(from, spec, known) {
  const base = path.resolve(from, spec);
  /** @type {string[]} */
  const tries = [base];
  for (const ext of SOURCE_EXTENSIONS) tries.push(base + ext);
  for (const ext of SOURCE_EXTENSIONS) tries.push(path.join(base, 'index' + ext));
  const ext = path.extname(base);
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const stem = base.slice(0, -ext.length);
    for (const swap of ['.ts', '.tsx', '.mts', '.cts']) tries.push(stem + swap);
  }
  for (const candidate of tries) if (known.has(candidate)) return candidate;
  return null;
}

// ---------------------------------------------------------------------------
// git, quietly
// ---------------------------------------------------------------------------

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function git(args, cwd) {
  const said = await gitTry(args, cwd);
  return said.ok ? said.text.trim() : null;
}

/**
 * git, with the reason it did not work kept rather than thrown away.
 *
 * `git(...)` collapses every failure into `null`, and for "is this a repository at all" that
 * is the right shape. For reading the diff it is not: an empty answer and a failed answer
 * mean opposite things and only one of them means "nothing changed".
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ok: boolean, text: string, why: string}>}
 */
async function gitTry(args, cwd) {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, text: stdout, why: '' };
  } catch (e) {
    const err = /** @type {{stderr?: string, message?: string, killed?: boolean, code?: string}} */ (e);
    const why = err.killed
      ? 'it took longer than twenty seconds'
      : String(err.stderr || err.message || 'it failed').trim().split('\n')[0];
    return { ok: false, text: '', why };
  }
}

/** @param {string} text */
function lines(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
