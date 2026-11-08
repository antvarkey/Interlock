(() => {
const { D, P, fmt, Run, forecast, actWithin, latestSafe, prewarning, parityTest, BUGS, ruleById } = IL;
const mw = (kw, d = 1) => fmt(kw / 1000, d);
/* A chiller needs ~45 s to start, so the act-now window is before the job starts: the final call. */
const LATEST = latestSafe("single"), FINAL = LATEST === null ? null : Math.max(0, LATEST - 60);
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const JS = P.job_start_s;
const rel = (t) => (t < JS ? `T−${JS - t} s` : `T+${t - JS} s`);

const S = {
  run: null, phase: "idle", plan: { lead: null, staged: false }, events: [], notes: [], muted: false,
  seen: {}, alert: null, alertDone: false, acked: false, skip: false, ghost: null, pw: null, handoff: null, outcome: null, audio: null,
};

/* ------------------------------------------------------------ the do-nothing forecast, drawn faintly behind the live run */
function ghostRun() {
  const r = new Run("single"); while (!r.done) r.step(); return r.series;
}
S.ghost = ghostRun();

/* ------------------------------------------------------------ sound (only started from a click) */
function ensureAudio() {
  try { if (!S.audio) S.audio = new (window.AudioContext || window.webkitAudioContext)(); if (S.audio.state === "suspended") S.audio.resume(); } catch (e) { S.audio = null; }
}
function beep(sev) {
  if (S.muted || !S.audio) return;
  try {
    const ctx = S.audio, n = sev === "crit" ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain(), t0 = ctx.currentTime + i * 0.22;
      o.type = "square"; o.frequency.value = sev === "crit" ? 880 : 620;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      o.connect(g).connect(ctx.destination); o.start(t0); o.stop(t0 + 0.18);
    }
  } catch (e) {}
}

/* ------------------------------------------------------------ notifications: toasts + bell history */
function notify({ sev = "info", title, body = "", actions = [], sticky = false, pulse = false, go = null, silent = false }) {
  const note = { id: S.notes.length + 1, sev, title, body, read: false, at: S.run ? rel(Math.max(0, S.run.t - 1)) : "before job" };
  S.notes.unshift(note); renderBell();
  if (!silent) beep(sev);
  const t = document.createElement("div");
  t.className = `toast ${sev}${pulse ? " pulse" : ""}`;
  t.setAttribute("role", sev === "crit" ? "alert" : "status");
  t.innerHTML = `<div class="row"><div class="tt">${esc(title)}</div><button class="x" aria-label="Dismiss">×</button></div>${body ? `<div class="tb">${esc(body)}</div>` : ""}<div class="slot"></div>`;
  const close = () => { t.remove(); };
  t.querySelector(".x").onclick = close;
  if (actions.length) {
    const a = document.createElement("div"); a.className = "ta";
    for (const ac of actions) {
      const b = document.createElement("button"); b.className = `btn sm ${ac.cls || ""}`; b.textContent = ac.label;
      b.onclick = () => { ac.fn(); if (!ac.keep) close(); }; a.appendChild(b);
    }
    t.appendChild(a);
  }
  const box = $("#toasts"); box.prepend(t);
  const kids = [...box.children];
  if (kids.length > 4) { const victim = kids.reverse().find((k) => !k.dataset.sticky); (victim || kids[0]).remove(); }
  if (sticky) t.dataset.sticky = "1"; else setTimeout(close, sev === "warn" ? 9000 : 6500);
  return { el: t, close, note };
}
function renderBell() {
  const unread = S.notes.filter((n) => !n.read).length;
  const b = $("#badge"); b.textContent = unread; b.hidden = unread === 0;
  const p = $("#bellpanel");
  p.innerHTML = `<div class="hbar" style="margin-bottom:6px"><b style="flex:1">Notifications</b><button class="btn sm" id="markread">Mark all read</button><button class="btn sm" id="clearn">Clear</button></div>` +
    (S.notes.length ? S.notes.map((n) => `<div class="note ${n.sev}${n.read ? " read" : ""}"><span class="d"></span><div><b>${esc(n.title)}</b><span>${esc(n.body)}</span><br><time>${esc(n.at)}</time></div></div>`).join("") : `<p class="muted" style="padding:10px 4px">Nothing yet. Alerts from a live run will collect here.</p>`);
  $("#markread").onclick = () => { S.notes.forEach((n) => (n.read = true)); renderBell(); };
  $("#clearn").onclick = () => { S.notes = []; renderBell(); };
}
$("#bell").onclick = () => {
  const p = $("#bellpanel"), open = p.hidden;
  p.hidden = !open; $("#bell").setAttribute("aria-expanded", String(open));
  if (open) { S.notes.forEach((n) => (n.read = true)); renderBell(); }
};
document.addEventListener("click", (e) => { if (!e.target.closest("#bellpanel,#bell")) { $("#bellpanel").hidden = true; $("#bell").setAttribute("aria-expanded", "false"); } });
$("#mute").onclick = () => { S.muted = !S.muted; $("#mute").textContent = S.muted ? "Sound off" : "Sound on"; $("#mute").setAttribute("aria-pressed", String(S.muted)); ensureAudio(); };
(function theme() {
  const root = document.documentElement;
  $("#theme").onclick = () => {
    const dark = root.dataset.theme !== "light";
    root.dataset.theme = dark ? "light" : "dark"; draw();
  };
})();

/* ------------------------------------------------------------ tabs */
function showTab(name) {
  for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", String(t.dataset.tab === name));
  for (const p of document.querySelectorAll(".pane")) p.hidden = p.id !== "pane-" + name;
  if (name === "live") draw();
  if (name === "rules") scrollSrc();
  if (name === "hand") renderHandoff();
  $("#t-hand .dot")?.remove();
}
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));
const goTab = (n) => showTab(n);

