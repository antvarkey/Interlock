/* The live scenario: queue a job, show the pre-warning, play the backend's simulation forward,
   raise the live alert with an act-within countdown, and let the operator step in.

   The backend simulation is deterministic for a given plan. When the operator turns on the
   chiller 2 override mid-run, we ask the backend to re-simulate with `manual_at` = the next
   second. The history before that second is identical (checked in backend tests), so playback
   just continues on the new timeline. */
import { useCallback, useEffect, useReducer, useRef } from "react";
import { api } from "./api.js";
import { unlock } from "./audio.js";
import { fmt, rel } from "./format.js";

const fresh = () => ({
  phase: "idle", // idle | briefing | running | done
  plan: { profile: "single", lead: null, choice: null },
  prewarning: null,
  sim: null,
  t: 0,
  processed: -1,
  log: [],
  alert: null, // { state: active|closed|tripped|resolved|recovered|clear, ... }
  overrideAt: null,
  acked: false,
  busy: false,
  skip: false,
  outcome: null,
  error: null,
  lastCd: null,
});

const PLAN_LABEL = {
  prestart: "Plan applied: pre-start chiller 2 one minute before the job",
  staged: "Plan applied: start the job in two stages",
  both: "Plan applied: pre-start chiller 2 and start in two stages",
  ignore: "Operator chose to start without changes",
};

