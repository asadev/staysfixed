/**
 * Journeys read straight out of the code — the cheapest source, and the exact one.
 *
 * `adapters/source.js` already reads every door a project opens without running any of it:
 * IPC channels, HTTP routes, exported names, commands, settings. This file turns that list
 * of doors into JOURNEYS — named sequences that go and knock on them. Nobody writes
 * anything, nobody records anything, and it costs about a second on a large project.
 *
 * WHY THIS IS THE BEST SOURCE. A recorded session tells you about one path a person
 * happened to take. The suite tells you about the paths somebody thought to write a test
 * for. The code tells you about every door there is, including the ones nobody has opened
 * since they were written — which is exactly where a silent break hides.
 *
 * WHY DOORS ARE GROUPED RATHER THAN ONE JOURNEY EACH. Terminal Deck has 5,785 doors. A
 * journey is the unit of retry, of the wobble measurement and of the stored record, so
 * 5,785 of them would mean 5,785 folders and four walks each, and one door falling over
 * would lose nothing but would still cost a whole run. Doors are gathered into families
 * that share a prefix — everything on `session:`, everything under `/api/users` — so a
 * large project gets tens of journeys covering thousands of doors, and a difference still
 * lands on the individual door because the PATH names the door, not the journey.
 *
 * WHAT THIS CANNOT DO. It knocks on doors; it does not know what is behind them. A route
 * gets a request with no body, an IPC channel gets a call with no arguments, an exported
 * function is looked at rather than called. Calling something with invented arguments is
 * how a tool invents a failure that is really its own fault — so this file never does it,
 * and the suite source exists for the cases where real arguments matter.
 */

import path from 'node:path';
import {
  readContract,
  readFileRoutes,
  readPackageCommands,
  surfaceOf,
} from '../adapters/source.js';

/** @typedef {import('../types.js').Journey} Journey */
/** @typedef {import('../types.js').JourneyStep} JourneyStep */
/** @typedef {import('../types.js').Channel} Channel */
/** @typedef {import('../types.js').Surface} Surface */
/** @typedef {import('../adapters/source.js').Door} Door */

// ---------------------------------------------------------------------------
// What must never be knocked on for real
// ---------------------------------------------------------------------------

/**
 * Words in a door's name that mean opening it for real would be irreversible.
 *
 * This is a NAME-BASED guess and it is deliberately generous: a journey wrongly marked
 * irreversible is observed at the call and not at the effect, which costs a little
 * coverage; a journey wrongly marked safe sends somebody a real email. When those are the
 * two mistakes available, you make the first one.
 *
 * The adapter is what actually stops the effect happening. This flag is how it is told to.
 */
export const IRREVERSIBLE_WORDS = Object.freeze([
  { word: 'pay', why: 'it sounds like it moves money' },
  { word: 'payment', why: 'it sounds like it moves money' },
  { word: 'charge', why: 'it sounds like it moves money' },
  { word: 'checkout', why: 'it sounds like it moves money' },
  { word: 'refund', why: 'it sounds like it moves money' },
  { word: 'invoice', why: 'it sounds like it moves money' },
  { word: 'subscribe', why: 'it sounds like it starts a paid subscription' },
  { word: 'billing', why: 'it sounds like it moves money' },
  { word: 'send', why: 'it sounds like it sends a message somebody receives' },
  { word: 'email', why: 'it sounds like it sends a message somebody receives' },
  { word: 'sms', why: 'it sounds like it sends a message somebody receives' },
  { word: 'notify', why: 'it sounds like it sends a message somebody receives' },
  { word: 'publish', why: 'it sounds like it makes something public' },
  { word: 'deploy', why: 'it sounds like it changes something that is live' },
  { word: 'release', why: 'it sounds like it changes something that is live' },
  { word: 'delete', why: 'it sounds like it destroys data' },
  { word: 'destroy', why: 'it sounds like it destroys data' },
  { word: 'remove', why: 'it sounds like it destroys data' },
  { word: 'drop', why: 'it sounds like it destroys data' },
  { word: 'purge', why: 'it sounds like it destroys data' },
  { word: 'wipe', why: 'it sounds like it destroys data' },
  { word: 'reset', why: 'it sounds like it throws away what is there' },
  { word: 'migrate', why: 'it sounds like it rewrites stored data in place' },
  { word: 'uninstall', why: 'it sounds like it takes something away that has to be put back' },
]);

/** Verbs on a route that change something by definition, whatever the route is called. */
const CHANGING_METHODS = new Set(['DELETE']);

/**
 * Package scripts that never finish on their own. A journey that never ends is not a
 * journey, it is a hang, and a hang looks exactly like a broken product.
 */
