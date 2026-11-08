# Interlock

Interlock reads decades-old data center control logic, turns it into plain-English rules, proves a modern
rewrite behaves the same, and uses those rules to warn operators **before** a training job start trips the
cooling system.

Built for two hackathon tracks:

- **8090 (legacy modernization):** source code in, traceable rules out, a rewrite checked against the original.
- **NorthMark Compute & Cloud (keep the data center running):** a pre-warning with verified steps, a live alert, and an
  automatic shift handoff.

## The scenario it demonstrates

An idle GPU cluster starts a large training job. IT power jumps from 180 kW to 1,400 kW in about 8 seconds. One
chiller can only remove 900 kW, and the second chiller is not staged in until chiller 1 has been heavily loaded for
90 seconds. The supply temperature rises faster than rule R1 allows, so R1 trips the cooling loop about 28 seconds
after the job starts. Restart is then blocked for 300 seconds, and the GPUs shut down on over-temperature.

Interlock finds R1 in the old code, predicts the trip from the job queue, and tells the operator what to do. It checks
each recommended step in the plant simulator before suggesting it.

## Run it

```bash
pip install -r requirements.txt
uvicorn interlock.server:app --port 8000     # open http://localhost:8000
```

Other commands:

```bash
python -m interlock.cli rules               # extracted rules and findings
python -m interlock.cli demo                # the three job-start scenarios, as text
python -m interlock.cli parity              # old-vs-new differential test (about 425,000 scans)
python -m interlock.cli parity --bug lockout   # shows the test catching an injected change
python -m interlock.cli build               # writes generated/modern_sequencer.py
python -m pytest                            # 23 tests
```

## What is in the dashboard

| Tab | What it shows |
| --- | --- |
| Live scenario | Queue a job, see the pre-warning with verified steps, run the scenario with live charts and alerts |
| Rules | The 7 extracted rules, each linked to its source lines, with findings and matching incident tickets |
| Verify | Parity test of the old code against the rewrite, rule coverage, and a "break it on purpose" button |
| Shift handoff | A generated handoff: timeline, root cause, earlier tickets with the same pattern, follow-ups |

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
| `legacy/` | The fake legacy system: controller, glossary, runbook, point list, tickets, mitigations |
| `interlock/st_parser.py` | Parser for the Structured Text subset, keeps source line numbers |
| `interlock/interp.py` | Reference interpreter, the ground truth for the rewrite |
| `interlock/extract.py` | Plain-English rules, counter detection, runbook and point-list checks, ticket linking |
| `interlock/codegen.py` | Generates readable Python with descriptive names and rule annotations |
| `interlock/parity.py` | Differential test: compares outputs, all internal variables and rules fired on every scan |
| `interlock/plant.py` | Small cooling-plant model used to run the controller forward |
| `interlock/engine.py` | Predictor, verified mitigations, pre-warning, live alert, handoff |
| `interlock/llm_assist.py` | The LLM jobs: rewrite proposal (verified), glossary draft (human approval) |
| `interlock/ask.py` | Optional question box (needs `ANTHROPIC_API_KEY`) |
| `interlock/server.py`, `web/` | FastAPI API and the dashboard (plain JavaScript, no build step) |

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
- **The live alert gives only a few seconds** in this scenario. That is a result, not a bug: the pre-warning is what
  gives operators time to act.
- **The "Ask Interlock" box** and the two jobs above are the only parts that call an LLM, and none has been run against the live API.

## Clickable prototype (no server needed)

`prototype/interlock.html` is a single file that runs the whole scenario in the browser: pre-warning dialog, live alert
with countdown, popup notifications, rules, parity test and handoff. Open it directly, or host it anywhere static.

```
cd prototype
python export_data.py      # re-export rules and reference timelines from the Python engine
python build.py            # assemble interlock.html from template.html + engine.js + app.js + style.css
node test_engine.js        # check the JavaScript engine matches the Python results exactly
python e2e_test.py         # click through it in headless Chromium (pip install playwright; playwright install chromium)
```
