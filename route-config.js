"use strict";

// Pure config-parsing helpers for a "merged" route entry -- one config.js
// routes[] entry that covers more than one SEPTA route_id at a shared stop
// (see README's "Merging routes" section). No I/O, no MagicMirror/Node
// dependency, so these are unit-testable in isolation and safe to call from
// node_helper.js's config registration.

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

module.exports = { parseRouteIds, resolveDirectionForRoute };
