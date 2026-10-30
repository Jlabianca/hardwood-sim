// Tune league.eff_scale (shot-making) and league.pace_scale (seconds per possession) so the simulated
// league matches the real season's points and possessions per team per game.
// Usage: node scripts/calibrate.js site/data/model.json
const fs = require("fs");
const Sim = require("../site/js/sim.js");
const path = process.argv[2] || "site/data/model.json";
const model = JSON.parse(fs.readFileSync(path));
const teams = Object.keys(model.teams);
function run() {
  delete model._lr;
  let pts = 0, poss = 0, k = 0, homeMargin = 0, reb = 0;
  for (let i = 0; i < 1600; i++) { // every pairing is played at both venues so team strength cancels out of the home margin
    const j = i >> 1;
    let a = teams[j % teams.length], h = teams[(j * 7 + 3) % teams.length];
    if (a === h) continue;
    if (i & 1) [a, h] = [h, a];
    const r = Sim.simulateGame(model, { away: a, home: h, seed: 1000 + i });
    const mins = 48 + 5 * r.ot;
    pts += (r.score.away + r.score.home) * 48 / mins; poss += (r.poss[0] + r.poss[1]) * 48 / mins; k += 2;
    homeMargin += r.score.home - r.score.away;
    for (const id in r.box) reb += (r.box[id].oreb + r.box[id].dreb) * 48 / mins;
  }
  return { pts: pts / k, poss: poss / k, hm: homeMargin / (k / 2), reb: reb / k };
}
const L = model.league, tPts = L.pts_per_team, tPoss = L.poss_per_team;
for (let it = 0; it < 10; it++) {
  const r = run();
  console.log(`eff ${L.eff_scale.toFixed(3)} pace ${L.pace_scale.toFixed(3)} home ${L.home_edge.toFixed(3)} -> ${r.pts.toFixed(2)} pts/team (target ${tPts.toFixed(2)}), ${r.poss.toFixed(2)} poss/team (target ${tPoss.toFixed(2)}), home margin ${r.hm.toFixed(2)}, ${r.reb.toFixed(2)} reb/team (target ${L.reb_per_team})`);
  if (Math.abs(r.pts - tPts) < 0.4 && Math.abs(r.poss - tPoss) < 0.4 && Math.abs(r.reb - L.reb_per_team) < 0.3 && Math.abs(r.hm - L.home_margin) < 0.35) break;
  L.reb_credit *= L.reb_per_team / r.reb;
  L.home_edge = Math.max(0, L.home_edge + (L.home_margin - r.hm) * 0.012);
  L.pace_scale *= Math.pow(tPoss / r.poss, 1.0);
  const ppp = r.pts / r.poss, tppp = tPts / tPoss;
  L.eff_scale += (tppp - ppp) / 0.45;
}
delete model._lr;
fs.writeFileSync(path, JSON.stringify(model));
