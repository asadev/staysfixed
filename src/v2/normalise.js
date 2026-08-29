/**
 * Normalisation — turning a raw value into a comparable one.
 *
 * This is the craft of the whole tool. Every product disagrees with itself about things that
 * do not matter: the clock, an id, a port, where the temp folder went today. Left alone, a
 * version bump in a footer reports five hundred differences and the agent reading them learns
 * nothing. Normalised too hard, a real break disappears and the tool goes quiet — which is
 * worse, because a quiet difference machine is indistinguishable from a working one.
 *
 * So the rules are DATA. They live in git next to the project's config, they are reviewed like
 * any other change, and every one of them carries `wouldHide` in plain English: the real
 * change this rule would wrongly cover up. Read that field before switching a rule on.
 *
 * And every normalisation is auditable. `explain()` returns exactly what was replaced, where,
 * by which rule, and what that rule admits it might be hiding. A difference the tool decided
 * not to show has to be answerable for.
 */

import fsp from 'node:fs/promises';
import { sha256 } from '../core/hash.js';
import { StaysFixedError } from '../core/errors.js';
import { canonicalJson, matchPath } from './observation.js';

/**
 * @typedef {import('./types.js').NormaliseRule} NormaliseRule
 * @typedef {import('./types.js').ObservedValue} ObservedValue
 * @typedef {import('./types.js').Observation} Observation
 * @typedef {import('./types.js').Capture} Capture
 * @typedef {import('./types.js').Channel} Channel
 * @typedef {import('./types.js').Replacement} Replacement
 * @typedef {import('./types.js').Explanation} Explanation
 */

/** Where in a value we are, when a rule needs to say. */
const ROOT = '$';

/** Sentinel for a value a `drop` rule removed. Never appears in a result. */
const DROPPED = Symbol('dropped');

// ---------------------------------------------------------------------------
// The default rules
// ---------------------------------------------------------------------------

/**
 * On by default.
 *
 * The posture: aggressive about clocks and ids, which are pure churn and never carry meaning
 * on their own; conservative about everything that could plausibly be the thing that broke.
 * Where a rule has a real cost, it says so in `wouldHide` and the fix is always the same —
 * scope it with `paths` rather than switching it off everywhere.
 *
 * @type {NormaliseRule[]}
 */
