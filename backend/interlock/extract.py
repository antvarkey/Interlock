"""Turn parsed legacy control logic into plain-English rules.

Everything here is deterministic. Each rule keeps the source lines it came
from, the variables it reads and writes, and whether its action interrupts
cooling or IT load. The extractor also cross-checks the code against the
runbook, the point list and past incident tickets.
"""
from __future__ import annotations

import csv
import io
import json
import re
from pathlib import Path

from .st_parser import Assign, If, Program

CMP_FLIP = {">": "<=", ">=": "<", "<": ">=", "<=": ">", "=": "<>", "<>": "="}
CMP_WORDS = {">": "above", ">=": "at or above", "<": "below", "<=": "at or below", "=": "equal to", "<>": "not equal to"}
STOPWORDS = {
    "when", "then", "that", "this", "with", "from", "after", "about", "while", "during", "again",
    "same", "were", "have", "been", "pattern", "possibly", "started", "start", "job", "ticket",
    "closed", "action", "taken", "found", "cause", "unknown", "several", "never", "test", "the", "and",
}


# ----------------------------------------------------------------- helpers
def negate(e):
    if e[0] == "bin" and e[1] in CMP_FLIP:
        return ("bin", CMP_FLIP[e[1]], e[2], e[3])
    if e[0] == "un" and e[1] == "NOT":
        return e[2]
    return ("un", "NOT", e)


def fmt_num(n) -> str:
    if isinstance(n, float):
        s = f"{n:.6f}".rstrip("0").rstrip(".")
        return s if s else "0"
    return str(n)


def last_line(stmts) -> int:
    best = 0
    for s in stmts:
        if isinstance(s, Assign):
            best = max(best, s.line)
        else:
            best = max(best, s.end_line)
    return best


def vars_in(e, acc: set):
    if e[0] == "var":
        acc.add(e[1])
    elif e[0] == "un":
        vars_in(e[2], acc)
    elif e[0] == "bin":
        vars_in(e[2], acc)
        vars_in(e[3], acc)
    return acc


def find_compares(e, var: str, out: list):
    """Collect numbers that `var` is compared against inside expression e."""
    if e[0] == "bin":
        if e[1] in CMP_FLIP and e[2] == ("var", var) and e[3][0] == "num":
            out.append(e[3][1])
        find_compares(e[2], var, out)
        find_compares(e[3], var, out)
    elif e[0] == "un":
        find_compares(e[2], var, out)
    return out


