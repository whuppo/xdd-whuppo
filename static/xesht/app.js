// Flesh of Xesht arbitrage: buy a Breach unique and a Xesht, transform the unique into its
// alternate, sell the result. Prices come raw from the fetcher (update_data.py, xesht/<league>.json);
// every profit is computed here so settings re-rank instantly.

const VIEWS = ["plain", "foulborn"];
const LINKS = [0, 5, 6];
const VENDOR_TIER = 2; // poe.ninja shows hard-to-sell items at about 1c

const state = {
  leagues: [],
  league: null,
  data: null,
  view: "plain",
  links: "all",
  currency: "chaos",
  search: "",
  haircut: 90,
  minListings: 10,
  zeroVendor: true,
  profitableOnly: false,
  sort: { plain: { key: "profit", asc: false }, foulborn: { key: "profit", asc: false } },
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function load(key, fallback) {
  try { return localStorage.getItem(`xesht.${key}`) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(`xesht.${key}`, value); } catch { /* ignore */ }
}

// ---------- formatting ----------

function price(chaos, signed = false) {
  if (chaos == null) return "—";
  const sign = signed && chaos > 0 ? "+" : chaos < 0 ? "−" : "";
  const v = Math.abs(chaos);
  if (state.currency === "divine" && state.data?.divinePrice) {
    const d = v / state.data.divinePrice;
    return sign + (d >= 10 ? d.toFixed(1) : d >= 0.1 ? d.toFixed(2) : d.toFixed(3)) + " div";
  }
  return sign + (v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : String(Number(v.toFixed(2)))) + "c";
}

function profitCell(chaos) {
  const cls = chaos > 0 ? "up" : chaos < 0 ? "down" : "muted";
  return `<span class="${cls}">${price(chaos, true)}</span>`;
}

const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const linkLabel = (l) => (l ? `${l}L` : "—");

function ago(ts) {
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

// ---------- the model ----------

// Builds every conversion, plain and Foulborn, in both directions and at every link count with prices.
// Nothing is filtered here: render() applies the settings, and the detail dialog shows everything.
function conversions() {
  const d = state.data;
  const xesht = d.xesht.chaos;
  const share = state.haircut / 100;
  const sellValue = (chaos) => (state.zeroVendor && chaos <= VENDOR_TIER ? 0 : chaos * share);

  const byKey = new Map(d.items.map((i) => [`${i.name}|${i.variant ?? ""}|${i.links}`, i]));
  const get = (name, variant, links) => byKey.get(`${name}|${variant ?? ""}|${links}`);

  const plain = [];
  const foulborn = [];
  d.pairs.forEach(([a, b], pair) => {
    for (const [from, to] of [[a, b], [b, a]]) {
      for (const links of LINKS) {
        const input = get(from, null, links);
        const output = get(to, null, links);
        if (input && output) {
          const cost = input.chaos + xesht;
          const profit = sellValue(output.chaos) - cost;
          plain.push({
            pair, from, to, links, input, output, cost, sell: output.chaos, profit, roi: profit / cost,
            listings: Math.min(input.listings, output.listings),
          });
        }

        const inputs = (d.variants[from] ?? []).map((v) => get(from, v.label, links)).filter(Boolean);
        if (!inputs.length) continue;
        const cheapest = inputs.reduce((m, i) => (i.chaos < m.chaos ? i : m));
        const outcomes = (d.variants[to] ?? []).map((v) => ({ ...v, item: get(to, v.label, links) }));
        const priced = outcomes.filter((o) => o.item);
        if (!priced.length) continue;
        const fcost = cheapest.chaos + xesht;
        const nets = priced.map((o) => sellValue(o.item.chaos) - fcost);
        const complete = priced.length === outcomes.length;
        foulborn.push({
          pair, from, to, links, input: cheapest, outcomes, complete, cost: fcost,
          profit: complete ? nets.reduce((s, x) => s + x, 0) / nets.length : null,
          best: Math.max(...nets),
          worst: complete ? Math.min(...nets) : null,
          win: complete ? nets.filter((x) => x > 0).length / nets.length : null,
          listings: Math.min(cheapest.listings, ...priced.map((o) => o.item.listings)),
        });
      }
    }
  });
  return { plain, foulborn };
}

function visible(rows) {
  const q = state.search.trim().toLowerCase();
  return rows.filter((r) =>
    (state.links === "all" || r.links === Number(state.links)) &&
    (!q || r.from.toLowerCase().includes(q) || r.to.toLowerCase().includes(q)));
}

// Rows the settings rule out, kept apart so the page can say how many were hidden and why.
function passes(r) {
  if (r.complete === false) return false;
  if (r.listings < state.minListings) return false;
  if (state.profitableOnly && !(r.profit > 0)) return false;
  return true;
}

function sorted(rows, view) {
  const { key, asc } = state.sort[view];
  const val = (r) => (key === "from" ? r.from : r[key] ?? -Infinity);
  return [...rows].sort((x, y) => {
    const a = val(x), b = val(y);
    const c = typeof a === "string" ? a.localeCompare(b) : a - b;
    return asc ? c : -c;
  });
}

// ---------- rendering ----------

function icon(item) {
  return item?.icon ? `<img src="${esc(item.icon)}" alt="" loading="lazy">` : "";
}

function conversionCell(r) {
  return `<td class="conv">${icon(r.input)}<span>${esc(r.from)} <span class="muted">→</span> ${esc(r.to)}</span>${icon(r.output ?? r.outcomes.find((o) => o.item)?.item)}</td>`;
}

function outcomeChips(r) {
  return r.outcomes.map((o) => {
    if (!o.item) return `<span class="chip missing" title="${esc(o.mod)}">${esc(o.label)} <b>no price</b></span>`;
    const vendor = state.zeroVendor && o.item.chaos <= VENDOR_TIER;
    return `<span class="chip${vendor ? " vendor" : ""}" title="${esc(o.mod)} · ${o.item.listings} listed">${esc(o.label)} <b>${price(o.item.chaos)}</b></span>`;
  }).join("");
}

function render() {
  if (!state.data) return;
  const all = conversions();
  state.all = all;
  for (const v of VIEWS) {
    $(`#${v}-view`).hidden = state.view !== v;
    $(`#intro-${v}`).hidden = state.view !== v;
  }
  document.querySelectorAll("th[data-sort]").forEach((th) => {
    const s = state.sort[th.closest("table").id];
    th.classList.toggle("sorted", s.key === th.dataset.sort);
    th.classList.toggle("asc", s.key === th.dataset.sort && s.asc);
  });

  const rows = visible(all[state.view]);
  const shown = sorted(rows.filter(passes), state.view);
  const tbody = $(`#${state.view} tbody`);
  if (state.view === "plain") {
    tbody.innerHTML = shown.map((r) => `<tr data-pair="${r.pair}">
      ${conversionCell(r)}
      <td class="num">${linkLabel(r.links)}</td>
      <td class="num">${price(r.cost)}</td>
      <td class="num">${price(r.sell)}</td>
      <td class="num profit">${profitCell(r.profit)}</td>
      <td class="num">${pct(r.roi)}</td>
      <td class="num">${r.input.listings} / ${r.output.listings}</td></tr>`).join("");
  } else {
    tbody.innerHTML = shown.map((r) => `<tr data-pair="${r.pair}">
      ${conversionCell(r)}
      <td class="num">${linkLabel(r.links)}</td>
      <td class="num" title="Cheapest input: ${esc(r.input.variant)}">${price(r.cost)}</td>
      <td class="chips-cell">${outcomeChips(r)}</td>
      <td class="num profit">${profitCell(r.profit)}</td>
      <td class="num">${profitCell(r.worst)}</td>
      <td class="num">${pct(r.win)}</td>
      <td class="num">${r.listings}</td></tr>`).join("");
  }
  if (!shown.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted empty-row">Nothing matches these settings.</td></tr>`;
  }

  const thin = rows.filter((r) => r.complete !== false && r.listings < state.minListings).length;
  const incomplete = rows.filter((r) => r.complete === false).length;
  const notes = [];
  if (thin) notes.push(`${thin} with fewer than ${state.minListings} listings`);
  if (incomplete) notes.push(`${incomplete} with an unpriced outcome`);
  $("#hidden-note").textContent = notes.length ? `Hidden: ${notes.join(", ")}. They still show in each pair's detail.` : "";

  const div = state.data.divinePrice ? ` · 1 div = ${Math.round(state.data.divinePrice)}c` : "";
  $("#status").textContent = `Flesh of Xesht ${price(state.data.xesht.chaos)} · updated ${ago(state.data.fetchedAt)}${div}`;
}

// ---------- detail ----------

function openDetail(pair) {
  const [a, b] = state.data.pairs[pair];
  const plain = state.all.plain.filter((r) => r.pair === pair);
  const foul = state.all.foulborn.filter((r) => r.pair === pair);
  const head = (r) => `${esc(r.from)} → ${esc(r.to)}${r.links ? ` · ${r.links}L` : ""}`;
  const flags = (r) => [
    r.listings < state.minListings ? `<span class="warn">thin: ${r.listings} listed</span>` : "",
    r.complete === false ? `<span class="warn">an outcome has no price</span>` : "",
  ].filter(Boolean).join(" ");

  const plainHtml = plain.length ? plain.map((r) => `<div class="leg">
      <div class="leg-head"><b>${head(r)}</b> ${flags(r)}</div>
      <div class="leg-row"><span>Buy ${esc(r.from)}</span><span>${price(r.input.chaos)}</span></div>
      <div class="leg-row"><span>Flesh of Xesht</span><span>${price(state.data.xesht.chaos)}</span></div>
      <div class="leg-row"><span>Sell ${esc(r.to)} at ${state.haircut}%</span><span>${price(r.sell)}</span></div>
      <div class="leg-row total"><span>Profit</span><span>${profitCell(r.profit)}</span></div></div>`).join("")
    : `<p class="muted">No plain prices for this pair.</p>`;

  const variantList = (name) => (state.data.variants[name] ?? [])
    .map((v) => `<li><b>${esc(v.label)}</b>: ${esc(v.mod)}</li>`).join("");

  const foulHtml = foul.length ? foul.map((r) => `<div class="leg">
      <div class="leg-head"><b>${head(r)}</b> ${flags(r)}</div>
      <div class="leg-row"><span>Buy cheapest Foulborn ${esc(r.from)} (${esc(r.input.variant)})</span><span>${price(r.input.chaos)}</span></div>
      ${r.outcomes.map((o) => `<div class="leg-row"><span>→ ${esc(o.label)}${o.item ? ` <span class="muted">(${o.item.listings} listed)</span>` : ""}</span><span>${o.item ? price(o.item.chaos) : "no price"}</span></div>`).join("")}
      <div class="leg-row total"><span>Expected profit</span><span>${r.profit == null ? "—" : profitCell(r.profit)}</span></div></div>`).join("")
    : `<p class="muted">No Foulborn prices for this pair.</p>`;

  $("#detail-body").innerHTML = `
    <div class="detail-head">${icon(plain[0]?.input ?? foul[0]?.input)}<h3>${esc(a)} ⇄ ${esc(b)}</h3></div>
    <h4>Plain</h4>${plainHtml}
    <h4>Foulborn</h4>${foulHtml}
    <h4>Foulborn mods</h4>
    <div class="variants"><div><b>${esc(a)}</b><ul>${variantList(a)}</ul></div><div><b>${esc(b)}</b><ul>${variantList(b)}</ul></div></div>`;
  $("#detail").showModal();
}

// ---------- data ----------

const DATA = window.XDD_DATA;

async function fetchData() {
  $("#status").textContent = "Loading…";
  const slug = state.leagues.find((l) => l.name === state.league)?.slug ?? "";
  try {
    const res = await fetch(`${DATA}/xesht/${slug}.json`, { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status === 404 ? "no data for this league yet" : res.statusText);
    state.data = await res.json();
    render();
  } catch (err) {
    state.data = null;
    $("#status").textContent = `Failed to load: ${err.message}`;
  }
}

function bindSeg(attr, key, after = render) {
  document.querySelectorAll(`[data-${attr}]`).forEach((b) => {
    b.classList.toggle("on", b.dataset[attr] === String(state[key]));
    b.addEventListener("click", () => {
      state[key] = b.dataset[attr];
      save(key, state[key]);
      document.querySelectorAll(`[data-${attr}]`).forEach((x) => x.classList.toggle("on", x === b));
      after();
    });
  });
}

async function init() {
  state.leagues = await fetch(`${DATA}/xesht/leagues.json`, { cache: "no-cache" }).then((r) => r.json()).catch(() => []);
  if (!state.leagues.length) {
    $("#status").textContent = "No price data yet. It's generated every 30 minutes.";
    return;
  }
  const leagues = state.leagues.map((l) => l.name);
  const saved = load("league", null);
  state.league = leagues.includes(saved) ? saved : leagues[0];
  const hashView = location.hash.slice(1);
  state.view = VIEWS.includes(hashView) ? hashView : VIEWS.includes(load("view", "plain")) ? load("view", "plain") : "plain";
  state.links = load("links", "all");
  state.currency = load("currency", "chaos");
  state.haircut = Number(load("haircut", 90));
  state.minListings = Number(load("minListings", 10));
  state.zeroVendor = load("zeroVendor", "1") === "1";

  const sel = $("#league");
  sel.innerHTML = leagues.map((l) => `<option${l === state.league ? " selected" : ""}>${esc(l)}</option>`).join("");
  sel.addEventListener("change", () => { state.league = sel.value; save("league", sel.value); fetchData(); });

  bindSeg("view", "view", () => { history.replaceState(null, "", `#${state.view}`); render(); });
  bindSeg("links", "links");
  bindSeg("cur", "currency");
  window.addEventListener("hashchange", () => {
    const v = location.hash.slice(1);
    if (VIEWS.includes(v) && v !== state.view) document.querySelector(`[data-view="${v}"]`).click();
  });

  const num = (id, key, min, max) => {
    const el = $(id);
    el.value = state[key];
    el.addEventListener("input", () => {
      const v = Number(el.value);
      if (!Number.isFinite(v) || el.value === "") return;
      state[key] = Math.min(max, Math.max(min, v));
      save(key, state[key]);
      render();
    });
  };
  num("#haircut", "haircut", 50, 100);
  num("#min-listings", "minListings", 0, 200);
  $("#zero-vendor").checked = state.zeroVendor;
  $("#zero-vendor").addEventListener("change", (ev) => { state.zeroVendor = ev.target.checked; save("zeroVendor", ev.target.checked ? "1" : "0"); render(); });
  $("#profitable-only").addEventListener("change", (ev) => { state.profitableOnly = ev.target.checked; render(); });
  $("#search").addEventListener("input", (ev) => { state.search = ev.target.value; render(); });

  document.querySelectorAll("th[data-sort]").forEach((th) => th.addEventListener("click", () => {
    const view = th.closest("table").id;
    const key = th.dataset.sort;
    const cur = state.sort[view];
    state.sort[view] = { key, asc: cur.key === key ? !cur.asc : key === "from" };
    render();
  }));
  document.querySelector("main").addEventListener("click", (ev) => {
    const row = ev.target.closest("tr[data-pair]");
    if (row) openDetail(Number(row.dataset.pair));
  });

  await fetchData();
  setInterval(fetchData, 10 * 60 * 1000); // data refreshes every 30 min; this just picks it up
  setInterval(render, 60 * 1000);          // keep "updated N min ago" fresh
}

init();