export const DEFAULT_RULES = [
  {
    id: 'clock.iso',
    kind: 'replace',
    what: 'Dates and times written the standard way, like 2026-08-29T04:11:07.412Z.',
    why: 'A clock reading is different every run by definition. Left in, every log line and every record carrying a created-at time reports as changed.',
    wouldHide: 'A date the product shows on purpose — a booking date, a due date, a birthday. If dates are part of what your product says, scope this rule to the paths where they are only timestamps.',
    pattern: '\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:?\\d{2})?',
    with: '<time>',
  },
  {
    id: 'clock.epoch-ms',
    kind: 'replace',
    what: 'Millisecond timestamps — thirteen-digit numbers from about 2022 to 2033.',
    why: 'The same clock reading in its other common form. Appears in ids, filenames and JSON bodies.',
    wouldHide: 'Any genuine number that happens to be thirteen digits starting 16 to 19 — a large account number, or an amount held in the smallest currency unit. Money paths should exempt this rule.',
    pattern: '\\b1[6-9]\\d{11}\\b',
    with: '<time>',
    numbers: true,
  },
  {
    id: 'clock.duration',
    kind: 'replace',
    what: 'Durations printed next to their unit: 412ms, 1.2s, 900us.',
    why: 'How long something took is different every run, and almost every CLI prints it.',
    wouldHide: 'A duration the product deliberately shows and that ought to be fixed — a 30s timeout in a settings screen, a 14 day trial. Scope it away from those screens.',
    pattern: '\\b\\d+(?:\\.\\d+)?\\s?(?:ms|us|\\u00b5s|ns)\\b|\\b\\d+(?:\\.\\d+)?s\\b',
    with: '<duration>',
  },
  {
    id: 'mem.address',
    kind: 'replace',
    what: 'Memory addresses — 0x followed by eight or more hex digits.',
    why: 'Handed out by the operating system, different every launch, and they leak into crash dumps and object descriptions.',
    wouldHide: 'A long hex constant the product prints on purpose. Eight digits is the floor precisely so that shorter constants, including colours, are left alone.',
    pattern: '0x[0-9a-fA-F]{8,}',
    with: '<address>',
  },
  {
    id: 'id.uuid',
    kind: 'replace',
    what: 'UUIDs, in the usual 8-4-4-4-12 shape.',
    why: 'Freshly minted on every run. One of them in a response body makes the whole body differ.',
    wouldHide: 'A UUID written into a fixture on purpose, where the point of the check is that this exact id came back. Those are rare, and worth naming explicitly with a scoped exemption.',
    pattern: '\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\b',
    with: '<uuid>',
  },
  {
    id: 'id.hex',
    kind: 'replace',
    what: 'Runs of 16 to 31 hex characters — request ids, session ids, short handles.',
    why: 'Minted per run, like a UUID but without the dashes to recognise it by.',
    wouldHide: 'A hex value that is meant to be stable and is in that length range. The 32-and-longer case is deliberately NOT covered here, because those are usually content hashes and a content hash changing is exactly the signal we want — see the optional rule id.hex-long.',
    pattern: '\\b[0-9a-fA-F]{16,31}\\b',
    with: '<hex>',
  },
  {
    id: 'id.pid',
    kind: 'replace',
    what: 'Process ids, where they are labelled as such.',
    why: 'Different every launch, and printed by anything that spawns a child process.',
    wouldHide: 'Almost nothing. The label has to be there, so a bare number is never touched.',
    pattern: '\\b(pid|PID)\\s*[=:]?\\s*\\d+\\b',
    with: '$1 <pid>',
  },
  {
    id: 'net.port',
    kind: 'replace',
    what: 'Port numbers on a local address — localhost:53412, 127.0.0.1:8931.',
    why: 'Test servers and debug ports are picked free at launch, so they differ every run.',
    wouldHide: 'A port the product is supposed to bind to and prints on purpose. If serving on a fixed port is part of the promise, check it on its own path and exempt that path here.',
    pattern: '(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]):\\d{2,5}',
    with: '$1:<port>',
  },
  {
    id: 'path.temp',
    kind: 'replace',
    what: 'Temporary folders on Mac, Linux and Windows.',
    why: 'A fresh temp folder every run, with a random name in the middle of it.',
    wouldHide: 'The file NAME inside the temp folder, which this replaces along with the folder. If a check is about which file got written, observe the basename on its own path.',
    pattern: '(?:/private)?/var/folders/[^\\s"\'`]*|/tmp/[^\\s"\'`]*|[A-Za-z]:\\\\Users\\\\[^\\\\]+\\\\AppData\\\\Local\\\\Temp[^\\s"\'`]*',
    with: '<temp>',
  },
  {
    id: 'path.home',
    kind: 'replace',
    what: 'The home folder of whoever is running it.',
    why: 'Absolute paths differ between machines and between users, and the same run on his laptop and on the office box would otherwise disagree about everything.',
    wouldHide: 'The username itself, where the product shows it on purpose. It also makes two different users look like the same user, so a permissions bug that only appears for one of them would not show.',
    pattern: '/Users/[^/\\s"\'`]+|/home/[^/\\s"\'`]+|[A-Za-z]:\\\\Users\\\\[^\\\\\\s"\'`]+',
    with: '<home>',
  },
  {
    id: 'token.bearer',
    kind: 'replace',
    what: 'Bearer tokens in an authorization header or a log line.',
    why: 'Reissued on every sign-in, so they never match twice.',
    wouldHide: 'Whether the token changed — which for a sign-in flow can be the very thing worth seeing. It is acceptable here only because signing in is a sealed class: a difference in it goes to a person on other evidence, not on the token string.',
    pattern: '(Bearer|bearer)\\s+[A-Za-z0-9\\-._~+/]+=*',
    with: '$1 <token>',
  },
  {
    id: 'token.jwt',
    kind: 'replace',
    what: 'JSON web tokens — the three dot-separated blocks starting eyJ.',
    why: 'Signed with a timestamp inside, so a fresh one every time even for the same user.',
    wouldHide: 'A change in what the token CLAIMS, which is real and which this erases. If a product decides anything from a token body, decode it and observe the claims on their own paths.',
    pattern: 'eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*',
    with: '<jwt>',
  },
  {
    id: 'text.ansi',
    kind: 'replace',
    what: 'Terminal colour codes.',
    why: 'They surround almost every line a modern CLI prints, and they change when a library bumps, not when behaviour does.',
    wouldHide: 'A colour change. If colour IS the output — a diff tool, a linter, a test runner showing red and green — switch this off, because then colour is behaviour.',
    pattern: '\\u001b\\[[0-9;]*[A-Za-z]',
    with: '',
  },
  {
    id: 'text.crlf',
    kind: 'replace',
    what: 'Windows line endings.',
    why: 'The same product printing the same words disagrees with itself across operating systems otherwise.',
    wouldHide: 'A genuine line-ending change, which matters for a tool that WRITES files for other software to read. Products that promise a file format should check the raw bytes on their own path.',
    pattern: '\\r\\n',
    with: '\n',
  },
  {
    id: 'text.trailing-space',
    kind: 'replace',
    what: 'Spaces and tabs at the end of a line.',
    why: 'Invisible, and they move when a formatter runs.',
    wouldHide: 'Trailing whitespace changes, which nobody has ever needed to know about.',
    pattern: '[ \\t]+$',
    flags: 'gm',
    with: '',
  },
  {
    id: 'number.float',
    kind: 'round',
    what: 'Floating point numbers, cut to twelve significant digits.',
    why: 'The same arithmetic in a different order gives 0.30000000000000004 instead of 0.3, and that is a fact about binary floats, not about the product.',
    wouldHide: 'A genuine change smaller than one part in a trillion. Whole numbers are never touched, so ids and counts are safe.',
    digits: 12,
  },
];

