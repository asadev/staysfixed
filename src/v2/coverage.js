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
import { CHANNELS, joinPath, splitPath } from './observation.js';
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
 * @property {{door: string, status: number}[]} [onlyRedirected]
 *                                            Doors that answered with a redirect. Walked — the
 *                                            bounce is real behaviour — but what is behind them
 *                                            was never seen.
 * @property {{door: string, status: number}[]} [knockedShut]
 *                                            Doors a step knocked on where the running build
 *                                            answered that they are not there. Knocking is not
 *                                            walking, and these have proved nothing.
 * @property {string[]} [notTried]            Doors this journey's steps name, on a walk that
 *                                            never happened — the adapter refused it and wrote
 *                                            down only that. Nobody knocked, so nothing here
 *                                            is walked.
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
 * A refusal is dropped for the same reason. When an adapter cannot look at something it
 * writes that down at the address it would have looked at, marked `refused` — a payment it
 * would not make, a server that never started, a route with a parameter nobody supplied.
 * Left in, the note saying "we did not look here" became the evidence that we did.
 *
 * Both still count in `byChannel`: they were written down, and the tallies say how much was
 * written down. It is only the "somebody opened this door" set they are kept out of.
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
    if (o.meta?.refused === true) continue;
    const parts = String(o.path).split('.');
    for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join('.'));
  }
  return { paths: [...paths], byChannel };
}

/**
 * Answers that mean the door is not there in the build that ran.
 *
 * A 500 is deliberately NOT here: the route exists and it broke, which is a real difference
 * and exactly what a check is for. These four are the codes that say the thing the source
 * declares was never reachable, so nothing has been proved about it either way.
 */
