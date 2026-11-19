// Shared light/dark theme toggle. Every page has a #theme button; the choice is saved per browser
// and applies to all pages on the site. (Each page's <head> also applies it before first paint.)
(function () {
  const THEMES = [
    { id: "auto", label: "◐ Auto", title: "Theme: follows your system" },
    { id: "light", label: "☀ Light", title: "Theme: light" },
    { id: "dark", label: "☾ Dark", title: "Theme: dark" },
  ];

  function load() {
    try { return localStorage.getItem("theme") ?? "auto"; } catch { return "auto"; }
  }
  function save(id) {
    try { localStorage.setItem("theme", id); } catch { /* ignore */ }
  }

  function apply(id) {
    const t = THEMES.find((x) => x.id === id) ?? THEMES[0];
    if (t.id === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t.id;
    const btn = document.getElementById("theme");
    if (btn) {
      btn.textContent = t.label;
      btn.title = `${t.title} (click to change)`;
    }
    return t.id;
  }

  let current = apply(load());
  document.getElementById("theme")?.addEventListener("click", () => {
    current = apply(THEMES[(THEMES.findIndex((t) => t.id === current) + 1) % THEMES.length].id);
    save(current);
  });
})();
