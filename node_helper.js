"use strict";

const NodeHelper = require("node_helper");
const { pollRoute } = require("./septa-client.js");

function routeKey(route) {
  return `${route.routeId}:${route.stopId}:${route.direction}`;
}

module.exports = NodeHelper.create({
  start() {
    // fullKey -> RouteState. Only one node_helper instance exists even with
    // multiple MMM-septa instances on screen, so state is keyed by
    // instanceId + route to keep every instance's routes independent.
    this.routes = new Map();
  },

  stop() {
    for (const state of this.routes.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.routes.clear();
  },

  socketNotificationReceived(notification, payload) {
    if (notification !== "SEPTA_CONFIG") return;
    this.registerConfig(payload);
  },

  registerConfig(payload) {
    const { instanceId, routes, refreshIntervalSeconds, retryIntervalSeconds } = payload;
    for (const route of routes || []) {
      const fullKey = `${instanceId}::${routeKey(route)}`;
      if (this.routes.has(fullKey)) continue; // already polling this route

      const state = {
        config: { routeId: route.routeId, stopId: route.stopId, direction: route.direction },
        instanceId,
        routeKey: routeKey(route),
        refreshIntervalSeconds: refreshIntervalSeconds || 120,
        retryIntervalSeconds: retryIntervalSeconds || 30,
        etas: [],
        detour: false,
        detourReason: null,
        headsign: null,
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
      const result = await pollRoute(state.config);
      state.etas = result.etas;
      state.detour = result.detour;
      state.detourReason = result.detourReason;
      // headsign/stopName are effectively static (a route's destination and
      // a stop's name don't change); don't let a cycle where no trips were
      // running (so we couldn't look them up) blank out an already-known
      // value.
      if (result.headsign) state.headsign = result.headsign;
      if (result.stopName) state.stopName = result.stopName;
      state.direction = result.direction;
      state.hasTripError = result.hasTripError;
      state.lastFetchTime = result.fetchedAt;

      this.sendSocketNotification("SEPTA_UPDATE", {
        instanceId: state.instanceId,
        routeKey: state.routeKey,
        etas: state.etas,
        detour: state.detour,
        detourReason: state.detourReason,
        headsign: state.headsign,
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
