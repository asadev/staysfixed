# Guards

A guard is one check per bug that has already been fixed once. Its only job is to
fail on the day that bug comes back.

That is the whole idea. A guard is not a unit test and it is not a spec. Nobody
writes a guard for behaviour that has never broken. You write one the moment you
finish fixing something, while you still remember exactly what went wrong, and
then you never think about it again until the day it saves you.

Picture checks catch what you can see. Guards catch what you cannot: a keyboard
shortcut that stopped firing, a build that started emitting the wrong file, a
session that stopped being cleared on logout.

---

## Where they live

A folder of plain JavaScript files, `.staysfixed/guards/` by default. Files
starting with `_` or `.` are skipped, which is a handy way to park one. The
default export is the guard; a file may also export an array of guards, or
several named exports.

```js
export default {
  name: 'the sidebar still collapses',
  because: 'A CSS rename broke the toggle handler and it shipped.',
  async run(app) {
    await app.open('/');
    await app.click('[data-action="toggle-sidebar"]');
    await app.expect('the sidebar is hidden', async () => !(await app.page.visible('.sidebar')));
  },
};
```

They run inside `staysfixed check`, in the same real app the pictures are taken
from. `staysfixed check --guards` runs just the guards, which is much faster and
is what you want when your edit could not possibly change how anything looks.

---

## The name is the point

The name is the whole handover. It is what prints when the guard fails, what goes
in the report, what an agent reads back before deciding whether it broke
something, and what a person has to judge in five seconds at one in the morning.
Six months from now the name is all that is left of the bug.

So the tool refuses names that only make sense to whoever typed them. This is
enforced, not suggested — a bad name is rejected when the guards load, with an
explanation and, where the tool can honestly build one, a rewrite.

**The rule:** write what the app is supposed to do, in the words you would say out
loud. At least three words. Present tense. No test ids.

### What gets refused

| Refused | Why |
| --- | --- |
| `sidebar_collapse_test` | A code identifier, not a sentence. Guard names are printed to people, so use spaces and ordinary words. |
| `#4412` or `BUG-88` | An issue number. The number tells nobody what broke — put it in `link` and use the name to say what should still work. |
| `test sidebar collapse` | Starts with a test word. That describes a test, not the app. Drop it. |
| `should collapse` | Same, and only two words. |
| `sidebar` | One word. It says which area it touches, not what should still be true. |
| `SIDEBAR COLLAPSES` | ALL CAPS reads like shouting, not like a sentence. |
| `src/ui/sidebar.js` | A file name. Say what the app should still do, not where the code lives. |
| `Sidebar#collapse` | `#` and `::` read like code references. Put the reference in `link`. |
| A 140-character paragraph | Over 120 characters. The name is a short sentence; the story goes in `because`. |

### What passes

- `the sidebar still collapses`
- `prices still show two decimals`
- `logging out clears the session`
- `the export button still produces a csv`
- `keyboard shortcuts still work after the modal closes`
- `the settings window remembers its size`

Notice they are all sentences you could say to a colleague, and each one names
the behaviour rather than the code.

Two guards may not share a name. When one fails, the report shows the name — and
if two guards share it, nobody can tell which one broke.

---

## The fields

```js
export default {
  // Required. Plain language, three words or more.
  name: 'the sidebar still collapses',

  // When it was fixed. Free text — a date, a version, whatever you would say.
  fixed: '2026-08-14',

  // The story of the bug, in a sentence or two. Printed underneath the failure,
  // so somebody who has never seen this bug knows what they are looking at.
  because: 'A CSS refactor renamed .sidebar--open everywhere except the toggle handler.',

  // An issue, a commit, a note. Anywhere to read more.
  link: 'https://github.com/asadev/staysfixed/issues/12',

  // Park it without deleting it. `check` reports it as left out on purpose.
  skip: false,

  // How long it gets before it is called failed. Default 30000.
  timeoutMs: 20_000,

  // The check itself.
  async run(app) { /* ... */ },
};
```

---

