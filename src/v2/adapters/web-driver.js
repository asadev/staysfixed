/**
 * Driving a browser, and reading what it means.
 *
 * This file knows about browsers and nothing about Stays Fixed. It opens a throwaway
 * Chromium, freezes the world inside it, walks the steps it is given, and hands back four
 * plain things: the meaning tree, the traffic, the complaints and a picture. `web.js` turns
 * those into observations. Keeping the split means the hard browser problems - which are
 * all timing problems - are solved in one place and read in one place.
 *
 * FOUR DECISIONS WORTH KNOWING ABOUT.
 *
 * 1. THE MEANING, NOT THE MARKUP. What is read is the accessibility tree - role, name,
 *    state - through Playwright's ARIA snapshot. The DOM is not read at all. A team that
 *    swaps a div for a section, renames a class or reorders two wrappers has changed
 *    nothing a person can perceive, and a tool that reports it has trained its owner to
 *    ignore it.
 *
 * 2. ADDRESSES THAT SURVIVE A REORDERING. A control is addressed by what it is and what it
 *    says - `button:Pay now` - inside the chain of landmarks and headings above it. Not by
 *    its position. Moving the whole "Randomness" section to the bottom of the page moves
 *    nothing, because the address never mentioned where the section was. Position is used
 *    only as a last resort, between things that are genuinely indistinguishable, and then
 *    only within the one section they share. This is the single most load-bearing choice in
 *    the file: everything downstream reads these addresses, and an address that moves when
 *    nothing did produces a page of differences nobody will ever read twice.
 *
 * 3. THE FREEZE COMES FIRST, THE WIRE COMES SECOND. `src/freeze/` is applied before a
 *    single byte of the app is fetched - frozen clock, killed motion, seeded randomness,
 *    pinned fonts, no outbound network. That is proven code and it is used exactly the way
 *    `src/picture/capture.js` uses it. On top of it sits one more layer this file owns: a
 *    refusal boundary that stops anything that spends money, sends a message or destroys
 *    data, records that it was ASKED for, and reports the refusal as a hole in the check.
 *    Both layers intercept, and they were measured working together rather than assumed to.
 *
 * 4. OUR OWN WINDOW, ALWAYS. Every walk gets a brand new profile folder under the scratch
 *    directory and is closed at the end of the walk. Nothing attaches to a browser somebody
 *    else started, nothing uses a fixed debugging port, nothing outlives the walk that
 *    opened it. Cookies and local storage cannot leak from one journey into the next, which
 *    matters more here than it looks: leaked state between journeys shows up as a
 *    difference, and a difference the tool caused itself is the worst kind of noise.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';

import { globToRegExp } from '../../freeze/network.js';

/** @typedef {import('../types.js').ObservedValue} JsonValue */

// ---------------------------------------------------------------------------
// Finding Playwright
// ---------------------------------------------------------------------------

/**
 * What a browser needs before it can be opened, and what to do when it is not there.
 *
 * @typedef {object} PlaywrightState
 * @property {boolean} ok              A browser can be opened right now.
 * @property {any} [chromium]          Playwright's chromium launcher, when there is one.
 * @property {string} [version]        Which Playwright.
 * @property {string} why              Plain English, filled in whether it worked or not.
 * @property {'installed'|'no package'|'no browser'} state
 * @property {string} [howToGet]       The exact command that fixes it.
 * @property {string} [executable]     Where the browser binary is, when it exists.
 */

/**
 * Find Playwright, in the two places it could honestly be.
 *
 * Stays Fixed is installed INTO other people's projects, so "is Playwright here" has two
 * different answers: is it beside us, and is it in the project we were pointed at. Both are
 * tried, because a project that already drives its own tests with Playwright should not be
 * asked to install a second copy.
 *
 * It is loaded with `import()` rather than named at the top of the file on purpose. A tool
 * that cannot start at all because an optional browser library is missing is a tool that
 * cannot tell you what is missing.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectRoot]  The project being checked. Looked in second.
 * @returns {Promise<PlaywrightState>}
 */
export async function loadPlaywright(opts = {}) {
  const install = 'npm install --save-dev playwright';
  /** @type {any} */
  let mod = null;
  /** @type {string|undefined} */
  let version;

  /** @param {any} loaded */
  const unwrap = (loaded) => (loaded && loaded.chromium ? loaded : (loaded?.default ?? null));

  try {
    mod = unwrap(await import('playwright'));
  } catch {
    // Not beside us. Try the project we were pointed at.
  }

  if (!mod && opts.projectRoot) {
    try {
      const require = createRequire(path.join(opts.projectRoot, 'package.json'));
      mod = unwrap(await import(require.resolve('playwright')));
    } catch {
      // Not there either. That is an answer, and it is reported as one.
    }
  }

  if (!mod?.chromium) {
    return {
      ok: false,
      state: 'no package',
      why: 'Playwright is not installed, so no web page can be opened. Everything read out of the source still works; nothing that needs a browser does.',
      howToGet: install,
    };
  }

  try {
    const require = createRequire(import.meta.url);
    version = String(require('playwright/package.json').version);
  } catch {
    // A version we cannot read is not a reason to refuse to run.
  }

  /** @type {string|undefined} */
  let executable;
  try {
    executable = String(mod.chromium.executablePath());
  } catch {
    executable = undefined;
  }

  const there = Boolean(executable) && (await exists(/** @type {string} */ (executable)));
  if (!there) {
    return {
      ok: false,
      state: 'no browser',
      chromium: mod.chromium,
      version,
      why: `Playwright ${version ?? ''} is installed but its browser has not been downloaded, so no page can be opened yet. This is one command and nobody has to be asked.`.trim(),
      howToGet: 'npx playwright install chromium',
      executable,
    };
  }

  return {
    ok: true,
    state: 'installed',
    chromium: mod.chromium,
    version,
    executable,
    why: `Playwright ${version ?? ''} is here and its Chromium is downloaded, so pages can be opened.`.trim(),
  };
}

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Opening a window
// ---------------------------------------------------------------------------

