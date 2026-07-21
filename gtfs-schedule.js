"use strict";

// Lightweight, dependency-free fallback to SEPTA's static GTFS schedule, used
// to fill in arrivals beyond what /trips/ currently knows about (see
// septa-client.js's isTripTracked/useScheduleSupplement). No native modules,
// no full-feed database -- the (large) static feed is only ever
// downloaded/parsed rarely (see node_helper.js's once-daily refresh), never
// on the hot per-route polling path.
//
// Only trips.txt, stop_times.txt, calendar.txt, calendar_dates.txt, and
// (as of the stopNames addition below) stops.txt are read out of the zip;
// shapes.txt/etc are still never touched. The result is filtered immediately
// down to the user's configured (routeId, stopId) pairs, so what actually
// stays resident/cached is tiny (dozens to low hundreds of rows), even
// though scanning stop_times.txt itself means streaming through every row in
// the feed (confirmed live: ~1s for 2 million rows).

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const GTFS_URL = "https://www3.septa.org/developer/google_bus.zip";
const DEFAULT_CACHE_PATH = path.join(__dirname, "gtfs-cache.json");
const FEED_CACHE_PATH = path.join(__dirname, "find-stop-feed-cache.json");
// How long a cached download of the raw feed (see fetchRouteStopPatterns)
// stays valid before a re-run re-downloads instead of reusing it -- 24h to
// match the runtime schedule cache's own refresh cadence (SEPTA republishes
// this feed at most about that often anyway).
const FEED_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const NEEDED_FILES = ["trips.txt", "stop_times.txt", "calendar.txt", "calendar_dates.txt", "stops.txt"];
const DOW_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]; // index by Date#getDay()

// --- ZIP reading (central directory only; plain 32-bit fields, no ZIP64 --
// SEPTA's feed is ~20MB, nowhere near the 4GB threshold that would need it) ---

function readZipEntries(buffer, wantedNames) {
  const wanted = new Set(wantedNames);
  const found = new Map();

  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("gtfs-schedule: end-of-central-directory record not found");

  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);

  for (let i = 0; i < entryCount && found.size < wanted.size; i++) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x02014b50) throw new Error("gtfs-schedule: bad central directory entry signature");

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLen);

    if (wanted.has(name)) {
      const lfhNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
      const lfhExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

      let data;
      if (compressionMethod === 0) data = compressed;
      else if (compressionMethod === 8) data = zlib.inflateRawSync(compressed);
      else throw new Error(`gtfs-schedule: unsupported ZIP compression method ${compressionMethod} for ${name}`);

      found.set(name, data);
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return found;
}

// --- CSV parsing ---
// stop_times.txt rows are all plain numeric/time fields (no commas/quotes
// expected), so a fast plain split is used for it -- it's by far the
// largest file. trips.txt's trip_headsign is free text and could in
// principle contain a comma, so it gets a real quote-aware parser.

function splitCsvLineSimple(line) {
  return line.split(",");
}

function splitCsvLineQuoted(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(text, splitLine) {
  const lines = text.split("\n");
  const header = splitLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cols = splitLine(line);
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = cols[c];
    rows.push(row);
  }
  return rows;
}

// trips.txt filtered to a set of route_ids ->
// Map<trip_id, {routeId, serviceId, headsign, directionId}>
function parseTripsForRoutes(text, routeIds) {
  const targetRoutes = new Set(routeIds.map(String));
  const trips = new Map();
  for (const row of parseCsv(text, splitCsvLineQuoted)) {
    if (!targetRoutes.has(row.route_id)) continue;
    trips.set(row.trip_id, {
      routeId: row.route_id,
      serviceId: row.service_id,
      headsign: row.trip_headsign || null,
      directionId: row.direction_id,
    });
  }
  return trips;
}

// stops.txt -> Map<stop_id, stop_name>. Passing stopIds filters to just
// those stops (used by buildScheduleCache to keep the runtime cache's
// stopNames tiny, the same way parseStopTimesForTrips filters); omit it to
// keep every stop (used by scripts/find-stop.js, which doesn't know its
// stop_ids up front).
function parseStops(text, stopIds) {
  const targetStops = stopIds ? new Set(stopIds.map(String)) : null;
  const stops = new Map();
  for (const row of parseCsv(text, splitCsvLineQuoted)) {
    if (!row.stop_id) continue;
    if (targetStops && !targetStops.has(row.stop_id)) continue;
    stops.set(row.stop_id, row.stop_name || null);
  }
  return stops;
}

