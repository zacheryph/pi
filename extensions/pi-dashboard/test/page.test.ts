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

  it("has one modal dialog for stash previews, outside the live-rendered main", () => {
    expect(page).toContain(
      '<main></main>\n<dialog id="preview" class="modal" aria-labelledby="preview-title"></dialog>\n<dialog id="answer" class="modal" aria-labelledby="answer-title"></dialog>',
    );
    expect(page).toContain("modal.showModal()");
    expect(page).toContain("if (event.target === modal) modal.close();");
  });

  it("links pull requests only to https URLs, in a new tab without an opener", () => {
    expect(page).toContain('if (typeof pr.url === "string" && pr.url.startsWith("https://")) {');
    expect(page).toContain('link.rel = "noopener noreferrer";');
    expect(page).toContain("left.append(prPanel(session))");
    // The card counts come from the reporter, which sees every PR, not the capped list.
    expect(page).toContain("const open = Number(session.git.openCreated) || 0;");
    expect(page).toContain("left.append(worktreePanel(session))");
  });

  it("renders session text through textContent, never innerHTML", () => {
    expect(page).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
    expect(page).toContain("textContent");
  });
});
