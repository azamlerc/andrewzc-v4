// andrewzc props delete <list> <prop>
// Delete a prop from all entities in a list, and from the page schema.

import { processEntities, queryPages, updatePage } from "../database.js";

export async function run([list, propName], _opts) {
  if (!list || !propName) {
    console.error("Usage: andrewzc props delete <list> <prop>");
    process.exit(1);
  }

  await processEntities(
    { list, [`props.${propName}`]: { $exists: true } },
    (entity) => {
      const props = { ...entity.props };
      delete props[propName];
      entity.props = props;
    }
  );

  const [page] = await queryPages({ key: list });
  if (page?.props) {
    const updated = Object.fromEntries(
      Object.entries(page.props).filter(([k]) => k !== propName && !k.startsWith(`${propName}.`))
    );
    await updatePage(list, { props: updated });
    console.log(`✅ Removed "${propName}" from pages/${list}.props`);
  } else {
    console.log(`⚠️  No props schema on page "${list}"`);
  }
}
