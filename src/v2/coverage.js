/**
 * Coverage — and mostly, what was never looked at.
 *
 * The code reader gets 5,805 doors out of Terminal Deck in under two seconds without
 * starting it, 452 of them IPC channels. Almost none of those doors have ever been opened
 * by this tool. That is fine. What is not fine is a run that comes back clean and lets a
 * person read it as "nothing changed", when what it actually said was "nothing I looked at
 * changed" — and it never mentioned that it looked at forty of five thousand.
 *
 * That gap between the two sentences is the only thing this file exists to close.
 *
 * THREE RULES, AND THEY ARE THE WHOLE DESIGN.
 *
 * 1. A door read out of the source is NOT a door that was walked. The contract channel is
 *    how we learn a door exists; it can never be the evidence that anything opened it.
 *    Every observation on the `contract` channel is deliberately ignored when this file
 *    works out what was walked. Getting that backwards would report perfect coverage on a
 *    product nobody ever ran, which is the exact lie this file is here to prevent.
 *
 * 2. Never a percentage, and there is not one in this file. A percentage invites a target,
 *    a target invites gaming, and a gamed coverage number is worse than no number because
 *    somebody trusts it. Counts, and the names of the things that are missing.
 *
 * 3. Undercount rather than overcount. Where the evidence is ambiguous this file records
 *    the door as unopened and says why in a caveat. A ledger that flatters itself is a
 *    ledger that hides work.
 *
 * WHAT COUNTS AS HAVING OPENED A DOOR, strongest evidence first. Every entry carries the
 * sentence saying which of these it rests on, because they are not equally good.
 *
 *   a step        A journey has a step naming exactly this door, and a capture exists for
 *                 that journey. This is the tool knocking on the door on purpose, and it is
 *                 the only evidence that works for every kind of door.
 *   an address    Something was observed at the door's own address — `ipc.session:save…`
 *                 came back from the running app. The product answered at its own door.
 *   a function    The test suite's own coverage says this exact function ran. Exported names
 *                 only, and it is as strong as the other two: the code ran.
 *   a file        The file that declares the door executed, but nothing addressed the door
 *                 itself. This is NOT counted as opened. It is its own weaker column,
 *                 `reached`, and it is reported separately for exactly that reason.
 *
 * DOORS THAT CANNOT BE WALKED FROM HERE AT ALL are separated out rather than left sitting in
 * the work queue looking like laziness: a setting is read and not opened, a name built while
 * the program runs has nothing to knock on, and a door whose name says it charges a card is
 * watched at the call and refused at the effect, permanently and on purpose.
 */

import { asAddress } from './adapters/electron.js';
import { readContract, readFileRoutes, readPackageCommands } from './adapters/source.js';
import { familyOf, irreversibility, isRunnable } from './journeys/from-routes.js';
import { joinPath, splitPath } from './observation.js';
import { listBuilds, listCaptures, loadCapture, referencePointer } from './store.js';

/** @typedef {import('./types.js').Channel} Channel */
/** @typedef {import('./types.js').Capture} Capture */
/** @typedef {import('./types.js').Coverage} Coverage */
/** @typedef {import('./types.js').CoverageGap} CoverageGap */
/** @typedef {import('./types.js').Journey} Journey */
/** @typedef {import('./types.js').JourneySource} JourneySource */
/** @typedef {import('./types.js').Observation} Observation */
/** @typedef {import('./types.js').Store} Store */
/** @typedef {import('./types.js').Verdict} Verdict */
/** @typedef {import('./adapters/source.js').Door} Door */

/**
 * A journey that may have arrived with what the test suite says it touched.
 * @typedef {Journey & {touched?: {files: string[], functions: string[], ranButNotListed?: number}}} JourneyWithTouch
 */

/**
 * A door, reduced to what the ledger needs and nothing else.
 *
 * Separate from `Door` because a ledger can be built from doors read live out of the source
 * OR recovered from stored contract observations, and those two arrive in different shapes.
 * Everything downstream sees only this.
 *
 * @typedef {object} DoorFact
 * @property {'ipc'|'route'|'export'|'command'|'env'} kind
 * @property {string} name
 * @property {string} address        Where an observation about this door would live.
 * @property {string} [detail]
 * @property {string} [file]
 * @property {number} [line]
 * @property {string} [via]          How the code reader worked the name out.
 * @property {boolean} [named]       False when the name is built while the program runs.
 * @property {boolean} [inTest]
 * @property {string} [describe]
 */

/**
 * One walk that really happened: a journey that produced a capture, and everything that
 * walk knows about what it touched.
 *
 * @typedef {object} Walk
 * @property {string} journey
 * @property {string} [at]                    ISO timestamp of the capture.
 * @property {JourneySource} [source]
 * @property {string} [buildId]
 * @property {string[]} paths                 Non-contract observation addresses, and every
 *                                            prefix of each, so a lookup is one set hit.
 * @property {string[]} [doors]               Door keys the journey's steps name, for steps that
 *                                            named a door with nothing to tell apart from
 *                                            another of the same name. See doorKey.
 * @property {string[]} [doorAddresses]       Full door addresses, for steps that were specific
 *                                            enough to build one. A route step knows its verb,
 *                                            and GET /x and POST /x are two doors that share a
 *                                            doorKey — so a step that knows which one it knocked
 *                                            on lands here instead, and the other stays shut.
 * @property {string[]} [touchedFiles]
 * @property {string[]} [touchedFunctions]    'file:name', from the suite's own coverage.
 * @property {number} [functionsNotListed]    Functions that ran and were cut from the list to
 *                                            keep it readable. Every one of them is a door
 *                                            this ledger will call unopened when it was not.
 */

