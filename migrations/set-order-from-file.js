#!/usr/bin/env node
// set-order-from-file.js
//
// Sets the `order` field on entities in a list based on line number in a text file.
// Each line in the file should be an entity key. Order starts at 1.
//
// Usage:
//   node migrations/set-order-from-file.js <list> <file> [--dryrun]
//
// Example:
//   node migrations/set-order-from-file.js countries order.txt
//   node migrations/set-order-from-file.js countries order.txt --dryrun

import "dotenv/config";
import { MongoClient } from "mongodb";
import { readFileSync, existsSync } from "fs";

const DRYRUN = process.argv.includes("--dryrun");
const [list, filePath] = process.argv.filter((a, i) => i >= 2 && !a.startsWith("--"));

if (!list || !filePath) {
  console.error("Usage: node migrations/set-order-from-file.js <list> <file> [--dryrun]");
  process.exit(1);
}

if (!existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "andrewzc";
if (!URI) throw new Error("Missing MONGODB_URI in environment");

const keys = readFileSync(filePath, "utf8")
  .split("\n")
  .map(l => l.trim())
  .filter(Boolean);

console.log(`${keys.length} keys in file`);
if (DRYRUN) console.log("-- DRY RUN --\n");

const client = new MongoClient(URI);

async function main() {
  await client.connect();
  const entities = client.db(DB).collection("entities");

  let updated = 0;
  let notFound = [];

  for (let i = 0; i < keys.length; i++) {
    const key   = keys[i];
    const order = i + 1;

    if (DRYRUN) {
      const exists = await entities.findOne({ list, key }, { projection: { _id: 1 } });
      if (exists) {
        console.log(`  [dry] ${key} → order: ${order}`);
        updated++;
      } else {
        console.warn(`  NOT FOUND: ${key}`);
        notFound.push(key);
      }
      continue;
    }

    const result = await entities.updateOne({ list, key }, { $set: { order } });
    if (result.matchedCount) {
      console.log(`  ${key} → order: ${order}`);
      updated++;
    } else {
      console.warn(`  NOT FOUND: ${key}`);
      notFound.push(key);
    }
  }

  console.log(`\nDone. Updated: ${updated}, Not found: ${notFound.length}`);
  if (notFound.length) {
    console.log("Not found:");
    for (const k of notFound) console.log(`  ${k}`);
  }

  await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