# ----------------------------------------------------------------- extractor
class Extractor:
    def __init__(self, prog: Program, glossary: dict, scan_s: float = 1.0):
        self.prog = prog
        self.g = glossary
        self.scan_s = scan_s
        self.counters: dict[str, tuple] = {}
        self.rules: list[dict] = []
        self.derived: list[dict] = []

    # --- glossary access
    def desc(self, v: str) -> str:
        return self.g.get(v, {}).get("desc", v.lower())

    def the(self, v: str) -> str:
        return f"the {self.desc(v)}"

    def unit(self, v: str) -> str:
        u = self.g.get(v, {}).get("unit", "")
        return f" {u}" if u and u != "scans" else ""

    # --- text rendering
    def expr_text(self, e) -> str:
        k = e[0]
        if k == "num":
            return fmt_num(e[1])
        if k == "bool":
            return "on" if e[1] else "off"
        if k == "var":
            return self.desc(e[1])
        if k == "un":
            return f"not {self.expr_text(e[2])}" if e[1] == "NOT" else f"minus {self.expr_text(e[2])}"
        word = {"+": "plus", "-": "minus", "*": "times", "/": "divided by"}.get(e[1], e[1])
        return f"{self.expr_text(e[2])} {word} {self.expr_text(e[3])}"

    def cond_text(self, e) -> str:
        k = e[0]
        if k == "var":
            return self.g.get(e[1], {}).get("true_text") or f"{self.the(e[1])} is on"
        if k == "un" and e[1] == "NOT" and e[2][0] == "var":
            return self.g.get(e[2][1], {}).get("false_text") or f"{self.the(e[2][1])} is off"
        if k == "bin" and e[1] == "AND":
            return f"{self.cond_text(e[2])} and {self.cond_text(e[3])}"
        if k == "bin" and e[1] == "OR":
            return f"either {self.cond_text(e[2])} or {self.cond_text(e[3])}"
        if k == "bin" and e[1] in CMP_WORDS:
            l, r = e[2], e[3]
            if l[0] == "var" and l[1] in self.counters and r[0] == "num" and e[1] in (">=", ">"):
                n = r[1] if e[1] == ">=" else r[1] + 1
                inner = self.cond_text(self.counters[l[1]][0])
                return f"{inner} for {n} consecutive scans (about {fmt_num(n * self.scan_s)} s)"
            if l[0] == "var" and r[0] == "num":
                return f"{self.the(l[1])} is {CMP_WORDS[e[1]]} {fmt_num(r[1])}{self.unit(l[1])}"
            return f"{self.expr_text(l)} is {CMP_WORDS[e[1]]} {self.expr_text(r)}"
        if k == "un" and e[1] == "NOT":
            return f"not ({self.cond_text(e[2])})"
        return self.expr_text(e)

    def action_text(self, a: Assign) -> str:
        g = self.g.get(a.name, {})
        e = a.expr
        if e[0] == "bool":
            if e[1]:
                return g.get("set_true") or f"turn on the {self.desc(a.name)}"
            return g.get("set_false") or f"turn off the {self.desc(a.name)}"
        if e[0] == "num":
            return f"set the {self.desc(a.name)} to {fmt_num(e[1])}{self.unit(a.name)}"
        if e[0] == "bin" and e[1] in "+-" and e[2] == ("var", a.name) and e[3][0] == "num":
            verb = "increase" if e[1] == "+" else "decrease"
            return f"{verb} the {self.desc(a.name)} by {fmt_num(e[3][1])}{self.unit(a.name)}"
        return f"set the {self.desc(a.name)} to ({self.expr_text(e)})"

    # --- passes
    def is_counter(self, s) -> tuple | None:
        """IF c THEN X := X + 1; ELSE X := 0; END_IF  ->  counter of consecutive scans where c holds."""
        if not isinstance(s, If) or len(s.branches) != 2:
            return None
        a, b = s.branches
        if b.cond is not None or len(a.body) != 1 or len(b.body) != 1:
            return None
        inc, rst = a.body[0], b.body[0]
        if not (isinstance(inc, Assign) and isinstance(rst, Assign)) or inc.name != rst.name:
            return None
        if inc.expr == ("bin", "+", ("var", inc.name), ("num", 1)) and rst.expr == ("num", 0):
            return inc.name, a.cond
        return None

    def run(self):
        for s in self.prog.body:
            c = self.is_counter(s)
            if c:
                self.counters[c[0]] = (c[1], s.line)
        self.walk(self.prog.body, [], top=True)
        return self.rules

    def walk(self, stmts, path, top=False):
        for s in stmts:
            if isinstance(s, Assign):
                if not top:
                    continue
                d = self.prog.decl_by_name[s.name]
                if d.block == "output":
                    self.add_rule("follows", [], [s], s.line, (s.line, s.line))
                else:
                    self.derived.append({
                        "var": s.name, "line": s.line,
                        "english": f"{self.desc(s.name).capitalize()} = {self.expr_text(s.expr)}.",
                    })
                continue
            if self.is_counter(s):
                continue
            prev = []
            for b in s.branches:
                bc = path + [negate(c) for c in prev] + ([b.cond] if b.cond is not None else [])
                direct = [x for x in b.body if isinstance(x, Assign)]
                if direct:
                    self.add_rule("branch", bc, direct, b.line, (b.line, last_line(b.body)))
                self.walk([x for x in b.body if isinstance(x, If)], bc)
                if b.cond is not None:
                    prev.append(b.cond)

    def add_rule(self, kind, conds, actions, trigger_line, span):
        rid = f"R{len(self.rules) + 1}"
        reads, writes = set(), set()
        for c in conds:
            vars_in(c, reads)
        for a in actions:
            vars_in(a.expr, reads)
            writes.add(a.name)
        interrupts = []
        for a in actions:
            g = self.g.get(a.name, {})
            if kind == "follows":
                if g.get("impact_true"):
                    interrupts.append(g["impact_true"])
            elif a.expr[0] == "bool":
                key = "impact_true" if a.expr[1] else "impact_false"
                if g.get(key):
                    interrupts.append(g[key])
        if kind == "follows":
            a = actions[0]
            cond = self.cond_text(a.expr)
            english = f"The {self.desc(a.name)} is on whenever {cond}, and off otherwise."
            cond_txt = cond
            act_txt = [self.action_text(Assign(a.name, ("bool", True), a.line))]
            cond_exprs = [a.expr]
        else:
            cond_txt = " and ".join(self.cond_text(c) for c in conds) if conds else "every scan"
            act_txt = [self.action_text(a) for a in actions]
            acts = ", ".join(act_txt[:-1]) + (", and " if len(act_txt) > 2 else " and ") + act_txt[-1] if len(act_txt) > 1 else act_txt[0]
            english = f"When {cond_txt}, {acts}."
            cond_exprs = conds
        english = english[0].upper() + english[1:]
        self.rules.append({
            "id": rid,
            "kind": kind,
            "english": english,
            "condition": cond_txt[0].upper() + cond_txt[1:],
            "actions": act_txt,
            "lines": list(span),
            "trigger_line": trigger_line,
            "reads": sorted(reads),
            "writes": sorted(writes),
            "sets_true": sorted(a.name for a in actions if kind == "branch" and a.expr == ("bool", True)),
            "interrupts": interrupts,
            "protective": bool(interrupts),
            "_cond_exprs": cond_exprs,
            "_actions": actions,
        })


