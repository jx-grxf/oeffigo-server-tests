# ÖffiGo server tests

Load, latency and cache probing for the ÖffiGo backend. Deliberately separate
from the app repo: this is measurement tooling, not production code.

## The rule that matters

**Nothing here may reach VAO.** Every provider call is drawn from a contractual
per-service daily allowance that is global and fail-closed — spending it in a
load test takes the app down for real users. `lib/targets.js` therefore lists
only paths answered from the server's memory, from Postgres, or rejected before
a provider is touched, and `assertSafe()` fails the run at startup if a
forbidden path ever creeps into the catalogue.

That means all of `/v1`, plus the `/v2` *auxiliary* paths (`status`, `config`,
`announcements`, `network-maps`, `meta`, `schema`). It does **not** mean the
`/v2` contract routes, `/v1/hci/*`, `/v1/rescue`, or `/v1/wiener-linien/*`
(the last sits behind a fair-use brake at the upstream).

`/v1/history` is included with its **default window only**. Its query parameters
are part of both the edge cache key and the origin's own cache key, so a
randomised parameter is a cache miss *and* a fresh multi-aggregate over Postgres.
Randomising it is a denial-of-service against our own database. Don't.

## Files

| File | What it does |
|------|--------------|
| `scripts/loadtest.k6.js` | Five k6 scenarios: keepalive, edge, origin, herd, ratelimit |
| `scripts/probe.sh` | Connection-level facts: cold TCP/TLS cost, colo, cache, protocol |
| `scripts/aggregate.mjs` | Merges every runner's JSON into one report |
| `lib/targets.js` | The endpoint catalogue and the safety assertions |
| `.github/workflows/loadtest.yml` | The distributed run |

## Running it

```bash
k6 run scripts/loadtest.k6.js                 # full run, ~3 min
k6 run -e SMOKE=1 -e RATE=6 scripts/loadtest.k6.js   # ~40 s, validates the script
./scripts/probe.sh | jq                        # connection facts only
```

Distributed: Actions tab → "distributed load test" → Run workflow. Pick the
number of machines; each is a separate runner with its own public IP. The final
`report` job merges every runner's artifacts and writes the verdict to the job
summary.

## What a single machine can and cannot tell you

Every per-IP limit in the API is a separate bucket per source address, and the
edge adds its own per-IP-and-colo flood guard on top. From one machine you
therefore measure **your own bucket**, not the server — push the rate up and you
are simply counting your own 429s.

This is why the workflow uses a matrix. N runners are N addresses, so together
they load the origin rather than one bucket. Even then the honest framing is
that this measures *the protective layer's behaviour under distributed load*
(edge offload, latency degradation, the shape of the 429 curve, absence of 5xx)
rather than the raw ceiling of the origin process, which is not observable from
outside the limits. A true capacity number needs the buckets raised by
environment variable, or a local instance with provider stubs.

## Reading the output

- **429 and 403 are not failures.** They are the limiter doing its job, and they
  are counted separately. Only 5xx is a server error, and the run's threshold is
  set against that.
- **Edge and origin latency are reported apart.** A cache hit and a cache miss
  are different products; averaging them together hides the only number that
  moves.
- **The herd scenario** starts every VU on one identical resource at the same
  instant. If cost stays flat as concurrency grows, request coalescing is
  working; if it grows with N, it is not.

Runners are GitHub-hosted and mostly US-based, so absolute latency from CI is
not what an Austrian phone sees. Compare runs against each other, and use
`probe.sh` from a local machine for numbers that represent real users.
