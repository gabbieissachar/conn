#!/bin/bash
# Tests for the conn-rebuild workflow: the step script against the stand-in commands, and static checks
# on the workflow file. Nothing here starts, quits or opens an app, and nothing reads a real process.
#   bash .archon/workflows/conn/rebuild/tests/test-conn-rebuild.sh
# Scratch directories go under $TMPDIR and are left for the system to clean up.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
WF="$HERE/.."
LIB="$WF/lib/conn-rebuild.sh"
STUBS="$WF/fixtures/stub-bin"
YAML="$WF/conn-rebuild.yaml"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/conn-rebuild-tests.XXXXXX")"
PASS=0
FAIL=0
N=0

check() { # description, then a command whose success means pass
  local desc="$1"; shift
  if "$@"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: $desc"; fi
}
has() { case "$1" in *"$2"*) return 0 ;; esac; return 1; }
lacks() { case "$1" in *"$2"*) return 1 ;; esac; return 0; }

newcase() { # a fresh fake repo root and artifacts directory
  N=$((N + 1))
  mkdir -p "$SCRATCH/case$N/repo" "$SCRATCH/case$N/art"
  ROOT_T="$(cd "$SCRATCH/case$N/repo" && pwd -P)"; ART="$(cd "$SCRATCH/case$N/art" && pwd -P)"
  printf '#!/bin/sh\nexit 0\n' > "$ROOT_T/build.sh"; chmod +x "$ROOT_T/build.sh"
}
run() { # scenario step [VAR=value ...]  ->  OUT ERR RC
  local scenario="$1" step="$2"; shift 2
  RC=0
  OUT="$(cd "$ROOT_T" && env ARTIFACTS_DIR="$ART" INPUTS_STUBS_DIR="$STUBS" INPUTS_STUB_SCENARIO="$scenario" "$@" bash "$LIB" "$step" 2> "$SCRATCH/err")" || RC=$?
  ERR="$(cat "$SCRATCH/err")"
}
state() { cat "$ART/stub-state/$1" 2>/dev/null || true; }
APP_T() { echo "$ROOT_T/build/Conn.app"; }

# ---- preflight --------------------------------------------------------------------------------------------
newcase; run running preflight
check "preflight prints the head commit" test "$RC" = 0 -a "$OUT" = "abc1234 Stub commit subject"
newcase; run dirty preflight
check "preflight refuses a dirty tree" test "$RC" = 1
check "dirty message names the cause" has "$ERR" "uncommitted changes"
newcase; run wrong-branch preflight
check "preflight refuses another branch" test "$RC" = 1
check "branch message names the branch" has "$ERR" "feature/x"

# ---- find-running -----------------------------------------------------------------------------------------
newcase; run running find-running
check "running, no arguments" test "$RC" = 0 -a "$OUT" = "running (pid 4242), started with no arguments"
check "env file says args are known and CONN_ARGS unset" grep -q '^ARGS_KNOWN=1$' "$ART/running.env"
check "env file: CONN_ARGS_SET=0" grep -q '^CONN_ARGS_SET=0$' "$ART/running.env"
check "no other variable of the process is stored" bash -c "! grep -rq 'do-not-keep\|SECRET_STUB_TOKEN\|/Users/stub' '$ART'"
check "no other variable is printed" lacks "$OUT$ERR" "SECRET_STUB_TOKEN"
newcase; run running-args find-running
check "CONN_ARGS is recorded and printed" test "$OUT" = 'running (pid 4242), started with CONN_ARGS="--session fake --write fake"'
check "CONN_ARGS stops at the next variable" grep -q '^CONN_ARGS=--session\\ fake\\ --write\\ fake$' "$ART/running.env"
check "no other variable is stored (args case)" bash -c "! grep -rq 'do-not-keep\|SECRET_STUB_TOKEN\|/Users/stub\|/usr/bin' '$ART'"
newcase; run running-argv find-running
check "argv is recorded" test "$OUT" = 'running (pid 4242), started with arguments "--dark"'
newcase; run env-hidden find-running
check "unreadable environment is said plainly" has "$OUT" "could not be read"
check "unreadable environment is recorded as unknown" grep -q '^ARGS_KNOWN=0$' "$ART/running.env"
newcase; run not-running find-running
check "not running is said plainly" test "$RC" = 0 -a "$OUT" = "not running"
newcase; run two-running find-running
check "two Conn processes stop the run" test "$RC" = 1
check "two Conn processes message" has "$ERR" "more than one Conn"

