import { useCallback, useEffect, useState } from "react";
import Logo from "./components/Logo.jsx";
import { Bell, useNotify } from "./components/Notifications.jsx";
import RuleSheet, { RuleDrawer, RulePicker } from "./components/RuleSheet.jsx";
import { api } from "./lib/api.js";
import { setMuted, unlock } from "./lib/audio.js";
import { useScenario } from "./lib/useScenario.js";
import HandoffView from "./views/HandoffView.jsx";
import LiveView from "./views/LiveView.jsx";
import LogicView from "./views/LogicView.jsx";

const TABS = [
  { id: "live", n: "01", label: "Live operations" },
  { id: "logic", n: "02", label: "Rules & verification" },
  { id: "handoff", n: "03", label: "Shift handoff" },
];

/* ?rule=R1 opens a single rule in its own window (from "Open in new window"). */
function StandaloneRule() {
  const [st, setSt] = useState(null);
  const [id, setId] = useState(new URLSearchParams(location.search).get("rule") || "R1");
  useEffect(() => { api.state().then(setSt); }, []);
  useEffect(() => {
    const u = new URL(location.href); u.searchParams.set("rule", id); history.replaceState(null, "", u);
    document.title = `${id} · Interlock rules`;
  }, [id]);
  if (!st) return <div className="empty">Loading…</div>;
  return (
    <div className="shell">
      <header className="topbar"><Logo /><span className="sp" /><RulePicker rules={st.rules} sel={id} onSelect={setId} /></header>
      <main style={{ maxWidth: 860 }}>
        <div className="eyebrow section" style={{ marginBottom: 16 }}><span className="n">{id}</span>Rule in plain English</div>
        <div className="card"><RuleSheet st={st} id={id} onSelect={setId} popout={false} /></div>
      </main>
    </div>
  );
}

