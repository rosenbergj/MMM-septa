"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  isDetourActive,
  findSkippedStopName,
  filterGoodTrips,
  isTripTracked,
  isNoGpsSource,
  filterStopTimes,
  findStopName,
  computeIsFresh,
  pollRoute,
  mergeScheduledArrivals,
} = require("../septa-client.js");

function fixture(name) {
  return require(path.join(__dirname, "fixtures", name));
}

// Builds a fetchImpl stub with no network access: responses is an ordered
// list of [urlSubstring, value] pairs, first match wins. `value` is either a
// plain JSON-able object/array (resolves like a successful fetch) or an
// Error instance (rejects, simulating a network/HTTP failure).
function stubFetch(responses) {
  return async function fetchImpl(url) {
    for (const [substring, value] of responses) {
      if (url.includes(substring)) {
        if (value instanceof Error) throw value;
        return { ok: true, status: 200, statusText: "OK", json: async () => value };
      }
    }
    throw new Error(`stubFetch: no handler for URL: ${url}`);
  };
}

test("isDetourActive", async (t) => {
  await t.test("active window + matching stop -> true", () => {
    const detours = fixture("detours-route17-active.json");
    assert.equal(isDetourActive(detours, 21289, new Date(2026, 0, 1)), true);
    assert.equal(isDetourActive(detours, "21289", new Date(2026, 0, 1)), true);
  });

  await t.test("active window but stop not skipped -> false", () => {
    const detours = fixture("detours-route17-active.json");
    assert.equal(isDetourActive(detours, 99999, new Date(2026, 0, 1)), false);
  });

  await t.test("now before start -> false", () => {
    const detours = [{ start: "1/1/2030, 00:00:00", end: "1/1/2031, 00:00:00", skipped_stops: ["1"] }];
    assert.equal(isDetourActive(detours, 1, new Date(2026, 0, 1)), false);
  });

  await t.test("now after end -> false", () => {
    const detours = [{ start: "1/1/2010, 00:00:00", end: "1/1/2011, 00:00:00", skipped_stops: ["1"] }];
    assert.equal(isDetourActive(detours, 1, new Date(2026, 0, 1)), false);
  });

  await t.test("skipped_stops null -> false", () => {
    const detours = [{ start: "1/1/2020, 00:00:00", end: "1/1/2099, 00:00:00", skipped_stops: null }];
    assert.equal(isDetourActive(detours, 1, new Date(2026, 0, 1)), false);
  });

  await t.test("empty detours array -> false", () => {
    const detours = fixture("detours-route17-empty.json");
    assert.equal(isDetourActive(detours, 21289, new Date(2026, 0, 1)), false);
  });

  await t.test("object-shaped skipped_stops (real API shape) -> true for a matching stop", () => {
    const detours = fixture("detours-route64-live-sample.json");
    assert.equal(isDetourActive(detours, 15210, new Date(2026, 5, 1)), true);
    assert.equal(isDetourActive(detours, "15210", new Date(2026, 5, 1)), true);
  });

  await t.test("object-shaped skipped_stops -> false for a stop not in the map", () => {
    const detours = fixture("detours-route64-live-sample.json");
    assert.equal(isDetourActive(detours, 99999, new Date(2026, 5, 1)), false);
  });

  await t.test("empty-object and null skipped_stops (real API shapes) never match, don't crash", () => {
    const detours = fixture("detours-route2-live-sample.json");
    assert.equal(isDetourActive(detours, 12345, new Date(2026, 6, 10, 10, 0, 0)), false);
  });

  await t.test("day_time_active_info restricts to its daily window (non-crossing)", () => {
    // D12564 in the fixture: stop 8704, active 07:00-15:00 daily, 07/06-07/14.
    const detours = fixture("detours-route2-live-sample.json");
    assert.equal(isDetourActive(detours, 8704, new Date(2026, 6, 10, 10, 0, 0)), true);
    assert.equal(isDetourActive(detours, 8704, new Date(2026, 6, 10, 20, 0, 0)), false);
  });

  await t.test("day_time_active_info window crossing midnight", () => {
    const detours = [
      {
        start: "1/1/2020, 00:00:00",
        end: "1/1/2099, 00:00:00",
        skipped_stops: { 1: ["Test Stop", "0", "0"] },
        day_time_active_info: {
          Sun: "22:00:00-02:00:00",
          Mon: "22:00:00-02:00:00",
          Tue: "22:00:00-02:00:00",
          Wed: "22:00:00-02:00:00",
          Thu: "22:00:00-02:00:00",
          Fri: "22:00:00-02:00:00",
          Sat: "22:00:00-02:00:00",
        },
      },
    ];
    assert.equal(isDetourActive(detours, 1, new Date(2026, 0, 1, 23, 0, 0)), true);
    assert.equal(isDetourActive(detours, 1, new Date(2026, 0, 1, 1, 0, 0)), true);
    assert.equal(isDetourActive(detours, 1, new Date(2026, 0, 1, 12, 0, 0)), false);
  });

  await t.test("missing day_time_active_info -> active for the entire date range", () => {
    const detours = fixture("detours-route17-active.json");
    assert.equal(isDetourActive(detours, 21289, new Date(2026, 0, 1, 3, 0, 0)), true);
  });
});

