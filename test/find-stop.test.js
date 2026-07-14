"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  pickRepresentativePatterns,
  computeDirectionTrend,
  applyGeographySanityCheck,
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

// Builds a minimal pattern with just the fields computeDirectionTrend reads:
// two stops (first/last), each with a lat/lon. stopSequence/stopName aren't
// needed for these tests but are included for shape realism.
function pattern({ tripId, stopCount, firstLat, firstLon, lastLat, lastLon }) {
  const stops = [{ stopId: 1, stopSequence: 1, stopName: "start", stopLat: firstLat, stopLon: firstLon }];
  // Padding stops in between so `stops.length` can differ between patterns
  // (computeDirectionTrend only looks at the first and last stop's
  // coordinates, so the padding stops' own lat/lon don't matter).
  for (let i = 2; i < stopCount; i++) {
    stops.push({ stopId: i, stopSequence: i, stopName: `mid ${i}`, stopLat: null, stopLon: null });
  }
  stops.push({ stopId: 999, stopSequence: stopCount, stopName: "end", stopLat: lastLat, stopLon: lastLon });
  return { tripId, headsign: `headsign-${tripId}`, directionId: "0", stops };
}

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

test("computeDirectionTrend", async (t) => {
  await t.test("clear north-south displacement -> NS axis, Northbound", () => {
    const p = pattern({ tripId: "1", stopCount: 5, firstLat: 39.9, firstLon: -75.16, lastLat: 40.0, lastLon: -75.17 });
    const trend = computeDirectionTrend([p]);
    assert.deepEqual(trend, { dominantAxis: "NS", name: "Northbound" });
  });

  await t.test("clear north-south displacement, reversed -> Southbound", () => {
    const p = pattern({ tripId: "1", stopCount: 5, firstLat: 40.0, firstLon: -75.16, lastLat: 39.9, lastLon: -75.17 });
    const trend = computeDirectionTrend([p]);
    assert.deepEqual(trend, { dominantAxis: "NS", name: "Southbound" });
  });

  await t.test("clear east-west displacement -> EW axis, Eastbound/Westbound", () => {
    const east = pattern({ tripId: "1", stopCount: 5, firstLat: 39.95, firstLon: -75.3, lastLat: 39.95, lastLon: -75.1 });
    assert.deepEqual(computeDirectionTrend([east]), { dominantAxis: "EW", name: "Eastbound" });

    const west = pattern({ tripId: "1", stopCount: 5, firstLat: 39.95, firstLon: -75.1, lastLat: 39.95, lastLon: -75.3 });
    assert.deepEqual(computeDirectionTrend([west]), { dominantAxis: "EW", name: "Westbound" });
  });

  await t.test("displacement below the floor -> null (too ambiguous to call)", () => {
    // ~0.1mi of north-south drift, well under MIN_TREND_DISPLACEMENT_MILES.
    const p = pattern({ tripId: "1", stopCount: 3, firstLat: 39.95, firstLon: -75.16, lastLat: 39.9515, lastLon: -75.16 });
    assert.equal(computeDirectionTrend([p]), null);
  });

  await t.test("missing lat/lon on an endpoint -> null, doesn't crash", () => {
    const p = pattern({ tripId: "1", stopCount: 3, firstLat: null, firstLon: null, lastLat: 40.0, lastLon: -75.16 });
    assert.equal(computeDirectionTrend([p]), null);
  });

  await t.test("uses the SHORTEST pattern in the direction, not the longest", () => {
    // The longest pattern detours east at the end (like route 63's real
    // spur) and reads as EW/Eastbound; the shortest pattern sticks to the
    // core north-south run. computeDirectionTrend should report the
    // shortest pattern's trend, not the longest's.
    const longestWithSpur = pattern({
      tripId: "long",
      stopCount: 20,
      firstLat: 39.9,
      firstLon: -75.2,
      lastLat: 40.0,
      lastLon: -75.0,
    });
    const shortestCore = pattern({
      tripId: "short",
      stopCount: 5,
      firstLat: 39.9,
      firstLon: -75.2,
      lastLat: 40.0,
      lastLon: -75.21,
    });
    const trend = computeDirectionTrend([longestWithSpur, shortestCore]);
    assert.deepEqual(trend, { dominantAxis: "NS", name: "Northbound" });
  });
});

