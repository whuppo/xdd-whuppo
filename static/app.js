// Only the tiers that actually drop in meaningful numbers; the server filters out the rest.
const TIERS = ["Screaming", "Shrieking", "Deafening"];
const VIEWS = ["grid", "list", "upgrade"];

const state = {
  league: null,
  data: null,
  view: "grid",
  currency: "chaos",
  search: "",
  sort: { key: "chaos", asc: false },
  usort: { key: "profit", asc: false },
  profitableOnly: false,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function load(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

// ---------- formatting ----------

function price(chaos) {
  if (chaos == null) return "—";
  if (state.currency === "divine" && state.data?.divinePrice) {
    const d = chaos / state.data.divinePrice;
    return (d >= 10 ? d.toFixed(1) : d >= 0.1 ? d.toFixed(2) : d.toFixed(3)) + " div";
  }
  return (chaos >= 100 ? Math.round(chaos) : chaos >= 10 ? chaos.toFixed(1) : chaos.toFixed(2)) + "c";
}

function change(pct) {
  if (pct == null) return "";
  const cls = pct > 0 ? "up" : pct < 0 ? "down" : "muted";
  return `<span class="${cls}">${pct > 0 ? "+" : ""}${pct.toFixed(1)}%</span>`;
}

function volume(v) {
  if (v == null) return "—";
  return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "k" : String(Math.round(v));
}

function ago(ts) {
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function sparkline(data, w = 100, h = 24) {
  const pts = data.filter((v) => v != null);
  if (pts.length < 2) return "";
  const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const step = w / (pts.length - 1);
  const d = pts.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(" ");
  const color = pts[pts.length - 1] >= pts[0] ? "var(--up)" : "var(--down)";
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${d}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}

// ---------- rendering ----------

function filtered() {
  const q = state.search.trim().toLowerCase();
  const all = state.data?.essences ?? [];
  return q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all;
}

function renderGrid() {
  const items = filtered();
  const tiered = items.filter((e) => e.tier);
  const specials = items.filter((e) => !e.tier).sort((a, b) => (b.chaos ?? 0) - (a.chaos ?? 0));

  // Heat shading is relative within each tier column, so you can spot the valuable type at a glance.
  const maxByTier = {};
  for (const e of tiered) maxByTier[e.tier] = Math.max(maxByTier[e.tier] ?? 0, e.chaos ?? 0);

  const kinds = [...new Set(tiered.map((e) => e.kind))].sort();
  const byKey = new Map(tiered.map((e) => [`${e.kind}|${e.tier}`, e]));

  let html = "";
  if (kinds.length) {
    html += `<table class="grid"><thead><tr><th></th>${TIERS.map((t) => `<th>${t}</th>`).join("")}</tr></thead><tbody>`;
    for (const kind of kinds) {
      html += `<tr><th class="row">${esc(kind)}</th>`;
      for (const t of TIERS) {
        const e = byKey.get(`${kind}|${t}`);
        if (!e) { html += `<td class="empty"></td>`; continue; }
        const heat = maxByTier[t] ? ((e.chaos ?? 0) / maxByTier[t]) * 0.35 : 0;
        html += `<td style="--h:${heat.toFixed(3)}" data-id="${esc(e.id)}" title="${esc(e.name)}">
          <div class="cell">${e.image ? `<img src="${esc(e.image)}" alt="" loading="lazy">` : ""}
          <div><div class="p">${price(e.chaos)}</div><div class="c">${change(e.change)}</div></div></div></td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table>`;
  }
  if (specials.length) {
    html += `<h2>Special essences</h2><div class="specials">`;
    for (const e of specials) {
      html += `<div class="special" data-id="${esc(e.id)}">${e.image ? `<img src="${esc(e.image)}" alt="" loading="lazy">` : ""}
        <div><div>${esc(e.name)}</div><b>${price(e.chaos)}</b> ${change(e.change)}</div></div>`;
    }
    html += `</div>`;
  }
  $("#grid-view").innerHTML = html || `<p class="muted">No essences match.</p>`;
}

function renderList() {
  const { key, asc } = state.sort;
  const items = [...filtered()].sort((a, b) => {
    const x = a[key], y = b[key];
    const r = typeof x === "string" ? x.localeCompare(y) : (x ?? -Infinity) - (y ?? -Infinity);
    return asc ? r : -r;
  });
  document.querySelectorAll("#list th[data-sort]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === key);
    th.classList.toggle("asc", th.dataset.sort === key && asc);
  });
  $("#list tbody").innerHTML = items.map((e) => `
    <tr data-id="${esc(e.id)}">
      <td class="name">${e.image ? `<img src="${esc(e.image)}" alt="" loading="lazy">` : ""}${esc(e.name)}</td>
      <td class="num">${price(e.chaos)}</td>
      <td class="num">${change(e.change)}</td>
      <td>${sparkline(e.sparkline)}</td>
      <td class="num">${volume(e.volume)}</td>
    </tr>`).join("");
}

// ---------- upgrades ----------

// Every 3:1 vendor upgrade (plus the 9:1 two-step), across all essence types.
function computeUpgrades(essences) {
  const byKey = new Map(essences.filter((e) => e.tier).map((e) => [`${e.kind}|${e.tier}`, e]));
  const steps = [];
  for (let i = 0; i < TIERS.length - 1; i++) {
    for (let j = i + 1; j < TIERS.length; j++) steps.push([TIERS[i], TIERS[j], 3 ** (j - i)]);
  }
  const out = [];
  for (const kind of new Set(essences.filter((e) => e.tier).map((e) => e.kind))) {
    for (const [fromTier, toTier, count] of steps) {
      const from = byKey.get(`${kind}|${fromTier}`), to = byKey.get(`${kind}|${toTier}`);
      if (from?.chaos == null || to?.chaos == null) continue;
      const cost = from.chaos * count;
      out.push({
        kind, from, to, count, cost,
        step: `${count} ${fromTier} → 1 ${toTier}`,
        stepOrder: TIERS.indexOf(fromTier) * 10 + TIERS.indexOf(toTier),
        value: to.chaos,
        profit: to.chaos - cost,
        roi: cost ? (to.chaos - cost) / cost * 100 : null,
        volume: to.volume,
      });
    }
  }
  return out;
}

function profitHtml(p) {
  const cls = p > 0 ? "up" : p < 0 ? "down" : "muted";
  return `<span class="${cls}">${p > 0 ? "+" : p < 0 ? "−" : ""}${price(Math.abs(p))}</span>`;
}

function renderUpgrades() {
  const q = state.search.trim().toLowerCase();
  let rows = computeUpgrades(state.data.essences)
    .filter((u) => !q || u.from.name.toLowerCase().includes(q) || u.to.name.toLowerCase().includes(q));
  if (state.profitableOnly) rows = rows.filter((u) => u.profit > 0);

  const { key, asc } = state.usort;
  const sortKey = key === "step" ? "stepOrder" : key;
  rows.sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    const r = typeof x === "string" ? x.localeCompare(y) : (x ?? -Infinity) - (y ?? -Infinity);
    return asc ? r : -r;
  });
  document.querySelectorAll("#upgrades th[data-usort]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.usort === key);
    th.classList.toggle("asc", th.dataset.usort === key && asc);
  });
  $("#upgrades tbody").innerHTML = rows.length ? rows.map((u) => `
    <tr data-id="${esc(u.from.id)}">
      <td class="name">${u.to.image ? `<img src="${esc(u.to.image)}" alt="" loading="lazy">` : ""}${esc(u.kind)}</td>
      <td class="step">${esc(u.step)}</td>
      <td class="num">${price(u.cost)}</td>
      <td class="num">${price(u.value)}</td>
      <td class="num profit">${profitHtml(u.profit)}</td>
      <td class="num">${u.roi == null ? "—" : change(u.roi)}</td>
      <td class="num">${volume(u.volume)}</td>
    </tr>`).join("") : `<tr><td colspan="7" class="muted">No upgrades match.</td></tr>`;
}

function render() {
  for (const v of VIEWS) $(`#${v}-view`).hidden = state.view !== v;
  if (!state.data) return;
  ({ grid: renderGrid, list: renderList, upgrade: renderUpgrades })[state.view]();
  const div = state.data.divinePrice ? ` · 1 div = ${state.data.divinePrice}c` : "";
  $("#status").textContent = `${state.data.essences.length} essences · updated ${ago(state.data.fetchedAt)}${div}`;
}

// ---------- detail ----------

function lineChart(points, fmtY, fmtX) {
  const W = 600, H = 160, L = 48, R = 8, T = 8, B = 20;
  if (points.length < 2) return "";
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  let ymin = Math.min(...ys), ymax = Math.max(...ys);
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  const sx = (x) => L + ((x - xmin) / (xmax - xmin || 1)) * (W - L - R);
  const sy = (y) => T + (1 - (y - ymin) / (ymax - ymin)) * (H - T - B);
  const d = points.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("");
  const ticks = [ymin, (ymin + ymax) / 2, ymax];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}" stroke="var(--border)"/>
      <text x="${L - 6}" y="${sy(t) + 3}" text-anchor="end">${fmtY(t)}</text>`).join("")}
    <text x="${L}" y="${H - 4}">${fmtX(xmin)}</text>
    <text x="${W - R}" y="${H - 4}" text-anchor="end">${fmtX(xmax)}</text>
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

async function openDetail(id) {
  const e = state.data.essences.find((x) => x.id === id);
  if (!e) return;
  const body = $("#detail-body");
  // poe.ninja's sparkline is % change vs. 7 days ago; convert back to approximate prices.
  const start = e.change != null ? e.chaos / (1 + e.change / 100) : null;
  const week = start != null
    ? e.sparkline.map((pct, i) => ({ x: i - (e.sparkline.length - 1), y: start * (1 + pct / 100) })).filter((p) => !isNaN(p.y))
    : [];
  body.innerHTML = `
    <div class="detail-head">${e.image ? `<img src="${esc(e.image)}" alt="">` : ""}<h3>${esc(e.name)}</h3></div>
    <div class="stats">
      <div><span>Price</span><b>${price(e.chaos)}</b></div>
      <div><span>7d change</span><b>${change(e.change) || "—"}</b></div>
      <div><span>Volume</span><b>${volume(e.volume)}</b></div>
    </div>
    ${computeUpgrades(state.data.essences).filter((u) => u.from.id === e.id).map((u) => `
      <div class="upgrade-box">
        <div><span>${esc(u.step)}</span><b>${profitHtml(u.profit)}</b></div>
        <div class="muted"><span>Cost ${price(u.cost)} → worth ${price(u.value)}</span><span>${change(u.roi)}</span></div>
      </div>`).join("")}
    <div class="chart-title">Last 7 days (poe.ninja)</div>
    ${lineChart(week, (y) => price(y), (x) => (x === 0 ? "today" : `${-x}d ago`)) || `<p class="muted">No trend data.</p>`}
    <div class="chart-title">Recorded by this tracker</div>
    <div id="hist"><p class="muted">Loading…</p></div>
    <p><a href="https://poe.ninja/poe1/economy/${encodeURIComponent(state.league.toLowerCase().replace(/\s+/g, ""))}/essences/${encodeURIComponent(e.id)}" target="_blank" rel="noopener">View on poe.ninja ↗</a></p>`;
  $("#detail").showModal();

  try {
    const res = await fetch(`/api/history?league=${encodeURIComponent(state.league)}&id=${encodeURIComponent(id)}`);
    const rows = await res.json();
    const pts = rows.filter((r) => r.chaos != null).map((r) => ({ x: r.ts, y: r.chaos }));
    const fmtX = (ts) => new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    $("#hist").innerHTML = pts.length >= 2
      ? lineChart(pts, (y) => price(y), fmtX)
      : `<p class="muted">${pts.length} snapshot${pts.length === 1 ? "" : "s"} so far. Leave the server running and history builds up every 30 minutes.</p>`;
  } catch {
    $("#hist").innerHTML = `<p class="muted">Couldn't load history.</p>`;
  }
}

