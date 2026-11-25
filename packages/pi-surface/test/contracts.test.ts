import { describe, expect, it } from "vitest";
import {
  ACTION_ID,
  FORM_VIEW_ID,
  isActionRequest,
  isActionResult,
  isBadge,
  isDeliverySnapshot,
  isDetailModel,
  isExplorerModel,
  isFormAnswer,
  isFormModel,
  isSessionModel,
  isSpan,
  isSummaryModel,
  isViewEntry,
  isViewKind,
  isViewModel,
  isWidgetModel,
  isWidgetRow,
  MAX_FORM_OPTIONS,
  MAX_FORM_QUESTIONNAIRES,
  MAX_FORM_QUESTIONS,
  MAX_FORM_TEXT,
  MAX_QUESTIONNAIRE_ID,
  MAX_VIEW_ERROR,
  readDeliverySnapshot,
  SESSION_VIEW_ID,
  summaryCount,
  VIEW_ID,
  VIEW_KINDS,
  type DeliverySnapshot,
  type DetailModel,
  type ExplorerModel,
  type FormModel,
  type FormQuestionnaire,
  type JsonValue,
  type SessionModel,
  type SummaryModel,
  type ViewKind,
  type ViewModelOf,
  type WidgetModel,
} from "#src/index";

/** A deep copy with one path changed: `set(model, ["a", 0, "b"], value)`. */
function set(value: unknown, path: readonly (string | number)[], next: unknown): unknown {
  const copy = structuredClone(value) as Record<string | number, unknown>;
  let at = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
  at[path.at(-1)!] = next;
  return copy;
}

const session: SessionModel = {
  sessionId: "019a-session",
  cwd: "/work/api",
  name: "webhooks",
  model: { provider: "anthropic", id: "claude-x", name: "Claude X" },
  thinking: "medium",
  context: { tokens: 42_000, window: 200_000, percent: 21 },
  status: { kind: "tool", tool: "bash", since: 1_700_000_000_000 },
  activity: [
    { tool: "bash", summary: "npm test", at: 1_700_000_000_500, live: true },
    { tool: "read", summary: "src/a.ts", at: 1_700_000_000_000, durationMs: 12, error: false },
  ],
  usage: { input: 1200, output: 340, cacheRead: 9000, cacheWrite: 100, cost: 0.0421 },
  startedAt: 1_699_999_000_000,
  piVersion: "0.70.0",
};

const summary: SummaryModel = {
  counts: [
    { key: "total", label: "tasks", value: 7 },
    { key: "completed", label: "done", value: 3, tone: "success" },
    { key: "running", label: "running", value: 2, tone: "accent", live: true },
    { key: "bytes", label: "on this branch", value: 887, unit: "bytes" },
  ],
  active: { id: "worker", label: "Move retries into the queue worker" },
  profile: { name: "reviewer", label: "Reviewer", description: "Reviews diffs" },
};

const questionnaire = (id: string): FormQuestionnaire => ({
  id,
  title: "Pi's questions",
  openedAt: 1_700_000_000_000,
  questions: [
    {
      question: "Which queue?",
      header: "Queue",
      options: [{ label: "SQS", description: "Managed" }, { label: "Redis" }],
    },
    {
      question: "Which failures retry?",
      options: [{ label: "Timeouts" }, { label: "429" }, { label: "5xx" }],
      multiSelect: true,
    },
    { question: "Anything else?", options: [] },
  ],
  submit: { action: "ask.submit", args: { id } },
  cancel: { action: "ask.cancel", args: { id } },
});

const form: FormModel = {
  // Two open at once, each answered on its own; ids are opaque, not view-id shaped.
  questionnaires: [questionnaire("toolu_01:A/b c"), questionnaire("call-2")],
};

const widget: WidgetModel = {
  title: { label: "Subagents", icon: "◆" },
  active: true,
  meta: ["2 running"],
  rows: [
    {
      lead: { text: "01:23", tone: "dim", since: 1_700_000_000_000, live: true },
      left: [{ text: "explore", bold: true }, ": map paths"],
      right: [[{ text: "⠋", tone: "accent", icon: "active", live: true }, " reading a.ts"]],
      group: "running",
      live: { right: [[{ text: "■", icon: "stopped" }, " stopped"]], group: "stopped" },
    },
    // A persisted task state: an active icon, but not process-bound.
    { left: "worker: Move retries", right: [[{ text: "▸", icon: "active" }, " in_progress"]] },
  ],
};

