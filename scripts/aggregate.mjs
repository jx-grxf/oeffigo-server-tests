#!/usr/bin/env node
// Merges every runner's summary into one verdict.
//
// The point of a distributed run is that each machine has its own IP, and every
// per-IP bucket in the API is therefore a separate bucket. One runner measures
// its own rate limit; N runners together measure the SERVER. So the numbers that
// matter are the aggregate throughput and the spread across machines, not any
// single machine's percentile.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "artifacts";
const files = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".json")) files.push(p);
  }
};
try { walk(dir); } catch { console.error(`no artifacts under ${dir}`); process.exit(1); }

const loads = [], probes = [];
for (const f of files) {
  let j; try { j = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
  if (j.ttfb && j.requests != null) loads.push(j);
  else if (j.cold) probes.push(j);
}

const nums = (xs) => xs.filter((x) => typeof x === "number" && Number.isFinite(x));
const sum = (xs) => nums(xs).reduce((a, b) => a + b, 0);
const avg = (xs) => (nums(xs).length ? sum(xs) / nums(xs).length : null);
const max = (xs) => (nums(xs).length ? Math.max(...nums(xs)) : null);
const r2 = (x) => (typeof x === "number" ? Math.round(x * 100) / 100 : null);

const totalReqs = sum(loads.map((l) => l.requests));
const totalRps  = sum(loads.map((l) => l.throughputPerSec));
const total429  = sum(loads.map((l) => l.rateLimited));
const total5xx  = sum(loads.map((l) => l.serverErrors));

const report = {
  generatedAt: new Date().toISOString(),
  machines: loads.length,
  distinctIps: [...new Set(probes.map((p) => p.publicIp))].length,
  aggregate: {
    requests: totalReqs,
    requestsPerSecond: r2(totalRps),
    rateLimited: total429,
    rateLimitedShare: totalReqs ? r2(total429 / totalReqs) : null,
    serverErrors: total5xx,
    serverErrorShare: totalReqs ? r2(total5xx / totalReqs) : null,
    edgeHitRate: r2(avg(loads.map((l) => l.edgeHitRate))),
  },
  latencyMs: {
    edgeP95Avg:   r2(avg(loads.map((l) => l.ttfb?.edge?.p95))),
    edgeP95Worst: r2(max(loads.map((l) => l.ttfb?.edge?.p95))),
    originP95Avg: r2(avg(loads.map((l) => l.ttfb?.origin?.p95))),
    originP95Worst: r2(max(loads.map((l) => l.ttfb?.origin?.p95))),
    herdP50Avg:   r2(avg(loads.map((l) => l.ttfb?.herd?.p50))),
    herdMaxWorst: r2(max(loads.map((l) => l.ttfb?.herd?.max))),
  },
  connectionMs: {
    coldTlsP50: r2(avg(probes.flatMap((p) => p.cold.map((c) => c.tlsMs)))),
    coldTtfbP50: r2(avg(probes.flatMap((p) => p.cold.map((c) => c.ttfbMs)))),
    warmTtfbP50: r2(avg(probes.flatMap((p) => p.warmTtfbMs.slice(1)))),
  },
  slowestColdPaths: probes
    .flatMap((p) => p.cold.map((c) => ({ path: c.path, ttfbMs: r2(c.ttfbMs), machine: p.machine })))
    .sort((a, b) => b.ttfbMs - a.ttfbMs).slice(0, 8),
  colos: [...new Set(probes.flatMap((p) => p.cold.map((c) => (c.cfRay || "").split("-")[1]).filter(Boolean)))],
  perMachine: loads.map((l) => ({
    machine: l.machine, requests: l.requests, rps: r2(l.throughputPerSec),
    edgeP95: l.ttfb?.edge?.p95, originP95: l.ttfb?.origin?.p95,
    rateLimited: l.rateLimited, serverErrors: l.serverErrors,
  })),
};

writeFileSync("report.json", JSON.stringify(report, null, 2));

const L = (k, v) => `${String(k).padEnd(26)} ${v}`;
console.log(`
==========================================================
  ÖffiGo API — distributed load test report
==========================================================
${L("machines / distinct IPs", `${report.machines} / ${report.distinctIps}`)}
${L("Cloudflare colos", report.colos.join(", ") || "n/a")}

  AGGREGATE
${L("  total requests", report.aggregate.requests)}
${L("  combined req/s", report.aggregate.requestsPerSecond)}
${L("  edge hit rate", report.aggregate.edgeHitRate)}
${L("  rate limited (429/403)", `${report.aggregate.rateLimited} (${report.aggregate.rateLimitedShare} of all)`)}
${L("  server errors (5xx)", `${report.aggregate.serverErrors} (${report.aggregate.serverErrorShare})`)}

  LATENCY (TTFB, ms) — served requests only; refusals excluded
${L("  share of run served", report.aggregate.rateLimitedShare != null
    ? `${Math.round((1 - report.aggregate.rateLimitedShare) * 100)}%`
    : "unknown")}
${L("  edge p95 avg / worst", `${report.latencyMs.edgeP95Avg} / ${report.latencyMs.edgeP95Worst}`)}
${L("  origin p95 avg / worst", `${report.latencyMs.originP95Avg} / ${report.latencyMs.originP95Worst}`)}
${L("  herd p50 / worst max", `${report.latencyMs.herdP50Avg} / ${report.latencyMs.herdMaxWorst}`)}

  CONNECTION (ms)
${L("  cold TLS handshake", report.connectionMs.coldTlsP50)}
${L("  cold TTFB", report.connectionMs.coldTtfbP50)}
${L("  warm TTFB (reused)", report.connectionMs.warmTtfbP50)}

  SLOWEST COLD PATHS
${report.slowestColdPaths.map((s) => `    ${String(s.ttfbMs).padStart(8)} ms  ${s.path}`).join("\n")}
==========================================================
`);
