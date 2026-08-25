import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOME = "/tmp/clauc-import-unit";
const FIXTURES = "/tmp/clauc-fixtures";
process.env.CLAUC_HOME = HOME;

const { importTranscripts } = await import("../src/import.ts");
const { db } = await import("../src/db.ts");
const { getBranch } = await import("../src/report.ts");

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A directory that is not a git repo, so it keys on the path itself. */
const CWD = "/tmp/clauc-fixtures/fake-project";

type LineInput = {
  at: number;
  branch?: string;
  cwd?: string;
  type?: string;
  prompt?: boolean;
  tool?: boolean;
};

function line({ at, branch = "feat/login", cwd = CWD, type, prompt, tool }: LineInput) {
  return JSON.stringify({
    type: type ?? (prompt ? "user" : "assistant"),
    timestamp: new Date(at).toISOString(),
    cwd,
    gitBranch: branch,
    ...(prompt ? { promptSource: "typed" } : {}),
    ...(tool ? { toolUseResult: { filePath: "x.ts" } } : {}),
  });
}

function transcript(relativePath: string, lines: string[]) {
  const full = join(FIXTURES, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, lines.join("\n") + "\n");
}

const run = (options: Partial<Parameters<typeof importTranscripts>[0]> = {}) =>
  importTranscripts({ dir: FIXTURES, ...options });

beforeEach(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
  mkdirSync(FIXTURES, { recursive: true });
  db().run("DELETE FROM chunks; DELETE FROM branches;");
  db().run("DROP TABLE IF EXISTS imports");
});

afterEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(FIXTURES, { recursive: true, force: true });
});

const T0 = Date.now() - 3 * HOUR;

test("replays transcript lines into chunks", async () => {
  transcript("project-a/session.jsonl", [
    line({ at: T0, prompt: true }),
    line({ at: T0 + 10 * MIN, tool: true }),
    line({ at: T0 + 20 * MIN, tool: true }),
  ]);

  const result = await run();
  expect(result.files).toBe(1);
  expect(result.events).toBe(3);

  const stat = getBranch(CWD, "feat/login")!;
  expect(stat.chunks).toBe(1);
  expect(stat.active_ms).toBe(22 * MIN);
  expect(stat.prompts).toBe(1);
  expect(stat.tool_calls).toBe(2);
});

test("a gap past the idle window splits the history", async () => {
  transcript("project-a/session.jsonl", [
    line({ at: T0, prompt: true }),
    line({ at: T0 + 10 * MIN, tool: true }),
    line({ at: T0 + 2 * HOUR, prompt: true }),
  ]);

  await run();
  const stat = getBranch(CWD, "feat/login")!;
  expect(stat.chunks).toBe(2);
  expect(stat.active_ms).toBe(12 * MIN + 2 * MIN);
});

test("subagent transcripts count, and their overlap is merged not doubled", async () => {
  transcript("project-a/session.jsonl", [
    line({ at: T0, prompt: true }),
    line({ at: T0 + 30 * MIN, tool: true }),
  ]);
  transcript("project-a/session/subagents/agent-explore.jsonl", [
    line({ at: T0 + 10 * MIN, tool: true }),
    line({ at: T0 + 20 * MIN, tool: true }),
  ]);

  const result = await run();
  expect(result.files).toBe(2);

  const stat = getBranch(CWD, "feat/login")!;
  expect(stat.chunks).toBe(1);
  // The subagent ran inside the parent's window, so it adds tool calls but no
  // extra wall-clock time.
  expect(stat.active_ms).toBe(32 * MIN);
  expect(stat.tool_calls).toBe(3);
});

test("lines with no branch, no timestamp, or a bare HEAD are ignored", async () => {
  transcript("project-a/session.jsonl", [
    JSON.stringify({ type: "mode", mode: "normal" }),
    line({ at: T0, branch: "HEAD", prompt: true }),
    JSON.stringify({ type: "user", cwd: CWD, gitBranch: "feat/login" }),
    line({ at: T0 + 5 * MIN, prompt: true }),
    "{ not json",
  ]);

  const result = await run();
  expect(result.events).toBe(1);
  expect(getBranch(CWD, "HEAD")).toBeNull();
  expect(getBranch(CWD, "feat/login")!.chunks).toBe(1);
});

test("unchanged transcripts are skipped on a second run", async () => {
  transcript("project-a/session.jsonl", [line({ at: T0, prompt: true })]);

  expect((await run()).files).toBe(1);

  const second = await run();
  expect(second.files).toBe(0);
  expect(second.skipped).toBe(1);
  expect(getBranch(CWD, "feat/login")!.chunks).toBe(1);
});

test("a grown transcript is re-read without duplicating earlier time", async () => {
  transcript("project-a/session.jsonl", [
    line({ at: T0, prompt: true }),
    line({ at: T0 + 10 * MIN, tool: true }),
  ]);
  await run();

  transcript("project-a/session.jsonl", [
    line({ at: T0, prompt: true }),
    line({ at: T0 + 10 * MIN, tool: true }),
    line({ at: T0 + 20 * MIN, tool: true }),
  ]);
  const second = await run();
  expect(second.files).toBe(1);

  const stat = getBranch(CWD, "feat/login")!;
  expect(stat.chunks).toBe(1);
  expect(stat.active_ms).toBe(22 * MIN);
});

test("--force re-reads, and --dry-run writes nothing", async () => {
  transcript("project-a/session.jsonl", [line({ at: T0, prompt: true })]);

  const dry = await run({ dryRun: true });
  expect(dry.chunks).toBe(1);
  expect(getBranch(CWD, "feat/login")).toBeNull();

  await run();
  expect((await run({ force: true })).files).toBe(1);
});

test("sinceDays drops lines older than the window", async () => {
  const old = Date.now() - 40 * 24 * HOUR;
  transcript("project-a/session.jsonl", [
    line({ at: old, prompt: true }),
    line({ at: T0, prompt: true }),
  ]);

  const result = await run({ sinceDays: 7 });
  expect(result.events).toBe(1);
});

test("separate branches stay separate", async () => {
  transcript("project-a/session.jsonl", [
    line({ at: T0, branch: "feat/login", prompt: true }),
    line({ at: T0 + 5 * MIN, branch: "fix/typo", prompt: true }),
    line({ at: T0 + 10 * MIN, branch: "feat/login", tool: true }),
  ]);

  await run();
  expect(getBranch(CWD, "feat/login")!.active_ms).toBe(12 * MIN);
  expect(getBranch(CWD, "fix/typo")!.active_ms).toBe(2 * MIN);
});
