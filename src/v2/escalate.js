/**
 * What reaches a person, and nothing else.
 *
 * The word "approve" was hiding four separate decisions, and version 2 splits them:
 *
 *   1. WHAT COUNTS AS WORKING — Asad, and only Asad, and never by opening this tool. It is cut
 *      by an act he already performs: saying ship. That is `cutReference` in reference.js,
 *      called from `onShip` in ship.js, and no agent can reach either.
 *   2. IS THIS DIFFERENCE REAL OR IS IT NOISE — the machine, arithmetically, from running the
 *      new build twice. Nobody's opinion. That is `subtractWobble` in run.js.
 *   3. DID MY OWN EDIT CAUSE THIS — the agent, and it PROVES the claim by reverting the suspect
 *      hunk and re-running rather than asserting it. That is cause.js.
 *   4. IS AN UNINTENDED DIFFERENCE ACCEPTABLE ANYWAY — a person. THIS FILE.
 *
 * So this module does two jobs and refuses the rest.
 *
 * It hands `check.js` the arithmetic of the decision record: which findings are already
 * accounted for by a live waiver, which are sealed and can never be accounted for by any
 * agent at all, and the counts that make the resulting silence legible. A waiver applied
 * without being counted out loud is how a rubber stamp starts, so the count travels on the
 * verdict itself and is never optional.
 *
 * And it writes the escalation block: the handful of items a month that genuinely need a
 * person, three sentences each, in a shape a closing session summary can paste in whole. NOT
 * a report. NOT a dashboard. NOT a link to somewhere he has to go and look. He reads one
 * closing summary at the end of a working stretch, so anything not inside it did not happen.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT OWN. Classifying a difference as sealed belongs to
 * sealed.js; sealing an intent and judging what it covers belongs to intent.js; moving the
 * reference and retiring waivers belongs to reference.js and ship.js. Every one of those is
 * a safety property, and a safety property implemented twice is a safety property that will
 * disagree with itself in six months. This file calls them.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { findConfigFile } from '../core/paths.js';
import { classify } from './sealed.js';
import { readIntent, referenceStamp, readJsonFile, writeJsonAtomic } from './intent.js';
import { WAIVER_BUDGET, activeWaivers, allWaivers, fingerprintFinding, waiverFor } from './waiver.js';
import { recordCheck } from './reference.js';

/** @typedef {import('./types.js').Store} Store */
/** @typedef {import('./types.js').Finding} Finding */
/** @typedef {import('./types.js').Verdict} Verdict */
/** @typedef {import('./intent.js').Intent} Intent */
/** @typedef {import('./sealed.js').SealedVerdict} SealedVerdict */
/** @typedef {import('./waiver.js').Waiver} Waiver */

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Five waivers between one ship and the next.
 *
 * Re-exported from waiver.js rather than restated, because the budget is a safety property
 * and a safety property with two numbers in two files is a safety property that will
 * disagree with itself. waiver.js enforces it; this only says it out loud.
 */
export { WAIVER_BUDGET };

/**
 * How many items the escalation block prints before it stops and says how many are left.
 *
 * If this ceiling is ever reached in ordinary use, the gates are wrong and the fix is the
 * gates, not a longer list. Six things needing a person in one run is not a summary line,
 * it is a meeting.
 */
const MOST_ITEMS = 6;

// ---------------------------------------------------------------------------
// The decision record, gathered
// ---------------------------------------------------------------------------

/**
 * Everything an agent has said about this change, and what is left of its budget.
 *
 * @typedef {object} Decisions
 * @property {string} product
 * @property {string} stamp        Which reference is in force for this product, as one short string.
 * @property {Intent|null} intent  The most recently sealed intent, if there is one.
 * @property {Waiver[]} live       Waivers that still cover something.
 * @property {Waiver[]} expired    Waivers that have stopped covering anything.
 * @property {number} budget
 * @property {number} spent
 * @property {number} left
 */

/**
 * @param {Store} store
 * @param {string} product
 * @returns {Promise<Decisions>}
 */
