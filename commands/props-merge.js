// andrewzc props merge <main-list> <detail-list> [--dryrun]
// Merge entities from a detail list into props of a main list.

import { fetchEntities, fetchEntity, bulkSetFields, insertEntity, pushToEntityField } from "../database.js";
import { simplify } from "../utilities.js";

function computeValue(entity, subName) {
  const prefix           = entity.prefix;
  const hasBadges        = entity.badges?.length > 0;
  const hasStrike        = entity.strike === true;
  const hasMultipleIcons = entity.icons?.length > 1;
  const extraIcons       = entity.icons?.slice(1);

  if (subName) {
    const item = { name: subName, value: prefix || true };
    if (hasStrike)        item.strike = true;
    if (hasBadges)        item.badges = entity.badges;
    if (hasMultipleIcons) item.icons  = extraIcons;
    return { value: item, isArray: true };
  }

  if (hasBadges || hasStrike || hasMultipleIcons) {
    const obj = { value: prefix || true };
    if (hasStrike)        obj.strike = true;
    if (hasBadges)        obj.badges = entity.badges;
    if (hasMultipleIcons) obj.icons  = extraIcons;
    return { value: obj, isArray: false };
  }

  return { value: prefix || true, isArray: false };
}

export async function run([mainList, detailList], { dryRun }) {
  if (!mainList || !detailList) {
    console.error("Usage: andrewzc props merge <main-list> <detail-list> [--dryrun]");
    process.exit(1);
  }

  if (dryRun) console.log("🔍 DRY RUN — no changes will be written\n");

  const detailEntities = await fetchEntities({ list: detailList });
  console.log(`Found ${detailEntities.length} entities in "${detailList}"`);
  if (detailEntities.length === 0) process.exit(0);

  let modified = 0, created = 0;

  for (const detail of detailEntities) {
    const nameMatch = detail.name.match(/^(.+?)\s*\((.+?)\)$/);
    const baseKey   = nameMatch ? simplify(nameMatch[1]) : detail.key;
    const subName   = nameMatch ? nameMatch[2].trim() : null;

    const { value, isArray } = computeValue(detail, subName);
    const propField = `props.${detailList}`;

    let mainEntity = await fetchEntity(mainList, baseKey);

    if (!mainEntity) {
      if (dryRun) { console.log(`Would create: ${mainList}/${baseKey}`); continue; }
      const { _id, list: _list, ...fields } = detail;
      mainEntity = await insertEntity({
        ...fields, key: baseKey, list: mainList,
        dateAdded: new Date().toISOString().split("T")[0], props: {},
      });
      created++;
      console.log(`✨ Created ${mainList}/${baseKey}`);
    }

    if (dryRun) {
      console.log(`Would set ${mainList}/${baseKey} ${propField} = ${JSON.stringify(value)}`);
      continue;
    }

    if (isArray) {
      const exists = Array.isArray(mainEntity.props?.[detailList]);
      await pushToEntityField(mainEntity._id, propField, value, exists);
    } else {
      await bulkSetFields([{ _id: mainEntity._id, fields: { [propField]: value } }]);
    }

    modified++;
    if (modified % 20 === 0) console.log(`Progress: ${modified}/${detailEntities.length}...`);
  }

  console.log(`\n✅ Done. Modified: ${modified}, Created: ${created}`);
}
