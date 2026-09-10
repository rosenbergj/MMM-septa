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
to `directions.txt` (see "Finding your route and stop IDs" above): the
newest feed that has one is held back indefinitely if SEPTA ever ships a feed
without it, rather than aging out on the usual two-day schedule.

If both retained feeds are newer than today, the display drops to live-only
data as before, and logs why.

`node scripts/compare-feeds.js <old.zip> <new.zip>` prints what changed
between two feeds -- service coverage per day, routes added/removed, trip
counts, direction name changes, and with `--headsigns`/`--stops`, those too.

## How often the display fades

The module fades out and back in **only when a poll actually brings something
new to show** -- roughly once per `refreshIntervalSeconds`, and not even then
if SEPTA returned the same arrivals as last time. The fade is meant to read as
"this data just changed", so it's worth keeping rare.

Two things it deliberately does *not* fade for:

- **Countdown ticks.** The "Nm" values re-render every
  `countdownTickSeconds`, but instantly, with no fade. With several arrivals
  on screen at once at least one digit changes on most ticks, so fading these
  would blink the module roughly every 15-20 seconds.
- **Polls that changed nothing.** If a refresh produces a display identical to
  what's already on screen, nothing is re-rendered at all.

Configured routes are also polled on a shared schedule, spread across a few
seconds, so one refresh cycle arrives as a single batch and produces one fade
rather than one per route.

## File by file

- `septa-client.js` — pure SEPTA API client + filtering logic (detours,
  trip filtering, stop-time filtering, staleness), fully unit tested.
- `node_helper.js` — runs one polling loop per configured route on the
  backend, pushes results to the frontend over MagicMirror's socket
  notifications. Polls are kept as light as they can be: routes share a
  single aligned schedule (staggered a second or so apart), rows on the
  same route share one `/detours/` and `/trips/` response per cycle, and
  no `/trip-update/` is requested for a bus SEPTA already reports as past
  your stop. On a four-route setup that's roughly 23 requests per cycle
  down to 13, with identical arrivals on screen.
- `MMM-septa.js` — renders the last known state per route, and re-renders
  the "Nm" countdowns every `countdownTickSeconds` without needing a
  fresh backend fetch (see "How often the display fades"). When a detour affects the configured stop, shows
  "DETOUR" (with SEPTA's stated reason, e.g. "DETOUR: Sinkhole", if one
  was provided) instead of arrival times. The route label is followed by
  a small direction abbreviation (e.g. "17 NB"). The route number itself is
  colored using SEPTA's own colors, read from the static GTFS feed's
  `routes.txt`. Every real color in the feed is used: Metro and trolley
  routes get their brand color (e.g. Market-Frankford Line blue, Broad St
  Line orange), a route in SEPTA's frequent bus network gets the same red
  SEPTA uses for it on stop signage (25 routes as of the Sept 2026 feed —
  3, 6, 17, 18, 21, 23, 25, 33, 46, 47, 48, 51, 52, 56, 57, 58, 60, 63, 64,
  66, 70, 79, 82, 108, 113), and the bus services that stand in for a Metro
  line or run their own branded loop get theirs (`L1_OWL` and `B1_OWL` in
  their parent line's color, `T_BUS`, `D1_BUS`/`D2_BUS`, `M1_BUS`, the two
  LUCY loops, `BLVDDIR`, and the `FXCB`/`NOR_BUS`/`WTR_BUS` shuttles). Some
  of those deliberately match the line they replace — `M1_BUS` is drawn in
  M1's purple because SEPTA means it to read as M1.

  Ordinary bus routes are the exception: they carry a near-black in
  `routes.txt` that would be invisible on a mirror, so they keep the default
  label color instead. The colors ride along in the GTFS schedule cache, so
  they need no separate fetch and a restart shows them immediately. Each route also gets
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
  Two arrival times joined by a slash (e.g. "8m/15m") are the **same
  vehicle** serving your stop twice on one trip -- a mid-route loop or an
  out-and-back spur, which a handful of SEPTA routes really do (route 107
  serves Marshall Rd & Sloan St twice, about six minutes apart). A note
  saying so appears below the row whenever that happens. Two visits are
  only joined when they're next to each other in the list; if a different
  bus falls between them they're shown normally.
  The nearest arrival is shown larger/brighter than the
  rest. Countdowns round **down**, so "3m" means at least three minutes
  away and a bus under a minute out shows "0m" -- the display would
  rather send you to the stop early than tell you a 2m30s bus is 3m off.
  For the same reason `warnMinutes` and `countdownWithinMinutes` can
  trigger up to a minute earlier than the exact arithmetic would suggest. With `useScheduleSupplement` on (the default), arrivals SEPTA
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
