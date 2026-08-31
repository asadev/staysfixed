/**
 * The half of the macOS adapter that touches the machine.
 *
 * Everything here either runs a program or parses what one printed. The adapter next door
 * decides what any of it MEANS. They are split because the parsing is the part that has to be
 * tested without a Mac app on screen, and a test that needs a window open is a test nobody
 * runs.
 *
 * The measurements that shaped all of this were taken on 2026-08-31 and are written down in
 * the opening comment of `macos.js`. The short version: the accessibility layer is already on
 * every Mac, it is reachable from `osascript` with nothing installed, and it costs about four
 * milliseconds per control.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sizeBucket } from './contract.js';
import { endOfChild, letGoOf } from './process.js';

// ---------------------------------------------------------------------------
// Numbers, and where each one came from
// ---------------------------------------------------------------------------

/**
 * How many controls to read from one window before stopping and saying so.
 *
 * Windows can afford 4000 because UI Automation reads a whole cached subtree in one pass at
 * about 2ms a control. macOS has no cached subtree read at all — every attribute is a live
 * Mach round trip into the app being watched — and it was measured at 3.9ms a control on this
 * machine. 4000 of those is sixteen seconds for ONE read, and the settle loop reads more than
 * once, so the same cap here would mean a minute and a half per window. 1500 keeps a full read
 * near six seconds, which is the same order as everything else this tool does. Anything past
 * it is reported as unchecked, never as absent.
 */
export const MAX_TREE_NODES = 1500;

/**
 * The wall clock the probe stops at whatever it has read.
 *
 * The cap above is a count, and a count is not enough on its own: one app answering slowly
 * turns 1500 controls into an unbounded wait. Activity Monitor, measured on this machine, had
 * read 5,251 controls after twenty seconds and had not finished. So there is a clock as well as
 * a count, and hitting either one is reported.
 */
export const TREE_BUDGET_MS = 12_000;

/**
 * How long any single accessibility question may take before it is abandoned.
 *
 * `AXUIElementSetMessagingTimeout` is the only thing standing between this tool and an app
 * that has stopped pumping its event loop. Without it a hung app hangs the run, because every
 * AX read is a synchronous message into that app's main thread. Two seconds is long enough for
 * a busy app and short enough that a dead one is noticed rather than waited on.
 */
export const AX_MESSAGE_TIMEOUT_S = 2;

/** How long to let an app get its first window up before calling it a no-show. */
export const WINDOW_WAIT_MS = 20_000;

/** A window picture bigger than this is dropped rather than carried back inline. */
export const MAX_SHOT_BYTES = 4 * 1024 * 1024;

/** How long one probe call may take overall, including `osascript`'s own 110-150ms start. */
const PROBE_LIMIT_MS = 60_000;

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/**
 * The JavaScript-for-Automation program that reads the screen.
 *
 * It is fed to `osascript -l JavaScript` on STANDARD INPUT, with one JSON argument after it,
 * so nothing is ever written to disk: there is nothing left behind, nothing to go stale, and
 * nothing for the person who owns this Mac to find later and wonder about. That is the same
 * decision the Windows probe made, for the same reason.
 *
 * Why JavaScript for Automation and not a compiled Swift probe. The design assumed a small
 * Swift binary would have to be built and shipped, exactly as the Windows design assumed a
 * .NET one. It was checked on a real Mac on 2026-08-31 before a line was written, and it is
 * the wrong answer for three reasons. `osascript` is on every Mac and needs no developer
 * tools, while `swiftc` needs Xcode or the Command Line Tools and most people running a
 * regression check on a Mac app do have those — but the ones who do not would be asked to
 * install four gigabytes to read a checkbox. A compiled probe would have to be signed, or
 * Gatekeeper is entitled to refuse it. And JavaScript for Automation's Objective-C bridge
 * publishes the ENTIRE accessibility C API through BridgeSupport, so the compiled version
 * would have no more reach than this one. It reads a real AppKit window in 57 milliseconds
 * with nothing installed.
 *
 * Three things are enforced inside the probe rather than in JavaScript, because this is the
 * only side that can enforce them:
 *
 *   - Every element is read with ONE round trip, not thirteen.
 *     `AXUIElementCopyMultipleAttributeValues` fetches all twelve attributes and the child
 *     list together. The first version of this asked for each attribute separately and could
 *     not finish a large window in two minutes.
 *   - Every read has a clock on it and a count on it, and says which one it hit.
 *   - The tree is cross-checked against CoreGraphics' own window list before it is believed.
 *     That is a completely different mechanism — the window server, rather than the app's own
 *     accessibility responder — which is what makes it a real second opinion rather than the
 *     same question asked twice.
 *
 * @returns {string} JavaScript for Automation, ready for `osascript -l JavaScript -`
 */
