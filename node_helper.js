"use strict";

const path = require("path");
const NodeHelper = require("node_helper");
const { pollRoute, mergeScheduledArrivals, fetchRoutes, resolveRouteLabelColor, alignedDelayMs } = require("./septa-client.js");
const {
  fetchScheduleCache,
  getScheduledArrivals,
  hasActiveServiceOn,
  getAllHeadsignsForStop,
  getHeadsignsSkippingStop,
  getDirectionIdsForStop,
  getScheduledRouteIds,
  getTerminusExclusionDirectionId,
  // Both fully generic (path-parameterized, no GTFS-specific structure
  // assumed) despite living in gtfs-schedule.js -- reused as-is for the
  // route-colors cache below instead of duplicating the same trivial
  // read/write-with-error-handling logic.
  loadCacheFromDisk,
  saveCacheToDisk,
} = require("./gtfs-schedule.js");
const { parseRouteIds, resolveDirectionForRoute, resolveScheduleHorizonMinutes } = require("./route-config.js");

const SCHEDULE_INITIAL_DELAY_MS = 60 * 1000; // wait until well after MagicMirror's own startup
const SCHEDULE_REFRESH_MS = 24 * 60 * 60 * 1000; // once daily thereafter
const SCHEDULE_RETRY_MS = 60 * 60 * 1000; // retry sooner than a full day if a refresh fails
const ROUTE_COLORS_CACHE_PATH = path.join(__dirname, "route-colors-cache.json");
// Consecutive cycles a route's trip-update fetches must fail before the
// display's "!" indicator lights up -- avoids flickering it on for an
// isolated one-cycle blip (e.g. during a flaky-but-recovering SEPTA outage).
const TRIP_ERROR_DISPLAY_THRESHOLD = 3;
// Routes are spread across this window within each aligned polling tick.
// Aligning every route onto the same grid (see septa-client.js's
// alignedDelayMs) is what lets the display batch a whole cycle into one fade,
// but aligning them *exactly* would fire every route's requests at the same
// instant -- for a four-row config that's a burst of ~29 requests, including
// up to ~20 concurrent /trip-update/ calls, at one undocumented API.
const ROUTE_STAGGER_SPREAD_MS = 5000;
// ...but no two adjacent routes may be further apart than this. The frontend
// coalesces a cycle's updates by waiting for the burst to go quiet
// (MMM-septa.js's DATA_RENDER_QUIET_MS, 2000ms), and that's a *trailing*
// debounce: it collapses the whole burst into one fade only while each
// successive update lands within the quiet window of the one before it. So
// what has to stay under 2000ms is the gap between adjacent slots, not the
// total spread. Without this cap a two-route config would sit 2500ms apart
// (ROUTE_STAGGER_SPREAD_MS / 2) and fade twice per cycle. Keep it comfortably
// below DATA_RENDER_QUIET_MS; the two constants are coupled across the
// frontend/backend split, so changing either means rechecking the other.
const ROUTE_STAGGER_MAX_GAP_MS = 1500;

function routeKey(route) {
  return `${route.routeId}:${route.stopId}:${route.direction}`;
}

// This route's offset within the stagger window: slot `index` of `total`,
// evenly spaced, with the per-slot gap capped so the frontend can still
// coalesce the burst (see ROUTE_STAGGER_MAX_GAP_MS). Assigned by position in
// the configured route list rather than by hashing the route's key -- a hash
// is stable across config changes but clusters (measured on a real four-row
// config, one plausible instanceId put three rows inside the same second),
// and even spacing is the whole point of staggering. Deterministic either
// way: the same config produces the same slots on every restart, and only
// adding or removing a configured route reshuffles them, which costs nothing.
function routeStaggerMs(index, total) {
  if (!(total > 1)) return 0;
  const gapMs = Math.min(ROUTE_STAGGER_MAX_GAP_MS, ROUTE_STAGGER_SPREAD_MS / total);
  return Math.round(index * gapMs);
}

