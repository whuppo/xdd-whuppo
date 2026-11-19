// Only the tiers that actually drop in meaningful numbers; the server filters out the rest.
const TIERS = ["Screaming", "Shrieking", "Deafening"];
const VIEWS = ["grid", "list", "upgrade"];

const state = {
  leagues: [],
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

// ---------- stash tab layout ----------

// essence_tab.txt mirrors the in-game essence stash tab: tab-separated, first line holds the
// tier for each column, other cells hold an essence type ("Greed") or "(special) Name". Empty cells are intentional.
const SPECIAL_PREFIX = "(special)";

async function loadLayout() {
  const text = await fetch("essence_tab.txt").then((r) => {
    if (!r.ok) throw new Error(`essence_tab.txt: ${r.status}`);
    return r.text();
  });
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "");
  const headers = lines[0].split("\t").map((s) => s.trim());
  const rows = lines.slice(1).map((l) => {
    const cells = l.split("\t").map((s) => s.trim());
    while (cells.length < headers.length) cells.push("");
    return cells.slice(0, headers.length);
  });
  // Put a visible gap wherever the same tier appears in two adjacent columns (Screaming | Screaming).
  const gapAfter = new Set();
  for (let i = 0; i < headers.length - 1; i++) if (headers[i] === headers[i + 1]) gapAfter.add(i);
  return { headers, rows, gapAfter };
}

function layoutCell(text, tier) {
  if (!text) return null;
  if (text.startsWith(SPECIAL_PREFIX)) return { special: true, kind: text.slice(SPECIAL_PREFIX.length).trim() };
  return { special: false, kind: text, tier };
}

// Builds the stash-tab grid. cellFn(e, cell) returns { body, heat, heatColor, title } for one placed essence.
// Each section between separators (the two mirrored halves) is its own table, so on narrow screens
// the sections can stack vertically (see layoutStashGrids).
function stashGridHtml(cellFn) {
  const layout = state.layout;
  const essences = state.data.essences;
  const byKey = new Map(essences.filter((e) => e.tier).map((e) => [`${e.kind}|${e.tier}`, e]));
  const specials = new Map(essences.filter((e) => !e.tier).map((e) => [e.kind, e]));
  const q = state.search.trim().toLowerCase();
  const placed = new Set();

  // Split column indexes into sections at each separator.
  const sections = [[]];
  layout.headers.forEach((_, i) => {
    sections[sections.length - 1].push(i);
    if (layout.gapAfter.has(i) && i < layout.headers.length - 1) sections.push([]);
  });

  const cellHtml = (text, i) => {
    const cell = layoutCell(text, layout.headers[i]);
    const e = cell && (cell.special ? specials.get(cell.kind) : byKey.get(`${cell.kind}|${cell.tier}`));
    if (!cell) return `<td class="empty"></td>`;
    if (!e) return `<td class="missing" title="${esc(text)}: no price data"><div class="cell"><span class="muted">${esc(cell.kind)}</span></div></td>`;
    placed.add(e.id);
    const c = cellFn(e, cell);
    const dim = q && !e.name.toLowerCase().includes(q) ? " dim" : "";
    const style = `--h:${(c.heat ?? 0).toFixed(3)}${c.heatColor ? `;--hc:${c.heatColor}` : ""}`;
    return `<td class="${cell.special ? "special-cell" : ""}${dim}" style="${style}" data-id="${esc(e.id)}" title="${esc(c.title ?? e.name)}">
      <div class="cell">${e.image ? `<img src="${esc(e.image)}" alt="" loading="lazy">` : ""}
      <div><div class="k">${esc(cell.kind)}</div>${c.body}</div></div></td>`;
  };

  let html = `<div class="stash-grid">`;
  sections.forEach((cols, s) => {
    const sep = s < sections.length - 1; // separator column after every section but the last
    html += `<table class="grid stash"><thead><tr>`;
    for (const i of cols) html += `<th>${esc(layout.headers[i])}</th>`;
    if (sep) html += `<th class="gap"></th>`;
    html += `</tr></thead><tbody>`;
    for (const row of layout.rows) {
      html += `<tr>${cols.map((i) => cellHtml(row[i], i)).join("")}`;
      if (sep) html += `<td class="gap" aria-hidden="true"></td>`;
      html += `</tr>`;
    }
    html += `</tbody></table>`;
  });
  html += `</div>`;
  return { html, placed };
}

function layoutPending(target) {
  if (state.layout) return false;
  $(target).innerHTML = `<p class="muted">${esc(state.layoutError || "Loading layout…")}</p>`;
  return true;
}

