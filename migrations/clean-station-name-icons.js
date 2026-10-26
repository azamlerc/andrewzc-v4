#!/usr/bin/env node
// Remove duplicated top-level icons from the four migrated station-name pages.
// Usage: node migrations/clean-station-name-icons.js [--dryrun]
import "dotenv/config";
import { MongoClient } from "mongodb";

const lists = ["metro-animals", "metro-cars", "metro-colors", "metro-numbers"];
const dryRun = process.argv.includes("--dryrun");
const client = new MongoClient(process.env.MONGODB_URI);
try {
  await client.connect();
  const entities = client.db(process.env.MONGODB_DB || "andrewzc").collection("entities");
  const stations = await entities.find({
    list: "stations",
    "icons.1": { $exists: true },
    $or: lists.map(list => ({ [`props.${list}`]: { $exists: true } })),
  }).toArray();

  // Check every record before writing; preserve repeated digits such as Once's 1,1.
  for (const station of stations) {
    if (!Array.isArray(station.icons)) throw new Error(`Invalid icons: ${station.key}`);
    const propIcons = lists.flatMap(list => {
      const prop = station.props?.[list];
      return (Array.isArray(prop) ? prop : [prop]).flatMap(value => value?.icons || []);
    });
    for (const icon of station.icons.slice(1)) {
      const index = propIcons.indexOf(icon);
      if (index < 0) throw new Error(`Icon not preserved in props: ${station.key} ${icon}`);
      propIcons.splice(index, 1);
    }
  }

  console.log(`${dryRun ? "Would clean" : "Cleaning"} ${stations.length} stations`);
  if (!dryRun && stations.length) {
    const result = await entities.bulkWrite(stations.map(station => ({
      updateOne: {
        filter: { _id: station._id, icons: station.icons },
        update: { $set: { icons: station.icons.slice(0, 1) } },
      },
    })));
    console.log(`Modified: ${result.modifiedCount}`);
    if (result.matchedCount !== stations.length) throw new Error("Some icons changed concurrently; rerun the migration");
    const after = await entities.find({ _id: { $in: stations.map(s => s._id) } }).toArray();
    for (const station of after) {
      const before = stations.find(s => s._id.equals(station._id));
      if (JSON.stringify(station.icons) !== JSON.stringify(before.icons.slice(0, 1)) ||
          JSON.stringify(station.props) !== JSON.stringify(before.props)) {
        throw new Error(`Verification failed: ${station.key}`);
      }
    }
    console.log("Verified: first icons retained and all props unchanged.");
  }
} finally {
  await client.close();
}
