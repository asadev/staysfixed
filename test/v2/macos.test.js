/**
 * What the macOS adapter decides, checked without a window on screen.
 *
 * Every test here is driven by fixture data — a tree the probe would have handed back, the text
 * `ps` would have printed, a crash report as macOS writes one — because a test that needs an app
 * open is a test that only runs on somebody's desk. The parts that really do need a Mac with a
 * window on it were proven by hand on 2026-08-31 and written up in the opening comment of
 * `macos.js`; what is guarded here is the decisions, which are the part that can quietly rot.
 *
 * The one that matters most is the first group. A Mac app can be alive, on screen, and still
 * report zero controls — measured, twice, caused by a second copy of the same app being open.
 * If this adapter ever writes that down as "this window has no controls in it", the next run
 * compares zero against zero, agrees that nothing has changed, and the whole product has told
 * its one unforgivable lie.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  controlAddress, controlMeaning, meaningFromTree, spawnedObservations, fileObservations,
  complaintObservations, networkObservations, findMacApp, looksLikeAMacProject, describeMacos,
  macosAdapter, HOW_TO_ALLOW,
} from '../../src/v2/adapters/macos.js';
import {
  readBundle, pidsRunning, descendantsOf, readCrashReport, worthKeepingFromLog, readProbeReply,
  macosProbeScript, MAX_TREE_NODES,
} from '../../src/v2/adapters/macos-driver.js';

/** @type {import('../../src/v2/types.js').Journey} */
const journey = { name: 'open-the-app', describe: 'open the app and read the screen', source: 'code', surface: 'macos' };

/** One control, as the probe hands it back. */
const control = (over = {}) => ({
  d: 1, role: 'AXButton', sub: null, title: 'Save order', desc: null, value: null, id: 'save',
  on: true, help: null, hint: null, sel: null, foc: false, can: ['AXPress'], ...over,
});

// ---------------------------------------------------------------------------

describe('an empty answer from a living app is never a pass', () => {
  test('a window the window server can see, with no controls, is recorded as unchecked', () => {
    const seen = meaningFromTree({ journey, window: 'Widget Shop', nodes: [], onScreenCount: 1, childCount: -1 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].meta.refused, true, 'this has to be a hole, not a fact');
    assert.match(seen[0].meta.describe, /is on the screen/);
    assert.match(seen[0].meta.describe, /second copy of the same app/, 'and it has to name the cause somebody can act on');
    assert.match(seen[0].meta.describe, /agree that nothing had changed/, 'and say why staying quiet would be worse');
  });

  test('a window that claims children and then hands back none is a half answer, not an empty one', () => {
    const seen = meaningFromTree({
      journey, window: 'Widget Shop', nodes: [control({ d: 0, role: 'AXWindow' })], onScreenCount: 1, childCount: 12,
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].meta.refused, true);
    assert.match(seen[0].meta.describe, /12 things in it and then handed back none/);
  });

  test('nothing on screen and nothing in the tree is still unchecked, never empty', () => {
    const seen = meaningFromTree({ journey, window: 'Widget Shop', nodes: [], onScreenCount: 0, childCount: -1 });
    assert.equal(seen[0].meta.refused, true);
    assert.match(seen[0].meta.describe, /unchecked, not empty/);
  });

  test('a real tree is recorded as facts, and the count comes with it', () => {
    const seen = meaningFromTree({
      journey,
      window: 'Widget Shop',
      nodes: [control({ d: 0, role: 'AXWindow', title: 'Widget Shop', id: null }), control()],
      onScreenCount: 1,
      childCount: 2,
      settled: true,
    });
    assert.equal(seen.filter((o) => o.meta.refused).length, 0, 'a good read produces no holes at all');
    const counter = seen.find((o) => o.channel === 'counters');
    assert.equal(counter.value, 2);
  });
});

