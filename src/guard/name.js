/**
 * The naming rule for guards, enforced instead of hoped for.
 *
 * A guard outlives the memory of the bug it was written for. The name is the
 * whole handover: it is what fails in CI, what an agent reads back, and what a
 * person has to judge in five seconds at midnight. So the tool refuses names
 * that only make sense to whoever typed them.
 */

/**
 * @typedef {object} NameVerdict
 * @property {boolean} ok
 * @property {string} [why]         Plain-language reason it was refused.
 * @property {string} [suggestion]  A rewrite, only when we can honestly offer one.
 */

/** Why the rule exists. Printed by the CLI whenever a name is refused. */
export const NAME_RULE_EXPLAINER =
  'A guard name is the only thing that still makes sense six months from now. ' +
  'It is what gets printed when the guard fails, what goes in the report, and what an agent reads ' +
  'before deciding whether it broke something. So write what the app is supposed to do, in the words ' +
  'you would say out loud: "the sidebar still collapses", "prices still show two decimals", ' +
  '"logging out clears the session". A name like sidebar_collapse_test tells the next person nothing ' +
  'about what broke or whether it matters. Three plain words minimum, present tense, no test ids.';

const MAX_LENGTH = 120;

/** Words that start a test name rather than describe the app. */
const TEST_SPEAK = new Set([
  'test',
  'tests',
  'it',
  'should',
  'shall',
  'verify',
  'verifies',
  'check',
  'checks',
  'assert',
  'asserts',
  'ensure',
  'ensures',
]);

/** Words that add nothing once the name is a sentence. */
const NOISE = new Set([
  'test',
  'tests',
  'testing',
  'spec',
  'specs',
  'should',
  'shall',
  'it',
  'verify',
  'verifies',
  'verified',
  'check',
  'checks',
  'checked',
  'assert',
  'asserts',
  'ensure',
  'ensures',
  'case',
  'cases',
  'regression',
  'regressions',
  'bug',
  'bugs',
  'guard',
  'guards',
  'e2e',
  'unit',
  'snapshot',
  'fix',
  'fixed',
  'fixes',
  'still',
  'again',
]);

const ARTICLES = new Set(['the', 'a', 'an']);

/**
 * Verbs a user interface actually does. The rewriter only offers a sentence when
 * it can find one of these, because guessing a verb out of a noun produces
 * confident nonsense ("the login form still validations") and people accept
 * suggestions without reading them.
 */
const VERBS = new Set([
  'align', 'appear', 'apply', 'build', 'cancel', 'clear', 'close', 'collapse', 'connect', 'copy',
  'delete', 'disappear', 'disconnect', 'download', 'drag', 'drop', 'exit', 'expand', 'export',
  'fit', 'filter', 'focus', 'format', 'highlight', 'hide', 'hold', 'import', 'install', 'keep',
  'launch', 'load', 'log', 'match', 'mount', 'navigate', 'open', 'paginate', 'parse', 'paste',
  'persist', 'print', 'reconnect', 'redirect', 'redo', 'refresh', 'remain', 'render', 'reset',
  'resize', 'restore', 'resume', 'retry', 'return', 'run', 'save', 'scroll', 'search', 'select',
  'show', 'sign', 'sort', 'start', 'stay', 'stop', 'submit', 'sync', 'toggle', 'undo', 'update',
  'upload', 'validate', 'work', 'wrap',
]);

/**
 * @typedef {'empty'|'long'|'path'|'id'|'symbols'|'caps'|'identifier'|'testspeak'|'short'} RefusalKind
 */

/**
 * Is this name acceptable, and if not, why — and can we offer a rewrite?
 *
 * @param {unknown} name
 * @returns {NameVerdict}
 */
export function checkGuardName(name) {
  const refusal = refuse(name);
  if (!refusal) return { ok: true };
  const suggestion = suggestFor(typeof name === 'string' ? name : '', refusal.kind);
  return suggestion ? { ok: false, why: refusal.why, suggestion } : { ok: false, why: refusal.why };
}

/**
 * The rule itself, with no rewriting. Kept separate so a suggested rewrite can be
 * run back through it without ever recursing into the suggester.
 *
 * @param {unknown} name
 * @returns {{kind: RefusalKind, why: string}|null}
 */
