// andrewzc keys rekey <list> [--dryrun]
// Regenerate keys for all entities in a list based on page tags.
// When a rekeyed entity would clash, the two are merged per field-level rules.

import { MongoClient } from "mongodb";
import { queryPages } from "../database.js";
import { computeKey } from "../utilities.js";

const SCALAR_FIELDS = ["name", "link", "coords", "city", "reference", "prefix", "wikiSummary"];

function parseLatLon(s) {
  if (!s) return null;
  const parts = String(s).split(",").map(p => parseFloat(p.trim()));
  if (parts.length < 2 || parts.some(isNaN)) return null;
  return { lat: parts[0], lon: parts[1] };
}

function mergeScalar(a, b, fieldName) {
  const aEmpty = a == null || a === "";
  const bEmpty = b == null || b === "";
  if (aEmpty && bEmpty) return { value: a, conflict: false };
  if (aEmpty)           return { value: b, conflict: false };
  if (bEmpty)           return { value: a, conflict: false };
  if (a === b)          return { value: a, conflict: false };

  if (fieldName === "wikiSummary") {
    return { value: a.length >= b.length ? a : b, conflict: false };
  }
  if (fieldName === "coords") {
    const pa = parseLatLon(a), pb = parseLatLon(b);
    if (pa && pb && Math.abs(pa.lat - pb.lat) < 0.001 && Math.abs(pa.lon - pb.lon) < 0.001) {
      return { value: a, conflict: false };
    }
  }
  if (fieldName === "link") {
    try {
      const da = decodeURIComponent(a), db = decodeURIComponent(b);
      if (da === db) return { value: da, conflict: false };
    } catch (_) {}
  }

  console.error(`  ⚠️  Conflict on "${fieldName}": "${a}" vs "${b}"`);
  return { value: a, conflict: true };
}

function mergeProps(a = {}, b = {}) {
  const merged = { ...a };
  let conflict = false;
  for (const [k, bVal] of Object.entries(b)) {
    if (!(k in merged)) { merged[k] = bVal; continue; }
    const aVal = merged[k];
    if (aVal && bVal && typeof aVal === "object" && typeof bVal === "object"
        && !Array.isArray(aVal) && !Array.isArray(bVal)) {
      const sub = mergeProps(aVal, bVal);
      if (sub.conflict) conflict = true;
      merged[k] = sub.merged;
    } else {
      const r = mergeScalar(aVal, bVal, `props.${k}`);
      if (r.conflict) conflict = true;
      merged[k] = r.value;
    }
  }
  return { merged, conflict };
}

function mergeEntities(dst, src) {
  const $set = {};
  let conflict = false;

  for (const f of SCALAR_FIELDS) {
    const r = mergeScalar(dst[f], src[f], f);
    if (r.conflict) conflict = true;
    if (r.value !== dst[f] && r.value != null) $set[f] = r.value;
  }

  for (const f of ["been", "strike"]) {
    const merged = !!(dst[f] || src[f]);
    if (merged !== dst[f]) $set[f] = merged;
  }

  for (const f of ["icons", "countries"]) {
    const a = Array.isArray(dst[f]) ? dst[f] : [];
    const b = Array.isArray(src[f]) ? src[f] : [];
    if (a.length === 0 && b.length > 0) $set[f] = b;
  }

  const { merged: mergedProps, conflict: propsConflict } = mergeProps(dst.props, src.props);
  if (propsConflict) conflict = true;
  if (JSON.stringify(mergedProps) !== JSON.stringify(dst.props ?? {})) $set.props = mergedProps;

  return { $set, conflict };
}

export async function run([list], { dryRun }) {
  if (!list) {
    console.error("Usage: andrewzc keys rekey <list> [--dryrun]");
    process.exit(1);
  }

  const [page] = await queryPages({ key: list });
  if (!page) { console.error(`❌ Page "${list}" not found`); process.exit(1); }

  const tags = page.tags ?? [];
  console.log(`Tags: ${tags.length ? tags.join(", ") : "none"}\n`);

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db  = client.db(process.env.MONGODB_DB || "andrewzc");
  const col = db.collection("entities");

  const entities = await col.find({ list }).toArray();
  const byKey    = new Map(entities.map(e => [e.key, e]));

  let rekeyed = 0, merged = 0, skipped = 0, unchanged = 0;

  for (const entity of entities) {
    const newKey = computeKey(entity, tags);
    if (entity.key === newKey) { unchanged++; continue; }

    if (!byKey.has(newKey)) {
      console.log(`  🔑 ${entity.key} → ${newKey}`);
      if (!dryRun) await col.updateOne({ _id: entity._id }, { $set: { key: newKey } });
      byKey.delete(entity.key);
      byKey.set(newKey, { ...entity, key: newKey });
      rekeyed++;
      continue;
    }

    const existing = byKey.get(newKey);
    console.log(`  🔀 ${entity.key} ⟶ ${newKey} (merge with existing)`);

    const { $set, conflict } = mergeEntities(existing, entity);

    if (conflict) {
      console.error(`  ❌ Skipping — conflicting field values need human intervention.\n`);
      skipped++;
      continue;
    }

    if (!dryRun) {
      if (Object.keys($set).length > 0) await col.updateOne({ _id: existing._id }, { $set });
      await col.deleteOne({ _id: entity._id });
    } else {
      if (Object.keys($set).length > 0) console.log(`    would $set: ${JSON.stringify($set)}`);
      console.log(`    would delete duplicate ${entity.key}`);
    }

    byKey.set(newKey, { ...existing, ...$set });
    byKey.delete(entity.key);
    merged++;
  }

  await client.close();

  console.log(`\n✅ Unchanged: ${unchanged}  Rekeyed: ${rekeyed}  Merged: ${merged}  Skipped: ${skipped}${dryRun ? "\n[DRY RUN] No changes written." : ""}`);
}
