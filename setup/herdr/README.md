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
configuration. As verified on 2026-09-06, the local Claude v7, Codex v7, and
Copilot v2 integrations are installed and current, and live Herdr panes expose
native agent-session metadata. Keep this sidecar as a fallback for panes that
lack native metadata.

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
or tmux pane scanning. Herdr already owns layout persistence and native agent
resume. It can move individual panes between workspaces, but it cannot move a
complete tab atomically or archive a workspace non-destructively. Those gaps
belong in Herdr rather than this sidecar.

## Restart-Recovery Bundles

`prepare-restart-recovery` is separate from `archive`. It does not close a
workspace or tab, send a status command to a busy pane, or dispatch an agent
resume command. `backup-all` is an alias for the same non-destructive command.

Use this safe order when a computer restart could interrupt Herdr:

1. Attach the exact named sessions that need recovery, then run a strict
   preflight and seal the bundle. Repeat `--session`; without it, the command
   selects only sessions running at preflight time. It never selects every
   saved session directory.
2. Restart only after the command reports that the bundle is `ready`.
3. After boot, attach each bundled session through Herdr's normal interactive
   path. Recovery does not start sessions for you.
4. Run the reconciliation preview. It adopts matching native workspaces and
   identifies only proven-missing workspaces for rebuilding.
5. Confirm the preview, then check the recorded verification result. Agent
   command dispatch and observed agent recovery are reported separately.

For example:

```sh
herdr-organizer prepare-restart-recovery --session project-a --session project-b
# Keep the printed bundle ID private and local.

# Restart the computer, then attach each selected session in the normal Herdr UI.
herdr-organizer reconcile-all --bundle <bundle_id>
herdr-organizer reconcile-all --bundle <bundle_id> --confirm <bundle_id>
```

The preparation preflight refuses busy or unresolved Codex and Claude panes,
missing CWDs or registered worktrees, unknown foreground process state, and
unclassified non-shell processes. To acknowledge one intentionally volatile
process, name its complete identity. There is no global bypass:

```sh
herdr-organizer prepare-restart-recovery --session project-a \
  --allow-volatile-pane 'project-a|w3|w3:t2|w3:p1'
```

Bundles, per-session captures, checksums, and reconciliation journals live in
`state/workspace-organizer/restart-recovery/`. They are local-only, gitignored,
and created with private permissions. They contain paths and supported-agent
resume metadata, so do not commit, upload, or share them. Keep the pre-boot
bundle and post-boot journal until you accept the result, then delete them
manually under your normal local retention policy. The tool never silently
prunes them.

`reconcile-all` is preview-first. It refuses an unattached bundle session and
never starts one. It does not rebuild an ambiguous native match. An intentional
additional copy requires both `--copy-ambiguous` and the second confirmation
`--confirm-extra copy:<bundle_id>`. `rollback-reconcile` also starts as a
preview and can close only workspace IDs created by that bundle's journal. It
never closes adopted native workspaces.

## Workspace Organizer MVP

`herdr-organizer` is a local bridge for the immediate workflow. It reorders
tabs within their current workspace without disrupting processes. It can also
archive a whole workspace by saving its tab layouts and supported agent resume
references, then closing the workspace. Restore creates a new workspace and
fresh shells from that archive.

It does not preserve running processes, terminal scrollback, or an atomic
cross-workspace tab move. An archive with working or blocked agents is refused
unless you explicitly acknowledge that those processes will stop.

Write the snapshot consumed by the local viewer:

```sh
herdr-organizer snapshot
herdr-organizer-ui
```

When only one named Herdr server is running, the organizer selects it
automatically. When more than one is running, choose the target explicitly:

```sh
herdr-organizer-ui --session esim
```

Preview an archive, then execute it with the exact workspace ID:

```sh
herdr-organizer archive --workspace w3
herdr-organizer archive --workspace w3 --execute --confirm w3
```

Restore an archive as fresh shells. Add `--resume-agents` only when you want
the organizer to send supported Codex or Claude resume commands into those
new panes:

```sh
herdr-organizer list-archives
herdr-organizer restore --archive <archive_id>
herdr-organizer restore --archive <archive_id> --execute --confirm <archive_id>
herdr-organizer restore --archive <archive_id> --resume-agents --execute --confirm <archive_id>
```

Reorder a tab with a zero-based destination index:

```sh
herdr-organizer reorder-tab --tab w3:t2 --index 0
herdr-organizer reorder-tab --tab w3:t2 --index 0 --execute
```

Move selected tabs to another workspace with the organizer's multi-select UI,
or repeat `--tab` in the terminal. This is an archive-stop style operation: it
rebuilds layouts in the destination and only then closes the original tabs.
It does not preserve their running processes, but it automatically sends
supported Codex and Claude resume commands into the replacement panes. It
writes a recovery record before it closes any source tab, so a failed resume
can be retried.

```sh
herdr-organizer move-tabs --tab w3:t2 --tab w3:t4 --to-workspace w5
herdr-organizer move-tabs --tab w3:t2 --tab w3:t4 --to-workspace w5 --execute --confirm w5
herdr-organizer resume-move --move <move_id> --execute --confirm <move_id>
```
