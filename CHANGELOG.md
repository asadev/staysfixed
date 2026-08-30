# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version
numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.2] — 2026-08-30

Found the same way as 0.7.1, one step further along: install from npm into an
empty folder, run `init`, then run `doctor` on what `init` just wrote.

### Fixed

- **`doctor` read the commented-out examples in a settings file as settings.**
  `staysfixed init` comments out every option that does not apply to your
  project rather than leaving it out, so nothing is hidden from the person
  reading the file — and `doctor` searched the raw text. On a folder holding one
  script and nothing else it announced *"Electron desktop apps: **Covered.** It
  opens release/mac-arm64/Your App.app"*, and an Android app beside it, both read
  out of comments and both false.

  A surface reported as covered when nothing will ever be walked on it is the
  worst answer this tool can give, because every clean result after it is
  believed. Comments are taken away before anything is read out of the file now,
  with strings respected so an address keeps its two slashes — and the file is
  still never loaded, because a settings file may be JavaScript and doctor must
  not run somebody's code to answer a question about their machine.

## [0.7.1] — 2026-08-30

Found by installing 0.7.0 from npm into an empty folder and running it the way a
stranger would, which is the only way this was ever going to be found.

### Fixed

- **`init` asked for a build step on a script that runs straight from source.** A
  plain Node command-line tool is recorded as "not built", because there is
  nothing to build — and that was read as "it has not been built yet". So a fresh
  install told its owner to go and name the command that builds a file sitting
  right there, in the same breath as offering to run it. Being sent shopping for
  nothing is the fastest way to make somebody stop reading the page, and this
  project's README promises it never happens. A test holds it shut.

## [0.7.0] — 2026-08-30

The release where the front door was found to be locked.

Everything written about this tool over MCP was true of code that no client could
reach: `staysfixed mcp` served version 1's picture tools, and `staysfixed init`
wrote version 1's picture settings. The README, `docs/mcp.md`,
`docs/getting-started.md` and the tool's own `capabilities` reply all described
the difference engine. An agent that followed this project's own wiring block got
a tool set none of the documentation mentions, and never reached the engine at
all. Nothing was broken. Nothing was reachable either, which is worse, because it
looks like it works.

That is fixed, and so is the second half of the same mistake: `doctor` was
confidently wrong about this machine, in three different ways, all of them
invisible.

### Changed — the front door

- **`staysfixed mcp` now serves the difference engine.** Seven tools:
  `staysfixed_capabilities`, `_intent`, `_check`, `_explain`, `_prove`, `_waive`,
  `_coverage`. There is still no door marked approve.
- **`staysfixed mcp --v1` serves version 1's picture tools, unchanged.** Nobody who
  wired those up is stranded, and a test holds them there.
- **`staysfixed init` now reads your project properly.** It works out what the
  repository actually makes, writes settings with an explanation beside every
  option, never overwrites a file you already have, and answers with
  `plan.project`, `plan.readiness`, `plan.needs.agent`, `plan.needs.person`,
  `plan.needs.impossible`, `plan.journeys`, `plan.covers.short` and `plan.wiring`
  under `--json`. `docs/getting-started.md` was written entirely around those
  fields against a command that did not produce any of them.
- **Settings for a product with no screen are no longer a puzzle.** `status`,
  `walk`, `approve`, `mark`, `trace` and `check --pictures` all work by opening
  something and photographing it, and a command-line tool has nothing to open —
  which is the correct shape for its settings, not a mistake. They used to answer
  "Stays Fixed does not know what to open" and tell you to add a web address you do
  not have. They now say which half of the tool needs a screen, and name the half
  that covers you without one.

### Added — the MCP surface an agent reads before it calls anything

- **Every tool carries a short title and the protocol's own flags for what it does
  to your machine.** `staysfixed_capabilities`, `staysfixed_explain` and
  `staysfixed_coverage` are read-only and idempotent; `staysfixed_check` and
  `staysfixed_prove` open your product, so they are neither; and none of the seven
  claims to reach the outside world, because none of them does. A client can now
  tell a question from an action without reading any documentation.
- **`journeys: "suite"` and `journeys: "recorded"` are refused by name.** Both are
  written and tested in `src/v2/journeys/`, and nothing on the check path calls
  them, so both used to reach the engine as the name of a file and come back as
  "there is no journeys file at .../suite" — an error that sends an agent looking
  for a file it never asked for.

