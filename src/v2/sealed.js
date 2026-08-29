/**
 * The five classes no agent may ever wave through.
 *
 * Everything else in the waiver system is a judgement with a confidence attached. This file is
 * not. It answers one question — "may an agent decide, on its own, that this difference is
 * fine?" — and when the answer is no, no amount of good reasoning changes it. That asymmetry is
 * deliberate. An agent under pressure to finish writes a plausible reason for anything, so the
 * defence cannot be the quality of the reason; it has to be a class of difference where the
 * reason is never listened to at all.
 *
 * The five, and why each one is on the list:
 *
 *   money      Being wrong costs somebody money, and the mistake is not reversible by editing
 *              code afterwards. A charge that went out is out.
 *   sign-in    Being wrong locks a real person out of their own account, or lets the wrong
 *              person in. Both are worse than the feature that was being built.
 *   data-loss  Being wrong destroys something that cannot be rebuilt from the repository.
 *   crash      The product stopped. There is no version of "I meant that" worth reading.
 *   guard      A guard is the encoded memory of a bug somebody already reported once. A
 *              difference there means a bug that was already paid for is back, and an agent
 *              deciding that is acceptable is the single fastest way to destroy trust in a
 *              product. This one leads the list for that reason.
 *
 * WHERE THE LINES ARE DRAWN, and what I was worried about in each direction. Sealing too much
 * sends a person a stream of things they do not need to see, they stop reading it, and the one
 * that mattered goes past unread — a seal that is never read is worth less than no seal. Sealing
 * too little lets an agent wave through the one difference that costs somebody their afternoon.
 * So each rule below says which way I erred and why.
 *
 * This file reads a finding and nothing else. No disk, no network, no clock — so it gives the
 * same answer twice, it can be run on a finding that came out of a file, and a test can hand it
 * anything at all. `waiver.js` is the only caller that matters, and it calls this FIRST, before
 * it looks at intents or budgets, because a sealed finding is refused whatever the rest says.
 *
 * It deliberately does NOT trust the engine to have got this right on its own. `rank.js` already
 * labels findings, and this agrees with it by design — same class names, same order. But it also
 * does the work again from the finding's own text, and seals when EITHER says so. A gate that
 * only reads a flag another part of the tool set is a gate that a bug in that part can open.
 */

/**
 * @typedef {import('./types.js').Finding} Finding
 * @typedef {import('./types.js').FindingClass} FindingClass
 * @typedef {import('./types.js').Difference} Difference
 * @typedef {import('./types.js').Channel} Channel
 */

/**
 * The classes, worst first, and what each is called in a sentence a person reads.
 *
 * The order matches `SEALED_ORDER` in rank.js on purpose: two parts of one tool disagreeing
 * about which of two bad things is worse is the kind of small inconsistency that makes people
 * stop believing either of them.
 *
 * @type {{name: Exclude<FindingClass, 'ordinary'>, says: string, because: string}[]}
 */
export const SEALED_CLASSES = [
  {
    name: 'guard',
    says: 'a bug somebody already reported once',
    because:
      'A guard exists because this exact thing broke before and somebody had to say so. A difference here means it is back.',
  },
  {
    name: 'crash',
    says: 'a crash',
    because: 'The product stopped, or started stopping. Nothing about that can be intended.',
  },
  {
    name: 'data-loss',
    says: 'losing data',
    because: 'Code can be edited back. Data that was deleted cannot.',
  },
  {
    name: 'money',
    says: 'money',
    because: 'A charge, a price or a refund that goes out wrong costs a real person real money.',
  },
  {
    name: 'sign-in',
    says: 'signing in',
    because: 'Getting this wrong locks the right people out or lets the wrong people in.',
  },
];

/** Just the names, worst first. @type {Exclude<FindingClass, 'ordinary'>[]} */
export const SEALED_ORDER = SEALED_CLASSES.map((c) => c.name);

