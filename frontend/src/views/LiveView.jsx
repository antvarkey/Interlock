import { useEffect } from "react";
import Chart from "../components/Chart.jsx";
import { Trace } from "../components/Bits.jsx";
import { cap, fmt, rel } from "../lib/format.js";

/* ------------------------------------------------------------------ pre-warning dialog */
function PrewarningModal({ pw, busy, onChoose, onRule }) {
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onChoose("cancel"); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onChoose]);
  const crit = pw.level === "critical";
  return (
    <div className="backdrop" role="dialog" aria-modal="true" aria-labelledby="pw-title">
      <div className="modal" style={crit ? undefined : { borderColor: "var(--ok-line)" }}>
        <div className="mh">
          <div className="row">
            <span className={`chip ${crit ? "crit" : "ok"}`}><span className="led pulse" /> Pre-warning · before the job starts</span>
            <span className="chip mono">T−90s</span>
            {pw.rule && <Trace id={pw.rule.id} lines={pw.rule.lines} onClick={() => onRule(pw.rule.id)} />}
          </div>
          <h2 id="pw-title">{pw.title}</h2>
          <p className="muted" style={{ marginTop: 8 }}>{crit ? "Predicted by running the rules extracted from the original controller forward in the plant simulator. This is what happens if nobody acts." : pw.summary}</p>
        </div>
        {crit && (
          <div className="mb">
            <div>
              <div className="eyebrow">Evidence</div>
              <ul>{pw.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
              {pw.tickets?.length > 0 && (
                <>
                  <div className="eyebrow" style={{ marginTop: 18 }}>Seen before</div>
                  <div className="row" style={{ marginTop: 8, gap: 6 }}>
                    {pw.tickets.map((t) => <span key={t.id} className="chip mono" title={t.text}>{t.id}</span>)}
                  </div>
                  <p className="faint small" style={{ marginTop: 6 }}>{pw.tickets.length} past incidents closed as “cause unknown” match this rule.</p>
                </>
              )}
              {pw.watchouts?.length > 0 && (
                <>
                  <div className="eyebrow" style={{ marginTop: 18 }}>Watch out</div>
                  <ul>{pw.watchouts.map((w) => <li key={w}>{w}</li>)}</ul>
                </>
              )}
            </div>
            <div>
              <div className="eyebrow">Steps that avoid it · each checked in simulation</div>
              {pw.steps.map((s, i) => (
                <div className="mstep" key={s.id}>
                  <div className="t"><span className="mono faint">0{i + 1}</span>{s.title}<span className="sp" />
                    <span className={`chip ${s.avoids_trip ? "ok" : "crit"}`}>{s.avoids_trip ? "✓ Avoids the trip" : "Does not avoid it"}</span></div>
                  <p>{s.how}</p>
                  <div className="sim"><span>peak {fmt(s.peak_temp_c, 1)} °C</span><span>peak {fmt(s.peak_facility_kw)} kW</span>{s.power_cap_margin_kw != null && <span>{fmt(s.power_cap_margin_kw)} kW under cap</span>}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="mf">
          {crit ? (
            <>
              <button className="btn primary" disabled={busy} onClick={() => onChoose("prestart")}>Pre-start chiller 2</button>
              <button className="btn primary" disabled={busy} onClick={() => onChoose("staged")}>Start in two stages</button>
              <button className="btn" disabled={busy} onClick={() => onChoose("both")}>Do both</button>
              <span className="sp" />
              <button className="btn" data-pick="ignore" disabled={busy} onClick={() => onChoose("ignore")}>Ignore and start anyway</button>
              <button className="btn ghost" disabled={busy} onClick={() => onChoose("cancel")}>Cancel</button>
            </>
          ) : (
            <>
              <button className="btn primary" onClick={() => onChoose("ignore")}>Start the job</button>
              <button className="btn ghost" onClick={() => onChoose("cancel")}>Cancel</button>
            </>
          )}
        </div>
        <div className="guard" style={{ padding: "0 26px 16px" }}>
          <span className="led" style={{ color: "var(--accent)" }} /> Interlock recommends; it never actuates. A person approves every step.
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ live alert panel */
function AlertPanel({ m, onOverride, onAck, onRule, lockLeft }) {
  const a = m.alert, sim = m.sim;
  const canOverride = m.phase === "running" && !m.busy && m.plan.lead == null && m.overrideAt == null;

  if (m.phase === "idle" || m.phase === "briefing" || (!a && m.phase !== "done")) {
    const running = m.phase === "running";
    const p = sim?.prediction;
    return (
      <section className={`alertpanel ${running ? "live" : ""}`} aria-label="Live alert">
        <div className="head"><span className={`led ${running ? "pulse" : ""}`} /><span className="eyebrow" style={{ color: "inherit" }}>Live alert · {running ? "monitoring" : "armed"}</span></div>
        <div className="body">
          <h3>{running ? (mitigatedLabel(m) || "Watching the ramp") : "No active alerts"}</h3>
          <p className="lead">
            {running && p
              ? p.will_trip
                ? `Forecast with this plan: rule ${p.primary.rule} acts about ${p.trip_after_start_s} s after the job starts.`
                : `Forecast with this plan: no protective rule fires. Peak supply temperature ${fmt(p.peak_temp_c, 1)} °C.`
              : "Interlock watches the scheduler for queued jobs and the power meters for the ramp, then checks the extracted rules to predict a trip."}
          </p>
          <ul className="watchlist">
            <li><span className="chip accent mono">SCHED</span>Job queue · Cluster B</li>
            <li><span className="chip accent mono">PWR</span>Facility meters · 1 s scan, alert on +100 kW / 3 s</li>
            <li><span className="chip accent mono">RULES</span>Protective rules R1, R6 from chw_sequencer.st</li>
          </ul>
          {running && (
            <div className="actions">
              <button className="btn" disabled={!canOverride} onClick={onOverride}>
                {m.plan.lead != null || m.overrideAt != null ? "Chiller 2 override is on" : "Start chiller 2 now (manual override)"}
              </button>
            </div>
          )}
        </div>
      </section>
    );
  }

  if (!a && m.phase === "done") {
    return (
      <section className="alertpanel ok" aria-label="Live alert">
        <div className="head"><span className="led" /><span className="eyebrow" style={{ color: "inherit" }}>Live alert · clear</span></div>
        <div className="body"><h3>No alert was needed</h3><p className="lead">The plan kept every protective rule from firing.</p></div>
      </section>
    );
  }

  if (a.state === "active") {
    const left = Math.max(0, a.deadline - m.t);
    const total = a.deadline - a.t || 1;
    const eta = Math.max(0, Math.ceil(a.tripAt - m.t));
    return (
      <section className={`alertpanel crit ${m.acked ? "" : "unacked"}`} aria-label="Live alert" role="alert">
        <div className="head"><span className="led pulse" /><span className="eyebrow" style={{ color: "inherit" }}>Live alert · act now</span><span className="sp" />
          <Trace id={a.rule.id} lines={a.rule.lines} onClick={() => onRule(a.rule.id)} /></div>
        <div className="body">
          <h3>Power spike detected. {cap(a.rule.interrupts?.[0] || "a protective trip")} in about {eta} s.</h3>
          <div className="countdown">
            <div className="big num" data-testid="act-within">{Math.ceil(left)}<small>s</small></div>
            <div className="lbl"><b>Window to prevent the trip</b>Starting chiller 2 inside this window is verified in simulation to avoid it.</div>
          </div>
          <div className="meter"><i style={{ width: `${(left / total) * 100}%` }} /></div>
          <div className="actions">
            <button className="btn danger lg" id="opCh2" disabled={!canOverride} onClick={onOverride}>{m.busy ? "Applying…" : "Start chiller 2 now"}</button>
            <button className="btn" id="opAck" disabled={m.acked} onClick={onAck}>{m.acked ? "Acknowledged" : "Acknowledge"}</button>
          </div>
          <p className="hint">{a.summary}</p>
        </div>
      </section>
    );
  }

  if (a.state === "closed") {
    const eta = Math.max(0, Math.ceil(a.tripAt - m.t));
    return (
      <section className={`alertpanel crit ${m.acked ? "" : "unacked"}`} aria-label="Live alert" role="alert">
        <div className="head"><span className="led pulse" /><span className="eyebrow" style={{ color: "inherit" }}>Live alert · window closed</span><span className="sp" />
          <Trace id={a.rule.id} lines={a.rule.lines} onClick={() => onRule(a.rule.id)} /></div>
        <div className="body">
          <h3>Too late to prevent the trip. Prepare to recover.</h3>
          <div className="countdown">
            <div className="big num">{eta}<small>s</small></div>
            <div className="lbl"><b>Until rule {a.rule.id} stops the cooling loop</b>Checkpoint or pause training jobs now. Do not attempt a restart before the lockout ends.</div>
          </div>
          <div className="actions">
            <button className="btn" disabled={!canOverride} onClick={onOverride}>Start chiller 2 anyway (shortens the outage)</button>
            <button className="btn" disabled={m.acked} onClick={onAck}>{m.acked ? "Acknowledged" : "Acknowledge"}</button>
          </div>
          <p className="hint">This is why the pre-warning matters: once the ramp is visible, there are only a few seconds left.</p>
        </div>
      </section>
    );
  }

  if (a.state === "tripped") {
    return (
      <section className="alertpanel crit" aria-label="Live alert" role="alert">
        <div className="head"><span className="led pulse" /><span className="eyebrow" style={{ color: "inherit" }}>Incident · cooling loop tripped</span><span className="sp" />
          <Trace id={a.rule.id} lines={a.rule.lines} onClick={() => onRule(a.rule.id)} /></div>
        <div className="body">
          <h3>Rule {a.rule.id} stopped the pumps at {rel(a.trippedAt, sim.job_start)}.</h3>
          <div className="countdown">
            <div className="big num">{lockLeft}<small>s</small></div>
            <div className="lbl"><b>Restart lockout remaining</b>The code uses 300 s. The runbook says 2 minutes. The runbook is wrong.</div>
          </div>
          <div className="meter"><i style={{ width: `${(lockLeft / 300) * 100}%` }} /></div>
          <dl className="kvs">
            <dt>Supply temperature</dt><dd>{fmt(sim.series.temp[Math.min(Math.floor(m.t), sim.duration - 1)], 1)} °C</dd>
            <dt>Matches past incidents</dt><dd>INC-2291, 2347, 2402, 2503</dd>
          </dl>
          <div className="actions">
            <button className="btn" disabled={!canOverride} onClick={onOverride}>Start chiller 2 (helps recovery)</button>
          </div>
        </div>
      </section>
    );
  }

  if (a.state === "recovered") {
    return (
      <section className="alertpanel warn" aria-label="Live alert">
        <div className="head"><span className="led" /><span className="eyebrow" style={{ color: "inherit" }}>Recovering</span></div>
        <div className="body"><h3>Lockout ended. Pumps restarting.</h3><p className="lead">The job was lost and must be resubmitted. The shift handoff has the root cause.</p></div>
      </section>
    );
  }

  // resolved or clear
  return (
    <section className="alertpanel ok" aria-label="Live alert">
      <div className="head"><span className="led" /><span className="eyebrow" style={{ color: "inherit" }}>Live alert · {a.state === "resolved" ? "resolved" : "clear"}</span></div>
      <div className="body">
        <h3>{a.state === "resolved" ? `Trip avoided. Override applied at ${rel(a.resolvedAt, sim.job_start)}.` : "Ramp detected. No protective rule is predicted to fire."}</h3>
        <p className="lead">{a.state === "resolved" ? "Chiller 2 is starting. Interlock re-ran the rules with the override on and no protective rule fires." : a.summary}</p>
      </div>
    </section>
  );
}

const mitigatedLabel = (m) =>
  m.plan.choice === "both" ? "Plan on: chiller 2 pre-start and staged job" :
  m.plan.choice === "prestart" ? "Plan on: chiller 2 pre-start" :
  m.plan.choice === "staged" ? "Plan on: two-stage job start" :
  m.overrideAt != null ? "Chiller 2 override on" : null;

/* ------------------------------------------------------------------ page */
export default function LiveView({ st, sc, ghost, onRule }) {
  const { m } = sc;
  const P = st.plant, cap_kw = st.facts.power_cap_kw;
  const sim = m.sim;
  const js = P.job_start_s;
  const i = sim ? Math.min(Math.floor(m.t), sim.duration - 1) : 0;
  const s = sim?.series;
  const temp = s ? s.temp[i] : P.setpoint_c;
  const it = s ? s.it_kw[i] : P.idle_kw;
  const fac = s ? s.fac_kw[i] : P.idle_kw * (1 + P.chiller_kw_per_kw) + P.pump_kw;
  const pumps = s ? s.pumps[i] : true;
  const capNow = s ? (pumps ? s.cap_kw[i] : 0) : P.chiller_cap_kw;
  const ch2 = s ? s.ch2_running[i] : false;
  const recoveryT = sim?.events.find((e) => e.type === "recovery")?.t;
  const lockLeft = !pumps && recoveryT ? Math.max(0, recoveryT - i) : 0;
  const ch2Cmd = sim && ((m.plan.lead != null && i >= js - m.plan.lead) || (m.overrideAt != null && i >= m.overrideAt));

  const tCls = temp >= P.throttle_c ? "crit" : temp >= P.setpoint_c + 2 ? "warn" : "";
  const tiles = [
    { k: "Supply temp", v: fmt(temp, 1), u: "°C", s: `setpoint ${P.setpoint_c} °C · throttle ${P.throttle_c}`, cls: tCls, bar: (temp - 5) / (P.shutdown_c - 5) },
    { k: "IT load", v: fmt(it), u: "kW", s: (sim && i > js && it < 5) || temp >= P.shutdown_c ? "GPUs shut down" : temp >= P.throttle_c ? "GPUs throttling" : it > P.idle_kw + 50 ? "training ramp" : "cluster idle", cls: temp >= P.throttle_c ? "crit" : "", bar: it / P.full_kw },
    { k: "Cooling capacity", v: fmt(capNow), u: "kW", s: it > capNow + 20 ? `${fmt(it - capNow)} kW short` : "headroom ok", cls: !pumps ? "crit" : it > capNow + 20 ? "warn" : "", bar: capNow / (P.chiller_cap_kw * 2) },
    { k: "Facility power", v: fmt(fac), u: "kW", s: `cap ${fmt(cap_kw)} kW`, cls: fac > cap_kw ? "crit" : fac > cap_kw - 120 ? "warn" : "", bar: fac / cap_kw },
    { k: "Chiller 2", v: ch2 ? "Online" : ch2Cmd ? "Starting" : "Standby", u: "", s: ch2Cmd ? "manual override on" : "auto staging after 90 s", cls: ch2 ? "ok" : ch2Cmd ? "warn" : "" },
    { k: "Cooling loop", v: pumps ? "Running" : "Tripped", u: "", s: pumps ? "pumps on" : `restart in ${lockLeft} s`, cls: pumps ? "" : "crit" },
  ];

  // phase stepper
  const a = m.alert;
  const stepState = (n) => {
    const now = m.phase === "idle" ? 0 : m.phase === "briefing" ? 1 : m.phase === "done" ? 4 : i < js ? 2 : 3;
    if (n === 3 && a && ["active", "closed", "tripped"].includes(a.state)) return n <= now ? "bad" : "";
    if (n === 4 && m.phase === "done") return m.outcome?.tripped ? "bad" : "good";
    return n < now ? "done" : n === now ? "now" : "";
  };
  const steps = ["Job queued", "Pre-warning", "Job start T+0", "Ramp · live alert", "Outcome"];

  const markers = sim ? sim.events.filter((e) => ["live_alert", "rule_fired", "action", "impact"].includes(e.type) && e.t > 0).map((e) => ({
    t: e.t,
    label: e.type === "live_alert" ? "alert" : e.type === "rule_fired" ? (e.title.match(/R\d+/) || ["trip"])[0] + " trip" : e.type === "action" ? "operator" : /shut/.test(e.title) ? "shutdown" : "throttle",
    color: e.type === "action" ? "var(--accent)" : e.type === "live_alert" ? "var(--warn)" : "var(--crit)",
  })) : [];
  const upTo = sim ? Math.floor(m.t) + 1 : 0;

  return (
    <>
      <div className="card command">
        <div>
          <div className="eyebrow"><span className="n">01</span>Live operations · Cluster B training job</div>
          <h2 style={{ marginTop: 10 }}>
            {m.phase === "idle" && "A large training job is queued on an idle cluster."}
            {m.phase === "briefing" && "Pre-warning issued. Waiting for an operator decision."}
            {m.phase === "running" && (i < js ? "Job starting soon. Plan locked in." : "Job running. Interlock is watching the ramp.")}
            {m.phase === "done" && (m.outcome?.tripped ? "Run finished: the job was lost to a cooling trip." : "Run finished: no cooling trip.")}
          </h2>
          <p className="sub">IT power goes from {fmt(P.idle_kw)} kW to {fmt(P.full_kw)} kW in about {P.ramp_s} s. One chiller removes {fmt(P.chiller_cap_kw)} kW. Plant numbers are illustrative placeholders.</p>
        </div>
        <div className="ctrl">
          <div className="clock"><small>Job clock</small><span data-testid="clock">{rel(i, js)}</span></div>
          {m.phase === "running"
            ? <button className="btn" onClick={sc.skip}>Skip to end</button>
            : <button className="btn live lg" id="go" disabled={m.phase === "briefing"} onClick={sc.queue}>{m.phase === "done" ? "Run again" : "Queue training job"} <span className="arrow">→</span></button>}
          <button className="btn ghost" disabled={m.phase === "idle"} onClick={sc.reset}>Reset</button>
        </div>
        <div className="stepper">
          {steps.map((label, n) => <div key={label} className={stepState(n)}><span className="n">0{n + 1}</span>{label}</div>)}
        </div>
      </div>

      <div className="tiles">
        {tiles.map((t) => (
          <div key={t.k} className={`tile ${t.cls}`}>
            <div className="k">{t.k}</div>
            <div className="v">{t.v}{t.u && <small>{t.u}</small>}</div>
            <div className="s">{t.s}</div>
            {t.bar != null && <div className="bar"><i style={{ width: `${Math.max(0, Math.min(1, t.bar)) * 100}%` }} /></div>}
          </div>
        ))}
      </div>

      <div className="live-grid">
        <div className="stack">
          <div className="card">
            <div className="card-h"><h3>Chilled-water supply temperature</h3><span className="sp" /><span className="chip mono">°C</span></div>
            <Chart duration={P.duration_s} jobStart={js} yMin={5} yMax={20} unit="°C" cursor={sim ? i : null} markers={markers}
              hlines={[{ y: P.throttle_c, color: "var(--warn)", label: `throttle ${P.throttle_c}` }, { y: P.shutdown_c, color: "var(--crit)", label: `shutdown ${P.shutdown_c}` }]}
              series={[
                { id: "ghost", data: ghost?.series.temp || [], color: "var(--ink-3)", dash: "5 5", width: 1.5, opacity: 0.7 },
                ...(s ? [{ id: "temp", data: s.temp, upTo, color: "var(--accent)", fill: true }] : []),
              ]} />
            <div className="legend">
              <span><i style={{ borderColor: "var(--accent)" }} />This run</span>
              <span><i style={{ borderColor: "var(--ink-3)", borderTopStyle: "dashed" }} />Forecast if nobody acts</span>
              <span><i style={{ borderColor: "var(--warn)", borderTopStyle: "dotted" }} />GPU throttle</span>
              <span><i style={{ borderColor: "var(--crit)", borderTopStyle: "dotted" }} />GPU shutdown</span>
            </div>
          </div>
          <div className="card">
            <div className="card-h"><h3>Heat to remove vs. cooling available</h3><span className="sp" /><span className="chip mono">kW</span></div>
            <Chart duration={P.duration_s} jobStart={js} yMin={0} yMax={2000} unit="kW" cursor={sim ? i : null}
              hlines={[{ y: cap_kw, color: "var(--crit)", label: `facility cap ${fmt(cap_kw)}` }]}
              series={s ? [
                { id: "cap", data: s.cap_kw.map((v, k) => (s.pumps[k] ? v : 0)), upTo, color: "var(--ok)", fill: true },
                { id: "fac", data: s.fac_kw, upTo, color: "#8f7cf0", width: 1.5 },
                { id: "it", data: s.it_kw, upTo, color: "var(--accent)" },
              ] : []} />
            <div className="legend">
              <span><i style={{ borderColor: "var(--accent)" }} />IT load (heat)</span>
              <span><i style={{ borderColor: "var(--ok)" }} />Cooling capacity</span>
              <span><i style={{ borderColor: "#8f7cf0" }} />Facility power</span>
            </div>
          </div>
        </div>

        <div className="stack">
          <AlertPanel m={m} onOverride={sc.override} onAck={sc.ack} onRule={onRule} lockLeft={lockLeft} />
          <div className="card">
            <div className="card-h"><h3>Event log</h3><span className="sp" /><span className="faint small">{m.log.length} events</span></div>
            <ul className="feed" id="feed">
              {m.log.length === 0 && <li><span /><span /><span className="faint">Nothing has happened yet. Queue the job to begin.</span></li>}
              {m.log.map((e, k) => (
                <li key={m.log.length - k} className={e.kind}><span className="ts">{rel(e.t, js)}</span><span className="d" /><span className="tx">{e.text}</span></li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {m.phase === "done" && m.outcome && (
        <div className="card result" id="result">
          <div className={`verdict ${m.outcome.tripped ? "crit" : "ok"}`}>{m.outcome.tripped ? "Cooling trip" : "No trip"}</div>
          <div className="stats">
            <div><b>{fmt(m.outcome.peak_temp_c, 1)} °C</b>peak supply temperature</div>
            <div><b>{fmt(m.outcome.peak_facility_kw)} kW</b>peak facility power</div>
            <div><b>{fmt(m.outcome.power_cap_margin_kw)} kW</b>margin to the cap</div>
            {m.outcome.tripped && <div><b>{fmt(m.outcome.lostS / 60, 1)} min</b>GPUs down</div>}
          </div>
          <button className="btn" onClick={() => onRule(null, "handoff")}>Open shift handoff <span className="arrow">→</span></button>
        </div>
      )}

      {m.phase === "briefing" && m.prewarning && <PrewarningModal pw={m.prewarning} busy={m.busy} onChoose={sc.choose} onRule={(id) => { sc.choose("cancel"); onRule(id); }} />}
    </>
  );
}