### Fixed — `doctor` was wrong about this machine

All three were found by running it on a real Mac and checking every line it
printed, which is the only way this kind of mistake is ever found.

- **It asked `command -v powershell.exe` over ssh to decide whether Windows sits
  behind a machine.** That question answers "no" on a machine with a real Windows
  desktop right there: the path is put on `PATH` by an interactive login shell, and
  ssh does not run one. The one true Windows runner in this machine's ssh config
  was reported as not Windows. It asks the filesystem now, for the three places
  PowerShell actually lives, using the same list the code that later drives it
  uses — one list, not two.
- **It read a refusal as an answer.** `ssh github-imza 'echo staysfixed-reachable'`
  is refused by github.com with `Invalid command: echo staysfixed-reachable`, on
  stderr, quoting the command back. A probe that looked for its own word anywhere
  in either stream found it inside the refusal, so three git hosts were listed as
  machines this tool could run checks on — and, by the same bug, as Windows
  desktops. It reads standard output only now, and matches the whole line.
- **It named the first eight machines in an ssh config and dropped the rest without
  a word.** It dials sixteen, and anything past that is named as not dialled rather
  than left out. Undercount and say so; never quietly stop short.
- **It reported Docker as present because the command was on the path**, on a
  machine where Docker Desktop was shut and nothing it promises would have worked.
  It asks the engine for its version now.
- **It said an iPhone app "cannot be done here at all" on a Mac with Xcode and
  three simulator runtimes on it.** The real reason was that this repository has
  no iPhone app in it, which is not a limit of the machine. Those two reasons are
  two different sentences now, and the object carries
  `surfaces[].notInThisProject` so an agent can tell them apart too.
- No probe in `doctor` uses a shell variable or a loop any more. One machine in
  this config reaches Windows through an OpenSSH server that hands the command down
  through a second shell, and every `$p` is expanded to nothing before the shell
  meant to read it sees it — `for p in "A"; do echo "$p"; done` prints an empty
  line there. Literal arguments only.

### Fixed — what an agent actually reads

- **`staysfixed_explain` printed `(SEALED: [object Object])`** on the one reply an
  agent reads when it is trying to understand a difference it may not waive.
- **The same sentence arrived twice in one check reply** — "not everything was
  checked", once under the headline and again inside the summary — and the values
  of a one-address finding were printed twice in `explain`. Both are said once now.
- **`staysfixed_coverage` printed the same line three times.** Several of the
  coverage caveats share one headline and differ entirely in their reason, so a
  list of headlines was one sentence repeated and none of the three reasons. The
  reason is printed with each.
- **"2 journeys were walked" no longer sits one line above "2 of the 2 ways into
  this product have never been walked through."** Both numbers were right and the
  two sentences contradicted each other on screen: a journey is one route through
  the product, a door is one way into it, and they now have two different words.
- **The tool no longer advises you to do something it cannot do.** Three places
  told you to harvest your own test suite as journeys. That is written and not
  wired, so all three now name what does work today.

### Changed — what a fresh install pulls

- **`playwright` is out of `dependencies`.** Nothing in `src/` imports it — browsers
  are driven over the debugging protocol by code in this repository — and having it
  there made a fresh `npm install staysfixed` pull about 18MB against a README
  promising two packages under a megabyte. It stays a `devDependency`, and it is
  still what `doctor` tells you to install in YOUR project when you want a browser
  of your own.
- **`docs/` ships with the package**, so an agent that installed this from npm can
  read `docs/getting-started.md` without a network.

### Changed — everything else in this batch

- **A check gives your screen back.** An app the tool opens comes to the front once,
  because that first appearance is how you see what is happening; from the moment
  you pick something else, anything the tool launched loses the argument
  permanently. The window it opens is placed beside the app rather than over it,
  and a window that is going to be left up is waited for while one that is going
  away is not.
- **The store writes whole lines or says plainly that it did not.** A full disk is
  the one storage failure that happens to real people mid-run, and it now reads as
  a full disk rather than as a corrupt record.
- **Ranking says which of two answers it has.** When distance from the edit cannot
  be worked out, the finding is still reported and still counted, and the reply
  says that its position is a guess rather than letting the order imply a
  confidence nobody has.
- **The self-check corpus grew again**, including a case where the store itself
  cannot be written to — a machine-shaped failure that has to come back as "no
  answer" rather than as a clean run.