/**
 * One browser window, and everything hanging off it.
 *
 * @typedef {object} Window
 * @property {any} context            Playwright's browser context. Ours, always.
 * @property {any} page
 * @property {any} cdp                A debug-protocol session onto that page.
 * @property {any} handle             The page, in the shape `src/freeze/` expects.
 * @property {string} profileDir      The throwaway profile folder we made.
 * @property {() => Promise<void>} close
 */

/**
 * Open a browser window nobody else is using.
 *
 * Its own profile folder, under the scratch directory the engine handed us, thrown away
 * when the walk ends. No fixed debugging port, no attaching to something already running,
 * no reuse between journeys.
 *
 * @param {object} opts
 * @param {any} opts.chromium
 * @param {string} opts.scratchDir
 * @param {{width: number, height: number, deviceScaleFactor?: number}} [opts.viewport]
 * @param {'light'|'dark'} [opts.colorScheme]
 * @param {boolean} [opts.headed]     Open a window somebody can watch. Off by default.
 * @param {string} [opts.label]       Goes in the folder name, so a leftover folder explains itself.
 * @returns {Promise<Window>}
 */
export async function openWindow(opts) {
  const viewport = {
    width: opts.viewport?.width ?? 1280,
    height: opts.viewport?.height ?? 800,
  };
  const deviceScaleFactor = opts.viewport?.deviceScaleFactor ?? 1;
  const profileDir = path.join(opts.scratchDir, `browser-${safe(opts.label ?? 'walk')}-${Date.now().toString(36)}`);
  await fsp.mkdir(profileDir, { recursive: true });

  const context = await opts.chromium.launchPersistentContext(profileDir, {
    headless: opts.headed !== true,
    viewport,
    deviceScaleFactor,
    colorScheme: opts.colorScheme ?? 'light',
    // A window that asks about location, notifications or the camera stops dead waiting for
    // an answer nobody is there to give. Grant nothing, the same way every time.
    permissions: [],
    // A browser that restores a session, offers to save a password or runs an extension is
    // a browser whose screen depends on yesterday.
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars'],
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
  });

  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  await wakeDomains(cdp);
  const handle = pageHandleFor(page, cdp, null);

  return {
    context,
    page,
    cdp,
    handle,
    profileDir,
    close: async () => {
      // Only ever the window we opened. Somebody else's browser is somebody else's business.
      // Bounded, because closing is also a conversation with the browser and a browser that
      // has stopped answering must not be able to hold a whole check open. Closing it is
      // also what releases anything still waiting on it, so this goes first and always.
      await withLimit(context.close(), 15000, undefined);
      await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Switch on the parts of the debug protocol the freeze layer needs, before it is used.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE. `Page.addScriptToEvaluateOnNewDocument` accepts
 * a script and hands back an identifier whether or not the Page domain is switched on - and
 * if it is not, the script is remembered and never actually run. Nothing fails. Nothing is
 * logged. Every init script the freeze layer registers is accepted and silently ignored, so
 * the clock keeps ticking, randomness stays random, and animations keep animating, while
 * every line of code involved reports success.
 *
 * That was measured, not guessed: with this one call the fixture app's clock reads
 * 2026-08-29T09:00:00.000Z on every run and `Math.random` is the seeded generator; without
 * it the clock is the wall clock and `Math.random` is native, and the only visible symptom
 * is a suspiciously noisy run.
 *
 * @param {any} cdp
 * @returns {Promise<void>}
 */
export async function wakeDomains(cdp) {
  for (const domain of ['Page', 'Runtime']) {
    try {
      await cdp.send(`${domain}.enable`);
    } catch {
      // An older browser without one of these is still worth driving.
    }
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function safe(text) {
  return String(text).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'walk';
}

// ---------------------------------------------------------------------------
// The page, in the shape the freeze layer expects
// ---------------------------------------------------------------------------

/**
 * Wait for something, but never for ever.
 *
 * Every promise in this file that crosses into the browser needs one of these, and the
 * reason is worth writing down. A browser can leave a promise pending for ever with nothing
 * wrong anywhere: a response whose body never finishes arriving, a request paused by two
 * interceptors where one of them aborted it, a page that is closing while somebody is still
 * reading from it. None of those throw. Nothing times out on its own. The run simply stops,
 * for ever, having already done all its work - which is what happened here before this
 * existed, intermittently, about one walk in four.
 *
 * A check that never finishes is worse than a slow one: nobody can tell it apart from a
 * broken machine, and it takes the answers of every journey that already succeeded with it.
 *
 * @template T
 * @template R
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {R} whenSlow      What to hand back if it never arrives. Give it a value the caller
 *                          can tell apart from a real answer, and then say so out loud - a
 *                          timeout quietly returning something that looks like a result is
 *                          how a hole turns into a pass.
 * @returns {Promise<T|R>}
 */
export function withLimit(promise, ms, whenSlow) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(whenSlow), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(whenSlow);
      },
    );
  });
}

/**
 * Wrap a Playwright page so `src/freeze/` can drive it unchanged.
 *
 * The freeze layer was written against a hand-rolled debug-protocol client and it is the
 * most carefully tested code in the repository - frozen clock, killed motion, seeded
 * randomness, pinned fonts, blocked network, and `settle`, which photographs until two
 * frames agree. Rewriting any of that for Playwright would be re-deriving proven work and
 * getting it subtly wrong. So the page is reshaped instead, and every one of those files
 * runs here exactly as it runs for a picture check.
 *
 * The protocol calls go through a real debug session rather than through Playwright's own
 * wrappers, because that is what the freeze layer asks for: `Emulation.setTimezoneOverride`,
 * `Page.addScriptToEvaluateOnNewDocument`, `Fetch.enable`. Playwright is content to share a
 * target with a second debug client; that was measured, not assumed.
 *
 * The Page domain has to be switched on before this is any use - see {@link wakeDomains},
 * which {@link openWindow} calls for you and which explains what happens when nobody does.
 *
 * @param {any} page
 * @param {any} cdp
 * @param {string|null} baseUrl       The app's own origin, so "block everything external"
 *                                    knows what external means. Set before freezing.
 * @returns {any}
 */