export async function readDecisions(store, product) {
  const live = await activeWaivers(store, product);
  const all = await allWaivers(store, product);
  // By id, never by object identity: the two calls above each read the file again, so every
  // waiver comes back as a fresh object and an identity test would call every live waiver
  // expired. The visible symptom would be a run reporting "3 waivers have expired" on the
  // very run that wrote them.
  const alive = new Set(live.map((w) => w.id));
  return {
    product,
    stamp: await referenceStamp(store, product),
    intent: await readIntent(store, product),
    live,
    expired: all.filter((w) => !alive.has(w.id)),
    budget: WAIVER_BUDGET,
    spent: live.length,
    left: Math.max(0, WAIVER_BUDGET - live.length),
  };
}

/**
 * What to fall back to when the bookkeeping cannot be read at all.
 *
 * No intent and no waivers means nothing is accounted for, so every difference is reported.
 * That is the only safe direction for this to fail in: a broken record makes the tool
 * noisier, never quieter.
 *
 * @param {string} product
 * @returns {Decisions}
 */
export function noDecisions(product) {
  return { product, stamp: 'unreadable', intent: null, live: [], expired: [], budget: WAIVER_BUDGET, spent: 0, left: WAIVER_BUDGET };
}

// ---------------------------------------------------------------------------
// Which product is this?
// ---------------------------------------------------------------------------

/**
 * The product name a folder answers to.
 *
 * The reference pointer, the intents and the waivers are all keyed by this string, so the
 * command line, the MCP surface and the ship hook agreeing on it is not a nicety. Disagree
 * and an agent's waivers are counted against a product that never ships, while the product
 * that does ship never retires any.
 *
 * The rule matches `productName` in ship.js and `openProject` in check.js exactly: the
 * settings file's own `product`, else the package name, else the folder.
 *
 * @param {string} root
 * @returns {Promise<string>}
 */
export async function productFor(root) {
  const configFile = findConfigFile(root);
  if (configFile && configFile.endsWith('.json')) {
    try {
      const parsed = JSON.parse(await fsp.readFile(configFile, 'utf8'));
      if (typeof parsed?.product === 'string' && parsed.product) return parsed.product;
    } catch {
      // A settings file nobody can parse is somebody else's problem to report. Falling
      // through to the package name keeps the bookkeeping keyed on something either way.
    }
  }
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
    if (typeof pkg?.name === 'string' && pkg.name) return pkg.name;
  } catch {
    // No package.json, or an unreadable one. The folder name it is.
  }
  return path.basename(path.resolve(root));
}

// ---------------------------------------------------------------------------
// Naming a finding, and pinning a waiver to one exact difference
// ---------------------------------------------------------------------------

/**
 * Something to call a finding by.
 *
 * Stable while the finding itself persists, so an agent can run a check twice and still
 * explain, prove or waive the same one. Built from the title and the addresses rather than
 * from a counter, because a counter renumbers everything the moment one finding is fixed.
 *
 * @param {Finding} f
 * @returns {string}
 */
export function findingId(f) {
  return 'f-' + shortDigest([f.title, ...(f.paths ?? [])]).slice(0, 6);
}

/**
 * What a waiver pins to — the exact difference, not the finding — comes from waiver.js, which
 * is what writes the waivers. Computing it a second way here would produce records that
 * never match the waivers written against them, and the symptom would be a waiver that
 * silently covers nothing.
 */
export { fingerprintFinding as fingerprintOf };

/**
 * Sixteen hex characters of SHA-256 over whatever it is handed. The same algorithm
 * `shortDigest` in intent.js uses, so two parts of the tool naming the same thing name it
 * the same way.
 *
 * @param {unknown[]} parts
 * @returns {string}
 */