export function macosProbeScript() {
  return `
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');

// The twelve things worth knowing about a control, fetched together in one message to the
// app. AXChildren rides along in the same call so walking the tree costs nothing extra.
var WANT = ['AXRole','AXSubrole','AXTitle','AXDescription','AXValue','AXIdentifier',
            'AXEnabled','AXHelp','AXPlaceholderValue','AXSelected','AXFocused','AXChildren'];
var WANT_CF = $(WANT.map(function (n) { return $(n); }));

// An out-parameter comes back as an opaque CFTypeRef that the bridge will not let you call
// CFArrayGetCount on. castRefToObject turns it into the NSArray it really is, and the
// elements of THAT array can be handed straight back into the AX functions. Casting them
// back with castObjectToRef fails; this took an afternoon to find and is why it is written
// down here rather than left to be rediscovered.
function attr(el, name) {
  var r = Ref();
  if ($.AXUIElementCopyAttributeValue(el, $(name), r) !== 0) return null;
  return ObjC.castRefToObject(r[0]);
}

// A batched read hands back an error wrapper, not null, for anything the control does not
// have. Only strings and numbers are real answers; everything else is "it does not have one".
function plain(v) {
  if (v === null || v === undefined) return null;
  if (!v.isKindOfClass) return null;
  if (v.isKindOfClass($.NSString)) return ObjC.unwrap(v);
  if (v.isKindOfClass($.NSNumber)) return ObjC.unwrap(v);
  return null;
}

function actionsOf(el) {
  var r = Ref();
  if ($.AXUIElementCopyActionNames(el, r) !== 0) return [];
  var a = ObjC.castRefToObject(r[0]);
  var out = [];
  for (var i = 0; i < a.count; i++) out.push(ObjC.unwrap(a.objectAtIndex(i)));
  return out.sort();
}

function batch(el) {
  var r = Ref();
  if ($.AXUIElementCopyMultipleAttributeValues(el, WANT_CF, 0, r) !== 0) return null;
  return ObjC.castRefToObject(r[0]);
}

function appFor(pid) {
  var app = $.AXUIElementCreateApplication(pid);
  $.AXUIElementSetMessagingTimeout(app, ${AX_MESSAGE_TIMEOUT_S});
  return app;
}

function axWindows(app) {
  var w = attr(app, 'AXWindows');
  return w === null ? null : w;
}

// The second opinion. CoreGraphics knows what is actually on the screen because the window
// server drew it; the accessibility tree knows what the app SAYS is on the screen. When the
// two disagree the accessibility answer is not trustworthy, and a tree that is not
// trustworthy must never be stored as though it were empty.
function cgWindowsFor(pid) {
  var list = $.CGWindowListCopyWindowInfo(
    $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0);
  var arr = ObjC.castRefToObject(list);
  var out = [];
  for (var i = 0; i < arr.count; i++) {
    var d = arr.objectAtIndex(i);
    var owner = ObjC.unwrap(d.objectForKey('kCGWindowOwnerPID'));
    if (pid >= 0 && owner !== pid) continue;
    // Layer 0 is an ordinary window. Anything else is a menu, a tooltip, a shadow or a
    // status item, and counting those against the accessibility tree would make the
    // cross-check disagree for no reason.
    if (ObjC.unwrap(d.objectForKey('kCGWindowLayer')) !== 0) continue;
    out.push({
      id: ObjC.unwrap(d.objectForKey('kCGWindowNumber')),
      title: ObjC.unwrap(d.objectForKey('kCGWindowName')),
      owner: ObjC.unwrap(d.objectForKey('kCGWindowOwnerName')),
      pid: owner,
      w: Math.round(ObjC.unwrap(d.objectForKey('kCGWindowBounds').objectForKey('Width'))),
      h: Math.round(ObjC.unwrap(d.objectForKey('kCGWindowBounds').objectForKey('Height'))),
    });
  }
  return out;
}

// Depth-first with an explicit stack rather than recursion. A deep tree in a scripting
// runtime with a small stack is a crash, and a crashed probe reads exactly like an app with
// no controls.
function readTree(win, limit, budgetMs, withActions) {
  var t0 = $.NSDate.date;
  var out = [];
  var stack = [{ el: win, d: 0 }];
  var truncated = false;
  var ranOut = false;
  while (stack.length > 0) {
    if (out.length >= limit) { truncated = true; break; }
    if (-t0.timeIntervalSinceNow * 1000 > budgetMs) { ranOut = true; break; }
    var cur = stack.pop();
    var b = batch(cur.el);
    if (b === null) continue;
    out.push({
      d: cur.d,
      role: plain(b.objectAtIndex(0)),
      sub: plain(b.objectAtIndex(1)),
      title: plain(b.objectAtIndex(2)),
      desc: plain(b.objectAtIndex(3)),
      value: plain(b.objectAtIndex(4)),
      id: plain(b.objectAtIndex(5)),
      on: plain(b.objectAtIndex(6)),
      help: plain(b.objectAtIndex(7)),
      hint: plain(b.objectAtIndex(8)),
      sel: plain(b.objectAtIndex(9)),
      foc: plain(b.objectAtIndex(10)),
      can: withActions ? actionsOf(cur.el) : [],
    });
    var kids = b.objectAtIndex(11);
    if (kids && kids.isKindOfClass && kids.isKindOfClass($.NSArray)) {
      for (var k = kids.count - 1; k >= 0; k--) stack.push({ el: kids.objectAtIndex(k), d: cur.d + 1 });
    }
  }
  return { nodes: out, truncated: truncated, ranOut: ranOut,
           ms: Math.round(-t0.timeIntervalSinceNow * 1000) };
}

// What the window says it is, boiled down to one string, used only to decide whether two
// readings in a row agree. Actions are left out on purpose: fetching them is a second round
// trip per control, it is about a third of the whole cost, and nothing about a control's
// action list changes while a window is settling.
function signature(win, limit, budgetMs) {
  var t = readTree(win, limit, budgetMs, false);
  var parts = [];
  for (var i = 0; i < t.nodes.length; i++) {
    var n = t.nodes[i];
    parts.push(n.role + '/' + n.title + '/' + n.desc + '/' + n.value + '/' + n.on + '/' + n.sel);
  }
  return { key: parts.join('|'), tree: t };
}

// A control is found by what it IS and what it is CALLED, never by where it sits. An index
// would be stable right up until somebody adds a control above it.
function findControl(el, wanted, depth) {
  if (depth > 60) return null;
  var b = batch(el);
  if (b === null) return null;
  var id = plain(b.objectAtIndex(5));
  var role = plain(b.objectAtIndex(0));
  var title = plain(b.objectAtIndex(2));
  var desc = plain(b.objectAtIndex(3));
  if (id !== null && id === wanted) return el;
  if (title !== null && title === wanted) return el;
  if (desc !== null && desc === wanted) return el;
  if (role !== null && title !== null && (role + ':' + title) === wanted) return el;
  var kids = b.objectAtIndex(11);
  if (kids && kids.isKindOfClass && kids.isKindOfClass($.NSArray)) {
    for (var i = 0; i < kids.count; i++) {
      var hit = findControl(kids.objectAtIndex(i), wanted, depth + 1);
      if (hit !== null) return hit;
    }
  }
  return null;
}

function findInApp(app, wanted) {
  var wins = axWindows(app);
  if (wins === null) return null;
  for (var i = 0; i < wins.count; i++) {
    var hit = findControl(wins.objectAtIndex(i), wanted, 0);
    if (hit !== null) return hit;
  }
  return null;
}

// How much of a picture is not black. A locked screen, or a Mac with no screen-recording
// permission, hands back a window picture that is entirely black, and reporting that as
// evidence would be reporting a blank page as a photograph.
function litPixels(file) {
  var img = $.NSImage.alloc.initWithContentsOfFile(file);
  if (!img || img.isNil()) return -1;
  var tiff = img.TIFFRepresentation;
  if (!tiff || tiff.isNil()) return -1;
  var rep = $.NSBitmapImageRep.imageRepWithData(tiff);
  if (!rep || rep.isNil()) return -1;
  // NSNumber-ish values come back through the bridge as strings often enough that every one
  // of them is put through Number() here rather than trusted.
  var w = Number(rep.pixelsWide), h = Number(rep.pixelsHigh);
  if (!(w > 1) || !(h > 1)) return -1;
  var lit = 0;
  // Two big primes as strides, so the 200 samples are spread over the whole picture rather
  // than over one band of it, and so the SAME pixels are sampled on both builds.
  for (var i = 0; i < 200; i++) {
    var c = rep.colorAtXY((i * 7919) % w, (i * 104729) % h);
    if (c && !c.isNil() && (Number(c.redComponent) + Number(c.greenComponent) + Number(c.blueComponent)) > 0.12) lit++;
  }
  return lit;
}

function run(argv) {
  var req;
  try { req = JSON.parse(argv[0]); } catch (e) { return JSON.stringify({ ok: false, error: 'the request was not readable json' }); }
  var t0 = $.NSDate.date;
  var reply = { ok: true, op: req.op };
  try {
    if (req.op === 'running') {
      // NSWorkspace is the only thing that knows a running process's BUNDLE IDENTIFIER, and the
      // bundle identifier is what actually collides: two builds of one app live in two folders
      // and run two different executables, but they declare the same identifier, and that is
      // what makes one of them stop answering the accessibility layer.
      var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
      var rows = [];
      for (var a = 0; a < apps.count; a++) {
        var ra = apps.objectAtIndex(a);
        var bid = ra.bundleIdentifier;
        if (!bid || bid.isNil()) continue;
        rows.push({
          pid: Number(ra.processIdentifier),
          bundleId: ObjC.unwrap(bid),
          path: ra.bundleURL && !ra.bundleURL.isNil() ? ObjC.unwrap(ra.bundleURL.path) : null,
        });
      }
      reply.apps = rows;

    } else if (req.op === 'hello') {
      reply.axTrusted = $.AXIsProcessTrusted();
      reply.user = ObjC.unwrap($.NSUserName());
      reply.screens = $.NSScreen.screens.count;
      var s = $.NSScreen.mainScreen;
      reply.screen = s && !s.isNil() ? (Math.round(s.frame.size.width) + 'x' + Math.round(s.frame.size.height)) : 'unknown';
      reply.macos = ObjC.unwrap($.NSProcessInfo.processInfo.operatingSystemVersionString);

    } else if (req.op === 'windows') {
      var app = appFor(req.pid);
      var wins = axWindows(app);
      var out = [];
      var n = wins === null ? 0 : wins.count;
      for (var i = 0; i < n; i++) {
        var b = batch(wins.objectAtIndex(i));
        out.push({
          title: b === null ? null : plain(b.objectAtIndex(2)),
          role: b === null ? null : plain(b.objectAtIndex(0)),
          sub: b === null ? null : plain(b.objectAtIndex(1)),
          index: i,
        });
      }
      reply.windows = out;
      reply.axCount = n;
      reply.onScreen = cgWindowsFor(req.pid);

    } else if (req.op === 'settle') {
      var app2 = appFor(req.pid);
      var wins2 = axWindows(app2);
      if (wins2 === null || req.index >= wins2.count) {
        reply.ok = false;
        reply.error = 'that window is not on the screen any more';
      } else {
        var win = wins2.objectAtIndex(req.index);
        // A cheap signature, repeatedly, until two in a row match. Then ONE full read with
        // the action lists, which is the expensive part and is only worth paying for once.
        var last = '';
        var agreed = false;
        var reads = 0;
        while (reads < req.tries) {
          reads++;
          var sig = signature(win, req.limit, req.budgetMs);
          if (reads > 1 && sig.key === last) { agreed = true; break; }
          last = sig.key;
          $.NSThread.sleepForTimeInterval(req.gapMs / 1000);
        }
        var full = readTree(win, req.limit, req.budgetMs, true);
        // The count from a different call than the one that built the tree. When a window
        // hands back a tree of one node while claiming a dozen children, the read is broken.
        var cr = Ref();
        var childCount = $.AXUIElementGetAttributeValueCount(win, $('AXChildren'), cr) === 0 ? cr[0] : -1;
        reply.agreed = agreed;
        reply.reads = reads;
        reply.nodes = full.nodes;
        reply.truncated = full.truncated;
        reply.ranOut = full.ranOut;
        reply.readMs = full.ms;
        reply.childCount = childCount;
        reply.onScreen = cgWindowsFor(req.pid);
      }

    } else if (req.op === 'press') {
      var app3 = appFor(req.pid);
      var target = findInApp(app3, req.control);
      if (target === null) {
        reply.ok = false;
        reply.error = 'no control on screen is called "' + req.control + '"';
      } else {
        var actions = actionsOf(target);
        var wantAction = req.action || 'AXPress';
        if (actions.indexOf(wantAction) === -1) {
          reply.ok = false;
          reply.error = 'the control "' + req.control + '" cannot be asked to ' + wantAction
            + '; it can only be asked to ' + (actions.length === 0 ? 'do nothing' : actions.join(', '));
        } else {
          var e = $.AXUIElementPerformAction(target, $(wantAction));
          reply.ok = e === 0;
          if (e !== 0) reply.error = 'the app refused the ' + wantAction + ' (accessibility error ' + e + ')';
        }
      }

    } else if (req.op === 'set') {
      var app4 = appFor(req.pid);
      var target2 = findInApp(app4, req.control);
      if (target2 === null) {
        reply.ok = false;
        reply.error = 'no control on screen is called "' + req.control + '"';
      } else {
        var settable = Ref();
        $.AXUIElementIsAttributeSettable(target2, $('AXValue'), settable);
        if (!settable[0]) {
          reply.ok = false;
          reply.error = 'the control "' + req.control + '" will not let anything change its value';
        } else {
          var e2 = $.AXUIElementSetAttributeValue(target2, $('AXValue'), $(String(req.value)));
          reply.ok = e2 === 0;
          if (e2 !== 0) reply.error = 'the app refused the new value (accessibility error ' + e2 + ')';
        }
      }

    } else if (req.op === 'lit') {
      var lit = {};
      for (var f = 0; f < req.files.length; f++) lit[req.files[f]] = litPixels(req.files[f]);
      reply.lit = lit;

    } else {
      reply.ok = false;
      reply.error = 'nothing here knows how to do ' + req.op;
    }
  } catch (err) {
    reply.ok = false;
    reply.error = String(err && err.message ? err.message : err);
  }
  reply.ms = Math.round(-t0.timeIntervalSinceNow * 1000);
  return JSON.stringify(reply);
}
`;
}