function Dashboard() {
  const notifyApi = useNotify();
  const [config, setConfig] = useState({ jobStart: 300, pace: "demo" });
  const [st, setSt] = useState(null);
  const [ghost, setGhost] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("live");
  const [rule, setRule] = useState("R1");
  const [drawer, setDrawer] = useState(false);
  const [muted, setMute] = useState(false);
  const [handoffSeen, setHandoffSeen] = useState(true);

  const goTab = useCallback((t) => { setTab(t); window.scrollTo({ top: 0, behavior: "smooth" }); }, []);
  const sc = useScenario({ ...notifyApi, goTab, config });
  const { m } = sc;

  // the job clock changes the plant timeline, so reload the state and the "if nobody acts" forecast
  useEffect(() => {
    Promise.all([api.state(config.jobStart), api.prewarning({ profile: "single", job_start_s: config.jobStart }), api.simulate({ profile: "single", job_start_s: config.jobStart })])
      .then(([s, pw, g]) => { setSt({ ...s, baseline: pw }); setGhost(g); })
      .catch((e) => setErr(String(e.message || e)));
  }, [config.jobStart]);

  useEffect(() => { if (m.phase === "done") setHandoffSeen(tab === "handoff"); }, [m.phase]); // eslint-disable-line
  useEffect(() => { if (tab === "handoff") setHandoffSeen(true); }, [tab]);

  const a = m.alert;
  const i = m.sim ? Math.min(Math.floor(m.t), m.sim.duration - 1) : 0;
  const pumps = m.sim ? m.sim.series.pumps[i] : true;
  const ch2 = m.sim ? m.sim.series.ch2_running[i] : false;
  const critical = m.phase === "running" && a && ["active", "closed", "tripped"].includes(a.state);
  useEffect(() => {
    document.title = critical ? `● ${a.state === "tripped" ? "TRIP" : "ALERT"} · Interlock` : "Interlock · Cooling control intelligence";
  }, [critical, a?.state]);

  // a rule id opens the drawer without leaving the page; a tab name navigates
  const openRule = (id, t) => {
    if (t) { goTab(t); return; }
    if (id) { setRule(id); setDrawer(true); }
  };

  const status = m.phase === "running"
    ? critical ? { cls: "crit", text: a.state === "tripped" ? "Cooling loop tripped" : a.kind === "final" && a.state === "active" ? "Final call · act now" : "Trip predicted" }
      : { cls: "live", text: "Job running · monitoring" }
    : m.phase === "briefing" ? { cls: "warn", text: "Pre-warning issued" }
    : m.phase === "done" ? (m.outcome?.tripped ? { cls: "crit", text: "Incident · handoff ready" } : { cls: "ok", text: "Nominal · handoff ready" })
    : { cls: "ok", text: "Nominal · 1 job queued" };

  if (err) return <div className="err">Could not reach the Interlock API.{"\n"}{err}{"\n\n"}Start it with: cd backend && uvicorn interlock.server:app --port 8000</div>;

  return (
    <div className="shell">
      <header className="topbar">
        <Logo fanMode={!pumps ? "stopped" : ch2 ? "fast" : "idle"} />
        <div className="site"><span className="sep" /><span>NMC² · Cluster B</span><span>·</span><b>Hall 2 facility water</b><span className="chip mono" style={{ marginLeft: 6 }}>demo data</span></div>
        <span className="sp" />
        <span className={`status-pill ${status.cls}`} data-testid="status" key={status.text}><span className={`led ${m.phase !== "idle" ? "pulse" : ""}`} />{status.text}</span>
        <button className="iconbtn" id="rules-btn" onClick={() => setDrawer(true)} title="Open the rules in plain English">
          <span className="mono" style={{ fontSize: 11, color: "var(--accent)" }}>R1–R{st?.rules.length || 7}</span>&nbsp;Rules
        </button>
        <button className="iconbtn" aria-pressed={muted} title="Alert sounds" onClick={() => { unlock(); setMuted(!muted); setMute(!muted); }}>{muted ? "Sound off" : "Sound on"}</button>
        <Bell />
      </header>
      <nav className="nav" role="tablist" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} role="tab" id={`t-${t.id}`} aria-selected={tab === t.id} onClick={() => goTab(t.id)} className={t.id === "live" ? "primary-tab" : ""}>
            <span className="n">{t.n}</span>{t.label}
            {t.id === "live" && critical && tab !== "live" && <span className="dot crit" />}
            {t.id === "handoff" && m.phase === "done" && !handoffSeen && <span className="dot" />}
          </button>
        ))}
      </nav>
      {critical && (
        <div className={`banner ${a.state === "active" ? "" : ""}`} role="alert">
          <span className="led pulse" />
          <span style={{ flex: 1 }}>
            {a.state === "active" && a.kind === "final" && <>Final call: the job starts in {Math.max(0, Math.ceil(m.sim.job_start - m.t))} s and rule {a.rule.id} will stop the cooling loop. Start chiller 2 now to prevent it.</>}
            {a.state === "active" && a.kind !== "final" && <>Rule {a.rule.id} will stop the cooling loop in about {Math.max(0, Math.ceil(a.tripAt - m.t))} s. Start chiller 2 now to prevent it.</>}
            {a.state === "closed" && <>Rule {a.rule.id} will stop the cooling loop in about {Math.max(0, Math.ceil(a.tripAt - m.t))} s. The window to prevent it has closed.</>}
            {a.state === "tripped" && <>Cooling loop tripped by rule {a.rule.id}. Restart is blocked by the lockout.</>}
          </span>
          {a.state === "active" && <span className="cd">ACT WITHIN {Math.max(0, Math.ceil(a.deadline - m.t))} S</span>}
          {a.state === "active" && <button className="btn" onClick={sc.override}>Start chiller 2 now</button>}
          {tab !== "live" && <button className="btn" onClick={() => goTab("live")}>Open live view</button>}
        </div>
      )}
      <main>
        {!st ? <div className="empty">Loading the extracted rules…</div> : (
          <div className="view" key={tab}>
            {tab === "live" && <LiveView st={st} sc={sc} ghost={ghost} onRule={openRule} config={config} setConfig={setConfig} />}
            {tab === "logic" && <LogicView st={st} sel={rule} setSel={setRule} notify={notifyApi.notify} />}
            {tab === "handoff" && <HandoffView st={st} sc={sc} onRule={openRule} notify={notifyApi.notify} />}
          </div>
        )}
      </main>
      {drawer && st && <RuleDrawer st={st} id={rule} onSelect={setRule} onClose={() => setDrawer(false)} onOpenPage={() => { setDrawer(false); goTab("logic"); }} />}
    </div>
  );
}

export default function App() {
  return new URLSearchParams(location.search).has("rule") ? <StandaloneRule /> : <Dashboard />;
}
