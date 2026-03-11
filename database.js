// database.js — MongoDB access layer for andrewzc-v4 scripts.
//
// Each exported function opens a connection, does its work, and closes it.
// This open/close-per-call pattern is correct for CLI scripts (vs. the API's
// persistent pool). Uses the same MONGODB_URI and MONGODB_DB env vars.

import { MongoClient } from "mongodb";
import { parseCoords } from "./utilities.js";

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB  = process.env.MONGODB_DB || "andrewzc";

if (!MONGODB_URI) throw new Error("Missing MONGODB_URI in environment");

// ── Internal helpers ──────────────────────────────────────────────────────────

function track(doc) {
  const changed = new Set();
  const deleted = new Set();

  const proxy = new Proxy(doc, {
    set(target, prop, value) {
      if (prop === "_id") { target[prop] = value; return true; }
      target[prop] = value;
      changed.add(prop);
      deleted.delete(prop);
      return true;
    },
    deleteProperty(target, prop) {
      if (prop === "_id") return true;
      if (prop in target) delete target[prop];
      deleted.add(prop);
      changed.add(prop);
      return true;
    },
  });

  const delta = () => {
    const $set = {}, $unset = {};
    for (const k of changed) {
      if (k === "_id") continue;
      if (deleted.has(k) || proxy[k] === undefined) $unset[k] = 1;
      else $set[k] = proxy[k];
    }
    const update = {};
    if (Object.keys($set).length)   update.$set   = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    return update;
  };

  const clear  = () => { changed.clear(); deleted.clear(); };
  return { doc: proxy, delta, clear, changedCount: () => changed.size };
}

async function withDb(fn) {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  try {
    const db       = client.db(MONGODB_DB);
    const pages    = db.collection("pages");
    const entities = db.collection("entities");
    return await fn({ db, pages, entities });
  } finally {
    await client.close();
  }
}

