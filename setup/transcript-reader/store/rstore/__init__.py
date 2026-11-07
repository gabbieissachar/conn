"""The transcript reader's shadow store (plan S1): one SQLite file that every harness's session log is ingested into, with the
live identity of each Herdr pane, and the checks that prove it against today's reader. Nothing reads the store yet.

Design and operations: ../README.md. The plan: data/reader-architecture-plan/plan.md in the Firstmate home ("S1").
"""

SCHEMA_VERSION = 1
