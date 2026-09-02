#!/usr/bin/env node
"use strict";

// Diffs two banked SEPTA GTFS feeds and prints what changed between them.
//
// SEPTA serves exactly one google_bus.zip and keeps no history, so this is
// only possible because gtfs-schedule.js retains the last few feed "days"
// (see FEED_RETENTION_DAYS). Point it at any two zips -- typically the two in
// feeds/, or one of those against a copy banked before a schedule change.
//
// Usage:
//   node scripts/compare-feeds.js <old.zip> <new.zip> [--route 17] [--days 14]
//                                 [--from 20260902] [--headsigns] [--stops]
//
// Deliberately never reads stop_times.txt: it's ~100MB and nothing here needs
// per-stop times, so a full comparison runs in a couple of seconds.

const fs = require("fs");
const path = require("path");
const { readZipEntries, parseFeedInfo } = require("../gtfs-schedule.js");

const FILES = ["feed_info.txt", "routes.txt", "trips.txt", "calendar.txt", "calendar_dates.txt", "stops.txt"];

function printHelp() {
  console.log(`Usage: node scripts/compare-feeds.js <old.zip> <new.zip> [options]

Options:
  --route <id>    Restrict route/headsign detail to one route_id
  --days <n>      Days of service coverage to compare (default: 14)
  --from <date>   YYYYMMDD to start the coverage table (default: today)
  --headsigns     List per-route headsign additions/removals
  --stops         List added/removed stop_ids
  --help          Show this message
`);
}

function parseArgs(argv) {
  const opts = { days: 14, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--route") opts.route = argv[++i];
    else if (arg === "--days") opts.days = Number(argv[++i]);
    else if (arg === "--from") opts.from = argv[++i];
    else if (arg === "--headsigns") opts.headsigns = true;
    else if (arg === "--stops") opts.stops = true;
    else opts.positional.push(arg);
  }
  return opts;
}

// Minimal CSV: SEPTA quotes some name fields, so handle quotes, but nothing
// here needs embedded newlines.
function parseCsv(text) {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const header = splitLine(lines[0]).map((h) => h.trim().replace(/^﻿/, ""));
  return lines.slice(1).map((line) => {
    const cols = splitLine(line);
    const row = {};
    header.forEach((name, i) => (row[name] = (cols[i] || "").trim()));
    return row;
  });
}

