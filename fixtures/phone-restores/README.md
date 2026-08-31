# What a phone looks like when nothing has changed

These two files are a measurement, not a made-up example, and they are the evidence behind
one sentence in the Android and iPhone adapters: that a paired run is offered on a phone.

## The question they answer

The strongest thing this tool does is a PAIRED run: it puts the old build back on the machine
and walks it minutes before the new one, so nothing that drifted in between — the weather, a
dependency, the clock — can be mistaken for somebody's change.

A phone has one screen, one package name and one set of permissions, so the two builds cannot
run side by side. They take turns, and the device is put back in between. Until 2026-08-31 the
adapters said a paired run was not offered here, because nobody had ever checked whether the
device really does come back to the same place. That was a guess.

## How they were taken

On 2026-08-31, on an Apple Silicon Mac, ONE build was walked repeatedly and the device was put
back between every walk exactly the way it is put back between two builds. The build never
changed, so anything that differs between two walks is what a paired run would have to live
with.

- **Android** — Terminal Deck's own app (`dev.terminaldeck.apk.debug` 0.13.0 build 6) on the
  `sfx_a33` virtual device: Android 13, Google APIs, arm64, no Play Store. The whole device was
  restored from a snapshot taken before anything was installed. Ten walks were taken; the four
  here are the ones kept.
- **iOS** — Terminal Deck's own app (0.15.0 build 2608221311) on an iPhone 17 Pro simulator
  running iOS 27.0. Between walks the app and everything it had written were removed and every
  permission it had been granted was taken back. Ten walks were taken; the four here are kept.

## What they showed

- **iOS: 725 addresses, and all 725 agreed in every pair.** Five pairs, 3,625 comparisons, not
  one disagreement — and the Mac was carrying a load average of about 500 at the time.
- **Android: 309 addresses, and 301 agreed in every pair.** The eight that did not were one
  thing seen at eight checkpoints: the identity code the app makes fresh for itself at every
  install. A control run with the snapshot restore switched OFF produced the same eight and no
  others, which is what proves the restore contributed none of them.

Eight addresses out of 309 that move on their own is ordinary wobble, and this tool already
measures and subtracts exactly that: the new build is always walked twice, and anything it
cannot answer the same way twice is taken out before a single difference is reported.
`test/v2/phones-paired.test.js` runs that arithmetic over these files.

## The shape of the file

One shared list of `addresses`, a matching list of `channels`, and one list of `values` per
walk — the same address at the same index in every walk. It is stored that way because the
plain form was five times the size for the same facts. `everyWalkSawEveryAddress` is true on
both, which is its own result: no address appeared or vanished across a restore.
