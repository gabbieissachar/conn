#!/bin/bash
# The transcript reader's own server: start, stop, restart and status, on its own port.
# It serves only the reader's pages and /api/transcript-reader/* (server.js), apart
# from setup/serve.sh and the pages that one serves.
#
# Usage: bash setup/transcript-reader/serve.sh [start|stop|restart|status] [--port <port>]
#   start    start it if it is not running (the default command)
#   stop     stop this copy's server on the port; never another copy's or another app's
#   restart  stop, then start (after changing api.js or server.js)
#   status   say whether the port serves this copy, another copy of the repo, or nothing
# Port: --port, else PMOS_READER_PORT, else 8768. 8765 and 8766 belong to other pages.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
PORT="${PMOS_READER_PORT:-8768}"
COMMAND="start"

while [[ $# -gt 0 ]]; do
  case "$1" in
    start|stop|restart|status) COMMAND="$1"; shift ;;
    --port) PORT="${2:-}"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done

if [[ ! "$PORT" =~ ^[0-9]{2,5}$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "Invalid port: $PORT"
  exit 2
fi
if [[ "$PORT" == "8765" || "$PORT" == "8766" ]]; then
  echo "Port $PORT belongs to other pages. Pick another with --port or PMOS_READER_PORT (default 8768)."
  exit 2
fi

LOG_PATH="$HERE/out/server-$PORT.log"
# Same value as copyId in api.js: a hash of this copy's real path.
COPY="$(printf %s "$REPO_ROOT" | shasum -a 256 | cut -c1-16)"

listener() { lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1; }
# The copy header of whatever answers on the port: this copy's id, another's, or empty (not a reader server).
served_copy() { curl --max-time 2 -sI "http://localhost:$PORT/" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1)=="x-transcript-reader-copy" {print $2}'; }
# Where the process listening on the port was started (server.js runs from its repo copy's root).
where() { lsof -a -d cwd -p "$1" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }

describe() {
  local pid copy
  pid="$(listener)"
  if [[ -z "$pid" ]]; then echo "Nothing listens on port $PORT."; return 1; fi
  copy="$(served_copy)"
  if [[ "$copy" == "$COPY" ]]; then echo "Port $PORT serves this copy of the repo ($REPO_ROOT), pid $pid."; return 0; fi
  if [[ -n "$copy" ]]; then echo "Port $PORT serves another copy of the repo ($(where "$pid")), pid $pid."; return 2; fi
  echo "Port $PORT is used by another server (pid $pid), not a transcript reader."
  return 3
}

stop() {
  describe >/dev/null; local state=$?
  case $state in
    0) kill "$(listener)" 2>/dev/null; sleep 0.3; echo "Stopped the reader server on port $PORT." ;;
    1) echo "Nothing listens on port $PORT." ;;
    *) describe; echo "Not stopping it."; return 1 ;;
  esac
}

start() {
  describe >/dev/null; local state=$?
  case $state in
    0) echo "Reader server already running on port $PORT: http://localhost:$PORT"; return 0 ;;
    2|3) describe; echo "Pick another port with --port or PMOS_READER_PORT."; return 1 ;;
  esac
  if ! command -v node &>/dev/null; then echo "Node.js not found. Run: bash setup/check.sh"; return 1; fi
  # out/ holds private transcript text, so it and the server's log are the owner's alone, like Claude's logs.
  mkdir -p "$HERE/out" && chmod 700 "$HERE/out"
  [[ -f "$LOG_PATH" ]] && chmod 600 "$LOG_PATH"
  # node alone goes to the background (not a "cd && node" list, whose subshell would keep this script's output open).
  ( cd "$REPO_ROOT" || exit 1; umask 077; nohup node "$HERE/server.js" --port "$PORT" --root "$REPO_ROOT" >> "$LOG_PATH" 2>&1 < /dev/null & )
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.3
    [[ "$(served_copy)" == "$COPY" ]] && { echo "Reader server started: http://localhost:$PORT"; echo "Log: $LOG_PATH"; return 0; }
  done
  echo "The reader server did not start. Log: $LOG_PATH"
  return 1
}

case "$COMMAND" in
  start) start ;;
  stop) stop ;;
  restart) stop && start ;;
  status) describe ;;
esac
