---
description: Backfill branch history from past Claude Code transcripts
argument-hint: "[--dry-run] [--days N] [--force]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/clauc:*)
---

If the user passed no arguments, run `${CLAUDE_PLUGIN_ROOT}/bin/clauc import --dry-run`
first, show the summary line and the branch table, and get the user's go-ahead before
re-running without `--dry-run` to write. Otherwise run
`${CLAUDE_PLUGIN_ROOT}/bin/clauc import $ARGUMENTS` and show the summary line and the
branch table.

After a real (non-dry-run) import, mention that `/clauc-sync` retires branches already
deleted from git — only finished branches feed `/clauc-estimate`.
