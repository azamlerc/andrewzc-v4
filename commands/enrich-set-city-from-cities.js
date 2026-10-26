// andrewzc enrich set-city-from-cities [city-key] [--dryrun]
import { MongoClient } from "mongodb";
import { CITY_RADIUS_KM } from "../utilities.js";

const EXCLUDED_TARGET_LISTS = ["places", "all-cities", "cities"];

export function validCity(city) {
  const coords = city.location?.coordinates;
  return typeof city.name === "string" && city.name.trim().length > 0
    && city.location?.type === "Point" && Array.isArray(coords) && coords.length === 2
    && coords.every(Number.isFinite)
    && Math.abs(coords[0]) <= 180 && Math.abs(coords[1]) <= 90;
}

// Resolve overlaps before writing, so city iteration order cannot claim a nearer
// city's entities. In single-city mode only that city's radius participates.
export async function assignCities(col, cities, { dryRun = false, log = console.log } = {}) {
  const assignments = new Map();
  let skipped = 0;
  for (const city of cities) {
    if (!validCity(city)) {
      log(`Skipping ${city.key}: missing name or valid Point location.`);
      skipped++;
      continue;
    }
    let matches = 0;
    const cursor = col.aggregate([
      { $geoNear: {
        near: city.location,
        key: "location",
        distanceField: "cityDistanceMeters",
        maxDistance: CITY_RADIUS_KM * 1000,
        spherical: true,
        query: { city: { $exists: false }, list: { $nin: EXCLUDED_TARGET_LISTS } },
      } },
      { $project: { _id: 1, key: 1, list: 1, name: 1, location: 1, cityDistanceMeters: 1 } },
    ]);
    for await (const entity of cursor) {
      matches++;
      const id = String(entity._id);
      const previous = assignments.get(id);
      const distance = entity.cityDistanceMeters;
      if (!previous || distance < previous.distance
          || (distance === previous.distance && city.key < previous.cityKey)) {
        assignments.set(id, { entity, city: city.name, cityKey: city.key, distance });
      }
    }
    log(`${city.name}: ${matches} entities within ${CITY_RADIUS_KM} km without city.`);
  }

  let updated = 0;
  let batch = [];
  async function flush() {
    if (!batch.length) return;
    const result = await col.bulkWrite(batch, { ordered: false });
    updated += result.modifiedCount;
    batch = [];
  }
  for (const { entity, city, distance } of assignments.values()) {
    log(`${dryRun ? "Would set" : "Set candidate"} ${entity.list}/${entity.key}: ${city} (${(distance / 1000).toFixed(2)} km)`);
    if (!dryRun) {
      batch.push({ updateOne: {
        // Preserve concurrent city/location edits and recheck target exclusions.
        filter: { _id: entity._id, city: { $exists: false }, location: entity.location,
          list: { $nin: EXCLUDED_TARGET_LISTS } },
        update: { $set: { city } },
      } });
      if (batch.length === 500) await flush();
    }
  }
  if (!dryRun) await flush();
  const stats = { candidates: assignments.size, updated, skipped };
  log(dryRun
    ? `Dry run: would update ${stats.candidates} entities; skipped ${skipped} cities.`
    : `Updated ${updated}/${stats.candidates} entities; skipped ${skipped} cities. Unmatched candidates were changed concurrently.`);
  return stats;
}

export async function run(args, { dryRun = false, testMode = false } = {}) {
  const positional = args.filter(arg => !arg.startsWith("--"));
  const unknown = args.filter(arg => arg.startsWith("--") && !["--dryrun", "--test"].includes(arg));
  if (positional.length > 1 || unknown.length) {
    throw new Error("Usage: andrewzc enrich set-city-from-cities [city-key] [--dryrun]");
  }
  const [cityKey] = positional;
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const col = client.db(process.env.MONGODB_DB || "andrewzc").collection("entities");
    const cities = await col.find(
      { list: "cities", ...(cityKey ? { key: cityKey } : {}) },
      { projection: { _id: 1, key: 1, name: 1, location: 1 } },
    ).sort({ key: 1 }).toArray();
    if (cityKey && !cities.length) throw new Error(`No city with key "${cityKey}" in cities.`);
    if (cityKey && !validCity(cities[0])) throw new Error(`City "${cityKey}" has no valid name or Point location.`);
    return await assignCities(col, cities, { dryRun: dryRun || testMode });
  } finally {
    await client.close();
  }
}
