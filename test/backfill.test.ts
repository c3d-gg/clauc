import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const HOME = "/tmp/clauc-backfill-unit";
process.env.CLAUC_HOME = HOME;

const { backfill, carve } = await import("../src/backfill.ts");
const { mergeProject } = await import("../src/merge.ts");
const { db } = await import("../src/db.ts");
const { getBranch } = await import("../src/report.ts");

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 0, 1, 18, 0, 0); // an evening on main
const GAME = { projectPath: "/repo/game", project: "game", fromBranch: "main" };

function seed(
  branch: string,
  start: number,
  end: number,
  prompts = 0,
  tools = 0,
  path = GAME.projectPath,
): void {
  const project = path.split("/").pop()!;
  db()
    .query(
      `INSERT INTO chunks (project, project_path, branch, started_at, ended_at, prompts, tool_calls)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(project, path, branch, start, end, prompts, tools);
  db()
    .query(
      `INSERT INTO branches (project_path, branch, project, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_path, branch) DO UPDATE SET
         first_seen = MIN(first_seen, excluded.first_seen),
         last_seen  = MAX(last_seen,  excluded.last_seen)`,
    )
    .run(path, branch, project, start, end);
}

beforeEach(() => {
  db().run("DELETE FROM chunks; DELETE FROM branches;");
});

afterEach(() => {
  rmSync(HOME, { recursive: true, force: true });
});

// --- carve: the splitting math ---

test("a chunk fully inside the window moves whole", () => {
  const pieces = carve(
    { started_at: T0, ended_at: T0 + HOUR, prompts: 4, tool_calls: 10 },
    T0 - HOUR,
    T0 + 2 * HOUR,
  );
  expect(pieces).toHaveLength(1);
  expect(pieces[0]).toMatchObject({ inside: true, prompts: 4, tool_calls: 10 });
});

test("a chunk spanning one edge splits in two, counts prorated", () => {
  // [18:00, 19:00] against window starting 18:30 — a clean 50/50 cut.
  const pieces = carve(
    { started_at: T0, ended_at: T0 + HOUR, prompts: 4, tool_calls: 10 },
    T0 + 30 * MIN,
    T0 + 5 * HOUR,
  );
  expect(pieces).toHaveLength(2);
  expect(pieces[0]).toMatchObject({
    started_at: T0,
    ended_at: T0 + 30 * MIN,
    inside: false,
    prompts: 2,
    tool_calls: 5,
  });
  expect(pieces[1]).toMatchObject({
    started_at: T0 + 30 * MIN,
    ended_at: T0 + HOUR,
    inside: true,
    prompts: 2,
    tool_calls: 5,
  });
});

test("a chunk spanning the whole window splits in three", () => {
  const pieces = carve(
    { started_at: T0, ended_at: T0 + 3 * HOUR, prompts: 3, tool_calls: 9 },
    T0 + HOUR,
    T0 + 2 * HOUR,
  );
  expect(pieces.map((p) => p.inside)).toEqual([false, true, false]);
  expect(pieces.map((p) => p.prompts)).toEqual([1, 1, 1]);
  expect(pieces.map((p) => p.tool_calls)).toEqual([3, 3, 3]);
});

test("proration conserves counts even when rounding is lumpy", () => {
  // 55/5 minute split of a single prompt: rounding alone would bill it twice.
  const pieces = carve(
    { started_at: T0, ended_at: T0 + HOUR, prompts: 1, tool_calls: 7 },
    T0 + 55 * MIN,
    T0 + 2 * HOUR,
  );
  expect(pieces.reduce((sum, p) => sum + p.prompts, 0)).toBe(1);
  expect(pieces.reduce((sum, p) => sum + p.tool_calls, 0)).toBe(7);
});

test("a zero-length chunk is a single instant: in or out, never split", () => {
  const lone = { started_at: T0, ended_at: T0, prompts: 1, tool_calls: 0 };
  expect(carve(lone, T0, T0 + HOUR)).toMatchObject([{ inside: true, prompts: 1 }]);
  expect(carve(lone, T0 + 1, T0 + HOUR)).toMatchObject([{ inside: false, prompts: 1 }]);
});

// --- backfill: windows against the db ---

test("an idle-spanning evening chunk yields time to a window inside it", () => {
  // The failure mode that motivated splitting: one 5-hour chunk covering the
  // whole evening, and a 2-hour lesson carved out of the middle of it.
  seed("main", T0, T0 + 5 * HOUR, 10, 20);

  const [result] = backfill(
    [{ branch: "lesson/01", from: T0 + HOUR, to: T0 + 3 * HOUR }],
    GAME,
  );
  expect(result!.moved).toBe(1);
  expect(result!.split).toBe(1);

  expect(getBranch(GAME.projectPath, "lesson/01")!.active_ms).toBe(2 * HOUR);
  expect(getBranch(GAME.projectPath, "main")!.active_ms).toBe(3 * HOUR);
  expect(getBranch(GAME.projectPath, "main")!.prompts).toBe(6);
  expect(getBranch(GAME.projectPath, "lesson/01")!.prompts).toBe(4);
});

test("a chunk spanning multiple windows in batch mode is re-cut by each", () => {
  seed("main", T0, T0 + 4 * HOUR, 8, 0);

  backfill(
    [
      { branch: "lesson/01", from: T0, to: T0 + HOUR, finish: true },
      { branch: "lesson/02", from: T0 + HOUR, to: T0 + 3 * HOUR, finish: true },
    ],
    GAME,
  );

  expect(getBranch(GAME.projectPath, "lesson/01")!.active_ms).toBe(HOUR);
  expect(getBranch(GAME.projectPath, "lesson/02")!.active_ms).toBe(2 * HOUR);
  expect(getBranch(GAME.projectPath, "main")!.active_ms).toBe(HOUR);
  expect(getBranch(GAME.projectPath, "lesson/01")!.finished_at).toBe(T0 + HOUR);
  expect(getBranch(GAME.projectPath, "lesson/02")!.finished_at).toBe(T0 + 3 * HOUR);

  const total =
    getBranch(GAME.projectPath, "lesson/01")!.prompts +
    getBranch(GAME.projectPath, "lesson/02")!.prompts +
    getBranch(GAME.projectPath, "main")!.prompts;
  expect(total).toBe(8);
});

test("chunks outside the window stay on the source branch untouched", () => {
  seed("main", T0 - 5 * HOUR, T0 - 4 * HOUR, 3, 3);
  seed("main", T0, T0 + HOUR, 2, 2);

  backfill([{ branch: "lesson/01", from: T0, to: T0 + 2 * HOUR }], GAME);

  const main = getBranch(GAME.projectPath, "main")!;
  expect(main.active_ms).toBe(HOUR);
  expect(main.prompts).toBe(3);
  expect(getBranch(GAME.projectPath, "lesson/01")!.active_ms).toBe(HOUR);
});

test("carving out the earliest chunk re-anchors the source branch bounds", () => {
  seed("main", T0, T0 + HOUR);
  seed("main", T0 + 5 * HOUR, T0 + 6 * HOUR);

  backfill([{ branch: "lesson/01", from: T0 - HOUR, to: T0 + 2 * HOUR }], GAME);

  const main = getBranch(GAME.projectPath, "main")!;
  expect(main.first_seen).toBe(T0 + 5 * HOUR);
  expect(main.last_seen).toBe(T0 + 6 * HOUR);
});

test("refuses to carve into a branch that already has chunks, unless forced", () => {
  seed("main", T0, T0 + 2 * HOUR);
  seed("lesson/01", T0 - 3 * HOUR, T0 - 2 * HOUR);

  expect(() =>
    backfill([{ branch: "lesson/01", from: T0, to: T0 + HOUR }], GAME),
  ).toThrow(/--force/);

  backfill([{ branch: "lesson/01", from: T0, to: T0 + HOUR }], { ...GAME, force: true });
  expect(getBranch(GAME.projectPath, "lesson/01")!.active_ms).toBe(2 * HOUR);
});

test("a window with no tracked activity reports zero moved pieces", () => {
  seed("main", T0, T0 + HOUR);
  const [result] = backfill(
    [{ branch: "lesson/01", from: T0 + 6 * HOUR, to: T0 + 7 * HOUR }],
    GAME,
  );
  expect(result!.moved).toBe(0);
  expect(getBranch(GAME.projectPath, "lesson/01")!.active_ms).toBe(0);
});

// --- merge-project: healing phantom projects ---

test("merge-project folds a phantom subdirectory project into the repo", () => {
  seed("main", T0, T0 + HOUR, 2, 2);
  seed("main", T0 + 20 * MIN, T0 + 90 * MIN, 1, 1, "/repo/game/node_modules/@tuiparts/react");

  const result = mergeProject("/repo/game/node_modules/@tuiparts/react", GAME.projectPath)!;
  expect(result.chunks).toBe(1);
  expect(result.branches).toBe(1);
  expect(result.merged).toBe(1); // the overlapping chunks coalesced into one

  const main = getBranch(GAME.projectPath, "main")!;
  expect(main.chunks).toBe(1);
  expect(main.active_ms).toBe(90 * MIN);
  expect(main.prompts).toBe(3);
  expect(getBranch("/repo/game/node_modules/@tuiparts/react", "main")).toBeNull();
});

test("merging keeps a branch open when either side is still open", () => {
  seed("main", T0, T0 + HOUR);
  db()
    .query(`UPDATE branches SET finished_at = ? WHERE project_path = ?`)
    .run(T0 + HOUR, GAME.projectPath);
  seed("main", T0 + 5 * HOUR, T0 + 6 * HOUR, 0, 0, "/repo/game/tools/codegen");

  mergeProject("/repo/game/tools/codegen", GAME.projectPath);
  expect(getBranch(GAME.projectPath, "main")!.finished_at).toBeNull();
});

test("--force into an existing branch widens bounds instead of clobbering them", () => {
  // feat/ui already has real history from the morning.
  seed("feat/ui", T0 - 8 * HOUR, T0 - 7 * HOUR, 3, 5);
  // An evening chunk on main, part of which belongs to feat/ui.
  seed("main", T0, T0 + 2 * HOUR, 4, 8);

  backfill([{ branch: "feat/ui", from: T0 + HOUR, to: T0 + 2 * HOUR }], {
    ...GAME,
    force: true,
  });

  const stat = getBranch(GAME.projectPath, "feat/ui")!;
  // The morning chunk still anchors first_seen; the carved hour extends last_seen.
  expect(stat.first_seen).toBe(T0 - 8 * HOUR);
  expect(stat.last_seen).toBe(T0 + 2 * HOUR);
  expect(stat.prompts).toBe(3 + 2);
});

test("target branch bounds re-anchor to the chunks it actually received", () => {
  seed("main", T0, T0 + 4 * HOUR, 8, 0);

  // The window is wider than the work inside it.
  backfill([{ branch: "feat/wide", from: T0 - 2 * HOUR, to: T0 + 6 * HOUR }], GAME);

  const stat = getBranch(GAME.projectPath, "feat/wide")!;
  expect(stat.first_seen).toBe(T0);
  expect(stat.last_seen).toBe(T0 + 4 * HOUR);
});