// ---------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Ran
 * @property {number|null} code
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 * @property {string} why
 * @property {number} ms
 */

/**
 * Run a program with a limit on it and no shell in the way.
 *
 * Deliberately not `runCommand` from process.js, which goes through a shell. Everything this
 * adapter runs takes an argument that came from somebody's config — an app path, a control
 * name, a whole JSON request — and a shell between here and there is a quoting bug waiting to
 * become an executed command.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {object} [opts]
 * @param {number} [opts.limitMs]
 * @param {string} [opts.stdin]
 * @param {string} [opts.what]
 * @returns {Promise<Ran>}
 */
export async function runQuietly(file, args, opts = {}) {
  const started = Date.now();
  const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  /** @type {Buffer[]} */
  const out = [];
  /** @type {Buffer[]} */
  const err = [];
  child.stdout?.on('data', (c) => out.push(c));
  child.stderr?.on('data', (c) => err.push(c));
  child.on('error', (e) => err.push(Buffer.from(`${e.message}\n`)));
  if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  else child.stdin?.end();

  const ended = await endOfChild(child, {
    limitMs: opts.limitMs ?? PROBE_LIMIT_MS,
    what: opts.what ?? `${file} ${args[0] ?? ''}`.trim(),
  });
  letGoOf(child);
  return {
    code: ended.code,
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8'),
    timedOut: ended.gaveUp,
    why: ended.why,
    ms: Date.now() - started,
  };
}