/* ------------------------------------------------------------ event log */
function logEvent(ts, kind, text) {
  S.events.unshift({ ts, kind, text }); renderFeed();
}
function renderFeed() {
  $("#feed").innerHTML = S.events.length
    ? S.events.map((e) => `<li class="${e.kind}"><span class="ts">${rel(e.ts)}</span><span class="tx">${esc(e.text)}</span></li>`).join("")
    : `<li><span class="ts"></span><span class="tx muted">Nothing has happened yet.</span></li>`;
}

/* ------------------------------------------------------------ the pre-warning dialog */
function openModal(html) { const m = $("#modal"); m.innerHTML = html; $("#backdrop").hidden = false; const f = m.querySelector("button.primary,button"); f && f.focus(); }
function closeModal() { $("#backdrop").hidden = true; }

function queueJob() {
  ensureAudio();
  const pw = prewarning(); S.pw = pw;
  S.phase = "warning"; syncButtons();
  notify({ sev: "crit", title: "Pre-warning: " + pw.title, body: "Verified steps are ready. Review them before the job starts.", sticky: false, silent: false });
  const steps = pw.steps.map((s) => `<div class="step"><b>${esc(s.title)}</b>${esc(s.how)}<div class="v">✓ Checked in simulation: no cooling trip, peak ${s.peakTemp.toFixed(1)} °C, peak facility power ${fmt(s.peakFac)} kW (${fmt(s.margin)} kW under the ${fmt(D.facts.power_cap_kw)} kW cap)</div></div>`).join("");
  openModal(`
    <span class="chip crit">PRE-WARNING · before the job starts</span>
    <h2 id="mTitle">${esc(pw.title)}</h2>
    <p class="muted">Why Interlock expects this, from the original controller code:</p>
    <ul>${pw.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
    <p class="muted">Past incidents that match: ${pw.tickets.map((t) => `<span class="chip mute mono">${esc(t.id)}</span>`).join(" ")}</p>
    <details class="watch"><summary>Other things to watch (${pw.watchouts.length})</summary><ul>${pw.watchouts.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></details>
    <p class="muted">Steps that avoid it:</p>
    <div class="steps">${steps}</div>
    <div class="mbtns">
      <button class="btn primary" data-pick="prestart">Pre-start chiller 2</button>
      <button class="btn primary" data-pick="staged">Start in two stages</button>
      <button class="btn" data-pick="both">Do both</button>
      <span class="sp"></span>
      <button class="btn" data-pick="ignore">Ignore and start anyway</button>
      <button class="btn" data-pick="cancel">Cancel</button>
    </div>`);
  $("#modal").querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => pick(b.dataset.pick)));
}
function pick(choice) {
  closeModal();
  if (choice === "cancel") { S.phase = "idle"; syncButtons(); return; }
  S.plan = { lead: null, staged: false };
  if (choice === "prestart" || choice === "both") S.plan.lead = 120;
  if (choice === "staged" || choice === "both") S.plan.staged = true;
  startRun(choice);
}