async function bulkSave({ entities }, trackedDocs, { ordered = false, chunkSize = 1000 } = {}) {
  const docs = trackedDocs.filter(Boolean);
  if (docs.length === 0) return { insertedCount: 0, modifiedCount: 0, matchedCount: 0 };

  let insertedCount = 0, modifiedCount = 0, matchedCount = 0;

  for (let i = 0; i < docs.length; i += chunkSize) {
    const batch = docs.slice(i, i + chunkSize);
    const ops   = [];

    for (const tracked of batch) {
      const doc    = tracked.doc;
      const update = tracked.delta();
      const isNew  = !!doc.__isNew;
      delete doc.__isNew;

      if (isNew) { ops.push({ insertOne: { document: doc } }); continue; }
      if (!Object.keys(update).length) continue;
      if (!doc._id) throw new Error(`Cannot update without _id: ${doc.list}/${doc.key || doc.name}`);

      ops.push({ updateOne: { filter: { _id: doc._id }, update } });
    }

    if (ops.length === 0) continue;

    const res = await entities.bulkWrite(ops, { ordered });
    insertedCount += res.insertedCount || 0;
    modifiedCount += res.modifiedCount || 0;
    matchedCount  += res.matchedCount  || 0;

    for (const tracked of batch) tracked?.clear?.();
  }

  return { insertedCount, modifiedCount, matchedCount };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function geoPointFromCoords(coords) {
  const ll = parseCoords(coords);
  if (!ll) return null;
  return { type: "Point", coordinates: [ll.lon, ll.lat] };
}

export async function fetchEntity(list, key) {
  return withDb(async ({ entities }) => entities.findOne({ list, key }));
}

export async function fetchEntities(filter, options = {}) {
  return withDb(async ({ entities }) => {
    let cur = entities.find(filter);
    if (options.sort)  cur = cur.sort(options.sort);
    if (options.limit) cur = cur.limit(options.limit);
    return cur.toArray();
  });
}

export async function queryPages(filter = {}) {
  return withDb(async ({ pages }) => pages.find(filter).toArray());
}

export async function bulkSetFields(updates) {
  if (updates.length === 0) return;
  return withDb(async ({ entities }) => {
    const ops = updates.map(({ _id, fields }) => ({
      updateOne: { filter: { _id }, update: { $set: fields } },
    }));
    return entities.bulkWrite(ops, { ordered: false });
  });
}

export async function updatePage(key, fields) {
  return withDb(async ({ pages }) =>
    pages.updateOne({ key }, { $set: fields })
  );
}

export async function insertEntity(doc) {
  return withDb(async ({ entities }) => {
    const res = await entities.insertOne(doc);
    return { ...doc, _id: res.insertedId };
  });
}

export async function pushToEntityField(_id, field, value, exists) {
  return withDb(async ({ entities }) => {
    const update = exists
      ? { $push: { [field]: value } }
      : { $set:  { [field]: [value] } };
    return entities.updateOne({ _id }, update);
  });
}

export async function processEntities(filter, transformFn, options = {}) {
  const { sort, limit, chunkSize = 1000, dryRun = false } = options;

  return withDb(async (ctx) => {
    let cur = ctx.entities.find(filter);
    if (sort)  cur = cur.sort(sort);
    if (limit) cur = cur.limit(limit);
    const docs = await cur.toArray();

    console.log(`Found ${docs.length} entities matching filter`);
    if (docs.length === 0) return { processed: 0, modified: 0, skipped: 0 };

    const tracked = [];
    let processed = 0, modified = 0, skipped = 0;

    for (const doc of docs) {
      const t = track(doc);
      t.doc.__isNew = false;
      try {
        transformFn(t.doc);
        processed++;
        if (t.changedCount() > 0) { tracked.push(t); modified++; }
        else skipped++;
      } catch (err) {
        console.error(`Error on ${doc.list}/${doc.key || doc.name}:`, err.message);
        skipped++;
      }
    }

    console.log(`Processed: ${processed}, Modified: ${modified}, Skipped: ${skipped}`);

    if (!dryRun && tracked.length > 0) {
      const result = await bulkSave(ctx, tracked, { ordered: false, chunkSize });
      console.log(`Saved: inserted=${result.insertedCount}, modified=${result.modifiedCount}`);
    } else if (dryRun) {
      console.log(`[DRY RUN] Would have saved ${tracked.length} entities`);
    }

    return { processed, modified, skipped };
  });
}

export async function fetchCompletionStats() {
  return withDb(async ({ db }) =>
    db.collection("entities").aggregate([
      { $match: { been: { $exists: true } } },
      { $group: {
        _id:     "$list",
        total:   { $sum: 1 },
        visited: { $sum: { $cond: ["$been", 1, 0] } },
      }},
      { $lookup: { from: "pages", localField: "_id", foreignField: "key", as: "page" } },
      { $unwind: { path: "$page", preserveNullAndEmptyArrays: true } },
      { $project: {
        list:        "$_id",
        total:       1,
        visited:     1,
        name:        { $ifNull: ["$page.name", "$_id"] },
        icon:        { $ifNull: ["$page.icon", ""] },
        percentDone: { $multiply: [{ $divide: ["$visited", "$total"] }, 100] },
      }},
      { $sort: { percentDone: -1 } },
    ]).toArray()
  );
}

export async function vectorSearch(queryVector, { listFilter = null, limit = 10 } = {}) {
  return withDb(async ({ entities }) => {
    const pipeline = [
      { $vectorSearch: {
        index:         "wikiEmbeddings",
        path:          "wikiEmbedding",
        queryVector,
        numCandidates: limit * 5,
        limit,
      }},
      { $project: { name: 1, list: 1, icons: 1, score: { $meta: "vectorSearchScore" } } },
    ];
    if (listFilter) pipeline.splice(1, 0, { $match: { list: listFilter } });
    pipeline.push(
      { $lookup: { from: "pages", localField: "list", foreignField: "key", as: "pageInfo" } },
      { $unwind: { path: "$pageInfo", preserveNullAndEmptyArrays: true } }
    );
    return entities.aggregate(pipeline).toArray();
  });
}
