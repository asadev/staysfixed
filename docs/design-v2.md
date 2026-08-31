# Stays Fixed v2 — the design

*Written 2026-08-29, from Asad's own statement of what the tool is for.*

> **What this page is, and what it is not.** This is the design and the reasoning behind it,
> kept as it was written so the arguments stay readable — including the ones that turned out
> to be wrong. **It is not a description of the current state.** For that, read
> [the README](../README.md), which says what works, what does not, and what never will; or
> run `staysfixed doctor`, which answers the same question about your actual machine.
>
> **Where it stands, as of 2026-08-30.** Phases 1 to 6 are built and in use: the seven
> observation channels flattened to one address space, the run-twice wobble floor with no
> tolerance setting anywhere, normalisation rules that each declare what they hide,
> clustering, distance-from-the-edit ranking, revert-and-re-run causal proof, the store, the
> reference cut by shipping, sealed classes, sealed intents, the waiver budget, the coverage
> ledger, the self-check corpus, and adapters for command-line tools, libraries, HTTP
> servers, source reading, the web, Electron, Android, iOS and native Windows over ssh. The
> MCP surface is seven tools and it is what `staysfixed mcp` serves.
>
> **What is written and not wired:** nothing. Replaying a recorded session was the last one
> and it landed on 2026-08-31: `staysfixed record` opens the product, follows what a person
> does, walks the session twice against the same build before keeping it, and `--journeys
> recorded` walks it on every later check. Harvesting a project's own test suite was in this
> list too and is wired — `--journeys suite`, opt-in, held to a 90-second budget, every file
> it did not reach named. Journeys otherwise come from what each adapter reads out of your
> source, plus a journeys file you point it at.
>
> **What is permanent and will not change:** nothing irreversible is ever run — it is watched
> at the call and refused at the effect, and the refusal is reported as missing coverage;
> real phones cannot be paired; a race that already existed will not show; native Windows
> shows one desktop, so two builds cannot run there at once; pictures are tied to the machine
> that took them; and how long something took is recorded and never compared. The README
> carries the full list in plain words.

## What it is

Stays Fixed stops being a photo album and becomes a difference machine. You point it at your product, it runs the last build you were happy with and the build you just changed through exactly the same steps on the same machine within the same minute, and it reports only the things that behave differently — what the screen says a control now does, what calls go out, what files get written, what errors appear, what the program prints, and only last of all what it looks like. Nobody approves pictures any more: the build you said "ship" to IS the definition of working, so the only thing you ever have to do is what you already do. The agent runs it through MCP, gets a short ranked list of real differences, proves which ones its own edit caused by undoing that edit and re-running, and fixes them. You hear about it only when a difference lands in a class no agent is allowed to wave through — money, sign-in, lost data, a crash, or a bug you already reported once.

## How it proves nothing changed

Three ideas, in order of how much weight they carry.

FIRST — measure the wobble instead of guessing a tolerance. Every product disagrees with itself a little between runs: a timestamp, an animation frame, an id. So the tool runs the NEW build TWICE. Anything that differs between two runs of the same build was not caused by the change; it is the product's own wobble, and it is subtracted arithmetically. This deletes every tolerance setting in the current tool (`tolerance` in src/core/config.js, gone). It also catches a bug class no screenshot tool has ever caught: a path that was steady in the old build and wobbles in the new one means the change made something non-deterministic.

SECOND — cheap suspicion, expensive proof. The old build's observations are stored, content-addressed against the build artifact, from the last time it ran. A normal check compares NEW-twice against that stored record: fast, no rebuild. Every path that shows a difference then gets the OLD build BOOTED LIVE, in the same minute, on the same machine, and re-walked — and only differences that survive that live re-run are reported. That is what makes paired running affordable enough to leave switched on for iOS and Android, where a full paired run costs two xcodebuild passes. A `--paired` mode runs old live from the start, for pre-release and for the first run on a product with no stored record.

THIRD — sequential, not simultaneous. The brief's "same second" is the one part of the idea I reject. Two builds on one machine fight over ports, single-instance locks, user data dirs, databases and relay slots — his own two-hosts-fighting-over-one-relay-slot incident on 2026-08-28 is exactly this failure. The value was never in the same second; it is in the same machine, same fonts, same OS, same data, minutes apart. Runs are sequential with a full state reset between them, interleaved scenario by scenario so drift cannot accumulate.

