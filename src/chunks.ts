import { IDLE_MS, LEAD_IN_MS } from "./config.ts";
import { db, type Chunk } from "./db.ts";

/**
 * The chunking rule lives here: beats less than IDLE_MS apart belong to one
 * chunk; a wider gap closes it and the next beat opens a new chunk, back-dated
 * by up to LEAD_IN_MS to credit the thinking that produced it. `track.beat`
 * applies the same rule incrementally in SQL for the live path — change the
 * rule in one place and the other must follow.
 */

/** One moment of activity, ready to be folded into chunks. */
export type Beat = {
  at: number;
  prompt: boolean;
  tool: boolean;
};

export type ChunkDraft = {
  started_at: number;
  ended_at: number;
  prompts: number;
  tool_calls: number;
};

/** A branch a bulk write touched, so `coalesce` knows where to look. */
export type BranchRef = {
  root: string;
  branch: string;
};

/** Fold one branch's beats, oldest first, into chunks. */
export function foldBeats(beats: Beat[]): ChunkDraft[] {
  const sorted = [...beats].sort((a, z) => a.at - z.at);

  const drafts: ChunkDraft[] = [];
  let open: ChunkDraft | null = null;
  for (const beat of sorted) {
    if (open && beat.at - open.ended_at <= IDLE_MS) {
      open.ended_at = beat.at;
      open.prompts += beat.prompt ? 1 : 0;
      open.tool_calls += beat.tool ? 1 : 0;
      continue;
    }

    // Back-date the chunk start, but never past the previous chunk's end.
    const gap: number = open ? beat.at - open.ended_at : Number.POSITIVE_INFINITY;
    open = {
      started_at: beat.at - Math.min(LEAD_IN_MS, gap),
      ended_at: beat.at,
      prompts: beat.prompt ? 1 : 0,
      tool_calls: beat.tool ? 1 : 0,
    };
    drafts.push(open);
  }

  return drafts;
}

/**
 * Collapse stored chunks that overlap or sit within the idle window of each
 * other. Imported history and live tracking can describe the same afternoon,
 * and resumed sessions repeat lines across transcripts. Both show up here as
 * chunks that should have been one. Returns how many rows were folded away.
 */
export function coalesce(branches: Iterable<BranchRef>): number {
  const conn = db();
  const remove = conn.prepare(`DELETE FROM chunks WHERE id = ?`);
  const rewrite = conn.prepare(
    `UPDATE chunks SET ended_at = ?, prompts = ?, tool_calls = ? WHERE id = ?`,
  );
  let removed = 0;

  for (const { root, branch } of dedupe(branches)) {
    const chunks = conn
      .query<Chunk, [string, string]>(
        `SELECT * FROM chunks
          WHERE project_path = ? AND branch = ?
          ORDER BY started_at ASC`,
      )
      .all(root, branch);

    let open: Chunk | null = null;
    for (const chunk of chunks) {
      if (open && chunk.started_at - open.ended_at <= IDLE_MS) {
        open.ended_at = Math.max(open.ended_at, chunk.ended_at);
        open.prompts += chunk.prompts;
        open.tool_calls += chunk.tool_calls;

        remove.run(chunk.id);
        rewrite.run(open.ended_at, open.prompts, open.tool_calls, open.id);
        removed++;
        continue;
      }
      open = chunk;
    }
  }

  return removed;
}

function dedupe(branches: Iterable<BranchRef>): BranchRef[] {
  const seen = new Map<string, BranchRef>();
  for (const ref of branches) {
    seen.set(`${ref.root}\0${ref.branch}`, ref);
  }
  return [...seen.values()];
}