const explorer: ExplorerModel = {
  title: "Subagents",
  items: [
    {
      id: "a1",
      label: "explore",
      badge: { text: "running", tone: "accent", live: { text: "stopped" } },
    },
    { id: "a2", label: "plan", badge: { text: "done", tone: "success" }, detail: "finished" },
  ],
  tabs: [{ label: "All", ids: ["a1", "a2"] }],
  marker: { label: "unreviewed", onClear: { action: "todo.review", args: { branch: 1 } } },
  hints: [{ keys: "/subagent:agents", priority: 1 }],
  loadDetail: { action: "subagent.inspect" },
};

const detail: DetailModel = {
  title: { label: "About", detail: "v1" },
  content: [{ heading: "Hi" }],
};

const models: { [Kind in ViewKind]: ViewModelOf<Kind> } = {
  widget,
  explorer,
  detail,
  session,
  summary,
  form,
};

describe("view kinds", () => {
  it("lists every kind and recognizes only those", () => {
    expect(VIEW_KINDS).toEqual(["widget", "explorer", "detail", "session", "summary", "form"]);
    for (const kind of VIEW_KINDS) expect(isViewKind(kind)).toBe(true);
    for (const kind of ["timeline", "", "Widget", undefined, 1])
      expect(isViewKind(kind)).toBe(false);
  });

  it("names the conventional providers with view ids", () => {
    expect(SESSION_VIEW_ID).toBe("system.session");
    expect(FORM_VIEW_ID).toBe("ask.questions");
    expect(VIEW_ID.test(SESSION_VIEW_ID) && VIEW_ID.test(FORM_VIEW_ID)).toBe(true);
  });

  it("validates each kind's model, which survives a JSON round trip unchanged", () => {
    for (const kind of VIEW_KINDS) {
      const model = models[kind];
      expect(isViewModel(kind, model), kind).toBe(true);
      const copy: unknown = JSON.parse(JSON.stringify(model satisfies JsonValue));
      expect(copy, kind).toStrictEqual(model);
      expect(isViewModel(kind, copy), kind).toBe(true);
    }
  });

  it("refuses a model under another kind, and any model under an unknown kind", () => {
    for (const kind of VIEW_KINDS)
      for (const other of VIEW_KINDS)
        if (other !== kind)
          expect(isViewModel(kind, models[other]), `${other} as ${kind}`).toBe(false);
    expect(isViewModel("timeline", widget)).toBe(false);
  });

  it("refuses models that are not plain JSON", () => {
    expect(isViewModel("detail", { ...detail, when: new Date() })).toBe(false);
    expect(isViewModel("summary", { ...summary, extra: () => 1 })).toBe(false);
    const cycle: Record<string, unknown> = { counts: [] };
    cycle.self = cycle;
    expect(isViewModel("summary", cycle)).toBe(false);
  });
});