export function pageHandleFor(page, cdp, baseUrl) {
  /** @type {string[]} */
  const complaints = [];
  /** @type {Map<string, {initId: string, token: string}>} */
  const styles = new Map();
  let styleCounter = 0;

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  const send = (method, params) => cdp.send(method, params ?? {});

  /**
   * @param {string} event
   * @param {(params: any) => void} handler
   * @returns {() => void}
   */
  const on = (event, handler) => {
    cdp.on(event, handler);
    return () => {
      try {
        cdp.off(event, handler);
      } catch {
        // The session is already closed; nothing left to detach from.
      }
    };
  };

  /**
   * @param {string} js
   * @returns {Promise<any>}
   */
  const evaluate = async (js) => {
    const res = await send('Runtime.evaluate', {
      expression: js,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res?.exceptionDetails) {
      const text = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'the page refused to run it';
      throw new Error(String(text).split('\n')[0]);
    }
    return res?.result?.value;
  };

  /**
   * @param {string} source
   * @returns {Promise<string>}
   */
  const addInitScript = async (source) => {
    const res = await send('Page.addScriptToEvaluateOnNewDocument', { source });
    return String(res?.identifier ?? '');
  };

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  const removeInitScript = async (id) => {
    if (!id) return;
    try {
      await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id });
    } catch {
      // Already gone with the document.
    }
  };

  /**
   * A stylesheet dies at the next navigation, so the same CSS also goes in as a script that
   * runs before each new document. On this document the tag applies; after a navigation the
   * script puts an identical one back. It refuses to add itself twice, so nothing is ever
   * applied twice over.
   *
   * @param {string} css
   * @returns {Promise<string>}
   */
  const insertCss = async (css) => {
    styleCounter += 1;
    const token = `staysfixed-style-${styleCounter}`;
    const source = `(function () {
  try {
    if (document.getElementById(${JSON.stringify(token)})) return;
    var el = document.createElement('style');
    el.id = ${JSON.stringify(token)};
    el.textContent = ${JSON.stringify(css)};
    (document.head || document.documentElement).appendChild(el);
  } catch (e) {}
})()`;
    let initId = '';
    try {
      initId = await addInitScript(source);
    } catch {
      // No init scripts on this target. The current document still gets the styles.
    }
    try {
      await evaluate(source);
    } catch {
      // No document yet. The init script covers the one that is coming.
    }
    const id = `style:${styleCounter}`;
    styles.set(id, { initId, token });
    return id;
  };

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  const removeCss = async (id) => {
    const held = styles.get(id);
    if (!held) return;
    styles.delete(id);
    await removeInitScript(held.initId);
    try {
      await evaluate(`(function () {
  var el = document.getElementById(${JSON.stringify(held.token)});
  if (el && el.parentNode) el.parentNode.removeChild(el);
})()`);
    } catch {
      // The document went away, and it took the tag with it.
    }
  };

  page.on('console', (/** @type {any} */ message) => {
    const type = message.type();
    if (type !== 'error' && type !== 'assert') return;
    record(message.text());
  });
  page.on('pageerror', (/** @type {any} */ error) => {
    record(`${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`);
  });

  /** @param {string} text */
  function record(text) {
    const line = String(text ?? '').trim();
    if (!line || complaints.includes(line) || complaints.length >= 50) return;
    complaints.push(line);
  }

  /**
   * @param {string} selector
   * @param {{timeoutMs?: number, state?: string}} [o]
   * @returns {Promise<void>}
   */
  const locate = (selector, o) =>
    page.locator(selector).first().waitFor({ state: o?.state ?? 'visible', timeout: o?.timeoutMs ?? 10000 });

  return {
    // --- the extras the freeze layer needs ---------------------------------
    send,
    on,
    sessionId: 'playwright',
    targetId: 'playwright',
    addInitScript,
    removeInitScript,
    insertCss,
    removeCss,
    baseUrl,
    clearConsole: () => {
      complaints.length = 0;
    },

    // --- the ordinary page a step drives -----------------------------------
    /** @param {string} url */
    goto: async (url) => {
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    },
    /**
     * @param {string} selector
     * @param {{timeoutMs?: number}} [o]
     */
    click: async (selector, o) => {
      await page.locator(selector).first().click({ timeout: o?.timeoutMs ?? 10000 });
    },
    /**
     * @param {string} selector
     * @param {string} text
     */
    type: async (selector, text) => {
      await page.locator(selector).first().fill(text, { timeout: 10000 });
    },
    /** @param {string} key */
    press: async (key) => {
      await page.keyboard.press(key);
    },
    /** @param {string} selector */
    hover: async (selector) => {
      await page.locator(selector).first().hover({ timeout: 10000 });
    },
    moveMouseAway: async () => {
      // (1,1) rather than (0,0): some apps read the exact origin as "no pointer at all" and
      // never fire the leave, so whatever is under the cursor stays hovered in the picture.
      await page.mouse.move(1, 1);
    },
    /**
     * @param {string} selector
     * @param {{timeoutMs?: number}} [o]
     */
    waitFor: (selector, o) => locate(selector, o),
    /**
     * @param {string} selector
     * @param {{timeoutMs?: number}} [o]
     */
    waitForGone: (selector, o) => locate(selector, { ...o, state: 'hidden' }),
    /** @param {string} selector */
    scrollTo: async (selector) => {
      await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 10000 });
    },
    /** @param {number} ms */
    wait: async (ms) => {
      await page.waitForTimeout(ms);
    },
    evaluate,
    /** @param {string} selector */
    visible: (selector) => page.locator(selector).first().isVisible().catch(() => false),
    /** @param {string} selector */
    exists: async (selector) => (await page.locator(selector).count()) > 0,
    /** @param {string} selector */
    textOf: async (selector) => String((await page.locator(selector).first().textContent()) ?? ''),
    /** @param {string} selector */
    count: (selector) => page.locator(selector).count(),
    /** @param {string} selector */
    boxOf: async (selector) => {
      try {
        return await page.locator(selector).first().boundingBox();
      } catch {
        return null;
      }
    },
    url: async () => String(page.url()),
    title: () => page.title(),
    shoot: async () => Buffer.from(await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' })),
    /** @param {{width: number, height: number}} v */
    setViewport: async (v) => {
      await page.setViewportSize({ width: v.width, height: v.height });
    },
    consoleErrors: () => complaints.slice(),
  };
}

