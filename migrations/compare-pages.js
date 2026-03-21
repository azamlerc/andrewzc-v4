#!/usr/bin/env node
// compare-pages.js
//
// For each page in the DB that still has a corresponding static HTML file,
// opens both the static and dynamic versions in the browser side by side
// and asks whether the new page looks good.
//
// If you answer 'y', the static file is moved to the 'old/' folder.
// If you answer 'n' (or anything else), it is skipped.
//
// Usage:
//   node migrations/compare-pages.js [--start <key>]
//
// Options:
//   --start <key>   Skip ahead to a specific page key (resume after interruption)

import "dotenv/config";
import { MongoClient } from "mongodb";
import { execSync } from "child_process";
import { existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import * as readline from "readline";

const URI       = process.env.MONGODB_URI;
const DB        = process.env.MONGODB_DB || "andrewzc";
const SITE_DIR  = "/Users/andrewzc/Projects/andrewzc.net";
const OLD_DIR   = join(SITE_DIR, "old");
const BASE_URL  = "http://localhost/andrewzc";

if (!URI) throw new Error("Missing MONGODB_URI in environment");

// ── Parse --start arg ────────────────────────────────────────────────────────

const startIdx = process.argv.indexOf("--start");
const startKey = startIdx !== -1 ? process.argv[startIdx + 1] : null;

// ── Readline prompt ──────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

// ── Main ─────────────────────────────────────────────────────────────────────

const client = new MongoClient(URI);

async function main() {
  await client.connect();
  const db = client.db(DB);

  const pages = await db.collection("pages")
    .find({}, { projection: { key: 1 } })
    .sort({ key: 1 })
    .toArray();

  await client.close();

  // Ensure old/ directory exists
  if (!existsSync(OLD_DIR)) {
    mkdirSync(OLD_DIR);
    console.log(`Created ${OLD_DIR}`);
  }

  // Filter to pages that still have a static HTML file
  const toCompare = pages.filter(p => existsSync(join(SITE_DIR, `${p.key}.html`)));

  console.log(`${pages.length} pages in DB, ${toCompare.length} still have static HTML files.\n`);

  // Optionally skip ahead
  let startIndex = 0;
  if (startKey) {
    const idx = toCompare.findIndex(p => p.key === startKey);
    if (idx === -1) {
      console.warn(`--start key "${startKey}" not found, starting from beginning.`);
    } else {
      startIndex = idx;
      console.log(`Resuming from "${startKey}" (${startIndex + 1}/${toCompare.length}).\n`);
    }
  }

  let moved = 0;
  let skipped = 0;

  for (let i = startIndex; i < toCompare.length; i++) {
    const { key } = toCompare[i];
    const staticFile = join(SITE_DIR, `${key}.html`);
    const staticUrl  = `${BASE_URL}/${key}.html`;
    const dynamicUrl = `${BASE_URL}/page.html?id=${key}`;

    console.log(`\n[${i + 1}/${toCompare.length}] Comparing: ${key}`);
    console.log(`  Static:  ${staticUrl}`);
    console.log(`  Dynamic: ${dynamicUrl}`);

    // Open both URLs in the default browser
    execSync(`open "${staticUrl}" "${dynamicUrl}"`);

    const answer = await ask("  Does the new page look good? [y/n/q] ");
    const trimmed = answer.trim().toLowerCase();

    if (trimmed === "q") {
      console.log("\nQuitting. Run with --start " + key + " to resume here.");
      break;
    } else if (trimmed === "y") {
      const dest = join(OLD_DIR, `${key}.html`);
      renameSync(staticFile, dest);
      console.log(`  ✓ Moved to old/${key}.html`);
      moved++;
    } else {
      console.log(`  – Skipped.`);
      skipped++;
    }
  }

  rl.close();
  console.log(`\nDone. Moved: ${moved}, Skipped: ${skipped}.`);
}

main().catch(err => { console.error(err); rl.close(); process.exit(1); });
