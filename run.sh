#!/bin/bash
# Run Conn. Options go through the CONN_ARGS environment variable (AppKit treats stray argv words as files to open).
#   ./run.sh                      live: observe-only client of Herdr session "esim"
#   ./run.sh --session NAME       another Herdr session
#   ./run.sh --write NAME         allow the compose box to send to that session (default: none)
#   ./run.sh --fixture            a stand-in Herdr with invented agents, invented web pages; safe to screen-share,
#                                 and the one place the compose box is exercised
#                                 It also starts a stand-in Campus (invented conversations, a sign-in page that sets a cookie, an event stream) and points the
#                                 CAMPUS section at it; add --no-campus to leave Campus out. A plain launch reads the real Campus (sign in inside Conn).
#   ./run.sh --campus-url ADDRESS use another Campus (default https://campus.shopback.com); --no-campus leaves the section out; a scripted launch
#                                 (--ui-check and the like) never reaches the real Campus unless --campus is given
#   CONN_EMBED_URL=ADDRESS ./run.sh ...   the reader's embed page that draws Campus conversations (default: the live reader's; a --fixture launch has none, so it keeps the native transcript;
#                                 a file copy of embed.html is what the --campus-check embed steps use)
#   ./run.sh --campus-writes      start with the "Campus writes" switch on (a person's own launch starts with it off)
#   ./run.sh --fixture --campus-signed-out-403   the stand-in Campus answers 403 (what the real one answers) instead of 401 to a person who is not signed in
#   ./run.sh --renderer grid      the cell-grid pane view (SwiftTerm is the default)
#   ./run.sh --text-panes         poll pane text (pane.read) instead of streaming: works across Herdr protocol changes
#   ./run.sh --mode herdr|agent|editor   --web on|off   --select N   --dark   --privacy   --open FILE
#                                 A plain launch opens on the Herdr client view and attaches its client; a scripted launch
#                                 opens on it too and never attaches (see README "Herdr client mode").
#   ./run.sh --agent-view         turn the Agent view on (off by default; --no-agent-view forces it off; also CONN_AGENT_VIEW=1 or
#                                 `defaults write dev.local.conn conn.agentView -bool YES`; see README "The Agent view flag")
#   ./run.sh --client-config FILE  the Herdr client view starts its client with this config (default: a generated copy of your
#                                 Herdr config with Herdr's sidebar hidden; FILE must be in Conn's folder or a temp folder)
#   ./run.sh --selftest 10 | --shot FILE | --tour DIR | --quit-after N
#   ./run.sh --background ...     test mode: no focus, no Dock icon or menu-bar item, invisible click-through windows.
#                                 Every scripted launch (--ui-check, --shot, --tour, --selftest, --quit-after, ...) implies it;
#                                 --foreground (or CONN_FOREGROUND=1) opts out.
cd "$(dirname "$0")"
[ -d build/Conn.app ] || ./build.sh
ARGS="$*"
if [[ " $ARGS " == *" --fixture "* ]]; then
  # Short path: a Unix socket path is limited to 104 bytes.
  # One folder per checkout, so two checkouts running --fixture at once do not share (and delete) each other's sockets.
  DIR=/tmp/conn-fixture-$UID-$(printf %s "$PWD" | cksum | cut -d" " -f1)
  mkdir -p "$DIR"
  printf '#!/bin/sh\nexec "%s/build/FakeHerdr" cli "$@"\n' "$PWD" > "$DIR/herdr"
  chmod +x "$DIR/herdr"
  build/FakeHerdr serve --dir "$DIR/s" --session fake --agents 24 >/dev/null 2>&1 &
  FAKE=$!
  trap 'kill $FAKE 2>/dev/null' EXIT
  sleep 0.8
  ARGS="--session fake --socket-dir $DIR/s --herdr-bin $DIR/herdr --write fake $ARGS"
  if [[ " $ARGS " != *" --no-campus "* && " $ARGS " != *" --campus-url "* && -x build/FakeCampus ]]; then
    FAKEC_ARGS=(--autorun)
    [[ " $ARGS " == *" --campus-signed-out-403 "* ]] && FAKEC_ARGS+=(--signed-out-403)
    build/FakeCampus serve "${FAKEC_ARGS[@]}" >"$DIR/campus.log" 2>&1 &
    FAKEC=$!
    trap 'kill $FAKE $FAKEC 2>/dev/null' EXIT
    for _ in $(seq 1 50); do grep -q "listening" "$DIR/campus.log" 2>/dev/null && break; sleep 0.1; done
    CPORT=$(sed -n 's/.*127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p' "$DIR/campus.log" | head -1)
    [ -n "$CPORT" ] && ARGS="$ARGS --campus-url http://127.0.0.1:$CPORT"
  fi
fi
CONN_ARGS="$ARGS" build/Conn.app/Contents/MacOS/Conn