describe("widget, explorer and detail guards", () => {
  it("accept today's models, and refuse malformed nested data", () => {
    expect(isWidgetModel(widget)).toBe(true);
    expect(isExplorerModel(explorer)).toBe(true);
    expect(isDetailModel(detail)).toBe(true);
    const bad: [string, (value: unknown) => boolean, unknown][] = [
      ["widget without rows", isWidgetModel, { title: "x" }],
      ["row with a bad span", isWidgetModel, set(widget, ["rows", 0, "left", 0, "tone"], "loud")],
      ["row clock NaN", isWidgetModel, set(widget, ["rows", 0, "lead", "since"], Number.NaN)],
      ["right not lines", isWidgetModel, set(widget, ["rows", 1, "right"], "x")],
      ["meta not lines", isWidgetModel, set(widget, ["meta"], [1])],
      ["title object", isWidgetModel, set(widget, ["title", "label"], 3)],
      ["item without id", isExplorerModel, set(explorer, ["items", 1, "id"], undefined)],
      ["bad badge", isExplorerModel, set(explorer, ["items", 0, "badge", "tone"], "red")],
      ["bad detail", isExplorerModel, set(explorer, ["items", 1, "detail"], [{ heading: 1 }])],
      ["bad tab ids", isExplorerModel, set(explorer, ["tabs", 0, "ids"], [1])],
      ["bad noun", isExplorerModel, set(explorer, ["noun"], ["one"])],
      ["bad action id", isExplorerModel, set(explorer, ["loadDetail"], { action: "Inspect" })],
      ["array args", isExplorerModel, set(explorer, ["loadDetail", "args"], [1])],
      [
        "NaN args",
        isExplorerModel,
        set(explorer, ["marker", "onClear", "args"], { n: Number.NaN }),
      ],
      ["infinite priority", isExplorerModel, set(explorer, ["hints", 0, "priority"], Infinity)],
      ["detail content", isDetailModel, { title: "x", content: 1 }],
    ];
    for (const [name, check, value] of bad) expect(check(value), name).toBe(false);
  });

  it("keeps the action id shape in step with the action registry's", () => {
    expect(isExplorerModel({ ...explorer, loadDetail: { action: "git.worktree.remove" } })).toBe(
      true,
    );
    expect(ACTION_ID.test("git.worktree.remove")).toBe(true);
  });
});

describe("process-bound markers", () => {
  it("mark spans, badges and rows, with what a row or badge settles to", () => {
    expect(isSpan({ text: "01:23", since: 1, live: true })).toBe(true);
    expect(isSpan({ text: "01:23", live: false })).toBe(false);
    expect(isBadge({ text: "running", live: true })).toBe(true);
    expect(isBadge({ text: "running", live: { text: "stopped", tone: "dim" } })).toBe(true);
    expect(isBadge({ text: "running", live: { tone: "dim" } })).toBe(false);
    expect(isWidgetRow({ left: "x", live: true })).toBe(true);
    expect(isWidgetRow({ left: "x", live: { right: [1] } })).toBe(false);
    expect(isWidgetModel({ title: "W", rows: [], live: true })).toBe(true);
    expect(isWidgetModel({ title: "W", rows: [], live: { active: false, meta: [] } })).toBe(true);
    expect(isWidgetModel({ title: "W", rows: [], live: { active: "no" } })).toBe(false);
    expect(isWidgetModel({ title: "W", rows: [], live: false })).toBe(false);
    expect(isSummaryModel(set(summary, ["counts", 2, "live"], "yes"))).toBe(false);
    expect(isSessionModel(set(session, ["activity", 0, "live"], 1))).toBe(false);
  });

  it("leave a persisted state unmarked even when it shares the active icon", () => {
    const task = widget.rows[1]!;
    expect(task.live).toBeUndefined();
    expect(isWidgetRow(task)).toBe(true);
  });
});

describe("session model", () => {
  it("accepts the minimum a session always has", () => {
    expect(
      isSessionModel({
        sessionId: "s",
        cwd: "/",
        status: { kind: "idle", since: 0 },
        startedAt: 0,
      }),
    ).toBe(true);
    expect(
      isSessionModel(set(session, ["context"], { tokens: null, window: 1, percent: null })),
    ).toBe(true);
    expect(isSessionModel(set(session, ["status"], { kind: "waiting", since: 1 }))).toBe(true);
  });

  it("refuses malformed nested data and numbers that are not finite", () => {
    const bad: [string, unknown][] = [
      ["no session id", set(session, ["sessionId"], "")],
      ["status kind", set(session, ["status", "kind"], "sleeping")],
      ["tool status without tool", set(session, ["status"], { kind: "tool", since: 1 })],
      ["status since NaN", set(session, ["status", "since"], Number.NaN)],
      ["started at Infinity", set(session, ["startedAt"], Infinity)],
      ["context NaN", set(session, ["context", "percent"], Number.NaN)],
      ["negative window", set(session, ["context", "window"], -1)],
      ["usage Infinity", set(session, ["usage", "cost"], Infinity)],
      ["usage missing", set(session, ["usage", "cacheRead"], undefined)],
      ["model id", set(session, ["model", "id"], 7)],
      ["activity at", set(session, ["activity", 1, "at"], "now")],
      ["activity duration", set(session, ["activity", 1, "durationMs"], Number.NaN)],
      ["activity list", set(session, ["activity"], {})],
    ];
    for (const [name, value] of bad) expect(isSessionModel(value), name).toBe(false);
  });

  it("carries no main-agent profile or connection identity", () => {
    expect(Object.keys(session).sort()).toEqual(
      [
        "activity",
        "context",
        "cwd",
        "model",
        "name",
        "piVersion",
        "sessionId",
        "startedAt",
        "status",
        "thinking",
        "usage",
      ].sort(),
    );
  });
});

