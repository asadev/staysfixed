/**
 * The watch window, from the check's point of view.
 *
 * A check describes itself into an event stream and carries on. This subscribes to that
 * stream, opens a window beside whatever is being checked, and forwards everything to it. It
 * has no other effect on the check: it takes nothing away from it, it holds nothing up, and
 * when the window cannot open the check does not notice.
 *
 * THREE THINGS HERE ARE NOT OBVIOUS, and all three are the owner's one requirement said in
 * different places:
 *
 *   "That window should come up... But once we minimise it, it should keep working headless
 *    in the background. Not invisible. It should not keep bringing itself to the front."
 *
 * ONE. The window is opened WITHOUT being waited for. `attachWatcher` hands back a watcher
 * immediately and the browser starts behind it, so the check begins in the same millisecond it
 * would have begun with no window at all. That is safe only because the event stream hands a
 * late listener everything that already happened, in order — so a window that took two seconds
 * to open still draws the two seconds it missed.
 *
 * TWO. The ENGINE works everything out and the PANEL only draws. Every sentence and every
 * number a person reads is made here, on this side, by `events.js`, and pushed over finished.
 * Nothing in the page is computed on a clock of its own. That is what makes minimising the
 * window harmless: a browser slows a hidden page right down, and a page that is only drawing
 * what it was handed loses nothing by being slow. It catches up the moment it is looked at.
 *
 * THREE. Nothing here ever waits on the window. `push` hands back nothing, so there is no
 * promise to await by accident; every send has a hard timeout on it in `window.js`; and
 * stopping the watcher never blocks on a window that has stopped answering.
 *
 * The division of labour across these four files: `events.js` decides WHAT to say, `panel.js`
 * decides how it LOOKS, `window.js` owns the window it is said in, and this file is the seam
 * between all of that and a check.
 */

import { detail } from '../../core/log.js';
import { messageOf } from '../../core/errors.js';
import { openPanel } from './window.js';
import { attachPanel, panelPlan } from './events.js';

/** @typedef {import('../types.js').Journey} Journey */
/** @typedef {import('./events.js').PanelPlanShape} PanelPlan */
/** @typedef {import('./events.js').PanelReference} PanelReference */
/** @typedef {import('./window.js').Panel} Panel */
/** @typedef {import('./window.js').BesideThis} BesideThis */
/** @typedef {import('./window.js').PanelHealth} PanelHealth */
/** @typedef {import('./window.js').PanelBrowser} PanelBrowser */

/** Panel width when nobody says otherwise. */
const DEFAULT_WIDTH = 480;

/** How long `snapTo` will wait for a window that is still opening before shrugging. */
const SNAP_WAIT_MS = 6000;

/**
 * How long stopping will wait for a window that is STILL opening, when the window is going
 * to be closed anyway.
 *
 * Short, and it has to be. A check that finishes in two seconds on a machine where a browser
 * takes twenty to start would otherwise sit there at the end, done, with nothing to say,
 * waiting on a window nobody is going to read. So stopping calls the opening off and gives it
 * a moment to tidy up; a window that arrives after that closes itself, because the opening
 * sequence already knows it was abandoned.
 */
const STOP_WAIT_MS = 1500;

/**
 * How long stopping will wait for a window that is still opening and is going to be LEFT UP.
 *
 * A different situation with the opposite answer, and getting the two confused is what made
 * `--watch` show nothing at all on anything that finishes quickly. A browser takes two or
 * three seconds to start; a check on a command-line product takes one. Under the short wait
 * the run reached the end first, called the window off, and a person who explicitly asked to
 * watch got no window and no result — every time, for the fastest and most common case.
 *
 * So when the window is going to stay up, the end of the check waits for it. The check itself
 * is long over by then: nothing is being held up except the moment the terminal comes back,
 * and the person asked for a window, so a window is what they get — with the whole run
 * already drawn on it, because a late listener is handed everything it missed.
 */
const LATE_WINDOW_MS = 25_000;

/**
 * Anything with the two halves of an event stream on it.
 *
 * Written structurally rather than as the engine's own type so this can be handed a real
 * check's stream, a stub in a test, or whatever the stream grows into next, without any of
 * them having to import each other.
 *
 * @typedef {object} Watchable
 * @property {(listener: (event: any) => void) => () => void} on
 */

