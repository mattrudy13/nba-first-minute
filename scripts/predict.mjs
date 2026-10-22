#!/usr/bin/env node
// Saves today's estimate into data/predictions-<season>.json: the chance both teams score in the
// first minute, which is the league's Yes rate so far (see MODEL in model.js), and the break-even
// prices. A day's estimate is rewritten on every run until its first game tips off, then it's
// locked: that last pre-tip version is the one graded.
//
//   node scripts/predict.mjs
//   NOW=2026-10-22T20:00:00Z node scripts/predict.mjs   # pretend it's another time (testing)

import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const M = require("../model.js");
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const readJson = async (f, fallback) => {
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, f), "utf8"));
  } catch {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing data/${f}`);
  }
};

const now = process.env.NOW ? new Date(process.env.NOW) : new Date();
const today = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const { current: season } = await readJson("seasons.json");
const data = await readJson(`${season}.json`);
const prev = M.seasonRates(M.finishedGames(await readJson(`${season - 1}.json`, {})));
const file = `predictions-${season}.json`;
const store = await readJson(file, { season, days: {} });

const games = Object.entries(data.games)
  .filter(([, g]) => g.d === today)
  .map(([gid, g]) => ({ gid, ...g }))
  .sort((a, b) => (a.tip < b.tip ? -1 : 1));

if (!games.length) {
  console.log(`${today}: no games`);
} else {
  const firstTip = games[0].tip;
  if (now >= new Date(firstTip) || games.some((g) => g.state !== "pre")) {
    console.log(`${today}: locked (first tip ${firstTip})`);
  } else {
    const before = M.finishedGames(data).filter((g) => g.d < today);
    const lg = M.leagueRates(before, prev, M.MODEL);
    const old = store.days[today];
    store.days[today] = {
      takenAt: now.toISOString(),
      firstTip,
      version: M.MODEL.version,
      yes: +lg.yes.toFixed(4),
      // What the estimate rests on: this season's games so far and last season's rate.
      basis: { games: before.length, yesSoFar: before.length ? +(before.filter((g) => g.yes).length / before.length).toFixed(4) : null, prevYes: prev.yes != null ? +prev.yes.toFixed(4) : null },
      games: games.map((g) => ({ gid: g.gid, home: g.home, away: g.away, tip: g.tip })),
    };
    // Nothing changed since the last run: keep its timestamp so the data commit is skipped.
    if (old && JSON.stringify({ ...old, takenAt: 0 }) === JSON.stringify({ ...store.days[today], takenAt: 0 })) store.days[today] = old;
    const p = store.days[today].yes;
    const odds = (x) => { const o = Math.round(M.americanOdds(x)); return o > 0 ? `+${o}` : `${o}`; };
    console.log(`${today}: ${games.length} games, Yes ${(100 * p).toFixed(1)}% (break-even Yes ${odds(p)}, No ${odds(1 - p)})`);
  }
}

store.updated = now.toISOString();
await writeFile(path.join(DATA_DIR, file), JSON.stringify(store));
