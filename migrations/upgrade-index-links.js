// One-shot migration: rewrite static .html links to page.html?id= on index pages
//
// For each sub-page listed in index.html (Trains through Cars, excluding
// infrastructure, bucket list, heritage sites), finds all links of the form
// "foo.html" where "foo" is a known page key in the DB, and rewrites them to
// "page.html?id=foo".
//
// Also fixes malformed "page.html?id=foo.html" links (strips the .html suffix).
//
// Run:  node migrations/upgrade-index-links.js [--dryrun]
// Env:  SITE_ROOT defaults to /Users/andrewzc/Projects/andrewzc.net

import "dotenv/config";
import fs from "fs";
import path from "path";
import { queryPages } from "../database.js";

const ROOT   = path.resolve(process.env.SITE_ROOT || "/Users/andrewzc/Projects/andrewzc.net");
const dryRun = process.argv.includes("--dryrun");

// ── 1. Load all known page keys from DB ──────────────────────────────────────

const pages    = await queryPages({});
const pageKeys = new Set(pages.map(p => p.key));
console.log(`Loaded ${pageKeys.size} page keys from DB\n`);

// ── 2. Index pages to process ─────────────────────────────────────────────────
// Trains → Cars inclusive. Excluded per instructions:
//   infrastructure (already upgraded manually)
//   bucket list / heritage sites (already use page.html?id=)

const INDEX_PAGES = [
  "trains.html",
  "buildings.html",
  "cities-index.html",
  "countries-index.html",
  "geography.html",
  "nature.html",
  "roadtrips.html",
  "states-index.html",
  "music.html",
  "people.html",
  "cars-index.html",
];

// These filenames should never be rewritten even if present
const SKIP_KEYS = new Set([
  "page", "edit", "search", "nearby", "hello", "styles",
  "flags", "typeahead", "map", "index", "bingo", "photos",
  "maps", "coding", "portfolio", "social", "resume",
]);

// ── 3. Process each file ──────────────────────────────────────────────────────

// Matches: href="foo.html" or href='foo.html'
const STATIC_RE   = /href=(["'])([a-z0-9][a-z0-9\-]*)\.html\1/g;
// Matches malformed: href="page.html?id=foo.html"
const MALFORMED_RE = /href=(["'])page\.html\?id=([a-z0-9][a-z0-9\-]*)\.html\1/g;

let totalRewrites = 0;
let totalUnknown  = 0;

for (const filename of INDEX_PAGES) {
  const filepath = path.join(ROOT, filename);

  if (!fs.existsSync(filepath)) {
    console.log(`⚠️  Not found: ${filename} — skipping\n`);
    continue;
  }

  const original = fs.readFileSync(filepath, "utf8");
  let updated    = original;
  const fileRewrites = [];
  const fileUnknown  = [];

  // Pass 1: fix malformed page.html?id=foo.html → page.html?id=foo
  updated = updated.replace(MALFORMED_RE, (match, quote, key) => {
    if (pageKeys.has(key)) {
      fileRewrites.push(`[fix] page.html?id=${key}.html → page.html?id=${key}`);
      return `href=${quote}page.html?id=${key}${quote}`;
    }
    return match;
  });

  // Pass 2: foo.html → page.html?id=foo (only for known page keys)
  updated = updated.replace(STATIC_RE, (match, quote, key) => {
    if (SKIP_KEYS.has(key)) return match;

    if (pageKeys.has(key)) {
      fileRewrites.push(`${key}.html → page.html?id=${key}`);
      return `href=${quote}page.html?id=${key}${quote}`;
    }

    fileUnknown.push(`${key}.html`);
    return match; // leave unknown links as-is
  });

  const changed = fileRewrites.length;
  totalRewrites += changed;
  totalUnknown  += fileUnknown.length;

  console.log(`${filename}:`);
  for (const r of fileRewrites) console.log(`  ✅ ${r}`);
  for (const u of fileUnknown)  console.log(`  ⚠️  unknown (not in DB): ${u}`);

  if (changed === 0) {
    console.log(`  (no changes)\n`);
    continue;
  }

  if (!dryRun) {
    fs.writeFileSync(filepath, updated, "utf8");
    console.log(`  → wrote ${changed} change(s)\n`);
  } else {
    console.log(`  → [dry run] would write ${changed} change(s)\n`);
  }
}

console.log(`────────────────────────────────────────`);
console.log(`Rewrites: ${totalRewrites}  |  Unknown links left as-is: ${totalUnknown}`);
if (dryRun) console.log(`[DRY RUN] No files were modified.`);
