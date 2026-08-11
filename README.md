# ÖffiGo Server Tests

Load- and rate-limit tests for the ÖffiGo backend (`https://api.oeffigo.app`).
Separate from the app repo on purpose — this is throwaway probing tooling, not
production code.

## The one rule

**Only `/v1/*` paths.** They are answered from the server's memory or rejected
before they reach VAO, so they cost nothing from the contractual 950/day budget.
`/v2/*` goes through to VAO and costs real budget — never point a load test at it.

## Files

| File | What it is | Run |
|------|-----------|-----|
| `loadtest.ts` | Simple Node load test, one endpoint. Good for reading. | `node loadtest.ts` |
| `loadtest-hard.ts` | Node, hammers all `/v1` endpoints. Shows the laptop choke. | `node loadtest-hard.ts` |
| `loadtest.k6.js` | The real tool. k6, reuses connections, no choke. | `k6 run loadtest.k6.js` |
| `.github/workflows/loadtest.yml` | Distributed test — many CI machines, many IPs, free. | Actions tab → Run workflow |

## What each one is for

- **One machine, quick look:** `k6 run loadtest.k6.js` (or `-e RATE=500` to push).
- **Real distributed load without paying:** push this repo to GitHub and run the
  workflow. Each runner is a separate machine with its own IP, so the per-IP
  rate limiter is exercised in parallel — the free version of k6 Cloud.

## What we already learned

- A 10-second edge cache (Cloudflare) shields the origin. Cached `/v1` paths
  (`/v1/status`, `/v1/config`, …) never reach the server under load.
- Origin-reaching paths (`/v1/health`, `/v1/vehicles`, a 404, …) get throttled
  at 120 requests/minute per IP. The limiter works.
- From one machine you measure your own rate-limit bucket, not the server's
  ceiling. Multiple IPs (the workflow) are needed to load the origin for real.
