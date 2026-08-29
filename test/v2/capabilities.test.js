/**
 * What this machine can check, and — much more importantly — what it cannot.
 *
 * The requirement these tests exist for is the fourth state in the design: a
 * project where only some surfaces work is still useful, but it must say plainly
 * "this covers your website; your desktop app is not being checked and here is
 * why", rather than reporting a green run that quietly means less than it looks
 * like. A tool that over-claims its own coverage is worse than no tool, because
 * somebody believed it.
 *
 * So the tests here are mostly about honesty rather than about function:
 *
 *   - nothing is called covered that is not covered
 *   - nothing is offered to a person that they cannot do anything about
 *   - nothing already working is presented as something to go and set up
 *   - and a check aimed at a web page or a desktop app that does not confirm it
 *     went there says so before it says anything else
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { capabilities, describeCapabilities } from '../../src/v2/doctor.js';
import { surveyBrowsers, INSTALL_COMMAND } from '../../src/v2/browsers.js';
import { toolDefinitions, callTool, aimingNote } from '../../src/v2/mcp/tools.js';

/** Every probe doctor makes, on a laptop that may be busy. */
const SURVEY_MS = 60_000;

/** @type {import('../../src/v2/doctor.js').Capabilities} */
let caps;

describe('what this machine can check', () => {
  before(async () => {
    // Offline: the point of these tests is the local survey, and dialling every
    // host in somebody's ssh config makes them slow and makes them depend on
    // whether a server happened to be awake.
    caps = await capabilities({ cwd: process.cwd(), offline: true });
  });

  test('every surface reports one of the four states, and says who has to act', { timeout: SURVEY_MS }, () => {
    const states = ['ready', 'the agent can fix this', 'only a person can do this', 'not possible here'];
    for (const surface of caps.surfaces) {
      assert.ok(states.includes(surface.state), `${surface.id} reported a state nobody defined: ${surface.state}`);
      assert.ok(surface.summary.length > 0, `${surface.id} has to say something a person can read`);

      if (surface.state === 'not possible here') {
        // The fourth state is the one that matters, and its whole job is to stop
        // offering. A list of things to install here would be asking somebody to
        // do work that changes nothing.
        assert.equal(surface.needs.length, 0, `${surface.id} is not possible here, so it must not hand anybody a to-do list`);
        assert.ok((surface.instead ?? surface.summary).length > 0, `${surface.id} has to say what to do instead`);
      }
      if (surface.state === 'the agent can fix this') {
        assert.ok(surface.needs.length > 0, `${surface.id} says the agent can fix it, so there has to be something to fix`);
        for (const need of surface.needs) {
          assert.equal(need.automatic, true, `${surface.id} cannot be agent-fixable while "${need.what}" needs a person`);
          assert.ok(need.fix.length > 0, `"${need.what}" has to come with the exact thing to run`);
        }
      }
      if (surface.state === 'only a person can do this') {
        assert.ok(surface.needs.some((n) => !n.automatic), `${surface.id} says it needs a person, so at least one need has to actually need one`);
        for (const need of surface.needs) {
          assert.ok(need.why.length > 0, `a person is being asked for "${need.what}" and has not been told why`);
        }
      }
    }
  });

  test('nothing already working is presented as something to set up', () => {
    // Detect, never ask. Every entry in nextSteps had to fail a real probe.
    const working = new Set(caps.tools.filter((t) => t.found).map((t) => t.name));
    for (const step of caps.nextSteps) {
      assert.equal(working.has(step.what), false, `${step.what} is already here, so it must never be listed as something to go and get`);
    }
    for (const surface of caps.surfaces) {
      if (surface.status === 'ready') assert.equal(surface.needs.length, 0, `${surface.id} is ready, so there is nothing left to ask for`);
    }
  });

  test('a surface nothing can unlock is never turned into a next step', () => {
    const dead = new Set(caps.surfaces.filter((s) => s.state === 'not possible here').map((s) => s.id));
    for (const surface of caps.surfaces) {
      if (!dead.has(surface.id)) continue;
      for (const need of surface.needs) {
        assert.equal(caps.nextSteps.some((s) => s.what === need.what), false, `${need.what} came from a surface that cannot be unlocked here`);
      }
    }
  });

  test('the coverage statement never claims a surface that is not covered', () => {
    const ready = caps.surfaces.filter((s) => s.status === 'ready').map((s) => s.name);
    const partial = caps.surfaces.filter((s) => s.status === 'partial').map((s) => s.name);
    const out = caps.surfaces.filter((s) => s.status === 'unavailable').map((s) => s.name);

    assert.deepEqual([...caps.covers.covered].sort(), [...ready].sort(), 'only what works in full may be called covered');
    assert.deepEqual(caps.covers.partly.map((p) => p.name).sort(), [...partial].sort(), 'a partly-covered surface has to be named as partly covered, not folded in with the rest');
    assert.deepEqual(caps.covers.notCovered.map((p) => p.name).sort(), [...out].sort());

    for (const name of out) {
      assert.ok(caps.covers.short.includes(name), `"${name}" is not being checked at all and the sentence a person reads never mentions it`);
    }
    assert.equal(caps.covers.everything, out.length === 0 && partial.length === 0);
    if (out.length > 0) {
      assert.match(caps.covers.short, /does NOT check/, 'the words that stop a clean result being over-read have to be in there');
    }
    for (const gap of caps.covers.notCovered) {
      assert.ok(gap.why.length > 0, `"${gap.name}" is not covered and nobody has been told why`);
    }
  });

  test('the same words reach a person and an agent', () => {
    const said = describeCapabilities(caps).join('\n');
    assert.ok(said.includes(caps.covers.short), 'the honest sentence must not be something only the JSON gets');
    assert.ok(said.includes(caps.browsers.note), 'and neither may the browser it is about to open');
  });

  test('it says what it will do to this machine while it runs', () => {
    assert.ok(caps.browsers.neverTouches.length >= 3);
    const promises = caps.browsers.neverTouches.join(' ');
    assert.match(promises, /9333/, 'the port another session owns is named, not just implied');
    assert.match(promises, /throwaway/, 'and the profile promise is spelled out');
    assert.match(caps.browsers.leftovers, /staysfixed browsers --clean/, 'and there is a way out when a run dies mid-flight');
  });

  test('a desktop app needs no browser, and the answer no longer pretends it does', () => {
    // Version 1 said Electron was unavailable without Chrome. It was simply wrong:
    // a desktop app is its own Chromium and opens its own debugging port. Somebody
    // with a perfectly checkable app was being told to go and install a browser.
    const electron = caps.surfaces.find((s) => s.id === 'electron');
    assert.ok(electron);
    const asks = [electron.summary, ...electron.needs.map((n) => `${n.what} ${n.why} ${n.fix}`)].join(' ');
    assert.equal(/install (google )?chrome|install chromium/i.test(asks), false, 'nothing about a desktop app may ask for a browser');
  });

  test('the web surface is only "ready" when it has a browser of its own', { timeout: SURVEY_MS }, async () => {
    // Simulated by hiding the downloaded test browsers: his own Chrome lives at an
    // absolute path and is still found, which is the exact machine being described.
    const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'staysfixed-nohome-'));
    const realHome = process.env.HOME;
    const realCache = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.HOME = empty;
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(empty, 'no-browsers-here');
    try {
      // Prime the survey with the machine we are pretending to be on; capabilities
      // reuses it rather than asking the machine a second time.
      const bare = await surveyBrowsers({ refresh: true });
      const bareCaps = await capabilities({ cwd: process.cwd(), offline: true });
      const web = bareCaps.surfaces.find((s) => s.id === 'web');
      assert.ok(web);

      if (bare.chosen === null) {
        assert.equal(web.status, 'unavailable', 'with no browser at all a web page cannot be opened, and saying otherwise would be a lie');
        return;
      }
      assert.equal(bare.borrowingHis, true);
      assert.equal(web.status, 'partial', 'borrowing the browser he uses is not the same as being ready, and calling it ready is how the machine gets quietly worse');
      assert.equal(web.state, 'the agent can fix this');
      assert.equal(web.needs[0].fix, INSTALL_COMMAND);
      assert.equal(bareCaps.covers.covered.includes(web.name), false, 'and it must not be listed as covered in full');
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      if (realCache === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = realCache;
      await surveyBrowsers({ refresh: true });
    }
  });
});

