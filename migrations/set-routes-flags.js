// set-routes-flags.js
//
// Sets flags: [stateCode] on all entities in the "routes" list,
// derived from their existing state field (lowercased).
// Skips entities with no state, or with state: "BC" (not a US state).
//
// Run: node migrations/set-routes-flags.js [--dryrun]

import "dotenv/config";
import { processEntities } from "../database.js";

const dryRun = process.argv.includes("--dryrun");

await processEntities(
  { list: "routes", state: { $exists: true, $ne: "BC" } },
  (doc) => {
    doc.flags = [doc.state.toLowerCase()];
  },
  { dryRun }
);

console.log(dryRun ? "\n[DRY RUN] No changes written." : "\nDone.");