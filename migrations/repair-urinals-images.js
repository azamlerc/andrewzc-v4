// migrations/repair-urinals-images.js
//
// Repairs low-res images uploaded from Photos derivatives by replacing them
// with full-resolution versions from the urinals-originals export folder.
//
// For each urinals entity with images:
//   1. Check each image in S3 — skip if already >= SIZE_THRESHOLD bytes
//   2. Spatial-join entity coords against urinals.json to find candidate UUIDs
//   3. Find the corresponding file in urinals-originals/ by UUID
//   4. Re-process with sharp and PUT directly to S3, overwriting the bad file
//
// Run: node migrations/repair-urinals-images.js [--dryrun]

import "dotenv/config";
import { MongoClient } from "mongodb";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { unlink } from "fs/promises";
import { S3Client, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const DRYRUN     = process.argv.includes("--dryrun");

const PHOTOS_JSON    = join(__dirname, "../import-progress/urinals.json");
const ORIGINALS_DIR  = join(__dirname, "../import-progress/urinals-originals");
const S3_BUCKET      = process.env.S3_BUCKET || "andrewzc-imagine";
const S3_PREFIX      = "urinals";       // keys: urinals/{filename} and urinals/tn/{filename}
const SIZE_THRESHOLD = 100 * 1024;      // 100KB — below this we assume it's a derivative thumbnail
const SEARCH_RADIUS  = 300;             // metres — generous for matching photos to entities

const execFileAsync = promisify(execFile);

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ── Geo ───────────────────────────────────────────────────────────────────────

function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6378137;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseCoords(coordsStr) {
  if (!coordsStr) return null;
  const [lat, lon] = coordsStr.split(",").map(s => parseFloat(s.trim()));
  if (isNaN(lat) || isNaN(lon)) return null;
  return { lat, lon };
}

// ── File helpers ──────────────────────────────────────────────────────────────

function findOriginalFile(photo, originalsDir) {
  const candidates = [];

  // Drag-export from Photos converts HEIC to JPEG and lowercases extension
  if (photo.original_filename) {
    const base = photo.original_filename.replace(/\.[^.]+$/, "");
    candidates.push(
      photo.original_filename,          // exact original name
      `${base}.jpeg`,                   // HEIC → jpeg
      `${base}.jpg`,                    // jpg lowercase
      `${base}.JPG`,                    // JPEG original → JPG uppercase
    );
  }
  if (photo.filename) {
    const base = photo.filename.replace(/\.[^.]+$/, "");
    candidates.push(photo.filename, `${base}.jpeg`, `${base}.jpg`);
  }

  // UUID-based names as fallback (osxphotos export)
  const exts = [".HEIC", ".heic", "_edited.heic", ".jpeg", "_edited.jpeg", ".jpg", "_edited.jpg"];
  for (const ext of exts) candidates.push(`${photo.uuid}${ext}`);

  for (const name of candidates) {
    const p = join(originalsDir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

async function convertHeicIfNeeded(filePath) {
  if (!/\.(heic|heif)$/i.test(filePath)) return { path: filePath, temp: false };
  const outPath = join(tmpdir(), `repair-${Date.now()}.jpg`);
  await execFileAsync("sips", ["-s", "format", "jpeg", filePath, "--out", outPath]);
  return { path: outPath, temp: true };
}

async function makeBuffers(filePath) {
  const { path: decodePath, temp } = await convertHeicIfNeeded(filePath);
  try {
    const image = sharp(decodePath).rotate();
    const originalBuffer = await image.clone()
      .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    const thumbBuffer = await image.clone()
      .resize(600, 600, { fit: "cover", position: "centre" })
      .jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    return { originalBuffer, thumbBuffer };
  } finally {
    if (temp) await unlink(decodePath).catch(() => {});
  }
}

// ── S3 helpers ────────────────────────────────────────────────────────────────

async function s3Size(key) {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return res.ContentLength ?? 0;
  } catch {
    return null; // key doesn't exist
  }
}

async function s3Put(key, buffer) {
  await s3.send(new PutObjectCommand({
    Bucket:      S3_BUCKET,
    Key:         key,
    Body:        buffer,
    ContentType: "image/jpeg",
  }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Load photos metadata
  const photos = JSON.parse(readFileSync(PHOTOS_JSON, "utf8"));
  console.log(`Loaded ${photos.length} photos from urinals.json`);

  // Connect to Atlas
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const entities = client.db(process.env.MONGODB_DB || "andrewzc").collection("entities");

  if (DRYRUN) console.log("-- DRY RUN --\n");

  const docs = await entities.find({
    list: "urinals",
    images: { $exists: true, $not: { $size: 0 } },
  }).toArray();

  console.log(`Found ${docs.length} urinals entities with images\n`);

  let repaired = 0, skipped = 0, noMatch = 0;

  for (const entity of docs) {
    const coords = parseCoords(entity.coords);
    if (!coords) {
      console.log(`${entity.name}: no coords, skipping`);
      noMatch++;
      continue;
    }

    // Find nearby photos in urinals.json
    const nearby = photos.filter(p =>
      p.latitude && p.longitude &&
      haversineMetres(coords.lat, coords.lon, p.latitude, p.longitude) <= SEARCH_RADIUS
    );

    if (nearby.length === 0) {
      console.log(`${entity.name}: no nearby photos in JSON`);
      noMatch++;
      continue;
    }

    const imageResults = [];
    let anyNeedRepair = false;

    // Process each image filename on the entity
    for (let i = 0; i < entity.images.length; i++) {
      const filename = entity.images[i];
      const origKey  = `${S3_PREFIX}/${filename}`;
      const tnKey    = `${S3_PREFIX}/tn/${filename}`;

      // Check current S3 size
      const size = await s3Size(origKey);
      if (size === null) {
        imageResults.push(`  ${filename}: not found in S3, skipping`);
        skipped++;
        continue;
      }
      if (size >= SIZE_THRESHOLD) {
        imageResults.push(`  ${filename}: ${(size / 1024).toFixed(0)}KB — already full-res, skipping`);
        skipped++;
        continue;
      }

      anyNeedRepair = true;
      imageResults.push(`  ${filename}: ${(size / 1024).toFixed(0)}KB — needs repair`);

      // Pick the i-th nearby photo (sorted by date) as the source
      const sorted = nearby.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      const photo  = sorted[i] || sorted[sorted.length - 1];
      const source = findOriginalFile(photo, ORIGINALS_DIR);

      if (!source) {
        const tried = [photo.original_filename, photo.filename].filter(Boolean).join(", ");
        imageResults.push(`  ${filename}: no original file found (tried: ${tried})`);
        skipped++;
        continue;
      }

      imageResults.push(`  ${filename}: repairing from ${source.split("/").pop()}`);

      if (!DRYRUN) {
        try {
          const { originalBuffer, thumbBuffer } = await makeBuffers(source);
          await s3Put(origKey, originalBuffer);
          await s3Put(tnKey, thumbBuffer);
          imageResults.push(`  ${filename}: ✓ replaced (${(originalBuffer.length / 1024).toFixed(0)}KB)`);
          repaired++;
        } catch (err) {
          imageResults.push(`  ${filename}: ✗ error — ${err.message.split("\n")[0]}`);
          skipped++;
        }
      } else {
        imageResults.push(`  ${filename}: [DRY RUN] would replace from ${source.split("/").pop()}`);
        repaired++;
      }
    }

    // Only print entity header and results if something needed repair
    if (anyNeedRepair) {
      console.log(`${entity.name}: ${entity.images.length} image(s), ${nearby.length} nearby photo(s)`);
      for (const line of imageResults) console.log(line);
    }
  }

  await client.close();

  console.log(`\nRepaired: ${repaired}  Skipped: ${skipped}  No match: ${noMatch}`);
  if (DRYRUN) console.log("[DRY RUN] No changes written");
}

main().catch(err => { console.error(err); process.exit(1); });
