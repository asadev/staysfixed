/**
 * The contract, read straight out of the code. Nothing runs.
 *
 * This is the cheapest and the most exact of the seven channels, and it is the one no
 * screenshot tool has ever had. A picture can only show you a door somebody happened to
 * open. The source shows you every door there is: every IPC channel the desktop app
 * answers on, every route the server serves, every function the library exports, every
 * command the CLI accepts, every environment variable it reads. Delete one by accident and
 * this channel says so in milliseconds, without booting anything.
 *
 * HOW IT READS. Not with a regular expression over raw text — that counts the word
 * `ipcMain` inside a comment, inside a string, and inside a block of code somebody
 * commented out three months ago. It runs a small lexer that knows what a comment is, what
 * a string is and what a regular expression is, and then matches patterns over the TOKENS.
 * The difference is not academic: on Terminal Deck it changes the answer, and it resolves
 * the hundred-odd registrations whose channel name sits on the next line or behind a
 * constant, which a line-based search cannot see at all.
 *
 * WHAT IT STILL CANNOT SEE, measured rather than guessed — see `report` on every reading:
 *   - a channel whose name is built while the program runs. Counted and reported as a door
 *     with no readable name, never silently dropped.
 *   - a registration made through somebody's own wrapper function.
 *   - routes a framework builds out of the filesystem, unless it is one of the two layouts
 *     this file knows (Next.js app and pages routes are; a bespoke one is not).
 *   - dead code. If it is written, it is counted, because "is this reachable" is a question
 *     only running it can answer, and this file never runs anything.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import nodeModule from 'node:module';
import { defineAdapter, joinPath, notCovered, observation } from './contract.js';

// ---------------------------------------------------------------------------
// The lexer
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Token
 * @property {'name'|'punct'|'string'|'template'|'number'|'regex'} t
 * @property {string} v      For a string, the text it holds. For everything else, the source.
 * @property {number} line   1-based.
 * @property {boolean} [built]  A template with a substitution in it: part of this value is
 *                            worked out while the program runs, so `v` is not the whole
 *                            story and must never be treated as a name. Carried as a flag
 *                            rather than as a marker inside `v`, because a marker inside the
 *                            text is a marker some real string will eventually collide with.
 */

/** Words after which a slash starts a regular expression rather than a division. */
const REGEX_MAY_FOLLOW = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else',
  'yield', 'await', 'case', 'throw',
]);

const PUNCT3 = ['...', '===', '!==', '**=', '<<=', '>>=', '&&=', '||=', '??=', '>>>'];
const PUNCT2 = [
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=',
  '%=', '&=', '|=', '^=', '<<', '>>', '**',
];

/** The one-letter escapes, written this way so the table itself stays readable. */
const SIMPLE_ESCAPES = /** @type {Record<string, string>} */ ({
  n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0',
});

/**
 * Turn source text into tokens, throwing away comments.
 *
 * Two deliberate safety valves, both there because this lexer is pointed at TypeScript and
 * at JSX, neither of which it fully understands:
 *
 *   - a quoted string that reaches the end of its line without closing is not a string. It
 *     is almost always an apostrophe in JSX text ("don't"), so the quote is emitted as
 *     punctuation and lexing carries on from the next character. Without this one rule a
 *     single apostrophe swallows the rest of the file.
 *   - the same for a regular expression, which also cannot legally contain a newline. That
 *     is what stops a JSX closing tag being read as the start of one.
 *
 * Both recoveries are counted, and the count is reported, because a file that needed twenty
 * of them was probably not read properly and you deserve to know.
 *
 * @param {string} text
 * @returns {{tokens: Token[], recoveries: number}}
 */
export function lex(text) {
  /** @type {Token[]} */
  const tokens = [];
  let i = 0;
  let line = 1;
  let recoveries = 0;
  const n = text.length;

  /** Whether a slash here opens a regular expression or divides. */
  const regexCanStart = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.t === 'name') return REGEX_MAY_FOLLOW.has(prev.v);
    if (prev.t === 'number' || prev.t === 'string' || prev.t === 'template' || prev.t === 'regex') return false;
    // Punctuation: a closing bracket usually ends a value, so a slash after it divides.
    return !(prev.v === ')' || prev.v === ']');
  };

  while (i < n) {
    const c = text[i];

    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

    // Comments — dropped entirely. This is most of the reason to lex at all.
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }

    // Strings.
    if (c === '"' || c === "'") {
      const start = i;
      const startLine = line;
      let out = '';
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = text[j];
        if (d === '\\') { out += readEscape(text, j); j += escapeLength(text, j); continue; }
        if (d === '\n') break;              // not a string after all — see the note above
        if (d === c) { closed = true; j++; break; }
        out += d;
        j++;
      }
      if (!closed) { recoveries++; tokens.push({ t: 'punct', v: c, line: startLine }); i = start + 1; continue; }
      tokens.push({ t: 'string', v: out, line: startLine });
      i = j;
      continue;
    }

    // Template literals. A template with a substitution in it is marked as such rather than
    // guessed at, so a channel name built at run time reads as "there is a door here, we
    // cannot name it" instead of as a channel called nothing.
    if (c === '`') {
      const startLine = line;
      let j = i + 1;
      let out = '';
      let simple = true;
      let depth = 0;
      while (j < n) {
        const d = text[j];
        if (d === '\\') { out += readEscape(text, j); j += escapeLength(text, j); continue; }
        if (d === '\n') { line++; if (depth === 0) out += d; j++; continue; }
        if (d === '$' && text[j + 1] === '{') { simple = false; depth++; j += 2; continue; }
        if (depth > 0) {
          if (d === '{') depth++;
          else if (d === '}') depth--;
          j++;
          continue;
        }
        if (d === '`') { j++; break; }
        out += d;
        j++;
      }
      tokens.push(simple
        ? { t: 'template', v: out, line: startLine }
        : { t: 'template', v: out, line: startLine, built: true });
      i = j;
      continue;
    }

    // Regular expressions.
    if (c === '/' && regexCanStart()) {
      const start = i;
      const startLine = line;
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = text[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;             // cannot happen in a real regex — recover
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { closed = true; j++; break; }
        j++;
      }
      if (!closed) { recoveries++; tokens.push({ t: 'punct', v: '/', line: startLine }); i = start + 1; continue; }
      while (j < n && /[a-z]/.test(text[j])) j++;
      tokens.push({ t: 'regex', v: text.slice(start, j), line: startLine });
      i = j;
      continue;
    }

    // Names, including keywords.
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++;
      tokens.push({ t: 'name', v: text.slice(i, j), line });
      i = j;
      continue;
    }

    // Numbers, roughly. Nothing here depends on reading them precisely.
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxXoObBnE._]/.test(text[j])) j++;
      tokens.push({ t: 'number', v: text.slice(i, j), line });
      i = j;
      continue;
    }

    const three = text.slice(i, i + 3);
    if (PUNCT3.includes(three)) { tokens.push({ t: 'punct', v: three, line }); i += 3; continue; }
    const two = text.slice(i, i + 2);
    if (PUNCT2.includes(two)) { tokens.push({ t: 'punct', v: two, line }); i += 2; continue; }
    tokens.push({ t: 'punct', v: c, line });
    i++;
  }

  return { tokens, recoveries };
}

