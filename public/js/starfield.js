// Decorative starry background for the Home page. Gentle twinkle only; still when the user prefers less motion.
(function () {
  "use strict";
  const canvas = document.querySelector(".starfield");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  let stars = [];
  let frame = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    const count = Math.round((window.innerWidth * window.innerHeight) / 3500);
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    stars = Array.from({ length: count }, () => ({
      x: rand() * canvas.width,
      y: rand() * canvas.height,
      r: (rand() ** 3 * 1.6 + 0.3) * dpr,
      a: 0.25 + rand() * 0.65,
      speed: 0.4 + rand() * 1.2,
      phase: rand() * Math.PI * 2,
      warm: rand() < 0.15,
    }));
    draw(0);
  }

  function draw(t) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of stars) {
      const tw = still.matches ? 1 : 0.75 + 0.25 * Math.sin(t * 0.001 * s.speed + s.phase);
      ctx.globalAlpha = s.a * tw;
      ctx.fillStyle = s.warm ? "#ffd9a8" : "#dbe7ff";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function loop(t) {
    draw(t);
    frame = requestAnimationFrame(loop);
  }

  function start() {
    cancelAnimationFrame(frame);
    if (!still.matches && !document.hidden) frame = requestAnimationFrame(loop);
  }

  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", start);
  if (still.addEventListener) still.addEventListener("change", () => { draw(0); start(); });
  resize();
  start();
})();
