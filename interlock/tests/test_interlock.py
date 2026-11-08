import pytest

from interlock.engine import Interlock, LegacyAdapter
from interlock.extract import fmt_num, negate
from interlock.interp import LegacyController
from interlock.parity import BUGS
from interlock.st_parser import ParseError, parse


@pytest.fixture(scope="module")
def il():
    return Interlock()


# ---------------------------------------------------------------- parser / interpreter
def test_parse_counts_and_comments(il):
    names = {d.name: d for d in il.prog.decls}
    assert len(il.prog.decls) == 16
    assert names["TS1"].comment == "CHW SUPPLY TEMP C"
    assert names["PMP_CM"].init is True
    assert names["TS1_P"].init == 7.0


def test_parse_error_has_line_number():
    with pytest.raises(ParseError, match="line 3"):
        parse("VAR\nEND_VAR\nX := ;")


def test_interpreter_trips_after_20_scans_of_fast_rise():
    prog = parse(open("legacy/chw_sequencer.st").read())
    c = LegacyController(prog)
    temp, tripped_at = 7.0, None
    for i in range(40):
        temp += 0.2
        outs, _ = c.step({"TS1": temp, "PF1": 500.0, "CH1_LD": 50.0, "CH2_ST": False, "MAN_C2": False, "AI_77": 0.0})
        if not outs["PMP_CM"] and tripped_at is None:
            tripped_at = i + 1
    assert tripped_at == 20  # the 20th consecutive scan with a rise above 0.1 degC trips the loop


# ---------------------------------------------------------------- extraction
def test_seven_rules_with_source_lines(il):
    assert [r["id"] for r in il.rules] == [f"R{i}" for i in range(1, 8)]
    r1 = il.rule_by_id["R1"]
    assert r1["lines"] == [52, 56]
    assert "for 20 consecutive scans" in r1["english"]
    assert "300 s" in r1["english"]
    assert r1["protective"] and "the cooling loop stops" in r1["interrupts"]


def test_findings(il):
    kinds = sorted(f["kind"] for f in il.ex["findings"])
    assert kinds == ["dead_input", "runbook_mismatch", "runbook_mismatch", "runbook_ok", "runbook_ok"]
    texts = " ".join(f["text"] for f in il.ex["findings"])
    assert "300 s but the runbook says 2 minutes" in texts
    assert "0.1 °C/s but the runbook says 0.15" in texts
    assert "AI_77" in texts and "can never fire" in texts


def test_tickets_link_to_the_trip_rule_only(il):
    assert {t["id"] for t in il.rule_by_id["R1"]["tickets"]} == {"INC-2291", "INC-2347", "INC-2402", "INC-2503"}
    assert [t["id"] for t in il.rule_by_id["R7"]["tickets"]] == ["INC-2418"]
    linked = {t["id"] for r in il.rules for t in r["tickets"]}
    assert "INC-2455" not in linked and "INC-2460" not in linked  # unrelated tickets stay unlinked


def test_helpers():
    assert fmt_num(0.1) == "0.1" and fmt_num(1850.0) == "1850" and fmt_num(20) == "20"
    assert negate(("bin", ">", ("var", "X"), ("num", 1))) == ("bin", "<=", ("var", "X"), ("num", 1))


# ---------------------------------------------------------------- rewrite and parity
def test_generated_code_is_readable_and_annotated(il):
    assert "class ChwSequencer" in il.modern_source
    assert "R1 (original lines 52-56)" in il.modern_source
    assert "TS1" not in il.modern_source.replace("TS1 LAST", "")  # cryptic tags are gone


def test_parity_passes_and_covers_every_rule(il):
    r = il.parity(sequences=400)
    assert r["passed"] and r["scans"] > 50_000
    assert r["rules_covered"] == r["rules_total"] == 7


@pytest.mark.parametrize("bug", sorted(BUGS))
def test_parity_catches_injected_bugs(il, bug):
    r = il.parity(sequences=400, bug=bug)
    assert not r["passed"] and r["first_mismatches"]


@pytest.mark.parametrize("profile,lead", [("single", None), ("staged", None), ("single", 60)])
def test_old_and_new_agree_inside_the_plant(il, profile, lead):
    at = None if lead is None else il.params.job_start_s - lead
    assert il.sim_parity(profile, at)


