---
description: First-run setup — verify Bun, put clauc on your terminal PATH, backfill history
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/clauc:*), Bash(ls:*), Bash(command:*), Bash(echo:*), Bash(cat:*), Bash(mkdir:*), Bash(chmod:*)
---

Walk the user through clauc's first-run setup. Three steps, in order; report
each result in one line before moving on.

## 1. Verify the hooks can find Bun

Run `${CLAUDE_PLUGIN_ROOT}/bin/clauc where`.

- Output shows a db path → tracking works. Say so and continue.
- It fails with "bun not found" → stop here. Tell the user to install Bun
  (`curl -fsSL https://bun.sh/install | bash`) or set `CLAUC_BUN=/path/to/bun`
  in their shell profile, then rerun `/clauc-setup`. Bun is a hard dependency;
  there is no fallback runtime.

## 2. Offer the terminal shim

Inside Claude Code sessions `clauc` is already on PATH (the plugin's `bin/` is
added automatically), so this step is only for using `clauc` from a regular
terminal. Ask before writing anything.

If the user wants it, write an executable shim to `~/.local/bin/clauc` that
resolves the newest installed plugin version at run time (the install path
changes on every update, so never hardcode `${CLAUDE_PLUGIN_ROOT}` itself):

```sh
#!/usr/bin/env sh
set -eu
dir="$(ls -d PLUGIN_PARENT/*/ 2>/dev/null | sort -V | tail -1)"
[ -n "$dir" ] || { echo "clauc: plugin not installed" >&2; exit 127; }
exec "${dir}bin/clauc" "$@"
```

Replace `PLUGIN_PARENT` with the parent directory of `${CLAUDE_PLUGIN_ROOT}`
(one level up — the directory that holds one subdirectory per installed
version). If `${CLAUDE_PLUGIN_ROOT}` doesn't sit in a versioned layout (a
local-checkout install), point the shim straight at
`${CLAUDE_PLUGIN_ROOT}/bin/clauc` instead. `chmod +x` the shim.

Then check `~/.local/bin` is on the user's PATH (`command -v clauc` from a
fresh `$PATH` won't show it; check `echo "$PATH"` instead). If it isn't, give
them the exact line for their shell's profile file (read `$SHELL` to pick
`.zshrc`, `.bashrc`, or `config.fish`):

```sh
export PATH="$HOME/.local/bin:$PATH"
```

## 3. Backfill history

Run `${CLAUDE_PLUGIN_ROOT}/bin/clauc import --dry-run` and show the summary
line plus the branch table. Ask before importing for real; on a yes, run it
without `--dry-run`, then suggest `/clauc-sync` to retire merged branches and
`/clauc-estimate` once there's data.

Done means: tracking verified, shim written or explicitly declined, and the
user knows whether their history is imported.