/**
 * One door, and what this tool has ever managed to do with it.
 *
 * @typedef {object} DoorEntry
 * @property {string} address
 * @property {'ipc'|'route'|'export'|'command'|'env'} kind
 * @property {string} name
 * @property {'opened'|'reached'|'never'} state
 * @property {string} how                     One plain sentence. Always filled in, including
 *                                            for a door nothing has ever been near.
 * @property {string[]} journeys              Journeys that opened it.
 * @property {string|null} lastWalkedAt       ISO, or null.
 * @property {boolean} walkable               False when nothing here could ever open it.
 * @property {string} [whyNot]                Why not, in plain English. Set when walkable is false.
 * @property {boolean} [irreversible]         Opening it for real cannot be undone. Watched at
 *                                            the call, refused at the effect, forever.
 * @property {string} [file]
 * @property {number} [line]
 * @property {string} [group]                 The family it belongs to, for the work queue.
 * @property {string} [groupLabel]
 */

/**
 * What this tool has ever seen of a product's doors.
 *
 * @typedef {object} Ledger
 * @property {string} product
 * @property {string} at                      ISO, when the ledger was drawn up.
 * @property {'per door'|'counts only'} knows Whether the entries name individual doors, or
 *                                            the ledger only had totals to work from.
 * @property {number} doors                   Doors the code reader knows about.
 * @property {number} opened
 * @property {number} reached                 Code ran; the door itself was never addressed.
 * @property {number} never
 * @property {number} unwalkable              Of `never`, the ones nothing here could ever open.
 * @property {number} work                    never minus unwalkable. The queue that is real.
 * @property {number} irreversible            Doors watched at the call and refused at the effect.
 * @property {DoorEntry[]} entries            Empty when `knows` is 'counts only'.
 * @property {Record<string, KindTally>} byKind
 * @property {number} journeys                Distinct journeys that produced a capture.
 * @property {Record<string, number>} byJourneySource
 * @property {Partial<Record<Channel, number>>} byChannel   Observations per channel.
 * @property {number} captures
 * @property {number} builds
 * @property {string[]} caveats               Every reason this ledger is less exact than it
 *                                            looks. Never empty when a shortcut was taken.
 * @property {CoverageGap[]} gaps             Holes carried over from the captures themselves.
 */

/**
 * @typedef {object} KindTally
 * @property {number} doors
 * @property {number} opened
 * @property {number} reached
 * @property {number} never
 */

/**
 * One thing worth covering next, written as a job rather than a statistic.
 *
 * @typedef {object} WorkItem
 * @property {string} group
 * @property {string} what
 * @property {string} why
 * @property {string} howTo                   The concrete next move.
 * @property {number} doors
 * @property {number} openedHere              How many of that family are already open.
 * @property {string[]} examples              Up to five door names, so it is not abstract.
 * @property {string[]} files                 Where they live, commonest first.
 * @property {number} rank                    Higher is more worth doing.
 */

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** @type {Record<string, string>} */
const KIND_ONE = {
  ipc: 'IPC channel', route: 'route', export: 'exported name', command: 'command',
  env: 'setting it reads',
};

/** @type {Record<string, string>} */
const KIND_MANY = {
  ipc: 'IPC channels', route: 'routes', export: 'exported names', command: 'commands',
  env: 'settings it reads',
};

/**
 * How much a never-opened door of each kind is worth covering.
 *
 * An IPC channel and a route are how the outside world reaches the product, so a break
 * behind one is a break somebody hits. An exported name matters to whoever imports it. A
 * setting is read rather than opened, and the contract channel already watches whether it
 * disappears, so there is no journey to write and it scores nothing.
 *
 * @type {Record<string, number>}
 */
const KIND_WEIGHT = { ipc: 10, route: 10, command: 6, export: 3, env: 0 };

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------

/**
 * Where an observation about this door would live.
 *
 * This has to agree exactly with `pathForDoor` in the source adapter, because the whole
 * ledger is a join between the addresses the code reader writes down and the addresses the
 * running product answers at. If those two ever drift apart, every door reads as never
 * opened and the tool starts asking for work that is already done.
 *
 * @param {{kind: string, name: string, detail?: string, file?: string}} door
 * @returns {string}
 */
export function doorAddress(door) {
  switch (door.kind) {
    case 'ipc': return joinPath(['ipc', door.name]);
    case 'route': return joinPath(['route', door.detail ?? '', door.name]);
    case 'export': return joinPath(['export', door.file ?? '', door.name]);
    case 'command': return joinPath(['cli', door.name]);
    default: return joinPath(['proc', 'env', door.name]);
  }
}

/**
 * The identity two different sources use to mean the same door — a journey step, and a door
 * read out of the code. Kind and name, and nothing else: the file a door is declared in can
 * move without the door changing.
 *
 * @param {{kind: string, name: string}} door
 * @returns {string}
 */
