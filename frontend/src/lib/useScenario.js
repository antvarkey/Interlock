/* The live scenario: queue a job, show the pre-warning, play the backend's simulation forward,
   raise the final-call and ramp alerts, and let the operator step in.

   The backend simulation is deterministic for a given plan. When the operator turns on the
   chiller 2 override mid-run, we ask the backend to re-simulate with `manual_at` = the next
   second. The history before that second is identical (checked in backend tests), so playback
   just continues on the new timeline.

   Alerts:
   - final call: the scheduler knows when the job starts, so Interlock counts down to the last
     moment a fix still works (a chiller needs ~45 s to start). This is the act-within window.
   - ramp alert: when facility power jumps. By then the trip is unavoidable; it tells operators
     to prepare to recover. */
import { useCallback, useEffect, useReducer, useRef } from "react";
import { api } from "./api.js";
import { unlock } from "./audio.js";
import { fmt, mw, rel } from "./format.js";

export const PACES = [
  { id: "demo", label: "Demo pace" },
  { id: "1", label: "Real time" },
  { id: "2", label: "2×" },
  { id: "5", label: "5×" },
  { id: "10", label: "10×" },
];

const fresh = () => ({
  phase: "idle", // idle | briefing | running | done
  plan: { profile: "single", lead: null, choice: null },
  prewarning: null,
  sim: null,
  t: 0,
  processed: -1,
  log: [],
  alert: null, // { kind: final|ramp, state: active|closed|tripped|resolved|recovered|clear, ... }
  overrideAt: null,
  acked: false,
  busy: false,
  skip: false,
  outcome: null,
  error: null,
  lastCd: null,
});

