"use strict";

const NodeHelper = require("node_helper");
const { pollRoute, mergeScheduledArrivals } = require("./septa-client.js");
const { fetchScheduleCache, getScheduledArrivals, loadCacheFromDisk, saveCacheToDisk } = require("./gtfs-schedule.js");

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
  },

  stop() {
    for (const state of this.routes.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.routes.clear();
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
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
      this.scheduleTimer = setTimeout(() => this.refreshScheduleCache(), SCHEDULE_REFRESH_MS);
    } catch (err) {
      console.error(`MMM-septa: GTFS schedule refresh failed: ${err.message}; retrying in ${SCHEDULE_RETRY_MS / 1000}s`);
      this.scheduleTimer = setTimeout(() => this.refreshScheduleCache(), SCHEDULE_RETRY_MS);
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
        config: { routeId: route.routeId, stopId: route.stopId, direction: route.direction },
        useScheduleSupplement: useScheduleSupplement !== false,
        instanceId,
        routeKey: routeKey(route),
        refreshIntervalSeconds: refreshIntervalSeconds || 120,
        retryIntervalSeconds: retryIntervalSeconds || 30,
        etas: [],
        detour: false,
        detourReason: null,
        stopName: null,
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
      const result = await pollRoute(state.config, { useScheduleSupplement: state.useScheduleSupplement });
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

      // A detour means SEPTA is actively skipping this stop -- the static
      // schedule has no idea and would just show phantom arrivals, so only
      // merge in the schedule supplement when there's no detour in effect.
      if (state.useScheduleSupplement && this.scheduleCache && !result.detour) {
        const scheduled = getScheduledArrivals(
          this.scheduleCache,
          state.config.routeId,
          state.config.stopId,
          new Date(),
          SCHEDULE_HORIZON_MINUTES
        );
        state.etas = mergeScheduledArrivals(result.etas, scheduled);
      } else {
        state.etas = result.etas;
      }

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
