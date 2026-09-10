#!/usr/bin/env node
"use strict";

// Measures how well inferDetourSpanStops guesses, by running it against the detours where SEPTA *did* publish skipped_stops
// -- the one population where there's a ground truth to score against.
//
// Production deliberately never infers for those
// (findInferredDetourCandidates drops any detour carrying skipped_stops, because SEPTA's own list is better).
// This script inverts exactly that one filter and keeps the rest,
// so what it scores is the same geometry the mirror runs, on the only detours that can be marked right or wrong.
//
// Two numbers matter, and they pull against each other:
//   containment -- did the inferred span include every stop SEPTA listed?
//                  This is the headline; it's what "about two-thirds of the
//                  time" in the README refers to.
//   width       -- how many stops the span covers versus how many SEPTA
//                  listed. A span that swallows the whole route contains
//                  everything and tells you nothing, so containment alone
//                  can be gamed by getting wider.
//
// Usage:
//   node scripts/measure-detour-inference.js [--route 17] [--json out.json]
//
// Detour coverage is time-of-day dependent -- overnight, most routes aren't running and few detours are active
// -- so a single run is a snapshot, not a verdict.
// Compare runs taken at comparable times.

const fs = require("fs");
const path = require("path");
const { fetchDetours, detourSkippedStopIds, parseSeptaDateTime } = require("../septa-client.js");
const {
  readZipEntries,
  parseRouteStopPaths,
  parseStopLatLon,
  parseFeedInfo,
  inferDetourSpanStops,
  detourTurnPoints,
  loadFeedIndex,
  feedZipPath,
  orderFeedsNewestFirst,
} = require("../gtfs-schedule.js");

// Matches findInferredDetourCandidates.
// Kept in sync by hand rather than imported, because this needs the opposite skipped_stops test and importing would mean threading a flag through production code for a diagnostic.
const MAX_DAYS = 28;
const CONCURRENCY = 4;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--route") opts.route = argv[++i];
    else if (argv[i] === "--json") opts.json = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") opts.help = true;
  }
  return opts;
}

function newestFeedPath() {
  const entries = orderFeedsNewestFirst(loadFeedIndex());
  if (!entries.length) throw new Error("no banked feeds -- run scripts/register-feed.js first");
  return feedZipPath(entries[0].version);
}

// Ground-truth population: active now, short enough that production would still consider it news,
// at least two turn points to locate, AND a non-empty skipped_stops to score against.
function isScorable(detour, now) {
  if (!detour) return false;
  if (detourSkippedStopIds(detour).length === 0) return false;
  const start = parseSeptaDateTime(detour.start);
  const end = parseSeptaDateTime(detour.end);
  if (!start || !end) return false;
  if (!(now > start && now < end)) return false;
  if ((end - start) / 86400000 > MAX_DAYS) return false;
  return detourTurnPoints(detour).length >= 2;
}

