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

// Which cardinal axis each direction name belongs to -- used by the
// geography sanity check below to tell an axis disagreement (e.g. reported
// Eastbound, schedule geometry says north-south) apart from a same-axis
// reversal (reported Northbound, schedule geometry clearly runs south).
const AXIS_OF_DIRECTION = {
  Northbound: "NS",
  Southbound: "NS",
  Eastbound: "EW",
  Westbound: "EW",
};

// Miles per degree of latitude/longitude, adjusted for Philadelphia's
// latitude (~40degN, where SEPTA's entire service area sits) so lat and lon
// displacements are directly comparable in miles.
const MILES_PER_DEGREE_LAT = 69.0;
const MILES_PER_DEGREE_LON = 69.0 * Math.cos((40 * Math.PI) / 180);

// Below this net displacement along whichever axis dominates, a pattern's
// endpoints are too close together to tell a real cardinal trend from noise
// (e.g. a short shuttle loop) -- computeDirectionTrend backs off rather than
// guess.
const MIN_TREND_DISPLACEMENT_MILES = 0.5;

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

// One representative trip per distinct (direction, headsign, stop
// sequence) -- collapses true duplicates (many trips running the exact
// same route at different times of day) down to one, without assuming two
// trips sharing a headsign necessarily share a stop pattern. That
// assumption doesn't always hold, most often because two trips originating
// from different places can share a headsign -- keying on headsign alone
// would silently discard the shorter one. A genuine same-headsign subset
// pattern still ends up contributing nothing extra visually, but that's
// mergeDirectionPatterns' doing (it already treats "every stop already in
// the reference" as a no-op), not a filter applied here.
function pickRepresentativePatterns(patterns) {
  const byPattern = new Map();
  for (const pattern of patterns) {
    const headsignPart = pattern.headsign || `(no headsign, trip ${pattern.tripId})`;
    const shapePart = pattern.stops.map((s) => s.stopId).join(",");
    const key = `${pattern.directionId} ${headsignPart} ${shapePart}`;
    if (!byPattern.has(key)) byPattern.set(key, pattern);
  }
  return [...byPattern.values()];
}

// Map<directionId, { name, confirmed: true } | { seenUnnamed: true }> from
// whichever live trips happen to be running right now -- any live trip in a
// given direction resolves the *whole* direction_id (not just its own
// headsign's pattern), since direction_id is shared across headsigns.
//
// { seenUnnamed: true } means a live trip is confirmed running in this
// direction right now, but SEPTA's own feed never gives it a usable name
// (confirmed live, e.g. every currently-running trip on T1-T5, route 63, and
// B1/B2/B3/L1 reports the literal string "N/A" for direction_name even
// though direction_id itself is populated normally) -- kept distinct from
// "nothing running at all" (no entry) so directionHeaderLabel/
// directionConfigFragment don't tell a real, running trip's direction "no
// live trip currently running", which is simply false for these routes.
function buildDirectionNameMap(liveTrips, patterns) {
  const directionIdByTripId = new Map(patterns.map((p) => [p.tripId, p.directionId]));
  const names = new Map();
  for (const trip of liveTrips || []) {
    if (!trip) continue;
    const directionId = directionIdByTripId.get(trip.trip_id);
    if (directionId == null) continue;
    const existing = names.get(directionId);
    if (existing && existing.confirmed) continue; // already have a real name, nothing to improve
    // See buildDirectionNameMap's doc comment above -- "N/A" is SEPTA's own
    // sentinel for "not a real name", not a genuine confirmation.
    if (trip.direction_name && trip.direction_name !== "N/A") {
      names.set(directionId, { name: trip.direction_name, confirmed: true });
    } else if (!existing) {
      names.set(directionId, { seenUnnamed: true });
    }
  }
  return names;
}

