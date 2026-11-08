"""Differential testing: run the legacy program and the modern rewrite side by
side on the same generated sensor sequences and compare every output, every
internal variable and the list of rules that fired, on every scan.

A pass means "no differences across N scans of generated inputs". It is strong
evidence, not a proof.
"""
from __future__ import annotations

import random
import time

from .codegen import load_class
from .interp import LegacyController

BUGS = {
    "off_by_one": ("self.rise_counter >= 20", "self.rise_counter >= 21",
                   "Trip counter threshold changed from 20 to 21 scans"),
    "lockout": ("self.restart_lockout_s = 300", "self.restart_lockout_s = 120",
                "Restart lockout changed from 300 s to 120 s"),
}


def _segments(rng: random.Random, n: int, make):
    out = []
    while len(out) < n:
        out.extend(make(rng, rng.randint(5, 40)))
    return out[:n]


def gen_inputs(rng: random.Random, scans: int, heavy_start: bool) -> list[dict]:
    temp, seq = 25.0, []

    def temp_seg(r, k):
        nonlocal temp
        mode = r.choices(["flat", "rise", "fall"], [0.4, 0.4, 0.2])[0]
        slope = {"flat": 0.0, "rise": r.uniform(0.01, 0.07), "fall": -r.uniform(0.005, 0.03)}[mode]
        vals = []
        for _ in range(k):
            temp = min(45.0, max(15.0, temp + slope + (r.uniform(-0.004, 0.004) if mode == "flat" else 0.0)))
            vals.append(temp)
        return vals

    temps = _segments(rng, scans, temp_seg)
    power = _segments(rng, scans, lambda r, k: [r.choice([2000.0, 4500.0, 9000.0, 10499.0, 10501.0, 12000.0]) + r.uniform(-100, 100)] * k)
    loads = _segments(rng, scans, lambda r, k: [r.choice([15.0, 55.0, 79.9, 80.0, 95.0, 100.0])] * k)
    if heavy_start:
        loads[:110] = [95.0] * 110
    man = _segments(rng, scans, lambda r, k: [r.random() < 0.15] * k)
    run2 = _segments(rng, scans, lambda r, k: [r.random() < 0.5] * k)
    aux = _segments(rng, scans, lambda r, k: [0.0 if r.random() < 0.9 else r.uniform(0.1, 5.0)] * k)
    for i in range(scans):
        seq.append({
            "chw_supply_temp_c": temps[i], "facility_power_kw": power[i], "chiller1_load_pct": loads[i],
            "chiller2_running": run2[i], "chiller2_manual_start": man[i], "aux_cond_flow_77": aux[i],
        })
    return seq


def run_parity(prog, hooks: dict, glossary: dict, modern_source: str, rule_ids: list[str],
               sequences: int = 200, seed: int = 7, bug: str | None = None, loader=None) -> dict:
    t0 = time.time()
    desc = None
    if bug:
        old, new, desc = BUGS[bug]
        if old not in modern_source:
            raise ValueError(f"cannot inject bug {bug!r}")
        modern_source = modern_source.replace(old, new, 1)
    Modern = (loader or load_class)(modern_source)
    to_modern = {d.name: glossary.get(d.name, {}).get("name", d.name.lower()) for d in prog.decls}
    legacy_inputs = {to_modern[d.name]: d.name for d in prog.decls if d.block == "input"}
    scans_total, mismatches, coverage = 0, [], {rid: 0 for rid in rule_ids}
    master = random.Random(seed)
    for si in range(sequences):
        rng = random.Random(master.random())
        long_run = si % 4 == 0
        scans = 400 if long_run else 150
        seq = gen_inputs(rng, scans, heavy_start=(si % 3 == 0))
        if long_run:  # force an early trip so the lockout expiry path is exercised
            for k in range(5, 40):
                seq[k]["chw_supply_temp_c"] = 25.0 + 0.05 * (k - 4)
            for k in range(40, 400):
                seq[k]["chw_supply_temp_c"] = seq[39]["chw_supply_temp_c"]
        legacy, modern = LegacyController(prog, hooks), Modern()
        for k, inp in enumerate(seq):
            lo, lf = legacy.step({legacy_inputs[n]: v for n, v in inp.items()})
            mo, mf = modern.step(**inp)
            scans_total += 1
            for rid in lf:
                coverage[rid] = coverage.get(rid, 0) + 1
            diffs = []
            for d in prog.decls:
                if d.block == "input":
                    continue
                lv, mv = legacy.env[d.name], getattr(modern, to_modern[d.name])
                if lv != mv:
                    diffs.append({"field": to_modern[d.name], "legacy": lv, "modern": mv})
            if lf != mf:
                diffs.append({"field": "rules fired", "legacy": lf, "modern": mf})
            if diffs:
                if len(mismatches) < 5:
                    mismatches.append({"sequence": si, "scan": k, "inputs": inp, "recent": seq[max(0, k - 4):k + 1], "diffs": diffs})
                else:
                    mismatches.append(None)
                break  # first difference in a sequence is enough
    shown = [m for m in mismatches if m]
    return {
        "passed": not mismatches,
        "sequences": sequences,
        "scans": scans_total,
        "mismatch_sequences": len(mismatches),
        "first_mismatches": shown,
        "coverage": coverage,
        "rules_covered": sum(1 for v in coverage.values() if v > 0),
        "rules_total": len(rule_ids),
        "injected_bug": desc,
        "seconds": round(time.time() - t0, 2),
    }
