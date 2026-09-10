#!/usr/bin/env node
"use strict";

// Helper for figuring out which stop_id/direction_name to put in your config.js, without needing a separate "stops" API
// (SEPTA doesn't document one we could verify).
//
// Lists every stop, for every scheduled stop pattern (headsign) on the route, straight from SEPTA's static GTFS schedule
// -- including short-turn/express patterns with no currently-running trip,
// which a purely live-data approach can miss entirely (you'd have to happen to run this while one of those trips was in service).
//
// Same-direction patterns are merged into one deduped view rather than printed as separate blocks: the longest pattern becomes the reference,
// and any other pattern's stops the reference doesn't already have are spliced in as unlabeled "alt" rows at the point where they leave the reference
// -- or, for a pattern that *starts* off the reference, at the point where it rejoins,
// so that an alt block always sits next to the reference stop it really connects to on some trip
// (a pattern with nothing extra -- SEPTA often just runs a shorter version of the same route
// -- contributes nothing beyond its headsign name).
// See gtfs-schedule.js's mergeDirectionPatterns for the actual algorithm.
//
// Each row can carry a trip count, printed sparsely (see pickAnnotatedRows).
// The reference is chosen by stop count alone, which is uncorrelated with how often a pattern runs,
// so an "alt" row can easily be better served than the main sequence it's spliced into
// -- the counts are the only thing in the output that distinguishes a genuine branch from a once-a-day variant.
// Not printed by --full, whose rows are meant to be pasted into config.js verbatim.
//
// Output is fully deterministic across runs: no "currently running" annotation, no calendar/day filtering
// (a weekend-only pattern shows up even if you run this on a Tuesday), same result every time for a given GTFS feed
// -- direction names included, since those also come straight from the static feed's directions.txt.
//
// Usage: node scripts/find-stop.js <routeId> [--full] Example: node scripts/find-stop.js 17 Example: node scripts/find-stop.js 17 --full

const {
  fetchRouteStopPatterns,
  mergeDirectionPatterns,
  loadCacheFromDisk,
  FEED_CACHE_PATH,
  FEED_CACHE_MAX_AGE_MS,
} = require("../gtfs-schedule.js");

