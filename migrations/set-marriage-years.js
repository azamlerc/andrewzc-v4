// One-shot migration: replace props.marriage: true with props.marriage: { year: YYYY }
// Source: https://en.wikipedia.org/wiki/Timeline_of_same-sex_marriage
//
// Run: node migrations/set-marriage-years.js [--dryrun]

import "dotenv/config";
import { fetchEntities, bulkSetFields } from "../database.js";

// Year same-sex marriage became legal nationally (or first jurisdiction for federal states)
// For Mexico: 2010 (first state); for US: 2004 (Massachusetts); for Brazil: 2013 (national ruling)
// Bermuda: legalized 2017, then reversed — kept as the year it was briefly legal
const MARRIAGE_YEARS = {
  "netherlands":     2001,
  "belgium":         2003,
  "canada":          2003,
  "spain":           2005,
  "south-africa":    2006,
  "norway":          2009,
  "sweden":          2009,
  "portugal":        2010,
  "iceland":         2010,
  "argentina":       2010,
  "denmark":         2012,
  "brazil":          2013,
  "france":          2013,
  "uruguay":         2013,
  "new-zealand":     2013,
  "luxembourg":      2015,
  "united-states":   2015,
  "ireland":         2015,
  "colombia":        2016,
  "finland":         2017,
  "malta":           2017,
  "germany":         2017,
  "australia":       2017,
  "austria":         2019,
  "ecuador":         2019,
  "taiwan":          2019,
  "united-kingdom":  2020,
  "costa-rica":      2020,
  "chile":           2022,
  "switzerland":     2022,
  "slovenia":        2022,
  "andorra":         2023,
  "estonia":         2023,
  "mexico":          2022, // nationwide effective
  "cuba":            2022,
  "nepal":           2023,
  "greece":          2024,
  "thailand":        2024,
  "bermuda":         2017, // legalized then reversed; kept for historical accuracy
};

const dryRun = process.argv.includes("--dryrun");

const entities = await fetchEntities({
  list: "countries",
  "props.marriage": { $exists: true },
});

console.log(`Found ${entities.length} countries with marriage prop\n`);

const updates = [];
const missing = [];

for (const entity of entities) {
  const year = MARRIAGE_YEARS[entity.key];
  if (!year) {
    missing.push(entity.key);
    continue;
  }
  console.log(`${dryRun ? "[dry] " : ""}${entity.key}: marriage → { year: ${year} }`);
  updates.push({ _id: entity._id, fields: { "props.marriage": { year } } });
}

if (missing.length) {
  console.warn(`\n⚠️  No year found for: ${missing.join(", ")}`);
}

console.log(`\nTo update: ${updates.length}`);

if (!dryRun && updates.length > 0) {
  await bulkSetFields(updates);
  console.log(`✅ Done.`);
} else if (dryRun) {
  console.log("[DRY RUN] No changes written.");
}