// ---------------------------------------------------------------------------
// The refusal boundary
// ---------------------------------------------------------------------------

/**
 * Things that are not undone by trying again.
 *
 * Blunt on purpose, and blunt in the safe direction. Refusing a call that would have been
 * harmless costs one line in the report saying it was not checked. Making a call that was
 * not harmless costs somebody money, or somebody's inbox, or somebody's data - twice, once
 * for each build. A project that knows better says so in its own settings, and every
 * refusal names itself in the report so nobody has to guess which one to allow.
 */
export const IRREVERSIBLE = Object.freeze([
  '**/pay', '**/pay/**', '**/payment*', '**/payments/**', '**/charge*', '**/charges/**',
  '**/checkout/**', '**/orders/**', '**/purchase*', '**/subscribe*', '**/subscriptions/**',
  '**/billing/**', '**/refund*', '**/invoices/**', '**/payout*',
  '**/send*', '**/email*', '**/mail*', '**/sms*', '**/notif*', '**/invite*', '**/message*',
  '**/delete*', '**/destroy*', '**/remove*', '**/purge*', '**/wipe*', '**/cancel*',
  '**/unsubscribe*', '**/reset-*',
]);

// On why these end in a star rather than naming exact paths. The first version of this list
// had the exact path "send", and a fixture that posted to /api/send-receipt sailed straight
// through it - a receipt emailed to a customer, twice, once for each build, by the tool that
// exists to keep that from happening. Every real product spells these differently:
// send-receipt, sendMail, deleteAccount, cancelSubscription. A prefix catches all of them; an
// exact path catches only the one somebody happened to think of.

/**
 * @typedef {object} WireCall
 * @property {string} method
 * @property {string} pattern         The address with the changing parts taken out.
 * @property {string} url             The address as it really was. Never compared.
 * @property {string} kind            document, script, fetch, image, ...
 * @property {boolean} sameOrigin
 * @property {boolean} refused
 * @property {string} [why]           Why it was refused, in plain English.
 * @property {JsonValue} [sends]      The shape of what was being sent, when there was a body.
 * @property {number} [status]        Filled in when an answer came back.
 * @property {JsonValue} [answered]   The answer, for the app's own calls that speak JSON.
 * @property {JsonValue} [shape]      The fields the answer carries and what type each one is.
 * @property {string} [failed]        Why it never finished.
 * @property {number} times
 */

/**
 * Watch - and where it matters, stop - everything the page sends.
 *
 * The freeze layer has already cut the page off from the internet; this is the second,
 * narrower boundary, and it answers a different question. Freezing asks "is this somebody
 * else's server, which would make the picture depend on their weather". Refusing asks "does
 * this spend money, send a message or destroy data", which is true of a call to the app's
 * own back end - exactly the case freezing lets through.
 *
 * Everything is recorded either way. A refused call is recorded as ASKED FOR - same method,
 * same address, same shape of body - and reported as a hole in the check. That is the whole
 * of this tool's safety: watch the ask, never perform the effect, and never let a refusal be
 * mistaken for a pass.
 *
 * @param {any} page
 * @param {object} opts
 * @param {string|null} opts.baseUrl
 * @param {string[]} [opts.refuse]        Extra patterns to refuse, from the project.
 * @param {string[]} [opts.allow]         Patterns to allow that would otherwise be refused.
 * @param {boolean} [opts.allowWrites]    Let ordinary writes through to an address that is
 *                                        not on this machine. Off unless a project says so.
 * @param {boolean} [opts.allowIrreversible]  Never set by the engine. It exists so the
 *                                        refusal is a decision in the code, not an accident.
 * @returns {Promise<{calls: () => WireCall[], settled: () => Promise<void>, stop: () => Promise<void>}>}
 */
export async function watchTheWire(page, opts) {
  const own = originOf(opts.baseUrl);
  const local = isLocal(opts.baseUrl);
  const refuse = (opts.refuse ?? []).map(globToRegExp);
  const allow = (opts.allow ?? []).map(globToRegExp);

  /** @type {Map<string, WireCall>} */
  const calls = new Map();
  /** @type {Promise<void>[]} */
  const reading = [];

  /**
   * @param {string} method
   * @param {string} url
   * @returns {WireCall}
   */
  const entryFor = (method, url) => {
    const pattern = wirePattern(url, own);
    const key = `${method} ${pattern}`;
    const found = calls.get(key);
    if (found) return found;
    /** @type {WireCall} */
    const made = { method, pattern, url, kind: 'other', sameOrigin: originOf(url) === own, refused: false, times: 0 };
    calls.set(key, made);
    return made;
  };

  await page.route('**/*', async (/** @type {any} */ route) => {
    const request = route.request();
    const url = String(request.url());
    const method = String(request.method()).toUpperCase();
    const entry = entryFor(method, url);
    entry.times += 1;
    entry.kind = String(request.resourceType());

    const body = request.postData();
    if (body) entry.sends = shapeOfBody(String(request.headers()['content-type'] ?? ''), body);

    const verdict = judge({ method, url, own, local, refuse, allow, allowWrites: opts.allowWrites === true });
    if (verdict.refuse && opts.allowIrreversible !== true) {
      entry.refused = true;
      entry.why = verdict.why;
      try {
        await route.abort('blockedbyclient');
      } catch {
        // The page gave up on it first. Refused either way.
      }
      return;
    }
    try {
      await route.continue();
    } catch {
      // The request was answered already, or the page moved on. Nothing else to do: a
      // request that is paused and never answered stalls the page, which looks like a hang.
    }
  });

  page.on('response', (/** @type {any} */ response) => {
    const request = response.request();
    const url = String(request.url());
    const method = String(request.method()).toUpperCase();
    const entry = entryFor(method, url);
    entry.status = Number(response.status());
    if (!entry.sameOrigin) return;
    const type = String(response.headers()['content-type'] ?? '');
    if (!/json|text\/plain/i.test(type)) return;
    // Read it now, not later: once the page navigates the body is gone, and a body we
    // failed to read would look exactly like a body that was never sent.
    reading.push(
      withLimit(response.text(), 5000, null).then((/** @type {string|null} */ text) => {
        // null means it never arrived - a redirect, a 204, a stream the page consumed first,
        // or a body that simply never finished. Not worth failing a walk over, and not worth
        // waiting for either.
        if (text === null) return;
        const parsed = readAnswer(type, text);
        entry.answered = parsed.value;
        if (parsed.shape !== undefined) entry.shape = parsed.shape;
      }),
    );
  });

  page.on('requestfailed', (/** @type {any} */ request) => {
    const entry = entryFor(String(request.method()).toUpperCase(), String(request.url()));
    if (entry.refused) return;
    entry.failed = String(request.failure()?.errorText ?? 'it did not finish');
  });

  return {
    calls: () => [...calls.values()].sort((a, b) => `${a.method} ${a.pattern}`.localeCompare(`${b.method} ${b.pattern}`)),
    settled: async () => {
      await withLimit(Promise.all(reading.splice(0)), 15000, []);
    },
    stop: async () => {
      try {
        await page.unroute('**/*');
      } catch {
        // The page is closing. The routes go with it.
      }
    },
  };
}

