// commands/photos-export-album.js
//
// One command instead of two manual osxphotos invocations: produces both
// inputs that `photos import-album` needs for a given Photos album.
//
//   1. import-progress/<list>.json            — full photo metadata,
//      via `osxphotos query --album <name> --json`
//   2. import-progress/<list>-originals/       — full-resolution source
//      files, via `osxphotos export --filename "{original_name}"`
//
// The originals folder matters more than it looks. Without it,
// photos-import-album.js falls back to Photos' own internal preview
// derivatives (`path_derivatives`), which are low-resolution. That silent
// fallback is exactly what produced the blurry urinals photos that
// migrations/repair-urinals-images.js later had to repair from a re-export.
// Always pass the originals folder this command creates through to
// `photos import-album --originals`.
//
// Requires osxphotos (https://github.com/RhetTbull/osxphotos) on PATH:
//   pipx install osxphotos
//
// If <list>.json already exists, prompts interactively: re-query Photos
// (overwriting it), or keep the existing file and skip straight to
// exporting originals. Pass --force to skip that prompt and always
// re-query (e.g. for non-interactive use).
//
// Once the export is done, chains straight into the interactive
// `photos import-album` run — the JSON file and originals folder are just
// internal plumbing between the two steps, not something to manage by hand.
// Pass --no-import to stop after exporting instead. Any other flags
// (--radius, --resume, ...) are forwarded through to import-album.
//
// Usage:
//   node andrewzc.js photos export-album <AlbumName> <list> [--force] [--no-import] [import-album options...]
//
// Example:
//   node andrewzc.js photos export-album Urinals urinals
//   node andrewzc.js photos export-album Urinals urinals --radius 300
//   node andrewzc.js photos export-album Urinals urinals --no-import

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import * as readline from "readline";

const __dirname    = dirname(fileURLToPath(import.meta.url));
const PROGRESS_DIR = join(__dirname, "../import-progress");

function checkOsxphotos() {
  try {
    execFileSync("osxphotos", ["version"], { stdio: "ignore" });
  } catch {
    console.error("✗ osxphotos not found on PATH.");
    console.error("  Install it with: pipx install osxphotos");
    process.exit(1);
  }
}

function queryAlbum(albumName, jsonPath) {
  console.log(`Querying album "${albumName}" via osxphotos…`);
  let stdout;
  try {
    stdout = execFileSync(
      "osxphotos",
      ["query", "--album", albumName, "--json"],
      { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1024 * 1024 * 256 }
    );
  } catch (err) {
    console.error(`✗ osxphotos query failed: ${err.message.split("\n")[0]}`);
    process.exit(1);
  }

  const photos = JSON.parse(stdout.toString("utf8"));
  if (photos.length === 0) {
    console.error(`✗ osxphotos returned 0 photos for album "${albumName}". Check the album name (case-sensitive, must match Photos exactly).`);
    process.exit(1);
  }
  writeFileSync(jsonPath, JSON.stringify(photos, null, 2));
  console.log(`✓ Wrote ${photos.length} photo record(s) to ${jsonPath}`);
  return photos;
}

async function resolveJson(albumName, jsonPath, force) {
  if (!existsSync(jsonPath)) {
    return queryAlbum(albumName, jsonPath);
  }

  if (force) {
    return queryAlbum(albumName, jsonPath);
  }

  // File exists and --force wasn't given: ask what to do rather than
  // requiring a flag or aborting.
  let existingCount = "?";
  try {
    existingCount = JSON.parse(readFileSync(jsonPath, "utf8")).length;
  } catch { /* unreadable/corrupt — still offer the choice */ }
  const { mtime } = statSync(jsonPath);

  console.log(`${jsonPath} already exists (${existingCount} photo(s), last updated ${mtime.toLocaleString()}).`);

  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  let choice;
  while (true) {
    const answer = (await ask("  [u]pdate from Photos / [k]eep existing and continue / [q]uit: ")).trim().toLowerCase();
    if (["u", "update"].includes(answer))            { choice = "update"; break; }
    if (["k", "keep", ""].includes(answer))          { choice = "keep";   break; }
    if (["q", "quit"].includes(answer))              { choice = "quit";   break; }
    console.log("  Please enter u, k, or q.");
  }
  rl.close();

  if (choice === "quit") {
    console.log("Cancelled.");
    process.exit(0);
  }
  if (choice === "keep") {
    console.log(`Using existing ${jsonPath} — skipping straight to the photo export.`);
    return JSON.parse(readFileSync(jsonPath, "utf8"));
  }
  return queryAlbum(albumName, jsonPath);
}

export async function run([albumName, list, ...rest], _opts) {
  if (!albumName || !list) {
    console.error("Usage: node andrewzc.js photos export-album <AlbumName> <list> [--force] [--no-import] [import-album options...]");
    process.exit(1);
  }

  const force      = rest.includes("--force");
  const noImport   = rest.includes("--no-import");
  const passThrough = rest.filter(a => a !== "--force" && a !== "--no-import");

  checkOsxphotos();
  mkdirSync(PROGRESS_DIR, { recursive: true });

  const jsonPath     = join(PROGRESS_DIR, `${list}.json`);
  const originalsDir = join(PROGRESS_DIR, `${list}-originals`);

  // ── 1. Metadata JSON ─────────────────────────────────────────────────────
  await resolveJson(albumName, jsonPath, force);

  // ── 2. Full-resolution originals ────────────────────────────────────────
  // osxphotos export requires DEST to already exist — it won't create it.
  mkdirSync(originalsDir, { recursive: true });
  console.log(`\nExporting full-resolution originals to ${originalsDir}…`);
  try {
    execFileSync(
      "osxphotos",
      ["export", originalsDir, "--album", albumName, "--filename", "{original_name}", "--update"],
      { stdio: "inherit" }
    );
  } catch (err) {
    console.error(`✗ osxphotos export failed: ${err.message.split("\n")[0]}`);
    process.exit(1);
  }
  console.log(`✓ Originals exported to ${originalsDir}`);

  const importArgs = [list, jsonPath, "--originals", originalsDir, ...passThrough];

  if (noImport) {
    console.log(`\nNext:\n  node andrewzc.js photos import-album ${importArgs.join(" ")}`);
    return;
  }

  console.log(`\nContinuing straight to the interactive import…\n`);
  const { run: importRun } = await import("./photos-import-album.js");
  await importRun(importArgs, _opts);
}
