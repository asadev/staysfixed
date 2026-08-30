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

import { isExpected, messageOf } from '../../core/errors.js';
import { findConfigFile, rootForConfig } from '../../core/paths.js';
import { openStore } from '../store.js';
import { SEALED_CLASSES, classify } from '../sealed.js';
import { sealIntent } from '../intent.js';
import { waive } from '../waiver.js';
import {
  WAIVER_BUDGET,
  decide,
  escalationBlock,
  escalationsFor,
  productFor,
  readCheckRecord,
  readDecisions,
} from '../escalate.js';

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
 * The five classes an agent may never wave through, said as a name and a sentence.
 *
 * This file used to keep its own copy of the list and its own regular expressions for
 * matching it, which is precisely the shape of bug the whole tool exists to catch: two
 * statements of what may never be waived, agreeing today, one of them quietly edited in six
 * months. There is one list now, in src/v2/sealed.js, and one function that decides which
 * class a difference is in. This only reads them.
 *
 * @type {Record<string, string>}
 */
const SEALED_SAYS = Object.fromEntries(SEALED_CLASSES.map((c) => [c.name, `${c.says} - ${c.because}`]));

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
  // What a run did NOT look at, in one sentence. Taken from the engine rather than
  // written again here, because two differently-worded statements of the same coverage
  // is how one of them quietly starts being wrong — and this is the sentence that stands
  // between a clean result and somebody believing more of it than it says.
  notChecked: ['whatWasNotChecked'],
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
 * The sealed intents, the waivers and the record of the last check all live in the store's
 * own folder. This file reads and writes none of them: intents belong to src/v2/intent.js,
 * waivers to src/v2/waiver.js, the record and the escalations to src/v2/escalate.js.
 *
 * That separation is the point. The engine decides what is DIFFERENT; the decision layer
 * decides what an agent is ALLOWED to say about it; this surface only asks, and repeats the
 * answer word for word. An engine bug must not be able to widen a gate, and neither must a
 * rewording here — which is exactly what happened while this file held its own copy of the
 * sealed classes and its own idea of what an intent covered.
 *
 * @param {ToolContext} ctx
 * @returns {import('../types.js').Store}
 */
function storeFor(ctx) {
  return openStore({ root: ctx.root });
}

/**
 * A sealed statement of what the agent meant to change, written before the run.
 * @typedef {import('../intent.js').Intent} Intent
 */

/**
 * The record of the last check, written by the engine and read here, so that explain, prove
 * and waive can all be handed an id and "there is no finding called that" is a real answer
 * rather than a shrug.
 * @typedef {import('../escalate.js').CheckRecord} CheckIndex
 */

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * What each tool DOES to the machine, in the four flags the protocol defines for it.
 *
 * These are not decoration. A client uses them to decide what it may run without stopping
 * to ask a person, and an agent uses them to tell a question apart from an action. Getting
 * them wrong in either direction is a real cost: mark a tool read-only when it is not and
 * something runs unasked; mark a harmless question as an action and every session opens
 * with a prompt nobody needed.
 *
 * They are set honestly here rather than optimistically. `staysfixed_check` reads nothing
 * but it OPENS YOUR PRODUCT — twice — so it is not read-only, and two runs of it can
 * legitimately answer differently, so it is not idempotent either. `staysfixed_prove` puts
 * files back to the reference for one run and restores them afterwards; nothing survives
 * it, and an agent should still know it touches the working tree.
 *
 * `openWorldHint` is false on every one of them, and that is the whole design in one flag:
 * nothing here reaches a server, an account or the internet. There is nowhere to sign up.
 *
 * @param {{title: string, readOnly?: boolean, destructive?: boolean, idempotent?: boolean}} a
 * @returns {Record<string, unknown>}
 */
function behaves({ title, readOnly = false, destructive = false, idempotent = false }) {
  return { title, readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false };
}

/**
 * The `tools/list` payload. Static, and it never touches disk: an agent listing
 * tools in a project that is not set up must still see
 * `staysfixed_capabilities`, which is the tool that explains why nothing else
 * will work yet.
 *
 * Every entry carries three things an agent reads before it calls anything: a short
 * `title` a person would recognise in a permission prompt, a description long enough to
 * say WHEN to call it and not merely what it is, and `annotations` saying what it does to
 * the machine. See `behaves`.
 *
 * @returns {{name: string, title: string, description: string, inputSchema: Record<string, any>, annotations: Record<string, unknown>}[]}
 */
