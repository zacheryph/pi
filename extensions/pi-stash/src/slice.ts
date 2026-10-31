import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

export const DEFAULT_GET_BYTES = 16 * 1024;
/** Pi's tool output budget: 50 KB / 2,000 lines. */
export const HARD_MAX_BYTES = DEFAULT_MAX_BYTES;
export const HARD_MAX_LINES = DEFAULT_MAX_LINES;
const MAX_GREP_CONTEXT = 20;

export interface SliceRequest {
  lines?: [number, number];
  grep?: { pattern: string; context?: number; ignoreCase?: boolean };
  jsonPath?: string;
  maxBytes?: number;
}

export interface SliceResult {
  mode: "head" | "lines" | "grep" | "json";
  /** Rendered output; line-numbered for head/lines/grep. */
  text: string;
  totalLines: number;
  /** First and last entry line shown (head/lines). */
  range?: [number, number];
  truncated: boolean;
  /** The first output row was longer than the budget and was cut short. */
  clipped?: boolean;
  /** Next range to request after a truncated head/lines read. */
  next?: [number, number];
  matches?: number;
  matchesShown?: number;
  hint?: string;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/** Cuts a string to at most `bytes` UTF-8 bytes without splitting a code point. */
function clipBytes(text: string, bytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= bytes) return text;
  let end = Math.max(0, bytes);
  // Back up to a code point boundary (UTF-8 continuation bytes are 10xxxxxx).
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

class Budget {
  private used = 0;
  private count = 0;
  readonly rows: string[] = [];
  /** Set when a row was cut to fit; the output is then incomplete. */
  clipped = false;
  constructor(
    readonly bytes: number,
    private readonly lines = HARD_MAX_LINES,
  ) {}