test("filterGoodTrips", async (t) => {
  const trips = fixture("trips-route17.json");

  await t.test("default (useScheduleSupplement=true): Northbound keeps seq=1 and seq>1, excludes CANCELED", () => {
    const good = filterGoodTrips(trips, "Northbound");
    assert.deepEqual(good.map((trip) => trip.trip_id), ["787404", "900002"]);
  });

  await t.test("default: Southbound keeps ON-TIME trip with seq>1", () => {
    const good = filterGoodTrips(trips, "Southbound");
    assert.deepEqual(good.map((trip) => trip.trip_id), ["787763"]);
  });

  await t.test("default: wrong direction excluded entirely", () => {
    assert.deepEqual(filterGoodTrips(trips, "Eastbound"), []);
  });

  await t.test("default: a trip with no next_stop_sequence at all is still kept (untracked, not dropped)", () => {
    const withMissing = [{ direction_name: "Northbound", status: "ON-TIME", trip_id: "x" }];
    assert.deepEqual(filterGoodTrips(withMissing, "Northbound").map((trip) => trip.trip_id), ["x"]);
  });

  await t.test("useScheduleSupplement=false: Northbound excludes seq<=1 and CANCELED, keeps the rest", () => {
    const good = filterGoodTrips(trips, "Northbound", false);
    assert.deepEqual(good.map((trip) => trip.trip_id), ["900002"]);
  });

  await t.test("useScheduleSupplement=false: missing next_stop_sequence excluded", () => {
    const withMissing = [{ direction_name: "Northbound", status: "ON-TIME", trip_id: "x" }];
    assert.deepEqual(filterGoodTrips(withMissing, "Northbound", false), []);
  });
});

test("isTripTracked", async (t) => {
  const baseTrip = { next_stop_sequence: 5, status: "ON-TIME", vehicle_id: "1234" };

  await t.test("normal in-progress, GPS-tracked trip -> true", () => {
    assert.equal(isTripTracked(baseTrip, { "real-time": true }), true);
  });

  await t.test("next_stop_sequence 1 -> false", () => {
    assert.equal(isTripTracked({ ...baseTrip, next_stop_sequence: 1 }, { "real-time": true }), false);
  });

  await t.test('status "NO GPS" -> false', () => {
    assert.equal(isTripTracked({ ...baseTrip, status: "NO GPS" }, { "real-time": true }), false);
  });

  await t.test('vehicle_id "None" -> false', () => {
    assert.equal(isTripTracked({ ...baseTrip, vehicle_id: "None" }, { "real-time": true }), false);
  });

  await t.test('trip-update "real-time": false -> false', () => {
    assert.equal(isTripTracked(baseTrip, { "real-time": false }), false);
  });

  await t.test("missing tripsEntry -> false", () => {
    assert.equal(isTripTracked(null, { "real-time": true }), false);
  });

  await t.test("missing trip-update trip object -> true (no real-time:false signal to distrust)", () => {
    assert.equal(isTripTracked(baseTrip, undefined), true);
  });
});

