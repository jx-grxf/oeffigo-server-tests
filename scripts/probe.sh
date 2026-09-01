#!/usr/bin/env bash
# Connection-level probe. k6 measures load; this measures the things a load
# generator averages away: what a COLD client pays before the first byte, which
# Cloudflare colo answered, and whether the caches behave as the headers claim.
#
# Emits one JSON document on stdout.
set -uo pipefail

BASE="${BASE:-https://api.oeffigo.app}"
MACHINE="${MACHINE:-local}"
HOST="${BASE#https://}"

# One cold request per path: a fresh process, so a fresh TCP + TLS handshake.
cold() {
  curl -sS --compressed -o /dev/null -D /tmp/probe_h "$BASE$1" \
    -w '%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{size_download} %{http_version}' 2>/dev/null
}
hdr() { grep -i "^$1:" /tmp/probe_h 2>/dev/null | tr -d '\r' | head -1 | cut -d' ' -f2-; }

printf '{\n  "machine": %s,\n  "base": %s,\n  "at": %s,\n' \
  "\"$MACHINE\"" "\"$BASE\"" "\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""

printf '  "publicIp": "%s",\n' "$(curl -sS --max-time 10 https://api.ipify.org 2>/dev/null || echo unknown)"

# --- cold connection cost, per path ---
printf '  "cold": [\n'
FIRST=1
for p in /v1/health /v1/status /v1/config /v1/history /v2/meta /v2/schema /robots.txt; do
  read -r code dns conn tls ttfb total size ver <<<"$(cold "$p")"
  [ $FIRST -eq 0 ] && printf ',\n'; FIRST=0
  printf '    {"path": "%s", "code": %s, "dnsMs": %.1f, "tcpMs": %.1f, "tlsMs": %.1f, "ttfbMs": %.1f, "totalMs": %.1f, "bytes": %s, "httpVersion": "%s", "cfCache": "%s", "cfRay": "%s", "railwayEdge": "%s", "encoding": "%s"}' \
    "$p" "${code:-0}" \
    "$(echo "${dns:-0} * 1000" | bc -l)" "$(echo "${conn:-0} * 1000" | bc -l)" \
    "$(echo "${tls:-0} * 1000" | bc -l)" "$(echo "${ttfb:-0} * 1000" | bc -l)" \
    "$(echo "${total:-0} * 1000" | bc -l)" "${size:-0}" "${ver:-0}" \
    "$(hdr cf-cache-status)" "$(hdr cf-ray)" "$(hdr x-railway-edge)" "$(hdr content-encoding)"
done
printf '\n  ],\n'

# --- warm: one connection, ten sequential requests ---
# The gap between this and "cold" above is exactly what a new TCP+TLS costs,
# which is the single biggest lever a mobile client has.
ARGS=(); for i in $(seq 1 10); do ARGS+=( -o /dev/null "$BASE/v2/meta" ); done
WARM=$(curl -sS --compressed -w '%{time_starttransfer} ' "${ARGS[@]}" 2>/dev/null)
printf '  "warmTtfbMs": [%s],\n' "$(echo "$WARM" | tr ' ' '\n' | grep -v '^$' | awk '{printf "%s%.1f", (NR>1?", ":""), $1*1000}')"

# --- does the edge actually hold what its headers promise? ---
# Two identical requests back to back: the second must be a HIT if the TTL is real.
curl -sS -o /dev/null -D /tmp/probe_h "$BASE/v2/meta" >/dev/null 2>&1; ONE=$(hdr cf-cache-status)
curl -sS -o /dev/null -D /tmp/probe_h "$BASE/v2/meta" >/dev/null 2>&1; TWO=$(hdr cf-cache-status)
printf '  "cacheProbe": {"first": "%s", "second": "%s"},\n' "$ONE" "$TWO"

# --- protocol support ---
# Whether the SERVER offers HTTP/3, which is an alt-svc advertisement, and
# separately whether THIS curl can speak it. Conflating the two reports a
# missing client feature as a missing server feature.
curl -sS -o /dev/null -D /tmp/probe_h "$BASE/v2/meta" >/dev/null 2>&1
ALTSVC=$(hdr alt-svc | tr -d '"')
if curl -V | grep -q HTTP3; then
  H3=$(curl -sS --http3-only -o /dev/null -w '%{http_version}' --max-time 8 "$BASE/v2/meta" 2>/dev/null || echo "failed")
else
  H3="client-cannot-test"
fi
printf '  "http3Advertised": "%s",\n  "http3Negotiated": "%s",\n' "$ALTSVC" "$H3"
TLSV=$(curl -sS -o /dev/null -w '%{ssl_verify_result}' -v "$BASE/v2/meta" 2>&1 | grep -oE 'TLSv1\.[23]' | head -1)
printf '  "tls": "%s"\n' "${TLSV:-unknown}"
printf '}\n'
