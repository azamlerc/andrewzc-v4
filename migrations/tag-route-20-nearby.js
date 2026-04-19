// tag-route-20-nearby.js
//
// Finds all entities within 5km of any town on the route-20 page and tags
// them with "route-20-trip". Skips entities that are already tagged, and
// skips entities on the route-20 page itself (they're already tagged).
//
// Uses the location_2dsphere index for efficient geospatial queries.
//
// Run: node migrations/tag-route-20-nearby.js [--dryrun]

import "dotenv/config";
import { MongoClient } from "mongodb";

const DRYRUN   = process.argv.includes("--dryrun");
const TRIP_KEY = "route-20-trip";
const RADIUS_M = 5000; // 5 km

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "andrewzc";
if (!URI) throw new Error("Missing MONGODB_URI in environment");

const client = new MongoClient(URI);

async function main() {
  await client.connect();
  const entities = client.db(DB).collection("entities");

  if (DRYRUN) console.log("-- DRY RUN --\n");

  // 1. Fetch all route-20 towns that have a location
  const towns = await entities
    .find({ list: "route-20", location: { $exists: true } })
    .project({ key: 1, name: 1, location: 1 })
    .toArray();

  console.log(`Found ${towns.length} route-20 towns with coordinates\n`);

  // 2. For each town, find nearby entities on other lists not already tagged
  const taggedIds = new Set();   // avoid double-counting across towns
  const byList    = new Map();   // list -> [{ name, near, _id }, ...] for summary

  for (const town of towns) {
    const nearby = await entities.find({
      list:     { $ne: "route-20" },  // skip the route-20 page itself
      trips:    { $ne: TRIP_KEY },     // skip already tagged
      location: {
        $nearSphere: {
          $geometry:    town.location,
          $maxDistance: RADIUS_M,
        },
      },
    }).project({ _id: 1, key: 1, list: 1, name: 1 }).toArray();

    for (const e of nearby) {
      const id = e._id.toString();
      if (taggedIds.has(id)) continue;
      taggedIds.add(id);

      if (!byList.has(e.list)) byList.set(e.list, []);
      byList.get(e.list).push({ name: e.name, near: town.name, _id: e._id });
    }
  }

  console.log(`Found ${taggedIds.size} entities to tag across ${byList.size} lists\n`);

  // 3. Print summary grouped by list
  for (const [list, items] of [...byList.entries()].sort()) {
    console.log(`  ${list} (${items.length}):`);
    for (const { name, near } of items.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`    • ${name}  ← near ${near}`);
    }
  }

  // 4. Bulk update
  if (!DRYRUN && taggedIds.size > 0) {
    const ids = [...byList.values()].flat().map(e => e._id);
    const result = await entities.updateMany(
      { _id: { $in: ids } },
      { $addToSet: { trips: TRIP_KEY } }
    );
    console.log(`\nTagged ${result.modifiedCount} entities with "${TRIP_KEY}"`);
  } else if (DRYRUN) {
    console.log(`\n[DRY RUN] Would have tagged ${taggedIds.size} entities`);
  }

  console.log("\nDone.");
  await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
