/** Hashing. Used to fingerprint pictures so markers can spot a change without storing copies. */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';

/**
 * @param {Buffer|Uint8Array|string} data
 * @returns {string} hex sha256
 */
export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * @param {string} file
 * @returns {Promise<string|null>} hex sha256, or null when the file is not there
 */
export async function sha256File(file) {
  try {
    return sha256(await fsp.readFile(file));
  } catch {
    return null;
  }
}

/**
 * A short, readable fingerprint for logs. Never used for comparison.
 * @param {string} hex
 */
export function shortHash(hex) {
  return hex.slice(0, 12);
}
