"use strict";

// Pure, dependency-free client for SEPTA's public v2 REST API, plus the
// filtering/orchestration logic that turns raw API responses into a display-
// ready summary for one route/stop/direction. No timers, no module-level
// state, no MagicMirror dependency — everything here takes explicit inputs
// so it can be unit tested with fixture JSON and a fake clock.
//
// Ported from the proven design in /home/josh/working/lightpi
// (fetchers.py:199-319, config.py:139-178), which has polled these same
// endpoints reliably for months.

const BASE_URL = "https://www3.septa.org/api/v2";
const REQUEST_TIMEOUT_MS = 20000;

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`SEPTA request failed: ${response.status} ${response.statusText} (${url})`);
  }
  return response.json();
}

async function fetchDetours(routeId, fetchImpl = fetch) {
  return fetchJson(`${BASE_URL}/detours/?route=${encodeURIComponent(routeId)}`, fetchImpl);
}

async function fetchTrips(routeId, fetchImpl = fetch) {
  return fetchJson(`${BASE_URL}/trips/?route_id=${encodeURIComponent(routeId)}`, fetchImpl);
}

async function fetchTripUpdate(tripId, fetchImpl = fetch) {
  return fetchJson(`${BASE_URL}/trip-update/?trip_id=${encodeURIComponent(tripId)}`, fetchImpl);
}

// SEPTA formats detour start/end as "%m/%d/%Y, %H:%M:%S" (e.g.
// "7/6/2026, 14:30:00"). JS Date parsing of that exact format isn't
// reliable across locales/engines, so parse it by hand.
function parseSeptaDateTime(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [month, day, year, hour, minute, second] = match.slice(1).map(Number);
  return new Date(year, month - 1, day, hour, minute, second);
}

// SEPTA's detour skipped_stops has shown up as a flat array of stop-id
// strings, but every live detour we've actually captured returns an object
// keyed by stop id instead (values are [name, lat, lon], not needed here).
// Handle both, plus null/missing.
function detourSkipsStop(skippedStops, targetStopId) {
  if (Array.isArray(skippedStops)) {
    return skippedStops.map(String).includes(targetStopId);
  }
  if (skippedStops && typeof skippedStops === "object") {
    return Object.prototype.hasOwnProperty.call(skippedStops, targetStopId);
  }
  return false;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseTimeOfDaySeconds(value) {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(value).trim());
  if (!match) return null;
  const [hour, minute, second] = match.slice(1).map(Number);
  return hour * 3600 + minute * 60 + second;
}

// day_time_active_info gives each detour a per-weekday "HH:MM:SS-HH:MM:SS"
// window on top of its overall start/end date range (e.g. a detour that's
// only in effect during evening rush hour, every day, for a month). The
// window can cross midnight (e.g. "16:30:00-04:30:00"). If the field is
// missing entirely, the detour is active for its whole date range, which
// matches SEPTA's own convention of an explicit "00:00:00-23:59:59" entry
// meaning "all day".
function isWithinDayTimeWindow(dayTimeInfo, now) {
  if (!dayTimeInfo || typeof dayTimeInfo !== "object") return true;
  const range = dayTimeInfo[DAY_NAMES[now.getDay()]];
  if (!range) return false;
  const [startStr, endStr] = String(range).split("-");
  const start = parseTimeOfDaySeconds(startStr);
  const end = parseTimeOfDaySeconds(endStr);
  if (start == null || end == null) return true;
  const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  return start <= end ? nowSeconds >= start && nowSeconds <= end : nowSeconds >= start || nowSeconds <= end;
}

// Returns the detour currently in effect for this stop (so callers can read
// fields like `reason`), or null. A detour is "active" if now falls strictly
// between its start/end date range, the configured stop is one of its
// skipped stops, and (if present) now falls within its day_time_active_info
// window for today.
function findActiveDetour(detours, stopId, now = new Date()) {
  if (!Array.isArray(detours)) return null;
  const targetStopId = String(stopId);
  return (
    detours.find((detour) => {
      if (!detour) return false;
      const start = parseSeptaDateTime(detour.start);
      const end = parseSeptaDateTime(detour.end);
      if (!start || !end) return false;
      if (!(now > start && now < end)) return false;
      if (!detourSkipsStop(detour.skipped_stops, targetStopId)) return false;
      return isWithinDayTimeWindow(detour.day_time_active_info, now);
    }) || null
  );
}

