# Using Stays Fixed from an AI coding agent

Stays Fixed speaks the Model Context Protocol, so an agent can check its own work
the moment it finishes editing — before it tells you it is done.

This is where the tool earns its keep. An agent that has just changed twenty
files has no way of knowing whether it broke the settings page, because it never
opened the settings page. Now it can: it opens the real app, photographs the
screens, compares them against the pictures you approved, runs the guards, and
gets back a short verdict plus the diff image of anything that moved.

**An agent can check. Only a human can approve.** That rule is the entire point
and it is enforced by not offering the door: `staysfixed_approve` is not in the
tool list at all unless the project explicitly opted in. Without it, an agent
edits the code, sees the picture move, blesses the new picture, and reports
success — and the safety net you installed has become a rubber stamp.

---

## Wiring it up

The server runs over stdin and stdout:

```
npx -y github:asadev/staysfixed mcp
```

It reads your `staysfixed.config.js` from the working directory it is started
in, walking up parent folders the same way the CLI does. If your client starts
the server somewhere else, set `cwd` in the config block.

### Claude Code

```
claude mcp add staysfixed -- npx -y github:asadev/staysfixed mcp
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
      "args": ["-y", "github:asadev/staysfixed", "mcp"],
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
      "args": ["-y", "github:asadev/staysfixed", "mcp"],
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
args = ["-y", "github:asadev/staysfixed", "mcp"]
cwd = "/absolute/path/to/your/project"
```

### Anything else

Every client that speaks MCP over stdio wants the same three things — a command,
its arguments, and somewhere to run it. The JSON block above is the shape almost
all of them use; translate it into whatever your client's config file looks like.

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

## The tools

| Tool | What it does | When the agent should reach for it |
| --- | --- | --- |
| `staysfixed_screens` | Lists the screens and guards this project watches, each with its plain-language description. Does not open the app, so it is nearly free. | **First**, before touching anything, so it knows what is protected. |
| `staysfixed_check` | Opens the real app, photographs every screen, compares each against the approved picture, runs every guard. Returns a short verdict, a line for anything not passing, and the diff image of each changed screen. | **After editing and before saying it is done.** This is the one that matters. |
| `staysfixed_capture` | Photographs one screen right now and hands back the picture. Compares nothing, approves nothing, changes nothing. | To see what a change actually looks like, or to look at a screen before touching it. |
| `staysfixed_status` | Approved pictures, guards, markers, how the last check went, and any condemned check. Does not open the app. | To get oriented, or after a check, to see whether something has been flaking. |
| `staysfixed_trace` | Compares a screen against the known-good markers and reports the last marker where it still looked right, the first where it did not, and the commits in between. | When `check` says something changed and nobody expected it to. |
| `staysfixed_approve` | Accepts the new picture as correct from now on. **Not offered unless `mcp.allowApprove` is true.** Off by default. | Almost never. See below. |
| `staysfixed_mark` | Pins this moment as known-good, after checking that everything passes. **Not offered unless `mcp.allowMark` is true.** Off by default. | At a release, or before starting something risky. |

`staysfixed_check` takes `only` (a list of screen or guard names), `guardsOnly`
(much faster, for edits that cannot change how anything looks) and `picturesOnly`.

The text an agent gets back leads with the verdict and then says only what is
**not** passing. A wall of green lines costs tokens and tells it nothing.

---

## The approve rule

By default `mcp.allowApprove` is `false` and the approve tool does not exist as
far as the agent is concerned. When a picture changes, the agent is told plainly:

> You cannot approve a new picture — only a person can, by running
> `staysfixed approve <screen>` in their terminal. That is deliberate. If a
> picture changed on purpose, say so and let them approve it; if it changed by
> accident, fix your code and check again.

Which is exactly the behaviour you want. The agent either fixes what it broke, or
tells you what it changed on purpose and hands you the decision.

You can turn it on:

```js
mcp: {
  allowApprove: true,   // think hard about this
  allowMark: false,
}
```

Do it only if you understand what you are giving up. The moment an agent can
approve its own pictures, the picture check stops being a check and becomes a
record of whatever the agent decided to do.

`allowMark` is milder — a marker is refused unless everything is passing — but it
is off by default for the same reason: markers are what a future regression is
traced back to, and they should mean something a person stood behind.

---

## Notes

**Everything is fresh.** The config and the guard files are re-read on every tool
call, so an agent that just edited `staysfixed.config.js` is answered from the
file it wrote, not from a snapshot taken when your editor started the server.

**Failures come back as results, not protocol errors.** A tool that fails returns
its explanation as content with `isError` set, because the agent is supposed to
read the failure and act on it — a JSON-RPC error would be swallowed by the
client before the agent ever saw the words.

**Nothing is left running.** Each check opens the app and closes it again on the
way out, success or failure. The server lives for your whole coding session, so a
leaked browser per call would fill the machine by lunchtime.

**Stdout is the protocol.** Every human-readable word the tool produces goes to
stderr. If you are debugging a guard, `console.log` in it is safe — the server
diverts stdout writes to stderr so a stray log cannot corrupt the stream.