describe('the caps announce themselves', () => {
  const big = Array.from({ length: 3 }, (_, i) => control({ id: `c${i}` }));

  test('a tree that hit the control cap says how much was left unread', () => {
    const seen = meaningFromTree({
      journey, window: 'Big', nodes: big, onScreenCount: 1, childCount: 3, settled: true, truncated: true,
    });
    const hole = seen.find((o) => o.meta.refused);
    assert.ok(hole, 'hitting the cap must be visible, or the ledger claims coverage it does not have');
    assert.match(hole.meta.describe, new RegExp(String(MAX_TREE_NODES)));
    assert.match(hole.meta.describe, /unchecked/);
  });

  test('a tree that ran out of time says so separately from one that ran out of room', () => {
    const seen = meaningFromTree({
      journey, window: 'Slow', nodes: big, onScreenCount: 1, childCount: 3, settled: true, ranOut: true,
    });
    const hole = seen.find((o) => o.meta.refused);
    assert.match(hole.meta.describe, /limit with 3 controls read/);
    assert.match(hole.meta.describe, /unchecked, not unchanged/);
  });

  test('a window that never held still is reported, because the difference may be the movement', () => {
    const seen = meaningFromTree({
      journey, window: 'Busy', nodes: big, onScreenCount: 1, childCount: 3, settled: false,
    });
    const hole = seen.find((o) => o.meta.refused);
    assert.match(hole.meta.describe, /never held still/);
    assert.match(hole.meta.describe, /the movement rather than the change/);
  });
});

describe('what one control is boiled down to', () => {
  test('the accessibility identifier wins, because it is the one a translator never touches', () => {
    assert.equal(controlAddress(control({ id: 'save', title: 'Save order' }), 3), 'button:save');
  });

  test('with no identifier it falls back to the title, then to the description', () => {
    assert.equal(controlAddress(control({ id: null, title: 'Save order' }), 3), 'button:Save order');
    assert.equal(controlAddress(control({ id: null, title: null, desc: 'Close' }), 3), 'button:Close');
  });

  test('a control with no name at all is numbered, and the number is visible in the address', () => {
    assert.equal(controlAddress(control({ id: null, title: null, desc: null }), 7), 'button#7');
  });

  test('a checkbox being ticked or not is part of what it means', () => {
    const on = controlMeaning(control({ role: 'AXCheckBox', title: 'Remember me', value: 1 }));
    const off = controlMeaning(control({ role: 'AXCheckBox', title: 'Remember me', value: 0 }));
    assert.notEqual(on, off, 'a checkbox that changed state has to read as a different control');
    assert.match(on, /showing 1/);
  });

  test('a button going from greyed out to clickable reads as a difference', () => {
    const off = controlMeaning(control({ title: 'Delete order', on: false }));
    const on = controlMeaning(control({ title: 'Delete order', on: true }));
    assert.match(off, /greyed out/);
    assert.doesNotMatch(on, /greyed out/);
    assert.notEqual(off, on);
  });

  test('what a control can be asked to do is part of what it means', () => {
    assert.match(controlMeaning(control({ can: ['AXPress', 'AXShowMenu'] })), /can Press, ShowMenu/);
  });

  test('the keyboard focus is deliberately left out', () => {
    // The adapter opens apps in the BACKGROUND, so which control holds the keyboard depends on
    // what the person using the Mac clicked on while the run was going. Comparing it would
    // report their mouse as a regression in the product.
    assert.equal(controlMeaning(control({ foc: true })), controlMeaning(control({ foc: false })));
  });

  test('where a control sits on screen is deliberately left out', () => {
    // A window that opens two pixels lower is not a difference anybody wants reported.
    assert.equal(controlMeaning(control({ d: 1 })), controlMeaning(control({ d: 4 })));
  });

  test('two controls with the same name get two addresses, not one', () => {
    const seen = meaningFromTree({
      journey,
      window: 'Panel',
      nodes: [control({ id: null, title: 'Close' }), control({ id: null, title: 'Close' })],
      onScreenCount: 1,
      childCount: 2,
      settled: true,
    });
    const paths = seen.filter((o) => o.channel === 'meaning').map((o) => o.path);
    assert.equal(new Set(paths).size, paths.length, 'the second must not silently overwrite the first');
  });

  test('two journeys reading one window do not collide on the same address', () => {
    // Every index in this engine keeps the FIRST observation at a path and drops the rest, so a
    // collision means the second journey's answer is never compared with anything at all.
    const nodes = [control()];
    const one = meaningFromTree({ journey, window: 'Widget Shop', nodes, onScreenCount: 1, childCount: 1, settled: true });
    const other = meaningFromTree({
      journey: { ...journey, name: 'press-save' }, window: 'Widget Shop', nodes, onScreenCount: 1, childCount: 1, settled: true,
    });
    for (const o of one) assert.ok(!other.some((p) => p.path === o.path), `"${o.path}" appears in both journeys`);
  });
});

