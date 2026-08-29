# Stays Fixed

A test runner that proves what already worked still works after an AI agent
changed the code.

AI agents change a lot of code very quickly, and the thing that breaks is almost
never the thing they were working on — it is something in the corner that had
already been built, already been fixed, and that nobody thought to look at again.
Ordinary tests read the code, and code that reads fine can still render a page
with no stylesheet, a collapsed sidebar or a button pushed off the screen. A
picture can see that. So Stays Fixed opens your real app, photographs the screens
that matter, and compares them against pictures a human approved.

Four nets, one engine:

| | |
| --- | --- |
| **Picture checks** | Photograph the screens that matter and fail on any visible difference — until a person approves the new picture. |
| **Guards** | One check per bug that was already fixed once, named in plain English, whose only job is to fail the day that bug comes back. |
| **Walk** | Before a release, open the real built app, walk the main routes, and photograph every step onto one page you can scroll. |
| **Markers** | Pin each known-good release, so when something does regress you trace it to the exact commit in minutes. |

It runs as a command you type, and as an MCP server so Claude Code, Codex, Gemini
CLI or Cursor can check their own work the moment they finish editing. **An agent
can check. Only a human can approve.**

---

## Install and first run

**It is not on npm yet.** Run it from GitHub — that is the way to use it today:

```
npx github:asadev/staysfixed init
npx github:asadev/staysfixed check
```

`init` asks what your app is, writes a `staysfixed.config.js` you can read, makes
the `.staysfixed/` folder and adds the two lines to your `.gitignore` that keep
the throwaway results out of git.

`check` opens the app, takes the pictures, and — the first time — tells you that
nobody has approved any of them yet. Look at them, and approve the ones that are
right:

```
npx github:asadev/staysfixed approve --all
```

From then on, `check` is silent unless something actually moved.

Requirements: **Node 22 or newer**, and a Chromium-based browser on the machine
(Chrome, Chromium, Edge or Brave — or, for a desktop app, the Chromium already
inside your Electron build). `npx github:asadev/staysfixed doctor` tells you what
it found and what it is missing.

Two runtime dependencies, `pngjs` and `pixelmatch`. No build step: the JavaScript
in the repository is the JavaScript that runs.

---

## The four nets

### 1. Picture checks

Photograph the screens that matter, compare against the approved picture, fail on
any visible difference.

```
$ staysfixed check

✓  home                           still the same 1.4s
✓  signed-in-dashboard            still the same 2.1s
✓  settings-notifications         still the same 1.9s
✗  billing-empty                  looks different — 4,118 pixels changed 2.3s
!  pricing-card-pro               nobody has approved this picture yet 900ms
    look at it, then run: staysfixed approve pricing-card-pro
✓  the sidebar still collapses    still holds 400ms
✓  logging out clears the session still holds 700ms

✗ 1 thing changed. Look at it before you ship. 1 new screen is waiting for a person to approve it.
  5 screens, 2 guards, about 12 seconds.

What is not right
  name              what happened                           where to look
  billing-empty     looks different — 4,118 pixels changed  .staysfixed/results/diffs/billing-empty.diff.png
  pricing-card-pro  nobody has approved this picture yet    .staysfixed/results/pricing-card-pro.png

What to do next
  Look at each picture in the report. If the new one is what you meant, approve it:
    staysfixed approve billing-empty
    staysfixed approve pricing-card-pro
  Or accept every one of them: staysfixed approve --all
  The pictures, side by side: .staysfixed/report.html
```

Open `.staysfixed/report.html` — one self-contained page with the old picture,
the new one and the difference side by side. If the new look is what you meant,
approve it and it becomes the picture everything is measured against from now on.

Approved pictures live in `.staysfixed/approved/` and belong in git. They are the
promise. The `results/` folder is only evidence from the last run and is ignored.

### 2. Guards

One check per bug that has already been fixed once. Its only job is to fail on
the day that bug comes back.

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

