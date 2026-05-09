#!/usr/bin/env bash
# Phase-5 OG smoke test.
#
# Hits /api/og/m/:slug on the target host with several crawler UAs and a
# plain Chrome UA. Asserts the response codes and that og:image is present
# in the body. The endpoint is UA-agnostic — UA-based routing happens in
# the Cloudflare Worker — so all calls should return 200 with og:* tags
# when the slug is live.
#
# Usage:
#   SLUG=abcd1234 BASE_URL=https://overhype.me bash scripts/phase5-og-smoke.sh
#
# In CI this is intentionally NOT run automatically; it depends on a live
# slug existing.

set -euo pipefail

BASE_URL="${BASE_URL:-https://overhype.me}"
SLUG="${SLUG:?SLUG env var is required}"

UAS=(
  "Twitterbot/1.0"
  "Mozilla/5.0 (compatible; facebookexternalhit/1.1; +http://www.facebook.com/externalhit_uatext.php)"
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)"
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)"
  "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)"
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36"
)

failures=0
for ua in "${UAS[@]}"; do
  echo
  echo "── $ua"
  response=$(curl -sS -A "$ua" -o /tmp/phase5-og-body.html -w "%{http_code}" "$BASE_URL/api/og/m/$SLUG")
  echo "HTTP $response"
  if [[ "$response" != "200" && "$response" != "404" && "$response" != "410" ]]; then
    echo "✗ unexpected status"
    failures=$((failures + 1))
    continue
  fi
  if ! grep -q 'og:image' /tmp/phase5-og-body.html; then
    echo "✗ og:image missing"
    failures=$((failures + 1))
    continue
  fi
  echo "✓ og:image present"
done

echo
if (( failures > 0 )); then
  echo "FAIL — $failures UAs failed"
  exit 1
fi
echo "OK — all UAs returned valid OG HTML"
