// commands/photos-suggest.js
//
// For each visited entity on a list that has no images in the DB, finds nearby
// photos in the local Photos library and offers to open them for review.
//
// On 'y': opens the earliest nearby photo in Apple Photos and the entity's
//         edit page in the browser. Press Enter when done to continue.
// On 'n': moves silently to the next entity.
// On 'q': quits. Resume with --start <key>.
//
// Usage:
//   node andrewzc.js photos suggest <list> [--start <key>] [--radius <metres>]

import { MongoClient } from "mongodb";
import { execSync } from "child_process";
import * as readline from "readline";
import { parseCoords } from "../utilities.js";

const LOCAL_URI   = "mongodb://localhost:27017";

function buildRadii(maxRadius) {
  const steps = [100, 200, 500, 1000, 2000, 5000];
  return steps.filter(r => r <= maxRadius);
}
const EDIT_BASE   = "http://localhost/andrewzc/edit.html";
const PHOTOS_LIBRARY = `${process.env.HOME}/Pictures/Photos Library.photoslibrary`;

async function findNearbyPhotos(photosCol, coords, maxRadius) {
  // Return count and earliest photo within maxRadius
  const RADII = buildRadii(maxRadius);
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
    if (photo) {
      // Count all photos within this radius
      const count = await photosCol.countDocuments({
        location: {
          $geoWithin: {
            $centerSphere: [[coords.lon, coords.lat], radius / 6378137],
          },
        },
      });
      return { photo, radius, count };
    }
  }
  return null;
}

function photoLibraryPath(uuid) {
  // Photos organises originals by first character of UUID
  const subdir = uuid[0].toUpperCase();
  return `${PHOTOS_LIBRARY}/originals/${subdir}/${uuid}.jpg`;
}

export async function run([list, ...rest], _opts) {
  if (!list) {
    console.error("Usage: node andrewzc.js photos suggest <list> [--start <key>] [--radius <metres>]");
    process.exit(1);
  }

  const startFlagIdx  = rest.indexOf("--start");
  const startKey      = startFlagIdx !== -1 ? rest[startFlagIdx + 1] : null;

  const radiusFlagIdx = rest.indexOf("--radius");
  const maxRadius     = radiusFlagIdx !== -1 ? parseInt(rest[radiusFlagIdx + 1], 10) : 200;
  const RADII         = buildRadii(maxRadius);

  if (RADII.length === 0) {
    console.error(`--radius ${maxRadius} is below minimum search radius of 100m`);
    process.exit(1);
  }

  const atlasClient = new MongoClient(process.env.MONGODB_URI);
  const localClient = new MongoClient(LOCAL_URI);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  try {
    await atlasClient.connect();
    await localClient.connect();

    const entitiesCol = atlasClient.db(process.env.MONGODB_DB || "andrewzc").collection("entities");
    const photosCol   = localClient.db("photos").collection("photos");

    // Visited entities with no images
    const docs = await entitiesCol
      .find({ list, been: true, $or: [{ images: { $exists: false } }, { images: { $size: 0 } }] })
      .sort({ name: 1 })
      .toArray();

    console.log(`${list}: ${docs.length} visited entities with no images\n`);

    // Optionally skip ahead
    let startIndex = 0;
    if (startKey) {
      const idx = docs.findIndex(e => e.key === startKey);
      if (idx === -1) {
        console.warn(`--start key "${startKey}" not found, starting from beginning.`);
      } else {
        startIndex = idx;
        console.log(`Resuming from "${startKey}" (${startIndex + 1}/${docs.length}).\n`);
      }
    }

    let reviewed = 0, skipped = 0;

    for (let i = startIndex; i < docs.length; i++) {
      const entity = docs[i];

      if (!entity.coords) continue;
      const coords = parseCoords(entity.coords);
      if (!coords) continue;

      const result = await findNearbyPhotos(photosCol, coords, 200);
      if (!result) continue; // no nearby photos, move on silently

      const { photo, radius, count } = result;
      const dateStr = photo.date.slice(0, 10);

      console.log(`\n[${i + 1}/${docs.length}] ${entity.name}`);
      console.log(`  ${count} photo${count === 1 ? "" : "s"} nearby (within ${radius}m), earliest: ${dateStr}`);

      const answer = (await ask("  Review? [y/n/q] ")).trim().toLowerCase();

      if (answer === "q") {
        console.log(`\nQuitting. Resume with --start ${entity.key}`);
        break;
      } else if (answer === "y") {
        const editUrl = `${EDIT_BASE}?list=${encodeURIComponent(list)}&key=${encodeURIComponent(entity.key)}`;
        // Open edit page first, then Photos on top
        execSync(`open "${editUrl}"`);
        try {
          execSync(`osxphotos show ${photo.uuid}`, { stdio: "ignore" });
        } catch {
          // osxphotos show may exit non-zero; that's fine, Photos still opens
        }
        reviewed++;
      } else {
        skipped++;
      }
    }

    console.log(`\nDone. Reviewed: ${reviewed}, Skipped: ${skipped}.`);

  } finally {
    rl.close();
    await atlasClient.close();
    await localClient.close();
  }
}