function refuse(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    return {
      kind: 'empty',
      why: 'A guard needs a name. Give it one plain sentence saying what should still be true, like "the sidebar still collapses".',
    };
  }

  const text = name.trim();

  if (text.length > MAX_LENGTH) {
    return {
      kind: 'long',
      why: `That name is ${text.length} characters long. Keep it under ${MAX_LENGTH} — a guard name is a short sentence, not a paragraph. Put the story of the bug in "because" instead.`,
    };
  }

  if (/[\\/]/.test(text) || /\.(js|mjs|cjs|ts|tsx|jsx|json|py|rb|go|rs)$/i.test(text)) {
    return {
      kind: 'path',
      why: 'That looks like a file name, not a description. Say what the app should still do, not where the code that does it lives.',
    };
  }

  if (/^#?[A-Za-z]{0,8}[-_ #]?\d+$/.test(text)) {
    return {
      kind: 'id',
      why: 'That is an issue number, not a description. The number will not tell anyone what broke — put it in "link" and use the name to say what should still work.',
    };
  }

  if (text.includes('#') || text.includes('::')) {
    return {
      kind: 'symbols',
      why: 'Names containing "#" or "::" read like code references. Write the behaviour in ordinary words, and put any issue or commit reference in "link".',
    };
  }

  if (/[A-Za-z]/.test(text) && text === text.toUpperCase()) {
    return {
      kind: 'caps',
      why: 'ALL CAPS reads like shouting, not like a sentence. Write it the way you would say it out loud.',
    };
  }

  const words = text.split(/\s+/).filter(Boolean);

  // One token that carries word boundaries inside it — snake_case, kebab-case,
  // SCREAMING_CASE or camelCase. These are identifiers, not sentences.
  if (words.length === 1 && (/[_.-]/.test(text) || /[a-z][A-Z]/.test(text))) {
    return {
      kind: 'identifier',
      why: 'That reads like a code identifier, not a sentence. Guard names are printed to people, so use spaces and ordinary words.',
    };
  }

  const first = words[0].toLowerCase().replace(/[^a-z]/g, '');
  if (words.length > 1 && TEST_SPEAK.has(first)) {
    return {
      kind: 'testspeak',
      why: `Starting with "${words[0]}" describes a test, not the app. Drop the test word and say what should still be true.`,
    };
  }

  if (words.length < 3) {
    return {
      kind: 'short',
      why: `That is only ${words.length} word${words.length === 1 ? '' : 's'}. Use at least three, so the name says what should still be true and not just which area it touches.`,
    };
  }

  return null;
}

/**
 * Offer a rewrite, but only one we would stand behind. Anything we cannot turn
 * into a real sentence gets no suggestion at all — a wrong suggestion is worse
 * than none, because people accept them.
 *
 * @param {string} name
 * @param {RefusalKind} kind
 * @returns {string|undefined}
 */
function suggestFor(name, kind) {
  // An issue number carries no behaviour at all, so there is nothing to rewrite from.
  if (kind === 'empty' || kind === 'long' || kind === 'id') return undefined;

  // Lower-casing keeps the author's own grammar, which beats anything we build.
  if (kind === 'caps') {
    const lowered = name.trim().toLowerCase();
    if (!refuse(lowered)) return lowered;
  }

  const built = sentenceFrom(name);
  if (built) return built;

  if (kind === 'testspeak') {
    const rest = name.trim().split(/\s+/).slice(1).join(' ');
    if (rest && !refuse(rest)) return rest;
  }

  if (kind === 'symbols') {
    const stripped = name
      .replace(/::/g, ' ')
      .replace(/#\s*\d*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (stripped && !refuse(stripped)) return stripped;
  }

  return undefined;
}

/**
 * Turn `sidebar_collapse_test` into "the sidebar still collapses".
 *
 * Only attempted when a real verb can be found, and only when something is left
 * in front of it to be the subject.
 *
 * @param {string} raw
 * @returns {string|undefined}
 */
function sentenceFrom(raw) {
  let base = String(raw).trim();
  base = base.split(/[\\/]/).pop() ?? base;
  base = base.replace(/\.(js|mjs|cjs|ts|tsx|jsx|json|py|rb|go|rs)$/i, '');

  let words = splitWords(base).filter((w) => !NOISE.has(w));
  while (words.length > 0 && ARTICLES.has(words[0])) words = words.slice(1);
  if (words.length < 2) return undefined;

  let at = -1;
  let stem = '';
  for (let i = 1; i < words.length; i += 1) {
    const found = verbStem(words[i]);
    if (found) {
      at = i;
      stem = found;
      break;
    }
  }
  if (at < 1) return undefined;

  const subject = words.slice(0, at);
  const tail = words.slice(at + 1);
  // "the prices still show" — a plural subject takes the bare verb.
  const last = subject[subject.length - 1];
  const plural = /s$/.test(last) && !/(ss|us|is)$/.test(last);
  const verb = plural ? stem : thirdPerson(stem);

  const candidate = ['the', subject.join(' '), 'still', verb, tail.join(' ')]
    .filter(Boolean)
    .join(' ');
  return refuse(candidate) ? undefined : candidate;
}

/**
 * The plain form of a word if it is one of the verbs we know, else nothing.
 * @param {string} word
 * @returns {string|undefined}
 */
function verbStem(word) {
  const tries = [
    word,
    word.replace(/s$/, ''),
    word.replace(/es$/, ''),
    word.replace(/ies$/, 'y'),
    word.replace(/ing$/, ''),
    word.replace(/ing$/, 'e'),
    word.replace(/ed$/, ''),
  ];
  for (const t of tries) if (t && VERBS.has(t)) return t;
  return undefined;
}

/**
 * Split an identifier or phrase into lower-case words.
 * @param {string} s
 * @returns {string[]}
 */
function splitWords(s) {
  return String(s)
    .replace(/[_.\-#]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * "collapse" -> "collapses", "apply" -> "applies", "match" -> "matches".
 * Already-conjugated verbs are left alone.
 * @param {string} word
 * @returns {string}
 */
function thirdPerson(word) {
  if (/s$/.test(word) && !/(ss|us|is)$/.test(word)) return word;
  if (/(s|x|z|ch|sh|o)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}
