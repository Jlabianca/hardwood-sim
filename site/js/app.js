/* Hardwood Sim — UI: game picker, animated replay of one simulated game, projections, injuries/minutes. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  let model = null, cur = { away: null, home: null }, outSet = new Set(), minutes = {}, seed = 1, game = null;
  let idx = -1, playing = false, timer = null, speed = 1;
  let projResult = null, projStale = true, worker = null;
  const lines = {}; // user-entered prop lines: key `${id}|${stat}`
  const players = {}; // id -> {name, short, team, pos}
  const colCache = {};

  // ---------------- colors ----------------
  const lumOf = (hex) => { const n = parseInt(String(hex).replace("#", ""), 16); return isNaN(n) ? 0 : (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255; };
  function teamColor(T) { // dark primaries (navy, black) read poorly on the dark UI: use the alternate color when it's livelier
    if (lumOf(T.color) < 0.25 && T.alt && lumOf(T.alt) > 0.3 && lumOf(T.alt) < 0.9) return bright(T.alt);
    return bright(T.color);
  }
  function bright(hex) { // lift dark team colors so they read on the dark background
    const n = parseInt(String(hex).replace("#", ""), 16);
    if (isNaN(n)) return "#9aa";
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (lum < 0.42) {
      const k = Math.min(0.6, (0.42 - lum) * 1.6 + 0.15);
      r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k;
    }
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }
  const col = (t) => colCache[t] || (colCache[t] = model && model.teams[t] ? teamColor(model.teams[t]) : "#9aa");

  // ---------------- boot ----------------
  fetch("data/model.json").then((r) => r.json()).then((m) => {
    model = m;
    for (const t in m.teams) for (const p of m.teams[t].players) players[p.id] = { name: p.name, short: p.short, team: t, pos: p.pos };
    $("dataLine").textContent = `${m.season_label} season · data through ${fmtDate(m.through)} · built ${m.generated}`;
    initPicker();
    initTabs();
    initControls();
    fromHash() || selectGame(defaultGame());
  }).catch((e) => { $("dataLine").textContent = "Could not load data/model.json — serve this folder over http (see README). " + e; });

  const todayET = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  function fmtDate(d) {
    const [y, mo, da] = d.split("-").map(Number);
    return new Date(Date.UTC(y, mo - 1, da, 12)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }
  function fmtDay(d) {
    const [y, mo, da] = d.split("-").map(Number);
    return new Date(Date.UTC(y, mo - 1, da, 12)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  }
  const tipTime = (iso) => { try { return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }); } catch (e) { return ""; } };

  function defaultDate() {
    const dates = [...new Set(model.schedule.map((g) => g.date))];
    const t = todayET();
    return dates.find((d) => d >= t) || dates[dates.length - 1];
  }
  function defaultGame() {
    const d = defaultDate();
    return model.schedule.find((g) => g.date === d) || model.schedule[model.schedule.length - 1];
  }

  // ---------------- picker ----------------
  function initPicker() {
    const dates = [...new Set(model.schedule.map((g) => g.date))];
    const def = defaultDate(), t = todayET();
    $("dateSel").innerHTML = dates.map((d) => `<option value="${d}" ${d === def ? "selected" : ""}>${fmtDay(d)}${d === t ? " (today)" : ""}</option>`).join("");
    $("dateSel").onchange = renderGames;
    const teams = Object.keys(model.teams).sort();
    const opts = teams.map((t) => `<option>${t}</option>`).join("");
    $("awaySel").innerHTML = opts; $("homeSel").innerHTML = opts;
    $("awaySel").onchange = $("homeSel").onchange = () => {
      if ($("awaySel").value !== $("homeSel").value) selectGame({ away: $("awaySel").value, home: $("homeSel").value });
    };
    $("neutralChk").onchange = $("restAway").onchange = $("restHome").onchange = () => { newGame(seed); projStale = true; if (activeTab() === "proj") runProjections(); };
    renderGames();
  }
  function renderGames() {
    const d = $("dateSel").value;
    $("gameList").innerHTML = model.schedule.filter((g) => g.date === d).map((g) => {
      const tail = g.home_score != null ? ` <span class="fin">${g.away_score}-${g.home_score}</span>` : ` <span class="fin">${tipTime(g.start)}</span>`;
      const sel = g.away === cur.away && g.home === cur.home ? "sel" : "";
      const bb = (t) => (restCat(t, g.date) === "b2b" ? `<span class="b2b" title="second night of a back-to-back">B2B</span>` : "");
      return `<button class="${sel}" data-id="${g.id}">${g.away}${bb(g.away)} @ ${g.home}${bb(g.home)}${tail}</button>`;
    }).join("") || `<span class="dim">No games on this date.</span>`;
    $("gameList").querySelectorAll("button").forEach((b) => (b.onclick = () => selectGame(model.schedule.find((g) => g.id === b.dataset.id))));
  }
  const REST_LBL = { b2b: "B2B", "1": "1 day", "2+": "2+ days" };
  function restCat(team, date) { // days off before a game on `date`, from the schedule
    if (!date) return "1";
    let prev = null;
    for (const g of model.schedule) if ((g.home === team || g.away === team) && g.date < date && (!prev || g.date > prev)) prev = g.date;
    if (!prev) return "1";
    const days = Math.round((Date.parse(date) - Date.parse(prev)) / 864e5) - 1;
    return days <= 0 ? "b2b" : days === 1 ? "1" : "2+";
  }
  function schedFor(a, h) {
    const d = $("dateSel").value;
    return model.schedule.find((g) => g.away === a && g.home === h && g.date === d) ||
      model.schedule.find((g) => g.away === a && g.home === h && g.home_score == null) || null;
  }
  function selectGame(g, s) {
    if (!g || !model.teams[g.away] || !model.teams[g.home]) return;
    cur = { away: g.away, home: g.home };
    $("awaySel").value = g.away; $("homeSel").value = g.home;
    $("neutralChk").checked = !!g.neutral;
    outSet = new Set(NBASim.defaultOut(model, [g.away, g.home]));
    minutes = {};
    document.documentElement.style.setProperty("--away", col(g.away));
    document.documentElement.style.setProperty("--home", col(g.home));
    const sg = schedFor(g.away, g.home);
    $("mSpread").value = sg && sg.home_spread != null ? sg.home_spread : "";
    $("mTotal").value = sg && sg.total != null ? sg.total : "";
    $("mktNote").textContent = sg && sg.home_spread != null ? "closing lines" : "";
    $("spreadLbl").textContent = `${g.home} spread`;
    $("restAwayLbl").textContent = g.away; $("restHomeLbl").textContent = g.home;
    $("restAway").value = restCat(g.away, sg ? sg.date : g.date);
    $("restHome").value = restCat(g.home, sg ? sg.date : g.date);
    renderGames(); renderRoster();
    projStale = true; projResult = null;
    $("projOut").classList.add("hidden"); $("runInfo").textContent = "";
    newGame(s || randSeed());
    if (activeTab() === "proj") runProjections();
  }
  const randSeed = () => Math.floor(Math.random() * 1e9);

  // ---------------- tabs ----------------
  const activeTab = () => (document.querySelector(".tab.active") || {}).dataset.tab;
  function initTabs() {
    document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
      document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "tab-" + t.dataset.tab));
      if (t.dataset.tab === "proj" && projStale) runProjections();
    }));
  }

  // ---------------- watch ----------------
  function initControls() {
    $("btnPlay").onclick = () => (playing ? pause() : play());
    $("btnStep").onclick = () => { pause(); step(); };
    $("btnQtr").onclick = () => {
      pause();
      const q = idx >= 0 ? game.events[idx].q : 1;
      let j = idx + 1;
      while (j < game.events.length - 1 && !(game.events[j].kind === "endq" && game.events[j].q >= q)) j++;
      idx = j; show(idx, false);
      if (idx >= game.events.length - 1) showFinal();
    };
    $("btnEnd").onclick = () => { pause(); idx = game.events.length - 1; show(idx, false); showFinal(); };
    $("btnNew").onclick = () => newGame(randSeed());
    $("speedSel").onchange = () => (speed = +$("speedSel").value);
    $("btnShare").onclick = () => {
      const url = location.href.split("#")[0] + `#${cur.away}@${cur.home}/${seed}`;
      navigator.clipboard && navigator.clipboard.writeText(url);
      $("btnShare").textContent = "Copied"; setTimeout(() => ($("btnShare").textContent = "Copy link"), 1200);
    };
    $("btnRun").onclick = runProjections;
    $("statSel").onchange = $("teamFilter").onchange = renderProps;
    $("mSpread").onchange = $("mTotal").onchange = () => { $("mktNote").textContent = ""; if (projResult) renderProjections(); };
    $("btnCsv").onclick = downloadCsv;
  }
  function fromHash() {
    const m = location.hash.match(/^#([A-Z]{2,4})@([A-Z]{2,4})(?:\/(\d+))?/);
    if (!m || !model.teams[m[1]] || !model.teams[m[2]]) return false;
    const g = model.schedule.find((x) => x.away === m[1] && x.home === m[2] && x.home_score == null);
    if (g) $("dateSel").value = g.date;
    selectGame(g || { away: m[1], home: m[2] }, m[3] ? +m[3] : undefined);
    return true;
  }

  function simOpts(extra) {
    return Object.assign({ away: cur.away, home: cur.home, out: [...outSet], minutes, neutral: $("neutralChk").checked,
      rest: { away: $("restAway").value, home: $("restHome").value } }, extra);
  }
  function newGame(s) {
    pause();
    seed = s;
    $("seedLbl").textContent = seed;
    game = NBASim.simulateGame(model, simOpts({ seed, log: true }));
    // elapsed game seconds for every event (for the flow chart)
    for (const e of game.events) e.el = e.q <= 4 ? (e.q - 1) * 720 + (720 - e.t) : 2880 + (e.q - 5) * 300 + (300 - e.t);
    game.len = 2880 + game.ot * 300;
    idx = -1;
    $("finalBox").classList.add("hidden");
    drawCourtBase();
    resetBoard();
    $("btnPlay").textContent = "▶ Play";
  }

  function resetBoard() {
    setRow("rowAway", cur.away, 0); setRow("rowHome", cur.home, 0);
    $("rowAway").classList.remove("has-ball", "trail"); $("rowHome").classList.remove("has-ball", "trail");
    $("qtr").textContent = "1ST"; $("clock").textContent = "12:00";
    $("lead").textContent = "TIP-OFF"; $("run").textContent = ""; $("poss").textContent = "";
    $("restTag").textContent = [[cur.away, $("restAway").value], [cur.home, $("restHome").value]].filter((x) => x[1] === "b2b").map((x) => `${x[0]} B2B`).join(" · ");
    $("pType").textContent = ""; $("pType").className = "ptype mono";
    const ta = model.teams[cur.away], th = model.teams[cur.home];
    $("pDesc").textContent = `${ta.name} (${ta.record}) at ${th.name} (${th.record}). Press play to start.`;
    $("playerBadge").textContent = ""; $("playerBadge").style.visibility = "hidden"; $("possBox").textContent = "PLAY –";
    renderOnCourt(game.events[0], liveBox(-1));
    renderLine(-1);
    drawFlow(-1);
  }
  function setRow(id, abbr, pts) {
    const r = $(id);
    r.querySelector(".abbr").textContent = abbr;
    r.querySelector(".pts").textContent = pts;
    r.querySelector(".bar").style.background = col(abbr);
  }

  function play() {
    if (!game) return;
    if (idx >= game.events.length - 1) newGame(seed);
    playing = true; $("btnPlay").textContent = "❚❚ Pause";
    tick();
  }
  function pause() { playing = false; clearTimeout(timer); $("btnPlay").textContent = "▶ Play"; }
  function tick() {
    if (!playing) return;
    if (!step()) { pause(); return; }
    const e = game.events[idx];
    const big = (e.kind === "3" && e.made) || e.dunk && e.made || e.kind === "endq" || e.and1 || e.blk || e.stl;
    timer = setTimeout(tick, (big ? 1900 : 1150) / speed);
  }
  function step() {
    if (idx >= game.events.length - 1) { showFinal(); return false; }
    idx++;
    show(idx, true);
    if (idx === game.events.length - 1) setTimeout(showFinal, 700 / speed);
    return true;
  }

  const ordinal = (n) => ["", "1ST", "2ND", "3RD", "4TH"][n] || n + "TH";
  const qName = (q) => (q <= 4 ? ordinal(q) : q === 5 ? "OT" : `${q - 4}OT`);
  function clockStr(t) {
    if (t < 60 && t > 0) return t.toFixed(1);
    const s = Math.ceil(t - 1e-6);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  const nm = (id) => (players[id] ? players[id].short : "?");
  const teamOf = (side) => (side === 0 ? cur.away : cur.home);

  function describe(e) {
    const p = nm(e.pid);
    if (e.kind === "tip") return { label: "TIP-OFF", cls: "big", desc: `${teamOf(e.side)} win the opening tip.` };
    if (e.kind === "endq") {
      const fin = e.q >= 4 && e.score[0] !== e.score[1];
      return { label: fin ? "FINAL" : `END OF ${qName(e.q)}`, cls: "big", desc: `${cur.away} ${e.score[0]} – ${cur.home} ${e.score[1]}` };
    }
    let desc = "", label = "", cls = "";
    const rebTxt = () => {
      if (!e.reb) return "";
      if (!e.reb.who) return ` ${teamOf(e.reb.side)} team rebound.`;
      return ` ${e.reb.off ? "Offensive" : "Defensive"} rebound ${nm(e.reb.who)}.`;
    };
    if (e.kind === "to") {
      label = e.stl ? "STEAL" : "TURNOVER"; cls = "to";
      desc = e.stl ? `${nm(e.stl)} steals it from ${p}.` : `${p} turnover (${["bad pass", "lost ball", "travel", "offensive foul", "out of bounds"][Math.floor(((+e.t * 7) % 5))]}).`;
    } else if (e.kind === "ft" || e.kind === "foul") {
      label = `FREE THROWS ${e.ftm}/${e.fta}`; cls = e.ftm === e.fta ? "made" : "miss";
      desc = `${e.kind === "foul" ? "Intentional foul" : "Shooting foul"} on ${nm(e.by)}. ${p} makes ${e.ftm} of ${e.fta}.` + rebTxt();
    } else {
      const three = e.kind === "3";
      let shot;
      if (three) shot = e.dist >= 30 ? `${e.dist}-ft deep three` : Math.abs(e.y) > 21.5 && e.x < 9 ? "corner three" : `${e.dist}-ft ${e.style < 0.4 ? "pullup three" : e.style < 0.55 ? "step-back three" : "three"}`;
      else if (e.zone === "rim") shot = e.dunk ? (e.putback ? "putback dunk" : e.style < 0.3 ? "alley-oop dunk" : "dunk") : e.putback ? "putback layup" : e.style < 0.45 ? "driving layup" : e.style < 0.65 ? "layup" : e.style < 0.85 ? "finger roll" : "tip shot";
      else shot = `${e.dist}-ft ${e.style < 0.35 ? "pullup jumper" : e.style < 0.55 ? "floater" : e.style < 0.7 ? "turnaround jumper" : e.style < 0.85 ? "step-back jumper" : "hook shot"}`;
      if (e.made) {
        label = (three ? "3-POINTER" : e.dunk ? "DUNK" : "2-POINTER") + (e.and1 ? " · AND-ONE" : "");
        cls = three || e.dunk || e.and1 ? "big" : "made";
        desc = `${p} ${shot}` + (e.def ? ` over ${nm(e.def)}` : "") + (e.ast ? ` (assist ${nm(e.ast)})` : "") + ".";
        if (e.and1) desc += ` Fouled by ${nm(e.by)} — ${e.ftm ? "makes" : "misses"} the free throw.` + (e.ftm ? "" : rebTxt());
      } else {
        label = e.blk ? "BLOCKED" : three ? "MISSED 3" : "MISSED 2"; cls = e.blk ? "to" : "miss";
        desc = e.blk ? `${nm(e.blk)} blocks ${p}'s ${shot}.` : `${p} misses a ${shot}` + (e.def ? `, ${nm(e.def)} defending.` : ".");
        desc += rebTxt();
      }
    }
    return { label, cls, desc };
  }

  function liveBox(i) {
    const b = {};
    const g = (id) => b[id] || (b[id] = { pts: 0, reb: 0, ast: 0 });
    for (let k = 0; k <= i; k++) {
      const e = game.events[k];
      if (e.kind === "2" || e.kind === "3") { if (e.made) g(e.pid).pts += +e.kind; if (e.ast) g(e.ast).ast++; }
      if (e.ftm) g(e.pid).pts += e.ftm;
      if (e.reb && e.reb.who) g(e.reb.who).reb++;
    }
    return b;
  }
  function scoringRun(i) {
    let a = 0, h = 0;
    for (let k = i; k >= 0; k--) {
      const e = game.events[k], prev = k > 0 ? game.events[k - 1].score : [0, 0];
      const da = e.score[0] - prev[0], dh = e.score[1] - prev[1];
      if (da && h || dh && a) break;
      a += da; h += dh;
    }
    if (a >= 7) return `${cur.away} ${a}-0 RUN`;
    if (h >= 7) return `${cur.home} ${h}-0 RUN`;
    return "";
  }

  function show(i, animate) {
    const e = game.events[i];
    const sc = e.score;
    setRow("rowAway", cur.away, sc[0]); setRow("rowHome", cur.home, sc[1]);
    const ballSide = e.kind === "endq" ? -1 : e.side;
    $("rowAway").classList.toggle("has-ball", ballSide === 0);
    $("rowHome").classList.toggle("has-ball", ballSide === 1);
    $("rowAway").classList.toggle("trail", sc[0] < sc[1]);
    $("rowHome").classList.toggle("trail", sc[1] < sc[0]);
    $("qtr").textContent = qName(e.q); $("clock").textContent = clockStr(e.t);
    const diff = sc[0] - sc[1];
    $("lead").textContent = diff === 0 ? "TIED" : `${diff > 0 ? cur.away : cur.home} +${Math.abs(diff)}`;
    $("run").textContent = scoringRun(i);
    $("poss").innerHTML = ballSide >= 0 ? `<span style="color:${col(teamOf(ballSide))}">●</span> ${teamOf(ballSide)} BALL` : "";
    const d = describe(e);
    $("pType").textContent = d.label; $("pType").className = "ptype mono " + d.cls;
    $("pDesc").textContent = d.desc;
    const who = e.kind === "to" && e.stl ? e.stl : e.blk ? e.blk : e.pid;
    const wteam = who ? players[who] && players[who].team : teamOf(e.side);
    const initials = who && players[who] ? players[who].name.split(/[ .'-]+/).filter(Boolean).map((s) => s[0]).join("").slice(0, 3) : (wteam || "").slice(0, 3);
    $("playerBadge").textContent = e.kind === "endq" ? "" : initials;
    $("playerBadge").style.visibility = e.kind === "endq" ? "hidden" : "";
    $("playerBadge").style.borderColor = wteam ? col(wteam) : "";
    $("playerBadge").style.color = wteam ? col(wteam) : "";
    $("possBox").textContent = `PLAY ${i + 1} / ${game.events.length}\n${qName(e.q)} QUARTER · ${clockStr(e.t)} LEFT`;
    renderOnCourt(e, liveBox(i), e.pid);
    renderLine(i);
    drawFlow(i);
    drawEvent(i, animate);
  }

  function renderOnCourt(e, lb, act) {
    if (!e || !e.on) { $("onCourt").innerHTML = ""; return; }
    const block = (s) => `<h5 style="color:${col(teamOf(s))}">${teamOf(s)} ON COURT</h5><div class="hd"><span></span><span>PTS</span><span>REB</span><span>AST</span></div>` +
      e.on[s].map((id) => { const b = lb[id] || { pts: 0, reb: 0, ast: 0 }; return `<div class="${id === act ? "act" : ""}"><span>${nm(id)}</span><span>${b.pts}</span><span>${b.reb}</span><span>${b.ast}</span></div>`; }).join("");
    $("onCourt").innerHTML = block(0) + block(1);
  }

  function renderLine(i) {
    const q = { away: [], home: [] };
    let prev = [0, 0], lastQ = 1;
    for (let k = 0; k <= i && k < game.events.length; k++) {
      const e = game.events[k], qi = e.q - 1;
      q.away[qi] = (q.away[qi] || 0) + e.score[0] - prev[0];
      q.home[qi] = (q.home[qi] || 0) + e.score[1] - prev[1];
      prev = e.score; lastQ = e.q;
    }
    const nq = Math.max(4, i >= 0 ? lastQ : 1);
    const heads = []; for (let k = 1; k <= nq; k++) heads.push(k <= 4 ? k : k === 5 ? "OT" : `${k - 4}OT`);
    const head = `<tr><th></th>${heads.map((x) => `<th>${x}</th>`).join("")}<th>T</th></tr>`;
    const row = (s, t) => `<tr><td style="color:${col(t)}">${t}</td>${heads.map((_, k) => `<td>${k + 1 <= lastQ && i >= 0 ? q[s][k] || 0 : "-"}</td>`).join("")}<td><b>${prev[s === "away" ? 0 : 1]}</b></td></tr>`;
    $("lineScore").innerHTML = head + row("away", cur.away) + row("home", cur.home);
  }

  // ---------------- court ----------------
  const S = 10; // px per foot
  function drawCourtBase() {
    const svg = $("court");
    const L = (x1, y1, x2, y2) => `<line x1="${x1 * S}" y1="${y1 * S}" x2="${x2 * S}" y2="${y2 * S}"/>`;
    let h = `<defs><linearGradient id="wood" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#3a2614"/><stop offset=".5" stop-color="#46301a"/><stop offset="1" stop-color="#3a2614"/></linearGradient>
      <pattern id="planks" width="940" height="20" patternUnits="userSpaceOnUse"><rect width="940" height="20" fill="url(#wood)"/><line x1="0" y1="19.5" x2="940" y2="19.5" stroke="#000" stroke-opacity=".18"/></pattern></defs>`;
    h += `<rect x="0" y="0" width="940" height="500" fill="url(#planks)"/>`;
    // paint, tinted by the team attacking that basket in the first half (away attacks right)
    h += `<rect x="0" y="${17 * S}" width="${19 * S}" height="${16 * S}" fill="${col(cur.home)}" opacity=".28"/>`;
    h += `<rect x="${75 * S}" y="${17 * S}" width="${19 * S}" height="${16 * S}" fill="${col(cur.away)}" opacity=".28"/>`;
    h += `<circle cx="470" cy="250" r="${6 * S}" fill="${col(cur.home)}" opacity=".18"/>`;
    h += `<g stroke="#f3e9dc" stroke-opacity=".55" stroke-width="2" fill="none">`;
    h += `<rect x="1" y="1" width="938" height="498"/>` + L(47, 0, 47, 50);
    h += `<circle cx="470" cy="250" r="${6 * S}"/><circle cx="470" cy="250" r="${2 * S}"/>`;
    for (const side of [0, 1]) {
      const bx = side ? 88.75 : 5.25, dir = side ? -1 : 1, base = side ? 94 : 0, ft = base + dir * 19;
      h += `<rect x="${Math.min(base, ft) * S}" y="${17 * S}" width="${19 * S}" height="${16 * S}"/>`;
      h += `<path d="M ${ft * S} ${19 * S} A ${6 * S} ${6 * S} 0 0 ${side ? 0 : 1} ${ft * S} ${31 * S}"/>`;
      h += `<path d="M ${ft * S} ${19 * S} A ${6 * S} ${6 * S} 0 0 ${side ? 1 : 0} ${ft * S} ${31 * S}" stroke-dasharray="6 6"/>`;
      const cx = base + dir * 14; // three-point line: corners then arc
      h += L(base, 3, cx, 3) + L(base, 47, cx, 47);
      h += `<path d="M ${cx * S} ${3 * S} A ${23.75 * S} ${23.75 * S} 0 0 ${side ? 0 : 1} ${cx * S} ${47 * S}"/>`;
      h += `<path d="M ${(bx) * S} ${21 * S} A ${4 * S} ${4 * S} 0 0 ${side ? 0 : 1} ${bx * S} ${29 * S}" stroke-opacity=".35"/>`;
      h += L(base + dir * 4, 22, base + dir * 4, 28);
    }
    h += `</g>`;
    for (const side of [0, 1]) {
      const bx = side ? 88.75 : 5.25;
      h += `<circle cx="${bx * S}" cy="250" r="${0.75 * S}" fill="none" stroke="#ff7a2f" stroke-width="3"/>`;
    }
    h += `<text x="470" y="262" fill="#f3e9dc" opacity=".35" font-family="monospace" font-size="34" font-weight="700" text-anchor="middle">${cur.home}</text>`;
    h += `<g id="shots"></g><g id="dyn"></g>`;
    svg.innerHTML = h;
  }
  const attacksRight = (side, q) => (side === 0) === (q <= 2);
  function spot(e) { // event -> court px
    const right = attacksRight(e.side, e.q);
    let x, y;
    if (e.kind === "ft" || e.kind === "foul") { x = 15; y = 0; }
    else if (e.kind === "to") { x = 18 + ((e.t * 13) % 22); y = ((e.t * 31) % 36) - 18; }
    else { x = e.x; y = e.y; }
    const cx = right ? 88.75 - x : 5.25 + x;
    return [cx * S, (25 + (right ? y : -y)) * S, right];
  }
  function marker(e) {
    if (e.kind !== "2" && e.kind !== "3") return "";
    const [x, y] = spot(e), c = col(teamOf(e.side));
    return e.made
      ? `<circle cx="${x}" cy="${y}" r="7" fill="${c}" stroke="#0b0f14" stroke-width="1.5" opacity=".9"/>`
      : `<g stroke="${c}" stroke-width="2.5" opacity=".75"><line x1="${x - 5}" y1="${y - 5}" x2="${x + 5}" y2="${y + 5}"/><line x1="${x - 5}" y1="${y + 5}" x2="${x + 5}" y2="${y - 5}"/></g>`;
  }
  function drawEvent(i, animate) {
    const e = game.events[i];
    // shot chart for the current quarter
    let sh = "";
    for (let k = 0; k < i; k++) if (game.events[k].q === e.q) sh += marker(game.events[k]);
    $("shots").innerHTML = sh;
    const g = $("dyn");
    if (e.kind === "tip" || e.kind === "endq") {
      g.innerHTML = e.kind === "tip" ? `<circle cx="470" cy="250" r="9" fill="#ff8a3d" stroke="#5a2a0a" stroke-width="2"/>` : "";
      if (e.kind === "endq") $("shots").innerHTML = sh + marker(e);
      return;
    }
    const [x, y, right] = spot(e);
    const hx = (right ? 88.75 : 5.25) * S, hy = 250;
    const c = col(teamOf(e.side));
    let h = "";
    const label = nm(e.pid);
    if (e.kind === "to") {
      h += `<g stroke="#ef5b5b" stroke-width="4"><line x1="${x - 10}" y1="${y - 10}" x2="${x + 10}" y2="${y + 10}"/><line x1="${x - 10}" y1="${y + 10}" x2="${x + 10}" y2="${y - 10}"/></g>`;
      h += `<text x="${x}" y="${y - 16}" fill="#fff" font-family="monospace" font-size="15" text-anchor="middle">${e.stl ? nm(e.stl) + " STEAL" : label}</text>`;
      g.innerHTML = h;
      return;
    }
    const apex = Math.min(y, hy) - (e.kind === "3" ? 90 : e.zone === "rim" ? 25 : 60);
    h += `<circle cx="${x}" cy="${y}" r="11" fill="none" stroke="${c}" stroke-width="2.5"/>`;
    h += `<text x="${x}" y="${y > 60 ? y - 18 : y + 30}" fill="#fff" font-family="monospace" font-size="15" font-weight="700" text-anchor="middle" paint-order="stroke" stroke="#000" stroke-width="3">${label}</text>`;
    h += `<path id="trail" d="M ${x} ${y} Q ${(x + hx) / 2} ${apex} ${hx} ${hy}" stroke="#fff" stroke-opacity=".35" stroke-width="2" fill="none" stroke-dasharray="4 5"/>`;
    const madeShot = (e.kind === "2" || e.kind === "3") ? e.made : e.ftm > 0;
    if (madeShot) h += `<circle id="flash" cx="${hx}" cy="${hy}" r="10" fill="none" stroke="${e.kind === "3" || e.dunk ? "#ff8a3d" : "#3ecf8e"}" stroke-width="4" opacity="0"/>`;
    h += `<g id="ball"><circle r="8" fill="#ff8a3d" stroke="#5a2a0a" stroke-width="2"/></g>`;
    g.innerHTML = h;
    const ball = $("ball"), path = $("trail"), flash = $("flash");
    const len = path.getTotalLength();
    const dur = animate ? 700 / speed : 0;
    const t0 = performance.now();
    const bounce = !madeShot ? [(Math.random() - 0.5) * 120, (Math.random() - 0.5) * 140] : null;
    function frame(t) {
      const k = dur ? Math.min(1, (t - t0) / dur) : 1;
      const ee = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const pt = path.getPointAtLength(len * ee);
      ball.setAttribute("transform", `translate(${pt.x},${pt.y})`);
      if (k < 1) requestAnimationFrame(frame);
      else if (flash) { flash.setAttribute("opacity", "1"); flash.setAttribute("r", "22"); }
      else if (bounce) ball.setAttribute("transform", `translate(${hx + (right ? -1 : 1) * Math.abs(bounce[0]) * 0.6},${hy + bounce[1]})`);
    }
    requestAnimationFrame(frame);
  }

  // ---------------- game flow ----------------
  function drawFlow(i) {
    const W = 1000, H = 70, mid = H / 2, len = game.len;
    let maxAbs = 10;
    for (const e of game.events) maxAbs = Math.max(maxAbs, Math.abs(e.score[0] - e.score[1]));
    const X = (el) => (el / len) * W, Y = (m) => mid - (m / maxAbs) * (mid - 6);
    let h = "";
    for (let q = 1; q * 720 < len; q++) { const xq = q <= 4 ? X(q * 720) : X(2880 + (q - 4) * 300); if (xq < W) h += `<line x1="${xq}" x2="${xq}" y1="0" y2="${H}" stroke="#1d2a38"/>`; }
    h += `<line x1="0" x2="${W}" y1="${mid}" y2="${mid}" stroke="#2a3a4c"/>`;
    h += `<text x="6" y="13" fill="${col(cur.away)}" font-family="monospace" font-size="11">${cur.away} LEADS</text><text x="6" y="${H - 5}" fill="${col(cur.home)}" font-family="monospace" font-size="11">${cur.home} LEADS</text>`;
    if (i >= 0) {
      let pts = `0,${mid}`;
      for (let k = 0; k <= i; k++) { const e = game.events[k]; pts += ` ${X(e.el).toFixed(1)},${Y(e.score[0] - e.score[1]).toFixed(1)}`; }
      const lastX = X(game.events[i].el);
      h += `<clipPath id="ca"><rect x="0" y="0" width="${W}" height="${mid}"/></clipPath><clipPath id="ch"><rect x="0" y="${mid}" width="${W}" height="${mid}"/></clipPath>`;
      h += `<polygon points="${pts} ${lastX},${mid}" fill="${col(cur.away)}" opacity=".35" clip-path="url(#ca)"/>`;
      h += `<polygon points="${pts} ${lastX},${mid}" fill="${col(cur.home)}" opacity=".35" clip-path="url(#ch)"/>`;
      h += `<polyline points="${pts}" fill="none" stroke="#e8eef5" stroke-width="1.5" stroke-opacity=".8"/>`;
      h += `<circle cx="${lastX}" cy="${Y(game.events[i].score[0] - game.events[i].score[1])}" r="3.5" fill="#ff8a3d"/>`;
    }
    $("flow").innerHTML = h;
  }

  // ---------------- final box ----------------
  function showFinal() {
    if (!game) return;
    const first = game.events[0].on;
    const mmss = (s) => { s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
    const side = (s) => {
      const t = teamOf(s);
      const ps = Object.values(game.box).filter((b) => b.side === s && b.sec > 0);
      const st = first[s];
      ps.sort((a, b) => (st.includes(b.id) - st.includes(a.id)) || b.sec - a.sec);
      const tot = { sec: 0, pts: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fg3m: 0, fg3a: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, pf: 0 };
      const rows = ps.map((b) => {
        for (const k in tot) tot[k] += b[k];
        return `<tr class="${st.includes(b.id) ? "" : "bench"}"><td>${b.name}<span class="pos">${b.pos}</span></td><td>${mmss(b.sec)}</td><td><b>${b.pts}</b></td><td>${b.oreb + b.dreb}</td><td>${b.ast}</td><td>${b.stl}</td><td>${b.blk}</td><td>${b.tov}</td><td>${b.fgm}-${b.fga}</td><td>${b.fg3m}-${b.fg3a}</td><td>${b.ftm}-${b.fta}</td><td>${b.pf}</td><td>${b.pm > 0 ? "+" : ""}${b.pm}</td></tr>`;
      }).join("");
      const pct = (m, a) => (a ? ` (${((m / a) * 100).toFixed(0)}%)` : "");
      return `<h4 style="color:${col(t)}">${model.teams[t].name.toUpperCase()}</h4><table><tr><th>PLAYER</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TO</th><th>FG</th><th>3PT</th><th>FT</th><th>PF</th><th>+/-</th></tr>${rows}
        <tr class="tot"><td>TEAM</td><td></td><td>${tot.pts}</td><td>${tot.oreb + tot.dreb}</td><td>${tot.ast}</td><td>${tot.stl}</td><td>${tot.blk}</td><td>${tot.tov}</td><td>${tot.fgm}-${tot.fga}${pct(tot.fgm, tot.fga)}</td><td>${tot.fg3m}-${tot.fg3a}${pct(tot.fg3m, tot.fg3a)}</td><td>${tot.ftm}-${tot.fta}</td><td>${tot.pf}</td><td></td></tr></table>`;
    };
    $("finalBox").innerHTML = `<h2>FINAL${game.ot ? (game.ot > 1 ? ` / ${game.ot}OT` : " / OT") : ""} · ${cur.away} ${game.score.away} – ${cur.home} ${game.score.home}</h2>
      <div class="boxgrid"><div>${side(0)}</div><div>${side(1)}</div></div>`;
    $("finalBox").classList.remove("hidden");
  }

  // ---------------- projections ----------------
  function runProjections() {
    if (!model) return;
    const n = +$("nSel").value;
    const opts = simOpts({ seed: 12345 });
    $("btnRun").disabled = true; $("prog").style.width = "0%";
    $("runInfo").textContent = `simulating ${n.toLocaleString()} games…`;
    const t0 = performance.now();
    const finish = (res) => {
      projResult = res; projStale = false; $("btnRun").disabled = false; $("prog").style.width = "100%";
      $("runInfo").textContent = `${res.n.toLocaleString()} games in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
      renderProjections();
    };
    try {
      if (!worker) { worker = new Worker("js/worker.js"); worker.postMessage({ model }); }
      worker.onmessage = (e) => {
        if (e.data.progress != null) $("prog").style.width = (e.data.progress * 100).toFixed(0) + "%";
        if (e.data.done) finish(e.data.result);
      };
      worker.postMessage({ run: true, opts, n });
    } catch (err) { // no workers (e.g. file://): run on the main thread
      setTimeout(() => finish(NBASim.summarize(NBASim.simulateMany(model, opts, n))), 30);
    }
  }

  const pct = (x) => (x * 100).toFixed(1) + "%";
  function american(p) {
    if (p <= 0 || p >= 1) return "–";
    return p >= 0.5 ? String(Math.round((-100 * p) / (1 - p))) : "+" + Math.round((100 * (1 - p)) / p);
  }
  const quant = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))];
  const meanOf = (arr) => { let s = 0; for (const x of arr) s += x; return s / arr.length; };
  function pOver(sorted, line) { // P(x > line)
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= line) lo = m + 1; else hi = m; }
    return (sorted.length - lo) / sorted.length;
  }
  function pUnder(sorted, line) { // P(x < line)
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < line) lo = m + 1; else hi = m; }
    return lo / sorted.length;
  }
  const num = (v) => (v === "" || v == null || isNaN(+v) ? null : +v);

  function renderProjections() {
    const r = projResult, n = r.n, A = cur.away, H = cur.home;
    const margin = Array.from(r.home, (h, i) => h - r.away[i]);
    const total = Array.from(r.home, (h, i) => h + r.away[i]);
    const total1h = Array.from(r.home1h, (h, i) => h + r.away1h[i]);
    const pH = r.wins.home / n, pA = 1 - pH;
    const sortedTotal = [...total].sort((a, b) => a - b);
    const sortedMargin = [...margin].sort((a, b) => a - b);
    const cards = [
      [`${A} win`, pct(pA), `fair ${american(pA)}`],
      [`${H} win`, pct(pH), `fair ${american(pH)}`],
      ["Avg score", `${meanOf(r.away).toFixed(1)}–${meanOf(r.home).toFixed(1)}`, `${A}–${H}`],
      ["Fair spread", `${H} ${fmtLine(-quant(sortedMargin, 0.5))}`, `mean margin ${meanOf(margin) > 0 ? H : A} by ${Math.abs(meanOf(margin)).toFixed(1)}`],
      ["Avg total", meanOf(total).toFixed(1), `median ${quant(sortedTotal, 0.5)} · 1H ${meanOf(total1h).toFixed(1)}`],
      ["Overtime", pct(r.ot / n), `${r.ot.toLocaleString()} of ${n.toLocaleString()} games`],
    ];
    const rA = $("restAway").value, rH = $("restHome").value;
    if (rA !== "1" || rH !== "1") {
      const R = model.league.rest || {}, edge = (R[rH] || 0) - (R[rA] || 0);
      cards.push(["Rest", `${REST_LBL[rA]} / ${REST_LBL[rH]}`, `${A} / ${H} · worth ${edge >= 0 ? H : A} ~${Math.abs(edge).toFixed(1)} pts (built in)`]);
    }
    const sp = num($("mSpread").value), tl = num($("mTotal").value);
    if (sp != null) {
      const cover = margin.filter((m) => m + sp > 0).length / n, push = margin.filter((m) => m + sp === 0).length / n;
      cards.push([`${H} ${fmtLine(sp)}`, pct(cover), `cover · ${A} ${fmtLine(-sp)} ${pct(1 - cover - push)}${push ? ` · push ${pct(push)}` : ""}`]);
    }
    if (tl != null) {
      const o = total.filter((t) => t > tl).length / n, u = total.filter((t) => t < tl).length / n;
      cards.push([`Over ${tl}`, pct(o), `under ${pct(u)} · fair over ${american(o)}`]);
    }
    $("gameCards").innerHTML = cards.map(([k, v, s]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("");
    $("marginTitle").textContent = `${H} margin distribution`;
    const mc = Math.round(meanOf(margin)), tc = Math.round(meanOf(total));
    hist($("marginChart"), margin, mc - 36, mc + 36, 1, sp != null ? -sp : null, 6, sp != null ? `${H} ${fmtLine(sp)}` : "");
    hist($("totalChart"), total, tc - 56, tc + 56, 2, tl, 10, tl != null ? `o/u ${tl}` : "");
    $("teamFilter").innerHTML = `<option value="">Both</option><option>${A}</option><option>${H}</option>`;
    $("projOut").classList.remove("hidden");
    renderProps();
  }
  const fmtLine = (x) => (x > 0 ? "+" + x : x === 0 ? "PK" : String(x));

  function hist(svg, data, lo, hi, bw0, mark, tickEvery, markLabel) {
    const W = 600, Hh = 200, pad = 22, bins = Math.ceil((hi - lo + 1) / bw0), counts = new Array(bins).fill(0);
    for (const x of data) if (x >= lo && x <= hi) counts[Math.floor((x - lo) / bw0)]++;
    const max = Math.max(...counts, 1), bw = (W - 2 * pad) / bins;
    let h = "";
    counts.forEach((c, i) => {
      const bh = (c / max) * (Hh - 2 * pad), x = pad + i * bw;
      const v = lo + i * bw0;
      const color = mark != null && v > mark ? "#3ecf8e" : "#4aa3ff";
      h += `<rect x="${x + 0.5}" y="${Hh - pad - bh}" width="${Math.max(1, bw - 1)}" height="${bh}" fill="${color}" opacity=".8"><title>${bw0 > 1 ? `${v}–${v + bw0 - 1}` : v}: ${(c / data.length * 100).toFixed(1)}%</title></rect>`;
    });
    for (let v = Math.ceil(lo / tickEvery) * tickEvery; v <= hi; v += tickEvery) h += `<text x="${pad + ((v - lo) / bw0 + 0.5) * bw}" y="${Hh - 5}" fill="#7d8ea1" font-size="11" font-family="monospace" text-anchor="middle">${v}</text>`;
    if (mark != null) {
      const x = pad + ((mark - lo) / bw0 + 0.5) * bw;
      h += `<line x1="${x}" x2="${x}" y1="${pad - 6}" y2="${Hh - pad}" stroke="#ff8a3d" stroke-dasharray="3 3"/><text x="${x + 4}" y="${pad}" fill="#ff8a3d" font-size="11" font-family="monospace">${markLabel}</text>`;
    }
    svg.innerHTML = h;
  }

  const MIN_MEAN = { pts: 2, reb: 1, ast: 0.5, fg3m: 0.2, pra: 3, pr: 3, pa: 2, ra: 1.5, stl: 0.2, blk: 0.15, stocks: 0.4, tov: 0.3, min: 4, dd: 0.004, td: 0.0005 };
  function propRows(k, tf) {
    return Object.values(projResult.players).filter((p) => !tf || p.team === tf)
      .map((p) => ({ p, d: p.d[k], m: meanOf(p.d[k]), min: meanOf(p.d.min) }))
      .filter((x) => x.min >= 3 && x.m >= MIN_MEAN[k]).sort((a, b) => b.m - a.m);
  }
  function renderProps() {
    if (!projResult) return;
    const k = $("statSel").value, tf = $("teamFilter").value;
    const rows = propRows(k, tf);
    const nameCell = (p) => `<td>${p.name}<span class="pos">${p.pos}</span></td><td><span class="teamtag" style="background:${col(p.team)}"></span>${p.team}</td>`;
    if (k === "dd" || k === "td") {
      $("propTable").innerHTML = `<tr><th>Player</th><th>Team</th><th>Avg min</th><th>Probability</th><th>Fair yes</th><th>Fair no</th></tr>` +
        rows.map(({ p, m, min }) => `<tr>${nameCell(p)}<td>${min.toFixed(1)}</td><td>${pct(m)}</td><td>${american(m)}</td><td>${american(1 - m)}</td></tr>`).join("");
      return;
    }
    $("propTable").innerHTML = `<tr><th>Player</th><th>Team</th><th>Avg min</th><th>Mean</th><th>Median</th><th>10th–90th</th><th>Line</th><th>Over</th><th>Under</th><th>Fair over</th><th>Fair under</th></tr>` +
      rows.map(({ p, d, m, min }) => {
        const key = p.id + "|" + k;
        const med = quant(d, 0.5);
        const user = lines[key] != null;
        const line = user ? lines[key] : Math.floor(m) + 0.5;
        const o = pOver(d, line), u = pUnder(d, line);
        const oc = user && o >= 0.56 ? "edge-hi" : "", uc = user && u >= 0.56 ? "edge-lo" : "";
        return `<tr>${nameCell(p)}<td>${min.toFixed(1)}</td><td>${m.toFixed(1)}</td><td>${med}</td><td>${quant(d, 0.1)}–${quant(d, 0.9)}</td>
          <td><input data-key="${key}" type="number" step="0.5" value="${line}"></td>
          <td class="${oc}">${pct(o)}</td><td class="${uc}">${pct(u)}</td><td>${american(o)}</td><td>${american(u)}</td></tr>`;
      }).join("");
    $("propTable").querySelectorAll("input").forEach((inp) => (inp.onchange = () => {
      if (inp.value === "") delete lines[inp.dataset.key]; else lines[inp.dataset.key] = +inp.value;
      renderProps();
    }));
  }
  function downloadCsv() {
    if (!projResult) return;
    const stats = ["pts", "reb", "ast", "fg3m", "pra", "pr", "pa", "ra", "stl", "blk", "stocks", "tov", "min", "dd", "td"];
    const out = [["game", "player", "team", "stat", "mean", "median", "p10", "p90", "line", "over", "under", "fair_over", "fair_under"].join(",")];
    for (const k of stats) for (const { p, d, m } of propRows(k, "")) {
      const yn = k === "dd" || k === "td";
      const line = yn ? 0.5 : lines[p.id + "|" + k] != null ? lines[p.id + "|" + k] : Math.floor(m) + 0.5;
      const o = pOver(d, line), u = pUnder(d, line);
      out.push([`${cur.away}@${cur.home}`, `"${p.name}"`, p.team, k, m.toFixed(3), quant(d, 0.5), quant(d, 0.1), quant(d, 0.9), line, o.toFixed(4), u.toFixed(4), american(o), american(u)].join(","));
    }
    const blob = new Blob([out.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `hardwood-sim_${cur.away}-at-${cur.home}_${projResult.n}sims.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------------- roster ----------------
  function renderRoster() {
    $("injNote").textContent = (model.injury_source === "espn"
      ? "Players listed Out on ESPN's injury report, or not with the team for its last 3 games, start unchecked. "
      : "The injury report couldn't be loaded for this build, so players who missed their team's last game start unchecked. ") +
      "Toggle anyone in or out, or type projected minutes to override the model (blank = model). Everyone else's minutes and shots re-balance. DEF is each player's defensive rating (points per 100 possessions saved, from play-by-play): it shapes the lineup's defense and who guards whom. Changes apply to both tabs.";
    const block = (t) => {
      const T = model.teams[t];
      const tgt = NBASim.minuteTargets(T.players.filter((p) => !outSet.has(p.id)), minutes);
      const tmap = {}; T.players.filter((p) => !outSet.has(p.id)).forEach((p, i) => (tmap[p.id] = tgt[i]));
      const avg = (v) => (v == null ? "–" : v);
      return `<div class="team"><h3 style="color:${col(t)}">${T.name} <span class="dim">${T.record}</span></h3><div class="hdr"><span></span><span>Player</span><span>Status</span><span>Proj min</span><span>PTS</span><span>REB</span><span>AST</span><span title="Defensive rating: points per 100 possessions the opponent scores less with him on the floor (adjusted plus-minus from play-by-play)">DEF</span></div>` +
        T.players.map((p) => {
          const off = outSet.has(p.id), ov = minutes[p.id] != null;
          const val = off ? "" : ov ? minutes[p.id] : tmap[p.id].toFixed(1);
          return `<label class="${off ? "off" : ""}" title="${(p.inj_note || "").replace(/"/g, "'")}"><input type="checkbox" data-id="${p.id}" ${off ? "" : "checked"}>
          <span>${p.name} <span class="pos">${p.pos}</span></span><span class="st">${p.status || ""}</span>
          <span><input type="number" min="0" max="48" step="1" data-min="${p.id}" class="${ov ? "ovr" : ""}" value="${val}" ${off ? "disabled" : ""}></span>
          <span>${avg(p.avg.pts)}</span><span>${avg(p.avg.reb)}</span><span>${avg(p.avg.ast)}</span>
          <span class="${(p.d || 0) >= 1 ? "dpos" : (p.d || 0) <= -1 ? "dneg" : ""}">${(p.d || 0) > 0 ? "+" : ""}${(p.d || 0).toFixed(1)}</span></label>`;
        }).join("") + "</div>";
    };
    $("rosters").innerHTML = block(cur.away) + block(cur.home);
    $("rosters").querySelectorAll("input[type=checkbox]").forEach((c) => (c.onchange = () => {
      if (c.checked) outSet.delete(c.dataset.id); else { outSet.add(c.dataset.id); delete minutes[c.dataset.id]; }
      changed();
    }));
    $("rosters").querySelectorAll("input[data-min]").forEach((c) => (c.onchange = () => {
      if (c.value === "") delete minutes[c.dataset.min]; else minutes[c.dataset.min] = Math.max(0, Math.min(48, +c.value));
      changed();
    }));
  }
  function changed() {
    projStale = true;
    renderRoster();
    newGame(seed);
  }
})();
