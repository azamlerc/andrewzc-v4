#!/usr/bin/env node
// abbreviate-us-states.js
//
// For entities in a list whose name ends with ", <US State Name>",
// replaces the state name with its two-letter abbreviation.
// e.g. "Wishon, California" → "Wishon, CA"
//
// Ignores names that don't end with a recognised US state name.
//
// Usage:
//   node migrations/abbreviate-us-states.js <list> [--dryrun]

import "dotenv/config";
import { MongoClient } from "mongodb";

const DRYRUN = process.argv.includes("--dryrun");
const [list] = process.argv.slice(2).filter(a => !a.startsWith("--"));

if (!list) {
  console.error("Usage: node migrations/abbreviate-us-states.js <list> [--dryrun]");
  process.exit(1);
}

const STATE_CODES = {
  "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR",
  "California": "CA", "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE",
  "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID",
  "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS",
  "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD",
  "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS",
  "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV",
  "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
  "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK",
  "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC",
  "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX", "Utah": "UT",
  "Vermont": "VT", "Virginia": "VA", "Washington": "WA", "West Virginia": "WV",
  "Wisconsin": "WI", "Wyoming": "WY",
};

// Build a regex that matches ", <State Name>" at end of string
// Sorted longest-first so "New Hampshire" matches before "New"
const stateNames = Object.keys(STATE_CODES).sort((a, b) => b.length - a.length);
const stateRegex = new RegExp(`,\\s*(${stateNames.map(s => s.replace(/ /g, "\\s+")).join("|")})\\s*$`);

function abbreviate(name) {
  const m = name.match(stateRegex);
  if (!m) return null;
  const stateName = m[1].replace(/\s+/g, " ").trim();
  const code = STATE_CODES[stateName];
  if (!code) return null;
  return name.replace(m[0], `, ${code}`);
}

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "andrewzc";
if (!URI) throw new Error("Missing MONGODB_URI in environment");

const client = new MongoClient(URI);

async function main() {
  await client.connect();
  const col = client.db(DB).collection("entities");

  if (DRYRUN) console.log("-- DRY RUN --\n");

  const docs = await col
    .find({ list }, { projection: { _id: 1, key: 1, name: 1 } })
    .toArray();

  console.log(`Checking ${docs.length} entities in "${list}"...\n`);

  let updated = 0;

  for (const doc of docs) {
    const newName = abbreviate(doc.name);
    if (!newName) continue;

    console.log(`  ${DRYRUN ? "[dry] " : ""}${doc.key}: "${doc.name}" → "${newName}"`);

    if (!DRYRUN) {
      await col.updateOne({ _id: doc._id }, { $set: { name: newName } });
    }
    updated++;
  }

  console.log(`\nDone. Updated: ${updated}.`);
  await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
