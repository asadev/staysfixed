# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version
numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
