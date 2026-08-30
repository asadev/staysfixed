# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version
numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.9.0] — 2026-08-30

Found the same way as 0.8.0 and one better: the published build was installed as a stranger
installs it and used on real throwaway products — a café API, a static site, a library, a
server that spawns its own child — until it said something untrue. And this time the repo's
own CI was read, which had been **red for ten releases** while every summary said the tests
passed. It was red for two real reasons, both below.

**The tool was breaking the products it was sent to protect**, and on some shapes it never
came back at all. Those two are why this release exists.

### Fixed — it broke the product, or itself

- **Refusing a connection killed the program that made it.** The refusal was delivered by
  emitting `'error'` on the socket; at that instant nothing is listening, and in Node an
  `'error'` with no listener is a thrown exception. `http.get` on Node 22 — the floor this
  package declares — and a bare `net.connect` on every version died with exit 1, and the run
  then reported the user's product as broken. The refusal is real now rather than simulated,
  so the operating system produces it through Node's own plumbing.
- **`check` printed its whole answer and never exited.** A start command runs through a
  shell, so the server is a grandchild; killing the shell left it alive holding the output
  pipe, so the event loop never emptied. It also orphaned the server. The shell is started as
  its own process group now and the whole group is signalled.
- **Two agents shipping at once lost what "working" means.** Six ships, all reporting
  success, four records, and the "already the reference" path never firing. The whole cut is
  one at a time per product now.
- **Every killed run left a whole copy of the project in the temporary folder, for ever** —
  777 MB of them on an ordinary machine. Abandoned copies are reclaimed; a copy a live run
  owns is never touched.

### Fixed — it said things that were not true

- **The agent was told "everything that worked before still works"** about a run that
  compared nothing at all, while the terminal correctly called it no answer. The engine's
  verdict is the floor for the machine surface now, so this class cannot come back one reason
  at a time.
- **A sealed money change reached the agent labelled `"ordinary"`** — the human text said
  sealed, `waive` refused it, and the JSON said it was waivable.
- **The seal that exists because somebody was burned before could never fire.** Guard names
  were never passed to the decision, so that class was empty on every run this tool has ever
  done. And a check on a project with a guard in `.staysfixed/guards` printed the word
  "guard" zero times: not run, not counted, not mentioned.
- **A guard that asks nothing was reported as holding.** An empty `run()` came back as
  "still holds", and would have said so every day for ever.
- **The library journey never imported anything.** `init` writes `module: "index.js"`; the
  probe treated that as a package name, failed identically on both builds, and the check said
  "Nothing that worked has changed" for ever.
- **`ship` blessed a build nothing had looked at.** It matched by git commit, so an
  uncommitted edit resolved to an earlier build that had been checked and was clean.
- **`doctor` said a check "here" covers things in a folder where a check cannot run at all.**
- **`--only` printed "everything that worked still works"** about a slice.
- **`init` and `doctor` both offered `check --paired` as the way to record a reference.** It
  cannot; only shipping cuts one, on purpose. `doctor` also marked it as something the agent
  could do — the single thing an agent must never do.
- **`status` said nothing had happened** one command after a check and a ship.
- **It called the person's own browser "a separate application from the browser you use"**,
  which is the one case where that sentence matters and the one case it was false.

### Fixed — it could not see, or would not run

- **Full Chrome was invisible on Linux and Windows.** Playwright and Puppeteer both unpack
  into `chrome-linux64` and `chrome-win64`; only macOS uses the names this looked for. On
  Linux, the very command this tool tells people to run left a browser it could not find.
- **`status`, `walk`, `flake`, `approve`, `mark` and `trace` told a website it had no
  screen** — they only knew version 1's `app:`, and `init` writes version 2's `web:`.
- **The sign-in example `init` writes used two words the tool does not know**, and a step made
  only of unknown words was skipped in silence — so the form was never filled, every page
  behind the login photographed the login page, and the run came back clean.
- **A browser's throwaway profile outlived an interrupted run.**

### Fixed — it was noisy or unhelpful

- **Renaming one heading came back as five findings**, none of them saying "renamed". A thing
  addressed by its own words is now recognised when it is renamed, and its children travel
  with it.
- **`doctor` connected to every machine in your ssh config, unasked, on the first run.** Nine
  connections on a brand-new scratch project. It is asked for now, and the machines are still
  listed either way.
- **Every command-line check wrote two rows** to the log `ship` reads.
- **The `.gitignore` lines `init` writes matched nothing version 2 writes** — 151 untracked
  files and 1.9 MB of run evidence in `git status` after nine checks.
