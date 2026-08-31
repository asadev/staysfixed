/**
 * Which iPhone the simulator is asked for, and why the answer used to be the wrong one.
 *
 * This is a regression guard around one measured failure. On 2026-08-31, on a Mac with
 * Xcode, an iOS 27.0 runtime and a built app all sitting there ready, `prepare` came back
 * with "a simulator called staysfixed-ios could not be made" and nothing else. The whole
 * iPhone surface was dark and the message read like the Mac was broken.
 *
 * It was not. `simctl list devicetypes` prints the NEWEST iPhone first and the oldest last,
 * and the code took the last phone in that list — so it asked for an iPhone 6s on iOS 27.0.
 * Apple refuses that pairing outright and says so with a number and no words:
 * `SimError 403`, empty message. One attempt meant one number and no way to tell that the
 * pairing was the problem.
 *
 * Two things changed and both are guarded here: the newest phone is asked for first, and
 * every other one is handed back behind it so a refusal can try the next instead of giving
 * up on the platform.
 *
 * Nothing here needs Xcode, a simulator or a Mac. The list is a fixture, taken verbatim from
 * the machine where this happened.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { phoneKindsToTry } from '../../src/v2/adapters/ios-driver.js';

/**
 * The head and the tail of what this Mac's `simctl list devicetypes` actually printed on
 * 2026-08-31, in the order it printed them. Newest first, oldest last.
 */
const AS_APPLE_LISTS_THEM = [
  { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', name: 'iPhone 17 Pro' },
  { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max', name: 'iPhone 17 Pro Max' },
  { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17e', name: 'iPhone 17e' },
  { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-Air', name: 'iPhone Air' },
  { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', name: 'iPhone 17' },
  { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro', name: 'iPhone 16 Pro' },
  { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16', name: 'iPhone 16' },
  { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-13-mini', name: 'iPhone 13 mini' },
  { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE--2nd-generation-', name: 'iPhone SE (2nd generation)' },
  { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-8', name: 'iPhone 8' },
  { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-6s', name: 'iPhone 6s' },
];

describe('choosing a kind of iPhone to make', () => {
  test('the newest phone is asked for first, not the oldest', () => {
    const order = phoneKindsToTry(AS_APPLE_LISTS_THEM);
    assert.equal(order[0].label, 'iPhone 17 Pro', 'the first thing asked for must be a phone this year\'s iOS actually runs on');
    assert.notEqual(order[0].label, 'iPhone 6s', 'this is the exact ask that came back as SimError 403 and left the platform dark');
  });

  test('every other phone is behind it, so a refusal can try the next one', () => {
    const order = phoneKindsToTry(AS_APPLE_LISTS_THEM);
    assert.equal(order.length, AS_APPLE_LISTS_THEM.length, 'nothing may be dropped: an old Mac with an old runtime needs the old phones');
    assert.equal(new Set(order.map((o) => o.id)).size, order.length, 'no phone may be tried twice — a refusal would then be counted twice as well');
    // The awkward shapes — Plus, Max, mini, e, SE — go BEHIND every plain phone rather than
    // being thrown away. They are still real hardware and an old Mac may have nothing else.
    assert.deepEqual(
      order.map((o) => o.label).slice(-5),
      ['iPhone 17 Pro Max', 'iPhone 17e', 'iPhone Air', 'iPhone 13 mini', 'iPhone SE (2nd generation)'],
      'the awkward shapes should come last, in the order Apple listed them, and none should be missing',
    );
  });

  test('a plain phone is preferred to a Plus, a Max, a mini or an e', () => {
    const order = phoneKindsToTry(AS_APPLE_LISTS_THEM).map((o) => o.label);
    assert.ok(order.indexOf('iPhone 16') < order.indexOf('iPhone 17 Pro Max'), 'a plain phone should come before an awkward one from a newer year');
    assert.ok(order.indexOf('iPhone 8') < order.indexOf('iPhone 13 mini'), 'even an old plain phone comes before a newer awkward one — the loop tries them all anyway');
    assert.ok(order.indexOf('iPhone 17 Pro') < order.indexOf('iPhone 16 Pro'), 'within the plain phones the newest still comes first');
  });

  test('a Mac with no iPhone simulator at all gets an empty list, not a wrong guess', () => {
    assert.deepEqual(phoneKindsToTry([]), []);
    assert.deepEqual(
      phoneKindsToTry([{ identifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-10-46mm', name: 'Apple Watch Series 10' }]),
      [],
      'a watch is not a phone, and asking for one produces a failure nobody can read',
    );
  });
});
