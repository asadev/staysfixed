/**
 * The Stays Fixed v2 tool set, as an agent sees it.
 *
 * Everything here is written for a reader who is not human: a coding agent that
 * has just changed a product and needs to know, in as few tokens as possible,
 * what moved that it did not mean to move. Three rules shape the whole file.
 *
 *   1. SAY ONLY WHAT IS NOT ACCOUNTED FOR. Unchanged paths never reach the
 *      agent's context. But the silence has to be legible, so every reply says
 *      what the run actually covered and what it could not. "Nothing changed"
 *      and "nothing ran" read identically otherwise, and one of those is a
 *      broken tool reporting success.
 *
 *   2. NOTHING HEAVY IS PUSHED. Every value, picture and piece of evidence is
 *      fetched on request through `staysfixed_explain`, never volunteered. Each
 *      reply ends by naming what was withheld and the exact call that fetches it.
 *
 *   3. THE AGENT CANNOT BLESS ITS OWN WORK. It can record that a difference was
 *      intended, and only through four gates it cannot argue with: five classes
 *      are sealed off entirely, the claim has to match an intent sealed BEFORE
 *      the run, five waivers between one ship and the next, and every waiver
 *      dies when the reference moves. There is no door here marked "approve".
 *
 * This file is the surface, the bookkeeping and the gates. The difference engine
 * proper lives in `src/v2/check.js` and `src/v2/doctor.js`; the engine is found
 * at run time rather than imported, so the server still starts, still lists its
 * tools and still answers `staysfixed_capabilities` when a piece of it is not
 * built yet. Capabilities is the call an agent makes to find out what is
 * missing, so it must never be the thing that is missing.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { isExpected, messageOf } from '../../core/errors.js';
import { gitInfo } from '../../core/git.js';
import { findConfigFile, rootForConfig } from '../../core/paths.js';
import { openStore } from '../store.js';

/**
 * What a check hands back, and one finding inside it.
 *
 * `CheckOutcome` is a Verdict plus `blocked`: "the check could not be completed" is
 * neither a pass nor a failure, and reporting it as either is the exact thing this
 * tool exists to stop. It is declared at the engine's front door in src/v2/check.js.
 *
 * Taken from src/v2/types.js, which is the contract every part of version 2 is built
 * against. This surface used to read them off the command line module, which does not
 * define them - so the two would have been free to drift, and the drift would have
 * shown up as an agent being told about a field that was never filled in.
 *
 * @typedef {import('../check.js').CheckOutcome} CheckResult
 * @typedef {import('../types.js').Finding} RawFinding
 */

/**
 * A finding with the two things the surface needs and the engine does not
 * provide: something to call it by, and something a waiver can be pinned to.
 *
 * @typedef {RawFinding & {id: string, fingerprint: string}} Finding
 */

/**
 * What every tool call is handed.
 *
 * @typedef {object} ToolContext
 * @property {string} root
 * @property {string} cwd
 * @property {string} version
 * @property {string} protocolVersion
 */

/** @typedef {{type: 'text', text: string}|{type: 'image', data: string, mimeType: string}} ContentItem */
/** @typedef {{content: ContentItem[], structuredContent?: Record<string, unknown>, isError?: boolean}} ToolResult */

// ---------------------------------------------------------------------------
// Constants that are policy, not preference
// ---------------------------------------------------------------------------

/**
 * The five classes an agent may never wave through. These are not merely
 * "important bugs" - they are the differences where being wrong costs money, an
 * account, data, or a person's afternoon, and where a plausible-sounding reason
 * from a model under pressure to finish is worth nothing at all.
 *
 * The keys are the strings the engine puts in `sealed`.
 */
const SEALED_CLASSES = {
  money: 'it touches money - a charge, a price, a refund, a balance',
  'sign-in': 'it touches signing in - credentials, sessions, permissions',
  'data-loss': 'it could lose data - a delete, a migration, an overwrite',
  crash: 'the product crashed, or stopped with an error it did not stop with before',
  guard: 'a named guard covers this - somebody already reported this bug once',
};

/**
 * Five waivers between one ship and the next. Past that it is not a change with
 * side effects, it is a rewrite, and a person looks at a rewrite. The number is
 * deliberately small enough to be annoying: an agent that needs a sixth is an
 * agent that has misunderstood its task.
 */
const WAIVER_BUDGET = 5;

/** How many findings ride in a default reply before the rest are counted instead. */
const DEFAULT_LIMIT = 10;

/** How many paths of one finding are listed before they are summarised. */
const MAX_PATHS = 8;

/** Pictures are channel seven and evidence only: this many, and only when asked. */
const MAX_IMAGES = 2;

// ---------------------------------------------------------------------------
// Finding the difference engine
// ---------------------------------------------------------------------------

/**
 * Where the engine's callable parts live, and what they are called.
 *
 * The surface and the engine are built in parallel, and a hard `import` of a
 * file that is not written yet takes the whole server down - including the one
 * call whose job is to explain that it is missing. So the specifier is built
 * from a variable: a literal would be resolved at type-check time and fail there
 * instead.
 *
 * If a name moves, one edit to this table wires it up again, and
 * `staysfixed_capabilities` prints exactly what was looked for and not found, so
 * nobody has to guess.
 */
const ENGINE_FILES = ['check.js', 'doctor.js'];

/**
 * Part name to the export names accepted for it, best first.
 *
 * `proveCause` in src/v2/cause.js is deliberately NOT listed. It takes an
 * engine-internal finding and a loaded project, neither of which this surface
 * has, and calling it with the wrong shapes would fail in a way that reads like
 * a bug in the product being checked. Refusing is the honest answer until a
 * facade with a plain argument object exists.
 */
const ENGINE_PARTS = {
  check: ['check'],
  prove: ['prove'],
  explain: ['explain'],
  capabilities: ['capabilities'],
  describe: ['describeCapabilities'],
};

/**
 * @typedef {object} Engine
 * @property {Record<string, (arg: any) => any>} parts
 * @property {string[]} loaded
 * @property {string[]} missing
 */

/** @type {Engine|null} */
let engineCache = null;

/**
 * Load whatever of the engine exists, once per process.
 *
 * Exported because `selfcheck.js` drives the same engine and must find it the
 * same way. If those two ever looked in different places, the corpus would be
 * proving something other than what an agent actually runs.
 *
 * @param {boolean} [refresh]  During the build the engine appears mid-session.
 * @returns {Promise<Engine>}
 */
export async function loadEngine(refresh = false) {
  if (engineCache && !refresh) return engineCache;

  /** @type {Record<string, any>} */
  const bag = {};
  /** @type {string[]} */
  const loaded = [];

  for (const rel of ENGINE_FILES) {
    const url = new URL(`../${rel}`, import.meta.url);
    if (!fs.existsSync(url)) continue;
    try {
      // Built from a variable, not a literal - see the note on ENGINE_FILES.
      const href = url.href;
      const mod = await import(href);
      for (const [key, value] of Object.entries(mod)) {
        if (!(key in bag)) bag[key] = value;
      }
      loaded.push(rel);
    } catch {
      // A module that throws while loading is that lane's problem, not a reason
      // for this server to die. It shows up as a missing part below.
    }
  }

  /** @type {Engine} */
  const engine = { parts: {}, loaded, missing: [] };
  for (const [part, names] of Object.entries(ENGINE_PARTS)) {
    const hit = names.find((n) => typeof bag[n] === 'function');
    if (hit) engine.parts[part] = bag[hit];
    else engine.missing.push(part);
  }

  engineCache = engine;
  return engine;
}

/**
 * What an agent gets when it asks for something only the engine can do and the
 * engine is not there. Written as instructions to whoever is integrating,
 * because that is the only person who will ever read it.
 *
 * @param {Engine} engine
 * @param {string} part
 * @param {string} needs   The exact signature the missing function must have.
 * @returns {ToolResult}
 */
