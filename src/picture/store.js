/**
 * Reading and writing the pictures on disk.
 *
 * `approved/` is the promise and belongs in git. `results/` is only evidence
 * from the last run. Nothing in here ever promotes a result to approved by
 * itself — `approveFromResult` is called when a human has said yes, and that
 * separation is the point of the whole tool.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { approvedPicture, resultPicture, safeName } from '../core/paths.js';
import { sha256 } from '../core/hash.js';
import { StaysFixedError } from '../core/errors.js';
import { platformTag } from '../drive/find.js';
import { pngSize } from './capture.js';

/**
 * How wide a preview is, in real pixels.
 *
 * The watch panel is 460 CSS pixels across, and every screen a person reviews on is
 * retina, so the panel is really 920 pixels wide. A 320-pixel preview stretched over
 * that is the blur everybody complained about: you cannot read a label in it, and
 * zooming in only makes the blur bigger. 900 is where a preview stops being a
 * stand-in and starts being a picture — and it still weighs about 40KB, which a run
 * can hand to a window a dozen times over without anybody noticing.
 */
const PREVIEW_WIDTH = 900;

/**
 * A small note written beside a result picture so `approve` knows things the PNG
 * cannot tell it — the screen density it was taken at, and its description.
 * @typedef {object} ResultNote
 * @property {number} [deviceScaleFactor]
 * @property {string} [describe]
 */

/**
 * A picture already decoded into pixels: what `PNG.sync.read` hands back, and what the
 * mask painter works on. Described by its shape rather than by pngjs's class, because
 * pngjs does not hand back one of those.
 * @typedef {{width: number, height: number, data: Uint8Array}} Pixels
 */

/**
 * A small copy of a picture, ready to drop straight into a page.
 *
 * This is the INSTANT preview, and only that. The watch panel loads the real PNG off
 * disk the moment it exists, so this only has to hold the frame for the fraction of a
 * second before that file arrives — but it has to hold it honestly, at a size a person
 * can actually read.
 *
 * It is built from the finished picture rather than asked of the app again: what a
 * watcher sees is exactly what was compared, blackout boxes and all, and never a second
 * photograph taken a moment later that shows something slightly different.
 *
 * Points are averaged now, not sampled. Dropping nine pixels out of every ten is what
 * made the old previews look broken rather than merely small — a one-pixel border or a
 * line of text either survived or vanished depending on where it happened to land.
 * Averaging every pixel that falls inside an output pixel costs about forty
 * milliseconds on a retina screenshot, and it is the difference between a picture and a
 * smear.
 *
 * @param {Buffer|Pixels} source
 *   The bytes of a PNG, or a picture already decoded. Hand over the decoded one when
 *   you have it — a retina screenshot costs about eighty milliseconds to decode, and
 *   decoding the same megapixels twice for one screen is the whole cost of this
 *   function paid for nothing.
 * @returns {Promise<string|null>} a data: address for an <img>, or null if it cannot be read
 */
export async function thumbnailOf(source) {
  try {
    if (Buffer.isBuffer(source) && pngSize(source).width <= PREVIEW_WIDTH) {
      // Already small enough to be its own preview. Saves decoding and re-encoding a
      // picture only to hand back what we were given.
      return `data:image/png;base64,${source.toString('base64')}`;
    }
  } catch {
    // Not a PNG we can measure from its header. Fall through and let the decode below
    // be the one that decides whether there is a picture here at all.
  }

  try {
    // Told apart by what it IS, not by `instanceof PNG`: pngjs's sync reader hands back
    // a plain object rather than an instance of its own class, so an instance check
    // here quietly says "no" to every decoded picture ever passed in.
    const full = Buffer.isBuffer(source) ? PNG.sync.read(source) : source;
    if (!(full.width > 0) || !(full.height > 0)) return null;
    const scale = full.width > PREVIEW_WIDTH ? full.width / PREVIEW_WIDTH : 1;
    const width = Math.max(1, Math.round(full.width / scale));
    const height = Math.max(1, Math.round(full.height / scale));

    const small = new PNG({ width, height });
    const from = full.data;
    const into = small.data;

    for (let y = 0; y < height; y += 1) {
      const top = Math.floor(y * scale);
      // Always at least one row, even when the picture is barely bigger than the preview.
      const bottom = Math.min(full.height, Math.max(top + 1, Math.floor((y + 1) * scale)));
      for (let x = 0; x < width; x += 1) {
        const left = Math.floor(x * scale);
        const right = Math.min(full.width, Math.max(left + 1, Math.floor((x + 1) * scale)));
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let n = 0;
        for (let sy = top; sy < bottom; sy += 1) {
          let i = (sy * full.width + left) * 4;
          for (let sx = left; sx < right; sx += 1) {
            r += from[i];
            g += from[i + 1];
            b += from[i + 2];
            a += from[i + 3];
            n += 1;
            i += 4;
          }
        }
        const at = (y * width + x) * 4;
        into[at] = (r / n + 0.5) | 0;
        into[at + 1] = (g / n + 0.5) | 0;
        into[at + 2] = (b / n + 0.5) | 0;
        into[at + 3] = (a / n + 0.5) | 0;
      }
    }
    return `data:image/png;base64,${PNG.sync.write(small).toString('base64')}`;
  } catch {
    // A picture nobody can decode is not worth failing a run over — the run itself has
    // already said what it thinks of the screen, and a watcher simply sees no picture.
    return null;
  }
}

