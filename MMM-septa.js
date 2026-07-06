/* global Module, config */
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

// detourReason/stopName/headsign come from SEPTA's API, not our own config,
// so escape them before dropping them into innerHTML.
function septaEscapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// null if there are no arrivals or any arrival is missing a headsign;
// "Mixed destinations" if the shown arrivals don't all share one; otherwise
// the shared headsign itself.
function septaCommonHeadsign(arrivals) {
  if (!Array.isArray(arrivals) || arrivals.length === 0) return null;
  const first = arrivals[0].headsign;
  if (!first) return null;
  return arrivals.every((arrival) => arrival.headsign === first) ? first : "Mixed destinations";
}

// "Northbound" -> "NB", "Southbound" -> "SB", etc; falls back to the
// original string for anything that doesn't fit the "___bound" pattern.
function septaAbbreviateDirection(direction) {
  if (typeof direction !== "string") return "";
  const match = /^(.)\S*bound$/i.exec(direction.trim());
  return match ? `${match[1].toUpperCase()}B` : direction;
}

// Beyond countdownWithinMinutes, a clock time ("5:47 PM") is more useful than
// a big minute count; respects the mirror's global 12h/24h config.timeFormat
// if present (falls back to the browser's locale default otherwise).
function septaFormatClockTime(etaSeconds) {
  const timeFormat = typeof config !== "undefined" ? config.timeFormat : undefined;
  const hour12 = timeFormat === 24 ? false : timeFormat === 12 ? true : undefined;
  return new Date(etaSeconds * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12 });
}

Module.register("MMM-septa", {
  defaults: {
    routes: [], // [{ routeId, stopId, direction, label }]
    maxArrivals: 3,
    refreshIntervalSeconds: 120, // how often node_helper actually polls SEPTA
    retryIntervalSeconds: 30, // backoff after a failed poll
    warnMinutes: 5, // arrivals at/under this get the "urgent" style
    countdownWithinMinutes: 30, // arrivals at/under this show "N min"; farther out show clock time
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

  getHeader() {
    // Falls back to "SEPTA tracking" unless the user set their own `header`
    // on this module's entry in config.js.
    return this.data.header || "SEPTA tracking";
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

      const headerRow = document.createElement("tr");
      const headerCell = document.createElement("td");
      headerCell.className = "septa-stop-header";
      headerCell.colSpan = 2;
      const abbrev = septaAbbreviateDirection(route.direction);
      const stopName = state && state.stopName;
      headerCell.innerHTML = stopName ? `${abbrev} &middot; ${septaEscapeHtml(stopName)}` : abbrev;
      headerRow.appendChild(headerCell);
      wrapper.appendChild(headerRow);

      const row = document.createElement("tr");
      row.className = "septa-row";

      const shownArrivals = state && Array.isArray(state.etas) ? state.etas.slice(0, this.config.maxArrivals) : [];
      const commonHeadsign = septaCommonHeadsign(shownArrivals);

      const labelCell = document.createElement("td");
      labelCell.className = "septa-label";
      const labelMain = document.createElement("div");
      labelMain.className = "septa-label-main";
      labelMain.innerHTML = route.label || route.routeId;
      labelCell.appendChild(labelMain);
      if (commonHeadsign) {
        const labelSub = document.createElement("div");
        labelSub.className = "septa-label-sub";
        labelSub.innerHTML =
          commonHeadsign === "Mixed destinations" ? commonHeadsign : `&rarr; ${septaEscapeHtml(commonHeadsign)}`;
        labelCell.appendChild(labelSub);
      }
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
          arrivalsCell.innerHTML = state.detourReason ? `DETOUR: ${septaEscapeHtml(state.detourReason)}` : "DETOUR";
        } else if (shownArrivals.length === 0) {
          arrivalsCell.innerHTML = "&ndash;&ndash;";
        } else {
          arrivalsCell.innerHTML = shownArrivals
            .map((arrival, index) => {
              const minutes = septaMinutesUntil(arrival.eta, now);
              const urgencyClass = minutes <= this.config.warnMinutes ? "septa-urgent" : "septa-normal";
              const tierClass = index === 0 ? "septa-first" : "septa-later";
              const text =
                minutes <= this.config.countdownWithinMinutes ? `${minutes}m` : septaFormatClockTime(arrival.eta);
              return `<span class="${urgencyClass} ${tierClass}">${text}</span>`;
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
