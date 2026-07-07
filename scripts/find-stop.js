#!/usr/bin/env node
"use strict";

// Helper for figuring out which stop_id/direction_name to put in your
// config.js, without needing a separate "stops" API (SEPTA doesn't
// document one we could verify).
//
// Lists every stop, for every scheduled stop pattern (headsign) on the
// route, straight from SEPTA's static GTFS schedule -- including
// short-turn/express patterns that have no currently-running trip, which a
// purely live-data approach can miss entirely (you'd have to happen to run
// this while one of those trips was in service). Live /trips/ data is still
// fetched, but only to resolve each pattern's friendly direction_name string
// (e.g. "Northbound") and to note which patterns are currently running.
//
// Usage: node scripts/find-stop.js <routeId> [--full]
// Example: node scripts/find-stop.js 17
// Example: node scripts/find-stop.js 17 --full
//
// --full prints, per stop, the stop name followed by a ready-to-paste
// routes[] entry for config.js instead of the seq/stop_id/stop_name table.

const { fetchTrips } = require("../septa-client.js");
const { fetchRouteStopPatterns } = require("../gtfs-schedule.js");

// One representative trip per distinct headsign -- trips sharing a headsign
// should share a stop pattern, so picking the one with the most stops (the
// least likely to be an anomalous/truncated instance) is a reasonable
// stand-in for "the" pattern of that headsign.
function pickRepresentativePatterns(patterns) {
  const byHeadsign = new Map();
  for (const pattern of patterns) {
    const key = pattern.headsign || `(no headsign, trip ${pattern.tripId})`;
    const existing = byHeadsign.get(key);
    if (!existing || pattern.stops.length > existing.stops.length) byHeadsign.set(key, pattern);
  }
  return [...byHeadsign.values()];
}

// Maps each GTFS direction_id to a live direction_name string, using
// whichever live trips happen to be running right now -- any live trip in a
// given direction resolves the *whole* direction_id (not just its own
// headsign's pattern), since direction_id is shared across headsigns.
function buildDirectionNameMap(liveTrips, patterns) {
  const directionIdByTripId = new Map(patterns.map((p) => [p.tripId, p.directionId]));
  const names = new Map();
  for (const trip of liveTrips || []) {
    if (!trip || !trip.direction_name) continue;
    const directionId = directionIdByTripId.get(trip.trip_id);
    if (directionId != null && !names.has(directionId)) names.set(directionId, trip.direction_name);
  }
  return names;
}

function directionLabel(directionNames, directionId) {
  const name = directionNames.get(directionId);
  return name || `direction_id ${directionId} (name unconfirmed -- no live trip running this direction right now)`;
}

function printStopTable(routeId, pattern, directionNames, isLive) {
  const label = directionLabel(directionNames, pattern.directionId);
  const liveNote = isLive ? "currently running" : "schedule only, not currently running";
  console.log(
    `\nRoute ${routeId}${pattern.headsign ? ` — "${pattern.headsign}"` : ""} — ${label} (trip ${pattern.tripId}, ${liveNote})`
  );
  const seqWidth = Math.max(3, ...pattern.stops.map((s) => String(s.stopSequence).length));
  const idWidth = Math.max(7, ...pattern.stops.map((s) => String(s.stopId).length));
  console.log(`  ${"seq".padEnd(seqWidth)}  ${"stop_id".padEnd(idWidth)}  stop_name`);
  for (const stop of pattern.stops) {
    console.log(`  ${String(stop.stopSequence).padEnd(seqWidth)}  ${String(stop.stopId).padEnd(idWidth)}  ${stop.stopName || ""}`);
  }
}

function printStopEntriesFull(routeId, pattern, directionNames, isLive) {
  const label = directionLabel(directionNames, pattern.directionId);
  const liveNote = isLive ? "currently running" : "schedule only, not currently running";
  console.log(`\nRoute ${routeId}${pattern.headsign ? ` — "${pattern.headsign}"` : ""} — ${label} (trip ${pattern.tripId}, ${liveNote})`);
  const resolvedDirection = directionNames.get(pattern.directionId);
  for (const stop of pattern.stops) {
    console.log(`  ${stop.stopName || ""}`);
    if (resolvedDirection) {
      console.log(
        `  { routeId: "${routeId}", stopId: ${stop.stopId}, direction: "${resolvedDirection}", label: "${routeId}" },`
      );
    } else {
      console.log(
        `  { routeId: "${routeId}", stopId: ${stop.stopId}, direction: "TODO_CONFIRM_DIRECTION" /* direction_id ${pattern.directionId}, no live trip to confirm the name -- check SEPTA's site or re-run later */, label: "${routeId}" },`
      );
    }
  }
}

function parseArgs(argv) {
  let routeId = null;
  let full = false;
  for (const arg of argv) {
    if (arg === "--full" || arg === "-f") {
      full = true;
    } else if (!routeId) {
      routeId = arg;
    }
  }
  return { routeId, full };
}

async function main() {
  const { routeId, full } = parseArgs(process.argv.slice(2));
  if (!routeId) {
    console.error("Usage: node scripts/find-stop.js <routeId> [--full]");
    console.error("Example: node scripts/find-stop.js 17");
    console.error("Example: node scripts/find-stop.js 17 --full");
    process.exit(1);
  }

  console.error(`Downloading SEPTA's static schedule feed (one-time per run, ~20MB)...`);
  let patterns;
  try {
    patterns = await fetchRouteStopPatterns(routeId);
  } catch (err) {
    console.error(`Failed to fetch/parse the schedule feed for route ${routeId}: ${err.message}`);
    process.exit(1);
  }

  if (patterns.length === 0) {
    console.error(`No scheduled trips found for route ${routeId} in the static schedule. Check the route_id.`);
    process.exit(1);
  }

  // Live data is best-effort here -- only used to label directions and flag
  // which patterns are currently running, so a failure shouldn't block the
  // (more complete) schedule-based listing.
  let liveTrips = [];
  try {
    liveTrips = await fetchTrips(routeId);
  } catch (err) {
    console.error(`Warning: couldn't fetch live trips (${err.message}) -- direction names will be unconfirmed.`);
  }
  // "Currently running" is checked by headsign, not by the exact
  // representative trip_id above -- that trip_id is just whichever static
  // schedule instance happened to have the most stops, essentially never the
  // literal trip that's live right now even when its headsign is.
  const liveHeadsigns = new Set((liveTrips || []).map((trip) => trip && trip.trip_headsign).filter(Boolean));
  const directionNames = buildDirectionNameMap(liveTrips, patterns);

  const representative = pickRepresentativePatterns(patterns).sort((a, b) => {
    if (a.directionId !== b.directionId) return String(a.directionId).localeCompare(String(b.directionId));
    return String(a.headsign).localeCompare(String(b.headsign));
  });

  for (const pattern of representative) {
    const isLive = liveHeadsigns.has(pattern.headsign);
    if (full) {
      printStopEntriesFull(routeId, pattern, directionNames, isLive);
    } else {
      printStopTable(routeId, pattern, directionNames, isLive);
    }
  }

  if (full) {
    console.log(
      '\nCopy the object for your stop straight into the "routes" array in config.js ' +
        "(adjust label if you'd like something other than the route number). Entries marked " +
        "TODO_CONFIRM_DIRECTION need the direction name filled in by hand -- re-run this command " +
        "while a trip in that direction is running, or check SEPTA's site."
    );
  } else {
    console.log(
      "\nCopy the stop_id and the direction name exactly as shown above (e.g. \"Northbound\") " +
        "into your config.js route entry. Or re-run with --full to get ready-to-paste routes[] entries."
    );
  }
}

main();
