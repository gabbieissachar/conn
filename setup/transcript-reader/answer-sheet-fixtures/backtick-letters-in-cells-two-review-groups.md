Nathan, I added this to the list as top priority. Two groups of questions to start the design are below. The sketch comes after your answers.

Where reminders come from today, since "all reminders" can mean three different things:
1. **The app itself:** the badge and the count of open items. The app sends no banners.
2. **The mail digest:** sent by a script in the ops repo.
3. **Everything else:** calendar and chat belong to the operating system. An app can only mute those by switching on a system mode, through a shortcut you create once.

## Review group A - what "quiet" means

Answer these in order. P1 decides how P2 and P3 make sense. Stop at P1 if your answer changes the picture.

| ID | Decision | Depends on | Recommended | Answer |
| --- | --- | --- | --- | --- |
| **P1** | What a quiet session mutes | - | `b` | `a` the app and the digest only: items 1-2 above, calendar and chat untouched / `b` the app, the digest and the system: also switches the system mode on and off through your shortcut / `c` the app's own badge and count only |
| **P2** | What happens to reminders that arrive during a quiet session | P1 | `a` | `a` held, then shown as one short list when the session ends / `b` dropped (they stay visible in the item list) |
| **P3** | Can anything break through | P1 | `a` | `a` nothing / `b` an item waiting on you for more than N minutes / `c` named lists only |

I recommend P1=b because "all reminders" most likely means chat too. P2=a means you lose nothing and get one catch-up moment instead of a trickle.

## Review group B - the timer

These are independent of each other and of group A.

| ID | Decision | Recommended | Answer |
| --- | --- | --- | --- |
| **P4** | Session shape | `a` | `a` classic: 25 min focus, 5 min break, a 15 min break after every 4, all editable / `b` one block of a length you choose, no breaks / `c` both as presets |
| **P5** | Where the countdown shows | `a` | `a` a pill in the toolbar plus a countdown in the menu bar / `b` toolbar only |
| **P6** | When a session ends | `b` | `a` soft chime, then a "Session done" screen with Restart and Start break buttons, nothing starts on its own / `b` the break starts on its own, then the next session |

P6=b matches your "keep it rolling".

**Next, group C:** how breaks show and what happens when you are away.

Reply with keyed answers: `P1=...; P2=...; P3=...; P4=...; P5=...; P6=...`
