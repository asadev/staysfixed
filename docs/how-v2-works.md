# How version 2 works

*The difference engine. What it does, in the order it does it, and the exact
shapes the pieces hand each other.*

Version 1 photographed screens and compared pixels. That answers one question —
*does it still look the same* — and it asks a person to approve every answer.
Version 2 asks a bigger one: **has anything that already worked changed?** It
answers it without a person, and it reports only the differences nobody asked
for.

---

## The loop

The agent is the user. It goes like this, and the owner of the product is not in
it:

1. The agent changes some code.
2. The agent calls `staysfixed_check` over MCP.
3. Everything unchanged is skipped and never reaches the agent at all.
4. What comes back is what changed. The agent already knows what it *meant* to
   change, so the targets are the differences it did **not** intend.
5. It fixes those and runs again.

The only things that reach a person are the ones no agent may wave through:
money, signing in, lost data, a crash, or a bug that was already reported once.

---

## The three ideas it rests on

### 1. Measure the wobble. Never guess a tolerance.

Every product disagrees with itself a little between runs — a timestamp, an
animation frame, an id. So the tool runs the **new build twice**. Anything that
differs between two runs of the same build was not caused by your change: it is
the product's own wobble, and it is subtracted arithmetically.

There are no tolerance settings in version 2. Version 1's `tolerance` block is
gone. Tolerance knobs are how tools like this die — too loose to catch the real
thing, too tight to leave switched on.

It also catches something no screenshot tool has ever caught. A path that was
**steady** in the reference and **wobbles** now is itself a finding: the change
made something unpredictable. That is `newlyUnstable`, and it is reported even
though no value technically "changed".

### 2. Cheap suspicion, expensive proof.

Comparing against the stored record is fast and needs no rebuild, so that runs
first. Every path that then looks different gets the old build **booted live, on
this machine, in the same minute**, and walked again. Only differences that
survive that live re-run are reported.

`--paired` skips straight to the expensive half: old build live from the start.
That is for pre-release, and for the first run on a product with no stored
record.

### 3. Sequential, never simultaneous.

Two builds at the same instant fight over ports, single-instance locks, user data
directories, databases and relay slots. The value was never in the same *second*
— it is in the same machine, the same fonts, the same operating system, the same
data, minutes apart. Runs are sequential with a full state reset between them,
interleaved journey by journey so drift cannot accumulate.

---

## The seven channels

Everything observed is flattened to one shape: **a path, a channel, and a
value**. One comparison engine then serves every platform.

| Channel | What it holds |
| --- | --- |
| `meaning` | What the interface says a control is and does — its role, its name, whether it is on, off or disabled. Not the underlying markup, because markup changes when nothing did. |
| `effects` | What the product sent out into the world: calls made, files written, processes started, things saved. |
| `complaints` | What the product complained about: console messages, errors, crashes, the code it exited with. |
| `results` | What the product gave back: what it printed, what it answered, what it offers other code. |
| `contract` | The doors the source code says exist: routes, exported functions, message channels. Read without running anything. Free, and exact. |
| `counters` | Rough counts — files written, calls made, doors answered, names exported. Compared exactly. |
| `pixels` | What it looked like. Used to show a person a problem another channel already found. |

### The address space

A **path** is segments joined with dots, read left to right from the widest
thing to the narrowest: surface, then place, then thing, then the property of
it. The first segment names the surface, so paths from a phone and paths from a
terminal sit in one list without colliding.

```
api.GET./users.status
cli.build.exit
ipc.session:create.registered
screen.home.tree.button:Save.enabled
```

**How long something took is deliberately NOT in this address space.** It is
recorded, it is printed in the sentence a person reads beside the address, and it
is never differenced. A stopwatch on a shared machine measures how busy the
machine is at least as much as it measures the product — measured here, thirty
runs of the same one-line program on an idle Mac spread from 48ms to 96ms against
a bucket boundary at 100ms, so any load at all crossed it and invented a
difference nobody caused. Every duration goes out through `howLongItTook()` in
`src/v2/adapters/contract.js`, carries a fixed value on every run, and counts as
missing coverage rather than as a pass. A build that *hangs* is still caught: it
is stopped for taking too long, and how it finished is compared exactly.