test("isNoGpsSource", async (t) => {
  await t.test('status "NO GPS" -> true', () => {
    assert.equal(isNoGpsSource({ status: "NO GPS", vehicle_id: "1234" }), true);
  });

  await t.test('vehicle_id "None" -> true', () => {
    assert.equal(isNoGpsSource({ status: "ON-TIME", vehicle_id: "None" }), true);
  });

  await t.test("normal tracked trip -> false", () => {
    assert.equal(isNoGpsSource({ status: "ON-TIME", vehicle_id: "1234", next_stop_sequence: 5 }), false);
  });

  await t.test("next_stop_sequence 1 with a real vehicle -> false (exempt; has real GPS/delay)", () => {
    assert.equal(isNoGpsSource({ status: "ON-TIME", vehicle_id: "1234", next_stop_sequence: 1 }), false);
  });

  await t.test("missing tripsEntry -> false", () => {
    assert.equal(isNoGpsSource(null), false);
  });
});

test("filterStopTimes", async (t) => {
  const stopTimes = fixture("trip-update-900002.json").stop_times;
  const now = 1783312100;

  await t.test("matches numeric stop_id", () => {
    const result = filterStopTimes(stopTimes, 21289, now);
    assert.deepEqual(result.map((s) => s.stop_id), [21289]);
  });

  await t.test("matches string stop_id (numeric coercion)", () => {
    const result = filterStopTimes(stopTimes, "21289", now);
    assert.deepEqual(result.map((s) => s.stop_id), [21289]);
  });

  await t.test("excludes departed stops", () => {
    const result = filterStopTimes(stopTimes, 40, now);
    assert.deepEqual(result, []);
  });

  await t.test("excludes stops with eta in the past", () => {
    const result = filterStopTimes(stopTimes, 21289, 1783312999);
    assert.deepEqual(result, []);
  });

  await t.test("excludes delay >= 999 sentinel", () => {
    const badDelayStopTimes = fixture("trip-update-787763.json").stop_times;
    const result = filterStopTimes(badDelayStopTimes, 10312, 1783312100);
    assert.deepEqual(result, []);
  });
});

test("findSkippedStopName", async (t) => {
  await t.test("object-shaped skipped_stops -> the stop's name", () => {
    const skippedStops = { 8704: ["Huntingdon St & 17th St", "39.993027", "-75.15956"] };
    assert.equal(findSkippedStopName(skippedStops, "8704"), "Huntingdon St & 17th St");
  });

  await t.test("stop not in the map -> null", () => {
    const skippedStops = { 8704: ["Huntingdon St & 17th St", "39.993027", "-75.15956"] };
    assert.equal(findSkippedStopName(skippedStops, "99999"), null);
  });

  await t.test("array-shaped skipped_stops (no name info) -> null", () => {
    assert.equal(findSkippedStopName(["21289", "21290"], "21289"), null);
  });

  await t.test("null/empty skipped_stops -> null", () => {
    assert.equal(findSkippedStopName(null, "21289"), null);
    assert.equal(findSkippedStopName({}, "21289"), null);
  });
});

test("findStopName", async (t) => {
  const stopTimes = fixture("trip-update-900002.json").stop_times;

  await t.test("matches numeric stop_id", () => {
    assert.equal(findStopName(stopTimes, 21289), "20th St & Oregon Av");
  });

  await t.test("matches string stop_id (numeric coercion)", () => {
    assert.equal(findStopName(stopTimes, "21289"), "20th St & Oregon Av");
  });

  await t.test("no matching stop -> null", () => {
    assert.equal(findStopName(stopTimes, 99999), null);
  });

  await t.test("non-array input -> null", () => {
    assert.equal(findStopName(null, 21289), null);
  });
});

