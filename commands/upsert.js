// andrewzc upsert <file.csv|json> [list]
// Upsert entities from a file with full enrichment cascade.
// See README for full details.

import { MongoClient } from "mongodb";
import { readFileSync } from "fs";
import { parse } from "csv-parse/sync";
import path from "path";
import {
  computeKey, countryCodeToFlagEmoji, countryCodesFromIcons,
  findNearestCity, parseCoords, formatCoords,
} from "../utilities.js";
import { getCoordsFromUrl } from "../../andrewzc-api/wiki.js";

function coerceValue(v) {
  if (v === "true")  return true;
  if (v === "false") return false;
  if (v === "null" || v === "") return null;
  if (!isNaN(v) && v.trim() !== "") return Number(v);
  return v;
}

function setNested(obj, dotPath, value) {
  const parts = dotPath.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

async function searchWikipediaLink(name) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&format=json&origin=*`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const title = json?.query?.search?.[0]?.title;
  if (!title) return null;
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

export async function run([filePath, listArg], _opts) {
  if (!filePath) {
    console.error("Usage: andrewzc upsert <file.csv|json> [list]");
    process.exit(1);
  }

  const ext = path.extname(filePath).toLowerCase();
  if (![".csv", ".json"].includes(ext)) {
    console.error("File must be .csv or .json"); process.exit(1);
  }

  const raw = readFileSync(path.resolve(filePath), "utf8");
  let rows;

  if (ext === ".json") {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      rows = parsed;
    } else if (typeof parsed === "object" && parsed !== null) {
      rows = Object.entries(parsed).filter(([k]) => k !== "--info--").map(([, v]) => v);
    } else {
      rows = [parsed];
    }
  } else {
    rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true }).map(row => {
      const doc = {};
      for (const [header, value] of Object.entries(row)) setNested(doc, header, coerceValue(value));
      return doc;
    });
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db  = client.db(process.env.MONGODB_DB || "andrewzc");
  const col = db.collection("entities");

  const pageCache = {};
  async function getPageTags(list) {
    if (pageCache[list] !== undefined) return pageCache[list];
    const page = await db.collection("pages").findOne({ key: list }, { projection: { tags: 1 } });
    pageCache[list] = page?.tags ?? [];
    return pageCache[list];
  }

  let inserted = 0, updated = 0, skipped = 0;
  const errors = [], warnings = [];

  for (const row of rows) {
    const doc = Object.fromEntries(
      Object.entries(row).filter(([, v]) => v !== null && v !== undefined)
    );

    const list = doc.list ?? listArg;
    if (!list) { skipped++; errors.push(`Row missing list: ${JSON.stringify(doc)}`); continue; }
    doc.list = list;

    if (!doc.name) { skipped++; errors.push(`[${list}] Row missing name: ${JSON.stringify(doc)}`); continue; }
    if (doc.key)   { skipped++; errors.push(`[${list}] "${doc.name}" — 'key' must not be in input`); continue; }

    const tags = await getPageTags(list);
    const requiresReference = tags.includes("reference") && !tags.includes("reference-optional");

    if (requiresReference && !doc.reference) {
      skipped++; errors.push(`[${list}] "${doc.name}" — page requires reference but none provided`); continue;
    }

    if (doc.country && !doc.icons) {
      const flag = countryCodeToFlagEmoji(doc.country);
      if (flag) doc.icons = [flag];
      else warnings.push(`[${list}] "${doc.name}" — could not convert country "${doc.country}" to flag`);
    } else if (doc.icons && !doc.country) {
      const codes = countryCodesFromIcons(doc.icons);
      if (codes.length === 1) doc.country = codes[0];
      else if (codes.length > 1) doc.country = codes;
    }

    const key = computeKey(doc, tags);
    if (!key) { skipped++; errors.push(`[${list}] "${doc.name}" — could not compute key`); continue; }
    doc.key = key;

    const existing = await col.findOne({ key, list }, { projection: { link: 1, coords: 1, location: 1, city: 1, reference: 1 } });

    if (!doc.link && !existing?.link) {
      const found = await searchWikipediaLink(doc.name);
      if (found) { doc.link = found; console.log(`  🔍 ${doc.name}: ${found}`); }
    }

    const skipCoords = tags.includes("no-coords") || tags.includes("people");
    if (!skipCoords && doc.coords) {
      const parsed = parseCoords(doc.coords);
      if (parsed) {
        doc.coords   = formatCoords(parsed);
        doc.location = { type: "Point", coordinates: [parsed.lon, parsed.lat] };
      } else {
        warnings.push(`[${list}] "${doc.name}" — could not parse coords: "${doc.coords}"`);
        delete doc.coords;
      }
    }

    const hasCoords   = doc.coords || (existing?.coords && existing.coords !== "not-found");
    const linkToFetch = doc.link ?? existing?.link;
    if (!skipCoords && !hasCoords && linkToFetch && /wikipedia\.org|booking\.com|airbnb\.com/.test(linkToFetch)) {
      const result = await getCoordsFromUrl(linkToFetch, { list });
      if (result) {
        doc.coords   = result.coords;
        doc.location = result.location;
        console.log(`  📍 ${doc.name}: ${result.coords}`);
      } else {
        console.log(`  ⚠️  ${doc.name}: coords not found`);
      }
    }

    const locationForCity = doc.location ?? existing?.location;
    if (!skipCoords && locationForCity && !doc.city && !existing?.city) {
      const city = await findNearestCity(locationForCity, col);
      if (city) { doc.city = city; console.log(`  🏙️  ${doc.name}: city = ${city}`); }
    }

    const needsReference = tags.includes("reference") || tags.includes("reference-optional");
    const hasReference   = doc.reference || existing?.reference;
    if (needsReference && !hasReference && doc.city) {
      doc.reference = doc.city;
      console.log(`  📎 ${doc.name}: reference = ${doc.reference}`);
    }

    if (requiresReference && !doc.reference && !existing?.reference) {
      skipped++; errors.push(`[${list}] "${doc.name}" — required reference could not be derived`); continue;
    }

    if (doc.reference && !existing?.reference) doc.key = computeKey(doc, tags);
    if (doc.been == null && !existing) doc.been = false;

    const result = await col.updateOne({ key, list }, { $set: doc }, { upsert: true });
    const icons  = Array.isArray(doc.icons) ? doc.icons.join(" ") : (doc.icons ?? "");
    const label  = [icons, doc.name].filter(Boolean).join(" ");

    if (result.upsertedCount) { inserted++; console.log(`added   ${label}`); }
    else if (result.modifiedCount) { updated++; console.log(`updated ${label}`); }
  }

  console.log(`\n=== upsert: ${path.basename(filePath)} ===`);
  console.log(`Inserted: ${inserted}  Updated: ${updated}  Skipped: ${skipped}`);
  if (warnings.length) { console.log(`\n⚠️  Warnings:`); warnings.forEach(w => console.log(`  ${w}`)); }
  if (errors.length)   { console.log(`\n❌ Errors:`);   errors.forEach(e => console.log(`  ${e}`)); }

  await client.close();
}
