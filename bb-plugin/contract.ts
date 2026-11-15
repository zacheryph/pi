// The app's RPC surface. Shared by server.ts and the React slots; the live
// query hooks need the contract value, so this module stays free of server code.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type {
  QuestionnaireAnswer,
  SessionSnapshot,
  SessionStatus,
} from "../packages/pi-presentation/src/contract.ts";

export type {
  ActionRef,
  Badge,
  Block,
  DetailContent,
  DetailModel,
  ExplorerItem,
  ExplorerModel,
  GitSection,
  JsonObject,
  JsonValue,
  Line,
  Questionnaire,
  QuestionnaireAnswer,
  SessionSnapshot,
  SessionStatus,
  StashSection,
  SubagentsSection,
  SubagentState,
  TodoSection,
  TodoStatus,
  Span,
  StateIcon,
  Title,
  Tone,
  ViewSummary,
  WidgetModel,
  WidgetRow,
} from "../packages/pi-presentation/src/contract.ts";

const threadId = z.string().min(1).max(128);

/** One connected (or fixture) session in the sessions list. */
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
  cwd: string;
  name?: string;
  agent?: string;
  model?: string;
  status: SessionStatus["kind"];
  todos?: { done: number; total: number; active?: string };
  /** Subagents queued or running. */
  runningAgents: number;
  questions: number;
}

export interface SnapshotResult {
  snapshot: SessionSnapshot | null;
  source: "live" | "fixture" | "saved" | null;
  connected: boolean;
}

/** `<extension>.<verb>`, as pi-surface defines an action id. */
const actionId = z
  .string()
  .max(200)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/);

/** Requests the app may forward to a session; the same shapes pi-bb accepts. */
export const requestSchema = z.discriminatedUnion("command", [
  /** Run an action on the session's bus, e.g. an explorer's `loadDetail` with `{ id }`. */
  z.object({ command: z.literal("action"), id: actionId, args: z.json().optional() }).strict(),
  z
    .object({
      command: z.literal("answer"),
      question: z.string().min(1).max(200),
      answer: z.custom<QuestionnaireAnswer>(
        (value) => typeof value === "object" && value !== null && !Array.isArray(value),
      ),
    })
    .strict(),
]);
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
  request: {
    input: z.object({ threadId, request: requestSchema }).strict(),
    output: z.object({ data: z.json() }),
  },
});

export type RpcContract = typeof rpcContract;
