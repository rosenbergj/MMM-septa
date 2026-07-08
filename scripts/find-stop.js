#!/usr/bin/env node
"use strict";

// Helper for figuring out which stop_id/direction_name to put in your
// config.js, without needing a separate "stops" API (SEPTA doesn't
// document one we could verify).
//
// Lists every stop, for every scheduled stop pattern (headsign) on the
// route, straight from SEPTA's static GTFS schedule -- including
// short-turn/express patterns with no currently-running trip, which a
// purely live-data approach can miss entirely (you'd have to happen to run
// this while one of those trips was in service).
//
// Same-direction patterns are merged into one deduped view rather than
// printed as separate blocks: the longest pattern becomes the reference,
// and any other pattern's stops the reference doesn't already have are
// spliced in as unlabeled "alt" rows at the point where they diverge (a
// pattern with nothing extra -- SEPTA often just runs a shorter version of
// the same route -- contributes nothing beyond its headsign name). See
// gtfs-schedule.js's mergeDirectionPatterns for the actual algorithm.
//
// Output is deterministic across runs: no "currently running" annotation,
// no calendar/day filtering (a weekend-only pattern shows up even if you
// run this on a Tuesday), same result every time for a given GTFS feed.
// Live /trips/ data is used for exactly one thing -- resolving each
// direction's real direction_name string -- since that's the one piece of
// real information the static feed can't provide (it only has direction_id
// 0/1, not a name).
//
// Usage: node scripts/find-stop.js <routeId> [--full]
// Example: node scripts/find-stop.js 17
// Example: node scripts/find-stop.js 17 --full

const { fetchTrips } = require("../septa-client.js");
const {
  fetchRouteStopPatterns,
  mergeDirectionPatterns,
  loadCacheFromDisk,
  FEED_CACHE_PATH,
  FEED_CACHE_MAX_AGE_MS,
} = require("../gtfs-schedule.js");

