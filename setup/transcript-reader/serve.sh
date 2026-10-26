#!/bin/bash
# The transcript reader's own server: start, stop, restart and status, on its own port.
# It serves only the reader's pages and /api/transcript-reader/* (server.js), apart
# from setup/serve.sh and the pages that one serves.
#
# Usage: bash setup/transcript-reader/serve.sh [start|stop|restart|status|passcode] [--port <port>] [--tailnet]
#   start    start it if it is not running (the default command)
#   stop     stop this copy's server on the port; never another copy's or another app's
#   restart  stop, then start (after changing api.js or server.js)
#   status   say whether the port serves this copy, another copy of the repo, or nothing,
#            and whether it also serves the Tailscale address
#   passcode set the passcode for the Tailscale address: typed twice on the terminal without
#            echo, stored only as a salted hash in out/passcode.json (never an argument)
# Port: --port, else PMOS_READER_PORT, else 8768. 8765 and 8766 belong to other pages.
# --tailnet (or PMOS_READER_TAILNET=1), on start and restart: also listen on this Mac's Tailscale
#   IPv4 address (tailscale ip -4), same port, so a phone on the tailnet opens it by that address
#   after typing the passcode. Loopback stays as it is. Without Tailscale up or without a passcode
#   it starts loopback only and says why. Never 0.0.0.0 or another interface.
# The passcode file is PMOS_READER_PASSCODE_FILE, else out/passcode.json.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
PORT="${PMOS_READER_PORT:-8768}"
COMMAND="start"
case "${PMOS_READER_TAILNET:-}" in 1|true|yes|on) TAILNET=1 ;; *) TAILNET=0 ;; esac
PASSCODE_FILE="${PMOS_READER_PASSCODE_FILE:-$HERE/out/passcode.json}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    start|stop|restart|status|passcode) COMMAND="$1"; shift ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --tailnet) TAILNET=1; shift ;;
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

# This Mac's Tailscale IPv4 address, when Tailscale is up and gives one in its 100.64.0.0/10 range.
tailnet_ip() {
  local bin ip
  bin="$(command -v tailscale || true)"
  [[ -z "$bin" && -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]] && bin=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  [[ -z "$bin" ]] && return 1
  ip="$("$bin" ip -4 2>/dev/null | head -1)"
  [[ "$ip" =~ ^100\.([0-9]{1,3})\.[0-9]{1,3}\.[0-9]{1,3}$ ]] && (( BASH_REMATCH[1] >= 64 && BASH_REMATCH[1] <= 127 )) || return 1
  echo "$ip"
}
# The Tailscale address the process on the port listens on, if any (read from the process itself).
tailnet_served() {
  local pid
  pid="$(listener)"
  [[ -n "$pid" ]] || return 1
  lsof -nP -a -p "$pid" -iTCP:"$PORT" -sTCP:LISTEN -Fn 2>/dev/null | sed -n "s/^n\(100\.[0-9.]*\):$PORT\$/\1/p" | head -1 | grep .
}

describe() {
  local pid copy
  pid="$(listener)"
  if [[ -z "$pid" ]]; then echo "Nothing listens on port $PORT."; return 1; fi
  copy="$(served_copy)"
  if [[ "$copy" == "$COPY" ]]; then
    echo "Port $PORT serves this copy of the repo ($REPO_ROOT), pid $pid."
    local served
    if served="$(tailnet_served)"; then echo "Tailnet address served: http://$served:$PORT (passcode required)."
    else echo "Tailnet address not served (loopback only)."; fi
    return 0
  fi
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
    0) echo "Reader server already running on port $PORT: http://localhost:$PORT"
       if [[ "$TAILNET" == 1 ]] && ! tailnet_served >/dev/null; then echo "It is not serving the tailnet address. To add it: bash $0 restart --tailnet"; fi
       return 0 ;;
    2|3) describe; echo "Pick another port with --port or PMOS_READER_PORT."; return 1 ;;
  esac
  if ! command -v node &>/dev/null; then echo "Node.js not found. Run: bash setup/check.sh"; return 1; fi
  # out/ holds private transcript text, so it and the server's log are the owner's alone, like Claude's logs.
  mkdir -p "$HERE/out" && chmod 700 "$HERE/out"
  [[ -f "$LOG_PATH" ]] && chmod 600 "$LOG_PATH"
  # The tailnet address is opt-in, and needs Tailscale up and a passcode set: otherwise loopback only, with the reason.
  local tailnet_args=() tailnet_note="" ip=""
  if [[ "$TAILNET" == 1 ]]; then
    if ! ip="$(tailnet_ip)"; then tailnet_note="Tailnet address not served: Tailscale is not running or gave no IPv4 address."
    elif [[ ! -s "$PASSCODE_FILE" ]]; then tailnet_note="Tailnet address not served: no passcode is set. Set one with: bash $0 passcode"
    else tailnet_args=(--tailnet-ip "$ip" --passcode-file "$PASSCODE_FILE"); fi
  fi
  # node alone goes to the background (not a "cd && node" list, whose subshell would keep this script's output open).
  ( cd "$REPO_ROOT" || exit 1; umask 077; nohup node "$HERE/server.js" --port "$PORT" --root "$REPO_ROOT" ${tailnet_args[@]+"${tailnet_args[@]}"} >> "$LOG_PATH" 2>&1 < /dev/null & )
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.3
    if [[ "$(served_copy)" == "$COPY" ]]; then
      echo "Reader server started: http://localhost:$PORT"
      if [[ ${#tailnet_args[@]} -gt 0 ]]; then
        for _ in 1 2 3 4 5 6 7 8 9 10; do tailnet_served >/dev/null && break; sleep 0.3; done
        if tailnet_served >/dev/null; then echo "Tailnet address served: http://$ip:$PORT (passcode required)"
        else echo "Tailnet address not served: $ip:$PORT could not be bound. See the log."; fi
      elif [[ -n "$tailnet_note" ]]; then echo "$tailnet_note"; fi
      echo "Log: $LOG_PATH"
      return 0
    fi
  done
  echo "The reader server did not start. Log: $LOG_PATH"
  return 1
}

passcode() {
  if ! command -v node &>/dev/null; then echo "Node.js not found. Run: bash setup/check.sh"; return 1; fi
  mkdir -p "$(dirname "$PASSCODE_FILE")" && chmod 700 "$HERE/out" 2>/dev/null
  ( umask 077; node "$HERE/passcode.js" "$PASSCODE_FILE" ) || return $?
  echo "Devices signed in under an earlier passcode are signed out. If the phone address is not served yet: bash $0 restart --tailnet"
}

case "$COMMAND" in
  passcode) passcode ;;
  start) start ;;
  stop) stop ;;
  restart) stop && start ;;
  status) describe ;;
esac
