/**
 * The window, and whether it tells the truth.
 *
 * The watch panel is the only part of this tool a person looks at rather than reads, and
 * that makes it the easiest place for the tool to lie without anybody noticing: the terminal
 * can say "no answer from this run" while the window beside it says, in green, that
 * everything still works. Nothing failed. Both were produced by the same run. Only one of
 * them was true.
 *
 * So the sentences are what is tested here, not the plumbing. Four of them mattered enough
 * to be written down as their own case:
 *
 *   - the all-clear is NEVER said about a run that compared nothing;
 *   - the mode warning is said once, not twice;
 *   - a finding an agent has recorded as intended leaves the window, the way it leaves the
 *     terminal, instead of sitting there being a problem nobody has;
 *   - and every number on the page counts the same population, so two figures with the same
 *     words on them can never carry different numbers.
 *
 * WHY SOME OF THIS OPENS A BROWSER. The panel is a page: its headline is decided by script
 * running inside it, and checking that from the outside by reading the code that writes it
 * is exactly the mistake that let the all-clear survive. Those tests render the real page and
 * read the words out of it. There is no fake app and no real product anywhere — the events
 * are made here — and on a machine with no browser they skip, out loud, with the reason.
 *
 * Everything that is arithmetic or data — where the panel sits, what the mapper makes of an
 * engine event, what the screen guard counts — needs nothing at all and always runs.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { panelBounds } from '../../src/v2/watch/window.js';
import { panelHtml } from '../../src/v2/watch/panel.js';
import { makeMapper, trimVerdict, panelPlan, CLASS_WORDS, SURFACE_NOTES } from '../../src/v2/watch/events.js';
import { guardTheScreen, describeGuard } from '../../src/v2/watch/focus.js';

// ---------------------------------------------------------------------------
// Where the panel sits — arithmetic, so no window is opened for it
// ---------------------------------------------------------------------------

/** An ordinary desktop app window. */
const APP = { width: 1440, height: 900 };

/** @type {(app: any, watch: any) => {width: number, height: number, x: number, y: number}} */
const boundsFor = panelBounds;

describe('where the panel opens', () => {
  test('every part of the opening guess is a real number', () => {
    const bounds = boundsFor(APP, { side: 'right', width: 460 });
    for (const [key, value] of Object.entries(bounds)) {
      assert.equal(typeof value, 'number', `${key} is not a number`);
      assert.ok(Number.isFinite(value), `${key} is ${value}`);
    }
    assert.ok(bounds.width > 0 && bounds.height > 0, 'a panel with no size is not a panel');
  });

  test('THE SIDE IS THE PANEL\'S SIDE, not the app\'s', () => {
    // The flip this asserts is the whole of a bug that has been fixed once already. The
    // placement function underneath names the edge the APP is pinned to; the person typing
    // --watch-side is naming where they want the WINDOW. Passing one straight through as the
    // other puts the panel exactly where the person asked it not to be.
    const right = boundsFor(APP, { side: 'right', width: 460 });
    const left = boundsFor(APP, { side: 'left', width: 460 });

    assert.ok(right.x >= APP.width, `--watch-side right put the panel at ${right.x}, on top of an app 1440 wide`);
    assert.ok(left.x + left.width <= APP.width, `--watch-side left put the panel at ${left.x}, running across the app`);
    assert.ok(left.x < right.x, 'left is not to the left of right');
  });

  test('a width nobody could read is refused, and so is one nobody could fit', () => {
    assert.ok(boundsFor(APP, { side: 'right', width: 10 }).width > 10, 'a 10px panel was allowed');
    assert.ok(boundsFor(APP, { side: 'right', width: 99999 }).width < 99999, 'a panel wider than any screen was allowed');
  });

  test('it is as tall as the app unless it is told otherwise', () => {
    assert.equal(boundsFor(APP, { side: 'right' }).height, APP.height);
    assert.equal(boundsFor(APP, { side: 'right', height: 640 }).height, 640);
  });

  test('with nothing to sit beside it still lands somewhere usable', () => {
    const bounds = boundsFor(undefined, {});
    assert.ok(bounds.width > 0 && bounds.height > 0);
    assert.ok(Number.isFinite(bounds.x) && Number.isFinite(bounds.y));
  });
});

