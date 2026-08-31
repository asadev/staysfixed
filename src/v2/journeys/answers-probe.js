/**
 * Call what a module exports, with fixed inputs, and print the answers.
 *
 * WHY THIS FILE EXISTS. Until 2026-08-31 a library was checked by importing it and writing
 * down the NAMES and SHAPES of what it exported — "slug: a function taking 1 argument". That
 * is a real thing to compare and it is not the thing that breaks. Measured that day on a
 * four-line library: the separator inside `slug` was changed from "-" to "_", so every web
 * address the library produces became a different string, and `isReserved('admin')` went from
 * true to false. Both exports still existed, both still took one argument, so every address
 * agreed and `staysfixed check` answered "Nothing that worked has changed" and exited 0. That
 * is the one answer this tool may never give. Nothing here calls anything, so nothing here
 * could ever have seen it.
 *
 * This program is what closes that hole. It imports the module the same way the shape probe
 * does, calls every exported function it is willing to call with a fixed ladder of inputs,
 * and prints one line per call. The lines are compared like any other output, so a function
 * that starts answering differently changes the text and the check fails with the old answer
 * and the new one side by side.
 *
 * WHY IT IS A FILE AND NOT A STRING. The shape probe is built as one long JavaScript string
 * and handed to `node -e`, wrapped in single quotes. That works on this machine and it makes
 * the code unreadable, and single quotes are not how Windows quotes anything. A file is run
 * by path, reads the same as the rest of the codebase, and can be tested on its own.
 *
 * WHAT KEEPS THIS SAFE. Four things, and none of them is optional:
 *
 *   1. It only ever runs inside the scratch copy the process adapter makes, never in
 *      anybody's working folder, with a stopped clock, a scratch HOME and a scratch temp
 *      folder, and with every outbound connection recorded and then refused at the wire.
 *      That boundary is not this file's doing and this file must never be run outside it.
 *   2. It refuses by name. A function whose name says it deletes, sends, publishes, charges
 *      or migrates is NOT called — it is named in the output as not called, with the reason,
 *      so the hole is visible instead of silent. This is the same generous name-based guess
 *      the tool already makes about routes and commands, made in the same words.
 *   3. It never constructs a class and never reads a property that is really a getter,
 *      because both of those run somebody else's code without the name of the thing being
 *      called ever appearing at the call site.
 *   4. It stops. Every call has a deadline and the whole run has a deadline, and whatever it
 *      did not reach is printed as not reached rather than left out.
 *
 * WHAT IT STILL CANNOT SEE, said here because a reader of the output deserves to know: a
 * function that only misbehaves on an input this ladder does not contain, and a function
 * this program refused to call. Both are named in the output.
 *
 * Usage: node answers-probe.js <module id>   (with the working directory inside the copy)
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ANSWERS_END,
  ANSWERS_START,
  CALLED_PREFIX,
  MAX_ARGS,
  MAX_FUNCTIONS,
  NOT_CALLED_PREFIX,
  PER_CALL_MS,
  PROBE_INPUTS,
  WHOLE_RUN_MS,
  describeInput,
  whyItWouldNotBeCalled,
} from './from-exports.js';

/**
 * Where the module really is.
 *
 * The rule is copied deliberately from the shape probe rather than reinvented: "starts with a
 * dot, or has a slash in it" was the old test, and `index.js` has neither, so Node was asked
 * for a PACKAGE by that name and answered that it did not exist. `staysfixed init` writes
 * exactly `{ module: "index.js" }` for an ordinary package entry, so getting this wrong makes
 * the probe fail identically on both builds — which produces no difference at all and reads
 * exactly like a clean check.
 *
 * @param {string} id
 * @returns {string}
 */
function resolveModule(id) {
  const asFile = new URL(id, pathToFileURL(`${process.cwd()}/`)).href;
  let onDisk = false;
  try {
    onDisk = existsSync(fileURLToPath(asFile));
  } catch {
    onDisk = false;
  }
  const looksLikeAPath = id.startsWith('.') || id.startsWith('/') || id.includes('/');
  return looksLikeAPath || onDisk ? asFile : id;
}

/**
 * Is this function really a class?
 *
 * Constructing a stranger's class is not something this program is willing to do — a
 * constructor can open a file, start a server or connect to a database, and unlike a plain
 * call there is no useful answer to compare afterwards. Calling one without `new` throws, and
 * a page of identical TypeErrors would drown the answers that matter.
 *
 * @param {Function} fn
 * @returns {boolean}
 */
