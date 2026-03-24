#!/usr/bin/env node
// import-roadtrips.js
//
// Imports a roadtrip JSON file from andrewzc.net/data/<key>.json.
// - Ensures a page record exists for the trip (with tag "roadtrip")
// - For each entity in the JSON, finds the matching entity in the DB by name
//   (and disambiguates by last icon when multiple matches exist)
// - Adds the trip key to a `trips` array on each matched entity
// - Writes status back to the JSON file: "added", "ambiguous", "not found"
//   Entries already marked "added" are skipped on subsequent runs.
//
// Disambiguation rules (applied in order):
//   1. Candidates on the trip's own page (list === tripKey) are legacy
//      duplicates — deleted and removed from the pool.
//   2. Candidates on the "places" list are never the right choice (places is
//      just a visited-cities map, not a specific destination type) — removed
//      from the pool silently. If this leaves exactly one candidate, use it.
//   3. Match the last icon in the entry's icons array against the page icon
//      of each remaining candidate's list.
//
// Usage:
//   node migrations/import-roadtrips.js <key> [--dryrun]
//
// Example:
//   node migrations/import-roadtrips.js europe-2022
//   node migrations/import-roadtrips.js europe-2022 --dryrun

import "dotenv/config";
import { MongoClient } from "mongodb";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const DRYRUN  = process.argv.includes("--dryrun");
const tripKey = process.argv.find((a, i) => i >= 2 && !a.startsWith("-"));
const DATA_DIR = "/Users/andrewzc/Projects/andrewzc.net/data";

if (!tripKey) {
  console.error("Usage: node migrations/import-roadtrips.js <key> [--dryrun]");
  process.exit(1);
}

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "andrewzc";
if (!URI) throw new Error("Missing MONGODB_URI in environment");

// ── Emoji normalisation ───────────────────────────────────────────────────────
// Strip VS-16 (U+FE0F) variation selectors so "🏝️" and "🏝" compare equal.

const normalizeIcon = (s) => s?.replace(/\uFE0F/g, "") ?? "";

// ── Load JSON ─────────────────────────────────────────────────────────────────

const jsonPath = join(DATA_DIR, `${tripKey}.json`);
if (!existsSync(jsonPath)) {
  console.error(`File not found: ${jsonPath}`);
  process.exit(1);
}

const raw = JSON.parse(readFileSync(jsonPath, "utf8"));
const info = raw["--info--"];
if (!info) {
  console.error(`JSON file is missing "--info--" key`);
  process.exit(1);
}

// All entries except --info--
const entries = Object.entries(raw).filter(([k]) => k !== "--info--");

// ── Main ─────────────────────────────────────────────────────────────────────

const client = new MongoClient(URI);