- `check --json` now carries `notChecked` and `doorsNeverOpened`, which the README had
  promised and only the MCP reply had.
- `init` no longer names `staysfixed check --product <name>`, which is not an option.
- The docs said the self-check builds seventeen products; it builds twenty.
- `process.alsoWatch` is documented.

## [0.8.0] — 2026-08-30

The night this was pointed at itself. Everything below was found the same way:
the published build was installed the way a stranger installs it, and used on
throwaway products — a plain-Node server, an Express API, a Flask app, a static
site, a Vite app, a bare Gradle project, an empty Xcode project, a CLI that
reaches the internet three ways — until it said something untrue. Reading the
code found none of it.

**Two of them were the tool lying about itself**, which is the worst thing this
product can do: it told every agent that asked that it could read web pages and
then could not open one, and it reported a clean run over an entire uncovered
HTTP surface. Both are closed.

### Changed

- **`staysfixed init` now runs version 2's setup.** It ran version 1's picture
  setup until now. Version 2's `init` had been written and tested and was wired
  to nothing — the command table deliberately left it out, on the grounds that
  somebody might have `staysfixed init` in a setup script and would get a
  different file. True, and not a reason: version 1's `init` writes settings for
  photographing screens, which is not what this tool does any more, so a new
  project got the wrong shape of file and was told it was set up. `init --json`
  now answers with the fields `docs/getting-started.md` tells an agent to read —
  `plan.project`, `plan.readiness`, `plan.needs.person`, `plan.journeys`,
  `plan.covers.short`.

- **`staysfixed check --watch` opens version 2's panel, not version 1's.** This
  is the one flag whose meaning moved, and it is written down here because
  nothing else said so. The panel draws what a difference engine finds —
  journeys, wobble, findings, a verdict — where version 1's drew approved
  pictures, which this tool no longer has. `--pictures --watch` and `--guards
  --watch` still open version 1's panel over version 1's run, so the only person
  whose command changed meaning is the one who typed `--watch` on its own.

- **The scratch copy is cloned, not copied.** Every run works in a throwaway copy
  of the project so it can write anywhere it likes without touching the real one,
  and that copy used to be made byte by byte. On the project this was built
  against — twelve gigabytes, most of it an iOS build folder — that is twelve
  gigabytes of real disk per build and twenty-four per check, before a single
  journey is walked. It now asks the filesystem to clone instead: on a Mac that is
  one call per file that copies no bytes at all and shares the blocks until
  something writes to them, and on Linux the same where the filesystem supports
  it. Measured on that tree: **41.5 seconds and no bytes moved.** It falls back to
  a real copy wherever cloning is not available, so a filesystem without it is
  slower here and never wrong. Never a symlink and never a hardlink — both point
  back at the real project, which is the one thing the copy exists to protect.

### Added

- **`process.skip` — folders to leave out of that copy.** A project can name
  folders that are not worth copying, and a copy that takes over twenty seconds
  now says so and points at the setting. **The bar is deliberately high: only
  things regenerated on demand and read by nothing.** Anything skipped that turns
  out to matter makes a run pass for the wrong reason, and a false pass is the one
  failure this whole tool exists to prevent. It can only ever add to the built-in
  list — `.git`, `.staysfixed`, `.turbo`, `.nyc_output`, `coverage`,
  `.pytest_cache`, `__pycache__`, `.DS_Store` — because a setting that could
  switch one of those back on would only ever make runs slower.

- **`docs/settings.md` — every option, and what each surface needs on the machine.**
  None of the roughly ninety settings keys the adapters read was written down
  anywhere: the README said the reference "lives with the code it configures",
  which is no help at all to somebody who is not going to read the code. Nor was
  anything the code needs installed: the exact commands for Xcode, the iOS
  runtime, the Android SDK and its emulator, and the two separate ways a browser
  can be missing were all sitting in the source as `howToGet` strings and in none
  of the documentation. It also names the things that quietly cost you coverage —
  an Android Play Store image, which refuses root forever so the files an app
  writes cannot be seen; a `web.start` or `http.start` that hard-codes its port; a
  Windows desktop nobody is signed in to.

- **The README now lists the silences that are still open,** beside the table of
  the ones that were found and closed. A table of closed bugs on its own reads as
  though nothing is left. Twelve rows, each with the file that would close it.

