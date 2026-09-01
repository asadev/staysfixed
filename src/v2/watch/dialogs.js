/**
 * The system dialogs this tool causes, and what to do about them.
 *
 * ## What went wrong, 2026-09-01
 *
 * A real check on a real product ran for four minutes and spent the last two of them frozen.
 * The owner recorded it. On screen, over everything, was a macOS alert:
 *
 *     Keychain Not Found
 *     A keychain cannot be found to store "Terminal Deck Key."
 *     [?]                                 [Cancel]  [Reset To Defaults]
 *
 * The panel sat on "Walking ask the private channel voice:status to answer" at 23 of 27
 * journeys and never moved. When the run finally gave up it said only that one journey had no
 * answer. It never said WHY, and the why was a modal box waiting for a person who was not
 * going to be there — on a machine where nobody had been asked to sit and watch.
 *
 * ## Why this is the tool's problem and not the product's
 *
 * Every adapter here starts the thing under test in a THROWAWAY settings folder, on its own
 * ports, under its own name, so that a run can never touch the real install. That isolation is
 * the whole design, and a fresh settings folder is exactly the condition that makes an
 * application ask the operating system for something it has never been granted: a keychain, a
 * microphone, the Documents folder, permission to control another app. So these dialogs are a
 * NORMAL consequence of how this tool works. A tool that causes them and then hangs behind
 * them, silently, is broken in its own right.
 *
 * ## The three rules, and why each one is a rule
 *
 * ONLY OURS. A dialog is touched only when it belongs to an application this run started, and
 * the caller supplies that list — the same `ours` bookkeeping the screen guard keeps. His own
 * apps ask him things all day and none of it is any of this tool's business. Getting this
 * wrong would mean a background check silently answering a prompt in his email client.
 *
 * ONLY HARMLESS BUTTONS. The button pressed comes from a fixed list of ones that decline,
 * dismiss or close, and nothing else is ever pressed. On the very dialog that started this,
 * the other button was "Reset To Defaults" — on a keychain — which is a change to the machine
 * that no automated run may make on somebody's behalf. When there is no harmless button, the
 * dialog is left exactly as it is and reported instead. A tool that cannot act safely says so;
 * it does not guess.
 *
 * SAY IT HAPPENED. Every dialog seen is recorded with its words, whether it could be dismissed
 * or not, and the check reports it. "No answer for one journey" is a fact with no cause in it.
 * "No answer, because your app put up a box saying a keychain cannot be found, and I closed it"
 * is the same fact with the thing a person needs in order to act.
 *
 * Everything here is best effort and every failure is swallowed: no window server, no Apple
 * Events permission, a locked screen or a machine that is not a Mac all mean there are no
 * dialogs to clear, which is never a reason to fail a check.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { detail } from '../../core/log.js';

const run = promisify(execFile);

/** How often to look. Dialogs are not urgent — a person would take a second to notice one too. */
const LOOK_EVERY_MS = 1200;

/**
 * The only buttons this file will ever press.
 *
 * Every one of them declines, dismisses or closes. Nothing here grants anything, changes a
 * setting, deletes anything or agrees to anything. The list is deliberately short and
 * deliberately literal: a fuzzy match would eventually press "Allow" because it contained
 * "low", and the whole safety of this file is that it cannot.
 */
const SAFE_BUTTONS = [
  'Cancel',
  "Don't Allow",
  'Don’t Allow',
  'Deny',
  'Not Now',
  'Later',
  'Close',
  'Dismiss',
  'No',
  'Quit',
];

/**
 * Buttons that must never be pressed even if some future edit adds them above.
 *
 * A second, independent gate. `SAFE_BUTTONS` is the allow-list and this is the veto, and a
 * button has to get past both. It exists because the failure this file guards against is not
 * "the wrong button was pressed once" — it is "somebody widened the allow-list a year from now
 * and nobody noticed what it now includes".
 */
const NEVER_PRESS = [
  'reset',
  'allow',
  'delete',
  'erase',
  'remove',
  'ok',
  'yes',
  'continue',
  'agree',
  'accept',
  'grant',
  'always',
  'trust',
  'update',
  'install',
  'send',
  'share',
];

/**
 * @typedef {object} SeenDialog
 * @property {string} app        The application it belongs to.
 * @property {string} title      Its window title, when it has one.
 * @property {string} says       The text on it, joined into one line.
 * @property {string|null} closed The button pressed, or null when it was left alone.
 * @property {string|null} why    Why it was left alone, when it was.
 * @property {number} at         Milliseconds into the run.
 */

/**
 * Is this a button this file is allowed to press?
 *
 * @param {string} label
 * @returns {boolean}
 */
