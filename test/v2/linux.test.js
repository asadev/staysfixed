/**
 * The native-Linux adapter, driven with fixture data on a machine that is not Linux.
 *
 * Everything here is the parsing and the deciding, which is where this adapter can be wrong
 * quietly. The talking-to-a-real-desktop half was proved against a real Ubuntu 24.04 machine
 * on 2026-08-31 — two runs of one build with zero unstable addresses, then one changed control
 * reported as exactly one difference — and none of that can run in a suite on a Mac. What CAN
 * run here is every way this adapter could report a confident, wrong, comfortable answer, and
 * that is what these hold down.
 *
 * THE THREE THAT MATTER MOST, because each one was a real wrong answer during the build:
 *
 *   1. `gdbus` prints the first entry of an array differently from every later one. A pattern
 *      that expects them to match reads a desktop with six applications as a desktop with one
 *      — no error, no empty result, just a smaller number. There is a test with both shapes in
 *      the same string.
 *   2. A machine with no desktop still has a user session bus, and asking that bus for the
 *      accessibility bus STARTS an empty one. Reported as a desktop, that headless server
 *      looks exactly like an app with no controls, and the next run compares nothing against
 *      nothing and agrees. So the screen is asked about first, and there is a test that the
 *      question is even in that order.
 *   3. An empty tree, a tree that contradicts itself, and a tree that hit the size cap must
 *      each come back as a HOLE. A single one of them returning "no controls" as a value is
 *      the false all-clear this product exists to prevent.
 *
 * A NOTE ABOUT THE SOURCE-LEVEL CHECKS AT THE BOTTOM. Three tests in this repo have already
 * been failed by their own comments, because a test that bans a STRING cannot tell using a
 * thing from writing about it. The two here are written to that lesson: they match the call
 * form `dbus.connection.Connection(` with its bracket, which prose never has, and they read
 * the probe the adapter actually sends rather than the file it is written in — the file's own
 * comment explains both traps by name and would fail a lazier test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  COMPARED_STATES, MAX_TREE_NODES, PROBE_SENTINEL, RUN_MARKER, STATE_NAMES, gdbusProbeCommand,
  linuxProbeScript, parseGdbusAddress, parseGdbusChildren, probeCommand, readDesktopProbe,
  readProbeReply,
} from '../../src/v2/adapters/linux-driver.js';
import {
  complaintObservations, controlAddress, controlMeaning, describeLinuxDesktop, exitMeaning,
  fileObservations, findLinuxBuild, isChromiumToolkit, linuxAdapter, meaningFromTree,
  networkObservations, printedObservations, spawnedObservations,
} from '../../src/v2/adapters/linux.js';

/** A journey stub. Only the name and the sentence are ever read by the code under test. */
const journey = /** @type {import('../../src/v2/types.js').Journey} */ (/** @type {unknown} */ ({
  name: 'open-the-app',
  describe: 'open the Linux app and read every control it puts on screen',
}));

/**
 * One control, with everything filled in and anything the test cares about overridden.
 * @param {Partial<import('../../src/v2/adapters/linux.js').TreeNode>} [over]
 * @returns {import('../../src/v2/adapters/linux.js').TreeNode}
 */
function node(over = {}) {
  return {
    role: 'push button', name: 'Save', depth: 3, states: ['enabled', 'sensitive', 'showing', 'visible'],
    can: ['Click'], value: null, text: null, kids: 0, claimed: 0, ...over,
  };
}

/** Is this observation a hole rather than an answer. @param {any} o */
const isHole = (o) => o?.meta?.refused === true;

// ---------------------------------------------------------------------------