# ----------------------------------------------------------------- cross-checks
def parse_runbook(text: str) -> dict[str, tuple[float, str, str]]:
    """Read the 'Documented parameters' table. Returns label -> (value, unit, raw)."""
    out = {}
    for line in text.splitlines():
        if not line.startswith("|") or set(line.replace("|", "").strip()) <= set("- "):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) != 2 or cells[0].lower() == "parameter":
            continue
        m = re.match(r"([\d.]+)\s*(minutes?|min|seconds?|secs?|s|kW|°C/s)\b", cells[1])
        if not m:
            continue
        val, unit = float(m.group(1)), m.group(2)
        if unit.startswith("min"):
            val, unit = val * 60, "s"
        elif unit.startswith("sec") or unit == "s":
            unit = "s"
        out[cells[0]] = (val, unit, cells[1])
    return out


def runbook_findings(ex: Extractor, runbook_text: str) -> list[dict]:
    rb = parse_runbook(runbook_text)
    findings = []
    for var, g in ex.g.items():
        spec = g.get("runbook")
        if not spec or spec["label"] not in rb:
            continue
        values, rule_ids = [], []
        for r in ex.rules:
            found = []
            if spec["mode"] == "assign":
                found = [a.expr[1] for a in r["_actions"] if a.name == var and a.expr[0] == "num"]
            else:
                exprs = list(r["_cond_exprs"])
                for cv in r["reads"]:
                    if cv in ex.counters:
                        exprs.append(ex.counters[cv][0])
                for c in exprs:
                    found += find_compares(c, var, [])
            if found:
                values += found
                rule_ids.append(r["id"])
        if not values:
            continue
        code_val = values[0]
        doc_val, doc_unit, raw = rb[spec["label"]]
        same = abs(code_val - doc_val) < 1e-9
        rule = next(r for r in ex.rules if r["id"] == rule_ids[0])
        findings.append({
            "kind": "runbook_ok" if same else "runbook_mismatch",
            "label": spec["label"],
            "unit": spec["unit"],
            "code_value": code_val,
            "runbook_value": doc_val,
            "runbook_text": raw,
            "rules": rule_ids,
            "lines": rule["lines"],
            "text": (f"{spec['label']}: code and runbook agree ({fmt_num(code_val)} {spec['unit']})."
                     if same else
                     f"{spec['label']}: the code uses {fmt_num(code_val)} {spec['unit']} but the runbook says {raw}."),
        })
    return findings