// ---------------------------------------------------------------------------
// The mapper — the engine's words turned into the window's
// ---------------------------------------------------------------------------

/**
 * Everything one engine event turned into.
 * @param {any} mapper
 * @param {any} event
 * @returns {any[]}
 */
function drawn(mapper, event) {
  return mapper.map(event);
}

describe('what the window is told about the run', () => {
  test('a verdict keeps whether it was an ANSWER, not only how many findings it had', () => {
    const trimmed = trimVerdict({ ok: false, findings: [], newlyUnstable: [], summary: 'NO ANSWER FROM THIS RUN.' });
    assert.equal(trimmed.ok, false, 'ok was dropped, which is how the window came to say everything was fine');
    assert.equal(trimmed.findings, 0);
    assert.equal(trimmed.newlyUnstable, 0);
  });

  test('and it keeps the count of what has newly stopped sitting still', () => {
    const trimmed = trimVerdict({
      ok: false,
      findings: [],
      newlyUnstable: [{ path: 'a' }, { path: 'b' }],
      summary: '',
    });
    assert.equal(trimmed.newlyUnstable, 2, 'a run that is not a pass, with no findings, and no way to say why');
  });

  test('trimming twice does not lose the numbers', () => {
    const once = trimVerdict({ ok: false, findings: [{ id: 'f1' }], newlyUnstable: [{ path: 'a' }], summary: 's' });
    const twice = trimVerdict(once);
    assert.deepEqual(
      { ok: twice.ok, findings: twice.findings, newlyUnstable: twice.newlyUnstable },
      { ok: false, findings: 1, newlyUnstable: 1 },
    );
  });

  test('the steadiness the ENGINE measured is the one that is drawn', () => {
    // The window used to work steady out as "everything watched, minus the unstable ones",
    // and those are two different populations: what the adapters wrote down is not the same
    // as the addresses the wobble was measured over. A walk that recorded the same address
    // twice therefore reported more addresses as having answered the same way twice than the
    // build had addresses to answer at.
    const mapper = makeMapper({});
    drawn(mapper, { type: 'journey:done', at: 1, journey: 'shop', count: 7 });
    drawn(mapper, { type: 'journey:done', at: 2, journey: 'buy', count: 7 });
    const [wobble] = drawn(mapper, { type: 'wobble', at: 3, count: 0, steady: 12, measured: true });
    assert.equal(wobble.wobble.steady, 12, 'the window drew its own guess over the measurement');
  });

  test('and when nothing said, the old guess still stands rather than nothing at all', () => {
    const mapper = makeMapper({});
    drawn(mapper, { type: 'journey:done', at: 1, journey: 'shop', count: 9 });
    const [wobble] = drawn(mapper, { type: 'wobble', at: 2, count: 2 });
    assert.equal(wobble.wobble.steady, 7);
    assert.equal(wobble.wobble.measured, true);
  });

  test('a wobble that was never TAKEN is not a wobble of nothing', () => {
    const mapper = makeMapper({});
    const [wobble] = drawn(mapper, { type: 'wobble', at: 1, count: 0, steady: 0, measured: false });
    assert.equal(wobble.wobble.measured, false, 'two noughts would read as good news, and it is not news at all');
  });

  test('the end names WHICH findings survived, not just how many', () => {
    const mapper = makeMapper({});
    const out = drawn(mapper, {
      type: 'check:done',
      at: 9,
      verdict: { ok: true, findings: [{ id: 'f2', title: 'the list gained a line' }], coverage: { paths: 3, journeys: 1 } },
    });
    const done = out.find((/** @type {any} */ e) => e.type === 'check:done');
    assert.deepEqual(done.findingIds, ['f2'], 'without the list there is no way to take a waived finding back');
  });

  test('an already-trimmed verdict names nobody, so a window cannot wipe its own list', () => {
    const mapper = makeMapper({});
    const out = drawn(mapper, { type: 'check:done', at: 9, message: 'done', panelVerdict: { ok: true, findings: 0 } });
    const done = out.find((/** @type {any} */ e) => e.type === 'check:done');
    assert.equal(done.findingIds, undefined);
  });

  test('an event from version one lands on the stream and is simply not drawn', () => {
    assert.deepEqual(makeMapper({}).map({ type: 'screen:done', at: 1 }), []);
    assert.deepEqual(makeMapper({}).map(null), []);
  });
});