/**
 * Read one reply out of what `osascript` printed.
 *
 * Split out from the call so it can be tested with a fixture. It matters that a probe which
 * printed nothing, printed a syntax error, or was killed for taking too long all come back as
 * DIFFERENT sentences: they are three different faults and lumping them together is how a
 * person ends up staring at "the probe failed" for an hour.
 *
 * @param {Ran} ran
 * @returns {Record<string, any>}
 */
export function readProbeReply(ran) {
  if (ran.timedOut) {
    return { ok: false, error: `the screen reader was stopped for taking too long: ${ran.why}` };
  }
  const text = ran.stdout.trim();
  if (text === '') {
    const complaint = ran.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300);
    return { ok: false, error: complaint === '' ? 'the screen reader printed nothing at all' : `the screen reader stopped: ${complaint}` };
  }
  // `osascript` prints the returned value on the last line; a script that logged on the way
  // through puts its noise before it, and taking the whole thing would fail to parse.
  const last = text.split('\n').filter((l) => l.trim() !== '').pop() ?? '';
  try {
    return JSON.parse(last);
  } catch {
    return { ok: false, error: `the screen reader answered something that was not readable: ${last.slice(0, 200)}` };
  }
}

/**
 * Ask the screen one question.
 *
 * The script goes in on standard input and the request goes in as one argument, which is what
 * `osascript -l JavaScript -` supports and what keeps the request out of any shell's hands.
 *
 * @param {Record<string, any>} request
 * @param {object} [opts]
 * @param {number} [opts.limitMs]
 * @returns {Promise<Record<string, any>>}
 */
