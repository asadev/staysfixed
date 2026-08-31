/**
 * Reading a native Linux desktop app, over the machine somebody already has.
 *
 * This file knows about the Linux accessibility bus and nothing about Stays Fixed. It finds
 * the desktop session on a machine reached over ssh, opens the app, reads the whole window
 * tree, and hands back plain objects. `linux.js` turns those into observations. Same split as
 * `ios.js`/`ios-driver.js` and for the same reason: everything hard here is a fact about the
 * platform, and platform facts are easier to keep honest when they live in one file.
 *
 * ── WHAT WAS MEASURED BEFORE ANY OF THIS WAS WRITTEN ───────────────────────────────────────
 *
 * All of it on a stock Ubuntu 24.04 machine on 2026-08-31, with NOTHING installed for the
 * purpose. This is the sibling of `windows.js`, and it was costed the same way.
 *
 *   1. THE ACCESSIBILITY SERVICE IS ALREADY THERE. `at-spi2-core` and `gdbus` come with any
 *      desktop Linux; nothing has to be installed to read a window. The address of the
 *      accessibility bus is one call:
 *        gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus \
 *              --method org.a11y.Bus.GetAddress
 *   2. `python3` AND THE `dbus` MODULE ARE ALREADY THERE — checked on two separate machines.
 *      So the probe is Python, sent down the ssh connection each run, living only in the
 *      memory of the process running it, leaving nothing on that machine's disk.
 *   3. ONE PROGRAM DOING THE WHOLE WALK IN-PROCESS IS THE DESIGN, and it is the only design.
 *      In one Python process: 190 accessible things in 305 ms — and 189 nodes read with every
 *      property, state, action and value in 562-707 ms across four runs. Shelling out to
 *      `gdbus` once per property instead: 30 things in 1343 ms. That is not slower, it is
 *      unusable. For scale, the Windows adapter reads 148 controls in 303 ms. The two
 *      platforms cost about the same.
 *   4. THE CONNECTION IS THE ONE THIS TOOL ALREADY HAS. A held ssh link to that machine
 *      answers a request in 150-250 ms, and the handshake costs 3.2 seconds once. Measured
 *      against the demo box on 2026-08-31 through `remote.js` unchanged, so this adapter adds
 *      no transport of its own.
 *
 * ── THREE TRAPS THAT COST REAL TIME, WRITTEN DOWN SO NOBODY PAYS AGAIN ─────────────────────
 *
 * A. `dbus.connection.Connection(addr)` FAILS WITH `NoReply`. It opens the socket and never
 *    performs the bus handshake, so the first method call sits there until it times out. The
 *    class that does the handshake is `dbus.bus.BusConnection(addr)`. One character of
 *    difference, twenty minutes of looking at the wrong end.
 *
 * B. `gdbus` PRINTS THE FIRST ARRAY ENTRY DIFFERENTLY FROM EVERY LATER ONE. Asking the
 *    registry for its children prints the first as `(':1.0', objectpath '/path')` and the
 *    rest as `(':1.0', '/path')`. A regex that expects the word `objectpath` every time reads
 *    a tree SIX NODES DEEP instead of 190 and reports it with total confidence — which is
 *    precisely the shape of bug this whole tool exists to catch. `parseGdbusChildren` below
 *    handles both forms and there is a test holding it down.
 *
 * C. THE BULK QUERY ANSWERS ZERO, IN ZERO MILLISECONDS, AND IS WRONG. Every application on
 *    the accessibility bus advertises `org.a11y.atspi.Collection`, whose `GetMatches` is meant
 *    to return a whole subtree in one call — the natural fast path, and the exact equivalent
 *    of the cached read the Windows adapter uses. On the machine this was built against it
 *    returned 0 objects for all five match modes, in 0 ms, while a plain walk of the same
 *    application found 189 nodes. An adapter that had trusted it would have recorded "this app
 *    has no controls", and every later run would have compared zero against zero and agreed
 *    that nothing changed. So it is NOT USED, and the cross-check below exists because of it.
 *
 * ── HOW THE READ IS CROSS-CHECKED ─────────────────────────────────────────────────────────
 *
 * Every node is read twice by two different routes: the `GetChildren` method, which builds a
 * list of children, and the `ChildCount` property, which counts them by another code path
 * inside the same bridge. Both come back in the walk that is happening anyway, so the check
 * is free. When they disagree the tree is lying about its own shape and the read is reported
 * as unchecked rather than as an answer. That is a genuine second opinion about the SHAPE of
 * the tree; it is not a second opinion about the CONTENTS of a node, and this file does not
 * claim one. Measured on the demo box: 189 nodes, 0 disagreements.
 */

import { RemoteLinkLost } from '../remote.js';

/**
 * What every reply from the Python probe starts with.
 *
 * The far side is a Python program running inside a shell inside an ssh session, and all
 * three of those write to the same stream when they feel like it: a deprecation warning from
 * a library, a GTK message about a missing theme, an at-spi warning about a stale reference.
 * Every one of those turned up during the work that produced this file. So a line either
 * starts with this and is a reply, or it does not and is kept as noise a person can read.
 * Same rule as `remote.js` uses one layer up, for the same reason.
 */
export const PROBE_SENTINEL = '#SFPY#';