```
$ staysfixed check --guards-only

✗  prices still show two decimals This should still be true, and it is not: "the total shows two decimals". 300ms
    expected: the total shows two decimals
    why this guard exists: A rounding change made the cart show $12.5 instead of $12.50 for two days.
```

The name is not decoration. It is what prints when the guard fails, what goes in
the report, and what an agent reads before deciding whether it broke something.
So names are enforced: `sidebar_collapse_test` and `#4412` are refused, with an
explanation and — where one can honestly be built — a rewrite. Three plain words
minimum, present tense, no test ids. See [docs/guards.md](docs/guards.md).

**It does not steal your screen.** A desktop app has to really open to be
photographed, but it opens *behind* whatever you are using and stays there. The
rendering flags keep it painting while it sits in the background, so the pictures
are identical either way — bring it to the front yourself whenever you want to
watch it work. Set `app.foreground: true` if you would rather it came forward.

### 3. Walk

Before a release, open the real built app, walk the main routes, photograph each
step, and leave behind one page you can scroll through in thirty seconds.

```
$ staysfixed walk

✓ Walked 6 screens and every one of them opened.
  Every screen it photographed: .staysfixed/results/walk-20260829-013245/index.html
```

Nothing is compared and nothing can fail on a pixel here. This net is for the
question a picture check cannot answer: *does the thing I am about to ship
actually open?*

### 4. Markers

Pin each known-good moment — a release, or just before you start something risky.
Everything is checked first, and the marker is refused if anything is not
passing.

```
$ staysfixed mark v0.1.0 --note "first public build"
```

Then, when something has regressed and you have no idea when:

```
$ staysfixed trace billing-empty

billing-empty
  It was still right at "v0.1.0" and already different by "v0.2.0". The change is in between.
  2 commits landed in between:
    3f9c1ab  2026-08-24  Move the empty state into its own component  Asad Iqbal
    77d0e42  2026-08-25  Tidy the card styles                         Asad Iqbal
  files those commits touched:
    src/billing/EmptyState.jsx
    src/styles/cards.css

Looked through 3 markers.
```

### And the rest

```
staysfixed status                    what is set up here, and how the last check went
staysfixed flake                     checks that have changed their mind
staysfixed doctor                    what is missing before any of this can run
staysfixed mcp                       serve to an AI agent (see below)
```

```
$ staysfixed status

Stays Fixed
  watching ~/Projects/shop
  settings in ~/Projects/shop/staysfixed.config.js

  6  approved pictures
  6  screens in the settings
  3  guards
  2  known-good markers
  newest marker: v0.1.0 — pinned 2 days ago

  last checked 11 minutes ago at a1b2c3d on main, took about 12 seconds
✓ Everything that worked still works.
```

---

## How it keeps pictures stable

A picture check is only worth having if it is silent when nothing changed. The
moment it fails for a reason nobody caused, people learn to ignore it — and once
they ignore it, the real regression walks through with everything else. So most
of the work in this tool is removing every reason a picture could change on its
own:

1. **Frozen clock.** The app always believes it is the same instant, in the same
   time zone and locale. Timers still fire, so nothing hangs; only the reading of
   the clock is pinned.
2. **No motion.** Animations, transitions, smooth scrolling and video are stopped
   three different ways, and the page is told the machine prefers reduced motion.
3. **Seeded randomness.** `Math.random`, `crypto.getRandomValues` and
   `randomUUID` are replaced with a seeded generator, so a shuffled list is
   shuffled the same way every time.
4. **Frozen data.** External network requests are blocked, or replayed byte for
   byte from recordings kept in the repository, so your picture never depends on
   somebody else's server.
5. **Pinned rendering.** Text smoothing, glyph positioning and font synthesis are
   fixed in CSS; hinting, LCD text, subpixel positioning and GPU rasterisation
   are switched off in the browser; the colour profile is forced to sRGB.