describe('reading what gdbus printed', () => {
  // The real output, copied from a terminal on 2026-08-31. Note the FIRST pair spells out
  // `objectpath` and the three after it do not. This exact asymmetry read a 190-node desktop
  // as a 6-node one, confidently, until it was found.
  const realChildren = "([(':1.0', objectpath '/org/a11y/atspi/accessible/root'),"
    + " (':1.4', '/org/a11y/atspi/accessible/root'),"
    + " (':1.7', '/org/a11y/atspi/accessible/root'),"
    + " (':1.9', '/org/a11y/atspi/accessible/root')],)";

  test('finds every application, not only the first one gdbus spelled out in full', () => {
    const found = parseGdbusChildren(realChildren);
    assert.equal(found.length, 4, 'a pattern that needs "objectpath" every time finds only one');
    assert.deepEqual(found.map((f) => f.bus), [':1.0', ':1.4', ':1.7', ':1.9']);
    assert.equal(found[0].path, '/org/a11y/atspi/accessible/root');
    assert.equal(found[3].path, '/org/a11y/atspi/accessible/root');
  });

  test('a desktop with one application still reads as one, not as none', () => {
    assert.equal(parseGdbusChildren("([(':1.0', objectpath '/org/a11y/atspi/accessible/root')],)").length, 1);
  });

  test('an empty desktop reads as empty rather than throwing', () => {
    assert.deepEqual(parseGdbusChildren('([],)'), []);
  });

  test('pulls the bus address out of a real reply', () => {
    const line = "ADDRESS ('unix:path=/run/user/0/at-spi/bus_99,guid=919f3202fc389191b95563126a955e11',)";
    assert.match(String(parseGdbusAddress(line)), /^unix:path=\/run\/user\/0\/at-spi\/bus_99/);
  });

  test('a complaint is never mistaken for an address', () => {
    // If this came back as an address, the next call would open a socket at a path made of
    // English and fail somewhere much further from the cause.
    const angry = 'ADDRESS Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: '
      + "The name org.a11y.Bus was not provided by any .service files";
    assert.equal(parseGdbusAddress(angry), null);
  });
});

describe('deciding whether a machine has a desktop at all', () => {
  test('no screen means no desktop, and the bus is not even asked about', () => {
    // The measured trap: a headless machine has a user session bus, and asking it for the
    // accessibility bus starts an empty one. Reported as a desktop, that is a machine with
    // "no controls" — and the run after it compares nothing against nothing and agrees.
    const probe = readDesktopProbe('SCREEN no\n');
    assert.equal(probe.hasBus, false);
    assert.equal(probe.address, null);
    assert.match(probe.why, /no screen on that machine/);
    assert.match(probe.why, /starts an empty one/);
  });

  test('a screen and a bus with applications on it is a desktop', () => {
    const probe = readDesktopProbe([
      'SCREEN yes',
      "ADDRESS ('unix:path=/run/user/1000/at-spi/bus_0',)",
      "APPS ([(':1.0', objectpath '/org/a11y/atspi/accessible/root'), (':1.4', '/org/a11y/atspi/accessible/root')],)",
    ].join('\n'));
    assert.equal(probe.hasBus, true);
    assert.equal(probe.apps, 2);
    assert.match(probe.why, /2 applications/);
  });

  test('a bus with nothing on it says so, because that is also what a bare server looks like', () => {
    const probe = readDesktopProbe("SCREEN yes\nADDRESS ('unix:path=/run/user/0/at-spi/bus',)\nAPPS ([],)");
    assert.equal(probe.hasBus, true);
    assert.equal(probe.apps, 0);
    assert.match(probe.why, /nothing at all is on it/);
  });

  test('a machine that answered nothing is not a machine with an empty desktop', () => {
    const probe = readDesktopProbe('', 'gdbus: command not found');
    assert.equal(probe.hasBus, false);
    assert.match(probe.why, /Nothing on that machine answered as an accessibility bus/);
  });

  test('the cheap probe asks about the screen before it asks about the bus', () => {
    // Order is the whole safety property here: asking the other way round STARTS a service on
    // a machine that had none and then reports it as a desktop.
    const command = gdbusProbeCommand();
    const screenAt = command.indexOf('SCREEN');
    const busAt = command.indexOf('org.a11y.Bus');
    assert.ok(screenAt >= 0 && busAt >= 0);
    assert.ok(screenAt < busAt, 'the screen must be settled before anything asks for the bus');
    assert.match(command, /if \[ "\$SCREEN" != yes \]; then exit 0; fi/);
  });
});

