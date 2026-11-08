"""Parser for the small Structured Text subset used by the legacy sequencer.

Supported: VAR / VAR_INPUT / VAR_OUTPUT blocks with trailing comments,
assignments, IF / ELSIF / ELSE / END_IF, AND / OR / NOT, comparisons and
+ - * / arithmetic. Every statement keeps its source line number so that
rules extracted later can point back at the original code.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

KEYWORDS = {
    "IF", "THEN", "ELSIF", "ELSE", "END_IF", "VAR", "VAR_INPUT", "VAR_OUTPUT",
    "END_VAR", "AND", "OR", "NOT", "TRUE", "FALSE",
}

TOKEN_RE = re.compile(
    r"""
    (?P<comment>\(\*.*?\*\))
  | (?P<num>\d+\.\d+|\d+)
  | (?P<ident>[A-Za-z_][A-Za-z0-9_]*)
  | (?P<op>:=|<>|<=|>=|[=<>+\-*/();:,])
  | (?P<ws>\s+)
    """,
    re.VERBOSE | re.DOTALL,
)


@dataclass
class Token:
    kind: str  # comment, num, kw, ident, op
    text: str
    line: int


@dataclass
class VarDecl:
    name: str
    type: str
    init: object
    comment: str
    block: str  # input, internal, output
    line: int


@dataclass
class Assign:
    name: str
    expr: tuple
    line: int


@dataclass
class Branch:
    cond: tuple | None  # None means ELSE
    body: list
    line: int


@dataclass
class If:
    branches: list
    line: int
    end_line: int = 0


@dataclass
class Program:
    decls: list
    body: list
    source: str
    decl_by_name: dict = field(default_factory=dict)


class ParseError(Exception):
    pass


def tokenize(src: str) -> list[Token]:
    tokens: list[Token] = []
    pos, line = 0, 1
    while pos < len(src):
        m = TOKEN_RE.match(src, pos)
        if not m:
            raise ParseError(f"line {line}: unexpected character {src[pos]!r}")
        text = m.group()
        kind = m.lastgroup
        if kind == "ident":
            if text in KEYWORDS:
                kind = "kw"
        if kind != "ws":
            tokens.append(Token(kind, text, line))
        line += text.count("\n")
        pos = m.end()
    return tokens


class Parser:
    def __init__(self, src: str):
        self.src = src
        # keep comments only for declarations; strip others lazily
        self.toks = tokenize(src)
        self.i = 0

    # --- helpers
    def _skip_comments(self):
        while self.i < len(self.toks) and self.toks[self.i].kind == "comment":
            self.i += 1

    def peek(self) -> Token | None:
        self._skip_comments()
        return self.toks[self.i] if self.i < len(self.toks) else None

    def next(self) -> Token:
        t = self.peek()
        if t is None:
            raise ParseError("unexpected end of file")
        self.i += 1
        return t

    def expect(self, text: str) -> Token:
        t = self.next()
        if t.text != text:
            raise ParseError(f"line {t.line}: expected {text!r}, found {t.text!r}")
        return t

    def accept(self, text: str) -> bool:
        t = self.peek()
        if t is not None and t.text == text:
            self.i += 1
            return True
        return False

    # --- declarations
    def parse_decls(self) -> list[VarDecl]:
        decls = []
        while True:
            t = self.peek()
            if t is None or t.text not in ("VAR", "VAR_INPUT", "VAR_OUTPUT"):
                break
            block = {"VAR": "internal", "VAR_INPUT": "input", "VAR_OUTPUT": "output"}[self.next().text]
            while True:
                t = self.peek()
                if t.text == "END_VAR":
                    self.next()
                    break
                name = self.next()
                self.expect(":")
                typ = self.next().text
                init = None
                if self.accept(":="):
                    init = self.parse_literal()
                semi = self.expect(";")
                # trailing comment on the same line
                comment = ""
                if self.i < len(self.toks) and self.toks[self.i].kind == "comment" and self.toks[self.i].line == semi.line:
                    comment = self.toks[self.i].text[2:-2].strip()
                    self.i += 1
                decls.append(VarDecl(name.text, typ, init, comment, block, name.line))
        return decls

    def parse_literal(self):
        t = self.next()
        if t.text == "TRUE":
            return True
        if t.text == "FALSE":
            return False
        neg = False
        if t.text == "-":
            neg = True
            t = self.next()
        if t.kind != "num":
            raise ParseError(f"line {t.line}: expected a literal")
        v = float(t.text) if "." in t.text else int(t.text)
        return -v if neg else v

    # --- statements
    def parse_stmts(self, stop: set[str]) -> list:
        out = []
        while True:
            t = self.peek()
            if t is None or t.text in stop:
                return out
            out.append(self.parse_stmt())

    def parse_stmt(self):
        t = self.peek()
        if t.text == "IF":
            return self.parse_if()
        if t.kind == "ident":
            name = self.next()
            self.expect(":=")
            expr = self.parse_expr()
            self.expect(";")
            return Assign(name.text, expr, name.line)
        raise ParseError(f"line {t.line}: unexpected {t.text!r}")

    def parse_if(self) -> If:
        start = self.expect("IF")
        branches = []
        cond = self.parse_expr()
        self.expect("THEN")
        body = self.parse_stmts({"ELSIF", "ELSE", "END_IF"})
        branches.append(Branch(cond, body, start.line))
        while True:
            t = self.peek()
            if t.text == "ELSIF":
                self.next()
                c = self.parse_expr()
                self.expect("THEN")
                b = self.parse_stmts({"ELSIF", "ELSE", "END_IF"})
                branches.append(Branch(c, b, t.line))
            elif t.text == "ELSE":
                self.next()
                b = self.parse_stmts({"END_IF"})
                branches.append(Branch(None, b, t.line))
            else:
                break
        end = self.expect("END_IF")
        self.expect(";")
        return If(branches, start.line, end.line)

    # --- expressions (precedence: OR < AND < NOT < compare < add < mul < unary)
    def parse_expr(self):
        return self.parse_or()

    def parse_or(self):
        left = self.parse_and()
        while self.accept("OR"):
            left = ("bin", "OR", left, self.parse_and())
        return left

    def parse_and(self):
        left = self.parse_not()
        while self.accept("AND"):
            left = ("bin", "AND", left, self.parse_not())
        return left

    def parse_not(self):
        if self.accept("NOT"):
            return ("un", "NOT", self.parse_not())
        return self.parse_cmp()

    def parse_cmp(self):
        left = self.parse_add()
        t = self.peek()
        if t is not None and t.text in ("=", "<>", "<", ">", "<=", ">="):
            self.next()
            return ("bin", t.text, left, self.parse_add())
        return left

    def parse_add(self):
        left = self.parse_mul()
        while True:
            t = self.peek()
            if t is not None and t.text in ("+", "-"):
                self.next()
                left = ("bin", t.text, left, self.parse_mul())
            else:
                return left

    def parse_mul(self):
        left = self.parse_unary()
        while True:
            t = self.peek()
            if t is not None and t.text in ("*", "/"):
                self.next()
                left = ("bin", t.text, left, self.parse_unary())
            else:
                return left

    def parse_unary(self):
        if self.accept("-"):
            return ("un", "-", self.parse_unary())
        return self.parse_atom()

    def parse_atom(self):
        t = self.next()
        if t.kind == "num":
            return ("num", float(t.text) if "." in t.text else int(t.text))
        if t.text == "TRUE":
            return ("bool", True)
        if t.text == "FALSE":
            return ("bool", False)
        if t.text == "(":
            e = self.parse_expr()
            self.expect(")")
            return e
        if t.kind == "ident":
            return ("var", t.text)
        raise ParseError(f"line {t.line}: unexpected {t.text!r} in expression")


def parse(src: str) -> Program:
    p = Parser(src)
    decls = p.parse_decls()
    body = p.parse_stmts(set())
    if p.peek() is not None:
        raise ParseError(f"line {p.peek().line}: trailing input")
    prog = Program(decls, body, src)
    prog.decl_by_name = {d.name: d for d in decls}
    return prog
