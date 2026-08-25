const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact work duration: "3h 20m". Used for active time. */
export function duration(ms: number): string {
  if (ms < MINUTE) return "0m";
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}m`;

  const hours = Math.floor(ms / HOUR);
  const minutes = Math.round((ms % HOUR) / MINUTE);
  if (hours < 24) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;

  const days = Math.floor(ms / DAY);
  const rest = Math.round((ms % DAY) / HOUR);
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

/** Calendar span, rounded up — "took 3 days" reads better than "2.6 days". */
export function span(ms: number): string {
  if (ms < HOUR) return duration(ms);
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  const days = Math.max(1, Math.round(ms / DAY));
  return days === 1 ? "1 day" : `${days} days`;
}

export function ago(timestamp: number, now: number = Date.now()): string {
  const delta = now - timestamp;
  if (delta < MINUTE) return "just now";
  if (delta < DAY) return `${duration(delta)} ago`;
  return `${span(delta)} ago`;
}

export function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function padStart(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

/** Left-aligned first column, right-aligned rest. Keeps reports scannable. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) =>
        i === 0 ? pad(cell, widths[i]!) : padStart(cell, widths[i]!),
      )
      .join("  ")
      .trimEnd();

  return [
    line(headers),
    widths.map((w) => "─".repeat(w)).join("  "),
    ...rows.map(line),
  ].join("\n");
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
