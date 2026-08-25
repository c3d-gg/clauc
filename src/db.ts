import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { CLAUC_HOME, DB_PATH } from "./config.ts";

/**
 * One uninterrupted stretch of work on a branch. Beats stretch `ended_at`
 * forward; a gap wider than the idle window closes the chunk and the next beat
 * opens a new row. All timestamps are epoch ms.
 */
export type Chunk = {
  id: number;
  project: string;
  project_path: string;
  branch: string;
  started_at: number;
  ended_at: number;
  prompts: number;
  tool_calls: number;
};

/**
 * A NULL `finished_at` means the branch is still in progress; `clauc finish`
 * (or sync) sets it, and any new beat clears it again.
 */
export type Branch = {
  project: string;
  project_path: string;
  branch: string;
  first_seen: number;
  last_seen: number;
  finished_at: number | null;
  note: string | null;
};

/**
 * Every writer widens a branch's bounds the same way — earliest `first_seen`
 * wins, latest `last_seen` wins — but they disagree on what touching a branch
 * means for `finished_at` and `note`. Those disagreements are the policy,
 * kept side by side here instead of scattered as four hand-rolled upserts:
 *
 * - `live`    a new beat: work resumed, so the branch is no longer finished.
 * - `replay`  imported history: fills in bounds without reopening anything.
 * - `merge`   folding two rows into one: a branch still open on either side
 *             stays open, and an existing note survives.
 * - `window`  backfill: the window says outright whether the branch is done,
 *             and its note wins over whatever was there.
 */
const BRANCH_POLICIES = {
  live: `finished_at = NULL`,
  replay: `finished_at = branches.finished_at`,
  merge: `finished_at = CASE
            WHEN branches.finished_at IS NULL OR excluded.finished_at IS NULL THEN NULL
            ELSE MAX(branches.finished_at, excluded.finished_at)
          END,
          note = COALESCE(branches.note, excluded.note)`,
  window: `finished_at = excluded.finished_at,
           note = COALESCE(excluded.note, branches.note)`,
} as const;

export type BranchPolicy = keyof typeof BRANCH_POLICIES;

export type BranchTouch = {
  projectPath: string;
  branch: string;
  project: string;
  firstSeen: number;
  lastSeen: number;
  finishedAt?: number | null;
  note?: string | null;
};

export function touchBranch(policy: BranchPolicy, row: BranchTouch): void {
  db()
    .query(
      `INSERT INTO branches (project_path, branch, project, first_seen, last_seen, finished_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_path, branch) DO UPDATE SET
         project    = excluded.project,
         first_seen = MIN(branches.first_seen, excluded.first_seen),
         last_seen  = MAX(branches.last_seen,  excluded.last_seen),
         ${BRANCH_POLICIES[policy]}`,
    )
    .run(
      row.projectPath,
      row.branch,
      row.project,
      row.firstSeen,
      row.lastSeen,
      row.finishedAt ?? null,
      row.note ?? null,
    );
}

/**
 * Recompute a branch's bounds from the chunks that actually sit on it — the
 * repair step after a bulk rewrite (backfill) moves chunks between branches.
 * A branch with no chunks keeps its stored bounds.
 */
export function anchorBranch(projectPath: string, branch: string): void {
  db()
    .query(
      `UPDATE branches
          SET first_seen = COALESCE((SELECT MIN(started_at) FROM chunks
                                      WHERE project_path = ?1 AND branch = ?2), first_seen),
              last_seen  = COALESCE((SELECT MAX(ended_at) FROM chunks
                                      WHERE project_path = ?1 AND branch = ?2), last_seen)
        WHERE project_path = ?1 AND branch = ?2`,
    )
    .run(projectPath, branch);
}

let handle: Database | null = null;

export function db(): Database {
  if (handle) return handle;

  mkdirSync(CLAUC_HOME, { recursive: true });
  const conn = new Database(DB_PATH, { create: true });

  // Hooks fire concurrently and asynchronously, so several writers can land at
  // once. WAL plus a busy timeout keeps them from tripping over each other.
  conn.run("PRAGMA journal_mode = WAL");
  conn.run("PRAGMA busy_timeout = 5000");
  conn.run("PRAGMA synchronous = NORMAL");

  conn.run(`
    CREATE TABLE IF NOT EXISTS chunks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project      TEXT    NOT NULL,
      project_path TEXT    NOT NULL,
      branch       TEXT    NOT NULL,
      started_at   INTEGER NOT NULL,
      ended_at     INTEGER NOT NULL,
      prompts      INTEGER NOT NULL DEFAULT 0,
      tool_calls   INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS chunks_key
      ON chunks (project_path, branch, ended_at DESC);

    CREATE TABLE IF NOT EXISTS branches (
      project_path TEXT    NOT NULL,
      branch       TEXT    NOT NULL,
      project      TEXT    NOT NULL,
      first_seen   INTEGER NOT NULL,
      last_seen    INTEGER NOT NULL,
      finished_at  INTEGER,
      note         TEXT,
      PRIMARY KEY (project_path, branch)
    );

    CREATE TABLE IF NOT EXISTS branch_tags (
      project_path TEXT NOT NULL,
      branch       TEXT NOT NULL,
      tag          TEXT NOT NULL,
      PRIMARY KEY (project_path, branch, tag)
    );
  `);

  handle = conn;
  return conn;
}