6. **Wait for stillness.** Fonts and images are waited for, focus rings are
   cleared, and then the tool photographs the screen repeatedly and only accepts a
   picture once two in a row are identical.
7. **Blackout boxes.** Anything genuinely allowed to change — a live clock, a
   session id, a "3 minutes ago" — is painted over on **both** pictures, so
   adding a mask never forces a re-approval.
8. **Sensible tolerance.** 0.05% of pixels by default: enough to absorb hinting
   noise, nowhere near enough to hide a missing stylesheet or a shifted column.
9. **A flake register.** Every run is remembered. A check that changes its mind
   while the code stood still is recorded, and past the limit it is condemned and
   says so in red until a person fixes it or deletes it. There is no option to
   tolerate one.

**The honest caveat.** A picture is tied to the operating system that took it. A
picture approved on macOS will not match on Linux — the font stack is different,
the fallback faces are different, and the text rasteriser is a different piece of
code. No flag fixes this. Approved pictures are stamped with the platform that
took them and comparing across platforms warns you.

Two ways to live with it. **Take the pictures in one place** — approve on CI, or
on one machine everyone shares. That is simpler and it is what most projects
should do. Or **approve per platform**, by setting `dir` from an environment
variable so each platform keeps its own approved folder.

The long version, with what each trick cannot fix, is in
[docs/how-it-stays-stable.md](docs/how-it-stays-stable.md).

---

## For AI agents (MCP)

An agent that has just changed twenty files has no way of knowing whether it
broke the settings page, because it never opened the settings page. With this
wired in, it can check before it tells you it is done.

Claude Code:

```
claude mcp add staysfixed -- npx -y github:asadev/staysfixed mcp
```

Cursor, Gemini CLI, and most other clients take the same block —
`.cursor/mcp.json`, `~/.gemini/settings.json`, or your project's `.mcp.json`:

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

Codex keeps the same fields in TOML, in `~/.codex/config.toml`:

```toml
[mcp_servers.staysfixed]
command = "npx"
args = ["-y", "github:asadev/staysfixed", "mcp"]
cwd = "/absolute/path/to/your/project"
```

The tools an agent gets:

| Tool | What it does |
| --- | --- |
| `staysfixed_screens` | Lists the screens and guards this project watches. Cheap — does not open the app. Call it first. |
| `staysfixed_check` | Opens the app, photographs everything, runs the guards. Returns the verdict, what is not passing, and the diff image of each changed screen. |
| `staysfixed_capture` | Photographs one screen and hands back the picture. Compares nothing, changes nothing. |
| `staysfixed_status` | Approved pictures, guards, markers, last run, anything condemned for flaking. |
| `staysfixed_trace` | Which change broke this screen — last good marker, first bad one, the commits between. |

**An agent can check; only a human can approve.** `staysfixed_approve` is not
merely refused — it is not in the tool list at all unless the project explicitly
opts in, so the agent never sees a door to push on. That is the entire point of
the tool: an agent that can bless its own screenshots would edit the code, notice
the picture moved, approve the new picture, and report success, and your safety
net would have become a rubber stamp.

Full wiring instructions for every client: [docs/mcp.md](docs/mcp.md).

---

## Config reference

Everything is optional except `app` and `screens`. A five-line config works.

