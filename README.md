# Hardwood Sim

A possession-by-possession NBA game simulator that runs in the browser. It's the basketball sibling of [Gridiron Sim](https://github.com/Jlabianca/gridiron-sim). Pick a matchup and you can:

https://jlabianca.github.io/hardwood-sim/

- **Watch a sim**: an animated replay of one simulated game, with a scoreboard, a court view with a live shot chart, the ten players on the floor with their running stat lines, the line score, a game-flow (lead tracker) chart, a live win-probability chart (also shown on the scoreboard) and a full box score at the final buzzer. Win % comes from the margin, the time left and the pre-game edge: the rest of the game is treated as normally distributed, with the pre-game expected margin and spread taken from 400 quick simulations of the matchup. In a calibration check over 1,500 simulated games it was accurate at every stage (for example, teams given 75% at halftime won 75%). Every game comes from a seed, and *Copy link* shares that exact game (for example `#NY@BOS/42`).
- **Rest**: back-to-backs are flagged in the game list, and each team's rest (back-to-back, 1 day, 2+ days) is pulled from the schedule and can be changed.
- **Slate**: one click runs every game on the selected date (1,000–5,000 sims each; a 15-game night takes about 20 seconds at 2,000). You get a table of every game (projected score, win %, fair moneyline and spread, and cover / over odds for the market lines you type in) and one props table across all games, with any stat, a game filter, a player search and a *Biggest edge* sort. *Paste lines* takes a list like `Jalen Brunson, pts, 25.5` and fills in your lines in one go. Edge is the model's probability on the better side of your line minus 52.4% (break-even at −110). *Download CSV* exports every player and stat for the night. Click a matchup to open it on the Projections tab with the same simulations.
- **Projections & props**: re-run the game 1,000–20,000 times to get win probability, fair moneylines, a fair spread, cover and over/under odds against the market line you type in, the margin and total distributions, and per-player prop distributions. Covered stats are points, rebounds, assists, 3-pointers made, PRA, P+R, P+A, R+A, steals, blocks, stocks, turnovers, minutes, double-doubles and triple-doubles. Type in a sportsbook line and it shows the model's over/under probability and fair odds. *Download CSV* exports every player and every stat for the game.
- **Alt-line ladders**: the model's over/under % and fair odds at a range of lines, for every player stat (on the player card) and for the game spread, total, each team's total and the first-half total (on the Projections tab). Type a book's price on any rung to get its EV per $100, or add any rung to the parlay slip. Rungs stay on half points, so they can't push.
- **Same-game parlays** (on the Projections tab): build a parlay from player props (any stat, over/under, double-/triple-doubles), moneyline, spread and game total, or click the O / U buttons in any props table (including the Slate's). Every leg is checked in the *same* simulated game, so correlation is measured instead of assumed: you get the chance all legs hit, fair parlay odds, what the price would be if the legs were independent, and the correlation lift between them (for example, a star's points over and the game over usually help each other; two teammates' points overs work against each other). Type the book's parlay odds to get the EV per $100. The page warns you when the edge is inside the simulation noise.
- **Parlay slip** (on the Slate tab): a multi-game parlay. Add moneylines, spreads and totals with the buttons on each game row, props with the O / U buttons, or same-game legs from the Projections tab. Legs in the same game are priced together from the same simulated games (correlation included); separate games are simulated independently, so their chances multiply. Shows each game's chance, the combined chance with a margin of error, fair odds, the independent price, and EV per $100 against the book's parlay odds.
- **Player cards**: click any player's name (props tables, Slate, Injuries tab, box score) for his card: tonight's model projection next to his season, last-5, last-10 and vs-tonight's-opponent averages, how often he went over your line in each, a bar chart of his last 15 games against the line, the model's distribution for tonight, and his full game log (this season plus the end of last season, DNPs included). Switch the stat, change the line (shared with the props tables), or add the over/under to the parlay slip. Game logs live in `site/data/logs.json`, loaded only when a card opens.
- **Injuries / minutes**: toggle players in or out, or type a player's projected minutes to override the model. Everyone else's minutes and shots re-balance around the change. Edits stick to the player when you switch games, and the Slate tab uses them too; *Reset to model* clears them.

The site is fully static: one JSON model file and plain JavaScript, with no server. It's hosted on GitHub Pages, and a scheduled GitHub Action rebuilds the model from fresh data twice a day.

## How the model works

`scripts/build_data.py` reads player and team box scores, shot locations, the schedule and rosters from [hoopR](https://github.com/sportsdataverse/hoopR-nba-data), plus ESPN's injury report, and writes `site/data/model.json`:

- **Players**: per-minute rates for shots, 3-point attempts, free-throw trips, turnovers, assists, offensive and defensive rebounds, steals, blocks and fouls. Rates are recency-weighted (half-life of 15 games), last season counts at a lower weight, and everything gets a small pull toward the average for the player's position. Each player has a shot profile from his shot chart: rim vs. mid-range share, make rate at the rim and from mid-range, 3P%, FT%, corner-three share and dunk rate.
- **Minutes**: a recency-weighted projection (half-life of 4 games, coach's-decision DNPs count as 0). Projections are re-scaled to 240 per team after injuries, so a star's absence spreads minutes over the rotation.
- **Teams**: pace, plus defensive factors (eFG% allowed, turnovers forced, offensive rebounds allowed, free-throw rate and 3-point attempt rate allowed). These are recency-weighted and shrunk toward league average.
- **Defense by player**: `scripts/lineups.py` rebuilds who was on the floor for every stretch of every game from the play-by-play substitutions (about 99% of periods are rebuilt cleanly). A ridge regression on those stints, the same idea as adjusted plus-minus (RAPM), gives each player a defensive rating: how many points per 100 possessions the opponent scores less with him on the floor, after accounting for the other nine players. The current season counts fully and last season at 60%. The DEF column on the Injuries / minutes tab shows it. The top of the list is Gobert, Holmgren, Wembanyama, Caruso and Derrick White.
- **Rest**: a margin regression with team strengths, over the current and previous season, measures what rest is worth: the second night of a back-to-back costs about 2–3 points vs. a normal day off. Rest days come from the schedule; you can change them on the page.

`site/js/sim.js` then plays the game one possession at a time:

- The clock runs from both teams' pace. Late in close games, teams milk the clock or hurry, and a trailing team fouls on purpose.
- The five offensive players compete for each "chance" (shot, free-throw trip or turnover) in proportion to their rates. The defense shifts the odds.
- The shot zone and make probability come from the shooter's profile, adjusted for the defense, home court, rest, transition and putbacks.
- **Lineup defense**: the five defenders on the floor are compared with the team's usual defense (weighted by minutes actually played), so when an elite defender sits, or is out injured, the opponent shoots better.
- **Matchups**: every time lineups change, each defender picks up an offensive player at his position, with the best defender taking the most dangerous scorer. The primary defender's rating counts extra on his man's shots, so a guard facing Derrick White has a tougher night than one facing a weak defender. Team totals don't change from this; it shifts production between players. The play-by-play names the defender on each shot.
- A lineup that has to create more than usual (say, with its star sitting) gets slightly less efficient. That's why removing a star costs a team points instead of just handing his shots to someone else.
- Misses go to a rebound battle between the ten players on the floor. Assists, blocks and steals go to the players who rack them up.
- A rotation engine plays everyone toward his minutes target, handling starters, closers in tight fourth quarters, foul trouble, foul-outs, garbage time and overtime.

`scripts/calibrate.js` tunes four global constants so the simulated league matches the real one in points per game, possessions per game, rebounds per game and home-court margin.

### Backtest (2025-26 season, Feb 2 – Mar 22, 290 games, each week using only data available before it)

Inactive players were taken from the real box score (they're known at tip-off), and rest days from the schedule.

| | Model | Closing market |
|---|---|---|
| Margin error (MAE) | 11.06 | 10.37 |
| Total error (MAE) | 14.82 | 14.07 |
| Mean total | 230.9 | 228.4 (actual 229.8) |

The model's margins correlate 0.88 with the closing spreads. Its win-probability Brier score is 0.187 (0.192 before the rest, lineup-defense and matchup upgrades; lower is better), and the total error improved from 15.00. Margin error and player projections were unchanged within noise. Player projections correlate 0.70 with actual points, 0.66 with rebounds, 0.69 with assists and 0.54 with 3-pointers made. For comparison, simply using each player's season-to-date average gives a points error (MAE) of 4.83 against the model's 4.63. Most of the gain comes from knowing who's out and re-spreading minutes and shots; on rebounds and assists the model only matches the season averages. **Bottom line: it's sensible, but it doesn't beat the closing line.** Treat a gap between the model and the market as a reason to dig in, not as a bet. To rerun the backtest:

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
- Matchups are assigned by position and defensive rating, not from tracking data, and the defensive ratings are noisy for players with few minutes (they're shrunk toward zero). Rest doesn't yet make coaches rest stars on back-to-backs; use the injury toggles for that. No coach-specific rotation patterns.
- Shot locations on the court are illustrative: they're drawn from the player's zone mix, not real tracking data.
- Market lines aren't in the data for upcoming games; type them in on the Projections tab. Closing lines show up for past games.
- Parlay legs with whole-number lines can push; pushes count as not hitting, so prefer half-point lines.
- Ideas: pulling live prop lines from an odds API, and tracking the model's results over the season.

## Data and credits

Box scores, shot locations, schedule, rosters and historical closing lines come from [sportsdataverse/hoopR-nba-data](https://github.com/sportsdataverse/hoopR-nba-data), which collects them from ESPN. Injury statuses come from ESPN's public injury feed. This project isn't affiliated with the NBA. It's for entertainment and research.
