/**
 * Known-good markers.
 *
 * A marker is a small, boring JSON file that says "on this day, at this commit,
 * every screen looked like this and every guard held". It stores fingerprints,
 * never copies of pictures, so pinning a release costs a couple of kilobytes.
 *
 * Markers are what turn "it broke sometime last week" into "it broke between
 * v0.14.0 and v0.15.0, here are the nine commits". That only works if they are
 * honest, so writing over one is refused unless a human insists.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { safeName } from '../core/paths.js';
import { gitInfo } from '../core/git.js';
import { approvedHashes } from '../picture/store.js';
import { platformTag } from '../drive/find.js';
import { StaysFixedError } from '../core/errors.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Pin the way things look right now.
 *
 * @param {import('../types.js').Project} project
 * @param {string} label  'v0.15.0', 'before-the-store-work' — anything a person will recognise later.
 * @param {{
 *   note?: string,
 *   force?: boolean,
 *   at?: string,
 *   guards?: Record<string, import('../types.js').CheckStatus>,
 *   pictures?: Record<string, string>,
 *   run?: import('../types.js').RunSummary,
 *   tool?: string,
 * }} [opts]
 * @returns {Promise<import('../types.js').Marker>}
 */
export async function writeMarker(project, label, opts = {}) {
  const clean = String(label ?? '').trim();
  if (!clean) {
    throw new StaysFixedError('A marker needs a name.', {
      hint: 'Something you will recognise in three months: `staysfixed mark v0.15.0`.',
    });
  }

  const file = markerFile(project, clean);
  if (!opts.force && (await exists(file))) {
    throw new StaysFixedError(`There is already a marker called "${clean}".`, {
      hint: 'Markers are history, and history should not be quietly rewritten. Use a new name, or pass --force if this one really was wrong.',
    });
  }

  const pictures = opts.pictures ?? (await approvedHashes(project.paths));

  /** @type {import('../types.js').Marker} */
  const marker = {
    label: clean,
    at: opts.at ?? new Date().toISOString(),
    git: await gitInfo(project.paths.root),
    pictures,
    guards: guardsFor(opts),
    tool: opts.tool ?? (await toolVersion()),
    platform: platformTag(),
  };
  if (opts.note) marker.note = opts.note;

  await fsp.mkdir(project.paths.markers, { recursive: true });
  await fsp.writeFile(file, JSON.stringify(marker, null, 2) + '\n');
  return marker;
}

/**
 * Where the guard column of a marker comes from.
 *
 * An explicit map wins. Otherwise we take the real statuses out of the run being
 * pinned — recording a guard as passing when it did not would make the marker a
 * lie, and a lying marker is worse than no marker.
 *
 * @param {{guards?: Record<string, import('../types.js').CheckStatus>, run?: import('../types.js').RunSummary}} opts
 * @returns {Record<string, import('../types.js').CheckStatus>}
 */
function guardsFor(opts) {
  if (opts.guards) return { ...opts.guards };
  /** @type {Record<string, import('../types.js').CheckStatus>} */
  const out = {};
  for (const g of opts.run?.guards ?? []) out[g.name] = g.status ?? 'passed';
  return out;
}

/**
 * Every marker, newest first.
 * @param {import('../types.js').Project} project
 * @returns {Promise<import('../types.js').Marker[]>}
 */
export async function listMarkers(project) {
  /** @type {string[]} */
  let names;
  try {
    names = await fsp.readdir(project.paths.markers);
  } catch {
    return [];
  }

  /** @type {import('../types.js').Marker[]} */
  const markers = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const marker = await readMarkerFile(path.join(project.paths.markers, name));
    if (marker) markers.push(marker);
  }
  // Newest first. Ties keep a stable order, so two markers written in the same
  // second never swap places between runs.
  return markers.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * @param {import('../types.js').Project} project
 * @param {string} label
 * @returns {Promise<import('../types.js').Marker|null>}
 */
export async function readMarker(project, label) {
  const direct = await readMarkerFile(markerFile(project, label));
  if (direct) return direct;
  // The file name is a tidied-up version of the label, so a person typing the
  // original label with spaces or slashes in it should still find their marker.
  const all = await listMarkers(project);
  return all.find((m) => m.label === label) ?? null;
}

/**
 * @param {import('../types.js').Project} project
 * @param {string} label
 * @returns {Promise<boolean>} true when a marker was actually removed
 */
export async function deleteMarker(project, label) {
  const file = markerFile(project, label);
  if (await exists(file)) {
    await fsp.rm(file, { force: true });
    return true;
  }
  const found = (await listMarkers(project)).find((m) => m.label === label);
  if (!found) return false;
  const other = markerFile(project, found.label);
  if (await exists(other)) {
    await fsp.rm(other, { force: true });
    return true;
  }
  return false;
}

/**
 * One line a person can read at a glance:
 * "v0.15.0 — 12 pictures, 8 guards, at 3f9a1c2 on main, 28 Aug 2026"
 *
 * @param {import('../types.js').Marker} marker
 * @returns {string}
 */
export function describeMarker(marker) {
  const pictures = Object.keys(marker.pictures ?? {}).length;
  const guards = Object.keys(marker.guards ?? {}).length;

  const parts = [
    `${pictures} ${pictures === 1 ? 'picture' : 'pictures'}`,
    `${guards} ${guards === 1 ? 'guard' : 'guards'}`,
  ];
  if (marker.git?.shortSha) {
    parts.push(marker.git.branch ? `at ${marker.git.shortSha} on ${marker.git.branch}` : `at ${marker.git.shortSha}`);
  }
  const day = readableDay(marker.at);
  if (day) parts.push(day);

  return `${marker.label} — ${parts.join(', ')}`;
}

/**
 * @param {import('../types.js').Project} project
 * @param {string} label
 * @returns {string}
 */
function markerFile(project, label) {
  return path.join(project.paths.markers, `${safeName(label)}.json`);
}

/**
 * @param {string} file
 * @returns {Promise<import('../types.js').Marker|null>}
 */
async function readMarkerFile(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.label !== 'string') return null;
    // Older or hand-edited markers may be missing pieces; fill them in rather
    // than throwing, because a half-readable marker still narrows a search.
    return {
      label: parsed.label,
      at: typeof parsed.at === 'string' ? parsed.at : '',
      note: typeof parsed.note === 'string' ? parsed.note : undefined,
      git: parsed.git ?? { sha: null, shortSha: null, branch: null, dirty: false, user: null },
      pictures: parsed.pictures ?? {},
      guards: parsed.guards ?? {},
      tool: typeof parsed.tool === 'string' ? parsed.tool : 'unknown',
      platform: typeof parsed.platform === 'string' ? parsed.platform : 'unknown',
    };
  } catch {
    return null;
  }
}

/**
 * '2026-08-28T21:03:00.000Z' -> '28 Aug 2026'. Read in UTC so the same marker
 * reads the same on every machine that opens it.
 * @param {string} iso
 * @returns {string|null}
 */
function readableDay(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function exists(file) {
  try {
    await fsp.stat(file);
    return true;
  } catch {
    return false;
  }
}

/** @type {string|null} */
let cachedVersion = null;

/**
 * Which build of the tool wrote this marker. Read off package.json rather than
 * hard-coded, so it can never drift from the version that actually shipped.
 * @returns {Promise<string>}
 */
async function toolVersion() {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const raw = await fsp.readFile(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    cachedVersion = typeof parsed.version === 'string' ? `staysfixed ${parsed.version}` : 'staysfixed';
  } catch {
    cachedVersion = 'staysfixed';
  }
  return cachedVersion;
}