```js
/** @type {import('staysfixed/src/types.js').StaysFixedConfig} */
export default {
  // --- What to open -------------------------------------------------------
  app: {
    kind: 'web',                       // 'web' or 'electron'

    // web:
    url: 'http://localhost:3000',      // the address; relative screen urls hang off it
    start: 'npm run preview',          // optional command that starts the app
    browser: '/path/to/chrome',        // optional; found on the system by default
    headless: true,                    // default true

    // electron:
    // binary: '/Applications/Your App.app/Contents/MacOS/Your App',
    // args: ['--skip-onboarding'],
    // windowMatch: 'Your App',        // only drive the window whose title/url contains this

    cwd: '.',                          // working directory for start / binary
    env: { NODE_ENV: 'production' },   // extra environment for the launched process
    startTimeoutMs: 60000,             // how long to wait for the app to answer
    debugPort: 9333,                   // default: a free one is picked
    // attach: 'http://127.0.0.1:9333' // drive something already running instead of launching
  },

  // --- How big the window is ----------------------------------------------
  // Change this and every approved picture stops matching. Pick a size once.
  viewport: {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,              // 2 = retina-sharp, still deterministic
    mobile: false,                     // emulate a touch device
  },

  // --- Holding the app still ----------------------------------------------
  freeze: {
    clock: '2026-01-01T12:00:00.000Z', // the instant the app believes it is; false = leave time alone
    timezone: 'UTC',
    locale: 'en-US',
    motion: true,                      // kill animations, transitions, video, smooth scroll
    random: 'seeded',                  // 'seeded' or 'off'
    seed: 20260101,
    fonts: true,                       // wait for fonts and images, pin text rendering
    network: 'block-external',         // 'block-external' | 'replay' | 'live'
    networkAllow: ['https://fonts.gstatic.com/**'],  // globs let out even when blocking
    hideScrollbars: true,
    hideCaret: true,                   // the text cursor blinks; hide it
    settle: {
      frames: 2,                       // identical photos in a row before we accept one
      intervalMs: 250,
      timeoutMs: 10000,
      maxDriftPixels: 0,               // pixels allowed to differ and still count as identical
    },
  },

  // --- How much difference is allowed --------------------------------------
  tolerance: {
    pixels: 0.0005,                    // share of pixels allowed to differ, 0..1
    threshold: 0.12,                   // per-pixel colour sensitivity, lower = stricter
    antialiasing: true,                // ignore anti-aliasing noise
    maxPixels: 500,                    // a hard cap; overrides `pixels` when set
  },

  // --- Things allowed to change, painted over before comparing -------------
  // A CSS selector covers every element it matches; a rectangle covers an exact
  // area in CSS pixels. Applied to every screen.
  masks: ['[data-live-clock]', { x: 0, y: 0, width: 240, height: 32 }],

  // --- The screens ---------------------------------------------------------
  screens: [
    {
      name: 'billing-empty',           // file-safe id; becomes the picture's file name
      describe: 'Billing with no invoices yet',   // shown to humans
      url: '/billing',                 // shorthand for a single goto step

      // Or a list of steps, which also works in staysfixed.config.json:
      steps: [
        { goto: '/billing' },          // navigate; relative resolves against app.url
        { waitFor: '.invoice-list' },  // wait for a selector
        { waitForGone: '.spinner' },   // wait for one to disappear
        { scrollTo: '#totals' },       // scroll an element into view
        { hover: '.plan-card' },
        { click: 'button.new' },
        { type: 'input[name="q"]', text: 'hello' },  // type into a field
        { press: 'Enter' },
        { evaluate: 'window.scrollTo(0, 0)' },       // run JavaScript in the page
        { wait: 200 },                 // last resort; settle usually beats this
        { note: 'A human note, shown in reports.' },
      ],

      // Or code, when the steps need a decision (JS config only):
      // async do(page) { await page.goto('/billing'); await page.click('#tab'); },

      masks: ['.invoice-date'],        // extra masks for this screen only
      tolerance: { pixels: 0.001 },    // override tolerance for this screen only
      viewport: { width: 720 },        // override the size for this screen only
      freeze: { settle: { timeoutMs: 20000 } },     // per-screen freeze overrides
      clip: '[data-plan="pro"]',       // photograph only this element
      fullPage: false,                 // photograph the whole scrollable page
      skip: false,                     // leave it out for now, without deleting it
    },
  ],

  // --- Guards: one check per bug already fixed once ------------------------
  guards: '.staysfixed/guards',        // folder of plain JavaScript files

  // --- The pre-release walk -----------------------------------------------
  walk: {
    describe: 'What a reviewer clicks through before a release',
    steps: [ /* same shape as screens; defaults to `screens` */ ],
  },

  // --- What an AI agent may do through the MCP server ----------------------
  mcp: {
    allowApprove: false,               // let an agent approve pictures. FALSE on purpose.
    allowMark: false,                  // let an agent write known-good markers
  },

  // --- Housekeeping --------------------------------------------------------
  dir: '.staysfixed',                  // where approved pictures, guards and markers live
  flakeLimit: 2,                       // flakes before a check is condemned
  retries: 1,                          // re-captures before calling a difference real
  concurrency: 1,                      // screens at once. One, on purpose: determinism first.
};
```

