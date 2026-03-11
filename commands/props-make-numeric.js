// andrewzc props make-numeric <list> <prop>
// Convert string prop values to numbers. Handles $, K, M suffixes.

import { processEntities, queryPages, updatePage } from "../database.js";

function getNestedValue(obj, path) {
  return path.split(".").reduce((cur, key) => cur?.[key], obj);
}

function setNestedValue(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function toNumber(val) {
  if (typeof val === "number") return val;
  if (typeof val !== "string") return null;
  let s = val.trim().replace(/^\$/, "");
  const multiplier =
    /[Mm]$/.test(s) ? 1_000_000 :
    /[Kk]$/.test(s) ? 1_000 : 1;
  if (multiplier !== 1) s = s.slice(0, -1);
  const n = Number(s);
  if (isNaN(n)) return null;
  return n * multiplier;
}

export async function run([list, propPath], _opts) {
  if (!list || !propPath) {
    console.error("Usage: andrewzc props make-numeric <list> <prop>");
    process.exit(1);
  }

  const skippedValues = [];

  await processEntities(
    { list, [`props.${propPath}`]: { $exists: true } },
    (entity) => {
      const props = { ...entity.props };
      const raw   = getNestedValue(props, propPath);

      if (Array.isArray(raw)) {
        const converted = raw.map(item => {
          if (item && typeof item === "object" && "value" in item) {
            const n = toNumber(item.value);
            if (n === null) { skippedValues.push(`${entity.name}: ${JSON.stringify(item.value)}`); return item; }
            return { ...item, value: n };
          }
          const n = toNumber(item);
          if (n === null) { skippedValues.push(`${entity.name}: ${JSON.stringify(item)}`); return item; }
          return n;
        });
        setNestedValue(props, propPath, converted);
      } else {
        const n = toNumber(raw);
        if (n === null) { skippedValues.push(`${entity.name}: ${JSON.stringify(raw)}`); return; }
        setNestedValue(props, propPath, n);
      }

      entity.props = props;
    }
  );

  if (skippedValues.length > 0) {
    console.log(`\n⚠️  Could not convert ${skippedValues.length} value(s):`);
    for (const s of skippedValues) console.log(`   ${s}`);
  }

  const [page] = await queryPages({ key: list });
  if (page?.props) {
    const updated = { ...page.props };
    for (const key of Object.keys(updated)) {
      if ((key === propPath || key.startsWith(`${propPath}.`)) && updated[key] === "string") {
        updated[key] = "number";
      }
    }
    await updatePage(list, { props: updated });
    console.log(`✅ "${propPath}" marked as number in pages/${list}.props`);
  } else {
    console.log(`⚠️  No props schema on page "${list}"`);
  }
}