/**
 * What the panel is told to do.
 *
 * The shared `WatchOptions` shape already carries every one of these, `snap` included, so
 * this is a name for it rather than an extension of it. It used to add `snap` back on top;
 * that stopped being true when the shared shape learned about it, and an intersection that
 * adds nothing is a thing to read twice and understand once.
 *
 * @typedef {import('../../types.js').WatchOptions} PanelOptions
 */

/**
 * @typedef {object} AttachOptions
 * @property {string} [product]       One repository can build five. This names the one being checked.
 * @property {string} [project]       The folder it is being run in.
 * @property {Journey[]} [journeys]   Every journey about to be walked, in order.
 * @property {PanelReference} [reference]  What it is being compared against, already in words.
 * @property {PanelPlan} [plan]       The finished plan, when a caller has built one itself.
 * @property {PanelOptions} [watch]
 * @property {string} [dir]           Where to remember the window position. The project's own folder.
 * @property {{width: number, height: number}} [appViewport]
 * @property {(browser: PanelBrowser) => void} [onOpen]
 *                                    Told once, when the window really is up, which browser
 *                                    it opened in and whether that browser belongs to the
 *                                    person. Nothing can know this in advance: the window is
 *                                    opened in the background and the browser is chosen while
 *                                    it opens. Anything that has to treat the panel's window
 *                                    as the tool's own — the screen guard does — has to be
 *                                    told rather than ask.
 */

/**
 * A check's handle on its window.
 *
 * `snapTo` is how the check introduces the thing being observed once it is up. It is safe to
 * call when there is no panel, when the panel cannot move windows, when the panel is still
 * opening, and when the person asked for no snapping: in every one of those cases it does
 * nothing and costs nothing.
 *
 * `health` is there so the claim this whole file makes — that the window never held the check
 * up — has a number behind it rather than being taken on trust.
 *
 * `browser` names what the window actually opened in, and whether that browser belongs to
 * the person rather than to the tool. Anything that decides what "ours" means on this screen
 * has to read it: a window in the person's own browser is not ours to push around.
 *
 * @typedef {object} Watcher
 * @property {() => Promise<void>} stop
 * @property {(beside: BesideThis) => Promise<void>} snapTo
 * @property {() => PanelHealth|null} health
 * @property {() => boolean} open   Is there a window right now.
 * @property {() => PanelBrowser|null} browser
 */

/**
 * Wait for something, but not for long, and never mind if it does not arrive.
 *
 * The whole of "stopping never blocks on a window", in five lines. The promise itself carries
 * on — nothing here can cancel it, and it does not need to, because whatever it eventually
 * produces knows it was stopped and puts itself away.
 *
 * @template T
 * @param {Promise<T>} work
 * @param {number} ms
 * @returns {Promise<T|null>}
 */
function soon(work, ms) {
  /** @type {Promise<null>} */
  const giveUp = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    // Never hold the program open waiting for a window.
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([work.catch(() => null), giveUp]);
}

/**
 * A watcher that is not watching anything.
 *
 * Handed back whenever there is no window — switched off, no browser, a page that would not
 * build — so every caller has the same shape to stop, whatever happened.
 *
 * @returns {Watcher}
 */
function noWatcher() {
  return {
    stop: async () => {},
    snapTo: async () => {},
    health: () => null,
    open: () => false,
    browser: () => null,
  };
}

/**
 * The opening plan: what the window draws before anything has happened.
 *
 * A window that opens empty and fills up looks broken for the first few seconds, so it is
 * given the product, the surfaces in play and every journey it is about to walk, in order,
 * from the moment it appears.
 *
 * @param {AttachOptions} opts
 * @returns {PanelPlan}
 */
function planFor(opts) {
  if (opts.plan) return opts.plan;
  return panelPlan({
    ...(opts.product ? { product: opts.product } : {}),
    ...(opts.project ? { project: opts.project } : {}),
    ...(opts.journeys ? { journeys: opts.journeys } : {}),
    ...(opts.reference ? { reference: opts.reference } : {}),
  });
}

