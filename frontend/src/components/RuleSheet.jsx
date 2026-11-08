/* One rule in plain English with the code it came from. Used in three places:
   the slide-in drawer (from anywhere in the app), a standalone window (?rule=R1),
   and the Rules & verification page. */
import { useEffect, useRef, useState } from "react";
import { Trace } from "./Bits.jsx";
import { lineSpan } from "../lib/format.js";

export function RulePicker({ rules, sel, onSelect }) {
  return (
    <div className="rulepicker" role="tablist" aria-label="Rules">
      {rules.map((r) => (
        <button key={r.id} role="tab" aria-selected={r.id === sel} onClick={() => onSelect(r.id)} className={r.protective ? "prot" : ""}>
          {r.id}
        </button>
      ))}
    </div>
  );
}

export function CodeExcerpt({ source, lines, context = 3, full = false }) {
  const all = source.split("\n");
  const from = full ? 1 : Math.max(1, lines[0] - context);
  const to = full ? all.length : Math.min(all.length, lines[1] + context);
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current, h = c?.querySelector(".hl");
    if (c && h && full) c.scrollTop = Math.max(0, h.offsetTop - 80);
  }, [lines, full]);
  return (
    <div className="code" ref={ref} style={full ? undefined : { maxHeight: "none" }}>
      {all.slice(from - 1, to).map((ln, k) => {
        const n = from + k;
        return <div key={n} className={n >= lines[0] && n <= lines[1] ? "hl" : ""}><i>{n}</i>{ln || " "}</div>;
      })}
    </div>
  );
}

export default function RuleSheet({ st, id, onSelect, popout = true }) {
  const r = st.rules.find((x) => x.id === id) || st.rules[0];
  const g = st.glossary;
  const [full, setFull] = useState(false);
  useEffect(() => setFull(false), [id]);
  const tag = (v) => <div className="tag" key={v}><code>{v}</code><span>{g[v]?.desc || ""}</span></div>;
  return (
    <div className="rulesheet anim-in" key={r.id}>
      <div className="row" style={{ marginBottom: 12 }}>
        <Trace id={r.id} lines={r.lines} />
        {r.protective && <span className="chip crit">Interrupts cooling or load</span>}
        {r.findings.length > 0 && <span className="chip warn">{r.findings.length} finding{r.findings.length > 1 ? "s" : ""}</span>}
        {r.tickets.length > 0 && <span className="chip accent">{r.tickets.length} incidents</span>}
        <span className="sp" />
        {popout && (
          <button className="btn sm ghost" title="Open this rule in its own window"
            onClick={() => window.open(`${location.pathname}?rule=${r.id}`, `rule-${r.id}`, "width=760,height=900")}>
            Open in new window ↗
          </button>
        )}
      </div>
      <p className="english">{r.english}</p>
      {r.interrupts.length > 0 && <p style={{ marginTop: 10, color: "var(--crit)" }}>Effect: {r.interrupts.join("; ")}.</p>}

      <div className="row" style={{ margin: "18px 0 8px" }}>
        <span className="eyebrow">Source · legacy/chw_sequencer.st {lineSpan(r.lines)}</span>
        <span className="sp" />
        <button className="btn sm ghost" onClick={() => setFull(!full)}>{full ? "Show excerpt" : "Show whole file"}</button>
      </div>
      <CodeExcerpt source={st.legacy_source} lines={r.lines} full={full} />

      <div className="io">
        <div><div className="eyebrow" style={{ marginBottom: 6 }}>Reads</div>{r.reads.length ? r.reads.map(tag) : <p className="faint small">Nothing</p>}</div>
        <div><div className="eyebrow" style={{ marginBottom: 6 }}>Writes</div>{r.writes.map(tag)}</div>
      </div>

      {r.findings.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="eyebrow">Needs a human decision</div>
          {r.findings.map((f) => <div key={f.text} className={`finding ${f.kind === "dead_input" ? "dead" : ""}`}><b>{f.label}.</b> {f.text}</div>)}
        </div>
      )}
      {r.tickets.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="eyebrow" style={{ marginBottom: 4 }}>Past incidents this rule explains</div>
          {r.tickets.map((t) => <div key={t.id} className="ticket"><span className="id">{t.id}</span><span className="faint mono small">{t.date}</span><div className="muted" style={{ marginTop: 3 }}>{t.text}</div></div>)}
        </div>
      )}
      {r.mitigations.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="eyebrow" style={{ marginBottom: 4 }}>Known mitigations · verified in simulation</div>
          {r.mitigations.map((x) => <div key={x.id} className="ticket"><b>{x.title}.</b> <span className="muted">{x.how}</span></div>)}
        </div>
      )}
      {onSelect && <RuleNav rules={st.rules} id={r.id} onSelect={onSelect} />}
    </div>
  );
}

function RuleNav({ rules, id, onSelect }) {
  const i = rules.findIndex((r) => r.id === id);
  return (
    <div className="row" style={{ marginTop: 20 }}>
      <button className="btn sm" disabled={i <= 0} onClick={() => onSelect(rules[i - 1].id)}>← {rules[i - 1]?.id || ""}</button>
      <span className="sp" />
      <button className="btn sm" disabled={i >= rules.length - 1} onClick={() => onSelect(rules[i + 1].id)}>{rules[i + 1]?.id || ""} →</button>
    </div>
  );
}

export function RuleDrawer({ st, id, onSelect, onClose, onOpenPage }) {
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Rules in plain English">
        <div className="drawer-h">
          <div>
            <div className="eyebrow">Rules in plain English</div>
            <RulePicker rules={st.rules} sel={id} onSelect={onSelect} />
          </div>
          <span className="sp" />
          <button className="btn sm ghost" onClick={onOpenPage}>Full page</button>
          <button className="x" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="drawer-b">
          <RuleSheet st={st} id={id} onSelect={onSelect} />
        </div>
      </aside>
    </>
  );
}
