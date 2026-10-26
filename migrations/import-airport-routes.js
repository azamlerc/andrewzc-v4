#!/usr/bin/env node
// Import the active AIRPORT_ROUTES pairs without executing browser JavaScript.
// Run from andrewzc-v4 (uses its .env):
//   node migrations/import-airport-routes.js --dryrun
//   node migrations/import-airport-routes.js
// Optional: --source /path/to/airports.js
// Optional: --airport-map /path/to/map.json (IATA code -> airport entity key).
// Historical DEN/OSL/BLR/HKG connections use the newer airport for world maps.
// --airport-map can override these defaults when needed.
// Existing routes are preserved. Unresolved/ambiguous airports or conflicting
// route keys abort the entire preflight before any writes.

import "dotenv/config";
import { MongoClient } from "mongodb";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_AIRPORT_MAP = Object.freeze({
  DEN: "denver-international",
  OSL: "oslo-gardermoen",
  BLR: "bengaluru-kempegowda",
  HKG: "hong-kong-chek-lap-kok",
});

export function parseAirportPairs(source) {
  const block = source.match(/const\s+AIRPORT_ROUTES\s*=\s*\[([\s\S]*?)\n\];/);
  if (!block) throw new Error("Could not find AIRPORT_ROUTES array");
  const pairs = new Map();
  for (const raw of block[1].split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    const match = line.match(/^\["([A-Z]{3})",\s*"([A-Z]{3})"\],?$/);
    if (!match) throw new Error(`Invalid airport pair: ${line}`);
    const codes = match.slice(1).sort();
    if (codes[0] === codes[1]) throw new Error(`Self-connection: ${codes[0]}`);
    pairs.set(codes.join("-"), codes);
  }
  if (!pairs.size) throw new Error("No active airport pairs found");
  return [...pairs.values()].sort((a, b) => a.join("-").localeCompare(b.join("-")));
}

export function buildRoutes(pairs, airports, airportMap = {}) {
  if (!airportMap || typeof airportMap !== "object" || Array.isArray(airportMap)) {
    throw new Error("Airport map must be an object mapping codes to entity keys");
  }
  airportMap = { ...DEFAULT_AIRPORT_MAP, ...airportMap };
  const byCode = new Map();
  for (const airport of airports) {
    const code = String(airport.prefix || "").trim().toUpperCase();
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(airport);
  }
  const errors = [];
  for (const code of new Set(pairs.flat())) {
    let matches = byCode.get(code) || [];
    if (Object.hasOwn(airportMap, code)) {
      matches = matches.filter(airport => airport.key === airportMap[code]);
      byCode.set(code, matches);
    }
    if (matches.length !== 1 || !matches[0].key) {
      errors.push(`${code}: ${matches.length ? `ambiguous/invalid (${matches.map(a => a.key).join(", ")})` : "not found"}`);
    }
  }
  if (errors.length) throw new Error(`Cannot resolve airport codes:\n${errors.join("\n")}`);
  return pairs.map(codes => ({
    key: codes.join("-").toLowerCase(),
    name: codes.join("–"),
    mode: "air",
    stops: codes.map(code => ({ list: "airports", key: byCode.get(code)[0].key })),
    path: { kind: "great-circle" },
  }));
}

export function planInserts(routes, existing) {
  const pending = [];
  for (const route of routes) {
    const matches = existing.filter(doc => doc.key === route.key);
    if (!matches.length) { pending.push(route); continue; }
    const doc = matches[0];
    if (matches.length !== 1 || doc.mode !== route.mode || doc.path?.kind !== route.path.kind ||
        doc.stops?.length !== 2 || !route.stops.every((stop, i) =>
          doc.stops[i]?.list === stop.list && doc.stops[i]?.key === stop.key)) {
      throw new Error(`Conflicting existing route: ${route.key}`);
    }
  }
  return pending;
}

async function main() {
  const args = process.argv.slice(2);
  let sourcePath = fileURLToPath(new URL("../../andrewzc.net/airports.js", import.meta.url));
  let dryRun = false;
  let airportMap = {};
  for (let i = 0; i < args.length; i++) {
    if (["--dryrun", "--dry-run"].includes(args[i])) dryRun = true;
    else if (args[i] === "--source" && args[i + 1]) sourcePath = resolve(args[++i]);
    else if (args[i] === "--airport-map" && args[i + 1]) {
      airportMap = JSON.parse(readFileSync(resolve(args[++i]), "utf8"));
    }
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  const pairs = parseAirportPairs(readFileSync(sourcePath, "utf8"));
  if (!process.env.MONGODB_URI) throw new Error("Missing MONGODB_URI in environment");
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || "andrewzc");
    const airports = await db.collection("entities").find({ list: "airports" },
      { projection: { key: 1, prefix: 1 } }).toArray();
    const routes = buildRoutes(pairs, airports, airportMap);
    const collection = db.collection("routes");
    const existing = await collection.find({ key: { $in: routes.map(route => route.key) } }).toArray();
    const pending = planInserts(routes, existing);
    console.log(`${routes.length} routes; ${routes.length - pending.length} already exist; ${pending.length} to insert.`);
    for (const route of pending) console.log(JSON.stringify(route));
    if (dryRun) { console.log("DRY RUN: no changes written."); return; }
    await collection.createIndex({ key: 1 }, { unique: true });
    if (pending.length) {
      const result = await collection.bulkWrite(pending.map(route => ({ updateOne: {
        filter: { key: route.key }, update: { $setOnInsert: route }, upsert: true,
      } })));
      console.log(`Inserted ${result.upsertedCount} routes.`);
    }
  } finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
