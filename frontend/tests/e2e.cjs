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
  const ctx = await b.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on("pageerror", (e) => errs.push(String(e)));
  pg.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  const shot = async (n) => OUT && pg.screenshot({ path: `${OUT}/${n}.png` });

  await pg.goto(URL);
  await pg.waitForSelector("#go");
  check("wordmark", (await pg.getAttribute(".logo", "aria-label")) === "Interlock" && (await pg.$(".logo .fan")) !== null);
  const shape = (sel) => pg.$eval(sel, (e) => getComputedStyle(e).borderRadius + "/" + getComputedStyle(e).height);
  const pill = await shape("[data-testid=status]"), btn = await shape("#go");
  check("status box same shape as queue button", pill === btn, `${pill} vs ${btn}`);
  check("job clock defaults to T-5 min", (await pg.innerText("[data-testid=clock]")) === "T−300s");
  await shot("01-idle");

  // the rule drawer opens from the top bar on any tab
  await pg.click("#rules-btn");
  await pg.waitForSelector(".drawer .english");
  check("rule drawer", /0\.02 °C\/s/.test(await pg.innerText(".drawer .english")));
  await pg.waitForTimeout(400);
  await shot("01b-drawer");
  await pg.keyboard.press("Escape");

  // Run 1: ignore the pre-warning, act inside the live-alert window
  await pg.click("#go");
  await pg.waitForSelector("#pw-title");
  check("pre-warning dialog", /cooling loop stops/i.test(await pg.innerText("#pw-title")));
  await shot("02-prewarning");
  await pg.click("[data-pick=ignore]");
  await pg.waitForSelector("[data-testid=act-within]", { timeout: 30000 });
  check("final-call countdown", /\d/.test(await pg.innerText("[data-testid=act-within]")) && /final call/i.test(await pg.innerText(".alertpanel")));
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
  for (const [fmt, sel] of [["pdf", "#rca-pdf"], ["docx", "#rca-docx"]]) {
    const [dl] = await Promise.all([pg.waitForEvent("download", { timeout: 30000 }), pg.click(sel)]);
    check(`RCA ${fmt} download`, dl.suggestedFilename().endsWith("." + fmt), dl.suggestedFilename());
  }

  await pg.click("#t-logic");
  await pg.click("[data-r=R7]");
  check("rules detail", /retired/i.test(await pg.innerText("#detail")));
  check("only one Ask box", (await pg.$$("[aria-label='Ask about the rules']")).length === 1);
  check("removed parser sentence", !/not guessed/.test(await pg.innerText("body")));
  await pg.click("[data-r=R1]");
  await shot("08-rules");

  // a rule can be popped out into its own window
  const [pop] = await Promise.all([ctx.waitForEvent("page"), pg.click("#detail >> text=Open in new window")]);
  await pop.waitForSelector(".english");
  check("rule in its own window", /R1/.test(await pop.title()) && /cooling loop/.test(await pop.innerText(".english")));
  await pop.close();

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
