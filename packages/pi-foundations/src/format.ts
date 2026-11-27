import { formatBytes as formatSize } from "#surface";

/** Collapse whitespace and trim plain data; optional cap includes the ellipsis. */
export function oneLine(text: string, max?: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (max === undefined || flat.length <= max) return flat;
  if (max <= 0) return "";
  return `${flat.slice(0, max - 1)}…`;
}

/**
 * The display policy is the size every renderer shows (`formatBytes` in pi-surface: `887 B`,
 * `12.4 KiB`, `1.0 GiB`); the log policy keeps its own whole-number units for log banners.
 */
export function formatBytes(bytes: number, style: "display" | "log" = "display"): string {
  if (style === "display") return formatSize(bytes);
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024))} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} bytes`;
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

/**
 * Plain text as inline Markdown that reads as typed: every character Markdown or HTML would act
 * on is backslash-escaped, and line breaks become spaces.
 */
export function markdownText(text: string): string {
  return oneLine(text).replace(/[\\`*_{}[\]()<>#+!|~&-]/g, "\\$&");
}

/** `text` in a fenced code block whose fence is longer than any backtick run inside it. */
export function markdownFence(text: string, language = ""): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text.replace(/\n$/, "")}\n${fence}`;
}
