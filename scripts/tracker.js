// Model tracker: save each day's projections, then grade them against the real box scores.
//
//   node scripts/tracker.js project [--date YYYY-MM-DD] [--model site/data/model.json] [--logs site/data/logs.json]
//                                   [--actual-outs]      # backfill: treat players who didn't play as out
//   node scripts/tracker.js report  # grade every saved day that has final scores; writes site/data/tracker.json
//
// Saved projections live in tracker/proj/<date>.json (committed by the daily GitHub Action). The "line" used to
// grade player leans is a stand-in for a sportsbook line: the player's season average before that game, rounded
// to x.5. It shows whether the model's lean away from a player's average is worth anything; it is not a book line.
const fs = require("fs");
const path = require("path");
const Sim = require("../site/js/sim.js");

const ROOT = path.join(__dirname, "..");
const PROJ_DIR = process.env.TRACKER_DIR || path.join(ROOT, "tracker", "proj");
const STATS = ["pts", "reb", "ast", "fg3m", "pra"];
const LOG_IX = { min: 4, pts: 5, reb: 6, ast: 7, fg3m: 8 };
const val = (r, k) => (k === "pra" ? r[5] + r[6] + r[7] : r[LOG_IX[k]]);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const todayET = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

function restCat(model, team, date) {
  let prev = null;
  for (const g of model.schedule) if ((g.home === team || g.away === team) && g.date < date && (!prev || g.date > prev)) prev = g.date;
  if (!prev) return "1";
  const days = Math.round((Date.parse(date) - Date.parse(prev)) / 864e5) - 1;
  return days <= 0 ? "b2b" : days === 1 ? "1" : "2+";
}

function project() {
  const date = arg("--date", todayET());
  const model = JSON.parse(fs.readFileSync(arg("--model", path.join(ROOT, "site/data/model.json"))));
  const logs = JSON.parse(fs.readFileSync(arg("--logs", path.join(ROOT, "site/data/logs.json"))));
  const actualOuts = process.argv.includes("--actual-outs");
  const actualLogs = actualOuts ? JSON.parse(fs.readFileSync(arg("--actual-logs", path.join(ROOT, "site/data/logs.json")))) : null;
  const N = +arg("--n", 2000);
  const games = model.schedule.filter((g) => g.date === date && model.teams[g.away] && model.teams[g.home]);
  if (!games.length) { console.log(`tracker: no games on ${date}`); return; }
  const out = { date, generated: new Date().toISOString(), backfill: actualOuts, n: N, data_through: model.through, games: [] };
  for (const g of games) {
    let outs;
    if (actualOuts) { // who actually sat is known at tip-off; use it for backfilled days
      outs = [];
      for (const t of [g.away, g.home]) for (const p of model.teams[t].players) {
        const rows = (actualLogs.players[p.id] || []).filter((r) => r[0] === date && r[4] > 0);
        if (!rows.length) outs.push(p.id);
      }
    } else outs = Sim.defaultOut(model, [g.away, g.home]);
    const rest = { away: restCat(model, g.away, date), home: restCat(model, g.home, date) };
    const agg = Sim.simulateMany(model, { away: g.away, home: g.home, out: outs, rest, seed: 4242 }, N);
    const margin = Array.from(agg.home, (h, i) => h - agg.away[i]), total = Array.from(agg.home, (h, i) => h + agg.away[i]);
    const players = [];
    for (const id in agg.players) {
      const P = agg.players[id], s = P.stats, m = mean(Array.from(s.min));
      if (m < 8) continue;
      // season average before this game -> stand-in line
      const prior = ((logs.players && logs.players[id]) || []).filter((r) => r[3] === model.season && !r[19] && r[0] < date);
      const row = { id, name: P.name, team: P.team, min: +m.toFixed(1) };
      for (const k of STATS) {
        const arr = k === "pra" ? Array.from(s.pts, (x, i) => x + s.reb[i] + s.ast[i]) : Array.from(s[k]);
        row[k] = +mean(arr).toFixed(2);
        if (prior.length >= 3) {
          const line = Math.floor(mean(prior.map((r) => val(r, k)))) + 0.5;
          row[k + "_line"] = line;
          row[k + "_pover"] = +(arr.filter((x) => x > line).length / N).toFixed(4);
        }
      }
      players.push(row);
    }
    out.games.push({
      id: g.id, away: g.away, home: g.home, rest, outs: outs.length,
      p_home: +(agg.wins.home / N).toFixed(4), margin: +mean(margin).toFixed(2), total: +mean(total).toFixed(2), players,
    });
  }
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  const file = path.join(PROJ_DIR, `${date}.json`);
  fs.writeFileSync(file, JSON.stringify(out));
  console.log(`tracker: saved ${games.length} games for ${date} -> ${path.relative(ROOT, file)}`);
}

