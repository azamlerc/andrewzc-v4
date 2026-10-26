// andrewzc enrich run <list>
// Run the full enrichment cascade: link → location → city → reference.
// Each step only runs if its prerequisite is present and the target is absent.
// On Wikipedia rate limit, skips remaining Wikipedia steps but continues city/reference.

import { MongoClient } from "mongodb";
import { formatLocation } from "../../andrewzc-api/location.js";
import { findNearestCity } from "../utilities.js";
import { getLocationFromUrl } from "../../andrewzc-api/wiki.js";

const DELAY_MS = 2_000; // pause between Wikipedia requests to avoid rate limiting

const delay = () => new Promise(r => setTimeout(r, DELAY_MS));

async function searchWikipediaLink(name) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&format=json&origin=*`;
  const res = await fetch(url);
  if (res.status === 429) throw Object.assign(new Error("Rate limited"), { rateLimited: true });
  if (!res.ok) return null;
  const body = await res.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    const contentType = res.headers.get("content-type") ?? "unknown content type";
    console.warn(`  Invalid JSON response (${contentType}) for Wikipedia search: ${name}`);
    return null;
  }
  const title = json?.query?.search?.[0]?.title;
  if (!title) return null;
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

export async function run([list], _opts) {
  if (!list) {
    console.error("Usage: andrewzc enrich run <list>");
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db  = client.db(process.env.MONGODB_DB || "andrewzc");
  const col = db.collection("entities");

  const page = await db.collection("pages").findOne({ key: list }, { projection: { tags: 1 } });
  const tags = page?.tags ?? [];

  const skipLocation     = tags.includes("no-coords") || tags.includes("people");
  const needsReference = tags.includes("reference") || tags.includes("reference-optional");

  // Find entities missing any enrichable field
  const missingConditions = [{ link: { $exists: false } }];
  if (!skipLocation) {
    missingConditions.push({ location: null }, { city: { $exists: false } });
  }
  if (needsReference) missingConditions.push({ reference: { $exists: false } });

  const entities = await col.find(
    { list, $or: missingConditions },
    { projection: { key: 1, name: 1, link: 1, location: 1, city: 1, reference: 1 } }
  ).toArray();

  console.log(`Enriching ${entities.length} entities in "${list}"...\n`);

  let enriched    = 0;
  let wikiBlocked = false;

  for (const entity of entities) {
    const update = {};
    let madeWikiRequest = false;

    // 1. Link
    if (!wikiBlocked && !entity.link) {
      try {
        const found = await searchWikipediaLink(entity.name);
        if (found) { update.link = found; console.log(`  🔍 ${entity.name}: ${found}`); }
        madeWikiRequest = true;
      } catch (err) {
        if (err.rateLimited) {
          console.warn("  🚫 Rate limited — skipping Wikipedia for this run.");
          wikiBlocked = true;
        } else throw err;
      }
    }

    const link = update.link ?? entity.link;

    // 2. Location — delay first if we already made a link request this iteration
    if (!wikiBlocked && !skipLocation && !entity.location && link && /wikipedia\.org|booking\.com|airbnb\.com/.test(link)) {
      if (madeWikiRequest) await delay();
      try {
        const result = await getLocationFromUrl(link, { list });
        if (result) {
          update.location = result.location;
          console.log(`  📍 ${entity.name}: ${formatLocation(result.location)}`);
        } else {
          console.log(`  ⚠️  ${entity.name}: location not found`);
        }
        madeWikiRequest = true;
      } catch (err) {
        if (err.rateLimited) {
          console.warn("  🚫 Rate limited — skipping Wikipedia for this run.");
          wikiBlocked = true;
        } else throw err;
      }
    }

    // 3. City
    const location = update.location ?? entity.location;
    if (!skipLocation && location && !entity.city) {
      const city = await findNearestCity(location, col);
      if (city) { update.city = city; console.log(`  🏙️  ${entity.name}: city = ${city}`); }
    }

    // 4. Reference
    const city = update.city ?? entity.city;
    if (needsReference && !entity.reference && city) {
      update.reference = city;
      console.log(`  📎 ${entity.name}: reference = ${city}`);
    }

    if (Object.keys(update).length > 0) {
      await col.updateOne({ _id: entity._id }, { $set: update });
      enriched++;
    }

    // Pause between entities if any Wikipedia requests were made
    if (madeWikiRequest && !wikiBlocked) await delay();
  }

  console.log(`\nDone. Enriched ${enriched}/${entities.length} entities.`);
  await client.close();
}