export async function askTheScreen(request, opts = {}) {
  const ran = await runQuietly('/usr/bin/osascript', ['-l', 'JavaScript', '-', JSON.stringify(request)], {
    stdin: macosProbeScript(),
    limitMs: opts.limitMs ?? PROBE_LIMIT_MS,
    what: `reading the screen (${request.op})`,
  });
  return readProbeReply(ran);
}

// ---------------------------------------------------------------------------
// The app bundle
// ---------------------------------------------------------------------------

/**
 * What is inside a `.app`, as far as this adapter cares.
 *
 * @typedef {object} BundleFacts
 * @property {boolean} ok
 * @property {string} why
 * @property {string} [executable]   Full path to the program inside the bundle.
 * @property {string} [name]         What the bundle calls itself.
 * @property {boolean} [electron]    True when this is a Chromium shell wearing a Mac icon.
 * @property {string} [bundleId]     What the app calls itself to the system. Two builds of one
 *                                   app share this, and sharing it is what breaks them.
 */

/**
 * Decide what a bundle is from the two files that actually say so.
 *
 * Split from the disk read so a test can hand it a plist and a file listing.
 *
 * @param {string} appPath
 * @param {string} plistXml           Contents of Contents/Info.plist.
 * @param {string[]} frameworkNames   Names inside Contents/Frameworks, when there are any.
 * @returns {BundleFacts}
 */
