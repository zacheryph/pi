import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseSkillBlock, type SessionEntry, type Skill, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { detailFields, sourceSummary } from "./detail-format.js";
import type { InsightView } from "./types.js";

/** Branch-local successful read evidence only; never skill contents. */
export const SKILL_READ_ENTRY = "pi-system-insights:skill-read";

export function normalizeSkillPath(path: string, cwd: string): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  const absolute = resolve(cwd, expanded);
  try {
    return realpathSync(absolute);
  } catch {
    // Missing files, permissions, or broken symlinks must not break the viewer.
    return absolute;
  }
}

interface ReadEvidence {
  path: string;
  partial: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function skillReadEvidence(
  event: Pick<ToolResultEvent, "toolName" | "input" | "isError">,
  cwd: string,
): ReadEvidence | undefined {
  const input = record(event.input);
  if (event.toolName !== "read" || event.isError !== false || typeof input?.path !== "string" || !input.path.trim()) {
    return undefined;
  }
  return {
    path: normalizeSkillPath(input.path, cwd),
    partial: input.offset != null || input.limit != null,
  };
}

interface Observation {
  index: number;
  partial: boolean;
  kind: string;
}

/** `entries` must be the current root-to-leaf branch, not all session file entries. */
export function buildSkillsView(skills: readonly Skill[], entries: readonly SessionEntry[], cwd: string): InsightView {
  const paths = new Set(skills.map((skill) => normalizeSkillPath(skill.filePath, cwd)));
  const observed = new Map<string, Observation>();
  const calls = new Map<string, { name: string; input: Record<string, unknown>; index: number }>();
  const seenResults = new Set<string>();
  const markers = new Map<string, Observation[]>();
  let lastBoundary = -1;
  let boundaryKind = "compaction";

  function observe(evidence: ReadEvidence, index: number, kind: string): void {
    if (paths.has(evidence.path)) observed.set(evidence.path, { index, partial: evidence.partial, kind });
  }

  function observeResult(evidence: ReadEvidence, index: number, callIndex: number, kind: string): void {
    // tool_result hooks append markers BEFORE the transcript result. Reuse that
    // observation's position rather than incorrectly cleaning across compaction.
    // A new assistant call cannot consume a marker from an older invocation.
    const pending = markers.get(evidence.path);
    const match = pending?.findIndex((marker) => marker.index >= callIndex && marker.partial === evidence.partial) ?? -1;
    if (pending && match >= 0) {
      pending.splice(match, 1);
      return;
    }
    observe(evidence, index, kind);
  }

  entries.forEach((entry, index) => {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      lastBoundary = index;
      boundaryKind = entry.type === "compaction" ? "compaction" : "branch summary";
      return;
    }
    if (entry.type === "custom" && entry.customType === SKILL_READ_ENTRY) {
      const data = record(entry.data);
      if (typeof data?.path !== "string" || !data.path.trim() || typeof data.partial !== "boolean") return;
      const evidence = { path: normalizeSkillPath(data.path, cwd), partial: data.partial };
      if (!paths.has(evidence.path)) return;
      observe(evidence, index, "successful read observed live");
      const pending = markers.get(evidence.path) ?? [];
      pending.push({ index, partial: evidence.partial, kind: "live marker" });
      markers.set(evidence.path, pending);
      return;
    }
    if (entry.type !== "message") return;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") {
          calls.set(block.id, { name: block.name, input: block.arguments, index });
        }
      }
    } else if (message.role === "user") {
      const text = typeof message.content === "string"
        ? message.content
        : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      const expanded = parseSkillBlock(text);
      if (!expanded) return;
      const path = normalizeSkillPath(expanded.location, cwd);
      if (skills.some((skill) => skill.name === expanded.name && normalizeSkillPath(skill.filePath, cwd) === path)) {
        observe({ path, partial: false }, index, "expanded user skill block");
      }
    } else if (message.role === "toolResult") {
      const parent = calls.get(message.toolCallId);
      if (!seenResults.has(message.toolCallId)) {
        seenResults.add(message.toolCallId);
        if (parent && parent.name === message.toolName) {
          const evidence = skillReadEvidence({ toolName: message.toolName, input: parent.input, isError: message.isError }, cwd);
          if (evidence) observeResult(evidence, index, parent.index, "successful read tool result");
        }
      }
      // Completed nested reads count even if a later operation made the parent
      // fail. Missing arguments and unfinished/error calls provide no evidence.
      for (const nested of message.nestedCalls?.calls ?? []) {
        if (seenResults.has(nested.id)) continue;
        seenResults.add(nested.id);
        if (nested.status !== "ok" || !nested.arguments) continue;
        const evidence = skillReadEvidence({ toolName: nested.name, input: nested.arguments, isError: false }, cwd);
        if (evidence) observeResult(evidence, index, parent?.index ?? -1, "successful nested read recorded by parent result");
      }
    }
  });

  return {
    title: "Skills",
    note: "Observed loading; no skill files opened. Retention unverified.",
    legend: [
      { label: "[loaded]", color: "success", meaning: "fresh observation" },
      { label: "[loaded]", color: "dim", meaning: "unobserved/dirty" },
    ],
    items: [...skills].sort((left, right) => left.name.localeCompare(right.name)).map((skill) => {
      const observation = observed.get(normalizeSkillPath(skill.filePath, cwd));
      const dirty = observation !== undefined && lastBoundary > observation.index;
      const status = observation
        ? `loaded${dirty ? " · dirty" : ""}${observation.partial ? " · partial" : ""}`
        : "not observed";
      const fields: [string, string][] = [
        ["Name", skill.name],
        ["Description", skill.description],
        ["Path", skill.filePath],
        ["Source", sourceSummary(skill.sourceInfo, false)],
        ["Invocation", skill.disableModelInvocation ? "command-only" : "auto"],
        ["Evidence", observation ? observation.kind : "none on this branch (not proof of being unloaded)"],
      ];
      if (observation) fields.push(["Loading", status]);
      const detail = detailFields(fields);
      if (observation?.partial) detail.push("Partial read: explicit offset/limit; full-file load not inferred.");
      if (dirty) detail.push(`Pre-${boundaryKind} evidence; instructions may no longer remain in context.`);
      return {
        id: skill.filePath,
        label: skill.name,
        description: skill.description,
        status: `${status}${skill.disableModelInvocation ? " · command-only" : ""}`,
        badge: { label: "[loaded]", color: observation && !dirty ? "success" : "dim" },
        detail: detail.join("\n"),
      };
    }),
  };
}
