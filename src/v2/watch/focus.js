/**
 * Letting you watch, without taking your screen.
 *
 * The owner asked for something more precise than "run it invisibly", and he was right
 * to. He wants to SEE it work — the app opening, the panel beside it, each check ticking
 * green — because watching it is most of how you come to trust it. What he does not want
 * is what it did to him tonight:
 *
 *   "if i click something and bring [my app] on the first layer of the screen and i am
 *    working on something, after my click it will not keep bringing it up. it will just
 *    keep it back side and keep working."
 *
 * So the rule is not "stay hidden". It is: **come up once, then never come up again.**
 *
 * That distinction is the whole of this file. An app the tool opens is allowed to appear —
 * it should, the first time, so a person can see what is happening. From the moment the
 * person picks something else, whatever the tool launched loses the argument for good.
 *
 * ## Why a guard rather than a flag
 *
 * There is no flag for this. An Electron app calls `app.focus()` and `win.show()` from its
 * own main process during startup, when a window opens, when a dialog appears; a simulator
 * activates when it boots; a browser activates when a new window is created. None of that
 * goes through us, so none of it can be forbidden at launch time. The only thing that
 * actually works is to watch who is in front and put the person's app back when something
 * of ours pushes in front of it.
 *
 * ## Why polling is the right answer here, unusually
 *
 * The standing rule in this codebase is events over polling. macOS does publish an
 * activation notification, but reading it needs a process inside the window server session
 * with an event loop — a small native helper or a persistent AppleScript, both of which are
 * a thing to install and a thing to leave running on his machine. A twelve-line
 * `osascript` every 400ms costs about a millisecond of CPU and installs nothing. The rule
 * exists to stop wasteful polling; this is the case it does not cover.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detail } from '../../core/log.js';

const run = promisify(execFile);

/** How often to look. Fast enough that a stolen screen is given back before it is annoying. */
const LOOK_EVERY_MS = 400;

/**
 * How long to leave the tool's window alone at the start.
 *
 * It has just been opened deliberately and a person is probably looking at it. Snatching
 * focus away in the same instant would be its own kind of rude, and would also fight the
 * launch itself while the app is still deciding which of its windows is in front.
 */
const GRACE_MS = 2500;

/** @typedef {{name: string}} Frontmost */

/**
 * Who is in front right now, by application name.
 *
 * Returns null rather than throwing on any failure — no window server, no Apple Events
 * permission, a headless machine, a locked screen. Every one of those means "there is no
 * screen to take", which is not an error and must never fail a check.
 *
 * @returns {Promise<string|null>}
 */
export async function frontmostApp() {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await run(
      'osascript',
      ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
      { timeout: 3000 },
    );
    const name = stdout.trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Bring one application back to the front.
 *
 * @param {string} name
 * @returns {Promise<boolean>} whether it worked
 */
export async function bringForward(name) {
  if (process.platform !== 'darwin' || !name) return false;
  try {
    await run(
      'osascript',
      [
        '-e',
        `tell application "System Events" to set frontmost of first application process whose name is ${JSON.stringify(name)} to true`,
      ],
      { timeout: 3000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * @typedef {object} ScreenGuard
 * @property {(name: string) => void} claim      Tell the guard an application belongs to the tool.
 * @property {() => Promise<void>} release       Stop guarding. Always safe to call twice.
 * @property {() => GuardReport} report          What it did, for the run summary.
 */

/**
 * @typedef {object} GuardReport
 * @property {number} handedBack   How many times the screen was taken and given back.
 * @property {string|null} yours   The application the guard believes is yours.
 * @property {string[]} ours       Everything the tool opened.
 * @property {boolean} watching    False when there is no screen to guard.
 */

/**
 * Watch who is in front, and give the screen back when something of ours takes it.
 *
 * The bookkeeping is deliberately simple, because a clever version of this would guess
 * wrong and fight the person for their own screen:
 *
 *  - Anything the tool launches is `ours`, named as the tool launches it.
 *  - Anything else that is frontmost is *yours*, and the guard remembers the last one. That
 *    is how it learns what to put back — by watching what you actually chose, never by
 *    being told.
 *  - When one of ours is in front and you have chosen something since, yours goes back.
 *  - When one of ours is in front and you have chosen nothing yet, it is left alone. That
 *    first appearance is the point: it is how you see what is happening.
 *
 * `look` and `putBack` exist so this loop can be exercised without a screen. They default to
 * the two functions above and nothing in the tool passes them; a test does, because the
 * bookkeeping — what counts as yours, when the screen is given back, how many times it
 * happened — is the part that has to be right, and it is unreachable behind two calls to
 * `osascript` that answer differently on every machine and not at all on most of them.
 *
 * @param {{claims?: string[], everyMs?: number, graceMs?: number, look?: () => Promise<string|null>, putBack?: (name: string) => Promise<boolean>}} [opts]
 * @returns {ScreenGuard}
 */
export function guardTheScreen(opts = {}) {
  const everyMs = opts.everyMs ?? LOOK_EVERY_MS;
  const graceMs = opts.graceMs ?? GRACE_MS;
  const whoIsInFront = opts.look ?? frontmostApp;
  const putBack = opts.putBack ?? bringForward;

  /** @type {Set<string>} everything the tool opened */
  const ours = new Set(opts.claims ?? []);
  /** @type {string|null} the last application the person chose for themselves */
  let yours = null;
  let handedBack = 0;
  // Nothing to guard where there is no window server — unless a caller supplied its own way
  // of looking, which means it is being driven deliberately rather than left to the machine.
  let stopped = process.platform !== 'darwin' && !opts.look;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  const startedAt = Date.now();

  /** @param {string} name */
  const claim = (name) => {
    if (name) ours.add(name);
  };

  const isOurs = (/** @type {string} */ name) => {
    for (const one of ours) {
      // A launched application is often reported under a slightly different name than the
      // path it was started from — "Terminal Deck" for a binary called "Terminal Deck", but
      // "Electron" for a development build, and "Simulator" for a simulator boot. Matching
      // loosely in both directions is what makes this work without a table of special cases.
      if (name === one || name.includes(one) || one.includes(name)) return true;
    }
    return false;
  };

  const look = async () => {
    if (stopped) return;
    const front = await whoIsInFront();
    if (front) {
      if (!isOurs(front)) {
        // The person chose this. It is now what "yours" means.
        yours = front;
      } else if (yours && Date.now() - startedAt > graceMs) {
        // Something of ours is in front, and there is somewhere to put you back.
        const ok = await putBack(yours);
        if (ok) {
          handedBack += 1;
          detail(`the screen was taken by ${front}; gave it back to ${yours}`);
        }
      }
    }
    if (!stopped) timer = setTimeout(look, everyMs);
  };

  if (!stopped) timer = setTimeout(look, everyMs);

  return {
    claim,
    async release() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    report() {
      return { handedBack, yours, ours: [...ours], watching: !stopped };
    },
  };
}

/**
 * One sentence for the summary, or nothing when there is nothing worth saying.
 *
 * A person who was not interrupted should not be told about the machinery that did not
 * interrupt them. This only speaks when it actually did something.
 *
 * @param {GuardReport} report
 * @returns {string|null}
 */
export function describeGuard(report) {
  if (!report || report.handedBack === 0) return null;
  const times = report.handedBack === 1 ? 'once' : `${report.handedBack} times`;
  const back = report.yours ? ` to ${report.yours}` : '';
  return `Something the check opened came to the front ${times} and the screen was handed straight back${back}.`;
}