/** @type {Record<string, {says: string, because: string}>} */
const CLASS_INDEX = Object.fromEntries(SEALED_CLASSES.map((c) => [c.name, { says: c.says, because: c.because }]));

// ---------------------------------------------------------------------------
// The vocabularies
// ---------------------------------------------------------------------------

/**
 * Money words that seal on any channel at all.
 *
 * ERRED TOWARDS SEALING. These are words that almost never appear in a product except where
 * money is involved, so a false seal is rare and the cost of missing one is somebody being
 * charged the wrong amount. `price` is in here even though a price is often just a label,
 * because a price label that changed by itself is exactly the thing worth interrupting a person
 * for.
 *
 * Note `\bpay\b` cannot match inside `payload` — a word boundary needs a non-word character —
 * so the obvious false positive is already handled by the boundary rather than by an exception.
 */
const MONEY_ALWAYS =
  /\b(charge|charged|charges|charging|payment|payments|pay|paying|paid|invoice|invoices|refund|refunds|refunded|price|prices|pricing|billing|billed|subscription|subscriptions|checkout|stripe|paypal|braintree|adyen|payout|payouts|wallet|coupon|coupons|discount|discounts|voucher|iban|swift code|credit card|card number|cardnumber|cvv|amount due|total due|purchase|purchases|receipt|receipts)\b/i;

/**
 * Money words that only seal when something actually went out or came back.
 *
 * ERRED TOWARDS NOT SEALING. `total`, `amount`, `balance` and `cost` are ordinary English and
 * live all over a product that has nothing to do with money — a load balance, a total count of
 * files, the cost of a query. On the `effects` and `results` channels they sit inside a call
 * that was made or a body that came back, which is where a number of that name is usually a
 * sum of money. On a screen label they are usually not, and sealing there would flood a person
 * with counters that moved.
 */
const MONEY_WHEN_SENT =
  /\b(amount|amounts|balance|balances|total|totals|subtotal|cost|costs|fee|fees|cents|currency|usd|eur|gbp|aed|pkr|inr|tax|vat)\b/i;

/**
 * Sign-in words that seal on any channel.
 *
 * ERRED TOWARDS SEALING, with two deliberate exclusions.
 *
 * `session` on its own is NOT here, and that is the most important omission in this file. A
 * terminal session, a shell session, a browser session and a recorded session are all ordinary
 * words in the products this runs against — Terminal Deck calls every shell it opens a session —
 * and sealing on it would put a sealed finding in front of a person on nearly every run. The
 * phrase `session token` IS here, because that is unambiguous.
 *
 * The status numbers 401 and 403 are NOT here either. A word boundary sits either side of the
 * digits in a version string like `1.401.0`, so they seal things that have nothing to do with
 * signing in. `unauthorized` and `forbidden` carry the same meaning without the false matches.
 */
const SIGN_IN_ALWAYS =
  /\b(sign ?in|signin|sign ?out|signout|sign ?up|signup|log ?in|login|log ?out|logout|password|passwords|passcode|passphrase|credential|credentials|oauth|jwt|api key|apikey|access token|refresh token|session token|bearer token|two ?factor|2fa|otp|mfa|sso|saml|authenticate|authenticated|authentication|authorise|authorize|authorisation|authorization|unauthorised|unauthorized|forbidden|impersonate|impersonation)\b/i;

/**
 * Sign-in words that only seal when something went out, came back, or is a door the code
 * exposes.
 *
 * ERRED TOWARDS NOT SEALING. `auth`, `token`, `role`, `permission` and `account` are everywhere
 * in a codebase's own vocabulary. Inside a request that was made, a body that came back, or the
 * list of routes the source exposes, a change to one of them is a change to who can do what.
 */
const SIGN_IN_WHEN_SENT =
  /\b(auth|tokens?|permissions?|roles?|cookies?|identity|identities|account|accounts|scope|scopes|acl)\b/i;

/**
 * Data-loss phrases that seal on any channel.
 *
 * ERRED HARD TOWARDS SEALING. Every one of these is a phrase that only appears where something
 * is being destroyed. There is no ordinary reading of `drop table` or `rm -rf`.
 */
