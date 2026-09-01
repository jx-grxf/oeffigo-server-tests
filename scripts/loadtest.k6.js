// ÖffiGo API load test.
//
// Five scenarios, run back to back, each answering a different question:
//
//   keepalive  What does a warm, connection-reusing client see? (the real app)
//   edge       How much of a burst does Cloudflare absorb before the origin feels it?
//   origin     What does the origin itself do when the edge cannot help?
//   herd       Do N clients asking for the SAME thing at the SAME instant cost
//              the backend N times, or once? (request coalescing / single-flight)
//   ratelimit  Where does the per-IP bucket actually trip, and what does it cost?
//
// Safety: see lib/targets.js. Nothing here spends the VAO contract allowance;
// the one upstream call it does make (/v1/vehicles) is bounded and documented
// there.
//
// Run:  k6 run scripts/loadtest.k6.js
//       k6 run -e RATE=300 -e BASE=https://api.oeffigo.app scripts/loadtest.k6.js

import http from "k6/http";
import { check } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import {
  EDGE_PATHS, ORIGIN_PATHS, EXPENSIVE_PATHS, NOTFOUND_PATH, assertSafe,
} from "../lib/targets.js";

const BASE = __ENV.BASE || "https://api.oeffigo.app";
const RATE = Number(__ENV.RATE || 100);
const MACHINE = __ENV.MACHINE || "local";
// SMOKE shortens every scenario so the script can be validated end to end in
// under a minute without putting meaningful load on production.
const SMOKE = !!__ENV.SMOKE;
const D = (full, smoke) => (SMOKE ? smoke : full);

assertSafe([...EDGE_PATHS, ...ORIGIN_PATHS, ...EXPENSIVE_PATHS, NOTFOUND_PATH]);

// --- metrics -----------------------------------------------------------------
// Latency split by who answered. Mixing them into one p95 hides the only number
// that matters: an edge hit and an origin miss are different products.
const ttfbEdge    = new Trend("ttfb_edge_ms", true);
const ttfbOrigin  = new Trend("ttfb_origin_ms", true);
const ttfbHerd    = new Trend("ttfb_herd_ms", true);
const cacheHit    = new Rate("edge_hit_rate");
const rateLimited = new Counter("rate_limited");
const serverError = new Counter("server_errors");
const byStatus    = new Counter("status_total");

