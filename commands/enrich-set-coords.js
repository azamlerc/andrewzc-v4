// andrewzc enrich set-coords <list> [--retry] [--test] [--dryrun]
// Fetch coords and location from Wikipedia/Booking/Airbnb links.
// --retry   Also attempt entities previously marked "not-found"
// --test    Report eligible entities by list; no writes
// --dryrun  Show what would be written without committing

import { MongoClient } from "mongodb";
import { getCoordsFromUrl } from "../../andrewzc-api/wiki.js";

const DELAY_MS = 500;

export async function run([list], { retry, testMode, dryRun }) {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db       = client.db(process.env.MONGODB_DB || "andrewzc");
  const entities = db.collection("entities");
  const pages    = db.collection("pages");

  // Build set of no-coords lists
  const noCoordsPages = await pages.find({ tags: "no-coords" }, { projection: { key: 1 } }).toArray();
  const noCoordsLists = new Set(noCoordsPages.map(p => p.key));

  const filter = retry
    ? { link: { $regex: "wikipedia\\.org|booking\\.com|airbnb\\.com" },
        $or: [{ coords: { $exists: false } }, { coords: "not-found" }] }
    : { link: { $regex: "wikipedia\\.org|booking\\.com|airbnb\\.com" }, coords: { $exists: false } };

  if (list) filter.list = list;

  const candidates = await entities.find(filter, {
    projection: { _id: 1, key: 1, list: 1, name: 1, link: 1 }
  }).toArray();

  const eligible = candidates.filter(e => !noCoordsLists.has(e.list));
  console.log(`Candidates: ${candidates.length}, eligible: ${eligible.length}\n`);

  if (testMode) {
    const counts = {};
    const keysByList = {};
    for (const e of eligible) {
      counts[e.list] = (counts[e.list] ?? 0) + 1;
      (keysByList[e.list] ??= []).push(e.key);
    }
    const sorted  = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const maxList = Math.max(...sorted.map(([l]) => l.length));
    const total   = sorted.reduce((s, [, n]) => s + n, 0);
    console.log("=== enrich set-coords --test ===\n");
    for (const [l, count] of sorted) {
      const suffix = count < 5 ? `  — ${keysByList[l].join(", ")}` : "";
      console.log(`  ${l.padEnd(maxList)}  ${String(count).padStart(4)}${suffix}`);
    }
    console.log(`\n  ${"TOTAL".padEnd(maxList)}  ${String(total).padStart(4)}`);
    await client.close();
    return;
  }

  let found = 0, notFound = 0, errors = 0;

  for (const entity of eligible) {
    const label = `${entity.list}/${entity.key}`;
    process.stdout.write(`${label} … `);

    let result = null;
    try {
      result = await getCoordsFromUrl(entity.link, { list: entity.list });
    } catch (err) {
      console.error(`\n  ❌ ${err.message}`);
      errors++;
      continue;
    }

    await new Promise(r => setTimeout(r, DELAY_MS));

    if (result) {
      console.log(`✅ ${result.coords}`);
      found++;
      if (!dryRun) {
        await entities.updateOne({ _id: entity._id }, { $set: { coords: result.coords, location: result.location } });
      }
    } else {
      console.log("❌ not found");
      notFound++;
      if (!dryRun) {
        await entities.updateOne({ _id: entity._id }, { $set: { coords: "not-found" } });
      }
    }
  }

  console.log(`\nEligible: ${eligible.length}  Found: ${found}  Not found: ${notFound}  Errors: ${errors}`);
  if (dryRun) console.log("[DRY RUN] No changes written.");
  await client.close();
}
