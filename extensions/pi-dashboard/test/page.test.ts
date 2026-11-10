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

  it("embeds the hub token for Focus requests, keeping only token characters", () => {
    expect(page).toContain('<meta name="dashboard-token" content="tok_EN-123">');
    expect(renderPage('"><script>')).toContain('content="script"');
  });

  it("keeps its modal dialogs outside the live-rendered main", () => {
    expect(page).toContain(
      '<main></main>\n<dialog id="preview" class="modal" aria-labelledby="preview-title"></dialog>\n<dialog id="answer" class="modal" aria-labelledby="answer-title"></dialog>\n<dialog id="usage" class="modal narrow" aria-labelledby="usage-title"></dialog>',
    );
    expect(page).toContain("modal.showModal()");
    expect(page).toContain("if (event.target === modal) modal.close();");
  });

  it("links pull requests only to https URLs, in a new tab without an opener", () => {
    expect(page).toContain('if (typeof pr.url === "string" && pr.url.startsWith("https://")) {');
    expect(page).toContain('link.rel = "noopener noreferrer";');
    expect(page).toContain("right.append(prPanel(session))");
    // The card counts come from the reporter, which sees every PR, not the capped list.
    expect(page).toContain("const open = Number(session.git.openCreated) || 0;");
    expect(page).toContain("right.append(worktreePanel(session))");
  });

  it("lays the detail page out in two even columns, splitting one side when the other is empty", () => {
    expect(page).toContain(
      ".cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));",
    );
    for (const panel of ["todoPanel", "subagentPanel", "activityPanel"])
      expect(page).toContain(`left.append(${panel}(session))`);
    for (const panel of ["prPanel", "worktreePanel", "stashPanel"])
      expect(page).toContain(`right.append(${panel}(session))`);
    expect(page).toContain(
      "if (!right.childElementCount && left.childElementCount > 1) right.append(left.lastElementChild);",
    );
    expect(page).not.toMatch(/Blackhole|memoryPanel|usagePanel/);
  });

  it("folds finished todos, subagents and pull requests behind a remembered row", () => {
    expect(page).toContain(
      'const finished = tasks.filter((task) => task.status === "completed" && !task.unreviewed);',
    );
    expect(page).toContain(
      'fold(node, "fold:" + session.id + ":todos", finished.length + " completed"',
    );
    // A waiting agent (idle on open work) is live too: it stays out of the folded finished row.
    expect(page).toContain("const live = agents.filter(isLiveSubagent);");
    expect(page).toContain(
      'return agent.state === "running" || agent.state === "queued" || agent.state === "waiting";',
    );
    expect(page).toContain('fold(node, "fold:" + session.id + ":subagents"');
    expect(page).toContain(
      'const ended = prs.filter((pr) => pr.state === "merged" || pr.state === "closed");',
    );
    expect(page).toContain('fold(node, "fold:" + session.id + ":prs", label, ...prGroups(ended));');
    expect(page).toContain("details.open = expanded.has(key);");
  });

  it("opens usage in a modal from the strip, refreshed on each update", () => {
    expect(page).toContain('cell("Usage", usageButton(session)');
    expect(page).toContain('button.setAttribute("aria-haspopup", "dialog");');
    expect(page).toContain("usageModal.showModal()");
    expect(page).toContain("checkAnswerStillOpen();\n  fillUsage();");
  });

  it("renders session text through textContent, never innerHTML", () => {
    expect(page).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
    expect(page).toContain("textContent");
  });
});
