import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { renderPage } from "#src/hub/page";

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
});
