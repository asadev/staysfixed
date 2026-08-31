/**
 * Native Windows applications, driven over the machine somebody already has.
 *
 * ── WHAT WAS FOUND BEFORE ANY OF THIS WAS WRITTEN ──────────────────────────────────────────
 *
 * The design costed this platform at a week and a half and assumed a small .NET probe built on
 * FlaUI, shipped as one executable. That was checked against a real Windows 11 machine on
 * 2026-08-29 before a line was written, and it is the wrong answer. Three measurements settled it.
 *
 *   1. The machine has the .NET 8 RUNTIME but no SDK. A FlaUI probe could not be built there,
 *      so it would have to be cross-built elsewhere and copied over as an unsigned executable —
 *      which is the definition of "installing something on somebody's machine", and which
 *      SmartScreen is entitled to block.
 *   2. Windows PowerShell 5.1 is already there, and it can load `UIAutomationClient` from the
 *      .NET Framework that ships with the operating system. That is the same UI Automation that
 *      FlaUI wraps. It read a real File Explorer window — 148 controls with names, roles, states
 *      and rectangles — in 303 milliseconds. Nothing was installed to do it.
 *   3. So the probe is PowerShell, sent down the connection at the start of a run, living only
 *      in the memory of the process running it, leaving nothing behind. FlaUI remains the honest
 *      upgrade path if a window ever turns out to be too big for this to read quickly, and that
 *      is a decision to make with a measurement in hand rather than in advance.
 *
 * ── WHAT IT WATCHES ────────────────────────────────────────────────────────────────────────
 *
 *   meaning     The window tree from UI Automation: what each control IS (a button, a checkbox,
 *               a list), what it is CALLED, its automation id, whether it is on, off, checked,
 *               expanded or selected, and what it says it can DO. This is the channel that
 *               answers "what does the screen say this control now does", and it is the reason
 *               the platform is worth covering at all.
 *   effects     Programs it started, and files that changed in the folders it was told to watch.
 *   complaints  Windows Error Reporting entries, application hangs, and anything the program
 *               logged to the Windows event log while it was running. Plus whether it exited.
 *   results     What a console program printed, and the titles of the windows it opened.
 *   counters    How many windows, how many controls, and how long things took, all in buckets.
 *   pixels      A picture of each window, as evidence for something another channel already found.
 *
 * ── WHAT IT CANNOT DO, SAID PLAINLY ────────────────────────────────────────────────────────
 *
 * TWO BUILDS CANNOT RUN AT ONCE. Not "should not" — cannot, in principle. UI Automation reads
 * whatever desktop is in front of it, and Windows has one. So runs are strictly sequential, and
 * the same-machine guarantee is weaker here than anywhere else: the desktop is shared with
 * whatever else that person has open, and a notification popping up during a run is a real
 * source of difference that no amount of freezing removes. The wobble measurement absorbs some
 * of it. It does not absorb all of it, and this adapter reports a run on a busy desktop as
 * exactly that.
 *
 * THERE IS NO SAFETY BOUNDARY AT THE WIRE. The CLI adapter can watch a program ask to reach the
 * internet and refuse it, because it loads a watcher inside a Node child. There is no equivalent
 * for a compiled Windows application without administrator rights, and the account this runs
 * under does not have them. So a journey marked irreversible is REFUSED OUTRIGHT here rather
 * than walked carefully — it is reported as missing coverage, and it never runs.
 *
 * FILES AND NETWORK ARE SAMPLED, NOT CAPTURED. Everything that would really capture them —
 * Process Monitor, an ETW kernel session, pktmon — needs administrator. What is left works and
 * is worth having: the folders this adapter is told to watch are compared before and after, and
 * connections belonging to the program are sampled while it runs. A file written outside those
 * folders is not seen. A connection that opens and closes between two samples is not seen. Both
 * are reported as holes, in those words, and never as "it did not do anything".
 *
 * MOST WINDOWS PRODUCTS DO NOT NEED THIS. If the Windows build is Electron — and most desktop
 * products are, including the one this tool was written alongside — it is already covered from
 * any machine over its debug port by the Electron adapter, in full, with two builds able to run
 * side by side. This adapter DECLINES a Chromium window on purpose and says where to go instead.
 * Reading an Electron window through UI Automation would also switch on Chromium's accessibility
 * engine, which changes the timing and behaviour of the very thing being measured.
 *
 * AN EMPTY TREE IS NEVER A PASS. A minimised window on that machine returned zero controls from
 * the fast cached read while a plain tree walk still found children in it. A tool that reported
 * that as "this window has no controls" would compare zero against zero on the next run and call
 * it unchanged. So every read is cross-checked, and a tree that comes back empty or suddenly
 * much smaller is recorded as unchecked with the reason attached.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  countBucket, defineAdapter, joinPath, notCovered, observation, sizeBucket, timeBucket,
  trimForStorage,
} from './contract.js';
import { RemoteLinkLost, remoteRunner } from '../remote.js';
// Every wait here has a limit and every limit says what it was waiting for; the pieces are in
// process.js so there is one of each rather than one per adapter.
import { endOfChild, letGoOf } from './process.js';

/** @typedef {import('./contract.js').Build} Build */
/** @typedef {import('./contract.js').PreparedBuild} PreparedBuild */
/** @typedef {import('./contract.js').RunContext} RunContext */
/** @typedef {import('./contract.js').AdapterProject} AdapterProject */
/** @typedef {import('./contract.js').Detection} Detection */
/** @typedef {import('./contract.js').Missing} Missing */
/** @typedef {import('../types.js').Journey} Journey */
/** @typedef {import('../types.js').Observation} Observation */

/**
 * Window classes that mean "this is not really a native Windows app".
 *
 * Chromium-based shells all report one of these. Seeing one is not a failure — it is the
 * adapter finding out that a better tool for the job already exists and saying so.
 */
export const CHROMIUM_CLASSES = ['Chrome_WidgetWin_0', 'Chrome_WidgetWin_1'];

/** How long to let an app get its first window up before calling it a no-show. */
const WINDOW_WAIT_MS = 20_000;

/** Controls past this many, and the tree is stored as a summary with a fingerprint instead. */
const MAX_TREE_NODES = 4000;

/** A window picture bigger than this is dropped rather than carried back inline. */
const MAX_SHOT_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/**
 * The PowerShell program that runs on the Windows side for the length of one run.
 *
 * It is a request-and-reply loop over standard input and standard output, one JSON object per
 * line, each reply carrying the sentinel the transport looks for. It is written as one string
 * here rather than kept as a .ps1 file for one reason that matters: nothing is ever written to
 * that machine's disk, so there is nothing to leave behind, nothing to go stale, and nothing
 * for the person who owns the machine to find later and wonder about.
 *
 * Two rules are enforced inside the probe itself rather than in JavaScript, because this is the
 * only side that can enforce them:
 *
 *   - It only ever stops a process it started. `$ours` is the whole list, and `stop` checks it.
 *     Somebody's real work is on that desktop.
 *   - Every tree read is taken twice through two different mechanisms — the fast cached read and
 *     a plain walker count — and reports both. Disagreement is what tells the engine the read
 *     was not trustworthy, and it is the only defence against a confidently empty answer.
 *
 * @returns {string} PowerShell, ready to be base64ed onto the wire
 */