describe("summary model", () => {
  it("reads producer totals by stable key, apart from their labels", () => {
    expect(summaryCount(summary, "running")).toBe(2);
    expect(summaryCount(summary, "missing")).toBeUndefined();
    // An empty summary is a loaded producer with nothing yet.
    expect(isSummaryModel({ counts: [] })).toBe(true);
    // A profile with no counts, as for a main agent with no subagents.
    expect(isSummaryModel({ counts: [], profile: { name: "reviewer" } })).toBe(true);
  });

  it("takes a count's unit only as the literal bytes", () => {
    expect(isSummaryModel(summary)).toBe(true);
    expect(summaryCount(summary, "bytes")).toBe(887);
    // A count without a unit is a plain number of things.
    expect(isSummaryModel(set(summary, ["counts", 3, "unit"], undefined))).toBe(true);
  });

  it("refuses duplicate or malformed keys, and values that are not finite counts", () => {
    const bad: [string, unknown][] = [
      ["duplicate key", set(summary, ["counts", 1, "key"], "total")],
      ["key shape", set(summary, ["counts", 0, "key"], "Total Tasks")],
      ["NaN", set(summary, ["counts", 0, "value"], Number.NaN)],
      ["Infinity", set(summary, ["counts", 0, "value"], Infinity)],
      ["negative", set(summary, ["counts", 0, "value"], -1)],
      ["string value", set(summary, ["counts", 0, "value"], "7")],
      ["no label", set(summary, ["counts", 0, "label"], undefined)],
      ["tone", set(summary, ["counts", 0, "tone"], "red")],
      ["unit", set(summary, ["counts", 3, "unit"], "kilobytes")],
      ["unit case", set(summary, ["counts", 3, "unit"], "Bytes")],
      ["unit type", set(summary, ["counts", 3, "unit"], 1)],
      ["unit null", set(summary, ["counts", 3, "unit"], null)],
      ["active id", set(summary, ["active", "id"], "")],
      ["profile name", set(summary, ["profile", "name"], 1)],
      ["counts", { counts: {} }],
    ];
    for (const [name, value] of bad) expect(isSummaryModel(value), name).toBe(false);
  });
});

