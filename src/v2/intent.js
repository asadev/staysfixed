/**
 * The agent says what it meant to change, BEFORE it sees what broke.
 *
 * This is the gate that turns "I meant to do that" from a story into a claim that can be
 * checked. A reason written after seeing the damage is worthless — a model under pressure to
 * finish writes a perfectly plausible reason for a real regression, and nobody reading it can
 * tell. A reason written BEFORE, that then has to match what actually broke, is falsifiable:
 * either the difference falls inside what was declared, or it does not, and that is arithmetic
 * rather than persuasion.
 *
 * WHY THE TREE IS FINGERPRINTED. An intent is only worth anything if the ordering is real. A
 * timestamp alone is a promise; the working tree at the moment of sealing is evidence. So every
 * intent records what the repository looked like when it was sealed — the commit it sat on, the
 * files that were already modified, and a digest of the whole diff. Three things become
 * checkable that were previously taken on trust:
 *
 *   - Whether the intent was written before the edits or after them. If the files it names were
 *     already modified when it was sealed, it was written after the work; that is allowed, and
 *     it is recorded, and it makes every later claim weaker.
 *   - Whether the code being waived is the code the intent was written about. If the tree has
 *     not moved since sealing, the intent describes exactly this build.
 *   - Whether an intent has gone stale. A reference that moved after the intent was sealed means
 *     the world it described has already shipped.
 *
 * WHAT THE FINGERPRINT CANNOT PROVE, said plainly because a safety gate that oversells itself is
 * worse than none. It cannot prove the agent had not already run a check and seen the breakage
 * before sealing — nothing in a working tree records that. What stops that route is the clock
 * gate in waiver.js (an intent must predate the check it is used against, so a peek costs a full
 * re-run), the coverage test (the intent has to NAME the thing, not just mention it), and the
 * budget of five. The fingerprint narrows the hole; it does not close it, and it should never be
 * described as if it did.
 *
 * WHERE THIS WRITES. `<store.dir>/intents/<product>.json`, next to the engine's observations but
 * not inside them. The engine decides what is different; this decides what an agent is allowed
 * to say about it, and a bug in one must not be able to widen the other.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { safeName } from '../core/paths.js';
import { StaysFixedError } from '../core/errors.js';
import { referencePointer } from './store.js';

const run = promisify(execFile);

/**
 * @typedef {import('./types.js').Store} Store
 * @typedef {import('./types.js').Finding} Finding
 */

/** How many intents are kept per product. Enough to explain an old waiver, not a diary. */
const KEEP_INTENTS = 25;

/** Words too general to prove a match on their own. */
const GENERIC_WORDS = new Set([
  'src', 'lib', 'app', 'apps', 'index', 'main', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json',
  'test', 'tests', 'spec', 'page', 'pages', 'view', 'views', 'screen', 'screens', 'component',
  'components', 'util', 'utils', 'helper', 'helpers', 'common', 'shared', 'core', 'api', 'new',
  'old', 'file', 'files', 'code', 'the', 'and', 'for', 'with', 'from', 'into', 'all', 'dist',
  'build', 'node', 'modules', 'public', 'static', 'assets', 'style', 'styles', 'css', 'data',
]);

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

/**
 * What the repository looked like at one moment.
 *
 * @typedef {object} TreeFingerprint
 * @property {'git'|'none'} how        `none` when this is not a git repository, in which case
 *                                     nothing here proves an ordering and it says so.
 * @property {string|null} head        The commit it sat on.
 * @property {string|null} branch
 * @property {boolean} dirty
 * @property {string[]} changedFiles   Repo-relative, sorted. Modified, added, deleted, untracked.
 * @property {string} digest           One short string standing for the whole state, so two
 *                                     moments can be compared without keeping the diff.
 * @property {string} at               ISO. When it was taken.
 * @property {string} note             One plain sentence about what this does and does not prove.
 */

/**
 * A sealed statement of what an agent set out to do.
 *
 * @typedef {object} Intent
 * @property {string} id
 * @property {string} product
 * @property {string} summary          One plain sentence, in the agent's own words.
 * @property {string[]} files          Files, folders or named areas it expects to affect. A
 *                                     difference outside these cannot be waived.
 * @property {string[]} expect         Differences it expects to see, in its own words.
 * @property {string} sealedAt         ISO. Written by this file, never supplied by the caller.
 * @property {string} reference        The reference in force when it was sealed, as a stamp.
 * @property {TreeFingerprint} tree
 * @property {'before-the-edits'|'after-the-edits'|'unknown'} sealedRelativeToEdits
 * @property {string} ordering         One plain sentence about what the ordering proves.
 * @property {string} [by]             Who sealed it, when anybody knows.
 */

