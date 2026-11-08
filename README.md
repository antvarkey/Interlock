# Interlock

Interlock reads decades-old data center control logic, turns it into plain-English rules, proves a modern
rewrite behaves the same, and uses those rules to warn operators **before** a training job start trips the
cooling system.

Built for two hackathon tracks:

- **8090 (legacy modernization):** source code in, traceable rules out, a rewrite checked against the original.
- **NorthMark Compute & Cloud (keep the data center running):** a pre-warning with verified steps, a live alert, and an
  automatic shift handoff.

## The scenario it demonstrates

One data hall: 64 liquid-cooled GPU racks (4,608 GPUs) fed by a chilled-water plant with evaporative cooling towers.
The idle cluster starts a large training job, and IT load jumps from 2.1 MW to 8.3 MW in about 10 seconds. One chiller
removes 4.5 MW. The second chiller is not staged in until chiller 1 has been heavily loaded for 90 seconds, and then
needs about 45 seconds to start. The facility-water supply rises faster than rule R1 allows, so R1 trips the cooling
loop about 29 seconds after the job starts. Restart is then blocked for 300 seconds, and the GPUs throttle and then
shut down on over-temperature.

Interlock finds R1 in the old code, predicts the trip from the job queue, and tells the operator what to do. It checks
each recommended step in the plant simulator before suggesting it.

## Repository layout

```
backend/    Python: parser, rule extraction, rewrite + parity test, plant simulator, predictor, alerts, FastAPI
  interlock/    the package (server.py is the API)
  legacy/       the fake legacy system: controller, glossary, runbook, point list, tickets, mitigations
  generated/    the generated modern controller
  tests/        pytest suite
frontend/   React + Vite operator dashboard
  src/          App, views (Live, Rules, Verification, Handoff), components, the scenario engine
  tests/        browser end-to-end check (Playwright)
  prototype/    single-file offline fallback (no server), same look and logo
```

## Run it

```bash
# 1. backend (API on :8000)
cd backend
pip install -r requirements.txt
uvicorn interlock.server:app --port 8000

# 2. frontend, in a second terminal
cd frontend
npm install
npm run build        # the backend now serves the dashboard at http://localhost:8000
# or: npm run dev    # live reload on http://localhost:5173, /api is proxied to :8000
```

Other backend commands (run from `backend/`):

```bash
python -m interlock.cli rules               # extracted rules and findings
python -m interlock.cli demo                # the three job-start scenarios, as text
python -m interlock.cli parity              # old-vs-new differential test (about 425,000 scans)
python -m interlock.cli parity --bug lockout   # shows the test catching an injected change
python -m interlock.cli build               # writes generated/modern_sequencer.py
python -m pytest                            # 35 tests
```

Dashboard end-to-end check (backend running and serving `frontend/dist`):

```bash
cd frontend && node tests/e2e.cjs [screenshot-dir]
```

## The dashboard

Design follows the two sponsors: 8090's warm graphite palette, Söhne-style grotesk type (Inter Tight), dot grid,
hairlines, numbered sections and traceability tags (`R1 · L52–56` on every alert); NMC²'s electric blue, prism
glow, thin telemetry numerals and letter-spaced call-to-action buttons. The wordmark is white with the "O" drawn as a
cooling fan that turns while the loop runs, turns faster when chiller 2 is helping, and stops when the loop trips.

| Section | What it shows |
| --- | --- |
| 01 Live operations (main window) | Queue a job, pre-warning dialog with verified steps, job clock and playback settings, live telemetry, charts against the "if nobody acts" forecast, and the live alerts |
| 02 Rules & verification | The 7 extracted rules with source lines, the Ask box, findings and incident tickets; the parity test, rule coverage, "break it on purpose" buttons, and the legacy and rewritten code |
| 03 Shift handoff | Generated handoff: timeline with operator actions, root cause, earlier tickets, follow-ups, and the RCA report. Pre-job briefing before a run |

**Rules from anywhere.** The `Rules` button in the top bar, and every `R1 · L52–56` tag, opens a drawer with the rule
in plain English and its source lines, without leaving the page. "Open in new window" pops a rule out into its own
window (`/?rule=R1`) so it can sit next to the dashboard.

**Job clock.** Choose how long after queueing the job starts (2, 3, 5 or 10 minutes; 5 is the default) and the
playback speed (demo pace, real time, 2×, 5×, 10×). The backend re-runs the plant for the chosen start time.