export function readBundle(appPath, plistXml, frameworkNames) {
  // Electron on macOS ships a framework with exactly this name, and it has done for every
  // version anybody still runs. Finding it is not a failure — it is this adapter working out
  // that a better tool for the job is already in the box and saying which one.
  const electron = frameworkNames.some((n) => /^Electron Framework\.framework$/i.test(n));
  const match = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plistXml);
  if (!match) {
    return {
      ok: false,
      electron,
      why: `${appPath} has no CFBundleExecutable in its Info.plist, so nothing here knows which program inside it to open.`,
    };
  }
  const nameMatch = /<key>CFBundleName<\/key>\s*<string>([^<]+)<\/string>/.exec(plistXml);
  // The bundle identifier matters more here than anywhere else in this adapter. Two builds
  // being compared sit in two folders and run two different files, so nothing about their paths
  // says they are the same app — but they declare the same identifier, and THAT is what makes
  // one of them go silent when both are open. It is read out here so `prepare` can look for
  // other copies of the same app rather than other copies of the same file.
  const idMatch = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plistXml);
  return {
    ok: true,
    electron,
    executable: path.join(appPath, 'Contents', 'MacOS', match[1]),
    name: nameMatch ? nameMatch[1] : path.basename(appPath, '.app'),
    bundleId: idMatch ? idMatch[1] : undefined,
    why: `${appPath} opens ${match[1]}.`,
  };
}

/**
 * Look inside a `.app` on disk.
 * @param {string} appPath
 * @returns {Promise<BundleFacts>}
 */
export async function inspectBundle(appPath) {
  /** @type {string} */
  let plist;
  try {
    plist = await fsp.readFile(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
  } catch {
    return { ok: false, electron: false, why: `There is no readable app bundle at ${appPath}.` };
  }
  /** @type {string[]} */
  let frameworks = [];
  try {
    frameworks = await fsp.readdir(path.join(appPath, 'Contents', 'Frameworks'));
  } catch { /* plenty of apps have no frameworks folder at all */ }
  return readBundle(appPath, plist, frameworks);
}

// ---------------------------------------------------------------------------
// Starting and stopping
// ---------------------------------------------------------------------------

/**
 * Which running processes are this exact program.
 *
 * Matched on the FULL executable path, never on the app's name. Two builds of the same app
 * being compared have the same name and different paths, and picking the wrong one produces a
 * run that reads the old build and reports it as the new one — a pass that means nothing.
 *
 * @param {string} psOutput   Output of `ps -axo pid=,comm=`.
 * @param {string} executable
 * @returns {number[]}
 */
export function pidsRunning(psOutput, executable) {
  /** @type {number[]} */
  const found = [];
  for (const line of psOutput.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const space = trimmed.indexOf(' ');
    if (space < 0) continue;
    const pid = Number(trimmed.slice(0, space));
    const command = trimmed.slice(space + 1).trim();
    if (Number.isInteger(pid) && command === executable) found.push(pid);
  }
  return found;
}

/**
 * Every process this run is responsible for, walked down from the ones it started.
 *
 * The command line is kept, because "it now launches its updater with a different flag" is
 * exactly the kind of change no screenshot has ever caught.
 *
 * @param {string} psOutput   Output of `ps -axo pid=,ppid=,comm=`.
 * @param {number[]} roots
 * @returns {{pid: number, parent: number, command: string}[]}
 */
export function descendantsOf(psOutput, roots) {
  /** @type {{pid: number, parent: number, command: string}[]} */
  const all = [];
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    all.push({ pid: Number(m[1]), parent: Number(m[2]), command: m[3].trim() });
  }
  const mine = new Set(roots);
  // Repeated passes rather than one, because `ps` lists in pid order and a grandchild can be
  // listed before its parent. Bounded by the depth of the tree, which is never deep.
  for (let pass = 0; pass < 8; pass++) {
    let grew = false;
    for (const row of all) {
      if (mine.has(row.parent) && !mine.has(row.pid)) { mine.add(row.pid); grew = true; }
    }
    if (!grew) break;
  }
  return all.filter((row) => mine.has(row.pid) && !roots.includes(row.pid));
}

