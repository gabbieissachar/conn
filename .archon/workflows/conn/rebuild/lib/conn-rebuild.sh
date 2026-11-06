#!/bin/bash
# The steps of the conn-rebuild workflow. One subcommand per workflow node:
#   preflight | find-running | build | quit | relaunch
# Run from the helm repository root (the workflow does). Bash 3.2 safe (macOS /bin/bash).
#
# State between nodes lives in $ARTIFACTS_DIR (running.env, built.env). Each subcommand prints one
# short line on stdout (the node output the workflow reads) and explains failures on stderr.
#
# Safety rules, each checked by tests/test-conn-rebuild.sh:
#   - Conn is only ever asked to quit (AppleScript). Nothing here sends a signal or force-kills.
#   - Only the CONN_ARGS variable of the running Conn is read from its environment, never anything else.
#   - Test seam: INPUTS_STUBS_DIR puts stand-in commands (ps, git, osascript, open, sleep, build.sh) first on
#     PATH. It is refused unless it is inside this workflow's fixtures/ directory.
set -euo pipefail

LIB_DIR="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(pwd -P)"
APP="$ROOT/build/Conn.app"
EXE="$APP/Contents/MacOS/Conn"
BUILD_CMD="./build.sh"

die() { echo "conn-rebuild: $*" >&2; exit 1; }

