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
//
// headsignOrder (from node_helper, derived from the full day's schedule --
// see gtfs-schedule.js's getAllHeadsignsForStop) fixes which marker goes
// with which destination, so it doesn't change from one poll to the next
// just because a different trip happens to be next. Any shown headsign not
// in that list (schedule cache not loaded yet, or a genuine off-schedule
// trip) is appended after it, in first-seen order, so nothing is dropped.
function septaGroupByDestination(arrivals, headsignOrder) {
  if (!Array.isArray(arrivals) || arrivals.length === 0) return { mixed: false, headsign: null };
  const shown = new Set();
  for (const arrival of arrivals) shown.add(arrival.headsign);
  if (shown.size <= 1) return { mixed: false, headsign: arrivals[0].headsign || null };

  const order = [];
  if (Array.isArray(headsignOrder)) {
    for (const headsign of headsignOrder) {
      if (shown.has(headsign)) order.push(headsign);
    }
  }
  for (const arrival of arrivals) {
    if (arrival.headsign && !order.includes(arrival.headsign)) order.push(arrival.headsign);
  }

  const markerFor = new Map(order.map((headsign, index) => [headsign, septaFootnoteMarker(index)]));
  return { mixed: true, markerFor, order };
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
    routes: [], // [{ routeId, stopId, direction, label, warnMinutes }] -- warnMinutes is optional, overrides the global value below
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
      const destinationInfo = septaGroupByDestination(shownArrivals, state && state.headsignOrder);
      // secondaryStopId (route config): headsigns that structurally never
      // reach it come from the static schedule (secondaryStopSkippedHeadsigns);
      // an active detour skipping it applies route-wide regardless of
      // headsign (secondaryStopDetour). Both default to "no effect" when the
      // route has no secondaryStopId configured or state hasn't arrived yet.
      const secondaryStopSkippedHeadsigns = (state && state.secondaryStopSkippedHeadsigns) || [];
      const secondaryStopDetour = Boolean(state && state.secondaryStopDetour);
      const secondaryStopDisplayName =
        (state && state.secondaryStopName) || (route.secondaryStopId != null ? String(route.secondaryStopId) : "");
      // Per-route warnMinutes overrides the global config value, which in
      // turn overrides the module default -- MagicMirror already merges
      // the global-vs-default step via this.config, so only the route-level
      // override needs handling here.
      const warnMinutes = typeof route.warnMinutes === "number" ? route.warnMinutes : this.config.warnMinutes;

      const labelCell = document.createElement("td");
      labelCell.className = "septa-label";
      const labelMain = document.createElement("div");
      labelMain.className = "septa-label-main";
      const abbrev = septaAbbreviateDirection(route.direction);
      labelMain.innerHTML = `${route.label || route.routeId} <span class="septa-direction-abbrev">${abbrev}</span>`;
      labelCell.appendChild(labelMain);
      // Every destination line -- whether there's one or several, flagged
      // or not -- always renders as a full-width colspan=2 row below the
      // route (appended after this route's main row, same pattern as the
      // stop-name header row above), never stacked in the narrow label
      // column. That's true even for a single, unflagged destination: a
      // long headsign name or a flagged neighbor elsewhere in the table
      // would otherwise still stretch that shared column for every row, and
      // keeping the rule unconditional means there's no special case where
      // a destination's location (label column vs. below) depends on
      // whether *anything* happens to be flagged.
      const fullWidthRows = [];
      if (destinationInfo.mixed) {
        for (const headsign of destinationInfo.order) {
          const marker = destinationInfo.markerFor.get(headsign);
          const line = `&rarr; ${septaEscapeHtml(headsign)}(${marker})`;
          const flagged = secondaryStopSkippedHeadsigns.includes(headsign);
          fullWidthRows.push({
            flagged,
            html: flagged ? `${line} (no stop at ${septaEscapeHtml(secondaryStopDisplayName)})` : line,
          });
        }
      } else if (destinationInfo.headsign) {
        const line = `&rarr; ${septaEscapeHtml(destinationInfo.headsign)}`;
        const flagged = secondaryStopSkippedHeadsigns.includes(destinationInfo.headsign);
        fullWidthRows.push({
          flagged,
          html: flagged ? `${line} (no stop at ${septaEscapeHtml(secondaryStopDisplayName)})` : line,
        });
      }
      if (secondaryStopDetour && shownArrivals.length > 0) {
        fullWidthRows.push({
          flagged: true,
          html: `Detour skips stop at ${septaEscapeHtml(secondaryStopDisplayName)}`,
        });
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
          // A bare space between entries reads as visually ambiguous once
          // there's more than one, especially with mixed countdown-/clock-
          // style formatting (e.g. "6m 20m 2:55pm"). Comma-separate
          // whenever there's more than one, tracked or not.
          const separator = shownArrivals.length > 1 ? ", " : " ";
          arrivalsCell.innerHTML = shownArrivals
            .map((arrival, index) => {
              const minutes = septaMinutesUntil(arrival.eta, now);
              // Arrivals that skip the secondary stop -- via an active
              // detour, via this specific trip's own live stop_times (ground
              // truth, when known -- see septa-client.js's tripReachesStop;
              // some headsigns cover more than one physical pattern, e.g.
              // route 17's "Broad-Pattison" is both a normal trip and a much
              // longer weekend Navy Yard extension, so this is checked per
              // trip rather than trusting the headsign alone), or otherwise
              // via the headsign-level static-schedule fallback -- read as
              // orange instead of red/green urgency. Untracked ("~")
              // arrivals keep their existing tilde/italic/opacity treatment
              // (added via untrackedClass below) on top of this color.
              const skipsSecondaryStop =
                secondaryStopDetour ||
                arrival.reachesSecondaryStop === false ||
                (arrival.reachesSecondaryStop == null && secondaryStopSkippedHeadsigns.includes(arrival.headsign));
              const urgencyClass = skipsSecondaryStop
                ? "septa-secondary-skip"
                : minutes <= warnMinutes
                  ? "septa-urgent"
                  : "septa-normal";
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

      for (const entry of fullWidthRows) {
        const entryRow = document.createElement("tr");
        const entryCell = document.createElement("td");
        entryCell.className = entry.flagged ? "septa-full-width septa-secondary-skip" : "septa-full-width";
        entryCell.colSpan = 2;
        entryCell.innerHTML = entry.html;
        entryRow.appendChild(entryCell);
        wrapper.appendChild(entryRow);
      }
    }

    return wrapper;
  },
});
