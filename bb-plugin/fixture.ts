// A canned, realistic session for `bb pi-surface fixture`, so every slot can be
// seen without a model run. It is one pi-surface delivery snapshot: the views
// the bundle's extensions publish, shaped as they shape them, with the same
// `live` marks. Names and paths are invented.
import { formatBytes } from "pi-surface/format";
import type {
  ActionRequest,
  AttentionModel,
  Block,
  DeliverySnapshot,
  ExplorerModel,
  ExplorerTab,
  FormModel,
  JsonValue,
  Line,
  SessionModel,
  StateIcon,
  SummaryModel,
  Tone,
  ViewEntry,
  WidgetModel,
  WidgetRow,
} from "./contract.ts";

const MINUTE = 60_000;

type TodoStatus = "pending" | "in_progress" | "completed";
type AgentState = "queued" | "running" | "waiting" | "completed" | "failed" | "stopped";

const stashHandle = (name: string) => `stash:${name}@3f9c2a81d0e4`;

/** A count's noun as its producer labels it: singular for one, plural otherwise. */
const agree = (value: number, one: string, many = `${one}s`) => (value === 1 ? one : many);

interface FixtureTask {
  key: string;
  subject: string;
  status: TodoStatus;
  blocked?: boolean;
  description?: string;
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

interface FixtureAgent {
  id: string;
  type: string;
  description: string;
  state: AgentState;
  minutesAgo: number;
  durationMs?: number;
  toolUses: number;
  tokens: number;
  note: string;
}

const AGENTS: FixtureAgent[] = [
  {
    id: "a1",
    type: "reviewer",
    description: "Review the attempts schema",
    state: "completed",
    minutesAgo: 46,
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
    minutesAgo: 9,
    toolUses: 23,
    tokens: 61_000,
    note: "Reading src/admin/replay.ts",
  },
  {
    id: "a3f2b1c4",
    type: "general-purpose",
    description: "Write retry backoff tests",
    state: "running",
    minutesAgo: 3,
    toolUses: 6,
    tokens: 12_400,
    note: "Running npm test -- deliver",
  },
];

const WORKTREES = [
  {
    path: "/work/.worktrees/webhooks/retry-worker",
    repo: "webhooks",
    branch: "feat/retry-worker",
    status: "uncommitted changes; 3 unpushed commits",
    tone: "warning" as Tone,
    agents: ["a2", "a3f2b1c4"],
  },
  {
    path: "/work/.worktrees/webhooks/attempts-schema",
    repo: "webhooks",
    branch: "feat/attempts-schema",
    status: "clean; merged into main",
    tone: "success" as Tone,
    agents: ["a1"],
  },
];

type FixturePr = {
  label: string;
  url: string;
  title: string;
  origin: "created" | "referenced";
  state: "open" | "merged" | "closed";
  draft?: boolean;
  approved?: boolean;
  status: string;
  tone: Tone;
};

const PRS: readonly FixturePr[] = [
  {
    label: "acme/webhooks#212",
    url: "https://github.com/acme/webhooks/pull/212",
    title: "Retry webhooks from the queue worker",
    origin: "created",
    state: "open",
    draft: true,
    status: "draft · checks 1 failed, 2 pending, 9 passed",
    tone: "error",
  },
  {
    label: "acme/webhooks#214",
    url: "https://github.com/acme/webhooks/pull/214",
    title: "Exponential backoff with jitter",
    origin: "created",
    state: "open",
    approved: true,
    status: "open · approved · checks 9 passed",
    tone: "success",
  },
  {
    label: "acme/webhooks#209",
    url: "https://github.com/acme/webhooks/pull/209",
    title: "Add delivery_attempts table",
    origin: "created",
    state: "merged",
    approved: true,
    status: "merged · approved · checks 12 passed",
    tone: "success",
  },
  {
    label: "acme/platform#88",
    url: "https://github.com/acme/platform/pull/88",
    title: "Queue worker: graceful shutdown",
    origin: "referenced",
    state: "open",
    status: "open · review required · checks 7 passed",
    tone: "default",
  },
];

/** pi-git's PR filters (its `prTabs`), over the fixture's pull requests. */
function prTabs(): ExplorerTab[] {
  const ids = (list: readonly FixturePr[]) => list.map((pr) => `github.com/${pr.label}`);
  const created = PRS.filter((pr) => pr.origin === "created");
  const active = created.filter((pr) => pr.state === "open");
  return [
    { label: "All", ids: ids(active) },
    { label: "Draft", ids: ids(active.filter((pr) => pr.draft)) },
    { label: "Open", ids: ids(active.filter((pr) => !pr.draft)) },
    { label: "Approved", ids: ids(active.filter((pr) => pr.approved)) },
    {
      label: "Closed",
      ids: ids(created.filter((pr) => pr.state !== "open")),
      secondary: true,
    },
    {
      label: "Other",
      ids: ids(PRS.filter((pr) => pr.origin === "referenced")),
      secondary: true,
    },
  ];
}

/** `mm:ss`, as pi-subagent's clock reads. */
function clockText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

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

const AGENT_STATE: Record<AgentState, { label: string; tone: Tone }> = {
  queued: { label: "queued", tone: "dim" },
  running: { label: "running", tone: "accent" },
  waiting: { label: "waiting", tone: "muted" },
  completed: { label: "done", tone: "success" },
  failed: { label: "error", tone: "error" },
  stopped: { label: "stopped", tone: "dim" },
};
const LIVE_STATES: ReadonlySet<AgentState> = new Set(["queued", "running", "waiting"]);

/** `2 active / 3 pending`, as pi-ui's `stateCounts` reads, leaving out zeros. */
function stateCounts(active: number, pending: number): Line[] {
  const parts = [
    ...(active ? [`${active} active`] : []),
    ...(pending ? [`${pending} pending`] : []),
  ];
  return parts.length ? [{ text: parts.join(" / "), tone: "muted" }] : [];
}

const ago = (now: number, minutes: number) => now - minutes * MINUTE;

function sessionView(now: number): SessionModel {
  return {
    sessionId: "fixture-session",
    cwd: "/work/webhooks",
    name: "Webhook retry queue",
    model: { provider: "anthropic", id: "claude-opus", name: "Claude Opus" },
    thinking: "high",
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    status: { kind: "tool", tool: "bash", since: ago(now, 1) },
    activity: [
      { tool: "bash", summary: "npm test -- test/deliver.test.ts", at: ago(now, 1), live: true },
      { tool: "edit", summary: "src/webhooks/worker.ts", at: ago(now, 2), durationMs: 140 },
      { tool: "read", summary: "src/webhooks/deliver.ts", at: ago(now, 3), durationMs: 35 },
      { tool: "bash", summary: "git diff --stat", at: ago(now, 5), durationMs: 410 },
      { tool: "stash_put", at: ago(now, 6), durationMs: 22 },
      { tool: "bash", summary: "npm test", at: ago(now, 12), durationMs: 41_000, error: true },
    ],
    usage: { input: 412_000, output: 38_500, cacheRead: 1_920_000, cacheWrite: 96_000, cost: 4.87 },
    startedAt: ago(now, 55),
    piVersion: "1.5.2",
  };
}

function todoViews(): ViewEntry[] {
  const by = (status: TodoStatus) => TASKS.filter((task) => task.status === status).length;
  const blocked = TASKS.filter((task) => task.blocked).length;
  const active = TASKS.find((task) => task.status === "in_progress");
  const summary: SummaryModel = {
    counts: [
      { key: "total", label: agree(TASKS.length, "task"), value: TASKS.length },
      { key: "completed", label: "completed", value: by("completed"), tone: "success" },
      { key: "in-progress", label: "in progress", value: by("in_progress"), tone: "accent" },
      { key: "pending", label: "pending", value: by("pending") - blocked },
      { key: "blocked", label: "blocked", value: blocked, tone: "warning" },
      { key: "archived", label: "archived", value: 0, tone: "muted" },
    ],
    ...(active ? { active: { id: active.key, label: active.subject } } : {}),
  };
  const widget: WidgetModel = {
    title: { label: "Todos" },
    active: true,
    meta: stateCounts(by("in_progress"), by("pending")),
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
  const explorer: ExplorerModel = {
    title: "Todos",
    noun: ["task", "tasks"],
    notices: [{ text: "Read-only task snapshot", tone: "muted" }],
    items: TASKS.map((task) => {
      const status = taskStatus(task);
      return {
        id: task.key,
        label: `${task.key}: ${task.subject}${task.dependsOn ? ` ← ${task.dependsOn.join(", ")}` : ""}`,
        badge: { text: `${status.glyph} ${status.label}`, tone: status.tone },
      };
    }),
    tabs: [
      { label: "All", ids: TASKS.map((task) => task.key) },
      { label: "Recent", ids: TASKS.map((task) => task.key).toReversed() },
    ],
    loadDetail: { action: "todo.inspect" },
  };
  return [
    { id: "todo.explorer", kind: "explorer", title: "Todos", model: explorer },
    { id: "todo.summary", kind: "summary", title: "Tasks", model: summary },
    { id: "todo.widget", kind: "widget", title: "Tasks", model: widget },
  ];
}

const STOPPED: Line = [
  { text: "■", tone: "dim", icon: "stopped" },
  { text: " stopped", tone: "dim" },
];

function subagentViews(now: number): ViewEntry[] {
  const count = (state: AgentState) => AGENTS.filter((agent) => agent.state === state).length;
  const running = AGENTS.filter((agent) => agent.state === "running");
  const summary: SummaryModel = {
    counts: [
      { key: "running", label: "running", value: count("running"), tone: "accent", live: true },
      { key: "queued", label: "queued", value: count("queued"), tone: "dim", live: true },
      { key: "waiting", label: "waiting", value: count("waiting"), tone: "muted", live: true },
      { key: "completed", label: "done", value: count("completed"), tone: "success" },
      { key: "failed", label: "failed", value: count("failed"), tone: "error" },
      { key: "stopped", label: "stopped", value: count("stopped"), tone: "dim" },
      { key: "total", label: agree(AGENTS.length, "subagent"), value: AGENTS.length },
    ],
    ...(running[0]
      ? {
          active: {
            id: running[0].id,
            label: `${running[0].type}: ${running[0].description}`,
            live: true as const,
          },
        }
      : {}),
    profile: {
      name: "orchestrate",
      description: "Plans the work and hands it to subagents",
    },
  };
  const widget: WidgetModel = {
    title: { label: "Subagents" },
    active: running.length > 0,
    meta: stateCounts(running.length, count("queued")),
    ...(running.length ? { live: { active: false, meta: [] } } : {}),
    rows: running.map((agent): WidgetRow => ({
      // As pi-subagent builds it: the clock leads, and while it runs it carries its start.
      lead: {
        text: clockText(agent.minutesAgo * MINUTE),
        tone: "dim",
        since: ago(now, agent.minutesAgo),
        live: true,
      },
      left: [{ text: agent.type, bold: true }, ": ", { text: agent.description, tone: "muted" }],
      right: [
        [
          { text: "●", tone: "accent", icon: "active", live: true },
          { text: ` ${agent.note}`, tone: "muted" },
        ],
      ],
      group: "running",
      live: { right: [STOPPED], group: "stopped" },
    })),
  };
  const explorer: ExplorerModel = {
    title: "Subagents",
    noun: ["subagent", "subagents"],
    items: AGENTS.map((agent) => {
      const state = AGENT_STATE[agent.state];
      return {
        id: agent.id,
        label: [
          { text: agent.type, tone: "accent" },
          { text: ` — ${agent.description}`, tone: "muted" },
        ],
        badge: {
          text: state.label,
          tone: state.tone,
          ...(LIVE_STATES.has(agent.state)
            ? { live: { text: "stopped", tone: "dim" as const } }
            : {}),
        },
        detail: [
          {
            fields: [
              ["Agent", agent.type],
              ["Id", agent.id],
              ["State", { text: state.label, tone: state.tone }],
              ["Tool uses", String(agent.toolUses)],
              ["Tokens", String(agent.tokens)],
            ],
          },
          { heading: agent.state === "running" ? "Latest update" : "Note" },
          { text: agent.note },
        ],
      };
    }),
    tabs: [
      { label: "All", ids: AGENTS.map((agent) => agent.id) },
      { label: "Active", ids: running.map((agent) => agent.id) },
    ],
  };
  return [
    { id: "subagent.explorer", kind: "explorer", title: "Subagents", model: explorer },
    { id: "subagent.summary", kind: "summary", title: "Subagents", model: summary },
    { id: "subagent.widget", kind: "widget", title: "Subagents", model: widget },
  ];
}

function stashViews(now: number): ViewEntry[] {
  const entries = STASH.toSorted((a, b) => a.minutesAgo - b.minutesAgo);
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const summary: SummaryModel = {
    counts: [
      { key: "entries", label: agree(entries.length, "entry", "entries"), value: entries.length },
      {
        key: "versions",
        label: agree(entries.length, "version"),
        value: entries.length,
        tone: "muted",
      },
      { key: "bytes", label: "on this branch", value: bytes, unit: "bytes", tone: "muted" },
      { key: "store-bytes", label: "in the store", value: 25_946, unit: "bytes" },
      {
        key: "store-max-bytes",
        label: "store cap",
        value: 50 * 1024 * 1024,
        unit: "bytes",
        tone: "muted",
      },
    ],
  };
  // As pi-stash builds it: each item's id is the entry's handle.
  const explorer: ExplorerModel = {
    title: "Stash",
    noun: ["entry", "entries"],
    notices: [{ text: `${formatBytes(bytes)} stored on this branch`, tone: "muted" }],
    emptyText: "No stash entries on this branch.",
    items: entries.map((entry) => ({
      id: stashHandle(entry.name),
      label: [
        { text: stashHandle(entry.name), tone: "accent" },
        { text: ` — ${entry.description}`, tone: "muted" },
      ],
      search: entry.name,
      badge: {
        text: `${formatBytes(entry.bytes)} · ${entry.lines} lines · ${Math.round((now - ago(now, entry.minutesAgo)) / MINUTE)}m`,
      },
    })),
    loadDetail: { action: "stash.inspect" },
  };
  return [
    { id: "stash.explorer", kind: "explorer", title: "Stash", model: explorer },
    { id: "stash.summary", kind: "summary", title: "Stash", model: summary },
  ];
}

function gitViews(): ViewEntry[] {
  const summary: SummaryModel = {
    counts: [
      { key: "worktrees", label: agree(WORKTREES.length, "worktree"), value: WORKTREES.length },
      { key: "missing", label: "missing", value: 0, tone: "warning" },
      { key: "uncommitted", label: "uncommitted", value: 1, tone: "warning" },
      { key: "removed", label: "removed", value: 1, tone: "dim" },
      { key: "other-worktrees", label: "other worktrees", value: 0, tone: "dim" },
      { key: "prs", label: agree(PRS.length, "pull request"), value: PRS.length },
      { key: "prs-created", label: "opened here", value: 3 },
      { key: "prs-open", label: "open", value: 2, tone: "accent" },
      { key: "prs-failing", label: "failing", value: 1, tone: "error" },
      { key: "prs-watching", label: "watching", value: 0, live: true },
    ],
  };
  const worktrees: ExplorerModel = {
    title: "Git worktrees",
    noun: ["worktree", "worktrees"],
    items: WORKTREES.map((worktree) => ({
      id: worktree.path,
      label: [
        { text: `${worktree.repo} @ ${worktree.branch}`, tone: "accent" },
        { text: ` — ${worktree.path}`, tone: "muted" },
      ],
      search: `${worktree.path} ${worktree.agents.join(" ")}`,
      badge: { text: worktree.status, tone: worktree.tone },
      detail: [
        {
          fields: [
            ["Path", worktree.path],
            ["Repository", `/work/${worktree.repo}`],
            ["Branch", worktree.branch],
            ["State", { text: worktree.status, tone: worktree.tone }],
          ],
        },
        { heading: "Agents" },
        { bullets: worktree.agents },
      ],
    })),
    tabs: [
      {
        label: "This session",
        ids: WORKTREES.map((worktree) => worktree.path),
        emptyText: "No worktrees in this session.",
      },
      { label: "Removed", ids: [], emptyText: "Nothing removed in this session." },
      { label: "Other", ids: [], emptyText: "No other worktrees under the worktree root." },
    ],
  };
  const prs: ExplorerModel = {
    title: "Pull requests",
    noun: ["pull request", "pull requests"],
    items: PRS.map((pr) => ({
      id: `github.com/${pr.label}`,
      label: [
        { text: pr.label, tone: "accent" },
        { text: ` — ${pr.title}`, tone: "muted" },
      ],
      search: pr.url,
      badge: { text: pr.status, tone: pr.tone },
      detail: [
        {
          fields: [
            ["URL", pr.url],
            ["Title", pr.title],
            ["Status", { text: pr.status, tone: pr.tone }],
            ["Origin", pr.origin === "created" ? "opened in this session" : "referenced"],
          ],
        },
      ],
    })),
    tabs: prTabs(),
  };
  return [
    { id: "git.prs", kind: "explorer", title: "Pull requests", model: prs },
    { id: "git.summary", kind: "summary", title: "Git", model: summary },
    { id: "git.worktrees", kind: "explorer", title: "Git worktrees", model: worktrees },
  ];
}

/**
 * What pi-git will publish once the agent hands pull requests to the user for
 * review: one ready, one whose head moved since the handoff.
 */
function attentionView(now: number): ViewEntry {
  const review = (pr: FixturePr, sha: string) => ({
    id: `pr:github.com/${pr.label}`,
    rev: sha,
    category: "review",
    title: `Review ${pr.label}`,
    link: { url: pr.url, label: pr.label },
    dismiss: {
      action: "git.attention.dismiss",
      args: { id: `pr:github.com/${pr.label}`, rev: sha },
    },
  });
  const model: AttentionModel = {
    items: [
      {
        ...review(PRS[0]!, "4be19a2"),
        reason: `${PRS[0]!.title} · draft at 4be19a2`,
        state: "ready",
        since: ago(now, 12),
        observedAt: ago(now, 1),
      },
      {
        ...review(PRS[1]!, "9f02b1c"),
        reason: `${PRS[1]!.title} · head moved since 9f02b1c`,
        state: "stale",
        since: ago(now, 50),
        observedAt: ago(now, 1),
      },
    ],
    total: 2,
  };
  return { id: "git.attention", kind: "attention", title: "Git", model };
}

/**
 * What pi-todo will publish for a task waiting on the user: an item that
 * takes a reply, which moves the task on and wakes the agent.
 */
function todoAttentionView(now: number): ViewEntry {
  const model: AttentionModel = {
    items: [
      {
        id: "task:staging-host",
        rev: "3",
        category: "task",
        title: "Pick the staging webhook host",
        reason: "Tell me which host staging webhooks should post to: hooks.staging or a new one.",
        state: "ready",
        since: ago(now, 6),
        reply: { action: "todo.unblock", args: { key: "staging-host", rev: "3" } },
      },
    ],
    total: 1,
  };
  return { id: "todo.attention", kind: "attention", title: "Todos", model };
}

function formView(now: number): FormModel {
  return {
    questionnaires: [
      {
        id: "fixture-ask-1",
        title: "Retry policy",
        openedAt: ago(now, 1),
        questions: [
          {
            header: "Attempts",
            question: "How many delivery attempts before a webhook is dead-lettered?",
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
        submit: { action: "ask.submit", args: { id: "fixture-ask-1" } },
        cancel: { action: "ask.cancel", args: { id: "fixture-ask-1" } },
      },
    ],
  };
}

/** A complete delivery snapshot with every view the slots read, timed relative to `now`. */
export function fixtureSnapshot(now = Date.now()): DeliverySnapshot {
  const views: ViewEntry[] = [
    { id: "ask.questions", kind: "form", title: "Questions", model: formView(now) },
    attentionView(now),
    todoAttentionView(now),
    ...gitViews(),
    ...stashViews(now),
    ...subagentViews(now),
    { id: "system.session", kind: "session", title: "Session", model: sessionView(now) },
    ...todoViews(),
  ];
  return { id: "fixture", views: views.toSorted((a, b) => (a.id < b.id ? -1 : 1)) };
}

function idArg(args: JsonValue | undefined): string {
  const id = (args as { id?: unknown } | null | undefined)?.id;
  if (typeof id !== "string") throw new Error("expected { id }");
  return id;
}

/** Answers what a real session would, from the same canned data. */
export function fixtureResponder(now = Date.now()) {
  const at = (minutes: number) => new Date(ago(now, minutes)).toISOString();
  return (request: ActionRequest): unknown => {
    switch (request.action) {
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
      case "git.attention.dismiss":
        // A fixture keeps its items: there is no ledger to record the dismissal in.
        return null;
      case "todo.unblock":
        // A fixture keeps its items: there is no task to move on or agent to wake.
        return null;
      case "ask.submit":
      case "ask.cancel":
        throw new Error("This is a fixture session; answers go nowhere.");
      case "subagent.profiles":
        return {
          profiles: [
            {
              name: "orchestrate",
              description: "Project manager for multi-step work",
              running: true,
            },
            {
              name: "assist",
              description: "Long-running assistant for on-call and everyday questions",
              running: false,
            },
            { name: "dig", description: "Investigator for open-ended questions", running: false },
          ],
        };
      case "subagent.switch":
        throw new Error("This is a fixture session; it has no conversation to compact.");
      default:
        throw new Error(`Unknown action "${request.action}".`);
    }
  };
}
