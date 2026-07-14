"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseRouteIds, resolveDirectionForRoute } = require("../route-config.js");

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
