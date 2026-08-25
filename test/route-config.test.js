"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseRouteIds,
  resolveDirectionForRoute,
  resolveScheduleHorizonMinutes,
  DEFAULT_SCHEDULE_HORIZON_MINUTES,
  MAX_SCHEDULE_HORIZON_MINUTES,
} = require("../route-config.js");

test("parseRouteIds", async (t) => {
  await t.test("a single unmerged routeId -> one-element array", () => {
    assert.deepEqual(parseRouteIds("17"), ["17"]);
  });

  await t.test("comma-separated string -> array, trimmed", () => {
    assert.deepEqual(parseRouteIds("T2,T3,T4,T5"), ["T2", "T3", "T4", "T5"]);
  });

  await t.test("comma-separated string with stray whitespace -> still trimmed", () => {
    assert.deepEqual(parseRouteIds("T2, T3 , T4"), ["T2", "T3", "T4"]);
  });

  await t.test("bare JSON array -> used as-is, coerced to strings", () => {
    assert.deepEqual(parseRouteIds(["T2", "T3"]), ["T2", "T3"]);
  });

  await t.test("a numeric routeId -> stringified single-element array", () => {
    assert.deepEqual(parseRouteIds(17), ["17"]);
  });

  await t.test("empty entries from stray commas are dropped", () => {
    assert.deepEqual(parseRouteIds("T2,,T3"), ["T2", "T3"]);
  });
});

test("resolveDirectionForRoute", async (t) => {
  await t.test("a plain string applies uniformly to every sub-route", () => {
    assert.equal(resolveDirectionForRoute("Westbound", "T2"), "Westbound");
    assert.equal(resolveDirectionForRoute("Westbound", "T5"), "Westbound");
  });

  await t.test("a {routeId: direction} map resolves per sub-route", () => {
    const direction = { "2": "Northbound", "17": "Eastbound" };
    assert.equal(resolveDirectionForRoute(direction, "2"), "Northbound");
    assert.equal(resolveDirectionForRoute(direction, "17"), "Eastbound");
  });

  await t.test("a sub-route missing from the map -> undefined (config error, not a crash)", () => {
    const direction = { "2": "Northbound" };
    assert.equal(resolveDirectionForRoute(direction, "17"), undefined);
  });

  await t.test("null/undefined direction -> passed through as-is", () => {
    assert.equal(resolveDirectionForRoute(null, "17"), null);
    assert.equal(resolveDirectionForRoute(undefined, "17"), undefined);
  });
});

test("resolveScheduleHorizonMinutes", async (t) => {
  await t.test("an in-range value is used as-is", () => {
    assert.equal(resolveScheduleHorizonMinutes(30), 30);
  });

  await t.test("a numeric string is coerced, not rejected", () => {
    assert.equal(resolveScheduleHorizonMinutes("90"), 90);
  });

  await t.test("the ceiling itself is in range, not clamped", () => {
    assert.equal(resolveScheduleHorizonMinutes(MAX_SCHEDULE_HORIZON_MINUTES), MAX_SCHEDULE_HORIZON_MINUTES);
  });

  await t.test("past the ceiling -> the ceiling, not the default", () => {
    assert.equal(resolveScheduleHorizonMinutes(MAX_SCHEDULE_HORIZON_MINUTES + 1), MAX_SCHEDULE_HORIZON_MINUTES);
  });

  await t.test("a horizon past 24h (which would double-count trips) is clamped well below it", () => {
    assert.equal(resolveScheduleHorizonMinutes(48 * 60), MAX_SCHEDULE_HORIZON_MINUTES);
    assert.ok(MAX_SCHEDULE_HORIZON_MINUTES < 24 * 60);
  });

  await t.test("zero -> the ceiling, not the default (useScheduleSupplement:false is how you turn it off)", () => {
    assert.equal(resolveScheduleHorizonMinutes(0), MAX_SCHEDULE_HORIZON_MINUTES);
  });

  await t.test("negative -> the ceiling", () => {
    assert.equal(resolveScheduleHorizonMinutes(-5), MAX_SCHEDULE_HORIZON_MINUTES);
  });

  await t.test("Infinity counts as past the ceiling, not as nonsense", () => {
    assert.equal(resolveScheduleHorizonMinutes(Infinity), MAX_SCHEDULE_HORIZON_MINUTES);
    assert.equal(resolveScheduleHorizonMinutes(-Infinity), MAX_SCHEDULE_HORIZON_MINUTES);
  });

  await t.test("unset -> the default", () => {
    assert.equal(resolveScheduleHorizonMinutes(undefined), DEFAULT_SCHEDULE_HORIZON_MINUTES);
  });

  await t.test("an unparseable string -> the default", () => {
    assert.equal(resolveScheduleHorizonMinutes("soon"), DEFAULT_SCHEDULE_HORIZON_MINUTES);
    assert.equal(resolveScheduleHorizonMinutes(NaN), DEFAULT_SCHEDULE_HORIZON_MINUTES);
  });

  await t.test("zero as a numeric string still means unlimited", () => {
    assert.equal(resolveScheduleHorizonMinutes("0"), MAX_SCHEDULE_HORIZON_MINUTES);
  });

  await t.test("null and \"\" express no number -> the default, NOT the ceiling", () => {
    // They'd coerce to 0 under Number(), which would wrongly read as
    // "unlimited" -- the type check exists to stop exactly that.
    assert.equal(resolveScheduleHorizonMinutes(null), DEFAULT_SCHEDULE_HORIZON_MINUTES);
    assert.equal(resolveScheduleHorizonMinutes(""), DEFAULT_SCHEDULE_HORIZON_MINUTES);
    assert.equal(resolveScheduleHorizonMinutes("   "), DEFAULT_SCHEDULE_HORIZON_MINUTES);
  });

  await t.test("booleans and arrays express no number either -> the default", () => {
    assert.equal(resolveScheduleHorizonMinutes(false), DEFAULT_SCHEDULE_HORIZON_MINUTES);
    assert.equal(resolveScheduleHorizonMinutes(true), DEFAULT_SCHEDULE_HORIZON_MINUTES);
    assert.equal(resolveScheduleHorizonMinutes([]), DEFAULT_SCHEDULE_HORIZON_MINUTES);
  });

  await t.test("the default stays below the ceiling", () => {
    assert.ok(DEFAULT_SCHEDULE_HORIZON_MINUTES < MAX_SCHEDULE_HORIZON_MINUTES);
  });
});
