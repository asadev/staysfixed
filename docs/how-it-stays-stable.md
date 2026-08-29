# How it stays stable

A picture check is only worth having if it is silent when nothing changed. The
moment it fails for a reason nobody caused, people start ignoring it — and once
they ignore it, the real regression walks through with everything else. So most
of the engineering in Stays Fixed is not in taking the picture or comparing it.
It is in removing every reason the picture could change on its own.

This page is the long version: each source of wobble, what actually goes wrong,
what the tool does about it, and — the part that usually goes unsaid — what it
cannot fix.

---

## 1. Time

**What goes wrong.** Almost every app puts time on the screen: a "3 minutes ago",
a copyright year, a date column, a greeting that says good morning. Any of them
makes a picture that never matches itself twice. Worse are the invisible ones: a
component that keys off `Date.now()`, a cache that expires, a token that looks
stale on the second run.

Time zone is the sneakier half. The same instant renders as `14:00` in London and
`09:00` in New York, so a picture approved on somebody's laptop fails in CI for a
reason that has nothing to do with the code.

**What the tool does.** Two layers, because neither is enough alone.

The Chrome DevTools Protocol is told which time zone and locale the renderer
believes it is in. That reaches `Date.prototype.toString`, `getTimezoneOffset`
and all the ICU date formatters — places page script cannot touch. The defaults
are UTC and `en-US`.

Then a script injected before any of the app's own code replaces `Date` with a
subclass whose `new Date()` and `Date.now()` return a fixed instant, by default
`2026-01-01T12:00:00.000Z`. A subclass rather than a proxy, so `instanceof`,
every `Date.prototype` method and all date arithmetic keep working untouched.

The instant is frozen but the app is not dead: real timers still fire, so a
spinner that waits 300ms still finishes. Only the *reading* of the clock is
pinned. `Emulation.setVirtualTimePolicy` — which would genuinely stop time —
is deliberately not used, because it also stops the app.

**What it cannot fix.** Time that comes from your server rather than the browser.
If the API returns `"created_at"` and the app renders it, the picture depends on
your database, not on the clock. Seed the data, use `network: 'replay'`, or mask
the column. And `Date()` called without `new`, which returns a string — app code
effectively never does this and minifiers never produce it, but it is the one
thing the subclass gives up.

---

## 2. Movement

**What goes wrong.** Anything that moves is a picture that disagrees with itself.
A fade-in caught at 60% opacity. A skeleton loader shimmering. A carousel one
slide further along. A modal mid-scale. A `<video>` that has autoplayed to a
different frame. Timing is what decides which frame you got, and timing is never
the same twice.

**What the tool does.** Three layers, because each catches what the others miss.

CSS kills declared animations and transitions — including delayed ones, which
would otherwise fire later, and infinite ones, which hold a compositor layer
open. `will-change` is forced back to `auto`: a promoted element is rasterised on
different pixel boundaries, so taking the promotion away puts it back on the same
pixels every run. Smooth scrolling becomes instant scrolling.

Page script kills what CSS cannot reach: running Web Animations are cancelled
(cancelled, not finished — finishing an infinite spinner is meaningless and
finishing a fade-out would hide content you wanted to see), `<video>` elements
are paused and seeked to frame zero, and `Element.prototype.animate` is replaced
with a stub that reports itself already finished. The stub matters: libraries
await `animation.finished` before showing the next thing, so simply deleting
`animate()` would leave those apps hung half-rendered forever. A mutation
observer re-sweeps whenever the page changes, because a router-mounted spinner
or a lazily-faded image brings its own animations with it.

The protocol is told the machine prefers reduced motion, which is the only thing
that stops a well-behaved app starting an animation in the first place.

**What it cannot fix.** An animated GIF. A `<canvas>` draw loop that ignores
`requestAnimationFrame`. A WebGL scene. Anything driven by a `setInterval` that
paints directly. Mask those regions.

---

## 3. Randomness

**What goes wrong.** Randomness reaches a picture in more places than people
expect: a shuffled list, a placeholder avatar colour, a chart's jitter, a React
key printed into a data attribute, a generated id that ends up in the
accessibility tree and then in a tooltip. Any one of them makes a screen that
never matches itself.

**What the tool does.** `Math.random`, `crypto.getRandomValues` and
`crypto.randomUUID` are all replaced with a seeded generator — mulberry32, 32
bits of state, well distributed enough that a shuffled list still looks
shuffled, and identical on every machine on every run. The seed defaults to
`20260101` and is configurable.

