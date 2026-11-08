"""Where Interlock uses a language model, and where it does not.

The LLM PROPOSES. Deterministic code DECIDES.

Two jobs use it:

1. Rewrite proposal.  The model translates the legacy controller into a modern
   Python class from the source text alone (no parser output about behaviour).
   The proposal is then
     - screened for unsafe constructs before it ever runs,
     - compared with the original controller by the parity test, and
     - only accepted if it passes a normal run AND a held-out run on different
       random inputs. On a mismatch the model gets the first difference back and
       may try again (bounded).
   The rest of Interlock never trusts the model's code on its own say-so.

2. Glossary draft.  The model proposes plain names and descriptions for cryptic
   tags (AI_77, CH1_LD ...), from the source, point list and runbook. Output is
   labelled "proposed" and a human approves it; nothing uses it automatically.

What the model never does: decide whether a job will trip cooling (the plant
simulator does that), decide a rule's meaning for the operator (the parser and
templates do that), or be the only evidence for any "verified" claim.

Needs the `anthropic` package and ANTHROPIC_API_KEY for live use. Tests use a
scripted stand-in (ScriptedLLM) so the loop is exercised without network.
"""
from __future__ import annotations

import ast
import builtins
import json
import os
import re
from typing import Protocol

from .parity import run_parity

MODEL = os.environ.get("INTERLOCK_MODEL", "claude-sonnet-5-5")
MAX_CODE_CHARS = 30_000


# ------------------------------------------------------------------ clients
class LLM(Protocol):
    name: str

    def complete(self, system: str, messages: list[dict], max_tokens: int = 4000) -> str: ...


class AnthropicLLM:
    def __init__(self, model: str = MODEL):
        import anthropic

        self.client = anthropic.Anthropic()
        self.name = model

    def complete(self, system: str, messages: list[dict], max_tokens: int = 4000) -> str:
        msg = self.client.messages.create(model=self.name, max_tokens=max_tokens, temperature=0,
                                          system=system, messages=messages)
        return "".join(b.text for b in msg.content if b.type == "text")


class ScriptedLLM:
    """Test double: returns canned replies in order. Never used outside tests/demos,
    and any report produced with it says so."""

    def __init__(self, replies: list[str]):
        self.replies, self.name, self.calls = list(replies), "scripted-test-double", []

    def complete(self, system: str, messages: list[dict], max_tokens: int = 4000) -> str:
        self.calls.append(list(messages))
        return self.replies.pop(0) if self.replies else ""


def available() -> bool:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return False
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False
    return True


def default_client() -> LLM | None:
    return AnthropicLLM() if available() else None


# ------------------------------------------------------------------ screening and loading model-written code
BANNED_NAMES = {"exec", "eval", "compile", "open", "__import__", "globals", "locals", "vars", "getattr",
                "setattr", "delattr", "input", "breakpoint", "help", "exit", "quit", "memoryview", "type", "super"}
_SAFE_NAMES = ("abs", "min", "max", "round", "bool", "int", "float", "len", "range", "tuple", "list", "dict", "str",
               "isinstance", "enumerate", "zip", "sum", "any", "all", "sorted", "reversed", "set", "repr")
SAFE_BUILTINS = {n: getattr(builtins, n) for n in _SAFE_NAMES}


def _only_future_import(name, globals=None, locals=None, fromlist=(), level=0):
    if name != "__future__":
        raise ImportError(f"import of {name!r} is not allowed")
    return builtins.__import__(name, globals, locals, fromlist, level)


SAFE_BUILTINS.update({"__import__": _only_future_import, "True": True, "False": False, "None": None,
                      "__build_class__": builtins.__build_class__, "__name__": "interlock_candidate"})


