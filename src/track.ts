import { IDLE_MS, LEAD_IN_MS } from "./config.ts";
import { db, touchBranch, type Chunk } from "./db.ts";
import type { Repo } from "./git.ts";

export type BeatKind = "prompt" | "tool" | "ping";

/**
 * Record one moment of activity on a branch.
 *
 * Activity arrives as a stream of unevenly spaced beats, so time is measured by
 * stretching the current chunk's end forward. A gap wider than IDLE_MS means we
 * walked away, and the next beat opens a fresh chunk instead — that gap is
 * never billed as work, minus a short lead-in for the thinking that produced
 * the beat.
 */
export function beat(repo: Repo, kind: BeatKind, now: number = Date.now()): void {
  const conn = db();

  const last = conn
    .query<Chunk, [string, string]>(
      `SELECT * FROM chunks
        WHERE project_path = ? AND branch = ?
        ORDER BY ended_at DESC
        LIMIT 1`,
    )
    .get(repo.root, repo.branch);

  const prompts = kind === "prompt" ? 1 : 0;
  const tools = kind === "tool" ? 1 : 0;

  if (last && now - last.ended_at <= IDLE_MS && now >= last.started_at) {
    conn
      .query(
        `UPDATE chunks
            SET ended_at = ?, prompts = prompts + ?, tool_calls = tool_calls + ?
          WHERE id = ?`,
      )
      .run(Math.max(now, last.ended_at), prompts, tools, last.id);
  } else {
    // Back-date the chunk start, but never past the previous chunk's end.
    const gap = last ? now - last.ended_at : Number.POSITIVE_INFINITY;
    const startedAt = now - Math.min(LEAD_IN_MS, gap);

    conn
      .query(
        `INSERT INTO chunks
           (project, project_path, branch, started_at, ended_at, prompts, tool_calls)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(repo.name, repo.root, repo.branch, startedAt, now, prompts, tools);
  }

  // Re-opening a branch clears finished_at: work resumed, so it isn't done.
  touchBranch("live", {
    projectPath: repo.root,
    branch: repo.branch,
    project: repo.name,
    firstSeen: now,
    lastSeen: now,
  });
}

/** Explicitly close a branch out, so it counts toward estimates. */
export function finish(
  projectPath: string,
  branch: string,
  note?: string,
  now: number = Date.now(),
): boolean {
  const result = db()
    .query(
      `UPDATE branches
          SET finished_at = ?, note = COALESCE(?, note)
        WHERE project_path = ? AND branch = ?`,
    )
    .run(now, note ?? null, projectPath, branch);
  return result.changes > 0;
}

export function reopen(projectPath: string, branch: string): boolean {
  const result = db()
    .query(
      `UPDATE branches SET finished_at = NULL
        WHERE project_path = ? AND branch = ?`,
    )
    .run(projectPath, branch);
  return result.changes > 0;
}
