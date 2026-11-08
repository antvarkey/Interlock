/* End-to-end check of the dashboard against a running backend.
   Usage: (backend on :8000 serving frontend/dist)  node tests/e2e.cjs [screenshotDir]
   Uses the Playwright that is installed globally (require('playwright')). */
const { chromium } = require("playwright");
const URL = process.env.INTERLOCK_URL || "http://localhost:8000/";
const OUT = process.argv[2] || null;
let failed = 0;
const check = (name, ok, info = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${info}`); if (!ok) failed++; };

(async () => {
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1440, height: 960 } });
  const errs = [];
  pg.on("pageerror", (e) => errs.push(String(e)));
  pg.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  const shot = async (n) => OUT && pg.screenshot({ path: `${OUT}/${n}.png` });

  await pg.goto(URL);
  await pg.waitForSelector("#go");
  check("wordmark", (await pg.getAttribute(".logo", "aria-label")) === "Interlock" && (await pg.$(".logo .fan")) !== null);
  await shot("01-idle");

  // Run 1: ignore the pre-warning, act inside the live-alert window
  await pg.click("#go");
  await pg.waitForSelector("#pw-title");
  check("pre-warning dialog", /cooling loop stops/i.test(await pg.innerText("#pw-title")));
  await shot("02-prewarning");
  await pg.click("[data-pick=ignore]");
  await pg.waitForSelector("[data-testid=act-within]", { timeout: 30000 });
  check("live alert countdown", /\d/.test(await pg.innerText("[data-testid=act-within]")));
  check("critical banner", (await pg.$(".banner")) !== null);
  check("alert toast", (await pg.$(".toast.crit")) !== null);
  await shot("03-live-alert");
  await pg.click("#opCh2");
  await pg.waitForFunction(() => /Trip avoided/.test(document.body.innerText), null, { timeout: 15000 });
  check("override avoids trip", true);
  await shot("04-resolved");
  await pg.click("text=Skip to end");
  await pg.waitForSelector("#result", { timeout: 30000 });
  check("result: no trip", /No trip/.test(await pg.innerText("#result")));

  // Run 2: ignore everything, see the trip
  await pg.click("#go");
  await pg.waitForSelector("[data-pick=ignore]");
  await pg.click("[data-pick=ignore]");
  await pg.waitForSelector("[data-testid=act-within]", { timeout: 30000 });
  await pg.waitForFunction(() => /Cooling loop tripped/.test(document.body.innerText), null, { timeout: 60000 });
  await shot("05-tripped");
  await pg.click("text=Skip to end");
  await pg.waitForSelector("#result", { timeout: 30000 });
  check("result: trip", /Cooling trip/.test(await pg.innerText("#result")));
  await shot("06-done");

  await pg.click("#t-handoff");
  await pg.waitForSelector("#hand");
  const hand = await pg.innerText("#hand");
  check("handoff has root cause + operator log", /R1/.test(hand) && /Operator chose to start without changes/.test(hand));
  await shot("07-handoff");

  await pg.click("#t-rules");
  await pg.click("[data-r=R7]");
  check("rules detail", /retired/i.test(await pg.innerText("body")));
  await pg.click("[data-r=R1]");
  await shot("08-rules");

  await pg.click("#t-verify");
  await pg.waitForFunction(() => /No differences/.test(document.body.innerText), null, { timeout: 30000 });
  check("parity passes", true);
  await pg.click("[data-bug=lockout]");
  await pg.waitForFunction(() => /Mismatch found/.test(document.body.innerText), null, { timeout: 30000 });
  check("parity catches planted bug", true);
  await shot("09-verify");

  check("no console errors", errs.length === 0, errs.join(" | "));
  await b.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
