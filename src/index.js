/**
 * Stays Fixed, as a library.
 *
 * `import { loadProject, runCheck } from 'staysfixed'` gives you exactly what
 * the `staysfixed` command and the MCP server use — there is no private path
 * that behaves differently. Everything here is plain ESM with no build step, so
 * you can also point Node straight at `src/index.js` from a checkout.
 */

/**
 * Find and read a project's config.
 * Everything else takes the `Project` this hands back.
 */
export { loadProject } from './core/config.js';

/**
 * The four nets.
 *
 * `runCheck` photographs the screens and runs the guards.
 * `captureOne` photographs a single screen — what an agent calls right after it
 * has changed something.
 * `runWalk` opens the real app, walks it, and leaves a page of photos behind.
 * `projectStatus` answers "what is set up here?" without opening anything.
 */
export { runCheck, captureOne, runWalk, projectStatus } from './run.js';

/**
 * Approving a new look.
 *
 * This is a person's job, always. It is exported so a review tool can offer the
 * button — never so an agent can press it on its own behalf.
 */
export { approveScreens } from './run.js';

/**
 * Guards: one check per bug that has already been fixed once.
 */
export { loadGuards } from './guard/load.js';

/**
 * Markers and tracing: pin a release that was known good, then find the commit
 * where a screen stopped looking like it.
 */
export { writeMarker, listMarkers } from './marker/mark.js';
export { traceScreens } from './marker/trace.js';

/**
 * The MCP server, so a coding agent can check its own work the moment it
 * finishes editing — under the same rules, including never approving anything.
 */
export { serveMcp } from './mcp/server.js';

/**
 * Errors and exit codes.
 * A `StaysFixedError` is a problem worth explaining to a person; anything else
 * is a bug in this tool.
 */
export { StaysFixedError, EXIT } from './core/errors.js';

/** The version of Stays Fixed you are running, read off its package.json. */
export { VERSION } from './run.js';
