// andrewzc wiki load [list]
// Fetch Wikipedia summaries and generate OpenAI embeddings.
// Omit list to enrich all non-deprecated lists.

import OpenAI from "openai";
import { fetchEntities, queryPages, bulkSetFields } from "../database.js";

const BATCH_SIZE             = 10;
const SLEEP_MS               = 1000;
const MAX_CONSECUTIVE_ERRORS = 5;

class RateLimitError extends Error {}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWikiSummary(url) {
  const { hostname, pathname } = new URL(url);
  const lang  = hostname.match(/^([a-z]{2})\.wikipedia\.org$/)?.[1] ?? "en";
  const title = decodeURIComponent(pathname.split("/").at(-1));
  const apiUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json` +
    `&prop=extracts&exintro=true&explaintext=true&redirects=true&titles=${encodeURIComponent(title)}`;

  const res = await fetch(apiUrl, { headers: { "User-Agent": "PersonalWebsiteBot/1.0 (andrewzc)" } });
  if (res.status === 429 || res.status === 403) throw new RateLimitError(`HTTP ${res.status}`);

  const data    = await res.json();
  const extract = Object.values(data.query?.pages ?? {})[0]?.extract;
  if (!extract) return { summary: null };

  const summary = extract.split("\n")
    .filter(p => p.trim().length > 50)
    .filter(p => !/<[a-z]/i.test(p))
    .filter(p => !/^[^a-zA-Z]*$/.test(p))
    .slice(0, 3).join(" ") || null;
  return { summary };
}

export async function run([list], _opts) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY not set"); process.exit(1);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  let entities;
  if (list) {
    const [page] = await queryPages({ key: list });
    if (page?.propertyOf) {
      console.error(`⚠️  "${list}" is deprecated (propertyOf: ${page.propertyOf}).`); process.exit(0);
    }
    entities = await fetchEntities({
      list, link: { $regex: "wikipedia\\.org" },
      $or: [{ enrichedAt: { $exists: false } }, { wikiSummary: { $exists: true }, wikiEmbedding: { $exists: false } }],
    });
    console.log(`Found ${entities.length} unenriched entities in "${list}"`);
  } else {
    const deprecated = (await queryPages({ propertyOf: { $exists: true } })).map(p => p.key);
    entities = await fetchEntities({
      list: { $nin: deprecated }, link: { $regex: "wikipedia\\.org" },
      $or: [{ enrichedAt: { $exists: false } }, { wikiSummary: { $exists: true }, wikiEmbedding: { $exists: false } }],
    });
    console.log(`Found ${entities.length} unenriched entities across all lists`);
  }

  if (entities.length === 0) { console.log("✅ Nothing to do!"); return; }

  let processed = 0, noExtract = 0, consecutiveErrors = 0;

  for (let i = 0; i < entities.length; i += BATCH_SIZE) {
    const batch        = entities.slice(i, i + BATCH_SIZE);
    const batchNum     = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(entities.length / BATCH_SIZE);
    console.log(`\nBatch ${batchNum}/${totalBatches} (${processed} saved so far)...`);

    const withSummary = [], withoutSummary = [];

    for (const entity of batch) {
      console.log(`  ${entity.list}/${entity.name}`);

      if (entity.wikiSummary) {
        withSummary.push({ entity, summary: entity.wikiSummary });
        consecutiveErrors = 0;
        continue;
      }

      try {
        const { summary } = await fetchWikiSummary(entity.link);
        if (summary) { withSummary.push({ entity, summary }); }
        else         { withoutSummary.push({ entity }); noExtract++; }
        consecutiveErrors = 0;
      } catch (err) {
        if (err instanceof RateLimitError) {
          console.error(`\n🚫 Rate limited (${err.message}). Saved ${processed} so far.`);
          process.exit(1);
        }
        console.warn(`  ⚠️  Network error: ${entity.name} — ${err.message}`);
        if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error(`\n🚫 ${consecutiveErrors} consecutive errors. Saved ${processed} so far.`);
          process.exit(1);
        }
      }
      await sleep(SLEEP_MS);
    }

    if (withSummary.length > 0) {
      const res         = await openai.embeddings.create({ model: "text-embedding-3-small", input: withSummary.map(r => r.summary), dimensions: 512 });
      const embeddings  = res.data.map(item => item.embedding);
      await bulkSetFields(withSummary.map(({ entity, summary }, j) => ({
        _id: entity._id, fields: { wikiSummary: summary, wikiEmbedding: embeddings[j], enrichedAt: new Date() },
      })));
      processed += withSummary.length;
      console.log(`  ✅ Saved ${withSummary.length}`);
    }

    if (withoutSummary.length > 0) {
      await bulkSetFields(withoutSummary.map(({ entity }) => ({ _id: entity._id, fields: { enrichedAt: new Date() } })));
      console.log(`  ⏭️  No extract for ${withoutSummary.length}`);
    }
  }

  console.log(`\n✅ Done. Saved: ${processed}, No extract: ${noExtract}`);
}
