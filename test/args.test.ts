import { expect, test } from "bun:test";
import { parseArgs, parseWhen } from "../src/args.ts";

const BOOLS = new Set(["force", "finish", "all"]);

// --- parseArgs ---

test("boolean flags leave the next argument positional", () => {
  const args = parseArgs(["--finish", "feat/ui", "--force"], BOOLS);
  expect(args.positionals).toEqual(["feat/ui"]);
  expect(args.flags.has("finish")).toBe(true);
  expect(args.flags.has("force")).toBe(true);
});

test("value options consume exactly one argument", () => {
  const args = parseArgs(["feat/ui", "--note", "the fix", "2026-08-20"], BOOLS);
  expect(args.options.get("note")).toBe("the fix");
  expect(args.positionals).toEqual(["feat/ui", "2026-08-20"]);
});

test("a positional equal to an earlier option's value stays positional", () => {
  // The old indexOf-based classifier swallowed the second "fix".
  const args = parseArgs(["--note", "fix", "fix"], BOOLS);
  expect(args.options.get("note")).toBe("fix");
  expect(args.positionals).toEqual(["fix"]);
});

test("a value option at the end of the line degrades to a flag", () => {
  const args = parseArgs(["--note"], BOOLS);
  expect(args.options.has("note")).toBe(false);
  expect(args.flags.has("note")).toBe(true);
});

// --- parseWhen ---

test("ms epochs pass through", () => {
  expect(parseWhen("1767225600000", undefined)).toBe(1767225600000);
});

test("date-only strings pin to local midnight, not UTC", () => {
  expect(parseWhen("2026-08-20", undefined)).toBe(new Date(2026, 7, 20).getTime());
});

test("datetime strings parse as local time", () => {
  expect(parseWhen("2026-08-20 14:30", undefined)).toBe(
    new Date(2026, 7, 20, 14, 30).getTime(),
  );
});

test("garbage throws with the usage hint", () => {
  expect(() => parseWhen("yesterday-ish", undefined)).toThrow(/commit:<ref>/);
});

test("commit refs need a repo to resolve against", () => {
  expect(() => parseWhen("commit:abc123", undefined)).toThrow(/git repo/);
});
