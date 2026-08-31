# Stays Fixed

**Prove that nothing which already worked has changed — and let the agent do the
reviewing.**

An AI agent changes twenty files in four minutes. What breaks is almost never the
thing it was working on: it is something in a corner that had already been built,
already been fixed, and that nobody thought to look at again. The agent cannot
check that corner, because it does not know the corner exists.

So Stays Fixed runs your product through the same steps twice, compares it
against the build you were last happy with, subtracts everything the product
disagrees with itself about, and hands back **only the differences nobody asked
for**. Everything unchanged is skipped and never mentioned. The agent already
knows what it *meant* to change, so what is left is its work queue.

You are not in that loop, and you never approve anything. **What "working" means
is cut by something you already do: saying ship.** You hear about it only when a
difference lands in a class no agent may wave through — money, signing in, lost
data, a crash, or a bug you already reported once — and then it arrives as three
plain sentences inside the summary you were reading anyway.

---

## The loop

1. The agent seals what it **meant** to change, before it runs anything.
2. It changes some code.
3. It calls `staysfixed_check` over MCP.
4. Everything unchanged is skipped and never reaches its context.
5. What comes back is what changed. It already knows what it intended, so the
   targets are the differences it did **not** intend.
6. It fixes those and runs again. Anything it genuinely meant, it can record as
   intended — five times, never in a sealed class, and only inside what it
   sealed in step 1.

> "You will call the MCP, make it run the tests, the results come back, then you
> decide. Whatever is unchanged will be skipped. The things that changed other
> than the ones you actually did yourself — those ones are the targets. So you
> will not burn your tokens reviewing every single thing. You will only review
> what actually matters."

---

## Install

```
npx staysfixed init
npx staysfixed check
```

No account, no sign-up, no server anywhere, nothing uploaded. It works in any
project in any language — it only needs to be able to run your product.

Requirements: **Node 22 or newer**, and **git** — your project has to be a git
repository. Not for history's sake: git is how an old build is put back on the
machine to be walked live, and how a difference is measured against the code you
just changed. A folder with no git in it is refused outright rather than checked
against a guess. Everything else depends on what you are watching, and the tool
works out what it has:

```
npx staysfixed doctor
npx staysfixed doctor --json      # the same answer, for an agent
```

Everything each kind of product needs — the exact programs, the exact install
commands, the settings keys and the licences only a person can accept — is in
[docs/settings.md](docs/settings.md).

`doctor` is the first thing you should run and the first thing an agent should
call. It says what it can check on this machine, what it cannot, what is missing,
and the exact command that would fix each gap — and it never suggests setting up
something that already works, because everything it lists as missing failed a
real check first.

Every kind of product comes back in one of four states, and the last two are the
ones that matter:

| State | What it means for you |
| --- | --- |
| **ready** | It works here now. Nothing to say. |
| **the agent can fix this** | Everything in the way installs with a command. The agent runs it and never mentions it to you. |
| **only a person can do this** | A licence, a device, a password, a pair of hands. You get *what to do, why it is needed, and what it unlocks* — one sentence each, so being asked for half an hour of your time comes with what you get for it. |
| **not possible here** | No command on this machine changes the answer. It says so, says the nearest honest alternative, and **stops offering it**. |

Two separate questions are answered separately, because folding them together is
how a surface gets called ready while nothing is ever walked on it:

- **can this machine run it** — is there a simulator, an emulator, a browser, a
  Java runtime, another machine it can already reach over SSH;
- **can this copy drive it** — is the adapter for that kind of product actually
  in this build of the tool.

A Mac with Xcode on it can run an iPhone app. That says nothing about whether
there is anything here that knows how to open one, and `doctor --json` answers
both under `surfaces` and `drivers`.

And it never sends you shopping for nothing. A project with no phone app in it is
never told to install Java or thirty gigabytes of Xcode — it is told there is no
phone app here to check.

### What a fresh install downloads, and what it does not

`npm install staysfixed` pulls **three packages and no browser** — `pixelmatch`,
`pngjs` and `playwright-core`, about 13MB together on a Mac. `playwright-core` is
the part that drives a browser; it is deliberately the version that **downloads
none**, so nothing here takes minutes and nothing lands in a shared cache behind
your back.

Checking a **website** needs an actual browser, and the tool looks for one you
already have before asking for anything: Chrome for Testing, Chromium, Edge or
Chrome. If there is none on the machine at all, that is one command:

```
npx playwright install chromium
```

Measured on a Mac in August 2026 that is about **570MB** in a shared cache
outside your project — 371MB for Chrome for Testing and 196MB for its headless
shell — downloaded once per machine, not once per project. `doctor` tells you if
you need it, and it is one of the things an agent can simply do without asking
you. A project that already drives its own tests with the full `playwright`
package is used as it is and never asked to install a second copy of the same
driver.

Checking a **desktop app** needs no browser at all and no download: the app is
its own Chromium, and the tool drives it over its own debugging port.

**Checks never open the browser you use.** Given the choice they open Chrome for
Testing or Chromium — a separate application — because on a Mac two copies of one
browser share a single slot, and a check running in the background can end up
answering when you click your own browser icon. If your machine has nothing but
your everyday browser, it is used, invisibly and on a throwaway profile, and
every run says so out loud rather than borrowing it quietly. Nothing it opens
uses your profile, nothing it opens survives the run, and nothing it did not
start is ever closed:

```
npx staysfixed browsers            # which browser checks open, and why
npx staysfixed browsers --clean    # clear up after a run that was interrupted
```

---

## What is real today

This is a repository in the middle of a rebuild, and the README is not going to
pretend otherwise.

