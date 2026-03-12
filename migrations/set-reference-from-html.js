// Migration: parse the local-script name from a static RTL HTML page
// (mosques.html, synagogues.html, or any page using the same bilingual format)
// and save it as the `reference` field on each matching entity in the DB.
//
// The static RTL pages use this pattern per item:
//   <a class="english" href="...">English Name</a> <span>🇵🇸</span> <span class="arabic">
//   النص بالعربية
//   </span><br>
//
// The local-script text is the trimmed content of the span with class
// "arabic" or "hebrew" (both are handled generically).
//
// Usage:
//   node migrations/set-reference-from-html.js <list-key> [--dryrun]
//
// Examples:
//   node migrations/set-reference-from-html.js mosques
//   node migrations/set-reference-from-html.js synagogues --dryrun

import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import { fetchEntities, bulkSetFields } from "../database.js";

// ── Config ─────────────────────────────────────────────────────────────────────

const SITE_DIR = "/Users/andrewzc/Projects/andrewzc.net";

// ── Args ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const listKey = args[0];
const dryRun = process.argv.includes("--dryrun");

if (!listKey) {
  console.error("Usage: node migrations/set-reference-from-html.js <list-key> [--dryrun]");
  process.exit(1);
}

// ── HTML parser ────────────────────────────────────────────────────────────────

// Extract { englishName, localName } pairs from the static RTL HTML.
// Handles both been:true (above <hr>) and been:false (below <hr>) items,
// and handles struck-through items (<a class="english strike">).
//
// Collapses whitespace so the multi-line span pattern becomes a single line.
function parseLocalNames(html) {
  const result = new Map(); // englishName → localName

  const collapsed = html.replace(/\s+/g, " ");

  // Matches: <a class="english[optional extra classes]" ...>NAME</a> ... <span class="arabic|hebrew">LOCAL</span>
  const rowRegex = /<a class="english[^"]*"[^>]*>([^<]+)<\/a>(?:[^<]*<[^>]+>)*?[^<]*<span class="(?:arabic|hebrew)">\s*([^<]+?)\s*<\/span>/g;

  let m;
  while ((m = rowRegex.exec(collapsed)) !== null) {
    const englishName = m[1].trim();
    const localName   = m[2].trim();
    if (englishName && localName && !result.has(englishName)) {
      result.set(englishName, localName);
    }
  }

  return result;
}

// ── Key derivation ─────────────────────────────────────────────────────────────

// Reproduce the key-generation logic from database-workflow.md:
// lowercase, strip diacritics, punctuation → space, spaces → hyphens, strip "the-".
function toKey(name) {
  return name
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[''.,\-–—"()/]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^the-/, "")
    .replace(/^-|-$/g, "");
}

// ── Main ───────────────────────────────────────────────────────────────────────

const htmlPath = join(SITE_DIR, `${listKey}.html`);
let html;
try {
  html = readFileSync(htmlPath, "utf8");
} catch (err) {
  console.error(`Could not read ${htmlPath}: ${err.message}`);
  process.exit(1);
}

const localNames = parseLocalNames(html);
console.log(`Parsed ${localNames.size} local names from ${listKey}.html`);

if (localNames.size === 0) {
  console.error(`No local names found — check that the HTML uses class="arabic" or class="hebrew" on the script span.`);
  process.exit(1);
}

// Fetch all entities for this list
const entities = await fetchEntities({ list: listKey });
console.log(`Found ${entities.length} entities in DB for list "${listKey}"`);

// Match HTML entries to DB entities and build update list
const updates = [];
const unmatched = [];

for (const [englishName, localName] of localNames) {
  // Try direct name match first, then fall back to derived-key comparison
  let entity = entities.find(e => e.name === englishName);
  if (!entity) {
    const derivedKey = toKey(englishName);
    entity = entities.find(e => e.key === derivedKey);
  }

  if (!entity) {
    unmatched.push(englishName);
    continue;
  }

  // Skip if already set correctly
  if (entity.reference === localName) continue;

  updates.push({ _id: entity._id, fields: { reference: localName } });
}

// Report unmatched
if (unmatched.length > 0) {
  console.warn(`\n⚠️  ${unmatched.length} HTML entries had no matching DB entity:`);
  unmatched.forEach(n => console.warn(`   - ${n}`));
}

console.log(`\n${updates.length} entities to update`);

if (updates.length === 0) {
  console.log("Nothing to do.");
  process.exit(0);
}

if (dryRun) {
  console.log("\n[DRY RUN] Would update:");
  for (const u of updates) {
    const e = entities.find(e => String(e._id) === String(u._id));
    console.log(`  ${e?.key ?? u._id}: reference = "${u.fields.reference}"`);
  }
  console.log("\n[DRY RUN] No changes written.");
  process.exit(0);
}

await bulkSetFields(updates);
console.log(`\n✅ Updated ${updates.length} entities with reference (local name).`);
