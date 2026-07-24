# Herdr Agent Session Replay

Use this when `herdr` already manages layout and pane transport, but pmOS still
needs a replay contract for resumable Codex and Claude sessions.

## Model

- `herdr` owns session persistence, workspaces, tabs, panes, and worktrees.
- pmOS keeps a narrow replay registry keyed by herdr pane identity.
- `herdr-agent-register` records `pane_id -> client -> session_id -> cwd ->
  resume_command`.
- `herdr-agent-scan` and `herdr-agent-autoregister` enumerate live herdr panes,
  auto-register panes whose resume ids are visible in scrollback or in the
  foreground process command, and park the rest in missing-session JSON.
- `herdr-agent-capture-history` is an explicit alias for that evidence-based
  scan; process metadata is preferred after scrollback and is safe to rerun.
- `herdr-agent-capture-status` opt-in queries `/status` in unresolved idle
  agent panes and parses the returned session ID; it does not query working or
  blocked panes.
- `herdr-agent-restore` safely replays `codex-r` or `claude-r` into registered
  panes.
- `herdr-agent-capture-missing` preserves the tmux-era manual repair pattern
  when a pane is known but the resumable session id is not.

State files default to:

```sh
/Users/nguyen.tran/workspace/pmos/personal/01-System/setup/herdr/state/
```

## Shell Setup

Source these in shells that launch or resume Codex or Claude inside herdr:

```sh
source /Users/nguyen.tran/workspace/pmos/setup/codex-shortcuts.zsh
source /Users/nguyen.tran/workspace/pmos/personal/01-System/setup/herdr/agent-session-shortcuts.zsh
```

## Core Commands

Register a known resumable session for the current pane:

```sh
herdr-agent-register codex <session_id>
herdr-agent-register claude <session_id>
```

List registered replay targets:

```sh
herdr-agent-list
```

Normalize the manifest field order after manual edits or migrations:

```sh
python3 /Users/nguyen.tran/workspace/pmos/personal/01-System/setup/herdr/agent-session-registry.py normalize
```

Best-effort bulk scan:

```sh
herdr-agent-scan
herdr-agent-autoregister
herdr-agent-capture-history
herdr-agent-capture-status
```

The status capture is opt-in because it sends a diagnostic command into idle
agent panes. It registers only panes whose response contains a session ID.

This tries to detect `session_id` values from pane scrollback, keeps already
registered panes, and writes unresolved panes into the missing-session JSON for
manual fill.

Preview replay:

```sh
herdr-agent-restore
```

Execute replay:

```sh
herdr-agent-restore --execute
herdr-agent-restore --execute --all
herdr-agent-restore --pane-id w3:p1 --execute
```

Remove one registration:

```sh
herdr-agent-remove w3:p1
```

## Manual Missing-Session Flow

Capture one editable repair row for the current pane:

```sh
herdr-agent-capture-missing --client codex
```

This writes:

```sh
/Users/nguyen.tran/workspace/pmos/personal/01-System/setup/herdr/state/herdr-agent-missing-sessions.json
```

Fill `session_id`, then apply it:

```sh
herdr-agent-apply-missing
```

## Current Scope

This v1 intentionally does not port tmux layout restore, tmux snapshot listing,
or tmux pane scanning. Herdr already owns layout persistence, and integration or
runtime-based auto-detection should only be added after explicit replay has been
proven on the live runtime.