// "95 minutes" below 2h (fine-grained enough to be useful for a
// same-session re-run), "3 hours" above it (the cache lasts a full
// FEED_CACHE_MAX_AGE_MS day, so precision past whole hours isn't useful).
function formatCacheAge(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(ms / 3600000);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

const OPPOSITE_DIRECTION = {
  Northbound: "Southbound",
  Southbound: "Northbound",
  Eastbound: "Westbound",
  Westbound: "Eastbound",
};

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

// Map<directionId, { name, confirmed: true }> from whichever live trips
// happen to be running right now -- any live trip in a given direction
// resolves the *whole* direction_id (not just its own headsign's pattern),
// since direction_id is shared across headsigns.
function buildDirectionNameMap(liveTrips, patterns) {
  const directionIdByTripId = new Map(patterns.map((p) => [p.tripId, p.directionId]));
  const names = new Map();
  for (const trip of liveTrips || []) {
    if (!trip || !trip.direction_name) continue;
    const directionId = directionIdByTripId.get(trip.trip_id);
    if (directionId != null && !names.has(directionId)) names.set(directionId, { name: trip.direction_name, confirmed: true });
  }
  return names;
}

// If there are exactly two directions total and exactly one is confirmed
// live, infer the other as its cardinal opposite (Northbound<->Southbound,
// Eastbound<->Westbound) -- but tag it as inferred, not confirmed, so
// callers can still flag it for double-checking. Leaves directionNames
// alone in every other case (more than two directions, zero or both
// already confirmed, or an unrecognized confirmed name).
function inferOppositeDirectionNames(directionNames, allDirectionIds) {
  const result = new Map(directionNames);
  if (allDirectionIds.length !== 2 || result.size !== 1) return result;
  const [[knownId, knownEntry]] = result.entries();
  const opposite = OPPOSITE_DIRECTION[knownEntry.name];
  if (!opposite) return result;
  const otherId = allDirectionIds.find((id) => id !== knownId);
  result.set(otherId, { name: opposite, confirmed: false, inferredFrom: knownEntry.name });
  return result;
}

function directionHeaderLabel(entry, directionId) {
  if (!entry) return `direction_id ${directionId} (name unconfirmed -- no live trip running this direction right now)`;
  if (entry.confirmed) return entry.name;
  return `${entry.name} (inferred as the opposite of ${entry.inferredFrom} -- not live-confirmed, double-check)`;
}

// { value, comment }: value always drops in cleanly as the `direction` field
// with nothing extra inside it, so a correctly-confirmed (or, once you've
// double-checked it, correctly-inferred) entry is directly copyable as-is.
// Any caveat goes in `comment`, printed as a trailing `//` comment *after*
// the object instead of embedded inside the field value.
function directionConfigFragment(entry, directionId) {
  if (!entry) {
    return {
      value: `"TODO_CONFIRM_DIRECTION"`,
      comment: `direction_id ${directionId}, no live trip to confirm the name -- check SEPTA's site or re-run later`,
    };
  }
  if (entry.confirmed) return { value: `"${entry.name}"`, comment: null };
  return {
    value: `"${entry.name}"`,
    comment: `inferred as the opposite of ${entry.inferredFrom} -- not live-confirmed, double-check`,
  };
}

// "Front-Market" -> `"Front-Market"`; ["A","B"] -> `"A" and "B"`; ["A","B","C"]
// -> `"A", "B", and "C"` (oxford comma).
function formatHeadsignList(headsigns) {
  const quoted = headsigns.map((h) => `"${h}"`);
  if (quoted.length <= 1) return quoted.join("");
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")}, and ${quoted[quoted.length - 1]}`;
}

// Prints a blank line at every transition between "stop" and "alt" rows
// (but never before the very first row), which is what visually sets an
// alt block apart from the main sequence regardless of whether it's a
// leading, trailing, or interior block -- see gtfs-schedule.js's
// mergeDirectionPatterns for how rows are ordered.
function printMergedDirection(routeId, label, merged) {
  console.log(`\nRoute ${routeId} — ${label} — ${formatHeadsignList(merged.headsigns)}`);
  const stopRows = merged.rows.filter((r) => r.type === "stop");
  const seqWidth = Math.max(3, ...stopRows.map((r) => String(r.stopSequence).length));
  const idWidth = Math.max(7, ...merged.rows.map((r) => String(r.stopId).length));
  console.log(`  ${"seq".padEnd(seqWidth)}  ${"stop_id".padEnd(idWidth)}  stop_name`);
  let prevType = null;
  for (const row of merged.rows) {
    if (prevType !== null && row.type !== prevType) console.log("");
    const seqLabel = row.type === "alt" ? "alt" : String(row.stopSequence);
    console.log(`  ${seqLabel.padEnd(seqWidth)}  ${String(row.stopId).padEnd(idWidth)}  ${row.stopName || ""}`);
    prevType = row.type;
  }
}

function printMergedDirectionFull(routeId, label, merged, directionEntry, directionId) {
  console.log(`\nRoute ${routeId} — ${label} — ${formatHeadsignList(merged.headsigns)}`);
  const { value, comment } = directionConfigFragment(directionEntry, directionId);
  const commentSuffix = comment ? ` // ${comment}` : "";
  let prevType = null;
  for (const row of merged.rows) {
    if (prevType !== null && row.type !== prevType) console.log("");
    console.log(`  ${row.stopName || ""}`);
    console.log(`  { routeId: "${routeId}", stopId: ${row.stopId}, direction: ${value}, label: "${routeId}" },${commentSuffix}`);
    prevType = row.type;
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

  // Purely informational -- fetchRouteStopPatterns makes the same freshness
  // check itself and is the actual source of truth for whether it downloads
  // or reuses the cache. Checked separately here only so the right message
  // prints *before* a possible download starts (the whole point is warning
  // about the wait in advance); an extremely unlikely race where the cache
  // expires between this check and that one just means a stale message, not
  // stale data.
  const cachedFeed = loadCacheFromDisk(FEED_CACHE_PATH);
  const cacheFresh = Boolean(cachedFeed && Date.now() - cachedFeed.downloadedAt < FEED_CACHE_MAX_AGE_MS);
  if (cacheFresh) {
    console.error(`Using SEPTA's static schedule feed cached ${formatCacheAge(Date.now() - cachedFeed.downloadedAt)} ago...`);
  } else {
    console.error(
      "Downloading SEPTA's static schedule feed (~20MB, takes about 5-15 seconds) -- cached afterward for 24h..."
    );
  }
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

  const representative = pickRepresentativePatterns(patterns);

  const byDirection = new Map();
  for (const pattern of representative) {
    if (!byDirection.has(pattern.directionId)) byDirection.set(pattern.directionId, []);
    byDirection.get(pattern.directionId).push(pattern);
  }
  const directionIds = [...byDirection.keys()].sort();

  // Live data is best-effort and used for exactly one thing (direction
  // names) -- a failure shouldn't block the (more complete) schedule-based
  // listing.
  let liveTrips = [];
  try {
    liveTrips = await fetchTrips(routeId);
  } catch (err) {
    console.error(`Warning: couldn't fetch live trips (${err.message}) -- direction names will be unconfirmed.`);
  }
  // Matched against the full per-trip patterns list, not just the reduced
  // one-per-headsign `representative` set -- a live trip's specific trip_id
  // would almost never happen to be the one instance picked as
  // representative for its headsign, out of potentially dozens sharing it.
  let directionNames = buildDirectionNameMap(liveTrips, patterns);
  directionNames = inferOppositeDirectionNames(directionNames, directionIds);

  for (const directionId of directionIds) {
    const merged = mergeDirectionPatterns(byDirection.get(directionId));
    const entry = directionNames.get(directionId) || null;
    const label = directionHeaderLabel(entry, directionId);
    if (full) {
      printMergedDirectionFull(routeId, label, merged, entry, directionId);
    } else {
      printMergedDirection(routeId, label, merged);
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