/** {@link IRREVERSIBLE}, compiled once. */
const ALWAYS_REFUSED = IRREVERSIBLE.map(globToRegExp);

/**
 * Should this call be allowed to happen for real?
 *
 * The built-in refusal list is applied HERE rather than by whoever calls this, and that is
 * deliberate: a safety boundary a caller has to remember to switch on is a safety boundary
 * that will one day be called without it.
 *
 * @param {object} input
 * @param {string} input.method
 * @param {string} input.url
 * @param {string|null} input.own
 * @param {boolean} input.local
 * @param {RegExp[]} [input.refuse]      Extra patterns from the project, on top of the built-in list.
 * @param {RegExp[]} [input.allow]       Patterns the project says are safe after all.
 * @param {boolean} [input.allowWrites]
 * @returns {{refuse: boolean, why: string}}
 */
export function judge(input) {
  const { url, method } = input;
  const reading = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  let where = url;
  try {
    where = new URL(url).pathname;
  } catch {
    // Not a URL we can pick apart. The whole string is matched instead.
  }
  /** @param {RegExp[]} list */
  const matches = (list) => list.some((re) => re.test(url) || re.test(where));

  if (matches(input.allow ?? [])) return { refuse: false, why: 'the project said this one is safe to let through' };

  // A project's OWN list is absolute: it applies to reads as well, because only the project
  // knows it has a link that deletes something. The built-in list applies to writes only.
  // Reading is assumed safe, and the assumption buys a lot: without it, every GET of an
  // order, an invoice or a message thread is refused, and a shop loses most of its coverage
  // to protect against a danger that was never there.
  if (matches(input.refuse ?? [])) {
    return {
      refuse: true,
      why: `${method} ${where} is on this project's own list of things that must not really happen. It was asked for and stopped at the wire, so what was asked is compared and the effect never happened.`,
    };
  }
  if (reading) return { refuse: false, why: 'reading something changes nothing' };
  if (matches(ALWAYS_REFUSED)) {
    return {
      refuse: true,
      why: `${method} ${where} looks like it spends money, sends a message or destroys data. It was asked for and stopped at the wire, so what was asked is compared and the effect never happened.`,
    };
  }
  if (input.local || input.allowWrites) {
    return { refuse: false, why: 'a write to a copy of the app running on this machine, against data that is put back between runs' };
  }
  return {
    refuse: true,
    why: `${method} ${where} writes to an address that is not on this machine, so it was stopped. Point the check at a copy of the app running locally, or set "allowWrites" for this project if the address is a safe one.`,
  };
}

/**
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
function originOf(url) {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Is this address on the machine we are running on?
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
export function isLocal(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host === '0.0.0.0'
    );
  } catch {
    return false;
  }
}

/**
 * An address with the parts that change taken out of it.
 *
 * `/api/users/8412/orders/a9f3-...` and `/api/users/9001/orders/b2c1-...` are the same call
 * made twice, and comparing them as written would report a difference on every run. What is
 * worth comparing is that the page asked for a user's orders at all.
 *
 * @param {string} url
 * @param {string|null} own
 * @returns {string}
 */
export function wirePattern(url, own) {
  /** @type {URL} */
  let u;
  try {
    u = new URL(url);
  } catch {
    return String(url).slice(0, 200);
  }
  const where = u.pathname
    .split('/')
    .map((part) => {
      if (part === '') return part;
      if (/^[0-9]+$/.test(part)) return '*';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)) return '*';
      if (/^[0-9a-f]{16,}$/i.test(part)) return '*';
      if (/[0-9]{6,}/.test(part)) return '*';
      return part;
    })
    .join('/');
  const keys = [...u.searchParams.keys()].sort();
  const query = keys.length > 0 ? `?${keys.join('&')}` : '';
  const head = own && u.origin === own ? '' : u.origin;
  return `${head}${where || '/'}${query}`;
}

/**
 * The shape of something being sent, never the thing itself.
 *
 * A request body carries names, addresses and card numbers. What is worth comparing is that
 * the page still sends an order with an id, a quantity and an address - the fields and their
 * types - not what today's happened to say.
 *
 * @param {string} contentType
 * @param {string} body
 * @returns {JsonValue}
 */
export function shapeOfBody(contentType, body) {
  if (/json/i.test(contentType)) {
    try {
      return typesIn(JSON.parse(body));
    } catch {
      return 'said it was JSON and was not';
    }
  }
  if (/x-www-form-urlencoded/i.test(contentType)) {
    try {
      return [...new URLSearchParams(body).keys()].sort();
    } catch {
      return 'a form we could not read';
    }
  }
  return `${Buffer.byteLength(body, 'utf8')} bytes of ${contentType.split(';')[0] || 'something'}`;
}

