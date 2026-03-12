// andrewzc props enrich-country-icons <list> [--dryrun]
//
// For props that contain a "country" code (e.g. independence, unification,
// territories), adds an "icons" array containing the corresponding flag emoji.
//
// Input:  { "independence": { "country": "TR", "reference": "Ottoman Empire", "year": 1912 } }
// Output: { "independence": { "country": "TR", "icons": ["🇹🇷"], "reference": "Ottoman Empire", "year": 1912 } }
//
// - Skips prop objects that already have an icons field
// - Skips prop objects with no country field, or where the country code
//   doesn't resolve to a known flag emoji
// - Safe to re-run (idempotent due to skip logic above)

import { fetchEntities, bulkSetFields } from "../database.js";
import { countryCodeToFlagEmoji } from "../utilities.js";

// Props to inspect — all known props that may contain a nested country code
const COUNTRY_PROPS = ["independence", "unification", "territories"];

export async function run([list], { dryRun }) {
  if (!list) {
    console.error("Usage: andrewzc props enrich-country-icons <list> [--dryrun]");
    process.exit(1);
  }

  // Build filter: entities that have at least one of these props with a country field
  const filter = {
    list,
    $or: COUNTRY_PROPS.map(p => ({ [`props.${p}.country`]: { $exists: true } })),
  };

  const entities = await fetchEntities(filter);
  console.log(`Found ${entities.length} entities with country-bearing props in "${list}"\n`);

  const updates = [];
  let skipped = 0;

  for (const entity of entities) {
    const newProps = { ...entity.props };
    let changed = false;

    for (const propName of COUNTRY_PROPS) {
      const prop = newProps[propName];
      if (!prop || typeof prop !== "object") continue;
      if (!prop.country) continue;
      if (prop.icons) {
        // Already enriched — skip
        continue;
      }

      const emoji = countryCodeToFlagEmoji(prop.country);
      if (!emoji) {
        console.log(`  ⚠️  ${entity.key}: unknown country code "${prop.country}" on props.${propName}`);
        skipped++;
        continue;
      }

      newProps[propName] = { ...prop, icons: [emoji] };
      changed = true;
      console.log(`  ${dryRun ? "[dry] " : ""}${entity.key}: props.${propName}.icons = ["${emoji}"] (${prop.country})`);
    }

    if (changed) {
      updates.push({ _id: entity._id, fields: { props: newProps } });
    }
  }

  console.log(`\nTo update: ${updates.length}, Skipped: ${skipped}`);

  if (!dryRun && updates.length > 0) {
    await bulkSetFields(updates);
    console.log(`✅ Done — updated ${updates.length} entities.`);
  } else if (dryRun) {
    console.log("[DRY RUN] No changes written.");
  }
}
