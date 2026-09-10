# MMM-septa

A [MagicMirror²](https://magicmirror.builders/) module that shows upcoming
SEPTA arrivals for a fixed list of routes/stops — buses, the Metro
subway/el lines, and trolleys, all with the same `route_id`s SEPTA's own
feed uses. (Regional Rail is a separate SEPTA feed and isn't covered.)

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
SEPTA uses for that route (e.g. `"Northbound"`). To find them:

```sh
node scripts/find-stop.js 17
```

That lists every stop on the route, read from SEPTA's static schedule, so
short-turn and express patterns show up even when nothing is running. Stops
only some patterns serve appear as `alt` rows, and the `trips` column says how
many trips actually serve each one:

```
Route 17 — Northbound — "2nd-Market" and "Front-Market"
  seq  stop_id  stop_name                   trips
  1    40       20th St & Johnston St         214
  2    21289    20th St & Oregon Av
  ...
  45   21318    Market St & 3rd St            214

  alt  69       Front St & Market St Loop      19

  46   7657     Market St & Front St          195
  ...
```

Add `--full` to get ready-to-paste `routes[]` entries instead of the table:

```sh
node scripts/find-stop.js 17 --full
```

```
Route 17 — Southbound — "20th-Johnston" and "Broad-Pattison"
  2nd St & Church St
  { routeId: "17", stopId: 31442, direction: "Southbound", label: "17" },
  ...
```

Copy the `stop_id` and the direction name exactly as printed.

Metro and trolley routes work the same way — `node scripts/find-stop.js T2`.
Their ids are `L1` (Market-Frankford), `B1`/`B2`/`B3` (Broad St local, express,
Ridge Spur), `M1` (Norristown High-Speed), and `T1`–`T5`, `G1`, `D1`, `D2` for
the trolleys.

Each run downloads SEPTA's ~20MB static feed, which is normal for a one-off
lookup; see [DESIGN.md](DESIGN.md) for why the module's own polling doesn't.

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
    scheduleHorizonMinutes: 60,
    showHeadsigns: true,
  },
}
```

| Option                    | Default | Description                                                              |
| ------------------------- | ------- | -------------------------------------------------------------------------- |
| `routes`                  | `[]`    | Array of `{ routeId, stopId, direction, label, warnMinutes, secondaryStopId, showHeadsigns }` -- `label` is optional and defaults to `routeId` if omitted; `warnMinutes` and `showHeadsigns` are optional per-route and override the global values below; `secondaryStopId` is optional, see below. `routeId` (and, for a merge, `direction`) can also merge several routes into one row -- see "Merging routes" below |
| `maxArrivals`             | `3`     | Number of upcoming arrivals shown per route                              |
| `refreshIntervalSeconds`  | `120`   | How often the backend actually polls SEPTA                               |
| `retryIntervalSeconds`    | `30`    | Backoff before retrying after a failed poll                              |
| `warnMinutes`             | `5`     | Arrivals at or under this many minutes are styled as "urgent" (global default; can be overridden per route) |
| `countdownWithinMinutes`  | `30`    | Arrivals at or under this many minutes show as "Nm"; farther out shows a clock time (e.g. "5:47 PM"), honoring the mirror's global `timeFormat` (12/24h) |
| `countdownTickSeconds`    | `15`    | How often the displayed "Nm" countdown re-renders client-side. These re-renders are instant (no fade) -- see ["How often the display fades"](DESIGN.md#how-often-the-display-fades) |
| `animationSpeed`          | `1000`  | Length in ms of the fade shown when a poll brings genuinely new data. Set `0` for no fade at all |
| `useScheduleSupplement`   | `true`  | Include arrivals SEPTA hasn't fully GPS-confirmed yet, plus static-schedule arrivals up to `scheduleHorizonMinutes` out that live tracking doesn't cover yet (both shown as "~Nm", italic/muted). Set `false` to show only GPS-confirmed arrivals. |
| `scheduleHorizonMinutes`  | `60`    | How many minutes ahead the static-schedule supplement reaches. How far SEPTA's own live feed reaches varies a lot (largely with how near the stop is to the start of a route or variant); this fills in the rest. Raise to show arrivals farther out, lower for a shorter-term view; still capped by `maxArrivals`, and it only adds arrivals *past* the furthest live-tracked one. Only applies when `useScheduleSupplement` is `true`. Capped at 12 hours (720). `0`/`-1` mean unlimited and resolve to the cap, as does anything above it; a non-numeric value falls back to `60`. To switch the supplement off, use `useScheduleSupplement: false`. |
| `showHeadsigns`           | `true`  | Show each trip's headsign (see below) below the route, and footnote markers when several are mixed together. Global default, overridable per route. Set `false` to hide both and compact the display -- see "Secondary stop" below for how this interacts with `secondaryStopId`. |

Each route's `direction` should match SEPTA's `direction_name` for that route
exactly (case-sensitive) — use `find-stop.js` to confirm it. A mismatch is
checked against SEPTA's static `directions.txt` once per daily schedule
refresh and logged as a console warning if found, regardless of whether a
live trip happens to be running (unlike the live-only check this
supplements — see "Known limitations" below). If your `stop_id` is itself
exclusive to one direction (true for most stops — the two directions
usually get two different stop_ids), arrivals still show up even with a
mismatched `direction` — the warning is informational, not something that
hides arrivals.

Only stops **later in the trip** count for `secondaryStopId`. If a route
passes your secondary stop before reaching your configured stop and then
again afterwards, only the later visit matters -- and if a detour removes
that later visit, the trip is flagged as skipping the secondary stop even
though it technically served it earlier. A stop the bus has already passed
is no use to you when you board.

#### Detours SEPTA doesn't detail

Most SEPTA detours arrive without a list of skipped stops -- 75 of 121 on
2026-09-02, nearly all of them active. For those, the module infers which
stretch of route the detour bypasses from the turn-by-turn coordinates SEPTA
does provide, and if your stop falls inside it, adds a note:

> Detour near here (SEPTA didn't list exact stops)

or, when only your `secondaryStopId` is affected:

> Detour near 19th St & South St (SEPTA didn't list exact stops)

**Arrival times are still shown**, unlike a detour that names your stop
outright (which replaces the row with `DETOUR`). The inference is a good
guess, not a fact, so it doesn't take your bus times away.

It stays quiet unless it can be reasonably sure: the detour must be active
now, match your route *and* direction, run no longer than 28 days (longer ones
are the new normal rather than news), and carry at least two turn coordinates
so there's a path to locate. Roughly half of all detours carry no coordinates
at all and are never reported this way. Measured against detours where SEPTA
*did* list the stops, the inferred span contains all of them about two-thirds
of the time -- so it under-reports rather than crying wolf.

A `routeId` that doesn't match any real SEPTA route (a typo, a
discontinued route, etc) fails silently — it just never has any arrivals,
indistinguishable from a real route that legitimately has nothing running
right now. A warning is logged to the console (once at startup, and again
on each daily refresh if it's still wrong) if this happens.

A `stopId` the configured route never actually stops at (a typo, a stop
that belongs to a different route, or a `stop_id` retired in a service
change) *is* called out on screen. The row keeps its usual shape — route
number, direction, and an empty `--` where the times go — with the stop
header showing the raw configured `stopId` (since there's no real stop name
to look up) and a small orange **"Invalid stop ID configured"** note
underneath. A warning is logged to the console on each daily schedule
refresh as well. The check is direction-agnostic: a `stopId` that's real on
the route but paired with the wrong `direction` isn't flagged this way (see
the note about `direction` above). Routes with `useScheduleSupplement: false`
aren't checked at all, since the static schedule this compares against is
never downloaded for them.

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

### Merging routes (optional)

Some routes share a stop and behave like one route with several headsigns —
SEPTA's T1-T5 trolleys through the same tunnel corridor, or two bus routes
running together for a few blocks. Set `routeId` to a comma-separated string to
combine them into one row:

```js
{ routeId: "T2,T3,T4,T5", stopId: 20661, direction: "Westbound", label: "17" },
```

An array (`routeId: ["T2", "T3", "T4", "T5"]`) works identically. Every route in
the list has to actually stop at that `stopId`; one that doesn't is logged as a
config error and contributes nothing.

Every sub-route still polls SEPTA independently — same detours, same
`secondaryStopId`, same everything. Merging only changes the display:

- The label becomes `BUS` or `METRO`, unless you set your own `label`. The
  direction abbreviation combines each sub-route's own direction in N/S/E/W
  order (`NEB` for one Eastbound and one Northbound sub-route).
- Arrivals from every sub-route merge into one sorted list, under the usual
  `maxArrivals`/`countdownWithinMinutes` limits, and always carry footnote
  markers — which sub-route is next can change between polls.
- Below that, one line resolving each sub-route's markers: `T2(*), T4(*,†)`
  with `showHeadsigns: false`, or one line per sub-route with it on.
- A `DETOUR` banner replaces the row only when *every* sub-route is detoured. A
  single detoured sub-route just contributes no arrivals.

**Direction**: one `direction` string applies to every sub-route, which covers
most merges. When they differ, pass a map instead:

```js
{ routeId: "2,17", stopId: 40, direction: { "2": "Northbound", "17": "Eastbound" } },
```

That isn't cosmetic. Disambiguating a stop served by both directions of a route
depends on knowing each sub-route's own direction rather than one borrowed from
a neighbor — see [DESIGN.md](DESIGN.md).

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

- Regional Rail isn't covered — separate SEPTA feed and API.
- SEPTA publishes no live GPS for the Broad Street and Market-Frankford lines
  (`B1`/`B2`/`B3`/`L1`) — every trip reports `"NO GPS"`, so arrivals on those
  four are always schedule-based estimates. Trolleys and `M1` do get live
  positions, same as buses.
- A single "urgent" color threshold (`warnMinutes`), not a multi-tier scheme.
- Two identical route/stop/direction entries in one module instance collide;
  use distinct entries.
- A stop served by both directions of the same route (rare but real — route 2
  stop 40, T1–T5's 13th St tunnel terminus) is resolved automatically, no
  config needed. It stays unresolved only when the stop is a dead end for
  neither direction, `directions.txt` can't match your configured `direction`,
  and no live trip with a usable name is running. There's also no way to ask
  for the arriving side of a terminus on purpose. See [DESIGN.md](DESIGN.md).

## How it works

Design notes -- the polling model, schedule feed retention, when the display
fades, and a file-by-file rundown of the code -- live in
[DESIGN.md](DESIGN.md).
