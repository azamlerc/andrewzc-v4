import test from "node:test";
import assert from "node:assert/strict";
import { assignCities, validCity } from "../commands/enrich-set-city-from-cities.js";
import { CITY_RADIUS_KM, findNearestCity } from "../utilities.js";
const point = coordinates => ({ type: "Point", coordinates });
const city = (key, longitude) => ({ key, name: key.toUpperCase(), location: point([longitude, 0]) });
const entity = (id, distance) => ({ _id: id, key: id, list: "bridges", location: point([0, 0]), cityDistanceMeters: distance });
function collection(results, modified = null) {
  const queries = [], writes = [];
  return {
    queries, writes,
    aggregate(pipeline) {
      queries.push(pipeline);
      return (async function* () { yield* results[pipeline[0].$geoNear.near.coordinates[0]]; })();
    },
    async bulkWrite(batch) { writes.push(...batch); return { modifiedCount: modified ?? batch.length }; },
  };
}
test("overlapping radii choose nearest, ties use city key independent of iteration", async () => {
  for (const cities of [[city("a", 0), city("b", 1)], [city("b", 1), city("a", 0)]]) {
    const col = collection({ 0: [entity("closer-b", 100), entity("tie", 50)], 1: [entity("closer-b", 20), entity("tie", 50)] });
    const result = await assignCities(col, cities, { log() {} });
    assert.equal(result.updated, 2);
    const assigned = Object.fromEntries(col.writes.map(w => [w.updateOne.filter._id, w.updateOne.update.$set.city]));
    assert.deepEqual(assigned, { "closer-b": "B", tie: "A" });
    assert.equal(col.queries[0][0].$geoNear.maxDistance, CITY_RADIUS_KM * 1000);
    assert.deepEqual(col.queries[0][0].$geoNear.query, {
      city: { $exists: false }, list: { $nin: ["places", "all-cities", "cities"] },
    });
    assert.deepEqual(col.writes[0].updateOne.filter.list, { $nin: ["places", "all-cities", "cities"] });
    assert.deepEqual(col.writes[0].updateOne.filter.city, { $exists: false });
    assert.deepEqual(col.writes[0].updateOne.filter.location, point([0, 0]));
  }
});
test("dry run resolves overlaps but never writes", async () => {
  const col = collection({ 0: [entity("x", 5)] });
  assert.deepEqual(await assignCities(col, [city("a", 0)], { dryRun: true, log() {} }), { candidates: 1, updated: 0, skipped: 0 });
  assert.equal(col.writes.length, 0);
});
test("invalid cities are skipped; concurrent nonmatches are not counted as updates", async () => {
  const col = collection({ 0: [entity("x", 5)] }, 0);
  const result = await assignCities(col, [{ key: "bad" }, city("a", 0)], { log() {} });
  assert.deepEqual(result, { candidates: 1, updated: 0, skipped: 1 });
  assert.equal(col.queries.length, 1);
  assert.equal(validCity({ ...city("bad", 181) }), false);
});
test("existing nearest-city helper shares the same radius", async () => {
  let query;
  const col = { find(q) { query = q; return { limit() { return { async toArray() { return [{ name: "A" }]; } }; } }; } };
  assert.equal(await findNearestCity(point([0, 0]), col), "A");
  assert.equal(query.location.$nearSphere.$maxDistance, CITY_RADIUS_KM * 1000);
});
