"use strict";

// Lightweight, dependency-free fallback to SEPTA's static GTFS schedule, used
// to fill in arrivals beyond what /trips/ currently knows about (see
// septa-client.js's isTripTracked/useScheduleSupplement). No native modules,
// no full-feed database -- the (large) static feed is only ever
// downloaded/parsed rarely (see node_helper.js's once-daily refresh), never
// on the hot per-route polling path.
//
// Only trips.txt, stop_times.txt, calendar.txt, and calendar_dates.txt are
// read out of the zip; shapes.txt/stops.txt/etc are never touched. The
// result is filtered immediately down to the user's configured
// (routeId, stopId) pairs, so what actually stays resident/cached is tiny
// (dozens to low hundreds of rows), even though scanning stop_times.txt
// itself means streaming through every row in the feed (confirmed live:
// ~1s for 2 million rows).

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const GTFS_URL = "https://www3.septa.org/developer/google_bus.zip";
const DEFAULT_CACHE_PATH = path.join(__dirname, "gtfs-cache.json");
const NEEDED_FILES = ["trips.txt", "stop_times.txt", "calendar.txt", "calendar_dates.txt"];
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

// stops.txt -> Map<stop_id, stop_name>. Only ever read by
// scripts/find-stop.js (a one-off dev tool) -- node_helper.js's runtime
// schedule cache deliberately never touches stops.txt, to keep the daily
// refresh/cache footprint tiny (see fetchScheduleCache/NEEDED_FILES).
function parseStops(text) {
  const stops = new Map();
  for (const row of parseCsv(text, splitCsvLineQuoted)) {
    if (row.stop_id) stops.set(row.stop_id, row.stop_name || null);
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
// serviceId, arrivalTimeSeconds, headsign}. Passing no stopIds (or null)
// keeps every stop for every known trip -- used by
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
function buildScheduleCache(fileTexts, routeIds, stopIds) {
  const trips = parseTripsForRoutes(fileTexts["trips.txt"], routeIds);
  const entries = parseStopTimesForTrips(fileTexts["stop_times.txt"], trips, stopIds);
  const calendar = parseCalendar(fileTexts["calendar.txt"]);
  const calendarExceptions = parseCalendarDates(fileTexts["calendar_dates.txt"]);
  return { builtAt: Date.now(), entries, calendar, calendarExceptions };
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
      }));
    patterns.push({ tripId, headsign: trip.headsign, directionId: trip.directionId, stops });
  }
  return patterns;
}

// Returns scheduled arrivals for one route/stop within the next
// horizonMinutes, each shaped to match septa-client.js's etas entries
// (minus `tracked`, which callers should set to false -- these are always
// schedule-only by definition). Checks both "today" and "yesterday" as the
// service-day basis so post-midnight arrival_time values (GTFS allows
// times >= 24:00:00 for trips that start the previous service day) resolve
// correctly; at most one basis can ever fall within a 60-minute-scale
// horizon, so no double-counting is possible.
function getScheduledArrivals(cache, routeId, stopId, now, horizonMinutes) {
  const targetRouteId = String(routeId);
  const targetStopId = Number(stopId);
  const nowMs = now.getTime();
  const horizonMs = horizonMinutes * 60000;

  const results = [];
  for (const entry of cache.entries) {
    if (entry.routeId !== targetRouteId || entry.stopId !== targetStopId) continue;
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

// Every distinct headsign scheduled to serve this route/stop at any point
// in the day (not just the next horizonMinutes), sorted alphabetically for
// a stable order. Used to assign footnote markers to destinations
// consistently, rather than by whichever trip happens to be next right now
// -- that would make the same destination's marker change from one poll to
// the next as different trips rotate through.
function getAllHeadsignsForStop(cache, routeId, stopId) {
  const targetRouteId = String(routeId);
  const targetStopId = Number(stopId);
  const headsigns = new Set();
  for (const entry of cache.entries) {
    if (entry.routeId !== targetRouteId || entry.stopId !== targetStopId) continue;
    if (entry.headsign) headsigns.add(entry.headsign);
  }
  return [...headsigns].sort();
}

// Headsigns scheduled at (routeId, primaryStopId) that are never scheduled at
// (routeId, secondaryStopId) -- i.e. destinations whose pattern structurally
// never reaches the secondary stop (a short-turn trip, etc), independent of
// any detour. Used to flag "this bus won't take you to your secondary stop"
// regardless of which specific trip happens to be next.
function getHeadsignsSkippingStop(cache, routeId, primaryStopId, secondaryStopId) {
  const primaryHeadsigns = getAllHeadsignsForStop(cache, routeId, primaryStopId);
  const secondaryHeadsigns = new Set(getAllHeadsignsForStop(cache, routeId, secondaryStopId));
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
// scripts/find-stop.js.
async function fetchRouteStopPatterns(routeId, fetchImpl = fetch) {
  const fileTexts = await downloadGtfsFiles(ROUTE_STOP_PATTERN_FILES, fetchImpl);
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
  parseStopTimesForTrips,
  parseCalendar,
  parseCalendarDates,
  isServiceActiveOn,
  buildScheduleCache,
  buildRouteStopPatterns,
  getScheduledArrivals,
  getAllHeadsignsForStop,
  getHeadsignsSkippingStop,
  fetchScheduleCache,
  fetchRouteStopPatterns,
  loadCacheFromDisk,
  saveCacheToDisk,
};