The real functions stay reachable on `window.__staysfixed_realRandom`, because a
handful of apps genuinely need unpredictable bytes — a crypto key, a WebRTC
session — and would break rather than merely look different.

**What it cannot fix.** Randomness that happened on your server. An API that
returns a random featured item produces a different picture no matter what the
browser does.

---

## 4. The network

**What goes wrong.** This is the single biggest reason a picture stops matching
tomorrow. A page that fetches an avatar from a CDN, a font from a third party, an
analytics beacon or a live feed is a page whose picture depends on somebody
else's server, on today's weather in their data centre, and on the office wifi.
A stock photo service rotates its image and your check fails at 3am for a change
nobody made.

**What the tool does.** Every request is intercepted, in one of three modes.

`live` lets everything through and counts it, so `--verbose` can show you what
your app is actually reaching for.

`block-external` — the default — lets the app's own origin, localhost and an
allow list out, and refuses everybody else. A tiny glob syntax covers the allow
list: `*` stops at a path separator, `**` crosses them.

`replay` records every reply once into `.staysfixed/fixtures/` and then serves
those same bytes forever. This is usually the only way a desktop app or an
API-heavy page renders the same screen twice. Those recordings belong in git —
they are part of the promise, not part of the evidence.

Every paused request gets exactly one answer: continue, fail, or fulfil. A
request that is paused and never answered stalls the page silently, which looks
exactly like a hung app, so the code is careful about it. On replay,
`content-encoding`, `content-length` and `transfer-encoding` headers are dropped:
the recorded body was handed over already decoded and whole, so telling the
browser it is gzipped makes the browser throw the reply away and the "replayed"
run shows a blank page for no visible reason.

**What it cannot fix.** Your own backend returning different data. If the app
talks to a live database, the picture is a picture of that database. Seed it,
replay it, or accept that the screen is not checkable.

---

## 5. Fonts and images arriving late

**What goes wrong.** The most common cause of a picture that "randomly" fails is
a font or an image that had not landed yet. Text reflows when the real face
replaces the fallback — every line moves. A missing image collapses a card and
everything below it slides up. Neither is a bug in the app, and neither is worth
waking a human for.

**What the tool does.** Waits for both before the shutter. `document.fonts.ready`
is treated as a starting gun rather than a finish line — it can settle while a
face requested a moment ago is still in flight — so the tool then polls
`document.fonts.status` until the browser itself agrees everything is loaded, up
to a bounded number of tries. Images are waited on the same way.

Every wait races a real `setTimeout` rather than a clock reading, because the
clock is frozen and `Date.now()` would never reach the deadline.

**What it cannot fix.** A font that genuinely is not available on the machine
taking the picture. If your CSS falls back to a system font, the picture is of
the fallback, and a different machine has a different fallback. Self-host your
fonts, or allow the font host through `networkAllow`.

---

## 6. Layout that shifts after it looks finished

**What goes wrong.** A chart draws itself a beat late. A virtualised list
measures its rows and re-lays them out. A scrollbar decides it exists and takes
15 pixels of width away from everything. A late `ResizeObserver` fires. The page
looked ready and then moved.

**What the tool does.** This is what the settle loop is for, and it is the reason
picture checks can be trusted at all. Take the photo, take it again, and only
accept it once two photos in a row agree. Everything else in the freeze layer
removes a *reason* to change; settle is the net for the reasons nobody thought
of.

Before the first shot it waits for `load`, gives any surviving animations a
bounded grace period to end on their own, and waits two animation frames — the
first lets the browser run what was scheduled, the second only arrives once that
work has actually been painted. Then it shoots on an interval until `frames`
consecutive photos are identical, or `timeoutMs` runs out. Two identical frames
is the default; `maxDriftPixels` is 0, meaning identical means identical.

The comparison between two settle frames starts by comparing the compressed PNG
bytes, which costs nothing and is what happens almost every time. Only when they
differ does it pay to decode both.

If it times out it hands back the last photo anyway and records that it never
settled, rather than failing — a screen that will not hold still is worth seeing.

**What it cannot fix.** A page that never settles: a live-updating dashboard, a
running timer, a chat that polls. Mask the moving region, or do not check that
screen.

---

## 7. Focus rings

**What goes wrong.** Whichever element happened to have focus when the last step
finished draws an outline. Which element that is depends on click timing, so it
changes between runs on identical code — and the approved picture has the ring on
a different element, or on none.

