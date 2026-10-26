import test from "node:test";
import assert from "node:assert/strict";
import { backfillLocations, locationFromCoords, run } from "../commands/location-backfill.js";

test("conversion preserves precision, reverses axes, and accepts zero and DMS", () => {
  assert.deepEqual(locationFromCoords("1.12345, -34.5678"), { type: "Point", coordinates: [-34.5678, 1.12345] });
  assert.deepEqual(locationFromCoords("0, 0"), { type: "Point", coordinates: [0, 0] });
  assert.deepEqual(locationFromCoords("90, -180"), { type: "Point", coordinates: [-180, 90] });
  assert.deepEqual(locationFromCoords('40°30′0″N, 73°30′0″W'), { type: "Point", coordinates: [-73.5, 40.5] });
});

test("unknown, malformed, ambiguous, and out-of-range values are never guessed", () => {
  for (const value of [null, "", "not-found", "unknown", [1, 2], "91, 0", "0, 181", "NaN, 0", "1e2, 0",
    "1, 2, 3", "1E, 2N", "1NS, 2", "1 2, 3", "40°60′N, 0", "hello, world"]) {
    assert.equal(locationFromCoords(value), null, JSON.stringify(value));
  }
});

function collection(docs, modifiedCount) {
  return {
    writes: [], query: null,
    find(filter, options) {
      this.query = { filter, options };
      return (async function* () { yield* docs; })();
    },
    async bulkWrite(batch) {
      this.writes.push(...batch);
      return { modifiedCount: modifiedCount ?? batch.length };
    },
  };
}

test("backfill only sets location, scopes by list, and protects concurrent edits", async () => {
  const doc = { _id: "a", list: "bridges", key: "a", coords: "1, 2" };
  const col = collection([doc, { _id: "b", coords: "not-found" }, { _id: "c", coords: "bad" }]);
  const stats = await backfillLocations(col, { list: "bridges", log() {} });
  assert.deepEqual(stats, { examined: 3, candidates: 1, updated: 1, unknown: 1, invalid: 1 });
  assert.deepEqual(col.query.filter, { location: null, coords: { $exists: true }, list: "bridges" });
  assert.deepEqual(col.writes, [{ updateOne: {
    filter: { _id: "a", location: null, coords: "1, 2" },
    update: { $set: { location: { type: "Point", coordinates: [2, 1] } } },
  } }]);
});

test("dry run covers all lists without writes; repeat run has no candidates", async () => {
  const col = collection([{ _id: "a", coords: "1, 2" }]);
  const stats = await backfillLocations(col, { dryRun: true, log() {} });
  assert.equal(stats.candidates, 1);
  assert.equal(stats.updated, 0);
  assert.equal(col.writes.length, 0);
  assert.deepEqual(col.query.filter, { location: null, coords: { $exists: true } });
  const repeated = await backfillLocations(collection([]), { log() {} });
  assert.equal(repeated.candidates, 0);
  assert.equal(repeated.updated, 0);
});

test("reports actual writes when a candidate no longer matches", async () => {
  const stats = await backfillLocations(collection([{ _id: "a", coords: "1, 2" }], 0), { log() {} });
  assert.equal(stats.candidates, 1);
  assert.equal(stats.updated, 0);
});

test("rejects unexpected arguments before connecting", async () => {
  await assert.rejects(run(["a", "b"]), /Usage:/);
  await assert.rejects(run(["--overwrite"]), /Usage:/);
});