describe('the wire to the probe', () => {
  test('a reply is only ever a sentinelled line', () => {
    const got = readProbeReply(
      'Gtk-Message: Failed to load module "canberra-gtk-module"\n'
      + `${PROBE_SENTINEL}{"ok":true,"walked":189}\n`,
      'dbind-WARNING: Couldn\'t connect to accessibility bus\n',
    );
    assert.deepEqual(got.reply, { ok: true, walked: 189 });
    assert.equal(got.noise.length, 2);
    assert.match(got.noise[0], /canberra-gtk-module/);
  });

  test('a stream of nothing but warnings is no reply at all', () => {
    // The alternative — assembling an answer out of whatever turned up — is how a warning
    // becomes an observation.
    const got = readProbeReply('Gtk-Message: something\nGLib-GObject-WARNING: something else\n');
    assert.equal(got.reply, null);
    assert.equal(got.noise.length, 2);
  });

  test('a sentinelled line that will not parse is kept where somebody will see it', () => {
    const got = readProbeReply(`${PROBE_SENTINEL}{"ok":true,`);
    assert.equal(got.reply, null);
    assert.match(got.noise[0], /unreadable reply/);
  });

  test('nothing but base64 crosses the shell', () => {
    // Quotes, dollars, backslashes and newlines all mean something different to a POSIX shell,
    // to ssh and to Python, and the probe contains all four. Base64 contains none of them.
    const command = probeCommand('python3', 'print("hi $HOME `whoami`")', { op: 'hello', dir: "it's" });
    const inQuotes = [...command.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    assert.equal(inQuotes.length, 2, 'exactly two quoted things: the program and the request');
    for (const blob of inQuotes) assert.match(blob, /^[A-Za-z0-9+/=]+$/);
    assert.equal(
      JSON.parse(Buffer.from(inQuotes[1], 'base64').toString('utf8')).dir,
      "it's",
      'the request survives an apostrophe, which is what would end the shell quoting',
    );
  });
});

describe('accessibility states', () => {
  test('the bitfield decodes to what a real window said', () => {
    // 0x43200102 came off a real GTK frame on 2026-08-31. If this list ever slips by one
    // entry, every control in every report starts describing the wrong thing while looking
    // perfectly reasonable, so the numbers are pinned to a real reading rather than to a
    // header file somebody copied.
    const low = 0x43200102;
    const names = STATE_NAMES.filter((_, i) => i < 32 && (low & (1 << i)) !== 0);
    assert.deepEqual(names, ['active', 'enabled', 'resizable', 'sensitive', 'showing', 'visible']);
  });

  test('a plain enabled button decodes to four states', () => {
    const low = 0x43000900;
    const names = STATE_NAMES.filter((_, i) => i < 32 && (low & (1 << i)) !== 0);
    assert.deepEqual(names, ['enabled', 'focusable', 'sensitive', 'showing', 'visible']);
  });

  test('behaviour is compared and where the mouse is is not', () => {
    for (const meaningful of ['checked', 'enabled', 'sensitive', 'expanded', 'selected', 'read only']) {
      assert.ok(COMPARED_STATES.has(meaningful), `${meaningful} decides whether a control works`);
    }
    for (const restless of ['focused', 'active', 'busy', 'stale', 'transient']) {
      assert.ok(!COMPARED_STATES.has(restless), `${restless} flips between two readings of an unchanged app`);
    }
  });
});

describe('what a control is called and what it says it is', () => {
  test('the address is what it is and what it is called, never where it sits', () => {
    assert.equal(controlAddress(node({ name: 'Save' }), 4), 'push button:Save');
    // Adding a control above it must not move it: the same control at a different index keeps
    // the same address, or every control below an insertion reports as changed.
    assert.equal(controlAddress(node({ name: 'Save' }), 90), 'push button:Save');
  });

  test('an accessible id wins over a name, because a name is what somebody translated', () => {
    assert.equal(controlAddress(node({ id: 'save-button', name: 'Enregistrer' }), 1), 'push button:save-button');
  });

  test('an unnamed container falls back to its role and its depth', () => {
    assert.equal(controlAddress(node({ role: 'filler', name: '', depth: 2 }), 7), 'filler@2#7');
  });

  test('the meaning carries everything that decides behaviour', () => {
    const said = controlMeaning(node({
      role: 'check box', name: 'Send a copy', states: ['checked', 'enabled', 'sensitive', 'focused'], can: ['Click'],
    }));
    assert.match(said, /check box/);
    assert.match(said, /called "Send a copy"/);
    assert.match(said, /checked/);
    assert.match(said, /can Click/);
    assert.ok(!said.includes('focused'), 'focus follows the mouse and is not a change in the product');
  });

  test('a value and a typed-in text are both part of the meaning', () => {
    assert.match(controlMeaning(node({ role: 'slider', name: 'Volume', value: 0.4, can: [] })), /set to 0\.4/);
    assert.match(controlMeaning(node({ role: 'text', name: '', text: '420.00', can: [] })), /saying "420\.00"/);
  });

  test('a password is compared on its length and never on its contents', () => {
    const said = controlMeaning(node({ role: 'password text', name: '', text: '11 characters', secret: true, can: [] }));
    assert.match(said, /holding 11 characters/);
    assert.ok(!said.includes('saying'), 'a stored reference is committed to a repository');
  });

  test('a control that would not answer says so instead of looking ordinary', () => {
    assert.match(controlMeaning(node({ unreadable: 'object does not exist' })), /could not be read/);
  });
});

describe('a tree that cannot be trusted is never a pass', () => {
  test('a normal tree becomes one observation per control plus a count', () => {
    const seen = meaningFromTree({
      journey,
      window: 'Invoice 2481',
      nodes: [node({ role: 'frame', name: 'Invoice 2481', depth: 0 }), node({ name: 'Save' }), node({ name: 'Cancel' })],
      walked: 3,
      shapeDisagreed: 0,
      settled: true,
    });
    const meanings = seen.filter((o) => o.channel === 'meaning');
    assert.equal(meanings.length, 3);
    assert.ok(meanings.every((o) => !isHole(o)));
    const count = seen.find((o) => o.channel === 'counters');
    assert.ok(count, 'how many controls were on screen is itself worth comparing');
    assert.equal(seen.filter(isHole).length, 0);
  });

  test('an empty window is UNCHECKED, never an app with no controls', () => {
    const seen = meaningFromTree({ journey, window: 'Some Window', nodes: [], walked: 0, toolkit: 'Qt' });
    assert.equal(seen.length, 1);
    assert.ok(isHole(seen[0]), 'recording "no controls" makes the next run agree that nothing changed');
    assert.match(String(seen[0].meta?.describe), /UNCHECKED, not empty/);
    assert.match(String(seen[0].meta?.describe), /Qt/);
  });

  test('a tree that contradicts itself about its own shape is thrown away, not reported', () => {
    const seen = meaningFromTree({
      journey, window: 'Invoice 2481', nodes: [node(), node()], walked: 2, shapeDisagreed: 1,
    });
    assert.equal(seen.length, 1);
    assert.ok(isHole(seen[0]));
    assert.match(String(seen[0].meta?.describe), /contradicted itself/);
    // And nothing from that read leaked into the report alongside the hole.
    assert.equal(seen.filter((o) => o.channel === 'meaning' && !isHole(o)).length, 0);
  });

  test('two controls with the same name are numbered, not silently merged', () => {
    const seen = meaningFromTree({
      journey,
      window: 'Two Panels',
      nodes: [node({ name: 'Close' }), node({ name: 'Close' })],
      walked: 2,
      settled: true,
    });
    const paths = seen.filter((o) => o.channel === 'meaning').map((o) => o.path);
    assert.equal(new Set(paths).size, 2, 'the second must not overwrite the first');
    assert.ok(paths.some((p) => p.endsWith('~2')));
  });

  test('a window that never held still is recorded as still moving', () => {
    const seen = meaningFromTree({ journey, window: 'Busy', nodes: [node()], walked: 1, settled: false });
    const hole = seen.find(isHole);
    assert.ok(hole);
    assert.match(String(hole.meta?.describe), /never held still/);
  });

  test('hitting the size cap is a visible decision, not a quiet truncation', () => {
    const seen = meaningFromTree({
      journey, window: 'Enormous', nodes: [node(), node()], walked: 2, hitLimit: true, settled: true,
    });
    const hole = seen.find(isHole);
    assert.ok(hole, 'a cap nobody can see from the outside is a wrong answer, not a cap');
    assert.match(String(hole.meta?.describe), new RegExp(String(MAX_TREE_NODES)));
  });

  test('controls that vanished mid-read are counted and admitted', () => {
    const seen = meaningFromTree({ journey, window: 'Flickery', nodes: [node()], walked: 1, unreadable: 3, settled: true });
    const hole = seen.find(isHole);
    assert.ok(hole);
    assert.match(String(hole.meta?.describe), /3 controls .* would not answer/);
  });
});

describe('how it ended', () => {
  test('a signal is a crash and the polite one is not', () => {
    assert.equal(exitMeaning('139').crashed, true);
    assert.match(exitMeaning('139').value, /segmentation fault/);
    assert.equal(exitMeaning('134').crashed, true);
    // 143 is this tool asking the app to close at the end of a walk. Calling that a crash
    // would make every single run report one.
    assert.equal(exitMeaning('143').crashed, false);
    assert.match(exitMeaning('143').value, /closed when asked/);
    assert.equal(exitMeaning('137').crashed, false);
    assert.equal(exitMeaning('0').crashed, false);
    assert.equal(exitMeaning('2').crashed, true);
  });

  test('still running is not an ending', () => {
    assert.equal(exitMeaning(null).value, 'still running');
    assert.equal(exitMeaning(undefined).crashed, false);
  });

  test('a crash reaches the report as a complaint', () => {
    const seen = complaintObservations(journey, { complained: 'Segmentation fault\n', exit: '139' });
    const ending = seen.find((o) => o.path.includes('how it ended'));
    assert.ok(ending);
    assert.match(String(ending.value), /crashed/);
    assert.ok(seen.some((o) => isHole(o) && o.path.includes('core dumps')), 'the dump itself is a named hole');
  });

  test('a quiet run still records that it was quiet, so going noisy is a difference', () => {
    const seen = complaintObservations(journey, { complained: '', exit: null });
    const said = seen.find((o) => o.path.includes('complained'));
    assert.ok(said && !isHole(said));
    assert.equal(said.value, '');
  });
});

describe('what it did while it was open', () => {
  test('neither the wrapper nor the app is a program the app started', () => {
    const seen = spawnedObservations(journey, [
      { name: 'sh', pid: 100, ppid: 1, cmd: '/bin/sh -c ...' },
      { name: 'yourapp', pid: 101, ppid: 100, cmd: '/opt/yourapp/yourapp' },
      { name: 'yourapp-updater', pid: 102, ppid: 101, cmd: '/opt/yourapp/updater --check' },
    ], 100, 101);
    const effects = seen.filter((o) => o.channel === 'effects');
    assert.equal(effects.length, 1, 'reporting our own wrapper every run would be noise, not a finding');
    assert.match(String(effects[0].value), /updater --check/);
    const count = seen.find((o) => o.channel === 'counters');
    assert.ok(count);
  });

  test('files written, changed and deleted are all differences, and the rest is a hole', () => {
    const seen = fileObservations(
      journey,
      { '/home/you/.config/app': { 'settings.json': 100, 'old.log': 20 } },
      { '/home/you/.config/app': { 'settings.json': 180, 'new.log': 5 } },
    );
    const said = seen.filter((o) => o.channel === 'effects' && !isHole(o)).map((o) => String(o.meta?.describe));
    assert.ok(said.some((s) => /changed settings\.json/.test(s)));
    assert.ok(said.some((s) => /wrote new\.log/.test(s)));
    assert.ok(said.some((s) => /deleted old\.log/.test(s)));
    const hole = seen.find(isHole);
    assert.ok(hole, 'anything written outside the watched folders was not seen and must say so');
    assert.match(String(hole.meta?.describe), /a hole, not a clean result/);
  });

  test('connections are reported without the ones that go nowhere, and sampling is admitted', () => {
    const seen = networkObservations(journey, [
      { remote: '140.82.121.4:443', state: '01' },
      { remote: '127.0.0.1:5432', state: '01' },
      { remote: '140.82.121.4:443', state: '01' },
    ]);
    const real = seen.filter((o) => !isHole(o));
    assert.equal(real.length, 1, 'the same address twice is one connection, and loopback is not a connection out');
    assert.equal(real[0].value, '140.82.121.4:443');
    assert.ok(seen.some(isHole));
  });

  test('what it printed is compared even when it printed nothing', () => {
    const seen = printedObservations(journey, '');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].value, '');
    const cut = printedObservations(journey, 'x'.repeat(10), true);
    assert.ok(cut.some(isHole), 'a truncation nobody can see is a wrong answer');
  });
});

