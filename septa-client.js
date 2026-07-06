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

// When skipped_stops is the object-keyed real API shape, each entry also
// carries the stop's name -- reuse it so the stop-context header still has
// something to show during an active detour, when we skip fetching trip
// data entirely and so can't derive stopName from stop_times instead.
function findSkippedStopName(skippedStops, targetStopId) {
  if (!skippedStops || Array.isArray(skippedStops) || typeof skippedStops !== "object") return null;
  const entry = skippedStops[targetStopId];
  return (Array.isArray(entry) && typeof entry[0] === "string" && entry[0]) || null;
}

// A trip is "good" if it's heading the configured direction and isn't
// canceled. With useScheduleSupplement enabled (the default), that's the
// whole rule -- trips SEPTA hasn't started GPS-tracking yet (or that
// haven't left their first stop) are included too, and flagged via
// isTripTracked() rather than dropped. With it disabled, only trips past
// their first stop count as "good", matching the module's original
// tracked-only behavior.
function filterGoodTrips(trips, direction, useScheduleSupplement = true) {
  if (!Array.isArray(trips)) return [];
  return trips.filter((trip) => {
    if (!trip) return false;
    if (trip.direction_name !== direction) return false;
    if (trip.status === "CANCELED") return false;
    if (useScheduleSupplement) return true;
    return Number(trip.next_stop_sequence || 0) > 1;
  });
}

// A trip counts as "tracked" (solid, live data) unless SEPTA's own data
// says otherwise: still at/before its first stop, no GPS yet, no vehicle
// assigned, or the trip-update response itself says "real-time": false.
// Untracked trips still get real ETAs (SEPTA blends in the static
// schedule for them), just with lower confidence -- flagged, not dropped.
function isTripTracked(tripsEntry, tripUpdateTrip) {
  if (!tripsEntry) return false;
  if (Number(tripsEntry.next_stop_sequence) === 1) return false;
  if (tripsEntry.status === "NO GPS") return false;
  if (tripsEntry.vehicle_id === "None") return false;
  if (tripUpdateTrip && tripUpdateTrip["real-time"] === false) return false;
  return true;
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

// Every stop_time entry in a trip-update carries stop_name for every stop
// along that trip, not just the target one -- reuse that (same trick
// scripts/find-stop.js uses) so callers can label which physical stop
// they're showing, without a separate "stops" API call.
function findStopName(stopTimes, stopId) {
  if (!Array.isArray(stopTimes)) return null;
  const targetStopId = Number(stopId);
  const match = stopTimes.find((stopTime) => stopTime && Number(stopTime.stop_id) === targetStopId);
  return (match && match.stop_name) || null;
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
  const useScheduleSupplement = options.useScheduleSupplement !== false;
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
      stopName: findSkippedStopName(activeDetour.skipped_stops, String(stopId)),
      direction,
      hasTripError: false,
      fetchedAt: nowDate.getTime(),
    };
  }

  const trips = await fetchTrips(routeId, fetchImpl);
  const goodTrips = filterGoodTrips(trips, direction, useScheduleSupplement);

  const nowSeconds = nowDate.getTime() / 1000;
  const results = await Promise.allSettled(
    goodTrips.map((trip) => fetchTripUpdate(trip.trip_id, fetchImpl))
  );

  // Each arrival keeps the headsign and tracked-status of the specific trip
  // it came from -- a route/direction can in principle have mixed headsigns
  // across trips (short-turns, etc), so a single route-level value can't be
  // trusted to describe every arrival shown.
  let hasTripError = false;
  let stopName = null;
  const etas = [];
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      hasTripError = true;
      return;
    }
    const stopTimes = result.value && result.value.stop_times;
    if (!stopName) stopName = findStopName(stopTimes, stopId);
    const tripEntry = goodTrips[index];
    const headsign = (tripEntry && tripEntry.trip_headsign) || null;
    const tracked = isTripTracked(tripEntry, result.value && result.value.trip);
    const tripId = (tripEntry && tripEntry.trip_id) || null;
    for (const stopTime of filterStopTimes(stopTimes, stopId, nowSeconds)) {
      etas.push({ eta: Number(stopTime.eta), headsign, tracked, tripId });
    }
  });
  etas.sort((a, b) => a.eta - b.eta);

  return {
    etas,
    detour: false,
    detourReason: null,
    stopName,
    direction,
    hasTripError,
    fetchedAt: nowDate.getTime(),
  };
}

// Merges GTFS-schedule-derived candidates (see gtfs-schedule.js's
// getScheduledArrivals) into an already-tracked etas list. A candidate is
// dropped unconditionally if its eta is at or before the latest tracked
// arrival (SEPTA's own live data should already cover anything that
// imminent -- if it didn't show up there, something's off, so it's not
// worth surfacing from the schedule instead) and otherwise dropped only if
// its tripId matches a trip we're already showing (the same run counted
// twice). Survivors are tagged tracked:false and merged in eta order.
function mergeScheduledArrivals(trackedEtas, scheduledCandidates) {
  const maxTrackedEta = trackedEtas.reduce((max, arrival) => Math.max(max, arrival.eta), -Infinity);
  const trackedTripIds = new Set(trackedEtas.map((arrival) => arrival.tripId).filter(Boolean));

  const survivors = scheduledCandidates
    .filter((candidate) => candidate.eta > maxTrackedEta && !trackedTripIds.has(candidate.tripId))
    .map((candidate) => ({ ...candidate, tracked: false }));

  return [...trackedEtas, ...survivors].sort((a, b) => a.eta - b.eta);
}

module.exports = {
  BASE_URL,
  fetchDetours,
  fetchTrips,
  fetchTripUpdate,
  parseSeptaDateTime,
  isDetourActive,
  findActiveDetour,
  findSkippedStopName,
  filterGoodTrips,
  isTripTracked,
  filterStopTimes,
  findStopName,
  computeIsFresh,
  pollRoute,
  mergeScheduledArrivals,
};
