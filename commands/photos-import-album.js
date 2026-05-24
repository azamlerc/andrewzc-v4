// commands/photos-import-album.js
//
// Interactively import photos from an exported osxphotos JSON album into a
// new page on andrewzc.net, creating entities and uploading photos.
//
// Photos are clustered by location (greedy, within --radius metres).
// For each cluster the script opens the first photo in Apple Photos and
// presents name candidates from:
//   1. place_names from Photos metadata
//   2. Nearby entities from the andrewzc DB (all lists)
//   3. city from Photos metadata (fallback)
// The AI caption is shown for fun/inspiration.
//
// Progress is saved to import-progress/<album>-progress.json after each
// cluster so you can resume safely with --resume.
//
// Usage:
//   node andrewzc.js photos import-album <list> <album-json> [--radius <m>] [--originals <dir>] [--resume]
//
// Example:
//   node andrewzc.js photos import-album urinals import-progress/urinals.json
//   node andrewzc.js photos import-album urinals import-progress/urinals.json --originals import-progress/urinals-originals
//   node andrewzc.js photos import-album urinals import-progress/urinals.json --originals import-progress/urinals-originals --resume

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { MongoClient } from "mongodb";
import * as readline from "readline";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { insertEntity, geoPointFromCoords } from "../database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROGRESS_DIR = join(__dirname, "../import-progress");
const EDIT_BASE    = "http://localhost/andrewzc/edit.html";
const LOCAL_URI    = "mongodb://localhost:27017";
const API_BASE     = (process.env.ANDREWZC_API_BASE || "https://api.andrewzc.net").replace(/\/+$/, "");
const ADMIN_SESSION   = process.env.ANDREWZC_ADMIN_SESSION || "";
const ADMIN_USERNAME  = process.env.ANDREWZC_ADMIN_USERNAME || "";
const ADMIN_PASSWORD  = process.env.ANDREWZC_ADMIN_PASSWORD || "";

// ── Helpers ───────────────────────────────────────────────────────────────────

