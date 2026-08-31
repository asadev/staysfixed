/**
 * Page control — the surface every screen recipe and every guard is handed.
 *
 * It sits on one attached target (a browser tab or an Electron window) and turns
 * "click the save button" into real input events, real waits and real pictures.
 *
 * Two habits run through the whole file, and both exist for determinism:
 *  - every wait computes its deadline once, then polls; a naive loop that adds
 *    a timeout per iteration drifts and makes the same check take a different
 *    amount of time on a slow machine.
 *  - input is dispatched as real browser events, never as `element.click()`.
 */

import { Buffer } from 'node:buffer';
import { setTimeout as sleep } from 'node:timers/promises';
import { StaysFixedError } from '../core/errors.js';
import { detail } from '../core/log.js';
import { waitForQuietDom } from './launch.js';

/**
 * Keys `press()` understands by name. Anything else is sent as literal text.
 * @type {Record<string, {key: string, code: string, keyCode: number, text?: string}>}
 */
export const KEY_CODES = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
};

/** Domains we try to turn on. A window that refuses one still works for the rest. */
const DOMAINS = ['Page', 'Runtime', 'DOM', 'CSS', 'Log', 'Console'];

/** Most recorded errors worth reading. Past this the page is broken, not subtly wrong. */
const MAX_CONSOLE_ERRORS = 50;

/** Chrome cannot paint a picture wider or taller than this. */
const MAX_CAPTURE_SIDE = 16384;

/**
 * After a click, how long the page has to stay unchanged before we call it finished,
 * and how long we are prepared to wait for that.
 *
 * Both are deliberately small. This is here to replace the `{ wait: 400 }` people write
 * because they are guessing, so it has to be quicker than the guess on a page that has
 * already finished and it must never become the slow part of a run on a page that fidgets
 * forever — the settle loop is the real guarantee, not this.
 */
const CLICK_QUIET_MS = 120;
const CLICK_QUIET_CAP_MS = 1500;

/**
 * Seconds, written the way a person says them: 15, 1.5, 0.5.
 * @param {number} ms
 * @returns {string}
 */
function secs(ms) {
  return String(Math.round(ms / 100) / 10);
}

/**
 * @param {string} selector
 * @returns {string}
 */
function q(selector) {
  return JSON.stringify(selector);
}

/**
 * @param {string} selector
 * @returns {string}
 */
function visibleSource(selector) {
  return (
    '(function(){var el=document.querySelector(' +
    q(selector) +
    ');if(!el)return false;' +
    'var r=el.getBoundingClientRect();if(r.width<=0||r.height<=0)return false;' +
    'var node=el;' +
    'while(node&&node.nodeType===1){' +
    'var s=window.getComputedStyle(node);' +
    'if(s.display==="none"||s.visibility==="hidden"||s.visibility==="collapse")return false;' +
    'if(parseFloat(s.opacity||"1")===0)return false;' +
    'node=node.parentElement;}' +
    'return true;})()'
  );
}

/**
 * @param {string} selector
 * @param {boolean} scroll  Scroll it to the middle of the window first.
 * @returns {string}
 */
function boxSource(selector, scroll) {
  return (
    '(function(){var el=document.querySelector(' +
    q(selector) +
    ');if(!el)return null;' +
    (scroll ? 'el.scrollIntoView({block:"center",inline:"center",behavior:"instant"});' : '') +
    'var r=el.getBoundingClientRect();' +
    'return {x:r.x,y:r.y,width:r.width,height:r.height};})()'
  );
}

/**
 * A `<style>` tag that adds itself once, whenever the document is ready enough
 * to hold it. Used both for the immediate injection and as the init script that
 * re-applies it after a navigation.
 * @param {string} css
 * @param {string} token  The element id, so the script is safe to run twice.
 * @returns {string}
 */
function styleTagSource(css, token) {
  return (
    '(function(){var css=' +
    JSON.stringify(css) +
    ';var id=' +
    JSON.stringify(token) +
    ';function add(){' +
    'if(document.getElementById(id))return;' +
    'var root=document.head||document.documentElement;if(!root)return;' +
    'var el=document.createElement("style");el.id=id;el.textContent=css;root.appendChild(el);}' +
    'add();document.addEventListener("DOMContentLoaded",add);})();'
  );
}

/**
 * @param {string} token
 * @returns {string}
 */
function removeStyleTagSource(token) {
  return (
    '(function(){var el=document.getElementById(' +
    JSON.stringify(token) +
    ');if(el&&el.parentNode)el.parentNode.removeChild(el);return true;})()'
  );
}

