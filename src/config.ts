import { homedir } from "node:os";
import { join } from "node:path";

/** Where the sqlite file lives. Override with CLAUC_HOME for testing. */
export const CLAUC_HOME = process.env.CLAUC_HOME ?? join(homedir(), ".clauc");
export const DB_PATH = join(CLAUC_HOME, "clauc.db");

/**
 * A gap longer than this ends the current work chunk. Anything shorter counts
 * as "still working".
 *
 * Wider than an editor tracker's window on purpose: beats here come from
 * prompts and tool calls, and the quiet stretches between them — reading a long
 * response, clicking through the change in a browser — are still work on the
 * branch.
 */
export const IDLE_MS =
  Number(process.env.CLAUC_IDLE_MINUTES ?? 30) * 60 * 1000;

/**
 * Work that led up to a beat but produced no earlier beat. Without this a lone
 * beat would be a zero-length chunk, and a session of sparse, thoughtful
 * prompts would report no time at all.
 */
export const LEAD_IN_MS =
  Number(process.env.CLAUC_LEAD_IN_MINUTES ?? 2) * 60 * 1000;

/** A branch untouched for this long shows as `stale` in reports. */
export const STALE_DAYS = Number(process.env.CLAUC_STALE_DAYS ?? 14);

export const DEBUG = process.env.CLAUC_DEBUG === "1";