- **`staysfixed browsers` is reachable.** It was written, tested, given a finished
  command entry with a comment saying "wiring it up is one line" — and that line
  was never written. README.md told people to run `npx staysfixed browsers` and
  `npx staysfixed browsers --clean` to clear up after an interrupted run, and both
  answered *"There is no command called browsers"*. Somebody whose disk was
  filling with abandoned browser profiles had no way to clear them and no reason
  to doubt the page telling them there was.

### Fixed

- **`staysfixed ship --version 0.14.0` printed `0.7.2` and shipped nothing.**
  `--version` is a global flag meaning "print the tool's version", and it is also
  one of `ship`'s own options meaning "the release that went out was called this".
  The two lists were concatenated, the parser reads switches before values, so the
  global one won: the release script got the tool's version number on standard
  output, exit code 0, and no reference cut. A command's own flags now win any name
  they share with a global one.

- **`staysfixed walk --no-snap` answered "I do not know the option --no-snap".**
  `--no-snap` — leave both windows where they are instead of putting them side by
  side — was read by `walk` and declared by nobody. It is now in `walk`'s options
  and in its help, so `docs/watching.md` saying both commands take every panel flag
  is true again.

- **The very first run on a project answered `ok: true` to a machine.** With no
  build on record there is nothing to compare against, so the run proves nothing.
  It said exactly that, in words, in the summary, and the command line exited 2 on
  it — but `--json` and the MCP reply both carried `ok: true`, with no `blocked`
  and none of the `NOTHING WAS ACTUALLY COMPARED` wording. An agent reads the
  fields, not the sentence, so the two interfaces that matter most reported a pass
  over a run that compared nothing. That is the exact failure this tool exists to
  prevent, produced by the tool itself. `comparedNothing` fired only on
  per-journey gaps, which a true cold start never records; it now fires on an
  empty `reference.id` as well, and the rest of the codebase was swept for the
  same shape — `ok` computed from "were there findings" rather than from "was
  anything compared at all".

- **The README said a fresh install pulls two packages under a megabyte.** It
  pulls three: `playwright-core` became a runtime dependency, which is the browser
  driver without a browser in it — about 13MB, and still nothing that takes
  minutes. The install section now says what actually happens, including that a
  browser already on the machine is found and used before anything is downloaded,
  and that a project already using the full `playwright` is never asked for a
  second copy of the same driver.

- **`staysfixed check --guards-only` does not exist and never did.**
  `docs/guards.md` had told people to run it since it was written. The flag is
  `--guards`.

- **`staysfixed rules` and `staysfixed browsers` were both named in the README and
  neither existed.** `browsers` has been wired up; there is no `rules` command, so
  the README now says where the rules actually are — one file,
  `.staysfixed/rules.json`, read like any other file in a pull request.

- **`--watch-width 100` is refused, not quietly widened.** `docs/watching.md` said
  anything under 240 or over 900 was brought back to the nearest of the two. Under
  240 is an error with a message; over 900 is brought down.

- **`--profile` prints nothing on a difference-engine check.** It works on
  `staysfixed walk` and on the version 1 picture check. The flag is accepted by the
  new check and the timings are not kept, so `docs/watching.md` no longer claims
  otherwise.

- **`staysfixed doctor --json` does not fill the project path into its MCP wiring
  block** — `staysfixed init --json` does. `docs/mcp.md` had said both did.

- **`docs/design-v2.md` named four tools that were never used.** It is a plan
  rather than a description and says so at the top, but it is also the only
  per-platform prose in the repository, and it told anybody reading it that
  Android needs Appium, UiAutomator2 and a Java runtime, iOS needs WebDriverAgent
  and Windows needs a .NET probe built on FlaUI. None of those is used. What
  shipped needs none of them, and the section now says so before the list rather
  than after it.

- **`--color` was accepted by every command and did nothing.** Colour is settled
  before anything else loads, so by the time a command is parsed the answer is
  already fixed and nothing on the command line could turn it back on. `--no-color`
  works and always did — it is handled first thing, before the logging module
  decides. `--color` has been taken away rather than left as a switch that turns
  nothing on.

### Added — products it could not see before

- **A hand-written `node:http` server is read.** A product with `createServer`, a
  chain of `req.url === '/x'` and `.listen(PORT)` was reported as "one thing: the
  `notes` command", found zero routes, left the `http` block commented out, and
  said **"a check here covers the `notes` command in full. Nothing is being left
  out."** over an entire uncovered surface. The same product written with Express
  was handled perfectly, so the machinery worked and the reading stopped at
  frameworks. Eight hand-rolled routing shapes are now read — `req.url === '/x'`,
  `.startsWith`, a `switch` on a pathname, `new URL(req.url, base).pathname`,
  `url.parse`, the `split('?')[0]` variant, `if`/`else if` chains, and a path held
  in a constant — and a method is claimed only where the code checks one, `ANY`
  otherwise, never `GET`.

