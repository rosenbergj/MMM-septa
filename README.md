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
these, use the included helper — it hits the same SEPTA endpoints the module
uses at runtime, so there's nothing extra to configure:

```sh
node scripts/find-stop.js 17
```

This prints every stop along the route, per direction, e.g.:

```
Route 17 — Northbound (trip 787404)
  seq  stop_id  stop_name
  1    40       20th St & Johnston St
  2    21289    20th St & Oregon Av
  ...

Route 17 — Southbound (trip 787763)
  seq  stop_id  stop_name
  1    69       Front St & Market St Loop
  ...
```

Add `--full` to get ready-to-paste `routes[]` entries instead of the table
— each stop prints its name followed by the exact object to drop into
config.js:

```sh
node scripts/find-stop.js 17 --full
```

```
Route 17 — Northbound (trip 787404)
  20th St & Oregon Av
  { routeId: "17", stopId: 21289, direction: "Northbound", label: "17" },
  ...
```

Copy the `stop_id` and the direction name (exactly as printed) into your
config. If your stop is missing from the printout, the sample trip used to
generate it had already passed that stop when you ran the command — just
re-run it (ideally earlier in the route's service window).

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
  },
}
```

| Option                    | Default | Description                                                              |
| ------------------------- | ------- | -------------------------------------------------------------------------- |
| `routes`                  | `[]`    | Array of `{ routeId, stopId, direction, label, warnMinutes, secondaryStopId }` -- `label` is optional and defaults to `routeId` if omitted; `warnMinutes` is optional per-route and overrides the global value below; `secondaryStopId` is optional, see below |
| `maxArrivals`             | `3`     | Number of upcoming arrivals shown per route                              |
| `refreshIntervalSeconds`  | `120`   | How often the backend actually polls SEPTA                               |
| `retryIntervalSeconds`    | `30`    | Backoff before retrying after a failed poll                              |
| `warnMinutes`             | `5`     | Arrivals at or under this many minutes are styled as "urgent" (global default; can be overridden per route) |
| `countdownWithinMinutes`  | `30`    | Arrivals at or under this many minutes show as "Nm"; farther out shows a clock time (e.g. "5:47 PM"), honoring the mirror's global `timeFormat` (12/24h) |
| `countdownTickSeconds`    | `15`    | How often the displayed "Nm" countdown re-renders client-side            |
| `useScheduleSupplement`   | `true`  | Include arrivals SEPTA hasn't fully GPS-confirmed yet, plus static-schedule arrivals up to 60 minutes out that live tracking doesn't cover yet (both shown as "~Nm", italic/muted). Set `false` to show only GPS-confirmed arrivals. |

Each route's `direction` must match SEPTA's `direction_name` for that route
exactly (case-sensitive) — use `find-stop.js` to confirm it.

### Secondary stop (optional)

If you only care about arrivals that actually continue past your stop to
some further destination — e.g. a short-turn trip that ends before reaching
where you're headed, or a stop you're worried a detour might skip — set
`secondaryStopId` on that route to that further stop's `stop_id`. It doesn't
change which arrivals are shown, just how they're colored:

- If a trip's destination pattern never reaches the secondary stop (a
  short-turn headsign), that headsign's line and its non-detour arrival
  times are colored orange instead of red/green, with "(no stop at
  &lt;secondary stop name&gt;)" appended.
- If an active detour is currently skipping the secondary stop (but not your
  primary stop, so trips are still shown), all arrival times for that route
  are colored orange, with a "Detour skips stop at &lt;secondary stop
  name&gt;" line appended below the destinations.
- Untracked ("~") arrivals keep their usual italic/muted look either way,
  just recolored orange instead of gray/green/red.

The secondary stop's name is resolved automatically the same way the
primary stop's is (no config needed) and cached once known.

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

- Bus routes only — SEPTA rail isn't covered.
- No time-of-day-dependent stop/direction switching (e.g. commuting one
  direction in the morning, the other in the evening) — each route entry is
  static. Can be added later if useful.
- A single "urgent" color threshold (`warnMinutes`), not a multi-tier scheme.
- Two identical route/stop/direction entries within the same module instance
  will collide (they share one internal state slot) — use distinct entries.

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
  a small direction abbreviation (e.g. "17 NB"), and each route also gets
  a small header line with the stop name (e.g. "20th St & Oregon Av"),
  discovered automatically from SEPTA's live data (no config needed) and
  cached once known, so it doesn't disappear during a cycle with no
  active trips. Each arrival carries its own trip's destination, shown
  as a sub-label under the route label when every currently-shown
  arrival agrees on it (e.g. "→ Front-Market"). When they don't, each
  distinct destination among the shown arrivals gets a footnote marker
  (*, †, ‡, ...) appended to its times (e.g. "14m* 22m†"), with every
  destination listed on its own line below (e.g. "→ 20th-Johnston(*)"
  / "→ Broad-Pattison(†)") instead of a vague "Mixed destinations".
  Marker assignment is stable across polls -- node_helper derives it
  from every headsign the route/stop is ever scheduled to see (not
  just whichever trip happens to be next), so a given destination
  keeps the same marker even as different trips rotate through. The
  nearest arrival is shown larger/brighter than the rest. With
  `useScheduleSupplement` on
  (the default), arrivals SEPTA hasn't started GPS-tracking yet — still
  at their first stop, no vehicle assigned, or otherwise not "real-time"
  — are shown too, styled as "~Nm" (italic, muted) instead of being
  dropped entirely. The one exception: a trip with no vehicle assigned
  at all ("NO GPS") has no real delay data behind its ETA (confirmed
  live that these can sit unchanged for the better part of an hour, or
  vanish entirely, without ever getting a vehicle) — so if a later,
  fully-confirmed arrival already exists, the "NO GPS" one is dropped
  rather than shown ahead of it. A trip still at its first stop but
  with a real assigned vehicle is unaffected by this — its GPS/delay
  data is genuinely trustworthy, just not yet "in progress".
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
  the same trip as one already shown.
- `scripts/find-stop.js` / `scripts/dry-run.js` — standalone CLI helpers,
  runnable with plain `node`, no MagicMirror needed.

Adapted from the SEPTA-polling design in the `lightpi` project.
