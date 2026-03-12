#!/usr/bin/env node
// copy-group-from-twin-stations.js
//
// For stations that have props.twin-stations but are missing the top-level
// group field, find the corresponding entity in the twin-stations list
// (matched by name + reference) and copy the group value over.
//
// Usage:
//   node migrations/copy-group-from-twin-stations.js [--dryrun]

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

  // Fetch all stations with twin-stations prop but no group
  const stationsMissingGroup = await entities.find(
    { list: "stations", "props.twin-stations": { $exists: true }, group: { $exists: false } },
    { projection: { key: 1, name: 1, reference: 1 } }
  ).toArray();

  console.log(`Found ${stationsMissingGroup.length} stations missing group`);
  if (DRYRUN) console.log("-- DRY RUN --");

  // Build a lookup map from twin-stations: "name|reference" -> group
  const twinEntities = await entities.find(
    { list: "twin-stations", group: { $exists: true } },
    { projection: { name: 1, reference: 1, group: 1 } }
  ).toArray();

  const twinMap = new Map();
  for (const e of twinEntities) {
    const k = `${e.name}|${e.reference}`;
    twinMap.set(k, e.group);
  }

  console.log(`Loaded ${twinMap.size} twin-stations entries with group`);

  let matched = 0;
  let unmatched = 0;

  for (const station of stationsMissingGroup) {
    const lookupKey = `${station.name}|${station.reference}`;
    const group = twinMap.get(lookupKey);

    if (!group) {
      console.warn(`  UNMATCHED: ${station.key} (name="${station.name}", reference="${station.reference}")`);
      unmatched++;
      continue;
    }

    console.log(`  ${DRYRUN ? "[dry]" : "SET"} ${station.key} → group: "${group}"`);
    matched++;

    if (!DRYRUN) {
      await entities.updateOne(
        { _id: station._id },
        { $set: { group } }
      );
    }
  }

  console.log(`\nDone. Matched: ${matched}, Unmatched: ${unmatched}`);
  await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
