/**
 * One error type, so the CLI can tell "your setup is wrong" (worth explaining)
 * apart from "something exploded" (worth a stack trace).
 */

export class StaysFixedError extends Error {
  /**
   * @param {string} message  Written for a human, in plain language.
   * @param {{hint?: string, cause?: unknown, exitCode?: number}} [opts]
   */
  constructor(message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'StaysFixedError';
    /** @type {string|undefined} */
    this.hint = opts.hint;
    /** @type {number} */
    this.exitCode = opts.exitCode ?? 2;
    /** @type {true} */
    this.expected = true;
  }
}

/**
 * @param {unknown} e
 * @returns {e is StaysFixedError}
 */
export function isExpected(e) {
  return Boolean(e && typeof e === 'object' && /** @type {any} */ (e).expected === true);
}

/**
 * @param {unknown} e
 * @returns {string}
 */
export function messageOf(e) {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Exit codes the CLI uses. Stable, so scripts can rely on them. */
export const EXIT = {
  /** Everything the tool knows about still works. */
  ok: 0,
  /** Something changed or a guard failed — a human needs to look. */
  failed: 1,
  /** The tool could not run: bad config, no browser, app would not start. */
  error: 2,
};