// ---------------------------------------------------------------------------
// The page itself — one vocabulary, embedded, never re-typed
// ---------------------------------------------------------------------------

describe('the page the window draws', () => {
  test('it carries the words for a finding class rather than writing its own', () => {
    const html = panelHtml(panelPlan({ product: 'shop', journeys: [] }));
    for (const word of Object.values(CLASS_WORDS)) {
      assert.ok(html.includes(word), `the page cannot say "${word}", so it is keeping a second copy of the list`);
    }
  });

  test('and the line saying what "walked" meant on each surface', () => {
    const html = panelHtml(panelPlan({ product: 'shop', journeys: [] }));
    assert.ok(html.includes(SURFACE_NOTES.cli), 'the surface notes never reach the page');
    assert.ok(html.includes(SURFACE_NOTES.ios), 'the surface notes never reach the page');
  });

  test('a product name cannot break out of the page it is written into', () => {
    const html = panelHtml(panelPlan({ product: '</script><script>stop()</script>', journeys: [] }));
    assert.ok(!html.includes('<script>stop()'), 'a product name got out and became script');
  });
});

// ---------------------------------------------------------------------------
// The screen guard — come up once, then never come up again
// ---------------------------------------------------------------------------

describe('giving the screen back', () => {
  test('nothing is said to somebody who was never interrupted', () => {
    assert.equal(describeGuard({ handedBack: 0, yours: 'Terminal', ours: [], watching: true }), null);
  });

  test('and it counts, in words, when it did happen', () => {
    const once = describeGuard({ handedBack: 1, yours: 'Terminal', ours: [], watching: true }) ?? '';
    assert.ok(once.includes('once') && once.includes('Terminal'), once);
    const twice = describeGuard({ handedBack: 3, yours: 'Terminal', ours: [], watching: true }) ?? '';
    assert.ok(twice.includes('3 times'), twice);
  });

  test('what the tool opened is remembered, and can be added to after it starts', async () => {
    const guard = guardTheScreen({ claims: ['Terminal Deck'], look: async () => null });
    guard.claim('Simulator');
    assert.deepEqual(guard.report().ours.sort(), ['Simulator', 'Terminal Deck']);
    await guard.release();
    assert.equal(guard.report().watching, false);
    await guard.release();
  });

  test('the FIRST appearance is left alone; every one after it is handed straight back', async () => {
    /** @type {string[]} */
    const putBackTo = [];
    // The screen, scripted: the tool's app comes up first with nobody having chosen
    // anything yet, then the person picks their editor, and then the app pushes in front
    // again — which is the moment that is not allowed.
    const script = ['Terminal Deck', 'Terminal Deck', 'Code', 'Terminal Deck', 'Terminal Deck'];
    let at = 0;
    const guard = guardTheScreen({
      claims: ['Terminal Deck'],
      everyMs: 1,
      graceMs: 0,
      look: async () => script[Math.min(at++, script.length - 1)],
      putBack: async (name) => {
        putBackTo.push(name);
        return true;
      },
    });
    await waitFor(() => at >= script.length, 'the guard never looked at the screen');
    await guard.release();

    assert.ok(putBackTo.length >= 1, 'the app took the screen after the person had chosen and kept it');
    assert.deepEqual([...new Set(putBackTo)], ['Code'], 'the screen was given back to the wrong application');
    assert.equal(guard.report().yours, 'Code');
    assert.ok(guard.report().handedBack >= 1, 'handing the screen back was not counted');
  });

  test('an app that is in front before the person has chosen anything is never pushed away', async () => {
    /** @type {string[]} */
    const putBackTo = [];
    let looks = 0;
    const guard = guardTheScreen({
      claims: ['Terminal Deck'],
      everyMs: 1,
      graceMs: 0,
      look: async () => {
        looks += 1;
        return 'Terminal Deck';
      },
      putBack: async (name) => {
        putBackTo.push(name);
        return true;
      },
    });
    await waitFor(() => looks >= 4, 'the guard never looked at the screen');
    await guard.release();
    assert.deepEqual(putBackTo, [], 'the window was shoved away on the one appearance that is the whole point');
    assert.equal(guard.report().handedBack, 0);
  });
});