async function main() {
  await client.connect();
  const db = client.db(DB);
  const pages    = db.collection("pages");
  const entities = db.collection("entities");

  if (DRYRUN) console.log("-- DRY RUN --\n");

  // ── 1. Ensure page record ──────────────────────────────────────────────────

  const existingPage = await pages.findOne({ key: tripKey });

  if (existingPage) {
    const hasTripTag = (existingPage.tags || []).includes("roadtrip");
    if (!hasTripTag) {
      console.log(`Page "${tripKey}" exists — adding "roadtrip" tag`);
      if (!DRYRUN) await pages.updateOne({ key: tripKey }, { $addToSet: { tags: "roadtrip" } });
    } else {
      console.log(`Page "${tripKey}" already exists with "roadtrip" tag ✓`);
    }
  } else {
    const newPage = {
      key:  tripKey,
      name: info.name,
      icon: info.icon,
      type: info.type || "place",
      tags: ["roadtrip"],
      ...(info.size && { size: info.size }),
    };
    console.log(`Creating page: ${JSON.stringify(newPage)}`);
    if (!DRYRUN) await pages.insertOne(newPage);
  }

  // ── 2. Build page icon lookup: normalised icon -> list key(s) ─────────────

  const allPages = await pages.find({}, { projection: { key: 1, icon: 1 } }).toArray();
  // Map normalised icon string -> Set of list keys (multiple pages can share an icon)
  const iconToLists = new Map();
  for (const p of allPages) {
    const norm = normalizeIcon(p.icon);
    if (!iconToLists.has(norm)) iconToLists.set(norm, new Set());
    iconToLists.get(norm).add(p.key);
  }

  // ── 3. Process each entry ──────────────────────────────────────────────────

  // Count how many are skipped (already "added")
  const alreadyAdded = entries.filter(([, e]) => e.status === "added").length;
  const toProcess    = entries.filter(([, e]) => e.status !== "added");

  console.log(`\n${entries.length} entries total — ${alreadyAdded} already added, processing ${toProcess.length}...\n`);

  // Summary tracking
  const updated   = new Map(); // list -> [name, ...]
  const notFound  = [];
  const ambiguous = [];
  const deleted   = [];        // legacy duplicate entities removed

  for (const [entryKey, entry] of toProcess) {
    const { name, icons = [] } = entry;
    if (!name) continue;

    let candidates = await entities.find(
      { name },
      { projection: { _id: 1, key: 1, list: 1, icons: 1 } }
    ).toArray();

    // ── Rule 1: Delete legacy duplicates living on the trip page itself ───────
    const duplicates = candidates.filter(c => c.list === tripKey);
    if (duplicates.length > 0) {
      for (const dup of duplicates) {
        console.log(`  ${DRYRUN ? "[dry] " : ""}DELETE legacy duplicate: ${tripKey}/${dup.key} ("${name}")`);
        deleted.push(`${tripKey}/${dup.key}`);
        if (!DRYRUN) {
          await entities.deleteOne({ _id: dup._id });
        }
      }
      candidates = candidates.filter(c => c.list !== tripKey);
    }

    // ── Rule 2: Remove "places" candidates — never the right choice ───────────
    const withoutPlaces = candidates.filter(c => c.list !== "places");
    if (withoutPlaces.length < candidates.length) {
      candidates = withoutPlaces;
    }

    let match = null;

    if (candidates.length === 0) {
      notFound.push({ key: entryKey, name, icons });
      raw[entryKey] = { ...entry, status: "not found" };
      continue;
    }

    if (candidates.length === 1) {
      match = candidates[0];
    } else {
      // ── Rule 3: Match last icon against page icon ─────────────────────────
      const lastIcon = normalizeIcon(icons[icons.length - 1] ?? "");
      if (lastIcon) {
        const matchingLists = iconToLists.get(lastIcon) ?? new Set();
        const byPageIcon = candidates.filter(c => matchingLists.has(c.list));

        if (byPageIcon.length === 1) {
          match = byPageIcon[0];
        } else {
          const cands = (byPageIcon.length > 1 ? byPageIcon : candidates)
            .map(c => `${c.list}/${c.key}`);
          ambiguous.push({ key: entryKey, name, icons, candidates: cands });
          raw[entryKey] = { ...entry, status: "ambiguous" };
          continue;
        }
      } else {
        ambiguous.push({ key: entryKey, name, icons, candidates: candidates.map(c => `${c.list}/${c.key}`) });
        raw[entryKey] = { ...entry, status: "ambiguous" };
        continue;
      }
    }

    // Add trip to entity's trips array
    if (!DRYRUN) {
      await entities.updateOne(
        { _id: match._id },
        { $addToSet: { trips: tripKey } }
      );
    }

    const list = match.list;
    if (!updated.has(list)) updated.set(list, []);
    updated.get(list).push(name);

    raw[entryKey] = { ...entry, status: "added" };

    if (DRYRUN) {
      console.log(`  [dry] ${list}/${match.key} → trips += "${tripKey}"`);
    }
  }

  // ── 4. Write status back to JSON (unless dry run) ─────────────────────────

  if (!DRYRUN) {
    writeFileSync(jsonPath, JSON.stringify(raw, null, 2), "utf8");
    console.log(`\nWrote status back to ${jsonPath}`);
  }

  // ── 5. Summary ─────────────────────────────────────────────────────────────

  if (deleted.length > 0) {
    console.log(`\n── Deleted legacy duplicates (${deleted.length}) ────────────────────`);
    for (const d of deleted) console.log(`  ✗ ${d}`);
  }

  console.log("\n── Updated ──────────────────────────────────────────────────");
  let totalUpdated = 0;
  for (const [list, names] of [...updated.entries()].sort()) {
    console.log(`\n  ${list} (${names.length}):`);
    for (const n of names.sort()) console.log(`    • ${n}`);
    totalUpdated += names.length;
  }
  console.log(`\n  Total: ${totalUpdated} entities updated`);

  if (ambiguous.length > 0) {
    console.log("\n── Ambiguous (multiple matches) ─────────────────────────────");
    for (const { key: k, name: n, icons: ic, candidates: cands } of ambiguous) {
      console.log(`  ${k} "${n}" [${ic.join(" ")}]`);
      for (const c of cands) console.log(`    ? ${c}`);
    }
  }

  if (notFound.length > 0) {
    console.log("\n── Not found ────────────────────────────────────────────────");
    for (const { key: k, name: n, icons: ic } of notFound) {
      console.log(`  ${k} "${n}" [${ic.join(" ")}]`);
    }
  }

  // ── 6. Check if trip page is now empty ────────────────────────────────────

  const remaining = await entities.countDocuments({ list: tripKey });
  if (remaining === 0) {
    console.log(`\n✓ No entities remain on page "${tripKey}" — safe to delete the page.`);
  } else {
    console.log(`\n⚠ ${remaining} entities still remain on page "${tripKey}".`);
  }

  console.log(`\nDone. Updated: ${totalUpdated}, Deleted: ${deleted.length}, Ambiguous: ${ambiguous.length}, Not found: ${notFound.length}, Skipped (already added): ${alreadyAdded}`);
  await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