/* ------------------------------------------------------------ run control */
function startRun(choice) {
  S.run = new Run(S.plan.staged ? "staged" : "single");
  if (S.plan.lead) S.run.manualAt = JS - S.plan.lead;
  S.events = []; S.seen = {}; S.alert = null; S.alertDone = false; S.rampDone = false; S.acked = false; S.skip = false; S.handoff = null; S.outcome = null;
  S.phase = "running"; syncButtons();
  const label = { prestart: "Plan applied: pre-start chiller 2 one minute before the job", staged: "Plan applied: start the job in two stages", both: "Plan applied: pre-start chiller 2 and start in two stages", ignore: "Operator chose to start without changes" }[choice];
  logEvent(0, choice === "ignore" ? "warn" : "action", label);
  notify({ sev: choice === "ignore" ? "warn" : "ok", title: choice === "ignore" ? "Starting without changes" : "Plan accepted", body: label, silent: true });
  last = 0; acc = 0;
}
function resetAll() {
  S.run = null; S.phase = "idle"; S.events = []; S.alert?.toast?.close(); S.alert = null; S.handoff = null; S.outcome = null; S.skip = false;
  $("#toasts").innerHTML = ""; $("#result").classList.remove("on"); syncButtons(); renderFeed(); renderTiles(); draw(); renderHandoff();
}
function syncButtons() {
  const run = S.phase === "running";
  $("#go").disabled = S.phase === "running" || S.phase === "warning";
  $("#go").textContent = S.phase === "done" ? "Run it again" : "Queue the training job";
  $("#go").onclick = () => (S.phase === "done" ? (resetAll(), queueJob()) : queueJob());
  $("#skip").disabled = !run; $("#reset").disabled = S.phase === "idle" || S.phase === "warning";
  const manualOn = S.run && S.run.manualAt !== null && S.run.manualAt <= S.run.t;
  $("#opCh2").disabled = !run || manualOn || S.run.manualAt !== null;
  $("#opAck").disabled = !(run && S.alert && !S.acked);
  $("#opHint").textContent = S.phase === "idle" ? "Queue the job to see the pre-warning. Once it is running, you can step in here."
    : S.phase === "warning" ? "Waiting for your decision on the pre-warning."
    : S.phase === "done" ? "Run finished. Open Shift handoff for the summary."
    : manualOn || (S.run && S.run.manualAt !== null) ? "Chiller 2 override is on or scheduled."
    : "If an alert appears, turning on chiller 2 early is the fix. The sooner, the better.";
  const g = $("#jobSub");
  g.textContent = S.phase === "idle" ? `Hall is idle at ${mw(P.idle_kw)} MW. A training job will take it to ${mw(P.full_kw)} MW in about ${P.ramp_s} seconds, starting ${JS / 60} min from now.`
    : S.phase === "warning" ? "Waiting on the pre-warning."
    : S.phase === "running" ? "Simulation running. Time is shown relative to the job start (T+0)."
    : "Run finished.";
}
$("#skip").onclick = () => { S.skip = true; };
$("#reset").onclick = resetAll;
$("#opCh2").onclick = () => {
  if (S.phase !== "running") return;
  S.run.manualAt = S.run.t;
  const f = forecast(S.run);
  logEvent(S.run.t, "action", "Operator turned on the chiller 2 manual override");
  if (S.alert) { S.alert.toast.close(); S.acked = true; }
  S.alertDone = true;
  if (f.willTrip) notify({ sev: "warn", title: "Override on, but too late to prevent a trip", body: `Forecast: protective rule ${f.primary.rule} still acts about ${f.primary.t - S.run.t} s from now. Chiller 2 will shorten the outage.`, sticky: false });
  else notify({ sev: "ok", title: "Override accepted: trip avoided", body: `Forecast: no cooling stop. Peak supply temperature ${f.peakTemp.toFixed(1)} °C, peak facility power ${fmt(f.peakFac)} kW.` });
  syncButtons();
};
$("#opAck").onclick = () => { if (S.alert) { S.alert.toast.close(); S.acked = true; logEvent(S.run.t, "action", "Alert acknowledged by operator"); } syncButtons(); };

