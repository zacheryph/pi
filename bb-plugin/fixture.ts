// A canned, realistic session for `bb pi-surface fixture`, so every slot can be
// seen without a model run. Names and paths are invented.
import type {
  SessionSnapshot,
  StashPreview,
  SurfaceRequest,
  TodoHistory,
  TodoStatus,
} from "./contract.ts";

const MINUTE = 60_000;

const stashHandle = (name: string) => `stash:${name}@3f9c2a81d0e4`;

interface FixtureTask {
  key: string;
  subject: string;
  status: TodoStatus;
  blocked?: boolean;
  description?: string;
  message?: string;
  dependsOn?: string[];
  history: Array<{ status: TodoStatus; from?: TodoStatus; message?: string; minutesAgo: number }>;
}

const TASKS: FixtureTask[] = [
  {
    key: "schema",
    subject: "Add the delivery_attempts table",
    status: "completed",
    message: "Migration 0042 adds attempts with a (webhook_id, attempt) key.",
    history: [
      { status: "in_progress", from: "pending", minutesAgo: 52 },
      {
        status: "completed",
        from: "in_progress",
        message: "Migration 0042 adds attempts with a (webhook_id, attempt) key.",
        minutesAgo: 41,
      },
    ],
  },
  {
    key: "backoff",
    subject: "Exponential backoff with jitter",
    status: "completed",
    message: "Base 2 s, cap 10 min, full jitter.",
    history: [
      { status: "in_progress", from: "pending", minutesAgo: 40 },
      {
        status: "completed",
        from: "in_progress",
        message: "Base 2 s, cap 10 min, full jitter.",
        minutesAgo: 28,
      },
    ],
  },
  {
    key: "dead-letter",
    subject: "Dead-letter after 8 attempts",
    status: "completed",
    history: [
      { status: "in_progress", from: "pending", minutesAgo: 27 },
      { status: "completed", from: "in_progress", minutesAgo: 19 },
    ],
  },
  {
    key: "worker",
    subject: "Move retries into the queue worker",
    status: "in_progress",
    description: "Replace the inline retry loop in deliver() with jobs on the retry queue.",
    message: "Worker picks up due attempts; wiring the ack path now.",
    history: [
      { status: "in_progress", from: "pending", minutesAgo: 18 },
      {
        status: "in_progress",
        message: "Worker picks up due attempts; wiring the ack path now.",
        minutesAgo: 4,
      },
    ],
  },
  {
    key: "tests",
    subject: "Retry and dead-letter tests",
    status: "pending",
    dependsOn: ["worker"],
    blocked: true,
    history: [],
  },
  { key: "metrics", subject: "Emit retry metrics", status: "pending", history: [] },
  { key: "docs", subject: "Document the retry policy", status: "pending", history: [] },
];

const STASH = [
  {
    name: "delivery-paths",
    description: "Every call site that sends a webhook, with file and line",
    source: "tool:subagent",
    lines: 64,
    bytes: 4_812,
    minutesAgo: 35,
    preview: [
      "src/webhooks/deliver.ts:42   deliver(event, endpoint)",
      "src/webhooks/deliver.ts:118  retryInline(attempt)",
      "src/billing/notify.ts:77     deliver(invoiceEvent, account.hook)",
      "src/admin/replay.ts:23       deliver(stored.event, stored.endpoint)",
    ],
  },
  {
    name: "queue-schema",
    description: "Current retry queue schema and indexes",
    source: "path:db/schema/retry_queue.sql",
    lines: 38,
    bytes: 1_604,
    minutesAgo: 47,
    preview: [
      "CREATE TABLE retry_queue (",
      "  id bigserial PRIMARY KEY,",
      "  webhook_id bigint NOT NULL,",
      "  due_at timestamptz NOT NULL,",
    ],
  },
  {
    name: "flaky-test-log",
    description: "Failing run of deliver.test.ts",
    source: "tool:bash",
    lines: 212,
    bytes: 18_340,
    minutesAgo: 12,
    preview: [
      "FAIL test/deliver.test.ts > retries a 503 three times",
      "  expected 3 attempts, received 2",
      "  at test/deliver.test.ts:88:21",
    ],
  },
  {
    name: "review-notes",
    description: "Reviewer findings on the schema change",
    source: "content",
    lines: 22,
    bytes: 1_190,
    minutesAgo: 6,
    preview: [
      "1. delivery_attempts needs an index on (due_at) for the worker scan.",
      "2. Keep attempt numbers 1-based to match the API docs.",
    ],
  },
];

