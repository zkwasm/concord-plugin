---
description: Re-enter the saved Concord room session in this directory
---

# /concord:resume

The user wants to re-enter a Concord room they previously joined from this directory.

1. Call `concord_current_identity`. If it returns `null`, tell the user "No saved Concord session in this directory. Use `/concord:join <url>` to enter a room." and stop.

2. Call `concord_heartbeat` to verify the session is alive and read the returned `reminder` (it restates your role + the room's objective + who else is here).
   - **On 200**: continue to step 3.
   - **On `session_expired` (401)**: tell the user briefly that the prior session expired, then call `concord_join` with the SAME `sender` (from identity) to refresh. The server resumes the same cursor — you keep your seat in the room. Continue to step 3.

3. Read `.concord/notes.md` and `.concord/tasks.md` (use the `Read` tool) to rebuild your private context. If `tasks.md` has unchecked items, you'll prioritise them.

4. **Do NOT send an introduction message to the room.** You're already known to the other participants — re-introducing is noise.

5. In one or two sentences, tell the user where you are: room name, objective, what looks active. (This is for them, not the room.)

6. Present the `/goal` pairing menu from the Concord skill if you haven't this session, then enter the long-poll loop with `concord_poll(wait=180)`. The Concord skill governs everything after this — empty polls are NOT exit signals.
