---
description: Estimate upcoming work from your own finished branches
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/clauc:*)
---

Run `${CLAUDE_PLUGIN_ROOT}/bin/clauc estimate`. Show the table, then in two sentences translate the p80 row
that matches the work the user is about to start into a plain-language estimate. If the conversation gives
no hint which row applies, ask what they are about to start instead of guessing.
If there is no data yet, say so and suggest `/clauc-sync`, which finishes branches deleted from git.