/**
 * Open a Mac app WITHOUT taking the screen away from whoever is using this machine.
 *
 * `open -g` is the whole reason this goes through LaunchServices rather than spawning the
 * program directly. Measured on 2026-08-31: the same binary, spawned directly twice, left the
 * foreground alone the first time and TOOK it the second. Non-deterministic foreground theft
 * is worse than deterministic foreground theft, because it passes a test. `-g` is a promise
 * from the system rather than a hope about the app.
 *
 * `-n` makes a second copy open even when one is already running, which is what comparing two
 * builds of the same app needs. `-o` and `--stderr` catch what the app prints, which is the
 * only reason not spawning it directly costs anything at all.
 *
 * @param {object} spec
 * @param {string} spec.appPath
 * @param {string[]} [spec.args]
 * @param {string} spec.stdoutFile
 * @param {string} spec.stderrFile
 * @returns {Promise<Ran>}
 */
export async function openInTheBackground(spec) {
  const args = ['-g', '-n', '-o', spec.stdoutFile, '--stderr', spec.stderrFile, '-a', spec.appPath];
  if (spec.args && spec.args.length > 0) args.push('--args', ...spec.args);
  return runQuietly('/usr/bin/open', args, { limitMs: 30_000, what: `opening ${path.basename(spec.appPath)}` });
}

/**
 * Ask one process to quit, then insist, then give up — and only ever one this run started.
 *
 * @param {number} pid
 * @param {(m: string) => void} [log]
 * @returns {Promise<'quit'|'forced'|'was already gone'>}
 */
