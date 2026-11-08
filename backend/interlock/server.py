"""FastAPI server for Interlock. Run with:  uvicorn interlock.server:app --port 8000"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
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


class ParityReq(BaseModel):
    sequences: int = 2000
    bug: str | None = None


class PlanReq(BaseModel):
    profile: str = "single"          # "single" or "staged"
    manual_lead_s: int | None = None  # start chiller 2 by hand this many seconds before the job
    manual_at: int | None = None      # or: start chiller 2 by hand at this absolute second (mid-run override)


class AskReq(BaseModel):
    question: str


def _check(req: PlanReq):
    if req.profile not in ("single", "staged"):
        raise HTTPException(400, "profile must be 'single' or 'staged'")
    if req.manual_lead_s is not None and not (0 <= req.manual_lead_s <= il.params.job_start_s):
        raise HTTPException(400, f"manual_lead_s must be between 0 and {il.params.job_start_s}")
    if req.manual_at is not None and not (0 <= req.manual_at < il.params.duration_s):
        raise HTTPException(400, f"manual_at must be between 0 and {il.params.duration_s - 1}")
    if req.manual_at is not None and req.manual_lead_s is not None:
        raise HTTPException(400, "give manual_lead_s or manual_at, not both")


@app.get("/api/state")
def state():
    return il.public_state()


@app.post("/api/parity")
def parity(req: ParityReq):
    if req.bug is not None and req.bug not in BUGS:
        raise HTTPException(400, f"unknown bug {req.bug!r}; choose from {sorted(BUGS)}")
    return il.parity(sequences=max(10, min(req.sequences, 20000)), bug=req.bug)


@app.post("/api/prewarning")
def prewarning(req: PlanReq):
    _check(req)
    return il.prewarning(req.profile, req.manual_lead_s)


@app.post("/api/simulate")
def simulate(req: PlanReq):
    _check(req)
    return il.simulate(req.profile, req.manual_lead_s, req.manual_at)


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