function renderGrid() {
  if (layoutPending("#grid-view")) return;
  const essences = state.data.essences;

  // Heat shading is relative within each tier, so you can spot the valuable type at a glance.
  const maxByTier = {};
  for (const e of essences) if (e.tier) maxByTier[e.tier] = Math.max(maxByTier[e.tier] ?? 0, e.chaos ?? 0);

  let { html, placed } = stashGridHtml((e, cell) => ({
    body: `<div class="p">${price(e.chaos)}</div><div class="c">${change(e.change)}</div>`,
    heat: !cell.special && maxByTier[e.tier] ? ((e.chaos ?? 0) / maxByTier[e.tier]) * 0.35 : 0,
  }));

  // Anything poe.ninja lists that the layout file doesn't place (e.g. a new essence) still gets shown.
  const q = state.search.trim().toLowerCase();
  const extra = essences.filter((e) => !placed.has(e.id) && (!q || e.name.toLowerCase().includes(q)));
  if (extra.length) {
    html += `<h2>Not in stash layout</h2><div class="specials">`;
    for (const e of extra) {
      html += `<div class="special" data-id="${esc(e.id)}">${e.image ? `<img src="${esc(e.image)}" alt="" loading="lazy">` : ""}
        <div><div>${esc(e.name)}</div><b>${price(e.chaos)}</b> ${change(e.change)}</div></div>`;
    }
    html += `</div>`;
  }
  $("#grid-view").innerHTML = html;
}

// Upgrade grid. Two modes:
//  - "unit":  each cell shows the profit of one 3:1 upgrade to the next tier.
//  - "stash": each cell shows how many you own → how many after the best plan, and that step's total profit.
function renderUpgradeGrid() {
  const stashMode = !!state.stash && state.upgradeGridMode !== "unit";
  $("#upgrade-grid-title").textContent = stashMode ? "Your stash: best upgrade plan" : "Upgrade profit per essence";
  if (layoutPending("#upgrade-grid")) return;
  $("#upgrade-grid").innerHTML = (stashMode ? STASH_LEGEND : "") + (stashMode ? stashGrid() : unitGrid()).html;
}

const STASH_LEGEND = `
  <div class="legend" aria-label="Color key">
    <span><i style="--sw:var(--up-rgb)"></i>Upgrade the whole stack</span>
    <span><i style="--sw:var(--warn-rgb)"></i>Upgrade part of the stack</span>
    <span><i style="--sw:var(--down-rgb)"></i>Hold, upgrading loses money</span>
    <span><i class="none"></i>Nothing to decide (max tier, special, or fewer than 3)</span>
  </div>`;

function unitGrid() {
  const next = new Map(computeUpgrades(state.data.essences).filter((u) => u.count === 3).map((u) => [u.from.id, u]));
  const maxAbs = Math.max(0, ...[...next.values()].map((u) => Math.abs(u.profit)));

  return stashGridHtml((e) => {
    const u = next.get(e.id);
    if (!u) {
      const why = e.tier ? "Max tier, can't upgrade" : "Special essences can't be upgraded";
      return { body: `<div class="p muted">—</div><div class="c muted">&nbsp;</div>`, title: `${e.name}: ${why}` };
    }
    return {
      body: `<div class="p">${profitHtml(u.profit)}</div><div class="c">${u.roi == null ? "" : change(u.roi)}</div>`,
      heat: maxAbs ? (Math.abs(u.profit) / maxAbs) * 0.35 : 0,
      heatColor: u.profit >= 0 ? "var(--up-rgb)" : "var(--down-rgb)",
      title: `${u.step} ${u.kind}: costs ${price(u.cost)}, worth ${price(u.value)}`,
    };
  });
}

