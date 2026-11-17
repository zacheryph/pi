import type { DeliverySnapshot } from "#src/index";

// The stale-running bb card (docs/plans/views-only-snapshot.md, "Current
// duplication"): a thread's last snapshot, saved while subagents were running,
// restored after Pi stopped. bb settles its older agent section, but the shared
// views below kept their running clocks and active icons. The views are shaped
// as pi-subagent, pi-todo, pi-ask and pi-system-insights build them (see
// extensions/pi-subagent/src/ui/widget-renderer.ts and bb-plugin/fixture.ts),
// with the `live` marks the producers are to add.

/** When the snapshot was saved; Pi stopped right after. */
export const SAVED_AT = 1_700_000_600_000;
const STARTED = SAVED_AT - 133_000;

const stopped = [
  { text: "■", tone: "dim", icon: "stopped" },
  { text: " stopped", tone: "dim" },
] as const;

export const staleRunningCard = {
  id: "48213",
  host: { pid: 48213, terminal: { kind: "tmux", label: "%3" } },
  views: [
    {
      id: "ask.questions",
      kind: "form",
      title: "Questions",
      model: {
        questionnaires: [
          {
            id: "toolu_01",
            title: "Retry policy",
            openedAt: SAVED_AT - 5_000,
            questions: [
              { question: "Retry on 429?", options: [{ label: "Yes" }, { label: "No" }] },
            ],
            submit: { action: "ask.answer", args: { id: "toolu_01" } },
            cancel: { action: "ask.cancel", args: { id: "toolu_01" } },
          },
        ],
      },
    },
    { id: "git.widget", kind: "widget", title: "Git", error: "git: not a repository" },
    {
      id: "subagent.explorer",
      kind: "explorer",
      title: "Subagents",
      model: {
        title: "Subagents",
        noun: ["subagent", "subagents"],
        items: [
          {
            id: "agent-1",
            label: [
              { text: "Explore", tone: "accent" },
              { text: " — map the views", tone: "muted" },
            ],
            badge: { text: "running", tone: "accent", live: { text: "stopped", tone: "dim" } },
            detail: [{ fields: [["Agent", "Explore"]] }, { heading: "Latest update" }],
          },
          {
            id: "agent-2",
            label: [{ text: "Review", tone: "accent" }],
            badge: { text: "waiting", tone: "muted", live: true },
          },
          {
            id: "agent-3",
            label: [{ text: "Plan", tone: "accent" }],
            badge: { text: "done", tone: "success" },
            detail: "Wrote the plan.",
          },
        ],
        tabs: [
          { label: "All", ids: ["agent-1", "agent-2", "agent-3"] },
          { label: "Active", ids: ["agent-1", "agent-2"] },
        ],
        loadDetail: { action: "subagent.inspect" },
      },
    },
    {
      id: "subagent.summary",
      kind: "summary",
      title: "Subagents",
      model: {
        counts: [
          { key: "running", label: "running", value: 1, tone: "accent", live: true },
          { key: "waiting", label: "waiting", value: 1, live: true },
          { key: "queued", label: "queued", value: 1, live: true },
          { key: "completed", label: "done", value: 1, tone: "success" },
        ],
        active: { id: "agent-1", label: "Explore: map the views", live: true },
        profile: { name: "default", label: "Default agent" },
      },
    },
    {
      id: "subagent.widget",
      kind: "widget",
      title: "Subagents",
      model: {
        title: { label: "Subagents", icon: "◆" },
        active: true,
        meta: [{ text: "2 active / 1 pending", tone: "muted" }],
        live: { active: false, meta: [] },
        rows: [
          {
            lead: { text: "02:13", tone: "dim", since: STARTED, live: true },
            left: [{ text: "Explore", bold: true }, ": ", { text: "map the views", tone: "muted" }],
            right: [
              [
                { text: "⠋", tone: "accent", icon: "active", live: true },
                { text: " reading views.ts", tone: "muted" },
              ],
            ],
            group: "running",
            live: { right: [stopped], group: "stopped" },
          },
          {
            lead: { text: "--:--", tone: "dim" },
            left: [{ text: "Review", bold: true }, ": ", { text: "check it", tone: "muted" }],
            right: [
              [
                { text: "", tone: "muted", icon: "waiting", live: true },
                { text: "waiting: review", tone: "muted" },
              ],
            ],
            group: "waiting",
            live: { right: [stopped], group: "stopped" },
          },
          {
            lead: { text: "01:05", tone: "dim" },
            left: [{ text: "Plan", tone: "dim", bold: true }, ": ", { text: "plan", tone: "dim" }],
            right: [
              [
                { text: "✓", tone: "success", icon: "done" },
                { text: " done", tone: "success" },
              ],
            ],
            group: "finished",
          },
        ],
      },
    },
    {
      id: "system.session",
      kind: "session",
      title: "Session",
      model: {
        sessionId: "0193-session",
        cwd: "/repo",
        status: { kind: "tool", tool: "subagent", since: SAVED_AT - 2_000 },
        activity: [
          { tool: "subagent", summary: "Explore", at: STARTED, durationMs: 133_000, live: true },
          { tool: "read", summary: "src/views.ts", at: STARTED - 9_000, durationMs: 40 },
        ],
        usage: { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
        startedAt: SAVED_AT - 3_600_000,
      },
    },
    {
      id: "todo.explorer",
      kind: "explorer",
      title: "Todos",
      model: {
        title: "Todos",
        items: [
          {
            id: "1",
            label: "1: Read the plan",
            badge: { text: "✓ completed", tone: "success" },
            marked: true,
          },
          {
            id: "2",
            label: "2: Write the collector",
            badge: { text: "▸ in_progress", tone: "accent" },
          },
        ],
        marker: {
          label: "unreviewed",
          clearAction: "mark reviewed",
          onClear: { action: "todo.review", args: { branch: 1 } },
        },
        onOpen: { action: "todo.opened" },
        loadDetail: { action: "todo.inspect" },
      },
    },
    {
      id: "todo.summary",
      kind: "summary",
      title: "Tasks",
      model: {
        counts: [
          { key: "total", label: "tasks", value: 3 },
          { key: "completed", label: "done", value: 1 },
          { key: "in-progress", label: "in progress", value: 1 },
          { key: "unreviewed", label: "unreviewed", value: 1 },
        ],
        // A task `in_progress` in the session file: persisted, not process-bound.
        active: { id: "2", label: "Write the collector" },
      },
    },
    {
      id: "todo.widget",
      kind: "widget",
      title: "Tasks",
      model: {
        title: { label: "Todos" },
        active: true,
        meta: [{ text: "1 active / 1 pending", tone: "muted" }],
        rows: [
          {
            left: [{ text: "2", bold: true }, ": Write the collector"],
            right: [
              [
                { text: "▸", tone: "accent", icon: "active" },
                { text: " in_progress", tone: "accent" },
              ],
            ],
            keepRight: true,
          },
          {
            left: [{ text: "3", bold: true }, ": Review it"],
            right: [[{ text: "○", tone: "dim", icon: "pending" }]],
            keepRight: true,
          },
        ],
      },
    },
  ],
} as const satisfies DeliverySnapshot;
