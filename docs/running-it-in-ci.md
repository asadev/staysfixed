# Running it where merges happen

*A check that only runs on the author's laptop catches what the author was already looking
for. The same check on every pull request catches what nobody was looking for — which is
the whole class of thing this tool exists to find.*

---

## What it does

On every pull request it runs your product twice, boots the commit your branch **forked
from** on the same machine, walks that too, and reports only what behaves differently. If
something changed that nobody accounted for, the job fails and the pull request cannot be
merged on a green tick that was never earned.

Three files make that work:

| | |
| --- | --- |
| `.github/workflows/staysfixed.yml` | The job. It is printed in full at the bottom of this page, because it is not in the npm package. |
| `src/v2/ci.js` | Works out what to compare against, runs the check, writes the report, exits with the code that decides the job. |
| This file | What it can and cannot do up there, and why. |

---

## A build server is a *better* machine for this, not a worse one

Everything Stays Fixed concludes rests on one claim: **the difference was caused by the
change and nothing else.** That claim is only as good as the machine underneath it.

A laptop has your fonts, your other work, your ports in use, your half-finished experiment
from yesterday afternoon, and a browser that updated itself last Tuesday. A fresh runner has
the same fonts every time, the same operating system, nothing else competing for memory, and
no history. For a difference machine that is worth a great deal.

The tool's own rule — **sequential, never simultaneous** — is easier to keep here too. The
workflow cancels a superseded run of the same branch rather than letting two builds fight
over one port.

---

