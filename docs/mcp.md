# Using Stays Fixed from an AI coding agent

Stays Fixed speaks the Model Context Protocol, so an agent can check its own work
the moment it finishes editing — before it tells you it is done.

This is where the tool earns its keep. An agent that has just changed twenty
files has no way of knowing whether it broke the settings page, because it never
opened the settings page and does not know the settings page exists. Now it can
ask: it runs your product through the same steps twice, compares that against the
build you last shipped, subtracts whatever your product disagrees with itself
about, and hands the agent **only the differences nobody asked for**. Everything
unchanged is skipped and never reaches its context.

**An agent can check, and it can waive within limits. It can never decide what
"working" means.** That is cut by shipping, by a person, and there is no tool on
this surface that could move it — not refused, not on the list.

---

## Wiring it up

The server runs over stdin and stdout:

```
npx -y staysfixed mcp
```

It works out where your project starts from the folder it was launched in,
walking up parent folders the same way the CLI does — so an editor that starts
the server in a subfolder still gets answers about the whole project. It answers
`staysfixed_capabilities` even when the project has no settings file and half the
engine is missing, because that is the call an agent makes to find out what is
wrong.

### Claude Code

```
claude mcp add staysfixed -- npx -y staysfixed mcp
```

Add `-s project` to write it into the repository's `.mcp.json` so everybody on
the team gets it, instead of only you.

### Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for all projects:

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

### Gemini CLI

Same shape, in `~/.gemini/settings.json` (or `.gemini/settings.json` in the
project):

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

### Codex

Codex keeps the same fields in TOML, in `~/.codex/config.toml`:

```toml
[mcp_servers.staysfixed]
command = "npx"
args = ["-y", "staysfixed", "mcp"]
cwd = "/absolute/path/to/your/project"
```

### Anything else

Every client that speaks MCP over stdio wants the same three things — a command,
its arguments, and somewhere to run it. The JSON block above is the shape almost
all of them use; translate it into whatever your client's config file looks like.

`staysfixed doctor --json` returns that block already filled in, under
`wiring.mcp`, and so does `staysfixed_capabilities` with `detail: "full"` — so an
agent setting this up for somebody never has to copy it out of this page.

### If you have it installed locally

Skip `npx` and point straight at it, which is faster to start:

```json
{
  "mcpServers": {
    "staysfixed": {
      "command": "node",
      "args": ["./node_modules/staysfixed/bin/staysfixed.js", "mcp"]
    }
  }
}
```

---

## The loop

1. **`staysfixed_capabilities`** — once per session, first. What can be checked on
   this machine, what cannot and why, what is missing and who has to fix it, and
   the exact shape of every reply. After this call an agent should not need to
   read any documentation about this tool, including this page.
2. **`staysfixed_intent`** — say what you *meant* to change, before you run
   anything.
3. Change the code.
4. **`staysfixed_check`** — run it. Only what you did not account for comes back.
5. **`staysfixed_explain`** on the two or three you intend to act on, and
   **`staysfixed_prove`** where you want to test whether your own edit really
   caused one.
6. Fix those. **`staysfixed_waive`** anything you genuinely meant, within the
   gates. Then check again.

## The tools

| Tool | What it does | When the agent should reach for it |
| --- | --- | --- |
| `staysfixed_capabilities` | What this machine can check right now, what it cannot and why, what is missing that would unlock more, which other machines it can already reach, and the shape of every reply. Runs nothing. | **First**, once per session, before anything else. |
| `staysfixed_intent` | Seals what you meant to change: one plain sentence, the files or areas you expect to touch, and the differences you expect. | **Before the check**, and it has to be before — an intent sealed after a run cannot justify anything in it. |
| `staysfixed_check` | Runs your product through the same steps twice, compares against the last shipped build, and returns only the differences you did not account for, ranked with the ones furthest from your edit at the top. | **After editing and before saying it is done.** This is the one that matters. |
| `staysfixed_explain` | One finding in depth: every address that moved, both values in full, what class it is in, how far from your edit, the evidence. | On the two or three findings you intend to act on. Never on all of them. |
| `staysfixed_prove` | Puts the files you suspect back to the reference, runs again, and says whether the difference went away. Nothing is left reverted. | When you are about to fix something and want to know it is yours. |
| `staysfixed_waive` | Records that a difference was intended. Four gates, and a refusal is final. | Rarely. It is not approval and it makes nothing the new normal. |
| `staysfixed_coverage` | What was **not** checked: doors no journey has opened, surfaces out of reach, surfaces this copy has no adapter for, anything refused for being irreversible, and what it can never see anywhere. | Before telling anybody a change is safe. |

Each of those also carries a short title and the protocol's own flags for what it
does to the machine, so a client can tell a question from an action without being
told: `staysfixed_capabilities`, `staysfixed_explain` and `staysfixed_coverage`
are read-only and idempotent; `staysfixed_check` and `staysfixed_prove` open your
product, so they are neither; and none of the seven reaches the outside world,
because none of them does.

### Aiming a check

`staysfixed_check` takes `surface` and `at` to point it at one kind of product:

```
{ "surface": "web",      "at": "http://localhost:3000" }
{ "surface": "electron", "at": "./release/mac-arm64/YourApp.app" }
{ "surface": "android",  "at": "./app/build/outputs/apk/release/app.apk" }
{ "surface": "ios",      "at": "./build/YourApp.app" }
```

