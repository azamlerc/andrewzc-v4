// andrewzc stats links
// Show Wikipedia link language breakdown across all entities.

import { fetchEntities } from "../database.js";

export async function run(_args, _opts) {
  const entities = await fetchEntities(
    { link: { $regex: "wikipedia\\.org" } },
    { projection: { link: 1 } }
  );

  const counts = {};
  for (const { link } of entities) {
    const m = link.match(/^https?:\/\/([a-z]{2})\.wikipedia\.org/);
    const lang = m ? m[1] : "?";
    counts[lang] = (counts[lang] ?? 0) + 1;
  }

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total  = sorted.reduce((s, [, n]) => s + n, 0);

  console.log(`\n📊 Wikipedia Link Languages (${total} total)\n`);

  const maxLang = Math.max(...sorted.map(([l]) => l.length));
  for (const [lang, count] of sorted) {
    const pct = ((count / total) * 100).toFixed(1).padStart(5);
    console.log(`  ${lang.padEnd(maxLang)}  ${String(count).padStart(6)}  ${pct}%`);
  }

  console.log();
}
