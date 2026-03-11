// andrewzc props rename <list> <old-prop> <new-prop>
// Rename a prop (supports dot notation) on all entities and update page schema.

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

function deleteNestedValue(obj, path) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null) return;
    cur = cur[keys[i]];
  }
  delete cur[keys[keys.length - 1]];
}

export async function run([list, oldProp, newProp], _opts) {
  if (!list || !oldProp || !newProp) {
    console.error("Usage: andrewzc props rename <list> <old-prop> <new-prop>");
    process.exit(1);
  }

  await processEntities(
    { list, [`props.${oldProp}`]: { $exists: true } },
    (entity) => {
      const props = { ...entity.props };
      const value = getNestedValue(props, oldProp);
      deleteNestedValue(props, oldProp);
      setNestedValue(props, newProp, value);
      entity.props = props;
    }
  );

  const [page] = await queryPages({ key: list });
  if (page?.props) {
    const updated = Object.fromEntries(
      Object.entries(page.props).map(([k, v]) => [k === oldProp ? newProp : k, v])
    );
    await updatePage(list, { props: updated });
    console.log(`✅ Renamed "${oldProp}" → "${newProp}" in pages/${list}.props`);
  } else {
    console.log(`⚠️  No props schema on page "${list}"`);
  }
}