const NOTHING_THERE = new Set([404, 405, 410, 501]);

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
  // NOTHING WAS TRIED IS NOT A WALK.
  //
  // Every adapter has branches where it runs nothing and says so: the server never came up,
  // the route has a `:id` nobody supplied a value for, the command spends money and there is
  // nothing watching to stop it. Each one writes a single observation marked `refused` and
  // returns. No `api.<door>.status` comes back, because no request went out.
  //
  // The status rule below reads a missing status as "it answered something we are happy
  // with", so every one of those doors counted as walked. Measured 2026-08-31 with the HTTP
  // adapter's own output: one route, one journey, the server never started, and the ledger
  // came back doorsWalked 1 of 1 — full coverage of a product that had not been run — in the
  // same report whose only line read "was not tried: It never started."
  //
  // A capture whose entire non-contract record is refusals is a walk that did nothing. Its
  // steps opened nothing, and the doors they name are listed rather than dropped.
  const seen = capture.observations ?? [];
  const refusals = seen.filter((o) => o?.meta?.refused === true);
  const anythingHappened = seen.some((o) => o?.channel !== 'contract' && o?.meta?.refused !== true);
  const nothingWasTried = refusals.length > 0 && !anythingHappened;

  if (journey?.steps) {
    // Two lists, because a doorKey is kind and name only. That is right for an IPC channel or
    // an exported name, where the name IS the door; it is wrong for a route, where GET /basket
    // and POST /basket share a key and are two different doors. A step that knows which one it
    // knocked on says so with `doorDetail`, and goes in the exact list — otherwise walking GET
    // would report POST as walked too, which is the coverage ledger lying in the one direction
    // it must never lie in.
    const named = journey.steps.filter((s) => typeof s.door === 'string' && typeof s.kind === 'string');

    // KNOCKING IS NOT WALKING.
    //
    // A door was counted as walked because a STEP said it knocked on it — whatever came back.
    // So a route the source declares and the running build answers 404 counted as covered; and
    // behind a login wall, where every request is bounced to /login, every door in the product
    // counted as walked and the run came back clean. That is the coverage ledger lying in the
    // one direction this file says it must never lie in.
    //
    // What answered is on the record: the http adapter writes `api.<door>.status`. A 404, 405,
    // 410 or 501 means the thing the code declares is not there in the build that ran, so
    // nothing was proved about it and it stays shut.
    const answered = new Map();
    for (const ob of capture.observations ?? []) {
      const found = /^api\.(.+)\.status$/.exec(String(ob?.path ?? ''));
      if (found) answered.set(found[1], Number(ob.value));
    }
    /** @type {{door: string, status: number}[]} */
    const shut = [];
    /** @type {{door: string, status: number}[]} */
    const bounced = [];
    /** @type {string[]} */
    const untried = [];
    /** @param {any} s @returns {boolean} */
    const reallyWalked = (s) => {
      // The door is the ROUTE (`/reports`); the observation is addressed by method and route
      // together (`api.GET /reports.status`), because GET and POST on one path are two doors.
      // Try the composite first and the bare name after, so both shapes of step are covered.
      const keys = [
        typeof s.doorDetail === 'string' && s.doorDetail ? `${s.doorDetail} ${s.door}` : null,
        typeof s.method === 'string' && s.method ? `${s.method} ${s.door}` : null,
        String(s.door),
      ].filter(Boolean);
      if (nothingWasTried) {
        untried.push(String(keys[0] ?? s.door));
        return false;
      }
      const key = keys.find((k) => answered.has(/** @type {string} */ (k)));
      const code = key === undefined ? undefined : answered.get(/** @type {string} */ (key));
      // A redirect is real behaviour and it IS walked — but what you saw is the bounce, not the
      // thing behind it. Behind a login wall every door answers 302 to /login, and the run
      // then reports full coverage of a product it never got into.
      if (typeof code === 'number' && code >= 300 && code < 400) {
        bounced.push({ door: String(key), status: code });
        return true;
      }
      if (typeof code !== 'number' || !NOTHING_THERE.has(code)) return true;
      shut.push({ door: String(key), status: code });
      return false;
    };

    const exact = named.filter((s) => typeof s.doorDetail === 'string' && s.doorDetail !== '').filter(reallyWalked);
    const byName = named.filter((s) => typeof s.doorDetail !== 'string' || s.doorDetail === '').filter(reallyWalked);
    if (shut.length > 0) walk.knockedShut = shut;
    if (bounced.length > 0) walk.onlyRedirected = bounced;
    if (untried.length > 0) walk.notTried = untried;
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
// One order, every time
// ---------------------------------------------------------------------------

/**
 * TWO IDENTICAL RUNS HAVE TO SAY THE SAME THING.
 *
 * This tool's whole method is running the same thing twice and subtracting what disagrees.
 * A report that disagrees with itself between two identical runs is not untidy — it is the
 * measurement contradicting the method, and a reader who spots it has no reason to believe
 * the rest.
 *
 * It was doing exactly that. A capture id ends in three random bytes, deliberately, so two
 * captures written inside the same second do not overwrite each other — and the store hands
 * captures back in id order, so those random bytes decide which walk is read first. Measured
 * 2026-08-31 on one unchanged product, three runs: help, the-code, the-code, help; then
 * the-code, help, the-code, help; then help, the-code, the-code, help.
 *
 * Everything the ledger built in that order came out shuffled with it — which of two
 * journeys got named as the evidence for a door, which six of eight shut doors got listed by
 * name in the caveat, the order of the gaps, the key order of the tallies. So the walks are
 * put in an order of the ledger's own before anything reads them, and that order is a
 * function of what is IN each walk, never of when it arrived.
 *
 * @param {Walk[]} walks
 * @returns {Walk[]}
 */
function inWalkOrder(walks) {
  return [...walks]
    .map((walk) => ({ walk, key: walkOrderKey(walk) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ walk }) => walk);
}

/**
 * The whole of one walk, squeezed into a single sortable string.
 *
 * Every field that can reach the report is in here, so two walks only ever tie when they
 * would produce the same words either way round. The addresses are the exception: a walk on
 * a big product carries tens of thousands of them, and holding all of that in a sort key
 * costs more than the ordering is worth. How many there are, plus a fingerprint of them,
 * tells two walks apart just as well and stays one short string.
 *
 * @param {Walk} walk
 * @returns {string}
 */
function walkOrderKey(walk) {
  return [
    walk.journey ?? '',
    walk.at ?? '',
    walk.buildId ?? '',
    walk.source ?? '',
    String((walk.paths ?? []).length),
    digestOf(walk.paths ?? []),
    (walk.doors ?? []).join('\u0001'),
    (walk.doorAddresses ?? []).join('\u0001'),
    (walk.knockedShut ?? []).map((d) => `${d.door}=${d.status}`).join('\u0001'),
    (walk.onlyRedirected ?? []).map((d) => `${d.door}=${d.status}`).join('\u0001'),
    (walk.notTried ?? []).join('\u0001'),
    (walk.touchedFiles ?? []).join('\u0001'),
    (walk.touchedFunctions ?? []).join('\u0001'),
    String(walk.functionsNotListed ?? 0),
  ].join('\u0000');
}

/**
 * A short fingerprint of a list of strings. FNV-1a, written out rather than imported,
 * because this file has no business opening a crypto library to decide a sort order.
 *
 * @param {string[]} items
 * @returns {string}
 */
function digestOf(items) {
  let hash = 0x811c9dc5;
  for (const item of items) {
    for (let i = 0; i < item.length; i++) {
      hash ^= item.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x0a;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Sort a list of pairs by the first of the two. Used wherever a caveat names only the first
 * few of something: which few get named has to be decided by their names.
 *
 * @param {[string, unknown]} a
 * @param {[string, unknown]} b
 * @returns {number}
 */
function byFirst(a, b) {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/**
 * The channel tallies written out in one fixed order — the channel list's own, not the order
 * the observations happened to arrive in. Same reason as {@link inWalkOrder}: this object is
 * printed by `--json`, and JSON keeps the order keys were added in.
 *
 * @param {Partial<Record<Channel, number>>} byChannel
 * @returns {Partial<Record<Channel, number>>}
 */
function inChannelOrder(byChannel) {
  /** @type {Record<string, number>} */
  const out = {};
  const held = /** @type {Record<string, number>} */ (byChannel);
  for (const channel of CHANNELS) if (held[channel] !== undefined) out[channel] = held[channel];
  // A channel this build of the tool has never heard of is still evidence somebody wrote
  // down, and dropping it would make the report smaller than the run was.
  for (const channel of Object.keys(held).sort()) if (out[channel] === undefined) out[channel] = held[channel];
  return out;
}

/**
 * Sort gaps into an order of their own. Only for gaps whose order carries no meaning — the
 * ones read back out of stored captures, which arrive in whatever order the disk listed
 * them. The gaps `toCoverage` builds are in rank order and are left exactly as they are.
 *
 * @param {CoverageGap[]} list
 * @returns {CoverageGap[]}
 */
function inGapOrder(list) {
  return [...list].sort((a, b) => {
    const left = `${a.what}\u0000${a.why}\u0000${a.unlockedBy ?? ''}`;
    const right = `${b.what}\u0000${b.why}\u0000${b.unlockedBy ?? ''}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
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
  const walks = inWalkOrder(input.walks).map((walk) => ({ walk, paths: new Set(walk.paths) }));

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
  // Named, never silently dropped. A route the code declares and the build answers 404 to is
  // not a covered route and it is not an absent one either — it is a disagreement between the
  // source and the thing that ran, and that is worth more than most differences.
  /** @type {Map<string, number>} */
  const shutDoors = new Map();
  for (const { walk } of walks) for (const d of walk.knockedShut ?? []) shutDoors.set(d.door, d.status);
  if (shutDoors.size > 0) {
    // Sorted, so which six get named is decided by their names and not by which capture the
    // disk happened to hand back first. See `inWalkOrder` for why that was ever in doubt.
    const listed = [...shutDoors.entries()].sort(byFirst).slice(0, 6).map(([door, code]) => `${door} answered ${code}`).join(', ');
    caveats.push(
      `${shutDoors.size} ${shutDoors.size === 1 ? 'door the code declares was' : 'doors the code declares were'} knocked on and answered as not being there (${listed}${shutDoors.size > 6 ? ', and more' : ''}). Knocking is not walking: nothing has been proved about ${shutDoors.size === 1 ? 'it' : 'them'}, and the source and the build that ran disagree about whether ${shutDoors.size === 1 ? 'it exists' : 'they exist'}.`,
    );
  }
  /** @type {Map<string, number>} */
  const bouncedDoors = new Map();
  for (const { walk } of walks) for (const d of walk.onlyRedirected ?? []) bouncedDoors.set(d.door, d.status);
  if (bouncedDoors.size > 0) {
    const all = bouncedDoors.size >= Math.max(1, opened);
    caveats.push(
      `${bouncedDoors.size} ${bouncedDoors.size === 1 ? 'door' : 'doors'} answered with a redirect rather than with ${bouncedDoors.size === 1 ? 'a page' : 'pages'} — ${[...bouncedDoors.entries()].sort(byFirst).slice(0, 5).map(([door, code]) => `${door} answered ${code}`).join(', ')}${bouncedDoors.size > 5 ? ', and more' : ''}. What was seen is the bounce, not what is behind it.${all ? ' EVERY door that answered did this, which is what a sign-in wall looks like from out here: this run has not been inside the product at all.' : ''}`,
    );
  }
  // A door whose journey was refused before anything ran. Nobody knocked on it, so it is not
  // shut and it is not bounced — it is untouched, and the only wrong answer is to leave it
  // out. This says the number out loud so nobody has to notice a door that quietly stopped
  // being counted as walked.
  /** @type {Set<string>} */
  const untriedDoors = new Set();
  for (const { walk } of walks) for (const door of walk.notTried ?? []) untriedDoors.add(door);
  if (untriedDoors.size > 0) {
    const listed = [...untriedDoors].sort().slice(0, 6).join(', ');
    caveats.push(
      `${untriedDoors.size} ${untriedDoors.size === 1 ? 'door was' : 'doors were'} never tried at all (${listed}${untriedDoors.size > 6 ? ', and more' : ''}). The journey that would have opened ${untriedDoors.size === 1 ? 'it' : 'them'} was refused before anything ran — the thing it needed did not start, or a value it needed was never supplied — and the reason is on the record beside it. ${untriedDoors.size === 1 ? 'It is' : 'They are'} counted here as never opened, because nothing knocked.`,
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
    // Both of these are printed by `--json`, and JSON keeps the order keys were added in.
    // Added in the order the walks arrived, they came out shuffled between two identical
    // runs — see `inWalkOrder`. Written out in an order of their own, they do not.
    byJourneySource: Object.fromEntries(Object.entries(byJourneySource).sort(byFirst)),
    byChannel: inChannelOrder(input.byChannel ?? {}),
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
    // These holes were collected build by build and capture by capture, in the order the
    // store listed them — which is the order the random end of a capture id put them in.
    // Nothing about one unreadable record makes it more urgent than another, so they go in
    // an order of their own and two identical runs list them the same way round.
    gaps: inGapOrder(dedupeGaps(holes)),
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

  // Whole families tie here routinely — ten folders of four unopened exports each score the
  // same and hold the same number of doors — and a tie used to be settled by whichever came
  // out of the map first. The family's own name settles it instead, so the list this file
  // hands back is the same list every time and the cut at the end falls in the same place.
  const ranked = jobs.sort(
    (a, b) => b.rank - a.rank || b.doors - a.doors || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0),
  );
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