// stops.txt -> Map<stop_id, {lat, lon}>, dropping any row with a missing or
// non-numeric coordinate. Kept separate from parseStops (whose Map<id, name>
// shape is relied on directly by buildScheduleCache/node_helper.js and their
// tests) since this is only needed by scripts/find-stop.js's geography sanity
// check.
function parseStopLatLon(text) {
  const stops = new Map();
  for (const row of parseCsv(text, splitCsvLineQuoted)) {
    if (!row.stop_id || !row.stop_lat || !row.stop_lon) continue;
    const lat = Number(row.stop_lat);
    const lon = Number(row.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    stops.set(row.stop_id, { lat, lon });
  }
  return stops;
}

function timeToSeconds(value) {
  const match = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(String(value).trim());
  if (!match) return null;
  const [h, m, s] = match.slice(1).map(Number);
  return h * 3600 + m * 60 + s;
}

// stop_times.txt filtered to trips in tripsById, and (if stopIds is given)
// stops in stopIds -> array of {routeId, stopId, stopSequence, tripId,
// serviceId, arrivalTimeSeconds, headsign, directionId}. Passing no stopIds
// (or null) keeps every stop for every known trip -- used by
// scripts/find-stop.js's buildRouteStopPatterns to see a trip's full stop
// sequence; the runtime schedule cache always passes a real (small) stopIds
// set, so this stays off the hot path.
function parseStopTimesForTrips(text, tripsById, stopIds) {
  const targetStops = stopIds ? new Set(stopIds.map(String)) : null;
  const entries = [];
  const lines = text.split("\n");
  const header = splitCsvLineSimple(lines[0]).map((h) => h.trim());
  const tripIdx = header.indexOf("trip_id");
  const arrivalIdx = header.indexOf("arrival_time");
  const stopIdx = header.indexOf("stop_id");
  const seqIdx = header.indexOf("stop_sequence");

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Cheap pre-check before splitting: skip lines that can't possibly
    // reference one of our (comparatively few) target stop_ids. Skipped
    // entirely when unfiltered (targetStops === null).
    if (targetStops) {
      let matchesStop = false;
      for (const stopId of targetStops) {
        if (line.includes(`,${stopId},`)) {
          matchesStop = true;
          break;
        }
      }
      if (!matchesStop) continue;
    }

    const cols = splitCsvLineSimple(line);
    const tripId = cols[tripIdx];
    const trip = tripsById.get(tripId);
    if (!trip) continue;
    const stopId = cols[stopIdx];
    if (targetStops && !targetStops.has(stopId)) continue;
    const arrivalTimeSeconds = timeToSeconds(cols[arrivalIdx]);
    if (arrivalTimeSeconds == null) continue;

    entries.push({
      routeId: trip.routeId,
      stopId: Number(stopId),
      stopSequence: Number(cols[seqIdx]),
      tripId,
      serviceId: trip.serviceId,
      arrivalTimeSeconds,
      headsign: trip.headsign,
      directionId: trip.directionId,
    });
  }
  return entries;
}

// calendar.txt -> { [service_id]: { monday..sunday: bool, startDate, endDate } }
function parseCalendar(text) {
  const calendar = {};
  for (const row of parseCsv(text, splitCsvLineSimple)) {
    calendar[row.service_id] = {
      sunday: row.sunday === "1",
      monday: row.monday === "1",
      tuesday: row.tuesday === "1",
      wednesday: row.wednesday === "1",
      thursday: row.thursday === "1",
      friday: row.friday === "1",
      saturday: row.saturday === "1",
      startDate: row.start_date,
      endDate: row.end_date,
    };
  }
  return calendar;
}

// calendar_dates.txt -> { [service_id]: { [YYYYMMDD]: 1 (added) | 2 (removed) } }
function parseCalendarDates(text) {
  const exceptions = {};
  for (const row of parseCsv(text, splitCsvLineSimple)) {
    if (!exceptions[row.service_id]) exceptions[row.service_id] = {};
    exceptions[row.service_id][row.date] = Number(row.exception_type);
  }
  return exceptions;
}

function formatYYYYMMDD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

