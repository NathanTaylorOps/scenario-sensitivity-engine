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

  await page.fill("#term-input", "7");
  await page.fill("#ltv-input", "150");
  await page.waitForTimeout(500);
  await check("an out-of-range loan-to-value is rejected", async () => {
    const text = (await page.textContent("#financing-result"))?.trim() ?? "";
    assert.ok(text.includes("Invalid loan terms"), `expected a validation error, got: "${text}"`);
  });

  await page.fill("#ltv-input", "70");
  await page.waitForTimeout(500);
  await check("valid loan terms compute a normal DSCR result", async () => {
    const text = (await page.textContent("#financing-result"))?.trim() ?? "";
    assert.ok(/\d+%/.test(text), `expected a percentage in the result, got: "${text}"`);
    assert.ok(!text.includes("Invalid loan terms"), `valid inputs still show a validation error: "${text}"`);
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
