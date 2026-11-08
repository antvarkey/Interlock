/* Interlock engine in JavaScript: legacy interpreter, rewritten controller, plant model,
   predictor, alerts and handoff. Mirrors the Python engine; checked against it in tests. */
const IL = (() => {
  const D = DATA;
  const P = D.plant;
  const ruleById = Object.fromEntries(D.rules.map((r) => [r.id, r]));
  const protectiveIds = new Set(D.rules.filter((r) => r.protective).map((r) => r.id));

  /* ------------------------------------------------------------ legacy interpreter (runs the parsed original code) */
  function ev(e, env) {
    switch (e[0]) {
      case "num": case "bool": return e[1];
      case "var": return env[e[1]];
      case "un": { const v = ev(e[2], env); return e[1] === "NOT" ? !v : -v; }
      default: {
        const l = ev(e[2], env), r = ev(e[3], env);
        switch (e[1]) {
          case "AND": return !!l && !!r; case "OR": return !!l || !!r;
          case "+": return l + r; case "-": return l - r; case "*": return l * r; case "/": return l / r;
          case "=": return l === r; case "<>": return l !== r; case "<": return l < r;
          case ">": return l > r; case "<=": return l <= r; case ">=": return l >= r;
        }
      }
    }
  }
  class LegacyController {
    constructor() { this.reset(); }
    reset() {
      this.env = {};
      for (const d of D.decls) this.env[d.name] = d.init !== null ? d.init : d.type === "BOOL" ? false : 0;
    }
    run(stmts, fired) {
      for (const s of stmts) {
        if (s.t === "assign") {
          const v = ev(s.expr, this.env);
          this.env[s.name] = v;
          const rid = D.hooks[s.line];
          if (rid && v === true) fired.push(rid);
        } else {
          for (const b of s.branches) {
            if (b.cond === null || ev(b.cond, this.env)) {
              const rid = D.hooks[b.line];
              if (rid) fired.push(rid);
              this.run(b.body, fired);
              break;
            }
          }
        }
      }
    }
    step(inputs) {
      for (const d of D.decls) if (d.block === "input") this.env[d.name] = inputs[d.name];
      const fired = [];
      this.run(D.ast, fired);
      return fired;
    }
  }

  /* ------------------------------------------------------------ rewritten controller (port of the generated Python) */
  const newCtrl = (cfg = {}) => ({
    cfg: { tripScans: 20, lockoutS: 300, ...cfg },
    s: { prev: 7.0, rise: 0.0, riseCt: 0, stageCt: 0, lockout: 0, tripped: false, ch2Cmd: false, pumps: true, shed: false, alarm: false },
  });
  function ctrlStep(c, i) {
    const s = c.s, fired = [];
    s.rise = i.temp - s.prev;
    s.prev = i.temp;
    s.riseCt = s.rise > 0.1 ? s.riseCt + 1 : 0;
    s.stageCt = i.ch1 >= 80.0 ? s.stageCt + 1 : 0;
    if (s.riseCt >= c.cfg.tripScans && !s.tripped) {
      fired.push("R1"); s.tripped = true; s.lockout = c.cfg.lockoutS; s.pumps = false; s.ch2Cmd = false;
    }
    if (s.tripped) {
      if (s.lockout > 0) { fired.push("R2"); s.lockout -= 1; }
      else { fired.push("R3"); s.tripped = false; s.pumps = true; }
    }
    if (s.stageCt >= 90 && !s.tripped) { fired.push("R4"); s.ch2Cmd = true; }
    if (i.man && !s.tripped) { fired.push("R5"); s.ch2Cmd = true; }
    s.shed = i.power > 1850.0;
    if (s.shed) fired.push("R6");
    if (i.aux > 0.0) { fired.push("R7"); s.alarm = true; }
    return { out: { ch2Cmd: s.ch2Cmd, pumps: s.pumps, shed: s.shed, alarm: s.alarm }, fired };
  }

  /* ------------------------------------------------------------ plant */
  function jobTarget(profile, t) {
    if (t < P.job_start_s) return P.idle_kw;
    const x = t - P.job_start_s;
    if (profile === "staged") {
      const half = P.idle_kw + (P.full_kw - P.idle_kw) * P.staged_frac;
      if (x < P.staged_hold_s) return P.idle_kw + (half - P.idle_kw) * Math.min(1, x / P.ramp_s);
      return half + (P.full_kw - half) * Math.min(1, (x - P.staged_hold_s) / P.ramp_s);
    }
    return P.idle_kw + (P.full_kw - P.idle_kw) * Math.min(1, x / P.ramp_s);
  }
  const newPlant = () => ({
    temp: P.setpoint_c, ch2t: 0, pumpOn: true, shutdown: false, it: P.idle_kw, cool: P.idle_kw, cap: P.chiller_cap_kw,
    fac: P.idle_kw * (1 + P.chiller_kw_per_kw) + P.pump_kw,
  });
  function sensors(pl, man) {
    return { temp: pl.temp, power: pl.fac, ch1: pl.cap > 0 ? (100 * pl.cool) / pl.cap : 0, ch2run: pl.ch2t >= P.ch2_delay_s, man, aux: 0.0 };
  }
  function plantAdvance(pl, out, target) {
    pl.pumpOn = out.pumps;
    pl.ch2t = out.ch2Cmd && pl.pumpOn ? pl.ch2t + 1 : 0;
    let it = out.shed ? target * (1 - P.shed_frac) : target;
    if (pl.temp >= P.shutdown_c) pl.shutdown = true;
    if (pl.shutdown) it = 0; else if (pl.temp >= P.throttle_c) it *= 0.4;
    let cap2 = 0;
    if (pl.ch2t >= P.ch2_delay_s) cap2 = P.chiller_cap_kw * Math.min(1, (pl.ch2t - P.ch2_delay_s) / P.ch2_ramp_s);
    pl.cap = pl.pumpOn ? P.chiller_cap_kw + cap2 : P.chiller_cap_kw;
    const capNow = pl.pumpOn ? P.chiller_cap_kw + cap2 : 0;
    const cool = !pl.pumpOn ? 0 : Math.max(0, Math.min(capNow, it + P.kp_kw_per_c * (pl.temp - P.setpoint_c)));
    pl.temp += (it - cool) / P.loop_kj_per_c;
    pl.it = it; pl.cool = cool;
    pl.fac = it + P.chiller_kw_per_kw * cool + (pl.pumpOn ? P.pump_kw : 0);
  }

  /* ------------------------------------------------------------ a run you can step, clone and change mid-flight */
  class Run {
    constructor(profile = "single", ctrlCfg = {}) {
      this.profile = profile; this.t = 0; this.pl = newPlant(); this.c = newCtrl(ctrlCfg);
      this.manualAt = null; // second from which the manual chiller 2 override is on
      this.series = { t: [], temp: [], it: [], fac: [], cap: [], cool: [] };
      this.log = []; // fired rule ids per scan
    }
    get done() { return this.t >= P.duration_s; }
    step() {
      const man = this.manualAt !== null && this.t >= this.manualAt;
      const { out, fired } = ctrlStep(this.c, sensors(this.pl, man));
      plantAdvance(this.pl, out, jobTarget(this.profile, this.t));
      const s = this.series;
      s.t.push(this.t); s.temp.push(this.pl.temp); s.it.push(this.pl.it); s.fac.push(this.pl.fac);
      s.cap.push(this.pl.pumpOn ? this.pl.cap : 0); s.cool.push(this.pl.cool);
      this.log.push(fired);
      this.t += 1;
      return fired;
    }
    /* cheap copy for what-if forecasting: only state, not history */
    fork() {
      const r = new Run(this.profile, this.c.cfg);
      r.t = this.t; r.pl = { ...this.pl }; r.c = { cfg: this.c.cfg, s: { ...this.c.s } }; r.manualAt = this.manualAt;
      return r;
    }
  }

  /* run to the end (or until a protective rule fires) and summarise */
  function forecast(run, { stopAtTrip = false } = {}) {
    const r = run.fork();
    let primary = null, throttleT = null, shutdownT = null, peakT = r.pl.temp, peakFac = r.pl.fac, peakIt = r.pl.it;
    while (!r.done) {
      const f = r.step();
      if (r.pl.temp > peakT) peakT = r.pl.temp;
      if (r.pl.fac > peakFac) peakFac = r.pl.fac;
      if (r.pl.it > peakIt) peakIt = r.pl.it;
      if (r.t - 1 >= P.job_start_s) {
        for (const id of f) if (protectiveIds.has(id) && !primary) primary = { rule: id, t: r.t - 1 };
      }
      if (throttleT === null && r.pl.temp >= P.throttle_c) throttleT = r.t - 1;
      if (shutdownT === null && r.pl.temp >= P.shutdown_c) shutdownT = r.t - 1;
      if (stopAtTrip && primary) break;
    }
    return {
      willTrip: !!primary, primary, tripAfterStart: primary ? primary.t - P.job_start_s : null, throttleT, shutdownT,
      outcome: shutdownT !== null ? "thermal_shutdown" : throttleT !== null ? "throttle" : "ok",
      peakTemp: peakT, peakIt, peakFac, capMargin: D.facts.power_cap_kw - peakFac,
    };
  }
  function plan(profile, leadS) {
    const r = new Run(profile);
    if (leadS !== null && leadS !== undefined) r.manualAt = Math.max(0, P.job_start_s - leadS);
    return r;
  }
  const predictPlan = (profile, leadS) => forecast(plan(profile, leadS));

  /* seconds from now during which turning on the manual override still avoids a trip */
  function actWithin(run) {
    let best = null;
    for (let d = 0; d <= 60; d++) {
      const r = run.fork(); r.manualAt = run.t + d;
      if (!forecast(r).willTrip) best = d;
    }
    return best;
  }

  /* ------------------------------------------------------------ alerts and handoff text */
  const fmt = (n, d = 0) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const cap1 = (s) => s[0].toUpperCase() + s.slice(1);

  function verifiedSteps() {
    const r1 = ruleById.R1;
    return r1.mitigations.map((m) => {
      const sim = m.sim || {};
      const p = predictPlan(sim.profile || "single", sim.manual_ch2_lead_s ?? null);
      return { ...m, avoidsTrip: !p.willTrip, peakTemp: p.peakTemp, peakFac: p.peakFac, margin: p.capMargin };
    });
  }

  function prewarning() {
    const p = predictPlan("single", null);
    if (!p.willTrip) return { level: "ok", title: "No protective rule is predicted to fire at job start", pred: p };
    const rule = ruleById[p.primary.rule];
    const what = rule.interrupts[0];
    const ev = [
      `The job takes IT power from ${fmt(P.idle_kw)} kW to ${fmt(p.peakIt)} kW in about ${P.ramp_s} s.`,
      `One chiller can remove about ${fmt(P.chiller_cap_kw)} kW, so heat exceeds cooling by about ${fmt(p.peakIt - P.chiller_cap_kw)} kW.`,
      `Rule ${rule.id} (lines ${rule.lines[0]}-${rule.lines[1]}) acts about ${p.tripAfterStart} s after the job starts.`,
      `GPUs reach shutdown temperature about ${p.shutdownT - P.job_start_s} s after the job starts.`,
      `Cooling restart is then blocked for ${fmt(D.facts.lockout_s)} s by rules R2 and R3.`,
    ];
    return {
      level: "critical", pred: p, rule, evidence: ev, steps: verifiedSteps(),
      title: `${cap1(what)} about ${p.tripAfterStart} s after the job starts`,
      watchouts: rule.findings.map((f) => f.text), tickets: rule.tickets,
    };
  }

  /* parity test, in the browser: legacy interpreter vs rewritten controller on generated sensor sequences */
  function prng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function genInputs(rnd, scans, heavy) {
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const seg = (make) => { const out = []; while (out.length < scans) out.push(...make(5 + Math.floor(rnd() * 36))); return out.slice(0, scans); };
    let temp = 7.0;
    const temps = seg((k) => {
      const r = rnd(), mode = r < 0.4 ? "flat" : r < 0.8 ? "rise" : "fall";
      const slope = mode === "flat" ? 0 : mode === "rise" ? 0.05 + rnd() * 0.3 : -(0.02 + rnd() * 0.08);
      const v = [];
      for (let i = 0; i < k; i++) { temp = Math.min(30, Math.max(3, temp + slope + (mode === "flat" ? (rnd() - 0.5) * 0.04 : 0))); v.push(temp); }
      return v;
    });
    const power = seg((k) => Array(k).fill(pick([300, 900, 1700, 1849, 1851, 2100]) + (rnd() - 0.5) * 60));
    const loads = seg((k) => Array(k).fill(pick([15, 55, 79.9, 80, 95, 100])));
    if (heavy) for (let i = 0; i < Math.min(110, scans); i++) loads[i] = 95;
    const man = seg((k) => Array(k).fill(rnd() < 0.15));
    const aux = seg((k) => Array(k).fill(rnd() < 0.9 ? 0.0 : 0.1 + rnd() * 4.9));
    return temps.map((_, i) => ({ temp: temps[i], power: power[i], ch1: loads[i], man: man[i], aux: aux[i] }));
  }
  const BUGS = {
    off_by_one: { cfg: { tripScans: 21 }, text: "Trip counter threshold changed from 20 to 21 scans" },
    lockout: { cfg: { lockoutS: 120 }, text: "Restart lockout changed from 300 s to 120 s" },
  };
  const LEG = { temp: "TS1", power: "PF1", ch1: "CH1_LD", man: "MAN_C2", aux: "AI_77" };
  const PAIR = [["lockout", "LK_CT"], ["tripped", "TRP"], ["ch2Cmd", "CH2_CM"], ["pumps", "PMP_CM"], ["shed", "SHD_CM"], ["alarm", "AL_9"], ["riseCt", "RR_CT"], ["stageCt", "ST_CT"]];
  const NAMES = { lockout: "restart_lockout_s", tripped: "cooling_loop_tripped", ch2Cmd: "chiller2_start_cmd", pumps: "cooling_pumps_cmd", shed: "load_shed_cmd", alarm: "aux_flow_alarm", riseCt: "rise_counter", stageCt: "stage_delay_counter" };

  /* runs in slices so the page stays responsive; calls onProgress(done, total) and resolves with the result */
  function parityTest({ sequences = 400, bug = null, onProgress = () => {} } = {}) {
    const cfg = bug ? BUGS[bug].cfg : {};
    const master = prng(7), cov = Object.fromEntries(D.rules.map((r) => [r.id, 0]));
    let scans = 0, mismatches = 0, first = null, i = 0;
    const t0 = performance.now();
    return new Promise((resolve) => {
      const slice = () => {
        const end = Math.min(sequences, i + 10);
        for (; i < end; i++) {
          const rnd = prng(Math.floor(master() * 4294967296));
          const long = i % 4 === 0, n = long ? 400 : 150;
          const seq = genInputs(rnd, n, i % 3 === 0);
          if (long) {
            for (let k = 5; k < 40; k++) seq[k].temp = 7.0 + 0.2 * (k - 4);
            for (let k = 40; k < n; k++) seq[k].temp = seq[39].temp;
          }
          const leg = new LegacyController(), mod = newCtrl(cfg);
          for (let k = 0; k < n; k++) {
            const inp = seq[k];
            const li = { TS1: inp.temp, PF1: inp.power, CH1_LD: inp.ch1, CH2_ST: false, MAN_C2: inp.man, AI_77: inp.aux };
            const lf = leg.step(li);
            const mf = ctrlStep(mod, inp).fired;
            scans++;
            for (const id of lf) cov[id]++;
            const diffs = [];
            for (const [m, l] of PAIR) if (leg.env[l] !== mod.s[m]) diffs.push({ field: NAMES[m], legacy: leg.env[l], rewrite: mod.s[m] });
            if (lf.join() !== mf.join()) diffs.push({ field: "rules fired", legacy: lf.join(",") || "none", rewrite: mf.join(",") || "none" });
            if (diffs.length) { mismatches++; if (!first) first = { sequence: i, scan: k, diffs }; break; }
          }
        }
        onProgress(i, sequences);
        if (i < sequences) setTimeout(slice, 0);
        else resolve({
          passed: mismatches === 0, sequences, scans, mismatches, first, cov, bugText: bug ? BUGS[bug].text : null,
          covered: Object.values(cov).filter((v) => v > 0).length, total: D.rules.length, seconds: ((performance.now() - t0) / 1000).toFixed(2),
        });
      };
      setTimeout(slice, 0);
    });
  }

  return { D, P, ruleById, protectiveIds, Run, LegacyController, newCtrl, ctrlStep, forecast, predictPlan, actWithin, prewarning, verifiedSteps, parityTest, BUGS, fmt, cap1 };
})();
if (typeof module !== "undefined") module.exports = IL;
