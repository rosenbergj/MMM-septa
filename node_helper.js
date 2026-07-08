"use strict";

const NodeHelper = require("node_helper");
const { pollRoute, mergeScheduledArrivals, fetchRoutes, resolveRouteLabelColor } = require("./septa-client.js");
const {
  fetchScheduleCache,
  getScheduledArrivals,
  getAllHeadsignsForStop,
  getHeadsignsSkippingStop,
  loadCacheFromDisk,
  saveCacheToDisk,
} = require("./gtfs-schedule.js");

const SCHEDULE_HORIZON_MINUTES = 60;
const SCHEDULE_INITIAL_DELAY_MS = 60 * 1000; // wait until well after MagicMirror's own startup
const SCHEDULE_REFRESH_MS = 24 * 60 * 60 * 1000; // once daily thereafter
const SCHEDULE_RETRY_MS = 60 * 60 * 1000; // retry sooner than a full day if a refresh fails

function routeKey(route) {
  return `${route.routeId}:${route.stopId}:${route.direction}`;
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
    // routeId -> hex color string, or null for "no override". Empty until
    // the first refresh completes -- unlike the GTFS schedule cache, this is
    // a single small JSON request (every route in one response, no
    // per-route or per-stop filtering to do), so it's not worth persisting
    // to disk or delaying behind SCHEDULE_INITIAL_DELAY_MS the way the
    // multi-MB GTFS zip download is.
    this.routeColors = {};
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
      console.log(`MMM-septa: refreshed route color metadata (${routes.length} routes)`);
      this.routeColorTimer = setTimeout(() => this.refreshRouteColors(), SCHEDULE_REFRESH_MS);
    } catch (err) {
      console.error(`MMM-septa: route color metadata refresh failed: ${err.message}; retrying in ${SCHEDULE_RETRY_MS / 1000}s`);
      this.routeColorTimer = setTimeout(() => this.refreshRouteColors(), SCHEDULE_RETRY_MS);
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
      this.validateSecondaryStopIds();
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

  socketNotificationReceived(notification, payload) {
    if (notification !== "SEPTA_CONFIG") return;
    this.registerConfig(payload);
  },

  registerConfig(payload) {
    const { instanceId, routes, refreshIntervalSeconds, retryIntervalSeconds, useScheduleSupplement } = payload;
    for (const route of routes || []) {
      const fullKey = `${instanceId}::${routeKey(route)}`;
      if (this.routes.has(fullKey)) continue; // already polling this route

      const state = {
        config: {
          routeId: route.routeId,
          stopId: route.stopId,
          direction: route.direction,
          secondaryStopId: route.secondaryStopId,
        },
        useScheduleSupplement: useScheduleSupplement !== false,
        instanceId,
        routeKey: routeKey(route),
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
        secondaryStopDetour: false,
        secondaryStopName: null,
        direction: route.direction,
        hasTripError: false,
        lastFetchTime: null,
        timer: null,
      };
      this.routes.set(fullKey, state);
      this.runCycle(fullKey); // kick off the first fetch immediately
    }
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
      const result = await pollRoute(
        { ...state.config, secondaryStopId },
        { useScheduleSupplement: state.useScheduleSupplement }
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
      state.hasTripError = result.hasTripError;
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
          SCHEDULE_HORIZON_MINUTES,
          state.directionId
        );
        state.etas = mergeScheduledArrivals(result.etas, scheduled);
      } else {
        state.etas = result.etas;
      }

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
        lastFetchTime: state.lastFetchTime,
        refreshIntervalSeconds: state.refreshIntervalSeconds,
        headsignOrder,
        secondaryStopDetour: state.secondaryStopDetour,
        secondaryStopName: state.secondaryStopName,
        secondaryStopSkippedHeadsigns,
        routeColor: this.routeColors[state.config.routeId] || null,
      });

      state.timer = setTimeout(() => this.runCycle(fullKey), state.refreshIntervalSeconds * 1000);
    } catch (err) {
      console.error(
        `MMM-septa: route ${state.routeKey} fetch failed: ${err.message}; retrying in ${state.retryIntervalSeconds}s`
      );
      state.timer = setTimeout(() => this.runCycle(fullKey), state.retryIntervalSeconds * 1000);
    }
  },
});
