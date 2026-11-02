"""Build the simulator's model file (site/data/model.json) from hoopR (sportsdataverse) NBA data.

Usage:
    python scripts/build_data.py                         # current season, all completed games
    python scripts/build_data.py --refresh               # re-download the data files first
    python scripts/build_data.py --season 2026 --asof 2026-03-01 --out backtest/model_2026-03-01.json
                                                         # only use games before a date (for backtests)

Seasons are named by the year they end in (2027 = the 2026-27 season), as in hoopR.
Data: player and team box scores, shot locations, schedule and rosters from
sportsdataverse/hoopR-nba-data (originally from ESPN). Injury statuses come from ESPN's
public injuries feed when it can be reached.
"""
import argparse
import datetime as dt
import json
import math
import os
import re
import urllib.request
from collections import defaultdict

import numpy as np
import pandas as pd

from lineups import defensive_ratings, stints

HOOPR = "https://raw.githubusercontent.com/sportsdataverse/hoopR-nba-data/main/nba"
FILES = {
    "player_box_{y}.parquet": HOOPR + "/player_box/parquet/player_box_{y}.parquet",
    "team_box_{y}.parquet": HOOPR + "/team_box/parquet/team_box_{y}.parquet",
    "shots_{y}.parquet": HOOPR + "/shots/parquet/shots_{y}.parquet",
    "play_by_play_{y}.parquet": HOOPR + "/pbp/parquet/play_by_play_{y}.parquet",
}
CUR_ONLY = {
    "nba_schedule_{y}.parquet": HOOPR + "/schedules/parquet/nba_schedule_{y}.parquet",
    "rosters_{y}.parquet": HOOPR + "/rosters/parquet/rosters_{y}.parquet",
}
LINES = ("closing_lines_odds_api.parquet", HOOPR + "/betting_lines/closing_lines_odds_api.parquet")
INJURIES_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries"

RATE_HALF_LIFE = 15.0     # games; recency decay for per-minute player rates
MIN_HALF_LIFE = 4.0       # games; recency decay for minutes
PRIOR_GAME_W = 0.30       # weight of a prior-season game in player rates
PRIOR_MIN_GAMES = 1.5     # prior-season minutes count as this many current games
RATE_SHRINK_MIN = 15.0    # minutes of league-average (by position) added to every player's rates
TEAM_HALF_LIFE = 10.0     # games; recency decay for team pace/defense
TEAM_PRIOR_W = 0.25       # weight of a prior-season game in team pace/defense
TEAM_SHRINK = 12.0        # games of league average added to team factors
DEF_LAMBDA = 2500.0       # ridge penalty (possessions) for the defensive plus-minus regression
DEF_PRIOR_W = 0.6         # weight of last season's possessions in the defensive regression

STATS = ["min", "fgm", "fga", "fg3m", "fg3a", "ftm", "fta", "oreb", "dreb", "ast", "stl", "blk", "tov", "pf", "pts"]
BOX_COLS = {
    "minutes": "min", "field_goals_made": "fgm", "field_goals_attempted": "fga",
    "three_point_field_goals_made": "fg3m", "three_point_field_goals_attempted": "fg3a",
    "free_throws_made": "ftm", "free_throws_attempted": "fta", "offensive_rebounds": "oreb",
    "defensive_rebounds": "dreb", "assists": "ast", "steals": "stl", "blocks": "blk",
    "turnovers": "tov", "fouls": "pf", "points": "pts",
}


def download(raw, season, refresh, asof):
    os.makedirs(raw, exist_ok=True)
    jobs = []
    for y in (season, season - 1):
        jobs += [(n.format(y=y), u.format(y=y)) for n, u in FILES.items()]
    jobs += [(n.format(y=season), u.format(y=season)) for n, u in CUR_ONLY.items()]
    jobs.append(LINES)
    for name, url in jobs:
        path = os.path.join(raw, name)
        if (refresh or not os.path.exists(path)):
            print("downloading", url)
            try:
                urllib.request.urlretrieve(url, path)
            except Exception as e:
                print("  could not download:", e)


def read(raw, name):
    path = os.path.join(raw, name)
    return pd.read_parquet(path) if os.path.exists(path) else None


