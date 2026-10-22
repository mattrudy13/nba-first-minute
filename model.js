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

if (typeof module !== "undefined") {
  module.exports = { FIRST_MINUTE, clockSeconds, firstPoints };
}
