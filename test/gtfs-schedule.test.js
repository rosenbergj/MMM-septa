"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  readZipEntries,
  parseTripsForRoutes,
  parseStops,
  parseStopTimesForTrips,
  parseCalendar,
  parseCalendarDates,
  isServiceActiveOn,
  buildScheduleCache,
  buildRouteStopPatterns,
  mergeDirectionPatterns,
  getScheduledArrivals,
  getAllHeadsignsForStop,
  getHeadsignsSkippingStop,
  loadCacheFromDisk,
  saveCacheToDisk,
  fetchScheduleCache,
  fetchRouteStopPatterns,
} = require("../gtfs-schedule.js");

// Hand-builds a minimal, valid ZIP archive (local file headers + central
// directory + end-of-central-directory) from an in-memory {name, content,
// method} list, so readZipEntries can be tested without any real file or
// third-party zip library. method: 0 = stored, 8 = deflate (matches what
// real ZIP tools use for GTFS feeds).
function buildTestZip(files) {
  const chunks = [];
  const centralDirEntries = [];
  let offset = 0;

  for (const { name, content, method = 8 } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const contentBuf = Buffer.from(content, "utf8");
    const compressed = method === 8 ? zlib.deflateRawSync(contentBuf) : contentBuf;

    const localHeaderOffset = offset;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10); // mod time
    lfh.writeUInt16LE(0, 12); // mod date
    lfh.writeUInt32LE(0, 14); // crc32 (unchecked by our reader)
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(contentBuf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra length

    chunks.push(lfh, nameBuf, compressed);
    offset += lfh.length + nameBuf.length + compressed.length;

    centralDirEntries.push({ name: nameBuf, method, compressed, contentBuf, localHeaderOffset });
  }

  const cdStart = offset;
  for (const entry of centralDirEntries) {
    const cdfh = Buffer.alloc(46);
    cdfh.writeUInt32LE(0x02014b50, 0);
    cdfh.writeUInt16LE(20, 4); // version made by
    cdfh.writeUInt16LE(20, 6); // version needed
    cdfh.writeUInt16LE(0, 8); // flags
    cdfh.writeUInt16LE(entry.method, 10);
    cdfh.writeUInt16LE(0, 12); // mod time
    cdfh.writeUInt16LE(0, 14); // mod date
    cdfh.writeUInt32LE(0, 16); // crc32
    cdfh.writeUInt32LE(entry.compressed.length, 20);
    cdfh.writeUInt32LE(entry.contentBuf.length, 24);
    cdfh.writeUInt16LE(entry.name.length, 28);
    cdfh.writeUInt16LE(0, 30); // extra length
    cdfh.writeUInt16LE(0, 32); // comment length
    cdfh.writeUInt16LE(0, 34); // disk number start
    cdfh.writeUInt16LE(0, 36); // internal attrs
    cdfh.writeUInt32LE(0, 38); // external attrs
    cdfh.writeUInt32LE(entry.localHeaderOffset, 42);

    chunks.push(cdfh, entry.name);
    offset += cdfh.length + entry.name.length;
  }
  const cdEnd = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centralDirEntries.length, 8);
  eocd.writeUInt16LE(centralDirEntries.length, 10);
  eocd.writeUInt32LE(cdEnd - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

test("readZipEntries", async (t) => {
  await t.test("extracts a stored (uncompressed) entry", () => {
    const zip = buildTestZip([{ name: "a.txt", content: "hello world", method: 0 }]);
    const result = readZipEntries(zip, ["a.txt"]);
    assert.equal(result.get("a.txt").toString("utf8"), "hello world");
  });

  await t.test("extracts a deflated entry", () => {
    const zip = buildTestZip([{ name: "b.txt", content: "deflate me please", method: 8 }]);
    const result = readZipEntries(zip, ["b.txt"]);
    assert.equal(result.get("b.txt").toString("utf8"), "deflate me please");
  });

  await t.test("extracts only the wanted subset from a multi-entry archive", () => {
    const zip = buildTestZip([
      { name: "wanted.txt", content: "keep this" },
      { name: "unwanted.txt", content: "ignore this" },
      { name: "also-wanted.txt", content: "keep this too" },
    ]);
    const result = readZipEntries(zip, ["wanted.txt", "also-wanted.txt"]);
    assert.equal(result.size, 2);
    assert.equal(result.get("wanted.txt").toString("utf8"), "keep this");
    assert.equal(result.get("also-wanted.txt").toString("utf8"), "keep this too");
    assert.equal(result.has("unwanted.txt"), false);
  });

  await t.test("missing end-of-central-directory record throws", () => {
    assert.throws(() => readZipEntries(Buffer.from("not a zip"), ["a.txt"]));
  });
});

test("parseTripsForRoutes", async (t) => {
  const csv =
    "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,shape_id,wheelchair_accessible,bikes_allowed\n" +
    "17,10,1001,Front-Market,,0,1,1,1,1\n" +
    '64,11,2001,"Columbus, Blvd Pier 70",,1,2,2,1,1\n' +
    "999,12,3001,Somewhere Else,,0,3,3,1,1\n";

  await t.test("filters to only the requested route_ids", () => {
    const trips = parseTripsForRoutes(csv, ["17", "64"]);
    assert.equal(trips.size, 2);
    assert.deepEqual(trips.get("1001"), { routeId: "17", serviceId: "10", headsign: "Front-Market", directionId: "0" });
  });

  await t.test("handles a quoted headsign containing a comma", () => {
    const trips = parseTripsForRoutes(csv, ["64"]);
    assert.deepEqual(trips.get("2001"), {
      routeId: "64",
      serviceId: "11",
      headsign: "Columbus, Blvd Pier 70",
      directionId: "1",
    });
  });
});

test("parseStops", async (t) => {
  const csv =
    "stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,zone_id,stop_url,location_type,parent_station,wheelchair_boarding\n" +
    "21289,,20th St & Oregon Av,,39.9,-75.1,,,,,\n" +
    '8704,,"Huntingdon St & 17th St",,40.0,-75.1,,,,,\n';

  await t.test("maps stop_id to stop_name", () => {
    const stops = parseStops(csv);
    assert.equal(stops.get("21289"), "20th St & Oregon Av");
    assert.equal(stops.get("8704"), "Huntingdon St & 17th St");
  });

  await t.test("unknown stop_id -> undefined", () => {
    assert.equal(parseStops(csv).get("99999"), undefined);
  });
});

test("parseStopTimesForTrips", async (t) => {
  const csv =
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,shape_dist_traveled,timepoint\n" +
    "1001,08:15:00,08:15:00,100,1,,0,0,,1\n" +
    "1001,08:20:00,08:20:00,200,2,,0,0,0.5,0\n" +
    "1002,25:05:00,25:05:00,100,1,,0,0,,1\n"; // past-midnight time (>=24:00:00)
  const tripsById = new Map([
    ["1001", { routeId: "17", serviceId: "10", headsign: "Front-Market", directionId: "0" }],
    ["1002", { routeId: "17", serviceId: "10", headsign: "Front-Market", directionId: "0" }],
  ]);

  await t.test("keeps only rows for known trips and requested stops", () => {
    const entries = parseStopTimesForTrips(csv, tripsById, [100]);
    assert.deepEqual(entries, [
      {
        routeId: "17",
        stopId: 100,
        stopSequence: 1,
        tripId: "1001",
        serviceId: "10",
        arrivalTimeSeconds: 8 * 3600 + 15 * 60,
        headsign: "Front-Market",
        directionId: "0",
      },
      {
        routeId: "17",
        stopId: 100,
        stopSequence: 1,
        tripId: "1002",
        serviceId: "10",
        arrivalTimeSeconds: 25 * 3600 + 5 * 60,
        headsign: "Front-Market",
        directionId: "0",
      },
    ]);
  });

  await t.test("drops rows for trips not in tripsById (other routes)", () => {
    const entries = parseStopTimesForTrips(csv, new Map(), [100]);
    assert.deepEqual(entries, []);
  });

  await t.test("no stopIds given -> keeps every stop for every known trip", () => {
    const entries = parseStopTimesForTrips(csv, tripsById);
    assert.deepEqual(
      entries.map((e) => `${e.tripId}:${e.stopId}:${e.stopSequence}`),
      ["1001:100:1", "1001:200:2", "1002:100:1"]
    );
  });
});

test("parseCalendar / parseCalendarDates", async (t) => {
  const calendarCsv =
    "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
    "10,1,1,1,1,1,0,0,20260101,20261231\n" +
    "20,0,0,0,0,0,1,1,20260101,20261231\n";
  const calendarDatesCsv = "service_id,date,exception_type\n10,20260704,2\n20,20260704,1\n";

  await t.test("parseCalendar reflects each day flag and date range", () => {
    const calendar = parseCalendar(calendarCsv);
    assert.deepEqual(calendar["10"], {
      sunday: false,
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
      saturday: false,
      startDate: "20260101",
      endDate: "20261231",
    });
  });

  await t.test("parseCalendarDates parses exception_type as a number", () => {
    const exceptions = parseCalendarDates(calendarDatesCsv);
    assert.deepEqual(exceptions, { 10: { 20260704: 2 }, 20: { 20260704: 1 } });
  });
});

test("isServiceActiveOn", async (t) => {
  const calendar = parseCalendar(
    "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
      "weekday,1,1,1,1,1,0,0,20260101,20261231\n"
  );
  const exceptions = parseCalendarDates("service_id,date,exception_type\nweekday,20260704,2\n");

  await t.test("active on a matching weekday within range", () => {
    // 2026-07-06 is a Monday.
    assert.equal(isServiceActiveOn(calendar, exceptions, "weekday", new Date(2026, 6, 6)), true);
  });

  await t.test("inactive on a non-matching day (Sunday)", () => {
    assert.equal(isServiceActiveOn(calendar, exceptions, "weekday", new Date(2026, 6, 5)), false);
  });

  await t.test("inactive outside the date range", () => {
    assert.equal(isServiceActiveOn(calendar, exceptions, "weekday", new Date(2027, 0, 1)), false);
  });

  await t.test("calendar_dates exception removes an otherwise-active day", () => {
    // 2026-07-04 is a Saturday (already inactive by calendar.txt), but this
    // also confirms an explicit removal exception is honored.
    assert.equal(isServiceActiveOn(calendar, exceptions, "weekday", new Date(2026, 6, 4)), false);
  });

  await t.test("unknown service_id -> false", () => {
    assert.equal(isServiceActiveOn(calendar, exceptions, "nonexistent", new Date(2026, 6, 6)), false);
  });
});

test("buildScheduleCache + getScheduledArrivals", async (t) => {
  const fileTexts = {
    "trips.txt":
      "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,shape_id,wheelchair_accessible,bikes_allowed\n" +
      "17,weekday,9001,Front-Market,,0,1,1,1,1\n",
    "stop_times.txt":
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,shape_dist_traveled,timepoint\n" +
      "9001,08:15:00,08:15:00,21289,2,,0,0,,1\n",
    "calendar.txt":
      "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
      "weekday,1,1,1,1,1,0,0,20260101,20261231\n",
    "calendar_dates.txt": "service_id,date,exception_type\n",
  };

  await t.test("buildScheduleCache assembles entries + calendar tables", () => {
    const cache = buildScheduleCache(fileTexts, ["17"], [21289]);
    assert.equal(cache.entries.length, 1);
    assert.equal(cache.entries[0].tripId, "9001");
    assert.ok(cache.calendar.weekday);
  });

  await t.test("buildScheduleCache: no stops.txt in fileTexts -> stopNames is an empty object, not a crash", () => {
    const cache = buildScheduleCache(fileTexts, ["17"], [21289]);
    assert.deepEqual(cache.stopNames, {});
  });

  await t.test("buildScheduleCache: stops.txt present -> stopNames filtered to just stopIds", () => {
    const withStops = {
      ...fileTexts,
      "stops.txt": "stop_id,stop_name\n21289,20th St & Oregon Av\n99999,Somewhere Else\n",
    };
    const cache = buildScheduleCache(withStops, ["17"], [21289]);
    assert.deepEqual(cache.stopNames, { 21289: "20th St & Oregon Av" });
  });

  await t.test("getScheduledArrivals returns the trip when within horizon and service is active", () => {
    const cache = buildScheduleCache(fileTexts, ["17"], [21289]);
    // 2026-07-06 is a Monday; "now" is 08:00, trip arrives 08:15 (15 min out).
    const now = new Date(2026, 6, 6, 8, 0, 0);
    const results = getScheduledArrivals(cache, "17", 21289, now, 60);
    assert.equal(results.length, 1);
    assert.equal(results[0].tripId, "9001");
    assert.equal(results[0].headsign, "Front-Market");
  });

  await t.test("getScheduledArrivals excludes trips outside the horizon", () => {
    const cache = buildScheduleCache(fileTexts, ["17"], [21289]);
    const now = new Date(2026, 6, 6, 6, 0, 0); // 08:15 is 135 min away
    assert.deepEqual(getScheduledArrivals(cache, "17", 21289, now, 60), []);
  });

  await t.test("getScheduledArrivals excludes trips when service isn't active that day", () => {
    const cache = buildScheduleCache(fileTexts, ["17"], [21289]);
    const now = new Date(2026, 6, 5, 8, 0, 0); // Sunday -- "weekday" service inactive
    assert.deepEqual(getScheduledArrivals(cache, "17", 21289, now, 60), []);
  });

  await t.test("getScheduledArrivals resolves a past-midnight arrival_time against the prior day's service", () => {
    const wraparoundTexts = {
      ...fileTexts,
      "stop_times.txt": fileTexts["stop_times.txt"].replace("08:15:00,08:15:00", "24:10:00,24:10:00"),
    };
    const cache = buildScheduleCache(wraparoundTexts, ["17"], [21289]);
    // Monday night's service (service active Monday) produces an arrival at
    // 00:10 Tuesday morning -- check right around that wall-clock moment.
    const now = new Date(2026, 6, 7, 0, 5, 0); // Tuesday 00:05
    const results = getScheduledArrivals(cache, "17", 21289, now, 60);
    assert.equal(results.length, 1);
    assert.equal(results[0].tripId, "9001");
  });

  // Reproduces a real bug found live: route 2 stop 40 is served by trips in
  // *both* directions (direction_id 0 -> "20th-Johnston", direction_id 1 ->
  // other headsigns) -- rare, but real, and the static schedule has no
  // direction_name to distinguish them, only a bare direction_id.
  await t.test("directionId filters out the opposite direction's trips at a stop served by both", async (t) => {
    const bothDirectionsTexts = {
      "trips.txt":
        "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,shape_id,wheelchair_accessible,bikes_allowed\n" +
        "2,weekday,9001,20th-Johnston,,0,1,1,1,1\n" +
        "2,weekday,9002,Pulaski-Hunting Park,,1,2,2,1,1\n",
      "stop_times.txt":
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,shape_dist_traveled,timepoint\n" +
        "9001,08:15:00,08:15:00,40,81,,0,0,,1\n" +
        "9002,08:20:00,08:20:00,40,1,,0,0,,1\n",
      "calendar.txt":
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
        "weekday,1,1,1,1,1,0,0,20260101,20261231\n",
      "calendar_dates.txt": "service_id,date,exception_type\n",
    };
    const cache = buildScheduleCache(bothDirectionsTexts, ["2"], [40]);
    const now = new Date(2026, 6, 6, 8, 0, 0); // Monday 08:00

    await t.test("no directionId given -> both directions' trips leak through (old behavior)", () => {
      const results = getScheduledArrivals(cache, "2", 40, now, 60);
      assert.deepEqual(
        results.map((r) => r.headsign),
        ["20th-Johnston", "Pulaski-Hunting Park"]
      );
    });

    await t.test("directionId given -> only that direction's trips", () => {
      const results = getScheduledArrivals(cache, "2", 40, now, 60, "1");
      assert.deepEqual(results.map((r) => r.headsign), ["Pulaski-Hunting Park"]);
    });

    await t.test("directionId given (number, not string) -> still matches via coercion", () => {
      const results = getScheduledArrivals(cache, "2", 40, now, 60, 1);
      assert.deepEqual(results.map((r) => r.headsign), ["Pulaski-Hunting Park"]);
    });
  });
});

test("getAllHeadsignsForStop", async (t) => {
  const fileTexts = {
    "trips.txt":
      "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,shape_id,wheelchair_accessible,bikes_allowed\n" +
      "17,weekday,9001,Front-Market,,0,1,1,1,1\n" +
      "17,weekday,9002,Broad-Pattison,,0,2,2,1,1\n" +
      "17,weekday,9003,Front-Market,,0,3,3,1,1\n" +
      "64,weekday,9004,Other-Route-Headsign,,0,4,4,1,1\n",
    "stop_times.txt":
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,shape_dist_traveled,timepoint\n" +
      // Spread across the day -- not all within any one 60-minute horizon.
      "9001,06:00:00,06:00:00,21289,2,,0,0,,1\n" +
      "9002,14:00:00,14:00:00,21289,2,,0,0,,1\n" +
      "9003,22:00:00,22:00:00,21289,2,,0,0,,1\n" +
      "9004,08:00:00,08:00:00,21289,2,,0,0,,1\n",
    "calendar.txt":
      "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
      "weekday,1,1,1,1,1,0,0,20260101,20261231\n",
    "calendar_dates.txt": "service_id,date,exception_type\n",
  };
  const cache = buildScheduleCache(fileTexts, ["17", "64"], [21289]);

  await t.test("returns every distinct headsign for the route/stop, sorted, regardless of time of day", () => {
    assert.deepEqual(getAllHeadsignsForStop(cache, "17", 21289), ["Broad-Pattison", "Front-Market"]);
  });

  await t.test("doesn't mix in headsigns from a different route at the same stop", () => {
    assert.deepEqual(getAllHeadsignsForStop(cache, "64", 21289), ["Other-Route-Headsign"]);
  });

  await t.test("no matching route/stop -> empty array", () => {
    assert.deepEqual(getAllHeadsignsForStop(cache, "17", 99999), []);
  });

  await t.test("directionId filters to just that direction's headsigns", () => {
    const mixedDirectionTexts = {
      ...fileTexts,
      "trips.txt": fileTexts["trips.txt"].replace("17,weekday,9002,Broad-Pattison,,0,2,2,1,1\n", "17,weekday,9002,Broad-Pattison,,1,2,2,1,1\n"),
    };
    const mixedCache = buildScheduleCache(mixedDirectionTexts, ["17", "64"], [21289]);
    assert.deepEqual(getAllHeadsignsForStop(mixedCache, "17", 21289, "0"), ["Front-Market"]);
    assert.deepEqual(getAllHeadsignsForStop(mixedCache, "17", 21289, "1"), ["Broad-Pattison"]);
    assert.deepEqual(getAllHeadsignsForStop(mixedCache, "17", 21289), ["Broad-Pattison", "Front-Market"]);
  });
});

test("getHeadsignsSkippingStop", async (t) => {
  const fileTexts = {
    "trips.txt":
      "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,shape_id,wheelchair_accessible,bikes_allowed\n" +
      "17,weekday,9001,Front-Market,,0,1,1,1,1\n" + // serves both stops
      "17,weekday,9002,Broad-Pattison,,0,2,2,1,1\n" + // short-turn: primary stop only
      "17,weekday,9003,Front-Market,,0,3,3,1,1\n", // same headsign as 9001, primary stop only on this instance
    "stop_times.txt":
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,shape_dist_traveled,timepoint\n" +
      "9001,06:00:00,06:00:00,21289,2,,0,0,,1\n" +
      "9001,06:10:00,06:10:00,99000,3,,0,0,,1\n" +
      "9002,14:00:00,14:00:00,21289,2,,0,0,,1\n" +
      "9003,22:00:00,22:00:00,21289,2,,0,0,,1\n",
    "calendar.txt":
      "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
      "weekday,1,1,1,1,1,0,0,20260101,20261231\n",
    "calendar_dates.txt": "service_id,date,exception_type\n",
  };
  const cache = buildScheduleCache(fileTexts, ["17"], [21289, 99000]);

  await t.test("a headsign served by at least one trip reaching the secondary stop is not flagged", () => {
    assert.deepEqual(getHeadsignsSkippingStop(cache, "17", 21289, 99000), ["Broad-Pattison"]);
  });

  await t.test("no secondary-stop data at all -> every primary headsign flagged", () => {
    assert.deepEqual(getHeadsignsSkippingStop(cache, "17", 21289, 88888), ["Broad-Pattison", "Front-Market"]);
  });

  await t.test("no matching route/stop -> empty array", () => {
    assert.deepEqual(getHeadsignsSkippingStop(cache, "99", 21289, 99000), []);
  });

  await t.test("directionId is applied to both the primary and secondary stop lookups", () => {
    const mixedDirectionTexts = {
      ...fileTexts,
      // 9002 (Broad-Pattison, the one that skips the secondary stop) is now
      // the *other* direction -- it shouldn't be flagged when asking about
      // direction "0", since it isn't part of direction "0" at all.
      "trips.txt": fileTexts["trips.txt"].replace(
        "17,weekday,9002,Broad-Pattison,,0,2,2,1,1\n",
        "17,weekday,9002,Broad-Pattison,,1,2,2,1,1\n"
      ),
    };
    const mixedCache = buildScheduleCache(mixedDirectionTexts, ["17"], [21289, 99000]);
    assert.deepEqual(getHeadsignsSkippingStop(mixedCache, "17", 21289, 99000, "0"), []);
    assert.deepEqual(getHeadsignsSkippingStop(mixedCache, "17", 21289, 99000, "1"), ["Broad-Pattison"]);
  });
});

test("buildRouteStopPatterns", async (t) => {
  const fileTexts = {
    "trips.txt":
      "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,shape_id,wheelchair_accessible,bikes_allowed\n" +
      "17,weekday,9001,Front-Market,,0,1,1,1,1\n" + // full pattern, reaches 99000
      "17,weekday,9002,Broad-Pattison,,1,2,2,1,1\n" + // short-turn, other direction, never reaches 99000
      "64,weekday,9004,Other-Route,,0,4,4,1,1\n", // different route -- excluded
    "stop_times.txt":
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,shape_dist_traveled,timepoint\n" +
      "9001,06:00:00,06:00:00,21289,1,,0,0,,1\n" +
      "9001,06:10:00,06:10:00,99000,2,,0,0,,1\n" +
      "9002,14:00:00,14:00:00,21289,1,,0,0,,1\n" +
      "9004,08:00:00,08:00:00,21289,1,,0,0,,1\n",
    "stops.txt":
      "stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,zone_id,stop_url,location_type,parent_station,wheelchair_boarding\n" +
      "21289,,20th St & Oregon Av,,,,,,,,\n" +
      "99000,,Broad St & Pattison Av,,,,,,,,\n",
  };

  await t.test("returns every trip's full stop sequence, in order, with names", () => {
    const patterns = buildRouteStopPatterns(fileTexts, "17");
    const full = patterns.find((p) => p.tripId === "9001");
    assert.deepEqual(full, {
      tripId: "9001",
      headsign: "Front-Market",
      directionId: "0",
      stops: [
        { stopId: 21289, stopSequence: 1, stopName: "20th St & Oregon Av", stopLat: null, stopLon: null },
        { stopId: 99000, stopSequence: 2, stopName: "Broad St & Pattison Av", stopLat: null, stopLon: null },
      ],
    });
  });

  await t.test("includes a short-turn trip that never reaches a stop the full pattern does", () => {
    const patterns = buildRouteStopPatterns(fileTexts, "17");
    const shortTurn = patterns.find((p) => p.tripId === "9002");
    assert.deepEqual(
      shortTurn.stops.map((s) => s.stopId),
      [21289]
    );
    assert.equal(shortTurn.headsign, "Broad-Pattison");
    assert.equal(shortTurn.directionId, "1");
  });

  await t.test("excludes trips from a different route", () => {
    const patterns = buildRouteStopPatterns(fileTexts, "17");
    assert.equal(patterns.some((p) => p.tripId === "9004"), false);
  });

  await t.test("unknown stop name -> stopName null instead of throwing", () => {
    const missingStopName = {
      ...fileTexts,
      "stops.txt": "stop_id,stop_name\n21289,20th St & Oregon Av\n", // 99000 omitted
    };
    const patterns = buildRouteStopPatterns(missingStopName, "17");
    const full = patterns.find((p) => p.tripId === "9001");
    assert.equal(full.stops[1].stopName, null);
  });
});

test("mergeDirectionPatterns", async (t) => {
  // Small helper: a pattern with the given headsign and a stop list built
  // from bare stop_ids (name/sequence follow the id, matching the fixtures'
  // style elsewhere in this file -- these tests only care about ordering).
  function pattern(headsign, stopIds) {
    return {
      headsign,
      stops: stopIds.map((stopId, index) => ({ stopId, stopSequence: index + 1, stopName: `Stop ${stopId}` })),
    };
  }
  function rowIds(merged) {
    return merged.rows.map((r) => (r.type === "alt" ? `alt:${r.stopId}` : `${r.stopId}`));
  }

  await t.test("empty input -> empty headsigns and rows", () => {
    assert.deepEqual(mergeDirectionPatterns([]), { headsigns: [], rows: [] });
  });

  await t.test("single pattern -> its own stops, no alt rows, its headsign listed", () => {
    const merged = mergeDirectionPatterns([pattern("Front-Market", [1, 2, 3])]);
    assert.deepEqual(merged.headsigns, ["Front-Market"]);
    assert.deepEqual(rowIds(merged), ["1", "2", "3"]);
    assert.ok(merged.rows.every((r) => r.type === "stop"));
  });

  await t.test("a pattern fully contained in the longest one is discarded (no alt rows) but still listed", () => {
    const longest = pattern("Broad-Pattison", [1, 2, 3, 4, 5]);
    const shortTurn = pattern("20th-Johnston", [1, 2, 3]); // a prefix -- no stops of its own
    const merged = mergeDirectionPatterns([longest, shortTurn]);
    assert.deepEqual(merged.headsigns, ["20th-Johnston", "Broad-Pattison"]);
    assert.deepEqual(rowIds(merged), ["1", "2", "3", "4", "5"]);
  });

  await t.test("prefix divergence: extra stops before the first shared stop, as alt rows up front", () => {
    // "longest" needs its own unique tail stops (50, 51) so it genuinely
    // has the most total stops despite divergent's unique prefix -- the
    // reference is picked purely by total stop count, not by which one
    // "should" conceptually be the base route.
    const longest = pattern("Broad-Pattison", [1, 2, 3, 4, 50, 51]);
    const divergent = pattern("Other-Start", [97, 98, 1, 2, 3, 4]);
    const merged = mergeDirectionPatterns([longest, divergent]);
    assert.deepEqual(rowIds(merged), ["alt:97", "alt:98", "1", "2", "3", "4", "50", "51"]);
  });

  await t.test("suffix divergence: extra stops after the last shared stop, as alt rows at the end", () => {
    // Same reasoning as above, mirrored: "longest" needs unique *leading*
    // stops (50, 51) to still win on total count despite divergent's
    // unique suffix.
    const longest = pattern("Broad-Pattison", [50, 51, 1, 2, 3, 4]);
    const divergent = pattern("Navy-Yard", [1, 2, 3, 4, 97, 98]);
    const merged = mergeDirectionPatterns([longest, divergent]);
    assert.deepEqual(rowIds(merged), ["50", "51", "1", "2", "3", "4", "alt:97", "alt:98"]);
  });

  await t.test("interior divergence: extra stops between two shared stops, grouped as one alt run in place", () => {
    // Reference: A,B,C,G,H,I,J,K,L (using ids 1,2,3,7,8,9,10,11,12).
    // Other: A,B,C,D,E,F,J,K,L (ids 1,2,3,4,5,6,10,11,12) -- diverges only
    // between C and J.
    const longest = pattern("Express", [1, 2, 3, 7, 8, 9, 10, 11, 12]);
    const local = pattern("Local", [1, 2, 3, 4, 5, 6, 10, 11, 12]);
    const merged = mergeDirectionPatterns([longest, local]);
    assert.deepEqual(rowIds(merged), [
      "1",
      "2",
      "3",
      "alt:4",
      "alt:5",
      "alt:6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
    ]);
  });

  await t.test("a stop_id repeated within a pattern (loop) doesn't produce a false alt", () => {
    // Reference passes stop 1 twice (a loop) -- only its first occurrence
    // is indexed, so a divergent pattern's second visit to stop 1 can't
    // match monotonically (index 0 isn't > the last match). It's still a
    // known reference stop_id though, so it's silently skipped rather than
    // misclassified as a genuine extra stop.
    const longest = pattern("Loop", [1, 2, 3, 1, 4]);
    const divergent = pattern("Loop-Variant", [1, 2, 3, 1, 4]);
    const merged = mergeDirectionPatterns([longest, divergent]);
    assert.deepEqual(
      merged.rows.filter((r) => r.type === "alt"),
      []
    );
  });

  await t.test("multiple divergent patterns: a shared extra stop is only ever printed once, credited to the alphabetically-first headsign", () => {
    const longest = pattern("Zzz-Longest", [1, 2, 3, 4, 5]); // must genuinely be longest overall
    const patternA = pattern("Aaa-First", [97, 1, 2, 3]);
    const patternB = pattern("Bbb-Second", [97, 1, 2, 3]); // claims the same stop 97
    const merged = mergeDirectionPatterns([longest, patternA, patternB]);
    assert.deepEqual(rowIds(merged), ["alt:97", "1", "2", "3", "4", "5"]);
    assert.deepEqual(merged.headsigns, ["Aaa-First", "Bbb-Second", "Zzz-Longest"]);
  });

  await t.test("headsigns list includes every distinct headsign, sorted, regardless of containment", () => {
    const longest = pattern("B-Longest", [1, 2, 3, 4]);
    const contained = pattern("A-Contained", [1, 2, 3]);
    const divergent = pattern("C-Divergent", [1, 2, 3, 4, 5]);
    const merged = mergeDirectionPatterns([longest, contained, divergent]);
    assert.deepEqual(merged.headsigns, ["A-Contained", "B-Longest", "C-Divergent"]);
  });
});

test("fetchRouteStopPatterns", async (t) => {
  // A dedicated, never-pre-existing cache path per sub-test -- fetchRouteStopPatterns
  // now caches its download to disk (see FEED_CACHE_MAX_AGE_MS), so without
  // this every sub-test after the first would silently reuse whatever the
  // previous one cached instead of actually exercising its own fetchImpl
  // stub (confirmed live: without this, "throws on a failed download" below
  // never even calls its fetchImpl, because the previous sub-test's cache
  // is still "fresh").
  const cachePaths = [];
  function freshCachePath(name) {
    const p = path.join(os.tmpdir(), `mmm-septa-feed-cache-test-${process.pid}-${name}.json`);
    cachePaths.push(p);
    try {
      fs.unlinkSync(p);
    } catch (err) {
      // didn't exist yet -- fine
    }
    return p;
  }
  t.after(() => {
    for (const p of cachePaths) {
      try {
        fs.unlinkSync(p);
      } catch (err) {
        // already gone / never created -- fine either way
      }
    }
  });

  await t.test("downloads, unzips, and parses the feed end-to-end", async () => {
    const zip = buildTestZip([
      {
        name: "trips.txt",
        content:
          "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,shape_id,wheelchair_accessible,bikes_allowed\n" +
          "17,weekday,9001,Front-Market,,0,1,1,1,1\n",
      },
      {
        name: "stop_times.txt",
        content:
          "trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,shape_dist_traveled,timepoint\n" +
          "9001,08:15:00,08:15:00,21289,1,,0,0,,1\n",
      },
      { name: "stops.txt", content: "stop_id,stop_name\n21289,20th St & Oregon Av\n" },
    ]);
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
    });

    const patterns = await fetchRouteStopPatterns("17", fetchImpl, freshCachePath("basic"));
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0].stops[0].stopName, "20th St & Oregon Av");
  });

  await t.test("throws on a failed download", async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, statusText: "Internal Server Error" });
    await assert.rejects(() => fetchRouteStopPatterns("17", fetchImpl, freshCachePath("failure")), /500/);
  });

  await t.test("a fresh cache is reused instead of calling fetchImpl again", async () => {
    const zip = buildTestZip([
      { name: "trips.txt", content: "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,shape_id,wheelchair_accessible,bikes_allowed\n17,weekday,9001,Front-Market,,0,1,1,1,1\n" },
      { name: "stop_times.txt", content: "trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,shape_dist_traveled,timepoint\n9001,08:15:00,08:15:00,21289,1,,0,0,,1\n" },
      { name: "stops.txt", content: "stop_id,stop_name\n21289,20th St & Oregon Av\n" },
    ]);
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount += 1;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
      };
    };
    const cachePath = freshCachePath("reuse");

    await fetchRouteStopPatterns("17", fetchImpl, cachePath);
    assert.equal(fetchCount, 1);

    // Second call, same (now-populated) cache path: should reuse the cached
    // download rather than calling fetchImpl again, even for a different
    // routeId -- the cache isn't filtered by route, see fetchRouteStopPatterns.
    const patterns = await fetchRouteStopPatterns("17", fetchImpl, cachePath);
    assert.equal(fetchCount, 1);
    assert.equal(patterns.length, 1);

    fs.unlinkSync(cachePath);
  });

  await t.test("preloadedCache is used as-is, without reading cachePath from disk at all", async () => {
    const fetchImpl = async () => {
      throw new Error("fetchImpl should not be called -- preloadedCache is fresh");
    };
    const preloadedCache = {
      downloadedAt: Date.now(),
      fileTexts: {
        "trips.txt":
          "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,shape_id,wheelchair_accessible,bikes_allowed\n17,weekday,9001,Front-Market,,0,1,1,1,1\n",
        "stop_times.txt":
          "trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,shape_dist_traveled,timepoint\n9001,08:15:00,08:15:00,21289,1,,0,0,,1\n",
        "stops.txt": "stop_id,stop_name\n21289,20th St & Oregon Av\n",
      },
    };
    // Deliberately a path with nothing on disk -- proves the result came
    // from preloadedCache, not a fallback disk read.
    const nonexistentPath = path.join(os.tmpdir(), `mmm-septa-feed-cache-test-${process.pid}-does-not-exist.json`);

    const patterns = await fetchRouteStopPatterns("17", fetchImpl, nonexistentPath, preloadedCache);
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0].stops[0].stopName, "20th St & Oregon Av");
  });
});

