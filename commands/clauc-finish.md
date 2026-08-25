---
description: Mark the current branch as done and print its final numbers
argument-hint: "[branch] [--note \"text\"]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/clauc:*)
---

Run `${CLAUDE_PLUGIN_ROOT}/bin/clauc finish $ARGUMENTS` and report the final elapsed/active numbers.
