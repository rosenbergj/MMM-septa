#!/usr/bin/env node
"use strict";

// Live smoke test: runs the exact same pollRoute() code path node_helper.js
// uses, against the real SEPTA API, and logs each cycle to the console. No
// MagicMirror install required — useful for verifying connectivity/behavior
// on a new machine, or after editing septa-client.js.
//
// Usage:
//   node scripts/dry-run.js [--route 17] [--stop 21289] [--direction Northbound]
//                            [--interval 20] [--retry 10] [--cycles Infinity]
//
// NOTE: --interval defaults to a short 20s purely so you don't have to wait
// long to see it work. Real MagicMirror config should use something like
// 120s (SEPTA's own data doesn't update much faster than that anyway) —
// do not copy this script's default interval into your config.js.

const { pollRoute } = require("../septa-client.js");

function printHelp() {
  console.log(`Usage: node scripts/dry-run.js [options]

Options:
  --route <id>        SEPTA route id (default: 17)
  --stop <id>         SEPTA stop id (default: 21289, "20th St & Oregon Av")
  --direction <name>  Exact direction_name, e.g. Northbound/Southbound (default: Northbound)
  --interval <secs>   Seconds between successful poll cycles (default: 20)
  --retry <secs>      Seconds to wait before retrying after a failed cycle (default: 10)
  --cycles <n>        Stop after n cycles instead of running forever (default: run until Ctrl-C)
  --help              Show this message
`);
}

function parseArgs(argv) {
  const args = {
    routeId: "17",
    stopId: "21289",
    direction: "Northbound",
    intervalSeconds: 20,
    retrySeconds: 10,
    cycles: Infinity,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--route":
        args.routeId = argv[(i += 1)];
        break;
      case "--stop":
        args.stopId = argv[(i += 1)];
        break;
      case "--direction":
        args.direction = argv[(i += 1)];
        break;
      case "--interval":
        args.intervalSeconds = Number(argv[(i += 1)]);
        break;
      case "--retry":
        args.retrySeconds = Number(argv[(i += 1)]);
        break;
      case "--cycles":
        args.cycles = Number(argv[(i += 1)]);
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }
  return args;
}

function formatTime(date) {
  return date.toTimeString().slice(0, 8);
}

function minutesUntil(etaSeconds, nowMs) {
  return Math.round((etaSeconds * 1000 - nowMs) / 60000);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const routeConfig = { routeId: args.routeId, stopId: args.stopId, direction: args.direction };

  console.log(
    `Dry-running SEPTA polling for route ${args.routeId}, stop ${args.stopId}, direction "${args.direction}".`
  );
  console.log(
    `NOTE: --interval ${args.intervalSeconds}s is for fast local observation only — ` +
      `do not copy a short interval like this into real MagicMirror config (use 120s+).`
  );
  console.log("Press Ctrl-C to stop.\n");

  let cyclesRun = 0;
  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
    console.log("\nStopping dry-run.");
    process.exit(0);
  });

  async function tick() {
    if (stopped || cyclesRun >= args.cycles) return;
    cyclesRun += 1;
    const now = new Date();
    try {
      const result = await pollRoute(routeConfig);
      if (result.detour) {
        console.log(`[${formatTime(now)}] route ${args.routeId}: DETOUR active, no arrivals`);
      } else {
        const minutes = result.etas.map((eta) => `${minutesUntil(eta, now.getTime())}m`);
        console.log(
          `[${formatTime(now)}] route ${args.routeId} (${args.direction} @${args.stopId}): ` +
            `${result.etas.length} etas -> [${minutes.join(", ")}] ` +
            `fresh=true detour=false tripError=${result.hasTripError}`
        );
      }
      if (!stopped && cyclesRun < args.cycles) {
        setTimeout(tick, args.intervalSeconds * 1000);
      }
    } catch (err) {
      console.log(
        `[${formatTime(now)}] route ${args.routeId}: fetch failed: ${err.message}; ` +
          `retrying in ${args.retrySeconds}s`
      );
      if (!stopped && cyclesRun < args.cycles) {
        setTimeout(tick, args.retrySeconds * 1000);
      }
    }
  }

  await tick();
}

main();
