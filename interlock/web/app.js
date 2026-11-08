/* Interlock dashboard. Plain JavaScript, no build step. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const rng = (l) => (l[0] === l[1] ? `${l[0]}` : `${l[0]}–${l[1]}`);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n, d = 0) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const api = async (path, body) => {
  const res = await fetch("/api/" + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) throw new Error(path + " failed: " + res.status);
  return res.json();
};

const S = { st: null, sel: "R1", sim: null, raf: null, baseline: null };

/* ------------------------------------------------------------------ plan */
const planBody = () => ({
  profile: $('input[name="profile"]:checked').value,
  manual_lead_s: $("#prestart").checked ? 60 : null,
});

function dot(level) { return `<span class="dot ${level === "ok" ? "ok" : level === "info" ? "info" : "critical"}"></span>`; }

function renderPrewarning(pw) {
  if (!pw.rule) {
    return `<div class="alert ok"><div class="t">${dot("ok")}<span>${esc(pw.title)}</span></div><div class="small muted" style="margin-top:6px">${esc(pw.summary)}</div></div>`;
  }
  const steps = pw.steps.map((s) => `
    <div class="step">
      <div class="h">${esc(s.title)} <span class="chip ${s.avoids_trip ? "ok" : "crit"}">${s.avoids_trip ? "verified: avoids the trip" : "does not avoid the trip"}</span></div>
      <div class="small" style="margin:4px 0">${esc(s.how)}</div>
      <div class="small muted">Simulated: peak supply temperature ${fmt(s.peak_temp_c, 1)} °C · peak facility power ${fmt(s.peak_facility_kw)} kW${s.power_cap_margin_kw != null ? ` (${fmt(s.power_cap_margin_kw)} kW below the cap)` : ""}</div>
      <div style="margin-top:6px"><button class="btn" data-apply="${s.id}">Apply this step</button></div>
    </div>`).join("");
  const tickets = (pw.tickets || []).map((t) => `<li><b>${esc(t.id)}</b> (${esc(t.date)}): ${esc(t.text)}</li>`).join("");
  return `<div class="alert ${pw.level}">
    <div class="t">${dot(pw.level)}<span>${esc(pw.title)}</span></div>
    <div class="small muted" style="margin:4px 0 0 18px">Pre-warning sent when the job is queued, 90 s before it starts. Shows what happens if nobody acts.</div>
    <div class="label">Rule behind this · lines ${rng(pw.rule.lines)}</div>
    <div class="small">${esc(pw.rule.english)}</div>
    <div class="label">Why it will happen</div>
    <ul class="small">${pw.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
    <div class="label">What to do (each step checked in the simulator)</div>${steps}
    ${pw.watchouts.length ? `<div class="label">Watch out</div><ul class="small">${pw.watchouts.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
    ${tickets ? `<div class="label">Seen before</div><ul class="small">${tickets}</ul>` : ""}
  </div>`;
}

async function refreshVerdict() {
  const pw = await api("prewarning", planBody());
  const el = $("#verdict");
  if (pw.level === "ok") {
    el.className = "verdict ok";
    el.innerHTML = `With this plan: no protective rule is predicted to fire. Peak supply temperature ${fmt(pw.prediction.peak_temp_c, 1)} °C, peak facility power ${fmt(pw.prediction.peak_facility_kw)} kW (${fmt(pw.prediction.power_cap_margin_kw)} kW below the cap).`;
  } else {
    el.className = "verdict bad";
    el.innerHTML = `With this plan: ${esc(pw.title.toLowerCase())}.`;
  }
}

/* ------------------------------------------------------------------ charts */
function drawChart(canvas, cfg) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = 230;
  canvas.style.height = H + "px";
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext("2d");
  g.scale(dpr, dpr);
  const pad = { l: 56, r: 16, t: 16, b: 28 };
  const X = (t) => pad.l + (t / cfg.duration) * (W - pad.l - pad.r);
  const Y = (v) => H - pad.b - ((v - cfg.ymin) / (cfg.ymax - cfg.ymin)) * (H - pad.t - pad.b);
  g.font = "11px ui-monospace, Menlo, monospace";
  g.fillStyle = "#8b98ab"; g.strokeStyle = "#2a3445"; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = cfg.ymin + ((cfg.ymax - cfg.ymin) * i) / 4;
    g.beginPath(); g.moveTo(pad.l, Y(v)); g.lineTo(W - pad.r, Y(v)); g.stroke();
    g.textAlign = "right"; g.fillText(fmt(v, cfg.yd || 0), pad.l - 8, Y(v) + 4);
  }
  g.textAlign = "center";
  for (let t = 0; t <= cfg.duration; t += 60) g.fillText(t + "s", X(t), H - 8);
  (cfg.hlines || []).forEach((h) => {
    g.strokeStyle = h.color; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(pad.l, Y(h.y)); g.lineTo(W - pad.r, Y(h.y)); g.stroke(); g.setLineDash([]);
    g.fillStyle = h.color; g.textAlign = "left"; g.fillText(h.label, pad.l + 6, Y(h.y) - 4);
  });
  (cfg.markers || []).forEach((m) => {
    if (m.t > cfg.cursor) return;
    g.strokeStyle = m.color; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(X(m.t), pad.t); g.lineTo(X(m.t), H - pad.b); g.stroke(); g.setLineDash([]);
    g.fillStyle = m.color; g.textAlign = "left"; g.fillText(m.label, X(m.t) + 4, pad.t + 10 + (m.row || 0) * 12);
  });
  (cfg.lines || []).forEach((ln) => {
    g.strokeStyle = ln.color; g.lineWidth = 2; g.beginPath();
    let started = false;
    for (let i = 0; i < ln.y.length && i <= cfg.cursor; i++) {
      const x = X(i), y = Y(Math.min(cfg.ymax, Math.max(cfg.ymin, ln.y[i])));
      if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
    }
    g.stroke(); g.lineWidth = 1;
  });
  if (cfg.cursor < cfg.duration - 1) {
    g.strokeStyle = "#e7edf5"; g.globalAlpha = 0.5; g.beginPath(); g.moveTo(X(cfg.cursor), pad.t); g.lineTo(X(cfg.cursor), H - pad.b); g.stroke(); g.globalAlpha = 1;
  }
}

function drawCharts(sim, cursor) {
  const duration = sim ? sim.duration : 420;
  const base = { duration, cursor };
  const ev = sim ? sim.events : [];
  const markers = sim ? [{ t: sim.job_start, color: "#8b98ab", label: "job starts" }]
    .concat(ev.filter((e) => e.type === "live_alert").map((e) => ({ t: e.t, color: "#e3a72f", label: "alert", row: 1 })))
    .concat(ev.filter((e) => e.type === "rule_fired").map((e) => ({ t: e.t, color: "#ff5d5d", label: "trip", row: 2 })))
    .concat(ev.filter((e) => e.type === "action" && e.t > 0).map((e) => ({ t: e.t, color: "#3ecf8e", label: "operator", row: 1 }))) : [];
  drawChart($("#c-temp"), { ...base, ymin: 0, ymax: 24, yd: 0, markers,
    hlines: [{ y: sim ? sim.thresholds.shutdown_c : 18, color: "#ff5d5d", label: "GPU shutdown 18 °C" }, { y: sim ? sim.thresholds.throttle_c : 15, color: "#e3a72f", label: "GPU throttle 15 °C" }],
    lines: sim ? [{ y: sim.series.temp, color: "#e3a72f" }] : [] });
  drawChart($("#c-pow"), { ...base, ymin: 0, ymax: 2000, markers,
    lines: sim ? [{ y: sim.series.it_kw, color: "#5aa9ff" }, { y: sim.series.cap_kw, color: "#3ecf8e" }] : [] });
}

/* ------------------------------------------------------------------ playback */
const rel = (t, js) => (t - js >= 0 ? "+" : "−") + Math.abs(t - js) + " s";

function renderBanner(sim, cur) {
  const el = $("#banner");
  const la = sim.live_alert, p = sim.prediction;
  const tripEv = sim.events.filter((e) => e.type === "rule_fired" && e.t <= cur).pop();
  if (tripEv) {
    const impact = sim.events.filter((e) => e.type === "impact" && e.t <= cur).pop();
    el.innerHTML = `<div class="alert critical"><div class="t">${dot("critical")}<span>${esc(tripEv.title)}</span></div>
      <div class="small" style="margin:6px 0 0 18px">${impact ? esc(impact.title) + ". " : ""}${p.shutdown_t && cur >= p.shutdown_t ? "Cooling restart is blocked by the lockout." : ""}</div></div>`;
    return;
  }
  if (la && cur >= la.t) {
    const left = la.level === "critical" ? Math.max(0, p.primary.t - cur) : null;
    const act = la.act_within_s != null ? Math.max(0, la.act_within_s - (cur - la.t)) : null;
    el.innerHTML = `<div class="alert ${la.level}"><div class="t">${dot(la.level)}<span>${esc(la.title)}</span></div>
      ${left != null ? `<div class="small" style="margin:6px 0 0 18px"><b>Trip in ${Math.ceil(left)} s</b>${act != null ? (act > 0 ? ` · act within <b>${Math.ceil(act)} s</b>` : " · the window to prevent it has closed. This is why the pre-warning matters.") : ""}</div>` : ""}
      ${(la.steps || []).map((s) => `<div class="step"><div class="h">${esc(s.title)}</div><div class="small">${esc(s.how)}</div></div>`).join("")}</div>`;
    return;
  }
  const act = sim.events.filter((e) => e.type === "action" && e.t <= cur && e.t > 0).pop();
  el.innerHTML = act ? `<div class="alert info"><div class="t">${dot("info")}<span>${esc(act.title)}</span></div></div>` : "";
}

function renderFeed(sim, cur) {
  const list = sim.events.filter((e) => e.t <= cur).reverse();
  $("#feed").innerHTML = list.length
    ? list.map((e) => `<div class="ev"><div class="tm">${rel(e.t, sim.job_start)}</div>${dot(e.level)}<div>${esc(e.title)}</div></div>`).join("")
    : '<div class="muted small">Waiting for the job to start…</div>';
}

function frame(cur) {
  const sim = S.sim;
  drawCharts(sim, cur);
  renderFeed(sim, cur);
  renderBanner(sim, cur);
  $("#clock").textContent = `t = ${Math.floor(cur)} s (${rel(Math.floor(cur), sim.job_start)})`;
}

function stop() { if (S.raf) cancelAnimationFrame(S.raf); S.raf = null; }

async function run() {
  stop();
  $("#run").disabled = true;
  $("#run").textContent = "▶ Running…";
  S.sim = await api("simulate", planBody());
  S.handoffStale = true;
  const sim = S.sim, speed = +$("#speed").value;
  let cur = 0, last = performance.now();
  const tick = (now) => {
    const dt = (now - last) / 1000; last = now;
    cur += dt * speed * (cur < sim.job_start - 12 ? 6 : 1);
    if (cur >= sim.duration - 1) { cur = sim.duration - 1; frame(cur); finish(); return; }
    frame(cur);
    S.raf = requestAnimationFrame(tick);
  };
  S.raf = requestAnimationFrame(tick);
}

function finish() { S.raf = null; $("#run").disabled = false; $("#run").textContent = "▶ Run again"; }

/* ------------------------------------------------------------------ rules tab */
const lineHtml = (src, hl) => src.split("\n").map((l, i) => `<div class="ln${hl && i + 1 >= hl[0] && i + 1 <= hl[1] ? " hl" : ""}" data-n="${i + 1}"><span class="n">${i + 1}</span><span>${esc(l) || " "}</span></div>`).join("");

function renderRules() {
  const st = S.st;
  const mism = st.findings.filter((f) => f.kind === "runbook_mismatch").length;
  const dead = st.findings.filter((f) => f.kind === "dead_input").length;
  const linked = st.rules.reduce((n, r) => n + r.tickets.length, 0);
  $("#rules-summary").innerHTML = `<span class="chip info">${st.rules.length} rules extracted</span>
    <span class="chip warn">${mism} runbook mismatches</span><span class="chip warn">${dead} dead rule</span><span class="chip ok">${linked} incident tickets linked</span>`;
  $("#rule-list").innerHTML = st.rules.map((r) => `
    <div class="rule ${r.id === S.sel ? "sel" : ""}" data-rule="${r.id}">
      <div><span class="id">${r.id}</span>${r.protective ? '<span class="chip crit">interrupts cooling or load</span> ' : ""}${r.findings.length ? '<span class="chip warn">finding</span> ' : ""}${r.tickets.length ? `<span class="chip ok">${r.tickets.length} ticket${r.tickets.length === 1 ? "" : "s"}</span>` : ""}</div>
      <div class="small" style="margin-top:4px">${esc(r.english)}</div>
    </div>`).join("");
  $$("#rule-list .rule").forEach((el) => el.addEventListener("click", () => { S.sel = el.dataset.rule; renderRules(); }));
  const r = st.rules.find((x) => x.id === S.sel);
  const g = st.glossary;
  const nm = (v) => `<span class="mono">${esc(v)}</span> <span class="muted">${esc(g[v]?.desc || "")}</span>`;
  $("#rule-detail").innerHTML = `
    <h3>${r.id} · in plain English</h3>
    <div style="font-size:15px;margin-bottom:12px">${esc(r.english)}</div>
    <div class="kv">
      <div>Source lines</div><div class="mono">${rng(r.lines)}</div>
      <div>Reads</div><div>${r.reads.map(nm).join("<br>") || "–"}</div>
      <div>Writes</div><div>${r.writes.map(nm).join("<br>")}</div>
      ${r.interrupts.length ? `<div>Effect</div><div class="fail">${esc(r.interrupts.join("; "))}</div>` : ""}
    </div>
    ${r.findings.map((f) => `<div class="label">Finding</div><div class="small"><span class="chip warn">${f.kind.replace("_", " ")}</span> ${esc(f.text)}</div>`).join("")}
    ${r.mitigations.length ? `<div class="label">Known mitigations</div><ul class="plain small">${r.mitigations.map((m) => `<li><b>${esc(m.title)}.</b> ${esc(m.how)}</li>`).join("")}</ul>` : ""}
    ${r.tickets.length ? `<div class="label">Incident tickets that match this rule</div><ul class="plain small">${r.tickets.map((t) => `<li><b>${esc(t.id)}</b> (${esc(t.date)}): ${esc(t.text)}</li>`).join("")}</ul>` : ""}`;
  $("#src").innerHTML = lineHtml(st.legacy_source, r.lines);
  const first = $("#src .ln.hl");
  if (first) $("#src").scrollTop = Math.max(0, first.offsetTop - 120);
}

async function ask() {
  const q = $("#ask-q").value.trim();
  if (!q) return;
  const out = $("#ask-a"); out.style.display = "block"; out.textContent = "Thinking…";
  try { out.textContent = (await api("ask", { question: q })).answer; } catch (e) { out.textContent = "Could not reach the server."; }
}

/* ------------------------------------------------------------------ verify tab */
async function parity(bug) {
  const out = $("#p-out");
  $$("#tab-verify .btn").forEach((b) => (b.disabled = true));
  out.innerHTML = '<span class="muted">Running…</span>';
  try {
    const r = await api("parity", { sequences: 2000, bug });
    const cls = r.passed ? "pass" : "fail";
    out.innerHTML = `
      <div class="big ${cls}">${r.passed ? "PASS" : "MISMATCH FOUND"}</div>
      <div class="small" style="margin:4px 0 10px">${r.passed
        ? `No differences across ${fmt(r.scans)} scans in ${fmt(r.sequences)} generated sequences.`
        : `${fmt(r.mismatch_sequences)} of ${fmt(r.sequences)} sequences diverge. ${esc(r.injected_bug || "")}.`}</div>
      <div class="small muted">Checked in ${r.seconds} s. A pass is strong evidence of identical behavior on the tested inputs, not a proof.</div>
      ${r.first_mismatches.length ? (() => { const m = r.first_mismatches[0]; return `<div class="label">First difference</div>
        <div class="small">Sequence ${m.sequence}, scan ${m.scan}.</div>
        <ul class="plain small">${m.diffs.map((d) => `<li class="mono">${esc(d.field)}: legacy ${esc(JSON.stringify(d.legacy))} vs rewrite ${esc(JSON.stringify(d.modern))}</li>`).join("")}</ul>`; })() : ""}`;
    const mx = Math.max(...Object.values(r.coverage), 1);
    $("#p-cov").innerHTML = `<div class="small" style="margin-bottom:8px">${r.rules_covered} of ${r.rules_total} rules fired at least once.</div>` +
      Object.entries(r.coverage).map(([id, n]) => `<div class="cov"><b>${id}</b><div class="bar"><i style="width:${n ? Math.max(2, (Math.sqrt(n) / Math.sqrt(mx)) * 100) : 0}%"></i></div><span class="mono muted">${fmt(n)}</span></div>`).join("");
  } catch (e) { out.innerHTML = '<span class="fail">Request failed.</span>'; }
  $$("#tab-verify .btn").forEach((b) => (b.disabled = false));
}

/* ------------------------------------------------------------------ AI-assisted rewrite */
async function llmInit() {
  const st = await (await fetch("/api/llm/status")).json();
  $("#llm-status").textContent = st.available
    ? `Model ${st.model} ready. Rewrite in use: ${st.rewrite_in_use === "llm" ? "model-written (verified)" : "deterministic generator"}.`
    : "No ANTHROPIC_API_KEY on this server, so the model is off. Everything else works without it.";
  $("#llm-go").disabled = !st.available;
}
async function llmTranslate() {
  const out = $("#llm-out"), btn = $("#llm-go");
  btn.disabled = true; out.innerHTML = '<span class="muted">Asking the model and verifying each answer. This can take a minute…</span>';
  try {
    const r = await (await fetch("/api/llm/translate", { method: "POST" })).json();
    if (!r.available) { out.textContent = r.message; return; }
    out.innerHTML = `<div class="big ${r.accepted ? "pass" : "fail"}">${r.accepted ? "ACCEPTED" : "NOT ACCEPTED"}</div>
      <ul class="plain small">${r.attempts.map((a) => `<li><b>Attempt ${a.n}:</b> ${esc(a.stage)}${a.detail ? `<div class="muted mono" style="white-space:pre-wrap">${esc(a.detail.split("\n").slice(0, 3).join("\n"))}</div>` : ""}</li>`).join("")}</ul>
      <div class="small muted">${esc(r.note)}</div>`;
  } catch (e) { out.innerHTML = '<span class="fail">Request failed.</span>'; }
  btn.disabled = false;
}

/* ------------------------------------------------------------------ handoff tab */
async function renderHandoff() {
  const el = $("#handoff");
  if (!S.sim) { el.innerHTML = '<div class="card muted">Running the default scenario…</div>'; S.sim = await api("simulate", { profile: "single" }); }
  const h = S.sim.handoff;
  const root = h.root_cause;
  el.innerHTML = `
    <div class="card"><div class="row"><h3 style="margin:0">Shift handoff · generated automatically</h3><div class="spacer"></div><button class="btn" id="copy">Copy as text</button></div>
      <div style="font-size:17px;margin:10px 0">${esc(h.headline)}</div>
      <div class="small muted">Plan: ${h.plan.profile === "staged" ? "two-stage job start" : "full-power job start"}${h.plan.manual_ch2_at != null ? `, chiller 2 pre-started at t = ${h.plan.manual_ch2_at} s` : ""}.</div></div>
    <div class="two">
      <div class="card"><h3>Timeline</h3><div class="tl">${h.timeline.map((e) => `<div class="e ${e.level}"><span class="mono muted">${rel(e.t, h.plan.job_start)}</span> ${esc(e.title)}</div>`).join("")}</div></div>
      <div>
        ${root ? `<div class="card"><h3>${esc(h.root_label)}</h3><div class="small"><span class="chip">${root.id} · lines ${rng(root.lines)}</span></div>
          <div style="margin:8px 0">${esc(root.english)}</div><ul class="plain small">${root.why.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
        ${h.related_tickets.length ? `<div class="card"><h3>Same pattern in earlier tickets</h3><ul class="plain small">${h.related_tickets.map((t) => `<li><b>${esc(t.id)}</b> (${esc(t.date)}): ${esc(t.text)}</li>`).join("")}</ul></div>` : ""}
        ${h.followups.length ? `<div class="card"><h3>Follow-ups for the next shift</h3><ul class="plain small">${h.followups.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}
      </div>
    </div>`;
  $("#copy").addEventListener("click", () => {
    const txt = [h.headline, "", "Timeline:", ...h.timeline.map((e) => `  ${rel(e.t, h.plan.job_start)}  ${e.title}`), "",
      root ? `Root cause (${root.id}, lines ${root.lines[0]}-${root.lines[1]}): ${root.english}` : "", "", "Follow-ups:", ...h.followups.map((f) => "  - " + f)].join("\n");
    navigator.clipboard?.writeText(txt);
    $("#copy").textContent = "Copied";
  });
  S.handoffStale = false;
}

/* ------------------------------------------------------------------ boot */
function showTab(name) {
  $$("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
  if (name === "handoff" && (S.handoffStale || !$("#handoff").innerHTML)) renderHandoff();
  if (name === "live") drawCharts(S.sim, S.sim ? S.sim.duration - 1 : 0);
  if (name === "rules") renderRules();
}

async function init() {
  S.st = await api("state");
  $$("#nav button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("#run").addEventListener("click", run);
  $("#skip").addEventListener("click", async () => { stop(); if (!S.sim || $("#run").disabled === false) S.sim = await api("simulate", planBody()); frame(S.sim.duration - 1); finish(); S.handoffStale = true; });
  $$('input[name="profile"], #prestart').forEach((el) => el.addEventListener("change", refreshVerdict));
  $("#prewarning").addEventListener("click", (e) => {
    const id = e.target.dataset?.apply;
    if (!id) return;
    if (id === "prestart_ch2") $("#prestart").checked = true;
    if (id === "staged_start") $('input[name="profile"][value="staged"]').checked = true;
    refreshVerdict();
  });
  $("#ask-go").addEventListener("click", ask);
  $("#ask-q").addEventListener("keydown", (e) => { if (e.key === "Enter") ask(); });
  $("#p-run").addEventListener("click", () => parity(null));
  $("#p-bug1").addEventListener("click", () => parity("off_by_one"));
  $("#p-bug2").addEventListener("click", () => parity("lockout"));
  $("#llm-go").addEventListener("click", llmTranslate);
  llmInit().catch(() => ($("#llm-status").textContent = "Status unavailable."));
  $("#v-old").innerHTML = lineHtml(S.st.legacy_source);
  $("#v-new").innerHTML = lineHtml(S.st.modern_source);
  renderRules();
  $("#prewarning").innerHTML = renderPrewarning(await api("prewarning", { profile: "single" }));
  await refreshVerdict();
  drawCharts(null, 0);
  window.addEventListener("resize", () => drawCharts(S.sim, S.sim ? S.sim.duration - 1 : 0));
}
init().catch((e) => { document.body.insertAdjacentHTML("beforeend", `<pre style="color:#ff5d5d;padding:20px">${esc(e.stack || e)}</pre>`); });