/**
 * What somebody handed `evaluate`, turned into a piece of JavaScript the app can run.
 *
 * A STRING IS NOT THE OBVIOUS THING TO PASS. Every other tool in this space takes a
 * function — `page.evaluate(() => document.title)` is what anybody who has driven a browser
 * before writes first — and this took only text. Handing it a function put a function object
 * where the debug protocol wanted a string, and what came back was, in full, measured while
 * using the tool on 2026-08-31:
 *
 *     The app refused the request "Runtime.evaluate": Invalid parameters
 *
 * That is the machine's own words about its own wire format, said to somebody who has done
 * nothing wrong except write the thing that works everywhere else. So a function is now
 * accepted and turned into the call it obviously means, and text goes through untouched.
 * Only what genuinely cannot be run says so — in a sentence naming what it was given and
 * showing the one line that works.
 *
 * It runs with nothing passed to it, which is why a function that declares a parameter is
 * refused rather than quietly given `undefined`: there is no way to send a value into the
 * page here, and the alternative is a guard failing inside the app for a reason that has
 * nothing to do with the app.
 *
 * @param {unknown} what   A piece of JavaScript as text, or a function to call in the page.
 * @returns {string}
 */
export function asJavaScript(what) {
  if (typeof what === 'string') return what;

  if (typeof what === 'function') {
    const source = String(what);
    // A built-in — `page.evaluate(Math.max)`, `page.evaluate(document.querySelector)` — has
    // no readable body, so there is nothing to send. Asked FIRST, before anything about the
    // arguments: a built-in usually declares some, and being told to close over them is
    // advice about a function nobody could have sent anyway. Said plainly, too, because
    // "SyntaxError: Unexpected token" out of the page is a worse version of the message this
    // whole function exists to replace.
    if (/\{\s*\[native code\]\s*\}/.test(source)) {
      throw new StaysFixedError('evaluate() was handed a built-in function, and the app cannot be sent one: it has no source to run.', {
        hint: 'Wrap it in a function of your own: page.evaluate(() => document.querySelector(".total").textContent).',
      });
    }
    if (what.length > 0) {
      throw new StaysFixedError(
        `evaluate() runs a function inside the app with nothing passed to it, and this one asks for ${what.length === 1 ? 'an argument' : `${what.length} arguments`}.`,
        {
          hint: 'Nothing can be sent into the page here. Close over what it needs, or write the value into the JavaScript itself: page.evaluate(`document.title === ${JSON.stringify(expected)}`).',
        },
      );
    }
    // Shorthand method syntax — `{ title() { ... } }` — is not an expression on its own, so
    // the ordinary wrapping below would send the app something it cannot parse. Put back in
    // the object it was written in and called by name.
    //
    // A leading `async` is taken off before the name is read, and it has to be: leave it on
    // and the pattern happily reads `async () => 1` as a method called "async", because
    // backtracking gives up the optional keyword and matches the word itself.
    const shorthand = /^(?!function\b)([A-Za-z_$][\w$]*)\s*\(/.exec(source.replace(/^async\s+/, ''));
    if (shorthand) return `({ ${source} }).${shorthand[1]}()`;
    return `(${source})()`;
  }

  throw new StaysFixedError(
    `evaluate() wants a piece of JavaScript written as text, or a function to run in the app. It was given ${what === null ? 'null' : typeof what}.`,
    { hint: 'Either way round works: page.evaluate(\'document.title\') or page.evaluate(() => document.title).' },
  );
}

/**
 * One line describing whatever the page threw.
 * @param {any} details  Runtime.ExceptionDetails
 * @returns {string}
 */
function describeException(details) {
  if (!details) return 'Unknown error';
  const ex = details.exception;
  let text = ex && (ex.description ?? ex.value);
  if (text === undefined || text === null) text = details.text;
  if (text === undefined || text === null) text = 'Unknown error';
  return String(text).split('\n')[0].trim() || 'Unknown error';
}

/**
 * One console argument, readable.
 * @param {any} arg  Runtime.RemoteObject
 * @returns {string}
 */
function describeArg(arg) {
  if (!arg) return '';
  if (arg.value !== undefined) {
    if (typeof arg.value === 'string') return arg.value;
    const json = JSON.stringify(arg.value);
    return typeof json === 'string' ? json : String(arg.value);
  }
  if (arg.unserializableValue !== undefined) return String(arg.unserializableValue);
  if (arg.description !== undefined) return String(arg.description).split('\n')[0];
  return String(arg.type ?? '');
}

/**
 * Build the page surface for one already-attached target.
 *
 * @param {import('../types.js').CdpSession} cdp
 * @param {{sessionId: string, targetId: string, baseUrl?: string|null, timeoutMs?: number}} opts
 * @returns {Promise<import('../types.js').PageHandle>}
 */
export async function createPage(cdp, opts) {
  const sessionId = opts.sessionId;
  const targetId = opts.targetId;
  const baseUrl = opts.baseUrl ?? null;
  const defaultTimeout = opts.timeoutMs ?? 15000;

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  function send(method, params) {
    return cdp.send(method, params, sessionId);
  }

  /**
   * Events arrive for every attached target on one connection, so filter by
   * session. A connection opened straight at a page's own websocket sends no
   * session id at all — those events are ours too.
   * @param {string} event
   * @param {(params: any) => void} handler
   * @returns {() => void}
   */
  function on(event, handler) {
    return cdp.on(event, (params, sid) => {
      if (sid === undefined || sid === sessionId) handler(params);
    });
  }

  for (const domain of DOMAINS) {
    try {
      await send(`${domain}.enable`);
    } catch {
      // Some Electron windows and service-worker-ish targets simply do not have
      // every domain. Losing CSS or Log costs a nicety, not the run.
      detail(`This window does not support ${domain}; carrying on without it.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Console capture — a screen can look perfect and still be on fire.
  // ---------------------------------------------------------------------------

  /** @type {string[]} */
  const errors = [];

  /** @param {string} text */
  function record(text) {
    const line = String(text).trim();
    if (!line) return;
    if (errors.includes(line)) return;
    // Keep the first fifty: the earliest error is usually the cause of the rest.
    if (errors.length >= MAX_CONSOLE_ERRORS) return;
    errors.push(line);
  }

  on('Runtime.consoleAPICalled', (params) => {
    const type = String(params?.type ?? '');
    if (type !== 'error' && type !== 'assert' && type !== 'warning') return;
    const args = Array.isArray(params?.args) ? params.args : [];
    const text = args.map(describeArg).filter(Boolean).join(' ');
    if (type === 'warning') {
      detail(`The page warned: ${text}`);
      return;
    }
    record(text);
  });

  on('Log.entryAdded', (params) => {
    const entry = params?.entry;
    if (!entry) return;
    if (entry.level !== 'error') {
      if (entry.level === 'warning') detail(`The page warned: ${entry.text}`);
      return;
    }
    record(entry.url ? `${entry.text} (${entry.url})` : String(entry.text ?? ''));
  });

  on('Runtime.exceptionThrown', (params) => {
    record(describeException(params?.exceptionDetails));
  });

  function consoleErrors() {
    return errors.slice();
  }

  function clearConsole() {
    errors.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Running JavaScript in the page
  // ---------------------------------------------------------------------------

  /**
   * Run JavaScript in the page.
   *
   * Takes it as text, or as a function to call — see {@link asJavaScript} for why both, and
   * for the message that used to come back when somebody wrote the function.
   *
   * @param {string|Function} js
   * @returns {Promise<any>}
   */
  async function evaluate(js) {
    const res = await send('Runtime.evaluate', {
      expression: asJavaScript(js),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res?.exceptionDetails) {
      throw new StaysFixedError(`The page threw an error: ${describeException(res.exceptionDetails)}`, {
        hint: 'This came from the app itself, not from Stays Fixed. Open the same screen by hand and look at the browser console.',
      });
    }
    return res?.result?.value;
  }

  /**
   * document.readyState, tolerant of being asked mid-navigation (the old
   * execution context is thrown away and the call simply fails).
   * @returns {Promise<string>}
   */
  async function readyState() {
    try {
      return String(await evaluate('document.readyState'));
    } catch {
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // Looking at the page
  // ---------------------------------------------------------------------------

  /**
   * @param {string} selector
   * @returns {Promise<boolean>}
   */
  async function visible(selector) {
    return Boolean(await evaluate(visibleSource(selector)));
  }

  /**
   * @param {string} selector
   * @returns {Promise<boolean>}
   */
  async function exists(selector) {
    return Boolean(await evaluate(`Boolean(document.querySelector(${q(selector)}))`));
  }

  /**
   * @param {string} selector
   * @returns {Promise<string>}
   */
  async function textOf(selector) {
    const value = await evaluate(
      '(function(){var el=document.querySelector(' +
        q(selector) +
        ');if(!el)return "";' +
        'var t=el.innerText;if(typeof t!=="string")t=el.textContent||"";return t.trim();})()',
    );
    return typeof value === 'string' ? value : '';
  }

  /**
   * @param {string} selector
   * @returns {Promise<number>}
   */
  async function count(selector) {
    const n = await evaluate(`document.querySelectorAll(${q(selector)}).length`);
    return typeof n === 'number' ? n : 0;
  }

  /**
   * @param {string} selector
   * @param {boolean} [scroll]
   * @returns {Promise<import('../types.js').MaskRect|null>}
   */
  async function readBox(selector, scroll = false) {
    const box = await evaluate(boxSource(selector, scroll));
    if (!box || typeof box !== 'object') return null;
    return /** @type {import('../types.js').MaskRect} */ ({
      x: Number(box.x),
      y: Number(box.y),
      width: Number(box.width),
      height: Number(box.height),
    });
  }

  /**
   * @param {string} selector
   * @returns {Promise<import('../types.js').MaskRect|null>}
   */
  function boxOf(selector) {
    return readBox(selector, false);
  }

  /** @returns {Promise<string>} */
  async function url() {
    const href = await evaluate('String(window.location.href)');
    return typeof href === 'string' ? href : '';
  }

  /** @returns {Promise<string>} */
  async function title() {
    const t = await evaluate('String(document.title)');
    return typeof t === 'string' ? t : '';
  }

  // ---------------------------------------------------------------------------
  // Waiting
  // ---------------------------------------------------------------------------

  /**
   * @param {string} selector
   * @param {{timeoutMs?: number}} [o]
   * @returns {Promise<void>}
   */
  async function waitFor(selector, o) {
    const timeoutMs = o?.timeoutMs ?? defaultTimeout;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await visible(selector)) return;
      if (Date.now() >= deadline) {
        throw new StaysFixedError(`Waited ${secs(timeoutMs)}s for "${selector}" and it never appeared.`, {
          hint: 'Either the app did not get that far, or the selector no longer matches anything on the screen.',
        });
      }
      await sleep(50);
    }
  }

  /**
   * @param {string} selector
   * @param {{timeoutMs?: number}} [o]
   * @returns {Promise<void>}
   */
  async function waitForGone(selector, o) {
    const timeoutMs = o?.timeoutMs ?? defaultTimeout;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!(await visible(selector))) return;
      if (Date.now() >= deadline) {
        throw new StaysFixedError(`Waited ${secs(timeoutMs)}s for "${selector}" to go away and it is still on screen.`, {
          hint: 'Whatever was meant to close it — a dialog closing, a spinner finishing — did not happen.',
        });
      }
      await sleep(50);
    }
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  async function wait(ms) {
    await sleep(Math.max(0, Number(ms) || 0));
  }

  // ---------------------------------------------------------------------------
  // Going places
  // ---------------------------------------------------------------------------

  /**
   * @param {string} target
   * @returns {Promise<void>}
   */
  async function goto(target) {
    let resolved;
    try {
      resolved = baseUrl ? new URL(target, baseUrl).href : new URL(target).href;
    } catch {
      throw new StaysFixedError(`I cannot open "${target}" because it is not a full address.`, {
        hint: 'Either write the whole address, or set the app address in your config so short paths like "/settings" have something to hang off.',
      });
    }

    let loaded = false;
    // Listen before navigating: the load event can beat the navigate reply back.
    const offLoad = on('Page.loadEventFired', () => {
      loaded = true;
    });

    try {
      const res = await send('Page.navigate', { url: resolved });
      if (res?.errorText) {
        throw new StaysFixedError(`The app could not open ${resolved}: ${res.errorText}.`, {
          hint: 'Check the app is actually running and serving that address.',
        });
      }

      // No loaderId means the page moved inside itself — a hash change or a
      // single-page route. No load event will ever fire for that.
      const sameDocument = !res?.loaderId;
      const deadline = Date.now() + defaultTimeout;
      const patienceForMissedLoad = Date.now() + 1000;

      for (;;) {
        if (loaded) break;
        const state = await readyState();
        if (state === 'complete' && (sameDocument || Date.now() >= patienceForMissedLoad)) break;
        if (Date.now() >= deadline) {
          throw new StaysFixedError(`Waited ${secs(defaultTimeout)}s for ${resolved} to finish loading and it never did.`, {
            hint: 'Something on the page is still working — a request that never answers, or a script that never finishes.',
          });
        }
        await sleep(50);
      }

      // The load event can fire while the document is still settling; the real
      // finish line is readyState.
      while ((await readyState()) !== 'complete') {
        if (Date.now() >= deadline) {
          throw new StaysFixedError(`Waited ${secs(defaultTimeout)}s for ${resolved} to finish loading and it never did.`, {
            hint: 'Something on the page is still working — a request that never answers, or a script that never finishes.',
          });
        }
        await sleep(50);
      }
    } finally {
      offLoad();
    }
  }

  // ---------------------------------------------------------------------------
  // Input — real events, because synthetic ones miss half the handlers
  // ---------------------------------------------------------------------------

  /**
   * @param {string} selector
   * @param {boolean} scroll
   * @returns {Promise<{x: number, y: number}>}
   */
  async function pointFor(selector, scroll) {
    const box = await readBox(selector, scroll);
    if (!box || !(box.width > 0) || !(box.height > 0)) {
      throw new StaysFixedError(`I found "${selector}" but it takes up no space on screen, so there is nothing to click.`, {
        hint: 'It may be collapsed, sized to nothing, or covered by something else.',
      });
    }
    return {
      x: Math.round(Math.max(0, box.x + box.width / 2)),
      y: Math.round(Math.max(0, box.y + box.height / 2)),
    };
  }

  /**
   * Click something, and by default wait for the page to finish reacting.
   *
   * `settle` is the reason a screen recipe does not need `{ wait: 400 }` after a click.
   * A hand-written wait is always a guess: too short and the picture catches the screen
   * half-drawn, too long and every run pays for it forever. Instead we watch the page
   * itself and carry on the moment it stops changing — usually in a fraction of the time
   * somebody would have guessed. Pass `{ settle: false }` for a click that deliberately
   * starts something you want to photograph while it is still happening.
   *
   * @param {string} selector
   * @param {{timeoutMs?: number, settle?: boolean}} [o]
   * @returns {Promise<void>}
   */
  async function click(selector, o) {
    await waitFor(selector, o);

    // A click that was never delivered is the worst kind of failure, because nothing
    // reports it: the coordinates were right, the element was there, the protocol call
    // succeeded, and the app simply never heard about it. On a desktop app it happened
    // about two times in five — the top strip of an Electron window is a drag region the
    // window manager consumes mouse events for, and a control sitting in it gets its
    // clicks eaten. The symptom was a guard failing every other run with no error.
    //
    // So the click is confirmed rather than assumed: arm a one-shot listener, dispatch,
    // and check whether the element actually heard it. If it did not, try again; if a
    // real pointer can never reach it, click the element directly and say so.
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const point = await pointFor(selector, true);
      await arm(selector);
      const base = { x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers: 0 };
      await send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 });
      await send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 });
      await send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
      if (await heard()) {
        await settleAfterClick(o);
        return;
      }
      detail(`click on ${selector} was not delivered (try ${attempt} of ${attempts})`);
      await sleep(120);
    }

    const blocker = await topAt(selector);
    detail(`clicking ${selector} directly; a real pointer could not reach it`, blocker ? `(${blocker} is on top)` : '');
    const done = await evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`
    );
    if (!done) {
      throw new StaysFixedError(`Could not click "${selector}" — it disappeared while I was trying.`);
    }
    await settleAfterClick(o);
  }

  /**
   * Give whatever the click started a chance to finish.
   *
   * `waitForQuietDom` wants the whole launched app because that is what everything else
   * hands it; all it ever touches is `page.evaluate`, and here the page is the one being
   * built, so it is handed exactly that.
   *
   * @param {{settle?: boolean}} [o]
   * @returns {Promise<void>}
   */
  async function settleAfterClick(o) {
    if (o?.settle === false) return;
    const asApp = /** @type {import('../types.js').LaunchedApp} */ (
      /** @type {unknown} */ ({ page: { evaluate } })
    );
    await waitForQuietDom(asApp, { quietMs: CLICK_QUIET_MS, timeoutMs: CLICK_QUIET_CAP_MS });
  }

  /**
   * Arm a one-shot capture listener so we can tell whether a click was really delivered.
   * @param {string} selector
   */
  async function arm(selector) {
    await evaluate(`(() => {
      window.__staysfixed_heard = false;
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.addEventListener('click', function h() { window.__staysfixed_heard = true; }, { once: true, capture: true });
      return true;
    })()`);
  }

  /** @returns {Promise<boolean>} whether the armed element heard the click */
  async function heard() {
    try {
      return Boolean(await evaluate('window.__staysfixed_heard === true'));
    } catch {
      // The page navigated because of the click. That counts as delivered.
      return true;
    }
  }

  /**
   * What is actually on top at the middle of an element — the thing swallowing the click.
   * @param {string} selector
   * @returns {Promise<string|null>}
   */
  async function topAt(selector) {
    try {
      return /** @type {string|null} */ (
        await evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          if (!top || top === el || el.contains(top)) return null;
          return top.tagName.toLowerCase() + (top.className ? '.' + String(top.className).trim().split(/\s+/)[0] : '');
        })()`)
      );
    } catch {
      return null;
    }
  }

  /**
   * @param {string} selector
   * @returns {Promise<void>}
   */
  async function hover(selector) {
    await waitFor(selector);
    const point = await pointFor(selector, true);
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
      buttons: 0,
      modifiers: 0,
    });
  }

  /**
   * Park the pointer where nothing lives.
   *
   * A click leaves the mouse sitting on whatever it just pressed, and that thing stays
   * hovered: a highlighted row, a tooltip, a button in its hover colour. The first real
   * app this tool was pointed at photographed a tooltip nobody meant to capture, and a
   * sidebar that refused to collapse because the pointer was still resting on the arrow
   * that collapses it. Guards hit the same thing, so this is on the page, not buried in
   * the capture path.
   *
   * Park it OUTSIDE the window, not in a corner. The corner was the first attempt and it
   * was wrong in a way worth remembering: (1,1) is the top-left, which is exactly where
   * sidebars, their reveal hot-zones and window controls live. Parking there hovered the
   * very sidebar the picture was meant to show collapsed, and held it open.
   *
   * Past the bottom-right edge there is nothing to hit, so every hovered element gets its
   * mouseout and the page settles into the state a person would see with their hand off
   * the mouse.
   * @returns {Promise<void>}
   */
  async function moveMouseAway() {
    let x = 5000;
    let y = 5000;
    try {
      const size = /** @type {{w: number, h: number}} */ (
        await evaluate('({ w: window.innerWidth || 0, h: window.innerHeight || 0 })')
      );
      if (size && size.w > 0) x = size.w + 50;
      if (size && size.h > 0) y = size.h + 50;
    } catch {
      // No document to ask. The default is far enough outside any real window.
    }
    try {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'none',
        buttons: 0,
        modifiers: 0,
      });
    } catch {
      // A target with no input domain has no hover to clear.
    }
  }

  /**
   * @param {string} key
   * @returns {Promise<void>}
   */
  async function press(key) {
    // "Meta+b", "Control+Shift+P", "Alt+ArrowLeft" — the shortcut a person would type.
    // Shortcuts are how a lot of real apps are actually driven, and a check that can only
    // click cannot reach half of what a keyboard user does.
    const parts = String(key).split('+').filter(Boolean);
    const name = parts.length > 1 ? /** @type {string} */ (parts.pop()) : String(key);
    let modifiers = 0;
    for (const part of parts) {
      const m = part.toLowerCase();
      if (m === 'alt' || m === 'option') modifiers |= 1;
      else if (m === 'ctrl' || m === 'control') modifiers |= 2;
      else if (m === 'meta' || m === 'cmd' || m === 'command') modifiers |= 4;
      else if (m === 'shift') modifiers |= 8;
      else {
        throw new StaysFixedError(`I do not know the key "${part}" in "${key}".`, {
          hint: 'Modifiers are Meta, Control, Alt and Shift, joined with +, e.g. "Meta+b".',
        });
      }
    }

    const entry = KEY_CODES[name];
    if (!entry && modifiers === 0) {
      // Unknown name with no modifiers: treat it as literal text, so press('a') still works.
      await sendChar(name);
      return;
    }

    const single = name.length === 1;
    const upper = single ? name.toUpperCase() : name;
    /** @type {Record<string, unknown>} */
    const common = entry
      ? {
          key: entry.key,
          code: entry.code,
          windowsVirtualKeyCode: entry.keyCode,
          nativeVirtualKeyCode: entry.keyCode,
          modifiers,
        }
      : {
          key: name,
          code: single ? (/[a-z]/i.test(name) ? `Key${upper}` : `Digit${name}`) : name,
          windowsVirtualKeyCode: upper.charCodeAt(0),
          nativeVirtualKeyCode: upper.charCodeAt(0),
          modifiers,
        };

    // A modified key must NOT carry text: sending "b" alongside Meta types a letter into
    // whatever has focus as well as firing the shortcut.
    const withText = Boolean(entry && entry.text) && modifiers === 0;
    await send('Input.dispatchKeyEvent', {
      ...common,
      type: withText ? 'keyDown' : 'rawKeyDown',
      ...(withText && entry && entry.text ? { text: entry.text, unmodifiedText: entry.text } : {}),
    });
    await send('Input.dispatchKeyEvent', { ...common, type: 'keyUp' });
  }


  /**
   * One character, the long way round: a key press the app can listen to, then
   * the character insertion itself.
   * @param {string} ch
   * @returns {Promise<void>}
   */
  async function sendChar(ch) {
    if (ch === '\n' || ch === '\r') {
      await press('Enter');
      return;
    }
    const code = ch.length === 1 ? ch.charCodeAt(0) : 0;
    const virtual = ch.length === 1 ? ch.toUpperCase().charCodeAt(0) : 0;
    /** @type {Record<string, unknown>} */
    const common = {
      key: ch,
      windowsVirtualKeyCode: virtual,
      nativeVirtualKeyCode: virtual,
      modifiers: 0,
    };
    // rawKeyDown, then char: keyDown carrying text would insert the character a
    // second time on top of the char event.
    if (code >= 0x20) {
      await send('Input.dispatchKeyEvent', { ...common, type: 'rawKeyDown' });
      await send('Input.dispatchKeyEvent', { type: 'char', text: ch, key: ch, unmodifiedText: ch, modifiers: 0 });
      await send('Input.dispatchKeyEvent', { ...common, type: 'keyUp' });
    } else {
      await send('Input.dispatchKeyEvent', { type: 'char', text: ch, key: ch, unmodifiedText: ch, modifiers: 0 });
    }
  }

  /**
   * @param {string} selector
   * @param {string} text
   * @returns {Promise<void>}
   */
  async function typeText(selector, text) {
    await click(selector);
    const before = await evaluate(
      '(function(){var el=document.querySelector(' +
        q(selector) +
        ');if(!el)return null;return typeof el.value==="string"?el.value:null;})()',
    );
    for (const ch of String(text)) await sendChar(ch);

    // Some frameworks only listen for their own synthetic input events and never
    // see raw key events at all. If nothing landed, put the value in by hand.
    if (typeof before === 'string') {
      const after = await evaluate(
        '(function(){var el=document.querySelector(' +
          q(selector) +
          ');if(!el)return null;return typeof el.value==="string"?el.value:null;})()',
      );
      if (after === before) {
        await evaluate(
          '(function(){var el=document.querySelector(' +
            q(selector) +
            ');if(!el)return false;var v=' +
            JSON.stringify(before + String(text)) +
            ';' +
            // React replaces the value setter on the element itself, so the only
            // way it notices a change is through the prototype's original setter.
            'var proto=(window.HTMLTextAreaElement&&el instanceof window.HTMLTextAreaElement)?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;' +
            'var d=Object.getOwnPropertyDescriptor(proto,"value");' +
            'if(d&&d.set){d.set.call(el,v);}else{el.value=v;}' +
            'el.dispatchEvent(new Event("input",{bubbles:true}));' +
            'el.dispatchEvent(new Event("change",{bubbles:true}));' +
            'return true;})()',
        );
      }
    }
  }

  /**
   * @param {string} selector
   * @returns {Promise<void>}
   */
  async function scrollTo(selector) {
    await waitFor(selector);
    await evaluate(boxSource(selector, true));
    // Smooth scrolling may be off, but the app may still be animating something
    // of its own. Wait until the page stops moving before anyone takes a picture.
    const deadline = Date.now() + defaultTimeout;
    let previous = await evaluate('window.scrollY');
    for (;;) {
      await sleep(100);
      const now = await evaluate('window.scrollY');
      if (now === previous) return;
      previous = now;
      if (Date.now() >= deadline) return;
    }
  }

  // ---------------------------------------------------------------------------
  // Window and pictures
  // ---------------------------------------------------------------------------

  /**
   * @param {import('../types.js').ViewportConfig} v
   * @returns {Promise<void>}
   */
  async function setViewport(v) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: Math.round(v.width),
      height: Math.round(v.height),
      deviceScaleFactor: v.deviceScaleFactor ?? 1,
      mobile: Boolean(v.mobile),
    });
    try {
      await send('Emulation.setVisibleSize', { width: Math.round(v.width), height: Math.round(v.height) });
    } catch {
      // Gone from newer Chrome. The metrics override above already did the work.
    }
  }

  /**
   * Take a picture of the window.
   *
   * `format: 'jpeg'` with a `quality` exists for one caller: the settle loop, which
   * shoots the same screen over and over only to ask whether anything moved. Those frames
   * are thrown away, never compared against an approved picture and never written to
   * disk, so a cheap lossy encode is the right tool — it costs a fraction of a full-size
   * retina PNG and two JPEGs of one unchanged frame are byte-for-byte identical, which is
   * the whole question. Every kept picture is a PNG, which is the default.
   *
   * @param {import('../types.js').CaptureOptions & {format?: 'png'|'jpeg', quality?: number}} [captureOpts]
   * @returns {Promise<Buffer>}
   */
  async function shoot(captureOpts) {
    const o = captureOpts ?? {};
    /** @type {{x: number, y: number, width: number, height: number, scale: number}|null} */
    let clip = null;

    if (o.fullPage) {
      const metrics = await send('Page.getLayoutMetrics');
      const content = metrics?.cssContentSize ?? metrics?.contentSize ?? null;
      if (content) {
        clip = {
          x: 0,
          y: 0,
          // Whole pixels only: a layout that lands on a half pixel would
          // otherwise change the picture's size between runs.
          width: Math.min(MAX_CAPTURE_SIDE, Math.ceil(Number(content.width))),
          height: Math.min(MAX_CAPTURE_SIDE, Math.ceil(Number(content.height))),
          scale: 1,
        };
      }
    } else if (o.rect) {
      clip = {
        x: Math.round(o.rect.x),
        y: Math.round(o.rect.y),
        width: Math.round(o.rect.width),
        height: Math.round(o.rect.height),
        scale: 1,
      };
    } else if (o.clip) {
      const box = await readBox(o.clip, false);
      if (!box || !(box.width > 0) || !(box.height > 0)) {
        throw new StaysFixedError(`I cannot photograph "${o.clip}" because it takes up no space on screen.`, {
          hint: 'Check the screen really shows that element by the time the picture is taken.',
        });
      }
      clip = {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
        scale: 1,
      };
    }

    const jpeg = o.format === 'jpeg';
    /** @type {Record<string, unknown>} */
    const params = {
      format: jpeg ? 'jpeg' : 'png',
      captureBeyondViewport: Boolean(o.fullPage),
      fromSurface: true,
    };
    // Chrome ignores quality on a PNG, and refuses a value outside 0..100.
    if (jpeg) params.quality = Math.max(0, Math.min(100, Math.round(o.quality ?? 50)));
    if (clip) params.clip = clip;

    const res = await send('Page.captureScreenshot', params);
    if (!res?.data) {
      throw new StaysFixedError('The window gave back an empty picture.', {
        hint: 'This usually means the window was hidden or had just closed. Try again with the app in the foreground.',
      });
    }
    return Buffer.from(String(res.data), 'base64');
  }

  // ---------------------------------------------------------------------------
  // Scripts and styles we push into the page
  // ---------------------------------------------------------------------------

  /**
   * @param {string} source
   * @returns {Promise<string>}
   */
  async function addInitScript(source) {
    const res = await send('Page.addScriptToEvaluateOnNewDocument', { source });
    return String(res?.identifier ?? '');
  }

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function removeInitScript(id) {
    if (!id) return;
    try {
      await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id });
    } catch {
      // Already gone, or the page went away first. Nothing to undo.
    }
  }

  /** @type {Map<string, {styleSheetId?: string, initId?: string, token: string}>} */
  const styles = new Map();
  let styleCounter = 0;

  /**
   * @param {string} css
   * @returns {Promise<string>}
   */
  async function insertCss(css) {
    styleCounter += 1;
    const token = `staysfixed-style-${styleCounter}`;
    const source = styleTagSource(css, token);

    // The stylesheet dies on navigation, so the same CSS also goes in as an init
    // script. On this document only the stylesheet applies; after a navigation
    // only the tag does — never both, so nothing is applied twice.
    let initId = '';
    try {
      initId = await addInitScript(source);
    } catch {
      detail('This window will not keep styles across navigation; applying them to the current page only.');
    }

    /** @type {string|undefined} */
    let styleSheetId;
    try {
      const tree = await send('Page.getFrameTree');
      const frameId = tree?.frameTree?.frame?.id;
      if (!frameId) throw new Error('no frame');
      const sheet = await send('CSS.createStyleSheet', { frameId });
      styleSheetId = String(sheet?.styleSheetId ?? '');
      if (!styleSheetId) throw new Error('no stylesheet');
      await send('CSS.setStyleSheetText', { styleSheetId, text: css });
    } catch {
      // No CSS domain on this window (common in Electron). Push a plain <style>
      // tag in instead — same result, one more element in the DOM.
      styleSheetId = undefined;
      await evaluate(source);
    }

    const id = `${styleSheetId ? 'sheet' : 'style'}:${styleCounter}`;
    styles.set(id, { styleSheetId, initId, token });
    return id;
  }

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function removeCss(id) {
    const entry = styles.get(id);
    if (!entry) return;
    styles.delete(id);

    if (entry.styleSheetId) {
      try {
        // CDP has no "delete stylesheet"; emptying it is the removal.
        await send('CSS.setStyleSheetText', { styleSheetId: entry.styleSheetId, text: '' });
      } catch {
        // The page navigated away and took the stylesheet with it.
      }
    }
    if (entry.initId) await removeInitScript(entry.initId);
    try {
      await evaluate(removeStyleTagSource(entry.token));
    } catch {
      // Nothing to take out.
    }
  }

  /** @type {import('../types.js').PageHandle} */
  const page = {
    goto,
    click,
    type: typeText,
    press,
    hover,
    moveMouseAway,
    waitFor,
    waitForGone,
    scrollTo,
    wait,
    evaluate,
    visible,
    exists,
    textOf,
    count,
    boxOf,
    url,
    title,
    shoot,
    setViewport,
    consoleErrors,
    send,
    on,
    sessionId,
    targetId,
    addInitScript,
    removeInitScript,
    insertCss,
    removeCss,
    baseUrl,
    clearConsole,
  };
  return page;
}