# ---- build ------------------------------------------------------------------------------------------------
newcase; run running build
check "build prints the built commit" test "$RC" = 0 -a "$OUT" = "abc1234"
check "build record has the commit" grep -q '^BUILT_SHA=abc1234$' "$ART/built.env"
check "build produced the executable" test -x "$(APP_T)/Contents/MacOS/Conn"
newcase; run build-fails build
check "failed build stops" test "$RC" = 1
check "failed build shows the last lines" has "$ERR" "stub build line 60"
check "failed build shows only the last lines" lacks "$ERR" "stub build line 10"
newcase; run head-moves preflight; run head-moves build
check "a head that moves during the build stops the run" test "$RC" = 1
check "head-moves message" has "$ERR" "main moved during the build"

# ---- quit -------------------------------------------------------------------------------------------------
newcase; run running find-running; run running build; run running quit
check "quit prints quit" test "$RC" = 0 -a "$OUT" = "quit"
check "quit asks the app at this path to quit" has "$(state osascript.args)" "tell application \"$(APP_T)\" to quit"
newcase; run not-running find-running; run not-running quit
check "quit with nothing running says so and asks nothing" test "$RC" = 0 -a "$OUT" = "not-running" -a ! -e "$ART/stub-state/osascript.args"
newcase; run quit-stuck find-running; run quit-stuck build; run quit-stuck quit INPUTS_QUIT_TIMEOUT_SECONDS=2
check "a Conn that does not exit stops the run" test "$RC" = 1
check "stuck message says nothing was force-killed" has "$ERR" "Nothing was force-killed"
check "stuck message names the possible dialog" has "$ERR" "dialog"
newcase; run running quit INPUTS_QUIT_TIMEOUT_SECONDS=abc
check "a bad timeout is refused" test "$RC" = 1
newcase; run running quit INPUTS_QUIT_TIMEOUT_SECONDS=0
check "a zero timeout is refused" test "$RC" = 1

# ---- relaunch ---------------------------------------------------------------------------------------------
launch_flow() { # scenario
  newcase; run "$1" find-running; run "$1" build; run "$1" quit; run "$1" relaunch
}
launch_flow running
check "relaunch confirms the new process and the build" test "$RC" = 0 -a "$OUT" = "running (pid 4343) from the build of abc1234"
check "relaunch opens a new instance of this app, with no arguments" test "$(state open.args)" = "$(printf -- '-n\n%s' "$(APP_T)")"
launch_flow running-args
check "relaunch passes the same CONN_ARGS" test "$(state open.args)" = "$(printf -- '-n\n--env\nCONN_ARGS=--session fake --write fake\n%s' "$(APP_T)")"
launch_flow running-argv
check "relaunch passes the same arguments" test "$(state open.args)" = "$(printf -- '-n\n%s\n--args\n--dark' "$(APP_T)")"
launch_flow env-hidden
check "relaunch with unknown arguments starts with none" test "$(state open.args)" = "$(printf -- '-n\n%s' "$(APP_T)")"
launch_flow not-running
check "relaunch works when Conn was not running" test "$RC" = 0 -a "$OUT" = "running (pid 4343) from the build of abc1234"
newcase; run running find-running; run running build; run running relaunch
check "relaunch refuses while the old Conn still runs" test "$RC" = 1
check "and launches nothing" test ! -e "$ART/stub-state/open.args"
newcase; run running relaunch
check "relaunch needs a build record" test "$RC" = 1