A dot inside one segment is written `%2E` and a literal percent `%25` — use
`joinPath()` and you never have to think about it. Escaping rather than
stripping matters: `v1.2` and `v12` are different names, and a stripping scheme
would quietly merge two different buttons into one address.

The full grammar is `PATH_RULES` in `src/v2/observation.js`, and it is printed to
whoever is wiring the tool up rather than left in a document.

## Where the steps come from

Ranked, because this is the real workload question:

1. **Read the code.** Free and exact. Routes, exports, IPC channels.
2. **Run the project's own test suite under instrumentation.** Most projects
   already have hundreds of journeys sitting there, walked for a different reason.
3. **Recorded real sessions.**
4. **The agent exploring one named gap** and freezing it into a replayable file.
5. Never a person clicking through an app.

`--journeys <source>` picks between them — and **one of those five is written and
not wired.** A run walks (1) by default: each adapter reads your source and offers
what it finds there. `--journeys <file>` names steps by hand, and `--journeys
suite` adds (2), the project's own test suite — each file run twice inside the
scratch copy, every check reported by name, held to a 90-second budget with every
file it did not reach named. Session replay lives in `src/v2/journeys/` with tests
around it and nothing on the check path calls it; ask for `--journeys recorded` and
you are told that by name rather than handed a clean result about steps something
else chose. Saying so is the point: a feature that exists in the repository and not
in the run is not a feature you have.

---

## Four layers of noise control

Before anything reaches the agent:

1. **Normalise** volatile shapes by rules kept in git, so a version bump in a
   footer reports zero differences instead of five hundred.
2. **Cluster** by signature, so one cause is one finding.
3. **Rank by distance from the changed code.** A difference *far* from your edit
   sorts to the **top** — that is the definition of a side effect.
4. **Prove causation** by reverting the suspect hunk and running again. That is a
   proof, not a heuristic, and it is cheap.

### What normalising deliberately hides

Every normalisation rule is a trade. It buys quiet by making some real
differences invisible, and pretending otherwise would be dishonest. So the rules
are **data**, not code: they live in git next to the project's settings, they get
reviewed like any other change, and every one of them carries a **`wouldHide`**
field written in plain English — the real change this rule would wrongly cover
up. Read that field before switching a rule on.

The rule that quietens a wobbling clock also hides a genuinely wrong date. The
rule that quietens a build time also hides a real ten-times slowdown. The rule
that strips terminal colour also hides green success turning red. None of that is
a bug; all of it has to be written down.

Two things keep it honest:

- **`explain()` returns exactly what was replaced, where, by which rule, and what
  that rule admits it might be hiding.** A difference the tool decided not to show
  has to be answerable for.
- **The test suite asserts each blind spot exists.** `test/v2/normalise.test.js`
  fails if a rule ships without a `wouldHide`, and fails again if a recorded blind
  spot silently stops being one — because that means the trade changed and nobody
  wrote it down again.

## Where the approval line sits

The word "approve" was hiding four different decisions.

1. **What counts as working** — the owner, and only the owner. But never by
   opening this tool. The reference is cut by an act already performed: saying
   ship. Approval happens in bulk, retrospectively, by shipping.
2. **Is this difference real or is it noise** — the machine, arithmetically, from
   running the new build twice. No judgement, nobody's opinion.
3. **Did my own edit cause this** — the agent. That is a *causal* claim, which is
   checkable: revert the suspect hunk, run again, and if the difference survives
   the revert the agent was wrong and it escalates.
4. **Is an unintended difference acceptable anyway** — the owner. This is the
   only thing that reaches a person, and it should be a handful of items a month.

**An agent cannot write a reference.** It can only write a waiver, through four
machine-checked gates: sealed classes are unwaivable; the waiver must agree with
an intent the agent sealed **before** the run, so it has to say what it meant to
change before it sees what broke; five waivers per change and no more; and every
waiver is fingerprinted to one exact difference and expires when the reference
moves.

---

## The shapes

These are the seams between the modules. The authoritative versions are the
JSDoc typedefs in `src/v2/types.js` and `src/v2/run.js`; this is the short read.

### An observation

One fact seen during a run.

```js
{ path: 'screen.settings.tree.button:Save.enabled', channel: 'meaning', value: true }
```