export function windowsProbeScript() {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public struct SFRect { public int L, T, R, B; } public class SFNative { [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out SFRect r); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); }'

$AE = [System.Windows.Automation.AutomationElement]
$TC = [System.Windows.Automation.Condition]::TrueCondition
$ours = New-Object 'System.Collections.Generic.HashSet[int]'

function Emit($o) {
  [Console]::Out.WriteLine('#SF#' + ($o | ConvertTo-Json -Compress -Depth 20))
  [Console]::Out.Flush()
}

function CacheFor() {
  $cr = New-Object System.Windows.Automation.CacheRequest
  foreach ($p in @($AE::NameProperty, $AE::ControlTypeProperty, $AE::AutomationIdProperty,
                   $AE::ClassNameProperty, $AE::IsEnabledProperty, $AE::IsOffscreenProperty,
                   $AE::BoundingRectangleProperty, $AE::HelpTextProperty,
                   $AE::IsKeyboardFocusableProperty, $AE::HasKeyboardFocusProperty)) { $cr.Add($p) }
  $cr.TreeScope = [System.Windows.Automation.TreeScope]::Subtree
  $cr.TreeFilter = [System.Windows.Automation.Automation]::ControlViewCondition
  return $cr
}

function StateOf($el) {
  $bits = @()
  try { $t = $null; if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref] $t)) { $bits += 'toggle=' + $t.Current.ToggleState } } catch {}
  try { $x = $null; if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref] $x)) { $bits += 'expand=' + $x.Current.ExpandCollapseState } } catch {}
  try { $s = $null; if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref] $s)) { $bits += 'selected=' + $s.Current.IsSelected } } catch {}
  try { $v = $null; if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref] $v)) { $bits += 'value=' + $v.Current.Value; $bits += 'readonly=' + $v.Current.IsReadOnly } } catch {}
  try { $r = $null; if ($el.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref] $r)) { $bits += 'range=' + $r.Current.Value } } catch {}
  return ($bits -join ' ')
}

function CanDo($el) {
  $names = @()
  try { foreach ($p in $el.GetSupportedPatterns()) { $names += $p.ProgrammaticName.Replace('PatternIdentifiers.Pattern', '') } } catch {}
  return ($names | Sort-Object)
}

function WalkCount($el) {
  $w = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $n = 0
  $stack = New-Object 'System.Collections.Generic.Stack[object]'
  $stack.Push($el)
  while ($stack.Count -gt 0 -and $n -lt 20000) {
    $cur = $stack.Pop()
    $n++
    try { $c = $w.GetFirstChild($cur); while ($c -ne $null) { $stack.Push($c); $c = $w.GetNextSibling($c) } } catch {}
  }
  return $n
}

function TopWindows($processId) {
  $out = @()
  foreach ($k in $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $TC)) {
    try {
      $c = $k.Current
      if ($processId -ge 0 -and $c.ProcessId -ne $processId) { continue }
      $h = [IntPtr] $c.NativeWindowHandle
      $out += @{ name = $c.Name; cls = $c.ClassName; pid = $c.ProcessId; hwnd = [int64] $c.NativeWindowHandle;
                 type = $c.ControlType.ProgrammaticName; visible = [SFNative]::IsWindowVisible($h) }
    } catch {}
  }
  return $out
}

function FindByHandle($hwnd) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::NativeWindowHandleProperty, [int] $hwnd)
  return $AE::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}

function ReadTree($win, $limit) {
  $cr = CacheFor
  $act = $cr.Activate()
  try { $set = $win.FindAll([System.Windows.Automation.TreeScope]::Subtree, $TC) } finally { $act.Dispose() }
  $nodes = @()
  $i = 0
  foreach ($e in $set) {
    if ($i -ge $limit) { break }
    $i++
    $cc = $e.Cached
    $r = $cc.BoundingRectangle
    $nodes += @{
      type = $cc.ControlType.ProgrammaticName.Replace('ControlType.', '')
      name = $cc.Name
      aid = $cc.AutomationId
      cls = $cc.ClassName
      help = $cc.HelpText
      on = $cc.IsEnabled
      hidden = $cc.IsOffscreen
      focusable = $cc.IsKeyboardFocusable
      focused = $cc.HasKeyboardFocus
      w = [int] $r.Width
      h = [int] $r.Height
      state = (StateOf $e)
      can = (CanDo $e)
    }
  }
  return @{ nodes = $nodes; cached = $set.Count; walked = (WalkCount $win) }
}

function Shot($hwnd) {
  $h = [IntPtr] $hwnd
  $r = New-Object SFRect
  [void] [SFNative]::GetWindowRect($h, [ref] $r)
  $w = $r.R - $r.L; $ht = $r.B - $r.T
  if ($w -le 0 -or $ht -le 0) { return @{ ok = $false; why = 'that window has no size on screen right now' } }
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc()
  $ok = [SFNative]::PrintWindow($h, $dc, 2)
  $g.ReleaseHdc($dc); $g.Dispose()
  $lit = 0
  $rand = New-Object Random 7
  for ($i = 0; $i -lt 200; $i++) { $px = $bmp.GetPixel($rand.Next($w), $rand.Next($ht)); if ($px.R + $px.G + $px.B -gt 30) { $lit++ } }
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return @{ ok = $ok; w = $w; h = $ht; lit = $lit; bytes = $ms.Length; png = [Convert]::ToBase64String($ms.ToArray()) }
}

function SnapDir($dir) {
  $files = @{}
  if (-not (Test-Path $dir)) { return $files }
  foreach ($f in (Get-ChildItem -Path $dir -Recurse -File -Force -ErrorAction SilentlyContinue | Select-Object -First 5000)) {
    $files[$f.FullName.Substring($dir.Length).TrimStart('\\')] = $f.Length
  }
  return $files
}

