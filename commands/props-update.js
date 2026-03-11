// andrewzc props update <list> <file.json> [--dryrun]
// Set props on entities in a list from a JSON file.
// File format: { "entity-key": { "prop": value, ... }, ... }

import { readFileSync } from "fs";
import { resolve } from "path";
import { processEntities } from "../database.js";

export async function run([list, dataFile], { dryRun }) {
  if (!list || !dataFile) {
    console.error("Usage: andrewzc props update <list> <file.json> [--dryrun]");
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(resolve(dataFile), "utf8"));
  console.log(`Loaded ${Object.keys(data).length} entries from ${dataFile}`);

  await processEntities(
    { list, key: { $in: Object.keys(data) } },
    (entity) => {
      if (!entity.props) entity.props = {};
      Object.assign(entity.props, data[entity.key]);
    },
    { dryRun }
  );

  console.log("✅ Done.");
}