describe('the other channels', () => {
  test('a helper the app started is reported with its whole command line', () => {
    const seen = spawnedObservations(journey, [
      { pid: 2, parent: 1, command: '/Applications/Thing.app/Contents/MacOS/Updater --silent' },
    ]);
    const started = seen.find((o) => o.channel === 'effects');
    assert.match(String(started.value), /--silent/, 'a changed flag on a helper is a real regression nothing else catches');
  });

  test('two runs that started the same helpers in a different order do not differ', () => {
    const a = spawnedObservations(journey, [
      { pid: 2, parent: 1, command: '/a/Helper' }, { pid: 3, parent: 1, command: '/a/Updater' },
    ]);
    const b = spawnedObservations(journey, [
      { pid: 9, parent: 1, command: '/a/Updater' }, { pid: 8, parent: 1, command: '/a/Helper' },
    ]);
    assert.deepEqual(a.map((o) => [o.path, o.value]), b.map((o) => [o.path, o.value]));
  });

  test('files are compared by their contents, so a rewrite to the same length is caught', () => {
    const before = new Map([['settings.json', 'aaaaaaaaaaaaaaaa']]);
    const after = new Map([['settings.json', 'bbbbbbbbbbbbbbbb']]);
    const seen = fileObservations(journey, before, after, '~/Library/Application Support/Thing');
    const changed = seen.find((o) => o.channel === 'effects');
    assert.ok(changed, 'the same-length rewrite that the Windows adapter openly misses is caught here');
    assert.match(changed.meta.describe, /changed what is inside settings\.json/);
  });

  test('a run that watched nowhere still says the disk was not watched', async () => {
    // Proven through the adapter itself rather than the helper, because the silence being
    // guarded against is the one where nothing is added at all.
    const seen = fileObservations(journey, new Map(), new Map(), '/tmp/x');
    assert.equal(seen.filter((o) => o.channel === 'counters').length, 1, 'a zero has to be written down as a zero');
  });

  test('a crash is a fact, and no crash is also a fact', () => {
    const none = complaintObservations(journey, [], { kept: [], dropped: 0, ok: true, why: 'read' });
    assert.ok(none.some((o) => o.path.endsWith('crashed') && o.value === 0));
    const one = complaintObservations(
      journey,
      [{ file: '/x/Thing-2026.ips', exception: 'EXC_BAD_ACCESS', reason: 'SIGSEGV' }],
      { kept: [], dropped: 0, ok: true, why: 'read' },
    );
    assert.ok(one.some((o) => String(o.value).includes('EXC_BAD_ACCESS')));
  });

  test('a log that could not be read is a hole, never a quiet zero', () => {
    const seen = complaintObservations(journey, [], { kept: [], dropped: 0, ok: false, why: 'the log could not be read' });
    const hole = seen.find((o) => o.meta.refused);
    assert.ok(hole, 'an unreadable log must not look like an app that logged nothing');
    assert.match(hole.meta.describe, /Crashes are still reported/);
  });

  test('connections are reported with the note that sampling misses things', () => {
    const seen = networkObservations(journey, 'Thing 42 me 9u IPv4 0x1 0t0 TCP 10.0.0.2:5000->93.184.216.34:443 (ESTABLISHED)');
    assert.ok(seen.some((o) => o.value === '93.184.216.34:443'));
    const hole = seen.find((o) => o.meta.refused);
    assert.match(hole.meta.describe, /sampled while the app ran, not captured/);
  });

  test('the loopback is not reported as somewhere it reached out to', () => {
    const seen = networkObservations(journey, 'Thing 42 me 9u IPv4 0x1 0t0 TCP 127.0.0.1:5000->127.0.0.1:6000 (ESTABLISHED)');
    assert.equal(seen.filter((o) => !o.meta.refused).length, 0);
  });
});