module.exports = NodeHelper.create({
  start() {
    // fullKey -> RouteState. Only one node_helper instance exists even with
    // multiple MMM-septa instances on screen, so state is keyed by
    // instanceId + route to keep every instance's routes independent.
    this.routes = new Map();
    // Use whatever was cached from a previous run (if any) immediately, so
    // a MagicMirror restart doesn't lose the schedule supplement for the
    // first 60+ seconds while a fresh download is pending.
    this.scheduleCache = loadCacheFromDisk();
    this.scheduleTimer = setTimeout(() => this.refreshScheduleCache(), SCHEDULE_INITIAL_DELAY_MS);
    // routeId -> hex color string, or null for "no override". Persisted to
    // disk (unlike the reasoning that originally justified *not* doing so --
    // measured 2026-07-08: SEPTA's /routes/ endpoint fails ~55% of the time,
    // so a restart landing on a failed first fetch would otherwise show
    // every route's default color until a retry succeeds, up to an hour
    // later) -- loaded here so a restart has the last known-good colors
    // immediately, same principle as the GTFS schedule cache just above,
    // just without that one's SCHEDULE_INITIAL_DELAY_MS (this is one small
    // JSON request, not worth deferring).
    const cachedRouteColors = loadCacheFromDisk(ROUTE_COLORS_CACHE_PATH);
    this.routeColors = cachedRouteColors || {};
    this.refreshRouteColors();
  },

  stop() {
    for (const state of this.routes.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.routes.clear();
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    if (this.routeColorTimer) clearTimeout(this.routeColorTimer);
  },

  // Fetches SEPTA's /routes/ endpoint (every route's metadata in one
  // response -- rail/trolley brand colors and each bus route's
  // is_frequent_bus flag, see septa-client.js's resolveRouteLabelColor) and
  // indexes it by routeId for runCycle to look up. Runs once at startup,
  // then once every 24h like the GTFS schedule refresh -- this metadata
  // essentially never changes, so a retry-on-failure/once-daily cadence is
  // plenty.
  async refreshRouteColors() {
    try {
      const routes = await fetchRoutes();
      this.routeColors = Object.fromEntries(routes.map((r) => [String(r.route_id), resolveRouteLabelColor(r)]));
      saveCacheToDisk(this.routeColors, ROUTE_COLORS_CACHE_PATH);
      console.log(`MMM-septa: refreshed route color metadata (${routes.length} routes)`);
      this.routeColorTimer = setTimeout(() => this.refreshRouteColors(), SCHEDULE_REFRESH_MS);
    } catch (err) {
      // warn, not error: /routes/ 404s intermittently and always has (~55%
      // of requests, measured 2026-07-08 and still ~7-in-12 on 2026-08-25),
      // so a failure here is the expected case rather than a fault. Nothing
      // is lost when it happens -- label colors are cosmetic, the last
      // known-good set is already loaded from disk, and the retry below
      // picks up the next success.
      console.warn(
        `MMM-septa: route color metadata refresh failed: ${err.message}; this endpoint is known to fail ` +
          `intermittently -- keeping the cached label colors and retrying in ${SCHEDULE_RETRY_MS / 1000}s.`
      );
      this.routeColorTimer = setTimeout(() => this.refreshRouteColors(), SCHEDULE_RETRY_MS);
    }
  },

  // A configured routeId that doesn't exist (typo, discontinued route, etc)
  // currently fails silently: fetchDetours/fetchTrips just return empty
  // arrays for an unrecognized route_id, so the route shows "--" forever,
  // indistinguishable from a real route that simply has nothing running
  // right now (late night, etc). Unlike an invalid secondaryStopId, there's
  // no misleading display to suppress here -- an unrecognized routeId
  // already degrades to exactly what it would show anyway -- so this only
  // warns, once per refresh (same daily cadence as validateSecondaryStopIds),
  // rather than changing any display behavior.
  //
  // Checked against the static GTFS feed, NOT SEPTA's /routes/ endpoint.
  // /routes/ looks like a route inventory and isn't one: on 2026-08-25 it
  // omitted 13 routes that were running that day (41, 51, 63, 71, 72, 76,
  // 81, 82, B1_OWL, L1_OWL, M1_BUS, MANN, NOR_BUS) while listing 33 ids with
  // no trips in the feed at all. Validating against it warned about a live
  // route 63 with buses reporting GPS at that moment. It stays in use for
  // what it's actually good for -- label colors and is_frequent_bus.
  validateRouteIds() {
    const scheduledRouteIds = getScheduledRouteIds(this.scheduleCache);
    if (!scheduledRouteIds) return; // cache predates the field; nothing to check against
    const known = new Set(scheduledRouteIds);
    for (const state of this.routes.values()) {
      // Routes that opted out of the supplement were never pulled into the
      // cache, so it can't speak to them either way (same skip as
      // validateSecondaryStopIds).
      if (state.useScheduleSupplement === false) continue;
      if (known.has(String(state.config.routeId))) continue;
      console.warn(
        `MMM-septa: routeId ${state.config.routeId} for route ${state.routeKey} has no trips in SEPTA's ` +
          `static GTFS feed -- check for a typo or a discontinued route; it will otherwise just show no ` +
          `arrivals, indistinguishable from a real route with nothing currently running.`
      );
    }
  },

  // Downloads and parses SEPTA's static GTFS feed, filtered down to just the
  // routes/stops currently configured with useScheduleSupplement enabled.
  // Runs once ~60s after startup (well clear of MagicMirror's own startup
  // work), then once every 24h; a failure retries in an hour rather than
  // waiting for the next scheduled day.
  async refreshScheduleCache() {
    const routeIds = new Set();
    const stopIds = new Set();
    for (const state of this.routes.values()) {
      if (state.useScheduleSupplement === false) continue;
      routeIds.add(state.config.routeId);
      stopIds.add(state.config.stopId);
      if (state.config.secondaryStopId) stopIds.add(state.config.secondaryStopId);
    }

    if (routeIds.size === 0) {
      // No routes registered yet (or none want the supplement) -- check
      // again shortly rather than downloading the feed for nothing.
      this.scheduleTimer = setTimeout(() => this.refreshScheduleCache(), SCHEDULE_RETRY_MS);
      return;
    }

    try {
      this.scheduleCache = await fetchScheduleCache([...routeIds], [...stopIds]);
      saveCacheToDisk(this.scheduleCache);
      console.log(`MMM-septa: refreshed GTFS schedule cache (${this.scheduleCache.entries.length} entries)`);
      // SEPTA sometimes publishes a feed whose calendar doesn't cover today
      // (e.g. it has already rolled forward to the next service period, ahead
      // of a schedule change). When that happens the schedule supplement can
      // contribute nothing and the display quietly drops to live-only data --
      // easy to mistake for a broken module -- so warn about it here, once per
      // refresh (not per poll cycle). See gtfs-schedule.js's hasActiveServiceOn.
      if (!hasActiveServiceOn(this.scheduleCache, new Date())) {
        console.warn(
          `MMM-septa: the current GTFS feed has no service active for today -- the schedule supplement is ` +
            `unavailable and only SEPTA's short live-arrival window will show until the feed covers today ` +
            `again (usually a temporary gap around a SEPTA schedule change).`
        );
      }
      this.validateRouteIds();
      this.validateSecondaryStopIds();
      this.validateStopIds();
      this.scheduleTimer = setTimeout(() => this.refreshScheduleCache(), SCHEDULE_REFRESH_MS);
    } catch (err) {
      console.error(`MMM-septa: GTFS schedule refresh failed: ${err.message}; retrying in ${SCHEDULE_RETRY_MS / 1000}s`);
      this.scheduleTimer = setTimeout(() => this.refreshScheduleCache(), SCHEDULE_RETRY_MS);
    }
  },

  // A secondaryStopId that never appears anywhere on its own route (wrong
  // route entirely, a typo, or a nonexistent stop_id) would otherwise make
  // getHeadsignsSkippingStop flag every headsign as skipping it, so every
  // arrival would show up permanently colored orange with no visible sign
  // it's a config mistake rather than a real signal. Checked
  // direction-agnostically (either direction counts) -- direction_id may not
  // even be resolved yet this early, and a stop simply being real on the
  // route at all is enough to rule out this failure mode. Skips routes that
  // opted out of the schedule supplement, since their data was never pulled
  // into the cache in the first place (see refreshScheduleCache).
  //
  // Sets state.secondaryStopIdValid (re-evaluated fresh on every refresh,
  // not latched -- so a config edited between restarts is picked up rather
  // than being stuck on a stale verdict) so runCycle can treat an invalid
  // secondaryStopId as if none were configured at all, rather than leaving
  // every arrival flagged; also logs a warning each time it's found invalid
  // so the misconfiguration is discoverable.
  validateSecondaryStopIds() {
    for (const state of this.routes.values()) {
      if (state.useScheduleSupplement === false) continue;
      if (!state.config.secondaryStopId) continue;
      const headsigns = getAllHeadsignsForStop(this.scheduleCache, state.config.routeId, state.config.secondaryStopId);
      state.secondaryStopIdValid = headsigns.length > 0;
      if (!state.secondaryStopIdValid) {
        console.warn(
          `MMM-septa: secondaryStopId ${state.config.secondaryStopId} for route ${state.routeKey} ` +
            `doesn't appear anywhere on route ${state.config.routeId}'s schedule -- check for a typo or ` +
            `wrong route/stop id; treating it as unconfigured until fixed.`
        );
      }
    }
  },

  // A configured stopId that the route never actually stops at (a typo, a
  // stop on a different route entirely, a stop_id retired in a service
  // change) otherwise just shows no arrivals forever, indistinguishable
  // from a real route with nothing currently running -- and because the
  // stop's name never resolves either, even the stop header above the row
  // silently vanishes. Checked direction-agnostically, same reasoning as
  // validateSecondaryStopIds -- a stop simply being real on the route at
  // all is enough to rule out this failure mode. Skips routes that opted
  // out of the schedule supplement, since their data was never pulled into
  // the cache in the first place (see refreshScheduleCache).
  //
  // Sets state.stopIdValid (re-evaluated fresh on every refresh, not
  // latched -- so a config fixed between restarts is picked up rather than
  // being stuck on a stale verdict), which rides along to the display so it
  // can label the row instead of leaving it looking merely quiet.
  //
  // A merged route entry ("T2,T3,T4,T5") fans out into one registration per
  // sub-routeId, all sharing the one configured stopId, so this same check
  // doubles as the merged-group requirement that every sub-routeId really
  // stops there -- only the warning wording differs, since for a merged
  // entry the likelier mistake is a route that doesn't belong in the list
  // rather than a bad stopId. The display draws the same distinction (see
  // MMM-septa.js's renderMergedRouteRow).
  validateStopIds() {
    for (const state of this.routes.values()) {
      if (state.useScheduleSupplement === false) continue;
      const headsigns = getAllHeadsignsForStop(this.scheduleCache, state.config.routeId, state.config.stopId);
      state.stopIdValid = headsigns.length > 0;
      if (state.stopIdValid) continue;
      if (state.merged) {
        console.warn(
          `MMM-septa: merged route ${state.routeKey} -- routeId ${state.config.routeId} doesn't appear to stop at ` +
            `stopId ${state.config.stopId} anywhere in its schedule -- check your merged routeId list for a typo or ` +
            `a route that doesn't actually share this stop; it will otherwise just show no arrivals, ` +
            `indistinguishable from a real route with nothing currently running.`
        );
      } else {
        console.warn(
          `MMM-septa: stopId ${state.config.stopId} for route ${state.routeKey} doesn't appear anywhere on ` +
            `route ${state.config.routeId}'s schedule -- check for a typo or wrong route/stop id; the row will ` +
            `show "Invalid stop ID configured" until it's fixed.`
        );
      }
    }
  },

  socketNotificationReceived(notification, payload) {
    if (notification !== "SEPTA_CONFIG") return;
    this.registerConfig(payload);
  },

  registerConfig(payload) {
    const { instanceId, routes, refreshIntervalSeconds, retryIntervalSeconds, useScheduleSupplement, scheduleHorizonMinutes } = payload;
    // Clamped/defaulted in route-config.js -- see resolveScheduleHorizonMinutes
    // for which bad values land on the ceiling and which on the default.
    const resolvedHorizon = resolveScheduleHorizonMinutes(scheduleHorizonMinutes);
    // Flattened first, before any state is created, purely so routeStaggerMs
    // knows how many routes it's spreading across. Already-registered routes
    // stay in this list (they're skipped below, not re-registered) so that
    // re-receiving the same SEPTA_CONFIG assigns the same slots.
    const registrations = [];
    for (const route of routes || []) {
      // A merged route entry ("T2,T3,T4,T5") fans out here into N fully
      // independent single-route registrations -- same polling, same
      // detour/secondary-stop handling, same everything as an ordinary
      // route, just repeated per sub-routeId. Merging only ever happens at
      // display time (see MMM-septa.js), so nothing below this point needs
      // to know a route came from a merged entry at all except the two
      // small exceptions marked `merged` (used only by
      // validateStopIds).
      const subRouteIds = parseRouteIds(route.routeId);
      const merged = subRouteIds.length > 1;
      for (const subRouteId of subRouteIds) {
        // A plain string direction applies to every sub-route uniformly; a
        // {routeId: direction} map resolves per sub-route -- see
        // route-config.js's resolveDirectionForRoute for why a merge needs
        // this (a stop_id ambiguous between both directions of a route
        // can't safely fall back to a shared direction_name match unless
        // every sub-route's own direction is known).
        const direction = resolveDirectionForRoute(route.direction, subRouteId);
        const subRoute = { routeId: subRouteId, stopId: route.stopId, direction };
        registrations.push({ route, subRouteId, direction, subRoute, merged, fullKey: `${instanceId}::${routeKey(subRoute)}` });
      }
    }

    registrations.forEach(({ route, subRouteId, direction, subRoute, merged, fullKey }, index) => {
      if (this.routes.has(fullKey)) return; // already polling this route

      const state = {
        config: {
          routeId: subRouteId,
          stopId: route.stopId,
          direction,
          secondaryStopId: route.secondaryStopId,
        },
        merged,
        useScheduleSupplement: useScheduleSupplement !== false,
        scheduleHorizonMinutes: resolvedHorizon,
        instanceId,
        routeKey: routeKey(subRoute),
        refreshIntervalSeconds: refreshIntervalSeconds || 120,
        retryIntervalSeconds: retryIntervalSeconds || 30,
        etas: [],
        detour: false,
        detourReason: null,
        stopName: null,
        directionId: null,
        // null until validateSecondaryStopIds runs (once the schedule cache
        // is available); treated as valid/unconfirmed until then so the
        // feature works as before during that window -- see runCycle.
        secondaryStopIdValid: null,
        // Likewise null until validateStopIds runs -- the display only
        // flags an invalid stopId on a definite false, so the row looks
        // completely normal during the startup window rather than
        // flashing a config error at every restart.
        stopIdValid: null,
        secondaryStopDetour: false,
        secondaryStopName: null,
        direction,
        hasTripError: false,
        // Raw per-cycle failure count, reset to 0 on any success -- hasTripError
        // (sent to the display) only flips on once this hits the threshold below,
        // so an isolated one-cycle blip during a flaky API doesn't flicker the
        // indicator on and off every refresh.
        consecutiveTripErrorCycles: 0,
        lastFetchTime: null,
        timer: null,
        staggerMs: routeStaggerMs(index, registrations.length),
      };
      this.routes.set(fullKey, state);
      this.runCycle(fullKey); // kick off the first fetch immediately
    });
    // No eager routeId validation here. It used to be safe because SEPTA's
    // /routes/ list didn't depend on what was configured, but the GTFS cache
    // that replaced it is scoped to the currently configured routes -- so
    // checking a route before the next refresh has pulled it into the feed
    // would false-positive on every legitimately new one. Deferred to
    // refreshScheduleCache, same as the stop validators.
  },

  // Self-rescheduling setTimeout chain (not setInterval) so a slow cycle
  // never overlaps with the next one, and a failing route backs off to
  // retryIntervalSeconds instead of hammering SEPTA at the full interval.
  // Mirrors lightpi's SeptaRouteUpdater.run() (fetchers.py:255-319).
  async runCycle(fullKey) {
    const state = this.routes.get(fullKey);
    if (!state) return; // route was deregistered (e.g. stop() ran)

    try {
      // Treat an already-confirmed-invalid secondaryStopId (see
      // validateSecondaryStopIds) exactly as if none were configured at all
      // -- rather than passing it through and having every arrival flagged
      // as permanently skipping a stop that isn't even really part of this
      // route. Left as state.config.secondaryStopId (rather than undefined)
      // whenever validity is still unknown (secondaryStopIdValid === null,
      // i.e. before the schedule cache has loaded even once), so the
      // feature works as it always has during that brief startup window.
      const secondaryStopId = state.secondaryStopIdValid === false ? undefined : state.config.secondaryStopId;
      // Most stops are exclusive to one direction_id (a street's two curbs
      // get two different stop_ids) -- when that's true here, it tells
      // pollRoute which direction_id the user's configured stop actually
      // means, with no live direction_name needed at all. Recomputed every
      // cycle rather than cached on state: cheap (a small filter over the
      // schedule cache's already-tiny, pre-filtered entries), and it stays
      // correct across a daily schedule cache refresh for free.
      const stopDirectionIds = this.scheduleCache
        ? getDirectionIdsForStop(this.scheduleCache, state.config.routeId, state.config.stopId)
        : [];
      // A stop genuinely served by both direction_ids (e.g. T1-T5's 13th St
      // tunnel terminus) can still resolve structurally without any live
      // direction_name -- see gtfs-schedule.js's resolveTerminusExclusion --
      // when one direction is uniformly a dead end there (every trip ends,
      // never continues) and the other isn't; falls back to null (the
      // existing direction_name-based matching in septa-client.js) when it
      // doesn't fit that shape, same as before this existed.
      const structuralDirectionId =
        stopDirectionIds.length === 1
          ? stopDirectionIds[0]
          : this.scheduleCache
            ? getTerminusExclusionDirectionId(this.scheduleCache, state.config.routeId, state.config.stopId)
            : null;
      const result = await pollRoute(
        { ...state.config, secondaryStopId },
        { useScheduleSupplement: state.useScheduleSupplement, structuralDirectionId }
      );
      state.detour = result.detour;
      state.detourReason = result.detourReason;
      // stopName is effectively static (a stop's name doesn't change); don't
      // let a cycle where no trips were running (so we couldn't look it up)
      // blank out an already-known value. headsign travels per-arrival
      // inside etas instead, which is always freshly replaced above, so it
      // needs no separate caching here.
      if (result.stopName) state.stopName = result.stopName;
      state.direction = result.direction;
      state.consecutiveTripErrorCycles = result.hasTripError ? state.consecutiveTripErrorCycles + 1 : 0;
      state.hasTripError = state.consecutiveTripErrorCycles >= TRIP_ERROR_DISPLAY_THRESHOLD;
      state.lastFetchTime = result.fetchedAt;
      state.secondaryStopDetour = Boolean(result.secondaryStopDetour);
      // Same "never blank out a known value" caching as stopName above.
      if (result.secondaryStopName) state.secondaryStopName = result.secondaryStopName;
      // Resolved from live data (see pollRoute) once any trip matching this
      // route's configured direction has been seen -- needed to filter the
      // GTFS schedule cache to just this direction, since a stop_id can
      // rarely (but really) be served by both directions of the same
      // route, and the static schedule alone has no direction_name to
      // check against, only a bare direction_id.
      if (result.directionId != null) state.directionId = result.directionId;

      // Live data only reveals a stop's name via a trip that actually passes
      // through it -- a secondary stop that every currently-running headsign
      // structurally skips might never resolve that way. The schedule
      // cache's stopNames (see gtfs-schedule.js's buildScheduleCache) covers
      // every configured stop regardless of what's running right now, so use
      // it as a fallback once live data has had its chance.
      if (!state.stopName && this.scheduleCache && this.scheduleCache.stopNames) {
        const scheduleName = this.scheduleCache.stopNames[String(state.config.stopId)];
        if (scheduleName) state.stopName = scheduleName;
      }
      if (!state.secondaryStopName && secondaryStopId && this.scheduleCache && this.scheduleCache.stopNames) {
        const scheduleName = this.scheduleCache.stopNames[String(secondaryStopId)];
        if (scheduleName) state.secondaryStopName = scheduleName;
      }

      // A detour means SEPTA is actively skipping this stop -- the static
      // schedule has no idea and would just show phantom arrivals, so only
      // merge in the schedule supplement when there's no detour in effect.
      if (state.useScheduleSupplement && this.scheduleCache && !result.detour) {
        const scheduled = getScheduledArrivals(
          this.scheduleCache,
          state.config.routeId,
          state.config.stopId,
          new Date(),
          state.scheduleHorizonMinutes,
          state.directionId
        );
        state.etas = mergeScheduledArrivals(result.etas, scheduled);
      } else {
        state.etas = result.etas;
      }

      // Whether the schedule supplement is expected but the static feed
      // doesn't cover today at all (see gtfs-schedule.js's hasActiveServiceOn)
      // -- the frontend surfaces a single "live data only" note when true. Only
      // meaningful for a route actually using the supplement, once the cache
      // has loaded (before that it's a plain startup gap, not a feed problem).
      const scheduleUnavailable =
        state.useScheduleSupplement &&
        Boolean(this.scheduleCache) &&
        !hasActiveServiceOn(this.scheduleCache, new Date());

      // A stable order for footnote-marker assignment (see MMM-septa.js's
      // septaGroupByDestination) -- every headsign this route/stop is ever
      // scheduled to see, not just whichever trips happen to be next right
      // now, so a given destination's marker doesn't change as different
      // trips rotate through.
      const headsignOrder = this.scheduleCache
        ? getAllHeadsignsForStop(this.scheduleCache, state.config.routeId, state.config.stopId, state.directionId)
        : [];

      // Structural (schedule-based) secondary-stop skip: headsigns whose
      // pattern never reaches the secondary stop, regardless of any detour.
      // See septa-client.js's pollRoute for the separate, live detour-based
      // check (state.secondaryStopDetour above).
      const secondaryStopSkippedHeadsigns =
        secondaryStopId && this.scheduleCache
          ? getHeadsignsSkippingStop(
              this.scheduleCache,
              state.config.routeId,
              state.config.stopId,
              secondaryStopId,
              state.directionId
            )
          : [];

      this.sendSocketNotification("SEPTA_UPDATE", {
        instanceId: state.instanceId,
        routeKey: state.routeKey,
        etas: state.etas,
        detour: state.detour,
        detourReason: state.detourReason,
        stopName: state.stopName,
        direction: state.direction,
        hasTripError: state.hasTripError,
        stopIdValid: state.stopIdValid,
        lastFetchTime: state.lastFetchTime,
        refreshIntervalSeconds: state.refreshIntervalSeconds,
        headsignOrder,
        secondaryStopDetour: state.secondaryStopDetour,
        secondaryStopName: state.secondaryStopName,
        secondaryStopSkippedHeadsigns,
        routeColor: this.routeColors[state.config.routeId] || null,
        scheduleUnavailable,
      });

      // Success re-schedules onto the shared grid (offset by this route's own
      // stagger slot); the very first cycle after registration runs
      // immediately and off-grid, so this is where a route snaps into place --
      // always by shortening its next wait, never lengthening it.
      state.timer = setTimeout(
        () => this.runCycle(fullKey),
        alignedDelayMs(Date.now(), state.refreshIntervalSeconds, state.staggerMs)
      );
    } catch (err) {
      console.error(
        `MMM-septa: route ${state.routeKey} fetch failed: ${err.message}; retrying in ${state.retryIntervalSeconds}s`
      );
      // Deliberately *not* grid-aligned: a failing route should retry on its
      // own short backoff and recover as soon as it can, rather than waiting
      // out the rest of a slot it isn't currently earning. It rejoins the grid
      // on its next success, via the aligned path above.
      state.timer = setTimeout(() => this.runCycle(fullKey), state.retryIntervalSeconds * 1000);
    }
  },
});
