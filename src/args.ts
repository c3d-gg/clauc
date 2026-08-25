import { commitTime } from "./git.ts";

export type ParsedArgs = {
  flags: Set<string>;
  options: Map<string, string>;
  positionals: string[];
};

/**
 * One left-to-right pass over the arguments after the command. `--name` is a
 * bare flag when listed in `booleanFlags`, otherwise it consumes the next
 * argument as its value; everything else is positional. Classifying by
 * position (not by looking values up again) keeps a positional that happens to
 * equal an earlier option's value from being swallowed.
 */
export function parseArgs(rest: string[], booleanFlags: ReadonlySet<string>): ParsedArgs {
  const parsed: ParsedArgs = { flags: new Set(), options: new Map(), positionals: [] };

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) {
      parsed.positionals.push(arg);
      continue;
    }

    const name = arg.slice(2);
    if (booleanFlags.has(name)) {
      parsed.flags.add(name);
      continue;
    }

    const value = rest[index + 1];
    if (value !== undefined) {
      parsed.options.set(name, value);
      index++;
    } else {
      parsed.flags.add(name);
    }
  }

  return parsed;
}

/**
 * A moment in time from the command line: ms epoch, `commit:<ref>` (that
 * commit's author time), or anything Date can parse — date-only strings are
 * pinned to local midnight instead of UTC. Throws on anything else; the CLI
 * turns that into its usage message.
 */
export function parseWhen(value: string, root: string | undefined): number {
  if (value.startsWith("commit:")) {
    if (!root) throw new Error(`"${value}" needs a git repo to resolve against`);
    const at = commitTime(root, value.slice("commit:".length));
    if (at === null) throw new Error(`can't resolve "${value}" in ${root}`);
    return at;
  }
  if (/^\d{12,}$/.test(value)) return Number(value);

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00` : value;
  const at = new Date(normalized).getTime();
  if (Number.isNaN(at)) {
    throw new Error(
      `can't parse time "${value}" — use ISO ("2026-08-20 14:00"), ms epoch, or commit:<ref>`,
    );
  }
  return at;
}