describe('reading what the machine printed', () => {
  test('a bundle is understood from its own Info.plist', () => {
    const plist = '<key>CFBundleExecutable</key><string>Widget</string>'
      + '<key>CFBundleName</key><string>Widget Shop</string>'
      + '<key>CFBundleIdentifier</key><string>dev.example.widget</string>';
    const facts = readBundle('/x/Widget.app', plist, []);
    assert.equal(facts.ok, true);
    assert.equal(facts.executable, '/x/Widget.app/Contents/MacOS/Widget');
    assert.equal(facts.bundleId, 'dev.example.widget', 'the identifier is what two builds of one app share');
    assert.equal(facts.electron, false);
  });

  test('an Electron bundle is recognised and handed to the adapter that covers it properly', () => {
    const facts = readBundle('/x/Thing.app', '<key>CFBundleExecutable</key><string>Thing</string>', [
      'Electron Framework.framework', 'Squirrel.framework',
    ]);
    assert.equal(facts.electron, true);
  });

  test('a bundle with no executable named says so instead of guessing one', () => {
    const facts = readBundle('/x/Broken.app', '<plist></plist>', []);
    assert.equal(facts.ok, false);
    assert.match(facts.why, /no CFBundleExecutable/);
  });

  test('processes are matched on the whole path, never on the app\'s name', () => {
    // Two builds being compared have the same name and different folders. Matching on the name
    // reads the old build and reports it as the new one, which is a pass that means nothing.
    const ps = [
      '  101 /tmp/a/Widget.app/Contents/MacOS/Widget',
      '  102 /tmp/b/Widget.app/Contents/MacOS/Widget',
      '  103 /Applications/Something Else.app/Contents/MacOS/Something Else',
    ].join('\n');
    assert.deepEqual(pidsRunning(ps, '/tmp/b/Widget.app/Contents/MacOS/Widget'), [102]);
  });

  test('a grandchild listed before its parent is still found', () => {
    // `ps` lists in pid order, so a grandchild can appear above the child that started it.
    const ps = ['  500 400 /a/grandchild', '  400 300 /a/child', '  300 1 /a/parent', '  900 1 /a/stranger'].join('\n');
    const found = descendantsOf(ps, [300]).map((r) => r.pid).sort();
    assert.deepEqual(found, [400, 500]);
  });

  test('the app itself is not reported as a program it started', () => {
    const ps = ['  300 1 /a/parent', '  400 300 /a/child'].join('\n');
    assert.deepEqual(descendantsOf(ps, [300]).map((r) => r.pid), [400]);
  });

  test('a crash report is boiled down to the two lines that change when the crash changes', () => {
    const ips = `${JSON.stringify({ app_name: 'Widget', timestamp: '2026-08-31 14:00:00', bug_type: '309' })}\n`
      + `${JSON.stringify({ exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV' }, threads: [{ frames: Array(80).fill({ imageOffset: 12345 }) }] })}`;
    const read = readCrashReport(ips);
    assert.equal(read.app, 'Widget');
    assert.equal(read.exception, 'EXC_BAD_ACCESS');
    assert.equal(read.reason, 'SIGSEGV');
    // The frames are deliberately left out: their addresses differ on every run of identical
    // code, so comparing them would report a regression every single time.
    assert.equal(JSON.stringify(read).includes('12345'), false);
  });

  test('only real complaints survive the log, and the addresses in them are rubbed out', () => {
    const log = [
      '2026-08-31 14:34:29.651 Df Widget[123:5210f4] [com.apple.xpc:connection] [0x7a7502bac0] chatter',
      '2026-08-31 14:34:30.000 Er Widget[123:5210f4] could not open the file at 0x7a7502bac0',
      '2026-08-31 14:34:31.000 Fa Widget[123:5210b9] assertion failed',
    ].join('\n');
    const { kept, dropped } = worthKeepingFromLog(log);
    assert.equal(dropped, 1, 'debug chatter is dropped and the number dropped is reported');
    assert.equal(kept.length, 2);
    assert.ok(kept.every((l) => !/0x7a7502bac0/.test(l)), 'a pointer differs on every run and would report as a change');
    assert.ok(kept.every((l) => !/^2026-/.test(l)), 'and so would the timestamp');
  });

  test('the same complaint twice is one complaint', () => {
    const line = '2026-08-31 14:34:30.000 Er Widget[123:aa] the same thing';
    assert.equal(worthKeepingFromLog([line, line].join('\n')).kept.length, 1);
  });
});

