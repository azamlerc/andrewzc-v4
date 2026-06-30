// andrewzc caption embed [list]
// Generate caption-based embeddings for entities that have a caption.
// Omit list to process all lists.
// Skips entities that already have a captionEmbedding (safe to re-run).
//
// The embedded string is composed on the fly from structured fields — it is
// NOT stored in the database, only the resulting captionEmbedding vector is.

import OpenAI from "openai";
import { fetchEntities, bulkSetFields } from "../database.js";

const BATCH_SIZE = 100; // OpenAI embeddings supports up to 2048 inputs per call

function buildRagText(entity) {
  const parts = [];
  parts.push(entity.name);
  if (entity.reference)        parts.push(entity.reference);
  if (entity.list)             parts.push(`list: ${entity.list}`);
  if (entity.country)          parts.push(`country: ${entity.country}`);
  if (entity.challenge != null) parts.push(`challenge: ${entity.challenge}/5`);
  if (entity.dateVisited)      parts.push(`visited: ${entity.dateVisited}`);
  if (entity.tags?.length)     parts.push(`tags: ${entity.tags.join(", ")}`);
  parts.push(entity.caption); // caption last — semantic anchor
  return parts.join(" | ");
}

export async function run([list], _opts) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY not set"); process.exit(1);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const filter = {
    caption: { $exists: true, $ne: "" },
    captionEmbedding: { $exists: false },
    ...(list ? { list } : {}),
  };

  const entities = await fetchEntities(filter);

  if (entities.length === 0) {
    console.log("✅ Nothing to do!"); return;
  }

  const scope = list ? `"${list}"` : "all lists";
  console.log(`Found ${entities.length} entities with captions and no captionEmbedding in ${scope}`);

  let processed = 0;

  for (let i = 0; i < entities.length; i += BATCH_SIZE) {
    const batch    = entities.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const total    = Math.ceil(entities.length / BATCH_SIZE);
    console.log(`\nBatch ${batchNum}/${total} (${processed} saved so far)...`);

    const texts = batch.map(buildRagText);

    // Log a sample from the first batch so the composed string is visible
    if (i === 0) {
      console.log(`  Sample ragText: ${texts[0]}`);
    }

    const res        = await openai.embeddings.create({ model: "text-embedding-3-small", input: texts, dimensions: 512 });
    const embeddings = res.data.map(item => item.embedding);

    await bulkSetFields(batch.map((entity, j) => ({
      _id:    entity._id,
      fields: { captionEmbedding: embeddings[j] },
    })));

    processed += batch.length;
    console.log(`  ✅ Saved ${batch.length}`);
  }

  console.log(`\n✅ Done. Embedded ${processed} entities.`);
}