Values are JSON-safe: strings, numbers, booleans, null, and arrays or plain
objects of those. `makeObservation()` refuses anything else, and it refuses a
path that breaks the grammar, so a bad address can never reach the store.

### A capture

One journey, walked once, against one build.

```js
{
  id: '20260829-013245-a-3f9c1a',
  journey: 'the shop opens',
  build: { /* fingerprint */ },
  run: 'a',                    // 'a' and 'b' are the two runs of the same build
  startedAt: '2026-08-29T01:32:45.000Z',
  durationMs: 4120,
  observations: [ /* … */ ],
  coverage: { /* what it did NOT manage to look at */ },
  complete: true,              // false when the file was read back torn
}
```

### A difference

```js
{
  path: 'cli.build.exit',
  channel: 'results',
  kind: 'changed',             // 'changed' | 'appeared' | 'vanished'
  reference: 0,
  candidate: 1,
  journey: 'the shop opens',
  distance: 1,                 // how far apart the two values are, not how far from your edit
}
```

`vanished` is the one no screenshot comparison has ever noticed: a door that
closed.

### Wobble

What one build disagrees with itself about, measured by running it twice.

```js
{
  buildId: 'abc1234',
  journey: 'the shop opens',
  runs: ['…-a-…', '…-b-…'],
  entries: [ /* WobbleEntry per unsteady path */ ],
  unstable: ['counters.boot.ms'],
  steady: 417,
  measured: true,              // false when the build was only run once — and it says so
}
```

`subtractWobble(differences, wobble, { referenceWobble })` returns
`{ real, noise, newlyUnstable, couldTellNewlyUnstable, couldNotTell, note }`. The
rule is set subtraction and nothing cleverer: if a path will not sit still between
two runs of the same build, a difference at that path proves nothing, whatever its
size. Any "but it changed by MORE than the wobble did" rule is a tolerance wearing
a disguise.

`couldNotTell` is the guard on the one way that rule can go catastrophically
wrong. If the second run of the new build falls over half way, or the product
writes hash-named files, or stamps a fresh id on every line it prints, then most
of its addresses are unsteady, nearly every difference is dropped as noise, and
what is left is not an answer — but it reads exactly like a clean run. So
`wobbleStorm(wobble)` looks at the share: a build that disagrees with itself about
more than half of its own addresses did not wobble, something went wrong with the
run. The verdict is then **not** ok, the summary opens with `NO ANSWER FROM THIS
RUN`, and the reason is in the coverage as a hole. This is not a tolerance — no
number here decides whether any single difference is real. It decides one thing:
whether this run has earned the right to use the word clean.

### A finding

A cluster of differences that share a cause, which is what the agent reads:

```js
{
  id: 'f3a91c',                // stable while the cause persists, so a waiver can pin to it
  signature: 'meaning:changed:button-name',
  channel: 'meaning',
  kind: 'changed',
  what: 'Every Save button is now called Store.',
  count: 37,
  journeys: ['the shop opens'],
  paths: [ /* a handful, for orientation */ ],
  examples: [ /* Difference */ ],
  where: 'src/ui/Button.jsx',
  provenAgainst: 'the old build, run live',
  distance: 6,                 // steps through imports from the nearest file you changed
  sealed: null,                // or one of the five classes
  waivable: true,
  why: 'Why it sorted where it did, in plain English.',
}
```

### A verdict

What `staysfixed check --json` prints and what the MCP tool returns:

```js
{
  ok: false,
  compared: true,              // false when there was nothing to compare against yet
  headline: 'Three things changed that nobody asked for.',
  findings: [ /* most suspicious first */ ],
  reference: { kind: 'marker', label: 'v0.13.0', bootable: true },
  provenAgainst: 'the old build, run live',
  notes: [ /* warnings a reader must not miss */ ],
  missingCoverage: [ /* what was refused rather than run twice */ ],
  counts: { unchanged: 4118, wobble: 412, differences: 44, droppedAtProof: 39, findings: 3 },
  journeys: ['the shop opens'],
  youChanged: ['src/ui/Settings.jsx'],
  tookMs: { total: 41200, firstPass: 12000, secondPass: 11800, proof: 17400 },
  at: '2026-08-29T01:32:45.000Z',
}
```