function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6378137;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clusterPhotos(photos, radiusMetres) {
  const used = new Set();
  const clusters = [];

  for (let i = 0; i < photos.length; i++) {
    if (used.has(i)) continue;
    const anchor = photos[i];
    if (!anchor.latitude || !anchor.longitude) continue;

    const cluster = [anchor];
    used.add(i);

    for (let j = i + 1; j < photos.length; j++) {
      if (used.has(j)) continue;
      const p = photos[j];
      if (!p.latitude || !p.longitude) continue;
      if (haversineMetres(anchor.latitude, anchor.longitude, p.latitude, p.longitude) <= radiusMetres) {
        cluster.push(p);
        used.add(j);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

function fingerprint(cluster) {
  return cluster[0].uuid;
}

function nameCandidates(cluster, nearbyEntities) {
  const candidates = new Set();

  // 1. place_names from Photos (most specific)
  for (const p of cluster) {
    for (const name of (p.search_info?.place_names || [])) {
      if (name) candidates.add(name);
    }
  }

  // 2. venues from Photos
  for (const p of cluster) {
    for (const v of (p.search_info?.venues || [])) {
      if (v) candidates.add(v);
    }
  }

  // 3. Nearby entities from the andrewzc DB
  for (const e of nearbyEntities) {
    if (e.name) candidates.add(e.name);
  }

  // 4. City fallback
  for (const p of cluster) {
    const city = p.search_info?.city || p.place?.address?.city;
    if (city) candidates.add(city);
  }

  return [...candidates];
}

function toKey(name) {
  return name
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function loadProgress(progressFile) {
  if (existsSync(progressFile)) {
    return JSON.parse(readFileSync(progressFile, "utf8"));
  }
  return { done: [], skipped: [] };
}

function saveProgress(progressFile, progress) {
  writeFileSync(progressFile, JSON.stringify(progress, null, 2));
}

// ── Auth & API ────────────────────────────────────────────────────────────────

async function login() {
  if (ADMIN_SESSION) return `admin_session=${ADMIN_SESSION}`;
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    console.error("Missing ANDREWZC_ADMIN_SESSION or credentials in .env");
    process.exit(1);
  }
  const res = await fetch(`${API_BASE}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD, label: "photos-import-album" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Login failed (${res.status})`);
  const cookie = res.headers.getSetCookie?.()[0] || res.headers.get("set-cookie");
  if (!cookie) throw new Error("No session cookie returned");
  return cookie.split(";")[0];
}

async function apiRequest(path, { method = "GET", cookie = "", body = null } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Request failed (${res.status})`);
  return data;
}

async function putToS3(url, buffer) {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: buffer,
  });
  if (!res.ok) throw new Error(`S3 PUT failed (${res.status})`);
}

// ── Upload photos for a cluster ───────────────────────────────────────────────

async function convertHeicIfNeeded(filePath) {
  if (!/\.(heic|heif)$/i.test(filePath)) return { path: filePath, temp: false };
  const { tmpdir } = await import("os");
  const { basename } = await import("path");
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  const outPath = `${tmpdir()}/${basename(filePath).replace(/\.(heic|heif)$/i, "")}-${Date.now()}.jpg`;
  await execFileAsync("sips", ["-s", "format", "jpeg", filePath, "--out", outPath]);
  return { path: outPath, temp: true };
}

async function uploadClusterPhotos(list, key, cluster, cookie, originalsDir) {
  const { default: sharp } = await import("sharp");

  // For each photo, prefer: originals folder (full-res) > path (local original) > derivative (preview)
  const available = cluster.map(p => {
    if (originalsDir) {
      // Try original_filename and filename with all known suffix variants
      // (Photos drag-export: HEIC → .jpeg, JPEG → .JPG)
      const bases = [p.original_filename, p.filename]
        .filter(Boolean)
        .map(f => f.replace(/\.[^.]+$/, ""));
      const suffixes = [".jpeg", ".JPG", ".jpg", ".HEIC", ".heic"];
      for (const base of bases) {
        for (const suffix of suffixes) {
          const candidate = join(originalsDir, `${base}${suffix}`);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
    return p.path || p.path_derivatives?.[0];
  }).filter(Boolean);

  if (available.length === 0) {
    console.log("  ⚠ No local file paths available for upload");
    return;
  }

  console.log(`  Allocating ${available.length} upload slot(s)…`);
  const presigned = await apiRequest(
    `/entities/${encodeURIComponent(list)}/${encodeURIComponent(key)}/images/presign`,
    { method: "POST", cookie, body: { count: available.length } }
  );
  const uploads = presigned?.uploads || [];

  let uploaded = 0;
  for (let i = 0; i < available.length; i++) {
    const filePath = available[i];
    const upload   = uploads[i];
    console.log(`  Uploading ${upload.filename}…`);

    let decodePath = filePath, temp = false;
    try {
      ({ path: decodePath, temp } = await convertHeicIfNeeded(filePath));
      const image = sharp(decodePath).rotate();
      const originalBuffer = await image.clone().jpeg({ quality: 90, mozjpeg: true }).toBuffer();
      const thumbBuffer    = await image.clone()
        .resize(600, 600, { fit: "cover", position: "centre" })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();

      await putToS3(upload.originalUploadUrl, originalBuffer);
      await putToS3(upload.thumbUploadUrl, thumbBuffer);
      uploaded++;
    } catch (err) {
      console.log(`  ⚠ Skipping ${upload.filename}: ${err.message.split("\n")[0]}`);
    } finally {
      if (temp) {
        const { unlink } = await import("fs/promises");
        await unlink(decodePath).catch(() => {});
      }
    }
  }

  await apiRequest(
    `/entities/${encodeURIComponent(list)}/${encodeURIComponent(key)}/images/complete`,
    { method: "POST", cookie, body: { filenames: uploads.map(u => u.filename) } }
  );

  console.log(`  ✓ Uploaded ${uploaded}/${available.length} photo(s)`);
}

// ── Nearby entity lookup ──────────────────────────────────────────────────────

async function findNearbyEntities(entitiesCol, lat, lon, radiusMetres) {
  return entitiesCol.find({
    location: {
      $nearSphere: {
        $geometry: { type: "Point", coordinates: [lon, lat] },
        $maxDistance: radiusMetres,
      },
    },
  }).limit(5).toArray();
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function run([list, albumJson, ...rest], _opts) {
  if (!list || !albumJson) {
    console.error("Usage: node andrewzc.js photos import-album <list> <album-json> [--radius <m>] [--resume]");
    process.exit(1);
  }

  const radiusIdx    = rest.indexOf("--radius");
  const radius       = radiusIdx !== -1 ? parseInt(rest[radiusIdx + 1], 10) : 200;
  const originalsIdx = rest.indexOf("--originals");
  const originalsDir = originalsIdx !== -1 ? rest[originalsIdx + 1] : null;
  const resume       = rest.includes("--resume");

  if (originalsDir) console.log(`Using originals from: ${originalsDir}`);

  const albumName    = albumJson.replace(/^.*\//, "").replace(/\.json$/, "");
  const progressFile = join(PROGRESS_DIR, `${albumName}-progress.json`);

  // Load photos
  const photos = JSON.parse(readFileSync(albumJson, "utf8"));
  console.log(`Loaded ${photos.length} photos from ${albumJson}`);

  // Cluster
  const clusters = clusterPhotos(photos, radius);
  console.log(`Clustered into ${clusters.length} groups (radius: ${radius}m)\n`);

  // Load progress
  const progress = loadProgress(progressFile);
  if (resume && (progress.done.length + progress.skipped.length) > 0) {
    console.log(`Resuming: ${progress.done.length} done, ${progress.skipped.length} skipped previously\n`);
  }

  // Connect to DBs
  const atlasClient = new MongoClient(process.env.MONGODB_URI);
  const localClient = new MongoClient(LOCAL_URI);
  await atlasClient.connect();
  await localClient.connect();

  const entitiesCol = atlasClient.db(process.env.MONGODB_DB || "andrewzc").collection("entities");

  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  let cookie = null; // lazy login

  let created = 0, skippedCount = 0;

  try {
    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      const fp      = fingerprint(cluster);
      const anchor  = cluster[0];

      // Skip already processed
      if (progress.done.includes(fp) || progress.skipped.includes(fp)) continue;

      const lat = anchor.latitude;
      const lon = anchor.longitude;
      const dateStr = (anchor.date || anchor.date_original || "").slice(0, 10);

      // Check for existing entities nearby
      const nearbyEntities = await findNearbyEntities(entitiesCol, lat, lon, radius);
      const onThisPage     = nearbyEntities.filter(e => e.list === list);

      // Name candidates
      const candidates = nameCandidates(cluster, nearbyEntities);

      // Display cluster info
      console.log(`\n[${ i + 1}/${clusters.length}] ${cluster.length} photo${cluster.length === 1 ? "" : "s"} · ${dateStr}`);
      console.log(`  Coords: ${lat.toFixed(6)}, ${lon.toFixed(6)}`);

      // AI captions (unique, from all photos in cluster)
      const captions = [...new Set(cluster.map(p => p.ai_caption).filter(Boolean))];
      if (captions.length) {
        for (const c of captions) console.log(`  🤖 "${c}"`);
      }

      // Existing entities on this page nearby
      if (onThisPage.length) {
        console.log(`  ⚠ Already on ${list} page:`);
        for (const e of onThisPage) console.log(`    • ${e.name} (${e.key})`);
      }

      // Name options
      if (candidates.length) {
        console.log("  Name options:");
        candidates.forEach((c, idx) => console.log(`    ${idx + 1}. ${c}`));
      }

      // Open in Photos
      try {
        execSync(`osxphotos show ${anchor.uuid}`, { stdio: "ignore" });
      } catch { /* Photos still opens */ }

      // Prompt
      console.log("  Enter number to pick a name, type a custom name, or:");
      const answer = (await ask("  [s]kip / [q]uit: ")).trim();

      if (answer.toLowerCase() === "q") {
        console.log(`\nQuitting. Re-run with --resume to continue.`);
        saveProgress(progressFile, progress);
        break;
      }

      if (answer.toLowerCase() === "s" || answer === "") {
        progress.skipped.push(fp);
        saveProgress(progressFile, progress);
        skippedCount++;
        continue;
      }

      // Resolve name
      let chosenName;
      const num = parseInt(answer, 10);
      if (!isNaN(num) && num >= 1 && num <= candidates.length) {
        chosenName = candidates[num - 1];
      } else {
        chosenName = answer;
      }

      const chosenKey = toKey(chosenName);
      console.log(`  → "${chosenName}" (key: ${chosenKey})`);

      // Lazy login
      if (!cookie) {
        console.log("  Logging in…");
        cookie = await login();
      }

      // Build and insert entity directly via MongoDB, or add to existing
      const coordsStr = `${lat.toFixed(8)}, ${lon.toFixed(8)}`;
      const isoCode   = anchor.place?.address?.iso_country_code?.toUpperCase();
      const iconFlag  = isoCode
        ? String.fromCodePoint(...[...isoCode].map(c => 0x1F1A5 + c.charCodeAt(0)))
        : null;

      const existing = await entitiesCol.findOne({ list, key: chosenKey });

      if (existing) {
        console.log(`  ↩ Entity ${list}/${chosenKey} already exists — adding photos to it`);
      } else {
        const entityDoc = {
          key:      chosenKey,
          name:     chosenName,
          list,
          been:     true,
          coords:   coordsStr,
          location: geoPointFromCoords(coordsStr),
          ...(dateStr ? { dateVisited: dateStr } : {}),
          ...(anchor.place?.address?.city        ? { city: anchor.place.address.city } : {}),
          ...(isoCode                            ? { country: isoCode }                : {}),
          ...(iconFlag                           ? { icons: [iconFlag] }               : {}),
        };
        await insertEntity(entityDoc);
        console.log(`  ✓ Created entity ${list}/${chosenKey}`);
      }

      // Upload photos
      await uploadClusterPhotos(list, chosenKey, cluster, cookie, originalsDir);

      // Open edit page to review
      const editUrl = `${EDIT_BASE}?list=${encodeURIComponent(list)}&key=${encodeURIComponent(chosenKey)}`;
      execSync(`open "${editUrl}"`);

      progress.done.push(fp);
      saveProgress(progressFile, progress);
      created++;
    }
  } finally {
    rl.close();
    await atlasClient.close();
    await localClient.close();
  }

  console.log(`\nDone. Created: ${created}, Skipped: ${skippedCount}.`);
  if (created > 0) console.log(`Progress saved to ${progressFile}`);
}
