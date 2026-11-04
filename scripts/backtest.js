// Backtest: for each as-of model (built only from games before its date), simulate the games of the
// following 7 days and compare with the real results, the closing lines and the players' real stat lines.
// Players who didn't play in the real game are treated as out (inactives are known at tip-off).
// Usage: node scripts/backtest.js 2026 2026-02-02 2026-02-09 ...   (dates = as-of model dates)
const fs = require("fs");
const Sim = require(process.env.SIM ? require("path").resolve(process.env.SIM) : "../site/js/sim.js");
const [season, ...dates] = process.argv.slice(2);
const DIR = process.env.BT_DIR || "backtest";
const actual = JSON.parse(fs.readFileSync(process.env.ACTUALS || `backtest/actuals_${season}.json`));
const N = +(process.env.N || 1000);
const rows = [], props = { pts: [], reb: [], ast: [], fg3m: [] }, base = { pts: [], reb: [], ast: [] };
const leans = { pts: [], reb: [], ast: [] };
const mtiers = {};
const tiers = { "avg 25+": [], "avg 18-25": [], "avg 10-18": [], "avg <10": [] }; // model minus actual points, by season average // [model P(over), hit] against the season-average stand-in line
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const NOREST = process.env.NOREST === "1";
function restCat(model, team, date) {
  let prev = null;
  for (const g of model.schedule) if ((g.home === team || g.away === team) && g.date < date && (!prev || g.date > prev)) prev = g.date;
  if (!prev) return "1";
  const days = Math.round((Date.parse(date) - Date.parse(prev)) / 864e5) - 1;
  return days <= 0 ? "b2b" : days === 1 ? "1" : "2+";
}
for (let k = 0; k < dates.length; k++) {
  const d0 = dates[k];
  const d1 = new Date(Date.parse(d0) + 7 * 864e5).toISOString().slice(0, 10);
  const model = JSON.parse(fs.readFileSync(`${DIR}/model_${d0}.json`));
  if (process.env.DEF_SCALE) model.league.def_scale = +process.env.DEF_SCALE;
  if (process.env.VAR_USE) model.league.var_use = +process.env.VAR_USE;
  if (process.env.VAR_EFF) model.league.var_eff = +process.env.VAR_EFF;
  if (process.env.VAR_REB) model.league.var_reb = +process.env.VAR_REB;
  if (process.env.VAR_AST) model.league.var_ast = +process.env.VAR_AST;
  if (process.env.USE_GAMMA) model.league.use_gamma = +process.env.USE_GAMMA;
  if (process.env.MIN_BOOST) model.league.min_boost = +process.env.MIN_BOOST;
  const games = actual.filter((g) => g.date >= d0 && g.date < d1 && model.teams[g.home] && model.teams[g.away]);
  for (const g of games) {
    const ids = [...model.teams[g.home].players, ...model.teams[g.away].players].map((p) => p.id);
    const out = ids.filter((id) => !g.players[id] || g.players[id].min <= 0);
    const rest = NOREST ? undefined : { away: restCat(model, g.away, g.date), home: restCat(model, g.home, g.date) };
    const agg = Sim.simulateMany(model, { away: g.away, home: g.home, out, rest, seed: 7 }, N);
    const margin = Array.from(agg.home, (h, i) => h - agg.away[i]);
    const total = Array.from(agg.home, (h, i) => h + agg.away[i]);
    rows.push({ g, mMargin: mean(margin), mTotal: mean(total), pHome: agg.wins.home / N });
    const avgOf = {};
    for (const t of [g.home, g.away]) for (const p of model.teams[t].players) avgOf[p.id] = p.avg;
    for (const id in agg.players) {
      const a = g.players[id];
      if (!a || a.min <= 0) continue;
      const s = agg.players[id].stats;
      for (const st in props) props[st].push([mean(Array.from(s[st])), a[st]]);
      const av = avgOf[id];
      if (av && av.pts != null) for (const st in base) base[st].push([av[st], a[st], mean(Array.from(s[st]))]);
      if (av && av.pts != null) {
        const t = av.pts >= 25 ? "avg 25+" : av.pts >= 18 ? "avg 18-25" : av.pts >= 10 ? "avg 10-18" : "avg <10";
        tiers[t].push(mean(Array.from(s.pts)) - a.pts);
        (mtiers[t] = mtiers[t] || []).push(mean(Array.from(s.min)) - a.min);
      }
      if (av && av.pts != null) for (const st in leans) {
        const line = Math.floor(av[st]) + 0.5, arr = s[st];
        let o = 0; for (let i = 0; i < arr.length; i++) if (arr[i] > line) o++;
        const p = o / arr.length;
        leans[st].push(p >= 0.5 ? [p, a[st] > line ? 1 : 0] : [1 - p, a[st] < line ? 1 : 0]);
      }
    }
  }
  console.log(`${d0}: ${games.length} games`);
}
const mae = (xs) => mean(xs.map(Math.abs));
const corr = (pairs) => {
  const xs = pairs.map((p) => p[0]), ys = pairs.map((p) => p[1]), mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
};
const withLines = rows.filter((r) => r.g.home_spread != null && r.g.total != null);
const act = (r) => r.g.home_score - r.g.away_score, actT = (r) => r.g.home_score + r.g.away_score;
console.log(`\n${rows.length} games (${withLines.length} with closing lines), ${N} sims each`);
console.log(`margin MAE  model ${mae(withLines.map((r) => r.mMargin - act(r))).toFixed(2)}  market ${mae(withLines.map((r) => -r.g.home_spread - act(r))).toFixed(2)}`);
console.log(`total  MAE  model ${mae(withLines.map((r) => r.mTotal - actT(r))).toFixed(2)}  market ${mae(withLines.map((r) => r.g.total - actT(r))).toFixed(2)}`);
console.log(`mean total  model ${mean(rows.map((r) => r.mTotal)).toFixed(1)}  market ${mean(withLines.map((r) => r.g.total)).toFixed(1)}  actual ${mean(rows.map(actT)).toFixed(1)}`);
console.log(`model margin vs closing spread correlation ${corr(withLines.map((r) => [r.mMargin, -r.g.home_spread])).toFixed(2)}`);
console.log(`winner picked ${(mean(rows.map((r) => ((r.pHome > 0.5) === (act(r) > 0) ? 1 : 0))) * 100).toFixed(1)}%`);
const brier = mean(rows.map((r) => (r.pHome - (act(r) > 0 ? 1 : 0)) ** 2));
console.log(`win-probability Brier score ${brier.toFixed(4)}`);
for (const st in leans) {
  const out = [];
  let ece = 0;
  for (const [lo, hi] of [[0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 0.75], [0.75, 1.01]]) {
    const b = leans[st].filter((x) => x[0] >= lo && x[0] < hi);
    if (!b.length) continue;
    const said = mean(b.map((x) => x[0])), hit = mean(b.map((x) => x[1]));
    ece += (b.length / leans[st].length) * Math.abs(said - hit);
    out.push(`${Math.round(lo * 100)}-${Math.round(Math.min(hi, 1) * 100)}%: n=${b.length} said ${(said * 100).toFixed(1)} hit ${(hit * 100).toFixed(1)}`);
  }
  console.log(`leans ${st.padEnd(4)} calibration error ${(ece * 100).toFixed(2)} | ${out.join(" | ")}`);
}
console.log("minutes bias by season average (model - actual): " + Object.entries(mtiers).map(([k, v]) => `${k} ${mean(v).toFixed(2)}`).join(" | "));
console.log("points bias by season average (model - actual): " + Object.entries(tiers).map(([k, v]) => `${k} ${v.length ? mean(v).toFixed(2) : "-"} (n=${v.length})`).join(" | "));
for (const st in base) console.log(`season-avg baseline ${st.padEnd(4)} n=${base[st].length} corr ${corr(base[st]).toFixed(2)} MAE ${mae(base[st].map((p) => p[0] - p[1])).toFixed(2)} | model on same players corr ${corr(base[st].map((p) => [p[2], p[1]])).toFixed(2)} MAE ${mae(base[st].map((p) => p[2] - p[1])).toFixed(2)}`);
for (const st in props) console.log(`player ${st.padEnd(5)} n=${props[st].length} corr ${corr(props[st]).toFixed(2)} MAE ${mae(props[st].map((p) => p[0] - p[1])).toFixed(2)}`);