WHAT IS COMPARED: seven channels, all flattened to one `path → value` shape so one comparison engine serves every platform. (1) The meaning tree — the accessibility tree, role + name + state, NOT the DOM, because the DOM changes when nothing did. (2) Effects out — network calls, files written, processes spawned, storage writes. (3) Complaints — console, crashes, stderr, exit codes. (4) Results — stdout, HTTP bodies, exported API surface. (5) The contract read statically out of the source: routes, exports, IPC channels. I verified this on Terminal Deck — 462 `ipcMain` registrations in src/, a complete door list obtained free and exactly, none of which any screenshot has ever seen. (6) Coarse counters and timing. (7) Pixels, last, and only as evidence for a finding another channel already made.

WHERE THE STEPS COME FROM, ranked, because this is the real workload answer: read the code (free, exact) → run the project's OWN existing test suite under instrumentation (Terminal Deck has 624 test files sitting there unused for this) → recorded real sessions → the agent exploring one named gap and freezing it into a replayable file → never a person.

NOISE CONTROL, four layers before anything reaches the agent: normalise volatile shapes by rules kept in git, so a version bump in a footer reports zero differences and not five hundred; cluster by signature; rank by DISTANCE FROM THE CHANGED CODE — a difference far from your edit sorts to the TOP, because that is the definition of a side effect; then let the agent prove causation by reverting the suspect hunk and re-running. That last step is the one the five designs only approximated with heuristics, and it is cheap, and it is a proof rather than a guess.

## What survives from v0.3.1

- The freeze layer (~2,068 lines across src/freeze/) — frozen clock, killed motion, seeded randomness, pinned fonts, blocked network. Paired running does NOT make this redundant: it removes differences between the two builds, and this removes the product's own internal nondeterminism, which is what keeps the measured wobble small enough to be useful.
- `settle` (src/freeze/settle.js) — capture until two frames agree. It generalises past pixels to any observation, and it works on every platform because it only ever needs a picture. Best single algorithm in the repo.
- The network record/replay interceptor (src/freeze/network.js), promoted from a determinism trick to the SAFETY BOUNDARY. It is the answer to "what about a payment": the old build replays recorded traffic and never reaches the real world.
- Guards (src/guard/) and the plain-English naming rule — the only behavioural testing in the repo, and the encoded memory of bugs he already reported once. They are the third net for the case both engines are blind to: the old build was already wrong.
- Markers and trace (src/marker/) — promoted to load-bearing. A marker now DEFINES "old", and bisect runs over stored build artifacts, so the bisect actually works instead of needing every commit rebuilt.
- The flake register (src/core/history.js) — moved to the front door: a generated journey that does not reproduce twice on the old build is rejected at birth rather than admitted and condemned later.
- The dependency-free CDP driver (src/drive/) — kept for ELECTRON specifically, because it attaches to an already-running main process over the debug port, which is exactly Terminal Deck's shape and which Playwright handles badly.
- The MCP server (src/mcp/) — the delivery mechanism the whole requirement rests on.
- `doctor` (src/cli/doctor.js) — with seven platforms and a dozen external toolchains it matters more, not less.
- The writing voice throughout. Plain-English output is not decoration here: the agent reads it, and so does he.

## What is thrown away

- Pixel comparison as the primary signal, and `pixelmatch` as the centre of gravity. He said it plainly: not UI/UX, functionality. Pixels drop to channel seven — used as evidence, never as the accusation.
- Every tolerance knob (`tolerance` in src/core/config.js). Replaced by a measured wobble floor. Tolerance settings are how tools like this die: too loose to catch the real thing, too tight to stay switched on.
- `approved/` pictures as the source of truth, and `src/cli/approve.js` with them. The reference becomes a COMMIT, cut automatically when he ships. This is the single biggest cut to his workload in the whole design.
- `src/watch/panel.js` — 3,218 lines, verified the largest file in the repository, a live watch panel built for a human who is explicitly not going to watch. Also `src/watch/window.js` (1,242) and `src/report/html.js` (579).
- `concurrency: 1` as a global posture, and the "two runtime dependencies, no build step, plain JS" constraint — he lifted it in writing.
- Triage's "second-opinion" gate that asks the host for a model via MCP sampling. Sampling is deprecated in the current spec and Claude Code does not implement it; do not build a safety gate on a capability that is not there.
- Differential's proposal to drive Windows through the NovaWindows Appium driver — an unverifiable third-party dependency cited from a blog post. A self-contained FlaUI .NET probe instead.
- Platforms' clean sweep of the hand-written CDP client in favour of Playwright everywhere. Playwright wins for the web; it loses for attaching to a live Electron main process. Keep both — the dependency budget that made this an either/or no longer exists.

