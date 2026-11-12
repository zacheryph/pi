/** Collapse whitespace and trim plain data; optional cap includes the ellipsis. */
export function oneLine(text: string, max?: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (max === undefined || flat.length <= max) return flat;
  if (max <= 0) return "";
  return `${flat.slice(0, max - 1)}…`;
}

/** Existing display and log policies deliberately retain their different units/rounding. */
export function formatBytes(bytes: number, style: "display" | "log" = "display"): string {
  if (style === "log") {
    return bytes >= 1024 * 1024
      ? `${Math.round(bytes / (1024 * 1024))} MB`
      : bytes >= 1024
        ? `${Math.round(bytes / 1024)} KB`
        : `${bytes} bytes`;
  }
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** Compact rounded job durations, or the decimal-seconds display used by agents. */
export function formatDuration(ms: number, style: "compact" | "seconds" = "compact"): string {
  if (style === "seconds") return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The word only; callers own the count and surrounding grammar. */
export function plural(n: number, one: string, many = one + "s"): string {
  return n === 1 ? one : many;
}
