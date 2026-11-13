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
  GitSection,
  Questionnaire,
  QuestionnaireAnswer,
  SessionSnapshot,
  SessionStatus,
  StashPreview,
  StashSection,
  SubagentsSection,
  SubagentState,
  TodoHistory,
  TodoSection,
  TodoStatus,
} from "../packages/pi-presentation/src/contract.ts";

const threadId = z.string().min(1).max(128);

/** One connected (or fixture) session in the sessions list. */
export interface SessionSummary {
  threadId: string;
  /** Live: a Pi process is connected now. Fixture: installed by `bb pi-surface fixture`. */
  source: "live" | "fixture";
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
  source: "live" | "fixture" | null;
  connected: boolean;
}

/** Requests the app may forward to a session; the same shapes pi-bb accepts. */
export const requestSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("stash-preview"), name: z.string().min(1).max(200) }).strict(),
  z.object({ command: z.literal("todo-history"), key: z.string().min(1).max(200) }).strict(),
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