$os = Get-CimInstance Win32_OperatingSystem
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
Emit @{
  id = 'hello'; ok = $true; kind = 'windows'
  host = $env:COMPUTERNAME; user = $env:USERNAME
  windows = $os.Caption + ' ' + $os.Version
  ps = $PSVersionTable.PSVersion.ToString()
  session = (Get-Process -Id $PID).SessionId
  locked = [bool] (Get-Process LogonUI -ErrorAction SilentlyContinue)
  loggedIn = [bool] (Get-Process explorer -ErrorAction SilentlyContinue)
  screens = [System.Windows.Forms.Screen]::AllScreens.Count
  screen = '' + $vs.Width + 'x' + $vs.Height
  temp = $env:TEMP
  admin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  try { $req = $line | ConvertFrom-Json } catch { Emit @{ id = '?'; ok = $false; error = 'that was not readable json' }; continue }
  $watch = [Diagnostics.Stopwatch]::StartNew()
  try {
    switch ($req.op) {

      'bye' { Emit @{ id = $req.id; ok = $true }; exit 0 }

      'ping' { Emit @{ id = $req.id; ok = $true; ms = $watch.ElapsedMilliseconds } }

      'launch' {
        $si = @{ FilePath = $req.exe; PassThru = $true }
        if ($req.args) { $si.ArgumentList = $req.args }
        if ($req.cwd) { $si.WorkingDirectory = $req.cwd }
        $before = @(Get-CimInstance Win32_Process -Property ProcessId | ForEach-Object { $_.ProcessId })
        $p = Start-Process @si
        [void] $ours.Add($p.Id)
        Emit @{ id = $req.id; ok = $true; pid = $p.Id; before = $before.Count; startedAt = (Get-Date).ToString('o'); ms = $watch.ElapsedMilliseconds }
      }

      'windows' { $w = TopWindows ([int] $req.pid); Emit @{ id = $req.id; ok = $true; windows = $w; count = $w.Count; ms = $watch.ElapsedMilliseconds } }

      'tree' {
        $win = FindByHandle $req.hwnd
        if ($null -eq $win) { Emit @{ id = $req.id; ok = $false; error = 'that window is not on the desktop any more' }; break }
        $limit = if ($req.limit) { [int] $req.limit } else { 4000 }
        $t = ReadTree $win $limit
        Emit @{ id = $req.id; ok = $true; nodes = $t.nodes; cached = $t.cached; walked = $t.walked; ms = $watch.ElapsedMilliseconds }
      }

      'settle' {
        $win = FindByHandle $req.hwnd
        if ($null -eq $win) { Emit @{ id = $req.id; ok = $false; error = 'that window is not on the desktop any more' }; break }
        $limit = if ($req.limit) { [int] $req.limit } else { 4000 }
        $tries = if ($req.tries) { [int] $req.tries } else { 6 }
        $gap = if ($req.gapMs) { [int] $req.gapMs } else { 250 }
        $last = $null; $lastKey = ''; $agreed = $false; $n = 0
        while ($n -lt $tries) {
          $n++
          $t = ReadTree $win $limit
          $key = ($t.nodes | ForEach-Object { $_.type + '/' + $_.name + '/' + $_.aid + '/' + $_.on + '/' + $_.state }) -join '|'
          if ($key -eq $lastKey -and $n -gt 1) { $agreed = $true; $last = $t; break }
          $lastKey = $key; $last = $t
          Start-Sleep -Milliseconds $gap
        }
        Emit @{ id = $req.id; ok = $true; agreed = $agreed; reads = $n; nodes = $last.nodes; cached = $last.cached; walked = $last.walked; ms = $watch.ElapsedMilliseconds }
      }

      'shot' { $s = Shot $req.hwnd; $s.id = $req.id; $s.ms = $watch.ElapsedMilliseconds; Emit $s }

      'spawned' {
        $rows = @()
        foreach ($p in (Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, CreationDate)) {
          if ($ours.Contains([int] $p.ParentProcessId) -or $ours.Contains([int] $p.ProcessId)) {
            $rows += @{ name = $p.Name; parent = $p.ParentProcessId; pid = $p.ProcessId; cmd = $p.CommandLine }
          }
        }
        Emit @{ id = $req.id; ok = $true; procs = $rows; ms = $watch.ElapsedMilliseconds }
      }

      'net' {
        $rows = @()
        try {
          foreach ($c in (Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
            if (-not $ours.Contains([int] $c.OwningProcess)) { continue }
            $rows += @{ remote = $c.RemoteAddress; port = $c.RemotePort; state = '' + $c.State }
          }
          Emit @{ id = $req.id; ok = $true; conns = $rows; sampled = $true; ms = $watch.ElapsedMilliseconds }
        } catch { Emit @{ id = $req.id; ok = $false; error = 'connections could not be listed on this account' } }
      }

      'snap' {
        $out = @{}
        foreach ($d in $req.dirs) { $out[$d] = (SnapDir $d) }
        Emit @{ id = $req.id; ok = $true; dirs = $out; ms = $watch.ElapsedMilliseconds }
      }

      'events' {
        $since = [DateTime]::Parse($req.since)
        $rows = @()
        foreach ($log in @('Application', 'System')) {
          try {
            foreach ($e in (Get-WinEvent -FilterHashtable @{ LogName = $log; StartTime = $since } -MaxEvents 200 -ErrorAction SilentlyContinue)) {
              if ($e.LevelDisplayName -eq 'Information') { continue }
              $rows += @{ log = $log; id = $e.Id; level = $e.LevelDisplayName; source = $e.ProviderName; text = ('' + $e.Message).Substring(0, [Math]::Min(400, ('' + $e.Message).Length)) }
            }
          } catch {}
        }
        Emit @{ id = $req.id; ok = $true; events = $rows; ms = $watch.ElapsedMilliseconds }
      }

      'alive' {
        $p = Get-Process -Id ([int] $req.pid) -ErrorAction SilentlyContinue
        Emit @{ id = $req.id; ok = $true; running = ($null -ne $p); exit = $(if ($p) { $null } else { 'gone' }); ms = $watch.ElapsedMilliseconds }
      }

      'stop' {
        $target = [int] $req.pid
        if (-not $ours.Contains($target)) {
          Emit @{ id = $req.id; ok = $false; error = 'refusing to stop a process this run did not start' }
          break
        }
        $p = Get-Process -Id $target -ErrorAction SilentlyContinue
        $code = $null
        if ($p) {
          [void] $p.CloseMainWindow()
          if (-not $p.WaitForExit(4000)) { Stop-Process -Id $target -Force -ErrorAction SilentlyContinue; $code = 'forced' }
          else { $code = $p.ExitCode }
        }
        [void] $ours.Remove($target)
        Emit @{ id = $req.id; ok = $true; exit = $code; ms = $watch.ElapsedMilliseconds }
      }

      default { Emit @{ id = $req.id; ok = $false; error = 'nothing here knows how to do ' + $req.op } }
    }
  } catch {
    Emit @{ id = $req.id; ok = $false; error = ('' + $_.Exception.Message) }
  }
}
`;
}

// ---------------------------------------------------------------------------
// Turning replies into observations
// ---------------------------------------------------------------------------

/**
 * @typedef {object} TreeNode
 * @property {string} type
 * @property {string} name
 * @property {string} aid
 * @property {string} cls
 * @property {boolean} on
 * @property {boolean} hidden
 * @property {boolean} [focused]
 * @property {number} w
 * @property {number} h
 * @property {string} state
 * @property {string[]} can
 */

/**
 * The address one control lives at.
 *
 * Built from what the control IS and what it is CALLED, never from where it sits in the tree.
 * An index would be stable right up until somebody adds a control above it, at which point
 * every control below would report as changed and the real change would be buried in the noise.
 * Where a control has neither a name nor an automation id — and classic Windows dialogs are
 * full of those — the numeric automation id is used, which is what those dialogs actually have.
 *
 * @param {TreeNode} node
 * @param {number} index  Only used when a control has no identity of its own.
 * @returns {string}
 */
export function controlAddress(node, index) {
  const called = node.aid || node.name;
  if (called) return `${node.type.toLowerCase()}:${called}`;
  if (node.cls) return `${node.type.toLowerCase()}:${node.cls}#${index}`;
  return `${node.type.toLowerCase()}#${index}`;
}

/**
 * What one control says it is, in one line, and it is the only thing compared.
 *
 * Deliberately excludes the rectangle. A window that opens two pixels lower is not a
 * difference anybody wants reported, and a control that MOVED without changing what it is or
 * does is a pixel finding, not a meaning one. What is included is what would make somebody say
 * the product behaves differently: what it is, whether it works, whether it is showing, what it
 * is set to, and what it can be asked to do.
 *
 * @param {TreeNode} node
 * @returns {string}
 */