def screen_source(src: str, inputs: list[str], outputs: list[str]) -> list[str]:
    """Return a list of problems; empty means the code may be loaded."""
    problems: list[str] = []
    if len(src) > MAX_CODE_CHARS:
        return [f"code is longer than {MAX_CODE_CHARS} characters"]
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        return [f"syntax error on line {e.lineno}: {e.msg}"]
    cls = None
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            ok = isinstance(node, ast.ImportFrom) and node.module == "__future__"
            if not ok:
                problems.append(f"line {node.lineno}: imports are not allowed")
        elif isinstance(node, (ast.While, ast.AsyncFor, ast.AsyncFunctionDef, ast.Await, ast.Global, ast.Nonlocal, ast.Lambda)):
            problems.append(f"line {node.lineno}: {type(node).__name__} is not allowed")
        elif isinstance(node, ast.Name) and node.id in BANNED_NAMES:
            problems.append(f"line {node.lineno}: name '{node.id}' is not allowed")
        elif isinstance(node, ast.Attribute) and node.attr.startswith("__") and node.attr != "__init__":
            problems.append(f"line {node.lineno}: attribute '{node.attr}' is not allowed")
        elif isinstance(node, ast.ClassDef) and node.name == "ChwSequencer":
            cls = node
    if cls is None:
        problems.append("no class named ChwSequencer")
        return problems
    methods = {n.name: n for n in cls.body if isinstance(n, ast.FunctionDef)}
    if "step" not in methods or "reset" not in methods:
        problems.append("class must define reset() and step()")
    else:
        kw = [a.arg for a in methods["step"].args.kwonlyargs]
        if sorted(kw) != sorted(inputs):
            problems.append(f"step() must take exactly these keyword-only inputs: {inputs}; got {kw}")
    return problems


def load_candidate(src: str):
    """Execute screened source with a minimal set of builtins."""
    ns: dict = {"__builtins__": dict(SAFE_BUILTINS)}
    exec(compile(src, "<llm_candidate>", "exec"), ns)  # noqa: S102 - screened above
    return ns["ChwSequencer"]


def _smoke(cls, inputs: list[str], outputs: list[str], decls) -> str | None:
    """Call step once; catch crashes and wrong return shapes before the long test."""
    try:
        obj = cls()
        sample = {n: (False if d.type == "BOOL" else 0.0) for n, d in zip(inputs, [x for x in decls if x.block == "input"])}
        out, fired = obj.step(**sample)
    except Exception as e:  # model code is untrusted
        return f"step() crashed on a zero input: {type(e).__name__}: {e}"
    if not isinstance(out, dict) or sorted(out) != sorted(outputs):
        return f"step() must return a dict with exactly the keys {outputs}"
    if not isinstance(fired, list):
        return "step() must return a list of fired rule ids as its second value"
    return None


def extract_python(text: str) -> str | None:
    m = re.search(r"```(?:python)?\s*\n(.*?)```", text, re.S)
    return (m.group(1) if m else text).strip() or None


# ------------------------------------------------------------------ prompts
SYSTEM_REWRITE = (
    "You rewrite legacy PLC Structured Text into a readable, behaviour-identical Python class for a "
    "data center cooling controller. Safety matters: a one-character difference in a threshold or timer "
    "can stop cooling. Preserve statement order, comparison operators, constants and counter semantics "
    "exactly. Use the exact names provided. Reply with ONE ```python block and nothing else."
)


def _numbered(src: str) -> str:
    return "\n".join(f"{i + 1:>3}  {ln}" for i, ln in enumerate(src.splitlines()))


def rewrite_prompt(il) -> str:
    g = il.legacy["glossary"]
    nm = {d.name: g.get(d.name, {}).get("name", d.name.lower()) for d in il.prog.decls}
    rows = []
    for d in il.prog.decls:
        rows.append(f"  {d.name:<8} -> {nm[d.name]:<26} {d.block:<7} {d.type:<5} initial={d.init!r}")
    rules = []
    for r in il.rules:
        how = ("append the id when this branch is taken" if r["kind"] == "branch"
               else "append the id right after the assignment when the assigned boolean is True")
        rules.append(f"  {r['id']}  original lines {r['lines'][0]}-{r['lines'][1]}  ({how})")
    ins = [nm[d.name] for d in il.prog.decls if d.block == "input"]
    outs = [nm[d.name] for d in il.prog.decls if d.block == "output"]
    return f"""Rewrite this controller.

ORIGINAL SOURCE (line numbers on the left):
{_numbered(il.legacy['source'])}

NAME MAP (legacy tag -> attribute or keyword name, block, type, initial value). Inputs are step() keyword
arguments; every other variable is an attribute on self, set in reset():
{chr(10).join(rows)}

CONTRACT
- class ChwSequencer with SCAN_SECONDS = 1.0, INPUTS = {tuple(ins)!r}, OUTPUTS = {tuple(outs)!r}, __init__ (calls reset), reset(), and
  step(self, *, {', '.join(ins)}) -> tuple[dict, list[str]].
- One step() call is one scan: run the original statements in the original order; later statements see values
  assigned by earlier ones in the same scan.
- Return (outputs, fired). outputs is a dict keyed by exactly {list(outs)!r} with the current values.
- fired lists rule ids in the order they happen within the scan. Rules:
{chr(10).join(rules)}
- Allowed: plain Python, no imports except `from __future__ import annotations`, no loops, no I/O.
- Add a short plain-English comment above each rule block.
"""