Aim it at a kind of product this project does not contain, or that this copy of
the tool has no adapter for, and **it refuses by name** — it never falls back to
checking whatever else was lying around and reporting that as your answer. A run
that did go where it was aimed says so.

It also takes `paired` (boot the old build live from the start — slower, much
stronger, and the right thing before a release), `against` (compare with a named
marker or commit), `only` (a list of journey names), `limit` and `offset` (paging
through the *last* run without running anything again), and `format: "json"`.

`journeys` names where the steps come from. Today that is the default — what each
adapter reads out of your source — or a path to a journeys file. `"suite"` and
`"recorded"` are written in `src/v2/journeys/` and not yet wired into a run: ask
for either and you are told so by name, rather than given a clean result about
steps something quietly chose instead.

---

## What comes back

Every reply is trimmed hard on purpose. Nothing heavy is volunteered: values,
evidence and pictures are fetched through `staysfixed_explain`, and each reply
ends by naming what was withheld and the call that fetches it.

- **The headline** — `NOTHING UNACCOUNTED FOR`, or how many differences you did
  not account for and how many of those are sealed.
- **The arithmetic** — how many ways in were walked, how many differences were
  subtracted as the product's own wobble, how many were already recorded as
  intended. This is what makes the silence legible: "nothing changed" and
  "nothing ran" read identically without it.
- **What was not checked** — directly under the headline, on clean runs as loudly
  as on dirty ones, and on a clean run also what a clean result *on this machine*
  actually means.
- **The findings**, worst first. Furthest from your edit sorts to the top,
  because that is what a side effect looks like.
- **Newly unpredictable addresses**, listed separately. Those were the same every
  run before your change and disagree with themselves now. Nothing looks broken,
  which is exactly why that kind of bug survives for months. A run with any of
  these is not a pass, and they cannot be waived — it is not a difference, it is
  a loss of determinism.
- **An escalation block**, when something needs a person, written for the person
  and marked to be pasted into your closing summary word for word.

Three results are neither a pass nor a failure and must never be reported as one:

- **`BLOCKED`** — the check could not be completed. No answer at all.
- **`NOTHING WAS ACTUALLY COMPARED`** — every journey walked on the new build,
  nothing on record from the old one. Arithmetically clean, and it would let a
  real regression through.
- **`NO ANSWER FROM THIS RUN`** — the build disagreed with itself about most of
  its own addresses, so almost everything was dropped before it could be
  compared. Fix it by writing a normalisation rule for whatever is moving, not by
  trusting the clean-looking run underneath it.

---

## The waiver gates

An agent's only door is a waiver, and it passes four machine-checked gates:

1. **Sealed classes are unwaivable** — money, signing in, losing data, a crash, or
   a difference touching a named guard. Whatever the reason, whoever is asking.
2. **The waiver has to agree with an intent sealed *before* the run.** Sealing one
   afterwards is refused, and the refusal says so in those words.
3. **Five waivers between one ship and the next.** Sealing another intent does not
   buy five more.
4. **Every waiver is fingerprinted to one exact difference** and dies the moment
   the reference moves.

Every waiver is counted out loud in the reply. "Nothing changed", "nothing ran"
and "everything was waived" read identically otherwise, and two of those three
are a safety net quietly announcing success.

`staysfixed_approve` is not merely refused — **it is not on the tool list at
all**, so an agent never sees a door to push on. An agent that could bless its own
results would edit the code, notice something moved, approve it, and report
success, and your safety net would have become a rubber stamp.

---

## Notes

**Nothing is guessed about where you are.** The server walks up from the folder it
was started in to find your project, the same way the CLI does. If it still lands
somewhere wrong, set `cwd` in the config block or pass `--config`.

**Tool calls run one at a time.** Two at once would mean two copies of your app
fighting over ports, locks and data folders — which is the exact failure this
whole design rejects. The queue is not optional.

**Failures come back as results, not protocol errors.** A tool that fails returns
its explanation as content with `isError` set, because the agent is supposed to
read the failure and act on it — a JSON-RPC error is swallowed by the client
before the agent ever sees the words. A check that found differences is also
returned with `isError` set, deliberately: it is the flag every client puts in
front of the agent, and an agent skimming past a real regression is the failure
this tool exists to prevent.

**Nothing is left running.** Anything the tool opened is closed on the way out —
clean finish, error or interrupt — and it never closes anything it did not start.
`staysfixed browsers --clean` tidies up after a run that was killed.

**Stdout is the protocol.** Every human-readable word goes to stderr. If you are
debugging a guard, `console.log` in it is safe: the server diverts stdout writes
to stderr so a stray log cannot corrupt the stream.

---

## The version 1 tools, for anybody who wired them up

Before the difference engine, Stays Fixed was a picture checker, and its MCP
surface was a different set of tools: `staysfixed_screens`, `staysfixed_capture`,
`staysfixed_status`, `staysfixed_trace`, a picture-shaped `staysfixed_check`, and
`staysfixed_approve` / `staysfixed_mark` behind explicit opt-ins
(`mcp.allowApprove`, `mcp.allowMark`, both `false` by default).

They still work, unchanged, and they are served by:

```
npx -y staysfixed mcp --v1
```

Nobody who wired that up has to change anything. Everything version 1's picture
check did is also still reachable from the command line — `staysfixed check
--pictures`, `staysfixed approve` — and pictures still require a person to
approve them there, for the same reason they always did.