export function controlMeaning(node) {
  const parts = [node.type];
  if (node.name) parts.push(`called "${node.name}"`);
  parts.push(node.on ? 'enabled' : 'disabled');
  if (node.hidden) parts.push('not showing');
  if (node.state) parts.push(node.state);
  if (node.can && node.can.length > 0) parts.push(`can ${node.can.join(', ')}`);
  return parts.join(', ');
}

/**
 * Turn one window's tree into observations, or into a hole if the read cannot be trusted.
 *
 * The cross-check is the important part and it is why `cached` and `walked` both come back from
 * the probe. They are two different mechanisms counting the same tree. When they agree, the read
 * is good. When the fast one returns nothing and the slow one finds controls, the fast one is
 * lying, and reporting its answer would put a confident zero into the reference — after which
 * every later run would compare zero against zero and agree that nothing had changed.
 *
 * @param {object} spec
 * @param {Journey} spec.journey
 * @param {string} spec.window        Plain name of the window, for the path.
 * @param {TreeNode[]} spec.nodes
 * @param {number} spec.cached        How many the fast read found.
 * @param {number} spec.walked        How many a plain walk found.
 * @param {boolean} [spec.settled]    Did two reads in a row agree.
 * @returns {Observation[]}
 */
export function meaningFromTree(spec) {
  const { journey, window: windowName, nodes, cached, walked } = spec;
  const head = ['screen', windowName];

  if (cached === 0 && walked > 1) {
    return [notCovered({
      channel: 'meaning',
      path: joinPath(...head, 'controls'),
      reason: 'not supported here',
      says: `The window "${windowName}" would not give up its controls: the fast read found none while a plain `
        + `walk found ${walked}. That happens when a window is minimised or its content has been put away. `
        + 'Nothing is recorded for it, because recording "no controls" would make the next run agree that nothing changed.',
    })];
  }
  if (nodes.length === 0) {
    return [notCovered({
      channel: 'meaning',
      path: joinPath(...head, 'controls'),
      reason: 'not supported here',
      says: `The window "${windowName}" reported no controls at all. Either it draws itself without telling `
        + 'Windows what it is showing, or there was nothing on it yet. Either way it is unchecked, not empty.',
    })];
  }

  /** @type {Observation[]} */
  const out = [];
  /** @type {Map<string, number>} */
  const usedNames = new Map();
  nodes.forEach((node, index) => {
    let address = controlAddress(node, index);
    // Two controls can honestly share a name — two "Close" buttons in two panels. Number the
    // repeats rather than let the second quietly overwrite the first.
    const seen = usedNames.get(address) ?? 0;
    usedNames.set(address, seen + 1);
    if (seen > 0) address = `${address}~${seen + 1}`;
    out.push(observation({
      channel: 'meaning',
      path: joinPath(...head, address),
      value: controlMeaning(node),
      says: `On "${windowName}", ${controlMeaning(node)}.`,
      journey: journey.name,
      surface: 'windows',
    }));
  });

  out.push(observation({
    channel: 'counters',
    path: joinPath('count', windowName, 'controls'),
    value: countBucket(nodes.length),
    says: `"${windowName}" is showing ${nodes.length} control${nodes.length === 1 ? '' : 's'}.`,
    journey: journey.name,
    surface: 'windows',
  }));

  if (spec.settled === false) {
    out.push(notCovered({
      channel: 'meaning',
      path: joinPath(...head, 'settled'),
      reason: 'timed out',
      says: `"${windowName}" never held still: two readings in a row never matched. What was recorded is one `
        + 'snapshot of something still moving, so a difference found in it may be the movement rather than the change.',
    }));
  }
  if (nodes.length >= MAX_TREE_NODES) {
    out.push(notCovered({
      channel: 'meaning',
      path: joinPath(...head, 'all of it'),
      reason: 'too big',
      says: `"${windowName}" has more than ${MAX_TREE_NODES} controls, so only the first ${MAX_TREE_NODES} were `
        + 'recorded. Anything past that is unchecked.',
    }));
  }
  return out;
}

/**
 * Programs the app started, as observations.
 *
 * The command line is kept and compared, because "it now launches the updater with a different
 * flag" is exactly the kind of change no screenshot has ever caught.
 *
 * @param {Journey} journey
 * @param {{name: string, pid: number, parent: number, cmd: string|null}[]} procs
 * @param {number} ownPid
 * @returns {Observation[]}
 */
export function spawnedObservations(journey, procs, ownPid) {
  const children = procs.filter((p) => p.pid !== ownPid);
  /** @type {Observation[]} */
  const out = children
    .map((p) => ({ name: p.name, cmd: p.cmd ?? '(no command line visible)' }))
    .sort((a, b) => (a.name + a.cmd < b.name + b.cmd ? -1 : 1))
    .map((p, index) => observation({
      channel: 'effects',
      path: joinPath('proc', journey.name, `${p.name}#${index}`),
      value: p.cmd,
      says: `It started ${p.name}. That is a program running because this app ran.`,
      journey: journey.name,
      surface: 'windows',
    }));
  out.push(observation({
    channel: 'counters',
    path: joinPath('count', journey.name, 'programs started'),
    value: countBucket(children.length),
    says: `It started ${children.length} other program${children.length === 1 ? '' : 's'}.`,
    journey: journey.name,
    surface: 'windows',
  }));
  return out;
}

/**
 * What changed on disk in the folders we were told to watch.
 *
 * Sizes rather than contents, because reading every file back over a network connection would
 * cost more than the whole rest of the run. A file that changed size changed; a file that was
 * rewritten with the same length is missed, and that is said out loud rather than hidden.
 *
 * @param {Journey} journey
 * @param {Record<string, Record<string, number>>} before
 * @param {Record<string, Record<string, number>>} after
 * @returns {Observation[]}
 */
export function fileObservations(journey, before, after) {
  /** @type {Observation[]} */
  const out = [];
  for (const dir of Object.keys(after).sort()) {
    const was = before[dir] ?? {};
    const now = after[dir] ?? {};
    const names = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort();
    let touched = 0;
    for (const name of names) {
      const oldSize = was[name];
      const newSize = now[name];
      if (oldSize === newSize) continue;
      touched++;
      out.push(observation({
        channel: 'effects',
        path: joinPath('file', journey.name, name),
        value: newSize === undefined ? 'deleted' : oldSize === undefined ? `written, ${sizeBucket(newSize)}` : `changed to ${sizeBucket(newSize)}`,
        says: newSize === undefined
          ? `It deleted ${name}.`
          : oldSize === undefined
            ? `It wrote ${name}, ${sizeBucket(newSize)}.`
            : `It changed ${name}; it is now ${sizeBucket(newSize)}.`,
        journey: journey.name,
        surface: 'windows',
      }));
    }
    out.push(observation({
      channel: 'counters',
      path: joinPath('count', journey.name, 'files touched'),
      value: countBucket(touched),
      says: `${touched} file${touched === 1 ? '' : 's'} changed under ${dir}.`,
      journey: journey.name,
      surface: 'windows',
    }));
  }
  out.push(notCovered({
    channel: 'effects',
    path: joinPath('file', journey.name, 'everywhere else'),
    reason: 'missing tool',
    says: 'Only the folders this check was told to watch were compared. Watching everything a program writes '
      + 'needs administrator rights on Windows, which this account does not have, so a file written anywhere '
      + 'else was not seen. That is a hole, not a clean result.',
  }));
  return out;
}

