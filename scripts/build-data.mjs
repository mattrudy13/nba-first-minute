#!/usr/bin/env node
// Builds data/<season>.json from ESPN's public site API: the schedule, and for each finished
// regular-season game (NBA Cup included) the time of each team's first point, from play-by-play.
// Seasons are named by their start year (2025 = 2025-26).
//
//   node scripts/build-data.mjs            # current season (data/seasons.json)
//   node scripts/build-data.mjs 2025       # a given season
//   node scripts/build-data.mjs --reprocess
//
// Already-processed games are reused, so reruns only fetch new games. This is the only script
// that talks to ESPN.

import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { firstPoints } = require("../model.js");

const API = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

const args = process.argv.slice(2);
const reprocess = args.includes("--reprocess");
const seasonsFile = path.join(DATA_DIR, "seasons.json");
const seasons = await readJson(seasonsFile, { current: 2026 });
const season = Number(args.find((a) => /^\d{4}$/.test(a)) ?? seasons.current);
const isCurrent = season === seasons.current;

// On GitHub Actions a `::warning::` line shows as a yellow note on the run without failing it.
const warn = (msg) => console.warn(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : msg);

// ESPN sometimes answers 200 with an empty or cut-off body, and its CDN keeps responses for 8 s
// (max-age=8). So retries wait past that (2 s, 4 s, 8 s) and add a throwaway param to miss the cache.
async function getJson(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(i === 1 ? url : `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`, { headers: { "user-agent": "nba-first-minute (github.com/mattrudy13/nba-first-minute)" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

// ESPN's scoreboard `dates=YYYYMMDD` groups games by US Eastern date. Keep dates as YYYY-MM-DD strings.
const ymd = (d) => d.toISOString().slice(0, 10);
const easternToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
function addDays(s, n) {
  const d = new Date(`${s}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

// The All-Star events are filed as regular season; skip them. The NBA Cup final ("CC") stays.
const isCountedGame = (e) => e.season?.type === 2 && e.competitions?.[0]?.type?.abbreviation !== "ALLSTAR";

const file = path.join(DATA_DIR, `${season}.json`);
const old = reprocess ? {} : await readJson(file, {});
const data = {
  season,
  label: `${season}-${String(season + 1).slice(2)}`,
  updated: new Date().toISOString(),
  teams: old.teams ?? {},
  games: old.games ?? {},
  processedEvents: old.processedEvents ?? [],
  scannedThrough: old.scannedThrough ?? null,
};
const processed = new Set(data.processedEvents);

// ---- Schedule: one scoreboard call per day ----

const today = easternToday();
const seasonStart = `${season}-10-01`;
const seasonEnd = `${season + 1}-04-20`;
// Rescan a few days back so games that were in progress last run get picked up, and a few days
// ahead so the upcoming slates are known.
let from = data.scannedThrough && !reprocess ? addDays(data.scannedThrough, -3) : seasonStart;
if (from < seasonStart) from = seasonStart;
let to = isCurrent ? addDays(today, 3) : seasonEnd;
if (to > seasonEnd) to = seasonEnd;
const days = [];
for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);

// A day ESPN still won't serve after retries is skipped with a warning rather than failing the
// run, so the other days still update. Only every day failing (an outage) fails the run.
const boards = await mapLimit(days, 6, async (d) => {
  try {
    return { d, b: await getJson(`${API}/scoreboard?dates=${d.replace(/-/g, "")}`) };
  } catch (err) {
    warn(`scoreboard ${d} skipped, retried next run: ${err.message}`);
    return { d, b: null };
  }
});
const missed = boards.filter(({ b }) => !b).map(({ d }) => d);
const loaded = boards.filter(({ b }) => b);
if (days.length && !loaded.length) throw new Error(`ESPN scoreboard failed for all ${days.length} days`);
for (const { d, b } of loaded) {
  for (const e of b.events ?? []) {
    if (!isCountedGame(e)) continue;
    // Postponed games stay on their original date as "post" with 0–0; the makeup is its own event.
    if (/POSTPONED|CANCELED/.test(e.status.type.name)) continue;
    const c = e.competitions[0];
    const side = (ha) => c.competitors.find((x) => x.homeAway === ha);
    const home = side("home"), away = side("away");
    for (const t of [home, away]) {
      const tm = t.team;
      data.teams[tm.abbreviation] = { id: tm.id, name: tm.displayName, short: tm.shortDisplayName ?? tm.name, color: tm.color ? `#${tm.color}` : "#888", logo: tm.logo };
    }
    const prev = data.games[e.id] ?? {};
    data.games[e.id] = {
      ...prev,
      d,
      tip: e.date,
      home: home.team.abbreviation,
      away: away.team.abbreviation,
      hs: home.score != null ? Number(home.score) : null,
      as: away.score != null ? Number(away.score) : null,
      state: e.status.type.state, // pre / in / post
      detail: e.status.type.shortDetail,
      note: c.notes?.[0]?.headline ?? null,
    };
  }
}
// A game that moved off a scanned date (postponed) shouldn't linger on the old one.
// Only days that loaded count, or a skipped day's games would all look moved and be deleted.
const scanned = new Set(loaded.map(({ d }) => d));
const seen = new Set(loaded.flatMap(({ b }) => (b.events ?? []).map((e) => e.id)));
for (const [gid, g] of Object.entries(data.games)) {
  if (scanned.has(g.d) && !seen.has(gid) && !processed.has(gid)) delete data.games[gid];
}
data.scannedThrough = days.length ? [...days].reverse().find((d) => d <= today) ?? from : data.scannedThrough;
// Hold scannedThrough at the first skipped day so the next run's rescan reaches back to it.
if (missed.length && missed[0] < data.scannedThrough) data.scannedThrough = missed[0];

// ---- Play-by-play for finished games ----

const todo = Object.entries(data.games).filter(([gid, g]) => g.state === "post" && !processed.has(gid));
console.log(`${data.label}: ${Object.keys(data.games).length} games on the schedule, ${todo.length} to process`);

let failed = 0;
await mapLimit(todo, 6, async ([gid, g]) => {
  try {
    const sum = await getJson(`${API}/summary?event=${gid}`);
    // A finished game with no Q1 plays means ESPN's play-by-play is missing, not a 0–0 first
    // quarter. Leave it unprocessed so the next run retries it.
    if (!(sum.plays ?? []).some((p) => p.period?.number === 1)) throw new Error("no Q1 play-by-play");
    const teamId = (ha) => sum.header?.competitions?.[0]?.competitors?.find((c) => c.homeAway === ha)?.team?.id;
    const homeId = teamId("home"), awayId = teamId("away");
    if (!homeId || !awayId) throw new Error("no team ids in summary");
    Object.assign(g, firstPoints(sum.plays, homeId, awayId));
    processed.add(gid);
  } catch (err) {
    failed++;
    console.warn(`${gid} (${g.d} ${g.away} @ ${g.home}): ${err.message}`);
  }
});
data.processedEvents = [...processed].sort();

await writeFile(file, JSON.stringify(data));
if (!(await readJson(seasonsFile, null))) await writeFile(seasonsFile, JSON.stringify({ current: 2026, seasons: [2025, 2026] }, null, 2) + "\n");

const done = Object.values(data.games).filter((g) => g.yes != null);
const yes = done.filter((g) => g.yes).length;
console.log(`${data.label}: ${done.length} games processed, ${yes} both scored in the first minute (${done.length ? ((100 * yes) / done.length).toFixed(1) : "–"}%)${failed ? `, ${failed} skipped (retried next run)` : ""}`);
