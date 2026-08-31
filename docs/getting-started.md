# Installing Stays Fixed — for the agent doing it

You have been asked to add Stays Fixed to somebody's project. This page is written for you,
not for them. Follow it top to bottom and you will not need to read anything else, and you
will not need to ask them anything you could have found out yourself.

**The one rule.** Never make a person do what the machine can do. You install everything
installable, you work out everything readable, and you hand them only the steps that need a
licence, a device, a password, a real customer record or a pair of hands. Every one of those
comes back to you already written in plain words — say it to them the way it is written.

---

## What this tool is, in four sentences

It proves nothing that already worked has broken. It runs their product through the same
steps twice, compares that against the build they were last happy with, subtracts whatever
their product disagrees with itself about, and reports only what is left. Nothing that stayed
the same is ever mentioned — which is what keeps the answer short enough for you to read every
word of it. Nobody approves pictures: the build they say `staysfixed ship` about IS the
definition of working.

---

## The install, in order

### 1. Ask the machine what it can do

```
staysfixed doctor --json
```

This is the first call. It comes back as one object saying what can be checked on this
machine right now, what is missing, and — the field that matters — **who has to fix each
missing thing**. Nothing in `needs` got there without failing a real probe first, so you never
have to check whether something is "really" missing.

Read `surfaces[].state`. It is one of four values and they mean exactly what they say:

| `state` | What you do |
|---|---|
| `ready` | Nothing. Do not mention it. |
| `the agent can fix this` | Run the commands in `needs[].fix`. Do not mention it. |
| `only a person can do this` | Tell them, using the words in `needs[].what/why/fix`. |
| `not possible here` | Do not offer it again. `instead` holds the nearest honest alternative — say that. |

Also read `covers.short`. It is one paragraph saying what a clean run on this machine would
and would not mean, written to be repeated to a person word for word. If you only quote one
thing from `doctor`, quote that.

### 2. Set it up for the project

```
staysfixed init --json
```

This reads the repository — package.json, the lockfile, the framework config, the folder
shapes, built artifacts, an `.app`, an `.xcodeproj`, a `gradlew`, a Dockerfile, the test
runner, and every route, exported name and private channel written in the source — and works
out what the repository actually makes. Then it writes a settings file with an explanation
beside every option.

**A repository usually makes more than one thing.** `plan.project.products` is a list, and a
list of four is normal: one repository producing a desktop app, an iPhone app, an Android app
and a website is the case this was built against. Do not treat the first entry as the answer.

What comes back:

- `plan.project` — what it is, with `evidence` naming the actual file behind every claim, and
  `confidence` on every product. Anything below `0.5` is a guess and says so. If it is wrong,
  the evidence tells you why in one line and you fix it in the settings.
- `plan.readiness[]` — the same four states as above, but per **product** rather than per
  platform.
- `plan.needs.agent` — clear this list yourself. Do not mention any of it.
- `plan.needs.person` — this is the ONLY thing you say out loud. Each item has `what`, `why`,
  `unlocks` and `fix`, already written for somebody who is not a programmer.
- `plan.needs.impossible` — nothing to do. `fix` holds the honest alternative.
- `plan.journeys[]` — everything it can already walk, and where each came from.
- `plan.config` — where the settings go and their whole text. **If `config.exists` is true it
  wrote nothing**, because it never overwrites somebody's file. The text is still there: read
  their file, and merge across only what is missing.
- `plan.covers.short` — the paragraph to repeat.

`init` writes at most two files: the settings, and three lines appended to `.gitignore`. Add
`--dry-run` to work everything out and write nothing.

**Where the steps come from, today.** Each adapter reads their source and offers what it
finds there — routes, commands, screens, message channels — and `--journeys <file>` names
steps by hand. `--journeys suite` adds their own test suite: each test file runs twice inside
the scratch copy, every check is reported by name, and it stops after 90 seconds naming every
file it did not reach. Replaying a recorded session is written in `src/v2/journeys/` and is
**not wired into a run**: ask for `--journeys recorded` and you are told so by name. Nothing
quietly substitutes different steps and hands you a clean answer about them.

### 3. Take the first reading

```
staysfixed check --paired
```

`--paired` boots the old build live rather than trusting a stored record. It is slower and it
is the strongest answer there is. Use it the first time and whenever the run says the stored
record is thin.

On a project that has never shipped with this installed there is nothing on record as working
yet, so this first run **proves nothing** and says so in those words. That is not a failure;
it is the cold start, and it is over as soon as they ship once.

### 4. Wire it into their agent

`plan.wiring.mcp` is the MCP block, with the project path already filled in. Paste it into
their agent's MCP settings. It runs `staysfixed mcp`, which serves the seven difference-engine
tools — capabilities, intent, check, explain, prove, waive, coverage. (`staysfixed mcp --v1`
serves the older picture-checking tools instead, for anybody who wired those up before.) From then on the loop is: you call `staysfixed_check`, you get
back only the differences, you already know what you meant to change, so the ones you did NOT
intend are your work queue. You fix those and run again. The person is not in that loop at
all.

