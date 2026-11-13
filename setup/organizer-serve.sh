#!/bin/bash
# Conn's local Herdr organizer server.
#
# This is a small, organizer-only server derived from pmos setup/serve.sh at
# commit 992863cddd3f7c585187a8360c83337b7e28963f. The pmos server stays on
# port 8765 for its other apps; this server owns port 8767 by default.
# Usage: bash setup/organizer-serve.sh [status] [--port <port>] [--restart] [--tailnet]

set -euo pipefail

HERE="$(dirname "${BASH_SOURCE[0]}")"
REPO_ROOT="$(git -C "$HERE/.." rev-parse --show-toplevel 2>/dev/null || printf '%s\n' "$HERE/..")"
PORT="${CONN_ORGANIZER_PORT:-8767}"
RESTART=0
COMMAND="start"
case "${CONN_ORGANIZER_TAILNET:-}" in 1|true|yes|on) TAILNET=1 ;; *) TAILNET=0 ;; esac
PASSCODE_FILE="${PMOS_READER_PASSCODE_FILE:-$REPO_ROOT/setup/transcript-reader/out/passcode.json}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    status)
      COMMAND="status"
      shift
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --restart)
      RESTART=1
      shift
      ;;
    --tailnet)
      TAILNET=1
      shift
      ;;
    --no-tailnet)
      TAILNET=0
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! "$PORT" =~ ^[0-9]{2,5}$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "Invalid port: $PORT" >&2
  exit 2
fi

LOG_PATH="${CONN_ORGANIZER_LOG:-/tmp/conn-organizer-serve-$PORT.log}"

is_organizer_server() {
  curl --max-time 2 -fsS -D - -o /dev/null "http://localhost:$PORT/api/conn-organizer-health" 2>/dev/null \
    | tr -d '\r' | grep -qi '^X-Conn-Organizer-Serve: 1$'
}

source "$HERE/tailnet-lib.sh"
tailnet_served() {
  tailnet_listening "$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)" "$PORT"
}

if [[ "$COMMAND" == "status" ]]; then
  if ! lsof -iTCP:"$PORT" -sTCP:LISTEN &>/dev/null; then
    echo "Nothing listens on port $PORT."
    exit 1
  fi
  if ! is_organizer_server; then
    echo "Port $PORT is used by a different server."
    exit 1
  fi
  echo "The Conn Herdr organizer server runs on port $PORT (http://localhost:$PORT)."
  if SERVED="$(tailnet_served)"; then
    echo "Tailnet address served: http://$SERVED:$PORT/apps/wip-herdr-workspace-organizer.html (the organizer page only, passcode required)."
  else
    echo "Tailnet address not served (loopback only)."
  fi
  exit 0
fi

if lsof -iTCP:"$PORT" -sTCP:LISTEN &>/dev/null; then
  if ! is_organizer_server; then
    echo "Port $PORT is occupied by a different server. Choose another port with --port <port>." >&2
    exit 1
  fi
  if [[ "$RESTART" == "1" ]]; then
    PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$PIDS" ]]; then
      echo "Restarting organizer server on port $PORT (killing pid(s): $PIDS)"
      # shellcheck disable=SC2086
      kill $PIDS 2>/dev/null || true
      sleep 0.2
    fi
  else
    echo "Organizer server already running on port $PORT"
    echo "Tip: run 'bash setup/organizer-serve.sh --restart' if you changed server code."
    exit 0
  fi
fi

if ! command -v node &>/dev/null; then
  echo "Node.js not found." >&2
  exit 1
fi

TAILNET_IP=""
TAILNET_NOTE=""
if [[ "$TAILNET" == "1" ]]; then
  if ! TAILNET_IP="$(tailnet_ip)"; then
    TAILNET_NOTE="Tailnet address not served: Tailscale is not running or gave no IPv4 address."
  elif [[ ! -s "$PASSCODE_FILE" ]]; then
    TAILNET_IP=""
    TAILNET_NOTE="Tailnet address not served: no passcode is set. Set one with: bash setup/transcript-reader/serve.sh passcode"
  fi