function report() {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, "site/data/model.json")));
  const logs = JSON.parse(fs.readFileSync(path.join(ROOT, "site/data/logs.json")));
  const files = fs.existsSync(PROJ_DIR) ? fs.readdirSync(PROJ_DIR).filter((f) => f.endsWith(".json")).sort() : [];
  const sched = {}; for (const g of model.schedule) sched[g.id] = g;
  const days = [], games = [], pl = Object.fromEntries(STATS.map((k) => [k, []]));
  let pending = null;
  for (const f of files) {
    const P = JSON.parse(fs.readFileSync(path.join(PROJ_DIR, f)));
    const done = P.games.filter((g) => sched[g.id] && sched[g.id].home_score != null);
    if (!done.length) { pending = { date: P.date, games: P.games.length, generated: P.generated }; continue; }
    const day = { date: P.date, backfill: !!P.backfill, games: done.length, right: 0, brier: 0, mErr: 0, tErr: 0, ptsErr: [], n: 0 };
    for (const g of done) {
      const s = sched[g.id], m = s.home_score - s.away_score, t = s.home_score + s.away_score;
      const right = (g.p_home > 0.5) === (m > 0);
      games.push({ date: P.date, backfill: !!P.backfill, p: g.p_home, won: m > 0 ? 1 : 0, mErr: g.margin - m, tErr: g.total - t, right });
      day.right += right; day.brier += (g.p_home - (m > 0 ? 1 : 0)) ** 2; day.mErr += Math.abs(g.margin - m); day.tErr += Math.abs(g.total - t);
      for (const p of g.players) {
        const rows = ((logs.players[p.id]) || []).filter((r) => r[0] === P.date && r[4] > 0);
        if (!rows.length) continue; // didn't play
        const r = rows[0];
        for (const k of STATS) {
          const a = val(r, k), rec = { proj: p[k], act: a, backfill: !!P.backfill };
          if (p[k + "_line"] != null) { rec.line = p[k + "_line"]; rec.pover = p[k + "_pover"]; rec.over = a > rec.line ? 1 : 0; }
          pl[k].push(rec);
          if (k === "pts") day.ptsErr.push(Math.abs(p[k] - a));
        }
        day.n++;
      }
    }
    days.push({ date: day.date, backfill: day.backfill, games: day.games, right: day.right, brier: +(day.brier / day.games).toFixed(4),
      margin_mae: +(day.mErr / day.games).toFixed(2), total_mae: +(day.tErr / day.games).toFixed(2),
      pts_mae: day.ptsErr.length ? +mean(day.ptsErr).toFixed(2) : null, players: day.n });
  }
  const mae = (a) => (a.length ? +mean(a.map(Math.abs)).toFixed(3) : null);
  const summary = {
    days: days.length, games: games.length,
    winner_pct: games.length ? +(games.filter((g) => g.right).length / games.length).toFixed(4) : null,
    brier: games.length ? +mean(games.map((g) => (g.p - g.won) ** 2)).toFixed(4) : null,
    margin_mae: mae(games.map((g) => g.mErr)), total_mae: mae(games.map((g) => g.tErr)),
    total_bias: games.length ? +mean(games.map((g) => g.tErr)).toFixed(2) : null,
  };
  // win-probability calibration
  const cal = [];
  for (const [lo, hi] of [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]]) {
    const g = games.map((x) => (x.p >= 0.5 ? { p: x.p, w: x.won } : { p: 1 - x.p, w: 1 - x.won })).filter((x) => x.p >= lo && x.p < hi);
    if (g.length) cal.push({ bucket: `${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}%`, n: g.length, said: +mean(g.map((x) => x.p)).toFixed(4), won: +mean(g.map((x) => x.w)).toFixed(4) });
  }
  // players: error by stat, and how reliable the model's lean vs. the stand-in line is
  const stats = {};
  for (const k of STATS) {
    const a = pl[k];
    const withLine = a.filter((r) => r.line != null);
    const buckets = [];
    for (const [lo, hi] of [[0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 1.01]]) {
      const b = withLine.map((r) => (r.pover >= 0.5 ? { p: r.pover, hit: r.over } : { p: 1 - r.pover, hit: r.act < r.line ? 1 : 0 })).filter((x) => x.p >= lo && x.p < hi);
      if (b.length) buckets.push({ bucket: `${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}%`, n: b.length, said: +mean(b.map((x) => x.p)).toFixed(4), hit: +mean(b.map((x) => x.hit)).toFixed(4) });
    }
    stats[k] = { n: a.length, mae: mae(a.map((r) => r.proj - r.act)), bias: a.length ? +mean(a.map((r) => r.proj - r.act)).toFixed(3) : null,
      line_n: withLine.length, buckets };
  }
  const out = { generated: new Date().toISOString(), summary, calibration: cal, stats, days: days.reverse(), pending };
  fs.writeFileSync(process.env.TRACKER_OUT || path.join(ROOT, "site/data/tracker.json"), JSON.stringify(out));
  console.log(`tracker: graded ${summary.days} days, ${summary.games} games` + (pending ? `; pending ${pending.date}` : ""));
}

const cmd = process.argv[2];
if (cmd === "project") project();
else if (cmd === "report") report();
else console.log("usage: node scripts/tracker.js project|report [options]");