**Live alerts.** The alert system has these parts:

- **Pre-warning** when the job is queued: which rule fires, the evidence, matching incidents, and steps that are each
  checked in the simulator. The operator picks a plan, ignores it, or cancels.
- **Final call** before the job starts. A chiller needs about 45 s to start, so once the power ramp is visible it is
  already too late. The scheduler knows the start time, so Interlock counts down to the last moment a fix still works:
  an act-within countdown, the time to trip, and buttons to start chiller 2 or acknowledge.
- **Ramp alert** when facility power rises by 1 MW within 3 s. If the window has closed, it tells operators to
  checkpoint jobs and prepare to recover.
- **Operator override mid-run.** "Start chiller 2 now" re-simulates on the backend (`/api/simulate` with `manual_at`)
  and playback continues on the new timeline. Acting inside the window avoids the trip; acting late shortens the outage.
- **Alert states:** armed, monitoring, act now, window closed, tripped (with the lockout countdown), recovering, resolved.
- **Delivery:** toasts, a notification bell with history, alert tones, a red banner that shows on every tab, the
  browser tab title, the phase stepper and the logo fan.

**Root cause analysis report.** After a run, the Shift handoff page downloads a PDF or Word report (`/api/report`):
executive summary, major events, timeline with operator actions, a Pareto chart of incidents by cause, five whys,
evidence from the legacy code with line numbers, corrective and preventive actions with owners, and assumptions. It is
built from the run, the extracted rules and the tickets, not written by a language model, and marked as a draft for
engineering review.

## Plant model

The plant is sized like one hall of a large GPU deployment. What is verified and what is assumed:

| | Value in the model | Basis |
| --- | --- | --- |
| Site context | One hall, Spartanburg-style HPC campus | NMC² is building in stages at 4000 S. Pine St, Spartanburg, first stage planned for Q3 2026, initially permitted for 48 MW of on-site gas generation and applying for more than 450 MW ([Post and Courier](https://www.postandcourier.com/spartanburg/news/spartanburg-data-center-northmark-water-power/article_07cc2de8-9eb6-4711-ad7f-90ef8230b158.html), [Compute Atlas](https://www.compute-atlas.com/facilities/northmark-valara-spartanburg-sc)) |
| Heat rejection | Chillers with evaporative cooling towers, closed loop to the racks | About 459,000 gallons a day projected, 85 % lost to evaporation; reported as evaporative plus closed-loop cooling (same sources) |
| IT load | 64 racks × ~130 kW = 8.3 MW full, 2.1 MW idle | Rack-scale liquid-cooled NVIDIA systems are rated about 120 kW, with 130–132 kW reported in deployments (industry guides). NMC² does not publish its hardware. Idle at 25 % is an assumption |
| Ramp | Idle to full in about 10 s | Synchronous training jobs swing between compute-heavy and communication-heavy phases, causing fast power swings ([Microsoft/OpenAI/NVIDIA, arXiv:2508.14318](https://arxiv.org/abs/2508.14318)) |
| Chillers | 2 duty + 1 standby, 4.5 MW each; 45 s to start, 120 s to full load | Vendor fast-start figures: online in about 43 s and near full load in under 4 minutes; standard restarts take 10–15 minutes |
| Temperatures | Facility-water supply 25 °C; GPUs throttle at 32 °C, shut down at 35 °C | Warm-water liquid cooling range; exact limits are assumptions |
| Facility power cap | 10.5 MW | Assumption, chosen so the verified fixes stay under it |

Replace these with the facility's real values in `PlantParams` (`backend/interlock/plant.py`); the legacy code, runbook
and tests use the same numbers.

## How it works

```
legacy/chw_sequencer.st ──► st_parser ──► extract ──► rules (English + source lines + findings)
        │                                     │
        └──► interp (reference)               └──► codegen ──► generated/modern_sequencer.py
                    └────────── parity.py: run both on generated inputs, compare everything ──────┘

plant.py (heat, chillers, loop) + modern controller ──► engine.predict ──► alerts, verified steps, handoff
```

| File | Role |
| --- | --- |
| `backend/legacy/` | The fake legacy system: controller, glossary, runbook, point list, tickets, mitigations |
| `backend/interlock/st_parser.py` | Parser for the Structured Text subset, keeps source line numbers |
| `backend/interlock/interp.py` | Reference interpreter, the ground truth for the rewrite |
| `backend/interlock/extract.py` | Plain-English rules, counter detection, runbook and point-list checks, ticket linking |
| `backend/interlock/codegen.py` | Generates readable Python with descriptive names and rule annotations |
| `backend/interlock/parity.py` | Differential test: compares outputs, all internal variables and rules fired on every scan |
| `backend/interlock/plant.py` | Small cooling-plant model used to run the controller forward |
| `backend/interlock/engine.py` | Predictor, verified mitigations, pre-warning, live alert, handoff |
| `backend/interlock/llm_assist.py` | The LLM jobs: rewrite proposal (verified), glossary draft (human approval) |
| `backend/interlock/ask.py` | Optional question box (needs `ANTHROPIC_API_KEY`) |
| `backend/interlock/server.py` | FastAPI API; serves the built dashboard from `frontend/dist` |
| `frontend/src/lib/useScenario.js` | Plays the simulation, raises the live alert, handles operator actions |

## Where the AI is used

The model **proposes**. Deterministic code **decides**. Needs `pip install anthropic` and `ANTHROPIC_API_KEY`.

| Job | What the model does | What checks it |
| --- | --- | --- |
| **Rewrite proposal** (`cli translate`) | Reads the legacy source and writes a modern Python controller | Screened for unsafe code (no imports, loops, `eval`, file access), then the parity test, then a held-out parity run on different random inputs. A mismatch goes back to the model with the first difference, up to 4 tries. Accepted only if every rule was exercised and nothing differed. Written to `generated/llm_sequencer.py` with a report; used only with `INTERLOCK_REWRITE=llm`, and re-verified at every startup |
| **Glossary draft** (`cli glossary-draft`) | Suggests plain names and descriptions for cryptic tags from the source, point list and runbook | Schema check, and the output is labelled "proposed, needs human review". Nothing uses it automatically |
| **Operator Q&A** (`/api/ask`) | Answers questions from the extracted rules, findings and tickets only | Context is limited to extracted facts; it must cite rule ids |

The model never decides whether a job will trip cooling (the plant simulator does), never writes the operator-facing
rule text (the parser and templates do) and is never the only evidence for a "verified" claim. Without a key everything
else works, using the deterministic rewrite.

## Be honest about the limits

- **The legacy code is synthetic.** It was written for this demo. The parser handles a Structured Text subset
  (assignments, IF/ELSIF/ELSE, boolean and arithmetic expressions). Real PLC programs need more language support.
- **Plant numbers are illustrative placeholders** (`PlantParams` in `plant.py`). Replace them with real ramp rates,
  chiller capacities and delays from the facility.
- **Rule extraction is deterministic, not an LLM.** That is deliberate: every rule is traceable to source lines and
  checked by the parity test. The LLM rewrite proposal exists for code the parser cannot handle yet, with the parity test as the safety net.
- **The LLM paths were tested with a scripted stand-in, not a live model.** The loop, screening, repair feedback and
  adoption rules are covered by tests; real model output has not been run here. The code screen is an allowlist in the
  same process, so run untrusted model code in a subprocess or container before using this on real systems.
- **The glossary and mitigations are hand-written** (`legacy/glossary.json`, `legacy/mitigations.json`). In a real
  deployment an engineer reviews them. The mitigations are verified in simulation, but only inside this plant model.
- **"Parity" means no differences across the tested scans.** It is strong evidence, not a proof.
- **Interlock recommends; it never actuates.** A human approves every step.
- **The ramp alert always comes too late** in this scenario, because a chiller takes about 45 s to start. That is a
  result, not a bug: the pre-warning and the final call, both timed from the scheduler, are what give operators time.
- **The "Ask Interlock" box** and the two jobs above are the only parts that call an LLM, and none has been run against the live API.

## Clickable prototype (no server needed)

`frontend/prototype/interlock.html` is a single file that runs the whole scenario in the browser: pre-warning dialog, live alert
with countdown, popup notifications, rules, parity test and handoff. Open it directly, or host it anywhere static.

```
cd frontend/prototype
python export_data.py      # re-export rules and reference timelines from the Python engine
python build.py            # assemble interlock.html from template.html + engine.js + app.js + style.css
node test_engine.js        # check the JavaScript engine matches the Python results exactly
python e2e_test.py [dir]   # click through it in headless Chromium (pip install playwright)
```
