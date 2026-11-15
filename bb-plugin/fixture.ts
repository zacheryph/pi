// A canned, realistic session for `bb pi-surface fixture`, so every slot can be
// seen without a model run. Names and paths are invented.
import type {
  Block,
  ExplorerModel,
  JsonValue,
  Line,
  SessionSnapshot,
  StateIcon,
  SurfaceRequest,
  SubagentState,
  TodoStatus,
  Tone,
  ViewSummary,
  WidgetModel,
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
  /** The subagent holding the task, as pi-todo labels it. */
  assignee?: string;
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
    assignee: "agent a3f2b1c4",
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

/** A full session snapshot with every section and view filled, timed relative to `now`. */
export function fixtureSnapshot(now = Date.now()): SessionSnapshot {
  const sections = fixtureSections(now);
  return { ...sections, views: fixtureViews(sections, now) };
}

function fixtureSections(now: number): SessionSnapshot {
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
          id: "a3f2b1c4",
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

/** `mm:ss`, as pi-subagent's clock reads. */
function clockText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

// ── Views ──────────────────────────────────────────────────────────────────
// What the bundle's extensions offer for the data above, shaped as they shape it.

const TASK_STATUS: Record<
  TodoStatus,
  { glyph: string; label: string; tone: Tone; icon: StateIcon }
> = {
  completed: { glyph: "✓", label: "completed", tone: "success", icon: "done" },
  in_progress: { glyph: "▸", label: "in_progress", tone: "accent", icon: "active" },
  pending: { glyph: "○", label: "pending", tone: "dim", icon: "pending" },
};

function taskStatus(task: FixtureTask) {
  return task.blocked
    ? { glyph: "○", label: "blocked", tone: "warning" as const, icon: "blocked" as const }
    : TASK_STATUS[task.status];
}

const AGENT_STATE: Record<SubagentState, { label: string; tone: Tone }> = {
  queued: { label: "queued", tone: "dim" },
  running: { label: "running", tone: "accent" },
  waiting: { label: "waiting", tone: "muted" },
  completed: { label: "done", tone: "success" },
  failed: { label: "error", tone: "error" },
  stopped: { label: "stopped", tone: "dim" },
};

/** `2 active / 3 pending`, as pi-ui's `stateCounts` reads, leaving out zeros. */
function stateCounts(active: number, pending: number): Line[] {
  const parts = [
    ...(active ? [`${active} active`] : []),
    ...(pending ? [`${pending} pending`] : []),
  ];
  return parts.length ? [{ text: parts.join(" / "), tone: "muted" }] : [];
}

function fixtureViews(snapshot: SessionSnapshot, now: number): ViewSummary[] {
  const count = (status: TodoStatus) => TASKS.filter((task) => task.status === status).length;
  const todoWidget: WidgetModel = {
    title: { label: "Todos" },
    active: true,
    meta: stateCounts(count("in_progress"), count("pending")),
    // Finished tasks with unreviewed messages stay in the widget, as in pi-todo's.
    rows: TASKS.map((task) => {
      const status = taskStatus(task);
      const glyph = { text: status.glyph, tone: status.tone, icon: status.icon };
      const full = [glyph, { text: ` ${status.label}`, tone: status.tone }];
      const badge = task.assignee
        ? [{ text: `→ ${task.assignee} · `, tone: "muted" as const }]
        : [];
      return {
        // As pi-todo builds it: the key bold, the glyph standing for the task's state.
        left: [
          { text: task.key, bold: true },
          `: ${task.subject}${task.dependsOn ? ` ← ${task.dependsOn.join(", ")}` : ""}`,
        ],
        right: [
          ...(task.assignee
            ? [
                [...badge, ...full],
                [...badge, glyph],
              ]
            : []),
          full,
          [glyph],
        ],
        keepRight: true,
      };
    }),
    emptyText: "No unfinished tasks",
  };
  const unreviewed = TASKS.filter((task) => task.status === "completed");
  const todoExplorer: ExplorerModel = {
    title: "Todos",
    noun: ["task", "tasks"],
    notices: [{ text: "Read-only task snapshot · last reviewed 50m ago", tone: "muted" }],
    items: TASKS.map((task) => {
      const status = taskStatus(task);
      return {
        id: task.key,
        label: `${task.key}: ${task.subject}${task.dependsOn ? ` ← ${task.dependsOn.join(", ")}` : ""}`,
        badge: { text: `${status.glyph} ${status.label}`, tone: status.tone },
        marked: task.status === "completed",
      };
    }),
    tabs: [
      { label: "All", ids: TASKS.map((task) => task.key) },
      { label: "Unreviewed", ids: unreviewed.map((task) => task.key) },
    ],
    marker: {
      label: "unreviewed",
      clearAction: "mark reviewed",
      onClear: { action: "todo.review", args: { branch: 1 } },
    },
    loadDetail: { action: "todo.inspect" },
  };
  const agents = snapshot.subagents?.agents ?? [];
  const running = agents.filter((agent) => agent.state === "running");
  const queued = agents.filter((agent) => agent.state === "queued");
  const subagentWidget: WidgetModel = {
    title: { label: "Subagents" },
    active: running.length > 0,
    meta: stateCounts(running.length, queued.length),
    rows: running.map((agent) => ({
      // As pi-subagent builds it: the clock leads, and while it runs it carries its start.
      lead: { text: clockText(now - agent.since), tone: "dim", since: agent.since },
      left: [{ text: agent.type, bold: true }, ": ", { text: agent.description, tone: "muted" }],
      right: [
        [
          { text: "●", tone: "accent", icon: "active" },
          { text: ` ${agent.note ?? "thinking…"}`, tone: "muted" },
        ],
      ],
      group: "running",
    })),
  };
  const subagentExplorer: ExplorerModel = {
    title: "Subagents",
    noun: ["subagent", "subagents"],
    items: agents.map((agent) => {
      const state = AGENT_STATE[agent.state];
      return {
        id: agent.id,
        label: [
          { text: agent.type, tone: "accent" },
          { text: ` — ${agent.description}`, tone: "muted" },
        ],
        badge: { text: state.label, tone: state.tone },
        detail: [
          {
            fields: [
              ["Agent", agent.type],
              ["Id", agent.id],
              ["State", { text: state.label, tone: state.tone }],
              ["Tool uses", String(agent.toolUses ?? 0)],
              ...(agent.tokens ? ([["Tokens", String(agent.tokens)]] as const) : []),
            ],
          },
          ...(agent.note
            ? [
                { heading: agent.state === "running" ? "Latest update" : "Note" },
                { text: agent.note },
              ]
            : []),
        ],
      };
    }),
    tabs: [
      { label: "All", ids: agents.map((agent) => agent.id) },
      { label: "Active", ids: running.map((agent) => agent.id) },
    ],
  };
  const stashExplorer: ExplorerModel = {
    title: "Stash",
    noun: ["entry", "entries"],
    notices: [{ text: "25.3 KB stored on this branch", tone: "muted" }],
    items: (snapshot.stash?.entries ?? []).map((entry) => ({
      id: entry.handle,
      label: [
        { text: entry.handle, tone: "accent" },
        ...(entry.description ? [{ text: ` — ${entry.description}`, tone: "muted" as const }] : []),
      ],
      badge: { text: `${entry.lines} lines · ${Math.round((now - entry.createdAt) / MINUTE)}m` },
    })),
    loadDetail: { action: "stash.inspect" },
  };
  const git = snapshot.git;
  const worktrees: ExplorerModel = {
    title: "Git worktrees",
    noun: ["worktree", "worktrees"],
    items: (git?.worktrees ?? []).map((worktree) => {
      const state = worktree.mergedInto
        ? `merged into ${worktree.mergedInto}`
        : [
            worktree.dirty ? "uncommitted changes" : "",
            worktree.unpushed ? `${worktree.unpushed} unpushed` : "",
          ]
            .filter(Boolean)
            .join("; ") || "clean";
      const tone: Tone = worktree.dirty || worktree.unpushed ? "warning" : "success";
      return {
        id: worktree.path,
        label: [
          { text: `${worktree.repo} @ ${worktree.branch}`, tone: "accent" },
          { text: ` — ${worktree.path}`, tone: "muted" },
        ],
        badge: { text: state, tone },
        detail: [
          {
            fields: [
              ["Path", worktree.path],
              ["Branch", worktree.branch],
              ["State", { text: state, tone }],
            ],
          },
        ],
      };
    }),
  };
  const prs: ExplorerModel = {
    title: "Pull requests",
    noun: ["pull request", "pull requests"],
    items: (git?.prs ?? []).map((pr) => {
      const failing = (pr.checks?.failed ?? 0) > 0;
      const status = [
        pr.draft ? "draft" : pr.state,
        ...(pr.checks
          ? [`checks ${pr.checks.passed}✓ ${pr.checks.failed}✗ · ${pr.checks.pending} pending`]
          : []),
      ]
        .filter(Boolean)
        .join(" · ");
      const tone: Tone = pr.state === "merged" ? "success" : failing ? "error" : "default";
      return {
        id: pr.url,
        label: [
          { text: pr.label, tone: "accent" },
          ...(pr.title ? [{ text: ` — ${pr.title}`, tone: "muted" as const }] : []),
        ],
        badge: { text: status, tone },
        detail: [
          {
            fields: [
              ["URL", pr.url],
              ...(pr.title ? ([["Title", pr.title]] as const) : []),
              ["Status", { text: status, tone }],
              ["Origin", pr.origin === "created" ? "opened in this session" : "referenced"],
            ],
          },
        ],
      };
    }),
    tabs: [
      {
        label: "Opened here",
        ids: (git?.prs ?? []).filter((pr) => pr.origin === "created").map((pr) => pr.url),
      },
      {
        label: "Referenced",
        ids: (git?.prs ?? []).filter((pr) => pr.origin === "referenced").map((pr) => pr.url),
      },
    ],
  };
  return [
    { id: "git.prs", kind: "explorer", title: "Pull requests", model: prs },
    { id: "git.worktrees", kind: "explorer", title: "Git worktrees", model: worktrees },
    { id: "stash.explorer", kind: "explorer", title: "Stash", model: stashExplorer },
    { id: "subagent.explorer", kind: "explorer", title: "Subagents", model: subagentExplorer },
    { id: "subagent.widget", kind: "widget", title: "Subagents", model: subagentWidget },
    { id: "todo.explorer", kind: "explorer", title: "Todos", model: todoExplorer },
    { id: "todo.widget", kind: "widget", title: "Tasks", model: todoWidget },
  ];
}

function idArg(args: JsonValue | undefined): string {
  const id = (args as { id?: unknown } | null | undefined)?.id;
  if (typeof id !== "string") throw new Error("expected { id }");
  return id;
}

/** Answers what a real session would, from the same canned data. */
export function fixtureResponder(now = Date.now()) {
  const at = (minutes: number) => new Date(now - minutes * MINUTE).toISOString();
  return (request: SurfaceRequest): unknown => {
    if (request.command === "answer")
      throw new Error("This is a fixture session; answers go nowhere.");
    switch (request.id) {
      case "todo.inspect": {
        const key = idArg(request.args);
        const task = TASKS.find((candidate) => candidate.key === key);
        if (!task) throw new Error(`No task "${key}" on this branch.`);
        const status = taskStatus(task);
        const blocks: Block[] = [
          {
            fields: [
              ["Status", { text: status.label, tone: status.tone }],
              ...(task.assignee ? ([["Assigned to", task.assignee]] as const) : []),
              ...(task.dependsOn ? ([["Depends on", task.dependsOn.join(", ")]] as const) : []),
            ],
          },
          ...(task.description ? [{ text: task.description }] : []),
          { heading: "History" },
          task.history.length
            ? {
                bullets: task.history.map(
                  (update) =>
                    `${at(update.minutesAgo)} · ${update.from ? `${update.from} → ` : ""}${update.status}${update.message ? ` · ${update.message}` : ""}`,
                ),
              }
            : { text: "No updates yet.", tone: "muted" },
        ];
        return blocks;
      }
      case "stash.inspect": {
        const handle = idArg(request.args);
        const entry = STASH.find((candidate) => stashHandle(candidate.name) === handle);
        if (!entry) throw new Error(`No stash entry "${handle}" on this branch.`);
        const blocks: Block[] = [
          {
            fields: [
              ["Handle", handle],
              ["Source", entry.source],
              ["Size", `${entry.lines} lines, ${entry.bytes} bytes`],
            ],
          },
          { lines: entry.preview, numbered: true },
          ...(entry.preview.length < entry.lines
            ? [{ text: `Preview stops here; ${entry.lines} lines total.`, tone: "muted" as const }]
            : []),
        ];
        return blocks;
      }
      case "todo.review":
        return { reviewed: 1 };
      default:
        throw new Error(`Unknown action "${request.id}".`);
    }
  };
}