async function mapWithLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const index = i++;
        out[index] = await fn(items[index]);
      }
    })
  );
  return out;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: node scripts/measure-detour-inference.js [--route <id>] [--json <path>]");
    return;
  }

  const feedPath = newestFeedPath();
  const zip = readZipEntries(fs.readFileSync(feedPath), ["route_stops.txt", "stops.txt", "routes.txt", "feed_info.txt"]);
  const routeStopsText = zip.get("route_stops.txt");
  if (!routeStopsText) throw new Error(`${path.basename(feedPath)} has no route_stops.txt`);
  const stopLatLon = parseStopLatLon(zip.get("stops.txt").toString("utf8"));
  const feedInfo = parseFeedInfo(zip.get("feed_info.txt") && zip.get("feed_info.txt").toString("utf8"));

  const routeIds = zip
    .get("routes.txt")
    .toString("utf8")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(",")[0])
    .filter(Boolean);
  const targets = opts.route ? [opts.route] : routeIds;

  // Unfiltered by route: the switch to route_stops.txt made building every route's path cheap enough to just do (no stop_times.txt scan at all).
  const cache = { routeStopPaths: parseRouteStopPaths(routeStopsText.toString("utf8"), routeIds, stopLatLon) };

  const now = new Date();
  console.log(`feed ${feedInfo ? feedInfo.version : "?"}, ${Object.keys(cache.routeStopPaths).length} route/direction paths`);
  console.log(`fetching detours for ${targets.length} route(s) at ${now.toISOString()} ...`);

  let fetchFailures = 0;
  const perRoute = await mapWithLimit(targets, CONCURRENCY, async (routeId) => {
    try {
      return { routeId, detours: await fetchDetours(routeId) };
    } catch {
      fetchFailures++;
      return { routeId, detours: [] };
    }
  });

  const results = [];
  let noPath = 0;
  let noSpan = 0;
  for (const { routeId, detours } of perRoute) {
    for (const detour of Array.isArray(detours) ? detours : []) {
      if (!isScorable(detour, now)) continue;
      const directionId = detour.direction_id != null ? String(detour.direction_id) : null;
      if (directionId == null || !cache.routeStopPaths[`${routeId}|${directionId}`]) {
        noPath++;
        continue;
      }
      const span = inferDetourSpanStops(cache, routeId, directionId, detour);
      if (!span) {
        noSpan++;
        continue;
      }
      const listed = detourSkippedStopIds(detour).map(String);
      const hit = listed.filter((id) => span.has(id));
      results.push({
        routeId,
        directionId,
        reason: (detour.reason || "").trim() || null,
        listedCount: listed.length,
        spanCount: span.size,
        hitCount: hit.length,
        containsAll: hit.length === listed.length,
        missed: listed.filter((id) => !span.has(id)),
      });
    }
  }

  console.log("");
  console.log("-".repeat(66));
  if (fetchFailures) console.log(`  ${fetchFailures} route(s) failed to fetch (SEPTA flakiness) -- excluded`);
  console.log(`  scorable detours (active, <=${MAX_DAYS}d, >=2 turn points, skipped_stops listed): ${results.length}`);
  if (noPath) console.log(`  skipped, no stop path for that route/direction: ${noPath}`);
  if (noSpan) console.log(`  skipped, span inference declined: ${noSpan}`);

  if (!results.length) {
    console.log("\n  Nothing to score. Detour coverage varies by time of day -- try again midday.");
    return;
  }

  const containedAll = results.filter((r) => r.containsAll).length;
  const totalListed = results.reduce((n, r) => n + r.listedCount, 0);
  const totalHit = results.reduce((n, r) => n + r.hitCount, 0);
  const widthRatios = results.filter((r) => r.listedCount > 0).map((r) => r.spanCount / r.listedCount);

  console.log("");
  console.log(`  CONTAINMENT  span contained every listed stop: ${containedAll}/${results.length} (${((100 * containedAll) / results.length).toFixed(0)}%)`);
  console.log(`               individual listed stops covered:  ${totalHit}/${totalListed} (${((100 * totalHit) / totalListed).toFixed(0)}%)`);
  console.log(`  WIDTH        median span / listed stops:       ${median(widthRatios).toFixed(1)}x`);
  console.log(`               median span size:                 ${median(results.map((r) => r.spanCount))} stops`);
  console.log(`               median listed size:               ${median(results.map((r) => r.listedCount))} stops`);

  console.log("\n  per detour:");
  for (const r of results.sort((a, b) => Number(a.containsAll) - Number(b.containsAll))) {
    console.log(
      `    ${r.containsAll ? "OK  " : "MISS"} route ${String(r.routeId).padEnd(8)} dir ${r.directionId}  ` +
        `listed ${String(r.listedCount).padStart(3)}  span ${String(r.spanCount).padStart(3)}  ` +
        `covered ${r.hitCount}/${r.listedCount}${r.reason ? "  (" + r.reason + ")" : ""}`
    );
  }

  if (opts.json) {
    fs.writeFileSync(opts.json, JSON.stringify({ measuredAt: now.toISOString(), feed: feedInfo, results }, null, 2));
    console.log(`\n  wrote ${opts.json}`);
  }
}

main().catch((err) => {
  console.error(`measure-detour-inference: ${err.message}`);
  process.exit(1);
});
