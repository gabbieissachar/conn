# pmOS herdr agent session shortcuts.
#
# Source after setup/codex-shortcuts.zsh so codex-r can auto-register the
# current herdr pane when a resume session id is known.

_pmos_repo="${PMOS_REPO:-${PMOS_ROOT:-/Users/nguyen.tran/workspace/pmos}}"
export PMOS_REPO="${PMOS_REPO:-$_pmos_repo}"
_pmos_herdr_agent_root="$_pmos_repo/personal/01-System/setup/herdr"
_pmos_herdr_agent_registry="$_pmos_herdr_agent_root/agent-session-registry.py"
_pmos_herdr_agent_restore="$_pmos_herdr_agent_root/agent-session-restore.py"
_pmos_herdr_workspace_organizer="$_pmos_herdr_agent_root/workspace-organizer.py"
_pmos_claude_real_bin="${PMOS_CLAUDE_REAL_BIN:-$(whence -p claude 2>/dev/null)}"

herdr-agent-register() {
  if (( $# < 2 )); then
    echo "usage: herdr-agent-register <codex|claude> <session_id> [registry args...]" >&2
    return 2
  fi

  local client="$1"
  local session_id="$2"
  shift 2
  python3 "$_pmos_herdr_agent_registry" register --client "$client" --session-id "$session_id" "$@"
}

herdr-agent-list() {
  python3 "$_pmos_herdr_agent_registry" list "$@"
}

herdr-agent-manifest() {
  python3 "$_pmos_herdr_agent_registry" path "$@"
}

herdr-agent-remove() {
  python3 "$_pmos_herdr_agent_registry" remove "$@"
}

herdr-agent-capture-missing() {
  python3 "$_pmos_herdr_agent_registry" capture-missing "$@"
}

herdr-agent-scan() {
  python3 "$_pmos_herdr_agent_registry" scan "$@"
}

herdr-agent-capture-history() {
  python3 "$_pmos_herdr_agent_registry" scan "$@"
}

herdr-agent-capture-status() {
  python3 "$_pmos_herdr_agent_registry" scan --status "$@"
}

herdr-agent-autoregister() {
  python3 "$_pmos_herdr_agent_registry" scan --execute "$@"
}

herdr-agent-apply-missing() {
  python3 "$_pmos_herdr_agent_registry" apply-missing --execute "$@"
}

herdr-agent-restore() {
  python3 "$_pmos_herdr_agent_restore" "$@"
}

herdr-agent-recover() {
  herdr-agent-capture-history --execute
  herdr-agent-capture-status --execute
  herdr-agent-restore --execute --all
}

herdr-organizer() {
  python3 "$_pmos_herdr_workspace_organizer" "$@"
}

herdr-organizer-ui() {
  herdr-organizer snapshot "$@" && open "http://localhost:8765/apps/wip-herdr-workspace-organizer.html"
}

claude-real-bin() {
  print -r -- "${PMOS_CLAUDE_REAL_BIN:-$_pmos_claude_real_bin}"
}

claudew() {
  local claude_bin="${PMOS_CLAUDE_REAL_BIN:-$_pmos_claude_real_bin}"
  if [[ -z "$claude_bin" ]]; then
    echo "claude not found on PATH" >&2
    return 127
  fi

  local session_id=""
  local args=("$@")
  local index=1
  while (( index <= ${#args[@]} )); do
    local arg="${args[$index]}"
    case "$arg" in
      -r|--resume|--session-id)
        if (( index + 1 <= ${#args[@]} )); then
          session_id="${args[$((index + 1))]}"
        fi
        index=$((index + 2))
        continue
        ;;
      --resume=*|--session-id=*)
        session_id="${arg#*=}"
        ;;
    esac
    index=$((index + 1))
  done

  if [[ -n "$session_id" && -n "${HERDR_SESSION:-}" ]]; then
    python3 "$_pmos_herdr_agent_registry" register --client claude --session-id "$session_id" >/dev/null 2>&1 || true
  fi

  "$claude_bin" "$@"
}

claude-r() {
  local session_id="${1:-}"
  if [[ -z "$session_id" ]]; then
    echo "usage: claude-r <session_id> [claude args...]" >&2
    return 2
  fi

  shift
  if [[ -n "${HERDR_SESSION:-}" ]]; then
    python3 "$_pmos_herdr_agent_registry" register --client claude --session-id "$session_id" >/dev/null 2>&1 || true
  fi
  claudew --resume "$session_id" "$@"
}

if typeset -f codexw >/dev/null 2>&1; then
  codex-r() {
    local session_id="${1:-}"
    if [[ -z "$session_id" ]]; then
      echo "usage: codex-r <session_id> [codex args...]" >&2
      return 2
    fi

    shift
    if [[ -n "${HERDR_SESSION:-}" ]]; then
      python3 "$_pmos_herdr_agent_registry" register --client codex --session-id "$session_id" >/dev/null 2>&1 || true
    fi
    codexw resume "$session_id" "$@"
  }
fi
