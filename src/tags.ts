import { db } from "./db.ts";

/** Tags are labels across branches — "frontend", "infra" — for report cuts
 *  that branch prefixes can't express. They never feed estimates. */

function normalize(tag: string): string {
  return tag.toLowerCase().replace(/^[+-]/, "");
}

export function tagsFor(projectPath: string, branch: string): string[] {
  return db()
    .query<{ tag: string }, [string, string]>(
      `SELECT tag FROM branch_tags WHERE project_path = ? AND branch = ? ORDER BY tag`,
    )
    .all(projectPath, branch)
    .map((row) => row.tag);
}

/** Apply +tag / -tag changes and return the tags left on the branch. */
export function setTags(projectPath: string, branch: string, changes: string[]): string[] {
  const conn = db();
  const add = conn.prepare(
    `INSERT OR IGNORE INTO branch_tags (project_path, branch, tag) VALUES (?, ?, ?)`,
  );
  const remove = conn.prepare(
    `DELETE FROM branch_tags WHERE project_path = ? AND branch = ? AND tag = ?`,
  );

  conn.transaction(() => {
    for (const change of changes) {
      const tag = normalize(change);
      if (!tag) continue;
      if (change.startsWith("-")) remove.run(projectPath, branch, tag);
      else add.run(projectPath, branch, tag);
    }
  })();

  return tagsFor(projectPath, branch);
}

export type TagStats = {
  tag: string;
  branches: number;
  active_ms: number;
  prompts: number;
};

/** Active time rolled up per tag — "how much goes to things tagged Y". */
export function tagSummary(projectPath?: string): TagStats[] {
  // Chunks are aggregated per branch first, so each tag row joins at most one
  // totals row and COUNT(*) is the branch count — no multi-column DISTINCT.
  return db()
    .query<TagStats, (string | null)[]>(
      `SELECT
         t.tag,
         COUNT(*)                          AS branches,
         COALESCE(SUM(totals.active_ms), 0) AS active_ms,
         COALESCE(SUM(totals.prompts), 0)   AS prompts
       FROM branch_tags t
       LEFT JOIN (
         SELECT project_path, branch,
                SUM(ended_at - started_at) AS active_ms,
                SUM(prompts)               AS prompts
           FROM chunks GROUP BY project_path, branch
       ) totals
         ON totals.project_path = t.project_path AND totals.branch = t.branch
       WHERE ?1 IS NULL OR t.project_path = ?1
       GROUP BY t.tag
       ORDER BY active_ms DESC`,
    )
    .all(projectPath ?? null);
}
