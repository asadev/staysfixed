# Watching it work

A check is normally something you start and then look away from. `--watch` opens
a panel and draws the run as it happens — and puts that panel hard against the
app it is checking, so the two read as one window: your app, and its side panel
telling you what it is finding.

```
staysfixed check --watch
staysfixed walk --watch
```

---

## What the panel shows

- **Every screen and every guard, in a list**, each one moving from waiting, to
  running, to whatever it turned out to be: still the same, changed, new, or
  broken.
- **A thumbnail of each picture the moment it is taken**, so you see the app
  going past even on the screens that pass.
- **Approved, now, and the difference side by side** for anything that changed —
  the same three pictures the HTML report gives you, without waiting for the run
  to end.
- **A bar per check** showing how long it took, so the slow one is obvious.
- **Running totals and the verdict**: how many are done, how many changed, and
  the same closing sentence the terminal prints.

The terminal still prints everything it always printed. The panel is a second
view of one run, not a replacement for the first.

---

## It attaches itself to your app

When the run opens your app, the panel pushes that window to one edge of the
screen and puts itself flush against it, filling the space left over. Nothing is
resized: your app keeps the size it asked for, the panel keeps the width you
asked for, and the panel keeps its width and its edge, and if the two together are wider than your display the app is pushed off the far edge rather than resized — resizing the thing being photographed would change every picture.

By default the app goes to the **right** edge with the panel down its left.
`--watch-side left` is the mirror image.

If there is not enough room for both — an app nearly as wide as the display —
the panel still opens at its full width rather than shrinking to something you
cannot read. Move one of them, or ask for a narrower panel.

## You can move it, and it stays moved

It is an ordinary window. Grab its edge and drag it wherever you like. Once you
have moved it, the panel stops placing itself: it will not jump back, and it will
not be pushed anywhere else for the rest of the run. Where you put it is where it
stays.

If you would rather it never moved anything in the first place, use `--no-snap`
and both windows open exactly where they would have anyway.

---

## The flags

| Flag | What it does |
| --- | --- |
| `--watch` | Open the panel. |
| `--watch-side left` | Push the app to the left edge and put the panel on its right. The default is `right`. |
| `--watch-width 520` | How wide the panel is, in pixels. The default is 460; anything under 240 or over 900 is brought back to the nearest of the two. |
| `--no-snap` | Leave both windows exactly where they are. Nothing is moved. |
| `--no-keep-open` | Close the panel the moment the run ends. By default it stays up so you can look at what changed. |
| `--watch-front` | Bring the panel to the front. See below for why that is not the default. |
| `--profile` | Nothing to do with the panel: prints where the seconds went after the run. |

Both `staysfixed check` and `staysfixed walk` take all of them.

`--watch` and `--json` ask for opposite things — a window to look at, and output
for a script to read. Ask for both and the tool says so in one line and carries
on without the panel, rather than quietly picking one.

You can set any of them once, in `staysfixed.config.js`, instead of typing them
every time:

```js
export default {
  app: { kind: 'web', url: 'http://localhost:5173' },
  watch: { enabled: true, side: 'left', width: 520 },
  screens: [/* ... */],
};
```

The command line wins over the settings file, with one deliberate exception:
`--watch` can only ever turn the panel **on**. Not typing it is not the same as
saying no to it, so it never switches off a panel your settings file asked for.

---

## It opens behind your work, on purpose

The panel is a real window, and a window that jumps in front of what you are
typing at the wrong moment is worse than no window at all. So it opens *behind*
whatever you are using and keeps drawing there. Bring it forward yourself
whenever you want to look — click it in your dock or task switcher — or start the
run with `--watch-front` if you would rather it came forward on its own.

This is the same rule the app being photographed already follows.

---

## What it needs

A Chrome-family browser on the machine: Chrome, Chromium, Edge or Brave. The
panel is a plain HTML page in an ordinary browser window, with no server, no port
you have to remember and nothing loaded from the internet.

If there is no such browser, or it will not start, you get one line saying the
panel could not open and **the run carries on exactly as it would have without
it**. A panel that failed to appear has never changed a verdict and never will.

`staysfixed doctor` tells you what browsers it can find here.

---

## It cannot affect the pictures

This matters more than the feature does, so it is worth being explicit.

The panel is a **separate browser window of its own**, with a throwaway profile.
It is not injected into your app, it shares no page and no rendering settings
with the app being photographed, and it never sends anything into it. It only
reads: the run publishes small events as it goes — this screen started, here is
its thumbnail, this one changed by four thousand pixels — and the panel draws
them.

Snapping moves the app's **window**. It never touches the app's page. What gets
photographed is the viewport the capture sets for itself, which is fixed by your
settings and has nothing to do with where the window happens to be sitting on
your desk — so a run watched and a run unwatched reach the same verdict, and the
pictures are byte for byte the same either way.

The thumbnails in the panel are shrunk copies made after a picture has already
been taken and compared. Nothing that appears in the panel is ever the thing that
gets compared.

---

## Where the time went

`--profile` is the other half of this work and needs no window:

```
$ staysfixed check --profile

...

Where the time went
  taking the pictures until two agree      11.5s  36%
  running the steps                        9.5s   30%
  waiting for fonts and images             7.7s   24%
  comparing against the approved pictures  2.7s   9%
  opening the app                          2.4s   8%
  running the guards                       900ms  3%
  everything else                          184ms  1%
  in total                                 31.9s
  each screen                              2.9s on average, across 11 screens
```

It is a pointer at the slow part, not a benchmark — the numbers are rounded to
what a person would say out loud. Run it twice before believing any one figure.