/** @param {string} text @param {number} at */
function escapeLength(text, at) {
  const next = text[at + 1];
  if (next === 'x') return 4;
  if (next === 'u') {
    if (text[at + 2] === '{') {
      const close = text.indexOf('}', at);
      return close === -1 ? 2 : close - at + 1;
    }
    return 6;
  }
  return 2;
}

/** @param {string} text @param {number} at */
function readEscape(text, at) {
  const next = text[at + 1];
  if (next !== undefined && next in SIMPLE_ESCAPES) return SIMPLE_ESCAPES[next];
  if (next === 'x') return String.fromCharCode(parseInt(text.slice(at + 2, at + 4), 16) || 0);
  if (next === 'u') {
    if (text[at + 2] === '{') {
      const close = text.indexOf('}', at);
      if (close === -1) return '';
      return String.fromCodePoint(parseInt(text.slice(at + 3, close), 16) || 0);
    }
    return String.fromCharCode(parseInt(text.slice(at + 2, at + 6), 16) || 0);
  }
  return next ?? '';
}

// ---------------------------------------------------------------------------
// What a project's code can hold
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Door
 * @property {'ipc'|'route'|'export'|'command'|'env'} kind
 * @property {string} name            The channel, the route, the exported name.
 * @property {string} detail          'answers with a value', 'GET', 'a function taking (a, b)'.
 * @property {string} file            Relative to the project root.
 * @property {number} line
 * @property {boolean} inTest         Found in a test file. A test's fake registration is not
 *                                    a door the product answers on, so these are counted
 *                                    separately and left out by default.
 * @property {boolean} named          False when the name is built while the program runs and
 *                                    all we know is that a door is there.
 * @property {string} via             How the name was worked out: 'literal', 'a constant', …
 */

/**
 * @typedef {object} ReadingReport
 * @property {number} filesRead
 * @property {number} filesSkipped
 * @property {number} testFiles
 * @property {number} lexRecoveries   Times the lexer had to back out of a string or a regex.
 * @property {number} typesStripped   Files whose TypeScript types Node stripped for us.
 * @property {number} unnamed         Doors that exist but whose name is built at run time.
 * @property {number} viaConstant     Names that came from a constant rather than a literal.
 * @property {number} duplicates      Doors registered more than once where that is a bug —
 *                                    a second `ipcMain.handle` on one channel, or two routes
 *                                    on one verb and path. Legal repeats are not counted.
 * @property {string[]} problems      Files that could not be read, one line each.
 * @property {Record<string, number>} counts   Doors by kind, product code only.
 */

/**
 * @typedef {object} ContractReading
 * @property {Door[]} doors
 * @property {ReadingReport} report
 */

const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);

/** Folders never worth reading. Build output is a copy of the source with worse names. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'release', 'coverage', '.next', '.turbo',
  '.staysfixed', '.cache', 'vendor', '__snapshots__', '.venv', 'venv',
]);

/** The folders a project's own code normally lives in. */
const SOURCE_FOLDERS = ['src', 'lib', 'app', 'bin', 'server', 'pages', 'api', 'electron', 'main', 'packages'];

/** Everything Electron answers a renderer on. */
const IPC_METHODS = new Set(['handle', 'on', 'handleOnce', 'once', 'addListener']);

/** The verbs a web framework hangs a route off. */
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);

/**
 * Receiver names accepted as a router without proof. Anything else has to have been
 * assigned from a framework factory somewhere in the same file.
 */
const ROUTER_NAMES = new Set(['app', 'router', 'server', 'fastify', 'api', 'routes']);

/** @param {string} file */
export function looksLikeATest(file) {
  const normalised = file.split(path.sep).join('/');
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalised) ||
    /(^|\/)(__tests__|__mocks__|tests?|e2e|fixtures)\//.test(normalised)
  );
}

// ---------------------------------------------------------------------------
// Reading one file
// ---------------------------------------------------------------------------

/**
 * A name that pointed at a constant which may live in another file.
 * @typedef {{unresolved: string}} Pending
 */

/** @typedef {Omit<Door, 'name'> & {name: string|Pending}} RawDoor */

/**
 * @typedef {object} FileReading
 * @property {RawDoor[]} doors
 * @property {Map<string, string>} constants   String constants this file exports, for the
 *                                            cross-file pass. Only exported ones travel.
 * @property {number} recoveries
 * @property {boolean} typesStripped
 */

