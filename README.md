# Hardwood Sim

A possession-by-possession NBA game simulator that runs in the browser. It's the basketball sibling of [Gridiron Sim](https://github.com/Jlabianca/gridiron-sim). Pick a matchup and you can:

https://jlabianca.github.io/hardwood-sim/

- **Today** (the home page): plain-English cards for every game on the date — who wins and how often, the likely score, each team's key players, who's out, back-to-backs — plus **Model's favorite plays**: the night's strongest leans (best stat per player, vs. his season average or your own line), each with a strength label and a one-line **why** (teammates out and how he's done without them, matchup rank, minutes trend, recent form, expected pace, rest). Plays where a player's role has changed a lot are flagged, since sportsbooks will have moved those lines. Early in the season the model leans on last season more than on a hot or cold start, so some picks go against a player's recent games; those are tagged, the "why" names the last-season vs. this-season gap, and the watch-out shows his last-10 record. (In the tracker's graded games, when the model leaned against a player's last 10 by 7+ games, the model was right 65% of the time.) Your favorite players are pinned at the top.
- **Live**: tonight's games with scores and clock from ESPN's public scoreboard (refreshes every 20 seconds while games are on), a live win chance for each game that starts from the model's pre-game simulation and moves with the score and clock, the total's pace, and a box score next to each player's projection with his points pace. Your parlay slip (now saved in the browser) is tracked leg by leg with a live chance for each and for the whole parlay; the model's favorite plays and your favorite players are tracked too.
- **Stats basis** (top right, remembered): *this season* builds every player and team rating from 2026-27 games only (players who haven't played yet keep the blend); *this + last season* blends in last season, fading it out as this season's games come in. Every simulation on the site uses the chosen basis. On this season's first 104 games the blend predicted better (winners 69% vs. 59%, margin error 11.7 vs. 12.9, rebounds/assists error 1.91/1.40 vs. 2.02/1.53); the gap shrinks as the season goes on. The player card also has a **Season** dropdown (this season, each past season, or all) for its averages, hit rates, chart and game log.
- **Simple / Advanced mode** (top right, remembered): Simple shows Strong / Lean / Slight / Toss-up labels and plain odds ("hits about 6 in 10", "about 1 in 8", "a slightly bad price") and hides the technical columns and alt-line ladders; Advanced shows every number.
- **Player search** (top right): type any name to open his card, with tonight's matchup if he's playing. Cards have a **Model's take** with the reasons, and a ☆ Favorite button.
- **Watch a sim**: an animated replay of one simulated game, with a scoreboard, a court view with a live shot chart, the ten players on the floor with their running stat lines, the line score, a game-flow (lead tracker) chart, a live win-probability chart (also shown on the scoreboard) and a full box score at the final buzzer. Win % comes from the margin, the time left and the pre-game edge: the rest of the game is treated as normally distributed, with the pre-game expected margin and spread taken from 400 quick simulations of the matchup. In a calibration check over 1,500 simulated games it was accurate at every stage (for example, teams given 75% at halftime won 75%). Every game comes from a seed, and *Copy link* shares that exact game (for example `#NY@BOS/42`).
- **Rest**: back-to-backs are flagged in the game list, and each team's rest (back-to-back, 1 day, 2+ days) is pulled from the schedule and can be changed.
- **Slate**: one click runs every game on the selected date (1,000–5,000 sims each; a 15-game night takes about 20 seconds at 2,000). You get a table of every game (projected score, win %, fair moneyline and spread, and cover / over odds for the market lines you type in) and one props table across all games, with any stat, a game filter, a player search and a *Biggest edge* sort. *Paste lines* takes a list like `Jalen Brunson, pts, 25.5` and fills in your lines in one go. Edge is the model's probability on the better side of your line minus 52.4% (break-even at −110). *Download CSV* exports every player and stat for the night. Click a matchup to open it on the Projections tab with the same simulations.
- **Projections & props**: re-run the game 1,000–20,000 times to get win probability, fair moneylines, a fair spread, cover and over/under odds against the market line you type in, the margin and total distributions, and per-player prop distributions. Covered stats are points, rebounds, assists, 3-pointers made, PRA, P+R, P+A, R+A, steals, blocks, stocks, turnovers, minutes, double-doubles and triple-doubles. Type in a sportsbook line and it shows the model's over/under probability and fair odds. *Download CSV* exports every player and every stat for the game.
- **Alt-line ladders**: the model's over/under % and fair odds at a range of lines, for every player stat (on the player card) and for the game spread, total, each team's total and the first-half total (on the Projections tab). Type a book's price on any rung to get its EV per $100, or add any rung to the parlay slip. Rungs stay on half points, so they can't push.
- **Same-game parlays** (on the Projections tab): build a parlay from player props (any stat, over/under, double-/triple-doubles), moneyline, spread and game total, or click the O / U buttons in any props table (including the Slate's). Every leg is checked in the *same* simulated game, so correlation is measured instead of assumed: you get the chance all legs hit, fair parlay odds, what the price would be if the legs were independent, and the correlation lift between them (for example, a star's points over and the game over usually help each other; two teammates' points overs work against each other). Type the book's parlay odds to get the EV per $100. The page warns you when the edge is inside the simulation noise.
- **Parlay slip** (on the Slate tab): a multi-game parlay. Add moneylines, spreads and totals with the buttons on each game row, props with the O / U buttons, or same-game legs from the Projections tab. Legs in the same game are priced together from the same simulated games (correlation included); separate games are simulated independently, so their chances multiply. Shows each game's chance, the combined chance with a margin of error, fair odds, the independent price, and EV per $100 against the book's parlay odds.
- **Player cards**: click any player's name (props tables, Slate, Injuries tab, box score) for his card: tonight's model projection next to his season, last-5, last-10 and vs-tonight's-opponent averages, how often he went over your line in each, a bar chart of his last 15 games against the line, the model's distribution for tonight, and his full game log (this season plus the end of last season, DNPs included). Switch the stat, change the line (shared with the props tables), or add the over/under to the parlay slip. Game logs live in `site/data/logs.json`, loaded only when a card opens.
- **Head to head**: on the Projections tab, every meeting between the two teams in the last three seasons (score, margin, total, top scorers, and in Advanced mode how each did against the closing spread and total), with the series record and averages in a sentence; each Today card shows the last meeting and the three-season series. On the player card, **Vs. [team]** shows his games against tonight's opponent (or any team you pick) over three seasons, his average against them compared with his usual, and how often he went over your line. Box scores two seasons back are downloaded just for this.
- **Teammate splits (on the player card)**: his averages in games where each current teammate sat vs. played, with minutes and how often he went over your line without him (this season and last, only while they were teammates). Teammates who are out tonight are listed first.
- **Matchups (defense vs. position)**: what every defense allows per game to opposing guards, forwards and centers (points, rebounds, assists, threes, steals, blocks, PRA, minutes), this season or over its last 25 games, ranked 1 (softest) to 30, filtered to the teams playing on the selected date. The player card shows tonight's matchup line for his position.
- **Tracker**: how the model has actually done. Each daily run saves that day's projections (`tracker/proj/<date>.json`, committed back to the repo; the pre-tip-off run replaces the morning one), and the next morning grades them against the real box scores: winners picked, win-probability Brier and calibration, margin and total error, player error and bias by stat, and how often the model's lean was right against a stand-in line (the player's season average before the game, rounded to x.5; not a sportsbook line). The start of the season was backfilled from data available before each day, using who actually sat.
- **Injuries / minutes**: toggle players in or out, or type a player's projected minutes to override the model. Everyone else's minutes and shots re-balance around the change. Edits stick to the player when you switch games, and the Slate tab uses them too; *Reset to model* clears them.

The site is fully static: one JSON model file and plain JavaScript, with no server. It's hosted on GitHub Pages, and a scheduled GitHub Action rebuilds the model from fresh data twice a day.

## How the model works

`scripts/build_data.py` reads player and team box scores, shot locations, the schedule and rosters from [hoopR](https://github.com/sportsdataverse/hoopR-nba-data), plus ESPN's injury report, and writes `site/data/model.json`:

- **Players**: per-minute rates for shots, 3-point attempts, free-throw trips, turnovers, assists, offensive and defensive rebounds, steals, blocks and fouls. Rates are recency-weighted (half-life of 15 games) and get a small pull toward the average for the player's position. Last season counts at a lower weight that fades as this season's games come in: for volume stats (shots, trips, assists, rebounds) its weight halves after 8 current games, since roles change; shooting percentages keep more of last season, since a hot or cold week is mostly noise. Each player has a shot profile from his shot chart: rim vs. mid-range share, make rate at the rim and from mid-range, 3P%, FT%, corner-three share and dunk rate.
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

The league scoring environment switches to the current season's level after about 75 games (this season scores about 2 points per team less than last), so early-season totals don't run high. `scripts/calibrate.js` tunes four global constants so the simulated league matches the real one in points per game, possessions per game, rebounds per game and home-court margin.

### Backtest (2025-26 season, Feb 2 – Mar 22, 290 games, each week using only data available before it)

Inactive players were taken from the real box score (they're known at tip-off), and rest days from the schedule.

| | Model | Closing market |
|---|---|---|
| Margin error (MAE) | 11.08 | 10.37 |
| Total error (MAE) | 14.83 | 14.07 |
| Mean total | 231.4 | 228.4 (actual 229.8) |

The model's margins correlate 0.88 with the closing spreads, it picked 72% of winners, and its win-probability Brier score is 0.189. Player projections correlate 0.70 with actual points (error 4.64 vs. 4.83 for the player's season average), 0.65 with rebounds and 0.69 with assists, where it roughly matches season averages.

**Stars get their full share of shots.** Shots used to be handed out in plain proportion to each player's usage, which spread them too evenly: players averaging 25+ were projected about 1.6 points short on the backtest (about 3 short early in 2026-27). Each player's shot weight is now his usage relative to league average raised to `use_gamma` (1.2), which brings the 25+ group to within about half a point on both seasons and slightly lowers points error (4.62 on the backtest).

**Prop probabilities are calibrated.** Against a stand-in line (each player's season average, rounded to x.5), the model's lean probabilities were on average within 3.7 points (points), 1.9 (rebounds) and 2.6 (assists) of how often they actually hit, down from about 5 before the nightly-form variation was added (`var_use`, `var_eff`, `var_reb`, `var_ast` in the model: some nights a player shoots more, shoots better, or rebounds/passes more, relative to his teammates). **Bottom line: it's sensible and its percentages mean what they say, but it doesn't beat the closing line.** Treat a gap between the model and the market as a reason to dig in, not as a bet. To rerun the backtest:

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
