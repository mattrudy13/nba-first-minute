#!/usr/bin/env node
// Replays a season day by day (each day sees only earlier games, plus the season before as a prior)
// to choose the model's terms and constants. Fit window Oct–Jan, holdout Feb–Apr.
//
//   node scripts/backtest.mjs          # 2025-26 → data/backtest-2025.json, prints the comparison
//   node scripts/backtest.mjs 2025
//
// Every combination of terms is fitted on the fit window by grid search (rho fitted on top). Terms are
// then dropped one at a time while dropping one lowers holdout log loss (the keep rule). The chosen
// terms' constants are refitted on the whole season for live use.

import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const M = require("../model.js");
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const readJson = async (f) => JSON.parse(await readFile(path.join(DATA_DIR, f), "utf8"));

const season = Number(process.argv.slice(2).find((a) => /^\d{4}$/.test(a)) ?? 2025);
const games = M.finishedGames(await readJson(`${season}.json`));
const prev = M.seasonRates(M.finishedGames(await readJson(`${season - 1}.json`)));
const split = `${season + 1}-02-01`;
const isFit = games.map((g) => g.d < split);

const GRID = {
  offK: [10, 20, 40, 80, 160, 320],
  defK: [10, 20, 40, 80, 160, 320],
  priorGames: [5, 10, 20, 40],
  halfLife: [10, 20, 40, 80],
  home: [true],
};
const OFF = { offK: Infinity, defK: Infinity, priorGames: 0, halfLife: Infinity, home: false };
const TERMS = Object.keys(GRID);
const RHOS = Array.from({ length: 17 }, (_, i) => -0.25 + 0.025 * i);

// One pass over the season: each side's chance for every game, from games on earlier days only.
function replay(m) {
  const out = new Array(games.length);
  const hist = {};
  const done = [];
  let i = 0;
  while (i < games.length) {
    const d = games[i].d;
    const lg = M.leagueRates(done, prev, m);
    let j = i;
    for (; j < games.length && games[j].d === d; j++) {
      const g = games[j];
      const c = M.gameChance(g.home, g.away, hist, lg, prev, { ...m, rho: 0 });
      out[j] = { pHome: c.pHome, pAway: c.pAway, lgYes: lg.yes };
    }
    for (let k = i; k < j; k++) {
      const g = games[k];
      (hist[g.home] ??= { off: [], def: [] }).off.push(g.h60); hist[g.home].def.push(g.a60);
      (hist[g.away] ??= { off: [], def: [] }).off.push(g.a60); hist[g.away].def.push(g.h60);
      done.push(g);
    }
    i = j;
  }
  return out;
}

const lossOf = (pred, rho, which) => {
  let s = 0, n = 0;
  pred.forEach((p, k) => {
    if (which === "fit" ? !isFit[k] : which === "hold" ? isFit[k] : false) return;
    s += M.logLoss(M.yesChance(p.pHome, p.pAway, rho), games[k].yes); n++;
  });
  return s / n;
};
const bestRho = (pred, which) => RHOS.reduce((b, r) => (lossOf(pred, r, which) < lossOf(pred, b, which) ? r : b), 0);

// All combinations of each term's grid values (or off).
function* configs(terms) {
  const keys = [...terms];
  function* rec(i, acc) {
    if (i === keys.length) { yield acc; return; }
    for (const v of GRID[keys[i]]) yield* rec(i + 1, { ...acc, [keys[i]]: v });
  }
  yield* rec(0, { ...M.MODEL, ...OFF });
}

const subsetKey = (terms) => (terms.length ? [...terms].sort().join("+") : "none");
const subsets = [];
for (let mask = 0; mask < 1 << TERMS.length; mask++) {
  const terms = TERMS.filter((_, i) => mask & (1 << i));
  // Last season's team rate and recency weighting only act on a team term.
  if ((terms.includes("priorGames") || terms.includes("halfLife")) && !terms.includes("offK") && !terms.includes("defK")) continue;
  subsets.push(terms);
}

// Fit each combination on the fit window (or the whole season).
function fitSubset(terms, which) {
  let best = null;
  for (const m of configs(terms)) {
    const pred = replay(m);
    const rho = bestRho(pred, which);
    const loss = lossOf(pred, rho, which);
    if (!best || loss < best.loss) best = { m: { ...m, rho }, pred, loss };
  }
  return best;
}

const t0 = Date.now();
const fitted = {};
for (const terms of subsets) {
  const f = fitSubset(terms, "fit");
  fitted[subsetKey(terms)] = { terms, m: f.m, fit: f.loss, hold: lossOf(f.pred, f.m.rho, "hold"), pred: f.pred };
}

// Baselines: the league's Yes rate so far, and each team's raw scoring rate multiplied (no shrinkage).
const ref = fitted.none.pred;
const baseLoss = (which) => {
  let s = 0, n = 0;
  ref.forEach((p, k) => { if ((which === "fit") !== isFit[k]) return; s += M.logLoss(M.yesChance(p.lgYes, 1, 0), games[k].yes); n++; });
  return s / n;
};
const rawPred = replay({ ...M.MODEL, ...OFF, offK: 1e-9 });
const holdIdx = games.map((_, k) => k).filter((k) => !isFit[k]);