def point_findings(ex: Extractor, csv_text: str) -> list[dict]:
    findings = []
    for row in csv.DictReader(io.StringIO(csv_text)):
        if row["status"].strip().upper() != "RETIRED":
            continue
        tag = row["tag"]
        users = [r for r in ex.rules if tag in r["reads"]]
        if users:
            findings.append({
                "kind": "dead_input",
                "label": f"Retired tag {tag}",
                "rules": [r["id"] for r in users],
                "lines": users[0]["lines"],
                "text": (f"Tag {tag} ({row['description']}) was retired on {row['last_changed']}, "
                         f"so rule {users[0]['id']} can never fire."),
            })
    return findings


def _tokens(text: str) -> set[str]:
    t = text.lower()
    t = re.sub(r"tripp(ed|ing)|trips|tripped", "trip", t)
    t = re.sub(r"stopp(ed|ing)|stops|stopped", "stop", t)
    t = re.sub(r"pumps", "pump", t)
    t = re.sub(r"restarted|restarts", "restart", t)
    return {w for w in re.findall(r"[a-z0-9_]+", t) if len(w) > 3 and w not in STOPWORDS}


def link_tickets(rules: list[dict], tickets: list[dict], glossary: dict) -> dict[str, list[dict]]:
    """Link each ticket to the one rule whose wording overlaps it most.

    A rule's wording is its plain-English text plus the "also_known_as" words
    the glossary attaches to the variables it writes. Ties go to the rule that
    interrupts cooling or load, since that is what an incident ticket describes.
    """
    linked: dict[str, list[dict]] = {r["id"]: [] for r in rules}
    rule_tokens = {}
    for r in rules:
        words = r["english"]
        for v in r["writes"]:
            words += " " + glossary.get(v, {}).get("also_known_as", "")
        rule_tokens[r["id"]] = _tokens(words)
    protective = {r["id"]: r["protective"] for r in rules}
    for t in tickets:
        tt = _tokens(t["text"])
        scored = sorted(((len(tt & rt), protective[rid], rid) for rid, rt in rule_tokens.items()), reverse=True)
        if scored and scored[0][0] >= 2:
            linked[scored[0][2]].append(t)
    return linked


# ----------------------------------------------------------------- public API
def load_legacy(folder: str | Path) -> dict:
    folder = Path(folder)
    return {
        "source": (folder / "chw_sequencer.st").read_text(),
        "glossary": json.loads((folder / "glossary.json").read_text()),
        "runbook": (folder / "runbook.md").read_text(),
        "points": (folder / "point_list.csv").read_text(),
        "tickets": json.loads((folder / "tickets.json").read_text()),
        "mitigations": json.loads((folder / "mitigations.json").read_text()),
    }


def extract(prog: Program, legacy: dict, scan_s: float = 1.0) -> dict:
    ex = Extractor(prog, legacy["glossary"], scan_s)
    ex.run()
    findings = runbook_findings(ex, legacy["runbook"]) + point_findings(ex, legacy["points"])
    linked = link_tickets(ex.rules, legacy["tickets"], legacy["glossary"])
    for r in ex.rules:
        r["tickets"] = linked[r["id"]]
        r["mitigations"] = [m for m in legacy["mitigations"] if m["applies_to_sets"] in r["sets_true"]]
        r["findings"] = [f for f in findings if r["id"] in f["rules"] and f["kind"] != "runbook_ok"]
    # edges for the dependency graph: variable -> rule -> variable
    edges = []
    for r in ex.rules:
        edges += [{"from": v, "to": r["id"]} for v in r["reads"]]
        edges += [{"from": r["id"], "to": v} for v in r["writes"]]
    hooks = {r["trigger_line"]: r["id"] for r in ex.rules}
    public_rules = [{k: v for k, v in r.items() if not k.startswith("_")} for r in ex.rules]
    return {
        "rules": public_rules,
        "derived": ex.derived,
        "counters": {k: {"cond": ex.cond_text(v[0]), "line": v[1]} for k, v in ex.counters.items()},
        "findings": findings,
        "graph": {"edges": edges},
        "hooks": hooks,
        "rule_objects": ex.rules,
    }
