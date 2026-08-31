/**
 * Stopping a command AND everything that command started — on every operating system.
 *
 * Almost every command this tool runs is really a shell: `npm test`, `npm run dev`,
 * `poetry run uvicorn ...`. The shell then starts the real program, which often starts
 * another one. So the process this tool holds a handle to is the shell, and the work is
 * happening in its children and grandchildren.
 *
 * Killing the shell is not killing the work. On Linux the children carry on with a new
 * parent; on a Mac they usually die with the shell, which is exactly why this was invisible
 * for so long. The answer there is to put the shell and everything it starts into one
 * process GROUP and signal the group, which is what a negative process id means.
 *
 * WINDOWS HAS NO PROCESS GROUPS OF THAT KIND, and the code here used to say so and give up —
 * it killed the one process it knew about and hoped. It does not work: measured on a real
 * Windows 11 machine on 2026-08-31, a command the guard had already given up on kept running,
 * finished its work and wrote its file, because only `cmd.exe` had been killed and the `node`
 * underneath it never noticed. Windows does have an answer, it is just spelled differently:
 * `taskkill /T` walks the tree of children and stops all of them. This file is the one place
 * that difference is written down, so no caller has to remember it again.
 */

import { spawnSync } from 'node:child_process';

/** Windows spells "stop this and everything under it" as a command, not a signal. */
const TASKKILL = 'taskkill';

/**
 * Stop a process and every process it started.
 *
 * Safe to call more than once, safe to call on something already gone, and safe to call from
 * an exit handler — nothing here is asynchronous, because a process on its way out has no
 * event loop left to wait on.
 *
 * @param {number|null|undefined} pid   The process this tool started.
 * @param {'SIGTERM'|'SIGKILL'} signal  SIGTERM asks; SIGKILL insists.
 * @param {{child?: import('node:child_process').ChildProcess|null}} [opts]
 *        The handle, when the caller has one. It is the fallback if the tree walk fails.
 * @returns {boolean} true when something was asked to stop, false when there was nothing to ask.
 */
export function stopTree(pid, signal, opts = {}) {
  const child = opts.child ?? null;
  if (!pid) {
    if (!child) return false;
    return tryKill(child, signal);
  }

  if (process.platform === 'win32') {
    // `/T` takes the children, `/F` insists — and on Windows BOTH are always used, including
    // for the polite SIGTERM. There is no polite stop for a console program there: `taskkill`
    // without `/F` sends a window a close message, which `node` has no window to receive, so
    // it refuses with "this process can only be terminated forcefully" and nothing stops.
    //
    // Nothing is lost by that, because Node's own `child.kill('SIGTERM')` on Windows is
    // already an outright TerminateProcess — the ONLY difference this line makes is that the
    // children go too. Measured on a real Windows 11 machine on 2026-08-31: the first version
    // of this file tried the polite form, watched it refuse, and fell back to killing the
    // shell alone — which left the server running AND made it look like it had stopped,
    // because the handle the caller was watching had gone. The scratch folder could then not
    // be deleted, and the whole of `waiting.test.js` failed on it.
    const ran = spawnSync(TASKKILL, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
    if (ran.status === 0) return true;
    // taskkill was not there, or the process had already finished — which is the outcome the
    // caller wanted anyway. Stopping the one process this tool definitely knows about is
    // weaker than stopping the tree, and it is a great deal better than leaving it running.
    return child ? tryKill(child, signal) : false;
  }

  try {
    // A negative process id is the GROUP. This is the line that takes the watchers,
    // bundlers and servers down with the shell that started them.
    process.kill(-pid, signal);
    return true;
  } catch {
    // No group — which happens when the caller did not start it detached — or it is already
    // gone. Either way, ask the one process we know about.
    if (child) return tryKill(child, signal);
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {'SIGTERM'|'SIGKILL'} signal
 * @returns {boolean}
 */
function tryKill(child, signal) {
  try {
    return child.kill(signal);
  } catch {
    // Already gone, which is the outcome wanted.
    return false;
  }
}

/**
 * Should a command be started in a process group of its own?
 *
 * Only where process groups exist. On Windows `detached: true` does something else entirely —
 * it gives the child its own console WINDOW, which flashes up on the person's screen in the
 * middle of a check and is never what this tool wants. Windows gets its tree walk from
 * `stopTree` instead, which needs nothing at spawn time.
 */
export const OWN_PROCESS_GROUP = process.platform !== 'win32';