describe('a probe that did not answer says which way it failed', () => {
  test('a probe stopped for taking too long is not the same as one that printed nothing', () => {
    const slow = readProbeReply({ timedOut: true, why: 'it ran out of time', stdout: '', stderr: '', code: null, ms: 0 });
    const quiet = readProbeReply({ timedOut: false, why: '', stdout: '', stderr: '', code: 1, ms: 0 });
    assert.equal(slow.ok, false);
    assert.equal(quiet.ok, false);
    assert.notEqual(slow.error, quiet.error, 'three different faults must not read as one');
    assert.match(slow.error, /taking too long/);
    assert.match(quiet.error, /printed nothing/);
  });

  test('what the probe complained about is carried through rather than swallowed', () => {
    const broken = readProbeReply({ timedOut: false, why: '', stdout: '', stderr: 'execution error: not allowed (-1743)', code: 1, ms: 0 });
    assert.match(broken.error, /-1743/);
  });

  test('a reply with noise printed before it is still read', () => {
    const reply = readProbeReply({ timedOut: false, why: '', stdout: 'some warning\n{"ok":true,"op":"hello"}\n', stderr: '', code: 0, ms: 0 });
    assert.equal(reply.ok, true);
  });

  test('an answer that is not readable json says what it got', () => {
    const reply = readProbeReply({ timedOut: false, why: '', stdout: 'not json at all', stderr: '', code: 0, ms: 0 });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /not json at all/);
  });
});

describe('the probe itself', () => {
  const script = macosProbeScript();

  test('it never sends a synthetic mouse event', () => {
    // Measured on this machine: a synthetic click lands on the window and no handler fires,
    // while the accessibility layer's own press action really runs the code. A step that
    // pressed and silently did nothing would be the worst kind of pass.
    assert.equal(/CGEvent|CGPostMouseEvent|kCGEventLeftMouseDown/.test(script), false);
    assert.match(script, /AXUIElementPerformAction/);
  });

  test('every accessibility conversation has a limit on it', () => {
    // Without this a hung app hangs the whole run, because every read is a synchronous message
    // into that app's main thread.
    assert.match(script, /AXUIElementSetMessagingTimeout/);
  });

  test('it reads all twelve attributes in one message rather than twelve', () => {
    assert.match(script, /AXUIElementCopyMultipleAttributeValues/);
  });

  test('it asks the window server as well as the app, which is the whole cross-check', () => {
    assert.match(script, /CGWindowListCopyWindowInfo/);
  });

  test('it walks the tree with a stack, not with recursion', () => {
    // A deep tree in a scripting runtime with a small stack is a crash, and a crashed probe
    // reads exactly like an app with no controls.
    assert.match(script, /var stack = \[\{ el: win, d: 0 \}\]/);
  });
});