const DATA_LOSS_ALWAYS =
  /(\bdrop\s+(?:table|database|schema)\b|\btruncate\b|\bdelete\s+from\b|\brm\s+-rf\b|\bunlink\b|\brmdir\b|\bwiped?\b|\bpurged?\b|\berased?\b|\bdata ?loss\b|\bdestroys?\b|\bdestroyed\b|\bshred\b|--accept-data-loss|\bmigrate\s+reset\b|\bforce-reset\b|\bdrop\s+column\b|\bformat\s+(?:disk|drive)\b)/i;

/**
 * Data-loss words that only seal when something went out or a door changed.
 *
 * ERRED TOWARDS NOT SEALING, and this is the line I am least comfortable with in either
 * direction. A button labelled Delete that changed colour is not a data-loss incident, and
 * treating it as one is how a safety net gets ignored. But a Delete button that stopped asking
 * "are you sure" IS one, and that difference lives on the meaning channel where this rule does
 * not look. I chose the quieter rule and left the loud case to the guard class: a confirmation
 * that matters enough to worry about is a bug somebody has already reported once, and a guard
 * names it. If that turns out to be wrong in practice, the fix is a guard, not a wider regex.
 */
const DATA_LOSS_WHEN_SENT =
  /\b(delete|deletes|deleted|deleting|remove all|removes all|clear all|clears all|drop|dropped|migration|migrations|migrate|migrated|overwrite|overwrites|overwritten|reset)\b/i;

/**
 * Crash words that seal on any channel, because none of them has a calm reading.
 */
const CRASH_ALWAYS =
  /\b(segfault|segmentation fault|core dumped|kernel panic|stack overflow|out of memory|fatal error|abort trap|sigsegv|sigabrt|sigbus|heap corruption)\b/i;

/**
 * Crash words that seal when they come from the complaints channel — console, stderr, exit codes.
 *
 * ERRED TOWARDS NOT SEALING on the word `error` alone, which is why it is missing here. Every
 * product with an error message in it says "error" somewhere, on every screen, forever. An error
 * MESSAGE changing is an ordinary difference and rank.js already puts complaints near the top of
 * the list, so it will be looked at; it just does not need a person woken up. `uncaught`,
 * `unhandled`, `traceback` and `panic` are different — they are what a program says while it is
 * dying.
 */
const CRASH_IN_COMPLAINTS =
  /\b(crash|crashed|crashes|crashing|uncaught|unhandled|fatal|panic|panicked|traceback|stack trace|nonzero exit|non-zero exit|exited unexpectedly|terminated unexpectedly)\b/i;

/** Paths that hold the exit code of something we ran. */
const EXIT_CODE_PATH = /(^|[.\-_/])(exit ?code|exitstatus|exit ?status|status ?code|returncode|return ?code)([.\-_/]|$)/i;

/** Channels where a value represents something that actually left the machine or came back. */
/** @type {Set<Channel>} */
const SENT_CHANNELS = new Set(['effects', 'results', 'contract']);

/** A guard name shorter than this is too small to match on safely. */
const SHORTEST_GUARD_NAME = 6;

/** How much of one value is read. A whole HTTP body would drown the match in noise. */
const VALUE_CHARS = 400;

