import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  attentionRows,
  settleSnapshot,
  type AttentionItem,
  type AttentionList,
  type AttentionModel,
  type DeliverySnapshot,
  type FormModel,
  type FormQuestionnaire,
  type SessionModel,
  type SessionStatus,
  type ViewEntry,
} from "#src/index";

const T = 1_700_000_000_000;

const questionnaire = (id: string, openedAt?: number, extra: Partial<FormQuestionnaire> = {}) =>
  ({
    id,
    ...(openedAt !== undefined ? { openedAt } : {}),
    questions: [{ question: "Which queue?", options: [{ label: "SQS" }, { label: "Redis" }] }],
    submit: { action: "ask.submit", args: { id } },
    cancel: { action: "ask.cancel", args: { id } },
    ...extra,
  }) satisfies FormQuestionnaire;

const formView = (...questionnaires: FormQuestionnaire[]): ViewEntry => ({
  id: "ask.questions",
  kind: "form",
  title: "Questions",
  model: { questionnaires } satisfies FormModel,
});

const sessionView = (status: SessionStatus): ViewEntry => ({
  id: "system.session",
  kind: "session",
  title: "Session",
  model: { sessionId: "s1", cwd: "/work", status, startedAt: T } satisfies SessionModel,
});

const item = (id: string, since: number, extra: Partial<AttentionItem> = {}): AttentionItem => ({
  id,
  category: "review",
  title: `Review ${id}`,
  state: "ready",
  since,
  ...extra,
});

const attentionView = (id: string, items: AttentionItem[], total = items.length): ViewEntry => ({
  id,
  kind: "attention",
  title: id,
  model: { items, total } satisfies AttentionModel,
});

const keys = (list: AttentionList) => list.rows.map((row) => row.key);

