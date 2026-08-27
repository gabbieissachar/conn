# Herdr Agent Session Replay

Use this when `herdr` already manages layout and pane transport, but pmOS still
needs a replay contract for resumable Codex and Claude sessions.

## Model

- `herdr` owns named-session persistence, workspaces, tabs, panes, and
  worktrees.
- pmOS keeps a narrow replay registry keyed by the compound identity
  `herdr_session + pane_id`; pane IDs are only unique inside one named Herdr
  session.
- `herdr-agent-register` records `pane_id -> client -> session_id -> cwd ->
  resume_command`.
- `herdr-agent-scan` and `herdr-agent-autoregister` enumerate live herdr panes,
  auto-register panes whose resume ids are visible in scrollback or in the
  foreground process command, and park the rest in missing-session JSON.
- `herdr-agent-capture-history` is an explicit alias for that evidence-based
  scan; process metadata is preferred after scrollback and is safe to rerun.
- The scan checks Herdr's pane-level native `agent_session` metadata first when
  an official integration has reported it.
- `herdr-agent-capture-status` opt-in queries `/status` in unresolved idle
  agent panes and parses the returned session ID; it does not query working or
  blocked panes.
- `herdr-agent-restore` safely replays `codex-r` or `claude-r` into registered
  panes.
- `herdr-agent-recover` runs the post-restart sidecar recovery sequence in one
  command: history scan, opt-in status capture, then replay.
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

List registered replay targets. The first column is the Herdr session:

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

## Restart Recovery

Herdr persists each named session's workspaces, tabs, pane layout, labels, and
cwd. It cannot keep arbitrary foreground processes alive across a computer
restart, so agent conversation restoration is a separate layer for every
selected named session.

Preferred path, after verifying it on one non-critical pane:

```sh
herdr integration install codex
herdr integration install claude
herdr integration status
```

Herdr's native integrations report the agent session references and let Herdr
restore them with the layout. Keep native agent restore enabled in Herdr
configuration. This is the preferred path, but it is not yet enabled or
verified in this environment.

Current sidecar fallback after Herdr is running again. Attach each selected
non-default named session in its own terminal, because each attach exposes a
different Herdr pane namespace:

```sh
herdr session attach esim
herdr session attach Misc
herdr-agent-recover
```

Run `herdr-agent-recover` once per attached named session. It scans and restores
only the session exposed by the current `HERDR_SESSION`/Herdr socket, so a
`w1:p1` in `esim` cannot collide with a `w1:p1` in `Misc`.

The fallback first captures IDs from live process metadata and scrollback,
then queries unresolved idle panes with `/status`, and finally replays only
registered IDs. Its status diagnostics are appended to:

```sh
personal/01-System/setup/herdr/state/herdr-agent-status-capture.jsonl
```

The JSONL file records outcomes and identifiers, not pane output. A login hook
or LaunchAgent can later run the attach and recovery sequence automatically;
that should be added only after the interactive flow is proven.

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