/**
 * Read one file's doors. A name pointing at a constant defined elsewhere comes back
 * pending, and {@link readContract} fills it in once every file has been read.
 *
 * @param {string} relFile   Path relative to the project root, for reporting.
 * @param {string} text
 * @returns {FileReading}
 */
export function readFile(relFile, text) {
  const extension = path.extname(relFile);
  let source = text;
  let typesStripped = false;
  // Node can strip TypeScript types for us, which takes generics and annotations out of the
  // way and gives the lexer a cleaner run at deciding what a slash means. It cannot handle
  // JSX, so .tsx keeps its types and takes its chances — the lexer copes, it just works
  // harder, and the recovery count says how hard.
  const stripper = nodeModule.stripTypeScriptTypes;
  if (typeof stripper === 'function' && (extension === '.ts' || extension === '.mts' || extension === '.cts')) {
    // Which modes Node accepts has changed between releases, so try each and take the first
    // that works rather than pinning to one and silently getting nothing.
    for (const mode of /** @type {const} */ (['strip', 'transform'])) {
      try {
        source = stripper(text, { mode });
        typesStripped = true;
        break;
      } catch {
        source = text;
      }
    }
  }

  const { tokens, recoveries } = lex(source);
  const inTest = looksLikeATest(relFile);

  /** @type {Map<string, string>} Every `const X = 'literal'` in this file, at any depth. */
  const constants = new Map();
  /** @type {Map<string, string>} The subset of those that this file exports. */
  const exportedConstants = new Map();
  /** @type {Set<string>} Names proven to be a router by what they were assigned. */
  const routers = new Set();
  // A receiver called `app` or `api` only counts as a router in a file that actually pulls
  // in a web framework. Without this rule `api.get(id)` — a perfectly ordinary getter, and
  // Terminal Deck has one — is read as a route called whatever `id` happens to hold.
  const hasWebFramework = /\b(express|fastify|hono|koa|polka|connect|node:http|node:https)\b/.test(text);
  /** @type {Set<string>} Names proven to be Electron's ipcMain. */
  const ipcNames = new Set(['ipcMain']);

  // First sweep: learn this file's vocabulary. Constants and aliases both have to be known
  // before the registrations that use them are read, and they are not always written first.
  for (let i = 0; i + 3 < tokens.length; i++) {
    const t = tokens[i];
    if (t.t !== 'name' || (t.v !== 'const' && t.v !== 'let' && t.v !== 'var')) continue;
    const target = tokens[i + 1];
    const equals = tokens[i + 2];
    if (target.t !== 'name' || equals.v !== '=') continue;
    const value = tokens[i + 3];
    if ((value.t === 'string' || value.t === 'template') && !value.built) {
      constants.set(target.v, value.v);
      if (tokens[i - 1]?.v === 'export') exportedConstants.set(target.v, value.v);
    } else if (value.t === 'name' && ipcNames.has(value.v) && tokens[i + 4]?.v !== '.') {
      ipcNames.add(target.v);
    } else if (isRouterFactory(tokens, i + 3)) {
      routers.add(target.v);
    }
  }

  /** @type {RawDoor[]} */
  const doors = [];

  /** @param {string} raw @returns {{name: string|Pending, via: string}} */
  const fromConstant = (raw) => {
    const known = constants.get(raw);
    if (known !== undefined) return { name: known, via: 'a constant in the same file' };
    return { name: { unresolved: raw }, via: 'a constant from another file' };
  };

  for (let i = 0; i + 2 < tokens.length; i++) {
    const receiver = tokens[i];
    const dot = tokens[i + 1];
    const method = tokens[i + 2];
    if (receiver.t !== 'name' || (dot.v !== '.' && dot.v !== '?.') || method.t !== 'name') continue;

    // process.env.SOMETHING — the settings a product silently depends on.
    if (receiver.v === 'process' && method.v === 'env') {
      const after = tokens[i + 3];
      const name = tokens[i + 4];
      if (after?.v === '.' && name?.t === 'name') {
        doors.push(door('env', name.v, 'read from the environment', relFile, name.line, inTest, true, 'literal'));
      } else if (after?.v === '[' && name?.t === 'string') {
        doors.push(door('env', name.v, 'read from the environment', relFile, name.line, inTest, true, 'literal'));
      }
      continue;
    }

    const open = tokens[i + 3];
    if (open?.v !== '(') continue;
    const arg = tokens[i + 4];

    // ipcMain.handle('channel', …) — the doors an Electron app answers on.
    if (ipcNames.has(receiver.v) && IPC_METHODS.has(method.v)) {
      const answers = method.v === 'handle' || method.v === 'handleOnce'
        ? 'answers with a value'
        : 'listens, answers nothing';
      if (!arg) continue;
      if ((arg.t === 'string' || arg.t === 'template') && !arg.built) {
        doors.push(door('ipc', arg.v, answers, relFile, arg.line, inTest, true, 'literal'));
      } else if (arg.t === 'name') {
        const found = fromConstant(arg.v);
        doors.push(door('ipc', found.name, answers, relFile, arg.line, inTest, true, found.via));
      } else {
        doors.push(door('ipc', `${relFile}:${arg.line}`, answers, relFile, arg.line, inTest, false,
          arg.t === 'template' ? 'a name built while it runs' : 'a name we could not read'));
      }
      continue;
    }

    const isRouter = routers.has(receiver.v) || (hasWebFramework && ROUTER_NAMES.has(receiver.v));
    if (!isRouter) continue;

    // app.get('/path', …) and friends. Requiring the path to start with a slash is what
    // keeps `app.get('setting')` — a settings getter, not a route — out of the list.
    if (HTTP_METHODS.has(method.v)) {
      if (arg && (arg.t === 'string' || arg.t === 'template') && arg.v.startsWith('/')) {
        doors.push(door('route', arg.v, method.v.toUpperCase(), relFile, arg.line, inTest, true, 'literal'));
      } else if (arg?.t === 'name') {
        const found = fromConstant(arg.v);
        if (typeof found.name === 'string' && !found.name.startsWith('/')) continue;
        doors.push(door('route', found.name, method.v.toUpperCase(), relFile, arg.line, inTest, true, found.via));
      }
      continue;
    }
    if (method.v === 'use' && arg?.t === 'string' && arg.v.startsWith('/')) {
      doors.push(door('route', arg.v, 'MOUNT', relFile, arg.line, inTest, true, 'literal'));
      continue;
    }
    // fastify.route({ method: 'GET', url: '/path' })
    if (method.v === 'route') {
      const end = matchBracket(tokens, i + 3);
      let url = null;
      let verb = 'ANY';
      for (let j = i + 4; j < end; j++) {
        const key = tokens[j];
        if (key.t !== 'name' || tokens[j + 1]?.v !== ':') continue;
        const value = tokens[j + 2];
        if (!value || value.t !== 'string') continue;
        if (key.v === 'url' || key.v === 'path') url = value.v;
        if (key.v === 'method') verb = value.v.toUpperCase();
      }
      if (url) doors.push(door('route', url, verb, relFile, receiver.line, inTest, true, 'literal'));
    }
  }

  // Exports get their own sweep, because `export` is a prefix rather than a receiver.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t !== 'name') continue;
    if (t.v === 'export') { readExport(tokens, i, relFile, inTest, doors); continue; }
    // The CommonJS spelling of the same thing.
    let at = -1;
    if (t.v === 'module' && tokens[i + 1]?.v === '.' && tokens[i + 2]?.v === 'exports') at = i + 2;
    else if (t.v === 'exports' && tokens[i - 1]?.v !== '.') at = i;
    if (at === -1) continue;
    if (tokens[at + 1]?.v === '.' && tokens[at + 2]?.t === 'name' && tokens[at + 3]?.v === '=') {
      const name = tokens[at + 2];
      doors.push(door('export', name.v, describeExport(tokens, at + 4), relFile, name.line, inTest, true, 'literal'));
    }
  }

  // Command-line flags. These are a mention, not a proof — a string that looks like a flag
  // may be one this program accepts or one it passes on to something else. It gets its own
  // wording so nobody mistakes the two.
  for (const token of tokens) {
    if (token.t === 'string' && /^--[a-z0-9][a-z0-9-]*$/i.test(token.v)) {
      doors.push(door('command', token.v, 'a flag this file mentions', relFile, token.line, inTest, true, 'literal'));
    }
  }

  return { doors, constants: exportedConstants, recoveries, typesStripped };
}