describe("form model", () => {
  it("holds concurrent questionnaires, each with its own identity and actions", () => {
    expect(isFormModel(form)).toBe(true);
    const [first, second] = form.questionnaires;
    expect(first!.id).not.toBe(second!.id);
    expect(first!.submit.args).toEqual({ id: first!.id });
    expect(second!.cancel.args).toEqual({ id: second!.id });
    // An id need not have a view id's shape: it is a payload value.
    expect(VIEW_ID.test(first!.id)).toBe(false);
    expect(isFormModel({ questionnaires: [] })).toBe(true);
  });

  it("refuses two questionnaires with one id", () => {
    expect(isFormModel({ questionnaires: [questionnaire("same"), questionnaire("same")] })).toBe(
      false,
    );
  });

  it("enforces its bounds", () => {
    const many = (count: number) => Array.from({ length: count }, (_, i) => questionnaire(`q${i}`));
    expect(isFormModel({ questionnaires: many(MAX_FORM_QUESTIONNAIRES) })).toBe(true);
    expect(isFormModel({ questionnaires: many(MAX_FORM_QUESTIONNAIRES + 1) })).toBe(false);

    const one = questionnaire("q");
    const question = one.questions[0]!;
    const withQuestions = (count: number) =>
      ({
        questionnaires: [
          {
            ...one,
            questions: Array.from({ length: count }, (_, i) => ({
              ...question,
              question: `Q${i}?`,
            })),
          },
        ],
      }) satisfies FormModel;
    expect(isFormModel(withQuestions(MAX_FORM_QUESTIONS))).toBe(true);
    expect(isFormModel(withQuestions(MAX_FORM_QUESTIONS + 1))).toBe(false);
    expect(isFormModel(withQuestions(0))).toBe(false);

    const options = (count: number) =>
      set(
        form,
        ["questionnaires", 0, "questions", 0, "options"],
        Array.from({ length: count }, (_, i) => ({ label: `o${i}` })),
      );
    expect(isFormModel(options(MAX_FORM_OPTIONS))).toBe(true);
    expect(isFormModel(options(MAX_FORM_OPTIONS + 1))).toBe(false);

    const text = "x".repeat(MAX_FORM_TEXT);
    expect(isFormModel(set(form, ["questionnaires", 0, "questions", 0, "question"], text))).toBe(
      true,
    );
    expect(
      isFormModel(set(form, ["questionnaires", 0, "questions", 0, "question"], `${text}x`)),
    ).toBe(false);
    const id = "i".repeat(MAX_QUESTIONNAIRE_ID);
    expect(isFormModel(set(form, ["questionnaires", 0, "id"], id))).toBe(true);
    expect(isFormModel(set(form, ["questionnaires", 0, "id"], `${id}i`))).toBe(false);
  });

  it("refuses malformed questions, options and action references", () => {
    const bad: [string, unknown][] = [
      ["empty id", set(form, ["questionnaires", 0, "id"], "")],
      ["blank question", set(form, ["questionnaires", 0, "questions", 0, "question"], " ")],
      ["option label", set(form, ["questionnaires", 0, "questions", 0, "options", 0, "label"], "")],
      ["options missing", set(form, ["questionnaires", 0, "questions", 0, "options"], undefined)],
      ["multiSelect", set(form, ["questionnaires", 0, "questions", 1, "multiSelect"], "yes")],
      ["no submit", set(form, ["questionnaires", 0, "submit"], undefined)],
      ["no cancel", set(form, ["questionnaires", 1, "cancel"], undefined)],
      ["submit args", set(form, ["questionnaires", 0, "submit", "args"], "id")],
      ["submit id", set(form, ["questionnaires", 0, "submit", "action"], "answer")],
      ["opened NaN", set(form, ["questionnaires", 0, "openedAt"], Number.NaN)],
    ];
    for (const [name, value] of bad) expect(isFormModel(value), name).toBe(false);
  });

  it("checks an answer's shape and bounds", () => {
    expect(
      isFormAnswer({
        answers: [
          { questionIndex: 0, optionIndexes: [1] },
          { questionIndex: 1, optionIndexes: [0, 2], text: "also 408", notes: "n" },
          { questionIndex: 2, text: "no" },
        ],
        globalNote: "thanks",
      }),
    ).toBe(true);
    for (const value of [
      {},
      { answers: [{ questionIndex: -1 }] },
      { answers: [{ questionIndex: 0.5 }] },
      { answers: [{ questionIndex: MAX_FORM_QUESTIONS }] },
      { answers: [{ questionIndex: 0, optionIndexes: [Number.NaN] }] },
      { answers: [{ questionIndex: 0, text: "x".repeat(MAX_FORM_TEXT + 1) }] },
      { answers: [], globalNote: 1 },
    ])
      expect(isFormAnswer(value), JSON.stringify(value)).toBe(false);
  });
});