def repair_prompt(prev_src: str, failure: str) -> str:
    return f"""Your rewrite did not pass verification. Fix it and reply with the full corrected class in ONE ```python block.

YOUR PREVIOUS CODE:
```python
{prev_src}
```

WHAT WENT WRONG:
{failure}
"""


def describe_mismatch(res: dict) -> str:
    m = res["first_mismatches"][0]
    lines = [f"The original controller and your code disagree in scenario {m['sequence']} at scan {m['scan']} "
             f"({res['mismatch_sequences']} of {res['sequences']} scenarios differ).",
             "Inputs for the last scans up to and including the failing one (oldest first):"]
    for inp in m.get("recent", [m["inputs"]]):
        lines.append("  " + json.dumps({k: (round(v, 4) if isinstance(v, float) else v) for k, v in inp.items()}))
    lines.append("Differences at the failing scan:")
    for d in m["diffs"]:
        lines.append(f"  {d['field']}: original={d['legacy']!r}  yours={d['modern']!r}")
    lines.append("The original is the reference. Re-read its source for the rule that governs the differing field.")
    return "\n".join(lines)


# ------------------------------------------------------------------ job 1: rewrite proposal with verification
def propose_rewrite(il, llm: LLM, max_attempts: int = 4, sequences: int = 400, holdout_sequences: int = 1500,
                    on_progress=None) -> dict:
    """Ask the model for a rewrite, verify it, give failures back, and stop after max_attempts."""
    g = il.legacy["glossary"]
    nm = {d.name: g.get(d.name, {}).get("name", d.name.lower()) for d in il.prog.decls}
    inputs = [nm[d.name] for d in il.prog.decls if d.block == "input"]
    outputs = [nm[d.name] for d in il.prog.decls if d.block == "output"]
    rule_ids = [r["id"] for r in il.rules]
    messages = [{"role": "user", "content": rewrite_prompt(il)}]
    attempts, src_ok = [], None
    say = on_progress or (lambda *_: None)

    for n in range(1, max_attempts + 1):
        say(f"attempt {n}: asking {llm.name}")
        reply = llm.complete(SYSTEM_REWRITE, messages)
        src = extract_python(reply)
        rec = {"n": n, "stage": None, "detail": None}
        attempts.append(rec)
        messages.append({"role": "assistant", "content": reply})
        if not src:
            rec.update(stage="no code", detail="The reply contained no code.")
            messages.append({"role": "user", "content": "Reply with the full class in one ```python block."})
            continue
        problems = screen_source(src, inputs, outputs)
        if problems:
            rec.update(stage="rejected before running", detail="; ".join(problems[:5]))
            messages.append({"role": "user", "content": repair_prompt(src, "The code was rejected before it ran: " + "; ".join(problems[:5]))})
            continue
        try:
            cls = load_candidate(src)
        except Exception as e:
            rec.update(stage="failed to load", detail=f"{type(e).__name__}: {e}")
            messages.append({"role": "user", "content": repair_prompt(src, f"Loading failed: {type(e).__name__}: {e}")})
            continue
        bad = _smoke(cls, inputs, outputs, il.prog.decls)
        if bad:
            rec.update(stage="failed smoke test", detail=bad)
            messages.append({"role": "user", "content": repair_prompt(src, bad)})
            continue
        res = run_parity(il.prog, il.ex["hooks"], g, src, rule_ids, sequences=sequences, loader=load_candidate)
        rec["parity"] = {k: res[k] for k in ("passed", "scans", "sequences", "mismatch_sequences", "rules_covered", "rules_total")}
        if not res["passed"]:
            rec.update(stage="parity mismatch", detail=describe_mismatch(res))
            messages.append({"role": "user", "content": repair_prompt(src, rec["detail"])})
            say(f"attempt {n}: parity mismatch, sending the first difference back")
            continue
        if res["rules_covered"] < res["rules_total"]:
            rec.update(stage="coverage too low", detail="Not every rule was exercised, so the pass is not trusted.")
            break
        hold = run_parity(il.prog, il.ex["hooks"], g, src, rule_ids, sequences=holdout_sequences, seed=1234, loader=load_candidate)
        rec["holdout"] = {k: hold[k] for k in ("passed", "scans", "sequences", "mismatch_sequences")}
        if not hold["passed"]:
            rec.update(stage="held-out mismatch", detail=describe_mismatch(hold))
            messages.append({"role": "user", "content": repair_prompt(src, rec["detail"])})
            say(f"attempt {n}: passed the first run but failed the held-out run")
            continue
        rec.update(stage="accepted", detail=f"{res['scans']:,} scans plus {hold['scans']:,} held-out scans, 0 differences")
        src_ok = src
        break

    return {
        "accepted": src_ok is not None,
        "model": llm.name,
        "live_model": not isinstance(llm, ScriptedLLM),
        "attempts": attempts,
        "llm_calls": len([a for a in attempts]),
        "source": src_ok,
        "note": ("Accepted only because it matched the original on every checked scan. "
                 "Passing is strong evidence, not a proof.") if src_ok else
                "No attempt passed verification. The deterministic rewrite stays in use.",
    }