/**
 * @param {Door['kind']} kind
 * @param {string|Pending} name
 * @param {string} detail
 * @param {string} file
 * @param {number} line
 * @param {boolean} inTest
 * @param {boolean} named
 * @param {string} via
 * @returns {RawDoor}
 */
function door(kind, name, detail, file, line, inTest, named, via) {
  return { kind, name, detail, file, line, inTest, named, via };
}

/**
 * Is the expression starting at `at` one of the framework factories that hands back
 * something you can hang routes off?
 * @param {Token[]} tokens
 * @param {number} at
 */
function isRouterFactory(tokens, at) {
  const first = tokens[at];
  if (!first) return false;
  if (first.t === 'name' && first.v === 'new') return isRouterFactory(tokens, at + 1);
  if (first.t !== 'name') return false;
  if (/^(express|fastify|Fastify|Router|Hono|polka|connect)$/.test(first.v)) return true;
  // express.Router(), http.createServer()
  return tokens[at + 1]?.v === '.' && /^(Router|createServer)$/.test(tokens[at + 2]?.v ?? '');
}

/**
 * Index of the bracket closing the one at `open`. Returns the end of the token list when
 * the file is unbalanced, which happens in a file the lexer had to recover inside.
 * @param {Token[]} tokens
 * @param {number} open
 */