// Net lat/lon displacement (in miles) from the first to the last stop of the
// SHORTEST pattern in a direction -- deliberately the shortest, not the
// longest. The longest pattern is the one most likely to include a
// short-turn/express spur at one end that runs off in some other direction
// (real example: route 63's longest pattern in one direction detours far
// enough west that its first-to-last-stop trend reads as east-west, even
// though every one of that direction's patterns -- and the schedule's own
// street-crossing order -- agrees it's actually a north-south route). The
// shortest pattern is the one least likely to include such a spur, so it's
// the better stand-in for the route's core direction.
//
// Returns null (not enough signal to say anything) if lat/lon is missing for
// either endpoint stop, or if the net displacement along the dominant axis
// is below MIN_TREND_DISPLACEMENT_MILES.
function computeDirectionTrend(directionPatterns) {
  let shortest = null;
  for (const pattern of directionPatterns) {
    if (!shortest || pattern.stops.length < shortest.stops.length) shortest = pattern;
  }
  const stops = shortest.stops;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (first.stopLat == null || first.stopLon == null || last.stopLat == null || last.stopLon == null) return null;

  const dLatMiles = (last.stopLat - first.stopLat) * MILES_PER_DEGREE_LAT;
  const dLonMiles = (last.stopLon - first.stopLon) * MILES_PER_DEGREE_LON;
  const dominantAxis = Math.abs(dLatMiles) >= Math.abs(dLonMiles) ? "NS" : "EW";
  const dominantMiles = dominantAxis === "NS" ? dLatMiles : dLonMiles;
  if (Math.abs(dominantMiles) < MIN_TREND_DISPLACEMENT_MILES) return null;

  const name =
    dominantAxis === "NS" ? (dLatMiles >= 0 ? "Northbound" : "Southbound") : dLonMiles >= 0 ? "Eastbound" : "Westbound";
  return { dominantAxis, name };
}

// Demotes a live-confirmed direction_name to unconfirmed when it contradicts
// its own schedule pattern's geography in a way that has no legitimate
// explanation: the reported name's axis (N/S vs E/W) matches the schedule's
// dominant axis, but the sign is backwards (data says Northbound, the
// pattern's own stops clearly run south). This never asserts a direction
// from geography alone -- it only ever takes a confirmed name away -- and it
// never acts on an axis-level disagreement (reported Eastbound, geography
// says N/S): naming conventions can legitimately put a route on an axis that
// doesn't match its literal compass heading (I-76 keeps its E/W designation
// through Philadelphia even where the road itself runs mostly north-south),
// so that kind of disagreement isn't treated as evidence of a data error. A
// same-axis reversal has no such excuse, so it's demoted rather than
// trusted -- confirmed live on route 135, where both directions' live
// direction_name is the literal opposite of what every stop in their own
// pattern says.
function applyGeographySanityCheck(directionNames, byDirection) {
  const result = new Map(directionNames);
  for (const [directionId, entry] of directionNames) {
    if (!entry.confirmed) continue;
    const directionPatterns = byDirection.get(directionId);
    if (!directionPatterns) continue;
    const trend = computeDirectionTrend(directionPatterns);
    if (!trend) continue;
    if (AXIS_OF_DIRECTION[entry.name] !== trend.dominantAxis) continue;
    if (trend.name === entry.name) continue;
    console.error(
      `Warning: SEPTA's live feed reports "${entry.name}" for direction_id ${directionId}, but every stop in that ` +
        `direction's own schedule pattern runs the opposite way along the same axis (net trend: ${trend.name}). ` +
        "Treating the live-reported name as unconfirmed rather than trusting a reversed report."
    );
    result.set(directionId, { rejectedGeography: true, rejectedName: entry.name });
  }
  return result;
}

// If there are exactly two directions total and exactly one has a confirmed
// live name, infer the other as its cardinal opposite
// (Northbound<->Southbound, Eastbound<->Westbound) -- but tag it as
// inferred, not confirmed, so callers can still flag it for double-checking.
// Counts only *confirmed* entries toward "exactly one" -- a seenUnnamed
// entry for the other direction (a live trip running with no usable name)
// doesn't disqualify the inference, and the inferred guess overwrites it:
// a labeled, caveated guess is more useful than "seen, but nothing to say
// about it". Leaves directionNames alone in every other case (more than two
// directions, zero or both already confirmed, or an unrecognized confirmed
// name).
function inferOppositeDirectionNames(directionNames, allDirectionIds) {
  const result = new Map(directionNames);
  const confirmed = [...result.entries()].filter(([, entry]) => entry.confirmed);
  if (allDirectionIds.length !== 2 || confirmed.length !== 1) return result;
  const [[knownId, knownEntry]] = confirmed;
  const opposite = OPPOSITE_DIRECTION[knownEntry.name];
  if (!opposite) return result;
  const otherId = allDirectionIds.find((id) => id !== knownId);
  result.set(otherId, { name: opposite, confirmed: false, inferredFrom: knownEntry.name });
  return result;
}