## Where the approval line sits

The word "approve" was hiding four different decisions. Split them and the line becomes obvious.

1. WHAT COUNTS AS WORKING — Asad, and only Asad. But he never opens the tool to say it. The reference is cut by an act he already performs: saying ship. One line added to the `ship-everywhere` skill records that build as the new reference. He approves in bulk, retrospectively, by shipping.

2. IS THIS DIFFERENCE REAL, OR IS IT NOISE — the machine, arithmetically, from running the new build twice. No judgement involved, nobody's opinion.

3. IS THIS DIFFERENCE CAUSED BY WHAT I MEANT TO CHANGE — the agent. This is a CAUSAL claim, which is checkable, not an aesthetic one, which is not. The agent proves it by reverting the suspect hunk and re-running; if the difference survives the revert, the agent was wrong and it escalates.

4. IS AN UNINTENDED DIFFERENCE ACCEPTABLE ANYWAY — Asad. This is the only thing that reaches him, and it should be a handful of items a month, arriving inside the closing summary he already reads, never as a report or a dashboard.

The anti-rubber-stamp mechanism, taken from the triage design because it is the strongest safeguard any of the five proposed: the agent CANNOT write a reference. It can only write a waiver, and only through four machine-checked gates. (a) Sealed classes are unwaivable — money, sign-in, data loss, a crash, or any difference touching a named guard go straight to him. (b) The waiver must be consistent with an INTENT the agent sealed BEFORE the check ran, so it has to say what it meant to change before it sees what broke; that makes the claim falsifiable rather than a rationalisation. (c) A budget of five waivers per change — past that it is not a side effect, it is a rewrite, and a person looks. (d) Every waiver is fingerprinted to the exact difference, expires when the reference moves, and is counted out loud in the summary. Waivers are provisional; they become the reference only when he ships.

Where I rejected the alternative: the differential design would let the agent declare a difference intended with a written reason and an expiry. That is unbounded — an agent under pressure to finish will declare the real regression intended, and the reason it writes will read perfectly plausible. Sealing the intent before the run, and sealing five classes off entirely, is what makes the same freedom safe.

## Platforms, in build order