function matchBracket(tokens, open) {
  const opener = tokens[open]?.v;
  if (opener !== '(' && opener !== '[' && opener !== '{') return open;
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t !== 'punct') continue;
    if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
    else if (t.v === ')' || t.v === ']' || t.v === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

/**
 * Read one `export …`. Handles the shapes that actually appear: a function, a class, a
 * const, a default, a `{ a, b as c }` list, and a re-export.
 * @param {Token[]} tokens
 * @param {number} i
 * @param {string} file
 * @param {boolean} inTest
 * @param {RawDoor[]} out
 */
function readExport(tokens, i, file, inTest, out) {
  let at = i + 1;
  while (tokens[at]?.t === 'name' && (tokens[at].v === 'async' || tokens[at].v === 'declare')) at++;
  const head = tokens[at];
  if (!head) return;

  if (head.v === 'default') {
    out.push(door('export', 'default', describeExport(tokens, at + 1), file, head.line, inTest, true, 'literal'));
    return;
  }
  if (head.v === '{') {
    const end = matchBracket(tokens, at);
    for (let j = at + 1; j < end; j++) {
      const name = tokens[j];
      if (name.t !== 'name' || name.v === 'type') continue;
      let exported = name.v;
      if (tokens[j + 1]?.v === 'as' && tokens[j + 2]?.t === 'name') { exported = tokens[j + 2].v; j += 2; }
      out.push(door('export', exported, 'passed straight through from somewhere else', file, name.line, inTest, true, 'literal'));
      while (j < end && tokens[j].v !== ',') j++;
    }
    return;
  }
  if (head.v === '*') return;                                 // the names live in the other file
  if (head.v === 'type' || head.v === 'interface') return;    // types are not doors

  if (head.v === 'function' || head.v === 'class') {
    let nameAt = at + 1;
    if (tokens[nameAt]?.v === '*') nameAt++;
    const name = tokens[nameAt];
    if (!name || name.t !== 'name') return;
    const detail = head.v === 'class'
      ? `a class with ${methodNames(tokens, nameAt).join(', ') || 'no methods'}`
      : `a function taking (${parameterNames(tokens, nameAt + 1).join(', ')})`;
    out.push(door('export', name.v, detail, file, name.line, inTest, true, 'literal'));
    return;
  }
  if (head.v === 'const' || head.v === 'let' || head.v === 'var') {
    const name = tokens[at + 1];
    if (name?.t !== 'name') return;
    out.push(door('export', name.v, describeExport(tokens, at + 3), file, name.line, inTest, true, 'literal'));
  }
}

/**
 * Say what an exported thing is, in the words a person would use.
 *
 * The exact value is deliberately not recorded for anything but a short literal. A
 * library's API surface is its SHAPE; comparing the contents of an exported object belongs
 * to the results channel, which sees it after the module has actually run and does not have
 * to guess.
 *
 * @param {Token[]} tokens
 * @param {number} at
 */
function describeExport(tokens, at) {
  const t = tokens[at];
  if (!t) return 'something';
  if (t.t === 'string' || t.t === 'template') {
    return t.built ? 'text built while it runs' : `the text "${t.v.slice(0, 60)}"`;
  }
  if (t.t === 'number') return 'a number';
  if (t.t === 'name') {
    if (t.v === 'true' || t.v === 'false') return t.v;
    if (t.v === 'async' || t.v === 'new') return describeExport(tokens, at + 1);
    if (t.v === 'function') {
      const parenAt = tokens[at + 1]?.t === 'name' ? at + 2 : at + 1;
      return `a function taking (${parameterNames(tokens, parenAt).join(', ')})`;
    }
    if (t.v === 'class') return 'a class';
    if (tokens[at + 1]?.v === '=>') return `a function taking (${t.v})`;
    return 'something';
  }
  if (t.v === '(') {
    const end = matchBracket(tokens, at);
    if (tokens[end + 1]?.v === '=>') return `a function taking (${parameterNames(tokens, at).join(', ')})`;
    return 'something';
  }
  if (t.v === '{') return 'an object';
  if (t.v === '[') return 'a list';
  return 'something';
}

/**
 * The parameter names of the list starting at `open`. Destructured and rest parameters are
 * labelled rather than expanded — what changes when somebody breaks an interface is the
 * count and the order, not the shape of a destructure.
 * @param {Token[]} tokens
 * @param {number} open
 */
function parameterNames(tokens, open) {
  if (tokens[open]?.v !== '(') return [];
  const end = matchBracket(tokens, open);
  /** @type {string[]} */
  const names = [];
  let depth = 0;
  let expectName = true;
  for (let i = open + 1; i < end; i++) {
    const t = tokens[i];
    if (t.t === 'punct') {
      if (t.v === '(' || t.v === '[' || t.v === '{') {
        if (depth === 0 && expectName) { names.push(t.v === '{' ? '(an object)' : '(a list)'); expectName = false; }
        depth++;
      } else if (t.v === ')' || t.v === ']' || t.v === '}') {
        depth--;
      } else if (t.v === ',' && depth === 0) {
        expectName = true;
      }
      continue;
    }
    if (depth === 0 && expectName && t.t === 'name') { names.push(t.v); expectName = false; }
  }
  return names;
}

/** Words that are not method names even though a bracket follows them. */
const NOT_A_METHOD = new Set(['constructor', 'if', 'for', 'while', 'switch', 'return', 'catch', 'get', 'set']);

/**
 * The method names of the class whose name sits at `nameAt`. One level deep only.
 * @param {Token[]} tokens
 * @param {number} nameAt
 */
function methodNames(tokens, nameAt) {
  let open = nameAt + 1;
  while (tokens[open] && tokens[open].v !== '{') open++;
  if (!tokens[open]) return [];
  const end = matchBracket(tokens, open);
  /** @type {string[]} */
  const names = [];
  let depth = 0;
  for (let i = open + 1; i < end; i++) {
    const t = tokens[i];
    if (t.t === 'punct') {
      if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
      else if (t.v === ')' || t.v === ']' || t.v === '}') depth--;
      continue;
    }
    if (depth === 0 && t.t === 'name' && tokens[i + 1]?.v === '(' && !NOT_A_METHOD.has(t.v)) names.push(t.v);
  }
  return [...new Set(names)];
}

// ---------------------------------------------------------------------------
// Reading a whole project
// ---------------------------------------------------------------------------

/**
 * Walk a project and read every door out of it.
 *
 * Two passes over the findings, one pass over the disk: files are read and lexed once, and
 * any name that pointed at a constant defined in another file is filled in afterwards from
 * everything that was learned on the way. That is the only way a registration written as
 * `ipcMain.handle(LID_AWAKE_GET, …)` turns into a channel with a real name instead of a
 * shrug — and on Terminal Deck that is a hundred-odd of them.
 *
 * @param {object} opts
 * @param {string} opts.root                  Project root. Only ever read.
 * @param {string[]} [opts.folders]           Subfolders to read. Defaults to the usual ones.
 * @param {boolean} [opts.includeTests]       Count doors found in test files. Default false.
 * @param {number} [opts.maxFileBytes]        Skip anything bigger. Default 24MB — a built
 *   bundle is a legitimate thing to read, and Terminal Deck's is 3.5MB. At the old 2MB
 *   the whole main process was skipped and the reader then said it had found no source
 *   at all, which is the exact shape of failure this tool exists to prevent: a silence
 *   that reads like an all-clear.
 * @returns {Promise<ContractReading>}
 */
export async function readContract(opts) {
  const root = path.resolve(opts.root);
  const maxFileBytes = opts.maxFileBytes ?? 24 * 1024 * 1024;
  const found = await collectFiles(root, opts.folders ?? SOURCE_FOLDERS, maxFileBytes);

  /** @type {RawDoor[]} */
  const all = [];
  /** @type {Map<string, string>} every string constant anywhere in the project */
  const constants = new Map();
  /** @type {Set<string>} names two files define differently */
  const ambiguous = new Set();
  /** @type {ReadingReport} */
  const report = {
    filesRead: 0, filesSkipped: found.skipped, testFiles: 0, lexRecoveries: 0,
    typesStripped: 0, unnamed: 0, viaConstant: 0, duplicates: 0, problems: [], counts: {},
  };

  for (const rel of found.files) {
    let text;
    try {
      text = await fsp.readFile(path.join(root, rel), 'utf8');
    } catch (error) {
      report.problems.push(`${rel} could not be opened: ${describeError(error)}`);
      continue;
    }
    let reading;
    try {
      reading = readFile(rel, text);
    } catch (error) {
      report.problems.push(`${rel} could not be read: ${describeError(error)}`);
      continue;
    }
    report.filesRead++;
    report.lexRecoveries += reading.recoveries;
    if (reading.typesStripped) report.typesStripped++;
    if (looksLikeATest(rel)) report.testFiles++;
    for (const [key, value] of reading.constants) {
      const known = constants.get(key);
      if (known !== undefined && known !== value) ambiguous.add(key);
      else constants.set(key, value);
    }
    all.push(...reading.doors);
  }

  /** @type {Door[]} */
  const resolved = [];
  for (const raw of all) {
    if (typeof raw.name === 'string') {
      resolved.push(/** @type {Door} */ (raw));
      continue;
    }
    const wanted = raw.name.unresolved;
    const known = constants.get(wanted);
    if (known !== undefined && !ambiguous.has(wanted)) {
      resolved.push({ ...raw, name: known, named: true, via: 'a constant from another file' });
    } else {
      // A door we can prove is there but cannot name. Reported as a hole, because dropping
      // it is exactly how a contract list quietly becomes wrong.
      resolved.push({
        ...raw,
        name: `${raw.file}:${raw.line}`,
        named: false,
        via: ambiguous.has(wanted)
          ? `the constant ${wanted}, which two files define differently`
          : `the constant ${wanted}, which was never found`,
      });
    }
  }

  const doors = resolved
    .filter((d) => opts.includeTests || !d.inTest)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.file.localeCompare(b.file) || a.line - b.line);

  report.unnamed = doors.filter((d) => !d.named).length;
  report.viaConstant = doors.filter((d) => d.named && d.via.includes('constant')).length;
  /** @type {Set<string>} */
  const seenNames = new Set();
  for (const d of doors) {
    const key = `${d.kind}:${d.name}:${d.detail}`;
    // Only count a repeat that actually breaks something. An environment variable read in
    // nine files, a flag mentioned in four, two `ipcMain.on` listeners and two modules
    // exporting the same name are all normal; a second `ipcMain.handle` on one channel is
    // refused by Electron at start-up, and a second route on one verb and path never runs.
    const wouldBeABug = (d.kind === 'ipc' && d.detail.startsWith('answers')) || d.kind === 'route';
    if (d.named && wouldBeABug && seenNames.has(key)) report.duplicates++;
    seenNames.add(key);
    report.counts[d.kind] = (report.counts[d.kind] ?? 0) + 1;
  }

  return { doors, report };
}