- **The scratch checkout a causal proof makes is put away, and says so plainly when
  it will not go.** A file that vanished between git listing it and the copy
  reaching it is not a failure; a directory that will not delete is, and the two
  used to share one empty catch.

## [0.6.2] — 2026-08-30

Something to watch it with, and the first proof on a real product that somebody
else built.

### Added

- **A live panel showing what the tool now is.** Version 1's panel showed screens
  and pictures, because that is what version 1 did. This one shows a product being
  proven unchanged: which surface each journey walks, which build it is being
  measured against and how that build was chosen, addresses ticking up as they are
  watched, how much wobble was measured and subtracted, the findings that survived,
  what was **not** checked, and the one or two things only a person may decide. The
  wobble figure is given room on purpose — it is the number that explains why the
  tool is quiet.
- **A focus guard, so watching it work never costs you your screen.** An app the
  tool opens is allowed to come to the front once, because that first appearance is
  how you see what is happening. From the moment you pick something else, anything
  the tool launched loses the argument permanently. There is no flag for it and
  nothing to configure: an Electron app calls `focus()` from its own main process, a
  simulator activates when it boots, a browser activates when a window opens, and
  none of that goes through us — so the only thing that works is watching who is in
  front and handing the screen straight back. It learns which application is yours
  by watching what you choose, never by being told, and it says nothing at all
  unless it actually had to act. Measured on a real desktop app: five grabs over
  five seconds, five handed straight back.

### Fixed

- Three rendering defects, each of which would have told somebody something untrue:
  a verdict trimmed twice, so a run with four findings — two of them sealed —
  announced *"Everything that worked still works"*; a build that lost its name on a
  second trim and became "an unnamed build"; and a `\b` inside a template literal
  eaten before the regular expression saw it, so permanent coverage gaps were
  painted as though a person could act on them.
- **A check that finished before its window opened waited out a twenty-second
  timeout.** The check never waited on the panel, but stopping did: a 2.2 second
  check took 20.7 seconds of wall time. Opening is cancellable now and a window that
  arrives late closes itself. A 100ms check ends in 277ms.

### Proven

- On a real product that somebody else built: a reference cut at **15,147
  addresses** across 17 journeys, two agent-shaped breaks caught in 12.6 seconds
  with the break far from the edit correctly outranking the one inside it, and
  silence restored when both were undone. Its iPhone app built and driven in a
  simulator of the tool's own; its Android app built and driven on a throwaway
  emulator.
- With the panel open throughout: same verdict, same 1,776 addresses, 110 events
  pushed, 104 delivered, none dropped. Closing it mid-run changes nothing.

## [0.6.1] — 2026-08-30

Documentation only, and it is a correction rather than a polish. The README
described where journeys come from in the words of the design — read the code,
then harvest the project's own test suite, then recorded sessions — and only the
first of those is wired into `staysfixed check`. The suite harvest, session
recording and the flake register are written and tested in `src/v2/journeys/` and
nothing on the check path calls them. Both places that implied otherwise now say
so plainly. A feature that exists in the repository and not in the run is not a
feature you have.

## [0.6.0] — 2026-08-30

The second sweep for silences, done the same way as the first: read all of
`src/v2` looking for anything that can drop something and then report nothing
found. Five more were there, and two of them were in the safety machinery
itself — the gate that decides what an agent may never wave through, and the
proof that decides whether a change explains a break.

Every fix below has a test that fails against yesterday's code and passes
against today's. That was checked by putting the old behaviour back, one line at
a time, in a copy of the repository, and watching each test go red.

### Fixed — silences, second sweep

- **Only the first 80 differences of a finding were read when deciding whether it
  was one of the five things nobody may wave through.** A cluster can hold
  hundreds of addresses; a refund sitting at address 150 of 300 was classified
  ordinary, which means an agent could waive it and it would never reach a
  person. Every difference is read now. A cap on the one gate that cannot have
  one is not a performance decision, it is a hole.
- **The causal proof re-checked five addresses and then spoke for all of them.**
  A finding of three hundred where the first five went away came back "caused by
  that change" — a machine-checked reason for an agent to close a break it had
  only half explained. It re-checks every address now, and when a change explains
  part of a finding and not the rest it says exactly that, with both numbers. It
  costs nothing: the journeys were already re-walked and each extra address is one
  lookup.