function splitLine(line) {
  if (!line.includes('"')) return line.split(",");
  const out = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function loadFeed(zipPath) {
  const buffer = fs.readFileSync(zipPath);
  const found = readZipEntries(buffer, FILES);
  const texts = {};
  for (const name of FILES) {
    const data = found.get(name);
    if (data) texts[name] = data.toString("utf8");
  }
  const trips = parseCsv(texts["trips.txt"] || "");
  const routes = parseCsv(texts["routes.txt"] || "");
  const stops = parseCsv(texts["stops.txt"] || "");
  const calendar = {};
  for (const row of parseCsv(texts["calendar.txt"] || "")) calendar[row.service_id] = row;
  const exceptions = {};
  for (const row of parseCsv(texts["calendar_dates.txt"] || "")) {
    (exceptions[row.service_id] = exceptions[row.service_id] || {})[row.date] = row.exception_type;
  }
  return {
    label: path.basename(zipPath),
    info: parseFeedInfo(texts["feed_info.txt"]),
    sizeBytes: buffer.length,
    trips,
    routeNames: new Map(routes.map((r) => [r.route_id, r.route_long_name || r.route_short_name || ""])),
    stops: new Map(stops.map((s) => [s.stop_id, s.stop_name])),
    calendar,
    exceptions,
  };
}

const DOW = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function serviceActive(feed, serviceId, yyyymmdd, dowName) {
  const exception = feed.exceptions[serviceId] && feed.exceptions[serviceId][yyyymmdd];
  if (exception === "1") return true;
  if (exception === "2") return false;
  const cal = feed.calendar[serviceId];
  return Boolean(cal) && cal[dowName] === "1" && cal.start_date <= yyyymmdd && yyyymmdd <= cal.end_date;
}

function tripsOnDate(feed, date) {
  const key =
    `${date.getFullYear()}` +
    `${String(date.getMonth() + 1).padStart(2, "0")}` +
    `${String(date.getDate()).padStart(2, "0")}`;
  const dowName = DOW[date.getDay()];
  const active = new Set();
  const serviceIds = new Set([...Object.keys(feed.calendar), ...Object.keys(feed.exceptions)]);
  for (const serviceId of serviceIds) {
    if (serviceActive(feed, serviceId, key, dowName)) active.add(serviceId);
  }
  return { key, dowName, count: feed.trips.filter((t) => active.has(t.service_id)).length };
}

function countBy(list, keyFn) {
  const out = new Map();
  for (const item of list) out.set(keyFn(item), (out.get(keyFn(item)) || 0) + 1);
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.positional.length !== 2) {
    printHelp();
    process.exit(opts.help ? 0 : 1);
  }
  const [oldFeed, newFeed] = opts.positional.map(loadFeed);

  console.log("=".repeat(72));
  for (const feed of [oldFeed, newFeed]) {
    const i = feed.info;
    console.log(
      `${feed.label}\n  version ${i ? i.version : "(none)"}  covers from ${i ? i.feedStartDate : "?"} ` +
        `to ${i ? i.feedEndDate : "?"}  ${(feed.sizeBytes / 1e6).toFixed(1)}MB  ${feed.trips.length.toLocaleString()} trips`
    );
  }

  // Service coverage -- the thing that actually bites, and the reason the
  // feed store exists: a feed can be perfectly valid and still answer nothing
  // for the days you care about.
  console.log("\n" + "-".repeat(72) + "\nSERVICE COVERAGE");
  const start = opts.from
    ? new Date(Number(opts.from.slice(0, 4)), Number(opts.from.slice(4, 6)) - 1, Number(opts.from.slice(6, 8)))
    : new Date();
  console.log(`${"date".padEnd(12)}${"day".padEnd(5)}${"old".padStart(9)}${"new".padStart(9)}`);
  for (let i = 0; i < opts.days; i++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const a = tripsOnDate(oldFeed, date);
    const b = tripsOnDate(newFeed, date);
    let flag = "";
    if (a.count && !b.count) flag = "   <-- only the OLD feed covers this day";
    if (!a.count && b.count) flag = "   <-- only the NEW feed covers this day";
    console.log(
      `${a.key.padEnd(12)}${a.dowName.slice(0, 3).padEnd(5)}${a.count.toLocaleString().padStart(9)}` +
        `${b.count.toLocaleString().padStart(9)}${flag}`
    );
  }

  // Routes
  const oldRoutes = countBy(oldFeed.trips, (t) => t.route_id);
  const newRoutes = countBy(newFeed.trips, (t) => t.route_id);
  const added = [...newRoutes.keys()].filter((r) => !oldRoutes.has(r)).sort();
  const removed = [...oldRoutes.keys()].filter((r) => !newRoutes.has(r)).sort();
  console.log("\n" + "-".repeat(72) + "\nROUTES");
  console.log(`  old ${oldRoutes.size}, new ${newRoutes.size}`);
  if (added.length) console.log(`  ADDED:   ${added.map((r) => `${r} (${newFeed.routeNames.get(r) || "?"})`).join(", ")}`);
  if (removed.length) console.log(`  REMOVED: ${removed.map((r) => `${r} (${oldFeed.routeNames.get(r) || "?"})`).join(", ")}`);
  if (!added.length && !removed.length) console.log("  no routes added or removed");

  const shared = [...newRoutes.keys()].filter((r) => oldRoutes.has(r));
  const changed = shared
    .map((r) => ({ route: r, delta: newRoutes.get(r) - oldRoutes.get(r), from: oldRoutes.get(r), to: newRoutes.get(r) }))
    .filter((c) => c.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const shownChanges = opts.route ? changed.filter((c) => c.route === opts.route) : changed.slice(0, 20);
  console.log(`\n  trip-count changes (${changed.length} routes changed${opts.route ? "" : ", top 20"}):`);
  if (!shownChanges.length) console.log("    none");
  for (const c of shownChanges) {
    console.log(
      `    ${c.route.padEnd(8)} ${String(c.from).padStart(5)} -> ${String(c.to).padStart(5)} ` +
        `(${c.delta > 0 ? "+" : ""}${c.delta})  ${newFeed.routeNames.get(c.route) || ""}`
    );
  }

  if (opts.headsigns) {
    console.log("\n" + "-".repeat(72) + "\nHEADSIGNS");
    const routesToCheck = opts.route ? [opts.route] : shared;
    let reported = 0;
    for (const route of routesToCheck) {
      const before = new Set(oldFeed.trips.filter((t) => t.route_id === route).map((t) => t.trip_headsign));
      const after = new Set(newFeed.trips.filter((t) => t.route_id === route).map((t) => t.trip_headsign));
      const gone = [...before].filter((h) => !after.has(h));
      const fresh = [...after].filter((h) => !before.has(h));
      if (!gone.length && !fresh.length) continue;
      reported++;
      console.log(`  route ${route}:`);
      for (const h of gone) console.log(`    - ${h}`);
      for (const h of fresh) console.log(`    + ${h}`);
    }
    if (!reported) console.log("  no headsign changes");
  }

  if (opts.stops) {
    console.log("\n" + "-".repeat(72) + "\nSTOPS");
    const addedStops = [...newFeed.stops.keys()].filter((s) => !oldFeed.stops.has(s));
    const removedStops = [...oldFeed.stops.keys()].filter((s) => !newFeed.stops.has(s));
    console.log(`  old ${oldFeed.stops.size}, new ${newFeed.stops.size}, +${addedStops.length} / -${removedStops.length}`);
    for (const s of removedStops.slice(0, 25)) console.log(`    - ${s}  ${oldFeed.stops.get(s)}`);
    if (removedStops.length > 25) console.log(`    ... and ${removedStops.length - 25} more removed`);
    for (const s of addedStops.slice(0, 25)) console.log(`    + ${s}  ${newFeed.stops.get(s)}`);
    if (addedStops.length > 25) console.log(`    ... and ${addedStops.length - 25} more added`);
  }
}

main();
