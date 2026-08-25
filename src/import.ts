import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { coalesce, foldBeats, type BranchRef } from "./chunks.ts";
import { db, touchBranch } from "./db.ts";
import { resolveRepo } from "./git.ts";

/** One moment of activity recovered from a transcript. */
type Event = {
  at: number;
  root: string;
  project: string;
  branch: string;
  prompt: boolean;
  tool: boolean;
};

type Draft = {
  project: string;
  root: string;
  branch: string;
  started_at: number;
  ended_at: number;
  prompts: number;
  tool_calls: number;
};

export type ImportResult = {
  files: number;
  skipped: number;
  events: number;
  chunks: number;
  merged: number;
  branches: { project: string; branch: string; from: number; to: number }[];
};

export type ImportOptions = {
  /** Transcript root, defaults to ~/.claude/projects. */
  dir: string;
  /** Re-read files that were imported before. */
  force?: boolean;
  /** Ignore transcript lines older than this many days. */
  sinceDays?: number;
  /** Parse and report, but write nothing. */
  dryRun?: boolean;
  onProgress?: (done: number, total: number) => void;
};

/**
 * Records which transcripts have been consumed. Transcripts grow as sessions
 * continue, so a file is re-read only when its size changes.
 */
function ensureLedger(): void {
  db().run(`
    CREATE TABLE IF NOT EXISTS imports (
      path        TEXT PRIMARY KEY,
      imported_at INTEGER NOT NULL,
      size        INTEGER NOT NULL,
      events      INTEGER NOT NULL
    );
  `);
}

/**
 * Map a session's cwd to the repo root, so imported history keys the same way
 * live tracking does. Directories that no longer exist fall back to the cwd.
 */
function makeRootResolver() {
  const cache = new Map<string, { root: string; project: string }>();
  return (cwd: string) => {
    const hit = cache.get(cwd);
    if (hit) return hit;

    // A cwd that has since been deleted (scratch dirs, symlinked node_modules
    // packages) can't answer git queries, which used to strand its sessions as
    // a phantom project. The nearest surviving ancestor almost always resolves
    // to the repo the session actually ran in.
    let probe = cwd;
    while (probe !== "/" && probe.includes("/") && !existsSync(probe)) {
      probe = dirname(probe);
    }

    const repo = resolveRepo(probe);
    const resolved = repo
      ? { root: repo.root, project: repo.name }
      : { root: cwd, project: cwd.split("/").filter(Boolean).pop() ?? cwd };

    cache.set(cwd, resolved);
    return resolved;
  };
}

type Line = {
  type?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  promptSource?: string;
  toolUseResult?: unknown;
};

async function readEvents(
  path: string,
  rootOf: ReturnType<typeof makeRootResolver>,
  floor: number,
): Promise<Event[]> {
  const events: Event[] = [];
  const stream = Bun.file(path).stream();
  const decoder = new TextDecoder();
  let buffer = "";

  const take = (raw: string) => {
    if (!raw.trim()) return;

    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      return; // a partially written trailing line
    }

    // Session metadata lines carry no time or place, so there is nothing to
    // attribute them to. A literal "HEAD" is what gets recorded when the cwd
    // is not a repo at all, which is not a branch worth tracking.
    if (!line.timestamp || !line.cwd || !line.gitBranch) return;
    if (line.gitBranch === "HEAD") return;

    const at = Date.parse(line.timestamp);
    if (Number.isNaN(at) || at < floor) return;

    const { root, project } = rootOf(line.cwd);
    events.push({
      at,
      root,
      project,
      branch: line.gitBranch,
      prompt: line.type === "user" && line.promptSource === "typed",
      tool: line.toolUseResult !== undefined,
    });
  };

  for await (const bytes of stream) {
    buffer += decoder.decode(bytes as Uint8Array, { stream: true });
    let cut = buffer.indexOf("\n");
    while (cut >= 0) {
      take(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf("\n");
    }
  }
  take(buffer);

  return events;
}

/**
 * Group key for a branch's beats within this import pass. NUL-separated — a
 * byte that can't appear in a path or branch name, unlike a space.
 */
function chunkKey(root: string, branch: string): string {
  return `${root}\0${branch}`;
}