/**
 * Wait for something to become true, rather than sleeping and hoping.
 * @param {() => boolean} done
 * @param {string} what
 * @returns {Promise<void>}
 */
async function waitFor(done, what) {
  const until = Date.now() + 4000;
  while (!done()) {
    if (Date.now() > until) throw new Error(what);
    await new Promise((go) => setTimeout(go, 5));
  }
}

// ---------------------------------------------------------------------------
// The sentences on screen — these render the real page
// ---------------------------------------------------------------------------

/** One browser for the whole file, opened once and only if it is there. */
/** @type {any} */
let browser = null;
/** @type {string} */
let noBrowser = '';

before(async () => {
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    noBrowser = `no browser on this machine to render the panel in: ${e instanceof Error ? e.message : String(e)}`;
  }
});

after(async () => {
  if (browser) await browser.close();
});

/**
 * The real panel, with a real run pushed into it through the real mapper.
 *
 * @param {any[]} events    Engine events, exactly as `run.js` emits them.
 * @param {any} [plan]
 * @returns {Promise<{state: string, tone: string, what: string, counts: string, findings: number, steady: string, covered: string, close: () => Promise<void>}>}
 */
async function panelAfter(events, plan = { product: 'shop', journeys: [] }) {
  const page = await browser.newPage({ viewport: { width: 520, height: 1200 } });
  await page.setContent(panelHtml(panelPlan(plan)), { waitUntil: 'load' });
  const mapper = makeMapper(panelPlan(plan));
  for (const event of events) {
    for (const one of mapper.map(event)) {
      await page.evaluate((/** @type {any} */ e) => /** @type {any} */ (window).__staysfixed_push(e), one);
    }
  }
  const read = await page.evaluate(() => ({
    state: document.querySelector('.state')?.textContent ?? '',
    tone: document.querySelector('.state')?.className ?? '',
    what: document.querySelector('#what')?.textContent ?? '',
    counts: document.querySelector('#counts')?.textContent ?? '',
    findings: document.querySelectorAll('#findingList > *').length,
    // The figure counts up to its value over about a third of a second, so the number ON it
    // is whatever frame we caught. `data-n` is the value it is counting TO, set the moment
    // the figure is told, and reading it is what keeps this from being a test about timing.
    steady: document.querySelector('#wSteady')?.getAttribute('data-n') ?? document.querySelector('#wSteady')?.textContent ?? '',
    covered: document.querySelector('#covFigures')?.textContent ?? '',
  }));
  return { ...read, close: () => page.close() };
}

/**
 * A whole verdict, as the engine hands one over.
 * @param {any} over
 * @returns {any}
 */
function verdict(over = {}) {
  return {
    ok: true,
    mode: 'stored-record',
    summary: 'Nothing that worked has changed.',
    findings: [],
    newlyUnstable: [],
    differencesReal: 0,
    differencesNoise: 0,
    durationMs: 120,
    coverage: { paths: 4, journeys: 1, byChannel: {}, gaps: [] },
    ...over,
  };
}

