#!/usr/bin/env python3
"""Sportsbook player-prop lines from The Odds API (the-odds-api.com).

Needs the repository secret ODDS_API_KEY. Without it this script does nothing (the site still gets
game lines - moneyline, spread, total - straight from ESPN's scoreboard in the browser).

Credits: The Odds API's free plan has 500 credits a month. Each game costs (number of markets) x
(number of regions) credits, so one market for one region on a 10-game night costs 10. To stay inside
the free plan this fetches once a day (the first run after 20:00 UTC, ~3-4pm ET when props are posted),
saves the result to tracker/odds/<date>.json (committed, so later runs that day reuse it) and copies it to
site/data/odds.json. Set ODDS_MARKETS to fetch more markets (costs more credits), e.g.
  player_points,player_rebounds,player_assists,player_threes
Set ODDS_FORCE=1 to fetch again even if today's file exists.
"""
import datetime as dt
import json
import os
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

API = "https://api.the-odds-api.com/v4/sports/basketball_nba"
MARKETS = {
    "player_points": "pts", "player_rebounds": "reb", "player_assists": "ast", "player_threes": "fg3m",
    "player_points_rebounds_assists": "pra", "player_points_rebounds": "pr", "player_points_assists": "pa",
    "player_rebounds_assists": "ra", "player_blocks": "blk", "player_steals": "stl", "player_turnovers": "tov",
}
BOOKS = "draftkings,fanduel,betmgm,williamhill_us,espnbet,betrivers,fanatics"  # up to 10 books cost the same as one region


def norm(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[.'`]", "", s)
    s = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", s)
    return re.sub(r"[^a-z]+", " ", s).strip()


def get(url, params):
    q = urllib.parse.urlencode(params)
    with urllib.request.urlopen(f"{url}?{q}", timeout=30) as r:
        left = r.headers.get("x-requests-remaining")
        return json.load(r), (float(left) if left not in (None, "") else None)


def main():
    model_path = sys.argv[1] if len(sys.argv) > 1 else "site/data/model.json"
    out_dir, site_out = "tracker/odds", "site/data/odds.json"
    today = dt.datetime.now(ZoneInfo("America/New_York")).date().isoformat()
    path = os.path.join(out_dir, f"{today}.json")
    key = os.environ.get("ODDS_API_KEY", "").strip()
    force = os.environ.get("ODDS_FORCE") == "1"
    allowed = os.environ.get("ODDS_FETCH", "1") == "1"
    late = dt.datetime.now(dt.timezone.utc).hour >= 20

    def publish():
        if os.path.exists(path):
            with open(path) as f, open(site_out, "w") as g:
                g.write(f.read())
            print("odds: published", path)
        else:
            with open(site_out, "w") as g:
                json.dump({"date": today, "props": {}, "note": "no sportsbook prop lines yet today"}, g)

    if not key:
        print("odds: no ODDS_API_KEY secret set, skipping sportsbook prop lines")
        return publish()
    if os.path.exists(path) and not force:
        print("odds: already fetched today")
        return publish()
    if not force and not (allowed and late):
        print("odds: waiting for the afternoon run to fetch (saves credits)")
        return publish()

    with open(model_path) as f:
        model = json.load(f)
    team_by_name = {t["name"]: abbr for abbr, t in model["teams"].items()}
    by_name = {}
    for abbr, t in model["teams"].items():
        for p in t["players"]:
            by_name.setdefault(norm(p["name"]), []).append((p["id"], abbr))

    markets = [m.strip() for m in os.environ.get("ODDS_MARKETS", "player_points").split(",") if m.strip() in MARKETS]
    events, left = get(f"{API}/events", {"apiKey": key})  # the event list is free
    tz = ZoneInfo("America/New_York")
    todays = [e for e in events if dt.datetime.fromisoformat(e["commence_time"].replace("Z", "+00:00")).astimezone(tz).date().isoformat() == today]
    out = {"date": today, "fetched": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "markets": [MARKETS[m] for m in markets],
           "games": [], "props": {}, "unmatched": []}
    for e in todays:
        need = len(markets)
        if left is not None and left < need + 5:
            print(f"::warning title=odds::stopping, only {left:.0f} Odds API credits left this month")
            break
        home, away = team_by_name.get(e["home_team"]), team_by_name.get(e["away_team"])
        out["games"].append({"away": away, "home": home, "start": e["commence_time"]})
        try:
            data, left = get(f"{API}/events/{e['id']}/odds", {"apiKey": key, "regions": "us", "markets": ",".join(markets),
                                                              "oddsFormat": "american", "bookmakers": BOOKS})
        except Exception as ex:
            print("odds: could not fetch", e["away_team"], "@", e["home_team"], ex)
            continue
        for bk in data.get("bookmakers", []):
            for mk in bk.get("markets", []):
                stat = MARKETS.get(mk["key"])
                rows = {}
                for o in mk.get("outcomes", []):
                    nm, pt = o.get("description"), o.get("point")
                    if nm is None or pt is None:
                        continue
                    r = rows.setdefault((nm, pt), {"book": bk["key"], "line": pt})
                    r["o" if o["name"].lower() == "over" else "u"] = o["price"]
                for (nm, _), r in rows.items():
                    cands = [c for c in by_name.get(norm(nm), []) if c[1] in (home, away)] or by_name.get(norm(nm), [])
                    if len(cands) != 1:
                        if nm not in out["unmatched"]:
                            out["unmatched"].append(nm)
                        continue
                    out["props"].setdefault(cands[0][0], {}).setdefault(stat, []).append(r)
    out["credits_left"] = left
    os.makedirs(out_dir, exist_ok=True)
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    n = sum(len(v) for p in out["props"].values() for v in p.values())
    print(f"::notice title=odds::{len(out['props'])} players, {n} book lines; {left} credits left this month")
    publish()


if __name__ == "__main__":
    main()