- **A wobble big enough to swallow the comparison was still subtracted, and the
  run came back clean.** If the second run of the new build falls over, or the
  product writes hash-named files, or stamps a fresh id on every line, most of its
  addresses are unsteady, nearly every difference is dropped before anything is
  compared, and the verdict reads "nothing that already worked has changed". A
  build that disagrees with itself about more than half of its own addresses now
  gets **no verdict**: the summary opens with `NO ANSWER FROM THIS RUN`, the
  reason is a named hole in the coverage, and `ok` is false. No number here
  decides whether any difference is real — it decides only whether the run has
  earned the word clean.
- **Two facts written at one address lost one of them, silently.** Every index in
  the engine keeps the first observation at a path, so a second one is never
  compared with anything and a door that broke behind it is invisible. The
  detector for this was written on the first day of v2 and nothing ever called it.
  Every walk is checked now and each clash is named — which address, and what the
  ignored answer was. Identical repeats are not reported, because they hide
  nothing.
- **The route reader skipped a folder it could not open, and every route behind
  it, without a word.** This is the same bug as the one fixed yesterday in the
  file walk, in a second function that the first fix did not touch. It names the
  folder now.

### Added

- A twelfth case in the self-check corpus, and a third kind of expectation with
  it: a product so unsteady that the comparison is thrown away before it happens,
  where the only honest answer is that the run says nothing. Confirmed to fail
  against 0.5.0 and pass against this. Measured after the change: twelve of
  twelve, three times running, with the project's own suite in parallel and the
  machine's load average between 208 and 343.
- Six more tests in `test/v2/silences.test.js`, one per fix above, each confirmed
  red against the previous code.

### Changed

- `readFileRoutes(root)` returns `{ doors, problems }` rather than an array. The
  problems are folders it could not open, and they are reported as missing
  coverage by every caller.

### Known, and written down rather than fixed

- What a normalisation rule rubbed out is not itemised per run. The receipt
  exists in the code and nothing calls it. The rules are in your repository and
  the capture is stamped with which set it used, so a comparison across a rule
  change is announced — but a broad rule is still how you go blind on purpose.
- Ranking reads up to 4,000 source files of up to 400KB. Past that a finding is
  still reported and still counted; it may just not sort where it deserves to.
  Nothing is dropped for being far from the change.

## [0.5.0] — 2026-08-30

The release about the one way this tool can be catastrophically wrong: reporting
nothing while something is broken. Five separate places could do that, and one of
them could do it permanently.

### Fixed — silences

Each of these produced a clean-looking run while something was invisible.

- **A `git diff` too big to read was treated as no diff at all**, so a large
  uncommitted change was fingerprinted as a clean checkout of the commit it sat
  on. If that commit was the reference, the check was comparing the build against
  itself, and a comparison of a build with itself can only ever come back clean.
  The diff is now streamed into a hash with no ceiling, and a git command that
  fails is refused loudly rather than read as "nothing has changed".
- **A folder with no git in it** gave every build the same identity, with the same
  consequence, quietly and for ever. It is now refused, with a sentence saying
  why.
- **The two ends of a huge output were kept with only a rough size**, so a break
  in the middle that was thrown away left a byte-identical record. The exact byte
  count is kept now, and a truncated value is reported as missing coverage rather
  than passed over.
- **An adapter that threw while listing what it would walk had its journeys
  dropped in silence** — a whole surface disappearing from a run whose verdict
  then read "nothing that worked has changed". It is recorded as a hole, by name.
- **A folder the source reader could not open was skipped without a word**, taking
  every door behind it. It is named now, along with any file still too big to read.
- **The normalisation-rule stamp on a stored capture was written and never read.**
  Comparing a record tidied up under one set of rules against a run tidied up
  under another produces differences that are about the rules; the run now says so.

### Changed — how long something took is recorded and never compared

A stopwatch on a shared machine measures how busy the machine is at least as much
as it measures the product. Measured on the corpus's own fixture: thirty runs of
the same one-line program on an idle Mac took 48ms to 96ms, against a bucket
boundary at 100ms — four milliseconds of headroom, so any load at all crossed it.
That is what made the self-check come back "1 of 9 wrong" one busy evening and
then pass five times in a row on a quiet machine.