const NEVER_EXITS = /^(dev|start|serve|watch|preview|storybook|tunnel)(:|$)/;

/**
 * Package scripts that are somebody else's job. Building and releasing are not journeys
 * through a product; they are how the product gets made, and running them here would
 * rebuild the thing being measured underneath the measurement. The test scripts are left
 * out for a different reason: the suite is a far better journey source than a command that
 * runs all of it at once, and `from-suite.js` is where it is read properly.
 */
const NOT_A_JOURNEY = /^(build|dist|pack|release|version|preversion|postversion|prepare|prepublish|prepublishOnly|postinstall|art|test|check|lint|format|typecheck|coverage)(:|$)/;

/**
 * Is this `command` door something that can actually be run?
 *
 * The code reader files three different things under `command`: programs a package
 * installs, scripts in package.json, and every flag a source file mentions. The first two
 * can be walked through. A flag cannot — it modifies a command rather than being one — and
 * turning each into its own journey buries the real commands under a hundred of them.
 *
 * @param {Door} door
 * @returns {boolean}
 */
export function isRunnable(door) {
  if (door.kind !== 'command') return false;
  if (String(door.name).startsWith('-')) return false;
  return door.via === 'package.json';
}

/**
 * Split a name into the words a person would read in it: `session:createMany` becomes
 * session, create, many. Word-splitting rather than substring matching is what stops
 * `undeleteAll` reading as `delete` and `resend` reading as `send`.
 *
 * @param {string} name
 * @returns {string[]}
 */
