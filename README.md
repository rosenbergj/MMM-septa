# MMM-septa

A [MagicMirror²](https://magicmirror.builders/) module that shows upcoming
SEPTA bus arrivals for a fixed list of routes/stops.

This module deliberately avoids the GTFS-static + GTFS-realtime protobuf +
local SQLite approach used by some other transit modules — that approach
requires native module rebuilds under Electron and can be slow/fragile. This
module instead polls SEPTA's own public v2 JSON API directly (no API key, no
database, no dependencies beyond Node's built-in `fetch`), the same approach
a sibling (non-MagicMirror) project has used reliably for months.

## Requirements

- MagicMirror² already installed.
- Node.js 18 or newer (this module relies on Node's built-in global `fetch`
  and `AbortSignal.timeout` — there's nothing to `npm install`).

## Installation

```sh
cd ~/MagicMirror/modules
git clone <url-of-this-repo> MMM-septa
```

No `npm install` step is required for normal use — the module has zero
runtime dependencies. (`npm test` for the module's own test suite does rely
on Node's built-in test runner, also with no dependencies to install.)

## Finding your route and stop IDs

You'll need a SEPTA `route_id`, a `stop_id`, and the exact `direction_name`
SEPTA uses for that route (e.g. `"Northbound"`). If you don't already know
these, use the included helper:

```sh
node scripts/find-stop.js 17
```

This prints every stop, for every distinct scheduled pattern (headsign) on
the route, straight from SEPTA's static GTFS schedule — including
short-turn/express patterns with no trip running right now, which is the
whole reason it uses the static schedule rather than only live data: a
purely live-data lookup can only ever show whichever trips happen to be
running at the moment you run it, and would silently miss a short-turn
pattern's stops if none of its trips were currently active.

Patterns sharing a direction are merged into one listing instead of printed
separately: the longest pattern is the reference, and any other pattern's
stops the reference doesn't already have are spliced in as unlabeled `alt`
rows right where they diverge (before, after, or in the middle of the main
sequence). A pattern that's fully covered by the reference (SEPTA often just
runs a shorter version of the same route) contributes nothing beyond its
name appearing in the header. Output is deterministic — no "currently
running" status, no filtering by day, same result every time you run it for
a given feed — e.g.:

```
Route 17 — Southbound — "20th-Johnston" and "Broad-Pattison"
  seq  stop_id  stop_name
  1    31442    2nd St & Church St
  2    20961    2nd St & Market St
  ...
  44   21340    19th St & Oregon Av

  alt  21341    19th St & Johnston St
  alt  38       19th St & Moyamensing Av
  alt  31456    Moyamensing Av & 20th St
  alt  40       20th St & Johnston St

  45   30872    20th St & Oregon Av - FS
  ...
```

Live `/trips/` data is still fetched, but only to label each direction with
its real `direction_name` string (the static feed only has a bare 0/1
direction_id, not a name). If no live trip is running in a direction right
now, it's labeled `direction_id N (name unconfirmed -- no live trip running
this direction right now)` instead — unless the route has exactly two
directions and the other one *is* confirmed live, in which case the missing
one is inferred as its cardinal opposite (Northbound↔Southbound,
Eastbound↔Westbound) and flagged as such rather than presented as certain:
`Southbound (inferred as the opposite of Northbound -- not live-confirmed,
double-check)`.

Add `--full` to get ready-to-paste `routes[]` entries instead of the table
— same merged stop list and grouping, each stop's name followed by the
exact object to drop into config.js:

```sh
node scripts/find-stop.js 17 --full
```

```
Route 17 — Southbound — "20th-Johnston" and "Broad-Pattison"
  2nd St & Church St
  { routeId: "17", stopId: 31442, direction: "Southbound", label: "17" },
  ...
```

Copy the `stop_id` and the direction name (exactly as printed) into your
config. This downloads SEPTA's full static schedule feed (~20MB) each time
you run it — that's normal for this one-off lookup script. The module's own
runtime polling never re-downloads it per-poll either (see "How it works"
below) — it already downloads the same feed once daily for the schedule
supplement, and reads a bit more out of that same download to resolve stop
names.

## Configuration

Add to `config.js`:

Shows a "SEPTA tracking" header by default; set `header` (a standard
MagicMirror module option, outside `config`) to override it.

```js
{
  module: "MMM-septa",
  position: "top_right",
  config: {
    routes: [
      { routeId: "17", stopId: 21289, direction: "Northbound", label: "17" },
      { routeId: "64", stopId: 21265, direction: "Westbound", label: "64", warnMinutes: 2 },
    ],
    maxArrivals: 3,
    refreshIntervalSeconds: 120,
    retryIntervalSeconds: 30,
    warnMinutes: 5,
    countdownWithinMinutes: 30,
    useScheduleSupplement: true,
    showHeadsigns: true,
  },
}
```

| Option                    | Default | Description                                                              |
| ------------------------- | ------- | -------------------------------------------------------------------------- |
| `routes`                  | `[]`    | Array of `{ routeId, stopId, direction, label, warnMinutes, secondaryStopId, showHeadsigns }` -- `label` is optional and defaults to `routeId` if omitted; `warnMinutes` and `showHeadsigns` are optional per-route and override the global values below; `secondaryStopId` is optional, see below |
| `maxArrivals`             | `3`     | Number of upcoming arrivals shown per route                              |
| `refreshIntervalSeconds`  | `120`   | How often the backend actually polls SEPTA                               |
| `retryIntervalSeconds`    | `30`    | Backoff before retrying after a failed poll                              |
| `warnMinutes`             | `5`     | Arrivals at or under this many minutes are styled as "urgent" (global default; can be overridden per route) |
| `countdownWithinMinutes`  | `30`    | Arrivals at or under this many minutes show as "Nm"; farther out shows a clock time (e.g. "5:47 PM"), honoring the mirror's global `timeFormat` (12/24h) |
| `countdownTickSeconds`    | `15`    | How often the displayed "Nm" countdown re-renders client-side            |
| `useScheduleSupplement`   | `true`  | Include arrivals SEPTA hasn't fully GPS-confirmed yet, plus static-schedule arrivals up to 60 minutes out that live tracking doesn't cover yet (both shown as "~Nm", italic/muted). Set `false` to show only GPS-confirmed arrivals. |
| `showHeadsigns`           | `true`  | Show each trip's headsign (see below) below the route, and footnote markers when several are mixed together. Global default, overridable per route. Set `false` to hide both and compact the display -- see "Secondary stop" below for how this interacts with `secondaryStopId`. |

Each route's `direction` should match SEPTA's `direction_name` for that route
exactly (case-sensitive) — use `find-stop.js` to confirm it. If your
`stop_id` is itself exclusive to one direction (true for most stops — the
two directions usually get two different stop_ids), arrivals still show up
even when SEPTA's live feed can't confirm a name at all, and a mismatched
`direction` just logs a warning instead of hiding arrivals.

A `routeId` that doesn't match any real SEPTA route (a typo, a
discontinued route, etc) fails silently — it just never has any arrivals,
indistinguishable from a real route that legitimately has nothing running
right now. A warning is logged to the console (once at startup, and again
on each daily refresh if it's still wrong) if this happens.

### What's a "headsign"?

The destination text shown on the front of the bus (or train) — SEPTA's
term for it, borrowed here since it's what the API itself calls the field.
It can differ between trips on the same route and direction: a short-turn
that ends partway along the route, a branch, a weekend-only extension, and
so on. Riders already familiar with a route usually recognize what a given
headsign means for their trip; this module just displays whatever SEPTA
reports, plus (via `secondaryStopId` below) an optional way to tell apart
headsigns that do vs. don't reach a stop you care about.

### Secondary stop (optional)

Set `secondaryStopId` on a route to flag arrivals whose trip doesn't stop at
some other `stop_id` on that same route — e.g. a short-turn trip that ends
before reaching where you're headed, a stop you're worried a detour might
skip, or (just as validly) an earlier stop if you want to tell full-length
trips apart from ones that start further along the route. It works in
either direction relative to your primary stop. By default (`showHeadsigns:
true`) it doesn't change which arrivals are shown, it just flags them: if a
trip or an entire headsign doesn't stop at the secondary stop (whether
structurally or because of an active detour), that's noted in text (e.g.
"no stop at Broad St & Kitty Hawk Av") and colored orange instead of the
usual red/green/gray.

With `showHeadsigns: false`, that changes for the *structural* case only:
trips whose headsign/pattern never reaches the secondary stop are hidden
entirely instead of flagged, replaced by a single muted note ("Note: Some
trips omitted that don't stop at Broad St & Kitty Hawk Av") in the same
style as a headsign line — not orange. This is meant to cut down on orange
you don't actually care about when a route just has multiple branches, only
some of which go where you're headed. A trip skipped by an active *detour*
is unaffected by this and still shows in orange as above, since that's a
real-time situation rather than an expected branch of the route.

If `secondaryStopId` doesn't actually appear anywhere on the configured
route at all (wrong route, a typo, or a nonexistent `stop_id`), it's treated
as if it weren't set — nothing is flagged, hidden, or colored orange — and
a warning is logged to the console on each schedule refresh so the mistake
is discoverable.

The secondary stop's name is resolved automatically (no config needed) —
first from live trip data the same way the primary stop's is, falling back
to the daily static-schedule refresh if no live trip happens to pass through
it (which a structurally-skipping headsign might never do) — and cached
once known either way.

## Testing

Unit tests (no network access, safe to run anytime):

```sh
npm test
```

Live smoke test against the real SEPTA API (no MagicMirror required — useful
to confirm connectivity from a new machine, or after changing
`septa-client.js`):

```sh
npm run dry-run -- --route 17 --stop 21289 --direction Northbound
```

Run `node scripts/dry-run.js --help` for all options. Its default polling
interval is short (20s) purely so you don't have to wait to see output —
don't copy that into your real `config.js`.

## Known limitations (MVP scope)

- Regional Rail isn't covered — that's a separate GTFS feed/API SEPTA
  publishes and this module doesn't touch it.
- SEPTA Metro (the subway/el) and trolleys are reachable with the same
  `route_id`s used by SEPTA's static GTFS feed and live v2 API — no
  separate feed or endpoint needed:
  - `L1` — Market-Frankford Line
  - `B1` — Broad Street Line Local
  - `B2` — Broad Street Line Express
  - `B3` — Broad-Ridge Spur
  - `M1` — Norristown High-Speed Line
  - Trolleys: `T1`–`T5`, `G1`, `D1`, `D2`

  Caveat: SEPTA has no live GPS tracking for the Broad Street Line or
  Market-Frankford Line (`B1`/`B2`/`B3`/`L1`) — every trip on those two
  lines reports `"NO GPS"`, so their arrivals are always schedule-based
  estimates, never truly live-tracked. Every other route above (the
  trolleys and `M1`) does get live GPS/position data, behaving the same
  as a bus route.
- No time-of-day-dependent stop/direction switching (e.g. commuting one
  direction in the morning, the other in the evening) — each route entry is
  static. Can be added later if useful.
- A single "urgent" color threshold (`warnMinutes`), not a multi-tier scheme.
- Two identical route/stop/direction entries within the same module instance
  will collide (they share one internal state slot) — use distinct entries.
- A stop genuinely served by both directions of a route (rare, but real —
  e.g. route 2 stop 40, or T1-T5's shared 13th St tunnel terminus) normally
  resolves via a live trip's `direction_name`. Routes whose live feed never
  gives a usable one at all (confirmed: the trolleys, route 63, and
  `B1`/`B2`/`B3`/`L1` always report `"N/A"`) get an automatic fallback
  instead: if every one of one direction's patterns reaches the stop only as
  that pattern's own last stop (a dead end — no rider could board there and
  continue), that direction is excluded automatically and the other is used,
  no config needed. Two shapes still aren't handled, and won't guess:
  - Wanting the excluded (terminal/arriving) side on purpose instead of the
    kept (departing) side — there's no way to ask for it.
  - Neither direction is uniformly terminal (both have at least one pattern
    where the stop is a real, continuing stop) — there's no direction safe
    to rule out, and no name to pick between them with.

  Both require the stop to be direction-ambiguous *and* the route to be one
  of the "always N/A" ones, so in practice this has only actually come up
  for T1-T5 at 13th St, which lands in the handled case.

## How it works

- `septa-client.js` — pure SEPTA API client + filtering logic (detours,
  trip filtering, stop-time filtering, staleness), fully unit tested.
- `node_helper.js` — runs one polling loop per configured route on the
  backend, pushes results to the frontend over MagicMirror's socket
  notifications.
- `MMM-septa.js` — renders the last known state per route, and re-renders
  the "Nm" countdowns every `countdownTickSeconds` without needing a
  fresh backend fetch. When a detour affects the configured stop, shows
  "DETOUR" (with SEPTA's stated reason, e.g. "DETOUR: Sinkhole", if one
  was provided) instead of arrival times. The route label is followed by
  a small direction abbreviation (e.g. "17 NB"). The route number itself is
  colored using SEPTA's own `/routes/` endpoint: Metro/trolley routes get
  their real brand color (e.g. Market-Frankford Line blue, Broad St Line
  orange), a bus route SEPTA flags as frequent-service (`is_frequent_bus`)
  is colored red, and everything else keeps the default label color. This
  metadata is fetched once at startup and refreshed daily, same cadence as
  the GTFS schedule cache, and cached to disk so a restart shows the last
  known-good colors immediately rather than defaulting to plain white until
  a fresh fetch succeeds (SEPTA's `/routes/` endpoint measured ~55% failure
  in testing, so this matters in practice, not just in theory). Each route also gets
  a small header line with the stop name (e.g. "20th St & Oregon Av"),
  discovered automatically from SEPTA's live data (no config needed) and
  cached once known, so it doesn't disappear during a cycle with no
  active trips. If two routes configured back-to-back share the same
  `stopId` (e.g. two different routes that both stop at the same physical
  corner), the header only prints once rather than repeating identically —
  configuring a third route with a different stop in between resets this,
  so the header intentionally reprints rather than grouping non-adjacent
  routes out of the order you configured them in. Each arrival carries
  its own trip's destination, shown as a full-width line below the route
  (not squeezed into the label column, which would stretch it for every
  route once a longer note is involved — see "Secondary stop" below)
  when every currently-shown arrival agrees on it (e.g. "→ Front-Market").
  When they don't, each distinct destination among the shown arrivals
  gets a footnote marker (\*, †, ‡, ...) appended to its times (e.g.
  "14m* 22m†"), with every destination listed on its own line below
  (e.g. "→ 20th-Johnston(*)" / "→ Broad-Pattison(†)") instead of a vague
  "Mixed destinations". Marker assignment is stable across polls --
  node_helper derives it from every headsign the route/stop is ever
  scheduled to see (not just whichever trip happens to be next), so a
  given destination keeps the same marker even as different trips
  rotate through. Set `showHeadsigns: false` to hide both the destination
  line(s) and the footnote markers for a more compact display — see
  "Secondary stop" above for how it also changes secondary-stop handling.
  The nearest arrival is shown larger/brighter than the
  rest. With `useScheduleSupplement` on (the default), arrivals SEPTA
  hasn't started GPS-tracking yet — still at their first stop, no
  vehicle assigned, or otherwise not "real-time" — are shown too,
  styled as "~Nm" (italic, muted) instead of being dropped entirely.
  The one exception: a trip with no vehicle assigned at all ("NO GPS")
  has no real delay data behind its ETA (confirmed live that these can
  sit unchanged for the better part of an hour, or vanish entirely,
  without ever getting a vehicle) — so if a later, fully-confirmed
  arrival already exists, the "NO GPS" one is dropped rather than shown
  ahead of it. A trip still at its first stop but with a real assigned
  vehicle is unaffected by this — its GPS/delay data is genuinely
  trustworthy, just not yet "in progress".
- `gtfs-schedule.js` — fills in arrivals up to 60 minutes out that live
  tracking doesn't cover yet, using SEPTA's static GTFS schedule as a
  fallback (also shown "~Nm"). No sqlite, no GTFS-realtime protobuf, no
  full-feed database: `node_helper.js` downloads and filters the feed down
  to just your configured routes/stops once ~60 seconds after startup and
  once daily thereafter (never on the per-poll hot path), and caches the
  tiny result to `gtfs-cache.json` next to the module so a restart doesn't
  require redownloading. That file is gitignored — safe to delete anytime;
  it's rebuilt automatically on the next refresh. A scheduled arrival is
  dropped if it's no later than the latest live-tracked arrival (live data
  should already cover anything that imminent) or if it turns out to be
  the same trip as one already shown. The same daily refresh also resolves
  your configured stops' names (filtered to just those stop_ids, same as
  everything else here) as a fallback for when live data hasn't/can't.
- `scripts/find-stop.js` / `scripts/dry-run.js` — standalone CLI helpers,
  runnable with plain `node`, no MagicMirror needed.
