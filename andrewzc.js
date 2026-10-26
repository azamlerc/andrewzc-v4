#!/usr/bin/env node
// andrewzc — unified CLI for the andrewzc.net database
//
// Usage: node andrewzc.js <command> [args] [options]
//
// Run without arguments or with --help to see all commands.

import "dotenv/config";

const COMMANDS = {
  // ── Enrichment ──────────────────────────────────────────────────────────────
  "enrich set-link":      { args: "<list> [--overwrite]",                      desc: "Search Wikipedia by name and set link field" },
  "enrich set-location":    { args: "[list] [--test] [--dryrun]",                 desc: "Fetch GeoJSON location from Wikipedia/Booking/Airbnb links" },
  "enrich set-city":      { args: "<list>",                                    desc: "Set city from location via nearest-city lookup" },
  "enrich set-city-from-cities": { args: "[city-key] [--dryrun]", desc: "Fill missing cities by searching around each city (20 km)" },
  "enrich set-reference": { args: "<list>",                                    desc: "Copy city → reference" },
  "enrich set-country":   { args: "<list>|--all [--overwrite] [--dryrun]",     desc: "Derive country/countries from flag emoji in icons array" },
  "enrich set-icon":      { args: "<list> [--overwrite] [--dryrun]",           desc: "Derive flag emoji from country/countries and set icons array" },
  "enrich find-country":  { args: "<list> [--overwrite] [--dryrun]",           desc: "Copy country from nearest geolocated entity in the DB" },
  "enrich run":           { args: "<list>",                                    desc: "Run full cascade: link → location → city → reference" },

  // ── Import ───────────────────────────────────────────────────────────────────
  "import":               { args: "<page-key>",            desc: "Upsert page + entities from output/pages.json and output/entities.json" },

  // ── Keys ────────────────────────────────────────────────────────────────────
  "keys rekey":           { args: "<list> [--dryrun]",     desc: "Regenerate keys from page tags; merge duplicates" },

  // ── Props ────────────────────────────────────────────────────────────────────
  "props update":         { args: "<list> <file.json> [--dryrun]",       desc: "Set props on entities from a JSON file" },
  "props merge":          { args: "<main-list> <detail-list> [--dryrun]", desc: "Merge a detail list into props of a main list" },
  "props update-schema":  { args: "<list>",                              desc: "Introspect props and write schema to page document" },
  "props delete":         { args: "<list> <prop>",                       desc: "Delete a prop from all entities and page schema" },
  "props rename":         { args: "<list> <old> <new>",                  desc: "Rename a prop on all entities and page schema" },
  "props make-numeric":   { args: "<list> <prop>",                       desc: "Convert string prop values to numbers" },
  "props enrich-country-icons": { args: "<list> [--dryrun]",             desc: "Add flag emoji icons to props that contain a country code" },

  // ── Wikipedia / Embeddings ───────────────────────────────────────────────────
  "wiki load":            { args: "[list]",                desc: "Fetch Wikipedia summaries and generate embeddings" },
  "wiki clear":           { args: "<list> [--junk-only]",  desc: "Clear wikiSummary, wikiEmbedding, enrichedAt" },
  "wiki clear-embeddings":{ args: "<list|--all>",          desc: "Clear only wikiEmbedding, keep summaries" },

  // ── Caption Embeddings ────────────────────────────────────────────────────────
  "caption embed":        { args: "[list]",                desc: "Generate captionEmbedding vectors for entities with a caption" },

  // ── Stats ────────────────────────────────────────────────────────────────────
  "stats completion":     { args: "",                      desc: "Show completion % (visited/total) for all lists" },
  "stats links":          { args: "",                      desc: "Show Wikipedia link language breakdown" },

  // ── Upsert ───────────────────────────────────────────────────────────────────
  "upsert":               { args: "<file.csv|json> [list]", desc: "Upsert entities from a file with full enrichment" },

  // ── Images ───────────────────────────────────────────────────────────────────
  "image upload":         { args: "<list> <key> <file...>", desc: "Upload one or more images via API presigned URLs" },

  // ── Photos ───────────────────────────────────────────────────────────────────
  "photos set-dates":     { args: "<list> [--key <key>] [--radius <m>] [--dryrun]", desc: "Set dateVisited from nearby photos in local Photos library" },
  "photos suggest":       { args: "<list> [--start <key>] [--radius <m>]",           desc: "Interactively suggest nearby photos for entities with no images" },
  "photos import-album":  { args: "<list> [album-json] [--radius <m>] [--originals <dir>] [--resume]", desc: "Interactively create entities from a Photos album export" },
  "photos export-album":  { args: "<AlbumName> <list> [--force]",                     desc: "Export an album via osxphotos: JSON metadata + full-res originals" },

  // ── Backup ───────────────────────────────────────────────────────────────────
  "backup":               { args: "[--out <dir>]",          desc: "Dump all collections to JSON (strips wikiEmbedding)" },

  "location backfill":    { args: "[list] [--dryrun]",       desc: "Fill missing GeoJSON locations from existing coords only" },

  // ── Flags ────────────────────────────────────────────────────────────────────
  "flags":                { args: "",                       desc: "Rebuild flags.json from the database" },
};

