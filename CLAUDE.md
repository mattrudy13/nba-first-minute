# nba-first-minute: project notes

NBA "both teams score in the first minute" prop tracker on GitHub Pages:
https://mattrudy13.github.io/nba-first-minute/. Same conventions as `../kotc-tracker`: plain HTML/CSS/JS,
no build step, globals in `model.js` (data/model, no DOM, also required by the scripts) and `common.js`
(DOM), Barlow Condensed + Inter, dark top bar. Accent is teal. README.md covers the pages and pipeline.

## Status (2026-10-21)

v0.1 built 2026-10-21: data for 2024-25 (prior only), 2025-26 and 2026-27 so far; backtest; Today, Teams,
Games and Model pages; update workflow. The first saved estimate is Oct 22 (Oct 21's games had tipped
before the pipeline existed).

## Rudy's decisions (don't relitigate)

- The prop: Yes if both teams score with **11:00 or more** on the Q1 clock. 11:00 counts. **Any points**
  count, including technical free throws before the first possession (e.g. 401810559, BKN @ DET).
- Regular season + NBA Cup only (`isCountedGame`, copied from kotc). No playoffs, play-in or All-Star.
- Wanted: team splits, a matchup estimate, timing detail (close calls). No odds comparison for now.
- Estimates saved before tip-off and graded, like kotc.
- **Live estimate = league Yes rate** (2026-10-21), since no team-based estimate beat it in the backtest.
  Rudy chose this over showing the team model as "experimental". Team rates are shown as context only.
- A team-based estimate goes live only if it beats the league Yes rate on the holdout (keep rule).

## Data

- `data/<season>.json`: `games{gid}` keyed by ESPN event id: `d` (Eastern date), `tip`, `home`, `away`, `hs`,
  `as`, `state`, `detail`, `note`; once processed: `hFirst`/`aFirst` (seconds into the game of each side's
  first point, null = none in Q1), `h60`/`a60`, `yes`, `firstScorer`. Plus `teams`, `processedEvents`,
  `scannedThrough`. `2024.json` exists only as the prior for the 2025-26 backtest.
- First points are credited by the **scoring play's team id**, not ESPN's running score, which is wrong on the
  odd play (401809971 shows 0–2 for 2–2). Both methods agreed on all 1,231 2025-26 games. A finished game
  with no Q1 plays is left unprocessed and retried (missing play-by-play, not a 0–0 quarter).
- ESPN's clock is whole seconds above a minute. A play logged at "12:00" can be a real point (technical
  free throw, or a basket logged before the clock started: 401810650).
- `predictions-<season>.json`: `days[d]` = `{takenAt, firstTip, version, yes, basis: {games, yesSoFar, prevYes},
  games[], result?}`. `result` = `{games, yes, logLoss, brier}`. Locks at the first tip or once any game
  has started; an unchanged estimate keeps its old `takenAt` so the data commit is skipped.
- `backtest-2025.json`: baselines, every term combination (`combos`, with holdout difference vs the league
  rate ± paired SE), `keepRule`, `chosen`, `leaguePriorScan`, `live`, `calibration` (best team model).

## Findings (2025-26, all 1,231 games)

- Yes 41.8%; home scored 67.9%, away 65.9%; independent product 44.7%, so the sides are negatively
  correlated (fitted ρ ≈ −0.05 to −0.125). 2024-25: Yes 38.5%. By month 2025-26: Oct 49%, Nov 41%, Dec 44%,
  Jan 43%, Feb 40%, Mar 44%, Apr 29%.
- Team offense split-half (odd vs even games) r = 0.46, first vs second half of season 0.24, season to
  season 0.04. Defense 0.11 / 0.12. Spread across teams 7.5 pts (offense) vs 5.2 from luck alone.
- Backtest (fit Oct–Jan 730 games, holdout Feb–Apr 501, 39.7% Yes): league Yes rate 0.6732 holdout log
  loss; best team model 0.6747; offense only 0.6750; raw team-rate product 0.6845. All team models within
  ~1 SE of the league rate.
- League prior: 200 games of last season's rate (`MODEL.leaguePrior` 400 sides) was best on the fit window;
  differences tiny.
- Pregame total (from kotc's `data/2025.json`) and spread: no trend in Yes rate by quintile.
- 19 games had a first point at exactly 11:00; 260 No games were close calls (a first point at 10:59–10:45).

## Before every commit that touches model.js, common.js or style.css

Run `node scripts/stamp-assets.mjs`. `check-assets.yml` fails the push otherwise.

## Dev notes

- Serve with `python3 -m http.server`. Test with Playwright from `../apartments/.venv/bin/python`: every page
  in light and dark mode at 1280 and 375 px, no console errors, no page-level sideways scroll.
- Test predict/grade on a scratch copy of the repo with `NOW=<iso>`; the lock also checks game states, so
  a past day with started games stays locked whatever `NOW` says.
- stats.nba.com timed out and cdn.nba.com returned 403 from this Mac (2026-10-21), so ESPN is the only source.
- **Tooltips only for definitions**, by Rudy's request. None are used.
- Commit prefixes: `feat:`, `fix:`, `docs:`, `data:` (the bot uses `data:`). No commits or pushes 8 AM–5 PM ET on
  weekdays unless Rudy asks.
