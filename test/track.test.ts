import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const HOME = "/tmp/clauc-unit";
process.env.CLAUC_HOME = HOME;

const { beat, finish } = await import("../src/track.ts");
const { db } = await import("../src/db.ts");
const { getBranch, listBranches, estimates, categorize } = await import("../src/report.ts");
const { span } = await import("../src/format.ts");

const repo = { root: "/repo/air-ui", name: "air-ui", branch: "feat/login" };
const MIN = 60_000;
const LEAD_IN = 2 * MIN; // credited to the work that produced each new chunk
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);

beforeEach(() => {
  db().run("DELETE FROM chunks; DELETE FROM branches;");
});

afterEach(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("beats inside the idle window extend one chunk", () => {
  beat(repo, "prompt", T0);
  beat(repo, "tool", T0 + 5 * MIN);
  beat(repo, "tool", T0 + 25 * MIN);

  const stat = getBranch(repo.root, repo.branch)!;
  expect(stat.chunks).toBe(1);
  expect(stat.active_ms).toBe(25 * MIN + LEAD_IN);
  expect(stat.prompts).toBe(1);
  expect(stat.tool_calls).toBe(2);
});

test("a lone beat still credits the lead-in, never zero", () => {
  beat(repo, "prompt", T0);
  expect(getBranch(repo.root, repo.branch)!.active_ms).toBe(LEAD_IN);
});

test("a gap past the idle window starts a new chunk and is not billed", () => {
  beat(repo, "prompt", T0);
  beat(repo, "tool", T0 + 10 * MIN);
  beat(repo, "prompt", T0 + 3 * HOUR); // lunch
  beat(repo, "tool", T0 + 3 * HOUR + 20 * MIN);

  const stat = getBranch(repo.root, repo.branch)!;
  expect(stat.chunks).toBe(2);
  // 12m before lunch + 22m after — the 2h50m gap is not billed.
  expect(stat.active_ms).toBe(34 * MIN);
  expect(stat.lead_ms).toBe(3 * HOUR + 20 * MIN); // measured between observed beats
});

test("elapsed spans calendar days while active time stays small", () => {
  beat(repo, "prompt", T0);
  beat(repo, "tool", T0 + 20 * MIN);
  beat(repo, "prompt", T0 + 2 * DAY);
  beat(repo, "tool", T0 + 2 * DAY + 25 * MIN);

  const stat = getBranch(repo.root, repo.branch)!;
  expect(span(stat.lead_ms)).toBe("2 days");
  expect(stat.active_ms).toBe(22 * MIN + 27 * MIN);
  expect(stat.days_touched).toBe(2);
});

test("finishing freezes elapsed time, and new work reopens the branch", () => {
  beat(repo, "prompt", T0);
  beat(repo, "tool", T0 + 10 * MIN);
  finish(repo.root, repo.branch, "shipped", T0 + HOUR);

  let stat = getBranch(repo.root, repo.branch)!;
  expect(stat.finished_at).toBe(T0 + HOUR);
  expect(stat.lead_ms).toBe(HOUR);
  expect(stat.active_ms).toBe(10 * MIN + LEAD_IN);
  expect(stat.note).toBe("shipped");

  beat(repo, "prompt", T0 + 2 * DAY);
  stat = getBranch(repo.root, repo.branch)!;
  expect(stat.finished_at).toBeNull();
});

test("open and finished branches are listed separately", () => {
  beat(repo, "prompt", T0);
  beat({ ...repo, branch: "fix/typo" }, "prompt", T0);
  finish(repo.root, "fix/typo", undefined, T0 + HOUR);

  expect(listBranches({}).map((b) => b.branch)).toEqual(["feat/login"]);
  expect(listBranches({ onlyFinished: true }).map((b) => b.branch)).toEqual(["fix/typo"]);
  expect(listBranches({ includeFinished: true })).toHaveLength(2);
});

test("categorize groups by branch convention", () => {
  expect(categorize("feat/login")).toBe("feat");
  expect(categorize("AIR-123-broken-modal")).toBe("AIR");
  expect(categorize("fix-the-thing")).toBe("fix");
  expect(categorize("scratch")).toBe("other");
});

test("estimates report p50 and p80 per category", () => {
  const leads = [1, 2, 3, 4, 10]; // days
  leads.forEach((days, i) => {
    const branch = { ...repo, branch: `feat/task-${i}` };
    beat(branch, "prompt", T0);
    beat(branch, "tool", T0 + 20 * MIN);
    finish(branch.root, branch.branch, undefined, T0 + days * DAY);
  });

  const [feat] = estimates(listBranches({ onlyFinished: true }));
  expect(feat!.category).toBe("feat");
  expect(feat!.count).toBe(5);
  expect(feat!.medianLeadMs).toBe(3 * DAY);
  expect(feat!.p80LeadMs).toBe(4 * DAY);
  expect(feat!.medianActiveMs).toBe(22 * MIN);
});
