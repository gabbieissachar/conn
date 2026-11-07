# S1 exit scorecard

Rendered: (the date of the render) from the store. Soak started: not started.

A row reads OPEN until its check has run and passed; nothing is PASS by default.

| Check | Pass means | Result | Evidence |
| --- | --- | --- | --- |
| 1. Turn parity, automated | zero unexplained mismatches over the last three days of the soak | **OPEN** | no parity run yet. 0 runs over 0 distinct days in the last 3 days, 0 session comparisons, 0 unexplained mismatches |
| 2. Identity at the moment it matters | zero mismatches between the store's live binding and the send check, across the soak | **OPEN** | Send: none; audit: none. No Send row until the Send hook is applied (README, "The Send hook"); audit rows are the same comparison without a Send. |
| 3. Disagreement adjudication | zero unadjudicated rows, no open `builder-right` row | **OPEN** | the builder's mapping has not been sampled yet. 0 builder samples; 0 rows: 0 unadjudicated, 0 store-right, 0 builder-right (0 open), 0 both-wrong |
| 4. Event coverage checklist | every row filled, and at least seven days have passed | **OPEN** | 0 of 12 rows filled; soak day 0.0 of at least 7; open: /clear in Claude, /clear in Codex, resume, compact, a model-swap restart, a Herdr restart, pane close, Ctrl+Z, a Codex worker, a pane in a second Herdr session, a personal-account pane, a Pi pane |
| 5. Crash and file-change tests, in the lab | no duplicate or missing events after a mid-write kill; a deleted log stays, marked log gone; `forget` removes everywhere | **OPEN** | the lab tests have not been run through `reader_store.py lab-run` yet |
| 6. Cost and lag | `rusage` CPU within budget, lag p95 within budget, `/clear` to relink at or below 2 s in the lab | **OPEN** | ingest: no sample yet; diff job: no run yet; lag: no sample yet; /clear-to-relink: not measured yet |
| 7. Usefulness check by the owner | each expected session is in the top results of its known-answer search | **OPEN** | no known-answer file given |

Overall (checks 1 to 7): **OPEN**.

## 8. Verdict

- Firstmate verified the numbers against the raw logs: ______ (date, who)
- Gaps named: ______
- Owner's go for S2 and S3: ______

## Evidence files

- Parity mismatches: `parity_mismatches` (both values per row); `reader_store.py parity-report`
- Send checks: `send_checks` and the `send_agreement` view
- Disagreements: the `disagreements` view; `reader_store.py disagree list`
- Coverage: `reader_store.py coverage show` (writes the checklist file)
- Cost: `reader_store.py rusage`; lag: `ingest_lag`
- Known answers: `reader_store.py known-answers check <file>`
