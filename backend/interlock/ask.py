"""Optional "Ask Interlock" question box.

Answers operator questions using only the extracted rules, findings and
tickets as context. It needs the `anthropic` package and an ANTHROPIC_API_KEY.
Without them it reports that it is unavailable; the rest of Interlock does not
depend on it.
"""
from __future__ import annotations

import os

from .llm_assist import MODEL

SYSTEM = (
    "You are Interlock, an assistant for data center operators. Answer using ONLY the rules, "
    "findings and incident tickets provided. Cite rule ids (like R1) and source line numbers. "
    "If the context does not contain the answer, say so. Be short and concrete. Never invent "
    "numbers, equipment or procedures."
)


def build_context(state: dict) -> str:
    lines = ["RULES (extracted from the legacy controller):"]
    for r in state["rules"]:
        lines.append(f"- {r['id']} (source lines {r['lines'][0]}-{r['lines'][1]}): {r['english']}")
        for m in r.get("mitigations", []):
            lines.append(f"    known mitigation: {m['title']}. {m['how']}")
    lines.append("")
    lines.append("DOCUMENTATION AND CONFIG FINDINGS:")
    for f in state["findings"]:
        lines.append(f"- [{f['kind']}] {f['text']}")
    lines.append("")
    lines.append("INCIDENT TICKETS:")
    for t in state["tickets"]:
        lines.append(f"- {t['id']} ({t['date']}): {t['text']}")
    return "\n".join(lines)


def available() -> bool:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return False
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False
    return True


def ask(state: dict, question: str) -> dict:
    if not available():
        return {"available": False,
                "answer": "The question box needs the anthropic package and an ANTHROPIC_API_KEY. "
                          "Everything else in Interlock works without it."}
    import anthropic

    client = anthropic.Anthropic()
    msg = client.messages.create(
        model=MODEL,
        max_tokens=500,
        system=SYSTEM + "\n\n" + build_context(state),
        messages=[{"role": "user", "content": question}],
    )
    return {"available": True, "answer": "".join(b.text for b in msg.content if b.type == "text")}