describe('finding the app and knowing when not to bother', () => {
  test('a build already on that machine costs nothing, and one here has to be copied', () => {
    assert.equal(findLinuxBuild({ root: '/p', config: { remoteExe: '/opt/app/app' } }).mode, 'there');
    const push = findLinuxBuild({ root: '/p', config: { exe: 'dist/linux/app' } });
    assert.equal(push.mode, 'push');
    // `local` is the build on THIS machine, waiting to be copied over, so its separator is
    // this machine's. Spelled with `/` it failed on a real Windows 11 machine on 2026-08-31
    // about a perfectly correct answer.
    assert.equal(push.local, path.join('/p', 'dist/linux/app'));
    assert.match(push.why, /has to be copied/);
    assert.equal(findLinuxBuild({ root: '/p', config: {} }).mode, 'none');
  });

  test('a Chromium window is somebody else\'s job', () => {
    assert.equal(isChromiumToolkit('Chromium'), true);
    assert.equal(isChromiumToolkit('chromium'), true);
    assert.equal(isChromiumToolkit('gtk'), false);
    assert.equal(isChromiumToolkit('Qt'), false);
    assert.equal(isChromiumToolkit(''), false);
  });

  test('an Electron project is declined with somewhere better to go', async () => {
    // Everything this adapter can do, the Electron adapter does better for an Electron app:
    // from any machine, over the debug port, with both builds up at once. Declining is the
    // right answer and it has to come with the place to go instead.
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sfx-linux-electron-'));
    await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { electron: '30.0.0' } }));
    const found = await linuxAdapter.detect({ root, config: { host: 'box', remoteExe: '/opt/a' } });
    await fsp.rm(root, { recursive: true, force: true });
    assert.equal(found.applies, false);
    assert.match(found.why, /Electron adapter/);
    assert.deepEqual(found.missing, [], 'nothing is missing — there is simply a better tool already in the box');
  });

  test('a project with no machine and no build says which of the two blocks it', async () => {
    const found = await linuxAdapter.detect({ root: '/nowhere-at-all', config: {} });
    assert.equal(found.applies, false);
    const blocking = found.missing.filter((m) => m.blocking);
    assert.equal(blocking.length, 2);
    assert.ok(blocking.every((m) => typeof m.howToGet === 'string' && m.howToGet.length > 20));
    assert.ok(found.missing.some((m) => /folders this app writes into/.test(m.what)));
  });

  test('the journeys it offers never invent a button to press', async () => {
    const walks = await linuxAdapter.journeys({ root: '/p', config: { host: 'box', remoteExe: '/opt/a' } });
    assert.equal(walks.length, 1);
    assert.equal(walks[0].surface, 'linux');
    // Anything beyond opening the app has to come from somebody who knows it. An adapter that
    // guesses which buttons to press on an unknown native program will one day press
    // "Delete account".
    const withExtra = await linuxAdapter.journeys({
      root: '/p',
      config: { host: 'box', remoteExe: '/opt/a', journeys: [{ name: 'save-an-invoice', irreversible: true }] },
    });
    assert.equal(withExtra.length, 2);
    assert.equal(withExtra[1].irreversible, true);
  });

  test('an irreversible journey is refused outright rather than walked carefully', async () => {
    const seen = await linuxAdapter.run(
      /** @type {any} */ ({ ...journey, irreversible: true, describe: 'pay the invoice' }),
      /** @type {any} */ ({ ready: true, why: 'ok', facts: { exe: '/opt/a', host: 'box' } }),
      /** @type {any} */ ({ config: {}, scratchDir: '/tmp', evidenceDir: '/tmp', seed: 1, clock: 'x' }),
    );
    assert.equal(seen.length, 1);
    assert.ok(isHole(seen[0]));
    assert.match(String(seen[0].meta?.describe), /not run at all/);
    assert.match(String(seen[0].meta?.describe), /a hole in what was checked, not a pass/);
  });

  test('a build that was never prepared reports a hole and never an empty screen', async () => {
    const seen = await linuxAdapter.run(
      journey,
      /** @type {any} */ ({ ready: false, why: 'There is no desktop session on box.' }),
      /** @type {any} */ ({ config: {}, scratchDir: '/tmp', evidenceDir: '/tmp', seed: 1, clock: 'x' }),
    );
    assert.equal(seen.length, 1);
    assert.ok(isHole(seen[0]));
    assert.match(String(seen[0].meta?.describe), /no desktop session/);
  });
});