// Paired standard error of a holdout log-loss difference vs the league Yes rate.
function vsLeague(pred, rho) {
  const diffs = holdIdx.map((k) => M.logLoss(M.yesChance(pred[k].pHome, pred[k].pAway, rho), games[k].yes) - M.logLoss(M.yesChance(ref[k].lgYes, 1, 0), games[k].yes));
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (diffs.length - 1));
  return { diff: mean, se: sd / Math.sqrt(diffs.length) };
}

// Keep rule: from all terms, drop the term whose removal lowers holdout log loss most; repeat.
let chosen = [...TERMS];
const steps = [];
for (;;) {
  const cur = fitted[subsetKey(chosen)];
  const drops = chosen
    .map((t) => ({ t, key: subsetKey(chosen.filter((x) => x !== t)) }))
    .filter((x) => fitted[x.key])
    .map((x) => ({ ...x, hold: fitted[x.key].hold }));
  const best = drops.sort((a, b) => a.hold - b.hold)[0];
  if (!best || best.hold >= cur.hold) break;
  steps.push({ drop: best.t, from: cur.hold, to: best.hold });
  chosen = chosen.filter((x) => x !== best.t);
}
const pick = fitted[subsetKey(chosen)];
const live = fitSubset(chosen, "all");

// Calibration of the chosen model's holdout chances.
const BUCKETS = [0, 0.35, 0.4, 0.45, 0.5, 1];
const calibration = BUCKETS.slice(0, -1).map((lo, i) => {
  const ks = holdIdx.filter((k) => { const p = M.yesChance(pick.pred[k].pHome, pick.pred[k].pAway, pick.m.rho); return p >= lo && p < BUCKETS[i + 1]; });
  const avg = (f) => (ks.length ? ks.reduce((s, k) => s + f(k), 0) / ks.length : null);
  return { lo, hi: BUCKETS[i + 1], n: ks.length, predicted: avg((k) => M.yesChance(pick.pred[k].pHome, pick.pred[k].pAway, pick.m.rho)), actual: avg((k) => +games[k].yes) };
});

const round = (x, n = 4) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 10 ** n) / 10 ** n);
const params = (m) => ({ offK: m.offK, defK: m.defK, priorGames: m.priorGames, halfLife: m.halfLife, home: m.home, rho: round(m.rho, 3) });
const nFit = isFit.filter(Boolean).length;
const out = {
  season,
  updated: new Date().toISOString(),
  version: M.MODEL.version,
  fitWindow: { from: games[0].d, to: games[nFit - 1].d, games: nFit },
  holdout: { from: games[nFit].d, to: games.at(-1).d, games: games.length - nFit, yesRate: round(holdIdx.filter((k) => games[k].yes).length / holdIdx.length) },
  baselines: {
    leagueYes: { fit: round(baseLoss("fit")), hold: round(baseLoss("hold")) },
    rawProduct: { fit: round(lossOf(rawPred, 0, "fit")), hold: round(lossOf(rawPred, 0, "hold")) },
  },
  combos: Object.values(fitted)
    .map((f) => ({ terms: f.terms, fit: round(f.fit), hold: round(f.hold), ...Object.fromEntries(Object.entries(vsLeague(f.pred, f.m.rho)).map(([k, v]) => [k, round(v, 5)])), params: params(f.m) }))
    .sort((a, b) => a.hold - b.hold),
  keepRule: steps.map((s) => ({ drop: s.drop, from: round(s.from), to: round(s.to) })),
  chosen: { terms: chosen, fitParams: params(pick.m), hold: round(pick.hold), liveParams: params(live.m) },
  calibration: calibration.map((c) => ({ ...c, predicted: round(c.predicted), actual: round(c.actual) })),
};
// JSON has no Infinity: a switched-off term is stored as null.
await writeFile(path.join(DATA_DIR, `backtest-${season}.json`), JSON.stringify(out, (k, v) => (v === Infinity ? null : v)));

const fmt = (x) => x.toFixed(4);
console.log(`${season} backtest (${((Date.now() - t0) / 1000).toFixed(0)} s): fit ${out.fitWindow.games} games, holdout ${out.holdout.games} (Yes ${(100 * out.holdout.yesRate).toFixed(1)}%)`);
console.log(`  league Yes rate        fit ${fmt(out.baselines.leagueYes.fit)}  hold ${fmt(out.baselines.leagueYes.hold)}`);
console.log(`  raw team-rate product  fit ${fmt(out.baselines.rawProduct.fit)}  hold ${fmt(out.baselines.rawProduct.hold)}`);
for (const c of out.combos) console.log(`  ${subsetKey(c.terms).padEnd(40)} fit ${fmt(c.fit)}  hold ${fmt(c.hold)}  vs league ${c.diff >= 0 ? "+" : ""}${c.diff.toFixed(4)} ± ${c.se.toFixed(4)}  ${JSON.stringify(c.params)}`);
console.log("keep rule:", steps.map((s) => `drop ${s.drop} (${fmt(s.from)} → ${fmt(s.to)})`).join(", ") || "nothing dropped");
console.log("chosen:", subsetKey(chosen), "fit params", JSON.stringify(params(pick.m)), "→ live (whole season)", JSON.stringify(params(live.m)));
console.log("calibration (holdout):", calibration.map((c) => `${c.lo}-${c.hi}: n ${c.n}, ${c.predicted == null ? "–" : (100 * c.predicted).toFixed(1)}% vs ${c.actual == null ? "–" : (100 * c.actual).toFixed(1)}%`).join(" | "));