describe("delivery snapshots", () => {
  const delivery: DeliverySnapshot = {
    id: "4242",
    host: { pid: 4242, terminal: { kind: "cmux", label: "workspace 2" } },
    views: [
      { id: "ask.questions", kind: "form", title: "Questions", model: form },
      { id: "git.prs", kind: "explorer", title: "Pull requests", error: "Too large to send." },
      { id: "subagent.widget", kind: "widget", title: "Subagents", model: widget },
      { id: "system.session", kind: "session", title: "Session", model: session },
      { id: "todo.summary", kind: "summary", title: "Tasks", model: summary },
    ],
  };

  it("validate strictly and survive a JSON round trip", () => {
    expect(isDeliverySnapshot(delivery)).toBe(true);
    const copy: unknown = JSON.parse(JSON.stringify(delivery));
    expect(copy).toStrictEqual(delivery);
    expect(isDeliverySnapshot(copy)).toBe(true);
    expect(readDeliverySnapshot(copy)).toStrictEqual(delivery);
    // Without the system view or host: routing identity alone is enough.
    expect(isDeliverySnapshot({ id: "4242", views: [] })).toBe(true);
  });

  it("refuse a malformed envelope or entry, strictly", () => {
    const bad: [string, unknown][] = [
      ["no id", set(delivery, ["id"], "")],
      ["long id", set(delivery, ["id"], "x".repeat(129))],
      ["views", set(delivery, ["views"], {})],
      ["pid", set(delivery, ["host", "pid"], 1.5)],
      ["terminal", set(delivery, ["host", "terminal"], { label: "x" })],
      ["duplicate id", set(delivery, ["views", 1, "id"], "ask.questions")],
      ["bad view id", set(delivery, ["views", 0, "id"], "questions")],
      ["model and error", set(delivery, ["views", 0, "error"], "both")],
      ["long error", set(delivery, ["views", 1, "error"], "e".repeat(MAX_VIEW_ERROR + 1))],
      ["neither", set(delivery, ["views", 2, "model"], undefined)],
      ["model of the wrong kind", set(delivery, ["views", 2, "kind"], "summary")],
      ["unknown kind", set(delivery, ["views", 2, "kind"], "timeline")],
      ["nested NaN", set(delivery, ["views", 4, "model", "counts", 0, "value"], Number.NaN)],
    ];
    for (const [name, value] of bad) expect(isDeliverySnapshot(value), name).toBe(false);
    expect(isViewEntry(delivery.views[0])).toBe(true);
  });

  it("read a newer producer's snapshot, skipping what this copy cannot draw", () => {
    const newer = {
      ...delivery,
      host: { ...delivery.host, focus: true },
      views: [
        ...delivery.views,
        { id: "future.timeline", kind: "timeline", title: "Timeline", model: { lanes: [] } },
        { id: "future.broken", kind: "hologram", title: "Broken", error: "failed" },
        { id: "todo.widget", kind: "widget", title: "Tasks", model: { rows: "nope" } },
        { id: "todo.summary", kind: "summary", title: "Again", model: summary },
        { kind: "widget", title: "No id", model: widget },
        "junk",
      ],
    };
    expect(isDeliverySnapshot(newer)).toBe(false);
    const read = readDeliverySnapshot(newer)!;
    expect(read.views.map((entry) => [entry.id, entry.kind])).toEqual([
      ...delivery.views.map((entry) => [entry.id, entry.kind]),
      ["todo.widget", "widget"],
    ]);
    expect(read.views.at(-1)).toEqual({
      id: "todo.widget",
      kind: "widget",
      title: "Tasks",
      error: "Malformed widget view.",
    });
    expect(isDeliverySnapshot(read)).toBe(true);
    for (const value of [null, [], { views: [] }, { id: "x" }, { id: "x", views: [], host: 1 }])
      expect(readDeliverySnapshot(value), JSON.stringify(value)).toBeUndefined();
  });
});

describe("action requests and results", () => {
  it("accept an action id with JSON arguments", () => {
    expect(isActionRequest({ action: "todo.review", args: { ids: ["a"] } })).toBe(true);
    expect(isActionRequest({ action: "todo.review" })).toBe(true);
    expect(isActionRequest({ action: "review" })).toBe(false);
    expect(isActionRequest({ action: "todo.review", args: Number.NaN })).toBe(false);
    expect(isActionRequest({ action: "todo.review", args: { at: new Date() } })).toBe(false);
  });

  it("accept a JSON result or a bounded error, not both", () => {
    expect(isActionResult({ ok: true })).toBe(true);
    expect(isActionResult({ ok: true, value: [1, { a: null }] })).toBe(true);
    expect(isActionResult({ ok: false, error: "Unknown action." })).toBe(true);
    for (const value of [
      { ok: true, value: Infinity },
      { ok: true, error: "x" },
      { ok: false },
      { ok: false, error: "" },
      { ok: false, error: "e".repeat(MAX_VIEW_ERROR + 1) },
      { ok: false, error: "x", value: 1 },
      { ok: "yes" },
    ])
      expect(isActionResult(value), JSON.stringify(value)).toBe(false);
  });
});
