Nathan, the export job sent its first report, and it shows a gap to close first. In the job's local copy, `export-run.cjs` writes the file **before** it checks the target folder, and it accepts any option name. A typo in `--dry-run` there writes real files. The safe version, which refuses unknown options and requires `--dry-run` or `--execute`, exists only on the shared `main` (`1a2b3c4d`).

The build waits on your answers below. The full report is the job's `report.md`, at `/tmp/example/data/export-job/report.md`.

| Key | Call | Recommended |
|---|---|---|
| **R1** | Restore the strict option checks in the local script now: `a` yes, the job owner does it now; `b` wait for the new build | `a`, since any run there can hit it today |
| **R2** | Which code the build starts from. The shared `main` has the strict checks but lacks the new lookup fixes; the local copy has those fixes but lost the checks. `a` the owner merges both into one base first; `b` build on the shared `main` without the fixes | `a` |
| **R3** | Regions in the first version. Four regions have no expected host, so the host check is silently skipped for them. `a` only regions with a host check (north and east, and the others already configured); `b` all, after their hosts are added | `a` |
| **R4** | A run that exits successfully but reports `ok=false` or failed rows: `a` treat it as a hard stop; `b` trust the exit code | `a` |
| **R5** | Receipt check when the endpoint is missing or errors: `a` fail and stop; `b` keep today's "not found" plus success | `a` |
| **R6** | Account input: `a` numeric account id only; `b` also accept an alias that a script resolves | `a` for the first version |
| **R7** | Who sets the setup values and `EXPORT_SETUP_FILE` for the workflow: `a` the job owner; `b` you | `a` |
| **R8** | How old an event can be before a person must approve replaying it. The scripts have no age limit today: `a` 7 days; `b` 30 days; `c` give a number | your call, since partner retention rules apply |
| **R9** | If sending is ever automated, add a second approval after the receipt check: `a` yes; `b` no | `a` |

Reply like `R1=a; R2=a; ...`. The owner will act on R1, R2 and R7 from its own home. I'll pass your answers on and start the build.

Notes on the rest of the batch are still in progress.

**Still open:**
- **G1** review-only mode ([here](http://localhost:8768/setup/transcript-reader/out/prototype.html#s=1f5b7c82&m=90a7b6ed-fb1), [phone](https://example.invalid/prototype.html#s=1f5b7c82&m=90a7b6ed-fb1)). I recommend `b`.
