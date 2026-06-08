#!/usr/bin/env node
// set-france-department-order.js
//
// Sets the `order` field on france list entities by parsing the department
// number from the digit emoji in the icons array, skipping any flag emoji.
//
// Examples:
//   ["🇫🇷", "0️⃣", "1️⃣"]  → order: 1   (Ain, dept 01)
//   ["🇫🇷", "7️⃣", "5️⃣"]  → order: 75  (Paris)
//   ["🇫🇷", "3️⃣", "3️⃣"]  → order: 33  (Gironde, previously broken)
//   ["🇬🇵", "9️⃣", "7️⃣", "1️⃣"] → order: 971 (Guadeloupe)
//   ["🇫🇷", "2️⃣", "A️⃣"]  → skipped   (Corse 2A/2B — not pure digits)
//
// Usage:
//   node migrations/set-france-department-order.js [--dryrun]

import "dotenv/config";
import { MongoClient } from "mongodb";

const DRYRUN = process.argv.includes("--dryrun");
const URI    = process.env.MONGODB_URI;
const DB     = process.env.MONGODB_DB || "andrewzc";

if (!URI) throw new Error("Missing MONGODB_URI in environment");

const DIGIT_MAP = new Map([
  ["0️⃣", "0"], ["1️⃣", "1"], ["2️⃣", "2"], ["3️⃣", "3"], ["4️⃣", "4"],
  ["5️⃣", "5"], ["6️⃣", "6"], ["7️⃣", "7"], ["8️⃣", "8"], ["9️⃣", "9"],
]);

// Returns true if the emoji is a regional indicator flag (any country/region)
function isFlag(emoji) {
  if (!emoji) return false;
  // Regional indicator letters are U+1F1E6–U+1F1FF
  const cp = emoji.codePointAt(0);
  return cp >= 0x1F1E6 && cp <= 0x1F1FF;
}

function iconsToOrder(icons) {
  if (!Array.isArray(icons) || icons.length === 0) return null;

  // Strip flag emoji, keep only digit emoji
  const nonFlags = icons.filter(i => !isFlag(i));
  if (nonFlags.length === 0) return null;

  const digits = nonFlags.map(i => DIGIT_MAP.get(i));

  // If any non-flag icon wasn't a digit emoji, skip (e.g. Corse 2A)
  if (digits.some(d => d === undefined)) return null;

  return parseInt(digits.join(""), 10);
}

const client = new MongoClient(URI);

async function main() {
  await client.connect();
  const entities = client.db(DB).collection("entities");

  const docs = await entities
    .find({ list: "france" }, { projection: { _id: 1, key: 1, name: 1, icons: 1 } })
    .sort({ key: 1 })
    .toArray();

  console.log(`Found ${docs.length} france entities`);
  if (DRYRUN) console.log("-- DRY RUN --\n");

  let updated = 0, skipped = 0;

  for (const doc of docs) {
    const order = iconsToOrder(doc.icons);
    if (order === null) {
      console.log(`  SKIP  ${doc.key} (${doc.name}) [${(doc.icons || []).join(" ")}]`);
      skipped++;
      continue;
    }

    console.log(`  ${DRYRUN ? "[dry] " : "SET   "}${doc.key} (${doc.name}) → order: ${order}`);
    if (!DRYRUN) {
      await entities.updateOne({ _id: doc._id }, { $set: { order } });
    }
    updated++;
  }

  console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}`);
  await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