/**
 * Crashes, hangs and anything the program complained about into the Windows event log.
 *
 * The event ids are the ones Windows itself uses and they are worth knowing: 1000 is an
 * application crash, 1002 is an application hang, 1001 is the report Windows filed about it.
 * Everything else is kept too, at warning level and above, because an application that has
 * started logging a new warning every run has changed even if nothing on screen has.
 *
 * @param {Journey} journey
 * @param {{log: string, id: number, level: string, source: string, text: string}[]} events
 * @param {string} appHint  Something to recognise this app by in a log line.
 * @returns {Observation[]}
 */
export function complaintObservations(journey, events, appHint) {
  const hint = appHint.toLowerCase();
  const mine = events.filter((e) => `${e.source} ${e.text}`.toLowerCase().includes(hint));
  const crashes = mine.filter((e) => [1000, 1001, 1002].includes(e.id));
  /** @type {Observation[]} */
  const out = crashes.map((e, index) => observation({
    channel: 'complaints',
    path: joinPath('log', journey.name, 'crash', String(index)),
    value: `${e.id === 1002 ? 'stopped responding' : 'crashed'}: ${trimForStorage(e.text, 400).text}`,
    says: e.id === 1002
      ? 'Windows recorded that this app stopped responding.'
      : 'Windows recorded that this app crashed.',
    journey: journey.name,
    surface: 'windows',
  }));
  out.push(observation({
    channel: 'complaints',
    path: joinPath('log', journey.name, 'complaints'),
    value: countBucket(mine.length),
    says: mine.length === 0
      ? 'Windows logged nothing about this app while it ran.'
      : `Windows logged ${mine.length} thing${mine.length === 1 ? '' : 's'} about this app while it ran.`,
    journey: journey.name,
    surface: 'windows',
  }));
  return out;
}

/**
 * Connections the app had open, plus the honest note about what sampling misses.
 *
 * @param {Journey} journey
 * @param {{remote: string, port: number, state: string}[]} conns
 * @returns {Observation[]}
 */
