import { defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const task = z.object({
  key: z.string(),
  subject: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  blocked: z.boolean(),
  unreviewed: z.number(),
  description: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  message: z.object({ text: z.string(), at: z.number().optional() }).optional(),
});
export const agent = z.object({
  id: z.string(),
  type: z.string(),
  description: z.string(),
  state: z.enum(["queued", "running", "waiting", "completed", "failed", "stopped"]),
  since: z.number(),
  durationMs: z.number().optional(),
  toolUses: z.number().optional(),
  tokens: z.number().optional(),
  note: z.string().optional(),
});
export const stateSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  todos: z
    .object({ revision: z.number(), total: z.number(), tasks: z.array(task).max(100) })
    .optional(),
  subagents: z.object({ agents: z.array(agent).max(100) }).optional(),
});
export type HarnessState = z.output<typeof stateSchema>;
export const stateWatch = defineSubscription({
  name: "pi.state",
  input: z.object({ agentId: z.string().min(1) }),
  event: z.discriminatedUnion("type", [
    z.object({ type: z.literal("state"), state: stateSchema }),
    z.object({ type: z.literal("unavailable"), message: z.string() }),
  ]),
});
