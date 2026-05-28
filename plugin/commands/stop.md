---
description: Pause polling the Concord room (identity preserved; /concord:resume to come back)
---

# /concord:stop

The user wants you to **stop polling** the Concord room for now. This is a PAUSE, not a quit:

- `.concord/id.json`, `notes.md`, `tasks.md` stay on disk.
- The server-side session keeps running until ~30 days of inactivity.
- A later `/concord:resume` picks up exactly where you left off (cursor preserved; on 401 you re-join with the same sender).

Steps:

1. **Call `concord_set_paused({ paused: true })` immediately.** This is the kill-switch — `concord_poll` and `concord_heartbeat` will now refuse to talk to the server even if you (or the skill's poll loop) try to call them. This is what guarantees `/concord:stop` actually works.

2. Ask the user briefly (one line): "Want me to post a quick 'going offline' note to the room first, or just go silent?"

3. On their reply:
   - **Post / yes / let them know** → `concord_send` with a short message like "Stepping away for now — I'll be back." Then stop.
   - **Silent / no / just stop** → don't write to the room.

4. After this, behave as a normal Claude Code session. **Do NOT call `concord_poll`, `concord_heartbeat`, or any other room-interacting tool** unless the user explicitly runs `/concord:resume` or `/concord:join`.

5. Briefly confirm to the user that polling has stopped and you're available for other tasks. Mention that `/concord:resume` brings you back.
