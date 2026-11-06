#!/bin/bash
# Run Conn. Options go through the CONN_ARGS environment variable (AppKit treats stray argv words as files to open).
#   ./run.sh                      live: observe-only client of Herdr session "esim"
#   ./run.sh --session NAME       another Herdr session
#   ./run.sh --write NAME         allow the compose box to send to that session (default: none)
#   ./run.sh --fixture            a stand-in Herdr with invented agents, invented web pages; safe to screen-share,
#                                 and the one place the compose box is exercised
#   ./run.sh --renderer grid      the cell-grid pane view (SwiftTerm is the default)
#   ./run.sh --text-panes         poll pane text (pane.read) instead of streaming: works across Herdr protocol changes
#   ./run.sh --mode herdr|agent|editor   --web on|off   --select N   --dark   --privacy   --open FILE
#                                 A plain launch opens on the Herdr client view and attaches its client; a scripted launch
#                                 keeps the Agent view and never attaches (see README "Herdr client mode").
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
  DIR=/tmp/conn-fixture-$UID
  mkdir -p "$DIR"
  printf '#!/bin/sh\nexec "%s/build/FakeHerdr" cli "$@"\n' "$PWD" > "$DIR/herdr"
  chmod +x "$DIR/herdr"
  build/FakeHerdr serve --dir "$DIR/s" --session fake --agents 24 >/dev/null 2>&1 &
  FAKE=$!
  trap 'kill $FAKE 2>/dev/null' EXIT
  sleep 0.8
  ARGS="--session fake --socket-dir $DIR/s --herdr-bin $DIR/herdr --write fake $ARGS"
fi
CONN_ARGS="$ARGS" build/Conn.app/Contents/MacOS/Conn