export function useScenario({ notify, dismissKey, patchKey, clearToasts, goTab }) {
  const M = useRef(fresh());
  const [, render] = useReducer((x) => x + 1, 0);
  const js = () => M.current.sim?.job_start ?? 90;
  const at = (t) => rel(t, js());

  const log = (t, kind, text) => { M.current.log = [{ t, kind, text }, ...M.current.log]; };
  const mitigated = () => {
    const m = M.current;
    return m.plan.lead != null || m.plan.profile === "staged" || m.overrideAt != null;
  };

  /* ---------------------------------------------------------------- operator actions */
  const override = useCallback(async () => {
    const m = M.current;
    if (m.phase !== "running" || m.busy || m.plan.lead != null || m.overrideAt != null) return;
    const when = Math.floor(m.t) + 1;
    if (when >= m.sim.duration) return;
    m.busy = true; render();
    try {
      const next = await api.simulate({ profile: m.plan.profile, manual_at: when });
      m.sim = next; m.overrideAt = when;
      log(when, "action", "Operator turned on the chiller 2 manual override");
      const p = next.prediction;
      if (!p.will_trip) {
        if (m.alert && ["active", "closed"].includes(m.alert.state)) m.alert = { ...m.alert, state: "resolved", resolvedAt: when };
        dismissKey("live");
        notify({ sev: "ok", title: m.alert ? "Override accepted: trip avoided" : "Chiller 2 override on", at: at(when),
          body: `Forecast: no protective rule fires. Peak supply temperature ${fmt(p.peak_temp_c, 1)} °C, peak facility power ${fmt(p.peak_facility_kw)} kW.` });
      } else {
        const eta = p.primary.t - when;
        notify({ sev: "warn", title: "Override on, but too late to prevent the trip", at: at(when),
          body: eta > 0 ? `Forecast: rule ${p.primary.rule} still acts in about ${eta} s. Chiller 2 will shorten the outage.` : `Rule ${p.primary.rule} has already acted. Chiller 2 will help the recovery.` });
      }
    } catch (e) {
      notify({ sev: "crit", title: "Could not apply the override", body: String(e.message || e) });
    }
    m.busy = false; render();
  }, [notify, dismissKey]);

  const ack = useCallback(() => {
    const m = M.current;
    if (!m.alert || m.acked) return;
    m.acked = true;
    dismissKey("live");
    log(Math.floor(m.t), "action", "Alert acknowledged by operator");
    render();
  }, [dismissKey]);

  /* ---------------------------------------------------------------- events from the backend timeline */
  const handle = (e) => {
    const m = M.current, sim = m.sim;
    switch (e.type) {
      case "prewarning":
        log(e.t, e.level === "ok" ? "ok" : "crit", e.title);
        break;
      case "action":
        if (m.overrideAt != null && e.t === m.overrideAt) break; // already logged on click
        log(e.t, "action", e.title);
        if (e.t > 0) notify({ sev: "info", title: "Chiller 2 override on (per the verified plan)", body: "A second chiller is starting before the ramp arrives.", at: at(e.t), silent: true });
        break;
      case "live_alert": {
        const la = sim.live_alert;
        log(e.t, la.level === "critical" ? "crit" : "ok", la.title);
        if (la.level !== "critical") {
          m.alert = { state: "clear", t: la.t, title: la.title, summary: la.summary };
          notify({ sev: "info", title: "Power ramp detected", body: la.summary, at: at(e.t) });
          break;
        }
        const deadline = la.act_within_s != null ? la.t + la.act_within_s : null;
        m.alert = { state: deadline != null ? "active" : "closed", t: la.t, deadline, tripAt: sim.prediction.primary?.t,
          rule: la.rule, title: la.title, summary: la.summary, steps: la.steps };
        const jump = sim.series.fac_kw[la.t] - sim.series.fac_kw[Math.max(0, la.t - 3)];
        notify({
          key: "live", sev: "crit", sticky: true, pulse: true, at: at(e.t),
          title: deadline != null ? "Power spike: cooling trip coming" : "Power spike: cooling trip now unavoidable",
          body: `Facility power jumped ${fmt(jump)} kW in 3 s. Rule ${la.rule.id} stops the cooling loop in about ${la.eta_s} s.`,
          actions: deadline != null
            ? [{ label: "Start chiller 2 now", cls: "danger", fn: override, keep: true }, { label: "Acknowledge", fn: ack, keep: true }]
            : [{ label: "Acknowledge", fn: ack, keep: true }],
        });
        break;
      }
      case "rule_fired": {
        const rid = (e.title.match(/Rule (R\d+)/) || [])[1];
        const stopsCooling = /cooling loop/.test(e.title);
        log(e.t, stopsCooling ? "crit" : "warn", e.title);
        if (stopsCooling) {
          m.alert = { ...(m.alert || {}), state: "tripped", trippedAt: e.t, rule: m.alert?.rule || { id: rid, lines: [0, 0] } };
          dismissKey("live");
          notify({ key: "trip", sev: "crit", sticky: true, pulse: true, at: at(e.t), title: `Cooling loop tripped (rule ${rid})`,
            body: "The old controller read the fast temperature rise as a fault and stopped the pumps. Restart is blocked by the lockout." });
        } else {
          notify({ sev: "warn", at: at(e.t), title: e.title, body: "Facility power passed the cap, so the controller shed part of the IT load." });
        }
        break;
      }
      case "impact":
        log(e.t, /shut down/.test(e.title) ? "crit" : "warn", e.title);
        notify({ sev: /shut down/.test(e.title) ? "crit" : "warn", at: at(e.t), title: e.title, sticky: /shut down/.test(e.title),
          body: /shut down/.test(e.title) ? "The job is lost. It cannot restart until cooling is back and the lockout ends." : "Training speed is dropping." });
        break;
      case "recovery":
        log(e.t, "ok", e.title);
        if (m.alert) m.alert = { ...m.alert, state: "recovered" };
        dismissKey("trip");
        notify({ sev: "ok", at: at(e.t), title: "Cooling restarting", body: "The restart lockout ended. The job must be resubmitted by the scheduler." });
        break;
      case "outcome":
        log(e.t, "ok", e.title);
        notify({ sev: "ok", at: at(e.t), title: "Job running at full power", body: "No protective rule fired.", silent: true });
        break;
      default:
        log(e.t, e.level, e.title);
    }
  };

  const processSecond = (s) => {
    const m = M.current;
    if (m.alert?.state === "active" && s >= m.alert.deadline) {
      m.alert = { ...m.alert, state: "closed" };
      log(s, "crit", "The window to prevent the trip has closed");
      patchKey("live", { countdown: "Window to prevent the trip has closed", actions: [{ label: "Acknowledge", fn: ack, keep: true }] });
    }
    for (const e of m.sim.events) if (e.t === s) handle(e);
  };

  const finish = () => {
    const m = M.current, s = m.sim, p = s.prediction;
    m.phase = "done"; m.skip = false;
    const lost = s.series.it_kw.filter((v, i) => i >= s.job_start && v < 5).length;
    m.outcome = { tripped: p.will_trip && p.primary?.rule === "R1", ...p, lostS: lost };
    log(s.duration - 1, m.outcome.tripped ? "crit" : "ok",
      m.outcome.tripped ? "Run complete: the job was lost to a cooling trip" : "Run complete: the job ran without a cooling trip");
    clearToasts(); // incident toasts are in the bell history and the event log now
    notify({ sev: m.outcome.tripped ? "warn" : "ok", title: "Shift handoff ready", body: "Cause, actions taken and follow-ups for the next shift.",
      actions: [{ label: "Open handoff", cls: "primary", fn: () => goTab("handoff") }] });
  };

  /* ---------------------------------------------------------------- pacing */
  const speed = (t) => {
    const m = M.current, j = js();
    if (m.skip) return 320;
    if (t < j - 4) return 22;
    if (t < j - 1) return 3;
    if (!mitigated() && t < j + 6) return 0.6; // slow down so the act-within window is usable
    if (t < j + 35) return 4;
    if (t < j + 120) return 12;
    return 28;
  };

  useEffect(() => {
    let raf, last = 0;
    const frame = (now) => {
      const m = M.current;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      if (m.phase === "running" && !m.busy && m.sim) {
        const end = m.sim.duration - 1;
        m.t = Math.min(end, m.t + dt * speed(m.t));
        while (m.processed < Math.floor(m.t)) processSecond(++m.processed);
        if (m.alert?.state === "active") {
          const cd = Math.max(0, Math.ceil(m.alert.deadline - m.t));
          if (cd !== m.lastCd) { m.lastCd = cd; patchKey("live", { countdown: `Act within ${cd} s` }); }
        }
        if (m.t >= end) finish();
        render();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------------------------------------------------------- flow */
  const queue = useCallback(async () => {
    unlock();
    const m = M.current;
    if (m.phase === "running" || m.phase === "briefing") return;
    try {
      const pw = await api.prewarning({ profile: "single" });
      M.current = { ...fresh(), prewarning: pw, phase: "briefing" };
      clearToasts();
      if (pw.level === "critical")
        notify({ sev: "crit", title: `Pre-warning: ${pw.title}`, body: "Verified steps are ready. Review them before the job starts.", at: "T−90s" });
    } catch (e) {
      M.current.error = String(e.message || e);
    }
    render();
  }, [notify, clearToasts]);

  const choose = useCallback(async (choice) => {
    const m = M.current;
    if (choice === "cancel") { m.phase = "idle"; render(); return; }
    const plan = {
      profile: choice === "staged" || choice === "both" ? "staged" : "single",
      lead: choice === "prestart" || choice === "both" ? 60 : null,
      choice,
    };
    m.busy = true; render();
    try {
      const sim = await api.simulate({ profile: plan.profile, manual_lead_s: plan.lead });
      M.current = { ...fresh(), prewarning: m.prewarning, plan, sim, phase: "running" };
      log(0, choice === "ignore" ? "warn" : "action", PLAN_LABEL[choice]);
      notify({ sev: choice === "ignore" ? "warn" : "ok", title: choice === "ignore" ? "Starting without changes" : "Plan accepted", body: PLAN_LABEL[choice], silent: true, at: "T−90s" });
    } catch (e) {
      m.busy = false; m.error = String(e.message || e);
    }
    render();
  }, [notify]);

  const skip = useCallback(() => { M.current.skip = true; }, []);
  const reset = useCallback(() => { M.current = fresh(); clearToasts(); render(); }, [clearToasts]);

  return { m: M.current, queue, choose, override, ack, skip, reset };
}
