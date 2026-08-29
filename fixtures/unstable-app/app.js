/*
 * Every trick that normally ruins a screenshot, in one file.
 *
 * Nothing here is contrived for the sake of it: a ticking clock, a relative
 * timestamp, an infinite spinner, a Web Animations tween, seeded-looking random
 * data, a chart drawn from Math.random, a blinking caret, an autofocused input,
 * a feed that changes on every load, a font that swaps in, and an image that
 * arrives late are all things real apps do. Freeze all of them and a picture is
 * trustworthy; miss one and the tool cries wolf.
 */

(function () {
  var WORDS = [
    'harbour', 'lantern', 'thicket', 'compass', 'granite', 'meadow',
    'orbit', 'saffron', 'tundra', 'velvet', 'wharf', 'zephyr',
  ];

  // A fixed point in the past. The page shows how long ago it was, so the text
  // changes every second unless somebody has stopped the clock.
  var POSTED_AT = Date.parse('2026-01-01T11:57:00.000Z');

  var LATE_IMAGE =
    'data:image/svg+xml;base64,' +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80">' +
        '<rect width="200" height="80" fill="#e6efff"/>' +
        '<circle cx="46" cy="40" r="22" fill="#1f6feb"/>' +
        '<rect x="82" y="24" width="96" height="10" rx="5" fill="#7aa7f5"/>' +
        '<rect x="82" y="46" width="62" height="10" rx="5" fill="#c3d7fb"/>' +
        '</svg>'
    );

  function el(sel) {
    return document.querySelector('[data-sf="' + sel + '"]');
  }

  function two(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function ago(ms) {
    var seconds = Math.round(ms / 1000);
    if (seconds < 60) return seconds + ' seconds ago';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
    var hours = Math.round(minutes / 60);
    if (hours < 48) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    return Math.round(hours / 24) + ' days ago';
  }

  // ---- the clock, ten times a second -------------------------------------
  function tick() {
    var now = new Date();
    el('clock').textContent =
      two(now.getUTCHours()) + ':' + two(now.getUTCMinutes()) + ':' + two(now.getUTCSeconds());
    el('stamp').textContent = now.toISOString();
    el('ago').textContent = 'Posted ' + ago(now.getTime() - POSTED_AT);
  }
  tick();
  setInterval(tick, 100);

  // ---- a Web Animations tween started from script -------------------------
  var slider = el('slider');
  if (slider && slider.animate) {
    slider.animate(
      [{ transform: 'translateX(0px)' }, { transform: 'translateX(120px)' }],
      { duration: 1400, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' }
    );
  }

  // ---- randomness ---------------------------------------------------------
  el('number').textContent = Math.random().toFixed(9);
  el('uuid').textContent =
    typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'no crypto here';

  var shuffled = WORDS.slice();
  for (var i = shuffled.length - 1; i > 0; i -= 1) {
    var j = Math.floor(Math.random() * (i + 1));
    var swap = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = swap;
  }
  var list = el('shuffled');
  shuffled.forEach(function (word) {
    var li = document.createElement('li');
    li.textContent = word;
    list.appendChild(li);
  });

  var bars = el('bars');
  for (var b = 0; b < 14; b += 1) {
    var bar = document.createElement('i');
    bar.style.height = (12 + Math.round(Math.random() * 88)) + '%';
    bars.appendChild(bar);
  }

  // ---- a feed that is different every load --------------------------------
  var feed = el('feed');
  fetch('/api/feed')
    .then(function (r) {
      return r.json();
    })
    .then(function (data) {
      feed.textContent = '';
      data.items.forEach(function (item) {
        var row = document.createElement('div');
        var left = document.createElement('span');
        left.textContent = item.word + ' · ' + item.id;
        var right = document.createElement('b');
        right.textContent = String(item.score);
        row.appendChild(left);
        row.appendChild(right);
        feed.appendChild(row);
      });
    })
    .catch(function () {
      feed.textContent = 'the feed did not answer';
    });

  // ---- an image that turns up after everything else -----------------------
  setTimeout(function () {
    el('late-image').src = LATE_IMAGE;
  }, 200);

  // ---- two routes ---------------------------------------------------------
  var home = document.getElementById('view-home');
  var details = document.getElementById('view-details');
  var slowAsked = false;

  function show() {
    var onDetails = location.hash === '#/details';
    home.hidden = onDetails;
    details.hidden = !onDetails;
    if (onDetails) {
      el('details-time').textContent = new Date().toISOString();
      if (!slowAsked) {
        slowAsked = true;
        // Deliberately answers after 400ms, so anything that photographs the
        // details page too eagerly catches it half-drawn.
        fetch('/slow')
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            var dd = document.createElement('dd');
            dd.className = 'mono';
            dd.setAttribute('data-sf', 'slow-note');
            dd.textContent = 'the slow route answered after ' + data.waitedMs + 'ms';
            var dt = document.createElement('dt');
            dt.textContent = 'Slow route';
            var pairs = details.querySelector('.pairs');
            pairs.appendChild(dt);
            pairs.appendChild(dd);
          })
          .catch(function () {});
      }
    }
  }

  el('go-details').addEventListener('click', function () {
    location.hash = '#/details';
  });
  el('go-home').addEventListener('click', function () {
    location.hash = '';
  });
  el('back').addEventListener('click', function () {
    location.hash = '';
  });
  window.addEventListener('hashchange', show);
  show();
})();