setup() {
  [ -x ./build.sh ] || die "run from the helm repository root (no ./build.sh in $ROOT)"
  : "${ARTIFACTS_DIR:?ARTIFACTS_DIR is not set}"
  mkdir -p "$ARTIFACTS_DIR"
  local stubs="${INPUTS_STUBS_DIR:-}"
  if [ -n "$stubs" ]; then
    local fixtures real
    fixtures="$(cd "$LIB_DIR/../fixtures" && pwd -P)"
    real="$(cd "$stubs" 2>/dev/null && pwd -P)" || { echo "conn-rebuild: stubs_dir does not exist" >&2; exit 2; }
    case "$real/" in
      "$fixtures"/*) ;;
      *) echo "conn-rebuild: stubs_dir must be inside this workflow's fixtures/ directory" >&2; exit 2 ;;
    esac
    PATH="$real:$PATH"
    export PATH
    if [ -x "$real/build.sh" ]; then BUILD_CMD="$real/build.sh"; fi
  fi
}

# PIDs of Conn processes running exactly this checkout's build/Conn.app executable, one per line.
running_pids() {
  ps -axww -o pid=,command= | awk -v exe="$EXE" '{
    pid = $1; sub(/^ *[0-9]+ +/, "")
    if ($0 == exe || index($0, exe " ") == 1) print pid
  }'
}

# Reads the value of CONN_ARGS from the text of `ps eww` for one process. Only that variable is kept.
# Values are space separated in that text, so a value ends where the next NAME=value starts.
conn_args_from() { sed -n 's/.* CONN_ARGS=//p' | sed -E 's/(^| )[A-Za-z_][A-Za-z0-9_]*=.*$//' | sed -E 's/^ +//; s/ +$//'; }

cmd_preflight() {
  local branch dirty sha subject
  branch="$(git rev-parse --abbrev-ref HEAD)"
  [ "$branch" = "main" ] || die "not on main (on '$branch'). Switch the helm checkout to main and run again."
  dirty="$(git status --porcelain --untracked-files=no)"
  if [ -n "$dirty" ]; then
    echo "$dirty" | head -n 10 >&2
    die "tracked files have uncommitted changes (first lines above). Commit or restore them and run again."
  fi
  sha="$(git rev-parse --short HEAD)"
  subject="$(git log -1 --format=%s)"
  echo "$sha $subject"
}

cmd_find_running() {
  local pids n pid argv envtext conn_args conn_args_set args_known desc
  pids="$(running_pids)"
  n=0
  for pid in $pids; do n=$((n + 1)); done
  if [ "$n" -eq 0 ]; then
    printf 'RUNNING=0\n' > "$ARTIFACTS_DIR/running.env"
    echo "not running"
    return 0
  fi
  [ "$n" -eq 1 ] || die "more than one Conn is running from $EXE (pids: $(echo "$pids" | tr '\n' ' ')). Quit the extra ones and run again."
  pid="$pids"
  argv="$(ps -ww -p "$pid" -o command= || true)"
  argv="${argv#"$EXE"}"; argv="${argv# }"
  # Only CONN_ARGS is taken from the environment text. Seeing any ordinary variable proves the
  # environment was readable, which tells "started without CONN_ARGS" from "could not read it".
  envtext="$(ps eww -p "$pid" || true)"
  args_known=0; conn_args_set=0; conn_args=""
  case "$envtext" in
    *" HOME="*|*" PATH="*|*" USER="*) args_known=1 ;;
  esac
  case "$envtext" in
    *" CONN_ARGS="*) conn_args_set=1; conn_args="$(printf '%s\n' "$envtext" | conn_args_from)" ;;
  esac
  {
    printf 'RUNNING=1\nPID=%q\nARGS_KNOWN=%q\nCONN_ARGS_SET=%q\nCONN_ARGS=%q\nARGV=%q\n' \
      "$pid" "$args_known" "$conn_args_set" "$conn_args" "$argv"
  } > "$ARTIFACTS_DIR/running.env"
  if [ "$args_known" -eq 0 ] && [ -z "$argv" ]; then
    desc="how it was started could not be read (it will be relaunched without arguments)"
  elif [ -n "$conn_args" ] && [ -n "$argv" ]; then
    desc="CONN_ARGS=\"$conn_args\" and arguments \"$argv\""
  elif [ -n "$conn_args" ]; then
    desc="CONN_ARGS=\"$conn_args\""
  elif [ -n "$argv" ]; then
    desc="arguments \"$argv\""
  else
    desc="no arguments"
  fi
  echo "running (pid $pid), started with $desc"
}

cmd_build() {
  local before after log mtime
  before="$(git rev-parse --short HEAD)"
  log="$ARTIFACTS_DIR/build.log"
  if ! "$BUILD_CMD" > "$log" 2>&1; then
    tail -n 40 "$log" >&2
    die "build failed (last lines above; full log: $log)"
  fi
  after="$(git rev-parse --short HEAD)"
  [ "$before" = "$after" ] || die "main moved during the build (from $before to $after). Run the workflow again to build the new head."
  [ -x "$EXE" ] || die "the build finished but $EXE is missing"
  mtime="$(stat -f %m "$EXE")"
  printf 'BUILT_SHA=%q\nEXE_MTIME=%q\n' "$after" "$mtime" > "$ARTIFACTS_DIR/built.env"
  echo "$after"
}

cmd_quit() {
  local pids n pid timeout deadline err rc
  timeout="${INPUTS_QUIT_TIMEOUT_SECONDS:-30}"
  case "$timeout" in ''|*[!0-9]*) die "quit_timeout_seconds must be a whole number of seconds (got '$timeout')" ;; esac
  [ "$timeout" -ge 1 ] && [ "$timeout" -le 600 ] || die "quit_timeout_seconds must be between 1 and 600"
  pids="$(running_pids)"
  n=0
  for pid in $pids; do n=$((n + 1)); done
  if [ "$n" -eq 0 ]; then
    echo "not-running"
    return 0
  fi
  [ "$n" -eq 1 ] || die "more than one Conn is running from $EXE (pids: $(echo "$pids" | tr '\n' ' ')). Quit the extra ones and run again."
  pid="$pids"
  # -1712 is "no reply in time", which a quit held up by a dialog gives; the wait below decides that case.
  rc=0
  err="$(osascript -e 'with timeout of 15 seconds' -e "tell application \"$APP\" to quit" -e 'end timeout' 2>&1 >/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    case "$err" in
      *"-1712"*) echo "conn-rebuild: the quit request got no reply in 15 seconds; waiting for Conn to exit" >&2 ;;
      *) die "could not ask Conn to quit: $err" ;;
    esac
  fi
  deadline=$(( $(date +%s) + timeout ))
  while [ -n "$(running_pids)" ]; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      die "Conn (pid $pid) is still running $timeout seconds after the quit request. It may be showing a dialog (for example unsaved editor changes). Nothing was force-killed. Answer the dialog or quit Conn by hand, then resume the run."
    fi
    sleep 1
  done
  echo "quit"
}

cmd_relaunch() {
  local pids n pid launch deadline err rc after
  # The two records below are sourced; RUNNING and ARGS_KNOWN come with them and are not read here.
  # shellcheck disable=SC2034
  local RUNNING=0 ARGS_KNOWN=0 CONN_ARGS_SET=0 CONN_ARGS="" ARGV="" BUILT_SHA="" EXE_MTIME=""
  [ -f "$ARTIFACTS_DIR/built.env" ] || die "no build record in this run (built.env missing)"
  # shellcheck disable=SC1091
  . "$ARTIFACTS_DIR/built.env"
  if [ -f "$ARTIFACTS_DIR/running.env" ]; then
    # shellcheck disable=SC1091
    . "$ARTIFACTS_DIR/running.env"
  fi
  pids="$(running_pids)"
  [ -z "$pids" ] || die "Conn is still running (pid $(echo "$pids" | tr '\n' ' ')); not starting a second copy"
  [ -x "$EXE" ] || die "$EXE is missing"
  set -- open -n
  if [ "$CONN_ARGS_SET" = "1" ] && [ -n "$CONN_ARGS" ]; then set -- "$@" --env "CONN_ARGS=$CONN_ARGS"; fi
  set -- "$@" "$APP"
  if [ -n "$ARGV" ]; then
    # The recorded arguments are split into words on purpose, as Conn splits CONN_ARGS.
    # shellcheck disable=SC2086
    set -- "$@" --args $ARGV
  fi
  launch="$(date +%s)"
  [ "$EXE_MTIME" -le "$launch" ] || die "the build is dated after now; refusing to judge the new process"
  rc=0
  err="$("$@" 2>&1)" || rc=$?
  [ "$rc" -eq 0 ] || die "could not launch Conn: $err"
  deadline=$((launch + 30))
  pid=""
  while :; do
    pids="$(running_pids)"
    n=0
    for after in $pids; do n=$((n + 1)); done
    if [ "$n" -eq 1 ]; then pid="$pids"; break; fi
    [ "$n" -le 1 ] || die "more than one Conn is running after the launch (pids: $(echo "$pids" | tr '\n' ' '))"
    [ "$(date +%s)" -lt "$deadline" ] || die "Conn did not appear within 30 seconds of the launch"
    sleep 1
  done
  # A launch that dies right away would still have shown up once; look again after a short pause.
  sleep 2
  [ "$(running_pids)" = "$pid" ] || die "Conn (pid $pid) exited within seconds of the launch"
  echo "running (pid $pid) from the build of $BUILT_SHA"
}

main() {
  local sub="${1:-}"
  [ -n "$sub" ] || die "usage: conn-rebuild.sh preflight|find-running|build|quit|relaunch"
  setup
  case "$sub" in
    preflight) cmd_preflight ;;
    find-running) cmd_find_running ;;
    build) cmd_build ;;
    quit) cmd_quit ;;
    relaunch) cmd_relaunch ;;
    *) die "unknown step '$sub'" ;;
  esac
}

# Sourced by the tests with CONN_REBUILD_SOURCE_ONLY=1 so single functions can be called.
if [ "${CONN_REBUILD_SOURCE_ONLY:-}" != "1" ]; then main "$@"; fi
