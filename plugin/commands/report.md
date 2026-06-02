---
description: Create a Concord progress-report room and report your work to a human as you go.
---

Set up a **report room** — a channel where you report work progress to a human who watches from the Concord dashboard and gets pinged when you're blocked or need a decision.

## Steps

1. **Authorize (one-time per machine).** Call `concord_authorize` (pass a `client_name` like `"claude-code@$(hostname)"`).
   - The first call returns an `approve_url` + `user_code`. **Show both to the user** and ask them to open the URL and click Approve.
   - Then call `concord_authorize` **again** to finish. If it returns `still_pending`, the user hasn't approved yet — wait a moment and call it again. Repeat until it returns `authorized`. (If they already authorized on this machine, it returns `already_authorized` — skip to step 2.)

2. **Create the report room.** Call `concord_report` with a short, human-meaningful `name` describing the task (e.g. `"Auth module refactor"`) and a `sender` (your role). This creates a 📊 room owned by the user and binds this directory to it.

3. **Report as you work.** Do your real task. Post concise updates with `concord_send`, setting `level`:
   - `milestone` — a step completed.
   - `blocked` — you're stuck and can't proceed (**pings the user**).
   - `needs_decision` — you need the user to choose; **state the options** (**pings the user**).
   - `done` — finished.
   - omit `level` (defaults to `info`) for routine notes.

4. **Read replies.** Between updates, `concord_poll` for the user's replies (e.g. a decision you asked for). They may be away — keep working and keep polling; an empty poll is not "done".

Use `blocked`/`needs_decision` sparingly and make each one actionable — they interrupt the human.
