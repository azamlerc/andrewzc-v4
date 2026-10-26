// andrewzc location backfill [list] [--dryrun]
// Convert stored coordinates only: no geocoding, enrichment, or coords deletion.
import { MongoClient } from "mongodb";
import { parseCoords } from "../utilities.js";

export function locationFromCoords(value) {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(",");
  if (parts.length !== 2) return null;
  // Guard the shared parser against misplaced/duplicated hemisphere letters
  // and malformed numbers. Accept decimals and DMS with an optional suffix.
  const number = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
  const dms = "-?\\d+(?:\\.\\d+)?°(?:\\d+(?:\\.\\d+)?['′])?(?:\\d+(?:\\.\\d+)?[\"″])?";
  if (!parts.every((part, i) => new RegExp(`^(?:${number}|${dms})\\s*[${i === 0 ? "NS" : "EW"}]?$`, "i").test(part.trim()))) return null;
  const parsed = parseCoords(value);
  if (!parsed || !Number.isFinite(parsed.lat) || !Number.isFinite(parsed.lon)
      || Math.abs(parsed.lat) > 90 || Math.abs(parsed.lon) > 180) return null;
  return { type: "Point", coordinates: [parsed.lon, parsed.lat] };
}

export async function backfillLocations(col, { list, dryRun = false, log = console.log } = {}) {
  // null matches both absent and explicitly null locations. Other existing
  // values are preserved, including non-Point geometries.
  const filter = { location: null, coords: { $exists: true }, ...(list ? { list } : {}) };
  const cursor = col.find(filter, { projection: { _id: 1, list: 1, key: 1, coords: 1 } });
  const stats = { examined: 0, candidates: 0, updated: 0, unknown: 0, invalid: 0 };
  let batch = [];
  async function flush() {
    if (!batch.length) return;
    const result = await col.bulkWrite(batch, { ordered: false });
    stats.updated += result.modifiedCount;
    batch = [];
  }
  for await (const doc of cursor) {
    stats.examined++;
    if (doc.coords == null || (typeof doc.coords === "string"
        && ["", "not-found", "unknown"].includes(doc.coords.trim().toLowerCase()))) {
      stats.unknown++;
      continue;
    }
    const location = locationFromCoords(doc.coords);
    if (!location) {
      stats.invalid++;
      log(`Invalid coords: ${doc.list}/${doc.key || doc._id}: ${JSON.stringify(doc.coords)}`);
      continue;
    }
    stats.candidates++;
    if (!dryRun) {
      batch.push({ updateOne: {
        filter: { _id: doc._id, location: null, coords: doc.coords },
        update: { $set: { location } },
      } });
      if (batch.length === 500) await flush();
    }
  }
  if (!dryRun) await flush();
  log(`${dryRun ? "Dry run" : "Backfill"} (${list || "whole database"}): ${JSON.stringify(stats)}`);
  if (!dryRun && stats.updated < stats.candidates) log("Some candidates changed concurrently; rerun to verify.");
  return stats;
}

export async function run(args, { dryRun = false, testMode = false } = {}) {
  const positional = args.filter(arg => !arg.startsWith("--"));
  if (positional.length > 1 || args.some(arg => arg.startsWith("--") && !["--dryrun", "--test"].includes(arg))) {
    throw new Error("Usage: andrewzc location backfill [list] [--dryrun]");
  }
  if (!process.env.MONGODB_URI) throw new Error("Missing MONGODB_URI in environment");
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const col = client.db(process.env.MONGODB_DB || "andrewzc").collection("entities");
    return await backfillLocations(col, { list: positional[0], dryRun: dryRun || testMode });
  } finally {
    await client.close();
  }
}
