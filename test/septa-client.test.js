"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  isDetourActive,
  findInferredDetourCandidates,
  findSkippedStopName,
  filterGoodTrips,
  isTripTracked,
  isNoGpsSource,
  isTripPastStop,
  filterStopTimes,
  findStopName,
  tripReachesStopAfter,
  computeIsFresh,
  alignedDelayMs,
  makeCachingFetch,
  pollRoute,
  mergeScheduledArrivals,
  resolveRouteLabelColor,
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

test("findInferredDetourCandidates", async (t) => {
  const now = new Date(2026, 8, 2, 12, 0, 0);
  // Shaped after the real route 17 southbound detour of 2026-09-02: five
  // geocoded turns, four days long, and no skipped_stops at all.
  const base = {
    route_id: "17",
    direction_id: "1",
    reason: "Road Construction",
    start: "9/1/2026, 18:52:20",
    end: "9/6/2026, 00:30:00",
    skipped_stops: {},
    coordinate_detail_from_message: {
      "rittenhouse and 18th st.": [39.9484, -75.17104, "Rittenhouse Sq & 18th St"],
      "18th st. and locust st.": [39.94899, -75.17092],
      "locust st. and broad st.": [39.94842, -75.16512],
      "broad st. and washington ave.": [39.93884, -75.16716],
      "washington ave. and 19th st,": [39.93975, -75.17325],
    },
  };

  await t.test("the real route 17 shape qualifies", () => {
    assert.deepEqual(findInferredDetourCandidates([base], now), [base]);
  });

  await t.test("a detour that lists its skipped stops is left to the confident path", () => {
    const reported = { ...base, skipped_stops: { 14959: ["19th St & South St", 39.9, -75.1] } };
    assert.deepEqual(findInferredDetourCandidates([reported], now), []);
    // ...including the flat-array shape skipped_stops sometimes takes.
    assert.deepEqual(findInferredDetourCandidates([{ ...base, skipped_stops: ["14959"] }], now), []);
  });

  await t.test("outside its date range -> not a candidate", () => {
    assert.deepEqual(findInferredDetourCandidates([base], new Date(2026, 8, 8, 12, 0, 0)), []);
    assert.deepEqual(findInferredDetourCandidates([base], new Date(2026, 7, 20, 12, 0, 0)), []);
  });

  await t.test("outside today's day_time window -> not a candidate", () => {
    const evening = { ...base, day_time_active_info: { Wed: "18:00:00-22:00:00" } };
    assert.deepEqual(findInferredDetourCandidates([evening], now), []);
    const allDay = { ...base, day_time_active_info: { Wed: "00:00:00-23:59:59" } };
    assert.deepEqual(findInferredDetourCandidates([allDay], now), [allDay]);
  });

  // Long-running detours are the new normal rather than news, and a
  // permanently-orange note would be noise. 18 of the 30 that would otherwise
  // alert on 2026-09-02 were longer than a month.
  await t.test("running longer than the cap -> not a candidate", () => {
    const forever = { ...base, start: "4/20/2026, 13:23:14", end: "1/1/2027, 00:00:00" };
    assert.deepEqual(findInferredDetourCandidates([forever], now), []);
  });

  await t.test("fewer than two usable coordinates -> not a candidate, it can't be localized", () => {
    const oneTurn = { ...base, coordinate_detail_from_message: { "a and b": [39.94, -75.17] } };
    assert.deepEqual(findInferredDetourCandidates([oneTurn], now), []);
    assert.deepEqual(findInferredDetourCandidates([{ ...base, coordinate_detail_from_message: {} }], now), []);
    assert.deepEqual(findInferredDetourCandidates([{ ...base, coordinate_detail_from_message: null }], now), []);
    const malformed = { ...base, coordinate_detail_from_message: { a: [null, null], b: ["x", "y"], c: [39.9, -75.1] } };
    assert.deepEqual(findInferredDetourCandidates([malformed], now), []);
  });

  await t.test("non-array input -> empty, never a throw", () => {
    assert.deepEqual(findInferredDetourCandidates(null, now), []);
    assert.deepEqual(findInferredDetourCandidates(undefined, now), []);
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

  await t.test("structuralDirectionId matches by direction_id, ignoring direction_name entirely", () => {
    // Same direction_id-0 trips filterGoodTrips(trips, "Northbound") finds by
    // name -- but reached here via structuralDirectionId, with a configured
    // direction string ("Eastbound") that wouldn't match any of them by name.
    const good = filterGoodTrips(trips, "Eastbound", true, "0");
    assert.deepEqual(good.map((trip) => trip.trip_id), ["787404", "900002"]);
  });

  await t.test("structuralDirectionId still excludes CANCELED trips", () => {
    const good = filterGoodTrips(trips, "Northbound", true, "0");
    assert.ok(!good.some((trip) => trip.trip_id === "900001"));
  });

  await t.test("structuralDirectionId matches even when direction_name is N/A on every trip", () => {
    const allNA = trips.map((trip) => ({ ...trip, direction_name: "N/A" }));
    const good = filterGoodTrips(allNA, "Northbound", true, "0");
    assert.deepEqual(good.map((trip) => trip.trip_id), ["787404", "900002"]);
  });

  await t.test("structuralDirectionId null falls back to matching direction_name (unchanged behavior)", () => {
    const good = filterGoodTrips(trips, "Northbound", true, null);
    assert.deepEqual(good.map((trip) => trip.trip_id), ["787404", "900002"]);
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

  // Real payload captured live 2026-07-14 ~00:08 EDT: SEPTA stamped the
  // last northbound trip of the night with etas a full 24h in the future
  // (transit_date already rolled over to the new calendar day, added to a
  // GTFS "24:xx" past-midnight arrival time meant for the *previous*
  // service day) even though the bus was really a few stops out. Confirmed
  // against the live vehicle position at capture time: it was two stops
  // before 21303, on schedule, so the true arrival was ~00:11:12 -- not
  // 2026-07-15.
  await t.test("corrects a midnight day-rollover eta back to the true arrival time", () => {
    const stopTimes = fixture("trip-update-787319-midnight-bug.json").stop_times;
    const now = 1784002120; // 2026-07-14 00:08:40 EDT, the real capture time
    const result = filterStopTimes(stopTimes, 21303, now);
    assert.deepEqual(result.map((s) => s.eta), [1784002272]); // 2026-07-14 00:11:12 EDT
  });

  await t.test("leaves a genuinely near eta untouched", () => {
    const stopTimes = fixture("trip-update-900002.json").stop_times;
    const result = filterStopTimes(stopTimes, 21289, now);
    assert.deepEqual(result[0].eta, 1783312200);
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

test("tripReachesStopAfter", async (t) => {
  // Fixture trip: stop 21289 at sequence 2, stop 21290 at sequence 3.
  const stopTimes = fixture("trip-update-900002.json").stop_times;

  await t.test("a stop later in the trip -> true", () => {
    assert.equal(tripReachesStopAfter(stopTimes, 21290, 2), true);
  });

  await t.test("matches string stop_id (numeric coercion)", () => {
    assert.equal(tripReachesStopAfter(stopTimes, "21290", 2), true);
  });

  await t.test("a stop the bus already passed -> false, even though the trip does serve it", () => {
    assert.equal(tripReachesStopAfter(stopTimes, 21289, 2), false);
  });

  await t.test("stop not in this trip's sequence at all -> false (ground truth: confirmed skip)", () => {
    assert.equal(tripReachesStopAfter(stopTimes, 99999, 1), false);
  });

  await t.test("non-array input (stop_times unavailable) -> null (unknown, not a confirmed skip)", () => {
    assert.equal(tripReachesStopAfter(null, 21289, 1), null);
    assert.equal(tripReachesStopAfter(undefined, 21289, 1), null);
  });

  await t.test("no usable sequence to compare against -> counts any visit (permissive)", () => {
    assert.equal(tripReachesStopAfter(stopTimes, 21289, undefined), true);
    assert.equal(tripReachesStopAfter(stopTimes, 21289, "N/A"), true);
  });

  // The case Josh raised: LUCYGR's Green Loop opens at stop 28325 (sequence
  // 1) and normally closes there again (sequence 21). Boarding mid-route,
  // only the closing visit is reachable -- so when a detour removes it, the
  // opening visit must not be mistaken for the secondary stop being served.
  await t.test("looping route: only the visit after boarding counts", () => {
    const looping = [
      { stop_id: 28325, stop_sequence: 1 },
      { stop_id: 21441, stop_sequence: 18 },
      { stop_id: 28325, stop_sequence: 21 },
    ];
    assert.equal(tripReachesStopAfter(looping, 28325, 18), true);

    const detoured = looping.filter((stopTime) => stopTime.stop_sequence !== 21);
    assert.equal(tripReachesStopAfter(detoured, 28325, 18), false);
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

test("isTripPastStop", async (t) => {
  const running = (nextStopSequence) => ({
    next_stop_sequence: nextStopSequence,
    status: "ON-TIME",
    vehicle_id: "7478",
  });

  await t.test("bus past our stop -> skip its trip-update", () => {
    assert.equal(isTripPastStop(running(42), 16), true);
  });

  await t.test("bus approaching our stop -> keep", () => {
    assert.equal(isTripPastStop(running(11), 17), false);
  });

  await t.test("bus at our stop right now -> keep (it hasn't served it yet)", () => {
    assert.equal(isTripPastStop(running(17), 17), false);
  });

  await t.test("trip not yet started (next_stop_sequence 1) -> keep", () => {
    assert.equal(isTripPastStop(running(1), 16), false);
  });

  // Every uncertain case must fail open: an extra fetch costs one request, a
  // wrong skip silently drops a real arrival off the display.
  await t.test("unknown stop sequence (cache cold or trip unknown) -> keep", () => {
    assert.equal(isTripPastStop(running(42), null), false);
    assert.equal(isTripPastStop(running(42), undefined), false);
  });

  await t.test('"NO GPS" trip -> keep, its next_stop_sequence is a sentinel', () => {
    assert.equal(isTripPastStop({ ...running(998), status: "NO GPS" }, 16), false);
  });

  await t.test("no vehicle assigned yet -> keep", () => {
    assert.equal(isTripPastStop({ ...running(998), vehicle_id: "None" }, 16), false);
  });

  await t.test("non-numeric next_stop_sequence -> keep", () => {
    assert.equal(isTripPastStop(running(null), 16), false);
    assert.equal(isTripPastStop(running("N/A"), 16), false);
    assert.equal(isTripPastStop({ status: "ON-TIME", vehicle_id: "7478" }, 16), false);
  });

  await t.test("missing trip entry -> keep", () => {
    assert.equal(isTripPastStop(null, 16), false);
  });

  // Real shapes from the 2026-09-02 feed. Callers pass the LAST sequence at
  // which the trip serves the stop; these assert that doing so is what keeps
  // a returning bus on screen.
  await t.test("route 95 Metroplex spur: stop 5909 at sequences 38 and 40", () => {
    // Bus at sequence 39 (inside the shopping-center spur) is about to serve
    // 5909 again 2 minutes later -- must not be written off.
    assert.equal(isTripPastStop(running(39), 40), false);
    assert.equal(isTripPastStop(running(41), 40), true); // genuinely past both
    // Using the first occurrence instead would have skipped it:
    assert.equal(isTripPastStop(running(39), 38), true);
  });

  await t.test("LUCYGR Green Loop: stop 28325 opens at sequence 1, closes at 21", () => {
    // Mid-lap, still 30-odd minutes from coming back to 30th St.
    assert.equal(isTripPastStop(running(10), 21), false);
    assert.equal(isTripPastStop(running(10), 1), true); // first-occurrence bug
  });
});

test("makeCachingFetch", async (t) => {
  // Minimal Response stand-in: json() is single-use on a real Response, so
  // these deliberately throw on a second read to catch any body sharing.
  function response(body, { ok = true, status = 200, statusText = "OK" } = {}) {
    let read = false;
    return {
      ok,
      status,
      statusText,
      json: async () => {
        if (read) throw new Error("body already consumed");
        read = true;
        return body;
      },
    };
  }

  await t.test("identical URLs inside the window share one real request", async () => {
    let calls = 0;
    const fetchImpl = async (url) => {
      calls++;
      return response({ url, n: calls });
    };
    const cachingFetch = makeCachingFetch(10_000, fetchImpl, () => 1000);

    const a = await (await cachingFetch("/trips/?route_id=17")).json();
    const b = await (await cachingFetch("/trips/?route_id=17")).json();
    assert.equal(calls, 1);
    assert.deepEqual(a, b);
  });

  await t.test("each caller gets its own readable body", async () => {
    const cachingFetch = makeCachingFetch(10_000, async () => response({ ok: 1 }), () => 1000);
    const first = await cachingFetch("/detours/?route=17");
    const second = await cachingFetch("/detours/?route=17");
    assert.deepEqual(await first.json(), { ok: 1 });
    assert.deepEqual(await second.json(), { ok: 1 }); // would throw if shared
  });

  await t.test("concurrent callers share a single in-flight request", async () => {
    let calls = 0;
    const cachingFetch = makeCachingFetch(10_000, async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return response({ n: calls });
    }, () => 1000);

    const [a, b] = await Promise.all([cachingFetch("/trips/?route_id=63"), cachingFetch("/trips/?route_id=63")]);
    assert.equal(calls, 1);
    assert.deepEqual(await a.json(), await b.json());
  });

  await t.test("different URLs are not shared", async () => {
    let calls = 0;
    const cachingFetch = makeCachingFetch(10_000, async () => response({ n: ++calls }), () => 1000);
    await cachingFetch("/trips/?route_id=17");
    await cachingFetch("/trips/?route_id=63");
    assert.equal(calls, 2);
  });

  await t.test("past the TTL the URL is fetched again", async () => {
    let calls = 0;
    let clock = 1000;
    const cachingFetch = makeCachingFetch(10_000, async () => response({ n: ++calls }), () => clock);
    await cachingFetch("/trips/?route_id=17");
    clock += 10_001;
    await cachingFetch("/trips/?route_id=17");
    assert.equal(calls, 2);
  });

  await t.test("a rejected fetch is not cached, and still rejects", async () => {
    let calls = 0;
    const cachingFetch = makeCachingFetch(10_000, async () => {
      calls++;
      throw new Error("network down");
    }, () => 1000);

    await assert.rejects(() => cachingFetch("/trips/?route_id=17"), /network down/);
    await assert.rejects(() => cachingFetch("/trips/?route_id=17"), /network down/);
    assert.equal(calls, 2); // retried, not replayed from cache
  });

  await t.test("a non-ok response is not cached, and keeps its status", async () => {
    let calls = 0;
    const cachingFetch = makeCachingFetch(10_000, async () => {
      calls++;
      return response(null, { ok: false, status: 503, statusText: "Service Unavailable" });
    }, () => 1000);

    const first = await cachingFetch("/routes/");
    assert.equal(first.ok, false);
    assert.equal(first.status, 503);
    assert.equal(first.statusText, "Service Unavailable");
    await cachingFetch("/routes/");
    assert.equal(calls, 2);
  });

  await t.test("expired entries are evicted rather than accumulating", async () => {
    let clock = 0;
    const cachingFetch = makeCachingFetch(1000, async () => response({}), () => clock);
    for (let i = 0; i < 50; i++) {
      clock += 2000; // every entry is stale by the next call
      await cachingFetch(`/trip-update/?trip_id=${i}`);
    }
    // One more call at a fresh clock must still be a miss, proving nothing
    // stale was retained and served.
    let calls = 0;
    const counting = makeCachingFetch(1000, async () => {
      calls++;
      return response({});
    }, () => clock);
    await counting("/trip-update/?trip_id=0");
    assert.equal(calls, 1);
  });
});

test("alignedDelayMs", async (t) => {
  const INTERVAL = 120;
  const INTERVAL_MS = INTERVAL * 1000;

  await t.test("a cycle finishing 1s past a grid point waits out the rest of the interval", () => {
    assert.equal(alignedDelayMs(INTERVAL_MS + 1000, INTERVAL), 119_000);
  });

  await t.test("finishing exactly on a grid point waits a full interval, never 0", () => {
    assert.equal(alignedDelayMs(0, INTERVAL), INTERVAL_MS);
    assert.equal(alignedDelayMs(INTERVAL_MS, INTERVAL), INTERVAL_MS);
    assert.equal(alignedDelayMs(INTERVAL_MS * 7, INTERVAL), INTERVAL_MS);
  });

  // The property Josh asked about: aligning must never stretch the effective
  // refresh rate. Whatever a cycle costs, the *next* start lands exactly one
  // interval after the previous start -- unlike the old
  // "interval after this one finished" scheme, which spaced them at
  // interval + duration.
  await t.test("steady-state spacing is exactly one interval, whatever the cycle duration", () => {
    for (const durationMs of [0, 1, 1000, 4500, 60_000, 119_999]) {
      const startedAt = INTERVAL_MS * 10;
      const finishedAt = startedAt + durationMs;
      const nextStart = finishedAt + alignedDelayMs(finishedAt, INTERVAL);
      assert.equal(nextStart - startedAt, INTERVAL_MS, `duration ${durationMs}ms`);
    }
  });

  await t.test("a cycle overrunning its interval aligns to the next grid point, still no worse than unaligned", () => {
    const startedAt = INTERVAL_MS * 10;
    const finishedAt = startedAt + 130_000; // overran a 120s interval
    const nextStart = finishedAt + alignedDelayMs(finishedAt, INTERVAL);
    assert.equal(nextStart - startedAt, INTERVAL_MS * 2); // 240s, vs 250s unaligned
  });

  await t.test("result always lands in (0, intervalMs]", () => {
    for (let nowMs = 0; nowMs < INTERVAL_MS * 2; nowMs += 997) {
      const delay = alignedDelayMs(nowMs, INTERVAL);
      assert.ok(delay > 0 && delay <= INTERVAL_MS, `nowMs ${nowMs} -> ${delay}`);
    }
  });

  await t.test("offset shifts this route's grid off the shared one", () => {
    assert.equal(alignedDelayMs(0, INTERVAL, 5000), 5000);
    assert.equal(alignedDelayMs(5000, INTERVAL, 5000), INTERVAL_MS);
    assert.equal(alignedDelayMs(6000, INTERVAL, 5000), INTERVAL_MS - 1000);
  });

  await t.test("two routes with different offsets stay that far apart on every tick", () => {
    const a = 1000;
    const b = 4000;
    for (let nowMs = 0; nowMs < INTERVAL_MS * 2; nowMs += 1013) {
      const nextA = nowMs + alignedDelayMs(nowMs, INTERVAL, a);
      const nextB = nowMs + alignedDelayMs(nowMs, INTERVAL, b);
      assert.notEqual(nextA, nextB, `nowMs ${nowMs}`);
    }
  });

  await t.test("offsets at or beyond one interval normalize instead of overshooting", () => {
    assert.equal(alignedDelayMs(0, INTERVAL, INTERVAL_MS), INTERVAL_MS);
    assert.equal(alignedDelayMs(0, INTERVAL, INTERVAL_MS + 5000), 5000);
    assert.equal(alignedDelayMs(0, INTERVAL, -5000), INTERVAL_MS - 5000);
  });

  await t.test("a nonsense interval passes straight through, preserving old setTimeout behavior", () => {
    assert.equal(alignedDelayMs(1000, 0), 0);
    assert.equal(alignedDelayMs(1000, -5), -5000);
    assert.ok(Number.isNaN(alignedDelayMs(1000, NaN)));
  });
});

test("resolveRouteLabelColor", async (t) => {
  await t.test("route_type 1 (subway/metro) with a real route_color -> that color, lowercased, hash-prefixed", () => {
    assert.equal(
      resolveRouteLabelColor({ route_type: 1, route_color: "0097D6", is_frequent_bus: false }),
      "#0097d6"
    );
  });

  await t.test("route_type 0 (trolley) with a real route_color -> that color", () => {
    assert.equal(
      resolveRouteLabelColor({ route_type: 0, route_color: "5A960A", is_frequent_bus: false }),
      "#5a960a"
    );
  });

  await t.test("route_type 3 (bus), is_frequent_bus true -> the frequent-bus red, not route_color", () => {
    assert.equal(
      resolveRouteLabelColor({ route_type: 3, route_color: "000000", is_frequent_bus: true }),
      "#e63946"
    );
  });

  await t.test("route_type 3 (bus), is_frequent_bus false -> null (use default label color)", () => {
    assert.equal(resolveRouteLabelColor({ route_type: 3, route_color: "FFFFFF", is_frequent_bus: false }), null);
  });

  await t.test("rail/trolley route_type takes priority over is_frequent_bus", () => {
    assert.equal(
      resolveRouteLabelColor({ route_type: 1, route_color: "0097D6", is_frequent_bus: true }),
      "#0097d6"
    );
  });

  await t.test("rail/trolley route_type but malformed route_color -> falls through to is_frequent_bus check", () => {
    assert.equal(
      resolveRouteLabelColor({ route_type: 1, route_color: "not-a-color", is_frequent_bus: true }),
      "#e63946"
    );
  });

  await t.test("no routeMeta at all (route missing from /routes/ response) -> null", () => {
    assert.equal(resolveRouteLabelColor(null), null);
    assert.equal(resolveRouteLabelColor(undefined), null);
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

  await t.test("skips the trip-update for a bus already past the stop, and never requests it", async () => {
    const requested = [];
    const base = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", trips],
      ["trip-update/?trip_id=787404", tripUpdate787404],
      ["trip-update/?trip_id=900002", tripUpdate900002],
    ]);
    const fetchImpl = (url, options) => {
      requested.push(url);
      return base(url, options);
    };

    // Northbound good trips here are 787404 (next_stop_sequence 1) and 900002
    // (next_stop_sequence 2). Put our stop at sequence 1 on 900002 -- so that
    // bus has already served it -- and at 16 on 787404, which hasn't.
    const result = await pollRoute(
      { routeId: "17", stopId: 21289, direction: "Northbound" },
      {
        fetchImpl,
        now: fixedNow,
        stopSequenceForTrip: (tripId) => (String(tripId) === "900002" ? 1 : 16),
      }
    );

    assert.ok(!requested.some((url) => url.includes("trip_id=900002")), "must not fetch the passed trip");
    assert.ok(requested.some((url) => url.includes("trip_id=787404")), "must still fetch the approaching trip");
    assert.deepEqual(result.etas, [
      { eta: 1783312560, headsign: "Front-Market", tracked: false, tripId: "787404" },
    ]);
    // A skip is not an error -- it must not light the display's "!" indicator.
    assert.equal(result.hasTripError, false);
  });

  await t.test("without a stopSequenceForTrip lookup, every good trip is still fetched", async () => {
    const requested = [];
    const base = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", trips],
      ["trip-update/?trip_id=787404", tripUpdate787404],
      ["trip-update/?trip_id=900002", tripUpdate900002],
    ]);
    const fetchImpl = (url, options) => {
      requested.push(url);
      return base(url, options);
    };
    const result = await pollRoute(
      { routeId: "17", stopId: 21289, direction: "Northbound" },
      { fetchImpl, now: fixedNow }
    );
    assert.equal(requested.filter((url) => url.includes("trip-update")).length, 2);
    assert.equal(result.etas.length, 2);
  });

  await t.test("a cold schedule cache (lookup returns null) skips nothing", async () => {
    const requested = [];
    const base = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", trips],
      ["trip-update/?trip_id=787404", tripUpdate787404],
      ["trip-update/?trip_id=900002", tripUpdate900002],
    ]);
    const fetchImpl = (url, options) => {
      requested.push(url);
      return base(url, options);
    };
    await pollRoute(
      { routeId: "17", stopId: 21289, direction: "Northbound" },
      { fetchImpl, now: fixedNow, stopSequenceForTrip: () => null }
    );
    assert.equal(requested.filter((url) => url.includes("trip-update")).length, 2);
  });

  // A trip that serves the configured stop twice (route 107 hits Marshall Rd
  // & Sloan St at sequence 22, loops via Dennison/Shadeland, and returns at
  // sequence 33). Both visits are real, boardable arrivals.
  const loopingTrips = [
    {
      trip_id: "957206",
      direction_id: 0,
      direction_name: "Westbound",
      status: "ON-TIME",
      vehicle_id: "3255",
      next_stop_sequence: 20,
      trip_headsign: "Lawrence Park",
    },
  ];
  const loopingUpdate = {
    trip: { "real-time": true },
    stop_times: [
      { stop_id: 22187, stop_name: "Marshall Rd & Long Ln", stop_sequence: 10, eta: 1783312000, departed: false, delay: 0 },
      { stop_id: 19116, stop_name: "Marshall Rd & Sloan St", stop_sequence: 22, eta: 1783312400, departed: false, delay: 0 },
      { stop_id: 19116, stop_name: "Marshall Rd & Sloan St", stop_sequence: 33, eta: 1783312800, departed: false, delay: 0 },
      { stop_id: 19127, stop_name: "Garrett Rd & Burmont Rd", stop_sequence: 34, eta: 1783313000, departed: false, delay: 0 },
    ],
  };
  const loopingFetch = () =>
    stubFetch([
      ["detours/?route=107", []],
      ["trips/?route_id=107", loopingTrips],
      ["trip-update/?trip_id=957206", loopingUpdate],
    ]);

  await t.test("a trip serving the stop twice yields two arrivals, both tagged with the same trip", async () => {
    const result = await pollRoute(
      { routeId: "107", stopId: 19116, direction: "Westbound" },
      { fetchImpl: loopingFetch(), now: fixedNow, structuralDirectionId: "0" }
    );
    assert.equal(result.etas.length, 2);
    assert.deepEqual(result.etas.map((e) => e.eta), [1783312400, 1783312800]);
    // The display slash-joins arrivals sharing a trip, so this equality is
    // what makes "8m/15m" render instead of "8m, 15m".
    assert.equal(result.etas[0].tripId, result.etas[1].tripId);
  });

  // Josh's LUCYGR case: a secondary stop the bus already passed is no use to
  // someone boarding at the primary stop, even though the trip does serve it.
  await t.test("a secondary stop already passed does not count as reached", async () => {
    const result = await pollRoute(
      { routeId: "107", stopId: 19116, direction: "Westbound", secondaryStopId: 22187 },
      { fetchImpl: loopingFetch(), now: fixedNow, structuralDirectionId: "0" }
    );
    assert.deepEqual(result.etas.map((e) => e.reachesSecondaryStop), [false, false]);
  });

  await t.test("a secondary stop still ahead counts as reached", async () => {
    const result = await pollRoute(
      { routeId: "107", stopId: 19116, direction: "Westbound", secondaryStopId: 19127 },
      { fetchImpl: loopingFetch(), now: fixedNow, structuralDirectionId: "0" }
    );
    assert.deepEqual(result.etas.map((e) => e.reachesSecondaryStop), [true, true]);
  });

  // Per-arrival, not per-trip: a secondary stop between the two visits is
  // ahead of the first boarding and behind the second.
  await t.test("reachesSecondaryStop is decided per arrival, not once per trip", async () => {
    const update = {
      trip: { "real-time": true },
      stop_times: [
        ...loopingUpdate.stop_times,
        { stop_id: 29767, stop_name: "Shadeland Av & Bryn Mawr Av", stop_sequence: 29, eta: 1783312600, departed: false, delay: 0 },
      ],
    };
    const result = await pollRoute(
      { routeId: "107", stopId: 19116, direction: "Westbound", secondaryStopId: 29767 },
      {
        fetchImpl: stubFetch([
          ["detours/?route=107", []],
          ["trips/?route_id=107", loopingTrips],
          ["trip-update/?trip_id=957206", update],
        ]),
        now: fixedNow,
        structuralDirectionId: "0",
      }
    );
    assert.deepEqual(result.etas.map((e) => e.reachesSecondaryStop), [true, false]);
  });

  // End-to-end replay of the real live payloads captured 2026-07-14 ~00:08
  // EDT (route 17, stop 21303, Wharton St). Before the midnight-eta fix,
  // this trip's eta came back tagged 24h in the future ("2026-07-15"), so
  // MMM.js fell past countdownWithinMinutes and rendered a plain clock time
  // instead of a "3m" countdown -- a bus that was really a few minutes away
  // displayed as an untroubled, far-off arrival. See filterStopTimes's
  // "corrects a midnight day-rollover eta" test for the underlying fixture.
  await t.test("corrects a midnight day-rollover eta to a real near-term arrival", async () => {
    const midnightTrips = fixture("trips-route17-midnight-bug.json");
    const midnightTripUpdate = fixture("trip-update-787319-midnight-bug.json");
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", midnightTrips],
      ["trip-update/?trip_id=787319", midnightTripUpdate],
    ]);
    const midnightNow = () => new Date(1784002120 * 1000); // 2026-07-14 00:08:40 EDT
    const result = await pollRoute(
      { routeId: "17", stopId: 21303, direction: "Northbound" },
      { fetchImpl, now: midnightNow, useScheduleSupplement: false }
    );
    assert.deepEqual(result.etas, [
      { eta: 1784002272, headsign: "Front-Market", tracked: true, tripId: "787319" },
    ]);
    const minutesAway = (result.etas[0].eta - 1784002120) / 60;
    assert.ok(minutesAway > 2 && minutesAway < 3, `expected ~2.5 min, got ${minutesAway}`); // not ~1442
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

  await t.test("no secondaryStopId configured: secondaryStopDetour/secondaryStopName default false/null", async () => {
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", trips],
      ["trip-update/?trip_id=787404", tripUpdate787404],
      ["trip-update/?trip_id=900002", tripUpdate900002],
    ]);
    const result = await pollRoute({ routeId: "17", stopId: 21289, direction: "Northbound" }, { fetchImpl, now: fixedNow });
    assert.equal(result.secondaryStopDetour, false);
    assert.equal(result.secondaryStopName, null);
  });

  await t.test("secondaryStopId skipped by a (different, concurrent) active detour: flagged + named from skipped_stops", async () => {
    // Reuses route 2's live detour fixture purely for its D12564 entry
    // (skips stop 8704, active 07:00-15:00 daily, 07/06-07/14/2026) --
    // pollRoute never checks a detour's own route_id field against
    // routeConfig.routeId, so it's a valid stand-in here.
    const detoursLive = fixture("detours-route2-live-sample.json");
    const oneTrip = [
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
    const trackedUpdate = {
      trip: { status: "ON-TIME", "real-time": true },
      stop_times: [{ stop_id: 21289, eta: 1783312900, delay: 0, departed: false }],
    };
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursLive],
      ["trips/?route_id=17", oneTrip],
      ["trip-update/?trip_id=tracked-1", trackedUpdate],
    ]);
    const result = await pollRoute(
      { routeId: "17", stopId: 21289, direction: "Northbound", secondaryStopId: 8704 },
      { fetchImpl, now: () => new Date(2026, 6, 10, 10, 0, 0) }
    );
    assert.equal(result.detour, false); // primary stop itself isn't skipped -- trips still shown
    assert.equal(result.secondaryStopDetour, true);
    assert.equal(result.secondaryStopName, "Huntingdon St & 17th St");
  });

  await t.test("secondaryStopId not under any active detour: false, name resolved from a trip's own stop_times", async () => {
    const oneTrip = [
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
    const trackedUpdate = {
      trip: { status: "ON-TIME", "real-time": true },
      stop_times: [
        { stop_id: 21289, eta: 1783312900, delay: 0, departed: false },
        { stop_id: 8704, stop_name: "Huntingdon St & 17th St", eta: 1783313200, delay: 0, departed: false },
      ],
    };
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", oneTrip],
      ["trip-update/?trip_id=tracked-1", trackedUpdate],
    ]);
    const result = await pollRoute(
      { routeId: "17", stopId: 21289, direction: "Northbound", secondaryStopId: 8704 },
      { fetchImpl, now: fixedNow }
    );
    assert.equal(result.secondaryStopDetour, false);
    assert.equal(result.secondaryStopName, "Huntingdon St & 17th St");
  });

  await t.test("reachesSecondaryStop is per-trip, not per-headsign -- distinguishes two same-headsign patterns", async () => {
    // Reproduces route 17's real "Broad-Pattison" ambiguity: one trip_id
    // reaches the configured secondary stop, another with the identical
    // headsign doesn't (a short-turn sharing a headsign with a longer
    // pattern) -- ground truth must come from each trip's own stop_times,
    // not a route/headsign-level classification.
    const twoTrips = [
      {
        route_id: "17",
        trip_id: "reaches-1",
        direction_name: "Southbound",
        status: "ON-TIME",
        vehicle_id: "1234",
        next_stop_sequence: 10,
        trip_headsign: "Broad-Pattison",
      },
      {
        route_id: "17",
        trip_id: "short-turn-1",
        direction_name: "Southbound",
        status: "ON-TIME",
        vehicle_id: "5678",
        next_stop_sequence: 10,
        trip_headsign: "Broad-Pattison",
      },
    ];
    const reachesUpdate = {
      trip: { status: "ON-TIME", "real-time": true },
      stop_times: [
        { stop_id: 21289, eta: 1783312900, delay: 0, departed: false },
        { stop_id: 21271, eta: 1783313200, delay: 0, departed: false }, // Broad St & Kitty Hawk Av
      ],
    };
    const shortTurnUpdate = {
      trip: { status: "ON-TIME", "real-time": true },
      stop_times: [{ stop_id: 21289, eta: 1783312950, delay: 0, departed: false }], // never reaches 21271
    };
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", twoTrips],
      ["trip-update/?trip_id=reaches-1", reachesUpdate],
      ["trip-update/?trip_id=short-turn-1", shortTurnUpdate],
    ]);
    const result = await pollRoute(
      { routeId: "17", stopId: 21289, direction: "Southbound", secondaryStopId: 21271 },
      { fetchImpl, now: fixedNow }
    );
    const byTripId = Object.fromEntries(result.etas.map((a) => [a.tripId, a.reachesSecondaryStop]));
    assert.equal(byTripId["reaches-1"], true);
    assert.equal(byTripId["short-turn-1"], false);
  });

  await t.test("no secondaryStopId configured: etas carry no reachesSecondaryStop field at all", async () => {
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", trips],
      ["trip-update/?trip_id=787404", tripUpdate787404],
      ["trip-update/?trip_id=900002", tripUpdate900002],
    ]);
    const result = await pollRoute({ routeId: "17", stopId: 21289, direction: "Northbound" }, { fetchImpl, now: fixedNow });
    assert.ok(result.etas.every((a) => !("reachesSecondaryStop" in a)));
  });

  await t.test("directionId is resolved from any trip matching the configured direction", async () => {
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", trips],
      ["trip-update/?trip_id=787404", tripUpdate787404],
      ["trip-update/?trip_id=900002", tripUpdate900002],
    ]);
    const result = await pollRoute({ routeId: "17", stopId: 21289, direction: "Northbound" }, { fetchImpl, now: fixedNow });
    assert.equal(result.directionId, "0");
  });

  await t.test("directionId is resolved for Southbound independently of Northbound", async () => {
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", trips],
      ["trip-update/?trip_id=787763", tripUpdate787763],
    ]);
    const result = await pollRoute({ routeId: "17", stopId: 10311, direction: "Southbound" }, { fetchImpl, now: fixedNow });
    assert.equal(result.directionId, "1");
  });

  await t.test("directionId is null when no trip matches the configured direction", async () => {
    const noMatchTrips = trips.filter((t) => t.direction_name !== "Northbound");
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", noMatchTrips],
      ["trip-update/?trip_id=787763", tripUpdate787763],
    ]);
    const result = await pollRoute({ routeId: "17", stopId: 21289, direction: "Northbound" }, { fetchImpl, now: fixedNow });
    assert.equal(result.directionId, null);
  });

  await t.test("structuralDirectionId resolves arrivals even when every trip's direction_name is N/A", async () => {
    // Route 63's real-world behavior: direction_name is "N/A" on every
    // live-tracked trip, so name-based matching alone would find nothing.
    const allNA = trips.map((trip) => ({ ...trip, direction_name: "N/A" }));
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", allNA],
      ["trip-update/?trip_id=787404", tripUpdate787404],
      ["trip-update/?trip_id=900002", tripUpdate900002],
    ]);
    const result = await pollRoute(
      { routeId: "17", stopId: 21289, direction: "Northbound" },
      { fetchImpl, now: fixedNow, structuralDirectionId: "0" }
    );
    assert.equal(result.directionId, "0");
    assert.ok(result.etas.length > 0);
  });

  await t.test("structuralDirectionId still shows arrivals when a live name conflicts with the configured direction", async () => {
    // Simulates a route-135-style reversal (or a stale config): a live trip
    // confirms direction_id 0 is actually called "Southbound", not the
    // configured "Northbound". The configured stop_id wins; a warning is
    // logged (not asserted here), arrivals are still shown.
    const reversed = trips.map((trip) =>
      trip.direction_id === 0 ? { ...trip, direction_name: "Southbound" } : trip
    );
    const fetchImpl = stubFetch([
      ["detours/?route=17", detoursEmpty],
      ["trips/?route_id=17", reversed],
      ["trip-update/?trip_id=787404", tripUpdate787404],
      ["trip-update/?trip_id=900002", tripUpdate900002],
    ]);
    const result = await pollRoute(
      { routeId: "17", stopId: 21289, direction: "Northbound" },
      { fetchImpl, now: fixedNow, structuralDirectionId: "0" }
    );
    assert.equal(result.directionId, "0");
    assert.ok(result.etas.length > 0);
  });
});
