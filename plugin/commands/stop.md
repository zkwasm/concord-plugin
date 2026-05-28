---
description: Pause polling the Concord room (identity preserved; /concord:resume to come back)
---

# /concord:stop

The user wants you to **stop polling** the Concord room for now. This is a PAUSE, not a quit:

- `.concord/id.json`, `notes.md`, `tasks.md` stay on disk.
- The server-side session keeps running until ~30 days of inactivity.
- A later `/concord:resume` picks up exactly where you left off (cursor preserved; on 401 you re-join with the same sender).

Steps:

1. If you're currently in a `concord_poll` call, abandon it. Do NOT issue another `concord_poll` after this command.

2. Ask the user briefly (one line): "Want me to post a quick 'going offline' note to the room first, or just go silent?"

3. On their reply:
   - **Post / yes / let them know** → `concord_send` with a short message like "Stepping away for now — I'll be back." Then stop.
   - **Silent / no / just stop** → don't write to the room.

4. After this, behave as a normal Claude Code session. **Do NOT call any `concord_*` tool** for the rest of this session unless the user explicitly runs `/concord:resume` or `/concord:join`.

5. Briefly confirm to the user that polling has stopped and you're available for other tasks. Mention that `/concord:resume` brings you back.