/**
 * The accessibility states, in the order the bus numbers them.
 *
 * This is `AtspiStateType` from at-spi2-core, and the order is fixed by the wire protocol —
 * a state arrives as two 32-bit numbers with one bit per entry in this list, so the position
 * IS the meaning. Checked against real readings on 2026-08-31: a GTK frame came back as
 * 0x43200102, which is bits 1, 8, 21, 24, 25 and 30 — active, enabled, resizable, sensitive,
 * showing, visible. That is exactly what a window on screen should say, and it is how this
 * list was proved right rather than assumed.
 */
export const STATE_NAMES = [
  'invalid', 'active', 'armed', 'busy', 'checked', 'collapsed', 'defunct', 'editable',
  'enabled', 'expandable', 'expanded', 'focusable', 'focused', 'has tooltip', 'horizontal',
  'iconified', 'modal', 'multi line', 'multiselectable', 'opaque', 'pressed', 'resizable',
  'selectable', 'selected', 'sensitive', 'showing', 'single line', 'stale', 'transient',
  'vertical', 'visible', 'manages descendants', 'indeterminate', 'required', 'truncated',
  'animated', 'invalid entry', 'supports autocompletion', 'selectable text', 'is default',
  'visited', 'checkable', 'has popup', 'read only',
];

/**
 * The states that are compared, and therefore the ones a change in will be reported.
 *
 * Everything a person would call behaviour is in here: whether a control works, whether it is
 * ticked, whether it is open, whether it is chosen, whether it can be typed into, whether it
 * is the default. What is deliberately LEFT OUT is the handful that change with where the
 * mouse is and which window happens to be in front — `focused`, `active`, `busy`, `stale`,
 * `transient`, `opaque`, `visited`. Those flip between two readings of an unchanged app, and
 * comparing them would fill a report with movement and bury the one real difference in it.
 *
 * This is an ALLOW list rather than a block list on purpose. A version of at-spi that adds a
 * new state cannot then start flapping the report on its own; it arrives as something not yet
 * compared, which is a decision somebody makes on purpose rather than a surprise.
 */
export const COMPARED_STATES = new Set([
  'armed', 'checkable', 'checked', 'collapsed', 'defunct', 'editable', 'enabled', 'expandable',
  'expanded', 'focusable', 'has popup', 'has tooltip', 'horizontal', 'iconified',
  'indeterminate', 'invalid entry', 'is default', 'modal', 'multi line', 'multiselectable',
  'pressed', 'read only', 'required', 'selectable', 'selectable text', 'selected', 'sensitive',
  'showing', 'single line', 'supports autocompletion', 'truncated', 'vertical', 'visible',
]);

/**
 * The roles that mean "this is a window somebody is looking at".
 *
 * An application on the accessibility bus has windows as its children, and everything else
 * hanging off it — menus that have never been opened, tooltips, off-screen popups — is not a
 * window. Reading those as windows produces a report full of things nobody has seen.
 */
export const WINDOW_ROLES = new Set(['frame', 'dialog', 'window', 'alert', 'file chooser']);

/**
 * The name of the environment variable that marks everything this tool started.
 *
 * The Windows probe keeps a list of the process ids it launched, in memory, and refuses to
 * stop anything else. This does the same job and does it better, because it survives the
 * probe exiting: every process this run starts inherits this variable, so "is this ours" is a
 * question the machine itself answers, out of `/proc`, at any later moment. Somebody's real
 * work is on that desktop and this is the line that protects it.
 */
export const RUN_MARKER = 'STAYSFIXED_RUN';

/** Past this many nodes the walk stops and says it stopped, rather than reading for ever. */
export const MAX_TREE_NODES = 4000;

/** A window picture over this size is dropped rather than carried back down the ssh link. */
export const MAX_SHOT_BYTES = 1_500_000;

// ---------------------------------------------------------------------------
// The cheap probe: is there an accessibility bus here at all
// ---------------------------------------------------------------------------

/**
 * A shell one-liner that answers "is there a desktop with an accessibility bus on this
 * machine" using only what a desktop Linux already has.
 *
 * `gdbus` and nothing else. This exists so `detect` and `doctor` can answer the question on a
 * machine that is missing the Python `dbus` module — which is the one piece that might not be
 * there — instead of reporting "no desktop" at something that has one. Detect, never ask.
 *
 * @param {{display?: string, sessionBus?: string}} [env]  What the caller already knows.
 * @returns {string} A command for `/bin/sh -c`.
 */
export function gdbusProbeCommand(env = {}) {
  const prelude = [
    env.display ? `export DISPLAY='${env.display}'` : '',
    env.sessionBus ? `export DBUS_SESSION_BUS_ADDRESS='${env.sessionBus}'` : '',
  ].filter(Boolean).join('; ');
  const body = [
    // The screen question comes FIRST and gates everything after it. See the note in the probe
    // about a screenless machine: asking a bare user session for the accessibility bus starts
    // an empty one, and then reports it as a desktop.
    "SCREEN=no; for f in /proc/[0-9]*/environ; do if tr '\\0' '\\n' < \"$f\" 2>/dev/null |"
      + " grep -qE '^(DISPLAY|WAYLAND_DISPLAY)=.'; then SCREEN=yes; break; fi; done",
    (env.display ? 'SCREEN=yes' : 'true'),
    'echo "SCREEN $SCREEN"',
    'if [ "$SCREEN" != yes ]; then exit 0; fi',
    'ADDR=$(gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus'
      + ' --method org.a11y.Bus.GetAddress 2>&1)',
    'echo "ADDRESS $ADDR"',
    'BUS=$(printf %s "$ADDR" | sed "s/^(.//; s/.,)$//")',
    'gdbus call --address "$BUS" --dest org.a11y.atspi.Registry'
      + ' --object-path /org/a11y/atspi/accessible/root'
      + ' --method org.a11y.atspi.Accessible.GetChildren 2>&1 | sed "s/^/APPS /"',
  ].join('; ');
  return prelude ? `${prelude}; ${body}` : body;
}