test("computeIsFresh", async (t) => {
  await t.test("null lastFetchTime -> false", () => {
    assert.equal(computeIsFresh(null, 120, 1_000_000), false);
  });

  await t.test("age under refresh interval -> true", () => {
    const now = 1_000_000;
    assert.equal(computeIsFresh(now - 30_000, 120, now), true);
  });

  await t.test("age exactly at 3x refresh interval -> true (boundary)", () => {
    const now = 1_000_000;
    assert.equal(computeIsFresh(now - 120_000 * 3, 120, now), true);
  });

  await t.test("age just over 3x refresh interval -> false", () => {
    const now = 1_000_000;
    assert.equal(computeIsFresh(now - (120_000 * 3 + 1), 120, now), false);
  });
});

test("mergeScheduledArrivals", async (t) => {
  await t.test("matches the 1/11-tracked, 3/12/27/47-scheduled walkthrough exactly", () => {
    const tracked = [
      { eta: 1, headsign: "A", tracked: true, tripId: "live-1" },
      { eta: 11, headsign: "A", tracked: true, tripId: "live-2" },
    ];
    const candidates = [
      { eta: 3, headsign: "A", tripId: "sched-3" },
      { eta: 12, headsign: "A", tripId: "sched-12" },
      { eta: 27, headsign: "A", tripId: "sched-27" },
      { eta: 47, headsign: "A", tripId: "sched-47" },
    ];
    const merged = mergeScheduledArrivals(tracked, candidates);
    assert.deepEqual(
      merged.map((a) => a.eta),
      [1, 11, 12, 27, 47]
    );
    assert.equal(merged[0].tracked, true);
    assert.equal(merged[2].tracked, false);
  });

  await t.test("drops a candidate whose tripId matches an already-tracked trip, even past the cutoff", () => {
    const tracked = [{ eta: 1, headsign: "A", tracked: true, tripId: "live-1" }];
    const candidates = [{ eta: 50, headsign: "A", tripId: "live-1" }];
    assert.deepEqual(mergeScheduledArrivals(tracked, candidates), tracked);
  });

  await t.test("with no tracked arrivals at all, every candidate survives (no cutoff)", () => {
    const candidates = [
      { eta: 5, headsign: "A", tripId: "sched-5" },
      { eta: 40, headsign: "A", tripId: "sched-40" },
    ];
    const merged = mergeScheduledArrivals([], candidates);
    assert.deepEqual(
      merged.map((a) => a.eta),
      [5, 40]
    );
    assert.ok(merged.every((a) => a.tracked === false));
  });
});

