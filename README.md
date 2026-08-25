# clauc

Tracks how long a **project + branch** actually takes, from inside Claude Code.

Built for the estimation problem: you can't feel how long work takes, so guess
from your own history instead. After a few branches you get numbers like
*"a `feat/` branch here usually runs 3 days, worst case 7."*

```
air-ui on feat/address-book
  elapsed   2 days  (since 2 days ago)
  active    5h 36m  (1h 2m today)
  spread    3 days, 3 sessions
  volume    14 prompts, 22 tool calls
```

```
Based on 5 finished branches in air-ui:

kind  n  elapsed (p50)   (p80)  active (p50)   (p80)  prompts
────  ─  ─────────────  ──────  ────────────  ──────  ───────
feat  3         3 days  7 days         7h 6m   7h 8m       17
fix   2             5h   1 day           54m  1h 12m        3
```

## The two numbers

They answer different questions, and confusing them is how estimates go wrong.

| | what it is | what it's for |
|---|---|---|
| **elapsed** | first activity → last activity | "when will this land?" — includes nights, meetings, waiting on review |
| **active** | sum of work chunks | "how much of my day does this eat?" |

A branch can be *3 days elapsed, 7 hours active*. Quote elapsed to other people;
plan your week with active.

## How time is measured

Hooks fire a **beat** on every prompt, tool call, session start, and turn end.
Beats accumulate into chunks:

- Beats less than **30 min** apart extend the current chunk.
- A longer gap ends it — that gap is never counted as work.
- Each new chunk is back-dated **2 min** to credit the thinking that produced
  it, so a session of sparse prompts doesn't report zero.

Both thresholds are env-tunable (see Configuration). Nothing leaves your
machine; everything lands in a local SQLite file.

## Install

