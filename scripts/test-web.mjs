#!/usr/bin/env node
/**
 * Automated smoke test for the built UI, run against dist/web/ (run `npm run
 * build:web` first). This is the gap identified in review: all 92 tests in
 * test/engine.test.ts exercise src/engine/ only — every check of src/web/
 * before this was a one-off script run by hand during development, never
 * committed, never repeatable, and never wired into CI. This is a floor, not
 * a full UI test suite: it checks that the page renders its key sections
 * with no console/page errors, and it regression-tests the loan-validation
 * bug caught during review (an invalid loan term used to silently report a
 * misleading "100% probability of meeting the covenant" instead of an
 * error). Requires Playwright's Chromium browser: `npx playwright install
 * chromium` once before the first run (see README).
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "dist", "web");
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png" };

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const reqPath = req.url === "/" ? "/index.html" : req.url;
        const data = await readFile(path.join(root, reqPath));
        res.writeHead(200, { "Content-Type": MIME[path.extname(reqPath)] ?? "application/octet-stream" });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(0, () => resolve(server));
  });
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().includes("favicon")) pageErrors.push(msg.text());
  });

  let failures = 0;
  const check = async (label, fn) => {
    try {
      await fn();
      console.log(`  ok - ${label}`);
    } catch (err) {
      failures += 1;
      console.error(`  FAIL - ${label}`);
      console.error(`    ${err.message}`);
    }
  };

  await page.goto(`http://localhost:${port}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);

  console.log("Checking initial render...");
  await check("verdict badge renders non-empty text", async () => {
    const text = (await page.textContent("#verdict-badge"))?.trim();
    assert.ok(text && text.length > 0, "verdict badge was empty");
  });
  await check("stat tiles render three values", async () => {
    const count = await page.$$eval(".stat-tile", (els) => els.length);
    assert.equal(count, 3, `expected 3 stat tiles, got ${count}`);
  });
  await check("tornado and range charts render as SVG", async () => {
    assert.ok(await page.$("#tornado-chart svg"), "tornado chart svg missing");
    assert.ok(await page.$("#range-chart svg"), "range chart svg missing");
  });
  await check("both charts' table fallbacks are present", async () => {
    const count = await page.$$eval(".viz-table-fallback", (els) => els.length);
    assert.equal(count, 2, `expected 2 chart table fallbacks, got ${count}`);
  });
  await check("all three audience panels render non-empty text", async () => {
    for (const id of ["audience-executor", "audience-cfo", "audience-lender"]) {
      const text = (await page.textContent(`#${id}`))?.trim();
      assert.ok(text && text.length > 0, `#${id} was empty`);
    }
  });
  await check("comparison table has one row per decision", async () => {
    const count = await page.$$eval("#comparison-table-body tr", (els) => els.length);
    assert.ok(count >= 2, `expected at least 2 comparison rows, got ${count}`);
  });

  console.log("Checking persona/decision switching...");
  await page.selectOption("#persona-select", { index: 1 });
  await page.waitForTimeout(400);
  const tabs = await page.$$("#decision-tabs .tab");
  await check("switching persona still renders decision tabs", () => {
    assert.ok(tabs.length > 0, "no decision tabs after switching persona");
  });
  if (tabs.length > 1) await tabs[1].click();
  await page.waitForTimeout(400);

  console.log("Regression-testing the loan-validation fix (financing panel)...");
  await page.selectOption("#persona-select", { index: 0 });
  await page.waitForTimeout(400);
  await page.fill("#term-input", "0");
  await page.waitForTimeout(500);
  await check("a 0-year loan term is rejected, not reported as a safe covenant", async () => {
    const text = (await page.textContent("#financing-result"))?.trim() ?? "";
    assert.ok(text.includes("Invalid loan terms"), `expected a validation error, got: "${text}"`);
    assert.ok(!text.includes("100%"), `financing panel still shows a misleading 100% for an invalid term: "${text}"`);
  });

  await page.fill("#term-input", "5");
  await page.fill("#ltv-input", "150");
  await page.waitForTimeout(500);
  await check("an out-of-range loan-to-value is rejected", async () => {
    const text = (await page.textContent("#financing-result"))?.trim() ?? "";
    assert.ok(text.includes("Invalid loan terms"), `expected a validation error, got: "${text}"`);
  });

  await page.fill("#ltv-input", "0");
  await page.waitForTimeout(500);
  await check("a 0% loan-to-value is explained as the all-equity case, not reported as a 100% covenant pass", async () => {
    const text = (await page.textContent("#financing-result"))?.trim() ?? "";
    assert.ok(text.includes("all-equity"), `expected the all-equity explanation, got: "${text}"`);
    assert.ok(!text.includes("100%"), `0% LTV still shows a vacuous 100%: "${text}"`);
  });

  await page.fill("#ltv-input", "70");
  await page.waitForTimeout(500);
  await check("valid loan terms compute an APV and a DSCR result", async () => {
    const text = (await page.textContent("#financing-result"))?.trim() ?? "";
    assert.ok(/\d+%/.test(text), `expected a percentage in the result, got: "${text}"`);
    assert.ok(text.includes("APV"), `expected an adjusted-present-value line, got: "${text}"`);
    assert.ok(text.includes("coverage"), `expected a coverage line, got: "${text}"`);
    assert.ok(!text.includes("minimumDscrPercentiles"), "raw field names must not leak into the UI");
    assert.ok(!text.includes("Invalid loan terms"), `valid inputs still show a validation error: "${text}"`);
  });

  await check("the loan term defaults to the decision's horizon", async () => {
    const term = await page.inputValue("#term-input");
    assert.equal(term, "5");
  });

  console.log("Checking the assumption editor (Phase 1 driver customization)...");
  await page.selectOption("#persona-select", { index: 0 });
  await page.waitForTimeout(400);

  await check("the editor panel is hidden by default, before it's ever opened (regression: a CSS specificity bug once made it show open on page load)", async () => {
    const visible = await page.isVisible("#editor-panel");
    assert.equal(visible, false, "the editor panel should not be visible until 'Edit assumptions' is clicked");
  });

  await page.click("#edit-assumptions-btn");
  await page.waitForTimeout(200);
  await check("the editor opens with one row per driver plus the discount rate", async () => {
    const rowCount = await page.$$eval(".editor-row", (els) => els.length);
    assert.ok(rowCount > 1, `expected multiple editor rows, got ${rowCount}`);
  });

  async function findRowByLabel(label) {
    const rows = await page.$$(".editor-row");
    for (const row of rows) {
      const text = await row.$eval(".editor-row-label", (el) => el.textContent ?? "");
      if (text.includes(label)) return row;
    }
    return null;
  }

  const statBefore = (await page.textContent("#stat-tiles .stat-tile:nth-child(2) .stat-value"))?.trim();

  const capexRow = await findRowByLabel("capex");
  const capexInputs = await capexRow.$$("input[type=number]");
  await capexInputs[0].fill("10000");
  await capexInputs[1].fill("15000");
  await capexInputs[2].fill("20000");
  await page.click("#editor-save-btn");
  await page.waitForTimeout(300);

  await check("editing a driver far outside its sourced range saves but shows a non-blocking guardrail warning", async () => {
    const warningsVisible = await page.isVisible("#editor-warnings");
    const errorsVisible = await page.isVisible("#editor-validation-errors");
    assert.equal(errorsVisible, false, "a merely unusual (but internally valid) edit must not be hard-blocked");
    assert.equal(warningsVisible, true, "a range with zero overlap with the sourced default should surface a guardrail warning");
  });

  await check("saving an edited assumption actually changes the computed result", async () => {
    const statAfter = (await page.textContent("#stat-tiles .stat-tile:nth-child(2) .stat-value"))?.trim();
    assert.notEqual(statAfter, statBefore, "base-case NPV should change after editing capex");
  });

  await check("the reset-to-defaults button appears once an override is saved", async () => {
    assert.equal(await page.isVisible("#reset-assumptions-btn"), true);
  });

  const statAfterEdit = (await page.textContent("#stat-tiles .stat-tile:nth-child(2) .stat-value"))?.trim();
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await check("a saved override persists across a page reload (localStorage)", async () => {
    const statAfterReload = (await page.textContent("#stat-tiles .stat-tile:nth-child(2) .stat-value"))?.trim();
    assert.equal(statAfterReload, statAfterEdit);
  });

  await page.click("#edit-assumptions-btn");
  await page.waitForTimeout(200);
  const capexRow2 = await findRowByLabel("capex");
  const capexInputs2 = await capexRow2.$$("input[type=number]");
  await capexInputs2[0].fill("999999"); // pessimistic > optimistic: structurally invalid
  await page.click("#editor-save-btn");
  await page.waitForTimeout(300);
  await check("an internally-invalid edit (pessimistic > optimistic) is hard-blocked by the engine's own validation, not just warned", async () => {
    assert.equal(await page.isVisible("#editor-validation-errors"), true);
  });

  await page.click("#editor-cancel-btn");
  await page.click("#reset-assumptions-btn");
  await page.waitForTimeout(300);
  await check("resetting to defaults restores the original built-in value", async () => {
    const statAfterReset = (await page.textContent("#stat-tiles .stat-tile:nth-child(2) .stat-value"))?.trim();
    assert.equal(statAfterReset, statBefore);
  });

  console.log("Checking scenario save/export/import (Phase 1 portability)...");
  await page.selectOption("#persona-select", { index: 0 });
  await page.waitForTimeout(300);

  await page.click("#edit-assumptions-btn");
  await page.waitForTimeout(200);
  const scenarioCapexRow = await findRowByLabel("capex");
  const scenarioCapexInputs = await scenarioCapexRow.$$("input[type=number]");
  await scenarioCapexInputs[1].fill("300000");
  await page.click("#editor-save-btn");
  await page.waitForTimeout(300);
  const npvWithOverride = (await page.textContent("#stat-tiles .stat-tile:nth-child(2) .stat-value"))?.trim();

  await page.fill("#scenario-name-input", "Smoke test scenario");
  await page.click("#scenario-save-btn");
  await page.waitForTimeout(200);
  await check("saving a scenario adds it to the saved-scenarios list", async () => {
    const count = await page.$$eval("#scenario-select option", (els) => els.length);
    assert.ok(count >= 1, "expected at least one saved scenario option");
  });

  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#scenario-export-btn")]);
  const exportPath = "/tmp/sse-smoke-test-export.json";
  await download.saveAs(exportPath);
  const exportedJson = JSON.parse(await readFile(exportPath, "utf8"));
  await check("an exported scenario file includes the active driver override", () => {
    assert.ok(exportedJson.driverOverride, "expected the exported file to carry the edited capex assumption");
  });

  await page.click("#reset-assumptions-btn");
  await page.waitForTimeout(200);
  const decisionTabsAfterReset = await page.$$("#decision-tabs .tab");
  if (decisionTabsAfterReset.length > 1) await decisionTabsAfterReset[1].click();
  await page.waitForTimeout(300);

  const importInput = await page.$("#scenario-import-input");
  await importInput.setInputFiles(exportPath);
  await page.waitForTimeout(400);

  await check("importing an exported scenario reproduces the identical result (determinism)", async () => {
    const npvAfterImport = (await page.textContent("#stat-tiles .stat-tile:nth-child(2) .stat-value"))?.trim();
    assert.equal(npvAfterImport, npvWithOverride, "importing the exported scenario should reproduce the exact same NPV as before it was exported");
  });

  await check("importing a scenario also switches back to the persona/decision it was saved from", async () => {
    const activeTabText = (await page.textContent("#decision-tabs .tab-active"))?.trim();
    assert.equal(activeTabText, "Buy a second CNC machine / production line");
  });

  await check("importScenarioFromJson rejects a malformed file without crashing the page", async () => {
    const fs = await import("node:fs/promises");
    const badPath = "/tmp/sse-smoke-test-bad-import.json";
    await fs.writeFile(badPath, "{ not actually json");
    const input = await page.$("#scenario-import-input");
    await input.setInputFiles(badPath);
    await page.waitForTimeout(300);
    const msgVisible = await page.isVisible("#scenario-message");
    assert.equal(msgVisible, true, "a bad import should surface a message, not fail silently");
  });

  await check("no console or page errors were raised during any of the above", () => {
    assert.deepEqual(pageErrors, [], `unexpected console/page errors: ${JSON.stringify(pageErrors)}`);
  });

  await browser.close();
  server.close();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll UI smoke checks passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