/**
 * Turn an answer into something worth comparing.
 * @param {string} contentType
 * @param {string} text
 * @returns {{value: JsonValue, shape?: JsonValue}}
 */
export function readAnswer(contentType, text) {
  if (text === '') return { value: 'nothing at all' };
  if (/json/i.test(contentType)) {
    try {
      const parsed = JSON.parse(text);
      return { value: sorted(parsed), shape: typesIn(parsed) };
    } catch {
      return { value: `said it was JSON but was not: ${text.slice(0, 500)}` };
    }
  }
  return {
    value: text.length > 4000 ? `${text.slice(0, 2000)}\n... the middle is left out ...\n${text.slice(-2000)}` : text,
  };
}

/**
 * @param {unknown} value
 * @returns {JsonValue}
 */
function sorted(value) {
  if (value === null || typeof value !== 'object') return /** @type {JsonValue} */ (value ?? null);
  if (Array.isArray(value)) return value.map(sorted);
  /** @type {Record<string, JsonValue>} */
  const out = {};
  const object = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(object).sort()) out[key] = sorted(object[key]);
  return out;
}

/**
 * The names and types inside a value, with every list collapsed to "N things shaped like
 * this". It holds still while the values churn, so a renamed or dropped field shows up on
 * its own instead of buried inside a diff of the whole body.
 *
 * @param {unknown} value
 * @returns {JsonValue}
 */
export function typesIn(value) {
  if (value === null || value === undefined) return 'nothing';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'an empty list';
    return { 'a list of': value.length, 'each one': typesIn(value[0]) };
  }
  if (typeof value === 'object') {
    /** @type {Record<string, JsonValue>} */
    const out = {};
    const object = /** @type {Record<string, unknown>} */ (value);
    for (const key of Object.keys(object).sort()) out[key] = typesIn(object[key]);
    return out;
  }
  return typeof value;
}

// ---------------------------------------------------------------------------
// The meaning tree
// ---------------------------------------------------------------------------

/**
 * One node of the accessibility tree.
 *
 * @typedef {object} AriaNode
 * @property {string} role            button, heading, list, textbox, text, ...
 * @property {string} [name]          What a screen reader would call it.
 * @property {Record<string, string|boolean>} states   disabled, checked, expanded, level, ...
 * @property {string} [text]          Its own words, when it has any of its own.
 * @property {AriaNode[]} children
 */

/**
 * Read Playwright's ARIA snapshot into a tree.
 *
 * The snapshot is a small, strict subset of YAML, and it is parsed here rather than with a
 * YAML library for two reasons: there is no YAML library among this project's dependencies,
 * and every line has exactly one of five shapes, which is a page of code rather than a
 * dependency. The five shapes:
 *
 *     - button "Save"                    something with a name
 *     - heading "Total" [level=2]        with states in brackets
 *     - navigation:                      something with children under it
 *     - paragraph: nine o'clock          something with its own words
 *     - text: nine o'clock               words with no element of their own
 *
 * A colon inside a quoted name is not a separator, and neither is one inside brackets. Both
 * happen in real apps, and both would otherwise cut a name silently in half.
 *
 * @param {string} snapshot
 * @returns {AriaNode[]}
 */
export function parseAria(snapshot) {
  const lines = String(snapshot ?? '').split('\n');
  /** @type {AriaNode[]} */
  const roots = [];
  /** @type {{indent: number, node: AriaNode}[]} */
  const stack = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const indent = raw.length - raw.replace(/^\s+/, '').length;
    const body = raw.trim();
    if (!body.startsWith('- ') && body !== '-') continue;
    const rest = body === '-' ? '' : body.slice(2);

    const cut = splitAtSeparator(rest);
    const node = readHead(cut.head);
    if (cut.text !== undefined) {
      let text = cut.text;
      if (text === '|' || text === '|-' || text === '>' || text === '>-') {
        // A block of text, written across several more-indented lines.
        /** @type {string[]} */
        const block = [];
        while (i + 1 < lines.length) {
          const next = lines[i + 1];
          if (next.trim() === '') {
            block.push('');
            i += 1;
            continue;
          }
          const nextIndent = next.length - next.replace(/^\s+/, '').length;
          if (nextIndent <= indent) break;
          block.push(next.trim());
          i += 1;
        }
        text = block.join('\n').trim();
      }
      node.text = unquote(text);
    }

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });
  }
  return roots;
}

/**
 * Find the colon that separates a node from its words, ignoring the ones inside a quoted
 * name or inside brackets.
 *
 * @param {string} rest
 * @returns {{head: string, text?: string}}
 */
function splitAtSeparator(rest) {
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '[') depth += 1;
    else if (!quoted && ch === ']') depth = Math.max(0, depth - 1);
    else if (!quoted && depth === 0 && ch === ':') {
      const after = rest.slice(i + 1);
      if (after === '') return { head: rest.slice(0, i) };
      if (after.startsWith(' ')) return { head: rest.slice(0, i), text: after.trim() };
    }
  }
  return { head: rest };
}

/**
 * @param {string} head
 * @returns {AriaNode}
 */
