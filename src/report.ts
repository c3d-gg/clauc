import { db } from "./db.ts";

export type BranchStats = {
  project: string;
  project_path: string;
  branch: string;
  first_seen: number;
  last_seen: number;
  finished_at: number | null;
  note: string | null;
  /** Sum of chunk durations — time actually spent working. */
  active_ms: number;
  /** first_seen to last_seen (or finished_at) — calendar time elapsed. */
  lead_ms: number;
  chunks: number;
  prompts: number;
  tool_calls: number;
  /** Distinct calendar days touched, in local time. */
  days_touched: number;
};

type Row = Omit<BranchStats, "lead_ms">;

const STATS_SQL = `
  SELECT
    b.project,
    b.project_path,
    b.branch,
    b.first_seen,
    b.last_seen,
    b.finished_at,
    b.note,
    COALESCE(SUM(c.ended_at - c.started_at), 0) AS active_ms,
    COUNT(c.id)                                 AS chunks,
    COALESCE(SUM(c.prompts), 0)                 AS prompts,
    COALESCE(SUM(c.tool_calls), 0)              AS tool_calls,
    COUNT(DISTINCT date(c.started_at / 1000, 'unixepoch', 'localtime')) AS days_touched
  FROM branches b
  LEFT JOIN chunks c
    ON c.project_path = b.project_path AND c.branch = b.branch
`;

function withLead(row: Row): BranchStats {
  return {
    ...row,
    lead_ms: Math.max(0, (row.finished_at ?? row.last_seen) - row.first_seen),
  };
}

export type ListFilter = {
  projectPath?: string;
  /** Only branches touched within this many days. */
  since?: number;
  includeFinished?: boolean;
  onlyFinished?: boolean;
  /** Only branches carrying this tag. */
  tag?: string;
};

export function listBranches(filter: ListFilter = {}): BranchStats[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filter.projectPath) {
    where.push("b.project_path = ?");
    params.push(filter.projectPath);
  }
  if (filter.since !== undefined) {
    where.push("b.last_seen >= ?");
    params.push(Date.now() - filter.since * 24 * 60 * 60 * 1000);
  }
  if (filter.tag) {
    where.push(
      `EXISTS (SELECT 1 FROM branch_tags t
                WHERE t.project_path = b.project_path
                  AND t.branch = b.branch AND t.tag = ?)`,
    );
    params.push(filter.tag.toLowerCase());
  }
  if (filter.onlyFinished) where.push("b.finished_at IS NOT NULL");
  else if (!filter.includeFinished) where.push("b.finished_at IS NULL");

  const sql = [
    STATS_SQL,
    where.length ? `WHERE ${where.join(" AND ")}` : "",
    "GROUP BY b.project_path, b.branch",
    "ORDER BY b.last_seen DESC",
  ]
    .filter(Boolean)
    .join("\n");

  return db().query<Row, typeof params>(sql).all(...params).map(withLead);
}

export function getBranch(projectPath: string, branch: string): BranchStats | null {
  const sql = `${STATS_SQL}
    WHERE b.project_path = ? AND b.branch = ?
    GROUP BY b.project_path, b.branch`;
  const row = db().query<Row, [string, string]>(sql).get(projectPath, branch);
  return row ? withLead(row) : null;
}

/** Active ms on a branch since a wall-clock instant, for "today" style numbers. */
export function activeSince(
  projectPath: string,
  branch: string,
  from: number,
): number {
  const row = db()
    .query<{ ms: number }, [number, string, string, number]>(
      `SELECT COALESCE(SUM(ended_at - MAX(started_at, ?)), 0) AS ms
         FROM chunks
        WHERE project_path = ? AND branch = ? AND ended_at >= ?`,
    )
    .get(from, projectPath, branch, from);
  return row?.ms ?? 0;
}

export function startOfToday(now: number = Date.now()): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Branch prefix used to group similar work: `feat/login` -> `feat`,
 * `AIR-123-fix-thing` -> `AIR`. Falls back to `other` when there's no
 * convention to lean on.
 */
export function categorize(branch: string): string {
  const slash = branch.indexOf("/");
  if (slash > 0) return branch.slice(0, slash).toLowerCase();

  const ticket = branch.match(/^([A-Z]{2,10})-\d+/);
  if (ticket) return ticket[1]!;

  const word = branch.match(/^([a-z]+)[-_]/);
  if (word) return word[1]!;

  return "other";
}

export type Estimate = {
  category: string;
  count: number;
  medianLeadMs: number;
  p80LeadMs: number;
  medianActiveMs: number;
  p80ActiveMs: number;
  medianPrompts: number;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

/**
 * Turn finished branches into planning numbers. Median is the typical case,
 * p80 is the number worth quoting out loud — it absorbs the branch that went
 * sideways, which is exactly the one memory keeps forgetting.
 */
export function estimates(branches: BranchStats[]): Estimate[] {
  const groups = new Map<string, BranchStats[]>();
  for (const b of branches) {
    const key = categorize(b.branch);
    const bucket = groups.get(key);
    if (bucket) bucket.push(b);
    else groups.set(key, [b]);
  }

  const numbers = (list: BranchStats[], pick: (b: BranchStats) => number) =>
    list.map(pick).sort((a, z) => a - z);

  return [...groups.entries()]
    .map(([category, list]) => {
      const lead = numbers(list, (b) => b.lead_ms);
      const active = numbers(list, (b) => b.active_ms);
      const prompts = numbers(list, (b) => b.prompts);
      return {
        category,
        count: list.length,
        medianLeadMs: percentile(lead, 0.5),
        p80LeadMs: percentile(lead, 0.8),
        medianActiveMs: percentile(active, 0.5),
        p80ActiveMs: percentile(active, 0.8),
        medianPrompts: percentile(prompts, 0.5),
      };
    })
    .sort((a, z) => z.count - a.count);
}