- **Python products are checkable.** A Flask app was told "a Python project is not
  being checked… in a language nothing here drives". The honesty was right and the
  conclusion was wrong: the two adapters that would run it read no source at all.
  The process adapter runs a command and compares what it printed, exited with and
  touched; the http adapter boots a server and asks it for routes. Flask, FastAPI
  (including an `APIRouter` prefix) and Django `urlpatterns` are now read, and
  their path parameters become the same "somebody has to give a real value" flow
  every other route uses. Go, Rust, Ruby and PHP get the boot and the command
  without the routes — and every one of them says, **by name**, that the source
  channel is blind for that language, so none can reach "covered in full".

- **`--journeys suite` walks the project's own test suite.** It was written,
  tested and reachable by nothing. Each test file runs twice inside the scratch
  copy with the same frozen clock, seed and watcher as everything else, and every
  check is reported by name, along with why each failure failed and a fingerprint
  of the test file itself — so an edited test says plainly that the change is
  yours. It earns its keep: take the penny-rounding out of a `total()` and the
  product's own output does not move by one character, the discovered journeys say
  nothing has changed, and the harvest names the check that turned red. Off unless
  asked for, held to `suite: { budgetMs }` (90 seconds by default, `0` for none),
  and **every file the budget did not reach is named one by one** rather than
  summarised as "some tests were skipped".

- **`keepBuilds` — how much of the record is kept.** The store grew for ever: one
  build folder per commit, in your git history, with the function that would have
  stopped it written and called by nothing. Three tiers now, capped by count and
  not by age, and it refuses to remove anything at all if any record could not be
  read.

### Fixed — the tool being wrong about itself

- **It could not open a single web page, and said it could.** `playwright` was
  dropped from the dependencies on the reasonable-looking grounds that nothing
  under `src/` imported it. Nothing does — the web adapter reaches it through
  `await import()`, which no search for an import statement can see. So every
  website check on a fresh install answered "Playwright is not installed, so no
  web page can be opened", while `staysfixed_capabilities` told the calling agent
  that web apps and sites could be checked *here and now*. The dependency is back
  as `playwright-core` — the driver without a browser in it, 13MB and no download,
  because this tool already knows how to find Chrome for Testing, Chrome, Edge or
  Chromium and deliberately prefers one that is not the browser you use. A test
  holds it in place by name, and holds `doctor` and the walk to the same answer.

- **An Android project with no APK built was reported as covered in full,** and
  then could not be walked at all. iOS already named the missing build and the
  exact `xcodebuild` line; Android now names the Gradle one. A Tauri app read as
  ready on any machine with no Windows host, because `doctor` returns no Windows
  needs precisely when there is no Windows to ask about.

- **Version 1 passed a page with a letter missing from its heading.** The picture
  check's default allowed 0.05% of a picture through, described in a comment as
  "enough for font hinting noise, nowhere near enough to hide a missing
  stylesheet". On a 2880×1800 screenshot that is **2,592 pixels**; taking one
  letter out of an `h1` moves **593**. The replacement was measured rather than
  chosen — ten fresh takes of the same build differ by **zero** pixels — so the
  default is now zero, and a project that sets `tolerance.pixels` is told, per
  screen, how many pixels its setting just swallowed.

- **The network boundary let everything out.** The watcher injected into every run
  read the host off the first argument, but Node normalises `Socket.connect` to
  `[options, callback]` — so the host read as an empty string, which was in the
  loopback allow-list. `fetch`, `http.get` and `net.connect` to the open internet
  all succeeded and the report came back empty, while the tool's loudest safety
  claim said every outbound connection had been refused. All three are now refused
  and recorded by host and port.

- **`npm run start` died silently** — the default start command `init` writes for
  every Node server. The watcher wrapped `process.env` in a Proxy with only `get`
  and `has` traps, so `process.env.X = 'y'` quietly failed, npm could not pass
  `npm_lifecycle_event` to the script, and it exited 1 without printing a word.
  Every trap now forwards through `Reflect`, with `set` taking the target as the
  receiver.