// Is this service_id running on this calendar date, per calendar.txt's
// day-of-week/date-range rule, overridden by any calendar_dates.txt
// exception for that exact date (added=1 always active, removed=2 always
// inactive, regardless of what calendar.txt alone would say).
function isServiceActiveOn(calendar, calendarExceptions, serviceId, date) {
  const dateStr = formatYYYYMMDD(date);
  const exceptionsForService = calendarExceptions[serviceId];
  if (exceptionsForService && exceptionsForService[dateStr] === 1) return true;
  if (exceptionsForService && exceptionsForService[dateStr] === 2) return false;

  const cal = calendar[serviceId];
  if (!cal) return false;
  if (dateStr < cal.startDate || dateStr > cal.endDate) return false;
  return Boolean(cal[DOW_KEYS[date.getDay()]]);
}

// Builds the full (unfiltered-by-date) cache object from raw zip file
// contents. Pure given the extracted text -- no I/O, easy to unit test.
// stopNames is filtered down to just stopIds (like entries is) so a
// configured stop's name is always resolvable from the daily schedule
// refresh, not just whenever a live trip happens to pass through it (which a
// structurally-skipping headsign, e.g. a secondary stop, might never do) --
// stops.txt in fileTexts is optional so callers that don't need names (or
// don't have it, e.g. NEEDED_FILES-less test fixtures) still work.
function buildScheduleCache(fileTexts, routeIds, stopIds) {
  const trips = parseTripsForRoutes(fileTexts["trips.txt"], routeIds);
  const entries = parseStopTimesForTrips(fileTexts["stop_times.txt"], trips, stopIds);
  const calendar = parseCalendar(fileTexts["calendar.txt"]);
  const calendarExceptions = parseCalendarDates(fileTexts["calendar_dates.txt"]);
  const stopNames = fileTexts["stops.txt"] ? Object.fromEntries(parseStops(fileTexts["stops.txt"], stopIds)) : {};
  const terminusExclusions = buildTerminusExclusions(fileTexts, entries, routeIds, stopIds);
  return { builtAt: Date.now(), entries, calendar, calendarExceptions, stopNames, terminusExclusions };
}

// Every trip on a route, stop-by-stop with names, straight from the static
// schedule -- so a short-turn pattern with no currently-running trip still
// shows up (unlike scripts/find-stop.js's old live-only approach, which
// could only ever show whichever trip happened to be running). Pure given
// the extracted GTFS text; requires stops.txt in fileTexts (the runtime
// schedule cache never fetches it -- see parseStops).
function buildRouteStopPatterns(fileTexts, routeId) {
  const trips = parseTripsForRoutes(fileTexts["trips.txt"], [routeId]);
  const stopNames = parseStops(fileTexts["stops.txt"]);
  const stopLatLon = parseStopLatLon(fileTexts["stops.txt"]);
  const allStopTimes = parseStopTimesForTrips(fileTexts["stop_times.txt"], trips);

  const stopTimesByTrip = new Map();
  for (const entry of allStopTimes) {
    if (!stopTimesByTrip.has(entry.tripId)) stopTimesByTrip.set(entry.tripId, []);
    stopTimesByTrip.get(entry.tripId).push(entry);
  }

  const patterns = [];
  for (const [tripId, trip] of trips) {
    const stopTimes = stopTimesByTrip.get(tripId);
    if (!stopTimes || stopTimes.length === 0) continue;
    const stops = [...stopTimes]
      .sort((a, b) => a.stopSequence - b.stopSequence)
      .map((s) => ({
        stopId: s.stopId,
        stopSequence: s.stopSequence,
        stopName: stopNames.get(String(s.stopId)) || null,
        stopLat: stopLatLon.get(String(s.stopId))?.lat ?? null,
        stopLon: stopLatLon.get(String(s.stopId))?.lon ?? null,
      }));
    patterns.push({ tripId, headsign: trip.headsign, directionId: trip.directionId, stops });
  }
  return patterns;
}

