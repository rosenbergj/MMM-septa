#!/usr/bin/env node
"use strict";

// Registers a banked GTFS zip into the module's feed store, so feed selection
// can use it (see gtfs-schedule.js's selectFeedForDate).
//
// Needed because SEPTA keeps no feed history: once it republishes
// google_bus.zip, the superseded feed is only recoverable from a copy you
// already had. This puts such a copy back into rotation.
//
// Usage:
//   node scripts/register-feed.js <path-to-google_bus.zip>
//
// Copies the zip into feeds/ if it isn't already there, reads its real
// feed_version out of feed_info.txt (the filename is never trusted), and adds
// it to feeds/index.json under the normal retention rules.
//
// Deliberately conservative: it never deletes a zip. If registering would
// push an existing feed out of the retained set, it stops and says so rather
// than silently discarding something SEPTA can no longer serve.

const fs = require("fs");
const path = require("path");
const {
  readZipEntries,
  parseFeedInfo,
  planFeedRetention,
  loadFeedIndex,
  saveFeedIndex,
  feedZipPath,
  selectFeedForDate,
  FEEDS_DIR,
} = require("../gtfs-schedule.js");

function fail(message) {
  console.error(`register-feed: ${message}`);
  process.exit(1);
}

function main() {
  const source = process.argv[2];
  if (!source || source === "--help" || source === "-h") {
    console.log("Usage: node scripts/register-feed.js <path-to-google_bus.zip>");
    process.exit(source ? 0 : 1);
  }
  if (!fs.existsSync(source)) fail(`no such file: ${source}`);

  const buffer = fs.readFileSync(source);
  let meta;
  try {
    const entry = readZipEntries(buffer, ["feed_info.txt"]).get("feed_info.txt");
    meta = parseFeedInfo(entry && entry.toString("utf8"));
  } catch (err) {
    fail(`could not read ${source} as a GTFS zip: ${err.message}`);
  }
  if (!meta || !meta.day) fail("that zip has no readable feed_version in feed_info.txt, so it can't be retained");

  console.log(`feed ${meta.version} (day ${meta.day}), covers ${meta.feedStartDate} to ${meta.feedEndDate}`);

  const existing = loadFeedIndex();
  if (existing.some((entry) => entry.version === meta.version)) {
    console.log("already registered; nothing to do.");
    return;
  }

  const incoming = { ...meta, etag: null, downloadedAt: Date.now(), registeredManually: true };
  const { keep, evict } = planFeedRetention(existing, incoming);

  if (!keep.some((entry) => entry.version === meta.version)) {
    fail(
      `${meta.version} is older than every retained feed ` +
        `(${existing.map((e) => e.version).join(", ")}), so registering it would have no effect.`
    );
  }
  if (evict.length) {
    fail(
      `registering ${meta.version} would drop ${evict.map((e) => e.version).join(", ")} from the retained set. ` +
        "Refusing: SEPTA no longer serves superseded feeds. Remove the unwanted entry from " +
        `${path.join(FEEDS_DIR, "index.json")} by hand if that's really what you want.`
    );
  }

  fs.mkdirSync(FEEDS_DIR, { recursive: true });
  const destination = feedZipPath(meta.version);
  if (path.resolve(source) !== path.resolve(destination)) {
    fs.copyFileSync(source, destination);
    console.log(`copied -> ${destination}`);
  }
  saveFeedIndex(keep);
  console.log(`registered. retained feeds: ${keep.map((e) => `${e.version} (day ${e.day})`).join(", ")}`);

  const today = new Date();
  const selected = selectFeedForDate(keep, today);
  console.log(
    selected
      ? `feed selected for today: ${selected.entry.version}`
      : "WARNING: no retained feed covers today -- the display will stay in live-only mode."
  );
  console.log("Restart MagicMirror for this to take effect.");
}

main();
