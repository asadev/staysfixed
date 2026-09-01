/**
 * A modal box must not be able to stall a run in silence.
 *
 * Recorded by the owner on 2026-09-01. A four-minute check spent its last two minutes frozen
 * at "23 of 27 journeys" behind a macOS alert:
 *
 *     Keychain Not Found
 *     A keychain cannot be found to store "Terminal Deck Key."
 *     [?]                                 [Cancel]  [Reset To Defaults]
 *
 * The run finished and said one journey had no answer. It never said a box was up. That is the
 * whole defect: the cause was on screen and the report did not contain it.
 *
 * These tests hold four things, and the middle two are the ones that matter most, because they
 * are about what this code is allowed to do to somebody's machine.
 *
 *  1. A dialog belonging to something the run started is closed, and recorded.
 *  2. "Reset To Defaults" is NEVER pressed. On the real alert it sat next to Cancel and it was
 *     the DEFAULT button — resetting a keychain is a change to the machine, and an unattended
 *     check may not make it on anybody's behalf.
 *  3. A dialog with nothing safe on it is LEFT ALONE and reported, rather than guessed at.
 *  4. A dialog belonging to anything else is not touched at all. His own apps ask him things
 *     all day and none of it is this tool's business.
 *
 * The looking and the pressing are injected, for the same reason the screen guard injects
 * them: the decisions are the part that has to be right, and they are otherwise unreachable
 * behind two osascript calls that answer differently on every machine and not at all on most.
 * The finder itself was proved separately against a real alert put up on this Mac — it read
 * back the title, both buttons and the sentence, and pressed Cancel.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { watchForDialogs, describeDialogs, mayPress, safeButton } from '../../src/v2/watch/dialogs.js';

/** The alert from the recording, exactly as the finder reads it back. */
const KEYCHAIN = {
  app: 'Terminal Deck',
  title: 'Keychain Not Found',
  says: 'A keychain cannot be found to store "Terminal Deck Key."',
  buttons: ['Reset To Defaults', 'Cancel'],
};

/**
 * @param {any[]} up what is on screen
 * @returns {{watcher: any, pressed: {app: string, button: string}[]}}
 */
function watcherOver(up) {
  /** @type {{app: string, button: string}[]} */
  const pressed = [];
  const watcher = watchForDialogs({
    claims: ['Terminal Deck'],
    everyMs: 5000,
    elapsed: () => 42,
    look: async (apps) => up.filter((d) => apps.includes(d.app)),
    press: async (app, button) => {
      pressed.push({ app, button });
      return true;
    },
  });
  return { watcher, pressed };
}

describe('a modal box cannot stall a run in silence', () => {
  test('the keychain alert is closed with Cancel and written down', async () => {
    const { watcher, pressed } = watcherOver([KEYCHAIN]);
    await watcher.sweepNow();
    await watcher.stop();

    assert.deepEqual(pressed, [{ app: 'Terminal Deck', button: 'Cancel' }]);
    const seen = watcher.report();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].closed, 'Cancel');
    assert.match(seen[0].says, /keychain cannot be found/);
    // And the run has a sentence to print, naming what happened and what it may have cost.
    const said = describeDialogs(seen);
    assert.match(String(said), /closed with "Cancel"/);
    assert.match(String(said), /may have had no answer/);
  });

  test('"Reset To Defaults" is never pressed, even as the default button', async () => {
    assert.equal(mayPress('Reset To Defaults'), false);
    assert.equal(safeButton(['Reset To Defaults']), null);
    const { watcher, pressed } = watcherOver([KEYCHAIN]);
    await watcher.sweepNow();
    await watcher.stop();
    assert.ok(
      !pressed.some((p) => /reset/i.test(p.button)),
      `a button that changes the machine was pressed: ${JSON.stringify(pressed)}`,
    );
  });

  test('nothing safe on it means leave it and say so', async () => {
    const permission = { app: 'Terminal Deck', title: 'Microphone', says: 'wants to use the microphone', buttons: ['Allow', 'Always Allow'] };
    const { watcher, pressed } = watcherOver([permission]);
    await watcher.sweepNow();
    await watcher.stop();

    assert.deepEqual(pressed, [], 'it pressed something on a dialog with no safe answer');
    const seen = watcher.report();
    assert.equal(seen[0].closed, null);
    assert.match(String(seen[0].why), /nothing on it is safe/);
    assert.match(String(describeDialogs(seen)), /left alone/);
  });

  test("somebody else's dialog is not touched", async () => {
    const his = { app: 'Mail', title: 'Delete', says: 'Delete this mailbox?', buttons: ['Cancel', 'Delete'] };
    const { watcher, pressed } = watcherOver([his]);
    await watcher.sweepNow();
    await watcher.stop();

    assert.deepEqual(pressed, [], 'it reached into an application this run never started');
    assert.deepEqual(watcher.report(), [], 'it recorded a dialog that was none of its business');
  });

  test('one box sitting there for a minute is one line, not sixty', async () => {
    const { watcher, pressed } = watcherOver([KEYCHAIN]);
    await watcher.sweepNow();
    await watcher.sweepNow();
    await watcher.sweepNow();
    await watcher.stop();
    assert.equal(watcher.report().length, 1);
    assert.equal(pressed.length, 1);
  });

  test('no dialogs means no sentence at all', () => {
    assert.equal(describeDialogs([]), null);
  });
});
