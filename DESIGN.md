# MMM-septa — design notes

How this module is built and why. For installing and configuring it, see
[README.md](README.md); this file assumes you already have it running.

## Schedule feed retention

SEPTA publishes one `google_bus.zip` and keeps no older versions. It also
republishes the **next** service period's feed several days before that period
begins -- so for a few days the only feed you can download has no service for
today, and the module falls back to "Realtime data only; schedule data
unavailable".

To survive that, the module keeps the last two feeds it has seen in `feeds/`
next to the module (about 21MB each, created automatically) and builds its
schedule from **the newest retained feed that actually covers today** -- which
during a changeover is the older one. It re-checks at each service-day
rollover, so the switch to the new feed happens on its own. The feed is only
re-downloaded when SEPTA's copy actually changes.

A feed is never discarded while it's the only retained one covering today, so
if SEPTA publishes two future-dated feeds in a row the module holds three
until it no longer needs the oldest. The same protection separately applies
to `directions.txt`, which supplies direction names everywhere the module needs
them (see "Resolving direction at a two-direction stop" below): the newest feed
that has one is held back indefinitely if SEPTA ever ships a feed without it,
rather than aging out on the usual two-day schedule.

If both retained feeds are newer than today, the display drops to live-only
data and logs why.

`node scripts/compare-feeds.js <old.zip> <new.zip>` prints what changed
between two feeds -- service coverage per day, routes added or removed, trip
counts, direction names, route colors (frequent-network membership first),
and with `--headsigns`/`--stops`, those too.

## How often the display fades

The module fades out and back in **only when a live poll actually brings
something new to show** -- roughly once per `refreshIntervalSeconds`, and not
even then if SEPTA returned the same arrivals as last time. The fade is meant
to read as "this data just changed", so it's worth keeping rare.

Two things it deliberately does *not* fade for:

- **Countdown ticks.** The "Nm" values re-render every
  `countdownTickSeconds`, but instantly, with no fade. With several arrivals
  on screen at once at least one digit changes on most ticks, so fading these
  would blink the module roughly every 15-20 seconds.
- **Live polls that changed nothing.** If a live poll produces a display
  identical to what's already on screen, nothing is re-rendered at all.

Configured routes are also polled on a shared schedule, spread across a few
seconds, so one round of live polls arrives as a single batch and produces one
fade rather than one per route.

## What the display shows

- **Detours.** When a detour skips the configured stop, the row shows
  "DETOUR" instead of arrival times, with SEPTA's stated reason if it gave one
  (e.g. "DETOUR: Sinkhole").
- **The route label** is followed by a small direction abbreviation (e.g.
  "17 NB").
- **Route colors** come from SEPTA's own colors in the static feed's
  `routes.txt`, and every real color in it is used. Metro and trolley routes
  get their brand color (Market-Frankford Line blue, Broad St Line orange); a
  route in SEPTA's frequent bus network gets the same red SEPTA puts on its
  stop signage (25 routes as of the Sept 2026 feed -- 3, 6, 17, 18, 21, 23, 25,
  33, 46, 47, 48, 51, 52, 56, 57, 58, 60, 63, 64, 66, 70, 79, 82, 108, 113);
  and the buses that stand in for a Metro line or run their own branded loop
  get theirs (`L1_OWL` and `B1_OWL` in their parent line's color, `T_BUS`,
  `D1_BUS`/`D2_BUS`, `M1_BUS`, the two LUCY loops, `BLVDDIR`, and the
  `FXCB`/`NOR_BUS`/`WTR_BUS` shuttles). Some deliberately match the line they
  replace -- `M1_BUS` is drawn in M1's purple because SEPTA means it to read as
  M1. Ordinary bus routes are the exception: they carry a near-black in
  `routes.txt` that would be invisible on a mirror, so they keep the default
  label color. The colors ride along in the schedule cache, so they need no
  separate fetch and a restart shows them immediately.
- **The stop-name header** (e.g. "20th St & Oregon Av") is discovered from
  SEPTA's live data, with no config needed, and cached once known, so it
  doesn't disappear during a live poll with no active trips. If two routes
  configured back-to-back share the same `stopId`, the header prints once
  rather than repeating; a route with a different stop in between resets that,
  so the header reprints rather than grouping routes out of the order you
  configured them in.
