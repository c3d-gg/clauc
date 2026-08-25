import { basename } from "node:path";
import { coalesce, type BranchRef } from "./chunks.ts";
import { db, touchBranch, type Branch } from "./db.ts";

export type MergeResult = {
  chunks: number;
  branches: number;
  /** Chunks coalesced away where the two projects overlapped in time. */
  merged: number;
};

/**
 * Fold one tracked project into another — heals the phantom projects created
 * when a session's cwd (a scratch dir, a node_modules package) could no longer
 * be resolved to its repo root at import time.
 *
 * Chunks move wholesale. Branch rows merge by name: earliest first_seen wins,
 * latest last_seen wins, and a branch still open on either side stays open.
 * Overlapping chunks coalesce the same way import handles re-reads.
 */
export function mergeProject(fromPath: string, toPath: string): MergeResult | null {
  const conn = db();
  const project = basename(toPath);

  const sources = conn
    .query<Branch, [string]>(`SELECT * FROM branches WHERE project_path = ?`)
    .all(fromPath);
  const chunks =
    conn
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM chunks WHERE project_path = ?`)
      .get(fromPath)?.n ?? 0;
  if (sources.length === 0 && chunks === 0) return null;

  const touched: BranchRef[] = [];
  let merged = 0;

  conn.transaction(() => {
    conn
      .query(`UPDATE chunks SET project_path = ?, project = ? WHERE project_path = ?`)
      .run(toPath, project, fromPath);

    for (const source of sources) {
      touchBranch("merge", {
        projectPath: toPath,
        branch: source.branch,
        project,
        firstSeen: source.first_seen,
        lastSeen: source.last_seen,
        finishedAt: source.finished_at,
        note: source.note,
      });
      touched.push({ root: toPath, branch: source.branch });
    }

    // Tags follow their branches; rows that collide with an existing tag on
    // the target are simply dropped.
    conn
      .query(`UPDATE OR IGNORE branch_tags SET project_path = ? WHERE project_path = ?`)
      .run(toPath, fromPath);
    conn.query(`DELETE FROM branch_tags WHERE project_path = ?`).run(fromPath);

    conn.query(`DELETE FROM branches WHERE project_path = ?`).run(fromPath);
    merged = coalesce(touched);
  })();

  return { chunks, branches: sources.length, merged };
}
