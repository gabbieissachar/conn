#!/bin/bash
# The transcript reader's own server: start, stop, restart and status, on its own port.
# It serves only the reader's pages and /api/transcript-reader/* (server.js), apart
# from setup/serve.sh and the pages that one serves.
#
# Usage: bash setup/transcript-reader/serve.sh [start|stop|restart|status|passcode|cert] [--port <port>] [--tailnet] [--tailnet-https] [--https-port <port>]
#   start    start it if it is not running (the default command)
#   stop     stop this copy's server on the port; never another copy's or another app's
#   restart  stop, then start (after changing api.js or server.js)
#   status   say whether the port serves this copy, another copy of the repo, or nothing,
#            and whether it also serves the Tailscale address
#   passcode set the passcode for the Tailscale address: typed twice on the terminal without
#            echo, stored only as a salted hash in out/passcode.json (never an argument)
#   cert     fetch or renew the Tailscale HTTPS certificate for this machine's name (tailscale cert); a
#            running server picks a renewed one up within the hour
# Port: --port, else PMOS_READER_PORT, else 8768. 8765 and 8766 belong to other pages.
# --tailnet (or PMOS_READER_TAILNET=1), on start and restart: also listen on this Mac's Tailscale
#   IPv4 address (tailscale ip -4), same port, so a phone on the tailnet opens it by that address
#   after typing the passcode. Loopback stays as it is. Without Tailscale up or without a passcode
#   it starts loopback only and says why. Never 0.0.0.0 or another interface.
# --tailnet-https (or PMOS_READER_TAILNET_HTTPS=1), on start and restart: also serve HTTPS on that address, on port
#   8443 (--https-port or PMOS_READER_HTTPS_PORT; macOS lets only root bind 443), under this machine's Tailscale
#   name, <machine>.<tailnet>.ts.net, which Tailscale reports (status --json, Self.DNSName) and is never typed in.
#   It implies --tailnet: the plain http address keeps working. The certificate comes from `tailscale cert` and is
#   kept owner-only in out/tailnet-cert/ (PMOS_READER_CERT_DIR). The same passcode gates it. When HTTPS certificates
#   are off for the tailnet, or no certificate can be had, it starts as before and says why in one line.
# The passcode file is PMOS_READER_PASSCODE_FILE, else out/passcode.json.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
PORT="${PMOS_READER_PORT:-8768}"
COMMAND="start"
case "${PMOS_READER_TAILNET:-}" in 1|true|yes|on) TAILNET=1 ;; *) TAILNET=0 ;; esac
PASSCODE_FILE="${PMOS_READER_PASSCODE_FILE:-$HERE/out/passcode.json}"
case "${PMOS_READER_TAILNET_HTTPS:-}" in 1|true|yes|on) HTTPS=1 ;; *) HTTPS=0 ;; esac
HTTPS_PORT="${PMOS_READER_HTTPS_PORT:-8443}"
CERT_DIR="${PMOS_READER_CERT_DIR:-$HERE/out/tailnet-cert}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    start|stop|restart|status|passcode|cert) COMMAND="$1"; shift ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --tailnet) TAILNET=1; shift ;;
    --tailnet-https) TAILNET=1; HTTPS=1; shift ;;
    --https-port) HTTPS_PORT="${2:-}"; shift 2 ;;
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

if [[ ! "$HTTPS_PORT" =~ ^[0-9]{2,5}$ ]] || (( HTTPS_PORT < 1024 || HTTPS_PORT > 65535 )) || [[ "$HTTPS_PORT" == "$PORT" || "$HTTPS_PORT" == "8765" || "$HTTPS_PORT" == "8766" ]]; then
  echo "Invalid HTTPS port: $HTTPS_PORT (1024 to 65535, not the reader's own port or 8765/8766)"
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

# tailnet_ip and tailnet_listening: setup/tailnet-lib.sh, shared with setup/serve.sh.
source "$REPO_ROOT/setup/tailnet-lib.sh"
# The Tailscale address the process on the port listens on, if any.
tailnet_served() { tailnet_listening "$(listener)" "$PORT"; }

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
    local secure name
    if secure="$(tailnet_listening "$pid" "$HTTPS_PORT")" && name="$(tailnet_dns_name)"; then echo "HTTPS address served: https://$name:$HTTPS_PORT (passcode required)."
    elif [[ "$HTTPS" == 1 ]]; then echo "HTTPS address not served. Restart with: bash $0 restart --tailnet-https"; fi
    return 0
  fi
  if [[ -n "$copy" ]]; then echo "Port $PORT serves another copy of the repo ($(where "$pid")), pid $pid."; return 2; fi
  echo "Port $PORT is used by another server (pid $pid), not a transcript reader."
  return 3
}

