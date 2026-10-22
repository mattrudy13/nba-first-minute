// Shared DOM code for every page: data loading, formatting, URL state and markup helpers.
// Plain globals, no build step. Model and data logic lives in model.js.

const FM = { cache: {} };

async function getData(file, { optional = false } = {}) {
  if (file in FM.cache) return FM.cache[file];
  const res = await fetch(`data/${file}`, { cache: "no-cache" });
  if (!res.ok) {
    if (optional) return (FM.cache[file] = null);
    throw new Error(`Couldn't load ${file} (HTTP ${res.status})`);
  }
  return (FM.cache[file] = await res.json());
}
const getSeasons = () => getData("seasons.json");

// ---- Formatting ----

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const fmt = {
  int: (n) => (n == null || !Number.isFinite(n) ? "–" : Math.round(n).toLocaleString()),
  pct: (n) => (n == null || !Number.isFinite(n) ? "–" : `${(n * 100).toFixed(1)}%`),
  pct0: (n) => (n == null || !Number.isFinite(n) ? "–" : `${Math.round(n * 100)}%`),
  d4: (n) => (n == null || !Number.isFinite(n) ? "–" : n.toFixed(4)),
  // American odds, rounded: +143 / −143.
  odds: (n) => (n == null || !Number.isFinite(n) ? "–" : n > 0 ? `+${Math.round(n)}` : `−${Math.round(-n)}`),
};
// Seconds into the game → the Q1 clock at that moment ("11:45"). null = no point in Q1.
function clockText(t) {
  if (t == null) return "–";
  // Medians can land on a half second; the clock shows whole seconds.
  const left = Math.max(0, Math.round(720 - t));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}
// Dates are YYYY-MM-DD Eastern; render them without a time-zone shift.
function dateText(d, opts = { weekday: "short", month: "short", day: "numeric" }) {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", ...opts });
}
function timeText(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
}
function stampText(iso) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
}
const easternToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const seasonLabel = (s) => `${s}-${String(s + 1).slice(2)}`;

// ---- URL state ----

function getParams() {
  return Object.fromEntries(new URLSearchParams(location.search));
}
function setParams(obj) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== "" && v != null && v !== false) q.set(k, v === true ? "1" : v);
  const s = q.toString();
  history.replaceState(null, "", s ? `?${s}` : location.pathname);
}

// ---- Markup helpers ----

function teamChip(teams, abbr) {
  const t = teams?.[abbr];
  return `<span class="team" style="--team:${esc(t?.color ?? "#888")}">${esc(abbr ?? "–")}</span>`;
}
const matchup = (teams, g) => `${teamChip(teams, g.away)} <span class="muted">@</span> ${teamChip(teams, g.home)}`;
// Result chip for a game: Yes / No once processed, else the game's state.
function resultChip(g) {
  if (g.yes == null) return `<span class="res wait">${g.state === "in" ? "Live" : g.state === "post" ? "Pending" : "Not started"}</span>`;
  return g.yes ? `<span class="res yes">Yes</span>` : `<span class="res no">No</span>`;
}
// A side's first point as a Q1 clock, flagged when it just missed the minute (10:59–10:45).
function firstCell(t) {
  if (t == null) return `<span class="muted">none in Q1</span>`;
  if (t > FIRST_MINUTE && t <= NEAR_MISS) return `${clockText(t)} <span class="close">close</span>`;
  return t <= FIRST_MINUTE ? `<b>${clockText(t)}</b>` : clockText(t);
}

// Sortable table: columns are { key, label, fmt, cls, sort, asc, nosort }. Sort state lives on `state`.
function renderTable(el, rows, cols, state, onSort, empty = "Nothing to show yet.") {
  const dir = state.dir === "asc" ? 1 : -1;
  const col = cols.find((c) => c.key === state.sort) ?? cols[0];
  const val = col.sort ?? ((r) => r[col.key]);
  if (!state.nosort) {
    rows = [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return typeof x === "string" ? x.localeCompare(y) * dir : (x - y) * dir;
    });
  }
  el.innerHTML = `<table class="grid"><thead><tr>${cols
    .map(
      (c) =>
        `<th class="${c.cls ?? ""}${c.key === col.key && !state.nosort ? " sorted " + state.dir : ""}">${
          c.nosort || state.nosort ? c.label : `<button data-sort="${c.key}">${c.label}</button>`
        }</th>`
    )
    .join("")}</tr></thead><tbody>${
    rows.length
      ? rows.map((r, i) => `<tr${r._cls ? ` class="${r._cls}"` : ""}>${cols.map((c) => `<td class="${c.cls ?? ""}">${c.fmt(r, i)}</td>`).join("")}</tr>`).join("")
      : `<tr><td class="empty" colspan="${cols.length}">${empty}</td></tr>`
  }</tbody></table>`;
  el.querySelectorAll("[data-sort]").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.sort;
      if (state.sort === k) state.dir = state.dir === "asc" ? "desc" : "asc";
      else {
        state.sort = k;
        state.dir = cols.find((c) => c.key === k)?.asc ? "asc" : "desc";
      }
      onSort();
    })
  );
}

// Segmented buttons: <div class="seg" id="x"><button data-v="a">…</button></div>.
function initSeg(id, value, onChange) {
  const el = document.getElementById(id);
  const set = (v) => el.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === v));
  set(value);
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    set(b.dataset.v);
    onChange(b.dataset.v);
  });
}

// Season <select> filled from seasons.json, newest first.
function fillSeasons(sel, seasons, value) {
  sel.innerHTML = [...seasons.seasons].reverse().map((s) => `<option value="${s}"${s === value ? " selected" : ""}>${seasonLabel(s)}</option>`).join("");
}

function showError(err) {
  const el = document.getElementById("status");
  if (el) {
    el.hidden = false;
    el.textContent = err.message || String(err);
  }
  console.error(err);
}

// ---- Theme toggle (follows the system until the viewer picks one) ----

const THEME_KEY = "fm:theme";
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
try {
  applyTheme(localStorage.getItem(THEME_KEY));
} catch {}
function currentTheme() {
  return document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
document.addEventListener("DOMContentLoaded", () => {
  const b = document.getElementById("theme");
  if (!b) return;
  const label = () => {
    const dark = currentTheme() === "dark";
    b.textContent = dark ? "☀" : "☾";
    b.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  };
  label();
  b.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
    label();
  });
});
