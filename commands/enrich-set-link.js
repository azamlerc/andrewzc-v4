// andrewzc enrich set-link <list>
// Search Wikipedia by entity name and set the link field.
// Skips pages tagged "people". Stops gracefully on rate limit.

import { MongoClient } from "mongodb";

const DELAY_MS = 1_000;

async function searchWikipediaLink(name) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&format=json&origin=*`;
  const res = await fetch(url);
  if (res.status === 429) throw Object.assign(new Error("Rate limited"), { rateLimited: true });
  if (!res.ok) return null;
  const json = await res.json();
  const title = json?.query?.search?.[0]?.title;
  if (!title) return null;
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

export async function run([list], _opts) {
  if (!list) {
    console.error("Usage: andrewzc enrich set-link <list>");
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db  = client.db(process.env.MONGODB_DB || "andrewzc");
  const col = db.collection("entities");

  const page = await db.collection("pages").findOne({ key: list }, { projection: { tags: 1 } });
  const tags = page?.tags ?? [];

  if (tags.includes("people")) {
    console.error(`⚠️  "${list}" is tagged "people" — name search unreliable for people.`);
    await client.close();
    process.exit(1);
  }

  const entities = await col.find(
    { list, link: { $exists: false } },
    { projection: { _id: 1, name: 1 } }
  ).toArray();

  console.log(`Found ${entities.length} entities in "${list}" with no link.\n`);

  let updated = 0;

  for (const entity of entities) {
    try {
      const link = await searchWikipediaLink(entity.name);
      if (link) {
        await col.updateOne({ _id: entity._id }, { $set: { link } });
        console.log(`  🔍 ${entity.name}: ${link}`);
        updated++;
      } else {
        console.log(`  ⚠️  ${entity.name}: not found`);
      }
    } catch (err) {
      if (err.rateLimited) { console.warn("\n  🚫 Rate limited — stopping."); break; }
      throw err;
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`\nDone. Updated ${updated}/${entities.length} entities.`);
  await client.close();
}
