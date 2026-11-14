(function () {
  "use strict";
  const { el } = window.SkyBlink;
  const navList = document.getElementById("chapter-nav");
  const holder = document.getElementById("chapters");

  function block(b) {
    if (b.p) return el("p", {}, b.p);
    if (b.list) return el("ul", {}, b.list.map((item) => el("li", {}, item)));
    if (b.try) return el("p", { class: "try" }, b.try);
    if (b.links) {
      const parts = [];
      b.links.forEach(([label, href], i) => {
        if (i) parts.push(" · ");
        parts.push(el("a", { href, rel: "noopener", target: "_blank" }, label + " ↗"));
      });
      return el("p", { class: "links" }, parts);
    }
    return null;
  }

  window.LEARN_CHAPTERS.forEach((ch, ci) => {
    const sub = el("ol", { class: "sub" }, ch.sections.map((s) =>
      el("li", {}, el("a", { href: "#" + s.id, "data-target": s.id }, s.title))));
    navList.append(el("li", {}, [el("a", { href: "#" + ch.id, "data-target": ch.id }, (ci + 1) + ". " + ch.title), sub]));

    holder.append(el("section", { class: "chapter", id: ch.id, "aria-labelledby": ch.id + "-title" }, [
      el("header", {}, [
        el("div", { class: "kicker" }, "Chapter " + (ci + 1)),
        el("h2", { id: ch.id + "-title" }, ch.title),
        el("p", { class: "muted" }, ch.intro),
      ]),
      ...ch.sections.map((s) => el("article", { class: "card lesson", id: s.id }, [
        el("h3", {}, s.title),
        ...s.blocks.map(block),
      ])),
    ]));
  });

  // highlight the chapter in view
  const links = [...navList.querySelectorAll(":scope > li > a")];
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        links.forEach((a) => a.setAttribute("aria-current", String(a.dataset.target === e.target.id)));
      }
    }, { rootMargin: "-30% 0px -60% 0px" });
    holder.querySelectorAll(".chapter").forEach((c) => io.observe(c));
  }
})();