/** @param {unknown} error */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string} root
 * @param {string[]} folders
 * @param {number} maxFileBytes
 */
async function collectFiles(root, folders, maxFileBytes) {
  /** @type {string[]} Files skipped for size, named so the gap can be reported. */
  const tooBig = [];
  /** @type {string[]} */
  const files = [];
  let skipped = 0;

  /** @param {string} dir */
  const walk = async (dir) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) continue;      // never follow a link back out of the project
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!CODE_EXTENSIONS.has(path.extname(entry.name))) continue;
      if (/\.d\.[cm]?ts$/.test(entry.name)) continue;   // declarations describe, they open nothing
      try {
        // A file too big to read is a hole, and a hole has to be named. Recording the
        // path — not just a count — is what lets the coverage ledger say WHICH door it
        // cannot see rather than quietly reporting fewer of them.
        if ((await fsp.stat(full)).size > maxFileBytes) {
          skipped++;
          tooBig.push(path.relative(root, full));
          continue;
        }
      } catch {
        continue;
      }
      files.push(path.relative(root, full));
    }
  };

  const roots = folders.map((f) => path.join(root, f)).filter((d) => fs.existsSync(d));
  for (const dir of roots.length > 0 ? roots : [root]) await walk(dir);
  files.sort();
  return { files, skipped, tooBig };
}

// ---------------------------------------------------------------------------
// Routes that live in the filesystem rather than in a call
// ---------------------------------------------------------------------------

/**
 * Next.js puts its routes in folder names, so no amount of reading calls will find them.
 * Both layouts are handled: an app folder, where a `route` file's exported method names are
 * the verbs, and a pages/api folder, where the file itself is the route.
 *
 * @param {string} root
 * @returns {Promise<Door[]>}
 */
