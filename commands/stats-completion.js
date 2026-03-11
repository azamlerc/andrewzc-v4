// andrewzc stats completion
// Print completion % (visited/total) for all lists, sorted by % done.

import { fetchCompletionStats } from "../database.js";

export async function run(_args, _opts) {
  const stats = await fetchCompletionStats();

  console.log("\n📊 Completion Stats\n");
  console.log("Icon  Name                                       Done   Total  Percent");
  console.log("─".repeat(70));

  for (const s of stats) {
    const icon    = s.icon;
    const name    = s.name.substring(0, 40).padEnd(42);
    const done    = String(s.visited).padStart(6);
    const total   = String(s.total).padStart(6);
    const percent = (s.percentDone.toFixed(1) + "%").padStart(7);
    console.log(`${icon} ${name} ${done} ${total} ${percent}`);
  }

  console.log("\n✅ Done.\n");
}