`compared: false` is not a pass. A run with nothing to compare against has
proved nothing, and the command line exits with an error rather than letting a
release through on the strength of it.

### The modules

| Module | What it holds |
| --- | --- |
| `src/v2/types.js` | Every shape, as JSDoc typedefs. Nothing else. |
| `src/v2/observation.js` | The address space, the channels, `diffCaptures`, `measureWobble`, `subtractWobble`. |
| `src/v2/normalise.js` | The rules, as data, each carrying `wouldHide` in plain English, and `explain()` so a normalisation can be answered for. |
| `src/v2/cluster.js` | Many differences, one cause, one finding. |
| `src/v2/rank.js` | `rankFindings` — furthest from the edit first, sealed classes above everything — plus `classOf`, `whatChanged`, `importGraph`. Which classes are sealed, and the words used to refuse one, live in `src/v2/sealed.js`. |
| `src/v2/cause.js` | `proveCause` — revert the suspect hunk, run again, and find out. |
| `src/v2/store.js` | The append-only capture files, build records, references, and reading a torn file without losing the rest. |
| `src/v2/run.js` | `runCheck` — the loop, over any `CheckEngine`. |
| `src/v2/check.js` | `check` — the assembled front door. The command line, the MCP server and the self-check corpus all look for it here, on purpose: if they found the engine in different places they would be checking different things and reporting it as one. |
| `src/v2/selfcheck.js` | The corpus of deliberately broken builds — `CASES` — and `selfcheck`. |
| `src/v2/adapters/` | One per surface. The only place that knows what a browser or a child process is. |
| `src/v2/mcp/` | The tools an agent calls. |
| `src/v2/cli.js` | `V2_COMMANDS`, `run`, `doctorRun`, `checkOptions`, `report`. |
| `src/v2/doctor.js` | `capabilities()`, `describeCapabilities()`, `CHANNELS`, `onPath`, `reachableHosts`. |

## The tool describes itself

Nothing about wiring this up should require a human to read documentation —
including this page. `staysfixed doctor --json`, and `staysfixed_capabilities`
over MCP, return the same object, and it is the first call an agent should make.
It carries:

- what it can check on this machine right now, per kind of product, and which of
  the seven channels are reachable for each
- what is missing, why it matters, and the exact command that would fix it —
  marked with whether the tool can do it itself or a person has to
- which other machines it can already reach, **detected by dialling them**, so a
  working SSH host is never presented as something to go and set up
- the shape of its own results, so an agent can act on them without being taught
- what it will never be able to see, on any machine

---

## Honest limits

- **Anything irreversible is watched at the moment it is asked for** — the same
  charge, the same amount, the same place — and never allowed to happen. If a bug
  only appears after the payment settles or the email lands, this tool is blind
  to it, by design and permanently.
- **A migration that destroys data is refused, not run twice.** The refusal is
  reported as missing coverage, never as a pass.
- **A run whose wobble swallowed the comparison has no verdict.** It says so in
  those words rather than passing. See `couldNotTell` above.
- **Two facts at one address lose one of them.** Every index keeps the first, so
  an adapter that gives one name to two things makes the second invisible. Each
  walk is checked and each clash is named in the coverage — but the check finds
  it, it does not fix it. The adapter has to give the two things two names.
- **Subtracting the wobble hides intermittent bugs.** A race that already existed
  and got worse will not show. Running the new build twice recovers half of this
  by flagging anything newly unstable. Only half. This is the sharpest weakness
  in the architecture.
- **"Deep" means every door the code exposes and every journey it was given.** Not every possible state — nothing can enumerate that, and any tool
  claiming otherwise is lying. The coverage ledger names the doors it never
  opened, so the hole is visible instead of pretended away.
- **Real phones cannot be paired.** No paired run is possible on a device in your
  hand; those fall back to the stored record and say so.
- **Native Windows cannot run two builds at once, even in principle,** because
  Windows shows one desktop at a time.
- **If the old build no longer compiles**, comparison falls back to the stored
  record. That reintroduces every cross-day difference the paired design exists
  to remove, and it announces itself in those words on every run rather than
  degrading quietly.