## The one line you must not delete

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
```

`actions/checkout` fetches **one commit** by default. Ask a repository with one commit in it
what your branch forked from and it says: this commit. So the check would compare your build
against *itself*, find nothing, and go green — the strongest-looking pass the tool can print,
meaning absolutely nothing.

Stays Fixed catches that case by name and refuses it, so it fails honestly rather than
passing dishonestly. But a refusal is not a check. Full history is what makes this work, it
costs a few seconds, and it is the single most important line in the workflow.

On GitLab the same thing is `GIT_DEPTH: 0`.

---

## How the reference is chosen

There is no stored record on a fresh runner — no folder from yesterday, nothing from the last
time anybody ran anything. So the reference has to be rebuilt out of what a build server does
have, which is git. That turns out to be enough, because a check can be aimed at a commit and
`git archive` puts that commit back on the machine without touching your working tree or
your `.git`.

`referenceForCI()` works down this list and stops at the first one available. **It always says
which rung it landed on, in the job summary, because they are not equally strong.**

| Mode | How it is found | Worth | When it applies |
| --- | --- | --- | --- |
| **named** | Somebody passed `--against v1.2.0` | strong | Whenever you say so |
| **merge-base** | `git merge-base` between the base branch and yours | strong | Pull requests. The right answer, and the default |
| **released** | The commit your project's own reference points at — what somebody said *ship* to | strong | Pushes to a main branch |
| **last-tag** | The most recent tag in this history | fair | No pull request, no reference recorded |
| **previous-commit** | What the branch was immediately before this push | fair | Nothing else available |
| **stored-record** | Observations committed in `.staysfixed`, or restored from a cache | weak | No commit could be booted at all |
| **none** | Nothing | nothing | Reported as a failure, never as a pass |

**Why merge-base is the right one for a pull request.** It compares what *your branch* did.
Comparing against the last release instead would drag in everything else that landed on the
base branch while your pull request was open, and hand you a list of differences your branch
is not responsible for.

Every mode that names a commit runs **paired**: the old build is put back on the runner and
walked live, minutes after the new one, on the same machine. That is the strongest answer the
tool has, and CI is the one place where paying for it costs nobody any waiting.

Any candidate that turns out to be the commit under test is thrown away, whichever rung it
came from. Comparing something against itself proves nothing and reads like a perfect pass.

---

## What comes out

The job summary carries a plain-English table, then what changed, then what it did **not**
look at — that last part on a clean run as well as a dirty one, because a gap only mentioned
when something fails is a gap nobody ever sees.

The exit code decides the job:

| Code | Means |
| --- | --- |
| **0** | Nothing that already worked has changed. |
| **1** | Something changed that nobody accounted for. |
| **2** | The check could not run, or there was nothing to compare against. |

**Two is not a pass.** A run that proved nothing exiting zero is the exact failure this whole
tool exists to prevent, and it would be an easy and invisible one to ship. So the workflow has
no `continue-on-error` on the check step, and it should stay that way.

---

## What it cannot do up there, and why

**It never approves anything.** A build server cannot say what "working" means — only a
person shipping can. CI reports; it does not bless. Nothing in `ci.js` cuts a reference,
writes a waiver, or records a build in a way that would let one be cut later, and nothing in
it ever should.

**It never writes your project's record.** Observations from a pull request job were taken on
a machine nobody will see again, off a branch nobody has merged. Letting them become "what
the old build did" would move the standard sideways every time a runner changed. So the check
runs with remembering switched off, and the report says so at the bottom.

**Pictures are tied to the machine that took them.** This is the honest caveat and it is
worth reading twice. Version 2 puts pixels last on purpose — they are evidence for a finding
another channel already made, never the accusation. That design decision is what lets this
run in CI at all. A picture taken on your Mac and a picture taken on an Ubuntu runner differ
in font rasterisation, in sub-pixel antialiasing, in emoji, in scrollbar width, and in a
dozen other ways that have nothing whatever to do with your code. Compare those two directly
and every screen is "different", every run is red, and within a week somebody switches the
whole thing off.

Two things keep that from happening here. Both builds are walked **on the same runner**, so
their pictures are taken by the same machine and the comparison is fair. And the first six
channels — what the interface says a control does, what calls went out, what it complained
about, what it gave back, what the source declares, and the coarse counts — do not care what
machine they ran on at all. Those are what a CI run is really made of.

The consequence, said plainly: **never compare a picture taken on a laptop against a picture
taken on a runner.** That is the `stored-record` mode, and it is marked weak for exactly this
reason. If the stored record was taken on a machine like this one the report says so; if it
was taken somewhere else the report says *that*, in those words, at the top.

**There are no pictures in the artifact.** The engine writes its evidence images into a
scratch folder and clears that folder when the run ends, so nothing is left to collect by the
time the job packs up. The artifact holds every observation both builds produced as JSONL,
the verdict, and what it compared against — which is the real evidence and is enough to work
out what happened after the runner is gone. An empty folder called `evidence` would be worse
than saying this.

**Anything irreversible is refused, not run twice.** Money, sign-in, a message going out, a
migration that destroys data — observed at the call boundary, never at the effect, and
reported as missing coverage. That is the same everywhere; it is only worth repeating here
because a build server is exactly where somebody would be tempted to point this at a staging
system with real credentials in it. Do not.

---

## Making a stored record worth something (optional)

The `stored-record` mode is weak mostly because the record usually came from somebody's
laptop. There is one arrangement that fixes that, and it is the one thing CI can do here that
a laptop cannot do as cleanly: **take the record on a runner, so every later run compares
against observations from an identical machine.**

Add a second job that runs on pushes to your main branch, passes `--remember`, and caches the
result:

```yaml
  record:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci || npm install
      - run: node node_modules/staysfixed/src/v2/ci.js --remember
      - uses: actions/cache/save@v4
        with:
          path: .staysfixed/v2
          key: staysfixed-${{ github.sha }}
```

and restore it in the check job with `actions/cache/restore@v4` before the check step.

`--remember` is a deliberate flag and not a default, because getting it the wrong way round
would turn every red pull request into the new definition of working. **Only ever pass it on
a branch that has been merged.**

This is worth setting up only if you cannot get a full history — with `fetch-depth: 0` the
paired merge-base run is stronger than any stored record, and needs no cache at all.

---

## Not on GitHub?

`ci.js` reads GitLab and CircleCI too, and falls back to plain git when it recognises
neither. There is nothing GitHub-specific in the check itself — only the job summary page,
which GitLab and CircleCI do not have, so on those the report goes to the job log and to
`.staysfixed/ci/summary.md` in the artifact.

**GitLab.** `CI_MERGE_REQUEST_DIFF_BASE_SHA` is the fork point already worked out, so GitLab
is the one server that gives the strongest mode away for free:

```yaml
staysfixed:
  image: node:22
  variables:
    GIT_DEPTH: 0            # read the section above before removing this
  script:
    - npm ci
    - node node_modules/staysfixed/src/v2/ci.js
  artifacts:
    when: always
    paths: [.staysfixed/ci, .staysfixed/v2]
