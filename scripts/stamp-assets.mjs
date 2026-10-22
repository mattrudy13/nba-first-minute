#!/usr/bin/env node
// Cache-busting for GitHub Pages (which lets browsers cache files for 10 minutes): stamps each shared
// asset's content hash onto the tags that load it, e.g. <script src="model.js?v=1a2b3c4d">. A changed
// file gets a new URL, so a fresh page never runs against a stale cached model.js / common.js / style.css.
//
//   node scripts/stamp-assets.mjs           # rewrite the HTML files
//   node scripts/stamp-assets.mjs --check   # exit 1 if any stamp is out of date (CI)

import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = ["model.js", "common.js", "style.css"];
const check = process.argv.includes("--check");

const hashes = {};
for (const a of ASSETS) hashes[a] = createHash("sha256").update(await readFile(path.join(ROOT, a))).digest("hex").slice(0, 8);

const stale = [];
for (const f of (await readdir(ROOT)).filter((f) => f.endsWith(".html"))) {
  const file = path.join(ROOT, f);
  const html = await readFile(file, "utf8");
  const out = html.replace(/(src|href)="(model\.js|common\.js|style\.css)(?:\?v=[0-9a-f]*)?"/g, (_, attr, a) => `${attr}="${a}?v=${hashes[a]}"`);
  if (out !== html) {
    stale.push(f);
    if (!check) await writeFile(file, out);
  }
}
if (check && stale.length) {
  console.error(`Asset stamps out of date in: ${stale.join(", ")}. Run: node scripts/stamp-assets.mjs`);
  process.exit(1);
}
console.log(check ? "asset stamps up to date" : stale.length ? `stamped ${stale.join(", ")}` : "already up to date");