export function networkObservations(journey, conns) {
  const reachable = conns
    .filter((c) => c.remote !== '0.0.0.0' && c.remote !== '::' && c.remote !== '127.0.0.1')
    .map((c) => `${c.remote}:${c.port}`)
    .sort();
  const unique = [...new Set(reachable)];
  /** @type {Observation[]} */
  const out = unique.map((where, index) => observation({
    channel: 'effects',
    path: joinPath('net', journey.name, String(index)),
    value: where,
    says: `While it was running it had a connection open to ${where}.`,
    journey: journey.name,
    surface: 'windows',
  }));
  out.push(notCovered({
    channel: 'effects',
    path: joinPath('net', journey.name, 'everything it asked for'),
    reason: 'missing tool',
    says: 'Connections were sampled while the app ran, not captured. A request that opened and finished '
      + 'between two samples was not seen, and nothing here could have stopped one. Capturing every call '
      + 'needs administrator rights on Windows, which this account does not have.',
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Finding the app
// ---------------------------------------------------------------------------

/**
 * Where the Windows build is, and whether it is already on the far machine.
 *
 * Two honest modes, and which one a project is in changes what a run costs by minutes:
 *
 *   `there`  The config names a path that already exists on the Windows machine. Free.
 *   `push`   The build is here and has to be copied over. Real, and reported with its size,
 *            because a person who does not know a run copies 200 megabytes over ssh every time
 *            will reasonably conclude the tool is broken when it takes four minutes.
 *
 * @param {AdapterProject} project
 * @returns {{mode: 'there'|'push'|'none', exe: string|null, local: string|null, why: string}}
 */
export function findWindowsBuild(project) {
  const config = project.config ?? {};
  if (typeof config.remoteExe === 'string' && config.remoteExe.trim() !== '') {
    return {
      mode: 'there',
      exe: config.remoteExe,
      local: null,
      why: `The Windows build is already on that machine at ${config.remoteExe}, so nothing is copied.`,
    };
  }
  if (typeof config.exe === 'string' && config.exe.trim() !== '') {
    const local = path.isAbsolute(config.exe) ? config.exe : path.join(project.root, config.exe);
    return {
      mode: 'push',
      exe: null,
      local,
      why: `The Windows build is here at ${local} and has to be copied to the Windows machine before each run.`,
    };
  }
  return {
    mode: 'none',
    exe: null,
    local: null,
    why: 'No Windows build was named, so there is nothing to open.',
  };
}

/**
 * Is this window really a native one, or a Chromium shell wearing a Windows title bar.
 * @param {string} className
 * @returns {boolean}
 */
export function isChromiumWindow(className) {
  return CHROMIUM_CLASSES.includes(className);
}

/**
 * Make a list out of whatever PowerShell sent.
 *
 * Not defensive programming — a real and famous behaviour of the thing on the other end.
 * `ConvertTo-Json` turns a list of three into a JSON array, a list of one into a BARE OBJECT,
 * and a list of none into `null`. So a window tree with a single control arrives shaped like a
 * single control, and any code that maps over it dies. PowerShell 5.1 has no `-AsArray` to fix
 * this at the source, so it is fixed here, once, and every reply is read through it.
 *
 * @template T
 * @param {unknown} value
 * @returns {T[]}
 */
export function asList(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? /** @type {T[]} */ (value) : [/** @type {T} */ (value)];
}

/**
 * Copy a build over to the far machine, and say how long it took and how big it was.
 *
 * Streamed through tar rather than scp so it is one connection and one pass, and so a folder
 * of thousands of small files does not become thousands of round trips at a second each.
 *
 * @param {string} host
 * @param {string} localDir
 * @param {string} remoteDir
 * @returns {Promise<{ok: boolean, ms: number, why: string}>}
 */
export async function pushBuild(host, localDir, remoteDir) {
  const started = Date.now();
  // `ConnectTimeout` because ssh with no answer at the far end will sit on a half-open socket
  // for as long as the network lets it, and the whole point of this pass is that nothing here
  // is allowed to wait without a clock on it.
  const tar = spawn('tar', ['-cf', '-', '-C', path.dirname(localDir), path.basename(localDir)]);
  const ssh = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, `mkdir -p '${remoteDir}' && tar -xf - -C '${remoteDir}'`]);
  let trouble = '';
  tar.stdout.pipe(ssh.stdin);
  ssh.stderr.on('data', (d) => { trouble += String(d); });
  tar.stderr.on('data', (d) => { trouble += String(d); });
  // Nothing wants what ssh prints on its way through, and that is exactly why it has to be
  // read. A pipe nobody empties fills up, and a full pipe blocks its writer for ever — the
  // same hang as an unclosed one, arriving from the other direction.
  ssh.stdout?.resume();
  // A pipe with nobody reading it fills up and blocks the writer for ever, so if ssh is gone
  // tar has to be told rather than left leaning on a dead pipe.
  ssh.on('error', () => { try { tar.kill('SIGKILL'); } catch { /* already gone */ } });
  tar.on('error', () => { try { ssh.kill('SIGKILL'); } catch { /* already gone */ } });

  // Thirty minutes for a whole build over a network, which is far longer than it has ever
  // taken and still a limit. A copy that never finishes and never says so is the shape of the
  // hang this whole pass exists to remove.
  const ended = await endOfChild(ssh, { limitMs: 30 * 60_000, what: `the copy of this build to ${host}` });
  try { tar.kill('SIGKILL'); } catch { /* it finished on its own */ }
  letGoOf(tar);

  const ms = Date.now() - started;
  if (ended.gaveUp) return { ok: false, ms, why: `${ended.why} ${trouble.trim().slice(0, 200)}`.trim() };
  if (ended.code === 0) return { ok: true, ms, why: `Copied to ${host} in ${timeBucket(ms)}.` };
  return { ok: false, ms, why: `Copying to ${host} failed: ${trouble.trim().slice(0, 300) || `the copy ended with ${ended.code ?? ended.signal}`}` };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** The one connection this adapter holds while a run is going on. */
let link = /** @type {import('../remote.js').RemoteRunner|null} */ (null);

/** Everything this run started over there, so teardown can put it back and nothing else. */
/** @type {number[]} */
let startedHere = [];

/**
 * Open the Windows machine, once, and keep it.
 * @param {string} host
 * @param {(m: string) => void} [log]
 */
async function connect(host, log) {
  if (link && link.alive) return link;
  link = remoteRunner({ host, kind: 'windows', surface: 'windows', agent: windowsProbeScript(), log });
  await link.open();
  return link;
}

export const windowsAdapter = defineAdapter({
  name: 'windows',
  title: 'native Windows apps',
  describe:
    'Opens a native Windows program on a real Windows desktop reached over ssh, reads what every control on '
    + 'screen says it is and does through UI Automation, and watches what it starts, writes and complains '
    + 'about. It cannot run two builds at once — Windows has one desktop — and it declines Electron apps, '
    + 'which are covered better and in pairs over their debug port.',
  channels: ['meaning', 'effects', 'complaints', 'results', 'counters', 'pixels'],

  /**
   * @param {AdapterProject} project
   * @returns {Promise<Detection>}
   */
  async detect(project) {
    const config = project.config ?? {};
    const host = typeof config.host === 'string' ? config.host : null;
    const build = findWindowsBuild(project);
    /** @type {Missing[]} */
    const missing = [];

    if (!host) {
      missing.push({
        what: 'the name of a machine with a Windows desktop on it',
        unlocks: 'checking a native Windows app at all — a Windows window can only be read from Windows',
        howToGet: 'Put {"host": "the-ssh-host-name"} under "windows" in the config. Any ssh host that gets you a '
          + 'shell on a Windows machine works, including a WSL shell on one — the tool finds powershell.exe from '
          + 'there by itself. Nothing needs installing on that machine.',
        blocking: true,
      });
    }
    if (build.mode === 'none') {
      missing.push({
        what: 'the built Windows program',
        unlocks: 'opening the app and reading what is on its screen',
        howToGet: 'Either put {"remoteExe": "C:\\\\path\\\\to\\\\YourApp.exe"} under "windows" in the config if the '
          + 'build already lives on that machine — much faster — or {"exe": "dist/win/YourApp.exe"} to have it '
          + 'copied over before each run.',
        blocking: true,
      });
    }
    if (!Array.isArray(config.watchDirs) || config.watchDirs.length === 0) {
      missing.push({
        what: 'the folders this app writes into',
        unlocks: 'seeing what it saved, which is otherwise invisible — Windows will not let this account watch '
          + 'the whole disk without administrator rights',
        howToGet: 'Put {"watchDirs": ["C:\\\\Users\\\\you\\\\AppData\\\\Roaming\\\\YourApp"]} under "windows" in the config.',
      });
    }

    let electronish = false;
    try {
      const pkg = JSON.parse(await fsp.readFile(path.join(project.root, 'package.json'), 'utf8'));
      electronish = Boolean(pkg.dependencies?.electron || pkg.devDependencies?.electron || pkg.build?.appId);
    } catch { /* a built app somebody pointed at need not have a package.json */ }

    if (electronish) {
      return {
        applies: false,
        confidence: 0,
        why: 'This is an Electron app, so the Electron adapter covers its Windows build properly — over the debug '
          + 'port, from any machine, with two builds able to run side by side. This adapter would be strictly worse: '
          + 'one build at a time, on one shared desktop, and reading the window would switch on Chromium\'s '
          + 'accessibility engine and change the timing of the thing being measured.',
        missing: [],
        notes: ['Nothing is missing. There is simply a better tool for this app already in the box.'],
      };
    }

    const applies = Boolean(host) && build.mode !== 'none';
    return {
      applies,
      confidence: applies ? 0.9 : 0,
      why: applies
        ? `${build.why} It will be opened on the desktop behind "${host}", read, and closed again — one build at a `
          + 'time, because Windows shows one desktop and two cannot be up at once.'
        : 'A native Windows app needs a Windows machine and a built program, and one of those is not named yet.',
      missing,
      notes: [
        'Nothing is installed on the Windows machine. The program that reads the screen is sent down the ssh '
          + 'connection each run and disappears when it closes.',
        'Two builds can never run at the same time here. That is a property of Windows, not of this tool, and it '
          + 'makes the same-machine comparison weaker on this platform than on any other.',
        'The desktop is shared with whoever uses that machine. A notification or an update prompt appearing '
          + 'mid-run is a real difference this cannot tell from a real one, beyond what running twice subtracts.',
        'Nothing irreversible can be stopped here. There is no way to refuse a compiled program\'s network call '
          + 'without administrator rights, so a journey marked irreversible is refused outright instead of walked.',
      ],
    };
  },

  /**
   * @param {AdapterProject} project
   * @returns {Promise<Journey[]>}
   */
  async journeys(project) {
    const config = project.config ?? {};
    const build = findWindowsBuild(project);
    if (build.mode === 'none') return [];

    /** @type {Journey[]} */
    const journeys = [{
      name: 'open-the-app',
      describe: 'open the Windows app and read every control it puts on screen',
      source: 'code',
      surface: 'windows',
      from: 'the built program named in the config',
      channels: ['meaning', 'effects', 'complaints', 'counters', 'pixels'],
      steps: [{ act: 'launch' }, { act: 'settle' }, { act: 'read' }],
      timeoutMs: 120_000,
    }];

    // Anything else has to be described by somebody who knows the app. Read out of the config
    // rather than invented here: an adapter that guesses which buttons to press on an unknown
    // native program is an adapter that will one day press "Delete account".
    for (const extra of Array.isArray(config.journeys) ? config.journeys : []) {
      if (!extra || typeof extra.name !== 'string') continue;
      journeys.push({
        name: extra.name,
        describe: typeof extra.describe === 'string' ? extra.describe : `walk "${extra.name}"`,
        source: 'recorded',
        surface: 'windows',
        from: 'the project config',
        channels: ['meaning', 'effects', 'complaints', 'counters', 'pixels'],
        steps: Array.isArray(extra.steps) ? extra.steps : [],
        irreversible: Boolean(extra.irreversible),
        timeoutMs: 120_000,
      });
    }
    return journeys;
  },

  /**
   * @param {Build} build
   * @param {RunContext} ctx
   * @returns {Promise<PreparedBuild>}
   */
  async prepare(build, ctx) {
    const config = ctx.config ?? {};
    const host = typeof config.host === 'string' ? config.host : null;
    if (!host) {
      return { build, root: build.root, ready: false, why: 'No Windows machine is named in the config, so there is nowhere to open this.', dispose: async () => {} };
    }
    const where = findWindowsBuild({ root: build.root, config });
    if (where.mode === 'none') {
      return { build, root: build.root, ready: false, why: where.why, dispose: async () => {} };
    }

    let runner;
    try {
      runner = await connect(host, ctx.log);
    } catch (error) {
      return {
        build,
        root: build.root,
        ready: false,
        why: error instanceof RemoteLinkLost
          ? `${error.message}. Nothing was checked on Windows.`
          : `Could not reach ${host}: ${String(error)}`,
        dispose: async () => {},
      };
    }

    const facts = runner.facts;
    if (facts.loggedIn === false) {
      return {
        build,
        root: build.root,
        ready: false,
        why: `Nobody is signed in on ${host}, and there is nothing to read on a desktop nobody has signed into. `
          + 'Sign in there once and leave the session running; locking the screen afterwards is fine.',
        dispose: async () => {},
      };
    }

    let exe = where.exe;
    /** @type {string[]} */
    const notes = [];
    if (where.mode === 'push' && where.local) {
      const remoteDir = `/tmp/staysfixed-${build.id}`;
      const pushed = await pushBuild(host, path.dirname(where.local), remoteDir);
      if (!pushed.ok) {
        return { build, root: build.root, ready: false, why: pushed.why, dispose: async () => {} };
      }
      notes.push(pushed.why);
      // The copy lands on the Linux side; Windows reaches it through the UNC path WSL publishes.
      const distro = String(facts.host ?? 'Ubuntu');
      exe = `\\\\wsl.localhost\\${distro}${remoteDir.replace(/\//g, '\\')}\\${path.basename(path.dirname(where.local))}\\${path.basename(where.local)}`;
      notes.push('Starting a program from a copied folder is slower than one already on that machine. Naming '
        + '"remoteExe" instead, once, removes this from every run.');
    }

    return {
      build,
      root: build.root,
      ready: Boolean(exe),
      why: exe
        ? `${where.why} ${notes.join(' ')}`.trim()
        : 'The Windows program could not be placed on that machine.',
      facts: {
        exe: exe ?? undefined,
        host,
        locked: facts.locked,
        desktop: typeof facts.screen === 'string' ? facts.screen : undefined,
      },
      dispose: async () => { /* nothing was installed, so there is nothing to undo */ },
    };
  },

  /**
   * @param {Journey} journey
   * @param {PreparedBuild} prepared
   * @param {RunContext} ctx
   * @returns {Promise<Observation[]>}
   */
  async run(journey, prepared, ctx) {
    const config = ctx.config ?? {};
    const exe = String(prepared.facts?.exe ?? '');
    const host = String(prepared.facts?.host ?? '');

    if (!prepared.ready || !exe) {
      return [notCovered({
        channel: 'meaning',
        path: joinPath('screen', journey.name, 'anything at all'),
        reason: 'missing tool',
        says: `"${journey.describe}" was not walked: ${prepared.why}`,
      })];
    }

    // Refused outright rather than walked carefully. There is no wire boundary on Windows
    // without administrator rights, so "watch it ask and stop it" is not available, and a
    // careful walk of an irreversible journey is a walk that really does the irreversible thing.
    if (journey.irreversible) {
      return [notCovered({
        channel: 'effects',
        path: joinPath('screen', journey.name, 'refused'),
        reason: 'irreversible',
        says: `"${journey.describe}" would spend money, send a message or destroy data, and on Windows there is no `
          + 'way to let it ask and then stop it — that needs administrator rights this account does not have. '
          + 'It was not run at all. This is a hole in what was checked, not a pass.',
      })];
    }

    let runner;
    try {
      runner = await connect(host, ctx.log);
    } catch (error) {
      return [notCovered({
        channel: 'meaning',
        path: joinPath('screen', journey.name, 'anything at all'),
        reason: 'timed out',
        says: `"${journey.describe}" was not walked: ${error instanceof Error ? error.message : String(error)}.`,
      })];
    }

    /** @type {Observation[]} */
    const seen = [];
    /** @type {string[]} */
    const watchDirs = Array.isArray(config.watchDirs) ? config.watchDirs.map(String) : [];
    let pid = 0;
    const startedAt = new Date().toISOString();

    try {
      const before = watchDirs.length > 0 ? await runner.call('snap', { dirs: watchDirs }) : { dirs: {} };

      const launched = await runner.call('launch', {
        exe,
        args: Array.isArray(config.args) ? config.args : undefined,
        cwd: typeof config.cwd === 'string' ? config.cwd : undefined,
      }, { timeoutMs: 60_000 });
      if (!launched.ok) {
        return [notCovered({
          channel: 'meaning',
          path: joinPath('screen', journey.name, 'anything at all'),
          reason: 'crashed',
          says: `The app would not start on ${host}: ${launched.error}.`,
        })];
      }
      pid = Number(launched.pid);
      startedHere.push(pid);

      // Wait for a window rather than sleeping a fixed time. A machine under load takes longer,
      // and a fixed sleep would turn that into a difference in the report.
      /** @type {{name: string, cls: string, hwnd: number, pid: number, visible: boolean}[]} */
      let windows = [];
      const deadline = Date.now() + WINDOW_WAIT_MS;
      while (Date.now() < deadline) {
        const reply = await runner.call('windows', { pid });
        windows = asList(reply.windows).filter((/** @type {any} */ w) => Boolean(w.visible));
        if (windows.length > 0) break;
        await new Promise((r) => setTimeout(r, 400));
      }

      if (windows.length === 0) {
        seen.push(notCovered({
          channel: 'meaning',
          path: joinPath('screen', journey.name, 'a window'),
          reason: 'timed out',
          says: `The app started on ${host} but put no window on screen within ${timeBucket(WINDOW_WAIT_MS)}. `
            + 'Nothing about its screen was checked. It may be a background program, or it may have failed silently.',
        }));
      }

      const chromium = windows.filter((w) => isChromiumWindow(w.cls));
      if (chromium.length > 0 && chromium.length === windows.length) {
        seen.push(notCovered({
          channel: 'meaning',
          path: joinPath('screen', journey.name, 'controls'),
          reason: 'not supported here',
          says: 'Every window this app opened is a Chromium one, so it is an Electron app after all. It is not read '
            + 'here: the Electron adapter covers it properly over its debug port, from any machine, with two builds '
            + 'able to run at once. Reading it here would also switch on Chromium\'s accessibility engine and change '
            + 'the timing of what is being measured.',
        }));
      } else {
        for (const window of windows.filter((w) => !isChromiumWindow(w.cls))) {
          const label = window.name || window.cls || 'a window with no title';
          const tree = await runner.call('settle', { hwnd: window.hwnd, limit: MAX_TREE_NODES }, { timeoutMs: 90_000 });
          if (!tree.ok) {
            seen.push(notCovered({
              channel: 'meaning',
              path: joinPath('screen', label, 'controls'),
              reason: 'crashed',
              says: `"${label}" could not be read: ${tree.error}.`,
            }));
            continue;
          }
          seen.push(...meaningFromTree({
            journey,
            window: label,
            nodes: asList(tree.nodes),
            cached: Number(tree.cached ?? 0),
            walked: Number(tree.walked ?? 0),
            settled: Boolean(tree.agreed),
          }));
          seen.push(observation({
            channel: 'results',
            path: joinPath('screen', label, 'title'),
            value: window.name,
            says: `A window is open called "${window.name}".`,
            journey: journey.name,
            surface: 'windows',
          }));

          // Pixels last, and only as evidence. A picture is written to the evidence folder and
          // pointed at; it is never the thing compared.
          const shot = await runner.call('shot', { hwnd: window.hwnd }, { timeoutMs: 45_000 });
          // THREE WAYS OUT OF HERE AND TWO OF THEM USED TO BE SILENT. A picture that failed,
          // came back empty, or came back bigger than the cap simply produced no observation
          // at all — so the pixels channel dropped out of the run without a word, and the
          // ledger reported the same coverage as a run where every window was photographed.
          // A cap is a decision and a decision has to be visible; a failure is a hole and a
          // hole has to be named. Neither is a reason to lose the rest of the walk.
          const tooBig = shot.ok === true && Boolean(shot.png) && Number(shot.bytes) > MAX_SHOT_BYTES;
          if (!shot.ok || !shot.png || tooBig) {
            seen.push(notCovered({
              channel: 'pixels',
              path: joinPath('screen', label, 'picture'),
              reason: tooBig ? 'too big' : 'crashed',
              says: tooBig
                ? `The picture of "${label}" came back at ${sizeBucket(Number(shot.bytes))}, over the ${sizeBucket(MAX_SHOT_BYTES)} this keeps, so it was not stored. Every other channel still looked at that window; only the picture is missing.`
                : `No picture of "${label}" could be taken${shot.error ? `: ${String(shot.error)}` : '.'} Every other channel still looked at that window; only the picture is missing.`,
            }));
          }
          if (shot.ok && shot.png && !tooBig) {
            const file = path.join(ctx.evidenceDir, `windows-${journey.name}-${label.replace(/[^a-z0-9]+/gi, '-')}.png`);
            await fsp.writeFile(file, Buffer.from(String(shot.png), 'base64'));
            seen.push(observation({
              channel: 'pixels',
              path: joinPath('screen', label, 'looks like'),
              value: `${shot.w} by ${shot.h}`,
              says: `A picture of "${label}" was kept as evidence. It is not compared — it is there to show a person `
                + 'something another channel already found.',
              evidence: file,
              journey: journey.name,
              surface: 'windows',
            }));
            if (Number(shot.lit) === 0) {
              seen.push(notCovered({
                channel: 'pixels',
                path: joinPath('screen', label, 'picture is usable'),
                reason: 'not supported here',
                says: 'The picture came back completely black. On a locked Windows desktop that is expected for '
                  + 'anything drawn by the graphics card. Every other channel still works; only the picture is lost.',
              }));
            }
          }
        }
      }

      const spawned = await runner.call('spawned', {});
      seen.push(...spawnedObservations(journey, asList(spawned.procs), pid));

      const net = await runner.call('net', {});
      if (net.ok) seen.push(...networkObservations(journey, asList(net.conns)));

      if (watchDirs.length > 0) {
        const after = await runner.call('snap', { dirs: watchDirs }, { timeoutMs: 90_000 });
        seen.push(...fileObservations(journey, before.dirs ?? {}, after.dirs ?? {}));
      } else {
        seen.push(notCovered({
          channel: 'effects',
          path: joinPath('file', journey.name, 'anything written'),
          reason: 'needs a sample',
          says: 'Nothing was watched on disk, because no folders were named. Add "watchDirs" under "windows" in the '
            + 'config and what this app saves becomes visible.',
        }));
      }

      const alive = await runner.call('alive', { pid });
      seen.push(observation({
        channel: 'complaints',
        path: joinPath('proc', journey.name, 'still running'),
        value: Boolean(alive.running),
        says: alive.running
          ? 'The app was still running when the check finished, which is what a window app should do.'
          : 'The app had already exited by the time the check finished. For a window app that usually means it fell over.',
        journey: journey.name,
        surface: 'windows',
      }));

      const events = await runner.call('events', { since: startedAt }, { timeoutMs: 60_000 });
      seen.push(...complaintObservations(journey, asList(events.events), path.basename(exe).replace(/\.exe$/i, '')));

      return seen;
    } catch (error) {
      // The machine went away part way through. Keep everything really seen, and say plainly
      // that the rest is unchecked. Never let a short run look like a clean one.
      return [...seen, notCovered({
        channel: 'meaning',
        path: joinPath('screen', journey.name, 'the rest of it'),
        reason: 'timed out',
        says: `"${journey.describe}" stopped part way through on ${host}: `
          + `${error instanceof Error ? error.message : String(error)}. Everything after that point is unchecked, `
          + 'not unchanged.',
      })];
    } finally {
      if (pid && link && link.alive) {
        try { await link.call('stop', { pid }, { timeoutMs: 15_000 }); } catch { /* the link is gone; teardown says so */ }
        startedHere = startedHere.filter((p) => p !== pid);
      }
    }
  },

  /**
   * Put the machine back the way it was found.
   *
   * Only ever stops what this run started — the probe itself refuses any other pid, and that
   * refusal is the last line of defence for somebody's real work sitting on that desktop.
   */
  async teardown() {
    if (link) {
      for (const pid of startedHere.slice()) {
        try { await link.call('stop', { pid }, { timeoutMs: 10_000 }); } catch { /* going away anyway */ }
      }
      startedHere = [];
      try { await link.close(); } catch { /* already closed */ }
      link = null;
    }
  },
});

/**
 * One paragraph about what this adapter can do on a given machine, for `doctor` and for an
 * agent reading the tool's own description of itself.
 *
 * @param {import('../remote.js').RemoteDescription} remote
 * @returns {string}
 */
export function describeWindows(remote) {
  if (!remote.reachable) {
    return `No Windows desktop answers through "${remote.host}", so a native Windows app cannot be checked from `
      + 'here. If the Windows product is Electron — most desktop products are — it is already covered over its '
      + 'debug port and nothing is missing.';
  }
  if (!remote.windows) {
    return `"${remote.host}" answers, but there is no Windows behind it. A native Windows window can only be read `
      + 'from Windows itself.';
  }
  if (remote.desktopLoggedIn === false) {
    return `"${remote.host}" is a Windows machine, but nobody is signed in on it. There is nothing on a desktop `
      + 'nobody has signed into, so signing in once and leaving the session running is what turns this on.';
  }
  const locked = remote.desktopLocked
    ? ' The screen is locked, which is fine — controls read correctly, only full-screen pictures come back black.'
    : '';
  return `${remote.windowsVersion ?? 'Windows'} is reachable through "${remote.host}" and its desktop is signed in, `
    + `so a native Windows app can be opened there and read.${locked} One build at a time, always: Windows shows `
    + 'one desktop and two cannot be up at once.';
}
