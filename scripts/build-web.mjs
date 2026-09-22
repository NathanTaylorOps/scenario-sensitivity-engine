#!/usr/bin/env node
/**
 * Builds the static browser UI: type-checks and compiles src/web (plus the
 * engine/personas modules it imports) to plain ES modules with tsc, then
 * copies the static HTML/CSS into dist/web. No bundler is used — the source
 * keeps `.ts` import extensions for Node-native execution, and
 * `rewriteRelativeImportExtensions` in tsconfig.web.json rewrites them to
 * `.js` in the compiled output so the browser can load them directly as
 * native ES modules.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distWeb = path.join(root, "dist", "web");

console.log("Type-checking and compiling src/web (tsc -p tsconfig.web.json)...");
execFileSync("npx", ["tsc", "-p", "tsconfig.web.json"], { cwd: root, stdio: "inherit" });

mkdirSync(distWeb, { recursive: true });
copyFileSync(path.join(root, "web", "index.html"), path.join(distWeb, "index.html"));
copyFileSync(path.join(root, "web", "styles.css"), path.join(distWeb, "styles.css"));
copyFileSync(path.join(root, "web", "og-image.png"), path.join(distWeb, "og-image.png"));

console.log(`Built static UI at ${path.relative(root, distWeb)}/`);