export function wordsIn(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * Kinds of door where walking through actually does something. An exported name is looked
 * at, never called, so a constant called `AGENTS_REMOVE_CHANNEL` is not dangerous to read —
 * and marking it dangerous would bury the handful of doors that really are.
 */
const CAN_HAVE_AN_EFFECT = new Set(['ipc', 'route', 'command']);

/**
 * Would opening this door for real be something that cannot be undone?
 *
 * @param {Door} door
 * @returns {{irreversible: boolean, why: string}}
 */
export function irreversibility(door) {
  if (!CAN_HAVE_AN_EFFECT.has(door.kind)) return { irreversible: false, why: '' };
  const words = new Set(wordsIn(door.name));
  for (const entry of IRREVERSIBLE_WORDS) {
    if (words.has(entry.word)) {
      return { irreversible: true, why: `The name contains "${entry.word}", so ${entry.why}.` };
    }
  }
  if (door.kind === 'route' && CHANGING_METHODS.has(String(door.detail).toUpperCase())) {
    return { irreversible: true, why: 'It is a DELETE route, so asking for it properly would remove something.' };
  }
  return { irreversible: false, why: '' };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Turn anything into a name that is safe as a folder and readable in a report.
 *
 * Escaping rather than dropping matters here for the same reason it does in the path
 * grammar: `v1.2` and `v12` are different things, and a scheme that strips would merge
 * two journeys into one address and then report the difference between them as a change.
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function slug(text, limit = 60) {
  const cleaned = String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const out = cleaned === '' ? 'unnamed' : cleaned;
  return out.length <= limit ? out : `${out.slice(0, limit - 7)}-${shortHash(out)}`;
}

/**
 * A short, stable fingerprint. Only ever used to keep two long names apart, never as an
 * identity anything is compared on.
 * @param {string} text
 * @returns {string}
 */
export function shortHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(6, '0').slice(0, 6);
}

/**
 * The family a door belongs to.
 *
 * IPC channels are named `thing:action` almost everywhere, and routes are a folder tree, so
 * both have a natural first level. Exported names group by the file they live in, because
 * that is what a person means by "the store module". Commands stand alone: each one is a
 * separate program run and grouping them would mean one failing command hid the next.
 *
 * @param {Door} door
 * @returns {{group: string, label: string}}
 */
export function familyOf(door) {
  switch (door.kind) {
    case 'ipc': {
      const head = String(door.name).split(/[:/.]/)[0] || 'other';
      return { group: `ipc-${slug(head)}`, label: `IPC channels starting with "${head}"` };
    }
    case 'route': {
      const segments = String(door.name).split('/').filter(Boolean);
      const head = segments[0] ?? 'root';
      const second = segments[0] === 'api' && segments[1] ? `api/${segments[1]}` : head;
      return { group: `route-${slug(second)}`, label: `routes under /${second}` };
    }
    case 'export': {
      const file = String(door.file).split(path.sep).join('/');
      const folder = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.';
      return {
        group: `export-${slug(folder === '.' ? 'top' : folder)}`,
        label: folder === '.' ? 'what the top-level files export' : `what the files in ${folder} export`,
      };
    }
    case 'command':
      return { group: `cli-${slug(door.name)}`, label: `the command "${door.name}"` };
    default:
      return { group: 'settings', label: 'the settings it reads' };
  }
}

// ---------------------------------------------------------------------------
// Doors to steps
// ---------------------------------------------------------------------------

/** What an adapter is being asked to do at each kind of door. */
const ACT_FOR_KIND = /** @type {const} */ ({
  ipc: 'invoke',
  route: 'request',
  export: 'inspect',
  command: 'run',
  env: 'read',
});

/** The channels a walk through each kind of door can honestly fill. */
const CHANNELS_FOR_KIND = /** @type {Record<string, Channel[]>} */ ({
  ipc: ['results', 'complaints', 'effects', 'counters'],
  route: ['results', 'complaints', 'effects', 'counters'],
  export: ['contract', 'results'],
  command: ['results', 'complaints', 'effects', 'counters'],
  env: ['contract'],
});

/**
 * One door, as a step an adapter can act on.
 *
 * Everything the adapter needs is on the step, and nothing it does not: the door's file and
 * line ride along because ranking measures distance from the changed code, and a step that
 * knows which file it came from turns "something broke" into "something broke next to what
 * you just edited".
 *
 * @param {Door} door
 * @returns {JourneyStep}
 */
export function stepForDoor(door) {
  const risk = irreversibility(door);
  /** @type {JourneyStep} */
  const step = {
    act: ACT_FOR_KIND[door.kind] ?? 'read',
    kind: door.kind,
    door: door.name,
    detail: door.detail,
    file: door.file,
    line: door.line,
  };
  if (door.kind === 'route') {
    step.method = String(door.detail).toUpperCase();
    step.route = door.name;
  }
  if (door.kind === 'command') step.command = door.name;
  if (risk.irreversible) {
    step.irreversible = true;
    step.why = risk.why;
    step.note = 'Watch the call go out and stop it there. Never let the effect happen.';
  }
  return step;
}

// ---------------------------------------------------------------------------
// Doors to journeys
// ---------------------------------------------------------------------------

/**
 * @typedef {object} FromRoutesOptions
 * @property {Surface} [surface]      What these journeys run against. Read off the project
 *                                    when it is not given.
 * @property {number} [maxSteps]      Doors per journey. See the note at the top of the file
 *                                    for why this is not simply "all of them".
 * @property {boolean} [includeTests] Include doors a test file registers. Off, because a
 *                                    fake registration in a test is not a door the product
 *                                    answers on.
 * @property {('ipc'|'route'|'export'|'command'|'env')[]} [kinds]  Only these kinds.
 * @property {(door: Door) => boolean} [where]   A last filter, for a caller with its own idea.
 */

/**
 * @typedef {object} FromRoutesReport
 * @property {number} doors           Doors the code reader found.
 * @property {number} doorsCovered    Doors a journey now knocks on.
 * @property {number} journeys
 * @property {Record<string, number>} byKind          Doors covered, per kind.
 * @property {{what: string, why: string, doors: number}[]} left
 *                                    Doors deliberately not turned into journeys, and why.
 *                                    This is the coverage hole, said out loud rather than
 *                                    left to be discovered.
 */

/**
 * Turn a list of doors into journeys.
 *
 * Pure: hand it doors, get journeys. Everything that touches a disk lives in
 * {@link journeysFromCode}, so this half can be tested with a list written by hand.
 *
 * @param {Door[]} doors
 * @param {FromRoutesOptions} [options]
 * @returns {{journeys: Journey[], report: FromRoutesReport}}
 */
export function journeysFromDoors(doors, options = {}) {
  const maxSteps = options.maxSteps ?? 40;
  const surface = options.surface ?? 'library';
  /** @type {FromRoutesReport} */
  const report = { doors: doors.length, doorsCovered: 0, journeys: 0, byKind: {}, left: [] };

  /** @type {Map<string, {reason: string, count: number}>} */
  const left = new Map();
  /** @param {string} reason */
  const leaveOut = (reason) => {
    const entry = left.get(reason) ?? { reason, count: 0 };
    entry.count++;
    left.set(reason, entry);
  };

  /** @type {Map<string, {label: string, kind: Door['kind'], doors: Door[]}>} */
  const families = new Map();

  for (const door of doors) {
    if (!options.includeTests && door.inTest) { leaveOut('they are registered inside a test file, not by the product'); continue; }
    if (!door.named) { leaveOut('their names are built while the program runs, so there is nothing to knock on'); continue; }
    if (options.kinds && !options.kinds.includes(door.kind)) { leaveOut('their kind was not asked for'); continue; }
    if (door.kind === 'env') { leaveOut('a setting is read, not opened — the contract channel already watches them'); continue; }
    if (door.kind === 'command' && !isRunnable(door)) {
      leaveOut('they are flags rather than programs — a flag modifies a command, it is not something a journey can walk through on its own, and the contract channel already watches every one of them');
      continue;
    }
    if (door.kind === 'command' && NEVER_EXITS.test(door.name.replace(/^npm run /, ''))) {
      leaveOut('they never exit on their own, so a walk through one would hang rather than finish');
      continue;
    }
    if (door.kind === 'command' && NOT_A_JOURNEY.test(door.name.replace(/^npm run /, ''))) {
      leaveOut('they build or release the product rather than use it, and running one would rebuild the thing being measured');
      continue;
    }
    if (options.where && !options.where(door)) { leaveOut('a filter the caller supplied left them out'); continue; }

    const family = familyOf(door);
    const existing = families.get(family.group);
    if (existing) existing.doors.push(door);
    else families.set(family.group, { label: family.label, kind: door.kind, doors: [door] });
  }

  /** @type {Journey[]} */
  const journeys = [];
  for (const [group, family] of [...families.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const ordered = family.doors
      .slice()
      .sort((a, b) => (a.name === b.name ? compare(`${a.file}:${a.line}`, `${b.file}:${b.line}`) : compare(a.name, b.name)));
    const chunks = chunk(ordered, maxSteps);
    chunks.forEach((part, index) => {
      const name = chunks.length === 1 ? `code-${group}` : `code-${group}-${index + 1}`;
      const steps = part.map(stepForDoor);
      const files = unique(part.map((d) => d.file));
      /** @type {Journey} */
      const journey = {
        name,
        describe:
          chunks.length === 1
            ? `knock on the ${part.length} ${part.length === 1 ? 'door' : 'doors'} in ${family.label}`
            : `knock on ${family.label}, part ${index + 1} of ${chunks.length} (${part.length} doors)`,
        source: 'code',
        surface,
        from: files.length === 1 ? files[0] : `${files.length} files, starting with ${files[0]}`,
        channels: CHANNELS_FOR_KIND[family.kind] ?? ['results'],
        steps,
      };
      if (steps.some((s) => s.irreversible === true)) {
        journey.irreversible = true;
      }
      journeys.push(journey);
      report.doorsCovered += part.length;
      report.byKind[family.kind] = (report.byKind[family.kind] ?? 0) + part.length;
    });
  }

  report.journeys = journeys.length;
  report.left = [...left.values()]
    .sort((a, b) => b.count - a.count)
    .map((entry) => ({
      what: `${entry.count} ${entry.count === 1 ? 'door is' : 'doors are'} not walked.`,
      why: `They were left out because ${entry.reason}.`,
      doors: entry.count,
    }));
  return { journeys, report };
}

/**
 * Read a project's code and hand back journeys that visit its doors.
 *
 * Reads. Never runs, never writes, never starts anything — which is why this is safe to
 * point at a repository somebody else is working in.
 *
 * @param {object} opts
 * @param {string} opts.root                 Project root. Read only.
 * @param {string[]} [opts.folders]          Folders to read. Defaults to the usual ones.
 * @param {Record<string, any>} [opts.config]  The project's config, for the surface.
 * @param {FromRoutesOptions} [opts.journeys]
 * @returns {Promise<{journeys: Journey[], doors: Door[], report: FromRoutesReport & {readMs: number, filesRead: number, unnamed: number}}>}
 */
export async function journeysFromCode(opts) {
  const started = Date.now();
  const reading = await readContract({ root: opts.root, folders: opts.folders });
  const fileRoutes = await readFileRoutes(opts.root);
  reading.doors.push(...fileRoutes.doors);
  reading.report.problems.push(...fileRoutes.problems);
  reading.doors.push(...(await readPackageCommands(opts.root)));

  const surface =
    opts.journeys?.surface ?? /** @type {Surface} */ (surfaceOf({ root: opts.root, config: opts.config }));
  const built = journeysFromDoors(reading.doors, { ...opts.journeys, surface });

  if (reading.report.unnamed > 0) {
    built.report.left.push({
      what: `${reading.report.unnamed} doors exist whose names are worked out while the program runs.`,
      why: 'The code reader can see that a door is there but not what it is called, so nothing can knock on it.',
      doors: reading.report.unnamed,
    });
  }

  return {
    journeys: built.journeys,
    doors: reading.doors,
    report: {
      ...built.report,
      readMs: Date.now() - started,
      filesRead: reading.report.filesRead,
      unnamed: reading.report.unnamed,
    },
  };
}

// ---------------------------------------------------------------------------
// Small things
// ---------------------------------------------------------------------------

/**
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
function chunk(items, size) {
  if (items.length <= size) return items.length === 0 ? [] : [items];
  /** @type {T[][]} */
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * @param {string} a
 * @param {string} b
 */
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