function readHead(head) {
  const text = head.trim();
  /** @type {AriaNode} */
  const node = { role: 'text', states: {}, children: [] };

  const roleMatch = /^([A-Za-z][A-Za-z0-9_-]*)/.exec(text);
  node.role = roleMatch ? roleMatch[1] : 'text';
  let at = roleMatch ? roleMatch[1].length : 0;

  const after = text.slice(at).trimStart();
  at = text.length - after.length;
  if (after.startsWith('"')) {
    let i = 1;
    let name = '';
    while (i < after.length) {
      const ch = after[i];
      if (ch === '\\' && i + 1 < after.length) {
        name += after[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') break;
      name += ch;
      i += 1;
    }
    node.name = name;
    at += i + 1;
  }

  for (const m of text.slice(at).matchAll(/\[([A-Za-z0-9_-]+)(?:=([^\]]*))?\]/g)) {
    node.states[m[1]] = m[2] === undefined ? true : m[2];
  }
  return node;
}

/**
 * @param {string} text
 * @returns {string}
 */
function unquote(text) {
  const t = text.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/**
 * Roles that are places rather than things. A place goes into the address of everything
 * underneath it, which is part of what makes an address survive a page being rearranged.
 */
const PLACES = new Set([
  'banner', 'navigation', 'main', 'complementary', 'contentinfo', 'region', 'search', 'form',
  'dialog', 'alertdialog', 'article', 'list', 'listbox', 'menu', 'menubar', 'table', 'grid',
  'treegrid', 'tree', 'tablist', 'tabpanel', 'toolbar', 'radiogroup', 'status', 'alert', 'log',
  'feed',
]);

// What is deliberately NOT on that list: group, figure, blockquote, document, application,
// combobox. Every one of them is a container a browser hands out for ordinary markup - a
// fieldset, a details element, an address block - and putting them in the address means a
// team that wrapped a section in a fieldset for spacing reasons gets told the whole section
// moved. A NAMED one still counts, because a name is somebody saying out loud that this is a
// place ("Shipping address"), and that is handled by the `node.name` test below rather than
// by this list.

/**
 * The places that are a place in their own right, and so are never described as being
 * "under" a heading.
 *
 * Without this the navigation bar under a page's title ends up addressed through the title,
 * and renaming the product moves every link in the site. A landmark is where something is;
 * a heading is what a run of content is about. Only the second one makes a section.
 */
const LANDMARKS = new Set([
  'banner', 'navigation', 'main', 'complementary', 'contentinfo', 'region', 'search', 'form',
  'dialog', 'alertdialog',
]);

/**
 * One addressable thing on the screen.
 *
 * @typedef {object} MeaningEntry
 * @property {string[]} at            The address, part by part, outermost first.
 * @property {string} role
 * @property {string} [name]
 * @property {JsonValue} value        What it says, or what it is when it says nothing.
 * @property {Record<string, string|boolean>} states
 * @property {string} describe        One plain sentence about it.
 */

/**
 * Flatten the meaning tree into addresses that survive a page being rearranged.
 *
 * THE PROBLEM THIS SOLVES, because it is most of the reason this file exists. The obvious
 * way to address a control is by where it is: third thing inside the second section. Do that
 * and moving one paragraph renames every address below it, so a one-line change reports two
 * hundred differences. Nobody reads the second report like that.
 *
 * So an address is built out of what a person would actually say. Three rules, in order:
 *
 *   1. A THING IS NAMED BY WHAT IT IS AND WHAT IT SAYS - `button:Pay now`. Rename the button
 *      and the old address goes while a new one arrives, which is exactly right: the label
 *      IS the promise the control makes.
 *   2. A THING LIVES SOMEWHERE - inside a landmark, a list, a dialog, and underneath a
 *      heading. Headings are used as section markers because that is what they are for, and
 *      because a section that moves takes its heading with it. `main.under:Your orders`
 *      still means the same place after the section is moved to the top of the page.
 *   3. ONLY WHEN TWO THINGS IN ONE SECTION ARE GENUINELY INDISTINGUISHABLE does position
 *      come into it, as `#2`, `#3` - and it is counted only within that section, so a change
 *      in one section can never renumber another.
 *
 * @param {AriaNode[]} nodes
 * @returns {MeaningEntry[]}
 */
export function flattenAria(nodes) {
  /** @type {MeaningEntry[]} */
  const out = [];

  /**
   * @param {AriaNode[]} children
   * @param {string[]} at
   * @returns {void}
   */
  const walk = (children, at) => {
    /** @type {Map<string, number>} */
    const seen = new Map();
    /** @type {{level: number, at: string[]}[]} */
    const sections = [];

    for (const node of children) {
      const heading = node.role === 'heading';
      const level = Number(node.states.level ?? 2) || 2;
      if (heading) {
        while (sections.length > 0 && sections[sections.length - 1].level >= level) sections.pop();
      }
      const ownPlace = LANDMARKS.has(node.role);
      const scope = heading || ownPlace || sections.length === 0 ? at : sections[sections.length - 1].at;

      // Two things with the same name in the same place have to be told apart somehow, and
      // counting is the only honest way left. The count is kept per place, so it cannot
      // spread: adding a row to one list never renumbers another.
      const key = `${scope.join(' ')} ${node.role} ${node.name ?? ''}`;
      const nth = (seen.get(key) ?? 0) + 1;
      seen.set(key, nth);

      const base = node.name ? `${node.role}:${short(node.name)}` : node.role;
      const segment = nth > 1 ? `${base}#${nth}` : base;
      const here = [...scope, segment];

      out.push({
        at: here,
        role: node.role,
        name: node.name,
        value: node.text !== undefined && node.text !== '' ? node.text : phrase(node),
        states: node.states,
        describe: describeNode(node, here),
      });

      if (heading) {
        sections.push({ level, at: [...at, `under:${short(node.name ?? node.text ?? 'a heading')}`] });
      }

      if (node.children.length > 0) {
        // A place goes into the address of what is inside it; anything else does not, so a
        // wrapper somebody added for layout reasons changes no address at all.
        const inside = PLACES.has(node.role) || node.name ? here : scope;
        walk(node.children, inside);
      }
    }
  };

  walk(nodes, []);
  return out;
}

/**
 * @param {AriaNode} node
 * @returns {string}
 */
function phrase(node) {
  if (node.name) return `${withArticle(node.role)} called "${node.name}"`;
  return withArticle(node.role);
}

/**
 * @param {AriaNode} node
 * @param {string[]} at
 * @returns {string}
 */
function describeNode(node, at) {
  const where = at.length > 1 ? ` inside ${at.slice(0, -1).join(' / ')}` : '';
  const states = Object.keys(node.states).filter((k) => k !== 'level');
  const said = node.text ? ` It says "${short(node.text, 80)}".` : '';
  const flags = states.length > 0 ? ` It is ${states.join(' and ')}.` : '';
  return `${capital(phrase(node))}${where}.${said}${flags}`;
}

/**
 * @param {string} role
 * @returns {string}
 */
function withArticle(role) {
  return /^[aeiou]/i.test(role) ? `an ${role}` : `a ${role}`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function capital(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Keep a name short enough to sit inside an address.
 *
 * A whole paragraph used as a button label is rare and real. Cutting it keeps addresses
 * readable and inside the length an address is allowed to be; the full text is still
 * compared, because the full text is the value.
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function short(text, limit = 60) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length <= limit ? one : `${one.slice(0, limit - 1)}...`;
}

/**
 * How many of each kind of thing is on the screen.
 *
 * @param {MeaningEntry[]} entries
 * @returns {Map<string, number>}
 */
export function countRoles(entries) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const entry of entries) counts.set(entry.role, (counts.get(entry.role) ?? 0) + 1);
  return new Map([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Everything a step may say, in the order it happens when one step says several things.
 *
 * This is v1's vocabulary, unchanged and on purpose: a project that already has screens
 * written for picture checks can point the difference machine at the same file and have it
 * work, and nobody has to learn a second set of words for the same actions.
 */
export const ACTION_ORDER = /** @type {const} */ ([
  'goto', 'waitFor', 'scrollTo', 'hover', 'click', 'type', 'press', 'evaluate', 'waitForGone', 'wait',
]);

/**
 * Do what one step says.
 *
 * @param {any} page      A page handle from {@link pageHandleFor}.
 * @param {Record<string, any>} step
 * @param {{baseUrl?: string|null}} [opts]
 * @returns {Promise<string[]>} what it did, in plain English, for the report
 */
export async function runStep(page, step, opts = {}) {
  /** @type {string[]} */
  const did = [];
  for (const action of ACTION_ORDER) {
    const value = step[action];
    if (value === undefined || value === null) continue;
    switch (action) {
      case 'goto': {
        await page.goto(absolute(String(value), opts.baseUrl ?? null));
        did.push(`opened ${String(value)}`);
        break;
      }
      case 'waitFor':
        await page.waitFor(String(value), { timeoutMs: step.timeoutMs });
        did.push(`waited for ${String(value)} to appear`);
        break;
      case 'waitForGone':
        await page.waitForGone(String(value), { timeoutMs: step.timeoutMs });
        did.push(`waited for ${String(value)} to go`);
        break;
      case 'scrollTo':
        await page.scrollTo(String(value));
        did.push(`scrolled to ${String(value)}`);
        break;
      case 'hover':
        await page.hover(String(value));
        did.push(`hovered ${String(value)}`);
        break;
      case 'click':
        await page.click(String(value), { timeoutMs: step.timeoutMs });
        did.push(`clicked ${String(value)}`);
        break;
      case 'type':
        await page.type(String(value), String(step.text ?? ''));
        did.push(`typed into ${String(value)}`);
        break;
      case 'press':
        await page.press(String(value));
        did.push(`pressed ${String(value)}`);
        break;
      case 'evaluate':
        await page.evaluate(String(value));
        did.push('ran a piece of script the journey asked for');
        break;
      case 'wait':
        await page.wait(Number(value));
        did.push(`waited ${Number(value)} milliseconds`);
        break;
      default:
        break;
    }
  }
  return did;
}

/**
 * The plain-English verb for a step, used to name it in an address.
 * @param {Record<string, any>} step
 * @returns {string}
 */
export function actOf(step) {
  if (step.goto !== undefined) return 'open';
  if (step.click !== undefined) return 'click';
  if (step.type !== undefined) return 'type';
  if (step.press !== undefined) return 'press';
  if (step.hover !== undefined) return 'hover';
  if (step.scrollTo !== undefined) return 'scroll';
  if (step.waitFor !== undefined || step.waitForGone !== undefined || step.wait !== undefined) return 'wait';
  if (step.evaluate !== undefined) return 'run';
  return 'step';
}

/**
 * @param {string} url
 * @param {string|null} baseUrl
 * @returns {string}
 */
export function absolute(url, baseUrl) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (!baseUrl) return url;
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

/**
 * Where the page is, with the parts that change taken out.
 *
 * @param {string} url
 * @param {string|null} baseUrl
 * @returns {string}
 */
export function whereItIs(url, baseUrl) {
  try {
    const u = new URL(url);
    const own = baseUrl ? new URL(baseUrl).origin : null;
    const keys = [...u.searchParams.keys()].sort();
    return `${u.origin === own ? '' : u.origin}${u.pathname}${keys.length > 0 ? `?${keys.join('&')}` : ''}${u.hash}`;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/**
 * How full the screen is, said roughly.
 *
 * The picture itself is evidence and is never compared - comparing pixels is what v1 did and
 * what this design deliberately stopped doing. But one thing a picture knows and no other
 * channel does is whether anything was drawn at all. A page whose stylesheet failed to load
 * still has every button in its accessibility tree; a page that rendered nothing looks
 * identical to a working one everywhere except here.
 *
 * So exactly one number is taken from the pixels, and it is bucketed so coarsely that
 * nothing short of a real collapse can move it. Sampled every eighth pixel, because this
 * runs at every checkpoint of every journey and a full decode of a retina screen is not
 * worth it.
 *
 * @param {Buffer} png
 * @returns {{wide: number, tall: number, ink: string}}
 */
export function inkOf(png) {
  try {
    const image = PNG.sync.read(png);
    const { width, height, data } = image;
    const back = [data[0], data[1], data[2]];
    let looked = 0;
    let different = 0;
    for (let y = 0; y < height; y += 8) {
      for (let x = 0; x < width; x += 8) {
        const at = (y * width + x) * 4;
        looked += 1;
        if (
          Math.abs(data[at] - back[0]) > 24 ||
          Math.abs(data[at + 1] - back[1]) > 24 ||
          Math.abs(data[at + 2] - back[2]) > 24
        ) {
          different += 1;
        }
      }
    }
    return { wide: width, tall: height, ink: inkWord(looked === 0 ? 0 : different / looked) };
  } catch {
    return { wide: 0, tall: 0, ink: 'unreadable' };
  }
}

/**
 * @param {number} share
 * @returns {string}
 */
function inkWord(share) {
  if (share < 0.005) return 'blank';
  if (share < 0.05) return 'nearly blank';
  if (share < 0.2) return 'sparse';
  if (share < 0.5) return 'busy';
  return 'very busy';
}