### 5. Put one line in their release script

```
staysfixed ship
```

At the very end, after the thing has actually gone out. That build becomes what "working"
means from then on. This is the whole approval mechanism, and it is why they never open the
tool. It never fails a release: if it cannot work something out it says so and exits 0.

---

## Reading a check

Every check answers with one object. The fields that decide what you do:

- **`ok`** — true when nothing unintended survived. False when something did, **or** when
  something that used to give the same answer every time stopped doing so.
- **`blocked`** — the run could not happen. This is neither a pass nor a failure. Never
  report a blocked run as "nothing changed".
- **`reference.id`** — check this before you believe `ok`. An **empty string** means there was
  nothing on record to compare this build against, so the run proved nothing at all. It comes
  back with `ok: true`, because arithmetically nothing came back different — and it is not a
  pass. It happens on every project until somebody has run `staysfixed ship` once. The command
  line exits 2 on it; the JSON does not say so in a field yet, so read this one.
- **`mode`** — `paired` means the old build was booted and walked here, in this minute.
  `stored-record` means it was compared against what the old build wrote down last time,
  which is genuinely weaker. When it is `stored-record`, `modeWarning` holds the sentence to
  repeat.
- **`findings[]`** — ranked, worst first. This is the only part you need to read. Each one is
  a cluster of differences that share a cause, not a single address: one missing stylesheet is
  one finding, not four hundred differences.
- **`findings[].sealed`** — true means no agent may wave it through, whatever you believe you
  meant to change. Money, sign-in, data loss, a crash, or a bug already reported once. It goes
  to a person. Do not argue with it, do not work around it.
- **`newlyUnstable`** — addresses that were steady before the change and disagree with
  themselves now. Treat these as findings even though no value "changed": the edit made
  something unpredictable.
- **`coverage.gaps[]`** — everything that was NOT looked at, each with what would unlock it.
  An unopened door is visible here rather than silently passing. Read this before telling
  anybody a run was clean.
- **`summary`** — one paragraph covering all of the above, safe to quote word for word.

### The three tools that go with it

- `staysfixed_intent` — say what you meant to change **before** you run the check. Sealing it
  first is what makes the claim falsifiable rather than a story told afterwards.
- `staysfixed_prove` — proves a finding was caused by your edit, by undoing that edit and
  re-running. A proof, not a guess. If the difference survives the revert, you were wrong.
- `staysfixed_waive` — mark a difference as intended. Four gates: sealed classes are refused,
  it has to match the intent you sealed first, there is a budget of five per change, and every
  waiver expires when the reference moves. You can never write a reference. Only shipping does
  that.

---

## What to say to the person, and when

**Say nothing** about anything in `needs.agent`, anything `ready`, or any step you completed
yourself. A set-up that mentions work you already did reads as work they have to check.

**Say this, once, when everything is in place** — build it out of `plan.covers.short`:

> Stays Fixed is set up. It will now check *&lt;the things covered&gt;* every time I change
> anything, and tell me the moment something that used to work stops working. It is not
> checking *&lt;the things not covered&gt;* — *&lt;the reason&gt;*. You do not have to approve
> anything: when you release, one line in the release script records that build as what
> "working" means.

**Say this when something genuinely needs them** — one item per line, their words already
written for you in `needs.person`:

> One thing needs you: *&lt;what&gt;*. *&lt;why&gt;* It unlocks *&lt;unlocks&gt;*. To do it:
> *&lt;fix&gt;*.

The usual four, and they are usual because a machine genuinely cannot do them:

1. **A real value for a changing part of an address** — an id or a slug that exists in their
   data. Nobody but them knows one.
2. **A way to put the data back** — a database dump or reset command. Both builds have to see
   the same rows or every difference is really a data difference.
3. **Confirming which routes must never really run** — the tool guesses from names like
   `/charge` and puts them in the settings; only they know if the guess is right.
4. **Xcode, a device, an account, a licence** — a download with an agreement on it, or a thing
   with a cable.

**Never say** "install Tailscale", "give me SSH access" or anything else the tool did not put
in `needs.person`. If a host is already reachable, `doctor` found it and it is not a step.

---

## How to know it is working

Four checks, in order, and they take about a minute:

1. `staysfixed doctor --json` returns an object with at least one surface not `unavailable`.
2. `staysfixed init --json` returns `ok: true`, and `plan.readiness` has at least one product
   whose state is `ready`.
3. `staysfixed check --paired` finishes with `blocked` absent and `coverage.paths` above zero.
   Zero addresses observed means it walked nothing, whatever else it says. On a project that
   has never shipped, `reference.id` will be empty and that run proves nothing — expected, and
   over as soon as they ship once.
