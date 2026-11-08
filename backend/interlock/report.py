"""Root cause analysis (RCA) report for the shift handoff, as PDF or Word.

The analysis is built from facts Interlock already has: the simulated run, the rules extracted
from the legacy code (with source lines), the findings, the incident tickets and the verified
mitigations. Nothing here is written by a language model. The document is marked as a draft for
engineering review, because the plant numbers are illustrative.

    model = build_rca(il, sim, operator_log)
    pdf_bytes = render_pdf(model)
    docx_bytes = render_docx(model)
"""
from __future__ import annotations

import io
from datetime import datetime, timezone

from .plant import job_target_kw

BRAND_INK = "#151211"
BRAND_ACCENT = "#2B9CFC"
BRAND_CRIT = "#D9433F"
BRAND_MUTED = "#6B6563"


def _rel(t: int, js: int) -> str:
    return f"T-{js - t}s" if t < js else f"T+{t - js}s"


def _mw(kw: float) -> str:
    return f"{kw / 1000:,.1f} MW"


# ------------------------------------------------------------------ analysis model
def _categorise(ticket: dict, rules: list[dict]) -> str:
    for r in rules:
        if any(t["id"] == ticket["id"] for t in r["tickets"]):
            if r["id"] == "R1":
                return "Rate-of-rise trip at job start (R1)"
            if any(f["kind"] == "dead_input" for f in r["findings"]):
                return f"Dead alarm on retired tag ({r['id']})"
            return f"Rule {r['id']}"
    text = ticket["text"].lower()
    if "ai_77" in text or "alarm" in text:
        return "Dead alarm on retired tag (R7)"
    return "Equipment maintenance (not control logic)"


def _gpu_hours_lost(il, sim: dict) -> float:
    """GPU-hours lost to throttling and shutdown inside the simulated window."""
    p = il.params
    gpus = p.racks * p.gpus_per_rack
    lost = 0.0
    for t in range(p.job_start_s, sim["duration"]):
        target = job_target_kw(p, sim["profile"], t)
        if target <= p.idle_kw:
            continue
        frac_lost = max(0.0, target - sim["series"]["it_kw"][t]) / p.full_kw
        lost += frac_lost * gpus / 3600.0
    return lost


def _five_whys(il, sim: dict) -> tuple[list[dict], str]:
    p, pred = il.params, sim["prediction"]
    js = p.job_start_s
    base = il.predict(sim["profile"]) if not pred["will_trip"] else pred
    rid = (base["primary"] or {}).get("rule", "R1")
    r1 = il.rule_by_id[rid]
    lines = f"lines {r1['lines'][0]}-{r1['lines'][1]}"
    lockout = il.facts["lockout_s"] or 0
    deficit = base["peak_it_kw"] - p.chiller_cap_kw
    why3 = (f"The supply temperature rose faster than the trip threshold for 20 consecutive scans. "
            f"Heat from the job ({_mw(base['peak_it_kw'])}) exceeded what one chiller removes "
            f"({_mw(p.chiller_cap_kw)}) by {_mw(deficit)}.")
    why4 = (f"Chiller 2 is only staged after chiller 1 has been at 80 % load or more for 90 s (rule R4), and then "
            f"needs about {p.ch2_delay_s} s to start and {p.ch2_ramp_s} s to reach full capacity. "
            f"The job reached full power in about {p.ramp_s} s.")
    why5 = ("The 2004 sequencer was written for slow, predictable load changes. It reads a fast temperature rise as a "
            "pump fault, and it has no link to the job scheduler, so it cannot prepare for a known load step.")
    if pred["will_trip"]:
        first = ("GPUs shut down on over-temperature" if pred["shutdown_t"] else "GPUs throttled") + \
            f" at {_rel(pred['shutdown_t'] or pred['throttle_t'] or pred['primary']['t'], js)}."
        whys = [
            {"q": "Why was the training job lost?", "a": first + f" Facility-water supply reached {pred['peak_temp_c']:.1f} °C."},
            {"q": "Why did the supply temperature keep climbing?",
             "a": f"Rule {rid} ({lines}) stopped the cooling pumps at {_rel(pred['primary']['t'], js)}, and the restart "
                  f"lockout (rules R2 and R3) kept cooling off for {lockout} s."},
            {"q": f"Why did rule {rid} trip?", "a": why3},
            {"q": "Why was only one chiller carrying the load?", "a": why4},
            {"q": "Why does the control logic behave this way?", "a": why5},
        ]
    else:
        whys = [
            {"q": "Why was there a risk of losing the job?",
             "a": f"Without the plan, rule {rid} ({lines}) is forecast to stop the cooling pumps about "
                  f"{base['trip_after_start_s']} s after the job starts."},
            {"q": f"Why would rule {rid} trip?", "a": why3},
            {"q": "Why would only one chiller be carrying the load?", "a": why4},
            {"q": "Why does the control logic behave this way?", "a": why5},
            {"q": "Why did nothing go wrong this time?",
             "a": "The verified plan put a second chiller on line before the ramp, or limited the ramp, so the rule never fired."},
        ]
    root = ("Control logic designed for steady loads, with no coordination between the job scheduler and the "
            f"chilled-water plant. Rule {rid} treats the expected temperature rise at a job start as a pump fault.")
    return whys, root


