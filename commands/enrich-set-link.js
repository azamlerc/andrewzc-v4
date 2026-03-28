// andrewzc enrich set-link <list> [--overwrite]
// Search Wikipedia by entity name and set the link field.
// Skips pages tagged "people". Stops gracefully on rate limit.
//
// --overwrite: also replace existing links that are relative (don't start with "https")

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

export async function run([list], opts) {
  if (!list) {
    console.error("Usage: andrewzc enrich set-link <list> [--overwrite]");
    process.exit(1);
  }

  const overwrite = opts?.overwrite ?? false;

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

  // Base filter: no link yet
  // With --overwrite: also include entities whose link is relative (doesn't start with "https")
  const filter = overwrite
    ? { list, $or: [{ link: { $exists: false } }, { link: { $not: /^https/ } }] }
    : { list, link: { $exists: false } };

  const entities = await col.find(
    filter,
    { projection: { _id: 1, name: 1, link: 1 } }
  ).toArray();

  const label = overwrite ? "with no link or a relative link" : "with no link";
  console.log(`Found ${entities.length} entities in "${list}" ${label}.\n`);

  let updated = 0;

  for (const entity of entities) {
    const oldLink = entity.link ?? null;
    try {
      const link = await searchWikipediaLink(entity.name);
      if (link) {
        await col.updateOne({ _id: entity._id }, { $set: { link } });
        if (oldLink) {
          console.log(`  🔄 ${entity.name}: ${oldLink} → ${link}`);
        } else {
          console.log(`  🔍 ${entity.name}: ${link}`);
        }
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