export function doorKey(door) {
  return `${door.kind} ${door.name}`;
}

/**
 * A door from the code reader, reduced to what the ledger needs.
 * @param {Door} door
 * @returns {DoorFact}
 */
export function doorFact(door) {
  return {
    kind: door.kind,
    name: door.name,
    address: doorAddress(door),
    detail: door.detail,
    file: door.file,
    line: door.line,
    via: door.via,
    named: door.named,
    inTest: door.inTest,
  };
}

/**
 * Recover the door list from stored contract observations.
 *
 * This is what makes `ledger(store, product)` work with nothing but a store: the addresses
 * the code reader wrote down are still sitting in the captures, so the door list can be read
 * back out of them without going anywhere near the project's source. It is poorer than
 * reading the code again — a door added since the last capture is not in here at all — and
 * the ledger says so in a caveat rather than letting it pass.
 *
 * @param {Observation[]} observations
 * @returns {DoorFact[]}
 */
export function doorsFromObservations(observations) {
  /** @type {Map<string, DoorFact>} */
  const found = new Map();
  for (const o of observations) {
    if (o.channel !== 'contract') continue;
    const parts = splitPath(o.path);
    if (parts[0] === 'count' || parts[1] === 'unreadable') continue;
    /** @type {DoorFact|null} */
    let door = null;
    const last = parts[parts.length - 1];
    if (parts[0] === 'ipc' && parts.length >= 3 && last === 'registered') {
      door = { kind: 'ipc', name: parts.slice(1, -1).join('.'), address: '' };
    } else if (parts[0] === 'route' && parts.length >= 4 && last === 'declared') {
      door = { kind: 'route', detail: parts[1], name: parts.slice(2, -1).join('.'), address: '' };
    } else if (parts[0] === 'cli' && parts.length >= 3 && last === 'declared') {
      door = { kind: 'command', name: parts.slice(1, -1).join('.'), address: '' };
    } else if (parts[0] === 'proc' && parts[1] === 'env' && parts.length >= 3) {
      door = { kind: 'env', name: parts.slice(2).join('.'), address: '' };
    } else if (parts[0] === 'export' && parts.length >= 3) {
      door = { kind: 'export', file: parts[1], name: parts.slice(2).join('.'), address: '' };
    }
    if (!door) continue;
    door.address = o.path.replace(/\.(registered|declared)$/, '');
    door.named = !(typeof o.value === 'string' && o.value.startsWith('there, but we cannot read its name'));
    if (o.meta?.source) door.file = o.meta.source;
    if (o.meta?.line !== undefined) door.line = o.meta.line;
    if (o.meta?.describe) door.describe = o.meta.describe;
    const key = doorKey(door);
    if (!found.has(key)) found.set(key, door);
  }
  return [...found.values()];
}

/**
 * Could anything here ever open this door, and if not, why not?
 *
 * Kept apart from "has it been opened" on purpose. A door nobody has walked is work; a door
 * nothing can walk is a permanent hole. Mixing the two produces a queue that never empties,
 * and a queue that never empties gets ignored.
 *
 * @param {DoorFact} door
 * @returns {{walkable: boolean, whyNot?: string, irreversible?: boolean}}
 */
export function walkability(door) {
  if (door.named === false) {
    return {
      walkable: false,
      whyNot: 'Its name is worked out while the program runs, so there is nothing to knock on. The contract channel still notices if it disappears.',
    };
  }
  if (door.kind === 'env') {
    return {
      walkable: false,
      whyNot: 'A setting is read, not opened. The contract channel watches whether the product still reads it, and that is everything this kind of door has to give.',
    };
  }
  if (door.kind === 'command' && !isRunnable(asDoor(door))) {
    return {
      walkable: false,
      whyNot: 'It is a flag rather than a program. A flag changes what a command does; it is not something a journey can walk through on its own.',
    };
  }
  const risk = irreversibility(asDoor(door));
  if (risk.irreversible) {
    return {
      walkable: false,
      irreversible: true,
      whyNot: `${risk.why} It is watched at the call and stopped there, so the call going out can be compared but the door is never really opened. That is deliberate and permanent.`,
    };
  }
  return { walkable: true };
}

/**
 * A DoorFact in the shape the code reader's own helpers expect.
 * @param {DoorFact} door
 * @returns {Door}
 */
function asDoor(door) {
  return {
    kind: door.kind,
    name: door.name,
    detail: door.detail ?? '',
    file: door.file ?? '',
    line: door.line ?? 0,
    inTest: door.inTest ?? false,
    named: door.named ?? true,
    via: door.via ?? '',
  };
}

// ---------------------------------------------------------------------------
// What a walk touched
// ---------------------------------------------------------------------------

/**
 * Every address a capture observed, plus every prefix of each, so asking "did anything
 * happen at this door" is one set lookup instead of a scan of every path.
 *
 * Contract observations are dropped here, and that single line is the honesty of the whole
 * file: reading a door out of the source is how we know it exists, never evidence that
 * anybody opened it.
 *
 * @param {Observation[]} observations
 * @returns {{paths: string[], byChannel: Partial<Record<Channel, number>>}}
 */