/**
 * The fingerprint of a picture.
 *
 * The same sha256 that is written into an approved picture's note, so anyone holding that
 * note can tell whether a fresh photograph is the same file without reading the old one
 * off disk or decoding either of them.
 *
 * @param {Buffer|Uint8Array|string} buffer
 * @returns {string} hex sha256
 */
export function fingerprint(buffer) {
  return sha256(buffer);
}

/**
 * @param {import('../types.js').ProjectPaths} paths
 * @param {string} name
 * @returns {Promise<{png: Buffer, meta: import('../types.js').PictureMeta|null}|null>}
 */
export async function readApproved(paths, name) {
  const files = approvedPicture(paths, name);
  let png;
  try {
    png = await fsp.readFile(files.png);
  } catch {
    return null;
  }
  return { png, meta: await readJson(files.json) };
}

/**
 * @param {import('../types.js').ProjectPaths} paths
 * @param {string} name
 * @param {Buffer} png
 * @param {ResultNote} [note]
 * @returns {Promise<string>} the file written
 */
export async function writeResult(paths, name, png, note) {
  const files = resultPicture(paths, name);
  await fsp.mkdir(path.dirname(files.png), { recursive: true });
  await fsp.writeFile(files.png, png);
  if (note && (note.deviceScaleFactor !== undefined || note.describe !== undefined)) {
    await fsp.writeFile(resultNotePath(paths, name), JSON.stringify(note, null, 2) + '\n');
  }
  return files.png;
}

/**
 * @param {import('../types.js').ProjectPaths} paths
 * @param {string} name
 * @param {Buffer} png
 * @returns {Promise<string>} the file written
 */
export async function writeDiff(paths, name, png) {
  const files = resultPicture(paths, name);
  await fsp.mkdir(path.dirname(files.diff), { recursive: true });
  await fsp.writeFile(files.diff, png);
  return files.diff;
}

/**
 * Promote the latest result to being the approved picture. Only ever called
 * after a human has looked at it and said yes.
 *
 * @param {import('../types.js').ProjectPaths} paths
 * @param {string} name
 * @param {{
 *   git?: import('../types.js').GitInfo|null,
 *   tool?: string,
 *   describe?: string,
 *   deviceScaleFactor?: number,
 * }} [opts]
 * @returns {Promise<import('../types.js').PictureMeta>}
 */
export async function approveFromResult(paths, name, opts = {}) {
  const result = resultPicture(paths, name);
  let png;
  try {
    png = await fsp.readFile(result.png);
  } catch {
    throw new StaysFixedError(`There is no new picture of "${name}" to approve.`, {
      hint: 'Run `staysfixed check` first, then approve what you saw.',
    });
  }

  const files = approvedPicture(paths, name);
  const previous = await readJson(files.json);
  const note = /** @type {ResultNote|null} */ (await readJson(resultNotePath(paths, name)));
  const size = pngSize(png);

  /** @type {import('../types.js').PictureMeta} */
  const meta = {
    name,
    width: size.width,
    height: size.height,
    deviceScaleFactor:
      opts.deviceScaleFactor ?? note?.deviceScaleFactor ?? previous?.deviceScaleFactor ?? 1,
    sha256: sha256(png),
    approvedAt: new Date().toISOString(),
    approvedBy: opts.git?.user ?? 'unknown',
    tool: opts.tool ?? 'staysfixed',
    platform: platformTag(),
  };
  const describe = opts.describe ?? note?.describe ?? previous?.describe;
  if (describe !== undefined) meta.describe = describe;
  if (opts.git?.sha) meta.gitSha = opts.git.sha;

  await fsp.mkdir(paths.approved, { recursive: true });
  await fsp.writeFile(files.png, png);
  await fsp.writeFile(files.json, JSON.stringify(meta, null, 2) + '\n');
  return meta;
}

/**
 * @param {import('../types.js').ProjectPaths} paths
 * @returns {Promise<string[]>}
 */
export async function listApproved(paths) {
  return listPictureNames(paths.approved);
}

/**
 * @param {import('../types.js').ProjectPaths} paths
 * @returns {Promise<string[]>}
 */
export async function listResults(paths) {
  return listPictureNames(paths.results);
}

/**
 * @param {import('../types.js').ProjectPaths} paths
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function removeApproved(paths, name) {
  const files = approvedPicture(paths, name);
  await fsp.rm(files.png, { force: true });
  await fsp.rm(files.json, { force: true });
}

/**
 * Fingerprint every approved picture, so a marker can tell later whether a
 * screen still looks the way it did without keeping a second copy of it.
 * @param {import('../types.js').ProjectPaths} paths
 * @returns {Promise<Record<string,string>>}
 */
export async function approvedHashes(paths) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const name of await listApproved(paths)) {
    try {
      out[name] = sha256(await fsp.readFile(approvedPicture(paths, name).png));
    } catch {
      // A picture that vanished between the listing and the read simply has no fingerprint.
    }
  }
  return out;
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listPictureNames(dir) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.png') && !e.name.endsWith('.diff.png'))
    .map((e) => e.name.slice(0, -4))
    .sort();
}

/**
 * @param {import('../types.js').ProjectPaths} paths
 * @param {string} name
 * @returns {string}
 */
function resultNotePath(paths, name) {
  return path.join(paths.results, `${safeName(name)}.json`);
}

/**
 * @param {string} file
 * @returns {Promise<any>} the parsed contents, or null when it is missing or unreadable
 */
async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}