**What the tool does.** Blurs the active element immediately before the shutter,
unless it is `document.body`, then forces a layout flush and waits two frames so
the removal is actually painted rather than merely calculated. It also resets
scroll to the top unless the recipe scrolled somewhere on purpose, for the same
reason: a page left scrolled by a click-into-view photographs differently every
run.

**What it cannot fix.** A focus ring you actually want in the picture. If the
screen you are checking is "the search box is focused", the blur will undo it —
capture that state with a mask around the rest, or check it with a guard instead.

---

## 8. Scrollbars and the text caret

**What goes wrong.** A scrollbar appears when content grows by one line, and
taking 15 pixels of width away reflows the entire page. Whether it is an overlay
scrollbar or a classic one is an operating-system setting, so the same code
photographs differently on two machines. Meanwhile a text cursor blinks: half the
runs catch it on, half catch it off.

**What the tool does.** Hides both. Scrollbars go via CSS
(`::-webkit-scrollbar`, `scrollbar-width: none`) and via Chrome's
`--hide-scrollbars` flag; the caret goes via `caret-color: transparent`. Both are
on by default and both can be turned off in `freeze`.

**What it cannot fix.** A custom scrollbar your app draws itself out of divs.
That is content, and it is checked like content.

---

## 9. GPU rasterisation

**What goes wrong.** The same page, rasterised through two different graphics
drivers, is not the same pixels. Gradients band differently. A rotated element's
edges land a fraction differently. A composited layer is rounded to a different
boundary. None of it is visible to a person and all of it is visible to a pixel
comparison.

**What the tool does.** The browser is launched with GPU rasterisation off
(`--disable-gpu`), runtime Skia optimisations off, partial raster off, composited
antialiasing off, and the colour profile forced to sRGB. Software rendering is
slower and it is the same everywhere, which is the trade this tool exists to
make. The device scale factor is forced rather than inherited from the display,
so plugging in an external monitor does not change your pictures.

**What it cannot fix.** Software rasterisation still differs a little between
Chrome versions. That is why the CI workflow pins Chrome's major version, and why
bumping it is a deliberate act followed by re-approving what moved.

---

## 10. Operating-system text smoothing

**What goes wrong.** macOS, Windows and Linux each draw text differently, and
within one OS the answer changes with the display, with whether the window is on
an external monitor, and with the graphics driver version. Subpixel antialiasing
puts colour fringes on glyph edges. Hinting snaps stems to the pixel grid.
Different fake-bold synthesis appears when a weight is missing.

**What the tool does.** Pins all of it: `-webkit-font-smoothing: antialiased`,
`text-rendering: geometricPrecision` (which stops glyph advances being rounded to
whole pixels — that rounding is what makes a line of text reflow by one pixel
between runs), and `font-synthesis: none` (so a fake bold is never invented,
because inventing one is a per-machine decision). At the browser level, font
render hinting is off, LCD text is off, and subpixel positioning is off.

This trades a little fidelity for pictures that do not change when the operating
system changes its mind. It is worth it.

**What it cannot fix — and this is the honest limit of the whole tool.** A
picture is tied to the operating system that took it. A macOS-approved picture
will not match on Linux, no matter how many flags are set: the font stack is
different, the fallback faces are different, and the text rasteriser is a
different piece of code. Approved pictures are stamped with the platform that
took them (`darwin-arm64`, `linux-x64`) and comparing across platforms warns you.

There are two honest ways to live with this:

1. **Take the pictures in one place.** Approve on CI, or approve on one machine
   everyone shares. This is the simpler answer and it is the one most projects
   should pick.
2. **Approve per platform.** Keep a separate approved folder per platform by
   setting `dir` from an environment variable, and approve on each. More work,
   but it lets everybody run `check` locally.

---

## The last line of defence: the flake register

Even with all of the above, something will eventually wobble. So the tool keeps
score. Every run appends a status per check. When a check changes its mind while
the git sha and the working tree stood still, that is recorded as a flake — that
is the only honest definition, because anything looser blames you for your own
edits. A check that only passes on the retry inside a single run counts too.

Past `flakeLimit` (2 by default) the check is **condemned**, and `check` says so
in red until a person deals with it. There is no option to tolerate it. Fix it or
delete it — a check nobody believes is worse than no check, and the whole tool is
built on being believed.

`staysfixed flake` shows the register. `staysfixed flake --clear <name>` forgives
a check once it has genuinely been fixed.