// ---------- data ----------

async function fetchData() {
  $("#status").textContent = "Loading…";
  try {
    const res = await fetch(`/api/essences?league=${encodeURIComponent(state.league)}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    state.data = json;
    render();
  } catch (err) {
    $("#status").textContent = `Failed to load: ${err.message}`;
  }
}

// ---------- theme ----------

const THEMES = [
  { id: "auto", label: "◐ Auto", title: "Theme: follows your system" },
  { id: "light", label: "☀ Light", title: "Theme: light" },
  { id: "dark", label: "☾ Dark", title: "Theme: dark" },
];

function applyTheme(id) {
  const t = THEMES.find((x) => x.id === id) ?? THEMES[0];
  if (t.id === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t.id;
  const btn = $("#theme");
  btn.textContent = t.label;
  btn.title = `${t.title} (click to change)`;
  return t.id;
}

function initTheme() {
  let current = applyTheme(load("theme", "auto"));
  $("#theme").addEventListener("click", () => {
    const next = THEMES[(THEMES.findIndex((t) => t.id === current) + 1) % THEMES.length].id;
    current = applyTheme(next);
    save("theme", current);
  });
}

async function init() {
  initTheme();
  const leagues = await fetch("/api/leagues").then((r) => r.json()).catch(() => ["Standard"]);
  const saved = load("league", null);
  state.league = leagues.includes(saved) ? saved : leagues[0];
  state.view = VIEWS.includes(load("view", "grid")) ? load("view", "grid") : "grid";
  state.currency = load("currency", "chaos");

  const sel = $("#league");
  sel.innerHTML = leagues.map((l) => `<option${l === state.league ? " selected" : ""}>${esc(l)}</option>`).join("");
  sel.addEventListener("change", () => { state.league = sel.value; save("league", sel.value); fetchData(); });

  document.querySelectorAll("[data-view]").forEach((b) => {
    b.classList.toggle("on", b.dataset.view === state.view);
    b.addEventListener("click", () => {
      state.view = b.dataset.view; save("view", state.view);
      document.querySelectorAll("[data-view]").forEach((x) => x.classList.toggle("on", x === b));
      render();
    });
  });
  document.querySelectorAll("[data-cur]").forEach((b) => {
    b.classList.toggle("on", b.dataset.cur === state.currency);
    b.addEventListener("click", () => {
      state.currency = b.dataset.cur; save("currency", state.currency);
      document.querySelectorAll("[data-cur]").forEach((x) => x.classList.toggle("on", x === b));
      render();
    });
  });
  $("#search").addEventListener("input", (ev) => { state.search = ev.target.value; render(); });
  document.querySelectorAll("#list th[data-sort]").forEach((th) => th.addEventListener("click", () => {
    const key = th.dataset.sort;
    state.sort = { key, asc: state.sort.key === key ? !state.sort.asc : key === "name" };
    render();
  }));
  document.querySelectorAll("#upgrades th[data-usort]").forEach((th) => th.addEventListener("click", () => {
    const key = th.dataset.usort;
    state.usort = { key, asc: state.usort.key === key ? !state.usort.asc : key === "kind" || key === "step" };
    render();
  }));
  $("#profitable-only").addEventListener("change", (ev) => { state.profitableOnly = ev.target.checked; render(); });
  document.querySelector("main").addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-id]");
    if (el) openDetail(el.dataset.id);
  });

  await fetchData();
  setInterval(fetchData, 10 * 60 * 1000); // server caches for 30 min; this just picks up new data
  setInterval(render, 60 * 1000);          // keep "updated N min ago" fresh
}

init();
