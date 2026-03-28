#!/usr/bin/env node
// tag-pages-by-reference.js
//
// Finds all pages that contain entities whose `reference` field matches a name
// from a given source list, then tags those pages with a specified tag.
//
// Usage:
//   node migrations/tag-pages-by-reference.js <source-list> <tag> [--dryrun]
//
// Examples:
//   node migrations/tag-pages-by-reference.js cities city-reference
//   node migrations/tag-pages-by-reference.js artists artist-reference --dryrun

import "dotenv/config";
import { MongoClient } from "mongodb";

const DRYRUN = process.argv.includes("--dryrun");
const [sourceList, tag] = process.argv.filter((a, i) => i >= 2 && !a.startsWith("--"));

if (!sourceList || !tag) {
  console.error("Usage: node migrations/tag-pages-by-reference.js <source-list> <tag> [--dryrun]");
  process.exit(1);
}

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "andrewzc";
if (!URI) throw new Error("Missing MONGODB_URI in environment");

const client = new MongoClient(URI);

async function main() {
  await client.connect();
  const db       = client.db(DB);
  const entities = db.collection("entities");
  const pages    = db.collection("pages");

  if (DRYRUN) console.log("-- DRY RUN --\n");

  // ── 1. Get all names from the source list ──────────────────────────────────

  const sourceDocs = await entities
    .find({ list: sourceList }, { projection: { name: 1 } })
    .toArray();

  const referenceNames = new Set(sourceDocs.map(d => d.name));
  console.log(`Loaded ${referenceNames.size} names from "${sourceList}"`);

  // ── 2. Find all distinct lists whose entities have a matching reference ─────

  const result = await entities.aggregate([
    { $match: { reference: { $in: [...referenceNames] } } },
    { $group: { _id: "$list", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]).toArray();

  console.log(`\nFound ${result.length} pages with entities referencing a "${sourceList}" name:\n`);

  const listKeys = result.map(r => r._id);
  for (const { _id: list, count } of result) {
    console.log(`  ${list} (${count} matching entities)`);
  }

  // ── 3. Check which pages already have the tag ──────────────────────────────

  const alreadyTagged = await pages
    .find({ key: { $in: listKeys }, tags: tag }, { projection: { key: 1 } })
    .toArray();
  const alreadyTaggedKeys = new Set(alreadyTagged.map(p => p.key));

  const toTag = listKeys.filter(k => !alreadyTaggedKeys.has(k));

  console.log(`\n${alreadyTaggedKeys.size} already have tag "${tag}", ${toTag.length} to update.`);

  if (toTag.length === 0) {
    console.log("Nothing to do.");
    await client.close();
    return;
  }

  // ── 4. Tag the pages ───────────────────────────────────────────────────────

  console.log(`\n${DRYRUN ? "[dry] " : ""}Adding tag "${tag}" to:`);
  for (const key of toTag) console.log(`  + ${key}`);

  if (!DRYRUN) {
    const updateResult = await pages.updateMany(
      { key: { $in: toTag } },
      { $addToSet: { tags: tag } }
    );
    console.log(`\nDone. Modified ${updateResult.modifiedCount} pages.`);
  } else {
    console.log(`\n[dry] Would modify ${toTag.length} pages.`);
  }

  await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
