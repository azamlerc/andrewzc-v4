#!/usr/bin/env node
// dedup-list.js
//
// Interactively finds and merges near-duplicate entities in a list.
// Two entities are considered potential duplicates if their coordinates
// are within --radius metres of each other (default: 2000m).
//
// For each duplicate pair it shows both entities and asks:
//   1 — keep entity 1's name/key, merge data from entity 2, delete entity 2
//   2 — keep entity 2's name/key, merge data from entity 1, delete entity 1
//   s — skip this pair
//   q — quit
//
// Merging behaviour:
//   - been: true if either entity has been: true
//   - All other fields: winner's value takes precedence; missing fields
//     filled from the loser
//   - The losing entity is deleted

import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import * as readline from "readline";

const DRYRUN = process.argv.includes("--dryrun");
const args   = process.argv.slice(2).filter(a => !a.startsWith("--"));

const radiusIdx = process.argv.indexOf("--radius");
const RADIUS_M  = radiusIdx !== -1 ? parseInt(process.argv[radiusIdx + 1], 10) : 2000;

const [list] = args;

if (!list) {
  console.error("Usage: node migrations/dedup-list.js <list> [--radius <metres>] [--dryrun]");
  process.exit(1);
}

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "andrewzc";
if (!URI) throw new Error("Missing MONGODB_URI in environment");

const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(resolve => rl.question(q, resolve));

// ── Haversine distance in metres ──────────────────────────────────────────────

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function parseCoords(entity) {
  if (entity.location?.coordinates) {
    const [lon, lat] = entity.location.coordinates;
    return { lat, lon };
  }
  if (entity.coords) {
    const [lat, lon] = entity.coords.split(",").map(Number);
    if (!isNaN(lat) && !isNaN(lon)) return { lat, lon };
  }
  return null;
}

// ── Merge two entities into the winner ───────────────────────────────────────

function mergeEntities(winner, loser) {
  const merged = { ...winner };

  // been: true if either has been
  merged.been = winner.been === true || loser.been === true;

  // Fill missing fields from loser (winner's values take precedence)
  for (const [k, v] of Object.entries(loser)) {
    if (["_id", "key", "list", "name"].includes(k)) continue;
    if (merged[k] == null && v != null) merged[k] = v;
  }

  return merged;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const client = new MongoClient(URI);
await client.connect();
const col = client.db(DB).collection("entities");

if (DRYRUN) console.log("-- DRY RUN --\n");

// Fetch all entities in the list that have coordinates
const all = await col
  .find({ list }, { projection: { _id: 1, key: 1, name: 1, been: 1, link: 1, city: 1, address: 1, zip: 1, coords: 1, location: 1 } })
  .toArray();

console.log(`Loaded ${all.length} entities from "${list}" with coordinates`);
console.log(`Finding pairs within ${RADIUS_M}m of each other...\n`);

// Find all pairs within radius
const pairs = [];
const seen  = new Set();

for (let i = 0; i < all.length; i++) {
  const a = all[i];
  const ac = parseCoords(a);
  if (!ac) continue;

  for (let j = i + 1; j < all.length; j++) {
    const b = all[j];
    const pairKey = [a._id, b._id].map(String).sort().join("|");
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    const bc = parseCoords(b);
    if (!bc) continue;

    const dist = haversine(ac.lat, ac.lon, bc.lat, bc.lon);
    if (dist <= RADIUS_M) {
      pairs.push({ a, b, dist: Math.round(dist) });
    }
  }
}

console.log(`Found ${pairs.length} potential duplicate pair(s).\n`);

if (pairs.length === 0) {
  rl.close();
  await client.close();
  process.exit(0);
}

// Sort by distance ascending
pairs.sort((x, y) => x.dist - y.dist);

let merged = 0, skipped = 0;

for (let i = 0; i < pairs.length; i++) {
  const { a, b, dist } = pairs[i];

  // Check both still exist (might have been merged earlier)
  const aExists = await col.findOne({ _id: a._id }, { projection: { _id: 1 } });
  const bExists = await col.findOne({ _id: b._id }, { projection: { _id: 1 } });
  if (!aExists || !bExists) continue;

  console.log(`\n[${i + 1}/${pairs.length}] ${dist}m apart:`);
  console.log(`  1: ${a.name} (${a.key})`);
  if (a.city) console.log(`     ${a.city}${a.address ? ", " + a.address : ""}${a.link ? " — " + a.link : ""}`);
  console.log(`     been: ${a.been ?? false}`);
  console.log(`  2: ${b.name} (${b.key})`);
  if (b.city) console.log(`     ${b.city}${b.address ? ", " + b.address : ""}${b.link ? " — " + b.link : ""}`);
  console.log(`     been: ${b.been ?? false}`);

  const answer = (await ask("  Keep which? [1/2/s/q] ")).trim().toLowerCase();

  if (answer === "q") {
    console.log("\nQuitting.");
    break;
  }

  if (answer !== "1" && answer !== "2") {
    console.log("  Skipped.");
    skipped++;
    continue;
  }

  const winner = answer === "1" ? a : b;
  const loser  = answer === "1" ? b : a;
  const mergedDoc = mergeEntities(winner, loser);

  console.log(`  Keeping: "${winner.name}" — deleting: "${loser.name}"`);
  if (mergedDoc.been) console.log(`  → been: true (from ${loser.been ? "both" : "winner"})`);

  if (!DRYRUN) {
    await col.replaceOne({ _id: winner._id }, { ...mergedDoc, _id: winner._id });
    await col.deleteOne({ _id: loser._id });
  }

  merged++;
}

rl.close();
console.log(`\nDone. Merged: ${merged}, Skipped: ${skipped}.`);
await client.close();
