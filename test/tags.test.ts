import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const HOME = "/tmp/clauc-tags-unit";
process.env.CLAUC_HOME = HOME;

const { setTags, tagsFor, tagSummary } = await import("../src/tags.ts");
const { mergeProject } = await import("../src/merge.ts");
const { db } = await import("../src/db.ts");
const { listBranches } = await import("../src/report.ts");
const { beat } = await import("../src/track.ts");

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);
const repo = { root: "/repo/game", name: "game", branch: "feat/inventory" };

beforeEach(() => {
  db().run("DELETE FROM chunks; DELETE FROM branches; DELETE FROM branch_tags;");
});

afterEach(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("tags add and remove with +/-, normalized to lowercase", () => {
  expect(setTags(repo.root, repo.branch, ["+Frontend", "+ui"])).toEqual(["frontend", "ui"]);
  expect(setTags(repo.root, repo.branch, ["-ui", "+ui", "-ui"])).toEqual(["frontend"]);
  expect(tagsFor(repo.root, repo.branch)).toEqual(["frontend"]);
});

test("adding a tag twice keeps one row", () => {
  setTags(repo.root, repo.branch, ["+ui", "+ui"]);
  expect(tagsFor(repo.root, repo.branch)).toEqual(["ui"]);
});

test("tag summary rolls up active time across branches", () => {
  beat(repo, "prompt", T0);
  beat(repo, "tool", T0 + 10 * MIN);
  const other = { ...repo, branch: "fix/crash" };
  beat(other, "prompt", T0);
  beat(other, "tool", T0 + 20 * MIN);

  setTags(repo.root, repo.branch, ["+frontend"]);
  setTags(repo.root, other.branch, ["+frontend", "+urgent"]);

  const [frontend, urgent] = tagSummary(repo.root);
  expect(frontend).toMatchObject({ tag: "frontend", branches: 2 });
  expect(urgent).toMatchObject({ tag: "urgent", branches: 1 });
  expect(frontend!.active_ms).toBeGreaterThan(urgent!.active_ms);
});

test("report filters by tag", () => {
  beat(repo, "prompt", T0);
  beat({ ...repo, branch: "fix/crash" }, "prompt", T0);
  setTags(repo.root, repo.branch, ["+frontend"]);

  const rows = listBranches({ projectPath: repo.root, tag: "Frontend", includeFinished: true });
  expect(rows.map((row) => row.branch)).toEqual([repo.branch]);
});

test("merge-project carries tags along, dropping collisions", () => {
  beat(repo, "prompt", T0);
  const phantom = { root: "/repo/game/tools/codegen", name: "codegen", branch: repo.branch };
  beat(phantom, "prompt", T0 + 5 * MIN);
  setTags(repo.root, repo.branch, ["+frontend"]);
  setTags(phantom.root, phantom.branch, ["+frontend", "+codegen"]);

  mergeProject(phantom.root, repo.root);
  expect(tagsFor(repo.root, repo.branch)).toEqual(["codegen", "frontend"]);
  expect(tagsFor(phantom.root, phantom.branch)).toEqual([]);
});