export function toolDefinitions() {
  return [
    {
      name: 'staysfixed_capabilities',
      title: 'What can be checked here',
      annotations: behaves({ title: 'What can be checked here', readOnly: true, idempotent: true }),
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
      title: 'Seal what you meant to change',
      annotations: behaves({ title: 'Seal what you meant to change' }),
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
      title: 'Check what changed',
      annotations: behaves({ title: 'Check what changed' }),
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
          journeys: {
            type: 'string',
            description:
              "Where the steps come from. 'code' is the default and needs nothing: each adapter reads your source and offers what it finds - routes, commands, screens, message channels. 'suite' walks the project's own test suite as well: each test file runs twice inside the scratch copy, every check is reported by name, and it stops after 90 seconds naming each file it did not reach. It catches breaks nothing else can - a rounding change the product's own output never shows. It is opt-in because running a stranger's whole suite twice on every check is not something to do by default. You can also pass a path to a journeys file naming steps by hand. 'recorded' (replay a recorded session) is written and not yet wired into a run: ask for it and it says so rather than checking something else.",
          },
          surface: {
            type: 'string',
            enum: ['auto', 'cli', 'library', 'server', 'web', 'electron', 'android', 'ios'],
            description:
              "What kind of product to aim at. Default 'auto', which uses the settings. 'web' opens the page in a browser of the tool's own — never yours — and reads what the screen says each control is and does. 'electron' opens the desktop app with its own scratch data folder and drives it over its own debugging port. 'android' installs the APK on a virtual device; 'ios' boots the built app on a simulator. Aim it at something this copy or this machine cannot drive and it refuses by name rather than checking something else and reporting that.",
          },
          at: {
            type: 'string',
            description:
              "Where that product is: a URL for 'web' (http://localhost:3000), the path to the built app for 'electron', the APK for 'android', the built .app for 'ios'. Leave it out to use whatever the settings name.",
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
      title: 'One finding in full',
      annotations: behaves({ title: 'One finding in full', readOnly: true, idempotent: true }),
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
      title: 'Prove what caused it',
      annotations: behaves({ title: 'Prove what caused it' }),
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
      title: 'Record a difference as intended',
      annotations: behaves({ title: 'Record a difference as intended' }),
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
      title: 'What was not checked',
      annotations: behaves({ title: 'What was not checked', readOnly: true, idempotent: true }),
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

  const decisions = await readDecisions(storeFor(ctx), await productFor(ctx.root));
  const spent = decisions.spent;

  if (input.format === 'json') {
    const payload = {
      tool: 'staysfixed',
      version: ctx.version,
      loop: LOOP_STEPS,
      resultShapes: RESULT_SHAPES,
      waiving: { budget: WAIVER_BUDGET, spent, sealedClasses: SEALED_SAYS, expiresWhen: 'the reference moves - when a build is shipped' },
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
  for (const [name, why] of Object.entries(SEALED_SAYS)) out.push(`    ${name} - ${why}`);

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
  "staysfixed_check { surface: 'android', at: '/path/to/app-release.apk' } — installs the APK on a virtual device of its own, walks it, and reads what each control on the screen is and does. A real handset cannot be compared against a second build and never will be; the emulator is the honest answer.",
  "staysfixed_check { surface: 'ios', at: '/path/to/YourApp.app' } — boots the built app on a simulator of its own. Real iPhones are out of reach for the same reason.",
  "staysfixed_check { surface: 'cli' } or { surface: 'server' } — the same engine on a command-line tool or an HTTP server.",
  'Aiming at something this copy has no adapter for, or something this project does not contain, is REFUSED by name. It never falls back to checking whatever else was lying around and reporting that as your answer.',
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

  const store = storeFor(ctx);
  const product = await productFor(ctx.root);

  // src/v2/intent.js does the sealing, and it does more than write a file down: it
  // fingerprints the working tree at this moment, so whether the intent was written before
  // the edits or after them stops being a promise and becomes something anybody can check.
  const intent = await sealIntent(store, { product, summary, touches, expect, by: 'an agent, over MCP' });

  // Sealing a new intent does NOT hand out a fresh five. The budget is counted
  // against the reference, precisely so an agent that has spent its waivers
  // cannot buy five more by re-declaring what it meant to do. Between one ship
  // and the next, all of it is one change.
  const spent = (await readDecisions(store, product)).spent;

  return {
    content: [
      {
        type: 'text',
        text: [
          `Sealed as ${intent.id} at ${intent.sealedAt}${intent.tree.head ? `, on commit ${intent.tree.head.slice(0, 7)}` : ''}.`,
          `You said: ${summary}`,
          `Expecting to affect: ${intent.files.join(', ')}.`,
          expect.length ? `Expecting to see: ${expect.join('; ')}.` : '',
          intent.ordering,
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

  const store = storeFor(ctx);
  const limit = positive(input.limit) ?? DEFAULT_LIMIT;
  const offset = positive(input.offset) ?? 0;

  // A value the engine does not understand must be refused BY NAME, never passed down.
  //
  // `suite` is now wired and reaches the harvest. `recorded` is still written and called by
  // nothing, so passing it down would reach the engine as the name of a FILE and come back as
  // "there is no journeys file at .../recorded" — an error that sends an agent looking for a
  // file it never asked for. Refusing it by name and saying why is the honest answer, and a
  // clean result about the wrong steps would be worse than no result.
  const wantedJourneys = text(input.journeys);
  if (wantedJourneys === 'recorded') {
    return problem(
      'Replaying a recorded session is written and not wired into a run yet, so nothing was checked. Leave journeys out to use the steps each adapter reads from your source, pass "suite" to walk your own test suite, or pass the path to a journeys file.'
    );
  }

  const surface = text(input.surface);
  const at = text(input.at);
  const aimed = (surface !== null && surface !== 'auto') || at !== null;

  // Paging really does page. An agent asking for the next ten findings is asking to read
  // more of an answer it already has, and running the whole product again to give it to
  // them would be minutes of work for a result that could also come back DIFFERENT - which
  // is the one thing a page two must never be.
  const product = await productFor(ctx.root);
  const paging = offset > 0 ? await readCheckRecord(store) : null;

  /** @type {CheckResult} */
  const result = paging ? paging.result : await run({
    cwd: ctx.root,
    configFile: undefined,
    against: text(input.against) ?? undefined,
    paired: input.paired === true,
    journeys: wantedJourneys ?? undefined,
    only: stringList(input.only) ?? [],
    surface: surface && surface !== 'auto' ? surface : undefined,
    at: at ?? undefined,
  });

  // A run that was AIMED at something has to confirm it went there. An engine
  // that quietly ignores an unknown option would hand back a perfectly clean
  // result about something else entirely, and the agent would read it as proof
  // about the thing it named. So the confirmation is required, not assumed.
  const missedTheTarget = aimed && !paging ? aimingNote(surface, at, /** @type {any} */ (result).target) : null;

  // Waivers were applied by the engine, in src/v2/escalate.js, before this ever saw the
  // verdict - and the record it wrote holds EVERY finding, waived ones included, so this
  // surface can still explain and prove one. What is applied here is only the fallback for
  // an engine too old to have done it, and it calls exactly the same function rather than
  // keeping a second opinion about what a waiver means.
  const record = paging ?? (await readCheckRecord(store));
  const fresh = record && (paging !== null || record.result?.runId === result?.runId);

  /** @type {Finding[]} */
  const all = fresh && record ? record.findings : decide(Array.isArray(result?.findings) ? result.findings : [], await readDecisions(store, product)).all;
  const accounting = fresh && record ? record.accounting : (/** @type {any} */ (result).accounted ?? null);

  const waived = all.filter((f) => typeof (/** @type {any} */ (f).waivedBy) === 'string');
  const unaccounted = all.filter((f) => typeof (/** @type {any} */ (f).waivedBy) !== 'string');
  const expired = accounting?.expiredWaivers ?? 0;

  // The engine reports a newly unpredictable address as a whole wobble entry. The
  // agent only needs the address, so that is all that is carried forward - the values
  // behind it are fetched with staysfixed_explain like everything else heavy.
  const newlyUnstable = (Array.isArray(result?.newlyUnstable) ? result.newlyUnstable : []).map((e) =>
    typeof e === 'string' ? e : e.path
  );

  const page = unaccounted.slice(offset, offset + limit);
  // A run that compared NOTHING is not a clean run, and this is the surface where saying so
  // matters most. The engine had already worked it out and set `ok: false`; this line only
  // ever counted differences, so a project with nothing on record produced zero differences,
  // counted as clean, and the agent was told everything still works.
  const comparedNothing = typeof result?.comparedNothing === 'string' && result.comparedNothing.length > 0;
  const clean = cleanForAgent(result, unaccounted.length, newlyUnstable.length);

  // What this run did not look at, in the engine's own words. It rides in every reply,
  // clean ones included: a green result on a product with three hundred unopened doors is
  // true, and it is not what it looks like, and an agent that reads only the headline is
  // about to tell somebody their change is safe.
  const notChecked = coverageSentence(engine, result);
  const doors = result?.coverage?.doorsKnown ?? 0;
  const unopened = Math.max(0, doors - (result?.coverage?.doorsWalked ?? 0));

  // On a clean run, and only then, the machine's own statement of what a clean run here
  // would MEAN. This is the sentence the design asks for in so many words: "this covers
  // your website; your iPhone app is not being checked, and here is why". An agent about
  // to tell somebody a change is safe needs it, and a run with findings in it does not —
  // that agent has work to do and no reason to over-read anything.
  const covers = clean ? await whatAGreenRunMeansHere(engine, ctx) : null;

  if (input.format === 'json') {
    const payload = {
      ok: clean,
      // "differences found" would be the wrong word for a run that found none because it
      // compared none. There are three outcomes here, not two, and the third is the one
      // that must never be mistaken for either.
      verdict: result?.blocked
        ? 'blocked'
        : comparedNothing
          ? 'nothing was compared'
          : clean
            ? 'nothing unaccounted for'
            : 'differences found',
      mode: result?.mode ?? null,
      note: result?.summary ?? null,
      noiseRemoved: result?.differencesNoise ?? null,
      newlyUnstable,
      coverage: result?.coverage ?? null,
      // Never only inside `coverage`. A field an agent has to know to go and look at is a
      // field that gets skipped, and this is the one that must not be.
      notChecked,
      doorsNeverOpened: unopened,
      covers,
      unaccounted: unaccounted.length,
      // Never a bare number. An agent has to be able to see that fifty things were waived
      // rather than merely that nothing was reported, or "silent" and "switched off" look
      // the same from here.
      accountedFor: {
        waived: waived.length,
        expiredWaivers: expired,
        unwaivable: unaccounted.filter((f) => classify(f) !== null).length,
        budget: accounting?.budget ?? WAIVER_BUDGET,
        waiversLeft: accounting?.left ?? null,
        note: accounting?.note ?? null,
      },
      // The class an agent reads has to be the class that DECIDES things, not the engine's
      // first guess. A 20% markup on a price came back as `class: "ordinary"` here while the
      // human text on the same run said "1 of them sealed and not yours to waive" and
      // `staysfixed_waive` refused it outright because it touches money. An agent reading
      // "ordinary" would reasonably believe it may wave a price change through, and would
      // tell somebody so. `waivable` is spelled out beside it so nothing has to be inferred
      // from a word at all.
      findings: page.map(findingForAgent),
      aimedAt: aimed ? { surface: surface ?? 'auto', at: at ?? null, confirmed: missedTheTarget === null } : null,
      aimingWarning: missedTheTarget,
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: !clean };
  }

  const intent = (await readDecisions(store, product)).intent;
  const body = renderCheck({
    result,
    unaccounted,
    page,
    offset,
    limit,
    waived: waived.length,
    expired,
    waiversLeft: accounting?.left ?? null,
    newlyUnstable,
    intent,
    clean,
    missedTheTarget,
    notChecked,
    covers,
  });

  // The handful of things a person has to rule on, written for the person rather than for
  // the agent, and handed over as a block to be pasted whole. This is the entire delivery
  // mechanism: he reads one closing summary at the end of a working stretch, so anything
  // that is not inside it did not reach him. There is no report to open and no dashboard.
  const escalations = await escalationsFor(store, result?.product ?? product);
  const tail = escalations.items.length
    ? [
        '',
        '',
        'PUT THIS IN YOUR CLOSING SUMMARY, WORD FOR WORD. It is written for the person you are working for, not for you, and it is the only part of this run they will ever see:',
        '',
        escalationBlock(escalations),
      ].join('\n')
    : '';

  // A difference is reported as an error result on purpose. Protocol-wise the
  // call succeeded, but `isError` is the flag every client puts in front of the
  // agent, and an agent that skims past a real regression is exactly the failure
  // this whole tool exists to prevent.
  return { content: [{ type: 'text', text: body + tail }], isError: !clean };
}

/**
 * Is this a clean run, as far as the machine asking is concerned?
 *
 * The last line is the one that matters and it is the one that was missing. This surface
 * used to work "clean" out from the difference count ALONE, and a product with nothing on
 * record produces no differences — so zero differences counted as a pass, and an agent was
 * told "everything that worked before still works" about a run that compared nothing at all.
 * The engine had already decided; nobody asked it.
 *
 * So the engine's own verdict is the floor. Whatever else is true, this can never answer
 * clean about a run the engine called not-ok. Counting reasons here will always be a list
 * somebody forgets to add to; deferring to the decision already made cannot be.
 *
 * @param {any} result            What `check` returned.
 * @param {number} unaccounted    Differences nobody has accounted for.
 * @param {number} newlyUnstable  Addresses that were steady and are not any more.
 * @returns {boolean}
 */
export function cleanForAgent(result, unaccounted, newlyUnstable) {
  if (result && result.ok === false) return false;
  if (result && result.blocked === true) return false;
  if (result && typeof result.comparedNothing === 'string' && result.comparedNothing.length > 0) return false;
  return unaccounted === 0 && newlyUnstable === 0;
}

/**
 * One finding, shaped for the machine that reads it.
 *
 * Split out and exported because it is a DECISION, not formatting, and a decision only a
 * running MCP server can reach is one nobody notices breaking. The class an agent reads has
 * to be the class that decides things: a 20% markup on a price came back over MCP as
 * `class: "ordinary"` while the human text on the same run said "1 of them sealed and not
 * yours to waive" and `staysfixed_waive` refused it because it touches money. An agent
 * reading "ordinary" would reasonably believe it may wave a price change through, and would
 * say so to a person. `waivable` is spelled out beside it so nothing has to be inferred
 * from a word at all.
 *
 * @param {any} f
 * @returns {any}
 */
export function findingForAgent(f) {
  const sealed = classify(f);
  return sealed
    ? { ...f, class: sealed.class, sealed: true, waivable: false, sealedBecause: sealed.why, sealedBy: sealed.matched }
    : { ...f, sealed: false, waivable: true };
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
 * @param {number|null} a.waiversLeft
 * @param {string[]} a.newlyUnstable
 * @param {Intent|null} a.intent
 * @param {boolean} a.clean
 * @param {string|null} a.missedTheTarget
 * @param {string} a.notChecked
 * @param {string|null} a.covers
 * @returns {string}
 */
export function renderCheck({ result, unaccounted, page, offset, limit, waived, expired, waiversLeft, newlyUnstable, intent, clean, missedTheTarget, notChecked, covers }) {
  /** @type {string[]} */
  const out = [];

  if (result?.blocked === true) {
    out.push('BLOCKED - the check could not be completed, so this is not a pass and not a failure. It is no answer at all.');
    if (result.summary) out.push(result.summary);
    out.push('Fix what is in the way and run it again. staysfixed_capabilities says what this machine can and cannot do.');
    return out.join('\n');
  }

  if (result?.comparedNothing) {
    out.push(
      result.comparedNothing === 'no reference'
        ? 'NOTHING WAS ACTUALLY COMPARED. There is no build of this product on record as working, so this run had nothing whatever to hold today\'s behaviour against. This is not a pass and not a failure - it is no answer.'
        : 'NOTHING WAS ACTUALLY COMPARED. Every journey was walked, and not one of them had anything on record from the build you were happy with. This is not a pass and not a failure - it is no answer.',
    );
    out.push('Do not report this as a clean run. Only shipping records what "working" means, and no agent may cut that reference.');
  } else if (clean) {
    out.push('NOTHING UNACCOUNTED FOR. Everything that worked before still works, as far as this run could see.');
  } else if (unaccounted.length) {
    const sealed = unaccounted.filter((f) => classify(f) !== null).length;
    out.push(`${unaccounted.length} ${unaccounted.length === 1 ? 'DIFFERENCE' : 'DIFFERENCES'} YOU DID NOT ACCOUNT FOR${sealed ? `, ${sealed} of them sealed and not yours to waive` : ''}.`);
  } else {
    out.push('NOTHING CHANGED, BUT THIS IS NOT A CLEAN RUN - see the newly unpredictable addresses below.');
  }

  // The silence has to be legible. "Nothing changed" and "nothing ran" read the
  // same otherwise, and one of those is a broken tool reporting success.
  /** @type {string[]} */
  const arithmetic = [];
  // "journeys", never "ways in". A DOOR is a way in — a route, a command, an exported
  // name — and the coverage sentence directly below this one counts doors. Calling both
  // of them "ways in" put "2 ways in were walked" one line above "2 of the 2 ways into
  // this product have never been walked through", which is a flat contradiction on screen
  // even though both numbers are right. Two different things need two different words.
  if (result?.coverage) arithmetic.push(`${result.coverage.journeys} ${result.coverage.journeys === 1 ? 'journey was' : 'journeys were'} walked`);
  if (typeof result?.differencesNoise === 'number' && result.differencesNoise > 0) arithmetic.push(`${result.differencesNoise} differences subtracted as this product's own wobble`);
  if (waived) arithmetic.push(`${waived} already recorded as intended and not shown again`);
  if (arithmetic.length) out.push(arithmetic.join(', ') + '.');

  // Immediately under the headline, never at the bottom. On a clean run this is the only
  // line that stops "nothing unaccounted for" being read as "your product is fine".
  out.push(notChecked);
  if (covers) out.push(covers);

  if (missedTheTarget) out.push(missedTheTarget);

  if (result?.mode === 'stored-record') {
    out.push(
      'Compared against the STORED RECORD, not against the old build booted live. That is genuinely weaker: it lets back in every difference that comes from the machine and the day rather than from your change. Pass paired: true for the strong comparison.'
    );
  }
  // The engine's summary ends with the same "not everything was checked" sentence that is
  // already printed under the headline, because both come from the one place that is
  // allowed to write it. Said twice in one reply it reads as a stutter, and an agent
  // paying by the token pays for it twice, so the second copy is taken out here rather
  // than by weakening either of the two rules that put it there.
  if (result?.summary) out.push(withoutRepeat(result.summary, notChecked));

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
    out.push(
      `${expired} ${expired === 1 ? 'waiver has' : 'waivers have'} expired because the reference moved - a build shipped since ${expired === 1 ? 'it was' : 'they were'} written. ${expired === 1 ? 'It covers' : 'They cover'} nothing any more, and anything ${expired === 1 ? 'it' : 'they'} used to cover is either in the list above or is now simply how the product works.`
    );
  }

  // Counted out loud on every run that has spent any of them. A waiver applied in silence
  // is how a rubber stamp starts, and the whole point of the budget is that an agent can
  // see itself running out.
  if (waived > 0 || (typeof waiversLeft === 'number' && waiversLeft < WAIVER_BUDGET)) {
    out.push('');
    out.push(
      `${waived} ${waived === 1 ? 'difference is' : 'differences are'} being held as intended by you, and ${typeof waiversLeft === 'number' ? `${waiversLeft} of your ${WAIVER_BUDGET} waivers ${waiversLeft === 1 ? 'is' : 'are'} left` : 'the budget could not be read'} before a person has to look. None of it is the new normal until a build ships.`
    );
  }

  if (unaccounted.length) {
    out.push('');
    out.push('Everything above is trimmed hard. staysfixed_explain gives you one finding in full; staysfixed_prove tells you whether your edit really caused it. Ask for those on the two or three you intend to act on, not on all of them.');
    if (!intent) out.push('You have not sealed an intent for this change, so nothing here can be waived. Call staysfixed_intent before the next run.');
  }

  return out.join('\n');
}

/**
 * What a clean run on THIS machine actually means, in the machine survey's own words.
 *
 * A product with a website and an iPhone app, checked on a machine that can only open the
 * website, produces a perfectly clean result that says nothing whatever about the phone.
 * Nothing inside the run can know that — the run only knows what it walked. This is the
 * other half, and it is the difference between "your change is safe" and "your change is
 * safe as far as your website goes".
 *
 * @param {Engine} engine
 * @param {ToolContext} ctx
 * @returns {Promise<string|null>}
 */
async function whatAGreenRunMeansHere(engine, ctx) {
  const survey = engine.parts.capabilities;
  if (typeof survey !== 'function') return null;
  try {
    // Offline: no other machine is dialled for this. A check is not the moment to spend
    // eight seconds finding out whether somebody's server is awake.
    const caps = await survey({ cwd: ctx.root, offline: true });
    const said = caps?.covers?.short;
    return typeof said === 'string' && said.trim() !== '' ? `WHAT A CLEAN RESULT HERE MEANS: ${said}` : null;
  } catch {
    return null;
  }
}

/**
 * What this run did not look at, in one sentence, guaranteed.
 *
 * The words come from the engine, so an agent and a person are never told two different
 * things about the same run. The fallback exists because this sentence may never be
 * absent: a reply that silently omits it on the one run where it mattered is exactly the
 * failure the whole coverage ledger is built to prevent. There is deliberately no path
 * through here that returns an empty string.
 *
 * @param {Engine} engine
 * @param {CheckResult} result
 * @returns {string}
 */
function coverageSentence(engine, result) {
  const say = engine.parts.notChecked;
  if (typeof say === 'function') {
    try {
      const said = say(result?.coverage);
      if (typeof said === 'string' && said.trim() !== '') return said;
    } catch {
      // An engine that threw while describing its own coverage has told us the most
      // important thing it could: do not trust the silence. Fall through and say so.
    }
  }

  const coverage = result?.coverage;
  if (!coverage) {
    return 'NOT EVERYTHING WAS CHECKED, and this run did not say how much — so how thorough it was is unknown. Treat a clean result with suspicion, and call staysfixed_coverage before you tell anybody a change is safe.';
  }
  const unopened = Math.max(0, (coverage.doorsKnown ?? 0) - (coverage.doorsWalked ?? 0));
  const gaps = (coverage.gaps ?? []).filter((g) => typeof g.doors !== 'number').length;
  if (unopened === 0 && gaps === 0) {
    return `Everything this run knows how to walk was walked — ${coverage.paths} addresses across ${coverage.journeys} journeys. That is not every possible state of your product; nothing can enumerate that.`;
  }
  return `NOT EVERYTHING WAS CHECKED: ${unopened} ways into this product have never been walked through, and ${gaps} other things were not looked at. A clean result only covers what was walked — staysfixed_coverage has the list.`;
}

/**
 * One sentence, said once.
 *
 * Returns `text` with `sentence` removed if it is in there, tidied so the seam does not
 * show. Both strings come from the engine, so this never edits meaning - it only stops the
 * same words arriving twice in one reply.
 *
 * @param {string} text
 * @param {string} sentence
 * @returns {string}
 */
function withoutRepeat(text, sentence) {
  const trimmed = sentence.trim();
  if (trimmed === '' || !text.includes(trimmed)) return text;
  const left = text.replace(trimmed, '').replace(/[ \t]{2,}/g, ' ').trim();
  return left === '' ? text : left;
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
  const sealed = classify(f);
  if (sealed) flags.push(`SEALED: ${sealed.class}`);
  if (typeof f.count === 'number' && f.count > 1) flags.push(`${f.count} addresses`);
  out.push(`- [${f.id}] ${trim(f.title, 200)}${flags.length ? `  (${flags.join(', ')})` : ''}`);

  // Only list the addresses when they add something. A single address the
  // sentence already names is a line of pure repetition, and the agent pays for
  // every one of those.
  const paths = f.paths ?? [];
  const worthListing = paths.filter((p) => !f.title.includes(p));
  if (worthListing.length) out.push(`    ${worthListing.slice(0, 3).join(', ')}${worthListing.length > 3 ? `, and ${worthListing.length - 3} more` : ''}`);
  if (f.sample) out.push(`    ${f.sample.path}: was ${valueOf(f.sample.reference)}, now ${valueOf(f.sample.candidate)}`);
  if (sealed) out.push(`    You cannot waive this: ${sealed.says}. Fix it, or tell a person. ${sealed.strength === 'likely' ? 'Read it before you assume it is a false alarm - and if it is one, that is a person\'s call, not yours.' : ''}`.trimEnd());
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

  const last = await readCheckRecord(storeFor(ctx));
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
  // `classify` returns a whole verdict, not a class name, and interpolating the object
  // printed "(SEALED: [object Object])" on the one reply an agent reads when it is trying
  // to understand a difference it is not allowed to waive.
  const sealed = classify(f);
  out.push(f.title + (sealed ? `  (SEALED: ${sealed.says} - not yours to waive)` : ''));
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

  // The engine's own deep answer lists every address with both values in full. When it is
  // there, printing a one-address sample above it is the same text twice in one reply -
  // and an agent pays for both copies.
  const engineShowsValues = typeof deep?.text === 'string' && f.sample != null && deep.text.includes(stringy(f.sample.candidate).trim());
  if (include.includes('values') && !engineShowsValues) {
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

  const last = await readCheckRecord(storeFor(ctx));
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

  const store = storeFor(ctx);
  const last = await readCheckRecord(store);
  if (!last) return problem('No check has run in this copy yet, so there is no difference to waive. Run staysfixed_check first.');
  const f = last.findings.find((x) => x.id === id);
  if (!f) return problem(`The last check has no finding called "${id}". You can only waive something this tool actually reported.`);

  // Every gate lives in src/v2/waiver.js, and it runs all four itself rather than trusting
  // this file to have run them first. A safety property that depends on being CALLED
  // correctly is not a safety property, and this surface used to hold its own slightly
  // different copy of all four — which is how a gate quietly stops meaning anything.
  //
  // The check stamp is what makes gate two real: an intent sealed after this check ran
  // cannot be used to justify anything in it, and only the record knows when it ran.
  const decision = await waive(store, {
    product: last.product ?? (await productFor(ctx.root)),
    finding: f,
    why: because,
    check: { at: last.at, runId: last.result?.runId },
    by: 'an agent, over MCP',
  });

  // A refusal is the tool working, not the tool being difficult, and the wording is the
  // feature: an agent told "refused" tries again in different words, an agent told which
  // gate stopped it and what it could legitimately do instead goes and does that.
  if (!decision.ok) return problem(decision.say);

  return { content: [{ type: 'text', text: decision.say }] };
}

/**
 * Whether a finding falls inside what the agent declared is decided by `intentCovers` in
 * src/v2/intent.js, and it used to be decided here as well, by a second and slightly
 * different set of rules. Two answers to one question is how a gate quietly stops meaning
 * anything: the strict one refuses, somebody notices, and the loose one becomes the one
 * that gets called. There is one now, and it grades its own confidence rather than
 * returning a bare yes.
 */

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
  const last = await readCheckRecord(storeFor(ctx));

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
      doorsKnown: coverage?.doorsKnown ?? null,
      doorsWalked: coverage?.doorsWalked ?? null,
      doorsNeverOpened: coverage ? Math.max(0, (coverage.doorsKnown ?? 0) - (coverage.doorsWalked ?? 0)) : null,
      // What this COPY of the tool can drive, which is not the same question as what this
      // machine could run. A Mac with Xcode on it can run an iPhone app; that says nothing
      // about whether there is an adapter here that knows how to open one.
      cannotBeDriven: (caps?.drivers ?? []).filter((/** @type {any} */ d) => !d.present).map((/** @type {any} */ d) => ({ surface: d.surface, why: d.why })),
      // The whole gap, not just its headline. Several of the caveats the engine raises
      // share one headline — "This coverage count is less exact than it looks" — and
      // differ entirely in `why`, so a list of headlines is the same sentence three times
      // and none of the three reasons. The reason IS the content.
      unopened: (coverage?.gaps ?? [])
        .filter((/** @type {{doors?: number}} */ g) => typeof g.doors !== 'number')
        .map((/** @type {{what: string, why?: string, unlockedBy?: string}} */ g) => ({ what: g.what, why: g.why ?? null, unlockedBy: g.unlockedBy ?? null })),
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
    // A gap IS something that was not looked at, said in plain English by whoever could
    // not look at it. Printing the sentence keeps the reason attached to the hole. The
    // doors gap is left out here because it is already counted, in its own words, just
    // above — and a number a reader can catch out twice is a number they stop believing.
    /** @type {{what: string, why: string, unlockedBy: string}[]} */
    const unopened = (coverage.gaps ?? [])
      .filter((/** @type {{doors?: number}} */ g) => typeof g.doors !== 'number')
      .map((/** @type {{what: string, why?: string, unlockedBy?: string}} */ g) => ({ what: String(g.what), why: String(g.why ?? ''), unlockedBy: String(g.unlockedBy ?? '') }));
    out.push(`The last run walked ${coverage.journeys} ${coverage.journeys === 1 ? 'journey' : 'journeys'}. A journey is one route through the product; a door is one way into it, and they are counted separately below.`);
    const doorsKnown = coverage.doorsKnown ?? 0;
    const never = Math.max(0, doorsKnown - (coverage.doorsWalked ?? 0));
    if (never > 0) {
      out.push(
        doorsKnown === 1
          ? 'The one door the code opens — a route, an exported function, an IPC channel — has never been walked through by any journey. It is known to EXIST and is not known to WORK, and no check has ever said anything about it.'
          : `${never} of the ${doorsKnown} doors the code opens — routes, exported functions, IPC channels — ${never === 1 ? 'has' : 'have'} never been walked through by any journey. They are known to EXIST and are not known to WORK, and no check has ever said anything about them.`
      );
    }
    if (unopened.length === 0 && never === 0) {
      out.push('It opened every way in that it knows about. That is not the same as every possible state - nothing can enumerate that - but there is no known door it has never been through.');
    } else if (unopened.length > 0) {
      out.push(`${unopened.length} other ${unopened.length === 1 ? 'thing was' : 'things were'} not looked at, so nothing in any check says anything about ${unopened.length === 1 ? 'it' : 'them'}:`);
      for (const gap of unopened.slice(0, 30)) {
        out.push(`- ${trim(gap.what, 160)}`);
        // The reason on its own line and never dropped. Three gaps here can carry the
        // same headline and three different reasons, and printing only the headline
        // turned that into the same sentence three times over - which reads as a bug in
        // the tool rather than as three separate holes in the coverage.
        if (gap.why) out.push(`  ${trim(gap.why, 400)}`);
        if (gap.unlockedBy && !/^Read the caveat/i.test(gap.unlockedBy)) out.push(`  What would close it: ${trim(gap.unlockedBy, 300)}`);
      }
      if (unopened.length > 30) out.push(`- and ${unopened.length - 30} more.`);
    }
  }

  const noAdapter = (caps?.drivers ?? []).filter((/** @type {any} */ d) => !d.present);
  if (noAdapter.length) {
    out.push('');
    out.push('This copy of Stays Fixed has no adapter for these, so nothing aimed at them would be walked at all:');
    for (const d of noAdapter) out.push(`- ${d.surface}: ${d.why}`);
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
  if (s === '') return null;
  // Capped, because every one of these is a string an AGENT chose and several of them are
  // echoed straight back in the reply and then written into the store for ever. A megabyte
  // of summary came back as a megabyte of tool result and stayed there. Nothing legitimate
  // here is long: a reason, a finding id, a surface name. Cutting says so out loud rather
  // than quietly keeping the first part.
  const MOST = 4000;
  return s.length <= MOST ? s : `${s.slice(0, MOST)} … (cut here: this was ${s.length} characters, and nothing this tool asks for is that long)`;
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
