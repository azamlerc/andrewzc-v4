// andrewzc enrich find-country <list> [--overwrite] [--dryrun]
//
// For each entity in a list that has a location but no country/countries,
// finds the nearest entity in the whole DB that has a country field and
// copies it over.
//
// This works because the DB has tens of thousands of geolocated entities
// spread across every country, so the nearest one is almost always in the
// same country. Accurate enough for airports, stations, etc.
//
// --overwrite: also replace existing country/countries values
// --dryrun:    print what would change without writing

import { MongoClient } from "mongodb";

export async function run([list], { dryRun, overwrite }) {
  if (!list) {
    console.error("Usage: andrewzc enrich find-country <list> [--overwrite] [--dryrun]");
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db       = client.db(process.env.MONGODB_DB || "andrewzc");
  const entities = db.collection("entities");

  if (dryRun)    console.log("-- DRY RUN --\n");
  if (overwrite) console.log("-- OVERWRITE MODE --\n");

  // Fetch entities that have a location but no country (or all, if --overwrite)
  const filter = overwrite
    ? { list, location: { $exists: true } }
    : { list, location: { $exists: true }, country: { $exists: false }, countries: { $exists: false } };

  const docs = await entities
    .find(filter, { projection: { _id: 1, key: 1, name: 1, location: 1 } })
    .toArray();

  console.log(`Found ${docs.length} entities in "${list}" to process.\n`);

  let updated = 0, notFound = 0;

  for (const doc of docs) {
    const [lon, lat] = doc.location.coordinates;

    // Find nearest entity with a country field, excluding the same list
    // to avoid circular lookups (e.g. don't match other entities in charleroi)
    const nearest = await entities.findOne(
      {
        list: { $ne: list },
        location: {
          $nearSphere: {
            $geometry: { type: "Point", coordinates: [lon, lat] },
            $maxDistance: 500_000, // 500km — wide enough to always find something
          }
        },
        country: { $exists: true },
      },
      { projection: { key: 1, list: 1, name: 1, country: 1 } }
    );

    if (!nearest) {
      console.warn(`  NOT FOUND: ${doc.key} (${lat}, ${lon})`);
      notFound++;
      continue;
    }

    const country = nearest.country;
    console.log(`  ${dryRun ? "[dry] " : ""}${doc.key} → country: "${country}" (from ${nearest.list}/${nearest.key})`);

    if (!dryRun) {
      await entities.updateOne(
        { _id: doc._id },
        { $set: { country }, $unset: { countries: "" } }
      );
    }
    updated++;
  }

  console.log(`\nDone. Updated: ${updated}, Not found: ${notFound}.`);
  await client.close();
}
