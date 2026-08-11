// UNCACHED load test — hit only the /v1 paths that reach the ORIGIN.
//
// The normal test mixes edge-cached and origin paths, so Cloudflare absorbs most
// of it and the server barely notices. This one strips the cache out: every path
// here is `no-store` (cf-cache-status: BYPASS), so every request has to travel
// all the way to your server. This is how you load the ORIGIN itself.
//
// Run it:    k6 run loadtest-uncached.k6.js
//
// THE ONE RULE stays: still only /v1. These are memory snapshots or 400/404
// rejections — they reach the server but never call VAO, so still zero budget.

import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE = "https://api.oeffigo.app";

// ONLY origin-reaching paths. No edge-cached ones. Every one of these is
// answered by your server directly (or rejected by it), never by Cloudflare.
const ENDPOINTS = [
  "/v1/health", // 200, no-store
  "/v1/predictions", // reaches server (400 without params — still origin)
  "/v1/vehicles", // reaches server (400 without a bbox — still origin)
  "/v1/wiener-linien/metro", // reaches server
  "/v1/nope", // 404 — reaches server
];

const RATE = Number(__ENV.RATE || 200);

const rateLimited = new Counter("rate_limited_429");
const reachedOrigin = new Counter("reached_origin"); // 200/400/404 = the server answered
const served = new Counter("served_2xx_4xx");

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 800,
      stages: [
        { target: RATE, duration: "10s" },
        { target: RATE, duration: "20s" },
        { target: 0, duration: "5s" },
      ],
    },
  },
  // No edge threshold here — everything is origin. We only care that the machine
  // itself does not fall over (network failures stay low).
  thresholds: {
    "checks{kind:answered}": ["rate>0.9"], // 90%+ must get SOME answer from the server
  },
};

export default function () {
  const path = ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)];
  const res = http.get(`${BASE}${path}`, { tags: { path } });

  if (res.status === 429) {
    rateLimited.add(1);
  } else if (res.status !== 0) {
    // 200 / 400 / 404 — the origin actually handled it.
    reachedOrigin.add(1);
  }

  if (res.status === 200 || res.status === 400 || res.status === 404) served.add(1);

  check(res, { answered: (r) => r.status !== 0 }, { kind: "answered" });
}
