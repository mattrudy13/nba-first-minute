// Data and model code shared by the pages (as globals) and the Node scripts (via createRequire).
// No DOM access here.

// ---- Play-by-play → one game row ----

// The prop: both teams score in the first minute of game clock. A point with 11:00 still on the
// Q1 clock counts (free throws at exactly 11:00 included), so the cutoff is 60 seconds, inclusive.
const FIRST_MINUTE = 60;

// ESPN's clock is "M:SS" above a minute and "SS.s" under it. Returns seconds left in the period.
function clockSeconds(display) {
  const s = String(display ?? "");
  const m = s.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

// Seconds into the game of each side's first point in Q1 (null = didn't score in Q1): the first
// scoring play credited to that team. Credited by team id rather than ESPN's running score, which
// is occasionally wrong for a play (401809971 shows 0-2 for 2-2).
function firstPoints(plays, homeId, awayId) {
  let hFirst = null, aFirst = null, firstScorer = null;
  for (const p of plays ?? []) {
    if (p.period?.number !== 1 || !p.scoringPlay || !(p.scoreValue > 0)) continue;
    const left = clockSeconds(p.clock?.displayValue);
    if (left == null) continue;
    const t = 720 - left;
    const tid = String(p.team?.id ?? "");
    if (hFirst == null && tid === String(homeId)) { hFirst = t; firstScorer ??= "home"; }
    if (aFirst == null && tid === String(awayId)) { aFirst = t; firstScorer ??= "away"; }
    if (hFirst != null && aFirst != null) break;
  }
  const h60 = hFirst != null && hFirst <= FIRST_MINUTE;
  const a60 = aFirst != null && aFirst <= FIRST_MINUTE;
  return { hFirst, aFirst, h60, a60, yes: h60 && a60, firstScorer };
}

// ---- Model: each side's chance of scoring in the first minute, then both ----

// Fitted by scripts/backtest.mjs (fit Oct–Jan 2025-26, holdout Feb–Apr). A term is switched off with
// Infinity (offK/defK), 0 (priorGames), Infinity (halfLife) or false (home). Terms stay only if they
// lower holdout log loss; the Model page lists what each one did.
const MODEL = {
  version: 1,
  leaguePrior: 200, // sides: last season's league rate counts as this many team-games this season
  offK: Infinity, // league-average pseudo-games mixed into a team's own scoring rate
  defK: Infinity, // same, for the rate a team allows
  priorGames: 0, // last season's team rate counts as this many games
  halfLife: Infinity, // recency weighting, in games
  home: false, // separate home and away league rates
  rho: 0, // correlation between the two sides scoring (they aren't independent)
};

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clampP = (p, lo = 0.001) => Math.min(1 - lo, Math.max(lo, p));

// Finished games, oldest first.
function finishedGames(data) {
  return Object.entries(data?.games ?? {})
    .filter(([, g]) => g.yes != null)
    .map(([gid, g]) => ({ gid, ...g }))
    .sort((a, b) => (a.tip < b.tip ? -1 : a.tip > b.tip ? 1 : 0));
}

// Whole-season rates for last season: league (all/home/away/yes) and each team's own and allowed rates.
function seasonRates(games) {
  const t = {};
  const add = (tm, k, hit) => { const x = (t[tm] ??= { off: [0, 0], def: [0, 0] })[k]; x[0] += hit; x[1]++; };
  let hh = 0, ah = 0, yes = 0;
  for (const g of games) {
    add(g.home, "off", g.h60); add(g.away, "off", g.a60);
    add(g.home, "def", g.a60); add(g.away, "def", g.h60);
    hh += g.h60; ah += g.a60; yes += g.yes;
  }
  const n = games.length;
  const r = ([h, m]) => (m ? h / m : null);
  return {
    n,
    all: n ? (hh + ah) / (2 * n) : null, home: n ? hh / n : null, away: n ? ah / n : null, yes: n ? yes / n : null,
    teams: Object.fromEntries(Object.entries(t).map(([tm, x]) => [tm, { off: r(x.off), def: r(x.def) }])),
  };
}

// Per-team results so far this season, newest last: off = did the team score, def = did its opponent.
function teamHistory(games) {
  const h = {};
  for (const g of games) {
    (h[g.home] ??= { off: [], def: [] }).off.push(g.h60); h[g.home].def.push(g.a60);
    (h[g.away] ??= { off: [], def: [] }).off.push(g.a60); h[g.away].def.push(g.h60);
  }
  return h;
}

// Recency-weighted hits and games over the last `len` entries of a 0/1 list.
function weighted(list, len, halfLife) {
  let hits = 0, n = 0;
  const decay = Number.isFinite(halfLife) ? Math.pow(0.5, 1 / halfLife) : 1;
  let w = 1;
  for (let i = len - 1; i >= 0; i--) { hits += w * list[i]; n += w; w *= decay; }
  return { hits, n };
}

// League rates this season so far, with last season's rates as a prior worth `leaguePrior` sides.
function leagueRates(games, prev, m = MODEL) {
  let hh = 0, ah = 0, yes = 0;
  for (const g of games) { hh += g.h60; ah += g.a60; yes += g.yes; }
  const n = games.length, w = prev?.all != null ? m.leaguePrior : 0;
  const mix = (hits, cnt, p, pw) => (cnt + pw ? (hits + pw * (p ?? 0)) / (cnt + pw) : 0.66);
  return {
    games: n,
    all: mix(hh + ah, 2 * n, prev?.all, w),
    home: mix(hh, n, prev?.home, w / 2),
    away: mix(ah, n, prev?.away, w / 2),
    yes: mix(yes, n, prev?.yes, w / 2),
  };
}

// A team's rate on log-odds, relative to the league: its own (recency-weighted) games, plus last
// season's rate worth `priorGames` games, plus `k` games at the league rate. 0 when the term is off.
function teamEdge(list, len, league, prevRate, prevLeague, k, m) {
  if (!Number.isFinite(k)) return 0;
  const { hits, n } = list ? weighted(list, len, m.halfLife) : { hits: 0, n: 0 };
  let pHits = 0, pN = 0;
  if (m.priorGames > 0 && prevRate != null && prevLeague != null) {
    pN = m.priorGames;
    pHits = pN * sigmoid(logit(league) + logit(clampP(prevRate, 0.02)) - logit(prevLeague));
  }
  const rate = (hits + pHits + k * league) / (n + pN + k || 1);
  return logit(clampP(rate, 0.02)) - logit(league);
}

// Both sides' chances and the chance both score. `hist` = teamHistory(games before the date),
// `lg` = leagueRates(...), `prev` = seasonRates(last season), `len` = {team: games to use} (default all).
function gameChance(home, away, hist, lg, prev, m = MODEL, len = {}) {
  const edge = (tm, k, key) => {
    const list = hist[tm]?.[key];
    return teamEdge(list, len[tm] ?? list?.length ?? 0, lg.all, prev?.teams?.[tm]?.[key], prev?.all, k, m);
  };
  const base = (side) => logit(clampP(m.home ? lg[side] : lg.all));
  const pHome = sigmoid(base("home") + edge(home, m.offK, "off") + edge(away, m.defK, "def"));
  const pAway = sigmoid(base("away") + edge(away, m.offK, "off") + edge(home, m.defK, "def"));
  return { pHome, pAway, pYes: yesChance(pHome, pAway, m.rho) };
}

// Two correlated yes/no events: P(both) = pA·pB + ρ·√(pA(1−pA)pB(1−pB)).
function yesChance(pA, pB, rho) {
  return clampP(pA * pB + rho * Math.sqrt(pA * (1 - pA) * pB * (1 - pB)));
}

const logLoss = (p, hit) => -Math.log(hit ? p : 1 - p);

if (typeof module !== "undefined") {
  module.exports = {
    FIRST_MINUTE, clockSeconds, firstPoints,
    MODEL, logit, sigmoid, finishedGames, seasonRates, teamHistory, leagueRates, gameChance, yesChance, logLoss,
  };
}
