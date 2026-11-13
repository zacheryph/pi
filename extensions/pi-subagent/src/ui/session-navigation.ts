/**
 * session-navigation.ts — Pure selection and transcript-sourcing for native session navigation.
 *
 * Splits the unit-testable core of the `/subagent:sessions` command from its TUI
 * wiring (`session-navigator.ts`): which subagents are navigable and how a picked
 * agent's transcript is sourced (live, in this slice).
 *
 * The `TranscriptSource` seam decouples *how messages are sourced* (live record
 * here; a file snapshot in a follow-up) from *how they render* — the renderer
 * (`session-navigator.ts`, which mounts Pi's per-entry components) talks only to
 * this seam. Rendering lives in the SDK/TUI module because the per-entry
 * components require a `TUI`, `cwd`, and markdown theme.
 */

import {
  buildSessionContext,
  parseSessionEntries,
  type SessionEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfigLookup } from "#src/config/agent-types";
import { extractAssistantContent } from "#src/session/content-items";
import {
  displayStatus,
  isRunningStatus,
  type RunOutcome,
  type SubagentStatus,
} from "#src/lifecycle/subagent-state";
import type { PersistedRunSummary } from "#src/persisted-record";
import type { AgentSessionEvent, SessionMessage, SubagentType } from "#src/types";
import { formatAgentDuration, getDisplayName, type ModelIdentity } from "#src/ui/display";

// ─────────────────────────────────────────────────────────────────────────────

/** The record fields the navigator reads to label and live-source a transcript. */
export interface NavigableSubagent {
  readonly id: string;
  readonly type: SubagentType;
  readonly description: string;
  readonly status: SubagentStatus;
  readonly outcome: RunOutcome | undefined;
  readonly startedAt: number;
  readonly completedAt: number | undefined;
  readonly toolUses: number;
  readonly activeTools: ReadonlyMap<string, string>;
  readonly responseText: string;
  readonly agentMessages: readonly SessionMessage[];
  /** Persisted transcript path, retained after the live session is released. */
  readonly outputFile: string | undefined;
  /** The model the agent runs, when known. */
  readonly model: ModelIdentity | undefined;
  /** The thinking level the agent runs at, when known. */
  readonly thinkingLevel: string | undefined;
  isSessionReady(): boolean;
  subscribeToUpdates(fn: (event: AgentSessionEvent) => void): (() => void) | undefined;
  getToolDefinition(name: string): ToolDefinition | undefined;
}

/**
 * A navigable entry plus the label shown in the picker.
 *
 * A `live` entry sources its transcript from the in-memory record; a `snapshot`
 * entry sources it from the persisted session file (the session was released by
 * the retention sweep, but the record and its transcript pointer survive).
 */
export type NavigationEntry =
  | {
      readonly kind: "live";
      readonly label: string;
      readonly heading: EntryHeading;
      readonly record: NavigableSubagent;
    }
  | {
      readonly kind: "snapshot";
      readonly label: string;
      readonly heading: EntryHeading;
      readonly outputFile: string;
    };

/** Who produced a transcript, for the pane's header. Fixed for the life of the entry. */
export interface EntryHeading {
  readonly name: string;
  readonly description: string;
}

/** The fields `buildLabel` reads — shared by the live and snapshot (released-session) label paths. */
interface LabelFields {
  readonly type: SubagentType;
  readonly description: string;
  readonly status: SubagentStatus;
  readonly outcome: RunOutcome | undefined;
  readonly startedAt: number;
  readonly completedAt: number | undefined;
  readonly toolUses: number;
}

/** The model and thinking level a transcript's session runs at. */
export interface SessionModel {
  readonly model: ModelIdentity | undefined;
  readonly thinkingLevel: string | undefined;
}

/** Running-agent streaming state, surfaced by a live source. */
export interface StreamingState {
  readonly activeTools: ReadonlyMap<string, string>;
  readonly responseText: string;
}

/** Liveness-agnostic transcript source consumed by the renderer. */
export interface TranscriptSource {
  /** Current message history. */
  getMessages(): readonly SessionMessage[];
  /**
   * Subscribe to changes; returns an unsubscribe, or undefined for a static
   * snapshot. The session event is forwarded so a consumer can route on it —
   * a streaming delta and a settled message warrant very different work.
   */
  subscribe(onChange: (event?: AgentSessionEvent) => void): (() => void) | undefined;
  /** Running-agent streaming state, or undefined when not streaming. */
  streaming(): StreamingState | undefined;
  /** Resolve a registered tool definition by name, for Pi's tool-execution components. */
  getToolDefinition(name: string): ToolDefinition | undefined;
  /** Model and thinking level, read at call time: a live child can switch either mid-run. */
  sessionModel(): SessionModel;
}

/**
 * Label every navigable subagent for the picker: records with a live session
 * source their transcript in-memory (`live`); records whose session the
 * retention sweep released but which retain a transcript pointer source it from
 * disk (`snapshot`). Records with neither are not navigable. Live entries first.
 *
 * `persisted` carries the runs the parent session recorded, which outlive the
 * manager's records across a `/reload` or `/resume`. One the manager no longer
 * holds is listed as a snapshot after the manager's own entries; the manager's
 * record wins for any run it still holds.
 */
export function listNavigableAgents(
  agents: readonly NavigableSubagent[],
  registry: AgentConfigLookup,
  persisted: readonly PersistedRunSummary[],
): NavigationEntry[] {
  const live: NavigationEntry[] = [];
  const snapshots: NavigationEntry[] = [];
  for (const record of agents) {
    const heading = buildHeading(record, registry);
    if (record.isSessionReady()) {
      live.push({ kind: "live", record, heading, label: buildLabel(record, registry) });
    } else if (record.outputFile) {
      snapshots.push({
        kind: "snapshot",
        outputFile: record.outputFile,
        heading,
        label: buildLabel(record, registry, true),
      });
    }
  }
  const held = new Set(agents.map((record) => record.id));
  for (const run of persisted) {
    if (held.has(run.id) || !run.outputFile) continue;
    snapshots.push({
      kind: "snapshot",
      outputFile: run.outputFile,
      heading: buildHeading(run, registry),
      label: buildLabel(run, registry, true),
    });
  }
  return [...live, ...snapshots];
}

