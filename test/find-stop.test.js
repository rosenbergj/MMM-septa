"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  pickRepresentativePatterns,
  countTripsByStop,
  pickAnnotatedRows,
  directionHeaderLabel,
  directionConfigFragment,
} = require("../scripts/find-stop.js");

// Builds a minimal pattern with just the fields pickRepresentativePatterns
// reads: tripId, headsign, directionId, and a stop sequence (only stopId
// matters for its dedup key -- stopSequence/stopName are included for shape
// realism but not otherwise exercised here).
function patternWithStops({ tripId, headsign, directionId = "0", stopIds }) {
  return {
    tripId,
    headsign,
    directionId,
    stops: stopIds.map((stopId, index) => ({ stopId, stopSequence: index + 1, stopName: `stop ${stopId}` })),
  };
}

// Builds a merged-view row of the shape mergeDirectionPatterns returns and
// printMergedDirection consumes. `breakBefore` is only ever set on alt rows.
function row(type, stopId, breakBefore = false) {
  const base = { type, stopId, stopSequence: stopId, stopName: `stop ${stopId}` };
  return breakBefore ? { ...base, breakBefore: true } : base;
}

test("countTripsByStop", async (t) => {
  await t.test("counts one per trip, not one per pattern", () => {
    const patterns = [
      patternWithStops({ tripId: "a", headsign: "X", stopIds: [1, 2, 3] }),
      patternWithStops({ tripId: "b", headsign: "X", stopIds: [1, 2, 3] }),
      patternWithStops({ tripId: "c", headsign: "X", stopIds: [1, 2] }),
    ];
    const counts = countTripsByStop(patterns, "0");
    assert.equal(counts.get(1), 3);
    assert.equal(counts.get(2), 3);
    assert.equal(counts.get(3), 2);
  });

  await t.test("filters to the requested direction", () => {
    const patterns = [
      patternWithStops({ tripId: "n", headsign: "X", directionId: "0", stopIds: [1, 2] }),
      patternWithStops({ tripId: "s", headsign: "Y", directionId: "1", stopIds: [1, 2] }),
    ];
    assert.equal(countTripsByStop(patterns, "0").get(1), 1);
    assert.equal(countTripsByStop(patterns, "1").get(1), 1);
  });

  await t.test("directionId is compared as a string -- parsed trips carry \"0\"/\"1\", not 0/1", () => {
    const patterns = [patternWithStops({ tripId: "n", headsign: "X", directionId: "0", stopIds: [1] })];
    assert.equal(countTripsByStop(patterns, 0).get(1), 1);
  });

  await t.test("a stop visited twice on one trip (loop turnaround) still counts as one trip", () => {
    const patterns = [patternWithStops({ tripId: "loop", headsign: "X", stopIds: [1, 2, 3, 2, 1] })];
    const counts = countTripsByStop(patterns, "0");
    assert.equal(counts.get(1), 1);
    assert.equal(counts.get(2), 1);
  });

  await t.test("no directionId counts every direction together", () => {
    const patterns = [
      patternWithStops({ tripId: "n", headsign: "X", directionId: "0", stopIds: [1] }),
      patternWithStops({ tripId: "s", headsign: "Y", directionId: "1", stopIds: [1] }),
    ];
    assert.equal(countTripsByStop(patterns, null).get(1), 2);
  });

  await t.test("no patterns -> empty map", () => {
    assert.equal(countTripsByStop([], "0").size, 0);
  });
});

test("pickAnnotatedRows", async (t) => {
  await t.test("uniform single-pattern direction -> only first and last", () => {
    const rows = [1, 2, 3, 4, 5].map((id) => row("stop", id));
    const trips = new Map(rows.map((r) => [r.stopId, 40]));
    assert.deepEqual(pickAnnotatedRows(rows, trips), [true, false, false, false, true]);
  });

  await t.test("a row whose count differs from the row above it is annotated", () => {
    const rows = [1, 2, 3, 4].map((id) => row("stop", id));
    const trips = new Map([
      [1, 40],
      [2, 40],
      [3, 12],
      [4, 12],
    ]);
    assert.deepEqual(pickAnnotatedRows(rows, trips), [true, false, true, true]);
  });

  await t.test("both sides of a stop/alt transition are annotated even at an unchanged count", () => {
    // Blank lines are printed before row 2 (stop->alt) and before row 4
    // (alt->stop), so rows 1,2,3,4 are all adjacent to one.
    const rows = [row("stop", 1), row("alt", 2), row("alt", 3), row("stop", 4), row("stop", 5), row("stop", 6)];
    const trips = new Map(rows.map((r) => [r.stopId, 40]));
    assert.deepEqual(pickAnnotatedRows(rows, trips), [true, true, true, true, false, true]);
  });

  await t.test("a breakBefore split between two alt blocks annotates both sides", () => {
    const rows = [row("stop", 1), row("alt", 2), row("alt", 3, true), row("alt", 4), row("stop", 5)];
    const trips = new Map(rows.map((r) => [r.stopId, 40]));
    // row 2 precedes the break, row 3 follows it; both flagged.
    assert.deepEqual(pickAnnotatedRows(rows, trips), [true, true, true, true, true]);
  });

  await t.test("a stop missing from the counts map reads as 0 rather than throwing", () => {
    const rows = [row("stop", 1), row("stop", 2), row("stop", 3)];
    const trips = new Map([[1, 0]]);
    assert.deepEqual(pickAnnotatedRows(rows, trips), [true, false, true]);
  });

  await t.test("degenerate row counts", () => {
    assert.deepEqual(pickAnnotatedRows([], new Map()), []);
    assert.deepEqual(pickAnnotatedRows([row("stop", 1)], new Map([[1, 5]])), [true]);
    assert.deepEqual(pickAnnotatedRows([row("stop", 1), row("stop", 2)], new Map([[1, 5], [2, 5]])), [true, true]);
  });
});

