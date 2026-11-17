#!/usr/bin/env node
/* Season outlook: play out the rest of the regular season (and the play-in and playoffs) many times.

   1. Team strength: every pair of teams plays N neutral-court games in the full possession sim, twice:
      with tonight's injury report and with everyone healthy. A least-squares fit turns the pairwise
      margins into one power rating per team (points better than an average team on a neutral floor).
   2. Each remaining game: margin ~ Normal(rating gap + home edge, GAME_SD). Games in the next INJ_DAYS
      days use the injury-report ratings, later games the healthy ones.
   3. Each simulated season also nudges every team's rating by Normal(0, DRIFT) - teams get better or worse
      (trades, injuries, slumps) in ways nobody can see yet - so long-range odds aren't overconfident.

   node scripts/season.js [model.json] [out.json]     env: PAIR_N (default 120), SEASONS (default 10000)
*/
const fs = require("fs");
const path = require("path");
const Sim = require(path.join(__dirname, "../site/js/sim.js"));

const modelPath = process.argv[2] || "site/data/model.json";
const outPath = process.argv[3] || "site/data/season.json";
const PAIR_N = +process.env.PAIR_N || 120, SEASONS = +process.env.SEASONS || 10000;
const GAME_SD = 13.3, DRIFT = 2.5, INJ_DAYS = 14;
// season-long strength regresses toward last season early on: the blended stats predicted games better in testing
const BASIS = process.env.SEASON_BASIS || "blend";

const EAST = ["ATL", "BOS", "BKN", "CHA", "CHI", "CLE", "DET", "IND", "MIA", "MIL", "NY", "ORL", "PHI", "TOR", "WSH"];
const WEST = ["DAL", "DEN", "GS", "HOU", "LAC", "LAL", "MEM", "MIN", "NO", "OKC", "PHX", "POR", "SAC", "SA", "UTAH"];

const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
const teams = Object.keys(model.teams).filter((t) => EAST.includes(t) || WEST.includes(t)).sort();
const conf = (t) => (EAST.includes(t) ? "East" : "West");
const L = model.league, homeEdge = L.home_margin != null ? L.home_margin : 2.0;
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