// EVERY difference of a finding is read, and there is deliberately no ceiling on that.
// Until 2026-08-30 this file read the first eighty and stopped, which meant a cluster of
// three hundred addresses could hold the word `refund` at address two hundred and be
// classified ordinary — waivable by an agent, never seen by a person. A cap here is not a
// performance decision, it is a hole in the one gate that cannot have one. The cost is a
// substring search over text already in memory: the values are trimmed to VALUE_CHARS
// before they are searched, so reading them all costs a constant multiple of the finding
// itself, which the caller is already holding.

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/**
 * What classify hands back when a finding is sealed.
 *
 * `strength` never changes the outcome — sealed is sealed — it only tells a person reading the
 * summary how sure the machine was. A guard matched by name is not the same kind of certainty
 * as the word `refund` turning up in a title, and pretending they are is how a person learns to
 * skim.
 *
 * @typedef {object} SealedVerdict
 * @property {Exclude<FindingClass, 'ordinary'>} class
 * @property {string} says            What this class is called in a sentence: 'money'.
 * @property {string} why             One plain sentence: why nobody may wave it through.
 * @property {string[]} matched       The exact words or guard names that decided it.
 * @property {string[]} where         The addresses those words came from, so it can be checked.
 * @property {'engine'|'words'|'both'} from
 *   Who said so: the engine's own label, this file reading the finding's text, or both agreeing.
 * @property {'certain'|'likely'} strength
 */

/**
 * @typedef {object} ClassifyOptions
 * @property {string[]} [guards]   Names of the guards loaded for this project. A difference that
 *                                 names one is sealed by name, which is the strongest signal here.
 * @property {boolean} [trustEngine]  Default true. Set false to ignore `finding.class` entirely
 *                                    and judge only from the text — used by the self-check, so a
 *                                    wrong label upstream cannot make this file look right.
 */

/**
 * Is this difference in a class no agent may wave through?
 *
 * @param {Finding} finding
 * @param {ClassifyOptions} [opts]
 * @returns {SealedVerdict|null}  null means ordinary: an agent may waive it if the other three
 *                                gates let it through.
 */
export function classify(finding, opts = {}) {
  const guards = (opts.guards ?? []).filter((g) => typeof g === 'string' && g.trim().length >= SHORTEST_GUARD_NAME);
  const trustEngine = opts.trustEngine !== false;

  const read = readFinding(finding);
  const fromWords = judgeWords(read, guards);

  /** @type {Exclude<FindingClass, 'ordinary'>|null} */
  let fromEngine = null;
  if (trustEngine) {
    const label = finding.class;
    if (typeof label === 'string' && label !== 'ordinary' && label in CLASS_INDEX) {
      fromEngine = /** @type {Exclude<FindingClass, 'ordinary'>} */ (label);
    }
  }

  if (!fromWords && !fromEngine) return null;

  // When the two disagree, take the worse of the two. Disagreement means one of them saw
  // something the other did not, and this is not the place to split the difference.
  const chosen = worseOf(fromWords ? fromWords.class : null, fromEngine);
  if (!chosen) return null;

  const agreed = Boolean(fromWords && fromEngine && fromWords.class === fromEngine);
  const matched = fromWords && fromWords.class === chosen ? fromWords.matched : [];
  const where = fromWords && fromWords.class === chosen ? fromWords.where : [];
  const meta = CLASS_INDEX[chosen];

  return {
    class: chosen,
    says: meta.says,
    why: `Nobody may wave this through on their own: it touches ${meta.says}. ${meta.because}`,
    matched,
    where,
    from: agreed ? 'both' : fromWords && fromWords.class === chosen ? 'words' : 'engine',
    // A guard matched by its own full name, or a phrase with no calm reading, is certain.
    // A single ordinary word turning up in a title is a good reason to look, not a proof.
    strength: chosen === 'guard' || (fromWords?.certain ?? false) || agreed ? 'certain' : 'likely',
  };
}

/**
 * The same answer as a plain class name, for callers that already work in `FindingClass`.
 *
 * @param {Finding} finding
 * @param {ClassifyOptions} [opts]
 * @returns {FindingClass}
 */
export function sealedClassOf(finding, opts = {}) {
  return classify(finding, opts)?.class ?? 'ordinary';
}

/**
 * @param {Finding} finding
 * @param {ClassifyOptions} [opts]
 * @returns {boolean}
 */
export function isSealed(finding, opts = {}) {
  return classify(finding, opts) !== null;
}

/**
 * The refusal, written out for whoever reads it — an agent that has just been told no, or a
 * person reading the closing summary.
 *
 * @param {SealedVerdict} verdict
 * @param {Finding} [finding]
 * @returns {string}
 */
