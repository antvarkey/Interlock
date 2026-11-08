global.DATA = require("./data.json");
const ref = require("./ref.json");
global.performance = performance;
const IL = require("./engine.js");
let bad = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + " " + extra); if (!ok) bad++; };

// 1. JS plant+controller reproduces the Python timelines exactly
for (const [name, prof, lead] of [["single", "single", null], ["prestart", "single", 60], ["staged", "staged", null]]) {
  const r = IL.Run ? new IL.Run(prof) : null;
  if (lead !== null) r.manualAt = IL.P.job_start_s - lead;
  while (!r.done) r.step();
  const py = ref[name];
  let maxd = 0, firedOk = true;
  for (let i = 0; i < r.series.t.length; i++) {
    maxd = Math.max(maxd, Math.abs(r.series.temp[i] - py.temp[i]), Math.abs(r.series.fac[i] - py.fac_kw[i]) / 1000, Math.abs(r.series.it[i] - py.it_kw[i]) / 1000);
    if (r.log[i].join() !== py.fired[i].join()) firedOk = false;
  }
  check(`timeline ${name}`, maxd < 1e-3 && firedOk, `(max diff ${maxd.toExponential(1)}, fired match ${firedOk})`);
  const s = IL.forecast(new IL.Run(prof)); // forecast from a fresh run with same plan
}
// 2. forecast summary matches Python's summary
const f1 = IL.predictPlan("single", null), s1 = ref.single.summary;
check("trip after start", f1.tripAfterStart === s1.trip_after_start_s && f1.primary.rule === s1.primary.rule, `${f1.tripAfterStart} s, ${f1.primary.rule}`);
check("shutdown time", f1.shutdownT === s1.shutdown_t, `${f1.shutdownT}`);
check("peak facility (mitigated)", Math.round(IL.predictPlan("single", 60).peakFac) === ref.prestart.summary.peak_facility_kw);
check("staged avoids trip", !IL.predictPlan("staged", null).willTrip);
// 3. act-within window equals Python's latest safe manual start
const run = new IL.Run("single"); while (run.t < 91) run.step();
const w = IL.actWithin(run);
check("act within", 91 + w === ref.latest_safe, `latest safe t=${91 + w}, python ${ref.latest_safe}`);
// 4. parity test in JS
(async () => {
  const ok = await IL.parityTest({ sequences: 300 });
  check("parity passes", ok.passed && ok.covered === 7, `${ok.scans} scans, ${ok.covered}/7 rules, ${ok.seconds}s`);
  for (const bug of ["off_by_one", "lockout"]) {
    const r = await IL.parityTest({ sequences: 300, bug });
    check(`parity catches ${bug}`, !r.passed && r.first, JSON.stringify(r.first && r.first.diffs[0]));
  }
  const pw = IL.prewarning();
  check("prewarning", pw.level === "critical" && pw.steps.every((s) => s.avoidsTrip) && pw.watchouts.length === 2, pw.title);
  process.exit(bad ? 1 : 0);
})();