function record(res, trend) {
  const cf = (res.headers["Cf-Cache-Status"] || "").toUpperCase();
  const hit = cf === "HIT";
  const refused = res.status === 429 || res.status === 403;

  byStatus.add(1, { status: String(res.status), cf: cf || "none" });
  if (refused) rateLimited.add(1);
  else if (res.status >= 500) serverError.add(1);
  // A 0 means the request never completed — the load generator or the network
  // gave up. That is not a server verdict, so it is tracked apart from 5xx. A
  // 429 *is* an answer, so this is counted before the refusal return below.
  check(res, { "got an answer": (r) => r.status !== 0 });

  // Latency is only recorded for requests the API actually SERVED.
  //
  // A refusal is fast by construction — the edge rejects it before any handler
  // runs — so folding 429s into the same trend drags every percentile toward
  // "how quickly we say no" and away from "how quickly we answer". Once a run
  // pushes past the per-IP bucket the refusals dominate by count, and the
  // reported p95 stops describing the product entirely. Ask for the refusal
  // rate separately; do not let it contaminate the latency.
  if (refused) return res;
  if (cf) cacheHit.add(hit);
  if (trend) trend.add(res.timings.waiting);
  else (hit ? ttfbEdge : ttfbOrigin).add(res.timings.waiting);
  return res;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// --- scenarios ---------------------------------------------------------------
// Sequential, with gaps, so one scenario's queue never contaminates the next.
export const options = {
  discardResponseBodies: true,
  scenarios: {
    keepalive: {
      executor: "constant-arrival-rate", exec: "mixed",
      rate: Math.max(2, Math.round(RATE * 0.2)), timeUnit: "1s", duration: D("30s", "6s"),
      preAllocatedVUs: 20, maxVUs: 200, startTime: "0s",
    },
    edge: {
      executor: "ramping-arrival-rate", exec: "edgeOnly",
      startRate: 10, timeUnit: "1s", preAllocatedVUs: 30, maxVUs: 400,
      stages: [{ target: RATE, duration: D("15s", "4s") }, { target: RATE, duration: D("20s", "4s") }],
      startTime: D("35s", "8s"),
    },
    origin: {
      executor: "ramping-arrival-rate", exec: "originOnly",
      startRate: 5, timeUnit: "1s", preAllocatedVUs: 30, maxVUs: 400,
      stages: [{ target: Math.round(RATE * 0.6), duration: D("15s", "4s") },
               { target: Math.round(RATE * 0.6), duration: D("20s", "4s") }],
      startTime: D("75s", "18s"),
    },
    // All VUs start together and ask for one identical, uncacheable-at-origin
    // resource. If the backend coalesces, cost stays flat as N grows.
    herd: {
      executor: "per-vu-iterations", exec: "herd",
      vus: SMOKE ? 15 : 60, iterations: SMOKE ? 1 : 3, maxDuration: "30s", startTime: D("115s", "28s"),
    },
    ratelimit: {
      executor: "constant-arrival-rate", exec: "limitProbe",
      rate: SMOKE ? 30 : Math.max(RATE, 200), timeUnit: "1s", duration: D("20s", "5s"),
      preAllocatedVUs: 50, maxVUs: 500, startTime: D("150s", "34s"),
    },
  },
  thresholds: {
    // 429 is the limiter doing its job, not a fault. Only 5xx is a real error.
    server_errors: ["count<10"],
    ttfb_edge_ms: ["p(95)<400"],
  },
};

const tag = (name) => ({ tags: { scenario: name, machine: MACHINE } });

export function mixed() {
  const all = [...EDGE_PATHS, ...ORIGIN_PATHS, ...EXPENSIVE_PATHS];
  record(http.get(`${BASE}${pick(all)}`, tag("keepalive")));
}

export function edgeOnly() {
  record(http.get(`${BASE}${pick(EDGE_PATHS)}`, tag("edge")));
}

export function originOnly() {
  record(http.get(`${BASE}${pick(ORIGIN_PATHS)}`, tag("origin")));
}

export function herd() {
  // Deliberately ONE fixed path for every VU. /v1/health is `no-store` at the
  // origin and 10 s at the edge, so this measures the edge's collapsing of a
  // simultaneous burst plus the origin's own handling of the survivors.
  record(http.get(`${BASE}/v1/health`, tag("herd")), ttfbHerd);
}

export function limitProbe() {
  // A 404 is the cheapest thing the origin can produce, so whatever this run
  // costs the server is limiter bookkeeping rather than handler work.
  record(http.get(`${BASE}${NOTFOUND_PATH}`, tag("ratelimit")));
}

// --- report ------------------------------------------------------------------
export function handleSummary(data) {
  const m = data.metrics;
  const num = (metric, stat) => {
    const v = m[metric]?.values?.[stat];
    return typeof v === "number" ? Math.round(v * 100) / 100 : null;
  };
  const out = {
    machine: MACHINE,
    base: BASE,
    ratePerSec: RATE,
    at: new Date().toISOString(),
    requests: num("http_reqs", "count"),
    throughputPerSec: num("http_reqs", "rate"),
    edgeHitRate: num("edge_hit_rate", "rate"),
    rateLimited: num("rate_limited", "count") ?? 0,
    // The share of requests the API refused. Read every latency number below as
    // describing only the remaining share — refusals are excluded from them.
    refusedShare: (() => {
      const total = num("http_reqs", "count"), ref = num("rate_limited", "count") ?? 0;
      return total ? Math.round((ref / total) * 1000) / 1000 : null;
    })(),
    serverErrors: num("server_errors", "count") ?? 0,
    ttfb: {
      edge:   { p50: num("ttfb_edge_ms", "med"),   p95: num("ttfb_edge_ms", "p(95)"),   p99: num("ttfb_edge_ms", "p(99)") },
      origin: { p50: num("ttfb_origin_ms", "med"), p95: num("ttfb_origin_ms", "p(95)"), p99: num("ttfb_origin_ms", "p(99)") },
      herd:   { p50: num("ttfb_herd_ms", "med"),   p95: num("ttfb_herd_ms", "p(95)"),   max: num("ttfb_herd_ms", "max") },
    },
    connection: {
      tcpP50: num("http_req_connecting", "med"),
      tlsP50: num("http_req_tls_handshaking", "med"),
      blockedP95: num("http_req_blocked", "p(95)"),
    },
    failedRate: num("http_req_failed", "rate"),
  };
  const line = (l, v) => `  ${l.padEnd(22)} ${v}`;
  const text = [
    `\n=== ÖffiGo API load test — machine ${MACHINE} ===`,
    line("requests", `${out.requests} (${out.throughputPerSec}/s)`),
    line("edge hit rate", out.edgeHitRate),
    line("rate limited", `${out.rateLimited} (${out.refusedShare} of all)`),
    line("server errors (5xx)", out.serverErrors),
    line("edge TTFB p50/p95", `${out.ttfb.edge.p50} / ${out.ttfb.edge.p95} ms`),
    line("origin TTFB p50/p95", `${out.ttfb.origin.p50} / ${out.ttfb.origin.p95} ms`),
    line("herd TTFB p50/max", `${out.ttfb.herd.p50} / ${out.ttfb.herd.max} ms`),
    "",
  ].join("\n");
  return {
    stdout: text,
    [`results/summary-${MACHINE}.json`]: JSON.stringify(out, null, 2),
  };
}