// ---- 1. power ratings from pairwise neutral-court sims ----
function ratings(outIds) {
  const idx = Object.fromEntries(teams.map((t, i) => [t, i])), n = teams.length;
  // normal equations for margin(a vs b) = r_a - r_b, with sum r = 0
  const A = Array.from({ length: n + 1 }, () => new Float64Array(n + 1)), b = new Float64Array(n + 1);
  let k = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const opts = { away: teams[i], home: teams[j], neutral: true, pilot: true, out: outIds, seed: 9000 + k++, basis: BASIS };
    // pilot mode skips the lead pull-back: it changes how spread out results are, not the average margin
    const agg = Sim.simulateMany(model, Object.assign({ exp_margin: 0 }, opts), PAIR_N);
    let m = 0; for (let g = 0; g < PAIR_N; g++) m += agg.away[g] - agg.home[g];
    m /= PAIR_N; // team i minus team j
    A[i][i]++; A[j][j]++; A[i][j]--; A[j][i]--; b[i] += m; b[j] -= m;
  }
  for (let i = 0; i < n; i++) { A[n][i] = 1; A[i][n] = 1; }
  // Gaussian elimination
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c <= n; c++) {
    let p = c; for (let r = c + 1; r <= n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r <= n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let x = c; x <= n + 1; x++) M[r][x] -= f * M[c][x]; }
  }
  return Object.fromEntries(teams.map((t, i) => [t, M[i][n + 1] / M[i][i]]));
}
const t0 = Date.now();
const injOut = Sim.defaultOut(model, teams);
const rNow = ratings(injOut);
const rHealthy = ratings([]);
console.log(`ratings: ${teams.length * (teams.length - 1) / 2} pairs x ${PAIR_N} games x 2 in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// ---- 2. schedule: record so far and games left ----
const season = model.schedule.filter((g) => teams.includes(g.home) && teams.includes(g.away) && (g.type == null || g.type === 2));
const W = Object.fromEntries(teams.map((t) => [t, 0])), Lo = Object.fromEntries(teams.map((t) => [t, 0]));
const left = [];
for (const g of season) {
  if (g.home_score != null && g.away_score != null) { if (g.home_score > g.away_score) { W[g.home]++; Lo[g.away]++; } else { W[g.away]++; Lo[g.home]++; } }
  else if (g.date >= today) left.push(g);
}
const dayDiff = (d) => (Date.parse(d) - Date.parse(today)) / 864e5;

// ---- 3. Monte Carlo ----
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const normal = () => { let u = 0, v = 0; while (u === 0) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const Phi = (z) => 0.5 * (1 + Math.tanh(0.7978845608 * (z + 0.044715 * z * z * z)));
const acc = Object.fromEntries(teams.map((t) => [t, { wins: [], seed: new Array(16).fill(0), playoff: 0, playin: 0, top6: 0, r2: 0, cf: 0, finals: 0, title: 0 }]));

for (let s = 0; s < SEASONS; s++) {
  const drift = Object.fromEntries(teams.map((t) => [t, DRIFT * normal()]));
  const rate = (t, near) => (near ? rNow[t] : rHealthy[t]) + drift[t];
  const w = Object.assign({}, W);
  for (const g of left) {
    const near = dayDiff(g.date) <= INJ_DAYS;
    const mu = rate(g.home, near) - rate(g.away, near) + (g.neutral ? 0 : homeEdge);
    if (mu + GAME_SD * normal() > 0) w[g.home]++; else w[g.away]++;
  }
  const strength = (t) => rHealthy[t] + drift[t];
  const pWin = (home, away) => Phi((strength(home) - strength(away) + homeEdge) / GAME_SD);
  const champs = {};
  for (const c of ["East", "West"]) {
    const ct = teams.filter((t) => conf(t) === c).sort((a, b) => w[b] - w[a] || rnd() - 0.5); // ties: coin flip
    ct.forEach((t, i) => { acc[t].seed[i + 1]++; if (i < 6) acc[t].top6++; if (i >= 6 && i < 10) acc[t].playin++; });
    // play-in: 7 v 8 (winner is the 7 seed), 9 v 10, then loser of 7/8 v winner of 9/10 for the 8 seed
    const one = (h, a) => (rnd() < pWin(h, a) ? [h, a] : [a, h]);
    const [s7, l78] = one(ct[6], ct[7]);
    const [w910] = one(ct[8], ct[9]);
    const [s8] = one(l78, w910);
    const seeds = [...ct.slice(0, 6), s7, s8];
    for (const t of seeds) acc[t].playoff++;
    // best-of-7 series, higher seed has home court 2-2-1-1-1
    const series = (hi, lo) => { let a = 0, b = 0, gm = 0; while (a < 4 && b < 4) { const home = [0, 1, 4, 6].includes(gm) ? hi : lo; const winHome = rnd() < pWin(home, home === hi ? lo : hi); if ((home === hi) === winHome) a++; else b++; gm++; } return a === 4 ? hi : lo; };
    const r1 = [series(seeds[0], seeds[7]), series(seeds[3], seeds[4]), series(seeds[2], seeds[5]), series(seeds[1], seeds[6])];
    for (const t of r1) acc[t].r2++;
    const order = (a, b) => (seeds.indexOf(a) < seeds.indexOf(b) ? [a, b] : [b, a]);
    const r2 = [series(...order(r1[0], r1[1])), series(...order(r1[2], r1[3]))];
    for (const t of r2) acc[t].cf++;
    champs[c] = series(...order(r2[0], r2[1]));
    acc[champs[c]].finals++;
  }
  const [a, b] = [champs.East, champs.West];
  const hi = w[a] > w[b] || (w[a] === w[b] && rnd() < 0.5) ? a : b, lo = hi === a ? b : a;
  let x = 0, y = 0, gm = 0;
  while (x < 4 && y < 4) { const home = [0, 1, 4, 6].includes(gm) ? hi : lo; const winHome = rnd() < pWin(home, home === hi ? lo : hi); if ((home === hi) === winHome) x++; else y++; gm++; }
  acc[x === 4 ? hi : lo].title++;
  for (const t of teams) acc[t].wins.push(w[t]);
}

const out = { generated: new Date().toISOString(), through: model.through, seasons: SEASONS, games_left: left.length, basis: BASIS, game_sd: GAME_SD, drift: DRIFT, inj_days: INJ_DAYS, teams: {} };
for (const t of teams) {
  const a = acc[t], ws = a.wins.sort((x, y) => x - y), q = (p) => ws[Math.min(ws.length - 1, Math.floor(p * ws.length))];
  out.teams[t] = {
    conf: conf(t), w: W[t], l: Lo[t], gp_left: left.filter((g) => g.home === t || g.away === t).length,
    rating: +rHealthy[t].toFixed(2), rating_now: +rNow[t].toFixed(2),
    proj_w: +(ws.reduce((x, y) => x + y, 0) / ws.length).toFixed(1), w10: q(0.1), w90: q(0.9),
    seed: a.seed.slice(1, 16).map((v) => +(v / SEASONS).toFixed(4)),
    top6: +(a.top6 / SEASONS).toFixed(4), playin: +(a.playin / SEASONS).toFixed(4), playoff: +(a.playoff / SEASONS).toFixed(4),
    r2: +(a.r2 / SEASONS).toFixed(4), cf: +(a.cf / SEASONS).toFixed(4), finals: +(a.finals / SEASONS).toFixed(4), title: +(a.title / SEASONS).toFixed(4),
  };
}
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`season: ${left.length} games left, ${SEASONS} seasons in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${outPath}`);
const top = teams.slice().sort((a, b) => out.teams[b].title - out.teams[a].title).slice(0, 5);
console.log("title favorites:", top.map((t) => `${t} ${(out.teams[t].title * 100).toFixed(1)}%`).join(", "));