export function addressesTouched(observations) {
  /** @type {Set<string>} */
  const paths = new Set();
  /** @type {Partial<Record<Channel, number>>} */
  const byChannel = {};
  for (const o of observations) {
    byChannel[o.channel] = (byChannel[o.channel] ?? 0) + 1;
    if (o.channel === 'contract') continue;
    const parts = String(o.path).split('.');
    for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join('.'));
  }
  return { paths: [...paths], byChannel };
}

/**
 * A walk, built from one stored capture and, when it is to hand, the journey behind it.
 *
 * @param {Capture} capture
 * @param {JourneyWithTouch} [journey]
 * @returns {Walk}
 */
export function walkFromCapture(capture, journey) {
  const touched = addressesTouched(capture.observations);
  /** @type {Walk} */
  const walk = {
    journey: capture.journey,
    at: capture.startedAt,
    source: capture.source ?? journey?.source,
    buildId: capture.build?.id,
    paths: touched.paths,
  };
  if (journey?.steps) {
    // Two lists, because a doorKey is kind and name only. That is right for an IPC channel or
    // an exported name, where the name IS the door; it is wrong for a route, where GET /basket
    // and POST /basket share a key and are two different doors. A step that knows which one it
    // knocked on says so with `doorDetail`, and goes in the exact list — otherwise walking GET
    // would report POST as walked too, which is the coverage ledger lying in the one direction
    // it must never lie in.
    const named = journey.steps.filter((s) => typeof s.door === 'string' && typeof s.kind === 'string');
    const exact = named.filter((s) => typeof s.doorDetail === 'string' && s.doorDetail !== '');
    const byName = named.filter((s) => typeof s.doorDetail !== 'string' || s.doorDetail === '');
    if (byName.length > 0) walk.doors = byName.map((s) => doorKey({ kind: String(s.kind), name: String(s.door) }));
    if (exact.length > 0) {
      walk.doorAddresses = exact.map((s) =>
        doorAddress({ kind: String(s.kind), name: String(s.door), detail: String(s.doorDetail), file: typeof s.doorFile === 'string' ? s.doorFile : undefined }),
      );
    }
  }
  if (journey?.touched?.files) walk.touchedFiles = journey.touched.files;
  if (journey?.touched?.functions) walk.touchedFunctions = journey.touched.functions;
  if (journey?.touched?.ranButNotListed) walk.functionsNotListed = journey.touched.ranButNotListed;
  return walk;
}

/**
 * Kinds where an observation sharing a door's address really is that door.
 *
 * `command` is missing on purpose. A command's runtime observations are addressed
 * `cli.<journey name>…`, not `cli.<command name>…`, so a journey that happened to be named
 * after a command would count that command as walked when nothing had run it. Undercounting
 * a command leaves a job on the queue; overcounting one is a lie, so the address rule is
 * switched off for commands and only a journey step can open one.
 */
const ADDRESS_RULE = new Set(['ipc', 'route', 'export', 'env']);

/**
 * What one walk did with one door, or null if it did nothing with it.
 *
 * @param {DoorFact} door
 * @param {Walk} walk
 * @param {Set<string>} paths      walk.paths, as a set.
 * @returns {{state: 'opened'|'reached', how: string}|null}
 */
export function whatTheWalkDid(door, walk, paths) {
  if (walk.doorAddresses?.includes(door.address) || walk.doors?.includes(doorKey(door))) {
    return { state: 'opened', how: `"${walk.journey}" has a step that knocks on it directly.` };
  }
  if (ADDRESS_RULE.has(door.kind)) {
    if (paths.has(door.address) || paths.has(trimmedAddress(door))) {
      return { state: 'opened', how: `"${walk.journey}" saw the product answer at its own address.` };
    }
    if (door.kind === 'export' && paths.has(joinPath(['export', walk.journey, door.name]))) {
      return { state: 'opened', how: `"${walk.journey}" read it off the module's exported surface.` };
    }
  }
  if (door.kind === 'export' && door.file && walk.touchedFunctions?.includes(`${door.file}:${door.name}`)) {
    return { state: 'opened', how: `"${walk.journey}" ran it — the test suite's own coverage says the function executed.` };
  }
  if (door.file && walk.touchedFiles?.includes(door.file)) {
    return {
      state: 'reached',
      how: `"${walk.journey}" ran ${door.file}, so the code around it executed, but nothing addressed this door itself.`,
    };
  }
  return null;
}

/**
 * The address a running product would actually use, for a name long enough to have been cut
 * short on the way into a path. Adapters shorten a long segment; the code reader does not,
 * so the two only ever meet if the ledger shortens too.
 *
 * @param {DoorFact} door
 * @returns {string}
 */