Requires **[Bun](https://bun.sh)**. That's a hard dependency, not a fallback
tier — clauc is built on `bun:sqlite` and runs its TypeScript directly, no
build step. It's an opinionated tool; if Bun isn't your thing, this isn't your
tracker.

```
/plugin marketplace add c3d-gg/claude-plugin
/plugin install clauc@c3d
```

Tracking starts on the next session. Non-git folders are ignored — there's no
branch to key on. If Bun lives somewhere unusual, point the hooks at it with
`CLAUC_BUN=/path/to/bun`.

Then run `/clauc-setup` once. It checks the hooks can find Bun, offers to put
`clauc` on your terminal PATH (inside Claude Code sessions it's on PATH
already), and backfills history from your past transcripts:

```sh
clauc import
```

That backfill is why you have numbers today instead of in six weeks.

## Commands

The plugin puts `clauc` on your PATH, and mirrors the common ones as slash
commands.

| | |
|---|---|
| `clauc status` | this branch: elapsed, active, today, volume |
| `clauc report` | every branch here. `--all` for every project, `--days N` to window, `--done` for finished only |
| `clauc estimate` | p50/p80 by branch kind — the planning table |
| `clauc finish [branch]` | mark done, `--note "text"`, `--at "2026-08-20 14:00"` |
| `clauc reopen [branch]` | undo that |
| `clauc sync` | retire branches already deleted from git |
| `clauc import` | backfill from past transcripts. `--dry-run`, `--days N`, `--force`, `--dir PATH` |
| `clauc backfill` | carve a window of tracked time out of main into a named branch |
| `clauc merge-project` | fold a phantom project into its real repo |
| `clauc tag [branch] +x -y` | label a branch; bare `clauc tag` shows labels |
| `clauc tags` | active time rolled up per tag. `--all` for every project |
| `clauc projects` | everything tracked |
| `clauc where` | db path and current settings |

Slash commands: `/clauc-setup`, `/clauc-status`, `/clauc-report`,
`/clauc-estimate`, `/clauc-import`, `/clauc-sync`, `/clauc-finish`. These run
the plugin's own copy, so they work before `clauc` reaches your terminal PATH.
Inside Claude Code sessions the plugin's `bin/` is on PATH automatically;
`/clauc-setup` can install a shim for your regular terminal too.

### Importing history

Claude Code already writes a transcript per session under
`~/.claude/projects`, and every line carries `cwd`, `gitBranch` and a
timestamp — which is everything a beat carries. `clauc import` replays those
through the same chunking rule, so history and live tracking are measured
identically.

- Subagent transcripts are included. They overlap their parent session in time,
  so they add tool calls without adding wall-clock time.
- Overlapping chunks are coalesced, so importing twice, importing a session
  that is still running, or importing over live-tracked time does not
  double-count.
- Each transcript is recorded once it has been read, and re-read only if it has
  grown. `--force` overrides that.
- Lines with `gitBranch: "HEAD"` are dropped. That is what gets written when
  the cwd is not a repo at all.

Start with `clauc import --dry-run` to see the branches and date ranges it
found before writing anything.

How far back this reaches depends on how long Claude Code has kept your
transcripts, so run it before they age out.

### Finishing branches

Only **finished** branches feed `clauc estimate` — an open branch has no final
duration yet. Two ways to close one:

- `clauc finish` when you merge, or
- `clauc sync`, which retires every tracked branch that no longer exists
  locally. Deleting a branch is usually the truest "done" signal git offers.

Beating on a finished branch reopens it automatically.

Work done entirely on `main` never triggers either signal — `main` is never
deleted and never feels "done". Close a stretch of it with
`clauc finish --at`, or carve it into named branches with `backfill` below.

### Backfilling branches out of main

`clauc backfill` retroactively carves a window of already-tracked time out of
an existing branch (usually `main`) into a named one, so it can feed
`estimate`:

```sh
clauc backfill lesson/07-registry "2026-08-20 19:00" "2026-08-20 21:30" \
  --note "command registry" --finish
```

- Bounds are ISO timestamps (local), ms epochs, or `commit:<ref>` — that
  commit's author time. The window is half-open: `[from, to)`.
- A chunk that overlaps a window edge is **split** there, not assigned whole by
  its start time — one 30-min-idle chunk can span a whole evening, and
  assigning it whole would zero out every window inside it. Prompt and tool
  counts are prorated by piece duration and conserved exactly.
- Time outside the window stays on the source branch (`--from-branch`,
  default `main`). `--finish` closes the new branch at `to`.
- It refuses to carve into a branch that already has chunks unless `--force`.

Sequential windows — each lesson starting where the last one ended — batch
through a plan file:

```sh
clauc backfill --plan plan.json    # [{branch, from, to, note?, finish?}]
```

Windows run in order, so a chunk spanning several windows is re-cut by each.

### Healing phantom projects

A session whose cwd has since been deleted (scratch dirs, symlinked
`node_modules` packages) can't be resolved to its repo root at import time and
used to strand its time as a separate "project". Import now walks up to the
nearest surviving ancestor; rows created before that fix merge by hand:

```sh
clauc projects                       # shows the exact paths
clauc merge-project /path/to/phantom /path/to/repo
```

Chunks move wholesale, branch rows merge by name, and overlapping time
coalesces the same way a re-import does.

### Grouping

`estimate` groups by branch prefix, so it follows whatever convention you
already use:

| branch | kind |
|---|---|
| `feat/login` | `feat` |
| `AIR-812-modal-focus` | `AIR` |
| `fix-the-thing` | `fix` |
| `scratch` | `other` |

### Tags

Branch prefixes answer "how long does a `feat/` take"; tags answer "where did
my week go" across prefixes:

```sh
clauc tag +frontend +ui       # current branch
clauc tag fix/crash +urgent   # any branch
clauc tags                    # active time per tag
clauc report --tag frontend
```

Tags are labels only — they never feed `estimate`, which stays grouped by
branch prefix.

## Configuration

| env var | default | |
|---|---|---|
| `CLAUC_HOME` | `~/.clauc` | where `clauc.db` lives |
| `CLAUC_IDLE_MINUTES` | `30` | gap that ends a work chunk |
| `CLAUC_LEAD_IN_MINUTES` | `2` | credit given to a chunk's first beat |
| `CLAUC_STALE_DAYS` | `14` | untouched branches shown as `stale` |
| `CLAUC_BUN` | — | explicit bun path for hooks |
| `CLAUC_DEBUG` | — | `1` to log beats to stderr |

## Data

One SQLite file at `~/.clauc/clauc.db`, two tables:

- `chunks` — one row per continuous stretch of work
- `branches` — first seen, last seen, finished, note

Query it directly whenever the built-in reports aren't the cut you want:

```sh
sqlite3 ~/.clauc/clauc.db \
  "SELECT branch, SUM(ended_at - started_at)/3600000.0 AS hours
     FROM chunks GROUP BY branch ORDER BY hours DESC"
```

## Development

```sh
bun install
bun run check   # typecheck + tests
```

Hooks run `src/hook.ts` through bun directly — no build step, so an edit is live
on the next beat.

To run your checkout as the installed plugin, the repo doubles as a local
marketplace:

```
/plugin marketplace add /path/to/your/clauc/checkout
/plugin install clauc@clauc-dev
```

Validate manifests with `claude plugin validate .` before opening a PR.

## Layout

```
.claude-plugin/   plugin + marketplace manifests
hooks/hooks.json  the five events that produce beats
scripts/beat      sh shim → src/hook.ts
bin/clauc         sh shim → src/cli.ts (added to PATH)
commands/         slash commands
src/
  config.ts   thresholds and paths
  git.ts      repo root + branch resolution
  db.ts       sqlite schema + the branch upsert policies
  chunks.ts   the beat → chunk fold and overlap coalescing
  track.ts    live tracking (the same rule, applied incrementally)
  report.ts   queries, percentiles, categorisation
  import.ts   transcript backfill
  backfill.ts carve windows of main into named branches
  merge.ts    fold phantom projects into their repo
  format.ts   durations and tables
  tags.ts     branch labels for cross-cutting reports
  args.ts     CLI argument + time parsing
  hook.ts     hook entrypoint
  cli.ts      CLI entrypoint
```

## License

[MIT](LICENSE)
