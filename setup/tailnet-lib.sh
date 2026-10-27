#!/bin/bash
# Shared by setup/serve.sh and setup/transcript-reader/serve.sh (source it): finding this Mac's
# Tailscale address and telling whether a running server listens on it. Defines functions only.

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

# The Tailscale address the process <pid> listens on at <port>, if any (read from the process itself).
tailnet_listening() {
  local pid="$1" port="$2"
  [[ -n "$pid" ]] || return 1
  lsof -nP -a -p "$pid" -iTCP:"$port" -sTCP:LISTEN -Fn 2>/dev/null | sed -n "s/^n\(100\.[0-9.]*\):$port\$/\1/p" | head -1 | grep .
}
