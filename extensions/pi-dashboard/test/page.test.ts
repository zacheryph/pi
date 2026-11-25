import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import type { ViewEntry } from "#surface";
import { renderPage } from "#src/hub/page";
import { snapshot } from "#test/helpers";
import { runPage } from "#test/page-dom";

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
      "function formPanel(record, items)",
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
