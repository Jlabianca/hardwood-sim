// Backtest: for each as-of model (built only from games before its date), simulate the games of the
// following 7 days and compare with the real results, the closing lines and the players' real stat lines.
// Players who didn't play in the real game are treated as out (inactives are known at tip-off).
// Usage: node scripts/backtest.js 2026 2026-02-02 2026-02-09 ...   (dates = as-of model dates)
const fs = require("fs");
const Sim = require("../site/js/sim.js");
const [season, ...dates] = process.argv.slice(2);
const actual = JSON.parse(fs.readFileSync(`backtest/actuals_${season}.json`));
const N = +(process.env.N || 1000);
const rows = [], props = { pts: [], reb: [], ast: [], fg3m: [] }, base = { pts: [], reb: [], ast: [] };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
for (let k = 0; k < dates.length; k++) {
  const d0 = dates[k];
  const d1 = new Date(Date.parse(d0) + 7 * 864e5).toISOString().slice(0, 10);
  const model = JSON.parse(fs.readFileSync(`backtest/model_${d0}.json`));
  const games = actual.filter((g) => g.date >= d0 && g.date < d1 && model.teams[g.home] && model.teams[g.away]);
  for (const g of games) {
    const ids = [...model.teams[g.home].players, ...model.teams[g.away].players].map((p) => p.id);
    const out = ids.filter((id) => !g.players[id] || g.players[id].min <= 0);
    const agg = Sim.simulateMany(model, { away: g.away, home: g.home, out, seed: 7 }, N);
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
for (const st in base) console.log(`season-avg baseline ${st.padEnd(4)} n=${base[st].length} corr ${corr(base[st]).toFixed(2)} MAE ${mae(base[st].map((p) => p[0] - p[1])).toFixed(2)} | model on same players corr ${corr(base[st].map((p) => [p[2], p[1]])).toFixed(2)} MAE ${mae(base[st].map((p) => p[2] - p[1])).toFixed(2)}`);
for (const st in props) console.log(`player ${st.padEnd(5)} n=${props[st].length} corr ${corr(props[st]).toFixed(2)} MAE ${mae(props[st].map((p) => p[0] - p[1])).toFixed(2)}`);
