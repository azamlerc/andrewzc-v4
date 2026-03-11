// andrewzc props update-schema <list>
// Introspect props on entities and write schema summary to the page document.

import { fetchEntities, updatePage } from "../database.js";

const IGNORED_SUBKEYS = new Set(["strike", "icons", "badges"]);

function introspectProp(key, values) {
  const schema = {};
  for (let value of values) {
    if (value == null) continue;
    if (Array.isArray(value)) { if (value.length === 0) continue; value = value[0]; }
    const t = typeof value;
    if (t !== "object") { schema[key] = t; continue; }
    const subKeys = Object.keys(value).filter(k => !IGNORED_SUBKEYS.has(k));
    if (subKeys.includes("value")) {
      schema[key] = value["value"] === true ? "boolean" : typeof value["value"];
    } else {
      for (const sub of subKeys) {
        const subVal = value[sub];
        if (subVal != null) schema[`${key}.${sub}`] = typeof subVal;
      }
    }
  }
  return schema;
}

export async function run([list], _opts) {
  if (!list) {
    console.error("Usage: andrewzc props update-schema <list>");
    process.exit(1);
  }

  const entities = await fetchEntities({ list, props: { $exists: true } });
  console.log(`Found ${entities.length} entities with props in "${list}"`);
  if (entities.length === 0) process.exit(0);

  const propValues = new Map();
  for (const entity of entities) {
    for (const [key, value] of Object.entries(entity.props || {})) {
      if (!propValues.has(key)) propValues.set(key, []);
      propValues.get(key).push(value);
    }
  }

  const schema = {};
  for (const [key, values] of propValues.entries()) {
    Object.assign(schema, introspectProp(key, values));
  }

  console.log("\nDerived props schema:");
  for (const [k, v] of Object.entries(schema).sort()) {
    console.log(`  ${k}: "${v}"`);
  }

  await updatePage(list, { props: schema });
  console.log(`\n✅ Written to pages/${list}.props`);
}