fi

PMOS_SERVE_TAILNET_IP="$TAILNET_IP" PMOS_READER_PASSCODE_FILE="$PASSCODE_FILE" \
  nohup node - "$REPO_ROOT" "$PORT" >"$LOG_PATH" 2>&1 <<'NODE' &
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const root = path.resolve(process.argv[2]);
const port = Number(process.argv[3]);
const pagePath = '/apps/wip-herdr-workspace-organizer.html';
const snapshotPath = '/api/herdr-workspace-organizer/snapshot';
const healthPath = '/api/conn-organizer-health';
const phone = require(path.join(root, 'setup', 'herdr-organizer', 'phone.js'));
const apiModule = require(path.join(root, 'setup', 'herdr-organizer', 'api.js'));
const { refreshSnapshot } = require(path.join(root, 'setup', 'herdr-organizer', 'snapshot-refresh.js'));

let tailnet = null;
try { tailnet = phone.tailnetFromEnv(process.env, root); }
catch (error) { process.stdout.write(`Tailnet: not served, ${error.message}\n`); }

const api = apiModule.create({ root, port, ...(tailnet ? { tailnet } : {}) });

function plain(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function json(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(JSON.stringify(body));
}

function servePage(res) {
  fs.readFile(path.join(root, 'apps', 'wip-herdr-workspace-organizer.html'), (error, data) => {
    if (error) { plain(res, 404, 'Not found'); return; }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'none'",
    });
    res.end(data);
  });
}

function onRequest(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { plain(res, 400, 'Bad request'); return; }

  if (api.handle(req, res)) return;
  if (url.pathname === healthPath && req.method === 'GET') {
    json(res, 200, { status: 'ok' }, { 'X-Conn-Organizer-Serve': '1' });
    return;
  }
  if (url.pathname === pagePath) {
    if (req.method !== 'GET') { plain(res, 405, 'GET required'); return; }
    servePage(res);
    return;
  }
  if (url.pathname === snapshotPath) {
    if (req.method !== 'POST') { plain(res, 405, 'POST required'); return; }
    refreshSnapshot(root).then(({ status, body }) => json(res, status, body));
    return;
  }
  plain(res, 404, 'Not found');
}

http.createServer(onRequest).listen(port, '127.0.0.1');
const loopbackV6 = http.createServer(onRequest);
loopbackV6.on('error', () => {});
loopbackV6.listen(port, '::1');

if (tailnet) {
  phone.listen({ root, api, tailnet, port }).then((result) => {
    if (result.error) process.stdout.write(`Tailnet: not served, ${result.error}\n`);
    else process.stdout.write(`Tailnet: also serving http://${result.ip}:${result.port} (the organizer page only, passcode required)\n`);
  });
}
NODE

sleep 1
if lsof -tiTCP:"$PORT" -sTCP:LISTEN &>/dev/null && is_organizer_server; then
  echo "Organizer server started at http://localhost:$PORT"
  if [[ -n "$TAILNET_IP" ]]; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do tailnet_served >/dev/null && break; sleep 0.3; done
    if tailnet_served >/dev/null; then
      echo "Tailnet address served: http://$TAILNET_IP:$PORT/apps/wip-herdr-workspace-organizer.html (the organizer page only, passcode required)"
    else
      echo "Tailnet address not served: $TAILNET_IP:$PORT could not be bound or has no valid passcode. See the log."
    fi
  elif [[ -n "$TAILNET_NOTE" ]]; then
    echo "$TAILNET_NOTE"
  fi
  echo "Logs: $LOG_PATH"
else
  echo "Organizer server failed to start. Check that Node.js is working: node --version" >&2
  echo "Logs (if any): $LOG_PATH" >&2
  exit 1
fi