test("pickRepresentativePatterns", async (t) => {
  await t.test("same headsign, different stop sequences -> both survive (T3-westbound-Yeadon shape)", () => {
    const fullLength = patternWithStops({ tripId: "long", headsign: "Yeadon", stopIds: [1, 2, 3, 4, 5] });
    const shortTurn = patternWithStops({ tripId: "short", headsign: "Yeadon", stopIds: [101, 102, 103] });
    const result = pickRepresentativePatterns([fullLength, shortTurn]);
    assert.equal(result.length, 2);
    assert.deepEqual(new Set(result.map((p) => p.tripId)), new Set(["long", "short"]));
  });

  await t.test("same headsign, identical stop sequence -> collapses to one (true duplicate trips)", () => {
    const morning = patternWithStops({ tripId: "9001", headsign: "Front-Market", stopIds: [1, 2, 3] });
    const evening = patternWithStops({ tripId: "9002", headsign: "Front-Market", stopIds: [1, 2, 3] });
    const result = pickRepresentativePatterns([morning, evening]);
    assert.equal(result.length, 1);
    assert.equal(result[0].tripId, "9001"); // first one seen
  });

  await t.test("different headsigns -> each kept independently, unaffected by the other's shape", () => {
    const a = patternWithStops({ tripId: "a", headsign: "Front-Market", stopIds: [1, 2, 3] });
    const b = patternWithStops({ tripId: "b", headsign: "Broad-Pattison", stopIds: [1, 2, 3, 4] });
    const result = pickRepresentativePatterns([a, b]);
    assert.equal(result.length, 2);
  });

  await t.test("same headsign and stop sequence but different directionId -> kept separate", () => {
    const northbound = patternWithStops({ tripId: "n", headsign: "Loop", directionId: "0", stopIds: [1, 2, 3] });
    const southbound = patternWithStops({ tripId: "s", headsign: "Loop", directionId: "1", stopIds: [1, 2, 3] });
    const result = pickRepresentativePatterns([northbound, southbound]);
    assert.equal(result.length, 2);
  });

  await t.test("a same-headsign subset pattern (no stops of its own) still survives pickRepresentativePatterns itself -- mergeDirectionPatterns is what absorbs it, not this function", () => {
    const fullLength = patternWithStops({ tripId: "full", headsign: "Broad-Pattison", stopIds: [1, 2, 3, 4, 5] });
    const subset = patternWithStops({ tripId: "partial", headsign: "Broad-Pattison", stopIds: [3, 4, 5] });
    const result = pickRepresentativePatterns([fullLength, subset]);
    assert.equal(result.length, 2);
  });

  await t.test("no headsign -> falls back to a per-trip key, never collapsed with another tripless pattern", () => {
    const a = patternWithStops({ tripId: "a", headsign: null, stopIds: [1, 2, 3] });
    const b = patternWithStops({ tripId: "b", headsign: null, stopIds: [1, 2, 3] });
    const result = pickRepresentativePatterns([a, b]);
    assert.equal(result.length, 2);
  });

  await t.test("empty input -> empty output", () => {
    assert.deepEqual(pickRepresentativePatterns([]), []);
  });
});

test("directionHeaderLabel", async (t) => {
  await t.test("a directionId with a name -> the name itself", () => {
    const directionNames = new Map([["0", "Northbound"]]);
    assert.equal(directionHeaderLabel(directionNames, "0"), "Northbound");
  });

  await t.test("a directionId missing from directions.txt -> the unknown-direction message", () => {
    const directionNames = new Map();
    assert.equal(
      directionHeaderLabel(directionNames, "1"),
      "Unknown Direction (direction_id 1 -- not listed in SEPTA's directions.txt)"
    );
  });
});

test("directionConfigFragment", async (t) => {
  await t.test("a directionId with a name -> that name, no comment", () => {
    const directionNames = new Map([["0", "Northbound"]]);
    const fragment = directionConfigFragment(directionNames, "0");
    assert.equal(fragment.value, `"Northbound"`);
    assert.equal(fragment.comment, null);
  });

  await t.test("a directionId missing from directions.txt -> a TODO with an explanatory comment", () => {
    const directionNames = new Map();
    const fragment = directionConfigFragment(directionNames, "1");
    assert.equal(fragment.value, `"TODO_CONFIRM_DIRECTION"`);
    assert.match(fragment.comment, /direction_id 1/);
    assert.match(fragment.comment, /directions\.txt/);
  });
});
