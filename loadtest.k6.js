// k6 load test — one tool, one machine, but as much load as your whole
// laptop test could not manage. k6 is a real load generator (written in Go): it
// reuses connections instead of opening 3000 raw sockets and choking.
//
// Run it:            k6 run loadtest.k6.js
// Run it harder:     k6 run -e RATE=500 loadtest.k6.js
// Run it distributed: see the notes at the bottom of this file.
//
// NOTE: this is a .js file, not .ts. k6 has its own runtime — it is NOT Node,
// so `fetch`, `console.log` timing, npm packages etc. do not apply here. You
// write against k6's own `http` module. Same ideas, different toolbox.
//
// THE ONE RULE stays: only /v1 paths. /v1/* is memory-served or rejected before
// VAO, so it costs nothing from the 950/day contract. Never add a /v2 path.

import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE = "https://api.oeffigo.app";

// Every public /v1 endpoint — same set as the Node test.
const ENDPOINTS = [
  "/v1/status", // edge-cached
  "/v1/announcements", // edge-cached
  "/v1/history", // edge-cached
  "/v1/network-maps", // edge-cached
  "/v1/config", // edge-cached
  "/v1/health", // reaches the server
  "/v1/predictions", // reaches the server
  "/v1/vehicles", // reaches the server
  "/v1/wiener-linien/metro", // reaches the server
  "/v1/nope", // reaches the server (404)
];

// Requests per second. Override from the command line: -e RATE=500
const RATE = Number(__ENV.RATE || 200);

// Our own tally of rate-limit responses, so it shows up as a clean metric.
const rateLimited = new Counter("rate_limited_429");
// Latency split by whether Cloudflare served it or your server did.
const edgeLatency = new Trend("edge_latency_ms", true);
const originLatency = new Trend("origin_latency_ms", true);

// ---------------------------------------------------------------------------
// The load profile. This is the part k6 does that raw fetch cannot: it holds a
// steady *arrival rate* (requests started per second), and spins up as many
// parallel workers ("VUs", virtual users) as it needs to keep that rate — then
// tells you if it could not keep up.
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 500,
      stages: [
        { target: RATE, duration: "10s" }, // ramp up to RATE req/s
        { target: RATE, duration: "20s" }, // hold there
        { target: 0, duration: "5s" }, // ramp back down
      ],
    },
  },
  // A "pass/fail" line for the whole run. k6 exits non-zero if these break —
  // which is how you would wire it into CI later.
  thresholds: {
    http_req_failed: ["rate<0.5"], // fewer than half of requests may fail outright
    edge_latency_ms: ["p(95)<500"], // 95% of edge answers under 500ms
  },
};

// ---------------------------------------------------------------------------
// What each virtual user does, over and over: pick an endpoint, hit it, record.
// ---------------------------------------------------------------------------

export default function () {
  // Spread evenly across all endpoints.
  const path = ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)];

  const res = http.get(`${BASE}${path}`, {
    tags: { path }, // lets k6 break the summary down per endpoint
  });

  const edge = res.headers["Cf-Cache-Status"] || "";
  if (edge === "HIT") {
    edgeLatency.add(res.timings.duration);
  } else {
    originLatency.add(res.timings.duration);
  }

  if (res.status === 429) {
    rateLimited.add(1);
  }

  // Not an assertion that fails the run — just bookkeeping k6 shows as a ratio.
  check(res, {
    "answered (not a network failure)": (r) => r.status !== 0,
    "not rate limited": (r) => r.status !== 429,
  });
}

// ---------------------------------------------------------------------------
// How to actually run this from MULTIPLE machines
// ---------------------------------------------------------------------------
//
// This single-machine run already beats the Node test by a lot. When you truly
// need several machines (to find your SERVER's ceiling, not your laptop's),
// you do NOT rewrite this file — you run this same script in one of these ways:
//
// 1) k6 Cloud (easiest, paid):
//        k6 cloud login
//        k6 cloud run loadtest.k6.js
//    Grafana runs it from several regions at once and draws the graphs.
//
// 2) Distributed on Kubernetes (free, more setup): the "k6-operator". You apply
//    a TestRun manifest that says `parallelism: 4`, and it launches 4 pods each
//    running a quarter of the load. Same script, unchanged.
//
// 3) Poor-man's version: copy this file to 3 cheap VMs in 3 regions and run
//        k6 run -e RATE=300 loadtest.k6.js
//    on each at the same time. Three machines, three source IPs — which also
//    means three separate buckets against your per-IP rate limiter, so you would
//    finally see the LIMIT itself scale, not just one IP getting throttled.