export function useScenario({ notify, dismissKey, patchKey, clearToasts, goTab, config }) {
  const M = useRef(fresh());
  const cfg = useRef(config);
  cfg.current = config;
  const [, render] = useReducer((x) => x + 1, 0);
  const js = () => M.current.sim?.job_start ?? cfg.current.jobStart;
  const at = (t) => rel(t, js());

  const log = (t, kind, text) => { M.current.log = [{ t, kind, text }, ...M.current.log]; };

  /* ---------------------------------------------------------------- operator actions */
  const override = useCallback(async () => {
    const m = M.current;
    if (m.phase !== "running" || m.busy || m.plan.lead != null || m.overrideAt != null) return;
    const when = Math.floor(m.t) + 1;
    if (when >= m.sim.duration) return;
    m.busy = true; render();
    try {
      const next = await api.simulate({ profile: m.plan.profile, manual_at: when, job_start_s: cfg.current.jobStart });
      m.sim = next; m.overrideAt = when;
      log(when, "action", "Operator turned on the chiller 2 manual override");
      const p = next.prediction;
      if (!p.will_trip) {
        if (m.alert && ["active", "closed"].includes(m.alert.state)) m.alert = { ...m.alert, state: "resolved", resolvedAt: when };
        dismissKey("live");
        notify({ sev: "ok", title: m.alert ? "Override accepted: trip avoided" : "Chiller 2 override on", at: at(when),
          body: `Forecast: no protective rule fires. Peak supply temperature ${fmt(p.peak_temp_c, 1)} °C, peak facility power ${mw(p.peak_facility_kw)} MW.` });
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
      case "final_call": {
        const fc = sim.final_call;
        log(e.t, "crit", `Final call: ${fc.title.replace(/^Last chance: /, "")}`);
        m.alert = { kind: "final", state: "active", t: fc.t, deadline: fc.deadline, tripAt: sim.prediction.primary?.t ?? fc.t + fc.eta_s,
          rule: fc.rule, title: fc.title, summary: fc.summary, steps: fc.steps };
        m.acked = false;
        notify({
          key: "live", sev: "crit", sticky: true, pulse: true, at: at(e.t),
          title: "Final call: start chiller 2 now",
          body: `The job starts in ${fc.job_in_s} s. Rule ${fc.rule.id} will stop the cooling loop about ${fc.eta_s - fc.job_in_s} s after that. A chiller needs about 45 s to start.`,
          actions: [{ label: "Start chiller 2 now", cls: "danger", fn: override, keep: true }, { label: "Acknowledge", fn: ack, keep: true }],
        });
        break;
      }
      case "live_alert": {
        const la = sim.live_alert;
        log(e.t, la.level === "critical" ? "crit" : "ok", la.title);
        if (la.level !== "critical") {
          if (!m.alert || m.alert.state !== "resolved") m.alert = { kind: "ramp", state: "clear", t: la.t, title: la.title, summary: la.summary };
          notify({ sev: "info", title: "Power ramp detected", body: la.summary, at: at(e.t), silent: true });
          break;
        }
        const deadline = la.act_within_s != null ? la.t + la.act_within_s : null;
        m.alert = { kind: "ramp", state: deadline != null ? "active" : "closed", t: la.t, deadline, tripAt: sim.prediction.primary?.t,
          rule: la.rule, title: la.title, summary: la.summary, steps: la.steps };
        const jump = sim.series.fac_kw[la.t] - sim.series.fac_kw[Math.max(0, la.t - 3)];
        notify({
          key: "live", sev: "crit", sticky: true, pulse: true, at: at(e.t),
          title: deadline != null ? "Power spike: cooling trip coming" : "Power spike: cooling trip now unavoidable",
          body: `Facility power jumped ${mw(jump)} MW in 3 s. Rule ${la.rule.id} stops the cooling loop in about ${la.eta_s} s.${deadline == null ? " Checkpoint jobs and prepare to recover." : ""}`,
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
      case "impact": {
        const sd = /shut down/.test(e.title);
        log(e.t, sd ? "crit" : "warn", e.title);
        notify({ key: sd ? "shutdown" : undefined, sev: sd ? "crit" : "warn", at: at(e.t), title: e.title, sticky: sd,
          body: sd ? "The job is lost. It cannot restart until cooling is back and the lockout ends." : "Training speed is dropping." });
        break;
      }
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
    notify({ sev: m.outcome.tripped ? "warn" : "ok", title: "Shift handoff ready", body: "Cause, actions taken, follow-ups, and a root cause analysis report.",
      actions: [{ label: "Open handoff", cls: "primary", fn: () => goTab("handoff") }] });
  };

  /* ---------------------------------------------------------------- pacing */
  const speed = (t) => {
    const m = M.current, j = js();
    if (m.skip) return 400;
    const pace = cfg.current.pace;
    if (pace !== "demo") return Number(pace);
    if (m.alert?.state === "active") return 4;      // the act-within window plays at 4x
    if (t < j - 6) return 24;
    if (t < j + 4) return 2.5;                       // slow down for the job start and ramp
    if (t < j + 40) return 4;
    if (t < j + 160) return 12;
    return 24;
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
      const pw = await api.prewarning({ profile: "single", job_start_s: cfg.current.jobStart });
      M.current = { ...fresh(), prewarning: pw, phase: "briefing" };
      clearToasts();
      if (pw.level === "critical")
        notify({ sev: "crit", title: `Pre-warning: ${pw.title}`, body: "Verified steps are ready. Review them before the job starts.", at: rel(0, cfg.current.jobStart) });
    } catch (e) {
      M.current.error = String(e.message || e);
    }
    render();
  }, [notify, clearToasts]);

  const choose = useCallback(async (choice) => {
    const m = M.current;
    if (choice === "cancel") { m.phase = "idle"; render(); return; }
    const leadStep = m.prewarning?.steps?.find((s) => s.sim?.manual_ch2_lead_s);
    const leadS = leadStep?.sim.manual_ch2_lead_s ?? 120;
    const plan = {
      profile: choice === "staged" || choice === "both" ? "staged" : "single",
      lead: choice === "prestart" || choice === "both" ? leadS : null,
      choice,
    };
    const label = {
      prestart: `Plan applied: pre-start chiller 2 ${leadS / 60} min before the job`,
      staged: "Plan applied: start the job in two stages",
      both: `Plan applied: pre-start chiller 2 and start in two stages`,
      ignore: "Operator chose to start without changes",
    }[choice];
    m.busy = true; render();
    try {
      const sim = await api.simulate({ profile: plan.profile, manual_lead_s: plan.lead, job_start_s: cfg.current.jobStart });
      M.current = { ...fresh(), prewarning: m.prewarning, plan, sim, phase: "running" };
      log(0, choice === "ignore" ? "warn" : "action", label);
      notify({ sev: choice === "ignore" ? "warn" : "ok", title: choice === "ignore" ? "Starting without changes" : "Plan accepted", body: label, silent: true, at: rel(0, sim.job_start) });
    } catch (e) {
      m.busy = false; m.error = String(e.message || e);
    }
    render();
  }, [notify]);

  const skip = useCallback(() => { M.current.skip = true; }, []);
  const reset = useCallback(() => { M.current = fresh(); clearToasts(); render(); }, [clearToasts]);

  return { m: M.current, queue, choose, override, ack, skip, reset };
}