function directionHeaderLabel(entry, directionId) {
  if (!entry) return `Unknown Direction (direction_id ${directionId} -- no live trip currently running to confirm its name)`;
  if (entry.seenUnnamed) {
    return `Unknown Direction (direction_id ${directionId} -- a live trip is running right now, but SEPTA's live feed doesn't give it a usable direction name)`;
  }
  if (entry.rejectedGeography) {
    return `Unknown Direction (direction_id ${directionId} -- SEPTA provided ambiguous data on what this direction is called)`;
  }
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
  if (entry.seenUnnamed) {
    return {
      value: `"TODO_CONFIRM_DIRECTION"`,
      comment: `direction_id ${directionId}, a live trip is running right now but SEPTA's live feed never gives this route's trips a usable direction name -- check SEPTA's site`,
    };
  }
  if (entry.rejectedGeography) {
    return {
      value: `"TODO_CONFIRM_DIRECTION"`,
      comment: `direction_id ${directionId}, SEPTA's live feed reported "${entry.rejectedName}" but that contradicts this direction's own schedule geography -- check SEPTA's site or re-run later`,
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

  // Decides which message to print below *and* is passed straight through
  // to fetchRouteStopPatterns as preloadedCache, so that function doesn't
  // have to re-read and re-parse the same (potentially 100MB+) cache file
  // from disk a second time just to reach the same freshness verdict.
  const cachedFeed = loadCacheFromDisk(FEED_CACHE_PATH);
  const cacheFresh = Boolean(cachedFeed && Date.now() - cachedFeed.downloadedAt < FEED_CACHE_MAX_AGE_MS);
  if (cacheFresh) {
    console.error(`Using SEPTA's static schedule feed cached ${formatCacheAge(Date.now() - cachedFeed.downloadedAt)} ago...`);
  } else {
    console.error(
      "Downloading SEPTA's static schedule feed (~20MB, takes about 5-15 seconds) -- cached afterward for 24h..."
    );
  }
  // Whether or not the feed itself needed downloading, filtering it down to
  // this one route is real, measurable work (~800ms against a full feed,
  // more for a route with a lot of distinct patterns) that happens entirely
  // inside fetchRouteStopPatterns below -- print this before calling it, not
  // after, so the wait is actually accounted for instead of looking stalled.
  console.error("Processing data...");
  let patterns;
  try {
    patterns = await fetchRouteStopPatterns(routeId, fetch, FEED_CACHE_PATH, cachedFeed);
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
  directionNames = applyGeographySanityCheck(directionNames, byDirection);
  directionNames = inferOppositeDirectionNames(directionNames, directionIds);

  let anyUnknownDirection = false;
  for (const directionId of directionIds) {
    const merged = mergeDirectionPatterns(byDirection.get(directionId));
    const entry = directionNames.get(directionId) || null;
    if (!entry || entry.seenUnnamed || entry.rejectedGeography) anyUnknownDirection = true;
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
  } else if (anyUnknownDirection) {
    console.log(
      "\nAt least one direction above shows \"Unknown Direction\" because either no trip in that direction is " +
        "currently running for SEPTA to confirm its name, a trip is running but SEPTA's live feed never gives " +
        "this route's trips a usable direction name (true for every trip on some routes, e.g. the trolleys and " +
        "route 63 -- re-running later won't help those), or SEPTA's live data for it didn't hold up (see any " +
        "warnings above). The stop_id is still correct as shown -- check SEPTA's site for the real direction " +
        "name before copying the entry into your config.js."
    );
  } else {
    console.log(
      "\nCopy the stop_id and the direction name exactly as shown above (e.g. \"Northbound\") " +
        "into your config.js route entry. Or re-run with --full to get ready-to-paste routes[] entries."
    );
  }
}

if (require.main === module) main();

module.exports = {
  pickRepresentativePatterns,
  buildDirectionNameMap,
  computeDirectionTrend,
  applyGeographySanityCheck,
  inferOppositeDirectionNames,
  directionHeaderLabel,
  directionConfigFragment,
};