def idstr(col):
    return pd.to_numeric(col, errors="coerce").astype("Int64").astype(str)


def pos_group(p):
    p = str(p or "").upper()
    if "C" in p:
        return "C"
    if p.startswith("F") or p in ("SF", "PF") or "F" in p:
        return "F"
    return "G"


def short_name(full):
    parts = str(full).split()
    if len(parts) < 2:
        return str(full)
    suffix = parts[-1] if parts[-1].rstrip(".") in ("Jr", "Sr", "II", "III", "IV") else ""
    last = parts[-2] if suffix else parts[-1]
    return f"{parts[0][0]}. {last}" + (f" {suffix}" if suffix else "")


def is_three(x, y):
    d = math.hypot(41.75 - abs(x), y)
    return d >= 23.6 or (abs(y) >= 21.9 and abs(x) >= 33.0)


def shot_table(shots):
    """Field-goal attempts with zone (rim / mid / three), corner flag, make and dunk flags."""
    s = shots[~shots["type_text"].astype(str).str.startswith("Free Throw")].copy()
    s = s[s["coordinate_x"].abs() <= 47]
    x, y = s["coordinate_x"].astype(float), s["coordinate_y"].astype(float)
    d = np.hypot(41.75 - x.abs(), y)
    three = (d >= 23.6) | ((y.abs() >= 21.9) & (x.abs() >= 33.0))
    s["zone"] = np.where(three, "three", np.where(d <= 6.0, "rim", "mid"))
    s["corner"] = three & (x.abs() >= 33.0)
    s["made"] = s["scoring_play"].astype(bool)
    s["dunk"] = s["type_text"].astype(str).str.contains("Dunk")
    s["athlete_id"] = idstr(s["athlete_id_1"])
    return s


