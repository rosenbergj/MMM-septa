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
rows right where they leave the main sequence — or, for a pattern that
*starts* somewhere off it, right where it rejoins. Either way an `alt` block
sits next to the stop it actually connects to, whether that's before, after,
or in the middle of the main sequence. A pattern that's fully covered by the
reference (SEPTA often just
runs a shorter version of the same route) contributes nothing beyond its
name appearing in the header. Output is deterministic — no "currently
running" status, no filtering by day, same result every time you run it for
a given feed — e.g.:

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

The `trips` column is how many trips in that direction actually serve the
stop, over the whole feed. It's printed sparsely — on the first and last
row, on either side of a blank line, and wherever the number changes from
the row above — so a run of identical values stays quiet and you read a
stop's service level from the last number printed above it. Above, 19 of
the 214 trips detour through the Front St loop.

This matters because an `alt` row is not necessarily a rare one. Whether a
stop lands in the main sequence or in an `alt` block is decided purely by
which pattern is longest, which has nothing to do with how often each
pattern runs — so a well-served stop can appear as an `alt` row while the
main sequence runs a once-a-day variant. The counts are what tell the two
apart. (`--full` output is unaffected; it has no `trips` column.)

Direction names come straight from SEPTA's static feed too — an
undocumented `directions.txt` extension maps each route's direction_id to
its real name (e.g. `"Northbound"`) directly, so no live data is involved
and the result is exactly as deterministic as everything else this prints.
The rare route with no scheduled trips at all (so `directions.txt` has
nothing to say about it either) shows `Unknown Direction (direction_id N --
not listed in SEPTA's directions.txt)` instead.

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
runtime polling never re-downloads it per-poll either (see
[DESIGN.md](DESIGN.md)) — it already downloads the same feed once daily for the schedule
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

Some routes share a stop and effectively behave like one route with several
headsigns — SEPTA's T1-T5 trolleys funneling through the same tunnel
corridor toward West Philly, or a bus route that happens to run alongside
another one for a few blocks. Set `routeId` to a comma-separated string
(`"T2,T3,T4,T5"`) instead of a single route_id to combine them into one row:

```js
{ routeId: "T2,T3,T4,T5", stopId: 20661, direction: "Westbound", label: "17" },
```

A bare JSON array (`routeId: ["T2", "T3", "T4", "T5"]`) works identically —
undocumented mainly because the comma-string form is easier to type, not
because it's discouraged.

Every sub-route still polls SEPTA fully independently (same detour
handling, same `secondaryStopId` support, same everything as an unmerged
route) — merging only changes how the results are displayed:

- The route label becomes `BUS` or `METRO` (SEPTA Metro is every route_id
  shaped like a letter — L/G/B/T/D/M — followed by a digit; anything else is
  a plain numbered bus route) — or your own `label`, if you set one, same
  override precedence as an unmerged route. The direction abbreviation next
  to it combines each sub-route's own direction in N/S/E/W order (`NEB` if
  one sub-route is Eastbound and another is Northbound).
- Arrival times from every sub-route are merged into one sorted list, same
  `maxArrivals`/`countdownWithinMinutes` limits as usual. Merged arrivals
  always carry a footnote marker (even when only one destination happens to
  be showing right now) since the mix of destinations can shift from one
  sub-route's trip to another's between polls.
- Below that: with `showHeadsigns: false`, one line resolving each
  contributing sub-route's marker(s), e.g. `T2(*), T4(*,†), T5(‡)`. With
  `showHeadsigns: true`, one line *per sub-route* instead of per headsign,
  e.g. `2 → Pulaski-Hunting Park(*)` and `17 → Front-Market(†), 2nd-Market(‡)`.
- `secondaryStopId` flags/omits exactly as it does for a single route,
  independently per sub-route.
- If one sub-route is detoured around the primary stop this cycle, it just
  contributes no arrivals — the rest of the group displays normally, no
  banner. A `DETOUR` banner only replaces the whole row when *every*
  sub-route is detoured at once.
- Every sub-route in the list must actually stop at the configured
  `stopId` — a mismatch (wrong route, a typo) is a warn-only config error,
  logged on each schedule refresh, same treatment as an unrecognized
  `routeId` elsewhere in this module. The on-screen "Invalid stop ID
  configured" note is deliberately *not* shown in that case: with the rest
  of the group still arriving normally, the stop itself is fine and it's
  the routeId list that's wrong. The note appears on a merged row only when
  *no* sub-route in the group stops there.

**Direction**: a single `direction` string applies to every sub-route,
which covers most merges (they usually share one cardinal direction). If
they don't — e.g. two routes that happen to run Northbound and Eastbound
through the same stop — `direction` can instead be a `{ routeId:
directionString }` map:

```js
{ routeId: "2,17", stopId: 40, direction: { "2": "Northbound", "17": "Eastbound" } },
```

This isn't just cosmetic. A stop occasionally really is served by both
directions of the same route (rare, but real — see "Known limitations"
above), and disambiguating that safely depends on knowing each sub-route's
own direction, not one borrowed from a different route in the group.

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
  e.g. route 2 stop 40, or T1-T5's shared 13th St tunnel terminus) is
  resolved in order, no config needed either way:
  1. If every one of one direction's patterns reaches the stop only as that
     pattern's own last stop (a dead end — no rider could board there and
     continue), that direction is excluded automatically and the other used.
  2. Otherwise, if SEPTA's static `directions.txt` calls exactly one of the
     stop's two direction_ids the same thing the configured `direction`
     says, that one is used — resolved with no live trip needed, unlike (3).
  3. Otherwise, falls back to a live trip's `direction_name`, which needs an
     actual trip running right now with a usable name. Routes whose live
     feed never gives one at all (confirmed: the trolleys, route 63, and
     `B1`/`B2`/`B3`/`L1` always report `"N/A"`) can never resolve this way.

  Genuinely unresolvable only when none of the three apply: neither
  direction is uniformly terminal, *and* `directions.txt` has no data for
  the route or the configured `direction` doesn't exactly match one of its
  two names, *and* no live trip with a usable name happens to be running.
  Wanting the excluded (terminal/arriving) side from (1) on purpose instead
  of the kept (departing) side also isn't handled — there's no way to ask
  for it.

## How it works

Design notes -- the polling model, schedule feed retention, when the display
fades, and a file-by-file rundown of the code -- live in
[DESIGN.md](DESIGN.md).