/**
 * Whether a finding falls inside what an intent declared, and how sure we are.
 *
 * This is a JUDGEMENT, not a proof, and the shape says so. `confidence` is on the outside of the
 * answer rather than folded into a boolean precisely so that a weak match cannot masquerade as a
 * strong one on its way through a caller.
 *
 * @typedef {object} IntentCoverage
 * @property {boolean} covers          True only at `strong` or `fair`.
 * @property {'strong'|'fair'|'weak'|'none'} confidence
 * @property {string} why              One plain sentence a person can check.
 * @property {string[]} matched        What actually lined up: the named file, the named area.
 */

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

/**
 * Record what an agent set out to do, and what the repository looked like while it said so.
 *
 * Call this BEFORE running a check — ideally before the edits, which is when it is worth most.
 * Sealing a second intent does not hand out a fresh waiver budget; the budget is counted against
 * the reference, in waiver.js, for exactly that reason.
 *
 * @param {Store} store
 * @param {{product: string, summary: string, files?: string[], touches?: string[], expect?: string[], by?: string}} what
 *        `touches` is accepted as another name for `files`, because that is what the MCP tool
 *        already calls it and two names for one idea is cheaper than a breaking rename.
 * @returns {Promise<Intent>}
 */
export async function sealIntent(store, what) {
  const product = clean(what?.product);
  const summary = clean(what?.summary);
  const files = list(what?.files ?? what?.touches);
  const expect = list(what?.expect);

  if (!product) throw new StaysFixedError('An intent has to say which product it is about.');
  if (!summary) {
    throw new StaysFixedError('An intent has to say, in one plain sentence, what you meant to change.', {
      hint: 'Write it the way you would tell a person: "make the basket show the delivery date".',
    });
  }
  if (files.length === 0) {
    throw new StaysFixedError('An intent has to name at least one file, folder or area you expect this change to affect.', {
      hint: 'That is the whole point of sealing one: a difference outside what you named cannot later be waived, so an empty list would leave you able to waive nothing at all.',
    });
  }

  const tree = await fingerprintTree(store.root);
  const relative = orderingOf(tree, files);

  /** @type {Intent} */
  const intent = {
    id: `intent-${crypto.randomBytes(5).toString('hex')}`,
    product,
    summary,
    files,
    expect,
    sealedAt: new Date().toISOString(),
    reference: await referenceStamp(store, product),
    tree,
    sealedRelativeToEdits: relative,
    ordering: sayOrdering(relative, tree),
  };
  const by = clean(what?.by);
  if (by) intent.by = by;

  const file = intentsFile(store, product);
  const kept = (await readIntents(store, product)).filter((i) => i.id !== intent.id);
  kept.push(intent);
  await writeJsonAtomic(file, kept.slice(-KEEP_INTENTS));
  return intent;
}

/**
 * The intent in force for a product: the most recent one sealed.
 *
 * @param {Store} store
 * @param {string} product
 * @returns {Promise<Intent|null>}
 */
export async function readIntent(store, product) {
  const all = await readIntents(store, product);
  return all.length > 0 ? all[all.length - 1] : null;
}

/**
 * One particular intent, so a waiver written months ago can still explain itself.
 *
 * @param {Store} store
 * @param {string} product
 * @param {string} id
 * @returns {Promise<Intent|null>}
 */
export async function readIntentById(store, product, id) {
  const all = await readIntents(store, product);
  return all.find((i) => i.id === id) ?? null;
}

/**
 * Every intent kept for a product, oldest first.
 *
 * @param {Store} store
 * @param {string} product
 * @returns {Promise<Intent[]>}
 */