describe('what doctor says about a machine', () => {
  /** @param {Partial<import('../../src/v2/remote.js').RemoteDescription>} over */
  const machine = (over) => /** @type {import('../../src/v2/remote.js').RemoteDescription} */ ({
    host: 'office-box', reachable: true, runnerStarted: true, how: '', os: 'linux', windows: false,
    windowsVersion: null, powershell: null, desktopLoggedIn: null, desktopLocked: null, tools: {},
    missing: [], notes: [], ...over,
  });

  test('an unreachable machine is not reported as a desktop with nothing on it', () => {
    assert.match(describeLinuxDesktop(machine({ reachable: false })), /cannot be checked from here/);
  });

  test('a Windows machine is told it is a Windows machine', () => {
    assert.match(describeLinuxDesktop(machine({ windows: true })), /Windows machine, not a Linux desktop/);
  });

  test('not having looked yet is different from having looked and found nothing', () => {
    assert.match(describeLinuxDesktop(machine({})), /has not been looked at yet/);
    assert.match(
      describeLinuxDesktop(machine({}), { hasBus: false, address: null, apps: 0, why: 'No screen.' }),
      /no desktop session on it/,
    );
  });

  test('a working desktop says nothing has to be installed on it', () => {
    const said = describeLinuxDesktop(machine({}), {
      hasBus: true, address: 'unix:path=/x', apps: 3, why: 'An accessibility bus is running with 3 applications on it.',
    });
    assert.match(said, /Nothing has to be installed/);
    assert.match(said, /One build at a time/);
  });
});

