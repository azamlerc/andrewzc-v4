// set-date-visited-from-photos.js
//
// For a given entity (or all visited entities on a page), finds the earliest
// photo taken nearby in the local MongoDB photo collection and sets dateVisited
// on the entity in Atlas.
//
// Uses a backoff radius strategy: tries 100m first, then 200m, then 500m.
// Reports which radius matched so you can judge confidence.
// Silently skips entities that already have dateVisited set.
//
// Single entity:  node migrations/set-date-visited-from-photos.js --page apple --key antara [--dryrun]
// Whole page:     node migrations/set-date-visited-from-photos.js --page apple [--dryrun]

import "dotenv/config";
import { MongoClient } from "mongodb";
import { parseCoords } from "../utilities.js";

const DRYRUN  = process.argv.includes("--dryrun");
const pageArg = process.argv.indexOf("--page");
const keyArg  = process.argv.indexOf("--key");

if (pageArg === -1) {
  console.error("Usage: node migrations/set-date-visited-from-photos.js --page <page> [--key <key>] [--dryrun]");
  process.exit(1);
}

const PAGE = process.argv[pageArg + 1];
const KEY  = keyArg !== -1 ? process.argv[keyArg + 1] : null;

const RADII = [100, 200, 500]; // metres, tried in order

const atlasClient = new MongoClient(process.env.MONGODB_URI);
const localClient = new MongoClient("mongodb://localhost:27017");

async function findEarliestPhoto(photos, coords) {
  for (const radius of RADII) {
    const photo = await photos.findOne(
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

function photosLabel(images) {
  if (!images?.length) return "no photos";
  return `${images.length} photo${images.length === 1 ? "" : "s"}`;
}

async function processEntity(entity, photos, entities) {
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

  const result = await findEarliestPhoto(photos, coords);

  if (!result) {
    console.log(`  ✗ No photos found within ${RADII[RADII.length - 1]}m  [${photoInfo}]`);
    return "no-match";
  }

  const { photo, radius } = result;
  const dateVisited = photo.date.slice(0, 10);

  console.log(`  ✓ ${dateVisited} at ${radius}m  [${photoInfo}]`);

  if (!DRYRUN) {
    await entities.updateOne({ _id: entity._id }, { $set: { dateVisited } });
  }

  return "matched";
}

async function main() {
  await atlasClient.connect();
  await localClient.connect();

  const entities = atlasClient.db(process.env.MONGODB_DB || "andrewzc").collection("entities");
  const photos   = localClient.db("photos").collection("photos");

  if (DRYRUN) console.log("-- DRY RUN --\n");

  // Build filter: single entity or all visited on page, excluding already-dated
  const filter = KEY
    ? { list: PAGE, key: KEY, dateVisited: { $exists: false } }
    : { list: PAGE, been: true, dateVisited: { $exists: false } };

  const totalVisited = KEY ? 1 : await entities.countDocuments({ list: PAGE, been: true });
  const docs = await entities.find(filter).sort({ name: 1 }).toArray();
  const already = totalVisited - docs.length;

  console.log(`${PAGE}: ${totalVisited} visited, ${already} already have dateVisited, processing ${docs.length}\n`);

  let matched = 0, noMatch = 0, skipped = 0;

  for (const entity of docs) {
    console.log(`${entity.name}`);
    const outcome = await processEntity(entity, photos, entities);
    if (outcome === "matched")  matched++;
    if (outcome === "no-match") noMatch++;
    if (outcome === "skipped")  skipped++;
  }

  console.log(`\nMatched: ${matched}  No match: ${noMatch}  Skipped: ${skipped}`);
  if (DRYRUN) console.log("[DRY RUN] No changes written");

  await atlasClient.close();
  await localClient.close();
}

main().catch(err => { console.error(err); process.exit(1); });