describe('the sentence the window ends on', () => {
  test('a run that compared NOTHING never gets the all-clear', async (t) => {
    if (!browser) return t.skip(noBrowser);
    // The most dangerous sentence this tool can produce, said about the one run that proves
    // least. No findings, because nothing was compared with anything — and the headline was
    // picked from the finding count alone.
    const panel = await panelAfter([
      { type: 'check:start', at: 0 },
      {
        type: 'check:done',
        at: 50,
        verdict: verdict({
          ok: false,
          summary: 'NO ANSWER FROM THIS RUN. None of the 3 journeys could be put beside 1.0.0.',
        }),
      },
    ]);
    assert.ok(
      !panel.state.includes('Everything that worked still works'),
      `the window said "${panel.state}" about a run that compared nothing`,
    );
    assert.ok(panel.state.toLowerCase().includes('no answer'), `expected the terminal's own words, got "${panel.state}"`);
    assert.ok(!panel.tone.includes('held'), 'and it was drawn in the colour of a clean run');
    assert.ok(panel.what.includes('NO ANSWER FROM THIS RUN'), 'the reason never reached the window');
    await panel.close();
  });

  test('a run that really did compare, and found nothing, still gets it', async (t) => {
    if (!browser) return t.skip(noBrowser);
    const panel = await panelAfter([
      { type: 'check:start', at: 0 },
      { type: 'check:done', at: 50, verdict: verdict({ ok: true }) },
    ]);
    assert.equal(panel.state, 'Everything that worked still works.');
    await panel.close();
  });

  test('no findings and something newly unpredictable is not a pass either', async (t) => {
    if (!browser) return t.skip(noBrowser);
    const panel = await panelAfter([
      { type: 'check:start', at: 0 },
      {
        type: 'check:done',
        at: 50,
        verdict: verdict({ ok: false, newlyUnstable: [{ path: 'a' }, { path: 'b' }], summary: 'Nothing behaves differently, but 2 addresses...' }),
      },
    ]);
    assert.ok(!panel.state.includes('Everything that worked still works'), panel.state);
    assert.ok(panel.state.includes('2'), `the number of them is the point, and it is missing from "${panel.state}"`);
    await panel.close();
  });

  test('THE MODE WARNING IS SAID ONCE', async (t) => {
    if (!browser) return t.skip(noBrowser);
    // The engine already ends its summary with this sentence. The window pushed it again as
    // a caveat of its own, so every stored-record run — which is most of them — printed the
    // whole paragraph twice, one straight after the other.
    const warning = 'This run compared against the stored record from the last time the old build ran, not against the old build run live.';
    const panel = await panelAfter([
      { type: 'check:start', at: 0 },
      {
        type: 'check:done',
        at: 50,
        verdict: verdict({ modeWarning: warning, summary: `Nothing that worked has changed. ${warning}` }),
      },
    ]);
    assert.equal(panel.what.split(warning).length - 1, 1, `the warning appears ${panel.what.split(warning).length - 1} times`);
    await panel.close();
  });

  test('and it is still said when the engine left it out of the summary', async (t) => {
    if (!browser) return t.skip(noBrowser);
    const warning = 'This is a weaker check than usual.';
    const panel = await panelAfter([
      { type: 'check:start', at: 0 },
      { type: 'check:done', at: 50, verdict: verdict({ modeWarning: warning, summary: 'Nothing that worked has changed.' }) },
    ]);
    assert.ok(panel.what.includes(warning), 'dropping the duplicate dropped the warning itself');
    await panel.close();
  });

  test('A WAIVED FINDING LEAVES THE WINDOW', async (t) => {
    if (!browser) return t.skip(noBrowser);
    // Two verdicts reach the window on every run: the engine's, carrying everything it
    // found, and then the settled one from check.js with the differences an agent has
    // recorded as intended taken out. A finding used to only ever ARRIVE, so the window sat
    // there reporting a problem the terminal had already stopped reporting.
    const found = {
      id: 'f1',
      title: 'The list gained a line',
      class: 'ordinary',
      count: 1,
      differences: [{ path: 'cli.list.stdout', kind: 'changed', reference: 'a', candidate: 'b', journey: 'list' }],
    };
    const panel = await panelAfter([
      { type: 'check:start', at: 0 },
      { type: 'check:done', at: 40, verdict: verdict({ ok: false, findings: [found], summary: '1 thing behaves differently.' }) },
      { type: 'check:done', at: 45, verdict: verdict({ ok: true, findings: [], summary: '1 difference was recorded as intended earlier.' }) },
    ]);
    assert.equal(panel.findings, 0, 'the waived finding is still drawn beside a terminal that has stopped reporting it');
    assert.equal(panel.state, 'Everything that worked still works.');
    await panel.close();
  });

  test('a finding nobody waived stays exactly where it is', async (t) => {
    if (!browser) return t.skip(noBrowser);
    const found = {
      id: 'f1',
      title: 'The total says 9.99 where it said 10.00',
      class: 'money',
      count: 1,
      differences: [{ path: 'screen.checkout.total', kind: 'changed', reference: '10.00', candidate: '9.99' }],
    };
    const panel = await panelAfter([
      { type: 'check:start', at: 0 },
      { type: 'check:done', at: 40, verdict: verdict({ ok: false, findings: [found], summary: '1 thing behaves differently.' }) },
      { type: 'check:done', at: 45, verdict: verdict({ ok: false, findings: [found], summary: '1 thing behaves differently.' }) },
    ]);
    assert.equal(panel.findings, 1, 'a settled verdict that still names the finding took it away anyway');
    assert.ok(panel.state.includes('needs you') || panel.state.includes('need you'), panel.state);
    await panel.close();
  });

  test('ONE COUNT OF ADDRESSES ON THE PAGE, not two that disagree', async (t) => {
    if (!browser) return t.skip(noBrowser);
    // The header counts up as each journey reports in; the coverage ledger is the finished
    // tally. They used to be able to hold different numbers under the same words.
    const panel = await panelAfter([
      { type: 'check:start', at: 0 },
      { type: 'journey:done', at: 10, journey: 'shop', count: 7, message: '7 things looked at' },
      { type: 'journey:done', at: 20, journey: 'buy', count: 7, message: '7 things looked at' },
      { type: 'wobble', at: 25, count: 0, steady: 12, measured: true, message: 'This build gives the same answer twice, everywhere.' },
      { type: 'check:done', at: 50, verdict: verdict({ coverage: { paths: 12, journeys: 2, byChannel: {}, gaps: [] } }) },
    ]);
    assert.ok(panel.counts.includes('12'), `the header says "${panel.counts}" where the ledger counted 12`);
    assert.ok(!panel.counts.includes('14'), `the header kept its own running total: "${panel.counts}"`);
    assert.equal(panel.steady, '12', 'the wobble figure disagrees with both of them');
    await panel.close();
  });
});

