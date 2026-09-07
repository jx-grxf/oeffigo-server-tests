// The endpoint catalogue, and the safety rules that decide what may be loaded.
//
// THE BUDGET RULE. Every VAO provider call is drawn from a contractual
// 950/service/day allowance that is global and fail-closed: spend it here and
// real users get errors. So this file lists only paths that are answered from
// the server's memory, from Postgres, or rejected before a provider is touched.
//
// Concretely that means: all of /v1, plus the /v2 *auxiliary* paths (status,
// config, announcements, network-maps, meta, schema) which are first-party
// services, not contract routes. It does NOT mean /v2/stops, /v2/trips,
// /v2/stops/{id}/departures or any other contract route — those reach VAO.
//
// Two paths carry their own warnings and are opt-in only, see EXPENSIVE below.

/** Edge-cached reads. Cloudflare answers most of these; the origin sees few. */
export const EDGE_PATHS = [
  "/v1/status",
  "/v1/config",
  "/v1/announcements",
  "/v1/network-maps",
  "/v2/status",
  "/v2/config",
  "/v2/announcements",
  "/v2/network-maps",
  "/v2/meta",
  "/v2/schema",
  "/robots.txt",
  "/",
];

/** Reads that reach the origin process on every miss. `no-store` at the origin,
 *  10 s at the edge — so under load the edge absorbs bursts but not the baseline.
 *
 * `/v1/vehicles` without a bbox is the passive in-memory snapshot. A bbox is a
 * different question and lives only in PROVIDER_PATHS below. */
export const ORIGIN_PATHS = [
  "/v1/health",
  "/v1/predictions?lat=48.2082&lon=16.3738&radius=2000&limit=50",
  "/v1/vehicles",
];

/** Real provider work. Never imported by the default load test. The separate
 * provider probe requires an explicit environment acknowledgement and runs at
 * a bounded cadence with this one fixed viewport. */
export const PROVIDER_PATHS = [
  "/v1/vehicles?minLat=48.05&minLon=16.15&maxLat=48.35&maxLon=16.75",
];

/** A path that exists on no route table. Cheapest possible origin round trip,
 *  which makes it the cleanest probe of pure request-handling overhead. */
export const NOTFOUND_PATH = "/v1/definitely-not-a-route";

/**
 * Paths that cost real work per distinct query and must never be randomised.
 *
 * `/v1/history` runs a multi-aggregate over a 90-day window. Its parameters
 * (from/to/line/source) are part of both the edge cache key and the origin's
 * own cache key, so a randomised parameter is a cache miss *and* a fresh
 * Postgres aggregate — measured at 1.2-3.3 s each against a pool of three
 * connections. Randomising it is a denial-of-service against our own database.
 *
 * It is included here with its DEFAULT window only, which is the one every real
 * client asks for and which the caches actually hold.
 */
export const EXPENSIVE_PATHS = ["/v1/history"];

/**
 * Never loaded, at any rate, under any flag.
 * - /v1/wiener-linien/* sits behind a global fair-use brake at the provider.
 * - every /v2 contract route spends the VAO allowance.
 */
export const FORBIDDEN = [
  /^\/v1\/wiener-linien\//,
  /^\/v2\/stops/,
  /^\/v2\/journeys/,
  /^\/v2\/trips/,
  /^\/v2\/footpath/,
  /^\/v2\/disruptions/,
  /^\/v2\/history/,
  /^\/v2\/vehicles/,
  /^\/v2\/predictions/,
  /^\/v2\/rescue/,
  /^\/v1\/hci\//,
  /^\/v1\/rescue/,
  /^\/v1\/vehicles\?.*(?:minLat|maxLat|minLon|maxLon)=/,
];

/** Fails the run rather than the contract. Called once at startup. */
export function assertSafe(paths, { allowProviderPaths = false } = {}) {
  for (const p of paths) {
    if (allowProviderPaths && PROVIDER_PATHS.includes(p)) continue;
    for (const bad of FORBIDDEN) {
      if (bad.test(p)) {
        throw new Error(
          `refusing to load ${p}: it reaches a provider or a fair-use-braked upstream`,
        );
      }
    }
  }
}