  /** Adds a row. A first row that is too long is clipped rather than dropped. */
  add(row: string): boolean {
    const cost = Buffer.byteLength(row, "utf8") + (this.rows.length ? 1 : 0);
    if (this.count >= this.lines) return false;
    if (this.used + cost > this.bytes) {
      if (this.rows.length) return false;
      const marker = " …[line clipped]";
      this.rows.push(clipBytes(row, Math.max(0, this.bytes - Buffer.byteLength(marker))) + marker);
      this.used = this.bytes;
      this.count++;
      this.clipped = true;
      return true;
    }
    this.rows.push(row);
    this.used += cost;
    this.count++;
    return true;
  }
}

const numbered = (n: number, line: string, mark = "\t") => `${n}${mark}${line}`;

/** How to see more of a row that was clipped to the byte budget. */
function clipHint(what: string, budget: Budget): string {
  const raise = budget.bytes < HARD_MAX_BYTES ? `raise maxBytes (max ${HARD_MAX_BYTES}) or ` : "";
  return `${what} clipped at ${budget.bytes} bytes; ${raise}use jsonPath if the entry is JSON`;
}

export function clampMaxBytes(maxBytes: number | undefined): number {
  if (maxBytes === undefined || !Number.isFinite(maxBytes)) return DEFAULT_GET_BYTES;
  return Math.max(256, Math.min(HARD_MAX_BYTES, Math.floor(maxBytes)));
}

function readRange(
  all: string[],
  start: number,
  end: number,
  budget: Budget,
  mode: "head" | "lines",
): SliceResult {
  const total = all.length;
  if (!total) return { mode, text: "(empty)", totalLines: 0, truncated: false };
  if (start > total) {
    return {
      mode,
      text: `(no lines: entry has ${total} lines)`,
      totalLines: total,
      truncated: false,
      hint: `Valid range is [1, ${total}]`,
    };
  }
  let last = start - 1;
  for (let n = start; n <= end; n++) {
    if (!budget.add(numbered(n, all[n - 1]))) break;
    last = n;
  }
  const clipped = budget.clipped;
  const truncated = last < end || clipped;
  const result: SliceResult = {
    mode,
    text: budget.rows.join("\n"),
    totalLines: total,
    range: [start, last],
    truncated,
    ...(clipped ? { clipped } : {}),
  };
  const hints = clipped ? [clipHint(`line ${last}`, budget)] : [];
  if (last < end) {
    const size = Math.max(1, last - start + 1);
    result.next = [last + 1, Math.min(total, end, last + size)];
    hints.push(
      `truncated at line ${last} of ${total}; next range is [${result.next[0]}, ${result.next[1]}]`,
    );
  } else if (mode === "head" && last < total) {
    hints.push(`showing lines ${start}-${last} of ${total}`);
  }
  if (hints.length) result.hint = hints.join("; ");
  return result;
}

/** Minimal JSONPath: `$`, `.key`, `["key"]`, `[0]`, `[-1]`. */
export function parseJsonPath(path: string): (string | number)[] {
  const text = path.trim();
  let i = text.startsWith("$") ? 1 : 0;
  const parts: (string | number)[] = [];
  const fail = () => new Error(`Invalid jsonPath "${path}": use $.key, $["key"] or $[0]`);
  while (i < text.length) {
    if (text[i] === ".") {
      const match = /^[A-Za-z_$][\w$-]*/.exec(text.slice(i + 1));
      if (!match) throw fail();
      parts.push(match[0]);
      i += 1 + match[0].length;
    } else if (text[i] === "[") {
      const rest = text.slice(i);
      const index = /^\[(-?\d+)\]/.exec(rest);
      const quoted = /^\[\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\]/.exec(rest);
      if (index) {
        parts.push(Number(index[1]));
        i += index[0].length;
      } else if (quoted) {
        const raw = quoted[1];
        parts.push(
          raw.startsWith("'")
            ? raw.slice(1, -1).replace(/\\(.)/g, "$1")
            : (JSON.parse(raw) as string),
        );
        i += quoted[0].length;
      } else throw fail();
    } else if (i === 0 && /[A-Za-z_]/.test(text[i])) {
      // Allow a leading bare key: `items[0].name`.
      const match = /^[A-Za-z_$][\w$-]*/.exec(text)!;
      parts.push(match[0]);
      i += match[0].length;
    } else throw fail();
  }
  return parts;
}

export function sliceText(text: string, request: SliceRequest): SliceResult {
  const modes = [request.lines, request.grep, request.jsonPath].filter(
    (value) => value !== undefined,
  );
  if (modes.length > 1) throw new Error("Use at most one of lines, grep, and jsonPath");
  const maxBytes = clampMaxBytes(request.maxBytes);
  const all = splitLines(text);
  const budget = new Budget(maxBytes);

  if (request.lines) {
    const [rawStart, rawEnd] = request.lines;
    if (
      !Number.isInteger(rawStart) ||
      !Number.isInteger(rawEnd) ||
      rawStart < 1 ||
      rawEnd < rawStart
    ) {
      throw new Error("lines must be [start, end] with 1 <= start <= end (1-based, inclusive)");
    }
    return readRange(all, rawStart, Math.min(rawEnd, all.length || 1), budget, "lines");
  }

  if (request.grep) {
    const context = Math.max(0, Math.min(MAX_GREP_CONTEXT, Math.floor(request.grep.context ?? 0)));
    let regex: RegExp;
    try {
      regex = new RegExp(request.grep.pattern, request.grep.ignoreCase ? "i" : "");
    } catch (error) {
      throw new Error(
        `Invalid grep pattern: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const hits: number[] = [];
    for (let i = 0; i < all.length; i++) if (regex.test(all[i])) hits.push(i);
    if (!hits.length)
      return {
        mode: "grep",
        text: "(no matches)",
        totalLines: all.length,
        truncated: false,
        matches: 0,
        matchesShown: 0,
      };
    let shown = 0;
    let printedUntil = -1;
    let full = true;
    const hitSet = new Set(hits);
    for (const hit of hits) {
      const from = Math.max(printedUntil + 1, hit - context);
      const to = Math.min(all.length - 1, hit + context);
      const rows: string[] = [];
      if (printedUntil >= 0 && from > printedUntil + 1) rows.push("--");
      for (let i = from; i <= to; i++)
        rows.push(numbered(i + 1, all[i], hitSet.has(i) ? ":\t" : "-\t"));
      // Only whole groups are shown, so a match is never cut from its context.
      const snapshot = budget.rows.length;
      let fits = true;
      for (const row of rows)
        if (!budget.add(row)) {
          fits = false;
          break;
        }
      if (!fits) {
        if (shown) budget.rows.length = snapshot;
        full = false;
        if (shown) break;
      }
      printedUntil = Math.max(printedUntil, to);
      shown++;
      if (!fits) break;
    }
    const result: SliceResult = {
      mode: "grep",
      text: budget.rows.join("\n"),
      totalLines: all.length,
      truncated: !full || budget.clipped,
      ...(budget.clipped ? { clipped: true } : {}),
      matches: hits.length,
      matchesShown: shown,
    };
    const hints = budget.clipped ? [clipHint("first matching line", budget)] : [];
    if (!full) {
      const nextLine = hits[shown] === undefined ? undefined : hits[shown] + 1;
      hints.push(
        `showing ${shown} of ${hits.length} matches${nextLine ? `; next match is at line ${nextLine}` : ""}; narrow the pattern or read with lines`,
      );
    }
    if (hints.length) result.hint = hints.join("; ");
    return result;
  }

  if (request.jsonPath !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `Entry is not valid JSON, so jsonPath cannot be used: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const part of parseJsonPath(request.jsonPath)) {
      if (typeof part === "number" && Array.isArray(value)) {
        value = value[part < 0 ? value.length + part : part];
      } else if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.hasOwn(value, String(part))
      ) {
        value = (value as Record<string, unknown>)[String(part)];
      } else {
        throw new Error(
          `jsonPath "${request.jsonPath}" does not match: no ${typeof part === "number" ? `index ${part}` : `key "${part}"`}`,
        );
      }
      if (value === undefined) throw new Error(`jsonPath "${request.jsonPath}" does not match`);
    }
    const rendered = splitLines(JSON.stringify(value, null, 2) ?? "null");
    let shownRows = 0;
    for (const row of rendered) {
      if (!budget.add(row)) break;
      shownRows++;
    }
    const truncated = shownRows < rendered.length || budget.clipped;
    const hint =
      budget.clipped && shownRows === rendered.length
        ? clipHint("value", budget)
        : `value truncated after ${shownRows} of ${rendered.length} lines; use a deeper jsonPath`;
    return {
      mode: "json",
      text: budget.rows.join("\n"),
      totalLines: all.length,
      truncated,
      ...(budget.clipped ? { clipped: true } : {}),
      ...(truncated ? { hint } : {}),
    };
  }

  return readRange(all, 1, all.length, budget, "head");
}

/** Leading lines within both budgets; the last one may be clipped. */
export function headLines(
  text: string,
  maxLines: number,
  maxBytes: number,
): { lines: string[]; total: number; complete: boolean } {
  const all = splitLines(text);
  const lines = splitLines(clipBytes(all.slice(0, maxLines).join("\n"), maxBytes));
  const complete = lines.length === all.length && lines.at(-1) === all.at(-1);
  return { lines, total: all.length, complete };
}

/** About 10 lines or 1 KB, whichever is smaller. Never the whole entry. */
export function previewOf(text: string, maxLines = 10, maxBytes = 1024): string {
  const { lines, total, complete } = headLines(text, maxLines, maxBytes);
  if (complete) return lines.join("\n");
  return `${lines.join("\n")}${lines.length < total ? `\n… (${total} lines total)` : " …"}`;
}