// ---------------------------------------------------------------------------

/**
 * The report may not be squeezed out of the window by the findings.
 *
 * Found on 2026-09-01 by the owner watching a real run finish, and confirmed by measuring
 * the live window rather than by reading the CSS. His words: "some things like popups hides
 * the full details at the end", and "its not showing detailings".
 *
 * WHAT WAS ACTUALLY HAPPENING. The footer holding "Needs a person" was `flex: 0 0 auto` with
 * nothing capping it, so its height was however many things needed a person. A run that
 * found seventeen grew it past the height of the whole panel, and the scrolling body — the
 * walk, every journey and its address count, the wobble, what survived, what was NOT checked
 * — was squeezed to EIGHTEEN PIXELS holding 41,115 of content. Measured on the running
 * window: clientHeight 18, scrollHeight 41115. At the moment a check finished, everything it
 * had spent four minutes drawing collapsed into one clipped line of text.
 *
 * AND THE OVER-CORRECTION, which is why this test measures both ends. Letting the footer
 * shrink instead (`flex: 0 1 auto`) moved the same bug rather than fixing it: the body took
 * every pixel and the footer collapsed to its label, so seventeen sealed findings rendered
 * at ZERO height — the detail lost again, from the other side. Measured the same way:
 * footer 36px, list 0px, seventeen rows in it.
 *
 * So the rule this holds is both halves at once, at the sizes that actually broke: with a
 * long list of findings on screen, the body still shows a heading and rows under it, AND the
 * findings list is still visible and scrolls inside its own box.
 */
