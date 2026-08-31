/**
 * Can a phone be compared the strong way?
 *
 * The strongest thing this tool does is a PAIRED run: the old build is put back on the
 * machine and walked minutes before the new one, so nothing that drifted in between can be
 * mistaken for somebody's change. Every other surface has had it. Phones did not, and the
 * reason written into both adapters was that nobody had ever proven a device comes back to
 * the same place after being put back. That was a guess, and a guess is a strange thing to
 * find at the bottom of a tool whose whole promise is that it never says "fine" without
 * having looked.
 *
 * It was measured on 2026-08-31 — the numbers and the machine are in
 * `fixtures/phone-restores/README.md` — and these tests are that measurement, kept, so it
 * cannot quietly stop being true. NOTHING HERE NEEDS A PHONE. Every test below runs the real
 * arithmetic the engine runs, over captures taken from a real emulator and a real simulator
 * and written down.
 *
 * The four questions, in order:
 *
 *   1. Do two restores of ONE build agree? (The measurement itself.)
 *   2. Where they do not, does the tool's own wobble subtraction take care of it? (The
 *      decision. If the answer were no, paired mode would be a false-alarm machine, which is
 *      the same failure as a false all-clear by a slower road.)
 *   3. Do the adapters now SAY what was measured, instead of implying nobody knows?
 *   4. And the danger that comes with switching paired on: an app bundle and an APK are
 *      build outputs, so the settings usually point at an absolute path — and an absolute
 *      path does not move when the old commit is checked out somewhere else. Both halves
 *      would read one file, find nothing different, and the run would report the tool's
 *      all-clear sentence about a comparison that never happened. That has to be caught and
 *      said on every journey, including the one that needs no device at all.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { diffCaptures, measureWobble, subtractWobble } from '../../src/v2/observation.js';
import { androidAdapter, referenceArtifact } from '../../src/v2/adapters/android.js';
import { iosAdapter, referenceBundle } from '../../src/v2/adapters/ios.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', '..', 'fixtures', 'phone-restores');

/**
 * One walk of a phone, out of the measurement, back in the shape the engine compares.
 *
 * The file keeps one list of addresses and one list of values per walk rather than four full
 * copies, because the plain form was five times the size for exactly the same facts.
 *
 * @param {any} fixture
 * @param {number} index
 * @returns {import('../../src/v2/types.js').Observation[]}
 */
function walk(fixture, index) {
  const row = fixture.walks[index];
  return fixture.addresses.map((/** @type {string} */ p, /** @type {number} */ i) => ({
    path: p,
    channel: fixture.channels[i],
    value: row.values[i],
    meta: {},
  }));
}

/** @param {string} name */
async function load(name) {
  return JSON.parse(await fsp.readFile(path.join(fixtures, name), 'utf8'));
}

const android = await load('android-four-restores.json');
const ios = await load('ios-four-restores.json');

