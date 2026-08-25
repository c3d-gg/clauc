#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs, parseWhen } from "./args.ts";
import { backfill, type Window } from "./backfill.ts";
import { DB_PATH, IDLE_MS, STALE_DAYS } from "./config.ts";
import { db } from "./db.ts";
import { ago, duration, span, table, truncate } from "./format.ts";
import { listLocalBranches, resolveRepo } from "./git.ts";
import { mergeProject } from "./merge.ts";
import {
  activeSince,
  estimates,
  getBranch,
  listBranches,
  startOfToday,
  type BranchStats,
} from "./report.ts";
import { importTranscripts } from "./import.ts";
import { setTags, tagsFor, tagSummary } from "./tags.ts";
import { finish, reopen } from "./track.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const [command = "status", ...rest] = process.argv.slice(2);

/** Flags that take no value, so the argument after them is still positional. */
const BOOLEAN_FLAGS = new Set(["all", "done", "dry-run", "force", "finish"]);

const args = parseArgs(rest, BOOLEAN_FLAGS);

function flag(name: string): boolean {
  return args.flags.has(name);
}

function option(name: string): string | undefined {
  return args.options.get(name);
}

function positional(): string | undefined {
  return args.positionals[0];
}

function positionals(): string[] {
  return args.positionals;
}

