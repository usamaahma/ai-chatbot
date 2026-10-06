/*!
 * Talking head: lip-syncs a still photo on a <canvas>.
 *
 * The mouth "opens" by warping the photo column by column: the lower lip and
 * jaw are pushed down (most at the centre of the mouth, not at all at the
 * corners) and the gap is filled with a dark mouth interior. How far it opens
 * follows the text being spoken, letter by letter, re-synced on every word
 * boundary event from speechSynthesis.
 *
 *   var head = TalkingHead.create(canvas, '/avatar-csr.jpg', { onError: fn });
 *   head.start('Hello there', 1.03);   // when an utterance starts
 *   head.sync(charIndex);              // on utterance 'boundary' events
 *   head.stop();                       // when it ends
 */
(function () {
  'use strict';

  // Geometry in source-image pixels (avatar-csr.jpg is 620 x 620).
  // Re-measure these if the photo is replaced.
  var FACE = {
    crop: { x: 0, y: 0, size: 620 }, // square shown in the round frame
    mouthX: 312,        // centre of the mouth
    lipLine: 464,       // where the lips meet
    halfWidth: 60,      // how far from centre the mouth opens (corners stay closed)
    upperLipTop: 449,   // upper lip is lifted slightly between here and lipLine
    jawBottom: 552,     // lower face is compressed between lipLine and here
    maxOpen: 17,        // jaw drop at full open
    liftRatio: 0.12,    // how much the upper lip lifts relative to the jaw drop
    teeth: true,        // lips are closed in this photo, so hint at teeth when open
  };

  // How open the mouth is for each letter (0 closed .. 1 wide).
  function visemeFor(ch) {
    if (!ch) return 0;
    ch = ch.toLowerCase();
    if ('ao'.indexOf(ch) !== -1) return 1;
    if (ch === 'e' || ch === 'i') return 0.65;
    if (ch === 'u' || ch === 'w' || ch === 'y') return 0.45;
    if ('mbp'.indexOf(ch) !== -1) return 0;
    if (ch === 'f' || ch === 'v') return 0.12;
    if (/[a-z0-9]/.test(ch)) return 0.3;
    if (ch === ' ') return 0.08;
    return 0; // punctuation: pause with lips closed
  }

  // Seconds of "pause" a character costs on the timeline, relative to a letter.
  function weightFor(ch) {
    if (/[.!?]/.test(ch)) return 4;
    if (/[,;:]/.test(ch)) return 2.5;
    return 1;
  }

  function create(canvas, src, opts) {
    opts = opts || {};
    var ctx = canvas.getContext('2d');
    var img = new Image();
    var ready = false;

    // speech timeline
    var text = '';
    var marks = [];     // cumulative weight at each character
    var cps = 14;       // letters per second at rate 1
    var anchorIdx = 0;  // char index at anchorTime
    var anchorTime = 0;
    var speaking = false;

    var open = 0;       // smoothed openness 0..1
    var target = 0;
    var raf = 0;

    img.onload = function () { ready = true; draw(); };
    img.onerror = function () { if (opts.onError) opts.onError(); };
    img.src = src;

    function fitCanvas() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var w = Math.round((canvas.clientWidth || 160) * dpr);
      if (canvas.width !== w || canvas.height !== w) { canvas.width = w; canvas.height = w; }
    }

    function draw() {
      if (!ready) return;
      fitCanvas();
      var c = FACE.crop;
      var k = canvas.width / c.size;
      ctx.setTransform(k, 0, 0, k, -c.x * k, -c.y * k);
      ctx.drawImage(img, 0, 0);

      var s = open * FACE.maxOpen;
      if (s < 0.3) return;

      var lift = s * FACE.liftRatio;
      var x0 = Math.floor(FACE.mouthX - FACE.halfWidth);
      var x1 = Math.ceil(FACE.mouthX + FACE.halfWidth);
      var lower = FACE.jawBottom - FACE.lipLine;
      var upper = FACE.lipLine - FACE.upperLipTop;
      // 0 at the mouth corners, 1 at the centre
      function prof(x) {
        var t = (x - FACE.mouthX) / FACE.halfWidth;
        return Math.abs(t) >= 1 ? 0 : Math.pow(Math.cos(t * Math.PI / 2), 0.7);
      }
      var x;

      // 1. mouth interior as one smooth shape
      ctx.save();
      ctx.filter = 'blur(' + (FACE.crop.size / 590).toFixed(2) + 'px)';
      ctx.beginPath();
      for (x = x0; x <= x1; x++) ctx.lineTo(x, FACE.lipLine - lift * prof(x));
      for (x = x1; x >= x0; x--) ctx.lineTo(x, FACE.lipLine + s * prof(x));
      ctx.closePath();
      var g = ctx.createLinearGradient(0, FACE.lipLine - lift, 0, FACE.lipLine + s);
      g.addColorStop(0, '#140807');
      g.addColorStop(0.6, '#2a110e');
      g.addColorStop(1, '#3d1a16');
      ctx.fillStyle = g;
      ctx.fill();

      // 2. a soft hint of upper teeth when open wide
      if (FACE.teeth && s > FACE.maxOpen * 0.45) {
        ctx.beginPath();
        var tx0 = FACE.mouthX - FACE.halfWidth * 0.6;
        var tx1 = FACE.mouthX + FACE.halfWidth * 0.6;
        for (x = tx0; x <= tx1; x++) ctx.lineTo(x, FACE.lipLine - lift * prof(x));
        for (x = tx1; x >= tx0; x--) ctx.lineTo(x, FACE.lipLine - lift * prof(x) + Math.min(FACE.maxOpen * 0.25, s * 0.24) * prof(x));
        ctx.closePath();
        ctx.fillStyle = 'rgba(214,204,192,' + Math.min(0.75, (s / FACE.maxOpen - 0.45) * 2) + ')';
        ctx.fill();
      }
      ctx.restore();

      // 3. upper lip squeezed up, lower lip + jaw squeezed down, column by column
      for (x = x0; x <= x1; x++) {
        var p = prof(x);
        var drop = s * p;
        if (drop < 0.2) continue;
        var up = lift * p;
        ctx.drawImage(img, x, FACE.upperLipTop, 1, upper, x, FACE.upperLipTop, 1.5, upper - up);
        ctx.drawImage(img, x, FACE.lipLine, 1, lower, x, FACE.lipLine + drop, 1.5, lower - drop);
      }
    }

    function charAt(now) {
      var elapsed = (now - anchorTime) / 1000 * cps + (marks[anchorIdx] || 0);
      // binary search the cumulative weights
      var lo = anchorIdx, hi = marks.length - 1;
      if (hi < 0 || elapsed >= marks[hi]) return -1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (marks[mid + 1] <= elapsed) lo = mid + 1; else hi = mid;
      }
      return lo;
    }

    function tick(now) {
      raf = 0;
      if (speaking) {
        var i = charAt(now);
        target = i < 0 ? 0 : visemeFor(text[i]);
        // small jitter so repeated letters don't look mechanical
        if (target > 0.2) target *= 0.85 + Math.random() * 0.25;
      } else {
        target = 0;
      }
      open += (target - open) * (target > open ? 0.5 : 0.35);
      if (open < 0.01 && !speaking) open = 0;
      draw();
      if (speaking || open > 0) raf = requestAnimationFrame(tick);
    }

    function loop() { if (!raf) raf = requestAnimationFrame(tick); }

    window.addEventListener('resize', function () { draw(); });

    return {
      start: function (utterText, rate) {
        text = String(utterText || '');
        marks = [];
        var sum = 0;
        for (var i = 0; i < text.length; i++) { marks.push(sum); sum += weightFor(text[i]); }
        marks.push(sum);
        cps = 14 * (rate || 1);
        anchorIdx = 0;
        anchorTime = performance.now();
        speaking = true;
        loop();
      },
      // Re-anchor the timeline to the real speech position (word boundary).
      sync: function (charIndex) {
        if (!speaking || charIndex == null || charIndex < 0 || charIndex >= text.length) return;
        anchorIdx = charIndex;
        anchorTime = performance.now();
      },
      stop: function () {
        speaking = false;
        loop();
      },
      redraw: draw,
      // Hold a fixed openness (0..1), for previews and testing.
      pose: function (v) { speaking = false; open = v; draw(); },
    };
  }

  window.TalkingHead = { create: create };
})();