describe('a phone put back twice comes back to the same place', () => {
  test('iOS: every address the simulator answered agreed across two restores', () => {
    // 725 addresses, twice, with the app removed and every permission taken back in between.
    // This is the whole measurement in one line, and it is the reason paired mode is offered
    // on iOS at all. If this ever fails, the sentence in ios.js is no longer true and has to
    // come out along with paired mode.
    assert.equal(ios.addresses.length, 725, 'the measurement was taken over 725 addresses');
    for (const [a, b] of [[0, 1], [2, 3]]) {
      const differences = diffCaptures(walk(ios, a), walk(ios, b));
      assert.deepEqual(
        differences.map((d) => d.path),
        [],
        `walks ${a} and ${b} of ONE iPhone build disagreed, which is what "a paired run is offered here" says cannot happen`,
      );
    }
  });

  test('Android: the only disagreement is the app arguing with itself, never the snapshot', () => {
    assert.equal(android.addresses.length, 309, 'the measurement was taken over 309 addresses');
    for (const [a, b] of [[0, 1], [2, 3]]) {
      const differences = diffCaptures(walk(android, a), walk(android, b));
      // Eight, and all eight are one thing seen at eight checkpoints: the identity code this
      // app makes fresh for itself every time it is installed. Named here rather than counted,
      // because "eight differences" is a number somebody could meet again for a completely
      // different reason and wave through.
      assert.equal(differences.length, 8, `walks ${a} and ${b} disagreed at ${differences.length} addresses, not the eight that were measured`);
      for (const d of differences) {
        assert.match(d.path, /TextView#12/, `${d.path} disagreed, and the measurement says the only thing that moves on its own is the app's own identity code`);
        assert.match(
          String(d.reference),
          /^[A-Z0-9]{4}(-[A-Z0-9]{4}){5}$/,
          'the value that moved should be a freshly-made identity code, not something about the device',
        );
      }
    }
  });

  test('nothing appeared and nothing vanished across a restore', () => {
    // Kept apart from the value comparison above on purpose. A changed value is the ordinary
    // kind of noise; an address that EXISTS after one restore and not after the next is a
    // different and much worse thing, because in a real comparison it reads as a door that
    // opened or closed. Neither device did it once.
    for (const fixture of [android, ios]) {
      assert.equal(fixture.everyWalkSawEveryAddress, true, `${fixture.what} — some walk saw a different set of addresses`);
    }
  });
});

describe('the wobble the tool already subtracts covers what is left', () => {
  test('Android: a paired run over two restores reports nothing as a real change', () => {
    // This is the decision, run as arithmetic rather than argued.
    //
    // A paired run walks the new build twice, measures what it cannot answer the same way
    // twice, and subtracts exactly those addresses before reporting anything. So: take two
    // restores as the new build's own two runs, take a third as the old build, compare, and
    // subtract. If anything survives, paired mode on Android is a false-alarm machine — which
    // is the same failure as a false all-clear, reached by a slower road.
    const wobble = measureWobble(walk(android, 2), walk(android, 3));
    assert.equal(wobble.unstable.length, 8, 'the new build should be seen arguing with itself at the eight identity-code addresses');

    const differences = diffCaptures(walk(android, 0), walk(android, 2));
    assert.ok(differences.length > 0, 'the raw comparison should have something in it, or this test is proving nothing');

    const settled = subtractWobble(differences, wobble, { referenceBuildId: 'the-build-you-shipped', candidateBuildId: 'the-build-you-have' });
    assert.deepEqual(
      settled.real.map((d) => d.path),
      [],
      'something survived the wobble subtraction, so a paired Android run would report a change nobody made',
    );
    assert.equal(settled.noise.length, differences.length, 'every difference should be accounted for as noise, not quietly dropped');
  });

  test('iOS: there is not even anything to subtract', () => {
    const wobble = measureWobble(walk(ios, 2), walk(ios, 3));
    assert.deepEqual(wobble.unstable, [], 'the iPhone build answered every address the same way twice');
    const differences = diffCaptures(walk(ios, 0), walk(ios, 2));
    const settled = subtractWobble(differences, wobble, { referenceBuildId: 'the-build-you-shipped', candidateBuildId: 'the-build-you-have' });
    assert.deepEqual(settled.real.map((d) => d.path), [], 'a paired iPhone run over two restores of one build should report nothing');
  });

  test('the subtraction is not just swallowing everything', () => {
    // The test above would pass just as happily if `subtractWobble` threw every difference
    // away, and a test that cannot fail is worse than no test. So: change one address that
    // the measurement says is steady, and check it comes through as a real change.
    const wobble = measureWobble(walk(android, 2), walk(android, 3));
    const changed = walk(android, 2).map((o) => (/TextView#1\.says/.test(o.path) ? { ...o, value: 'Something Else Entirely' } : o));
    const differences = diffCaptures(walk(android, 0), changed);
    const settled = subtractWobble(differences, wobble, { referenceBuildId: 'old', candidateBuildId: 'new' });
    assert.ok(
      settled.real.some((d) => /TextView#1\.says/.test(d.path)),
      'a real change at a steady address was subtracted away as noise, which would make paired mode useless',
    );
  });
});

describe('the adapters say what was measured, not that nobody knows', () => {
  test('neither adapter still calls this unproven', async () => {
    for (const file of ['android.js', 'ios.js']) {
      const source = await fsp.readFile(path.join(here, '..', '..', 'src', 'v2', 'adapters', file), 'utf8');
      // Read as one flat string on purpose. These are the words the old guess was written in,
      // and any of them coming back means somebody has restored the guess.
      assert.doesNotMatch(source, /snapshots? restore identically is (still )?unproven/i, `${file} still says the restore is unproven`);
      assert.doesNotMatch(source, /a paired run is not offered/i, `${file} still says a paired run is not offered`);
    }
  });

  test('both adapters carry the date, the device and the numbers where a person will meet them', async () => {
    // In `detect`'s notes, not only in a comment at the top of the file. The notes are what
    // `doctor` prints and what an agent reads; a fact that only exists in a comment is a fact
    // no user of this tool ever sees.
    const androidNotes = ((await androidAdapter.detect({ root: path.join(here, '..', '..'), config: {} })).notes ?? []).join(' ');
    assert.match(androidNotes, /2026-08-31/, 'the Android notes should say when this was measured');
    assert.match(androidNotes, /301 of 309/, 'the Android notes should carry the number a person can act on');
    assert.match(androidNotes, /"reference"/, 'the Android notes should name the setting that makes a paired run possible');

    const iosNotes = ((await iosAdapter.detect({ root: path.join(here, '..', '..'), config: {} })).notes ?? []).join(' ');
    assert.match(iosNotes, /2026-08-31/, 'the iPhone notes should say when this was measured');
    assert.match(iosNotes, /725 of 725/, 'the iPhone notes should carry the number a person can act on');
    assert.match(iosNotes, /"reference"/, 'the iPhone notes should name the setting that makes a paired run possible');
  });
});

describe('a paired run needs two builds, and it says so when it only had one', () => {
  test('the settings can name where the old build kept its package', () => {
    // Two spellings, because both read naturally. The point of the setting is that an APK and
    // a .app are BUILD OUTPUTS: a checkout of the old commit does not contain one, so without
    // somewhere to point, the old half of a paired run has no app to walk at all.
    assert.equal(referenceArtifact({ reference: 'builds/0.14.0.apk' }), 'builds/0.14.0.apk');
    assert.equal(referenceArtifact({ reference: { apk: 'builds/0.14.0.apk' } }), 'builds/0.14.0.apk');
    assert.equal(referenceArtifact({}), undefined);
    assert.equal(referenceArtifact({ reference: '   ' }), undefined, 'an empty setting is not an answer');
    assert.equal(referenceArtifact({ reference: { app: 'wrong-platform.app' } }), undefined, 'the iPhone spelling is not an Android package');

    assert.equal(referenceBundle({ reference: 'builds/0.14.0/App.app' }), 'builds/0.14.0/App.app');
    assert.equal(referenceBundle({ reference: { app: 'builds/0.14.0/App.app' } }), 'builds/0.14.0/App.app');
    assert.equal(referenceBundle({}), undefined);
    assert.equal(referenceBundle({ reference: '   ' }), undefined, 'an empty setting is not an answer');
    assert.equal(referenceBundle({ reference: { apk: 'wrong-platform.apk' } }), undefined, 'the Android spelling is not an app bundle');
  });

  test('Android: one package compared against itself is a hole on every journey', async () => {
    // NOTHING HERE NEEDS AN EMULATOR, and the file the settings point at is not even a real
    // package — it is one of the measurement fixtures. That is on purpose. The same-file
    // question is answered from the PATH, before the package is opened, so it goes on being
    // answered on a machine that cannot open it, on a build that cannot be got ready, and on
    // the one journey that needs no device at all. Every one of those is a road to the same
    // clean, confident, meaningless all-clear.
    const root = path.join(here, '..', '..');
    const config = { apk: path.join(root, 'fixtures', 'phone-restores', 'android-four-restores.json') };
    const ctx = { scratchDir: await scratch(), evidenceDir: await scratch(), seed: 1, clock: '2026-08-31T09:00:00.000Z', config, log: () => {} };
    try {
      const candidate = await androidAdapter.prepare({ id: 'c', label: 'the build you have', role: 'candidate', root }, ctx);
      const reference = await androidAdapter.prepare({ id: 'r', label: 'the build you were happy with', role: 'reference', root }, ctx);

      assert.equal(reference.facts?.paired, false, 'the old half read the same file as the new half and did not say so');
      assert.notEqual(candidate.facts?.paired, false, 'the new build is not the half this question is about');
      assert.match(String(reference.why), /same file/i, 'the reason has to be in the sentence a person reads, not only in a fact nobody prints');

      for (const journey of await androidAdapter.journeys({ root, config })) {
        const observations = await androidAdapter.run(journey, reference, ctx);
        const said = observations.filter((o) => o.path.endsWith('which build this was'));
        assert.equal(said.length, 1, `"${journey.name}" did not carry the warning that both halves were one file`);
        assert.equal(said[0].meta?.refused, true, 'it has to be a hole in the coverage, never a passing observation');
        assert.match(String(said[0].meta?.describe), /"reference"/, 'it should name the setting that fixes it');
      }

      // And the new build's own journeys stay clean, because there is nothing wrong with them.
      for (const journey of await androidAdapter.journeys({ root, config })) {
        const observations = await androidAdapter.run(journey, candidate, ctx);
        assert.equal(observations.filter((o) => o.path.endsWith('which build this was')).length, 0, 'the warning belongs on the old half, not on both');
      }

      await reference.dispose();
      await candidate.dispose();
    } finally {
      await androidAdapter.teardown();
    }
  });

  test('the warning is the same on the tenth journey as on the first', async () => {
    // The engine does not prepare two builds and keep them. It prepares one, walks ONE
    // journey against it, throws it away, and does it all again for the next journey — new
    // build twice, old build twice, four preparations per journey. So the memory of which
    // file each half read outlives every one of them, and a rule written as "was this the
    // same file as the other half" flags the NEW build from the second journey onwards,
    // because the previous journey's old half is still sitting in the map. Absent on journey
    // one, doubled on journey two: that reads as a bug in the tool rather than a fact about
    // the run, and it is the one this test stands over.
    const root = path.join(here, '..', '..');
    const config = { apk: path.join(root, 'fixtures', 'phone-restores', 'android-four-restores.json') };
    const ctx = { scratchDir: await scratch(), evidenceDir: await scratch(), seed: 1, clock: '2026-08-31T09:00:00.000Z', config, log: () => {} };
    const journeys = await androidAdapter.journeys({ root, config });
    /** @type {{journey: string, role: string, warnings: number}[]} */
    const seen = [];
    try {
      for (let round = 0; round < 3; round += 1) {
        for (const journey of journeys) {
          for (const role of /** @type {const} */ (['candidate', 'candidate', 'reference', 'reference'])) {
            const id = `${round}-${journey.name}-${role}-${seen.length}`;
            const prepared = await androidAdapter.prepare({ id, label: role, role, root }, ctx);
            const observations = await androidAdapter.run(journey, prepared, ctx);
            seen.push({ journey: `${journey.name} (round ${round + 1})`, role, warnings: observations.filter((o) => o.path.endsWith('which build this was')).length });
            await prepared.dispose();
          }
        }
      }
    } finally {
      await androidAdapter.teardown();
    }
    for (const row of seen) {
      assert.equal(
        row.warnings,
        row.role === 'reference' ? 1 : 0,
        `on "${row.journey}" the ${row.role} half carried ${row.warnings} warnings — it should be one on the old build and none on the new one, on every journey`,
      );
    }
    assert.ok(seen.length >= 8, 'this needs at least two rounds of the whole cycle to say anything at all');
  });

  test('iOS: one app bundle compared against itself is a hole on every journey', async () => {
    const root = path.join(here, '..', '..');
    const home = await scratch();
    const app = path.join(home, 'Pretend.app');
    await fsp.mkdir(app, { recursive: true });
    // Enough to be found as an app bundle and no more. What happens after it is found — can
    // this Mac open it, is there a simulator — is not what this test is about, and must not
    // be what decides whether the warning gets said.
    await fsp.writeFile(path.join(app, 'Info.plist'), '<plist><dict></dict></plist>');
    const config = { app };
    const ctx = { scratchDir: await scratch(), evidenceDir: await scratch(), seed: 1, clock: '2026-08-31T09:00:00.000Z', config, log: () => {} };
    try {
      const candidate = await iosAdapter.prepare({ id: 'c', label: 'the build you have', role: 'candidate', root }, ctx);
      const reference = await iosAdapter.prepare({ id: 'r', label: 'the build you were happy with', role: 'reference', root }, ctx);

      assert.equal(reference.facts?.paired, false, 'the old half read the same bundle as the new half and did not say so');
      assert.notEqual(candidate.facts?.paired, false, 'the new build is not the half this question is about');
      assert.match(String(reference.why), /same app bundle/i, 'the reason has to be in the sentence a person reads');

      for (const journey of await iosAdapter.journeys({ root, config })) {
        const observations = await iosAdapter.run(journey, reference, ctx);
        const said = observations.filter((o) => o.path.endsWith('which build this was'));
        assert.equal(said.length, 1, `"${journey.name}" did not carry the warning that both halves were one bundle`);
        assert.equal(said[0].meta?.refused, true, 'it has to be a hole in the coverage, never a passing observation');
        assert.match(String(said[0].meta?.describe), /"reference"/, 'it should name the setting that fixes it');
      }

      await reference.dispose();
      await candidate.dispose();
    } finally {
      await iosAdapter.teardown();
    }
  });
});

/** A throwaway folder outside the repo. Nothing a test does may land in `fixtures/`. */
async function scratch() {
  const os = await import('node:os');
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sfx-phones-'));
}
