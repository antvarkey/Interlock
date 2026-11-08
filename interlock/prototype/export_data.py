"""Export the Python engine's results as JSON for the browser prototype."""
import json, sys
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
from interlock.engine import Interlock
from interlock.st_parser import Assign, If

def ser(s):
    if isinstance(s, Assign):
        return {"t": "assign", "name": s.name, "expr": s.expr, "line": s.line}
    return {"t": "if", "line": s.line, "end": s.end_line,
            "branches": [{"cond": b.cond, "line": b.line, "body": [ser(x) for x in b.body]} for b in s.branches]}

il = Interlock()
st = il.public_state()
data = {
    "rules": st["rules"], "derived": st["derived"], "findings": st["findings"], "counters": st["counters"],
    "legacy_source": st["legacy_source"], "modern_source": st["modern_source"], "glossary": st["glossary"],
    "tickets": st["tickets"], "facts": st["facts"], "plant": st["plant"],
    "decls": [{"name": d.name, "type": d.type, "init": d.init, "block": d.block, "comment": d.comment} for d in il.prog.decls],
    "ast": [ser(s) for s in il.prog.body],
    "hooks": {str(k): v for k, v in il.ex["hooks"].items()},
    "mitigations": il.legacy["mitigations"],
}
# reference outputs from Python for checking the JS port
ref = {}
for name, prof, at in [("single", "single", None), ("prestart", "single", 30), ("staged", "staged", None)]:
    run, _ = il._run(prof, manual_at=at)
    ref[name] = {"temp": run.temp, "fac_kw": run.fac_kw, "it_kw": run.it_kw, "fired": run.fired, "summary": il.summarize(run)}
ref["latest_safe"] = il.latest_safe_manual_start("single")
json.dump(data, open(str(__import__("pathlib").Path(__file__).resolve().parent / "data.json"), "w"))
json.dump(ref, open(str(__import__("pathlib").Path(__file__).resolve().parent / "ref.json"), "w"))
print("ok", len(json.dumps(data)), "bytes; latest_safe", ref["latest_safe"])
