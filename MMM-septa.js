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
const FOOTNOTE_MARKERS = ["*", "†", "‡", "§", "¶", "‖"];
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
// headsignOrder (from node_helper, derived from the full day's schedule,
// most-frequently-scheduled headsign first -- see gtfs-schedule.js's
// getAllHeadsignsForStop) fixes which marker goes with which destination.
// Markers are assigned from headsignOrder's full, fixed positions --
// unfiltered by which headsigns happen to be shown this cycle -- so a given
// destination's marker never shifts depending on which *other* headsigns
// happen to be showing alongside it right now (a route with 3+ headsigns
// and a small maxArrivals window routinely shows a different subset from
// one poll to the next). `order` (the shown subset, in that same fixed
// sequence) is what the caller should actually iterate to print destination
// lines, so print order matches marker order too. allArrivals is the full
// pre-maxArrivals-cutoff pool (not just what's shown), so an off-schedule
// headsign missing from headsignOrder entirely -- schedule cache not loaded
// yet, or a genuine off-schedule trip -- still gets a slot that doesn't
// depend on the slice either, appended after the schedule-known ones in
// first-seen order.
function septaGroupByDestination(shownArrivals, allArrivals, headsignOrder) {
  if (!Array.isArray(shownArrivals) || shownArrivals.length === 0) return { mixed: false, headsign: null };
  const shown = new Set();
  for (const arrival of shownArrivals) shown.add(arrival.headsign);
  if (shown.size <= 1) return { mixed: false, headsign: shownArrivals[0].headsign || null };

  const fullOrder = Array.isArray(headsignOrder) ? [...headsignOrder] : [];
  for (const arrival of allArrivals) {
    if (arrival.headsign && !fullOrder.includes(arrival.headsign)) fullOrder.push(arrival.headsign);
  }

  const markerFor = new Map(fullOrder.map((headsign, index) => [headsign, septaFootnoteMarker(index)]));
  const order = fullOrder.filter((headsign) => shown.has(headsign));
  return { mixed: true, markerFor, order };
}

// "Northbound" -> "NB", "Southbound" -> "SB", etc; falls back to the
// original string for anything that doesn't fit the "___bound" pattern.
function septaAbbreviateDirection(direction) {
  if (typeof direction !== "string") return "";
  const match = /^(.)\S*bound$/i.exec(direction.trim());
  return match ? `${match[1].toUpperCase()}B` : direction;
}