// "95 minutes" below 2h (fine-grained enough to be useful for a same-session re-run), "3 hours" above it
// (the cache lasts a full FEED_CACHE_MAX_AGE_MS day, so precision past whole hours isn't useful).
function formatCacheAge(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(ms / 3600000);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

// One representative trip per distinct (direction, headsign, stop sequence)
// -- collapses true duplicates (many trips running the exact same route at different times of day) down to one,
// without assuming two trips sharing a headsign necessarily share a stop pattern.
// That assumption doesn't always hold, most often because two trips originating from different places can share a headsign
// -- keying on headsign alone would silently discard the shorter one.
// A genuine same-headsign subset pattern still ends up contributing nothing extra visually,
// but that's mergeDirectionPatterns' doing (it already treats "every stop already in the reference" as a no-op), not a filter applied here.
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

// The header label for a direction: its name from directions.txt, or a fallback noting the feed didn't have one
// (a route with any trips should always have an entry, per the feed's own directions.txt
// -- this only guards against a future feed omitting one).
function directionHeaderLabel(directionNames, directionId) {
  const name = directionNames.get(directionId);
  return name || `Unknown Direction (direction_id ${directionId} -- not listed in SEPTA's directions.txt)`;
}

// { value, comment }: value always drops in cleanly as the `direction` field with nothing extra inside it,
// so a named direction is directly copyable as-is.
// Any caveat goes in `comment`, printed as a trailing `//` comment *after* the object instead of embedded inside the field value.
function directionConfigFragment(directionNames, directionId) {
  const name = directionNames.get(directionId);
  if (name) return { value: `"${name}"`, comment: null };
  return {
    value: `"TODO_CONFIRM_DIRECTION"`,
    comment: `direction_id ${directionId} isn't listed in SEPTA's directions.txt -- check SEPTA's site`,
  };
}

// "Front-Market" -> `"Front-Market"`; ["A","B"] -> `"A" and "B"`; ["A","B","C"] -> `"A", "B", and "C"` (oxford comma).
function formatHeadsignList(headsigns) {
  const quoted = headsigns.map((h) => `"${h}"`);
  if (quoted.length <= 1) return quoted.join("");
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")}, and ${quoted[quoted.length - 1]}`;
}

// Prints a blank line at every transition between "stop" and "alt" rows (but never before the very first row),
// which is what visually sets an alt block apart from the main sequence regardless of whether it's a leading, trailing, or interior block
// -- see gtfs-schedule.js's mergeDirectionPatterns for how rows are ordered.
//
// Also breaks *within* an alt block wherever mergeDirectionPatterns set breakBefore,
// i.e. where the two stops don't actually run one into the other on any trip.
// Without that, one block of alt rows reads as a single consecutive stretch of road when it can really be several unrelated branches printed back to back (route 44 Westbound stacks three).
function shouldBreakBefore(row, prevType) {
  if (prevType === null) return false; // never before the very first row
  return row.type !== prevType || Boolean(row.breakBefore);
}

// How many trips actually serve each stop, in one direction.
// Built from the full per-trip patterns list (not the reduced `representative` set), since that's the only place the real counts survive
// -- pickRepresentativePatterns keeps one trip per distinct (direction, headsign, shape) and discards how many trips shared it.
//
// A stop is counted once per trip even if that trip stops there twice
// (a loop route's turnaround), because the printed column is labelled "trips", not "stop events".
function countTripsByStop(patterns, directionId) {
  const counts = new Map();
  for (const pattern of patterns) {
    if (directionId != null && String(pattern.directionId) !== String(directionId)) continue;
    const seen = new Set();
    for (const stop of pattern.stops) {
      if (seen.has(stop.stopId)) continue;
      seen.add(stop.stopId);
      counts.set(stop.stopId, (counts.get(stop.stopId) || 0) + 1);
    }
  }
  return counts;
}

// Which rows get a trip count printed next to them.
// Annotating every row buries the signal (a long route is ~100 near-identical numbers),
// so this prints one only where it tells the reader something they can't infer from the row above:
//
//   - the first and last row, so the listing is always anchored;
//   - either side of a blank line, i.e. wherever an alt block starts or
//     ends or one alt block breaks into another (see shouldBreakBefore) --
//     these are exactly the branch points, where "how much service does
//     this stretch actually get" is the question being asked;
//   - any row whose count differs from the row immediately above it.
//
// Everything else is silent and inherits the last number printed,
// so a mid-route detour reads as a dip and a return
// (route 63 Northbound drops to 14 for the Essington stops, then resumes at 230) rather than as a wall of digits.
// Typically annotates well under a fifth of rows; a single-pattern direction gets exactly two, first and last.
function pickAnnotatedRows(rows, tripsByStop) {
  const tripsAt = (row) => tripsByStop.get(row.stopId) || 0;
  return rows.map((row, index) => {
    if (index === 0 || index === rows.length - 1) return true;
    if (shouldBreakBefore(row, rows[index - 1].type)) return true;
    const next = rows[index + 1];
    if (next && shouldBreakBefore(next, row.type)) return true;
    return tripsAt(row) !== tripsAt(rows[index - 1]);
  });
}

function printMergedDirection(routeId, label, merged, tripsByStop) {
  console.log(`\nRoute ${routeId} — ${label} — ${formatHeadsignList(merged.headsigns)}`);
  const stopRows = merged.rows.filter((r) => r.type === "stop");
  const seqWidth = Math.max(3, ...stopRows.map((r) => String(r.stopSequence).length));
  const idWidth = Math.max(7, ...merged.rows.map((r) => String(r.stopId).length));
  const nameWidth = Math.max(9, ...merged.rows.map((r) => (r.stopName || "").length));
  const annotated = pickAnnotatedRows(merged.rows, tripsByStop);
  console.log(`  ${"seq".padEnd(seqWidth)}  ${"stop_id".padEnd(idWidth)}  ${"stop_name".padEnd(nameWidth)}  trips`);
  let prevType = null;
  merged.rows.forEach((row, index) => {
    if (shouldBreakBefore(row, prevType)) console.log("");
    const seqLabel = row.type === "alt" ? "alt" : String(row.stopSequence);
    // trimEnd so an unannotated row is byte-for-byte what it printed before this column existed, rather than carrying invisible padding.
    const trips = annotated[index] ? String(tripsByStop.get(row.stopId) || 0).padStart(5) : "";
    console.log(
      `  ${seqLabel.padEnd(seqWidth)}  ${String(row.stopId).padEnd(idWidth)}  ${(row.stopName || "").padEnd(nameWidth)}  ${trips}`.trimEnd()
    );
    prevType = row.type;
  });
}

function printMergedDirectionFull(routeId, label, merged, directionNames, directionId) {
  console.log(`\nRoute ${routeId} — ${label} — ${formatHeadsignList(merged.headsigns)}`);
  const { value, comment } = directionConfigFragment(directionNames, directionId);
  const commentSuffix = comment ? ` // ${comment}` : "";
  let prevType = null;
  for (const row of merged.rows) {
    if (shouldBreakBefore(row, prevType)) console.log("");
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

  // Decides which message to print below *and* is passed straight through to fetchRouteStopPatterns as preloadedCache,
  // so that function doesn't have to re-read and re-parse the same
  // (potentially 100MB+) cache file from disk a second time just to reach the same freshness verdict.
  const cachedFeed = loadCacheFromDisk(FEED_CACHE_PATH);
  const cacheFresh = Boolean(cachedFeed && Date.now() - cachedFeed.downloadedAt < FEED_CACHE_MAX_AGE_MS);
  if (cacheFresh) {
    console.error(`Using SEPTA's static schedule feed cached ${formatCacheAge(Date.now() - cachedFeed.downloadedAt)} ago...`);
  } else {
    console.error(
      "Downloading SEPTA's static schedule feed (~20MB, takes about 5-15 seconds) -- cached afterward for 24h..."
    );
  }
  // Whether or not the feed itself needed downloading, filtering it down to this one route is real, measurable work
  // (~800ms against a full feed, more for a route with a lot of distinct patterns) that happens entirely inside fetchRouteStopPatterns below
  // -- print this before calling it, not after, so the wait is actually accounted for instead of looking stalled.
  console.error("Processing data...");
  let patterns, directionNames;
  try {
    ({ patterns, directionNames } = await fetchRouteStopPatterns(routeId, fetch, FEED_CACHE_PATH, cachedFeed));
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

  let anyUnknownDirection = false;
  for (const directionId of directionIds) {
    const merged = mergeDirectionPatterns(byDirection.get(directionId));
    if (!directionNames.get(directionId)) anyUnknownDirection = true;
    const label = directionHeaderLabel(directionNames, directionId);
    if (full) {
      printMergedDirectionFull(routeId, label, merged, directionNames, directionId);
    } else {
      printMergedDirection(routeId, label, merged, countTripsByStop(patterns, directionId));
    }
  }

  if (full) {
    console.log(
      '\nCopy the object for your stop straight into the "routes" array in config.js ' +
        "(adjust label if you'd like something other than the route number)."
    );
  } else if (anyUnknownDirection) {
    console.log(
      "\nAt least one direction above shows \"Unknown Direction\" because SEPTA's directions.txt " +
        "doesn't list a name for it. The stop_id is still correct as shown -- check SEPTA's site for " +
        "the real direction name before copying the entry into your config.js."
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
  countTripsByStop,
  pickAnnotatedRows,
  directionHeaderLabel,
  directionConfigFragment,
};
