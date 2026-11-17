import type {
  SessionActivity,
  SessionContext,
  SessionModel,
  SessionModelRef,
  SessionStatus,
  SessionUsage,
} from "#surface";
import { cleanText } from "#src/session/text";

/** The parts of Pi's extension context the session view reads. */
export interface SessionSource {
  cwd: string;
  sessionManager: { getSessionId(): string };
  model?: { provider?: unknown; id?: unknown; name?: unknown };
  getContextUsage():
    | { tokens: number | null; contextWindow: number; percent: number | null }
    | undefined;
}

export interface SessionModelInput {
  ctx: SessionSource;
  /** The session's name, from `pi.getSessionName()`. */
  name?: unknown;
  /** The thinking level, from `pi.getThinkingLevel()`. */
  thinking?: unknown;
  status: SessionStatus;
  activity?: SessionActivity[];
  usage?: SessionUsage;
  startedAt: number;
  piVersion?: unknown;
}

const amount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function modelRef(model: SessionSource["model"]): SessionModelRef | undefined {
  const provider = cleanText(model?.provider);
  const id = cleanText(model?.id);
  if (!provider || !id) return undefined;
  const name = cleanText(model?.name);
  return { provider, id, ...(name ? { name } : {}) };
}

function contextUsage(usage: ReturnType<SessionSource["getContextUsage"]>) {
  if (!usage || !amount(usage.contextWindow)) return undefined;
  return {
    tokens: amount(usage.tokens) ? usage.tokens : null,
    window: usage.contextWindow,
    percent: amount(usage.percent) ? usage.percent : null,
  } satisfies SessionContext;
}

/**
 * The `system.session` model from the current context and the observer's
 * trackers. What Pi does not know yet (no model selected, no context window,
 * no version) is left out, so the result is always a valid `SessionModel`.
 * `undefined` only when the session has no usable id.
 */
export function buildSessionModel(input: SessionModelInput): SessionModel | undefined {
  const { ctx } = input;
  const sessionId = ctx.sessionManager.getSessionId();
  if (typeof sessionId !== "string" || !sessionId.trim()) return undefined;
  const name = cleanText(input.name);
  const model = modelRef(ctx.model);
  const thinking = cleanText(input.thinking, 32);
  const context = contextUsage(ctx.getContextUsage());
  const piVersion = cleanText(input.piVersion, 64);
  return {
    sessionId,
    cwd: typeof ctx.cwd === "string" ? ctx.cwd : "",
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(context ? { context } : {}),
    status: input.status,
    ...(input.activity?.length ? { activity: input.activity } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
    startedAt: input.startedAt,
    ...(piVersion ? { piVersion } : {}),
  };
}
