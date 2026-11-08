"""Interlock engine: ties extraction, the verified rewrite, the plant model,
the predictor, the alert engine and the shift handoff together."""
from __future__ import annotations

import json
import os
from pathlib import Path

from .codegen import generate, load_class
from .extract import extract, find_compares, load_legacy
from .interp import LegacyController
from .parity import run_parity
from .plant import PlantParams, simulate
from .st_parser import parse

ROOT = Path(__file__).resolve().parent.parent


class LegacyAdapter:
    """Lets the original interpreter be driven with the modern names, so the
    simulator can run old and new side by side."""

    def __init__(self, prog, hooks, glossary):
        self.inner = LegacyController(prog, hooks)
        self.to_modern = {d.name: glossary.get(d.name, {}).get("name", d.name.lower()) for d in prog.decls}
        self.to_legacy = {v: k for k, v in self.to_modern.items()}
        self.out_names = [d.name for d in prog.decls if d.block == "output"]

    def reset(self):
        self.inner.reset()

    def step(self, **sensors):
        outs, fired = self.inner.step({self.to_legacy[k]: v for k, v in sensors.items()})
        return {self.to_modern[k]: v for k, v in outs.items()}, fired


def _fmt(n: float, digits: int = 0) -> str:
    return f"{n:,.{digits}f}"


def _mw(kw: float) -> str:
    """Power for people: 8,300 kW reads as 8.3 MW."""
    return f"{kw / 1000:,.1f} MW" if abs(kw) >= 1000 else f"{kw:,.0f} kW"


FINAL_CALL_LEAD_S = 60      # final-call alert this long before the last safe moment to act
RAMP_DETECT_KW_3S = 1000.0  # live alert when facility power rises this much within 3 s