/**
 * Pull the accessibility bus address out of what `gdbus` printed.
 *
 * `gdbus` prints a one-string reply as `('unix:path=/run/user/0/at-spi/bus_99',)`, and prints
 * a failure as a sentence on the same stream. Returning the sentence as if it were an address
 * would send the next call at a socket path made of English, so anything that is not an
 * address comes back as null and the caller says the bus was not found.
 *
 * @param {string} text  Whatever the command printed.
 * @returns {string|null}
 */
export function parseGdbusAddress(text) {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.startsWith('ADDRESS ')) ?? text;
  const found = /'((?:unix:|tcp:)[^']*)'/.exec(line);
  return found ? found[1] : null;
}

/**
 * Pull the list of applications out of what `gdbus` printed for `GetChildren`.
 *
 * TRAP B, AND THE WHOLE REASON THIS IS A FUNCTION WITH A TEST RATHER THAN A REGEX INLINE.
 * `gdbus` writes the FIRST entry of an array of `(so)` pairs with its type spelled out and
 * every later one without it:
 *
 *     ([(':1.0', objectpath '/org/a11y/atspi/accessible/root'), (':1.4', '/org/...root')],)
 *
 * A pattern that requires `objectpath` matches only the first entry, so a desktop running six
 * applications reads as one. Nothing errors, nothing is empty, and the answer is wrong — a
 * quiet, confident, wrong answer, which is the failure this product exists to prevent. So the
 * word is optional here, and `test/v2/linux.test.js` holds it down with both shapes.
 *
 * @param {string} text
 * @returns {{bus: string, path: string}[]}
 */
export function parseGdbusChildren(text) {
  /** @type {{bus: string, path: string}[]} */
  const out = [];
  const pair = /\('([^']*)',\s*(?:objectpath\s*)?'([^']*)'\)/g;
  let hit = pair.exec(text);
  while (hit !== null) {
    out.push({ bus: hit[1], path: hit[2] });
    hit = pair.exec(text);
  }
  return out;
}

/**
 * @typedef {object} DesktopProbe
 * @property {boolean} hasBus        An accessibility bus answered.
 * @property {string|null} address   Where it is, when it answered.
 * @property {number} apps           How many applications are on it.
 * @property {string} why            Plain English, always filled in.
 */

/**
 * Read the cheap probe's output into an answer.
 *
 * @param {string} stdout
 * @param {string} [stderr]
 * @returns {DesktopProbe}
 */