- **Destinations.** Each arrival carries its own trip's destination. When
  every shown arrival agrees, it's a full-width line below the route (e.g.
  "→ Front-Market") -- not squeezed into the label column, which would stretch
  it for every route once a longer note is involved (see README's "Secondary
  stop"). When they don't agree, each distinct destination gets a footnote
  marker (\*, †, ‡, ...) on its times (e.g. "14m* 22m†"), with every destination
  listed on its own line below (e.g. "→ 20th-Johnston(*)" / "→ Broad-Pattison(†)").
  Marker assignment is stable across live polls: node_helper derives it from
  every headsign the route and stop is ever scheduled to see, not just
  whichever trip happens to be next, so a destination keeps its marker as
  different trips rotate through. `showHeadsigns: false` hides both the
  destination lines and the markers for a more compact display -- see README's
  "Secondary stop" for how it also changes secondary-stop handling.
- **A slash between two times** (e.g. "8m/15m") means the **same vehicle**
  serves your stop twice on one trip -- a mid-route loop or an out-and-back
  spur, which a handful of SEPTA routes really do (route 107 serves Marshall Rd
  & Sloan St twice, about six minutes apart). A note saying so appears below
  the row. Two visits are joined only when they're next to each other in the
  list; if a different bus falls between them they're shown normally.
- **The nearest arrival** is shown larger and brighter than the rest.
- **Countdowns round down**, so "3m" means at least three minutes away and a bus
  under a minute out shows "0m" -- the display would rather send you to the
  stop early than tell you a 2m30s bus is 3m off. For the same reason
  `warnMinutes` and `countdownWithinMinutes` can trigger up to a minute earlier
  than the exact arithmetic would suggest.
- **Untracked arrivals.** With `useScheduleSupplement` on (the default),
  arrivals SEPTA hasn't started GPS-tracking yet -- still at their first stop,
  no vehicle assigned, or otherwise not "real-time" -- are shown too, styled
  "~Nm" (italic, muted). The one exception: a trip with no vehicle assigned at
  all ("NO GPS") has no real delay data behind its ETA (these can sit unchanged
  for most of an hour, or vanish, without ever getting a vehicle), so if a
  later, fully confirmed arrival already exists, the "NO GPS" one is dropped
  rather than shown ahead of it. A trip still at its first stop but with a real
  assigned vehicle is unaffected -- its GPS and delay data are trustworthy,
  just not yet "in progress".

## Resolving direction at a two-direction stop

Most stops are served by one direction of a route, so the configured
`direction` is just a label. A few are genuinely served by both — route 2 at
stop 40, or T1-T5's shared 13th St tunnel terminus — and those are resolved in
this order, without any config:

1. **Terminal exclusion.** If every one of one direction's patterns reaches the
   stop only as that pattern's own last stop, nobody could board there and
   continue, so that direction is excluded and the other is used. This is what
   handles a tunnel-portal terminus, where one direction's trips all end and
   the other's all begin.
2. **`directions.txt` name match.** Otherwise, if SEPTA's static
   `directions.txt` gives exactly one of the stop's two direction_ids the same
   name as the configured `direction`, that one wins. No live trip needed.
3. **Live `direction_name`.** Otherwise, fall back to a running trip's own
   direction name — which requires a trip to be running *and* to report a
   usable name. Live names are unusable on a number of routes -- `"N/A"` on
   route 63 and `B1`/`B2`/`B3`/`L1`, `"N/A"` or wrong on T1-T5, and G1 calls
   both its directions "Northbound" -- so those can't resolve this way.

Unresolvable only when all three fail at once: neither direction is uniformly
terminal, `directions.txt` has no data for the route or the configured
`direction` doesn't exactly match one of its names, and no live trip with a
usable name is running.

Asking for the *excluded* side of (1) on purpose — the arriving platform at a
terminus rather than the departing one — isn't supported.

## Comment style

Comments use **semantic line breaks**: one sentence per line, no hard wrapping
to a column. Long sentences break at a clause (` -- `, `; `, `, and `) rather
than mid-phrase.

This is not cosmetic. Hard-wrapped paragraphs reflow entirely when one word
changes, so a one-word edit shows up as twenty changed lines and real changes
get lost in the churn. One sentence per line means a one-sentence edit touches
one line.

Lines can exceed 100 characters and that is fine. Editors soft-wrap; diffs
don't.

Two shapes are deliberately left hard-wrapped, because their line breaks carry
meaning: bulleted or numbered lists, and label lists (consecutive lines opening
`Usage:`, `Example:`, `options.fetchImpl:`). Don't reflow those into prose.

When editing an existing comment, match the surrounding style rather than
rewrapping the block.

## File by file

- `septa-client.js` — pure client for SEPTA's live v2 API (`/detours/`,
  `/trips/`, `/trip-update/`) plus the filtering logic: detours, trip
  filtering, stop-time filtering, staleness. Fully unit tested.
