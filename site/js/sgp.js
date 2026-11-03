/* Hardwood Sim — same-game parlay pricing.
 * Every leg is checked in the same simulated game, so correlation between legs (a star scoring a lot
 * and his team winning, a big man's rebounds and a low total, ...) is measured, not assumed.
 * Works in the browser (global SGP) and in Node (module.exports) for tests.
 */
(function (root) {
  "use strict";

  const COMBOS = { pra: ["pts", "reb", "ast"], pr: ["pts", "reb"], pa: ["pts", "ast"], ra: ["reb", "ast"], stocks: ["stl", "blk"] };

  /* Per-game values of a stat for one player (aligned with every other player and the team scores). */
  function statArray(r, id, stat) {
    const p = r.players[id];
    if (!p || !p.raw) return null;
    const x = p.raw, n = r.n, out = new Int16Array(n);
    if (x[stat]) return x[stat];
    if (COMBOS[stat]) {
      for (const k of COMBOS[stat]) for (let i = 0; i < n; i++) out[i] += x[k][i];
      return out;
    }
    if (stat === "dd" || stat === "td") {
      const need = stat === "dd" ? 2 : 3;
      for (let i = 0; i < n; i++) {
        const c = (x.pts[i] >= 10) + (x.reb[i] >= 10) + (x.ast[i] >= 10) + (x.stl[i] >= 10) + (x.blk[i] >= 10);
        out[i] = c >= need ? 1 : 0;
      }
      return out;
    }
    return null;
  }

  /* Outcome of one leg in every simulated game: 1 = win, 0 = push, -1 = loss. */
  function legOutcome(leg, r) {
    const n = r.n, out = new Int8Array(n);
    const cmp = (v, line, over) => (v === line ? 0 : (v > line) === over ? 1 : -1);
    if (leg.type === "prop") {
      const v = statArray(r, leg.id, leg.stat);
      if (!v) { out.fill(-1); return out; } // player not in the game (marked out)
      if (leg.stat === "dd" || leg.stat === "td") { for (let i = 0; i < n; i++) out[i] = (v[i] === 1) === (leg.side !== "u") ? 1 : -1; return out; }
      for (let i = 0; i < n; i++) out[i] = cmp(v[i], leg.line, leg.side === "o");
      return out;
    }
    for (let i = 0; i < n; i++) {
      const m = r.home[i] - r.away[i], t = r.home[i] + r.away[i];
      if (leg.type === "ml") out[i] = (leg.side === "home" ? m : -m) > 0 ? 1 : -1;
      else if (leg.type === "spread") out[i] = cmp((leg.side === "home" ? m : -m) + leg.line, 0, true);
      else if (leg.type === "total") out[i] = cmp(t, leg.line, leg.side === "o");
      else if (leg.type === "ttotal") out[i] = cmp(leg.team === "home" ? r.home[i] : r.away[i], leg.line, leg.side === "o");
      else if (leg.type === "h1total") out[i] = cmp(r.home1h[i] + r.away1h[i], leg.line, leg.side === "o");
    }
    return out;
  }

  /* Price a set of legs: each leg alone, all together in the same game, and as if they were independent. */
  function evaluate(legs, r) {
    const n = r.n, outs = legs.map((l) => legOutcome(l, r));
    const each = outs.map((o) => {
      let w = 0, p = 0;
      for (let i = 0; i < n; i++) { if (o[i] === 1) w++; else if (o[i] === 0) p++; }
      return { p: w / n, push: p / n };
    });
    let all = 0, noLoss = 0;
    for (let i = 0; i < n; i++) {
      let win = true, lost = false;
      for (const o of outs) { if (o[i] !== 1) win = false; if (o[i] === -1) { lost = true; break; } }
      if (win) all++;
      if (!lost) noLoss++;
    }
    const joint = all / n, indep = each.reduce((a, e) => a * e.p, 1);
    return {
      n, legs: each, joint, hits: all, pushOnly: (noLoss - all) / n, indep,
      lift: indep > 0 ? joint / indep : null,
      se: Math.sqrt(Math.max(joint * (1 - joint), 1e-9) / n),
    };
  }

  /* "+450", "-120", "450" (American) or "5.5" (decimal) -> decimal odds. */
  function toDecimal(s) {
    const x = parseFloat(String(s).replace(/\s/g, ""));
    if (!isFinite(x)) return null;
    if (Math.abs(x) >= 100) return x > 0 ? 1 + x / 100 : 1 + 100 / -x;
    if (x > 1) return x;
    return null;
  }
  function american(p) {
    if (!(p > 0 && p < 1)) return "–";
    return p >= 0.5 ? String(Math.round((-100 * p) / (1 - p))) : "+" + Math.round((100 * (1 - p)) / p);
  }

  const api = { statArray, legOutcome, evaluate, toDecimal, american };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SGP = api;
})(typeof self !== "undefined" ? self : this);