/* ------------------------------------------------------------ one tick of the simulation */
function mitigated() { return S.run.manualAt !== null || S.run.profile === "staged"; }
function speed() {
  if (S.skip) return 250;
  const t = S.run.t;
  if (S.alert && !S.alert.closed) return 4;
  if (t < JS - 4) return 25;
  if (t < JS + 4) return 2.5;
  if (t < JS + 30) return 4;
  if (t < JS + 120) return 14;
  return 30;
}
function tick() {
  const r = S.run, f = r.step(), ts = r.t - 1, pl = r.pl, s = r.series;
  if (S.plan.lead && ts === r.manualAt) logEvent(ts, "action", "Chiller 2 manual override ON (per the verified plan)");
  if (ts === JS) logEvent(ts, "info", `Training job started. IT load ramping from ${mw(P.idle_kw)} MW to ${mw(P.full_kw)} MW`);
  if (!S.alertDone && !mitigated() && ts === FINAL) finalCall(ts);
  if (!S.rampDone && !mitigated() && ts >= 3 && s.fac[ts] - s.fac[ts - 3] > 1000) liveAlert(ts);
  for (const id of f) {
    const first = !S.seen[id]; S.seen[id] = true;
    if (id === "R1" && first) {
      logEvent(ts, "crit", `Rule R1 fired (lines ${ruleById.R1.lines[0]}-${ruleById.R1.lines[1]}): cooling loop tripped, pumps and chiller 2 stopped`);
      notify({ sev: "crit", title: "Cooling loop tripped (rule R1)", body: `The old controller read the fast temperature rise as a fault and stopped the pumps. Restart is blocked for ${D.facts.lockout_s} s.`, sticky: true, pulse: true });
    } else if (id === "R3" && first) {
      logEvent(ts, "ok", "Rule R3: lockout over, pumps restarting");
      notify({ sev: "ok", title: "Cooling restarting", body: "The restart lockout ended (rule R3). The job was lost and must be restarted by the scheduler." });
    } else if (id === "R5" && first) logEvent(ts, "info", "Rule R5: manual chiller 2 start accepted");
    else if (id === "R4" && first) logEvent(ts, "info", "Rule R4: chiller 1 busy for 90 s, chiller 2 staged in automatically");
    else if (id === "R6" && first) { logEvent(ts, "warn", `Rule R6: facility power over ${mw(D.facts.power_cap_kw)} MW, load shed 15%`); notify({ sev: "warn", title: "Load shed (rule R6)", body: `Facility power passed the ${mw(D.facts.power_cap_kw)} MW cap.` }); }
  }
  if (!S.seen.throttle && pl.temp >= P.throttle_c) {
    S.seen.throttle = true; logEvent(ts, "warn", `Supply water at ${P.throttle_c} °C: GPUs throttling`);
    notify({ sev: "warn", title: "GPUs throttling", body: `Supply water reached ${P.throttle_c} °C. Training speed is dropping.` });
  }
  if (!S.seen.shutdown && pl.shutdown) {
    S.seen.shutdown = true; logEvent(ts, "crit", `Supply water at ${P.shutdown_c} °C: GPU thermal shutdown. The job is lost`);
    notify({ sev: "crit", title: "GPU thermal shutdown", body: "The job was lost. It cannot restart until cooling is back and the lockout ends.", sticky: true });
  }
  if (S.alert && !S.alert.closed && r.t > S.alert.deadline) {
    S.alert.closed = true;
    S.alert.toast.el.querySelector(".cd").textContent = "Window to prevent the trip has closed";
    logEvent(ts, "crit", "The window to prevent the trip closed");
  }
}
function finalCall(ts) {
  S.alertDone = true;
  const left = LATEST - ts, toJob = JS - ts;
  const title = "Final call: start chiller 2 now";
  logEvent(ts, "crit", `Final call: the job starts in ${toJob} s and rule R1 will stop the cooling loop`);
  const n = notify({
    sev: "crit", title, sticky: true, pulse: true,
    body: `The job starts in ${toJob} s. One chiller cannot carry ${mw(P.full_kw)} MW, and a second chiller needs about ${P.ch2_delay_s} s to start. Acting in the next ${left} s still prevents the trip.`,
    actions: [{ label: "Start chiller 2 now", cls: "danger", fn: () => $("#opCh2").click(), keep: true }, { label: "Acknowledge", fn: () => $("#opAck").click(), keep: true }],
  });
  const cd = document.createElement("div"); cd.className = "cd";
  n.el.querySelector(".slot").appendChild(cd);
  S.alert = { toast: n, deadline: LATEST, closed: false };
  syncButtons();
}
function liveAlert(ts) {
  S.rampDone = true;
  if (S.alert && !S.alert.closed) return; // the final call is still open and says more
  S.alertDone = true;
  const w = actWithin(S.run);
  const deadline = w === null ? -1 : S.run.t + w;
  const title = w === null ? "Power spike: cooling trip is now unavoidable" : "Power spike detected: cooling trip coming";
  const body = w === null ? `Facility power jumped ${mw(S.run.series.fac[ts] - S.run.series.fac[ts - 3])} MW in 3 s. Heat now exceeds what one chiller can remove. Expect GPU throttling and a ${D.facts.lockout_s} s restart block.`
    : `Facility power jumped ${mw(S.run.series.fac[ts] - S.run.series.fac[ts - 3])} MW in 3 s. One chiller cannot keep up, and rule R1 will stop the cooling loop. Turning on chiller 2 now still prevents it.`;
  logEvent(ts, "crit", title);
  const n = notify({
    sev: "crit", title, body, sticky: true, pulse: true,
    actions: w === null ? [] : [{ label: "Start chiller 2 now", cls: "danger", fn: () => $("#opCh2").click(), keep: true }, { label: "Acknowledge", fn: () => $("#opAck").click(), keep: true }],
  });
  const cd = document.createElement("div"); cd.className = "cd"; cd.textContent = w === null ? "Window to prevent the trip has closed" : "";
  n.el.querySelector(".slot").appendChild(cd);
  S.alert = { toast: n, deadline, closed: w === null };
  syncButtons();
}
function updateCountdown() {
  if (!S.alert || S.alert.closed || !S.run) return;
  const left = S.alert.deadline - S.run.t;
  S.alert.toast.el.querySelector(".cd").textContent = `Act within ${Math.max(0, left)} s`;
}