export function readDesktopProbe(stdout, stderr = '') {
  const all = `${stdout}\n${stderr}`;
  if (/^SCREEN no$/m.test(all)) {
    return {
      hasBus: false,
      address: null,
      apps: 0,
      why: 'There is no screen on that machine, so there is no desktop on it and nothing to read. A machine can '
        + 'have a perfectly good user session and no desktop; asking such a machine for an accessibility bus '
        + 'starts an empty one, which would look exactly like an app with no controls, so the question was not '
        + 'asked.',
    };
  }
  const address = parseGdbusAddress(all);
  if (!address) {
    const complaint = all.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ');
    return {
      hasBus: false,
      address: null,
      apps: 0,
      why: 'Nothing on that machine answered as an accessibility bus, which is what a desktop session '
        + `publishes. ${complaint ? `It said: ${complaint}` : 'It said nothing at all.'}`,
    };
  }
  const apps = parseGdbusChildren(all).length;
  return {
    hasBus: true,
    address,
    apps,
    why: apps === 0
      ? 'An accessibility bus is running on that machine but nothing at all is on it. That is normal on a desktop '
        + 'with no windows open, and it is also what a machine with no desktop looks like the moment something '
        + 'asks it this question. An app opened there would still be read.'
      : `An accessibility bus is running on that machine with ${apps} application${apps === 1 ? '' : 's'} on it, `
        + 'so a native Linux window can be opened there and read.',
  };
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/**
 * The Python program that does one job on the Linux side and prints one line of JSON.
 *
 * WHY IT IS A NEW PROCESS EACH TIME rather than a conversation held open the way the Windows
 * probe is. Python starts, imports `dbus` and connects to the bus in 113 ms, measured on the
 * demo box; a whole walk costs 600. Paying 113 ms per request buys something worth more than
 * it: there is no long-lived process of ours on somebody's desktop, nothing to leak if this
 * end dies, and the app under test is not a child of anything we are holding open — which is
 * what makes the exit code survive to be read later.
 *
 * WHAT IT REFUSES TO DO. It will not stop a process that does not carry this run's marker in
 * its environment. Not "should not" — it reads `/proc/<pid>/environ` and returns a refusal.
 * That desktop belongs to somebody.
 *
 * Written with `String.raw` so the backslashes in it are the ones Python sees.
 *
 * @returns {string} Python 3, ready to be base64ed onto the wire.
 */
export function linuxProbeScript() {
  return String.raw`
import sys, os, json, base64, time, subprocess, signal, glob, re

SENT = ${JSON.stringify(PROBE_SENTINEL)}
STATES = ${JSON.stringify(STATE_NAMES)}
WINDOW_ROLES = set(${JSON.stringify([...WINDOW_ROLES])})
MARKER = ${JSON.stringify(RUN_MARKER)}
A = 'org.a11y.atspi.Accessible'
P = 'org.freedesktop.DBus.Properties'

def emit(o):
    sys.stdout.write(SENT + json.dumps(o, default=str) + chr(10))
    sys.stdout.flush()

# --- finding the desktop session ------------------------------------------------------------
# Over ssh there is no session: no DISPLAY, no session bus, no accessibility bus. Every one of
# those lives in the environment of the processes the person's own login started. So the
# session is FOUND, out of /proc, rather than assumed - which is what makes this work on a
# real machine somebody is sitting at, and what makes it say so plainly on a server that has
# no desktop at all instead of reporting an empty screen.

def env_of(pid):
    try:
        with open('/proc/' + str(pid) + '/environ', 'rb') as fh:
            raw = fh.read()
    except Exception:
        return {}
    out = {}
    for part in raw.split(b'\0'):
        if b'=' in part:
            k, v = part.split(b'=', 1)
            try:
                out[k.decode('utf-8', 'replace')] = v.decode('utf-8', 'replace')
            except Exception:
                pass
    return out

def own_pids():
    me = os.getuid()
    for entry in glob.glob('/proc/[0-9]*'):
        try:
            if os.stat(entry).st_uid == me:
                yield int(entry.rsplit('/', 1)[1])
        except Exception:
            pass

def find_session(req):
    given = dict(req.get('env') or {})
    if req.get('envFile'):
        try:
            for line in open(req['envFile']):
                m = re.match(r"\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=['\"]?(.*?)['\"]?\s*$", line)
                if m and m.group(1) not in given:
                    given[m.group(1)] = m.group(2)
        except Exception:
            pass
    if given.get('DBUS_SESSION_BUS_ADDRESS'):
        return given, 'the config named it'
    seen = {}
    for pid in own_pids():
        e = env_of(pid)
        addr = e.get('DBUS_SESSION_BUS_ADDRESS')
        if not addr:
            continue
        if not (e.get('DISPLAY') or e.get('WAYLAND_DISPLAY')):
            continue
        key = (addr, e.get('DISPLAY', ''), e.get('WAYLAND_DISPLAY', ''), e.get('XDG_RUNTIME_DIR', ''))
        seen[key] = seen.get(key, 0) + 1
    if seen:
        best = sorted(seen.items(), key=lambda kv: -kv[1])[0][0]
        found = {'DBUS_SESSION_BUS_ADDRESS': best[0]}
        if best[1]:
            found['DISPLAY'] = best[1]
        if best[2]:
            found['WAYLAND_DISPLAY'] = best[2]
        if best[3]:
            found['XDG_RUNTIME_DIR'] = best[3]
        found.update(given)
        return found, 'it was read out of a running desktop process'
    runtime = given.get('XDG_RUNTIME_DIR') or ('/run/user/' + str(os.getuid()))
    if os.path.exists(runtime + '/bus'):
        found = {'DBUS_SESSION_BUS_ADDRESS': 'unix:path=' + runtime + '/bus', 'XDG_RUNTIME_DIR': runtime}
        found.update(given)
        return found, 'the session bus socket was found in the run directory'
    return given, 'no desktop session could be found on this machine'

def apply_session(session):
    for k, v in session.items():
        if v:
            os.environ[k] = v

# --- the accessibility bus ------------------------------------------------------------------

def a11y_address():
    import dbus
    # TRAP A: dbus.connection.Connection opens the socket and never performs the bus
    # handshake, so the first call hangs until it times out with NoReply. BusConnection is
    # the one that says hello.
    session = dbus.bus.BusConnection(os.environ['DBUS_SESSION_BUS_ADDRESS'])
    obj = session.get_object('org.a11y.Bus', '/org/a11y/bus', introspect=False)
    return str(dbus.Interface(obj, 'org.a11y.Bus').GetAddress())

def connect():
    import dbus
    return dbus.bus.BusConnection(a11y_address())

def state_names(pair):
    low = int(pair[0]) if len(pair) > 0 else 0
    high = int(pair[1]) if len(pair) > 1 else 0
    out = []
    for i, name in enumerate(STATES):
        word = low if i < 32 else high
        if word & (1 << (i % 32)):
            out.append(name)
    return out

# --- the walk -------------------------------------------------------------------------------
# One process, one connection, one recursive pass. See the measurements at the top of
# linux-driver.js for why it can never be a shell-out per property.

def read_tree(bus, dest, path, limit):
    import dbus
    nodes = []
    trouble = {'shape': 0, 'unreadable': 0}

    def obj(d, p):
        return bus.get_object(d, p, introspect=False)

    def one(d, p, depth):
        if len(nodes) >= limit:
            return
        o = obj(d, p)
        acc = dbus.Interface(o, A)
        props = dbus.Interface(o, P)
        try:
            all_props = props.GetAll(A)
            role = str(acc.GetRoleName())
            states = state_names(acc.GetState())
            ifaces = [str(x).replace('org.a11y.atspi.', '') for x in acc.GetInterfaces()]
        except Exception as err:
            trouble['unreadable'] += 1
            nodes.append({'role': '?', 'name': '', 'depth': depth, 'states': [], 'can': [],
                          'unreadable': str(err)[:120]})
            return
        actions = []
        if 'Action' in ifaces:
            try:
                actions = [str(x[0]) for x in dbus.Interface(o, 'org.a11y.atspi.Action').GetActions()]
            except Exception:
                pass
        value = None
        if 'Value' in ifaces:
            try:
                value = float(props.Get('org.a11y.atspi.Value', 'CurrentValue'))
            except Exception:
                pass
        text = None
        secret = False
        if 'Text' in ifaces and role in ('text', 'entry', 'password text', 'terminal', 'paragraph'):
            try:
                got = str(dbus.Interface(o, 'org.a11y.atspi.Text').GetText(0, 200))
                # A password box is read for its LENGTH and never for its contents. Somebody
                # else's password must not end up in a stored reference on this machine.
                if role == 'password text' or 'password' in str(all_props.get('Name', '')).lower():
                    secret = True
                    text = str(len(got)) + ' characters'
                else:
                    text = got
            except Exception:
                pass
        kids = []
        try:
            kids = [(str(a), str(b)) for a, b in acc.GetChildren()]
        except Exception as err:
            trouble['unreadable'] += 1
        # The free cross-check: the method that lists children and the property that counts
        # them are two code paths inside the bridge, and they must agree.
        try:
            claimed = int(all_props.get('ChildCount', len(kids)))
        except Exception:
            claimed = len(kids)
        if claimed != len(kids):
            trouble['shape'] += 1
        nodes.append({
            'role': role,
            'name': str(all_props.get('Name', '')),
            'describe': str(all_props.get('Description', '')),
            'id': str(all_props.get('AccessibleId', '')),
            'depth': depth,
            'states': states,
            'can': sorted(actions),
            'value': value,
            'text': text,
            'secret': secret,
            'kids': len(kids),
            'claimed': claimed,
        })
        if depth < 40:
            for cd, cp in kids:
                one(cd, cp, depth + 1)

    one(dest, path, 0)
    return nodes, trouble

def applications(bus):
    import dbus
    root = bus.get_object('org.a11y.atspi.Registry', '/org/a11y/atspi/accessible/root', introspect=False)
    kids = [(str(a), str(b)) for a, b in dbus.Interface(root, A).GetChildren()]
    daemon = bus.get_object('org.freedesktop.DBus', '/org/freedesktop/DBus', introspect=False)
    names = dbus.Interface(daemon, 'org.freedesktop.DBus')
    out = []
    for d, p in kids:
        pid = None
        try:
            pid = int(names.GetConnectionUnixProcessID(d))
        except Exception:
            pass
        name = ''
        toolkit = ''
        try:
            o = bus.get_object(d, p, introspect=False)
            props = dbus.Interface(o, P)
            name = str(props.Get(A, 'Name'))
            # WHAT DREW THIS WINDOW, straight from the app. This is the Linux equivalent of the
            # Chromium window class the Windows adapter looks for: an Electron app says
            # 'Chromium' here, and it is covered better and in pairs by the Electron adapter.
            toolkit = str(props.Get('org.a11y.atspi.Application', 'ToolkitName'))
        except Exception:
            pass
        out.append({'bus': d, 'path': p, 'pid': pid, 'name': name, 'toolkit': toolkit})
    return out

def extents(bus, dest, path):
    import dbus
    try:
        o = bus.get_object(dest, path, introspect=False)
        # 0 is screen coordinates. Window coordinates would give every window 0,0 and make
        # two windows on top of each other indistinguishable.
        e = dbus.Interface(o, 'org.a11y.atspi.Component').GetExtents(dbus.UInt32(0))
        return {'x': int(e[0]), 'y': int(e[1]), 'w': int(e[2]), 'h': int(e[3])}
    except Exception:
        return None

def marked_pids(run_id):
    out = []
    for pid in own_pids():
        e = env_of(pid)
        if e.get(MARKER) == run_id:
            out.append({'pid': pid, 'ppid': parent_of(pid), 'cmd': cmdline(pid), 'name': procname(pid)})
    return out

def parent_of(pid):
    try:
        # Field 4 of /proc/<pid>/stat, counting from one. Field 2 is the program name in
        # brackets and it is allowed to contain spaces and brackets, so the split has to start
        # after the LAST close bracket or a process called "sh (old)" shifts every field along.
        raw = open('/proc/' + str(pid) + '/stat').read()
        return int(raw[raw.rindex(')') + 1:].split()[1])
    except Exception:
        return 0

def cmdline(pid):
    try:
        with open('/proc/' + str(pid) + '/cmdline', 'rb') as fh:
            return ' '.join(x.decode('utf-8', 'replace') for x in fh.read().split(b'\0') if x)
    except Exception:
        return ''

def procname(pid):
    try:
        return open('/proc/' + str(pid) + '/comm').read().strip()
    except Exception:
        return '?'

# --- pixels ----------------------------------------------------------------------------------
# Evidence only, never the thing compared. Four ways to try, in the order of what a desktop is
# most likely to already have, and an honest refusal when none of them is there. Nothing here
# is worth installing something for.

def grab(box):
    try:
        import gi
        gi.require_version('Gdk', '3.0')
        from gi.repository import Gdk
        root = Gdk.get_default_root_window()
        if root is None:
            return {'ok': False, 'why': 'there is no screen to photograph on this session'}
        x = max(0, int(box.get('x', 0)))
        y = max(0, int(box.get('y', 0)))
        w = min(int(box.get('w') or root.get_width()), root.get_width() - x)
        h = min(int(box.get('h') or root.get_height()), root.get_height() - y)
        if w <= 0 or h <= 0:
            return {'ok': False, 'why': 'that window has no size on screen right now'}
        pb = Gdk.pixbuf_get_from_window(root, x, y, w, h)
        if pb is None:
            return {'ok': False, 'why': 'the screen would not give up its pixels'}
        if pb.get_width() > 1024:
            from gi.repository import GdkPixbuf
            scale = 1024.0 / pb.get_width()
            pb = pb.scale_simple(1024, max(1, int(pb.get_height() * scale)), GdkPixbuf.InterpType.BILINEAR)
        ok, buf = pb.save_to_bufferv('png', [], [])
        px = pb.get_pixels()
        lit = sum(1 for i in range(0, min(len(px), 60000), 101) if px[i] > 12)
        return {'ok': bool(ok), 'w': w, 'h': h, 'lit': lit, 'how': 'the desktop toolkit',
                'png': base64.b64encode(bytes(buf)).decode('ascii')}
    except Exception as err:
        return {'ok': False, 'why': 'no way to photograph a window is installed here (' + str(err)[:90] + ')'}

# --- what it did ------------------------------------------------------------------------------

def snap_dir(top, limit=5000):
    out = {}
    if not os.path.isdir(top):
        return out
    n = 0
    for base, dirs, files in os.walk(top):
        for f in files:
            full = os.path.join(base, f)
            try:
                out[os.path.relpath(full, top)] = os.path.getsize(full)
            except Exception:
                pass
            n += 1
            if n >= limit:
                return out
    return out

def sockets_of(pids):
    inodes = {}
    for pid in pids:
        for fd in glob.glob('/proc/' + str(pid) + '/fd/*'):
            try:
                link = os.readlink(fd)
            except Exception:
                continue
            if link.startswith('socket:['):
                inodes[link[8:-1]] = pid
    out = []
    for table in ('/proc/net/tcp', '/proc/net/tcp6'):
        try:
            lines = open(table).read().split(chr(10))[1:]
        except Exception:
            continue
        for line in lines:
            bits = line.split()
            if len(bits) < 10 or bits[9] not in inodes:
                continue
            out.append({'remote': hexaddr(bits[2]), 'state': bits[3]})
    return out

def hexaddr(field):
    host, port = field.split(':')
    port = int(port, 16)
    if len(host) == 8:
        b = [int(host[i:i + 2], 16) for i in (6, 4, 2, 0)]
        return '.'.join(str(x) for x in b) + ':' + str(port)
    return '[' + host.lower() + ']:' + str(port)

# --- the one operation this run was asked for --------------------------------------------------

def main():
    req = json.loads(base64.b64decode(sys.argv[1]).decode('utf-8')) if len(sys.argv) > 1 else {}
    op = req.get('op', 'hello')
    started = time.time()
    session, how = find_session(req)
    apply_session(session)
    took = lambda: int((time.time() - started) * 1000)

    if op == 'hello':
        distro = ''
        try:
            for line in open('/etc/os-release'):
                if line.startswith('PRETTY_NAME='):
                    distro = line.split('=', 1)[1].strip().strip('"')
        except Exception:
            pass
        screen_found = bool(session.get('DISPLAY') or session.get('WAYLAND_DISPLAY'))
        out = {'ok': True, 'op': op, 'session': session, 'how': how, 'distro': distro,
               'user': os.environ.get('USER') or str(os.getuid()), 'uid': os.getuid(),
               'screenFound': screen_found,
               'wayland': bool(session.get('WAYLAND_DISPLAY')), 'python': sys.version.split()[0]}
        try:
            import dbus
            out['dbusModule'] = True
        except Exception as err:
            out['dbusModule'] = False
            out['dbusWhy'] = str(err)[:120]
        if not session.get('DBUS_SESSION_BUS_ADDRESS'):
            out['bus'] = False
            out['why'] = 'no desktop session'
            return emit(dict(out, ms=took()))
        # A SCREENLESS MACHINE STILL HAS A BUS, AND ASKING IT A QUESTION CREATES A LIE.
        # Measured on 2026-08-31: with the whole desktop torn down, this box still had a
        # systemd user session bus at /run/user/0/bus, and asking that bus for org.a11y.Bus
        # STARTED a brand new accessibility bus with nothing on it. So "there is an
        # accessibility bus" is not the same question as "there is a desktop", and answering
        # the first one would have reported a headless server as an app with no controls -
        # after which every later run would have compared nothing against nothing and agreed.
        # A desktop is a SCREEN. No screen, no walk, and the question is not even asked, which
        # also means nothing is started on a machine that had nothing running.
        if not screen_found:
            out['bus'] = False
            out['why'] = 'there is a user session on this machine but no screen, so there is no desktop on it'
            return emit(dict(out, ms=took()))
        if not out['dbusModule']:
            out['bus'] = False
            out['why'] = 'the python dbus module is not installed here'
            return emit(dict(out, ms=took()))
        try:
            out['a11y'] = a11y_address()
            bus = connect()
            out['bus'] = True
            apps = applications(bus)
            out['apps'] = apps
            desk = extents(bus, 'org.a11y.atspi.Registry', '/org/a11y/atspi/accessible/root')
            out['screen'] = (str(desk['w']) + 'x' + str(desk['h'])) if desk else None
        except Exception as err:
            out['bus'] = False
            out['why'] = str(err)[:200]
        return emit(dict(out, ms=took()))

    if op == 'launch':
        run_id = req['run']
        folder = req.get('folder') or ('/tmp/staysfixed-linux-' + run_id)
        os.makedirs(folder, exist_ok=True)
        out_file = os.path.join(folder, 'printed.txt')
        err_file = os.path.join(folder, 'complained.txt')
        exit_file = os.path.join(folder, 'exit.txt')
        env = dict(os.environ)
        env.update(session)
        env[MARKER] = run_id
        # The three switches that make a toolkit publish its tree at all. GTK reads the first
        # two; Qt reads the third and the fourth, and without them a Qt window is invisible to
        # the accessibility bus even though the bus is running perfectly.
        env['GTK_MODULES'] = 'gail:atk-bridge'
        env['NO_AT_BRIDGE'] = '0'
        env['QT_ACCESSIBILITY'] = '1'
        env['QT_LINUX_ACCESSIBILITY_ALWAYS_ON'] = '1'
        env.update(req.get('extraEnv') or {})
        args = [str(x) for x in (req.get('args') or [])]
        # Run under a shell that records the exit code AFTER we are gone. The probe exits in a
        # moment; without this the app is reparented to init and its exit code is lost, and
        # "did it fall over" is one of the questions this adapter exists to answer.
        wrapper = '"$0" "$@"; printf %s "$?" > ' + json.dumps(exit_file)
        with open(out_file, 'wb') as so, open(err_file, 'wb') as se:
            p = subprocess.Popen(['/bin/sh', '-c', wrapper, req['exe']] + args,
                                 cwd=req.get('cwd') or None, env=env,
                                 stdout=so, stderr=se, stdin=subprocess.DEVNULL,
                                 start_new_session=True)
        return emit({'ok': True, 'op': op, 'pid': p.pid, 'folder': folder, 'out': out_file,
                     'err': err_file, 'exitFile': exit_file, 'ms': took()})

    if op == 'windows':
        bus = connect()
        apps = applications(bus)
        want = set(int(x) for x in (req.get('pids') or []))
        rows = []
        import dbus
        for app in apps:
            if want and app['pid'] not in want:
                continue
            try:
                o = bus.get_object(app['bus'], app['path'], introspect=False)
                kids = [(str(a), str(b)) for a, b in dbus.Interface(o, A).GetChildren()]
            except Exception:
                kids = []
            for cd, cp in kids:
                try:
                    co = bus.get_object(cd, cp, introspect=False)
                    role = str(dbus.Interface(co, A).GetRoleName())
                    if role not in WINDOW_ROLES:
                        continue
                    name = str(dbus.Interface(co, P).Get(A, 'Name'))
                    st = state_names(dbus.Interface(co, A).GetState())
                except Exception:
                    continue
                rows.append({'bus': cd, 'path': cp, 'role': role, 'name': name, 'app': app['name'],
                             'toolkit': app.get('toolkit', ''), 'pid': app['pid'], 'states': st,
                             'box': extents(bus, cd, cp), 'showing': 'showing' in st})
        return emit({'ok': True, 'op': op, 'windows': rows, 'apps': len(apps), 'ms': took()})

    if op == 'tree':
        bus = connect()
        limit = int(req.get('limit') or 4000)
        nodes, trouble = read_tree(bus, req['bus'], req['path'], limit)
        return emit({'ok': True, 'op': op, 'nodes': nodes, 'walked': len(nodes),
                     'shapeDisagreed': trouble['shape'], 'unreadable': trouble['unreadable'],
                     'hitLimit': len(nodes) >= limit, 'ms': took()})

    if op == 'settle':
        bus = connect()
        limit = int(req.get('limit') or 4000)
        tries = int(req.get('tries') or 6)
        gap = float(req.get('gapMs') or 250) / 1000.0
        last = None
        last_key = None
        agreed = False
        reads = 0
        while reads < tries:
            reads += 1
            nodes, trouble = read_tree(bus, req['bus'], req['path'], limit)
            key = '|'.join(n['role'] + '/' + n.get('name', '') + '/' + ','.join(n['states'])
                           for n in nodes)
            if last_key == key and reads > 1:
                agreed = True
                last = (nodes, trouble)
                break
            last_key = key
            last = (nodes, trouble)
            time.sleep(gap)
        nodes, trouble = last
        return emit({'ok': True, 'op': op, 'nodes': nodes, 'walked': len(nodes), 'reads': reads,
                     'agreed': agreed, 'shapeDisagreed': trouble['shape'],
                     'unreadable': trouble['unreadable'], 'hitLimit': len(nodes) >= limit,
                     'ms': took()})

    if op == 'shot':
        got = grab(req.get('box') or {})
        return emit(dict({'op': op, 'ms': took()}, **got))

    if op == 'after':
        run_id = req['run']
        wrapper = int(req.get('pid') or -1)
        pids = marked_pids(run_id)
        alive = any(p['pid'] == wrapper for p in pids)
        # The app itself is the wrapper's own child. Everything ELSE carrying the marker is a
        # program the app went and started, which is the thing worth reporting.
        app_pid = next((p['pid'] for p in pids if p['ppid'] == wrapper), None)
        exit_code = None
        try:
            exit_code = open(req['exitFile']).read().strip()
        except Exception:
            pass
        def slurp(name, cap=64000):
            try:
                with open(name, 'rb') as fh:
                    raw = fh.read(cap + 1)
                return raw[:cap].decode('utf-8', 'replace'), len(raw) > cap
            except Exception:
                return '', False
        printed, printed_cut = slurp(req.get('out') or '')
        complained, complained_cut = slurp(req.get('err') or '')
        dirs = {}
        for d in (req.get('dirs') or []):
            dirs[d] = snap_dir(d)
        return emit({'ok': True, 'op': op, 'running': alive, 'exit': exit_code,
                     'wrapper': wrapper, 'appPid': app_pid,
                     'procs': pids, 'printed': printed, 'printedCut': printed_cut,
                     'complained': complained, 'complainedCut': complained_cut,
                     'conns': sockets_of([p['pid'] for p in pids]), 'dirs': dirs, 'ms': took()})

    if op == 'snap':
        dirs = {}
        for d in (req.get('dirs') or []):
            dirs[d] = snap_dir(d)
        return emit({'ok': True, 'op': op, 'dirs': dirs, 'ms': took()})

    if op == 'stop':
        run_id = req['run']
        pid = int(req['pid'])
        # THE REFUSAL. Somebody's real work is on this desktop.
        if env_of(pid).get(MARKER) != run_id:
            return emit({'ok': False, 'op': op,
                         'error': 'refusing to stop a process this run did not start'})
        exit_code = None
        # ASK THE APP TO CLOSE, NOT THE WRAPPER. The little shell holding the app is what
        # writes the exit code down after the app is gone, and killing the whole group at once
        # takes the wrapper with it - so "did it fall over or close cleanly" came back empty
        # every time, which is a question this adapter exists to answer. Measured and fixed on
        # 2026-08-31. So: close the app, let the wrapper record what happened, and only reach
        # for the group if something refuses to go.
        for row in marked_pids(run_id):
            if row['pid'] == pid:
                continue
            try:
                os.kill(row['pid'], signal.SIGTERM)
            except Exception:
                pass
        for _ in range(40):
            if not os.path.exists('/proc/' + str(pid)):
                break
            time.sleep(0.1)
        forced = False
        if os.path.exists('/proc/' + str(pid)):
            forced = True
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except Exception:
                pass
        try:
            exit_code = open(req['exitFile']).read().strip()
        except Exception:
            pass
        return emit({'ok': True, 'op': op, 'forced': forced, 'exit': exit_code, 'ms': took()})

    emit({'ok': False, 'op': op, 'error': 'nothing here knows how to do ' + str(op)})

try:
    main()
except Exception as err:
    import traceback
    emit({'ok': False, 'error': str(err)[:300], 'trace': traceback.format_exc()[-600:]})
`;
}

// ---------------------------------------------------------------------------
// Talking to it
// ---------------------------------------------------------------------------

/**
 * The shell command that runs the probe once with one request.
 *
 * Both the program and the request travel as base64, which is the whole point: they pass
 * through a POSIX shell, an ssh session and Node's argument handling, and base64's alphabet
 * has no quote, dollar, backslash or newline in it for any of those three to get wrong. The
 * Windows probe travels the same way for the same reason.
 *
 * @param {string} python      Which python to use.
 * @param {string} script      The probe.
 * @param {Record<string, unknown>} request
 * @returns {string}
 */
export function probeCommand(python, script, request) {
  const program = Buffer.from(script, 'utf8').toString('base64');
  const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  return `printf %s '${program}' | base64 -d | ${python} - '${payload}'`;
}

/**
 * @typedef {object} ProbeReply
 * @property {Record<string, any>|null} reply  What the probe said, when it said anything.
 * @property {string[]} noise                  Everything else on the stream, kept verbatim.
 */

/**
 * Split what came back into the reply and the noise.
 *
 * A line either carries the sentinel and is the answer, or it does not and is noise. There is
 * no third case and no guessing. A run where the far side printed a GTK warning and nothing
 * else must come back as "it said nothing", never as an answer assembled out of a warning.
 *
 * @param {string} stdout
 * @param {string} [stderr]
 * @returns {ProbeReply}
 */
export function readProbeReply(stdout, stderr = '') {
  /** @type {Record<string, any>|null} */
  let reply = null;
  /** @type {string[]} */
  const noise = [];
  for (const line of `${stdout}\n${stderr}`.split('\n')) {
    const clean = line.trim();
    if (clean === '') continue;
    if (clean.startsWith(PROBE_SENTINEL)) {
      try {
        reply = JSON.parse(clean.slice(PROBE_SENTINEL.length));
      } catch {
        noise.push(`unreadable reply: ${clean.slice(0, 200)}`);
      }
    } else {
      noise.push(clean);
    }
  }
  return { reply, noise };
}

/**
 * One request to the Linux side, over the connection `remote.js` already holds.
 *
 * Never returns something that could be mistaken for an answer. A probe that printed nothing,
 * or printed only a warning, throws — and the adapter turns that into a hole with the reason
 * attached, which is the only honest thing to do with a screen nobody managed to read.
 *
 * @param {import('../remote.js').RemoteRunner} runner
 * @param {string} op
 * @param {Record<string, unknown>} [payload]
 * @param {{timeoutMs?: number, python?: string}} [opts]
 * @returns {Promise<Record<string, any>>}
 */
export async function askLinux(runner, op, payload = {}, opts = {}) {
  const command = probeCommand(opts.python ?? 'python3', linuxProbeScript(), { ...payload, op });
  const result = await runner.shell(command, { timeoutMs: opts.timeoutMs ?? 120_000 });
  const { reply, noise } = readProbeReply(result.stdout, result.stderr);
  if (!reply) {
    throw new RemoteLinkLost(
      runner.host,
      result.killed
        ? `the "${op}" read of that desktop was still running when time ran out`
        : `the "${op}" read of that desktop said nothing this could use`,
      noise,
    );
  }
  if (noise.length > 0) reply.noise = noise;
  return reply;
}