# Fetches or renews the Tailscale certificate for <name> into $CERT_DIR (owner-only). Prints nothing on success;
# on failure one plain reason, returned as status 1. Never changes anything else in Tailscale.
get_cert() {
  local name="$1" bin out
  bin="$(tailscale_bin)" || { echo "Tailscale is not installed."; return 1; }
  ( umask 077; mkdir -p "$CERT_DIR" ) && chmod 700 "$CERT_DIR"
  if ! out="$( umask 077; "$bin" cert --cert-file "$CERT_DIR/$name.crt" --key-file "$CERT_DIR/$name.key" "$name" 2>&1 )"; then
    case "$out" in
      *[Hh][Tt][Tt][Pp][Ss]*|*[Cc]ert*|*TLS*)
        echo "HTTPS certificates are not turned on for this tailnet (or Tailscale refused one for $name). Turn on HTTPS Certificates in the Tailscale admin console (DNS page), then run: bash $0 restart --tailnet-https" ;;
      *) echo "Could not get a Tailscale certificate: $(printf %s "$out" | tail -1 | cut -c1-160)" ;;
    esac
    return 1
  fi
  chmod 600 "$CERT_DIR/$name.key" "$CERT_DIR/$name.crt" 2>/dev/null
  return 0
}

cert() {
  local name reason
  name="$(tailnet_dns_name)" || { echo "This machine has no Tailscale name (Tailscale is not running, or MagicDNS is off)."; return 1; }
  if ! reason="$(get_cert "$name")"; then echo "$reason"; return 1; fi
  node -e 'const c=new (require("crypto").X509Certificate)(require("fs").readFileSync(process.argv[1]));console.log("Certificate for "+process.argv[2]+" is valid until "+new Date(c.validTo).toISOString().slice(0,10)+". A running reader picks it up within the hour.")' "$CERT_DIR/$name.crt" "$name"
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
  local tailnet_args=() tailnet_note="" ip="" https_note="" https_name=""
  if [[ "$TAILNET" == 1 ]]; then
    if ! ip="$(tailnet_ip)"; then tailnet_note="Tailnet address not served: Tailscale is not running or gave no IPv4 address."
    elif [[ ! -s "$PASSCODE_FILE" ]]; then tailnet_note="Tailnet address not served: no passcode is set. Set one with: bash $0 passcode"
    else tailnet_args=(--tailnet-ip "$ip" --passcode-file "$PASSCODE_FILE"); fi
  fi
  # HTTPS beside it: the machine's name and certificate from Tailscale, or one line saying why not.
  if [[ "$HTTPS" == 1 && ${#tailnet_args[@]} -gt 0 ]]; then
    if ! https_name="$(tailnet_dns_name)"; then https_note="HTTPS address not served: this machine has no Tailscale name (MagicDNS is off)."
    elif https_note="$(get_cert "$https_name")"; then
      https_note=""
      tailnet_args+=(--https-host "$https_name" --https-port "$HTTPS_PORT" --cert-file "$CERT_DIR/$https_name.crt" --key-file "$CERT_DIR/$https_name.key")
    else https_note="HTTPS address not served: $https_note"; fi
  elif [[ "$HTTPS" == 1 ]]; then https_note="HTTPS address not served: it needs the tailnet address first (see above)."; fi
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
        if [[ -n "$https_name" && -z "$https_note" ]]; then
          for _ in 1 2 3 4 5 6 7 8 9 10; do tailnet_listening "$(listener)" "$HTTPS_PORT" >/dev/null && break; sleep 0.3; done
          if tailnet_listening "$(listener)" "$HTTPS_PORT" >/dev/null; then echo "HTTPS address served: https://$https_name:$HTTPS_PORT (passcode required)"
          else https_note="HTTPS address not served: $(grep 'Tailnet HTTPS: not served' "$LOG_PATH" | tail -1 | sed 's/.*not served, //')"; fi
        fi
      elif [[ -n "$tailnet_note" ]]; then echo "$tailnet_note"; fi
      [[ -n "$https_note" ]] && echo "$https_note"
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
  cert) cert ;;
  start) start ;;
  stop) stop ;;
  restart) stop && start ;;
  status) describe ;;
esac
