import { spawnSync } from "node:child_process";
import { basename } from "node:path";

function git(cwd: string, ...args: string[]): string | null {
  const out = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 2000,
    windowsHide: true,
  });
  if (out.status !== 0) return null;
  const value = out.stdout?.trim();
  return value ? value : null;
}

export type Repo = {
  /** Absolute path to the repo root, or the cwd when not a repo. */
  root: string;
  /** Display name — the repo folder name. */
  name: string;
  branch: string;
};

/**
 * Resolve the tracking key for a directory. Detached HEAD becomes
 * `detached@<sha>` and a non-repo folder becomes `(no-branch)` so those
 * sessions still land somewhere instead of being silently dropped.
 */
export function resolveRepo(cwd: string): Repo | null {
  const root = git(cwd, "rev-parse", "--show-toplevel");
  if (!root) return null;

  let branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  if (!branch || branch === "HEAD") {
    const sha = git(cwd, "rev-parse", "--short", "HEAD");
    branch = sha ? `detached@${sha}` : "(no-branch)";
  }

  return { root, name: basename(root), branch };
}

/** Commit timestamp in ms, for `commit:<ref>` time bounds. */
export function commitTime(root: string, ref: string): number | null {
  const out = git(root, "show", "-s", "--format=%ct", ref);
  if (!out) return null;
  const seconds = Number(out.split("\n").pop());
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/** Branch names that still exist locally. Used to retire deleted branches. */
export function listLocalBranches(root: string): Set<string> {
  const out = git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads");
  return new Set(out ? out.split("\n") : []);
}