export async function readFileRoutes(root) {
  /** @type {Door[]} */
  const doors = [];

  /**
   * @param {string} base
   * @param {(rel: string, full: string) => Promise<void>} visit
   */
  const walk = async (base, visit) => {
    if (!fs.existsSync(base)) return;
    /** @type {string[]} */
    const stack = [base];
    while (stack.length > 0) {
      const dir = /** @type {string} */ (stack.pop());
      /** @type {import('node:fs').Dirent[]} */
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push(full);
        } else if (entry.isFile()) {
          await visit(path.relative(base, full), full);
        }
      }
    }
  };

  for (const appDir of ['app', 'src/app']) {
    await walk(path.join(root, appDir), async (rel, full) => {
      if (!/(^|\/)route\.[cm]?[jt]sx?$/.test(rel.split(path.sep).join('/'))) return;
      // A folder in brackets is a grouping, not part of the address; one starting with an
      // underscore is private and is not routed at all.
      const url = '/' + path.dirname(rel)
        .split(path.sep)
        .filter((s) => s !== '.' && !(s.startsWith('(') && s.endsWith(')')) && !s.startsWith('_'))
        .join('/');
      let verbs = ['ANY'];
      try {
        const reading = readFile(path.relative(root, full), await fsp.readFile(full, 'utf8'));
        const named = reading.doors
          .filter((d) => d.kind === 'export' && typeof d.name === 'string' && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(d.name))
          .map((d) => String(d.name));
        if (named.length > 0) verbs = named;
      } catch { /* an unreadable route file is still a route */ }
      for (const verb of verbs) {
        doors.push({
          kind: 'route', name: url === '/' ? '/' : url.replace(/\/$/, ''), detail: verb,
          file: path.relative(root, full), line: 1, inTest: false, named: true,
          via: 'the folder it lives in',
        });
      }
    });
  }

  for (const pagesDir of ['pages/api', 'src/pages/api']) {
    await walk(path.join(root, pagesDir), async (rel, full) => {
      if (!/\.[cm]?[jt]sx?$/.test(rel)) return;
      const stem = rel.replace(/\.[cm]?[jt]sx?$/, '').split(path.sep).join('/');
      doors.push({
        kind: 'route', name: `/api/${stem.replace(/\/?index$/, '')}`, detail: 'ANY',
        file: path.relative(root, full), line: 1, inTest: false, named: true,
        via: 'the folder it lives in',
      });
    });
  }

  return doors;
}

/**
 * The commands a package installs and the entries it exports, straight out of its own
 * package.json. Exact, because npm reads the same field.
 * @param {string} root
 * @returns {Promise<Door[]>}
 */
export async function readPackageCommands(root) {
  /** @type {Door[]} */
  const doors = [];
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
    for (const [name, target] of Object.entries(bin)) {
      doors.push({ kind: 'command', name, detail: `installs as a command, runs ${target}`, file: 'package.json', line: 1, inTest: false, named: true, via: 'package.json' });
    }
    for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
      doors.push({ kind: 'command', name: `npm run ${name}`, detail: String(script), file: 'package.json', line: 1, inTest: false, named: true, via: 'package.json' });
    }
    for (const [name, target] of Object.entries(pkg.exports ?? {})) {
      doors.push({ kind: 'export', name: `the package entry ${name}`, detail: typeof target === 'string' ? target : 'a conditional entry', file: 'package.json', line: 1, inTest: false, named: true, via: 'package.json' });
    }
  } catch { /* not every project is an npm package */ }
  return doors;
}

// ---------------------------------------------------------------------------
// Turning a reading into observations
// ---------------------------------------------------------------------------

/**
 * The path an observation about one door gets.
 *
 * The head names the KIND of door, not the journey that found it. That ordering is what
 * lets the engine cluster twenty missing IPC channels into one finding, and it is why these
 * heads match the ones the engine already knows: `ipc`, `route`, `export`, `cli`, `proc`.
 *
 * An exported name carries its file; a channel, a route, a command and a setting do not,
 * because those are global names and moving one to another file does not change the
 * promise. That distinction is the whole difference between a contract diff that stays
 * quiet through a refactor and one that shouts through it.
 *
 * @param {Door} found
 */
function pathForDoor(found) {
  switch (found.kind) {
    case 'ipc': return joinPath('ipc', found.name, 'registered');
    case 'route': return joinPath('route', found.detail, found.name, 'declared');
    case 'export': return joinPath('export', found.file, found.name);
    case 'command': return joinPath('cli', found.name, 'declared');
    default: return joinPath('proc', 'env', found.name);
  }
}

/** @type {Record<Door['kind'], string>} */
const KIND_LABEL = { ipc: 'ipc channel', route: 'route', export: 'exported', command: 'command', env: 'environment' };

/** @type {Record<Door['kind'], string>} */
const KIND_PHRASE = {
  ipc: 'an IPC channel', route: 'a route', export: 'an exported name',
  command: 'a command', env: 'an environment variable it reads',
};

/**
 * One observation per door, so a difference points at the door that went missing rather
 * than at a list that got shorter. The counts go alongside, because "there are three fewer
 * IPC channels than the build you shipped" is the sentence that makes somebody look.
 *
 * Three kinds of door repeat legitimately and three do not, and the paths are built to
 * match. An environment variable read in nine files is one setting, not nine; a flag
 * mentioned in four files is one flag. But two `ipcMain.handle` calls on the same channel
 * is a bug Electron refuses at start-up, and two routes on the same verb and path means one
 * of them never runs — so those are said out loud. Two `ipcMain.on` listeners are perfectly
 * legal and are not. An exported name is qualified by its file, because two modules
 * exporting `parse` are two different functions.
 *
 * @param {ContractReading} reading
 * @param {string} [journeyId]
 * @returns {import('./contract.js').Observation[]}
 */
