import type {
  ActivitySection,
  MemorySection,
  Questionnaire,
  SessionSnapshot,
  SessionStatus,
  StashSection,
  SubagentsSection,
  TerminalInfo,
  TodoSection,
  UsageSection,
} from "./protocol.ts";

/** Written by pi-subagents when a session starts with `--agent`. */
const MAIN_AGENT_ENTRY = "pi-subagents:main-agent-profile";
const MAX_TEXT = 200;

export interface SnapshotSource {
  cwd: string;
  sessionManager: { getSessionId(): string; getBranch(): Iterable<unknown> };
  model?: { provider: string; id: string; name?: string };
  getContextUsage():
    | { tokens: number | null; contextWindow: number; percent: number | null }
    | undefined;
}

export interface SnapshotInput {
  id: string;
  pid: number;
  startedAt: number;
  piVersion?: string;
  ctx: SnapshotSource;
  sessionName?: string;
  thinking?: string;
  status: SessionStatus & { since: number };
  todos?: TodoSection;
  stash?: StashSection;
  usage?: UsageSection;
  memory?: MemorySection;
  subagents?: SubagentsSection;
  terminal?: TerminalInfo;
  activity?: ActivitySection;
  questions?: Questionnaire[];
}

/** Collapses whitespace and caps length; names and titles are user and model text. */
export function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // oxlint-disable-next-line no-control-regex -- Intentionally matches terminal control characters.
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim();
  return text ? text.slice(0, MAX_TEXT) : undefined;
}

/** The latest main-agent profile on the branch, if the session runs one. */
export function agentName(branch: Iterable<unknown>): string | undefined {
  let name: string | undefined;
  for (const entry of branch) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as {
      type?: unknown;
      customType?: unknown;
      data?: { profile?: { name?: unknown } };
    };
    if (item.type === "custom" && item.customType === MAIN_AGENT_ENTRY)
      name = cleanText(item.data?.profile?.name);
  }
  return name;
}

export function buildSnapshot(input: SnapshotInput): SessionSnapshot {
  const { ctx } = input;
  const usage = ctx.getContextUsage();
  const agent = agentName(ctx.sessionManager.getBranch());
  const name = cleanText(input.sessionName);
  const title = input.status.kind === "waiting" ? cleanText(input.status.title) : undefined;
  const status =
    input.status.kind === "waiting"
      ? { kind: "waiting" as const, since: input.status.since, ...(title ? { title } : {}) }
      : input.status;
  return {
    id: input.id,
    pid: input.pid,
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
    ...(name ? { name } : {}),
    ...(agent ? { agent } : {}),
    ...(ctx.model
      ? {
          model: {
            provider: ctx.model.provider,
            id: ctx.model.id,
            ...(ctx.model.name ? { name: ctx.model.name } : {}),
          },
        }
      : {}),
    ...(input.thinking ? { thinking: input.thinking } : {}),
    status,
    ...(usage
      ? { context: { tokens: usage.tokens, window: usage.contextWindow, percent: usage.percent } }
      : {}),
    startedAt: input.startedAt,
    ...(input.piVersion ? { piVersion: input.piVersion } : {}),
    ...(input.todos ? { todos: input.todos } : {}),
    ...(input.stash ? { stash: input.stash } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.memory ? { memory: input.memory } : {}),
    ...(input.subagents ? { subagents: input.subagents } : {}),
    ...(input.terminal ? { terminal: input.terminal } : {}),
    ...(input.activity ? { activity: input.activity } : {}),
    ...(input.questions ? { questions: input.questions } : {}),
  };
}
