/** Bounded, plain-text activity feed. Never imports inherited conversation history. */
import type { AgentSessionEvent } from "#src/types";

const MAX_ENTRIES = 32;
const MAX_TEXT = 4096;

/** Strip terminal escapes and controls while preserving printable lines. */
export function watchText(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
    .slice(-MAX_TEXT);
}

function oneLine(text: string): string {
  return watchText(text).replace(/\s+/g, " ").trim();
}

function textContent(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content.filter(item => item?.type === "text" && typeof item.text === "string")
    .map(item => item.text as string).join("\n");
}

/** One useful argument, rather than a JSON dump of source code or payloads. */
function toolArgument(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const values = args as Record<string, unknown>;
  for (const key of ["path", "file_path", "command", "pattern", "query", "description", "url"]) {
    if (typeof values[key] === "string") return oneLine(values[key]).slice(0, 160);
  }
  return "";
}

interface TailEntry { key: string; text: string }

export class WatchTail {
  private entries: TailEntry[] = [];
  private sequence = 0;
  private assistantKey: string | undefined;
  private toolLabels = new Map<string, string>();

  get blocks(): readonly string[] { return this.entries.map(entry => entry.text).filter(Boolean); }

  note(text: string): void { this.put(`note:${++this.sequence}`, watchText(text)); }

  /** Returns whether visible text changed, so callers can coalesce repaints. */
  apply(event: AgentSessionEvent): boolean {
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.assistantKey = `assistant:${++this.sequence}`;
      return false;
    }
    if ((event.type === "message_update" || event.type === "message_end")
      && event.message.role === "assistant") {
      this.assistantKey ??= `assistant:${++this.sequence}`;
      const changed = this.put(this.assistantKey, watchText(textContent(event.message)));
      if (event.type === "message_end") this.assistantKey = undefined;
      return changed;
    }
    if (event.type === "tool_execution_start") {
      const label = oneLine(`${event.toolName} ${toolArgument(event.args)}`);
      this.toolLabels.set(event.toolCallId, label);
      return this.put(`tool:${event.toolCallId}`, `› ${label} …`);
    }
    if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const label = this.toolLabels.get(event.toolCallId) ?? oneLine(event.toolName);
      const result = event.type === "tool_execution_update" ? event.partialResult : event.result;
      const lastLine = watchText(textContent(result)).trim().split("\n").at(-1) ?? "";
      const status = event.type === "tool_execution_update" ? "…" : event.isError ? "✗" : "✓";
      return this.put(`tool:${event.toolCallId}`, `${status} ${label}${lastLine ? ` — ${oneLine(lastLine).slice(0, 160)}` : ""}`);
    }
    if (event.type === "compaction_start") { this.note("Compacting context…"); return true; }
    if (event.type === "auto_retry_start") { this.note(`Retry ${event.attempt}/${event.maxAttempts}`); return true; }
    return false;
  }

  private put(key: string, text: string): boolean {
    if (!text) return false;
    const entry = this.entries.find(item => item.key === key);
    if (entry) {
      if (entry.text === text) return false;
      entry.text = text;
    } else {
      this.entries.push({ key, text });
      if (this.entries.length > MAX_ENTRIES) {
        const removed = this.entries.shift()!;
        if (removed.key.startsWith("tool:")) this.toolLabels.delete(removed.key.slice(5));
      }
    }
    return true;
  }
}
