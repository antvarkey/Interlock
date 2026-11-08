import { useState } from "react";
import { PageHead, Trace } from "../components/Bits.jsx";
import { lineSpan, rel } from "../lib/format.js";

/* The shift handoff. After a run it merges the backend's generated handoff with the operator
   actions recorded in the dashboard (acknowledgements, overrides). Before a run it shows the
   pre-job briefing, so the page is never empty. */
export default function HandoffView({ st, sc, onRule }) {
  const { m } = sc;
  const [copied, setCopied] = useState("");
  const h = m.phase === "done" ? m.sim.handoff : null;
  const pw = m.prewarning || st.baseline;
  const js = st.plant.job_start_s;

  // operator actions captured on the dashboard, oldest first
  const timeline = h ? [...m.log].reverse().map((e) => ({ t: e.t, title: e.text, level: e.kind === "crit" ? "critical" : e.kind })) : [];

  const text = () => {
    if (!h) {
      return ["PRE-JOB BRIEFING — Cluster B cooling, Hall 2", "", `PREDICTION: ${pw.title}.`, ...pw.evidence.map((e) => `  - ${e}`), "",
        "VERIFIED STEPS", ...pw.steps.map((s, k) => `  ${k + 1}. ${s.title}: ${s.how}`), "", "WATCH OUT", ...pw.watchouts.map((w) => `  - ${w}`)].join("\n");
    }
    const r = h.root_cause;
    return ["SHIFT HANDOFF — Cluster B cooling, Hall 2", "", h.headline, "", "WHAT HAPPENED", ...timeline.map((e) => `  ${rel(e.t, js).padEnd(7)} ${e.title}`), "",
      r ? `${h.root_label.toUpperCase()} (${r.id}, lines ${r.lines[0]}-${r.lines[1]}): ${r.english}` : "", ...(r ? r.why.map((w) => `  - ${w}`) : []), "",
      h.related_tickets.length ? `SAME PATTERN IN EARLIER TICKETS: ${h.related_tickets.map((t) => t.id).join(", ")}` : "", "",
      "FOLLOW-UPS", ...h.followups.map((f, k) => `  ${k + 1}. ${f}`)].join("\n");
  };
  const copy = () => {
    navigator.clipboard?.writeText(text()).then(() => setCopied("Copied to clipboard."), () => setCopied("Copy was blocked. Select the text instead."));
  };

  if (!h) {
    return (
      <>
        <PageHead n="04" eyebrow="Shift handoff · generated" dim="No run yet." title="Here is the pre-job briefing."
          right={<button className="btn" onClick={copy} id="copy">Copy briefing</button>}>
          Run the scenario on Live operations and this page becomes the shift handoff: what happened, the rule behind it, earlier tickets with the same cause, and follow-ups.
        </PageHead>
        {copied && <p className="faint small" style={{ marginBottom: 12 }}>{copied}</p>}
        <div className="handoff-grid">
          <div className="card">
            <div className="row"><span className="eyebrow">Prediction</span><span className="sp" />{pw.rule && <Trace id={pw.rule.id} lines={pw.rule.lines} onClick={() => onRule(pw.rule.id)} />}</div>
            <p className="headline">{pw.title}.</p>
            <ul className="muted" style={{ paddingLeft: 18, marginTop: 12 }}>{pw.evidence.map((e) => <li key={e} style={{ margin: "5px 0" }}>{e}</li>)}</ul>
          </div>
          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 12 }}>Verified steps</div>
            <ol className="steps3">{pw.steps.map((s, k) => <li key={s.id}><span className="n">0{k + 1}</span><span><b>{s.title}.</b> {s.how}</span></li>)}</ol>
            <div className="divider" />
            <div className="eyebrow" style={{ marginBottom: 6 }}>Watch out</div>
            {pw.watchouts.map((w) => <div key={w} className="finding">{w}</div>)}
          </div>
        </div>
      </>
    );
  }

  const r = h.root_cause;
  return (
    <>
      <PageHead n="04" eyebrow="Shift handoff · generated from this run" dim="Cluster B cooling, Hall 2." title={m.outcome.tripped ? "The job was lost to a cooling trip." : "The job ran without a cooling trip."}
        right={<button className="btn primary" onClick={copy} id="copy">Copy handoff</button>}>
        {h.headline} Plan: {h.plan.profile === "staged" ? "two-stage job start" : "full-power job start"}{h.plan.manual_ch2_at != null ? `, chiller 2 override at ${rel(h.plan.manual_ch2_at, js)}` : ""}.
      </PageHead>
      {copied && <p className="faint small" style={{ marginBottom: 12 }}>{copied}</p>}
      <div className="handoff-grid" id="hand">
        <div className="card">
          <div className="eyebrow" style={{ marginBottom: 14 }}>What happened · including operator actions</div>
          <ul className="timeline">
            {timeline.map((e, k) => <li key={k} className={e.level}><span className="ts">{rel(e.t, js)}</span>{e.title}</li>)}
          </ul>
        </div>
        <div className="stack">
          {r && (
            <div className="card">
              <div className="row"><span className="eyebrow">{h.root_label}</span><span className="sp" /><Trace id={r.id} lines={r.lines} onClick={() => onRule(r.id)} /></div>
              <p className="english" style={{ marginTop: 12, fontSize: 17 }}>{r.english}</p>
              <ul className="muted small" style={{ paddingLeft: 18, marginTop: 10 }}>{r.why.map((w) => <li key={w} style={{ margin: "4px 0" }}>{w}</li>)}</ul>
              <p className="faint small">Source: legacy/chw_sequencer.st {lineSpan(r.lines)}</p>
            </div>
          )}
          {h.related_tickets.length > 0 && (
            <div className="card">
              <div className="eyebrow" style={{ marginBottom: 6 }}>Same pattern in earlier tickets</div>
              {h.related_tickets.map((t) => <div key={t.id} className="ticket"><span className="id">{t.id}</span><span className="faint mono small">{t.date}</span><div className="muted" style={{ marginTop: 3 }}>{t.text}</div></div>)}
            </div>
          )}
          {h.followups.length > 0 && (
            <div className="card">
              <div className="eyebrow" style={{ marginBottom: 12 }}>Follow-ups for the next shift</div>
              <ol className="steps3">{h.followups.map((f, k) => <li key={f}><span className="n">0{k + 1}</span><span>{f}</span></li>)}</ol>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