function engineMissing(engine, part, needs) {
  const names = (/** @type {Record<string, string[]>} */ (ENGINE_PARTS)[part] ?? []).join(' or ');
  return problem(
    [
      `The difference engine cannot do "${part}" in this copy of Stays Fixed.`,
      '',
      `It looked for a function called ${names}, exported from ${ENGINE_FILES.map((f) => `src/v2/${f}`).join(' or ')}.`,
      engine.loaded.length ? `It loaded ${engine.loaded.map((f) => `src/v2/${f}`).join(' and ')}, and neither exports that.` : 'Neither of those files exists yet.',
      '',
      `It needs: ${needs}`,
      '',
      'Everything else still works. Call staysfixed_capabilities for what this copy can do.',
    ].join('\n')
  );
}

// ---------------------------------------------------------------------------
// Where this tool keeps its own bookkeeping
// ---------------------------------------------------------------------------

/**
 * Sealed intents, waivers and a small index of the last check.
 *
 * They sit beside the engine's own store but they are not part of it, and that
 * separation is the point: the engine decides what is different, this decides
 * what an agent is allowed to say about it, and an engine bug must not be able
 * to widen a gate.
 *
 * @param {string} root
 */
function stateDir(root) {
  return path.join(root, '.staysfixed', 'v2');
}

/**
 * The project root: the folder with the settings file in it, else the folder
 * with the repository or the package, else where we were started.
 *
 * @param {string} from
 * @returns {string}
 */
export function findRoot(from) {
  const config = findConfigFile(from);
  if (config) return rootForConfig(config);
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(from);
    dir = parent;
  }
}

/**
 * @param {string} file
 * @param {any} fallback
 * @returns {Promise<any>}
 */
async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    // Not there, or hand-edited into nonsense. Either way start clean rather
    // than refuse to run: losing a waiver is safe, refusing to check is not.
    return fallback;
  }
}

/**
 * @param {string} file
 * @param {unknown} value
 */
async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Which reference is in force, as one short string.
 *
 * Taken as a digest of the store's references file rather than of any one
 * product's pointer, so that ANY movement of ANY reference retires every
 * outstanding waiver. That errs towards waivers dying too often, which costs an
 * agent one extra call, rather than towards a waiver outliving the thing it was
 * written about, which costs somebody a regression.
 *
 * @param {string} root
 * @returns {string}
 */
function referenceStamp(root) {
  const store = openStore({ root });
  try {
    const raw = fs.readFileSync(store.referencesFile);
    return 'ref-' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  } catch {
    // Nothing has ever been shipped with the hook in place. That is the cold
    // start, it is expected on any existing product, and it is a real state
    // rather than an error - but a waiver written now must not survive the day
    // the first reference is cut, so it gets its own stamp.
    return 'no-reference-yet';
  }
}

/**
 * A sealed statement of what the agent meant to change, written before the run.
 *
 * @typedef {object} Intent
 * @property {string} id
 * @property {string} sealedAt        ISO. A waiver only counts against an intent sealed BEFORE the check.
 * @property {string} summary
 * @property {string[]} touches       Files, folders or named areas it expected to affect.
 * @property {string[]} expect        Differences it expects to see, in its own words.
 * @property {string|null} commit
 * @property {string} reference       The reference stamp in force when it was sealed.
 */

/**
 * @param {string} root
 * @returns {Promise<Intent|null>}
 */
async function readIntent(root) {
  const raw = await readJson(path.join(stateDir(root), 'intent.json'), null);
  return raw && typeof raw === 'object' && typeof raw.id === 'string' ? raw : null;
}

/**
 * A recorded "I meant to do that".
 *
 * @typedef {object} Waiver
 * @property {string} id
 * @property {string} fingerprint     Pins the exact difference. A different value is a different finding.
 * @property {string} summary
 * @property {string} because
 * @property {string} intentId
 * @property {string} at
 * @property {string} reference       The stamp it was written against. It dies when this moves.
 */

/**
 * @param {string} root
 * @returns {Promise<Waiver[]>}
 */
async function readWaivers(root) {
  const raw = await readJson(path.join(stateDir(root), 'waivers.json'), []);
  return Array.isArray(raw) ? raw : [];
}

/**
 * What the last check found, kept so that explain, prove and waive can be given
 * an id to work with, and so "there is no finding called that" is a real answer
 * rather than a shrug.
 *
 * @typedef {object} CheckIndex
 * @property {string} at
 * @property {string} reference
 * @property {string} verdict
 * @property {Finding[]} findings
 * @property {string[]} newlyUnstable
 * @property {CheckResult} result
 */

/**
 * @param {string} root
 * @returns {Promise<CheckIndex|null>}
 */
async function readLastCheck(root) {
  const raw = await readJson(path.join(stateDir(root), 'last-check.json'), null);
  return raw && typeof raw === 'object' && Array.isArray(raw.findings) ? raw : null;
}

/**
 * Something to call a finding by, stable while the finding itself persists, so
 * an agent can run a check twice and still explain the same one.
 * @param {RawFinding} f
 * @returns {string}
 */
function idOf(f) {
  return 'f-' + digest([f.title, ...(f.paths ?? [])]).slice(0, 6);
}

/**
 * What a waiver pins to. Change the values and the waiver stops applying, which
 * is the whole point: "I meant the total to read 9.99 instead of 10.00" must not
 * quietly go on covering the total the day it becomes 0.
 * @param {RawFinding} f
 * @returns {string}
 */
function fingerprintOf(f) {
  return digest([f.title, ...(f.paths ?? []), f.sample?.path ?? '', stringy(f.sample?.reference), stringy(f.sample?.candidate)]).slice(0, 16);
}

/**
 * @param {unknown[]} parts
 * @returns {string}
 */