/** Same rule the live tracker uses, applied to a whole history at once. */
function toChunks(events: Event[]): Draft[] {
  const byBranch = new Map<string, Event[]>();
  for (const event of events) {
    const key = chunkKey(event.root, event.branch);
    const bucket = byBranch.get(key);
    if (bucket) bucket.push(event);
    else byBranch.set(key, [event]);
  }

  const drafts: Draft[] = [];
  for (const bucket of byBranch.values()) {
    const { root, project, branch } = bucket[0]!;
    for (const chunk of foldBeats(bucket)) {
      drafts.push({ root, project, branch, ...chunk });
    }
  }

  return drafts;
}

export async function importTranscripts(
  options: ImportOptions,
): Promise<ImportResult> {
  ensureLedger();
  const conn = db();
  const rootOf = makeRootResolver();

  const floor = options.sinceDays
    ? Date.now() - options.sinceDays * 24 * 60 * 60 * 1000
    : 0;

  // Subagent transcripts sit a level deeper, under <session>/subagents/, and
  // that is real work on the branch too.
  const paths = [
    ...new Bun.Glob("**/*.jsonl").scanSync({ cwd: options.dir, absolute: true }),
  ].sort();

  const result: ImportResult = {
    files: 0,
    skipped: 0,
    events: 0,
    chunks: 0,
    merged: 0,
    branches: [],
  };

  const seen = conn
    .query<{ path: string; size: number }, []>(`SELECT path, size FROM imports`)
    .all();
  const sizes = new Map(seen.map((row) => [row.path, row.size]));

  const drafts: Draft[] = [];
  const ledger: [string, number, number][] = [];

  for (const [index, path] of paths.entries()) {
    options.onProgress?.(index + 1, paths.length);

    const size = Bun.file(path).size;
    if (!options.force && sizes.get(path) === size) {
      result.skipped++;
      continue;
    }

    const events = await readEvents(path, rootOf, floor);
    result.files++;
    result.events += events.length;
    drafts.push(...toChunks(events));
    ledger.push([path, size, events.length]);
  }

  if (options.dryRun) {
    result.chunks = drafts.length;
    result.branches = summarize(drafts);
    return result;
  }

  const touched = new Map<string, BranchRef>();
  const insert = conn.prepare(
    `INSERT INTO chunks
       (project, project_path, branch, started_at, ended_at, prompts, tool_calls)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const remember = conn.prepare(
    `INSERT INTO imports (path, imported_at, size, events)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (path) DO UPDATE SET
       imported_at = excluded.imported_at,
       size        = excluded.size,
       events      = excluded.events`,
  );

  // One transaction: a half-finished import would leave the ledger claiming
  // files were read that produced no chunks.
  conn.transaction(() => {
    for (const draft of drafts) {
      insert.run(
        draft.project,
        draft.root,
        draft.branch,
        draft.started_at,
        draft.ended_at,
        draft.prompts,
        draft.tool_calls,
      );
      touchBranch("replay", {
        projectPath: draft.root,
        branch: draft.branch,
        project: draft.project,
        firstSeen: draft.started_at,
        lastSeen: draft.ended_at,
      });
      touched.set(chunkKey(draft.root, draft.branch), {
        root: draft.root,
        branch: draft.branch,
      });
    }

    const now = Date.now();
    for (const [path, size, events] of ledger) {
      remember.run(path, now, size, events);
    }

    result.merged = coalesce(touched.values());
  })();

  result.chunks = drafts.length - result.merged;
  result.branches = summarize(drafts);
  return result;
}

function summarize(drafts: Draft[]): ImportResult["branches"] {
  const byBranch = new Map<string, ImportResult["branches"][number]>();
  for (const draft of drafts) {
    const key = chunkKey(draft.root, draft.branch);
    const hit = byBranch.get(key);
    if (hit) {
      hit.from = Math.min(hit.from, draft.started_at);
      hit.to = Math.max(hit.to, draft.ended_at);
    } else {
      byBranch.set(key, {
        project: draft.project,
        branch: draft.branch,
        from: draft.started_at,
        to: draft.ended_at,
      });
    }
  }
  return [...byBranch.values()].sort((a, z) => z.to - a.to);
}