def build_rca(il, sim: dict, operator_log: list[dict] | None = None, site: str = "Cluster B · Hall 2") -> dict:
    p, pred = il.params, sim["prediction"]
    js = p.job_start_s
    tripped = pred["will_trip"]
    now = datetime.now(timezone.utc)
    whys, root = _five_whys(il, sim)

    # timeline: what the operator saw on the dashboard, else the simulated events
    if operator_log:
        timeline = [{"t": int(e["t"]), "text": e["text"], "kind": e.get("kind", "info")} for e in sorted(operator_log, key=lambda e: e["t"])]
    else:
        timeline = [{"t": e["t"], "text": e["title"], "kind": e["level"]} for e in sim["events"]]

    major = [e for e in sim["events"] if e["type"] in ("rule_fired", "impact")]

    # Pareto of incidents by cause: earlier tickets plus this run
    counts: dict[str, int] = {}
    for t in il.legacy["tickets"]:
        c = _categorise(t, il.rules)
        counts[c] = counts.get(c, 0) + 1
    if tripped:
        c = "Rate-of-rise trip at job start (R1)" if pred["primary"]["rule"] == "R1" else f"Rule {pred['primary']['rule']}"
        counts[c] = counts.get(c, 0) + 1
    total = sum(counts.values())
    pareto, cum = [], 0
    for cat, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        cum += n
        pareto.append({"cause": cat, "count": n, "pct": 100 * n / total, "cum_pct": 100 * cum / total})

    lost = _gpu_hours_lost(il, sim)
    unmitigated_lost = _gpu_hours_lost(il, il.simulate(sim["profile"])) if not tripped else lost

    rid = (pred["primary"] or il.predict(sim["profile"])["primary"] or {"rule": "R1"})["rule"]
    rule = il.rule_by_id[rid]
    src = il.legacy["source"].split("\n")
    excerpt = [(n, src[n - 1]) for n in range(rule["lines"][0], rule["lines"][1] + 1)]

    steps = il.verified_mitigations(rid) if rule["mitigations"] else []
    capa = [{"type": "Containment", "action": s["title"] + ". " + s["how"], "owner": "Plant operations" if s["kind"] == "operator" else "Scheduler / platform team",
             "status": "Verified in simulation" if s["avoids_trip"] else "Does not avoid the trip"} for s in steps]
    capa += [
        {"type": "Corrective", "action": f"Change rule {rid} so a temperature rise during a scheduled job start is not treated as a pump fault "
                                         "(for example, require a pump fault signal, or pre-stage chillers when a job is queued). "
                                         "Prove the change with the parity test and the plant simulator before deployment.",
         "owner": "Controls engineering", "status": "Open"},
        {"type": "Preventive", "action": "Connect the job scheduler to the plant: large jobs request cooling capacity before they start.",
         "owner": "Platform + facilities", "status": "Open"},
    ]
    for f in il.ex["findings"]:
        if f["kind"] == "runbook_mismatch":
            capa.append({"type": "Documentation", "action": f"Correct the runbook. {f['text']}", "owner": "Plant operations", "status": "Open"})
        elif f["kind"] == "dead_input":
            capa.append({"type": "Preventive", "action": f"Remove or re-point the dead alarm. {f['text']}", "owner": "Controls engineering", "status": "Open"})

    plan = ("two-stage job start" if sim["profile"] == "staged" else "full-power job start") + \
        (f", chiller 2 override at {_rel(sim['manual_ch2_at'], js)}" if sim["manual_ch2_at"] is not None else "")
    return {
        "doc_id": f"RCA-{now:%Y%m%d-%H%M}",
        "generated": now.strftime("%d %b %Y, %H:%M UTC"),
        "site": site,
        "title": "Cooling-loop trip at training job start" if tripped else "Near miss: cooling-loop trip avoided at job start",
        "severity": ("Major: job lost" if pred["shutdown_t"] else "Major: GPUs throttled") if tripped else "Near miss (no impact)",
        "tripped": tripped,
        "summary": [
            ("Outcome", f"{'Cooling loop tripped' if tripped else 'No protective rule fired'}; peak facility-water supply "
                        f"{pred['peak_temp_c']:.1f} °C; peak facility power {_mw(pred['peak_facility_kw'])}."),
            ("Impact", f"About {lost:,.0f} GPU-hours lost in the simulated window ({p.racks * p.gpus_per_rack:,} GPUs)." if tripped
             else f"None. Without the plan, about {unmitigated_lost:,.0f} GPU-hours would have been lost in the same window."),
            ("Plan", plan.capitalize() + "."),
            ("Primary rule", f"{rid}, legacy/chw_sequencer.st lines {rule['lines'][0]}-{rule['lines'][1]}."),
            ("Root cause", root),
        ],
        "major_events": [{"t": _rel(e["t"], js), "text": e["title"]} for e in major],
        "timeline": [{"t": _rel(e["t"], js), "text": e["text"], "kind": e["kind"]} for e in timeline],
        "pareto": pareto,
        "pareto_note": f"{total} incidents: {len(il.legacy['tickets'])} earlier tickets" + (" plus this run." if tripped else "."),
        "whys": whys,
        "root": root,
        "rule": {"id": rid, "english": rule["english"], "lines": rule["lines"], "excerpt": excerpt},
        "findings": [f["text"] for f in il.ex["findings"] if f["kind"] != "runbook_ok"],
        "tickets": rule["tickets"],
        "capa": capa,
        "assumptions": [
            f"Plant numbers are industry-typical placeholders, not measured values: {p.racks} liquid-cooled racks, "
            f"{_mw(p.idle_kw)} idle to {_mw(p.full_kw)} full IT load, two {_mw(p.chiller_cap_kw)} duty chillers plus a standby, "
            f"facility-water setpoint {p.setpoint_c:.0f} °C.",
            "GPU-hours are counted only inside the simulated window, so a real outage that includes a job restart costs more.",
            "The legacy controller and incident tickets are synthetic demo data.",
            "Interlock recommends; it never actuates. Every action above needs approval by the responsible engineer.",
        ],
    }


