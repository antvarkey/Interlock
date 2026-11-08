"""Command line for Interlock.

    python -m interlock.cli rules              print the extracted plain-English rules
    python -m interlock.cli build              write generated/modern_sequencer.py
    python -m interlock.cli parity [--bug X]   old-vs-new differential test
    python -m interlock.cli demo               run the job-start scenarios and print the outcomes
    python -m interlock.cli translate          LLM proposes a rewrite; parity test accepts or rejects it
    python -m interlock.cli glossary-draft     LLM proposes names for cryptic tags (needs human review)
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from .engine import ROOT, Interlock
from .parity import BUGS


def main() -> None:
    ap = argparse.ArgumentParser(prog="interlock")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("rules")
    sub.add_parser("build")
    pp = sub.add_parser("parity")
    pp.add_argument("--bug", choices=sorted(BUGS))
    pp.add_argument("--sequences", type=int, default=2000)
    sub.add_parser("demo")
    tp = sub.add_parser("translate")
    tp.add_argument("--attempts", type=int, default=4)
    sub.add_parser("glossary-draft")
    args = ap.parse_args()
    il = Interlock()

    if args.cmd == "rules":
        for r in il.rules:
            flag = "  [interrupts: " + "; ".join(r["interrupts"]) + "]" if r["interrupts"] else ""
            span = str(r["lines"][0]) if r["lines"][0] == r["lines"][1] else f"{r['lines'][0]}-{r['lines'][1]}"
            print(f"{r['id']}  lines {span}{flag}\n    {r['english']}")
        print()
        for f in il.ex["findings"]:
            print(f"[{f['kind']}] {f['text']}")

    elif args.cmd == "build":
        out = Path(ROOT) / "generated" / "modern_sequencer.py"
        out.parent.mkdir(exist_ok=True)
        out.write_text(il.modern_source)
        print(f"wrote {out}")

    elif args.cmd == "parity":
        r = il.parity(sequences=args.sequences, bug=args.bug)
        print("PASS" if r["passed"] else "MISMATCH", f"- {r['scans']:,} scans, {r['sequences']} sequences, "
              f"{r['rules_covered']}/{r['rules_total']} rules covered, {r['seconds']} s")
        if r["injected_bug"]:
            print("injected:", r["injected_bug"])
        for m in r["first_mismatches"][:1]:
            print(f"first difference: sequence {m['sequence']}, scan {m['scan']}")
            for d in m["diffs"]:
                print(f"    {d['field']}: legacy={d['legacy']} rewrite={d['modern']}")
        raise SystemExit(0 if r["passed"] != bool(args.bug) else 1)

    elif args.cmd in ("translate", "glossary-draft"):
        from . import llm_assist

        client = llm_assist.default_client()
        if client is None:
            raise SystemExit("This needs the anthropic package and ANTHROPIC_API_KEY. "
                             "Everything else in Interlock works without a model.")
        out_dir = Path(ROOT) / "generated"
        out_dir.mkdir(exist_ok=True)
        if args.cmd == "translate":
            rep = llm_assist.propose_rewrite(il, client, max_attempts=args.attempts, on_progress=print)
            for a in rep["attempts"]:
                print(f"  attempt {a['n']}: {a['stage']}" + (f" - {a['detail'].splitlines()[0]}" if a["detail"] else ""))
            if rep["accepted"]:
                (out_dir / "llm_sequencer.py").write_text(rep["source"])
                print("ACCEPTED: wrote generated/llm_sequencer.py (use it with INTERLOCK_REWRITE=llm)")
            else:
                print("NOT ACCEPTED:", rep["note"])
            (out_dir / "llm_translation_report.json").write_text(json.dumps({k: v for k, v in rep.items() if k != "source"}, indent=2))
            raise SystemExit(0 if rep["accepted"] else 1)
        rep = llm_assist.draft_glossary(il, client)
        (out_dir / "glossary_proposed.json").write_text(json.dumps(rep, indent=2))
        print(rep["status"], "-> generated/glossary_proposed.json")
        for t, d in rep["differs_from_approved"].items():
            print(f"  {t}: proposed {d['proposed']!r}, approved {d['approved']!r}")

    elif args.cmd == "demo":
        for label, prof, lead in [("full-power start, no action", "single", None),
                                  ("operator pre-starts chiller 2 at T-60 s", "single", 60),
                                  ("two-stage start", "staged", None)]:
            s = il.simulate(prof, lead)
            p = s["prediction"]
            print(f"\n== {label}: {p['outcome']}  (peak {p['peak_temp_c']} C, peak facility {p['peak_facility_kw']:.0f} kW)")
            for e in s["events"]:
                print(f"   t={e['t']:>3}  [{e['level']:<8}] {e['title']}")


if __name__ == "__main__":
    main()