describe('the probe that gets sent down the wire', () => {
  const probe = linuxProbeScript();

  test('it opens the bus with the class that performs the handshake', () => {
    // TRAP A. `dbus.connection.Connection(addr)` opens the socket and never says hello, so the
    // first call hangs until it times out with NoReply — twenty minutes of looking at the
    // wrong end. Matched with the bracket on purpose: this file and the driver both DISCUSS
    // the wrong class by name, and a test that banned the bare words would fail on prose.
    assert.match(probe, /dbus\.bus\.BusConnection\(/);
    assert.ok(!probe.includes('dbus.connection.Connection('), 'that one never finishes the handshake');
  });

  test('it does not use the bulk query that answers zero', () => {
    // TRAP C. Every application advertises Collection.GetMatches and it returned 0 objects in
    // 0 ms for all five match modes while a plain walk of the same app found 189 controls.
    assert.ok(!probe.includes('GetMatches'), 'the obvious fast path is a confident wrong answer');
    assert.match(probe, /GetChildren\(\)/, 'the walk is the plain one, which is the one that works');
  });

  test('it refuses to stop anything this run did not start', () => {
    assert.match(probe, /refusing to stop a process this run did not start/);
    assert.match(probe, new RegExp(`MARKER = ${JSON.stringify(RUN_MARKER)}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('it switches the accessibility bridge on for GTK and for Qt before starting the app', () => {
    // An app whose toolkit never published a tree is invisible here, and these four lines are
    // what stops most of that being this tool's own fault.
    for (const knob of ['GTK_MODULES', 'NO_AT_BRIDGE', 'QT_ACCESSIBILITY', 'QT_LINUX_ACCESSIBILITY_ALWAYS_ON']) {
      assert.ok(probe.includes(knob), `${knob} is what makes a window readable at all`);
    }
  });

  test('it prints replies behind the sentinel, because everything else writes to that stream too', () => {
    assert.match(probe, new RegExp(`SENT = ${JSON.stringify(PROBE_SENTINEL)}`));
  });
});
