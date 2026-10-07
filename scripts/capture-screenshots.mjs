#!/usr/bin/env node
/**
 * Reproducible portfolio screenshots of the real, built application.
 * No mocked metrics, generated images or manual browser state.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtRoot = path.join(projectRoot, "dist", "web");
const outputRoot = path.join(projectRoot, "artifacts", "screenshots");
const mime = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const fullPath = path.resolve(builtRoot, relative);
    if (!fullPath.startsWith(builtRoot + path.sep) && fullPath !== path.join(builtRoot, "index.html")) {
      res.writeHead(403).end();
      return;
    }
    const bytes = await readFile(fullPath);
    res.writeHead(200, { "Content-Type": mime[path.extname(fullPath)] ?? "application/octet-stream" }).end(bytes);
  } catch {
    res.writeHead(404).end("Not found");
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
try {
  await mkdir(outputRoot, { recursive: true });
  for (const target of [
    { name: "desktop-investment", width: 1440, height: 900, fullPage: true },
    { name: "mobile-investment", width: 390, height: 844, fullPage: true },
    { name: "desktop-first-screen", width: 1440, height: 900, fullPage: false },
  ]) {
    const context = await browser.newContext({ viewport: { width: target.width, height: target.height }, deviceScaleFactor: 1, colorScheme: "light", reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "networkidle" });
    await page.locator("#verdict-badge").waitFor();
    await page.locator("#range-chart svg").waitFor();
    await page.locator("#tornado-chart svg").waitFor();
    if (errors.length) throw new Error(`${target.name}: browser errors: ${errors.join("; ")}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflow) throw new Error(`${target.name}: horizontal viewport overflow`);
    await page.screenshot({ path: path.join(outputRoot, `${target.name}.png`), fullPage: target.fullPage, animations: "disabled" });
    console.log(`Captured ${target.name}.png at ${target.width}x${target.height}`);
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