describe('the findings and the report share the window', () => {
  /**
   * @param {number} count how many things need a person
   * @returns {Promise<{body: number, foot: number, listSeen: number, listAll: number, rows: number, close: () => Promise<void>}>}
   */
  async function withFindings(count) {
    // The height that broke it. A shorter window would hide the bug by never filling.
    const page = await browser.newPage({ viewport: { width: 480, height: 952 } });
    await page.setContent(panelHtml(panelPlan({ product: 'shop', journeys: [] })), { waitUntil: 'load' });
    const read = await page.evaluate((n) => {
      const foot = /** @type {HTMLElement} */ (document.getElementById('footer'));
      const needs = /** @type {HTMLElement} */ (document.getElementById('needs'));
      // A FULL BODY, because an empty one hides the bug. The live window had 41,914px of
      // walk in it, and it is that content pushing from below that made the flex row give
      // the footer everything. Measured against an almost-empty body, the broken CSS and
      // the fixed CSS return the same numbers and the test proves nothing.
      const body = /** @type {HTMLElement} */ (document.querySelector('.scroll'));
      const filler = document.createElement('div');
      filler.style.height = '41914px';
      body.appendChild(filler);
      foot.hidden = false;
      needs.textContent = '';
      for (let i = 0; i < n; i++) {
        const row = document.createElement('div');
        row.className = 'need';
        row.innerHTML =
          '<span class="dot glyph"></span><span class="needtext">In the doors the code opens, "SessionBar' + i +
          '" is there now and was not before. It says "a class with createElement, start, noteOutput, destroy, ' +
          'receive, as" and more.<span class="needwhy">It touches losing data.</span></span>';
        needs.appendChild(row);
      }
      return {
        body: body.clientHeight,
        foot: foot.offsetHeight,
        listSeen: needs.clientHeight,
        listAll: needs.scrollHeight,
        rows: needs.children.length,
      };
    }, count);
    return { ...read, close: () => page.close() };
  }

  test('seventeen findings do not squeeze the report to a slit', async (t) => {
    if (!browser) return t.skip(noBrowser);
    const m = await withFindings(17);
    assert.equal(m.rows, 17);
    // 18px was the measured failure. A heading plus a few rows needs three figures.
    assert.ok(m.body >= 132, `the report was squeezed to ${m.body}px by ${m.rows} findings`);
    await m.close();
  });

  test('and the findings themselves are still on screen', async (t) => {
    if (!browser) return t.skip(noBrowser);
    const m = await withFindings(17);
    assert.ok(m.listSeen > 100, `seventeen things need a person and the list is ${m.listSeen}px tall`);
    assert.ok(m.listAll > m.listSeen, 'a list taller than its box has to be the one that scrolls');
    await m.close();
  });

  test('forty findings change neither answer', async (t) => {
    if (!browser) return t.skip(noBrowser);
    const many = await withFindings(40);
    assert.ok(many.body >= 132, `the report was squeezed to ${many.body}px by ${many.rows} findings`);
    assert.ok(many.listSeen > 100, `the list of forty is ${many.listSeen}px tall`);
    // The footer is capped, so twice the findings must not mean a taller footer.
    const some = await withFindings(17);
    assert.equal(many.foot, some.foot, 'the footer is still growing with the number of findings');
    await many.close();
    await some.close();
  });
});
