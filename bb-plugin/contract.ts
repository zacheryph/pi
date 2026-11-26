// The app's RPC surface. Shared by server.ts and the React slots; the live
// query hooks need the contract value, so this module stays free of server code.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { DeliverySnapshot } from "pi-surface/delivery";
import type { SessionStatusKind } from "pi-surface/session";

// pi-surface's portable models, as types only: the wire carries them as JSON.
export type { JsonObject, JsonValue } from "pi-surface/json";
export type {
  ActionRef,
  Badge,
  Block,
  DetailContent,
  DetailModel,
  ExplorerItem,
  ExplorerModel,
  ExplorerTab,
  Line,
  Span,
  StateIcon,
  Title,
  Tone,
  WidgetModel,
  WidgetRow,
} from "pi-surface/model";
export type {
  SessionActivity,
  SessionModel,
  SessionStatus,
  SessionStatusKind,
  SessionUsage,
} from "pi-surface/session";
export type { SummaryCount, SummaryModel, SummaryProfile } from "pi-surface/summary";
export type {
  FormAnswer,
  FormModel,
  FormQuestion,
  FormQuestionAnswer,
  FormQuestionnaire,
} from "pi-surface/form";
export type { AttentionItem, AttentionLink, AttentionModel } from "pi-surface/attention";
export type { ActionRequest, ActionResult, DeliverySnapshot, ViewEntry } from "pi-surface/delivery";

const threadId = z.string().min(1).max(128);

/** One connected (or fixture, or saved) session in the sessions list, read from its views. */
export interface SessionSummary {
  threadId: string;
  /**
   * Live: a Pi process reports for the thread. Saved: no Pi runs for it now
   * (bb restarted, or stopped it), and this is what it last reported. Fixture:
   * installed by `bb pi-surface fixture`.
   */
  source: "live" | "fixture" | "saved";
  /** False during the grace period after the session's socket closed. */
  connected: boolean;
  updatedAt: number;
  /** From the `system.session` view; absent when the session has none. */
  cwd?: string;
  name?: string;
  model?: string;
  status?: SessionStatusKind;
  /** The main agent's profile, from `subagent.summary`. */
  profile?: string;
  /** From `todo.summary`, while the plan has tasks. */
  todos?: { done: number; total: number; active?: string };
  /** Subagents queued or running, from `subagent.summary`. */
  runningAgents: number;
  /** Open questionnaires in the session's form views. */
  questions: number;
}

export interface SnapshotResult {
  snapshot: DeliverySnapshot | null;
  source: "live" | "fixture" | "saved" | null;
  connected: boolean;
}

/** `<extension>.<verb>`, as pi-surface defines an action id. */
const actionId = z
  .string()
  .max(200)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/);

/** An action the app asks a session to run: pi-surface's `ActionRequest`, as pi-bb accepts it. */
export const requestSchema = z.object({ action: actionId, args: z.json().optional() }).strict();
export type SurfaceRequest = z.infer<typeof requestSchema>;

export const rpcContract = defineRpcContract({
  snapshot: {
    input: z.object({ threadId }).strict(),
    // Server-produced and checked when it arrived from the session.
    output: z.custom<SnapshotResult>((value) => typeof value === "object" && value !== null),
    tags: ({ threadId }) => [`thread:${threadId}`],
  },
  sessions: {
    input: z.null(),
    output: z.object({ sessions: z.array(z.custom<SessionSummary>()) }),
    tags: () => ["sessions"],
  },
  /** Runs an action on the thread's session; resolves to its result, `null` for none. */
  request: {
    input: z.object({ threadId, request: requestSchema }).strict(),
    output: z.object({ value: z.json() }),
  },
});

export type RpcContract = typeof rpcContract;
