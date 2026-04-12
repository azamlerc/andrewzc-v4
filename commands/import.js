// andrewzc import <page-key>
// Upserts a page record and its entities from the master export files:
//   andrewzc.net/output/pages.json
//   andrewzc.net/output/entities.json
//
// The page is matched by key. Entities are matched by list === page-key.
// Both the page and each entity are upserted (insert if missing, update if present).
// Existing fields not present in the source file are left untouched.
//
// Special handling for entities with empty names (e.g. artist-themed pages
// where the relevant word is the artist name rather than a song/album title):
//   1. If name is "" but reference is set, copy reference → name
//   2. If icons is [] but badges has values, move badges → icons (clear badges)

import { MongoClient } from "mongodb";
import { readFileSync } from "fs";
import path from "path";

const PAGES_FILE    = "/Users/andrewzc/Projects/andrewzc.net/output/pages.json";
const ENTITIES_FILE = "/Users/andrewzc/Projects/andrewzc.net/output/entities.json";

function normalizeEntity(entity) {
  const e = { ...entity };

  // 1. Empty name → copy from reference
  if (e.name === "" && e.reference) {
    e.name = e.reference;
  }

  // 2. Empty icons → move from badges
  if (Array.isArray(e.icons) && e.icons.length === 0 &&
      Array.isArray(e.badges) && e.badges.length > 0) {
    e.icons  = e.badges;
    e.badges = [];
  }

  return e;
}

export async function run([pageKey], _opts) {
  if (!pageKey) {
    console.error("Usage: andrewzc import <page-key>");
    process.exit(1);
  }

  // ── Load source files ───────────────────────────────────────────────────────

  const allPages    = JSON.parse(readFileSync(path.resolve(PAGES_FILE), "utf8"));
  const allEntities = JSON.parse(readFileSync(path.resolve(ENTITIES_FILE), "utf8"));

  const pageDoc = allPages.find(p => p.key === pageKey);
  if (!pageDoc) {
    console.error(`Page "${pageKey}" not found in ${PAGES_FILE}`);
    process.exit(1);
  }

  const entityDocs = allEntities.filter(e => e.list === pageKey);
  console.log(`Found page "${pageKey}" and ${entityDocs.length} entities in source files.\n`);

  // ── Connect ─────────────────────────────────────────────────────────────────

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db       = client.db(process.env.MONGODB_DB || "andrewzc");
  const pages    = db.collection("pages");
  const entities = db.collection("entities");

  // ── Upsert page ─────────────────────────────────────────────────────────────

  const { _id: _pid, ...pageFields } = pageDoc;
  const pageResult = await pages.updateOne(
    { key: pageKey },
    { $set: pageFields },
    { upsert: true }
  );

  if (pageResult.upsertedCount)       console.log(`  ➕ Page "${pageKey}" inserted`);
  else if (pageResult.modifiedCount)  console.log(`  ✏️  Page "${pageKey}" updated`);
  else                                console.log(`  ✓  Page "${pageKey}" unchanged`);

  // ── Upsert entities ─────────────────────────────────────────────────────────

  let inserted = 0, updated = 0, unchanged = 0;

  for (const raw of entityDocs) {
    const entity = normalizeEntity(raw);
    const { _id, key, list, ...fields } = entity;
    if (!key || !list) { console.warn(`  ⚠️  Skipping entity with missing key/list`); continue; }

    const result = await entities.updateOne(
      { key, list },
      { $set: { key, list, ...fields } },
      { upsert: true }
    );

    if (result.upsertedCount)      inserted++;
    else if (result.modifiedCount) updated++;
    else                           unchanged++;
  }

  console.log(`\nEntities: ${inserted} inserted, ${updated} updated, ${unchanged} unchanged.`);
  console.log(`\nDone.`);
  await client.close();
}