Durations are still measured and still shown, in the sentence beside the address,
where a person can read them. They are no longer differenced, on any platform.
**Stays Fixed will not tell you your product got slower.** A build that hangs is
still caught, because it is stopped for taking too long and how it finished is
compared exactly, and every counter that comes from the product rather than from
the clock is compared exactly as before.

### Added

- **Two more cases in the self-check corpus**, eleven in total: a break buried in
  the middle of an output too big to store, and a build ten times slower that must
  stay silent. Both were confirmed to fail against the previous code and pass
  against this one.
- **The corpus re-runs a case before accusing the engine.** Fail twice and it is a
  real failure. Behave the second time and it is reported as *could not tell* —
  not a pass, not a failure, exit code 2 — with the machine's load beside it.
  Measured after the change: eleven of eleven, three times running, with the
  project's own test suite in parallel and load average between 227 and 334.
- `test/v2/silences.test.js`, holding each of the above shut.

## [0.4.0] — 2026-08-30

The difference engine, published. Seven observation channels flattened into one
address space; the new build run twice so the product's own wobble is measured
and subtracted rather than guessed at; differences clustered, ranked by distance
from the changed code, and their cause proven by reverting the suspect change and
running again. The reference is cut by saying ship, and an agent may waive within
four gates but can never decide what "working" means. Adapters for processes,
HTTP, source reading, the web, Electron, Android, iOS and Windows, and a
self-check corpus of deliberately broken builds.

## [0.3.0] — 2026-08-29

Checks tick off live as they run, and guards show what they assert.

## [0.2.0] — 2026-08-29

Pictures you can look at, motion, and a report that says what was checked rather
than only how long it took.

## [0.1.0] — 2026-08-29

The first version. It is a first version: it works, it has been used, and it has
not been used by many people yet.

### Added

- **Picture checks.** Opens the real app, photographs the screens listed in the
  config, and compares each one against the picture a human approved. Anything
  that moved fails the run until a person looks at it and says yes.
- **Guards.** One check per bug that was already fixed once, named in plain
  language ("the sidebar still collapses"). The tool refuses names that read like
  code identifiers or issue numbers, because the name is what somebody has to
  understand six months later.
- **Walk.** Opens the built app before a release, walks the screens in order,
  photographs each step, and leaves behind a single page you can scroll through.
- **Markers.** Pins a known-good moment — a release, or just before something
  risky — and `trace` then reports the last marker where a screen still looked
  right, the first one where it did not, and the commits in between.
- **A flake register.** Every run is remembered. A check that changes its mind
  while the code stood still is recorded as a flake, and past the limit it is
  condemned and says so in red until a person fixes it or deletes it.
- **The freeze layer.** Frozen clock and time zone, animations and transitions
  stopped, seeded randomness, external network requests blocked or replayed from
  recorded fixtures, fonts and images waited for, text rasterisation pinned,
  scrollbars and text carets hidden, and a settle loop that only accepts a photo
  once two in a row agree.
- **An MCP server**, so Claude Code, Codex, Gemini CLI, Cursor and anything else
  that speaks the Model Context Protocol can check their own work the moment they
  finish editing. The approve tool is not offered to an agent unless the project
  explicitly opts in, and it is off by default.
- **Commands:** `init`, `check`, `approve`, `walk`, `mark`, `trace`, `status`,
  `flake`, `doctor`, `mcp`.
- **Web apps and Electron apps.** Config in JavaScript, or in JSON so a project
  in any language can use the tool without anybody writing JavaScript.
- Two runtime dependencies, `pngjs` and `pixelmatch`. No build step: the source
  in the repository is the code that runs.

### Known limits

- Not published to npm yet. Run it from GitHub: `npx staysfixed`.
- Approved pictures are tied to the operating system that took them. A picture
  approved on macOS will not match on Linux.
- Untested on Windows.
- Chromium-based rendering only — Chrome, Chromium, Edge, Brave, or the Chromium
  inside your Electron app. No Firefox, no WebKit.
- No phone or tablet simulators.
- No hosted service, no dashboard, no accounts.

[0.5.0]: https://github.com/asadev/staysfixed/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/asadev/staysfixed/compare/v0.3.1...v0.4.0
[0.3.0]: https://github.com/asadev/staysfixed/compare/v0.2.3...v0.3.0
[0.2.0]: https://github.com/asadev/staysfixed/compare/v0.1.1...v0.2.0
[0.1.0]: https://github.com/asadev/staysfixed/releases/tag/v0.1.0
