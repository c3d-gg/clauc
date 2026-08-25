#!/usr/bin/env bun
import { DEBUG } from "./config.ts";
import { resolveRepo } from "./git.ts";
import { beat, type BeatKind } from "./track.ts";

type HookInput = {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
};

const BEAT_BY_EVENT: Record<string, BeatKind> = {
  SessionStart: "ping",
  UserPromptSubmit: "prompt",
  PostToolUse: "tool",
  Stop: "ping",
  SessionEnd: "ping",
};

async function readInput(): Promise<HookInput | null> {
  try {
    const raw = await Bun.stdin.text();
    return raw.trim() ? (JSON.parse(raw) as HookInput) : null;
  } catch {
    return null;
  }
}

const input = await readInput();
const kind = BEAT_BY_EVENT[input?.hook_event_name ?? ""];

// Unknown event, or a session started somewhere that isn't a git repo — there's
// no branch to key on, so there's nothing to record.
if (input?.cwd && kind) {
  const repo = resolveRepo(input.cwd);
  if (repo) {
    try {
      beat(repo, kind);
      if (DEBUG) {
        console.error(`clauc: ${kind} ${repo.name}@${repo.branch}`);
      }
    } catch (err) {
      // Hooks run async and their output is discarded; never let a tracking
      // failure surface as noise in the user's session.
      if (DEBUG) console.error("clauc:", err);
    }
  }
}
