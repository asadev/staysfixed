/**
 * Starting and stopping the product's own server.
 *
 * A start command is run through a shell, because that is what people write: `npm run dev`,
 * `sh dev.sh`, `poetry run uvicorn ...`. So the thing that is spawned is the SHELL, and the
 * server is its child — often its grandchild, since `npm run dev` is npm, which runs next,
 * which runs node.
 *
 * Killing the shell therefore does not kill the server. And because the shell's stdout and
 * stderr are pipes, every survivor inherits the writing end of them — so the pipes never
 * close, this process's event loop never empties, and `staysfixed check` prints its whole
 * answer and then hangs for ever at nothing per cent of a CPU. Measured on 2026-08-30 on a
 * start command that spawns its server and waits, which is the shape `npm run dev` has: the
 * verdict appeared in about thirty seconds and the command never returned.
 *
 * So the shell is started as its own process GROUP and the whole group is signalled. And
 * after that, the pipes are torn down here rather than trusted to close, because a survivor
 * this file did not start — a stray `node` somebody's dev server left behind — must not be
 * able to hold a finished check open.
 */

import { spawn } from 'node:child_process';

import { stopTree, OWN_PROCESS_GROUP } from '../../core/stop-tree.js';

/**
 * Start the product, in a group of its own.
 *
 * @param {string} command
 * @param {{cwd: string, env: any, stdio?: any}} opts
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnServer(command, opts) {
  return spawn(String(command), {
    shell: true,
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
    // The whole point. Windows has no process groups of this kind, and `detached` there means
    // a console window of its own instead — so Windows is left alone at spawn time and gets
    // its whole tree stopped by `stopTree` below, which walks the children itself.
    detached: OWN_PROCESS_GROUP,
  });
}

/**
 * Stop it, and everything it started.
 *
 * @param {import('node:child_process').ChildProcess|null|undefined} child
 * @param {{graceMs?: number}} [opts]
 * @returns {Promise<void>}
 */
export async function stopServer(child, opts = {}) {
  if (!child) return;
  const pid = child.pid;
  const graceMs = opts.graceMs ?? 500;

  /**
   * @param {'SIGTERM'|'SIGKILL'} signal
   */
  const tellTheGroup = (signal) => {
    // The group on Linux and a Mac, the tree of children on Windows. Killing only the shell
    // on Windows left the server running and holding the folder it was started in: measured
    // on a real Windows 11 machine on 2026-08-31, where the whole of `waiting.test.js` failed
    // on being unable to delete its own scratch folder afterwards, because the servers it had
    // asked to stop were all still there.
    stopTree(pid, signal, { child });
  };

  if (child.exitCode === null && child.signalCode === null) {
    tellTheGroup('SIGTERM');
    await new Promise((done) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        done(undefined);
      };
      child.once('exit', finish);
      const timer = setTimeout(finish, graceMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    if (child.exitCode === null && child.signalCode === null) tellTheGroup('SIGKILL');
  }

  // And never let what it left behind hold this process open.
  for (const stream of [child.stdout, child.stderr, child.stdin]) {
    try {
      stream?.destroy();
    } catch {
      // Nothing to close.
    }
  }
  try {
    child.unref();
  } catch {
    // Not every child can be unreferenced. It has been signalled either way.
  }
}
