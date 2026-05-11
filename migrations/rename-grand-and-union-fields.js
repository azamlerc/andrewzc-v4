#!/usr/bin/env node
// rename-grand-and-union-fields.js
//
// For entities on the grand-and-union list:
//   - Move `name` → `caption`  (the intersection address, e.g. "Grand St & Union Ave")
//   - Move `reference` → `name` (the city/state label, e.g. "Brooklyn, NY")
//   - Remove `reference`
//
// Usage:
//   node migrations/rename-grand-and-union-fields.js [--dryrun]

import "dotenv/config";
import { MongoClient } from "mongodb";

const DRYRUN = process.argv.includes("--dryrun");
const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "andrewzc";

if (!URI) throw new Error("Missing MONGODB_URI in environment");

const client = new MongoClient(URI);

async function main() {
  await client.connect();
  const db = client.db(DB);
  const entities = db.collection("entities");

  const docs = await entities.find(
    { list: "grand-and-union" },
    { projection: { key: 1, name: 1, reference: 1 } }
  ).toArray();

  console.log(`Found ${docs.length} grand-and-union entities`);
  if (DRYRUN) console.log("-- DRY RUN --");

  for (const doc of docs) {
    console.log(`  ${DRYRUN ? "[dry]" : "SET"} ${doc.key}:`);
    console.log(`    caption: "${doc.name}"`);
    console.log(`    name:    "${doc.reference}"`);

    if (!DRYRUN) {
      await entities.updateOne(
        { _id: doc._id },
        {
          $set: { caption: doc.name, name: doc.reference },
          $unset: { reference: "" }
        }
      );
    }
  }

  console.log(`\nDone. Updated ${docs.length} entities.`);
  await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