export async function stopOne(pid, log) {
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  if (!alive()) return 'was already gone';
  try { process.kill(pid, 'SIGTERM'); } catch { return 'was already gone'; }
  for (let i = 0; i < 40; i++) {
    if (!alive()) return 'quit';
    await new Promise((r) => setTimeout(r, 100));
  }
  log?.(`The app would not quit when asked, so it was stopped outright (pid ${pid}).`);
  try { process.kill(pid, 'SIGKILL'); } catch { /* it went in the meantime */ }
  return 'forced';
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/**
 * Take a picture of one window by its window-server id.
 *
 * `-x` keeps the shutter sound quiet, `-o` leaves the drop shadow off so two builds are not
 * compared through different amounts of blur, and `-l` names one window rather than grabbing
 * the screen. Measured at 190ms for a 63KB picture, and the frontmost app did not change —
 * which is the property that matters, because a check that takes the screen is a check nobody
 * can run while they are working.
 *
 * @param {number} windowId
 * @param {string} file
 * @returns {Promise<{ok: boolean, why: string, bytes: number}>}
 */
export async function pictureOfWindow(windowId, file) {
  const ran = await runQuietly('/usr/sbin/screencapture', ['-x', '-o', '-l', String(windowId), file], {
    limitMs: 20_000,
    what: `a picture of window ${windowId}`,
  });
  try {
    const stat = await fsp.stat(file);
    if (stat.size === 0) return { ok: false, why: 'the picture came back empty', bytes: 0 };
    return { ok: true, why: `A picture ${sizeBucket(stat.size)} was taken.`, bytes: stat.size };
  } catch {
    const complaint = `${ran.stderr}`.trim().split('\n').pop() ?? '';
    return {
      ok: false,
      bytes: 0,
      why: complaint === ''
        ? 'no picture file was written, which on a Mac usually means this program has not been given Screen Recording permission'
        : complaint.slice(0, 200),
    };
  }
}

// ---------------------------------------------------------------------------
// Complaints
// ---------------------------------------------------------------------------

/** Where macOS files the report when a program falls over. */
export const CRASH_FOLDER = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');

/**
 * Pull the two lines out of a crash report that say what happened.
 *
 * A `.ips` file is a JSON header line followed by a second JSON body, and the body is
 * enormous — every thread, every frame, every loaded binary. None of that belongs in a
 * comparison: the addresses differ on every run and would report a regression every time. What
 * is kept is the exception type and the reason, which is the part that changes when the crash
 * changes.
 *
 * @param {string} text
 * @returns {{app: string|null, when: string|null, exception: string|null, reason: string|null}}
 */
export function readCrashReport(text) {
  const lines = text.split('\n');
  /** @type {any} */
  let head = {};
  try { head = JSON.parse(lines[0]); } catch { /* an unreadable header still leaves a body */ }
  /** @type {any} */
  let body = {};
  try { body = JSON.parse(lines.slice(1).join('\n')); } catch { /* older reports are plain text */ }
  const exception = body?.exception?.type ?? body?.termination?.indicator ?? null;
  const reason = body?.exception?.signal ?? body?.termination?.reason ?? head?.bug_type ?? null;
  return {
    app: head?.app_name ?? head?.procname ?? null,
    when: head?.timestamp ?? null,
    exception: exception === null ? null : String(exception),
    reason: reason === null ? null : String(reason).slice(0, 300),
  };
}

/**
 * Crash reports filed for one app since a moment.
 *
 * @param {string} appName
 * @param {number} sinceMs
 * @param {string} [folder]
 * @returns {Promise<{file: string, app: string|null, exception: string|null, reason: string|null}[]>}
 */
export async function crashesSince(appName, sinceMs, folder = CRASH_FOLDER) {
  /** @type {string[]} */
  let names = [];
  try { names = await fsp.readdir(folder); } catch { return []; }
  /** @type {{file: string, app: string|null, exception: string|null, reason: string|null}[]} */
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.ips')) continue;
    if (!name.toLowerCase().startsWith(`${appName.toLowerCase()}-`)) continue;
    const full = path.join(folder, name);
    try {
      const stat = await fsp.stat(full);
      if (stat.mtimeMs < sinceMs) continue;
      const parsed = readCrashReport(await fsp.readFile(full, 'utf8'));
      out.push({ file: full, app: parsed.app, exception: parsed.exception, reason: parsed.reason });
    } catch { /* a report being written as we read it is not a finding */ }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/**
 * Keep only the log lines worth comparing, and say how many were thrown away.
 *
 * The unified log is a firehose: a five-second run of a trivial AppKit app produced pages of
 * XPC connection chatter with pointer addresses in it, and every one of those addresses is
 * different on every run. Comparing them would make every run differ from every other run,
 * which is the fastest way to teach somebody to ignore this tool. So only what the app itself
 * complained about is kept, the addresses are rubbed out, and the number dropped is reported
 * rather than hidden.
 *
 * @param {string} text   Output of `log show --style compact`.
 * @returns {{kept: string[], dropped: number}}
 */
export function worthKeepingFromLog(text) {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  /** @type {string[]} */
  const kept = [];
  let dropped = 0;
  for (const line of lines) {
    // The compact style puts a two-letter level after the timestamp: Df debug, I info,
    // Er error, Fa fault. Only the last two are ever a complaint about the product.
    const level = / (Er|Fa) /.exec(line);
    if (!level) { dropped++; continue; }
    const cleaned = line
      // Pointers, object addresses and thread ids differ on every run of identical code.
      .replace(/0x[0-9a-f]{4,}/gi, '0x…')
      .replace(/\[\d+:[0-9a-f]+\]/g, '[…]')
      // The timestamp at the front is the run, not the product.
      .replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s*/, '');
    kept.push(cleaned.slice(0, 300));
  }
  return { kept: [...new Set(kept)].sort(), dropped };
}

/**
 * What one process complained about into the unified log while it ran.
 *
 * Measured at 1.93 seconds on this machine for a two-minute window on one pid, which is real
 * but affordable once per journey.
 *
 * Called as `/usr/bin/log`, spelt out, because `log` is a shell builtin in zsh and calling it
 * by name gets a builtin that does something else entirely.
 *
 * @param {number} pid
 * @param {number} sinceMs
 * @returns {Promise<{kept: string[], dropped: number, ok: boolean, why: string}>}
 */
export async function loggedBy(pid, sinceMs) {
  const seconds = Math.max(1, Math.ceil((Date.now() - sinceMs) / 1000) + 5);
  const ran = await runQuietly('/usr/bin/log', [
    'show', '--last', `${seconds}s`, '--predicate', `processIdentifier == ${pid}`, '--style', 'compact',
  ], { limitMs: 45_000, what: `what the app logged (pid ${pid})` });
  if (ran.timedOut || (ran.code !== 0 && ran.stdout.trim() === '')) {
    return { kept: [], dropped: 0, ok: false, why: ran.timedOut ? ran.why : (ran.stderr.trim().slice(0, 200) || 'the log could not be read') };
  }
  return { ...worthKeepingFromLog(ran.stdout), ok: true, why: 'read' };
}

/**
 * Everything running on this Mac, once, so both `pidsRunning` and `descendantsOf` can read it.
 * @returns {Promise<{byPath: string, byParent: string}>}
 */
export async function processList() {
  const [byPath, byParent] = await Promise.all([
    runQuietly('/bin/ps', ['-axo', 'pid=,comm='], { limitMs: 15_000, what: 'the list of running programs' }),
    runQuietly('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { limitMs: 15_000, what: 'the list of running programs' }),
  ]);
  return { byPath: byPath.stdout, byParent: byParent.stdout };
}
