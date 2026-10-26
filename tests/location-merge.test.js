import test from "node:test";
import assert from "node:assert/strict";

// The rekey module imports the CLI DB layer, but these merge tests never connect.
process.env.MONGODB_URI ||= "mongodb://127.0.0.1";
const { mergeEntities } = await import("../commands/keys-rekey.js");
const point = (lon, lat) => ({ type: "Point", coordinates: [lon, lat] });

test("rekey merges missing GeoJSON locations without copying legacy data", () => {
  const result = mergeEntities({ name: "A" }, { name: "A", location: point(2, 1), coords: "80, 90" });
  assert.deepEqual(result.$set.location, point(2, 1));
  assert.equal("coords" in result.$set, false);
  assert.equal(result.conflict, false);
});

test("near-identical locations merge while distant GeoJSON locations conflict", () => {
  const original = { name: "A", location: point(2, 1) };
  assert.equal(mergeEntities(original, { name: "A", location: point(2.0001, 1.0001) }).conflict, false);
  const distant = mergeEntities(original, { name: "A", location: point(5, 6) });
  assert.equal(distant.conflict, true);
  assert.equal("location" in distant.$set, false);
});