function digest(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * The `tools/list` payload. Static, and it never touches disk: an agent listing
 * tools in a project that is not set up must still see
 * `staysfixed_capabilities`, which is the tool that explains why nothing else
 * will work yet.
 *
 * @returns {{name: string, description: string, inputSchema: Record<string, any>}[]}
 */
export function toolDefinitions() {
  return [
    {
      name: 'staysfixed_capabilities',
      description:
        'CALL THIS FIRST, once per session. What Stays Fixed can check on this machine right now, what it cannot and why, what is missing that would unlock more, which other machines it can already reach, and the exact shape of every reply you will get back. It runs nothing and changes nothing. After this call you should not need to read any documentation about this tool.',
      inputSchema: {
        type: 'object',
        properties: {
          detail: { type: 'string', enum: ['brief', 'full'], description: "'brief' is the short answer and the default. 'full' adds every surface, the machine, the result shapes and the wiring." },
          format: { type: 'string', enum: ['text', 'json'], description: "'json' gives the same answer as one machine-readable object and no prose." },
          offline: { type: 'boolean', description: 'Do not dial any other machine. Faster, and it will report no remote runners.' },
          refresh: { type: 'boolean', description: 'Look for the engine again. Only useful while Stays Fixed itself is being built.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'staysfixed_intent',
      description:
        'Seal what you MEANT to change, BEFORE you run a check. One plain sentence, the files or areas you expect to affect, and the differences you expect to see. This is what makes a later "that one was me" claim checkable instead of a story: you cannot waive a difference outside what you sealed, and you cannot seal an intent after seeing what broke. Call it once per change, right before or right after you edit.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'What you set out to change, in one plain sentence a non-technical person would understand.' },
          touches: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files, folders or named areas you expect this to affect, e.g. ["src/checkout/total.js", "the basket page"]. A difference outside this list cannot be waived.',
          },
          expect: { type: 'array', items: { type: 'string' }, description: 'Differences you expect this change to produce, in your own words. Optional, and it makes the check sharper.' },
        },
        required: ['summary', 'touches'],
        additionalProperties: false,
      },
    },
    {
      name: 'staysfixed_check',
      description:
        'Run it. Puts the build you just changed through the same steps as the build that was last shipped, twice, and reports only the differences that are left after the product\'s own wobble is subtracted. Covers what the screen says a control does, what calls go out, what files are written, what errors appear, what the program prints, and what the code exposes. You get back ONLY what you did not account for, ranked with the differences furthest from your edit at the top, because those are side effects. Everything unchanged is silent. Seal an intent first.',
      inputSchema: {
        type: 'object',
        properties: {
          only: { type: 'array', items: { type: 'string' }, description: 'Check only these journeys, by name. Leave it out to check everything.' },
          against: { type: 'string', description: 'Compare against this marker, tag or commit instead of the newest reference.' },
          paired: {
            type: 'boolean',
            description: 'Boot the old build live and walk it from the start instead of trusting the stored record. Slower and much stronger. Use it before a release, and on the first run of a product with no stored record.',
          },
          journeys: { type: 'string', description: "Where the steps come from: 'suite', 'code', 'recorded', or a path to a journeys file." },
          surface: {
            type: 'string',
            enum: ['auto', 'cli', 'server', 'web', 'electron'],
            description:
              "What kind of product to aim at. Default 'auto', which uses the settings. 'web' opens the page in a browser of the tool's own — never yours — and reads what the screen says each control is and does. 'electron' opens the desktop app with its own scratch data folder and drives it over its own debugging port.",
          },
          at: {
            type: 'string',
            description: "What to aim at: a URL for 'web' (http://localhost:3000), or the path to the built app for 'electron'. Leave it out to use whatever the settings name.",
          },
          limit: { type: 'number', description: `How many findings to return in full. Default ${DEFAULT_LIMIT}; the rest are counted and named.` },
          offset: { type: 'number', description: 'Skip this many findings. Pages through the last run without running anything again.' },
          format: { type: 'string', enum: ['text', 'json'], description: "'json' returns the whole result as machine-readable JSON and no prose." },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'staysfixed_explain',
      description:
        'One finding, in depth: every address that moved, both values in full, what class it is in, how far it sits from your edit, and the evidence. This is where the heavy material lives - it is never pushed into a check reply, so ask for it on the two or three findings you actually intend to act on.',
      inputSchema: {
        type: 'object',
        properties: {
          finding: { type: 'string', description: 'The finding id from staysfixed_check.' },
          include: {
            type: 'array',
            items: { type: 'string', enum: ['values', 'paths', 'evidence', 'pixels'] },
            description: "What to include. Default is values and paths. 'pixels' returns a picture and costs a lot of context - ask only when a picture would settle it.",
          },
        },
        required: ['finding'],
        additionalProperties: false,
      },
    },
    {
      name: 'staysfixed_prove',
      description:
        'Test a causal claim by undoing a change and running again. You believe your edit to a particular file caused a finding: this puts that file back to the reference, re-runs, and tells you whether the difference went away. If it survives the revert, your edit did not cause it and you were about to fix the wrong thing. Nothing is left reverted.',
      inputSchema: {
        type: 'object',
        properties: {
          finding: { type: 'string', description: 'The finding id you are trying to explain.' },
          revert: { type: 'array', items: { type: 'string' }, description: 'The files you think caused it. They are put back to the reference for one run.' },
        },
        required: ['finding', 'revert'],
        additionalProperties: false,
      },
    },
    {
      name: 'staysfixed_waive',
      description:
        'Record that a difference was intended. This is NOT approval and it makes nothing the new normal - only shipping does that. Four rules are enforced and cannot be argued with: differences touching money, signing in, losing data, a crash, or a named guard can never be waived; the difference has to fall inside what you sealed with staysfixed_intent before the run; five between one ship and the next; and every waiver dies the moment the reference moves. If a waiver is refused, that is the answer - fix the code instead.',
      inputSchema: {
        type: 'object',
        properties: {
          finding: { type: 'string', description: 'The finding id from staysfixed_check.' },
          because: { type: 'string', description: 'Why this difference is what you meant, in one plain sentence. A person reads this later.' },
        },
        required: ['finding', 'because'],
        additionalProperties: false,
      },
    },
    {
      name: 'staysfixed_coverage',
      description:
        'What was NOT checked. The ways in that no journey has ever opened, the surfaces this machine cannot reach at all, anything refused because doing it twice would not have been reversible, and the things this tool can never see on any machine. Read it before you tell anyone a change is safe: a clean check only covers what was walked, and this is the list of what was not.',
      inputSchema: {
        type: 'object',
        properties: { format: { type: 'string', enum: ['text', 'json'] } },
        additionalProperties: false,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/**
 * Run one tool.
 *
 * A tool that fails is a RESULT with `isError: true`, never a JSON-RPC error -
 * the agent is meant to read the failure and act on it, and a protocol-level
 * error is swallowed by its client before it ever sees the words.
 *
 * @param {string} name
 * @param {any} args
 * @param {ToolContext} ctx
 * @returns {Promise<ToolResult>}
 */
export async function callTool(name, args, ctx) {
  /** @type {Record<string, any>} */
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};

  try {
    switch (name) {
      case 'staysfixed_capabilities':
        return await toolCapabilities(ctx, input);
      case 'staysfixed_intent':
        return await toolIntent(ctx, input);
      case 'staysfixed_check':
        return await toolCheck(ctx, input);
      case 'staysfixed_explain':
        return await toolExplain(ctx, input);
      case 'staysfixed_prove':
        return await toolProve(ctx, input);
      case 'staysfixed_waive':
        return await toolWaive(ctx, input);
      case 'staysfixed_coverage':
        return await toolCoverage(ctx, input);
      default:
        return problem(`There is no Stays Fixed tool called "${name}". The tools are: ${toolDefinitions().map((t) => t.name).join(', ')}.`);
    }
  } catch (e) {
    return problem(explainError(e));
  }
}

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

/**
 * The self-describing call.
 *
 * The machine survey belongs to `doctor.js` and is quoted from there rather than
 * repeated here - an agent and a person being told different things about the
 * same machine is exactly the bug this tool exists to catch, and it would be a
 * poor joke to ship it in the tool itself. What this adds is the part doctor
 * does not know: the loop, the shape of the replies, and the rules on waiving.
 *
 * @param {ToolContext} ctx
 * @param {Record<string, any>} input
 * @returns {Promise<ToolResult>}
 */
async function toolCapabilities(ctx, input) {
  const engine = await loadEngine(input.refresh === true);
  const full = input.detail === 'full';

  /** @type {any} */
  let caps = null;
  /** @type {string|null} */
  let capsError = null;
  if (engine.parts.capabilities) {
    try {
      caps = await engine.parts.capabilities({ cwd: ctx.root, offline: input.offline === true });
    } catch (e) {
      capsError = messageOf(e);
    }
  }

  const waivers = await readWaivers(ctx.root);
  const stamp = referenceStamp(ctx.root);
  const spent = waivers.filter((w) => w.reference === stamp).length;

  if (input.format === 'json') {
    const payload = {
      tool: 'staysfixed',
      version: ctx.version,
      loop: LOOP_STEPS,
      resultShapes: RESULT_SHAPES,
      waiving: { budget: WAIVER_BUDGET, spent, sealedClasses: SEALED_CLASSES, expiresWhen: 'the reference moves - when a build is shipped' },
      engine: { loaded: engine.loaded, missing: engine.missing },
      machine: caps,
      machineError: capsError,
      // Pulled up out of `machine` on purpose. These two are the answers an agent
      // acts on — what a clean run would actually mean, and which browser gets
      // opened — and burying them inside the machine survey is how they get skipped.
      covers: caps?.covers ?? null,
      browsers: caps?.browsers ?? null,
      aiming: AIMING,
      selfCheck: 'staysfixed check --selfcheck',
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
  }

  /** @type {string[]} */
  const out = [];
  // No version number on this line: `describeCapabilities` opens with one, and
  // two version numbers on two lines is the sort of small contradiction that
  // makes a reader stop trusting everything under it.
  out.push('Stays Fixed proves that nothing which already worked has changed.');
  out.push('');

  if (caps && engine.parts.describe) {
    // Word for word what `staysfixed doctor` prints. Same words to the agent and
    // to the person, always.
    for (const line of engine.parts.describe(caps)) out.push(String(line));
  } else if (capsError) {
    out.push(`This copy could not survey the machine: ${capsError}`);
  } else {
    out.push('This copy cannot survey the machine - src/v2/doctor.js is not exporting capabilities(). Nothing below tells you what this machine can actually drive.');
  }

  if (engine.missing.length) {
    out.push('');
    out.push(`NOT BUILT IN THIS COPY: ${engine.missing.join(', ')}. Those calls refuse rather than pretend. Everything else works.`);
  }

  out.push('');
  out.push('AIMING A CHECK AT ONE KIND OF PRODUCT');
  for (const line of AIMING) out.push(`- ${line}`);

  if (caps?.browsers) {
    out.push('');
    out.push('WHAT IT DOES TO THIS MACHINE WHILE IT RUNS');
    out.push(`- ${caps.browsers.note}`);
    for (const promise of caps.browsers.neverTouches ?? []) out.push(`- ${promise}`);
    out.push(`- ${caps.browsers.leftovers}`);
  }

  out.push('');
  out.push('THE LOOP');
  for (const step of LOOP_STEPS) out.push(`- ${step}`);

  out.push('');
  out.push('WHAT YOU MAY DECIDE, AND WHAT YOU MAY NOT');
  out.push(`- You cannot write a reference. Only shipping does that, and only a person ships.`);
  out.push(`- You can record that a difference was intended: ${WAIVER_BUDGET} between one ship and the next, ${spent} already spent, and every one of them dies when the reference moves.`);
  out.push('- These can never be waived by you, whatever the reason:');
  for (const [name, why] of Object.entries(SEALED_CLASSES)) out.push(`    ${name} - ${why}`);

  if (full) {
    out.push('');
    out.push('WHAT COMES BACK');
    for (const line of RESULT_SHAPES) out.push(`- ${line}`);
    if (caps?.wiring?.mcp) {
      out.push('');
      out.push('HOW THIS IS WIRED UP (paste this into an editor that does not have it yet)');
      out.push(JSON.stringify(caps.wiring.mcp, null, 2));
    }
    out.push('');
    out.push('PROVING THE TOOL ITSELF STILL WORKS');
    out.push('- `staysfixed check --selfcheck` builds a set of deliberately broken products and fails loudly if any of them get past the engine. A tool reporting "nothing changed" looks exactly like a tool that is broken; that is what tells the two apart. Run it before you trust a clean result from a copy you have not used before.');
  } else {
    out.push('');
    out.push('Ask again with { "detail": "full" } for the result shapes, the block that wires this into an editor, and how to prove the tool itself still catches things.');
  }

  return { content: [{ type: 'text', text: out.join('\n') }] };
}

/**
 * How to point a check at one kind of product. Said once, here, because it is the
 * part of the surface that changed when web and desktop apps arrived and an agent
 * that has to guess at it will guess wrong.
 */
const AIMING = [
  "staysfixed_check { surface: 'web', at: 'http://localhost:3000' } — opens the page in a browser of the tool's own, never yours, and reads what the screen says each control is and does. Start your dev server yourself first; the tool will not guess at a command that might build over what you have running.",
  "staysfixed_check { surface: 'electron', at: '/path/to/YourApp.app' } — opens the built desktop app with its own scratch data folder and its own debugging port, so it can never fight your own copy of it over a lock, a data folder or a relay slot.",
  "staysfixed_check { surface: 'cli' } or { surface: 'server' } — the same engine on a command-line tool or an HTTP server.",
  'Leave both out and it uses the settings. If you aim it and the result does not confirm it went there, the reply says so at the top and nothing below it is about what you asked for.',
  'Both builds are opened one after the other, never at once. Two copies of one app fight over ports, single-instance locks and data folders, and a tool that caused that would be causing the bug it exists to catch.',
];

/** The loop, said once, in the one place an agent reads it. */
const LOOP_STEPS = [
  'staysfixed_intent - seal what you meant to change, before you run anything.',
  'staysfixed_check - run it. You get back only what you did not account for.',
  'staysfixed_explain - the two or three findings you intend to act on, in depth.',
  'staysfixed_prove - undo the change you suspect and re-run, to test whether it really caused a finding.',
  'staysfixed_waive - record that a difference was intended. Four rules apply and a refusal is final.',
  'Fix what you caused, then call staysfixed_check again. Repeat until nothing unaccounted-for comes back.',
];

/** What every reply looks like, so an agent can act on one without being taught. */
const RESULT_SHAPES = [
  'staysfixed_check: a headline, then a ranked list. Each finding has an id, one plain sentence, the addresses that moved, and a sample of one value before and after. Furthest from your edit sorts to the top, because that is what a side effect looks like.',
  'An address reads channel first: results, effects, complaints, meaning, contract, counters, pixels. That first word tells you what kind of thing moved.',
  'A finding marked SEALED touches money, signing in, losing data, a crash, or a named guard. You cannot waive it. Fix it, or tell a person.',
  '"Newly unpredictable" is reported separately from the findings: those are addresses that were the same every run before your change and disagree with themselves now. Nothing looks broken, which is exactly why that class of bug survives for months. A run with any of these is not a pass.',
  'A run in stored-record mode says so in those words. It is genuinely weaker than a paired run and the reply never hides it.',
  'staysfixed_explain: one finding with every address and both values in full. Pass include: ["pixels"] only when a picture would settle it.',
  'staysfixed_prove: a verdict - the difference went away when you reverted, or it survived and your edit did not cause it.',
  'staysfixed_coverage: ways in never opened, surfaces out of reach, anything refused for being irreversible. A refusal is missing coverage, never a pass.',
];

// ---------------------------------------------------------------------------
// intent
// ---------------------------------------------------------------------------

/**
 * @param {ToolContext} ctx
 * @param {Record<string, any>} input
 * @returns {Promise<ToolResult>}
 */
async function toolIntent(ctx, input) {
  const summary = text(input.summary);
  const touches = stringList(input.touches) ?? [];
  const expect = stringList(input.expect) ?? [];

  if (!summary) return problem('Say what you meant to change, in one plain sentence: { "summary": "...", "touches": ["..."] }.');
  if (touches.length === 0) {
    return problem(
      'Name at least one file, folder or area you expect this change to affect. That is the whole point of sealing an intent: a difference outside what you named cannot later be waived, so an empty list would leave you able to waive nothing at all.'
    );
  }

  const git = await gitInfo(ctx.root).catch(() => null);
  const stamp = referenceStamp(ctx.root);

  /** @type {Intent} */
  const intent = {
    id: 'intent-' + crypto.randomBytes(5).toString('hex'),
    sealedAt: new Date().toISOString(),
    summary,
    touches,
    expect,
    commit: git?.shortSha ?? null,
    reference: stamp,
  };
  await writeJson(path.join(stateDir(ctx.root), 'intent.json'), intent);

  // Sealing a new intent does NOT hand out a fresh five. The budget is counted
  // against the reference, precisely so an agent that has spent its waivers
  // cannot buy five more by re-declaring what it meant to do. Between one ship
  // and the next, all of it is one change.
  const waivers = await readWaivers(ctx.root);
  const spent = waivers.filter((w) => w.reference === stamp).length;

  return {
    content: [
      {
        type: 'text',
        text: [
          `Sealed as ${intent.id} at ${intent.sealedAt}${intent.commit ? `, commit ${intent.commit}` : ''}.`,
          `You said: ${summary}`,
          `Expecting to affect: ${touches.join(', ')}.`,
          expect.length ? `Expecting to see: ${expect.join('; ')}.` : '',
          '',
          `You may waive at most ${WAIVER_BUDGET} differences before a person has to look, and ${spent} of those are already spent since the last time a build shipped. Sealing another intent does not give you more, and you can only waive a difference that falls inside what you just named.`,
          'Now run staysfixed_check.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

/**
 * @param {ToolContext} ctx
 * @param {Record<string, any>} input
 * @returns {Promise<ToolResult>}
 */
async function toolCheck(ctx, input) {
  const engine = await loadEngine();
  const run = engine.parts.check;
  if (!run) {
    return engineMissing(engine, 'check', 'check({cwd, configFile, against, paired, journeys, only}) returning a CheckResult - the shape at the top of src/v2/cli.js.');
  }

  const limit = positive(input.limit) ?? DEFAULT_LIMIT;
  const offset = positive(input.offset) ?? 0;

  const surface = text(input.surface);
  const at = text(input.at);
  const aimed = (surface !== null && surface !== 'auto') || at !== null;

  /** @type {CheckResult} */
  const result = await run({
    cwd: ctx.root,
    configFile: undefined,
    against: text(input.against) ?? undefined,
    paired: input.paired === true,
    journeys: text(input.journeys) ?? undefined,
    only: stringList(input.only) ?? [],
    surface: surface && surface !== 'auto' ? surface : undefined,
    at: at ?? undefined,
  });

  // A run that was AIMED at something has to confirm it went there. An engine
  // that quietly ignores an unknown option would hand back a perfectly clean
  // result about something else entirely, and the agent would read it as proof
  // about the thing it named. So the confirmation is required, not assumed.
  const missedTheTarget = aimed ? aimingNote(surface, at, /** @type {any} */ (result).target) : null;

  const stamp = referenceStamp(ctx.root);
  const waivers = await readWaivers(ctx.root);
  const live = waivers.filter((w) => w.reference === stamp);
  const expired = waivers.length - live.length;

  /** @type {Finding[]} */
  const all = (Array.isArray(result?.findings) ? result.findings : []).map((/** @type {RawFinding} */ f) => ({ ...f, id: idOf(f), fingerprint: fingerprintOf(f) }));

  // Everything already accounted for is dropped here rather than in the engine.
  // The engine's job is to find differences; deciding which ones an agent may
  // stop looking at is a separate job with its own rules. Counting them out loud
  // is part of the deal - a silently applied waiver is how a rubber stamp starts.
  const waived = all.filter((f) => !sealedOf(f) && live.some((w) => w.fingerprint === f.fingerprint));
  const unaccounted = all.filter((f) => !waived.includes(f));

  // The engine reports a newly unpredictable address as a whole wobble entry. The
  // agent only needs the address, so that is all that is carried forward - the values
  // behind it are fetched with staysfixed_explain like everything else heavy.
  const newlyUnstable = (Array.isArray(result?.newlyUnstable) ? result.newlyUnstable : []).map((e) =>
    typeof e === 'string' ? e : e.path
  );

  await writeJson(path.join(stateDir(ctx.root), 'last-check.json'), {
    at: new Date().toISOString(),
    reference: stamp,
    verdict: result?.blocked ? 'blocked' : result?.ok ? 'nothing unaccounted for' : 'differences found',
    findings: all,
    newlyUnstable,
    result,
  });

  const page = unaccounted.slice(offset, offset + limit);
  const clean = unaccounted.length === 0 && newlyUnstable.length === 0 && result?.blocked !== true;

  if (input.format === 'json') {
    const payload = {
      ok: clean,
      verdict: result?.blocked ? 'blocked' : result?.ok ? 'nothing unaccounted for' : 'differences found',
      mode: result?.mode ?? null,
      note: result?.summary ?? null,
      noiseRemoved: result?.differencesNoise ?? null,
      newlyUnstable,
      coverage: result?.coverage ?? null,
      unaccounted: unaccounted.length,
      accountedFor: { waived: waived.length, expiredWaivers: expired },
      findings: page,
      aimedAt: aimed ? { surface: surface ?? 'auto', at: at ?? null, confirmed: missedTheTarget === null } : null,
      aimingWarning: missedTheTarget,
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: !clean };
  }

  const intent = await readIntent(ctx.root);
  const body = renderCheck({ result, unaccounted, page, offset, limit, waived: waived.length, expired, newlyUnstable, intent, clean, missedTheTarget });

  // A difference is reported as an error result on purpose. Protocol-wise the
  // call succeeded, but `isError` is the flag every client puts in front of the
  // agent, and an agent that skims past a real regression is exactly the failure
  // this whole tool exists to prevent.
  return { content: [{ type: 'text', text: body }], isError: !clean };
}

/**
 * @param {object} a
 * @param {CheckResult} a.result
 * @param {Finding[]} a.unaccounted
 * @param {Finding[]} a.page
 * @param {number} a.offset
 * @param {number} a.limit
 * @param {number} a.waived
 * @param {number} a.expired
 * @param {string[]} a.newlyUnstable
 * @param {Intent|null} a.intent
 * @param {boolean} a.clean
 * @param {string|null} a.missedTheTarget
 * @returns {string}
 */
function renderCheck({ result, unaccounted, page, offset, limit, waived, expired, newlyUnstable, intent, clean, missedTheTarget }) {
  /** @type {string[]} */
  const out = [];

  if (result?.blocked === true) {
    out.push('BLOCKED - the check could not be completed, so this is not a pass and not a failure. It is no answer at all.');
    if (result.summary) out.push(result.summary);
    out.push('Fix what is in the way and run it again. staysfixed_capabilities says what this machine can and cannot do.');
    return out.join('\n');
  }

  if (clean) {
    out.push('NOTHING UNACCOUNTED FOR. Everything that worked before still works, as far as this run could see.');
  } else if (unaccounted.length) {
    const sealed = unaccounted.filter(sealedOf).length;
    out.push(`${unaccounted.length} ${unaccounted.length === 1 ? 'DIFFERENCE' : 'DIFFERENCES'} YOU DID NOT ACCOUNT FOR${sealed ? `, ${sealed} of them sealed and not yours to waive` : ''}.`);
  } else {
    out.push('NOTHING CHANGED, BUT THIS IS NOT A CLEAN RUN - see the newly unpredictable addresses below.');
  }

  // The silence has to be legible. "Nothing changed" and "nothing ran" read the
  // same otherwise, and one of those is a broken tool reporting success.
  /** @type {string[]} */
  const arithmetic = [];
  if (result?.coverage) arithmetic.push(`${result.coverage.journeys} ${result.coverage.journeys === 1 ? 'way in was' : 'ways in were'} walked`);
  if (typeof result?.differencesNoise === 'number' && result.differencesNoise > 0) arithmetic.push(`${result.differencesNoise} differences subtracted as this product's own wobble`);
  if (waived) arithmetic.push(`${waived} waived earlier`);
  if (arithmetic.length) out.push(arithmetic.join(', ') + '.');
  if (!result?.coverage) {
    out.push('This run did not report what it covered, so how thorough it was is unknown. Treat a clean result with suspicion until it does, and call staysfixed_coverage.');
  }

  if (missedTheTarget) out.push(missedTheTarget);

  if (result?.mode === 'stored-record') {
    out.push(
      'Compared against the STORED RECORD, not against the old build booted live. That is genuinely weaker: it lets back in every difference that comes from the machine and the day rather than from your change. Pass paired: true for the strong comparison.'
    );
  }
  if (result?.summary) out.push(result.summary);

  if (newlyUnstable.length) {
    out.push('');
    out.push(`NEWLY UNPREDICTABLE - ${newlyUnstable.length} ${newlyUnstable.length === 1 ? 'address was' : 'addresses were'} the same every run before your change and disagree with themselves now:`);
    for (const p of newlyUnstable.slice(0, MAX_PATHS)) out.push(`- ${p}`);
    if (newlyUnstable.length > MAX_PATHS) out.push(`- and ${newlyUnstable.length - MAX_PATHS} more.`);
    out.push('Nothing here looks broken, which is exactly why this kind of bug survives for months. It cannot be waived: it is not a difference, it is a loss of determinism.');
  }

  if (page.length) {
    out.push('');
    out.push(offset > 0 ? `Findings ${offset + 1} to ${offset + page.length}:` : 'Worst first - furthest from your edit is at the top, because that is what a side effect looks like:');
    for (const f of page) out.push(...renderFinding(f));
  }

  const shown = offset + page.length;
  if (shown < unaccounted.length) {
    out.push('');
    out.push(`${unaccounted.length - shown} more not shown. Ask with staysfixed_check { "offset": ${shown}, "limit": ${limit} } - it pages through the last run and does not run anything again.`);
  }

  if (expired > 0) {
    out.push('');
    out.push(`${expired} ${expired === 1 ? 'waiver has' : 'waivers have'} expired because the reference moved. They cover nothing any more.`);
  }

  if (unaccounted.length) {
    out.push('');
    out.push('Everything above is trimmed hard. staysfixed_explain gives you one finding in full; staysfixed_prove tells you whether your edit really caused it. Ask for those on the two or three you intend to act on, not on all of them.');
    if (!intent) out.push('You have not sealed an intent for this change, so nothing here can be waived. Call staysfixed_intent before the next run.');
  }

  return out.join('\n');
}

/**
 * Did the run go where it was aimed?
 *
 * An engine that does not understand `surface` or `at` will not fail — it will
 * ignore them and check whatever it was going to check anyway, and hand back a
 * clean result. That result is true, and it is about the wrong thing, and it is
 * the most dangerous shape a reply can have. So a run that was aimed must come
 * back saying where it went, and when it does not, the reply says so before it
 * says anything else.
 *
 * Exported only so a test can hold the exact refusal wording to account. It is
 * the sentence that stands between an agent and a clean result about the wrong
 * product, and a sentence that important should not be provable only by running
 * a whole check.
 *
 * @param {string|null} surface
 * @param {string|null} at
 * @param {unknown} confirmation   `target` off the result: what the engine says it aimed at.
 * @returns {string|null} the warning, or null when the run went where it was told
 */
export function aimingNote(surface, at, confirmation) {
  const said = /** @type {{surface?: string, at?: string}} */ (confirmation && typeof confirmation === 'object' ? confirmation : {});
  const wanted = surface && surface !== 'auto' ? surface : null;
  const okSurface = !wanted || said.surface === wanted;
  const okAt = !at || said.at === at;
  if (okSurface && okAt) return null;

  const asked = [wanted ? `the ${wanted} target` : null, at ? `"${at}"` : null].filter(Boolean).join(' at ');
  return (
    `THIS RUN DID NOT CONFIRM IT WENT WHERE YOU AIMED IT. You asked for ${asked}, and the result does not say it went there` +
    `${said.surface || said.at ? ` — it says it checked ${said.surface ?? 'something else'}${said.at ? ` at "${said.at}"` : ''}` : ' — it says nothing about a target at all'}. ` +
    'Treat everything below as saying NOTHING about what you aimed at. Call staysfixed_capabilities to see whether that kind of product can be checked on this machine at all.'
  );
}

/**
 * One finding, in as few lines as carry the meaning.
 * @param {Finding} f
 * @returns {string[]}
 */
function renderFinding(f) {
  /** @type {string[]} */
  const out = [];
  const flags = [];
  const sealed = sealedOf(f);
  if (sealed) flags.push(`SEALED: ${sealed}`);
  if (typeof f.count === 'number' && f.count > 1) flags.push(`${f.count} addresses`);
  out.push(`- [${f.id}] ${trim(f.title, 200)}${flags.length ? `  (${flags.join(', ')})` : ''}`);

  // Only list the addresses when they add something. A single address the
  // sentence already names is a line of pure repetition, and the agent pays for
  // every one of those.
  const paths = f.paths ?? [];
  const worthListing = paths.filter((p) => !f.title.includes(p));
  if (worthListing.length) out.push(`    ${worthListing.slice(0, 3).join(', ')}${worthListing.length > 3 ? `, and ${worthListing.length - 3} more` : ''}`);
  if (f.sample) out.push(`    ${f.sample.path}: was ${valueOf(f.sample.reference)}, now ${valueOf(f.sample.candidate)}`);
  if (sealed) out.push(`    You cannot waive this: ${SEALED_CLASSES[/** @type {'money'} */ (sealed)] ?? 'a person has to look at it'}. Fix it, or tell a person.`);
  return out;
}

// ---------------------------------------------------------------------------
// explain
// ---------------------------------------------------------------------------

/**
 * @param {ToolContext} ctx
 * @param {Record<string, any>} input
 * @returns {Promise<ToolResult>}
 */
async function toolExplain(ctx, input) {
  const id = text(input.finding);
  if (!id) return problem('Say which finding to explain, e.g. { "finding": "f-a1b2c3" }. The ids come from staysfixed_check.');

  const last = await readLastCheck(ctx.root);
  if (!last) return problem('No check has run in this copy yet, so there is nothing to explain. Run staysfixed_check first.');
  const f = last.findings.find((x) => x.id === id);
  if (!f) {
    const ids = last.findings.slice(0, 12).map((x) => x.id);
    return problem(`The last check has no finding called "${id}".${ids.length ? ` It found: ${ids.join(', ')}.` : ' It found nothing at all.'}`);
  }

  const include = stringList(input.include) ?? ['values', 'paths'];
  const engine = await loadEngine();

  /** @type {any} */
  let deep = null;
  if (engine.parts.explain) {
    try {
      deep = await engine.parts.explain({ cwd: ctx.root, finding: id, include });
    } catch (e) {
      deep = { error: messageOf(e) };
    }
  }

  /** @type {string[]} */
  const out = [];
  const sealed = sealedOf(f);
  out.push(f.title + (sealed ? `  (SEALED: ${sealed} - not yours to waive)` : ''));
  if (typeof f.distance === 'number') {
    out.push(f.distance === 0 ? 'This sits inside the code you changed.' : `This sits ${f.distance} away from the code you changed, which is why it is ranked where it is. The further away, the more it looks like a side effect.`);
  }

  const paths = f.paths ?? [];
  if (include.includes('paths') && paths.length) {
    out.push('');
    out.push(`EVERY ADDRESS THAT MOVED (${paths.length})`);
    for (const p of paths.slice(0, 60)) out.push(`  ${p}`);
    if (paths.length > 60) out.push(`  and ${paths.length - 60} more.`);
  }

  if (include.includes('values')) {
    out.push('');
    if (f.sample) {
      out.push(`BEFORE - ${f.sample.path}`);
      out.push(indent(stringy(f.sample.reference)));
      out.push(`AFTER - ${f.sample.path}`);
      out.push(indent(stringy(f.sample.candidate)));
      if (paths.length > 1) out.push(`That is one of ${paths.length} addresses in this finding. The engine keeps one sample per finding rather than every value, which is what stops a broken stylesheet costing you a whole context window.`);
    } else {
      out.push('The engine kept no sample value for this finding, so there is nothing to show side by side.');
    }
  }

  /** @type {ContentItem[]} */
  const content = [];

  if (include.includes('evidence')) {
    out.push('');
    if (f.evidence) {
      out.push(`EVIDENCE: ${f.evidence}`);
      const body = await readText(path.resolve(ctx.root, f.evidence));
      if (body !== null) out.push(indent(trimLines(body, 40)));
    } else {
      out.push('No evidence file was kept for this finding.');
    }
  } else if (f.evidence) {
    out.push('');
    out.push('Evidence was kept and not sent. Ask with include: ["evidence"].');
  }

  if (deep?.error) {
    out.push('');
    out.push(`The engine could not go deeper on this one: ${deep.error}`);
  } else if (deep && typeof deep.text === 'string') {
    out.push('');
    out.push(deep.text);
  }

  content.push({ type: 'text', text: out.join('\n') });

  // Pixels are channel seven and expensive. They ride along only when asked for
  // by name, never because a finding happened to have a picture attached.
  const pictures = picturesFrom(f, deep);
  if (include.includes('pixels')) {
    for (const p of pictures.slice(0, MAX_IMAGES)) {
      const png = await readMaybe(path.resolve(ctx.root, p));
      if (!png) continue;
      content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
    }
  } else if (pictures.length) {
    content.push({ type: 'text', text: `${pictures.length} picture(s) were kept as evidence and not sent. Ask with include: ["pixels"] if a picture would settle it.` });
  }

  return { content };
}

/**
 * @param {Finding} f
 * @param {any} deep
 * @returns {string[]}
 */
function picturesFrom(f, deep) {
  /** @type {string[]} */
  const out = [];
  if (typeof f.evidence === 'string' && /\.png$/i.test(f.evidence)) out.push(f.evidence);
  if (Array.isArray(deep?.pictures)) for (const p of deep.pictures) if (typeof p === 'string') out.push(p);
  return out;
}

// ---------------------------------------------------------------------------
// prove
// ---------------------------------------------------------------------------

/**
 * @param {ToolContext} ctx
 * @param {Record<string, any>} input
 * @returns {Promise<ToolResult>}
 */
async function toolProve(ctx, input) {
  const engine = await loadEngine();
  const run = engine.parts.prove;
  if (!run) {
    return engineMissing(
      engine,
      'prove',
      'prove({cwd, configFile, finding, revert}) returning {gone: boolean, detail?: string}. src/v2/cause.js already has proveCause(), but it takes an engine-internal finding and a loaded project, which this surface does not have - a small facade in src/v2/check.js is all that is needed.'
    );
  }

  const id = text(input.finding);
  const revert = stringList(input.revert);
  if (!id) return problem('Say which finding you are trying to explain, e.g. { "finding": "f-a1b2c3", "revert": ["src/total.js"] }.');
  if (!revert) return problem('Name what to put back to the reference for one run, e.g. { "revert": ["src/checkout/total.js"] }. Without that there is no claim to test.');

  const last = await readLastCheck(ctx.root);
  const f = last?.findings.find((x) => x.id === id);
  if (!f) return problem(`The last check has no finding called "${id}". Run staysfixed_check first, then prove one of the ids it gives you.`);

  /** @type {any} */
  const result = (await run({ cwd: ctx.root, finding: id, revert })) ?? {};
  const gone = result.gone === true;

  /** @type {string[]} */
  const out = [];
  if (gone) {
    out.push(`PROVEN: your change caused it. With ${revert.join(', ')} put back, this matched the reference again.`);
    out.push(`  ${trim(f.title, 200)}`);
    out.push('So it is yours to fix - or to record as intended, if that is genuinely what you meant and it is not sealed.');
  } else {
    out.push(`NOT PROVEN: it survived the revert. With ${revert.join(', ')} put back, this was still different.`);
    out.push(`  ${trim(f.title, 200)}`);
    out.push('Your edit did not cause this, so fixing that file will not help. Something else did, or it was already broken before you started.');
  }
  if (result.detail) out.push('', trim(String(result.detail), 600));
  out.push('', 'The working tree has been put back exactly as it was.');

  return { content: [{ type: 'text', text: out.join('\n') }] };
}

// ---------------------------------------------------------------------------
// waive - the four gates
// ---------------------------------------------------------------------------

/**
 * The only door an agent has, and it is a narrow one.
 *
 * A refusal here is the tool working, not the tool being difficult. The failure
 * it guards against is specific: an agent under pressure to finish declares the
 * real regression intended, and the reason it writes reads perfectly plausible.
 * Every gate below exists to make that particular sentence impossible to write
 * rather than merely discouraged.
 *
 * @param {ToolContext} ctx
 * @param {Record<string, any>} input
 * @returns {Promise<ToolResult>}
 */
async function toolWaive(ctx, input) {
  const id = text(input.finding);
  const because = text(input.because);
  if (!id) return problem('Say which finding, e.g. { "finding": "f-a1b2c3", "because": "..." }.');
  if (!because) return problem('Say why this difference is what you meant, in one plain sentence. A waiver with no reason is worth nothing to whoever reads it later.');

  const last = await readLastCheck(ctx.root);
  if (!last) return problem('No check has run in this copy yet, so there is no difference to waive. Run staysfixed_check first.');
  const f = last.findings.find((x) => x.id === id);
  if (!f) return problem(`The last check has no finding called "${id}". You can only waive something this tool actually reported.`);

  // GATE (a) - the sealed classes. Nothing gets through this, ever.
  const sealed = sealedOf(f);
  if (sealed) {
    return problem(
      [
        `Refused. This one is sealed: ${SEALED_CLASSES[/** @type {'money'} */ (sealed)] ?? 'a person has to look at it'}.`,
        `  ${trim(f.title, 200)}`,
        '',
        'No agent can wave this through, whatever the reason, and asking again with different wording will get the same answer. Either fix it, or report it to a person in your closing summary and say plainly what changed.',
      ].join('\n')
    );
  }

  const intent = await readIntent(ctx.root);

  // GATE (b), first half - there has to be an intent, and it has to predate the run.
  if (!intent) {
    return problem(
      'Refused. You did not seal an intent before this run, so there is nothing to check your claim against. Seal one with staysfixed_intent, run the check again, and waive from that. Sealing an intent now, after seeing what broke, would prove nothing.'
    );
  }
  if (Date.parse(intent.sealedAt) > Date.parse(last.at)) {
    return problem(
      `Refused. That intent (${intent.id}) was sealed AFTER the check ran. An intent only means something when it is written before you see what broke. Run staysfixed_check again so the claim is tested against an intent that predates it.`
    );
  }

  // GATE (b), second half - it has to fall inside what was sealed. This is the
  // substance of the gate: a claim about something the agent never said it was
  // touching is not a claim about a side effect, it is a rationalisation.
  if (!withinIntent(f, intent)) {
    return problem(
      [
        'Refused. This is outside what you sealed.',
        `  ${trim(f.title, 200)}`,
        '',
        `You said you were changing: ${intent.summary}`,
        `You said it would affect: ${intent.touches.join(', ')}.`,
        'This is somewhere else, which is the definition of a side effect - the exact thing you are not allowed to wave through.',
        '',
        'If you genuinely meant to change this too, that is a different change: seal a new intent that names it, run the check again, and waive from there.',
      ].join('\n')
    );
  }

  const waivers = await readWaivers(ctx.root);
  const stamp = referenceStamp(ctx.root);

  if (waivers.some((w) => w.fingerprint === f.fingerprint && w.reference === stamp)) {
    return { content: [{ type: 'text', text: `Already waived - this is recorded as intended and it did not cost you another slot.\n  ${trim(f.title, 200)}` }] };
  }

  // GATE (c) - five per change, counted against the REFERENCE rather than the
  // intent, so an agent that has spent its five cannot buy five more by sealing
  // a fresh intent and calling the same work a different change.
  const spent = waivers.filter((w) => w.reference === stamp).length;
  if (spent >= WAIVER_BUDGET) {
    return problem(
      [
        `Refused. That would be your ${ordinal(spent + 1)} waiver since the last build shipped, and the limit is ${WAIVER_BUDGET}.`,
        '',
        'Past five, this is not a change with side effects - it is a rewrite, and a person looks at a rewrite. Sealing another intent will not give you more. Stop waiving, fix what you can, and report the rest plainly.',
      ].join('\n')
    );
  }

  /** @type {Waiver} */
  const waiver = {
    id: 'waiver-' + crypto.randomBytes(5).toString('hex'),
    fingerprint: f.fingerprint,
    summary: f.title,
    because,
    intentId: intent.id,
    at: new Date().toISOString(),
    // GATE (d) - fingerprinted to the exact difference and pinned to this
    // reference. When the reference moves, every waiver written against the old
    // one stops applying. Waivers are provisional; only shipping makes anything
    // the new normal.
    reference: stamp,
  };
  waivers.push(waiver);
  await writeJson(path.join(stateDir(ctx.root), 'waivers.json'), waivers);

  const left = WAIVER_BUDGET - (spent + 1);
  return {
    content: [
      {
        type: 'text',
        text: [
          `Recorded as intended: ${trim(f.title, 200)}`,
          `Reason kept: ${because}`,
          '',
          `${left} of your ${WAIVER_BUDGET} waivers left before the next ship. This one is pinned to the exact values that differ and to the reference in force now - if either moves, it stops covering anything.`,
          'This is not approval. Nothing becomes the new normal until a build is shipped. Say in what you report back that you waived this, and why.',
        ].join('\n'),
      },
    ],
  };
}

/**
 * Does this finding fall inside what the agent said it was touching?
 *
 * Deliberately generous about wording and strict about scope. An agent that
 * named `src/checkout/` covers everything whose address or sentence mentions the
 * checkout; an agent that named "the basket page" covers a finding about the
 * basket page. What it does not cover is a finding that shares no words with
 * anything it named at all - and that case is precisely a side effect.
 *
 * @param {Finding} f
 * @param {Intent} intent
 * @returns {boolean}
 */
function withinIntent(f, intent) {
  // A finding the engine placed at distance zero is INSIDE the code that was
  // edited, and the intent named the code that was edited. There is nothing left
  // to test: this is the waivable case by definition, and refusing it would make
  // the gate refuse the one thing it exists to allow. The gate's whole job is to
  // stop a difference FAR from the edit being waved through as intended.
  if (f.distance === 0) return true;

  // `nearFiles` is not in the finding shape the CLI publishes yet, but the
  // engine's own findings carry it and it is by far the strongest signal for
  // this test. Read it if it is there rather than waiting for the shape to catch
  // up: the gate gets sharper the day it appears, and nothing breaks until then.
  const carried = /** @type {any} */ (f).nearFiles;
  const near = Array.isArray(carried) ? carried.filter((/** @type {unknown} */ x) => typeof x === 'string') : [];
  const haystacks = [f.title, ...(f.paths ?? []), ...near, f.sample?.path ?? ''].map((s) => String(s).toLowerCase());
  for (const raw of intent.touches) {
    const needle = String(raw).toLowerCase().trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (!needle) continue;
    if (haystacks.some((h) => h.includes(needle))) return true;
    // A file path was named: match on the parts that carry meaning, so
    // "src/checkout/total.js" also covers an address reported as "cli.checkout.total".
    const words = needle.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !GENERIC_WORDS.has(w));
    if (words.length && words.every((w) => haystacks.some((h) => h.includes(w)))) return true;
  }
  return false;
}

/** Words that appear in every path and therefore prove nothing about scope. */
const GENERIC_WORDS = new Set(['src', 'lib', 'app', 'index', 'the', 'and', 'page', 'file', 'test', 'main', 'dist', 'build', 'js', 'ts']);

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------

/**
 * What was not checked.
 *
 * Assembled from two places on purpose. The last run knows which ways in it
 * never opened; the machine survey knows which surfaces cannot be reached from
 * here at all. A report missing either half would let somebody read "everything
 * walked" and believe the product was covered when the phone was never touched.
 *
 * @param {ToolContext} ctx
 * @param {Record<string, any>} input
 * @returns {Promise<ToolResult>}
 */
async function toolCoverage(ctx, input) {
  const engine = await loadEngine();
  const last = await readLastCheck(ctx.root);

  /** @type {any} */
  let caps = null;
  if (engine.parts.capabilities) {
    try {
      caps = await engine.parts.capabilities({ cwd: ctx.root, offline: true });
    } catch {
      // The machine survey is one half of the answer, not the whole of it. Losing
      // it must not lose the half that came from the run.
      caps = null;
    }
  }

  const coverage = last?.result?.coverage ?? null;
  const unreachable = (caps?.surfaces ?? []).filter((/** @type {any} */ s) => s.status === 'unavailable');
  const partial = (caps?.surfaces ?? []).filter((/** @type {any} */ s) => s.status === 'partial');

  if (input.format === 'json') {
    const payload = {
      lastCheckAt: last?.at ?? null,
      covers: caps?.covers ?? null,
      walked: coverage?.journeys ?? null,
      unopened: (coverage?.gaps ?? []).map((g) => g.what),
      surfacesOutOfReach: unreachable.map((/** @type {any} */ s) => ({ name: s.name, why: s.summary, needs: s.needs })),
      surfacesPartial: partial.map((/** @type {any} */ s) => ({ name: s.name, why: s.summary })),
      neverVisible: caps?.limits ?? null,
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
  }

  /** @type {string[]} */
  const out = [];
  out.push('WHAT WAS NOT CHECKED');
  out.push('');
  // The machine's honest statement goes first, because it is the half that
  // survives even when no check has ever run here.
  if (caps?.covers?.short) {
    out.push(caps.covers.short);
    out.push('');
  }

  if (!last) {
    out.push('No check has run in this copy yet, so nothing at all has been covered.');
  } else if (!coverage) {
    out.push('The last run did not report what it covered, so how deep it went is unknown. That is itself the answer: treat its clean result with suspicion.');
  } else {
    // A gap IS a way in that was never opened, said in plain English by whoever
    // could not open it. Printing the sentence keeps the reason attached to the hole.
    const unopened = (coverage.gaps ?? []).map((g) => g.what);
    out.push(`The last run walked ${coverage.journeys} ${coverage.journeys === 1 ? 'way in' : 'ways in'}.`);
    if (unopened.length === 0) {
      out.push('It opened every way in that it knows about. That is not the same as every possible state - nothing can enumerate that - but there is no known door it has never been through.');
    } else {
      out.push(`${unopened.length} ${unopened.length === 1 ? 'way in has' : 'ways in have'} never been opened, so nothing in any check says anything about ${unopened.length === 1 ? 'it' : 'them'}:`);
      for (const d of unopened.slice(0, 30)) out.push(`- ${trim(String(d), 160)}`);
      if (unopened.length > 30) out.push(`- and ${unopened.length - 30} more.`);
    }
  }

  if (unreachable.length) {
    out.push('');
    out.push('Cannot be reached from this machine at all, so nothing there has been checked by anything:');
    for (const s of unreachable) {
      out.push(`- ${s.name}: ${s.summary}`);
      for (const need of s.needs ?? []) out.push(`    it would take: ${need.fix ?? need.what}`);
    }
  }
  if (partial.length) {
    out.push('');
    out.push(`Reachable, but not everything on them can be watched: ${partial.map((/** @type {any} */ s) => s.name).join(', ')}. staysfixed_capabilities says what each limit is.`);
  }

  if (Array.isArray(caps?.limits) && caps.limits.length) {
    out.push('');
    out.push('And these it will never see, on any machine, by design:');
    for (const limit of caps.limits) out.push(`- ${limit}`);
  }

  out.push('');
  out.push('What this tool can honestly claim: it catches breaks reachable from the journeys it has. Everything above is the hole, kept visible on purpose rather than pretended away.');

  return { content: [{ type: 'text', text: out.join('\n') }] };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Which sealed class a finding is in, if any.
 *
 * A crash counts however it arrives, even when the engine did not label it: the
 * one class where guessing wrong is unrecoverable is the one to be generous
 * about.
 *
 * @param {RawFinding} f
 * @returns {string|null}
 */
function sealedOf(f) {
  if (typeof f.sealed === 'string' && f.sealed in SEALED_CLASSES) return f.sealed;
  if (typeof f.sealed === 'string' && f.sealed) return f.sealed;
  if (/\bcrash|fatal|unhandled|segfault\b/i.test(String(f.title))) return 'crash';
  return null;
}

/**
 * @param {unknown} e
 * @returns {string}
 */
function explainError(e) {
  const message = messageOf(e);
  if (isExpected(e)) {
    const hint = /** @type {{hint?: string}} */ (e).hint;
    return hint ? `${message}\n${hint}` : message;
  }
  return `Stays Fixed could not finish that: ${message}`;
}

/**
 * @param {string} message
 * @returns {ToolResult}
 */
function problem(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * @param {unknown} v
 * @returns {string|null}
 */
function text(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
}

/**
 * @param {unknown} v
 * @returns {string[]|undefined}
 */
function stringList(v) {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => String(x).trim());
  return out.length ? out : undefined;
}

/**
 * @param {unknown} v
 * @returns {number|null}
 */
function positive(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function stringy(v) {
  if (v === null || v === undefined) return '(nothing)';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function valueOf(v) {
  const one = stringy(v).replace(/\s+/g, ' ').trim();
  if (one === '(nothing)') return one;
  return one.length > 90 ? `"${one.slice(0, 89)}..."` : `"${one}"`;
}

/**
 * @param {string} s
 * @param {number} max
 */
function trim(s, max) {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '...' : one;
}

/**
 * @param {string} s
 * @param {number} lines
 */
function trimLines(s, lines) {
  const all = String(s).split('\n');
  return all.length <= lines ? s : all.slice(0, lines).join('\n') + `\n... and ${all.length - lines} more lines.`;
}

/** @param {unknown} s */
function indent(s) {
  return String(s)
    .split('\n')
    .slice(0, 40)
    .map((line) => `  ${line}`)
    .join('\n');
}

/** @param {number} n */
function ordinal(n) {
  const suffix = n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/**
 * @param {string} file
 * @returns {Promise<Buffer|null>}
 */
async function readMaybe(file) {
  try {
    return await fsp.readFile(file);
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @returns {Promise<string|null>}
 */
async function readText(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}