/* ------------------------------------------------------------ finish + handoff */
function finish() {
  S.phase = "done"; S.skip = false;
  const r = S.run, s = r.series, tripped = !!S.seen.R1;
  const peakT = Math.max(...s.temp), peakFac = Math.max(...s.fac);
  const lostScans = s.it.filter((v, i) => i >= JS && v < 5).length;
  S.outcome = { tripped, shutdown: !!S.seen.shutdown, throttle: !!S.seen.throttle, peakT, peakFac, lostScans };
  S.handoff = buildHandoff();
  const ok = !tripped;
  logEvent(r.t - 1, ok ? "ok" : "crit", ok ? "Run complete: the job ran without a cooling trip" : "Run complete: job lost to a cooling trip");
  const res = $("#result"); res.classList.add("on");
  res.innerHTML = `<h3>Result</h3><div class="hbar"><span class="chip ${ok ? "ok" : "crit"}">${ok ? "No trip" : "Cooling trip"}</span>
    <span>Peak supply temperature <b class="mono">${peakT.toFixed(1)} °C</b></span><span>Peak facility power <b class="mono">${fmt(peakFac)} kW</b> (cap ${fmt(D.facts.power_cap_kw)})</span>
    ${tripped ? `<span>Job down for about <b class="mono">${Math.round(lostScans / 60 * 10) / 10} min</b></span>` : ""}</div>
    <p class="muted">${ok ? "The warning was acted on in time. Compare this with the dashed line in the chart: that is what would have happened with no action." : "Replay it and use the pre-warning to see the difference."}</p>`;
  const tab = $("#t-hand"); if (!tab.querySelector(".dot")) tab.insertAdjacentHTML("beforeend", '<span class="dot"></span>');
  notify({ sev: ok ? "ok" : "warn", title: "Shift handoff ready", body: "A summary of this run with the cause, what was done and follow-ups is ready to read.", actions: [{ label: "Open handoff", cls: "primary", fn: () => goTab("hand") }] });
  syncButtons();
}
function buildHandoff() {
  const o = S.outcome, r1 = ruleById.R1, ev = [...S.events].reverse();
  const L = [];
  L.push("SHIFT HANDOFF — Cluster B cooling, Hall 2");
  L.push("");
  L.push("STATUS");
  L.push(o.tripped ? `  The training job was lost: cooling loop tripped, GPUs ${o.shutdown ? "shut down on temperature" : "throttled"}.` : "  The training job ran without a cooling trip.");
  L.push(`  Peak supply temperature ${o.peakT.toFixed(1)} °C. Peak facility power ${fmt(o.peakFac)} kW against a ${fmt(D.facts.power_cap_kw)} kW cap.`);
  L.push("");
  L.push("WHAT HAPPENED");
  for (const e of ev) L.push(`  ${rel(e.ts).padEnd(7)} ${e.text}`);
  L.push("");
  L.push(o.tripped ? "ROOT CAUSE" : "RISK THE PLAN AVOIDED");
  L.push(`  ${r1.english}`);
  L.push(`  (Original controller lines ${r1.lines[0]}-${r1.lines[1]}.) The job takes IT power from ${fmt(P.idle_kw)} kW to ${fmt(P.full_kw)} kW in ${P.ramp_s} s; one chiller removes about ${fmt(P.chiller_cap_kw)} kW,`);
  L.push("  so the supply temperature rises faster than the controller allows and it stops the loop. Chiller 2 takes about 45 s to be useful.");
  L.push(`  Matches past incidents: ${r1.tickets.map((t) => t.id).join(", ")}.`);
  L.push("");
  L.push("FOLLOW-UPS");
  L.push("  1. Before every cluster start from idle: turn on the chiller 2 manual override at least 2 min early, or have the scheduler start the job at half power for 4 min.");
  r1.findings.forEach((f, i) => L.push(`  ${i + 2}. ${f.text}`));
  const n = r1.findings.length + 2;
  D.findings.filter((f) => !f.rules.includes("R1")).forEach((f, i) => L.push(`  ${n + i}. ${f.text}`));
  return L.join("\n");
}
function briefing() {
  const pw = S.pw || prewarning(), L = [];
  L.push("PRE-JOB BRIEFING — Cluster B cooling, Hall 2", "");
  L.push("PREDICTION", `  ${pw.title}.`);
  pw.evidence.forEach((e) => L.push(`  - ${e}`));
  L.push("", "VERIFIED STEPS (each checked in simulation)");
  pw.steps.forEach((s, i) => L.push(`  ${i + 1}. ${s.title}: ${s.how}`));
  L.push("", "ALSO WORTH KNOWING");
  pw.watchouts.forEach((w) => L.push(`  - ${w}`));
  return L.join("\n");
}
function renderHandoff() {
  const done = !!S.handoff;
  $("#handIntro").textContent = done ? "Generated from the run you just did. Paste it into the shift log or a ticket." : "No run yet, so this shows the pre-job briefing. Run the scenario on the Live tab to generate the real shift handoff.";
  $("#hand").textContent = done ? S.handoff : briefing();
  $("#copy").textContent = done ? "Copy handoff" : "Copy briefing";
}
$("#copy").onclick = () => {
  const txt = $("#hand").textContent;
  try {
    navigator.clipboard.writeText(txt).then(() => { $("#copied").textContent = "Copied."; notify({ sev: "ok", title: "Copied to clipboard", silent: true }); }, () => { $("#copied").textContent = "Copy was blocked here. Select the text and copy it."; });
  } catch (e) { $("#copied").textContent = "Copy was blocked here. Select the text and copy it."; }
};