# ---------------------------------------------------------------- plant, predictor, alerts
def test_unmitigated_start_trips_about_28s_in(il):
    p = il.predict("single")
    assert p["will_trip"] and p["primary"]["rule"] == "R1"
    assert p["trip_after_start_s"] == 28 and p["outcome"] == "thermal_shutdown"


@pytest.mark.parametrize("profile,lead", [("staged", None), ("single", 60), ("staged", 60)])
def test_mitigations_avoid_the_trip(il, profile, lead):
    p = il.predict(profile, lead)
    assert not p["will_trip"] and p["peak_temp_c"] == 7.0
    assert p["power_cap_margin_kw"] > 0  # the fix must not push the plant into the load-shed rule


def test_too_late_to_pre_start_does_not_help(il):
    assert il.predict("single", manual_at=il.params.job_start_s + 10)["will_trip"]
    latest = il.latest_safe_manual_start("single")
    assert latest is not None and latest < il.params.job_start_s + 10
    assert not il.predict("single", manual_at=latest)["will_trip"]
    assert il.predict("single", manual_at=latest + 1)["will_trip"]


def test_prewarning_contents(il):
    pw = il.prewarning("single")
    assert pw["level"] == "critical" and "28 s" in pw["title"]
    assert pw["rule"]["id"] == "R1" and pw["rule"]["lines"] == [52, 56]
    assert {s["id"] for s in pw["steps"]} == {"prestart_ch2", "staged_start"}
    assert all(s["avoids_trip"] for s in pw["steps"])
    assert any("300 s but the runbook says 2 minutes" in w for w in pw["watchouts"])
    assert il.prewarning("staged")["level"] == "ok"


def test_live_alert_window_is_short_and_honest(il):
    sim = il.simulate("single")
    la = sim["live_alert"]
    assert la["level"] == "critical" and la["act_within_s"] is not None and la["act_within_s"] < 10


def test_simulation_events_and_handoff(il):
    bad = il.simulate("single")
    types = [e["type"] for e in bad["events"]]
    assert types[0] == "prewarning" and "rule_fired" in types and "recovery" in types
    assert bad["handoff"]["root_label"] == "Root cause" and len(bad["handoff"]["related_tickets"]) == 4
    good = il.simulate("staged", 60)
    assert good["handoff"]["root_label"] == "Risk the plan avoided"
    assert not any(e["type"] == "rule_fired" for e in good["events"])
    assert len(bad["series"]["t"]) == il.params.duration_s


# ---------------------------------------------------------------- API
def test_api():
    from fastapi.testclient import TestClient
    from interlock.server import app

    c = TestClient(app)
    assert len(c.get("/api/state").json()["rules"]) == 7
    assert c.post("/api/prewarning", json={"profile": "single"}).json()["level"] == "critical"
    assert c.post("/api/simulate", json={"profile": "staged"}).json()["prediction"]["outcome"] == "ok"
    assert c.post("/api/parity", json={"sequences": 50}).json()["passed"]
    assert c.post("/api/prewarning", json={"profile": "nope"}).status_code == 400
    assert c.post("/api/prewarning", json={"profile": "single", "manual_lead_s": 9999}).status_code == 400
    assert c.post("/api/parity", json={"bug": "nope"}).status_code == 400
    ans = c.post("/api/ask", json={"question": "why?"}).json()
    assert "answer" in ans
    assert c.get("/").status_code == 200


# ---------------------------------------------------------------- LLM-assisted jobs (scripted stand-in, no network)
import json as _json

from interlock import llm_assist


def _fenced(src: str) -> str:
    return "Here is the rewrite.\n```python\n" + src + "\n```"


def test_llm_rewrite_repairs_after_a_mismatch(il):
    wrong = il.modern_source.replace("self.rise_counter >= 20", "self.rise_counter >= 21")
    llm = llm_assist.ScriptedLLM([_fenced(wrong), _fenced(il.modern_source)])
    rep = llm_assist.propose_rewrite(il, llm, max_attempts=3, sequences=60, holdout_sequences=80)
    assert rep["accepted"] and [a["stage"] for a in rep["attempts"]] == ["parity mismatch", "accepted"]
    assert not rep["live_model"]
    # the second prompt carried the concrete difference back to the model
    feedback = llm.calls[1][-1]["content"]
    assert "disagree" in feedback and "rise_counter" in feedback and "original=" in feedback