test("pollRoute", async (t) => {
  const trips = fixture("trips-route17.json");
  const tripUpdate787404 = fixture("trip-update-787404.json");
  const tripUpdate900002 = fixture("trip-update-900002.json");
  const tripUpdate787763 = fixture("trip-update-787763.json");
  const detoursEmpty = fixture("detours-route17-empty.json");
  const detoursActive = fixture("detours-route17-active.json");
  const fixedNow = () => new Date(1783312100 * 1000);

  await t.test("returns sorted etas for a clean Northbound cycle, tagging the untracked seq=1 trip", async () => {
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", trips],
      ["trip-update/?trip_id=787404", tripUpdate787404],
      ["trip-update/?trip_id=900002", tripUpdate900002],
    ]);
    const result = await pollRoute(
      { routeId: "17", stopId: 21289, direction: "Northbound" },
      { fetchImpl, now: fixedNow }
    );
    assert.deepEqual(result.etas, [
      { eta: 1783312200, headsign: "Front-Market", tracked: true, tripId: "900002" },
      { eta: 1783312560, headsign: "Front-Market", tracked: false, tripId: "787404" },
    ]);
    assert.equal(result.detour, false);
    assert.equal(result.hasTripError, false);
    assert.equal(result.stopName, "20th St & Oregon Av");
  });

  await t.test("useScheduleSupplement=false excludes the untracked seq=1 trip entirely", async () => {
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", trips],
      ["trip-update/?trip_id=900002", tripUpdate900002],
    ]);
    const result = await pollRoute(
      { routeId: "17", stopId: 21289, direction: "Northbound" },
      { fetchImpl, now: fixedNow, useScheduleSupplement: false }
    );
    assert.deepEqual(result.etas, [{ eta: 1783312200, headsign: "Front-Market", tracked: true, tripId: "900002" }]);
    assert.equal(result.hasTripError, false);
  });

  await t.test("drops a NO-GPS trip's arrival when a later tracked arrival exists", async () => {
    const twoTrips = [
      {
        route_id: "17",
        trip_id: "no-gps-1",
        direction_name: "Northbound",
        status: "NO GPS",
        vehicle_id: "None",
        next_stop_sequence: null,
        trip_headsign: "Front-Market",
      },
      {
        route_id: "17",
        trip_id: "tracked-1",
        direction_name: "Northbound",
        status: "ON-TIME",
        vehicle_id: "1234",
        next_stop_sequence: 10,
        trip_headsign: "Front-Market",
      },
    ];
    const noGpsUpdate = {
      trip: { status: "NO GPS" },
      stop_times: [{ stop_id: 21289, eta: 1783312150, delay: 0, departed: false }],
    };
    const trackedUpdate = {
      trip: { status: "ON-TIME", "real-time": true },
      stop_times: [{ stop_id: 21289, eta: 1783312900, delay: 0, departed: false }],
    };
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", twoTrips],
      ["trip-update/?trip_id=no-gps-1", noGpsUpdate],
      ["trip-update/?trip_id=tracked-1", trackedUpdate],
    ]);
    const result = await pollRoute(
      { routeId: "17", stopId: 21289, direction: "Northbound" },
      { fetchImpl, now: fixedNow }
    );
    assert.deepEqual(result.etas.map((a) => a.tripId), ["tracked-1"]);
  });

  await t.test("keeps a NO-GPS trip's arrival when it's later than the latest tracked arrival", async () => {
    const twoTrips = [
      {
        route_id: "17",
        trip_id: "no-gps-1",
        direction_name: "Northbound",
        status: "NO GPS",
        vehicle_id: "None",
        next_stop_sequence: null,
        trip_headsign: "Front-Market",
      },
      {
        route_id: "17",
        trip_id: "tracked-1",
        direction_name: "Northbound",
        status: "ON-TIME",
        vehicle_id: "1234",
        next_stop_sequence: 10,
        trip_headsign: "Front-Market",
      },
    ];
    const noGpsUpdate = {
      trip: { status: "NO GPS" },
      stop_times: [{ stop_id: 21289, eta: 1783313500, delay: 0, departed: false }],
    };
    const trackedUpdate = {
      trip: { status: "ON-TIME", "real-time": true },
      stop_times: [{ stop_id: 21289, eta: 1783312300, delay: 0, departed: false }],
    };
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", twoTrips],
      ["trip-update/?trip_id=no-gps-1", noGpsUpdate],
      ["trip-update/?trip_id=tracked-1", trackedUpdate],
    ]);
    const result = await pollRoute(
      { routeId: "17", stopId: 21289, direction: "Northbound" },
      { fetchImpl, now: fixedNow }
    );
    assert.deepEqual(result.etas.map((a) => a.tripId), ["tracked-1", "no-gps-1"]);
  });

  await t.test("keeps a NO-GPS trip's arrival when there are no tracked arrivals at all", async () => {
    const oneTrip = [
      {
        route_id: "17",
        trip_id: "no-gps-1",
        direction_name: "Northbound",
        status: "NO GPS",
        vehicle_id: "None",
        next_stop_sequence: null,
        trip_headsign: "Front-Market",
      },
    ];
    const noGpsUpdate = {
      trip: { status: "NO GPS" },
      stop_times: [{ stop_id: 21289, eta: 1783312150, delay: 0, departed: false }],
    };
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", oneTrip],
      ["trip-update/?trip_id=no-gps-1", noGpsUpdate],
    ]);
    const result = await pollRoute(
      { routeId: "17", stopId: 21289, direction: "Northbound" },
      { fetchImpl, now: fixedNow }
    );
    assert.deepEqual(result.etas.map((a) => a.tripId), ["no-gps-1"]);
  });

  await t.test("does not apply the NO-GPS cutoff to a next_stop_sequence:1 trip (real GPS/delay, exempt)", async () => {
    const twoTrips = [
      {
        route_id: "17",
        trip_id: "seq1-1",
        direction_name: "Northbound",
        status: "ON-TIME",
        vehicle_id: "5678",
        next_stop_sequence: 1,
        trip_headsign: "Front-Market",
      },
      {
        route_id: "17",
        trip_id: "tracked-1",
        direction_name: "Northbound",
        status: "ON-TIME",
        vehicle_id: "1234",
        next_stop_sequence: 10,
        trip_headsign: "Front-Market",
      },
    ];
    const seq1Update = {
      trip: { status: "ON-TIME", "real-time": true },
      stop_times: [{ stop_id: 21289, eta: 1783312150, delay: 0, departed: false }],
    };
    const trackedUpdate = {
      trip: { status: "ON-TIME", "real-time": true },
      stop_times: [{ stop_id: 21289, eta: 1783312900, delay: 0, departed: false }],
    };
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", twoTrips],
      ["trip-update/?trip_id=seq1-1", seq1Update],
      ["trip-update/?trip_id=tracked-1", trackedUpdate],
    ]);
    const result = await pollRoute(
      { routeId: "17", stopId: 21289, direction: "Northbound" },
      { fetchImpl, now: fixedNow }
    );
    assert.deepEqual(result.etas.map((a) => a.tripId), ["seq1-1", "tracked-1"]);
    assert.equal(result.etas[0].tracked, false);
  });

  await t.test("excludes delay-999 stop_times for a clean Southbound cycle", async () => {
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", trips],
      ["trip-update/?trip_id=787763", tripUpdate787763],
    ]);
    const result = await pollRoute(
      { routeId: "17", stopId: 10311, direction: "Southbound" },
      { fetchImpl, now: fixedNow }
    );
    assert.deepEqual(result.etas, [{ eta: 1783312320, headsign: "20th-Johnston", tracked: true, tripId: "787763" }]);
    assert.equal(result.hasTripError, false);
    assert.equal(result.stopName, "Market St & 4th St");
  });

  await t.test("short-circuits with detour:true when a detour is active", async () => {
    const fetchImpl = stubFetch([["detours/?route=17", detoursActive]]);
    const result = await pollRoute(
      { routeId: "17", stopId: 21289, direction: "Northbound" },
      { fetchImpl, now: () => new Date(2026, 0, 1) }
    );
    assert.deepEqual(result, {
      etas: [],
      detour: true,
      detourReason: null,
      stopName: null,
      direction: "Northbound",
      hasTripError: false,
      fetchedAt: new Date(2026, 0, 1).getTime(),
    });
  });

  await t.test("surfaces a trimmed detourReason when the active detour has one", async () => {
    const detoursLive = fixture("detours-route64-live-sample.json");
    const fetchImpl = stubFetch([["detours/?route=64", detoursLive]]);
    const result = await pollRoute(
      { routeId: "64", stopId: 15210, direction: "Westbound" },
      { fetchImpl, now: () => new Date(2026, 5, 1) }
    );
    assert.equal(result.detourReason, "Sinkhole");
  });

  await t.test("surfaces stopName from skipped_stops during an active detour", async () => {
    const detoursLive = fixture("detours-route64-live-sample.json");
    const fetchImpl = stubFetch([["detours/?route=64", detoursLive]]);
    const result = await pollRoute(
      { routeId: "64", stopId: 15210, direction: "Westbound" },
      { fetchImpl, now: () => new Date(2026, 5, 1) }
    );
    assert.equal(result.stopName, "Westminster Av & 46th St");
  });

  await t.test("each arrival keeps its own trip's headsign, not a shared route-level one", async () => {
    const twoGoodTrips = [
      trips[3], // trip_id 900002, headsign "Front-Market"
      {
        route_id: "17",
        trip_id: "900003",
        direction_name: "Northbound",
        status: "ON-TIME",
        next_stop_sequence: 2,
        trip_headsign: "Different-Destination",
      },
    ];
    const otherTripUpdate = {
      stop_times: [
        { stop_id: 21289, stop_name: "20th St & Oregon Av", stop_sequence: 2, eta: 1783312500, delay: 0, departed: false },
      ],
    };
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", twoGoodTrips],
      ["trip-update/?trip_id=900002", tripUpdate900002],
      ["trip-update/?trip_id=900003", otherTripUpdate],
    ]);
    const result = await pollRoute(
      { routeId: "17", stopId: 21289, direction: "Northbound" },
      { fetchImpl, now: fixedNow }
    );
    assert.deepEqual(result.etas, [
      { eta: 1783312200, headsign: "Front-Market", tracked: true, tripId: "900002" },
      { eta: 1783312500, headsign: "Different-Destination", tracked: true, tripId: "900003" },
    ]);
  });

  await t.test("isolates a single failed trip-update: partial etas + hasTripError", async () => {
    const twoGoodTrips = [
      ...trips,
      {
        route_id: "17",
        trip_id: "900003",
        direction_name: "Northbound",
        status: "ON-TIME",
        next_stop_sequence: 2,
      },
    ];
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", twoGoodTrips],
      ["trip-update/?trip_id=900002", tripUpdate900002],
      ["trip-update/?trip_id=900003", new Error("trip-update fetch failed")],
    ]);
    const result = await pollRoute(
      { routeId: "17", stopId: 21289, direction: "Northbound" },
      { fetchImpl, now: fixedNow }
    );
    assert.deepEqual(result.etas, [{ eta: 1783312200, headsign: "Front-Market", tracked: true, tripId: "900002" }]);
    assert.equal(result.hasTripError, true);
  });

  await t.test("all trip-update fetches failing: empty etas + hasTripError", async () => {
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", trips],
      ["trip-update/?trip_id=900002", new Error("boom")],
    ]);
    const result = await pollRoute(
      { routeId: "17", stopId: 21289, direction: "Northbound" },
      { fetchImpl, now: fixedNow }
    );
    assert.deepEqual(result.etas, []);
    assert.equal(result.hasTripError, true);
  });

  await t.test("fetchDetours failure propagates (throws)", async () => {
    const fetchImpl = stubFetch([["detours/?route=17", new Error("detours down")]]);
    await assert.rejects(
      () => pollRoute({ routeId: "17", stopId: 21289, direction: "Northbound" }, { fetchImpl, now: fixedNow }),
      /detours down/
    );
  });

  await t.test("real API detour shape (object skipped_stops) triggers detour:true", async () => {
    const detoursLive = fixture("detours-route64-live-sample.json");
    const fetchImpl = stubFetch([["detours/?route=64", detoursLive]]);
    const result = await pollRoute(
      { routeId: "64", stopId: 15210, direction: "Westbound" },
      { fetchImpl, now: () => new Date(2026, 5, 1) }
    );
    assert.equal(result.detour, true);
    assert.deepEqual(result.etas, []);
  });

  await t.test("fetchTrips failure propagates (throws)", async () => {
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", new Error("trips down")],
    ]);
    await assert.rejects(
      () => pollRoute({ routeId: "17", stopId: 21289, direction: "Northbound" }, { fetchImpl, now: fixedNow }),
      /trips down/
    );
  });
});
