"""Write backtest/actuals_<season>.json: final scores, closing lines and player stat lines for completed games.

Usage: python scripts/export_actuals.py --season 2026 --start 2026-02-02 --end 2026-03-15
"""
import argparse
import json
import os

import pandas as pd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--raw", default="data_raw")
    a = ap.parse_args()
    pb = pd.read_parquet(os.path.join(a.raw, f"player_box_{a.season}.parquet"))
    pb = pb[(pb["season_type"] == 2)]
    pb["game_date"] = pb["game_date"].astype(str)
    pb = pb[(pb["game_date"] >= a.start) & (pb["game_date"] <= a.end)]
    lines = pd.read_parquet(os.path.join(a.raw, "closing_lines_odds_api.parquet"))
    lines = {str(r["game_id"]): (r["home_point"], r["over_under"]) for _, r in lines.iterrows()}
    games = {}
    for gid, d in pb.groupby("game_id"):
        h = d[d["home_away"] == "home"]
        aw = d[d["home_away"] == "away"]
        if h.empty or aw.empty:
            continue
        hp, ou = lines.get(str(gid), (None, None))
        g = {
            "id": str(gid), "date": d["game_date"].iloc[0],
            "home": h["team_abbreviation"].iloc[0], "away": aw["team_abbreviation"].iloc[0],
            "home_score": int(h["team_score"].iloc[0]), "away_score": int(aw["team_score"].iloc[0]),
            "home_spread": None if hp is None or pd.isna(hp) else float(hp),
            "total": None if ou is None or pd.isna(ou) else float(ou),
            "players": {},
        }
        for _, r in d.iterrows():
            if pd.isna(r["athlete_id"]):
                continue
            mins = float(r["minutes"]) if pd.notna(r["minutes"]) else 0.0
            pid = str(int(float(r["athlete_id"])))
            f = lambda c: float(r[c]) if pd.notna(r[c]) else 0.0
            g["players"][pid] = {"min": mins, "pts": f("points"), "reb": f("rebounds"), "ast": f("assists"), "fg3m": f("three_point_field_goals_made")}
        games[str(gid)] = g
    os.makedirs("backtest", exist_ok=True)
    out = f"backtest/actuals_{a.season}.json"
    with open(out, "w") as fh:
        json.dump(sorted(games.values(), key=lambda g: g["date"]), fh)
    print(f"wrote {out}: {len(games)} games")


if __name__ == "__main__":
    main()
