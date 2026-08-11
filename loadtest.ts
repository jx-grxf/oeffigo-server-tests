// Load test — fire many requests per second and see what the server says.
//
// Run it:   node loadtest.ts
//
// IMPORTANT: only ever point this at /v1/status or /v1/health.
// Those are answered from the server's memory and never call VAO.
// Do NOT point it at /v2/* — every one of those can cost a request from your
// contractual VAO day budget (950/day), and that limit is real money and a real
// contract, not a soft limit you can retry past.

const TARGET: string = "https://api.oeffigo.app/v1/status";

const PER_SECOND: number = 100; // how many requests per second
const SECONDS: number = 5; // for how many seconds

// ---------------------------------------------------------------------------

interface Result {
  status: number; // the HTTP code, or 0 if the request never arrived
  ms: number; // how long it took
}

// One single request, timed.
async function fireOne(url: string): Promise<Result> {
  const start = Date.now();

  try {
    const response = await fetch(url);

    // Read the body even though we throw it away. If you don't, Node keeps the
    // connection open waiting for someone to read it, and you slowly run out.
    await response.text();

    return { status: response.status, ms: Date.now() - start };
  } catch {
    // No answer at all: DNS failed, connection refused, timeout.
    return { status: 0, ms: Date.now() - start };
  }
}

// A whole burst at once.
//
// The trick: don't `await` inside the loop. That would wait for request 1 to
// finish before starting request 2 — one after another, not at the same time.
// Instead collect the promises and hand them all to Promise.all.
async function burst(url: string, count: number): Promise<Result[]> {
  const pending: Promise<Result>[] = [];

  for (let i = 0; i < count; i++) {
    pending.push(fireOne(url));
  }

  return await Promise.all(pending);
}

// Count how often each status code appeared: { "200": 12, "429": 88 }
function countStatus(results: Result[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const r of results) {
    const key = r.status === 0 ? "failed" : String(r.status);
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return counts;
}

function average(numbers: number[]): number {
  if (numbers.length === 0) return 0;

  let sum = 0;
  for (const n of numbers) sum += n;

  return Math.round(sum / numbers.length);
}

// "200×12  429×88"
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
  console.log(`\n${TARGET}`);
  console.log(`${PER_SECOND} requests/second for ${SECONDS} seconds\n`);

  const everything: Result[] = [];

  for (let second = 1; second <= SECONDS; second++) {
    const startedAt = Date.now();

    const results = await burst(TARGET, PER_SECOND);
    everything.push(...results);

    const times = results.map((r) => r.ms);
    const took = Date.now() - startedAt;

    console.log(
      `s${second}  ${formatCounts(countStatus(results)).padEnd(28)}` +
        `avg ${String(average(times)).padStart(4)}ms   ` +
        `burst took ${took}ms`,
    );

    // If the burst itself took longer than a second, we are already behind and
    // there is nothing left to wait for.
    if (took < 1000) {
      await sleep(1000 - took);
    }
  }

  // ---- summary ----

  const times = everything.map((r) => r.ms);
  times.sort((a, b) => a - b);

  console.log(`\ntotal      ${everything.length} requests`);
  console.log(`status     ${formatCounts(countStatus(everything))}`);
  console.log(`fastest    ${times[0]}ms`);
  console.log(`median     ${times[Math.floor(times.length / 2)]}ms`);
  console.log(`slowest    ${times[times.length - 1]}ms`);
  console.log(`average    ${average(times)}ms\n`);
}

main();
