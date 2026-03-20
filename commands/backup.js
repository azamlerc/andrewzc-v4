// andrewzc backup
// Dump all collections to JSON files in a dated directory.
//
// Usage:
//   node andrewzc.js backup [--out <dir>]
//
// Output: ~/Backups/andrewzc/<YYYY-MM-DD>/<collection>.json
// Override with: --out /path/to/dir
//
// The entities collection has wikiEmbedding stripped (large, regenerable).
// All other collections are dumped in full.
// Each file is newline-delimited JSON (one document per line),
// readable by mongoimport --mode=upsert.

import { MongoClient } from "mongodb";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB  = process.env.MONGODB_DB || "andrewzc";

// Collections to back up, and any fields to strip (via projection).
const COLLECTIONS = [
  { name: "pages" },
  { name: "entities",   strip: { wikiEmbedding: 0 } },
  { name: "activities" },
  { name: "accounts",   strip: { passwordHash: 0 } },  // never back up credentials
  { name: "sessions",   skip: true },                   // ephemeral, not worth backing up
];

export async function run(args, _opts) {
  // Parse --out flag
  const outIdx = args.indexOf("--out");
  const outDir = outIdx !== -1 && args[outIdx + 1]
    ? args[outIdx + 1]
    : join(homedir(), "Backups", "andrewzc", new Date().toISOString().slice(0, 10));

  await mkdir(outDir, { recursive: true });
  console.log(`\n💾 Backing up ${MONGODB_DB} → ${outDir}\n`);

  const client = new MongoClient(MONGODB_URI);
  await client.connect();

  try {
    const db = client.db(MONGODB_DB);

    for (const { name, strip = {}, skip = false } of COLLECTIONS) {
      if (skip) {
        console.log(`  ⏭  ${name} — skipped`);
        continue;
      }

      const projection = { ...strip };
      const docs = await db.collection(name)
        .find({}, Object.keys(projection).length ? { projection } : {})
        .toArray();

      const ndjson = docs.map(d => JSON.stringify(d)).join("\n") + "\n";
      const outPath = join(outDir, `${name}.json`);
      await writeFile(outPath, ndjson, "utf8");

      const kb = (Buffer.byteLength(ndjson) / 1024).toFixed(0);
      const stripped = Object.keys(strip).length
        ? `  (stripped: ${Object.keys(strip).join(", ")})`
        : "";
      console.log(`  ✅ ${name.padEnd(14)} ${String(docs.length).padStart(6)} docs  ${String(kb).padStart(7)} KB${stripped}`);
    }
  } finally {
    await client.close();
  }

  console.log("\n✅ Backup complete.\n");
}
