# Contributing

Thanks for looking. This is a small tool with a small surface, and it is meant
to stay that way.

## Running it

```
git clone https://github.com/asadev/staysfixed
cd staysfixed
npm install
npm run typecheck     # the real gate — plain JavaScript, types come from JSDoc
npm test              # the suite
npm run check         # both, in that order
```

There is no build step and there never will be one. `npx staysfixed`
has to work straight from a checkout, so the source you edit is the source that
runs. Types are written as JSDoc comments and checked by `tsc` with `checkJs`
and `strict` on; if `npm run typecheck` is clean, the types are done.

## The rules

**Every new check must be deterministic.** If a check can produce two different
answers from the same code, it does not go in. That is the entire product: a
check that cries wolf is worse than no check, because people learn to ignore it
and then the real regression walks through with everything else. If you cannot
make something repeatable, mask it, or leave it out.

**A check that flakes twice gets fixed or deleted.** Never tolerated, never
retried until it goes green, never given a bigger tolerance to keep it quiet.
The tool enforces this on its users through the flake register, and the project
holds itself to the same rule.

**A human approves; an agent never approves its own work.** This is load-bearing.
Any change that gives an agent a way to bless its own pictures by default will be
turned down, however convenient it looks.

**Dependencies are close to a no.** The runtime has three: `pngjs`, `pixelmatch`
and `playwright-core`. Everything else is a Node 22+ built-in, including the
global `WebSocket` and `node --test`. Adding a fourth needs a reason that
survives the question "what happens when this package is abandoned?" — for almost
everything, the answer is to write the twenty lines by hand. The MCP transport,
the JSON-RPC layer, the CLI argument parsing and the terminal colours are all
hand-rolled for this reason.

`playwright-core` is the exception that proves the rule, and it is worth knowing
why it is here. Reading what a web page *means* — the roles, names and states a
screen reader would read out — is not twenty lines, and a browser is not a
package you write by hand. It is `playwright-core` rather than `playwright`
because the `-core` package downloads no browser of its own: this tool already
knows how to find Chrome for Testing, Chrome, Edge or Chromium on a machine, and
deliberately prefers one that is not the browser the person actually uses.

It was removed once, in 0.7.2, on the entirely reasonable grounds that nothing
under `src/` imported it. Nothing does — `web-driver.js` reaches it through a
dynamic `import()`, which no search for an import statement will find. What
shipped told every agent that asked that web pages could be read "here and now",
and then answered every website check with "no web page can be opened". If you
are ever tempted to drop it, `test/v2/web-driver.test.js` will stop you and
explain.

**Plain English, everywhere a person reads.** No jargon, no test ids, no stack
traces in normal output. Every error says what happened and what to do about it.
If you have to explain a message to somebody, the message is wrong.

**Comments explain why, not what.** Especially in `src/freeze/` — every trick in
there exists because something specific went wrong, and the next person needs to
know what, or they will "simplify" it back out.

## Sending a change

- One thing per pull request.
- Say what broke, and how you would reproduce it.
- Run `npm run check` before you open it. CI runs the same two commands on Node
  22 and 24, on Linux and macOS.
- New behaviour needs a test. New human-facing text needs to read as if a
  non-programmer wrote it.

## Reporting something instead

Open an issue. A picture check that failed while the app was actually fine is the
most serious kind of bug here — say so plainly and it gets looked at first.
