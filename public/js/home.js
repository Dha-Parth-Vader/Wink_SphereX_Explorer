// Home page blink demo on the simulated sample patch. Never autoplays; Play doubles as Pause.
(function () {
  "use strict";
  const MAX_SWAPS_PER_S = 3;
  const SWAPS_PER_S = Math.min(2, MAX_SWAPS_PER_S);
  const SIZE = 147;
  // the sample's fast mover, in PNG pixels, per date (see tools/make_sample_data.py)
  const MOVER = [{ x: 73, y: 80 }, { x: 73, y: 78 }, { x: 73, y: 76 }];
  const MJDS = [60810.4, 60995.6, 61180.3];

  const canvas = document.getElementById("demo-canvas");
  const ctx = canvas.getContext("2d");
  const playBtn = document.getElementById("demo-play");
  const hintBtn = document.getElementById("demo-hint");
  const stamp = document.getElementById("demo-stamp");
  const ring = document.getElementById("demo-ring");
  const status = document.getElementById("demo-status");

  const images = [];
  let index = 0;
  let timer = null;
  let lastSwap = 0;

  function dateOf(mjd) {
    return new Date(Date.UTC(1858, 10, 17) + mjd * 86400000).toISOString().slice(0, 10);
  }

  function show(i) {
    index = i;
    const img = images[i];
    if (img && img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, SIZE, SIZE);
    stamp.textContent = "Date " + (i + 1) + " of " + images.length + " · " + dateOf(MJDS[i]);
    ring.style.left = (MOVER[i].x + 0.5) / SIZE * 100 + "%";
    ring.style.top = (MOVER[i].y + 0.5) / SIZE * 100 + "%";
  }

  function tick() {
    const now = performance.now();
    // hard cap: never more than 3 swaps per second, whatever the timer does
    if (now - lastSwap < 1000 / MAX_SWAPS_PER_S) return;
    lastSwap = now;
    show((index + 1) % images.length);
  }

  function setPlaying(on) {
    clearInterval(timer);
    timer = on ? setInterval(tick, 1000 / SWAPS_PER_S) : null;
    playBtn.textContent = on ? "❚❚ Pause" : "▶ Blink";
    playBtn.setAttribute("aria-pressed", String(on));
    status.textContent = on ? "Blinking at " + SWAPS_PER_S + " dates per second." : "Paused on date " + (index + 1) + ".";
  }

  for (let v = 0; v < MJDS.length; v++) {
    const img = new Image();
    img.onload = () => { if (v === index) show(index); };
    img.onerror = () => { status.textContent = "The demo pictures didn't load. Try the Search Tool instead."; playBtn.disabled = true; };
    img.src = "data/frames/sample/v0" + v + "_all.png";
    images.push(img);
  }
  ctx.imageSmoothingEnabled = false;
  show(0);

  playBtn.addEventListener("click", () => setPlaying(timer == null));
  hintBtn.addEventListener("click", () => {
    const on = ring.hidden;
    ring.hidden = !on;
    hintBtn.setAttribute("aria-pressed", String(on));
    hintBtn.textContent = on ? "Hide hint" : "Show me where";
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden && timer) setPlaying(false); });
})();