// Merges same-direction stop patterns (one per headsign -- see
// scripts/find-stop.js's pickRepresentativePatterns, which reduces
// buildRouteStopPatterns' one-per-trip output down to this first) into a
// single deduped, ordered view instead of printing each headsign's full
// stop list separately. Used by scripts/find-stop.js to keep its output
// short even for a route with many headsigns/short-turns.
//
// The longest pattern becomes the "reference". Every other pattern is
// walked stop-by-stop and matched against the reference via a
// monotonically-advancing stopId->index lookup (a match must be at a later
// reference index than the previous match, so a repeated stop_id -- e.g. a
// loop -- can't match backwards). Matched stops are "anchors"; stops that
// don't match anything in the reference are "extra", grouped into
// contiguous runs and anchored to whichever reference stop precedes them
// (or "before everything" if there's no preceding anchor yet). Once an
// extra run has been placed, its stops become anchors too, so a branch that
// only overlaps an *earlier branch* (not the reference) still lands at the
// right place -- see gapIndexByStopId below.
//
// A pattern with zero extra stops is fully contained in the reference (SEPTA
// often just runs a shorter/truncated version of the same route) and
// contributes nothing beyond its headsign name. Patterns are processed in
// alphabetical-headsign order (not whatever order they happened to arrive
// in) so a shared extra stop always gets credited to the same pattern on
// every run, and no stop is ever repeated in the output even if multiple
// patterns would otherwise both claim it.
//
// Returns { headsigns: string[], rows: [{ type: "stop"|"alt", stopId,
// stopSequence, stopName }] } -- rows is the reference's own stops in
// order, with each pattern's extra runs spliced in at the right position.
// An "alt" row additionally carries breakBefore: true when it does not
// actually follow the alt row above it on any trip (see the end of this
// function); the field is absent otherwise.
function mergeDirectionPatterns(directionPatterns) {
  const headsigns = [...new Set(directionPatterns.map((p) => p.headsign).filter(Boolean))].sort();
  if (directionPatterns.length === 0) return { headsigns, rows: [] };

  const reference = directionPatterns.reduce((a, b) => (b.stops.length > a.stops.length ? b : a));
  const referenceIndexByStopId = new Map();
  reference.stops.forEach((stop, index) => {
    if (!referenceIndexByStopId.has(stop.stopId)) referenceIndexByStopId.set(stop.stopId, index);
  });

  // gapRuns key: the reference index an extra run follows (-1 = before the
  // reference's own first stop). Value: extra stops (in order) to insert
  // there.
  const gapRuns = new Map();
  const alreadyIncluded = new Set(reference.stops.map((stop) => stop.stopId));
  // stopId -> the gapRuns key an already-placed extra stop was flushed into,
  // so a *later* pattern can anchor on it the same way it anchors on a
  // reference stop. Without this, a pattern whose only overlap with
  // everything seen so far is an extra stop claimed by an earlier pattern
  // has no anchor at all: lastMatchedIndex never leaves -1 and its entire
  // stop list flushes to the leading gap, printing a mid-route or trailing
  // branch as if it ran before the reference's first stop. Confirmed live on
  // route 44 Westbound, where the short "Ardmore via Montgomery Ave"
  // short-turn starts at 54th St & City Av (not a reference stop, and
  // already claimed by "54th-City") and so dumped its whole 24-stop Ardmore
  // tail above the reference instead of at the City Av divergence point.
  const gapIndexByStopId = new Map();

  const others = directionPatterns.filter((p) => p !== reference).sort((a, b) => a.headsign.localeCompare(b.headsign));
  for (const pattern of others) {
    let lastMatchedIndex = -1;
    let pending = [];
    const flushPending = () => {
      if (pending.length === 0) return;
      if (!gapRuns.has(lastMatchedIndex)) gapRuns.set(lastMatchedIndex, []);
      gapRuns.get(lastMatchedIndex).push(...pending);
      for (const stop of pending) gapIndexByStopId.set(stop.stopId, lastMatchedIndex);
      pending = [];
    };
    for (const stop of pattern.stops) {
      const refIndex = referenceIndexByStopId.get(stop.stopId);
      // An extra stop's gap index is only consulted when the stop isn't on
      // the reference at all -- a reference stop that failed the
      // monotonicity check above is a backwards match (a loop), and must
      // stay rejected rather than get a second chance here.
      const anchorIndex = refIndex != null ? refIndex : gapIndexByStopId.get(stop.stopId);
      if (anchorIndex != null && anchorIndex > lastMatchedIndex) {
        flushPending();
        lastMatchedIndex = anchorIndex;
      } else if (!alreadyIncluded.has(stop.stopId)) {
        pending.push(stop);
        alreadyIncluded.add(stop.stopId);
      }
      // else: already represented (on the reference itself, just not
      // reachable monotonically from here -- e.g. a loop -- or already
      // claimed by an earlier pattern's extra run at a position we've
      // already passed) -- never repeat it.
    }
    flushPending();
  }

  const rows = [];
  const appendGapRun = (index) => {
    for (const stop of gapRuns.get(index) || []) {
      rows.push({ type: "alt", stopId: stop.stopId, stopSequence: stop.stopSequence, stopName: stop.stopName });
    }
  };
  appendGapRun(-1);
  reference.stops.forEach((stop, index) => {
    rows.push({ type: "stop", stopId: stop.stopId, stopSequence: stop.stopSequence, stopName: stop.stopName });
    appendGapRun(index);
  });

  // A run of adjacent "alt" rows reads as "these stops follow one another on
  // some trip" -- but a single gap run can hold extra stops from several
  // different patterns (each contributes one contiguous run, appended in
  // turn), and even one pattern's own run can have an interior stop dropped
  // (already claimed by an earlier pattern, or a backwards loop match), so
  // that reading isn't always true. Mark the rows where it breaks down, so
  // callers can separate them visually the same way they already separate
  // stop-vs-alt transitions.
  //
  // The test is literal rather than structural (e.g. "did these two come
  // from the same flush?"): a pair is consecutive if *any* pattern in this
  // direction runs one stop straight into the other. That's exactly the
  // assumption a reader is making, and it correctly stays silent when two
  // separate patterns' runs happen to abut at a genuinely consecutive pair.
  const consecutivePairs = new Set();
  for (const pattern of directionPatterns) {
    for (let i = 1; i < pattern.stops.length; i++) {
      consecutivePairs.add(`${pattern.stops[i - 1].stopId}|${pattern.stops[i].stopId}`);
    }
  }
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1];
    const row = rows[i];
    // Only within an alt run -- a stop/alt transition is already a visible
    // boundary for callers, and reference stops are consecutive by
    // definition.
    if (previous.type !== "alt" || row.type !== "alt") continue;
    if (!consecutivePairs.has(`${previous.stopId}|${row.stopId}`)) row.breakBefore = true;
  }

  return { headsigns, rows };
}