describe("attentionRows", () => {
  it("finds nothing in a session that needs nothing", () => {
    const list = attentionRows({ views: [sessionView({ kind: "working", since: T })] });
    expect(list).toEqual({ rows: [], blocking: 0, owed: 0, more: 0, failed: [] });
  });

  it("turns each open questionnaire into a blocking row, oldest first", () => {
    const list = attentionRows({
      views: [
        sessionView({ kind: "waiting", since: T, title: "Pi's questions" }),
        formView(
          questionnaire("call-2", T + 2_000),
          questionnaire("call-1", T + 1_000, {
            title: "Retry policy",
            questions: [
              { question: "Which queue?", options: [] },
              { question: "Which failures?", options: [], multiSelect: true },
            ],
          }),
          questionnaire("call-3"),
        ),
      ],
    });
    expect(list.rows).toEqual([
      {
        key: "ask.questions/call-1",
        kind: "blocking",
        viewId: "ask.questions",
        itemId: "call-1",
        category: "question",
        title: "Retry policy",
        reason: "2 questions",
        state: "ready",
        since: T + 1_000,
      },
      {
        key: "ask.questions/call-2",
        kind: "blocking",
        viewId: "ask.questions",
        itemId: "call-2",
        category: "question",
        title: "Which queue?",
        state: "ready",
        since: T + 2_000,
      },
      // No opening time: after the ones that have one.
      expect.objectContaining({ key: "ask.questions/call-3", title: "Which queue?" }),
    ]);
    // The questionnaires say what the session waits on, so the bare status adds no row.
    expect(list).toMatchObject({ blocking: 3, owed: 0, more: 0, failed: [] });
  });

  it("names a titled questionnaire's single question as its reason", () => {
    const list = attentionRows({ views: [formView(questionnaire("c", T, { title: "Deploy" }))] });
    expect(list.rows[0]).toMatchObject({ title: "Deploy", reason: "Which queue?" });
  });

  it("shows a session waiting on a dialog with no questionnaire as one blocking row", () => {
    const list = attentionRows({
      views: [sessionView({ kind: "waiting", since: T, title: "Allow bash?" })],
    });
    expect(list.rows).toEqual([
      {
        key: "system.session/waiting",
        kind: "blocking",
        viewId: "system.session",
        itemId: "waiting",
        category: "waiting",
        title: "Allow bash?",
        state: "ready",
        since: T,
      },
    ]);
    const untitled = attentionRows({ views: [sessionView({ kind: "waiting", since: T })] });
    expect(untitled.rows[0]!.title).toBe("Waiting for you");
  });

  it("lists owed items from every attention view: ready by age, then stale", () => {
    const dismiss = { action: "git.attention-dismiss", args: { id: "pr:42", rev: "a13c90e" } };
    const list = attentionRows({
      views: [
        attentionView(
          "git.attention",
          [
            item("pr:42", T + 3_000, {
              rev: "a13c90e",
              reason: "draft at a13c90e",
              link: { url: "https://github.com/acme/web/pull/42", label: "acme/web#42" },
              open: { action: "git.attention-open", args: { id: "pr:42" } },
              dismiss,
            }),
            item("pr:40", T, { state: "stale" }),
          ],
          14,
        ),
        attentionView("todo.attention", [item("findings", T + 1_000, { category: "findings" })]),
      ],
    });
    expect(keys(list)).toEqual([
      "todo.attention/findings",
      "git.attention/pr:42",
      "git.attention/pr:40",
    ]);
    expect(list.rows[1]).toEqual({
      key: "git.attention/pr:42",
      kind: "owed",
      viewId: "git.attention",
      itemId: "pr:42",
      category: "review",
      title: "Review pr:42",
      reason: "draft at a13c90e",
      state: "ready",
      since: T + 3_000,
      rev: "a13c90e",
      link: { url: "https://github.com/acme/web/pull/42", label: "acme/web#42" },
      open: { action: "git.attention-open", args: { id: "pr:42" } },
      dismiss,
    });
    // The producers' totals: 14 + 1 owed, 3 of them listed.
    expect(list).toMatchObject({ blocking: 0, owed: 15, more: 12, failed: [] });
  });

  it("puts blocking rows before owed ones, however old", () => {
    const list = attentionRows({
      views: [
        attentionView("git.attention", [item("pr:1", T - 86_400_000)]),
        formView(questionnaire("call-1", T)),
        sessionView({ kind: "waiting", since: T }),
      ],
    });
    expect(keys(list)).toEqual(["ask.questions/call-1", "git.attention/pr:1"]);
    expect(list).toMatchObject({ blocking: 1, owed: 1, more: 0 });
  });

  it("reports a failed form or attention view, and falls back to the waiting status", () => {
    const list = attentionRows({
      views: [
        { id: "ask.questions", kind: "form", title: "Questions", error: "Provider failed." },
        { id: "git.attention", kind: "attention", title: "Git", error: "Too large." },
        attentionView("todo.attention", [item("findings", T)]),
        sessionView({ kind: "waiting", since: T + 1, title: "Pi's questions" }),
        { id: "todo.widget", kind: "widget", title: "Tasks", error: "Not this one." },
      ],
    });
    expect(list.failed).toEqual(["ask.questions", "git.attention"]);
    expect(keys(list)).toEqual(["system.session/waiting", "todo.attention/findings"]);
  });

  it("keeps only owed rows of a settled snapshot, with links and no actions", () => {
    const live: DeliverySnapshot = {
      id: "thread-1",
      views: [
        attentionView("git.attention", [
          item("pr:42", T, {
            link: { url: "https://github.com/acme/web/pull/42", label: "acme/web#42" },
            dismiss: { action: "git.attention-dismiss", args: { id: "pr:42" } },
          }),
          item("run", T + 1, { live: true }),
        ]),
        formView(questionnaire("call-1", T)),
        sessionView({ kind: "waiting", since: T }),
      ],
    };
    expect(attentionRows(live)).toMatchObject({ blocking: 1, owed: 2 });
    const settled = attentionRows(settleSnapshot(live, T + 60_000));
    expect(settled).toEqual({
      rows: [
        {
          key: "git.attention/pr:42",
          kind: "owed",
          viewId: "git.attention",
          itemId: "pr:42",
          category: "review",
          title: "Review pr:42",
          state: "ready",
          since: T,
          link: { url: "https://github.com/acme/web/pull/42", label: "acme/web#42" },
        },
      ],
      blocking: 0,
      owed: 1,
      more: 0,
      failed: [],
    });
  });

  it("drops a link that is not https, keeping the row", () => {
    const links = [
      "http://github.com/acme",
      "javascript:alert(1)",
      "not a url",
      "https://ok.dev/x",
    ];
    const list = attentionRows({
      views: [
        attentionView(
          "git.attention",
          links.map((url, i) => item(`i${i}`, T + i, { link: { url, label: "open" } })),
        ),
      ],
    });
    expect(list.rows.map((row) => row.link?.url)).toEqual([
      undefined,
      undefined,
      undefined,
      "https://ok.dev/x",
    ]);
  });

  it("works the same embedded as source, with nothing from this module in scope", () => {
    // A fresh realm, as the dashboard page's inline script is: only the source and URL.
    const embedded = runInNewContext(`${attentionRows.toString()}\nattentionRows;`, {
      URL,
    }) as typeof attentionRows;
    const snapshot = {
      views: [
        attentionView(
          "git.attention",
          [
            item("pr:1", T, { state: "stale", link: { url: "https://ok.dev/1", label: "1" } }),
            item("pr:2", T, { link: { url: "http://ok.dev/2", label: "2" } }),
          ],
          5,
        ),
        formView(questionnaire("call-1", T)),
        sessionView({ kind: "waiting", since: T }),
      ],
    };
    const rows = JSON.parse(JSON.stringify(embedded(structuredClone(snapshot)))) as unknown;
    expect(rows).toEqual(attentionRows(snapshot));
  });
});