export function sayRefusal(verdict, finding) {
  const lines = [`Refused. ${verdict.why}`];
  if (finding?.title) lines.push(`  ${trim(finding.title, 200)}`);
  if (verdict.matched.length > 0) {
    lines.push(`  What decided it: ${verdict.matched.slice(0, 6).join(', ')}${verdict.where[0] ? ` (at ${verdict.where[0]})` : ''}.`);
  }
  lines.push(
    '',
    'No agent can wave this through, whatever the reason, and asking again in different words will get the same answer. Fix it, or put it in front of a person and say plainly what changed.'
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Reading a finding
// ---------------------------------------------------------------------------

/**
 * Everything about a finding that a word can be looked for in, kept next to the address it came
 * from so a match can be shown rather than asserted.
 *
 * @typedef {object} ReadFinding
 * @property {{text: string, where: string}[]} pieces
 * @property {Set<Channel>} channels
 * @property {Difference[]} differences
 */

/**
 * Pull the text out of a finding.
 *
 * `finding.why` is deliberately NOT read. That field holds prose the ranker wrote about the
 * finding — including, for a sealed one, the sentence "it touches money". Feeding the tool's own
 * explanation back into the tool's own classifier makes a loop where a label justifies itself,
 * and the day somebody rewords that sentence the seals change for no reason at all.
 *
 * @param {Finding} finding
 * @returns {ReadFinding}
 */
function readFinding(finding) {
  /** @type {{text: string, where: string}[]} */
  const pieces = [];
  /** @param {unknown} text @param {string} where */
  const add = (text, where) => {
    if (typeof text === 'string' && text.trim() !== '') pieces.push({ text, where });
  };

  add(finding.title, 'the title');
  add(finding.summary, 'the summary');
  add(finding.signature, 'what the differences were grouped on');
  for (const file of finding.nearFiles ?? []) add(file, 'a source file this points at');
  for (const p of finding.paths ?? []) add(p, p);

  const differences = finding.differences ?? [];
  for (const d of differences) {
    add(d.path, d.path);
    add(d.describe, d.path);
    add(faceOf(d.reference), d.path);
    add(faceOf(d.candidate), d.path);
    add(d.journey, `the ${d.journey} journey`);
  }
  if (finding.sample) {
    add(finding.sample.path, finding.sample.path);
    add(faceOf(finding.sample.reference), finding.sample.path);
    add(faceOf(finding.sample.candidate), finding.sample.path);
  }

  return {
    pieces,
    channels: new Set(differences.map((d) => d.channel)),
    differences,
  };
}

/**
 * A value as text, short enough to search without drowning the match in noise.
 * @param {unknown} value
 * @returns {string}
 */
function faceOf(value) {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return trim(value, VALUE_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return trim(JSON.stringify(value) ?? '', VALUE_CHARS);
  } catch {
    return '';
  }
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

// ---------------------------------------------------------------------------
// The rules, in order
// ---------------------------------------------------------------------------

/**
 * @typedef {object} WordVerdict
 * @property {Exclude<FindingClass, 'ordinary'>} class
 * @property {string[]} matched
 * @property {string[]} where
 * @property {boolean} certain
 */

/**
 * Judge the finding from its own text, in the order the classes are ranked, so a difference
 * that is both a crash and a money difference is reported as the worse of the two.
 *
 * @param {ReadFinding} read
 * @param {string[]} guards
 * @returns {WordVerdict|null}
 */
function judgeWords(read, guards) {
  const sent = [...read.channels].some((c) => SENT_CHANNELS.has(c));

  // GUARD. A guard name is a plain-English sentence somebody wrote about a bug they had —
  // 'the sidebar still collapses'. Whole-name matching is safe precisely because they are long
  // and specific. Matching on the individual WORDS of a guard name would seal half the product,
  // because those words are 'the', 'sidebar' and 'still'.
  for (const name of guards) {
    const hit = read.pieces.find((p) => p.text.toLowerCase().includes(name.toLowerCase().trim()));
    if (hit) return { class: 'guard', matched: [name], where: [hit.where], certain: true };
  }
  const guardPath = read.differences.find((d) => firstSegment(d.path) === 'guard');
  if (guardPath) return { class: 'guard', matched: ['a guard address'], where: [guardPath.path], certain: true };

  // CRASH. Two ways in: words that only get said while a program is dying, and an exit code
  // that used to be zero and is not any more. The second one needs no vocabulary at all, which
  // makes it the most reliable rule in the file.
  const exit = exitCodeCrash(read.differences);
  if (exit) return exit;
  const crashAlways = firstMatch(read, CRASH_ALWAYS);
  if (crashAlways) return { class: 'crash', ...crashAlways, certain: true };
  if (read.channels.has('complaints')) {
    const complaint = firstMatch(read, CRASH_IN_COMPLAINTS);
    if (complaint) return { class: 'crash', ...complaint, certain: true };
  }

  // DATA LOSS.
  const lossAlways = firstMatch(read, DATA_LOSS_ALWAYS);
  if (lossAlways) return { class: 'data-loss', ...lossAlways, certain: true };
  if (sent) {
    const lossSent = firstMatch(read, DATA_LOSS_WHEN_SENT);
    if (lossSent) return { class: 'data-loss', ...lossSent, certain: false };
  }

  // MONEY.
  const moneyAlways = firstMatch(read, MONEY_ALWAYS);
  if (moneyAlways) return { class: 'money', ...moneyAlways, certain: false };
  if (sent) {
    const moneySent = firstMatch(read, MONEY_WHEN_SENT);
    if (moneySent) return { class: 'money', ...moneySent, certain: false };
  }

  // SIGN IN.
  const signAlways = firstMatch(read, SIGN_IN_ALWAYS);
  if (signAlways) return { class: 'sign-in', ...signAlways, certain: false };
  if (sent) {
    const signSent = firstMatch(read, SIGN_IN_WHEN_SENT);
    if (signSent) return { class: 'sign-in', ...signSent, certain: false };
  }

  return null;
}

/**
 * A program that used to finish and now does not.
 *
 * Read as: the address is an exit code or a status code, the old value was zero or absent, and
 * the new value is not zero. No words involved, so it works on a product in any language, and it
 * cannot be talked out of.
 *
 * @param {Difference[]} differences
 * @returns {WordVerdict|null}
 */
function exitCodeCrash(differences) {
  for (const d of differences) {
    if (!EXIT_CODE_PATH.test(d.path)) continue;
    const now = asNumber(d.candidate);
    if (now === null || now === 0) continue;
    const before = asNumber(d.reference);
    if (before !== null && before !== 0) continue; // It was already failing. Not new, not a crash.
    return {
      class: 'crash',
      matched: [`exit code ${before === null ? 'became' : `went from ${before} to`} ${now}`],
      where: [d.path],
      certain: true,
    };
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * The first piece of the finding that a pattern matches, with the address it came from.
 *
 * @param {ReadFinding} read
 * @param {RegExp} pattern
 * @returns {{matched: string[], where: string[]}|null}
 */
function firstMatch(read, pattern) {
  for (const piece of read.pieces) {
    const hit = pattern.exec(piece.text);
    if (hit) return { matched: [hit[0]], where: [piece.where] };
  }
  return null;
}

/**
 * @param {string} path
 * @returns {string}
 */
function firstSegment(path) {
  return String(path).split('.')[0] ?? '';
}

/**
 * @param {Exclude<FindingClass, 'ordinary'>|null} a
 * @param {Exclude<FindingClass, 'ordinary'>|null} b
 * @returns {Exclude<FindingClass, 'ordinary'>|null}
 */
function worseOf(a, b) {
  if (!a) return b;
  if (!b) return a;
  return SEALED_ORDER.indexOf(a) <= SEALED_ORDER.indexOf(b) ? a : b;
}