- `node_helper.js` — the backend. Runs one polling loop per configured route
  and pushes results to the frontend over MagicMirror's socket notifications.
  Live polls are kept as light as they can be: routes share a single aligned
  schedule (staggered a second or so apart), rows on the same route share one
  `/detours/` and `/trips/` response per round, and no `/trip-update/` is
  requested for a bus SEPTA already reports as past your stop -- on a
  four-route setup, roughly 23 requests per round down to 13, with identical
  arrivals on screen. It also runs the daily schedule refresh (first run ~60
  seconds after startup, then daily, retrying hourly on failure) and the
  config validators, which check routeIds, stopIds, secondary stops and
  directions against the feed and log only when they object.
- `MMM-septa.js` (with `css/`) — renders the last known state per route, and
  re-renders the "Nm" countdowns every `countdownTickSeconds` without needing
  a backend fetch. See "What the display shows".
- `gtfs-schedule.js` — everything read from SEPTA's static GTFS feed, with no
  sqlite, no GTFS-realtime protobuf and no full-feed database. It fills in
  arrivals up to `scheduleHorizonMinutes` out (60 by default, 720 at most) that
  live tracking doesn't cover yet, also shown "~Nm": `node_helper.js`
  downloads the feed and filters it down to your configured routes and stops
  at each daily schedule refresh (never on the live-poll path), caching the
  small result to `gtfs-cache.json` next to the module so a restart doesn't
  require re-downloading. That file is gitignored and safe to delete anytime;
  the next daily schedule refresh rebuilds it. A scheduled arrival is dropped
  if it's no later than the latest live-tracked arrival (live data should
  already cover anything that imminent) or if it's the same trip as one
  already shown. The same pass resolves your configured stops' names as a
  fallback for when live data hasn't, and reads SEPTA's extension files --
  `directions.txt` for direction names, `routes.txt` for route colors,
  `route_stops.txt` for the stop paths detour inference needs. All three are
  optional, so a feed without them still builds a normal cache. It also owns
  feed retention (see "Schedule feed retention") and the stop-pattern listing
  `scripts/find-stop.js` prints.
- `route-config.js` — pure config parsing, unit tested. Splits a merged
  `routeId` (`"T2,T3,T4,T5"`, or an array) into its route_ids, resolves the
  configured `direction` for each sub-route (a string, or a
  `{ routeId: direction }` map), and resolves `scheduleHorizonMinutes`.
- `scripts/find-stop.js` — finds route and stop IDs from the static feed
  alone, merging each direction's patterns into one listing with trip counts;
  `--full` prints ready-to-paste config entries.
- `scripts/dry-run.js` — a live smoke test of the same `pollRoute` path the
  module uses.
- `scripts/compare-feeds.js` — diffs two banked feeds (see "Schedule feed
  retention"). It never reads `stop_times.txt`, so a full comparison takes a
  couple of seconds.
- `scripts/register-feed.js` — puts a banked `google_bus.zip` back into the
  feed store, reading its real `feed_version` from `feed_info.txt`. It never
  deletes a zip, and refuses rather than push an existing feed out of the
  retained set.
- `scripts/measure-detour-inference.js` — scores detour inference against the
  detours where SEPTA *did* list the skipped stops, reporting both containment
  and span width, since containment alone can be gamed by a wider span.

The scripts all run with plain `node`; none needs MagicMirror.