# ------------------------------------------------------------------ Pareto chart
def pareto_png(model: dict, dpi: int = 200) -> bytes:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    rows = model["pareto"]
    labels = [r["cause"].replace(" (", "\n(") for r in rows]
    fig, ax = plt.subplots(figsize=(7.2, 3.2), dpi=dpi)
    colors = [BRAND_CRIT if i == 0 else "#9AA5B1" for i in range(len(rows))]
    ax.bar(range(len(rows)), [r["count"] for r in rows], color=colors, width=0.6)
    ax.set_ylabel("Incidents", color=BRAND_INK, fontsize=9)
    ax.set_xticks(range(len(rows)), labels, fontsize=7.5, color=BRAND_INK)
    ax.tick_params(axis="y", labelsize=8, colors=BRAND_MUTED)
    ax.spines[["top", "right"]].set_visible(False)
    ax.spines[["left", "bottom"]].set_color("#C9C4C2")
    ax.yaxis.get_major_locator().set_params(integer=True)
    ax2 = ax.twinx()
    ax2.plot(range(len(rows)), [r["cum_pct"] for r in rows], color=BRAND_ACCENT, marker="o", linewidth=2)
    ax2.axhline(80, color=BRAND_ACCENT, linestyle=":", linewidth=1, alpha=0.6)
    ax2.set_ylim(0, 105)
    ax2.set_ylabel("Cumulative %", color=BRAND_ACCENT, fontsize=9)
    ax2.tick_params(axis="y", labelsize=8, colors=BRAND_ACCENT)
    ax2.spines[["top", "left"]].set_visible(False)
    ax2.spines["right"].set_color("#C9C4C2")
    for i, r in enumerate(rows):
        ax2.annotate(f"{r['cum_pct']:.0f}%", (i, r["cum_pct"]), textcoords="offset points", xytext=(0, 7), ha="center", fontsize=7.5, color=BRAND_ACCENT)
    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor="white")
    plt.close(fig)
    return buf.getvalue()


