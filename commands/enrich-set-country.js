// andrewzc enrich set-country <list> [--overwrite] [--dryrun]
// andrewzc enrich set-country --all   [--overwrite] [--dryrun]
//
// Derives country / countries from flag emoji in each entity's icons array
// and sets the appropriate top-level field:
//
//   - One flag  → country: "XX"
//   - Many flags → countries: ["XX", "YY", ...]
//
// Skips entities that already have country or countries set, unless --overwrite.
// Skips entities whose list's page is tagged "no-country".
// With --all, processes every distinct list in the entities collection.
//
// Sub-national flag emoji (England 🏴󠁧󠁢󠁥󠁮󠁧󠁿, Scotland 🏴󠁧󠁢󠁳󠁣󠁴󠁿, Wales 🏴󠁧󠁢󠁷󠁬󠁳󠁿, etc.)
// are mapped to their parent ISO 3166-1 alpha-2 country code.

import { MongoClient } from "mongodb";
import { flagEmojiToCountryCode } from "../utilities.js";

// ── Sub-national flag → parent country code ───────────────────────────────────
// These use Unicode tag sequences (U+1F3F4 + tag letters) rather than regional
// indicator pairs, so flagEmojiToCountryCode returns null for them.
const SUBNATIONAL_FLAG_MAP = {
  "🏴󠁧󠁢󠁥󠁮󠁧󠁿": "GB", // England
  "🏴󠁧󠁢󠁳󠁣󠁴󠁿": "GB", // Scotland
  "🏴󠁧󠁢󠁷󠁬󠁳󠁿": "GB", // Wales
  "🏴󠁵󠁳󠁴󠁸󠁿":   "US", // Texas (unofficial)
};

function iconToCountryCode(icon) {
  return SUBNATIONAL_FLAG_MAP[icon] ?? flagEmojiToCountryCode(icon);
}

function codesFromIcons(icons) {
  if (!Array.isArray(icons)) return [];
  return [...new Set(icons.map(iconToCountryCode).filter(Boolean))];
}

async function processList(list, col, pages, { dryRun, overwrite }) {
  // Check for no-country tag
  const page = await pages.findOne({ key: list }, { projection: { tags: 1 } });
  if ((page?.tags ?? []).includes("no-country")) {
    console.log(`  SKIP (no-country tag) "${list}"`);
    return { set: 0, noFlag: 0, skipped: 1 };
  }

  const filter = overwrite
    ? { list }
    : { list, country: { $exists: false }, countries: { $exists: false } };

  const entities = await col
    .find(filter, { projection: { _id: 1, key: 1, icons: 1, country: 1, countries: 1 } })
    .toArray();

  if (entities.length === 0) return { set: 0, noFlag: 0, skipped: 0 };

  let set = 0, noFlag = 0;

  for (const entity of entities) {
    const codes = codesFromIcons(entity.icons);

    if (codes.length === 0) {
      noFlag++;
      continue;
    }

    const update = codes.length === 1
      ? { $set: { country: codes[0] }, $unset: { countries: "" } }
      : { $set: { countries: codes }, $unset: { country: "" } };

    const label = codes.length === 1 ? `country: "${codes[0]}"` : `countries: [${codes.join(", ")}]`;
    const old   = entity.country ?? (entity.countries ? `[${entity.countries.join(", ")}]` : null);
    const arrow = old ? `${old} → ${label}` : label;

    console.log(`  ${dryRun ? "[dry] " : ""}${entity.key}: ${arrow}`);

    if (!dryRun) {
      await col.updateOne({ _id: entity._id }, update);
    }
    set++;
  }

  return { set, noFlag, skipped: 0 };
}

export async function run([list], { dryRun, overwrite, all }) {
  if (!list && !all) {
    console.error("Usage: andrewzc enrich set-country <list> [--overwrite] [--dryrun]");
    console.error("       andrewzc enrich set-country --all   [--overwrite] [--dryrun]");
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db    = client.db(process.env.MONGODB_DB || "andrewzc");
  const col   = db.collection("entities");
  const pages = db.collection("pages");

  if (dryRun)    console.log("-- DRY RUN --\n");
  if (overwrite) console.log("-- OVERWRITE MODE: replacing existing country fields --\n");

  if (all) {
    // Get all distinct list keys from the entities collection
    const listKeys = await col.distinct("list");
    listKeys.sort();
    console.log(`Processing ${listKeys.length} lists...\n`);

    let totalSet = 0, totalNoFlag = 0, totalSkipped = 0;

    for (const key of listKeys) {
      console.log(`\n── ${key}`);
      const { set, noFlag, skipped } = await processList(key, col, pages, { dryRun, overwrite });
      totalSet     += set;
      totalNoFlag  += noFlag;
      totalSkipped += skipped;
    }

    console.log(`\n══ Total — Set: ${totalSet}, No flag emoji: ${totalNoFlag}, Lists skipped (no-country): ${totalSkipped}`);
  } else {
    console.log(`Processing "${list}"...\n`);
    const { set, noFlag, skipped } = await processList(list, col, pages, { dryRun, overwrite });
    console.log(`\nDone. Set: ${set}, No flag emoji: ${noFlag}, Skipped: ${skipped}`);
  }

  await client.close();
}
