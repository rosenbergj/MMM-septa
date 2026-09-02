# Banked GTFS feeds

SEPTA serves exactly one `google_bus.zip` and **does not keep old versions**.
It also republishes the *next* service period's feed several days before that
period starts, so the live feed periodically has no service for today (see the
`SEPTA unpublishes the current day's GTFS` memory note). Once that happens the
superseded feed is unrecoverable from SEPTA.

These are banked copies. `feeds/` is gitignored -- they're ~21MB each.

| file | feed_version | covers from | banked |
|---|---|---|---|
| `google_bus-v202608233.zip` | v202608233 | 20260823 | 2026-09-02 11:05 EDT, ~1h before SEPTA replaced it |
| `google_bus-v202609060.zip` | v202609060 | 20260906 | 2026-09-02 12:00 EDT, the replacement |

`v202608233` is the only surviving copy of the feed covering Sept 2-5 2026.
Don't delete it until after 2026-09-06.