/** A full session snapshot with every section filled, timed relative to `now`. */
export function fixtureSnapshot(now = Date.now()): SessionSnapshot {
  const ago = (minutes: number) => now - minutes * MINUTE;
  return {
    id: "fixture",
    pid: 0,
    sessionId: "fixture-session",
    cwd: "/work/webhooks",
    name: "Webhook retry queue",
    agent: "orchestrate",
    model: { provider: "anthropic", id: "claude-opus", name: "Claude Opus" },
    thinking: "high",
    status: { kind: "tool", tool: "bash", since: ago(1) },
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    startedAt: ago(55),
    piVersion: "1.5.2",
    todos: {
      revision: 14,
      total: TASKS.length,
      tasks: TASKS.map((task) => ({
        key: task.key,
        subject: task.subject,
        status: task.status,
        blocked: task.blocked ?? false,
        unreviewed: task.status === "completed" ? 1 : 0,
        ...(task.description ? { description: task.description } : {}),
        ...(task.dependsOn ? { dependsOn: task.dependsOn } : {}),
        ...(task.message
          ? { message: { text: task.message, at: ago(task.history.at(-1)?.minutesAgo ?? 0) } }
          : {}),
        ...(task.history.length ? { updatedAt: ago(task.history.at(-1)!.minutesAgo) } : {}),
      })),
    },
    stash: {
      total: STASH.length,
      entries: STASH.toSorted((a, b) => a.minutesAgo - b.minutesAgo).map((entry) => ({
        name: entry.name,
        handle: stashHandle(entry.name),
        bytes: entry.bytes,
        lines: entry.lines,
        mime: "text/plain",
        description: entry.description,
        source: entry.source,
        createdAt: ago(entry.minutesAgo),
        createdBy: "fixture-session",
        versions: 1,
      })),
      store: { bytes: 25_946, maxBytes: 50 * 1024 * 1024 },
    },
    git: {
      worktrees: [
        {
          path: "/work/.worktrees/webhooks/retry-worker",
          repo: "webhooks",
          branch: "feat/retry-worker",
          state: "active",
          agents: 2,
          dirty: true,
          unpushed: 3,
        },
        {
          path: "/work/.worktrees/webhooks/attempts-schema",
          repo: "webhooks",
          branch: "feat/attempts-schema",
          state: "active",
          agents: 1,
          mergedInto: "main",
        },
      ],
      worktreeTotal: 2,
      removed: 1,
      other: 0,
      prs: [
        {
          label: "acme/webhooks#212",
          url: "https://github.com/acme/webhooks/pull/212",
          title: "Retry webhooks from the queue worker",
          origin: "created",
          state: "open",
          draft: true,
          checks: { passed: 9, failed: 1, pending: 2 },
          mergeable: true,
          observedAt: ago(2),
          watching: "settled",
        },
        {
          label: "acme/webhooks#209",
          url: "https://github.com/acme/webhooks/pull/209",
          title: "Add delivery_attempts table",
          origin: "created",
          state: "merged",
          review: "approved",
          checks: { passed: 12, failed: 0, pending: 0 },
          observedAt: ago(30),
        },
        {
          label: "acme/platform#88",
          url: "https://github.com/acme/platform/pull/88",
          title: "Queue worker: graceful shutdown",
          origin: "referenced",
          state: "open",
          review: "review_required",
          checks: { passed: 7, failed: 0, pending: 0 },
          observedAt: ago(44),
        },
      ],
      prTotal: 3,
      openCreated: 1,
      failingCreated: 1,
    },
    usage: { input: 412_000, output: 38_500, cacheRead: 1_920_000, cacheWrite: 96_000, cost: 4.87 },
    subagents: {
      agents: [
        {
          id: "a1",
          type: "reviewer",
          description: "Review the attempts schema",
          state: "completed",
          since: ago(46),
          durationMs: 6 * MINUTE + 12_000,
          toolUses: 14,
          tokens: 48_200,
          note: "Two findings, stashed as review-notes.",
        },
        {
          id: "a2",
          type: "explore",
          description: "Map every webhook delivery path",
          state: "running",
          since: ago(9),
          toolUses: 23,
          tokens: 61_000,
          note: "Reading src/admin/replay.ts",
        },
        {
          id: "a3",
          type: "general-purpose",
          description: "Write retry backoff tests",
          state: "running",
          since: ago(3),
          toolUses: 6,
          tokens: 12_400,
          note: "Running npm test -- deliver",
        },
      ],
    },
    activity: [
      { tool: "bash", summary: "npm test -- test/deliver.test.ts", at: ago(1), running: true },
      { tool: "edit", summary: "src/webhooks/worker.ts", at: ago(2), durationMs: 140 },
      { tool: "read", summary: "src/webhooks/deliver.ts", at: ago(3), durationMs: 35 },
      { tool: "bash", summary: "git diff --stat", at: ago(5), durationMs: 410 },
      { tool: "stash_put", at: ago(6), durationMs: 22 },
      { tool: "bash", summary: "npm test", at: ago(12), durationMs: 41_000, error: true },
    ],
    questions: [
      {
        id: "fixture-ask-1",
        since: ago(1),
        questions: [
          {
            header: "Attempts",
            question: "How many delivery attempts before a webhook is dead-lettered?",
            multiSelect: false,
            options: [
              { label: "5", description: "Gives up within about 1 minute" },
              { label: "8", description: "Gives up within about 17 minutes (current plan)" },
              { label: "12", description: "Keeps trying for about 4 hours" },
            ],
          },
          {
            header: "Signals",
            question: "Which failures should be retried?",
            multiSelect: true,
            options: [
              { label: "5xx responses", description: "Server errors from the endpoint" },
              { label: "Timeouts", description: "No response within 10 seconds" },
              { label: "429 Too Many Requests", description: "Honor Retry-After when present" },
            ],
          },
        ],
      },
    ],
  };
}

/** Answers what a real session would, from the same canned data. */
export function fixtureResponder(now = Date.now()) {
  return (request: SurfaceRequest): unknown => {
    switch (request.command) {
      case "stash-preview": {
        const entry = STASH.find((candidate) => candidate.name === request.name);
        if (!entry) throw new Error(`No stash entry named "${request.name}" on this branch.`);
        return {
          handle: stashHandle(entry.name),
          lines: entry.preview,
          total: entry.lines,
          complete: entry.preview.length >= entry.lines,
        } satisfies StashPreview;
      }
      case "todo-history": {
        const task = TASKS.find((candidate) => candidate.key === request.key);
        if (!task) throw new Error(`No task "${request.key}" on this branch.`);
        return {
          key: task.key,
          createdAt: now - 55 * MINUTE,
          updates: task.history.map((update, index) => ({
            revision: index + 2,
            at: now - update.minutesAgo * MINUTE,
            status: update.status,
            ...(update.from ? { from: update.from } : {}),
            ...(update.message ? { message: update.message } : {}),
          })),
        } satisfies TodoHistory;
      }
      case "answer":
        throw new Error("This is a fixture session; answers go nowhere.");
    }
  };
}
