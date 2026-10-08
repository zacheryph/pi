/** Bounded, typed activity feed. Never imports inherited conversation history. */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AgentSessionEvent } from "#src/types";

const MAX_ENTRIES = 32;
const MAX_TEXT = 4096;

/** Strip terminal escapes and controls while preserving printable lines. */
export function watchText(text: string): string {
  return text
    .replace(/(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c|$)/g, "")
    .replace(/(?:\x1b[P_X^]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\x1b\\|\u009c|$)/g, "")
    .replace(/(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]?/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
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

/** Match known skill resources without opening their contents. Missing paths remain lexical. */
export function watchSkillPath(path: string, cwd: string): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  const absolute = resolve(cwd, expanded);
  try { return realpathSync(absolute); } catch { return absolute; }
}

export interface WatchBlock {
  readonly kind: "text" | "thinking" | "tool" | "skill" | "note" | "error";
  readonly text: string;
  readonly status?: "pending" | "success" | "error";
  /** Explicit offset/limit is read evidence, not proof of a full skill load. */
  readonly partial?: boolean;
}
interface TailEntry { key: string; block: WatchBlock }
interface ToolInfo { name: string; label: string; skill?: string; partial?: boolean }
export interface WatchResources { cwd: string; skills: readonly { name: string; filePath: string }[] }

export class WatchTail {
  private entries: TailEntry[] = [];
  private sequence = 0;
  private assistantKey: string | undefined;
  private tools = new Map<string, ToolInfo>();
  private skills = new Map<string, string>();
  private cwd = process.cwd();

  constructor(resources?: WatchResources) { if (resources) this.setResources(resources); }

  setResources({ cwd, skills }: WatchResources): void {
    this.cwd = cwd;
    this.skills = new Map(skills.filter(skill => /(?:^|[/\\])SKILL\.md$/.test(skill.filePath))
      .map(skill => [watchSkillPath(skill.filePath, cwd), oneLine(skill.name).slice(0, 160)]));
  }

  get blocks(): readonly WatchBlock[] { return this.entries.map(entry => entry.block); }

  /** Filter only at display time: recent retained thinking can reappear on toggle. */
  visibleBlocks(showThinking = true): readonly WatchBlock[] {
    return this.blocks.filter(block => showThinking || block.kind !== "thinking");
  }

  note(text: string, kind: "note" | "text" | "error" = "note"): void {
    this.put(`note:${++this.sequence}`, { kind, text: watchText(text) });
  }

  /** Returns whether retained content changed, so callers can coalesce repaints. */
  apply(event: AgentSessionEvent): boolean {
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.assistantKey = `assistant:${++this.sequence}`;
      return false;
    }
    if ((event.type === "message_update" || event.type === "message_end")
      && event.message.role === "assistant") {
      this.assistantKey ??= `assistant:${++this.sequence}`;
      let changed = false;
      event.message.content.forEach((block, index) => {
        if (block.type !== "text" && block.type !== "thinking") return;
        changed = this.put(`${this.assistantKey}:${index}`, {
          kind: block.type,
          text: watchText(block.type === "text" ? block.text : block.thinking),
        }) || changed;
      });
      if (event.type === "message_end") {
        if (event.message.errorMessage) {
          changed = this.put(`${this.assistantKey}:error`, { kind: "error", text: watchText(event.message.errorMessage) }) || changed;
        }
        this.assistantKey = undefined;
      }
      return changed;
    }
    if (event.type === "tool_execution_start") {
      const label = oneLine(`${event.toolName} ${toolArgument(event.args)}`);
      const args = event.args as Record<string, unknown> | undefined;
      const skill = event.toolName === "read" && typeof args?.path === "string" && args.path.trim()
        ? this.skills.get(watchSkillPath(args.path, this.cwd)) : undefined;
      const info: ToolInfo = { name: event.toolName, label, skill, partial: args?.offset != null || args?.limit != null };
      this.tools.set(event.toolCallId, info);
      return this.putTool(event.toolCallId, info, "pending", "");
    }
    if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const call = this.tools.get(event.toolCallId);
      const info = call?.name === event.toolName ? call : { name: event.toolName, label: oneLine(event.toolName) };
      const result = event.type === "tool_execution_update" ? event.partialResult : event.result;
      const lastLine = info.skill ? "" : watchText(textContent(result)).trim().split("\n").at(-1) ?? "";
      const status = event.type === "tool_execution_update" ? "pending"
        : event.isError === false ? "success" : event.isError === true ? "error" : "pending";
      return this.putTool(event.toolCallId, info, status, oneLine(lastLine).slice(0, 160));
    }
    if (event.type === "compaction_start") { this.note("Compacting context…"); return true; }
    if (event.type === "auto_retry_start") { this.note(`Retry ${event.attempt}/${event.maxAttempts}`); return true; }
    return false;
  }

  private putTool(id: string, info: ToolInfo, status: NonNullable<WatchBlock["status"]>, excerpt: string): boolean {
    const text = info.skill
      ? `${info.skill} · ${status === "pending" ? "loading…" : status === "error" ? "failed" : info.partial ? "read · partial" : "loaded"}`
      : `${status === "pending" ? "…" : status === "error" ? "✗" : "✓"} ${info.label}${excerpt ? ` — ${excerpt}` : ""}`;
    return this.put(`tool:${id}`, { kind: info.skill ? "skill" : "tool", text, status, ...(info.skill ? { partial: info.partial } : {}) });
  }

  private put(key: string, block: WatchBlock): boolean {
    block = { ...block, text: watchText(block.text) };
    const index = this.entries.findIndex(item => item.key === key);
    if (!block.text) {
      if (index < 0) return false;
      this.entries.splice(index, 1);
      return true;
    }
    if (index >= 0) {
      const old = this.entries[index].block;
      if (old.text === block.text && old.kind === block.kind && old.status === block.status && old.partial === block.partial) return false;
      this.entries[index].block = block;
    } else {
      this.entries.push({ key, block });
      if (this.entries.length > MAX_ENTRIES) {
        const removed = this.entries.shift()!;
        if (removed.key.startsWith("tool:")) this.tools.delete(removed.key.slice(5));
      }
    }
    return true;
  }
}