test("fetchScheduleCache", async (t) => {
  await t.test("downloads, unzips, and parses the feed end-to-end", async () => {
    const zip = buildTestZip([
      {
        name: "trips.txt",
        content:
          "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,shape_id,wheelchair_accessible,bikes_allowed\n" +
          "17,weekday,9001,Front-Market,,0,1,1,1,1\n",
      },
      {
        name: "stop_times.txt",
        content:
          "trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,shape_dist_traveled,timepoint\n" +
          "9001,08:15:00,08:15:00,21289,2,,0,0,,1\n",
      },
      {
        name: "calendar.txt",
        content:
          "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
          "weekday,1,1,1,1,1,0,0,20260101,20261231\n",
      },
      { name: "calendar_dates.txt", content: "service_id,date,exception_type\n" },
      { name: "stops.txt", content: "stop_id,stop_name\n21289,20th St & Oregon Av\n" },
    ]);
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
    });

    const cache = await fetchScheduleCache(["17"], [21289], fetchImpl);
    assert.equal(cache.entries.length, 1);
    assert.equal(cache.entries[0].tripId, "9001");
    assert.equal(cache.stopNames["21289"], "20th St & Oregon Av");
  });

  await t.test("throws on a failed download", async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, statusText: "Internal Server Error" });
    await assert.rejects(() => fetchScheduleCache(["17"], [21289], fetchImpl), /500/);
  });
});

test("loadCacheFromDisk / saveCacheToDisk", async (t) => {
  const tmpPath = path.join(os.tmpdir(), `mmm-septa-gtfs-cache-test-${process.pid}.json`);

  t.after(() => {
    try {
      fs.unlinkSync(tmpPath);
    } catch (err) {
      // already gone / never created -- fine either way
    }
  });

  await t.test("round-trips a cache object through disk", () => {
    const cache = { builtAt: 12345, entries: [{ routeId: "17", stopId: 1, tripId: "x", serviceId: "10", arrivalTimeSeconds: 100, headsign: "H" }], calendar: {}, calendarExceptions: {} };
    saveCacheToDisk(cache, tmpPath);
    assert.deepEqual(loadCacheFromDisk(tmpPath), cache);
  });

  await t.test("missing file -> null, doesn't throw", () => {
    assert.equal(loadCacheFromDisk(path.join(os.tmpdir(), "definitely-does-not-exist-12345.json")), null);
  });
});
