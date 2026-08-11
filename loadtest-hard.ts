// Hard load test — hammer EVERY /v1 endpoint at once, ramping the rate up
// round by round, and watch where the server starts saying "no".
//
// Run it:   node loadtest-hard.ts
//
// THE ONE RULE (again): only /v1 paths in here.
// /v1/* is answered from the server's memory or rejected before it reaches VAO,
// so it costs nothing from the 950/day contract. /v2/* would. Never add a /v2
// path to this list.
//
// This one DOES trip your rate limiter (120 requests/minute per IP) on the
// paths that reach your server. That is the point — you asked to see what
// happens. It only trips it for your own home IP, it is pseudonymous, and it
// resets after a minute.

const BASE: string = "https://api.oeffigo.app";

// Every public /v1 endpoint. Some answer 200, some 400 (they want parameters we
// are not sending), one 404. For a load test that does not matter at all — a
// 400 still means "the request reached the server and got an answer".
const ENDPOINTS: string[] = [
  "/v1/status", // cached at the edge
  "/v1/announcements", // cached at the edge
  "/v1/history", // cached at the edge
  "/v1/network-maps", // cached at the edge
  "/v1/config", // cached at the edge
  "/v1/health", // reaches the server (no-store)
  "/v1/predictions", // reaches the server
  "/v1/vehicles", // reaches the server
  "/v1/wiener-linien/metro", // reaches the server
  "/v1/nope", // reaches the server (404)
];

// Each round fires this many requests per endpoint, then waits a second.
// It ramps up so you can watch the server hold, then start pushing back.
const ROUNDS: number[] = [20, 50, 100, 200, 300];

// ---------------------------------------------------------------------------

interface Result {
  path: string;
  status: number; // HTTP code, or 0 if the request never arrived
  edge: string; // Cloudflare's cf-cache-status: HIT / BYPASS / MISS / ""
  ms: number;
}

async function fireOne(path: string): Promise<Result> {
  const start = Date.now();

  try {
    const response = await fetch(`${BASE}${path}`);
    await response.text(); // drain the body so the connection can be reused

    return {
      path,
      status: response.status,
      edge: response.headers.get("cf-cache-status") ?? "",
      ms: Date.now() - start,
    };
  } catch {
    return { path, status: 0, edge: "", ms: Date.now() - start };
  }
}

// Fire `count` requests at every endpoint, all at the same time.
async function burst(count: number): Promise<Result[]> {
  const pending: Promise<Result>[] = [];

  for (const path of ENDPOINTS) {
    for (let i = 0; i < count; i++) {
      pending.push(fireOne(path));
    }
  }

  return await Promise.all(pending);
}

// { "200": 12, "429": 88 }  — one bucket per status code.
function countStatus(results: Result[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const r of results) {
    const key = r.status === 0 ? "failed" : String(r.status);
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return counts;
}

// "200×40  429×160"
function formatCounts(counts: Record<string, number>): string {
  return Object.keys(counts)
    .sort()
    .map((key) => `${key}×${counts[key]}`)
    .join("  ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const total = ROUNDS.reduce((a, b) => a + b, 0) * ENDPOINTS.length;
  console.log(`\nHammering ${ENDPOINTS.length} endpoints, ramping up.`);
  console.log(`${total} requests total.\n`);

  const everything: Result[] = [];

  for (const count of ROUNDS) {
    const startedAt = Date.now();

    const results = await burst(count);
    everything.push(...results);

    const perEndpoint = count;
    const took = Date.now() - startedAt;

    console.log(
      `${String(perEndpoint).padStart(3)}/endpoint  ` +
        `${formatCounts(countStatus(results)).padEnd(34)}` +
        `${results.length} reqs in ${took}ms`,
    );

    if (took < 1000) await sleep(1000 - took);
  }

  // ---- per-endpoint breakdown: who held, who pushed back ----

  console.log("\nper endpoint:");
  for (const path of ENDPOINTS) {
    const mine = everything.filter((r) => r.path === path);
    // The last edge status we saw for this path, as a hint of how it is served.
    const edge = mine.map((r) => r.edge).filter((e) => e !== "").pop() ?? "-";

    console.log(
      `  ${path.padEnd(26)}${edge.padEnd(8)}` +
        formatCounts(countStatus(mine)),
    );
  }

  // ---- overall ----

  console.log(`\ntotal      ${everything.length} requests`);
  console.log(`status     ${formatCounts(countStatus(everything))}`);

  const ok = everything.filter((r) => r.status === 200).length;
  const limited = everything.filter((r) => r.status === 429).length;
  console.log(
    `\n${ok} answered OK, ${limited} rate-limited (429). ` +
      `The 429s are the endpoints that reach your server saying "slow down".\n`,
  );
}

main();