| | State |
| --- | --- |
| Picture checks, guards, walk, markers, flake register | **Shipped.** Published as `staysfixed` 0.3.x and in use. Reached from `staysfixed check --pictures` and `--guards`, and over MCP with `staysfixed mcp --v1`. |
| The MCP server an agent wires up — seven tools, no door marked approve | **Works,** and it is what `staysfixed mcp` serves. It served version 1's picture tools until 0.7.0, which meant every word written about the engine over MCP was true of code no client could reach. |
| `staysfixed init` reading the repository and writing settings you can read | **Works,** and it is what `staysfixed init` runs. Also wired up in 0.7.0, for the same reason. |
| `doctor` describing this machine in plain English and as JSON | **Shipped.** Three of its probes were wrong about the machine it was run on until 0.7.0 — see [the silences](#the-silences-that-were-found-and-closed). |
| The difference engine — the address space, normalisation, wobble subtraction, clustering, ranking, causal proof, the store, the MCP tools, the self-check corpus | **Works.** |
| Command-line tools, libraries and HTTP servers | **Works.** |
| Reading the contract straight out of your source — routes, exports, message channels — without running anything | **Works.** 5,785 doors read out of one desktop app in 1.4 seconds. |
| Websites, through a browser of the tool's own | **Works.** |
| Electron desktop apps, over their own debugging port | **Works.** |
| The reference cut when you ship, sealed intents, the waiver budget, and escalations in your closing summary | **Works.** This page describes what it actually does. |
| The coverage ledger — every door counted, the unopened ones named, and the sentence saying so on every reply | **Works.** See [what it did not check](#what-it-did-not-check). |
| Aiming a check at one kind of product, and refusing by name rather than checking something else | **Works.** |
| Steps taken from your own test suite | **Works.** `--journeys suite` runs each test file twice inside the scratch copy, reports every check by name and why each failure failed, and stops after 90 seconds naming every file it did not reach. It is opt-in: running a stranger's whole suite twice on every check is not a thing to do by default. It catches what nothing else can — remove the penny-rounding from a `total()` and the product's own output does not move by one character, the discovered journeys say "nothing has changed", and the harvest names the check that turned red. |
| Steps taken from a recorded session, or rejected at birth for not repeating twice | **Written, not wired.** The code is in `src/v2/journeys/` with tests around it, and nothing on the check path calls it yet. Ask for `--journeys recorded` and you are told so by name. |
| Android APKs on an emulator | **The adapter is here.** It reads everything the APK declares with nothing installed and no Java, and where there is an emulator it installs one build at a time and walks it. Whether *this* machine can run one is a separate question, and `doctor` asks the adapter itself rather than keeping a second opinion — most of what it wants installs with a command; accepting Google's licence, once, needs a person. Two emulator snapshots restoring byte-identically is unproven, so Android compares against the stored record and says which mode it used. |
| The iOS simulator | **The adapter is here.** It reads what the app bundle declares with nothing running, and where Xcode and a simulator runtime are present it installs one build at a time, boots it and reads what is on the screen. It is new. Paired running costs two `xcodebuild` passes, so it is for before a release rather than for every edit, and like Android it compares against the stored record and says which mode it used. Ask `doctor` what it is actually covering on your machine before trusting a clean run. |
| Native Windows GUI (a real Win32 app, not an Electron one) | **Works,** and it has now been driven end to end: a real Win32 window on a Windows 11 desktop reached over ssh, 10 addresses read out of the UI Automation tree, a reference cut, and the next run compared against it. Nothing was installed on that machine — the program that reads the screen is sent down the connection each run. Windows shows one desktop, so two builds can never run at once: the comparison is genuinely weaker here than anywhere else, and a run says so rather than hiding it. |

All eight surfaces — command-line tools, libraries, servers, websites, Electron,
Android, iOS and native Windows — have now actually been run against a real
product, rather than only having an adapter and tests. That sentence was not true
before 2026-08-31, and the four that were unproven each turned out to have at
least one defect that only running them could find.

`staysfixed check` is the front door for both. Version 1's flags still mean
exactly what they meant yesterday — `--pictures`, `--guards` and `--only` reach
the same code they always did, on the settings you already have, and `staysfixed
mcp --v1` still serves the picture tools. Nobody who installed this last week has
to change anything.

**Two things did change, and they are worth reading if you installed this before
today.**

`--watch` moved. `staysfixed check --watch` opens **version 2's** panel — the one
built for a difference engine, which draws journeys, wobble, findings and a
verdict. Version 1's panel drew approved pictures side by side, which this tool no
longer has. `--pictures --watch` and `--guards --watch` still open version 1's
panel over version 1's run, so the only person whose command changed meaning is
the one who typed `--watch` on its own and got a picture check they did not ask
for. Everything about the panel is in [docs/watching.md](docs/watching.md).

`staysfixed init` now writes settings for the difference engine. On a product with
no screen those settings have no `app` block in them, and the picture commands say
so plainly rather than telling you to invent a web address. Add an `app` block
yourself if you want picture checks too.

## How it proves nothing changed

Three ideas, in order of how much weight they carry.

### 1. Measure the wobble. Never guess a tolerance.

Every product disagrees with itself a little between runs — a timestamp, an
animation frame, an id. So the tool runs the **new build twice**. Anything that
differs between two runs of the same build was not caused by your change: it is
the product's own wobble, and it is subtracted arithmetically.

There is no tolerance setting in version 2 and there is not going to be one.
Tolerance knobs are how tools like this die — too loose to catch the real thing,
too tight to leave switched on.

Version 1's picture check is the proof, and it was caught doing exactly that.
Its default allowed 0.05% of a picture through, with a comment saying that was
"enough for font hinting noise, nowhere near enough to hide a missing
stylesheet". On a 2880×1800 screenshot, 0.05% is **2,592 pixels**. Taking one
letter out of a page's main heading moves **593** — so the check reported
"Everything that worked still works" over a page anybody could see was wrong.
Ten fresh takes of that same build differ by **zero** pixels, because the freeze
layer underneath is thorough enough to make that true. So version 1's default is
now zero as well: a project whose product genuinely wobbles can set
`tolerance.pixels`, and every run then says in words how many pixels that
setting just swallowed.

It also catches a bug class no screenshot tool has ever caught. A path that was
**steady** in the old build and **wobbles** in the new one means the change made
something unpredictable. That is a finding, even though no single value can be
pointed at.

### 2. Cheap suspicion, expensive proof.

Comparing against the stored record is fast and needs no rebuild, so that runs
first. Every path that then looks different gets the old build **booted live, on
the same machine, in the same minute**, and walked again. Only differences that
survive that live re-run are reported.

`--paired` goes straight to the expensive half — old build live from the start.
That is for pre-release, and for the first run on a product with nothing recorded.

### 3. Sequential, never simultaneous.

Two builds at the same instant fight over ports, single-instance locks, user data
directories, databases and relay slots. The value was never in the same *second*:
it is in the same machine, same fonts, same operating system, same data, minutes
apart. Runs are sequential with a full state reset between them, interleaved
journey by journey so drift cannot accumulate.

---

## What it looks at

Seven channels, all flattened to one shape — a path, a channel, and a value — so
one comparison engine serves every platform. Pixels are last and are only ever
evidence for something another channel already found.

| Channel | What it holds |
| --- | --- |
| `meaning` | What the interface says a control is and does — its role, its name, whether it is on, off or disabled. Not the underlying markup, because markup changes when nothing did. |
| `effects` | What the product sent out into the world: calls made, files written, processes started, things saved. |
| `complaints` | What the product complained about: console messages, errors, crashes, the code it exited with. |
| `results` | What the product gave back: what it printed, what it answered, what it offers other code. |
| `contract` | The doors the source says exist: routes, exported functions, message channels. Read without running anything. Free, and exact. |
| `counters` | Rough counts — files written, calls made, doors answered. Compared exactly. How long something took is **recorded and never compared**: see [what it will never do](#what-it-will-never-do). |
| `pixels` | What it looked like. Used to show a person a problem another channel already found. |

An address reads left to right, widest thing first:

```
api.GET./users.status
cli.build.exit
ipc.session:create.registered
screen.home.tree.button:Save.enabled
```

Three kinds of difference come out, and the last one is the kind no screenshot
comparison has ever noticed: **changed**, **appeared**, and **vanished** — a
door that closed.

**Where the steps come from**, ranked, because this is the real workload
question: read the code (free, exact) → run the project's own existing test suite
under instrumentation → recorded real sessions → the agent exploring one named
gap and freezing it into a replayable file → never a person clicking through an
app.

What is wired into `staysfixed check` today is the first of those, a journeys file
you point it at, and — when you ask for it — the project's own test suite. Each
adapter reads your source and offers the journeys it can walk: routes, commands,
screens, message channels. `--journeys <file>` names steps by hand. `--journeys
suite` runs each test file twice inside the scratch copy, reports every check by
name, and stops after 90 seconds naming every file it did not reach. Recorded
sessions and the flake register are written and tested in `src/v2/journeys/`, and
**nothing on the check path calls them yet**. Saying so is the point: a feature
that exists in the repository and not in the run is not a feature you have.

## Keeping it quiet

Four layers before anything reaches the agent: **normalise** volatile shapes by
rules kept in git, so a version bump in a footer reports zero differences instead
of five hundred; **cluster** by signature, so one cause reads as one finding;
**rank by distance from the changed code**, so a difference far from your edit
sorts to the **top** — that is the definition of a side effect; then let the agent
**prove causation** by reverting the suspect hunk and running again. That last
step is a proof, not a heuristic.

Every normalisation rule buys quiet by making some real differences invisible.
The rule that quietens a wobbling clock also hides a genuinely wrong date. So the
rules are data, not code: they live in git, they get reviewed like any other
change, and every one carries a `wouldHide` field in plain English saying what it
covers up. `explain()` answers for any value it changed — what was replaced,
where, by which rule, and what that rule admits it might be hiding. The test
suite fails if a rule ships without one. See
[docs/how-v2-works.md](docs/how-v2-works.md).

---

## What it did **not** check

This is the most important thing the tool says, and the reason is arithmetic
rather than modesty. A tool that reports "nothing changed" is indistinguishable,
from the outside, from a tool that looked at nothing — and the more useful it
becomes, the less anybody reads past the headline.

So every reply carries what was left out, **in the same breath as the good
news**, on clean runs as loudly as on dirty ones. There is no version of the
answer that omits it.

```
ok Nothing that worked has changed. 601 addresses checked against 0.13.0, run
   live. … NOT EVERYTHING WAS CHECKED: 391 of the 452 ways into this product
   have never been walked through, so nothing here says anything about them,
   and 2 other things were not looked at. A clean result only covers what was
   walked.

What this run did not check

  391 of the 452 ways into this product have never been walked through.
      A break behind any of them is invisible to this tool. Point a journey at
      them - name the steps in a journeys file and pass it with --journeys.
```

A **door** is any way into your product the source declares: an HTTP route, an
exported function, a message channel between a desktop app's two halves, a
command in your `package.json`. They are read straight out of the code without
running anything — 5,785 of them out of one desktop app in 1.4 seconds, 452 of
those message channels.

Three rules hold the count honest:

- **A door read out of the source is not a door that was walked.** Knowing a
  door exists is not evidence that anything opened it, and getting that backwards
  would report perfect coverage on a product nobody ever ran.
- **Never a percentage.** A percentage invites a target, a target invites gaming,
  and a gamed coverage number is worse than no number because somebody believes
  it. Counts, and the names of what is missing.
- **Undercount rather than overcount.** Where the evidence is ambiguous the door
  is recorded as unopened, and the reason is written down beside it.

Even a run that walked every door it knows about refuses to claim it checked
everything, because it did not: it checked every way in *this tool knows about*.

```
staysfixed check --json            # coverage.doorsKnown, coverage.doorsWalked, coverage.gaps
```

Over MCP it is `staysfixed_coverage`. Every `staysfixed_check` reply says it in
words directly under the headline, and the JSON form carries `notChecked` and
`doorsNeverOpened` as fields of their own rather than only as prose — a number an
agent has to go looking for is a number it skips.

And on a clean run only, the reply also says what a clean result **on this
machine** actually means: *"this covers your website; your iPhone app is not
being checked at all, and here is why."* Nothing inside a run can know that — a
run only knows what it walked — so it comes from the machine survey and lands
beside the good news, which is the one place it cannot be missed.

### A run that compared nothing is not a pass

There is one shape of clean result that would be a lie: every journey walked on
the new build, nothing on record from the old one, zero differences found, and a
verdict reading *nothing that worked has changed*. It is arithmetically true and
it would let a real regression through. That run comes back as **`NOTHING WAS
ACTUALLY COMPARED`**, it is not a pass, and it exits non-zero.

**The cold start is the same thing, and it is now marked the same way.** The very
first run on a project — before anybody has shipped once with the hook in place —
has no reference at all, rather than a reference with nothing in it. For a while
only the command line caught that: it said *"Nothing to compare against yet… this
run proves nothing about what still works"* and exited 2, while `--json` and
`staysfixed_check` over MCP both carried `ok: true` with none of those words. An
agent reads the fields, not the sentence, so the two interfaces that matter most
reported a pass over a run that compared nothing — the exact failure this tool
exists to prevent, produced by the tool itself. Both now answer `ok: false` with
**`NOTHING WAS ACTUALLY COMPARED`**. `reference.id` is still worth reading — an
empty string means nothing was compared, whatever else a reply says.

### The silences that were found and closed

Every one of these left something invisible while the answer looked complete —
most of them a clean-looking run, and the last four an honest-looking description
of a machine. They are listed because a tool like this earns trust by naming the
ways it has been wrong, not by claiming it never was. All of them were found on
2026-08-29 and 2026-08-30 by reading the whole thing looking for the same shape
as the first one, and each has a case in the corpus, a test, or a probe rewritten
to ask the question a different way.

| It used to | Now |
| --- | --- |
| Skip any source file over 2MB **without a word**, then report that it had found no source at all — so a desktop app whose main process is one 3.5MB bundle had all 452 of its message channels silently unread | Reads up to 24MB, and names any file it still cannot open |
| Skip a folder it could not open, and every door behind it, silently | Names the folder and the reason, as missing coverage |
| Keep the two ends of a huge output and a **rough** size, so a break in the discarded middle left a byte-identical record | Keeps the exact byte count, and says out loud that only the ends were compared |
| Drop a whole adapter's journeys when it threw while listing them — a surface disappears and the verdict reads "nothing has changed" | Records it as a hole, by name, in the coverage |
| Treat a `git diff` too big to read as **no diff**, so a large uncommitted change was fingerprinted as a clean checkout — and if that commit was the reference, the check compared the build against itself and could only ever come back clean | Streams the diff into a hash with no ceiling, and refuses outright rather than guessing. A folder with no git in it is refused for the same reason |
| Read only the first **80** differences of a cluster when deciding whether it is one of the five things nobody may wave through — so a refund at address 150 of 300 was classified ordinary, and an agent could waive the lot | Reads every difference in the finding. There is no ceiling on the one gate that cannot have one |
| Re-check the first **five** addresses of a finding when proving whose change caused it, then say "caused by that change" about all three hundred — a machine-checked reason for an agent to close a break it had only half explained | Re-checks every address, and says in words when a change explains part of a finding and not the rest. It costs nothing: the walk already happened |
| Subtract the new build's own wobble even when the wobble had swallowed the comparison — a second run that fell over makes almost every address unsteady, everything is dropped before it is compared, and the run ends "nothing that already worked has changed" | A build that disagrees with itself about most of its own addresses gets **no verdict**: the run says NO ANSWER FROM THIS RUN, in those words, and is not a pass |
| Keep the **first** of two facts written at one address and ignore the second, so a door that broke behind a duplicated address could never be compared with anything. The detector for this was written on day one and never called | Every walk is checked for it, and each clash is named in the coverage: which address, and what the ignored answer was |
| Skip a folder it could not open **while looking for routes**, and every route behind it — the same bug as the one above, in a second place, still silent | Names the folder, and the routes behind it are reported as unread rather than as absent |
| Serve version **1**'s picture tools when an agent wired up `npx staysfixed mcp` exactly as this page says to. Everything written about the difference engine over MCP was true of code no client could reach | `staysfixed mcp` serves the seven tools above. Version 1's are behind `--v1` |
| Ask a machine `command -v powershell.exe` over ssh to find out whether Windows sits behind it — a question that answers "no" on a machine with Windows right there, because that path is added by an interactive login shell and ssh does not run one. It also read a **refusal** as an answer, so `github.com` was listed as a machine to run checks on, and as a Windows desktop | Asks the filesystem for the three places PowerShell actually lives, using the one list the code that later drives it uses. Reads standard output only, and matches the whole line, so a host that quotes your command back cannot answer for itself |
| Name only the first eight machines in an ssh config and drop the rest without a word | Dials sixteen, and anything past that is named as not dialled rather than left out |
| Report Docker as present because the command is on the path, on a Mac where Docker Desktop is shut and nothing it promises would work | Asks the engine for its version, and says "installed but not answering" when that is the truth |
| Read the **commented-out examples** in a settings file as settings. `staysfixed init` comments out every option that does not apply to your project, so nothing is hidden from you — and doctor searched the raw text. On a folder holding one script it announced "Electron desktop apps: **Covered.** It opens release/mac-arm64/Your App.app", and an Android app beside it. A surface called covered when nothing will ever be walked on it is the worst answer this tool can give | Comments are taken away before anything is read out of the file, with strings respected so an address keeps its two slashes. The file is still never loaded — doctor must not run your code to answer a question about your machine |
| Ask for a build step on a plain command-line tool. A script that runs from source is recorded as "not built", because there is nothing to build, and that was read as "it has not been built yet" — so a fresh install told its owner to name the command that builds a file sitting right there, in the same breath as offering to run it | Nothing is asked for when there is nothing to build, or when a command to run it has already been worked out |

### The silences that are still open

The table above is the honest half of a habit, and it would be a dishonest half
on its own: it lists what was found and closed, which reads as though nothing is
left. These are the ones that are **still open today**, found the same way, by
reading the code rather than the documentation. Every one of them can end in a
clean-looking answer, and the file that would close each one is named so nobody
has to take this on trust.

Seven rows left this table in one night. They are in the closed table above now:
a wobble storm that needed twelve addresses before it counted, so ten of eleven
wobbling passed; a desktop control compared to its first 200 characters; an
unreadable folder losing every page of a website behind it; two screens with one
name collapsing into one walk; a waiver pinned to the first 40 differences of a
finding rather than all of them; and three iOS ceilings that stopped counting
without saying so. What is below is what is genuinely left.

| What is invisible | Where |
| --- | --- |
| **What the scratch copy leaves out is left out of *both* builds.** A product that actually needs one of the folders named under `process.skip` fails the same way twice, so the difference engine sees no difference and the run reads clean. The defaults are only caches and reports, and the bar is written down — but a project that adds to that list can hide a real break from itself. | `src/v2/adapters/process.js` — `SKIP_BY_DEFAULT` |
| **Working out what a repository makes reads at most 300 files, four folders deep, and skips any file over 2MB.** A product it never notices is never configured and never walked, so it is missing from the coverage ledger rather than named in it — the one kind of gap the ledger cannot show you. | `src/v2/detect.js` |
| **Values nested more than 64 levels deep are compared as "too deep" rather than by their contents.** It will never go quiet about one, but it cannot say what inside it moved. This only ever applies to a value read back off the disk; observations made in this run refuse that depth at the door. | `src/v2/observation.js` |
| **A change buried in the middle of an output larger than 64KB can be missed.** Both ends are kept and compared along with the exact number of bytes dropped, so a middle that grew or shrank shows up. One that changed without changing length does not. | `src/v2/adapters/contract.js` — `trimForStorage` |
| **How long anything took is recorded and never compared.** A build that got twice as slow is not a finding. This one is deliberate and permanent — a stopwatch on a shared machine measures the machine at least as much as the product — and a build that *hangs* is still caught, because it is stopped for taking too long and how it finished is compared exactly. | by design |
| **On Windows and as root, one self-check case cannot run.** It takes away the permission to write, to prove the tool still answers when the disk gives out; neither honours that. The case reports itself as untested rather than as a pass, and the closing line counts it separately. | `src/v2/selfcheck.js` |
| **The distance from a finding to your edit has three ceilings: 4,000 source files, 8 imports out, and 400KB per file.** Past any of them the ranking for that finding is a guess. It is not silent — a run that hit a ceiling says so and names the files it could not read — but the order is worth less than the rest of the list. | `src/v2/rank.js` |

---

## Aiming a check at one thing

By default a check walks everything your settings describe. To aim it at one kind
of product:

```
staysfixed check --surface web --at http://localhost:3000
staysfixed check --surface electron --at ./release/mac-arm64/YourApp.app
staysfixed check --surface android --at ./app/build/outputs/apk/release/app.apk
staysfixed check --surface ios --at ./build/YourApp.app
```

The important half is what happens when it cannot go there. A tool that quietly
ignored an option it did not understand would check whatever it was going to
check anyway and hand back a **perfectly clean result about the wrong thing** —
the most dangerous shape a reply can have. So:

- aimed at a kind of product this project does not contain → it refuses, by name,
  and nothing is checked;
- aimed at a kind of product this copy of the tool has no adapter for → it
  refuses, and names the adapter that is missing;
- given an address no adapter would ever read → it refuses rather than dropping it;
- and a run that *did* go where it was aimed says so, so a clean result can be
  trusted to be about the thing you named.

---

## Where the approval line sits

The word "approve" was hiding four different decisions.

1. **What counts as working** — you, and only you. But never by opening this
   tool. The reference is cut by something you already do: saying ship. You
   approve in bulk, retrospectively, by shipping.
2. **Is this difference real or is it noise** — the machine, arithmetically, from
   running the new build twice. No judgement, nobody's opinion.
3. **Did my own edit cause this** — the agent. That is a *causal* claim, which is
   checkable: revert the suspect hunk, run again, and if the difference survives
   the revert the agent was wrong and it escalates.
4. **Is an unintended difference acceptable anyway** — you. This is the only thing
   that reaches a person, and it should be a handful of items a month.

**An agent can check, and it can waive within limits. It can never decide what
"working" means.** That is cut by shipping, by a person, and there is no tool on
the MCP surface that could move it — not refused, not on the list.

An agent's only door is a waiver, and it passes four machine-checked gates:

1. **Sealed classes are unwaivable.** Whatever the reason, whoever is asking.
2. **The waiver has to agree with an intent sealed *before* the run** — so the
   agent says what it meant to change before it sees what broke. Sealing one
   afterwards is refused, and the refusal says so in those words.
3. **Five waivers between one ship and the next.** Past five it is not a change
   with side effects, it is a rewrite, and a person looks at a rewrite. Sealing
   another intent does not buy five more.
4. **Every waiver is fingerprinted to the difference it was written about** and
   dies the moment the reference moves. Change that value and it stops covering
   anything. The pin is the finding's title, up to twenty of its addresses and up
   to forty of its differences — see [the silences that are still
   open](#the-silences-that-are-still-open) for what that means on a very large
   finding.

Every waiver is counted out loud in the reply. "Nothing changed", "nothing ran"
and "everything was waived" read identically otherwise, and two of those three
are a safety net quietly announcing success.

### The five sealed classes, in full

These go to a person whatever any agent believes, and there is no setting that
turns them off:

| | |
| --- | --- |
| **a bug somebody already reported once** | A guard exists because this exact thing broke before and somebody had to say so. A difference here means it is back. |
| **a crash** | The product stopped, or started stopping. Nothing about that can be intended. |
| **losing data** | Code can be edited back. Data that was deleted cannot. |
| **money** | A charge, a price or a refund that goes out wrong costs a real person real money. |
| **signing in** | Getting this wrong locks the right people out, or lets the wrong people in. |

### Saying ship

```
staysfixed ship --why "0.14.0 to TestFlight"
```

One line at the end of your release script, after the thing has actually gone
out. The build you shipped becomes the standard every later check is compared
against; every outstanding waiver is retired, because what it covered has either
shipped and become normal or has to be decided again.

It never fails your release. And it **refuses to make a build the standard if
that build was never checked, or was checked and found broken** — your release
still succeeds, it just tells you what "working" means did not move, and why.
Cutting a broken build as the standard is exactly how a safety net turns into a
rubber stamp.

### What actually reaches you

A handful of things a month, in three sentences each — what changed, why no agent
could wave it through, and what to do — inside the closing summary you were
reading anyway. Not a report, not a dashboard, not a link:

```
Stays Fixed: 1 thing needs your word on terminal-deck.

1. The checkout total now says 9.99 where it said 10.00
   No agent may wave this through: it touches money.
   Say whether that is the amount you wanted. If it is, shipping makes it the
   new normal; if it is not, nothing ships.
```

Five things can land there and four of them are rare on purpose: a sealed class;
the waiver budget running out with differences still outstanding; something that
used to give the same answer every run and now does not; a check that could not
run at all; and, once, the fact that you have never shipped with the hook in
place so there is nothing to compare against yet. A clean run produces none of
them and says one line: *nothing needs your word.*

```
staysfixed check --escalations notes.txt   # the same block, in a file
```

---

## For AI agents (MCP)

Claude Code:

```
claude mcp add staysfixed -- npx -y staysfixed mcp
```

Cursor, Gemini CLI and most other clients take the same block — `.cursor/mcp.json`,
`~/.gemini/settings.json`, or your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "staysfixed": {
      "command": "npx",
      "args": ["-y", "staysfixed", "mcp"],
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

Codex keeps the same fields in TOML, in `~/.codex/config.toml`:

```toml
[mcp_servers.staysfixed]
command = "npx"
args = ["-y", "staysfixed", "mcp"]
cwd = "/absolute/path/to/your/project"
```

| Tool | What it does |
| --- | --- |
| `staysfixed_capabilities` | **Call this first, once per session.** What it can check on this machine right now, what it cannot and why, what is missing that would unlock more, and the exact shape of every reply. It runs nothing. After this call an agent should not need to read any documentation about this tool. |
| `staysfixed_intent` | Seal what you **meant** to change, before you run a check. This is what makes a later "that one was me" claim checkable instead of a story. |
| `staysfixed_check` | Run it. Returns only the differences you did not account for, ranked with the ones furthest from your edit at the top. Unchanged paths never reach you; the reply says how many were skipped, and what was never looked at. Takes `surface` and `at` to aim it at a web page, a desktop app, an APK or a simulator build — and refuses by name rather than checking something else. |
| `staysfixed_explain` | One finding, in depth — both values in full, the journey that reached it, the code around it, the evidence. Never pushed into a check reply, so ask for it on the two or three you intend to act on. |
| `staysfixed_prove` | Test a causal claim by undoing a change and running again. If the difference survives the revert, your edit did not cause it and you were about to fix the wrong thing. |
| `staysfixed_waive` | Record that a difference was intended. Not approval, and it makes nothing the new normal — only shipping does that. Four gates, and a refusal is final. |
| `staysfixed_coverage` | What was **not** checked: the doors no journey has ever opened, the surfaces this machine cannot reach, the surfaces this *copy* has no adapter for, anything refused for being irreversible, and what it can never see on any machine. Read it before telling anyone a change is safe. |

**An agent can check; only a person can approve.** `staysfixed_approve` is not
merely refused — it is not on the tool list at all unless the project explicitly
opts in, so the agent never sees a door to push on. An agent that could bless its
own results would edit the code, notice something moved, approve it, and report
success, and your safety net would have become a rubber stamp.

Every tool in that list also carries a short title and the protocol's own flags
for what it does to your machine, so a client can tell a question from an action
without reading this page: `staysfixed_capabilities`, `staysfixed_explain` and
`staysfixed_coverage` are marked read-only, and none of the seven is marked as
reaching the outside world, because none of them does.

`staysfixed mcp` serves the tools above. The version 1 picture tools are still
there behind `staysfixed mcp --v1` for anybody who wired those up, unchanged.

Full wiring for every client: [docs/mcp.md](docs/mcp.md).

### Nothing here should need a human to read documentation

Every version ships knowing, in machine-readable form and in plain English: what
it can check on this machine right now and what it cannot; what is missing that
would unlock more, and whether the tool can install it itself or a person has to;
which other machines your ssh config names, and — for the ones your own settings
name, plus any you ask about with `--machines` — whether they answer, what they
run and what they are short of; and the shape of its own results, so an agent can
act on them without being taught. It does **not** dial your machines unasked: the
first command a stranger runs must not open connections to their production
servers, so naming a machine in your settings is what asks about it. That is `staysfixed doctor --json`, and it is
`staysfixed_capabilities` over MCP.

---

## The nets that are already shipped

### Guards — one check per bug that was already fixed once

```js
// .staysfixed/guards/the-sidebar-still-collapses.js
export default {
  name: 'the sidebar still collapses',
  because: 'A CSS rename broke the toggle handler and it shipped unnoticed for four days.',
  async run(app) {
    await app.open('/');
    await app.click('[data-action="toggle-sidebar"]');
    await app.expect('the sidebar is hidden', async () => !(await app.page.visible('.sidebar')));
  },
};
```

The name is not decoration. It is what prints when the guard fails and what an
agent reads before deciding whether it broke something. So names are enforced:
`sidebar_collapse_test` and `#4412` are refused, with an explanation and, where
one can honestly be built, a rewrite. See [docs/guards.md](docs/guards.md).

Guards are the third net, for the case both engines are blind to: **the old build
was already wrong.** A difference against a guard is sealed — it goes to a person.

### Walk — the last look before a release

```
staysfixed walk --open
```

Opens the real built app, visits each screen, photographs every step onto one
page you can scroll in thirty seconds. Nothing is compared and nothing can fail
on a pixel. This net answers the question a comparison cannot: *does the thing I
am about to ship actually open?*

### Markers — pin a known-good moment

```
staysfixed mark v0.15.0 --note "before the store work"
staysfixed trace billing-empty
```

A marker defines what "old" means. Comparison runs over stored build artifacts,
so tracing a regression to a commit does not need every commit rebuilt.

### Picture checks — version 1, unchanged

```
staysfixed check --pictures
staysfixed approve --all
```

Pixels dropped from the accusation to the evidence, but the version 1 picture
check is still here, still works, and still requires a person to approve. Nobody
who was using it has to stop.

### The freeze layer, which everything rests on

Frozen clock, killed motion, seeded randomness, pinned fonts and text rendering,
blocked or replayed network, and capture-until-two-frames-agree. Paired running
does not make this redundant: paired running removes differences between the two
builds, and this removes the product's own internal nondeterminism, which is what
keeps the measured wobble small enough to be useful. The long version, with what
each trick cannot fix, is in
[docs/how-it-stays-stable.md](docs/how-it-stays-stable.md).

The network interceptor has been promoted from a determinism trick to the
**safety boundary**. It is the answer to "what about a payment": the old build
replays recorded traffic and never reaches the real world.

---

## Settings

**You should not have to write these.** `staysfixed init` reads the repository —
`package.json`, the lockfile, the framework config, the folder shapes, the built
artifacts, an `.app`, an `.xcodeproj`, a `gradlew`, a Dockerfile, the test runner,
and every route, exported name and message channel written in the source — works
out what the repository actually makes, and writes settings with an explanation
beside every option. It never overwrites a file you already have. `staysfixed init
--json` is the same answer as one object, which is what an agent should read.

A repository usually makes more than one thing, and a list of four is normal: one
repository producing a desktop app, an iPhone app, an Android app and a website is
the case this was built against.

What it writes names the product and one block per kind of thing it found —
`process` for commands, `http` for a server, `web` for a website, `electron`,
`android`, `ios`, `windows`. **A product with no screen has no `app` block, and
that is correct**: the picture commands (`status`, `walk`, `approve`, `mark`,
`trace`, `check --pictures`) work by opening something and photographing it, so
they need an `app` and say so plainly if there is not one. `staysfixed check`
needs no `app` at all.

### `process.skip` — what to leave out of the scratch copy

Every run works in a **throwaway copy of your project**, so a build can write
wherever it likes without touching the folder you are working in. That copy is
cloned rather than copied: on a Mac and on most Linux filesystems it is one call
per file that moves no bytes at all and shares the blocks until something writes
to them. Measured on a twelve-gigabyte project, most of it an iOS build folder:
**41.5 seconds and no disk used.** Where the filesystem cannot clone, it falls
back to a real copy — slower, never wrong.

If that copy still takes over twenty seconds the run says so and points you here.
You can name folders to leave behind:

```js
export default {
  product: 'your-app',
  process: {
    // Folders not worth copying into the scratch build.
    skip: ['DerivedData', '.gradle'],
  },
};
```

**The bar for putting something on that list is deliberately high: only things
that are regenerated on demand and read by nothing.** Caches, coverage reports,
scratch output. Anything you skip that turns out to matter makes a run pass for
the wrong reason — and a run that passes for the wrong reason is the single
failure this whole tool exists to prevent. Build output, `node_modules`,
lockfiles, fixtures and configuration are all copied, every time, because a check
that runs against a different set of files than the real product is not checking
the real product. If you are not sure, leave it in and let the run be slower.

`skip` can only ever **add** to what is already left behind — `.git`,
`.staysfixed`, `.turbo`, `.nyc_output`, `coverage`, `.pytest_cache`,
`__pycache__` and `.DS_Store`. There is no way to switch one of those back on,
because doing so would only ever make runs slower.

A `staysfixed.config.json` works too, with a declarative `steps` form and no
functions — so a Rust, Python or Go project can use the tool without anybody
writing JavaScript. It may also live at `.staysfixed/config.js` (or `.mjs`, or
`.json`) if you would rather not have another file in the root.

**Every option, and what each kind of product needs on the machine**, is in
[docs/settings.md](docs/settings.md) — every settings key per block, and for each
surface the exact programs, environment variables, install commands and
permissions, rather than "you may need Xcode".

**Do not copy an example to set the difference engine up.** Run `staysfixed
init`: it reads what is actually in your project and writes a settings file with
every option in it — the ones that do not apply commented out rather than left
out — filled in from your own code. That is better than any example, because it
is about your project rather than somebody else's.

The three fully commented examples in [`examples/`](examples/) — [a web
app](examples/staysfixed.config.web.js), [an Electron
app](examples/staysfixed.config.electron.js) and [a
guard](examples/guards/the-sidebar-still-collapses.js) — are all **version 1's
shape**, for the picture check, which is the half that needs an `app`. Each file
says so at the top now. Copy one into a project and a plain `staysfixed check`
will tell you the settings do not name anything to open, which is correct and
confusing if you were not expecting it.

The design behind all of it is in [docs/how-v2-works.md](docs/how-v2-works.md).

---

## Does it actually work?

A tool that reports "nothing changed" looks exactly like a tool that is broken,
and there is no way to tell the two apart from the outside. So:

**It has to prove it still catches things.** `staysfixed check --selfcheck`
builds twenty tiny products — each a real repository with a working commit and
an uncommitted change on top, which is the shape an agent actually points this
tool at — and requires the engine to behave on every one.

- **Twelve are breaks it must catch**: a route that starts failing, a field
  dropped from a reply, a different exit code, a file that is no longer written, a
  door removed from a desktop app, a total quietly rounded, a break buried in the
  middle of a huge output, a value that used to be steady and is now random, a
  crash that only shows in what the program said, a charge that moved where
  nothing in the address mentions money, a run that could only compare half of
  itself and has to say which half, and a run whose own record could not be saved.
- **Four are the other half of the same promise**: pairs that must produce **no
  findings at all** — two identical builds, a product that wobbles, a build that
  takes ten times longer, and a journey nothing could walk, which has to be named
  as a hole rather than counted as clean. A tool that cries wolf gets switched
  off, and a tool that is switched off catches nothing.
- **One is the third kind**: a product so unsteady that the comparison is thrown
  away before it happens, where the only correct answer is that this run says
  **nothing** — and saying "nothing changed" there is the worst thing the tool can
  do.

**And it has to be honest when it cannot tell.** A case that misbehaves is built
again from scratch and run again before that becomes an accusation. Fail twice
and it is reported as a real failure. Behave the second time and it is reported
as *could not tell* — not a pass, not a failure, exit code 2, with the machine's
load printed beside it. This exists because the corpus once came back "1 of 9
wrong" with a test suite running alongside it and then passed five times in a row
on a quiet machine, and a corpus that can be perturbed by a busy laptop is worth
nothing on a busy laptop. The cause was found and removed — see
[what it will never do](#what-it-will-never-do) — and the re-run stayed, so that
the next machine-shaped thing to creep in lands as "nobody knows" rather than as
a false accusation people learn to ignore. Measured on 2026-08-30: eleven of
eleven, three times running, with the project's own suite running in parallel and
the machine's load average between 227 and 334; then twelve of twelve after the
second sweep of silences, three times running, with the suite in parallel again
and the load average between 208 and 343; and finally **twenty of twenty**,
with the suite in parallel, at the end of the same day.

**The unstable app.** `fixtures/unstable-app` is a page built to be impossible to
observe consistently: a clock ticking ten times a second, an endless spinner, a
tween, a shuffled list, a random uuid, a blinking caret, a late image, and a feed
the server answers differently every time. The suite runs it twenty times and
requires every result to be identical. If that fails, nothing else in the suite
matters.

**A real desktop app.** Pointed at a real Electron application: eleven screens,
two guards, about twenty-five seconds a run, five consecutive runs with nothing
different. Then one line was deleted from the built app — the `<link>` to its
stylesheet. All eleven failed, and so did the guard written for exactly that bug,
whose reason reads: *one release shipped with the whole app unstyled and every one
of its ~3,600 tests passed, because none of them could see it.*

---

## What it will never do

Honestly, so you know before you invest an afternoon.

- **Nothing irreversible, ever.** Anything that spends money, sends a message or
  destroys data is watched at the moment it is **asked for** — the same charge,
  the same amount, the same place — and refused at the effect. If a bug only
  appears after the payment settles or the email lands, this tool is blind to it,
  by design and permanently. A refusal is reported as a gap in coverage, never as
  a pass.
- **A migration that destroys data is refused, not run twice.**
- **It will not tell you your product got slower.** How long something took is
  recorded and shown to you, and it is never compared. A stopwatch on a shared
  machine measures how busy the machine is at least as much as it measures the
  product: measured here, thirty runs of the same one-line program on an idle Mac
  took between 48ms and 96ms, against a bucket boundary at 100ms. Comparing that
  invents a slowdown nobody caused every time the machine is busy, and a tool that
  cries wolf gets switched off. A build that **hangs** is still caught — it gets
  stopped for taking too long, and how it finished is compared exactly.
- **A change buried in the middle of a huge output can be missed.** Anything a
  product prints over 64KB has its two ends kept and compared, plus the exact
  number of bytes thrown away — so a middle that grew or shrank is caught. A
  middle that changed without changing its length is not, the whole text is
  written to the evidence folder either way, and the run says out loud that it
  only compared the ends.
- **A build that will not answer the same way twice gets no verdict at all.**
  Differences at addresses the new build cannot hold steady are dropped — that is
  the whole design, and it has one failure shape. If the second run falls over,
  or the product writes hash-named files, or stamps a fresh id on every line, then
  most of its addresses are unsteady, almost everything is dropped before it is
  compared, and what is left is not an answer. A run in that state now says **NO
  ANSWER FROM THIS RUN**, in those words, and is not a pass. Fix it by writing a
  normalisation rule for whatever is moving, not by trusting the clean-looking run
  underneath it.
- **What normalisation rubbed out is not itemised on every run.** The rules are in
  your repository — one file, `.staysfixed/rules.json`, which you read like any
  other file in a pull request — and the capture is stamped with which set was
  used, so a run comparing against a record tidied by a different set says so.
  There is no command that lists them and no per-run report of what each one
  rewrote. Anything a rule covers is not being watched, and that is the point
  of the rule; just know that adding a broad one is how you go blind on purpose.
- **Ranking reads your source, and it gives up on very large trees.** Distance
  from the code you just changed is what sorts the list, and it reads up to 4,000
  files of up to 400KB each to work it out. Past that a finding is still reported
  and still counted — it just may not sort where it deserves to. Nothing is
  dropped for being far away.
- **A race that already existed will not show.** Subtracting the wobble floor
  actively hides intermittent bugs. Running the new build twice recovers half of
  this by flagging anything newly unstable. Only half. That is the sharpest
  weakness in the whole architecture and it is not going to be dressed up.
- **A waiver is a judgement, and judgements can be wrong.** The gates make an
  agent's claim falsifiable — it has to be written before the damage is visible,
  it has to fall inside what was named, there are five of them, and they all die
  when you ship. What they cannot do is read the agent's mind. The five sealed
  classes are the answer to that: in the places where being wrong is expensive,
  no judgement is accepted from any agent at all.
- **Real phones cannot be paired, and the phone surfaces are the newest thing
  here.** No paired run is possible on a device in your hand: two builds cannot
  exist on one handset at once. Real iPhones and real Android handsets fall back
  to comparing against the stored record, and say so out loud on every run. The
  emulator and the simulator are the honest answer, and both of them compare
  against the stored record too — for Android because two emulator snapshots
  restoring byte-identically is unproven, and for iOS because a paired run costs
  two `xcodebuild` passes and belongs before a release rather than after every
  edit. If you ship a phone app, ask `doctor` what it is actually covering before
  you trust a clean result.
- **It is not every possible state.** "Deep" means every door the code exposes and
  every journey it was given. Nothing can enumerate every state, and any tool
  claiming otherwise is lying. The coverage ledger names the doors it has never
  opened, so the hole is visible instead of pretended away.
- **Your own test suite is walked only when you ask.** `--journeys suite`, or
  `journeys: "suite"` over MCP, runs each test file twice inside the scratch copy
  and reports every check by name, why each failure failed, and a fingerprint of
  the test file itself — so an edited test says plainly that the change is yours.
  It is off by default because running a stranger's whole suite twice on every
  check would make this too slow to leave switched on, and a check nobody can
  afford to run is a check nobody runs. It is held to 90 seconds and **every
  file it did not reach is named**, one by one, never "some tests were skipped".
  It earns the ask: take the penny-rounding out of a `total()` and the product's
  own output does not move by one character — the discovered journeys say nothing
  has changed, and the harvest names the check that turned red.
- **No hosted service, no dashboard, no accounts, no teams, nothing paid.** It is
  a command and a folder of files in your repository.
- **Pictures still do not travel between operating systems.** Text is drawn
  differently on every system. Pixels are evidence now rather than the accusation,
  which makes this matter far less than it did — but it has not gone away.
- **Native Windows shows one desktop, so two builds cannot run at once even in
  principle.** Runs are one after the other and the same-minute guarantee is
  weaker there than on any platform. If your Windows product is Electron — most
  are — it is covered properly instead, over the debug port, from any machine.
  Nothing irreversible can be refused on Windows either: there is no way to block
  a compiled program's network call without administrator rights, so a journey
  marked irreversible is refused outright rather than walked.
- **Not battle-tested.** It works, it is used, and it has not yet met the thousand
  strange apps a widely-used tool meets. If it reports something that is not true,
  that is the most serious kind of bug it can have — please
  [open an issue](https://github.com/asadev/staysfixed/issues).

---

## Licence

MIT. See [LICENSE](LICENSE).

Built by Asad Iqbal.
