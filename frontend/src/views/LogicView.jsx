/* 02 · Rules & verification: what the old code does, in plain English, and the proof that the
   rewrite behaves the same. */
import { useEffect, useState } from "react";
import { PageHead } from "../components/Bits.jsx";
import RuleSheet from "../components/RuleSheet.jsx";
import { api } from "../lib/api.js";
import { fmt } from "../lib/format.js";

const BUGS = [
  { id: "off_by_one", label: "Break it: trip after 21 scans, not 20" },
  { id: "lockout", label: "Break it: lockout 120 s, not 300 s" },
];

function AskBox() {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState(null);
  const ask = async () => {
    if (!q.trim()) return;
    setAnswer("Thinking…");
    try { setAnswer((await api.ask(q)).answer); } catch { setAnswer("Could not reach the server."); }
  };
  return (
    <div className="askbox">
      <div className="row">
        <input type="text" style={{ flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()}
          placeholder="Ask about the rules, e.g. why does cooling stop at job start?" aria-label="Ask about the rules" />
        <button className="btn" onClick={ask}>Ask</button>
      </div>
      {answer && <div className="answer anim-in">{answer}</div>}
    </div>
  );
}

export default function LogicView({ st, sel, setSel, notify }) {
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [codeMode, setCodeMode] = useState("side");

  const run = async (bug = null) => {
    setBusy(true);
    try {
      const r = await api.parity(2000, bug);
      setRes(r);
      if (bug && !r.passed) notify({ sev: "crit", title: "Parity check failed", body: `${r.injected_bug}. The rewrite must not be deployed until this is fixed.` });
    } catch (e) { setRes({ error: String(e.message || e) }); }
    setBusy(false);
  };
  useEffect(() => { run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const mism = st.findings.filter((f) => f.kind === "runbook_mismatch").length;
  const dead = st.findings.filter((f) => f.kind === "dead_input").length;
  const tickets = new Set(st.rules.flatMap((x) => x.tickets.map((t) => t.id))).size;
  const mx = res?.coverage ? Math.max(...Object.values(res.coverage), 1) : 1;

  return (
    <>
      <PageHead n="02" eyebrow="Rules & verification" dim="Decades-old control code," title="read as plain-English rules and proven against the rewrite." />

      <div className="summary stagger">
        <div><b>{st.rules.length}</b><span>rules extracted, each with source lines</span></div>
        <div><b style={{ color: "var(--warn)" }}>{mism}</b><span>places where the runbook disagrees with the code</span></div>
        <div><b>{dead}</b><span>dead rule tied to a retired sensor tag</span></div>
        <div><b style={{ color: "var(--accent)" }}>{tickets}</b><span>“cause unknown” incidents now explained</span></div>
        <div><b style={{ color: res?.passed ? "var(--ok)" : res && !res.error ? "var(--crit)" : "var(--ink-3)" }}>{res?.scans ? `${fmt(res.scans / 1000)}k` : "…"}</b>
          <span>{res ? (res.passed ? "scans with no difference, old vs. rewrite" : "scans checked, a difference was found") : "running the parity test"}</span></div>
      </div>

      {/* ------------------------------------------------ rules */}
      <section className="section">
        <div className="section-h"><h2><span className="n">A</span>Rules in plain English</h2><span className="sp" />
          <span className="faint small">Open any rule from anywhere with the Rules button in the top bar, or pop it out into its own window.</span></div>
        <AskBox />
        <div className="rules-grid">
          <div id="rlist" className="stagger">
            {st.rules.map((x) => (
              <button key={x.id} className="rcard" data-r={x.id} aria-pressed={x.id === sel} onClick={() => setSel(x.id)}>
                <div className="h">
                  <span className="trace"><b>{x.id}</b><span>L{x.lines[0]}{x.lines[1] !== x.lines[0] ? `–${x.lines[1]}` : ""}</span></span>
                  {x.protective && <span className="chip crit">Interrupts cooling or load</span>}
                  {x.findings.length > 0 && <span className="chip warn">{x.findings.length} finding{x.findings.length > 1 ? "s" : ""}</span>}
                </div>
                <p>{x.english}</p>
              </button>
            ))}
          </div>
          <div className="card" id="detail"><RuleSheet st={st} id={sel} onSelect={setSel} /></div>
        </div>
      </section>

      {/* ------------------------------------------------ verification */}
      <section className="section">
        <div className="section-h"><h2><span className="n">B</span>Verification</h2><span className="sp" />
          <span className="faint small">Every output, internal variable and rule fired is compared on every scan.</span></div>
        <div className="verify-grid">
          <div className="card" id="vout">
            <div className="row">
              <span className="eyebrow">Differential test · old code vs. rewrite</span><span className="sp" />
              <button className="btn primary" id="vrun" disabled={busy} onClick={() => run()}>Run parity test</button>
            </div>
            {busy ? <div className="progress"><i /></div> : <div className="divider" />}
            {!res && <p className="faint">Running…</p>}
            {res?.error && <p style={{ color: "var(--crit)" }}>{res.error}</p>}
            {res && !res.error && (
              <div className="anim-in" key={`${res.passed}-${res.injected_bug}`}>
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
              </div>
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
              <div className="cov" key={id}><button className="linkish mono" onClick={() => setSel(id)}>{id}</button>
                <div className="b"><i style={{ width: `${n ? Math.max(2, (Math.sqrt(n) / Math.sqrt(mx)) * 100) : 0}%` }} /></div>
                <span className="mono faint" style={{ textAlign: "right" }}>{fmt(n)}</span></div>
            ))}
            <div className="divider" />
            <div className="eyebrow" style={{ marginBottom: 12 }}>Where the AI is used · the model proposes, the test decides</div>
            <ol className="steps3">
              <li><span className="n">01</span><span><b>Rewrite proposal.</b> Screened for unsafe code, then compared with the original on generated and held-out scenarios. Failures go back to the model with the first difference.</span></li>
              <li><span className="n">02</span><span><b>Glossary draft.</b> Suggests plain names for cryptic tags. A person approves them.</span></li>
              <li><span className="n">03</span><span><b>Operator Q&amp;A.</b> The Ask box above answers only from the extracted rules, findings and tickets.</span></li>
            </ol>
          </div>
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <span className="eyebrow">Original and rewrite</span><span className="sp" />
            <div className="seg" role="group" aria-label="Code layout">
              <button aria-pressed={codeMode === "side"} onClick={() => setCodeMode("side")}>Side by side</button>
              <button aria-pressed={codeMode === "legacy"} onClick={() => setCodeMode("legacy")}>Structured Text</button>
              <button aria-pressed={codeMode === "modern"} onClick={() => setCodeMode("modern")}>Python</button>
            </div>
          </div>
          <div className={codeMode === "side" ? "two" : ""}>
            {codeMode !== "modern" && <div><div className="faint small mono" style={{ marginBottom: 6 }}>legacy/chw_sequencer.st · {st.legacy_source.split("\n").length} lines</div>
              <div className="code">{st.legacy_source.split("\n").map((l, k) => <div key={k}><i>{k + 1}</i>{l || " "}</div>)}</div></div>}
            {codeMode !== "legacy" && <div><div className="faint small mono" style={{ marginBottom: 6 }}>generated/modern_sequencer.py · {st.modern_source.split("\n").length} lines</div>
              <div className="code">{st.modern_source.split("\n").map((l, k) => <div key={k}><i>{k + 1}</i>{l || " "}</div>)}</div></div>}
          </div>
        </div>
      </section>
    </>
  );
}
