"use strict";

// Pure config-parsing helpers. No I/O, no MagicMirror/Node dependency, so
// these are unit-testable in isolation and safe to call from node_helper.js's
// config registration. Most of them concern a "merged" route entry -- one
// config.js routes[] entry that covers more than one SEPTA route_id at a
// shared stop (see README's "Merging routes" section).

// Splits a configured routeId into the list of route_ids it actually means.
// A comma-separated string ("T2,T3,T4,T5") is the primary, documented form;
// a bare JSON array is an undocumented equivalent for anyone who'd rather
// write structured config. Either way, a single, unmerged routeId ("17")
// still comes back as a one-element array, so callers never need a separate
// "is this route merged" branch -- every route entry is just "a list of one
// or more route_ids" from here on.
function parseRouteIds(routeId) {
  if (Array.isArray(routeId)) return routeId.map(String);
  return String(routeId)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

// Resolves the configured `direction` for one specific sub-routeId of a
// (possibly merged) route entry. A plain string applies uniformly to every
// sub-route -- the common case, since most merges share one cardinal
// direction (e.g. T2-T5's shared Westbound corridor). A {routeId:
// directionString} object is the escape hatch for a merge whose sub-routes
// genuinely don't share an axis (e.g. one Northbound, one Eastbound -- see
// README) -- each sub-route resolves only its own entry, undefined if that
// routeId is missing from the map. That's a config error; callers degrade
// the same way an unrecognized routeId/secondaryStopId already does
// elsewhere in this codebase (that sub-route just never matches a live
// trip and shows no arrivals, with a startup warning).
function resolveDirectionForRoute(direction, routeId) {
  if (direction && typeof direction === "object" && !Array.isArray(direction)) {
    return direction[routeId];
  }
  return direction;
}

// How far ahead the static-schedule supplement reaches, in minutes, when
// config.js doesn't say.
const DEFAULT_SCHEDULE_HORIZON_MINUTES = 60;

// Hard ceiling on that horizon. Twelve hours is far past the point where a
// bus could be live-tracked, but the binding reason is structural:
// getScheduledArrivals evaluates each schedule entry against yesterday's,
// today's and tomorrow's service day, and relies on those bases being 24h
// apart so at most one can land inside the horizon (see its comment). A
// horizon at or past 24h breaks that and the same trip is returned twice --
// measured on route 14 at stop 22524, a 48h horizon returns 127 arrivals of
// which 45 are duplicate tripIds. 720 keeps a 2x margin under that bound.
const MAX_SCHEDULE_HORIZON_MINUTES = 720;

// Resolves config.js's scheduleHorizonMinutes to a usable number of minutes.
//
// A value that genuinely expresses a number but lands out of range -- zero,
// negative, or past the ceiling -- resolves to the ceiling. That's
// deliberate: both "0 means unlimited" and "-1 means unlimited" are long-
// standing config conventions, and the ceiling is what unlimited means
// here. Other negatives and Infinity ride along on the same rule rather
// than earn a branch that would never fire. Turning the supplement *off*
// is useScheduleSupplement:false, not a zero horizon.
//
// Everything else expresses no number to honor -- unset, null, "", a string
// that won't parse, a boolean, an array -- and falls back to the default.
// The type check comes first precisely so those don't reach the range
// branch: Number() would quietly coerce null, "" and false to 0 and hand
// them the ceiling, which reads as "unlimited" for values that said nothing
// of the kind. A numeric string ("90") is still honored, and "0" still
// means unlimited, since both do express a number.
function resolveScheduleHorizonMinutes(value) {
  const expressesANumber = typeof value === "number" || (typeof value === "string" && value.trim() !== "");
  if (!expressesANumber) return DEFAULT_SCHEDULE_HORIZON_MINUTES;
  const minutes = Number(value);
  if (Number.isNaN(minutes)) return DEFAULT_SCHEDULE_HORIZON_MINUTES;
  if (minutes <= 0 || minutes > MAX_SCHEDULE_HORIZON_MINUTES) return MAX_SCHEDULE_HORIZON_MINUTES;
  return minutes;
}

module.exports = {
  parseRouteIds,
  resolveDirectionForRoute,
  resolveScheduleHorizonMinutes,
  DEFAULT_SCHEDULE_HORIZON_MINUTES,
  MAX_SCHEDULE_HORIZON_MINUTES,
};
