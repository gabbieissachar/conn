Nathan, that was unclear on my side. I used bare keys such as Z2 and R1 without saying what they were, so this is what they meant, and then the group to answer now.

## Quick fix for now: what those keys meant

| Key | In plain words |
|---|---|
| Z2 | You asked for a shortcut in the mobile app that opens the chat list. The open question is whether it should also close the current chat first. |
| R1-R4 | The design that explains why notices to the support team arrive late ("sent, not delivered"). It needs four calls. |
| Z3 | Whether the report page's Export button should also show in narrow windows. |
| Personal script | The export script has 3 more places that only look in the default folder. The question is whether to change them now. |
| Land | Three fixes are ready to land: both gauge halves and the plugin update. |

## Review group X: what the release board is built on

### How things work today

Open items already live in records, just scattered:

- **The tracker:** one row per task. 32 of those rows are calls waiting on you, each with its question written in the row.
- **Status lines:** "needs a decision", "ready".
- **Reports:** a `report.md` in each task's folder.
- **Chat replies:** this is where the plain-language context ends up buried.

**The trap:** a board with its own store drifts away from the tracker within days, and then you cannot trust either.

**My default:** the board is a read-only view over the existing records, the cards are tasks, and decisions stay where they are written.

### Cards

Answer them in order. X2 and X3 depend on the cards before them, so stop wherever an answer changes the plan.

| ID | Decision | Depends on | Recommended | Answer |
|---|---|---|---|---|
| X1 | **Where it lives.** a) a Board view inside the reader (it is already running, works on your phone) / b) a standalone page / c) inside the admin tool | none | a) | |
| X2 | **What a card is.** a) one task, with its open decisions, latest status and report link / b) one decision, linked to its task | X1 | a) | |
| X3 | **Columns.** a) by who acts next: Needs you, Ready, Running, Parked, Done / b) by project | X2 | a) | |
| X4 | **Cold-read context.** Every Needs-you card must make sense on its own: a) the card carries its own summary / b) it links to the report | X2 | a) | |
| X5 | **Answering.** a) answer on the card, recorded the way chat records it today / b) the board only links to the chat / c) both | X3 | a) | |
| X6 | **Which homes.** a) this home only / b) every home with a filter | X1 | b) | |

Reply with keyed answers: X1=...; X2=...; X3=...; X4=...; X5=...; X6=...

You can also answer `needs explanation` or `defer` on any card. Once these are settled, the next group covers who can see the board.
