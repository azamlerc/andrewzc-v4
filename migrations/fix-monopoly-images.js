#!/usr/bin/env node
// fix-monopoly-images.js
// One-time migration: rename `image` -> `images` (array) and strip path prefix
// on all monopoly entities.

import "dotenv/config";
import { MongoClient } from "mongodb";

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "andrewzc";
if (!URI) throw new Error("Missing MONGODB_URI in environment");

const client = new MongoClient(URI);

async function main() {
  await client.connect();
  const entities = client.db(DB).collection("entities");

  const docs = await entities.find(
    { list: "monopoly", image: { $exists: true } },
    { projection: { _id: 1, key: 1, image: 1 } }
  ).toArray();

  console.log(`Found ${docs.length} monopoly entities with image field`);

  for (const doc of docs) {
    const filename = doc.image.replace("images/monopoly/", "");
    await entities.updateOne(
      { _id: doc._id },
      { $set: { images: [filename] }, $unset: { image: "" } }
    );
    console.log(`  ${doc.key} → images: ["${filename}"]`);
  }

  console.log("Done.");
  await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
