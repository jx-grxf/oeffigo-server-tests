// Explicit, bounded mgate on-demand probe. This is not a load test.
// Run only after checking the provider budget:
//   k6 run -e ALLOW_PROVIDER_UPSTREAM=1 scripts/provider-probe.k6.js

import http from "k6/http";
import { check, sleep } from "k6";
import { PROVIDER_PATHS, assertSafe } from "../lib/targets.js";

if (__ENV.ALLOW_PROVIDER_UPSTREAM !== "1") {
  throw new Error("provider probe disabled: set ALLOW_PROVIDER_UPSTREAM=1 explicitly");
}
assertSafe(PROVIDER_PATHS, { allowProviderPaths: true });

const BASE = __ENV.BASE || "https://api.oeffigo.app";
export const options = {
  vus: 1,
  iterations: 3,
  discardResponseBodies: true,
};

export default function () {
  const response = http.get(`${BASE}${PROVIDER_PATHS[0]}`, {
    tags: { scenario: "explicit-provider-probe" },
  });
  check(response, { "provider probe answered": (result) => result.status !== 0 });
  // Longer than the server's 15 s on-demand TTL: every iteration is visible
  // budget work, bounded to exactly three calls in the worst case.
  sleep(20);
}
