import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import type { ViewEntry } from "#surface";
import { renderPage } from "#src/hub/page";
import { snapshot } from "#test/helpers";
import { runPage, type FakeNode, type PageRequest } from "#test/page-dom";

describe("renderPage", () => {
  const page = renderPage("tok_EN-123");

  it("is a complete document with one inline script that parses", () => {
    expect(page.startsWith("<!doctype html>")).toBe(true);
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    expect(scripts).toHaveLength(1);
    expect(() => new Script(scripts[0])).not.toThrow();
  });

  it("embeds the hub token for session requests, keeping only token characters", () => {
    expect(page).toContain('<meta name="dashboard-token" content="tok_EN-123">');
    expect(renderPage('"><script>')).toContain('content="script"');
  });

  it("keeps its modal dialogs outside the live-rendered main", () => {
    expect(page).toContain(
      '<main></main>\n<dialog id="answer" class="modal" aria-labelledby="answer-title"></dialog>\n<dialog id="usage" class="modal narrow" aria-labelledby="usage-title"></dialog>',
    );
    expect(page).toContain("answerModal.showModal()");
    expect(page).toContain("usageModal.showModal()");
  });

  it("has one renderer per view kind and knows no extension", () => {
    for (const renderer of [
      "function card(record)",
      "function headPanel(record)",
      "function activityPanel(session)",
      "function summaryView(entry, compact)",
      "function widgetPanel(record, entry)",
      "function explorerPanel(record, entry)",
      "function detailPanel(entry)",
      "function needsPanel(found, solo)",
    ])
      expect(page).toContain(renderer);
    // Only the conventional system view id; no extension's view, action or section.
    expect(page).not.toMatch(/todo\.|stash\.|git\.|subagent\.|ask\.|session\.todos|session\.git/);
  });

  it("sends behaviour back as the action a view references, plus Focus", () => {
    expect(page).toContain('return ask(record, "actions", { action: ref.action');
    expect(page).toContain('await ask(record, "focus");');
    expect(page).toContain('submit(questionnaire.submit, payload, "Answer sent");');
    expect(page).toContain('submit(questionnaire.cancel, {}, "Declined the question")');
    expect(page).not.toMatch(/\/preview|\/history|\/answer"/);
  });

  it("lays the detail page out in two even columns, splitting one side when the other is empty", () => {
    expect(page).toContain(
      ".cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));",
    );
    expect(page).toContain(
      "if (!right.childElementCount && left.childElementCount > 1) right.append(left.lastElementChild);",
    );
  });

  it("opens usage in a modal from the strip, refreshed on each update", () => {
    expect(page).toContain('cell("Usage", usageButton(record, session.usage)');
    expect(page).toContain('button.setAttribute("aria-haspopup", "dialog");');
    expect(page).toContain("checkAnswerStillOpen();\n  fillUsage();");
  });

  it("renders session text through textContent, never innerHTML", () => {
    expect(page).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
    expect(page).toContain("textContent");
  });

  it("embeds pi-surface's count formatters instead of its own compact numbers", () => {
    expect(page).toContain("function formatSummaryCount(count");
    expect(page).toContain("function formatBytes(bytes");
    expect(page).toContain("formatSummaryCount(item)");
    expect(page).not.toMatch(/\bamount\(/);
  });

  it("embeds pi-surface's attentionRows for the Needs you panel", () => {
    expect(page).toContain("function attentionRows(snapshot");
    expect(page).toContain("attentionRows({ views: viewsOf(record) })");
    expect(page).toContain('panel("Needs you"');
    expect(page).not.toContain('panel("Waiting on you"');
  });
});

describe("summary counts on the page", () => {
  const summaries: ViewEntry[] = [
    {
      id: "git.summary",
      kind: "summary",
      title: "Git",
      model: {
        counts: [
          { key: "worktrees", label: "worktree", value: 1 },
          { key: "prs", label: "pull requests", value: 2 },
          { key: "prs-open", label: "open", value: 1, tone: "accent" },
          { key: "removed", label: "removed", value: 0, tone: "dim" },
        ],
      },
    },
    {
      id: "stash.summary",
      kind: "summary",
      title: "Stash",
      model: {
        counts: [
          { key: "entries", label: "entry", value: 1 },
          { key: "bytes", label: "on this branch", value: 887, unit: "bytes", tone: "muted" },
          { key: "store-bytes", label: "in the store", value: 12_698, unit: "bytes" },
          {
            key: "store-max-bytes",
            label: "store cap",
            value: 1024 ** 3,
            unit: "bytes",
            tone: "muted",
          },
        ],
      },
    },
  ];
  const record = snapshot({ views: [...snapshot().views, ...summaries] });

  it("shows each count as its value then its producer's label, sizes formatted as sizes", () => {
    const run = runPage(renderPage("tok"));
    run.sessions({ home: "/home/me", sessions: [record] });
    // The index card leaves out zeros and muted or dim counts.
    expect(run.main.textsOf("chip-count")).toEqual([
      "1 worktree",
      "2 pull requests",
      "1 open",
      "1 entry",
      "12.4 KiB in the store",
    ]);

    run.location.hash = "#" + record.id;
    run.call("render", true);
    // The detail page shows every count above zero.
    expect(run.main.textsOf("chip-count")).toEqual([
      "1 worktree",
      "2 pull requests",
      "1 open",
      "1 entry",
      "887 B on this branch",
      "12.4 KiB in the store",
      "1.0 GiB store cap",
    ]);
    expect(run.main.textContent).not.toMatch(/1073\.7M|bytes/);
  });
});

describe("the Needs you panel", () => {
  const now = Date.now();
  const question: ViewEntry = {
    id: "ask.questions",
    kind: "form",
    title: "Questions",
    model: {
      questionnaires: [
        {
          id: "q1",
          openedAt: now - 60_000,
          questions: [
            {
              question: "Which retry strategy for failed webhooks?",
              options: [{ label: "Exponential" }, { label: "Fixed" }],
            },
          ],
          submit: { action: "ask.submit", args: { id: "q1" } },
          cancel: { action: "ask.cancel", args: { id: "q1" } },
        },
      ],
    },
  };
  const findings: ViewEntry = {
    id: "todo.attention",
    kind: "attention",
    title: "Todos",
    model: {
      items: [
        {
          id: "task-3",
          category: "findings",
          title: "2 findings to discuss",
          state: "ready",
          since: now - 30_000,
        },
      ],
      total: 1,
    },
  };
  // The page checks links again: the last two reach it only if something upstream let them through.
  const reviews: ViewEntry = {
    id: "git.attention",
    kind: "attention",
    title: "Git",
    model: {
      items: [
        {
          id: "pr:42",
          category: "review",
          title: "Review acme/web#42",
          reason: "draft at a13c90e",
          state: "ready",
          since: now - 3_600_000,
          link: { url: "https://github.com/acme/web/pull/42", label: "acme/web#42" },
        },
        {
          id: "pr:57",
          category: "review",
          title: "Review acme/api#57",
          state: "stale",
          since: now - 7_200_000,
          link: { url: "javascript:alert(1)", label: "acme/api#57" },
        },
        {
          id: "pr:58",
          category: "review",
          title: "Review acme/api#58",
          state: "ready",
          since: now - 600_000,
          link: { url: "http://example.com/acme/api/pull/58", label: "acme/api#58" },
        },
      ],
      total: 5,
    },
  };
  const waiting = snapshot({
    id: "101",
    session: {
      name: "Webhook retry queue",
      status: { kind: "waiting", since: now, title: "Answer the question" },
    },
  });
  const blocked = { ...waiting, views: [...waiting.views, question, findings] };
  const owing = snapshot({
    id: "202",
    host: { pid: 202 },
    session: { sessionId: "session-b", name: "Checkout cleanup" },
  });
  const owes = { ...owing, views: [...owing.views, reviews] };
  const idle = snapshot({ id: "303", host: { pid: 303 }, session: { name: "Docs refresh" } });

  const panelOf = (main: FakeNode) => {
    const panel = main
      .descendants()
      .find(
        (node) =>
          node.tagName === "section" && node.children[0]?.textContent.startsWith("Needs you"),
      );
    expect(panel).toBeDefined();
    return panel!;
  };
  const needRows = (node: FakeNode) =>
    node.descendants().filter((child) => child.className.split(" ").includes("need"));
  const find = (node: FakeNode, key: string) =>
    node.descendants().find((child) => child.dataset.key === key);
  type Anchor = FakeNode & { href: string; target: string; rel: string };

  it("lists Blocking then Owed rows from every session, with Answer and https Open links", () => {
    const run = runPage(renderPage("tok"));
    run.sessions({ home: "/home/me", sessions: [owes, blocked, idle] });
    const panel = panelOf(run.main);
    // 1 question, 1 finding and 5 reviews, of which 3 are listed.
    expect(panel.children[0]!.textContent).toBe("Needs you7 items");
    expect(panel.className).toBe("panel asks");
    const rows = needRows(panel);
    // Blocking first, then ready oldest first, then stale.
    expect(rows.map((row) => row.children[0]!.textContent)).toEqual([
      "Webhook retry queue",
      "Checkout cleanup",
      "Checkout cleanup",
      "Webhook retry queue",
      "Checkout cleanup",
    ]);
    expect(rows.map((row) => row.children[1]!.children[0]!.textContent)).toEqual([
      "Which retry strategy for failed webhooks?",
      "Review acme/web#42 · draft at a13c90e",
      "Review acme/api#58",
      "2 findings to discuss",
      "Review acme/api#57",
    ]);
    expect(rows.map((row) => row.children[2]!.textContent)).toEqual(["Answer", "Open", "", "", ""]);
    expect(rows.map((row) => row.className.includes("stale"))).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(panel.textsOf("muted").at(-1)).toBe("and 2 more");

    const open = rows[1]!.children[2]! as Anchor;
    expect(open.tagName).toBe("a");
    expect(open.href).toBe("https://github.com/acme/web/pull/42");
    expect(open.target).toBe("_blank");
    expect(open.rel).toBe("noopener noreferrer");
    // Links that are not https: are never drawn as links; the others link to a session's page.
    const hrefs = panel
      .descendants()
      .filter((node) => node.tagName === "a")
      .map((node) => (node as Anchor).href);
    expect(hrefs.filter((href) => !href.startsWith("#"))).toEqual([
      "https://github.com/acme/web/pull/42",
    ]);
  });

  it("gives an owing card the amber edge, a blocked card its highlight, and an idle one neither", () => {
    const run = runPage(renderPage("tok"));
    run.sessions({ home: "/home/me", sessions: [owes, blocked, idle] });
    const cards = run.main.descendants().filter((node) => node.tagName === "article");
    const classes = new Map(
      cards.map((card) => [card.children[0]!.children[0]!.textContent, card.className]),
    );
    // Blocked and owing at once: Blocking wins.
    expect(classes.get("Webhook retry queue")).toBe("card attn");
    expect(classes.get("Checkout cleanup")).toBe("card owes");
    expect(classes.get("Docs refresh")).toBe("card");
    expect(run.main.textContent).toContain("Owed: Review acme/web#42 · 4 more");
  });

  it("shows nothing when nothing needs you, and says which views failed", () => {
    const run = runPage(renderPage("tok"));
    run.sessions({ home: "/home/me", sessions: [idle] });
    expect(run.main.textContent).not.toContain("Needs you");
    const failing = {
      ...idle,
      views: [
        ...idle.views,
        { id: "git.attention", kind: "attention", title: "Git", error: "boom" },
      ],
    };
    run.sessions({ home: "/home/me", sessions: [failing] });
    expect(panelOf(run.main).textsOf("bad")).toEqual([
      "Docs refresh: Git unavailable; what it holds is unknown.",
    ]);
  });

  it("keeps a restarting session's owed rows as last known, without its questions", () => {
    const run = runPage(renderPage("tok"));
    run.sessions({ home: "/home/me", sessions: [{ ...blocked, disconnected: true }] });
    const rows = needRows(panelOf(run.main));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.children[1]!.textContent).toMatch(
      /^2 findings to discuss\d+s ago · last known$/,
    );
    expect(rows[0]!.children[2]!.textContent).toBe("");
  });

  it("answers a questionnaire from the panel through its submit action", async () => {
    const requests: PageRequest[] = [];
    const run = runPage(renderPage("tok"), (request) => {
      requests.push(request);
      return { status: 200, body: { ok: true, data: { status: "answered" } } };
    });
    run.sessions({ home: "/home/me", sessions: [owes, blocked] });
    find(run.main, "answer:101:q1:needs")!.dispatch("click");
    const form = run.byId("answer").children[0]!;
    expect(form.tagName).toBe("form");
    const inputs = form.descendants().filter((node) => node.tagName === "input");
    inputs[0]!.checked = true;
    form.dispatch("submit");
    await new Promise((resolve) => setImmediate(resolve));
    expect(requests).toEqual([
      {
        url: "/api/sessions/101/actions",
        method: "POST",
        headers: { "X-Dashboard-Token": "token", "Content-Type": "application/json" },
        body: {
          action: "ask.submit",
          args: { id: "q1", answers: [{ questionIndex: 0, optionIndexes: [0] }] },
        },
      },
    ]);
  });

  it("shows one session's rows on its page, with every question and its Answer", () => {
    const run = runPage(renderPage("tok"));
    run.sessions({ home: "/home/me", sessions: [blocked, owes] });
    run.location.hash = "#101";
    run.call("render", true);
    const panel = panelOf(run.main);
    expect(panel.children[0]!.textContent).toBe("Needs you2 items");
    const rows = needRows(panel);
    expect(rows.map((row) => row.className)).toEqual(["need solo", "need solo"]);
    expect(rows[0]!.textContent).toContain("the terminal can answer too; the first answer wins");
    expect(find(panel, "answer:101:q1:detail")?.textContent).toBe("Answer");
    expect(rows[1]!.textContent).toMatch(/^2 findings to discuss/);
  });

  describe("an item that takes a reply", () => {
    const task: ViewEntry = {
      id: "todo.attention",
      kind: "attention",
      title: "Todos",
      model: {
        items: [
          {
            id: "task:a",
            rev: "7",
            category: "task",
            title: "Pick a webhook host",
            reason: "Choose staging or prod in the deploy settings",
            state: "ready",
            since: now - 60_000,
            reply: { action: "todo.unblock", args: { key: "a", rev: "7" } },
          },
        ],
        total: 1,
      },
    };
    const asking = { ...owing, views: [...owing.views, task] };
    const textarea = (form: FakeNode) =>
      form.descendants().find((node) => node.tagName === "textarea")!;
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    it("shows Reply only while the session is live", () => {
      const run = runPage(renderPage("tok"));
      run.sessions({ home: "/home/me", sessions: [asking] });
      expect(needRows(panelOf(run.main))[0]!.children[2]!.textContent).toBe("Reply");
      run.sessions({ home: "/home/me", sessions: [{ ...asking, disconnected: true }] });
      expect(needRows(panelOf(run.main))[0]!.children[2]!.textContent).toBe("");
    });

    it("sends the typed text with the action's arguments", async () => {
      const requests: PageRequest[] = [];
      const run = runPage(renderPage("tok"), (request) => {
        requests.push(request);
        return { status: 200, body: { ok: true, data: null } };
      });
      run.sessions({ home: "/home/me", sessions: [asking] });
      find(run.main, "reply:202/todo.attention/task:a:needs")!.dispatch("click");
      const form = run.byId("answer").children[0]!;
      expect(form.textContent).toContain("Choose staging or prod in the deploy settings");
      // An empty reply is never sent.
      form.dispatch("submit");
      await settle();
      expect(requests).toEqual([]);
      expect(form.textsOf("bad")).toEqual(["Type a reply."]);
      textarea(form).value = "  Use staging.  ";
      form.dispatch("submit");
      await settle();
      expect(requests).toEqual([
        {
          url: "/api/sessions/202/actions",
          method: "POST",
          headers: { "X-Dashboard-Token": "token", "Content-Type": "application/json" },
          body: { action: "todo.unblock", args: { key: "a", rev: "7", text: "Use staging." } },
        },
      ]);
    });

    it("keeps the draft and says why when the reply is refused", async () => {
      const run = runPage(renderPage("tok"), () => ({
        status: 200,
        body: { ok: false, error: "Task a is no longer waiting." },
      }));
      run.sessions({ home: "/home/me", sessions: [asking] });
      find(run.main, "reply:202/todo.attention/task:a:needs")!.dispatch("click");
      const form = run.byId("answer").children[0]!;
      textarea(form).value = "Use staging.";
      form.dispatch("submit");
      await settle();
      expect(form.textsOf("bad")).toEqual(["Task a is no longer waiting."]);
      // Reopened, it is the same form with the same text.
      find(run.main, "reply:202/todo.attention/task:a:needs")!.dispatch("click");
      expect(run.byId("answer").children[0]).toBe(form);
      expect(textarea(form).value).toBe("Use staging.");
    });
  });
});
