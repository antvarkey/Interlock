import { useEffect, useState } from "react";
import { PageHead } from "../components/Bits.jsx";
import { api } from "../lib/api.js";
import { fmt } from "../lib/format.js";

const BUGS = [
  { id: "off_by_one", label: "Break it: trip after 21 scans, not 20" },
  { id: "lockout", label: "Break it: lockout 120 s, not 300 s" },
];

export default function VerifyView({ st, notify }) {
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [llm, setLlm] = useState(null);
  const [llmRes, setLlmRes] = useState(null);

  const run = async (bug = null) => {
    setBusy(true);
    try {
      const r = await api.parity(2000, bug);
      setRes(r);
      if (bug && !r.passed) notify({ sev: "crit", title: "Parity check failed", body: `${r.injected_bug}. The rewrite must not be deployed until this is fixed.` });
    } catch (e) { setRes({ error: String(e.message || e) }); }
    setBusy(false);
  };

  useEffect(() => {
    run();
    api.llmStatus().then(setLlm).catch(() => setLlm({ available: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const translate = async () => {
    setLlmRes({ pending: true });
    try { setLlmRes(await api.llmTranslate()); } catch (e) { setLlmRes({ error: String(e.message || e) }); }
  };

  const mx = res?.coverage ? Math.max(...Object.values(res.coverage), 1) : 1;

  return (
    <>
      <PageHead n="03" eyebrow="Verification · old code vs. rewrite" dim="A rewrite is only safe" title="if it behaves exactly like the original.">
        Both versions run on the same generated sensor sequences. Every output, every internal variable and the list of rules that fired is compared on every scan.
      </PageHead>

      <div className="verify-grid">
        <div className="card" id="vout">
          <div className="row">
            <span className="eyebrow">Differential test</span><span className="sp" />
            <button className="btn primary" id="vrun" disabled={busy} onClick={() => run()}>Run parity test</button>
          </div>
          {busy ? <div className="progress"><i /></div> : <div className="divider" />}
          {!res && <p className="faint">Running…</p>}
          {res?.error && <p style={{ color: "var(--crit)" }}>{res.error}</p>}
          {res && !res.error && (
            <>
              <div className={`verdict-big ${res.passed ? "ok" : "crit"}`}>{res.passed ? "No differences" : "Mismatch found"}</div>
              <p className="muted" style={{ marginTop: 10 }}>
                {res.passed
                  ? `Verified across ${fmt(res.scans)} control scans in ${fmt(res.sequences)} generated scenarios. ${res.rules_covered} of ${res.rules_total} rules exercised.`
                  : `${fmt(res.mismatch_sequences)} of ${fmt(res.sequences)} scenarios diverge. Planted change: ${res.injected_bug}.`}
              </p>
              <p className="faint small" style={{ marginTop: 6 }}>Checked in {res.seconds} s. A pass is strong evidence of identical behaviour on the tested inputs, not a proof.</p>
              {res.first_mismatches?.length > 0 && (() => {
                const f = res.first_mismatches[0];
                return (
                  <>
                    <div className="eyebrow" style={{ marginTop: 18 }}>First difference · scenario {f.sequence}, scan {f.scan}</div>
                    <table className="diff">
                      <thead><tr><th>Field</th><th>Original</th><th>Rewrite</th></tr></thead>
                      <tbody>{f.diffs.map((d) => <tr key={d.field}><td>{d.field}</td><td>{JSON.stringify(d.legacy)}</td><td style={{ color: "var(--crit)" }}>{JSON.stringify(d.modern)}</td></tr>)}</tbody>
                    </table>
                  </>
                );
              })()}
            </>
          )}
          <div className="divider" />
          <div className="eyebrow" style={{ marginBottom: 10 }}>Show the test catching a mistake</div>
          <div className="row" id="bugs">
            {BUGS.map((b) => <button key={b.id} className="btn sm" data-bug={b.id} disabled={busy} onClick={() => run(b.id)}>{b.label}</button>)}
          </div>
        </div>

        <div className="card">
          <div className="eyebrow" style={{ marginBottom: 12 }}>Rule coverage in the generated scenarios</div>
          {!res?.coverage && <p className="faint small">Run the test to see how often each rule fired.</p>}
          {res?.coverage && Object.entries(res.coverage).map(([id, n]) => (
            <div className="cov" key={id}><b className="mono">{id}</b>
              <div className="b"><i style={{ width: `${n ? Math.max(2, (Math.sqrt(n) / Math.sqrt(mx)) * 100) : 0}%` }} /></div>
              <span className="mono faint" style={{ textAlign: "right" }}>{fmt(n)}</span></div>
          ))}
          <div className="divider" />
          <div className="eyebrow" style={{ marginBottom: 12 }}>Where the AI is used · the model proposes, the test decides</div>
          <ol className="steps3">
            <li><span className="n">01</span><span><b>Rewrite proposal.</b> Reads the old code and writes a modern version. Screened for unsafe code, then compared with the original on generated and held-out scenarios. Failures go back to the model with the first difference, up to 4 tries.</span></li>
            <li><span className="n">02</span><span><b>Glossary draft.</b> Suggests plain names for cryptic tags. A person approves them.</span></li>
            <li><span className="n">03</span><span><b>Operator Q&amp;A.</b> Answers only from the extracted rules, findings and tickets.</span></li>
          </ol>
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn" disabled={!llm?.available || llmRes?.pending} onClick={translate}>Ask the model for a rewrite</button>
            <span className="faint small" style={{ flex: 1 }}>
              {!llm ? "Checking…" : llm.available ? `Model ready. Rewrite in use: ${llm.rewrite_in_use === "llm" ? "model-written (verified)" : "deterministic generator"}.` : "No ANTHROPIC_API_KEY on the server, so the model is off. Everything else works without it."}
            </span>
          </div>
          {llmRes && !llmRes.pending && (
            <div style={{ marginTop: 12 }} className="small">
              {llmRes.error || llmRes.message || (
                <>
                  <b style={{ color: llmRes.accepted ? "var(--ok)" : "var(--crit)" }}>{llmRes.accepted ? "Accepted" : "Not accepted"}</b>
                  <ul>{llmRes.attempts?.map((a) => <li key={a.n}>Attempt {a.n}: {a.stage}</li>)}</ul>
                  <span className="faint">{llmRes.note}</span>
                </>
              )}
            </div>
          )}
          {llmRes?.pending && <div className="progress"><i /></div>}
        </div>
      </div>

      <div className="two">
        <div className="card"><div className="row" style={{ marginBottom: 12 }}><span className="eyebrow">Original · Structured Text</span><span className="sp" /><span className="chip mono">{st.legacy_source.split("\n").length} lines</span></div>
          <div className="code">{st.legacy_source.split("\n").map((l, k) => <div key={k}><i>{k + 1}</i>{l || " "}</div>)}</div></div>
        <div className="card"><div className="row" style={{ marginBottom: 12 }}><span className="eyebrow">Rewrite · generated Python</span><span className="sp" /><span className="chip mono">{st.modern_source.split("\n").length} lines</span></div>
          <div className="code">{st.modern_source.split("\n").map((l, k) => <div key={k}><i>{k + 1}</i>{l || " "}</div>)}</div></div>
      </div>
    </>
  );
}
