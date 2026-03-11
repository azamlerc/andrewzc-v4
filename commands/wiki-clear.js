// andrewzc wiki clear <list> [--junk-only]
// Remove wikiSummary, wikiEmbedding, and enrichedAt from entities in a list.
// --junk-only  Only clear entries where wikiSummary starts with ".mw-parser-output"

import { processEntities } from "../database.js";

export async function run([list], { junkOnly }) {
  if (!list) {
    console.error("Usage: andrewzc wiki clear <list> [--junk-only]");
    process.exit(1);
  }

  const filter = junkOnly
    ? { list, wikiSummary: { $regex: /^\.mw-parser-output/ } }
    : { list, $or: [{ wikiSummary: { $exists: true } }, { wikiEmbedding: { $exists: true } }, { enrichedAt: { $exists: true } }] };

  await processEntities(filter, (entity) => {
    delete entity.wikiSummary;
    delete entity.wikiEmbedding;
    delete entity.enrichedAt;
  });

  console.log("✅ Done — wiki data cleared.");
}
