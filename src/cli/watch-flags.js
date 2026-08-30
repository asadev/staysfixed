/**
 * Reading the --watch flags off a command line.
 *
 * This lives on its own, and not in `src/cli/index.js` where it started, because both
 * halves of the tool need it and the import went in a circle: version 1's command table
 * imports version 2's commands, and version 2's command file imported this back out of
 * version 1's table. That worked only while the modules happened to load in a helpful
 * order — the day another import was added to version 2, the whole command line failed
 * with "cannot access V2_COMMANDS before initialization" and nothing ran at all.
 *
 * A shared thing that both sides need belongs to neither of them.
 */

import { StaysFixedError } from '../core/errors.js';

/**
 * Read the panel flags. Shared by `check` and `walk` so the two behave the same.
 * @param {import('./index.js').CliContext} ctx
 * @returns {import('./index.js').WatchFlags}
 */
export function watchFlags(ctx) {
  /** @type {import('./index.js').WatchFlags} */
  const flags = { enabled: ctx.bool('watch') };

  const side = ctx.str('watch-side');
  if (side !== undefined) {
    if (side !== 'left' && side !== 'right') {
      throw new StaysFixedError(`--watch-side has to be left or right, not "${side}".`, {
        hint: 'Write it as `--watch-side left` or `--watch-side right`.',
      });
    }
    flags.side = side;
  }

  const width = ctx.str('watch-width');
  if (width !== undefined) {
    const n = Number(width);
    // A panel narrower than this cannot show the before-and-after pictures side
    // by side, which is the only reason to open it.
    if (!Number.isFinite(n) || n < 240) {
      throw new StaysFixedError(`--watch-width has to be a number of pixels, 240 or more — I got "${width}".`, {
        hint: 'Write it as `--watch-width 520`.',
      });
    }
    flags.width = Math.round(n);
  }

  // Only mention these when they were actually typed, so --no-keep-open turns the
  // panel off at the end without a bare --watch turning it on against the settings.
  if (ctx.flags['keep-open'] !== undefined) flags.keepOpen = ctx.flags['keep-open'] === true;
  if (ctx.bool('watch-front')) flags.foreground = true;

  return flags;
}
