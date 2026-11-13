-- PROPOSED, not applied to any store: an additive version 1 view. The Tasks board (board/transcripts.py `_turn_tools`) uses a store's own `v1_turn_tools`
-- when it exists and otherwise runs this definition as a per-connection TEMP view, so the store file is never written. Becoming a real view is an S2 migration.
--
-- Why: the board links a supervisor reply to the task it is about. The strongest rule in the prototype was "the turn's own tool calls named the
-- task" (`fm-send.sh <task-id> ...`, `fm-captain-hold.sh hold <task-id> ...`): 127 of about 220 exact links in one home. `v1_turns` carries only
-- a count of tools, and tables are not the contract, so a board built on the views alone links about a third as many replies (31 against 91 in one home).
--
-- What: one row per turn with the bounded text of that turn's tool-call inputs (the same `step` text the reader's own page shows, which already
-- drops anything that touched a dotfile or a credential path). It is a new view beside v1_*, so no existing view changes and `user_version`
-- stays 1; it needs to be created on an existing store by the S2 migration, and the board treats its absence as "no command signal".
--
-- Cost to check in S2: tool_calls is about 99 MB; the join below is read once per board build for the sessions in the window.
CREATE VIEW IF NOT EXISTS v1_turn_tools AS
  SELECT t.session_id, t.idx,
         (SELECT group_concat(substr(c.step, 1, 1500), char(10))
            FROM events e JOIN tool_calls c ON c.source_id = e.source_id AND c.tool_use_id = e.tool_use_id
           WHERE e.session_id = t.session_id AND e.source_id = t.source_id AND e.kind = 'assistant' AND e.tool_use_id IS NOT NULL
             AND e.offset >= t.start_offset
             AND e.offset < COALESCE((SELECT n.start_offset FROM turns n WHERE n.source_id = t.source_id AND n.idx = t.idx + 1), 9223372036854775807)) AS text
  FROM turns t JOIN sessions s ON s.session_id = t.session_id AND s.current_source_id = t.source_id;
