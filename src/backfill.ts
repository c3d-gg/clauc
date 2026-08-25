import { anchorBranch, db, touchBranch, type Chunk } from "./db.ts";

export type Piece = {
  started_at: number;
  ended_at: number;
  prompts: number;
  tool_calls: number;
  inside: boolean;
};

/** One window of already-tracked time to carve into a named branch. */
export type Window = {
  branch: string;
  from: number;
  to: number;
  note?: string;
  finish?: boolean;
};

export type WindowResult = {
  branch: string;
  /** Pieces that landed on the target branch. */
  moved: number;
  /** Source chunks that had to be cut at a window edge. */
  split: number;
};

export type BackfillOptions = {
  projectPath: string;
  project: string;
  fromBranch: string;
  force?: boolean;
};

/**
 * Cut a chunk at the edges of the half-open window [from, to). Prompt and
 * tool counts are prorated by piece duration and conserved exactly — the last
 * piece absorbs the rounding remainder, so splitting never invents or drops
 * a prompt.
 */
export function carve(
  chunk: Pick<Chunk, "started_at" | "ended_at" | "prompts" | "tool_calls">,
  from: number,
  to: number,
): Piece[] {
  const { started_at: start, ended_at: end } = chunk;

  // A zero-length chunk is a single instant: in or out, never split.
  if (end <= start) {
    return [
      {
        started_at: start,
        ended_at: end,
        prompts: chunk.prompts,
        tool_calls: chunk.tool_calls,
        inside: start >= from && start < to,
      },
    ];
  }

  const spans = [
    { started_at: start, ended_at: Math.min(end, from), inside: false },
    { started_at: Math.max(start, from), ended_at: Math.min(end, to), inside: true },
    { started_at: Math.max(start, to), ended_at: end, inside: false },
  ].filter((span) => span.ended_at > span.started_at);

  const total = end - start || 1;
  let prompts = chunk.prompts;
  let tools = chunk.tool_calls;

  return spans.map((span, index) => {
    const last = index === spans.length - 1;
    const share = (span.ended_at - span.started_at) / total;
    const p = last ? prompts : Math.min(prompts, Math.round(chunk.prompts * share));
    const t = last ? tools : Math.min(tools, Math.round(chunk.tool_calls * share));
    prompts -= p;
    tools -= t;
    return { ...span, prompts: p, tool_calls: t };
  });
}

/**
 * Retroactively carve windows of tracked time out of a source branch (usually
 * main) into named branches. A chunk that overlaps a window edge is split
 * there — assigning whole chunks by start time silently zeroes any window that
 * falls inside one long evening chunk. Windows run in order, so a chunk
 * spanning several sequential windows is re-cut by each in turn.
 *
 * Everything happens in one transaction: a failed window leaves the db as it
 * was.
 */
export function backfill(windows: Window[], opts: BackfillOptions): WindowResult[] {
  const conn = db();
  const results: WindowResult[] = [];

  const overlapping = conn.prepare<Chunk, [string, string, number, number]>(
    `SELECT * FROM chunks
      WHERE project_path = ? AND branch = ?
        AND started_at < ? AND ended_at >= ?
      ORDER BY started_at ASC`,
  );
  const chunkCount = conn.prepare<{ n: number }, [string, string]>(
    `SELECT COUNT(*) AS n FROM chunks WHERE project_path = ? AND branch = ?`,
  );
  const removeChunk = conn.prepare(`DELETE FROM chunks WHERE id = ?`);
  const insertChunk = conn.prepare(
    `INSERT INTO chunks (project, project_path, branch, started_at, ended_at, prompts, tool_calls)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  conn.transaction(() => {
    for (const window of windows) {
      if (!(window.to > window.from)) {
        throw new Error(`${window.branch}: window is empty — from must be before to`);
      }
      if (window.branch === opts.fromBranch) {
        throw new Error(`${window.branch}: cannot carve a branch out of itself`);
      }
      if (!opts.force && (chunkCount.get(opts.projectPath, window.branch)?.n ?? 0) > 0) {
        throw new Error(
          `${window.branch} already has tracked chunks — pass --force to carve into it anyway`,
        );
      }

      let moved = 0;
      let split = 0;
      for (const chunk of overlapping.all(
        opts.projectPath,
        opts.fromBranch,
        window.to,
        window.from,
      )) {
        const pieces = carve(chunk, window.from, window.to);
        if (!pieces.some((piece) => piece.inside)) continue;

        removeChunk.run(chunk.id);
        if (pieces.length > 1) split++;
        for (const piece of pieces) {
          insertChunk.run(
            opts.project,
            opts.projectPath,
            piece.inside ? window.branch : opts.fromBranch,
            piece.started_at,
            piece.ended_at,
            piece.prompts,
            piece.tool_calls,
          );
          if (piece.inside) moved++;
        }
      }

      touchBranch("window", {
        projectPath: opts.projectPath,
        branch: window.branch,
        project: opts.project,
        firstSeen: window.from,
        lastSeen: window.to,
        finishedAt: window.finish ? window.to : null,
        note: window.note,
      });
      results.push({ branch: window.branch, moved, split });
    }

    // Both sides may now hold different chunks than their rows claim — the
    // source lost its earliest or latest, a --force target gained some outside
    // its old bounds. Re-anchor everyone to the chunks that actually remain.
    for (const branch of [opts.fromBranch, ...windows.map((w) => w.branch)]) {
      anchorBranch(opts.projectPath, branch);
    }
  })();

  return results;
}
