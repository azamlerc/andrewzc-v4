// commands/photos-set-dates.js
//
// For each visited entity on a list that lacks dateVisited, finds the earliest
// photo taken nearby in the local Photos MongoDB collection and sets dateVisited.
//
// Uses a backoff radius: 100m then 200m by default. Override with --radius.
//
// Usage:
//   node andrewzc.js photos set-dates <list> [--key <key>] [--radius <metres>] [--dryrun]

import { MongoClient } from "mongodb";
import { parseCoords } from "../utilities.js";

const LOCAL_URI = "mongodb://localhost:27017";

function buildRadii(maxRadius) {
  const steps = [100, 200, 500, 1000, 2000, 5000];
  return steps.filter(r => r <= maxRadius);
}

function photosLabel(images) {
  if (!images?.length) return "no photos";
  return `${images.length} photo${images.length === 1 ? "" : "s"}`;
}

async function findEarliestPhoto(photosCol, coords, RADII) {
  for (const radius of RADII) {
    const photo = await photosCol.findOne(
      {
        location: {
          $nearSphere: {
            $geometry: { type: "Point", coordinates: [coords.lon, coords.lat] },
            $maxDistance: radius,
          },
        },
      },
      { sort: { date: 1 } }
    );
    if (photo) return { photo, radius };
  }
  return null;
}

async function processEntity(entity, photosCol, entitiesCol, dryRun, RADII) {
  const photoInfo = photosLabel(entity.images);

  if (!entity.coords) {
    console.log(`  ⚠ No coords — skipping  [${photoInfo}]`);
    return "skipped";
  }

  const coords = parseCoords(entity.coords);
  if (!coords) {
    console.log(`  ⚠ Could not parse coords: ${entity.coords}  [${photoInfo}]`);
    return "skipped";
  }

  const result = await findEarliestPhoto(photosCol, coords, RADII);

  if (!result) {
    console.log(`  ✗ No photos found within ${RADII[RADII.length - 1]}m  [${photoInfo}]`);
    return "no-match";
  }

  const { photo, radius } = result;
  const dateVisited = photo.date.slice(0, 10);

  console.log(`  ✓ ${dateVisited} at ${radius}m  [${photoInfo}]`);

  if (!dryRun) {
    await entitiesCol.updateOne({ _id: entity._id }, { $set: { dateVisited } });
  }

  return "matched";
}

export async function run([list, ...rest], { dryRun }) {
  if (!list) {
    console.error("Usage: node andrewzc.js photos set-dates <list> [--key <key>] [--radius <metres>] [--dryrun]");
    process.exit(1);
  }

  const keyFlagIdx    = rest.indexOf("--key");
  const key           = keyFlagIdx !== -1 ? rest[keyFlagIdx + 1] : null;

  const radiusFlagIdx = rest.indexOf("--radius");
  const maxRadius     = radiusFlagIdx !== -1 ? parseInt(rest[radiusFlagIdx + 1], 10) : 200;
  const RADII         = buildRadii(maxRadius);

  const atlasClient = new MongoClient(process.env.MONGODB_URI);
  const localClient = new MongoClient(LOCAL_URI);

  try {
    await atlasClient.connect();
    await localClient.connect();

    const entitiesCol = atlasClient.db(process.env.MONGODB_DB || "andrewzc").collection("entities");
    const photosCol   = localClient.db("photos").collection("photos");

    if (dryRun) console.log("-- DRY RUN --\n");

    const filter = key
      ? { list, key, dateVisited: { $exists: false } }
      : { list, been: true, dateVisited: { $exists: false } };

    const totalVisited = await entitiesCol.countDocuments(key ? { list, key } : { list, been: true });
    const docs = await entitiesCol.find(filter).sort({ name: 1 }).toArray();
    const already = totalVisited - docs.length;

    console.log(`${list}: ${totalVisited} visited, ${already} already have dateVisited, processing ${docs.length}\n`);

    let matched = 0, noMatch = 0, skipped = 0;

    for (const entity of docs) {
      console.log(entity.name);
      const outcome = await processEntity(entity, photosCol, entitiesCol, dryRun, RADII);
      if (outcome === "matched")  matched++;
      if (outcome === "no-match") noMatch++;
      if (outcome === "skipped")  skipped++;
    }

    console.log(`\nMatched: ${matched}  No match: ${noMatch}  Skipped: ${skipped}`);
    if (dryRun) console.log("[DRY RUN] No changes written");

  } finally {
    await atlasClient.close();
    await localClient.close();
  }
}
