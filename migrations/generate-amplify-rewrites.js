#!/usr/bin/env node
// generate-amplify-rewrites.js
//
// Loads all pages from MongoDB and outputs a JSON array of Amplify rewrite
// rules, one per page, mapping /<key> → /page.html?id=<key>.
//
// Usage:
//   node migrations/generate-amplify-rewrites.js
//   node migrations/generate-amplify-rewrites.js > amplify-rewrites.json

import "dotenv/config";
import { MongoClient } from "mongodb";

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "andrewzc";

if (!URI) throw new Error("Missing MONGODB_URI in environment");

const client = new MongoClient(URI);

async function main() {
  await client.connect();
  const db = client.db(DB);
  const pages = await db.collection("pages")
    .find({}, { projection: { key: 1 } })
    .sort({ key: 1 })
    .toArray();

  const rules = pages.map(({ key }) => ({
    source: `/${key}`,
    status: "200",
    target: `/page.html?id=${key}`,
    condition: null
  }));

  console.log(JSON.stringify(rules, null, 2));
  await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