// ── Argument parsing ──────────────────────────────────────────────────────────

const rawArgs  = process.argv.slice(2);
const flags    = new Set(rawArgs.filter(a => a.startsWith("--")));

const dryRun    = flags.has("--dryrun");
const retry     = flags.has("--retry");
const testMode  = flags.has("--test");
const junkOnly  = flags.has("--junk-only");
const all       = flags.has("--all");
const overwrite = flags.has("--overwrite");

// ── Help ──────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log("\nUsage: node andrewzc.js <command> [args] [options]\n");
  console.log("Commands:\n");

  let lastGroup = null;
  for (const [cmd, { args, desc }] of Object.entries(COMMANDS)) {
    const group = cmd.split(" ")[0];
    if (group !== lastGroup) {
      console.log(`  ${group.toUpperCase()}`);
      lastGroup = group;
    }
    const full = args ? `${cmd} ${args}` : cmd;
    console.log(`    ${full.padEnd(52)} ${desc}`);
  }

  console.log("\nOptions:");
  console.log("  --dryrun       Print what would change without writing to DB");
  console.log("  --overwrite    Replace existing values (varies by command)");
  console.log("  --retry        Re-attempt previously failed operations");
  console.log("  --test         Report only, no writes");
  console.log("  --junk-only    Target only malformed entries");
  console.log("  --all          Apply to all lists");
  console.log("  --help         Show this help\n");
}

if (rawArgs.length === 0 || flags.has("--help")) {
  printHelp();
  process.exit(0);
}

// ── Command dispatch ──────────────────────────────────────────────────────────

// Command names are always the leading, contiguous words (never preceded
// by a flag), so they're matched against the raw args directly — the
// remainder (cmdArgs) then keeps every flag and its value intact, in the
// order given, exactly as each command's own run() expects to parse it.
const threeWord = rawArgs.slice(0, 3).join(" ");
const twoWord   = rawArgs.slice(0, 2).join(" ");
const oneWord   = rawArgs[0];

let command, cmdArgs;

if (COMMANDS[threeWord]) {
  command  = threeWord;
  cmdArgs  = rawArgs.slice(3);
} else if (COMMANDS[twoWord]) {
  command  = twoWord;
  cmdArgs  = rawArgs.slice(2);
} else if (COMMANDS[oneWord]) {
  command  = oneWord;
  cmdArgs  = rawArgs.slice(1);
} else {
  console.error(`\n❌ Unknown command: "${rawArgs.slice(0, 3).join(" ")}"\n`);
  printHelp();
  process.exit(1);
}

// ── Command implementations ───────────────────────────────────────────────────

const { run } = await import(`./commands/${command.replace(/ /g, "-")}.js`);
await run(cmdArgs, { dryRun, retry, testMode, junkOnly, all, overwrite });