function shortDigest(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// The arithmetic check.js runs after ranking
// ---------------------------------------------------------------------------

/**
 * A finding with the three things the decision layer adds: something to call it by, the
 * fingerprint a waiver pins to, and whether any agent is allowed to account for it at all.
 *
 * @typedef {Finding & {id: string, fingerprint: string, unwaivable?: boolean, unwaivableWhy?: string, sealedBy?: SealedVerdict, waivedBy?: string, waivedBecause?: string}} DecidedFinding
 */

/**
 * The counts that make the silence legible, carried on the verdict itself.
 *
 * An agent has to be able to see that fifty things were waived, not merely that nothing was
 * reported. "Nothing changed", "nothing ran" and "everything was waived" read identically
 * without this, and two of those three are a safety net quietly announcing success.
 *
 * @typedef {object} Accounting
 * @property {number} reported        Findings the agent still has to deal with.
 * @property {number} waived          Findings dropped because they were already recorded as intended.
 * @property {number} unwaivable      Of the reported ones, how many no agent may account for.
 * @property {number} expiredWaivers  Waivers that have stopped covering anything.
 * @property {number} budget
 * @property {number} spent
 * @property {number} left
 * @property {string|null} intent     The id of the intent in force, or null when none was sealed.
 * @property {string} note            One plain sentence saying all of the above.
 */

/**
 * @typedef {object} Decided
 * @property {DecidedFinding[]} all       Every finding, named and marked. Nothing dropped.
 * @property {DecidedFinding[]} reported  What the agent still has to deal with.
 * @property {DecidedFinding[]} waived    What was dropped, kept so the count can be justified.
 * @property {Accounting} accounting
 */

/**
 * Apply the decision record to a freshly ranked set of findings.
 *
 * Three things happen here and nothing else.
 *
 * Every finding is named and fingerprinted. Sealed-class findings are marked unwaivable —
 * asked of sealed.js, never decided here — so that no later code has to re-derive the rule
 * and no later code can get it wrong. And findings already covered by a LIVE waiver are
 * dropped from what anybody reads, but counted, and kept in `waived` so the count can be
 * justified line by line if anybody asks.
 *
 * A waiver never applies to a sealed finding, whatever the file on disk says. That is
 * checked here as well as where the waiver is written, because a gate that exists in only
 * one place is a gate a hand-edited JSON file walks straight through.
 *
 * @param {Finding[]} findings
 * @param {Decisions} decisions
 * @param {{guards?: string[]}} [opts]  Guard names, so a difference touching one is sealed by name.
 * @returns {Decided}
 */
export function decide(findings, decisions, opts = {}) {
  /** @type {DecidedFinding[]} */
  const all = [];
  /** @type {DecidedFinding[]} */
  const reported = [];
  /** @type {DecidedFinding[]} */
  const waived = [];

  for (const f of findings) {
    /** @type {DecidedFinding} */
    const named = { ...f, id: findingId(f), fingerprint: fingerprintFinding(f) };
    const sealed = classify(f, { guards: opts.guards ?? [] });
    if (sealed) {
      named.unwaivable = true;
      named.unwaivableWhy = sealed.why;
      named.sealedBy = sealed;
    }

    const cover = sealed ? undefined : waiverFor(decisions.live, f);
    if (cover) {
      named.waivedBy = cover.id;
      named.waivedBecause = cover.why;
      waived.push(named);
    } else {
      reported.push(named);
    }
    all.push(named);
  }

  const unwaivable = reported.filter((f) => f.unwaivable === true).length;

  /** @type {Accounting} */
  const accounting = {
    reported: reported.length,
    waived: waived.length,
    unwaivable,
    expiredWaivers: decisions.expired.length,
    budget: decisions.budget,
    spent: decisions.spent,
    left: decisions.left,
    intent: decisions.intent?.id ?? null,
    note: accountingNote(reported.length, waived.length, unwaivable, decisions),
  };

  return { all, reported, waived, accounting };
}

/**
 * The sentence that keeps a quiet run honest.
 *
 * @param {number} reported
 * @param {number} waived
 * @param {number} unwaivable
 * @param {Decisions} decisions
 * @returns {string}
 */
function accountingNote(reported, waived, unwaivable, decisions) {
  /** @type {string[]} */
  const parts = [];
  if (waived > 0) {
    parts.push(
      `${waived} ${waived === 1 ? 'difference was' : 'differences were'} recorded as intended earlier and ${waived === 1 ? 'is' : 'are'} not shown again`,
    );
  }
  if (unwaivable > 0) {
    parts.push(`${unwaivable} of what is left ${unwaivable === 1 ? 'is' : 'are'} in a class nobody may wave through`);
  }
  if (decisions.spent > 0) {
    parts.push(`${decisions.left} of the ${decisions.budget} waivers allowed before the next ship remain`);
  }
  if (parts.length === 0) {
    return reported === 0
      ? 'Nothing was waived and nothing was hidden: this run reports every difference it found.'
      : 'Nothing has been recorded as intended, so everything reported is exactly what the run found.';
  }
  return capital(parts.join(', ')) + '. Nothing is the new normal until a build ships.';
}

// ---------------------------------------------------------------------------
// What is written down after every check
// ---------------------------------------------------------------------------

/**
 * The record of one check.
 *
 * Every finding is kept here, waived ones included. The verdict drops them; this does not.
 * Dropping a finding from what an agent READS is the point of a waiver; dropping it from the
 * record would make the waiver unauditable, which is the opposite of the point.
 *
 * @typedef {object} CheckRecord
 * @property {string} at
 * @property {string} product
 * @property {string} reference        The reference stamp in force when the check ran.
 * @property {string} verdict          'blocked' | 'nothing unaccounted for' | 'differences found'
 * @property {DecidedFinding[]} findings
 * @property {string[]} newlyUnstable
 * @property {Accounting} accounting
 * @property {any} result              The whole verdict, for anything that wants the detail.
 */

/**
 * @param {Store} store
 * @returns {Promise<CheckRecord|null>}
 */
export async function readCheckRecord(store) {
  const raw = await readJsonFile(path.join(store.dir, 'last-check.json'), null);
  return raw && typeof raw === 'object' && Array.isArray(raw.findings) ? raw : null;
}

/**
 * Write down what this check concluded, and what a person now has to decide.
 *
 * Three files, each with one reader. `last-check.json` is the working record and holds
 * everything, so explain, prove and waive can be handed an id. `escalations.json` holds only
 * what a person must rule on, per product, so a closing summary can be assembled without
 * loading a whole run. And `recordCheck` adds a line to the check log that reference.js
 * reads at ship time — without it, somebody who runs `staysfixed check` on the command line
 * and then ships is told their build was never checked.
 *
 * @param {Store} store
 * @param {{product: string, verdict: Verdict & {blocked?: boolean}, decided: Decided}} what
 * @returns {Promise<void>}
 */
export async function rememberCheck(store, what) {
  const { product, verdict, decided } = what;
  const unstable = (verdict.newlyUnstable ?? []).map((e) => e.path);
  const state =
    verdict.blocked === true
      ? 'blocked'
      : decided.reported.length === 0 && unstable.length === 0
        ? 'nothing unaccounted for'
        : 'differences found';

  /** @type {CheckRecord} */
  const record = {
    at: new Date().toISOString(),
    product,
    reference: await referenceStamp(store, product),
    verdict: state,
    findings: decided.all,
    newlyUnstable: unstable,
    accounting: decided.accounting,
    result: verdict,
  };
  await writeJsonAtomic(path.join(store.dir, 'last-check.json'), record);

  const book = await readJsonFile(path.join(store.dir, 'escalations.json'), {});
  const all = book && typeof book === 'object' && !Array.isArray(book) ? book : {};
  all[product] = buildEscalations(product, record, verdict);
  await writeJsonAtomic(path.join(store.dir, 'escalations.json'), all);

  if (verdict.candidate?.id) {
    await recordCheck(store, {
      buildId: verdict.candidate.id,
      product,
      ok: verdict.ok === true,
      blocked: verdict.blocked === true,
      findings: decided.all.length,
      unaccounted: decided.reported.length,
      waived: decided.accounting.waived,
      sealed: decided.accounting.unwaivable,
      by: 'staysfixed check',
    });
  }
}

// ---------------------------------------------------------------------------
// Escalation — the only thing that reaches him
// ---------------------------------------------------------------------------

/**
 * One thing a person has to rule on. Three sentences, and there is no fourth.
 *
 * @typedef {object} Escalation
 * @property {string} id
 * @property {'sealed'|'difference'|'budget'|'unpredictable'|'blocked'|'no-reference'} kind
 * @property {string} what   What changed.
 * @property {string} why    Why no agent could wave it through.
 * @property {string} todo   What to do about it.
 * @property {string} [class]
 * @property {string[]} [paths]
 */

/**
 * What a person must decide about one product, and nothing else.
 *
 * @typedef {object} Escalations
 * @property {string} product
 * @property {string|null} at        When the check that produced this ran.
 * @property {Escalation[]} items
 * @property {number} waived
 * @property {number} expiredWaivers
 * @property {string} note           One sentence for the summary, true even when items is empty.
 */

/**
 * What a person must decide about this product.
 *
 * Deliberately narrow. An ordinary difference an agent caused and has not fixed yet is the
 * agent's problem, not his, and putting it here would turn a handful of items a month into a
 * feed nobody reads. Five things reach a person, and four of them are rare by construction:
 *
 *   - a difference in a sealed class, which no agent may account for at any time;
 *   - the waiver budget running out while differences remain, because that is a rewrite;
 *   - addresses that used to give the same answer every time and now do not, which cannot be
 *     waived because they are not a difference, they are a loss of determinism;
 *   - a check that could not run at all, because "no answer" must never look like a pass;
 *   - no reference yet, because until he ships once the tool is not protecting him and he
 *     ought to know that rather than assume it is.
 *
 * A clean run produces none of these. That is the design target, and if a normal week ever
 * produces more than a couple, the gates are wrong and the gates are what should change.
 *
 * @param {Store} store
 * @param {string} product
 * @returns {Promise<Escalations>}
 */
export async function escalationsFor(store, product) {
  const book = await readJsonFile(path.join(store.dir, 'escalations.json'), {});
  const found = book && typeof book === 'object' ? book[product] : null;
  if (found && Array.isArray(found.items)) return found;
  return {
    product,
    at: null,
    items: [],
    waived: 0,
    expiredWaivers: 0,
    note: `Stays Fixed has not checked ${product} yet, so nothing here says anything about it either way.`,
  };
}

/**
 * @param {string} product
 * @param {CheckRecord} record
 * @param {Verdict & {blocked?: boolean}} verdict
 * @returns {Escalations}
 */
function buildEscalations(product, record, verdict) {
  // TWO PILES, AND THE ORDER BETWEEN THEM IS THE FIX.
  //
  // `real` is everything that is the product behaving differently, or the check not having
  // happened at all. `steadiness` is the one item that is neither: addresses that used to
  // give the same answer every run and now do not. That is worth a person's attention and it
  // is NOT a difference — nothing in it has a wrong value.
  //
  // WHAT WENT WRONG, 2026-08-31. A run caught one real change correctly and also measured 242
  // addresses as newly unsteady. Only the second reached this block, because an ordinary
  // difference has never been put in here at all — so the only sentence the owner read told
  // him to hold the release over a wobble measurement, and never mentioned the change the
  // tool had actually found. Piling them separately makes that ordering structural instead of
  // accidental, and `crowdedOut` below makes sure a real change is never the thing left out.
  /** @type {Escalation[]} */
  const real = [];
  /** @type {Escalation[]} */
  const steadiness = [];

  if (verdict.blocked === true) {
    real.push({
      id: 'blocked',
      kind: 'blocked',
      what: `Stays Fixed could not check ${product} at all on this run, so nothing about it has been proved either way.`,
      why: 'A check that did not run is not a pass and not a failure, and nobody may file it under either.',
      todo: `Something is in the way and it needs clearing — the run said: ${oneLine(verdict.summary, 200)}`,
    });
  } else if (!verdict.reference || verdict.reference.id === '') {
    real.push({
      id: 'no-reference',
      kind: 'no-reference',
      what: `There is no build of ${product} on record as working yet, so this run had nothing to compare against.`,
      why: 'Only you can say what "working" means, and you say it by shipping — no agent may cut that reference.',
      // The order is said out loud because leaving it out sent people round a circle: `ship`
      // on a build nothing has watched answers "run a check before the next release", and
      // this line answered "you say it by shipping". Both are true and neither says which
      // comes first. A check watches the build; shipping then blesses what was watched.
      todo: 'Run `staysfixed check` once so there is a build to bless, then `staysfixed ship`. From the next change onwards it is automatic and you will not see this again.',
    });
  }

  for (const f of record.findings) {
    if (f.unwaivable !== true) continue;
    real.push({
      id: f.id,
      kind: 'sealed',
      what: oneLine(f.title, 220),
      // One sentence, not sealed.js's full two. He knows why money matters; what he needs
      // from this line is which of the five classes it landed in, so the item is three
      // sentences and stays three sentences.
      why: `No agent may wave this through: it touches ${f.sealedBy?.says ?? 'something a person has to rule on'}.`,
      todo: sealedTodo(f),
      class: typeof f.class === 'string' ? f.class : undefined,
      paths: (f.paths ?? []).slice(0, 6),
    });
  }

  if (record.accounting.left === 0 && record.accounting.reported > record.accounting.unwaivable) {
    real.push({
      id: 'budget',
      kind: 'budget',
      what: `The agent has used all ${record.accounting.budget} of the differences it is allowed to record as intended on ${product}, and there are still differences left over.`,
      why: 'Past five, this stopped being a change with side effects and became a rewrite, and a person looks at a rewrite.',
      todo: 'Read what it changed before it goes any further, or ship what you are happy with so the count starts again.',
    });
  }

  if (record.newlyUnstable.length > 0) {
    const n = record.newlyUnstable.length;
    steadiness.push({
      id: 'unpredictable',
      kind: 'unpredictable',
      what: `${n} ${n === 1 ? 'thing in' : 'things in'} ${product} used to give the same answer every single run and now ${n === 1 ? 'does' : 'do'} not: ${record.newlyUnstable.slice(0, 3).join(', ')}${n > 3 ? ', and more' : ''}.`,
      why: 'Nothing here has a wrong value, so no agent can point at it and no waiver can cover it — which is exactly why this kind of bug survives for months.',
      todo: 'Have it looked into before shipping. Something in the change made the product unpredictable.',
      paths: record.newlyUnstable.slice(0, 6),
    });
    // A REAL CHANGE IS NEVER THE THING LEFT OUT.
    //
    // An ordinary difference is the agent's problem and does not get its own item — that is
    // deliberate, and it stops a handful of items a month becoming a feed nobody reads. But it
    // stops being right the moment the ONLY thing in this block is a wobble measurement,
    // because then the sentence a person reads is an alarm about a non-difference with no
    // mention of the difference the tool did find. So a real change gets one line here, and it
    // goes first, exactly when it would otherwise have been the thing crowded out.
    const crowdedOut = record.findings.filter((f) => f.waivedBy === undefined && f.unwaivable !== true);
    if (real.length === 0 && crowdedOut.length > 0) {
      const worst = crowdedOut[0];
      real.push({
        id: 'differences',
        kind: 'difference',
        what: `${product} behaves differently from the build you were happy with in ${crowdedOut.length} ${crowdedOut.length === 1 ? 'place' : 'places'}: ${oneLine(worst.title, 180)}${crowdedOut.length > 1 ? ', and more' : ''}.`,
        why: 'This is a real change in the product, which is what the check is for — it is named before the steadiness note below so it cannot be read past.',
        todo: 'The agent has to deal with each one: fix it, or record it as intended and say why. Nothing is the new normal until you ship.',
        paths: (worst.paths ?? []).slice(0, 6),
      });
    }
  }

  const all = [...real, ...steadiness];
  return {
    product,
    at: record.at,
    items: all,
    waived: record.accounting.waived,
    expiredWaivers: record.accounting.expiredWaivers,
    note: summaryNote(product, all, record),
  };
}

/**
 * @param {DecidedFinding} f
 * @returns {string}
 */
function sealedTodo(f) {
  const where = (f.paths ?? [])[0];
  const cls = typeof f.class === 'string' ? f.class : '';
  if (cls === 'guard') return 'This is a bug you already reported once, coming back. Say whether it goes back on the list, or the guard was wrong.';
  if (cls === 'money') return 'Say whether that is the amount you wanted. If it is, shipping makes it the new normal; if it is not, nothing ships.';
  if (cls === 'sign-in') return 'Say whether signing in is meant to behave like that now. Nothing ships until you do.';
  if (cls === 'data-loss') return 'Say whether that deletion is meant to happen. This one is worth thirty seconds before anything ships.';
  if (cls === 'crash') return 'This has to be fixed before anything ships. Nobody needs to decide anything, but you should know it happened.';
  return `Say whether that is what you wanted${where ? `, at ${where}` : ''}. If it is, ship — shipping is what makes it the new normal.`;
}

/**
 * @param {string} product
 * @param {Escalation[]} items
 * @param {CheckRecord} record
 * @returns {string}
 */
function summaryNote(product, items, record) {
  // NOTHING NEEDING YOUR WORD IS NOT THE SAME AS NOTHING BEING WRONG.
  //
  // This line used to read "nothing on X needs your word" on a run that had found real
  // differences the agent had not dealt with — true about who has to decide, and read by
  // anybody skimming as an all-clear. One clause fixes it, and it is added rather than the
  // sentence replaced, because who has to decide is still the thing this block is about.
  const left = record.accounting.reported;
  const outstanding = left > 0
    ? ` The agent still has ${left} ${left === 1 ? 'difference' : 'differences'} of its own to deal with on this build.`
    : '';
  if (items.length === 0) {
    const waived = record.accounting.waived;
    return waived > 0
      ? `Stays Fixed: nothing on ${product} needs your word.${outstanding} ${waived} ${waived === 1 ? 'difference was' : 'differences were'} recorded as intended by the agent and ${waived === 1 ? 'is' : 'are'} waiting on your next ship.`
      : `Stays Fixed: nothing on ${product} needs your word.${outstanding}`;
  }
  return `Stays Fixed: ${items.length} ${items.length === 1 ? 'thing needs' : 'things need'} your word on ${product}.`;
}

/**
 * The escalation block, as plain text a closing summary can paste in whole.
 *
 * No headings to navigate, no table, no link, no reference numbers only the tool
 * understands. He reads one summary at the end of a working stretch; this has to fit inside
 * it and read as part of it.
 *
 * @param {Escalations} escalations
 * @returns {string}
 */
export function escalationBlock(escalations) {
  /** @type {string[]} */
  const out = [escalations.note];

  const shown = escalations.items.slice(0, MOST_ITEMS);
  shown.forEach((item, i) => {
    out.push('');
    out.push(`${i + 1}. ${item.what}`);
    out.push(`   ${item.why}`);
    out.push(`   ${item.todo}`);
  });

  if (escalations.items.length > shown.length) {
    out.push('');
    out.push(
      `And ${escalations.items.length - shown.length} more of the same kind. That many at once means something bigger went wrong than any one of them.`,
    );
  }

  if (escalations.items.length > 0 && escalations.waived > 0) {
    out.push('');
    out.push(
      `Also: the agent recorded ${escalations.waived} other ${escalations.waived === 1 ? 'difference' : 'differences'} as intended. ${escalations.waived === 1 ? 'It is' : 'They are'} provisional until you ship.`,
    );
  }

  return out.join('\n');
}

/**
 * Write the escalation block where a closing summary can pick it up.
 *
 * @param {Store} store
 * @param {string} product
 * @param {string} file   Where to write it. Absolute, or relative to the project folder.
 * @returns {Promise<{file: string, text: string, count: number}>}
 */
export async function writeEscalations(store, product, file) {
  const escalations = await escalationsFor(store, product);
  const text = escalationBlock(escalations);
  const where = path.isAbsolute(file) ? file : path.join(store.root, file);
  await fsp.mkdir(path.dirname(where), { recursive: true });
  await fsp.writeFile(where, text.endsWith('\n') ? text : text + '\n');
  return { file: where, text, count: escalations.items.length };
}

// ---------------------------------------------------------------------------
// Small things
// ---------------------------------------------------------------------------

/**
 * @param {unknown} s
 * @param {number} max
 * @returns {string}
 */
function oneLine(s, max) {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '...' : one;
}

/**
 * @param {string} s
 * @returns {string}
 */
function capital(s) {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