function isAClass(fn) {
  try {
    return /^\s*class[\s{]/.test(Function.prototype.toString.call(fn));
  } catch {
    return false;
  }
}

/**
 * One value, written the same way every time.
 *
 * Two runs of identical code have to produce identical text here or the whole feature becomes
 * a flake generator, so: object keys are sorted, lists and depth are capped, and anything
 * this function does not recognise is described rather than printed. Nothing reads the clock
 * and nothing reads a random number.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @param {Set<unknown>} [seen]
 * @returns {string}
 */
export function write(value, depth = 0, seen = new Set()) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (type === 'boolean') return String(value);
  if (type === 'bigint') return `${value}n`;
  if (type === 'symbol') return String(value);
  if (type === 'function') {
    const fn = /** @type {Function} */ (value);
    const named = fn.name ? ` called ${fn.name}` : '';
    return `a function${named} taking ${fn.length} ${fn.length === 1 ? 'argument' : 'arguments'}`;
  }
  if (value instanceof Error) return `${value.name}: ${cleanMessage(value.message)}`;
  if (value instanceof Date) {
    // The clock is stopped inside the boundary this runs in, so a date is reproducible. It is
    // written in full rather than bucketed because a library that formats dates is exactly the
    // kind of library whose output must be compared to the character.
    return `Date(${Number.isNaN(value.getTime()) ? 'invalid' : value.toISOString()})`;
  }
  if (value instanceof RegExp) return String(value);
  if (seen.has(value)) return '<the same object again>';
  if (depth >= 3) return Array.isArray(value) ? `a list of ${value.length}` : 'an object, not opened this far down';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const shown = value.slice(0, 20).map((item) => write(item, depth + 1, seen));
      return `[${shown.join(', ')}${value.length > 20 ? `, and ${value.length - 20} more` : ''}]`;
    }
    if (value instanceof Set) {
      const items = [...value].slice(0, 20).map((item) => write(item, depth + 1, seen)).sort();
      return `Set{${items.join(', ')}${value.size > 20 ? `, and ${value.size - 20} more` : ''}}`;
    }
    if (value instanceof Map) {
      const items = [...value.entries()]
        .slice(0, 20)
        .map(([k, v]) => `${write(k, depth + 1, seen)}: ${write(v, depth + 1, seen)}`)
        .sort();
      return `Map{${items.join(', ')}${value.size > 20 ? `, and ${value.size - 20} more` : ''}}`;
    }
    // Own keys only, sorted, and read through a descriptor so a getter is never fired. A
    // getter is somebody else's code running without its name appearing at any call site,
    // which is the one thing this program refuses to do by accident.
    const keys = Object.keys(/** @type {object} */ (value)).sort().slice(0, 30);
    const parts = keys.map((key) => {
      const d = Object.getOwnPropertyDescriptor(/** @type {object} */ (value), key);
      if (d && !('value' in d)) return `${key}: a computed property, not read`;
      return `${key}: ${write(d?.value, depth + 1, seen)}`;
    });
    const total = Object.keys(/** @type {object} */ (value)).length;
    return `{${parts.join(', ')}${total > 30 ? `, and ${total - 30} more` : ''}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * An error message with this machine's own paths taken out of it.
 *
 * A stack trace or a message carrying the scratch folder's absolute path differs between two
 * builds for a reason that has nothing to do with the product — the two builds are walked in
 * two different scratch folders — and that difference would arrive as a finding nobody caused.
 * The tool strips its own footprint out of stdout further downstream as well; this is the
 * cheap half done at the source.
 *
 * @param {string} text
 * @returns {string}
 */
function cleanMessage(text) {
  return String(text ?? '')
    .split('\n')[0]
    .split(process.cwd()).join('.')
    .slice(0, 300);
}

/**
 * Call one function once and say what came back, in one line, whatever happened.
 *
 * A throw is an answer and is written down as one. "Still throws the same TypeError" and
 * "used to throw and now returns a number" are both facts worth comparing, and a probe that
 * only recorded successful calls would report the second as nothing at all.
 *
 * @param {Function} fn
 * @param {unknown[]} args
 * @returns {Promise<string>}
 */
async function callOnce(fn, args) {
  let answer;
  try {
    answer = fn(...args);
  } catch (e) {
    return `threw ${write(e)}`;
  }
  if (answer === null || typeof answer !== 'object' || typeof (/** @type {any} */ (answer).then) !== 'function') {
    return write(answer);
  }
  // A promise is awaited, because the answer of an async function IS the thing worth
  // comparing and "a promise" is the same nine characters whatever the library does. It is
  // awaited under a deadline: an async function that never settles would otherwise hold the
  // whole run until the journey's own timeout killed it, and a killed journey reports nothing
  // about any of the functions that came after it.
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve('__staysfixed_no_answer__'), PER_CALL_MS);
    // Unreferenced so it can never be the reason this program stays alive.
    if (typeof timer?.unref === 'function') timer.unref();
  });
  try {
    const settled = await Promise.race([
      Promise.resolve(answer).then((v) => ({ ok: true, v }), (e) => ({ ok: false, v: e })),
      deadline,
    ]);
    if (settled === '__staysfixed_no_answer__') {
      return `had still not answered after ${PER_CALL_MS}ms, so nothing about this call is compared`;
    }
    const s = /** @type {{ok: boolean, v: unknown}} */ (settled);
    return s.ok ? `a promise for ${write(s.v)}` : `a promise that failed with ${write(s.v)}`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The fixed ladder of arguments one function is called with.
 *
 * FIXED is the whole point. Random or generated inputs would make two runs of the same build
 * disagree with each other, and this tool throws away anything that cannot answer the same
 * way twice — so a fuzzed probe would produce a great deal of noise and nothing that could
 * ever be compared. These are ordinary values a library actually receives, plus the empty and
 * the wrong ones, because "used to throw on null and now returns undefined" is a real change.
 *
 * A function of more than one argument gets the same value in each slot, capped at three.
 * Every combination of the ladder across three slots is a thousand calls per function, which
 * is a cost nobody agreed to for an answer nobody reads.
 *
 * @param {Function} fn
 * @returns {{args: unknown[], shown: string}[]}
 */
export function ladderFor(fn) {
  const arity = Math.min(Math.max(Number(fn.length) || 0, 0), MAX_ARGS);
  /** @type {{args: unknown[], shown: string}[]} */
  const out = [{ args: [], shown: '' }];
  if (arity === 0) return out;
  for (const input of PROBE_INPUTS) {
    const args = Array.from({ length: arity }, () => input.value);
    out.push({ args, shown: args.map(() => describeInput(input)).join(', ') });
  }
  return out;
}

async function main() {
  const id = process.argv[2];
  if (!id) {
    process.stderr.write('This probe needs the module to import as its one argument.\n');
    process.exitCode = 2;
    return;
  }

  /** @type {Record<string, unknown>} */
  let module;
  try {
    module = await import(resolveModule(id));
  } catch (e) {
    // Said on the complaints channel and NOT on stdout, so the answers block is never half
    // written. The run around this reads an empty stdout plus a non-zero exit as "this never
    // reached the product", which is exactly what happened, and records it as a hole.
    process.stderr.write(`Could not import ${id}: ${cleanMessage(/** @type {Error} */ (e)?.message ?? String(e))}\n`);
    process.exitCode = 1;
    return;
  }

  const write_ = (/** @type {string} */ line) => process.stdout.write(`${line}\n`);
  write_(ANSWERS_START);
  write_(`module: ${id}`);

  const names = Object.keys(module).sort();
  /** @type {string[]} */
  const called = [];
  /** @type {string[]} */
  const refused = [];
  /** @type {string[]} */
  const notReached = [];
  /** @type {string[]} */
  const values = [];

  const startedAt = Date.now();
  let functions = 0;

  for (const name of names) {
    let value;
    try {
      value = module[name];
    } catch (e) {
      refused.push(`${name} (crashed) — reading it threw ${write(e)}, so it was never called.`);
      continue;
    }
    if (typeof value !== 'function') {
      // A VALUE IS AN ANSWER TOO, and until 2026-08-31 nothing compared one. The shape probe
      // records an exported string as the words "some text" and an exported number as
      // "number", so `export const API_URL = 'https://api.example.com'` could be repointed at
      // a staging server, or a list of reserved words emptied, and every address agreed. It is
      // the same false all-clear as the one this file exists to stop, wearing a constant
      // instead of a function. The value is written out here in full, deterministically.
      values.push(`${name} = ${write(value)}`);
      continue;
    }
    const fn = /** @type {Function} */ (value);

    if (isAClass(fn)) {
      refused.push(`${name} (not supported here) — it is a class, and this tool never builds one: a constructor can do anything and gives no answer to compare.`);
      continue;
    }
    const why = whyItWouldNotBeCalled(name);
    if (why) {
      refused.push(`${name} (irreversible) — ${why}`);
      continue;
    }
    if (functions >= MAX_FUNCTIONS) {
      notReached.push(name);
      continue;
    }
    if (Date.now() - startedAt > WHOLE_RUN_MS) {
      notReached.push(name);
      continue;
    }

    functions++;
    called.push(name);
    for (const rung of ladderFor(fn)) {
      const answer = await callOnce(fn, rung.args);
      write_(`${name}(${rung.shown}) -> ${answer}`);
    }
  }

  for (const line of values) write_(line);
  write_(ANSWERS_END);
  write_(`${CALLED_PREFIX}${called.length === 0 ? '(none)' : called.join(', ')}`);
  // ONE LINE PER NAME, never a list on one line, and each carrying the KIND of hole it is in
  // brackets. Whatever reads this back turns each of these into its own recorded hole at that
  // function's own address — and the kind decides which sentence the owner is shown, because
  // "doing this for real would destroy data" and "this tool cannot observe a class" are two
  // different facts and reporting both as "the project asked us not to" is a third thing that
  // is true of neither. A line naming four functions at once would arrive as one hole with a
  // made-up name and three functions that silently read as fine.
  for (const line of refused) write_(`${NOT_CALLED_PREFIX}${line}`);
  for (const name of notReached) {
    write_(
      `${NOT_CALLED_PREFIX}${name} (timed out) — the probe had already called ${MAX_FUNCTIONS} functions or spent ` +
      `${Math.round(WHOLE_RUN_MS / 1000)} seconds calling, so this one was never reached and nothing here says anything about it.`,
    );
  }
}

await main();
