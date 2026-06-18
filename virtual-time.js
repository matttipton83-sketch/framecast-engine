// virtual-time.js
// Injected into the page BEFORE any of its own scripts run.
// It replaces the browser's sense of time with a clock that only moves when
// the renderer tells it to. This is what makes capture deterministic: every
// frame is computed fully before we screenshot it, so nothing is ever dropped
// or half-rendered — no matter how slow the machine is.
//
// Covers BOTH worlds:
//   • JavaScript animation  -> Date / performance.now / rAF / timers virtualized
//   • CSS & Web Animations  -> document.getAnimations() paused and seeked
// (Most open-source tools only do the first and silently break CSS keyframes.)

module.exports = function virtualTimeScript() {
  return `(() => {
    if (window.__framecast) return;
    const RealDate = Date;
    const realPerfNow = performance.now.bind(performance);
    let now = 0;                  // virtual milliseconds since start
    let rafQueue = [];            // {id, cb}
    let rafId = 0;
    let timers = [];              // {id, cb, time, interval, args}
    let timerId = 0;

    // --- performance.now ---
    const perf = window.performance;
    perf.now = () => now;

    // --- Date ---
    function FakeDate(...a) {
      if (a.length === 0) return new RealDate(now);
      return new RealDate(...a);
    }
    FakeDate.now = () => now;
    FakeDate.parse = RealDate.parse;
    FakeDate.UTC = RealDate.UTC;
    FakeDate.prototype = RealDate.prototype;
    Object.setPrototypeOf(FakeDate, RealDate);
    window.Date = FakeDate;

    // --- requestAnimationFrame ---
    window.requestAnimationFrame = (cb) => { rafId++; rafQueue.push({ id: rafId, cb }); return rafId; };
    window.cancelAnimationFrame = (id) => { rafQueue = rafQueue.filter(c => c.id !== id); };
    window.webkitRequestAnimationFrame = window.requestAnimationFrame;
    window.webkitCancelAnimationFrame = window.cancelAnimationFrame;

    // --- timers ---
    const realSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (cb, delay = 0, ...args) => {
      if (typeof cb !== 'function') return 0;
      timerId++; timers.push({ id: timerId, cb, time: now + (+delay || 0), interval: null, args });
      return timerId;
    };
    window.clearTimeout = (id) => { timers = timers.filter(t => t.id !== id); };
    window.setInterval = (cb, delay = 0, ...args) => {
      if (typeof cb !== 'function') return 0;
      timerId++; timers.push({ id: timerId, cb, time: now + (+delay || 0), interval: (+delay || 0), args });
      return timerId;
    };
    window.clearInterval = (id) => { timers = timers.filter(t => t.id !== id); };

    // --- the controller the renderer drives from Node ---
    window.__framecast = {
      now: () => now,
      // advance virtual time to target ms, firing due timers (in order) then one rAF batch
      tick: (target) => {
        let guard = 0;
        while (true) {
          timers.sort((a, b) => a.time - b.time);
          const next = timers.find(t => t.time <= target);
          if (!next) break;
          timers = timers.filter(t => t !== next);
          now = next.time;
          try { next.cb(...(next.args || [])); } catch (e) {}
          if (next.interval != null) { next.time = now + (next.interval || 0); timers.push(next); }
          if (++guard > 200000) break; // runaway protection
        }
        now = target;
        const batch = rafQueue; rafQueue = [];
        for (const c of batch) { try { c.cb(now); } catch (e) {} }
      },
      // pause & seek every CSS animation / WAAPI animation / SMIL to the virtual time
      seekDeclarative: (t) => {
        try {
          (document.getAnimations ? document.getAnimations() : []).forEach(a => {
            try { a.pause(); a.currentTime = t; } catch (e) {}
          });
        } catch (e) {}
        // SVG SMIL
        try { if (document.documentElement.setCurrentTime) document.documentElement.setCurrentTime(t / 1000); } catch (e) {}
        // pause any <video> and seek it
        try { document.querySelectorAll('video').forEach(v => { try { v.pause(); v.currentTime = t / 1000; } catch (e) {} }); } catch (e) {}
      },
      // best-effort: longest finite declarative animation duration (ms), 0 if none/infinite-only
      longestFiniteMs: () => {
        let max = 0; let sawInfinite = false;
        try {
          (document.getAnimations ? document.getAnimations() : []).forEach(a => {
            const tm = a.effect && a.effect.getTiming ? a.effect.getTiming() : {};
            const iters = tm.iterations;
            const dur = tm.duration;
            if (iters === Infinity) { sawInfinite = true; return; }
            if (typeof dur === 'number' && isFinite(dur)) {
              const total = dur * (iters || 1) + (tm.delay || 0);
              if (total > max) max = total;
            }
          });
        } catch (e) {}
        return { max, sawInfinite };
      },
    };
  })();`;
};
