/**
 * Reading a Python project without running any of it.
 *
 * Two of this tool's adapters never read a line of the product's source: the process adapter
 * runs a command and compares what it printed, and the HTTP adapter boots a server on a
 * spare port and asks it for routes. Neither one cares what language anything is written in.
 * So a Flask app was always checkable here, and the tool turned it away anyway — it said "a
 * Python project is in a language nothing here drives", which was true of the source reader
 * and false of everything else, and the person went away with nothing.
 *
 * What was actually missing was the addresses. The HTTP adapter can only ask for routes
 * somebody found first, and the JavaScript reader cannot see a Python one. This file finds
 * them, and it finds nothing else: it does not read what a view returns, what a function
 * does, or what any of it means. That limit is real and is reported by name rather than
 * quietly folded into a clean result.
 *
 * The addresses come out in the same shape the rest of the tool already uses, so a part of
 * an address that changes reads as ":pid" whether it was written for Flask, for FastAPI or
 * for Django — and the flow that asks a person for one real value works unchanged.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';

/** @typedef {import('./source.js').Door} Door */

/** Folders that never hold a route, and would cost a great deal to walk. */
const SKIP_DIRS = new Set([
  '.git', '.venv', 'venv', 'env', '__pycache__', 'site-packages', 'node_modules',
  'migrations', 'build', 'dist', '.tox', '.mypy_cache', '.pytest_cache', '.eggs',
  'static', 'staticfiles', 'media', '.staysfixed',
]);

/** The verbs Flask and FastAPI hang a route off directly. */
const VERB_DECORATORS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/** What a route reads as when nothing in the code says which verb it answers. */
const METHOD_UNKNOWN = 'ANY';

/** The calls that put an address into a Django urlpatterns list. */
const DJANGO_CALLS = new Set(['path', 're_path', 'url']);

/** How many Python files to open before stopping, and how big one may be. */
const MOST_FILES = 400;
const MOST_BYTES = 2_000_000;

/**
 * Blank out comments and docstrings, keeping every newline so line numbers still line up.
 *
 * Not optional. A docstring showing somebody how to use the library is full of example
 * route decorators, and reading those as real routes would put addresses in the report that
 * the product does not serve — which is worse than finding none at all.
 *
 * @param {string} text
 * @returns {string}
 */