# ---- the test seam is fenced ------------------------------------------------------------------------------
newcase
RC=0; ( cd "$ROOT_T" && env ARTIFACTS_DIR="$ART" INPUTS_STUBS_DIR="$SCRATCH" bash "$LIB" preflight ) >/dev/null 2>&1 || RC=$?
check "a stubs_dir outside fixtures/ is refused" test "$RC" = 2
RC=0; ( cd "$ROOT_T" && env ARTIFACTS_DIR="$ART" INPUTS_STUBS_DIR="$STUBS/../../" bash "$LIB" preflight ) >/dev/null 2>&1 || RC=$?
check "a stubs_dir that only starts with the fixtures path is refused" test "$RC" = 2

# ---- CONN_ARGS parsing ------------------------------------------------------------------------------------
# shellcheck disable=SC1090
CONN_REBUILD_SOURCE_ONLY=1 . "$LIB"
parse() { printf '%s\n' "$1" | conn_args_from; }
check "parse: value then next variable" test "$(parse '4 ?? S 0:01 /x/Conn HOME=/h CONN_ARGS=--a b --c d PATH=/p')" = "--a b --c d"
check "parse: value is last" test "$(parse '4 ?? S 0:01 /x/Conn HOME=/h CONN_ARGS=--dark')" = "--dark"
check "parse: empty value" test -z "$(parse '4 ?? S 0:01 /x/Conn HOME=/h CONN_ARGS= PATH=/p')"
check "parse: empty value at the end" test -z "$(parse '4 ?? S 0:01 /x/Conn HOME=/h CONN_ARGS=')"
check "parse: an option with an equals sign is kept" test "$(parse '4 ?? S 0:01 /x/Conn CONN_ARGS=--select=3 --dark HOME=/h')" = "--select=3 --dark"
check "parse: absent" test -z "$(parse '4 ?? S 0:01 /x/Conn HOME=/h')"

# ---- static checks on the workflow files ------------------------------------------------------------------
code() { grep -v '^[[:space:]]*#' "$1"; }
check "no kill, pkill or killall anywhere in the step script" bash -c "! grep -v '^[[:space:]]*#' '$LIB' | grep -Eq '(^|[^a-z-])(kill|pkill|killall)([[:space:]]|\$)'"
check "no kill in the workflow nodes" bash -c "! grep -v '^[[:space:]]*#' '$YAML' | grep -Eq '(^|[^a-z-])(kill|pkill|killall)([[:space:]]|\$)'"
check "no rm, git push or curl in the workflow files" bash -c "! cat '$YAML' '$LIB' | grep -v '^[[:space:]]*#' | grep -Eq '(^|[[:space:]])(rm|curl|wget)[[:space:]]|git push'"
check "no AI node (prompt, command, loop or script keys)" bash -c "! grep -Eq '^    (prompt|command|loop|script|approval):' '$YAML'"
check "exactly one human gate" test "$(grep -c '^    wait:' "$YAML")" = 1
check "quit only runs on approve" grep -q "when: \"\$decision.output == 'approve'\"" "$YAML"
check "relaunch only runs after a quit step finished" grep -q "when: \"\$quit.output == 'quit' || \$quit.output == 'not-running'\"" "$YAML"
chain="$(grep -E '^  - id:|^    depends_on:' "$YAML" | sed -E 's/^  - id: //; s/^    depends_on: /<- /' | tr '\n' ' ')"
check "the node chain is in order" test "$chain" = "preflight find-running <- [preflight] build <- [find-running] confirm-restart <- [build] decision <- [confirm-restart] quit <- [decision] relaunch <- [quit] "
check "the quit goes through AppleScript" grep -q "osascript" "$LIB"
check "the launch goes through open" grep -q 'set -- open -n' "$LIB"

echo "conn-rebuild tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
