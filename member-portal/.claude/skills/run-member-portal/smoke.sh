#!/usr/bin/env bash
# Drives the member-portal local preview end-to-end over plain curl: boots
# `wrangler dev:local` against fake data (src/index.local.ts — no Monday API token or
# real email sending needed), logs in as a fake donor via the console-logged magic
# link, and verifies the authenticated portal page renders that donor's data.
#
# Usage (run from anywhere — the script cd's to the unit root itself):
#   smoke.sh start            boot the server in the background, wait for readiness
#   smoke.sh login [email]    full login flow for one fake donor (default: family@example.com)
#   smoke.sh stop             kill whatever's listening on :8787
#   smoke.sh                  start -> login -> verify -> stop, all in one shot (the demo)
#
# Fake donor emails (src/monday/fakeClient.ts): jordan@example.com (single donor),
# family@example.com (two-person household — Sam & Riley Rivera, exercises the
# multi-donor-per-email UI), casey@example.com.
#
# Artifacts land in $TMPDIR/member-portal-run/ (server.log, cookies.txt, the last
# fetched portal.html).

set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)" # -> member-portal/ (unit root)

PORT=8787
RUN_DIR="${TMPDIR:-/tmp}/member-portal-run"
LOG="$RUN_DIR/server.log"
COOKIES="$RUN_DIR/cookies.txt"

mkdir -p "$RUN_DIR"

start() {
  if lsof -ti:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "already running on :$PORT" >&2
    return 0
  fi
  npm run predev:local >"$RUN_DIR/migrate.log" 2>&1
  nohup npm run dev:local >"$LOG" 2>&1 &
  echo "launching (pid $!), log at $LOG"
  for _ in $(seq 1 30); do
    curl -sf "http://localhost:$PORT/" -o /dev/null && { echo "ready on :$PORT"; return 0; }
    sleep 1
  done
  echo "server did not become ready within 30s — check $LOG" >&2
  exit 1
}

# Login is rate-limited at 5 attempts / 15 min per email (config.rateLimit) — and a
# rate-limited request returns the exact same "Check Your Email" 200 response as a
# real send (deliberate anti-enumeration design, see README's Auth section), so
# hammering the same fake donor email while iterating on this script silently stops
# producing magic links with no error anywhere. Clear it between runs.
reset_rate_limit() {
  npx wrangler d1 execute svbc-member-portal-local --local --config wrangler.local.jsonc \
    --command "DELETE FROM login_attempts;" >/dev/null
  echo "cleared login_attempts"
}

stop() {
  # Killing just the :8787 listener (workerd) leaves its parent `wrangler dev` /
  # npm process running orphaned — it doesn't die with its child. Repeat that
  # mistake a few times while iterating and you get a pile of zombie wrangler
  # processes all watching (and rewriting) the same .wrangler/state directory,
  # which makes the *next* server flap ("Connection status updated" in a loop,
  # never reaching "Ready on") instead of booting cleanly. Kill both: the port
  # listener for an immediate socket release, and the wrangler process itself
  # by its exact command line (specific to this config file — never matches
  # the agent's own session).
  lsof -ti:"$PORT" -sTCP:LISTEN | xargs -r kill || true
  pkill -f "wrangler dev --config wrangler.local.jsonc" || true
  echo "stopped :$PORT"
}

# Full login flow for one fake donor email. Prints the magic link, writes a cookie
# jar, and fetches the authenticated portal page.
#
# The home route `/` is ALWAYS the login form — it never checks the session cookie.
# The authenticated page lives at `/:locale/portal` (the callback redirects there).
# Hitting `/` after logging in and expecting to see donor data is the mistake to not
# make here; it will look like the session didn't take even though it did.
login() {
  local email="${1:-family@example.com}"
  rm -f "$COOKIES"
  reset_rate_limit
  curl -sS -X POST "http://localhost:$PORT/" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "email=$email" -o /dev/null

  # wrangler's console.log output is block-buffered when redirected to a file, so the
  # "Login link" line can lag a beat behind the POST that triggered it — poll instead
  # of grepping once immediately after the request.
  local link=""
  for _ in $(seq 1 20); do
    link=$(grep -a -A1 "Login link for $email" "$LOG" | tail -1 | tr -d ' ') || true
    [ -n "$link" ] && break
    sleep 0.25
  done
  if [ -z "$link" ]; then
    echo "no magic link found in $LOG for $email — did start/predev run first?" >&2
    return 1
  fi
  echo "magic link: $link"

  # -L: the callback 302-redirects straight to /:locale/portal, which is the page we
  # actually want to assert against. -c saves the session cookie for later requests.
  curl -sS -c "$COOKIES" -L "$link" -o "$RUN_DIR/portal.html"
  echo "cookie jar: $COOKIES"
  echo "portal html: $RUN_DIR/portal.html"
}

demo() {
  start
  if ! login "${1:-family@example.com}"; then
    stop
    return 1
  fi
  echo "--- donor names found on the portal page ---"
  grep -o 'Sam Rivera\|Riley Rivera\|Jordan Alvarez\|Casey Nguyen' "$RUN_DIR/portal.html" | sort -u
  stop
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  reset) reset_rate_limit ;;
  login) shift; login "$@" ;;
  demo) shift; demo "$@" ;;
  "") demo ;;
  *)
    echo "usage: $0 {start|stop|reset|login [email]|demo [email]}" >&2
    exit 1
    ;;
esac