# ------------------------------------------------------------------ job 2: glossary draft (human approval required)
SYSTEM_GLOSSARY = (
    "You name variables in legacy controller code for data center operators. Use only what the source, point list "
    "and runbook say. If something is unclear, say so in the description instead of guessing. Reply with ONE ```json block."
)
NAME_RE = re.compile(r"^[a-z][a-z0-9_]{2,40}$")


def glossary_prompt(il) -> str:
    tags = [f"  {d.name} ({d.block}, {d.type})" for d in il.prog.decls]
    return f"""Propose a glossary for these tags.

SOURCE:
{_numbered(il.legacy['source'])}

POINT LIST (csv):
{il.legacy['points']}

RUNBOOK:
{il.legacy['runbook']}

TAGS:
{chr(10).join(tags)}

Return a JSON object mapping each tag to {{"name": snake_case_name_with_unit_suffix, "desc": short plain-English phrase, "unit": optional}}.
Names must be unique. If the point list marks a tag retired or unused, say that in desc."""


def validate_glossary(obj, tags: list[str]) -> list[str]:
    errs = []
    if not isinstance(obj, dict):
        return ["not a JSON object"]
    for t in tags:
        e = obj.get(t)
        if not isinstance(e, dict) or not isinstance(e.get("name"), str) or not isinstance(e.get("desc"), str) or not e["desc"].strip():
            errs.append(f"{t}: needs name and desc")
        elif not NAME_RE.match(e["name"]):
            errs.append(f"{t}: name {e['name']!r} must be snake_case")
    names = [e.get("name") for e in obj.values() if isinstance(e, dict)]
    if len(set(names)) != len(names):
        errs.append("names are not unique")
    extra = set(obj) - set(tags)
    if extra:
        errs.append(f"unknown tags: {sorted(extra)}")
    return errs


def draft_glossary(il, llm: LLM, retries: int = 2) -> dict:
    tags = [d.name for d in il.prog.decls]
    messages = [{"role": "user", "content": glossary_prompt(il)}]
    for _ in range(retries + 1):
        reply = llm.complete(SYSTEM_GLOSSARY, messages, max_tokens=2500)
        messages.append({"role": "assistant", "content": reply})
        m = re.search(r"```(?:json)?\s*\n(.*?)```", reply, re.S)
        try:
            obj = json.loads(m.group(1) if m else reply)
        except json.JSONDecodeError as e:
            messages.append({"role": "user", "content": f"That was not valid JSON ({e}). Reply with one ```json block."})
            continue
        errs = validate_glossary(obj, tags)
        if errs:
            messages.append({"role": "user", "content": "Fix these problems and resend the whole object: " + "; ".join(errs)})
            continue
        approved = il.legacy["glossary"]
        diff = {t: {"proposed": obj[t]["name"], "approved": approved[t]["name"]}
                for t in tags if t in approved and approved[t].get("name") != obj[t]["name"]}
        return {"status": "proposed, needs human review", "model": llm.name, "entries": obj, "differs_from_approved": diff}
    return {"status": "failed", "model": llm.name, "entries": None, "differs_from_approved": {}}
