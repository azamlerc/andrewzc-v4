#!/usr/bin/env node
// scrape-spomenik-images.js
//
// For each entity on the "spomenik" list, fetches the linked Spomenik Database
// page, extracts the hero image from the Wix slideshow gallery, downloads the
// image, and uploads it using the standard image upload flow (presign → S3 PUT
// → complete).
//
// Usage:
//   node migrations/scrape-spomenik-images.js [--dryrun] [--key crni-kal]
//
// Options:
//   --dryrun      Print what would be done, don't upload anything
//   --key <key>   Only process the entity with this key

import "dotenv/config";
import { MongoClient } from "mongodb";
import sharp from "sharp";
import { JSDOM } from "jsdom";

const DRYRUN  = process.argv.includes("--dryrun");
const keyArg  = (() => { const i = process.argv.indexOf("--key"); return i >= 0 ? process.argv[i + 1] : null; })();

const URI      = process.env.MONGODB_URI;
const DB       = process.env.MONGODB_DB || "andrewzc";
const API_BASE = (process.env.ANDREWZC_API_BASE || "https://api.andrewzc.net").replace(/\/+$/, "");
const ADMIN_SESSION  = process.env.ANDREWZC_ADMIN_SESSION || "";
const ADMIN_USERNAME = process.env.ANDREWZC_ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ANDREWZC_ADMIN_PASSWORD || "";

const DELAY_MS = 2000; // be polite to the Wix server

if (!URI) throw new Error("Missing MONGODB_URI in environment");

// ---- Helpers ----------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function login() {
  if (ADMIN_SESSION) return `admin_session=${ADMIN_SESSION}`;
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) throw new Error("Missing admin credentials in .env");

  const res = await fetch(`${API_BASE}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD, label: "scrape-spomenik-images" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Login failed (${res.status})`);
  const cookie = res.headers.getSetCookie?.()[0] || res.headers.get("set-cookie");
  if (!cookie) throw new Error("Login succeeded but no session cookie");
  return cookie.split(";")[0];
}

async function api(path, { method = "GET", cookie = "", body = null } = {}) {
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

async function putToS3(uploadUrl, buffer) {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: buffer,
  });
  if (!res.ok) throw new Error(`S3 PUT failed (${res.status})`);
}

// Extract the hero image URL from a Wix Spomenik Database page
async function fetchHeroImageUrl(pageUrl) {
  const res = await fetch(pageUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; andrewzc-bot/1.0)",
      "Accept": "text/html",
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${pageUrl}`);

  const html = await res.text();
  const dom  = new JSDOM(html);
  const doc  = dom.window.document;

  // Find the slideshow gallery container
  const gallery = doc.querySelector("[data-testid='slide-show-gallery-items']");
  if (!gallery) throw new Error("No slideshow gallery found");

  // Find the first wow-image > img inside it
  const img = gallery.querySelector("wow-image img, img[src*='wixstatic']");
  if (!img) throw new Error("No image found in gallery");

  let src = img.getAttribute("src") || img.getAttribute("data-src") || "";
  if (!src) throw new Error("Image has no src");

  // Strip everything after the first .jpg (removes Wix transform params)
  const jpgIndex = src.toLowerCase().indexOf(".jpg");
  if (jpgIndex >= 0) src = src.slice(0, jpgIndex + 4);

  // Make absolute
  if (src.startsWith("//")) src = "https:" + src;
  if (!src.startsWith("http")) src = new URL(src, pageUrl).href;

  return src;
}

async function downloadImage(imageUrl) {
  const res = await fetch(imageUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; andrewzc-bot/1.0)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading image`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function makeUploadBuffers(inputBuffer) {
  const image = sharp(inputBuffer).rotate();

  const originalBuffer = await image
    .clone()
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();

  const thumbBuffer = await image
    .clone()
    .resize(600, 600, { fit: "cover", position: "centre" })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();

  return { originalBuffer, thumbBuffer };
}

// ---- Main -------------------------------------------------------------------

const client = new MongoClient(URI);

async function main() {
  await client.connect();
  const db = client.db(DB);

  const filter = { list: "spomenik", ...(keyArg ? { key: keyArg } : {}) };
  const entities = await db.collection("entities")
    .find(filter, { projection: { key: 1, link: 1, images: 1, name: 1 } })
    .sort({ order: 1 })
    .toArray();

  // Skip entities that already have images
  const todo = entities.filter(e => !e.images || e.images.length === 0);

  console.log(`Found ${entities.length} entities, ${todo.length} without images.`);
  if (DRYRUN) console.log("-- DRY RUN --\n");

  if (!DRYRUN) {
    console.log("Logging in…");
  }
  const cookie = DRYRUN ? null : await login();

  let ok = 0, skipped = 0, errors = 0;

  for (const entity of todo) {
    const { key, link, name } = entity;
    console.log(`\n[${key}] ${name}`);
    console.log(`  Link: ${link}`);

    try {
      // 1. Fetch the page and extract the hero image URL
      console.log("  Fetching page…");
      const imageUrl = await fetchHeroImageUrl(link);
      console.log(`  Image: ${imageUrl}`);

      if (DRYRUN) { ok++; continue; }

      // 2. Download the image
      console.log("  Downloading image…");
      const rawBuffer = await downloadImage(imageUrl);

      // 3. Process with sharp
      console.log("  Processing…");
      const { originalBuffer, thumbBuffer } = await makeUploadBuffers(rawBuffer);

      // 4. Presign
      console.log("  Presigning…");
      const presigned = await api(
        `/entities/spomenik/${encodeURIComponent(key)}/images/presign`,
        { method: "POST", cookie, body: { count: 1 } }
      );
      const upload = presigned.uploads[0];

      // 5. Upload to S3
      console.log(`  Uploading ${upload.filename}…`);
      await putToS3(upload.originalUploadUrl, originalBuffer);
      await putToS3(upload.thumbUploadUrl, thumbBuffer);

      // 6. Complete
      await api(
        `/entities/spomenik/${encodeURIComponent(key)}/images/complete`,
        { method: "POST", cookie, body: { filenames: [upload.filename] } }
      );

      console.log(`  ✓ Uploaded ${upload.filename}`);
      ok++;

    } catch (err) {
      console.error(`  ✗ Error: ${err.message}`);
      errors++;
    }

    // Be polite to Wix
    await sleep(DELAY_MS);
  }

  console.log(`\nDone. OK: ${ok}, Skipped: ${skipped}, Errors: ${errors}`);
  await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
