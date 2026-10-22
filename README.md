# NBA First Minute

A tracker for the NBA prop **"both teams score in the first minute"**: Yes if both teams have a point
with 11:00 or more on the first-quarter clock. Any point counts (free throws at exactly 11:00 and
technical free throws before the first possession included).

Site: https://mattrudy13.github.io/nba-first-minute/

## At a glance

- **What it does:** reads each game's play-by-play to find when each team first scored, shows team
  splits and close calls, and saves a Yes chance before tip-off that is graded after the games.
- **How it was tested:** team-based estimates (each team's scoring rate, its opponent's allowed rate, home/away,
  last season's rates, recency weighting, the link between the two sides) were fitted on October–January 2025-26 and
  tested on February–April. None beat the plain league rate (41.8% Yes), so the live estimate is the
  league rate and the team numbers are shown as context only.
- **Live record:** the first saved estimate is Oct 22, 2026; graded days build up on the Model page.
- **Built with:** JavaScript (Node), GitHub Actions on a schedule, GitHub Pages and ESPN's public API.

## Pages

- **Today** (`index.html`): today's chance per game, the break-even prices for Yes and No, the slate
  with each team's first-minute rates, and results once games are final. `?d=YYYY-MM-DD` shows another day.
- **Teams** (`teams.html`): per team: scored by 11:00 (home/away), allowed, both scored, scored first,
  median clock at its first point, close calls. 2025-26 and 2026-27.
- **Games** (`games.html`): every game's first-point times and result, with team and result filters.
- **Model** (`model.html`): this season's graded record, the 2025-26 backtest, and how it works.

## The estimate

The league's Yes rate so far this season, with last season's rate counting as 200 games, the same for
every game. 2025-26 hit 41.8% (515 of 1,231 games); 2024-25 hit 38.5%. Break-even at 41.8% is about
+139 for Yes and −139 for No.

`scripts/backtest.mjs` tested team-based estimates on 2025-26 (fit Oct–Jan, holdout Feb–Apr): each team's
scoring rate, its opponent's allowed rate, home/away, last season's team rates, recency weighting and the
correlation between the two sides. None beat the plain league rate on the holdout, so the live estimate
stays at the league rate. Pregame totals and spreads showed no trend either.

## Data and automation

All data comes from ESPN's public site API (no key): the scoreboard for the schedule and each game's
summary for play-by-play. `.github/workflows/update-data.yml` runs four times a day from October to April:

1. `scripts/build-data.mjs`: schedule and, for each finished game, the clock at each team's first point →
   `data/<season>.json`. Seasons are named by start year (2026 = 2026-27).
2. `scripts/predict.mjs`: today's estimate → `data/predictions-<season>.json`. Locks at the first tip-off.
3. `scripts/grade.mjs`: grades locked estimates once a day's games are final.

```sh
node scripts/build-data.mjs 2025      # a past season (only new games are fetched; --reprocess for all)
node scripts/backtest.mjs             # 2025-26 backtest → data/backtest-2025.json
NOW=2026-10-22T15:00:00Z node scripts/predict.mjs   # pretend it's another time (testing)
python3 -m http.server                # serve locally
```

Run `node scripts/stamp-assets.mjs` before committing changes to `model.js`, `common.js` or `style.css`.