# ------------------------------------------------------------------ PDF
def render_pdf(model: dict) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import (Image, KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle)

    ink, accent, crit, muted = (colors.HexColor(c) for c in (BRAND_INK, BRAND_ACCENT, BRAND_CRIT, BRAND_MUTED))
    line = colors.HexColor("#DAD6D4")
    zebra = colors.HexColor("#F6F5F4")
    S = {
        "title": ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=20, leading=24, textColor=ink, spaceAfter=4),
        "sub": ParagraphStyle("sub", fontName="Helvetica", fontSize=10, leading=14, textColor=muted),
        "h1": ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=13, leading=17, textColor=ink, spaceBefore=14, spaceAfter=6),
        "body": ParagraphStyle("body", fontName="Helvetica", fontSize=9.5, leading=13.5, textColor=ink, alignment=TA_LEFT),
        "small": ParagraphStyle("small", fontName="Helvetica", fontSize=8.5, leading=12, textColor=muted),
        "cell": ParagraphStyle("cell", fontName="Helvetica", fontSize=8.8, leading=12, textColor=ink),
        "cellb": ParagraphStyle("cellb", fontName="Helvetica-Bold", fontSize=8.8, leading=12, textColor=ink),
        "head": ParagraphStyle("head", fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=colors.white),
        "code": ParagraphStyle("code", fontName="Courier", fontSize=8.5, leading=11.5, textColor=ink),
        "q": ParagraphStyle("q", fontName="Helvetica-Bold", fontSize=9.5, leading=13, textColor=ink),
    }
    P = lambda text, st="body": Paragraph(text, S[st])  # noqa: E731
    W = A4[0] - 36 * mm

    def table(rows, widths, header=True):
        t = Table(rows, colWidths=widths, repeatRows=1 if header else 0)
        style = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), 0.4, line),
                 ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                 ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6)]
        if header:
            style += [("BACKGROUND", (0, 0), (-1, 0), ink)]
            style += [("BACKGROUND", (0, i), (-1, i), zebra) for i in range(2, len(rows), 2)]
        t.setStyle(TableStyle(style))
        return t

    def page(canvas, doc):
        canvas.saveState()
        canvas.setFillColor(ink)
        canvas.rect(0, A4[1] - 14 * mm, A4[0], 14 * mm, stroke=0, fill=1)
        canvas.setFillColor(colors.white)
        canvas.setFont("Helvetica-Bold", 11)
        canvas.drawString(18 * mm, A4[1] - 9 * mm, "INTERLOCK")
        canvas.setFont("Helvetica", 8.5)
        canvas.drawRightString(A4[0] - 18 * mm, A4[1] - 9 * mm, f"Root cause analysis · {model['doc_id']}")
        canvas.setStrokeColor(accent)
        canvas.setLineWidth(1.2)
        canvas.line(0, A4[1] - 14 * mm, A4[0], A4[1] - 14 * mm)
        canvas.setFillColor(muted)
        canvas.setFont("Helvetica", 7.5)
        canvas.drawString(18 * mm, 10 * mm, f"{model['site']} · Generated {model['generated']} · Draft for engineering review")
        canvas.drawRightString(A4[0] - 18 * mm, 10 * mm, f"Page {doc.page}")
        canvas.restoreState()

    sev_color = crit if model["tripped"] else colors.HexColor("#1C8F5B")
    story = [Spacer(1, 4 * mm), P(model["title"], "title"),
             P(f"{model['site']} &nbsp;·&nbsp; {model['generated']} &nbsp;·&nbsp; <font color='{sev_color.hexval().replace('0x', '#')}'><b>{model['severity']}</b></font>", "sub"),
             Spacer(1, 6 * mm)]

    story.append(P("1. Executive summary", "h1"))
    story.append(table([[P(k, "cellb"), P(v, "cell")] for k, v in model["summary"]], [32 * mm, W - 32 * mm], header=False))

    if model["major_events"]:
        story.append(P("2. Major events", "h1"))
        story.append(table([[P("Time", "head"), P("Event", "head")]] + [[P(e["t"], "cell"), P(e["text"], "cell")] for e in model["major_events"]], [24 * mm, W - 24 * mm]))

    story.append(P("3. Timeline", "h1"))
    story.append(table([[P("Time", "head"), P("What happened", "head")]] + [[P(e["t"], "cell"), P(e["text"], "cell")] for e in model["timeline"]], [24 * mm, W - 24 * mm]))

    story.append(KeepTogether([P("4. Pareto analysis of incidents by cause", "h1"),
                               Image(io.BytesIO(pareto_png(model)), width=W, height=W * 3.2 / 7.2)]))
    story.append(table([[P("Cause", "head"), P("Incidents", "head"), P("Share", "head"), P("Cumulative", "head")]] +
                       [[P(r["cause"], "cell"), P(str(r["count"]), "cell"), P(f"{r['pct']:.0f}%", "cell"), P(f"{r['cum_pct']:.0f}%", "cell")] for r in model["pareto"]],
                       [W - 66 * mm, 22 * mm, 20 * mm, 24 * mm]))
    story.append(Spacer(1, 2 * mm))
    story.append(P(model["pareto_note"] + " The top cause alone accounts for the largest share, so fixing it removes most incidents.", "small"))

    story.append(P("5. Five whys", "h1"))
    rows = [[P(f"<font color='#2B9CFC'>{i + 1}</font>", "q"), [P(w["q"], "q"), Spacer(1, 2), P(w["a"], "body")]] for i, w in enumerate(model["whys"])]
    rows.append([P("<font color='#D9433F'>&#9632;</font>", "q"), [P("Root cause", "q"), Spacer(1, 2), P(model["root"], "body")]])
    story.append(table(rows, [10 * mm, W - 10 * mm], header=False))

    r = model["rule"]
    code = "<br/>".join(f"<font color='#8E8784'>{n:>3}</font>&nbsp;&nbsp;{txt.replace(' ', '&nbsp;').replace('<', '&lt;')}" for n, txt in r["excerpt"])
    story.append(KeepTogether([P("6. Evidence from the legacy code", "h1"),
                               P(f"<b>Rule {r['id']}</b> (legacy/chw_sequencer.st, lines {r['lines'][0]}-{r['lines'][1]}): {r['english']}", "body"),
                               Spacer(1, 3 * mm),
                               table([[P(code, "code")]], [W], header=False)]))
    if model["tickets"]:
        story.append(Spacer(1, 3 * mm))
        story.append(P("Earlier tickets with the same pattern (all closed as cause unknown):", "body"))
        story.append(table([[P("Ticket", "head"), P("Date", "head"), P("Description", "head")]] +
                           [[P(t["id"], "cell"), P(t["date"], "cell"), P(t["text"], "cell")] for t in model["tickets"]], [22 * mm, 22 * mm, W - 44 * mm]))
    if model["findings"]:
        story.append(Spacer(1, 3 * mm))
        story.append(P("Contributing findings:", "body"))
        story.extend(P(f"• {f}", "body") for f in model["findings"])

    story.append(P("7. Corrective and preventive actions", "h1"))
    story.append(table([[P("Type", "head"), P("Action", "head"), P("Owner", "head"), P("Status", "head")]] +
                       [[P(c["type"], "cellb"), P(c["action"], "cell"), P(c["owner"], "cell"), P(c["status"], "cell")] for c in model["capa"]],
                       [30 * mm, W - 90 * mm, 32 * mm, 28 * mm]))

    story.append(P("8. Assumptions and limits", "h1"))
    story.extend(P(f"• {a}", "small") for a in model["assumptions"])

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=22 * mm, bottomMargin=18 * mm,
                            title=f"{model['doc_id']} {model['title']}", author="Interlock", subject="Root cause analysis")
    doc.build(story, onFirstPage=page, onLaterPages=page)
    return buf.getvalue()


