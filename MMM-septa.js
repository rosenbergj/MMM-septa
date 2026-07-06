/* global Module */
"use strict";

// Frontend module: renders upcoming SEPTA bus arrivals for a configured list
// of routes/stops. All the actual SEPTA polling happens in node_helper.js;
// this file only renders whatever it was last told and re-renders the "N
// min" countdowns client-side between polls (no extra backend calls needed
// just to tick a countdown down).

function septaRouteKey(route) {
  return `${route.routeId}:${route.stopId}:${route.direction}`;
}

function septaIsFresh(lastFetchTime, refreshIntervalSeconds, now) {
  if (lastFetchTime == null) return false;
  return (now - lastFetchTime) / 1000 <= refreshIntervalSeconds * 3;
}

function septaMinutesUntil(etaSeconds, nowMs) {
  return Math.max(0, Math.round((etaSeconds * 1000 - nowMs) / 60000));
}

Module.register("MMM-septa", {
  defaults: {
    routes: [], // [{ routeId, stopId, direction, label }]
    maxArrivals: 3,
    refreshIntervalSeconds: 120, // how often node_helper actually polls SEPTA
    retryIntervalSeconds: 30, // backoff after a failed poll
    warnMinutes: 5, // arrivals at/under this get the "urgent" style
    countdownTickSeconds: 15, // client-side re-render cadence, no network
    animationSpeed: 1000,
  },

  start() {
    this.routeStates = {}; // routeKey -> latest SEPTA_UPDATE payload

    this.sendSocketNotification("SEPTA_CONFIG", {
      instanceId: this.identifier,
      routes: this.config.routes,
      refreshIntervalSeconds: this.config.refreshIntervalSeconds,
      retryIntervalSeconds: this.config.retryIntervalSeconds,
    });

    setInterval(() => {
      this.updateDom(this.config.animationSpeed);
    }, this.config.countdownTickSeconds * 1000);
  },

  getStyles() {
    // MagicMirror's loader only prefixes the module's own path onto
    // getStyles() entries that DON'T contain a "/" (see loader.js
    // loadFileForModule) -- a slash makes it treat the string as an
    // already-resolved path instead. Since our CSS lives in a css/
    // subfolder, resolve it ourselves via this.file() first.
    return [this.file("css/MMM-septa.css")];
  },

  socketNotificationReceived(notification, payload) {
    if (notification !== "SEPTA_UPDATE") return;
    if (payload.instanceId !== this.identifier) return;
    this.routeStates[payload.routeKey] = payload;
    this.updateDom(this.config.animationSpeed);
  },

  getDom() {
    const wrapper = document.createElement("table");
    wrapper.className = "small septa-table";

    if (!this.config.routes || this.config.routes.length === 0) {
      wrapper.innerHTML = "MMM-septa: no routes configured.";
      return wrapper;
    }

    const now = Date.now();

    for (const route of this.config.routes) {
      const state = this.routeStates[septaRouteKey(route)];
      const row = document.createElement("tr");
      row.className = "septa-row";

      const labelCell = document.createElement("td");
      labelCell.className = "septa-label";
      labelCell.innerHTML = route.label || route.routeId;
      row.appendChild(labelCell);

      const arrivalsCell = document.createElement("td");
      arrivalsCell.className = "septa-arrivals";

      if (!state) {
        arrivalsCell.innerHTML = "&hellip;";
      } else {
        const fresh = septaIsFresh(state.lastFetchTime, state.refreshIntervalSeconds, now);
        if (!fresh) row.className += " septa-stale";

        if (state.detour) {
          arrivalsCell.classList.add("septa-detour");
          arrivalsCell.innerHTML = "DETOUR";
        } else if (!state.etas || state.etas.length === 0) {
          arrivalsCell.innerHTML = "&ndash;&ndash;";
        } else {
          arrivalsCell.innerHTML = state.etas
            .slice(0, this.config.maxArrivals)
            .map((eta) => {
              const minutes = septaMinutesUntil(eta, now);
              const cls = minutes <= this.config.warnMinutes ? "septa-urgent" : "septa-normal";
              return `<span class="${cls}">${minutes}m</span>`;
            })
            .join(" ");
        }

        if (state.hasTripError) {
          const warn = document.createElement("span");
          warn.className = "septa-partial";
          warn.title = "Some trip data failed to load this cycle";
          warn.innerHTML = " !";
          arrivalsCell.appendChild(warn);
        }
      }

      row.appendChild(arrivalsCell);
      wrapper.appendChild(row);
    }

    return wrapper;
  },
});