def rest_effects(tb):
    """Point effect of rest (back-to-back, 1, 2+ days off), from a margin regression with team strengths."""
    t = tb.copy()
    t["gd"] = pd.to_datetime(t["game_date"])
    t = t.sort_values("gd")
    t["rest"] = t.groupby(["yr", "team_id"])["gd"].diff().dt.days - 1
    t["rc"] = pd.cut(t["rest"].fillna(1), [-1, 0, 1, 1000], labels=["b2b", "1", "2+"]).astype(str)
    h = t[t["team_home_away"] == "home"].set_index("game_id")
    aw = t[t["team_home_away"] == "away"].set_index("game_id")
    g = h[["yr", "team_id", "team_score", "rc"]].join(aw[["team_id", "team_score", "rc"]], rsuffix="_a", how="inner")
    if len(g) < 300:
        return {"b2b": -2.4, "1": 0.0, "2+": 0.2}
    keys = sorted(set(zip(g["yr"], g["team_id"])) | set(zip(g["yr"], g["team_id_a"])))
    ix = {k: i for i, k in enumerate(keys)}
    cats = ["b2b", "2+"]  # relative to 1 day of rest (the normal schedule)
    n = len(keys)
    X = np.zeros((len(g), n + 1 + len(cats)))
    r = np.arange(len(g))
    X[r, [ix[k] for k in zip(g["yr"], g["team_id"])]] = 1
    X[r, [ix[k] for k in zip(g["yr"], g["team_id_a"])]] = -1
    X[:, n] = 1
    for c, cat in enumerate(cats):
        X[:, n + 1 + c] = (g["rc"].values == cat).astype(float) - (g["rc_a"].values == cat).astype(float)
    pen = np.eye(X.shape[1]) * 2.0
    pen[n, n] = 0
    beta = np.linalg.solve(X.T @ X + pen, X.T @ (g["team_score"] - g["team_score_a"]).values)
    out = {"1": 0.0}
    for c, cat in enumerate(cats):
        out[cat] = round(float(beta[n + 1 + c]), 2)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=None, help="season by end year (2027 = 2026-27)")
    ap.add_argument("--asof", default=None, help="YYYY-MM-DD: only use games before this date")
    ap.add_argument("--raw", default="data_raw")
    ap.add_argument("--out", default="site/data/model.json")
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()

    today = dt.date.today()
    season = a.season or (today.year + 1 if today.month >= 8 else today.year)
    download(a.raw, season, a.refresh, a.asof)
    asof = a.asof or "9999-12-31"

    # ---------------- player box scores ----------------
    frames = []
    for y in (season - 1, season):
        pb = read(a.raw, f"player_box_{y}.parquet")
        if pb is None:
            continue
        pb = pb[pb["season_type"] == 2].copy()
        pb["yr"] = y
        frames.append(pb)
    pb = pd.concat(frames, ignore_index=True)
    pb["game_date"] = pb["game_date"].astype(str)
    pb = pb[pb["game_date"] < asof]
    pb = pb.rename(columns=BOX_COLS)
    for c in STATS:
        pb[c] = pd.to_numeric(pb[c], errors="coerce")
    pb["athlete_id"] = idstr(pb["athlete_id"])
    pb["team_id"] = idstr(pb["team_id"])
    pb["played"] = pb["min"].fillna(0) > 0
    reason = pb["reason"].fillna("").astype(str).str.upper()
    pb["dnp_cd"] = (~pb["played"]) & pb["did_not_play"].fillna(False).astype(bool) & reason.str.contains("COACH")
    pb["dnp_inj"] = (~pb["played"]) & pb["did_not_play"].fillna(False).astype(bool) & ~reason.str.contains("COACH") & (reason != "")
    pb["pos"] = pb["athlete_position_abbreviation"].map(pos_group)
    for c in STATS:
        pb[c] = pb[c].fillna(0)

    cur = pb[pb["yr"] == season]
    played = pb[pb["played"]]
    if cur.empty:
        raise SystemExit("no current-season games yet")
    through = cur["game_date"].max()

    # league per-minute rates by position (prior for shrinkage)
    pos_rates = {}
    for g, d in played.groupby("pos"):
        m = d["min"].sum()
        pos_rates[g] = {c: d[c].sum() / m for c in STATS if c != "min"}
    lg_played = played[played["yr"] == season] if len(played[played["yr"] == season]) > 2000 else played

    # ---------------- shots: zones ----------------
    sframes = []
    for y in (season - 1, season):
        sh = read(a.raw, f"shots_{y}.parquet")
        if sh is None:
            continue
        sh = sh.copy()
        sh["yr"] = y
        sframes.append(sh)
    shots = pd.concat(sframes, ignore_index=True)
    gdates = pb.drop_duplicates("game_id").set_index("game_id")["game_date"]
    shots = shots[shots["game_id"].map(gdates).fillna("9999") < asof]
    st = shot_table(shots)
    st["w"] = np.where(st["yr"] == season, 1.0, PRIOR_GAME_W)
    zl = st.groupby("zone")["made"].mean()
    league_zone = {
        "rim_share2": float((st["zone"] == "rim").sum() / max(1, (st["zone"] != "three").sum())),
        "rim_pct": float(zl.get("rim", 0.65)), "mid_pct": float(zl.get("mid", 0.43)),
        "three_pct": float(zl.get("three", 0.36)),
        "corner_share3": float(st[st["zone"] == "three"]["corner"].mean()),
        "dunk_rate": float(st[st["zone"] == "rim"]["dunk"].mean()),
    }
    zagg = {}
    for pid, d in st.groupby("athlete_id"):
        w = d["w"]
        two = d["zone"] != "three"
        rim = d["zone"] == "rim"
        zagg[pid] = {
            "w2": float(w[two].sum()), "wrim": float(w[rim].sum()),
            "wrim_m": float(w[rim & d["made"]].sum()), "wmid": float(w[d["zone"] == "mid"].sum()),
            "wmid_m": float(w[(d["zone"] == "mid") & d["made"]].sum()),
            "w3": float(w[~two].sum()), "wcorner": float(w[(~two) & d["corner"]].sum()),
            "wdunk": float(w[rim & d["dunk"]].sum()),
        }

    # ---------------- rosters & team mapping ----------------
    tb_frames = []
    for y in (season - 1, season):
        tb = read(a.raw, f"team_box_{y}.parquet")
        if tb is None:
            continue
        tb = tb[tb["season_type"] == 2].copy()
        tb["yr"] = y
        tb_frames.append(tb)
    tb = pd.concat(tb_frames, ignore_index=True)
    tb["game_date"] = tb["game_date"].astype(str)
    tb = tb[tb["game_date"] < asof]
    tb["team_id"] = idstr(tb["team_id"])
    tb["opponent_team_id"] = idstr(tb["opponent_team_id"])
    teams_meta = {}
    gp_by_team = tb[tb["yr"] == season].groupby("team_abbreviation")["game_id"].nunique().sort_values(ascending=False)
    real = set(gp_by_team.index[:30])  # drops All-Star / exhibition teams
    for _, r in tb[(tb["yr"] == season) & tb["team_abbreviation"].isin(real)].drop_duplicates("team_abbreviation").iterrows():
        teams_meta[r["team_abbreviation"]] = {
            "name": r["team_display_name"], "short": r["team_short_display_name"],
            "color": "#" + str(r["team_color"] or "888888"), "alt": "#" + str(r["team_alternate_color"] or "888888"), "id": r["team_id"],
        }
    id2abbr = {v["id"]: k for k, v in teams_meta.items()}

    roster = None if a.asof else read(a.raw, f"rosters_{season}.parquet")
    team_of, roster_names, roster_pos = {}, {}, {}
    last = pb.sort_values("game_date").groupby("athlete_id").tail(1)
    if roster is not None and len(roster):
        for _, r in roster.iterrows():
            pid = str(int(float(r["athlete_id"])))
            team_of[pid] = r["team_abbreviation"]
            roster_names[pid] = r["display_name"]
            roster_pos[pid] = pos_group(r.get("position_abbreviation"))
    else:  # as-of builds: a player's team is the team of his latest game in the current season
        lc = cur.sort_values("game_date").groupby("athlete_id").tail(1)
        for _, r in lc.iterrows():
            team_of[r["athlete_id"]] = id2abbr.get(str(r["team_id"]), r["team_abbreviation"])

    # ---------------- per-player rates ----------------
    pb = pb.sort_values("game_date")
    players_by_team = defaultdict(list)
    names = last.set_index("athlete_id")["athlete_display_name"].to_dict()
    pos_of = last.set_index("athlete_id")["pos"].to_dict()

    team_last_game = {}
    team_games = {}
    for tid, d in cur.groupby("team_id"):
        ab = id2abbr.get(tid)
        if ab:
            team_last_game[ab] = d["game_date"].max()
            team_games[ab] = list(d.drop_duplicates("game_id").sort_values("game_date")["game_id"])
    for pid, team in team_of.items():
        if team not in teams_meta:
            continue
        d = pb[pb["athlete_id"] == pid]
        dc = d[d["yr"] == season]
        dp = d[d["yr"] == season - 1]
        name = roster_names.get(pid) or names.get(pid) or pid
        pos = roster_pos.get(pid) or pos_of.get(pid) or "F"

        # minutes: current-season games (DNP-coach's decision count as 0), injury DNPs excluded
        mc = dc[dc["played"] | dc["dnp_cd"]]
        k = np.arange(len(mc))[::-1]
        wm = 0.5 ** (k / MIN_HALF_LIFE)
        pm = dp[dp["played"]].tail(25)["min"]
        if len(mc):
            num, den = float((mc["min"].values * wm).sum()), float(wm.sum())
            if len(pm):
                num += pm.mean() * PRIOR_MIN_GAMES
                den += PRIOR_MIN_GAMES
            mins = num / den
        elif len(pm):
            mins = float(pm.mean()) * 0.9
        else:
            mins = 4.0 if roster is not None else 0.0
        starter = float((mc["starter"].astype(bool).values * wm).sum() / wm.sum()) if len(mc) else 0.0

        # per-minute rates with recency weights; prior season games down-weighted
        dpl = d[d["played"]]
        kc = np.arange((dpl["yr"] == season).sum())[::-1]
        kp = np.arange((dpl["yr"] == season - 1).sum())[::-1]
        w = np.concatenate([PRIOR_GAME_W * 0.5 ** (kp / 40.0), 0.5 ** (kc / RATE_HALF_LIFE)])
        dpl = pd.concat([dpl[dpl["yr"] == season - 1], dpl[dpl["yr"] == season]])
        wmin = float((dpl["min"].values * w).sum())
        pr = pos_rates.get(pos, pos_rates["F"])
        rate = {}
        for c in STATS:
            if c in ("min", "pts"):
                continue
            tot = float((dpl[c].values * w).sum())
            rate[c] = (tot + pr[c] * RATE_SHRINK_MIN) / (wmin + RATE_SHRINK_MIN)
        # shooting percentages (shrunk toward league/position)
        def wsum(c):
            return float((dpl[c].values * w).sum())
        fg3a, fg3m, fta, ftm = wsum("fg3a"), wsum("fg3m"), wsum("fta"), wsum("ftm")
        fg2a, fg2m = wsum("fga") - fg3a, wsum("fgm") - fg3m
        lg3 = league_zone["three_pct"]
        p3 = (fg3m + lg3 * 60) / (fg3a + 60)
        ft = (ftm + 0.78 * 40) / (fta + 40)
        z = zagg.get(pid)
        lr = league_zone
        if z and z["w2"] > 0:
            rim_share = (z["wrim"] + lr["rim_share2"] * 30) / (z["w2"] + 30)
            rim_pct = (z["wrim_m"] + lr["rim_pct"] * 25) / (z["wrim"] + 25)
            mid_pct = (z["wmid_m"] + lr["mid_pct"] * 30) / (z["wmid"] + 30)
            corner = (z["wcorner"] + lr["corner_share3"] * 20) / (z["w3"] + 20)
            dunk = (z["wdunk"] + lr["dunk_rate"] * 10) / (z["wrim"] + 10)
        else:
            rim_share, rim_pct, mid_pct, corner, dunk = lr["rim_share2"], lr["rim_pct"], lr["mid_pct"], lr["corner_share3"], lr["dunk_rate"]
        # make the zone split consistent with the player's overall 2P% (box scores are complete; shot logs can miss a few)
        p2 = (fg2m + 0.53 * 50) / (fg2a + 50)
        zone_p2 = rim_share * rim_pct + (1 - rim_share) * mid_pct
        if zone_p2 > 0:
            adj = p2 / zone_p2
            rim_pct, mid_pct = min(0.9, rim_pct * adj), min(0.75, mid_pct * adj)

        # status: injury DNP in the team's latest game
        status, absent = "", False
        tg = team_games.get(team, [])
        in_box = set(dc.loc[dc["team_id"] == teams_meta[team]["id"], "game_id"])
        missed3 = len(tg) >= 1 and all(g not in in_box for g in tg[-3:])
        lastg = dc[(dc["game_date"] == team_last_game.get(team, "")) & (dc["team_id"] == teams_meta[team]["id"])]
        if len(lastg) and bool(lastg["dnp_inj"].iloc[-1]):
            status = "DNP last game: " + str(lastg["reason"].iloc[-1]).title()
        elif not len(lastg):
            absent = True
            status = "Not with team last game"
        gp = int(dc["played"].sum())
        players_by_team[team].append({
            "id": pid, "name": name, "short": short_name(name), "pos": pos,
            "min": round(float(mins), 2), "start": round(starter, 3), "gp": gp,
            "r": {k2: round(v, 5) for k2, v in rate.items()},
            "p3": round(p3, 4), "ft": round(ft, 4), "rim": round(rim_share, 4),
            "prim": round(rim_pct, 4), "pmid": round(mid_pct, 4), "corner": round(corner, 3), "dunk": round(dunk, 3),
            "status": status, "absent": absent, "missed3": bool(missed3),
        })

    # ---------------- lineups & defensive impact ----------------
    team_of_game = dict(zip(zip(pb["game_id"].astype(str), pb["athlete_id"]), pb["team_id"]))
    sframes = []
    for y in (season - 1, season):
        pbp = read(a.raw, f"play_by_play_{y}.parquet")
        if pbp is None:
            continue
        pbp = pbp[(pbp["season_type"] == 2) & (pbp["game_date"].astype(str) < asof)]
        st_ = stints(pbp, team_of_game)
        st_["w"] = 1.0 if y == season else DEF_PRIOR_W
        sframes.append(st_)
    drapm = {}
    if sframes:
        S = pd.concat(sframes, ignore_index=True)
        _, drapm = defensive_ratings(S, S["w"].values, DEF_LAMBDA)
    d_base = {}
    for t, ps in players_by_team.items():
        for p in ps:
            p["d"] = round(drapm.get(p["id"], 0.0), 2)
        # the team's usual defense: weighted by minutes actually played this season (falls back to projections)
        tid = teams_meta[t]["id"]
        mins = cur[(cur["team_id"] == tid) & cur["played"]].groupby("athlete_id")["min"].sum().to_dict()
        w = {p["id"]: mins.get(p["id"], 0.0) for p in ps}
        if sum(w.values()) < 240:
            w = {p["id"]: max(p["min"], 0.0) for p in ps}
        tot = sum(w.values()) or 1.0
        d_base[t] = round(sum(p["d"] * w[p["id"]] for p in ps) / tot, 3)

    # season averages for the roster tab
    for t, ps in players_by_team.items():
        for p in ps:
            dc = cur[(cur["athlete_id"] == p["id"]) & cur["played"]]
            p["avg"] = {
                "min": round(float(dc["min"].mean()), 1) if len(dc) else None,
                "pts": round(float(dc["pts"].mean()), 1) if len(dc) else None,
                "reb": round(float((dc["oreb"] + dc["dreb"]).mean()), 1) if len(dc) else None,
                "ast": round(float(dc["ast"].mean()), 1) if len(dc) else None,
            }
        ps.sort(key=lambda p: -p["min"])

    # ---------------- team pace & defense ----------------
    tb = tb.copy()
    num = ["field_goals_made", "field_goals_attempted", "three_point_field_goals_made", "three_point_field_goals_attempted",
           "free_throws_made", "free_throws_attempted", "offensive_rebounds", "defensive_rebounds", "total_turnovers", "team_score",
           "assists", "steals", "blocks", "fouls"]
    for c in num:
        tb[c] = pd.to_numeric(tb[c], errors="coerce").fillna(0)
    tb["poss"] = tb["field_goals_attempted"] - tb["offensive_rebounds"] + tb["total_turnovers"] + 0.44 * tb["free_throws_attempted"]
    gmin = pb.groupby(["game_id", "team_id"])["min"].sum().reset_index()
    tb = tb.merge(gmin, on=["game_id", "team_id"], how="left")
    tb["gmins"] = (tb["min"].fillna(240) / 5).clip(48, 78).round()
    opp = tb[["game_id", "team_id", "poss", "field_goals_made", "field_goals_attempted", "three_point_field_goals_made",
              "three_point_field_goals_attempted", "free_throws_attempted", "offensive_rebounds", "defensive_rebounds",
              "total_turnovers", "team_score"]].copy()
    opp.columns = ["game_id", "opp_id"] + ["o_" + c for c in opp.columns[2:]]
    tb["opp_id"] = tb["opponent_team_id"].astype(str)
    tb = tb.merge(opp, on=["game_id", "opp_id"], how="inner")
    tb["pace"] = (tb["poss"] + tb["o_poss"]) / 2 * 48 / tb["gmins"]
    tb["o_efg"] = (tb["o_field_goals_made"] + 0.5 * tb["o_three_point_field_goals_made"]) / tb["o_field_goals_attempted"]
    tb["o_tov"] = tb["o_total_turnovers"] / tb["o_poss"]
    tb["o_orb"] = tb["o_offensive_rebounds"] / (tb["o_offensive_rebounds"] + tb["defensive_rebounds"])
    tb["o_ftr"] = tb["o_free_throws_attempted"] / tb["o_field_goals_attempted"]
    tb["o_3par"] = tb["o_three_point_field_goals_attempted"] / tb["o_field_goals_attempted"]
    tb["ortg"] = tb["team_score"] / tb["poss"] * 100
    tbc = tb[tb["yr"] == season]
    lg = {c: float(tbc[c].mean()) for c in ["pace", "o_efg", "o_tov", "o_orb", "o_ftr", "o_3par", "ortg"]}
    lg_pts = float(tbc["team_score"].mean())
    lg_poss = float((tbc["poss"] * 48 / tbc["gmins"]).mean())
    if len(tbc) < 300:  # early season: blend in last season's league environment
        tbp = tb[tb["yr"] == season - 1]
        wc = len(tbc) / 300
        for c in lg:
            lg[c] = wc * lg[c] + (1 - wc) * float(tbp[c].mean())
        lg_pts = wc * lg_pts + (1 - wc) * float(tbp["team_score"].mean())
        lg_poss = wc * lg_poss + (1 - wc) * float((tbp["poss"] * 48 / tbp["gmins"]).mean())

    teams = {}
    tb = tb.sort_values("game_date")
    for abbr, meta in teams_meta.items():
        d = tb[tb["team_id"] == meta["id"]]
        dcur, dpri = d[d["yr"] == season], d[d["yr"] == season - 1].tail(30)
        w = np.concatenate([TEAM_PRIOR_W * np.ones(len(dpri)), 0.5 ** (np.arange(len(dcur))[::-1] / TEAM_HALF_LIFE)])
        dd = pd.concat([dpri, dcur])
        f = {}
        for c in ["pace", "o_efg", "o_tov", "o_orb", "o_ftr", "o_3par"]:
            v = float((dd[c].values * w).sum())
            f[c] = (v + lg[c] * TEAM_SHRINK) / (w.sum() + TEAM_SHRINK)
        rec = dcur["team_winner"].astype(bool)
        teams[abbr] = {
            **meta, "abbr": abbr,
            "record": f"{int(rec.sum())}-{int((~rec).sum())}",
            "pace": round(f["pace"], 2),
            "d_efg": round(f["o_efg"] - lg["o_efg"], 4),     # eFG% allowed vs league
            "d_tov": round(f["o_tov"] / lg["o_tov"], 4),      # turnover rate forced vs league
            "d_orb": round(f["o_orb"] / lg["o_orb"], 4),      # offensive rebound rate allowed vs league
            "d_ftr": round(f["o_ftr"] / lg["o_ftr"], 4),      # free-throw rate allowed vs league
            "d_3par": round(f["o_3par"] / lg["o_3par"], 4),   # 3-point attempt rate allowed vs league
            "players": players_by_team.get(abbr, []),
            "d_base": d_base.get(abbr, 0.0),
        }

    hm = tb[tb["team_home_away"] == "home"]
    home_margin = (hm["team_score"] - hm["o_team_score"]).mean()
    rest = rest_effects(tb)
    print("rest effects (pts vs. 1 day of rest):", rest)

    # ---------------- league constants ----------------
    lpc = lg_played
    m = lpc["min"].sum()
    fgm, fga = lpc["fgm"].sum(), lpc["fga"].sum()
    fg3m = lpc["fg3m"].sum()
    fta, ftm = lpc["fta"].sum(), lpc["ftm"].sum()
    misses = (fga - fgm) + 0.45 * (fta - ftm)
    league = {
        "pace": round(lg["pace"], 2), "pts_per_team": round(lg_pts, 2), "poss_per_team": round(lg_poss, 2),
        "ortg": round(lg["ortg"], 2), "efg": round(lg["o_efg"], 4), "tov_rate": round(lg["o_tov"], 4),
        "orb_rate": round(lg["o_orb"], 4), "ft_pct": round(float(ftm / fta), 4), "fg3_pct": round(float(fg3m / lpc["fg3a"].sum()), 4),
        "ast_per_fgm": round(float(lpc["ast"].sum() / fgm), 4),
        "stl_per_tov": round(float(lpc["stl"].sum() / lpc["tov"].sum()), 4),
        "blk_per_miss2": round(float(lpc["blk"].sum() / ((fga - lpc["fg3a"].sum()) - (fgm - fg3m))), 4),
        "reb_credit": round(float((lpc["oreb"].sum() + lpc["dreb"].sum()) / misses), 4),
        "reb_per_team": round(float((lpc["oreb"].sum() + lpc["dreb"].sum()) / lpc.groupby(["game_id", "team_id"]).ngroups), 2),
        "pf_per_min": round(float(lpc["pf"].sum() / m), 5),
        "zone": {k: round(v, 4) for k, v in league_zone.items()},
        "extra_foul": 0.065,
        "load_k": 0.35,       # efficiency bonus/penalty per log-unit of lineup shot creation vs league  # non-shooting fouls per possession (foul-outs only)
        "home_edge": 0.035,
        "home_margin": round(float(home_margin), 2),
        "rest": rest,
        "def_scale": 0.022,   # logit of opponent shot-making per point/100 of on-court defensive rating
        "matchup_w": 1.5,     # extra weight of the primary defender's rating on his man's shots   # logit bump on home shooting (~2.5 pts); calibrate.js can retune
        "eff_scale": 0.0, "pace_scale": 1.0,
    }

    # ---------------- schedule ----------------
    sched = read(a.raw, f"nba_schedule_{season}.parquet")
    lines = read(a.raw, "closing_lines_odds_api.parquet")
    line_by_game = {}
    if lines is not None:
        for _, r in lines.iterrows():
            line_by_game[str(r["game_id"])] = (r.get("home_point"), r.get("over_under"))
    schedule = []
    if sched is not None:
        s = sched[sched["season_type"].isin([2, 3])].copy()
        for _, r in s.sort_values("date").iterrows():
            h, aw = r["home_abbreviation"], r["away_abbreviation"]
            if h not in teams or aw not in teams:
                continue
            gd = str(r["game_date"])
            done = bool(r["status_type_completed"]) and gd < asof
            hp, ou = line_by_game.get(str(r["game_id"]), (None, None))
            schedule.append({
                "id": str(r["game_id"]), "date": gd, "start": str(r["date"]),
                "away": aw, "home": h, "neutral": bool(r["neutral_site"]),
                "away_score": int(r["away_score"]) if done else None, "home_score": int(r["home_score"]) if done else None,
                "home_spread": float(hp) if hp is not None and pd.notna(hp) else None,
                "total": float(ou) if ou is not None and pd.notna(ou) else None,
            })

    # ---------------- injuries (ESPN) ----------------
    inj_n = 0
    if not a.asof:
        try:
            req = urllib.request.Request(INJURIES_URL, headers={"User-Agent": "Mozilla/5.0"})
            j = json.load(urllib.request.urlopen(req, timeout=30))
            byid = {p["id"]: p for t in teams.values() for p in t["players"]}
            byname = {p["name"].lower(): p for t in teams.values() for p in t["players"]}
            for team in j.get("injuries", []):
                for inj in team.get("injuries", []):
                    ath = inj.get("athlete", {}) or {}
                    pid = str(ath.get("id") or "")
                    if not pid:
                        for l in ath.get("links", []) or []:
                            mm = re.search(r"/id/(\d+)", l.get("href", ""))
                            if mm:
                                pid = mm.group(1)
                                break
                    p = byid.get(pid) or byname.get(str(ath.get("displayName", "")).lower())
                    if not p:
                        continue
                    st_ = str(inj.get("status") or (inj.get("type") or {}).get("description") or "").strip()
                    detail = str(inj.get("shortComment") or "")[:140]
                    p["status"] = st_
                    p["inj_note"] = detail
                    p["out"] = st_.lower() in ("out", "injured reserve", "suspension")
                    inj_n += 1
            print(f"injury report: {inj_n} players")
        except Exception as e:
            print("injury report unavailable:", e)
    for t in teams.values():
        for p in t["players"]:
            # with the injury report: report's Out list, plus anyone not with the team for its last 3 games
            # without it: anyone who missed the team's last game (injury DNP or not in the box score)
            if inj_n:
                p["out"] = bool(p.get("out")) or p["missed3"]
                if p["missed3"] and not p.get("inj_note"):
                    p["status"] = "Not with team last 3 games"
                elif p["absent"] and not p.get("inj_note"):
                    p["status"] = ""
            else:
                p["out"] = p["absent"] or p["status"].startswith("DNP last game")
            p.pop("absent"); p.pop("missed3")

    model = {
        "season": season, "season_label": f"{season - 1}-{str(season)[2:]}",
        "through": through, "asof": a.asof, "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "injury_source": "espn" if inj_n else "last-game DNPs",
        "league": league, "teams": teams, "schedule": schedule,
    }
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(model, fh, separators=(",", ":"))
    n_players = sum(len(t["players"]) for t in teams.values())
    print(f"wrote {a.out}: {len(teams)} teams, {n_players} players, {len(schedule)} games, data through {through}")


if __name__ == "__main__":
    main()
