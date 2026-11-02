"""Rebuild who was on the floor from play-by-play, and estimate each player's defensive impact.

stints(pbp, team_of)  -> one row per (game, stint, team on offense): the five offensive and five defensive
                         players, estimated possessions and points scored.
defensive_ratings(rows) -> regularized adjusted plus-minus (RAPM-style ridge regression) on those stints,
                         split into an offense and a defense number for each player, in points per 100
                         possessions. Positive defense = the opponent scores less with him on the floor.
"""
from collections import defaultdict

import numpy as np
import pandas as pd


def _id(x):
    try:
        return str(int(float(x)))
    except (TypeError, ValueError):
        return None


def stints(pbp, team_of):
    """pbp: hoopR play_by_play rows; team_of: {(game_id, athlete_id): team_id} from the player box scores."""
    out = []
    pbp = pbp.sort_values(["game_id", "game_play_number"])
    bad_periods = good_periods = 0
    for gid, g in pbp.groupby("game_id", sort=False):
        gid_s = str(gid)
        home, away = _id(g["home_team_id"].iloc[0]), _id(g["away_team_id"].iloc[0])
        if not home or not away:
            continue
        for per, p in g.groupby("period_number", sort=True):
            rows = p.to_dict("records")
            # who started the period: anyone whose first appearance isn't "entering the game"
            first = {}
            for r in rows:
                sub = r["type_text"] == "Substitution"
                ids = [_id(r["athlete_id_1"]), _id(r["athlete_id_2"]), _id(r["athlete_id_3"])]
                for k, a in enumerate(ids):
                    if a and a not in first:
                        first[a] = "in" if (sub and k == 0) else "on"
            on = {home: set(), away: set()}
            for a, how in first.items():
                t = team_of.get((gid_s, a))
                if how == "on" and t in on:
                    on[t].add(a)
            if len(on[home]) != 5 or len(on[away]) != 5:
                bad_periods += 1
                continue
            good_periods += 1
            # walk the period, accumulating per-stint team stats
            acc = None
            prev_score = None

            def flush():
                if acc is None:
                    return
                for t, o in ((home, away), (away, home)):
                    s = acc[t]
                    poss = s["fga"] - s["oreb"] + s["tov"] + 0.44 * s["fta"]
                    if poss > 0 or s["pts"] > 0:
                        out.append((gid_s, t, tuple(sorted(acc["on"][t])), tuple(sorted(acc["on"][o])), max(poss, 0.0), s["pts"]))

            def new_acc():
                return {"on": {home: set(on[home]), away: set(on[away])},
                        home: defaultdict(float), away: defaultdict(float)}

            acc = new_acc()
            for r in rows:
                tt = str(r["type_text"])
                tid = _id(r["team_id"])
                if tt == "Substitution":
                    a_in, a_out = _id(r["athlete_id_1"]), _id(r["athlete_id_2"])
                    t = team_of.get((gid_s, a_in)) or tid
                    if t in on and a_out in on[t] and a_in not in on[t]:
                        flush()
                        on[t].discard(a_out)
                        on[t].add(a_in)
                        acc = new_acc()
                    continue
                sc = (r["home_score"], r["away_score"])
                if prev_score is not None and sc != prev_score:
                    acc[home]["pts"] += max(0, sc[0] - prev_score[0])
                    acc[away]["pts"] += max(0, sc[1] - prev_score[1])
                prev_score = sc
                if tid not in (home, away):
                    continue
                if tt.startswith("Free Throw"):
                    acc[tid]["fta"] += 1
                elif bool(r["shooting_play"]):
                    acc[tid]["fga"] += 1
                elif tt == "Offensive Rebound":
                    acc[tid]["oreb"] += 1
                elif "Turnover" in tt:
                    acc[tid]["tov"] += 1
            flush()
    print(f"lineups: {good_periods} periods rebuilt, {bad_periods} skipped (couldn't identify all ten players)")
    return pd.DataFrame(out, columns=["game_id", "off_team", "off", "def", "poss", "pts"])


def defensive_ratings(rows, weights=None, lam=2500.0):
    """Ridge regression of points per 100 possessions on offensive and defensive player indicators."""
    if rows.empty:
        return {}, {}
    w = rows["poss"].values * (weights if weights is not None else 1.0)
    keep = w > 0
    rows, w = rows[keep], w[keep]
    y = rows["pts"].values / rows["poss"].values * 100.0
    mu = float(np.sum(y * w) / np.sum(w))
    players = sorted({a for t in rows["off"] for a in t} | {a for t in rows["def"] for a in t})
    ix = {a: i for i, a in enumerate(players)}
    n = len(players)
    A = np.zeros((2 * n, 2 * n))
    b = np.zeros(2 * n)
    for off, de, wi, yi in zip(rows["off"], rows["def"], w, y - mu):
        cols = [ix[a] for a in off] + [n + ix[a] for a in de]
        c = np.array(cols)
        A[np.ix_(c, c)] += wi
        b[c] += wi * yi
    A[np.diag_indices_from(A)] += lam
    beta = np.linalg.solve(A, b)
    orapm = {a: float(beta[ix[a]]) for a in players}
    drapm = {a: float(-beta[n + ix[a]]) for a in players}  # positive = opponents score less
    return orapm, drapm