// Returns scheduled arrivals for one route/stop within the next
// horizonMinutes, each shaped to match septa-client.js's etas entries
// (minus `tracked`, which callers should set to false -- these are always
// schedule-only by definition). Checks both "today" and "yesterday" as the
// service-day basis so post-midnight arrival_time values (GTFS allows
// times >= 24:00:00 for trips that start the previous service day) resolve
// correctly; at most one basis can ever fall within a 60-minute-scale
// horizon, so no double-counting is possible.
//
// directionId, when given, filters to just that direction -- some stop_ids
// are (rarely, but confirmed live -- e.g. route 2 stop 40) served by both
// directions of the same route, and without this a schedule-supplement
// arrival or headsign from the *opposite* configured direction would leak
// into the display. Omit it (undefined/null) to fall back to the old
// unfiltered behavior -- used when the caller hasn't yet resolved which
// directionId corresponds to the configured direction (see
// septa-client.js's pollRoute), since that's the common case (a stop used
// by only one direction) and unfiltered is still correct there.
function getScheduledArrivals(cache, routeId, stopId, now, horizonMinutes, directionId) {
  const targetRouteId = String(routeId);
  const targetStopId = Number(stopId);
  const targetDirectionId = directionId == null ? null : String(directionId);
  const nowMs = now.getTime();
  const horizonMs = horizonMinutes * 60000;

  const results = [];
  for (const entry of cache.entries) {
    if (entry.routeId !== targetRouteId || entry.stopId !== targetStopId) continue;
    if (targetDirectionId != null && entry.directionId !== targetDirectionId) continue;
    for (const dayOffset of [0, -1]) {
      const basisDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
      if (!isServiceActiveOn(cache.calendar, cache.calendarExceptions, entry.serviceId, basisDate)) continue;
      const etaMs = basisDate.getTime() + entry.arrivalTimeSeconds * 1000;
      if (etaMs >= nowMs && etaMs <= nowMs + horizonMs) {
        results.push({ eta: Math.floor(etaMs / 1000), tripId: entry.tripId, headsign: entry.headsign });
      }
    }
  }
  results.sort((a, b) => a.eta - b.eta);
  return results;
}