/** The repo the command is being run from, unless --all widens the scope. */
function scope() {
  return flag("all") ? undefined : resolveRepo(process.cwd());
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function label(stat: BranchStats): string {
  return `${stat.project}/${stat.branch}`;
}

function statusOf(stat: BranchStats): string {
  if (stat.finished_at) return "done";
  return Date.now() - stat.last_seen > STALE_DAYS * DAY_MS ? "stale" : "active";
}

function status(): void {
  const repo = resolveRepo(process.cwd());
  if (!repo) {
    console.log("clauc: not a git repo — nothing tracked here.");
    return;
  }

  const stat = getBranch(repo.root, repo.branch);
  console.log(`${repo.name} on ${repo.branch}`);

  if (!stat || stat.chunks === 0) {
    console.log("  no activity recorded yet");
    return;
  }

  const today = activeSince(repo.root, repo.branch, startOfToday());
  console.log(`  elapsed   ${span(stat.lead_ms)}  (since ${ago(stat.first_seen)})`);
  console.log(`  active    ${duration(stat.active_ms)}  (${duration(today)} today)`);
  console.log(
    `  spread    ${plural(stat.days_touched, "day")}, ${plural(stat.chunks, "session")}`,
  );
  console.log(
    `  volume    ${plural(stat.prompts, "prompt")}, ${plural(stat.tool_calls, "tool call")}`,
  );
  if (stat.finished_at) console.log(`  finished  ${ago(stat.finished_at)}`);
}

function report(): void {
  const repo = scope();
  const since = option("days");
  const rows = listBranches({
    projectPath: repo?.root,
    since: since ? Number(since) : undefined,
    includeFinished: true,
    onlyFinished: flag("done"),
    tag: option("tag"),
  });

  if (rows.length === 0) {
    console.log("clauc: nothing tracked yet for this scope.");
    return;
  }

  console.log(
    table(
      ["branch", "elapsed", "active", "days", "prompts", "tools", "status", "last"],
      rows.map((stat) => [
        truncate(flag("all") ? label(stat) : stat.branch, 44),
        span(stat.lead_ms),
        duration(stat.active_ms),
        String(stat.days_touched),
        String(stat.prompts),
        String(stat.tool_calls),
        statusOf(stat),
        ago(stat.last_seen),
      ]),
    ),
  );
}

function estimate(): void {
  const repo = scope();
  const rows = listBranches({ projectPath: repo?.root, onlyFinished: true });

  if (rows.length === 0) {
    console.log(
      "clauc: no finished branches yet — run `clauc finish` when you wrap one up,\n" +
        "       or `clauc sync` to retire branches already deleted from git.",
    );
    return;
  }

  console.log(
    `Based on ${rows.length} finished ${rows.length === 1 ? "branch" : "branches"}` +
      `${repo ? ` in ${repo.name}` : ""}:\n`,
  );
  console.log(
    table(
      ["kind", "n", "elapsed (p50)", "(p80)", "active (p50)", "(p80)", "prompts"],
      estimates(rows).map((e) => [
        e.category,
        String(e.count),
        span(e.medianLeadMs),
        span(e.p80LeadMs),
        duration(e.medianActiveMs),
        duration(e.p80ActiveMs),
        String(e.medianPrompts),
      ]),
    ),
  );
  console.log("\np80 is the number worth quoting — it includes the ones that went sideways.");
}

function markFinished(): void {
  const repo = resolveRepo(process.cwd());
  if (!repo) {
    console.log("clauc: not a git repo.");
    return;
  }
  const branch = positional() ?? repo.branch;
  const note = option("note");
  const at = option("at");

  if (!finish(repo.root, branch, note, at ? when(at, repo.root) : undefined)) {
    console.log(`clauc: no tracked activity for ${repo.name}/${branch}.`);
    return;
  }
  const stat = getBranch(repo.root, branch);
  console.log(
    `${repo.name}/${branch} marked done` +
      (stat ? ` — ${span(stat.lead_ms)} elapsed, ${duration(stat.active_ms)} active.` : "."),
  );
}

function markReopened(): void {
  const repo = resolveRepo(process.cwd());
  if (!repo) {
    console.log("clauc: not a git repo.");
    return;
  }
  const branch = positional() ?? repo.branch;
  console.log(
    reopen(repo.root, branch)
      ? `${repo.name}/${branch} reopened.`
      : `clauc: no tracked activity for ${repo.name}/${branch}.`,
  );
}

/**
 * Retire branches that no longer exist locally. A deleted branch was almost
 * always merged, which is the closest thing to a "done" signal git gives us.
 */
function sync(): void {
  const repo = resolveRepo(process.cwd());
  if (!repo) {
    console.log("clauc: not a git repo.");
    return;
  }

  const alive = listLocalBranches(repo.root);
  const open = listBranches({ projectPath: repo.root });
  const gone = open.filter(
    (stat) => !alive.has(stat.branch) && !stat.branch.startsWith("detached@"),
  );

  if (gone.length === 0) {
    console.log("clauc: nothing to retire — every tracked branch still exists.");
    return;
  }

  for (const stat of gone) {
    finish(repo.root, stat.branch, "auto: branch no longer in git", stat.last_seen);
    console.log(
      `  done  ${stat.branch}  ${span(stat.lead_ms)} elapsed, ${duration(stat.active_ms)} active`,
    );
  }
  console.log(`\nRetired ${gone.length} ${gone.length === 1 ? "branch" : "branches"}.`);
}

function projects(): void {
  const rows = db()
    .query<{ project: string; project_path: string; branches: number; last_seen: number }, []>(
      `SELECT project, project_path, COUNT(*) AS branches, MAX(last_seen) AS last_seen
         FROM branches GROUP BY project_path ORDER BY last_seen DESC`,
    )
    .all();

  if (rows.length === 0) {
    console.log("clauc: no projects tracked yet.");
    return;
  }
  console.log(
    table(
      ["project", "branches", "last active", "path"],
      rows.map((row) => [
        row.project,
        String(row.branches),
        ago(row.last_seen),
        row.project_path,
      ]),
    ),
  );
}

/**
 * Backfill from the transcripts Claude Code already keeps. They record cwd,
 * gitBranch and a timestamp per line, which is everything a beat carries, so
 * months of history can be replayed through the same chunking rule.
 */
async function runImport(): Promise<void> {
  const dir = option("dir") ?? join(homedir(), ".claude", "projects");
  const dryRun = flag("dry-run");
  const days = option("days");

  let lastShown = 0;
  const result = await importTranscripts({
    dir,
    force: flag("force"),
    sinceDays: days ? Number(days) : undefined,
    dryRun,
    onProgress: (done, total) => {
      if (done !== total && done - lastShown < 25) return;
      lastShown = done;
      process.stderr.write(`\rreading transcripts ${done}/${total}`);
    },
  });
  process.stderr.write("\r\x1b[2K");

  if (result.files === 0) {
    console.log(
      result.skipped > 0
        ? `clauc: all ${result.skipped} transcripts already imported. --force to re-read.`
        : `clauc: no transcripts found in ${dir}.`,
    );
    return;
  }

  console.log(
    `${dryRun ? "Would import" : "Imported"} ${plural(result.events, "event")} ` +
      `from ${plural(result.files, "transcript")}` +
      `${result.skipped ? ` (${result.skipped} unchanged, skipped)` : ""}.`,
  );
  console.log(
    `${plural(result.chunks, "work chunk")}` +
      `${result.merged ? `, ${result.merged} merged into existing ones` : ""}.`,
  );

  if (result.branches.length === 0) return;

  console.log();
  console.log(
    table(
      ["branch", "from", "to"],
      result.branches
        .slice(0, 20)
        .map((b) => [
          truncate(`${b.project}/${b.branch}`, 50),
          new Date(b.from).toISOString().slice(0, 10),
          new Date(b.to).toISOString().slice(0, 10),
        ]),
    ),
  );
  if (result.branches.length > 20) {
    console.log(`... and ${result.branches.length - 20} more.`);
  }
  if (!dryRun) {
    console.log("\nNext: `clauc sync` to retire merged branches, then `clauc estimate`.");
  }
}

function fail(message: string): never {
  console.log(`clauc: ${message}`);
  process.exit(1);
}

/** parseWhen, but a bad time exits with the usage message instead of a stack. */
function when(value: string, root: string | undefined): number {
  try {
    return parseWhen(value, root);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Retroactively carve a window of tracked time out of a source branch into a
 * named one — the escape hatch for work done entirely on main.
 */
function runBackfill(): void {
  const projectFlag = option("project");
  const repo = resolveRepo(projectFlag ? resolve(projectFlag) : process.cwd());
  const projectPath = repo?.root ?? (projectFlag ? resolve(projectFlag) : undefined);
  if (!projectPath) {
    fail("not a git repo — run from the project or pass --project <path>.");
  }
  const project = repo?.name ?? basename(projectPath);
  const fromBranch = option("from-branch") ?? "main";

  let windows: Window[];
  const planPath = option("plan");
  if (planPath) {
    let plan: unknown;
    try {
      plan = JSON.parse(readFileSync(planPath, "utf-8"));
    } catch (err) {
      fail(`can't read plan ${planPath}: ${err instanceof Error ? err.message : err}`);
    }
    if (!Array.isArray(plan) || plan.length === 0) {
      fail(`plan must be a non-empty array of {branch, from, to, note?, finish?}.`);
    }
    windows = plan.map((entry, index) => {
      const { branch, from, to, note, finish: markDone } = entry ?? {};
      if (typeof branch !== "string" || from === undefined || to === undefined) {
        fail(`plan entry ${index} needs branch, from and to.`);
      }
      return {
        branch,
        from: when(String(from), repo?.root),
        to: when(String(to), repo?.root),
        note: typeof note === "string" ? note : undefined,
        finish: Boolean(markDone) || flag("finish"),
      };
    });
  } else {
    const [branch, from, to] = positionals();
    if (!branch || !from || !to) {
      fail(
        "usage: clauc backfill <branch> <from> <to> [--note text] [--finish]\n" +
          "       clauc backfill --plan plan.json\n" +
          "       (--from-branch main, --project path, --force)",
      );
    }
    windows = [
      {
        branch,
        from: when(from, repo?.root),
        to: when(to, repo?.root),
        note: option("note"),
        finish: flag("finish"),
      },
    ];
  }

  let results;
  try {
    results = backfill(windows, { projectPath, project, fromBranch, force: flag("force") });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const empty = results.filter((r) => r.moved === 0);
  const splits = results.reduce((sum, r) => sum + r.split, 0);
  console.log(
    `Carved ${plural(results.length, "window")} out of ${project}/${fromBranch}` +
      `${splits ? `, splitting ${plural(splits, "chunk")} at window edges` : ""}.`,
  );
  if (empty.length > 0) {
    console.log(
      `warning: no active time found for ${empty.map((r) => r.branch).join(", ")} — check the window bounds.`,
    );
  }

  console.log();
  const rows = [...windows.map((w) => w.branch), fromBranch]
    .map((branch) => getBranch(projectPath, branch))
    .filter((stat): stat is BranchStats => stat !== null);
  console.log(
    table(
      ["branch", "elapsed", "active", "prompts", "tools", "status"],
      rows.map((stat) => [
        truncate(stat.branch, 44),
        span(stat.lead_ms),
        duration(stat.active_ms),
        String(stat.prompts),
        String(stat.tool_calls),
        statusOf(stat),
      ]),
    ),
  );
}

/**
 * Label a branch across the prefix convention — `+frontend -infra`. Tags cut
 * reports sideways; they never feed estimates.
 */
function runTag(): void {
  const repo = resolveRepo(process.cwd());
  if (!repo) {
    fail("not a git repo.");
  }
  const args = positionals();
  const changes = args.filter((arg) => /^[+-]/.test(arg));
  const branch = args.find((arg) => !/^[+-]/.test(arg)) ?? repo.branch;

  const tags =
    changes.length > 0 ? setTags(repo.root, branch, changes) : tagsFor(repo.root, branch);
  console.log(
    `${repo.name}/${branch}: ${tags.length ? tags.join(", ") : "no tags"}` +
      (changes.length === 0 ? "  (add with +tag, drop with -tag)" : ""),
  );
}

function runTags(): void {
  const repo = scope();
  const rows = tagSummary(repo?.root);
  if (rows.length === 0) {
    console.log("clauc: no tags yet — `clauc tag +name` on a branch to start.");
    return;
  }
  console.log(
    table(
      ["tag", "branches", "active", "prompts"],
      rows.map((row) => [
        row.tag,
        String(row.branches),
        duration(row.active_ms),
        String(row.prompts),
      ]),
    ),
  );
}

/** Fold a phantom project (deleted cwd, symlinked package) into its real repo. */
function runMergeProject(): void {
  const [from, to = resolveRepo(process.cwd())?.root] = positionals();
  if (!from || !to) {
    fail(
      "usage: clauc merge-project <from-path> [to-path]\n" +
        "       (to-path defaults to the repo you're in — paths as `clauc projects` shows them)",
    );
  }
  if (from === to) fail("from and to are the same project.");

  const result = mergeProject(from, to);
  if (!result) {
    fail(`nothing tracked under ${from} — see \`clauc projects\` for exact paths.`);
  }
  console.log(
    `Moved ${plural(result.chunks, "chunk")} and ${plural(result.branches, "branch")} ` +
      `into ${basename(to)}` +
      `${result.merged ? ` (${result.merged} overlapping chunks coalesced)` : ""}.`,
  );
}

function help(): void {
  console.log(`clauc — how long a branch actually took

  clauc status              this branch: elapsed, active time, volume
  clauc report [--days N]   every branch in this repo   (--all: every project)
                            (--done: only finished, --tag X: only tagged X)
  clauc estimate            p50/p80 by branch kind — your planning numbers
  clauc finish [branch]     mark done  (--note "text", --at "2026-08-20 14:00")
  clauc reopen [branch]     undo that
  clauc sync                retire branches deleted from git
  clauc import              backfill from past Claude Code transcripts
                            (--dry-run, --days N, --force, --dir PATH)
  clauc backfill <branch> <from> <to>
                            carve tracked time out of main into a named branch
                            (--note, --finish, --from-branch, --project, --force;
                             times: ISO, ms epoch, or commit:<ref>)
  clauc backfill --plan p.json
                            same, batched: [{branch, from, to, note?, finish?}]
  clauc merge-project <from-path> [to-path]
                            fold a phantom project into its real repo
  clauc tag [branch] +x -y  label a branch; bare \`clauc tag\` shows labels
  clauc tags                active time rolled up per tag  (--all: every project)
  clauc projects            everything being tracked
  clauc where               db path and settings

Elapsed = calendar time first touch to last. Active = work chunks, split on
gaps over ${IDLE_MS / 60000} minutes.`);
}

switch (command) {
  case "import":
    await runImport();
    break;
  case "status":
    status();
    break;
  case "report":
  case "ls":
    report();
    break;
  case "estimate":
  case "est":
    estimate();
    break;
  case "finish":
  case "done":
    markFinished();
    break;
  case "reopen":
    markReopened();
    break;
  case "sync":
    sync();
    break;
  case "backfill":
    runBackfill();
    break;
  case "merge-project":
    runMergeProject();
    break;
  case "tag":
    runTag();
    break;
  case "tags":
    runTags();
    break;
  case "projects":
    projects();
    break;
  case "where":
    console.log(`db      ${DB_PATH}`);
    console.log(`idle    ${IDLE_MS / 60000} min  (CLAUC_IDLE_MINUTES)`);
    console.log(`stale   ${STALE_DAYS} days  (CLAUC_STALE_DAYS)`);
    break;
  default:
    help();
}
