// andrewzc wiki clear-embeddings <list|--all>
// Remove only wikiEmbedding, preserving wikiSummary and enrichedAt.
// Use before regenerating embeddings at a different dimension size.

import { processEntities, fetchEntities, bulkSetFields } from "../database.js";
import { MongoClient } from "mongodb";

export async function run([list], { all }) {
  if (!list && !all) {
    console.error("Usage: andrewzc wiki clear-embeddings <list>  OR  andrewzc wiki clear-embeddings --all");
    process.exit(1);
  }

  const filter = all
    ? { wikiEmbedding: { $exists: true } }
    : { list, wikiEmbedding: { $exists: true } };

  await processEntities(filter, (entity) => { delete entity.wikiEmbedding; });

  console.log("✅ Done — embeddings cleared.");
}
