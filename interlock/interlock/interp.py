"""Reference interpreter for the legacy program.

This is the ground truth the modern rewrite is checked against. It executes
the parsed legacy code scan by scan, exactly as written.
"""
from __future__ import annotations

from .st_parser import Assign, If, Program


def _eval(e, env):
    k = e[0]
    if k == "num" or k == "bool":
        return e[1]
    if k == "var":
        return env[e[1]]
    if k == "un":
        v = _eval(e[2], env)
        return (not v) if e[1] == "NOT" else -v
    op, l, r = e[1], _eval(e[2], env), _eval(e[3], env)
    if op == "AND":
        return bool(l) and bool(r)
    if op == "OR":
        return bool(l) or bool(r)
    if op == "+":
        return l + r
    if op == "-":
        return l - r
    if op == "*":
        return l * r
    if op == "/":
        return l / r
    if op == "=":
        return l == r
    if op == "<>":
        return l != r
    if op == "<":
        return l < r
    if op == ">":
        return l > r
    if op == "<=":
        return l <= r
    if op == ">=":
        return l >= r
    raise ValueError(op)


class LegacyController:
    """Runs the legacy program. `hooks` maps a source line to a rule id so the
    interpreter can report which rules fired on each scan."""

    def __init__(self, prog: Program, hooks: dict[int, str] | None = None):
        self.prog = prog
        self.hooks = hooks or {}
        self.env: dict = {}
        self.reset()

    def reset(self):
        self.env = {}
        for d in self.prog.decls:
            if d.init is not None:
                self.env[d.name] = d.init
            elif d.type == "BOOL":
                self.env[d.name] = False
            elif d.type == "INT":
                self.env[d.name] = 0
            else:
                self.env[d.name] = 0.0

    def step(self, inputs: dict) -> tuple[dict, list[str]]:
        for d in self.prog.decls:
            if d.block == "input":
                self.env[d.name] = inputs[d.name]
        fired: list[str] = []
        self._run(self.prog.body, fired)
        outs = {d.name: self.env[d.name] for d in self.prog.decls if d.block == "output"}
        return outs, fired

    def _run(self, stmts, fired):
        for s in stmts:
            if isinstance(s, Assign):
                v = _eval(s.expr, self.env)
                self.env[s.name] = v
                rid = self.hooks.get(s.line)
                if rid and v is True:
                    fired.append(rid)
            elif isinstance(s, If):
                for b in s.branches:
                    if b.cond is None or _eval(b.cond, self.env):
                        rid = self.hooks.get(b.line)
                        if rid:
                            fired.append(rid)
                        self._run(b.body, fired)
                        break