> **Do not install anything off this section.** These were the *plans* for driving each
> platform, and four of them were replaced during the build — Appium, UiAutomator2,
> WebDriverAgent, FlaUI and a Java runtime are named below and **none of them is used**. What
> each surface actually needs, with the exact command, is in
> [settings.md](settings.md); what this machine actually has is
> `staysfixed doctor`. See [what the plan got wrong](#what-the-plan-got-wrong-2026-08-30).

### 1. CLI tools and libraries

- **Driven by:** Plain child-process I/O: stdout, stderr, exit code, files touched, processes spawned, plus the exported API surface read from the source.
- **Effort:** About 3 days
- **In the way:** None. This is the honest place to start, because the whole design stands or falls on whether wobble-subtraction really makes diffs quiet, and that can be found out here in days rather than months.

### 2. Server / API

- **Driven by:** Two ports, two restored copies of a database snapshot, request-and-response diffing, plus a post-migration schema diff.
- **Effort:** About 4 days
- **In the way:** Needs a restorable database snapshot he does not currently keep for every product. Migrations that destroy data are REFUSED rather than run twice, and the refusal is reported as missing coverage, never silently passed.

### 3. Web

- **Driven by:** Playwright (already installed on his Mac, 1.62.1) and its first-class ARIA snapshots for the meaning tree.
- **Effort:** About 4 days
- **In the way:** Only Chromium is downloaded locally; Firefox and WebKit need fetching. Nothing he has to do.

### 4. Electron desktop (Mac and Windows builds)

- **Driven by:** The existing CDP driver attaching to the running main process, plus direct probing of the IPC channel list read from source — 462 of them in Terminal Deck.
- **Effort:** About 4 days
- **In the way:** Two instances of the same app fight over the single-instance lock, the user data dir and the relay slot. Each run needs its own `--user-data-dir` and its own relay identity, or the tool recreates the exact bug diagnosed on his box on 2026-08-28.

### 5. Android APK

- **Driven by:** Appium 3 with the UiAutomator2 driver on an emulator; `emulator -read-only` for the second instance of one AVD.
- **Effort:** About 2 weeks
- **In the way:** His Mac has no Java runtime, `adb` and `emulator` are not on PATH, and Appium is not installed — all fixable without him. The real unknown, which none of the five verified: whether two emulator snapshots restore byte-identically. If they do not, Android falls back to stored-record comparison only, and must say so.

### 6. iOS simulator

- **Driven by:** `xcrun simctl` for the machinery (Xcode 27 and runtimes 26.4 / 26.5 / 27.0 are present) plus WebDriverAgent's `/source?format=json` for the meaning tree, on a cloned device pair with a warm device pool.
- **Effort:** About 2 weeks
- **In the way:** Appium and WebDriverAgent historically lag a new Xcode by months, and Xcode 27 is new. `xcrun simctl` has hung on this Mac before — call CoreSimulator's binary directly. Two `xcodebuild` runs make paired mode pre-release-only, and it really wants a second machine. Real devices are out of reach entirely.

### 7. Windows native (only if he ever ships one)

- **Driven by:** A small self-contained .NET probe built on FlaUI, shipped as one executable, speaking JSON over stdin/stdout, driven over SSH to his office box.
- **Effort:** About 1.5 weeks
- **In the way:** WinAppDriver has been dead since 2020 and Appium's Windows driver still wraps it. UI Automation reads the foreground desktop, so Windows cannot run two builds at once even in principle — sequential only, and the same-minute guarantee weakens. Mostly unnecessary: his Windows product is Electron and drives over CDP from the Mac. Build it last, or never. Verified this session: `ssh imza-pc` and `ssh imza-pc-linux` are the same machine (WSL Ubuntu on DESKTOP-DDGMNCV) with working `powershell.exe` interop onto a real logged-in Windows 11 desktop — so a usable runner exists today, no VM, no CI account.

## The build, in order

### Phase 1 — The engine, on CLI tools and libraries *(About a week)*

The whole difference machine end to end on the easiest surface: seven observation channels flattened to one shape, a JSONL store keyed by name, the run-twice wobble measurement, normalisation rules, clustering, distance-from-the-edit ranking, revert-and-re-run causal proof, and the MCP tools. Ships with a SELF-CHECK CORPUS — a set of deliberately broken builds it must detect — because a tool that reports "nothing changed" is indistinguishable from a broken tool, and none of the five designs noticed that. Useful alone: it guards its own repo and any CLI or library he ships.

### Phase 2 — Web and Electron *(About a week)*

Playwright for browsers, the kept CDP driver for Electron. This is where he first sees it working on Terminal Deck's desktop app and on his live sites. Includes the per-run isolation recipe — separate user data dir, separate relay identity — that stops the tool recreating the two-hosts bug.

### Phase 3 — The reference-at-ship hook and the waiver system *(About 3 days)*

The workload-down phase, and the first one that makes his life measurably easier rather than just his tooling better. `ship-everywhere` cuts the reference automatically. Sealed classes, sealed intent, waiver budget, expiry. Escalations land in the closing summary he already reads. After this phase he never approves a picture again.

### Phase 4 — Read the code, use the suite *(About 4 days)*

The static contract channel and the coverage ledger — all 462 Terminal Deck IPC channels enumerated, with a visible count of how many have never been walked — plus running the project's own 624 test files as instrumented journeys. Turns "how deep is this really" from a claim into a number, and hands the agent its work queue.

### Phase 5 — Android *(About 2 weeks)*

APK coverage on an emulator: the first real answer to "every platform". Starts by installing Java, adb and Appium on his Mac, then proves or disproves byte-identical snapshot restore. If that fails, Android lands as stored-record comparison — still useful, and it says so out loud.

### Phase 6 — iOS simulator *(About 2 weeks)*

The iPhone app covered, pre-release only, on a warm cloned device pair. Wants to run on a second machine over SSH rather than on his laptop while he works.

### Phase 7 — Windows native — only on demand *(About 1.5 weeks)*

The FlaUI probe over SSH to his office box. Built only if he ever ships a non-Electron Windows product. Listed here so it stays a visible decision rather than a silent gap.

## Honest limits

WHERE "EVERY PLATFORM, NO COMPROMISE" DOES NOT HOLD. Web, Electron, CLI, libraries and servers get the full paired treatment. Android and the iOS SIMULATOR get it with real work and one unproven assumption each. Real iPhones and real Android handsets do not — no paired run is possible on a device he is holding. Windows native GUI cannot run two builds at once even in principle, because UI Automation reads whatever desktop is in front. And any product whose old build can no longer be compiled — a yanked dependency, a dead toolchain — falls back to comparing against the stored record from the last time it ran. That fallback is genuinely weaker: it reintroduces every cross-day difference the paired design exists to eliminate. It must announce itself in those words on every run, not degrade quietly.

WHAT "DEEP" HONESTLY MEANS. Every door the code exposes, and every journey the existing test suite already walks. It is NOT every possible state — nothing can enumerate that, and any tool claiming otherwise is lying. The defensible claim is: it catches breaks reachable from the journeys it has, and the coverage ledger names the doors it has never opened, so the hole is visible instead of pretended away.

WHAT IT CANNOT SEE AT ALL. Anything irreversible is observed at the CALL boundary — did the same charge get requested, for the same amount — never at the effect. If a bug only appears after the payment settles or the email lands, this tool is blind to it, by design and permanently. Data-destroying migrations are refused rather than run twice, and refusal is reported as missing coverage. And subtracting the wobble floor actively HIDES intermittent bugs: a race that already existed and got worse will not show. Running the new build twice recovers half of this — it flags anything newly unstable — but only half. That is the sharpest weakness in the whole architecture and I am not going to dress it up.

WHAT HE HAS TO ACCEPT OR PROVIDE. The word "ship", which he already gives — nothing new. A handful of escalated decisions a month, inside the closing summary. A second machine or his office box for the mobile and Windows runs; his laptop should not boot two simulators while he is working. Java on his Mac for Android. And the one unavoidable cold start: on any existing product there is no reference until he ships once with the hook in place, so the first week of any product is guards only.

THREE THINGS ALL FIVE DESIGNS MISSED. None costed the disk — stored build artifacts for a paired system run to tens of gigabytes a year; keep artifacts only at markers, keep the observation files forever since they are small. None handled one repo producing five artifacts through five toolchains, which is exactly Terminal Deck: a change in shared code breaks the phone, so blast radius has to cross artifact boundaries. And none proposed that the tool prove it still catches things — which is why the self-check corpus is in phase one and not an afterthought.

---

## Corrections after Asad's second statement (2026-08-29)

**The loop, in his words, and it is the design.** The agent calls the MCP tool. The tool runs. The
results come back. Everything unchanged is skipped and never reaches the agent's context. What
remains is what changed — and of that, the agent already knows what it meant to change, so the
targets are the differences it did NOT intend. It fixes those and runs again. He is not in this loop
at all, except for the small class of things no agent may wave through.

**On effort.** The fortnight estimates for iOS and Android were wrong in a way worth naming: they
priced the PAIRED machinery — two simulators, cloned devices, byte-identical snapshot restore — not
the act of driving the app. Driving an iOS or Android app and reading what is on its screen is three
or four days. Ship that against the stored record first; add pairing only where the stored record
proves too noisy. The same split applies everywhere: the cheap half of every platform lands first.

**On access.** He offered to install the tool on his PC and hand over an MCP endpoint for it. Not
needed: `ssh imza-pc-linux` is already a working shell on that machine, and it has `powershell.exe`
interop onto the real logged-in Windows desktop. The Windows runner uses access that already exists.
The rule generalises — **the tool reaches every platform through the access the agent already has**,
and it must never ask a person to wire something up that a credential or an SSH host already covers.

**A requirement I had not written down: the tool must describe itself to the AI that installs it.**
Every version ships knowing, in machine-readable form and in plain English:
- what it can check on this machine right now, and what it cannot, and why
- what is missing that would unlock more (a runtime, a device, a snapshot, an SSH host)
- every parameter, endpoint and link needed to make it seamless, filled in where it can be detected
- the shape of its own results, so an agent can act on them without being taught

`doctor` becomes the machine-readable version of this, exposed over MCP as the first call any agent
makes. Nothing about wiring this tool up should ever require a human to read documentation.

## Designing for the stranger, not the owner (2026-08-29)

The owner made a point that changes what `capabilities` has to be:

> "Don't think about just my case, because you have access to everything of mine. Some people will
> not have the device access, so they will have to prepare it. In that case the readme file explains
> it to the AI, so the AI can explain to the person: you need this and you need that."

`capabilities` was being designed as detection — "here is what works on this machine" — which is the
right answer on a machine where everything is already wired. On a stranger's machine the useful half
is the opposite: **what is missing, and who has to fix it.**

So every platform reports one of four states, and the fourth is the one that matters:

1. **Ready** — it works here now. Nothing to say.
2. **The agent can fix this itself** — a package to install, a browser to download, a port to free.
   The tool returns the exact command and the agent just does it. The person is never told.
3. **Only a person can do this** — install Xcode, plug in a phone, log into an account, accept a
   permission dialog, provide an SSH host for a Windows box. The tool returns **what to do, why it
   is needed, and what it unlocks**, written for a person who is not a programmer, so the agent can
   relay it in one clear sentence rather than inventing its own instructions.
4. **Not possible here at all** — a real iPhone cannot run two builds; a Windows GUI cannot be driven
   from a Mac without a Windows machine. Say so, say what the nearest honest alternative is, and stop
   offering it.

The rule this encodes is the owner's own working rule, applied to his users: **never make a person do
what the machine can do.** The agent installs everything installable and hands the human only the
irreducible steps — the ones that need a licence, a device, a password or a pair of hands.

And it must degrade honestly. A project with only the web adapter available is still useful; it must
say plainly "this covers your website; your iPhone app is not being checked and here is why", rather
than reporting a green run that quietly means less than it appears to.

---

## What the plan got wrong (2026-08-30)

Written down because a design document that only records the parts that came true is a
sales page.

**The fortnight estimates for Android and iOS.** They priced the paired machinery — two
emulators, cloned devices, byte-identical snapshot restore — and not the act of driving the
app. Driving one and reading its screen took days. Both shipped against the stored record,
which each run says out loud.

**"Windows only if he ever ships one."** It was built, because a runner already existed: an
ssh host with a WSL shell on a real Windows desktop, nothing installed on it, the probe sent
down the connection each run. The lesson generalised into a rule — the tool reaches every
platform through access the agent already has, and must never ask a person to wire up
something a credential or an ssh host already covers.

**"`doctor` matters more, not less."** True, and understated. It was wrong about this
machine twice on the last night of the build: it asked `command -v powershell.exe` over ssh,
which answers "no" on a machine with Windows sitting right behind it, and it read a git
host's *refusal* as a reply and listed github.com as a machine to run checks on. Both are in
the README's list of silences. The rule that came out of it is worth more than the fix:
**a probe must ask the filesystem, not the path; read standard output, not whatever spoke;
and match the whole line, because a host that quotes your command back can otherwise answer
for itself.**

**Four of the tools named for driving the phones and Windows were never used.** The plan
said Appium 3 with UiAutomator2 for Android, WebDriverAgent for the iOS meaning tree, a Java
runtime for both, and a .NET probe built on FlaUI for Windows. What shipped needs none of
them. Android reads the APK directly — **no Java at all** — and drives the emulator through
`adb`. iOS uses `xcrun simctl` and a small reader compiled at run time with `clang` from the
Xcode command line tools. Windows sends a PowerShell script down an ssh connection each run
and installs nothing on the far machine. Every one of those replacements removed a
dependency rather than adding one, which is why they happened; the cost is that this page,
left alone, would have an agent installing four things nobody needs. The list that is kept
current is [settings.md](settings.md).

**The self-check corpus was the best decision in the whole design,** and the reason is not
the one given here. It was justified as proving the engine catches things. What it actually
did was catch the engine being *perturbable*: it came back "1 of 9 wrong" with the test suite
running alongside it, then passed five times on a quiet machine. That is how the load case
became part of the gate — the corpus and the suite are run at the same time, on purpose,
because that is how it will really be used.