/**
 * Open a window and point it at a check.
 *
 * Never throws, and never waits for the window. Every way this can go wrong ends the same way:
 * a line of detail, a watcher that does nothing, and a check that carries on at full speed.
 *
 * @param {Watchable} events
 * @param {AttachOptions} [opts]
 * @returns {Promise<Watcher>}
 */
export async function attachWatcher(events, opts = {}) {
  const watch = opts.watch ?? {};
  if (watch.enabled === false) return noWatcher();
  if (!events || typeof events.on !== 'function') return noWatcher();

  const plan = { ...planFor(opts), theme: watch.theme ?? 'dark' };

  /** @type {Panel|null} */
  let panel = null;
  /** @type {(() => void)|null} */
  let unsubscribe = null;
  // The check is over. Nothing new will be said.
  let stopped = false;
  // ...and the window is not wanted at all, so one that arrives late puts itself away.
  // Kept apart from `stopped` on purpose: a window that is going to be left up is still
  // wanted after the check has finished, because the finished result is what it is for.
  let abandoned = false;
  // How stopping reaches a window that has not finished opening. Every wait inside `openPanel`
  // watches this, so calling it off ends them all at once instead of one timeout at a time.
  const givingUp = new AbortController();

  // A window that will be closed at the end is not worth waiting for; a window that will be
  // left standing with the result on it is the whole reason somebody typed --watch.
  const leaveItUp = watch.keepOpen !== false;

  /**
   * Start the window and, when it is up, start feeding it.
   *
   * Nothing awaits this. Everything that can go wrong inside it ends with no panel and a check
   * that never knew there was going to be one.
   *
   * @type {Promise<Panel|null>}
   */
  const opening = openPanel({
    plan,
    watch,
    signal: givingUp.signal,
    ...(opts.dir ? { dir: opts.dir } : {}),
    ...(opts.appViewport ? { appViewport: opts.appViewport } : {}),
  })
    .then((open) => {
      if (!open) return null;
      if (abandoned) {
        // Given up on while it was still opening. Close it rather than leave a window nobody
        // asked for standing on somebody's screen.
        void open.close().catch(() => {});
        return null;
      }
      panel = open;
      if (opts.onOpen) {
        try {
          opts.onOpen(open.browser);
        } catch (e) {
          // Somebody wanting to know is never allowed to be the reason a window fails.
          detail(`The watch window opened, and telling the check about it went wrong. ${messageOf(e)}`);
        }
      }
      // Everything that already happened arrives here first, in order, before the first live
      // event does — which is the whole reason opening the window in the background is safe.
      //
      // `push` hands back nothing and swallows everything, so there is nothing in this
      // callback that could hold a check up even by accident.
      unsubscribe = attachPanel(events, (drawn) => open.push(drawn), {
        plan,
        onProblem: (problem) => {
          detail(`The watch window refused an update. The check is unaffected. ${messageOf(problem)}`);
        },
      });
      return open;
    })
    .catch((e) => {
      // openPanel reports its own trouble and hands back null; this is only here for whatever
      // it could not have seen coming.
      detail(`The watch window could not open, so this check has no live view. ${messageOf(e)}`);
      return null;
    });

  /**
   * Wait a little for a window that is still opening, and give up cheerfully.
   *
   * Used only by `snapTo`, which happens once, early, at the one moment the window and the
   * thing being checked are both about to exist. Everything else in here refuses to wait at all.
   *
   * @returns {Promise<Panel|null>}
   */
  async function panelSoon() {
    if (panel) return panel;
    return await soon(opening, SNAP_WAIT_MS);
  }

  const maySnap = watch.snap !== false;

  /** @type {Promise<void>|null} */
  let stopping = null;

  return {
    stop: () => {
      stopping ??= (async () => {
        stopped = true;

        if (!panel && !leaveItUp) {
          // It is still opening and it would only be closed again. Call it off, and give it a
          // moment to tidy up rather than waiting it out. A window that arrives after this
          // finds itself abandoned and closes itself.
          abandoned = true;
          givingUp.abort();
        } else if (!panel) {
          detail('The check finished before the watch window had opened. Waiting for it, because the result is what it is for.');
        }

        // Deliberately BEFORE anything stops listening. A window that opens now subscribes as
        // it lands and is handed everything that already happened, in order, including the
        // verdict — which is how a window that missed the whole run still shows all of it.
        const open = panel ?? (await soon(opening, leaveItUp ? LATE_WINDOW_MS : STOP_WAIT_MS));

        try {
          if (unsubscribe) unsubscribe();
        } catch {
          // Already gone. Nothing left to stop listening to.
        }

        if (open) {
          await open.close().catch(() => {});
        } else {
          // It never came. Nothing should be left starting up behind a finished check.
          abandoned = true;
          givingUp.abort();
        }
      })();
      return stopping;
    },

    snapTo: async (beside) => {
      if (!maySnap) return;
      // The check is over. Something that only just announced itself is something on its
      // way out, and dragging windows around at the end of a run is worse than not
      // arranging them at all.
      if (stopped) return;
      try {
        const open = await panelSoon();
        if (open) await open.snapTo(beside);
      } catch (e) {
        // Where two windows sit is a nicety. Losing it must never cost a check, and it is not
        // worth a warning in the middle of a clean one.
        detail(`The panel could not put itself beside what is being checked. ${messageOf(e)}`);
      }
    },

    health: () => (panel ? panel.health() : null),
    open: () => panel !== null,
    browser: () => (panel ? panel.browser : null),
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * What the command line hands over. Anything the person did not type is left out, so the
 * settings file still gets a say.
 *
 * @typedef {object} WatchFlags
 * @property {boolean} [enabled]
 * @property {'left'|'right'} [side]
 * @property {number} [width]
 * @property {number} [height]
 * @property {boolean} [keepOpen]
 * @property {boolean} [foreground]
 * @property {boolean} [snap]
 * @property {'dark'|'light'|'system'} [theme]
 */

/**
 * Settle what the panel should do: the settings file first, then anything typed on the command
 * line, then the defaults.
 *
 * `--watch` can only ever turn the panel on. A person who did not type it has not said no to
 * it — they have said nothing — so it never switches off a panel the settings file asked for.
 *
 * @param {{watch?: import('../../types.js').WatchOptions|boolean}|null} [config]
 * @param {WatchFlags|null} [cli]
 * @returns {PanelOptions}
 */
export function watchOptionsFrom(config, cli) {
  const raw = config?.watch;
  // `watch: true` in a settings file is the short way of saying `watch: {enabled: true}`,
  // and anything that is not an object at all says nothing.
  const settings = /** @type {PanelOptions} */ (
    raw === true ? { enabled: true } : raw && typeof raw === 'object' ? raw : {}
  );
  const flags = cli ?? {};

  const width = firstNumber(flags.width, settings.width) ?? DEFAULT_WIDTH;
  const height = firstNumber(flags.height, settings.height);
  const side = flags.side ?? settings.side ?? 'right';
  const theme = flags.theme ?? settings.theme;

  /** @type {PanelOptions} */
  const merged = {
    enabled: flags.enabled === true || settings.enabled === true,
    width,
    side: side === 'left' ? 'left' : 'right',
    keepOpen: firstBoolean(flags.keepOpen, settings.keepOpen) ?? true,
    // Never, unless somebody explicitly asks. This is the whole complaint: it must not keep
    // bringing itself to the front.
    foreground: firstBoolean(flags.foreground, settings.foreground) ?? false,
    // On by default: the point of the panel is that it reads as a side panel of the thing it
    // is checking, and it cannot do that sitting somewhere else on the screen.
    snap: firstBoolean(flags.snap, settings.snap) ?? true,
    // Dark unless somebody asks otherwise. The panel opens on a brand new browser profile, and
    // a fresh profile insists the computer is in light mode however it is really set, so this
    // is stated rather than detected.
    theme: theme === 'light' || theme === 'system' ? theme : 'dark',
  };
  // Left out rather than guessed: with no height the panel is as tall as whatever it is
  // standing next to.
  if (height !== undefined) merged.height = height;
  return merged;
}

/**
 * @param {...unknown} values
 * @returns {number|undefined}
 */
function firstNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return undefined;
}

/**
 * @param {...unknown} values
 * @returns {boolean|undefined}
 */
function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}