test("applyGeographySanityCheck", async (t) => {
  await t.test("axis and sign both agree with geography -> entry left untouched", () => {
    const p = pattern({ tripId: "1", stopCount: 5, firstLat: 39.9, firstLon: -75.16, lastLat: 40.0, lastLon: -75.17 });
    const directionNames = new Map([[0, { name: "Northbound", confirmed: true }]]);
    const byDirection = new Map([[0, [p]]]);
    const result = applyGeographySanityCheck(directionNames, byDirection);
    assert.deepEqual(result.get(0), { name: "Northbound", confirmed: true });
  });

  await t.test("axis mismatch (data says E/W, geography says N/S) -> left untouched, data trusted", () => {
    const p = pattern({ tripId: "1", stopCount: 5, firstLat: 39.9, firstLon: -75.16, lastLat: 40.0, lastLon: -75.17 });
    const directionNames = new Map([[0, { name: "Eastbound", confirmed: true }]]);
    const byDirection = new Map([[0, [p]]]);
    const result = applyGeographySanityCheck(directionNames, byDirection);
    assert.deepEqual(result.get(0), { name: "Eastbound", confirmed: true });
  });

  await t.test("same-axis reversal (data says Northbound, geography clearly says south) -> demoted", () => {
    const p = pattern({ tripId: "1", stopCount: 5, firstLat: 40.0, firstLon: -75.16, lastLat: 39.9, lastLon: -75.17 });
    const directionNames = new Map([[0, { name: "Northbound", confirmed: true }]]);
    const byDirection = new Map([[0, [p]]]);
    const result = applyGeographySanityCheck(directionNames, byDirection);
    assert.deepEqual(result.get(0), { rejectedGeography: true, rejectedName: "Northbound" });
  });

  await t.test("inferred (not confirmed) entries are left alone even if they'd otherwise be reversed", () => {
    const p = pattern({ tripId: "1", stopCount: 5, firstLat: 40.0, firstLon: -75.16, lastLat: 39.9, lastLon: -75.17 });
    const directionNames = new Map([[0, { name: "Northbound", confirmed: false, inferredFrom: "Southbound" }]]);
    const byDirection = new Map([[0, [p]]]);
    const result = applyGeographySanityCheck(directionNames, byDirection);
    assert.deepEqual(result.get(0), { name: "Northbound", confirmed: false, inferredFrom: "Southbound" });
  });

  await t.test("no pattern data for a direction -> left untouched, doesn't crash", () => {
    const directionNames = new Map([[0, { name: "Northbound", confirmed: true }]]);
    const byDirection = new Map();
    const result = applyGeographySanityCheck(directionNames, byDirection);
    assert.deepEqual(result.get(0), { name: "Northbound", confirmed: true });
  });
});

test("directionHeaderLabel", async (t) => {
  await t.test("rejectedGeography entry gets the ambiguous-data message", () => {
    const label = directionHeaderLabel({ rejectedGeography: true, rejectedName: "Northbound" }, 1);
    assert.equal(label, "Unknown Direction (direction_id 1 -- SEPTA provided ambiguous data on what this direction is called)");
  });
});

test("directionConfigFragment", async (t) => {
  await t.test("rejectedGeography entry produces a TODO with an explanatory comment", () => {
    const fragment = directionConfigFragment({ rejectedGeography: true, rejectedName: "Northbound" }, 1);
    assert.equal(fragment.value, `"TODO_CONFIRM_DIRECTION"`);
    assert.match(fragment.comment, /Northbound/);
    assert.match(fragment.comment, /contradicts this direction's own schedule geography/);
  });
});
