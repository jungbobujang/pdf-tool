/* 안내 페이지(/check · /privacy · /licenses) 공용: 버전 표시 + 움직이는 예시(보일 때만 재생) */
(function () {
  'use strict';
  const meta = document.querySelector('meta[name="app-version"]');
  const commit = meta && meta.content;
  if (commit) document.querySelectorAll('.app-version').forEach((el) => { el.textContent = `v ${commit}`; });

  const demos = [];
  if (window.GuideAnim) {
    document.querySelectorAll('figure.demo[data-demo]').forEach((fig) => {
      try {
        demos.push({ fig, anim: window.GuideAnim.create(fig.querySelector('.demo-stage'), fig.dataset.demo), seen: false });
      } catch (e) { console.warn(e); }
    });
  }
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  function sync() {
    demos.forEach((d) => {
      if (still.matches) d.anim.showLast();
      else if (d.seen && !document.hidden) d.anim.play();
      else d.anim.pause();
    });
  }
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((list) => {
      list.forEach((en) => {
        const d = demos.find((x) => x.fig === en.target);
        if (d) d.seen = en.isIntersecting;
      });
      sync();
    });
    demos.forEach((d) => io.observe(d.fig));
  } else {
    demos.forEach((d) => { d.seen = true; });
  }
  document.addEventListener('visibilitychange', sync);
  still.addEventListener('change', sync);
  sync();

  window.__pdfPages = { playing: () => demos.map((d) => d.anim.playing) };
})();