// Every distinct headsign scheduled to serve this route/stop at any point in
// the day (not just the next horizonMinutes), most-frequently-scheduled
// first (ties broken alphabetically, for a fully deterministic order) --
// used to assign footnote markers to destinations consistently, rather than
// by whichever trip happens to be next right now (that would make the same
// destination's marker change from one poll to the next as different trips
// rotate through) or by name (that would hand the friendliest, most
// recognizable marker to whichever headsign's name happens to sort first,
// even if it's a rarely-run pattern that a rider would see mismatched to it
// most of the time). Frequency here just means "how many scheduled
// stop_times entries this headsign has at this stop" -- unweighted by which
// calendar days are active, same as the rest of this function already
// ignores day-of-week -- which is a fine proxy for "how often a rider
// actually sees this one".
//
// directionId filtering: see getScheduledArrivals's doc comment -- same
// reasoning, same rare-but-real cross-direction leak this guards against.
function getAllHeadsignsForStop(cache, routeId, stopId, directionId) {
  const targetRouteId = String(routeId);
  const targetStopId = Number(stopId);
  const targetDirectionId = directionId == null ? null : String(directionId);
  const counts = new Map();
  for (const entry of cache.entries) {
    if (entry.routeId !== targetRouteId || entry.stopId !== targetStopId) continue;
    if (targetDirectionId != null && entry.directionId !== targetDirectionId) continue;
    if (!entry.headsign) continue;
    counts.set(entry.headsign, (counts.get(entry.headsign) || 0) + 1);
  }
  return [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
}

// Every distinct direction_id structurally scheduled to stop at
// (routeId, stopId) -- independent of any live data, so it's available even
// for a route whose live /trips/ feed never gives a usable direction_name
// (confirmed live: route 63). Most stops are exclusive to one direction (a
// street's two curbs get two different stop_ids), so this usually comes
// back with exactly one entry -- which is enough, on its own, to know which
// direction_id a configured stop means, with no direction_name needed at
// all. It can come back with more than one (some stops really are served by
// both directions of the same route, e.g. route 2 stop 40) or zero (nothing
// in the schedule cache matches).
function getDirectionIdsForStop(cache, routeId, stopId) {
  const targetRouteId = String(routeId);
  const targetStopId = Number(stopId);
  const directionIds = new Set();
  for (const entry of cache.entries) {
    if (entry.routeId !== targetRouteId || entry.stopId !== targetStopId) continue;
    directionIds.add(entry.directionId);
  }
  return [...directionIds].sort();
}

// For a (routeId, stopId) that getDirectionIdsForStop found ambiguous (2
// direction_ids -- e.g. a tunnel-portal terminus like T1-T5's 13th St, stop
// 283, where one direction's patterns all end there and the other's all
// start there), determines whether it's safe to resolve anyway without any
// live direction_name -- which some routes (confirmed live: T1-T5, route 63,
// B1/B2/B3/L1) never provide a usable one for, making the normal
// direction_name fallback (see septa-client.js's filterGoodTrips) permanently
// dead at a stop like this.
//
// A direction is "uniformly terminal" at this stop if every one of its
// patterns that reaches stopId does so only as that pattern's own last stop
// -- i.e. no rider could ever board here and continue somewhere on a trip
// from that direction (patterns that don't reach the stop at all don't count
// against it either way). When exactly one of the two directions is
// uniformly terminal and the other isn't, the other is the one anyone
// waiting at this stop actually wants -- returned here as a plain
// direction_id, usable exactly like a normal single-direction stop's
// structuralDirectionId (see node_helper.js's runCycle). The kept
// direction doesn't need to itself be uniform in any way -- some of its
// patterns can have the stop as their first stop, others as a plain
// mid-route stop; either way every one of them is a real, boardable,
// continuing trip.
//
// Returns null when the shape doesn't hold -- neither direction is uniformly
// terminal, so both have at least one genuinely continuing pattern and there
// is no direction safe to rule out. See README's "Known limitations" for why
// that residual case (and its mirror -- wanting the terminal side on purpose)
// is left unresolved rather than guessed at.
//
// fileTexts must include an unfiltered-by-stopId "stop_times.txt" -- the
// cache's own `entries` are pre-filtered to just the stops actually
// configured (see buildScheduleCache), so they can't answer "does this trip
// continue past here". This re-parses stop_times.txt for just this one
// route's trips (same approach as buildRouteStopPatterns/find-stop.js, just
// scoped to a single ambiguous route/stop instead of a whole route's
// listing) -- only worth its cost (a full pass over the already-downloaded
// feed text) because it's called rarely, once per daily schedule refresh,
// only for routeId/stopId pairs already known to be ambiguous.
function resolveTerminusExclusion(fileTexts, routeId, stopId, directionIds) {
  const trips = parseTripsForRoutes(fileTexts["trips.txt"], [routeId]);
  const allStopTimes = parseStopTimesForTrips(fileTexts["stop_times.txt"], trips);

  const stopTimesByTrip = new Map();
  for (const entry of allStopTimes) {
    if (!stopTimesByTrip.has(entry.tripId)) stopTimesByTrip.set(entry.tripId, []);
    stopTimesByTrip.get(entry.tripId).push(entry);
  }

  const targetStopId = Number(stopId);
  const uniformlyTerminal = new Map(directionIds.map((directionId) => [directionId, true]));

  for (const [tripId, stopTimes] of stopTimesByTrip) {
    const trip = trips.get(tripId);
    if (!trip || !directionIds.includes(trip.directionId)) continue;
    const sorted = [...stopTimes].sort((a, b) => a.stopSequence - b.stopSequence);
    const matchIndex = sorted.findIndex((s) => s.stopId === targetStopId);
    if (matchIndex === -1) continue; // this trip doesn't reach stopId at all
    if (matchIndex !== sorted.length - 1) uniformlyTerminal.set(trip.directionId, false);
  }

  const nonTerminal = directionIds.filter((directionId) => !uniformlyTerminal.get(directionId));
  return nonTerminal.length === 1 ? nonTerminal[0] : null;
}

// Precomputes resolveTerminusExclusion for every (routeId, stopId) pair
// among the configured routeIds/stopIds that getDirectionIdsForStop finds
// ambiguous -- cheap to check (entries is already small), expensive to
// resolve (a full stop_times.txt pass per ambiguous route), so this only
// pays that cost for pairs that actually need it. Returns a plain {
// "routeId:stopId": keptDirectionId } map, persisted as part of the cache
// (see buildScheduleCache) so it survives a disk-cache reload same as
// everything else in it.
function buildTerminusExclusions(fileTexts, entries, routeIds, stopIds) {
  const exclusions = {};
  for (const routeId of routeIds) {
    for (const stopId of stopIds) {
      const directionIds = getDirectionIdsForStop({ entries }, routeId, stopId);
      if (directionIds.length !== 2) continue;
      const kept = resolveTerminusExclusion(fileTexts, routeId, stopId, directionIds);
      if (kept != null) exclusions[`${routeId}:${stopId}`] = kept;
    }
  }
  return exclusions;
}

// Looks up a precomputed resolveTerminusExclusion result -- null (not just
// "falls through to the direction_name fallback") when this routeId/stopId
// pair either isn't ambiguous or didn't resolve, so callers can treat it
// exactly like any other "no structural signal" case.
function getTerminusExclusionDirectionId(cache, routeId, stopId) {
  const key = `${routeId}:${stopId}`;
  return (cache.terminusExclusions && cache.terminusExclusions[key]) ?? null;
}

// Headsigns scheduled at (routeId, primaryStopId) that are never scheduled at
// (routeId, secondaryStopId) -- i.e. destinations whose pattern structurally
// never stops at the secondary stop (a short-turn trip, a trip that starts
// further along the route than an earlier secondary stop, etc), independent
// of any detour or of which side of the primary stop the secondary one is
// on. Used to flag "this headsign doesn't stop at the secondary stop"
// regardless of which specific trip happens to be next. directionId is
// applied to both lookups -- see getScheduledArrivals's doc comment.
function getHeadsignsSkippingStop(cache, routeId, primaryStopId, secondaryStopId, directionId) {
  const primaryHeadsigns = getAllHeadsignsForStop(cache, routeId, primaryStopId, directionId);
  const secondaryHeadsigns = new Set(getAllHeadsignsForStop(cache, routeId, secondaryStopId, directionId));
  return primaryHeadsigns.filter((headsign) => !secondaryHeadsigns.has(headsign));
}

// Downloads the live feed and extracts just the requested files as text.
// I/O-only helper shared by fetchScheduleCache (the runtime cache's small
// NEEDED_FILES set) and fetchRouteStopPatterns (find-stop.js's heavier,
// stops.txt-inclusive one-off set) -- so both stay unit-testable without a
// network call, and the runtime path's file list is untouched by the
// script's needs.
async function downloadGtfsFiles(fileNames, fetchImpl = fetch) {
  const response = await fetchImpl(GTFS_URL);
  if (!response.ok) {
    throw new Error(`gtfs-schedule: failed to download feed: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const zipEntries = readZipEntries(buffer, fileNames);

  const fileTexts = {};
  for (const name of fileNames) {
    const data = zipEntries.get(name);
    if (!data) throw new Error(`gtfs-schedule: ${name} not found in feed`);
    fileTexts[name] = data.toString("utf8");
  }
  return fileTexts;
}

async function fetchScheduleCache(routeIds, stopIds, fetchImpl = fetch) {
  const fileTexts = await downloadGtfsFiles(NEEDED_FILES, fetchImpl);
  return buildScheduleCache(fileTexts, routeIds, stopIds);
}

const ROUTE_STOP_PATTERN_FILES = ["trips.txt", "stop_times.txt", "stops.txt"];

// Downloads just enough of the feed to list every scheduled stop pattern for
// one route (see buildRouteStopPatterns) -- used only by
// scripts/find-stop.js. The raw downloaded files are cached to disk
// (unfiltered by routeId, so a later run for a *different* route within the
// cache window benefits too, not just a repeat of the same one) for
// FEED_CACHE_MAX_AGE_MS -- only the actual network download/decompress is
// skipped on a cache hit. buildRouteStopPatterns' per-route filtering still
// runs every time regardless of cache status, and isn't free -- measured
// ~800ms against a real feed (stop_times.txt alone is over 100MB) -- so
// callers that want to show a "this may take a moment" message should print
// it before calling this, not after.
//
// preloadedCache lets a caller that already called loadCacheFromDisk itself
// (e.g. find-stop.js, to decide what status message to print before this
// runs) pass that result straight through, instead of this function reading
// and JSON-parsing the same (potentially 100MB+) cache file from disk all
// over again -- measured ~200ms on its own, pure waste when paid twice.
async function fetchRouteStopPatterns(routeId, fetchImpl = fetch, cachePath = FEED_CACHE_PATH, preloadedCache) {
  const cached = preloadedCache !== undefined ? preloadedCache : loadCacheFromDisk(cachePath);
  const cacheFresh = Boolean(cached && Date.now() - cached.downloadedAt < FEED_CACHE_MAX_AGE_MS);
  const fileTexts = cacheFresh ? cached.fileTexts : await downloadGtfsFiles(ROUTE_STOP_PATTERN_FILES, fetchImpl);
  if (!cacheFresh) saveCacheToDisk({ downloadedAt: Date.now(), fileTexts }, cachePath);
  return buildRouteStopPatterns(fileTexts, routeId);
}

// Lets the cache survive a MagicMirror restart without redownloading the
// feed -- returns null on any read/parse problem (missing file, corrupt
// JSON, etc), which callers treat the same as "no cache yet".
function loadCacheFromDisk(cachePath = DEFAULT_CACHE_PATH) {
  try {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch (err) {
    return null;
  }
}

function saveCacheToDisk(cache, cachePath = DEFAULT_CACHE_PATH) {
  try {
    fs.writeFileSync(cachePath, JSON.stringify(cache));
  } catch (err) {
    console.error(`gtfs-schedule: failed to write cache to disk: ${err.message}`);
  }
}

module.exports = {
  GTFS_URL,
  NEEDED_FILES,
  readZipEntries,
  parseTripsForRoutes,
  parseStops,
  parseStopLatLon,
  parseStopTimesForTrips,
  parseCalendar,
  parseCalendarDates,
  isServiceActiveOn,
  buildScheduleCache,
  buildRouteStopPatterns,
  getDirectionIdsForStop,
  resolveTerminusExclusion,
  getTerminusExclusionDirectionId,
  mergeDirectionPatterns,
  getScheduledArrivals,
  getAllHeadsignsForStop,
  getHeadsignsSkippingStop,
  fetchScheduleCache,
  fetchRouteStopPatterns,
  loadCacheFromDisk,
  saveCacheToDisk,
  FEED_CACHE_PATH,
  FEED_CACHE_MAX_AGE_MS,
};
