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

// Classic footnote marker sequence; falls back to "[N]" past the sixth
// distinct destination (never expected given maxArrivals defaults to 3).
const FOOTNOTE_MARKERS = ["*", "†", "‡", "§", "‖", "¶"];
function septaFootnoteMarker(index) {
  return FOOTNOTE_MARKERS[index] || `[${index + 1}]`;
}

// Groups shown arrivals by destination. With 0 or 1 distinct headsign among
// them, returns { mixed: false, headsign } (headsign may be null if none is
// known yet) -- rendered as a single "-> Destination" line, no per-arrival
// markers. With 2+ distinct headsigns, returns { mixed: true, markerFor,
// order } so each arrival's time can carry its own footnote marker and the
// label-sub line can list every destination alongside its marker instead of
// a vague "Mixed destinations".
function septaGroupByDestination(arrivals) {
  if (!Array.isArray(arrivals) || arrivals.length === 0) return { mixed: false, headsign: null };
  const distinct = [];
  for (const arrival of arrivals) {
    if (!distinct.includes(arrival.headsign)) distinct.push(arrival.headsign);
  }
  if (distinct.length <= 1) return { mixed: false, headsign: distinct[0] || null };

  const known = distinct.filter(Boolean);
  const markerFor = new Map(known.map((headsign, index) => [headsign, septaFootnoteMarker(index)]));
  return { mixed: true, markerFor, order: known };
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
    // Supplement live-tracked arrivals with SEPTA trips it hasn't started
    // GPS-tracking yet (and, later, static-schedule arrivals) instead of
    // showing only fully GPS-confirmed buses.
    useScheduleSupplement: true,
  },

  start() {
    this.routeStates = {}; // routeKey -> latest SEPTA_UPDATE payload

    this.sendSocketNotification("SEPTA_CONFIG", {
      instanceId: this.identifier,
      routes: this.config.routes,
      refreshIntervalSeconds: this.config.refreshIntervalSeconds,
      retryIntervalSeconds: this.config.retryIntervalSeconds,
      useScheduleSupplement: this.config.useScheduleSupplement,
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

      const stopName = state && state.stopName;
      if (stopName) {
        const headerRow = document.createElement("tr");
        const headerCell = document.createElement("td");
        headerCell.className = "septa-stop-header";
        headerCell.colSpan = 2;
        headerCell.innerHTML = septaEscapeHtml(stopName);
        headerRow.appendChild(headerCell);
        wrapper.appendChild(headerRow);
      }

      const row = document.createElement("tr");
      row.className = "septa-row";

      const shownArrivals = state && Array.isArray(state.etas) ? state.etas.slice(0, this.config.maxArrivals) : [];
      const destinationInfo = septaGroupByDestination(shownArrivals);

      const labelCell = document.createElement("td");
      labelCell.className = "septa-label";
      const labelMain = document.createElement("div");
      labelMain.className = "septa-label-main";
      const abbrev = septaAbbreviateDirection(route.direction);
      labelMain.innerHTML = `${route.label || route.routeId} <span class="septa-direction-abbrev">${abbrev}</span>`;
      labelCell.appendChild(labelMain);
      if (destinationInfo.mixed) {
        const labelSub = document.createElement("div");
        labelSub.className = "septa-label-sub";
        const parts = destinationInfo.order.map(
          (headsign) => `${septaEscapeHtml(headsign)}(${destinationInfo.markerFor.get(headsign)})`
        );
        labelSub.innerHTML = `&rarr; ${parts.join(", ")}`;
        labelCell.appendChild(labelSub);
      } else if (destinationInfo.headsign) {
        const labelSub = document.createElement("div");
        labelSub.className = "septa-label-sub";
        labelSub.innerHTML = `&rarr; ${septaEscapeHtml(destinationInfo.headsign)}`;
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
          // With any untracked (italic/"~") arrival in the same row, a bare
          // space between entries reads as visually ambiguous -- especially
          // once countdown- and clock-style entries mix (e.g.
          // "6m ~20m ~2:55pm"). A comma makes each entry's boundary clear.
          const hasUntracked = shownArrivals.some((arrival) => arrival.tracked === false);
          const separator = hasUntracked ? ", " : " ";
          arrivalsCell.innerHTML = shownArrivals
            .map((arrival, index) => {
              const minutes = septaMinutesUntil(arrival.eta, now);
              const urgencyClass = minutes <= this.config.warnMinutes ? "septa-urgent" : "septa-normal";
              // Bold is reserved for a genuinely confirmed "next bus" --
              // the first shown arrival only earns it if it's tracked, not
              // just because it's chronologically first. An all-untracked
              // row has no bold entry at all rather than overstating
              // confidence in a guess.
              const tierClass = index === 0 && arrival.tracked !== false ? "septa-first" : "septa-later";
              const untrackedClass = arrival.tracked === false ? " septa-untracked" : "";
              const prefix = arrival.tracked === false ? "~" : "";
              const text =
                minutes <= this.config.countdownWithinMinutes ? `${minutes}m` : septaFormatClockTime(arrival.eta);
              const marker =
                destinationInfo.mixed && destinationInfo.markerFor.has(arrival.headsign)
                  ? destinationInfo.markerFor.get(arrival.headsign)
                  : "";
              return `<span class="${urgencyClass} ${tierClass}${untrackedClass}">${prefix}${text}${marker}</span>`;
            })
            .join(separator);
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