// route-config.js's parseRouteIds/resolveDirectionForRoute, reimplemented
// here rather than shared: this file runs in the browser (MagicMirror loads
// it as a plain <script>, no require()), while route-config.js is a
// Node-only CommonJS module used by node_helper.js. Both copies are
// intentionally tiny (a handful of lines) and kept in sync by hand.
//
// Splits a configured routeId into the list of route_ids it actually means
// -- a comma-separated string ("T2,T3,T4,T5") is the primary, documented
// merged-route syntax, a bare JSON array an undocumented equivalent. A
// single, unmerged routeId ("17") still comes back as a one-element array.
function septaParseRouteIds(routeId) {
  if (Array.isArray(routeId)) return routeId.map(String);
  return String(routeId)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

// Resolves the configured `direction` for one sub-routeId of a (possibly
// merged) route entry -- a plain string applies to every sub-route
// uniformly, a {routeId: directionString} map resolves per sub-route (see
// README's "Merging routes" section for why a merge sometimes needs this).
function septaResolveDirectionForRoute(direction, routeId) {
  if (direction && typeof direction === "object" && !Array.isArray(direction)) {
    return direction[routeId];
  }
  return direction;
}

// SEPTA Metro (its branding for every rail/subway-el/trolley line -- the
// Broad Street Line, Market-Frankford Line, Norristown High-Speed Line, and
// every trolley) always uses a route_id of one letter (L/G/B/T/D/M) followed
// by a digit; an ordinary bus route_id is bare digits with no letter at
// all. A merged row shows "METRO" if any of its sub-routes matches that
// shape, "BUS" otherwise. Pattern-based rather than an enumerated list of
// known IDs -- SEPTA already adds new IDs within a lettered line (e.g. a
// future T6) without any code change needed here; a hardcoded list would
// silently miss those. Not derived from a route's color: an ordinary
// trolley also gets a real brand color from SEPTA's /routes/ metadata, so
// color alone can't tell a Metro line apart from a bus that happens to be
// flagged frequent-service (see septa-client.js's resolveRouteLabelColor).
const METRO_ROUTE_ID_PATTERN = /^[LGBTDM]\d+$/i;
function septaMergedRouteTypeLabel(subRouteIds) {
  return subRouteIds.some((id) => METRO_ROUTE_ID_PATTERN.test(id)) ? "METRO" : "BUS";
}

const CARDINAL_ORDER = ["N", "S", "E", "W"];

// Combines each sub-route's own direction abbreviation into one compact
// code for a merged row's header, e.g. ["NB", "NB"] -> "NB" (the common
// case -- every sub-route shares one cardinal direction), ["NB", "EB"] ->
// "NEB", in fixed N/S/E/W order regardless of input order. Falls back to
// joining the raw abbreviations with "/" if any of them doesn't fit the
// single-letter-cardinal shape (e.g. septaAbbreviateDirection's fallback
// for a direction string that isn't "___bound") -- safer than guessing at a
// combined code from something that isn't one.
function septaCombineDirectionAbbreviations(abbreviations) {
  const distinct = [...new Set(abbreviations.filter(Boolean))];
  if (distinct.length <= 1) return distinct[0] || "";
  const letters = new Set();
  for (const abbrev of distinct) {
    const match = /^([NSEW])B$/.exec(abbrev);
    if (!match) return distinct.join("/");
    letters.add(match[1]);
  }
  const ordered = CARDINAL_ORDER.filter((letter) => letters.has(letter));
  return `${ordered.join("")}B`;
}

// Like septaGroupByDestination, but for a merged route's combined arrivals,
// and deliberately NOT like it in one important way: it never re-indexes
// based on which headsigns happen to be shown this cycle. Every headsign
// gets a fixed marker up front, from its position in headsignOrder (the
// combined per-sub-route orders, concatenated and deduped by the caller),
// whether or not it's currently contributing an arrival. Markers are always
// on for a merged row (unlike septaGroupByDestination, which collapses to
// unmarked below 2 distinct shown headsigns) for the same reason: with
// several sub-routes and a maxArrivals cap, it's common for one sub-route
// to simply not make the cut some cycle -- filtering the order down to only
// "currently shown" first (as septaGroupByDestination does, harmlessly
// there) would shift every later headsign's marker down to fill the gap,
// so a route's marker would drift depending on which siblings happened to
// contribute that cycle. allArrivals is the full merged pool, not the
// maxArrivals-sliced shown list, so even an off-schedule headsign missing
// from headsignOrder entirely gets a slot that doesn't depend on the slice
// either.
function septaAssignMergedMarkers(allArrivals, headsignOrder) {
  const order = Array.isArray(headsignOrder) ? [...headsignOrder] : [];
  for (const arrival of allArrivals) {
    if (arrival.headsign && !order.includes(arrival.headsign)) order.push(arrival.headsign);
  }
  return new Map(order.map((headsign, index) => [headsign, septaFootnoteMarker(index)]));
}

// Wraps a merged row's sub-route id in the same color-only styling hook the
// single-route label uses (routeColor, from SEPTA's /routes/ metadata --
// see septa-client.js's resolveRouteLabelColor) -- no font-size/weight of
// its own, so it picks up whatever the surrounding context (the label cell
// up top, or a muted .septa-full-width row below) already provides and only
// ever changes color.
function septaColoredRouteLabel(id, routeColor) {
  const style = routeColor ? ` style="color:${septaEscapeHtml(routeColor)}"` : "";
  return `<span class="septa-route-number"${style}>${id}</span>`;
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
    routes: [], // [{ routeId, stopId, direction, label, warnMinutes, showHeadsigns }] -- warnMinutes and showHeadsigns are optional, overriding the global values below
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
    // How many minutes ahead the static-schedule supplement reaches. SEPTA's
    // live feed alone only covers ~15 min out; this fills the rest of the
    // window in from the schedule. Larger shows arrivals farther out (still
    // capped by maxArrivals); smaller keeps the display shorter-term. Only has
    // an effect when useScheduleSupplement is true.
    scheduleHorizonMinutes: 60,
    // Set false to hide the destination line(s) below each route and the
    // footnote markers on mixed-destination arrivals. When a route also has
    // a secondaryStopId, trips that skip it structurally (by headsign) are
    // hidden entirely instead of just flagged, replaced by a single muted
    // note -- trips skipping it due to an active detour still show, in
    // orange, unchanged. See README's "Secondary stop" section.
    showHeadsigns: true,
  },

  start() {
    this.routeStates = {}; // routeKey -> latest SEPTA_UPDATE payload

    this.sendSocketNotification("SEPTA_CONFIG", {
      instanceId: this.identifier,
      routes: this.config.routes,
      refreshIntervalSeconds: this.config.refreshIntervalSeconds,
      retryIntervalSeconds: this.config.retryIntervalSeconds,
      useScheduleSupplement: this.config.useScheduleSupplement,
      scheduleHorizonMinutes: this.config.scheduleHorizonMinutes,
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
    // Tracks the stopId of the header row most recently actually printed,
    // so two routes configured with the same stopId back-to-back (e.g. two
    // different routes/directions that happen to share a physical stop)
    // don't repeat an identical header between them. Only adjacent repeats
    // are deduped -- a different stopId in between resets this, so the
    // header intentionally reprints rather than silently grouping
    // non-adjacent routes out of the order they were configured in.
    let lastHeaderStopId = null;

    for (const route of this.config.routes) {
      const subRouteIds = septaParseRouteIds(route.routeId);
      if (subRouteIds.length > 1) {
        lastHeaderStopId = this.renderMergedRouteRow(wrapper, route, subRouteIds, now, lastHeaderStopId);
        continue;
      }
      const state = this.routeStates[septaRouteKey(route)];

      const stopName = state && state.stopName;
      if (stopName && route.stopId !== lastHeaderStopId) {
        const headerRow = document.createElement("tr");
        const headerCell = document.createElement("td");
        headerCell.className = "septa-stop-header";
        headerCell.colSpan = 2;
        headerCell.innerHTML = septaEscapeHtml(stopName);
        headerRow.appendChild(headerCell);
        wrapper.appendChild(headerRow);
        lastHeaderStopId = route.stopId;
      }

      const row = document.createElement("tr");
      row.className = "septa-row";

      // secondaryStopId (route config): headsigns that structurally never
      // reach it come from the static schedule (secondaryStopSkippedHeadsigns);
      // an active detour skipping it applies route-wide regardless of
      // headsign (secondaryStopDetour). Both default to "no effect" when the
      // route has no secondaryStopId configured or state hasn't arrived yet.
      const secondaryStopSkippedHeadsigns = (state && state.secondaryStopSkippedHeadsigns) || [];
      const secondaryStopDetour = Boolean(state && state.secondaryStopDetour);
      const secondaryStopDisplayName =
        (state && state.secondaryStopName) || (route.secondaryStopId != null ? String(route.secondaryStopId) : "");
      // Per-route warnMinutes/showHeadsigns override the global config value,
      // which in turn overrides the module default -- MagicMirror already
      // merges the global-vs-default step via this.config, so only the
      // route-level override needs handling here.
      const warnMinutes = typeof route.warnMinutes === "number" ? route.warnMinutes : this.config.warnMinutes;
      const showHeadsigns =
        typeof route.showHeadsigns === "boolean" ? route.showHeadsigns : this.config.showHeadsigns;

      const allEtas = state && Array.isArray(state.etas) ? state.etas : [];
      // With showHeadsigns off, a secondary-stop-configured route hides
      // trips that structurally skip it (by headsign/pattern) instead of
      // just flagging them -- filtered out of the full known list, before
      // it's cut down to maxArrivals, so the display still fills up with
      // maxArrivals genuine trips rather than just showing fewer. A trip
      // skipped by an active detour is a different, real-time situation and
      // is never filtered here (secondaryStopDetour applies route-wide, so
      // this can't fire while a detour is in effect anyway).
      let omittedSecondaryStopTrips = false;
      const etasForDisplay =
        !showHeadsigns && route.secondaryStopId != null
          ? allEtas.filter((arrival) => {
              const skipsByHeadsign =
                !secondaryStopDetour &&
                (arrival.reachesSecondaryStop === false ||
                  (arrival.reachesSecondaryStop == null &&
                    secondaryStopSkippedHeadsigns.includes(arrival.headsign)));
              if (skipsByHeadsign) omittedSecondaryStopTrips = true;
              return !skipsByHeadsign;
            })
          : allEtas;
      const shownArrivals = etasForDisplay.slice(0, this.config.maxArrivals);
      const destinationInfo = showHeadsigns
        ? septaGroupByDestination(shownArrivals, etasForDisplay, state && state.headsignOrder)
        : { mixed: false, headsign: null };

      const labelCell = document.createElement("td");
      labelCell.className = "septa-label";
      const labelMain = document.createElement("div");
      labelMain.className = "septa-label-main";
      const abbrev = septaAbbreviateDirection(route.direction);
      // routeColor (node_helper.js, from SEPTA's /routes/ endpoint): a real
      // brand color for Metro/trolley routes, red for a bus route SEPTA
      // flags as frequent-service, or null (default label color) for an
      // ordinary bus route -- see septa-client.js's resolveRouteLabelColor.
      // Scoped to just the route number span, not the direction abbreviation
      // next to it, which keeps its own muted styling regardless.
      const routeColor = state && state.routeColor;
      const routeNumberStyle = routeColor ? ` style="color:${septaEscapeHtml(routeColor)}"` : "";
      labelMain.innerHTML =
        `<span class="septa-route-number"${routeNumberStyle}>${route.label || route.routeId}</span> ` +
        `<span class="septa-direction-abbrev">${abbrev}</span>`;
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
      if (omittedSecondaryStopTrips) {
        fullWidthRows.push({
          flagged: false,
          html: `(Note: Some trips omitted that don't stop at ${septaEscapeHtml(secondaryStopDisplayName)})`,
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

  // Renders one merged route entry (routeId parsed into 2+ sub-routeIds --
  // e.g. "T2,T3,T4,T5") as a single combined row instead of one row per
  // sub-route. Each sub-routeId polls fully independently on the backend
  // (see node_helper.js's registerConfig) -- this only ever combines
  // already-resolved routeStates at display time, same principle as the
  // rest of getDom(). Returns the (possibly updated) lastHeaderStopId so
  // getDom()'s loop can keep threading it through, the same way its own
  // inline stop-header dedup logic does.
  //
  // See README's "Merging routes" section for the full behavior this
  // implements.
  renderMergedRouteRow(wrapper, route, subRouteIds, now, lastHeaderStopId) {
    const warnMinutes = typeof route.warnMinutes === "number" ? route.warnMinutes : this.config.warnMinutes;
    const showHeadsigns =
      typeof route.showHeadsigns === "boolean" ? route.showHeadsigns : this.config.showHeadsigns;

    // One entry per sub-route that has live state at all -- a sub-route
    // MagicMirror hasn't heard from yet (still loading on first start)
    // simply contributes nothing this cycle, same treatment as one that's
    // mid-detour.
    const subRoutes = subRouteIds.map((subRouteId) => {
      const direction = septaResolveDirectionForRoute(route.direction, subRouteId);
      const state = this.routeStates[septaRouteKey({ routeId: subRouteId, stopId: route.stopId, direction })];
      return { subRouteId, direction, state };
    });
    const knownSubRoutes = subRoutes.filter((s) => s.state);
    const routeColorFor = new Map(subRoutes.map((s) => [s.subRouteId, s.state && s.state.routeColor]));

    const stopName = knownSubRoutes.map((s) => s.state.stopName).find(Boolean);
    if (stopName && route.stopId !== lastHeaderStopId) {
      const headerRow = document.createElement("tr");
      const headerCell = document.createElement("td");
      headerCell.className = "septa-stop-header";
      headerCell.colSpan = 2;
      headerCell.innerHTML = septaEscapeHtml(stopName);
      headerRow.appendChild(headerCell);
      wrapper.appendChild(headerRow);
      lastHeaderStopId = route.stopId;
    }

    const row = document.createElement("tr");
    row.className = "septa-row";

    const labelCell = document.createElement("td");
    labelCell.className = "septa-label";
    const labelMain = document.createElement("div");
    labelMain.className = "septa-label-main";
    const combinedAbbrev = septaCombineDirectionAbbreviations(
      subRoutes.map((s) => septaAbbreviateDirection(s.direction))
    );
    labelMain.innerHTML =
      `<span class="septa-route-number">${route.label || septaMergedRouteTypeLabel(subRouteIds)}</span> ` +
      `<span class="septa-direction-abbrev">${combinedAbbrev}</span>`;
    labelCell.appendChild(labelMain);
    row.appendChild(labelCell);

    const arrivalsCell = document.createElement("td");
    arrivalsCell.className = "septa-arrivals";

    if (knownSubRoutes.length === 0) {
      arrivalsCell.innerHTML = "&hellip;";
      row.appendChild(arrivalsCell);
      wrapper.appendChild(row);
      return lastHeaderStopId;
    }

    const fresh = knownSubRoutes.every((s) => septaIsFresh(s.state.lastFetchTime, s.state.refreshIntervalSeconds, now));
    if (!fresh) row.className += " septa-stale";
    const hasTripError = knownSubRoutes.some((s) => s.state.hasTripError);

    // A merged row only shows a full DETOUR banner when literally every
    // sub-route is detoured around the primary stop this cycle -- a detour
    // on just one leg simply contributes zero arrivals from that sub-route
    // (pollRoute's existing detour handling is all-or-nothing per route),
    // no different in effect from that sub-route having nothing scheduled
    // right now.
    const allDetoured = knownSubRoutes.every((s) => s.state.detour);

    // secondaryStopId is one shared config value for the whole merged
    // group, not per sub-route -- each sub-route resolves its own skip
    // status against it independently, exactly like the single-route case
    // in getDom() above, and those per-arrival flags travel through the
    // merge below.
    const secondaryStopDisplayName =
      knownSubRoutes.map((s) => s.state.secondaryStopName).find(Boolean) ||
      (route.secondaryStopId != null ? String(route.secondaryStopId) : "");
    const anySecondaryStopDetour = knownSubRoutes.some((s) => s.state.secondaryStopDetour);

    let omittedSecondaryStopTrips = false;
    const mergedArrivals = [];
    for (const { subRouteId, state } of knownSubRoutes) {
      if (state.detour) continue;
      const secondaryStopSkippedHeadsigns = state.secondaryStopSkippedHeadsigns || [];
      const secondaryStopDetour = Boolean(state.secondaryStopDetour);
      const allEtas = Array.isArray(state.etas) ? state.etas : [];
      const etasForDisplay =
        !showHeadsigns && route.secondaryStopId != null
          ? allEtas.filter((arrival) => {
              const skipsByHeadsign =
                !secondaryStopDetour &&
                (arrival.reachesSecondaryStop === false ||
                  (arrival.reachesSecondaryStop == null &&
                    secondaryStopSkippedHeadsigns.includes(arrival.headsign)));
              if (skipsByHeadsign) omittedSecondaryStopTrips = true;
              return !skipsByHeadsign;
            })
          : allEtas;
      for (const arrival of etasForDisplay) {
        const skipsSecondaryStop =
          secondaryStopDetour ||
          arrival.reachesSecondaryStop === false ||
          (arrival.reachesSecondaryStop == null && secondaryStopSkippedHeadsigns.includes(arrival.headsign));
        mergedArrivals.push({ ...arrival, subRouteId, skipsSecondaryStop });
      }
    }
    mergedArrivals.sort((a, b) => a.eta - b.eta);
    const shownArrivals = mergedArrivals.slice(0, this.config.maxArrivals);

    // Two different marker schemes depending on showHeadsigns, matching the
    // two different jobs a marker does in each mode. With showHeadsigns
    // false, headsigns are deliberately hidden -- a marker's only job is to
    // trace a top-row time back to *which route* it came from, so it's one
    // marker per sub-route, fixed by that sub-route's position in the
    // configured routeId list (not by which sub-routes happen to have
    // arrivals this cycle, for the same stability reason headsignOrder
    // exists below -- so a route's marker never changes cycle to cycle).
    // With showHeadsigns true, headsigns are shown, so a marker instead
    // traces a time back to *which destination*, same as the single-route
    // case -- one marker per distinct headsign, via septaAssignMergedMarkers.
    const markerForSubRoute = new Map(subRouteIds.map((id, index) => [id, septaFootnoteMarker(index)]));
    let markerFor; // Map<headsign, marker>, only populated/used when showHeadsigns is true
    if (showHeadsigns) {
      // Each sub-route's own headsignOrder (from node_helper.js, stable
      // across polls -- see septaGroupByDestination's doc comment),
      // concatenated in sub-route configuration order and deduped, so a
      // given destination's marker doesn't change just because a different
      // sub-route's trip happens to be next.
      const combinedHeadsignOrder = [];
      for (const { state } of knownSubRoutes) {
        for (const headsign of state.headsignOrder || []) {
          if (!combinedHeadsignOrder.includes(headsign)) combinedHeadsignOrder.push(headsign);
        }
      }
      markerFor = septaAssignMergedMarkers(mergedArrivals, combinedHeadsignOrder);
    }
    for (const arrival of shownArrivals) {
      arrival.marker = showHeadsigns ? markerFor.get(arrival.headsign) || "" : markerForSubRoute.get(arrival.subRouteId);
    }

    if (allDetoured) {
      arrivalsCell.classList.add("septa-detour");
      const reason = knownSubRoutes.map((s) => s.state.detourReason).find(Boolean);
      arrivalsCell.innerHTML = reason ? `DETOUR: ${septaEscapeHtml(reason)}` : "DETOUR";
    } else if (shownArrivals.length === 0) {
      arrivalsCell.innerHTML = "&ndash;&ndash;";
    } else {
      const separator = shownArrivals.length > 1 ? ", " : " ";
      arrivalsCell.innerHTML = shownArrivals
        .map((arrival, index) => {
          const minutes = septaMinutesUntil(arrival.eta, now);
          const urgencyClass = arrival.skipsSecondaryStop
            ? "septa-secondary-skip"
            : minutes <= warnMinutes
              ? "septa-urgent"
              : "septa-normal";
          const tierClass = index === 0 && arrival.tracked !== false ? "septa-first" : "septa-later";
          const untrackedClass = arrival.tracked === false ? " septa-untracked" : "";
          const prefix = arrival.tracked === false ? "~" : "";
          const text =
            minutes <= this.config.countdownWithinMinutes ? `${minutes}m` : septaFormatClockTime(arrival.eta);
          return `<span class="${urgencyClass} ${tierClass}${untrackedClass}">${prefix}${text}${arrival.marker}</span>`;
        })
        .join(separator);
    }

    if (hasTripError) {
      const warn = document.createElement("span");
      warn.className = "septa-partial";
      warn.title = "Some trip data failed to load this cycle";
      warn.innerHTML = " !";
      arrivalsCell.appendChild(warn);
    }

    row.appendChild(arrivalsCell);
    wrapper.appendChild(row);

    // Second row(s): built from shownArrivals (what's actually in the top
    // countdown, post-maxArrivals-cutoff), not the full merged pool -- a
    // sub-route/headsign with nothing currently in that window doesn't get
    // a row of its own, same "only what's actually shown" principle as the
    // single-route case above.
    const fullWidthRows = [];
    if (!showHeadsigns) {
      // One marker per contributing sub-route (markerForSubRoute is a
      // fixed 1:1 mapping, so there's never more than one to resolve here)
      // -- e.g. "T2(*), T4(†), T5(‡)".
      const contributingSubRouteIds = new Set(shownArrivals.map((a) => a.subRouteId));
      const parts = subRouteIds
        .filter((id) => contributingSubRouteIds.has(id))
        .map((id) => `${septaColoredRouteLabel(id, routeColorFor.get(id))}(${markerForSubRoute.get(id)})`);
      if (parts.length > 0) fullWidthRows.push({ flagged: false, html: parts.join(", ") });
    } else {
      // Which headsigns each sub-route is currently showing, per subRouteId
      // -- a Set, not an array, since print order comes from markerFor's own
      // stable key order below (see septaAssignMergedMarkers), not from
      // whichever arrival happens to be chronologically first this cycle.
      const shownHeadsignsBySubRoute = new Map();
      for (const arrival of shownArrivals) {
        if (!shownHeadsignsBySubRoute.has(arrival.subRouteId)) shownHeadsignsBySubRoute.set(arrival.subRouteId, new Set());
        if (arrival.headsign) shownHeadsignsBySubRoute.get(arrival.subRouteId).add(arrival.headsign);
      }
      const stableHeadsignOrder = [...markerFor.keys()];
      for (const { subRouteId, state } of knownSubRoutes) {
        const shown = shownHeadsignsBySubRoute.get(subRouteId);
        if (!shown || shown.size === 0) continue;
        const headsigns = stableHeadsignOrder.filter((h) => shown.has(h));
        const skipped = state.secondaryStopSkippedHeadsigns || [];
        const parts = headsigns.map((headsign) => {
          const marker = markerFor.get(headsign);
          const line = `${septaEscapeHtml(headsign)}(${marker})`;
          return skipped.includes(headsign) ? `${line} (no stop at ${septaEscapeHtml(secondaryStopDisplayName)})` : line;
        });
        fullWidthRows.push({
          flagged: headsigns.some((h) => skipped.includes(h)),
          html: `${septaColoredRouteLabel(subRouteId, routeColorFor.get(subRouteId))} &rarr; ${parts.join(", ")}`,
        });
      }
    }
    if (omittedSecondaryStopTrips) {
      fullWidthRows.push({
        flagged: false,
        html: `(Note: Some trips omitted that don't stop at ${septaEscapeHtml(secondaryStopDisplayName)})`,
      });
    }
    if (anySecondaryStopDetour && shownArrivals.length > 0) {
      fullWidthRows.push({
        flagged: true,
        html: `Detour skips stop at ${septaEscapeHtml(secondaryStopDisplayName)}`,
      });
    }

    for (const entry of fullWidthRows) {
      const entryRow = document.createElement("tr");
      const entryCell = document.createElement("td");
      entryCell.className = entry.flagged ? "septa-full-width septa-secondary-skip" : "septa-full-width";
      entryCell.colSpan = 2;
      entryCell.innerHTML = entry.html;
      entryRow.appendChild(entryCell);
      wrapper.appendChild(entryRow);
    }

    return lastHeaderStopId;
  },
});