- **Every route, and every command, read as never walked.** A door is addressed
  `route.<VERB>.<url>` and `cli.<the command>`; the adapters wrote `api.<journey>`
  and `cli.<journey name>`. So the coverage ledger — the one part of this tool
  that must never be optimistic — was instead permanently and wrongly pessimistic,
  and a genuinely uncovered door was invisible in the noise.

- **A normalisation-rules caveat fired on every run, for ever.** A per-run
  temporary folder was baked into a rule pattern and collided with the real
  project-root rule, so the rule set contained a fresh random pattern every run —
  and the real rule was silently deleted, meaning absolute paths under your
  checkout were never normalised at all.

- **A committed change could not be ranked.** "The change" meant the working tree
  and nothing else, so the moment an agent committed its work — which is what an
  agent does at the end of a task — the distance measure went blind and every
  finding carried "nothing in the working tree has changed, so there is no edit to
  measure this against" over a change that was perfectly well known.

- **The scratch copy copied every byte.** On the project this was built against —
  twelve gigabytes, most of it an iOS build folder — that is twelve gigabytes of
  real disk per build and twenty-four per check. It now asks the filesystem to
  clone: **41.5 seconds and no bytes moved**, measured on that tree. Never a
  symlink and never a hardlink, because both point back at the project this exists
  to protect.

### Fixed — caps that decided things quietly

- **A finding's nearby files were cut to five, and the sealed classes are searched
  in that list.** A finding whose sixth file was `src/billing/refund.js` was
  classified `ordinary` — precisely the class an agent may close on its own.

- **A waiver was pinned to the first 40 differences and 20 addresses of a
  finding.** A waiver written over a three-hundred-address finding went on
  covering it after the value at address 41, 150 or 299 became something else.

- **A wobble storm needed twelve addresses before it counted,** so ten of eleven
  wobbling was not a storm: ten real differences subtracted, and the run passed.

- **Eight address truncations with no fingerprint,** across four files. Two long
  labels, two journey names, two log lines or two checkpoints that agreed for the
  first 60 to 200 characters landed on one address and one of the two answers was
  thrown away at the door. Two of them were screenshot filenames, so the picture
  offered as evidence for a finding could be a photograph of a different screen.

- **`trimForStorage` cut in characters against a byte limit.** On box-drawing or
  CJK output, 90,000 bytes in produced 180,061 bytes stored — the whole text twice
  — under a marker claiming 24,464 bytes had been left out of the middle.

- **Files over 8MB were compared by a size bracket, not a fingerprint,** so a
  build that wrote a different 40MB file compared equal. They are stream-hashed
  now, and the remaining ceiling is named in the ledger.

- **An adapter that did not answer in time made its surface READY.** The race
  resolved an empty needs list, and no needs meant covered — so an Android adapter
  hanging for sixteen seconds produced "Covered against the stored record."

### Changed — words a person reads

- **The watch window opened on a fifteen-line paragraph.** Its headline was right
  and the engine's entire summary sat underneath it as one grey block. Nothing is
  dropped — the summary is split at sentence ends, two are shown, and the rest sit
  behind one control.

- **A finding titled with the tool's own word.** A renamed route read as
  `"declared" is gone`. Twenty-seven such words are now recognised, so it reads
  `"/notes / declared" is gone` instead.

- **A sentence that said a thing was now what it already was.** When both sides of
  a change summarised to the same words, the summary was the wrong thing to print.
  The flagship case now reads: *"GET /invoice / body" now has "line" reading "A
  desk lamp ......... 49.99 GBP" where it read "A desk lamp ......... £49.99"*.

- **The first error anybody meets writing a guard was raw JavaScript** —
  `page.goto is not a function`. It now says what the object it was handed
  actually has, in one sentence, and suggests a name only when exactly one is
  close.

- **The shipped examples were for a shape the tool no longer uses.** Both said
  "copy this to the root of your project"; doing that today gets you a settings
  file the difference engine rejects. Each now says which half it belongs to, and
  points at `staysfixed init` — which beats any example, because it reads the
  project in front of it.

### Removed

- **Fourteen exports nothing called.** Ten were genuinely dead. Two were missing
  features and are now wired: `treeMovedSince`, the one thing `intent.js` promised
  and nothing checked, and `RUNNER_KINDS`, which validated nothing while an unknown
  runner kind was silently treated as posix. Two were kept and wired because
  deleting them would have quietly broken a promise the documentation makes.

- **`ios.suite` was advertised in a message telling somebody how to switch
  something on.** Nothing anywhere read it.

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
