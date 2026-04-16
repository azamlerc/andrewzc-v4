#!/usr/bin/env node
// scan-s3-images.js
//
// Scans the andrewzc-imagine S3 bucket and creates records in the "images"
// collection for every image file found.
//
// Path conventions:
//   imagine/{model}/{prompt-id}{style-suffix}.jpg
//   animals/{artist-id}/{artist-id}-{AnimalName}{style-suffix}.jpg
//
// Style suffixes: -lego, -anime, -art, -pixar (absent = "photo")
//
// Usage:
//   node migrations/scan-s3-images.js [--dryrun]

import "dotenv/config";
import { MongoClient } from "mongodb";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const DRYRUN = process.argv.includes("--dryrun");
const BUCKET = process.env.S3_BUCKET || "andrewzc-imagine";

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB  = process.env.MONGODB_DB || "andrewzc";
if (!MONGODB_URI) throw new Error("Missing MONGODB_URI in environment");

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ── Style suffix parsing ──────────────────────────────────────────────────────

const STYLE_SUFFIXES = ["lego", "anime", "art", "pixar"];

// Given a base filename without extension, extract the style suffix if present.
// Returns { stem, style } where stem is the filename without the suffix.
function parseStyle(base) {
  for (const style of STYLE_SUFFIXES) {
    if (base.endsWith(`-${style}`)) {
      return { stem: base.slice(0, -(style.length + 1)), style };
    }
  }
  return { stem: base, style: "photo" };
}

// ── Path parsing ──────────────────────────────────────────────────────────────

// Returns a record object or null if the path should be skipped.
function parsePath(key, lastModified) {
  // Skip thumbnail directories and non-jpg files
  if (key.includes("/tn/")) return null;
  if (!key.endsWith(".jpg") && !key.endsWith(".png")) return null;

  const parts = key.split("/");
  if (parts.length < 3) return null;

  const project = parts[0]; // "imagine" or "animals"
  const filename = parts[parts.length - 1];
  const base = filename.replace(/\.(jpg|png)$/, "");

  if (project === "imagine") {
    // imagine/{model}/{prompt-id}{style-suffix}.jpg
    const model = parts[1];
    const { stem: promptId, style } = parseStyle(base);

    // Skip counter variants (diet-coke1.jpg, diet-coke2.jpg) — these are
    // duplicates from the old getNextAvailableFilename logic. A trailing digit
    // that isn't part of the original prompt id indicates a duplicate.
    // Heuristic: skip if the last character of the stem is a digit AND
    // it is not preceded by a hyphen (e.g. "diet-coke1" vs "area-51").
    const lastChar = promptId.slice(-1);
    const secondLastChar = promptId.slice(-2, -1);
    if (/\d/.test(lastChar) && secondLastChar !== "-") {
      return null; // skip duplicate variant
    }

    return {
      project: "imagine",
      model,
      promptId,
      style,
      createdAt: lastModified,
    };
  }

  if (project === "animals") {
    // animals/{artist-id}/{artist-id}-{AnimalName}{style-suffix}.jpg
    const artistId = parts[1];
    const prefix = `${artistId}-`;
    if (!base.startsWith(prefix)) return null;

    const remainder = base.slice(prefix.length); // "Camel" or "Camel-lego"
    const { stem: animal, style } = parseStyle(remainder);

    return {
      project: "animals",
      model: "openai",
      artistId,
      animal,
      style,
      createdAt: lastModified,
    };
  }

  return null;
}

// ── S3 listing ────────────────────────────────────────────────────────────────

async function* listAllObjects(prefix) {
  let continuationToken;
  do {
    const cmd = new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });
    const res = await s3.send(cmd);
    for (const obj of res.Contents || []) {
      yield obj;
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);
}

// ── Dry run sampling ──────────────────────────────────────────────────────────

// For dry run: list a few folders per project and sample a few files each.
async function dryRunSample() {
  const projects = ["imagine", "animals"];
  const results = [];

  for (const project of projects) {
    console.log(`\n── ${project} ─────────────────────────────────────────────`);

    // List top-level folders (model or artist) under this project
    const listCmd = new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: `${project}/`,
      Delimiter: "/",
    });
    const res = await s3.send(listCmd);
    const folders = (res.CommonPrefixes || []).map(p => p.Prefix);

    // Sample up to 3 folders
    const sampleFolders = folders.slice(0, 3);
    console.log(`  ${folders.length} folder(s) found, sampling ${sampleFolders.length}:`);

    for (const folder of sampleFolders) {
      console.log(`\n  ${folder}`);

      // List up to 10 files in this folder, show first 5 parseable ones
      const fileCmd = new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: folder,
        MaxKeys: 10,
      });
      const fileRes = await s3.send(fileCmd);
      const files = fileRes.Contents || [];

      for (const obj of files.slice(0, 5)) {
        const record = parsePath(obj.Key, obj.LastModified);
        if (record) {
          console.log(`    ${obj.Key}`);
          console.log(`    → ${JSON.stringify(record)}`);
          results.push(record);
        } else {
          console.log(`    ${obj.Key} → (skipped)`);
        }
      }
    }
  }

  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (DRYRUN) {
    console.log("── DRY RUN ──────────────────────────────────────────────────");
    console.log(`Bucket: ${BUCKET}\n`);
    const sample = await dryRunSample();
    console.log(`\nSample produced ${sample.length} parseable record(s).`);
    console.log("Run without --dryrun to process all files.");
    return;
  }

  // Full run
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db     = client.db(MONGODB_DB);
  const images = db.collection("images");

  // Build a set of existing records to avoid duplicates on re-runs.
  const existingKeys = new Set();
  const existing = await images.find({}, {
    projection: { project: 1, model: 1, promptId: 1, artistId: 1, animal: 1, style: 1 }
  }).toArray();

  for (const doc of existing) {
    existingKeys.add(recordKey(doc));
  }
  console.log(`${existingKeys.size} existing records in images collection.`);

  const toInsert = [];
  let scanned = 0, skipped = 0, duplicate = 0;

  for (const prefix of ["imagine/", "animals/"]) {
    console.log(`\nScanning ${prefix}...`);
    for await (const obj of listAllObjects(prefix)) {
      scanned++;
      const record = parsePath(obj.Key, obj.LastModified);
      if (!record) { skipped++; continue; }

      const key = recordKey(record);
      if (existingKeys.has(key)) { duplicate++; continue; }

      toInsert.push(record);
      existingKeys.add(key); // prevent duplicates within this batch
    }
  }

  console.log(`\nScanned: ${scanned}, Skipped: ${skipped}, Duplicates: ${duplicate}, To insert: ${toInsert.length}`);

  if (toInsert.length > 0) {
    const CHUNK = 1000;
    let inserted = 0;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const batch = toInsert.slice(i, i + CHUNK);
      await images.insertMany(batch, { ordered: false });
      inserted += batch.length;
      process.stdout.write(`\rInserted ${inserted}/${toInsert.length}...`);
    }
    console.log(`\nDone. Inserted ${inserted} records.`);
  } else {
    console.log("Nothing to insert.");
  }

  await client.close();
}

function recordKey(doc) {
  if (doc.project === "imagine") {
    return `imagine|${doc.model}|${doc.promptId}|${doc.style}`;
  } else {
    return `animals|${doc.artistId}|${doc.animal}|${doc.style}`;
  }
}

main().catch(err => { console.error(err); process.exit(1); });