```

**CircleCI** tells a job that a pull request exists and refuses to say which branch it is
aimed at, so the base is worked out from git — `origin/main` and `origin/master` are tried.
Pass `--against` if your main branch is called something else.

**Anywhere else, or by hand.** It is one command and nothing about it needs a build server:

```sh
git fetch --unshallow 2>/dev/null || true      # full history, however you get it
npm ci
node node_modules/staysfixed/src/v2/ci.js --against "$(git merge-base origin/main HEAD)"
echo "exit code: $?"          # 0 nothing changed · 1 something did · 2 no answer at all
```

The report is printed to the log and written to `.staysfixed/ci/summary.md`. Keep that folder
and `.staysfixed/v2` if you want to look at what happened afterwards.

---

## Calling it from code

```js
// A file path, not a package name. Stays Fixed does not publish a subpath yet, so
// `import ... from 'staysfixed/src/v2/ci.js'` will NOT resolve — this form will.
import { detectCI, referenceForCI, reportForCI, runCI } from './node_modules/staysfixed/src/v2/ci.js';

const where = detectCI();                       // provider, commit, branch, pull request
const reference = await referenceForCI();       // mode, commit, how strong, what was ruled out
const { exitCode, report } = await runCI();     // all of it, plus the job summary
```

The whole surface: `detectCI`, `referenceForCI`, `reportForCI`, `writeJobSummary`,
`saveEvidence`, `runCI`, `main`.

`referenceForCI()` hands back everything it *considered*, not just what it chose — each mode,
whether it was available, why not, and the concrete thing that would unlock it. An agent
reading a weak run can find out what to do about it without being told.

There is no `staysfixed ci` command yet. The command table lives in another file; when it
gains one it will be `runCI` and nothing else, and this workflow will not have to change.

---

## What is not proven yet

Written down plainly, because a claim about CI made from a laptop is a claim nobody checked.

**No real GitHub Actions job has ever run this.** It could not be run from where it was
written. Everything below was proved locally by faking the environment variables and by
running the whole thing against real git repositories on a Mac.

What *was* proved:

- All four environments detected from faked variables — GitHub (pull request and push),
  GitLab, CircleCI, and neither. The GitHub event file is read for the branch tip, and a
  pull request is still recognised when that file is missing.
- **merge-base found correctly** on a real clone with a real branch forked from `origin/main`.
- **A depth-1 clone caught and refused.** This was a genuine bug found in the writing: a
  shallow clone answers the fork-point question with HEAD, and the run would have gone green
  having compared a build against itself. Every mode now throws away a reference that is the
  commit under test.
- The whole chain end to end on a scratch project: reference chosen, old build put back with
  `git archive`, both builds walked, a broken exit code found and sealed as a crash, exit **1**.
  The same project with the change reverted: exit **0**. A repository with nothing to compare
  against: exit **2**.
- The project's git history byte-identical before and after a run.
- The workflow's YAML parses, and both branches of its setup step were run in `bash -eo
  pipefail` against a configured and an unconfigured project. That step had a real bug too —
  one `ls` over both patterns fails whenever either matches nothing, which would have skipped
  the check on a properly configured project.

What is **not** proved, and would only be settled by a real run:

- Ubuntu. Every local run was on macOS. Nothing in `ci.js` is platform-specific, but that is
  an argument, not a measurement.
- The job summary actually rendering. The markdown is written to the file GitHub names; how
  it looks on the page is unseen.
- `actions/upload-artifact` picking up `.staysfixed/ci` and `.staysfixed/v2`.
- Whether a Chromium install is enough for the web adapter on a runner with no display.
- How long a paired run takes on a real product. On a two-command scratch project it was
  about a second; a real project with a browser in it will be minutes, and the 30-minute
  timeout in the workflow is a guess.

---

## The workflow itself

This file lives in the repository, not in the npm package — so if you installed Stays Fixed
from npm you cannot copy it off disk, and the line above used to send you looking for it.
Here it is in full. Save it as `.github/workflows/staysfixed.yml` in your own project.

```yaml
# Prove that nothing which already worked has changed — on every pull request.
#
# WHY A BUILD SERVER IS A GOOD PLACE FOR THIS, and not a compromise. Everything Stays Fixed
# concludes rests on one claim: the difference was caused by the change and nothing else. A
# fresh runner has the same fonts every time, the same operating system, nothing else
# competing for a port, and no half-finished experiment left over from yesterday. It is a
# better machine for this job than anybody's laptop.
#
# WHAT IT COMPARES AGAINST. On a pull request: the commit your branch forked from — put back
# on this same runner with `git archive` and walked again, minutes apart. That is a full
# paired run, and it needs nothing stored from a previous job. On a push it works down to the
# last release, the last tag, or the commit before. Whichever it lands on is named in the job
# summary, because they are not equally strong.
#
# THE ONE LINE YOU MUST NOT DELETE is `fetch-depth: 0`. A shallow checkout answers "what did
# this branch fork from" with "this commit" — so the check would compare the build against
# itself, find nothing, and go green. Stays Fixed catches that and refuses, but the run is
# then worth nothing. Full history is what makes this work.

