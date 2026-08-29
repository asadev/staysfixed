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

  const seeds = [...changed.files, ...changed.untracked].map((f) => path.resolve(changed.root, f));
  /** @type {Map<string, number>} */
  let distances = new Map();
  if (seeds.length > 0) {
    const graph = await importGraph(changed.root);
    if (graph.truncated) {
      notes.push(
        'This project has more source files than the distance measure will walk, so some findings say their distance is unknown.',
      );
    }
    distances = distancesFrom(graph.neighbours, seeds, opts.maxHops ?? MAX_HOPS);
  } else if (changed.ok) {
    notes.push('Nothing in the working tree has changed, so none of this can be blamed on an edit you just made.');
  }

  const ranked = findings.map((finding) => {
    const sealedClass = classOf(finding, guards);
    const distance = distanceFor(finding, distances, changed.root, opts.touches ?? {});
    /** @type {Finding} */
    const out = {
      ...finding,
      class: sealedClass,
      sealed: sealedClass !== 'ordinary',
      rank: scoreOf(finding, sealedClass, distance),
      why: explain(finding, sealedClass, distance, seeds.length > 0),
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

  const channels = new Set(finding.differences.map((d) => d.channel));
  for (const name of guards) {
    if (name && haystack.toLowerCase().includes(name.toLowerCase())) return 'guard';
  }
  if (finding.differences.some((d) => splitPath(d.path)[0] === 'guard')) return 'guard';
  if (channels.has('complaints') && CRASH.test(haystack)) return 'crash';
  if (DATA_LOSS_ALWAYS.test(haystack)) return 'data-loss';
  // The softer words — "delete", "migrate" — only seal when something actually
  // went out or came back. A button labelled Delete that changed colour is not a
  // data-loss incident, and treating it as one is how a safety net gets ignored.
  if (
    DATA_LOSS_IN_EFFECTS.test(haystack) &&
    (channels.has('effects') || channels.has('results') || channels.has('contract'))
  ) {
    return 'data-loss';
  }
  if (MONEY.test(haystack)) return 'money';
  if (SIGN_IN.test(haystack)) return 'sign-in';
  return 'ordinary';
}

/**
 * @param {Finding} finding
 * @param {FindingClass} sealedClass
 * @param {number|null} distance
 */
function scoreOf(finding, sealedClass, distance) {
  if (sealedClass !== 'ordinary') {
    // Sealed findings live above everything else, ordered among themselves by
    // how much damage the class can do. The gap is deliberately enormous, so no
    // amount of distance or spread can lift an ordinary finding into them.
    const rank = SEALED_ORDER.indexOf(sealedClass);
    return 10_000 - rank * 100 + Math.min(finding.count ?? 1, 50);
  }

  // Far from the edit is suspicious. Inside the edit is expected, and sorts last.
  const far = distance === null ? 3 : distance === 0 ? 0 : Math.min(2 + distance * 2, 12);
  const channel = Math.max(...finding.differences.map((d) => CHANNEL_WEIGHT[d.channel] ?? 2));
  // Something appearing or vanishing is worth more than something moving: a
  // whole address arriving or leaving is a shape change, not a value change.
  const shape = finding.differences.some((d) => d.kind !== 'changed') ? 4 : 0;
  const spread = Math.min(4, Math.floor(Math.log2((finding.count ?? 1) + 1)));
  return far * 10 + channel * 3 + shape + spread;
}

/**
 * @param {Finding} finding
 * @param {FindingClass} sealedClass
 * @param {number|null} distance
 * @param {boolean} knewWhatChanged
 */
function explain(finding, sealedClass, distance, knewWhatChanged) {
  if (sealedClass !== 'ordinary') {
    return `Nobody may wave this through on their own: it touches ${SEAL_WORDS[sealedClass]}. It goes to a person whatever caused it.`;
  }
  if (!knewWhatChanged) {
    return 'Nothing in the working tree has changed, so there is no edit to measure this against.';
  }
  if (distance === null) {
    return 'Nothing says which code this comes from, so how far it sits from your edit is unknown. Treat it as unexplained until you have checked.';
  }
  if (distance === 0) return 'This is in a file you just changed, so it is most likely what you meant to do.';
  if (distance === 1) return 'This is one step away from a file you changed, so your edit probably reaches it.';
  return `This is ${distance} steps away from anything you changed. That is what a side effect looks like.`;
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
 * @returns {number|null}
 */
function distanceFor(finding, distances, root, touches) {
  if (distances.size === 0) return null;
  /** @type {number[]} */
  const found = [];

  /** @param {string|undefined} file */
  const look = (file) => {
    if (!file) return;
    const abs = path.isAbsolute(file) ? file : path.resolve(root, file);
    const hops = distances.get(abs);
    if (typeof hops === 'number') found.push(hops);
  };

  for (const file of finding.nearFiles ?? []) look(file);

  if (found.length === 0) {
    for (const journey of journeysOf(finding)) {
      const files = touches[journey];
      if (!files || files.length === 0 || files.length > 25) continue;
      for (const file of files) look(file);
    }
  }
  return found.length > 0 ? Math.min(...found) : null;
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

  const patch = (await git(['diff', 'HEAD', '-U3', '--no-color', '--no-ext-diff'], cwd, true)) ?? '';
  const names = (await git(['diff', 'HEAD', '--name-only'], cwd)) ?? '';
  const others = (await git(['ls-files', '--others', '--exclude-standard'], cwd)) ?? '';

  return {
    ok: true,
    files: lines(names),
    untracked: lines(others),
    hunks: parseHunks(patch),
    patch,
    root,
  };
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
 * @returns {Promise<{neighbours: Map<string, Set<string>>, files: string[], truncated: boolean}>}
 */
export async function importGraph(root, opts = {}) {
  const limit = opts.maxFiles ?? MAX_FILES;
  const files = await sourceFiles(root, limit);
  /** @type {Map<string, Set<string>>} */
  const neighbours = new Map();
  const known = new Set(files.list);

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
      if (stat.size > MAX_FILE_BYTES) continue;
      text = await fsp.readFile(file, 'utf8');
    } catch {
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

  return { neighbours, files: files.list, truncated: files.truncated };
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
 * @param {boolean} [keepBlankLines]
 * @returns {Promise<string|null>}
 */
async function git(args, cwd, keepBlankLines = false) {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
    return keepBlankLines ? stdout : stdout.trim();
  } catch {
    return null;
  }
}

/** @param {string} text */
function lines(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