describe('aiming a check at a web page or a desktop app', () => {
  test('the tool an agent reads says how to aim it', () => {
    const check = toolDefinitions().find((t) => t.name === 'staysfixed_check');
    assert.ok(check);
    const surface = check.inputSchema.properties.surface;
    assert.ok(surface, 'there has to be a way to say which kind of product to look at');
    assert.deepEqual(surface.enum, ['auto', 'cli', 'server', 'web', 'electron']);
    assert.match(surface.description, /never yours/, 'an agent should learn from the schema that this does not borrow the person’s browser');
    assert.ok(check.inputSchema.properties.at, 'and a way to say where: a URL, or the built app');
  });

  test('capabilities explains both new surfaces without being asked twice', { timeout: SURVEY_MS }, async () => {
    const ctx = { root: process.cwd(), cwd: process.cwd(), version: '2.0.0-test', protocolVersion: '2025-06-18' };
    const said = (await callTool('staysfixed_capabilities', { detail: 'full', offline: true }, ctx)).content[0];
    assert.equal(said.type, 'text');
    const text = /** @type {{text: string}} */ (said).text;
    assert.match(text, /surface: 'web'/, 'the aiming instructions have to be in the first call an agent makes');
    assert.match(text, /surface: 'electron'/);
    assert.match(text, /one after the other, never at once/, 'the sequential rule is a property of the tool and an agent should know it without reading the source');
    assert.ok(text.includes(caps.covers.short), 'and the honest coverage sentence goes to the agent too, word for word');
  });

  test('a run that does not confirm it went where it was aimed says so first', () => {
    // The dangerous shape: an engine that does not understand the option ignores
    // it, checks something else, and hands back a perfectly clean result.
    const silent = aimingNote('web', 'http://localhost:3000', undefined);
    assert.ok(silent, 'a result that says nothing about a target cannot be treated as having hit one');
    assert.match(silent, /DID NOT CONFIRM/);
    assert.match(silent, /saying NOTHING about what you aimed at/);

    const wrongPlace = aimingNote('web', 'http://localhost:3000', { surface: 'cli' });
    assert.ok(wrongPlace);
    assert.match(wrongPlace, /it checked cli/);

    const wrongUrl = aimingNote('web', 'http://localhost:3000', { surface: 'web', at: 'http://localhost:4000' });
    assert.ok(wrongUrl, 'the right kind of product at the wrong address is still the wrong answer');
  });

  test('a run that did go where it was aimed says nothing extra', () => {
    assert.equal(aimingNote('web', 'http://localhost:3000', { surface: 'web', at: 'http://localhost:3000' }), null);
    assert.equal(aimingNote('electron', null, { surface: 'electron' }), null);
    // Nothing was asked for, so there is nothing to confirm and nothing to warn about.
    assert.equal(aimingNote(null, null, undefined), null);
  });
});
