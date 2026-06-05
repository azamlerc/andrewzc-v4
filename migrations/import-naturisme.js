#!/usr/bin/env node
// import-naturisme.js
//
// Imports spa data from le-naturisme.com country pages into the spas list.
// Parses the Leaflet marker script for coords and the article section for
// name, link, address, city, and zip.
//
// Usage:
//   node migrations/import-naturisme.js <file.html> <country-code> [--dryrun]
//
// Examples:
//   node migrations/import-naturisme.js austria.html AT
//   node migrations/import-naturisme.js germany.html DE
//   node migrations/import-naturisme.js netherlands.html NL --dryrun
//
// Country codes and their flag emoji are derived from the country-code argument.
// If an entity with the same name already exists in the spas list, its address
// fields are updated. Otherwise a new entity is inserted.

import "dotenv/config";
import { MongoClient } from "mongodb";
import { readFileSync, existsSync } from "fs";
import { countryCodeToFlagEmoji, simplify } from "../utilities.js";

const DRYRUN = process.argv.includes("--dryrun");
const args   = process.argv.slice(2).filter(a => !a.startsWith("--"));
const [htmlFile, countryCode] = args;

if (!htmlFile || !countryCode) {
  console.error("Usage: node migrations/import-naturisme.js <file.html> <country-code> [--dryrun]");
  process.exit(1);
}

if (!existsSync(htmlFile)) {
  console.error(`File not found: ${htmlFile}`);
  process.exit(1);
}

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "andrewzc";
if (!URI) throw new Error("Missing MONGODB_URI in environment");

const flagEmoji    = countryCodeToFlagEmoji(countryCode.toUpperCase());
const countryUpper = countryCode.toUpperCase();

// ── Parse HTML ─────────────────────────────────────────────────────────────────

const html = readFileSync(htmlFile, "utf8");

// 1. Extract markers from the Leaflet script
//    L.marker([lat,lon], {...}).addTo(mymap).bindPopup("<b>Name</b><br /><a href='url'...")
const markerRegex = /L\.marker\(\[([0-9.-]+),([0-9.-]+)\][^)]*\)[^.]*\.addTo\([^)]*\)[^.]*\.bindPopup\("(.*?)"\)/gs;
const markerData = new Map(); // name → { lat, lon, link }

for (const m of html.matchAll(markerRegex)) {
  const lat   = parseFloat(m[1]);
  const lon   = parseFloat(m[2]);
  const popup = m[3];

  const nameMatch = popup.match(/<b>(.*?)<\/b>/);
  if (!nameMatch) continue;
  const name = nameMatch[1].trim();

  const linkMatch = popup.match(/href=['"]([^'"]+)['"]/);
  const link = linkMatch ? linkMatch[1] : null;

  markerData.set(name, { lat, lon, link });
}

console.log(`Found ${markerData.size} markers in Leaflet script`);

// 2. Extract address details from the article section
//    Format: "Name, Street, ZIP City, Country"
//    → address = street only, city and zip extracted separately
const entryRegex = /<h3>[^<]*<span[^>]*>\d+<\/span>\s*<span[^>]*>([^<]+)<\/span><\/h3>\s*<p><i[^>]*><\/i>\s*([^<]+?)\.\s*<a[^>]+>[\s\S]*?<\/p>/g;
const addressData = new Map(); // name → { address, city, zip }

for (const m of html.matchAll(entryRegex)) {
  const name     = m[1].trim();
  const fullAddr = m[2].trim();

  // fullAddr: "Name, Street, ZIP City, Country"
  const parts = fullAddr.split(",").map(s => s.trim());

  if (parts.length >= 3) {
    // Drop first (name) and last (country)
    const addrParts = parts.slice(1, -1);

    // Last part is "ZIP City"
    const zipCity  = addrParts[addrParts.length - 1].trim();
    const zipMatch = zipCity.match(/^(\S+)\s+(.+)$/);
    const zip  = zipMatch ? zipMatch[1] : null;
    const city = zipMatch ? zipMatch[2] : zipCity;

    // Street is everything before the zip/city part
    const street = addrParts.slice(0, -1).join(", ").trim() || null;

    addressData.set(name, { street, city, zip });
  }
}

console.log(`Found ${addressData.size} address entries in article`);

// ── Merge data ─────────────────────────────────────────────────────────────────

const entities = [];

for (const [name, marker] of markerData) {
  const addr     = addressData.get(name) || {};
  const lat      = marker.lat;
  const lon      = marker.lon;
  const coords   = `${lat.toFixed(8)}, ${lon.toFixed(8)}`;
  const location = { type: "Point", coordinates: [lon, lat] };

  entities.push({
    name,
    link:    marker.link,
    coords,
    location,
    address: addr.street ?? null,  // street only, not zip/city
    city:    addr.city   ?? null,
    zip:     addr.zip    ?? null,
    country: countryUpper,
    icons:   flagEmoji ? [flagEmoji] : [],
    been:    false,
  });
}

console.log(`\nMerged ${entities.length} entities:\n`);
for (const e of entities) {
  console.log(`  ${e.name}`);
  console.log(`    coords:  ${e.coords}`);
  console.log(`    link:    ${e.link}`);
  console.log(`    address: ${e.address}`);
  console.log(`    city:    ${e.city}, zip: ${e.zip}`);
}

if (DRYRUN) {
  console.log("\n-- DRY RUN — no writes --");
  process.exit(0);
}

// ── Upsert to MongoDB ──────────────────────────────────────────────────────────

const client = new MongoClient(URI);
await client.connect();
const col = client.db(DB).collection("entities");

let inserted = 0, updated = 0;

for (const entity of entities) {
  const existing = await col.findOne({ list: "spas", name: entity.name });

  if (existing) {
    const patch = {};
    if (entity.address) patch.address = entity.address;
    if (entity.city)    patch.city    = entity.city;
    if (entity.zip)     patch.zip     = entity.zip;

    if (Object.keys(patch).length > 0) {
      await col.updateOne({ _id: existing._id }, { $set: patch });
      console.log(`  ✏️  Updated: ${entity.name}`);
    } else {
      console.log(`  ✓  Unchanged: ${entity.name}`);
    }
    updated++;
  } else {
    const baseKey = simplify(entity.name);
    let key = baseKey;
    let i   = 2;
    while (await col.findOne({ list: "spas", key })) {
      key = `${baseKey}-${i++}`;
    }

    await col.insertOne({ ...entity, key, list: "spas" });
    console.log(`  ➕ Inserted: ${entity.name} (${key})`);
    inserted++;
  }
}

console.log(`\nDone. Inserted: ${inserted}, Updated: ${updated}.`);
await client.close();