export function withoutCommentsAndDocstrings(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '#') {
      while (i < n && text[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = text.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        const close = text.indexOf(triple, i + 3);
        const end = close === -1 ? n : close + 3;
        for (let j = i; j < end; j++) out += text[j] === '\n' ? '\n' : ' ';
        i = end;
        continue;
      }
      out += c;
      i++;
      let escaped = false;
      while (i < n) {
        const d = text[i];
        out += d;
        i++;
        if (escaped) { escaped = false; continue; }
        if (d === '\\') { escaped = true; continue; }
        if (d === c || d === '\n') break;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Index of the bracket closing the one at `open`, or -1 when the file does not balance.
 * Quotes are stepped over, because an address is allowed to contain a bracket.
 * @param {string} text
 * @param {number} open
 */
function matchParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c) { if (text[i] === '\\') i++; i++; }
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** The line a character offset falls on, counting from 1. @param {string} text @param {number} at */
function lineAt(text, at) {
  let line = 1;
  for (let i = 0; i < at && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * The first plain string written inside a call's brackets, when the first thing given is one.
 * A name, an f-string or anything worked out while it runs answers null, because a route
 * whose address is assembled at run time is a door we know is there and cannot name.
 * @param {string} args
 * @returns {string|null}
 */
function firstString(args) {
  const found = /^\s*(?:r|rb|br|R)?(['"])((?:[^'"\\]|\\.)*)\1/.exec(args);
  return found ? found[2] : null;
}

/** Every string in a `name=[...]` list inside a call's brackets. @param {string} args @param {string} key */
function stringsNamed(args, key) {
  const list = new RegExp(`\\b${key}\\s*=\\s*[\\[(]([^\\])]*)[\\])]`).exec(args);
  if (!list) return [];
  return [...list[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/** A single `name='value'` string inside a call's brackets. @param {string} args @param {string} key */
function stringNamed(args, key) {
  const found = new RegExp(`\\b${key}\\s*=\\s*(['"])((?:[^'"\\\\]|\\\\.)*)\\1`).exec(args);
  return found ? found[2] : null;
}

/**
 * Rewrite the parts of an address that change into the one shape this tool asks about.
 *
 * Flask and Django spell a changing part one way, FastAPI another, and the tool already has
 * a flow that says "a real value for pid — somebody has to". Turning all of them into that
 * spelling is what lets a Flask route reach that flow without a line of it being rewritten.
 *
 * @param {string} raw
 * @returns {string}
 */
export function changingParts(raw) {
  return raw
    .replace(/<\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*:\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*>/g, (_all, name) => `:${name}`)
    .replace(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^}]*)?\}/g, (_all, name) => `:${name}`);
}

/**
 * An address out of a Django regular expression, or null when it cannot be read plainly.
 *
 * Anything with regex punctuation still in it after the named groups come out is refused.
 * A route reported as `/archive/[0-9]{4}` is an address nobody can ask for, and putting one
 * in the list would mean the tool asking for it, getting a 404, and calling the product
 * broken. Missing it is the lesser wrong, and the count of what was refused is reported.
 *
 * @param {string} raw
 * @returns {string|null}
 */
export function addressFromRegex(raw) {
  const named = raw.replace(/\(\?P<([A-Za-z_][A-Za-z0-9_]*)>[^)]*\)/g, (_all, name) => `:${name}`);
  const bare = named.replace(/^\^/, '').replace(/\$$/, '');
  if (/[\\[\]()*+?|^$]/.test(bare)) return null;
  return bare;
}

/**
 * Join a mount point and an address without doubling or losing the slash between them.
 * @param {string} prefix
 * @param {string} rest
 */
function joinRoute(prefix, rest) {
  const left = (prefix ?? '').replace(/\/+$/, '');
  const right = rest.startsWith('/') ? rest : `/${rest}`;
  const joined = `${left}${right}`;
  return joined.startsWith('/') ? joined : `/${joined}`;
}

/**
 * A route this product really answers on, or null.
 * Same standard of care the JavaScript reader holds itself to: a string that merely looks
 * like an address is not one, and it is better to miss a route than to invent one.
 * @param {string} value
 */
function usableRoute(value) {
  if (value.length > 120) return null;
  if (/[\\<>{}()\s]/.test(value)) return null;
  return value;
}

/**
 * @param {string} name
 * @param {string} detail
 * @param {string} file
 * @param {number} line
 * @param {boolean} inTest
 * @param {string} via
 * @returns {Door}
 */
function routeDoor(name, detail, file, line, inTest, via) {
  return { kind: 'route', name, detail, file, line, inTest, named: true, via };
}

/** @param {string} rel */
function looksLikeATest(rel) {
  const where = rel.split(path.sep).join('/');
  return /(^|\/)(tests?|__tests__|e2e|fixtures)\//.test(where) || /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(where);
}

/**
 * Every Python file in a project, bounded, with its text.
 * @param {string} root
 * @returns {Promise<{files: {rel: string, text: string}[], problems: string[]}>}
 */
async function collectPython(root) {
  /** @type {{rel: string, text: string}[]} */
  const files = [];
  /** @type {string[]} */
  const problems = [];
  /** @param {string} here @param {number} depth @returns {Promise<void>} */
  const walk = async (here, depth) => {
    if (files.length >= MOST_FILES || depth > 6) return;
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await fsp.readdir(here, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MOST_FILES) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const full = path.join(here, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
        continue;
      }
      if (!entry.name.endsWith('.py')) continue;
      const rel = path.relative(root, full);
      try {
        const stat = await fsp.stat(full);
        if (stat.size > MOST_BYTES) {
          problems.push(`${rel} is bigger than this reader will open, so any route in it is invisible to this run.`);
          continue;
        }
        files.push({ rel, text: await fsp.readFile(full, 'utf8') });
      } catch (error) {
        problems.push(`${rel} could not be opened: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  await walk(root, 0);
  return { files, problems };
}

/**
 * What one Python file says about itself.
 *
 * @typedef {object} PythonFileReading
 * @property {Door[]} doors
 * @property {Set<string>} frameworks     'flask', 'fastapi' or 'django', when the imports say so.
 * @property {{variable: string, framework: string}[]} apps   Names holding a web application.
 * @property {number} refused             Addresses seen and deliberately not claimed.
 */

/**
 * Read one Python file.
 *
 * @param {string} rel
 * @param {string} raw
 * @param {Record<string, string>} mountedAt   Module path to the address it is included at.
 * @returns {PythonFileReading}
 */
export function readPythonFile(rel, raw, mountedAt = {}) {
  const text = withoutCommentsAndDocstrings(raw);
  const inTest = looksLikeATest(rel);
  /** @type {Door[]} */
  const doors = [];
  /** @type {Set<string>} */
  const frameworks = new Set();
  /** @type {{variable: string, framework: string}[]} */
  const apps = [];
  let refused = 0;

  if (/\bfrom\s+flask\b|\bimport\s+flask\b/i.test(text)) frameworks.add('flask');
  if (/\bfrom\s+fastapi\b|\bimport\s+fastapi\b/i.test(text)) frameworks.add('fastapi');
  if (/\bfrom\s+django\b|\bimport\s+django\b|\bdjango\.urls\b/i.test(text)) frameworks.add('django');

  // Which names hold something routes can be hung off, and what each one is mounted under.
  // A router built with a prefix serves every one of its routes under that prefix, and a
  // report that left the prefix off would name addresses the product answers 404 on.
  /** @type {Map<string, string>} */
  const prefixOf = new Map();
  const factory = /(^|\n)[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:[A-Za-z_][A-Za-z0-9_.]*\.)?(Flask|FastAPI|APIRouter|Blueprint)[ \t]*\(/g;
  for (let found = factory.exec(text); found; found = factory.exec(text)) {
    const open = text.indexOf('(', found.index + found[0].length - 1);
    const close = matchParen(text, open);
    const args = close === -1 ? '' : text.slice(open + 1, close);
    const variable = found[2];
    const built = found[3];
    prefixOf.set(variable, stringNamed(args, 'prefix') ?? stringNamed(args, 'url_prefix') ?? '');
    if (built === 'Flask') { frameworks.add('flask'); apps.push({ variable, framework: 'flask' }); }
    if (built === 'FastAPI') { frameworks.add('fastapi'); apps.push({ variable, framework: 'fastapi' }); }
  }

  // Route decorators: the line above a function that says which address reaches it.
  const decorator = /(^|\n)[ \t]*@[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*\.[ \t]*([A-Za-z_]+)[ \t]*\(/g;
  for (let found = decorator.exec(text); found; found = decorator.exec(text)) {
    const receiver = found[2];
    const verb = found[3];
    const isRoute = verb === 'route' || VERB_DECORATORS.has(verb);
    if (!isRoute) continue;
    // A receiver has to have been built from a framework, or be one of the two names every
    // Flask and FastAPI tutorial uses in a file that imports one. Without this an ordinary
    // decorator such as a cache or a retry helper would start producing routes.
    const proven = prefixOf.has(receiver);
    const conventional = frameworks.size > 0 && ['app', 'router', 'api', 'bp', 'blueprint'].includes(receiver);
    if (!proven && !conventional) continue;

    const open = found.index + found[0].length - 1;
    const close = matchParen(text, open);
    if (close === -1) continue;
    const args = text.slice(open + 1, close);
    const written = firstString(args);
    if (written === null) { refused++; continue; }
    const address = usableRoute(joinRoute(prefixOf.get(receiver) ?? '', changingParts(written)));
    if (address === null) { refused++; continue; }

    const line = lineAt(text, found.index + (found[1] ? 1 : 0));
    const listed = stringsNamed(args, 'methods');
    const verbs = verb === 'route'
      ? (listed.length > 0 ? listed.map((m) => m.toUpperCase()) : ['GET'])
      : [verb.toUpperCase()];
    for (const method of verbs) doors.push(routeDoor(address, method, rel, line, inTest, 'a route decorator in the Python source'));
  }

  // Django keeps its addresses in a list instead, and the list is the only place they are.
  const patterns = /\burlpatterns\b[ \t]*\+?=[ \t]*\[/g;
  for (let found = patterns.exec(text); found; found = patterns.exec(text)) {
    const open = text.indexOf('[', found.index);
    const close = matchParen(text, open);
    if (close === -1) continue;
    const body = text.slice(open + 1, close);
    const mounted = mountedAt[moduleNameOf(rel)] ?? '';
    const call = /\b(path|re_path|url)[ \t]*\(/g;
    for (let one = call.exec(body); one; one = call.exec(body)) {
      if (!DJANGO_CALLS.has(one[1])) continue;
      const openCall = one.index + one[0].length - 1;
      const closeCall = matchParen(body, openCall);
      if (closeCall === -1) continue;
      const args = body.slice(openCall + 1, closeCall);
      const written = firstString(args);
      if (written === null) { refused++; continue; }
      // A line that mounts another module's addresses is not itself an address.
      if (/\binclude\s*\(/.test(args)) continue;
      const plain = one[1] === 'path' ? changingParts(written) : addressFromRegex(written);
      if (plain === null) { refused++; continue; }
      const address = usableRoute(joinRoute(mounted, plain));
      if (address === null) { refused++; continue; }
      const line = lineAt(text, open + 1 + one.index);
      // Django hands every verb to the same view and the view decides, so nothing in the
      // list says which one answers. Writing GET here would be putting a fact in the report
      // that is not in the code.
      doors.push(routeDoor(address, METHOD_UNKNOWN, rel, line, inTest, 'the urlpatterns list'));
    }
  }

  return { doors, frameworks, apps, refused };
}

/** The dotted module name a file would be imported as. @param {string} rel */
function moduleNameOf(rel) {
  return rel.split(path.sep).join('/').replace(/\.py$/, '').replace(/\/__init__$/, '').split('/').join('.');
}

/**
 * Where each Django app's addresses are mounted, read out of the include() calls.
 * @param {{rel: string, text: string}[]} files
 * @returns {Record<string, string>}
 */
function includePrefixes(files) {
  /** @type {Record<string, string>} */
  const mounted = {};
  for (const one of files) {
    const text = withoutCommentsAndDocstrings(one.text);
    const call = /\bpath[ \t]*\(\s*(['"])((?:[^'"\\]|\\.)*)\1\s*,\s*include\s*\(\s*(['"])((?:[^'"\\]|\\.)*)\3/g;
    for (let found = call.exec(text); found; found = call.exec(text)) {
      mounted[found[4].replace(/\.urls$/, '.urls')] = `/${found[2]}`.replace(/\/+/g, '/');
    }
  }
  return mounted;
}

/**
 * Everything this reader can say about a Python project.
 *
 * @typedef {object} PythonReading
 * @property {Door[]} doors
 * @property {string[]} problems
 * @property {number} filesRead
 * @property {string[]} frameworks     Web frameworks actually imported, by name.
 * @property {string|null} appFile     The file holding the application object.
 * @property {string|null} appTarget   What a server would be pointed at: 'app:app'.
 * @property {string|null} managePy    Django's own entry point, when there is one.
 * @property {string[]} entries        Files that look like a command somebody types.
 * @property {number} refused          Addresses seen and deliberately not claimed.
 */

/**
 * Read a whole Python project.
 * @param {string} root
 * @returns {Promise<PythonReading>}
 */
export async function readPython(root) {
  const { files, problems } = await collectPython(root);
  const mountedAt = includePrefixes(files);

  /** @type {Door[]} */
  const doors = [];
  /** @type {Set<string>} */
  const frameworks = new Set();
  let appFile = null;
  let appTarget = null;
  let managePy = null;
  let refused = 0;
  /** @type {string[]} */
  const entries = [];

  for (const one of files) {
    const reading = readPythonFile(one.rel, one.text, mountedAt);
    doors.push(...reading.doors);
    for (const name of reading.frameworks) frameworks.add(name);
    refused += reading.refused;
    if (!appFile && reading.apps.length > 0) {
      appFile = one.rel;
      appTarget = `${moduleNameOf(one.rel)}:${reading.apps[0].variable}`;
    }
    const base = path.basename(one.rel);
    if (base === 'manage.py') managePy = one.rel;
    // A file somebody types the name of. Both halves have to agree, because a module that
    // merely reads sys.argv could be a helper nobody ever runs directly.
    const looksTyped = /^(cli|main|__main__|run|manage|app)\.py$/.test(base);
    const readsArgv = /\bsys\.argv\b|\bargparse\b|\bclick\b|\btyper\b/.test(one.text);
    if (looksTyped && readsArgv && !looksLikeATest(one.rel)) entries.push(one.rel);
  }

  doors.sort((a, b) => a.name.localeCompare(b.name) || a.detail.localeCompare(b.detail) || a.file.localeCompare(b.file));

  return {
    doors: doors.filter((d) => !d.inTest),
    problems,
    filesRead: files.length,
    frameworks: [...frameworks],
    appFile,
    appTarget,
    managePy,
    entries,
    refused,
  };
}

/**
 * The routes of a Python project, in the shape the rest of the tool reads doors in.
 * @param {string} root
 * @returns {Promise<{doors: Door[], problems: string[]}>}
 */
export async function readPythonRoutes(root) {
  try {
    const reading = await readPython(root);
    const problems = [...reading.problems];
    if (reading.refused > 0) {
      const many = reading.refused !== 1;
      problems.push(`${reading.refused} Python address${many ? 'es were' : ' was'} written in a way this reader could not turn into an address anybody can ask for — built while it runs, or a regular expression with more than a name in it — so ${many ? 'they are' : 'it is'} not in the route list and nothing here watches ${many ? 'them' : 'it'}.`);
    }
    return { doors: reading.doors, problems };
  } catch (error) {
    return { doors: [], problems: [`The Python source could not be read: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
