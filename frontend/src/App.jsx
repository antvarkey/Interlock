import { useCallback, useEffect, useState } from "react";
import Logo from "./components/Logo.jsx";
import { Bell, useNotify } from "./components/Notifications.jsx";
import { api } from "./lib/api.js";
import { setMuted, unlock } from "./lib/audio.js";
import { useScenario } from "./lib/useScenario.js";
import HandoffView from "./views/HandoffView.jsx";
import LiveView from "./views/LiveView.jsx";
import RulesView from "./views/RulesView.jsx";
import VerifyView from "./views/VerifyView.jsx";

const TABS = [
  { id: "live", n: "01", label: "Live operations" },
  { id: "rules", n: "02", label: "Rules" },
  { id: "verify", n: "03", label: "Verification" },
  { id: "handoff", n: "04", label: "Shift handoff" },
];

export default function App() {
  const notifyApi = useNotify();
  const [st, setSt] = useState(null);
  const [ghost, setGhost] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("live");
  const [rule, setRule] = useState("R1");
  const [muted, setMute] = useState(false);
  const [handoffSeen, setHandoffSeen] = useState(true);

  const goTab = useCallback((t) => { setTab(t); window.scrollTo({ top: 0 }); }, []);
  const sc = useScenario({ ...notifyApi, goTab });
  const { m } = sc;

  useEffect(() => {
    Promise.all([api.state(), api.prewarning({ profile: "single" }), api.simulate({ profile: "single" })])
      .then(([s, pw, g]) => { setSt({ ...s, baseline: pw }); setGhost(g); })
      .catch((e) => setErr(String(e.message || e)));
  }, []);

  useEffect(() => { if (m.phase === "done") setHandoffSeen(tab === "handoff"); }, [m.phase]); // eslint-disable-line
  useEffect(() => { if (tab === "handoff") setHandoffSeen(true); }, [tab]);

  // alert state drives the tab title, the global banner and the logo fan
  const a = m.alert;
  const i = m.sim ? Math.min(Math.floor(m.t), m.sim.duration - 1) : 0;
  const pumps = m.sim ? m.sim.series.pumps[i] : true;
  const ch2 = m.sim ? m.sim.series.ch2_running[i] : false;
  const critical = m.phase === "running" && a && ["active", "closed", "tripped"].includes(a.state);
  useEffect(() => {
    document.title = critical ? `● ${a.state === "tripped" ? "TRIP" : "ALERT"} · Interlock` : "Interlock · Cooling control intelligence";
  }, [critical, a?.state]);

  const openRule = (id, t = "rules") => { if (id) setRule(id); goTab(t); };

  const status = m.phase === "running"
    ? critical ? { cls: "crit", text: a.state === "tripped" ? "Cooling loop tripped" : "Trip predicted · act now", pulse: true }
      : { cls: "live", text: "Job running · monitoring", pulse: true }
    : m.phase === "briefing" ? { cls: "warn", text: "Pre-warning issued", pulse: true }
    : m.phase === "done" ? (m.outcome?.tripped ? { cls: "crit", text: "Incident · handoff ready" } : { cls: "ok", text: "Nominal · handoff ready" })
    : { cls: "ok", text: "Nominal · 1 job queued" };

  if (err) return <div className="err">Could not reach the Interlock API.{"\n"}{err}{"\n\n"}Start it with: cd backend && uvicorn interlock.server:app --port 8000</div>;

  return (
    <div className="shell">
      <header className="topbar">
        <Logo fanMode={!pumps ? "stopped" : ch2 ? "fast" : "idle"} />
        <div className="site"><span className="sep" /><span>Cluster B</span><span>·</span><b>Hall 2 chilled water</b><span className="chip mono" style={{ marginLeft: 6 }}>demo data</span></div>
        <span className="sp" />
        <span className={`status-pill ${status.cls}`} data-testid="status"><span className={`led ${status.pulse ? "pulse" : ""}`} />{status.text}</span>
        <button className="iconbtn" aria-pressed={muted} title="Alert sounds" onClick={() => { unlock(); setMuted(!muted); setMute(!muted); }}>{muted ? "Sound off" : "Sound on"}</button>
        <Bell />
      </header>
      <nav className="nav" role="tablist" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} role="tab" id={`t-${t.id}`} aria-selected={tab === t.id} onClick={() => goTab(t.id)}>
            <span className="n">{t.n}</span>{t.label}
            {t.id === "live" && critical && tab !== "live" && <span className="dot crit" />}
            {t.id === "handoff" && m.phase === "done" && !handoffSeen && <span className="dot" />}
          </button>
        ))}
      </nav>
      {critical && (
        <div className="banner" role="alert">
          <span className="led pulse" />
          <span style={{ flex: 1 }}>
            {a.state === "active" && <>Rule {a.rule.id} will stop the cooling loop in about {Math.max(0, Math.ceil(a.tripAt - m.t))} s. Start chiller 2 now to prevent it.</>}
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
          <>
            {tab === "live" && <LiveView st={st} sc={sc} ghost={ghost} onRule={openRule} />}
            {tab === "rules" && <RulesView st={st} sel={rule} setSel={setRule} />}
            {tab === "verify" && <VerifyView st={st} notify={notifyApi.notify} />}
            {tab === "handoff" && <HandoffView st={st} sc={sc} onRule={openRule} />}
          </>
        )}
      </main>
    </div>
  );
}
