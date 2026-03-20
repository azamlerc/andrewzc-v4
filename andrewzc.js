#!/usr/bin/env node
// andrewzc — unified CLI for the andrewzc.net database
//
// Usage: node andrewzc.js <command> [args] [options]
//
// Run without arguments or with --help to see all commands.

import "dotenv/config";

const COMMANDS = {
  // ── Enrichment ──────────────────────────────────────────────────────────────
  "enrich set-link":      { args: "<list>",                desc: "Search Wikipedia by name and set link field" },
  "enrich set-coords":    { args: "<list> [--retry] [--test]", desc: "Fetch coords from Wikipedia/Booking/Airbnb links" },
  "enrich set-city":      { args: "<list>",                desc: "Set city from coords via nearest-city lookup" },
  "enrich set-reference": { args: "<list>",                desc: "Copy city → reference" },
  "enrich run":           { args: "<list>",                desc: "Run full cascade: link → coords → city → reference" },

  // ── Keys ────────────────────────────────────────────────────────────────────
  "keys rekey":           { args: "<list> [--dryrun]",     desc: "Regenerate keys from page tags; merge duplicates" },

  // ── Props ────────────────────────────────────────────────────────────────────
  "props update":         { args: "<list> <file.json> [--dryrun]", desc: "Set props on entities from a JSON file" },
  "props merge":          { args: "<main-list> <detail-list> [--dryrun]", desc: "Merge a detail list into props of a main list" },
  "props update-schema":  { args: "<list>",                desc: "Introspect props and write schema to page document" },
  "props delete":         { args: "<list> <prop>",         desc: "Delete a prop from all entities and page schema" },
  "props rename":         { args: "<list> <old> <new>",    desc: "Rename a prop on all entities and page schema" },
  "props make-numeric":   { args: "<list> <prop>",         desc: "Convert string prop values to numbers" },
  "props enrich-country-icons": { args: "<list> [--dryrun]", desc: "Add flag emoji icons to props that contain a country code" },

  // ── Wikipedia / Embeddings ───────────────────────────────────────────────────
  "wiki load":            { args: "[list]",                desc: "Fetch Wikipedia summaries and generate embeddings" },
  "wiki clear":           { args: "<list> [--junk-only]",  desc: "Clear wikiSummary, wikiEmbedding, enrichedAt" },
  "wiki clear-embeddings":{ args: "<list|--all>",          desc: "Clear only wikiEmbedding, keep summaries" },

  // ── Stats ────────────────────────────────────────────────────────────────────
  "stats completion":     { args: "",                      desc: "Show completion % (visited/total) for all lists" },
  "stats links":          { args: "",                      desc: "Show Wikipedia link language breakdown" },

  // ── Upsert ───────────────────────────────────────────────────────────────────
  "upsert":               { args: "<file.csv|json> [list]", desc: "Upsert entities from a file with full enrichment" },

  // ── Images ───────────────────────────────────────────────────────────────────
  "image upload":         { args: "<list> <key> <file...>", desc: "Upload one or more images via API presigned URLs" },

  // ── Backup ───────────────────────────────────────────────────────────────────
  "backup":               { args: "[--out <dir>]",          desc: "Dump all collections to JSON (strips wikiEmbedding)" },
};

// ── Argument parsing ──────────────────────────────────────────────────────────

const rawArgs  = process.argv.slice(2);
const flags    = new Set(rawArgs.filter(a => a.startsWith("--")));
const posArgs  = rawArgs.filter(a => !a.startsWith("--"));

const dryRun   = flags.has("--dryrun");
const retry    = flags.has("--retry");
const testMode = flags.has("--test");
const junkOnly = flags.has("--junk-only");
const all      = flags.has("--all");

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
    console.log(`    ${full.padEnd(46)} ${desc}`);
  }

  console.log("\nOptions:");
  console.log("  --dryrun       Print what would change without writing to DB");
  console.log("  --retry        Re-attempt previously failed operations");
  console.log("  --test         Report only, no writes");
  console.log("  --junk-only    Target only malformed entries");
  console.log("  --all          Apply to all lists");
  console.log("  --help         Show this help\n");
}

if (posArgs.length === 0 || flags.has("--help")) {
  printHelp();
  process.exit(0);
}

// ── Command dispatch ──────────────────────────────────────────────────────────

// Try three-word command first, then two-word, then one-word
const threeWord = posArgs.slice(0, 3).join(" ");
const twoWord   = posArgs.slice(0, 2).join(" ");
const oneWord   = posArgs[0];

let command, cmdArgs;

if (COMMANDS[threeWord]) {
  command  = threeWord;
  cmdArgs  = posArgs.slice(3);
} else if (COMMANDS[twoWord]) {
  command  = twoWord;
  cmdArgs  = posArgs.slice(2);
} else if (COMMANDS[oneWord]) {
  command  = oneWord;
  cmdArgs  = posArgs.slice(1);
} else {
  console.error(`\n❌ Unknown command: "${posArgs.slice(0, 3).join(" ")}"\n`);
  printHelp();
  process.exit(1);
}

// ── Command implementations ───────────────────────────────────────────────────

// Lazily import command modules so startup is fast for --help
const { run } = await import(`./commands/${command.replace(/ /g, "-")}.js`);
await run(cmdArgs, { dryRun, retry, testMode, junkOnly, all });
