// andrewzc enrich set-reference <list>
// Copy city → reference for all entities in a list that have a city.

import { processEntities } from "../database.js";

export async function run([list], _opts) {
  if (!list) {
    console.error("Usage: andrewzc enrich set-reference <list>");
    process.exit(1);
  }

  await processEntities(
    { list, city: { $exists: true } },
    (entity) => { entity.reference = entity.city; }
  );

  console.log("✅ Done — city → reference copied.");
}