A `staysfixed.config.json` file works too, with the declarative `steps` form and
no `do(page)` functions — so a Rust, Python or Go project can use the tool
without anybody writing JavaScript.

Two fuller examples, heavily commented, are in
[`examples/`](examples/): [a web app](examples/staysfixed.config.web.js),
[an Electron app](examples/staysfixed.config.electron.js), and
[a guard](examples/guards/the-sidebar-still-collapses.js).

---

## Does it actually work?

Two pieces of evidence ship with the repository.

**The unstable app.** `fixtures/unstable-app` is a page built to be impossible to
photograph: a clock ticking ten times a second, a relative timestamp, an endless
CSS spinner, a Web Animations tween, a shuffled list, a random number, a random
uuid, a chart of random bars, a blinking caret, an autofocused input, a web font,
an image that arrives late, and a feed the server answers differently every single
time it is asked. `npm test` photographs it **twenty times and requires every
picture to be byte-for-byte identical**. If that ever fails, the tool is broken and
nothing else in the suite matters.

**A real desktop app.** It was pointed at a real Electron application — 11 screens
and 2 guards, about 25 seconds a run, five consecutive runs with not one pixel of
difference. Then one line was removed from the built app: the `<link>` to its
stylesheet. Every one of the 11 pictures failed, and so did the guard written for
exactly that bug:

```
✗  start              looks different — 171,709 pixels changed
✗  overview           looks different — 188,813 pixels changed
✗  files              looks different — 187,242 pixels changed
   ...
✗  the app still has its styling
     expected: the window is not plain white
     why this guard exists: one release shipped with the whole app unstyled and
     every one of its ~3,600 tests passed, because none of them could see it.
```

Putting the line back made it green again on the next run.

Three checks were **deleted** during that run rather than tolerated — they wobbled,
and the rule in this tool is that a check which wobbles twice gets fixed or deleted.
That rule applies to the tool's own checks too.

---

## What version 0.1 does not do

Honestly, so you know before you invest an afternoon:

- **Not on npm yet.** Run it from GitHub: `npx github:asadev/staysfixed`.
- **No hosted service, no dashboard, no accounts, no teams, nothing paid.** It is
  a command and a folder of files in your repository. There is no server
  anywhere, and nothing is uploaded.
- **No history or analytics.** The flake register remembers whether a check has
  wobbled; it does not chart anything over time and there is no trend view.
- **No phone or tablet simulators.** You can emulate a narrow viewport and touch,
  which catches layout, but a real iOS or Android simulator is not supported.
- **Windows is untested.** The code has no deliberate Unix assumptions and CI runs
  on Linux and macOS, but nobody has run it on Windows, so treat it as unknown.
- **Chromium-based rendering only.** Chrome, Chromium, Edge, Brave, or the
  Chromium inside your Electron app. No Firefox and no WebKit, so this tool will
  not tell you that something broke in Safari.
- **Pictures do not travel between operating systems.** See the caveat above.
- **Not battle-tested.** This is a first version. It works, it is used, and it has
  not yet met the thousand strange apps that a widely-used tool meets. If it
  reports something that is not true, that is the most serious kind of bug it can
  have — please [open an issue](https://github.com/asadev/staysfixed/issues).

---

## Licence

MIT. See [LICENSE](LICENSE).

Built by Asad Iqbal.