name: Stays Fixed

on:
  pull_request:
  push:
    branches: [main, master]

# Nothing is published, released or tagged here, and no token is used for anything.
permissions:
  contents: read

# Two runs of the same branch would be two builds on one machine fighting over ports and
# user data directories. Sequential, never simultaneous, is a rule of the whole tool.
concurrency:
  group: staysfixed-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    name: Has anything that worked changed?
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@v4
        with:
          # Read the paragraph above before changing this.
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install
        run: npm ci || npm install

      # Only needed if anything you check is a web page. Delete these three lines for a
      # command line tool or a library — the check will say what it could not look at either way.
      - name: A browser to look at web pages with
        run: npx playwright install chromium

      - name: Is Stays Fixed set up in this project?
        id: setup
        run: |
          # Two separate looks on purpose. One `ls` over both patterns fails whenever
          # either of them matches nothing, which would report a configured project as
          # unconfigured and quietly skip the whole check.
          if ls staysfixed.config.* >/dev/null 2>&1 || ls .staysfixed/config.* >/dev/null 2>&1; then
            echo "configured=yes" >> "$GITHUB_OUTPUT"
          else
            echo "configured=no" >> "$GITHUB_OUTPUT"
            {
              echo "## Stays Fixed"
              echo
              echo "This project has no Stays Fixed settings file, so **nothing was checked**."
              echo "This job is green because nothing was claimed — not because anything was proved."
              echo
              echo 'Run `npx staysfixed init` in your project to set it up.'
            } >> "$GITHUB_STEP_SUMMARY"
          fi

      # Works out what to compare against, runs the check, writes the plain-English report
      # into the job summary, and exits with the code that decides this job:
      #
      #   0  nothing that already worked has changed
      #   1  something changed that nobody accounted for
      #   2  the check could not run, or there was nothing to compare against — which is
      #      NOT a pass, and is why this step has no `continue-on-error`
      - name: Check
        if: steps.setup.outputs.configured == 'yes'
        run: |
          # In your own project Stays Fixed is a dependency. In the Stays Fixed repository
          # itself it is the source you are looking at. Both paths are tried so this file
          # can be copied straight out of one into the other.
          if [ -f node_modules/staysfixed/src/v2/ci.js ]; then
            node node_modules/staysfixed/src/v2/ci.js
          else
            node src/v2/ci.js
          fi

      # Every observation both builds produced, the verdict, and what it compared against.
      # Kept even when the job fails — especially then.
      - name: Keep the evidence
        if: always() && steps.setup.outputs.configured == 'yes'
        uses: actions/upload-artifact@v4
        with:
          name: staysfixed-${{ github.run_id }}
          path: |
            .staysfixed/ci
            .staysfixed/v2
          if-no-files-found: ignore
          retention-days: 14
```
