# The unstable app

A tiny web app whose entire job is to be as hard to photograph as a real one. If
Stays Fixed can take the same picture of this twenty times running, it can take
the same picture of anything.

Open it yourself:

```
node fixtures/unstable-app/server.mjs      # http://127.0.0.1:8931
```

## What is deliberately wrong with it

- a clock that reruns ten times a second, and a "3 minutes ago" that counts up
- a CSS spinner that never stops, and a transition on hover
- an animation started from JavaScript with the Web Animations API
- a shuffled list, a random number and `crypto.randomUUID()` printed on the page
- a bar chart drawn from `Math.random()`
- a blinking text caret and an input that takes focus on load
- a web font carried in the stylesheet as a `data:` URI, so font timing is
  exercised with nothing fetched from the internet
- an image that only turns up 200ms after everything else
- a panel filled from `/api/feed`, which the server answers **differently every
  single time** — this one is masked in the settings, because no amount of
  freezing can make somebody else's data hold still
- `/slow`, a route that takes 400ms to answer, used by the details page

## The deliberate break

`http://127.0.0.1:8931/?broken=1` serves the same page with the stylesheet
removed. Every button still clicks and every element is still in the document, so
a behaviour suite of any size stays green. Only a picture notices. That is the
failure this whole tool exists to catch, and `test/break.test.js` reproduces it.

## Where the guard lives

In `.staysfixed/guards/`, not in `guards/`. The tool always reads guards from
`<dir>/guards`, so that is where they have to be.

A guard with a badly chosen name would stop this whole folder loading — which is
correct, and would also turn the fixture's own passing run red. That example
lives in `test/guard-load.test.js` instead, where it belongs.