## What `app` gives you

| | |
| --- | --- |
| `app.page` | The full page. `goto`, `click`, `type`, `press`, `hover`, `waitFor`, `waitForGone`, `scrollTo`, `wait`, `evaluate`, `visible`, `exists`, `textOf`, `count`, `boxOf`, `url`, `title`, `shoot`, `setViewport`, `consoleErrors`. |
| `app.open(path)` | Shorthand for `page.goto`. |
| `app.click(selector)` | Shorthand for `page.click`. |
| `app.expect(sentence, check)` | An assertion, in plain language. |
| `app.run(cmd, opts)` | Run a shell command in the project root. Returns `{ code, stdout, stderr }`. A non-zero exit is returned, never thrown — whether it means failure is the guard's decision. |
| `app.read(file)` | Read a project file as text. |
| `app.project` | The resolved config and paths. |

---

## The `expect` style

An assertion is a sentence plus a check, never a bare comparison:

```js
await app.expect('the sidebar is hidden', async () => !(await app.page.visible('.sidebar')));
```

When it fails, the terminal says:

```
✗  the sidebar still collapses    This should still be true, and it is not: "the sidebar is hidden". 0.4s
    expected: the sidebar is hidden
    why this guard exists: A CSS refactor renamed .sidebar--open everywhere except the toggle handler.
```

Anyone can act on that, including somebody who has never opened this repository.
Compare it with what a normal assertion library would have printed —
`AssertionError: expected false to be true` — which tells you nothing at all.

The check fails when it returns something falsy, or throws. Anything truthy
passes. Some shapes that read well:

```js
// A thing is on screen
await app.expect('the invoice total is on screen', () => app.page.visible('[data-total]'));

// A thing is gone
await app.expect('the error banner is gone', async () => !(await app.page.exists('.error-banner')));

// Text is right
await app.expect('the total still shows two decimals', async () => {
  const text = await app.page.textOf('[data-total]');
  return /^\$\d+\.\d{2}$/.test(text.trim());
});

// A count
await app.expect('all five plans are listed', async () => (await app.page.count('.plan-card')) === 5);

// Nothing to do with the screen at all
await app.expect('the production build still succeeds', async () => {
  const { code } = await app.run('npm run build');
  return code === 0;
});

await app.expect('the collapsed class is still defined', async () => {
  const css = await app.read('src/styles/sidebar.css');
  return css.includes('.sidebar--collapsed');
});
```

Write the sentence first. If you cannot say in plain words what should be true,
the guard is not ready to be written.

---

## Writing a good one

**Check the thing that actually broke, not only the thing you can see.** If the
bug was a class name that no longer matched, check the class name as well as the
visible result. A later refactor could hide the sidebar a different way, and the
guard should still hold.

**Check that the fix did not create a new trap.** A collapse you cannot undo is a
worse bug than the one you were fixing. Toggle it back.

**Keep it to one bug.** A guard that checks four unrelated things fails with one
name and four possible causes.

**Put the story in `because`, not the name.** The name is a sentence. The story
is a paragraph, and the tool prints it right underneath the failure.

**Do not add a guard for something that has never broken.** That is a test, and
it belongs in your test suite. Guards are a memory of real failures, and their
value comes from every single one of them mattering.

---

## The rule that keeps them honest

**A guard that flakes twice gets fixed or deleted. Never tolerated.**

Every run is remembered. When a guard changes its mind while the git sha and the
working tree stood still, that is a flake. Past `flakeLimit` — 2 by default — the
guard is condemned, and `check` says so in red until a person deals with it.

There is no option to tolerate a condemned guard, and there never will be. A
guard nobody believes is worse than no guard: it trains everybody to ignore red,
and then the real one goes unread. Usually the fix is easy — wait for the right
thing rather than a fixed delay, use `waitFor` instead of `wait`, or stop
depending on data that changes.

```
staysfixed flake                     # the register
staysfixed flake --clear "the sidebar still collapses"   # forgive one that is genuinely fixed
```