/**
 * Source a transcript from a persisted child-session JSONL snapshot.
 *
 * For an agent whose live session the retention sweep released: the in-memory
 * message history is gone, but the session file survives on disk (and the
 * record retains its path). Reads the file, drops the `SessionHeader`, and resolves the
 * message list via Pi's own parser. A static snapshot — no subscription, no
 * streaming, no live tool registry. `readFile` is injected so this module makes
 * no `fs` calls.
 */
export function fileSnapshotSource(
  outputFile: string,
  readFile: (path: string) => string,
): TranscriptSource {
  const entries = parseSessionEntries(readFile(outputFile));
  const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
  const { messages, model, thinkingLevel } = buildSessionContext(sessionEntries);
  // Pi also reads the model off each assistant message, so a file whose messages
  // predate those fields yields a model object with neither set.
  const recorded: SessionModel = {
    model:
      model?.provider && model.modelId
        ? { provider: model.provider, id: model.modelId }
        : undefined,
    thinkingLevel,
  };
  return {
    getMessages: () => messages,
    subscribe: () => undefined,
    streaming: () => undefined,
    getToolDefinition: () => undefined,
    sessionModel: () => recorded,
  };
}

/** Source a transcript live from an in-memory record (this slice's only source). */
export function liveSource(record: NavigableSubagent): TranscriptSource {
  return {
    getMessages: () => record.agentMessages,
    subscribe: (onChange) => record.subscribeToUpdates(onChange),
    streaming: () =>
      isRunningStatus(record.status)
        ? { activeTools: record.activeTools, responseText: record.responseText }
        : undefined,
    getToolDefinition: (name) => record.getToolDefinition(name),
    sessionModel: () => ({ model: record.model, thinkingLevel: record.thinkingLevel }),
  };
}

function buildHeading(
  fields: Pick<LabelFields, "type" | "description">,
  registry: AgentConfigLookup,
): EntryHeading {
  return {
    name: getDisplayName(fields.type, registry),
    description: fields.description,
  };
}

function buildLabel(fields: LabelFields, registry: AgentConfigLookup, released = false): string {
  const name = getDisplayName(fields.type, registry);
  const duration = formatAgentDuration(fields.startedAt, fields.completedAt);
  const marker = released ? " · session released (snapshot)" : "";
  return `${name} (${fields.description}) · ${fields.toolUses} tools · ${displayStatus(fields.status, fields.outcome)} · ${duration}${marker}`;
}

/** Lines of transcript a text view keeps, from the end; earlier ones are counted. */
export const TRANSCRIPT_TEXT_LINES = 80;
/** Characters of one message a text view keeps. */
const TRANSCRIPT_TEXT_MESSAGE = 600;

/** The text a message carries, tool calls named, for a plain-text transcript. */
function messageText(message: SessionMessage): string | undefined {
  const { role, content } = message as { role: string; content?: unknown };
  const parts = Array.isArray(content) ? (content as ReadonlyArray<{ type: string }>) : [];
  const text =
    typeof content === "string"
      ? content
      : parts
          .map((part) => (part.type === "text" ? ((part as { text?: string }).text ?? "") : ""))
          .filter(Boolean)
          .join("\n");
  const clip = (value: string) =>
    value.length > TRANSCRIPT_TEXT_MESSAGE
      ? `${value.slice(0, TRANSCRIPT_TEXT_MESSAGE - 1)}…`
      : value;
  if (role === "user") return text ? `user: ${clip(text)}` : undefined;
  if (role === "assistant") {
    const { textParts, toolNames } = extractAssistantContent(parts);
    const lines = [
      ...(textParts.length ? [`assistant: ${clip(textParts.join("\n"))}`] : []),
      ...toolNames.map((name) => `  [tool call: ${name}]`),
    ];
    return lines.length ? lines.join("\n") : undefined;
  }
  if (role === "toolResult") {
    const { toolName, isError } = message as { toolName?: string; isError?: boolean };
    const first = text.split("\n", 1)[0] ?? "";
    return `  [${toolName ?? "tool"} ${isError ? "failed" : "result"}] ${clip(first)}`.trimEnd();
  }
  return undefined;
}

/**
 * A subagent's transcript as plain text, for a host without the terminal pane:
 * the heading, then the last `TRANSCRIPT_TEXT_LINES` lines of messages (tool
 * calls and result first lines only), then what a running agent is doing now.
 */
export function transcriptText(
  heading: EntryHeading,
  source: Pick<TranscriptSource, "getMessages" | "streaming">,
): string {
  const lines = source.getMessages().flatMap((message) => messageText(message)?.split("\n") ?? []);
  const kept = lines.slice(-TRANSCRIPT_TEXT_LINES);
  const streaming = source.streaming();
  return [
    `${heading.name} (${heading.description})`,
    ...(lines.length > kept.length
      ? [`… ${lines.length - kept.length} earlier lines not shown`]
      : []),
    ...(kept.length ? kept : ["(no messages yet)"]),
    ...(streaming
      ? [
          ...(streaming.activeTools.size
            ? [`running: ${[...streaming.activeTools.values()].join(", ")}`]
            : []),
          ...(streaming.responseText ? [`writing: ${streaming.responseText.slice(-200)}`] : []),
        ]
      : []),
  ].join("\n");
}
