#!/usr/bin/env node
"use strict";

// Helper for figuring out which stop_id/direction_name to put in your
// config.js, without needing a separate "stops" API (SEPTA doesn't
// document one we could verify). Reuses the same two endpoints the module
// polls at runtime: fetch a trip per direction on the route, then read that
// trip's full stop list out of trip-update (its stop_times array includes
// stop_name for every stop along the route, not just one).
//
// Usage: node scripts/find-stop.js <routeId>
// Example: node scripts/find-stop.js 17

const { fetchTrips, fetchTripUpdate } = require("../septa-client.js");

function groupByDirection(trips) {
  const groups = new Map();
  for (const trip of trips) {
    if (!trip || !trip.direction_name) continue;
    if (!groups.has(trip.direction_name)) groups.set(trip.direction_name, []);
    groups.get(trip.direction_name).push(trip);
  }
  return groups;
}

// Prefer a trip that's still near the start of its run (low
// next_stop_sequence) so the printed stop list covers as much of the route
// as possible; prefer non-canceled trips; otherwise just take whatever's
// available.
function pickRepresentativeTrip(trips) {
  const candidates = [...trips].sort((a, b) => {
    const aCanceled = a.status === "CANCELED" ? 1 : 0;
    const bCanceled = b.status === "CANCELED" ? 1 : 0;
    if (aCanceled !== bCanceled) return aCanceled - bCanceled;
    return Number(a.next_stop_sequence || 0) - Number(b.next_stop_sequence || 0);
  });
  return candidates[0];
}

function printStopTable(direction, trip, stopTimes) {
  console.log(`\nRoute ${trip.route_id} — ${direction} (trip ${trip.trip_id})`);
  const sorted = [...stopTimes].sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
  const seqWidth = Math.max(3, ...sorted.map((s) => String(s.stop_sequence).length));
  const idWidth = Math.max(7, ...sorted.map((s) => String(s.stop_id).length));
  console.log(`  ${"seq".padEnd(seqWidth)}  ${"stop_id".padEnd(idWidth)}  stop_name`);
  for (const stopTime of sorted) {
    console.log(
      `  ${String(stopTime.stop_sequence).padEnd(seqWidth)}  ${String(stopTime.stop_id).padEnd(idWidth)}  ${stopTime.stop_name || ""}`
    );
  }
  const firstSeq = Number(sorted[0] && sorted[0].stop_sequence);
  if (Number.isFinite(firstSeq) && firstSeq > 1) {
    console.log(
      `  Note: this sample trip has already passed its first ${firstSeq - 1} stop(s); ` +
        `if your stop isn't listed, re-run in a few minutes to catch an earlier trip.`
    );
  }
}

async function main() {
  const routeId = process.argv[2];
  if (!routeId) {
    console.error("Usage: node scripts/find-stop.js <routeId>");
    console.error("Example: node scripts/find-stop.js 17");
    process.exit(1);
  }

  let trips;
  try {
    trips = await fetchTrips(routeId);
  } catch (err) {
    console.error(`Failed to fetch trips for route ${routeId}: ${err.message}`);
    process.exit(1);
  }

  if (!Array.isArray(trips) || trips.length === 0) {
    console.error(
      `No trips currently running for route ${routeId}. SEPTA only reports trips that are ` +
        `actively scheduled/in service right now — try again during route ${routeId}'s service hours.`
    );
    process.exit(1);
  }

  const groups = groupByDirection(trips);
  if (groups.size === 0) {
    console.error(`Got trips for route ${routeId}, but none had a usable direction_name. Raw response:`);
    console.error(JSON.stringify(trips, null, 2));
    process.exit(1);
  }

  for (const [direction, directionTrips] of groups) {
    const trip = pickRepresentativeTrip(directionTrips);
    try {
      const tripUpdate = await fetchTripUpdate(trip.trip_id);
      printStopTable(direction, trip, tripUpdate.stop_times || []);
    } catch (err) {
      console.error(`\nRoute ${routeId} — ${direction}: failed to fetch trip-update for trip ${trip.trip_id}: ${err.message}`);
    }
  }

  console.log(
    "\nCopy the stop_id and the direction name exactly as shown above (e.g. \"Northbound\") " +
      "into your config.js route entry."
  );
}

main();
