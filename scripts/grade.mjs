#!/usr/bin/env node
// Grades locked estimates once every game that day is final: how many games hit Yes against the
// saved chance, with log loss and Brier score. Run after build-data.mjs.

import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const M = require("../model.js");
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const readJson = async (f) => JSON.parse(await readFile(path.join(DATA_DIR, f), "utf8"));

const { current: season } = await readJson("seasons.json");
const file = path.join(DATA_DIR, `predictions-${season}.json`);
let store;
try {
  store = JSON.parse(await readFile(file, "utf8"));
} catch {
  console.log("no predictions yet");
  process.exit(0);
}
const data = await readJson(`${season}.json`);

let graded = 0;
for (const [d, p] of Object.entries(store.days)) {
  // A game postponed after the estimate was saved drops off the schedule; grade the rest.
  const games = p.games.map((g) => data.games[g.gid]).filter((g) => g && g.d === d);
  if (!games.length || games.some((g) => g.yes == null)) continue;
  const yes = games.filter((g) => g.yes).length;
  const result = {
    games: games.length,
    yes,
    logLoss: +(games.reduce((s, g) => s + M.logLoss(p.yes, g.yes), 0) / games.length).toFixed(4),
    brier: +(games.reduce((s, g) => s + (p.yes - g.yes) ** 2, 0) / games.length).toFixed(4),
  };
  if (JSON.stringify(p.result) !== JSON.stringify(result)) {
    p.result = result;
    graded++;
  }
}
await writeFile(file, JSON.stringify(store));
console.log(`graded ${graded} day(s)`);