/* ------------------------------------------------------------ tiles */
function renderTiles() {
  const pl = S.run ? S.run.pl : { temp: P.setpoint_c, it: P.idle_kw, fac: P.idle_kw * (1 + P.chiller_kw_per_kw) + P.pump_kw, cap: P.chiller_cap_kw, ch2t: 0, pumpOn: true, shutdown: false };
  const c = S.run ? S.run.c.s : { lockout: 0, tripped: false };
  const cls = pl.temp >= P.shutdown_c ? "crit" : pl.temp >= P.throttle_c ? "crit" : pl.temp >= P.setpoint_c + 2 ? "warn" : "";
  const ch2 = pl.ch2t === 0 ? ["Standby", ""] : pl.ch2t < P.ch2_delay_s ? [`Starting ${P.ch2_delay_s - pl.ch2t} s`, "warn"] : pl.ch2t < P.ch2_delay_s + P.ch2_ramp_s ? ["Ramping up", "info"] : ["Online", ""];
  const loop = !pl.pumpOn ? [c.lockout > 0 ? `Stopped` : "Restarting", "crit", c.lockout > 0 ? `restart in ${c.lockout} s` : ""] : ["Running", "", "pumps on"];
  const T = (k, v, s, cl = "") => `<div class="tile ${cl}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  $("#tiles").innerHTML =
    T("Supply temp", `${pl.temp.toFixed(1)} °C`, `setpoint ${P.setpoint_c} °C`, cls) +
    T("IT load", `${mw(pl.it, 2)} MW`, pl.shutdown ? "GPUs shut down" : pl.temp >= P.throttle_c ? "GPUs throttled" : "heat to remove", pl.shutdown ? "crit" : pl.temp >= P.throttle_c ? "warn" : "") +
    T("Cooling capacity", `${mw(pl.pumpOn ? pl.cap : 0)} MW`, "available now", !pl.pumpOn ? "crit" : "") +
    T("Facility power", `${mw(pl.fac, 2)} MW`, `cap ${mw(D.facts.power_cap_kw)} MW`, pl.fac > D.facts.power_cap_kw ? "crit" : pl.fac > D.facts.power_cap_kw - 400 ? "warn" : "") +
    T("Chiller 2", ch2[0], "second chiller", ch2[1]) +
    T("Cooling loop", loop[0], loop[2], loop[1]);
  $("#clock").textContent = S.run ? rel(Math.max(0, S.run.t - 1)) : rel(0);
}

/* ------------------------------------------------------------ charts */
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function chart(cv, { series, hlines = [], yMin, yMax, unit, upTo }) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const L = 52, R = 10, T = 8, B = 22, pw = W - L - R, ph = H - T - B, N = P.duration_s;
  const X = (i) => L + (i / (N - 1)) * pw, Y = (v) => T + ph - ((v - yMin) / (yMax - yMin)) * ph;
  g.font = "11px " + css("--mono"); g.fillStyle = css("--ink2"); g.strokeStyle = css("--line"); g.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const v = yMin + ((yMax - yMin) * k) / 4, y = Y(v);
    g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke();
    g.textAlign = "right"; g.fillText(unit === "kW" ? fmt(v / 1000) + " MW" : v.toFixed(0), L - 6, y + 4);
  }
  g.textAlign = "center";
  for (let tt = JS - 60; tt <= N; tt += 60) { if (tt < 0) continue; g.fillText(tt === JS ? "T+0" : (tt - JS > 0 ? "+" : "−") + Math.abs(tt - JS), X(tt), H - 6); }
  g.strokeStyle = css("--ink2"); g.setLineDash([2, 4]); g.beginPath(); g.moveTo(X(JS), T); g.lineTo(X(JS), T + ph); g.stroke(); g.setLineDash([]);
  for (const h of hlines) { g.strokeStyle = css(h.color); g.setLineDash([3, 4]); g.lineWidth = 1.5; g.beginPath(); g.moveTo(L, Y(h.y)); g.lineTo(W - R, Y(h.y)); g.stroke(); g.setLineDash([]); }
  for (const s of series) {
    const data = s.data, end = s.live ? Math.min(data.length, upTo) : data.length;
    if (end < 2) continue;
    g.strokeStyle = css(s.color); g.lineWidth = s.w || 2.2; g.setLineDash(s.dash || []); g.beginPath();
    for (let i = 0; i < end; i++) { const x = X(i), y = Y(Math.min(yMax, Math.max(yMin, data[i]))); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke(); g.setLineDash([]);
  }
  if (S.run && upTo > 0) { g.fillStyle = css("--accent"); g.beginPath(); g.arc(X(Math.min(upTo, N) - 1), T + ph, 0, 0, 7); g.fill(); g.strokeStyle = css("--accent"); g.lineWidth = 1; g.beginPath(); g.moveTo(X(upTo - 1), T); g.lineTo(X(upTo - 1), T + ph); g.stroke(); }
}
function draw() {
  if ($("#pane-live").hidden) return;
  const s = S.run ? S.run.series : { temp: [], it: [], cap: [], fac: [] }, n = s.temp.length;
  chart($("#c1"), { yMin: 22, yMax: 38, unit: "C", upTo: n, hlines: [{ y: P.throttle_c, color: "--warn" }, { y: P.shutdown_c, color: "--crit" }],
    series: [{ data: S.ghost.temp, color: "--ink2", dash: [6, 5], w: 1.8 }, { data: s.temp, color: "--accent", live: true }] });
  chart($("#c2"), { yMin: 0, yMax: 12000, unit: "kW", upTo: n, hlines: [{ y: D.facts.power_cap_kw, color: "--crit" }],
    series: [{ data: s.cap, color: "--ok", live: true }, { data: s.fac, color: "--info", live: true, w: 1.6 }, { data: s.it, color: "--accent", live: true }] });
}
new ResizeObserver(draw).observe($("#pane-live"));

/* ------------------------------------------------------------ animation loop */
let last = 0, acc = 0;
function frame(ts) {
  if (!last) last = ts;
  const dt = Math.min(0.1, (ts - last) / 1000); last = ts;
  if (S.phase === "running") {
    acc += dt * speed();
    let guard = 0;
    while (acc >= 1 && S.run && !S.run.done && guard++ < 400) { acc -= 1; tick(); }
    if (S.run.done) finish();
    updateCountdown(); renderTiles(); draw(); syncRunButtons();
  }
  requestAnimationFrame(frame);
}
function syncRunButtons() {
  const manual = S.run.manualAt !== null;
  $("#opCh2").disabled = S.phase !== "running" || manual;
  $("#opAck").disabled = !(S.phase === "running" && S.alert && !S.acked);
}

/* ------------------------------------------------------------ rules tab */
let selRule = "R1", srcMode = "legacy";
function rName(n) { const g = D.glossary[n]; return g ? g.desc : n; }
function renderRules() {
  $("#rlist").innerHTML = D.rules.map((r) => `<button class="rcard" data-r="${r.id}" aria-pressed="${r.id === selRule}">
    <div class="h"><b>${r.id}</b><span class="chip mute mono">lines ${r.lines[0] === r.lines[1] ? r.lines[0] : r.lines[0] + "-" + r.lines[1]}</span>${r.protective ? '<span class="chip crit">can interrupt cooling</span>' : ""}${r.tickets.length ? `<span class="chip warn">${r.tickets.length} incident${r.tickets.length === 1 ? "" : "s"}</span>` : ""}</div>
    <p>${esc(r.english)}</p></button>`).join("");
  document.querySelectorAll(".rcard").forEach((b) => (b.onclick = () => { selRule = b.dataset.r; srcMode = "legacy"; renderRules(); scrollSrc(); }));
  $("#segL").setAttribute("aria-pressed", String(srcMode === "legacy")); $("#segM").setAttribute("aria-pressed", String(srcMode === "modern"));
  const r = ruleById[selRule], src = srcMode === "legacy" ? D.legacy_source : D.modern_source;
  $("#src").innerHTML = src.split("\n").map((ln, i) => `<div data-l="${i + 1}" class="${srcMode === "legacy" && i + 1 >= r.lines[0] && i + 1 <= r.lines[1] ? "hl" : ""}"><i>${i + 1}</i>${esc(ln) || " "}</div>`).join("");
  const ml = r.mitigations || [];
  $("#detail").innerHTML = `
    <div class="card"><h3>${r.id} in plain English</h3><p>${esc(r.english)}</p>
      <p class="muted" style="margin-top:8px;font-size:13px">Reads: ${r.reads.map((x) => esc(rName(x))).join(", ") || "nothing"}. Changes: ${r.writes.map((x) => esc(rName(x))).join(", ") || "nothing"}.</p></div>
    ${r.findings.length ? `<div class="card"><h3>Needs a human decision</h3>${r.findings.map((f) => `<div class="finding"><b>${esc(f.label)}.</b> ${esc(f.text)}</div>`).join("")}</div>` : ""}
    ${r.tickets.length ? `<div class="card"><h3>Past incidents this rule explains</h3>${r.tickets.map((t) => `<div class="tk"><b>${esc(t.id)}</b> <span class="muted">${esc(t.date)}</span><br>${esc(t.text)}</div>`).join("")}</div>` : ""}
    ${ml.length ? `<div class="card"><h3>Verified ways to avoid it</h3>${ml.map((m) => `<div class="tk"><b>${esc(m.title)}</b><br>${esc(m.how)}</div>`).join("")}</div>` : ""}`;
}
function scrollSrc() {
  const c = $("#src"), h = c.querySelector(".hl");
  if (h && srcMode === "legacy") c.scrollTop = Math.max(0, h.offsetTop - 40); else c.scrollTop = 0;
}
$("#segL").onclick = () => { srcMode = "legacy"; renderRules(); scrollSrc(); };
$("#segM").onclick = () => { srcMode = "modern"; renderRules(); scrollSrc(); };

/* ------------------------------------------------------------ verify tab */
let vBusy = false;
async function runParity(bug) {
  if (vBusy) return; vBusy = true;
  document.querySelectorAll("#vrun,#bugs button").forEach((b) => (b.disabled = true));
  $("#vout").innerHTML = '<span class="muted">Running…</span>';
  const res = await parityTest({ sequences: 400, bug, onProgress: (d, t) => { $("#vbar").style.width = (100 * d) / t + "%"; } });
  vBusy = false; document.querySelectorAll("#vrun,#bugs button").forEach((b) => (b.disabled = false));
  const cov = Object.entries(res.cov).map(([id, n]) => `<span class="chip ${n ? "ok" : "crit"} mono">${id} ×${fmt(n)}</span>`).join("");
  if (res.passed) {
    $("#vout").innerHTML = `<div class="vres ok"><h4>✓ The rewrite matches the original</h4>${fmt(res.scans)} control cycles across ${res.sequences} generated scenarios, 0 differences. ${res.covered} of ${res.total} rules exercised. Took ${res.seconds} s.<div class="cov">${cov}</div></div>`;
  } else {
    const d = res.first.diffs;
    $("#vout").innerHTML = `<div class="vres bad"><h4>✗ The rewrite behaves differently</h4>${res.bugText ? `Planted mistake: ${esc(res.bugText)}.<br>` : ""}${res.mismatches} of ${res.sequences} scenarios differ. First difference at scenario ${res.first.sequence}, cycle ${res.first.scan}:
      <table><tr><th>What differs</th><th>Original</th><th>Rewrite</th></tr>${d.map((x) => `<tr><td>${esc(x.field)}</td><td class="mono">${esc(String(x.legacy))}</td><td class="mono">${esc(String(x.rewrite))}</td></tr>`).join("")}</table><div class="cov">${cov}</div></div>`;
    if (bug) notify({ sev: "crit", title: "Parity check failed", body: `${res.bugText}. The rewrite must not be deployed until this is fixed.`, silent: false });
  }
}
$("#vrun").onclick = () => { ensureAudio(); runParity(null); };
$("#bugs").innerHTML = Object.entries(BUGS).map(([k, b]) => `<button class="btn" data-bug="${k}">${esc(b.text)}</button>`).join("");
document.querySelectorAll("[data-bug]").forEach((b) => (b.onclick = () => { ensureAudio(); runParity(b.dataset.bug); }));

/* ------------------------------------------------------------ start */
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#backdrop").hidden) pick("cancel"); });
renderRules(); renderBell(); renderFeed(); renderTiles(); syncButtons(); renderHandoff();
requestAnimationFrame(() => { draw(); runParity(null); });
requestAnimationFrame(frame);
window.__IL_APP = S; /* handy for tests */
})();
