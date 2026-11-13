#!/bin/bash
# Shared by setup/serve.sh and setup/transcript-reader/serve.sh (source it): finding this Mac's
# Tailscale address and name and telling whether a running server listens on it. Defines functions only.

# The tailscale command, on PATH or inside the Mac app.
tailscale_bin() {
  local bin
  bin="$(command -v tailscale || true)"
  [[ -z "$bin" && -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]] && bin=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  [[ -n "$bin" ]] && echo "$bin"
}

# This Mac's Tailscale IPv4 address, when Tailscale is up and gives one in its 100.64.0.0/10 range.
tailnet_ip() {
  local bin ip
  bin="$(tailscale_bin)" || return 1
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

# This machine's name on the tailnet, <machine>.<tailnet>.ts.net, as Tailscale itself reports it (Self.DNSName of
# `tailscale status --json`), never typed in anywhere: renaming the machine in Tailscale changes it.
tailnet_dns_name() {
  local bin name
  bin="$(tailscale_bin)" || return 1
  name="$("$bin" status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String((JSON.parse(s).Self||{}).DNSName||"").replace(/\.$/,""))}catch(e){}})' 2>/dev/null)"
  [[ "$name" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || return 1
  echo "$name"
}