export async function readIntents(store, product) {
  const raw = await readJsonFile(intentsFile(store, product), []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((i) => i && typeof i === 'object' && typeof i.id === 'string' && typeof i.summary === 'string');
}

/**
 * Forget a product's intents. Housekeeping, and the way a test starts clean.
 *
 * @param {Store} store
 * @param {string} product
 * @returns {Promise<void>}
 */
export async function forgetIntents(store, product) {
  await fsp.rm(intentsFile(store, product), { force: true });
}

// ---------------------------------------------------------------------------
// Does this finding fall inside what was declared?
// ---------------------------------------------------------------------------

/**
 * Does this finding plausibly fall inside what the intent declared?
 *
 * Honest about what it is: a judgement about words, made by comparing what an agent said it was
 * touching with what the engine says a difference points at. It can be fooled by an agent that
 * names a whole folder, and it says so — a wide intent gets `fair` at best, never `strong`.
 *
 * The four grades, and where each line sits:
 *
 *   strong  A file the intent NAMED is one the engine says this finding comes from, or the agent
 *           predicted this exact difference in `expect`. There is nothing left to argue about.
 *   fair    The named area lines up with the addresses, or the finding sits inside code that was
 *           edited and the engine could not tell us which files it came from. Good enough to
 *           waive, because the alternative is refusing the one case the gate exists to allow.
 *   weak    One general word lined up, or the finding sits in code that was edited but in a file
 *           the intent never mentioned. That second case is the one worth being strict about: an
 *           edit the agent made but never declared is exactly a side effect, and waving it
 *           through on the grounds that it is near the edit would empty the gate out.
 *   none    Nothing lined up.
 *
 * @param {Intent|null} intent
 * @param {Finding} finding
 * @returns {IntentCoverage}
 */
export function intentCovers(intent, finding) {
  if (!intent) {
    return { covers: false, confidence: 'none', why: 'Nothing was sealed, so there is nothing to check this against.', matched: [] };
  }

  const near = (finding.nearFiles ?? []).filter((f) => typeof f === 'string').map(lower);
  const addresses = [...(finding.paths ?? []), ...(finding.differences ?? []).map((d) => d.path)].map(lower);
  const prose = [finding.title ?? '', finding.summary ?? '', finding.sample?.path ?? '', ...(finding.differences ?? []).map((d) => d.describe ?? '')]
    .filter((s) => s !== '')
    .map(lower);
  const everything = [...near, ...addresses, ...prose];

  // The strongest signal there is: the agent wrote down the difference it expected, and here it
  // is. Checked first because it needs no file paths at all, so it works on a product where the
  // engine cannot say which source a difference came from.
  for (const line of intent.expect) {
    const words = meaningfulWords(line);
    if (words.length >= 2 && words.every((w) => everything.some((h) => h.includes(w)))) {
      return {
        covers: true,
        confidence: 'strong',
        why: `You said before the run that you expected this: "${trim(line, 120)}".`,
        matched: [line],
      };
    }
  }

  /** @type {string[]} */
  const weakMatches = [];

  for (const raw of intent.files) {
    const needle = normalisePath(raw);
    if (!needle) continue;

    // A named file against the files the engine says this finding comes from. Either direction
    // counts: the intent may name a folder that contains the file, or the exact file itself.
    for (const file of near) {
      if (file === needle || file.startsWith(`${needle}/`) || needle.startsWith(`${file}/`) || file.endsWith(`/${needle}`)) {
        return {
          covers: true,
          confidence: 'strong',
          why: `You said you were changing ${raw}, and this difference comes from ${file}.`,
          matched: [raw, file],
        };
      }
    }

    // The whole name turning up in an address or a title. Weaker, because an address is not a
    // file, but a real match all the same: 'the basket page' inside 'web.basket.page.total'.
    if (everything.some((h) => h.includes(needle))) {
      return {
        covers: true,
        confidence: 'fair',
        why: `You said you were changing ${raw}, and that is named in what changed.`,
        matched: [raw],
      };
    }

    // A file path broken into the parts that carry meaning, so 'src/checkout/total.js' still
    // covers an address the tool reports as 'cli.checkout.total'.
    const words = meaningfulWords(needle);
    const hits = words.filter((w) => everything.some((h) => h.includes(w)));
    if (words.length >= 2 && hits.length === words.length) {
      return {
        covers: true,
        confidence: 'fair',
        why: `You said you were changing ${raw}, and every part of that name appears in what changed.`,
        matched: [raw, ...hits],
      };
    }
    if (hits.length > 0) weakMatches.push(...hits);
  }

  // Inside the edit itself. The engine puts a finding at distance zero when it sits in a file
  // that was just changed. If it also told us WHICH files, and none of them is one the intent
  // named, this is an edit the agent made and never declared — which is the definition of the
  // thing the gate is here to stop, so it stays weak and gets refused.
  if (finding.distance === 0) {
    if (near.length === 0) {
      return {
        covers: true,
        confidence: 'fair',
        why: 'This sits inside code you just edited, and nothing here can say which file it came from, so it is taken as part of the change you declared.',
        matched: [],
      };
    }
    return {
      covers: false,
      confidence: 'weak',
      why: `This sits in code you edited — ${near.slice(0, 3).join(', ')} — but you did not name any of that when you sealed your intent.`,
      matched: weakMatches,
    };
  }

  if (weakMatches.length > 0) {
    return {
      covers: false,
      confidence: 'weak',
      why: `Only the word "${weakMatches[0]}" lines up with what you said you were changing, and one word in common is not a match.`,
      matched: [...new Set(weakMatches)],
    };
  }

  return {
    covers: false,
    confidence: 'none',
    why: `Nothing about this difference matches what you said you were changing: ${intent.files.join(', ')}.`,
    matched: [],
  };
}

// ---------------------------------------------------------------------------
// The working tree
// ---------------------------------------------------------------------------

/**
 * What the repository looks like right now.
 *
 * Everything here is read-only and everything is allowed to fail: Stays Fixed runs in folders
 * that are not repositories, and one that is not simply cannot have its ordering checked. That
 * is a real state, it is reported in those words, and it is never dressed up as a fingerprint
 * that proves something.
 *
 * @param {string} root
 * @returns {Promise<TreeFingerprint>}
 */
export async function fingerprintTree(root) {
  const at = new Date().toISOString();
  const head = await git(['rev-parse', 'HEAD'], root);
  if (head === null) {
    return {
      how: 'none',
      head: null,
      branch: null,
      dirty: false,
      changedFiles: [],
      digest: 'no-repository',
      at,
      note: 'This folder is not a git repository, so nothing here can show what was edited when. The order an intent was sealed in rests on the clock alone.',
    };
  }

  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const status = (await git(['status', '--porcelain'], root)) ?? '';
  const changedFiles = filesFromStatus(status);
  // The diff itself is hashed rather than kept. Two moments only ever need to be compared, and
  // keeping the text would put a copy of the working tree in a file people commit by accident.
  const diff = (await git(['diff', 'HEAD'], root)) ?? '';
  const digest = shortDigest([head, status, diff]);

  return {
    how: 'git',
    head,
    branch: branch === 'HEAD' ? null : branch,
    dirty: changedFiles.length > 0,
    changedFiles,
    digest,
    at,
    note:
      changedFiles.length === 0
        ? `Nothing was edited at this point: a clean tree on ${head.slice(0, 7)}.`
        : `${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'} already edited on top of ${head.slice(0, 7)}.`,
  };
}

/**
 * Has the working tree moved since this intent was sealed?
 *
 * @param {Intent} intent
 * @param {TreeFingerprint} now
 * @returns {{moved: boolean, knowable: boolean, say: string}}
 */
export function treeMovedSince(intent, now) {
  if (intent.tree.how !== 'git' || now.how !== 'git') {
    return {
      moved: false,
      knowable: false,
      say: 'There is no repository here, so whether the code moved after you sealed your intent cannot be checked.',
    };
  }
  if (intent.tree.digest === now.digest) {
    return {
      moved: false,
      knowable: true,
      say: 'The code has not changed since you sealed this intent, so it describes exactly the build that was checked.',
    };
  }
  return {
    moved: true,
    knowable: true,
    say: 'The code changed after you sealed this intent, which is what an intent sealed before the work looks like.',
  };
}

/**
 * Was this intent written before the work or after it?
 *
 * Read from the files it names: if one of them was already modified when the intent was sealed,
 * the intent was written on top of work that was already done. That is allowed — the design says
 * an agent may seal one right before or right after it edits — but it is a weaker claim and it
 * is recorded as one rather than quietly treated the same.
 *
 * @param {TreeFingerprint} tree
 * @param {string[]} files
 * @returns {'before-the-edits'|'after-the-edits'|'unknown'}
 */
function orderingOf(tree, files) {
  if (tree.how !== 'git') return 'unknown';
  const named = files.map(normalisePath).filter((f) => f.includes('/') || /\.[a-z0-9]+$/i.test(f));
  if (named.length === 0) return 'unknown'; // Only areas were named, so no file to look for.
  const changed = tree.changedFiles.map(lower);
  const alreadyEdited = named.some((n) => changed.some((c) => c === n || c.startsWith(`${n}/`) || c.endsWith(`/${n}`)));
  return alreadyEdited ? 'after-the-edits' : 'before-the-edits';
}

/**
 * @param {'before-the-edits'|'after-the-edits'|'unknown'} relative
 * @param {TreeFingerprint} tree
 * @returns {string}
 */
function sayOrdering(relative, tree) {
  if (relative === 'before-the-edits') {
    return 'Sealed before the files it names were touched, so it says what you were about to do rather than what you had already done.';
  }
  if (relative === 'after-the-edits') {
    return 'Sealed after the work was already in the working tree. That is allowed, but it is a weaker claim: you could already see the change while you wrote it.';
  }
  return tree.how === 'git'
    ? 'This intent names areas rather than files, so whether it was written before or after the work cannot be checked.'
    : 'There is no repository here, so whether this was written before or after the work cannot be checked.';
}

/**
 * @param {string} status  Output of `git status --porcelain`.
 * @returns {string[]}
 */
function filesFromStatus(status) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const line of status.split('\n')) {
    if (line.trim() === '') continue;
    const body = line.slice(3).trim();
    // A rename is written 'old -> new'. Both halves count as touched.
    for (const part of body.split(' -> ')) {
      const file = part.replace(/^"|"$/g, '').trim();
      if (file) out.add(file);
    }
  }
  return [...out].sort();
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function git(args, cwd) {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
    return stdout.trimEnd();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The bookkeeping this lane shares
// ---------------------------------------------------------------------------

/**
 * Where intents and waivers live: beside the engine's observations, not inside them.
 *
 * @param {Store} store
 * @returns {string}
 */
export function stateDir(store) {
  return store.dir;
}

/**
 * @param {Store} store
 * @param {string} product
 * @returns {string}
 */
export function intentsFile(store, product) {
  return path.join(store.dir, 'intents', `${safeName(product)}.json`);
}

/**
 * Which reference is in force for this product, as one short string.
 *
 * A waiver dies when this moves, so it has to change whenever the answer to "what counts as
 * working" changes — and only then. It is taken from the product's own pointer, so shipping one
 * product does not retire waivers written about another; the buildId AND the time it was set are
 * both in it, so re-pointing at the same build after a rethink still counts as a move.
 *
 * @param {Store} store
 * @param {string} product
 * @returns {Promise<string>}
 */
export async function referenceStamp(store, product) {
  const pointer = await referencePointer(store, product).catch(() => null);
  // Nothing has ever shipped with the hook in place. That is the cold start, it is expected on
  // any existing product, and it is a real state rather than an error — but a waiver written now
  // must not survive the day the first reference is cut, so it gets a stamp of its own.
  if (!pointer) return 'no-reference-yet';
  return `ref-${shortDigest([pointer.buildId, pointer.setAt])}`;
}

/**
 * @param {string} file
 * @param {any} fallback
 * @returns {Promise<any>}
 */
export async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    // Not there, or hand-edited into nonsense. Either way start clean rather than refuse to run:
    // losing a waiver is safe — it means a person looks at something — and refusing to check is
    // not.
    return fallback;
  }
}

/**
 * Write so nobody can ever read it half-finished.
 *
 * @param {string} file
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await fsp.rename(temp, file);
}

/**
 * @param {unknown[]} parts
 * @returns {string}
 */
export function shortDigest(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {string}
 */
function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function list(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => clean(v)).filter((v) => v !== '');
}

/**
 * @param {string} value
 * @returns {string}
 */
function lower(value) {
  return String(value).toLowerCase();
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalisePath(value) {
  return lower(value).trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * The parts of a name that carry meaning — long enough, and not a word every project uses.
 *
 * @param {string} value
 * @returns {string[]}
 */
function meaningfulWords(value) {
  return [...new Set(lower(value).split(/[^a-z0-9]+/))].filter((w) => w.length > 2 && !GENERIC_WORDS.has(w));
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function trim(text, max) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
