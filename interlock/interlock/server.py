"""FastAPI server for Interlock. Run with:  uvicorn interlock.server:app --port 8000"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import llm_assist
from .ask import ask
from .engine import Interlock
from .parity import BUGS

WEB = Path(__file__).resolve().parent.parent / "web"
app = FastAPI(title="Interlock")
il = Interlock()


class ParityReq(BaseModel):
    sequences: int = 2000
    bug: str | None = None


class PlanReq(BaseModel):
    profile: str = "single"          # "single" or "staged"
    manual_lead_s: int | None = None  # start chiller 2 by hand this many seconds before the job


class AskReq(BaseModel):
    question: str


def _check(req: PlanReq):
    if req.profile not in ("single", "staged"):
        raise HTTPException(400, "profile must be 'single' or 'staged'")
    if req.manual_lead_s is not None and not (0 <= req.manual_lead_s <= il.params.job_start_s):
        raise HTTPException(400, f"manual_lead_s must be between 0 and {il.params.job_start_s}")


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
    return il.simulate(req.profile, req.manual_lead_s)


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
        out = Path(__file__).resolve().parent.parent / "generated"
        out.mkdir(exist_ok=True)
        (out / "llm_sequencer.py").write_text(rep["source"])
    return {"available": True, **{k: v for k, v in rep.items() if k != "source"}}


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


app.mount("/static", StaticFiles(directory=WEB), name="static")