function stashGrid() {
  const quantities = state.stash.quantities;
  const plans = new Map(planStash(quantities, state.data.essences).rows.map((r) => [r.kind, r]));

  // Profit of the step that starts at this cell: Screaming cells carry step 1, Shrieking cells step 2.
  const stepOf = (r, tier) =>
    tier === "Screaming" ? { n: r.a, unit: r.p1, to: "Shrieking" }
    : tier === "Shrieking" ? { n: r.b, unit: r.p2, to: "Deafening" }
    : null;
  // Flat decision colors, not a gradient: green = upgrade the whole stack, yellow = upgrade part of it
  // (3 or more left over), red = hold it.
  const DECISION_SHADE = 0.25;

  return stashGridHtml((e) => {
    if (!e.tier) {
      const qty = quantities[e.name] ?? 0;
      return {
        body: `<div class="p${qty ? "" : " muted"}">${qty}</div><div class="c muted">special</div>`,
        title: `${e.name}: you own ${qty}. Special essences can't be upgraded.`,
      };
    }
    const r = plans.get(e.kind);
    const own = r ? r.own[e.tier] : 0, after = r ? r.after[e.tier] : 0;
    const qtyHtml = own === after ? `${own}` : `${own}<span class="arrow muted">→</span>${after}`;
    const step = r && stepOf(r, e.tier);
    const lines = [`${e.name}: you own ${own}.`];
    const idle = e.tier === "Deafening" ? "max tier" : own === 0 ? "—" : own < 3 ? "too few" : "keep";
    let sub = `<span class="muted">${idle}</span>`;
    let heat = 0, heatColor;

    if (step && step.n) {
      const profit = step.n * step.unit;
      sub = profitHtml(profit);
      heat = DECISION_SHADE;
      const partial = after >= 3;
      heatColor = partial ? "var(--warn-rgb)" : "var(--up-rgb)";
      if (partial) lines.push(`Partial: upgrade only ${3 * step.n} and keep ${after}. Upgrading more isn't worth it at current prices.`);
      lines.push(`Vendor ${3 * step.n} → ${step.n} ${step.to} (${step.n} × ${profitHtml(step.unit).replace(/<[^>]+>/g, "")} = ${profitHtml(profit).replace(/<[^>]+>/g, "")}).`);
      if (e.tier === "Screaming" && step.unit < 0 && r.b) {
        lines.push(`Loses money on its own, but the extra Shrieking allow more Shrieking → Deafening upgrades, so the plan comes out ahead.`);
      }
    } else if (r && after > own) {
      sub = `<span class="up">+${after - own}</span>`;
      lines.push(`Gains ${after - own} from upgrading the tier below.`);
    } else if (step && own >= 3) {
      heat = DECISION_SHADE;
      heatColor = "var(--down-rgb)";
      sub = `<span class="muted">hold</span>`;
      lines.push(`Upgrading to ${step.to} isn't worth it at current prices.`);
    }
    if (after !== own) lines.push(`After the plan: ${after}.`);
    if (r && e.tier === "Deafening" && r.profit) lines.push(`${e.kind} plan total: ${profitHtml(r.profit).replace(/<[^>]+>/g, "")}.`);

    return {
      body: `<div class="p${own || after ? "" : " muted"}">${qtyHtml}</div><div class="c">${sub}</div>`,
      heat, heatColor, title: lines.join("\n"),
    };
  });
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

// ---------- stash import (WealthyExile CSV) ----------

// Minimal RFC 4180 parser: quoted fields, "" escapes, CRLF, and a leading BOM.
function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function parseWealthyExport(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("The file is empty.");
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const nameCol = header.indexOf("name"), qtyCol = header.indexOf("quantity");
  if (nameCol < 0 || qtyCol < 0) throw new Error("Couldn't find Name and Quantity columns. Is this a WealthyExile export?");
  const quantities = {};
  for (const r of rows.slice(1)) {
    const name = (r[nameCol] ?? "").trim();
    const qty = Number(String(r[qtyCol] ?? "").replace(/,/g, ""));
    if (!name || !Number.isFinite(qty) || qty <= 0) continue;
    quantities[name] = (quantities[name] ?? 0) + qty; // same item can appear in several tabs
  }
  return quantities;
}

// Best plan for one essence type: a = Screaming→Shrieking recipes, b = Shrieking→Deafening recipes.
// Profit is linear, but recipes made in step 1 feed step 2, so try every a and take the best.
function bestPlan(own, p1, p2) {
  let best = { a: 0, b: 0, profit: 0 };
  const maxA = p1 == null ? 0 : Math.floor(own.Screaming / 3);
  for (let a = 0; a <= maxA; a++) {
    const b = p2 != null && p2 > 0 ? Math.floor((own.Shrieking + a) / 3) : 0;
    const profit = a * (p1 ?? 0) + b * (p2 ?? 0);
    if (profit > best.profit + 1e-9) best = { a, b, profit };
  }
  return best;
}

function planStash(quantities, essences) {
  const byName = new Map(essences.map((e) => [e.name, e]));
  const byKey = new Map(essences.filter((e) => e.tier).map((e) => [`${e.kind}|${e.tier}`, e]));
  const kinds = new Set();
  let matched = 0, ignored = 0;
  for (const [name, qty] of Object.entries(quantities)) {
    const e = byName.get(name);
    if (e) { matched += qty; if (e.tier) kinds.add(e.kind); }
    else if (/Essence of /.test(name)) ignored += qty; // lower tiers we don't track
  }
  const rows = [];
  for (const kind of kinds) {
    const [scr, shr, deaf] = TIERS.map((t) => byKey.get(`${kind}|${t}`));
    const own = Object.fromEntries(TIERS.map((t) => [t, quantities[`${t} Essence of ${kind}`] ?? 0]));
    const p1 = scr?.chaos != null && shr?.chaos != null ? shr.chaos - 3 * scr.chaos : null;
    const p2 = shr?.chaos != null && deaf?.chaos != null ? deaf.chaos - 3 * shr.chaos : null;
    const plan = bestPlan(own, p1, p2);
    const after = {
      Screaming: own.Screaming - 3 * plan.a,
      Shrieking: own.Shrieking + plan.a - 3 * plan.b,
      Deafening: own.Deafening + plan.b,
    };
    rows.push({ kind, image: (deaf ?? shr ?? scr)?.image, own, after, p1, p2, ...plan });
  }
  rows.sort((x, y) => y.profit - x.profit || x.kind.localeCompare(y.kind));
  return { rows, matched, ignored, total: rows.reduce((s, r) => s + r.profit, 0) };
}

function renderStash() {
  const box = $("#stash-result");
  if (state.stashError) { box.innerHTML = `<p class="down">${esc(state.stashError)}</p>`; return; }
  if (!state.stash) { box.innerHTML = ""; return; }
  const { matched, ignored, total } = planStash(state.stash.quantities, state.data.essences);
  const mode = state.upgradeGridMode === "unit" ? "unit" : "stash";
  box.innerHTML = `
    <div class="stash-summary">
      <div><span>Loaded</span><b>${esc(state.stash.fileName)}</b></div>
      <div><span>Essences matched</span><b>${matched}</b></div>
      <div><span>Potential profit</span><b>${profitHtml(total)}</b></div>
      <button type="button" id="stash-clear">Clear</button>
    </div>
    ${ignored ? `<p class="muted">${ignored} lower-tier essence${ignored === 1 ? "" : "s"} (Wailing and below) not counted.</p>` : ""}
    <p class="muted">
      In the grid below, each cell shows how many you own → how many you'd have after the plan, and the profit
      from upgrading that tier. Hover a cell for details. Profit assumes you can sell at current poe.ninja prices;
      selling many at once may move the price.
    </p>
    <div class="seg" role="group" aria-label="Grid shows">
      <button type="button" data-gridmode="stash" class="${mode === "stash" ? "on" : ""}">My stash</button>
      <button type="button" data-gridmode="unit" class="${mode === "unit" ? "on" : ""}">Per-essence profit</button>
    </div>`;
}

async function loadStashFile(file) {
  if (!file) return;
  try {
    const quantities = parseWealthyExport(await file.text());
    state.stash = { fileName: file.name, quantities };
    state.stashError = null;
    save("stash", JSON.stringify(state.stash));
  } catch (err) {
    state.stashError = err.message;
  }
  render();
}

function initStash() {
  try { state.stash = JSON.parse(load("stash", "null")); } catch { state.stash = null; }
  state.upgradeGridMode = load("upgradeGridMode", "stash");
  const input = $("#stash-file"), drop = $("#stash-drop");
  input.addEventListener("change", () => { loadStashFile(input.files[0]); input.value = ""; });
  drop.addEventListener("dragover", (ev) => { ev.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (ev) => {
    ev.preventDefault(); drop.classList.remove("over");
    loadStashFile(ev.dataTransfer.files[0]);
  });
  $("#stash-result").addEventListener("click", (ev) => {
    const modeBtn = ev.target.closest("[data-gridmode]");
    if (modeBtn) { state.upgradeGridMode = modeBtn.dataset.gridmode; save("upgradeGridMode", state.upgradeGridMode); render(); return; }
    if (ev.target.id !== "stash-clear") return;
    state.stash = null; state.stashError = null;
    try { localStorage.removeItem("stash"); } catch { /* ignore */ }
    render();
  });
}

// The stash grid's full side-by-side width is the page's content column (centered on wide screens).
// When the available width is smaller than that, stack the grid's sections and hide the separators.
// The full width is measured unstacked and remembered, so stacking can't flip back and forth.
function layoutStashGrids() {
  for (const wrap of document.querySelectorAll(".stash-grid")) {
    if (!wrap.offsetParent) continue; // hidden view
    if (!wrap.dataset.full) {
      wrap.classList.remove("stacked");
      const full = [...wrap.children].reduce((sum, t) => sum + t.offsetWidth, 0);
      wrap.dataset.full = full;
      document.documentElement.style.setProperty("--content-w", `${full}px`);
    }
    wrap.classList.toggle("stacked", wrap.clientWidth < Number(wrap.dataset.full));
    wrap.querySelectorAll(".cell .p, .cell .c").forEach(fitText);
  }
}

// Shrink a cell line's font just enough to fit its fixed width (e.g. "1144→1454").
// Short values keep the normal size; anything still too long at the minimum falls back to the CSS ellipsis.
function fitText(el) {
  el.style.fontSize = "";
  if (el.scrollWidth <= el.clientWidth) return;
  let size = parseFloat(getComputedStyle(el).fontSize);
  while (el.scrollWidth > el.clientWidth && size > 9) {
    size -= 0.5;
    el.style.fontSize = `${size}px`;
  }
}

function render() {
  for (const v of VIEWS) $(`#${v}-view`).hidden = state.view !== v;
  if (!state.data) return;
  ({ grid: renderGrid, list: renderList, upgrade: () => { renderStash(); renderUpgradeGrid(); renderUpgrades(); } })[state.view]();
  layoutStashGrids();
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
    // History files are [[unix_ts, chaos, volume], ...]; a missing file just means no history yet.
    const res = await fetch(`${DATA}/history/${leagueSlug()}/${encodeURIComponent(id)}.json`, { cache: "no-cache" });
    const rows = res.ok ? await res.json() : [];
    const pts = rows.filter((r) => r[1] != null).map(([ts, chaos]) => ({ x: ts, y: chaos }));
    const fmtX = (ts) => new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    $("#hist").innerHTML = pts.length >= 2
      ? lineChart(pts, (y) => price(y), fmtX)
      : `<p class="muted">${pts.length} snapshot${pts.length === 1 ? "" : "s"} so far. History builds up every 30 minutes.</p>`;
  } catch {
    $("#hist").innerHTML = `<p class="muted">Couldn't load history.</p>`;
  }
}

// ---------- data ----------

// Static JSON written by update_data.py (GitHub Action on Pages, server.py locally).
// Relative, so the site works at a domain root or under /<repo>/ on github.io.
const DATA = "../data";

function leagueSlug() {
  return state.leagues.find((l) => l.name === state.league)?.slug ?? "";
}

async function fetchData() {
  $("#status").textContent = "Loading…";
  try {
    const res = await fetch(`${DATA}/essences/${leagueSlug()}.json`, { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status === 404 ? "no data for this league yet" : res.statusText);
    const json = await res.json();
    state.data = json;
    render();
  } catch (err) {
    $("#status").textContent = `Failed to load: ${err.message}`;
  }
}

async function init() {
  initStash();
  state.leagues = await fetch(`${DATA}/leagues.json`, { cache: "no-cache" }).then((r) => r.json()).catch(() => []);
  if (!state.leagues.length) {
    $("#status").textContent = "No price data yet. It's generated every 30 minutes.";
    return;
  }
  const leagues = state.leagues.map((l) => l.name);
  const saved = load("league", null);
  state.league = leagues.includes(saved) ? saved : leagues[0];
  // A #grid / #list / #upgrade link (e.g. from the tools hub) wins over the remembered view.
  const hashView = location.hash.slice(1);
  state.view = VIEWS.includes(hashView) ? hashView : VIEWS.includes(load("view", "grid")) ? load("view", "grid") : "grid";
  state.currency = load("currency", "chaos");

  const sel = $("#league");
  sel.innerHTML = leagues.map((l) => `<option${l === state.league ? " selected" : ""}>${esc(l)}</option>`).join("");
  sel.addEventListener("change", () => { state.league = sel.value; save("league", sel.value); fetchData(); });

  const setView = (view) => {
    state.view = view; save("view", view);
    history.replaceState(null, "", `#${view}`); // keep the URL shareable
    document.querySelectorAll("[data-view]").forEach((x) => x.classList.toggle("on", x.dataset.view === view));
    render();
  };
  document.querySelectorAll("[data-view]").forEach((b) => {
    b.classList.toggle("on", b.dataset.view === state.view);
    b.addEventListener("click", () => setView(b.dataset.view));
  });
  window.addEventListener("hashchange", () => {
    const v = location.hash.slice(1);
    if (VIEWS.includes(v) && v !== state.view) setView(v);
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

  loadLayout()
    .then((layout) => { state.layout = layout; })
    .catch((err) => { state.layoutError = `Couldn't load stash layout (${err.message}).`; })
    .finally(render);
  window.addEventListener("resize", layoutStashGrids);
  await fetchData();
  setInterval(fetchData, 10 * 60 * 1000); // server caches for 30 min; this just picks up new data
  setInterval(render, 60 * 1000);          // keep "updated N min ago" fresh
}

init();