function trimmedAddress(door) {
  if (door.kind !== 'ipc') return door.address;
  return joinPath(['ipc', asAddress(door.name)]);
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/**
 * @typedef {object} LedgerInput
 * @property {string} product
 * @property {DoorFact[]} doors
 * @property {Walk[]} walks
 * @property {Partial<Record<Channel, number>>} [byChannel]
 * @property {number} [captures]
 * @property {number} [builds]
 * @property {string[]} [caveats]
 * @property {CoverageGap[]} [gaps]
 * @property {string} [at]
 */

/**
 * Draw up the ledger. Pure: hand it doors and walks, get the answer — no disk, and no clock
 * beyond the one stamp saying when. Everything that touches a store lives in {@link ledger},
 * so this half can be tested with lists written by hand.
 *
 * @param {LedgerInput} input
 * @returns {Ledger}
 */
export function buildLedger(input) {
  /** @type {DoorEntry[]} */
  const entries = [];
  const walks = input.walks.map((walk) => ({ walk, paths: new Set(walk.paths) }));

  /** @type {Record<string, KindTally>} */
  const byKind = {};
  /** @type {Record<string, number>} */
  const byJourneySource = {};
  let opened = 0;
  let reached = 0;
  let never = 0;
  let unwalkable = 0;
  let irreversibleDoors = 0;

  for (const door of input.doors) {
    const can = walkability(door);
    /** @type {{journey: string, at?: string, how: string, state: 'opened'|'reached'}[]} */
    const hits = [];
    for (const { walk, paths } of walks) {
      const did = whatTheWalkDid(door, walk, paths);
      if (did) hits.push({ journey: walk.journey, at: walk.at, how: did.how, state: did.state });
    }
    const openedBy = hits.filter((h) => h.state === 'opened');
    const reachedBy = hits.filter((h) => h.state === 'reached');
    /** @type {DoorEntry['state']} */
    const state = openedBy.length > 0 ? 'opened' : reachedBy.length > 0 ? 'reached' : 'never';
    const evidence = openedBy.length > 0 ? openedBy : reachedBy;
    const best = evidence[0];
    const stamps = evidence.map((h) => h.at).filter((at) => typeof at === 'string').sort();

    const family = familyOf(asDoor(door));

    /** @type {DoorEntry} */
    const entry = {
      address: door.address,
      kind: door.kind,
      name: door.name,
      state,
      how: best
        ? best.how
        : can.walkable
          ? `Nothing has ever opened it, so a break behind this ${KIND_ONE[door.kind] ?? 'door'} would not be seen.`
          : /** @type {string} */ (can.whyNot),
      journeys: [...new Set(evidence.map((h) => h.journey))],
      lastWalkedAt: stamps.length > 0 ? /** @type {string} */ (stamps[stamps.length - 1]) : null,
      walkable: can.walkable,
      group: family.group,
      groupLabel: family.label,
    };
    if (!can.walkable) entry.whyNot = can.whyNot;
    if (can.irreversible) entry.irreversible = true;
    if (door.file) entry.file = door.file;
    if (door.line !== undefined) entry.line = door.line;
    entries.push(entry);

    const tally = byKind[door.kind] ?? { doors: 0, opened: 0, reached: 0, never: 0 };
    byKind[door.kind] = tally;
    tally.doors++;
    if (state === 'opened') { opened++; tally.opened++; }
    else if (state === 'reached') { reached++; tally.reached++; }
    else { never++; tally.never++; }
    if (state === 'never' && !can.walkable) unwalkable++;
    if (can.irreversible) irreversibleDoors++;
  }

  for (const { walk } of walks) {
    const source = walk.source ?? 'unknown';
    byJourneySource[source] = (byJourneySource[source] ?? 0) + 1;
  }

  const caveats = [...(input.caveats ?? [])];
  const namedSteps = walks.some(({ walk }) => (walk.doors?.length ?? 0) > 0);
  const knewFunctions = walks.some(({ walk }) => (walk.touchedFunctions?.length ?? 0) > 0);
  const blind = (byKind.route?.never ?? 0) + (byKind.command?.never ?? 0);
  if (walks.length > 0 && !namedSteps && blind > 0) {
    caveats.push(
      `No journey here has steps that name the door they knock on, so a door counts as opened only when something was observed at its own address. A route and a command are both addressed to the journey rather than to the door, so those ${blind} are undercounted. Walk the journeys the code reader generates and the answer becomes exact.`,
    );
  }
  if (walks.length > 0 && !knewFunctions && (byKind.export?.never ?? 0) > 0) {
    caveats.push(
      `Nothing here knows which functions the test suite ran, so an exported name counts as opened only if a journey addressed it directly — which is why ${byKind.export?.never} of them read as never opened. Install the test runner's coverage package and the suite says exactly what it touched.`,
    );
  }
  const cutFunctions = walks.reduce((n, { walk }) => n + (walk.functionsNotListed ?? 0), 0);
  if (cutFunctions > 0) {
    caveats.push(
      `${cutFunctions} functions that really did run were cut from the coverage lists to keep them readable, so up to that many of the doors counted as never opened were in fact opened. This ledger undercounts, and it undercounts by no more than ${cutFunctions}.`,
    );
  }
  if (input.doors.length === 0) {
    caveats.push('No doors are known at all, so this ledger cannot say what is uncovered — which is not the same as there being nothing uncovered.');
  }
  if (walks.length === 0) {
    caveats.push('Nothing has ever been walked against this product, so every door here is unopened by definition and no run has proved anything about any of them.');
  }

  return {
    product: input.product,
    at: input.at ?? new Date().toISOString(),
    knows: 'per door',
    doors: input.doors.length,
    opened,
    reached,
    never,
    unwalkable,
    work: never - unwalkable,
    irreversible: irreversibleDoors,
    entries,
    byKind,
    journeys: new Set(walks.map(({ walk }) => walk.journey)).size,
    byJourneySource,
    byChannel: input.byChannel ?? {},
    captures: input.captures ?? walks.length,
    builds: input.builds ?? 0,
    caveats,
    gaps: input.gaps ?? [],
  };
}

/**
 * @typedef {object} LedgerOptions
 * @property {Door[]} [doors]           The code reader's own output. The best answer there is.
 * @property {string} [root]            Read the code now to get the doors. Reads, runs nothing.
 * @property {JourneyWithTouch[]} [journeys]
 *                                      The journeys behind the captures. With these, a door
 *                                      is matched by the step that knocks on it, which is
 *                                      exact; without them the ledger falls back to addresses
 *                                      and says so out loud.
 * @property {number} [maxBuilds]       How far back to look. Default 20, newest first.
 * @property {string[]} [builds]        Exactly these build ids, instead of the newest.
 * @property {boolean} [includeTests]   Count doors registered inside test files. Off: a fake
 *                                      registration in a test is not a door the product answers on.
 * @property {(message: string) => void} [log]
 */

/**
 * Everything this tool has ever managed to walk of one product, door by door.
 *
 * Works with nothing but a store, because the door list can be recovered from the contract
 * observations already sitting in the captures. Hand it `root` or `doors` and it gets
 * better: a door added since the last capture is invisible to the store-only answer, and
 * the ledger names which of the two it used.
 *
 * @param {Store} store
 * @param {string} product
 * @param {LedgerOptions} [opts]
 * @returns {Promise<Ledger>}
 */
export async function ledger(store, product, opts = {}) {
  const log = opts.log ?? (() => {});
  /** @type {string[]} */
  const caveats = [];
  /** @type {CoverageGap[]} */
  const holes = [];

  const all = await listBuilds(store, {
    product,
    // A build folder that could not be read is a build that is simply not in this ledger,
    // and "not in the ledger" is indistinguishable from "never happened". It is a hole, and
    // holes are this file's entire subject.
    onProblem: (message) =>
      holes.push({
        what: message,
        why: 'A door this tool opened during that build therefore reads here as never opened.',
        unlockedBy: 'Run a check against that build again; a good record replaces the unreadable one.',
      }),
  });
  const wanted = opts.builds
    ? all.filter((b) => opts.builds?.includes(b.fingerprint.id))
    : all.slice(0, opts.maxBuilds ?? 20);
  if (!opts.builds && all.length > wanted.length) {
    caveats.push(
      `Only the newest ${wanted.length} of this product's ${all.length} builds were read. A door opened once, longer ago than that, reads here as never opened.`,
    );
  }

  /** @type {Map<string, JourneyWithTouch>} */
  const byName = new Map();
  for (const journey of opts.journeys ?? []) byName.set(journey.name, journey);

  /** @type {Walk[]} */
  const walks = [];
  /** @type {Observation[]} */
  const contractSeen = [];
  /** @type {Partial<Record<Channel, number>>} */
  const byChannel = {};
  let captures = 0;

  for (const build of wanted) {
    const refs = await listCaptures(store, { buildId: build.fingerprint.id });
    for (const ref of refs) {
      /** @type {Capture|null} */
      let capture = null;
      try {
        capture = await loadCapture(store, ref);
      } catch {
        capture = null;
      }
      if (!capture) {
        holes.push({
          what: `One stored record of "${ref.journey}" could not be read.`,
          why: 'The file is missing or unreadable, so whatever that walk saw is not counted here.',
          unlockedBy: 'Walk the journey again; a good capture replaces the unreadable one.',
        });
        continue;
      }
      captures++;
      log(`Reading ${ref.journey} from ${build.fingerprint.id}.`);
      if (capture.complete === false) {
        holes.push({
          what: `The record of "${capture.journey}" was read back torn.`,
          why: 'The run that wrote it stopped partway, so some of what it walked is missing from this ledger.',
          unlockedBy: 'Walk it again; a complete capture replaces the torn one.',
        });
      }
      const touched = addressesTouched(capture.observations);
      if (!opts.doors && !opts.root) {
        for (const o of capture.observations) if (o.channel === 'contract') contractSeen.push(o);
      }
      for (const [channel, n] of Object.entries(touched.byChannel)) {
        const key = /** @type {Channel} */ (channel);
        byChannel[key] = (byChannel[key] ?? 0) + n;
      }
      walks.push(walkFromCapture(capture, byName.get(capture.journey)));
      for (const gap of capture.coverage?.gaps ?? []) holes.push(gap);
    }
  }

  /** @type {DoorFact[]} */
  let doors;
  if (opts.doors) {
    doors = opts.doors.map(doorFact);
    caveats.push('The doors were handed in by the code reader as this ledger was drawn up, so it knows about doors added since the last run.');
  } else if (opts.root) {
    const reading = await readContract({ root: opts.root });
    const fileRoutes = await readFileRoutes(opts.root);
    reading.doors.push(...fileRoutes.doors);
    reading.doors.push(...(await readPackageCommands(opts.root)));
    for (const problem of fileRoutes.problems) {
      holes.push({
        what: problem,
        why: 'Doors nobody can see are not counted here, so this ledger is smaller than the product is.',
        unlockedBy: 'Make that folder readable by whoever runs the check.',
      });
    }
    doors = reading.doors.map(doorFact);
    caveats.push(`The code was read as this ledger was drawn up: ${reading.report.filesRead} files, ${reading.doors.length} doors, and nothing was run.`);
  } else {
    doors = doorsFromObservations(contractSeen);
    caveats.push(
      'The door list came from what previous runs wrote down, not from the code as it stands now, so a door added since the last run is not in this ledger at all. Pass `root` and it reads the source instead.',
    );
  }
  if (!opts.includeTests) {
    const before = doors.length;
    doors = doors.filter((d) => d.inTest !== true);
    if (before > doors.length) {
      caveats.push(`${before - doors.length} doors registered inside test files were left out: a fake registration in a test is not a door the product answers on.`);
    }
  }

  const pointer = await referencePointer(store, product);
  if (!pointer) {
    caveats.push('This product has no reference build yet, so nothing here has ever been compared against a build somebody called working.');
  }

  return buildLedger({
    product,
    doors,
    walks,
    byChannel,
    captures,
    builds: wanted.length,
    caveats,
    gaps: dedupeGaps(holes),
  });
}

// ---------------------------------------------------------------------------
// The work queue
// ---------------------------------------------------------------------------

/**
 * @typedef {object} GapsOptions
 * @property {number} [worst]              How many jobs to hand back. Default 12.
 * @property {boolean} [includeUnwalkable] Include doors nothing here could ever open. Off:
 *                                         they belong in the honest total, not in a queue,
 *                                         and the ledger counts them either way.
 * @property {number} [minDoors]           Ignore families smaller than this. Default 1.
 */

/**
 * The doors most worth covering next, grouped into jobs and ranked.
 *
 * A list of five thousand unopened doors is a wall, and a wall gets ignored. The same doors
 * grouped by family — the IPC channels that start with "session", the routes under /api/deck,
 * what the files in src/main/store export — is a morning's work with a beginning and an end.
 *
 * Ranked by how much the kind of door matters, how many of them are dark, and hardest of
 * all, whether the WHOLE family is dark. A family with nothing walked is a part of the
 * product this tool has never once seen, and that is worth more than another door in an area
 * it already knows something about.
 *
 * @param {Ledger} led
 * @param {GapsOptions} [opts]
 * @returns {WorkItem[]}
 */
export function gaps(led, opts = {}) {
  const worst = opts.worst ?? 12;
  const minDoors = opts.minDoors ?? 1;

  /** @type {Map<string, {label: string, kind: string, never: DoorEntry[], opened: number, reached: number, files: Map<string, number>}>} */
  const families = new Map();
  for (const entry of led.entries) {
    if (!opts.includeUnwalkable && !entry.walkable) continue;
    const key = entry.group ?? entry.kind;
    const family = families.get(key) ?? {
      label: entry.groupLabel ?? KIND_MANY[entry.kind] ?? entry.kind,
      kind: entry.kind,
      never: /** @type {DoorEntry[]} */ ([]),
      opened: 0,
      reached: 0,
      files: /** @type {Map<string, number>} */ (new Map()),
    };
    if (entry.state === 'opened') family.opened++;
    else if (entry.state === 'reached') family.reached++;
    else family.never.push(entry);
    if (entry.file) family.files.set(entry.file, (family.files.get(entry.file) ?? 0) + 1);
    families.set(key, family);
  }

  // Telling somebody to harvest a suite that has already been harvested is the kind of
  // advice that gets a tool switched off, so the queue checks first.
  const harvested = (led.byJourneySource.suite ?? 0) > 0;

  /** @type {WorkItem[]} */
  const jobs = [];
  for (const [group, family] of families) {
    if (family.never.length < minDoors) continue;
    const total = family.never.length + family.opened + family.reached;
    const allDark = family.opened === 0;
    const weight = KIND_WEIGHT[family.kind] ?? 3;
    // Size counts, but under a square root, so one family of four hundred cannot bury twenty
    // families of ten that between them cover far more of the product.
    const rank = Math.round(
      weight * Math.sqrt(family.never.length) * (allDark ? 2 : 1) + (family.reached > 0 ? 2 : 0),
    );
    jobs.push({
      group,
      what: `${family.label} — ${family.never.length} of ${total} never opened.`,
      why: allDark
        ? `Nothing has ever walked any of this. If it broke, no run of this tool would notice.${
            family.reached > 0
              ? ` ${family.reached} of them sit in code the tests do run, so the break would be right beside a path that looks covered.`
              : ''
          }`
        : `${family.opened} of them are covered and ${family.never.length} are not, so a clean run here means less than it looks like it does.`,
      howTo: howToCover(family.kind, family.never, harvested),
      doors: family.never.length,
      openedHere: family.opened,
      examples: family.never.slice(0, 5).map((e) => e.name),
      files: [...family.files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([file]) => file),
      rank,
    });
  }

  const ranked = jobs.sort((a, b) => (b.rank === a.rank ? b.doors - a.doors : b.rank - a.rank));
  if (ranked.length <= worst) return ranked;

  // The cut is real and it used to be invisible. `toCoverage` asks for eight jobs; a product
  // with forty families of unopened doors handed back eight and said nothing about the other
  // thirty-two, so the coverage list — the one place in this tool whose entire job is naming
  // what was NOT looked at — was itself quietly truncated. The last slot says what is missing
  // rather than being one more job.
  const shown = ranked.slice(0, Math.max(0, worst - 1));
  const rest = ranked.slice(Math.max(0, worst - 1));
  const doors = rest.reduce((n, job) => n + job.doors, 0);
  shown.push({
    group: 'everything else that is unopened',
    what: `${rest.length} more ${rest.length === 1 ? 'family' : 'families'} of doors are never opened and are not listed above.`,
    why: `Between them they hold ${doors} ${doors === 1 ? 'door' : 'doors'} nothing has ever walked through, so a clean run says nothing about any of them either. Only the ${shown.length} worth doing first are named here.`,
    howTo: `Work through the ones above, or ask for the whole list at once. The families left out start with ${rest.slice(0, 3).map((job) => job.group).join(', ')}.`,
    doors,
    openedHere: 0,
    examples: rest.slice(0, 5).map((job) => job.group),
    files: [],
    rank: 0,
  });
  return shown;
}

/**
 * The concrete next move for a family of unopened doors. Written for whoever reads it next,
 * which is usually an agent and occasionally a person, and never assumes either of them has
 * read any documentation.
 *
 * @param {string} kind
 * @param {DoorEntry[]} never
 * @param {boolean} [harvested]   The project's own tests have already been harvested, so
 *                                telling anyone to go and harvest them would be noise.
 * @returns {string}
 */
function howToCover(kind, never, harvested = false) {
  const first = never[0]?.name ?? 'one of them';
  switch (kind) {
    case 'ipc':
      return `Walk them. The code reader already turns these into a journey that invokes each channel: run the check with the journeys read out of the code switched on, or harvest the tests that already call "${first}".`;
    case 'route':
      return `Ask for them. A journey that requests each route writes down the status, the shape of the answer and what went out. Start with "${first}".`;
    case 'command':
      return `Run them. Each one is a program with a stdout, a stderr and an exit code, and all three are compared. Start with "${first}".`;
    case 'export':
      return harvested
        ? `The project's own tests have already been harvested and they do not reach these, so nothing existing covers them. Either they are dead code worth deleting, or they need a test that calls them — starting with "${first}".`
        : `Write a journeys file that calls them and pass it with --journeys — starting with "${first}". (Harvesting the project's own tests would answer this for free, and that is written and not yet wired into a run.)`;
    default:
      return `Add a journey that reaches "${first}" and the ones beside it.`;
  }
}

// ---------------------------------------------------------------------------
// Into the shape the rest of the tool speaks
// ---------------------------------------------------------------------------

/**
 * The ledger folded into the `Coverage` shape a verdict carries, so a run can report the
 * whole picture without anything else having to learn what a ledger is.
 *
 * @param {Ledger} led
 * @param {{worst?: number}} [opts]
 * @returns {Coverage}
 */
export function toCoverage(led, opts = {}) {
  /** @type {CoverageGap[]} */
  const out = [...led.gaps];
  if (led.doors > 0 && led.never > 0) {
    out.push({
      // A product with one door read "1 of this product's 1 doors have never been opened",
      // which is the sentence a reader stops believing the rest of the report over. The count
      // is the whole point of the line, so it is worth the four words it costs to say it in
      // English.
      what: led.doors === 1
        ? "This product's only door has never been opened by this tool."
        : led.never === 1
          ? `1 of this product's ${led.doors} doors has never been opened by this tool.`
          : `${led.never} of this product's ${led.doors} doors have never been opened by this tool.`,
      why: led.never === 1
        ? 'No journey reaches it, so a break behind it would not show up in any run — clean or otherwise.'
        : 'No journey reaches them, so a break behind one of them would not show up in any run — clean or otherwise.',
      unlockedBy: led.work > 0
        ? led.work === 1
          ? 'It could be covered by a journey that reaches it — read out of your source, or named by hand in a journeys file.'
          : `${led.work} of them could be covered by journeys that reach them — read out of your source, or named by hand in a journeys file.`
        : led.never === 1
          ? 'Nothing. It is a door this tool cannot open from here, and it says why.'
          : 'Nothing. Every one of them is a door this tool cannot open from here, and each says why.',
      channel: 'contract',
      doors: led.never,
    });
  }
  for (const job of gaps(led, { worst: opts.worst ?? 8 })) {
    out.push({ what: job.what, why: job.why, unlockedBy: job.howTo, channel: 'contract', doors: job.doors });
  }
  for (const caveat of led.caveats) {
    out.push({
      what: 'This coverage count is less exact than it looks.',
      why: caveat,
      unlockedBy: 'Read the caveat: it says what would make it exact.',
    });
  }
  /** @type {Coverage} */
  const coverage = {
    paths: Object.values(led.byChannel).reduce((a, b) => a + b, 0),
    journeys: led.journeys,
    byChannel: led.byChannel,
    gaps: dedupeGaps(out),
  };
  if (led.doors > 0) {
    coverage.doorsKnown = led.doors;
    coverage.doorsWalked = led.opened;
  }
  return coverage;
}

/**
 * @param {CoverageGap[]} list
 * @returns {CoverageGap[]}
 */
function dedupeGaps(list) {
  /** @type {CoverageGap[]} */
  const out = [];
  const seen = new Set();
  for (const gap of list) {
    const key = `${gap.what}|${gap.why}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(gap);
  }
  return out;
}