def test_llm_rewrite_rejects_unsafe_code_before_running(il):
    evil = il.modern_source.replace("class ChwSequencer:", "import os\nopen('/tmp/x', 'w')\n\nclass ChwSequencer:")
    llm = llm_assist.ScriptedLLM([_fenced(evil), _fenced(il.modern_source)])
    rep = llm_assist.propose_rewrite(il, llm, max_attempts=2, sequences=40, holdout_sequences=40)
    assert rep["attempts"][0]["stage"] == "rejected before running" and "imports" in rep["attempts"][0]["detail"]
    assert rep["accepted"]


def test_llm_rewrite_not_accepted_if_never_correct(il):
    wrong = il.modern_source.replace("self.restart_lockout_s = 300", "self.restart_lockout_s = 120")
    rep = llm_assist.propose_rewrite(il, llm_assist.ScriptedLLM([_fenced(wrong)] * 3), max_attempts=3, sequences=60)
    assert not rep["accepted"] and rep["source"] is None and "deterministic rewrite stays" in rep["note"]


def test_screening_blocks_dangerous_constructs():
    ins, outs = ["a"], ["o"]
    base = "class ChwSequencer:\n    def reset(self):\n        pass\n    def step(self, *, a):\n        {}\n        return {{'o': 1}}, []\n"
    assert llm_assist.screen_source(base.format("pass"), ins, outs) == []
    for bad in ("while True: pass", "x = getattr(self, 'y')", "x = self.__class__", "y = lambda: 1", "exec('1')"):
        assert llm_assist.screen_source(base.format(bad), ins, outs), bad
    assert llm_assist.screen_source("class Other: pass", ins, outs)


def test_glossary_draft_validates_and_needs_review(il):
    good = {d.name: {"name": il.legacy["glossary"][d.name]["name"] + "_x", "desc": "something"} for d in il.prog.decls}
    bad = dict(good); bad["TS1"] = {"name": "Bad Name", "desc": "x"}
    rep = llm_assist.draft_glossary(il, llm_assist.ScriptedLLM(["```json\n" + _json.dumps(bad) + "\n```",
                                                             "```json\n" + _json.dumps(good) + "\n```"]))
    assert rep["status"].startswith("proposed") and rep["entries"]["TS1"]["name"].endswith("_x")
    assert rep["differs_from_approved"]  # the human sees what changed against the approved glossary
    assert llm_assist.draft_glossary(il, llm_assist.ScriptedLLM(["nonsense"] * 3))["status"] == "failed"


def test_engine_adopts_llm_rewrite_only_when_it_passes(tmp_path, monkeypatch):
    import interlock.engine as eng

    monkeypatch.setattr(eng, "ROOT", tmp_path)
    (tmp_path / "legacy").mkdir()
    for f in (eng.Path(__file__).resolve().parent.parent / "legacy").iterdir():
        (tmp_path / "legacy" / f.name).write_text(f.read_text())
    base = eng.Interlock(legacy_dir=tmp_path / "legacy")
    (tmp_path / "generated").mkdir()
    gen = tmp_path / "generated" / "llm_sequencer.py"
    gen.write_text(base.modern_source.replace("self.rise_counter >= 20", "self.rise_counter >= 21"))
    assert eng.Interlock(legacy_dir=tmp_path / "legacy", rewrite="llm").rewrite_origin == "rules"  # failed parity: ignored
    gen.write_text(base.modern_source)
    assert eng.Interlock(legacy_dir=tmp_path / "legacy", rewrite="llm").rewrite_origin == "llm"


def test_llm_api_reports_unavailable_without_key(monkeypatch):
    from fastapi.testclient import TestClient
    from interlock.server import app

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    c = TestClient(app)
    st = c.get("/api/llm/status").json()
    assert st["available"] is False and st["rewrite_in_use"] == "rules"
    assert c.post("/api/llm/translate").json()["available"] is False
