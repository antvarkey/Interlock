"""FastAPI server for Interlock. Run with:  python -m uvicorn interlock.server:app --port 8000"""
from __future__ import annotations

import os
from dataclasses import replace
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import llm_assist
from .ask import ask
from .engine import Interlock
from .parity import BUGS

BACKEND = Path(__file__).resolve().parent.parent
# The React dashboard lives in ../frontend. `npm run build` writes it to frontend/dist,
# which this server serves. During development, run `npm run dev` there instead (it proxies /api here).
WEB = Path(os.environ.get("INTERLOCK_WEB_DIR", BACKEND.parent / "frontend" / "dist"))
app = FastAPI(title="Interlock")
il = Interlock()

# The job clock is configurable: how long after the job is queued it starts. Each setting gets its
# own (cached) engine, because the plant timeline and every prediction depend on it.
JOB_START_CHOICES = (120, 180, 300, 600)
_by_start: dict[int, Interlock] = {il.params.job_start_s: il}


def engine_for(job_start_s: int | None) -> Interlock:
    if job_start_s is None or job_start_s == il.params.job_start_s:
        return il
    if job_start_s not in JOB_START_CHOICES:
        raise HTTPException(400, f"job_start_s must be one of {list(JOB_START_CHOICES)}")
    if job_start_s not in _by_start:
        _by_start[job_start_s] = Interlock(params=replace(il.params, job_start_s=job_start_s))
    return _by_start[job_start_s]


class ParityReq(BaseModel):
    sequences: int = 2000
    bug: str | None = None


class PlanReq(BaseModel):
    profile: str = "single"          # "single" or "staged"
    manual_lead_s: int | None = None  # start chiller 2 by hand this many seconds before the job
    manual_at: int | None = None      # or: start chiller 2 by hand at this absolute second (mid-run override)
    job_start_s: int | None = None    # job clock: seconds from queueing to job start (default 300)


class LogEntry(BaseModel):
    t: int
    text: str
    kind: str = "info"


class ReportReq(PlanReq):
    format: str = "pdf"                       # "pdf" or "docx"
    operator_log: list[LogEntry] = []         # the event log from the dashboard, including operator actions


class AskReq(BaseModel):
    question: str


def _check(req: PlanReq) -> Interlock:
    il = engine_for(req.job_start_s)
    if req.profile not in ("single", "staged"):
        raise HTTPException(400, "profile must be 'single' or 'staged'")
    if req.manual_lead_s is not None and not (0 <= req.manual_lead_s <= il.params.job_start_s):
        raise HTTPException(400, f"manual_lead_s must be between 0 and {il.params.job_start_s}")
    if req.manual_at is not None and not (0 <= req.manual_at < il.params.duration_s):
        raise HTTPException(400, f"manual_at must be between 0 and {il.params.duration_s - 1}")
    if req.manual_at is not None and req.manual_lead_s is not None:
        raise HTTPException(400, "give manual_lead_s or manual_at, not both")
    return il


@app.get("/api/state")
def state(job_start_s: int | None = None):
    return {**engine_for(job_start_s).public_state(), "job_start_choices": list(JOB_START_CHOICES)}


@app.post("/api/parity")
def parity(req: ParityReq):
    if req.bug is not None and req.bug not in BUGS:
        raise HTTPException(400, f"unknown bug {req.bug!r}; choose from {sorted(BUGS)}")
    return il.parity(sequences=max(10, min(req.sequences, 20000)), bug=req.bug)


@app.post("/api/prewarning")
def prewarning(req: PlanReq):
    return _check(req).prewarning(req.profile, req.manual_lead_s)


@app.post("/api/simulate")
def simulate(req: PlanReq):
    return _check(req).simulate(req.profile, req.manual_lead_s, req.manual_at)


@app.post("/api/report")
def report(req: ReportReq):
    """Root cause analysis (Pareto + 5 whys) of the run, as a PDF or Word document."""
    from .report import build_rca, render_docx, render_pdf

    if req.format not in ("pdf", "docx"):
        raise HTTPException(400, "format must be 'pdf' or 'docx'")
    eng = _check(req)
    sim = eng.simulate(req.profile, req.manual_lead_s, req.manual_at)
    model = build_rca(eng, sim, [e.model_dump() for e in req.operator_log])
    if req.format == "pdf":
        body, mime = render_pdf(model), "application/pdf"
    else:
        body, mime = render_docx(model), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    name = f"{model['doc_id']}-interlock-rca.{req.format}"
    return Response(body, media_type=mime, headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.post("/api/ask")
def ask_endpoint(req: AskReq):
    return ask(il.public_state(), req.question)


@app.get("/api/llm/status")
def llm_status():
    return {"available": llm_assist.available(), "model": llm_assist.MODEL, "rewrite_in_use": il.rewrite_origin,
            "jobs": ["rewrite proposal (verified by parity test)", "glossary draft (human approval)", "operator Q&A"]}


@app.post("/api/llm/translate")
def llm_translate():
    client = llm_assist.default_client()
    if client is None:
        return {"available": False, "message": "Needs the anthropic package and ANTHROPIC_API_KEY."}
    rep = llm_assist.propose_rewrite(il, client)
    if rep["accepted"]:
        out = BACKEND / "generated"
        out.mkdir(exist_ok=True)
        (out / "llm_sequencer.py").write_text(rep["source"])
    return {"available": True, **{k: v for k, v in rep.items() if k != "source"}}


NOT_BUILT = """<!doctype html><meta charset="utf-8"><title>Interlock</title>
<body style="background:#07090c;color:#e8edf3;font:15px system-ui;padding:48px">
<h2>Interlock API is running</h2><p>The dashboard has not been built yet. Run:</p>
<pre style="background:#11151b;padding:16px;border-radius:8px">cd frontend
npm install
npm run build</pre><p>or use <code>npm run dev</code> for live reload. The API is under <code>/api</code>.</p></body>"""


@app.get("/", response_class=HTMLResponse)
def index():
    if (WEB / "index.html").exists():
        return FileResponse(WEB / "index.html")
    return HTMLResponse(NOT_BUILT)


@app.get("/favicon.svg", include_in_schema=False)
def favicon():
    f = WEB / "favicon.svg"
    if not f.exists():
        raise HTTPException(404)
    return FileResponse(f, media_type="image/svg+xml")


if (WEB / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=WEB / "assets"), name="assets")
