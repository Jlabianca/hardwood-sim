/* Hardwood Sim — possession-by-possession NBA game engine.
 * Works in the browser (global NBASim) and in Node (module.exports) for calibration/backtests.
 *
 * Each possession: the clock runs (from both teams' pace), the offense's five on-court players
 * compete for the "chance" (shot / free-throw trip / turnover) in proportion to their per-minute
 * rates, the shot zone and make probability come from the player's shot profile adjusted for the
 * defense and home court, misses go to a rebound battle between the ten players on the floor.
 * A rotation engine plays everyone toward a minutes target, with starters, closers, foul trouble,
 * foul-outs and garbage time.
 */
(function (root) {
  "use strict";

  // ---------------- random ----------------
  function makeRng(seed) {
    let a = (seed >>> 0) || 1;
    const r = function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    r.normal = function () {
      let u = 0; while (u === 0) u = r();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
    };
    r.gamma4 = function (mean) { // sum of 4 exponentials: shape 4
      let s = 0; for (let i = 0; i < 4; i++) s -= Math.log(1 - r());
      return (s / 4) * mean;
    };
    r.pick = function (w) {
      let tot = 0; for (let i = 0; i < w.length; i++) tot += w[i];
      let x = r() * tot;
      for (let i = 0; i < w.length; i++) { x -= w[i]; if (x <= 0) return i; }
      return w.length - 1;
    };
    return r;
  }
  // selection sharpness: >1 concentrates assists/rebounds/blocks on the players who rack them up
  const G_AST = 1.4, G_REB = 1.15, G_BLK = 1.08;
  const logit = (p) => Math.log(p / (1 - p));
  const sigm = (x) => 1 / (1 + Math.exp(-x));
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

  // ---------------- setup ----------------
  function defaultOut(model, teams) {
    const out = [];
    for (const t of teams) for (const p of model.teams[t].players) if (p.out) out.push(p.id);
    return out;
  }

  /* Minutes targets for the available players: scaled to 240, capped, deepest bench trimmed first. */
  function minuteTargets(players, fixed) {
    fixed = fixed || {};
    const fx = players.map((p) => fixed[p.id] != null);
    const fixedSum = players.reduce((a, p, i) => a + (fx[i] ? Math.max(0, Math.min(48, +fixed[p.id])) : 0), 0);
    if (fx.some(Boolean)) { // user-set minutes stay put; everyone else fills the remaining minutes
      const rest = players.filter((_, i) => !fx[i]);
      const scale = Math.max(0, 240 - fixedSum) / 240;
      const tr = minuteTargets(rest).map((x) => x * scale);
      let k = 0;
      return players.map((p, i) => (fx[i] ? Math.max(0.01, Math.min(48, +fixed[p.id])) : tr[k++]));
    }
    const t = players.map((p) => Math.max(0.5, p.min));
    let sum = t.reduce((a, b) => a + b, 0);
    if (sum > 240) { // trim from the bottom of the rotation first, then scale
      const order = t.map((_, i) => i).sort((a, b) => t[a] - t[b]);
      let excess = sum - 240;
      for (const i of order) {
        if (excess <= 0) break;
        const cut = Math.min(excess * 0.6, t[i] * 0.5);
        t[i] -= cut; excess -= cut;
      }
      sum = t.reduce((a, b) => a + b, 0);
      for (let i = 0; i < t.length; i++) t[i] *= 240 / sum;
    } else if (sum < 240) { // injuries: spread the missing minutes over the rotation, capped at 42
      for (let it = 0; it < 6; it++) {
        sum = t.reduce((a, b) => a + b, 0);
        const room = t.map((x) => (x >= 42 ? 0 : x >= 8 ? x : x * 0.3));
        const rs = room.reduce((a, b) => a + b, 0);
        if (sum >= 239.9 || rs <= 0) break;
        for (let i = 0; i < t.length; i++) t[i] = Math.min(42, t[i] + ((240 - sum) * room[i]) / rs);
      }
    }
    return t;
  }

  function prepTeam(model, abbr, outSet, fixed) {
    const T = model.teams[abbr], L = model.league;
    let avail = T.players.filter((p) => !outSet.has(p.id));
    if (avail.length < 5) { // never fewer than five: bring back the highest-minute players marked out
      const back = T.players.filter((p) => outSet.has(p.id)).sort((a, b) => b.min - a.min).slice(0, 5 - avail.length);
      avail = T.players.filter((p) => !outSet.has(p.id) || back.includes(p));
    }
    const targets = minuteTargets(avail, fixed);
    const ps = avail.map((p, i) => {
      const r = p.r;
      const fg3rate = r.fga > 0 ? clamp(r.fg3a / r.fga, 0, 0.95) : 0.3;
      const fgm = Math.max(0.01, r.fgm);
      // free throws: ~12% of FTA come from and-ones, the rest in 2-shot (some 3-shot) trips
      const trip = (r.fta * 0.88) / 2.1;
      const and1 = clamp((r.fta * 0.12) / fgm, 0, 0.2);
      return {
        id: p.id, name: p.name, short: p.short, pos: p.pos, team: abbr, target: targets[i] * 60, start: p.start, min: p.min,
        fga: r.fga, trip, tov: r.tov, fg3rate, p3: p.p3, ft: p.ft, rim: p.rim, prim: p.prim, pmid: p.pmid,
        corner: p.corner, dunk: p.dunk, and1, d: p.d || 0,
        oreb: r.oreb, dreb: r.dreb, ast: r.ast, stl: r.stl, blk: r.blk, pf: r.pf,
      };
    });
    // the team's usual on-court defense (minutes actually played), so lineups — and absences — are measured against it
    let dAvg = T.d_base;
    if (dAvg == null) { dAvg = 0; for (const p of ps) dAvg += p.d * (p.target / 60); dAvg /= 240; }
    return { abbr, ps, pace: T.pace, T, L, dAvg };
  }

  // league-average per-minute rates (for lineup strength ratios)
  function leagueRates(model) {
    if (model._lr) return model._lr;
    let m = 0; const s = { oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, use: 0 };
    for (const t in model.teams) for (const p of model.teams[t].players) {
      const w = Math.max(0, p.min);
      m += w; for (const k in s) s[k] += (k === "use" ? p.r.fga + (p.r.fta * 0.88) / 2.1 + p.r.tov : p.r[k]) * w;
    }
    for (const k in s) s[k] /= m;
    model._lr = s;
    return s;
  }

  // ---------------- one game ----------------
  const STAT_KEYS = ["sec", "pts", "fgm", "fga", "fg3m", "fg3a", "ftm", "fta", "oreb", "dreb", "ast", "stl", "blk", "tov", "pf", "pm"];

  function simulateGame(model, opts) {
    const L = model.league, LR = leagueRates(model);
    const rng = makeRng(opts.seed == null ? (Math.random() * 1e9) | 0 : opts.seed);
    const outSet = new Set(opts.out || defaultOut(model, [opts.away, opts.home]));
    const tm = [prepTeam(model, opts.away, outSet, opts.minutes), prepTeam(model, opts.home, outSet, opts.minutes)];
    const log = !!opts.log;
    const neutral = !!opts.neutral;

    // per-game minutes noise: coaches' rotations wobble night to night
    for (const t of tm) {
      let s0 = 0, s1 = 0;
      for (const p of t.ps) { s0 += p.target; p.gt = p.target * Math.exp(0.12 * rng.normal()); s1 += p.gt; }
      for (const p of t.ps) p.gt *= s0 / s1;
    }
    // per-game form: some nights a player looks for his shot more, some nights it falls more (hot/cold)
    const VU = L.var_use || 0, VE = L.var_eff || 0, VR = L.var_reb || 0, VA = L.var_ast || 0;
    const lgn = (v) => (v ? Math.exp(v * rng.normal() - v * v / 2) : 1);
    for (const t of tm) {
      let sw = 0, se = 0;
      for (const p of t.ps) {
        p.gu = lgn(VU); p.ge = VE ? VE * rng.normal() : 0; p.gr = lgn(VR); p.ga = lgn(VA);
        const w = p.fga * p.target; sw += w; se += w * p.ge;
      }
      // shooting form is relative to teammates: the team's overall shooting night is left to the game itself
      if (VE && sw > 0) for (const p of t.ps) p.ge -= se / sw;
    }

    const box = tm.map((t) => t.ps.map(() => { const o = {}; for (const k of STAT_KEYS) o[k] = 0; return o; }));
    const score = [0, 0], qs = [[], []];
    const gamePace = ((tm[0].pace * tm[1].pace) / L.pace) * (L.pace_scale || 1);
    const possMean = 2880 / (2 * gamePace); // seconds per possession
    const events = [];
    let on = [[], []];
    let q = 1, tleft = 720, lastSub = -1e9, elapsed = 0;
    const ldef = [tm[1].T, tm[0].T]; // defending team's factors, indexed by offense side
    const effBase = L.eff_scale || 0;
    const home = neutral ? -1 : 1;
    // rest: points relative to a normal day off, split between the team's offense and its defense
    const R = L.rest || {}, rest = opts.rest || {};
    const rPts = [R[rest.away] || 0, R[rest.home] || 0];
    const PL = L.def_scale || 0.022; // logit per point per 100 possessions
    const restAdj = [PL * (rPts[0] - rPts[1]) / 2, PL * (rPts[1] - rPts[0]) / 2];
    // matchups: mu[offSide][offIdx] = defIdx, rebuilt whenever lineups change
    const mu = [{}, {}];
    function assignMatchups() {
      for (let o = 0; o < 2; o++) {
        const d = 1 - o, offs = on[o].slice(), defs = on[d].slice(), m = {};
        const order = { G: 0, F: 1, C: 2 };
        offs.sort((a, b) => order[tm[o].ps[a].pos] - order[tm[o].ps[b].pos] || tm[o].ps[b].fga - tm[o].ps[a].fga);
        defs.sort((a, b) => order[tm[d].ps[a].pos] - order[tm[d].ps[b].pos] || tm[d].ps[b].d - tm[d].ps[a].d);
        // same position first (best defender takes the most dangerous scorer), then whoever is left
        const free = new Set(defs);
        for (const i of offs) {
          const pos = tm[o].ps[i].pos;
          const j = defs.find((x) => free.has(x) && tm[d].ps[x].pos === pos);
          if (j != null) { m[i] = j; free.delete(j); }
        }
        for (const i of offs) if (m[i] == null) { const j = [...free][0]; m[i] = j; free.delete(j); }
        mu[o] = m;
      }
    }

    // ---- rotation ----
    const isCloseLate = () => q >= 4 && tleft <= 300 && Math.abs(score[0] - score[1]) <= 12;
    function garbage() {
      const m = Math.abs(score[0] - score[1]);
      return q === 4 && ((tleft <= 480 && m >= 22) || (tleft <= 300 && m >= 17) || (tleft <= 720 && m >= 30));
    }
    function chooseLineup(s, mode) {
      const t = tm[s], B = box[s];
      const ok = t.ps.map((p, i) => B[i].pf < 6);
      let idx = t.ps.map((_, i) => i).filter((i) => ok[i]);
      if (idx.length < 5) { // short-handed: fouled-out players stay in when nobody else is left (NBA rule)
        const extra = t.ps.map((_, i) => i).filter((i) => !ok[i]).sort((a, b) => B[a].pf - B[b].pf);
        idx = idx.concat(extra.slice(0, 5 - idx.length));
      }
      let score_;
      if (mode === "start") score_ = (i) => t.ps[i].start * 100 + t.ps[i].gt / 60;
      else if (mode === "close") score_ = (i) => t.ps[i].gt / 60 - (B[i].pf >= 5 && tleft > 120 ? 8 : 0);
      else if (mode === "garbage") score_ = (i) => -t.ps[i].gt / 60;
      else {
        const horizon = Math.min(2880, elapsed + 200);
        score_ = (i) => {
          const p = t.ps[i];
          let need = (p.gt * horizon) / 2880 - B[i].sec;
          if (on[s].includes(i)) need += 45; // continuity
          const qq = Math.min(q, 4);
          if (B[i].pf >= qq + 1 && q < 4) need -= 2000; // foul trouble: sit until next quarter
          if (q === 4 && B[i].pf === 5 && tleft > 240) need -= 2000;
          return need;
        };
      }
      idx.sort((a, b) => score_(b) - score_(a));
      // light positional sanity: at most 2 centers, at least 1 guard
      const pick = [];
      let c = 0, g = 0;
      for (const i of idx) {
        const pos = t.ps[i].pos;
        if (pos === "C" && c >= 2 && mode !== "garbage") continue;
        if (pick.length === 4 && g === 0 && pos !== "G" && idx.some((j) => !pick.includes(j) && t.ps[j].pos === "G" && j !== i)) continue;
        pick.push(i); if (pos === "C") c++; if (pos === "G") g++;
        if (pick.length === 5) break;
      }
      for (const i of idx) { if (pick.length >= 5) break; if (!pick.includes(i)) pick.push(i); }
      return pick;
    }
    function subs(force) {
      const mode = force === "start" ? "start" : q > 4 ? "close" : garbage() ? "garbage" : isCloseLate() ? "close" : "normal";
      for (let s = 0; s < 2; s++) on[s] = chooseLineup(s, mode);
      lastSub = elapsed;
      assignMatchups();
    }

    // ---- helpers ----
    const pickOn = (s, wfn, excl) => {
      const w = on[s].map((i) => (i === excl ? 0 : Math.max(1e-6, wfn(tm[s].ps[i]))));
      return on[s][rng.pick(w)];
    };
    function addPts(s, pts) {
      score[s] += pts;
      for (const i of on[s]) box[s][i].pm += pts;
      for (const i of on[1 - s]) box[1 - s][i].pm -= pts;
      qs[s][q - 1] = (qs[s][q - 1] || 0) + pts;
    }
    function lineupSum(s, k) { let x = 0; for (const i of on[s]) x += tm[s].ps[i][k]; return x; }

    function rebound(o, live, isFt, ev) {
      const d = 1 - o;
      const offS = lineupSum(o, "oreb") / (5 * LR.oreb), defS = lineupSum(d, "dreb") / (5 * LR.dreb);
      const base = isFt ? 0.13 : L.orb_rate;
      const odds = (base / (1 - base)) * Math.pow(offS / defS, 0.8) * (ldef[o].d_orb || 1);
      const off = rng() < odds / (1 + odds);
      const side = off ? o : d;
      let who = -1;
      if (rng() < L.reb_credit / (isFt ? 1 : 0.97)) {
        who = pickOn(side, (p) => Math.pow(off ? p.oreb : p.dreb, G_REB) * p.gr);
        box[side][who][off ? "oreb" : "dreb"]++;
      }
      if (ev) ev.reb = { side, who: who >= 0 ? tm[side].ps[who].id : null, off };
      return off;
    }

    let lastFtMade = true;
    function freeThrows(o, shooter, n, ev) {
      const p = tm[o].ps[shooter], B = box[o][shooter];
      let made = 0, last = false;
      for (let k = 0; k < n; k++) { B.fta++; last = rng() < p.ft; if (last) { B.ftm++; made++; } }
      if (made) addPts(o, made);
      if (ev) { ev.ftm = made; ev.fta = n; }
      lastFtMade = last;
      return made;
    }

    // ---- one possession; returns seconds used ----
    function possession(o) {
      const d = 1 - o;
      const D = ldef[o];
      const lead = score[o] - score[d];
      const late = q >= 4 && tleft <= 120;
      let dur;
      // intentional fouling: defense trails late
      if (q >= 4 && tleft <= 48 && lead >= 1 && lead <= 9) {
        dur = Math.min(tleft, 2 + rng() * 4);
        const shooter = pickOn(o, (p) => (p.fga + p.trip) * p.ft * p.ft);
        const fouler = pickOn(d, (p) => p.pf);
        box[d][fouler].pf++;
        const ev = log ? { kind: "foul", side: o, pid: tm[o].ps[shooter].id, by: tm[d].ps[fouler].id } : null;
        const made = freeThrows(o, shooter, 2, ev);
        let again = false;
        if (!lastFtMade) again = rebound(o, true, true, ev);
        if (log) push(ev, dur);
        return { dur, keep: again };
      }
      let mean = possMean;
      if (late && lead > 0) mean = 21; // milk the clock
      else if (late && lead < 0) mean = 10; // hurry
      dur = clamp(rng.gamma4(mean), 4, 24);
      if (o === transition) { dur *= 0.55; }
      if (tleft <= 26) dur = Math.max(0.5, tleft - 0.5 - rng() * 1.5);
      dur = Math.min(dur, tleft);
      const trans = o === transition;
      transition = -1;
      if (rng() < L.extra_foul) { const f = pickOn(d, (x) => x.pf); box[d][f].pf++; }

      let chance = 0, used = dur;
      while (true) {
        chance++;
        const ev = log ? { side: o } : null;
        // who ends this chance, and how
        const w = on[o].map((i) => { const p = tm[o].ps[i]; return (p.fga + p.trip + p.tov) * p.gu; });
        // usage load: a lineup with less shot creation than usual has to stretch, and gets less efficient
        let load = 0; for (const x of w) load += x;
        load = load / (5 * LR.use);
        const loadAdj = clamp(L.load_k * Math.log(load), -0.12, 0.08);
        const actor = on[o][rng.pick(w)];
        const p = tm[o].ps[actor], B = box[o][actor];
        const wF = p.fga, wT = p.trip * (D.d_ftr || 1), wO = p.tov * (D.d_tov || 1) * (trans ? 0.8 : 1) * Math.exp(-loadAdj * 2);
        const u = rng() * (wF + wT + wO);
        if (u < wO) { // turnover
          B.tov++;
          let stealer = -1;
          if (rng() < L.stl_per_tov * Math.pow(lineupSum(d, "stl") / (5 * LR.stl), 0.7)) {
            stealer = pickOn(d, (x) => x.stl); box[d][stealer].stl++;
            transition = d;
          }
          if (ev) { ev.kind = "to"; ev.pid = p.id; ev.stl = stealer >= 0 ? tm[d].ps[stealer].id : null; push(ev, used); }
          return { dur: used };
        }
        if (u < wO + wT) { // free-throw trip (shooting foul / bonus)
          const fouler = pickOn(d, (x) => x.pf); box[d][fouler].pf++;
          const n = rng() < 0.07 ? 3 : 2;
          if (ev) { ev.kind = "ft"; ev.pid = p.id; ev.by = tm[d].ps[fouler].id; }
          const made = freeThrows(o, actor, n, ev);
          let off = false;
          if (!lastFtMade && rng() < 0.97) off = rebound(o, true, true, ev);
          if (ev) push(ev, used);
          if (off && tleft - used > 2 && chance < 6) { used = Math.min(tleft, used + 3 + rng() * 5); continue; }
          return { dur: used };
        }
        // field-goal attempt
        const late3 = q >= 4 && tleft - used <= 30 && lead <= -3 && lead >= -8;
        let p3 = clamp(p.fg3rate * (D.d_3par || 1), 0, 0.97);
        if (late3) p3 = Math.max(p3, 0.85);
        const three = rng() < p3;
        let zone = "three";
        if (!three) {
          let rs = p.rim + (trans ? 0.15 : 0) + (chance > 1 ? 0.25 : 0);
          zone = rng() < clamp(rs, 0.05, 0.97) ? "rim" : "mid";
        }
        let base = zone === "three" ? p.p3 : zone === "rim" ? p.prim : p.pmid;
        let lg = logit(clamp(base, 0.05, 0.95)) + effBase + 4.0 * (D.d_efg || 0) + loadAdj + restAdj[o] + p.ge;
        // lineup defense: the five defenders vs. the team's usual defense, plus the man guarding the shooter
        let dSum = 0; for (const j of on[d]) dSum += tm[d].ps[j].d;
        const guard = mu[o][actor];
        const dG = guard != null ? tm[d].ps[guard].d : dSum / 5;
        lg -= PL * ((dSum - 5 * tm[d].dAvg) + (L.matchup_w || 0) * (dG - dSum / 5));
        if (home !== -1 && o === 1) lg += L.home_edge;
        if (trans && zone !== "three") lg += 0.15;
        if (chance > 1 && zone === "rim") lg += 0.1;
        const made = rng() < sigm(lg);
        B.fga++; if (three) B.fg3a++;
        if (ev) { ev.kind = three ? "3" : "2"; ev.zone = zone; ev.pid = p.id; ev.made = made; ev.putback = chance > 1; ev.def = guard != null ? tm[d].ps[guard].id : null; geo(ev, zone, p); }
        if (made) {
          B.fgm++; if (three) B.fg3m++;
          addPts(o, three ? 3 : 2);
          // assist
          const pa = (zone === "three" ? 0.92 : zone === "rim" ? 0.63 : 0.51) * (L.ast_per_fgm / 0.62) *
            Math.pow(lineupSum(o, "ast") / Math.max(1e-6, 5 * LR.ast), 0.5) * (chance > 1 ? 0.35 : 1);
          if (rng() < clamp(pa, 0, 0.95)) {
            const a = pickOn(o, (x) => Math.pow(x.ast, G_AST) * x.ga, actor); box[o][a].ast++;
            if (ev) ev.ast = tm[o].ps[a].id;
          }
          // and-one
          if (rng() < p.and1 * (D.d_ftr || 1) * (zone === "three" ? 0.15 : zone === "rim" ? 1.5 : 0.6)) {
            const fouler = pickOn(d, (x) => x.pf); box[d][fouler].pf++;
            if (ev) { ev.and1 = true; ev.by = tm[d].ps[fouler].id; }
            const m1 = freeThrows(o, actor, 1, ev);
            if (!m1 && rebound(o, true, true, ev) && tleft - used > 3 && chance < 6) {
              if (ev) push(ev, used);
              used = Math.min(tleft, used + 3 + rng() * 4); continue;
            }
          }
          if (ev) push(ev, used);
          return { dur: used };
        }
        // miss: block?
        if (!three) {
          const pb = L.blk_per_miss2 * (zone === "rim" ? 1.4 : 0.57) * Math.pow(lineupSum(d, "blk") / (5 * LR.blk), 0.8);
          if (rng() < clamp(pb, 0, 0.5)) {
            const b = pickOn(d, (x) => Math.pow(x.blk, G_BLK)); box[d][b].blk++;
            if (ev) ev.blk = tm[d].ps[b].id;
          }
        }
        const off = rebound(o, true, false, ev);
        if (ev) push(ev, used);
        if (off && tleft - used > 1.5 && chance < 6) { used = Math.min(tleft, used + 2 + rng() * 6); continue; }
        return { dur: used };
      }
    }

    function geo(ev, zone, p) { // illustrative shot location in feet from the rim (x along the court, y across)
      let r, a;
      if (zone === "rim") { r = rng() * 5; a = (rng() - 0.5) * Math.PI; }
      else if (zone === "mid") { r = 8 + rng() * 14; a = (rng() - 0.5) * Math.PI * 0.9; }
      else if (rng() < p.corner) { ev.x = rng() * 9 - 1; ev.y = (rng() < 0.5 ? -1 : 1) * (22.1 + rng() * 0.8); ev.dist = Math.round(Math.hypot(ev.x, ev.y)); return; }
      else { r = 24 + rng() * (rng() < 0.15 ? 8 : 3); a = (rng() - 0.5) * Math.PI * 0.75; }
      ev.x = Math.max(-3.5, r * Math.cos(a)); ev.y = r * Math.sin(a); ev.dist = Math.round(r);
      ev.dunk = zone === "rim" && rng() < p.dunk * 1.6;
      ev.style = rng();
    }

    function push(ev, used) {
      ev.q = q; ev.t = Math.max(0, tleft - used); ev.score = [score[0], score[1]];
      ev.on = [on[0].map((i) => tm[0].ps[i].id), on[1].map((i) => tm[1].ps[i].id)];
      events.push(ev);
    }

    // ---- game loop ----
    let transition = -1;
    const nposs = [0, 0];
    const tipWinner = rng() < 0.5 ? 0 : 1;
    let poss = tipWinner;
    subs("start");
    if (log) events.push({ kind: "tip", q: 1, t: 720, side: tipWinner, score: [0, 0], on: [on[0].map((i) => tm[0].ps[i].id), on[1].map((i) => tm[1].ps[i].id)] });
    while (true) {
      while (tleft > 0.4) {
        if (elapsed - lastSub >= 150 || on.some((l, s) => l.some((i) => box[s][i].pf >= 6))) subs();
        const r = possession(poss);
        if (!r.keep) nposs[poss]++;
        const dsec = Math.max(0.3, r.dur);
        for (let s = 0; s < 2; s++) for (const i of on[s]) box[s][i].sec += dsec;
        tleft -= dsec; elapsed += dsec;
        if (!r.keep) poss = 1 - poss;
      }
      if (log) events.push({ kind: "endq", q, t: 0, score: [score[0], score[1]], on: [on[0].map((i) => tm[0].ps[i].id), on[1].map((i) => tm[1].ps[i].id)] });
      if (q >= 4 && score[0] !== score[1]) break;
      if (q > 12) break;
      q++;
      tleft = q <= 4 ? 720 : 300;
      transition = -1;
      poss = q <= 4 ? (q === 4 ? tipWinner : 1 - tipWinner) : (rng() < 0.5 ? 0 : 1);
      subs(q === 3 ? "start" : undefined);
    }

    // ---- results ----
    const res = { score: { away: score[0], home: score[1] }, ot: q - 4 > 0 ? q - 4 : 0, poss: nposs, qs: { away: qs[0], home: qs[1] }, box: {}, teams: [tm[0].abbr, tm[1].abbr] };
    for (let s = 0; s < 2; s++) tm[s].ps.forEach((p, i) => {
      const b = box[s][i];
      b.pts = b.ftm + 2 * (b.fgm - b.fg3m) + 3 * b.fg3m;
      res.box[p.id] = Object.assign({ id: p.id, name: p.name, short: p.short, pos: p.pos, team: p.team, side: s }, b);
    });
    if (log) { res.events = events; res.roster = tm.map((t) => t.ps.map((p) => ({ id: p.id, name: p.name, short: p.short, pos: p.pos }))); }
    return res;
  }

  // ---------------- many games ----------------
  const AGG_KEYS = ["min", "pts", "reb", "ast", "fg3m", "stl", "blk", "tov", "oreb", "fga", "fta"];
  function simulateMany(model, opts, n, progress) {
    const base = opts.seed == null ? 1 : opts.seed;
    const agg = { n, away: new Int16Array(n), home: new Int16Array(n), away1h: new Int16Array(n), home1h: new Int16Array(n), ot: 0, wins: { away: 0, home: 0 }, players: {} };
    for (let g = 0; g < n; g++) {
      const r = simulateGame(model, Object.assign({}, opts, { seed: (base * 1000003 + g * 7919) >>> 0, log: false }));
      agg.away[g] = r.score.away; agg.home[g] = r.score.home;
      agg.away1h[g] = (r.qs.away[0] || 0) + (r.qs.away[1] || 0);
      agg.home1h[g] = (r.qs.home[0] || 0) + (r.qs.home[1] || 0);
      if (r.ot) agg.ot++;
      if (r.score.away > r.score.home) agg.wins.away++; else agg.wins.home++;
      for (const id in r.box) {
        const b = r.box[id];
        let P = agg.players[id];
        if (!P) {
          P = agg.players[id] = { id, name: b.name, short: b.short, pos: b.pos, team: b.team, stats: {} };
          for (const k of AGG_KEYS) P.stats[k] = new Int16Array(n);
        }
        const S = P.stats;
        S.min[g] = Math.round(b.sec / 60); S.pts[g] = b.pts; S.reb[g] = b.oreb + b.dreb; S.ast[g] = b.ast; S.fg3m[g] = b.fg3m;
        S.stl[g] = b.stl; S.blk[g] = b.blk; S.tov[g] = b.tov; S.oreb[g] = b.oreb; S.fga[g] = b.fga; S.fta[g] = b.fta;
      }
      if (progress && (g + 1) % 250 === 0) progress((g + 1) / n);
    }
    return agg;
  }

  /* Turn raw per-game arrays into sorted distributions for every prop market. */
  function summarize(agg) {
    const n = agg.n, players = {};
    for (const id in agg.players) {
      const p = agg.players[id], s = p.stats;
      const d = {};
      const mk = (f) => { const a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = f(i); return a; };
      for (const k of ["min", "pts", "reb", "ast", "fg3m", "stl", "blk", "tov"]) d[k] = Int16Array.from(s[k]);
      d.pra = mk((i) => s.pts[i] + s.reb[i] + s.ast[i]);
      d.pr = mk((i) => s.pts[i] + s.reb[i]);
      d.pa = mk((i) => s.pts[i] + s.ast[i]);
      d.ra = mk((i) => s.reb[i] + s.ast[i]);
      d.stocks = mk((i) => s.stl[i] + s.blk[i]);
      const cats = (i) => (s.pts[i] >= 10) + (s.reb[i] >= 10) + (s.ast[i] >= 10) + (s.stl[i] >= 10) + (s.blk[i] >= 10);
      d.dd = mk((i) => (cats(i) >= 2 ? 1 : 0));
      d.td = mk((i) => (cats(i) >= 3 ? 1 : 0));
      for (const k in d) d[k].sort();
      // unsorted per-game results, aligned across players and teams: game g is the same simulated game everywhere
      const raw = {};
      for (const k of ["min", "pts", "reb", "ast", "fg3m", "stl", "blk", "tov"]) raw[k] = s[k];
      players[id] = { id, name: p.name, short: p.short, pos: p.pos, team: p.team, d, raw };
    }
    return { n, away: agg.away, home: agg.home, away1h: agg.away1h, home1h: agg.home1h, ot: agg.ot, wins: agg.wins, players };
  }

  const api = { simulateGame, simulateMany, summarize, defaultOut, minuteTargets, makeRng };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NBASim = api;
})(typeof self !== "undefined" ? self : this);