# ------------------------------------------------------------------ Word
def render_docx(model: dict) -> bytes:
    from docx import Document
    from docx.enum.table import WD_TABLE_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Cm, Pt, RGBColor

    ink, accent, crit, muted = (RGBColor.from_string(c[1:]) for c in (BRAND_INK, BRAND_ACCENT, BRAND_CRIT, BRAND_MUTED))
    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
    for side in ("left_margin", "right_margin"):
        setattr(sec, side, Cm(1.9))
    sec.top_margin, sec.bottom_margin = Cm(2.0), Cm(1.8)

    st = doc.styles["Normal"]
    st.font.name, st.font.size, st.font.color.rgb = "Calibri", Pt(10), ink
    st.element.rPr.rFonts.set(qn("w:eastAsia"), "Calibri")
    for name, size in (("Heading 1", 13), ("Title", 22)):
        s = doc.styles[name]
        s.font.name, s.font.size, s.font.color.rgb, s.font.bold = "Calibri", Pt(size), ink, True

    def shade(cell, hex_fill):
        tc = cell._tc.get_or_add_tcPr()
        shd = OxmlElement("w:shd")
        shd.set(qn("w:val"), "clear"), shd.set(qn("w:color"), "auto"), shd.set(qn("w:fill"), hex_fill)
        tc.append(shd)

    def tbl(header, rows, widths_cm):
        t = doc.add_table(rows=0, cols=len(widths_cm))
        t.alignment = WD_TABLE_ALIGNMENT.CENTER
        t.style = "Table Grid"
        if header:
            cells = t.add_row().cells
            for c, h in zip(cells, header):
                c.text = ""
                run = c.paragraphs[0].add_run(h.upper())
                run.bold, run.font.size, run.font.color.rgb = True, Pt(8), RGBColor(0xFF, 0xFF, 0xFF)
                shade(c, BRAND_INK[1:])
        for i, row in enumerate(rows):
            cells = t.add_row().cells
            for j, (c, v) in enumerate(zip(cells, row)):
                c.text = ""
                run = c.paragraphs[0].add_run(str(v))
                run.font.size = Pt(9)
                if j == 0 and not header:
                    run.bold = True
                if header and i % 2 == 1:
                    shade(c, "F6F5F4")
        for row in t.rows:
            for c, w in zip(row.cells, widths_cm):
                c.width = Cm(w)
        doc.add_paragraph()
        return t

    # header / footer
    hp = sec.header.paragraphs[0]
    r = hp.add_run("INTERLOCK")
    r.bold, r.font.size, r.font.color.rgb = True, Pt(10), ink
    r = hp.add_run(f"\tRoot cause analysis · {model['doc_id']}")
    r.font.size, r.font.color.rgb = Pt(8.5), muted
    fp = sec.footer.paragraphs[0]
    r = fp.add_run(f"{model['site']} · Generated {model['generated']} · Draft for engineering review")
    r.font.size, r.font.color.rgb = Pt(7.5), muted

    doc.add_paragraph(model["title"], style="Title")
    p = doc.add_paragraph()
    r = p.add_run(f"{model['site']}  ·  {model['generated']}  ·  ")
    r.font.color.rgb = muted
    r = p.add_run(model["severity"])
    r.bold, r.font.color.rgb = True, (crit if model["tripped"] else RGBColor(0x1C, 0x8F, 0x5B))

    W = 17.2
    doc.add_heading("1. Executive summary", level=1)
    tbl(None, model["summary"], [3.4, W - 3.4])
    if model["major_events"]:
        doc.add_heading("2. Major events", level=1)
        tbl(["Time", "Event"], [(e["t"], e["text"]) for e in model["major_events"]], [2.6, W - 2.6])
    doc.add_heading("3. Timeline", level=1)
    tbl(["Time", "What happened"], [(e["t"], e["text"]) for e in model["timeline"]], [2.6, W - 2.6])

    doc.add_heading("4. Pareto analysis of incidents by cause", level=1)
    doc.add_picture(io.BytesIO(pareto_png(model)), width=Cm(W))
    doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
    tbl(["Cause", "Incidents", "Share", "Cumulative"],
        [(r["cause"], r["count"], f"{r['pct']:.0f}%", f"{r['cum_pct']:.0f}%") for r in model["pareto"]], [W - 7.2, 2.4, 2.2, 2.6])
    p = doc.add_paragraph(model["pareto_note"])
    p.runs[0].font.color.rgb, p.runs[0].font.size = muted, Pt(8.5)

    doc.add_heading("5. Five whys", level=1)
    for i, w in enumerate(model["whys"]):
        p = doc.add_paragraph()
        r = p.add_run(f"{i + 1}  ")
        r.bold, r.font.color.rgb = True, accent
        p.add_run(w["q"]).bold = True
        q = doc.add_paragraph(w["a"])
        q.paragraph_format.left_indent = Cm(0.6)
    p = doc.add_paragraph()
    r = p.add_run("Root cause  ")
    r.bold, r.font.color.rgb = True, crit
    p.add_run(model["root"])

    rule = model["rule"]
    doc.add_heading("6. Evidence from the legacy code", level=1)
    p = doc.add_paragraph()
    p.add_run(f"Rule {rule['id']} ").bold = True
    p.add_run(f"(legacy/chw_sequencer.st, lines {rule['lines'][0]}-{rule['lines'][1]}): {rule['english']}")
    code = doc.add_paragraph()
    for n, txt in rule["excerpt"]:
        r = code.add_run(f"{n:>3}  {txt}\n")
        r.font.name, r.font.size = "Consolas", Pt(8.5)
    shade_p = code._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear"), shd.set(qn("w:fill"), "F6F5F4")
    shade_p.append(shd)
    if model["tickets"]:
        doc.add_paragraph("Earlier tickets with the same pattern (all closed as cause unknown):")
        tbl(["Ticket", "Date", "Description"], [(t["id"], t["date"], t["text"]) for t in model["tickets"]], [2.4, 2.4, W - 4.8])
    if model["findings"]:
        doc.add_paragraph("Contributing findings:")
        for f in model["findings"]:
            doc.add_paragraph(f, style="List Bullet")

    doc.add_heading("7. Corrective and preventive actions", level=1)
    tbl(["Type", "Action", "Owner", "Status"], [(c["type"], c["action"], c["owner"], c["status"]) for c in model["capa"]], [3.0, W - 9.0, 3.2, 2.8])

    doc.add_heading("8. Assumptions and limits", level=1)
    for a in model["assumptions"]:
        p = doc.add_paragraph(a, style="List Bullet")
        p.runs[0].font.size, p.runs[0].font.color.rgb = Pt(8.5), muted

    doc.core_properties.title = f"{model['doc_id']} {model['title']}"
    doc.core_properties.author = "Interlock"
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