/**
 * Shipped, documented, and NOT switched on. Each says why not.
 *
 * They are here rather than in a wiki because the rule a project needs is usually one of
 * these with a `paths` scope added, and it should be copyable rather than inventable.
 *
 * @type {NormaliseRule[]}
 */
export const OPTIONAL_RULES = [
  {
    id: 'id.hex-long',
    kind: 'replace',
    what: 'Hex runs of 32 characters or more — MD5, SHA-1, SHA-256, content hashes.',
    why: 'Build systems print them constantly and they change whenever anything upstream does.',
    wouldHide: 'A content hash changing, which is very often the exact thing you want to be told about — a bundle whose contents moved, a lockfile that resolved differently.',
    pattern: '\\b[0-9a-fA-F]{32,}\\b',
    with: '<hash>',
    off: true,
    whyOff: 'A changed hash is usually a finding, not noise. Switch it on scoped to the paths where you know the hash is a cache key and nothing more.',
  },
  {
    id: 'version.semver',
    kind: 'replace',
    what: 'Version numbers like 1.4.2.',
    why: 'This is the footer case: bump the version and every screen carrying it reports as changed. One rule turns five hundred differences into zero.',
    wouldHide: 'A dependency silently downgrading, a version pin that stopped being honoured, the wrong build being tested. All real, all serious.',
    pattern: '\\bv?\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?\\b',
    with: '<version>',
    off: true,
    whyOff: 'Never switch this on globally. Scope it to the footer, the about screen, the header — the places where the version is decoration. Leave it off everywhere the version is a fact.',
    paths: ['screen.**.footer.**'],
  },
  {
    id: 'keys.uuid',
    kind: 'replace',
    what: 'UUIDs used as object KEYS, not just values.',
    why: 'A response keyed by record id differs entirely between runs even when every record is identical.',
    wouldHide: 'Two entries collapsing into one, because normalising two different keys to the same text merges them and only the first survives. That silently deletes a record from the comparison.',
    pattern: '\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\b',
    with: '<uuid>',
    keys: true,
    off: true,
    whyOff: 'The collision risk is real and silent. Prefer sorting the collection and observing its members by position, which loses nothing.',
  },
  {
    id: 'stack.frames',
    kind: 'replace',
    what: 'File and line numbers inside stack traces.',
    why: 'Every unrelated edit above a throw moves the line number, and internal frames churn with the Node version.',
    wouldHide: 'Where the error came from — which is most of what a stack trace is for, and often the fastest way to see that a failure moved to a different cause.',
    pattern: '\\(([^()\\s]+):\\d+:\\d+\\)',
    with: '($1:<line>:<col>)',
    off: true,
    whyOff: 'Prefer observing the error MESSAGE and the top frame on their own paths. Blurring the frames throws away the answer along with the noise.',
  },
];

/**
 * A version stamp for the shipped set. Bump it when the defaults change, so a stored capture
 * normalised under the old rules is not silently compared against one normalised under the new
 * ones — see `rulesFingerprint`, which is the mechanism that actually catches it.
 */
