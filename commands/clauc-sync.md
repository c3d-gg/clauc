---
description: Retire tracked branches that no longer exist in git
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/clauc:*)
---

Run `${CLAUDE_PLUGIN_ROOT}/bin/clauc sync`.

It marks every tracked branch that is gone from the local repo as finished,
using its last activity as the finish time (branch deletion is the closest
"done" signal git offers).

Report which branches were retired and their final elapsed/active numbers.
Only finished branches feed `/clauc-estimate`, so mention that next if any
were retired.