export function mayPress(label) {
  const name = String(label ?? '').trim();
  if (name.length === 0) return false;
  const lower = name.toLowerCase();
  // The veto runs first and on the whole label, so "Reset To Defaults" is refused before
  // anything else gets a chance to like the look of it.
  for (const banned of NEVER_PRESS) {
    if (lower.split(/[^a-z’']+/).includes(banned)) return false;
  }
  return SAFE_BUTTONS.some((safe) => safe.toLowerCase() === lower);
}

/**
 * Pick the button to press out of what a dialog offers.
 *
 * @param {string[]} labels
 * @returns {string|null}
 */
export function safeButton(labels) {
  const offered = (labels ?? []).map((l) => String(l ?? '').trim()).filter(Boolean);
  // In SAFE_BUTTONS order rather than in the dialog's order, so the answer does not depend on
  // how somebody laid their buttons out.
  for (const wanted of SAFE_BUTTONS) {
    const hit = offered.find((l) => l.toLowerCase() === wanted.toLowerCase() && mayPress(l));
    if (hit) return hit;
  }
  return null;
}

/**
 * Every modal box currently up, for the applications named.
 *
 * WHAT COUNTS AS A DIALOG, and this took measuring rather than guessing. The obvious test is
 * the window's subrole, and it is wrong: on this Mac an ordinary Terminal window, Activity
 * Monitor and System Settings all report `AXDialog`, the same value the real keychain alert
 * reports. A tool matching on that would go hunting for buttons to press on somebody's actual
 * work. The attribute that does separate them is **AXModal** — measured true on the alert and
 * false on all four of his open Terminal windows — which is also the honest definition of the
 * thing being fixed here: a box that blocks. Sheets are included because a sheet is modal to
 * the window it hangs off whatever it says about itself.
 *
 * One `osascript` call for the whole sweep. The output is one record per line, tab separated,
 * because parsing AppleScript's own list syntax is a worse idea than choosing a separator.
 *
 * @param {string[]} apps
 * @returns {Promise<{app: string, title: string, says: string, buttons: string[]}[]>}
 */
export async function dialogsUp(apps) {
  if (process.platform !== 'darwin' || !apps || apps.length === 0) return [];
  const list = '{' + apps.map((a) => JSON.stringify(String(a))).join(', ') + '}';
  const script = `
    set out to ""
    tell application "System Events"
      repeat with wanted in ${list}
        repeat with proc in (every application process whose name is (wanted as string))
          try
            repeat with win in (every window of proc)
              set isDialog to false
              try
                if (value of attribute "AXModal" of win) is true then set isDialog to true
              end try
              try
                if subrole of win is "AXSystemDialog" then set isDialog to true
              end try
              -- NOT "sheets". Inside a System Events tell block that word is an element name,
              -- so "set sheets to {}" is read as "set every sheet to {}" and throws -10006.
              -- The error was swallowed by the try around this loop and the whole sweep came
              -- back empty, which looked exactly like a machine with no dialogs on it.
              set sheetCount to 0
              set firstSheet to missing value
              try
                set theSheets to every sheet of win
                set sheetCount to (count of theSheets)
                if sheetCount > 0 then set firstSheet to item 1 of theSheets
              end try
              if (isDialog) or (sheetCount > 0) then
                set target to win
                if sheetCount > 0 then set target to firstSheet
                set theTitle to ""
                try
                  set theTitle to name of target as string
                end try
                set theText to ""
                try
                  repeat with t in (every static text of target)
                    set theText to theText & (value of t as string) & " "
                  end repeat
                end try
                set theButtons to ""
                try
                  repeat with b in (every button of target)
                    set theButtons to theButtons & (name of b as string) & "|"
                  end repeat
                end try
                set out to out & (name of proc as string) & tab & theTitle & tab & theText & tab & theButtons & linefeed
              end if
            end repeat
          end try
        end repeat
      end repeat
    end tell
    return out
  `;
  try {
    const { stdout } = await run('osascript', ['-e', script], { timeout: 6000 });
    return stdout
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [app = '', title = '', says = '', buttons = ''] = line.split('\t');
        return {
          app: app.trim(),
          title: title.trim(),
          says: says.replace(/\s+/g, ' ').trim(),
          buttons: buttons.split('|').map((b) => b.trim()).filter(Boolean),
        };
      })
      .filter((d) => d.app.length > 0);
  } catch {
    // No window server, no permission, a locked screen. There is nothing to clear.
    return [];
  }
}

/**
 * Press one button on one application's frontmost dialog.
 *
 * @param {string} app
 * @param {string} button
 * @returns {Promise<boolean>}
 */
export async function pressButton(app, button) {
  if (process.platform !== 'darwin') return false;
  if (!mayPress(button)) return false;
  const script = `
    tell application "System Events"
      tell (first application process whose name is ${JSON.stringify(app)})
        repeat with win in (every window of it)
          try
            set target to win
            try
              if (count of (every sheet of win)) > 0 then set target to item 1 of (every sheet of win)
            end try
            click (first button of target whose name is ${JSON.stringify(button)})
            return "pressed"
          end try
        end repeat
      end tell
    end tell
    return "no"
  `;
  try {
    const { stdout } = await run('osascript', ['-e', script], { timeout: 6000 });
    return stdout.trim() === 'pressed';
  } catch {
    return false;
  }
}

/**
 * @typedef {object} DialogWatcher
 * @property {(name: string) => void} claim    Name an application this run started.
 * @property {() => Promise<void>} stop        Stop watching. Safe to call twice.
 * @property {() => SeenDialog[]} report       Every dialog seen, in the order they appeared.
 * @property {() => Promise<void>} sweepNow    Look once, right now. For tests and for the end of a run.
 */

/**
 * Watch for modal boxes belonging to what this run started, close the harmless ones, and
 * remember all of them.
 *
 * `look` and `press` exist for the same reason the screen guard has them: the decisions here —
 * whose dialog it is, which button qualifies, what gets recorded when nothing can be pressed —
 * are the part that has to be right, and they are unreachable behind two `osascript` calls
 * that answer differently on every machine and not at all on most.
 *
 * @param {{claims?: string[], everyMs?: number, elapsed?: () => number, look?: (apps: string[]) => Promise<any[]>, press?: (app: string, button: string) => Promise<boolean>}} [opts]
 * @returns {DialogWatcher}
 */
export function watchForDialogs(opts = {}) {
  const everyMs = opts.everyMs ?? LOOK_EVERY_MS;
  const look = opts.look ?? dialogsUp;
  const press = opts.press ?? pressButton;
  const elapsed = opts.elapsed ?? (() => 0);

  /** @type {Set<string>} */
  const ours = new Set(opts.claims ?? []);
  /** @type {SeenDialog[]} */
  const seen = [];
  /** Dialogs already recorded, so one box sitting there for a minute is one line, not fifty. */
  const already = new Set();
  let stopped = process.platform !== 'darwin' && !opts.look;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;

  const sweep = async () => {
    if (stopped || ours.size === 0) return;
    let up = [];
    try {
      up = await look([...ours]);
    } catch {
      return;
    }
    for (const d of up ?? []) {
      const key = `${d.app} ${d.title} ${d.says}`;
      if (already.has(key)) continue;
      const button = safeButton(d.buttons ?? []);
      let closed = null;
      let why = null;
      if (button) {
        const done = await press(d.app, button).catch(() => false);
        if (done) closed = button;
        else why = `tried to press "${button}" and the click did not land`;
      } else {
        // Recorded, not guessed at. The offered buttons go into the reason so a person reading
        // the run knows exactly what they are being asked and why nothing was pressed.
        why =
          (d.buttons ?? []).length > 0
            ? `nothing on it is safe for a machine to press: ${(d.buttons ?? []).join(', ')}`
            : 'it offered no button this tool could find';
      }
      already.add(key);
      seen.push({ app: d.app, title: d.title ?? '', says: d.says ?? '', closed, why, at: elapsed() });
      detail(
        `A dialog from ${d.app} said "${d.says || d.title}" — ` +
          (closed ? `closed it with "${closed}".` : `left it alone: ${why}.`),
      );
    }
  };

  const tick = async () => {
    await sweep();
    if (!stopped) timer = setTimeout(tick, everyMs);
  };
  if (!stopped) timer = setTimeout(tick, everyMs);

  return {
    claim: (name) => {
      if (name) ours.add(name);
    },
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    report: () => seen.slice(),
    sweepNow: sweep,
  };
}

/**
 * One plain sentence about the dialogs a run met, or nothing when it met none.
 *
 * Written to be read after the verdict, by somebody who has just been told a journey had no
 * answer and needs to know why.
 *
 * @param {SeenDialog[]} seen
 * @returns {string|null}
 */
export function describeDialogs(seen) {
  const all = seen ?? [];
  if (all.length === 0) return null;
  const closed = all.filter((d) => d.closed);
  const left = all.filter((d) => !d.closed);
  const parts = [];
  if (closed.length > 0) {
    const first = closed[0];
    parts.push(
      `${closed.length === 1 ? 'A box' : `${closed.length} boxes`} came up from the app this run started and ` +
        `${closed.length === 1 ? 'was' : 'were'} closed with "${first.closed}"` +
        `${first.says ? `: "${first.says}"` : ''}. Anything walked while it was up may have had no answer for that reason.`,
    );
  }
  if (left.length > 0) {
    const first = left[0];
    parts.push(
      `${left.length === 1 ? 'A box is' : `${left.length} boxes are`} still up and ${left.length === 1 ? 'was' : 'were'} ` +
        `left alone, because ${first.why}${first.says ? `. It says: "${first.says}"` : ''}. ` +
        'Nothing here presses a button that could change your machine.',
    );
  }
  return parts.join(' ');
}