function isDetourActive(detours, stopId, now = new Date()) {
  return findActiveDetour(detours, stopId, now) !== null;
}

// A trip is "good" if it's heading the configured direction, isn't
// canceled, and hasn't already progressed past its first stop.
function filterGoodTrips(trips, direction) {
  if (!Array.isArray(trips)) return [];
  return trips.filter((trip) => {
    if (!trip) return false;
    if (trip.direction_name !== direction) return false;
    if (trip.status === "CANCELED") return false;
    return Number(trip.next_stop_sequence || 0) > 1;
  });
}

// A stop_time counts as an upcoming arrival if it's for the configured
// stop, hasn't already departed, is still in the future, and doesn't carry
// SEPTA's "bad data" delay sentinel (>= 999).
//
// stop_id shows up as a string in some SEPTA payloads (e.g. trips'
// next_stop_id) and as a number in others (trip-update's stop_times), so
// compare numerically rather than with strict equality.
function filterStopTimes(stopTimes, stopId, now = Date.now() / 1000) {
  if (!Array.isArray(stopTimes)) return [];
  const targetStopId = Number(stopId);
  return stopTimes.filter((stopTime) => {
    if (!stopTime) return false;
    return (
      Number(stopTime.stop_id) === targetStopId &&
      !stopTime.departed &&
      Number(stopTime.eta) > now &&
      Number(stopTime.delay) < 999
    );
  });
}

// Data is "fresh" until it ages past 3x the refresh interval, matching
// lightpi's get_data() staleness window (fetchers.py:212-226).
function computeIsFresh(lastFetchTime, refreshIntervalSeconds, now = Date.now()) {
  if (lastFetchTime == null) return false;
  const ageSeconds = (now - lastFetchTime) / 1000;
  return ageSeconds <= refreshIntervalSeconds * 3;
}

// Runs one full poll cycle for a single route/stop/direction.
//
// routeConfig: { routeId, stopId, direction }
// options.fetchImpl: injectable fetch implementation (defaults to global fetch)
// options.now: () => Date, injectable clock (defaults to () => new Date())
//
// Detour and trips fetch failures propagate (throw) so the caller can apply
// its own retry-interval backoff. Per-trip trip-update failures are isolated
// (Promise.allSettled) so one bad trip only sets hasTripError — it never
// fails the whole cycle, mirroring lightpi's
// asyncio.gather(..., return_exceptions=True).
async function pollRoute(routeConfig, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const nowFn = options.now || (() => new Date());
  const { routeId, stopId, direction } = routeConfig;

  const nowDate = nowFn();

  const detours = await fetchDetours(routeId, fetchImpl);
  const activeDetour = findActiveDetour(detours, stopId, nowDate);
  if (activeDetour) {
    const reason = activeDetour.reason && activeDetour.reason.trim() ? activeDetour.reason.trim() : null;
    return {
      etas: [],
      detour: true,
      detourReason: reason,
      headsign: null,
      direction,
      hasTripError: false,
      fetchedAt: nowDate.getTime(),
    };
  }

  const trips = await fetchTrips(routeId, fetchImpl);
  const goodTrips = filterGoodTrips(trips, direction);
  const headsign = (goodTrips[0] && goodTrips[0].trip_headsign) || null;

  const nowSeconds = nowDate.getTime() / 1000;
  const results = await Promise.allSettled(
    goodTrips.map((trip) => fetchTripUpdate(trip.trip_id, fetchImpl))
  );

  let hasTripError = false;
  const etas = [];
  for (const result of results) {
    if (result.status === "rejected") {
      hasTripError = true;
      continue;
    }
    const stopTimes = result.value && result.value.stop_times;
    for (const stopTime of filterStopTimes(stopTimes, stopId, nowSeconds)) {
      etas.push(Number(stopTime.eta));
    }
  }
  etas.sort((a, b) => a - b);

  return {
    etas,
    detour: false,
    detourReason: null,
    headsign,
    direction,
    hasTripError,
    fetchedAt: nowDate.getTime(),
  };
}

module.exports = {
  BASE_URL,
  fetchDetours,
  fetchTrips,
  fetchTripUpdate,
  parseSeptaDateTime,
  isDetourActive,
  findActiveDetour,
  filterGoodTrips,
  filterStopTimes,
  computeIsFresh,
  pollRoute,
};
