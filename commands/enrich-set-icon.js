// andrewzc enrich set-icon <list> [--overwrite] [--dryrun]
//
// Derives flag emoji from the country/countries field on each entity and
// sets the icons array.
//
//   country: "FR"             → icons: ["🇫🇷"]
//   countries: ["BE", "FR"]   → icons: ["🇧🇪", "🇫🇷"]
//
// By default skips entities that already have a non-empty icons array.
// With --overwrite, replaces existing flags but preserves thematic emoji.
// Skips pages tagged "no-country".

import { MongoClient } from "mongodb";
import { countryCodeToFlagEmoji, flagEmojiToCountryCode } from "../utilities.js";

const CUSTOM_FLAG_EMOJI = {
  "ES-CN": "🇮🇨", // Canary Islands
  "GB-ENG": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  "GB-SCT": "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  "GB-WLS": "🏴󠁧󠁢󠁷󠁬󠁳󠁿",
};

function countryToFlagEmoji(code) {
  return CUSTOM_FLAG_EMOJI[code] ?? countryCodeToFlagEmoji(code) ?? null;
}

function deriveFlags(entity) {
  if (Array.isArray(entity.countries) && entity.countries.length > 0) {
    return entity.countries.map(countryToFlagEmoji).filter(Boolean);
  }
  if (entity.country) {
    const flag = countryToFlagEmoji(entity.country);
    return flag ? [flag] : [];
  }
  return [];
}

function isFlag(icon) {
  if (flagEmojiToCountryCode(icon) != null) return true;
  return Object.values(CUSTOM_FLAG_EMOJI).includes(icon);
}

function mergeIcons(existingIcons, newFlags) {
  const thematic = (existingIcons ?? []).filter(i => !isFlag(i));
  return [...newFlags, ...thematic];
}

export async function run([list], { dryRun, overwrite }) {
  if (!list) {
    console.error("Usage: andrewzc enrich set-icon <list> [--overwrite] [--dryrun]");
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db    = client.db(process.env.MONGODB_DB || "andrewzc");
  const col   = db.collection("entities");
  const pages = db.collection("pages");

  if (dryRun)    console.log("-- DRY RUN --\n");
  if (overwrite) console.log("-- OVERWRITE MODE --\n");

  const page = await pages.findOne({ key: list }, { projection: { tags: 1 } });
  if ((page?.tags ?? []).includes("no-country")) {
    console.log(`Page "${list}" is tagged "no-country" — skipping.`);
    await client.close();
    return;
  }

  const hasCountry = { $or: [{ country: { $exists: true } }, { countries: { $exists: true } }] };

  // Default: only entities with missing or empty icons
  // Overwrite: all entities with a country field
  const filter = overwrite
    ? { list, ...hasCountry }
    : { list, $or: [{ icons: { $exists: false } }, { icons: { $size: 0 } }], ...hasCountry };

  const docs = await col
    .find(filter, { projection: { _id: 1, key: 1, country: 1, countries: 1, icons: 1 } })
    .toArray();

  console.log(`Found ${docs.length} entities in "${list}" to process.\n`);

  let updated = 0, skipped = 0;

  for (const doc of docs) {
    const newFlags = deriveFlags(doc);

    if (newFlags.length === 0) {
      console.log(`  SKIP (no flag derivable) ${doc.key} — country: ${doc.country ?? doc.countries}`);
      skipped++;
      continue;
    }

    const newIcons = mergeIcons(doc.icons, newFlags);
    console.log(`  ${dryRun ? "[dry] " : ""}${doc.key}: icons = [${newIcons.join(" ")}]`);

    if (!dryRun) {
      await col.updateOne({ _id: doc._id }, { $set: { icons: newIcons } });
    }
    updated++;
  }

  console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}.`);
  await client.close();
}
