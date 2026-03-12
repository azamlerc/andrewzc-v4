// One-shot migration: copy flags from independence list entities into
// the corresponding countries entity's props.independence.flags
//
// Run: node migrations/set-independence-flags.js [--dryrun]

import "dotenv/config";
import { fetchEntities, bulkSetFields } from "../database.js";

const SOVIET = ["armenia","azerbaijan","belarus","estonia","georgia",
  "kazakhstan","kyrgyzstan","latvia","lithuania","moldova",
  "north-korea","russia","tajikistan","turkmenistan","ukraine","uzbekistan"];

const YUGOSLAVIA = ["bosnia-and-herzegovina","croatia","montenegro",
  "north-macedonia","serbia","slovenia"];

// Poland intentionally excluded — its countries prop already records
// independence from Germany (1944), not the USSR

const dryRun = process.argv.includes("--dryrun");

async function apply(keys, flags) {
  const label = flags[0];
  const entities = await fetchEntities({ list: "countries", key: { $in: keys } });

  const updates = entities.map(e => ({
    _id: e._id,
    fields: { "props.independence.flags": flags },
  }));

  if (dryRun) {
    console.log(`[dry] Would set props.independence.flags: ["${label}"] on ${updates.length} entities:`);
    console.log(`      ${keys.join(", ")}`);
    return;
  }

  await bulkSetFields(updates);
  console.log(`✅ ${label}: updated ${updates.length} entities`);
}

await apply(SOVIET, ["soviet-union"]);
await apply(YUGOSLAVIA, ["yugoslavia"]);

console.log(dryRun ? "\n[DRY RUN] No changes written." : "\nDone.");