describe('what it says it can do', () => {
  test('it declares six of the seven channels and no more', () => {
    assert.deepEqual([...macosAdapter.channels].sort(), ['complaints', 'counters', 'effects', 'meaning', 'pixels', 'results']);
    assert.equal(macosAdapter.channels.includes('contract'), false, 'a static contract is not something a built app has');
  });

  test('its one sentence names the two things it cannot do', () => {
    assert.match(macosAdapter.describe, /Accessibility permission/);
    assert.match(macosAdapter.describe, /one build at a time/i);
  });

  test('an app named in the config is found, and no app is said plainly', () => {
    assert.equal(findMacApp({ root: '/p', config: { app: 'dist/Thing.app' } }).app, '/p/dist/Thing.app');
    assert.equal(findMacApp({ root: '/p', config: { app: '/abs/Thing.app' } }).app, '/abs/Thing.app');
    const none = findMacApp({ root: '/p', config: {} });
    assert.equal(none.app, null);
    assert.match(none.why, /nothing to open/);
  });

  test('a Swift or Xcode project is recognised for what it is', () => {
    assert.equal(looksLikeAMacProject(['Thing.xcodeproj', 'README.md']), true);
    assert.equal(looksLikeAMacProject(['Package.swift']), true);
    assert.equal(looksLikeAMacProject(['package.json', 'src']), false);
  });

  test('with no app named, it does not apply and says what would fix it', async () => {
    const detection = await macosAdapter.detect({ root: '/p/nowhere', config: {} });
    assert.equal(detection.applies, false);
    if (process.platform !== 'darwin') {
      assert.match(detection.why, /can only be read from a Mac/);
      assert.match(detection.why, /no way to reach one over a network/);
      return;
    }
    const wanted = detection.missing.map((m) => m.what).join(' | ');
    assert.match(wanted, /built Mac app/, 'the missing half is the useful half');
    assert.ok(detection.missing.some((m) => m.blocking), 'and it has to be marked as blocking');
  });

  test('an Electron bundle on disk is declined, and the answer names the tool that covers it', async (t) => {
    if (process.platform !== 'darwin') return t.skip('detect stops at the platform check off a Mac');
    // A real bundle on disk rather than a stub, because the decision reads two files and the
    // point of this test is that it reads them correctly.
    const where = await fsp.mkdtemp(path.join(os.tmpdir(), 'sfx-macos-test-'));
    const app = path.join(where, 'Thing.app');
    await fsp.mkdir(path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework'), { recursive: true });
    await fsp.writeFile(path.join(app, 'Contents', 'Info.plist'),
      '<plist><dict><key>CFBundleExecutable</key><string>Thing</string></dict></plist>');
    try {
      const detection = await macosAdapter.detect({ root: where, config: { app } });
      assert.equal(detection.applies, false);
      assert.match(detection.why, /Electron adapter/);
      assert.match(detection.why, /two builds able to run side by side/);
      assert.deepEqual(detection.missing, [], 'nothing is missing — there is simply a better tool for it');
    } finally {
      await fsp.rm(where, { recursive: true, force: true });
    }
  });

  test('a real Mac bundle on disk is accepted, and the answer says one build at a time', async (t) => {
    if (process.platform !== 'darwin') return t.skip('detect stops at the platform check off a Mac');
    const where = await fsp.mkdtemp(path.join(os.tmpdir(), 'sfx-macos-test-'));
    const app = path.join(where, 'Thing.app');
    await fsp.mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    await fsp.writeFile(path.join(app, 'Contents', 'Info.plist'),
      '<plist><dict><key>CFBundleExecutable</key><string>Thing</string>'
      + '<key>CFBundleIdentifier</key><string>dev.example.thing</string></dict></plist>');
    try {
      const detection = await macosAdapter.detect({ root: where, config: { app } });
      // Whether it applies depends on whether this Mac has been given Accessibility permission,
      // and both answers are correct — but each has to say the right thing.
      if (detection.applies) {
        assert.match(detection.why, /one build at a time/);
        assert.ok(detection.notes.some((n) => /BACKGROUND/.test(n)), 'and that it never steals the screen');
      } else {
        assert.ok(detection.missing.some((m) => m.blocking && /permission/.test(m.what)));
        assert.match(detection.missing.find((m) => /permission/.test(m.what)).howToGet, /System Settings/);
      }
    } finally {
      await fsp.rm(where, { recursive: true, force: true });
    }
  });

  test('the one manual step is spelt out as an exact click, everywhere it appears', () => {
    assert.match(HOW_TO_ALLOW, /System Settings/);
    assert.match(HOW_TO_ALLOW, /Accessibility/);
    assert.match(describeMacos({ darwin: true, allowed: false }), /System Settings/);
    assert.match(describeMacos({ darwin: true, allowed: true }), /One build at a time/);
    assert.match(describeMacos({ darwin: false }), /only be read from a Mac/);
  });

  test('the description for a machine that is not a Mac points at the Electron adapter', () => {
    assert.match(describeMacos({ darwin: false }), /Electron/);
  });
});

describe('an irreversible journey is refused rather than walked carefully', () => {
  test('nothing runs, and it is reported as a hole rather than a pass', async () => {
    const seen = await macosAdapter.run(
      { name: 'buy-it', describe: 'buy the thing', source: 'recorded', surface: 'macos', irreversible: true },
      { build: { id: 'b', label: 'b', role: 'candidate', root: '/p' }, root: '/p', ready: true, why: 'ready', facts: { app: '/x/T.app', executable: '/x/T.app/Contents/MacOS/T', name: 'T' }, dispose: async () => {} },
      { scratchDir: '/tmp', evidenceDir: '/tmp', seed: 1, clock: 'now', config: {} },
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].meta.refused, true);
    assert.equal(seen[0].meta.refusedWhy.includes('irreversible'), true);
    assert.match(seen[0].meta.describe, /It was not run at all/);
    assert.match(seen[0].meta.describe, /not a pass/);
  });

  test('a build that was never made ready reports a hole, not an empty screen', async () => {
    const seen = await macosAdapter.run(
      { name: 'open-the-app', describe: 'open the app', source: 'code', surface: 'macos' },
      { build: { id: 'b', label: 'b', role: 'candidate', root: '/p' }, root: '/p', ready: false, why: 'no app was named', dispose: async () => {} },
      { scratchDir: '/tmp', evidenceDir: '/tmp', seed: 1, clock: 'now', config: {} },
    );
    assert.equal(seen[0].meta.refused, true);
    assert.match(seen[0].meta.describe, /no app was named/);
  });
});
