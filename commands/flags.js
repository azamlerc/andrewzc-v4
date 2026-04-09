// andrewzc flags
// Rebuild ~/Projects/andrewzc.net/data/flags.json from the database.
//
// Fetches all pages and countries, runs aggregations in parallel to count
// per-(page, country) occurrences, then writes the JSON file in the same
// compressed sparse-matrix format as before.
//
// Usage:
//   node andrewzc.js flags

import { MongoClient } from "mongodb";
import { writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB  = process.env.MONGODB_DB || "andrewzc";
const OUTPUT_PATH = join(homedir(), "Projects", "andrewzc.net", "data", "flags.json");

// ── Compression (mirrors flags-table.js) ─────────────────────────────────────

function compressArray(arr) {
  const compressed = [];
  let zeros = 0;
  for (const v of arr) {
    if (v === 0) {
      zeros++;
    } else {
      if (zeros > 0) { compressed.push(0, zeros); zeros = 0; }
      compressed.push(v);
    }
  }
  if (zeros > 0) compressed.push(0, zeros);
  return compressed;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function run(_args, _opts) {
  const t0 = Date.now();
  const client = new MongoClient(MONGODB_URI);
  await client.connect();

  try {
    const db       = client.db(MONGODB_DB);
    const entities = db.collection("entities");
    const pages    = db.collection("pages");

    // ── 1. Fire all queries in parallel ────────────────────────────────────

    // 1a. Country entities: key, name, flag icon, 2-letter code
    const countriesPromise = entities
      .find({ list: "countries" }, { projection: { key: 1, name: 1, icons: 1, country: 1 } })
      .toArray();

    // 1b. All page metadata (exclude roadtrip pages — they tag entities from other
    //     pages and have no entities of their own, so their counts are always 0)
    const pagesPromise = pages
      .find({ tags: { $ne: "roadtrip" } }, { projection: { key: 1, name: 1, icon: 1, group: 1 } })
      .toArray();

    // 1c. Per-page stats: total count + been count
    const pageStatsPipeline = [
      { $match: { list: { $exists: true } } },
      { $group: {
        _id:   "$list",
        total: { $sum: 1 },
        been:  { $sum: { $cond: [{ $eq: ["$been", true] }, 1, 0] } },
      }},
    ];
    const pageStatsPromise = entities.aggregate(pageStatsPipeline).toArray();

    // 1d. Per-(page, country) cell counts + been counts in a single pass.
    //     Merging been into this pipeline eliminates a full collection scan.
    const cellPipeline = [
      { $match: { list: { $exists: true } } },
      { $project: {
        list: 1,
        been: 1,
        // Normalise: single country uses `country` string, multiple uses `countries` array
        codes: { $ifNull: ["$countries", ["$country"]] },
      }},
      { $match: { codes: { $ne: null }, "codes.0": { $exists: true } } },
      { $unwind: "$codes" },
      { $match: { codes: { $ne: null, $ne: "" } } },
      { $group: {
        _id:   { list: "$list", code: "$codes" },
        count: { $sum: 1 },
        been:  { $sum: { $cond: [{ $eq: ["$been", true] }, 1, 0] } },
      }},
    ];
    const cellsPromise = entities.aggregate(cellPipeline).toArray();

    console.log("Running queries…");
    const [countryEntities, pagesDocs, pageStatsRaw, cellsRaw] =
      await Promise.all([countriesPromise, pagesPromise, pageStatsPromise, cellsPromise]);

    // ── 2. Build lookup maps ────────────────────────────────────────────────

    // code → country entity
    const codeToCountry = new Map();
    for (const c of countryEntities) {
      if (c.country) codeToCountry.set(c.country, c);
    }

    // list → { total, been }
    const pageStats = new Map(pageStatsRaw.map(r => [r._id, r]));

    // list → Map(code → { count, been })
    const cellMap = new Map();
    for (const r of cellsRaw) {
      const { list, code } = r._id;
      if (!cellMap.has(list)) cellMap.set(list, new Map());
      cellMap.get(list).set(code, { count: r.count, been: r.been });
    }

    // ── 3. Compute per-country totals (for sorting + output) ────────────────
    const countryTotals = new Map(); // countryKey → total entity count
    const countryBeen   = new Map(); // countryKey → been count

    for (const [, codeCounts] of cellMap) {
      for (const [code, { count, been }] of codeCounts) {
        const entity = codeToCountry.get(code);
        if (!entity) continue;
        countryTotals.set(entity.key, (countryTotals.get(entity.key) || 0) + count);
        countryBeen.set(entity.key,   (countryBeen.get(entity.key)   || 0) + been);
      }
    }

    // ── 4. Build sorted countries array ────────────────────────────────────
    const sortedCountries = countryEntities
      .filter(c => c.country && codeToCountry.has(c.country))
      .sort((a, b) => (countryTotals.get(b.key) || 0) - (countryTotals.get(a.key) || 0));

    const countryIndex = new Map(sortedCountries.map((c, i) => [c.country, i]));
    const numCountries = sortedCountries.length;

    // ── 5. Build sorted pages array ─────────────────────────────────────────
    const sortedPages = pagesDocs
      .map(p => {
        const stats = pageStats.get(p.key) || { total: 0, been: 0 };
        return {
          key:   p.key,
          name:  p.name,
          icon:  p.icon || "",
          group: p.group,
          count: stats.total,
          been:  stats.total > 0 ? +(stats.been / stats.total).toFixed(3) : 0,
        };
      })
      .sort((a, b) => b.count - a.count);

    // ── 6. Build compressed data matrix ────────────────────────────────────
    const data = {};
    for (const page of sortedPages) {
      const codeCounts = cellMap.get(page.key) || new Map();
      const row = new Array(numCountries).fill(0);
      for (const [code, { count }] of codeCounts) {
        const idx = countryIndex.get(code);
        if (idx !== undefined) row[idx] = count;
      }
      data[page.key] = compressArray(row).join(",");
    }

    // ── 7. Compute grand total ──────────────────────────────────────────────
    let totalCount = 0;
    for (const [, stats] of pageStats) totalCount += stats.total;

    // ── 8. Assemble output ──────────────────────────────────────────────────
    const output = {
      countries: sortedCountries.map(c => {
        const total = countryTotals.get(c.key) || 0;
        const been  = countryBeen.get(c.key)   || 0;
        return {
          been:    total > 0 ? +(been / total).toFixed(3) : 0,
          count:   total,
          country: c.country,
          icon:    c.icons?.[0] || "",
          key:     c.key,
          name:    c.name,
        };
      }),
      data,
      pages: sortedPages.map(p => {
        const out = {
          been:  p.been,
          count: p.count,
          icon:  p.icon,
          key:   p.key,
          name:  p.name,
        };
        if (p.group) out.group = p.group;
        return out;
      }),
      totalCount,
    };

    // ── 9. Write file ───────────────────────────────────────────────────────
    await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf8");

    const kb      = (Buffer.byteLength(JSON.stringify(output)) / 1024).toFixed(0);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`\n✅ Wrote ${OUTPUT_PATH}`);
    console.log(`   ${sortedPages.length} pages · ${sortedCountries.length} countries · ${totalCount.toLocaleString()} total entities · ${kb} KB · ${elapsed}s\n`);

  } finally {
    await client.close();
  }
}
