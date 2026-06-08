#!/usr/bin/env node
// move-icons-to-badges.js
//
// For entities on a given page that have more than one icon, moves all icons
// after the first into the badges array. The first icon (typically a country
// flag) is kept. Any existing badges are preserved.
//
// Usage:
//   node migrations/move-icons-to-badges.js --list <list-key> [--dryrun]
//
// Examples:
//   node migrations/move-icons-to-badges.js --list deaths --dryrun
//   node migrations/move-icons-to-badges.js --list deaths

import "dotenv/config";
import { MongoClient } from "mongodb";

const DRYRUN  = process.argv.includes("--dryrun");
const listArg = (() => { const i = process.argv.indexOf("--list"); return i >= 0 ? process.argv[i + 1] : null; })();

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "andrewzc";

if (!URI)      throw new Error("Missing MONGODB_URI in environment");
if (!listArg)  throw new Error("Usage: move-icons-to-badges.js --list <list-key> [--dryrun]");

const client = new MongoClient(URI);

async function main() {
  await client.connect();
  const entities = client.db(DB).collection("entities");

  const docs = await entities.find(
    { list: listArg, "icons.1": { $exists: true } }, // icons array has at least 2 elements
    { projection: { key: 1, name: 1, icons: 1, badges: 1 } }
  ).sort({ key: 1 }).toArray();

  console.log(`Found ${docs.length} entities on "${listArg}" with more than one icon.`);
  if (DRYRUN) console.log("-- DRY RUN --\n");

  let updated = 0;

  for (const doc of docs) {
    const [firstIcon, ...extraIcons] = doc.icons;
    const existingBadges = doc.badges || [];
    const newBadges = [...existingBadges, ...extraIcons];

    console.log(`  ${DRYRUN ? "[dry]" : "SET"} ${doc.key} (${doc.name})`);
    console.log(`    icons:  [${doc.icons.join(", ")}] → [${firstIcon}]`);
    console.log(`    badges: [${existingBadges.join(", ") || "—"}] → [${newBadges.join(", ")}]`);

    if (!DRYRUN) {
      await entities.updateOne(
        { _id: doc._id },
        { $set: { icons: [firstIcon], badges: newBadges } }
      );
    }
    updated++;
  }

  console.log(`\nDone. ${DRYRUN ? "Would update" : "Updated"}: ${updated} entities.`);
  await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
