# Hardwood Sim

A possession-by-possession NBA game simulator that runs in the browser. It's the basketball sibling of [Gridiron Sim](https://github.com/Jlabianca/gridiron-sim). Pick a matchup and you can:

https://jlabianca.github.io/hardwood-sim/

- **Watch a sim**: an animated replay of one simulated game, with a scoreboard, a court view with a live shot chart, the ten players on the floor with their running stat lines, the line score, a game-flow (lead tracker) chart and a full box score at the final buzzer. Every game comes from a seed, and *Copy link* shares that exact game (for example `#NY@BOS/42`).
- **Projections & props**: re-run the game 1,000–20,000 times to get win probability, fair moneylines, a fair spread, cover and over/under odds against the market line you type in, the margin and total distributions, and per-player prop distributions. Covered stats are points, rebounds, assists, 3-pointers made, PRA, P+R, P+A, R+A, steals, blocks, stocks, turnovers, minutes, double-doubles and triple-doubles. Type in a sportsbook line and it shows the model's over/under probability and fair odds. *Download CSV* exports every player and every stat for the game.
- **Injuries / minutes**: toggle players in or out, or type a player's projected minutes to override the model. Everyone else's minutes and shots re-balance around the change. Changes apply to both tabs.

The site is fully static: one JSON model file and plain JavaScript, with no server. It's hosted on GitHub Pages, and a scheduled GitHub Action rebuilds the model from fresh data twice a day.

## How the model works

`scripts/build_data.py` reads player and team box scores, shot locations, the schedule and rosters from [hoopR](https://github.com/sportsdataverse/hoopR-nba-data), plus ESPN's injury report, and writes `site/data/model.json`:

- **Players**: per-minute rates for shots, 3-point attempts, free-throw trips, turnovers, assists, offensive and defensive rebounds, steals, blocks and fouls. Rates are recency-weighted (half-life of 15 games), last season counts at a lower weight, and everything gets a small pull toward the average for the player's position. Each player has a shot profile from his shot chart: rim vs. mid-range share, make rate at the rim and from mid-range, 3P%, FT%, corner-three share and dunk rate.
- **Minutes**: a recency-weighted projection (half-life of 4 games, coach's-decision DNPs count as 0). Projections are re-scaled to 240 per team after injuries, so a star's absence spreads minutes over the rotation.
- **Teams**: pace, plus defensive factors (eFG% allowed, turnovers forced, offensive rebounds allowed, free-throw rate and 3-point attempt rate allowed). These are recency-weighted and shrunk toward league average.

`site/js/sim.js` then plays the game one possession at a time:

- The clock runs from both teams' pace. Late in close games, teams milk the clock or hurry, and a trailing team fouls on purpose.
- The five offensive players compete for each "chance" (shot, free-throw trip or turnover) in proportion to their rates. The defense shifts the odds.
- The shot zone and make probability come from the shooter's profile, adjusted for the defense, home court, transition and putbacks.
- A lineup that has to create more than usual (say, with its star sitting) gets slightly less efficient. That's why removing a star costs a team points instead of just handing his shots to someone else.
- Misses go to a rebound battle between the ten players on the floor. Assists, blocks and steals go to the players who rack them up.
- A rotation engine plays everyone toward his minutes target, handling starters, closers in tight fourth quarters, foul trouble, foul-outs, garbage time and overtime.

`scripts/calibrate.js` tunes four global constants so the simulated league matches the real one in points per game, possessions per game, rebounds per game and home-court margin.

### Backtest (2025-26 season, Feb 2 – Mar 22, 290 games, each week using only data available before it)

Inactive players were taken from the real box score (they're known at tip-off).

| | Model | Closing market |
|---|---|---|
| Margin error (MAE) | 11.03 | 10.37 |
| Total error (MAE) | 15.00 | 14.07 |
| Mean total | 231.1 | 228.4 (actual 229.8) |

The model's margins correlate 0.88 with the closing spreads, and it picked the winner 73.8% of the time. Its player projections correlate 0.70 with actual points, 0.66 with rebounds, 0.69 with assists and 0.54 with 3-pointers made. For comparison, simply using each player's season-to-date average gives a points error (MAE) of 4.83 against the model's 4.63. Most of the gain comes from knowing who's out and re-spreading minutes and shots; on rebounds and assists the model only matches the season averages. **Bottom line: it's sensible, but it doesn't beat the closing line.** Treat a gap between the model and the market as a reason to dig in, not as a bet. To rerun the backtest:

```bash
python scripts/export_actuals.py --season 2026 --start 2026-02-02 --end 2026-03-22
for d in 2026-02-02 2026-02-09 2026-02-23 2026-03-02 2026-03-09 2026-03-16; do
  python scripts/build_data.py --season 2026 --asof $d --out backtest/model_$d.json
  node scripts/calibrate.js backtest/model_$d.json
done
node scripts/backtest.js 2026 2026-02-02 2026-02-09 2026-02-23 2026-03-02 2026-03-09 2026-03-16
```

## Run locally

```bash
pip install -r requirements.txt
python scripts/build_data.py           # downloads hoopR data into data_raw/, writes site/data/model.json
node scripts/calibrate.js              # tunes scoring, pace, rebounds and home court
cd site && python -m http.server 8000  # open http://localhost:8000
```

Opening `index.html` straight from disk won't work, because the page has to fetch the JSON file. Use the local server above.

## Deploy on GitHub Pages

1. In the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
2. The workflow in `.github/workflows/update.yml` runs on every push, twice a day (about 9am and 5:40pm ET, for overnight box scores and the pre-game injury report), and on demand from the **Actions** tab. It rebuilds the model and deploys the site to `https://<you>.github.io/<repo>/`.

## Known limitations / ideas

- Early in the season, current-season samples are small, so last season carries more weight. Players who changed teams bring their old rates with them.
- No lineup-specific (on/off) effects beyond shot creation, no rest or back-to-back adjustment, and no coach-specific rotation patterns. Positions are only used loosely when choosing lineups.
- Shot locations on the court are illustrative: they're drawn from the player's zone mix, not real tracking data.
- Market lines aren't in the data for upcoming games; type them in on the Projections tab. Closing lines show up for past games.
- Ideas: pulling live prop lines from an odds API, a slate view that projects every game of the night at once, and tracking the model's results over the season.

## Data and credits

Box scores, shot locations, schedule, rosters and historical closing lines come from [sportsdataverse/hoopR-nba-data](https://github.com/sportsdataverse/hoopR-nba-data), which collects them from ESPN. Injury statuses come from ESPN's public injury feed. This project isn't affiliated with the NBA. It's for entertainment and research.