4. Break something on purpose — change a line of printed text, delete a route — run
   `staysfixed check`, and confirm it names it. Then put it back.

Step 4 is the one that matters. A tool that reports "nothing changed" is indistinguishable
from a tool that is broken, and the only way to tell them apart is to break something and
watch it notice. There is a built-in version of the same idea:

```
staysfixed check --selfcheck
```

which builds twenty deliberately broken products and proves the engine still behaves on
every one — twelve breaks it must catch, four clean pairs it must stay silent about, and one
product so unsteady that the only correct answer is that the run says nothing at all. A case that
misbehaves is built again and run again before that counts: fail twice and it is a real
failure; behave the second time and it comes back as **could not tell**, which is exit code 2
and is not a pass. That exists because a corpus that can be perturbed by a busy machine is
worth nothing on a busy machine.

---

## When it says it cannot

Every one of these is a designed answer, not a fault. Repeat the reason; do not work around it.

- **"There is nothing on record as working yet."** The cold start. One `staysfixed ship` ends
  it forever. Until then the run proves nothing and must not be reported as clean.
- **"This was not a full paired run."** It compared against a stored record. Weaker, and it
  says so every single time by design. `--paired` is the fix.
- **"Nothing here knows how to drive a &lt;platform&gt; journey yet."** Missing coverage, and it
  is counted as missing rather than passed.
- **A refused effect.** Anything irreversible is watched at the moment it is asked for and
  never allowed to happen, and a migration that destroys data is not run at all. Both are
  reported as gaps in coverage. Neither is ever a pass.
- **`blocked: true`.** No answer. Not a pass, not a failure. Say "the check could not run"
  and why.

---

## Five things this tool will never see

Say these once, when someone asks how much it covers. They are permanent, they are in
`doctor`'s `limits`, and pretending otherwise is worse than the gap itself.

1. **Anything after the call boundary.** It watches the same charge being requested for the
   same amount, and stops it. A bug that only appears once the payment settles or the email
   lands is invisible to it, by design and for good.
2. **Intermittent bugs that already existed.** Subtracting a product's own wobble hides them.
   Running the new build twice recovers half of this by flagging anything *newly* unstable —
   only half. This is the sharpest weakness in the whole design.
3. **States no journey reaches.** It checks the journeys it has, and `coverage.gaps` names the
   doors it has never opened. It cannot enumerate every possible state, and anything claiming
   to is lying.
4. **Whether your product got slower.** How long something took is recorded, printed in the
   sentence beside it, and never compared. A stopwatch on a shared machine measures how busy
   the machine is at least as much as it measures the product — thirty runs of the same
   one-line program on an idle Mac spread from 48ms to 96ms against a bucket at 100ms — so
   comparing it invents a slowdown every time the machine is busy. A build that *hangs* is
   still caught: it is stopped for taking too long, and how it finished is compared.
5. **A change buried in the middle of an output over 64KB.** The two ends are kept and
   compared, along with the exact number of bytes discarded, so a middle that grew or shrank
   shows up. One that changed without changing length does not. The whole text is written to
   the evidence folder, and the run says it only compared the ends.

---

## The commands, in one place

| Command | What it is for |
|---|---|
| `staysfixed doctor --json` | What this machine can drive, and who fixes what. Call it first. |
| `staysfixed init --json` | Read the project, write the settings, list what is left. |
| `staysfixed init --dry-run` | The same answer, writing nothing. |
| `staysfixed check --paired` | The strongest run. Boots the old build live. |
| `staysfixed check --json` | The everyday run. Only what changed comes back. |
| `staysfixed check --journeys <file>` | Walk exactly the steps a journeys file names. |
| `staysfixed check --against <ref>` | Compare against a tag, commit or marker. |
| `staysfixed check --selfcheck` | Prove the engine still catches deliberate breakage. |
| `staysfixed ship` | The build that went out is now what "working" means. |
| `staysfixed coverage` | What the last check did NOT look at. Read it before calling anything safe. |
| `staysfixed intent "<what you meant to change>"` | Seal what you meant to change, before you check. |
| `staysfixed explain <id>` | One finding from the last check, in full. |
| `staysfixed prove <id>` | Undo your own edit and re-measure, to see whether it really caused the finding. |
| `staysfixed waive <id> --why "<reason>"` | Record that a difference was intended. It is not approval. |

Those last five existed only over MCP until 2026-08-31, which meant a person at a terminal
got a strictly worse answer about their own product than an agent did. Every one of them is
now a command as well, and both roads reach the same code. `check` prints the finding ids, so
there is something to hand them.

If you have to write a settings block by hand — something `init` could not know, a second
product, a journey through a screen — every option is in
[settings.md](settings.md), together with what each kind of product needs installed on the
machine and the exact command that installs it.

And the three files, if you ever need to look: `src/v2/detect.js` works out what the project
is, `src/v2/doctor.js` works out what the machine can do, `src/v2/init.js` turns both into
settings and a list of what is left.
