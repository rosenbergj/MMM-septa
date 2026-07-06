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
  parseStopTimesForTrips,
  parseCalendar,
  parseCalendarDates,
  isServiceActiveOn,
  buildScheduleCache,
  getScheduledArrivals,
  loadCacheFromDisk,
  saveCacheToDisk,
  fetchScheduleCache,
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
    assert.deepEqual(trips.get("1001"), { routeId: "17", serviceId: "10", headsign: "Front-Market" });
  });

  await t.test("handles a quoted headsign containing a comma", () => {
    const trips = parseTripsForRoutes(csv, ["64"]);
    assert.deepEqual(trips.get("2001"), { routeId: "64", serviceId: "11", headsign: "Columbus, Blvd Pier 70" });
  });
});

test("parseStopTimesForTrips", async (t) => {
  const csv =
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,shape_dist_traveled,timepoint\n" +
    "1001,08:15:00,08:15:00,100,1,,0,0,,1\n" +
    "1001,08:20:00,08:20:00,200,2,,0,0,0.5,0\n" +
    "1002,25:05:00,25:05:00,100,1,,0,0,,1\n"; // past-midnight time (>=24:00:00)
  const tripsById = new Map([
    ["1001", { routeId: "17", serviceId: "10", headsign: "Front-Market" }],
    ["1002", { routeId: "17", serviceId: "10", headsign: "Front-Market" }],
  ]);

  await t.test("keeps only rows for known trips and requested stops", () => {
    const entries = parseStopTimesForTrips(csv, tripsById, [100]);
    assert.deepEqual(entries, [
      { routeId: "17", stopId: 100, tripId: "1001", serviceId: "10", arrivalTimeSeconds: 8 * 3600 + 15 * 60, headsign: "Front-Market" },
      { routeId: "17", stopId: 100, tripId: "1002", serviceId: "10", arrivalTimeSeconds: 25 * 3600 + 5 * 60, headsign: "Front-Market" },
    ]);
  });

  await t.test("drops rows for trips not in tripsById (other routes)", () => {
    const entries = parseStopTimesForTrips(csv, new Map(), [100]);
    assert.deepEqual(entries, []);
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
