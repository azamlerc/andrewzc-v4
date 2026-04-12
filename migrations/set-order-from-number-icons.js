#!/usr/bin/env node
// set-order-from-number-icons.js
//
// Sets the `order` field on music-numbers entities by parsing the number
// represented by the digit emoji in the icons array.
//
// Digit emoji 0️⃣–9️⃣ are mapped to integers and joined to form the number.
// Non-digit emoji (e.g. 🥧 for π) are skipped — those entities get no order.
//
// Usage:
//   node migrations/set-order-from-number-icons.js [--dryrun]

import "dotenv/config";
import { MongoClient } from "mongodb";

const DRYRUN = process.argv.includes("--dryrun");

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "andrewzc";
if (!URI) throw new Error("Missing MONGODB_URI in environment");

// Map digit emoji codepoints to digit characters
// 0️⃣ = U+0030 U+FE0F U+20E3, but stored as the combined emoji sequence
const DIGIT_MAP = new Map([
  ["0️⃣", "0"], ["1️⃣", "1"], ["2️⃣", "2"], ["3️⃣", "3"], ["4️⃣", "4"],
  ["5️⃣", "5"], ["6️⃣", "6"], ["7️⃣", "7"], ["8️⃣", "8"], ["9️⃣", "9"],
]);

function iconsToOrder(icons) {
  if (!Array.isArray(icons) || icons.length === 0) return null;
  const digits = icons.map(i => DIGIT_MAP.get(i)).filter(Boolean);
  if (digits.length === 0) return null;
  // Only use the result if ALL icons were digit emoji (no mix of digits + non-digits)
  // This avoids misinterpreting partial matches
  if (digits.length !== icons.length) return null;
  return parseInt(digits.join(""), 10);
}

const client = new MongoClient(URI);

async function main() {
  await client.connect();
  const entities = client.db(DB).collection("entities");

  const docs = await entities
    .find({ list: "music-numbers" }, { projection: { _id: 1, key: 1, icons: 1 } })
    .toArray();

  console.log(`Found ${docs.length} music-numbers entities`);
  if (DRYRUN) console.log("-- DRY RUN --\n");

  let updated = 0, skipped = 0;

  for (const doc of docs) {
    const order = iconsToOrder(doc.icons);
    if (order === null) {
      console.log(`  SKIP ${doc.key} [${(doc.icons || []).join(" ")}] — no digit emoji`);
      skipped++;
      continue;
    }

    console.log(`  ${DRYRUN ? "[dry] " : ""}${doc.key} → order: ${order}`);
    if (!DRYRUN) {
      await entities.updateOne({ _id: doc._id }, { $set: { order } });
    }
    updated++;
  }

  console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}`);
  await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