export const RULES_VERSION = 1;

// ---------------------------------------------------------------------------
// Rules as data: validating, merging, loading, describing
// ---------------------------------------------------------------------------

/**
 * @param {unknown} rule
 * @returns {string|null} the reason it is unusable, or null
 */
export function ruleProblem(rule) {
  if (typeof rule !== 'object' || rule === null) return 'a rule must be an object';
  const r = /** @type {Partial<NormaliseRule>} */ (rule);
  if (!r.id) return 'a rule needs an id';
  if (!r.kind) return `rule ${r.id} needs a kind (replace, round, sort or drop)`;
  if (!['replace', 'round', 'sort', 'drop'].includes(r.kind)) return `rule ${r.id} has an unknown kind "${r.kind}"`;
  if (!r.what || !r.why || !r.wouldHide) {
    return `rule ${r.id} is missing what/why/wouldHide — a rule nobody can audit is how a difference machine goes quiet`;
  }
  if (r.kind === 'replace') {
    if (typeof r.pattern !== 'string' || r.pattern.length === 0) return `rule ${r.id} needs a pattern`;
    if (typeof r.with !== 'string') return `rule ${r.id} needs a replacement (use "" to remove)`;
    try {
      new RegExp(r.pattern, r.flags ?? 'g');
    } catch (e) {
      return `rule ${r.id} has a pattern JavaScript cannot read: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (r.kind === 'round' && (typeof r.digits !== 'number' || r.digits < 1 || r.digits > 21)) {
    return `rule ${r.id} needs digits between 1 and 21`;
  }
  if (r.kind === 'drop' && (!r.at || r.at.length === 0)) {
    return `rule ${r.id} drops part of a value, so it must say exactly where with "at"`;
  }
  return null;
}

/**
 * @param {NormaliseRule[]} rules
 * @returns {NormaliseRule[]} the same rules, once every one of them is usable
 */
export function assertRules(rules) {
  for (const rule of rules) {
    const problem = ruleProblem(rule);
    if (problem) {
      throw new StaysFixedError(`Bad normalisation rule: ${problem}.`, {
        hint: 'Rules are data. Fix it where it is written down, not in code.',
      });
    }
  }
  return rules;
}

/**
 * Merge a project's rules over the shipped ones.
 *
 * Same id wins, so a project turns a default off by writing `{id, off: true}` and narrows one
 * by writing `{id, paths: [...]}` — no need to restate a rule to change one field of it.
 *
 * @param {NormaliseRule[]} base
 * @param {NormaliseRule[]} extra
 * @returns {NormaliseRule[]}
 */
export function mergeRules(base, extra) {
  /** @type {Map<string, NormaliseRule>} */
  const byId = new Map();
  for (const rule of base) byId.set(rule.id, rule);
  for (const rule of extra) {
    const existing = byId.get(rule.id);
    byId.set(rule.id, existing ? { ...existing, ...rule } : rule);
  }
  return [...byId.values()];
}

/**
 * The rules that are actually switched on.
 * @param {NormaliseRule[]} rules
 * @returns {NormaliseRule[]}
 */
export function activeRules(rules) {
  return rules.filter((r) => !r.off);
}

/**
 * A short fingerprint of a rule set.
 *
 * Stored on every capture. Comparing a capture normalised under one set of rules against one
 * normalised under another is meaningless — the differences you see are the rules changing,
 * not the product — and this is what lets the run notice and say so.
 *
 * @param {NormaliseRule[]} rules
 * @returns {string}
 */
export function rulesFingerprint(rules) {
  const active = activeRules(rules)
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      pattern: r.pattern ?? '',
      flags: r.flags ?? '',
      with: r.with ?? '',
      digits: r.digits ?? 0,
      keys: r.keys ?? false,
      numbers: r.numbers ?? false,
      paths: [...(r.paths ?? [])].sort(),
      channels: [...(r.channels ?? [])].sort(),
      at: [...(r.at ?? [])].sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return `v${RULES_VERSION}-${sha256(JSON.stringify(active)).slice(0, 12)}`;
}

/**
 * The rule set in plain English, for `doctor` and for any agent asking the tool what it does.
 * Says both what is on and what is deliberately off, because the second list is the more
 * useful one when a run reports nothing.
 *
 * @param {NormaliseRule[]} rules
 * @returns {{on: {id: string, what: string, wouldHide: string, scopedTo?: string[]}[], off: {id: string, what: string, whyOff: string}[]}}
 */
export function describeRules(rules) {
  return {
    on: rules
      .filter((r) => !r.off)
      .map((r) => (r.paths ? { id: r.id, what: r.what, wouldHide: r.wouldHide, scopedTo: r.paths } : { id: r.id, what: r.what, wouldHide: r.wouldHide })),
    off: rules
      .filter((r) => r.off)
      .map((r) => ({ id: r.id, what: r.what, whyOff: r.whyOff ?? 'no reason recorded' })),
  };
}

/**
 * Rules for the absolute paths of THIS machine.
 *
 * The shipped rules cover the shapes that are the same everywhere. A checkout folder is not
 * one of those, and it turns up inside stack traces, error messages and every file the product
 * writes — so it gets its own literal rules, generated where the tool is running rather than
 * guessed by a pattern that would over-match.
 *
 * @param {{root?: string, home?: string, tmp?: string}} where
 * @returns {NormaliseRule[]}
 */
export function machineRules(where) {
  /** @type {NormaliseRule[]} */
  const rules = [];
  /**
   * @param {string} s
   * @returns {string}
   */
  const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (where.root) {
    rules.push({
      id: 'path.project-root',
      kind: 'replace',
      what: 'The folder this project is checked out in.',
      why: 'It differs between his laptop, the office box and anyone else who clones the repo, and it appears in every stack trace and every written file path.',
      wouldHide: 'Nothing about the product. It only ever replaces a prefix that is a fact about the machine.',
      pattern: literal(where.root),
      with: '<project>',
    });
  }
  if (where.home) {
    rules.push({
      id: 'path.this-home',
      kind: 'replace',
      what: 'The home folder of the account running the tool.',
      why: 'Same reason as the project root, one level up.',
      wouldHide: 'The username, where a product shows it deliberately.',
      pattern: literal(where.home),
      with: '<home>',
    });
  }
  if (where.tmp) {
    rules.push({
      id: 'path.this-tmp',
      kind: 'replace',
      what: 'The temp folder this machine hands out.',
      why: 'Mac gives a per-boot random one under /var/folders that the general pattern only partly covers.',
      wouldHide: 'Nothing the product decides.',
      pattern: literal(where.tmp),
      with: '<temp>',
    });
  }
  return rules;
}

/**
 * Read a project's own rules from a JSON file. Missing file means no extra rules, which is the
 * normal case and not an error.
 *
 * @param {string} file
 * @returns {Promise<NormaliseRule[]>}
 */
export async function loadRules(file) {
  /** @type {string} */
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return [];
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new StaysFixedError(`Could not read the normalisation rules in ${file}: ${e instanceof Error ? e.message : String(e)}`, {
      hint: 'The file holds a JSON array of rules, or an object with a "rules" array.',
    });
  }
  const list = Array.isArray(parsed)
    ? parsed
    : /** @type {{rules?: unknown}} */ (parsed)?.rules;
  if (!Array.isArray(list)) {
    throw new StaysFixedError(`${file} does not contain a list of normalisation rules.`);
  }
  return assertRules(/** @type {NormaliseRule[]} */ (list));
}

// ---------------------------------------------------------------------------
// Applying the rules
// ---------------------------------------------------------------------------

/** Compiled regexes, keyed by source and flags. Building one per value would dominate the run. */
/** @type {Map<string, RegExp>} */
const rxCache = new Map();

/**
 * @param {string} pattern
 * @param {string} flags
 * @returns {RegExp}
 */
function regexFor(pattern, flags) {
  const key = `${flags} ${pattern}`;
  let rx = rxCache.get(key);
  if (!rx) {
    rx = new RegExp(pattern, flags);
    rxCache.set(key, rx);
  }
  // Shared instances with /g carry lastIndex between calls, and `replace` resets it — but
  // `test` does not, so nothing here may use `test` on a cached global regex.
  return rx;
}

/**
 * Does this rule apply to the observation we are normalising?
 *
 * A rule scoped by path or channel is SKIPPED when we do not know the path or channel, rather
 * than applied. A rule that says "only in api responses" must not fire on something we cannot
 * confirm is one.
 *
 * @param {NormaliseRule} rule
 * @param {{path?: string, channel?: Channel}} where
 * @returns {boolean}
 */
function ruleApplies(rule, where) {
  if (rule.off) return false;
  if (rule.channels && rule.channels.length > 0) {
    if (!where.channel || !rule.channels.includes(where.channel)) return false;
  }
  if (rule.paths && rule.paths.length > 0) {
    if (!where.path) return false;
    if (!rule.paths.some((glob) => matchPath(/** @type {string} */ (where.path), glob))) return false;
  }
  return true;
}

/**
 * @param {NormaliseRule} rule
 * @param {string} at
 * @returns {boolean}
 */
function ruleAppliesAt(rule, at) {
  if (!rule.at || rule.at.length === 0) return true;
  return rule.at.some((glob) => matchPath(at, glob));
}

/**
 * Turn a raw value into a canonical one.
 *
 * @param {ObservedValue} value
 * @param {NormaliseRule[]} rules
 * @param {{path?: string, channel?: Channel}} [where]   The observation this value belongs to,
 *                                                       so scoped rules know whether to fire.
 * @returns {ObservedValue}
 */
export function normalise(value, rules, where = {}) {
  const applicable = rules.filter((r) => ruleApplies(r, where));
  const out = walk(value, ROOT, applicable, null, 0);
  return out === DROPPED ? null : out;
}

/**
 * The same work, with a receipt.
 *
 * A difference hidden by normalisation has to be auditable, so this returns every replacement
 * that was made, where it was made, and what the rule that made it admits it might be hiding.
 * Used by the report, and by anyone asking "why did this run say nothing changed".
 *
 * @param {ObservedValue} value
 * @param {NormaliseRule[]} rules
 * @param {{path?: string, channel?: Channel}} [where]
 * @returns {Explanation}
 */
export function explain(value, rules, where = {}) {
  const applicable = rules.filter((r) => ruleApplies(r, where));
  /** @type {Replacement[]} */
  const replacements = [];
  const out = walk(value, ROOT, applicable, replacements, 0);
  return {
    value: out === DROPPED ? null : out,
    replacements,
    summary: summarise(replacements),
  };
}

/**
 * @param {Replacement[]} replacements
 * @returns {string}
 */
function summarise(replacements) {
  if (replacements.length === 0) return 'Nothing was rewritten before comparing.';
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const r of replacements) counts.set(r.ruleId, (counts.get(r.ruleId) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${id} (${n})`);
  return `Rewritten before comparing by ${parts.join(', ')}. Anything those rules cover is not being watched here.`;
}

/**
 * Normalise one observation, carrying its path and channel so scoped rules fire correctly.
 * @param {Observation} observation
 * @param {NormaliseRule[]} rules
 * @returns {Observation}
 */
export function normaliseObservation(observation, rules) {
  const value = normalise(observation.value, rules, { path: observation.path, channel: observation.channel });
  return { ...observation, value };
}

/**
 * Normalise a whole capture and stamp it with the rule set that was used.
 *
 * The stamp is not decoration: comparing captures normalised under different rules produces
 * differences that are about the rules, and the run has to be able to notice that.
 *
 * @param {Capture} capture
 * @param {NormaliseRule[]} rules
 * @returns {Capture}
 */
export function normaliseCapture(capture, rules) {
  return {
    ...capture,
    observations: capture.observations.map((o) => normaliseObservation(o, rules)),
    rules: rulesFingerprint(rules),
  };
}

/**
 * The recursive worker. Returns the rewritten node, or DROPPED.
 *
 * @param {ObservedValue} node
 * @param {string} at                        Position inside the value: '$', '$.items.3.id'.
 * @param {NormaliseRule[]} rules
 * @param {Replacement[]|null} record        Non-null when we are explaining rather than just doing.
 * @param {number} depth
 * @returns {ObservedValue|typeof DROPPED}
 */
function walk(node, at, rules, record, depth) {
  if (depth > 64) return node;

  for (const rule of rules) {
    if (rule.kind === 'drop' && ruleAppliesAt(rule, at)) {
      if (record) {
        record.push(receipt(rule, at, canonicalJson(node), '<dropped>'));
      }
      return DROPPED;
    }
  }

  if (typeof node === 'string') return rewriteString(node, at, rules, record);
  if (typeof node === 'number') return rewriteNumber(node, at, rules, record);
  if (node === null || typeof node === 'boolean') return node;

  if (Array.isArray(node)) {
    /** @type {ObservedValue[]} */
    const items = [];
    for (let i = 0; i < node.length; i++) {
      const child = walk(node[i], `${at}.${i}`, rules, record, depth + 1);
      if (child !== DROPPED) items.push(child);
    }
    for (const rule of rules) {
      if (rule.kind !== 'sort' || !ruleAppliesAt(rule, at)) continue;
      const before = record ? canonicalJson(items) : '';
      items.sort((a, b) => {
        const ja = canonicalJson(a);
        const jb = canonicalJson(b);
        return ja < jb ? -1 : ja > jb ? 1 : 0;
      });
      if (record) {
        const after = canonicalJson(items);
        if (before !== after) record.push(receipt(rule, at, before, after));
      }
    }
    return items;
  }

  /** @type {Record<string, ObservedValue>} */
  const out = {};
  for (const [key, child] of Object.entries(node)) {
    const newKey = rewriteKey(key, at, rules, record);
    const value = walk(/** @type {ObservedValue} */ (child), `${at}.${key}`, rules, record, depth + 1);
    if (value === DROPPED) continue;
    // First key wins on a collision. Losing an entry silently is exactly why `keys` is off by
    // default; when a project switches it on anyway, the loss is at least deterministic.
    if (!(newKey in out)) out[newKey] = value;
  }
  return out;
}

/**
 * @param {string} key
 * @param {string} at
 * @param {NormaliseRule[]} rules
 * @param {Replacement[]|null} record
 * @returns {string}
 */
function rewriteKey(key, at, rules, record) {
  let text = key;
  for (const rule of rules) {
    if (rule.kind !== 'replace' || !rule.keys) continue;
    const next = text.replace(regexFor(/** @type {string} */ (rule.pattern), rule.flags ?? 'g'), rule.with ?? '');
    if (next !== text) {
      if (record) record.push(receipt(rule, `${at}.${key} (key)`, text, next));
      text = next;
    }
  }
  return text;
}

/**
 * @param {string} value
 * @param {string} at
 * @param {NormaliseRule[]} rules
 * @param {Replacement[]|null} record
 * @returns {string}
 */
function rewriteString(value, at, rules, record) {
  let text = value;
  for (const rule of rules) {
    if (rule.kind !== 'replace' || !ruleAppliesAt(rule, at)) continue;
    const next = text.replace(regexFor(/** @type {string} */ (rule.pattern), rule.flags ?? 'g'), rule.with ?? '');
    if (next !== text) {
      if (record) record.push(receipt(rule, at, text, next));
      text = next;
    }
  }
  return text;
}

/**
 * @param {number} value
 * @param {string} at
 * @param {NormaliseRule[]} rules
 * @param {Replacement[]|null} record
 * @returns {ObservedValue}
 */
function rewriteNumber(value, at, rules, record) {
  for (const rule of rules) {
    if (rule.kind !== 'replace' || !rule.numbers || !ruleAppliesAt(rule, at)) continue;
    const text = String(value);
    const next = text.replace(regexFor(/** @type {string} */ (rule.pattern), rule.flags ?? 'g'), rule.with ?? '');
    if (next !== text) {
      if (record) record.push(receipt(rule, at, text, next));
      return next;
    }
  }
  for (const rule of rules) {
    if (rule.kind !== 'round' || !ruleAppliesAt(rule, at)) continue;
    // Whole numbers are left alone on purpose. toPrecision on a large integer would turn it
    // into a rounded float, and ids and counts are integers.
    if (Number.isInteger(value) || !Number.isFinite(value)) continue;
    const rounded = Number(value.toPrecision(rule.digits ?? 12));
    if (rounded !== value) {
      if (record) record.push(receipt(rule, at, String(value), String(rounded)));
      return rounded;
    }
  }
  return value;
}

/**
 * @param {NormaliseRule} rule
 * @param {string} at
 * @param {string} before
 * @param {string} after
 * @returns {Replacement}
 */
function receipt(rule, at, before, after) {
  return {
    ruleId: rule.id,
    what: rule.what,
    why: rule.why,
    wouldHide: rule.wouldHide,
    at,
    before: clip(before),
    after: clip(after),
  };
}

/**
 * Receipts are for reading. A megabyte of stdout in one is nobody's idea of an explanation.
 * @param {string} s
 * @returns {string}
 */
function clip(s) {
  return s.length <= 300 ? s : `${s.slice(0, 300)}… (${s.length} characters)`;
}
