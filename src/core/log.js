/**
 * Terminal output. No dependencies, no spinners that break in CI, no jargon.
 *
 * Everything a human reads comes through here, so the voice stays the same
 * whether it is printed by `check`, by `walk`, or quoted back by the MCP server.
 */

const noColor =
  process.env.NO_COLOR !== undefined ||
  process.env.STAYSFIXED_NO_COLOR !== undefined ||
  process.env.TERM === 'dumb';

const tty = Boolean(process.stdout.isTTY) && !noColor;

/** @type {(code: string) => (s: string) => string} */
const wrap = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const paint = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  grey: wrap('90'),
};

/** Symbols that survive a plain terminal. */
export const mark = {
  pass: tty ? '✓' : 'ok',
  fail: tty ? '✗' : 'X',
  warn: tty ? '!' : '!',
  info: tty ? '·' : '-',
  arrow: tty ? '→' : '->',
};

let quiet = false;
let verbose = false;

/** @param {{quiet?: boolean, verbose?: boolean}} opts */
export function setLogLevel(opts) {
  if (opts.quiet !== undefined) quiet = opts.quiet;
  if (opts.verbose !== undefined) verbose = opts.verbose;
}

export function isVerbose() {
  return verbose;
}

/** @param {...unknown} args */
export function say(...args) {
  if (!quiet) process.stdout.write(args.map(String).join(' ') + '\n');
}

/** @param {...unknown} args */
export function detail(...args) {
  if (verbose && !quiet) process.stdout.write(paint.grey(args.map(String).join(' ')) + '\n');
}

/** @param {...unknown} args */
export function warn(...args) {
  process.stderr.write(paint.yellow(`${mark.warn} ` + args.map(String).join(' ')) + '\n');
}

/** @param {...unknown} args */
export function fail(...args) {
  process.stderr.write(paint.red(`${mark.fail} ` + args.map(String).join(' ')) + '\n');
}

/** @param {...unknown} args */
export function ok(...args) {
  if (!quiet) process.stdout.write(paint.green(`${mark.pass} `) + args.map(String).join(' ') + '\n');
}

export function blank() {
  if (!quiet) process.stdout.write('\n');
}

/**
 * A heading with a rule under it.
 * @param {string} text
 */
export function heading(text) {
  if (quiet) return;
  process.stdout.write('\n' + paint.bold(text) + '\n');
}

/**
 * Print rows as an aligned table. Values are strings already painted if needed.
 * @param {string[][]} rows
 * @param {{indent?: number}} [opts]
 */
export function table(rows, opts = {}) {
  if (quiet || rows.length === 0) return;
  const indent = ' '.repeat(opts.indent ?? 0);
  const widths = /** @type {number[]} */ ([]);
  for (const row of rows) {
    row.forEach((cell, i) => {
      const w = visibleWidth(cell);
      if (widths[i] === undefined || w > widths[i]) widths[i] = w;
    });
  }
  for (const row of rows) {
    const line = row
      .map((cell, i) => (i === row.length - 1 ? cell : cell + ' '.repeat(widths[i] - visibleWidth(cell))))
      .join('  ');
    process.stdout.write(indent + line.trimEnd() + '\n');
  }
}

/**
 * Width ignoring ANSI colour codes.
 * @param {string} s
 */
export function visibleWidth(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * Human duration: 900 -> "0.9s", 65000 -> "1m 5s".
 * @param {number} ms
 */
export function duration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/**
 * A path shortened for reading, relative to cwd when it is inside it.
 * @param {string} p
 */
export function shortPath(p) {
  const cwd = process.cwd();
  if (p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  const home = process.env.HOME;
  if (home && p.startsWith(home + '/')) return '~/' + p.slice(home.length + 1);
  return p;
}
