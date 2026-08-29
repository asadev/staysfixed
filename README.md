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

You are not in that loop. You hear about it only when a difference lands in a
class no agent may wave through: money, signing in, lost data, a crash, or a bug
you already reported once.

---

## The loop

1. The agent changes some code.
2. It calls `staysfixed_check` over MCP.
3. Everything unchanged is skipped and never reaches its context.
4. What comes back is what changed. It already knows what it intended, so the
   targets are the differences it did **not** intend.
5. It fixes those and runs again.

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

Requirements: **Node 22 or newer**. Everything else depends on what you are
watching, and the tool works out what it has:

```
npx staysfixed doctor
npx staysfixed doctor --json      # the same answer, for an agent
```

`doctor` is the first thing you should run and the first thing an agent should
call. It says what it can check on this machine, what it cannot, what is missing,
and the exact command that would fix each gap — and it never suggests setting up
something that already works, because everything it lists as missing failed a
real check first.

### What a fresh install downloads, and what it does not

`npm install staysfixed` pulls **two small packages and nothing else** —
`pixelmatch` and `pngjs`, under a megabyte together. No browser, no runtime,
nothing that takes minutes.

Checking a **website** needs a browser. Rather than make everybody who only
wanted to check a command-line tool wait for one, that is a separate step you
take when you need it:

```
npm install --save-dev playwright && npx playwright install chromium
```

Measured on a Mac in August 2026, that is about **18MB of packages** in your
project and about **570MB of browser** in a shared cache outside it — 371MB for
Chrome for Testing and 196MB for its headless shell — downloaded once per
machine, not once per project. `doctor` tells you when you need it, and it is one
of the things an agent can simply do without asking you.

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
| Picture checks, guards, walk, markers, flake register, MCP server | **Shipped.** Published as `staysfixed` 0.3.x and in use. |
| `doctor` describing this machine in plain English and as JSON | **Shipped.** |
| The parts of the difference engine — the address space, normalisation, wobble subtraction, clustering, ranking, causal proof, the store, the MCP tools, the self-check corpus | **Written, being wired together.** |
| The engine assembled behind `staysfixed check`, on command-line tools and libraries | **Being built.** This is the next thing to land. |
| Web and Electron through the difference engine | Next. |
| The reference cut automatically when you ship, and the waiver system | After that. |
| Android, then the iOS simulator | After that. |
| Native Windows | Only if somebody ships a native Windows product. |

`staysfixed check` is the front door for both. Version 1's flags still mean
exactly what they meant yesterday — `--pictures`, `--guards`, `--watch` and
`--only` reach the same code they always did. Nobody who installed this last week
has to change anything.

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
| `counters` | Rough counts and rough timings. Deliberately rough — precise timing is noise, not information. |
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

**An agent cannot write a reference.** It can only write a waiver, through four
machine-checked gates: sealed classes are unwaivable; the waiver must agree with
an intent the agent sealed **before** the run, so it has to say what it meant to
change before it sees what broke; five waivers per change and no more; and every
waiver is fingerprinted to one exact difference and expires when the reference
moves.

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
| `staysfixed_check` | Run it. Returns only the differences you did not account for, ranked with the ones furthest from your edit at the top. Unchanged paths never reach you; the reply says how many were skipped. |
| `staysfixed_explain` | One finding, in depth — both values in full, the journey that reached it, the code around it, the evidence. Never pushed into a check reply, so ask for it on the two or three you intend to act on. |
| `staysfixed_prove` | Test a causal claim by undoing a change and running again. If the difference survives the revert, your edit did not cause it and you were about to fix the wrong thing. |
| `staysfixed_waive` | Record that a difference was intended. Not approval, and it makes nothing the new normal — only shipping does that. |
| `staysfixed_coverage` | What was **not** checked. Read it before telling anyone a change is safe. |

**An agent can check; only a person can approve.** `staysfixed_approve` is not
merely refused — it is not on the tool list at all unless the project explicitly
opts in, so the agent never sees a door to push on. An agent that could bless its
own results would edit the code, notice something moved, approve it, and report
success, and your safety net would have become a rubber stamp.

Full wiring for every client: [docs/mcp.md](docs/mcp.md).

### Nothing here should need a human to read documentation

Every version ships knowing, in machine-readable form and in plain English: what
it can check on this machine right now and what it cannot; what is missing that
would unlock more, and whether the tool can install it itself or a person has to;
which other machines it can already reach, **found by dialling them** rather than
by asking you; and the shape of its own results, so an agent can act on them
without being taught. That is `staysfixed doctor --json`, and it is
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

Everything is optional except `app`. A five-line file works, and
`staysfixed init` writes one you can read. A `staysfixed.config.json` works too,
with a declarative `steps` form and no functions — so a Rust, Python or Go
project can use the tool without anybody writing JavaScript.

Two fully commented examples are in [`examples/`](examples/):
[a web app](examples/staysfixed.config.web.js),
[an Electron app](examples/staysfixed.config.electron.js), and
[a guard](examples/guards/the-sidebar-still-collapses.js).

The full reference lives with the code it configures, and the design behind all
of it is in [docs/how-v2-works.md](docs/how-v2-works.md).

---

## Does it actually work?

A tool that reports "nothing changed" looks exactly like a tool that is broken,
and there is no way to tell the two apart from the outside. So:

**It has to prove it still catches things.** `staysfixed check --selfcheck` runs
a corpus of deliberately broken builds and requires the engine to catch every
one. If it misses any, it says so, and until that is fixed a clean check means
nothing.

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
- **A race that already existed will not show.** Subtracting the wobble floor
  actively hides intermittent bugs. Running the new build twice recovers half of
  this by flagging anything newly unstable. Only half. That is the sharpest
  weakness in the whole architecture and it is not going to be dressed up.
- **Real phones cannot be paired.** No paired run is possible on a device in your
  hand. Real iPhones and real Android handsets fall back to comparing against the
  stored record, and say so out loud on every run.
- **Native Windows cannot run two builds at once, even in principle,** because
  Windows shows one desktop at a time.
- **It is not every possible state.** "Deep" means every door the code exposes and
  every journey your suite already walks. Nothing can enumerate every state, and
  any tool claiming otherwise is lying. The coverage ledger names the doors it has
  never opened, so the hole is visible instead of pretended away.
- **No hosted service, no dashboard, no accounts, no teams, nothing paid.** It is
  a command and a folder of files in your repository.
- **Pictures still do not travel between operating systems.** Text is drawn
  differently on every system. Pixels are evidence now rather than the accusation,
  which makes this matter far less than it did — but it has not gone away.
- **Not battle-tested.** It works, it is used, and it has not yet met the thousand
  strange apps a widely-used tool meets. If it reports something that is not true,
  that is the most serious kind of bug it can have — please
  [open an issue](https://github.com/asadev/staysfixed/issues).

---

## Licence

MIT. See [LICENSE](LICENSE).

Built by Asad Iqbal.