export function contractObservations(reading, journeyId = 'the-code') {
  /** @type {import('./contract.js').Observation[]} */
  const out = [];
  /** @type {Map<string, number>} */
  const seen = new Map();

  for (const found of reading.doors) {
    const repeatsAreLegal = found.kind === 'env' || found.kind === 'command'
      || (found.kind === 'ipc' && found.detail.startsWith('listens'));
    const key = `${found.kind}:${found.name}:${found.detail}`;
    const times = (seen.get(key) ?? 0) + 1;
    seen.set(key, times);
    if (times > 1 && repeatsAreLegal) continue;    // one setting, not nine mentions of it

    const suffix = times > 1 ? ` (registered ${times} times — only the last one takes effect)` : '';
    out.push(observation({
      channel: 'contract',
      path: pathForDoor(found),
      value: found.named ? found.detail + suffix : `there, but we cannot read its name${suffix}`,
      says: found.named
        ? `The code opens ${KIND_PHRASE[found.kind]} called "${found.name}" that ${found.detail}.${
            times > 1 ? ' It is registered more than once, which means only the last one has any effect.' : ''}`
        : `The code opens ${KIND_PHRASE[found.kind]} whose name is worked out while it runs, so we know it is there but not what it is called (${found.via}).`,
      covered: found.named ? undefined : false,
      reason: found.named ? undefined : 'not supported here',
      where: { file: found.file, line: found.line },
      journey: journeyId,
    }));
  }

  for (const [kind, count] of Object.entries(reading.report.counts)) {
    const label = KIND_LABEL[/** @type {Door['kind']} */ (kind)] ?? kind;
    out.push(observation({
      channel: 'counters',
      path: joinPath('count', 'contract', label),
      value: count,
      says: `The code has ${count} ${label} ${count === 1 ? 'door' : 'doors'} in it.`,
    }));
  }

  if (reading.report.unnamed > 0) {
    const many = reading.report.unnamed !== 1;
    out.push(notCovered({
      channel: 'contract',
      path: joinPath('count', 'contract', 'doors we cannot name'),
      reason: 'not supported here',
      says: `${reading.report.unnamed} door${many ? 's' : ''} ${many ? 'exist' : 'exists'} whose ${many ? 'names are' : 'name is'} built while the program runs, so a change to ${many ? 'them' : 'it'} would not be seen here.`,
    }));
  }
  for (const problem of reading.report.problems) {
    out.push(notCovered({
      channel: 'contract',
      path: joinPath('contract', 'unreadable', problem.split(' ')[0]),
      reason: 'crashed',
      says: problem,
    }));
  }

  return out;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Which platform this project actually is.
 *
 * Guessed from what it depends on, because the answer is usually obvious from the
 * dependencies and asking a person a question the code already answers is exactly what this
 * tool is supposed to stop. A project can say so outright in its config and be believed.
 *
 * @param {import('./contract.js').AdapterProject} project
 * @returns {import('./contract.js').Surface}
 */
export function surfaceOf(project) {
  if (project.config?.surface) return project.config.surface;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(project.root, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if ('electron' in deps) return 'electron';
    if (['express', 'fastify', 'hono', 'koa', 'next', '@hapi/hapi'].some((n) => n in deps)) return 'server';
    if (pkg.bin) return 'cli';
  } catch { /* no package.json is an answer too */ }
  return 'library';
}

/** @type {ContractReading|null} */
let lastReading = null;

/**
 * The static-contract adapter.
 *
 * It applies to every project, always, because every project has source. It is the one
 * adapter that costs nothing to run and can never break anything, so the engine runs it
 * first and hands its result to the others — the HTTP adapter learns its routes from here
 * rather than by crawling a running server.
 */
export const sourceAdapter = defineAdapter({
  name: 'source',
  title: 'The contract, read out of the code',
  describe:
    "Reads the project's own source without running any of it and lists every door it opens: IPC channels, HTTP routes, exported functions, commands and the environment variables it reads. It cannot see a door whose name is assembled while the program runs, and it cannot tell whether a door is reachable — only that it was written.",
  channels: ['contract', 'counters'],

  /** @param {import('./contract.js').AdapterProject} project */
  async detect(project) {
    const folders = project.config?.folders ?? SOURCE_FOLDERS;
    // The same limit readContract uses. It was 2MB here and 24MB there, so a project
    // whose source is one big bundle was declared to have no source at all — and then
    // never read, even though the reader could have read it perfectly well.
    const found = await collectFiles(project.root, folders, 24 * 1024 * 1024);
    const canStrip = typeof nodeModule.stripTypeScriptTypes === 'function';
    /** @type {import('./contract.js').Missing[]} */
    const missing = [];
    if (!canStrip) {
      missing.push({
        what: 'Node 22.6 or newer',
        unlocks: 'cleaner reading of TypeScript files — without it the type annotations are left in and a few names are read less accurately',
        howToGet: 'upgrade Node; nothing else is needed',
      });
    }
    return {
      applies: found.files.length > 0,
      confidence: found.files.length > 0 ? 1 : 0,
      why: found.files.length > 0
        ? `There are ${found.files.length} source files to read. Nothing gets run, so this costs almost nothing and it cannot break anything.`
        : 'No JavaScript or TypeScript source was found in the usual folders, so there is nothing to read.',
      missing,
      notes: canStrip ? [] : ['TypeScript types are being read as they are, rather than stripped out first.'],
    };
  },

  /** @param {import('./contract.js').AdapterProject} project */
  async journeys(project) {
    return [{
      name: 'the-code',
      describe: 'read every door out of the source without running any of it',
      source: 'code',
      surface: surfaceOf(project),
      channels: ['contract', 'counters'],
      steps: [{ act: 'read', folders: project.config?.folders ?? SOURCE_FOLDERS }],
    }];
  },

  /** @param {import('./contract.js').Build} build */
  async prepare(build) {
    // Nothing to prepare. The source is read where it lies and never written to.
    return {
      build,
      root: build.root,
      ready: true,
      why: 'Reading source needs no preparation and never touches the files.',
      dispose: async () => {},
    };
  },

  /**
   * @param {import('./contract.js').Journey} journey
   * @param {import('./contract.js').PreparedBuild} build
   */
  async run(journey, build) {
    const reading = await readContract({ root: build.root });
    reading.doors.push(...await readFileRoutes(build.root));
    reading.doors.push(...await readPackageCommands(build.root));
    reading.report.counts = {};
    for (const found of reading.doors) {
      reading.report.counts[found.kind] = (reading.report.counts[found.kind] ?? 0) + 1;
    }
    lastReading = reading;
    return contractObservations(reading, journey.name);
  },

  async teardown() {
    lastReading = null;
  },
});

/**
 * The last thing the source adapter read.
 *
 * The HTTP adapter uses this to find its routes without crawling. Anything that cannot
 * guarantee it runs after the source adapter should call {@link readContract} itself rather
 * than depend on run order.
 */
export function lastContractReading() {
  return lastReading;
}