class Interlock:
    def __init__(self, legacy_dir: str | Path | None = None, params: PlantParams | None = None,
                 rewrite: str | None = None):
        self.legacy_dir = Path(legacy_dir or ROOT / "legacy")
        self.legacy = load_legacy(self.legacy_dir)
        self.prog = parse(self.legacy["source"])
        self.ex = extract(self.prog, self.legacy)
        self.rules = self.ex["rules"]
        self.rule_by_id = {r["id"]: r for r in self.rules}
        self.modern_source = generate(self.prog, self.legacy["glossary"], self.ex)
        self.Modern = load_class(self.modern_source)
        self.rewrite_origin = "rules"  # "rules" = deterministic code generator, "llm" = model proposal that passed parity
        if (rewrite or os.environ.get("INTERLOCK_REWRITE")) == "llm":
            self._adopt_llm_rewrite()
        self.params = params or PlantParams()
        self.facts = self._facts()
        self._cache: dict = {}

    def _adopt_llm_rewrite(self) -> None:
        """Use a model-written rewrite only if it is on disk AND passes parity again right now."""
        from .llm_assist import load_candidate, screen_source

        path = ROOT / "generated" / "llm_sequencer.py"
        if not path.exists():
            return  # nothing accepted yet: keep the deterministic rewrite
        src = path.read_text()
        g = self.legacy["glossary"]
        names = lambda block: [g.get(d.name, {}).get("name", d.name.lower()) for d in self.prog.decls if d.block == block]  # noqa: E731
        if screen_source(src, names("input"), names("output")):
            return
        res = run_parity(self.prog, self.ex["hooks"], self.legacy["glossary"], src,
                         [r["id"] for r in self.rules], sequences=300, loader=load_candidate)
        if res["passed"] and res["rules_covered"] == res["rules_total"]:
            self.modern_source, self.Modern, self.rewrite_origin = src, load_candidate(src), "llm"

    # ------------------------------------------------------------ facts
    def _facts(self) -> dict:
        facts = {"power_cap_kw": None, "lockout_s": None}
        for r in self.ex["rule_objects"]:
            for c in r["_cond_exprs"]:
                vals = find_compares(c, "PF1", [])
                if vals:
                    facts["power_cap_kw"] = vals[0]
            for a in r["_actions"]:
                if a.name == "LK_CT" and a.expr[0] == "num":
                    facts["lockout_s"] = a.expr[1]
        return facts

    def public_state(self) -> dict:
        ex = self.ex
        return {
            "rules": self.rules,
            "derived": ex["derived"],
            "counters": ex["counters"],
            "findings": ex["findings"],
            "graph": ex["graph"],
            "legacy_source": self.legacy["source"],
            "modern_source": self.modern_source,
            "glossary": self.legacy["glossary"],
            "tickets": self.legacy["tickets"],
            "facts": self.facts,
            "plant": {**self.params.__dict__, "duration_s": self.params.duration_s},
        }

    # ------------------------------------------------------------ parity
    def parity(self, sequences: int = 2000, bug: str | None = None, seed: int = 7) -> dict:
        return run_parity(self.prog, self.ex["hooks"], self.legacy["glossary"], self.modern_source,
                          [r["id"] for r in self.rules], sequences=sequences, seed=seed, bug=bug)

    def sim_parity(self, profile: str = "single", manual_ch2_at: int | None = None) -> bool:
        """Run the plant with the original code and with the rewrite; they must agree."""
        a = simulate(LegacyAdapter(self.prog, self.ex["hooks"], self.legacy["glossary"]), profile, manual_ch2_at, self.params)
        b = simulate(self.Modern(), profile, manual_ch2_at, self.params)
        return a.temp == b.temp and a.fired == b.fired and a.pumps == b.pumps

    # ------------------------------------------------------------ prediction
    def _run(self, profile: str, manual_lead_s: int | None = None, manual_at: int | None = None):
        if manual_at is None and manual_lead_s is not None:
            manual_at = max(0, self.params.job_start_s - manual_lead_s)
        return simulate(self.Modern(), profile, manual_at, self.params), manual_at

    def summarize(self, run) -> dict:
        p = self.params
        start = p.job_start_s
        protective = {r["id"] for r in self.rules if r["protective"]}
        first: dict[str, int] = {}
        for t, f in zip(run.t, run.fired):
            if t < start:
                continue
            for rid in f:
                if rid in protective and rid not in first:
                    first[rid] = t
        events = sorted(({"rule": rid, "t": t} for rid, t in first.items()), key=lambda e: e["t"])
        primary = events[0] if events else None
        throttle_t = next((t for t, v in zip(run.t, run.temp) if v >= p.throttle_c), None)
        shutdown_t = next((t for t, v in zip(run.t, run.temp) if v >= p.shutdown_c), None)
        peak_fac = max(run.fac_kw)
        cap = self.facts["power_cap_kw"]
        return {
            "profile": run.profile,
            "manual_ch2_at": run.manual_ch2_at,
            "will_trip": primary is not None,
            "protective_events": events,
            "primary": primary,
            "trip_after_start_s": (primary["t"] - start) if primary else None,
            "throttle_t": throttle_t,
            "shutdown_t": shutdown_t,
            "outcome": "thermal_shutdown" if shutdown_t else "throttle" if throttle_t else "ok",
            "peak_temp_c": round(max(run.temp), 2),
            "peak_it_kw": round(max(run.it_kw), 0),
            "peak_facility_kw": round(peak_fac, 0),
            "power_cap_margin_kw": round(cap - peak_fac, 0) if cap else None,
        }

    def predict(self, profile: str = "single", manual_lead_s: int | None = None, manual_at: int | None = None) -> dict:
        key = ("predict", profile, manual_lead_s, manual_at)
        if key not in self._cache:
            run, at = self._run(profile, manual_lead_s, manual_at)
            self._cache[key] = self.summarize(run)
        return self._cache[key]

    def latest_safe_manual_start(self, profile: str = "single") -> int | None:
        """The latest second at which starting chiller 2 by hand still avoids a trip."""
        best = None
        for at in range(0, self.params.job_start_s + 40):
            if not self.predict(profile, manual_at=at)["will_trip"]:
                best = at
        return best

    def verified_mitigations(self, rule_id: str) -> list[dict]:
        out = []
        for m in self.rule_by_id[rule_id]["mitigations"]:
            sim = m.get("sim", {})
            pred = self.predict(sim.get("profile", "single"), sim.get("manual_ch2_lead_s"))
            out.append({
                "id": m["id"], "title": m["title"], "how": m["how"], "kind": m["kind"], "sim": sim,
                "avoids_trip": not pred["will_trip"],
                "peak_temp_c": pred["peak_temp_c"],
                "peak_facility_kw": pred["peak_facility_kw"],
                "power_cap_margin_kw": pred["power_cap_margin_kw"],
            })
        return out

    # ------------------------------------------------------------ alerts
    def _rule_brief(self, rid: str) -> dict:
        r = self.rule_by_id[rid]
        return {"id": rid, "english": r["english"], "lines": r["lines"], "interrupts": r["interrupts"]}

    def _watchouts(self, rid: str) -> list[str]:
        return [f["text"] for f in self.rule_by_id[rid]["findings"]]

    def prewarning(self, profile: str = "single", manual_lead_s: int | None = None) -> dict:
        """What an operator is told when a job is queued, given the current plan."""
        p = self.params
        pred = self.predict(profile, manual_lead_s)
        if not pred["will_trip"]:
            return {
                "level": "ok", "kind": "prewarning", "prediction": pred,
                "title": "No protective rule is predicted to fire at job start",
                "summary": (f"Simulated with the current plan: peak supply temperature {pred['peak_temp_c']} °C, "
                            f"peak facility power {_mw(pred['peak_facility_kw'])}."),
                "rule": None, "evidence": [], "steps": [], "watchouts": [],
            }
        rid = pred["primary"]["rule"]
        rule = self.rule_by_id[rid]
        cap_kw = p.chiller_cap_kw
        what = rule["interrupts"][0] if rule["interrupts"] else "a protective action runs"
        n = pred["trip_after_start_s"]
        evidence = [
            f"The job takes IT load from {_mw(p.idle_kw)} to {_mw(pred['peak_it_kw'])} in about {p.ramp_s} s.",
            f"One chiller can remove about {_mw(cap_kw)}, so heat exceeds cooling by about {_mw(pred['peak_it_kw'] - cap_kw)}.",
            f"A second chiller needs about {p.ch2_delay_s} s to start and {p.ch2_ramp_s} s more to reach full capacity, "
            f"and the controller only stages it after chiller 1 has been heavily loaded for 90 s (rule R4).",
            f"Rule {rid} (lines {rule['lines'][0]}-{rule['lines'][1]}) acts about {n} s after the job starts.",
        ]
        if pred["shutdown_t"]:
            evidence.append(f"GPUs reach shutdown temperature about {pred['shutdown_t'] - p.job_start_s} s after the job starts.")
        if self.facts["lockout_s"]:
            evidence.append(f"Cooling restart is then blocked for {_fmt(self.facts['lockout_s'])} s by rules R2 and R3.")
        steps = self.verified_mitigations(rid) if rule["mitigations"] else []
        return {
            "level": "critical", "kind": "prewarning", "prediction": pred,
            "title": f"{what[0].upper()}{what[1:]} about {n} s after the job starts",
            "summary": rule["english"],
            "rule": self._rule_brief(rid),
            "evidence": evidence,
            "steps": steps,
            "watchouts": self._watchouts(rid),
            "tickets": rule["tickets"],
        }

    def final_call(self, profile: str, manual_lead_s: int | None, manual_at: int | None) -> dict | None:
        """The last alert that can still prevent the trip. Interlock knows when the job will start
        (from the scheduler), so it can count down to the latest moment a fix still works, before
        any power ramp is visible. Computed from the plan without a mid-run override, so the
        history stays the same when an operator acts on it."""
        if manual_lead_s is not None:
            return None  # chiller 2 is pre-started by the plan
        base = self.predict(profile)
        if not base["will_trip"] or not self.rule_by_id[base["primary"]["rule"]]["mitigations"]:
            return None
        latest = self.latest_safe_manual_start(profile)
        if latest is None:
            return None
        t = max(0, latest - FINAL_CALL_LEAD_S)
        if manual_at is not None and manual_at <= t:
            return None  # the operator acted before the final call was due
        rid = base["primary"]["rule"]
        rule = self.rule_by_id[rid]
        what = rule["interrupts"][0] if rule["interrupts"] else "a protective action runs"
        p = self.params
        return {
            "level": "critical", "kind": "final_call", "t": t, "deadline": latest, "act_within_s": latest - t,
            "eta_s": base["primary"]["t"] - t, "job_in_s": p.job_start_s - t,
            "title": f"Last chance: {what} about {base['trip_after_start_s']} s after the job starts",
            "summary": rule["english"], "rule": self._rule_brief(rid),
            "steps": [{"id": "start_ch2_now", "title": "Start chiller 2 now (manual override)",
                       "how": f"Verified in simulation to avoid the trip if done within {latest - t} s. "
                              f"Chiller 2 needs about {p.ch2_delay_s} s to start, so after that it cannot help in time.",
                       "avoids_trip": True}],
        }

    def live_alert(self, run, pred: dict, profile: str) -> dict | None:
        """Raised when the power ramp is detected. Says how long is left to act."""
        p = self.params
        fac = run.fac_kw
        t_detect = next((t for t in range(3, len(fac)) if fac[t] - fac[t - 3] >= RAMP_DETECT_KW_3S), None)
        if t_detect is None:
            return None
        if not pred["will_trip"]:
            return {
                "level": "info", "kind": "live_alert", "t": t_detect,
                "title": "Power ramp detected. No protective rule is predicted to fire.",
                "summary": f"Facility power is rising. Peak supply temperature is predicted to stay at {pred['peak_temp_c']} °C.",
                "steps": [], "rule": None,
            }
        rid = pred["primary"]["rule"]
        eta = pred["primary"]["t"] - t_detect
        what = self.rule_by_id[rid]["interrupts"][0] if self.rule_by_id[rid]["interrupts"] else "a protective action runs"
        steps, deadline = [], None
        if self.rule_by_id[rid]["mitigations"]:
            latest = self.latest_safe_manual_start(profile)
            if latest is not None and latest >= t_detect:
                deadline = latest - t_detect
                steps.append({
                    "id": "start_ch2_now", "title": "Start chiller 2 now (manual override)",
                    "how": f"Turn on the manual chiller 2 start override. Verified in simulation to avoid the trip if done within {deadline} s.",
                    "avoids_trip": True,
                })
        if not steps:
            steps.append({
                "id": "prepare_recovery", "title": "Too late to prevent the trip. Prepare to recover.",
                "how": (f"Expect the cooling restart to be blocked for {_fmt(self.facts['lockout_s'] or 0)} s. "
                        "Checkpoint or pause training jobs now and do not attempt a restart before the lockout ends."),
                "avoids_trip": False,
            })
        return {
            "level": "critical", "kind": "live_alert", "t": t_detect,
            "title": f"Power ramp detected. {what[0].upper()}{what[1:]} in about {eta} s.",
            "summary": self.rule_by_id[rid]["english"],
            "rule": self._rule_brief(rid), "eta_s": eta, "act_within_s": deadline, "steps": steps,
        }

    # ------------------------------------------------------------ simulation + handoff
    def simulate(self, profile: str = "single", manual_lead_s: int | None = None,
                 manual_at: int | None = None) -> dict:
        """Run the scenario. `manual_at` (absolute second) lets the dashboard model an operator
        turning on the chiller 2 override mid-run, e.g. in response to the live alert."""
        p = self.params
        run, manual_at = self._run(profile, manual_lead_s, manual_at)
        pred = self.summarize(run)
        baseline = self.prewarning("single", None)
        events: list[dict] = []
        events.append({"t": 0, "type": "prewarning", "level": baseline["level"], "title": f"Pre-warning: {baseline['title']}"})
        if profile == "staged":
            events.append({"t": 0, "type": "action", "level": "info",
                           "title": f"Scheduler starts the job in two stages (half power for {p.staged_hold_s} s, then full)"})
        if manual_at is not None:
            events.append({"t": manual_at, "type": "action", "level": "info",
                           "title": "Operator turns on the manual chiller 2 start override"})
        latest_safe = self.latest_safe_manual_start(profile) if pred["will_trip"] or manual_at is not None else None
        final = self.final_call(profile, manual_lead_s, manual_at)
        if final:
            events.append({"t": final["t"], "type": "final_call", "level": "critical", "title": final["title"]})
        live = self.live_alert(run, pred, profile)
        if live:
            events.append({"t": live["t"], "type": "live_alert", "level": live["level"], "title": live["title"]})
        for pe in pred["protective_events"]:
            rule = self.rule_by_id[pe["rule"]]
            events.append({"t": pe["t"], "type": "rule_fired", "level": "critical",
                           "title": f"Rule {pe['rule']} fired: {rule['interrupts'][0]}"})
        if pred["throttle_t"]:
            events.append({"t": pred["throttle_t"], "type": "impact", "level": "critical", "title": "GPUs throttle (supply temperature too high)"})
        if pred["shutdown_t"]:
            events.append({"t": pred["shutdown_t"], "type": "impact", "level": "critical", "title": "GPUs shut down on over-temperature"})
        restart = next((t for t, f in zip(run.t, run.fired) if "R3" in f), None)
        if restart:
            events.append({"t": restart, "type": "recovery", "level": "info", "title": "Restart lockout ends and cooling pumps resume (rule R3)"})
        if not pred["will_trip"]:
            events.append({"t": p.job_start_s + p.ramp_s + 5, "type": "outcome", "level": "ok",
                           "title": "Job running. No protective rule fired."})
        events.sort(key=lambda e: (e["t"], e["type"] != "prewarning"))
        return {
            "profile": profile, "manual_ch2_at": manual_at, "prediction": pred, "events": events,
            "prewarning": baseline, "final_call": final, "live_alert": live,
            "series": {
                "t": run.t, "temp": run.temp, "it_kw": run.it_kw, "fac_kw": run.fac_kw, "cool_kw": run.cool_kw,
                "cap_kw": run.cap_kw, "pumps": run.pumps, "ch2_running": run.ch2_running,
            },
            "job_start": p.job_start_s, "duration": p.duration_s, "latest_safe_manual_start": latest_safe,
            "thresholds": {"throttle_c": p.throttle_c, "shutdown_c": p.shutdown_c, "power_cap_kw": self.facts["power_cap_kw"]},
            "handoff": self.handoff(pred, events, profile, manual_at, baseline),
        }

    def handoff(self, pred: dict, events: list[dict], profile: str, manual_at: int | None, baseline: dict) -> dict:
        p = self.params
        if pred["will_trip"]:
            rid = pred["primary"]["rule"]
            rule = self.rule_by_id[rid]
            headline = (f"At job start, {rule['interrupts'][0]} {pred['trip_after_start_s']} s in; "
                        f"outcome: {pred['outcome'].replace('_', ' ')}.")
            root = {**self._rule_brief(rid), "why": baseline["evidence"]}
            related = rule["tickets"]
            followups = [
                "Start large training jobs in two stages, or pre-start chiller 2, until the control logic is changed.",
            ] + self._watchouts(rid)
        else:
            rid = baseline["rule"]["id"] if baseline["rule"] else None
            headline = "Training job started without a protective trip."
            root = ({**self._rule_brief(rid), "why": baseline["evidence"]} if rid else None)
            related = self.rule_by_id[rid]["tickets"] if rid else []
            followups = []
            if rid:
                followups.append(f"Rule {rid} would have fired without the mitigation. Keep the mitigation in the job-start procedure.")
                followups += self._watchouts(rid)
        actions = [e["title"] for e in events if e["type"] == "action"]
        return {
            "headline": headline, "root_cause": root, "actions_taken": actions,
            "root_label": "Root cause" if pred["will_trip"] else "Risk the plan avoided",
            "timeline": [{"t": e["t"], "title": e["title"], "level": e["level"]} for e in events],
            "related_tickets": related, "followups": followups,
            "plan": {"profile": profile, "manual_ch2_at": manual_at, "job_start": p.job_start_s},
        }


def dumps(obj) -> str:
    return json.dumps(obj, indent=2, default=str)
