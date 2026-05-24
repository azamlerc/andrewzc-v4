#!/usr/bin/env node
// remove-mexico-city-flag.js
//
// The mexico-city page is getting the no-country tag, so the Mexican flag
// is redundant in the icons array of each entity. This migration removes
// the 🇲🇽 flag (first element) from the icons array, leaving just the
// station pictogram emoji.
//
// Usage:
//   node migrations/remove-mexico-city-flag.js [--dryrun]

import "dotenv/config";
import { MongoClient } from "mongodb";

const DRYRUN = process.argv.includes("--dryrun");
const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "andrewzc";
const MX_FLAG = "🇲🇽";

if (!URI) throw new Error("Missing MONGODB_URI in environment");

const client = new MongoClient(URI);

async function main() {
  await client.connect();
  const db = client.db(DB);
  const entities = db.collection("entities");

  const docs = await entities.find(
    { list: "mexico-city", icons: { $exists: true } },
    { projection: { key: 1, icons: 1 } }
  ).toArray();

  console.log(`Found ${docs.length} mexico-city entities with icons`);
  if (DRYRUN) console.log("-- DRY RUN --");

  let updated = 0;
  let skipped = 0;

  for (const doc of docs) {
    const [first, ...rest] = doc.icons;

    if (first !== MX_FLAG) {
      console.log(`  SKIP ${doc.key}: first icon is "${first}", not 🇲🇽`);
      skipped++;
      continue;
    }

    console.log(`  ${DRYRUN ? "[dry]" : "SET"} ${doc.key}: [${doc.icons.join(", ")}] → [${rest.join(", ")}]`);

    if (!DRYRUN) {
      await entities.updateOne(
        { _id: doc._id },
        { $set: { icons: rest } }
      );
    }
    updated++;
  }

  console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}.`);
  await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
