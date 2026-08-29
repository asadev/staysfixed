/**
 * Seeding randomness.
 *
 * Randomness reaches a picture in more places than people expect: a shuffled list, a
 * placeholder avatar colour, a chart's jitter, a React key printed into a data attribute,
 * an "id" on a tooltip that ends up in the accessibility tree. Any one of them makes a
 * screen that never matches itself twice.
 *
 * The real functions stay reachable on window.__staysfixed_realRandom, because a handful
 * of apps genuinely need unpredictable bytes (a crypto key, a WebRTC session) and would
 * break rather than merely look different.
 */

/**
 * @param {number} seed
 * @returns {string} JavaScript to evaluate in the page
 */
export function randomScript(seed) {
  const start = Number.isFinite(seed) ? Math.trunc(seed) : 20260101;

  return `(function () {
  if (window.__staysfixed_realRandom) return;

  var SEED = ${start};

  // mulberry32: 32 bits of state, no dependencies, well-distributed enough that a
  // shuffled list still looks shuffled — and identical on every machine, every run.
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var rand = mulberry32(SEED);
  var cryptoObj = window.crypto || null;

  var real = {
    random: Math.random,
    getRandomValues: cryptoObj && cryptoObj.getRandomValues ? cryptoObj.getRandomValues.bind(cryptoObj) : null,
    randomUUID: cryptoObj && cryptoObj.randomUUID ? cryptoObj.randomUUID.bind(cryptoObj) : null,
    reseed: function (n) { rand = mulberry32(n | 0); uuidCount = 0; }
  };
  window.__staysfixed_realRandom = real;

  Math.random = rand;

  function seededFill(arr) {
    if (!arr || typeof arr !== 'object' || !('byteLength' in arr)) {
      throw new TypeError('Expected a typed array');
    }
    // Fill the underlying bytes rather than the elements, so a Uint32Array and a
    // Uint8Array over the same buffer both come out of the same stream.
    var view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    for (var i = 0; i < view.length; i++) view[i] = (rand() * 256) & 255;
    return arr;
  }

  var uuidCount = 0;
  function seededUUID() {
    // Counter-based, but shaped like a real v4 (version nibble 4, variant nibble 8) so
    // anything that validates the format still accepts it.
    var hex = (++uuidCount).toString(16);
    while (hex.length < 32) hex = '0' + hex;
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) +
      '-8' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
  }

  if (cryptoObj) {
    try { cryptoObj.getRandomValues = seededFill; } catch (e) {}
    if (cryptoObj.getRandomValues !== seededFill) {
      try {
        Object.defineProperty(cryptoObj, 'getRandomValues', { value: seededFill, configurable: true, writable: true });
      } catch (e) {}
    }
    try { cryptoObj.randomUUID = seededUUID; } catch (e) {}
    if (cryptoObj.randomUUID !== seededUUID) {
      try {
        Object.defineProperty(cryptoObj, 'randomUUID', { value: seededUUID, configurable: true, writable: true });
      } catch (e) {}
    }
  }
})();`;
}
