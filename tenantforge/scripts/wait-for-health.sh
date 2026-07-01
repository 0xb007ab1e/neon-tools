#!/usr/bin/env bash
# Poll a URL until it returns HTTP 200, bounded by a timeout. Used by the DAST workflow to gate
# the ZAP scan on the control-plane API actually being up (fail-closed: exit non-zero if it never
# comes up, so a boot failure fails the job rather than scanning nothing).
#
# Usage: wait-for-health.sh <url> [timeout_seconds] [interval_seconds]
#   url               — the health endpoint to poll (e.g. http://127.0.0.1:3000/health)
#   timeout_seconds   — total time to wait before giving up (default 60)
#   interval_seconds  — delay between attempts (default 2)
set -euo pipefail
IFS=$'\n\t'

url="${1:?usage: wait-for-health.sh <url> [timeout_seconds] [interval_seconds]}"
timeout="${2:-60}"
interval="${3:-2}"

deadline=$(( $(date +%s) + timeout ))
attempt=0

while :; do
  attempt=$(( attempt + 1 ))
  # -s silent, -o /dev/null discard body, -w print only the status code; --max-time bounds a hung
  # connect so a wedged server can't stall the poll (topic-reliability: timeouts on every call).
  # On a connect failure curl both prints "000" via -w and exits non-zero; take whichever we get and
  # normalise an empty/failed read to "000" so the comparison below is well-defined.
  if ! code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url")"; then
    code=000
  fi
  [ -n "$code" ] || code=000
  if [ "$code" = "200" ]; then
    echo "ready after ${attempt} attempt(s): ${url} -> ${code}"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::${url} did not return 200 within ${timeout}s (last status: ${code})" >&2
    exit 1
  fi
  echo "waiting for ${url} (attempt ${attempt}, last status: ${code})…"
  sleep "$interval"
done
